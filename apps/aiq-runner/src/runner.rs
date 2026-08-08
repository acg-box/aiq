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
		self, AdapterFailure, AdapterFailureKind, ArtifactReference, ArtifactSink,
		CapabilityValidationReport, CapabilityValidationStatus, CodexAdapter, CodexItemPhase,
		CodexOutput, Executor, InvocationRequest, SandboxPolicy,
	},
	capacity,
	corpus_commitment::{RunClass, RunProvenanceCommitment},
	model::{CapabilityManifest, MODEL_MATRIX, ModelConfig},
	protocol::{self, ProtocolError, ResultProvenance, TrustTier},
	resume::{self, InFlightCell, RunCheckpoint, RunCommitments},
	schedule::{self, ScheduleSlot},
	scoring::{self, AIQ_SCORING_VERSION},
	task::{
		self, Domain, EVALUATOR_RESULT_SCHEMA_VERSION, EvaluationError, EvaluationResult,
		Evaluator, EvaluatorCheck, EvaluatorContext, EvaluatorOutcome, EvaluatorRuntime,
		NormalizedToolEvidence, TASK_SCHEMA_VERSION, TaskBudgets, TaskDefinition, Visibility,
	},
};

/// Result schema version.
pub const RESULT_SCHEMA_VERSION: &str = "aiq.result.v2";
/// Run schema version.
pub const RUN_SCHEMA_VERSION: &str = "aiq.run.v3";
/// Calibration run schema version.
pub const CALIBRATION_RUN_SCHEMA_VERSION: &str = "aiq.calibration-run.v3";
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
	/// Whether a separate new run can be appropriate. Checkpoint resume never retries this result.
	pub retryable: bool,
}

/// Measured Codex adapter elapsed time. It includes model and local tool execution
/// and excludes workspace setup, workspace sealing, and evaluator replay.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Latency {
	/// Codex adapter elapsed time in wall-clock milliseconds.
	pub wall_ms: u64,
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
	/// Sum of declared wall budgets for every selected cell.
	pub declared_wall_budget_sum_seconds: u64,
	/// Largest worker load in a deterministic greedy schedule.
	pub declared_wall_budget_critical_path_seconds: u64,
	/// Capacity output is evidence only and never asserts schedule feasibility.
	pub feasibility_assessed: bool,
}

