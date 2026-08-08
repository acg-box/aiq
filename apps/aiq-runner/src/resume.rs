//! Durable preflight reuse and per-attempt run checkpoints.

#[cfg(not(windows))]
use std::fs::OpenOptions;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt as _;
use std::{
	collections::BTreeSet,
	ffi::{OsStr, OsString},
	fmt::{Display, Formatter},
	fs::{self, File},
	io::{self, ErrorKind, Write as _},
	path::{Path, PathBuf},
	process,
	time::{SystemTime, UNIX_EPOCH},
};
#[cfg(windows)]
use std::{
	iter, mem,
	os::windows::{
		ffi::{OsStrExt as _, OsStringExt as _},
		io::{AsRawHandle as _, FromRawHandle as _},
	},
	ptr, slice,
};

use serde::{Deserialize, Serialize, de::DeserializeOwned};
#[cfg(windows)]
use windows_sys::Win32::{
	Foundation::{ERROR_SUCCESS, GENERIC_WRITE, INVALID_HANDLE_VALUE, LocalFree},
	Security::{
		ACE_HEADER, ACL, ACL_SIZE_INFORMATION, AclSizeInformation,
		Authorization::{
			ConvertStringSecurityDescriptorToSecurityDescriptorW, GetSecurityInfo, SDDL_REVISION_1,
			SE_FILE_OBJECT,
		},
		DACL_SECURITY_INFORMATION, GetAce, GetAclInformation, GetSecurityDescriptorControl,
		GetSecurityDescriptorDacl, PSECURITY_DESCRIPTOR, SE_DACL_PRESENT, SE_DACL_PROTECTED,
		SECURITY_ATTRIBUTES,
	},
	Storage::FileSystem::{
		CREATE_NEW, CreateFileW, FILE_ATTRIBUTE_NORMAL, MOVEFILE_REPLACE_EXISTING,
		MOVEFILE_WRITE_THROUGH, MoveFileExW, READ_CONTROL,
	},
};

use crate::{
	adapter::{
		self, ArtifactReference, CapabilityValidationReport, CapabilityValidationStatus,
		ConfigurationProbeStatus, PREFLIGHT_MARKER_ARTIFACT_KIND, PREFLIGHT_MARKER_BYTES,
		PREFLIGHT_MARKER_SHA256, ProbeStatus,
	},
	capacity::CapacityCommitment,
	corpus_commitment::{RunClass, RunProvenanceCommitment},
	model::{CapabilityManifest, MODEL_MATRIX, ModelConfig},
	protocol,
	runner::{
		self, RESULT_SCHEMA_VERSION, RUN_SCHEMA_VERSION, ResultStatus, TaskResult,
		TerminalAttemptLineage,
	},
	schedule::ScheduleSlot,
	scoring::{AIQ_CORE_TASK_IDENTITY_SHA256, AIQ_SCORING_VERSION, FrozenCalibrationBankV2},
	task::{EvaluationResult, TASK_SCHEMA_VERSION},
};

/// Checkpoint schema version.
pub const CHECKPOINT_SCHEMA_VERSION: &str = "aiq.run-checkpoint.v8";
/// Persisted preflight schema version.
pub const PREFLIGHT_CACHE_SCHEMA_VERSION: &str = "aiq.preflight-cache.v2";
/// Persisted completed preflight-attempt diagnostic schema version.
pub const PREFLIGHT_ATTEMPT_SCHEMA_VERSION: &str = "aiq.preflight-attempt.v1";

/// Immutable commitments that make a checkpoint safe to resume.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RunCommitments {
	/// Stable run identifier.
	pub run_id: String,
	/// Selected schedule slot.
	pub schedule_slot: ScheduleSlot,
	/// Full catalog identity. Calibration selection does not change this commitment.
	pub catalog_digest: String,
	/// Content address of the selected tasks.
	pub task_set_hash: String,
	/// Scoring implementation version.
	pub scoring_version: String,
	/// Exact permission-admission commitment for Official execution.
	pub calibration_admission_digest: Option<String>,
	/// Frozen item bank embedded for scoring and verifier replay.
	pub calibration_bank: Option<FrozenCalibrationBankV2>,
	/// Digest of ordered task evaluator commitments.
	pub evaluator_digest: String,
	/// Digest of runner and result protocol commitments.
	pub runtime_digest: String,
	/// Exact committed model-visible toolchain policy digest.
	pub model_toolchain_digest: String,
	/// Direct capacity estimate derived from active support and operator concurrency.
	pub capacity: CapacityCommitment,
	/// Ordered selected model matrix.
	pub models: Vec<ModelConfig>,
	/// Explicit class selected before execution.
	pub run_class: RunClass,
	/// Permission policy, profile, requirements, and canary evidence.
	pub permission_evidence_digest: String,
	/// Canonical baseline workspace root.
	pub workspace_root: String,
	/// Canonical execution workspace root.
	pub execution_root: String,
	/// Canonical artifact root.
	pub artifact_root: String,
	/// Canonical controlled Codex home.
	pub codex_home: String,
	/// Exact Codex executable selector.
	pub codex_binary: String,
	/// Exact provenance observation value used by every resumed result.
	pub observed_at: String,
	/// Digest of the exact capability validation report.
	pub preflight_digest: String,
	/// Public-safe identities that the signed run must retain.
	pub provenance: RunProvenanceCommitment,
}

/// Atomic checkpoint written after every terminal attempt.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RunCheckpoint {
	/// Checkpoint schema version.
	pub schema_version: String,
	/// Immutable resume commitments.
	pub commitments: RunCommitments,
	/// Run start time retained across restarts.
	pub started_unix_ms: u64,
	/// Live cells durably marked before model execution and not yet committed.
	pub in_flight: Vec<InFlightCell>,
	/// Completed terminal results in deterministic execution order.
	pub results: Vec<TaskResult>,
	/// Append-visible terminal observations bound to selected results.
	pub terminal_attempt_lineage: Vec<TerminalAttemptLineage>,
	/// Full evaluator results aligned with `results`.
	///
	/// Signed run results retain only the canonical digest. Checkpoints retain
	/// this evidence so resumed runs can build the final evaluator-results bundle.
	pub evaluator_results: Vec<Option<EvaluationResult>>,
}
impl RunCheckpoint {
	/// Creates an empty checkpoint for a new run.
	#[must_use]
	pub fn new(commitments: RunCommitments, started_unix_ms: u64) -> Self {
		Self {
			schema_version: CHECKPOINT_SCHEMA_VERSION.to_owned(),
			commitments,
			started_unix_ms,
			in_flight: Vec::new(),
			results: Vec::new(),
			terminal_attempt_lineage: Vec::new(),
			evaluator_results: Vec::new(),
		}
	}

