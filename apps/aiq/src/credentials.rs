//! Exact runtime credential delivery for unattended observations.

use std::str;
use std::{
	collections::BTreeMap,
	env,
	ffi::{OsStr, OsString},
	fs::{self, DirBuilder, Metadata},
	io::{ErrorKind, Read as _},
	os::unix::{
		ffi::{OsStrExt as _, OsStringExt as _},
		fs::{DirBuilderExt as _, MetadataExt as _},
	},
	path::{Path, PathBuf},
	process::{Child, ExitStatus, Stdio},
};

use crate::{
	Error, Result, ResultContext,
	config::{
		Configuration, PROVIDER_ENVIRONMENT, PROVIDER_PATH, RUNNER_SIGNING_KEY,
		RUNNER_SUBMISSION_TOKEN, UnattendedSecrets, VERIFIER_INGRESS_TOKEN, VERIFIER_SIGNING_KEY,
	},
	supervisor,
};

/// Protected runtime secret names.
pub const PROTECTED_SECRETS: [&str; 4] = [
	"AIQ_RUNNER_SIGNING_KEY",
	"AIQ_RUNNER_SUBMISSION_TOKEN",
	"AIQ_VERIFIER_INGRESS_TOKEN",
	"AIQ_VERIFIER_SIGNING_KEY",
];

const MAX_BOOTSTRAP_BYTES: usize = 16 * 1_024;
const MAX_PROVIDER_BYTES: usize = 64 * 1_024;
const SYSTEM_PATH: &str = "/usr/bin:/bin:/usr/sbin:/sbin";
const SECRET_BINDINGS: [(&str, &str); 4] = [
	(PROTECTED_SECRETS[0], RUNNER_SIGNING_KEY),
	(PROTECTED_SECRETS[1], RUNNER_SUBMISSION_TOKEN),
	(PROTECTED_SECRETS[2], VERIFIER_INGRESS_TOKEN),
	(PROTECTED_SECRETS[3], VERIFIER_SIGNING_KEY),
];

pub(crate) struct Secret(Vec<u8>);
impl Secret {
	fn from_os_string(value: OsString) -> Self {
		Self(value.into_vec())
	}

	fn from_output(value: Vec<u8>) -> Self {
		Self(value)
	}

	pub(crate) fn from_string(value: String) -> Self {
		Self(value.into_bytes())
	}

	pub(crate) fn as_os_str(&self) -> &OsStr {
		OsStr::from_bytes(&self.0)
	}

	pub(crate) fn as_utf8(&self, label: &str) -> Result<&str> {
		str::from_utf8(&self.0).map_err(|_| Error::new(format!("{label} is not valid UTF-8")))
	}
}

impl Drop for Secret {
	fn drop(&mut self) {
		self.0.fill(0);
	}
}

/// Four exact consumer credentials held only for the active AIQ process.
pub(crate) struct RuntimeSecrets {
	runner_signing_key: Secret,
	runner_submission_token: Secret,
	verifier_ingress_token: Secret,
	verifier_signing_key: Secret,
}
impl RuntimeSecrets {
	#[cfg(test)]
	pub(crate) fn test() -> Self {
		Self {
			runner_signing_key: Secret::from_output(b"runner-signing".to_vec()),
			runner_submission_token: Secret::from_output(b"runner-submission".to_vec()),
			verifier_ingress_token: Secret::from_output(b"verifier-ingress".to_vec()),
			verifier_signing_key: Secret::from_output(b"verifier-signing".to_vec()),
		}
	}