/// Runner orchestration error.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RunnerError {
	message: String,
}
impl RunnerError {
	fn new(message: impl Into<String>) -> Self {
		Self { message: message.into() }
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

			let result = execute_task(
				self.adapter,
				self.workspace_provider,
				self.manifest,
				&self.tasks[task_index],
				self.models[model_index],
				&self.commitments.run_id,
				self.codex_version,
				self.observed_at,
				self.evaluator_root,
				self.evaluator_runtime,
			)
			.and_then(|mut result| {
				result.assign_result_id()?;

				Ok(result)
			});

			if match result.as_ref() {
				Ok(result) => aborts_paid_run(result),
				Err(_) => true,
			} {
				cancelled.store(true, Ordering::Release);
			}
			if event_tx
				.send(SelectedWorkerEvent::Completed(Box::new(
					result.map(|result| (index, result)),
				)))
				.is_err()
			{
				break;
			}
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
			SelectedWorkerEvent::Completed(result) => {
				let (index, result) = (*result)?;
				let marker = InFlightCell {
					task_id: result.task_id.clone(),
					task_version: result.task_version.clone(),
					model: result.model,
				};
				let position = checkpoint
					.in_flight
					.iter()
					.position(|candidate| candidate == &marker)
					.ok_or_else(|| {
						RunnerError::new("worker completed a cell without an in-flight marker")
					})?;

				checkpoint.in_flight.remove(position);

				if committed.insert(index, result).is_some() {
					return Err(RunnerError::new("worker completed a duplicate selected cell"));
				}

				self.persist_checkpoint(checkpoint, committed)?;

				if aborts_paid_run(committed.get(&index).expect("just inserted result")) {
					return Err(RunnerError::new(
						"paid-run boundary failure aborted the remaining paid cells",
					));
				}

				Ok(())
			},
		}
	}

	fn persist_checkpoint(
		&self,
		checkpoint: &mut RunCheckpoint,
		committed: &BTreeMap<usize, TaskResult>,
	) -> Result<(), RunnerError> {
		checkpoint.results = committed.values().cloned().collect();
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
	output: &'a CodexOutput,
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
}
impl InvocationEvidence {
	fn capture(invocation: &Result<CodexOutput, AdapterFailure>, wall_ms: u64) -> Self {
		match invocation {
			Ok(output) => Self {
				wall_ms,
				exit_code: output.exit_code,
				artifacts: output.artifacts.clone(),
				tool_usage: retained_stdout_tool_usage(&output.stdout_full, &output.artifacts),
			},
			Err(failure) => Self {
				wall_ms,
				exit_code: failure.exit_code,
				artifacts: failure.artifacts.clone(),
				tool_usage: retained_stdout_tool_usage(&failure.stdout_full, &failure.artifacts),
			},
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
	Completed(Box<Result<(usize, TaskResult), RunnerError>>),
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
	let mut worker_loads = vec![0_u64; jobs.min(selected_cells)];
	let mut sum = 0_u64;

	for _model in models {
		for task in tasks {
			sum = sum
				.checked_add(task.budgets.wall_seconds)
				.ok_or_else(|| RunnerError::new("declared wall budget sum overflows"))?;

			let worker = worker_loads
				.iter()
				.enumerate()
				.min_by_key(|(index, load)| (**load, *index))
				.map(|(index, _)| index)
				.ok_or_else(|| RunnerError::new("capacity schedule has no worker"))?;

			worker_loads[worker] = worker_loads[worker]
				.checked_add(task.budgets.wall_seconds)
				.ok_or_else(|| RunnerError::new("declared worker wall budget overflows"))?;
		}
	}

	Ok(CapacityEstimate {
		schema_version: "aiq.capacity-estimate.v1".to_owned(),
		jobs,
		selected_cells,
		model_keys: models.iter().map(|model| model.key()).collect(),
		task_ids: tasks.iter().map(|task| task.task_id.clone()).collect(),
		declared_wall_budget_sum_seconds: sum,
		declared_wall_budget_critical_path_seconds: worker_loads.into_iter().max().unwrap_or(0),
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
				latency: Latency { wall_ms: 1 },
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
		execution_concurrency: Some(1),
		models: MODEL_MATRIX.to_vec(),
		started_unix_ms: scheduled_unix_ms,
		finished_unix_ms: scheduled_unix_ms,
		synthetic: true,
		capability_validation: None,
		provenance: None,
		evaluator_results_artifact,
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
		"../../../benchmarks/candidates/aiq-core-1.0.6/catalog.json"
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
				budgets: TaskBudgets { wall_seconds: 1, max_steps: 1, max_tool_calls: 0 },
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
#[must_use]
pub fn parse_codex_tool_usage(stdout: &str) -> ToolUsage {
	let mut usage = ToolUsage::default();

	for line in stdout.lines() {
		if let Ok(event) = serde_json::from_str::<Value>(line)
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

		let Some(item) = adapter::normalize_codex_item(line.as_bytes()) else {
			continue;
		};

		if item.phase != CodexItemPhase::Completed {
			continue;
		}
		if item.counts_as_step {
			usage.steps = usage.steps.saturating_add(1);
		}
		if !item.is_tool_call {
			continue;
		}

		usage.total_calls = usage.total_calls.saturating_add(1);

		let count = usage.by_tool.entry(item.raw_type).or_default();

		*count = count.saturating_add(1);
	}

	usage
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

pub(crate) fn extract_final_response(stdout: &str) -> Option<String> {
	let mut response = None;

	for line in stdout.lines() {
		let Ok(value) = serde_json::from_str::<Value>(line) else {
			continue;
		};
		let item = value.get("item").unwrap_or(&value);
		let item_type = item.get("type").and_then(Value::as_str);

		if matches!(item_type, Some("agent_message" | "message"))
			&& let Some(text) = item.get("text").and_then(Value::as_str)
		{
			response = Some(text.to_owned());
		}
	}

	if response.is_none()
		&& !stdout.trim().is_empty()
		&& serde_json::from_str::<Value>(stdout).is_err()
	{
		response = Some(stdout.trim().to_owned());
	}

	response
}

fn retained_stdout_tool_usage(stdout: &str, artifacts: &[ArtifactReference]) -> ToolUsage {
	if artifacts.iter().any(|artifact| artifact.kind == "stdout.jsonl") {
		parse_codex_tool_usage(stdout)
	} else {
		ToolUsage::default()
	}
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

	checkpoint.results = committed.into_values().collect();
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
		matches!(
			failure.kind,
			FailureKind::Authentication
				| FailureKind::SubscriptionLimit
				| FailureKind::WorkspaceIntegrity
		)
	})
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

fn build_workspace_manifest(workspace: &Path) -> Result<WorkspaceManifest, RunnerError> {
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
			execution_concurrency: Some(execution_concurrency),
			models: MODEL_MATRIX.to_vec(),
			started_unix_ms: checkpoint.started_unix_ms,
			finished_unix_ms,
			synthetic: false,
			capability_validation: Some(validation),
			provenance: Some(commitments.provenance),
			evaluator_results_artifact,
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
			execution_concurrency: Some(execution_concurrency),
			models: models.to_vec(),
			task_ids: tasks.iter().map(|task| task.task_id.clone()).collect(),
			started_unix_ms: checkpoint.started_unix_ms,
			finished_unix_ms,
			capability_validation: validation,
			provenance: commitments.provenance,
			evaluator_results_artifact,
			results: checkpoint.results,
		})
	}
}

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
			);
		},
	};
	let started = Instant::now();
	let invocation_request = task_invocation_request(task, model, &context);
	let invocation = adapter.invoke(&invocation_request);
	let wall_ms = elapsed_ms(started);
	let invocation_evidence = InvocationEvidence::capture(&invocation, wall_ms);
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
			);
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
				);
			},
		};
	let sealed_manifest_sha256 = workspace_manifest.content_hash.clone();
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

	finish_sealed_task_result(
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
	)
}

