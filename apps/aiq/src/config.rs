//! Private runtime configuration.

use std::{
	fs,
	net::SocketAddr,
	path::{Component, Path, PathBuf},
};

use serde::Deserialize;

use crate::{Error, Result, ResultContext};

/// Configuration schema identifier.
pub const CONFIG_SCHEMA: &str = "aiq.continuous-observation-config.v2";

/// Fixed Infisical environment for unattended AIQ credentials.
pub(crate) const PROVIDER_ENVIRONMENT: &str = "prod";
/// Fixed Infisical path for unattended AIQ credentials.
pub(crate) const PROVIDER_PATH: &str = "/aiq";
/// Fixed provider key for the runner signing credential.
pub(crate) const RUNNER_SIGNING_KEY: &str = "RUNNER_SIGNING_KEY";
/// Fixed provider key for the runner submission credential.
pub(crate) const RUNNER_SUBMISSION_TOKEN: &str = "RUNNER_SUBMISSION_TOKEN";
/// Fixed provider key for the verifier ingress credential.
pub(crate) const VERIFIER_INGRESS_TOKEN: &str = "VERIFIER_INGRESS_TOKEN";
/// Fixed provider key for the verifier signing credential.
pub(crate) const VERIFIER_SIGNING_KEY: &str = "VERIFIER_SIGNING_KEY";
/// Fixed unattended provider identity name.
pub(crate) const PROVIDER_IDENTITY_NAME: &str = "aiq-continuous-observation-host";
/// Fixed unattended provider privilege slug.
pub(crate) const PROVIDER_PRIVILEGE_SLUG: &str = "aiq-continuous-observation-read";
/// Fixed Keychain account for the provider administration credential.
pub(crate) const PROVIDER_ADMIN_ACCOUNT: &str = "INSTANCE_ADMIN_TOKEN";
/// Create-only unattended provider configuration schema.
pub(crate) const PROVISION_CONFIG_SCHEMA: &str = "aiq.unattended-provider-provision.v1";

const DIGEST_PREFIX: &str = "sha256:";

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Configuration {
	pub(crate) schema_version: String,
	pub(crate) release_root: PathBuf,
	pub(crate) release_manifest_sha256: String,
	pub(crate) state_root: PathBuf,
	pub(crate) codex_auth_source: PathBuf,
	pub(crate) endpoint: String,
	pub(crate) official_jobs: u8,
	pub(crate) verifier_replay_jobs: u8,
	pub(crate) speed_jobs: u8,
	pub(crate) speed_trials: u8,
	pub(crate) unattended_secrets: Option<UnattendedSecrets>,
}
impl Configuration {
	pub(crate) fn read(path: &Path) -> Result<Self> {
		let bytes =
			fs::read(path).context(format!("cannot read configuration {}", path.display()))?;
		let configuration: Self = serde_json::from_slice(&bytes)
			.context(format!("invalid configuration {}", path.display()))?;

		configuration.validate()?;

		Ok(configuration)
	}

	fn validate(&self) -> Result<()> {
		if self.schema_version != CONFIG_SCHEMA {
			return Err(Error::new(format!("configuration schema must be {CONFIG_SCHEMA}")));
		}

		for (label, path) in [
			("release_root", &self.release_root),
			("state_root", &self.state_root),
			("codex_auth_source", &self.codex_auth_source),
		] {
			validate_absolute_path(path, label)?;
		}

		validate_digest(&self.release_manifest_sha256, "release_manifest_sha256")?;
		validate_https_origin(&self.endpoint)?;
		validate_bounded(self.official_jobs, 32, "official_jobs")?;
		validate_bounded(self.verifier_replay_jobs, 32, "verifier_replay_jobs")?;
		validate_bounded(self.speed_jobs, 17, "speed_jobs")?;

		if let Some(unattended) = &self.unattended_secrets {
			unattended.validate()?;
		}

		validate_bounded(self.speed_trials, 10, "speed_trials")
	}
}