	pub(crate) fn resolve(configuration: &Configuration) -> Result<Self> {
		let ambient = SECRET_BINDINGS.map(|(consumer, _)| {
			(consumer, env::var_os(consumer).filter(|value| !os_is_empty(value)))
		});
		let present = ambient.iter().filter(|(_, value)| value.is_some()).count();

		if present == SECRET_BINDINGS.len() {
			let mut values = ambient.into_iter().map(|(_, value)| {
				Secret::from_os_string(value.expect("all ambient credentials are present"))
			});

			return Ok(Self {
				runner_signing_key: values.next().expect("runner signing credential"),
				runner_submission_token: values.next().expect("runner submission credential"),
				verifier_ingress_token: values.next().expect("verifier ingress credential"),
				verifier_signing_key: values.next().expect("verifier signing credential"),
			});
		}
		if present != 0 {
			return Err(Error::new(
				"partial ambient runtime secret delivery is not allowed; set all four AIQ variables or none",
			));
		}

		let unattended = configuration.unattended_secrets.as_ref().ok_or_else(|| {
			Error::new(
				"unattended_secrets configuration is required when ambient runtime secrets are absent",
			)
		})?;

		Self::retrieve(&configuration.state_root, unattended)
	}

	fn retrieve(state_root: &Path, configuration: &UnattendedSecrets) -> Result<Self> {
		for (label, path) in [
			("security executable", &configuration.security_executable),
			("timeout executable", &configuration.timeout_executable),
			("Infisical executable", &configuration.infisical_executable),
		] {
			validate_executable(path, label)?;
		}

		let identity = RuntimeIdentity::read()?;
		let session = ProviderSession::create(state_root)?;
		let client_secret = read_client_secret(configuration, &identity)?;
		let access_token = login(configuration, &identity, &session, &client_secret)?;
		let mut values = Vec::with_capacity(SECRET_BINDINGS.len());

		drop(client_secret);

		for (_, key) in SECRET_BINDINGS {
			values.push(read_exact_secret(configuration, &identity, &session, &access_token, key)?);
		}

		drop(access_token);

		session.cleanup()?;

		let mut values = values.into_iter();

		Ok(Self {
			runner_signing_key: values.next().expect("runner signing credential"),
			runner_submission_token: values.next().expect("runner submission credential"),
			verifier_ingress_token: values.next().expect("verifier ingress credential"),
			verifier_signing_key: values.next().expect("verifier signing credential"),
		})
	}

	pub(crate) fn insert(
		&self,
		names: &[&str],
		environment: &mut BTreeMap<OsString, OsString>,
	) -> Result<()> {
		for name in names {
			environment.insert(OsString::from(name), self.value(name)?.as_os_str().to_os_string());
		}

		Ok(())
	}

	fn value(&self, name: &str) -> Result<&Secret> {
		match name {
			"AIQ_RUNNER_SIGNING_KEY" => Ok(&self.runner_signing_key),
			"AIQ_RUNNER_SUBMISSION_TOKEN" => Ok(&self.runner_submission_token),
			"AIQ_VERIFIER_INGRESS_TOKEN" => Ok(&self.verifier_ingress_token),
			"AIQ_VERIFIER_SIGNING_KEY" => Ok(&self.verifier_signing_key),
			_ => Err(Error::new("unknown protected runtime secret")),
		}
	}
}

pub(crate) struct RuntimeIdentity {
	home: PathBuf,
	user: OsString,
}
impl RuntimeIdentity {
	pub(crate) fn read() -> Result<Self> {
		let home = env::var_os("HOME")
			.map(PathBuf::from)
			.filter(|path| path.is_absolute())
			.ok_or_else(|| Error::new("HOME must be an absolute path for unattended delivery"))?;
		let user = env::var_os("USER")
			.or_else(|| env::var_os("LOGNAME"))
			.filter(|value| valid_coordinate(value))
			.ok_or_else(|| Error::new("USER or LOGNAME is required for unattended delivery"))?;

		Ok(Self { home, user })
	}
}

