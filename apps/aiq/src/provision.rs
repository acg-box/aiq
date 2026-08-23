//! Create-only operator setup for unattended AIQ credentials.

use std::{
	ffi::OsString,
	io::Write as _,
	os::unix::{ffi::OsStrExt as _, process::CommandExt as _},
	process::{Command, Stdio},
	time::Duration,
};

use serde::Serialize;
use serde_json::Value;
use ureq::{self, Body, http::Response};

use crate::{
	ResultContext,
	config::{
		PROVIDER_ENVIRONMENT, PROVIDER_PATH, ProvisionConfiguration, RUNNER_SIGNING_KEY,
		RUNNER_SUBMISSION_TOKEN, VERIFIER_INGRESS_TOKEN, VERIFIER_SIGNING_KEY,
	},
	credentials::{self, RuntimeIdentity, Secret},
	lock::ProcessLock,
};

const MAX_API_RESPONSE_BYTES: usize = 1_024 * 1_024;
const MAX_KEYCHAIN_BYTES: usize = 16 * 1_024;
const ACCESS_TOKEN_TTL_SECONDS: u64 = 900;
const SECRET_KEYS: [&str; 4] =
	[RUNNER_SIGNING_KEY, RUNNER_SUBMISSION_TOKEN, VERIFIER_INGRESS_TOKEN, VERIFIER_SIGNING_KEY];

