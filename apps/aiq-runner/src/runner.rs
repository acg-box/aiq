//! Full-matrix run orchestration and result data transfer objects.

#[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
mod subscription_smoke_tests;

use std::sync::mpsc::Sender;
use std::sync::mpsc::SyncSender;
use std::{
	collections::{BTreeMap, BTreeSet},
	fmt::{Display, Formatter},
	fs::{self, DirEntry, OpenOptions},
	io::{ErrorKind, Read, Write},
	path::{Path, PathBuf},
	process,
	sync::{
		Arc,
		atomic::{AtomicBool, AtomicUsize, Ordering},
		mpsc,
	},
	thread,
	time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
#[cfg(unix)]
use std::{fs::Permissions, os::unix::fs::PermissionsExt};

#[cfg(unix)]
use libc::O_NOFOLLOW;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Map;
use serde_json::Value;
use sha2::{Digest, Sha256};
#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem;

#[cfg(test)]
use crate::adapter::ExecutorError;
use crate::{
	adapter::{
		AdapterFailure, AdapterFailureKind, ArtifactReference, ArtifactSink,
		CapabilityValidationReport, CapabilityValidationStatus, CodexAdapter, CodexItemAccounting,
		CodexItemPolicyError, CodexOutput, Executor, InvocationRequest, MAX_CAPTURE_BYTES,
		SandboxPolicy,
	},
	capacity,
	corpus_commitment::{RunClass, RunProvenanceCommitment},
	model::{CapabilityManifest, MODEL_MATRIX, ModelConfig},
	protocol::{self, ProtocolError, ResultProvenance, TrustTier},
	resume::{
		self, InFlightCell, PENDING_EVALUATION_SCHEMA_VERSION, PendingEvaluation, RunCheckpoint,
		RunCommitments, SUBSCRIPTION_BACKPRESSURE_SCHEMA_VERSION, SubscriptionBackpressure,
	},
	schedule::{self, ScheduleSlot},
	scoring::{self, AIQ_SCORING_VERSION, FrozenCalibrationBankV2},
	task::{
		self, Domain, EVALUATOR_RESULT_SCHEMA_VERSION, EvaluationError, EvaluationResult,
		Evaluator, EvaluatorCheck, EvaluatorContext, EvaluatorOutcome, EvaluatorRuntime,
		NormalizedToolEvidence, TASK_SCHEMA_VERSION, TaskBudgets, TaskDefinition, Visibility,
	},
};

type EvaluatorReadyCallback<'a> = dyn FnMut(&PendingEvaluation) -> Result<(), RunnerError> + 'a;

/// Result schema version.
pub const RESULT_SCHEMA_VERSION: &str = "aiq.result.v2";
/// Run schema version.
pub const RUN_SCHEMA_VERSION: &str = "aiq.run.v4";
/// Calibration run schema version.
pub const CALIBRATION_RUN_SCHEMA_VERSION: &str = "aiq.calibration-run.v4";
/// Evaluator-result bundle schema version.
pub const EVALUATOR_RESULTS_SCHEMA_VERSION: &str = "aiq.evaluator-results.v1";
/// Maximum canonical evaluator-result bundle size.
pub const MAX_EVALUATOR_RESULTS_BUNDLE_BYTES: usize = 4 * 1_024 * 1_024 - 240 * 1_024;
/// Maximum UTF-8 bytes retained inline for each final model response.
///
/// The bound keeps a complete 1,224-cell signed package below the 4 MiB
/// submission limit even when every byte needs six-byte JSON escaping and each
/// result contains the normal external artifact references.
pub const MAX_RESULT_PREVIEW_BYTES: usize = 64;
/// Maximum task-declared completed-command digest entries in one 72-by-17 run.
///
/// AIQ Core has seven tool-use tasks and 17 configurations. Undeclared command
/// identities remain represented by the exact command and total call counters,
/// while this bounded map retains only task-required digest multiplicities.
pub const MAX_COMPLETED_COMMAND_DIGEST_ENTRIES_PER_RUN: usize = 7 * 17;
/// Maximum canonical replay snapshot retained for one candidate workspace.
pub const MAX_WORKSPACE_SNAPSHOT_BYTES: usize = 4 * 1_024 * 1_024;
/// Maximum file or directory entries inspected in one candidate workspace.
pub const MAX_WORKSPACE_ENTRIES: usize = 4_096;
/// Maximum directory depth inspected in one candidate workspace.
pub const MAX_WORKSPACE_DEPTH: usize = 64;
/// Maximum raw file bytes accepted before hexadecimal replay encoding.
pub const MAX_WORKSPACE_RAW_BYTES: u64 = (MAX_WORKSPACE_SNAPSHOT_BYTES / 3) as u64;
/// Maximum aggregate UTF-8 bytes accepted across replay-relative paths.
pub const MAX_WORKSPACE_PATH_BYTES: usize = 256 * 1_024;
/// Maximum live task workers accepted by the runner.
pub const MAX_RUN_JOBS: usize = 32;
/// Stable temporary-failure exit used by the outer observation orchestrator.
pub const SUBSCRIPTION_BACKPRESSURE_EXIT_CODE: u8 = 75;

/// Maximum combined JSONL retained across retryable Codex attempts for one cell.
const MAX_RETRY_STDOUT_BYTES: usize = MAX_CAPTURE_BYTES;
const OFFICIAL_TASK_COUNT: usize = 72;

static SEALED_WORKSPACE_SEQUENCE: AtomicUsize = AtomicUsize::new(0);

/// Supplies a controlled local workspace for a task.
pub trait TaskWorkspaceProvider {
	/// Quarantines an interrupted, uncommitted workspace before a fresh attempt.
	fn quarantine_interrupted(
		&self,
		_run_id: &str,
		_model: ModelConfig,
		_task: &TaskDefinition,
	) -> Result<(), WorkspaceError> {
		Ok(())
	}

	/// Resolves one task workspace or returns a structured unavailable error.
	fn context(
		&self,
		run_id: &str,
		model: ModelConfig,
		task: &TaskDefinition,
	) -> Result<TaskExecutionContext, WorkspaceError>;
}

#[cfg(test)]
pub(crate) struct TestArtifactSink;
#[cfg(test)]
impl ArtifactSink for TestArtifactSink {
	fn put(&self, kind: &str, bytes: &[u8]) -> Result<ArtifactReference, ExecutorError> {
		let digest = hex::encode(Sha256::digest(bytes));

		Ok(ArtifactReference {
			kind: kind.to_owned(),
			content_hash: format!("sha256:{digest}"),
			uri: format!("aiq-artifact://sha256/{digest}/{kind}"),
			bytes: u64::try_from(bytes.len()).unwrap_or(u64::MAX),
		})
	}
}

/// Local filesystem and worker settings for one selected run.
pub(crate) struct LocalRunExecution<'a> {
	pub(crate) evaluator: Option<(&'a Path, &'a EvaluatorRuntime)>,
	pub(crate) checkpoint_path: &'a Path,
	pub(crate) jobs: usize,
}

/// Controlled workspace and sandbox policy for one task.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskExecutionContext {
	/// Canonical task workspace directory.
	pub workspace_dir: PathBuf,
	/// Sandbox derived from the task's allowed tools.
	pub sandbox: SandboxPolicy,
}

/// Structured controlled-workspace error.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceError {
	message: String,
}
impl WorkspaceError {
	fn new(message: impl Into<String>) -> Self {
		Self { message: message.into() }
	}
}

impl std::error::Error for WorkspaceError {}

impl Display for WorkspaceError {
	fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
		formatter.write_str(&self.message)
	}
}

/// Runner-local provider that copies immutable task baselines into isolated run workspaces.
pub struct LocalDirectoryWorkspaceProvider {
	baseline_root: PathBuf,
	execution_root: PathBuf,
	baseline_workspace_digests: BTreeMap<String, String>,
}
impl LocalDirectoryWorkspaceProvider {
	/// Creates a provider from separate roots and committed per-task baseline digests.
	pub fn new(
		baseline_root: impl AsRef<Path>,
		execution_root: impl AsRef<Path>,
		baseline_workspace_digests: BTreeMap<String, String>,
	) -> Result<Self, WorkspaceError> {
		let baseline_root = canonical_directory(baseline_root.as_ref(), "workspace baseline root")?;
		let execution_root = prepare_execution_root(execution_root.as_ref())?;

		if baseline_root == execution_root
			|| baseline_root.starts_with(&execution_root)
			|| execution_root.starts_with(&baseline_root)
		{
			return Err(WorkspaceError::new(
				"workspace baseline and execution roots must be separate directory trees",
			));
		}

		Ok(Self { baseline_root, execution_root, baseline_workspace_digests })
	}
}

impl TaskWorkspaceProvider for LocalDirectoryWorkspaceProvider {
	fn quarantine_interrupted(
		&self,
		run_id: &str,
		model: ModelConfig,
		task: &TaskDefinition,
	) -> Result<(), WorkspaceError> {
		let destination = self.execution_root.join(run_id).join(model.key()).join(&task.task_id);

		if fs::symlink_metadata(&destination).is_ok() {
			quarantine_interrupted_workspace(
				&self.execution_root,
				run_id,
				model,
				task,
				&destination,
			)?;
		}

		Ok(())
	}

	fn context(
		&self,
		run_id: &str,
		model: ModelConfig,
		task: &TaskDefinition,
	) -> Result<TaskExecutionContext, WorkspaceError> {
		for (field, value) in [
			("run identifier", run_id),
			("model key", &model.key()),
			("task identifier", &task.task_id),
		] {
			if !safe_path_component(value) {
				return Err(WorkspaceError::new(format!(
					"{field} contains unsafe path characters"
				)));
			}
		}

		let baseline = self.baseline_root.join(&task.task_id);
		let expected_workspace_digest = self
			.baseline_workspace_digests
			.get(&task.task_id)
			.ok_or_else(|| WorkspaceError::new("task baseline has no committed digest"))?;
		let baseline_metadata = fs::symlink_metadata(&baseline).map_err(|error| {
			WorkspaceError::new(format!("task baseline {} unavailable: {error}", task.task_id))
		})?;

		if baseline_metadata.file_type().is_symlink() || !baseline_metadata.is_dir() {
			return Err(WorkspaceError::new("task baseline must be a regular directory"));
		}

		let destination = self.execution_root.join(run_id).join(model.key()).join(&task.task_id);
		let destination_parent = destination.parent().ok_or_else(|| {
			WorkspaceError::new("task execution destination has no controlled parent")
		})?;

		if fs::symlink_metadata(&destination).is_ok() {
			return Err(WorkspaceError::new(
				"task execution destination already exists; implicit resume is not permitted",
			));
		}

		let run_directory = self.execution_root.join(run_id);

		ensure_execution_directory(&run_directory)?;
		ensure_execution_directory(destination_parent)?;

		let canonical_parent = fs::canonicalize(destination_parent).map_err(|error| {
			WorkspaceError::new(format!("task execution parent unavailable: {error}"))
		})?;

		if !canonical_parent.starts_with(&self.execution_root) {
			return Err(WorkspaceError::new("task execution parent escapes the controlled root"));
		}

		copy_workspace_tree(&baseline, &destination)?;

		let workspace_dir = fs::canonicalize(&destination).map_err(|error| {
			WorkspaceError::new(format!("task execution workspace unavailable: {error}"))
		})?;

		if !workspace_dir.starts_with(&self.execution_root) {
			return Err(WorkspaceError::new(
				"task execution workspace escapes the controlled root",
			));
		}

		let workspace_manifest = build_workspace_manifest(&workspace_dir)
			.map_err(|error| WorkspaceError::new(error.to_string()))?;
		let workspace_digest = protocol::canonical_hash(&workspace_manifest)
			.map_err(|error| WorkspaceError::new(error.to_string()))?;

		if &workspace_digest != expected_workspace_digest {
			return Err(WorkspaceError::new(
				"copied task workspace does not match its committed baseline digest",
			));
		}

		let sandbox = SandboxPolicy::from_allowed_tools(&task.allowed_tools)
			.map_err(|error| WorkspaceError::new(error.to_string()))?;

		Ok(TaskExecutionContext { workspace_dir, sandbox })
	}
}

/// A task execution failure.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ResultFailure {
	/// Stable failure type.
	pub kind: FailureKind,
	/// Human-readable detail.
	pub message: String,
	/// Process exit code.
	pub exit_code: Option<i32>,
	/// Whether the live runner can retry the unfinished phase before it commits a terminal result.
	/// Checkpoint resume never retries an already committed result or repeats completed model work.
	pub retryable: bool,
}

/// Independent model and evaluator elapsed-time observations.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Latency {
	/// Codex adapter elapsed time in wall-clock milliseconds. It includes model
	/// and local tool execution and excludes evaluator replay.
	pub wall_ms: u64,
	/// Formal evaluator elapsed time in wall-clock milliseconds. This field is
	/// auxiliary evidence and cannot change semantic or publication decisions.
	pub evaluator_ms: u64,
}

/// Captured agent and tool usage.
#[derive(Clone, Debug, Default, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ToolUsage {
	/// Number of completed Codex items.
	pub steps: u32,
	/// Number of observed tool calls.
	pub total_calls: u32,
	/// Calls grouped by stable Codex item type.
	pub by_tool: BTreeMap<String, u32>,
	/// Completed command lines grouped by lowercase SHA-256 digest. Command text
	/// is never serialized or retained.
	#[serde(
		default,
		skip_serializing_if = "BTreeMap::is_empty",
		deserialize_with = "deserialize_nonempty_completed_command_sha256"
	)]
	pub completed_command_sha256: BTreeMap<String, u32>,
	/// Provider-reported token metadata from `turn.completed`, when present.
	#[serde(skip)]
	pub provider_tokens: ProviderTokenUsage,
}

/// Provider-reported token usage. Missing counters remain unknown and are not
/// replaced with zero or derived from other counters.
#[derive(Clone, Debug, Default, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderTokenUsage {
	/// Total input tokens reported by the provider, including cached input.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub input: Option<u64>,
	/// Cached subset of the reported input tokens.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub cached_input: Option<u64>,
	/// Input tokens written to provider prompt cache, when reported.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub cache_write_input: Option<u64>,
	/// Total output tokens reported by the provider, including reasoning output.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub output: Option<u64>,
	/// Reasoning subset of the reported output tokens.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub reasoning: Option<u64>,
	/// Provider-reported total tokens. This value is never derived locally.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub total: Option<u64>,
}
impl ProviderTokenUsage {
	/// Returns true when the provider reported no supported counters.
	#[must_use]
	pub const fn is_empty(&self) -> bool {
		self.input.is_none()
			&& self.cached_input.is_none()
			&& self.cache_write_input.is_none()
			&& self.output.is_none()
			&& self.reasoning.is_none()
			&& self.total.is_none()
	}
}

/// Deterministic post-run manifest of a candidate workspace tree.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceManifest {
	/// Manifest schema version.
	pub schema_version: &'static str,
	/// Sorted tree entries relative to the candidate root.
	pub entries: Vec<WorkspaceManifestEntry>,
}

/// One directory or regular file in a workspace manifest.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceManifestEntry {
	/// Slash-separated relative path.
	pub path: String,
	/// Entry type: `directory` or `file`.
	pub kind: &'static str,
	/// File size in bytes.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub bytes: Option<u64>,
	/// SHA-256 digest for a regular file.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub sha256: Option<String>,
}

/// Deterministic, bounded candidate workspace used for independent evaluator replay.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceSnapshot {
	/// Snapshot schema version.
	pub schema_version: String,
	/// Content hash of the corresponding canonical workspace manifest.
	pub manifest_sha256: String,
	/// Sorted directory and regular-file entries.
	pub entries: Vec<WorkspaceSnapshotEntry>,
}
impl WorkspaceSnapshot {
	/// Reconstructs a fresh workspace and verifies its exact manifest commitment.
	pub fn materialize_verified(
		&self,
		destination: &Path,
	) -> Result<WorkspaceManifest, RunnerError> {
		if self.schema_version != "aiq.workspace-snapshot.v1"
			|| !self.manifest_sha256.strip_prefix("sha256:").is_some_and(|digest| {
				digest.len() == 64
					&& digest
						.bytes()
						.all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
			}) || self.entries.len() > MAX_WORKSPACE_ENTRIES
			|| !self.entries.windows(2).all(|window| window[0].path < window[1].path)
		{
			return Err(RunnerError::new("workspace snapshot header or ordering is invalid"));
		}

		self.validate_entries()?;

		if fs::symlink_metadata(destination).is_ok() {
			return Err(RunnerError::new("workspace snapshot destination must not already exist"));
		}

		fs::create_dir(destination).map_err(|error| {
			RunnerError::new(format!("cannot create workspace snapshot destination: {error}"))
		})?;
		#[cfg(unix)]
		fs::set_permissions(destination, Permissions::from_mode(0o700)).map_err(|error| {
			RunnerError::new(format!("cannot restrict workspace snapshot destination: {error}"))
		})?;

		let destination = fs::canonicalize(destination).map_err(|error| {
			RunnerError::new(format!("cannot resolve workspace snapshot destination: {error}"))
		})?;
		let result = self.materialize_entries(&destination).and_then(|()| {
			let manifest = build_workspace_manifest(&destination)?;

			if protocol::canonical_hash(&manifest)? != self.manifest_sha256 {
				return Err(RunnerError::new(
					"reconstructed workspace does not match the snapshot manifest commitment",
				));
			}

			Ok(manifest)
		});

		if result.is_err() {
			let _ = fs::remove_dir_all(&destination);
		}

		result
	}

	fn validate_entries(&self) -> Result<(), RunnerError> {
		let mut folded_paths = BTreeSet::new();
		let mut entry_kinds = BTreeMap::new();
		let mut total_path_bytes = 0_usize;
		let mut total_file_bytes = 0_u64;

		for entry in &self.entries {
			if !safe_workspace_relative_path(&entry.path) {
				return Err(RunnerError::new("workspace snapshot path is invalid"));
			}

			total_path_bytes = total_path_bytes
				.checked_add(entry.path.len())
				.filter(|bytes| *bytes <= MAX_WORKSPACE_PATH_BYTES)
				.ok_or_else(|| {
					RunnerError::new("workspace snapshot exceeds the path-byte limit")
				})?;

			if !folded_paths.insert(entry.path.to_ascii_lowercase()) {
				return Err(RunnerError::new(
					"workspace snapshot contains case-insensitive path aliases",
				));
			}

			if let Some((parent, _)) = entry.path.rsplit_once('/')
				&& entry_kinds.get(parent) != Some(&"directory")
			{
				return Err(RunnerError::new(
					"workspace snapshot entry lacks its exact parent directory",
				));
			}

			let depth = entry.path.split('/').count();

			match entry.kind.as_str() {
				"directory"
					if depth <= MAX_WORKSPACE_DEPTH
						&& entry.bytes.is_none()
						&& entry.sha256.is_none()
						&& entry.content_hex.is_none() => {},
				"file" if depth <= MAX_WORKSPACE_DEPTH.saturating_add(1) => {
					let bytes = entry.bytes.ok_or_else(|| {
						RunnerError::new("workspace snapshot file lacks a byte count")
					})?;
					let digest = entry.sha256.as_deref().ok_or_else(|| {
						RunnerError::new("workspace snapshot file lacks a digest")
					})?;
					let content_hex = entry.content_hex.as_deref().ok_or_else(|| {
						RunnerError::new("workspace snapshot file lacks exact bytes")
					})?;
					let expected_hex_bytes = usize::try_from(bytes)
						.ok()
						.and_then(|bytes| bytes.checked_mul(2))
						.ok_or_else(|| {
							RunnerError::new("workspace snapshot file byte count is invalid")
						})?;

					if bytes > MAX_WORKSPACE_RAW_BYTES
						|| content_hex.len() != expected_hex_bytes
						|| content_hex
							.bytes()
							.any(|byte| !byte.is_ascii_digit() && !(b'a'..=b'f').contains(&byte))
						|| !digest.strip_prefix("sha256:").is_some_and(|digest| {
							digest.len() == 64
								&& digest.bytes().all(|byte| {
									byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
								})
						}) {
						return Err(RunnerError::new(
							"workspace snapshot file commitment is invalid",
						));
					}

					total_file_bytes = total_file_bytes
						.checked_add(bytes)
						.filter(|bytes| *bytes <= MAX_WORKSPACE_RAW_BYTES)
						.ok_or_else(|| {
							RunnerError::new("workspace snapshot exceeds the total raw-byte limit")
						})?;
				},
				_ => {
					return Err(RunnerError::new(
						"workspace snapshot entry is inconsistent or too deep",
					));
				},
			}

			entry_kinds.insert(entry.path.as_str(), entry.kind.as_str());
		}

		Ok(())
	}

	fn materialize_entries(&self, destination: &Path) -> Result<(), RunnerError> {
		let mut decoded_bytes = 0_usize;

		for entry in &self.entries {
			if !safe_workspace_relative_path(&entry.path) {
				return Err(RunnerError::new("workspace snapshot path is invalid"));
			}

			let path = destination.join(&entry.path);

			if !path.starts_with(destination) {
				return Err(RunnerError::new("workspace snapshot path escapes its destination"));
			}

			match entry.kind.as_str() {
				"directory"
					if entry.bytes.is_none()
						&& entry.sha256.is_none()
						&& entry.content_hex.is_none() =>
				{
					fs::create_dir(&path).map_err(|error| {
						RunnerError::new(format!(
							"cannot create workspace snapshot directory: {error}"
						))
					})?;
					#[cfg(unix)]
					fs::set_permissions(&path, Permissions::from_mode(0o700)).map_err(|error| {
						RunnerError::new(format!(
							"cannot restrict workspace snapshot directory: {error}"
						))
					})?;
				},
				"file" => {
					let expected_bytes = entry.bytes.ok_or_else(|| {
						RunnerError::new("workspace snapshot file lacks a byte count")
					})?;
					let expected_hash = entry.sha256.as_deref().ok_or_else(|| {
						RunnerError::new("workspace snapshot file lacks a digest")
					})?;
					let content_hex = entry.content_hex.as_deref().ok_or_else(|| {
						RunnerError::new("workspace snapshot file lacks exact bytes")
					})?;

					if content_hex
						.bytes()
						.any(|byte| !byte.is_ascii_digit() && !(b'a'..=b'f').contains(&byte))
						|| content_hex.len() % 2 != 0
					{
						return Err(RunnerError::new(
							"workspace snapshot file bytes are not canonical hexadecimal",
						));
					}

					let bytes = hex::decode(content_hex).map_err(|_| {
						RunnerError::new("workspace snapshot file bytes are invalid")
					})?;

					decoded_bytes = decoded_bytes.saturating_add(bytes.len());

					if u64::try_from(decoded_bytes).unwrap_or(u64::MAX) > MAX_WORKSPACE_RAW_BYTES
						|| u64::try_from(bytes.len()).unwrap_or(u64::MAX) != expected_bytes
						|| format!("sha256:{}", hex::encode(Sha256::digest(&bytes)))
							!= expected_hash
					{
						return Err(RunnerError::new(
							"workspace snapshot file does not match its commitment",
						));
					}

					let mut options = OpenOptions::new();

					options.write(true).create_new(true);

					#[cfg(unix)]
					std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);

					let mut file = options.open(&path).map_err(|error| {
						RunnerError::new(format!("cannot create workspace snapshot file: {error}"))
					})?;

					file.write_all(&bytes).and_then(|()| file.sync_all()).map_err(|error| {
						RunnerError::new(format!("cannot write workspace snapshot file: {error}"))
					})?;
				},
				_ => return Err(RunnerError::new("workspace snapshot entry is inconsistent")),
			}
		}

		Ok(())
	}
}

/// One entry in a deterministic workspace replay snapshot.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceSnapshotEntry {
	/// Slash-separated relative path.
	pub path: String,
	/// Entry type: `directory` or `file`.
	pub kind: String,
	/// File size in bytes.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub bytes: Option<u64>,
	/// SHA-256 digest for a regular file.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub sha256: Option<String>,
	/// Exact regular-file bytes as lowercase hexadecimal.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub content_hex: Option<String>,
}

/// One content-addressed task and model result.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TaskResult {
	/// Result schema version.
	pub schema_version: String,
	/// Content-addressed result identifier.
	pub result_id: String,
	/// Idempotent run identifier.
	pub run_id: String,
	/// Stable task identifier.
	pub task_id: String,
	/// Task version.
	pub task_version: String,
	/// Content address of the task package.
	pub task_hash: String,
	/// Model configuration.
	pub model: ModelConfig,
	/// Execution status.
	pub status: ResultStatus,
	/// Correctness outcome.
	pub evaluation: EvaluationOutcome,
	/// Transparent task score from 0 through 1, or no score for invalid, missing, or N/A.
	pub task_score: Option<f64>,
	/// Final response when available.
	pub response: Option<String>,
	/// Digest of the complete final response, including bytes outside the preview.
	pub response_sha256: Option<String>,
	/// Canonical SHA-256 digest of this result's external evaluator result.
	pub evaluator_result_sha256: Option<String>,
	/// SHA-256 digest of the exact checked external evaluator stdout bytes.
	#[serde(deserialize_with = "deserialize_required_nullable")]
	pub evaluator_stdout_sha256: Option<String>,
	/// Structured content-addressed raw execution artifacts.
	pub artifacts: Vec<ArtifactReference>,
	/// Structured failure when execution did not produce a scored result.
	pub failure: Option<ResultFailure>,
	/// Codex adapter elapsed time.
	pub latency: Latency,
	/// Captured tool usage.
	pub tool_usage: ToolUsage,
	/// Check-level evidence returned by the evaluator.
	///
	/// This transient field is retained in checkpoints and moved into the
	/// run-level evaluator-results artifact before an Official package is signed.
	#[serde(skip_serializing, default, deserialize_with = "reject_inline_evaluator_checks")]
	pub evaluator_checks: Vec<EvaluatorCheck>,
	/// Content-addressed deterministic workspace manifest, never a workspace archive.
	pub workspace_manifest: Option<ArtifactReference>,
	/// Result provenance.
	pub provenance: ResultProvenance,
}
impl TaskResult {
	/// Returns the result content address. The identifier field is excluded.
	pub fn content_hash(&self) -> Result<String, ProtocolError> {
		let mut package = self.clone();

		package.result_id.clear();

		protocol::canonical_hash(&package)
	}

	fn assign_result_id(&mut self) -> Result<(), ProtocolError> {
		let hash = self.content_hash()?;

		self.result_id = format!("result_{}", hash.trim_start_matches("sha256:"));

		Ok(())
	}

	pub(crate) fn evaluator_result(&self) -> Option<EvaluationResult> {
		let outcome = match self.evaluation {
			EvaluationOutcome::Correct => EvaluatorOutcome::Correct,
			EvaluationOutcome::Partial => EvaluatorOutcome::Partial,
			EvaluationOutcome::Incorrect => EvaluatorOutcome::Incorrect,
			EvaluationOutcome::NotEvaluated => return None,
		};

		Some(EvaluationResult {
			schema_version: EVALUATOR_RESULT_SCHEMA_VERSION.to_owned(),
			outcome,
			score: self.task_score?,
			checks: self.evaluator_checks.clone(),
			raw_stdout_sha256: self.evaluator_stdout_sha256.clone(),
		})
	}

	pub(crate) fn bind_evaluator_result_digest(&mut self) -> Result<(), ProtocolError> {
		self.evaluator_result_sha256 =
			self.evaluator_result().as_ref().map(protocol::canonical_hash).transpose()?;

		Ok(())
	}
}

/// Content-addressed evaluator results for one run.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EvaluatorResultsBundle {
	/// Bundle schema version.
	pub schema_version: String,
	/// Evaluator results aligned one-for-one with the signed run-result order.
	pub results: Vec<Option<EvaluationResult>>,
}

/// Complete terminal-observation history for one task-model cell.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TerminalAttemptLineage {
	/// Canonical task identifier.
	pub task_id: String,
	/// Canonical task version.
	pub task_version: String,
	/// Canonical model configuration.
	pub model: ModelConfig,
	/// Append-only terminal result identities observed for this cell.
	pub terminal_result_ids: Vec<String>,
	/// The sole terminal result selected for publication.
	pub selected_result_id: String,
}

/// A complete idempotent full-matrix run.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RunRecord {
	/// Run schema version.
	pub schema_version: String,
	/// Idempotent run identifier.
	pub run_id: String,
	/// Concrete local schedule slot.
	pub schedule_slot: ScheduleSlot,
	/// Task-set content address.
	pub task_set_hash: String,
	/// Scoring implementation version.
	pub scoring_version: String,
	/// Exact permission-admission commitment for Official execution.
	pub calibration_admission_digest: Option<String>,
	/// Frozen calibration bank; required for real Official records.
	pub calibration_bank: Option<FrozenCalibrationBankV2>,
	/// Maximum concurrent task executions, when recorded by the producing runner.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub execution_concurrency: Option<usize>,
	/// Exact 17-entry model matrix.
	pub models: Vec<ModelConfig>,
	/// Start time as Unix milliseconds.
	pub started_unix_ms: u64,
	/// End time as Unix milliseconds.
	pub finished_unix_ms: u64,
	/// Whether every result is synthetic.
	pub synthetic: bool,
	/// Capability validation used before execution.
	pub capability_validation: Option<CapabilityValidationReport>,
	/// Public-safe committed corpus and method identities. Synthetic runs use null.
	pub provenance: Option<RunProvenanceCommitment>,
	/// Content-addressed evaluator-results bundle aligned with `results`.
	pub evaluator_results_artifact: ArtifactReference,
	/// Canonical one-terminal-observation lineage for every cell.
	pub terminal_attempt_lineage: Vec<TerminalAttemptLineage>,
	/// Task and model results.
	pub results: Vec<TaskResult>,
}

/// Explicitly non-Official selected benchmark execution.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CalibrationRunRecord {
	/// Calibration record schema version.
	pub schema_version: String,
	/// This record can never be interpreted as Official.
	pub official_eligible: bool,
	/// Stable machine-readable reason for non-Official status.
	pub classification: String,
	/// Idempotent selected-run identifier.
	pub run_id: String,
	/// Concrete local schedule slot.
	pub schedule_slot: ScheduleSlot,
	/// Content address of the selected task set.
	pub task_set_hash: String,
	/// Scoring implementation version.
	pub scoring_version: String,
	/// Calibration runs never consume an Official frozen bank.
	pub calibration_admission_digest: Option<String>,
	/// Calibration runs fit, but do not consume, a frozen bank.
	pub calibration_bank: Option<FrozenCalibrationBankV2>,
	/// Maximum concurrent task executions, when recorded by the producing runner.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub execution_concurrency: Option<usize>,
	/// Ordered selected models.
	pub models: Vec<ModelConfig>,
	/// Selected task identifiers in deterministic order.
	pub task_ids: Vec<String>,
	/// Start time as Unix milliseconds.
	pub started_unix_ms: u64,
	/// End time as Unix milliseconds.
	pub finished_unix_ms: u64,
	/// Capability validation used before execution.
	pub capability_validation: CapabilityValidationReport,
	/// Public-safe committed corpus and method identities.
	pub provenance: RunProvenanceCommitment,
	/// Content-addressed evaluator-results bundle aligned with `results`.
	pub evaluator_results_artifact: ArtifactReference,
	/// Canonical one-terminal-observation lineage for every cell.
	pub terminal_attempt_lineage: Vec<TerminalAttemptLineage>,
	/// Selected task and model results.
	pub results: Vec<TaskResult>,
}

/// Machine-readable declared-capacity estimate for one selected run.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CapacityEstimate {
	/// Capacity estimate schema version.
	pub schema_version: String,
	/// Requested bounded worker count.
	pub jobs: usize,
	/// Number of selected model and task cells.
	pub selected_cells: usize,
	/// Ordered selected model keys.
	pub model_keys: Vec<String>,
	/// Ordered selected task identifiers.
	pub task_ids: Vec<String>,
	/// Sum of declared wall budgets, or `None` when any selected task is unbounded.
	pub declared_wall_budget_sum_seconds: Option<u64>,
	/// Largest worker load, or `None` when any selected task is unbounded.
	pub declared_wall_budget_critical_path_seconds: Option<u64>,
	/// Capacity output is evidence only and never asserts schedule feasibility.
	pub feasibility_assessed: bool,
}

/// Runner failure with a stable temporary-capacity disposition.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RunnerError {
	kind: RunnerErrorKind,
	message: String,
}
impl RunnerError {
	fn new(message: impl Into<String>) -> Self {
		Self { kind: RunnerErrorKind::General, message: message.into() }
	}

	fn subscription_backpressure() -> Self {
		Self {
			kind: RunnerErrorKind::SubscriptionBackpressure,
			message: "subscription capacity unavailable; checkpoint retained for resume".to_owned(),
		}
	}

	/// Reports the stable temporary-capacity outcome to the CLI entry point.
	#[must_use]
	pub fn is_subscription_backpressure(&self) -> bool {
		self.kind == RunnerErrorKind::SubscriptionBackpressure
	}

	/// Returns the CLI exit code for this runner outcome.
	#[must_use]
	pub fn exit_code(&self) -> u8 {
		if self.is_subscription_backpressure() { SUBSCRIPTION_BACKPRESSURE_EXIT_CODE } else { 1 }
	}
}

impl std::error::Error for RunnerError {}

impl Display for RunnerError {
	fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
		formatter.write_str(&self.message)
	}
}

impl From<ProtocolError> for RunnerError {
	fn from(error: ProtocolError) -> Self {
		Self::new(error.to_string())
	}
}