	/// Loads and validates an exact checkpoint. Mismatches are never ignored.
	pub fn load(path: &Path, expected: &RunCommitments) -> Result<Option<Self>, ResumeError> {
		let bytes = match fs::read(path) {
			Ok(bytes) => bytes,
			Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
			Err(error) => {
				return Err(ResumeError::new(format!("cannot read run checkpoint: {error}")));
			},
		};
		let checkpoint: Self = serde_json::from_slice(&bytes)
			.map_err(|error| ResumeError::new(format!("run checkpoint is corrupt: {error}")))?;

		if checkpoint.schema_version != CHECKPOINT_SCHEMA_VERSION {
			return Err(ResumeError::new("run checkpoint schema is not supported"));
		}
		if &checkpoint.commitments != expected {
			return Err(ResumeError::new(
				"run checkpoint commitments do not match this invocation",
			));
		}
		if checkpoint.results.len() != checkpoint.evaluator_results.len() {
			return Err(ResumeError::new(
				"run checkpoint evaluator evidence is not aligned with its results",
			));
		}

		runner::validate_terminal_attempt_lineage(
			&checkpoint.results,
			&checkpoint.terminal_attempt_lineage,
		)
		.map_err(|error| ResumeError::new(error.to_string()))?;

		let mut pairs = BTreeSet::new();
		let mut in_flight = BTreeSet::new();

		for cell in &checkpoint.in_flight {
			if !expected.models.contains(&cell.model)
				|| !in_flight.insert((
					cell.model,
					cell.task_id.as_str(),
					cell.task_version.as_str(),
				)) {
				return Err(ResumeError::new(
					"run checkpoint contains an invalid or duplicate in-flight cell",
				));
			}
		}
		for (result, evaluator_result) in
			checkpoint.results.iter().zip(&checkpoint.evaluator_results)
		{
			if result.run_id != expected.run_id
				|| !expected.models.contains(&result.model)
				|| !pairs.insert((result.model, result.task_id.clone()))
			{
				return Err(ResumeError::new(
					"run checkpoint contains an invalid or duplicate terminal result",
				));
			}
			if in_flight.contains(&(
				result.model,
				result.task_id.as_str(),
				result.task_version.as_str(),
			)) {
				return Err(ResumeError::new(
					"run checkpoint cell is both committed and in flight",
				));
			}

			let digest = evaluator_result
				.as_ref()
				.map(protocol::canonical_hash)
				.transpose()
				.map_err(|error| ResumeError::new(error.to_string()))?;

			if digest != result.evaluator_result_sha256
				|| evaluator_result.is_some() != (result.status == ResultStatus::Completed)
			{
				return Err(ResumeError::new(
					"run checkpoint evaluator evidence does not match its result",
				));
			}
		}

		Ok(Some(checkpoint))
	}

	/// Atomically replaces the durable checkpoint.
	pub fn persist(&self, path: &Path) -> Result<(), ResumeError> {
		atomic_write_json(path, self)
	}
}

/// One live cell whose model execution can have started but has no committed result.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct InFlightCell {
	/// Stable task identifier.
	pub task_id: String,
	/// Task version.
	pub task_version: String,
	/// Exact model configuration.
	pub model: ModelConfig,
}

/// Authenticated subscription preflight that can be reused before expiry.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PreflightCache {
	/// Cache schema version.
	pub schema_version: String,
	/// Expiration as Unix milliseconds.
	pub expires_unix_ms: u64,
	/// Digest of the exact capability manifest.
	pub manifest_digest: String,
	/// Exact committed model-visible toolchain policy digest.
	pub model_toolchain_digest: String,
	/// Exact Codex version committed by the manifest and active report.
	pub codex_version: String,
	/// Exact ordered model and reasoning matrix.
	pub models: Vec<ModelConfig>,
	/// Complete structured active report, including unsupported entries.
	pub report: CapabilityValidationReport,
	/// Exact successful Official admission receipt, when this cache was paid for an Official plan.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub official_admission_digest: Option<String>,
}
impl PreflightCache {
	/// Builds a reusable cache from one authenticated active report.
	pub fn new(
		manifest: &CapabilityManifest,
		report: CapabilityValidationReport,
		expires_unix_ms: u64,
		model_toolchain_digest: &str,
	) -> Result<Self, ResumeError> {
		validate_preflight_report(manifest, &report)?;

		if !valid_digest(model_toolchain_digest) {
			return Err(ResumeError::new("preflight model toolchain digest is invalid"));
		}

		Ok(Self {
			schema_version: PREFLIGHT_CACHE_SCHEMA_VERSION.to_owned(),
			expires_unix_ms,
			manifest_digest: protocol::canonical_hash(manifest)
				.map_err(|error| ResumeError::new(error.to_string()))?,
			model_toolchain_digest: model_toolchain_digest.to_owned(),
			codex_version: manifest.codex_version.trim().to_owned(),
			models: MODEL_MATRIX.to_vec(),
			report,
			official_admission_digest: None,
		})
	}

	/// Binds this paid cache to one exact successful Official admission receipt.
	pub fn bind_official_admission(mut self, digest: &str) -> Result<Self, ResumeError> {
		if !valid_digest(digest) {
			return Err(ResumeError::new("Official admission receipt digest is invalid"));
		}
		if self.official_admission_digest.as_deref().is_some_and(|existing| existing != digest) {
			return Err(ResumeError::new(
				"preflight cache is already bound to another Official admission receipt",
			));
		}

		self.official_admission_digest = Some(digest.to_owned());

		Ok(self)
	}

	/// Loads a cache only when every exact commitment and expiry check succeeds.
	pub fn load(
		path: &Path,
		manifest: &CapabilityManifest,
		now_unix_ms: u64,
		model_toolchain_digest: &str,
	) -> Result<Self, ResumeError> {
		let cache: Self = read_json(path, "preflight cache")?;
		let manifest_digest = protocol::canonical_hash(manifest)
			.map_err(|error| ResumeError::new(error.to_string()))?;

		if cache.schema_version != PREFLIGHT_CACHE_SCHEMA_VERSION
			|| cache.expires_unix_ms <= now_unix_ms
			|| cache.manifest_digest != manifest_digest
			|| cache.model_toolchain_digest != model_toolchain_digest
			|| cache.codex_version != manifest.codex_version.trim()
			|| cache.models != MODEL_MATRIX
		{
			return Err(ResumeError::new(
				"preflight cache is expired or its exact commitments do not match",
			));
		}

		validate_preflight_report(manifest, &cache.report)?;

		Ok(cache)
	}

	/// Atomically persists the reusable preflight report.
	pub fn persist(&self, path: &Path) -> Result<(), ResumeError> {
		atomic_write_json(path, self)
	}
}

/// Public-safe diagnostic for every completed active preflight attempt.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PreflightAttempt {
	/// Diagnostic schema version.
	pub schema_version: String,
	/// Whether this exact report can populate the strict cache.
	pub reusable: bool,
	/// Explicit reuse disposition.
	pub status: PreflightAttemptStatus,
	/// Local attempt observation time as Unix milliseconds.
	pub observed_unix_ms: u64,
	/// Cache expiry assigned only to a reusable report.
	pub expires_unix_ms: Option<u64>,
	/// Digest of the exact capability manifest.
	pub manifest_digest: String,
	/// Exact committed model-visible toolchain policy digest.
	pub model_toolchain_digest: String,
	/// Codex version required by the exact manifest.
	pub expected_codex_version: String,
	/// Codex version observed by the completed attempt, when present.
	pub observed_codex_version: Option<String>,
	/// Exact ordered model and reasoning matrix.
	pub models: Vec<ModelConfig>,
	/// Digest of the complete normalized report.
	pub report_digest: String,
	/// Complete normalized structured report.
	pub report: CapabilityValidationReport,
}
impl PreflightAttempt {
	/// Builds a diagnostic without weakening the reusable-cache contract.
	pub fn new(
		manifest: &CapabilityManifest,
		report: CapabilityValidationReport,
		observed_unix_ms: u64,
		expires_unix_ms: u64,
		model_toolchain_digest: &str,
	) -> Result<Self, ResumeError> {
		validate_preflight_attempt_report(manifest, &report)?;

		if !valid_digest(model_toolchain_digest) {
			return Err(ResumeError::new("preflight model toolchain digest is invalid"));
		}

		let reusable = validate_preflight_report(manifest, &report).is_ok();
		let report_digest = protocol::canonical_hash(&report)
			.map_err(|error| ResumeError::new(error.to_string()))?;

		Ok(Self {
			schema_version: PREFLIGHT_ATTEMPT_SCHEMA_VERSION.to_owned(),
			reusable,
			status: if reusable {
				PreflightAttemptStatus::Reusable
			} else {
				PreflightAttemptStatus::Unavailable
			},
			observed_unix_ms,
			expires_unix_ms: reusable.then_some(expires_unix_ms),
			manifest_digest: protocol::canonical_hash(manifest)
				.map_err(|error| ResumeError::new(error.to_string()))?,
			model_toolchain_digest: model_toolchain_digest.to_owned(),
			expected_codex_version: manifest.codex_version.trim().to_owned(),
			observed_codex_version: report.cli_probe.version.clone(),
			models: MODEL_MATRIX.to_vec(),
			report_digest,
			report,
		})
	}

