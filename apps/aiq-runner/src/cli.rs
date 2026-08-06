//! Command-line interface for local AIQ workflows.
use std::cmp::Ordering;
use std::{
	collections::{BTreeMap, BTreeSet},
	env,
	fs::{self, File, OpenOptions},
	io::{self, ErrorKind, Read as _, Seek as _, SeekFrom, Write as _},
	mem,
	path::{Path, PathBuf},
	process,
	str::FromStr,
	time::Duration,
};
#[cfg(unix)]
use std::{
	ffi::CString,
	fs::Permissions,
	os::fd::AsRawFd as _,
	os::unix::{
		ffi::OsStrExt as _,
		fs::{MetadataExt as _, OpenOptionsExt, PermissionsExt},
	},
};

use clap::{Parser, Subcommand, ValueEnum};
use libc::O_NOFOLLOW;
#[cfg(target_os = "linux")]
use libc::{AT_FDCWD, RENAME_EXCHANGE, RENAME_NOREPLACE};
#[cfg(unix)]
use libc::{LOCK_EX, LOCK_NB};
#[cfg(target_vendor = "apple")]
use libc::{RENAME_EXCL, RENAME_SWAP};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json;
use sha2::{Digest, Sha256};

use crate::official_admission::{
	OfficialOutputPlan, OfficialPlanBinding, PermissionAdmissionReport,
};
use crate::pinned_path::{PinnedDirectoryIdentity, PinnedPathIdentity};
use aiq_runner::{
	adapter::{
		self, ArtifactSink, CapabilityValidationReport, CapabilityValidationStatus,
		ChatgptCredentialObservation, CodexAdapter, CodexExecutionConfig, ConfigurationProbeStatus,
		Executor, LocalArtifactSink, ManagedPermissionProfileEvidence, ProbeStatus, SystemExecutor,
	},
	capacity::{self, CapacityAdmission},
	corpus_commitment::{
		self, CorpusCommitmentError, ExecutionToolPolicy, RunClass, ValidatedCorpusCommitment,
		ValidatedModelToolchain,
	},
	isolation::{self, ProtectedBenchmarkPath},
	model::{CapabilityManifest, MODEL_MATRIX, ModelConfig},
	normalization::{
		self, AttestedDeploymentMetadata, ReplayStatus, VerifiedPackageIdentity,
		VerifierSigningIdentity,
	},
	protocol::{
		self, CALIBRATION_RUN_PAYLOAD_TYPE, ProtocolError, RUN_PAYLOAD_TYPE, SigningIdentity,
		SubmissionEnvelope, TrustTier,
	},
	resume::{self, PreflightAttempt, PreflightCache, RunCheckpoint, RunCommitments},
	runner::{
		self, CALIBRATION_RUN_SCHEMA_VERSION, CalibrationRunRecord,
		LocalDirectoryWorkspaceProvider, LocalRunExecution, MAX_RUN_JOBS, RUN_SCHEMA_VERSION,
		RunRecord, SelectedRun,
	},
	schedule::{ScheduleConfig, ScheduleOccurrence, ScheduleSlot},
	scoring::{
		self, AIQ_BENCHMARK_VERSION, AIQ_SCORING_VERSION, AIQ_TASK_SET_ID, AIQ_TASK_SET_VERSION,
		CalibrationScoreReport, FalseOnly, ScoreContext, ScoreOptions, ScoreReport,
	},
	submission::{
		self, DEFAULT_ARTIFACT_UPLOAD_CONCURRENCY, HttpsTransport, MAX_ARTIFACT_UPLOAD_CONCURRENCY,
		MAX_SUBMISSION_BYTES, SecretToken, SubmissionBundleOutcome,
	},
	task::{
		self, DirectoryTaskSource, EvaluatorRuntime, TaskDefinition, TaskLoadIssue, TaskLoadReport,
		TaskSource, ValidationIssue, Visibility,
	},
};

const MAX_CORPUS_COMMITMENT_BYTES: usize = 4 * 1_024 * 1_024;
const MAX_CAPABILITY_MANIFEST_BYTES: usize = 512 * 1_024;
const FUTURE_PROTECTED_PLACEHOLDER: &[u8] = b"AIQ_DENIED\n";

/// Local AIQ runner.
#[derive(Debug, Parser)]
#[command(name = "aiq-runner", version, about)]
pub struct Cli {
	#[command(subcommand)]
	command: Command,
}
impl Cli {
	/// Executes the selected command.
	pub fn run(self) -> Result<(), Box<dyn std::error::Error>> {
		run_general_cli_command(self.command)
	}
}

#[derive(Clone)]
struct RunOptions {
	public_tasks: Option<PathBuf>,
	hidden_tasks: Option<PathBuf>,
	corpus_commitment: PathBuf,
	source_root: PathBuf,
	capabilities: PathBuf,
	workspace_root: PathBuf,
	execution_root: PathBuf,
	evaluator_root: PathBuf,
	evaluator_runtime: PathBuf,
	codex_toolchain_root: PathBuf,
	schedule: PathBuf,
	slot_date: String,
	occurrence: String,
	observed_at: String,
	codex_binary: String,
	codex_home: PathBuf,
	artifact_root: PathBuf,
	preflight_cache: PathBuf,
	official_admission: Option<PathBuf>,
	refresh_preflight: bool,
	preflight_ttl_seconds: u64,
	checkpoint: PathBuf,
	task_selectors: Vec<String>,
	model_selectors: Vec<String>,
	jobs: usize,
	run_class: RunClass,
	output: PathBuf,
}

struct PermissionAdmissionOptions {
	public_tasks: Option<PathBuf>,
	hidden_tasks: Option<PathBuf>,
	corpus_commitment: PathBuf,
	source_root: PathBuf,
	capabilities: PathBuf,
	workspace_root: PathBuf,
	execution_root: PathBuf,
	evaluator_root: PathBuf,
	evaluator_runtime: PathBuf,
	codex_toolchain_root: PathBuf,
	schedule: PathBuf,
	slot_date: String,
	occurrence: String,
	observed_at: String,
	codex_binary: String,
	codex_home: PathBuf,
	artifact_root: PathBuf,
	preflight_cache: PathBuf,
	checkpoint: PathBuf,
	jobs: usize,
	planned_output: PathBuf,
	planned_score_output: PathBuf,
	planned_package_output: PathBuf,
	report_output: PathBuf,
}

struct PreparedPermissionAdmission {
	adapter: CodexAdapter<SystemExecutor, LocalArtifactSink>,
	execution_root: PathBuf,
	protected_paths: Vec<ProtectedBenchmarkPath>,
	plan: OfficialPlanBinding,
}

struct BenchmarkProtectedPathInputs<'a> {
	public_tasks: Option<&'a Path>,
	hidden_tasks: Option<&'a Path>,
	source_root: &'a Path,
	workspace_root: &'a Path,
	evaluator_root: &'a Path,
	artifact_root: &'a Path,
	codex_home: &'a Path,
	codex_binary: &'a Path,
	corpus_commitment: &'a Path,
	capabilities: &'a Path,
	schedule: &'a Path,
	preflight_cache: &'a Path,
	checkpoint: &'a Path,
	planned_output: &'a Path,
	planned_score_output: Option<&'a Path>,
	planned_package_output: Option<&'a Path>,
	report_output: Option<&'a Path>,
	official_admission: Option<&'a Path>,
}

struct ExactFileBinding {
	path: PathBuf,
	file: File,
	identity: PinnedPathIdentity,
	sha256: String,
	maximum_bytes: usize,
	label: &'static str,
}
impl ExactFileBinding {
	fn capture(
		path: &Path,
		label: &'static str,
		maximum_bytes: usize,
	) -> Result<Self, Box<dyn std::error::Error>> {
		let metadata = fs::symlink_metadata(path)
			.map_err(|error| format!("cannot inspect {label}: {error}"))?;

		if metadata.file_type().is_symlink() || !metadata.is_file() {
			return Err(format!("{label} must be a non-symlink regular file").into());
		}

		let path = fs::canonicalize(path)?;
		let mut options = OpenOptions::new();

		options.read(true);
		#[cfg(unix)]
		options.custom_flags(O_NOFOLLOW);

		let file = options.open(&path)?;
		let identity = PinnedPathIdentity::capture(&path, &file)
			.map_err(|error| format!("cannot pin {label}: {error}"))?;
		let bytes = read_held_bounded_file(&file, label, maximum_bytes)?;
		let binding =
			Self { path, file, identity, sha256: raw_sha256(&bytes), maximum_bytes, label };

		binding.identity.verify(&binding.path, &binding.file).map_err(|error| {
			format!("cannot verify the pinned {} identity: {error}", binding.label)
		})?;

		Ok(binding)
	}

	fn read_verified(&self) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
		self.identity.verify(&self.path, &self.file).map_err(|error| {
			format!("{} identity changed before capability probing: {error}", self.label)
		})?;

		let bytes = read_held_bounded_file(&self.file, self.label, self.maximum_bytes)?;

		self.identity.verify(&self.path, &self.file).map_err(|error| {
			format!("{} identity changed while revalidating: {error}", self.label)
		})?;

		if raw_sha256(&bytes) != self.sha256 {
			return Err(format!("{} bytes changed before live dispatch", self.label).into());
		}

		Ok(bytes)
	}

	fn verify(&self) -> Result<(), Box<dyn std::error::Error>> {
		self.read_verified().map(drop)
	}
}

struct PreflightAdmissionBinding {
	capabilities: ExactFileBinding,
	corpus_commitment: ExactFileBinding,
	execution_policy: ExecutionToolPolicy,
	evaluator_runtime_path: PathBuf,
	evaluator_runtime_digest: String,
	evaluator_runtime_version: String,
	codex_toolchain_root: PathBuf,
	model_toolchain: ValidatedModelToolchain,
	codex_binary: String,
	codex_executable_digest: String,
	codex_home: PinnedDirectoryIdentity,
	credential: ChatgptCredentialObservation,
	profile_workspace: PinnedDirectoryIdentity,
	profile: ManagedPermissionProfileEvidence,
	artifact_root: PinnedDirectoryIdentity,
	output_parent: PinnedDirectoryIdentity,
}
impl PreflightAdmissionBinding {
	fn capture<E, S>(
		adapter: &CodexAdapter<E, S>,
		inputs: PreflightAdmissionInputs<'_>,
	) -> Result<Self, Box<dyn std::error::Error>>
	where
		E: Executor,
		S: ArtifactSink,
	{
		let capabilities = ExactFileBinding::capture(
			inputs.capabilities,
			"capability manifest",
			MAX_CAPABILITY_MANIFEST_BYTES,
		)?;
		let corpus_commitment = ExactFileBinding::capture(
			inputs.corpus_commitment,
			"corpus commitment",
			MAX_CORPUS_COMMITMENT_BYTES,
		)?;
		let codex_home_path = fs::canonicalize(inputs.codex_home)?;
		let profile_workspace_path = fs::canonicalize(inputs.profile_workspace)?;
		let artifact_root_path = fs::canonicalize(inputs.artifact_root)?;
		let output_parent_path = controlled_output_parent(inputs.output)?;

		Ok(Self {
			capabilities,
			corpus_commitment,
			execution_policy: inputs.execution_policy.clone(),
			evaluator_runtime_path: inputs.evaluator_runtime.executable().to_owned(),
			evaluator_runtime_digest: inputs.evaluator_runtime.executable_digest().to_owned(),
			evaluator_runtime_version: inputs.evaluator_runtime.version().to_owned(),
			codex_toolchain_root: inputs.codex_toolchain_root.to_owned(),
			model_toolchain: inputs.model_toolchain.clone(),
			codex_binary: inputs.codex_binary.to_owned(),
			codex_executable_digest: corpus_commitment::codex_executable_digest(
				inputs.codex_binary,
			)?,
			codex_home: PinnedDirectoryIdentity::capture(&codex_home_path)?,
			credential: adapter::chatgpt_credential_observation(&codex_home_path)?,
			profile_workspace: PinnedDirectoryIdentity::capture(&profile_workspace_path)?,
			profile: adapter.verify_managed_permission_profile(&profile_workspace_path)?,
			artifact_root: PinnedDirectoryIdentity::capture(&artifact_root_path)?,
			output_parent: PinnedDirectoryIdentity::capture(&output_parent_path)?,
		})
	}

	fn verify<E, S>(&self, adapter: &CodexAdapter<E, S>) -> Result<(), Box<dyn std::error::Error>>
	where
		E: Executor,
		S: ArtifactSink,
	{
		self.capabilities.verify()?;
		self.corpus_commitment.verify()?;

		let policy = corpus_commitment::read_execution_tool_policy(&self.corpus_commitment.path)?;

		if policy != self.execution_policy {
			return Err("corpus execution policy changed before a capability probe".into());
		}

		let evaluator_runtime = EvaluatorRuntime::resolve_committed(
			&self.evaluator_runtime_path,
			&self.evaluator_runtime_version,
		)?;

		if evaluator_runtime.executable_digest() != self.evaluator_runtime_digest {
			return Err("evaluator runtime bytes changed before a capability probe".into());
		}

		let model_toolchain = corpus_commitment::validate_model_toolchain_static(
			&self.codex_toolchain_root,
			&policy,
			&evaluator_runtime,
		)?;

		if model_toolchain != self.model_toolchain {
			return Err("model toolchain bytes changed before a capability probe".into());
		}
		if corpus_commitment::codex_executable_digest(&self.codex_binary)?
			!= self.codex_executable_digest
		{
			return Err("Codex executable bytes changed before a capability probe".into());
		}

		self.codex_home.verify()?;

		if adapter::chatgpt_credential_observation(self.codex_home.path())? != self.credential {
			return Err(
				"Codex home or credential identity changed before a capability probe".into()
			);
		}

		self.profile_workspace.verify()?;

		if adapter.verify_managed_permission_profile(self.profile_workspace.path())? != self.profile
		{
			return Err(
				"explicit permission profile evidence changed before a capability probe".into()
			);
		}

		self.artifact_root.verify()?;

		Ok(self.output_parent.verify()?)
	}
}

struct PreflightAdmissionInputs<'a> {
	capabilities: &'a Path,
	corpus_commitment: &'a Path,
	execution_policy: &'a ExecutionToolPolicy,
	evaluator_runtime: &'a EvaluatorRuntime,
	codex_toolchain_root: &'a Path,
	model_toolchain: &'a ValidatedModelToolchain,
	codex_binary: &'a str,
	codex_home: &'a Path,
	profile_workspace: &'a Path,
	artifact_root: &'a Path,
	output: &'a Path,
}

#[derive(Serialize)]
struct MatrixReport {
	schema_version: &'static str,
	models: Vec<ModelConfig>,
}