struct SelectedRunExecution<'a, E, S, P> {
	adapter: &'a CodexAdapter<E, S>,
	workspace_provider: &'a P,
	manifest: &'a CapabilityManifest,
	tasks: &'a [TaskDefinition],
	models: &'a [ModelConfig],
	observed_at: &'a str,
	validation: &'a CapabilityValidationReport,
	commitments: &'a RunCommitments,
	evaluator_root: Option<&'a Path>,
	evaluator_runtime: Option<&'a EvaluatorRuntime>,
	checkpoint_path: &'a Path,
	jobs: usize,
	codex_version: &'a str,
}
impl<E, S, P> SelectedRunExecution<'_, E, S, P>
where
	E: Executor + Sync,
	S: ArtifactSink + Sync,
	P: TaskWorkspaceProvider + Sync,
{
	fn complete_pending(
		&self,
		checkpoint: &mut RunCheckpoint,
		committed: &mut BTreeMap<usize, TaskResult>,
	) -> Result<(), RunnerError> {
		self.complete_pending_evaluations(checkpoint, committed)?;

		if !checkpoint.in_flight.is_empty() {
			for cell in &checkpoint.in_flight {
				let task = self
					.tasks
					.iter()
					.find(|task| {
						task.task_id == cell.task_id && task.task_version == cell.task_version
					})
					.ok_or_else(|| RunnerError::new("checkpoint in-flight task is not selected"))?;

				self.workspace_provider
					.quarantine_interrupted(&self.commitments.run_id, cell.model, task)
					.map_err(|error| RunnerError::new(error.to_string()))?;
			}

			return Err(RunnerError::new(
				"checkpoint contains an indeterminate paid cell; automatic retry is prohibited",
			));
		}
		if checkpoint.results.iter().any(aborts_paid_run) {
			return Err(RunnerError::new(
				"checkpoint records a paid-run boundary failure; paid execution remains aborted",
			));
		}

		let live_cells = self.prepare_pending(checkpoint, committed)?;

		if live_cells.is_empty() {
			return Ok(());
		}

		self.execute_live_cells(&live_cells, checkpoint, committed)
	}

	fn complete_pending_evaluations(
		&self,
		checkpoint: &mut RunCheckpoint,
		committed: &mut BTreeMap<usize, TaskResult>,
	) -> Result<(), RunnerError> {
		for pending in checkpoint.pending_evaluations.clone() {
			let task_index = self
				.tasks
				.iter()
				.position(|task| {
					task.task_id == pending.task_id && task.task_version == pending.task_version
				})
				.ok_or_else(|| RunnerError::new("pending evaluator task is not selected"))?;
			let model_index = self
				.models
				.iter()
				.position(|model| *model == pending.model)
				.ok_or_else(|| RunnerError::new("pending evaluator model is not selected"))?;
			let index = model_index * self.tasks.len() + task_index;

			if committed.contains_key(&index) {
				return Err(RunnerError::new(
					"pending evaluator cell already has a committed result",
				));
			}

			let (mut result, sealed_workspace) = resume_pending_evaluation(
				&pending,
				&self.tasks[task_index],
				self.commitments,
				self.codex_version,
				self.evaluator_root,
				self.evaluator_runtime,
			)?;

			if retryable_evaluator_result(&result) {
				return Err(retryable_evaluator_error(&result));
			}

			result.assign_result_id()?;
			committed.insert(index, result);
			checkpoint.pending_evaluations.retain(|candidate| {
				candidate.task_id != pending.task_id
					|| candidate.task_version != pending.task_version
					|| candidate.model != pending.model
			});
			self.persist_checkpoint(checkpoint, committed)?;
			sealed_workspace.cleanup().map_err(|error| RunnerError::new(error.to_string()))?;
		}

		Ok(())
	}

	fn prepare_pending(
		&self,
		checkpoint: &mut RunCheckpoint,
		committed: &mut BTreeMap<usize, TaskResult>,
	) -> Result<Vec<(usize, usize, usize)>, RunnerError> {
		let mut live_cells = Vec::new();

		for (task_index, model_index) in
			task_major_execution_order(self.tasks.len(), self.models.len())
		{
			let model = &self.models[model_index];
			let model_validation = self.validation.model(*model).ok_or_else(|| {
				RunnerError::new("capability validation omitted a selected entry")
			})?;
			let task = &self.tasks[task_index];
			let index = model_index * self.tasks.len() + task_index;

			if committed.contains_key(&index) {
				continue;
			}
			if model_validation.status == CapabilityValidationStatus::Available {
				self.workspace_provider
					.quarantine_interrupted(&self.commitments.run_id, *model, task)
					.map_err(|error| RunnerError::new(error.to_string()))?;
				live_cells.push((index, model_index, task_index));

				continue;
			}

			let mut result = match model_validation.status {
				CapabilityValidationStatus::Unsupported => unavailable_result(
					self.manifest,
					task,
					*model,
					&self.commitments.run_id,
					self.codex_version,
					self.observed_at,
					ResultStatus::Unsupported,
					FailureKind::CapabilityUnavailable,
					&model_validation.reason,
				)?,
				CapabilityValidationStatus::Unavailable => unavailable_result(
					self.manifest,
					task,
					*model,
					&self.commitments.run_id,
					self.codex_version,
					self.observed_at,
					ResultStatus::Failed,
					FailureKind::CapabilityValidationFailed,
					&model_validation.reason,
				)?,
				CapabilityValidationStatus::Available => unreachable!(),
			};

			result.assign_result_id()?;
			committed.insert(index, result);
			self.persist_checkpoint(checkpoint, committed)?;
		}

		Ok(live_cells)
	}

	fn execute_live_cells(
		&self,
		live_cells: &[(usize, usize, usize)],
		checkpoint: &mut RunCheckpoint,
		committed: &mut BTreeMap<usize, TaskResult>,
	) -> Result<(), RunnerError> {
		let worker_count = self.jobs.min(live_cells.len());
		let next = Arc::new(AtomicUsize::new(0));
		let cancelled = Arc::new(AtomicBool::new(false));
		let (event_tx, event_rx) = mpsc::channel::<SelectedWorkerEvent>();

		thread::scope(|scope| -> Result<(), RunnerError> {
			for _ in 0..worker_count {
				let next = Arc::clone(&next);
				let cancelled = Arc::clone(&cancelled);
				let event_tx = event_tx.clone();

				scope.spawn(move || {
					self.execute_live_worker(live_cells, &next, &cancelled, &event_tx);
				});
			}

			drop(event_tx);

			let mut fatal = None;

			for event in event_rx {
				if let Err(error) = self.handle_worker_event(
					event,
					checkpoint,
					committed,
					fatal.is_some(),
					&cancelled,
				) {
					cancelled.store(true, Ordering::Release);
					fatal.get_or_insert(error);
				}
			}

			fatal.map_or(Ok(()), Err)
		})
	}

	fn execute_live_worker(
		&self,
		live_cells: &[(usize, usize, usize)],
		next: &AtomicUsize,
		cancelled: &AtomicBool,
		event_tx: &Sender<SelectedWorkerEvent>,
	) {
		while !cancelled.load(Ordering::Acquire) {
			let position = next.fetch_add(1, Ordering::AcqRel);
			let Some((index, model_index, task_index)) = live_cells.get(position).copied() else {
				break;
			};
			let (acknowledged_tx, acknowledged_rx) = mpsc::sync_channel(0);

			if event_tx
				.send(SelectedWorkerEvent::Starting {
					index,
					model_index,
					task_index,
					acknowledged: acknowledged_tx,
				})
				.is_err() || !matches!(acknowledged_rx.recv(), Ok(Ok(())))
			{
				break;
			}

			let result = self.execute_live_cell_with_retries(
				index,
				model_index,
				task_index,
				cancelled,
				event_tx,
			);

			if match result.as_ref() {
				Ok(cell) => {
					subscription_limit_result(&cell.result)
						|| retryable_evaluator_result(&cell.result)
						|| aborts_paid_run(&cell.result)
				},
				Err(_) => true,
			} {
				cancelled.store(true, Ordering::Release);
			}
			if event_tx.send(SelectedWorkerEvent::Completed(Box::new(result))).is_err() {
				break;
			}
		}
	}

	fn execute_live_cell_with_retries(
		&self,
		index: usize,
		model_index: usize,
		task_index: usize,
		cancelled: &AtomicBool,
		event_tx: &Sender<SelectedWorkerEvent>,
	) -> Result<CompletedCell, RunnerError> {
		let task = &self.tasks[task_index];
		let model = self.models[model_index];
		let mut attempt_number = 1_u32;
		let mut prior_stdout = String::new();
		let mut prior_wall_ms = 0_u64;

		loop {
			let mut evaluator_ready = |pending: &PendingEvaluation| {
				let (acknowledged_tx, acknowledged_rx) = mpsc::sync_channel(0);

				event_tx
					.send(SelectedWorkerEvent::EvaluationReady {
						index,
						pending: Box::new(pending.clone()),
						acknowledged: acknowledged_tx,
					})
					.map_err(|_| RunnerError::new("cannot persist pending evaluator work"))?;

				match acknowledged_rx.recv() {
					Ok(Ok(())) => Ok(()),
					Ok(Err(message)) => Err(RunnerError::new(message)),
					Err(_) => {
						Err(RunnerError::new("pending evaluator checkpoint was not acknowledged"))
					},
				}
			};
			let attempt = execute_task_attempt(
				self.adapter,
				self.workspace_provider,
				self.manifest,
				task,
				model,
				&self.commitments.run_id,
				self.codex_version,
				self.observed_at,
				self.evaluator_root,
				self.evaluator_runtime,
				Some(&mut evaluator_ready),
			)?;
			let retry = !cancelled.load(Ordering::Acquire)
				&& retryable_invocation_result(&attempt.result)
				&& parse_codex_tool_usage(&attempt.stdout_full).is_ok();

			if retry {
				append_invocation_attempt(
					&mut prior_stdout,
					&attempt.stdout_full,
					InvocationAttemptMarker::retry(
						attempt_number,
						attempt.result.latency.wall_ms,
						attempt.result.failure.as_ref(),
					),
				)?;

				prior_wall_ms = prior_wall_ms
					.checked_add(attempt.result.latency.wall_ms)
					.ok_or_else(|| RunnerError::new("retryable invocation latency overflowed"))?;
				attempt_number = attempt_number
					.checked_add(1)
					.ok_or_else(|| RunnerError::new("retryable invocation count overflowed"))?;

				self.workspace_provider
					.quarantine_interrupted(&self.commitments.run_id, model, task)
					.map_err(|error| RunnerError::new(error.to_string()))?;

				continue;
			}

			let TaskExecutionAttempt { mut result, stdout_full, sealed_workspace } = attempt;

			if !prior_stdout.is_empty() {
				let disposition = if result.status == ResultStatus::Completed {
					InvocationAttemptDisposition::Selected
				} else {
					InvocationAttemptDisposition::TerminalFailure
				};

				append_invocation_attempt(
					&mut prior_stdout,
					&stdout_full,
					InvocationAttemptMarker::terminal(
						attempt_number,
						result.latency.wall_ms,
						disposition,
						result.failure.as_ref(),
					),
				)?;

				result.latency.wall_ms = prior_wall_ms
					.checked_add(result.latency.wall_ms)
					.ok_or_else(|| RunnerError::new("invocation latency overflowed"))?;
				result.tool_usage = parse_codex_tool_usage(&prior_stdout)
					.map_err(|error| RunnerError::new(error.to_string()))?;

				project_completed_command_digests(task, &mut result.tool_usage);

				result.artifacts.retain(|artifact| artifact.kind != "stdout.jsonl");
				result.artifacts.push(
					self.adapter
						.store_artifact("stdout.jsonl", prior_stdout.as_bytes())
						.map_err(|error| RunnerError::new(error.to_string()))?,
				);

				validate_invocation_attempt_evidence(&result, &prior_stdout)
					.map_err(|error| RunnerError::new(error.to_string()))?;
			}

			result.assign_result_id()?;

			return Ok(CompletedCell { index, result, sealed_workspace });
		}
	}

	fn handle_worker_event(
		&self,
		event: SelectedWorkerEvent,
		checkpoint: &mut RunCheckpoint,
		committed: &mut BTreeMap<usize, TaskResult>,
		fatal: bool,
		cancelled: &AtomicBool,
	) -> Result<(), RunnerError> {
		match event {
			SelectedWorkerEvent::Starting { index, model_index, task_index, acknowledged } => {
				if fatal || cancelled.load(Ordering::Acquire) {
					let _ = acknowledged.send(Err("run is cancelled".to_owned()));

					return Ok(());
				}

				let task = &self.tasks[task_index];
				let marker = InFlightCell {
					task_id: task.task_id.clone(),
					task_version: task.task_version.clone(),
					model: self.models[model_index],
				};

				if committed.contains_key(&index) || checkpoint.in_flight.contains(&marker) {
					let message = "worker started a duplicate selected cell".to_owned();
					let _ = acknowledged.send(Err(message.clone()));

					return Err(RunnerError::new(message));
				}

				checkpoint.in_flight.push(marker);

				match self.persist_checkpoint(checkpoint, committed) {
					Ok(()) => {
						let _ = acknowledged.send(Ok(()));

						Ok(())
					},
					Err(error) => {
						let message = error.to_string();
						let _ = acknowledged.send(Err(message.clone()));

						Err(RunnerError::new(message))
					},
				}
			},
			SelectedWorkerEvent::EvaluationReady { index, pending, acknowledged } => self
				.handle_evaluation_ready_event(
					index,
					*pending,
					acknowledged,
					checkpoint,
					committed,
				),
			SelectedWorkerEvent::Completed(result) => {
				self.handle_completed_event(*result, checkpoint, committed)
			},
		}
	}

	fn handle_evaluation_ready_event(
		&self,
		index: usize,
		pending: PendingEvaluation,
		acknowledged: SyncSender<Result<(), String>>,
		checkpoint: &mut RunCheckpoint,
		committed: &BTreeMap<usize, TaskResult>,
	) -> Result<(), RunnerError> {
		let marker = InFlightCell {
			task_id: pending.task_id.clone(),
			task_version: pending.task_version.clone(),
			model: pending.model,
		};
		let expected_index =
			self.models.iter().position(|model| *model == pending.model).and_then(|model_index| {
				self.tasks
					.iter()
					.position(|task| {
						task.task_id == pending.task_id && task.task_version == pending.task_version
					})
					.map(|task_index| model_index * self.tasks.len() + task_index)
			});
		let position = checkpoint.in_flight.iter().position(|cell| cell == &marker);
		let duplicate = checkpoint.pending_evaluations.iter().any(|candidate| {
			candidate.task_id == pending.task_id
				&& candidate.task_version == pending.task_version
				&& candidate.model == pending.model
		});
		let Some(position) = position else {
			let message =
				"worker produced pending evaluator work without an in-flight marker".to_owned();
			let _ = acknowledged.send(Err(message.clone()));

			return Err(RunnerError::new(message));
		};

		if expected_index != Some(index) || committed.contains_key(&index) || duplicate {
			let message = "worker produced invalid or duplicate pending evaluator work".to_owned();
			let _ = acknowledged.send(Err(message.clone()));

			return Err(RunnerError::new(message));
		}

		checkpoint.in_flight.remove(position);
		checkpoint.pending_evaluations.push(pending);
		checkpoint.pending_evaluations.sort_by(|left, right| {
			(&left.task_id, &left.task_version, left.model).cmp(&(
				&right.task_id,
				&right.task_version,
				right.model,
			))
		});

		match self.persist_checkpoint(checkpoint, committed) {
			Ok(()) => {
				let _ = acknowledged.send(Ok(()));

				Ok(())
			},
			Err(error) => {
				let message = error.to_string();
				let _ = acknowledged.send(Err(message.clone()));

				Err(RunnerError::new(message))
			},
		}
	}

	fn handle_completed_event(
		&self,
		completed: Result<CompletedCell, RunnerError>,
		checkpoint: &mut RunCheckpoint,
		committed: &mut BTreeMap<usize, TaskResult>,
	) -> Result<(), RunnerError> {
		let CompletedCell { index, result, sealed_workspace } = completed?;
		let marker = InFlightCell {
			task_id: result.task_id.clone(),
			task_version: result.task_version.clone(),
			model: result.model,
		};
		let in_flight_position =
			checkpoint.in_flight.iter().position(|candidate| candidate == &marker);
		let pending_position = checkpoint.pending_evaluations.iter().position(|candidate| {
			candidate.task_id == marker.task_id
				&& candidate.task_version == marker.task_version
				&& candidate.model == marker.model
		});

		if retryable_evaluator_result(&result) {
			let Some(position) = pending_position else {
				return Err(RunnerError::new(
					"retryable evaluator failure has no durable pending evaluation",
				));
			};
			let retained = sealed_workspace.as_ref().ok_or_else(|| {
				RunnerError::new("retryable evaluator failure lost its sealed workspace")
			})?;

			if in_flight_position.is_some()
				|| retained.path()
					!= checkpoint.pending_evaluations[position].sealed_workspace.as_path()
			{
				return Err(RunnerError::new(
					"retryable evaluator failure does not match its durable pending evidence",
				));
			}

			return Err(retryable_evaluator_error(&result));
		}

		match (in_flight_position, pending_position) {
			(Some(position), None) => {
				checkpoint.in_flight.remove(position);
			},
			(None, Some(position)) => {
				checkpoint.pending_evaluations.remove(position);
			},
			_ => {
				return Err(RunnerError::new(
					"worker completed a cell without exactly one durable phase marker",
				));
			},
		}

		if subscription_limit_result(&result) {
			let backpressure = checkpoint.subscription_backpressure.get_or_insert_with(|| {
				SubscriptionBackpressure {
					schema_version: SUBSCRIPTION_BACKPRESSURE_SCHEMA_VERSION.to_owned(),
					deferred_results: Vec::new(),
				}
			});

			if let Some(deferred) = backpressure.deferred_results.iter_mut().find(|deferred| {
				deferred.task_id == marker.task_id
					&& deferred.task_version == marker.task_version
					&& deferred.model == marker.model
			}) {
				*deferred = result;
			} else {
				backpressure.deferred_results.push(result);
			}

			backpressure.deferred_results.sort_by(|left, right| {
				(&left.task_id, &left.task_version, left.model).cmp(&(
					&right.task_id,
					&right.task_version,
					right.model,
				))
			});
			self.persist_checkpoint(checkpoint, committed)?;

			return Err(RunnerError::subscription_backpressure());
		}

		if let Some(backpressure) = &mut checkpoint.subscription_backpressure {
			backpressure.deferred_results.retain(|deferred| {
				deferred.task_id != marker.task_id
					|| deferred.task_version != marker.task_version
					|| deferred.model != marker.model
			});
		}

		if committed.insert(index, result).is_some() {
			return Err(RunnerError::new("worker completed a duplicate selected cell"));
		}

		self.persist_checkpoint(checkpoint, committed)?;

		if let Some(sealed_workspace) = sealed_workspace {
			sealed_workspace.cleanup().map_err(|error| RunnerError::new(error.to_string()))?;
		}

		if aborts_paid_run(committed.get(&index).expect("just inserted result")) {
			return Err(RunnerError::new(
				"paid-run boundary failure aborted the remaining paid cells",
			));
		}

		Ok(())
	}

	fn persist_checkpoint(
		&self,
		checkpoint: &mut RunCheckpoint,
		committed: &BTreeMap<usize, TaskResult>,
	) -> Result<(), RunnerError> {
		checkpoint.results = committed.values().cloned().collect();

		accumulate_terminal_attempt_lineage(
			&mut checkpoint.terminal_attempt_lineage,
			&checkpoint.results,
		)?;

		checkpoint.evaluator_results =
			checkpoint.results.iter().map(TaskResult::evaluator_result).collect();

		checkpoint
			.persist(self.checkpoint_path)
			.map_err(|error| RunnerError::new(error.to_string()))
	}
}

struct SealedWorkspace {
	path: PathBuf,
}
impl SealedWorkspace {
	fn create(source: &Path) -> Result<Self, WorkspaceError> {
		let source = canonical_directory(source, "candidate workspace")?;
		let parent = source
			.parent()
			.ok_or_else(|| WorkspaceError::new("candidate workspace has no controlled parent"))?;
		let parent = canonical_directory(parent, "candidate workspace parent")?;
		let source_name = source
			.file_name()
			.and_then(|name| name.to_str())
			.filter(|name| safe_path_component(name))
			.ok_or_else(|| WorkspaceError::new("candidate workspace name is unsafe"))?;
		let source_manifest = build_workspace_manifest(&source)
			.map_err(|error| WorkspaceError::new(error.to_string()))?;
		let created_at =
			SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |duration| duration.as_nanos());
		let mut destination = None;

		for _ in 0..64 {
			let sequence = SEALED_WORKSPACE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
			let candidate = parent
				.join(format!(".sealed-{source_name}-{}-{created_at}-{sequence}", process::id()));

			match fs::create_dir(&candidate) {
				Ok(()) => {
					destination = Some(candidate);

					break;
				},
				Err(error) if error.kind() == ErrorKind::AlreadyExists => {},
				Err(error) => {
					return Err(WorkspaceError::new(format!(
						"cannot create sealed candidate workspace: {error}"
					)));
				},
			}
		}

		let destination = destination.ok_or_else(|| {
			WorkspaceError::new("cannot allocate a unique sealed candidate workspace")
		})?;
		let result = (|| {
			restrict_workspace_permissions(&destination, true)?;
			copy_workspace_contents(&source, &destination)?;
			restrict_workspace_tree(&destination)?;

			let source_after = build_workspace_manifest(&source)
				.map_err(|error| WorkspaceError::new(error.to_string()))?;
			let sealed_manifest = build_workspace_manifest(&destination)
				.map_err(|error| WorkspaceError::new(error.to_string()))?;

			if source_manifest != source_after || source_manifest != sealed_manifest {
				return Err(WorkspaceError::new(
					"candidate workspace changed while its sealed copy was created",
				));
			}

			let path = fs::canonicalize(&destination).map_err(|error| {
				WorkspaceError::new(format!("cannot resolve sealed candidate workspace: {error}"))
			})?;

			if path.parent() != Some(parent.as_path()) || path == source {
				return Err(WorkspaceError::new(
					"sealed candidate workspace is not a fresh sibling",
				));
			}

			Ok(Self { path })
		})();

		match result {
			Ok(sealed) => Ok(sealed),
			Err(error) => match remove_sealed_workspace(&destination) {
				Ok(()) => Err(error),
				Err(cleanup) => Err(WorkspaceError::new(format!(
					"{error}; partial sealed workspace cleanup failed: {cleanup}"
				))),
			},
		}
	}

	fn path(&self) -> &Path {
		&self.path
	}

	fn retained(path: &Path) -> Result<Self, WorkspaceError> {
		let metadata = fs::symlink_metadata(path).map_err(|error| {
			WorkspaceError::new(format!("retained sealed workspace is unavailable: {error}"))
		})?;

		if metadata.file_type().is_symlink() || !metadata.is_dir() {
			return Err(WorkspaceError::new(
				"retained sealed workspace must be a regular directory",
			));
		}

		let canonical = fs::canonicalize(path).map_err(|error| {
			WorkspaceError::new(format!("cannot resolve retained sealed workspace: {error}"))
		})?;

		if canonical != path {
			return Err(WorkspaceError::new("retained sealed workspace path is not canonical"));
		}

		Ok(Self { path: canonical })
	}

	fn cleanup(self) -> Result<(), WorkspaceError> {
		remove_sealed_workspace(&self.path)
	}
}

#[derive(Default)]
struct WorkspaceCopyBudget {
	entries: usize,
	raw_bytes: u64,
	path_bytes: usize,
}

struct ResultEvaluation {
	status: ResultStatus,
	outcome: EvaluationOutcome,
	score: Option<f64>,
	checks: Vec<EvaluatorCheck>,
	raw_stdout_sha256: Option<String>,
	failure: Option<ResultFailure>,
}

struct ResultEvaluationRequest<'a> {
	task: &'a TaskDefinition,
	model: ModelConfig,
	run_id: &'a str,
	exit_code: Option<i32>,
	complete_response: Option<&'a str>,
	workspace_dir: &'a Path,
	workspace_manifest: &'a ArtifactReference,
	evaluator_root: Option<&'a Path>,
	evaluator_runtime: Option<&'a EvaluatorRuntime>,
	tool_usage: &'a ToolUsage,
	budget_failure: Option<&'a str>,
}

#[derive(Deserialize)]
struct SyntheticCatalog {
	tasks: Vec<SyntheticCatalogTask>,
}

#[derive(Deserialize)]
struct SyntheticCatalogTask {
	task_id: String,
	task_version: String,
	domain: Domain,
	difficulty: String,
	cluster_id: String,
	evaluator: SyntheticCatalogEvaluator,
}

#[derive(Deserialize)]
struct SyntheticCatalogEvaluator {
	scorer_version: String,
}

#[derive(Clone, Debug)]
struct InvocationEvidence {
	wall_ms: u64,
	exit_code: Option<i32>,
	artifacts: Vec<ArtifactReference>,
	tool_usage: ToolUsage,
	stdout_full: String,
}
impl InvocationEvidence {
	fn capture(
		invocation: &Result<CodexOutput, AdapterFailure>,
		wall_ms: u64,
		task: &TaskDefinition,
	) -> Self {
		match invocation {
			Ok(output) => Self {
				wall_ms,
				exit_code: output.exit_code,
				artifacts: output.artifacts.clone(),
				tool_usage: retained_stdout_tool_usage(
					&output.stdout_full,
					&output.artifacts,
					task,
				),
				stdout_full: output.stdout_full.clone(),
			},
			Err(failure) => Self {
				wall_ms,
				exit_code: failure.exit_code,
				artifacts: failure.artifacts.clone(),
				tool_usage: retained_stdout_tool_usage(
					&failure.stdout_full,
					&failure.artifacts,
					task,
				),
				stdout_full: failure.stdout_full.clone(),
			},
		}
	}
}

struct TaskExecutionAttempt {
	result: TaskResult,
	stdout_full: String,
	sealed_workspace: Option<SealedWorkspace>,
}

struct CompletedCell {
	index: usize,
	result: TaskResult,
	sealed_workspace: Option<SealedWorkspace>,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct InvocationAttemptMarker {
	#[serde(rename = "type")]
	event_type: String,
	attempt: u32,
	disposition: InvocationAttemptDisposition,
	failure_kind: Option<FailureKind>,
	exit_code: Option<i32>,
	wall_ms: u64,
}
impl InvocationAttemptMarker {
	fn retry(attempt: u32, wall_ms: u64, failure: Option<&ResultFailure>) -> Self {
		Self::new(attempt, wall_ms, InvocationAttemptDisposition::Retry, failure)
	}

	fn terminal(
		attempt: u32,
		wall_ms: u64,
		disposition: InvocationAttemptDisposition,
		failure: Option<&ResultFailure>,
	) -> Self {
		Self::new(attempt, wall_ms, disposition, failure)
	}

	fn new(
		attempt: u32,
		wall_ms: u64,
		disposition: InvocationAttemptDisposition,
		failure: Option<&ResultFailure>,
	) -> Self {
		Self {
			event_type: "aiq.invocation-attempt.v1".to_owned(),
			attempt,
			disposition,
			failure_kind: failure.map(|failure| failure.kind),
			exit_code: failure.and_then(|failure| failure.exit_code),
			wall_ms,
		}
	}
}

/// Run, task, model, and result status.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ResultStatus {
	/// Codex completed and the evaluator produced an outcome.
	Completed,
	/// Codex or the runner failed.
	Failed,
	/// The capability manifest reports no support.
	Unsupported,
	/// Codex completed, but no evaluator was available.
	Unevaluated,
}

/// Correctness outcome used by scoring.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EvaluationOutcome {
	/// The evaluator accepted the response.
	Correct,
	/// The evaluator rejected the response.
	Incorrect,
	/// No evaluator result exists.
	NotEvaluated,
	/// The evaluator awarded auditable partial credit.
	Partial,
}

/// Structured failure type.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureKind {
	/// Process execution failed.
	Spawn,
	/// The task exceeded its timeout.
	Timeout,
	/// Codex rejected the model.
	UnsupportedModel,
	/// Codex authentication or authorization failed.
	Authentication,
	/// The subscription quota or usage limit prevents further paid execution.
	SubscriptionLimit,
	/// Codex returned another unsuccessful exit.
	NonZeroExit,
	/// The capability claim and CLI probe do not permit execution.
	CapabilityUnavailable,
	/// Capability validation failed and cannot establish support.
	CapabilityValidationFailed,
	/// The task has no evaluator.
	MissingEvaluator,
	/// Codex produced no final response.
	MissingResponse,
	/// The controlled evaluator failed and requires an audited rerun.
	EvaluatorFailure,
	/// Observed execution exceeded a declared non-time budget.
	BudgetExceeded,
	/// Captured model output exceeded the safe byte limit.
	OutputTruncated,
	/// The controlled task workspace could not be prepared.
	WorkspaceUnavailable,
	/// A paid invocation completed or failed, but post-invocation workspace
	/// sealing, evidence retention, integrity validation, or cleanup failed.
	WorkspaceIntegrity,
}

/// Full Official-shaped output or an explicitly non-Official calibration output.
#[derive(Clone, Debug, PartialEq)]
pub enum SelectedRun {
	/// Existing complete run protocol.
	OfficialShape(RunRecord),
	/// Selected subset protocol.
	Calibration(CalibrationRunRecord),
}

/// Runner orchestration error.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RunnerErrorKind {
	General,
	SubscriptionBackpressure,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum InvocationAttemptDisposition {
	Retry,
	Selected,
	TerminalFailure,
}

#[derive(Clone, Copy, Debug)]
enum WorkspaceIntegrityFailure {
	Sealing,
	EvidenceRetention,
	PostEvaluationIntegrity,
	PostEvaluationCleanup,
}
impl WorkspaceIntegrityFailure {
	fn message(self) -> &'static str {
		match self {
			Self::Sealing => "post-invocation workspace sealing failed",
			Self::EvidenceRetention => {
				"post-invocation workspace evidence retention or cleanup failed"
			},
			Self::PostEvaluationIntegrity => {
				"post-evaluation workspace integrity or cleanup failed"
			},
			Self::PostEvaluationCleanup => "post-evaluation workspace cleanup failed",
		}
	}
}

enum SelectedWorkerEvent {
	Starting {
		index: usize,
		model_index: usize,
		task_index: usize,
		acknowledged: SyncSender<Result<(), String>>,
	},
	EvaluationReady {
		index: usize,
		pending: Box<PendingEvaluation>,
		acknowledged: SyncSender<Result<(), String>>,
	},
	Completed(Box<Result<CompletedCell, RunnerError>>),
}

/// Validates retry-attempt markers bound inside one content-addressed stdout artifact.
pub fn validate_invocation_attempt_evidence(
	result: &TaskResult,
	stdout: &str,
) -> Result<(), CodexItemPolicyError> {
	let mut markers = Vec::new();

	for line in stdout.lines() {
		let Ok(value) = serde_json::from_str::<Value>(line) else {
			continue;
		};
		let Some(event_type) = value.get("type").and_then(Value::as_str) else {
			continue;
		};

		if event_type == "aiq.invocation-attempt.v1" {
			markers.push(serde_json::from_value::<InvocationAttemptMarker>(value).map_err(
				|_| {
					CodexItemPolicyError::new(
						"invocation-attempt marker is not strict versioned JSON",
					)
				},
			)?);
		} else if event_type.starts_with("aiq.invocation-attempt.") {
			return Err(CodexItemPolicyError::new(
				"invocation-attempt marker version is not supported",
			));
		}
	}

	if markers.is_empty() {
		return Ok(());
	}
	if markers.len() < 2 {
		return Err(CodexItemPolicyError::new(
			"retry evidence must contain a retry and one selected terminal attempt",
		));
	}

	let mut wall_ms = 0_u64;

	for (index, marker) in markers.iter().enumerate() {
		let expected_attempt = u32::try_from(index + 1)
			.map_err(|_| CodexItemPolicyError::new("invocation-attempt count overflowed"))?;

		if marker.event_type != "aiq.invocation-attempt.v1" || marker.attempt != expected_attempt {
			return Err(CodexItemPolicyError::new("invocation-attempt marker sequence is invalid"));
		}

		wall_ms = wall_ms
			.checked_add(marker.wall_ms)
			.ok_or_else(|| CodexItemPolicyError::new("invocation-attempt latency overflowed"))?;

		if index + 1 < markers.len() {
			let retry_failure = matches!(
				(marker.failure_kind, marker.exit_code),
				(Some(FailureKind::NonZeroExit), Some(code)) if code != 0
			) || matches!(
				(marker.failure_kind, marker.exit_code),
				(Some(FailureKind::MissingResponse), None | Some(0))
			);

			if marker.disposition != InvocationAttemptDisposition::Retry || !retry_failure {
				return Err(CodexItemPolicyError::new(
					"retry marker does not bind a retryable Codex invocation failure",
				));
			}
		}
	}

	let final_marker = markers.last().expect("non-empty markers");
	let final_valid = if result.status == ResultStatus::Completed {
		final_marker.disposition == InvocationAttemptDisposition::Selected
			&& final_marker.failure_kind.is_none()
			&& final_marker.exit_code.is_none()
	} else {
		final_marker.disposition == InvocationAttemptDisposition::TerminalFailure
			&& result.failure.as_ref().is_some_and(|failure| {
				final_marker.failure_kind == Some(failure.kind)
					&& final_marker.exit_code == failure.exit_code
			})
	};

	if !final_valid || wall_ms != result.latency.wall_ms {
		return Err(CodexItemPolicyError::new(
			"selected invocation-attempt evidence does not match the task result",
		));
	}

	Ok(())
}

/// Derives canonical lineage without discarding duplicate terminal evidence.
#[must_use]
pub fn terminal_attempt_lineage(results: &[TaskResult]) -> Vec<TerminalAttemptLineage> {
	let mut grouped = BTreeMap::<(String, String, ModelConfig), Vec<String>>::new();

	for result in results {
		grouped
			.entry((result.task_id.clone(), result.task_version.clone(), result.model))
			.or_default()
			.push(result.result_id.clone());
	}

	grouped
		.into_iter()
		.map(|((task_id, task_version, model), terminal_result_ids)| TerminalAttemptLineage {
			task_id,
			task_version,
			model,
			selected_result_id: terminal_result_ids.last().cloned().unwrap_or_default(),
			terminal_result_ids,
		})
		.collect()
}

/// Rejects replacement, selection, omission, or duplicate terminal evidence.
pub fn validate_terminal_attempt_lineage(
	results: &[TaskResult],
	lineage: &[TerminalAttemptLineage],
) -> Result<(), ProtocolError> {
	let expected = terminal_attempt_lineage(results);

	if lineage != expected
		|| lineage.iter().any(|entry| {
			entry.terminal_result_ids.len() != 1
				|| entry.terminal_result_ids.first() != Some(&entry.selected_result_id)
		}) {
		return Err(ProtocolError::new(
			"terminal-attempt lineage contains replacement or multiple selected observations",
		));
	}

	Ok(())
}

/// Builds a declared-capacity estimate without invoking a model.
pub fn estimate_capacity(
	tasks: &[TaskDefinition],
	models: &[ModelConfig],
	jobs: usize,
) -> Result<CapacityEstimate, RunnerError> {
	validate_jobs(jobs)?;

	if tasks.is_empty() || models.is_empty() {
		return Err(RunnerError::new("cannot estimate an empty task or model selection"));
	}

	let selected_cells = tasks
		.len()
		.checked_mul(models.len())
		.ok_or_else(|| RunnerError::new("selected cell count overflows"))?;
	let wall_budgets =
		tasks.iter().map(|task| task.budgets.wall_seconds).collect::<Option<Vec<_>>>();
	let (sum, critical_path) = wall_budgets
		.map(|budgets| bounded_capacity_metrics(&budgets, models.len(), jobs.min(selected_cells)))
		.transpose()?
		.map_or((None, None), |(sum, critical_path)| (Some(sum), Some(critical_path)));

	Ok(CapacityEstimate {
		schema_version: "aiq.capacity-estimate.v2".to_owned(),
		jobs,
		selected_cells,
		model_keys: models.iter().map(|model| model.key()).collect(),
		task_ids: tasks.iter().map(|task| task.task_id.clone()).collect(),
		declared_wall_budget_sum_seconds: sum,
		declared_wall_budget_critical_path_seconds: critical_path,
		feasibility_assessed: false,
	})
}

/// Builds a deterministic synthetic run without invoking Codex.
pub fn synthetic_demo<S>(slot: ScheduleSlot, artifact_sink: &S) -> Result<RunRecord, RunnerError>
where
	S: ArtifactSink,
{
	let scheduled_unix_ms = slot
		.scheduled_unix_ms()
		.map_err(|error| RunnerError::new(format!("synthetic schedule is invalid: {error}")))?;
	let tasks = synthetic_demo_tasks();
	let set_hash = task::task_set_hash(&tasks)?;
	let run_id = schedule::idempotent_run_id(&slot, &set_hash, &MODEL_MATRIX, AIQ_SCORING_VERSION)?;
	let mut results = Vec::with_capacity(tasks.len() * MODEL_MATRIX.len());

	for model in MODEL_MATRIX {
		for task in &tasks {
			let response =
				if (model.reasoning_effort as u8).is_multiple_of(2) { "OK" } else { "NOT OK" };
			let evaluation_result = task
				.evaluator
				.as_ref()
				.ok_or_else(|| RunnerError::new("synthetic task lacks its evaluator"))?
				.evaluate_checked(response, None)
				.map_err(|error| RunnerError::new(error.to_string()))?;
			let score = evaluation_result.score;
			let correct = score == 1.0;
			let mut result = TaskResult {
				schema_version: RESULT_SCHEMA_VERSION.to_owned(),
				result_id: String::new(),
				run_id: run_id.clone(),
				task_id: task.task_id.clone(),
				task_version: task.task_version.clone(),
				task_hash: task.content_hash()?,
				model,
				status: ResultStatus::Completed,
				evaluation: if correct {
					EvaluationOutcome::Correct
				} else {
					EvaluationOutcome::Incorrect
				},
				task_score: Some(score),
				response: Some(response.to_owned()),
				response_sha256: Some(format!(
					"sha256:{}",
					hex::encode(Sha256::digest(response.as_bytes()))
				)),
				evaluator_result_sha256: None,
				evaluator_stdout_sha256: None,
				artifacts: Vec::new(),
				failure: None,
				latency: Latency { wall_ms: 1, evaluator_ms: 0 },
				tool_usage: ToolUsage::default(),
				evaluator_checks: evaluation_result.checks,
				workspace_manifest: None,
				provenance: ResultProvenance {
					node_id: "node_synthetic_demo".to_owned(),
					runner_version: env!("CARGO_PKG_VERSION").to_owned(),
					codex_version: "synthetic-not-invoked".to_owned(),
					observed_at: "synthetic".to_owned(),
					synthetic: true,
					local_trust: TrustTier::Untrusted,
				},
			};

			result.bind_evaluator_result_digest()?;
			result.assign_result_id()?;
			results.push(result);
		}
	}

	let (_, evaluator_results_bytes) = build_evaluator_results_bundle(&results)?;
	let evaluator_results_artifact = artifact_sink
		.put("evaluator-results.json", &evaluator_results_bytes)
		.map_err(|error| RunnerError::new(error.to_string()))?;

	Ok(RunRecord {
		schema_version: RUN_SCHEMA_VERSION.to_owned(),
		run_id,
		schedule_slot: slot,
		task_set_hash: set_hash,
		scoring_version: AIQ_SCORING_VERSION.to_owned(),
		calibration_admission_digest: None,
		calibration_bank: None,
		execution_concurrency: Some(1),
		models: MODEL_MATRIX.to_vec(),
		started_unix_ms: scheduled_unix_ms,
		finished_unix_ms: scheduled_unix_ms,
		synthetic: true,
		capability_validation: None,
		provenance: None,
		evaluator_results_artifact,
		terminal_attempt_lineage: terminal_attempt_lineage(&results),
		results,
	})
}

/// Returns the ten public-safe synthetic example tasks, one per domain.
#[must_use]
pub fn synthetic_tasks() -> Vec<TaskDefinition> {
	synthetic_demo_tasks().into_iter().filter(|task| task.task_id.ends_with("-01")).collect()
}

/// Returns the frozen 72-task shape used by the model-free synthetic demo.
#[must_use]
pub fn synthetic_demo_tasks() -> Vec<TaskDefinition> {
	let catalog = serde_json::from_str::<SyntheticCatalog>(include_str!(
		"../../../benchmarks/candidates/aiq-core-1.0.7/catalog.json"
	))
	.expect("checked-in benchmark catalog must deserialize");
	let catalog_entry_digests = scoring::frozen_catalog_entry_digests()
		.expect("checked-in benchmark catalog entries must hash");

	catalog
		.tasks
		.into_iter()
		.map(|catalog_task| {
			let catalog_entry_digest = catalog_entry_digests
				.get(&(catalog_task.task_id.clone(), catalog_task.task_version.clone()))
				.cloned()
				.expect("every synthetic task must bind a frozen catalog entry");

			TaskDefinition {
				schema_version: TASK_SCHEMA_VERSION.to_owned(),
				title: format!("Synthetic {} demonstration task", catalog_task.task_id),
				task_id: catalog_task.task_id,
				task_version: catalog_task.task_version,
				domain: catalog_task.domain,
				difficulty: catalog_task.difficulty,
				prompt: "Synthetic task. No model invocation occurs.".to_owned(),
				allowed_tools: vec!["none".to_owned()],
				budgets: TaskBudgets {
					wall_seconds: Some(1),
					max_steps: Some(1),
					max_tool_calls: Some(0),
				},
				tags: vec!["synthetic".to_owned()],
				cluster_id: Some(catalog_task.cluster_id),
				catalog_entry_digest: Some(catalog_entry_digest),
				scorer_version: catalog_task.evaluator.scorer_version,
				leakage_notes: vec!["Generated only for local demonstration.".to_owned()],
				fixture_refs: vec!["repo://synthetic-fixture".to_owned()],
				visibility: Visibility::PublicExample,
				provenance: BTreeMap::from([(
					"source".to_owned(),
					Value::String("aiq-runner synthetic demo".to_owned()),
				)]),
				evaluator: Some(Evaluator::exact_match("OK", true)),
			}
		})
		.collect()
}