/// Immutable non-secret metadata for unattended Infisical delivery.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct UnattendedSecrets {
	pub(crate) infisical_executable: PathBuf,
	pub(crate) timeout_executable: PathBuf,
	pub(crate) security_executable: PathBuf,
	pub(crate) api_url: String,
	pub(crate) project_id: String,
	pub(crate) client_id: String,
	pub(crate) keychain_service: String,
	pub(crate) keychain_account: String,
	pub(crate) environment: String,
	pub(crate) path: String,
	pub(crate) selectors: SecretSelectors,
}
impl UnattendedSecrets {
	fn validate(&self) -> Result<()> {
		for (label, path) in [
			("unattended_secrets.infisical_executable", &self.infisical_executable),
			("unattended_secrets.timeout_executable", &self.timeout_executable),
			("unattended_secrets.security_executable", &self.security_executable),
		] {
			validate_absolute_path(path, label)?;
		}

		validate_provider_origin(&self.api_url)?;

		for (label, value) in [
			("unattended_secrets.project_id", self.project_id.as_str()),
			("unattended_secrets.client_id", self.client_id.as_str()),
			("unattended_secrets.keychain_service", self.keychain_service.as_str()),
			("unattended_secrets.keychain_account", self.keychain_account.as_str()),
		] {
			validate_coordinate(value, label)?;
		}

		if self.environment != PROVIDER_ENVIRONMENT || self.path != PROVIDER_PATH {
			return Err(Error::new(format!(
				"unattended_secrets must select {PROVIDER_ENVIRONMENT}:{PROVIDER_PATH}",
			)));
		}

		self.selectors.validate()
	}
}

/// Explicit fixed mapping from provider keys to AIQ consumer roles.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SecretSelectors {
	pub(crate) runner_signing_key: String,
	pub(crate) runner_submission_token: String,
	pub(crate) verifier_ingress_token: String,
	pub(crate) verifier_signing_key: String,
}
impl SecretSelectors {
	pub(crate) fn validate(&self) -> Result<()> {
		for (label, actual, expected) in [
			("runner_signing_key", self.runner_signing_key.as_str(), RUNNER_SIGNING_KEY),
			(
				"runner_submission_token",
				self.runner_submission_token.as_str(),
				RUNNER_SUBMISSION_TOKEN,
			),
			(
				"verifier_ingress_token",
				self.verifier_ingress_token.as_str(),
				VERIFIER_INGRESS_TOKEN,
			),
			("verifier_signing_key", self.verifier_signing_key.as_str(), VERIFIER_SIGNING_KEY),
		] {
			if actual != expected {
				return Err(Error::new(format!(
					"unattended_secrets.selectors.{label} must be {expected}",
				)));
			}
		}

		Ok(())
	}
}

/// Non-secret exact target for create-only unattended provider setup.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ProvisionConfiguration {
	pub(crate) schema_version: String,
	pub(crate) state_root: PathBuf,
	pub(crate) infisical_executable: PathBuf,
	pub(crate) timeout_executable: PathBuf,
	pub(crate) security_executable: PathBuf,
	pub(crate) api_url: String,
	pub(crate) project_id: String,
	pub(crate) keychain_service: String,
	pub(crate) keychain_account: String,
	pub(crate) admin_keychain_account: String,
	pub(crate) identity_name: String,
	pub(crate) privilege_slug: String,
	pub(crate) environment: String,
	pub(crate) path: String,
	pub(crate) selectors: SecretSelectors,
}
impl ProvisionConfiguration {
	pub(crate) fn read(path: &Path) -> Result<Self> {
		let bytes = fs::read(path)
			.context(format!("cannot read provider setup configuration {}", path.display()))?;
		let configuration: Self = serde_json::from_slice(&bytes)
			.context(format!("invalid provider setup configuration {}", path.display()))?;

		configuration.validate()?;

		Ok(configuration)
	}