#[derive(Serialize)]
struct ValidationReport {
	schema_version: &'static str,
	valid: bool,
	task_count: usize,
	task_ids: Vec<String>,
	issues: Vec<PublicTaskLoadIssue>,
}
impl ValidationReport {
	fn public_safe(
		report: &TaskLoadReport,
		public_tasks: Option<&Path>,
		hidden_tasks: Option<&Path>,
	) -> Self {
		let mut source_ordinals = BTreeMap::<(&'static str, String), usize>::new();
		let issues = report
			.issues
			.iter()
			.map(|issue| {
				PublicTaskLoadIssue::public_safe(
					issue,
					public_tasks,
					hidden_tasks,
					&mut source_ordinals,
				)
			})
			.collect();

		Self {
			schema_version: "aiq.validation.v2",
			valid: report.issues.is_empty(),
			task_count: report.tasks.len(),
			task_ids: report.tasks.iter().map(|task| task.task_id.clone()).collect(),
			issues,
		}
	}
}

#[derive(Debug, Serialize)]
struct PublicTaskLoadIssue {
	source: String,
	code: String,
	field: Option<String>,
	message: &'static str,
}
impl PublicTaskLoadIssue {
	fn public_safe(
		issue: &TaskLoadIssue,
		public_tasks: Option<&Path>,
		hidden_tasks: Option<&Path>,
		source_ordinals: &mut BTreeMap<(&'static str, String), usize>,
	) -> Self {
		let source_path = Path::new(&issue.source);
		let public_match = public_tasks.filter(|root| source_path.starts_with(root));
		let hidden_match = hidden_tasks.filter(|root| source_path.starts_with(root));
		let scope = match (public_match, hidden_match) {
			(Some(public), Some(hidden)) => {
				match public.components().count().cmp(&hidden.components().count()) {
					Ordering::Less => "hidden_tasks",
					Ordering::Greater => "public_tasks",
					Ordering::Equal => "task_source",
				}
			},
			(Some(_), None) => "public_tasks",
			(None, Some(_)) => "hidden_tasks",
			(None, None) => "task_source",
		};
		let next = source_ordinals.keys().filter(|(candidate, _)| *candidate == scope).count() + 1;
		let ordinal = *source_ordinals.entry((scope, issue.source.clone())).or_insert(next);

		Self {
			source: format!("{scope}[{ordinal}]"),
			code: issue.issue.code.clone(),
			field: issue.issue.field.clone(),
			message: safe_task_issue_message(&issue.issue.code),
		}
	}
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ScoreBundle {
	schema_version: String,
	synthetic: bool,
	scores: Vec<ScoreReport>,
}

#[derive(Serialize)]
struct CalibrationScoreBundle {
	schema_version: &'static str,
	run_class: &'static str,
	official_eligible: FalseOnly,
	ranking_eligible: FalseOnly,
	scores: Vec<CalibrationScoreReport>,
}

#[derive(Serialize)]
struct DemoBundle {
	schema_version: &'static str,
	synthetic: bool,
	disclaimer: &'static str,
	run: RunRecord,
	scores: Vec<ScoreReport>,
}

struct PreparedRun {
	report: TaskLoadReport,
	selected_models: Vec<ModelConfig>,
	corpus: ValidatedCorpusCommitment,
	conservative_capacity: CapacityAdmission,
	slot: ScheduleSlot,
	task_set_hash: String,
	run_id: String,
	execution_window: ExecutionWindow,
}

struct AuthorizedRun {
	capacity_admission: CapacityAdmission,
	options: RunOptions,
	report: TaskLoadReport,
	selected_models: Vec<ModelConfig>,
	corpus: ValidatedCorpusCommitment,
	adapter: CodexAdapter<SystemExecutor, LocalArtifactSink>,
	workspace_provider: LocalDirectoryWorkspaceProvider,
	evaluator_root: PathBuf,
	evaluator_runtime: EvaluatorRuntime,
	model_toolchain: ValidatedModelToolchain,
	manifest: CapabilityManifest,
	future_files: FutureProtectedFiles,
	permission_evidence_digest: String,
	slot: ScheduleSlot,
	task_set_hash: String,
	run_id: String,
	runner_executable_digest: String,
	codex_executable_digest: String,
	codex_binary_commitment: String,
	codex_home_commitment: String,
	preflight: PreflightCache,
	execution_window: ExecutionWindow,
}

struct ExecutedLiveRun {
	run: SelectedRun,
	tasks: Vec<TaskDefinition>,
	options: RunOptions,
	future_files: FutureProtectedFiles,
	dispatch_deadline: DispatchDeadline,
}

struct PreparedLiveRuntime {
	adapter: CodexAdapter<SystemExecutor, LocalArtifactSink>,
	workspace_provider: LocalDirectoryWorkspaceProvider,
	evaluator_root: PathBuf,
	evaluator_runtime: EvaluatorRuntime,
	model_toolchain: ValidatedModelToolchain,
	manifest: CapabilityManifest,
	future_files: FutureProtectedFiles,
	permission_evidence: VerifiedPermissionEvidence,
	runner_executable_digest: String,
	codex_executable_digest: String,
	codex_home_commitment: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ExecutionWindow {
	scheduled_unix_ms: u64,
	next_slot_unix_ms: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct DispatchDeadline {
	dispatched_unix_ms: u64,
	next_slot_unix_ms: u64,
}

#[derive(Debug)]
struct PermissionEvidenceDigests {
	permission_policy_digest: String,
	managed_requirements_digest: String,
	profile_selection_digest: String,
	canary_digest: String,
}
impl PermissionEvidenceDigests {
	fn combined_digest(&self) -> Result<String, ProtocolError> {
		protocol::canonical_hash(&(
			"aiq.permission-evidence.v1",
			&self.permission_policy_digest,
			&self.managed_requirements_digest,
			&self.profile_selection_digest,
			&self.canary_digest,
		))
	}
}

#[derive(Debug)]
struct VerifiedPermissionEvidence {
	profile: ManagedPermissionProfileEvidence,
	digests: PermissionEvidenceDigests,
}
impl VerifiedPermissionEvidence {
	fn combined_digest(&self) -> Result<String, ProtocolError> {
		self.digests.combined_digest()
	}
}

struct OfficialPlanningInputs<'a> {
	public_tasks: Option<&'a Path>,
	hidden_tasks: Option<&'a Path>,
	corpus_commitment: &'a Path,
	capabilities: &'a Path,
	source_root: &'a Path,
	workspace_root: &'a Path,
	execution_root: &'a Path,
	evaluator_root: &'a Path,
	evaluator_runtime: &'a Path,
	codex_toolchain_root: &'a Path,
	codex_binary: &'a str,
	codex_home: &'a Path,
	artifact_root: &'a Path,
	schedule: &'a Path,
	observed_at: &'a str,
	preflight_cache: &'a Path,
	checkpoint: &'a Path,
	run_output: &'a Path,
	score_output: &'a Path,
	package_output: &'a Path,
	reserved_run_output_for: Option<&'a str>,
}

struct FutureProtectedEntry {
	category: &'static str,
	path: PathBuf,
	must_be_new: bool,
	recoverable_bytes: Option<Vec<u8>>,
}

#[derive(Default)]
struct FutureProtectedFiles {
	created: BTreeMap<PathBuf, FutureProtectedFile>,
	directory_locks: FutureProtectedDirectoryLocks,
}
impl FutureProtectedFiles {
	#[cfg(test)]
	fn prepare(entries: &[FutureProtectedEntry]) -> Result<Self, Box<dyn std::error::Error>> {
		let directory_locks = FutureProtectedDirectoryLocks::acquire(entries)?;

		Self::prepare_with_locks(entries, directory_locks)
	}

	#[cfg(test)]
	fn prepare_with_locks(
		entries: &[FutureProtectedEntry],
		directory_locks: FutureProtectedDirectoryLocks,
	) -> Result<Self, Box<dyn std::error::Error>> {
		let mut files = Self::with_locks(directory_locks);

		for entry in entries {
			files.prepare_entry(entry)?;
		}

		Ok(files)
	}

	fn with_locks(directory_locks: FutureProtectedDirectoryLocks) -> Self {
		Self { created: BTreeMap::new(), directory_locks }
	}

	fn prepare_entry(
		&mut self,
		entry: &FutureProtectedEntry,
	) -> Result<(), Box<dyn std::error::Error>> {
		if entry.path == Path::new("-") {
			return Ok(());
		}

		let path = canonical_leaf_policy_path(&entry.path)?;

		self.verify_directory_lock(&path)?;

		let expected_bytes =
			entry.recoverable_bytes.as_deref().unwrap_or(FUTURE_PROTECTED_PLACEHOLDER);

		match fs::symlink_metadata(&path) {
			Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
				return Err(format!(
					"future protected category {} must be a regular file",
					entry.category
				)
				.into());
			},
			Ok(_) if entry.must_be_new => {
				if entry.recoverable_bytes.is_none() {
					return Err(format!(
						"future protected category {} must not exist before this run",
						entry.category
					)
					.into());
				}

				let recovered = open_exact_reserved_file(
					&path,
					expected_bytes,
					"future protected reservation",
				)?;

				if self
					.created
					.insert(
						path.clone(),
						FutureProtectedFile {
							file: recovered,
							remove_on_drop: false,
							expected_bytes: expected_bytes.to_vec(),
						},
					)
					.is_some()
				{
					return Err("future protected paths must be distinct".into());
				}

				return Ok(());
			},
			Ok(_) => return Ok(()),
			Err(error) if error.kind() == ErrorKind::NotFound => {},
			Err(error) => return Err(error.into()),
		}

		let created_file = write_new_bytes(&path, expected_bytes, "future protected placeholder")?;

		if self
			.created
			.insert(
				path.clone(),
				FutureProtectedFile {
					file: created_file,
					remove_on_drop: !entry.must_be_new,
					expected_bytes: expected_bytes.to_vec(),
				},
			)
			.is_some()
		{
			return Err("future protected paths must be distinct".into());
		}

		Ok(())
	}

	fn write_created_pretty_json(
		&mut self,
		path: &Path,
		value: &impl Serialize,
		label: &str,
	) -> Result<(), Box<dyn std::error::Error>> {
		let path = canonical_leaf_policy_path(path)?;

		self.verify_directory_lock(&path)?;

		let created = self
			.created
			.get_mut(&path)
			.ok_or("future protected path was not created by this run")?;
		let mut bytes = serde_json::to_vec_pretty(value)?;

		bytes.push(b'\n');

		created.file = atomically_replace_exact_created_file(
			&path,
			&created.expected_bytes,
			&created.file,
			&bytes,
			label,
		)?;
		created.expected_bytes = bytes;

		Ok(())
	}

	fn verify_directory_lock(&self, path: &Path) -> Result<(), Box<dyn std::error::Error>> {
		self.directory_locks.verify(path).map_err(Into::into)
	}

	fn was_created(&self, path: &Path) -> bool {
		canonical_leaf_policy_path(path).is_ok_and(|path| self.created.contains_key(&path))
	}

	fn disarm(&mut self, path: &Path) {
		if let Ok(path) = canonical_leaf_policy_path(path) {
			self.created.remove(&path);
		}
	}

	fn cleanup(&mut self) {
		for (path, created) in mem::take(&mut self.created) {
			if created.remove_on_drop {
				let _ = remove_exact_created_file(
					&path,
					&created.expected_bytes,
					&created.file,
					"future protected placeholder",
				);
			}
		}
	}
}

impl Drop for FutureProtectedFiles {
	fn drop(&mut self) {
		self.cleanup();
	}
}

#[derive(Default)]
struct FutureProtectedDirectoryLocks {
	locks: BTreeMap<PathBuf, FutureProtectedDirectoryLock>,
}
impl FutureProtectedDirectoryLocks {
	fn acquire(entries: &[FutureProtectedEntry]) -> Result<Self, Box<dyn std::error::Error>> {
		let mut parents = BTreeSet::new();

		for entry in entries {
			if entry.path != Path::new("-") {
				let path = canonical_leaf_policy_path(&entry.path)?;
				let parent = path.parent().ok_or("future protected path has no parent")?;

				parents.insert(parent.to_owned());
			}
		}

		let mut locks = BTreeMap::new();

		for parent in parents {
			let lock = FutureProtectedDirectoryLock::acquire(&parent)?;
			let _ = locks.insert(parent, lock);
		}

		Ok(Self { locks })
	}

	fn verify(&self, path: &Path) -> Result<(), String> {
		let parent = path.parent().ok_or("future protected path has no parent")?;
		let lock =
			self.locks.get(parent).ok_or("future protected parent is not locked by this run")?;

		lock.verify()
	}
}

struct FutureProtectedFile {
	file: File,
	remove_on_drop: bool,
	expected_bytes: Vec<u8>,
}

struct FutureProtectedDirectoryLock {
	#[cfg(unix)]
	file: File,
	#[cfg(unix)]
	path: PathBuf,
	#[cfg(unix)]
	device: u64,
	#[cfg(unix)]
	inode: u64,
	#[cfg(not(unix))]
	_unavailable: (),
}
impl FutureProtectedDirectoryLock {
	fn acquire(path: &Path) -> Result<Self, Box<dyn std::error::Error>> {
		#[cfg(not(unix))]
		{
			let _ = path;

			return Err("future protected directory locking is unavailable on this platform".into());
		}
		#[cfg(unix)]
		{
			let file = File::open(path)?;
			let metadata = file.metadata()?;

			if !metadata.is_dir()
				|| metadata.uid() != unsafe { libc::geteuid() }
				|| metadata.permissions().mode() & 0o022 != 0
			{
				return Err(
				"future protected parent must be an owner-controlled directory without group or other write access"
					.into(),
				);
			}
			// SAFETY: the held descriptor is valid for this call and remains live in Self.
			let lock_result = unsafe { libc::flock(file.as_raw_fd(), LOCK_EX | LOCK_NB) };

			if lock_result != 0 {
				return Err(
					"another AIQ writer already holds the future protected parent lock".into()
				);
			}

			let lock =
				Self { file, path: path.to_owned(), device: metadata.dev(), inode: metadata.ino() };

			lock.verify()?;

			Ok(lock)
		}
	}

	fn verify(&self) -> Result<(), String> {
		#[cfg(not(unix))]
		return Err("future protected directory locking is unavailable on this platform".to_owned());

		#[cfg(unix)]
		{
			let held = self
				.file
				.metadata()
				.map_err(|_| "cannot inspect the held future protected parent lock".to_owned())?;
			let current = fs::symlink_metadata(&self.path)
				.map_err(|_| "future protected parent path changed".to_owned())?;

			if current.file_type().is_symlink()
				|| !current.is_dir()
				|| current.uid() != unsafe { libc::geteuid() }
				|| current.permissions().mode() & 0o022 != 0
				|| held.dev() != self.device
				|| held.ino() != self.inode
				|| current.dev() != self.device
				|| current.ino() != self.inode
			{
				return Err("future protected parent identity changed while locked".to_owned());
			}

			Ok(())
		}
	}
}

#[derive(Default)]
struct PermissionProbeCanaries {
	paths: Vec<PathBuf>,
	created: Vec<PathBuf>,
	bindings: Vec<(&'static str, String, &'static str)>,
}
impl PermissionProbeCanaries {
	fn prepare(
		protected_paths: &[ProtectedBenchmarkPath],
	) -> Result<Self, Box<dyn std::error::Error>> {
		if protected_paths.is_empty() {
			return Err("permission probe requires at least one denied root".into());
		}

		let mut canaries = Self::default();

		for (index, protected) in protected_paths.iter().enumerate() {
			let root = &protected.path;
			let protected_root_digest = path_digest(root)?;
			let metadata = match fs::symlink_metadata(root) {
				Ok(metadata) => metadata,
				Err(error) if error.kind() == ErrorKind::NotFound => {
					let path = create_permission_probe_file(root)?;
					let path = fs::canonicalize(&path)?;

					canaries.bindings.push((
						protected.category,
						protected_root_digest,
						"denied_read_canary",
					));
					canaries.paths.push(path.clone());
					canaries.created.push(path);

					continue;
				},
				Err(error) => return Err(error.into()),
			};

			if metadata.file_type().is_symlink() || (!metadata.is_file() && !metadata.is_dir()) {
				return Err(format!(
					"permission-probe denied root is not a regular file or directory: {}",
					root.display()
				)
				.into());
			}
			if metadata.is_file() {
				let path = fs::canonicalize(root)?;

				canaries.bindings.push((
					protected.category,
					protected_root_digest,
					"denied_read_canary",
				));
				canaries.paths.push(path);

				continue;
			}

			match create_permission_probe_file_in(root, index) {
				Ok(path) => {
					let canonical = fs::canonicalize(&path)?;

					canaries.bindings.push((
						protected.category,
						protected_root_digest,
						"denied_read_canary",
					));
					canaries.paths.push(canonical);
					canaries.created.push(path);
				},
				Err(create_error) => {
					let path = find_regular_probe_file(root).map_err(|find_error| {
						format!(
							"cannot create or find a denied canary below {}: create: {create_error}; find: {find_error}",
							root.display()
						)
					})?;

					canaries.bindings.push((
						protected.category,
						protected_root_digest,
						"denied_read_canary",
					));
					canaries.paths.push(path);
				},
			}
		}

		Ok(canaries)
	}

	fn evidence_digest(&self) -> Result<String, Box<dyn std::error::Error>> {
		permission_canary_evidence_digest(&self.bindings)
	}

	fn cleanup(&mut self) -> Result<(), Box<dyn std::error::Error>> {
		let mut first_error = None;

		for path in self.created.drain(..).rev() {
			if let Err(error) = fs::remove_file(&path)
				&& first_error.is_none()
			{
				first_error = Some(format!(
					"cannot remove denied permission canary {}: {error}",
					path.display()
				));
			}
		}

		first_error.map_or(Ok(()), |error| Err(error.into()))
	}
}

impl Drop for PermissionProbeCanaries {
	fn drop(&mut self) {
		for path in self.created.drain(..).rev() {
			let _ = fs::remove_file(path);
		}
	}
}

struct DemoOutputs<'a> {
	package: &'a Path,
	run: Option<&'a Path>,
	scores: Option<&'a Path>,
	metadata: Option<&'a Path>,
}

struct ValidationOptions {
	public_tasks: Option<PathBuf>,
	hidden_tasks: Option<PathBuf>,
	corpus_commitment: Option<PathBuf>,
	source_root: Option<PathBuf>,
	evaluator_root: Option<PathBuf>,
	evaluator_runtime: Option<PathBuf>,
	codex_toolchain_root: Option<PathBuf>,
	mode: CorpusValidationMode,
}

impl From<ReplayMode> for ReplayStatus {
	fn from(value: ReplayMode) -> Self {
		match value {
			ReplayMode::CommitmentsVerified => Self::CommitmentsVerified,
			ReplayMode::Failed => Self::Failed,
		}
	}
}

impl From<RunClassArgument> for RunClass {
	fn from(value: RunClassArgument) -> Self {
		match value {
			RunClassArgument::Calibration => Self::Calibration,
			RunClassArgument::Official => Self::Official,
		}
	}
}

#[allow(clippy::large_enum_variant)]
#[derive(Debug, Subcommand)]
enum Command {
	/// Print the exact static model matrix.
	Matrix {
		/// Machine-readable JSON output file, or `-` for standard output.
		#[arg(long, default_value = "-")]
		output: PathBuf,
	},
	/// Validate the immutable 72-task AIQ Core corpus without invoking Codex.
	ValidateCoreCorpus {
		#[arg(long)]
		hidden_tasks: PathBuf,
		#[arg(long)]
		corpus_commitment: PathBuf,
		#[arg(long)]
		source_root: PathBuf,
		#[arg(long)]
		evaluator_root: PathBuf,
		#[arg(long)]
		evaluator_runtime: PathBuf,
		#[arg(long)]
		codex_toolchain_root: PathBuf,
	},
	/// Validate the immutable six-variant controlled contrast corpus without invoking Codex.
	ValidateContrastCorpus {
		#[arg(long)]
		hidden_tasks: PathBuf,
		#[arg(long)]
		corpus_commitment: PathBuf,
		/// Exact canonical contrast commitment digest expected by the caller.
		#[arg(long)]
		expected_corpus_sha256: String,
		#[arg(long)]
		source_root: PathBuf,
		#[arg(long)]
		evaluator_root: PathBuf,
		#[arg(long)]
		evaluator_runtime: PathBuf,
		#[arg(long)]
		codex_toolchain_root: PathBuf,
	},
	/// Actively validate and persist an authenticated, expiring capability report.
	Preflight {
		/// Capability manifest to compare with the local Codex CLI.
		#[arg(long)]
		capabilities: PathBuf,
		/// Current corpus commitment for model toolchain validation.
		#[arg(long)]
		corpus_commitment: PathBuf,
		/// Absolute Node.js runtime path committed by the corpus.
		#[arg(long)]
		evaluator_runtime: PathBuf,
		/// Absolute controlled Node.js and ripgrep toolchain root.
		#[arg(long)]
		codex_toolchain_root: PathBuf,
		/// Absolute executable inspected, checked for executability, and canonicalized before
		/// preflight.
		#[arg(long, value_parser = parse_controlled_codex_binary)]
		codex_binary: String,
		/// Absolute existing non-symlink directory for the operator's subscription Codex home.
		#[arg(long, value_parser = parse_controlled_codex_home)]
		codex_home: PathBuf,
		/// Controlled local sink for bounded preflight artifacts.
		#[arg(long, default_value = ".aiq-artifacts")]
		artifact_root: PathBuf,
		/// Cache validity from the current time.
		#[arg(long, default_value_t = 86_400)]
		expires_in_seconds: u64,
		/// Machine-readable persisted preflight JSON.
		#[arg(long)]
		output: PathBuf,
		/// Successful model-free Official admission receipt for this exact paid preflight.
		#[arg(long)]
		official_admission: Option<PathBuf>,
	},
	/// Prove the exact Official Codex permission boundary without invoking a model.
	AdmitPermissions {
		/// Directory of public-example task JSON files.
		#[arg(long)]
		public_tasks: Option<PathBuf>,
		/// Controlled directory of hidden task JSON files.
		#[arg(long)]
		hidden_tasks: Option<PathBuf>,
		/// Current public-safe controlled-corpus commitment.
		#[arg(long)]
		corpus_commitment: PathBuf,
		/// Repository root used to verify every committed runner source byte.
		#[arg(long)]
		source_root: PathBuf,
		/// Capability manifest protected from benchmark children.
		#[arg(long)]
		capabilities: PathBuf,
		/// Controlled root containing one workspace directory per task identifier.
		#[arg(long)]
		workspace_root: PathBuf,
		/// Separate controlled root for fresh per-run, model, and task working copies.
		#[arg(long)]
		execution_root: PathBuf,
		/// Controlled registry root for committed external evaluator scripts.
		#[arg(long)]
		evaluator_root: PathBuf,
		/// Absolute Node.js runtime path for committed external evaluator scripts.
		#[arg(long)]
		evaluator_runtime: PathBuf,
		/// Absolute controlled Node.js and ripgrep toolchain root.
		#[arg(long)]
		codex_toolchain_root: PathBuf,
		/// Approved schedule JSON protected from benchmark children.
		#[arg(long)]
		schedule: PathBuf,
		/// Exact local Official slot date in YYYY-MM-DD format.
		#[arg(long)]
		slot_date: String,
		/// Exact Official slot occurrence: day or night.
		#[arg(long)]
		occurrence: String,
		/// Exact provenance observation value planned for the Official run.
		#[arg(long, value_parser = parse_run_observed_at)]
		observed_at: String,
		/// Absolute executable inspected, checked for executability, and canonicalized before use.
		#[arg(long, value_parser = parse_controlled_codex_binary)]
		codex_binary: String,
		/// Absolute existing non-symlink directory for the operator's subscription Codex home.
		#[arg(long, value_parser = parse_controlled_codex_home)]
		codex_home: PathBuf,
		/// Controlled local artifact sink.
		#[arg(long)]
		artifact_root: PathBuf,
		/// Planned persisted preflight cache path. It may be absent before paid preflight or
		/// retained for an exact unchanged resume, and is protected from benchmark children.
		#[arg(long)]
		preflight_cache: PathBuf,
		/// Planned durable per-attempt checkpoint. This command does not reserve it.
		#[arg(long)]
		checkpoint: PathBuf,
		/// Maximum concurrent live model and task workers used for conservative admission.
		#[arg(long)]
		jobs: usize,
		/// Planned create-once Official run output. This command does not reserve it.
		#[arg(long)]
		planned_output: PathBuf,
		/// Planned create-once Official score output.
		#[arg(long)]
		planned_score_output: PathBuf,
		/// Planned create-once signed Official package output.
		#[arg(long)]
		planned_package_output: PathBuf,
		/// Durable private permission-admission JSON receipt.
		#[arg(long)]
		output: PathBuf,
	},
	/// Validate controlled task sources without invoking Codex.
	Validate {
		/// Directory of public-example task JSON files.
		#[arg(long)]
		public_tasks: Option<PathBuf>,
		/// Controlled directory of hidden task JSON files.
		#[arg(long)]
		hidden_tasks: Option<PathBuf>,
		/// Current corpus commitment for model toolchain validation.
		#[arg(
			long,
			requires_all = ["source_root", "evaluator_root", "evaluator_runtime", "codex_toolchain_root"]
		)]
		corpus_commitment: Option<PathBuf>,
		/// Repository root used to verify the committed runner source manifest.
		#[arg(
			long,
			requires_all = ["corpus_commitment", "evaluator_root", "evaluator_runtime", "codex_toolchain_root"]
		)]
		source_root: Option<PathBuf>,
		/// Controlled registry root for committed external evaluator scripts.
		#[arg(
			long,
			requires_all = ["corpus_commitment", "source_root", "evaluator_runtime", "codex_toolchain_root"]
		)]
		evaluator_root: Option<PathBuf>,
		/// Absolute Node.js runtime path for committed external evaluator scripts.
		#[arg(
			long,
			requires_all = ["corpus_commitment", "source_root", "evaluator_root", "codex_toolchain_root"]
		)]
		evaluator_runtime: Option<PathBuf>,
		/// Absolute controlled Node.js and ripgrep toolchain root.
		#[arg(
			long,
			requires_all = ["corpus_commitment", "source_root", "evaluator_root", "evaluator_runtime"]
		)]
		codex_toolchain_root: Option<PathBuf>,
	},
	/// Run every controlled task against the exact 17-entry matrix.
	Run {
		/// Directory of public-example task JSON files.
		#[arg(long)]
		public_tasks: Option<PathBuf>,
		/// Controlled directory of hidden task JSON files.
		#[arg(long)]
		hidden_tasks: Option<PathBuf>,
		/// Current public-safe controlled-corpus commitment.
		#[arg(long)]
		corpus_commitment: PathBuf,
		/// Repository root used to verify every committed runner source byte.
		#[arg(long)]
		source_root: PathBuf,
		/// Required capability manifest.
		#[arg(long)]
		capabilities: PathBuf,
		/// Controlled root containing one workspace directory per task identifier.
		#[arg(long)]
		workspace_root: PathBuf,
		/// Separate controlled root for fresh per-run, model, and task working copies.
		#[arg(long)]
		execution_root: PathBuf,
		/// Controlled registry root for committed external evaluator scripts.
		#[arg(long)]
		evaluator_root: PathBuf,
		/// Absolute Node.js runtime path for committed external evaluator scripts.
		#[arg(long)]
		evaluator_runtime: PathBuf,
		/// Absolute controlled Node.js and ripgrep toolchain root.
		#[arg(long)]
		codex_toolchain_root: PathBuf,
		/// Required approved schedule JSON. The runner never selects a deployment schedule.
		#[arg(long)]
		schedule: PathBuf,
		/// Local slot date in YYYY-MM-DD format.
		#[arg(long)]
		slot_date: String,
		/// Slot occurrence: day or night.
		#[arg(long)]
		occurrence: String,
		/// Provenance observation time.
		#[arg(long, value_parser = parse_run_observed_at)]
		observed_at: String,
		/// Absolute executable inspected, checked for executability, and canonicalized before use.
		#[arg(long, value_parser = parse_controlled_codex_binary)]
		codex_binary: String,
		/// Absolute existing non-symlink directory for the operator's subscription Codex home.
		#[arg(long, value_parser = parse_controlled_codex_home)]
		codex_home: PathBuf,
		/// Controlled local artifact sink.
		#[arg(long, default_value = ".aiq-artifacts")]
		artifact_root: PathBuf,
		/// Persisted authenticated preflight report reused until expiry.
		#[arg(long, default_value = ".aiq-preflight.json")]
		preflight_cache: PathBuf,
		/// Successful model-free Official admission receipt. Required for Official runs.
		#[arg(long)]
		official_admission: Option<PathBuf>,
		/// Ignore a valid cache and actively repeat capability probes.
		#[arg(long)]
		refresh_preflight: bool,
		/// Validity assigned to a newly created preflight cache.
		#[arg(long, default_value_t = 86_400)]
		preflight_ttl_seconds: u64,
		/// Durable per-attempt checkpoint.
		#[arg(long, default_value = ".aiq-run-checkpoint.json")]
		checkpoint: PathBuf,
		/// Exact task identifier to run. Repeat for a deterministic calibration subset.
		#[arg(long = "task")]
		tasks: Vec<String>,
		/// Exact model key to run. Repeat for a deterministic calibration subset.
		#[arg(long = "model")]
		models: Vec<String>,
		/// Maximum concurrent live model and task workers.
		#[arg(long, default_value_t = 1)]
		jobs: usize,
		/// Execution class fixed before benchmark validation. Calibration is always non-Official.
		#[arg(long, value_enum, default_value_t = RunClassArgument::Calibration)]
		run_class: RunClassArgument,
		/// Run output path. Official requires a durable path and writes one create-once
		/// reservation.
		#[arg(long, default_value = "-")]
		output: PathBuf,
	},
	/// Score a saved run with transparent AIQ v1 rules.
	Score {
		/// Directory of public-example task JSON files.
		#[arg(long)]
		public_tasks: Option<PathBuf>,
		/// Controlled directory of hidden task JSON files.
		#[arg(long)]
		hidden_tasks: Option<PathBuf>,
		/// Saved run JSON.
		#[arg(long)]
		results: PathBuf,
		/// Deterministic cluster-bootstrap replicates.
		#[arg(long, default_value_t = 10_000)]
		bootstrap_samples: usize,
		/// Deterministic bootstrap seed.
		#[arg(long, default_value_t = 0x41_49_51_5f_56_31_u64)]
		bootstrap_seed: u64,
		/// Output JSON file, or `-` for standard output.
		#[arg(long, default_value = "-")]
		output: PathBuf,
		/// Exact Official admission receipt required for a real Official run.
		#[arg(long)]
		official_admission: Option<PathBuf>,
	},
	/// Produce explicitly synthetic data without invoking Codex.
	Demo {
		/// Local slot date in YYYY-MM-DD format.
		#[arg(long, default_value = "2000-01-01")]
		slot_date: String,
		/// Slot occurrence: day or night.
		#[arg(long, default_value = "day")]
		occurrence: String,
		/// Deterministic cluster-bootstrap replicates.
		#[arg(long, default_value_t = 10_000)]
		bootstrap_samples: usize,
		/// Output JSON file, or `-` for standard output.
		#[arg(long, default_value = "-")]
		output: PathBuf,
		/// Controlled local content-addressed artifact root.
		#[arg(long, default_value = ".aiq-artifacts")]
		artifact_root: PathBuf,
		/// Optional standalone run JSON for the package command.
		#[arg(long)]
		run_output: Option<PathBuf>,
		/// Optional standalone score bundle JSON for the normalize command.
		#[arg(long)]
		scores_output: Option<PathBuf>,
		/// Optional synthetic verifier-metadata JSON for the normalize command.
		#[arg(long)]
		metadata_output: Option<PathBuf>,
	},
	/// Submit a signed result package to the unverified Vercel queue.
	Submit {
		/// Signed submission-envelope JSON file.
		#[arg(long)]
		package: PathBuf,
		/// Controlled local content-addressed artifact root used by the run.
		#[arg(long, default_value = ".aiq-artifacts")]
		artifact_root: PathBuf,
		/// Vercel deployment origin. The runner posts to `/api/submissions`.
		#[arg(long)]
		endpoint: String,
		/// Environment variable that contains the runner bearer token.
		#[arg(long, default_value = "AIQ_RUNNER_SUBMISSION_TOKEN")]
		token_env: String,
		/// Global HTTPS timeout in seconds.
		#[arg(long, default_value_t = 30)]
		timeout_seconds: u64,
		/// Maximum artifact uploads in flight, from 1 through 32.
		#[arg(
			long,
			default_value_t = DEFAULT_ARTIFACT_UPLOAD_CONCURRENCY,
			value_parser = parse_artifact_upload_concurrency
		)]
		artifact_upload_concurrency: usize,
		/// Permit plain HTTP only when the endpoint is a loopback origin.
		#[arg(long, default_value_t = false)]
		allow_loopback_http: bool,
	},
	/// Sign a saved run as a content-addressed submission envelope.
	Package {
		/// Saved run JSON.
		#[arg(long)]
		run: PathBuf,
		/// Controlled local content-addressed artifact root used by the run.
		#[arg(long, default_value = ".aiq-artifacts")]
		artifact_root: PathBuf,
		/// Environment variable containing a 32-byte Ed25519 secret as hexadecimal.
		#[arg(long, default_value = "AIQ_RUNNER_SIGNING_KEY")]
		signing_key_env: String,
		/// Declared maximum concurrent task executions. Required when a real saved run predates this binding.
		#[arg(long)]
		execution_concurrency: Option<usize>,
		/// Output signed-envelope JSON file.
		#[arg(long)]
		output: PathBuf,
		/// Exact Official admission receipt required for a real Official run.
		#[arg(long)]
		official_admission: Option<PathBuf>,
	},
	/// Print the public node identity derived from one signing key.
	Identity {
		/// Environment variable containing a 32-byte Ed25519 secret as hexadecimal.
		#[arg(long, default_value = "AIQ_RUNNER_SIGNING_KEY")]
		signing_key_env: String,
	},
	/// Verify and normalize a signed matrix package, then sign a verifier attestation.
	Normalize {
		/// Directory of public-example task JSON files.
		#[arg(long)]
		public_tasks: Option<PathBuf>,
		/// Controlled directory of hidden task JSON files.
		#[arg(long)]
		hidden_tasks: Option<PathBuf>,
		/// Use the built-in 72-task synthetic set instead of controlled task files.
		#[arg(long, conflicts_with_all = ["public_tasks", "hidden_tasks"])]
		synthetic_demo_tasks: bool,
		/// Exact signed package bytes received by the submission boundary.
		#[arg(long)]
		package: PathBuf,
		/// Score bundle produced by the score command with production defaults.
		#[arg(long)]
		scores: PathBuf,
		/// Verifier-attested deployment metadata JSON.
		#[arg(long)]
		metadata: PathBuf,
		/// Environment variable containing the verifier's 32-byte Ed25519 secret.
		#[arg(long, default_value = "AIQ_VERIFIER_SIGNING_KEY")]
		verifier_signing_key_env: String,
		/// Safe Unix-millisecond time when verification completed.
		#[arg(long)]
		observed_unix_ms: u64,
		/// Result workspace reconstruction and deterministic evaluator replay disposition.
		#[arg(long, value_enum)]
		replay_status: ReplayMode,
		/// Output path for the exact `aiq.normalized-batch.v3` database stage.
		#[arg(long)]
		stage_output: PathBuf,
		/// Output path for the signed `aiq.verifier-attestation.v3`.
		#[arg(long)]
		attestation_output: PathBuf,
	},
	#[command(name = "__permission-probe", hide = true)]
	PermissionProbe {
		#[arg(long)]
		allowed_file: PathBuf,
		#[arg(long, required = true)]
		denied_file: Vec<PathBuf>,
		#[arg(long)]
		writable_file: PathBuf,
		#[arg(long)]
		read_only_file: PathBuf,
		#[arg(long)]
		read_only_write_file: PathBuf,
		#[arg(long)]
		node_executable: PathBuf,
		#[arg(long)]
		rg_executable: PathBuf,
		#[arg(long)]
		network_sentinel_port: u16,
	},
}
#[derive(Clone, Copy, Debug, ValueEnum)]
enum ReplayMode {
	/// The verifier replayed scoring and commitments only; production is not publishable.
	CommitmentsVerified,
	/// Verification failed. This result is rejection evidence and is not publishable.
	Failed,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum RunClassArgument {
	/// Local best-effort calibration. This can never become Official.
	Calibration,
	/// Complete non-synthetic 72-task by 17-model run.
	Official,
}

#[derive(Clone, Copy)]
enum OfficialPostrunOutput {
	Score,
	Package,
}
enum CorpusValidationMode {
	Released,
	Core,
	Contrast { expected_corpus_sha256: String },
}

fn read_held_bounded_file(
	file: &File,
	label: &str,
	maximum_bytes: usize,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
	let before = file.metadata()?;
	let maximum_u64 = u64::try_from(maximum_bytes).unwrap_or(u64::MAX);

	if !before.is_file() || before.len() == 0 || before.len() > maximum_u64 {
		return Err(format!("{label} must be a bounded nonempty regular file").into());
	}

	let mut reader = file.try_clone()?;

	reader.seek(SeekFrom::Start(0))?;

	let read_limit = u64::try_from(maximum_bytes).unwrap_or(u64::MAX - 1).saturating_add(1);
	let mut bytes = Vec::new();

	reader.take(read_limit).read_to_end(&mut bytes)?;

	let after = file.metadata()?;

	if bytes.is_empty()
		|| bytes.len() > maximum_bytes
		|| before.len() != after.len()
		|| after.len() != u64::try_from(bytes.len()).unwrap_or(u64::MAX)
	{
		return Err(format!("{label} changed while reading").into());
	}
	#[cfg(unix)]
	if before.dev() != after.dev() || before.ino() != after.ino() {
		return Err(format!("{label} identity changed while reading").into());
	}

	Ok(bytes)
}

fn raw_sha256(bytes: &[u8]) -> String {
	format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
}

fn controlled_output_parent(path: &Path) -> Result<PathBuf, Box<dyn std::error::Error>> {
	if path == Path::new("-") {
		return Err("live preflight output requires a durable path".into());
	}

	let parent =
		path.parent().filter(|parent| !parent.as_os_str().is_empty()).unwrap_or(Path::new("."));

	Ok(fs::canonicalize(parent)?)
}

fn run_general_cli_command(command: Command) -> Result<(), Box<dyn std::error::Error>> {
	match command {
		Command::Matrix { output } => write_json(
			&output,
			&MatrixReport { schema_version: "aiq.matrix.v1", models: MODEL_MATRIX.to_vec() },
		)?,
		command @ (Command::ValidateCoreCorpus { .. }
		| Command::ValidateContrastCorpus { .. }
		| Command::Validate { .. }) => dispatch_corpus_validation(command)?,
		Command::Preflight {
			capabilities,
			corpus_commitment,
			evaluator_runtime,
			codex_toolchain_root,
			codex_binary,
			codex_home,
			artifact_root,
			expires_in_seconds,
			output,
			official_admission,
		} => run_preflight(
			capabilities,
			corpus_commitment,
			evaluator_runtime,
			codex_toolchain_root,
			codex_binary,
			codex_home,
			artifact_root,
			expires_in_seconds,
			output,
			official_admission.as_deref(),
		)?,
		command @ Command::AdmitPermissions { .. } => dispatch_permission_admission(command)?,
		command @ Command::Run { .. } => dispatch_run(command)?,
		Command::Score {
			public_tasks,
			hidden_tasks,
			results,
			bootstrap_samples,
			bootstrap_seed,
			output,
			official_admission,
		} => run_score(
			public_tasks,
			hidden_tasks,
			results,
			bootstrap_samples,
			bootstrap_seed,
			output,
			official_admission.as_deref(),
		)?,
		Command::Demo {
			slot_date,
			occurrence,
			bootstrap_samples,
			output,
			artifact_root,
			run_output,
			scores_output,
			metadata_output,
		} => run_demo(
			&slot_date,
			&occurrence,
			bootstrap_samples,
			&artifact_root,
			DemoOutputs {
				package: &output,
				run: run_output.as_deref(),
				scores: scores_output.as_deref(),
				metadata: metadata_output.as_deref(),
			},
		)?,
		Command::Submit {
			package,
			artifact_root,
			endpoint,
			token_env,
			timeout_seconds,
			artifact_upload_concurrency,
			allow_loopback_http,
		} => run_submit(
			&package,
			&artifact_root,
			&endpoint,
			&token_env,
			timeout_seconds,
			artifact_upload_concurrency,
			allow_loopback_http,
		)?,
		command @ Command::Package { .. } => dispatch_package(command)?,
		Command::Identity { signing_key_env } => run_identity(&signing_key_env)?,
		command @ Command::Normalize { .. } => run_normalize_command(command)?,
		command @ Command::PermissionProbe { .. } => dispatch_permission_probe(command)?,
	}

	Ok(())
}

fn dispatch_corpus_validation(command: Command) -> Result<(), Box<dyn std::error::Error>> {
	let options = match command {
		Command::ValidateCoreCorpus {
			hidden_tasks,
			corpus_commitment,
			source_root,
			evaluator_root,
			evaluator_runtime,
			codex_toolchain_root,
		} => ValidationOptions {
			public_tasks: None,
			hidden_tasks: Some(hidden_tasks),
			corpus_commitment: Some(corpus_commitment),
			source_root: Some(source_root),
			evaluator_root: Some(evaluator_root),
			evaluator_runtime: Some(evaluator_runtime),
			codex_toolchain_root: Some(codex_toolchain_root),
			mode: CorpusValidationMode::Core,
		},
		Command::ValidateContrastCorpus {
			hidden_tasks,
			corpus_commitment,
			expected_corpus_sha256,
			source_root,
			evaluator_root,
			evaluator_runtime,
			codex_toolchain_root,
		} => ValidationOptions {
			public_tasks: None,
			hidden_tasks: Some(hidden_tasks),
			corpus_commitment: Some(corpus_commitment),
			source_root: Some(source_root),
			evaluator_root: Some(evaluator_root),
			evaluator_runtime: Some(evaluator_runtime),
			codex_toolchain_root: Some(codex_toolchain_root),
			mode: CorpusValidationMode::Contrast { expected_corpus_sha256 },
		},
		Command::Validate {
			public_tasks,
			hidden_tasks,
			corpus_commitment,
			source_root,
			evaluator_root,
			evaluator_runtime,
			codex_toolchain_root,
		} => ValidationOptions {
			public_tasks,
			hidden_tasks,
			corpus_commitment,
			source_root,
			evaluator_root,
			evaluator_runtime,
			codex_toolchain_root,
			mode: CorpusValidationMode::Released,
		},
		_ => unreachable!("corpus validation dispatcher requires a validation command"),
	};

	run_validation(options)
}

fn dispatch_package(command: Command) -> Result<(), Box<dyn std::error::Error>> {
	let Command::Package {
		run,
		artifact_root,
		signing_key_env,
		execution_concurrency,
		output,
		official_admission,
	} = command
	else {
		unreachable!("package dispatcher requires a package command");
	};

	run_package(
		&run,
		&artifact_root,
		&signing_key_env,
		execution_concurrency,
		&output,
		official_admission.as_deref(),
	)
}

fn safe_task_issue_message(code: &str) -> &'static str {
	match code {
		"source_unavailable" => "task source is unavailable",
		"read_error" => "task record could not be read",
		"invalid_json" => "task record is not valid JSON",
		"invalid_task" => "task record does not match the task schema",
		"missing_field" => "a required field is missing",
		"unsupported_schema" => "task schema version is not supported",
		"empty_field" => "field must not be empty",
		"invalid_version" => "field must use a valid version",
		"invalid_token" => "field contains an invalid token",
		"invalid_difficulty" => "task difficulty is invalid",
		"invalid_budget" => "task budget is invalid",
		"empty_collection" => "collection must not be empty",
		"empty_item" => "collection item must not be empty",
		"duplicate_item" => "collection items must be unique",
		"unknown_tool" => "task tool is not supported",
		"mixed_none_tool" => "the no-tools policy cannot include other tools",
		"invalid_reference" => "task reference is invalid",
		"missing_provenance" => "task provenance is missing",
		"missing_catalog_entry_digest" => "hidden task catalog binding is missing",
		"invalid_digest" => "task digest is invalid",
		"missing_evaluator" => "task evaluator is missing",
		"invalid_public_evaluator" => "public task evaluator is invalid",
		"invalid_hidden_evaluator" => "hidden task evaluator is invalid",
		"invalid_external_evaluator" => "controlled external evaluator is invalid",
		"missing_external_evaluator" => "controlled external evaluator is missing",
		"visibility_mismatch" => "task visibility does not match its source",
		"duplicate_task" => "task identifier and version must be unique",
		_ => "task input is invalid",
	}
}