	/// Loads a diagnostic only when every exact binding and disposition is intact.
	pub fn load(
		path: &Path,
		manifest: &CapabilityManifest,
		model_toolchain_digest: &str,
	) -> Result<Self, ResumeError> {
		let attempt: Self = read_json(path, "preflight attempt diagnostic")?;
		let manifest_digest = protocol::canonical_hash(manifest)
			.map_err(|error| ResumeError::new(error.to_string()))?;

		if attempt.schema_version != PREFLIGHT_ATTEMPT_SCHEMA_VERSION
			|| attempt.observed_unix_ms == 0
			|| attempt.manifest_digest != manifest_digest
			|| attempt.model_toolchain_digest != model_toolchain_digest
			|| attempt.expected_codex_version != manifest.codex_version.trim()
			|| attempt.observed_codex_version != attempt.report.cli_probe.version
			|| attempt.models != MODEL_MATRIX
			|| attempt.report_digest
				!= protocol::canonical_hash(&attempt.report)
					.map_err(|error| ResumeError::new(error.to_string()))?
		{
			return Err(ResumeError::new("preflight attempt diagnostic commitments do not match"));
		}

		validate_preflight_attempt_report(manifest, &attempt.report)?;

		let reusable = validate_preflight_report(manifest, &attempt.report).is_ok();
		let expected_status = if reusable {
			PreflightAttemptStatus::Reusable
		} else {
			PreflightAttemptStatus::Unavailable
		};

		if attempt.reusable != reusable
			|| attempt.status != expected_status
			|| reusable != attempt.expires_unix_ms.is_some()
		{
			return Err(ResumeError::new(
				"preflight attempt diagnostic reuse disposition is invalid",
			));
		}

		Ok(attempt)
	}

	/// Atomically persists this public-safe attempt diagnostic.
	pub fn persist(&self, path: &Path) -> Result<(), ResumeError> {
		atomic_write_json(path, self)
	}
}

/// Durable resume or cache validation failure.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResumeError {
	message: String,
}
impl ResumeError {
	fn new(message: impl Into<String>) -> Self {
		Self { message: message.into() }
	}
}

impl std::error::Error for ResumeError {}

impl Display for ResumeError {
	fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
		formatter.write_str(&self.message)
	}
}

#[cfg(windows)]
struct LocalSecurityDescriptor(PSECURITY_DESCRIPTOR);
#[cfg(windows)]
impl Drop for LocalSecurityDescriptor {
	fn drop(&mut self) {
		// SAFETY: The descriptor was allocated by a LocalAlloc-backed Windows API and is owned
		// here.
		let _ = unsafe { LocalFree(self.0) };
	}
}

/// Reuse disposition for one completed preflight probe attempt.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PreflightAttemptStatus {
	/// The report can populate the strict reusable cache.
	Reusable,
	/// The report is diagnostic evidence only and must fail closed.
	Unavailable,
}

/// Returns the deterministic diagnostic sidecar for one cache/output path.
#[must_use]
pub fn preflight_attempt_path(path: &Path) -> PathBuf {
	let mut name = path.as_os_str().to_os_string();

	name.push(".attempt.json");

	PathBuf::from(name)
}

/// Current Unix time in milliseconds.
#[must_use]
pub fn unix_ms() -> u64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map_or(0, |duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
}

/// Builds the stable runtime commitment for checkpoint validation.
pub fn runtime_digest(
	run_class: RunClass,
	permission_evidence_digest: &str,
	model_toolchain_digest: &str,
	capacity: &CapacityCommitment,
) -> Result<String, ResumeError> {
	if !valid_digest(model_toolchain_digest) || !valid_digest(permission_evidence_digest) {
		return Err(ResumeError::new("runtime digest input is invalid"));
	}

	protocol::canonical_hash(&(
		env!("CARGO_PKG_VERSION"),
		RUN_SCHEMA_VERSION,
		RESULT_SCHEMA_VERSION,
		TASK_SCHEMA_VERSION,
		AIQ_SCORING_VERSION,
		run_class,
		permission_evidence_digest,
		model_toolchain_digest,
		capacity,
	))
	.map_err(|error| ResumeError::new(error.to_string()))
}

/// Returns a class-domain-separated idempotent identity for a real benchmark run.
pub fn classified_run_id(
	slot: &ScheduleSlot,
	task_set_hash: &str,
	corpus_commitment_sha256: &str,
	models: &[ModelConfig],
	run_class: RunClass,
) -> Result<String, ResumeError> {
	classified_run_id_for_scoring_version(
		slot,
		task_set_hash,
		corpus_commitment_sha256,
		models,
		run_class,
		AIQ_SCORING_VERSION,
	)
}

/// Returns the fixed full-catalog commitment.
#[must_use]
pub fn catalog_digest() -> String {
	AIQ_CORE_TASK_IDENTITY_SHA256.to_owned()
}

/// Atomically writes JSON with file and parent-directory durability.
pub fn atomic_write_json(path: &Path, value: &impl Serialize) -> Result<(), ResumeError> {
	if path == Path::new("-") {
		return Err(ResumeError::new("durable state cannot use standard output"));
	}

	let parent =
		path.parent().filter(|parent| !parent.as_os_str().is_empty()).unwrap_or(Path::new("."));

	fs::create_dir_all(parent)
		.map_err(|error| ResumeError::new(format!("cannot create state directory: {error}")))?;

	let canonical_parent = fs::canonicalize(parent)
		.map_err(|error| ResumeError::new(format!("cannot resolve state directory: {error}")))?;
	let name = path.file_name().ok_or_else(|| ResumeError::new("state file name is missing"))?;
	let unique_suffix =
		SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |duration| duration.as_nanos());
	let temporary = temporary_state_path(&canonical_parent, name, unique_suffix);
	let mut file = open_private_state_file(&temporary)
		.map_err(|error| ResumeError::new(format!("cannot create temporary state: {error}")))?;
	let mut bytes =
		serde_json::to_vec_pretty(value).map_err(|error| ResumeError::new(error.to_string()))?;

	bytes.push(b'\n');

	if let Err(error) = file.write_all(&bytes).and_then(|()| file.sync_all()) {
		let _ = fs::remove_file(&temporary);

		return Err(ResumeError::new(format!("cannot persist temporary state: {error}")));
	}

	drop(file);

	let destination = canonical_parent.join(name);

	replace_durable_state(&temporary, &destination).map_err(|error| {
		let _ = fs::remove_file(&temporary);

		ResumeError::new(format!("cannot atomically replace durable state: {error}"))
	})?;

	#[cfg(unix)]
	File::open(&canonical_parent)
		.and_then(|directory| directory.sync_all())
		.map_err(|error| ResumeError::new(format!("cannot sync state directory: {error}")))?;

	Ok(())
}

/// Resolves a regular directory identity for checkpoint commitments.
pub fn directory_identity(path: &Path, label: &str) -> Result<String, ResumeError> {
	let metadata = fs::symlink_metadata(path)
		.map_err(|error| ResumeError::new(format!("{label} unavailable: {error}")))?;

	if metadata.file_type().is_symlink() || !metadata.is_dir() {
		return Err(ResumeError::new(format!("{label} must be a regular directory")));
	}

	fs::canonicalize(path)
		.map(|path: PathBuf| path.display().to_string())
		.map_err(|error| ResumeError::new(format!("{label} unavailable: {error}")))
}