/// Value-free result of one committed create-only setup.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProvisionReceipt {
	schema_version: &'static str,
	status: &'static str,
	provider: ProviderReceipt,
	identity: IdentityReceipt,
	keychain: KeychainReceipt,
	permissions: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderReceipt {
	domain: String,
	project_id: String,
	environment: &'static str,
	path: &'static str,
	keys: [&'static str; 4],
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct IdentityReceipt {
	name: String,
	id: String,
	membership_role: &'static str,
	privilege_slug: String,
	privilege_id: String,
	auth_method: &'static str,
	client_id: String,
	access_token_ttl_seconds: u64,
}

#[derive(Debug, Serialize)]
struct KeychainReceipt {
	service: String,
	account: String,
}

struct ApiResponse {
	status: u16,
	body: Vec<u8>,
}

struct ApiClient {
	agent: ureq::Agent,
}
impl ApiClient {
	fn new() -> Self {
		let configuration = ureq::Agent::config_builder()
			.timeout_global(Some(Duration::from_secs(120)))
			.http_status_as_error(false)
			.build();

		Self { agent: configuration.into() }
	}

	fn get(&self, url: &str, token: &Secret) -> crate::Result<ApiResponse> {
		let authorization = authorization(token)?;

		Self::collect(self.agent.get(url).header("Authorization", &authorization).call())
	}

	fn delete(&self, url: &str, token: &Secret) -> crate::Result<ApiResponse> {
		let authorization = authorization(token)?;

		Self::collect(self.agent.delete(url).header("Authorization", &authorization).call())
	}

	fn post(
		&self,
		url: &str,
		body: Option<&Value>,
		token: Option<&Secret>,
	) -> crate::Result<ApiResponse> {
		let authorization = token.map(authorization).transpose()?;
		let mut request = self.agent.post(url).header("Content-Type", "application/json");

		if let Some(authorization) = &authorization {
			request = request.header("Authorization", authorization);
		}

		let mut bytes = body
			.map(serde_json::to_vec)
			.transpose()
			.context("cannot encode Infisical request")?
			.unwrap_or_default();
		let result = request.send(bytes.as_slice());

		bytes.fill(0);

		Self::collect(result)
	}

	fn collect(
		result: std::result::Result<Response<Body>, ureq::Error>,
	) -> crate::Result<ApiResponse> {
		let mut response = result.map_err(|error| {
			if matches!(error, ureq::Error::Timeout(_)) {
				crate::Error::new("Infisical API request timed out; the exact target is frozen")
			} else {
				crate::Error::new("Infisical API transport failed; the exact target is frozen")
			}
		})?;
		let status = response.status().as_u16();
		let body = response
			.body_mut()
			.with_config()
			.limit((MAX_API_RESPONSE_BYTES + 1) as u64)
			.read_to_vec()
			.map_err(|_| crate::Error::new("Infisical API response could not be read"))?;

		if body.len() > MAX_API_RESPONSE_BYTES {
			return Err(crate::Error::new("Infisical API response exceeded its byte limit"));
		}

		Ok(ApiResponse { status, body })
	}
}

struct Transaction<'a> {
	configuration: &'a ProvisionConfiguration,
	api: ApiClient,
	admin_token: Secret,
	identity_id: Option<String>,
	privilege_id: Option<String>,
	universal_url: Option<String>,
	client_secret_id: Option<String>,
	outcome_unknown: bool,
	committed: bool,
}
impl<'a> Transaction<'a> {
	fn new(configuration: &'a ProvisionConfiguration, admin_token: Secret) -> Self {
		Self {
			configuration,
			api: ApiClient::new(),
			admin_token,
			identity_id: None,
			privilege_id: None,
			universal_url: None,
			client_secret_id: None,
			outcome_unknown: false,
			committed: false,
		}
	}

	fn admin_get(&self, url: &str) -> crate::Result<ApiResponse> {
		self.api.get(url, &self.admin_token)
	}

	fn admin_post(&self, url: &str, body: Option<&Value>) -> crate::Result<ApiResponse> {
		self.api.post(url, body, Some(&self.admin_token))
	}

	fn admin_delete(&self, url: &str) -> crate::Result<ApiResponse> {
		self.api.delete(url, &self.admin_token)
	}

	fn read_json(mut response: ApiResponse, label: &str) -> crate::Result<Value> {
		if !(200..300).contains(&response.status) {
			response.body.fill(0);

			return Err(crate::Error::new(format!("{label} failed with HTTP {}", response.status)));
		}

		let result = serde_json::from_slice(&response.body)
			.map_err(|_| crate::Error::new(format!("{label} returned invalid metadata")));

		response.body.fill(0);

		result
	}

	fn verify_project(&self) -> crate::Result<()> {
		let response = self.admin_get(&format!(
			"{}/api/v1/projects/{}",
			self.configuration.api_url, self.configuration.project_id,
		))?;
		let value = Self::read_json(response, "Infisical AIQ project verification")?;
		let project = value
			.get("project")
			.ok_or_else(|| crate::Error::new("Infisical did not return the AIQ project"))?;

		if project.get("id").and_then(Value::as_str) != Some(self.configuration.project_id.as_str())
		{
			return Err(crate::Error::new("Infisical returned a different AIQ project"));
		}

		let environments = project
			.get("environments")
			.and_then(Value::as_array)
			.ok_or_else(|| crate::Error::new("Infisical did not return project environments"))?;
		let matches = environments
			.iter()
			.filter(|environment| {
				environment.get("slug").and_then(Value::as_str) == Some(PROVIDER_ENVIRONMENT)
			})
			.count();

		if matches != 1 {
			return Err(crate::Error::new(
				"Infisical AIQ production environment is missing or ambiguous",
			));
		}

		Ok(())
	}

	fn require_identity_absence(&self) -> crate::Result<()> {
		let response = self.admin_get(&format!(
			"{}/api/v1/projects/{}/identities?limit=1000",
			self.configuration.api_url, self.configuration.project_id,
		))?;
		let value = Self::read_json(response, "Infisical AIQ identity absence check")?;
		let matches = value
			.get("identities")
			.and_then(Value::as_array)
			.into_iter()
			.flatten()
			.filter(|identity| {
				identity.get("name").and_then(Value::as_str)
					== Some(self.configuration.identity_name.as_str())
			})
			.count();

		if matches != 0 {
			return Err(crate::Error::new(
				"AIQ Infisical identity already exists or is ambiguous; create-only setup refused",
			));
		}

		Ok(())
	}

	fn create_identity(&mut self) -> crate::Result<String> {
		self.outcome_unknown = true;

		let response = self.admin_post(
			&format!(
				"{}/api/v1/projects/{}/identities",
				self.configuration.api_url, self.configuration.project_id,
			),
			Some(&serde_json::json!({
				"name": self.configuration.identity_name,
				"hasDeleteProtection": false,
				"roles": [{"role": "no-access", "isTemporary": false}]
			})),
		)?;
		let value = Self::read_json(response, "Infisical AIQ identity creation")?;
		let identity_id = required_string(&value, "/identity/id", "identity creation")?;

		self.identity_id = Some(identity_id.clone());
		self.outcome_unknown = false;

		Ok(identity_id)
	}

	fn verify_membership(&self, identity_id: &str) -> crate::Result<()> {
		let response = self.admin_get(&format!(
			"{}/api/v1/projects/{}/memberships/identities/{identity_id}",
			self.configuration.api_url, self.configuration.project_id,
		))?;
		let value = Self::read_json(response, "Infisical AIQ membership verification")?;
		let roles = value
			.pointer("/identityMembership/roles")
			.and_then(Value::as_array)
			.ok_or_else(|| crate::Error::new("Infisical did not return AIQ membership roles"))?;

		if roles.len() != 1
			|| roles[0].get("role").and_then(Value::as_str) != Some("no-access")
			|| roles[0].get("isTemporary").and_then(Value::as_bool) != Some(false)
			|| roles[0].get("customRoleId").is_some_and(|value| !value.is_null())
		{
			return Err(crate::Error::new("Infisical AIQ identity has an unexpected project role"));
		}

		Ok(())
	}

	fn privilege_permissions() -> Value {
		serde_json::json!([{
			"subject": "secrets",
			"action": ["describeSecret", "readValue"],
			"conditions": {
				"environment": {"$eq": PROVIDER_ENVIRONMENT},
				"secretPath": {"$eq": PROVIDER_PATH},
				"secretName": {"$in": SECRET_KEYS}
			}
		}])
	}

	fn privilege_permissions_match(value: Option<&Value>) -> bool {
		let Some(permissions) = value.and_then(Value::as_array) else {
			return false;
		};

		if permissions.len() != 1 {
			return false;
		}

		let permission = &permissions[0];
		let actions = permission.get("action").and_then(Value::as_array);
		let expected_conditions = &Self::privilege_permissions()[0]["conditions"];

		permission.get("subject").and_then(Value::as_str) == Some("secrets")
			&& actions.is_some_and(|actions| {
				actions.len() == 2
					&& actions.iter().any(|action| action.as_str() == Some("describeSecret"))
					&& actions.iter().any(|action| action.as_str() == Some("readValue"))
			}) && permission.get("conditions") == Some(expected_conditions)
			&& permission.get("inverted").is_none_or(|value| value.as_bool() == Some(false))
	}

	fn create_privilege(&mut self, identity_id: &str) -> crate::Result<String> {
		self.outcome_unknown = true;

		let response = self.admin_post(
			&format!("{}/api/v2/identity-project-additional-privilege", self.configuration.api_url,),
			Some(&serde_json::json!({
				"identityId": identity_id,
				"projectId": self.configuration.project_id,
				"slug": self.configuration.privilege_slug,
				"permissions": Self::privilege_permissions(),
				"type": {"isTemporary": false}
			})),
		)?;
		let value = Self::read_json(response, "Infisical AIQ privilege creation")?;
		let privilege_id = required_string(&value, "/privilege/id", "privilege creation")?;

		self.privilege_id = Some(privilege_id.clone());
		self.outcome_unknown = false;

		Ok(privilege_id)
	}

	fn verify_privilege(&self, privilege_id: &str, identity_id: &str) -> crate::Result<()> {
		let association = Self::read_json(
			self.admin_get(&format!(
				"{}/api/v2/identity-project-additional-privilege?identityId={identity_id}&projectId={}",
				self.configuration.api_url, self.configuration.project_id,
			))?,
			"Infisical AIQ privilege association verification",
		)?;
		let privileges = association
			.get("privileges")
			.and_then(Value::as_array)
			.ok_or_else(|| crate::Error::new("Infisical did not return AIQ privileges"))?;
		let matches = privileges
			.iter()
			.filter(|privilege| {
				privilege.get("id").and_then(Value::as_str) == Some(privilege_id)
					&& privilege.get("slug").and_then(Value::as_str)
						== Some(self.configuration.privilege_slug.as_str())
			})
			.count();

		if privileges.len() != 1 || matches != 1 {
			return Err(crate::Error::new(
				"Infisical AIQ privilege association is missing or ambiguous",
			));
		}

		let value = Self::read_json(
			self.admin_get(&format!(
				"{}/api/v2/identity-project-additional-privilege/{privilege_id}",
				self.configuration.api_url,
			))?,
			"Infisical AIQ privilege verification",
		)?;
		let privilege = value
			.get("privilege")
			.ok_or_else(|| crate::Error::new("Infisical did not return the AIQ privilege"))?;

		if privilege.get("slug").and_then(Value::as_str)
			!= Some(self.configuration.privilege_slug.as_str())
			|| privilege.get("isTemporary").and_then(Value::as_bool) != Some(false)
			|| !Self::privilege_permissions_match(privilege.get("permissions"))
		{
			return Err(crate::Error::new(
				"Infisical AIQ privilege does not match the exact four-key read contract",
			));
		}

		Ok(())
	}

	fn attach_universal_auth(&mut self, identity_id: &str) -> crate::Result<(String, String)> {
		let universal_url = format!(
			"{}/api/v1/auth/universal-auth/identities/{identity_id}",
			self.configuration.api_url,
		);

		self.outcome_unknown = true;

		let response = self.admin_post(
			&universal_url,
			Some(&serde_json::json!({
				"accessTokenTTL": ACCESS_TOKEN_TTL_SECONDS,
				"accessTokenMaxTTL": ACCESS_TOKEN_TTL_SECONDS,
				"accessTokenNumUsesLimit": 0,
				"accessTokenPeriod": 0,
				"lockoutEnabled": true,
				"lockoutThreshold": 3,
				"lockoutDurationSeconds": 300,
				"lockoutCounterResetSeconds": 30,
				"clientSecretTrustedIps": [
					{"ipAddress": "0.0.0.0/0"},
					{"ipAddress": "::/0"}
				],
				"accessTokenTrustedIps": [
					{"ipAddress": "0.0.0.0/0"},
					{"ipAddress": "::/0"}
				]
			})),
		)?;
		let value = Self::read_json(response, "Infisical AIQ Universal Auth attachment")?;
		let client_id = required_string(
			&value,
			"/identityUniversalAuth/clientId",
			"Universal Auth attachment",
		)?;

		self.universal_url = Some(universal_url.clone());
		self.outcome_unknown = false;

		Ok((universal_url, client_id))
	}

	fn create_client_secret(&mut self, universal_url: &str) -> crate::Result<Secret> {
		self.outcome_unknown = true;

		let response = self.admin_post(
			&format!("{universal_url}/client-secrets"),
			Some(&serde_json::json!({
				"description": "AIQ continuous-observation host bootstrap",
				"ttl": 0,
				"numUsesLimit": 0
			})),
		)?;
		let mut value = Self::read_json(response, "Infisical AIQ client secret creation")?;
		let secret_id = required_string(&value, "/clientSecretData/id", "client secret creation")?;
		let secret = match value.get_mut("clientSecret").map(Value::take) {
			Some(Value::String(secret)) if !secret.is_empty() => Secret::from_string(secret),
			_ => {
				return Err(crate::Error::new(
					"Infisical AIQ client secret creation returned incomplete metadata; target is frozen",
				));
			},
		};

		self.client_secret_id = Some(secret_id);
		self.outcome_unknown = false;

		Ok(secret)
	}

	fn login(&self, client_id: &str, client_secret: &Secret) -> crate::Result<Secret> {
		let response = self.api.post(
			&format!("{}/api/v1/auth/universal-auth/login", self.configuration.api_url,),
			Some(&serde_json::json!({
				"clientId": client_id,
				"clientSecret": client_secret.as_utf8("Universal Auth client secret")?
			})),
			None,
		)?;
		let mut value = Self::read_json(response, "Infisical AIQ Universal Auth validation")?;

		match value.get_mut("accessToken").map(Value::take) {
			Some(Value::String(token)) if !token.is_empty() => Ok(Secret::from_string(token)),
			_ => Err(crate::Error::new(
				"Infisical AIQ Universal Auth validation returned no access token",
			)),
		}
	}

	fn execute(&mut self, identity: &RuntimeIdentity) -> crate::Result<ProvisionReceipt> {
		self.verify_project()?;
		self.require_identity_absence()?;

		let identity_id = self.create_identity()?;

		self.verify_membership(&identity_id)?;

		let privilege_id = self.create_privilege(&identity_id)?;

		self.verify_privilege(&privilege_id, &identity_id)?;

		let (universal_url, client_id) = self.attach_universal_auth(&identity_id)?;
		let client_secret = self.create_client_secret(&universal_url)?;
		let access_token = self.login(&client_id, &client_secret)?;
		let runtime = self.configuration.runtime_metadata(client_id.clone());

		credentials::validate_exact_provider_access(
			&self.configuration.state_root,
			&runtime,
			&access_token,
		)?;

		drop(access_token);
		create_keychain_secret(self.configuration, identity, &client_secret)?;

		self.committed = true;

		Ok(ProvisionReceipt {
			schema_version: "aiq.unattended-provider-provision-receipt.v1",
			status: "succeeded",
			provider: ProviderReceipt {
				domain: self.configuration.api_url.clone(),
				project_id: self.configuration.project_id.clone(),
				environment: PROVIDER_ENVIRONMENT,
				path: PROVIDER_PATH,
				keys: SECRET_KEYS,
			},
			identity: IdentityReceipt {
				name: self.configuration.identity_name.clone(),
				id: identity_id,
				membership_role: "no-access",
				privilege_slug: self.configuration.privilege_slug.clone(),
				privilege_id,
				auth_method: "universal-auth",
				client_id,
				access_token_ttl_seconds: ACCESS_TOKEN_TTL_SECONDS,
			},
			keychain: KeychainReceipt {
				service: self.configuration.keychain_service.clone(),
				account: self.configuration.keychain_account.clone(),
			},
			permissions: Self::privilege_permissions(),
		})
	}

	fn rollback(&mut self) -> bool {
		if self.committed || self.outcome_unknown {
			return false;
		}

		let mut complete = true;

		if let (Some(universal_url), Some(client_secret_id)) =
			(self.universal_url.as_deref(), self.client_secret_id.as_deref())
		{
			complete &= self
				.admin_post(
					&format!("{universal_url}/client-secrets/{client_secret_id}/revoke"),
					None,
				)
				.is_ok_and(|response| (200..300).contains(&response.status));
		}
		if let Some(privilege_id) = self.privilege_id.as_deref() {
			complete &= self
				.admin_delete(&format!(
					"{}/api/v2/identity-project-additional-privilege/{privilege_id}",
					self.configuration.api_url,
				))
				.is_ok_and(|response| (200..300).contains(&response.status));
		}
		if let Some(identity_id) = self.identity_id.as_deref() {
			complete &= self
				.admin_delete(&format!(
					"{}/api/v1/projects/{}/identities/{identity_id}",
					self.configuration.api_url, self.configuration.project_id,
				))
				.is_ok_and(|response| (200..300).contains(&response.status));
		}

		complete
	}
}

pub(crate) fn provision(configuration: &ProvisionConfiguration) -> crate::Result<ProvisionReceipt> {
	for (label, path) in [
		("security executable", &configuration.security_executable),
		("timeout executable", &configuration.timeout_executable),
		("Infisical executable", &configuration.infisical_executable),
	] {
		credentials::validate_executable(path, label)?;
	}

	let identity = RuntimeIdentity::read()?;

	credentials::prepare_private_directory(&configuration.state_root)?;

	let _lock = ProcessLock::try_acquire(&configuration.state_root)?
		.ok_or_else(|| crate::Error::new("another AIQ process holds the active lock"))?;

	if read_keychain_secret(configuration, &identity, &configuration.keychain_account)?.is_some() {
		return Err(crate::Error::new(
			"AIQ Universal Auth Keychain account already exists; create-only setup refused",
		));
	}

	let admin_token =
		read_keychain_secret(configuration, &identity, &configuration.admin_keychain_account)?
			.ok_or_else(|| {
				crate::Error::new("missing exact Infisical instance administration credential")
			})?;
	let mut transaction = Transaction::new(configuration, admin_token);

	match transaction.execute(&identity) {
		Ok(receipt) => Ok(receipt),
		Err(error) if transaction.committed => Err(crate::Error::new(format!(
			"AIQ provider setup committed but value-free reporting failed: {error}",
		))),
		Err(_) if transaction.outcome_unknown => Err(crate::Error::new(
			"AIQ provider setup outcome is unknown; the exact target is frozen for review",
		)),
		Err(error) if !transaction.rollback() => Err(crate::Error::new(format!(
			"AIQ provider setup failed and exact rollback is incomplete: {error}",
		))),
		Err(error) => Err(error),
	}
}

fn read_keychain_secret(
	configuration: &ProvisionConfiguration,
	identity: &RuntimeIdentity,
	account: &str,
) -> crate::Result<Option<Secret>> {
	let arguments = [
		OsString::from("find-generic-password"),
		OsString::from("-s"),
		OsString::from(&configuration.keychain_service),
		OsString::from("-a"),
		OsString::from(account),
		OsString::from("-w"),
	];
	let (status, mut output) = credentials::capture_status(
		&configuration.timeout_executable,
		"30s",
		&configuration.security_executable,
		&arguments,
		&credentials::keychain_environment(identity),
		MAX_KEYCHAIN_BYTES,
		"AIQ Keychain lookup",
	)?;

	match status.code() {
		Some(0) => credentials::secret_line(output, false, "AIQ Keychain lookup").map(Some),
		Some(44) => {
			output.fill(0);

			Ok(None)
		},
		_ => {
			output.fill(0);

			Err(crate::Error::new(format!("AIQ Keychain lookup failed with status {status}")))
		},
	}
}

fn create_keychain_secret(
	configuration: &ProvisionConfiguration,
	identity: &RuntimeIdentity,
	client_secret: &Secret,
) -> crate::Result<()> {
	let mut command = Command::new(&configuration.timeout_executable);

	command
		.args(["--signal=TERM", "--kill-after=10s", "30s"])
		.arg(&configuration.security_executable)
		.args([
			"add-generic-password",
			"-A",
			"-s",
			&configuration.keychain_service,
			"-a",
			&configuration.keychain_account,
			"-w",
		])
		.env_clear()
		.envs(credentials::keychain_environment(identity))
		.stdin(Stdio::piped())
		.stdout(Stdio::null())
		.stderr(Stdio::null())
		.process_group(0);

	let mut child = command.spawn().context("cannot start AIQ Keychain bootstrap write")?;
	let mut input = Vec::with_capacity(client_secret.as_os_str().as_bytes().len() * 2 + 2);

	input.extend_from_slice(client_secret.as_os_str().as_bytes());
	input.push(b'\n');
	input.extend_from_slice(client_secret.as_os_str().as_bytes());
	input.push(b'\n');

	let write = child
		.stdin
		.take()
		.ok_or_else(|| crate::Error::new("AIQ Keychain bootstrap has no input channel"))?
		.write_all(&input);

	input.fill(0);
	write.context("cannot write AIQ Keychain bootstrap")?;

	let status = child.wait().context("cannot wait for AIQ Keychain bootstrap write")?;
	let readback = read_keychain_secret(configuration, identity, &configuration.keychain_account)?;
	let matches = readback
		.as_ref()
		.is_some_and(|value| value.as_os_str().as_bytes() == client_secret.as_os_str().as_bytes());

	if matches {
		Ok(())
	} else if status.success() {
		Err(crate::Error::new("AIQ Keychain bootstrap readback did not match"))
	} else if readback.is_some() {
		Err(crate::Error::new("AIQ Keychain bootstrap account became ambiguous"))
	} else {
		Err(crate::Error::new(format!(
			"AIQ Keychain create-only write failed with status {status}",
		)))
	}
}

fn authorization(token: &Secret) -> crate::Result<String> {
	Ok(format!("Bearer {}", token.as_utf8("Infisical authorization token")?))
}

fn required_string(value: &Value, pointer: &str, label: &str) -> crate::Result<String> {
	value
		.pointer(pointer)
		.and_then(Value::as_str)
		.filter(|value| !value.is_empty())
		.map(str::to_owned)
		.ok_or_else(|| {
			crate::Error::new(format!(
				"Infisical AIQ {label} returned incomplete metadata; target is frozen",
			))
		})
}

#[cfg(test)]
mod tests {
	use crate::provision::Transaction;

	#[test]
	fn privilege_is_limited_to_the_exact_four_production_keys() {
		let permissions = Transaction::privilege_permissions();

		assert_eq!(
			permissions,
			serde_json::json!([{
				"subject": "secrets",
				"action": ["describeSecret", "readValue"],
				"conditions": {
					"environment": {"$eq": "prod"},
					"secretPath": {"$eq": "/aiq"},
					"secretName": {"$in": [
						"RUNNER_SIGNING_KEY",
						"RUNNER_SUBMISSION_TOKEN",
						"VERIFIER_INGRESS_TOKEN",
						"VERIFIER_SIGNING_KEY"
					]}
				}
			}])
		);
		assert!(Transaction::privilege_permissions_match(Some(&permissions)));
		assert!(!Transaction::privilege_permissions_match(Some(&serde_json::json!([{
			"subject": "secrets",
			"action": ["describeSecret", "readValue", "edit"],
			"conditions": permissions[0]["conditions"]
		}]))));
	}
}