/// Recomputes normalized Codex tool evidence from complete `exec --json` output.
///
/// The verifier uses the same deterministic parser against the content-addressed
/// `stdout.jsonl` artifact. This prevents signed tool-use counters from becoming
/// an unaudited evaluator input.
pub fn parse_codex_tool_usage(stdout: &str) -> Result<ToolUsage, CodexItemPolicyError> {
	let mut accounting = CodexItemAccounting::default();
	let mut usage = ToolUsage::default();

	for line in stdout.lines() {
		let event = serde_json::from_str::<Value>(line).ok();

		if event.as_ref().and_then(|event| event.get("type")).and_then(Value::as_str)
			== Some("aiq.invocation-attempt.v1")
		{
			merge_codex_item_accounting(&mut usage, &accounting)?;

			accounting = CodexItemAccounting::default();

			continue;
		}

		if let Some(event) = event
			&& event.get("type").and_then(Value::as_str) == Some("turn.completed")
			&& let Some(provider) = event.get("usage").and_then(Value::as_object)
		{
			merge_provider_counter(&mut usage.provider_tokens.input, provider, "input_tokens");
			merge_provider_counter(
				&mut usage.provider_tokens.cached_input,
				provider,
				"cached_input_tokens",
			);
			merge_provider_counter(
				&mut usage.provider_tokens.cache_write_input,
				provider,
				"cache_write_input_tokens",
			);
			merge_provider_counter(&mut usage.provider_tokens.output, provider, "output_tokens");
			merge_provider_counter(
				&mut usage.provider_tokens.reasoning,
				provider,
				"reasoning_output_tokens",
			);
			merge_provider_counter(&mut usage.provider_tokens.total, provider, "total_tokens");
		}

		accounting.observe(line.as_bytes())?;
	}

	merge_codex_item_accounting(&mut usage, &accounting)?;

	Ok(usage)
}

/// Retains completed-command counts only for digests declared by the task's
/// external tool-evidence checks.
///
/// Total and per-tool call counts remain unfiltered, so an undeclared or extra
/// command still fails an exact evaluator gate without expanding the signed
/// package by an unbounded set of model-chosen identities.
pub fn project_completed_command_digests(task: &TaskDefinition, usage: &mut ToolUsage) {
	let Some(configuration) = task
		.evaluator
		.as_ref()
		.and_then(|evaluator| evaluator.external.as_ref())
		.map(|external| &external.configuration)
	else {
		usage.completed_command_sha256.clear();

		return;
	};
	let Some(checks) = configuration.get("checks").and_then(Value::as_array) else {
		usage.completed_command_sha256.clear();

		return;
	};
	let mut required = BTreeSet::new();

	for check in checks {
		let Some(check) = check.as_object() else {
			usage.completed_command_sha256.clear();

			return;
		};

		if check.get("type").and_then(Value::as_str) != Some("tool_evidence") {
			continue;
		}

		let Some(digests) = check.get("required_completed_command_sha256") else { continue };
		let Some(digests) = digests.as_object() else {
			usage.completed_command_sha256.clear();

			return;
		};

		for (digest, count) in digests {
			if !digest.strip_prefix("sha256:").is_some_and(|value| {
				value.len() == 64
					&& value
						.bytes()
						.all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
			}) || !count.as_u64().is_some_and(|count| (1..=u64::from(u32::MAX)).contains(&count))
			{
				usage.completed_command_sha256.clear();

				return;
			}

			required.insert(digest.clone());
		}
	}

	usage.completed_command_sha256.retain(|digest, _| required.contains(digest));
}

/// Executes a deterministic selected matrix through the normal local runner.
pub(crate) fn execute_selected_run<E, S, P>(
	adapter: &CodexAdapter<E, S>,
	workspace_provider: &P,
	manifest: &CapabilityManifest,
	tasks: &[TaskDefinition],
	validation: CapabilityValidationReport,
	commitments: RunCommitments,
	local: LocalRunExecution<'_>,
) -> Result<SelectedRun, RunnerError>
where
	E: Executor + Sync,
	S: ArtifactSink + Sync,
	P: TaskWorkspaceProvider + Sync,
{
	execute_selected_run_inner(
		adapter,
		workspace_provider,
		manifest,
		tasks,
		validation,
		commitments,
		local,
	)
}

pub(crate) fn build_evaluator_results_bundle(
	results: &[TaskResult],
) -> Result<(EvaluatorResultsBundle, Vec<u8>), RunnerError> {
	let evaluator_results = results
		.iter()
		.map(|result| {
			let evaluator_result = result.evaluator_result();

			if let Some(evaluator_result) = &evaluator_result {
				evaluator_result.validate_persisted().map_err(|error| {
					RunnerError::new(format!("task result evaluator evidence is invalid: {error}"))
				})?;
			}

			let digest = evaluator_result
				.as_ref()
				.map(protocol::canonical_hash)
				.transpose()
				.map_err(|error| RunnerError::new(error.to_string()))?;

			if digest != result.evaluator_result_sha256
				|| evaluator_result.is_some() != (result.status == ResultStatus::Completed)
			{
				return Err(RunnerError::new(
					"task result evaluator evidence is incomplete or does not match its digest",
				));
			}

			Ok(evaluator_result)
		})
		.collect::<Result<Vec<_>, RunnerError>>()?;
	let bundle = EvaluatorResultsBundle {
		schema_version: EVALUATOR_RESULTS_SCHEMA_VERSION.to_owned(),
		results: evaluator_results,
	};
	let bytes =
		protocol::canonical_json(&bundle).map_err(|error| RunnerError::new(error.to_string()))?;

	if bytes.len() > MAX_EVALUATOR_RESULTS_BUNDLE_BYTES {
		return Err(RunnerError::new(format!(
			"evaluator-results bundle is {} bytes; maximum is {MAX_EVALUATOR_RESULTS_BUNDLE_BYTES}",
			bytes.len()
		)));
	}

	Ok((bundle, bytes))
}

pub(crate) fn build_workspace_manifest(workspace: &Path) -> Result<WorkspaceManifest, RunnerError> {
	let canonical_root = fs::canonicalize(workspace)
		.map_err(|error| RunnerError::new(format!("candidate workspace unavailable: {error}")))?;
	let mut entries = Vec::new();
	let mut total_file_bytes = 0_u64;
	let mut total_path_bytes = 0_usize;

	collect_workspace_manifest_entries(
		&canonical_root,
		&canonical_root,
		&mut entries,
		0,
		&mut total_file_bytes,
		&mut total_path_bytes,
	)?;

	entries.sort_by(|left, right| left.path.cmp(&right.path));

	Ok(WorkspaceManifest { schema_version: "aiq.workspace-manifest.v1", entries })
}

fn deserialize_nonempty_completed_command_sha256<'de, D>(
	deserializer: D,
) -> Result<BTreeMap<String, u32>, D::Error>
where
	D: Deserializer<'de>,
{
	let values = BTreeMap::<String, u32>::deserialize(deserializer)?;

	if values.is_empty() {
		return Err(serde::de::Error::custom(
			"completed_command_sha256 must be omitted instead of empty",
		));
	}

	Ok(values)
}

fn retryable_invocation_result(result: &TaskResult) -> bool {
	result.status == ResultStatus::Failed
		&& result.failure.as_ref().is_some_and(|failure| {
			failure.retryable
				&& matches!(failure.kind, FailureKind::NonZeroExit | FailureKind::MissingResponse)
		})
}

fn append_invocation_attempt(
	stdout: &mut String,
	attempt_stdout: &str,
	marker: InvocationAttemptMarker,
) -> Result<(), RunnerError> {
	let marker =
		serde_json::to_string(&marker).map_err(|error| RunnerError::new(error.to_string()))?;
	let separator_bytes = usize::from(!stdout.is_empty() && !stdout.ends_with('\n'))
		+ usize::from(!attempt_stdout.is_empty() && !attempt_stdout.ends_with('\n'));
	let additional = attempt_stdout
		.len()
		.checked_add(marker.len())
		.and_then(|bytes| bytes.checked_add(separator_bytes + 1))
		.ok_or_else(|| RunnerError::new("retryable invocation evidence size overflowed"))?;

	if stdout.len().saturating_add(additional) > MAX_RETRY_STDOUT_BYTES {
		return Err(RunnerError::new(
			"retryable invocation evidence exceeds the hard output limit",
		));
	}
	if !stdout.is_empty() && !stdout.ends_with('\n') {
		stdout.push('\n');
	}

	stdout.push_str(attempt_stdout);

	if !attempt_stdout.is_empty() && !attempt_stdout.ends_with('\n') {
		stdout.push('\n');
	}

	stdout.push_str(&marker);
	stdout.push('\n');

	Ok(())
}

fn merge_codex_item_accounting(
	usage: &mut ToolUsage,
	accounting: &CodexItemAccounting,
) -> Result<(), CodexItemPolicyError> {
	accounting.finish()?;

	usage.steps = usage.steps.saturating_add(accounting.steps);
	usage.total_calls = usage.total_calls.saturating_add(accounting.tool_calls);

	for (tool, calls) in &accounting.by_tool {
		let total = usage.by_tool.entry(tool.clone()).or_default();

		*total = total.saturating_add(*calls);
	}
	for (digest, calls) in &accounting.completed_command_sha256 {
		let total = usage.completed_command_sha256.entry(digest.clone()).or_default();

		*total = total.saturating_add(*calls);
	}

	Ok(())
}

fn accumulate_terminal_attempt_lineage(
	lineage: &mut Vec<TerminalAttemptLineage>,
	results: &[TaskResult],
) -> Result<(), RunnerError> {
	for candidate in terminal_attempt_lineage(results) {
		if candidate.terminal_result_ids.len() != 1 {
			return Err(RunnerError::new("multiple terminal observations cannot be committed"));
		}

		if let Some(existing) = lineage.iter().find(|entry| {
			entry.task_id == candidate.task_id
				&& entry.task_version == candidate.task_version
				&& entry.model == candidate.model
		}) {
			if existing != &candidate {
				return Err(RunnerError::new(
					"a committed terminal observation cannot be replaced",
				));
			}
		} else {
			lineage.push(candidate);
		}
	}

	lineage.sort_by(|left, right| {
		(&left.task_id, &left.task_version, left.model).cmp(&(
			&right.task_id,
			&right.task_version,
			right.model,
		))
	});

	validate_terminal_attempt_lineage(results, lineage)
		.map_err(|error| RunnerError::new(error.to_string()))
}

fn bounded_capacity_metrics(
	budgets: &[u64],
	model_count: usize,
	worker_count: usize,
) -> Result<(u64, u64), RunnerError> {
	let mut worker_loads = vec![0_u64; worker_count];
	let mut sum = 0_u64;

	for _model in 0..model_count {
		for budget in budgets {
			sum = sum
				.checked_add(*budget)
				.ok_or_else(|| RunnerError::new("declared wall budget sum overflows"))?;

			let worker = worker_loads
				.iter()
				.enumerate()
				.min_by_key(|(index, load)| (**load, *index))
				.map(|(index, _)| index)
				.ok_or_else(|| RunnerError::new("capacity schedule has no worker"))?;

			worker_loads[worker] = worker_loads[worker]
				.checked_add(*budget)
				.ok_or_else(|| RunnerError::new("declared worker wall budget overflows"))?;
		}
	}

	Ok((sum, worker_loads.into_iter().max().unwrap_or(0)))
}

fn retained_stdout_tool_usage(
	stdout: &str,
	artifacts: &[ArtifactReference],
	task: &TaskDefinition,
) -> ToolUsage {
	let mut usage = if artifacts.iter().any(|artifact| artifact.kind == "stdout.jsonl") {
		// A policy-invalid failed attempt retains command-redacted stdout for verifier rejection;
		// its counters cannot be used as trusted evidence in the local result.
		parse_codex_tool_usage(stdout).unwrap_or_default()
	} else {
		ToolUsage::default()
	};

	project_completed_command_digests(task, &mut usage);

	usage
}

fn task_major_execution_order(
	task_count: usize,
	model_count: usize,
) -> impl Iterator<Item = (usize, usize)> {
	(0..task_count).flat_map(move |task_index| {
		(0..model_count).map(move |model_index| (task_index, model_index))
	})
}

fn merge_provider_counter(accumulator: &mut Option<u64>, usage: &Map<String, Value>, field: &str) {
	let Some(observed) = usage.get(field).and_then(Value::as_u64) else {
		return;
	};

	*accumulator = match *accumulator {
		Some(current) => Some(current.saturating_add(observed)),
		None => Some(observed),
	};
}

fn execute_selected_run_inner<E, S, P>(
	adapter: &CodexAdapter<E, S>,
	workspace_provider: &P,
	manifest: &CapabilityManifest,
	tasks: &[TaskDefinition],
	validation: CapabilityValidationReport,
	commitments: RunCommitments,
	local: LocalRunExecution<'_>,
) -> Result<SelectedRun, RunnerError>
where
	E: Executor + Sync,
	S: ArtifactSink + Sync,
	P: TaskWorkspaceProvider + Sync,
{
	validate_jobs(local.jobs)?;

	let models = commitments.models.clone();
	let slot = commitments.schedule_slot.clone();
	let observed_at = commitments.observed_at.clone();
	let (evaluator_root, evaluator_runtime) =
		local.evaluator.map_or((None, None), |(root, runtime)| (Some(root), Some(runtime)));

	if tasks.is_empty() || models.is_empty() {
		return Err(RunnerError::new("cannot run an empty task or model selection"));
	}

	validate_selected_run_commitments(
		manifest,
		tasks,
		&models,
		&slot,
		&validation,
		&commitments,
		local.jobs,
	)?;

	let pair_indexes = models
		.iter()
		.enumerate()
		.flat_map(|(model_index, model)| {
			tasks.iter().enumerate().map(move |(task_index, task)| {
				((*model, task.task_id.clone()), model_index * tasks.len() + task_index)
			})
		})
		.collect::<BTreeMap<_, _>>();
	let expected_tasks = tasks
		.iter()
		.map(|task| Ok((task.task_id.as_str(), (task.task_version.as_str(), task.content_hash()?))))
		.collect::<Result<BTreeMap<_, _>, ProtocolError>>()?;
	let expected_codex_version =
		validation.cli_probe.version.as_deref().unwrap_or(manifest.codex_version.as_str());
	let mut checkpoint = RunCheckpoint::load(local.checkpoint_path, &commitments)
		.map_err(|error| RunnerError::new(error.to_string()))?
		.unwrap_or_else(|| RunCheckpoint::new(commitments.clone(), unix_ms()));
	let mut committed = restore_checkpoint_results(
		&checkpoint,
		&pair_indexes,
		&expected_tasks,
		&validation,
		&commitments,
		expected_codex_version,
	)?;
	let codex_version =
		validation.cli_probe.version.clone().unwrap_or_else(|| manifest.codex_version.clone());
	let execution = SelectedRunExecution {
		adapter,
		workspace_provider,
		manifest,
		tasks,
		models: &models,
		observed_at: &observed_at,
		validation: &validation,
		commitments: &commitments,
		evaluator_root,
		evaluator_runtime,
		checkpoint_path: local.checkpoint_path,
		jobs: local.jobs,
		codex_version: &codex_version,
	};

	execution.complete_pending(&mut checkpoint, &mut committed)?;

	if committed.len() != pair_indexes.len() {
		return Err(RunnerError::new(
			"runner infrastructure stopped before every selected cell committed",
		));
	}

	checkpoint.subscription_backpressure = None;

	execution.persist_checkpoint(&mut checkpoint, &committed)?;

	checkpoint.results = committed.into_values().collect();

	accumulate_terminal_attempt_lineage(
		&mut checkpoint.terminal_attempt_lineage,
		&checkpoint.results,
	)?;

	checkpoint.evaluator_results =
		checkpoint.results.iter().map(TaskResult::evaluator_result).collect();

	let (_, evaluator_results_bytes) = build_evaluator_results_bundle(&checkpoint.results)?;
	let evaluator_results_artifact = execution
		.adapter
		.store_artifact("evaluator-results.json", &evaluator_results_bytes)
		.map_err(|error| RunnerError::new(error.to_string()))?;

	Ok(selected_run_record(
		tasks,
		&models,
		slot,
		validation,
		commitments,
		checkpoint,
		evaluator_results_artifact,
		local.jobs,
	))
}

fn validate_selected_run_commitments(
	manifest: &CapabilityManifest,
	tasks: &[TaskDefinition],
	models: &[ModelConfig],
	slot: &ScheduleSlot,
	validation: &CapabilityValidationReport,
	commitments: &RunCommitments,
	jobs: usize,
) -> Result<(), RunnerError> {
	let expected_run_id = resume::classified_run_id(
		slot,
		&commitments.task_set_hash,
		&commitments.provenance.corpus_commitment_sha256,
		models,
		commitments.run_class,
	)
	.map_err(|error| RunnerError::new(error.to_string()))?;

	if manifest.node_id != validation.node_id
		|| commitments.models != models
		|| commitments.schedule_slot != *slot
		|| commitments.task_set_hash != task::task_set_hash(tasks)?
		|| commitments.run_id != expected_run_id
		|| commitments.scoring_version != AIQ_SCORING_VERSION
		|| commitments.preflight_digest != protocol::canonical_hash(&validation)?
		|| commitments.provenance.catalog_digest != commitments.catalog_digest
		|| commitments.provenance.task_set_digest != commitments.task_set_hash
		|| commitments.provenance.evaluator_digest != commitments.evaluator_digest
		|| commitments.provenance.runtime_digest != commitments.runtime_digest
		|| commitments.provenance.preflight_digest != commitments.preflight_digest
		|| commitments.provenance.run_class != commitments.run_class
		|| commitments.provenance.permission_evidence_digest
			!= commitments.permission_evidence_digest
		|| !run_class_shape_matches(tasks, models, commitments.run_class)
	{
		return Err(RunnerError::new(
			"selected run commitments do not match the requested execution",
		));
	}

	let capability_validation_digest = protocol::canonical_hash(&validation)?;
	let available_models = validation
		.models
		.iter()
		.filter(|entry| entry.status == CapabilityValidationStatus::Available)
		.map(|entry| entry.model)
		.collect::<Vec<_>>();
	let unsupported_models = validation
		.models
		.iter()
		.filter(|entry| entry.status == CapabilityValidationStatus::Unsupported)
		.map(|entry| entry.model)
		.collect::<Vec<_>>();
	let expected_capacity = capacity::assess_capacity(
		tasks,
		models,
		&available_models,
		&unsupported_models,
		&capability_validation_digest,
		jobs,
		commitments.capacity.seconds_until_next_slot,
	)
	.map_err(|error| RunnerError::new(error.to_string()))?
	.commitment()
	.map_err(|error| RunnerError::new(error.to_string()))?;

	if commitments.capacity != expected_capacity {
		return Err(RunnerError::new(
			"capacity commitment does not match active capability support",
		));
	}

	Ok(())
}

fn aborts_paid_run(result: &TaskResult) -> bool {
	result.failure.as_ref().is_some_and(|failure| {
		matches!(failure.kind, FailureKind::Authentication | FailureKind::WorkspaceIntegrity)
	})
}

fn subscription_limit_result(result: &TaskResult) -> bool {
	result.status == ResultStatus::Failed
		&& result.evaluation == EvaluationOutcome::NotEvaluated
		&& result.failure.as_ref().is_some_and(|failure| {
			failure.kind == FailureKind::SubscriptionLimit
				&& failure.retryable
				&& result.task_score.is_none()
				&& result.response.is_none()
				&& result.response_sha256.is_none()
				&& result.evaluator_result_sha256.is_none()
				&& result.evaluator_stdout_sha256.is_none()
		})
}

fn retryable_evaluator_result(result: &TaskResult) -> bool {
	result.status == ResultStatus::Failed
		&& result.evaluation == EvaluationOutcome::NotEvaluated
		&& result.task_score.is_none()
		&& result.response.is_some()
		&& result.response_sha256.is_some()
		&& result.evaluator_result_sha256.is_none()
		&& result.evaluator_stdout_sha256.is_none()
		&& result.evaluator_checks.is_empty()
		&& result.workspace_manifest.is_some()
		&& result.failure.as_ref().is_some_and(|failure| {
			failure.kind == FailureKind::EvaluatorFailure && failure.retryable
		})
}

fn retryable_evaluator_error(result: &TaskResult) -> RunnerError {
	RunnerError::new(format!(
		"retryable evaluator failure retained pending evidence for {} / {}; model output remains unchanged",
		result.model.key(),
		result.task_id,
	))
}

fn reject_inline_evaluator_checks<'de, D>(_deserializer: D) -> Result<Vec<EvaluatorCheck>, D::Error>
where
	D: Deserializer<'de>,
{
	Err(serde::de::Error::custom(
		"evaluator_checks must be stored in the evaluator-results artifact",
	))
}

fn deserialize_required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
	D: Deserializer<'de>,
	T: Deserialize<'de>,
{
	Option::<T>::deserialize(deserializer)
}

fn run_class_shape_matches(
	tasks: &[TaskDefinition],
	models: &[ModelConfig],
	run_class: RunClass,
) -> bool {
	match run_class {
		RunClass::Calibration => true,
		RunClass::Official => {
			tasks.len() == OFFICIAL_TASK_COUNT
				&& tasks.iter().map(|task| &task.task_id).collect::<BTreeSet<_>>().len()
					== OFFICIAL_TASK_COUNT
				&& models == MODEL_MATRIX
		},
	}
}

fn quarantine_interrupted_workspace(
	execution_root: &Path,
	run_id: &str,
	model: ModelConfig,
	task: &TaskDefinition,
	destination: &Path,
) -> Result<(), WorkspaceError> {
	let quarantine_parent = execution_root.join(".quarantine").join(run_id).join(model.key());

	fs::create_dir_all(&quarantine_parent).map_err(|error| {
		WorkspaceError::new(format!("cannot create interrupted-workspace quarantine: {error}"))
	})?;

	let canonical_parent = fs::canonicalize(&quarantine_parent).map_err(|error| {
		WorkspaceError::new(format!("cannot resolve interrupted-workspace quarantine: {error}"))
	})?;

	if !canonical_parent.starts_with(execution_root) {
		return Err(WorkspaceError::new(
			"interrupted-workspace quarantine escapes the controlled root",
		));
	}

	let nonce =
		SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |duration| duration.as_nanos());
	let quarantine = canonical_parent.join(format!("{}-{}-{nonce}", task.task_id, process::id()));

	fs::rename(destination, &quarantine).map_err(|error| {
		WorkspaceError::new(format!(
			"dirty partial task workspace was rejected, but quarantine failed: {error}"
		))
	})
}

fn canonical_directory(path: &Path, label: &str) -> Result<PathBuf, WorkspaceError> {
	let metadata = fs::symlink_metadata(path)
		.map_err(|error| WorkspaceError::new(format!("{label} unavailable: {error}")))?;

	if metadata.file_type().is_symlink() || !metadata.is_dir() {
		return Err(WorkspaceError::new(format!("{label} must be a regular directory")));
	}

	fs::canonicalize(path)
		.map_err(|error| WorkspaceError::new(format!("{label} unavailable: {error}")))
}

fn prepare_execution_root(path: &Path) -> Result<PathBuf, WorkspaceError> {
	if let Ok(metadata) = fs::symlink_metadata(path)
		&& metadata.file_type().is_symlink()
	{
		return Err(WorkspaceError::new("workspace execution root must not be a symbolic link"));
	}

	fs::create_dir_all(path).map_err(|error| {
		WorkspaceError::new(format!("workspace execution root unavailable: {error}"))
	})?;

	canonical_directory(path, "workspace execution root")
}

fn safe_path_component(value: &str) -> bool {
	if value.is_empty()
		|| value.len() > 255
		|| value == "."
		|| value == ".."
		|| value.ends_with('.')
		|| !value
			.bytes()
			.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
	{
		return false;
	}

	let stem = value.split('.').next().unwrap_or(value).to_ascii_uppercase();

	!matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
		&& !matches!(stem.as_bytes(), [b'C', b'O', b'M', b'1'..=b'9'])
		&& !matches!(stem.as_bytes(), [b'L', b'P', b'T', b'1'..=b'9'])
}

fn validate_portable_sibling_names(entries: &[DirEntry]) -> Result<(), RunnerError> {
	let mut folded_names = BTreeSet::new();

	for entry in entries {
		let name = entry
			.file_name()
			.to_str()
			.filter(|value| safe_path_component(value))
			.ok_or_else(|| RunnerError::new("workspace path component is not portable"))?
			.to_ascii_lowercase();

		if !folded_names.insert(name) {
			return Err(RunnerError::new("workspace contains case-insensitive path aliases"));
		}
	}

	Ok(())
}

fn copy_workspace_tree(source: &Path, destination: &Path) -> Result<(), WorkspaceError> {
	let metadata = fs::symlink_metadata(source).map_err(|error| {
		WorkspaceError::new(format!("cannot inspect workspace baseline: {error}"))
	})?;

	if metadata.file_type().is_symlink() || !metadata.is_dir() {
		return Err(WorkspaceError::new("workspace baseline must be a regular directory"));
	}
	if fs::symlink_metadata(destination).is_ok() {
		return Err(WorkspaceError::new("workspace destination must not already exist"));
	}

	fs::create_dir(destination).map_err(|error| {
		WorkspaceError::new(format!("cannot create fresh workspace directory: {error}"))
	})?;

	let mut budget = WorkspaceCopyBudget::default();
	let result = copy_workspace_directory_contents(source, destination, 0, 0, &mut budget);

	if let Err(error) = result {
		let cleanup = remove_workspace_tree_if_present(destination);

		return match cleanup {
			Ok(()) => Err(error),
			Err(cleanup) => Err(WorkspaceError::new(format!(
				"{error}; partial workspace cleanup failed: {cleanup}"
			))),
		};
	}

	Ok(())
}

fn copy_workspace_contents(source: &Path, destination: &Path) -> Result<(), WorkspaceError> {
	for (path, label) in [(source, "source"), (destination, "destination")] {
		let metadata = fs::symlink_metadata(path).map_err(|error| {
			WorkspaceError::new(format!("cannot inspect workspace copy {label}: {error}"))
		})?;

		if metadata.file_type().is_symlink() || !metadata.is_dir() {
			return Err(WorkspaceError::new(format!(
				"workspace copy {label} must be a regular directory"
			)));
		}
	}

	copy_workspace_directory_contents(
		source,
		destination,
		0,
		0,
		&mut WorkspaceCopyBudget::default(),
	)
}

fn copy_workspace_directory_contents(
	source: &Path,
	destination: &Path,
	directory_depth: usize,
	parent_path_bytes: usize,
	budget: &mut WorkspaceCopyBudget,
) -> Result<(), WorkspaceError> {
	if directory_depth > MAX_WORKSPACE_DEPTH {
		return Err(WorkspaceError::new("workspace copy exceeds the directory depth limit"));
	}

	let remaining_entries = MAX_WORKSPACE_ENTRIES.saturating_sub(budget.entries);
	let mut entries = fs::read_dir(source)
		.map_err(|error| WorkspaceError::new(format!("cannot read workspace source: {error}")))?
		.take(remaining_entries.saturating_add(1))
		.collect::<Result<Vec<_>, _>>()
		.map_err(|error| WorkspaceError::new(format!("cannot read workspace source: {error}")))?;

	if entries.len() > remaining_entries {
		return Err(WorkspaceError::new("workspace copy exceeds the entry limit"));
	}

	entries.sort_by_key(DirEntry::file_name);

	validate_portable_sibling_names(&entries)
		.map_err(|error| WorkspaceError::new(error.to_string()))?;

	for entry in entries {
		let name = entry
			.file_name()
			.to_str()
			.filter(|value| safe_path_component(value))
			.ok_or_else(|| WorkspaceError::new("workspace copy path is not portable"))?
			.to_owned();
		let path_bytes = parent_path_bytes
			.checked_add(usize::from(parent_path_bytes != 0))
			.and_then(|bytes| bytes.checked_add(name.len()))
			.ok_or_else(|| WorkspaceError::new("workspace copy path length overflow"))?;

		budget.entries = budget
			.entries
			.checked_add(1)
			.filter(|entries| *entries <= MAX_WORKSPACE_ENTRIES)
			.ok_or_else(|| WorkspaceError::new("workspace copy exceeds the entry limit"))?;
		budget.path_bytes = budget
			.path_bytes
			.checked_add(path_bytes)
			.filter(|bytes| *bytes <= MAX_WORKSPACE_PATH_BYTES)
			.ok_or_else(|| WorkspaceError::new("workspace copy exceeds the path-byte limit"))?;

		copy_workspace_entry(
			&entry.path(),
			&destination.join(&name),
			directory_depth.saturating_add(1),
			path_bytes,
			budget,
		)?;
	}

	Ok(())
}

fn copy_workspace_entry(
	source: &Path,
	destination: &Path,
	path_depth: usize,
	path_bytes: usize,
	budget: &mut WorkspaceCopyBudget,
) -> Result<(), WorkspaceError> {
	let metadata = fs::symlink_metadata(source).map_err(|error| {
		WorkspaceError::new(format!("cannot inspect workspace source: {error}"))
	})?;

	if metadata.file_type().is_symlink() {
		return Err(WorkspaceError::new("workspace source contains a symbolic link"));
	}
	if metadata.is_file() {
		if path_depth > MAX_WORKSPACE_DEPTH.saturating_add(1) {
			return Err(WorkspaceError::new("workspace copy exceeds the directory depth limit"));
		}

		let remaining_bytes =
			MAX_WORKSPACE_RAW_BYTES.checked_sub(budget.raw_bytes).ok_or_else(|| {
				WorkspaceError::new("workspace copy exceeds the total raw-byte limit")
			})?;
		let bytes = read_workspace_file_bounded(source, remaining_bytes)
			.map_err(|error| WorkspaceError::new(error.to_string()))?;
		let byte_count = u64::try_from(bytes.len()).unwrap_or(u64::MAX);

		budget.raw_bytes = budget.raw_bytes.checked_add(byte_count).ok_or_else(|| {
			WorkspaceError::new("workspace copy exceeds the total raw-byte limit")
		})?;

		let mut options = OpenOptions::new();

		options.write(true).create_new(true);

		#[cfg(unix)]
		std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);

		let mut file = options.open(destination).map_err(|error| {
			WorkspaceError::new(format!("cannot create workspace destination file: {error}"))
		})?;

		file.write_all(&bytes).and_then(|()| file.sync_all()).map_err(|error| {
			WorkspaceError::new(format!("cannot write workspace destination file: {error}"))
		})?;

		fs::set_permissions(destination, metadata.permissions()).map_err(|error| {
			WorkspaceError::new(format!("cannot preserve workspace file permissions: {error}"))
		})?;

		return Ok(());
	}
	if !metadata.is_dir() {
		return Err(WorkspaceError::new("workspace source contains a special file"));
	}
	if path_depth > MAX_WORKSPACE_DEPTH {
		return Err(WorkspaceError::new("workspace copy exceeds the directory depth limit"));
	}

	fs::create_dir(destination).map_err(|error| {
		WorkspaceError::new(format!("cannot create workspace destination directory: {error}"))
	})?;

	copy_workspace_directory_contents(source, destination, path_depth, path_bytes, budget)?;

	Ok(())
}

fn restrict_workspace_tree(path: &Path) -> Result<(), WorkspaceError> {
	let metadata = fs::symlink_metadata(path).map_err(|error| {
		WorkspaceError::new(format!("cannot inspect sealed workspace entry: {error}"))
	})?;

	if metadata.file_type().is_symlink() {
		return Err(WorkspaceError::new("sealed workspace contains a symbolic link"));
	}
	if metadata.is_file() {
		return restrict_workspace_permissions(path, false);
	}
	if !metadata.is_dir() {
		return Err(WorkspaceError::new("sealed workspace contains a special file"));
	}

	restrict_workspace_permissions(path, true)?;

	let mut entries = fs::read_dir(path)
		.map_err(|error| {
			WorkspaceError::new(format!("cannot read sealed workspace directory: {error}"))
		})?
		.collect::<Result<Vec<_>, _>>()
		.map_err(|error| {
			WorkspaceError::new(format!("cannot read sealed workspace directory: {error}"))
		})?;

	entries.sort_by_key(DirEntry::file_name);

	for entry in entries {
		restrict_workspace_tree(&entry.path())?;
	}

	Ok(())
}

fn restrict_workspace_permissions(path: &Path, directory: bool) -> Result<(), WorkspaceError> {
	#[cfg(unix)]
	{
		let metadata = fs::symlink_metadata(path).map_err(|error| {
			WorkspaceError::new(format!("cannot inspect sealed workspace permissions: {error}"))
		})?;
		let executable = !directory && metadata.permissions().mode() & 0o100 != 0;
		let mode = if directory || executable { 0o700 } else { 0o600 };

		fs::set_permissions(path, Permissions::from_mode(mode)).map_err(|error| {
			WorkspaceError::new(format!("cannot restrict sealed workspace permissions: {error}"))
		})?;
	}

	#[cfg(not(unix))]
	let _ = (path, directory);

	Ok(())
}

fn remove_workspace_tree_if_present(path: &Path) -> Result<(), WorkspaceError> {
	let metadata = match fs::symlink_metadata(path) {
		Ok(metadata) => metadata,
		Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
		Err(error) => {
			return Err(WorkspaceError::new(format!("cannot inspect partial workspace: {error}")));
		},
	};

	if metadata.file_type().is_symlink() || !metadata.is_dir() {
		return Err(WorkspaceError::new(
			"partial workspace cleanup target is not a regular directory",
		));
	}

	fs::remove_dir_all(path)
		.map_err(|error| WorkspaceError::new(format!("cannot remove partial workspace: {error}")))
}

fn remove_sealed_workspace(path: &Path) -> Result<(), WorkspaceError> {
	let metadata = fs::symlink_metadata(path).map_err(|error| {
		WorkspaceError::new(format!("cannot inspect sealed candidate workspace: {error}"))
	})?;

	if metadata.file_type().is_symlink() || !metadata.is_dir() {
		return Err(WorkspaceError::new(
			"sealed candidate workspace cleanup target is not a regular directory",
		));
	}

	fs::remove_dir_all(path).map_err(|error| {
		WorkspaceError::new(format!("cannot remove sealed candidate workspace: {error}"))
	})
}

fn verify_sealed_workspace_unchanged(
	workspace: &Path,
	expected_manifest_sha256: &str,
) -> Result<(), RunnerError> {
	let manifest = build_workspace_manifest(workspace)?;
	let observed = protocol::canonical_hash(&manifest)?;

	if observed != expected_manifest_sha256 {
		return Err(RunnerError::new("sealed candidate workspace changed during evaluation"));
	}

	Ok(())
}

#[allow(clippy::too_many_arguments)]
fn finish_sealed_task_result(
	manifest: &CapabilityManifest,
	task: &TaskDefinition,
	model: ModelConfig,
	run_id: &str,
	codex_version: &str,
	observed_at: &str,
	result: Result<TaskResult, RunnerError>,
	sealed_workspace: SealedWorkspace,
	sealed_manifest_sha256: &str,
	invocation_evidence: &InvocationEvidence,
) -> Result<TaskResult, RunnerError> {
	let integrity =
		verify_sealed_workspace_unchanged(sealed_workspace.path(), sealed_manifest_sha256);
	let cleanup = sealed_workspace.cleanup();

	match (integrity, cleanup) {
		(Ok(()), Ok(())) => result,
		(Err(_), _) => workspace_integrity_result(
			manifest,
			task,
			model,
			run_id,
			codex_version,
			observed_at,
			invocation_evidence,
			result.ok(),
			WorkspaceIntegrityFailure::PostEvaluationIntegrity,
		),
		(Ok(()), Err(_)) => workspace_integrity_result(
			manifest,
			task,
			model,
			run_id,
			codex_version,
			observed_at,
			invocation_evidence,
			result.ok(),
			WorkspaceIntegrityFailure::PostEvaluationCleanup,
		),
	}
}

fn ensure_execution_directory(path: &Path) -> Result<(), WorkspaceError> {
	match fs::symlink_metadata(path) {
		Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
			Err(WorkspaceError::new("task execution path contains a symlink or non-directory"))
		},
		Ok(_) => Ok(()),
		Err(error) if error.kind() == ErrorKind::NotFound => match fs::create_dir(path) {
			Ok(()) => Ok(()),
			Err(error) if error.kind() == ErrorKind::AlreadyExists => {
				match fs::symlink_metadata(path) {
					Ok(metadata) if !metadata.file_type().is_symlink() && metadata.is_dir() => {
						Ok(())
					},
					Ok(_) => Err(WorkspaceError::new(
						"task execution path contains a symlink or non-directory",
					)),
					Err(error) => Err(WorkspaceError::new(format!(
						"cannot inspect concurrently created task execution directory: {error}"
					))),
				}
			},
			Err(error) => {
				Err(WorkspaceError::new(format!("cannot create task execution directory: {error}")))
			},
		},
		Err(error) => {
			Err(WorkspaceError::new(format!("cannot inspect task execution directory: {error}")))
		},
	}
}