pub(crate) fn classified_run_id_for_scoring_version(
	slot: &ScheduleSlot,
	task_set_hash: &str,
	corpus_commitment_sha256: &str,
	models: &[ModelConfig],
	run_class: RunClass,
	scoring_version: &str,
) -> Result<String, ResumeError> {
	if !valid_digest(corpus_commitment_sha256) {
		return Err(ResumeError::new("run identity corpus commitment digest is invalid"));
	}

	#[derive(Serialize)]
	struct ClassifiedRunIdentity<'a> {
		schema_version: &'static str,
		run_class: RunClass,
		slot: &'a ScheduleSlot,
		task_set_hash: &'a str,
		corpus_commitment_sha256: &'a str,
		models: &'a [ModelConfig],
		scoring_version: &'a str,
	}

	let digest = protocol::canonical_hash(&ClassifiedRunIdentity {
		schema_version: "aiq.run-identity.v3",
		run_class,
		slot,
		task_set_hash,
		corpus_commitment_sha256,
		models,
		scoring_version,
	})
	.map_err(|error| ResumeError::new(error.to_string()))?;

	Ok(format!("run_{}", digest.trim_start_matches("sha256:")))
}

fn valid_digest(value: &str) -> bool {
	value.strip_prefix("sha256:").is_some_and(|digest| {
		digest.len() == 64
			&& digest.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
			&& !digest.bytes().all(|byte| byte == b'0')
	})
}

fn temporary_state_path(parent: &Path, name: &OsStr, unique_suffix: u128) -> PathBuf {
	let mut temporary_name = OsString::from(".");

	temporary_name.push(name);
	temporary_name.push(format!(".tmp-{}-{unique_suffix}", process::id()));

	parent.join(temporary_name)
}

#[cfg(not(windows))]
fn open_private_state_file(path: &Path) -> io::Result<File> {
	let mut options = OpenOptions::new();

	options.write(true).create_new(true);
	#[cfg(unix)]
	options.mode(0o600);

	options.open(path)
}

#[cfg(windows)]
fn private_windows_security_descriptor() -> io::Result<LocalSecurityDescriptor> {
	let sddl = "D:P(A;;FA;;;OW)(A;;FA;;;SY)(A;;FA;;;BA)\0".encode_utf16().collect::<Vec<_>>();
	let mut descriptor: PSECURITY_DESCRIPTOR = ptr::null_mut();
	// SAFETY: `sddl` is NUL-terminated, and `descriptor` is a valid output pointer.
	let converted = unsafe {
		ConvertStringSecurityDescriptorToSecurityDescriptorW(
			sddl.as_ptr(),
			SDDL_REVISION_1,
			&mut descriptor,
			ptr::null_mut(),
		)
	};

	if converted == 0 {
		Err(io::Error::last_os_error())
	} else {
		Ok(LocalSecurityDescriptor(descriptor))
	}
}

#[cfg(windows)]
fn open_private_state_file(path: &Path) -> io::Result<File> {
	let descriptor = private_windows_security_descriptor()?;
	let attributes = SECURITY_ATTRIBUTES {
		nLength: u32::try_from(mem::size_of::<SECURITY_ATTRIBUTES>())
			.map_err(|_| io::Error::other("Windows security attributes are too large"))?,
		lpSecurityDescriptor: descriptor.0,
		bInheritHandle: 0,
	};
	let path = path.as_os_str().encode_wide().chain(iter::once(0)).collect::<Vec<_>>();
	// SAFETY: The path is NUL-terminated, the security attributes and descriptor outlive this call,
	// and CREATE_NEW prevents replacement of an existing temporary file.
	let handle = unsafe {
		CreateFileW(
			path.as_ptr(),
			GENERIC_WRITE | READ_CONTROL,
			0,
			&attributes,
			CREATE_NEW,
			FILE_ATTRIBUTE_NORMAL,
			ptr::null_mut(),
		)
	};

	if handle == INVALID_HANDLE_VALUE {
		return Err(io::Error::last_os_error());
	}

	// SAFETY: `handle` is a newly owned, valid file handle and is transferred to `File` once.
	let file = unsafe { File::from_raw_handle(handle) };

	if let Err(error) = verify_windows_private_dacl(&file, descriptor.0) {
		drop(file);

		if let Err(cleanup_error) = fs::remove_file(path_from_wide(&path)) {
			return Err(io::Error::new(
				error.kind(),
				format!("{error}; cannot remove insecure temporary state: {cleanup_error}"),
			));
		}

		return Err(error);
	}

	Ok(file)
}

#[cfg(windows)]
fn path_from_wide(path: &[u16]) -> PathBuf {
	let path = path.strip_suffix(&[0]).unwrap_or(path);

	PathBuf::from(OsString::from_wide(path))
}

#[cfg(windows)]
fn verify_windows_private_dacl(
	file: &File,
	expected_descriptor: PSECURITY_DESCRIPTOR,
) -> io::Result<()> {
	let mut actual_descriptor: PSECURITY_DESCRIPTOR = ptr::null_mut();
	let mut actual_dacl: *mut ACL = ptr::null_mut();
	// SAFETY: The file handle is valid, and all optional output pointers are either null or valid.
	let status = unsafe {
		GetSecurityInfo(
			file.as_raw_handle(),
			SE_FILE_OBJECT,
			DACL_SECURITY_INFORMATION,
			ptr::null_mut(),
			ptr::null_mut(),
			&mut actual_dacl,
			ptr::null_mut(),
			&mut actual_descriptor,
		)
	};

	if status != ERROR_SUCCESS {
		return Err(io::Error::from_raw_os_error(status.cast_signed()));
	}

	let actual_descriptor = LocalSecurityDescriptor(actual_descriptor);
	let mut control = 0_u16;
	let mut revision = 0_u32;
	// SAFETY: `actual_descriptor` is the valid descriptor returned by GetSecurityInfo.
	let control_read =
		unsafe { GetSecurityDescriptorControl(actual_descriptor.0, &mut control, &mut revision) };

	if control_read == 0 {
		return Err(io::Error::last_os_error());
	}
	if control & (SE_DACL_PRESENT | SE_DACL_PROTECTED) != SE_DACL_PRESENT | SE_DACL_PROTECTED
		|| actual_dacl.is_null()
	{
		return Err(io::Error::new(
			ErrorKind::PermissionDenied,
			"temporary state DACL is absent, null, or inherited",
		));
	}

	let mut expected_present = 0;
	let mut expected_defaulted = 0;
	let mut expected_dacl: *mut ACL = ptr::null_mut();

	// SAFETY: `expected_descriptor` is the valid descriptor retained by the caller.
	if unsafe {
		GetSecurityDescriptorDacl(
			expected_descriptor,
			&mut expected_present,
			&mut expected_dacl,
			&mut expected_defaulted,
		)
	} == 0
	{
		return Err(io::Error::last_os_error());
	}
	if expected_present == 0 || expected_dacl.is_null() {
		return Err(io::Error::new(
			ErrorKind::PermissionDenied,
			"private Windows DACL construction failed",
		));
	}

	let expected_entries = windows_acl_entries(expected_dacl)?;
	let actual_entries = windows_acl_entries(actual_dacl)?;

	if expected_entries.len() != 3 || actual_entries != expected_entries {
		return Err(io::Error::new(
			ErrorKind::PermissionDenied,
			"temporary state DACL does not grant only owner, system, and administrators",
		));
	}

	Ok(())
}