fn write_task_validation_report(
	report: &TaskLoadReport,
	public_tasks: Option<&Path>,
	hidden_tasks: Option<&Path>,
) -> Result<(), Box<dyn std::error::Error>> {
	write_json(Path::new("-"), &ValidationReport::public_safe(report, public_tasks, hidden_tasks))
}

fn run_identity(signing_key_env: &str) -> Result<(), Box<dyn std::error::Error>> {
	let secret = signing_secret_from_environment(signing_key_env)?;
	let identity = SigningIdentity::from_secret(secret);

	write_json(Path::new("-"), identity.node())
}

fn dispatch_permission_probe(command: Command) -> Result<(), Box<dyn std::error::Error>> {
	let Command::PermissionProbe {
		allowed_file,
		denied_file,
		writable_file,
		read_only_file,
		read_only_write_file,
		node_executable,
		rg_executable,
		network_sentinel_port,
	} = command
	else {
		return Err("permission probe dispatcher received another command".into());
	};

	adapter::run_permission_probe(
		&allowed_file,
		&denied_file,
		&writable_file,
		&read_only_file,
		&read_only_write_file,
		(&node_executable, &rg_executable),
		network_sentinel_port,
	)?;

	Ok(())
}

fn dispatch_run(command: Command) -> Result<(), Box<dyn std::error::Error>> {
	let Command::Run {
		public_tasks,
		hidden_tasks,
		corpus_commitment,
		source_root,
		capabilities,
		workspace_root,
		execution_root,
		evaluator_root,
		evaluator_runtime,
		codex_toolchain_root,
		schedule,
		slot_date,
		occurrence,
		observed_at,
		codex_binary,
		codex_home,
		artifact_root,
		preflight_cache,
		official_admission,
		refresh_preflight,
		preflight_ttl_seconds,
		checkpoint,
		tasks,
		models,
		jobs,
		run_class,
		output,
	} = command
	else {
		unreachable!("dispatch_run requires a run command");
	};

	run_live(RunOptions {
		public_tasks,
		hidden_tasks,
		corpus_commitment,
		source_root,
		capabilities,
		workspace_root,
		execution_root,
		evaluator_root,
		evaluator_runtime,
		codex_toolchain_root,
		schedule,
		slot_date,
		occurrence,
		observed_at,
		codex_binary,
		codex_home,
		artifact_root,
		preflight_cache,
		official_admission,
		refresh_preflight,
		preflight_ttl_seconds,
		checkpoint,
		task_selectors: tasks,
		model_selectors: models,
		jobs,
		run_class: run_class.into(),
		output,
	})
}

fn dispatch_permission_admission(command: Command) -> Result<(), Box<dyn std::error::Error>> {
	let Command::AdmitPermissions {
		public_tasks,
		hidden_tasks,
		corpus_commitment,
		source_root,
		capabilities,
		workspace_root,
		execution_root,
		evaluator_root,
		evaluator_runtime,
		codex_toolchain_root,
		schedule,
		slot_date,
		occurrence,
		observed_at,
		codex_binary,
		codex_home,
		artifact_root,
		preflight_cache,
		checkpoint,
		jobs,
		planned_output,
		planned_score_output,
		planned_package_output,
		output,
	} = command
	else {
		unreachable!("permission admission dispatcher requires an admit-permissions command");
	};

	run_permission_admission(PermissionAdmissionOptions {
		public_tasks,
		hidden_tasks,
		corpus_commitment,
		source_root,
		capabilities,
		workspace_root,
		execution_root,
		evaluator_root,
		evaluator_runtime,
		codex_toolchain_root,
		schedule,
		slot_date,
		occurrence,
		observed_at,
		codex_binary,
		codex_home,
		artifact_root,
		preflight_cache,
		checkpoint,
		jobs,
		planned_output,
		planned_score_output,
		planned_package_output,
		report_output: output,
	})
}

#[allow(clippy::too_many_arguments)]
fn run_preflight(
	path: PathBuf,
	corpus_commitment: PathBuf,
	evaluator_runtime: PathBuf,
	codex_toolchain_root: PathBuf,
	codex_binary: String,
	codex_home: PathBuf,
	artifact_root: PathBuf,
	expires_in_seconds: u64,
	output: PathBuf,
	official_admission: Option<&Path>,
) -> Result<(), Box<dyn std::error::Error>> {
	let future_locks = acquire_preflight_future_protected_locks(&output)?;
	let protected_output = canonical_leaf_policy_path(&output)?;

	future_locks.verify(&protected_output)?;

	let manifest = read_json::<CapabilityManifest>(&path)?;
	let codex_binary = controlled_codex_binary(&codex_binary)?;
	let evaluator_runtime = EvaluatorRuntime::resolve(&evaluator_runtime)?;
	let policy = corpus_commitment::read_execution_tool_policy(&corpus_commitment)?;
	let model_toolchain =
		preflight_model_toolchain(&codex_toolchain_root, &policy, &evaluator_runtime)?;
	let admission = official_admission.map(read_successful_official_admission).transpose()?;

	if let Some((report, _)) = &admission {
		verify_preflight_matches_official_plan(
			report,
			&path,
			&corpus_commitment,
			&evaluator_runtime,
			&model_toolchain,
			&codex_binary,
			&codex_home,
			&artifact_root,
			&output,
		)?;
	}

	let (observed_unix_ms, expires_unix_ms) = preflight_window(expires_in_seconds)?;
	let artifact_sink = LocalArtifactSink::new(&artifact_root)?;
	let official_protected = admission
		.as_ref()
		.map(|(receipt, _)| {
			let plan = receipt.plan.as_ref().ok_or("Official admission receipt omits its plan")?;
			let receipt_path =
				official_admission.ok_or("Official admission path is unavailable")?;

			official_plan_protected_paths(plan, receipt_path)
		})
		.transpose()?;
	let denied_roots = if let Some(protected) = &official_protected {
		let plan = admission
			.as_ref()
			.and_then(|(receipt, _)| receipt.plan.as_ref())
			.ok_or("Official admission receipt omits its plan")?;

		isolation::validate_protected_layout(
			protected,
			Some(Path::new(&plan.execution_root)),
			&[model_toolchain.root().to_owned()],
		)?;

		benchmark_denied_roots(protected)?
	} else {
		standalone_preflight_denied_roots(
			&path,
			&corpus_commitment,
			&artifact_root,
			model_toolchain.root(),
		)?
	};
	let adapter = CodexAdapter::new(
		SystemExecutor,
		artifact_sink,
		codex_binary.clone(),
		CodexExecutionConfig::isolated(codex_home.clone())
			.with_denied_roots(denied_roots)
			.with_model_toolchain(model_toolchain.clone()),
	);
	let profile_workspace = admission
		.as_ref()
		.and_then(|(receipt, _)| receipt.plan.as_ref())
		.map_or(artifact_root.as_path(), |plan| Path::new(&plan.execution_root));
	let binding = PreflightAdmissionBinding::capture(
		&adapter,
		PreflightAdmissionInputs {
			capabilities: &path,
			corpus_commitment: &corpus_commitment,
			execution_policy: &policy,
			evaluator_runtime: &evaluator_runtime,
			codex_toolchain_root: &codex_toolchain_root,
			model_toolchain: &model_toolchain,
			codex_binary: &codex_binary,
			codex_home: &codex_home,
			profile_workspace,
			artifact_root: &artifact_root,
			output: &output,
		},
	)?;

	binding.verify(&adapter)?;

	verify_preflight_official_permissions(
		&adapter,
		admission.as_ref(),
		official_protected.as_deref(),
	)?;

	future_locks.verify(&protected_output)?;

	let report = adapter.validate_capabilities(&manifest);

	binding.verify(&adapter)?;
	future_locks.verify(&protected_output)?;

	persist_completed_preflight(
		&output,
		&manifest,
		report,
		observed_unix_ms,
		expires_unix_ms,
		model_toolchain.digest(),
		admission.as_ref().map(|(_, digest)| digest.as_str()),
	)?;

	future_locks.verify(&protected_output)?;
	binding.output_parent.verify()?;

	Ok(())
}

fn preflight_window(expires_in_seconds: u64) -> Result<(u64, u64), &'static str> {
	let observed_unix_ms = resume::unix_ms();
	let expires_unix_ms = observed_unix_ms
		.checked_add(expires_in_seconds.checked_mul(1_000).ok_or("preflight expiry overflows")?)
		.ok_or("preflight expiry overflows")?;

	Ok((observed_unix_ms, expires_unix_ms))
}

fn preflight_model_toolchain(
	root: &Path,
	policy: &ExecutionToolPolicy,
	evaluator_runtime: &EvaluatorRuntime,
) -> Result<ValidatedModelToolchain, CorpusCommitmentError> {
	corpus_commitment::validate_model_toolchain(root, policy, evaluator_runtime)
}

fn verify_preflight_official_permissions<E, S>(
	adapter: &CodexAdapter<E, S>,
	admission: Option<&(PermissionAdmissionReport, String)>,
	protected_paths: Option<&[ProtectedBenchmarkPath]>,
) -> Result<(), Box<dyn std::error::Error>>
where
	E: Executor,
	S: ArtifactSink,
{
	let Some((receipt, _)) = admission else {
		return Ok(());
	};
	let plan = receipt.plan.as_ref().ok_or("Official admission receipt omits its plan")?;
	let expected_profile = receipt
		.managed_profile
		.as_ref()
		.ok_or("Official admission receipt omits permission profile evidence")?;
	let current_profile =
		adapter.verify_managed_permission_profile(Path::new(&plan.execution_root))?;

	if &current_profile != expected_profile {
		return Err(
			"explicit permission profile evidence changed after Official admission; no model was invoked"
				.into(),
		);
	}

	let current_evidence = verify_permission_evidence_with_profile(
		adapter,
		Path::new(&plan.execution_root),
		protected_paths.ok_or("Official protected plan is unavailable")?,
		RunClass::Official,
		current_profile,
	)?;
	let current_digest = current_evidence.combined_digest()?;

	if receipt.permission_evidence_digest.as_deref() != Some(&current_digest) {
		return Err(
			"permission evidence or canaries changed after Official admission; no model was invoked"
				.into(),
		);
	}

	Ok(())
}

fn run_permission_admission(
	mut options: PermissionAdmissionOptions,
) -> Result<(), Box<dyn std::error::Error>> {
	validate_permission_admission_outputs(&options.planned_output, &options.report_output)?;
	validate_permission_admission_output_aliases(&options)?;

	let observed_unix_ms = resume::unix_ms();
	let mut managed_profile = None;
	let mut plan = None;
	let assessment = (|| {
		let prepared = prepare_permission_admission(&mut options)?;

		plan = Some(prepared.plan.clone());

		let profile =
			prepared.adapter.verify_managed_permission_profile(&prepared.execution_root)?;

		managed_profile = Some(profile.clone());

		verify_permission_evidence_with_profile(
			&prepared.adapter,
			&prepared.execution_root,
			&prepared.protected_paths,
			RunClass::Official,
			profile,
		)
	})();
	let (report, denied) =
		permission_admission_report(observed_unix_ms, managed_profile, plan, assessment)?;

	write_private_json_receipt(&options.report_output, &report)?;

	if denied {
		return Err("Official permission admission denied; no model was invoked".into());
	}

	Ok(())
}

fn permission_admission_report(
	observed_unix_ms: u64,
	managed_profile: Option<ManagedPermissionProfileEvidence>,
	plan: Option<OfficialPlanBinding>,
	assessment: Result<VerifiedPermissionEvidence, Box<dyn std::error::Error>>,
) -> Result<(PermissionAdmissionReport, bool), Box<dyn std::error::Error>> {
	match assessment {
		Ok(evidence) => {
			let plan = plan.ok_or("successful Official admission has no exact plan")?;
			let permission_evidence_digest = evidence.combined_digest()?;

			Ok((
				PermissionAdmissionReport {
					schema_version: "aiq.official-permission-admission.v2".to_owned(),
					official_permission_eligible: true,
					model_invoked: false,
					observed_unix_ms,
					managed_profile: Some(evidence.profile),
					permission_policy_digest: Some(evidence.digests.permission_policy_digest),
					canary_digest: Some(evidence.digests.canary_digest),
					permission_evidence_digest: Some(permission_evidence_digest),
					plan: Some(plan),
					failure: None,
				},
				false,
			))
		},
		Err(error) => Ok((
			PermissionAdmissionReport {
				schema_version: "aiq.official-permission-admission.v2".to_owned(),
				official_permission_eligible: false,
				model_invoked: false,
				observed_unix_ms,
				managed_profile,
				permission_policy_digest: None,
				canary_digest: None,
				permission_evidence_digest: None,
				plan: None,
				failure: Some(error.to_string()),
			},
			true,
		)),
	}
}

fn read_successful_official_admission(
	path: &Path,
) -> Result<(PermissionAdmissionReport, String), Box<dyn std::error::Error>> {
	let metadata = fs::symlink_metadata(path)?;

	if metadata.file_type().is_symlink() || !metadata.is_file() {
		return Err("Official admission receipt must be a non-symlink regular file".into());
	}
	#[cfg(unix)]
	if metadata.nlink() != 1 || metadata.permissions().mode() & 0o777 != 0o600 {
		return Err(
			"Official admission receipt must be private and have no hard-link aliases".into()
		);
	}

	let report = read_json::<PermissionAdmissionReport>(path)?;

	if report.schema_version != "aiq.official-permission-admission.v2"
		|| !report.official_permission_eligible
		|| report.model_invoked
		|| report.plan.is_none()
		|| report.permission_evidence_digest.is_none()
		|| report.failure.is_some()
	{
		return Err("Official admission receipt is not a successful exact model-free plan".into());
	}

	let digest = protocol::canonical_hash(&report)?;

	Ok((report, digest))
}

#[allow(clippy::too_many_arguments)]
fn verify_preflight_matches_official_plan(
	report: &PermissionAdmissionReport,
	capabilities: &Path,
	corpus_commitment: &Path,
	evaluator_runtime: &EvaluatorRuntime,
	model_toolchain: &ValidatedModelToolchain,
	codex_binary: &str,
	codex_home: &Path,
	artifact_root: &Path,
	output: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
	let plan = report.plan.as_ref().ok_or("Official admission receipt omits its plan")?;
	let corpus_value = read_json::<serde_json::Value>(corpus_commitment)?;
	let manifest = read_json::<CapabilityManifest>(capabilities)?;
	let actual = (
		protocol::canonical_hash(&manifest)?,
		protocol::canonical_hash(&corpus_value)?,
		evaluator_runtime.executable_digest().to_owned(),
		model_toolchain.digest().to_owned(),
		corpus_commitment::codex_executable_digest(codex_binary)?,
		resume::directory_identity(codex_home, "Codex home")?,
		resume::directory_identity(artifact_root, "artifact root")?,
		canonical_policy_path(output)?.display().to_string(),
		canonical_policy_path(capabilities)?.display().to_string(),
		canonical_policy_path(corpus_commitment)?.display().to_string(),
		evaluator_runtime.executable().display().to_string(),
		model_toolchain.root().display().to_string(),
		protocol::canonical_hash(&adapter::chatgpt_credential_observation(codex_home)?)?,
	);
	let expected = (
		plan.capability_manifest_digest.clone(),
		plan.corpus_commitment_digest.clone(),
		plan.evaluator_runtime_digest.clone(),
		plan.model_toolchain_digest.clone(),
		plan.codex_executable_digest.clone(),
		plan.codex_home.clone(),
		plan.artifact_root.clone(),
		plan.outputs.preflight_cache.clone(),
		plan.capabilities.clone(),
		plan.corpus_commitment.clone(),
		plan.evaluator_runtime.clone(),
		plan.codex_toolchain_root.clone(),
		plan.codex_credential_digest.clone(),
	);

	if protocol::canonical_hash(&actual)? != protocol::canonical_hash(&expected)? {
		return Err(
			"paid preflight inputs do not match the exact Official admission receipt".into()
		);
	}

	Ok(())
}

fn validate_permission_admission_outputs(
	planned_output: &Path,
	report_output: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
	if planned_output == Path::new("-") || report_output == Path::new("-") {
		return Err(
			"Official permission admission requires durable planned and report outputs".into()
		);
	}

	let planned_output = canonical_policy_path(planned_output)?;
	let report_output = canonical_policy_path(report_output)?;

	if planned_output == report_output {
		return Err("permission admission --output must be distinct from --planned-output".into());
	}

	for (label, path) in [
		("planned Official output", &planned_output),
		("permission admission report", &report_output),
	] {
		match fs::symlink_metadata(path) {
			Err(error) if error.kind() == ErrorKind::NotFound => {},
			Err(error) => return Err(error.into()),
			Ok(metadata) if metadata.file_type().is_symlink() => {
				return Err(format!("{label} must not be a symlink").into());
			},
			Ok(_) => return Err(format!("{label} must not exist before admission").into()),
		}
	}

	Ok(())
}

fn validate_permission_admission_output_aliases(
	options: &PermissionAdmissionOptions,
) -> Result<(), Box<dyn std::error::Error>> {
	let report = canonical_policy_path(&options.report_output)?;
	let planned = canonical_policy_path(&options.planned_output)?;
	let preflight_attempt = resume::preflight_attempt_path(&options.preflight_cache);
	let mut other_paths = vec![
		options.corpus_commitment.as_path(),
		options.source_root.as_path(),
		options.capabilities.as_path(),
		options.workspace_root.as_path(),
		options.execution_root.as_path(),
		options.evaluator_root.as_path(),
		options.evaluator_runtime.as_path(),
		options.codex_toolchain_root.as_path(),
		options.schedule.as_path(),
		Path::new(&options.codex_binary),
		options.codex_home.as_path(),
		options.artifact_root.as_path(),
		options.preflight_cache.as_path(),
		preflight_attempt.as_path(),
		options.checkpoint.as_path(),
		options.planned_output.as_path(),
		options.planned_score_output.as_path(),
		options.planned_package_output.as_path(),
	];

	other_paths.extend(options.public_tasks.as_deref());
	other_paths.extend(options.hidden_tasks.as_deref());

	for path in other_paths {
		if canonical_policy_path(path).is_ok_and(|path| path == report) {
			return Err(
				"permission admission --output must be distinct from every controlled path".into(),
			);
		}
	}
	for path in [&options.checkpoint, &preflight_attempt] {
		if canonical_policy_path(path).is_ok_and(|path| path == planned) {
			return Err(
				"--planned-output must be distinct from checkpoint and preflight attempt paths"
					.into(),
			);
		}
	}

	Ok(())
}