pub(crate) struct ProviderSession {
	root: Option<PathBuf>,
	parent: PathBuf,
}
impl ProviderSession {
	pub(crate) fn create(state_root: &Path) -> Result<Self> {
		let parent = state_root.join("provider");

		prepare_private_directory(&parent)?;

		let root = parent.join("session");

		if fs::symlink_metadata(&root).is_ok() {
			remove_private_session(&root, &parent)?;
		}

		prepare_private_directory(&root)?;

		for child in ["config", "cache", "state", "tmp"] {
			prepare_private_directory(&root.join(child))?;
		}

		Ok(Self { root: Some(root), parent })
	}

	pub(crate) fn root(&self) -> &Path {
		self.root.as_deref().expect("active provider session")
	}

	pub(crate) fn cleanup(mut self) -> Result<()> {
		let root = self.root.take().expect("active provider session");

		remove_private_session(&root, &self.parent)
	}
}

impl Drop for ProviderSession {
	fn drop(&mut self) {
		if let Some(root) = self.root.take() {
			let _ = remove_private_session(&root, &self.parent);
		}
	}
}

pub(crate) fn validate_exact_provider_access(
	state_root: &Path,
	configuration: &UnattendedSecrets,
	access_token: &Secret,
) -> Result<()> {
	let identity = RuntimeIdentity::read()?;
	let session = ProviderSession::create(state_root)?;

	for (_, key) in SECRET_BINDINGS {
		drop(read_exact_secret(configuration, &identity, &session, access_token, key)?);
	}

	session.cleanup()
}

pub(crate) fn keychain_environment(identity: &RuntimeIdentity) -> BTreeMap<OsString, OsString> {
	BTreeMap::from([
		(OsString::from("HOME"), identity.home.as_os_str().to_os_string()),
		(OsString::from("LOGNAME"), identity.user.clone()),
		(OsString::from("PATH"), OsString::from(SYSTEM_PATH)),
		(OsString::from("USER"), identity.user.clone()),
	])
}

pub(crate) fn provider_environment(
	configuration: &UnattendedSecrets,
	identity: &RuntimeIdentity,
	session: &ProviderSession,
) -> BTreeMap<OsString, OsString> {
	let root = session.root();

	BTreeMap::from([
		(OsString::from("HOME"), root.as_os_str().to_os_string()),
		(OsString::from("LOGNAME"), identity.user.clone()),
		(OsString::from("NO_COLOR"), OsString::from("1")),
		(OsString::from("PATH"), OsString::from(SYSTEM_PATH)),
		(OsString::from("TMPDIR"), root.join("tmp").into_os_string()),
		(OsString::from("USER"), identity.user.clone()),
		(OsString::from("XDG_CACHE_HOME"), root.join("cache").into_os_string()),
		(OsString::from("XDG_CONFIG_HOME"), root.join("config").into_os_string()),
		(OsString::from("XDG_STATE_HOME"), root.join("state").into_os_string()),
		(OsString::from("INFISICAL_DOMAIN"), OsString::from(&configuration.api_url)),
		(OsString::from("INFISICAL_API_URL"), OsString::from(&configuration.api_url)),
		(OsString::from("INFISICAL_DISABLE_UPDATE_CHECK"), OsString::from("true")),
	])
}

pub(crate) fn capture(
	timeout: &Path,
	duration: &str,
	program: &Path,
	arguments: &[OsString],
	environment: &BTreeMap<OsString, OsString>,
	limit: usize,
	label: &str,
) -> Result<Vec<u8>> {
	let (status, mut output) =
		capture_status(timeout, duration, program, arguments, environment, limit, label)?;

	if !status.success() {
		output.fill(0);

		return Err(Error::new(format!("{label} failed with status {status}")));
	}

	Ok(output)
}