#[cfg(windows)]
fn windows_acl_entries(acl: *const ACL) -> io::Result<Vec<Vec<u8>>> {
	let information_size = u32::try_from(mem::size_of::<ACL_SIZE_INFORMATION>())
		.map_err(|_| io::Error::other("Windows ACL size information is too large"))?;
	let mut information = ACL_SIZE_INFORMATION::default();

	// SAFETY: `acl` is from a validated Windows security descriptor, and the output is sized.
	if unsafe {
		GetAclInformation(
			acl,
			std::ptr::addr_of_mut!(information).cast(),
			information_size,
			AclSizeInformation,
		)
	} == 0
	{
		return Err(io::Error::last_os_error());
	}

	let mut entries = Vec::with_capacity(
		usize::try_from(information.AceCount)
			.map_err(|_| io::Error::other("Windows ACL contains too many entries"))?,
	);

	for index in 0..information.AceCount {
		let mut ace = ptr::null_mut();

		// SAFETY: The index is below the ACE count returned for this ACL.
		if unsafe { GetAce(acl, index, &mut ace) } == 0 {
			return Err(io::Error::last_os_error());
		}

		// SAFETY: GetAce returned a valid pointer to at least one ACE header.
		let ace_size = usize::from(unsafe { &*ace.cast::<ACE_HEADER>() }.AceSize);

		if ace_size < mem::size_of::<ACE_HEADER>() {
			return Err(io::Error::new(ErrorKind::InvalidData, "Windows ACL has a short ACE"));
		}

		// SAFETY: The ACE size is supplied by the validated ACL and starts at `ace`.
		entries.push(unsafe { slice::from_raw_parts(ace.cast::<u8>(), ace_size) }.to_vec());
	}

	entries.sort();

	Ok(entries)
}

#[cfg(windows)]
fn replace_durable_state(temporary: &Path, destination: &Path) -> std::io::Result<()> {
	let temporary = temporary.as_os_str().encode_wide().chain(iter::once(0)).collect::<Vec<_>>();
	let destination =
		destination.as_os_str().encode_wide().chain(iter::once(0)).collect::<Vec<_>>();
	let moved = unsafe {
		MoveFileExW(
			temporary.as_ptr(),
			destination.as_ptr(),
			MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
		)
	};

	if moved == 0 { Err(std::io::Error::last_os_error()) } else { Ok(()) }
}

#[cfg(not(windows))]
fn replace_durable_state(temporary: &Path, destination: &Path) -> std::io::Result<()> {
	fs::rename(temporary, destination)
}

fn validate_preflight_report(
	manifest: &CapabilityManifest,
	report: &CapabilityValidationReport,
) -> Result<(), ResumeError> {
	validate_preflight_attempt_report(manifest, report)?;

	if !report.is_usable()
		|| report.node_id != manifest.node_id
		|| report.cli_probe.status != ProbeStatus::Available
		|| report.cli_probe.version.as_deref().map(str::trim) != Some(manifest.codex_version.trim())
		|| report.models.iter().map(|entry| entry.model).collect::<Vec<_>>() != MODEL_MATRIX
	{
		return Err(ResumeError::new(
			"preflight report is not authenticated, usable, and bound to the exact manifest",
		));
	}

	Ok(())
}

fn validate_preflight_attempt_report(
	manifest: &CapabilityManifest,
	report: &CapabilityValidationReport,
) -> Result<(), ResumeError> {
	if report.schema_version != "aiq.capability-validation.v3"
		|| report.node_id != manifest.node_id
		|| report.manifest_issues != adapter::validate_capability_manifest(manifest)
		|| report.models.iter().map(|entry| entry.model).collect::<Vec<_>>() != MODEL_MATRIX
		|| report
			.cli_probe
			.failure
			.as_ref()
			.is_some_and(|failure| !failure.is_normalized_preflight())
		|| report
			.authentication_probe
			.failure
			.as_ref()
			.is_some_and(|failure| !failure.is_normalized_preflight())
		|| report.models.iter().any(|entry| {
			entry.probe.failure.as_ref().is_some_and(|failure| !failure.is_normalized_preflight())
		}) {
		return Err(ResumeError::new(
			"preflight attempt report is not bound to the exact manifest and model matrix",
		));
	}
	if !matches!(
		(&report.cli_probe.status, &report.cli_probe.version, &report.cli_probe.failure),
		(ProbeStatus::Available, Some(_), None) | (ProbeStatus::Unavailable, None, Some(_))
	) || !matches!(
		(
			&report.authentication_probe.status,
			&report.authentication_probe.mode,
			&report.authentication_probe.failure,
		),
		(ProbeStatus::Available, Some(_), None) | (ProbeStatus::Unavailable, None, Some(_))
	) {
		return Err(ResumeError::new(
			"preflight attempt report contains inconsistent CLI or authentication evidence",
		));
	}

	for entry in &report.models {
		let recomputed = adapter::configuration_evidence_digest(
			entry.model,
			entry.probe.codex_version.as_ref(),
			&entry.probe.observed_at,
			entry.probe.status,
			entry.probe.result_digest.as_deref(),
			entry.probe.result_preview.as_deref(),
			&entry.probe.artifacts,
			entry.probe.failure.as_ref(),
		)
		.map_err(|error| ResumeError::new(error.to_string()))?;
		let shape_is_valid = match entry.probe.status {
			ConfigurationProbeStatus::Available => {
				entry.status == CapabilityValidationStatus::Available
					&& entry.probe.result_digest.is_some()
					&& entry.probe.result_preview.is_some()
					&& entry.probe.failure.is_none()
					&& entry
						.probe
						.artifacts
						.iter()
						.filter(|artifact| artifact.kind == PREFLIGHT_MARKER_ARTIFACT_KIND)
						.count() == 1 && entry.probe.artifacts.iter().any(valid_preflight_marker_reference)
			},
			ConfigurationProbeStatus::ObservedUnsupported => {
				entry.status == CapabilityValidationStatus::Unsupported
					&& entry.probe.result_digest.is_none()
					&& entry.probe.result_preview.is_none()
					&& entry.probe.failure.is_some()
					&& !entry
						.probe
						.artifacts
						.iter()
						.any(|artifact| artifact.kind == PREFLIGHT_MARKER_ARTIFACT_KIND)
			},
			ConfigurationProbeStatus::Failed => {
				entry.status == CapabilityValidationStatus::Unavailable
					&& entry.probe.result_digest.is_none()
					&& entry.probe.result_preview.is_none()
					&& entry.probe.failure.is_some()
					&& !entry
						.probe
						.artifacts
						.iter()
						.any(|artifact| artifact.kind == PREFLIGHT_MARKER_ARTIFACT_KIND)
			},
		};

		if !shape_is_valid
			|| entry.probe.observed_at.is_empty()
			|| entry.probe.evidence_digest != recomputed
			|| entry.probe.codex_version != report.cli_probe.version
		{
			return Err(ResumeError::new(
				"preflight attempt report contains inconsistent configuration evidence",
			));
		}
	}

	Ok(())
}

fn valid_preflight_marker_reference(artifact: &ArtifactReference) -> bool {
	artifact.kind == PREFLIGHT_MARKER_ARTIFACT_KIND
		&& artifact.content_hash == PREFLIGHT_MARKER_SHA256
		&& artifact.uri
			== format!(
				"aiq-artifact://sha256/{}/{}",
				PREFLIGHT_MARKER_SHA256.trim_start_matches("sha256:"),
				PREFLIGHT_MARKER_ARTIFACT_KIND
			) && artifact.bytes == PREFLIGHT_MARKER_BYTES.len() as u64
}

fn read_json<T>(path: &Path, label: &str) -> Result<T, ResumeError>
where
	T: DeserializeOwned,
{
	let bytes = fs::read(path)
		.map_err(|error| ResumeError::new(format!("cannot read {label}: {error}")))?;

	serde_json::from_slice(&bytes)
		.map_err(|error| ResumeError::new(format!("{label} is corrupt: {error}")))
}

#[cfg(test)]
mod tests {
	#[cfg(unix)]
	use std::os::unix::ffi::{OsStrExt as _, OsStringExt as _};
	#[cfg(windows)]
	use std::os::windows::ffi::{OsStrExt as _, OsStringExt as _};
	use std::{env, fs, process};

	use sha2::{Digest, Sha256};

	use crate::{
		adapter::{
			self, AdapterFailure, AdapterFailureKind, AuthenticationProbe, CapabilityValidation,
			CapabilityValidationReport, CapabilityValidationStatus, CliProbe, ConfigurationProbe,
			ConfigurationProbeStatus, ProbeStatus,
		},
		capacity::CapacityCommitment,
		corpus_commitment::{self, RunClass},
		model::{CapabilityManifest, CapabilityStatus, MODEL_MATRIX, ModelCapability},
		resume::{
			PreflightAttempt, PreflightAttemptStatus, PreflightCache, RunCheckpoint, RunCommitments,
		},
		runner,
		schedule::{ScheduleConfig, ScheduleOccurrence},
		scoring::AIQ_SCORING_VERSION,
		task,
	};