fn prepare_permission_admission(
	options: &mut PermissionAdmissionOptions,
) -> Result<PreparedPermissionAdmission, Box<dyn std::error::Error>> {
	let planning_options = RunOptions {
		public_tasks: options.public_tasks.clone(),
		hidden_tasks: options.hidden_tasks.clone(),
		corpus_commitment: options.corpus_commitment.clone(),
		source_root: options.source_root.clone(),
		capabilities: options.capabilities.clone(),
		workspace_root: options.workspace_root.clone(),
		execution_root: options.execution_root.clone(),
		evaluator_root: options.evaluator_root.clone(),
		evaluator_runtime: options.evaluator_runtime.clone(),
		codex_toolchain_root: options.codex_toolchain_root.clone(),
		schedule: options.schedule.clone(),
		slot_date: options.slot_date.clone(),
		occurrence: options.occurrence.clone(),
		observed_at: options.observed_at.clone(),
		codex_binary: options.codex_binary.clone(),
		codex_home: options.codex_home.clone(),
		artifact_root: options.artifact_root.clone(),
		preflight_cache: options.preflight_cache.clone(),
		official_admission: None,
		refresh_preflight: false,
		preflight_ttl_seconds: 86_400,
		checkpoint: options.checkpoint.clone(),
		task_selectors: Vec::new(),
		model_selectors: Vec::new(),
		jobs: options.jobs,
		run_class: RunClass::Official,
		output: options.planned_output.clone(),
	};
	let prepared_run = prepare_run_model_free(&planning_options)?;
	let evaluator_runtime = EvaluatorRuntime::resolve(&options.evaluator_runtime)?;

	prepared_run.corpus.validate_evaluator_runtime(&evaluator_runtime)?;

	let model_toolchain = prepared_run
		.corpus
		.validate_model_toolchain(&options.codex_toolchain_root, &evaluator_runtime)?;
	let plan = build_official_plan(
		OfficialPlanningInputs {
			public_tasks: options.public_tasks.as_deref(),
			hidden_tasks: options.hidden_tasks.as_deref(),
			corpus_commitment: &options.corpus_commitment,
			capabilities: &options.capabilities,
			source_root: &options.source_root,
			workspace_root: &options.workspace_root,
			execution_root: &options.execution_root,
			evaluator_root: &options.evaluator_root,
			evaluator_runtime: &options.evaluator_runtime,
			codex_toolchain_root: &options.codex_toolchain_root,
			codex_binary: &options.codex_binary,
			codex_home: &options.codex_home,
			artifact_root: &options.artifact_root,
			schedule: &options.schedule,
			observed_at: &options.observed_at,
			preflight_cache: &options.preflight_cache,
			checkpoint: &options.checkpoint,
			run_output: &options.planned_output,
			score_output: &options.planned_score_output,
			package_output: &options.planned_package_output,
			reserved_run_output_for: None,
		},
		&prepared_run,
	)?;

	options.codex_binary = controlled_codex_binary(&options.codex_binary)?;

	let artifact_sink = LocalArtifactSink::new(&options.artifact_root)?;
	let protected_paths = benchmark_protected_paths_from(BenchmarkProtectedPathInputs {
		public_tasks: options.public_tasks.as_deref(),
		hidden_tasks: options.hidden_tasks.as_deref(),
		source_root: &options.source_root,
		workspace_root: &options.workspace_root,
		evaluator_root: &options.evaluator_root,
		artifact_root: &options.artifact_root,
		codex_home: &options.codex_home,
		codex_binary: Path::new(&options.codex_binary),
		corpus_commitment: &options.corpus_commitment,
		capabilities: &options.capabilities,
		schedule: &options.schedule,
		preflight_cache: &options.preflight_cache,
		checkpoint: &options.checkpoint,
		planned_output: &options.planned_output,
		planned_score_output: Some(&options.planned_score_output),
		planned_package_output: Some(&options.planned_package_output),
		report_output: Some(&options.report_output),
		official_admission: None,
	})?;
	let execution_root = fs::canonicalize(&options.execution_root)?;

	isolation::validate_protected_layout(
		&protected_paths,
		Some(&execution_root),
		&[model_toolchain.root().to_owned()],
	)?;

	let denied_roots = benchmark_denied_roots(&protected_paths)?;
	let adapter = CodexAdapter::new(
		SystemExecutor,
		artifact_sink,
		options.codex_binary.clone(),
		CodexExecutionConfig::isolated(options.codex_home.clone())
			.with_denied_roots(denied_roots)
			.with_model_toolchain(model_toolchain),
	);

	Ok(PreparedPermissionAdmission { adapter, execution_root, protected_paths, plan })
}

fn run_validation(options: ValidationOptions) -> Result<(), Box<dyn std::error::Error>> {
	let ValidationOptions {
		public_tasks,
		hidden_tasks,
		corpus_commitment,
		source_root,
		evaluator_root,
		evaluator_runtime,
		codex_toolchain_root,
		mode,
	} = options;
	let task_report = load_tasks(public_tasks.as_deref(), hidden_tasks.as_deref())?;

	if !task_report.issues.is_empty() {
		write_task_validation_report(
			&task_report,
			public_tasks.as_deref(),
			hidden_tasks.as_deref(),
		)?;

		return Err("task validation failed".into());
	}

	let external_bindings = task_report
		.tasks
		.iter()
		.filter_map(|task| task.evaluator.as_ref()?.external.as_ref())
		.collect::<Vec<_>>();

	if !external_bindings.is_empty() {
		let corpus_path = corpus_commitment
			.as_deref()
			.ok_or("external task validation requires --corpus-commitment")?;
		let source_root =
			source_root.as_deref().ok_or("external task validation requires --source-root")?;
		let evaluator_root = evaluator_root
			.as_deref()
			.ok_or("external task validation requires --evaluator-root")?;
		let evaluator_runtime = evaluator_runtime
			.as_deref()
			.ok_or("external task validation requires --evaluator-runtime")?;
		let evaluator_root = controlled_evaluator_root(evaluator_root)?;
		let evaluator_runtime = EvaluatorRuntime::resolve(evaluator_runtime)?;
		let codex_toolchain_root = codex_toolchain_root
			.as_deref()
			.ok_or("external task validation requires --codex-toolchain-root")?;
		let corpus = match &mode {
			CorpusValidationMode::Released => corpus_commitment::validate_corpus_commitment(
				corpus_path,
				&task_report.tasks,
				source_root,
			)?,
			CorpusValidationMode::Core => {
				if !scoring::task_bindings_match_core_catalog(&task_report.tasks) {
					return Err("tasks do not match the immutable AIQ Core 1.0.5 catalog".into());
				}

				corpus_commitment::validate_core_corpus_commitment(
					corpus_path,
					&task_report.tasks,
					source_root,
				)?
			},
			CorpusValidationMode::Contrast { expected_corpus_sha256 } => {
				if task_report.tasks.len() != 6 {
					return Err("contrast validation requires exactly six tasks".into());
				}

				corpus_commitment::validate_contrast_corpus_commitment(
					corpus_path,
					&task_report.tasks,
					source_root,
					expected_corpus_sha256,
				)?
			},
		};

		corpus.validate_evaluator_runtime(&evaluator_runtime)?;
		corpus.validate_model_toolchain(codex_toolchain_root, &evaluator_runtime)?;

		for binding in external_bindings {
			binding.validate_registry(&evaluator_root)?;
			binding.validate_runtime(&evaluator_runtime)?;
		}
	} else if evaluator_root.is_some()
		|| evaluator_runtime.is_some()
		|| corpus_commitment.is_some()
		|| source_root.is_some()
		|| codex_toolchain_root.is_some()
		|| !matches!(mode, CorpusValidationMode::Released)
	{
		return Err("evaluator options require at least one external task".into());
	}

	write_task_validation_report(&task_report, public_tasks.as_deref(), hidden_tasks.as_deref())?;

	Ok(())
}

fn controlled_evaluator_root(path: &Path) -> Result<PathBuf, Box<dyn std::error::Error>> {
	let metadata = fs::symlink_metadata(path)?;

	if metadata.file_type().is_symlink() {
		return Err("evaluator root must not be a symlink".into());
	}

	let root = fs::canonicalize(path)?;

	if !root.is_dir() {
		return Err("evaluator root must be a directory".into());
	}

	Ok(root)
}

fn controlled_codex_binary(selector: &str) -> Result<String, Box<dyn std::error::Error>> {
	let path = Path::new(selector);

	if !path.is_absolute() {
		return Err("model execution requires an absolute --codex-binary".into());
	}

	let metadata = fs::symlink_metadata(path)?;

	if metadata.file_type().is_symlink() || !metadata.is_file() {
		return Err("--codex-binary must be a non-symlink regular file".into());
	}
	#[cfg(unix)]
	if PermissionsExt::mode(&metadata.permissions()) & 0o111 == 0 {
		return Err("--codex-binary must be executable".into());
	}

	let canonical = fs::canonicalize(path)?;

	Ok(canonical.to_string_lossy().into_owned())
}

fn parse_controlled_codex_binary(value: &str) -> Result<String, String> {
	controlled_codex_binary(value).map_err(|error| error.to_string())
}

fn parse_run_observed_at(value: &str) -> Result<String, String> {
	let milliseconds = value.strip_prefix("unix-ms:").ok_or_else(|| {
		"run --observed-at must use the canonical unix-ms:<milliseconds> format".to_owned()
	})?;

	if milliseconds.is_empty()
		|| (milliseconds.len() > 1 && milliseconds.starts_with('0'))
		|| !milliseconds.bytes().all(|byte| byte.is_ascii_digit())
	{
		return Err(
			"run --observed-at must use the canonical unix-ms:<milliseconds> format".to_owned()
		);
	}

	let parsed = milliseconds.parse::<u64>().map_err(|_| {
		"run --observed-at milliseconds must fit in an unsigned 64-bit integer".to_owned()
	})?;

	if parsed == 0 {
		return Err("run --observed-at milliseconds must be greater than zero".to_owned());
	}

	Ok(format!("unix-ms:{parsed}"))
}

fn controlled_codex_home(path: &Path) -> Result<PathBuf, Box<dyn std::error::Error>> {
	if !path.is_absolute() {
		return Err("--codex-home must be an absolute path".into());
	}

	let metadata = fs::symlink_metadata(path).map_err(|error| {
		if error.kind() == ErrorKind::NotFound {
			"--codex-home must name an existing non-symlink directory".to_owned()
		} else {
			format!("cannot inspect --codex-home: {error}")
		}
	})?;

	if metadata.file_type().is_symlink() || !metadata.is_dir() {
		return Err("--codex-home must name an existing non-symlink directory".into());
	}

	fs::canonicalize(path)
		.map_err(|error| format!("cannot canonicalize --codex-home: {error}").into())
}

fn parse_controlled_codex_home(value: &str) -> Result<PathBuf, String> {
	controlled_codex_home(Path::new(value)).map_err(|error| error.to_string())
}

fn validate_run_mode_options(
	options: &RunOptions,
	official_shape: bool,
) -> Result<(), Box<dyn std::error::Error>> {
	if options.run_class == RunClass::Official && !official_shape {
		return Err("Official runs require exactly 72 controlled tasks and the exact 17-model matrix; no model was invoked".into());
	}
	if options.run_class == RunClass::Official && options.output == Path::new("-") {
		return Err(
			"Official runs require a new durable --output path; no model was invoked".into()
		);
	}

	Ok(())
}

fn prepare_run_model_free(options: &RunOptions) -> Result<PreparedRun, Box<dyn std::error::Error>> {
	let mut report = load_tasks(options.public_tasks.as_deref(), options.hidden_tasks.as_deref())?;

	if !report.issues.is_empty() {
		write_task_validation_report(
			&report,
			options.public_tasks.as_deref(),
			options.hidden_tasks.as_deref(),
		)?;

		return Err("task validation failed; no model was invoked".into());
	}

	let selected_tasks = select_tasks(&report.tasks, &options.task_selectors)?;
	let selected_models = select_models(&options.model_selectors)?;
	let official_shape = selected_tasks.len() == 72 && selected_models == MODEL_MATRIX;

	validate_run_mode_options(options, official_shape)?;

	let corpus = corpus_commitment::validate_corpus_commitment(
		&options.corpus_commitment,
		&selected_tasks,
		&options.source_root,
	)?;
	let (slot, seconds_until_next_slot, scheduled_unix_ms, next_slot_unix_ms) =
		run_schedule_bounds(options)?;
	let (model_free_available, model_free_unsupported) = if options.run_class == RunClass::Official
	{
		(MODEL_MATRIX.as_slice(), [].as_slice())
	} else {
		([].as_slice(), MODEL_MATRIX.as_slice())
	};
	let conservative_capacity = capacity::assess_capacity(
		&selected_tasks,
		&selected_models,
		model_free_available,
		model_free_unsupported,
		&protocol::canonical_hash(&"aiq.model-free-official-capacity.v1")?,
		options.jobs,
		seconds_until_next_slot,
	)?;
	let task_set_hash = task::task_set_hash(&selected_tasks)?;
	let run_id = resume::classified_run_id(
		&slot,
		&task_set_hash,
		corpus.canonical_sha256(),
		&selected_models,
		options.run_class,
	)?;

	report.tasks = selected_tasks;

	Ok(PreparedRun {
		report,
		selected_models,
		corpus,
		conservative_capacity,
		slot,
		task_set_hash,
		run_id,
		execution_window: ExecutionWindow { scheduled_unix_ms, next_slot_unix_ms },
	})
}

fn build_official_plan(
	inputs: OfficialPlanningInputs<'_>,
	prepared: &PreparedRun,
) -> Result<OfficialPlanBinding, Box<dyn std::error::Error>> {
	if prepared.selected_models != MODEL_MATRIX || prepared.report.tasks.len() != 72 {
		return Err("Official planning requires the exact 72-by-17 selection".into());
	}

	let evaluator_root = controlled_evaluator_root(inputs.evaluator_root)?;
	let evaluator_runtime = EvaluatorRuntime::resolve(inputs.evaluator_runtime)?;

	prepared.corpus.validate_evaluator_runtime(&evaluator_runtime)?;

	let model_toolchain = prepared
		.corpus
		.validate_model_toolchain(inputs.codex_toolchain_root, &evaluator_runtime)?;

	validate_external_evaluator_bindings(
		&prepared.report.tasks,
		&evaluator_root,
		&evaluator_runtime,
	)?;

	LocalDirectoryWorkspaceProvider::new(
		inputs.workspace_root,
		inputs.execution_root,
		prepared.corpus.baseline_workspace_digests().clone(),
	)?;

	let manifest = read_json::<CapabilityManifest>(inputs.capabilities)?;
	let manifest_issues = adapter::validate_capability_manifest(&manifest);

	if !manifest_issues.is_empty() {
		return Err(
			format!("capability manifest is invalid: {}", manifest_issues.join("; ")).into()
		);
	}

	let codex_binary = controlled_codex_binary(inputs.codex_binary)?;
	let output_plan = official_output_plan(
		inputs.preflight_cache,
		inputs.checkpoint,
		inputs.run_output,
		inputs.score_output,
		inputs.package_output,
		inputs.reserved_run_output_for,
	)?;
	let schedule: ScheduleConfig = read_json(inputs.schedule)?;

	Ok(OfficialPlanBinding {
		run_id: prepared.run_id.clone(),
		task_ids: prepared.report.tasks.iter().map(|task| task.task_id.clone()).collect(),
		task_set_hash: prepared.task_set_hash.clone(),
		corpus_commitment_digest: prepared.corpus.canonical_sha256().to_owned(),
		catalog_digest: prepared.corpus.catalog_digest().to_owned(),
		source_manifest_digest: prepared.corpus.source_manifest_digest().to_owned(),
		evaluator_digest: corpus_commitment::evaluator_digest(&prepared.report.tasks)?,
		capability_manifest_digest: protocol::canonical_hash(&manifest)?,
		model_toolchain_digest: model_toolchain.digest().to_owned(),
		evaluator_runtime_digest: evaluator_runtime.executable_digest().to_owned(),
		runner_executable_digest: corpus_commitment::runner_executable_digest()?,
		codex_executable_digest: corpus_commitment::codex_executable_digest(&codex_binary)?,
		codex_credential_digest: protocol::canonical_hash(
			&adapter::chatgpt_credential_observation(inputs.codex_home)?,
		)?,
		public_tasks: inputs
			.public_tasks
			.map(|path| canonical_policy_path(path).map(|path| path.display().to_string()))
			.transpose()?,
		hidden_tasks: inputs
			.hidden_tasks
			.map(|path| canonical_policy_path(path).map(|path| path.display().to_string()))
			.transpose()?,
		corpus_commitment: canonical_policy_path(inputs.corpus_commitment)?.display().to_string(),
		capabilities: canonical_policy_path(inputs.capabilities)?.display().to_string(),
		source_root: resume::directory_identity(inputs.source_root, "source root")?,
		workspace_root: resume::directory_identity(inputs.workspace_root, "workspace root")?,
		execution_root: resume::directory_identity(inputs.execution_root, "execution root")?,
		evaluator_root: evaluator_root.display().to_string(),
		evaluator_runtime: evaluator_runtime.executable().display().to_string(),
		codex_toolchain_root: model_toolchain.root().display().to_string(),
		artifact_root: resume::directory_identity(inputs.artifact_root, "artifact root")?,
		codex_home: resume::directory_identity(inputs.codex_home, "Codex home")?,
		codex_binary,
		schedule: canonical_policy_path(inputs.schedule)?.display().to_string(),
		schedule_digest: protocol::canonical_hash(&schedule)?,
		slot: prepared.slot.clone(),
		observed_at: inputs.observed_at.to_owned(),
		jobs: prepared.conservative_capacity.configured_jobs,
		conservative_capacity_digest: prepared.conservative_capacity.digest()?,
		outputs: output_plan,
	})
}

fn official_output_plan(
	preflight_cache: &Path,
	checkpoint: &Path,
	run_output: &Path,
	score_output: &Path,
	package_output: &Path,
	reserved_run_output_for: Option<&str>,
) -> Result<OfficialOutputPlan, Box<dyn std::error::Error>> {
	let paths = [preflight_cache, checkpoint, run_output, score_output, package_output];

	if paths.iter().any(|path| *path == Path::new("-")) {
		return Err("Official planning requires durable output paths".into());
	}

	let canonical =
		paths.into_iter().map(canonical_leaf_policy_path).collect::<Result<Vec<_>, _>>()?;
	let unique = canonical.iter().collect::<BTreeSet<_>>();

	if unique.len() != canonical.len() {
		return Err(
			"Official preflight, checkpoint, run, score, and package paths must be distinct".into(),
		);
	}

	for (index, (label, path)) in [
		("Official run output", &canonical[2]),
		("Official score output", &canonical[3]),
		("Official package output", &canonical[4]),
	]
	.into_iter()
	.enumerate()
	{
		match fs::symlink_metadata(path) {
			Err(error) if error.kind() == ErrorKind::NotFound => {},
			Err(error) => return Err(error.into()),
			Ok(_)
				if index == 0
					&& reserved_run_output_for.is_some_and(|run_id| {
						has_exact_official_output_reservation(path, run_id)
					}) => {},
			Ok(_) => return Err(format!("{label} must not exist before admission").into()),
		}
	}

	Ok(OfficialOutputPlan {
		preflight_cache: canonical[0].display().to_string(),
		preflight_attempt: canonical_leaf_policy_path(&resume::preflight_attempt_path(
			preflight_cache,
		))?
		.display()
		.to_string(),
		checkpoint: canonical[1].display().to_string(),
		run_output: canonical[2].display().to_string(),
		score_output: canonical[3].display().to_string(),
		package_output: canonical[4].display().to_string(),
	})
}

fn run_schedule_bounds(
	options: &RunOptions,
) -> Result<(ScheduleSlot, u64, u64, u64), Box<dyn std::error::Error>> {
	let schedule: ScheduleConfig = read_json(&options.schedule)?;
	let occurrence = ScheduleOccurrence::from_str(&options.occurrence)?;
	let slot = schedule.slot(&options.slot_date, occurrence)?;
	let seconds_until_next_slot = schedule.seconds_until_next_slot(&slot)?;
	let scheduled_unix_ms = slot.scheduled_unix_ms()?;
	let next_slot_unix_ms = seconds_until_next_slot
		.checked_mul(1_000)
		.and_then(|interval| scheduled_unix_ms.checked_add(interval))
		.ok_or("next schedule slot overflows")?;

	Ok((slot, seconds_until_next_slot, scheduled_unix_ms, next_slot_unix_ms))
}

fn assess_run_capacity(
	options: &RunOptions,
	capability_validation: &CapabilityValidationReport,
	selected_tasks: &[TaskDefinition],
	selected_models: &[ModelConfig],
	seconds_until_next_slot: u64,
) -> Result<CapacityAdmission, Box<dyn std::error::Error>> {
	let (available_models, observed_unsupported_models) =
		capability_partition(capability_validation)?;
	let capability_validation_digest = protocol::canonical_hash(capability_validation)?;

	Ok(capacity::assess_capacity(
		selected_tasks,
		selected_models,
		&available_models,
		&observed_unsupported_models,
		&capability_validation_digest,
		options.jobs,
		seconds_until_next_slot,
	)?)
}

fn validate_live_protected_layout(
	options: &RunOptions,
	protected_paths: &[ProtectedBenchmarkPath],
	model_toolchain: &ValidatedModelToolchain,
) -> Result<(PathBuf, Vec<PathBuf>), Box<dyn std::error::Error>> {
	let execution_root = fs::canonicalize(&options.execution_root)?;

	isolation::validate_protected_layout(
		protected_paths,
		Some(&execution_root),
		&[model_toolchain.root().to_owned()],
	)?;

	Ok((execution_root, benchmark_denied_roots(protected_paths)?))
}

fn freeze_run_preflight(
	options: &RunOptions,
	official_admission: Option<&(PermissionAdmissionReport, String)>,
) -> Result<PreflightCache, Box<dyn std::error::Error>> {
	let official_admission_digest = official_admission.map(|(_, digest)| digest.as_str());
	let evaluator_runtime = resolve_run_evaluator_runtime(options)?;
	let toolchain_policy =
		corpus_commitment::read_execution_tool_policy(&options.corpus_commitment)?;
	let model_toolchain = corpus_commitment::validate_model_toolchain(
		&options.codex_toolchain_root,
		&toolchain_policy,
		&evaluator_runtime,
	)?;
	let manifest: CapabilityManifest = read_json(&options.capabilities)?;
	let manifest_issues = adapter::validate_capability_manifest(&manifest);

	if !manifest_issues.is_empty() {
		return Err(
			format!("capability manifest is invalid: {}", manifest_issues.join("; ")).into()
		);
	}

	let artifact_sink = LocalArtifactSink::new(&options.artifact_root)?;
	let protected_paths = benchmark_protected_paths(options)?;
	let (_, denied_roots) =
		validate_live_protected_layout(options, &protected_paths, &model_toolchain)?;
	let execution_config = CodexExecutionConfig::isolated(options.codex_home.clone())
		.with_denied_roots(denied_roots)
		.with_model_toolchain(model_toolchain.clone());
	let adapter = CodexAdapter::new(
		SystemExecutor,
		artifact_sink,
		controlled_codex_binary(&options.codex_binary)?,
		execution_config,
	);

	if let Some((receipt, _)) = official_admission {
		let expected_profile = receipt
			.managed_profile
			.as_ref()
			.ok_or("Official admission receipt omits permission profile evidence")?;
		let current_profile = adapter.verify_managed_permission_profile(&options.execution_root)?;

		if &current_profile != expected_profile {
			return Err(
				"explicit permission profile evidence changed after Official admission; no model was invoked"
					.into(),
			);
		}

		let current_evidence = verify_permission_evidence_with_profile(
			&adapter,
			&options.execution_root,
			&protected_paths,
			RunClass::Official,
			current_profile,
		)?;

		if receipt.permission_evidence_digest.as_deref()
			!= Some(current_evidence.combined_digest()?.as_str())
		{
			return Err("permission evidence or canaries changed after Official admission; no model was invoked".into());
		}
	}

	let force_refresh = options.refresh_preflight || !options.preflight_cache.exists();
	let preflight_binding = force_refresh
		.then(|| {
			PreflightAdmissionBinding::capture(
				&adapter,
				PreflightAdmissionInputs {
					capabilities: &options.capabilities,
					corpus_commitment: &options.corpus_commitment,
					execution_policy: &toolchain_policy,
					evaluator_runtime: &evaluator_runtime,
					codex_toolchain_root: &options.codex_toolchain_root,
					model_toolchain: &model_toolchain,
					codex_binary: &options.codex_binary,
					codex_home: &options.codex_home,
					profile_workspace: &options.execution_root,
					artifact_root: &options.artifact_root,
					output: &options.preflight_cache,
				},
			)
		})
		.transpose()?;

	if let Some(binding) = &preflight_binding {
		binding.verify(&adapter)?;
	}

	let preflight = load_run_preflight(
		&adapter,
		&manifest,
		options,
		force_refresh,
		model_toolchain.digest(),
		official_admission_digest,
	)?;

	if preflight.official_admission_digest.as_deref() != official_admission_digest {
		return Err("preflight cache does not match the exact Official admission receipt".into());
	}

	capability_partition(&preflight.report)?;

	Ok(preflight)
}

fn resolve_run_evaluator_runtime(
	options: &RunOptions,
) -> Result<EvaluatorRuntime, Box<dyn std::error::Error>> {
	Ok(EvaluatorRuntime::resolve(&options.evaluator_runtime)?)
}

fn acquire_run_future_protected_locks(
	options: &RunOptions,
	run_id: &str,
) -> Result<(Vec<FutureProtectedEntry>, FutureProtectedDirectoryLocks), Box<dyn std::error::Error>>
{
	validate_run_future_protected_paths(
		&options.preflight_cache,
		&options.checkpoint,
		&options.output,
	)?;

	let entries = future_protected_entries(
		options.run_class,
		&options.preflight_cache,
		&options.checkpoint,
		&options.output,
		run_id,
	);
	let locks = FutureProtectedDirectoryLocks::acquire(&entries)?;

	Ok((entries, locks))
}

fn validate_run_future_protected_paths(
	preflight_cache: &Path,
	checkpoint: &Path,
	output: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
	let preflight_attempt = resume::preflight_attempt_path(preflight_cache);
	let mut paths = vec![
		("preflight cache", preflight_cache),
		("preflight attempt", preflight_attempt.as_path()),
		("checkpoint", checkpoint),
	];

	if output != Path::new("-") {
		paths.push(("durable run output", output));
	}

	let mut unique = BTreeMap::new();

	for (label, path) in paths {
		let path = canonical_leaf_policy_path(path)?;

		if let Some(previous) = unique.insert(path, label) {
			return Err(format!("{previous} and {label} paths must be distinct").into());
		}
	}

	Ok(())
}

fn acquire_preflight_future_protected_locks(
	output: &Path,
) -> Result<FutureProtectedDirectoryLocks, Box<dyn std::error::Error>> {
	if output == Path::new("-") {
		return Err("capability preflight requires a durable output path".into());
	}

	let attempt = resume::preflight_attempt_path(output);
	let entries = [
		FutureProtectedEntry {
			category: "preflight_cache",
			path: output.to_owned(),
			must_be_new: false,
			recoverable_bytes: None,
		},
		FutureProtectedEntry {
			category: "preflight_attempt",
			path: attempt,
			must_be_new: false,
			recoverable_bytes: None,
		},
	];

	FutureProtectedDirectoryLocks::acquire(&entries)
}

fn run_live(options: RunOptions) -> Result<(), Box<dyn std::error::Error>> {
	complete_live_run(prepare_authorized_live_run(options)?)
}