pub(crate) fn capture_status(
	timeout: &Path,
	duration: &str,
	program: &Path,
	arguments: &[OsString],
	environment: &BTreeMap<OsString, OsString>,
	limit: usize,
	label: &str,
) -> Result<(ExitStatus, Vec<u8>)> {
	let mut timeout_arguments = vec![
		OsString::from("--signal=TERM"),
		OsString::from("--kill-after=10s"),
		OsString::from(duration),
		program.as_os_str().to_os_string(),
	];

	timeout_arguments.extend_from_slice(arguments);

	let mut command = supervisor::guarded_command(timeout, &timeout_arguments, environment)?;

	command.stdout(Stdio::piped()).stderr(Stdio::null());

	let mut child = command.spawn().context(format!("cannot start {label}"))?;
	let parent_liveness = child
		.stdin
		.take()
		.ok_or_else(|| Error::new(format!("{label} has no supervisor liveness pipe")))?;
	let mut output = Vec::with_capacity(limit.min(8 * 1_024));
	let read = child
		.stdout
		.take()
		.expect("piped provider stdout")
		.take(u64::try_from(limit).unwrap_or(u64::MAX) + 1)
		.read_to_end(&mut output);

	if read.is_err() || output.len() > limit {
		drop(parent_liveness);
		wait_after_liveness_close(&mut child);

		output.fill(0);

		return Err(Error::new(format!("{label} returned invalid output")));
	}

	let status = child.wait().context(format!("cannot wait for {label}"))?;

	drop(parent_liveness);

	Ok((status, output))
}

pub(crate) fn secret_line(
	mut output: Vec<u8>,
	require_newline: bool,
	label: &str,
) -> Result<Secret> {
	if require_newline && output.last() != Some(&b'\n') {
		output.fill(0);

		return Err(Error::new(format!("{label} returned invalid output")));
	}
	if output.last() == Some(&b'\n') {
		output.pop();

		if output.last() == Some(&b'\r') {
			output.pop();
		}
	}
	if output.is_empty() || output.iter().any(|byte| matches!(byte, 0 | b'\r' | b'\n')) {
		output.fill(0);

		return Err(Error::new(format!("{label} returned invalid output")));
	}

	Ok(Secret::from_output(output))
}

pub(crate) fn validate_executable(path: &Path, label: &str) -> Result<()> {
	let metadata = fs::symlink_metadata(path)
		.context(format!("cannot inspect configured {label} {}", path.display()))?;

	if metadata.is_file() && !metadata.file_type().is_symlink() && metadata.mode() & 0o111 != 0 {
		return Ok(());
	}
	if !metadata.file_type().is_symlink() || !path.starts_with("/nix/store") {
		return Err(Error::new(format!("configured {label} is not an executable regular file")));
	}

	let canonical = fs::canonicalize(path).context(format!("cannot resolve configured {label}"))?;
	let target = fs::symlink_metadata(&canonical)
		.context(format!("cannot inspect configured {label} target"))?;

	if canonical.starts_with("/nix/store")
		&& target.is_file()
		&& !target.file_type().is_symlink()
		&& target.mode() & 0o111 != 0
	{
		Ok(())
	} else {
		Err(Error::new(format!("configured {label} has an invalid target")))
	}
}

pub(crate) fn prepare_private_directory(path: &Path) -> Result<()> {
	match fs::symlink_metadata(path) {
		Ok(metadata) => validate_private_directory(&metadata, path),
		Err(error) if error.kind() == ErrorKind::NotFound => {
			DirBuilder::new()
				.mode(0o700)
				.create(path)
				.context(format!("cannot create private directory {}", path.display()))?;

			let metadata = fs::symlink_metadata(path)
				.context(format!("cannot inspect private directory {}", path.display()))?;

			validate_private_directory(&metadata, path)
		},
		Err(error) => Err(Error::new(format!(
			"cannot inspect private directory {}: {error}",
			path.display(),
		))),
	}
}

