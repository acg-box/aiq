//! Command-line interface for local AIQ workflows.
use std::{
	cmp::Ordering,
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
	fs::Permissions,
	os::unix::fs::{MetadataExt as _, OpenOptionsExt, PermissionsExt},
};

use clap::{Parser, Subcommand, ValueEnum};
use libc::O_NOFOLLOW;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};

use crate::pinned_path::{PinnedDirectoryIdentity, PinnedPathIdentity};
use aiq_runner::{
	adapter::{
		self, ArtifactSink, CapabilityValidationReport, CapabilityValidationStatus,
		ChatgptCredentialObservation, CodexAdapter, CodexEgressProxyEndpoint, CodexExecutionConfig,
		ConfigurationProbeStatus, Executor, LocalArtifactSink, ManagedPermissionProfileEvidence,
		ProbeStatus, SystemExecutor,
	},
	capacity::{self, CapacityAdmission},
	corpus_commitment::{
		self, ExecutionToolPolicy, RunClass, ValidatedCorpusCommitment, ValidatedModelToolchain,
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
		LocalDirectoryWorkspaceProvider, LocalRunExecution, RUN_SCHEMA_VERSION, RunRecord,
		SelectedRun,
	},
	schedule::{ScheduleConfig, ScheduleOccurrence, ScheduleSlot},
	scoring::{
		self, AIQ_SCORING_VERSION, CalibrationScoreReport, FalseOnly, ScoreContext, ScoreOptions,
		ScoreReport,
	},
	submission::{
		self, HttpsTransport, MAX_SIGNED_PACKAGE_BYTES, MAX_SUBMISSION_BYTES, SecretToken,
	},
	task::{
		self, DirectoryTaskSource, EvaluatorRuntime, TaskDefinition, TaskLoadIssue, TaskLoadReport,
		TaskSource, ValidationIssue, Visibility,
	},
};

const MAX_CORPUS_COMMITMENT_BYTES: usize = 4 * 1_024 * 1_024;
const MAX_CAPABILITY_MANIFEST_BYTES: usize = 512 * 1_024;

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
	codex_egress_proxy: CodexEgressProxyEndpoint,
	artifact_root: PathBuf,
	preflight_cache: PathBuf,
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
	codex_binary: String,
	codex_home: PathBuf,
	codex_egress_proxy: CodexEgressProxyEndpoint,
	artifact_root: PathBuf,
	preflight_cache: PathBuf,
	checkpoint: PathBuf,
	planned_output: PathBuf,
	report_output: PathBuf,
}

struct PreparedPermissionAdmission {
	adapter: CodexAdapter<SystemExecutor, LocalArtifactSink>,
	execution_root: PathBuf,
	protected_paths: Vec<ProtectedBenchmarkPath>,
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
	output: &'a Path,
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
			return Err("managed permission profile changed before a capability probe".into());
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
	capacity_admission: CapacityAdmission,
	slot: ScheduleSlot,
	task_set_hash: String,
	run_id: String,
	preflight: PreflightCache,
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

#[derive(Serialize)]
struct PermissionAdmissionReport {
	schema_version: &'static str,
	official_permission_eligible: bool,
	model_invoked: bool,
	observed_unix_ms: u64,
	managed_profile: Option<ManagedPermissionProfileEvidence>,
	permission_policy_digest: Option<String>,
	canary_digest: Option<String>,
	permission_evidence_digest: Option<String>,
	failure: Option<String>,
}

#[derive(Default)]
struct FutureProtectedFiles {
	created: BTreeMap<PathBuf, FutureProtectedFile>,
}
impl FutureProtectedFiles {
	fn prepare(entries: &[(&str, &Path, bool)]) -> Result<Self, Box<dyn std::error::Error>> {
		let mut files = Self::default();

		for (category, path, must_be_new) in entries {
			if *path == Path::new("-") {
				continue;
			}

			let path = canonical_policy_path(path)?;

			match fs::symlink_metadata(&path) {
				Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
					return Err(format!(
						"future protected category {category} must be a regular file"
					)
					.into());
				},
				Ok(_) if *must_be_new => {
					return Err(format!(
						"future protected category {category} must not exist before this run"
					)
					.into());
				},
				Ok(_) => continue,
				Err(error) if error.kind() == ErrorKind::NotFound => {},
				Err(error) => return Err(error.into()),
			}

			let created_file =
				write_new_bytes(&path, b"AIQ_DENIED\n", "future protected placeholder")?;

			if files
				.created
				.insert(
					path.clone(),
					FutureProtectedFile { file: created_file, remove_on_drop: !must_be_new },
				)
				.is_some()
			{
				return Err("future protected paths must be distinct".into());
			}
		}

