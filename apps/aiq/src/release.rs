//! Self-contained release validation and source reconstruction.

#[cfg(not(target_os = "macos"))]
use std::env;
use std::fs::Permissions;
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};
use std::process;
use std::{
	ffi::OsStr,
	fs::{self, File, OpenOptions},
	io::{Read as _, Write as _},
	path::{Path, PathBuf},
	process::{Command, Output},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{Error, Result, ResultContext, config, schedule::ScheduledSlot};

/// Release manifest schema identifier.
pub const RELEASE_MANIFEST_SCHEMA: &str = "aiq.observation-release.v1";

const GIT_EXECUTABLE: &str = match option_env!("AIQ_BUILD_GIT") {
	Some(path) => path,
	None => "git",
};
const MANIFEST_PATH: &str = "records/observation-release.v1.json";
const SOURCE_BUNDLE_PATH: &str = "records/source.bundle";
const BUILD_RECEIPT_PATH: &str = "records/final-build-receipt.v2.json";
const PRODUCTION_REFERENCE_PATH: &str = "records/production-reference.json";
const RUNNER_PATH: &str = "bin/aiq-runner";
const VERIFIER_PATH: &str = "bin/aiq-verifier";
const CODEX_PATH: &str = "codex-runtime/codex";
const CODEX_HOST_PATH: &str = "codex-runtime/codex-code-mode-host";
const COMMITMENT_PATH: &str = "core-a/commitment.json";
const SEAL_RECEIPT_PATH: &str = "core-a/receipt.json";
const CALIBRATION_ADMISSION_PATH: &str = "calibration-policy-v2/admission-v3.json";
const CAPABILITIES_PATH: &str = "official-r1/inputs/capabilities.json";
const SCHEDULE_PATH: &str = "official-r1/inputs/schedule.json";
const ENVIRONMENT_GENERATOR_PATH: &str = "official-r1/records/generate-verifier-environment.mjs";
const REQUIRED_RELEASE_DIRECTORIES: [&str; 6] =
	["bin", "calibration-policy-v2", "codex-runtime", "core-a", "official-r1", "records"];

/// Absolute inputs within one validated observation release.
#[derive(Clone, Debug)]
pub struct ReleasePaths {
	/// Pinned runner executable.
	pub runner: PathBuf,
	/// Pinned verifier executable.
	pub verifier: PathBuf,
	/// Pinned Codex executable.
	pub codex: PathBuf,
	/// Controlled hidden tasks.
	pub tasks: PathBuf,
	/// Controlled baseline workspaces.
	pub workspaces: PathBuf,
	/// Controlled evaluator registry.
	pub evaluator: PathBuf,
	/// Controlled evaluator runtime.
	pub runtime: PathBuf,
	/// Controlled toolchain root.
	pub toolchain: PathBuf,
	/// Core corpus commitment.
	pub commitment: PathBuf,
	/// Core corpus seal receipt.
	pub seal_receipt: PathBuf,
	/// Frozen calibration admission.
	pub calibration_admission: PathBuf,
	/// Official capability evidence.
	pub capabilities: PathBuf,
	/// Official schedule.
	pub schedule: PathBuf,
	/// Verifier environment record generator.
	pub environment_generator: PathBuf,
	/// Production reference record.
	pub production_reference: PathBuf,
	/// Final build receipt.
	pub build_receipt: PathBuf,
}

/// A validated, self-contained observation release.
#[derive(Clone, Debug)]
pub struct Release {
	root: PathBuf,
	manifest: ReleaseManifest,
	paths: ReleasePaths,
}
impl Release {
	/// Opens a release and verifies every identity bound by its manifest.
	///
	/// # Errors
	///
	/// Returns an error when the release path, manifest, receipt, or pinned input is invalid.
	pub fn open(root: &Path, expected_manifest_sha256: &str) -> Result<Self> {
		config::validate_digest(expected_manifest_sha256, "release_manifest_sha256")?;

		let canonical_root = canonical_directory(root, "release root")?;

		if canonical_root != root {
			return Err(Error::new("release_root must be a canonical directory path"));
		}

		let manifest_path = canonical_root.join(MANIFEST_PATH);

		verify_digest(&manifest_path, expected_manifest_sha256, "release manifest")?;

		let manifest: ReleaseManifest = read_json(&manifest_path, "release manifest")?;

		manifest.validate()?;

		let paths = release_paths(&canonical_root);

		verify_manifest_files(&canonical_root, &manifest, &paths)?;
		verify_build_receipt(&manifest, &paths.build_receipt)?;

		Ok(Self { root: canonical_root, manifest, paths })
	}

	/// Returns the release's validated runtime paths.
	#[must_use]
	pub const fn paths(&self) -> &ReleasePaths {
		&self.paths
	}

	/// Returns the release identity.
	#[must_use]
	pub fn id(&self) -> &str {
		&self.manifest.release_id
	}

	/// Returns the expected production-reference digest.
	#[must_use]
	pub fn production_reference_sha256(&self) -> &str {
		&self.manifest.production_reference_sha256
	}

	/// Returns the expected final-build-receipt digest.
	#[must_use]
	pub fn build_receipt_sha256(&self) -> &str {
		&self.manifest.build_receipt_sha256
	}

	/// Reconstructs or validates the exact detached source for one slot.
	///
	/// # Errors
	///
	/// Returns an error when the source bundle cannot produce the pinned clean source tree.
	pub fn prepare_source(&self, state_root: &Path, slot: &ScheduledSlot) -> Result<PathBuf> {
		private_directory(state_root)?;

		let scratch_root = state_root.join("scratch");

		private_directory(&scratch_root)?;

		let attempt_root = self.attempt_root(state_root, slot);

		private_directory(&attempt_root)?;

		let source = attempt_root.join("source");

		if source.exists() {
			if self.validate_source(&source).is_ok() {
				return Ok(source);
			}

			remove_scoped_tree(&source, &attempt_root)?;
		}

		let staging = attempt_root.join(format!("source.installing.{}", process::id()));

		if staging.exists() {
			remove_scoped_tree(&staging, &attempt_root)?;
		}

		let bundle = self.root.join(SOURCE_BUNDLE_PATH);

		run_git([
			OsStr::new("clone"),
			OsStr::new("--no-checkout"),
			OsStr::new("--quiet"),
			bundle.as_os_str(),
			staging.as_os_str(),
		])?;
		run_git([
			OsStr::new("-C"),
			staging.as_os_str(),
			OsStr::new("checkout"),
			OsStr::new("--detach"),
			OsStr::new("--quiet"),
			OsStr::new(&self.manifest.source_commit),
		])?;

		self.validate_source(&staging)?;

		fs::rename(&staging, &source).context("cannot activate reconstructed source")?;

		Ok(source)
	}

	/// Removes reconstructable source material for one terminal slot.
	///
	/// # Errors
	///
	/// Returns an error when the managed attempt directory cannot be removed safely.
	pub fn cleanup_source(&self, state_root: &Path, slot: &ScheduledSlot) -> Result<()> {
		let attempt_root = self.attempt_root(state_root, slot);
		let release_root =
			attempt_root.parent().ok_or_else(|| Error::new("invalid attempt root"))?;

		remove_scoped_tree(&attempt_root, release_root)
	}

	fn validate_source(&self, source: &Path) -> Result<()> {
		let head = git_stdout([
			OsStr::new("-C"),
			source.as_os_str(),
			OsStr::new("rev-parse"),
			OsStr::new("HEAD"),
		])?;

		if head != self.manifest.source_commit {
			return Err(Error::new("reconstructed source commit does not match the release"));
		}

		let tree = git_stdout([
			OsStr::new("-C"),
			source.as_os_str(),
			OsStr::new("rev-parse"),
			#[allow(clippy::literal_string_with_formatting_args)]
			OsStr::new("HEAD^{tree}"),
		])?;

		if tree != self.manifest.source_tree {
			return Err(Error::new("reconstructed source tree does not match the release"));
		}

		let branch = Command::new(GIT_EXECUTABLE)
			.args(["-C"])
			.arg(source)
			.args(["symbolic-ref", "-q", "HEAD"])
			.output()
			.context("cannot inspect reconstructed source HEAD")?;

		if branch.status.success() {
			return Err(Error::new("reconstructed source must have a detached HEAD"));
		}

		let status = git_stdout([
			OsStr::new("-C"),
			source.as_os_str(),
			OsStr::new("status"),
			OsStr::new("--porcelain=v1"),
			OsStr::new("--untracked-files=all"),
		])?;

		if !status.is_empty() {
			return Err(Error::new("reconstructed source is not clean"));
		}

		Ok(())
	}

	fn attempt_root(&self, state_root: &Path, slot: &ScheduledSlot) -> PathBuf {
		state_root.join("scratch").join(format!("{}--{}", self.manifest.release_id, slot.id))
	}
}

/// Result of installing one self-contained observation release.
#[derive(Clone, Debug, Serialize)]
pub struct InstalledRelease {
	/// Installed release root.
	pub release_root: PathBuf,
	/// Release manifest path.
	pub manifest: PathBuf,
	/// Digest to pin in private runtime configuration.
	pub release_manifest_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct BuildReceipt {
	schema_version: String,
	source_commit: String,
	source_tree: String,
	runner_executable_sha256: String,
	verifier_executable_sha256: String,
	codex_executable_sha256: String,
	codex_code_mode_host_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ReleaseManifest {
	schema_version: String,
	release_id: String,
	source_bundle_sha256: String,
	source_commit: String,
	source_tree: String,
	runner_sha256: String,
	verifier_sha256: String,
	codex_sha256: String,
	codex_code_mode_host_sha256: String,
	core_commitment_sha256: String,
	core_seal_receipt_sha256: String,
	calibration_admission_sha256: String,
	capabilities_sha256: String,
	schedule_sha256: String,
	environment_generator_sha256: String,
	production_reference_sha256: String,
	build_receipt_sha256: String,
}
impl ReleaseManifest {
	fn validate(&self) -> Result<()> {
		if self.schema_version != RELEASE_MANIFEST_SCHEMA {
			return Err(Error::new(format!(
				"release manifest schema must be {RELEASE_MANIFEST_SCHEMA}"
			)));
		}

		validate_release_id(&self.release_id)?;

		if self.source_commit.len() != 40
			|| !self.source_commit.bytes().all(|byte| byte.is_ascii_hexdigit())
			|| self.source_tree.len() != 40
			|| !self.source_tree.bytes().all(|byte| byte.is_ascii_hexdigit())
		{
			return Err(Error::new(
				"release source commit and tree must be full hexadecimal object IDs",
			));
		}

		for (label, digest) in self.digest_fields() {
			config::validate_digest(digest, label)?;
		}

		Ok(())
	}

	fn digest_fields(&self) -> [(&'static str, &str); 13] {
		[
			("source_bundle_sha256", &self.source_bundle_sha256),
			("runner_sha256", &self.runner_sha256),
			("verifier_sha256", &self.verifier_sha256),
			("codex_sha256", &self.codex_sha256),
			("codex_code_mode_host_sha256", &self.codex_code_mode_host_sha256),
			("core_commitment_sha256", &self.core_commitment_sha256),
			("core_seal_receipt_sha256", &self.core_seal_receipt_sha256),
			("calibration_admission_sha256", &self.calibration_admission_sha256),
			("capabilities_sha256", &self.capabilities_sha256),
			("schedule_sha256", &self.schedule_sha256),
			("environment_generator_sha256", &self.environment_generator_sha256),
			("production_reference_sha256", &self.production_reference_sha256),
			("build_receipt_sha256", &self.build_receipt_sha256),
		]
	}
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReleaseSchedule {
	schema_version: String,
	timezone: String,
	day_local_time: String,
	night_local_time: String,
}
impl ReleaseSchedule {
	fn validate(&self) -> Result<()> {
		if self.schema_version != "aiq.schedule.v1"
			|| self.timezone != "UTC"
			|| self.day_local_time != "15:00"
			|| self.night_local_time != "03:00"
		{
			return Err(Error::new(
				"release schedule must define the canonical 03:00 and 15:00 UTC slots",
			));
		}

		Ok(())
	}
}

/// Installs the minimal operational subset of a frozen release.
///
/// # Errors
///
/// Returns an error when source validation, copying, bundling, or atomic installation fails.
pub fn install_release(
	source_release: &Path,
	source_repository: &Path,
	destination: &Path,
	release_id: &str,
) -> Result<InstalledRelease> {
	validate_release_id(release_id)?;

	let source_release = canonical_directory(source_release, "source release")?;
	let source_repository = canonical_directory(source_repository, "source repository")?;

	if destination.exists() {
		return Err(Error::new("release destination already exists"));
	}

	let parent = destination
		.parent()
		.ok_or_else(|| Error::new("release destination must have a parent directory"))?;

	private_directory(parent)?;

	let parent = canonical_directory(parent, "release destination parent")?;

	if destination.parent() != Some(parent.as_path()) {
		return Err(Error::new("release destination parent must be canonical"));
	}

	let staging = parent.join(format!(".{release_id}.installing.{}", process::id()));

	if staging.exists() {
		return Err(Error::new(format!("staging release already exists: {}", staging.display())));
	}

	private_directory(&staging)?;

	let result = install_release_in_staging(
		&source_release,
		&source_repository,
		destination,
		&staging,
		release_id,
	);

	if result.is_err() && staging.exists() {
		let _ = remove_scoped_tree(&staging, &parent);
	}

	result
}

fn validate_release_id(value: &str) -> Result<()> {
	if value.is_empty()
		|| value.len() > 96
		|| matches!(value, "." | "..")
		|| !value
			.bytes()
			.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
	{
		return Err(Error::new("release_id must be one safe filesystem component"));
	}

	Ok(())
}

fn install_release_in_staging(
	source_release: &Path,
	source_repository: &Path,
	destination: &Path,
	staging: &Path,
	release_id: &str,
) -> Result<InstalledRelease> {
	let build_receipt: BuildReceipt =
		read_json(&source_release.join(BUILD_RECEIPT_PATH), "final build receipt")?;

	validate_build_receipt_shape(&build_receipt)?;
	verify_repository_source(source_repository, &build_receipt)?;

	for relative in REQUIRED_RELEASE_DIRECTORIES {
		copy_release_directory(&source_release.join(relative), &staging.join(relative))?;
	}

	create_source_bundle(
		source_repository,
		&build_receipt.source_commit,
		&staging.join(SOURCE_BUNDLE_PATH),
	)?;

	let manifest = build_manifest(staging, release_id, &build_receipt)?;

	manifest.validate()?;

	let manifest_path = staging.join(MANIFEST_PATH);

	write_pretty_json(&manifest_path, &manifest)?;

	let manifest_digest = digest_file(&manifest_path)?;

	Release::open(staging, &manifest_digest)?;
	fs::rename(staging, destination).context("cannot activate installed release")?;

	Ok(InstalledRelease {
		release_root: destination.to_path_buf(),
		manifest: destination.join(MANIFEST_PATH),
		release_manifest_sha256: manifest_digest,
	})
}

fn build_manifest(
	root: &Path,
	release_id: &str,
	receipt: &BuildReceipt,
) -> Result<ReleaseManifest> {
	Ok(ReleaseManifest {
		schema_version: RELEASE_MANIFEST_SCHEMA.to_owned(),
		release_id: release_id.to_owned(),
		source_bundle_sha256: digest_file(&root.join(SOURCE_BUNDLE_PATH))?,
		source_commit: receipt.source_commit.clone(),
		source_tree: receipt.source_tree.clone(),
		runner_sha256: digest_file(&root.join(RUNNER_PATH))?,
		verifier_sha256: digest_file(&root.join(VERIFIER_PATH))?,
		codex_sha256: digest_file(&root.join(CODEX_PATH))?,
		codex_code_mode_host_sha256: digest_file(&root.join(CODEX_HOST_PATH))?,
		core_commitment_sha256: digest_file(&root.join(COMMITMENT_PATH))?,
		core_seal_receipt_sha256: digest_file(&root.join(SEAL_RECEIPT_PATH))?,
		calibration_admission_sha256: digest_file(&root.join(CALIBRATION_ADMISSION_PATH))?,
		capabilities_sha256: digest_file(&root.join(CAPABILITIES_PATH))?,
		schedule_sha256: digest_file(&root.join(SCHEDULE_PATH))?,
		environment_generator_sha256: digest_file(&root.join(ENVIRONMENT_GENERATOR_PATH))?,
		production_reference_sha256: digest_file(&root.join(PRODUCTION_REFERENCE_PATH))?,
		build_receipt_sha256: digest_file(&root.join(BUILD_RECEIPT_PATH))?,
	})
}

fn verify_manifest_files(
	root: &Path,
	manifest: &ReleaseManifest,
	paths: &ReleasePaths,
) -> Result<()> {
	for (path, digest, label) in [
		(root.join(SOURCE_BUNDLE_PATH), &manifest.source_bundle_sha256, "source bundle"),
		(paths.runner.clone(), &manifest.runner_sha256, "runner"),
		(paths.verifier.clone(), &manifest.verifier_sha256, "verifier"),
		(paths.codex.clone(), &manifest.codex_sha256, "Codex executable"),
		(root.join(CODEX_HOST_PATH), &manifest.codex_code_mode_host_sha256, "Codex code-mode host"),
		(paths.commitment.clone(), &manifest.core_commitment_sha256, "core commitment"),
		(paths.seal_receipt.clone(), &manifest.core_seal_receipt_sha256, "core seal receipt"),
		(
			paths.calibration_admission.clone(),
			&manifest.calibration_admission_sha256,
			"calibration admission",
		),
		(paths.capabilities.clone(), &manifest.capabilities_sha256, "capabilities"),
		(paths.schedule.clone(), &manifest.schedule_sha256, "schedule"),
		(
			paths.environment_generator.clone(),
			&manifest.environment_generator_sha256,
			"environment generator",
		),
		(
			paths.production_reference.clone(),
			&manifest.production_reference_sha256,
			"production reference",
		),
		(paths.build_receipt.clone(), &manifest.build_receipt_sha256, "final build receipt"),
	] {
		verify_digest(&path, digest, label)?;
	}

	let schedule: ReleaseSchedule = read_json(&paths.schedule, "release schedule")?;

	schedule.validate()?;

	for (path, label) in [
		(&paths.tasks, "hidden tasks"),
		(&paths.workspaces, "baseline workspaces"),
		(&paths.evaluator, "evaluator registry"),
		(&paths.toolchain, "toolchain"),
	] {
		canonical_directory(path, label)?;
	}
	for (path, label) in [
		(&paths.runner, "runner"),
		(&paths.verifier, "verifier"),
		(&paths.codex, "Codex executable"),
		(&paths.runtime, "evaluator runtime"),
	] {
		verify_executable(path, label)?;
	}

	Ok(())
}

fn verify_build_receipt(manifest: &ReleaseManifest, path: &Path) -> Result<()> {
	let receipt: BuildReceipt = read_json(path, "final build receipt")?;

	validate_build_receipt_shape(&receipt)?;

	for (actual, expected, label) in [
		(receipt.source_commit.as_str(), manifest.source_commit.as_str(), "source commit"),
		(receipt.source_tree.as_str(), manifest.source_tree.as_str(), "source tree"),
		(
			receipt.runner_executable_sha256.as_str(),
			manifest.runner_sha256.as_str(),
			"runner digest",
		),
		(
			receipt.verifier_executable_sha256.as_str(),
			manifest.verifier_sha256.as_str(),
			"verifier digest",
		),
		(receipt.codex_executable_sha256.as_str(), manifest.codex_sha256.as_str(), "Codex digest"),
		(
			receipt.codex_code_mode_host_sha256.as_str(),
			manifest.codex_code_mode_host_sha256.as_str(),
			"Codex code-mode host digest",
		),
	] {
		if actual != expected {
			return Err(Error::new(format!(
				"final build receipt {label} does not match the release manifest"
			)));
		}
	}

	Ok(())
}

fn validate_build_receipt_shape(receipt: &BuildReceipt) -> Result<()> {
	if receipt.schema_version != "aiq.final-build-receipt.v2" {
		return Err(Error::new("final build receipt schema is invalid"));
	}

	for (label, digest) in [
		("runner_executable_sha256", receipt.runner_executable_sha256.as_str()),
		("verifier_executable_sha256", receipt.verifier_executable_sha256.as_str()),
		("codex_executable_sha256", receipt.codex_executable_sha256.as_str()),
		("codex_code_mode_host_sha256", receipt.codex_code_mode_host_sha256.as_str()),
	] {
		config::validate_digest(digest, label)?;
	}

	Ok(())
}

fn verify_repository_source(repository: &Path, receipt: &BuildReceipt) -> Result<()> {
	let commit = git_stdout([
		OsStr::new("-C"),
		repository.as_os_str(),
		OsStr::new("rev-parse"),
		OsStr::new(&format!("{}^{{commit}}", receipt.source_commit)),
	])?;
	let tree = git_stdout([
		OsStr::new("-C"),
		repository.as_os_str(),
		OsStr::new("rev-parse"),
		OsStr::new(&format!("{}^{{tree}}", receipt.source_commit)),
	])?;

	if commit != receipt.source_commit || tree != receipt.source_tree {
		return Err(Error::new(
			"source repository does not contain the final build receipt source",
		));
	}

	Ok(())
}

fn create_source_bundle(repository: &Path, commit: &str, destination: &Path) -> Result<()> {
	let parent = destination.parent().ok_or_else(|| Error::new("source bundle has no parent"))?;

	private_directory(parent)?;

	let bare = private_temporary_root().join(format!("bundle-build.{}", process::id()));

	if bare.exists() {
		remove_scoped_tree(&bare, &private_temporary_root())?;
	}

	private_directory(&private_temporary_root())?;

	let result = (|| {
		run_git([
			OsStr::new("init"),
			OsStr::new("--bare"),
			OsStr::new("--quiet"),
			bare.as_os_str(),
		])?;
		run_git([
			OsStr::new("--git-dir"),
			bare.as_os_str(),
			OsStr::new("fetch"),
			OsStr::new("--quiet"),
			repository.as_os_str(),
			OsStr::new(&format!("{commit}:refs/heads/release")),
		])?;
		run_git([
			OsStr::new("--git-dir"),
			bare.as_os_str(),
			OsStr::new("bundle"),
			OsStr::new("create"),
			destination.as_os_str(),
			OsStr::new("refs/heads/release"),
		])?;

		run_git([
			OsStr::new("--git-dir"),
			bare.as_os_str(),
			OsStr::new("bundle"),
			OsStr::new("verify"),
			destination.as_os_str(),
		])
	})();
	let cleanup = remove_scoped_tree(&bare, &private_temporary_root());

	result.and(cleanup)
}

fn copy_release_directory(source: &Path, destination: &Path) -> Result<()> {
	canonical_directory(source, "required release directory")?;

	#[cfg(target_os = "macos")]
	let output = Command::new("/usr/bin/ditto")
		.arg(source)
		.arg(destination)
		.output()
		.context("cannot start ditto for release installation")?;
	#[cfg(not(target_os = "macos"))]
	let output = Command::new("cp")
		.args(["-R", "-p"])
		.arg(source)
		.arg(destination)
		.output()
		.context("cannot start cp for release installation")?;

	ensure_command_success(&output, "release directory copy")
}

fn release_paths(root: &Path) -> ReleasePaths {
	let core = root.join("core-a");

	ReleasePaths {
		runner: root.join(RUNNER_PATH),
		verifier: root.join(VERIFIER_PATH),
		codex: root.join(CODEX_PATH),
		tasks: core.join("tasks"),
		workspaces: core.join("baselines"),
		evaluator: core.join("evaluator"),
		runtime: core.join("toolchain/node"),
		toolchain: core.join("toolchain"),
		commitment: root.join(COMMITMENT_PATH),
		seal_receipt: root.join(SEAL_RECEIPT_PATH),
		calibration_admission: root.join(CALIBRATION_ADMISSION_PATH),
		capabilities: root.join(CAPABILITIES_PATH),
		schedule: root.join(SCHEDULE_PATH),
		environment_generator: root.join(ENVIRONMENT_GENERATOR_PATH),
		production_reference: root.join(PRODUCTION_REFERENCE_PATH),
		build_receipt: root.join(BUILD_RECEIPT_PATH),
	}
}

fn canonical_directory(path: &Path, label: &str) -> Result<PathBuf> {
	let metadata =
		fs::symlink_metadata(path).context(format!("cannot inspect {label} {}", path.display()))?;

	if metadata.file_type().is_symlink() || !metadata.is_dir() {
		return Err(Error::new(format!("{label} must be a non-symlink directory")));
	}

	fs::canonicalize(path).context(format!("cannot canonicalize {label} {}", path.display()))
}

fn verify_executable(path: &Path, label: &str) -> Result<()> {
	let metadata =
		fs::symlink_metadata(path).context(format!("cannot inspect {label} {}", path.display()))?;

	if metadata.file_type().is_symlink() || !metadata.is_file() {
		return Err(Error::new(format!("{label} must be a non-symlink regular file")));
	}
	#[cfg(unix)]
	if metadata.permissions().mode() & 0o111 == 0 {
		return Err(Error::new(format!("{label} must be executable")));
	}

	Ok(())
}

fn verify_digest(path: &Path, expected: &str, label: &str) -> Result<()> {
	let actual = digest_file(path)?;

	if actual != expected {
		return Err(Error::new(format!("{label} digest mismatch at {}", path.display())));
	}

	Ok(())
}

fn digest_file(path: &Path) -> Result<String> {
	let metadata = fs::symlink_metadata(path)
		.context(format!("cannot inspect release file {}", path.display()))?;

	if metadata.file_type().is_symlink() || !metadata.is_file() {
		return Err(Error::new(format!(
			"release input must be a non-symlink regular file: {}",
			path.display()
		)));
	}

	let mut file =
		File::open(path).context(format!("cannot read release file {}", path.display()))?;
	let mut hasher = Sha256::new();
	let mut buffer = [0_u8; 8 * 1_024];

	loop {
		let count = file.read(&mut buffer).context(format!("cannot hash {}", path.display()))?;

		if count == 0 {
			break;
		}

		hasher.update(&buffer[..count]);
	}

	Ok(format!("sha256:{}", hex::encode(hasher.finalize())))
}

fn read_json<T>(path: &Path, label: &str) -> Result<T>
where
	T: for<'de> Deserialize<'de>,
{
	let bytes = fs::read(path).context(format!("cannot read {label} {}", path.display()))?;

	serde_json::from_slice(&bytes).context(format!("invalid {label} {}", path.display()))
}

fn write_pretty_json(path: &Path, value: &impl Serialize) -> Result<()> {
	let bytes = serde_json::to_vec_pretty(value).context("cannot serialize release manifest")?;
	let mut options = OpenOptions::new();

	options.write(true).create_new(true);
	#[cfg(unix)]
	options.mode(0o644);

	let mut file = options.open(path).context(format!("cannot create {}", path.display()))?;

	file.write_all(&bytes).context("cannot write release manifest")?;
	file.write_all(b"\n").context("cannot finish release manifest")?;

	file.sync_all().context("cannot sync release manifest")
}

fn private_directory(path: &Path) -> Result<()> {
	fs::create_dir_all(path)
		.context(format!("cannot create private directory {}", path.display()))?;

	let metadata = fs::symlink_metadata(path)
		.context(format!("cannot inspect private directory {}", path.display()))?;

	if metadata.file_type().is_symlink() || !metadata.is_dir() {
		return Err(Error::new(format!("private path is not a directory: {}", path.display())));
	}

	#[cfg(unix)]
	fs::set_permissions(path, Permissions::from_mode(0o700))
		.context(format!("cannot protect directory {}", path.display()))?;

	Ok(())
}

fn private_temporary_root() -> PathBuf {
	#[cfg(target_os = "macos")]
	{
		// SAFETY: `getuid` has no preconditions.
		let user = unsafe { libc::getuid() };

		PathBuf::from(format!("/private/tmp/aiq-{user}"))
	}

	#[cfg(not(target_os = "macos"))]
	{
		env::temp_dir().join(format!("aiq-{}", process::id()))
	}
}

fn remove_scoped_tree(path: &Path, parent: &Path) -> Result<()> {
	if path == parent || path.parent() != Some(parent) {
		return Err(Error::new("refusing to remove a path outside its exact managed parent"));
	}
	if !path.exists() {
		return Ok(());
	}

	let metadata =
		fs::symlink_metadata(path).context(format!("cannot inspect {}", path.display()))?;

	if metadata.file_type().is_symlink() {
		fs::remove_file(path).context(format!("cannot remove symlink {}", path.display()))
	} else {
		fs::remove_dir_all(path).context(format!("cannot remove directory {}", path.display()))
	}
}

fn run_git<I, S>(arguments: I) -> Result<()>
where
	I: IntoIterator<Item = S>,
	S: AsRef<OsStr>,
{
	let output =
		Command::new(GIT_EXECUTABLE).args(arguments).output().context("cannot start Git")?;

	ensure_command_success(&output, "Git")
}

fn git_stdout<I, S>(arguments: I) -> Result<String>
where
	I: IntoIterator<Item = S>,
	S: AsRef<OsStr>,
{
	let output =
		Command::new(GIT_EXECUTABLE).args(arguments).output().context("cannot start Git")?;

	if !output.status.success() {
		return Err(command_failure(&output, "Git"));
	}

	String::from_utf8(output.stdout)
		.context("Git output is not UTF-8")
		.map(|value| value.trim().to_owned())
}

fn ensure_command_success(output: &Output, label: &str) -> Result<()> {
	if output.status.success() { Ok(()) } else { Err(command_failure(output, label)) }
}

fn command_failure(output: &Output, label: &str) -> Error {
	let detail = String::from_utf8_lossy(&output.stderr).replace(['\r', '\n'], " ");

	Error::new(format!(
		"{label} failed with status {}: {}",
		output.status,
		detail.trim().chars().take(1_000).collect::<String>()
	))
}

#[cfg(test)]
mod tests {
	use std::env;
	#[cfg(unix)]
	use std::os;
	#[cfg(unix)]
	use std::os::unix::fs::PermissionsExt as _;
	use std::{
		ffi::OsStr,
		fs,
		path::{Path, PathBuf},
		process::{self, Command},
	};

	use crate::release::{
		self, BUILD_RECEIPT_PATH, BuildReceipt, CALIBRATION_ADMISSION_PATH, CAPABILITIES_PATH,
		CODEX_HOST_PATH, CODEX_PATH, COMMITMENT_PATH, ENVIRONMENT_GENERATOR_PATH, MANIFEST_PATH,
		PRODUCTION_REFERENCE_PATH, RELEASE_MANIFEST_SCHEMA, REQUIRED_RELEASE_DIRECTORIES,
		RUNNER_PATH, Release, ReleaseManifest, SCHEDULE_PATH, SEAL_RECEIPT_PATH,
		SOURCE_BUNDLE_PATH, VERIFIER_PATH,
	};
	use crate::schedule;

	struct ReleaseFixture {
		root: PathBuf,
		release: PathBuf,
		manifest_digest: String,
	}

	impl Drop for ReleaseFixture {
		fn drop(&mut self) {
			let _ = fs::remove_dir_all(&self.root);
		}
	}

	#[test]
	fn manifest_rejects_unsafe_release_identity() {
		let digest = format!("sha256:{}", "a".repeat(64));
		let mut manifest = ReleaseManifest {
			schema_version: RELEASE_MANIFEST_SCHEMA.to_owned(),
			release_id: "../escape".to_owned(),
			source_bundle_sha256: digest.clone(),
			source_commit: "b".repeat(40),
			source_tree: "c".repeat(40),
			runner_sha256: digest.clone(),
			verifier_sha256: digest.clone(),
			codex_sha256: digest.clone(),
			codex_code_mode_host_sha256: digest.clone(),
			core_commitment_sha256: digest.clone(),
			core_seal_receipt_sha256: digest.clone(),
			calibration_admission_sha256: digest.clone(),
			capabilities_sha256: digest.clone(),
			schedule_sha256: digest.clone(),
			environment_generator_sha256: digest.clone(),
			production_reference_sha256: digest.clone(),
			build_receipt_sha256: digest,
		};

		assert!(manifest.validate().is_err());

		manifest.release_id = "aiq-core-1.0.7-7e4ff5f".to_owned();

		assert!(manifest.validate().is_ok());
	}

	#[test]
	fn release_schedule_is_exact() {
		let mut schedule = release::ReleaseSchedule {
			schema_version: "aiq.schedule.v1".to_owned(),
			timezone: "UTC".to_owned(),
			day_local_time: "15:00".to_owned(),
			night_local_time: "03:00".to_owned(),
		};

		assert!(schedule.validate().is_ok());

		schedule.timezone = "America/New_York".to_owned();

		assert!(schedule.validate().is_err());
	}

	#[cfg(unix)]
	#[test]
	fn private_directory_rejects_a_symlink() {
		let root = env::temp_dir().join(format!("aiq-private-dir-test-{}", process::id()));
		let target = root.join("target");
		let link = root.join("link");
		let _ = fs::remove_dir_all(&root);

		fs::create_dir_all(&target).expect("private directory target");
		os::unix::fs::symlink(&target, &link).expect("private directory symlink");

		assert!(release::private_directory(&link).is_err());

		fs::remove_dir_all(root).expect("remove private directory fixture");
	}

	#[test]
	fn scoped_cleanup_rejects_parent_and_nested_paths() {
		let parent = Path::new("/private/tmp/aiq-test");

		assert!(release::remove_scoped_tree(parent, parent).is_err());
		assert!(release::remove_scoped_tree(&parent.join("one/two"), parent).is_err());
	}

	#[test]
	fn source_bundle_reconstructs_the_same_clean_detached_path() {
		let fixture = release_fixture();
		let release = Release::open(&fixture.release, &fixture.manifest_digest)
			.expect("validated fixture release");
		let slot = schedule::scheduled_slot("2026-08-10T03-00Z").expect("fixture slot");
		let state = fixture.root.join("state");
		let first = release.prepare_source(&state, &slot).expect("first source reconstruction");
		let expected_attempt = format!("{}--{}", release.id(), slot.id);

		assert!(first.starts_with(state.join("scratch")));
		assert_eq!(first.parent().and_then(Path::file_name), Some(OsStr::new(&expected_attempt)));
		assert_eq!(
			fs::read_to_string(first.join("tracked.txt")).expect("tracked source"),
			"pinned\n"
		);

		fs::write(first.join("tracked.txt"), "dirty\n").expect("dirty source fixture");

		let second = release.prepare_source(&state, &slot).expect("clean source reconstruction");

		assert_eq!(first, second, "resume must reuse the exact absolute source path");
		assert_eq!(
			fs::read_to_string(second.join("tracked.txt")).expect("restored source"),
			"pinned\n"
		);

		release.cleanup_source(&state, &slot).expect("source cleanup");

		assert!(!second.exists());

		drop(fixture);
	}

	fn release_fixture() -> ReleaseFixture {
		let root = env::temp_dir().join(format!("aiq-release-test-{}", process::id()));
		let _ = fs::remove_dir_all(&root);
		let release = root.join("release");
		let repository = root.join("repository");

		prepare_release_tree(&release);

		fs::create_dir_all(&repository).expect("repository fixture");

		git(&repository, ["init", "--quiet"]);

		fs::write(repository.join("tracked.txt"), "pinned\n").expect("repository source fixture");

		git(&repository, ["add", "tracked.txt"]);

		let status = Command::new(release::GIT_EXECUTABLE)
			.args(["-C"])
			.arg(&repository)
			.args([
				"-c",
				"core.hooksPath=/dev/null",
				"-c",
				"user.name=AIQ Test",
				"-c",
				"user.email=aiq@example.invalid",
				"commit",
				"--quiet",
				"-m",
				"fixture",
			])
			.status()
			.expect("fixture Git commit");

		assert!(status.success());

		let source_commit = release::git_stdout([
			OsStr::new("-C"),
			repository.as_os_str(),
			OsStr::new("rev-parse"),
			OsStr::new("HEAD"),
		])
		.expect("fixture commit");
		let source_tree = release::git_stdout([
			OsStr::new("-C"),
			repository.as_os_str(),
			OsStr::new("rev-parse"),
			OsStr::new("HEAD^{tree}"),
		])
		.expect("fixture tree");
		let receipt = BuildReceipt {
			schema_version: "aiq.final-build-receipt.v2".to_owned(),
			source_commit,
			source_tree,
			runner_executable_sha256: release::digest_file(&release.join(RUNNER_PATH))
				.expect("runner digest"),
			verifier_executable_sha256: release::digest_file(&release.join(VERIFIER_PATH))
				.expect("verifier digest"),
			codex_executable_sha256: release::digest_file(&release.join(CODEX_PATH))
				.expect("Codex digest"),
			codex_code_mode_host_sha256: release::digest_file(&release.join(CODEX_HOST_PATH))
				.expect("Codex host digest"),
		};

		release::write_pretty_json(&release.join(BUILD_RECEIPT_PATH), &receipt)
			.expect("build receipt fixture");
		release::create_source_bundle(
			&repository,
			&receipt.source_commit,
			&release.join(SOURCE_BUNDLE_PATH),
		)
		.expect("source bundle fixture");

		let manifest =
			release::build_manifest(&release, "fixture-1.0.7", &receipt).expect("manifest fixture");

		release::write_pretty_json(&release.join(MANIFEST_PATH), &manifest)
			.expect("manifest write");

		let manifest_digest =
			release::digest_file(&release.join(MANIFEST_PATH)).expect("manifest digest");
		let release = fs::canonicalize(release).expect("canonical fixture release");

		ReleaseFixture { root, release, manifest_digest }
	}

	fn prepare_release_tree(release: &Path) {
		for path in REQUIRED_RELEASE_DIRECTORIES.map(|relative| release.join(relative)) {
			fs::create_dir_all(path).expect("release directory fixture");
		}
		for relative in ["core-a/tasks", "core-a/baselines", "core-a/evaluator", "core-a/toolchain"]
		{
			fs::create_dir_all(release.join(relative)).expect("release input directory fixture");
		}
		for relative in [
			RUNNER_PATH,
			VERIFIER_PATH,
			CODEX_PATH,
			CODEX_HOST_PATH,
			"core-a/toolchain/node",
			COMMITMENT_PATH,
			SEAL_RECEIPT_PATH,
			CALIBRATION_ADMISSION_PATH,
			CAPABILITIES_PATH,
			SCHEDULE_PATH,
			ENVIRONMENT_GENERATOR_PATH,
			PRODUCTION_REFERENCE_PATH,
		] {
			let path = release.join(relative);

			fs::create_dir_all(path.parent().expect("fixture parent"))
				.expect("fixture parent directory");
			fs::write(path, format!("fixture:{relative}\n")).expect("release file fixture");
		}

		fs::write(
			release.join(SCHEDULE_PATH),
			br#"{"schema_version":"aiq.schedule.v1","timezone":"UTC","day_local_time":"15:00","night_local_time":"03:00"}"#,
		)
		.expect("release schedule fixture");

		for relative in
			[RUNNER_PATH, VERIFIER_PATH, CODEX_PATH, CODEX_HOST_PATH, "core-a/toolchain/node"]
		{
			let path = release.join(relative);

			#[cfg(unix)]
			fs::set_permissions(path, fs::Permissions::from_mode(0o755))
				.expect("fixture executable mode");
		}
	}

	fn git<const N: usize>(repository: &Path, arguments: [&str; N]) {
		let status = Command::new(release::GIT_EXECUTABLE)
			.args(["-C"])
			.arg(repository)
			.args(arguments)
			.status()
			.expect("fixture Git command");

		assert!(status.success());
	}
}