fn read_client_secret(
	configuration: &UnattendedSecrets,
	identity: &RuntimeIdentity,
) -> Result<Secret> {
	let arguments = [
		OsString::from("find-generic-password"),
		OsString::from("-s"),
		OsString::from(&configuration.keychain_service),
		OsString::from("-a"),
		OsString::from(&configuration.keychain_account),
		OsString::from("-w"),
	];

	secret_line(
		capture(
			&configuration.timeout_executable,
			"30s",
			&configuration.security_executable,
			&arguments,
			&keychain_environment(identity),
			MAX_BOOTSTRAP_BYTES,
			"AIQ Keychain bootstrap",
		)?,
		false,
		"AIQ Keychain bootstrap",
	)
}

fn login(
	configuration: &UnattendedSecrets,
	identity: &RuntimeIdentity,
	session: &ProviderSession,
	client_secret: &Secret,
) -> Result<Secret> {
	let arguments = [
		OsString::from("login"),
		OsString::from("--method=universal-auth"),
		OsString::from(format!("--domain={}", configuration.api_url)),
		OsString::from("--silent"),
		OsString::from("--plain"),
		OsString::from("--telemetry=false"),
	];
	let mut environment = provider_environment(configuration, identity, session);

	environment.insert(
		OsString::from("INFISICAL_UNIVERSAL_AUTH_CLIENT_ID"),
		OsString::from(&configuration.client_id),
	);
	environment.insert(
		OsString::from("INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET"),
		client_secret.as_os_str().to_os_string(),
	);

	secret_line(
		capture(
			&configuration.timeout_executable,
			"2m",
			&configuration.infisical_executable,
			&arguments,
			&environment,
			MAX_PROVIDER_BYTES,
			"Infisical machine login",
		)?,
		true,
		"Infisical machine login",
	)
}

fn read_exact_secret(
	configuration: &UnattendedSecrets,
	identity: &RuntimeIdentity,
	session: &ProviderSession,
	access_token: &Secret,
	key: &str,
) -> Result<Secret> {
	let arguments = [
		OsString::from("secrets"),
		OsString::from("get"),
		OsString::from(key),
		OsString::from("--silent"),
		OsString::from(format!("--domain={}", configuration.api_url)),
		OsString::from(format!("--projectId={}", configuration.project_id)),
		OsString::from(format!("--env={PROVIDER_ENVIRONMENT}")),
		OsString::from(format!("--path={PROVIDER_PATH}")),
		OsString::from("--plain"),
		OsString::from("--expand=false"),
		OsString::from("--include-imports=false"),
		OsString::from("--recursive=false"),
		OsString::from("--secret-overriding=false"),
		OsString::from("--telemetry=false"),
	];
	let mut environment = provider_environment(configuration, identity, session);

	environment.insert(OsString::from("INFISICAL_TOKEN"), access_token.as_os_str().to_os_string());

	secret_line(
		capture(
			&configuration.timeout_executable,
			"2m",
			&configuration.infisical_executable,
			&arguments,
			&environment,
			MAX_PROVIDER_BYTES,
			"Infisical exact secret retrieval",
		)?,
		true,
		"Infisical exact secret retrieval",
	)
}

fn wait_after_liveness_close(child: &mut Child) {
	let _ = child.wait();
}

fn validate_private_directory(metadata: &Metadata, path: &Path) -> Result<()> {
	if private_directory_metadata(metadata) {
		Ok(())
	} else {
		Err(Error::new(format!("invalid private directory {}", path.display())))
	}
}

fn private_directory_metadata(metadata: &Metadata) -> bool {
	metadata.is_dir()
		&& !metadata.file_type().is_symlink()
		&& metadata.uid() == current_uid()
		&& metadata.mode() & 0o7777 == 0o700
}

fn remove_private_session(path: &Path, parent: &Path) -> Result<()> {
	if path != parent.join("session") {
		return Err(Error::new("refusing provider session cleanup outside its owner"));
	}

	let metadata = match fs::symlink_metadata(path) {
		Ok(metadata) => metadata,
		Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
		Err(error) => {
			return Err(Error::new(format!("cannot inspect provider session directory: {error}")));
		},
	};

	if !private_directory_metadata(&metadata) {
		return Err(Error::new("refusing invalid provider session directory"));
	}

	fs::remove_dir_all(path).context("cannot remove provider session directory")
}