	fn temporary_root(label: &str) -> std::path::PathBuf {
		env::temp_dir().join(format!("aiq-resume-{label}-{}", process::id()))
	}

	fn manifest() -> CapabilityManifest {
		CapabilityManifest {
			schema_version: "aiq.capabilities.v1".to_owned(),
			node_id: format!("node_{}", "a".repeat(64)),
			observed_at: "2026-07-24T12:00:00Z".to_owned(),
			codex_version: "codex fixture".to_owned(),
			models: MODEL_MATRIX
				.into_iter()
				.map(|model| ModelCapability {
					model,
					status: CapabilityStatus::Available,
					reason: None,
				})
				.collect(),
		}
	}

	fn capacity_commitment() -> CapacityCommitment {
		CapacityCommitment {
			capability_validation_digest: format!("sha256:{}", "c".repeat(64)),
			runnable_cell_count: 1,
			admission_digest: format!("sha256:{}", "f".repeat(64)),
			configured_jobs: 1,
			effective_jobs: 1,
			seconds_until_next_slot: 43_200,
			conservative_bound_seconds: Some(3_600),
		}
	}

	fn report() -> CapabilityValidationReport {
		let manifest = manifest();
		let version = manifest.codex_version.clone();
		let models = MODEL_MATRIX
			.into_iter()
			.map(|model| {
				let preview = "AIQ_PREFLIGHT_OK".to_owned();
				let artifacts = vec![adapter::preflight_marker_artifact_reference()];
				let result_digest =
					format!("sha256:{}", hex::encode(Sha256::digest(preview.as_bytes())));
				let observed_at = "unix-ms:1".to_owned();
				let evidence_digest = adapter::configuration_evidence_digest(
					model,
					Some(&version),
					&observed_at,
					ConfigurationProbeStatus::Available,
					Some(&result_digest),
					Some(&preview),
					&artifacts,
					None,
				)
				.expect("evidence digest");

				CapabilityValidation {
					model,
					status: CapabilityValidationStatus::Available,
					reason: "active probe succeeded".to_owned(),
					probe: ConfigurationProbe {
						status: ConfigurationProbeStatus::Available,
						codex_version: Some(version.clone()),
						observed_at,
						result_digest: Some(result_digest),
						result_preview: Some(preview),
						artifacts,
						evidence_digest,
						failure: None,
					},
				}
			})
			.collect();

		CapabilityValidationReport {
			schema_version: "aiq.capability-validation.v3".to_owned(),
			node_id: manifest.node_id,
			manifest_issues: Vec::new(),
			cli_probe: CliProbe {
				status: ProbeStatus::Available,
				version: Some(version),
				failure: None,
			},
			authentication_probe: AuthenticationProbe {
				status: ProbeStatus::Available,
				mode: Some("chatgpt_subscription".to_owned()),
				failure: None,
			},
			models,
		}
	}

	fn unavailable_report(kind: AdapterFailureKind, message: &str) -> CapabilityValidationReport {
		let mut report = report();

		for entry in &mut report.models {
			let failure = AdapterFailure {
				kind,
				exit_code: Some(1),
				stderr: String::new(),
				message: message.to_owned(),
				stdout_truncated: false,
				stderr_truncated: false,
				artifacts: Vec::new(),
				stdout_full: String::new(),
			};

			entry.status = CapabilityValidationStatus::Unavailable;
			entry.reason =
				"active configuration probe failed without establishing support".to_owned();
			entry.probe.status = ConfigurationProbeStatus::Failed;
			entry.probe.result_digest = None;
			entry.probe.result_preview = None;

			entry.probe.artifacts.clear();

			entry.probe.failure = Some(failure);
			entry.probe.evidence_digest = adapter::configuration_evidence_digest(
				entry.model,
				entry.probe.codex_version.as_ref(),
				&entry.probe.observed_at,
				entry.probe.status,
				None,
				None,
				&entry.probe.artifacts,
				entry.probe.failure.as_ref(),
			)
			.expect("failed evidence digest");
		}

		report
	}

	fn commitments() -> RunCommitments {
		let tasks = runner::synthetic_tasks();
		let task_set_hash = task::task_set_hash(&tasks).expect("task set hash");
		let slot =
			ScheduleConfig::default().slot("2026-07-25", ScheduleOccurrence::Day).expect("slot");
		let evaluator_digest = format!("sha256:{}", "b".repeat(64));
		let permission_evidence_digest = format!("sha256:{}", "d".repeat(64));
		let model_toolchain_digest = format!("sha256:{}", "a".repeat(64));
		let capacity = capacity_commitment();
		let runtime_digest = super::runtime_digest(
			RunClass::Calibration,
			&permission_evidence_digest,
			&model_toolchain_digest,
			&capacity,
		)
		.expect("runtime digest");
		let preflight_digest = format!("sha256:{}", "c".repeat(64));
		let provenance = corpus_commitment::fixture_run_provenance_for_class(
			RunClass::Calibration,
			task_set_hash.clone(),
			evaluator_digest.clone(),
			runtime_digest.clone(),
			preflight_digest.clone(),
		);
		let run_id = super::classified_run_id(
			&slot,
			&task_set_hash,
			&provenance.corpus_commitment_sha256,
			&MODEL_MATRIX[..1],
			RunClass::Calibration,
		)
		.expect("run id");

		RunCommitments {
			run_id,
			schedule_slot: slot,
			catalog_digest: super::catalog_digest(),
			task_set_hash,
			scoring_version: AIQ_SCORING_VERSION.to_owned(),
			calibration_admission_digest: None,
			calibration_bank: None,
			evaluator_digest,
			runtime_digest,
			model_toolchain_digest,
			capacity,
			models: MODEL_MATRIX[..1].to_vec(),
			run_class: RunClass::Calibration,
			permission_evidence_digest,
			workspace_root: "/controlled/baseline".to_owned(),
			execution_root: "/controlled/execution".to_owned(),
			artifact_root: "/controlled/artifacts".to_owned(),
			codex_home: "/controlled/codex-home".to_owned(),
			codex_binary: "codex".to_owned(),
			observed_at: "fixture".to_owned(),
			preflight_digest,
			provenance,
		}
	}

	fn with_changed_capacity_admission(commitments: &RunCommitments) -> RunCommitments {
		let mut value = commitments.clone();

		value.capacity.admission_digest = format!("sha256:{}", "2".repeat(64));

		value
	}

	fn with_changed_provenance_digest(
		commitments: &RunCommitments,
		runner: bool,
	) -> RunCommitments {
		let mut value = commitments.clone();

		if runner {
			value.provenance.runner_executable_digest = format!("sha256:{}", "a".repeat(64));
		} else {
			value.provenance.codex_executable_digest = format!("sha256:{}", "b".repeat(64));
		}

		value
	}