		Ok(files)
	}

	fn write_created_pretty_json(
		&mut self,
		path: &Path,
		value: &impl Serialize,
		label: &str,
	) -> Result<(), Box<dyn std::error::Error>> {
		let path = canonical_policy_path(path)?;
		let created = self
			.created
			.get_mut(&path)
			.ok_or("future protected path was not created by this run")?;
		let mut bytes = serde_json::to_vec_pretty(value)?;

		bytes.push(b'\n');

		require_exact_created_file(&path, b"AIQ_DENIED\n", &created.file, label)?;

		created.file.set_len(0)?;
		created.file.seek(SeekFrom::Start(0))?;
		created.file.write_all(&bytes)?;
		created.file.sync_all()?;

		require_exact_created_file(&path, &bytes, &created.file, label)?;

		Ok(())
	}

	fn was_created(&self, path: &Path) -> bool {
		canonical_policy_path(path).is_ok_and(|path| self.created.contains_key(&path))
	}

	fn disarm(&mut self, path: &Path) {
		if let Ok(path) = canonical_policy_path(path) {
			self.created.remove(&path);
		}
	}

	fn cleanup(&mut self) {
		for (path, created) in mem::take(&mut self.created) {
			if created.remove_on_drop {
				let _ = remove_exact_created_file(
					&path,
					b"AIQ_DENIED\n",
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

struct FutureProtectedFile {
	file: File,
	remove_on_drop: bool,
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

impl From<ReplayMode> for ReplayStatus {
	fn from(value: ReplayMode) -> Self {
		match value {
			ReplayMode::EvaluatorReplayed => Self::EvaluatorReplayed,
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
		/// Exact private HTTP proxy used only by the outer Codex process.
		#[arg(long, value_parser = parse_codex_egress_proxy)]
		codex_egress_proxy: CodexEgressProxyEndpoint,
		/// Controlled local sink for bounded preflight artifacts.
		#[arg(long, default_value = ".aiq-artifacts")]
		artifact_root: PathBuf,
		/// Cache validity from the current time.
		#[arg(long, default_value_t = 86_400)]
		expires_in_seconds: u64,
		/// Machine-readable persisted preflight JSON.
		#[arg(long)]
		output: PathBuf,
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
		/// Absolute executable inspected, checked for executability, and canonicalized before use.
		#[arg(long, value_parser = parse_controlled_codex_binary)]
		codex_binary: String,
		/// Absolute existing non-symlink directory for the operator's subscription Codex home.
		#[arg(long, value_parser = parse_controlled_codex_home)]
		codex_home: PathBuf,
		/// Exact private HTTP proxy used only by outer Codex processes.
		#[arg(long, value_parser = parse_codex_egress_proxy)]
		codex_egress_proxy: CodexEgressProxyEndpoint,
		/// Controlled local artifact sink.
		#[arg(long)]
		artifact_root: PathBuf,
		/// Existing persisted preflight path protected from benchmark children.
		#[arg(long)]
		preflight_cache: PathBuf,
		/// Planned durable per-attempt checkpoint path.
		#[arg(long)]
		checkpoint: PathBuf,
		/// Planned create-once Official run output. This command does not reserve it.
		#[arg(long)]
		planned_output: PathBuf,
		/// Machine-readable permission-admission JSON, or `-` for standard output.
		#[arg(long, default_value = "-")]
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
		/// Exact private HTTP proxy used only by outer Codex processes.
		#[arg(long, value_parser = parse_codex_egress_proxy)]
		codex_egress_proxy: CodexEgressProxyEndpoint,
		/// Controlled local artifact sink.
		#[arg(long, default_value = ".aiq-artifacts")]
		artifact_root: PathBuf,
		/// Persisted authenticated preflight report reused until expiry.
		#[arg(long, default_value = ".aiq-preflight.json")]
		preflight_cache: PathBuf,
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
		/// Output signed-envelope JSON file.
		#[arg(long)]
		output: PathBuf,
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
		/// Candidate reconstruction and deterministic evaluator replay disposition.
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
		network_sentinel_port: u16,
	},
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum ReplayMode {
	/// The verifier reconstructed candidate workspaces and replayed deterministic evaluators.
	EvaluatorReplayed,
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
		Command::Preflight {
			capabilities,
			corpus_commitment,
			evaluator_runtime,
			codex_toolchain_root,
			codex_binary,
			codex_home,
			codex_egress_proxy,
			artifact_root,
			expires_in_seconds,
			output,
		} => run_preflight(
			capabilities,
			corpus_commitment,
			evaluator_runtime,
			codex_toolchain_root,
			codex_binary,
			codex_home,
			codex_egress_proxy,
			artifact_root,
			expires_in_seconds,
			output,
		)?,
		command @ Command::AdmitPermissions { .. } => dispatch_permission_admission(command)?,
		Command::Validate {
			public_tasks,
			hidden_tasks,
			corpus_commitment,
			source_root,
			evaluator_root,
			evaluator_runtime,
			codex_toolchain_root,
		} => run_validation(
			public_tasks,
			hidden_tasks,
			corpus_commitment,
			source_root,
			evaluator_root,
			evaluator_runtime,
			codex_toolchain_root,
		)?,
		command @ Command::Run { .. } => dispatch_run(command)?,
		Command::Score {
			public_tasks,
			hidden_tasks,
			results,
			bootstrap_samples,
			bootstrap_seed,
			output,
		} => run_score(
			public_tasks,
			hidden_tasks,
			results,
			bootstrap_samples,
			bootstrap_seed,
			output,
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
			allow_loopback_http,
		} => run_submit(
			&package,
			&artifact_root,
			&endpoint,
			&token_env,
			timeout_seconds,
			allow_loopback_http,
		)?,
		Command::Package { run, artifact_root, signing_key_env, output } => {
			run_package(&run, &artifact_root, &signing_key_env, &output)?;
		},
		Command::Identity { signing_key_env } => run_identity(&signing_key_env)?,
		command @ Command::Normalize { .. } => run_normalize_command(command)?,
		command @ Command::PermissionProbe { .. } => dispatch_permission_probe(command)?,
	}

	Ok(())
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
		codex_egress_proxy,
		artifact_root,
		preflight_cache,
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
		codex_egress_proxy,
		artifact_root,
		preflight_cache,
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
		codex_binary,
		codex_home,
		codex_egress_proxy,
		artifact_root,
		preflight_cache,
		checkpoint,
		planned_output,
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
		codex_binary,
		codex_home,
		codex_egress_proxy,
		artifact_root,
		preflight_cache,
		checkpoint,
		planned_output,
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
	codex_egress_proxy: CodexEgressProxyEndpoint,
	artifact_root: PathBuf,
	expires_in_seconds: u64,
	output: PathBuf,
) -> Result<(), Box<dyn std::error::Error>> {
	let manifest = read_json::<CapabilityManifest>(&path)?;
	let codex_binary = controlled_codex_binary(&codex_binary)?;
	let evaluator_runtime = EvaluatorRuntime::resolve(&evaluator_runtime)?;
	let policy = corpus_commitment::read_execution_tool_policy(&corpus_commitment)?;
	let model_toolchain = corpus_commitment::validate_model_toolchain(
		&codex_toolchain_root,
		&policy,
		&evaluator_runtime,
	)?;
	let observed_unix_ms = resume::unix_ms();
	let expires_unix_ms = observed_unix_ms
		.checked_add(expires_in_seconds.checked_mul(1_000).ok_or("preflight expiry overflows")?)
		.ok_or("preflight expiry overflows")?;
	let artifact_sink = LocalArtifactSink::new(&artifact_root)?;
	let denied_roots = standalone_preflight_denied_roots(
		&path,
		&corpus_commitment,
		&artifact_root,
		model_toolchain.root(),
	)?;
	let adapter = CodexAdapter::new(
		SystemExecutor,
		artifact_sink,
		codex_binary.clone(),
		CodexExecutionConfig::isolated(codex_home.clone())
			.with_denied_roots(denied_roots)
			.with_egress_proxy(codex_egress_proxy)
			.with_model_toolchain(model_toolchain.clone()),
	);
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
			profile_workspace: &artifact_root,
			artifact_root: &artifact_root,
			output: &output,
		},
	)?;

	binding.verify(&adapter)?;

	let report = adapter.validate_capabilities(&manifest);

	persist_completed_preflight(
		&output,
		&manifest,
		report,
		observed_unix_ms,
		expires_unix_ms,
		model_toolchain.digest(),
	)?;

	Ok(())
}

fn run_permission_admission(
	mut options: PermissionAdmissionOptions,
) -> Result<(), Box<dyn std::error::Error>> {
	let observed_unix_ms = resume::unix_ms();
	let mut managed_profile = None;
	let assessment = (|| {
		let prepared = prepare_permission_admission(&mut options)?;
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
	let (report, denied) = match assessment {
		Ok(evidence) => {
			let permission_evidence_digest = evidence.combined_digest()?;
			let report = PermissionAdmissionReport {
				schema_version: "aiq.official-permission-admission.v1",
				official_permission_eligible: true,
				model_invoked: false,
				observed_unix_ms,
				managed_profile: Some(evidence.profile),
				permission_policy_digest: Some(evidence.digests.permission_policy_digest),
				canary_digest: Some(evidence.digests.canary_digest),
				permission_evidence_digest: Some(permission_evidence_digest),
				failure: None,
			};

			(report, false)
		},
		Err(error) => {
			let report = PermissionAdmissionReport {
				schema_version: "aiq.official-permission-admission.v1",
				official_permission_eligible: false,
				model_invoked: false,
				observed_unix_ms,
				managed_profile,
				permission_policy_digest: None,
				canary_digest: None,
				permission_evidence_digest: None,
				failure: Some(error.to_string()),
			};

			(report, true)
		},
	};

	write_json(&options.report_output, &report)?;

	if denied {
		return Err("Official permission admission denied; no model was invoked".into());
	}

	Ok(())
}

fn prepare_permission_admission(
	options: &mut PermissionAdmissionOptions,
) -> Result<PreparedPermissionAdmission, Box<dyn std::error::Error>> {
	if options.planned_output == Path::new("-") {
		return Err("Official permission admission requires a durable planned output".into());
	}
	match fs::symlink_metadata(&options.planned_output) {
		Err(error) if error.kind() == ErrorKind::NotFound => {},
		Err(error) => return Err(error.into()),
		Ok(_) => return Err("planned Official output must not exist before admission".into()),
	}

	let task_report = load_tasks(options.public_tasks.as_deref(), options.hidden_tasks.as_deref())?;

	if !task_report.issues.is_empty() {
		return Err("Official permission admission requires valid controlled tasks".into());
	}
	if task_report.tasks.len() != 72 {
		return Err("Official permission admission requires exactly 72 controlled tasks".into());
	}

	let corpus = corpus_commitment::validate_corpus_commitment(
		&options.corpus_commitment,
		&task_report.tasks,
		&options.source_root,
	)?;
	let evaluator_root = controlled_evaluator_root(&options.evaluator_root)?;
	let evaluator_runtime = EvaluatorRuntime::resolve(&options.evaluator_runtime)?;

	corpus.validate_evaluator_runtime(&evaluator_runtime)?;

	let model_toolchain =
		corpus.validate_model_toolchain(&options.codex_toolchain_root, &evaluator_runtime)?;

	validate_external_evaluator_bindings(&task_report.tasks, &evaluator_root, &evaluator_runtime)?;

	LocalDirectoryWorkspaceProvider::new(
		&options.workspace_root,
		&options.execution_root,
		corpus.baseline_workspace_digests().clone(),
	)?;

	let manifest = read_json::<CapabilityManifest>(&options.capabilities)?;
	let manifest_issues = adapter::validate_capability_manifest(&manifest);

	if !manifest_issues.is_empty() {
		return Err(
			format!("capability manifest is invalid: {}", manifest_issues.join("; ")).into()
		);
	}

	let _: ScheduleConfig = read_json(&options.schedule)?;
	PreflightCache::load(
		&options.preflight_cache,
		&manifest,
		resume::unix_ms(),
		model_toolchain.digest(),
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
		output: &options.planned_output,
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
			.with_egress_proxy(options.codex_egress_proxy.clone())
			.with_denied_roots(denied_roots)
			.with_model_toolchain(model_toolchain),
	);

	Ok(PreparedPermissionAdmission { adapter, execution_root, protected_paths })
}

fn run_validation(
	public_tasks: Option<PathBuf>,
	hidden_tasks: Option<PathBuf>,
	corpus_commitment: Option<PathBuf>,
	source_root: Option<PathBuf>,
	evaluator_root: Option<PathBuf>,
	evaluator_runtime: Option<PathBuf>,
	codex_toolchain_root: Option<PathBuf>,
) -> Result<(), Box<dyn std::error::Error>> {
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
		let corpus = corpus_commitment::validate_corpus_commitment(
			corpus_path,
			&task_report.tasks,
			source_root,
		)?;

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

fn parse_codex_egress_proxy(value: &str) -> Result<CodexEgressProxyEndpoint, String> {
	CodexEgressProxyEndpoint::parse(value).map_err(|error| error.to_string())
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

fn prepare_run(
	options: &RunOptions,
	preflight: PreflightCache,
) -> Result<PreparedRun, Box<dyn std::error::Error>> {
	let capability_validation = &preflight.report;
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
	let capacity_admission = assess_run_capacity(
		options,
		capability_validation,
		&selected_tasks,
		&selected_models,
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
		capacity_admission,
		slot,
		task_set_hash,
		run_id,
		preflight,
		execution_window: ExecutionWindow { scheduled_unix_ms, next_slot_unix_ms },
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
) -> Result<PreflightCache, Box<dyn std::error::Error>> {
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
		.with_model_toolchain(model_toolchain.clone())
		.with_egress_proxy(options.codex_egress_proxy.clone());
	let adapter = CodexAdapter::new(
		SystemExecutor,
		artifact_sink,
		controlled_codex_binary(&options.codex_binary)?,
		execution_config,
	);
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

	let preflight =
		load_run_preflight(&adapter, &manifest, options, force_refresh, model_toolchain.digest())?;

	capability_partition(&preflight.report)?;

	Ok(preflight)
}

fn resolve_run_evaluator_runtime(
	options: &RunOptions,
) -> Result<EvaluatorRuntime, Box<dyn std::error::Error>> {
	Ok(EvaluatorRuntime::resolve(&options.evaluator_runtime)?)
}

fn run_live(mut options: RunOptions) -> Result<(), Box<dyn std::error::Error>> {
	let preflight = freeze_run_preflight(&options)?;
	let prepared = prepare_run(&options, preflight)?;
	let PreparedRun {
		report,
		selected_models,
		corpus,
		capacity_admission,
		slot,
		task_set_hash,
		run_id,
		preflight,
		execution_window,
	} = prepared;
	let runtime = prepare_live_runtime(&mut options, &corpus, &report.tasks)?;
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

	complete_live_run(AuthorizedRun {
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
fn prepare_live_runtime(
	options: &mut RunOptions,
	corpus: &ValidatedCorpusCommitment,
	tasks: &[TaskDefinition],
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
	let future_entries = future_protected_entries(options);
	let adapter = CodexAdapter::new(
		SystemExecutor,
		artifact_sink,
		options.codex_binary.clone(),
		CodexExecutionConfig::isolated(options.codex_home.clone())
			.with_egress_proxy(options.codex_egress_proxy.clone())
			.with_denied_roots(denied_roots)
			.with_model_toolchain(model_toolchain.clone()),
	);
	let permission_evidence =
		verify_permission_evidence(&adapter, &execution_root, &protected_paths, options.run_class)?;
	let future_files = FutureProtectedFiles::prepare(&future_entries)?;

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

fn future_protected_entries(options: &RunOptions) -> Vec<(&'static str, &Path, bool)> {
	vec![
		("preflight_cache", options.preflight_cache.as_path(), false),
		("checkpoint", options.checkpoint.as_path(), false),
		("output", options.output.as_path(), options.run_class == RunClass::Official),
	]
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
		return Err("Official runs require an exclusive managed aiq_benchmark allowlist and managed default; no model was invoked".into());
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
		SelectedRun::Calibration(run) => write_json(output, &run),
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

fn complete_live_run(mut context: AuthorizedRun) -> Result<(), Box<dyn std::error::Error>> {
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

	write_selected_run_and_disarm(
		run,
		&report.tasks,
		&options,
		&mut future_files,
		&dispatch_deadline,
	)
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
		catalog_digest: resume::catalog_digest(),
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
		output: &options.output,
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
	push("output", inputs.output)?;

	Ok(paths)
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

		file.write_all(b"AIQ_ALLOWED\n")?;
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
	Ok(protocol::canonical_hash(&("aiq.permission-canary-evidence.v1", bindings, "passed"))?)
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
) -> Result<PreflightCache, Box<dyn std::error::Error>>
where
	E: Executor,
	S: ArtifactSink,
{
	let now_unix_ms = resume::unix_ms();

	if !force_refresh && options.preflight_cache.exists() {
		return PreflightCache::load(
			&options.preflight_cache,
			manifest,
			now_unix_ms,
			model_toolchain_digest,
		)
		.map_err(Into::into);
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
	)
}

fn persist_completed_preflight(
	cache_path: &Path,
	manifest: &CapabilityManifest,
	report: CapabilityValidationReport,
	observed_unix_ms: u64,
	expires_unix_ms: u64,
	model_toolchain_digest: &str,
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

	let cache =
		PreflightCache::new(manifest, attempt.report, expires_unix_ms, model_toolchain_digest)?;

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

fn run_score(
	public_tasks: Option<PathBuf>,
	hidden_tasks: Option<PathBuf>,
	results: PathBuf,
	bootstrap_samples: usize,
	bootstrap_seed: u64,
	output: PathBuf,
) -> Result<(), Box<dyn std::error::Error>> {
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
	if stage_output == attestation_output {
		return Err("stage and attestation outputs must use different paths".into());
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
	output: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
	let secret = signing_secret_from_environment(signing_key_env)?;
	let identity = SigningIdentity::from_secret(secret);
	let value = read_json::<serde_json::Value>(run_path)?;
	let schema = value.get("schema_version").and_then(serde_json::Value::as_str);
	let package = match schema {
		Some(schema) if schema == RUN_SCHEMA_VERSION => {
			let mut run: RunRecord = serde_json::from_value(value)?;

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
			let run: CalibrationRunRecord = serde_json::from_value(value)?;

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
			let package = protocol::canonical_json(&envelope)?;

			if package.len() > MAX_SIGNED_PACKAGE_BYTES {
				return Err("signed calibration package exceeds the package byte bound".into());
			}

			package
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
	allow_loopback_http: bool,
) -> Result<(), Box<dyn std::error::Error>> {
	let token = env::var(token_env)
		.map_err(|_| format!("submission token environment variable {token_env} is unset"))?;
	let transport = HttpsTransport::new(Duration::from_secs(timeout_seconds), allow_loopback_http);
	let package = fs::read(package)?;
	let token = SecretToken::new(token)?;
	let outcome = if allow_loopback_http {
		submission::submit_signed_package_with_artifacts_allowing_loopback(
			&transport,
			endpoint,
			package,
			artifact_root,
			token,
		)?
	} else {
		submission::submit_signed_package_with_artifacts(
			&transport,
			endpoint,
			package,
			artifact_root,
			token,
		)?
	};

	write_json(Path::new("-"), &outcome)?;

	Ok(())
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
				task_set_id: "aiq-core".to_owned(),
				task_set_version: "1.0.0".to_owned(),
				benchmark_version: "aiq-core@1.0.0".to_owned(),
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
		fs::write(path, bytes)?;
	}

	Ok(())
}

fn write_new_bytes(
	path: &Path,
	bytes: &[u8],
	label: &str,
) -> Result<File, Box<dyn std::error::Error>> {
	let mut options = OpenOptions::new();

	options.write(true).create_new(true);

	#[cfg(unix)]
	OpenOptionsExt::mode(&mut options, 0o600);

	let mut file =
		options.open(path).map_err(|error| format!("cannot create {label} output: {error}"))?;

	file.write_all(bytes)
		.and_then(|()| file.sync_all())
		.map_err(|error| format!("cannot persist {label} output: {error}"))?;

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
		.map_err(|error| format!("cannot remove created {label} file: {error}").into())
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
	use std::{
		cell::RefCell,
		fs,
		path::{Path, PathBuf},
		process,
		rc::Rc,
		time::{SystemTime, UNIX_EPOCH},
	};

	use crate::{
		adapter::{
			CodexAdapter, CodexExecutionConfig, CommandRequest, ExecutionCapture, Executor,
			ExecutorError, ManagedPermissionProfileEvidence,
		},
		cli,
		corpus_commitment::RunClass,
		runner::TestArtifactSink,
	};

	struct BoundaryExecutor {
		requests: Rc<RefCell<Vec<CommandRequest>>>,
	}

	impl Executor for BoundaryExecutor {
		fn execute(&self, request: &CommandRequest) -> Result<ExecutionCapture, ExecutorError> {
			self.requests.borrow_mut().push(request.clone());

			Err(ExecutorError::new("recording profile boundary reached"))
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

	fn expected_path(path: &Path) -> PathBuf {
		cli::canonical_policy_path(path).expect("canonical policy fixture")
	}

	fn ineligible_managed_profile() -> ManagedPermissionProfileEvidence {
		ManagedPermissionProfileEvidence {
			schema_version: "aiq.managed-permission-profile-evidence.v1".to_owned(),
			codex_version: "codex-cli 0.146.0".to_owned(),
			default_permissions: "aiq_benchmark".to_owned(),
			allowed_permission_profile: "aiq_benchmark".to_owned(),
			active_permission_profile: "aiq_benchmark".to_owned(),
			official_eligible: false,
			managed_requirements_status: "allowlist_not_exclusive".to_owned(),
			managed_requirements_digest: format!("sha256:{}", "a".repeat(64)),
			profile_selection_digest: format!("sha256:{}", "b".repeat(64)),
			evidence_digest: format!("sha256:{}", "c".repeat(64)),
		}
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
	fn official_permission_admission_rejects_ineligible_profile_before_canary_or_reservation() {
		let root = fixture_root("ineligible-admission");
		let workspace = root.join("workspace");
		let codex_home = root.join("codex-home");
		let planned_output = root.join("official.json");

		fs::create_dir_all(&workspace).expect("admission workspace");
		fs::create_dir_all(&codex_home).expect("Codex home fixture");

		let requests = Rc::new(RefCell::new(Vec::new()));
		let adapter = CodexAdapter::new(
			BoundaryExecutor { requests: Rc::clone(&requests) },
			TestArtifactSink,
			"codex",
			CodexExecutionConfig::isolated(codex_home),
		);
		let error = cli::verify_permission_evidence_with_profile(
			&adapter,
			&workspace,
			&[],
			RunClass::Official,
			ineligible_managed_profile(),
		)
		.expect_err("ineligible managed requirements must fail closed");

		assert!(error.to_string().contains("exclusive managed aiq_benchmark allowlist"));
		assert!(requests.borrow().is_empty(), "the sandbox canary must not run after denial");
		assert!(!planned_output.exists(), "permission denial must not reserve Official output");

		fs::remove_dir_all(root).expect("fixture cleanup");
	}

	#[test]
	fn permission_admission_protects_the_complete_runtime_path_set() {
		let root = fixture_root("admission-paths");
		let source = root.join("source");
		let baselines = root.join("baselines");
		let evaluators = root.join("evaluators");
		let artifacts = root.join("artifacts");
		let codex_home = root.join("codex-home");
		let tasks = root.join("tasks");
		let codex_binary = root.join("codex");
		let commitment = root.join("commitment.json");
		let capabilities = root.join("capabilities.json");
		let schedule = root.join("schedule.json");
		let preflight = root.join("preflight.json");
		let checkpoint = root.join("checkpoint.json");
		let output = root.join("official.json");

		for directory in [&source, &baselines, &evaluators, &artifacts, &codex_home, &tasks] {
			fs::create_dir_all(directory).expect("protected directory fixture");
		}
		for file in [&codex_binary, &commitment, &capabilities, &schedule, &preflight] {
			fs::write(file, b"fixture").expect("protected file fixture");
		}

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
			output: &output,
		})
		.expect("complete protected paths");
		let categories =
			protected.iter().map(|entry| entry.category).collect::<std::collections::BTreeSet<_>>();

		assert_eq!(
			categories,
			std::collections::BTreeSet::from([
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
			])
		);
		assert!(!checkpoint.exists());
		assert!(!output.exists());

		fs::remove_dir_all(root).expect("fixture cleanup");
	}
}