	fn validate(&self) -> Result<()> {
		if self.schema_version != PROVISION_CONFIG_SCHEMA {
			return Err(Error::new(format!(
				"provider setup configuration schema must be {PROVISION_CONFIG_SCHEMA}",
			)));
		}

		for (label, path) in [
			("state_root", &self.state_root),
			("infisical_executable", &self.infisical_executable),
			("timeout_executable", &self.timeout_executable),
			("security_executable", &self.security_executable),
		] {
			validate_absolute_path(path, label)?;
		}

		validate_provider_origin(&self.api_url)?;

		for (label, value) in [
			("project_id", self.project_id.as_str()),
			("keychain_service", self.keychain_service.as_str()),
			("keychain_account", self.keychain_account.as_str()),
			("admin_keychain_account", self.admin_keychain_account.as_str()),
			("identity_name", self.identity_name.as_str()),
			("privilege_slug", self.privilege_slug.as_str()),
		] {
			validate_coordinate(value, label)?;
		}
		for (label, actual, expected) in [
			("environment", self.environment.as_str(), PROVIDER_ENVIRONMENT),
			("path", self.path.as_str(), PROVIDER_PATH),
			(
				"admin_keychain_account",
				self.admin_keychain_account.as_str(),
				PROVIDER_ADMIN_ACCOUNT,
			),
			("identity_name", self.identity_name.as_str(), PROVIDER_IDENTITY_NAME),
			("privilege_slug", self.privilege_slug.as_str(), PROVIDER_PRIVILEGE_SLUG),
		] {
			if actual != expected {
				return Err(Error::new(format!("{label} must be {expected}")));
			}
		}

		self.selectors.validate()
	}

	pub(crate) fn runtime_metadata(&self, client_id: String) -> UnattendedSecrets {
		UnattendedSecrets {
			infisical_executable: self.infisical_executable.clone(),
			timeout_executable: self.timeout_executable.clone(),
			security_executable: self.security_executable.clone(),
			api_url: self.api_url.clone(),
			project_id: self.project_id.clone(),
			client_id,
			keychain_service: self.keychain_service.clone(),
			keychain_account: self.keychain_account.clone(),
			environment: self.environment.clone(),
			path: self.path.clone(),
			selectors: self.selectors.clone(),
		}
	}
}

pub(crate) fn validate_digest(value: &str, label: &str) -> Result<()> {
	let Some(hex) = value.strip_prefix(DIGEST_PREFIX) else {
		return Err(Error::new(format!("{label} must use the sha256 prefix")));
	};

	if hex.len() != 64
		|| !hex.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
	{
		return Err(Error::new(format!("{label} must be a lowercase SHA-256 digest")));
	}

	Ok(())
}

pub(crate) fn validate_absolute_path(path: &Path, label: &str) -> Result<()> {
	if !path.is_absolute() {
		return Err(Error::new(format!("{label} must be absolute")));
	}
	if path
		.components()
		.any(|component| matches!(component, Component::CurDir | Component::ParentDir))
	{
		return Err(Error::new(format!("{label} must not contain . or .. components")));
	}

	Ok(())
}

pub(crate) fn validate_provider_origin(value: &str) -> Result<()> {
	if value.starts_with("https://") {
		return validate_https_origin(value)
			.map_err(|_| Error::new("unattended_secrets.api_url must be an HTTPS origin"));
	}

	let Some(authority) = value.strip_prefix("http://") else {
		return Err(Error::new("unattended_secrets.api_url must use HTTPS or loopback HTTP"));
	};
	let address = authority.parse::<SocketAddr>().map_err(|_| {
		Error::new("unattended_secrets.api_url loopback HTTP origin must include a numeric port")
	})?;

	if !address.ip().is_loopback() {
		return Err(Error::new(
			"unattended_secrets.api_url HTTP origin must use a loopback address",
		));
	}

	Ok(())
}

pub(crate) fn validate_coordinate(value: &str, label: &str) -> Result<()> {
	if value.is_empty()
		|| !value
			.bytes()
			.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
	{
		return Err(Error::new(format!("{label} is missing or invalid")));
	}

	Ok(())
}