fn retain_workspace_evidence<E, S>(
	adapter: &CodexAdapter<E, S>,
	workspace: &Path,
) -> Result<(ArtifactReference, ArtifactReference), RunnerError>
where
	E: Executor,
	S: ArtifactSink,
{
	let manifest = build_workspace_manifest(workspace)?;
	let snapshot = build_workspace_snapshot(workspace, &manifest)?;

	if build_workspace_manifest(workspace)? != manifest {
		return Err(RunnerError::new(
			"candidate workspace changed while replay evidence was captured",
		));
	}

	let manifest_bytes = protocol::canonical_json(&manifest)?;
	let snapshot_bytes = protocol::canonical_json(&snapshot)?;

	if manifest_bytes.len() > MAX_WORKSPACE_SNAPSHOT_BYTES
		|| snapshot_bytes.len() > MAX_WORKSPACE_SNAPSHOT_BYTES
	{
		return Err(RunnerError::new(
			"candidate workspace replay evidence exceeds the retained artifact limit",
		));
	}

	let manifest_reference = adapter
		.store_artifact("workspace-manifest.json", &manifest_bytes)
		.map_err(|error| RunnerError::new(error.to_string()))?;
	let snapshot_reference = adapter
		.store_artifact("workspace-snapshot.json", &snapshot_bytes)
		.map_err(|error| RunnerError::new(error.to_string()))?;

	Ok((manifest_reference, snapshot_reference))
}

fn read_workspace_file_bounded(path: &Path, max_bytes: u64) -> Result<Vec<u8>, RunnerError> {
	let mut options = OpenOptions::new();

	options.read(true);

	#[cfg(unix)]
	std::os::unix::fs::OpenOptionsExt::custom_flags(&mut options, O_NOFOLLOW);
	#[cfg(windows)]
	std::os::windows::fs::OpenOptionsExt::custom_flags(
		&mut options,
		FileSystem::FILE_FLAG_OPEN_REPARSE_POINT,
	);

	let file = options.open(path).map_err(|error| {
		RunnerError::new(format!("cannot open candidate workspace file: {error}"))
	})?;
	let metadata = file.metadata().map_err(|error| {
		RunnerError::new(format!("cannot inspect open candidate workspace file: {error}"))
	})?;

	if !metadata.is_file() {
		return Err(RunnerError::new("candidate workspace entry is not a regular file"));
	}
	if metadata.len() > max_bytes {
		return Err(RunnerError::new("candidate workspace file exceeds the byte limit"));
	}

	let read_limit = max_bytes.saturating_add(1);
	let mut bytes = Vec::new();

	file.take(read_limit).read_to_end(&mut bytes).map_err(|error| {
		RunnerError::new(format!("cannot read candidate workspace file: {error}"))
	})?;

	if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > max_bytes {
		return Err(RunnerError::new("candidate workspace file exceeds the byte limit"));
	}

	let path_metadata = fs::symlink_metadata(path).map_err(|error| {
		RunnerError::new(format!("cannot re-inspect candidate workspace file: {error}"))
	})?;

	if path_metadata.file_type().is_symlink()
		|| !path_metadata.is_file()
		|| path_metadata.len() != u64::try_from(bytes.len()).unwrap_or(u64::MAX)
	{
		return Err(RunnerError::new("candidate workspace file changed while it was read"));
	}

	Ok(bytes)
}

fn collect_workspace_manifest_entries(
	root: &Path,
	directory: &Path,
	entries: &mut Vec<WorkspaceManifestEntry>,
	depth: usize,
	total_file_bytes: &mut u64,
	total_path_bytes: &mut usize,
) -> Result<(), RunnerError> {
	if depth > MAX_WORKSPACE_DEPTH {
		return Err(RunnerError::new("candidate workspace exceeds the directory depth limit"));
	}

	let remaining_entries = MAX_WORKSPACE_ENTRIES.saturating_sub(entries.len());
	let mut children = fs::read_dir(directory)
		.map_err(|error| RunnerError::new(format!("cannot read candidate workspace: {error}")))?
		.take(remaining_entries.saturating_add(1))
		.collect::<Result<Vec<_>, _>>()
		.map_err(|error| RunnerError::new(format!("cannot read candidate workspace: {error}")))?;

	if children.len() > remaining_entries {
		return Err(RunnerError::new("candidate workspace exceeds the entry limit"));
	}

	children.sort_by_key(DirEntry::file_name);

	validate_portable_sibling_names(&children)?;

	for child in children {
		let path = child.path();
		let metadata = fs::symlink_metadata(&path).map_err(|error| {
			RunnerError::new(format!("cannot inspect candidate workspace entry: {error}"))
		})?;
		let relative = path.strip_prefix(root).map_err(|_| {
			RunnerError::new("candidate workspace entry escapes the canonical workspace root")
		})?;
		let relative = relative
			.components()
			.map(|component| {
				component
					.as_os_str()
					.to_str()
					.ok_or_else(|| RunnerError::new("candidate workspace path is not valid UTF-8"))
			})
			.collect::<Result<Vec<_>, _>>()?
			.join("/");

		if !safe_workspace_relative_path(&relative) {
			return Err(RunnerError::new(
				"candidate workspace path does not match the replay path grammar",
			));
		}

		*total_path_bytes = total_path_bytes
			.checked_add(relative.len())
			.filter(|bytes| *bytes <= MAX_WORKSPACE_PATH_BYTES)
			.ok_or_else(|| RunnerError::new("candidate workspace exceeds the path-byte limit"))?;

		if metadata.file_type().is_symlink() {
			return Err(RunnerError::new("candidate workspace contains a symbolic link"));
		}
		if metadata.is_dir() {
			entries.push(WorkspaceManifestEntry {
				path: relative,
				kind: "directory",
				bytes: None,
				sha256: None,
			});

			collect_workspace_manifest_entries(
				root,
				&path,
				entries,
				depth.saturating_add(1),
				total_file_bytes,
				total_path_bytes,
			)?;
		} else if metadata.is_file() {
			let remaining_bytes =
				MAX_WORKSPACE_RAW_BYTES.checked_sub(*total_file_bytes).ok_or_else(|| {
					RunnerError::new("candidate workspace exceeds the total raw-byte limit")
				})?;
			let bytes = read_workspace_file_bounded(&path, remaining_bytes)?;
			let byte_count = u64::try_from(bytes.len()).unwrap_or(u64::MAX);

			*total_file_bytes = total_file_bytes.checked_add(byte_count).ok_or_else(|| {
				RunnerError::new("candidate workspace exceeds the total raw-byte limit")
			})?;

			entries.push(WorkspaceManifestEntry {
				path: relative,
				kind: "file",
				bytes: Some(byte_count),
				sha256: Some(format!("sha256:{}", hex::encode(Sha256::digest(bytes)))),
			});
		} else {
			return Err(RunnerError::new("candidate workspace contains a special file"));
		}
	}

	Ok(())
}

fn build_workspace_snapshot(
	workspace: &Path,
	manifest: &WorkspaceManifest,
) -> Result<WorkspaceSnapshot, RunnerError> {
	let canonical_root = fs::canonicalize(workspace)
		.map_err(|error| RunnerError::new(format!("candidate workspace unavailable: {error}")))?;
	let mut entries = Vec::with_capacity(manifest.entries.len());

	for entry in &manifest.entries {
		let path = canonical_root.join(&entry.path);

		if entry.kind == "directory" {
			let metadata = fs::symlink_metadata(&path).map_err(|error| {
				RunnerError::new(format!("cannot inspect candidate workspace directory: {error}"))
			})?;

			if metadata.file_type().is_symlink() || !metadata.is_dir() {
				return Err(RunnerError::new(
					"candidate workspace directory changed during replay capture",
				));
			}

			entries.push(WorkspaceSnapshotEntry {
				path: entry.path.clone(),
				kind: "directory".to_owned(),
				bytes: None,
				sha256: None,
				content_hex: None,
			});

			continue;
		}
		if entry.kind != "file" {
			return Err(RunnerError::new("workspace manifest contains an unknown entry kind"));
		}

		let metadata = fs::symlink_metadata(&path).map_err(|error| {
			RunnerError::new(format!("cannot inspect candidate workspace file: {error}"))
		})?;

		if metadata.file_type().is_symlink() || !metadata.is_file() {
			return Err(RunnerError::new("candidate workspace file changed during replay capture"));
		}

		let expected_bytes = entry
			.bytes
			.ok_or_else(|| RunnerError::new("workspace manifest file lacks a byte count"))?;
		let bytes = read_workspace_file_bounded(&path, expected_bytes)?;
		let byte_count = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
		let digest = format!("sha256:{}", hex::encode(Sha256::digest(&bytes)));

		if entry.bytes != Some(byte_count) || entry.sha256.as_deref() != Some(&digest) {
			return Err(RunnerError::new("candidate workspace file changed during replay capture"));
		}

		entries.push(WorkspaceSnapshotEntry {
			path: entry.path.clone(),
			kind: "file".to_owned(),
			bytes: Some(byte_count),
			sha256: Some(digest),
			content_hex: Some(hex::encode(bytes)),
		});
	}

	Ok(WorkspaceSnapshot {
		schema_version: "aiq.workspace-snapshot.v1".to_owned(),
		manifest_sha256: protocol::canonical_hash(manifest)?,
		entries,
	})
}

fn safe_workspace_relative_path(value: &str) -> bool {
	(1..=4_096).contains(&value.len())
		&& !value.starts_with('/')
		&& !value.ends_with('/')
		&& !value.contains("//")
		&& value.split('/').all(safe_path_component)
}

fn validate_jobs(jobs: usize) -> Result<(), RunnerError> {
	if (1..=MAX_RUN_JOBS).contains(&jobs) {
		Ok(())
	} else {
		Err(RunnerError::new(format!("jobs must be between 1 and {MAX_RUN_JOBS}")))
	}
}

fn restore_checkpoint_results(
	checkpoint: &RunCheckpoint,
	pair_indexes: &BTreeMap<(ModelConfig, String), usize>,
	expected_tasks: &BTreeMap<&str, (&str, String)>,
	validation: &CapabilityValidationReport,
	commitments: &RunCommitments,
	expected_codex_version: &str,
) -> Result<BTreeMap<usize, TaskResult>, RunnerError> {
	let mut committed = BTreeMap::new();

	for (result, evaluator_result) in checkpoint.results.iter().zip(&checkpoint.evaluator_results) {
		let mut result = result.clone();

		if result.tool_usage.by_tool.contains_key("collab_tool_call") {
			return Err(RunnerError::new(
				"run checkpoint contains collaboration calls rejected by the active item policy",
			));
		}

		result.evaluator_checks =
			evaluator_result.as_ref().map_or_else(Vec::new, |result| result.checks.clone());

		let pair = (result.model, result.task_id.clone());
		let Some(index) = pair_indexes.get(&pair).copied() else {
			return Err(RunnerError::new(
				"run checkpoint result does not match the selected execution",
			));
		};
		let expected_task = expected_tasks.get(result.task_id.as_str());
		let validation_entry = validation.model(result.model);

		if expected_task.is_none_or(|(version, hash)| {
			result.task_version != *version || result.task_hash != *hash
		}) || result.provenance.synthetic
			|| result.provenance.node_id != validation.node_id
			|| result.provenance.codex_version != expected_codex_version
			|| result.provenance.runner_version != env!("CARGO_PKG_VERSION")
			|| result.provenance.observed_at != commitments.observed_at
			|| !validation_entry.is_some_and(|entry| {
				matches!(
					(entry.status, result.status),
					(CapabilityValidationStatus::Available, ResultStatus::Completed)
						| (CapabilityValidationStatus::Available, ResultStatus::Failed)
						| (CapabilityValidationStatus::Available, ResultStatus::Unevaluated)
						| (CapabilityValidationStatus::Unsupported, ResultStatus::Unsupported)
						| (CapabilityValidationStatus::Unavailable, ResultStatus::Failed)
				)
			}) || result.content_hash()? != result.result_id.replacen("result_", "sha256:", 1)
			|| committed.insert(index, result).is_some()
		{
			return Err(RunnerError::new(
				"run checkpoint result does not match the selected execution",
			));
		}
	}

	Ok(committed)
}

#[allow(
	clippy::too_many_arguments,
	reason = "the record constructor keeps each independently validated run commitment explicit"
)]
fn selected_run_record(
	tasks: &[TaskDefinition],
	models: &[ModelConfig],
	slot: ScheduleSlot,
	validation: CapabilityValidationReport,
	commitments: RunCommitments,
	checkpoint: RunCheckpoint,
	evaluator_results_artifact: ArtifactReference,
	execution_concurrency: usize,
) -> SelectedRun {
	let finished_unix_ms = unix_ms();

	if commitments.run_class == RunClass::Official {
		SelectedRun::OfficialShape(RunRecord {
			schema_version: RUN_SCHEMA_VERSION.to_owned(),
			run_id: commitments.run_id,
			schedule_slot: slot,
			task_set_hash: commitments.task_set_hash,
			scoring_version: AIQ_SCORING_VERSION.to_owned(),
			calibration_admission_digest: commitments.calibration_admission_digest,
			calibration_bank: commitments.calibration_bank,
			execution_concurrency: Some(execution_concurrency),
			models: MODEL_MATRIX.to_vec(),
			started_unix_ms: checkpoint.started_unix_ms,
			finished_unix_ms,
			synthetic: false,
			capability_validation: Some(validation),
			provenance: Some(commitments.provenance),
			evaluator_results_artifact,
			terminal_attempt_lineage: checkpoint.terminal_attempt_lineage,
			results: checkpoint.results,
		})
	} else {
		SelectedRun::Calibration(CalibrationRunRecord {
			schema_version: CALIBRATION_RUN_SCHEMA_VERSION.to_owned(),
			official_eligible: false,
			classification: "local_calibration_non_official".to_owned(),
			run_id: commitments.run_id,
			schedule_slot: slot,
			task_set_hash: commitments.task_set_hash,
			scoring_version: AIQ_SCORING_VERSION.to_owned(),
			calibration_admission_digest: None,
			calibration_bank: None,
			execution_concurrency: Some(execution_concurrency),
			models: models.to_vec(),
			task_ids: tasks.iter().map(|task| task.task_id.clone()).collect(),
			started_unix_ms: checkpoint.started_unix_ms,
			finished_unix_ms,
			capability_validation: validation,
			provenance: commitments.provenance,
			evaluator_results_artifact,
			terminal_attempt_lineage: checkpoint.terminal_attempt_lineage,
			results: checkpoint.results,
		})
	}
}

#[cfg(test)]
#[allow(clippy::too_many_arguments)]
fn execute_task<E, S, P>(
	adapter: &CodexAdapter<E, S>,
	workspace_provider: &P,
	manifest: &CapabilityManifest,
	task: &TaskDefinition,
	model: ModelConfig,
	run_id: &str,
	codex_version: &str,
	observed_at: &str,
	evaluator_root: Option<&Path>,
	evaluator_runtime: Option<&EvaluatorRuntime>,
) -> Result<TaskResult, RunnerError>
where
	E: Executor,
	S: ArtifactSink,
	P: TaskWorkspaceProvider,
{
	execute_task_attempt(
		adapter,
		workspace_provider,
		manifest,
		task,
		model,
		run_id,
		codex_version,
		observed_at,
		evaluator_root,
		evaluator_runtime,
		None,
	)
	.map(|attempt| attempt.result)
}

#[allow(clippy::too_many_arguments)]
fn execute_task_attempt<E, S, P>(
	adapter: &CodexAdapter<E, S>,
	workspace_provider: &P,
	manifest: &CapabilityManifest,
	task: &TaskDefinition,
	model: ModelConfig,
	run_id: &str,
	codex_version: &str,
	observed_at: &str,
	evaluator_root: Option<&Path>,
	evaluator_runtime: Option<&EvaluatorRuntime>,
	evaluator_ready: Option<&mut EvaluatorReadyCallback<'_>>,
) -> Result<TaskExecutionAttempt, RunnerError>
where
	E: Executor,
	S: ArtifactSink,
	P: TaskWorkspaceProvider,
{
	let context = match workspace_provider.context(run_id, model, task) {
		Ok(context) => context,
		Err(error) => {
			return workspace_unavailable_result(
				manifest,
				task,
				model,
				run_id,
				codex_version,
				observed_at,
				&error.to_string(),
			)
			.map(|result| TaskExecutionAttempt {
				result,
				stdout_full: String::new(),
				sealed_workspace: None,
			});
		},
	};
	let started = Instant::now();
	let invocation_request = task_invocation_request(task, model, &context);
	let invocation = adapter.invoke(&invocation_request);
	let wall_ms = elapsed_ms(started);
	let invocation_evidence = InvocationEvidence::capture(&invocation, wall_ms, task);
	let sealed_workspace = match SealedWorkspace::create(&context.workspace_dir) {
		Ok(workspace) => workspace,
		Err(_) => {
			return workspace_integrity_result(
				manifest,
				task,
				model,
				run_id,
				codex_version,
				observed_at,
				&invocation_evidence,
				None,
				WorkspaceIntegrityFailure::Sealing,
			)
			.map(|result| TaskExecutionAttempt {
				result,
				stdout_full: invocation_evidence.stdout_full.clone(),
				sealed_workspace: None,
			});
		},
	};
	let (workspace_manifest, workspace_snapshot) =
		match retain_workspace_evidence(adapter, sealed_workspace.path()) {
			Ok(evidence) => evidence,
			Err(_) => {
				let _ = sealed_workspace.cleanup();

				return workspace_integrity_result(
					manifest,
					task,
					model,
					run_id,
					codex_version,
					observed_at,
					&invocation_evidence,
					None,
					WorkspaceIntegrityFailure::EvidenceRetention,
				)
				.map(|result| TaskExecutionAttempt {
					result,
					stdout_full: invocation_evidence.stdout_full.clone(),
					sealed_workspace: None,
				});
			},
		};
	let sealed_manifest_sha256 = workspace_manifest.content_hash.clone();
	let mut retain_sealed_workspace = false;
	let result = match invocation {
		Ok(output) => successful_result(
			adapter,
			manifest,
			task,
			model,
			run_id,
			codex_version,
			observed_at,
			wall_ms,
			&output,
			sealed_workspace.path(),
			&workspace_manifest,
			&workspace_snapshot,
			evaluator_root,
			evaluator_runtime,
			evaluator_ready,
			&mut retain_sealed_workspace,
		),
		Err(failure) => failed_result(
			manifest,
			task,
			model,
			run_id,
			codex_version,
			observed_at,
			wall_ms,
			&failure,
			workspace_manifest,
			workspace_snapshot,
		),
	};

	finish_task_execution_attempt(
		manifest,
		task,
		model,
		run_id,
		codex_version,
		observed_at,
		result,
		sealed_workspace,
		&sealed_manifest_sha256,
		&invocation_evidence,
		retain_sealed_workspace,
	)
}

#[allow(clippy::too_many_arguments)]
fn finish_task_execution_attempt(
	manifest: &CapabilityManifest,
	task: &TaskDefinition,
	model: ModelConfig,
	run_id: &str,
	codex_version: &str,
	observed_at: &str,
	result: Result<TaskResult, RunnerError>,
	sealed_workspace: SealedWorkspace,
	sealed_manifest_sha256: &str,
	invocation_evidence: &InvocationEvidence,
	retain_sealed_workspace: bool,
) -> Result<TaskExecutionAttempt, RunnerError> {
	let stdout_full = invocation_evidence.stdout_full.clone();
	let (result, sealed_workspace) = if retain_sealed_workspace {
		let result = match verify_sealed_workspace_unchanged(
			sealed_workspace.path(),
			sealed_manifest_sha256,
		) {
			Ok(()) => result,
			Err(_) => workspace_integrity_result(
				manifest,
				task,
				model,
				run_id,
				codex_version,
				observed_at,
				invocation_evidence,
				result.ok(),
				WorkspaceIntegrityFailure::PostEvaluationIntegrity,
			),
		}?;

		(result, Some(sealed_workspace))
	} else {
		(
			finish_sealed_task_result(
				manifest,
				task,
				model,
				run_id,
				codex_version,
				observed_at,
				result,
				sealed_workspace,
				sealed_manifest_sha256,
				invocation_evidence,
			)?,
			None,
		)
	};

	Ok(TaskExecutionAttempt { result, stdout_full, sealed_workspace })
}

fn task_invocation_request(
	task: &TaskDefinition,
	model: ModelConfig,
	context: &TaskExecutionContext,
) -> InvocationRequest {
	InvocationRequest {
		model,
		prompt: task_prompt(task),
		timeout: task.budgets.wall_seconds.map(Duration::from_secs),
		max_steps: task.budgets.max_steps,
		max_tool_calls: task.budgets.max_tool_calls,
		workspace_dir: context.workspace_dir.clone(),
		sandbox: context.sandbox,
	}
}

#[allow(clippy::too_many_arguments)]
fn successful_result<E, S>(
	adapter: &CodexAdapter<E, S>,
	manifest: &CapabilityManifest,
	task: &TaskDefinition,
	model: ModelConfig,
	run_id: &str,
	codex_version: &str,
	observed_at: &str,
	wall_ms: u64,
	output: &CodexOutput,
	workspace_dir: &Path,
	workspace_manifest: &ArtifactReference,
	workspace_snapshot: &ArtifactReference,
	evaluator_root: Option<&Path>,
	evaluator_runtime: Option<&EvaluatorRuntime>,
	mut evaluator_ready: Option<&mut EvaluatorReadyCallback<'_>>,
	retain_sealed_workspace: &mut bool,
) -> Result<TaskResult, RunnerError>
where
	E: Executor,
	S: ArtifactSink,
{
	let mut tool_usage = parse_codex_tool_usage(&output.stdout_full)
		.map_err(|error| RunnerError::new(error.to_string()))?;

	project_completed_command_digests(task, &mut tool_usage);

	let complete_response = output.final_response.clone();
	let mut artifacts = output.artifacts.clone();

	artifacts.push(workspace_snapshot.clone());

	let budget_failure = result_budget_failure(task, &tool_usage);
	let (response, response_sha256) = result_response(
		adapter,
		output,
		complete_response.as_deref(),
		&mut artifacts,
		budget_failure.as_deref(),
	)?;
	let task_hash = task.content_hash()?;
	let result_provenance = provenance(manifest, codex_version, observed_at, false);
	let evaluator_is_ready =
		budget_failure.is_none() && complete_response.is_some() && task.evaluator.is_some();

	if evaluator_is_ready && let Some(callback) = evaluator_ready.as_mut() {
		let pending = PendingEvaluation {
			schema_version: PENDING_EVALUATION_SCHEMA_VERSION.to_owned(),
			run_id: run_id.to_owned(),
			task_id: task.task_id.clone(),
			task_version: task.task_version.clone(),
			task_hash: task_hash.clone(),
			model,
			final_response: complete_response.clone().expect("checked complete response"),
			response: response.clone().expect("complete response has a preview"),
			response_sha256: response_sha256.clone().expect("complete response has a digest"),
			artifacts: artifacts.clone(),
			exit_code: output.exit_code,
			latency: Latency { wall_ms, evaluator_ms: 0 },
			tool_usage: tool_usage.clone(),
			workspace_manifest: workspace_manifest.clone(),
			sealed_workspace: workspace_dir.to_owned(),
			provenance: result_provenance.clone(),
		};

		callback(&pending)?;

		*retain_sealed_workspace = true;
	}

	let evaluator_started =
		(budget_failure.is_none() && complete_response.is_some() && task.evaluator.is_some())
			.then(Instant::now);
	let evaluated = evaluate_result(ResultEvaluationRequest {
		task,
		model,
		run_id,
		exit_code: output.exit_code,
		complete_response: complete_response.as_deref(),
		workspace_dir,
		workspace_manifest,
		evaluator_root,
		evaluator_runtime,
		tool_usage: &tool_usage,
		budget_failure: budget_failure.as_deref(),
	})?;
	let evaluator_ms = evaluator_started.map_or(0, elapsed_ms);
	let mut result = TaskResult {
		schema_version: RESULT_SCHEMA_VERSION.to_owned(),
		result_id: String::new(),
		run_id: run_id.to_owned(),
		task_id: task.task_id.clone(),
		task_version: task.task_version.clone(),
		task_hash,
		model,
		status: evaluated.status,
		evaluation: evaluated.outcome,
		task_score: evaluated.score,
		response,
		response_sha256,
		evaluator_result_sha256: None,
		evaluator_stdout_sha256: evaluated.raw_stdout_sha256,
		artifacts,
		failure: evaluated.failure,
		latency: Latency { wall_ms, evaluator_ms },
		tool_usage,
		evaluator_checks: evaluated.checks,
		workspace_manifest: Some(workspace_manifest.clone()),
		provenance: result_provenance,
	};

	result.bind_evaluator_result_digest()?;

	Ok(result)
}

fn resume_pending_evaluation(
	pending: &PendingEvaluation,
	task: &TaskDefinition,
	commitments: &RunCommitments,
	codex_version: &str,
	evaluator_root: Option<&Path>,
	evaluator_runtime: Option<&EvaluatorRuntime>,
) -> Result<(TaskResult, SealedWorkspace), RunnerError> {
	let expected_task_hash = task.content_hash()?;
	let response_sha256 =
		format!("sha256:{}", hex::encode(Sha256::digest(pending.final_response.as_bytes())));
	let response_preview_end = pending
		.final_response
		.floor_char_boundary(MAX_RESULT_PREVIEW_BYTES.min(pending.final_response.len()));
	let response_preview = &pending.final_response[..response_preview_end];
	let execution_root = Path::new(&commitments.execution_root);

	if pending.schema_version != PENDING_EVALUATION_SCHEMA_VERSION
		|| pending.run_id != commitments.run_id
		|| pending.task_id != task.task_id
		|| pending.task_version != task.task_version
		|| pending.task_hash != expected_task_hash
		|| pending.response_sha256 != response_sha256
		|| pending.response != response_preview
		|| pending.final_response.len() > MAX_CAPTURE_BYTES
		|| pending.latency.evaluator_ms != 0
		|| !pending.sealed_workspace.is_absolute()
		|| !pending.sealed_workspace.starts_with(execution_root)
		|| pending.provenance.synthetic
		|| pending.provenance.runner_version != env!("CARGO_PKG_VERSION")
		|| pending.provenance.codex_version != codex_version
		|| pending.provenance.observed_at != commitments.observed_at
	{
		return Err(RunnerError::new(
			"pending evaluator evidence does not match the selected model result",
		));
	}

	let sealed_workspace = SealedWorkspace::retained(&pending.sealed_workspace)
		.map_err(|error| RunnerError::new(error.to_string()))?;
	let observed_manifest = build_workspace_manifest(sealed_workspace.path())?;
	let observed_manifest_sha256 = protocol::canonical_hash(&observed_manifest)?;

	if observed_manifest_sha256 != pending.workspace_manifest.content_hash {
		return Err(RunnerError::new(
			"retained sealed workspace does not match its pending evaluator manifest",
		));
	}

	let evaluator = task
		.evaluator
		.as_ref()
		.ok_or_else(|| RunnerError::new("pending evaluator task no longer has an evaluator"))?;
	let tool_evidence = NormalizedToolEvidence {
		steps: pending.tool_usage.steps,
		total_calls: pending.tool_usage.total_calls,
		by_tool: pending.tool_usage.by_tool.clone(),
		completed_command_sha256: pending.tool_usage.completed_command_sha256.clone(),
	};
	let context = EvaluatorContext {
		task_id: &pending.task_id,
		task_version: &pending.task_version,
		run_id: &pending.run_id,
		model: pending.model,
		final_response: &pending.final_response,
		candidate_workspace: sealed_workspace.path(),
		workspace_manifest_sha256: &pending.workspace_manifest.content_hash,
		tool_evidence: &tool_evidence,
	};
	let started = Instant::now();
	let (evaluated, raw_stdout_sha256) = evaluate_bound_evaluator(
		evaluator,
		&pending.final_response,
		&context,
		evaluator_root,
		evaluator_runtime,
	)?;
	let evaluator_ms = elapsed_ms(started);
	let (status, outcome, score, checks, failure) = evaluation_fields(evaluated, pending.exit_code);
	let mut result = TaskResult {
		schema_version: RESULT_SCHEMA_VERSION.to_owned(),
		result_id: String::new(),
		run_id: pending.run_id.clone(),
		task_id: pending.task_id.clone(),
		task_version: pending.task_version.clone(),
		task_hash: pending.task_hash.clone(),
		model: pending.model,
		status,
		evaluation: outcome,
		task_score: score,
		response: Some(pending.response.clone()),
		response_sha256: Some(pending.response_sha256.clone()),
		evaluator_result_sha256: None,
		evaluator_stdout_sha256: raw_stdout_sha256,
		artifacts: pending.artifacts.clone(),
		failure,
		latency: Latency { wall_ms: pending.latency.wall_ms, evaluator_ms },
		tool_usage: pending.tool_usage.clone(),
		evaluator_checks: checks,
		workspace_manifest: Some(pending.workspace_manifest.clone()),
		provenance: pending.provenance.clone(),
	};

	result.bind_evaluator_result_digest()?;

	verify_sealed_workspace_unchanged(sealed_workspace.path(), &observed_manifest_sha256)?;

	Ok((result, sealed_workspace))
}

fn evaluate_result(request: ResultEvaluationRequest<'_>) -> Result<ResultEvaluation, RunnerError> {
	if let Some(message) = request.budget_failure {
		return Ok(ResultEvaluation {
			status: ResultStatus::Failed,
			outcome: EvaluationOutcome::NotEvaluated,
			// Runtime budget exhaustion is not evaluator evidence. Keep the
			// failure visible, but leave the semantic task score absent.
			score: None,
			checks: Vec::new(),
			raw_stdout_sha256: None,
			failure: Some(ResultFailure {
				kind: FailureKind::BudgetExceeded,
				message: message.to_owned(),
				exit_code: request.exit_code,
				retryable: false,
			}),
		});
	}

	let Some(response) = request.complete_response else {
		return Ok(ResultEvaluation {
			status: ResultStatus::Failed,
			outcome: EvaluationOutcome::NotEvaluated,
			// A missing final response is not a semantic incorrect answer.
			score: None,
			checks: Vec::new(),
			raw_stdout_sha256: None,
			failure: Some(ResultFailure {
				kind: FailureKind::MissingResponse,
				message: "Codex CLI produced no final response".to_owned(),
				exit_code: request.exit_code,
				retryable: true,
			}),
		});
	};
	let Some(evaluator) = &request.task.evaluator else {
		return Ok(ResultEvaluation {
			status: ResultStatus::Unevaluated,
			outcome: EvaluationOutcome::NotEvaluated,
			score: None,
			checks: Vec::new(),
			raw_stdout_sha256: None,
			failure: Some(ResultFailure {
				kind: FailureKind::MissingEvaluator,
				message: "task has no evaluator; success cannot be inferred".to_owned(),
				exit_code: request.exit_code,
				retryable: false,
			}),
		});
	};
	let tool_evidence = NormalizedToolEvidence {
		steps: request.tool_usage.steps,
		total_calls: request.tool_usage.total_calls,
		by_tool: request.tool_usage.by_tool.clone(),
		completed_command_sha256: request.tool_usage.completed_command_sha256.clone(),
	};
	let context = EvaluatorContext {
		task_id: &request.task.task_id,
		task_version: &request.task.task_version,
		run_id: request.run_id,
		model: request.model,
		final_response: response,
		candidate_workspace: request.workspace_dir,
		workspace_manifest_sha256: &request.workspace_manifest.content_hash,
		tool_evidence: &tool_evidence,
	};
	let (result, raw_stdout_sha256) = evaluate_bound_evaluator(
		evaluator,
		response,
		&context,
		request.evaluator_root,
		request.evaluator_runtime,
	)?;
	let (status, outcome, score, checks, failure) = evaluation_fields(result, request.exit_code);

	Ok(ResultEvaluation { status, outcome, score, checks, raw_stdout_sha256, failure })
}

fn evaluate_bound_evaluator(
	evaluator: &Evaluator,
	response: &str,
	context: &EvaluatorContext<'_>,
	evaluator_root: Option<&Path>,
	evaluator_runtime: Option<&EvaluatorRuntime>,
) -> Result<(Result<EvaluationResult, EvaluationError>, Option<String>), RunnerError> {
	if evaluator.external.is_some() {
		let Some((root, runtime)) = evaluator_root.zip(evaluator_runtime) else {
			return Err(RunnerError::new(
				"external evaluators require an explicit registry and committed runtime",
			));
		};

		return Ok(
			match evaluator.evaluate_checked_observation_at_root(
				response,
				Some(context),
				root,
				runtime,
			) {
				Ok(observation) => (Ok(observation.result), Some(observation.raw_stdout_sha256)),
				Err(error) => (Err(error), None),
			},
		);
	}

	Ok((
		evaluator.evaluate_checked_with_execution(
			response,
			Some(context),
			evaluator_root.zip(evaluator_runtime),
		),
		None,
	))
}

fn result_budget_failure(task: &TaskDefinition, tool_usage: &ToolUsage) -> Option<String> {
	if task.budgets.max_steps.is_some_and(|limit| tool_usage.steps > limit) {
		Some(format!(
			"observed {} steps, but the task permits {}",
			tool_usage.steps,
			task.budgets.max_steps.expect("checked step limit")
		))
	} else if task.budgets.max_tool_calls.is_some_and(|limit| tool_usage.total_calls > limit) {
		Some(format!(
			"observed {} tool calls, but the task permits {}",
			tool_usage.total_calls,
			task.budgets.max_tool_calls.expect("checked tool-call limit")
		))
	} else {
		None
	}
}

fn result_response<E, S>(
	adapter: &CodexAdapter<E, S>,
	output: &CodexOutput,
	complete_response: Option<&str>,
	artifacts: &mut Vec<ArtifactReference>,
	budget_failure: Option<&str>,
) -> Result<(Option<String>, Option<String>), RunnerError>
where
	E: Executor,
	S: ArtifactSink,
{
	if budget_failure.is_some() {
		if !output.stdout_full.is_empty()
			&& !artifacts.iter().any(|artifact| artifact.kind == "stdout.jsonl")
		{
			artifacts.push(
				adapter
					.store_artifact("stdout.jsonl", output.stdout_full.as_bytes())
					.map_err(|error| RunnerError::new(error.to_string()))?,
			);
		}

		Ok((None, None))
	} else {
		let response_sha256 = complete_response
			.map(|value| format!("sha256:{}", hex::encode(Sha256::digest(value.as_bytes()))));
		let response = complete_response
			.map(|value| {
				if value.len() > MAX_RESULT_PREVIEW_BYTES {
					artifacts.push(
						adapter
							.store_artifact("final-response.txt", value.as_bytes())
							.map_err(|error| RunnerError::new(error.to_string()))?,
					);
				}

				let end = value.floor_char_boundary(MAX_RESULT_PREVIEW_BYTES.min(value.len()));

				Ok::<String, RunnerError>(value[..end].to_owned())
			})
			.transpose()?;

		Ok((response, response_sha256))
	}
}

fn evaluation_fields(
	result: Result<EvaluationResult, EvaluationError>,
	exit_code: Option<i32>,
) -> (ResultStatus, EvaluationOutcome, Option<f64>, Vec<EvaluatorCheck>, Option<ResultFailure>) {
	match result {
		Ok(result) => (
			ResultStatus::Completed,
			match result.outcome {
				EvaluatorOutcome::Correct => EvaluationOutcome::Correct,
				EvaluatorOutcome::Partial => EvaluationOutcome::Partial,
				EvaluatorOutcome::Incorrect => EvaluationOutcome::Incorrect,
			},
			Some(result.score),
			result.checks,
			None,
		),
		Err(error) => {
			let retryable = error.is_retryable();

			(
				ResultStatus::Failed,
				EvaluationOutcome::NotEvaluated,
				None,
				Vec::new(),
				Some(ResultFailure {
					kind: FailureKind::EvaluatorFailure,
					message: format!("controlled evaluator {:?} failure: {error}", error.kind()),
					exit_code,
					retryable,
				}),
			)
		},
	}
}

#[allow(clippy::too_many_arguments)]
fn workspace_integrity_result(
	manifest: &CapabilityManifest,
	task: &TaskDefinition,
	model: ModelConfig,
	run_id: &str,
	codex_version: &str,
	observed_at: &str,
	invocation: &InvocationEvidence,
	prior_result: Option<TaskResult>,
	failure: WorkspaceIntegrityFailure,
) -> Result<TaskResult, RunnerError> {
	let message = failure.message();

	if let Some(mut result) = prior_result {
		result.status = ResultStatus::Failed;
		result.evaluation = EvaluationOutcome::NotEvaluated;
		result.task_score = None;
		result.response = None;
		result.response_sha256 = None;
		result.evaluator_result_sha256 = None;
		result.evaluator_stdout_sha256 = None;

		result.artifacts.retain(|artifact| artifact.kind != "final-response.txt");

		result.failure = Some(ResultFailure {
			kind: FailureKind::WorkspaceIntegrity,
			message: message.to_owned(),
			exit_code: invocation.exit_code,
			retryable: true,
		});

		result.evaluator_checks.clear();

		return Ok(result);
	}

	Ok(TaskResult {
		schema_version: RESULT_SCHEMA_VERSION.to_owned(),
		result_id: String::new(),
		run_id: run_id.to_owned(),
		task_id: task.task_id.clone(),
		task_version: task.task_version.clone(),
		task_hash: task.content_hash()?,
		model,
		status: ResultStatus::Failed,
		evaluation: EvaluationOutcome::NotEvaluated,
		task_score: None,
		response: None,
		response_sha256: None,
		evaluator_result_sha256: None,
		evaluator_stdout_sha256: None,
		artifacts: invocation.artifacts.clone(),
		failure: Some(ResultFailure {
			kind: FailureKind::WorkspaceIntegrity,
			message: message.to_owned(),
			exit_code: invocation.exit_code,
			retryable: true,
		}),
		latency: Latency { wall_ms: invocation.wall_ms, evaluator_ms: 0 },
		tool_usage: invocation.tool_usage.clone(),
		evaluator_checks: Vec::new(),
		workspace_manifest: None,
		provenance: provenance(manifest, codex_version, observed_at, false),
	})
}

