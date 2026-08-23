//! Private runtime configuration.

use std::{
	fs,
	path::{Component, Path, PathBuf},
};

use serde::Deserialize;

use crate::{Error, Result, ResultContext};

/// Configuration schema identifier.
pub const CONFIG_SCHEMA: &str = "aiq.continuous-observation-config.v2";

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

		validate_bounded(self.speed_trials, 10, "speed_trials")
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

fn validate_absolute_path(path: &Path, label: &str) -> Result<()> {
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
}