fn prepare_authorized_live_run(
	mut options: RunOptions,
) -> Result<AuthorizedRun, Box<dyn std::error::Error>> {
	let prepared = prepare_run_model_free(&options)?;
	let admission = match (options.run_class, options.official_admission.as_deref()) {
		(RunClass::Official, Some(path)) => Some(read_successful_official_admission(path)?),
		(RunClass::Official, None) => {
			return Err(
				"Official run requires --official-admission before any paid preflight".into()
			);
		},
		(RunClass::Calibration, Some(_)) => {
			return Err("calibration runs must not consume an Official admission receipt".into());
		},
		(RunClass::Calibration, None) => None,
	};

	verify_official_admitted_plan(&options, &prepared, admission.as_ref())?;

	let (future_entries, future_locks) =
		acquire_run_future_protected_locks(&options, &prepared.run_id)?;
	let mut future_files = FutureProtectedFiles::with_locks(future_locks);

	for entry in future_entries.iter().filter(|entry| entry.category == "output") {
		future_files.prepare_entry(entry)?;
	}

	let preflight = freeze_run_preflight(&options, admission.as_ref())?;

	for entry in future_entries.iter().filter(|entry| entry.category != "output") {
		future_files.prepare_entry(entry)?;
	}

	let capacity_admission = assess_run_capacity(
		&options,
		&preflight.report,
		&prepared.report.tasks,
		&prepared.selected_models,
		prepared.conservative_capacity.seconds_until_next_slot,
	)?;
	let PreparedRun {
		report,
		selected_models,
		corpus,
		conservative_capacity: _,
		slot,
		task_set_hash,
		run_id,
		execution_window,
	} = prepared;
	let runtime = prepare_live_runtime(&mut options, &corpus, &report.tasks, future_files)?;
	let PreparedLiveRuntime {
		adapter,
		workspace_provider,
		evaluator_root,
		evaluator_runtime,
		model_toolchain,
		manifest,
		future_files,
		permission_evidence,
		runner_executable_digest,
		codex_executable_digest,
		codex_home_commitment,
	} = runtime;
	let permission_evidence_digest = permission_evidence.combined_digest()?;

	if let Some((report, _)) = &admission
		&& report.permission_evidence_digest.as_deref() != Some(&permission_evidence_digest)
	{
		return Err(
			"permission evidence changed after Official admission; no task model was invoked"
				.into(),
		);
	}

	Ok(AuthorizedRun {
		capacity_admission,
		report,
		selected_models,
		corpus,
		adapter,
		workspace_provider,
		evaluator_root,
		evaluator_runtime,
		model_toolchain,
		manifest,
		future_files,
		permission_evidence_digest,
		slot,
		task_set_hash,
		run_id,
		runner_executable_digest,
		codex_executable_digest,
		codex_binary_commitment: options.codex_binary.clone(),
		codex_home_commitment,
		preflight,
		execution_window,
		options,
	})
}

fn verify_official_admitted_plan(
	options: &RunOptions,
	prepared: &PreparedRun,
	admission: Option<&(PermissionAdmissionReport, String)>,
) -> Result<(), Box<dyn std::error::Error>> {
	let Some((report, _)) = admission else { return Ok(()) };
	let admitted = report.plan.as_ref().ok_or("Official admission receipt omits its plan")?;
	let expected = build_official_plan(
		OfficialPlanningInputs {
			public_tasks: options.public_tasks.as_deref(),
			hidden_tasks: options.hidden_tasks.as_deref(),
			corpus_commitment: &options.corpus_commitment,
			capabilities: &options.capabilities,
			source_root: &options.source_root,
			workspace_root: &options.workspace_root,
			execution_root: &options.execution_root,
			evaluator_root: &options.evaluator_root,
			evaluator_runtime: &options.evaluator_runtime,
			codex_toolchain_root: &options.codex_toolchain_root,
			codex_binary: &options.codex_binary,
			codex_home: &options.codex_home,
			artifact_root: &options.artifact_root,
			schedule: &options.schedule,
			observed_at: &options.observed_at,
			preflight_cache: &options.preflight_cache,
			checkpoint: &options.checkpoint,
			run_output: &options.output,
			score_output: Path::new(&admitted.outputs.score_output),
			package_output: Path::new(&admitted.outputs.package_output),
			reserved_run_output_for: Some(&prepared.run_id),
		},
		prepared,
	)?;

	if &expected != admitted {
		return Err(
			"Official run inputs do not match the exact admission receipt; no model was invoked"
				.into(),
		);
	}

	Ok(())
}

fn prepare_live_runtime(
	options: &mut RunOptions,
	corpus: &ValidatedCorpusCommitment,
	tasks: &[TaskDefinition],
	future_files: FutureProtectedFiles,
) -> Result<PreparedLiveRuntime, Box<dyn std::error::Error>> {
	options.codex_binary = controlled_codex_binary(&options.codex_binary)?;

	let evaluator_root = controlled_evaluator_root(&options.evaluator_root)?;
	let evaluator_runtime = EvaluatorRuntime::resolve(&options.evaluator_runtime)?;

	corpus.validate_evaluator_runtime(&evaluator_runtime)?;

	let model_toolchain =
		corpus.validate_model_toolchain(&options.codex_toolchain_root, &evaluator_runtime)?;

	validate_external_evaluator_bindings(tasks, &evaluator_root, &evaluator_runtime)?;

	let runner_executable_digest = corpus_commitment::runner_executable_digest()?;
	let codex_executable_digest =
		corpus_commitment::codex_executable_digest(&options.codex_binary)?;
	let manifest = read_json::<CapabilityManifest>(&options.capabilities)?;
	let codex_home_commitment = resume::directory_identity(&options.codex_home, "Codex home")?;
	let workspace_provider = LocalDirectoryWorkspaceProvider::new(
		&options.workspace_root,
		&options.execution_root,
		corpus.baseline_workspace_digests().clone(),
	)?;
	let artifact_sink = LocalArtifactSink::new(&options.artifact_root)?;
	let protected_paths = benchmark_protected_paths(options)?;
	let (execution_root, denied_roots) =
		validate_live_protected_layout(options, &protected_paths, &model_toolchain)?;
	let adapter = CodexAdapter::new(
		SystemExecutor,
		artifact_sink,
		options.codex_binary.clone(),
		CodexExecutionConfig::isolated(options.codex_home.clone())
			.with_denied_roots(denied_roots)
			.with_model_toolchain(model_toolchain.clone()),
	);
	let permission_evidence =
		verify_permission_evidence(&adapter, &execution_root, &protected_paths, options.run_class)?;

	Ok(PreparedLiveRuntime {
		adapter,
		workspace_provider,
		evaluator_root,
		evaluator_runtime,
		model_toolchain,
		manifest,
		future_files,
		permission_evidence,
		runner_executable_digest,
		codex_executable_digest,
		codex_home_commitment,
	})
}

fn validate_external_evaluator_bindings(
	tasks: &[TaskDefinition],
	evaluator_root: &Path,
	evaluator_runtime: &EvaluatorRuntime,
) -> Result<(), Box<dyn std::error::Error>> {
	for task in tasks {
		if let Some(binding) =
			task.evaluator.as_ref().and_then(|evaluator| evaluator.external.as_ref())
		{
			binding.validate_registry(evaluator_root)?;
			binding.validate_runtime(evaluator_runtime)?;
		}
	}

	Ok(())
}

fn future_protected_entries(
	run_class: RunClass,
	preflight_cache: &Path,
	checkpoint: &Path,
	output: &Path,
	run_id: &str,
) -> Vec<FutureProtectedEntry> {
	let mut entries = vec![
		FutureProtectedEntry {
			category: "preflight_cache",
			path: preflight_cache.to_owned(),
			must_be_new: false,
			recoverable_bytes: None,
		},
		FutureProtectedEntry {
			category: "checkpoint",
			path: checkpoint.to_owned(),
			must_be_new: false,
			recoverable_bytes: None,
		},
	];

	if output != Path::new("-") {
		entries.push(FutureProtectedEntry {
			category: "output",
			path: output.to_owned(),
			must_be_new: true,
			recoverable_bytes: Some(match run_class {
				RunClass::Official => official_output_reservation(run_id),
				RunClass::Calibration => calibration_output_reservation(run_id),
			}),
		});
	}

	entries
}

fn verify_permission_evidence<E, S>(
	adapter: &CodexAdapter<E, S>,
	execution_root: &Path,
	protected_paths: &[ProtectedBenchmarkPath],
	run_class: RunClass,
) -> Result<VerifiedPermissionEvidence, Box<dyn std::error::Error>>
where
	E: Executor,
	S: ArtifactSink,
{
	let profile = adapter.verify_managed_permission_profile(execution_root)?;

	verify_permission_evidence_with_profile(
		adapter,
		execution_root,
		protected_paths,
		run_class,
		profile,
	)
}

fn verify_permission_evidence_with_profile<E, S>(
	adapter: &CodexAdapter<E, S>,
	execution_root: &Path,
	protected_paths: &[ProtectedBenchmarkPath],
	run_class: RunClass,
	profile: ManagedPermissionProfileEvidence,
) -> Result<VerifiedPermissionEvidence, Box<dyn std::error::Error>>
where
	E: Executor,
	S: ArtifactSink,
{
	if run_class == RunClass::Official && !profile.official_eligible {
		return Err("Official runs require no external managed requirements and must select the explicit aiq_benchmark profile; no model was invoked".into());
	}

	let digests = PermissionEvidenceDigests {
		permission_policy_digest: adapter.permission_policy_digest(execution_root)?,
		managed_requirements_digest: profile.managed_requirements_digest().to_owned(),
		profile_selection_digest: profile.profile_selection_digest().to_owned(),
		canary_digest: verify_codex_permission_boundary(adapter, execution_root, protected_paths)?,
	};

	Ok(VerifiedPermissionEvidence { profile, digests })
}

fn validate_selected_run(
	run: &SelectedRun,
	tasks: &[TaskDefinition],
) -> Result<(), Box<dyn std::error::Error>> {
	match run {
		SelectedRun::OfficialShape(run) => {
			aiq_runner::run_validation::validate_run_record(run, Some(tasks))?
		},
		SelectedRun::Calibration(run) => {
			aiq_runner::run_validation::validate_calibration_run_record(run)?
		},
	}

	Ok(())
}

fn write_selected_run(
	run: SelectedRun,
	output: &Path,
	future_files: &mut FutureProtectedFiles,
) -> Result<(), Box<dyn std::error::Error>> {
	match run {
		SelectedRun::OfficialShape(run) => {
			future_files.write_created_pretty_json(output, &run, "Official live output")
		},
		SelectedRun::Calibration(run) if output == Path::new("-") => write_json(output, &run),
		SelectedRun::Calibration(run) => {
			future_files.write_created_pretty_json(output, &run, "calibration live output")
		},
	}
}

fn write_selected_run_and_disarm(
	run: SelectedRun,
	tasks: &[TaskDefinition],
	options: &RunOptions,
	future_files: &mut FutureProtectedFiles,
	dispatch_deadline: &DispatchDeadline,
) -> Result<(), Box<dyn std::error::Error>> {
	validate_selected_run(&run, tasks)?;

	let (started_unix_ms, finished_unix_ms) = match &run {
		SelectedRun::OfficialShape(run) => (run.started_unix_ms, run.finished_unix_ms),
		SelectedRun::Calibration(run) => (run.started_unix_ms, run.finished_unix_ms),
	};
	let write_result = with_completion_execution_boundary(
		dispatch_deadline,
		started_unix_ms,
		finished_unix_ms,
		|| write_selected_run(run, &options.output, future_files),
	);

	if write_result.is_ok() {
		future_files.disarm(&options.output);
	}

	write_result
}

fn complete_live_run(context: AuthorizedRun) -> Result<(), Box<dyn std::error::Error>> {
	let mut executed = execute_authorized_live_run(context)?;

	write_selected_run_and_disarm(
		executed.run,
		&executed.tasks,
		&executed.options,
		&mut executed.future_files,
		&executed.dispatch_deadline,
	)
}

fn execute_authorized_live_run(
	mut context: AuthorizedRun,
) -> Result<ExecutedLiveRun, Box<dyn std::error::Error>> {
	let validation = context.preflight.report.clone();

	context.future_files.disarm(&context.options.preflight_cache);

	let commitments = build_live_run_commitments(&context, &validation)?;
	let AuthorizedRun {
		capacity_admission: _,
		options,
		report,
		selected_models: _,
		corpus: _,
		adapter,
		workspace_provider,
		evaluator_root,
		evaluator_runtime,
		model_toolchain: _,
		manifest,
		mut future_files,
		permission_evidence_digest: _,
		slot: _,
		task_set_hash: _,
		run_id: _,
		runner_executable_digest: _,
		codex_executable_digest: _,
		codex_binary_commitment: _,
		codex_home_commitment: _,
		preflight,
		execution_window,
	} = context;
	let checkpoint_was_created = future_files.was_created(&options.checkpoint);
	let checkpoint_commitments = commitments.clone();
	let (run, dispatch_deadline) = with_final_preflight_execution_boundary(
		&preflight,
		&execution_window,
		|| {
			if checkpoint_was_created {
				RunCheckpoint::new(checkpoint_commitments, resume::unix_ms())
					.persist(&options.checkpoint)?;
			}

			future_files.disarm(&options.checkpoint);

			Ok(())
		},
		resume::unix_ms,
		|| {
			Ok(runner::execute_selected_run(
				&adapter,
				&workspace_provider,
				&manifest,
				&report.tasks,
				validation,
				commitments,
				LocalRunExecution {
					evaluator: Some((&evaluator_root, &evaluator_runtime)),
					checkpoint_path: &options.checkpoint,
					jobs: options.jobs,
				},
			)?)
		},
	)?;

	validate_selected_run(&run, &report.tasks)?;

	Ok(ExecutedLiveRun { run, tasks: report.tasks, options, future_files, dispatch_deadline })
}

fn build_live_run_commitments(
	context: &AuthorizedRun,
	validation: &CapabilityValidationReport,
) -> Result<RunCommitments, Box<dyn std::error::Error>> {
	let evaluator_digest = corpus_commitment::evaluator_digest(&context.report.tasks)?;
	let preflight_digest = protocol::canonical_hash(validation)?;
	let capacity = context.capacity_admission.commitment()?;
	let runtime_digest = resume::runtime_digest(
		context.options.run_class,
		&context.permission_evidence_digest,
		context.model_toolchain.digest(),
		&capacity,
	)?;
	let provenance = context.corpus.run_provenance(
		context.options.run_class,
		context.task_set_hash.clone(),
		evaluator_digest.clone(),
		runtime_digest.clone(),
		preflight_digest.clone(),
		context.runner_executable_digest.clone(),
		context.codex_executable_digest.clone(),
		context.permission_evidence_digest.clone(),
	);

	Ok(RunCommitments {
		run_id: context.run_id.clone(),
		schedule_slot: context.slot.clone(),
		catalog_digest: context.corpus.catalog_digest().to_owned(),
		task_set_hash: context.task_set_hash.clone(),
		scoring_version: AIQ_SCORING_VERSION.to_owned(),
		evaluator_digest,
		runtime_digest,
		model_toolchain_digest: context.model_toolchain.digest().to_owned(),
		capacity,
		models: context.selected_models.clone(),
		run_class: context.options.run_class,
		permission_evidence_digest: context.permission_evidence_digest.clone(),
		workspace_root: resume::directory_identity(
			&context.options.workspace_root,
			"workspace baseline root",
		)?,
		execution_root: resume::directory_identity(
			&context.options.execution_root,
			"workspace execution root",
		)?,
		artifact_root: resume::directory_identity(&context.options.artifact_root, "artifact root")?,
		codex_home: context.codex_home_commitment.clone(),
		codex_binary: context.codex_binary_commitment.clone(),
		observed_at: context.options.observed_at.clone(),
		preflight_digest,
		provenance,
	})
}

fn with_final_preflight_execution_boundary<T>(
	preflight: &PreflightCache,
	window: &ExecutionWindow,
	persist_checkpoint: impl FnOnce() -> Result<(), Box<dyn std::error::Error>>,
	clock: impl FnOnce() -> u64,
	dispatch: impl FnOnce() -> Result<T, Box<dyn std::error::Error>>,
) -> Result<(T, DispatchDeadline), Box<dyn std::error::Error>> {
	persist_checkpoint()?;

	let deadline = validate_dispatch_window(preflight, window, clock())?;
	let output = dispatch()?;

	Ok((output, deadline))
}

fn validate_dispatch_window(
	preflight: &PreflightCache,
	window: &ExecutionWindow,
	now_unix_ms: u64,
) -> Result<DispatchDeadline, Box<dyn std::error::Error>> {
	if preflight.expires_unix_ms <= now_unix_ms {
		return Err(
			"cached preflight expired before run dispatch; no task model or evaluator was invoked"
				.into(),
		);
	}
	if now_unix_ms < window.scheduled_unix_ms || now_unix_ms >= window.next_slot_unix_ms {
		return Err(
			"run dispatch is outside the exact scheduled slot window; no task model or evaluator was invoked"
				.into(),
		);
	}

	Ok(DispatchDeadline {
		dispatched_unix_ms: now_unix_ms,
		next_slot_unix_ms: window.next_slot_unix_ms,
	})
}

fn with_completion_execution_boundary<T>(
	deadline: &DispatchDeadline,
	started_unix_ms: u64,
	finished_unix_ms: u64,
	write_output: impl FnOnce() -> Result<T, Box<dyn std::error::Error>>,
) -> Result<T, Box<dyn std::error::Error>> {
	if finished_unix_ms < started_unix_ms {
		return Err(
			"serialized execution completion precedes the retained checkpoint start; final output was not written"
				.into(),
		);
	}
	if finished_unix_ms < deadline.dispatched_unix_ms {
		return Err(
			"execution completion clock precedes dispatch; final output was not written".into()
		);
	}
	if finished_unix_ms >= deadline.next_slot_unix_ms {
		return Err(
			"execution completed at or after the next scheduled slot; final output was not written"
				.into(),
		);
	}

	write_output()
}

fn capability_partition(
	report: &CapabilityValidationReport,
) -> Result<(Vec<ModelConfig>, Vec<ModelConfig>), Box<dyn std::error::Error>> {
	if !report.is_usable() {
		return Err("capability validation is not a usable exact 17-model report".into());
	}

	let mut available = Vec::new();
	let mut unsupported = Vec::new();

	for model in MODEL_MATRIX {
		let entry =
			report.model(model).ok_or("capability preflight model partition is incomplete")?;

		match (entry.status, entry.probe.status) {
			(CapabilityValidationStatus::Available, ConfigurationProbeStatus::Available) => {
				available.push(model)
			},
			(
				CapabilityValidationStatus::Unsupported,
				ConfigurationProbeStatus::ObservedUnsupported,
			) => unsupported.push(model),
			_ => return Err("capability preflight support evidence is inconsistent".into()),
		}
	}

	Ok((available, unsupported))
}

fn benchmark_protected_paths(
	options: &RunOptions,
) -> Result<Vec<ProtectedBenchmarkPath>, Box<dyn std::error::Error>> {
	let planned_postrun = options
		.official_admission
		.as_deref()
		.map(read_successful_official_admission)
		.transpose()?
		.map(|(receipt, _)| {
			let plan = receipt.plan.ok_or("Official admission receipt omits its plan")?;

			Ok::<_, Box<dyn std::error::Error>>((
				PathBuf::from(plan.outputs.score_output),
				PathBuf::from(plan.outputs.package_output),
			))
		})
		.transpose()?;

	benchmark_protected_paths_from(BenchmarkProtectedPathInputs {
		public_tasks: options.public_tasks.as_deref(),
		hidden_tasks: options.hidden_tasks.as_deref(),
		source_root: &options.source_root,
		workspace_root: &options.workspace_root,
		evaluator_root: &options.evaluator_root,
		artifact_root: &options.artifact_root,
		codex_home: &options.codex_home,
		codex_binary: Path::new(&options.codex_binary),
		corpus_commitment: &options.corpus_commitment,
		capabilities: &options.capabilities,
		schedule: &options.schedule,
		preflight_cache: &options.preflight_cache,
		checkpoint: &options.checkpoint,
		planned_output: &options.output,
		planned_score_output: planned_postrun.as_ref().map(|(score, _)| score.as_path()),
		planned_package_output: planned_postrun.as_ref().map(|(_, package)| package.as_path()),
		report_output: None,
		official_admission: options.official_admission.as_deref(),
	})
}

fn benchmark_protected_paths_from(
	inputs: BenchmarkProtectedPathInputs<'_>,
) -> Result<Vec<ProtectedBenchmarkPath>, Box<dyn std::error::Error>> {
	let mut paths = Vec::new();
	let mut push =
		|category: &'static str, path: &Path| -> Result<(), Box<dyn std::error::Error>> {
			if path != Path::new("-") {
				paths.push(ProtectedBenchmarkPath { category, path: canonical_policy_path(path)? });
			}

			Ok(())
		};

	push("source_root", inputs.source_root)?;
	push("workspace_baselines", inputs.workspace_root)?;
	push("evaluator_root", inputs.evaluator_root)?;
	push("artifact_root", inputs.artifact_root)?;
	push("codex_home", inputs.codex_home)?;
	push("codex_binary", inputs.codex_binary)?;

	if let Some(path) = inputs.public_tasks {
		push("public_tasks", path)?;
	}
	if let Some(path) = inputs.hidden_tasks {
		push("hidden_tasks", path)?;
	}

	push("corpus_commitment", inputs.corpus_commitment)?;
	push("capabilities", inputs.capabilities)?;
	push("schedule", inputs.schedule)?;
	push("preflight_cache", inputs.preflight_cache)?;

	let preflight_attempt = resume::preflight_attempt_path(inputs.preflight_cache);

	push("preflight_attempt", &preflight_attempt)?;
	push("checkpoint", inputs.checkpoint)?;
	push("output", inputs.planned_output)?;

	if let Some(path) = inputs.planned_score_output {
		push("official_score_output", path)?;
	}
	if let Some(path) = inputs.planned_package_output {
		push("official_package_output", path)?;
	}
	if let Some(path) = inputs.report_output {
		push("official_admission_receipt", path)?;
	}
	if let Some(path) = inputs.official_admission {
		push("official_admission_receipt", path)?;
	}

	Ok(paths)
}

fn official_plan_protected_paths(
	plan: &OfficialPlanBinding,
	receipt_path: &Path,
) -> Result<Vec<ProtectedBenchmarkPath>, Box<dyn std::error::Error>> {
	let mut paths = vec![
		("source_root", plan.source_root.as_str()),
		("workspace_baselines", plan.workspace_root.as_str()),
		("evaluator_root", plan.evaluator_root.as_str()),
		("artifact_root", plan.artifact_root.as_str()),
		("codex_home", plan.codex_home.as_str()),
		("codex_binary", plan.codex_binary.as_str()),
	];

	if let Some(path) = &plan.public_tasks {
		paths.push(("public_tasks", path));
	}
	if let Some(path) = &plan.hidden_tasks {
		paths.push(("hidden_tasks", path));
	}

	paths.extend([
		("corpus_commitment", plan.corpus_commitment.as_str()),
		("capabilities", plan.capabilities.as_str()),
		("schedule", plan.schedule.as_str()),
		("preflight_cache", plan.outputs.preflight_cache.as_str()),
		("preflight_attempt", plan.outputs.preflight_attempt.as_str()),
		("checkpoint", plan.outputs.checkpoint.as_str()),
		("output", plan.outputs.run_output.as_str()),
		("official_score_output", plan.outputs.score_output.as_str()),
		("official_package_output", plan.outputs.package_output.as_str()),
	]);

	let mut protected = paths
		.into_iter()
		.map(|(category, path)| {
			Ok(ProtectedBenchmarkPath { category, path: canonical_policy_path(Path::new(path))? })
		})
		.collect::<Result<Vec<_>, Box<dyn std::error::Error>>>()?;

	protected.push(ProtectedBenchmarkPath {
		category: "official_admission_receipt",
		path: canonical_policy_path(receipt_path)?,
	});

	Ok(protected)
}

/// Builds the deny policy for model-free standalone capability probes.
///
/// The host Codex process must read its executable, credential, and committed
/// toolchain. Probe turns have no tools, so the exact capability and corpus
/// control files are the only model-facing deny policy needed here.
fn standalone_preflight_denied_roots(
	capabilities: &Path,
	corpus_commitment: &Path,
	artifact_root: &Path,
	model_toolchain_root: &Path,
) -> Result<Vec<PathBuf>, Box<dyn std::error::Error>> {
	let protected_paths =
		[("capabilities", capabilities), ("corpus_commitment", corpus_commitment)]
			.into_iter()
			.map(|(category, path)| {
				Ok(ProtectedBenchmarkPath { category, path: canonical_policy_path(path)? })
			})
			.collect::<Result<Vec<_>, Box<dyn std::error::Error>>>()?;

	isolation::validate_protected_layout(
		&protected_paths,
		Some(artifact_root),
		&[model_toolchain_root.to_owned()],
	)?;

	benchmark_denied_roots(&protected_paths)
}

fn benchmark_denied_roots(
	protected_paths: &[ProtectedBenchmarkPath],
) -> Result<Vec<PathBuf>, Box<dyn std::error::Error>> {
	let mut roots = protected_paths.iter().map(|entry| entry.path.clone()).collect::<Vec<_>>();

	roots.sort();
	roots.dedup();

	if roots.is_empty() {
		return Err("benchmark execution has no explicit denied roots".into());
	}

	Ok(roots)
}

fn canonical_policy_path(path: &Path) -> Result<PathBuf, Box<dyn std::error::Error>> {
	match fs::canonicalize(path) {
		Ok(path) => Ok(path),
		Err(error) if error.kind() == ErrorKind::NotFound => {
			let name = path.file_name().ok_or("protected policy path has no file name")?;
			let parent = path
				.parent()
				.filter(|parent| !parent.as_os_str().is_empty())
				.unwrap_or(Path::new("."));
			let parent = fs::canonicalize(parent)?;

			Ok(parent.join(name))
		},
		Err(error) => Err(error.into()),
	}
}

fn canonical_leaf_policy_path(path: &Path) -> Result<PathBuf, Box<dyn std::error::Error>> {
	let name = path.file_name().ok_or("protected policy path has no file name")?;
	let parent =
		path.parent().filter(|parent| !parent.as_os_str().is_empty()).unwrap_or(Path::new("."));
	let path = fs::canonicalize(parent)?.join(name);

	match fs::symlink_metadata(&path) {
		Ok(metadata) if metadata.file_type().is_symlink() => {
			Err("protected policy path must not be a symlink".into())
		},
		Ok(_) => Ok(path),
		Err(error) if error.kind() == ErrorKind::NotFound => Ok(path),
		Err(error) => Err(error.into()),
	}
}