#[allow(clippy::too_many_arguments)]
fn failed_result(
	manifest: &CapabilityManifest,
	task: &TaskDefinition,
	model: ModelConfig,
	run_id: &str,
	codex_version: &str,
	observed_at: &str,
	wall_ms: u64,
	failure: &AdapterFailure,
	workspace_manifest: ArtifactReference,
	workspace_snapshot: ArtifactReference,
) -> Result<TaskResult, RunnerError> {
	let kind = match failure.kind {
		AdapterFailureKind::Spawn => FailureKind::Spawn,
		AdapterFailureKind::Timeout => FailureKind::Timeout,
		AdapterFailureKind::Unsupported => FailureKind::UnsupportedModel,
		AdapterFailureKind::Authentication => FailureKind::Authentication,
		AdapterFailureKind::UsageLimit => FailureKind::SubscriptionLimit,
		AdapterFailureKind::NonZeroExit => FailureKind::NonZeroExit,
		AdapterFailureKind::BudgetExceeded => FailureKind::BudgetExceeded,
		AdapterFailureKind::OutputTruncated => FailureKind::OutputTruncated,
		AdapterFailureKind::WorkspaceIntegrity => FailureKind::WorkspaceIntegrity,
	};

	Ok(TaskResult {
		schema_version: RESULT_SCHEMA_VERSION.to_owned(),
		result_id: String::new(),
		run_id: run_id.to_owned(),
		task_id: task.task_id.clone(),
		task_version: task.task_version.clone(),
		task_hash: task.content_hash()?,
		model,
		status: ResultStatus::Failed,
		evaluation: EvaluationOutcome::NotEvaluated,
		// Adapter/runtime failure is not a scored semantic outcome. Older
		// bundles may still contain `0`; the scorer treats those defensively
		// as invalid runtime observations.
		task_score: None,
		response: None,
		response_sha256: None,
		evaluator_result_sha256: None,
		evaluator_stdout_sha256: None,
		artifacts: {
			let mut artifacts = failure.artifacts.clone();

			artifacts.push(workspace_snapshot);

			artifacts
		},
		failure: Some(ResultFailure {
			kind,
			message: failure.message.clone(),
			exit_code: failure.exit_code,
			retryable: matches!(
				failure.kind,
				AdapterFailureKind::Spawn
					| AdapterFailureKind::Timeout
					| AdapterFailureKind::UsageLimit
					| AdapterFailureKind::NonZeroExit
					| AdapterFailureKind::WorkspaceIntegrity
			),
		}),
		latency: Latency { wall_ms, evaluator_ms: 0 },
		tool_usage: retained_stdout_tool_usage(&failure.stdout_full, &failure.artifacts, task),
		evaluator_checks: Vec::new(),
		workspace_manifest: Some(workspace_manifest),
		provenance: provenance(manifest, codex_version, observed_at, false),
	})
}

fn task_prompt(task: &TaskDefinition) -> String {
	let allowed_tools =
		serde_json::to_string(&task.allowed_tools).unwrap_or_else(|_| "[]".to_owned());
	let fixture_refs =
		serde_json::to_string(&task.fixture_refs).unwrap_or_else(|_| "[]".to_owned());
	let execution_measurement = match (task.budgets.max_steps, task.budgets.max_tool_calls) {
		(None, None) => "Agent steps and tool calls are measured but are not limited.".to_owned(),
		(max_steps, max_tool_calls) => format!(
			"Maximum steps: {}\nMaximum tool calls: {}",
			max_steps.map_or_else(|| "unbounded".to_owned(), |value| value.to_string()),
			max_tool_calls.map_or_else(|| "unbounded".to_owned(), |value| value.to_string())
		),
	};

	format!(
		"{}\n\nAIQ controlled execution context:\nAllowed tools: {allowed_tools}\nFixture references: {fixture_refs}\n{execution_measurement}",
		task.prompt
	)
}

#[allow(clippy::too_many_arguments)]
fn workspace_unavailable_result(
	manifest: &CapabilityManifest,
	task: &TaskDefinition,
	model: ModelConfig,
	run_id: &str,
	codex_version: &str,
	observed_at: &str,
	message: &str,
) -> Result<TaskResult, RunnerError> {
	Ok(TaskResult {
		schema_version: RESULT_SCHEMA_VERSION.to_owned(),
		result_id: String::new(),
		run_id: run_id.to_owned(),
		task_id: task.task_id.clone(),
		task_version: task.task_version.clone(),
		task_hash: task.content_hash()?,
		model,
		status: ResultStatus::Failed,
		evaluation: EvaluationOutcome::NotEvaluated,
		task_score: None,
		response: None,
		response_sha256: None,
		evaluator_result_sha256: None,
		evaluator_stdout_sha256: None,
		artifacts: Vec::new(),
		failure: Some(ResultFailure {
			kind: FailureKind::WorkspaceUnavailable,
			message: message.to_owned(),
			exit_code: None,
			retryable: false,
		}),
		latency: Latency { wall_ms: 0, evaluator_ms: 0 },
		tool_usage: ToolUsage::default(),
		evaluator_checks: Vec::new(),
		workspace_manifest: None,
		provenance: provenance(manifest, codex_version, observed_at, false),
	})
}

#[allow(clippy::too_many_arguments)]
fn unavailable_result(
	manifest: &CapabilityManifest,
	task: &TaskDefinition,
	model: ModelConfig,
	run_id: &str,
	codex_version: &str,
	observed_at: &str,
	status: ResultStatus,
	kind: FailureKind,
	message: &str,
) -> Result<TaskResult, RunnerError> {
	Ok(TaskResult {
		schema_version: RESULT_SCHEMA_VERSION.to_owned(),
		result_id: String::new(),
		run_id: run_id.to_owned(),
		task_id: task.task_id.clone(),
		task_version: task.task_version.clone(),
		task_hash: task.content_hash()?,
		model,
		status,
		evaluation: EvaluationOutcome::NotEvaluated,
		task_score: None,
		response: None,
		response_sha256: None,
		evaluator_result_sha256: None,
		evaluator_stdout_sha256: None,
		artifacts: Vec::new(),
		failure: Some(ResultFailure {
			kind,
			message: message.to_owned(),
			exit_code: None,
			retryable: status != ResultStatus::Unsupported,
		}),
		latency: Latency { wall_ms: 0, evaluator_ms: 0 },
		tool_usage: ToolUsage::default(),
		evaluator_checks: Vec::new(),
		workspace_manifest: None,
		provenance: provenance(manifest, codex_version, observed_at, false),
	})
}

fn provenance(
	manifest: &CapabilityManifest,
	codex_version: &str,
	observed_at: &str,
	synthetic: bool,
) -> ResultProvenance {
	ResultProvenance {
		node_id: manifest.node_id.clone(),
		runner_version: env!("CARGO_PKG_VERSION").to_owned(),
		codex_version: codex_version.to_owned(),
		observed_at: observed_at.to_owned(),
		synthetic,
		local_trust: TrustTier::Untrusted,
	}
}

fn unix_ms() -> u64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map_or(0, |duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
}

fn elapsed_ms(started: Instant) -> u64 {
	u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}
#[cfg(test)]
mod tests {
	use std::{
		collections::{BTreeMap, BTreeSet},
		env, fs,
		panic::{self, AssertUnwindSafe},
		path::{Path, PathBuf},
		process, slice,
		sync::{
			Arc, Barrier, Mutex,
			atomic::{AtomicBool, AtomicUsize, Ordering},
		},
		thread,
		time::Duration,
	};
	#[cfg(unix)]
	use std::{
		os::unix::{fs::PermissionsExt as _, net::UnixListener},
		time::Instant,
	};

	use sha2::{Digest, Sha256};

	use crate::{
		adapter::{
			self, AdapterFailure, AdapterFailureKind, ArtifactReference, ArtifactSink,
			AuthenticationProbe, CapabilityValidation, CapabilityValidationReport,
			CapabilityValidationStatus, CliProbe, CodexAdapter, CodexExecutionConfig, CodexOutput,
			CommandRequest, ConfigurationProbe, ConfigurationProbeStatus, ExecutionCapture,
			Executor, ExecutorError, MAX_CODEX_VERSION_BYTES, MAX_INLINE_PREVIEW_BYTES,
			ProbeStatus, SandboxPolicy,
		},
		corpus_commitment::{self, RunClass},
		model::{CapabilityManifest, MODEL_MATRIX},
		protocol,
		resume::{self, InFlightCell, PendingEvaluation, RunCheckpoint, RunCommitments},
		run_validation,
		runner::{
			self, EvaluationOutcome, FailureKind, LocalDirectoryWorkspaceProvider,
			MAX_RESULT_PREVIEW_BYTES, MAX_RUN_JOBS, ResultStatus, SelectedRun,
			TaskExecutionContext, TaskResult, TaskWorkspaceProvider, WorkspaceError,
		},
		schedule::{ScheduleConfig, ScheduleOccurrence, ScheduleSlot},
		scoring::{
			self, CalibrationDescriptiveStatus, FalseOnly, ScoreContext, ScoreOptions, ScoreTier,
		},
		submission::{self, MAX_SUBMISSION_BYTES},
		task::{
			self, EVALUATOR_RESULT_SCHEMA_VERSION, EvaluationResult, Evaluator, EvaluatorCheck,
			EvaluatorOutcome, TaskDefinition, evaluator::EvaluatorCheckFailureClass,
		},
	};
	#[cfg(unix)]
	use crate::{
		adapter::{LocalArtifactSink, SystemExecutor},
		task::{
			EVALUATOR_PROTOCOL_VERSION, EvaluatorContext, EvaluatorRuntime, EvaluatorRuntimeKind,
			ExternalEvaluatorBinding, NormalizedToolEvidence,
		},
	};
	use crate::{candidate_catalog, capacity};

	struct NeverExecutor;
	struct UsageLimitExecutor(Arc<AtomicUsize>);
	struct ConcurrentUsageLimitExecutor {
		calls: Arc<AtomicUsize>,
		barrier: Arc<std::sync::Barrier>,
	}

	struct MemorySink;
	struct FailingSink;

	struct TamperingSink {
		workspace_parent: PathBuf,
	}

	struct NeverWorkspace;

	struct TestWorkspace {
		root: PathBuf,
		quarantines: AtomicUsize,
	}

	struct DeterministicExecutor {
		stats: Arc<ExecutionStats>,
		delay_ms: u64,
		panic_at: Option<usize>,
	}
	struct EvidenceExecutor;
	struct FailureEvidenceExecutor {
		timed_out: bool,
	}
	struct RetryThenSuccessExecutor {
		calls: Arc<AtomicUsize>,
	}
	struct IncorrectExecutor(Arc<AtomicUsize>);
	struct RecordingSink {
		objects: Arc<Mutex<BTreeMap<String, Vec<u8>>>>,
	}

	struct ExecutionStats {
		active: AtomicUsize,
		max_active: AtomicUsize,
		calls: Mutex<Vec<Vec<u8>>>,
	}

	impl Executor for NeverExecutor {
		fn execute(
			&self,
			_request: &CommandRequest,
		) -> Result<crate::adapter::ExecutionCapture, ExecutorError> {
			Err(ExecutorError::new("executor must not run"))
		}
	}

	impl Executor for UsageLimitExecutor {
		fn execute(&self, _request: &CommandRequest) -> Result<ExecutionCapture, ExecutorError> {
			let attempt = self.0.fetch_add(1, Ordering::SeqCst);

			if attempt > 0 {
				return Ok(ExecutionCapture {
					exit_code: Some(0),
					stdout: br#"{"type":"item.completed","item":{"id":"message-recovered","type":"agent_message","text":"OK"}}"#.to_vec(),
					stderr: Vec::new(),
					timed_out: false,
					budget_exceeded: None,
					stdout_truncated: false,
					stderr_truncated: false,
				});
			}

			Ok(ExecutionCapture {
				exit_code: Some(1),
				stdout: Vec::new(),
				stderr: b"You have 0 weighted tokens left".to_vec(),
				timed_out: false,
				budget_exceeded: None,
				stdout_truncated: false,
				stderr_truncated: false,
			})
		}
	}

	impl Executor for ConcurrentUsageLimitExecutor {
		fn execute(&self, _request: &CommandRequest) -> Result<ExecutionCapture, ExecutorError> {
			self.calls.fetch_add(1, Ordering::SeqCst);
			self.barrier.wait();

			Ok(ExecutionCapture {
				exit_code: Some(1),
				stdout: Vec::new(),
				stderr: b"You have 0 weighted tokens left".to_vec(),
				timed_out: false,
				budget_exceeded: None,
				stdout_truncated: false,
				stderr_truncated: false,
			})
		}
	}

	impl ArtifactSink for MemorySink {
		fn put(&self, kind: &str, bytes: &[u8]) -> Result<ArtifactReference, ExecutorError> {
			let content_hash = format!("sha256:{}", hex::encode(Sha256::digest(bytes)));

			Ok(ArtifactReference {
				kind: kind.to_owned(),
				uri: format!(
					"aiq-artifact://sha256/{}/{kind}",
					content_hash.trim_start_matches("sha256:")
				),
				content_hash,
				bytes: bytes.len() as u64,
			})
		}
	}

	impl ArtifactSink for FailingSink {
		fn put(&self, _kind: &str, _bytes: &[u8]) -> Result<ArtifactReference, ExecutorError> {
			Err(ExecutorError::new("synthetic sink failure"))
		}
	}

	impl ArtifactSink for RecordingSink {
		fn put(&self, kind: &str, bytes: &[u8]) -> Result<ArtifactReference, ExecutorError> {
			self.objects
				.lock()
				.expect("recording sink lock")
				.insert(kind.to_owned(), bytes.to_vec());

			MemorySink.put(kind, bytes)
		}
	}

	impl ArtifactSink for TamperingSink {
		fn put(&self, kind: &str, bytes: &[u8]) -> Result<ArtifactReference, ExecutorError> {
			if kind == "workspace-snapshot.json" {
				let sealed = sealed_siblings(&self.workspace_parent);

				if sealed.len() == 1 {
					fs::write(sealed[0].join("fixture.txt"), "tampered after evidence")
						.map_err(|error| ExecutorError::new(error.to_string()))?;
				}
			}

			MemorySink.put(kind, bytes)
		}
	}

	impl TaskWorkspaceProvider for NeverWorkspace {
		fn context(
			&self,
			_run_id: &str,
			_model: crate::model::ModelConfig,
			_task: &crate::task::TaskDefinition,
		) -> Result<crate::runner::TaskExecutionContext, crate::runner::WorkspaceError> {
			panic!("unsupported configurations must not prepare a workspace")
		}
	}

	impl TaskWorkspaceProvider for TestWorkspace {
		fn quarantine_interrupted(
			&self,
			run_id: &str,
			model: crate::model::ModelConfig,
			task: &crate::task::TaskDefinition,
		) -> Result<(), WorkspaceError> {
			let path = self.root.join(run_id).join(model.key()).join(&task.task_id);

			if path.exists() {
				let quarantine = self.root.join(".quarantine").join(format!(
					"{}-{}",
					task.task_id,
					self.quarantines.fetch_add(1, Ordering::SeqCst)
				));

				fs::create_dir_all(quarantine.parent().expect("quarantine parent"))
					.map_err(|error| WorkspaceError::new(error.to_string()))?;
				fs::rename(path, quarantine)
					.map_err(|error| WorkspaceError::new(error.to_string()))?;
			}

			Ok(())
		}

		fn context(
			&self,
			run_id: &str,
			model: crate::model::ModelConfig,
			task: &crate::task::TaskDefinition,
		) -> Result<TaskExecutionContext, WorkspaceError> {
			let path = self.root.join(run_id).join(model.key()).join(&task.task_id);

			fs::create_dir_all(&path).map_err(|error| WorkspaceError::new(error.to_string()))?;
			fs::write(path.join("fixture.txt"), &task.task_id)
				.map_err(|error| WorkspaceError::new(error.to_string()))?;

			Ok(TaskExecutionContext { workspace_dir: path, sandbox: SandboxPolicy::NoTools })
		}
	}

	impl DeterministicExecutor {
		fn new(delay_ms: u64, panic_at: Option<usize>) -> (Self, Arc<ExecutionStats>) {
			let stats = Arc::new(ExecutionStats {
				active: AtomicUsize::new(0),
				max_active: AtomicUsize::new(0),
				calls: Mutex::new(Vec::new()),
			});

			(Self { stats: Arc::clone(&stats), delay_ms, panic_at }, stats)
		}
	}

	impl Executor for DeterministicExecutor {
		fn execute(&self, request: &CommandRequest) -> Result<ExecutionCapture, ExecutorError> {
			let call = {
				let mut calls = self.stats.calls.lock().expect("calls lock");

				calls.push(request.stdin.clone());

				calls.len()
			};

			if self.panic_at == Some(call) {
				panic!("injected runner crash");
			}

			let active = self.stats.active.fetch_add(1, Ordering::SeqCst) + 1;

			self.stats.max_active.fetch_max(active, Ordering::SeqCst);

			if self.delay_ms != 0 {
				let skew = request.stdin.first().map_or(0, |byte| u64::from(*byte % 3));

				thread::sleep(Duration::from_millis(self.delay_ms * (skew + 1)));
			}

			self.stats.active.fetch_sub(1, Ordering::SeqCst);

			Ok(ExecutionCapture {
				exit_code: Some(0),
				stdout: br#"{"type":"item.completed","item":{"type":"agent_message","text":"OK"}}"#
					.to_vec(),
				stderr: Vec::new(),
				timed_out: false,
				budget_exceeded: None,
				stdout_truncated: false,
				stderr_truncated: false,
			})
		}
	}

	impl Executor for EvidenceExecutor {
		fn execute(&self, _request: &CommandRequest) -> Result<ExecutionCapture, ExecutorError> {
			thread::sleep(Duration::from_millis(2));

			Ok(ExecutionCapture {
				exit_code: Some(0),
				stdout: concat!(
					r#"{"type":"item.started","item":{"id":"cmd-1","type":"command_execution","command":"node bin/task-tool.mjs"}}"#,
					"\n",
					r#"{"type":"item.completed","item":{"id":"cmd-1","type":"command_execution","status":"completed"}}"#,
					"\n",
					r#"{"type":"item.completed","item":{"type":"agent_message","text":"OK"}}"#
				)
				.as_bytes()
				.to_vec(),
				stderr: Vec::new(),
				timed_out: false,
				budget_exceeded: None,
				stdout_truncated: false,
				stderr_truncated: false,
			})
		}
	}

	impl Executor for FailureEvidenceExecutor {
		fn execute(&self, _request: &CommandRequest) -> Result<ExecutionCapture, ExecutorError> {
			Ok(ExecutionCapture {
				exit_code: (!self.timed_out).then_some(17),
				stdout: concat!(
					r#"{"type":"item.completed","item":{"id":"cmd-1","type":"command_execution","status":"completed"}}"#,
					"\n",
					r#"{"type":"turn.completed","usage":{"input_tokens":11,"cached_input_tokens":2,"cache_write_input_tokens":1,"output_tokens":5,"reasoning_output_tokens":3,"total_tokens":16}}"#
				)
				.as_bytes()
				.to_vec(),
				stderr: Vec::new(),
				timed_out: self.timed_out,
				budget_exceeded: None,
				stdout_truncated: false,
				stderr_truncated: false,
			})
		}
	}

	impl Executor for RetryThenSuccessExecutor {
		fn execute(&self, _request: &CommandRequest) -> Result<ExecutionCapture, ExecutorError> {
			let attempt = self.calls.fetch_add(1, Ordering::SeqCst);

			thread::sleep(Duration::from_millis(2));

			let (exit_code, response, input_tokens, output_tokens) =
				if attempt == 0 { (17, "partial", 11, 5) } else { (0, "OK", 7, 3) };
			let stdout = [
				serde_json::json!({
					"type": "item.completed",
					"item": {
						"id": "message-shared",
						"type": "agent_message",
						"text": response,
					}
				})
				.to_string(),
				serde_json::json!({
					"type": "turn.completed",
					"usage": {
						"input_tokens": input_tokens,
						"output_tokens": output_tokens,
						"total_tokens": input_tokens + output_tokens,
					}
				})
				.to_string(),
			]
			.join("\n");

			Ok(ExecutionCapture {
				exit_code: Some(exit_code),
				stdout: stdout.into_bytes(),
				stderr: Vec::new(),
				timed_out: false,
				budget_exceeded: None,
				stdout_truncated: false,
				stderr_truncated: false,
			})
		}
	}

	impl Executor for IncorrectExecutor {
		fn execute(&self, _request: &CommandRequest) -> Result<ExecutionCapture, ExecutorError> {
			self.0.fetch_add(1, Ordering::SeqCst);

			Ok(ExecutionCapture {
				exit_code: Some(0),
				stdout:
					br#"{"type":"item.completed","item":{"type":"agent_message","text":"WRONG"}}"#
						.to_vec(),
				stderr: Vec::new(),
				timed_out: false,
				budget_exceeded: None,
				stdout_truncated: false,
				stderr_truncated: false,
			})
		}
	}

	fn committed_baseline_digests(
		baseline_root: &Path,
		tasks: &[crate::task::TaskDefinition],
	) -> BTreeMap<String, String> {
		tasks
			.iter()
			.map(|task| {
				let manifest = super::build_workspace_manifest(&baseline_root.join(&task.task_id))
					.expect("baseline manifest");
				let digest = protocol::canonical_hash(&manifest).expect("baseline digest");

				(task.task_id.clone(), digest)
			})
			.collect()
	}

	fn sealed_siblings(parent: &Path) -> Vec<PathBuf> {
		let mut paths = fs::read_dir(parent)
			.expect("sealed workspace parent")
			.map(|entry| entry.expect("sealed sibling entry").path())
			.filter(|path| {
				path.file_name()
					.and_then(|name| name.to_str())
					.is_some_and(|name| name.starts_with(".sealed-"))
			})
			.collect::<Vec<_>>();

		paths.sort();

		paths
	}

	#[cfg(unix)]
	fn sealed_bytes_evaluator(
		evaluator_root: &Path,
		original_workspace: &Path,
	) -> ExternalEvaluatorBinding {
		let executable = evaluator_root.join("evaluator");
		let runtime_path = evaluator_root.join("node-test-runtime");

		fs::write(
			&runtime_path,
			"#!/bin/sh\nif [ \"$1\" = --version ]; then printf 'v0.0.0-test\\n'; else exec /bin/sh \"$@\"; fi\n",
		)
		.expect("test runtime");
		fs::set_permissions(&runtime_path, fs::Permissions::from_mode(0o700))
			.expect("test runtime permissions");

		let script = format!(
			concat!(
				"#!/bin/sh\n",
				"IFS= read -r input\n",
				"candidate=${{input#*\\\"candidate_workspace\\\":\\\"}}\n",
				"candidate=${{candidate%%\\\"*}}\n",
				"printf 'changed during evaluation\\n' > '{}'\n",
				"IFS= read -r answer < \"$candidate/answer.txt\"\n",
				"if [ \"$answer\" = 'sealed answer' ]; then\n",
				"  printf '%s\\n' '{}'\n",
				"else\n",
				"  printf '%s\\n' '{}'\n",
				"fi\n"
			),
			original_workspace.join("answer.txt").display(),
			r#"{"schema_version":"aiq.evaluator-result.v3","outcome":"correct","score":1.0,"checks":[{"check_id":"sealed_bytes","weight":1,"passed":true,"failure_class":"none","evidence_digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]}"#,
			r#"{"schema_version":"aiq.evaluator-result.v3","outcome":"incorrect","score":0.0,"checks":[{"check_id":"sealed_bytes","weight":1,"passed":false,"failure_class":"value","evidence_digest":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}]}"#,
		);

		fs::write(&executable, script).expect("evaluator executable");
		fs::set_permissions(&executable, fs::Permissions::from_mode(0o700))
			.expect("evaluator permissions");

		let executable_digest = format!(
			"sha256:{}",
			hex::encode(Sha256::digest(fs::read(&executable).expect("evaluator bytes")))
		);
		let configuration = serde_json::from_value(serde_json::json!({
			"schema_version": crate::task::EVALUATOR_CONFIG_SCHEMA_VERSION,
			"completion_policy": "natural_completion"
		}))
		.expect("formal evaluator configuration");

		ExternalEvaluatorBinding {
			protocol_version: EVALUATOR_PROTOCOL_VERSION.to_owned(),
			scorer_version: "1.0.0".to_owned(),
			runtime_kind: EvaluatorRuntimeKind::Node,
			runtime_executable_digest: EvaluatorRuntime::resolve(&runtime_path)
				.expect("shell runtime")
				.executable_digest()
				.to_owned(),
			executable_ref: PathBuf::from("evaluator"),
			executable_digest,
			configuration_digest: protocol::canonical_hash(&configuration)
				.expect("configuration digest"),
			arguments: Vec::new(),
			timeout_ms: None,
			max_input_bytes: 8_192,
			max_output_bytes: 8_192,
			configuration,
		}
	}

	#[cfg(unix)]
	fn transient_execution_evaluator(
		evaluator_root: &Path,
	) -> (ExternalEvaluatorBinding, EvaluatorRuntime) {
		let executable = evaluator_root.join("evaluator");
		let runtime_path = evaluator_root.join("node-test-runtime");
		let first_attempt = evaluator_root.join("first-attempt");
		let second_attempt = evaluator_root.join("second-attempt");

		fs::write(
			&runtime_path,
			"#!/bin/sh\nif [ \"$1\" = --version ]; then printf 'v0.0.0-test\\n'; else exec /bin/sh \"$@\"; fi\n",
		)
		.expect("test runtime");
		fs::set_permissions(&runtime_path, fs::Permissions::from_mode(0o700))
			.expect("test runtime permissions");
		fs::write(
			&executable,
			format!(
				concat!(
					"#!/bin/sh\n",
					"cat >/dev/null\n",
					"if [ ! -f '{}' ]; then : > '{}'; exit 1; fi\n",
					"if [ ! -f '{}' ]; then : > '{}'; exit 1; fi\n",
					"printf '%s\\n' '{}'\n",
				),
				first_attempt.display(),
				first_attempt.display(),
				second_attempt.display(),
				second_attempt.display(),
				r#"{"schema_version":"aiq.evaluator-result.v3","outcome":"correct","score":1.0,"checks":[{"check_id":"transient_recovery","weight":1,"passed":true,"failure_class":"none","evidence_digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]}"#,
			),
		)
		.expect("transient evaluator executable");
		fs::set_permissions(&executable, fs::Permissions::from_mode(0o700))
			.expect("transient evaluator permissions");

		let runtime = EvaluatorRuntime::resolve(&runtime_path).expect("shell-backed test runtime");
		let executable_digest = format!(
			"sha256:{}",
			hex::encode(Sha256::digest(fs::read(&executable).expect("evaluator bytes")))
		);
		let configuration = serde_json::from_value(serde_json::json!({
			"schema_version": crate::task::EVALUATOR_CONFIG_SCHEMA_VERSION,
			"completion_policy": "natural_completion"
		}))
		.expect("formal evaluator configuration");
		let binding = ExternalEvaluatorBinding {
			protocol_version: EVALUATOR_PROTOCOL_VERSION.to_owned(),
			scorer_version: "1.0.0".to_owned(),
			runtime_kind: EvaluatorRuntimeKind::Node,
			runtime_executable_digest: runtime.executable_digest().to_owned(),
			executable_ref: PathBuf::from("evaluator"),
			executable_digest,
			configuration_digest: protocol::canonical_hash(&configuration)
				.expect("configuration digest"),
			arguments: Vec::new(),
			timeout_ms: None,
			max_input_bytes: 8_192,
			max_output_bytes: 8_192,
			configuration,
		};

		(binding, runtime)
	}

	fn selected_validation(version: &str, node_id: String) -> CapabilityValidationReport {
		CapabilityValidationReport {
			schema_version: "aiq.capability-validation.v3".to_owned(),
			node_id,
			manifest_issues: Vec::new(),
			cli_probe: CliProbe {
				status: ProbeStatus::Available,
				version: Some(version.to_owned()),
				failure: None,
			},
			authentication_probe: AuthenticationProbe {
				status: ProbeStatus::Available,
				mode: Some("chatgpt_subscription".to_owned()),
				failure: None,
			},
			models: MODEL_MATRIX
				.iter()
				.map(|model| {
					let observed_at = "unix-ms:1".to_owned();
					let preview = "OK".to_owned();
					let artifacts = vec![adapter::preflight_marker_artifact_reference()];
					let digest =
						format!("sha256:{}", hex::encode(Sha256::digest(preview.as_bytes())));
					let evidence_digest = adapter::configuration_evidence_digest(
						*model,
						Some(&version.to_owned()),
						&observed_at,
						ConfigurationProbeStatus::Available,
						Some(&digest),
						Some(&preview),
						&artifacts,
						None,
					)
					.expect("fixture evidence digest");

					CapabilityValidation {
						model: *model,
						status: CapabilityValidationStatus::Available,
						reason: "fixture available".to_owned(),
						probe: ConfigurationProbe {
							status: ConfigurationProbeStatus::Available,
							codex_version: Some(version.to_owned()),
							observed_at,
							result_digest: Some(digest),
							result_preview: Some(preview),
							artifacts,
							evidence_digest,
							failure: None,
						},
					}
				})
				.collect(),
		}
	}

	fn direct_capacity(
		tasks: &[crate::task::TaskDefinition],
		models: &[crate::model::ModelConfig],
		validation: &CapabilityValidationReport,
		jobs: usize,
	) -> crate::capacity::CapacityCommitment {
		let available = validation
			.models
			.iter()
			.filter(|entry| entry.status == CapabilityValidationStatus::Available)
			.map(|entry| entry.model)
			.collect::<Vec<_>>();
		let unsupported = validation
			.models
			.iter()
			.filter(|entry| entry.status == CapabilityValidationStatus::Unsupported)
			.map(|entry| entry.model)
			.collect::<Vec<_>>();

		capacity::assess_capacity(
			tasks,
			models,
			&available,
			&unsupported,
			&protocol::canonical_hash(validation).expect("preflight digest"),
			jobs,
			43_200,
		)
		.expect("capacity admission")
		.commitment()
		.expect("capacity commitment")
	}

	fn set_capacity_jobs(
		commitments: &mut RunCommitments,
		tasks: &[crate::task::TaskDefinition],
		models: &[crate::model::ModelConfig],
		validation: &CapabilityValidationReport,
		jobs: usize,
	) {
		commitments.capacity = direct_capacity(tasks, models, validation, jobs);
		commitments.runtime_digest = resume::runtime_digest(
			commitments.run_class,
			&commitments.permission_evidence_digest,
			&commitments.model_toolchain_digest,
			&commitments.capacity,
		)
		.expect("runtime digest");

		commitments.provenance.runtime_digest.clone_from(&commitments.runtime_digest);
	}

	fn selected_fixture(
		task_count: usize,
		model_count: usize,
	) -> (
		Vec<crate::task::TaskDefinition>,
		Vec<crate::model::ModelConfig>,
		CapabilityManifest,
		CapabilityValidationReport,
		ScheduleSlot,
		RunCommitments,
	) {
		let tasks = super::synthetic_demo_tasks().into_iter().take(task_count).collect::<Vec<_>>();
		let models = MODEL_MATRIX[..model_count].to_vec();
		let version = "codex fixture".to_owned();
		let node_id = format!("node_{}", "f".repeat(64));
		let validation = selected_validation(&version, node_id.clone());
		let manifest = CapabilityManifest {
			schema_version: "aiq.capabilities.v1".to_owned(),
			node_id,
			observed_at: "fixture".to_owned(),
			codex_version: version,
			models: Vec::new(),
		};
		let slot =
			ScheduleConfig::default().slot("2026-07-25", ScheduleOccurrence::Day).expect("slot");
		let task_set_hash = task::task_set_hash(&tasks).expect("task set hash");
		let evaluator_digest = protocol::canonical_hash(&tasks).expect("evaluator digest");
		let model_toolchain_digest = format!("sha256:{}", "a".repeat(64));
		let permission_evidence_digest = format!("sha256:{}", "a".repeat(64));
		let preflight_digest = protocol::canonical_hash(&validation).expect("preflight digest");
		let capacity = direct_capacity(&tasks, &models, &validation, 1);
		let runtime_digest = resume::runtime_digest(
			RunClass::Calibration,
			&permission_evidence_digest,
			&model_toolchain_digest,
			&capacity,
		)
		.expect("runtime digest");
		let mut provenance = corpus_commitment::fixture_run_provenance_for_class(
			RunClass::Calibration,
			task_set_hash.clone(),
			evaluator_digest.clone(),
			runtime_digest.clone(),
			preflight_digest.clone(),
		);
		let run_id = resume::classified_run_id(
			&slot,
			&task_set_hash,
			&provenance.corpus_commitment_sha256,
			&models,
			RunClass::Calibration,
		)
		.expect("run id");

		provenance.permission_evidence_digest.clone_from(&permission_evidence_digest);

		let commitments = RunCommitments {
			run_id,
			schedule_slot: slot.clone(),
			catalog_digest: resume::catalog_digest(),
			task_set_hash,
			scoring_version: crate::scoring::AIQ_SCORING_VERSION.to_owned(),
			calibration_admission_digest: None,
			calibration_bank: None,
			evaluator_digest,
			runtime_digest,
			model_toolchain_digest,
			capacity,
			models: models.clone(),
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
		};

		(tasks, models, manifest, validation, slot, commitments)
	}

	fn candidate_selected_fixture(
		node_id: String,
	) -> (
		Vec<crate::task::TaskDefinition>,
		Vec<crate::model::ModelConfig>,
		CapabilityManifest,
		CapabilityValidationReport,
		ScheduleSlot,
		RunCommitments,
	) {
		let (mut tasks, models, mut manifest, mut validation, slot, mut commitments) =
			selected_fixture(72, MODEL_MATRIX.len());
		let candidate = candidate_catalog::checked_candidate_catalog_authority()
			.expect("checked candidate catalog");

		candidate.require_frozen_candidate().expect("frozen candidate catalog");

		for (task, expected) in tasks.iter_mut().zip(&candidate.tasks) {
			task.task_id.clone_from(&expected.task_id);

			task.task_version = candidate_catalog::CANDIDATE_TASK_SET_VERSION.to_owned();
			task.domain = expected.domain;
			task.cluster_id = Some(expected.cluster_id.clone());
			task.catalog_entry_digest = Some(expected.catalog_entry_digest.clone());
			task.scorer_version = "1.0.6".to_owned();
		}

		manifest.node_id.clone_from(&node_id);

		validation.node_id = node_id;
		commitments.preflight_digest =
			protocol::canonical_hash(&validation).expect("candidate preflight digest");

		commitments.provenance.preflight_digest.clone_from(&commitments.preflight_digest);

		refresh_selected_task_commitments(&mut commitments, &tasks, &validation);
		set_capacity_jobs(&mut commitments, &tasks, &models, &validation, 8);

		commitments.catalog_digest.clone_from(&candidate.task_metadata_digest);

		commitments.provenance.catalog_digest = candidate.task_metadata_digest;
		commitments.provenance.corpus_release_id =
			"corpus_candidate_qualification_fixture".to_owned();
		commitments.observed_at = "unix-ms:1".to_owned();

		(tasks, models, manifest, validation, slot, commitments)
	}

	fn refresh_selected_task_commitments(
		commitments: &mut RunCommitments,
		tasks: &[TaskDefinition],
		validation: &CapabilityValidationReport,
	) {
		let task_set_hash = task::task_set_hash(tasks).expect("task set hash");
		let evaluator_digest = protocol::canonical_hash(&tasks).expect("evaluator digest");
		let models = commitments.models.clone();

		commitments.task_set_hash.clone_from(&task_set_hash);
		commitments.evaluator_digest.clone_from(&evaluator_digest);

		commitments.provenance.task_set_digest = task_set_hash;
		commitments.provenance.evaluator_digest = evaluator_digest;

		set_capacity_jobs(commitments, tasks, &models, validation, 1);

		commitments.run_id = resume::classified_run_id(
			&commitments.schedule_slot,
			&commitments.task_set_hash,
			&commitments.provenance.corpus_commitment_sha256,
			&models,
			commitments.run_class,
		)
		.expect("run id");
	}

	#[test]
	fn candidate_completed_run_recovery_and_local_package_keep_exact_validation_context() {
		let root = env::temp_dir().join(format!(
			"aiq-candidate-completed-recovery-{}-{}",
			process::id(),
			super::unix_ms()
		));
		let checkpoint_path = root.join("checkpoint.json");
		let workspace =
			TestWorkspace { root: root.join("workspaces"), quarantines: AtomicUsize::new(0) };
		let identity = protocol::SigningIdentity::from_secret([31; 32]);
		let (tasks, _models, manifest, validation, _slot, commitments) =
			candidate_selected_fixture(identity.node().node_id.clone());
		let (executor, stats) = DeterministicExecutor::new(0, None);
		let adapter = CodexAdapter::new(
			executor,
			MemorySink,
			"codex",
			CodexExecutionConfig::isolated(root.join("codex-home")),
		);

		fs::create_dir_all(&root).expect("candidate fixture root");

		let first = runner::execute_selected_run(
			&adapter,
			&workspace,
			&manifest,
			&tasks,
			validation.clone(),
			commitments.clone(),
			runner::LocalRunExecution {
				evaluator: None,
				checkpoint_path: &checkpoint_path,
				jobs: 8,
			},
		)
		.expect("candidate completed run");
		let recovered = runner::execute_selected_run(
			&adapter,
			&workspace,
			&manifest,
			&tasks,
			validation,
			commitments,
			runner::LocalRunExecution {
				evaluator: None,
				checkpoint_path: &checkpoint_path,
				jobs: 8,
			},
		)
		.expect("candidate completed-run recovery");
		let SelectedRun::Calibration(first) = first else { panic!("candidate calibration") };
		let SelectedRun::Calibration(recovered) = recovered else {
			panic!("recovered candidate calibration")
		};

		assert_eq!(stats.calls.lock().expect("candidate call count").len(), 1_224);
		assert_eq!(first.results, recovered.results);

		let validation_context =
			run_validation::CalibrationValidationContext::from_package_provenance(&recovered)
				.expect("candidate package validation context");

		validation_context
			.validate(&first, Some(&tasks))
			.expect("candidate completed run validation");
		validation_context
			.validate(&recovered, Some(&tasks))
			.expect("candidate recovered run validation");

		let mut rebound = recovered.clone();

		rebound.provenance.corpus_commitment_sha256 = format!("sha256:{}", "c".repeat(64));

		assert!(validation_context.validate(&rebound, Some(&tasks)).is_err());

		let active_error = run_validation::validate_calibration_run_record(&recovered)
			.expect_err("active validation must reject candidate provenance");

		assert_eq!(active_error.to_string(), "signed run provenance bindings are invalid");

		let envelope = identity
			.sign(
				&recovered.run_id,
				protocol::CALIBRATION_RUN_PAYLOAD_TYPE,
				&recovered,
				protocol::TrustTier::Untrusted,
			)
			.expect("candidate package signature");
		let active_package_error = submission::serialize_signed_package(&envelope)
			.expect_err("production submission serialization must reject candidate provenance");

		assert!(
			active_package_error.to_string().contains("signed run provenance bindings are invalid")
		);

		let package = submission::serialize_calibration_package_for_local_verification(&envelope)
			.expect("candidate package for local verifier replay");
		let decoded: protocol::SubmissionEnvelope =
			serde_json::from_slice(&package).expect("candidate package JSON");

		decoded.verify(&BTreeSet::new()).expect("candidate package signature");

		assert_eq!(decoded.idempotency_key, recovered.run_id);
		assert_eq!(decoded.content_hash, envelope.content_hash);
		assert_eq!(decoded.signature, envelope.signature);

		fs::remove_dir_all(root).expect("candidate fixture cleanup");
	}