fn task_invocation_request(
	task: &TaskDefinition,
	model: ModelConfig,
	context: &TaskExecutionContext,
) -> InvocationRequest {
	InvocationRequest {
		model,
		prompt: task_prompt(task),
		timeout: Duration::from_secs(task.budgets.wall_seconds),
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
) -> Result<TaskResult, RunnerError>
where
	E: Executor,
	S: ArtifactSink,
{
	let tool_usage = parse_codex_tool_usage(&output.stdout_full);
	let complete_response = extract_final_response(&output.stdout_full);
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
	let evaluated = evaluate_result(ResultEvaluationRequest {
		task,
		model,
		run_id,
		output,
		complete_response: complete_response.as_deref(),
		workspace_dir,
		workspace_manifest,
		evaluator_root,
		evaluator_runtime,
		tool_usage: &tool_usage,
		budget_failure: budget_failure.as_deref(),
	})?;
	let mut result = TaskResult {
		schema_version: RESULT_SCHEMA_VERSION.to_owned(),
		result_id: String::new(),
		run_id: run_id.to_owned(),
		task_id: task.task_id.clone(),
		task_version: task.task_version.clone(),
		task_hash: task.content_hash()?,
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
		latency: Latency { wall_ms },
		tool_usage,
		evaluator_checks: evaluated.checks,
		workspace_manifest: Some(workspace_manifest.clone()),
		provenance: provenance(manifest, codex_version, observed_at, false),
	};

	result.bind_evaluator_result_digest()?;

	Ok(result)
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
				exit_code: request.output.exit_code,
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
				exit_code: request.output.exit_code,
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
				exit_code: request.output.exit_code,
				retryable: false,
			}),
		});
	};
	let tool_evidence = NormalizedToolEvidence {
		steps: request.tool_usage.steps,
		total_calls: request.tool_usage.total_calls,
		by_tool: request.tool_usage.by_tool.clone(),
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
	let (status, outcome, score, checks, failure) =
		evaluation_fields(result, request.output.exit_code);

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
	if tool_usage.steps > task.budgets.max_steps {
		Some(format!(
			"observed {} steps, but the task permits {}",
			tool_usage.steps, task.budgets.max_steps
		))
	} else if tool_usage.total_calls > task.budgets.max_tool_calls {
		Some(format!(
			"observed {} tool calls, but the task permits {}",
			tool_usage.total_calls, task.budgets.max_tool_calls
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
		Err(error) => (
			ResultStatus::Failed,
			EvaluationOutcome::NotEvaluated,
			None,
			Vec::new(),
			Some(ResultFailure {
				kind: FailureKind::EvaluatorFailure,
				message: format!("controlled evaluator {:?} failure: {error}", error.kind()),
				exit_code,
				retryable: true,
			}),
		),
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
		latency: Latency { wall_ms: invocation.wall_ms },
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
		latency: Latency { wall_ms },
		tool_usage: retained_stdout_tool_usage(&failure.stdout_full, &failure.artifacts),
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

	format!(
		"{}\n\nAIQ controlled execution context:\nAllowed tools: {allowed_tools}\nFixture references: {fixture_refs}\nMaximum steps: {}\nMaximum tool calls: {}",
		task.prompt, task.budgets.max_steps, task.budgets.max_tool_calls
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
		latency: Latency { wall_ms: 0 },
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
		latency: Latency { wall_ms: 0 },
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

	use crate::capacity;
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
		resume::{self, RunCheckpoint, RunCommitments},
		run_validation,
		runner::{
			self, EvaluationOutcome, FailureKind, LocalDirectoryWorkspaceProvider,
			MAX_RESULT_PREVIEW_BYTES, MAX_RUN_JOBS, ResultStatus, SelectedRun,
			TaskExecutionContext, TaskWorkspaceProvider, WorkspaceError,
		},
		schedule::{ScheduleConfig, ScheduleOccurrence, ScheduleSlot},
		scoring::{
			self, CalibrationDescriptiveStatus, FalseOnly, ScoreContext, ScoreOptions, ScoreTier,
		},
		submission::MAX_SUBMISSION_BYTES,
		task::{
			self, EVALUATOR_RESULT_SCHEMA_VERSION, EvaluationResult, Evaluator, EvaluatorCheck,
			EvaluatorOutcome, evaluator::EvaluatorCheckFailureClass,
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

	struct NeverExecutor;
	struct UsageLimitExecutor(Arc<AtomicUsize>);

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
			self.0.fetch_add(1, Ordering::SeqCst);

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
					r#"{"type":"item.started","item":{"id":"cmd-1","type":"command_execution","command":"pwd"}}"#,
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
		let configuration = BTreeMap::new();

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
			timeout_ms: 1_000,
			max_input_bytes: 8_192,
			max_output_bytes: 8_192,
			configuration,
		}
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

		let selected = super::selected_run_record(
			&tasks,
			&models,
			slot,
			validation,
			commitments,
			checkpoint,
			evaluator_results_artifact,
			1,
		);
		let SelectedRun::Calibration(run) = selected else {
			panic!("full calibration must not emit an Official RunRecord")
		};

		assert_eq!(run.schema_version, "aiq.calibration-run.v3");
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
		let checkpoint_path = root.join("checkpoint.json");
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
		let observed_at = "unix-ms:1".to_owned();
		let evidence_digest = adapter::configuration_evidence_digest(
			models[0],
			validation.cli_probe.version.as_ref(),
			&observed_at,
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
				observed_at,
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
			runner::LocalRunExecution {
				evaluator: None,
				checkpoint_path: &checkpoint_path,
				jobs: 1,
			},
		)
		.expect("first selected run");
		let second = runner::execute_selected_run(
			&adapter,
			&NeverWorkspace,
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

		fs::remove_dir_all(root).expect("fixture cleanup");
	}

	#[test]
	fn subscription_limit_is_unscored_and_aborts_new_paid_cells_across_resume() {
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

		assert!(first.to_string().contains("paid-run boundary failure"));

		let checkpoint =
			RunCheckpoint::load(&checkpoint_path, &commitments).expect("load").expect("checkpoint");

		assert_eq!(checkpoint.results.len(), 1);
		assert!(checkpoint.in_flight.is_empty());
		assert_eq!(checkpoint.results[0].task_score, None);
		assert_eq!(
			checkpoint.results[0].failure.as_ref().map(|failure| failure.kind),
			Some(FailureKind::SubscriptionLimit)
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
		.expect_err("provider account checkpoint must remain aborted");

		assert!(resumed.to_string().contains("paid-run boundary failure"));
		assert_eq!(calls.load(Ordering::SeqCst), 1);

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
			tasks.iter().map(|task| task.budgets.wall_seconds).sum::<u64>() * 2
		);
		assert!(!estimate.feasibility_assessed);

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
		let tool_evidence =
			NormalizedToolEvidence { steps: 1, total_calls: 0, by_tool: BTreeMap::new() };
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
			r#"{"type":"item.started","item":{"id":"cmd-1","type":"command_execution","command":"pwd"}}"#,
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
		let usage = runner::parse_codex_tool_usage(&stdout);

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

		for result in &mut run.results {
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

		task.budgets.max_steps = 2;
		task.budgets.max_tool_calls = 0;
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

		task.budgets.wall_seconds = 1;
		task.budgets.max_steps = 10;
		task.budgets.max_tool_calls = 10;
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
		let complete = format!("{}DECISIVE", "x".repeat(MAX_RESULT_PREVIEW_BYTES + 64));
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
		assert_eq!(failed.2, None);
	}
}