	#[test]
	fn checkpoint_restart_preserves_terminal_results_and_rejects_mismatch() {
		let root = temporary_root("checkpoint");
		let path = root.join("checkpoint.json");
		let commitments = commitments();
		let mut checkpoint = RunCheckpoint::new(commitments.clone(), 7);
		let mut result =
			runner::synthetic_demo(commitments.schedule_slot.clone(), &runner::TestArtifactSink)
				.expect("synthetic run")
				.results
				.remove(0);

		result.run_id.clone_from(&commitments.run_id);

		result.model = commitments.models[0];
		result.result_id = format!(
			"result_{}",
			result.content_hash().expect("result hash").trim_start_matches("sha256:")
		);

		checkpoint.evaluator_results.push(result.evaluator_result());
		checkpoint.results.push(result.clone());

		checkpoint.terminal_attempt_lineage = runner::terminal_attempt_lineage(&checkpoint.results);

		checkpoint.persist(&path).expect("checkpoint persist");

		let loaded = RunCheckpoint::load(&path, &commitments)
			.expect("checkpoint load")
			.expect("checkpoint exists");
		let mut persisted_result = result;

		persisted_result.evaluator_checks.clear();

		assert_eq!(loaded.results, vec![persisted_result]);
		assert!(loaded.evaluator_results[0].is_some());

		let mismatches = [
			{
				let mut value = commitments.clone();

				value.run_id.push_str("-other");

				value
			},
			{
				let mut value = commitments.clone();

				value.catalog_digest = format!("sha256:{}", "d".repeat(64));

				value
			},
			{
				let mut value = commitments.clone();

				value.task_set_hash = format!("sha256:{}", "e".repeat(64));

				value
			},
			{
				let mut value = commitments.clone();

				value.scoring_version = "other".to_owned();

				value
			},
			{
				let mut value = commitments.clone();

				value.evaluator_digest = format!("sha256:{}", "f".repeat(64));

				value
			},
			{
				let mut value = commitments.clone();

				value.runtime_digest = format!("sha256:{}", "1".repeat(64));

				value
			},
			with_changed_capacity_admission(&commitments),
			{
				let mut value = commitments.clone();

				value.models = MODEL_MATRIX[1..2].to_vec();

				value
			},
			{
				let mut value = commitments.clone();

				value.schedule_slot.local_date = "2026-07-26".to_owned();

				value
			},
			{
				let mut value = commitments.clone();

				value.workspace_root = "/other/baseline".to_owned();

				value
			},
			{
				let mut value = commitments.clone();

				value.artifact_root = "/other/artifacts".to_owned();

				value
			},
			with_changed_provenance_digest(&commitments, true),
			with_changed_provenance_digest(&commitments, false),
		];

		for mismatch in mismatches {
			assert!(RunCheckpoint::load(&path, &mismatch).is_err());
		}

		fs::remove_dir_all(root).expect("fixture cleanup");
	}

	#[test]
	fn retryable_evaluator_failure_remains_terminal_checkpoint_evidence() {
		let root = temporary_root("retryable-terminal");
		let path = root.join("checkpoint.json");
		let commitments = commitments();
		let mut checkpoint = RunCheckpoint::new(commitments.clone(), 7);
		let mut result =
			runner::synthetic_demo(commitments.schedule_slot.clone(), &runner::TestArtifactSink)
				.expect("synthetic run")
				.results
				.remove(0);

		result.run_id.clone_from(&commitments.run_id);

		result.model = commitments.models[0];
		result.status = runner::ResultStatus::Failed;
		result.evaluation = runner::EvaluationOutcome::NotEvaluated;
		result.task_score = None;

		result.evaluator_checks.clear();

		result.evaluator_result_sha256 = None;
		result.failure = Some(runner::ResultFailure {
			kind: runner::FailureKind::EvaluatorFailure,
			message: "controlled evaluator failed".to_owned(),
			exit_code: Some(1),
			retryable: true,
		});
		result.result_id = format!(
			"result_{}",
			result.content_hash().expect("result hash").trim_start_matches("sha256:")
		);

		checkpoint.evaluator_results.push(None);
		checkpoint.results.push(result.clone());

		checkpoint.terminal_attempt_lineage = runner::terminal_attempt_lineage(&checkpoint.results);

		checkpoint.persist(&path).expect("checkpoint persist");

		let loaded = RunCheckpoint::load(&path, &commitments)
			.expect("checkpoint load")
			.expect("checkpoint exists");

		assert_eq!(loaded.results, vec![result]);
		assert_eq!(loaded.evaluator_results, vec![None]);
		assert!(loaded.results[0].failure.as_ref().is_some_and(|failure| failure.retryable));

		fs::remove_dir_all(root).expect("fixture cleanup");
	}

	#[test]
	fn corrupt_checkpoint_is_rejected_and_atomic_replace_leaves_no_temporary_file() {
		let root = temporary_root("atomic");
		let path = root.join("checkpoint.json");
		let checkpoint = RunCheckpoint::new(commitments(), 1);

		checkpoint.persist(&path).expect("first persist");
		checkpoint.persist(&path).expect("atomic replacement");

		assert_eq!(
			fs::read_dir(&root)
				.expect("state directory")
				.filter_map(Result::ok)
				.map(|entry| entry.file_name())
				.collect::<Vec<_>>(),
			vec![std::ffi::OsString::from("checkpoint.json")]
		);

		fs::write(&path, b"{not-json").expect("corrupt fixture");

		assert!(RunCheckpoint::load(&path, &commitments()).is_err());

		fs::remove_dir_all(root).expect("fixture cleanup");
	}

	#[cfg(unix)]
	#[test]
	fn temporary_name_preserves_non_utf8_bytes() {
		let name = std::ffi::OsString::from_vec(b"checkpoint-\xff.json".to_vec());
		let temporary = super::temporary_state_path(std::path::Path::new("/state"), &name, 7);
		let bytes = temporary.file_name().expect("temporary file name").as_bytes();

		assert_eq!(&bytes[1..=name.as_bytes().len()], name.as_bytes());
	}

	#[cfg(windows)]
	#[test]
	fn temporary_name_preserves_non_unicode_wide_units() {
		let name_units = [b'n' as u16, 0xd800, b'x' as u16];
		let name = std::ffi::OsString::from_wide(&name_units);
		let temporary = super::temporary_state_path(std::path::Path::new(r"C:\state"), &name, 7);
		let temporary_units =
			temporary.file_name().expect("temporary file name").encode_wide().collect::<Vec<_>>();

		assert_eq!(&temporary_units[1..=name_units.len()], name_units);
	}

	#[test]
	fn preflight_cache_enforces_expiry_manifest_version_and_exact_matrix() {
		let root = temporary_root("preflight");
		let path = root.join("preflight.json");
		let manifest = manifest();
		let digest = format!("sha256:{}", "a".repeat(64));
		let cache = PreflightCache::new(&manifest, report(), 2_000, &digest).expect("valid cache");

		cache.persist(&path).expect("cache persist");

		assert!(PreflightCache::load(&path, &manifest, 1_999, &digest).is_ok());
		assert!(PreflightCache::load(&path, &manifest, 2_000, &digest).is_err());

		let mut changed = manifest.clone();

		changed.codex_version = "codex other".to_owned();

		assert!(PreflightCache::load(&path, &changed, 1_999, &digest).is_err());
		assert!(
			PreflightCache::load(&path, &manifest, 1_999, &format!("sha256:{}", "b".repeat(64)),)
				.is_err()
		);

		fs::remove_dir_all(root).expect("fixture cleanup");
	}

	#[test]
	fn paid_preflight_cache_preserves_the_exact_official_admission_binding() {
		let root = temporary_root("official-preflight");
		let path = root.join("preflight.json");
		let manifest = manifest();
		let toolchain_digest = format!("sha256:{}", "a".repeat(64));
		let admission_digest = format!("sha256:{}", "b".repeat(64));
		let cache = PreflightCache::new(&manifest, report(), 2_000, &toolchain_digest)
			.expect("valid cache")
			.bind_official_admission(&admission_digest)
			.expect("Official admission binding");

		cache.persist(&path).expect("cache persist");

		let loaded = PreflightCache::load(&path, &manifest, 1_999, &toolchain_digest)
			.expect("bound cache load");

		assert_eq!(loaded.official_admission_digest.as_deref(), Some(admission_digest.as_str()));
		assert!(cache.clone().bind_official_admission("not-a-digest").is_err());
		assert!(cache.bind_official_admission(&format!("sha256:{}", "c".repeat(64))).is_err());

		fs::remove_dir_all(root).expect("fixture cleanup");
	}