	fn assert_full_calibration_analysis(
		tasks: &[crate::task::TaskDefinition],
		run: &crate::runner::CalibrationRunRecord,
	) {
		run_validation::validate_calibration_run_record_with_tasks(run, tasks)
			.expect("full calibration calibration record");

		for model in run.models.iter().copied() {
			let analysis = scoring::score_calibration_model_with_context(
				tasks,
				&run.results,
				model,
				ScoreContext::default(),
				ScoreOptions { bootstrap_samples: 10, bootstrap_seed: 1 },
			)
			.expect("full calibration analysis");
			let serialized =
				serde_json::to_string(&analysis).expect("calibration analysis serialization");

			assert_eq!(analysis.schema_version, "aiq.calibration-score-report.v2");
			assert_eq!(analysis.run_class, "calibration");
			assert_eq!(analysis.descriptive_status, CalibrationDescriptiveStatus::CompleteFixture);
			assert_eq!(analysis.official_eligible, FalseOnly);
			assert_eq!(analysis.ranking_eligible, FalseOnly);
			assert!(analysis.quality_score.is_some());
			assert!(!serialized.contains("\"tier\""));
			assert!(!serialized.contains("Official"));
			assert!(!serialized.contains("Provisional"));
		}

		let mut drifted_tasks = tasks.to_vec();

		drifted_tasks[0].prompt.push_str(" drift");

		assert!(
			run_validation::validate_calibration_run_record_with_tasks(run, &drifted_tasks)
				.is_err()
		);

		let mut catalog_drifted_tasks = tasks.to_vec();

		catalog_drifted_tasks[0].catalog_entry_digest = Some(format!("sha256:{}", "0".repeat(64)));

		assert!(
			run_validation::validate_calibration_run_record_with_tasks(run, &catalog_drifted_tasks)
				.is_err()
		);

		let mut permuted = run.clone();

		permuted.results.swap(0, 1);

		assert!(run_validation::validate_calibration_run_record(&permuted).is_err());

		let mut reversed_models = run.clone();

		reversed_models.models.reverse();

		assert!(run_validation::validate_calibration_run_record(&reversed_models).is_err());
	}

	#[test]
	fn demo_is_explicitly_synthetic_for_every_result() {
		let slot = ScheduleConfig::default()
			.slot("2026-07-24", ScheduleOccurrence::Day)
			.expect("fixture slot must be valid");
		let scheduled_unix_ms = slot.scheduled_unix_ms().expect("fixture scheduled timestamp");
		let run = runner::synthetic_demo(slot, &runner::TestArtifactSink).expect("demo must build");
		let tasks = super::synthetic_demo_tasks();

		assert!(run.synthetic);
		assert_eq!(run.execution_concurrency, Some(1));
		assert_eq!(run.started_unix_ms, scheduled_unix_ms);
		assert_eq!(run.finished_unix_ms, scheduled_unix_ms);
		assert_eq!(run.models, MODEL_MATRIX);
		assert_eq!(run.results.len(), 1_224);
		assert!(tasks.iter().all(|task| task.validation_issues().is_empty()));
		assert!(tasks.iter().all(|task| task.catalog_entry_digest.is_some()));
		assert!(run.results.iter().all(|result| result.provenance.synthetic));
		assert!(
			run.results
				.iter()
				.all(|result| result.provenance.codex_version == "synthetic-not-invoked")
		);

		let score = scoring::score_model_with_context(
			&tasks,
			&run.results,
			MODEL_MATRIX[0],
			ScoreContext::default(),
			ScoreOptions { bootstrap_samples: 100, bootstrap_seed: 1 },
		)
		.expect("synthetic fixed-fixture score");

		assert_eq!(score.tier, ScoreTier::SyntheticComplete);
		assert!(score.score.is_none());
		assert!(score.quality_score.is_some());
		assert!(!score.ranking_eligible);
	}

	#[test]
	fn official_shape_requires_72_unique_tasks_and_the_complete_model_matrix() {
		let tasks = super::synthetic_demo_tasks();

		assert!(super::run_class_shape_matches(&tasks, &MODEL_MATRIX, RunClass::Official));
		assert!(!super::run_class_shape_matches(
			&tasks[..tasks.len() - 1],
			&MODEL_MATRIX,
			RunClass::Official,
		));
		assert!(!super::run_class_shape_matches(
			&tasks,
			&MODEL_MATRIX[..MODEL_MATRIX.len() - 1],
			RunClass::Official,
		));

		let mut duplicate = tasks.clone();
		let first_task_id = duplicate[0].task_id.clone();

		duplicate.last_mut().expect("last task").task_id = first_task_id;

		assert!(!super::run_class_shape_matches(&duplicate, &MODEL_MATRIX, RunClass::Official,));
		assert!(super::run_class_shape_matches(
			&tasks[..1],
			&MODEL_MATRIX[..1],
			RunClass::Calibration,
		));
	}

	#[test]
	fn task_result_and_evaluator_bundle_bind_the_exact_raw_stdout_digest() {
		let slot = ScheduleConfig::default()
			.slot("2024-02-29", ScheduleOccurrence::Day)
			.expect("fixture slot");
		let raw_digest = format!("sha256:{}", "7".repeat(64));
		let mut result = runner::synthetic_demo(slot, &runner::TestArtifactSink)
			.expect("synthetic run")
			.results
			.remove(0);

		result.evaluator_stdout_sha256 = Some(raw_digest.clone());

		result.bind_evaluator_result_digest().expect("bind evaluator result");

		let evaluator_result = result.evaluator_result().expect("evaluator result");

		assert_eq!(evaluator_result.raw_stdout_sha256.as_deref(), Some(raw_digest.as_str()));
		assert_eq!(
			result.evaluator_result_sha256,
			Some(protocol::canonical_hash(&evaluator_result).expect("evaluator digest"))
		);
	}

	#[test]
	fn full_matrix_calibration_remains_non_official_calibration_output() {
		let (tasks, models, _manifest, validation, slot, commitments) =
			selected_fixture(72, MODEL_MATRIX.len());
		let demo =
			runner::synthetic_demo(slot.clone(), &runner::TestArtifactSink).expect("demo fixture");
		let evaluator_results_artifact = demo.evaluator_results_artifact;
		let mut checkpoint = RunCheckpoint::new(commitments.clone(), 1);

		checkpoint.results = demo.results;
		checkpoint.evaluator_results =
			checkpoint.results.iter().map(|result| result.evaluator_result()).collect();

		for result in &mut checkpoint.results {
			result.run_id.clone_from(&commitments.run_id);

			result.provenance.synthetic = false;

			result.provenance.node_id.clone_from(&validation.node_id);

			result.provenance.codex_version =
				validation.cli_probe.version.clone().expect("fixture Codex version");
			result.provenance.observed_at = "unix-ms:1".to_owned();

			result.artifacts.push(ArtifactReference {
				kind: "workspace-snapshot.json".to_owned(),
				content_hash: format!("sha256:{}", "d".repeat(64)),
				uri: format!("aiq-artifact://sha256/{}/workspace-snapshot.json", "d".repeat(64)),
				bytes: 1,
			});

			result.workspace_manifest = Some(ArtifactReference {
				kind: "workspace-manifest.json".to_owned(),
				content_hash: format!("sha256:{}", "e".repeat(64)),
				uri: format!("aiq-artifact://sha256/{}/workspace-manifest.json", "e".repeat(64)),
				bytes: 1,
			});
			result.result_id = format!(
				"result_{}",
				result.content_hash().expect("result hash").trim_start_matches("sha256:")
			);
		}

		checkpoint.terminal_attempt_lineage = super::terminal_attempt_lineage(&checkpoint.results);

		let selected = super::selected_run_record(
			&tasks,
			&models,
			slot,
			validation.clone(),
			commitments,
			checkpoint,
			evaluator_results_artifact,
			1,
		);
		let SelectedRun::Calibration(run) = selected else {
			panic!("full calibration must not emit an Official RunRecord")
		};

		assert_eq!(run.schema_version, "aiq.calibration-run.v4");
		assert!(!run.official_eligible);
		assert_eq!(run.classification, "local_calibration_non_official");
		assert_eq!(run.provenance.run_class, RunClass::Calibration);
		assert_eq!(run.models, MODEL_MATRIX);
		assert_eq!(run.task_ids.len(), 72);
		assert_eq!(run.results.len(), 1_224);

		assert_full_calibration_analysis(&tasks, &run);

		let mut oversized_reason = run.clone();

		oversized_reason.capability_validation.models[0].reason = "r".repeat(129);

		assert!(run_validation::validate_calibration_run_record(&oversized_reason).is_err());

		let mut oversized_preview = run.clone();

		oversized_preview.capability_validation.models[0].probe.result_preview =
			Some("p".repeat(MAX_INLINE_PREVIEW_BYTES + 1));

		assert!(run_validation::validate_calibration_run_record(&oversized_preview).is_err());

		let mut oversized_version = run.clone();

		oversized_version.capability_validation.cli_probe.version =
			Some("v".repeat(MAX_CODEX_VERSION_BYTES + 1));

		assert!(run_validation::validate_calibration_run_record(&oversized_version).is_err());

		let mut oversized_failure = run.clone();

		oversized_failure.capability_validation.cli_probe.failure = Some(AdapterFailure {
			kind: AdapterFailureKind::NonZeroExit,
			exit_code: Some(1),
			stderr: String::new(),
			message: "f".repeat(129),
			stdout_truncated: false,
			stderr_truncated: false,
			artifacts: Vec::new(),
			stdout_full: String::new(),
		});

		assert!(run_validation::validate_calibration_run_record(&oversized_failure).is_err());

		let mut oversized_result = run;

		oversized_result.results[0].response = Some("🧪".repeat(MAX_RESULT_PREVIEW_BYTES / 2 + 1));

		assert!(run_validation::validate_calibration_run_record(&oversized_result).is_err());
	}

	#[test]
	fn unsupported_calibration_resume_keeps_one_terminal_cell_without_invocation() {
		let root = env::temp_dir().join(format!("aiq-runner-selected-resume-{}", process::id()));
		let path = root.join("checkpoint.json");
		let (tasks, models, manifest, mut validation, _slot, mut commitments) =
			selected_fixture(1, 1);

		commitments.observed_at = "unix-ms:1".to_owned();

		let failure = AdapterFailure {
			kind: AdapterFailureKind::Unsupported,
			exit_code: Some(1),
			stderr: "unsupported".to_owned(),
			message: "unsupported".to_owned(),
			stdout_truncated: false,
			stderr_truncated: false,
			artifacts: Vec::new(),
			stdout_full: String::new(),
		};
		let evidence_digest = adapter::configuration_evidence_digest(
			models[0],
			validation.cli_probe.version.as_ref(),
			"unix-ms:1",
			ConfigurationProbeStatus::ObservedUnsupported,
			None,
			None,
			&[],
			Some(&failure),
		)
		.expect("unsupported evidence digest");

		validation.models[0] = CapabilityValidation {
			model: models[0],
			status: CapabilityValidationStatus::Unsupported,
			reason: "observed unsupported".to_owned(),
			probe: ConfigurationProbe {
				status: ConfigurationProbeStatus::ObservedUnsupported,
				codex_version: validation.cli_probe.version.clone(),
				observed_at: "unix-ms:1".to_owned(),
				result_digest: None,
				result_preview: None,
				artifacts: Vec::new(),
				evidence_digest,
				failure: Some(failure),
			},
		};
		commitments.preflight_digest =
			protocol::canonical_hash(&validation).expect("preflight digest");

		commitments.provenance.preflight_digest.clone_from(&commitments.preflight_digest);

		commitments.capacity = direct_capacity(&tasks, &models, &validation, 1);
		commitments.runtime_digest = resume::runtime_digest(
			RunClass::Calibration,
			&commitments.permission_evidence_digest,
			&commitments.model_toolchain_digest,
			&commitments.capacity,
		)
		.expect("runtime digest");

		commitments.provenance.runtime_digest.clone_from(&commitments.runtime_digest);

		let adapter = CodexAdapter::new(
			NeverExecutor,
			MemorySink,
			"codex",
			CodexExecutionConfig::isolated("/controlled/codex-home"),
		);

		fs::create_dir_all(&root).expect("checkpoint root");

		let first = runner::execute_selected_run(
			&adapter,
			&NeverWorkspace,
			&manifest,
			&tasks,
			validation.clone(),
			commitments.clone(),
			runner::LocalRunExecution { evaluator: None, checkpoint_path: &path, jobs: 1 },
		)
		.expect("first selected run");
		let second = runner::execute_selected_run(
			&adapter,
			&NeverWorkspace,
			&manifest,
			&tasks,
			validation.clone(),
			commitments.clone(),
			runner::LocalRunExecution { evaluator: None, checkpoint_path: &path, jobs: 1 },
		)
		.expect("resumed selected run");

		for run in [first, second] {
			let SelectedRun::Calibration(run) = run else {
				panic!("selected subset must be a calibration")
			};

			assert!(!run.official_eligible);
			assert_eq!(run.classification, "local_calibration_non_official");
			assert_eq!(run.results.len(), 1);
			assert_eq!(run.results[0].status, ResultStatus::Unsupported);

			run_validation::validate_calibration_run_record(&run)
				.expect("single-model calibration retains one complete 17-model preflight");
		}

		assert_removed_terminal_result_rejects_resume(
			&path,
			&adapter,
			&manifest,
			&tasks,
			validation,
			commitments,
		);

		fs::remove_dir_all(root).expect("fixture cleanup");
	}

	fn assert_removed_terminal_result_rejects_resume(
		path: &Path,
		adapter: &CodexAdapter<NeverExecutor, MemorySink>,
		manifest: &CapabilityManifest,
		tasks: &[TaskDefinition],
		validation: CapabilityValidationReport,
		commitments: RunCommitments,
	) {
		let mut checkpoint =
			RunCheckpoint::load(path, &commitments).expect("checkpoint load").expect("checkpoint");

		checkpoint.results.clear();
		checkpoint.evaluator_results.clear();
		checkpoint.persist(path).expect("tampered checkpoint write");

		let error = runner::execute_selected_run(
			adapter,
			&NeverWorkspace,
			manifest,
			tasks,
			validation,
			commitments,
			runner::LocalRunExecution { evaluator: None, checkpoint_path: path, jobs: 1 },
		)
		.expect_err("removing a terminal result must not permit retry");

		assert!(error.to_string().contains("terminal-attempt lineage"));
	}

	#[test]
	fn subscription_limit_retains_checkpoint_and_resumes_unfinished_cells() {
		let root = env::temp_dir().join(format!("aiq-runner-usage-limit-{}", process::id()));
		let checkpoint_path = root.join("checkpoint.json");
		let workspace =
			TestWorkspace { root: root.join("workspaces"), quarantines: AtomicUsize::new(0) };
		let calls = Arc::new(AtomicUsize::new(0));
		let adapter = CodexAdapter::new(
			UsageLimitExecutor(Arc::clone(&calls)),
			MemorySink,
			"codex",
			CodexExecutionConfig::isolated("/controlled/codex-home"),
		);
		let (tasks, _models, manifest, validation, _slot, commitments) = selected_fixture(3, 1);

		fs::create_dir_all(&root).expect("test root");

		let first = runner::execute_selected_run(
			&adapter,
			&workspace,
			&manifest,
			&tasks,
			validation.clone(),
			commitments.clone(),
			runner::LocalRunExecution {
				evaluator: None,
				checkpoint_path: &checkpoint_path,
				jobs: 1,
			},
		)
		.expect_err("usage limit must abort the selected run");

		assert!(first.is_subscription_backpressure());
		assert_eq!(first.exit_code(), runner::SUBSCRIPTION_BACKPRESSURE_EXIT_CODE);

		let checkpoint =
			RunCheckpoint::load(&checkpoint_path, &commitments).expect("load").expect("checkpoint");

		assert!(checkpoint.results.is_empty());
		assert!(checkpoint.in_flight.is_empty());
		assert_eq!(
			checkpoint
				.subscription_backpressure
				.as_ref()
				.map(|backpressure| backpressure.deferred_results.len()),
			Some(1)
		);
		assert_eq!(calls.load(Ordering::SeqCst), 1);

		let resumed = runner::execute_selected_run(
			&adapter,
			&workspace,
			&manifest,
			&tasks,
			validation,
			commitments,
			runner::LocalRunExecution {
				evaluator: None,
				checkpoint_path: &checkpoint_path,
				jobs: 1,
			},
		)
		.expect("recovered subscription capacity must resume the unfinished cells");
		let SelectedRun::Calibration(resumed) = resumed else { panic!("calibration fixture") };

		assert_eq!(resumed.results.len(), 3);
		assert!(resumed.results.iter().all(|result| result.status == ResultStatus::Completed));
		assert_eq!(calls.load(Ordering::SeqCst), 4);

		fs::remove_dir_all(root).expect("cleanup");
	}

	#[test]
	fn concurrent_subscription_limits_leave_every_rejected_cell_pending() {
		let root = env::temp_dir().join(format!(
			"aiq-runner-concurrent-usage-limit-{}-{}",
			process::id(),
			super::unix_ms()
		));
		let checkpoint_path = root.join("checkpoint.json");
		let workspace =
			TestWorkspace { root: root.join("workspaces"), quarantines: AtomicUsize::new(0) };
		let calls = Arc::new(AtomicUsize::new(0));
		let adapter = CodexAdapter::new(
			ConcurrentUsageLimitExecutor {
				calls: Arc::clone(&calls),
				barrier: Arc::new(std::sync::Barrier::new(3)),
			},
			MemorySink,
			"codex",
			CodexExecutionConfig::isolated("/controlled/codex-home"),
		);
		let (tasks, models, manifest, validation, _slot, mut commitments) = selected_fixture(3, 1);

		set_capacity_jobs(&mut commitments, &tasks, &models, &validation, 3);

		fs::create_dir_all(&root).expect("test root");

		let error = runner::execute_selected_run(
			&adapter,
			&workspace,
			&manifest,
			&tasks,
			validation.clone(),
			commitments.clone(),
			runner::LocalRunExecution {
				evaluator: None,
				checkpoint_path: &checkpoint_path,
				jobs: 3,
			},
		)
		.expect_err("concurrent usage limits must defer the selected run");
		let checkpoint =
			RunCheckpoint::load(&checkpoint_path, &commitments).expect("load").expect("checkpoint");

		assert!(error.is_subscription_backpressure());
		assert_eq!(calls.load(Ordering::SeqCst), 3);
		assert!(checkpoint.results.is_empty());
		assert!(checkpoint.in_flight.is_empty());
		assert_eq!(
			checkpoint
				.subscription_backpressure
				.as_ref()
				.map(|backpressure| backpressure.deferred_results.len()),
			Some(3)
		);

		let recovered_calls = Arc::new(AtomicUsize::new(0));
		let recovered_adapter = CodexAdapter::new(
			IncorrectExecutor(Arc::clone(&recovered_calls)),
			MemorySink,
			"codex",
			CodexExecutionConfig::isolated("/controlled/codex-home"),
		);
		let resumed = runner::execute_selected_run(
			&recovered_adapter,
			&workspace,
			&manifest,
			&tasks,
			validation,
			commitments.clone(),
			runner::LocalRunExecution {
				evaluator: None,
				checkpoint_path: &checkpoint_path,
				jobs: 3,
			},
		)
		.expect("recovered capacity must run every deferred cell");
		let SelectedRun::Calibration(resumed) = resumed else { panic!("calibration fixture") };
		let checkpoint =
			RunCheckpoint::load(&checkpoint_path, &commitments).expect("load").expect("checkpoint");

		assert_eq!(recovered_calls.load(Ordering::SeqCst), 3);
		assert_eq!(resumed.results.len(), 3);
		assert!(checkpoint.subscription_backpressure.is_none());

		fs::remove_dir_all(root).expect("cleanup");
	}

	#[test]
	fn legacy_subscription_limit_checkpoint_migrates_without_replacing_completed_work() {
		let root = env::temp_dir().join(format!(
			"aiq-runner-legacy-usage-limit-{}-{}",
			process::id(),
			super::unix_ms()
		));
		let checkpoint_path = root.join("checkpoint.json");
		let workspace =
			TestWorkspace { root: root.join("workspaces"), quarantines: AtomicUsize::new(0) };
		let calls = Arc::new(AtomicUsize::new(0));
		let recovering_adapter = CodexAdapter::new(
			UsageLimitExecutor(Arc::clone(&calls)),
			MemorySink,
			"codex",
			CodexExecutionConfig::isolated("/controlled/codex-home"),
		);
		let successful_calls = Arc::new(AtomicUsize::new(0));
		let completed_adapter = CodexAdapter::new(
			IncorrectExecutor(Arc::clone(&successful_calls)),
			MemorySink,
			"codex",
			CodexExecutionConfig::isolated("/controlled/codex-home"),
		);
		let (tasks, _models, manifest, validation, _slot, commitments) = selected_fixture(3, 1);
		let mut completed = runner::execute_task(
			&completed_adapter,
			&workspace,
			&manifest,
			&tasks[0],
			commitments.models[0],
			&commitments.run_id,
			"codex fixture",
			&commitments.observed_at,
			None,
			None,
		)
		.expect("legacy completed result");
		let mut limited = runner::execute_task(
			&recovering_adapter,
			&workspace,
			&manifest,
			&tasks[1],
			commitments.models[0],
			&commitments.run_id,
			"codex fixture",
			&commitments.observed_at,
			None,
			None,
		)
		.expect("legacy subscription-limit result");

		limited.tool_usage.steps = 4;
		limited.tool_usage.total_calls = 2;

		limited.tool_usage.by_tool.insert("command_execution".to_owned(), 2);
		completed.assign_result_id().expect("completed result identity");
		limited.assign_result_id().expect("limited result identity");

		let completed_result_id = completed.result_id.clone();
		let limited_result_id = limited.result_id.clone();
		let mut checkpoint = RunCheckpoint::new(commitments.clone(), 1);

		assert_eq!(completed.status, ResultStatus::Completed);
		assert!(runner::subscription_limit_result(&limited));

		checkpoint.schema_version = "aiq.run-checkpoint.v8".to_owned();
		checkpoint.results = vec![completed, limited];
		checkpoint.evaluator_results =
			checkpoint.results.iter().map(TaskResult::evaluator_result).collect();
		checkpoint.terminal_attempt_lineage = runner::terminal_attempt_lineage(&checkpoint.results);

		checkpoint.persist(&checkpoint_path).expect("legacy checkpoint persist");

		let migrated_before_resume =
			RunCheckpoint::load(&checkpoint_path, &commitments).expect("load").expect("checkpoint");
		let deferred = migrated_before_resume
			.subscription_backpressure
			.as_ref()
			.and_then(|backpressure| backpressure.deferred_results.first())
			.expect("migrated deferred result");

		assert_eq!(deferred.result_id, limited_result_id);
		assert_eq!(deferred.tool_usage.steps, 4);
		assert_eq!(deferred.tool_usage.total_calls, 2);

		let resumed = runner::execute_selected_run(
			&recovering_adapter,
			&workspace,
			&manifest,
			&tasks,
			validation,
			commitments.clone(),
			runner::LocalRunExecution {
				evaluator: None,
				checkpoint_path: &checkpoint_path,
				jobs: 1,
			},
		)
		.expect("legacy subscription checkpoint must resume");
		let SelectedRun::Calibration(resumed) = resumed else { panic!("calibration fixture") };
		let migrated =
			RunCheckpoint::load(&checkpoint_path, &commitments).expect("load").expect("checkpoint");

		assert_eq!(successful_calls.load(Ordering::SeqCst), 1);
		assert_eq!(calls.load(Ordering::SeqCst), 3);
		assert_eq!(resumed.results.len(), 3);
		assert!(resumed.results.iter().any(|result| result.result_id == completed_result_id));
		assert!(resumed.results.iter().all(|result| result.result_id != limited_result_id));
		assert_eq!(migrated.schema_version, resume::CHECKPOINT_SCHEMA_VERSION);
		assert!(migrated.subscription_backpressure.is_none());

		fs::remove_dir_all(root).expect("cleanup");
	}