fn valid_coordinate(value: &OsStr) -> bool {
	!value.is_empty()
		&& value
			.as_bytes()
			.iter()
			.all(|byte| byte.is_ascii_alphanumeric() || matches!(*byte, b'-' | b'_' | b'.'))
}

fn os_is_empty(value: &OsStr) -> bool {
	value.as_bytes().iter().all(u8::is_ascii_whitespace)
}

fn current_uid() -> u32 {
	// SAFETY: `geteuid` has no preconditions.
	unsafe { libc::geteuid() }
}

#[cfg(test)]
mod tests {
	use std::{env, ffi::OsString, fs, os::unix::fs::PermissionsExt as _, process};

	use crate::{
		config::{CONFIG_SCHEMA, Configuration},
		credentials::{PROTECTED_SECRETS, RuntimeSecrets},
	};

	fn configuration(root: &std::path::Path) -> Configuration {
		Configuration {
			schema_version: CONFIG_SCHEMA.to_owned(),
			release_root: root.join("release"),
			release_manifest_sha256: format!("sha256:{}", "a".repeat(64)),
			state_root: root.join("state"),
			codex_auth_source: root.join("auth.json"),
			endpoint: "https://aiq.wiki".to_owned(),
			official_jobs: 32,
			verifier_replay_jobs: 1,
			speed_jobs: 1,
			speed_trials: 1,
			unattended_secrets: None,
		}
	}

	#[test]
	fn complete_ambient_delivery_remains_supported() {
		let _environment = crate::TEST_ENVIRONMENT_LOCK.lock().expect("environment lock");
		let root = env::temp_dir().join(format!("aiq-ambient-secret-test-{}", process::id()));
		let _ = fs::remove_dir_all(&root);

		fs::create_dir_all(&root).expect("fixture root");
		fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).expect("fixture mode");

		for name in PROTECTED_SECRETS {
			// SAFETY: this test runs in one process and restores every variable below.
			unsafe { env::set_var(name, "test-secret") };
		}

		let secrets = RuntimeSecrets::resolve(&configuration(&root)).expect("ambient credentials");
		let mut environment = std::collections::BTreeMap::new();

		secrets.insert(&[PROTECTED_SECRETS[0]], &mut environment).expect("child secret");

		assert_eq!(
			environment.get(&OsString::from(PROTECTED_SECRETS[0])),
			Some(&OsString::from("test-secret"))
		);

		for name in PROTECTED_SECRETS {
			// SAFETY: this restores the process environment changed by this test.
			unsafe { env::remove_var(name) };
		}

		fs::remove_dir_all(root).expect("remove fixture");
	}

	#[test]
	fn partial_ambient_delivery_fails_closed() {
		let _environment = crate::TEST_ENVIRONMENT_LOCK.lock().expect("environment lock");
		let root = env::temp_dir().join(format!("aiq-partial-secret-test-{}", process::id()));
		let _ = fs::remove_dir_all(&root);

		for name in PROTECTED_SECRETS {
			// SAFETY: this test establishes a known process environment.
			unsafe { env::remove_var(name) };
		}

		// SAFETY: this test runs in one process and restores the variable below.
		unsafe { env::set_var(PROTECTED_SECRETS[0], "one-secret") };

		let error = RuntimeSecrets::resolve(&configuration(&root))
			.err()
			.expect("partial delivery must fail");

		assert_eq!(
			error.to_string(),
			"partial ambient runtime secret delivery is not allowed; set all four AIQ variables or none"
		);

		// SAFETY: this restores the process environment changed by this test.
		unsafe { env::remove_var(PROTECTED_SECRETS[0]) };
	}
}