fn verify_codex_permission_boundary<E, S>(
	adapter: &CodexAdapter<E, S>,
	probe_parent: &Path,
	protected_paths: &[ProtectedBenchmarkPath],
) -> Result<String, Box<dyn std::error::Error>>
where
	E: Executor,
	S: ArtifactSink,
{
	let probe_parent = fs::canonicalize(probe_parent)?;
	let mut denied_canaries = PermissionProbeCanaries::prepare(protected_paths)?;
	let mut probe_root = None;

	for nonce in 0_u8..16 {
		let candidate = probe_parent.join(format!(
			".permission-probe-{}-{}-{nonce}",
			process::id(),
			resume::unix_ms()
		));

		match fs::create_dir(&candidate) {
			Ok(()) => {
				probe_root = Some(candidate);

				break;
			},
			Err(error) if error.kind() == ErrorKind::AlreadyExists => {},
			Err(error) => return Err(error.into()),
		}
	}

	let probe_root = probe_root.ok_or("cannot allocate a unique permission-probe directory")?;
	let probe_result = (|| -> Result<String, Box<dyn std::error::Error>> {
		#[cfg(unix)]
		fs::set_permissions(&probe_root, Permissions::from_mode(0o700))?;

		let workspace = probe_root.join("workspace");

		fs::create_dir(&workspace)?;
		#[cfg(unix)]
		fs::set_permissions(&workspace, Permissions::from_mode(0o700))?;

		let allowed_file = workspace.join("allowed.txt");
		let writable_file = workspace.join("writable.txt");
		let mut options = OpenOptions::new();

		options.write(true).create_new(true);

		#[cfg(unix)]
		OpenOptionsExt::mode(&mut options, 0o600);

		let mut file = options.open(&allowed_file)?;

		file.write_all(b"AIQ_ALLOWED\nAIQ_RG_OK\n")?;
		file.sync_all()?;
		adapter.verify_permission_boundary(
			&workspace,
			&allowed_file,
			&denied_canaries.paths,
			&writable_file,
		)?;

		denied_canaries.evidence_digest()
	})();
	let cleanup_result = fs::remove_dir_all(&probe_root);
	let denied_cleanup_result = denied_canaries.cleanup();

	match (probe_result, cleanup_result, denied_cleanup_result) {
		(Ok(digest), Ok(()), Ok(())) => Ok(digest),
		(Err(error), _, _) => Err(error),
		(Ok(_), Err(error), _) => {
			Err(format!("cannot remove completed permission-probe directory: {error}").into())
		},
		(Ok(_), Ok(()), Err(error)) => Err(error),
	}
}

fn permission_canary_evidence_digest(
	bindings: &[(&'static str, String, &'static str)],
) -> Result<String, Box<dyn std::error::Error>> {
	Ok(protocol::canonical_hash(&(
		"aiq.permission-canary-evidence.v2",
		bindings,
		"filesystem_network_and_toolchain_executables_passed",
	))?)
}

fn path_digest(path: &Path) -> Result<String, Box<dyn std::error::Error>> {
	let path = canonical_policy_path(path)?;
	let path = path.to_str().ok_or("permission canary path is not valid UTF-8")?;

	Ok(protocol::canonical_hash(&("aiq.permission-canary-path.v1", path))?)
}

fn create_permission_probe_file_in(root: &Path, index: usize) -> Result<PathBuf, std::io::Error> {
	for nonce in 0_u8..16 {
		let path = root.join(format!(
			".aiq-denied-canary-{}-{}-{index}-{nonce}",
			process::id(),
			resume::unix_ms()
		));

		match create_permission_probe_file(&path) {
			Ok(path) => return Ok(path),
			Err(error) if error.kind() == ErrorKind::AlreadyExists => {},
			Err(error) => return Err(error),
		}
	}

	Err(std::io::Error::new(
		ErrorKind::AlreadyExists,
		format!("cannot allocate a unique denied canary below {}", root.display()),
	))
}

fn create_permission_probe_file(path: &Path) -> Result<PathBuf, std::io::Error> {
	let mut options = OpenOptions::new();

	options.write(true).create_new(true);

	#[cfg(unix)]
	OpenOptionsExt::mode(&mut options, 0o600);

	let mut file = options.open(path)?;

	file.write_all(b"AIQ_DENIED\n")?;
	file.sync_all()?;

	Ok(path.to_owned())
}

fn find_regular_probe_file(root: &Path) -> Result<PathBuf, Box<dyn std::error::Error>> {
	let mut pending = vec![(root.to_owned(), 0_u8)];
	let mut inspected = 0_usize;

	while let Some((directory, depth)) = pending.pop() {
		let mut entries = fs::read_dir(&directory)?
			.collect::<Result<Vec<_>, _>>()?
			.into_iter()
			.map(|entry| entry.path())
			.collect::<Vec<_>>();

		entries.sort();

		for path in entries {
			inspected = inspected.checked_add(1).ok_or("permission-probe traversal overflow")?;

			if inspected > 4_096 {
				return Err("permission-probe traversal exceeded 4,096 entries".into());
			}

			let metadata = fs::symlink_metadata(&path)?;

			if metadata.file_type().is_symlink() {
				continue;
			}
			if metadata.is_file() {
				return Ok(fs::canonicalize(path)?);
			}
			if metadata.is_dir() && depth < 8 {
				pending.push((path, depth + 1));
			}
		}
	}

	Err(format!("denied root has no regular file: {}", root.display()).into())
}

fn load_run_preflight<E, S>(
	adapter: &CodexAdapter<E, S>,
	manifest: &CapabilityManifest,
	options: &RunOptions,
	force_refresh: bool,
	model_toolchain_digest: &str,
	official_admission_digest: Option<&str>,
) -> Result<PreflightCache, Box<dyn std::error::Error>>
where
	E: Executor,
	S: ArtifactSink,
{
	let now_unix_ms = resume::unix_ms();

	if !force_refresh && options.preflight_cache.exists() {
		let cache = PreflightCache::load(
			&options.preflight_cache,
			manifest,
			now_unix_ms,
			model_toolchain_digest,
		)?;

		if cache.official_admission_digest.as_deref() != official_admission_digest {
			return Err("cached preflight is not bound to this exact Official admission".into());
		}

		return Ok(cache);
	}

	let expires_unix_ms = now_unix_ms
		.checked_add(
			options.preflight_ttl_seconds.checked_mul(1_000).ok_or("preflight expiry overflows")?,
		)
		.ok_or("preflight expiry overflows")?;
	let report = adapter.validate_capabilities(manifest);

	persist_completed_preflight(
		&options.preflight_cache,
		manifest,
		report,
		now_unix_ms,
		expires_unix_ms,
		model_toolchain_digest,
		official_admission_digest,
	)
}

fn persist_completed_preflight(
	cache_path: &Path,
	manifest: &CapabilityManifest,
	report: CapabilityValidationReport,
	observed_unix_ms: u64,
	expires_unix_ms: u64,
	model_toolchain_digest: &str,
	official_admission_digest: Option<&str>,
) -> Result<PreflightCache, Box<dyn std::error::Error>> {
	let diagnostic_path = resume::preflight_attempt_path(cache_path);
	let attempt = PreflightAttempt::new(
		manifest,
		report,
		observed_unix_ms,
		expires_unix_ms,
		model_toolchain_digest,
	)?;

	attempt.persist(&diagnostic_path)?;

	if !attempt.reusable {
		return Err(format!(
			"preflight is unavailable; diagnostic written to {}",
			diagnostic_path.display()
		)
		.into());
	}

	let mut cache =
		PreflightCache::new(manifest, attempt.report, expires_unix_ms, model_toolchain_digest)?;

	if let Some(digest) = official_admission_digest {
		cache = cache.bind_official_admission(digest)?;
	}

	cache.persist(cache_path).map_err(|error| {
		format!("{error}; completed preflight diagnostic written to {}", diagnostic_path.display())
	})?;

	Ok(cache)
}

fn select_tasks(
	tasks: &[TaskDefinition],
	selectors: &[String],
) -> Result<Vec<TaskDefinition>, Box<dyn std::error::Error>> {
	if selectors.is_empty() {
		return Ok(tasks.to_vec());
	}

	let requested = selectors.iter().cloned().collect::<BTreeSet<_>>();

	if requested.len() != selectors.len() {
		return Err("task selectors must be unique".into());
	}

	let selected =
		tasks.iter().filter(|task| requested.contains(&task.task_id)).cloned().collect::<Vec<_>>();
	let found = selected.iter().map(|task| task.task_id.clone()).collect::<BTreeSet<_>>();

	if found != requested {
		return Err("one or more task selectors do not match a controlled task".into());
	}

	Ok(selected)
}

fn select_models(selectors: &[String]) -> Result<Vec<ModelConfig>, Box<dyn std::error::Error>> {
	if selectors.is_empty() {
		return Ok(MODEL_MATRIX.to_vec());
	}

	let requested = selectors.iter().cloned().collect::<BTreeSet<_>>();

	if requested.len() != selectors.len() {
		return Err("model selectors must be unique".into());
	}

	let selected = MODEL_MATRIX
		.into_iter()
		.filter(|model| requested.contains(&model.key()))
		.collect::<Vec<_>>();
	let found = selected.iter().map(|model| model.key()).collect::<BTreeSet<_>>();

	if found != requested {
		return Err("one or more model selectors do not match the exact matrix".into());
	}

	Ok(selected)
}

fn validate_official_postrun_paths(
	run: &RunRecord,
	run_path: &Path,
	output: &Path,
	official_admission: Option<&Path>,
	kind: OfficialPostrunOutput,
) -> Result<(), Box<dyn std::error::Error>> {
	if run.synthetic {
		if official_admission.is_some() {
			return Err("synthetic output must not consume an Official admission receipt".into());
		}

		return Ok(());
	}

	let path = official_admission
		.ok_or("real Official score and package commands require --official-admission")?;
	let (receipt, _) = read_successful_official_admission(path)?;
	let plan = receipt.plan.as_ref().ok_or("Official admission receipt omits its plan")?;
	let expected_output = match kind {
		OfficialPostrunOutput::Score => &plan.outputs.score_output,
		OfficialPostrunOutput::Package => &plan.outputs.package_output,
	};

	if run.run_id != plan.run_id
		|| canonical_policy_path(run_path)?.display().to_string() != plan.outputs.run_output
		|| canonical_policy_path(output)?.display().to_string() != *expected_output
		|| run.execution_concurrency.is_some_and(|jobs| jobs != plan.jobs)
	{
		return Err(
			"saved run or protected output does not match the exact Official admission receipt"
				.into(),
		);
	}

	Ok(())
}

fn run_score(
	public_tasks: Option<PathBuf>,
	hidden_tasks: Option<PathBuf>,
	results: PathBuf,
	bootstrap_samples: usize,
	bootstrap_seed: u64,
	output: PathBuf,
	official_admission: Option<&Path>,
) -> Result<(), Box<dyn std::error::Error>> {
	if output != Path::new("-") {
		validate_new_output_set(&[("score output", &output)])?;
	}

	let report = load_tasks(public_tasks.as_deref(), hidden_tasks.as_deref())?;

	if !report.issues.is_empty() {
		write_task_validation_report(&report, public_tasks.as_deref(), hidden_tasks.as_deref())?;

		return Err("task validation failed".into());
	}

	let value = read_json::<serde_json::Value>(&results)?;
	let schema = value.get("schema_version").and_then(serde_json::Value::as_str);
	let options = ScoreOptions { bootstrap_samples, bootstrap_seed };

	match schema {
		Some(RUN_SCHEMA_VERSION) => {
			let run: RunRecord = serde_json::from_value(value)?;

			validate_official_postrun_paths(
				&run,
				&results,
				&output,
				official_admission,
				OfficialPostrunOutput::Score,
			)?;

			aiq_runner::run_validation::validate_run_record(&run, Some(&report.tasks))?;

			let scores = score_all(&report.tasks, &run, options)?;

			write_json(
				&output,
				&ScoreBundle {
					schema_version: "aiq.score-bundle.v1".to_owned(),
					synthetic: run.synthetic,
					scores,
				},
			)
		},
		Some(CALIBRATION_RUN_SCHEMA_VERSION) => {
			if official_admission.is_some() {
				return Err(
					"calibration scoring must not consume an Official admission receipt".into()
				);
			}

			let run: CalibrationRunRecord = serde_json::from_value(value)?;
			let selected_tasks = select_tasks(&report.tasks, &run.task_ids)?;

			aiq_runner::run_validation::validate_calibration_run_record_with_tasks(
				&run,
				&selected_tasks,
			)?;

			let scores = score_calibration(&selected_tasks, &run, options)?;

			write_json(
				&output,
				&CalibrationScoreBundle {
					schema_version: "aiq.calibration-score-bundle.v1",
					run_class: "calibration",
					official_eligible: FalseOnly,
					ranking_eligible: FalseOnly,
					scores,
				},
			)
		},
		_ => Err("results schema is missing or unsupported for scoring".into()),
	}
}

fn run_normalize_command(command: Command) -> Result<(), Box<dyn std::error::Error>> {
	let Command::Normalize {
		public_tasks,
		hidden_tasks,
		synthetic_demo_tasks,
		package,
		scores,
		metadata,
		verifier_signing_key_env,
		observed_unix_ms,
		replay_status,
		stage_output,
		attestation_output,
	} = command
	else {
		unreachable!("normalize dispatch only passes the normalize command");
	};

	run_normalize(
		public_tasks.as_deref(),
		hidden_tasks.as_deref(),
		synthetic_demo_tasks,
		&package,
		&scores,
		&metadata,
		&verifier_signing_key_env,
		observed_unix_ms,
		replay_status.into(),
		&stage_output,
		&attestation_output,
	)
}

#[allow(clippy::too_many_arguments)]
fn run_normalize(
	public_tasks: Option<&Path>,
	hidden_tasks: Option<&Path>,
	use_synthetic_demo_tasks: bool,
	package_path: &Path,
	scores_path: &Path,
	metadata_path: &Path,
	verifier_signing_key_env: &str,
	observed_unix_ms: u64,
	replay_status: ReplayStatus,
	stage_output: &Path,
	attestation_output: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
	validate_new_output_set(&[
		("normalized stage", stage_output),
		("verifier attestation", attestation_output),
	])?;

	if replay_status == ReplayStatus::EvaluatorReplayed {
		return Err("aiq-runner cannot produce evaluator_replayed attestations; use aiq-verifier after actual evaluator replay".into());
	}

	let report = if use_synthetic_demo_tasks {
		TaskLoadReport { tasks: runner::synthetic_demo_tasks(), issues: Vec::new() }
	} else {
		load_tasks(public_tasks, hidden_tasks)?
	};

	if !report.issues.is_empty() {
		write_task_validation_report(&report, public_tasks, hidden_tasks)?;

		return Err("task validation failed".into());
	}

	let package_bytes = fs::read(package_path)?;

	if package_bytes.len() > MAX_SUBMISSION_BYTES {
		return Err("signed package exceeds the 4 MiB submission limit".into());
	}

	let envelope: SubmissionEnvelope = serde_json::from_slice(&package_bytes)?;
	let verified = envelope.verify(&BTreeSet::new())?;
	let run: RunRecord = serde_json::from_value(verified.payload)?;

	aiq_runner::run_validation::validate_run_record(&run, Some(&report.tasks))?;
	submission::validate_run_signer_binding(&run, &verified.signer.node_id)?;

	let score_bundle = read_json::<ScoreBundle>(scores_path)?;

	if score_bundle.schema_version != "aiq.score-bundle.v1"
		|| score_bundle.synthetic != run.synthetic
	{
		return Err("score bundle schema or synthetic policy does not match the signed run".into());
	}

	let metadata = read_json::<AttestedDeploymentMetadata>(metadata_path)?;
	let package_identity = VerifiedPackageIdentity {
		package_sha256: hex::encode(Sha256::digest(&package_bytes)),
		content_hash: verified.content_hash,
		signer: verified.signer,
	};
	let stage = normalization::normalize_verified_batch(
		&run,
		&report.tasks,
		&score_bundle.scores,
		&package_identity,
		&metadata,
	)?;
	let secret = signing_secret_from_environment(verifier_signing_key_env)?;
	let verifier = VerifierSigningIdentity::from_secret(secret);
	let attestation = verifier.attest(&stage, observed_unix_ms, replay_status)?;

	attestation.verify(&stage, verifier.node())?;

	write_json(stage_output, &stage)?;
	write_json(attestation_output, &attestation)?;

	Ok(())
}

fn run_package(
	run_path: &Path,
	artifact_root: &Path,
	signing_key_env: &str,
	execution_concurrency: Option<usize>,
	output: &Path,
	official_admission: Option<&Path>,
) -> Result<(), Box<dyn std::error::Error>> {
	validate_new_output_set(&[("signed package output", output)])?;

	let secret = signing_secret_from_environment(signing_key_env)?;
	let identity = SigningIdentity::from_secret(secret);
	let value = read_json::<serde_json::Value>(run_path)?;
	let schema = value.get("schema_version").and_then(serde_json::Value::as_str);
	let package = match schema {
		Some(schema) if schema == RUN_SCHEMA_VERSION => {
			let mut run: RunRecord = serde_json::from_value(value)?;

			validate_official_postrun_paths(
				&run,
				run_path,
				output,
				official_admission,
				OfficialPostrunOutput::Package,
			)?;

			aiq_runner::run_validation::validate_run_record(&run, None)?;

			if !run.synthetic {
				bind_execution_concurrency(&mut run.execution_concurrency, execution_concurrency)?;
				validate_official_postrun_paths(
					&run,
					run_path,
					output,
					official_admission,
					OfficialPostrunOutput::Package,
				)?;
			}

			aiq_runner::run_validation::validate_run_record(&run, None)?;

			let evaluator_results = submission::read_evaluator_results_artifact(
				artifact_root,
				&run.evaluator_results_artifact,
			)?;

			aiq_runner::run_validation::validate_evaluator_results_bundle(
				&run,
				&evaluator_results,
			)?;

			if run.synthetic {
				submission::bind_synthetic_run_to_signer(&mut run, &identity.node().node_id)?;
				aiq_runner::run_validation::validate_run_record(&run, None)?;
			} else if run
				.capability_validation
				.as_ref()
				.is_none_or(|report| report.node_id != identity.node().node_id)
			{
				return Err("signing key node_id does not match the run preflight node_id".into());
			}

			let envelope =
				identity.sign(&run.run_id, RUN_PAYLOAD_TYPE, &run, TrustTier::Untrusted)?;

			submission::serialize_signed_package(&envelope)?
		},
		Some(schema) if schema == CALIBRATION_RUN_SCHEMA_VERSION => {
			if official_admission.is_some() {
				return Err(
					"calibration packaging must not consume an Official admission receipt".into()
				);
			}

			let mut run: CalibrationRunRecord = serde_json::from_value(value)?;

			aiq_runner::run_validation::validate_calibration_run_record(&run)?;

			bind_execution_concurrency(&mut run.execution_concurrency, execution_concurrency)?;

			aiq_runner::run_validation::validate_calibration_run_record(&run)?;

			let evaluator_results = submission::read_evaluator_results_artifact(
				artifact_root,
				&run.evaluator_results_artifact,
			)?;

			aiq_runner::run_validation::validate_calibration_evaluator_results_bundle(
				&run,
				&evaluator_results,
			)?;

			if run.capability_validation.node_id != identity.node().node_id {
				return Err(
					"signing key node_id does not match the calibration preflight node_id".into()
				);
			}

			let envelope = identity.sign(
				&run.run_id,
				CALIBRATION_RUN_PAYLOAD_TYPE,
				&run,
				TrustTier::Untrusted,
			)?;

			submission::serialize_signed_package(&envelope)?
		},
		_ => return Err("run schema is unsupported for packaging".into()),
	};

	if output == Path::new("-") {
		print!("{}", String::from_utf8(package)?);
	} else {
		fs::write(output, package)?;
	}

	Ok(())
}

fn bind_execution_concurrency(
	existing: &mut Option<usize>,
	declared: Option<usize>,
) -> Result<(), Box<dyn std::error::Error>> {
	match (*existing, declared) {
		(Some(recorded), Some(declared)) if recorded != declared => {
			Err("declared execution concurrency differs from the saved run".into())
		},
		(Some(_), _) => Ok(()),
		(None, Some(declared)) if (1..=MAX_RUN_JOBS).contains(&declared) => {
			*existing = Some(declared);

			Ok(())
		},
		_ => Err("real run packaging requires a bound execution concurrency".into()),
	}
}

fn signing_secret_from_environment(name: &str) -> Result<[u8; 32], Box<dyn std::error::Error>> {
	let secret =
		env::var(name).map_err(|_| format!("signing key environment variable {name} is unset"))?;

	if secret.len() != 64
		|| !secret.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
	{
		return Err("signing key must contain 64 lowercase hexadecimal characters".into());
	}

	hex::decode(secret)?.try_into().map_err(|_| "signing key must encode exactly 32 bytes".into())
}

fn run_submit(
	package: &Path,
	artifact_root: &Path,
	endpoint: &str,
	token_env: &str,
	timeout_seconds: u64,
	artifact_upload_concurrency: usize,
	allow_loopback_http: bool,
) -> Result<(), Box<dyn std::error::Error>> {
	let token = env::var(token_env)
		.map_err(|_| format!("submission token environment variable {token_env} is unset"))?;
	let transport = HttpsTransport::new(Duration::from_secs(timeout_seconds), allow_loopback_http);
	let package = fs::read(package)?;
	let token = SecretToken::new(token)?;
	let outcome = if allow_loopback_http {
		submission::submit_signed_package_with_artifacts_concurrently_allowing_loopback(
			&transport,
			endpoint,
			package,
			artifact_root,
			token,
			artifact_upload_concurrency,
		)?
	} else {
		submission::submit_signed_package_with_artifacts_concurrently(
			&transport,
			endpoint,
			package,
			artifact_root,
			token,
			artifact_upload_concurrency,
		)?
	};

	write_json(Path::new("-"), &outcome)?;

	require_successful_package_submission(&outcome)
}

fn require_successful_package_submission(
	outcome: &SubmissionBundleOutcome,
) -> Result<(), Box<dyn std::error::Error>> {
	if outcome.package.kind.is_success() {
		return Ok(());
	}

	let status = outcome.package.status.map_or_else(
		|| "without an HTTP status".to_owned(),
		|status| format!("with HTTP {status}"),
	);

	Err(format!("package submission failed with {} {status}", outcome.package.kind.as_str()).into())
}

fn parse_artifact_upload_concurrency(value: &str) -> Result<usize, String> {
	let concurrency = value
		.parse::<usize>()
		.map_err(|_| "artifact upload concurrency must be a positive integer".to_owned())?;

	if (1..=MAX_ARTIFACT_UPLOAD_CONCURRENCY).contains(&concurrency) {
		Ok(concurrency)
	} else {
		Err(format!(
			"artifact upload concurrency must be between 1 and {MAX_ARTIFACT_UPLOAD_CONCURRENCY}"
		))
	}
}

fn run_demo(
	slot_date: &str,
	occurrence: &str,
	bootstrap_samples: usize,
	artifact_root: &Path,
	outputs: DemoOutputs<'_>,
) -> Result<(), Box<dyn std::error::Error>> {
	let occurrence = ScheduleOccurrence::from_str(occurrence)?;
	let slot = ScheduleConfig::default().slot(slot_date, occurrence)?;
	let scheduled_unix_ms = slot.scheduled_unix_ms()?;
	let artifact_sink = LocalArtifactSink::new(artifact_root)?;
	let run = runner::synthetic_demo(slot, &artifact_sink)?;
	let tasks = runner::synthetic_demo_tasks();

	aiq_runner::run_validation::validate_run_record(&run, Some(&tasks))?;

	let scores = score_all(
		&tasks,
		&run,
		ScoreOptions { bootstrap_samples, bootstrap_seed: 0x41_49_51_5f_56_31 },
	)?;

	if let Some(path) = outputs.run {
		write_json(path, &run)?;
	}
	if let Some(path) = outputs.scores {
		write_json(
			path,
			&ScoreBundle {
				schema_version: "aiq.score-bundle.v1".to_owned(),
				synthetic: true,
				scores: scores.clone(),
			},
		)?;
	}
	if let Some(path) = outputs.metadata {
		write_json(
			path,
			&AttestedDeploymentMetadata {
				task_set_id: AIQ_TASK_SET_ID.to_owned(),
				task_set_version: AIQ_TASK_SET_VERSION.to_owned(),
				benchmark_version: AIQ_BENCHMARK_VERSION.to_owned(),
				prompt_set_digest: run.task_set_hash.clone(),
				runner_commit: "0000000000000000000000000000000000000000".to_owned(),
				region: "local-synthetic".to_owned(),
				scheduled_unix_ms,
				started_unix_ms: run.started_unix_ms,
				finished_unix_ms: run.finished_unix_ms,
				synthetic_test: true,
			},
		)?;
	}

	write_json(
		outputs.package,
		&DemoBundle {
			schema_version: "aiq.synthetic-demo.v1",
			synthetic: true,
			disclaimer: "Synthetic demonstration only. Codex was not invoked, and these are not real model results.",
			run,
			scores,
		},
	)?;

	Ok(())
}

fn load_tasks(
	public_tasks: Option<&Path>,
	hidden_tasks: Option<&Path>,
) -> Result<TaskLoadReport, Box<dyn std::error::Error>> {
	if public_tasks.is_none() && hidden_tasks.is_none() {
		return Err("provide --public-tasks, --hidden-tasks, or both".into());
	}

	let mut combined = TaskLoadReport::default();

	for (path, visibility) in
		[(public_tasks, Visibility::PublicExample), (hidden_tasks, Visibility::Hidden)]
	{
		if let Some(path) = path {
			let mut report = DirectoryTaskSource::new(path, Some(visibility)).load();

			combined.tasks.append(&mut report.tasks);
			combined.issues.append(&mut report.issues);
		}
	}

	combined.tasks.sort_by(|left, right| left.task_id.cmp(&right.task_id));

	ensure_unique_task_ids(&mut combined);

	Ok(combined)
}

fn ensure_unique_task_ids(report: &mut TaskLoadReport) {
	let mut task_ids = BTreeSet::new();
	let mut duplicate_found = false;

	report.tasks.retain(|task| {
		let unique = task_ids.insert(task.task_id.clone());

		duplicate_found |= !unique;

		unique
	});

	if duplicate_found {
		report.issues.push(TaskLoadIssue {
			source: "merged_task_sources".to_owned(),
			issue: ValidationIssue {
				code: "duplicate_task".to_owned(),
				field: Some("task_id".to_owned()),
				message: "task_id must be unique across merged task sources".to_owned(),
			},
		});
	}
}

fn score_all(
	tasks: &[TaskDefinition],
	run: &RunRecord,
	options: ScoreOptions,
) -> Result<Vec<ScoreReport>, Box<dyn std::error::Error>> {
	MODEL_MATRIX
		.into_iter()
		.map(|model| {
			let preflight_configuration_not_applicable =
				run.capability_validation.as_ref().is_some_and(|validation| {
					validation.manifest_issues.is_empty()
						&& validation.cli_probe.status == ProbeStatus::Available
						&& validation.model(model).is_some_and(|entry| {
							entry.status == CapabilityValidationStatus::Unsupported
								&& entry.probe.status
									== ConfigurationProbeStatus::ObservedUnsupported
						})
				});

			scoring::score_model_with_context(
				tasks,
				&run.results,
				model,
				ScoreContext {
					preflight_configuration_not_applicable,
					receiver_authorized_publication: false,
				},
				options,
			)
			.map_err(|error| -> Box<dyn std::error::Error> { Box::new(error) })
		})
		.collect()
}