	#[test]
	fn retryable_nonzero_exit_retries_the_cell_and_accumulates_auxiliary_evidence() {
		let root = env::temp_dir().join(format!(
			"aiq-runner-cell-retry-{}-{}",
			process::id(),
			super::unix_ms()
		));
		let checkpoint_path = root.join("checkpoint.json");
		let workspace =
			TestWorkspace { root: root.join("workspaces"), quarantines: AtomicUsize::new(0) };
		let calls = Arc::new(AtomicUsize::new(0));
		let objects = Arc::new(Mutex::new(BTreeMap::new()));
		let adapter = CodexAdapter::new(
			RetryThenSuccessExecutor { calls: Arc::clone(&calls) },
			RecordingSink { objects: Arc::clone(&objects) },
			"codex",
			CodexExecutionConfig::isolated(root.join("codex-home")),
		);
		let (tasks, _models, manifest, validation, _slot, mut commitments) = selected_fixture(1, 1);

		commitments.observed_at = "unix-ms:1".to_owned();

		fs::create_dir_all(&root).expect("test root");

		let selected = runner::execute_selected_run(
			&adapter,
			&workspace,
			&manifest,
			&tasks,
			validation,
			commitments,
			runner::LocalRunExecution {
				evaluator: None,
				checkpoint_path: &checkpoint_path,
				jobs: 1,
			},
		)
		.expect("retryable process failure must continue the same cell");
		let SelectedRun::Calibration(run) = selected else { panic!("calibration fixture") };
		let result = run.results.first().expect("selected result");
		let stdout = String::from_utf8(
			objects
				.lock()
				.expect("recording sink lock")
				.get("stdout.jsonl")
				.expect("combined stdout")
				.clone(),
		)
		.expect("UTF-8 stdout");

		assert_eq!(calls.load(Ordering::SeqCst), 2);
		assert_eq!(workspace.quarantines.load(Ordering::SeqCst), 1);
		assert_eq!(result.status, ResultStatus::Completed);
		assert_eq!(result.evaluation, EvaluationOutcome::Correct);
		assert!(result.failure.is_none());
		assert_eq!(result.tool_usage.steps, 2);
		assert_eq!(result.tool_usage.total_calls, 0);
		assert_eq!(result.tool_usage.provider_tokens.input, Some(18));
		assert_eq!(result.tool_usage.provider_tokens.output, Some(8));
		assert_eq!(result.tool_usage.provider_tokens.total, Some(26));
		assert_eq!(stdout.matches(r#""type":"aiq.invocation-attempt.v1""#).count(), 2);

		run_validation::validate_calibration_run_record_with_tasks(&run, &tasks)
			.expect("retry result must satisfy the selected-run contract");
		runner::validate_invocation_attempt_evidence(result, &stdout)
			.expect("retry evidence must replay");

		let mut wrong_latency = result.clone();

		wrong_latency.latency.wall_ms = wrong_latency.latency.wall_ms.saturating_add(1);

		assert!(runner::validate_invocation_attempt_evidence(&wrong_latency, &stdout).is_err());
		assert!(
			runner::validate_invocation_attempt_evidence(
				result,
				&stdout.replacen(r#""attempt":2"#, r#""attempt":3"#, 1),
			)
			.is_err()
		);

		fs::remove_dir_all(root).expect("cleanup");
	}

	#[test]
	fn semantic_incorrect_result_is_not_retried() {
		let root = env::temp_dir().join(format!(
			"aiq-runner-no-semantic-retry-{}-{}",
			process::id(),
			super::unix_ms()
		));
		let checkpoint_path = root.join("checkpoint.json");
		let workspace =
			TestWorkspace { root: root.join("workspaces"), quarantines: AtomicUsize::new(0) };
		let calls = Arc::new(AtomicUsize::new(0));
		let adapter = CodexAdapter::new(
			IncorrectExecutor(Arc::clone(&calls)),
			MemorySink,
			"codex",
			CodexExecutionConfig::isolated(root.join("codex-home")),
		);
		let (tasks, _models, manifest, validation, _slot, commitments) = selected_fixture(1, 1);

		fs::create_dir_all(&root).expect("test root");

		let selected = runner::execute_selected_run(
			&adapter,
			&workspace,
			&manifest,
			&tasks,
			validation,
			commitments,
			runner::LocalRunExecution {
				evaluator: None,
				checkpoint_path: &checkpoint_path,
				jobs: 1,
			},
		)
		.expect("semantic incorrect is a completed observation");
		let SelectedRun::Calibration(run) = selected else { panic!("calibration fixture") };
		let result = run.results.first().expect("selected result");

		assert_eq!(calls.load(Ordering::SeqCst), 1);
		assert_eq!(workspace.quarantines.load(Ordering::SeqCst), 0);
		assert_eq!(result.status, ResultStatus::Completed);
		assert_eq!(result.evaluation, EvaluationOutcome::Incorrect);
		assert_eq!(result.task_score, Some(0.0));

		fs::remove_dir_all(root).expect("cleanup");
	}

	#[test]
	fn failed_stdout_retention_commits_only_replayable_default_counters_and_aborts() {
		let root = env::temp_dir().join(format!(
			"aiq-runner-sink-failure-{}-{}",
			process::id(),
			super::unix_ms()
		));
		let checkpoint_path = root.join("checkpoint.json");
		let workspace =
			TestWorkspace { root: root.join("workspaces"), quarantines: AtomicUsize::new(0) };
		let adapter = CodexAdapter::new(
			FailureEvidenceExecutor { timed_out: false },
			FailingSink,
			"codex",
			CodexExecutionConfig::isolated(root.join("codex-home")),
		);
		let (tasks, _models, manifest, validation, _slot, commitments) = selected_fixture(1, 1);

		fs::create_dir_all(&root).expect("test root");

		let error = runner::execute_selected_run(
			&adapter,
			&workspace,
			&manifest,
			&tasks,
			validation,
			commitments.clone(),
			runner::LocalRunExecution {
				evaluator: None,
				checkpoint_path: &checkpoint_path,
				jobs: 1,
			},
		)
		.expect_err("evidence loss must abort the paid run");

		assert!(error.to_string().contains("paid-run boundary failure"));

		let checkpoint =
			RunCheckpoint::load(&checkpoint_path, &commitments).expect("load").expect("checkpoint");
		let result = checkpoint.results.first().expect("workspace-integrity checkpoint result");

		assert_eq!(
			result.failure.as_ref().map(|failure| failure.kind),
			Some(FailureKind::WorkspaceIntegrity)
		);
		assert_eq!(result.tool_usage, runner::ToolUsage::default());
		assert!(result.artifacts.is_empty());
		assert!(result.workspace_manifest.is_none());
		assert!(runner::aborts_paid_run(result));

		fs::remove_dir_all(root).expect("cleanup");
	}

	#[test]
	fn concurrent_workers_overlap_commit_sorted_unique_snapshots_and_preserve_canonical_order() {
		let root = env::temp_dir().join(format!("aiq-runner-concurrent-{}", process::id()));
		let checkpoint_path = root.join("checkpoint.json");
		let workspace =
			TestWorkspace { root: root.join("workspaces"), quarantines: AtomicUsize::new(0) };
		let (executor, stats) = DeterministicExecutor::new(15, None);
		let adapter = CodexAdapter::new(
			executor,
			MemorySink,
			"codex",
			CodexExecutionConfig::isolated("/controlled/codex-home"),
		);
		let (tasks, models, manifest, validation, _slot, mut commitments) = selected_fixture(4, 2);

		set_capacity_jobs(&mut commitments, &tasks, &models, &validation, 4);

		fs::create_dir_all(&root).expect("test root");

		let done = Arc::new(AtomicBool::new(false));
		let snapshots = Arc::new(Mutex::new(Vec::<RunCheckpoint>::new()));
		let monitor = {
			let done = Arc::clone(&done);
			let snapshots = Arc::clone(&snapshots);
			let checkpoint_path = checkpoint_path.clone();

			thread::spawn(move || {
				while !done.load(Ordering::Acquire) {
					if let Ok(bytes) = fs::read(&checkpoint_path)
						&& let Ok(checkpoint) = serde_json::from_slice(&bytes)
					{
						snapshots.lock().expect("snapshot lock").push(checkpoint);
					}

					thread::sleep(Duration::from_millis(2));
				}
			})
		};
		let run = runner::execute_selected_run(
			&adapter,
			&workspace,
			&manifest,
			&tasks,
			validation,
			commitments,
			runner::LocalRunExecution {
				evaluator: None,
				checkpoint_path: &checkpoint_path,
				jobs: 4,
			},
		)
		.expect("concurrent run");

		done.store(true, Ordering::Release);
		monitor.join().expect("monitor");

		let SelectedRun::Calibration(run) = run else { panic!("calibration fixture") };
		let expected = models
			.iter()
			.flat_map(|model| tasks.iter().map(move |task| (*model, task.task_id.clone())))
			.collect::<Vec<_>>();
		let actual = run
			.results
			.iter()
			.map(|result| (result.model, result.task_id.clone()))
			.collect::<Vec<_>>();

		assert!(stats.max_active.load(Ordering::SeqCst) > 1);
		assert_eq!(actual, expected);
		assert_eq!(actual.iter().collect::<BTreeSet<_>>().len(), actual.len());

		let snapshots = snapshots.lock().expect("snapshot lock");

		assert!(snapshots.len() > 1);

		for snapshot in snapshots.iter() {
			let pairs = snapshot
				.results
				.iter()
				.map(|result| (result.model, result.task_id.clone()))
				.collect::<Vec<_>>();
			let indexes = pairs
				.iter()
				.map(|pair| {
					expected.iter().position(|expected| expected == pair).expect("known pair")
				})
				.collect::<Vec<_>>();

			assert!(indexes.windows(2).all(|window| window[0] < window[1]));
			assert_eq!(indexes.iter().collect::<BTreeSet<_>>().len(), indexes.len());
		}

		fs::remove_dir_all(root).expect("cleanup");
	}

	#[test]
	fn injected_crash_quarantines_an_indeterminate_paid_cell_without_retrying_it() {
		let root = env::temp_dir().join(format!("aiq-runner-crash-resume-{}", process::id()));
		let checkpoint_path = root.join("checkpoint.json");
		let workspace =
			TestWorkspace { root: root.join("workspaces"), quarantines: AtomicUsize::new(0) };
		let (executor, stats) = DeterministicExecutor::new(0, Some(2));
		let adapter = CodexAdapter::new(
			executor,
			MemorySink,
			"codex",
			CodexExecutionConfig::isolated("/controlled/codex-home"),
		);
		let (tasks, _models, manifest, validation, _slot, commitments) = selected_fixture(3, 1);

		fs::create_dir_all(&root).expect("test root");

		let crashed = panic::catch_unwind(AssertUnwindSafe(|| {
			let _ = runner::execute_selected_run(
				&adapter,
				&workspace,
				&manifest,
				&tasks,
				validation.clone(),
				commitments.clone(),
				runner::LocalRunExecution {
					evaluator: None,
					checkpoint_path: &checkpoint_path,
					jobs: 1,
				},
			);
		}));

		assert!(crashed.is_err());

		let partial =
			RunCheckpoint::load(&checkpoint_path, &commitments).expect("load").expect("checkpoint");

		assert_eq!(partial.results.len(), 1);
		assert_eq!(partial.in_flight.len(), 1);
		assert_eq!(stats.calls.lock().expect("calls").len(), 2);

		let resume_error = runner::execute_selected_run(
			&adapter,
			&workspace,
			&manifest,
			&tasks,
			validation,
			commitments,
			runner::LocalRunExecution {
				evaluator: None,
				checkpoint_path: &checkpoint_path,
				jobs: 1,
			},
		)
		.expect_err("an indeterminate paid cell must fail closed");

		assert!(resume_error.to_string().contains("indeterminate paid cell"));
		assert_eq!(stats.calls.lock().expect("calls").len(), 2);
		assert_eq!(workspace.quarantines.load(Ordering::SeqCst), 1);

		fs::remove_dir_all(root).expect("cleanup");
	}

	#[test]
	fn interrupted_evaluator_resumes_from_sealed_evidence_without_model_reexecution() {
		let root = env::temp_dir().join(format!(
			"aiq-runner-evaluator-resume-{}-{}",
			process::id(),
			super::unix_ms()
		));
		let checkpoint_path = root.join("checkpoint.json");
		let workspace_root = root.join("workspaces");

		fs::create_dir_all(&workspace_root).expect("workspace root");

		let workspace =
			TestWorkspace { root: workspace_root.clone(), quarantines: AtomicUsize::new(0) };
		let calls = Arc::new(AtomicUsize::new(0));
		let adapter = CodexAdapter::new(
			IncorrectExecutor(Arc::clone(&calls)),
			MemorySink,
			"codex",
			CodexExecutionConfig::isolated("/controlled/codex-home"),
		);
		let (tasks, _models, manifest, validation, _slot, mut commitments) = selected_fixture(1, 1);

		commitments.execution_root = fs::canonicalize(&workspace_root)
			.expect("canonical workspace root")
			.display()
			.to_string();

		let marker = InFlightCell {
			task_id: tasks[0].task_id.clone(),
			task_version: tasks[0].task_version.clone(),
			model: commitments.models[0],
		};
		let mut checkpoint = RunCheckpoint::new(commitments.clone(), 1);

		checkpoint.in_flight.push(marker);
		checkpoint.persist(&checkpoint_path).expect("initial in-flight checkpoint");

		let interrupted = panic::catch_unwind(AssertUnwindSafe(|| {
			let mut evaluator_ready = |pending: &PendingEvaluation| {
				checkpoint.in_flight.clear();
				checkpoint.pending_evaluations.push(pending.clone());
				checkpoint.persist(&checkpoint_path).expect("pending evaluator checkpoint");

				panic!("simulated external termination after evaluator checkpoint");
			};
			let _ = runner::execute_task_attempt(
				&adapter,
				&workspace,
				&manifest,
				&tasks[0],
				commitments.models[0],
				&commitments.run_id,
				"codex fixture",
				&commitments.observed_at,
				None,
				None,
				Some(&mut evaluator_ready),
			);
		}));

		assert!(interrupted.is_err());
		assert_eq!(calls.load(Ordering::SeqCst), 1);

		let interrupted_checkpoint =
			RunCheckpoint::load(&checkpoint_path, &commitments).expect("load").expect("checkpoint");
		let retained = interrupted_checkpoint.pending_evaluations[0].sealed_workspace.clone();

		assert!(interrupted_checkpoint.in_flight.is_empty());
		assert_eq!(interrupted_checkpoint.pending_evaluations.len(), 1);
		assert!(retained.is_dir());

		let resumed = runner::execute_selected_run(
			&adapter,
			&workspace,
			&manifest,
			&tasks,
			validation,
			commitments.clone(),
			runner::LocalRunExecution {
				evaluator: None,
				checkpoint_path: &checkpoint_path,
				jobs: 1,
			},
		)
		.expect("pending evaluator work must resume without a model call");
		let SelectedRun::Calibration(run) = resumed else { panic!("calibration fixture") };
		let completed =
			RunCheckpoint::load(&checkpoint_path, &commitments).expect("load").expect("checkpoint");

		assert_eq!(calls.load(Ordering::SeqCst), 1);
		assert_eq!(run.results.len(), 1);
		assert_eq!(run.results[0].status, ResultStatus::Completed);
		assert_eq!(run.results[0].response.as_deref(), Some("WRONG"));
		assert!(completed.pending_evaluations.is_empty());
		assert!(!retained.exists());

		fs::remove_dir_all(root).expect("cleanup");
	}

	#[cfg(unix)]
	#[test]
	fn retryable_evaluator_failure_stays_pending_and_replays_without_model_reexecution() {
		let root = env::temp_dir().join(format!(
			"aiq-runner-retryable-evaluator-{}-{}",
			process::id(),
			super::unix_ms()
		));
		let checkpoint_path = root.join("checkpoint.json");
		let workspace_root = root.join("workspaces");
		let evaluator_root = root.join("evaluators");

		fs::create_dir_all(&workspace_root).expect("workspace root");
		fs::create_dir(&evaluator_root).expect("evaluator root");

		let workspace =
			TestWorkspace { root: workspace_root.clone(), quarantines: AtomicUsize::new(0) };
		let calls = Arc::new(AtomicUsize::new(0));
		let adapter = CodexAdapter::new(
			IncorrectExecutor(Arc::clone(&calls)),
			MemorySink,
			"codex",
			CodexExecutionConfig::isolated(root.join("codex-home")),
		);
		let (mut tasks, _models, manifest, validation, _slot, mut commitments) =
			selected_fixture(1, 1);
		let (binding, runtime) = transient_execution_evaluator(&evaluator_root);

		tasks[0].evaluator = Some(Evaluator {
			kind: "repository_test_suite".to_owned(),
			expected: None,
			case_sensitive: false,
			external: Some(binding),
		});
		commitments.execution_root = fs::canonicalize(&workspace_root)
			.expect("canonical workspace root")
			.display()
			.to_string();

		refresh_selected_task_commitments(&mut commitments, &tasks, &validation);

		let first = runner::execute_selected_run(
			&adapter,
			&workspace,
			&manifest,
			&tasks,
			validation.clone(),
			commitments.clone(),
			runner::LocalRunExecution {
				evaluator: Some((&evaluator_root, &runtime)),
				checkpoint_path: &checkpoint_path,
				jobs: 1,
			},
		)
		.expect_err("retryable evaluator failure must not produce a terminal run");
		let pending =
			RunCheckpoint::load(&checkpoint_path, &commitments).expect("load").expect("checkpoint");
		let retained = pending.pending_evaluations[0].sealed_workspace.clone();
		let response_sha256 = pending.pending_evaluations[0].response_sha256.clone();

		assert!(first.to_string().contains("retryable evaluator failure"));
		assert_eq!(calls.load(Ordering::SeqCst), 1);
		assert!(pending.results.is_empty());
		assert!(pending.evaluator_results.is_empty());
		assert_eq!(pending.pending_evaluations.len(), 1);
		assert_eq!(pending.pending_evaluations[0].final_response, "WRONG");
		assert!(retained.is_dir());

		let second = runner::execute_selected_run(
			&adapter,
			&workspace,
			&manifest,
			&tasks,
			validation.clone(),
			commitments.clone(),
			runner::LocalRunExecution {
				evaluator: Some((&evaluator_root, &runtime)),
				checkpoint_path: &checkpoint_path,
				jobs: 1,
			},
		)
		.expect_err("a resumed evaluator failure must stay pending");
		let still_pending =
			RunCheckpoint::load(&checkpoint_path, &commitments).expect("load").expect("checkpoint");

		assert!(second.to_string().contains("retryable evaluator failure"));
		assert_eq!(calls.load(Ordering::SeqCst), 1);
		assert_eq!(still_pending.results, pending.results);
		assert_eq!(still_pending.evaluator_results, pending.evaluator_results);
		assert_eq!(still_pending.pending_evaluations, pending.pending_evaluations);
		assert!(retained.is_dir());

		let resumed = runner::execute_selected_run(
			&adapter,
			&workspace,
			&manifest,
			&tasks,
			validation,
			commitments.clone(),
			runner::LocalRunExecution {
				evaluator: Some((&evaluator_root, &runtime)),
				checkpoint_path: &checkpoint_path,
				jobs: 1,
			},
		)
		.expect("pending evaluator must replay without a model call");
		let SelectedRun::Calibration(run) = resumed else { panic!("calibration fixture") };
		let completed =
			RunCheckpoint::load(&checkpoint_path, &commitments).expect("load").expect("checkpoint");

		assert_eq!(calls.load(Ordering::SeqCst), 1);
		assert_eq!(run.results.len(), 1);
		assert_eq!(run.results[0].status, ResultStatus::Completed);
		assert_eq!(run.results[0].response.as_deref(), Some("WRONG"));
		assert_eq!(run.results[0].response_sha256.as_ref(), Some(&response_sha256));
		assert!(completed.pending_evaluations.is_empty());
		assert!(!retained.exists());

		fs::remove_dir_all(root).expect("cleanup");
	}

	#[test]
	fn checkpoint_before_the_paid_boundary_can_resume_without_duplicate_spend() {
		let root = env::temp_dir().join(format!("aiq-runner-pre-call-resume-{}", process::id()));
		let checkpoint_path = root.join("checkpoint.json");
		let workspace =
			TestWorkspace { root: root.join("workspaces"), quarantines: AtomicUsize::new(0) };
		let (executor, stats) = DeterministicExecutor::new(0, None);
		let adapter = CodexAdapter::new(
			executor,
			MemorySink,
			"codex",
			CodexExecutionConfig::isolated("/controlled/codex-home"),
		);
		let (tasks, _models, manifest, validation, _slot, commitments) = selected_fixture(1, 1);

		fs::create_dir_all(&root).expect("test root");
		RunCheckpoint::new(commitments.clone(), 1)
			.persist(&checkpoint_path)
			.expect("persist pre-call checkpoint");

		let selected = runner::execute_selected_run(
			&adapter,
			&workspace,
			&manifest,
			&tasks,
			validation,
			commitments,
			runner::LocalRunExecution {
				evaluator: None,
				checkpoint_path: &checkpoint_path,
				jobs: 1,
			},
		)
		.expect("pre-call checkpoint can resume");
		let SelectedRun::Calibration(run) = selected else { panic!("calibration fixture") };

		assert_eq!(run.results.len(), 1);
		assert_eq!(stats.calls.lock().expect("calls").len(), 1);

		fs::remove_dir_all(root).expect("cleanup");
	}

	#[test]
	fn jobs_bounds_capacity_and_canonical_result_semantics_are_stable() {
		let (tasks, models, manifest, validation, _slot, commitments) = selected_fixture(3, 2);

		assert!(runner::estimate_capacity(&tasks, &models, 0).is_err());
		assert!(runner::estimate_capacity(&tasks, &models, MAX_RUN_JOBS + 1).is_err());

		let estimate = runner::estimate_capacity(&tasks, &models, 2).expect("estimate");

		assert_eq!(estimate.selected_cells, 6);
		assert_eq!(
			estimate.declared_wall_budget_sum_seconds,
			Some(tasks.iter().filter_map(|task| task.budgets.wall_seconds).sum::<u64>() * 2)
		);
		assert!(!estimate.feasibility_assessed);

		let mut unbounded_tasks = tasks.clone();

		for task in &mut unbounded_tasks {
			task.budgets.wall_seconds = None;
		}

		let unbounded = runner::estimate_capacity(&unbounded_tasks, &models, 2)
			.expect("unbounded estimate remains descriptive");

		assert_eq!(unbounded.schema_version, "aiq.capacity-estimate.v2");
		assert_eq!(unbounded.declared_wall_budget_sum_seconds, None);
		assert_eq!(unbounded.declared_wall_budget_critical_path_seconds, None);
		assert!(!unbounded.feasibility_assessed);

		let request = super::task_invocation_request(
			&unbounded_tasks[0],
			models[0],
			&TaskExecutionContext {
				workspace_dir: PathBuf::from("/controlled/workspace"),
				sandbox: SandboxPolicy::WorkspaceWrite,
			},
		);

		assert_eq!(request.timeout, None);
		assert_eq!(request.max_steps, unbounded_tasks[0].budgets.max_steps);
		assert_eq!(request.max_tool_calls, unbounded_tasks[0].budgets.max_tool_calls);

		let run_once = |label: &str, jobs| {
			let root = env::temp_dir()
				.join(format!("aiq-runner-byte-stability-{label}-{}", process::id()));

			fs::create_dir_all(&root).expect("root");

			let workspace =
				TestWorkspace { root: root.join("workspaces"), quarantines: AtomicUsize::new(0) };
			let (executor, _stats) = DeterministicExecutor::new(0, None);
			let adapter = CodexAdapter::new(
				executor,
				MemorySink,
				"codex",
				CodexExecutionConfig::isolated("/controlled/codex-home"),
			);
			let mut commitments = commitments.clone();

			set_capacity_jobs(&mut commitments, &tasks, &models, &validation, jobs);

			let selected = runner::execute_selected_run(
				&adapter,
				&workspace,
				&manifest,
				&tasks,
				validation.clone(),
				commitments,
				runner::LocalRunExecution {
					evaluator: None,
					checkpoint_path: &root.join("checkpoint.json"),
					jobs,
				},
			)
			.expect("selected");
			let SelectedRun::Calibration(mut selected) = selected else { panic!("calibration") };

			for result in &mut selected.results {
				result.latency.wall_ms = 0;

				result.result_id.clear();
			}

			let bytes = protocol::canonical_json(&selected.results).expect("canonical results");

			fs::remove_dir_all(root).expect("cleanup");

			bytes
		};

		assert_eq!(run_once("one", 1), run_once("four", 4));
	}

	#[test]
	fn local_workspace_provider_derives_safe_write_policy() {
		let root = env::temp_dir().join(format!("aiq-runner-workspace-provider-{}", process::id()));
		let baseline_root = root.join("baseline");
		let execution_root = root.join("execution");
		let mut task = runner::synthetic_tasks()
			.into_iter()
			.next()
			.expect("synthetic fixture must contain a task");

		task.allowed_tools = vec!["filesystem_write".to_owned()];

		let task_root = baseline_root.join(&task.task_id);

		fs::create_dir_all(&task_root).expect("fixture workspace must be created");
		fs::write(task_root.join("pristine.txt"), "baseline").expect("baseline file");

		let provider = LocalDirectoryWorkspaceProvider::new(
			&baseline_root,
			&execution_root,
			committed_baseline_digests(&baseline_root, slice::from_ref(&task)),
		)
		.expect("fixture roots must resolve");
		let first = provider
			.context("run_fixture", MODEL_MATRIX[0], &task)
			.expect("first model workspace must resolve");
		let second = provider
			.context("run_fixture", MODEL_MATRIX[1], &task)
			.expect("second model workspace must resolve");

		assert_ne!(first.workspace_dir, second.workspace_dir);
		assert_eq!(first.sandbox, SandboxPolicy::WorkspaceWrite);
		assert_eq!(second.sandbox, SandboxPolicy::WorkspaceWrite);
		assert_eq!(
			fs::read_to_string(first.workspace_dir.join("pristine.txt")).ok().as_deref(),
			Some("baseline")
		);
		assert_eq!(
			fs::read_to_string(second.workspace_dir.join("pristine.txt")).ok().as_deref(),
			Some("baseline")
		);

		fs::write(first.workspace_dir.join("pristine.txt"), "changed by first model")
			.expect("first model can change its copy");

		assert_eq!(
			fs::read_to_string(task_root.join("pristine.txt")).ok().as_deref(),
			Some("baseline")
		);
		assert_eq!(
			fs::read_to_string(second.workspace_dir.join("pristine.txt")).ok().as_deref(),
			Some("baseline")
		);
		assert!(
			provider.context("run_fixture", MODEL_MATRIX[0], &task).is_err(),
			"an existing destination must not be treated as an implicit resume"
		);

		fs::remove_dir_all(&root).expect("fixture workspace must be removed");
	}

	#[test]
	fn local_workspace_provider_creates_shared_parents_concurrently() {
		let root =
			env::temp_dir().join(format!("aiq-runner-workspace-concurrency-{}", process::id()));
		let baseline_root = root.join("baseline");
		let execution_root = root.join("execution");
		let tasks = runner::synthetic_tasks().into_iter().take(8).collect::<Vec<_>>();

		for task in &tasks {
			let task_root = baseline_root.join(&task.task_id);

			fs::create_dir_all(&task_root).expect("fixture workspace must be created");
			fs::write(task_root.join("pristine.txt"), &task.task_id).expect("baseline file");
		}

		let provider = Arc::new(
			LocalDirectoryWorkspaceProvider::new(
				&baseline_root,
				&execution_root,
				committed_baseline_digests(&baseline_root, &tasks),
			)
			.expect("fixture roots must resolve"),
		);
		let barrier = Arc::new(Barrier::new(tasks.len()));
		let contexts = thread::scope(|scope| {
			let handles = tasks
				.iter()
				.map(|task| {
					let provider = Arc::clone(&provider);
					let barrier = Arc::clone(&barrier);

					scope.spawn(move || {
						barrier.wait();

						provider.context("run_concurrent", MODEL_MATRIX[0], task)
					})
				})
				.collect::<Vec<_>>();

			handles
				.into_iter()
				.map(|handle| handle.join().expect("workspace worker must not panic"))
				.collect::<Result<Vec<_>, _>>()
		})
		.expect("all concurrent workspaces must resolve");
		let paths =
			contexts.iter().map(|context| context.workspace_dir.clone()).collect::<BTreeSet<_>>();

		assert_eq!(paths.len(), tasks.len());

		for (task, context) in tasks.iter().zip(contexts) {
			assert_eq!(
				fs::read_to_string(context.workspace_dir.join("pristine.txt"))
					.expect("workspace file"),
				task.task_id
			);
		}

		fs::remove_dir_all(&root).expect("fixture workspace must be removed");
	}

	#[test]
	fn local_workspace_provider_hashes_the_copied_tree_against_the_committed_digest() {
		let root =
			env::temp_dir().join(format!("aiq-runner-workspace-commitment-{}", process::id()));
		let baseline_root = root.join("baseline");
		let execution_root = root.join("execution");
		let task = runner::synthetic_tasks().remove(0);
		let task_root = baseline_root.join(&task.task_id);

		fs::create_dir_all(&task_root).expect("fixture workspace must be created");
		fs::write(task_root.join("pristine.txt"), "committed").expect("baseline file");

		let commitments = committed_baseline_digests(&baseline_root, slice::from_ref(&task));

		fs::write(task_root.join("pristine.txt"), "mutated after review").expect("mutate baseline");

		let provider =
			LocalDirectoryWorkspaceProvider::new(&baseline_root, &execution_root, commitments)
				.expect("fixture roots must resolve");
		let error = provider
			.context("run_mutated", MODEL_MATRIX[0], &task)
			.expect_err("mutated copied bytes must fail closed");

		assert!(error.to_string().contains("committed baseline digest"));

		fs::remove_dir_all(&root).expect("fixture workspace must be removed");
	}

	#[test]
	fn local_workspace_provider_requires_a_committed_task_digest_and_safe_task_path() {
		let root = env::temp_dir().join(format!("aiq-runner-workspace-identity-{}", process::id()));
		let baseline_root = root.join("baseline");
		let execution_root = root.join("execution");
		let mut task = runner::synthetic_tasks().remove(0);

		fs::create_dir_all(baseline_root.join(&task.task_id))
			.expect("fixture workspace must be created");

		let provider =
			LocalDirectoryWorkspaceProvider::new(&baseline_root, &execution_root, BTreeMap::new())
				.expect("fixture roots must resolve");

		assert!(provider.context("run_missing", MODEL_MATRIX[0], &task).is_err());

		task.task_id = "../escape".to_owned();

		assert!(provider.context("run_unsafe", MODEL_MATRIX[0], &task).is_err());

		fs::remove_dir_all(&root).expect("fixture workspace must be removed");
	}

	#[cfg(unix)]
	#[test]
	fn local_workspace_provider_rejects_symlinks_and_special_files_before_execution() {
		let root = PathBuf::from("/tmp").join(format!("aiq-wt-{}", process::id()));
		let baseline_root = root.join("baseline");
		let execution_root = root.join("execution");
		let tasks = runner::synthetic_tasks().into_iter().take(2).collect::<Vec<_>>();
		let symlink_root = baseline_root.join(&tasks[0].task_id);
		let special_root = baseline_root.join(&tasks[1].task_id);

		fs::create_dir_all(&symlink_root).expect("symlink fixture root");
		fs::write(symlink_root.join("target.txt"), "target").expect("symlink target");
		std::os::unix::fs::symlink("target.txt", symlink_root.join("link.txt"))
			.expect("fixture symlink");
		fs::create_dir_all(&special_root).expect("special fixture root");

		let listener =
			UnixListener::bind(special_root.join("socket")).expect("fixture Unix-domain socket");
		let commitments = tasks
			.iter()
			.map(|task| (task.task_id.clone(), format!("sha256:{}", "a".repeat(64))))
			.collect();
		let provider =
			LocalDirectoryWorkspaceProvider::new(&baseline_root, &execution_root, commitments)
				.expect("fixture roots must resolve");

		assert!(provider.context("run_types", MODEL_MATRIX[0], &tasks[0]).is_err());
		assert!(provider.context("run_types", MODEL_MATRIX[0], &tasks[1]).is_err());

		drop(listener);

		fs::remove_dir_all(&root).expect("fixture workspace must be removed");
	}

	#[cfg(unix)]
	#[test]
	fn sealed_workspace_drives_evaluation_and_snapshot_after_source_mutation() {
		let root = env::temp_dir().join(format!(
			"aiq-runner-sealed-evidence-{}-{}",
			process::id(),
			super::unix_ms()
		));
		let source = root.join("candidate");
		let evaluator_root = root.join("evaluators");
		let artifact_root = root.join("artifacts");

		fs::create_dir_all(&source).expect("source workspace");
		fs::create_dir(&evaluator_root).expect("evaluator root");
		fs::write(source.join("answer.txt"), "sealed answer\n").expect("source answer");

		let sealed = super::SealedWorkspace::create(&source).expect("sealed workspace");
		let sealed_path = sealed.path().to_owned();
		let canonical_source_parent = fs::canonicalize(source.parent().expect("source parent"))
			.expect("canonical source parent");

		assert_eq!(sealed_path.parent(), Some(canonical_source_parent.as_path()));
		assert_ne!(sealed_path, fs::canonicalize(&source).expect("canonical source"));
		assert_eq!(
			fs::metadata(&sealed_path).expect("sealed root metadata").permissions().mode() & 0o777,
			0o700
		);
		assert_eq!(
			fs::metadata(sealed_path.join("answer.txt"))
				.expect("sealed file metadata")
				.permissions()
				.mode() & 0o777,
			0o600
		);

		fs::write(source.join("answer.txt"), "changed after sealing\n").expect("mutate source");

		let adapter = CodexAdapter::new(
			NeverExecutor,
			LocalArtifactSink::new(&artifact_root).expect("artifact root"),
			"codex",
			CodexExecutionConfig::isolated(root.join("codex-home")),
		);
		let (manifest_reference, snapshot_reference) =
			super::retain_workspace_evidence(&adapter, &sealed_path)
				.expect("sealed replay evidence");
		let snapshot_digest = snapshot_reference.content_hash.trim_start_matches("sha256:");
		let snapshot: runner::WorkspaceSnapshot = serde_json::from_slice(
			&fs::read(artifact_root.join(snapshot_digest).join("workspace-snapshot.json"))
				.expect("snapshot artifact"),
		)
		.expect("snapshot JSON");
		let replay = root.join("replay");

		snapshot.materialize_verified(&replay).expect("snapshot replay");

		assert_eq!(
			fs::read_to_string(replay.join("answer.txt")).expect("replayed answer"),
			"sealed answer\n"
		);

		let binding = sealed_bytes_evaluator(&evaluator_root, &source);
		let tool_evidence = NormalizedToolEvidence {
			steps: 1,
			total_calls: 0,
			by_tool: BTreeMap::new(),
			completed_command_sha256: BTreeMap::new(),
		};
		let context = EvaluatorContext {
			task_id: "coding-01",
			task_version: "1.0.0",
			run_id: "run_sealed",
			model: MODEL_MATRIX[0],
			final_response: "OK",
			candidate_workspace: &sealed_path,
			workspace_manifest_sha256: &manifest_reference.content_hash,
			tool_evidence: &tool_evidence,
		};
		let evaluated = binding
			.evaluate_at_root(
				"repository_test_suite",
				&context,
				&evaluator_root,
				&EvaluatorRuntime::resolve(&evaluator_root.join("node-test-runtime"))
					.expect("shell-backed test runtime"),
			)
			.expect("evaluator must read sealed bytes");

		assert_eq!(evaluated.outcome, task::EvaluatorOutcome::Correct);
		assert_eq!(
			fs::read_to_string(source.join("answer.txt")).expect("mutated source"),
			"changed during evaluation\n"
		);
		assert_eq!(
			fs::read_to_string(sealed_path.join("answer.txt")).expect("sealed answer"),
			"sealed answer\n"
		);

		super::verify_sealed_workspace_unchanged(&sealed_path, &manifest_reference.content_hash)
			.expect("sealed workspace must remain stable after evaluation");
		fs::write(sealed_path.join("answer.txt"), "tampered sealed answer\n")
			.expect("tamper sealed fixture");

		assert!(
			super::verify_sealed_workspace_unchanged(
				&sealed_path,
				&manifest_reference.content_hash,
			)
			.is_err()
		);

		sealed.cleanup().expect("sealed cleanup");

		assert!(!sealed_path.exists());

		fs::remove_dir_all(root).expect("fixture cleanup");
	}

	#[cfg(unix)]
	#[test]
	fn sealed_workspace_rejects_unsafe_entries_and_cleans_partial_copies() {
		let root = PathBuf::from("/tmp").join(format!("aiq-sealed-types-{}", super::unix_ms()));
		let source = root.join("candidate");

		fs::create_dir_all(&source).expect("source workspace");
		fs::write(source.join("a-regular.txt"), "copied first").expect("regular file");
		std::os::unix::fs::symlink("a-regular.txt", source.join("z-link"))
			.expect("symlink fixture");

		assert!(super::SealedWorkspace::create(&source).is_err());
		assert!(sealed_siblings(&root).is_empty());

		fs::remove_file(source.join("z-link")).expect("remove symlink fixture");

		let listener = UnixListener::bind(source.join("z-socket")).expect("special-file fixture");

		assert!(super::SealedWorkspace::create(&source).is_err());
		assert!(sealed_siblings(&root).is_empty());

		drop(listener);

		fs::remove_dir_all(root).expect("fixture cleanup");
	}

	#[test]
	fn sealed_workspace_paths_are_parallel_unique_and_cleanup_is_exact() {
		let root = env::temp_dir().join(format!(
			"aiq-runner-sealed-parallel-{}-{}",
			process::id(),
			super::unix_ms()
		));
		let source = root.join("candidate");
		let workers = 16;

		fs::create_dir_all(&source).expect("source workspace");
		fs::write(source.join("answer.txt"), "stable\n").expect("source answer");

		let barrier = Barrier::new(workers);
		let sealed = thread::scope(|scope| {
			let handles = (0..workers)
				.map(|_| {
					let barrier = &barrier;
					let source = &source;

					scope.spawn(move || {
						barrier.wait();

						super::SealedWorkspace::create(source).expect("parallel sealed workspace")
					})
				})
				.collect::<Vec<_>>();

			handles
				.into_iter()
				.map(|handle| handle.join().expect("sealed workspace worker"))
				.collect::<Vec<_>>()
		});
		let paths = sealed.iter().map(|workspace| workspace.path.clone()).collect::<BTreeSet<_>>();

		assert_eq!(paths.len(), workers);
		assert_eq!(sealed_siblings(&root).len(), workers);

		for workspace in sealed {
			let path = workspace.path.clone();

			workspace.cleanup().expect("parallel sealed cleanup");

			assert!(!path.exists());
		}

		assert!(sealed_siblings(&root).is_empty());

		fs::remove_dir_all(root).expect("fixture cleanup");
	}

	#[test]
	fn sealed_workspace_cleanup_rejects_a_substituted_target() {
		let root = env::temp_dir().join(format!(
			"aiq-runner-sealed-cleanup-{}-{}",
			process::id(),
			super::unix_ms()
		));
		let source = root.join("candidate");

		fs::create_dir_all(&source).expect("source workspace");
		fs::write(source.join("answer.txt"), "stable\n").expect("source answer");

		let sealed = super::SealedWorkspace::create(&source).expect("sealed workspace");
		let sealed_path = sealed.path.clone();

		fs::remove_dir_all(&sealed_path).expect("remove sealed directory");
		fs::write(&sealed_path, "substitution").expect("substitute cleanup target");

		let error = sealed.cleanup().expect_err("substituted cleanup target must fail closed");

		assert!(error.to_string().contains("cleanup target is not a regular directory"));

		fs::remove_file(sealed_path).expect("remove substitution fixture");
		fs::remove_dir_all(root).expect("fixture cleanup");
	}

	#[test]
	fn task_success_and_invocation_failure_remove_their_sealed_workspaces() {
		let root = env::temp_dir().join(format!(
			"aiq-runner-sealed-task-cleanup-{}-{}",
			process::id(),
			super::unix_ms()
		));
		let manifest = CapabilityManifest {
			schema_version: "aiq.capabilities.v1".to_owned(),
			node_id: "node_fixture".to_owned(),
			observed_at: "fixture".to_owned(),
			codex_version: "codex fixture".to_owned(),
			models: Vec::new(),
		};
		let task = runner::synthetic_tasks().remove(0);

		for (label, succeeds) in [("success", true), ("failure", false)] {
			let workspace_root = root.join(label);
			let provider =
				TestWorkspace { root: workspace_root.clone(), quarantines: AtomicUsize::new(0) };
			let result = if succeeds {
				let (executor, _) = DeterministicExecutor::new(0, None);
				let adapter = CodexAdapter::new(
					executor,
					MemorySink,
					"codex",
					CodexExecutionConfig::isolated(root.join("codex-home")),
				);

				runner::execute_task(
					&adapter,
					&provider,
					&manifest,
					&task,
					MODEL_MATRIX[0],
					&format!("run_{label}"),
					"codex fixture",
					"fixture",
					None,
					None,
				)
				.expect("successful invocation result")
			} else {
				let adapter = CodexAdapter::new(
					NeverExecutor,
					MemorySink,
					"codex",
					CodexExecutionConfig::isolated(root.join("codex-home")),
				);

				runner::execute_task(
					&adapter,
					&provider,
					&manifest,
					&task,
					MODEL_MATRIX[0],
					&format!("run_{label}"),
					"codex fixture",
					"fixture",
					None,
					None,
				)
				.expect("failed invocation result")
			};
			let workspace_parent =
				workspace_root.join(format!("run_{label}")).join(MODEL_MATRIX[0].key());

			assert_eq!(result.status == ResultStatus::Completed, succeeds);
			assert!(sealed_siblings(&workspace_parent).is_empty());
		}

		fs::remove_dir_all(root).expect("fixture cleanup");
	}

	#[test]
	fn post_evidence_sealed_workspace_mutation_fails_closed_and_cleans_up() {
		let root = env::temp_dir().join(format!(
			"aiq-runner-sealed-post-evidence-{}-{}",
			process::id(),
			super::unix_ms()
		));
		let workspace_root = root.join("workspaces");
		let run_id = "run_post_evidence";
		let manifest = CapabilityManifest {
			schema_version: "aiq.capabilities.v1".to_owned(),
			node_id: "node_fixture".to_owned(),
			observed_at: "fixture".to_owned(),
			codex_version: "codex fixture".to_owned(),
			models: Vec::new(),
		};
		let task = runner::synthetic_tasks().remove(0);
		let workspace_parent = workspace_root.join(run_id).join(MODEL_MATRIX[0].key());
		let provider = TestWorkspace { root: workspace_root, quarantines: AtomicUsize::new(0) };
		let adapter = CodexAdapter::new(
			EvidenceExecutor,
			TamperingSink { workspace_parent: workspace_parent.clone() },
			"codex",
			CodexExecutionConfig::isolated(root.join("codex-home")),
		);
		let result = runner::execute_task(
			&adapter,
			&provider,
			&manifest,
			&task,
			MODEL_MATRIX[0],
			run_id,
			"codex fixture",
			"fixture",
			None,
			None,
		)
		.expect("sealed mutation must produce a structured failure");

		assert_eq!(result.status, ResultStatus::Failed);
		assert_eq!(
			result.failure.as_ref().map(|failure| failure.kind),
			Some(FailureKind::WorkspaceIntegrity)
		);

		let failure = result.failure.as_ref().expect("workspace-integrity failure");

		assert_eq!(failure.message, "post-evaluation workspace integrity or cleanup failed");
		assert!(failure.message.len() <= 128);
		assert!(failure.message.bytes().all(|byte| byte.is_ascii_graphic() || byte == b' '));
		assert!(!failure.message.bytes().any(|byte| matches!(byte, b'"' | b'\\')));
		assert!(result.workspace_manifest.is_some());
		assert!(result.artifacts.iter().any(|artifact| artifact.kind == "workspace-snapshot.json"));
		assert!(result.latency.wall_ms >= 2);
		assert_eq!(result.tool_usage.total_calls, 1);
		assert_eq!(result.tool_usage.by_tool.get("command_execution"), Some(&1));
		assert!(runner::aborts_paid_run(&result));
		assert!(sealed_siblings(&workspace_parent).is_empty());

		fs::remove_dir_all(root).expect("fixture cleanup");
	}

	#[test]
	fn failed_invocations_retain_signed_tool_and_provider_usage() {
		let root = env::temp_dir().join(format!(
			"aiq-runner-failed-evidence-{}-{}",
			process::id(),
			super::unix_ms()
		));
		let workspace_root = root.join("workspaces");
		let manifest = CapabilityManifest {
			schema_version: "aiq.capabilities.v1".to_owned(),
			node_id: "node_fixture".to_owned(),
			observed_at: "fixture".to_owned(),
			codex_version: "codex fixture".to_owned(),
			models: Vec::new(),
		};
		let task = runner::synthetic_tasks().remove(0);
		let provider =
			TestWorkspace { root: workspace_root.clone(), quarantines: AtomicUsize::new(0) };

		for (label, timed_out, expected_kind) in
			[("nonzero", false, FailureKind::NonZeroExit), ("timeout", true, FailureKind::Timeout)]
		{
			let run_id = format!("run_failed_{label}");
			let adapter = CodexAdapter::new(
				FailureEvidenceExecutor { timed_out },
				MemorySink,
				"codex",
				CodexExecutionConfig::isolated(root.join(format!("codex-home-{label}"))),
			);
			let result = runner::execute_task(
				&adapter,
				&provider,
				&manifest,
				&task,
				MODEL_MATRIX[0],
				&run_id,
				"codex fixture",
				"fixture",
				None,
				None,
			)
			.expect("failed invocation must produce signed evidence");

			assert_eq!(result.status, ResultStatus::Failed);
			assert_eq!(result.failure.as_ref().map(|failure| failure.kind), Some(expected_kind));
			assert_eq!(result.tool_usage.steps, 1);
			assert_eq!(result.tool_usage.total_calls, 1);
			assert_eq!(result.tool_usage.by_tool.get("command_execution"), Some(&1));
			assert_eq!(result.tool_usage.provider_tokens.input, Some(11));
			assert_eq!(result.tool_usage.provider_tokens.cached_input, Some(2));
			assert_eq!(result.tool_usage.provider_tokens.cache_write_input, Some(1));
			assert_eq!(result.tool_usage.provider_tokens.output, Some(5));
			assert_eq!(result.tool_usage.provider_tokens.reasoning, Some(3));
			assert_eq!(result.tool_usage.provider_tokens.total, Some(16));
			assert!(result.workspace_manifest.is_some());
			assert!(result.artifacts.iter().any(|artifact| artifact.kind == "stdout.jsonl"));
			assert!(
				result.artifacts.iter().any(|artifact| artifact.kind == "workspace-snapshot.json")
			);
			assert!(
				sealed_siblings(&workspace_root.join(&run_id).join(MODEL_MATRIX[0].key()))
					.is_empty()
			);
		}

		fs::remove_dir_all(root).expect("fixture cleanup");
	}

	#[test]
	fn controlled_prompt_includes_allowed_tools_and_fixture_references() {
		let mut task = runner::synthetic_tasks()
			.into_iter()
			.next()
			.expect("synthetic fixture must contain a task");

		task.allowed_tools = vec!["filesystem_read".to_owned(), "web_search".to_owned()];
		task.fixture_refs = vec!["repo://fixture/input".to_owned()];

		let prompt = runner::task_prompt(&task);

		assert!(prompt.contains("filesystem_read"));
		assert!(prompt.contains("web_search"));
		assert!(prompt.contains("repo://fixture/input"));
	}

	#[test]
	fn completed_codex_items_preserve_raw_tool_names_and_count_file_changes() {
		let stdout = [
			r#"{"type":"item.started","item":{"id":"cmd-1","type":"command_execution","command":"node bin/task-tool.mjs"}}"#,
			r#"{"type":"item.completed","item":{"id":"cmd-1","type":"command_execution","status":"completed"}}"#,
			r#"{"type":"item.completed","item":{"id":"patch-1","type":"file_change","changes":[{"path":"src/lib.rs","kind":"update"}],"status":"completed"}}"#,
			r#"{"type":"item.completed","item":{"id":"mcp-1","type":"mcp_tool_call","server":"docs","tool":"search","status":"completed"}}"#,
			r#"{"type":"item.completed","item":{"id":"web-1","type":"web_search","query":"Rust process groups"}}"#,
			r#"{"type":"item.completed","item":{"id":"message-1","type":"agent_message","text":"done"}}"#,
			r#"{"type":"item.completed","item":{"id":"error-1","type":"error","message":"redacted"}}"#,
			r#"{"type":"item.completed","item":{"id":"future-1","type":"future_tool","payload":{}}}"#,
			r#"{"type":"turn.completed","usage":{"input_tokens":1}}"#,
			r#"not-json"#,
		]
		.join("\n");
		let usage = runner::parse_codex_tool_usage(&stdout).expect("fixture stdout policy");

		assert_eq!(usage.steps, 6);
		assert_eq!(usage.total_calls, 5);
		assert_eq!(
			usage.by_tool,
			BTreeMap::from([
				("command_execution".to_owned(), 1),
				("file_change".to_owned(), 1),
				("future_tool".to_owned(), 1),
				("mcp_tool_call".to_owned(), 1),
				("web_search".to_owned(), 1),
			])
		);
	}

	#[test]
	fn legacy_tool_usage_and_pending_evaluation_omit_completed_command_digests() {
		let legacy_usage = serde_json::json!({
			"steps": 1,
			"total_calls": 1,
			"by_tool": {"command_execution": 1}
		});
		let usage: runner::ToolUsage =
			serde_json::from_value(legacy_usage).expect("legacy tool usage");

		assert!(usage.completed_command_sha256.is_empty());
		assert!(
			serde_json::to_value(&usage)
				.expect("tool usage serialization")
				.get("completed_command_sha256")
				.is_none()
		);
		assert!(
			serde_json::from_value::<runner::ToolUsage>(serde_json::json!({
				"steps": 1,
				"total_calls": 1,
				"by_tool": {"command_execution": 1},
				"completed_command_sha256": {}
			}))
			.is_err()
		);

		let digest = "sha256:6763cc80f8294b52c6494f1c9891e41a8e3cd1c466ca622377c59643a0466319";
		let pending = PendingEvaluation {
			schema_version: resume::PENDING_EVALUATION_SCHEMA_VERSION.to_owned(),
			run_id: format!("run_{}", "a".repeat(64)),
			task_id: "tool-use-01".to_owned(),
			task_version: "1.0.7".to_owned(),
			task_hash: format!("sha256:{}", "b".repeat(64)),
			model: MODEL_MATRIX[0],
			final_response: "OK".to_owned(),
			response: "OK".to_owned(),
			response_sha256: format!("sha256:{}", "c".repeat(64)),
			artifacts: Vec::new(),
			exit_code: Some(0),
			latency: runner::Latency { wall_ms: 1, evaluator_ms: 0 },
			tool_usage: runner::ToolUsage {
				completed_command_sha256: BTreeMap::from([(digest.to_owned(), 1)]),
				..runner::ToolUsage::default()
			},
			workspace_manifest: ArtifactReference {
				kind: "workspace-manifest.json".to_owned(),
				content_hash: format!("sha256:{}", "d".repeat(64)),
				uri: format!("aiq-artifact://sha256/{}/workspace-manifest.json", "d".repeat(64)),
				bytes: 1,
			},
			sealed_workspace: PathBuf::from("sealed-workspace"),
			provenance: protocol::ResultProvenance {
				node_id: format!("node_{}", "e".repeat(64)),
				runner_version: "0.1.0".to_owned(),
				codex_version: "codex fixture".to_owned(),
				observed_at: "synthetic".to_owned(),
				synthetic: true,
				local_trust: protocol::TrustTier::Untrusted,
			},
		};
		let mut legacy_pending = serde_json::to_value(pending).expect("pending serialization");

		legacy_pending["tool_usage"]
			.as_object_mut()
			.expect("pending tool usage")
			.remove("completed_command_sha256");

		let recovered: PendingEvaluation =
			serde_json::from_value(legacy_pending).expect("legacy pending evaluation");

		assert!(recovered.tool_usage.completed_command_sha256.is_empty());
	}

	#[cfg(unix)]
	#[test]
	fn completed_command_digest_projection_retains_only_task_declared_identities() {
		let required = "sha256:6763cc80f8294b52c6494f1c9891e41a8e3cd1c466ca622377c59643a0466319";
		let undeclared = format!("sha256:{}", "f".repeat(64));
		let configuration = serde_json::from_value(serde_json::json!({
			"checks": [{
				"type": "tool_evidence",
				"required_completed_command_sha256": {
					"sha256:6763cc80f8294b52c6494f1c9891e41a8e3cd1c466ca622377c59643a0466319": 1
				}
			}]
		}))
		.expect("projection configuration");
		let mut task = runner::synthetic_tasks().remove(0);
		let scorer_version = task.scorer_version.clone();
		let evaluator = task.evaluator.as_mut().expect("synthetic evaluator");

		evaluator.external = Some(ExternalEvaluatorBinding {
			protocol_version: EVALUATOR_PROTOCOL_VERSION.to_owned(),
			scorer_version,
			runtime_kind: EvaluatorRuntimeKind::Node,
			runtime_executable_digest: format!("sha256:{}", "a".repeat(64)),
			executable_ref: PathBuf::from("unused-evaluator"),
			executable_digest: format!("sha256:{}", "b".repeat(64)),
			configuration_digest: protocol::canonical_hash(&configuration)
				.expect("projection configuration digest"),
			arguments: Vec::new(),
			timeout_ms: None,
			max_input_bytes: 8_192,
			max_output_bytes: 8_192,
			configuration,
		});

		let mut usage = runner::ToolUsage {
			steps: 3,
			total_calls: 3,
			by_tool: BTreeMap::from([("command_execution".to_owned(), 3)]),
			completed_command_sha256: BTreeMap::from([(required.to_owned(), 2), (undeclared, 1)]),
			provider_tokens: runner::ProviderTokenUsage::default(),
		};

		runner::project_completed_command_digests(&task, &mut usage);

		assert_eq!(usage.completed_command_sha256, BTreeMap::from([(required.to_owned(), 2)]));
		assert_eq!(usage.total_calls, 3);
		assert_eq!(usage.by_tool.get("command_execution"), Some(&3));
	}

	#[test]
	fn retry_markers_separate_item_lifecycles_while_preserving_cumulative_counts() {
		let stdout = [
			r#"{"type":"item.started","item":{"id":"cmd-shared","type":"command_execution","command":"node bin/task-tool.mjs"}}"#,
			r#"{"type":"aiq.invocation-attempt.v1","attempt":1,"disposition":"retry","failure_kind":"non_zero_exit","exit_code":17,"wall_ms":2}"#,
			r#"{"type":"item.started","item":{"id":"cmd-shared","type":"command_execution","command":"node bin/task-tool.mjs"}}"#,
			r#"{"type":"item.completed","item":{"id":"cmd-shared","type":"command_execution","status":"completed"}}"#,
			r#"{"type":"aiq.invocation-attempt.v1","attempt":2,"disposition":"selected","failure_kind":null,"exit_code":null,"wall_ms":3}"#,
		]
		.join("\n");
		let usage = runner::parse_codex_tool_usage(&stdout).expect("retry accounting");

		assert_eq!(usage.steps, 1);
		assert_eq!(usage.total_calls, 2);
		assert_eq!(usage.by_tool.get("command_execution"), Some(&2));
	}

	#[test]
	fn durable_parser_keeps_inert_collaboration_wait_out_of_tool_counts() {
		let stdout = [
			r#"{"type":"item.started","item":{"agents_states":{},"id":"wait-1","prompt":null,"receiver_thread_ids":[],"sender_thread_id":"thread-sender","status":"in_progress","tool":"wait","type":"collab_tool_call"}}"#,
			r#"{"type":"item.completed","item":{"agents_states":{},"id":"wait-1","prompt":null,"receiver_thread_ids":[],"sender_thread_id":"thread-sender","status":"completed","tool":"wait","type":"collab_tool_call"}}"#,
		]
		.join("\n");
		let usage = runner::parse_codex_tool_usage(&stdout).expect("inert wait policy");

		assert_eq!(usage.steps, 1);
		assert_eq!(usage.total_calls, 0);
		assert!(usage.by_tool.is_empty());
	}

	#[test]
	fn durable_parser_rejects_policy_invalid_collaboration_stdout() {
		let stdout = r#"{"type":"item.completed","item":{"agents_states":{},"id":"wait-1","prompt":null,"receiver_thread_ids":["receiver"],"sender_thread_id":"thread-sender","status":"completed","tool":"wait","type":"collab_tool_call"}}"#;

		assert!(runner::parse_codex_tool_usage(stdout).is_err());
	}

	#[test]
	fn checkpoint_resume_rejects_legacy_collaboration_tool_counts() {
		let (_tasks, _models, _manifest, validation, slot, commitments) = selected_fixture(1, 1);
		let mut result = runner::synthetic_demo(slot, &runner::TestArtifactSink)
			.expect("synthetic fixture")
			.results
			.into_iter()
			.next()
			.expect("synthetic result");

		result.tool_usage.by_tool.insert("collab_tool_call".to_owned(), 1);

		let mut checkpoint = RunCheckpoint::new(commitments.clone(), 1);

		checkpoint.results = vec![result];
		checkpoint.evaluator_results = vec![None];

		let error = super::restore_checkpoint_results(
			&checkpoint,
			&BTreeMap::new(),
			&BTreeMap::new(),
			&validation,
			&commitments,
			"fixture",
		)
		.expect_err("legacy collaboration counters must not resume");

		assert!(error.to_string().contains("collaboration calls"));
	}

	#[test]
	fn pending_execution_is_task_major_round_robin_but_keeps_model_major_indexes() {
		let order = super::task_major_execution_order(3, 2).collect::<Vec<_>>();
		let canonical_indexes = order
			.iter()
			.map(|(task_index, model_index)| model_index * 3 + task_index)
			.collect::<Vec<_>>();

		assert_eq!(order, vec![(0, 0), (0, 1), (1, 0), (1, 1), (2, 0), (2, 1)]);
		assert_eq!(canonical_indexes, vec![0, 3, 1, 4, 2, 5]);
	}

	#[test]
	fn full_matrix_worst_case_inline_results_fit_the_signed_submission_bound() {
		let (_, _, _, capability_validation, _, _) = selected_fixture(1, MODEL_MATRIX.len());
		let node_id = capability_validation.node_id.clone();
		let mut run = runner::synthetic_demo(
			ScheduleConfig::default()
				.slot("2024-02-29", ScheduleOccurrence::Day)
				.expect("fixture slot"),
			&runner::TestArtifactSink,
		)
		.expect("fixture run");

		run.synthetic = false;
		run.capability_validation = Some(capability_validation);

		let response = "\0".repeat(MAX_RESULT_PREVIEW_BYTES);
		let response_sha256 =
			format!("sha256:{}", hex::encode(Sha256::digest(response.as_bytes())));
		let artifact = |kind: &str, marker: char| {
			let digest = marker.to_string().repeat(64);

			ArtifactReference {
				kind: kind.to_owned(),
				content_hash: format!("sha256:{digest}"),
				uri: format!("aiq-artifact://sha256/{digest}/{kind}"),
				bytes: 4 * 1_024 * 1_024,
			}
		};

		for (index, result) in run.results.iter_mut().enumerate() {
			result.response = Some(response.clone());
			result.response_sha256 = Some(response_sha256.clone());
			result.artifacts = vec![
				artifact("stdout.jsonl", 'a'),
				artifact("stderr.txt", 'b'),
				artifact("final-response.txt", 'c'),
				artifact("workspace-snapshot.json", 'd'),
			];
			result.workspace_manifest = Some(artifact("workspace-manifest.json", 'e'));
			result.tool_usage = runner::ToolUsage {
				steps: u32::MAX,
				total_calls: u32::MAX,
				by_tool: BTreeMap::from([
					("command_execution".to_owned(), u32::MAX),
					("file_change".to_owned(), u32::MAX),
					("mcp_tool_call".to_owned(), u32::MAX),
					("web_search".to_owned(), u32::MAX),
				]),
				completed_command_sha256: if index
					< runner::MAX_COMPLETED_COMMAND_DIGEST_ENTRIES_PER_RUN
				{
					BTreeMap::from([(format!("sha256:{}", "f".repeat(64)), u32::MAX)])
				} else {
					BTreeMap::new()
				},
				provider_tokens: runner::ProviderTokenUsage::default(),
			};
			result.provenance.node_id = node_id.clone();
			result.provenance.codex_version = "codex fixture".to_owned();
			result.provenance.observed_at = "fixture".to_owned();
			result.provenance.synthetic = false;
			result.result_id = format!(
				"result_{}",
				result.content_hash().expect("fixture result hash").trim_start_matches("sha256:")
			);
		}

		let identity = protocol::SigningIdentity::from_secret([7; 32]);
		let envelope = identity
			.sign(&run.run_id, protocol::RUN_PAYLOAD_TYPE, &run, protocol::TrustTier::Untrusted)
			.expect("fixture package must sign");
		let bytes = serde_json::to_vec(&envelope).expect("fixture package serialization");

		assert_eq!(run.results.len(), 1_224);
		assert_eq!(
			run.results
				.iter()
				.map(|result| result.tool_usage.completed_command_sha256.len())
				.sum::<usize>(),
			runner::MAX_COMPLETED_COMMAND_DIGEST_ENTRIES_PER_RUN
		);
		assert_eq!(bytes.len(), 3_832_840);
		assert!(
			bytes.len() <= MAX_SUBMISSION_BYTES,
			"worst-case signed package is {} bytes, limit is {MAX_SUBMISSION_BYTES}",
			bytes.len()
		);
	}

	#[test]
	fn file_change_exceeding_max_tool_calls_skips_evaluation() {
		let stdout_full = [
			r#"{"type":"item.completed","item":{"id":"patch-1","type":"file_change","changes":[{"path":"answer.txt","kind":"add"}],"status":"completed"}}"#,
			r#"{"type":"item.completed","item":{"id":"message-1","type":"agent_message","text":"OK"}}"#,
		]
		.join("\n");
		let mut task = runner::synthetic_tasks().remove(0);

		task.budgets.max_steps = Some(2);
		task.budgets.max_tool_calls = Some(0);
		task.evaluator = Some(Evaluator::exact_match("OK", true));

		let adapter = CodexAdapter::new(
			NeverExecutor,
			MemorySink,
			"codex",
			CodexExecutionConfig::isolated("/controlled/codex-home"),
		);
		let manifest = CapabilityManifest {
			schema_version: "aiq.capabilities.v1".to_owned(),
			node_id: "node_fixture".to_owned(),
			observed_at: "fixture".to_owned(),
			codex_version: "codex fixture".to_owned(),
			models: Vec::new(),
		};
		let result = runner::successful_result(
			&adapter,
			&manifest,
			&task,
			MODEL_MATRIX[0],
			"run_fixture",
			"codex fixture",
			"fixture",
			1,
			&CodexOutput {
				stdout: stdout_full.clone(),
				stderr: String::new(),
				exit_code: Some(0),
				artifacts: Vec::new(),
				final_response: Some("OK".to_owned()),
				stdout_full,
			},
			Path::new("/controlled/candidate"),
			&ArtifactReference {
				kind: "workspace-manifest.json".to_owned(),
				content_hash:
					"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
						.to_owned(),
				uri: "aiq-artifact://fixture/manifest".to_owned(),
				bytes: 2,
			},
			&ArtifactReference {
				kind: "workspace-snapshot.json".to_owned(),
				content_hash:
					"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
						.to_owned(),
				uri: "aiq-artifact://fixture/snapshot".to_owned(),
				bytes: 2,
			},
			None,
			None,
			None,
			&mut false,
		)
		.expect("result must build");

		assert_eq!(result.status, ResultStatus::Failed);
		assert_eq!(result.evaluation, EvaluationOutcome::NotEvaluated);
		assert_eq!(result.task_score, None);
		assert!(result.response.is_none());
		assert!(result.response_sha256.is_none());
		assert_eq!(result.tool_usage.steps, 2);
		assert_eq!(result.tool_usage.total_calls, 1);
		assert_eq!(result.tool_usage.by_tool.get("file_change"), Some(&1));
		assert!(result.artifacts.iter().any(|artifact| artifact.kind == "stdout.jsonl"));
		assert!(!result.artifacts.iter().any(|artifact| artifact.kind == "final-response.txt"));
		assert!(result.evaluator_checks.is_empty());
		assert_eq!(
			result.failure.as_ref().map(|failure| failure.kind),
			Some(FailureKind::BudgetExceeded)
		);

		assert_budget_failure_satisfies_saved_run_contract(result);
	}

	fn assert_budget_failure_satisfies_saved_run_contract(result: TaskResult) {
		let tasks = runner::synthetic_demo_tasks();
		let mut run = runner::synthetic_demo(
			ScheduleConfig::default()
				.slot("2024-02-29", ScheduleOccurrence::Day)
				.expect("fixture slot"),
			&runner::TestArtifactSink,
		)
		.expect("fixture run");
		let mut validated_result = result;
		let original = run
			.results
			.iter()
			.find(|candidate| {
				candidate.task_id == validated_result.task_id
					&& candidate.model == validated_result.model
			})
			.expect("matching synthetic result");

		validated_result.run_id = run.run_id.clone();
		validated_result.task_version = original.task_version.clone();
		validated_result.task_hash = original.task_hash.clone();
		validated_result.provenance = original.provenance.clone();
		validated_result.workspace_manifest = None;

		validated_result.artifacts.retain(|artifact| artifact.kind == "stdout.jsonl");
		validated_result.assign_result_id().expect("budget result identifier");

		let target = run
			.results
			.iter_mut()
			.find(|candidate| {
				candidate.task_id == validated_result.task_id
					&& candidate.model == validated_result.model
			})
			.expect("matching mutable synthetic result");

		*target = validated_result;
		run.terminal_attempt_lineage = runner::terminal_attempt_lineage(&run.results);

		run_validation::validate_run_record(&run, Some(&tasks))
			.expect("post-hoc budget failure must satisfy the saved-run contract");
	}

	#[cfg(unix)]
	fn timeout_fixture_executable(root: &Path) -> PathBuf {
		let executable = root.join("local-codex");

		fs::write(
			&executable,
			concat!(
				"#!/bin/sh\n",
				"workspace=''\n",
				"previous=''\n",
				"for argument in \"$@\"; do\n",
				"  if [ \"$previous\" = '--cd' ]; then workspace=\"$argument\"; break; fi\n",
				"  previous=\"$argument\"\n",
				"done\n",
				"printf 'attempted\\n' > \"$workspace/attempted.txt\"\n",
				"sleep 30 &\n",
				"descendant=$!\n",
				"printf '%s\\n' \"$descendant\" > \"$workspace/descendant.pid\"\n",
				"wait\n",
			),
		)
		.expect("fixture executable");
		fs::set_permissions(&executable, fs::Permissions::from_mode(0o700))
			.expect("fixture executable permissions");

		executable
	}

	#[cfg(unix)]
	#[test]
	fn actual_adapter_timeout_retains_replay_evidence_and_kills_the_process_tree() {
		let root = env::temp_dir().join(format!(
			"aiq-runner-timeout-integration-{}-{}",
			process::id(),
			super::unix_ms()
		));
		let workspace_root = root.join("workspaces");
		let artifact_root = root.join("artifacts");

		fs::create_dir_all(&root).expect("fixture root");

		let executable = timeout_fixture_executable(&root);
		let provider = TestWorkspace { root: workspace_root, quarantines: AtomicUsize::new(0) };
		let adapter = CodexAdapter::new(
			SystemExecutor,
			LocalArtifactSink::new(&artifact_root).expect("artifact root"),
			executable.display().to_string(),
			CodexExecutionConfig::isolated(root.join("codex-home")),
		);
		let manifest = CapabilityManifest {
			schema_version: "aiq.capabilities.v1".to_owned(),
			node_id: "node_fixture".to_owned(),
			observed_at: "fixture".to_owned(),
			codex_version: "codex fixture".to_owned(),
			models: Vec::new(),
		};
		let mut task = runner::synthetic_tasks().remove(0);

		task.budgets.wall_seconds = Some(1);
		task.budgets.max_steps = Some(10);
		task.budgets.max_tool_calls = Some(10);
		task.evaluator = Some(Evaluator::exact_match("must not run", true));

		let result = runner::execute_task(
			&adapter,
			&provider,
			&manifest,
			&task,
			MODEL_MATRIX[0],
			"run_timeout",
			"codex fixture",
			"fixture",
			None,
			None,
		)
		.expect("timeout must produce a structured task result");

		assert_eq!(result.status, ResultStatus::Failed);
		assert_eq!(result.evaluation, EvaluationOutcome::NotEvaluated);
		assert_eq!(result.task_score, None);
		assert!(result.evaluator_checks.is_empty());
		assert_eq!(result.failure.as_ref().map(|failure| failure.kind), Some(FailureKind::Timeout));
		assert!(result.workspace_manifest.is_some());

		let snapshot_reference = result
			.artifacts
			.iter()
			.find(|artifact| artifact.kind == "workspace-snapshot.json")
			.expect("timeout must retain a replay snapshot");
		let digest = snapshot_reference.content_hash.trim_start_matches("sha256:");
		let snapshot: runner::WorkspaceSnapshot = serde_json::from_slice(
			&fs::read(artifact_root.join(digest).join("workspace-snapshot.json"))
				.expect("retained snapshot bytes"),
		)
		.expect("retained snapshot");
		let replay = root.join("replay");

		snapshot.materialize_verified(&replay).expect("timeout workspace must replay");

		assert_eq!(
			fs::read_to_string(replay.join("attempted.txt")).expect("replayed attempt evidence"),
			"attempted\n"
		);

		let descendant = fs::read_to_string(replay.join("descendant.pid"))
			.expect("replayed descendant PID")
			.trim()
			.parse::<i32>()
			.expect("descendant PID");
		let deadline = Instant::now() + Duration::from_secs(1);

		loop {
			// SAFETY: Signal zero only checks the PID created by this test.
			let status = unsafe { libc::kill(descendant, 0) };

			if status == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
				break;
			}

			assert!(
				Instant::now() < deadline,
				"timeout descendant {descendant} remained after process-group cleanup"
			);

			thread::sleep(Duration::from_millis(5));
		}

		fs::remove_dir_all(root).expect("fixture cleanup");
	}

	#[cfg(unix)]
	#[test]
	fn workspace_manifest_is_deterministic_and_rejects_symlinks() {
		let root = env::temp_dir().join(format!("aiq-runner-manifest-{}", process::id()));

		fs::create_dir_all(root.join("nested")).expect("fixture workspace");
		fs::write(root.join(".env.example"), "AIQ_TEST=true\n").expect("fixture file");
		fs::write(root.join("README.md"), "# Fixture\n").expect("fixture file");
		fs::write(root.join("package.json"), "{}\n").expect("fixture file");
		fs::write(root.join("z.txt"), "z").expect("fixture file");
		fs::write(root.join("nested/a.txt"), "a").expect("fixture file");

		let first = runner::build_workspace_manifest(&root).expect("first manifest");
		let second = runner::build_workspace_manifest(&root).expect("second manifest");

		assert_eq!(first, second);
		assert_eq!(
			protocol::canonical_hash(&first).expect("first digest"),
			protocol::canonical_hash(&second).expect("second digest")
		);
		assert_eq!(
			first.entries.iter().map(|entry| entry.path.as_str()).collect::<Vec<_>>(),
			vec![".env.example", "README.md", "nested", "nested/a.txt", "package.json", "z.txt"]
		);

		std::os::unix::fs::symlink(root.join("z.txt"), root.join("escape"))
			.expect("fixture symlink");

		assert!(runner::build_workspace_manifest(&root).is_err());

		fs::remove_dir_all(&root).expect("fixture workspace must be removed");
	}

	#[test]
	fn workspace_manifest_rejects_paths_outside_the_replay_grammar() {
		let root = env::temp_dir().join(format!("aiq-runner-manifest-unsafe-{}", process::id()));

		fs::create_dir(&root).expect("fixture workspace");
		fs::write(root.join("unsafe name.txt"), b"candidate").expect("fixture file");

		let error = runner::build_workspace_manifest(&root).expect_err("unsafe path must fail");

		assert!(error.to_string().contains("path component is not portable"));

		fs::remove_dir_all(root).expect("fixture cleanup");
	}

	#[test]
	fn workspace_manifest_rejects_excessive_directory_depth() {
		let root = env::temp_dir().join(format!("aiq-runner-manifest-depth-{}", process::id()));
		let mut directory = root.clone();

		fs::create_dir(&root).expect("fixture workspace");

		for _ in 0..=runner::MAX_WORKSPACE_DEPTH {
			directory.push("d");

			fs::create_dir(&directory).expect("nested fixture directory");
		}

		let error = runner::build_workspace_manifest(&root).expect_err("deep tree must fail");

		assert!(error.to_string().contains("directory depth limit"));

		fs::remove_dir_all(root).expect("fixture cleanup");
	}

	#[test]
	fn workspace_manifest_rejects_excessive_entry_count() {
		let root = env::temp_dir().join(format!("aiq-runner-manifest-entries-{}", process::id()));

		fs::create_dir(&root).expect("fixture workspace");

		for index in 0..=runner::MAX_WORKSPACE_ENTRIES {
			fs::write(root.join(format!("f{index:04}")), []).expect("fixture file");
		}

		let error = runner::build_workspace_manifest(&root).expect_err("large tree must fail");

		assert!(error.to_string().contains("entry limit"));

		fs::remove_dir_all(root).expect("fixture cleanup");
	}

	#[test]
	fn workspace_manifest_rejects_single_and_cumulative_oversized_files() {
		let single_root =
			env::temp_dir().join(format!("aiq-runner-manifest-single-{}", process::id()));

		fs::create_dir(&single_root).expect("fixture workspace");
		fs::File::create(single_root.join("large.bin"))
			.and_then(|file| file.set_len(runner::MAX_WORKSPACE_RAW_BYTES + 1))
			.expect("sparse oversized fixture file");

		let error =
			runner::build_workspace_manifest(&single_root).expect_err("large file must fail");

		assert!(error.to_string().contains("byte limit"));

		fs::remove_dir_all(single_root).expect("single-file fixture cleanup");

		let cumulative_root =
			env::temp_dir().join(format!("aiq-runner-manifest-total-{}", process::id()));
		let each = runner::MAX_WORKSPACE_RAW_BYTES / 2 + 1;

		fs::create_dir(&cumulative_root).expect("fixture workspace");

		for name in ["first.bin", "second.bin"] {
			fs::File::create(cumulative_root.join(name))
				.and_then(|file| file.set_len(each))
				.expect("sparse cumulative fixture file");
		}

		let error = runner::build_workspace_manifest(&cumulative_root)
			.expect_err("cumulative bytes must fail");

		assert!(error.to_string().contains("byte limit"));

		fs::remove_dir_all(cumulative_root).expect("cumulative fixture cleanup");
	}

	#[test]
	fn workspace_copy_enforces_limits_and_removes_partial_destinations() {
		let parent = env::temp_dir().join(format!("aiq-runner-copy-limits-{}", process::id()));
		let entry_source = parent.join("entry-source");
		let entry_destination = parent.join("entry-destination");

		fs::create_dir_all(&entry_source).expect("entry fixture workspace");

		for index in 0..=runner::MAX_WORKSPACE_ENTRIES {
			fs::write(entry_source.join(format!("f{index:04}")), []).expect("entry fixture file");
		}

		let error = super::copy_workspace_tree(&entry_source, &entry_destination)
			.expect_err("entry-heavy copy must fail");

		assert!(error.to_string().contains("entry limit"));
		assert!(!entry_destination.exists());

		let byte_source = parent.join("byte-source");
		let byte_destination = parent.join("byte-destination");

		fs::create_dir(&byte_source).expect("byte fixture workspace");
		fs::File::create(byte_source.join("large.bin"))
			.and_then(|file| file.set_len(runner::MAX_WORKSPACE_RAW_BYTES + 1))
			.expect("sparse oversized fixture file");

		let error = super::copy_workspace_tree(&byte_source, &byte_destination)
			.expect_err("byte-heavy copy must fail");

		assert!(error.to_string().contains("byte limit"));
		assert!(!byte_destination.exists());

		let depth_source = parent.join("depth-source");
		let depth_destination = parent.join("depth-destination");
		let mut directory = depth_source.clone();

		fs::create_dir(&depth_source).expect("depth fixture workspace");

		for _ in 0..=runner::MAX_WORKSPACE_DEPTH {
			directory.push("d");

			fs::create_dir(&directory).expect("nested depth fixture directory");
		}

		let error = super::copy_workspace_tree(&depth_source, &depth_destination)
			.expect_err("deep copy must fail");

		assert!(error.to_string().contains("directory depth limit"));
		assert!(!depth_destination.exists());

		fs::remove_dir_all(parent).expect("copy-limit fixture cleanup");
	}

	#[test]
	fn workspace_snapshot_path_grammar_matches_the_public_schema() {
		for path in ["file", ".env.example", "README.md", "dir", "dir/file"] {
			assert!(runner::safe_workspace_relative_path(path), "{path:?} must be accepted");
		}
		for path in [
			"",
			".",
			"./file",
			"dir/.",
			"dir/",
			"..",
			"../file",
			"dir/../file",
			"dir//file",
			"/absolute",
			"dir\\file",
			"NUL",
			"con.txt",
			"COM1.json",
			"Lpt9",
			"trailing.",
			"file\n",
			"file\r\n",
			"file\u{2028}",
			"file\u{2029}",
		] {
			assert!(!runner::safe_workspace_relative_path(path), "{path:?} must be rejected");
		}

		assert!(!runner::safe_workspace_relative_path(&"a".repeat(4_097)));
		assert!(!runner::safe_workspace_relative_path(&"a".repeat(256)));
	}

	#[test]
	fn workspace_snapshot_prevalidates_entry_depth_and_alias_limits() {
		let empty_digest = format!("sha256:{}", hex::encode(Sha256::digest([])));
		let file_entry = |path: String| runner::WorkspaceSnapshotEntry {
			path,
			kind: "file".to_owned(),
			bytes: Some(0),
			sha256: Some(empty_digest.clone()),
			content_hex: Some(String::new()),
		};
		let directory_entry = |path: String| runner::WorkspaceSnapshotEntry {
			path,
			kind: "directory".to_owned(),
			bytes: None,
			sha256: None,
			content_hex: None,
		};
		let exact_limit = runner::WorkspaceSnapshot {
			schema_version: "aiq.workspace-snapshot.v1".to_owned(),
			manifest_sha256: format!("sha256:{}", "a".repeat(64)),
			entries: (0..runner::MAX_WORKSPACE_ENTRIES)
				.map(|index| file_entry(format!("f{index:04}")))
				.collect(),
		};

		exact_limit.validate_entries().expect("exact entry limit must prevalidate");

		let parent = env::temp_dir().join(format!("aiq-runner-snapshot-limits-{}", process::id()));
		let excessive_destination = parent.join("excessive");
		let excessive = runner::WorkspaceSnapshot {
			entries: (0..=runner::MAX_WORKSPACE_ENTRIES)
				.map(|index| file_entry(format!("f{index:04}")))
				.collect(),
			..exact_limit.clone()
		};

		assert!(excessive.materialize_verified(&excessive_destination).is_err());
		assert!(!excessive_destination.exists());

		let mut path = String::new();
		let mut depth_entries = Vec::new();

		for index in 0..runner::MAX_WORKSPACE_DEPTH {
			if !path.is_empty() {
				path.push('/');
			}

			path.push_str(&format!("d{index:02}"));
			depth_entries.push(directory_entry(path.clone()));
		}

		depth_entries.push(file_entry(format!("{path}/file")));

		let depth_boundary =
			runner::WorkspaceSnapshot { entries: depth_entries.clone(), ..exact_limit.clone() };

		depth_boundary.validate_entries().expect("depth boundary must prevalidate");
		path.push_str("/too-deep");
		depth_entries.push(directory_entry(path));

		let too_deep = runner::WorkspaceSnapshot { entries: depth_entries, ..exact_limit.clone() };

		assert!(too_deep.validate_entries().is_err());

		let aliases = runner::WorkspaceSnapshot {
			entries: vec![file_entry("A".to_owned()), file_entry("a".to_owned())],
			..exact_limit
		};

		assert!(aliases.validate_entries().is_err());
	}

	#[test]
	fn maximum_workspace_snapshot_budget_fits_the_artifact_limit() {
		let large_bytes = vec![0_u8; usize::try_from(runner::MAX_WORKSPACE_RAW_BYTES).unwrap_or(0)];
		let large_digest = format!("sha256:{}", hex::encode(Sha256::digest(&large_bytes)));
		let empty_digest = format!("sha256:{}", hex::encode(Sha256::digest([])));
		let entries = (0..runner::MAX_WORKSPACE_ENTRIES)
			.map(|index| {
				let large = index == 0;

				runner::WorkspaceSnapshotEntry {
					path: format!("f{index:04}{}", "a".repeat(58)),
					kind: "file".to_owned(),
					bytes: Some(if large { runner::MAX_WORKSPACE_RAW_BYTES } else { 0 }),
					sha256: Some(if large { large_digest.clone() } else { empty_digest.clone() }),
					content_hex: Some(if large {
						hex::encode(&large_bytes)
					} else {
						String::new()
					}),
				}
			})
			.collect();
		let snapshot = runner::WorkspaceSnapshot {
			schema_version: "aiq.workspace-snapshot.v1".to_owned(),
			manifest_sha256: format!("sha256:{}", "a".repeat(64)),
			entries,
		};

		snapshot.validate_entries().expect("maximum snapshot budget must prevalidate");

		let bytes = protocol::canonical_json(&snapshot).expect("canonical maximum snapshot");

		assert!(bytes.len() <= runner::MAX_WORKSPACE_SNAPSHOT_BYTES, "{} bytes", bytes.len());
	}

	#[test]
	fn workspace_snapshot_reconstructs_exact_bytes_and_rejects_path_tampering() {
		let parent = env::temp_dir().join(format!("aiq-runner-snapshot-{}", process::id()));
		let source = parent.join("source");
		let replay = parent.join("replay");
		let rejected = parent.join("rejected");

		fs::create_dir_all(source.join("nested")).expect("fixture workspace");
		fs::write(source.join("plain.txt"), b"plain\n").expect("fixture file");
		fs::write(source.join("nested/binary.bin"), [0_u8, 1, 254, 255]).expect("fixture binary");

		let manifest = runner::build_workspace_manifest(&source).expect("fixture manifest");
		let snapshot =
			runner::build_workspace_snapshot(&source, &manifest).expect("fixture snapshot");

		assert_eq!(
			snapshot.entries.iter().map(|entry| entry.path.as_str()).collect::<Vec<_>>(),
			vec!["nested", "nested/binary.bin", "plain.txt"]
		);

		let reconstructed = snapshot.materialize_verified(&replay).expect("verified replay");

		assert_eq!(reconstructed, manifest);
		assert_eq!(
			fs::read(replay.join("nested/binary.bin")).expect("replayed bytes"),
			[0_u8, 1, 254, 255]
		);

		let mut tampered = snapshot;

		tampered.entries[0].path = "../escape".to_owned();

		assert!(tampered.materialize_verified(&rejected).is_err());
		assert!(!rejected.exists());

		fs::remove_dir_all(parent).expect("fixture cleanup");
	}

	#[test]
	fn evaluator_receives_complete_response_before_preview_and_artifact_storage() {
		let complete = format!(
			"{}DECISIVE node bin/task-tool.mjs unrelated text",
			"x".repeat(MAX_RESULT_PREVIEW_BYTES + 64)
		);
		let stdout_full = serde_json::json!({
			"type": "item.completed",
			"item": {"type": "agent_message", "text": complete.clone()}
		})
		.to_string();
		let mut task = runner::synthetic_tasks().remove(0);

		task.evaluator = Some(Evaluator::exact_match(&complete, true));

		let adapter = CodexAdapter::new(
			NeverExecutor,
			MemorySink,
			"codex",
			CodexExecutionConfig::isolated("/controlled/codex-home"),
		);
		let manifest = CapabilityManifest {
			schema_version: "aiq.capabilities.v1".to_owned(),
			node_id: "node_fixture".to_owned(),
			observed_at: "fixture".to_owned(),
			codex_version: "codex fixture".to_owned(),
			models: Vec::new(),
		};
		let result = runner::successful_result(
			&adapter,
			&manifest,
			&task,
			MODEL_MATRIX[0],
			"run_fixture",
			"codex fixture",
			"fixture",
			1,
			&CodexOutput {
				stdout: stdout_full[..MAX_RESULT_PREVIEW_BYTES].to_owned(),
				stderr: String::new(),
				exit_code: Some(0),
				artifacts: Vec::new(),
				final_response: Some(complete.clone()),
				stdout_full,
			},
			Path::new("/controlled/candidate"),
			&ArtifactReference {
				kind: "workspace-manifest.json".to_owned(),
				content_hash:
					"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
						.to_owned(),
				uri: "aiq-artifact://sha256/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/workspace-manifest.json".to_owned(),
				bytes: 2,
			},
			&ArtifactReference {
				kind: "workspace-snapshot.json".to_owned(),
				content_hash:
					"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
						.to_owned(),
				uri: "aiq-artifact://sha256/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/workspace-snapshot.json".to_owned(),
				bytes: 2,
			},
			None,
			None,
			None,
			&mut false,
		)
		.expect("result must build");

		assert_eq!(result.status, ResultStatus::Completed);
		assert_eq!(result.evaluation, EvaluationOutcome::Correct);
		assert_eq!(result.response.as_ref().map(String::len), Some(MAX_RESULT_PREVIEW_BYTES));
		assert!(result.artifacts.iter().any(|artifact| artifact.kind == "final-response.txt"));
	}

	#[test]
	fn partial_and_evaluator_failure_outcomes_remain_distinct() {
		let partial = runner::evaluation_fields(
			Ok(EvaluationResult {
				schema_version: EVALUATOR_RESULT_SCHEMA_VERSION.to_owned(),
				outcome: EvaluatorOutcome::Partial,
				score: 0.5,
				checks: vec![
					EvaluatorCheck {
						check_id: "a".to_owned(),
						weight: 1,
						passed: true,
						failure_class: EvaluatorCheckFailureClass::None,
						evidence_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned(),
					},
					EvaluatorCheck {
						check_id: "b".to_owned(),
						weight: 1,
						passed: false,
						failure_class: EvaluatorCheckFailureClass::Value,
						evidence_digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_owned(),
					},
				],
				raw_stdout_sha256: None,
			}),
			Some(0),
		);

		assert_eq!(partial.0, ResultStatus::Completed);
		assert_eq!(partial.1, EvaluationOutcome::Partial);
		assert_eq!(partial.2, Some(0.5));
		assert_eq!(partial.3.len(), 2);

		let invalid = Evaluator {
			kind: "exact_match".to_owned(),
			expected: None,
			case_sensitive: false,
			external: None,
		}
		.evaluate_checked("response", None);
		let failed = runner::evaluation_fields(invalid, Some(0));

		assert_eq!(failed.0, ResultStatus::Failed);
		assert_eq!(
			failed.4.as_ref().map(|failure| failure.kind),
			Some(FailureKind::EvaluatorFailure)
		);
		assert_eq!(failed.4.as_ref().map(|failure| failure.retryable), Some(false));
		assert_eq!(failed.2, None);
	}
}