fn validate_https_origin(value: &str) -> Result<()> {
	let Some(authority) = value.strip_prefix("https://") else {
		return Err(Error::new("endpoint must use HTTPS"));
	};

	if authority.is_empty()
		|| authority.contains(['/', '?', '#', '@'])
		|| authority.chars().any(char::is_whitespace)
	{
		return Err(Error::new("endpoint must be an HTTPS origin without credentials or a path"));
	}

	Ok(())
}

fn validate_bounded(value: u8, maximum: u8, label: &str) -> Result<()> {
	if value == 0 || value > maximum {
		return Err(Error::new(format!("{label} must be between 1 and {maximum}")));
	}

	Ok(())
}

#[cfg(test)]
mod tests {
	use std::path::PathBuf;

	use crate::config::{CONFIG_SCHEMA, Configuration};

	fn valid_configuration() -> Configuration {
		Configuration {
			schema_version: CONFIG_SCHEMA.to_owned(),
			release_root: PathBuf::from("/private/releases/aiq-1.0.7"),
			release_manifest_sha256: format!("sha256:{}", "a".repeat(64)),
			state_root: PathBuf::from("/private/state"),
			codex_auth_source: PathBuf::from("/private/auth.json"),
			endpoint: "https://aiq.wiki".to_owned(),
			official_jobs: 32,
			verifier_replay_jobs: 32,
			speed_jobs: 17,
			speed_trials: 5,
			unattended_secrets: None,
		}
	}

	#[test]
	fn accepts_exact_v2_configuration() {
		assert!(valid_configuration().validate().is_ok());
	}

	#[test]
	fn rejects_non_origin_endpoint_and_unbounded_work() {
		let mut configuration = valid_configuration();

		configuration.endpoint = "https://aiq.wiki/path".to_owned();

		assert!(configuration.validate().is_err());

		configuration.endpoint = "https://aiq.wiki".to_owned();
		configuration.speed_trials = 0;

		assert!(configuration.validate().is_err());
	}

	#[test]
	fn rejects_deprecated_source_root() {
		let json = format!(
			r#"{{"schema_version":"{CONFIG_SCHEMA}","release_root":"/release","release_manifest_sha256":"sha256:{digest}","state_root":"/state","codex_auth_source":"/auth.json","endpoint":"https://aiq.wiki","official_jobs":1,"verifier_replay_jobs":1,"speed_jobs":1,"speed_trials":1,"source_root":"/deleted"}}"#,
			digest = "a".repeat(64),
		);
		let parsed = serde_json::from_str::<Configuration>(&json);

		assert!(parsed.is_err());
	}

	#[test]
	fn unattended_metadata_is_exact_and_loopback_http_is_explicit() {
		let json = format!(
			r#"{{"schema_version":"{CONFIG_SCHEMA}","release_root":"/release","release_manifest_sha256":"sha256:{digest}","state_root":"/state","codex_auth_source":"/auth.json","endpoint":"https://aiq.wiki","official_jobs":32,"verifier_replay_jobs":1,"speed_jobs":1,"speed_trials":1,"unattended_secrets":{{"infisical_executable":"/nix/store/infisical/bin/infisical","timeout_executable":"/nix/store/coreutils/bin/timeout","security_executable":"/usr/bin/security","api_url":"http://127.0.0.2:51888","project_id":"project-id","client_id":"client-id","keychain_service":"infisical-selfhost","keychain_account":"AIQ_OBSERVATION_UA_CLIENT_SECRET","environment":"prod","path":"/aiq","selectors":{{"runner_signing_key":"RUNNER_SIGNING_KEY","runner_submission_token":"RUNNER_SUBMISSION_TOKEN","verifier_ingress_token":"VERIFIER_INGRESS_TOKEN","verifier_signing_key":"VERIFIER_SIGNING_KEY"}}}}}}"#,
			digest = "a".repeat(64),
		);
		let mut configuration =
			serde_json::from_str::<Configuration>(&json).expect("configuration");

		assert!(configuration.validate().is_ok());

		configuration
			.unattended_secrets
			.as_mut()
			.expect("unattended metadata")
			.selectors
			.runner_signing_key = "OTHER_KEY".to_owned();

		assert!(configuration.validate().is_err());
	}
}