fn score_calibration(
	tasks: &[TaskDefinition],
	run: &CalibrationRunRecord,
	options: ScoreOptions,
) -> Result<Vec<CalibrationScoreReport>, Box<dyn std::error::Error>> {
	run.models
		.iter()
		.copied()
		.map(|model| {
			let preflight_configuration_not_applicable =
				run.capability_validation.model(model).is_some_and(|entry| {
					run.capability_validation.manifest_issues.is_empty()
						&& run.capability_validation.cli_probe.status == ProbeStatus::Available
						&& entry.status == CapabilityValidationStatus::Unsupported
						&& entry.probe.status == ConfigurationProbeStatus::ObservedUnsupported
				});

			scoring::score_calibration_model_with_context(
				tasks,
				&run.results,
				model,
				ScoreContext {
					preflight_configuration_not_applicable,
					receiver_authorized_publication: false,
				},
				options,
			)
			.map_err(|error| -> Box<dyn std::error::Error> { Box::new(error) })
		})
		.collect()
}

fn read_json<T>(path: &Path) -> Result<T, Box<dyn std::error::Error>>
where
	T: DeserializeOwned,
{
	let bytes = fs::read(path)?;

	Ok(serde_json::from_slice(&bytes)?)
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<(), Box<dyn std::error::Error>> {
	let mut bytes = serde_json::to_vec_pretty(value)?;

	bytes.push(b'\n');

	if path == Path::new("-") {
		io::stdout().lock().write_all(&bytes)?;
	} else {
		let path = canonical_leaf_policy_path(path)?;
		let parent = path.parent().ok_or("protected JSON output has no parent")?;
		let directory_lock = FutureProtectedDirectoryLock::acquire(parent)?;

		write_new_bytes(&path, &bytes, "protected JSON")?;

		directory_lock.verify()?;
	}

	Ok(())
}

fn validate_new_output_set(outputs: &[(&str, &Path)]) -> Result<(), Box<dyn std::error::Error>> {
	let mut paths = BTreeSet::new();

	for (label, path) in outputs {
		if *path == Path::new("-") {
			return Err(format!("{label} requires a durable create-new path").into());
		}

		let path = canonical_policy_path(path)?;

		if !paths.insert(path.clone()) {
			return Err("protected outputs must use distinct paths".into());
		}

		match fs::symlink_metadata(&path) {
			Err(error) if error.kind() == ErrorKind::NotFound => {},
			Err(error) => return Err(error.into()),
			Ok(metadata) if metadata.file_type().is_symlink() => {
				return Err(format!("{label} must not be a symlink").into());
			},
			Ok(_) => return Err(format!("{label} must not already exist").into()),
		}
	}

	Ok(())
}

fn write_private_json_receipt(
	path: &Path,
	value: &impl Serialize,
) -> Result<(), Box<dyn std::error::Error>> {
	let path = canonical_leaf_policy_path(path)?;
	let parent = path.parent().ok_or("permission admission report has no parent")?;
	let directory_lock = FutureProtectedDirectoryLock::acquire(parent)?;
	let mut bytes = serde_json::to_vec_pretty(value)?;

	bytes.push(b'\n');

	let file = write_new_bytes(&path, &bytes, "permission admission report")?;

	#[cfg(unix)]
	{
		let metadata = file.metadata()?;

		if metadata.permissions().mode() & 0o777 != 0o600 {
			return Err("permission admission report must have mode 0600".into());
		}
	}

	directory_lock.verify()?;

	Ok(())
}

fn official_output_reservation(run_id: &str) -> Vec<u8> {
	format!("AIQ_OFFICIAL_OUTPUT_RESERVED_V1 {run_id}\n").into_bytes()
}

fn calibration_output_reservation(run_id: &str) -> Vec<u8> {
	format!("AIQ_CALIBRATION_OUTPUT_RESERVED_V1 {run_id}\n").into_bytes()
}

fn has_exact_official_output_reservation(path: &Path, run_id: &str) -> bool {
	let expected = official_output_reservation(run_id);

	open_exact_reserved_file(path, &expected, "Official output reservation").is_ok()
}

fn open_exact_reserved_file(
	path: &Path,
	expected_bytes: &[u8],
	label: &str,
) -> Result<File, Box<dyn std::error::Error>> {
	let metadata =
		fs::symlink_metadata(path).map_err(|error| format!("cannot inspect {label}: {error}"))?;

	if metadata.file_type().is_symlink() || !metadata.is_file() {
		return Err(format!("{label} must be a non-symlink regular file").into());
	}

	let mut options = OpenOptions::new();

	options.read(true).write(true);
	#[cfg(unix)]
	options.custom_flags(O_NOFOLLOW);

	let file = options.open(path).map_err(|error| format!("cannot open {label}: {error}"))?;

	require_exact_created_file(path, expected_bytes, &file, label)?;

	Ok(file)
}

fn atomically_replace_exact_created_file(
	path: &Path,
	expected_bytes: &[u8],
	created_file: &File,
	bytes: &[u8],
	label: &str,
) -> Result<File, Box<dyn std::error::Error>> {
	require_exact_created_file(path, expected_bytes, created_file, label)?;

	let (temporary_path, temporary_file) = write_unique_sibling_bytes(path, bytes, label)?;
	let install_result = (|| -> Result<(), Box<dyn std::error::Error>> {
		// Fail quickly when the reservation has already changed. The exchange and
		// post-exchange identity check enforce the actual compare-and-swap boundary.
		require_exact_created_file(path, expected_bytes, created_file, label)?;
		install_atomic_exchange(
			path,
			&temporary_path,
			expected_bytes,
			created_file,
			bytes,
			&temporary_file,
			label,
		)?;

		Ok(())
	})();

	if let Err(error) = install_result {
		let _ = remove_created_path_if_identity(&temporary_path, &temporary_file);

		return Err(error);
	}

	Ok(temporary_file)
}

fn install_atomic_exchange(
	path: &Path,
	temporary_path: &Path,
	expected_bytes: &[u8],
	created_file: &File,
	bytes: &[u8],
	temporary_file: &File,
	label: &str,
) -> Result<(), Box<dyn std::error::Error>> {
	atomic_exchange_paths(temporary_path, path)
		.map_err(|error| format!("cannot atomically exchange {label}: {error}"))?;
	sync_parent_directory(path, label)?;

	if let Err(error) =
		require_exact_created_file(temporary_path, expected_bytes, created_file, label)
	{
		let rollback = rollback_atomic_exchange(temporary_path, path, bytes, temporary_file, label);

		return Err(format!(
			"{label} reservation changed during atomic exchange: {error}; rollback: {}",
			rollback
				.map_or_else(|rollback_error| rollback_error.to_string(), |()| "complete".into())
		)
		.into());
	}

	require_exact_created_file(path, bytes, temporary_file, label)?;

	remove_exact_created_file(temporary_path, expected_bytes, created_file, "exchanged reservation")
}

fn rollback_atomic_exchange(
	temporary_path: &Path,
	path: &Path,
	bytes: &[u8],
	temporary_file: &File,
	label: &str,
) -> Result<(), Box<dyn std::error::Error>> {
	atomic_exchange_paths(temporary_path, path)?;
	sync_parent_directory(path, label)?;
	require_exact_created_file(temporary_path, bytes, temporary_file, label)?;

	remove_exact_created_file(temporary_path, bytes, temporary_file, label)
}

#[cfg(unix)]
fn atomic_exchange_paths(left: &Path, right: &Path) -> Result<(), io::Error> {
	let left = CString::new(left.as_os_str().as_bytes())
		.map_err(|_| io::Error::other("exchange path contains a NUL byte"))?;
	let right = CString::new(right.as_os_str().as_bytes())
		.map_err(|_| io::Error::other("exchange path contains a NUL byte"))?;
	#[cfg(target_os = "linux")]
	// SAFETY: both C strings remain live for the call and contain no interior NUL.
	let result = unsafe {
		libc::renameat2(AT_FDCWD, left.as_ptr(), AT_FDCWD, right.as_ptr(), RENAME_EXCHANGE)
	};
	#[cfg(target_vendor = "apple")]
	// SAFETY: both C strings remain live for the call and contain no interior NUL.
	let result = unsafe { libc::renamex_np(left.as_ptr(), right.as_ptr(), RENAME_SWAP) };

	#[cfg(not(any(target_os = "linux", target_vendor = "apple")))]
	{
		return Err(io::Error::new(
			ErrorKind::Unsupported,
			"atomic path exchange is unavailable on this Unix platform",
		));
	}

	#[cfg(any(target_os = "linux", target_vendor = "apple"))]
	if result == 0 { Ok(()) } else { Err(io::Error::last_os_error()) }
}

#[cfg(not(unix))]
fn atomic_exchange_paths(_left: &Path, _right: &Path) -> Result<(), io::Error> {
	Err(io::Error::new(
		ErrorKind::Unsupported,
		"atomic path exchange is unavailable on this platform",
	))
}

#[cfg(unix)]
fn atomic_rename_no_replace(source: &Path, destination: &Path) -> Result<(), io::Error> {
	let source = CString::new(source.as_os_str().as_bytes())
		.map_err(|_| io::Error::other("rename source contains a NUL byte"))?;
	let destination = CString::new(destination.as_os_str().as_bytes())
		.map_err(|_| io::Error::other("rename destination contains a NUL byte"))?;
	#[cfg(target_os = "linux")]
	// SAFETY: both C strings remain live for the call and contain no interior NUL.
	let result = unsafe {
		libc::renameat2(AT_FDCWD, source.as_ptr(), AT_FDCWD, destination.as_ptr(), RENAME_NOREPLACE)
	};
	#[cfg(target_vendor = "apple")]
	// SAFETY: both C strings remain live for the call and contain no interior NUL.
	let result = unsafe { libc::renamex_np(source.as_ptr(), destination.as_ptr(), RENAME_EXCL) };

	#[cfg(not(any(target_os = "linux", target_vendor = "apple")))]
	{
		return Err(io::Error::new(
			ErrorKind::Unsupported,
			"atomic no-replace rename is unavailable on this Unix platform",
		));
	}

	#[cfg(any(target_os = "linux", target_vendor = "apple"))]
	if result == 0 { Ok(()) } else { Err(io::Error::last_os_error()) }
}

#[cfg(not(unix))]
fn atomic_rename_no_replace(_source: &Path, _destination: &Path) -> Result<(), io::Error> {
	Err(io::Error::new(
		ErrorKind::Unsupported,
		"atomic no-replace rename is unavailable on this platform",
	))
}

fn sync_parent_directory(path: &Path, label: &str) -> Result<(), Box<dyn std::error::Error>> {
	let parent = path.parent().ok_or("protected output has no parent")?;

	#[cfg(unix)]
	File::open(parent)?
		.sync_all()
		.map_err(|error| format!("cannot sync {label} directory: {error}"))?;

	Ok(())
}

fn write_unique_sibling_bytes(
	path: &Path,
	bytes: &[u8],
	label: &str,
) -> Result<(PathBuf, File), Box<dyn std::error::Error>> {
	let parent = path.parent().ok_or("protected output has no parent")?;
	let name = path
		.file_name()
		.and_then(|name| name.to_str())
		.ok_or("protected output file name is not valid UTF-8")?;

	for nonce in 0_u8..16 {
		let temporary_path = parent.join(format!(
			".{name}.aiq-finalize-{}-{}-{nonce}",
			process::id(),
			resume::unix_ms()
		));
		let mut options = OpenOptions::new();

		options.read(true).write(true).create_new(true);

		#[cfg(unix)]
		OpenOptionsExt::mode(&mut options, 0o600).custom_flags(O_NOFOLLOW);

		let mut file = match options.open(&temporary_path) {
			Ok(file) => file,
			Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
			Err(error) => {
				return Err(format!("cannot create temporary {label} output: {error}").into());
			},
		};

		#[cfg(unix)]
		if let Err(error) = file.set_permissions(Permissions::from_mode(0o600)) {
			let _ = remove_created_path_if_identity(&temporary_path, &file);

			return Err(format!("cannot set temporary {label} output permissions: {error}").into());
		}

		let write_result = file
			.write_all(bytes)
			.and_then(|()| file.sync_all())
			.map_err(|error| format!("cannot persist temporary {label} output: {error}"));

		if let Err(error) = write_result {
			let _ = remove_created_path_if_identity(&temporary_path, &file);

			return Err(error.into());
		}
		if let Err(error) = require_exact_created_file(&temporary_path, bytes, &file, label) {
			let _ = remove_created_path_if_identity(&temporary_path, &file);

			return Err(error);
		}
		if let Err(error) = sync_parent_directory(&temporary_path, label) {
			let _ = remove_created_path_if_identity(&temporary_path, &file);

			return Err(error);
		}

		return Ok((temporary_path, file));
	}

	Err(format!("cannot allocate a unique temporary {label} output").into())
}

fn remove_created_path_if_identity(path: &Path, created_file: &File) -> Result<(), std::io::Error> {
	let held = created_file.metadata()?;
	let current = fs::symlink_metadata(path)?;

	if current.file_type().is_symlink() || !current.is_file() {
		return Err(std::io::Error::other("created path changed"));
	}
	#[cfg(unix)]
	if held.dev() != current.dev()
		|| held.ino() != current.ino()
		|| held.nlink() != 1
		|| current.nlink() != 1
	{
		return Err(std::io::Error::other("created path identity changed"));
	}
	#[cfg(not(unix))]
	if held.len() != current.len() {
		return Err(std::io::Error::other("created path identity changed"));
	}

	fs::remove_file(path)?;
	#[cfg(unix)]
	File::open(path.parent().ok_or_else(|| io::Error::other("created path has no parent"))?)?
		.sync_all()?;

	Ok(())
}

fn write_new_bytes(
	path: &Path,
	bytes: &[u8],
	label: &str,
) -> Result<File, Box<dyn std::error::Error>> {
	let (temporary_path, file) = write_unique_sibling_bytes(path, bytes, label)?;
	let install_result = (|| -> Result<(), Box<dyn std::error::Error>> {
		atomic_rename_no_replace(&temporary_path, path)
			.map_err(|error| format!("cannot install create-new {label} output: {error}"))?;
		require_exact_created_file(path, bytes, &file, label)?;

		sync_parent_directory(path, label)
	})();

	if let Err(error) = install_result {
		let _ = remove_created_path_if_identity(&temporary_path, &file);

		return Err(error);
	}

	Ok(file)
}

fn remove_exact_created_file(
	path: &Path,
	expected_bytes: &[u8],
	created_file: &File,
	label: &str,
) -> Result<(), Box<dyn std::error::Error>> {
	require_exact_created_file(path, expected_bytes, created_file, label)?;

	fs::remove_file(path)
		.map_err(|error| format!("cannot remove created {label} file: {error}"))?;

	sync_parent_directory(path, label)
}

fn require_exact_created_file(
	path: &Path,
	expected_bytes: &[u8],
	created_file: &File,
	label: &str,
) -> Result<(), Box<dyn std::error::Error>> {
	let created_metadata = created_file
		.metadata()
		.map_err(|error| format!("cannot inspect created {label}: {error}"))?;
	let current_metadata = fs::symlink_metadata(path)
		.map_err(|error| format!("cannot inspect created {label} path: {error}"))?;

	if current_metadata.file_type().is_symlink() || !current_metadata.is_file() {
		return Err(format!("created {label} path changed").into());
	}

	#[cfg(unix)]
	{
		if created_metadata.dev() != current_metadata.dev()
			|| created_metadata.ino() != current_metadata.ino()
		{
			return Err(format!("created {label} file was replaced").into());
		}
		if created_metadata.nlink() != 1 || current_metadata.nlink() != 1 {
			return Err(format!("created {label} file has a hard-link alias").into());
		}
	}

	#[cfg(not(unix))]
	if created_metadata.len() != current_metadata.len() {
		return Err(format!("created {label} file was replaced").into());
	}
	if current_metadata.len() != u64::try_from(expected_bytes.len())?
		|| fs::read(path)? != expected_bytes
	{
		return Err(format!("created {label} file was modified").into());
	}

	Ok(())
}

#[cfg(test)]
mod tests {
	use std::env;
	#[cfg(unix)]
	use std::os::unix::fs::PermissionsExt as _;
	use std::{
		cell::RefCell,
		fs,
		path::{Path, PathBuf},
		process,
		rc::Rc,
		time::{SystemTime, UNIX_EPOCH},
	};

	use clap::Parser as _;

	use crate::capacity;
	use crate::protocol;
	use crate::resume;
	use crate::runner;
	use crate::{
		adapter::{
			CodexAdapter, CodexExecutionConfig, CommandRequest, ExecutionCapture, Executor,
			ExecutorError, ManagedPermissionProfileEvidence,
		},
		cli,
		corpus_commitment::{self, RunClass},
		runner::TestArtifactSink,
	};

	struct BoundaryExecutor {
		requests: Rc<RefCell<Vec<CommandRequest>>>,
	}

	struct SuccessfulBoundaryExecutor {
		requests: Rc<RefCell<Vec<CommandRequest>>>,
	}

	impl Executor for BoundaryExecutor {
		fn execute(&self, request: &CommandRequest) -> Result<ExecutionCapture, ExecutorError> {
			self.requests.borrow_mut().push(request.clone());

			Err(ExecutorError::new("recording profile boundary reached"))
		}
	}

	impl Executor for SuccessfulBoundaryExecutor {
		fn execute(&self, request: &CommandRequest) -> Result<ExecutionCapture, ExecutorError> {
			self.requests.borrow_mut().push(request.clone());

			Ok(ExecutionCapture {
				exit_code: Some(0),
				stdout: b"AIQ_ISOLATION_OK\n".to_vec(),
				stderr: Vec::new(),
				timed_out: false,
				budget_exceeded: None,
				stdout_truncated: false,
				stderr_truncated: false,
			})
		}
	}

	#[test]
	fn official_cli_exposes_no_proxy_mode() {
		let command = <cli::Cli as clap::CommandFactory>::command();

		for subcommand_name in ["admit-permissions", "preflight", "run"] {
			let subcommand =
				command.find_subcommand(subcommand_name).expect("Official direct command");

			assert!(
				subcommand
					.get_arguments()
					.all(|argument| argument.get_id() != "codex_egress_proxy"),
				"{subcommand_name} must not expose a proxy mode"
			);
		}
	}

	fn fixture_root(name: &str) -> PathBuf {
		let suffix =
			SystemTime::now().duration_since(UNIX_EPOCH).expect("fixture clock").as_nanos();
		let repository_root =
			fs::canonicalize(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."))
				.expect("repository root");

		repository_root.join("target").join(format!("aiq-cli-{name}-{}-{suffix}", process::id()))
	}

	#[test]
	fn permission_canary_evidence_digest_commits_to_executable_canary_schema() {
		let bindings = [
			("workspace", "sha256:workspace".to_owned(), "directory"),
			("toolchain", "sha256:toolchain".to_owned(), "directory"),
		];
		let digest = cli::permission_canary_evidence_digest(&bindings)
			.expect("permission canary evidence digest");
		let legacy_digest =
			protocol::canonical_hash(&("aiq.permission-canary-evidence.v1", &bindings, "passed"))
				.expect("legacy permission canary evidence digest");

		assert!(digest.starts_with("sha256:"));
		assert_ne!(digest, legacy_digest);
		assert_eq!(
			digest,
			cli::permission_canary_evidence_digest(&bindings)
				.expect("stable permission canary evidence digest")
		);
	}

	fn expected_path(path: &Path) -> PathBuf {
		cli::canonical_policy_path(path).expect("canonical policy fixture")
	}

	#[test]
	fn corpus_validators_are_top_level_and_legacy_lifecycle_is_absent() {
		let common = [
			"--hidden-tasks",
			"/controlled/tasks",
			"--corpus-commitment",
			"/controlled/corpus.json",
			"--source-root",
			"/controlled/source",
			"--evaluator-root",
			"/controlled/evaluators",
			"--evaluator-runtime",
			"/controlled/bin/node",
			"--codex-toolchain-root",
			"/controlled/toolchain",
		];
		let core = super::Cli::try_parse_from(
			["aiq-runner", "validate-core-corpus"].into_iter().chain(common),
		);

		assert!(matches!(
			core,
			Ok(super::Cli { command: super::Command::ValidateCoreCorpus { .. } })
		));

		let contrast = super::Cli::try_parse_from([
			"aiq-runner",
			"validate-contrast-corpus",
			"--hidden-tasks",
			"/controlled/contrast-tasks",
			"--corpus-commitment",
			"/controlled/contrast-corpus.json",
			"--expected-corpus-sha256",
			"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			"--source-root",
			"/controlled/source",
			"--evaluator-root",
			"/controlled/evaluators",
			"--evaluator-runtime",
			"/controlled/bin/node",
			"--codex-toolchain-root",
			"/controlled/toolchain",
		]);

		assert!(matches!(
			contrast,
			Ok(super::Cli { command: super::Command::ValidateContrastCorpus { .. } })
		));
		assert!(super::Cli::try_parse_from(["aiq-runner", "candidate", "plan"]).is_err());
		assert!(super::Cli::try_parse_from(["aiq-runner", "replay-candidate"]).is_err());
	}

	fn unexpected_managed_requirements_profile() -> ManagedPermissionProfileEvidence {
		ManagedPermissionProfileEvidence {
			schema_version: "aiq.managed-permission-profile-evidence.v1".to_owned(),
			codex_version: "codex-cli 0.146.0".to_owned(),
			default_permissions: "aiq_benchmark".to_owned(),
			allowed_permission_profile: "aiq_benchmark".to_owned(),
			active_permission_profile: "aiq_benchmark".to_owned(),
			official_eligible: false,
			managed_requirements_status: "present_unexpected".to_owned(),
			managed_requirements_digest: format!("sha256:{}", "a".repeat(64)),
			profile_selection_digest: format!("sha256:{}", "b".repeat(64)),
			evidence_digest: format!("sha256:{}", "c".repeat(64)),
		}
	}

	#[test]
	fn package_concurrency_is_explicitly_bound_and_cannot_drift() {
		let mut missing = None;

		super::bind_execution_concurrency(&mut missing, Some(17)).expect("bind frozen run");

		assert_eq!(missing, Some(17));
		assert!(super::bind_execution_concurrency(&mut missing, Some(16)).is_err());

		let mut absent = None;

		assert!(super::bind_execution_concurrency(&mut absent, None).is_err());
		assert!(super::bind_execution_concurrency(&mut absent, Some(0)).is_err());
		assert!(
			super::bind_execution_concurrency(&mut absent, Some(crate::runner::MAX_RUN_JOBS + 1))
				.is_err()
		);
	}

	#[test]
	fn submit_artifact_upload_concurrency_has_a_bounded_default_and_override() {
		let parse = |extra: &[&str]| {
			let mut arguments = vec![
				"aiq-runner",
				"submit",
				"--package",
				"package.json",
				"--endpoint",
				"https://example.vercel.app",
			];

			arguments.extend_from_slice(extra);

			super::Cli::try_parse_from(arguments)
		};
		let default = parse(&[]).expect("default submit arguments");

		assert!(matches!(
			default.command,
			super::Command::Submit {
				artifact_upload_concurrency: crate::submission::DEFAULT_ARTIFACT_UPLOAD_CONCURRENCY,
				..
			}
		));

		let override_value = crate::submission::MAX_ARTIFACT_UPLOAD_CONCURRENCY.to_string();
		let overridden = parse(&["--artifact-upload-concurrency", &override_value])
			.expect("bounded submit override");

		assert!(matches!(
			overridden.command,
			super::Command::Submit {
				artifact_upload_concurrency: crate::submission::MAX_ARTIFACT_UPLOAD_CONCURRENCY,
				..
			}
		));
		assert!(parse(&["--artifact-upload-concurrency", "0"]).is_err());
		assert!(parse(&["--artifact-upload-concurrency", "33"]).is_err());
	}

	#[test]
	fn submit_cli_succeeds_only_for_accepted_or_exact_duplicate_packages() {
		let outcome = |kind, status| crate::submission::SubmissionBundleOutcome {
			schema_version: "aiq.submission-outcome.v1",
			artifacts_total: 1,
			artifacts_stored: 1,
			artifacts_duplicate: 0,
			package: crate::submission::SubmissionOutcome {
				kind,
				status,
				server_disposition: "untrusted response body highly-secret".to_owned(),
			},
		};

		for kind in [
			crate::submission::SubmissionOutcomeKind::Accepted,
			crate::submission::SubmissionOutcomeKind::Duplicate,
		] {
			assert!(
				super::require_successful_package_submission(&outcome(kind, Some(202))).is_ok()
			);
		}
		for (kind, status) in [
			(crate::submission::SubmissionOutcomeKind::Conflict, Some(409)),
			(crate::submission::SubmissionOutcomeKind::ClientError, Some(422)),
			(crate::submission::SubmissionOutcomeKind::ServerError, Some(503)),
			(crate::submission::SubmissionOutcomeKind::Network, None),
			(crate::submission::SubmissionOutcomeKind::Timeout, None),
			(crate::submission::SubmissionOutcomeKind::Configuration, None),
		] {
			let error = super::require_successful_package_submission(&outcome(kind, status))
				.expect_err("non-queue outcome must make submit fail");
			let diagnostic = error.to_string();

			assert!(diagnostic.contains(kind.as_str()));
			assert!(!diagnostic.contains("untrusted response body"));
			assert!(!diagnostic.contains("highly-secret"));
		}
	}

	#[test]
	fn invalid_official_planning_inputs_stop_with_zero_adapter_invocations() {
		let root = fixture_root("model-free-official-rejections");
		let source = root.join("source");
		let existing_output = root.join("existing.json");
		let invalid_corpus = root.join("invalid-corpus.json");

		fs::create_dir_all(&source).expect("source fixture");
		fs::write(&existing_output, b"preserve").expect("existing output fixture");
		fs::write(&invalid_corpus, b"{}").expect("invalid corpus fixture");

		let requests = Rc::new(RefCell::new(Vec::<CommandRequest>::new()));

		assert!(cli::select_models(&["not-a-model".to_owned()]).is_err());
		assert!(
			capacity::assess_capacity(
				&runner::synthetic_demo_tasks(),
				&crate::model::MODEL_MATRIX,
				&crate::model::MODEL_MATRIX,
				&[],
				&format!("sha256:{}", "a".repeat(64)),
				0,
				43_200,
			)
			.is_err()
		);
		assert!(
			crate::schedule::ScheduleConfig::default()
				.slot("invalid-date", crate::schedule::ScheduleOccurrence::Day)
				.is_err()
		);
		assert!(cli::validate_new_output_set(&[("Official output", &existing_output)]).is_err());
		assert!(
			corpus_commitment::validate_corpus_commitment(
				&invalid_corpus,
				&runner::synthetic_demo_tasks(),
				&source,
			)
			.is_err()
		);
		assert!(requests.borrow().is_empty(), "planning rejection must not reach an adapter");
		assert_eq!(fs::read(&existing_output).expect("preserved output"), b"preserve");

		fs::remove_dir_all(root).expect("fixture cleanup");
	}

	#[test]
	fn official_output_reservation_resumes_only_the_same_run_without_overwrite() {
		let root = fixture_root("official-output-reservation");
		let preflight = root.join("preflight.json");
		let checkpoint = root.join("checkpoint.json");
		let output = root.join("run.json");
		let score = root.join("score.json");
		let package = root.join("package.json");
		let run_id = format!("run_{}", "a".repeat(64));
		let entries = || {
			vec![cli::FutureProtectedEntry {
				category: "output",
				path: output.clone(),
				must_be_new: true,
				recoverable_bytes: Some(cli::official_output_reservation(&run_id)),
			}]
		};

		fs::create_dir_all(&root).expect("fixture root");

		drop(cli::FutureProtectedFiles::prepare(&entries()).expect("initial reservation"));

		assert_eq!(
			fs::read(&output).expect("reserved output"),
			cli::official_output_reservation(&run_id)
		);
		assert!(
			cli::official_output_plan(&preflight, &checkpoint, &output, &score, &package, None,)
				.is_err()
		);
		assert!(
			cli::official_output_plan(
				&preflight,
				&checkpoint,
				&output,
				&score,
				&package,
				Some(&format!("run_{}", "b".repeat(64))),
			)
			.is_err()
		);

		#[cfg(unix)]
		{
			let alias = root.join("reservation-alias");

			fs::hard_link(&output, &alias).expect("hard-link alias");

			assert!(
				cli::official_output_plan(
					&preflight,
					&checkpoint,
					&output,
					&score,
					&package,
					Some(&run_id),
				)
				.is_err()
			);

			fs::remove_file(alias).expect("remove hard-link alias");
		}

		let plan = cli::official_output_plan(
			&preflight,
			&checkpoint,
			&output,
			&score,
			&package,
			Some(&run_id),
		)
		.expect("same-run recovery plan");

		assert_eq!(plan.run_output, expected_path(&output).display().to_string());

		let mut recovered =
			cli::FutureProtectedFiles::prepare(&entries()).expect("recovered reservation");

		recovered
			.write_created_pretty_json(&output, &serde_json::json!({"complete": true}), "test")
			.expect("complete reserved output");
		recovered.disarm(&output);

		drop(recovered);

		assert_eq!(
			serde_json::from_slice::<serde_json::Value>(
				&fs::read(&output).expect("completed output")
			)
			.expect("completed JSON"),
			serde_json::json!({"complete": true})
		);
		assert!(fs::read_dir(&root).expect("output directory").all(|entry| {
			!entry.expect("output entry").file_name().to_string_lossy().contains(".aiq-finalize-")
		}));
		assert!(cli::FutureProtectedFiles::prepare(&entries()).is_err());

		fs::remove_dir_all(root).expect("fixture cleanup");
	}

	#[cfg(unix)]
	#[test]
	fn future_protected_parent_allows_only_one_cooperating_writer() {
		let root = fixture_root("future-protected-directory-lock");
		let first_path = root.join("first.json");
		let second_path = root.join("second.json");
		let entry = |path: PathBuf| {
			vec![cli::FutureProtectedEntry {
				category: "test",
				path,
				must_be_new: false,
				recoverable_bytes: None,
			}]
		};

		fs::create_dir_all(&root).expect("fixture root");

		let first_entries = entry(first_path.clone());
		let early_locks = cli::FutureProtectedDirectoryLocks::acquire(&first_entries)
			.expect("early directory locks before preflight");

		assert!(cli::FutureProtectedDirectoryLocks::acquire(&entry(second_path.clone())).is_err());

		let first = cli::FutureProtectedFiles::prepare_with_locks(&first_entries, early_locks)
			.expect("first directory writer");

		drop(first);

		assert!(!first_path.exists());

		drop(
			cli::FutureProtectedFiles::prepare(&entry(second_path.clone()))
				.expect("directory lock released after drop"),
		);

		assert!(!second_path.exists());

		fs::remove_dir_all(root).expect("fixture cleanup");
	}

	#[cfg(unix)]
	#[test]
	fn standalone_preflight_holds_one_lock_for_its_state_parent() {
		let root = fixture_root("standalone-preflight-directory-lock");
		let moved = root.with_extension("moved");
		let output = root.join("preflight.json");

		fs::create_dir_all(&root).expect("fixture root");

		let first =
			cli::acquire_preflight_future_protected_locks(&output).expect("first preflight writer");

		assert!(cli::acquire_preflight_future_protected_locks(&output).is_err());

		drop(first);
		drop(
			cli::acquire_preflight_future_protected_locks(&output)
				.expect("preflight lock released after drop"),
		);

		assert!(cli::acquire_preflight_future_protected_locks(Path::new("-")).is_err());

		let held =
			cli::acquire_preflight_future_protected_locks(&output).expect("held preflight parent");

		fs::rename(&root, &moved).expect("move locked parent");
		fs::create_dir_all(&root).expect("replacement parent");

		let protected_output = cli::canonical_leaf_policy_path(&output).expect("protected output");

		assert!(held.verify(&protected_output).is_err());

		drop(held);

		fs::remove_dir_all(root).expect("fixture cleanup");
		fs::remove_dir_all(moved).expect("moved fixture cleanup");
	}

	#[cfg(unix)]
	#[test]
	fn official_output_reservation_rejects_leaf_symlink_swaps_without_target_damage() {
		let root = fixture_root("official-output-reservation-symlink-swap");
		let preflight = root.join("preflight.json");
		let checkpoint = root.join("checkpoint.json");
		let output = root.join("run.json");
		let moved = root.join("moved-reservation.json");
		let score = root.join("score.json");
		let package = root.join("package.json");
		let run_id = format!("run_{}", "c".repeat(64));
		let entries = || {
			vec![cli::FutureProtectedEntry {
				category: "output",
				path: output.clone(),
				must_be_new: true,
				recoverable_bytes: Some(cli::official_output_reservation(&run_id)),
			}]
		};

		fs::create_dir_all(&root).expect("fixture root");

		let mut reserved =
			cli::FutureProtectedFiles::prepare(&entries()).expect("initial reservation");

		fs::rename(&output, &moved).expect("move held reservation");
		std::os::unix::fs::symlink(&moved, &output).expect("replacement symlink");

		assert!(
			cli::official_output_plan(
				&preflight,
				&checkpoint,
				&output,
				&score,
				&package,
				Some(&run_id),
			)
			.is_err()
		);
		assert!(cli::FutureProtectedFiles::prepare(&entries()).is_err());
		assert!(
			reserved
				.write_created_pretty_json(
					&output,
					&serde_json::json!({"must_not_install": true}),
					"test",
				)
				.is_err()
		);
		assert_eq!(
			fs::read(&moved).expect("reservation target"),
			cli::official_output_reservation(&run_id)
		);

		fs::remove_file(&output).expect("remove replacement symlink");

		drop(reserved);

		fs::remove_dir_all(root).expect("fixture cleanup");
	}

	#[cfg(unix)]
	#[test]
	fn atomic_output_exchange_restores_an_unexpected_concurrent_replacement() {
		let root = fixture_root("official-output-exchange-rollback");
		let output = root.join("run.json");
		let moved_reservation = root.join("moved-reservation.json");
		let run_id = format!("run_{}", "d".repeat(64));
		let expected = cli::official_output_reservation(&run_id);
		let final_bytes = b"{\"complete\":true}\n";

		fs::create_dir_all(&root).expect("fixture root");

		let held_reservation =
			cli::write_new_bytes(&output, &expected, "reservation").expect("reservation file");

		fs::rename(&output, &moved_reservation).expect("move reservation before exchange");
		fs::write(&output, b"unexpected concurrent file").expect("concurrent replacement");

		let (temporary_path, temporary_file) =
			cli::write_unique_sibling_bytes(&output, final_bytes, "test")
				.expect("temporary final output");

		assert!(
			cli::install_atomic_exchange(
				&output,
				&temporary_path,
				&expected,
				&held_reservation,
				final_bytes,
				&temporary_file,
				"test",
			)
			.is_err()
		);
		assert_eq!(fs::read(&output).expect("restored replacement"), b"unexpected concurrent file");
		assert_eq!(fs::read(&moved_reservation).expect("preserved reservation"), expected);
		assert!(!temporary_path.exists());

		fs::remove_dir_all(root).expect("fixture cleanup");
	}

	#[test]
	fn calibration_protects_only_a_durable_final_output() {
		let entries = cli::future_protected_entries(
			RunClass::Calibration,
			Path::new("preflight.json"),
			Path::new("checkpoint.json"),
			Path::new("run.json"),
			&format!("run_{}", "a".repeat(64)),
		);

		assert_eq!(
			entries.iter().map(|entry| entry.category).collect::<Vec<_>>(),
			vec!["preflight_cache", "checkpoint", "output"]
		);
		assert!(entries[2].must_be_new);
		assert_eq!(
			entries[2].recoverable_bytes,
			Some(cli::calibration_output_reservation(&format!("run_{}", "a".repeat(64))))
		);

		let stdout_entries = cli::future_protected_entries(
			RunClass::Calibration,
			Path::new("preflight.json"),
			Path::new("checkpoint.json"),
			Path::new("-"),
			&format!("run_{}", "b".repeat(64)),
		);

		assert_eq!(
			stdout_entries.iter().map(|entry| entry.category).collect::<Vec<_>>(),
			vec!["preflight_cache", "checkpoint"]
		);
	}

	#[test]
	fn live_run_state_paths_are_distinct_before_preflight() {
		let root = fixture_root("live-run-state-aliases");
		let preflight = root.join("preflight.json");
		let preflight_attempt = resume::preflight_attempt_path(&preflight);
		let checkpoint = root.join("checkpoint.json");
		let output = root.join("run.json");

		fs::create_dir_all(&root).expect("fixture root");
		cli::validate_run_future_protected_paths(&preflight, &checkpoint, &output)
			.expect("distinct durable paths");
		cli::validate_run_future_protected_paths(&preflight, &checkpoint, Path::new("-"))
			.expect("standard output is not a durable alias");

		for aliased_output in [&preflight, &preflight_attempt, &checkpoint] {
			assert!(
				cli::validate_run_future_protected_paths(&preflight, &checkpoint, aliased_output,)
					.is_err()
			);
		}

		assert!(cli::validate_run_future_protected_paths(&preflight, &preflight, &output).is_err());

		fs::remove_dir_all(root).expect("fixture cleanup");
	}

	#[test]
	fn calibration_finalizes_below_an_already_locked_parent() {
		let root = fixture_root("calibration-shared-output-parent");
		let preflight = root.join("preflight.json");
		let checkpoint = root.join("checkpoint.json");
		let output = root.join("run.json");
		let entries = cli::future_protected_entries(
			RunClass::Calibration,
			&preflight,
			&checkpoint,
			&output,
			&format!("run_{}", "c".repeat(64)),
		);

		fs::create_dir_all(&root).expect("fixture root");
		fs::write(&output, b"existing calibration output").expect("existing output");

		assert!(cli::FutureProtectedFiles::prepare(&entries).is_err());
		assert_eq!(
			fs::read(&output).expect("preserved existing output"),
			b"existing calibration output"
		);

		fs::remove_file(&output).expect("remove existing output fixture");

		drop(cli::FutureProtectedFiles::prepare(&entries).expect("initial reservation"));

		assert_eq!(
			fs::read(&output).expect("calibration reservation"),
			entries[2].recoverable_bytes.as_deref().expect("reservation bytes")
		);

		let mut protected = cli::FutureProtectedFiles::prepare(&entries)
			.expect("recovered calibration reservation");

		protected
			.write_created_pretty_json(
				&output,
				&serde_json::json!({"complete": true}),
				"calibration live output",
			)
			.expect("finalize calibration output with the held directory lock");
		protected.disarm(&output);

		drop(protected);

		assert_eq!(
			serde_json::from_slice::<serde_json::Value>(
				&fs::read(&output).expect("calibration output")
			)
			.expect("calibration JSON"),
			serde_json::json!({"complete": true})
		);
		assert!(!preflight.exists());
		assert!(!checkpoint.exists());

		fs::remove_dir_all(root).expect("fixture cleanup");
	}

	#[test]
	fn protected_json_install_rejects_existing_symlink_and_hard_link_without_damage() {
		let root = fixture_root("protected-json-install");
		let existing = root.join("existing.json");
		let hard_link = root.join("hard-link.json");

		fs::create_dir_all(&root).expect("fixture root");
		fs::write(&existing, b"original").expect("existing fixture");
		fs::hard_link(&existing, &hard_link).expect("hard-link fixture");

		assert!(cli::write_json(&existing, &serde_json::json!({"changed": true})).is_err());
		assert!(cli::write_json(&hard_link, &serde_json::json!({"changed": true})).is_err());
		assert_eq!(fs::read(&existing).expect("existing bytes"), b"original");

		#[cfg(unix)]
		{
			let symlink = root.join("symlink.json");

			std::os::unix::fs::symlink(&existing, &symlink).expect("symlink fixture");

			assert!(cli::write_json(&symlink, &serde_json::json!({"changed": true})).is_err());
			assert_eq!(fs::read(&existing).expect("symlink target bytes"), b"original");
		}

		fs::remove_dir_all(root).expect("fixture cleanup");
	}

	#[test]
	fn protected_json_install_is_create_new_and_leaves_no_temporary_file() {
		let root = fixture_root("protected-json-create-new");
		let output = root.join("output.json");

		fs::create_dir_all(&root).expect("fixture root");
		cli::write_json(&output, &serde_json::json!({"complete": true}))
			.expect("atomic create-new output");

		let expected = b"{\n  \"complete\": true\n}\n";

		assert_eq!(fs::read(&output).expect("protected output"), expected);
		assert!(cli::write_json(&output, &serde_json::json!({"changed": true})).is_err());
		assert_eq!(fs::read(&output).expect("preserved protected output"), expected);
		assert!(fs::read_dir(&root).expect("output directory").all(|entry| {
			!entry.expect("output entry").file_name().to_string_lossy().contains(".aiq-finalize-")
		}));

		fs::remove_dir_all(root).expect("fixture cleanup");
	}

	#[test]
	fn standalone_preflight_denies_control_files_and_rejects_workspace_or_toolchain_overlap() {
		let root = fixture_root("standalone-preflight");
		let controls = root.join("controls");
		let artifacts = root.join("probe-artifacts");
		let toolchain = root.join("toolchain");
		let capabilities = controls.join("capabilities.json");
		let corpus_commitment = controls.join("commitment.json");

		fs::create_dir_all(&controls).expect("control fixture");
		fs::create_dir_all(&artifacts).expect("artifact fixture");
		fs::create_dir_all(&toolchain).expect("toolchain fixture");
		fs::write(&capabilities, b"{}").expect("capability fixture");
		fs::write(&corpus_commitment, b"{}").expect("corpus fixture");

		let roots = cli::standalone_preflight_denied_roots(
			&capabilities,
			&corpus_commitment,
			&artifacts,
			&toolchain,
		)
		.expect("standalone preflight roots");
		let mut expected = vec![expected_path(&capabilities), expected_path(&corpus_commitment)];

		expected.sort();
		expected.dedup();

		assert_eq!(roots, expected);
		assert_eq!(roots.len(), 2);

		let workspace_capabilities = artifacts.join("capabilities.json");

		fs::write(&workspace_capabilities, b"{}").expect("workspace control fixture");

		let workspace_error = cli::standalone_preflight_denied_roots(
			&workspace_capabilities,
			&corpus_commitment,
			&artifacts,
			&toolchain,
		)
		.expect_err("workspace overlap must fail");

		assert!(workspace_error.to_string().contains("capabilities"));
		assert!(workspace_error.to_string().contains("writable execution workspace"));

		let toolchain_commitment = toolchain.join("commitment.json");

		fs::write(&toolchain_commitment, b"{}").expect("toolchain control fixture");

		let toolchain_error = cli::standalone_preflight_denied_roots(
			&capabilities,
			&toolchain_commitment,
			&artifacts,
			&toolchain,
		)
		.expect_err("toolchain overlap must fail");

		assert!(toolchain_error.to_string().contains("corpus_commitment"));
		assert!(toolchain_error.to_string().contains("additional read grant"));

		fs::remove_dir_all(root).expect("fixture cleanup");
	}

	#[test]
	fn standalone_preflight_profile_check_reaches_the_executor_with_nonempty_denies() {
		let root = fixture_root("standalone-preflight-boundary");
		let controls = root.join("controls");
		let artifacts = root.join("probe-artifacts");
		let toolchain = root.join("toolchain");
		let codex_home = root.join("codex-home");
		let capabilities = controls.join("capabilities.json");
		let corpus_commitment = controls.join("commitment.json");

		for directory in [&controls, &artifacts, &toolchain, &codex_home] {
			fs::create_dir_all(directory).expect("preflight fixture directory");
		}

		fs::write(&capabilities, b"{}").expect("capability fixture");
		fs::write(&corpus_commitment, b"{}").expect("corpus fixture");

		let roots = cli::standalone_preflight_denied_roots(
			&capabilities,
			&corpus_commitment,
			&artifacts,
			&toolchain,
		)
		.expect("standalone preflight roots");
		let requests = Rc::new(RefCell::new(Vec::new()));
		let adapter = CodexAdapter::new(
			BoundaryExecutor { requests: Rc::clone(&requests) },
			TestArtifactSink,
			"codex",
			CodexExecutionConfig::isolated(codex_home).with_denied_roots(roots),
		);
		let error = adapter
			.verify_managed_permission_profile(&artifacts)
			.expect_err("recording executor must stop the profile probe");

		assert!(error.to_string().contains("recording profile boundary reached"));
		assert!(!error.to_string().contains("requires at least one protected path"));
		assert_eq!(requests.borrow().len(), 1);
		assert_eq!(requests.borrow()[0].args, ["--version"]);

		fs::remove_dir_all(root).expect("fixture cleanup");
	}

	#[test]
	fn unexpected_managed_requirements_deny_admission_before_the_canary() {
		let root = fixture_root("denied-admission");
		let workspace = root.join("workspace");
		let codex_home = root.join("codex-home");
		let checkpoint = root.join("checkpoint.json");
		let planned_output = root.join("official.json");
		let report_output = root.join("admission.json");

		fs::create_dir_all(&workspace).expect("admission workspace");
		fs::create_dir_all(&codex_home).expect("Codex home fixture");

		let requests = Rc::new(RefCell::new(Vec::new()));
		let adapter = CodexAdapter::new(
			BoundaryExecutor { requests: Rc::clone(&requests) },
			TestArtifactSink,
			"codex",
			CodexExecutionConfig::isolated(codex_home),
		);
		let profile = unexpected_managed_requirements_profile();
		let assessment = cli::verify_permission_evidence_with_profile(
			&adapter,
			&workspace,
			&[],
			RunClass::Official,
			profile.clone(),
		);
		let (report, denied) =
			cli::permission_admission_report(42, Some(profile), None, assessment)
				.expect("denied admission report");

		assert!(denied);

		cli::write_private_json_receipt(&report_output, &report).expect("private denied receipt");

		let value: serde_json::Value =
			serde_json::from_slice(&fs::read(&report_output).expect("read denied receipt"))
				.expect("denied receipt JSON");

		assert_eq!(value["official_permission_eligible"], false);
		assert_eq!(value["model_invoked"], false);
		assert_eq!(value["managed_profile"]["managed_requirements_status"], "present_unexpected");
		assert!(
			value["failure"]
				.as_str()
				.is_some_and(|failure| failure.contains("require no external managed requirements"))
		);
		assert!(requests.borrow().is_empty(), "denial must precede the sandbox canary");
		assert!(!checkpoint.exists(), "denial must not create a checkpoint");
		assert!(!planned_output.exists(), "denial must not reserve planned Official output");
		#[cfg(unix)]
		assert_eq!(
			fs::symlink_metadata(&report_output).expect("receipt metadata").permissions().mode()
				& 0o777,
			0o600
		);

		fs::remove_dir_all(root).expect("fixture cleanup");
	}

	#[test]
	fn permission_admission_rejects_report_alias_existing_file_and_symlink() {
		let root = fixture_root("admission-report-output");
		let planned = root.join("official.json");
		let report = root.join("admission.json");

		fs::create_dir_all(&root).expect("fixture root");

		assert!(cli::validate_permission_admission_outputs(&planned, &planned).is_err());

		let options = cli::PermissionAdmissionOptions {
			public_tasks: None,
			hidden_tasks: Some(root.join("tasks")),
			corpus_commitment: root.join("commitment.json"),
			source_root: root.join("source"),
			capabilities: root.join("capabilities.json"),
			workspace_root: root.join("baselines"),
			execution_root: root.join("execution"),
			evaluator_root: root.join("evaluators"),
			evaluator_runtime: root.join("node"),
			codex_toolchain_root: root.join("toolchain"),
			schedule: root.join("schedule.json"),
			slot_date: "2030-01-01".to_owned(),
			occurrence: "day".to_owned(),
			observed_at: "unix-ms:1".to_owned(),
			codex_binary: root.join("codex").display().to_string(),
			codex_home: root.join("codex-home"),
			artifact_root: root.join("artifacts"),
			preflight_cache: root.join("preflight.json"),
			checkpoint: report.clone(),
			jobs: 1,
			planned_output: planned.clone(),
			planned_score_output: root.join("scores.json"),
			planned_package_output: root.join("package.json"),
			report_output: report.clone(),
		};

		assert!(cli::validate_permission_admission_output_aliases(&options).is_err());

		fs::write(&report, b"existing").expect("existing report fixture");

		assert!(cli::validate_permission_admission_outputs(&planned, &report).is_err());

		fs::remove_file(&report).expect("remove existing report fixture");

		let target = root.join("target.json");

		fs::write(&target, b"target").expect("symlink target fixture");

		#[cfg(unix)]
		{
			std::os::unix::fs::symlink(&target, &report).expect("report symlink fixture");

			assert!(cli::validate_permission_admission_outputs(&planned, &report).is_err());
			assert!(cli::write_private_json_receipt(&report, &serde_json::json!({})).is_err());
		}

		fs::remove_dir_all(root).expect("fixture cleanup");
	}

	#[test]
	fn every_protected_path_category_reaches_the_permission_canary() {
		let root = fixture_root("admission-canary-categories");
		let execution = root.join("execution");
		let toolchain = root.join("toolchain");
		let codex_home = root.join("codex-home");
		let probe_binary = env::current_exe().expect("test executable");

		for directory in [&execution, &toolchain, &codex_home] {
			fs::create_dir_all(directory).expect("fixture directory");
		}

		fs::write(codex_home.join("config.toml"), b"fixture").expect("Codex home fixture");

		let node = toolchain.join(if cfg!(windows) { "node.exe" } else { "node" });

		fs::write(&node, b"node").expect("toolchain fixture");

		let source = root.join("source");
		let baselines = root.join("baselines");
		let evaluators = root.join("evaluators");
		let artifacts = root.join("artifacts");
		let tasks = root.join("tasks");
		let codex_binary = root.join("codex");
		let commitment = root.join("commitment.json");
		let capabilities = root.join("capabilities.json");
		let schedule = root.join("schedule.json");
		let preflight = root.join("preflight.json");
		let checkpoint = root.join("checkpoint.json");
		let output = root.join("official.json");
		let report = root.join("admission.json");
		let protected = cli::benchmark_protected_paths_from(cli::BenchmarkProtectedPathInputs {
			public_tasks: None,
			hidden_tasks: Some(&tasks),
			source_root: &source,
			workspace_root: &baselines,
			evaluator_root: &evaluators,
			artifact_root: &artifacts,
			codex_home: &codex_home,
			codex_binary: &codex_binary,
			corpus_commitment: &commitment,
			capabilities: &capabilities,
			schedule: &schedule,
			preflight_cache: &preflight,
			checkpoint: &checkpoint,
			planned_output: &output,
			planned_score_output: None,
			planned_package_output: None,
			report_output: Some(&report),
			official_admission: None,
		})
		.expect("complete permission admission protected paths");
		let category_names = [
			"source_root",
			"workspace_baselines",
			"evaluator_root",
			"artifact_root",
			"codex_home",
			"codex_binary",
			"hidden_tasks",
			"corpus_commitment",
			"capabilities",
			"schedule",
			"preflight_cache",
			"preflight_attempt",
			"checkpoint",
			"output",
			"official_admission_receipt",
		];

		assert_eq!(
			protected.iter().map(|entry| entry.category).collect::<std::collections::BTreeSet<_>>(),
			category_names.into_iter().collect()
		);

		let requests = Rc::new(RefCell::new(Vec::new()));
		let adapter = CodexAdapter::new(
			SuccessfulBoundaryExecutor { requests: Rc::clone(&requests) },
			TestArtifactSink,
			"codex",
			CodexExecutionConfig::isolated(codex_home)
				.with_denied_roots(protected.iter().map(|entry| entry.path.clone()).collect())
				.with_permission_probe_executable(probe_binary)
				.with_model_toolchain(corpus_commitment::fixture_model_toolchain(toolchain)),
		);
		let digest = cli::verify_codex_permission_boundary(&adapter, &execution, &protected)
			.expect("all protected categories reach a successful canary");

		assert!(digest.starts_with("sha256:"));

		let requests = requests.borrow();
		let request = requests.first().expect("permission canary request");
		let denied_values = request
			.args
			.windows(2)
			.filter(|pair| pair[0] == "--denied-file")
			.map(|pair| pair[1].clone())
			.collect::<Vec<_>>();

		assert_eq!(denied_values.len(), category_names.len());
		assert_eq!(requests.len(), 1, "the canary must not invoke a model");

		for entry in &protected {
			assert!(
				denied_values
					.iter()
					.any(|path| path.starts_with(entry.path.to_string_lossy().as_ref())),
				"protected category {} did not reach the canary",
				entry.category
			);
		}

		fs::remove_dir_all(root).expect("fixture cleanup");
	}
}