	#[test]
	fn preflight_and_runtime_require_canonical_sha256_content_addresses() {
		let manifest = manifest();
		let raw_digest = "a".repeat(64);
		let canonical_digest = format!("sha256:{raw_digest}");
		let permission_evidence_digest = format!("sha256:{}", "d".repeat(64));

		assert!(PreflightCache::new(&manifest, report(), 2_000, &raw_digest).is_err());

		let capacity = capacity_commitment();

		assert!(
			super::runtime_digest(
				RunClass::Calibration,
				&permission_evidence_digest,
				&raw_digest,
				&capacity,
			)
			.is_err()
		);
		assert!(
			super::runtime_digest(
				RunClass::Calibration,
				&permission_evidence_digest,
				&canonical_digest,
				&capacity,
			)
			.is_ok()
		);
	}

	#[test]
	fn unavailable_preflight_entries_are_rejected_instead_of_fabricated() {
		let manifest = manifest();
		let mut report = report();

		report.models[0].status = CapabilityValidationStatus::Unavailable;

		assert!(
			PreflightCache::new(&manifest, report, 2_000, &format!("sha256:{}", "a".repeat(64)),)
				.is_err()
		);
	}

	#[test]
	fn unavailable_attempt_is_exact_bound_nonreusable_and_does_not_replace_valid_cache() {
		let root = temporary_root("preflight-attempt");
		let cache_path = root.join("preflight.json");
		let attempt_path = super::preflight_attempt_path(&cache_path);
		let manifest = manifest();
		let digest = format!("sha256:{}", "a".repeat(64));
		let cache = PreflightCache::new(&manifest, report(), 2_000, &digest).expect("valid cache");

		cache.persist(&cache_path).expect("cache persist");

		let original_cache = fs::read(&cache_path).expect("cache bytes");
		let attempt = PreflightAttempt::new(
			&manifest,
			unavailable_report(
				AdapterFailureKind::UsageLimit,
				"Codex subscription usage limit or quota was reached",
			),
			1_500,
			3_000,
			&digest,
		)
		.expect("diagnostic attempt");

		assert!(!attempt.reusable);
		assert_eq!(attempt.status, PreflightAttemptStatus::Unavailable);
		assert_eq!(attempt.expires_unix_ms, None);

		attempt.persist(&attempt_path).expect("attempt persist");

		assert_eq!(fs::read(&cache_path).expect("preserved cache"), original_cache);
		assert!(PreflightAttempt::load(&attempt_path, &manifest, &digest).is_ok());
		#[cfg(unix)]
		assert_eq!(
			std::os::unix::fs::PermissionsExt::mode(
				&fs::metadata(&attempt_path).expect("attempt metadata").permissions()
			) & 0o777,
			0o600
		);
		assert!(fs::read_dir(&root).expect("attempt directory").all(|entry| {
			!entry.expect("directory entry").file_name().to_string_lossy().contains(".tmp-")
		}));

		fs::remove_dir_all(root).expect("fixture cleanup");
	}

	#[test]
	fn attempt_rejects_raw_provider_text_and_detects_report_tampering() {
		let root = temporary_root("preflight-attempt-tamper");
		let path = root.join("preflight.json.attempt.json");
		let manifest = manifest();
		let digest = format!("sha256:{}", "a".repeat(64));
		let mut unsafe_report =
			unavailable_report(AdapterFailureKind::NonZeroExit, "Codex CLI exited unsuccessfully");

		unsafe_report.models[0].probe.failure.as_mut().expect("failure").stderr =
			"secret provider path /private/operator".to_owned();

		assert!(PreflightAttempt::new(&manifest, unsafe_report, 1_500, 3_000, &digest).is_err());

		let attempt = PreflightAttempt::new(&manifest, report(), 1_500, 3_000, &digest)
			.expect("reusable attempt");

		attempt.persist(&path).expect("attempt persist");

		let mut value: serde_json::Value =
			serde_json::from_slice(&fs::read(&path).expect("attempt bytes")).expect("attempt JSON");

		value["report"]["models"][0]["reason"] = serde_json::json!("tampered");

		fs::write(&path, serde_json::to_vec_pretty(&value).expect("tampered JSON"))
			.expect("tampered write");

		assert!(PreflightAttempt::load(&path, &manifest, &digest).is_err());

		fs::remove_dir_all(root).expect("fixture cleanup");
	}

	#[test]
	fn observed_unsupported_entry_remains_structured_in_the_cache() {
		let manifest = manifest();
		let mut report = report();
		let model = report.models[0].model;
		let version = manifest.codex_version.clone();
		let observed_at = "unix-ms:2".to_owned();
		let failure = AdapterFailure {
			kind: AdapterFailureKind::Unsupported,
			exit_code: Some(1),
			stderr: String::new(),
			message: "Codex rejected the exact model configuration".to_owned(),
			stdout_truncated: false,
			stderr_truncated: false,
			artifacts: Vec::new(),
			stdout_full: String::new(),
		};
		let evidence_digest = adapter::configuration_evidence_digest(
			model,
			Some(&version),
			&observed_at,
			ConfigurationProbeStatus::ObservedUnsupported,
			None,
			None,
			&[],
			Some(&failure),
		)
		.expect("unsupported evidence digest");

		report.models[0] = CapabilityValidation {
			model,
			status: CapabilityValidationStatus::Unsupported,
			reason: "active probe observed unsupported".to_owned(),
			probe: ConfigurationProbe {
				status: ConfigurationProbeStatus::ObservedUnsupported,
				codex_version: Some(version),
				observed_at,
				result_digest: None,
				result_preview: None,
				artifacts: Vec::new(),
				evidence_digest,
				failure: Some(failure),
			},
		};

		let cache =
			PreflightCache::new(&manifest, report, 2_000, &format!("sha256:{}", "a".repeat(64)))
				.expect("structured unsupported");

		assert_eq!(cache.report.models[0].status, CapabilityValidationStatus::Unsupported);
		assert!(cache.report.models[0].probe.failure.is_some());
	}

	#[test]
	fn real_run_identity_is_stable_and_domain_separated_by_run_class() {
		let slot = ScheduleConfig::default()
			.slot("2024-02-29", ScheduleOccurrence::Day)
			.expect("fixture slot");
		let task_set_hash = format!("sha256:{}", "a".repeat(64));
		let corpus_commitment = format!("sha256:{}", "b".repeat(64));
		let changed_corpus_commitment = format!("sha256:{}", "c".repeat(64));
		let calibration = super::classified_run_id(
			&slot,
			&task_set_hash,
			&corpus_commitment,
			&MODEL_MATRIX,
			RunClass::Calibration,
		)
		.expect("calibration identity");
		let calibration_1_0_6 = super::classified_run_id_for_scoring_version(
			&slot,
			&task_set_hash,
			&corpus_commitment,
			&MODEL_MATRIX,
			RunClass::Calibration,
			"1.0.6",
		)
		.expect("1.0.6 calibration identity");
		let repeated = super::classified_run_id(
			&slot,
			&task_set_hash,
			&corpus_commitment,
			&MODEL_MATRIX,
			RunClass::Calibration,
		)
		.expect("repeated calibration identity");
		let changed_corpus = super::classified_run_id(
			&slot,
			&task_set_hash,
			&changed_corpus_commitment,
			&MODEL_MATRIX,
			RunClass::Calibration,
		)
		.expect("changed-corpus calibration identity");
		let official = super::classified_run_id(
			&slot,
			&task_set_hash,
			&corpus_commitment,
			&MODEL_MATRIX,
			RunClass::Official,
		)
		.expect("official identity");

		assert_eq!(calibration, repeated);
		assert_ne!(calibration, calibration_1_0_6);
		assert_ne!(calibration, changed_corpus);
		assert_ne!(calibration, official);
		assert!(
			[&calibration, &changed_corpus, &official]
				.into_iter()
				.all(|run_id| run_id.starts_with("run_") && run_id.len() == 68)
		);
	}
}
