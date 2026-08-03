use std::{
	cell::RefCell,
	collections::BTreeMap,
	env,
	fs::{self, DirEntry, File, OpenOptions, Permissions, TryLockError},
	io::Write as _,
	os::unix::fs::{MetadataExt as _, OpenOptionsExt as _, PermissionsExt as _},
	path::{Path, PathBuf},
	process,
	rc::Rc,
	slice,
	sync::{
		Arc,
		atomic::{AtomicUsize, Ordering},
	},
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use libc::O_NOFOLLOW;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::schedule::ScheduleConfig;
use crate::schedule::ScheduleOccurrence;
use crate::{
	adapter::{
		ArtifactSink, CodexAdapter, CodexExecutionConfig, CommandRequest, ExecutionCapture,
		Executor, ExecutorError, LocalArtifactSink, SandboxPolicy, SystemExecutor,
	},
	corpus_commitment::{self, ValidatedModelToolchain},
	isolation::{self, ProtectedBenchmarkPath},
	model::{CapabilityManifest, MODEL_MATRIX, ModelConfig},
	pinned_path::{PinnedDirectoryIdentity, PinnedPathIdentity},
	protocol,
	runner::{
		self, EvaluationOutcome, LocalDirectoryWorkspaceProvider, ResultStatus,
		TaskExecutionContext, TaskResult, TaskWorkspaceProvider, TestArtifactSink, WorkspaceError,
	},
	task::{
		DirectoryTaskSource, EvaluatorRuntime, TASK_SCHEMA_VERSION, TaskDefinition, TaskSource,
		Visibility,
	},
};

const PUBLIC_TASK_BYTES_SHA256: &str =
	"sha256:931567fe066e8bc72494f4c6562bbe0916cc4d37ef096c58362ea955b0b410b5";
const PUBLIC_TASK_ID: &str = "public-example-instruction-following-01";
const PUBLIC_RUN_ID: &str = "subscription_smoke_fixed_public_example";
const CONTROLLED_TASK_ID: &str = "documentation-communication-01";
const CONTROLLED_TASK_VERSION: &str = "1.0.2";
const CONTROLLED_RUN_ID: &str = "controlled_subscription_smoke_fixed_hidden_task";

static SMOKE_TEMP_SEQUENCE: AtomicUsize = AtomicUsize::new(0);

#[derive(Debug)]
struct PublicSmokeConfig {
	codex_binary: PathBuf,
	codex_home: PathBuf,
	toolchain_root: PathBuf,
	execution_lock: PathBuf,
	output: PathBuf,
}

#[derive(Debug)]
struct ControlledSmokeConfig {
	task_root: PathBuf,
	baseline_root: PathBuf,
	evaluator_root: PathBuf,
	evaluator_runtime: PathBuf,
	corpus_commitment: PathBuf,
	codex_binary: PathBuf,
	codex_home: PathBuf,
	permission_probe_binary: PathBuf,
	toolchain_root: PathBuf,
	execution_lock: PathBuf,
	execution_root: PathBuf,
	artifact_root: PathBuf,
	output: PathBuf,
}

#[derive(Debug)]
struct ControlledSmokeCommitments {
	corpus_release_id: String,
	corpus_commitment_sha256: String,
	task_definition_sha256: String,
	baseline_workspace_sha256: String,
	evaluator_binding_sha256: String,
	evaluator_executable_sha256: String,
	evaluator_runtime_sha256: String,
}

struct ControlledSmokeCorpus {
	release_id: String,
	commitment_sha256: String,
	baseline_workspace_sha256: String,
	model_toolchain: ValidatedModelToolchain,
}

#[derive(Debug, Serialize)]
#[serde(deny_unknown_fields)]
struct SmokeSummary {
	schema_version: &'static str,
	classification: &'static str,
	task_id: &'static str,
	model: String,
	task_definition_sha256: String,
	#[serde(skip_serializing_if = "Option::is_none")]
	corpus_release_id: Option<String>,
	#[serde(skip_serializing_if = "Option::is_none")]
	corpus_commitment_sha256: Option<String>,
	#[serde(skip_serializing_if = "Option::is_none")]
	baseline_workspace_sha256: Option<String>,
	#[serde(skip_serializing_if = "Option::is_none")]
	evaluator_binding_sha256: Option<String>,
	#[serde(skip_serializing_if = "Option::is_none")]
	evaluator_executable_sha256: Option<String>,
	#[serde(skip_serializing_if = "Option::is_none")]
	evaluator_runtime_sha256: Option<String>,
	codex_version: String,
	codex_binary_sha256: String,
	status: ResultStatus,
	outcome: EvaluationOutcome,
	task_score: f64,
	latency_ms: u64,
	model_invocation_attempt_count: usize,
	synthetic: bool,
	official_eligible: bool,
}

struct EmptyWorkspace {
	root: PathBuf,
}
impl TaskWorkspaceProvider for EmptyWorkspace {
	fn context(
		&self,
		run_id: &str,
		model: ModelConfig,
		task: &TaskDefinition,
	) -> Result<TaskExecutionContext, WorkspaceError> {
		if run_id != PUBLIC_RUN_ID || model != MODEL_MATRIX[0] || task.task_id != PUBLIC_TASK_ID {
			return Err(WorkspaceError::new("subscription smoke received a non-fixed cell"));
		}

		let workspace_dir = self.root.join("empty-workspace");

		fs::create_dir(&workspace_dir)
			.map_err(|error| WorkspaceError::new(format!("cannot create workspace: {error}")))?;

		let workspace_dir = fs::canonicalize(workspace_dir)
			.map_err(|error| WorkspaceError::new(format!("cannot resolve workspace: {error}")))?;

		Ok(TaskExecutionContext { workspace_dir, sandbox: SandboxPolicy::NoTools })
	}
}

struct CountingExecutor {
	attempts: Arc<AtomicUsize>,
}
impl Executor for CountingExecutor {
	fn execute(&self, request: &CommandRequest) -> Result<ExecutionCapture, ExecutorError> {
		self.attempts.fetch_add(1, Ordering::SeqCst);

		SystemExecutor.execute(request)
	}
}

struct RecordingExecutor {
	requests: Rc<RefCell<Vec<CommandRequest>>>,
	exit_code: i32,
	stdout: Vec<u8>,
}
impl Executor for RecordingExecutor {
	fn execute(&self, request: &CommandRequest) -> Result<ExecutionCapture, ExecutorError> {
		self.requests.borrow_mut().push(request.clone());

		Ok(ExecutionCapture {
			exit_code: Some(self.exit_code),
			stdout: self.stdout.clone(),
			stderr: Vec::new(),
			timed_out: false,
			stdout_truncated: false,
			stderr_truncated: false,
			budget_exceeded: None,
		})
	}
}

struct SmokeExecutionLock {
	file: File,
	path: PathBuf,
	identity: PinnedPathIdentity,
}
impl SmokeExecutionLock {
	fn acquire(path: &Path) -> Result<Self, String> {
		let path = path.to_owned();
		let mut options = OpenOptions::new();

		options.read(true).write(true).create(true).mode(0o600).custom_flags(O_NOFOLLOW);

		let file =
			options.open(&path).map_err(|error| format!("cannot open execution lock: {error}"))?;
		let metadata =
			file.metadata().map_err(|error| format!("cannot inspect execution lock: {error}"))?;

		if !metadata.is_file() || metadata.permissions().mode() & 0o077 != 0 {
			return Err("execution lock must be a private regular file".to_owned());
		}

		file.try_lock().map_err(|error| match error {
			TryLockError::WouldBlock => "execution lock is already held".to_owned(),
			TryLockError::Error(error) => format!("cannot acquire execution lock: {error}"),
		})?;

		let identity = PinnedPathIdentity::capture(&path, &file)
			.map_err(|error| format!("cannot pin execution lock: {error}"))?;

		identity
			.verify(&path, &file)
			.map_err(|error| format!("execution lock identity is unsafe: {error}"))?;

		Ok(Self { file, path, identity })
	}

	fn verify_held(&self) -> Result<(), String> {
		self.identity
			.verify(&self.path, &self.file)
			.map_err(|error| format!("execution lock identity changed: {error}"))
	}
}

impl Drop for SmokeExecutionLock {
	fn drop(&mut self) {
		let _ = self.file.unlock();
	}
}

struct SmokeTempRoot {
	path: PathBuf,
}
impl SmokeTempRoot {
	fn create(repository_root: &Path) -> Result<Self, String> {
		let suffix = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.map_err(|error| format!("subscription smoke clock unavailable: {error}"))?
			.as_nanos();
		let sequence = SMOKE_TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
		let path = repository_root
			.join("target")
			.join(format!("aiq-subscription-smoke-{}-{suffix}-{sequence}", process::id()));

		fs::create_dir(&path)
			.map_err(|error| format!("cannot create subscription smoke root: {error}"))?;

		if let Err(error) = fs::set_permissions(&path, Permissions::from_mode(0o700)) {
			let _ = fs::remove_dir(&path);

			return Err(format!("cannot restrict subscription smoke root: {error}"));
		}

		Ok(Self { path })
	}

	fn path(&self) -> &Path {
		&self.path
	}
}

impl Drop for SmokeTempRoot {
	fn drop(&mut self) {
		let _ = fs::remove_dir_all(&self.path);
	}
}

struct ControlledSmokeArtifactCanary {
	path: PathBuf,
	file: File,
	identity: PinnedPathIdentity,
}
impl ControlledSmokeArtifactCanary {
	fn create(artifact_root: &Path) -> Result<Self, String> {
		let path = artifact_root.join(".aiq-controlled-smoke-denied-canary");
		let parent_identity = PinnedDirectoryIdentity::capture(artifact_root).map_err(|error| {
			format!("cannot pin controlled smoke artifact root before canary creation: {error}")
		})?;
		let mut options = OpenOptions::new();

		options.read(true).write(true).create_new(true).mode(0o600).custom_flags(O_NOFOLLOW);

		let file = options
			.open(&path)
			.map_err(|error| format!("cannot create controlled smoke artifact canary: {error}"))?;
		let identity = match PinnedPathIdentity::capture(&path, &file) {
			Ok(identity) => identity,
			Err(error) => {
				let primary = format!("cannot pin controlled smoke artifact canary: {error}");

				return Err(
					match cleanup_exact_empty_created_file(&parent_identity, &path, &file) {
						Ok(()) => primary,
						Err(cleanup_error) => format!("{primary}; cleanup failed: {cleanup_error}"),
					},
				);
			},
		};
		let canary = Self { path, file, identity };

		if let Err(error) = canary
			.file
			.try_clone()
			.and_then(|mut file| file.write_all(b"AIQ_DENIED\n").and_then(|()| file.sync_all()))
		{
			let primary = format!("cannot persist controlled smoke artifact canary: {error}");

			return Err(match canary.cleanup_allowing_prefix() {
				Ok(()) => primary,
				Err(cleanup_error) => format!("{primary}; cleanup failed: {cleanup_error}"),
			});
		}

		Ok(canary)
	}

	fn cleanup(self) -> Result<(), String> {
		self.cleanup_inner(false)
	}

	fn cleanup_allowing_prefix(self) -> Result<(), String> {
		self.cleanup_inner(true)
	}

	fn cleanup_inner(self, allow_prefix: bool) -> Result<(), String> {
		self.identity
			.verify(&self.path, &self.file)
			.map_err(|error| format!("cannot verify controlled smoke artifact canary: {error}"))?;

		let bytes = fs::read(&self.path)
			.map_err(|error| format!("cannot read controlled smoke artifact canary: {error}"))?;

		if (allow_prefix && !b"AIQ_DENIED\n".starts_with(&bytes))
			|| (!allow_prefix && bytes != b"AIQ_DENIED\n")
		{
			return Err("controlled smoke artifact canary changed before cleanup".to_owned());
		}

		self.identity.verify(&self.path, &self.file).map_err(|error| {
			format!("cannot reverify controlled smoke artifact canary: {error}")
		})?;

		fs::remove_file(&self.path)
			.map_err(|error| format!("cannot remove controlled smoke artifact canary: {error}"))
	}
}

struct ControlledSmokePermissionWorkspace {
	path: PathBuf,
	identity: PinnedDirectoryIdentity,
	allowed_path: PathBuf,
	allowed_file: File,
	allowed_identity: PinnedPathIdentity,
}
impl ControlledSmokePermissionWorkspace {
	fn create(execution_root: &Path) -> Result<Self, String> {
		let path = execution_root.join(".permission-admission");

		fs::create_dir(&path)
			.map_err(|error| format!("cannot create permission workspace: {error}"))?;

		if let Err(error) = fs::set_permissions(&path, Permissions::from_mode(0o700)) {
			return Err(cleanup_new_directory_error(
				&path,
				format!("cannot set permission workspace mode: {error}"),
			));
		}

		let identity = PinnedDirectoryIdentity::capture(&path).map_err(|error| {
			cleanup_new_directory_error(
				&path,
				format!("cannot pin controlled smoke permission workspace: {error}"),
			)
		})?;
		let allowed_path = path.join("allowed.txt");
		let mut options = OpenOptions::new();

		options.read(true).write(true).create_new(true).mode(0o600).custom_flags(O_NOFOLLOW);

		let allowed_file = match options.open(&allowed_path) {
			Ok(file) => file,
			Err(error) => {
				return Err(cleanup_pinned_directory_error(
					&identity,
					format!("cannot create allowed permission canary: {error}"),
				));
			},
		};
		let allowed_identity = match PinnedPathIdentity::capture(&allowed_path, &allowed_file) {
			Ok(identity) => identity,
			Err(error) => {
				let primary =
					format!("cannot pin controlled smoke allowed permission canary: {error}");
				let cleanup =
					cleanup_exact_empty_created_file(&identity, &allowed_path, &allowed_file)
						.and_then(|()| identity.verify())
						.and_then(|()| fs::remove_dir(&path).map_err(|error| error.to_string()));

				return Err(match cleanup {
					Ok(()) => primary,
					Err(cleanup_error) => format!("{primary}; cleanup failed: {cleanup_error}"),
				});
			},
		};
		let workspace = Self { path, identity, allowed_path, allowed_file, allowed_identity };

		if let Err(error) = workspace
			.allowed_file
			.try_clone()
			.and_then(|mut file| file.write_all(b"AIQ_ALLOWED\n").and_then(|()| file.sync_all()))
		{
			let primary = format!("cannot persist allowed permission canary: {error}");

			return Err(match workspace.cleanup_allowing_prefix() {
				Ok(()) => primary,
				Err(cleanup_error) => format!("{primary}; cleanup failed: {cleanup_error}"),
			});
		}

		Ok(workspace)
	}

	fn allowed_path(&self) -> &Path {
		&self.allowed_path
	}

	fn writable_path(&self) -> PathBuf {
		self.path.join("writable.txt")
	}

	fn cleanup(self) -> Result<(), String> {
		self.cleanup_inner(false)
	}

	fn cleanup_allowing_prefix(self) -> Result<(), String> {
		self.cleanup_inner(true)
	}

	fn cleanup_inner(self, allow_prefix: bool) -> Result<(), String> {
		self.identity.verify().map_err(|error| {
			format!("cannot verify controlled smoke permission workspace: {error}")
		})?;
		self.allowed_identity.verify(&self.allowed_path, &self.allowed_file).map_err(|error| {
			format!("cannot verify controlled smoke allowed permission canary: {error}")
		})?;

		let bytes = fs::read(&self.allowed_path).map_err(|error| {
			format!("cannot read controlled smoke allowed permission canary: {error}")
		})?;

		if (allow_prefix && !b"AIQ_ALLOWED\n".starts_with(&bytes))
			|| (!allow_prefix && bytes != b"AIQ_ALLOWED\n")
		{
			return Err(
				"controlled smoke allowed permission canary changed before cleanup".to_owned()
			);
		}

		self.allowed_identity.verify(&self.allowed_path, &self.allowed_file).map_err(|error| {
			format!("cannot reverify controlled smoke allowed permission canary: {error}")
		})?;

		fs::remove_file(&self.allowed_path).map_err(|error| {
			format!("cannot remove controlled smoke allowed permission canary: {error}")
		})?;

		self.identity.verify().map_err(|error| {
			format!("cannot reverify controlled smoke permission workspace: {error}")
		})?;

		fs::remove_dir(&self.path).map_err(|error| {
			format!("cannot remove controlled smoke permission workspace: {error}")
		})
	}
}

#[derive(Clone, Copy)]
enum InputKind {
	Directory,
	Executable,
	RegularFile,
}

fn cleanup_exact_empty_created_file(
	parent_identity: &PinnedDirectoryIdentity,
	path: &Path,
	file: &File,
) -> Result<(), String> {
	parent_identity
		.verify()
		.map_err(|error| format!("created file parent identity changed: {error}"))?;

	if path.parent() != Some(parent_identity.path()) {
		return Err("created file parent path changed".to_owned());
	}

	let held = file.metadata().map_err(|error| format!("cannot inspect created file: {error}"))?;
	let current = fs::symlink_metadata(path)
		.map_err(|error| format!("cannot inspect created file path: {error}"))?;

	if !held.is_file()
		|| !current.is_file()
		|| current.file_type().is_symlink()
		|| held.len() != 0
		|| current.len() != 0
		|| held.nlink() != 1
		|| current.nlink() != 1
		|| held.dev() != current.dev()
		|| held.ino() != current.ino()
	{
		return Err("created empty file identity changed before cleanup".to_owned());
	}

	parent_identity
		.verify()
		.map_err(|error| format!("created file parent identity changed before cleanup: {error}"))?;

	fs::remove_file(path)
		.map_err(|error| format!("cannot remove exact created empty file: {error}"))
}

fn require_chatgpt_subscription(
	codex_binary: &Path,
	config: &CodexExecutionConfig,
) -> Result<(), String> {
	let capture = SystemExecutor
		.execute(&chatgpt_subscription_request(codex_binary, config))
		.map_err(|error| format!("cannot probe Codex login: {error}"))?;
	let stdout = String::from_utf8(capture.stdout)
		.map_err(|_| "Codex login probe returned invalid stdout".to_owned())?;
	let stderr = String::from_utf8(capture.stderr)
		.map_err(|_| "Codex login probe returned invalid stderr".to_owned())?;

	if capture.exit_code != Some(0)
		|| capture.timed_out
		|| capture.stdout_truncated
		|| capture.stderr_truncated
		|| ![stdout.trim(), stderr.trim()].contains(&"Logged in using ChatGPT")
	{
		return Err("Codex login is not a recognized ChatGPT subscription".to_owned());
	}

	Ok(())
}

fn chatgpt_subscription_request(
	codex_binary: &Path,
	config: &CodexExecutionConfig,
) -> CommandRequest {
	let mut environment = config.allowed_environment.clone();

	environment.insert("CODEX_HOME".to_owned(), config.codex_home.display().to_string());

	for key in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]
	{
		environment.remove(key);
	}

	environment.remove("NO_PROXY");
	environment.remove("no_proxy");
	CommandRequest {
		program: codex_binary.display().to_string(),
		args: vec!["login".to_owned(), "status".to_owned()],
		stdin: Vec::new(),
		timeout: Duration::from_secs(10),
		max_capture_bytes: 4_096,
		max_steps: u32::MAX,
		max_tool_calls: u32::MAX,
		clear_environment: true,
		environment,
	}
}

fn create_private_artifact_root(path: PathBuf) -> Result<PathBuf, String> {
	create_private_output_root(path, "artifact")
}

fn create_private_execution_root(path: PathBuf) -> Result<PathBuf, String> {
	create_private_output_root(path, "execution")
}

fn create_private_output_root(path: PathBuf, label: &str) -> Result<PathBuf, String> {
	fs::create_dir(&path)
		.map_err(|error| format!("cannot create controlled smoke {label} root: {error}"))?;

	if let Err(error) = fs::set_permissions(&path, Permissions::from_mode(0o700)) {
		let _ = fs::remove_dir(&path);

		return Err(format!("cannot restrict controlled smoke {label} root: {error}"));
	}

	Ok(path)
}

fn canonical_input(
	values: &BTreeMap<String, String>,
	name: &str,
	kind: InputKind,
) -> Result<PathBuf, String> {
	let path = PathBuf::from(
		values
			.get(name)
			.filter(|value| !value.is_empty())
			.ok_or_else(|| format!("{name} is required for the paid subscription smoke"))?,
	);

	if !path.is_absolute() {
		return Err(format!("{name} must be absolute"));
	}

	let metadata =
		fs::symlink_metadata(&path).map_err(|error| format!("{name} is unavailable: {error}"))?;
	let correct_kind = match kind {
		InputKind::Directory => metadata.is_dir(),
		InputKind::Executable | InputKind::RegularFile => metadata.is_file(),
	};

	if metadata.file_type().is_symlink() || !correct_kind {
		return Err(format!("{name} must be an ordinary input of the required type"));
	}
	if matches!(kind, InputKind::Executable) && metadata.permissions().mode() & 0o111 == 0 {
		return Err(format!("{name} must be executable"));
	}

	let canonical =
		fs::canonicalize(&path).map_err(|error| format!("{name} is unavailable: {error}"))?;

	if canonical != path {
		return Err(format!("{name} must already be canonical"));
	}

	Ok(canonical)
}

fn canonical_output(
	values: &BTreeMap<String, String>,
	name: &str,
	must_be_absent: bool,
) -> Result<PathBuf, String> {
	let path = PathBuf::from(
		values
			.get(name)
			.filter(|value| !value.is_empty())
			.ok_or_else(|| format!("{name} is required for the paid subscription smoke"))?,
	);

	if !path.is_absolute() {
		return Err(format!("{name} must be absolute"));
	}

	let parent = path.parent().ok_or_else(|| format!("{name} has no parent"))?;
	let metadata = fs::symlink_metadata(parent)
		.map_err(|error| format!("{name} parent is unavailable: {error}"))?;

	if metadata.file_type().is_symlink() || !metadata.is_dir() {
		return Err(format!("{name} parent must be an ordinary directory"));
	}

	let canonical_parent = fs::canonicalize(parent)
		.map_err(|error| format!("{name} parent is unavailable: {error}"))?;
	let file_name = path.file_name().ok_or_else(|| format!("{name} has no file name"))?;

	if canonical_parent.join(file_name) != path {
		return Err(format!("{name} must already be canonical"));
	}
	if must_be_absent && fs::symlink_metadata(&path).is_ok() {
		return Err(format!("{name} must name a new output"));
	}

	Ok(path)
}

fn public_smoke_guard(values: &BTreeMap<String, String>) -> Result<PublicSmokeConfig, String> {
	if values.get("AIQ_ALLOW_PAID_SUBSCRIPTION_SMOKE").map(String::as_str) != Some("1") {
		return Err("AIQ_ALLOW_PAID_SUBSCRIPTION_SMOKE=1 is required".to_owned());
	}

	let codex_binary = canonical_input(values, "AIQ_REAL_CODEX_BINARY", InputKind::Executable)?;
	let codex_home = canonical_input(values, "AIQ_REAL_CODEX_HOME", InputKind::Directory)?;
	let toolchain_root =
		canonical_input(values, "AIQ_REAL_CODEX_TOOLCHAIN_ROOT", InputKind::Directory)?;
	let execution_lock = canonical_output(values, "AIQ_SUBSCRIPTION_SMOKE_EXECUTION_LOCK", false)?;
	let output = canonical_output(values, "AIQ_SUBSCRIPTION_SMOKE_OUTPUT", true)?;

	Ok(PublicSmokeConfig { codex_binary, codex_home, toolchain_root, execution_lock, output })
}

fn controlled_smoke_guard(
	values: &BTreeMap<String, String>,
) -> Result<ControlledSmokeConfig, String> {
	if values.get("AIQ_ALLOW_PAID_CONTROLLED_SUBSCRIPTION_SMOKE").map(String::as_str) != Some("1") {
		return Err("AIQ_ALLOW_PAID_CONTROLLED_SUBSCRIPTION_SMOKE=1 is required".to_owned());
	}

	let directory = |name| canonical_input(values, name, InputKind::Directory);
	let executable = |name| canonical_input(values, name, InputKind::Executable);
	let task_root = directory("AIQ_CONTROLLED_SUBSCRIPTION_SMOKE_TASK_ROOT")?;
	let baseline_root = directory("AIQ_CONTROLLED_SUBSCRIPTION_SMOKE_BASELINE_ROOT")?;
	let evaluator_root = directory("AIQ_CONTROLLED_SUBSCRIPTION_SMOKE_EVALUATOR_ROOT")?;
	let evaluator_runtime = executable("AIQ_CONTROLLED_SUBSCRIPTION_SMOKE_EVALUATOR_RUNTIME")?;
	let corpus_commitment = canonical_input(
		values,
		"AIQ_CONTROLLED_SUBSCRIPTION_SMOKE_CORPUS_COMMITMENT",
		InputKind::RegularFile,
	)?;
	let codex_binary = executable("AIQ_REAL_CODEX_BINARY")?;
	let codex_home = directory("AIQ_REAL_CODEX_HOME")?;
	let permission_probe_binary = executable("AIQ_REAL_PERMISSION_PROBE_BINARY")?;
	let toolchain_root = directory("AIQ_REAL_CODEX_TOOLCHAIN_ROOT")?;
	let execution_lock = canonical_output(values, "AIQ_SUBSCRIPTION_SMOKE_EXECUTION_LOCK", false)?;
	let execution_root =
		canonical_output(values, "AIQ_CONTROLLED_SUBSCRIPTION_SMOKE_EXECUTION_ROOT", true)?;
	let artifact_root =
		canonical_output(values, "AIQ_CONTROLLED_SUBSCRIPTION_SMOKE_ARTIFACT_ROOT", true)?;
	let output = canonical_output(values, "AIQ_CONTROLLED_SUBSCRIPTION_SMOKE_OUTPUT", true)?;

	for (left, right) in
		[(&execution_root, &artifact_root), (&execution_root, &output), (&artifact_root, &output)]
	{
		if left.starts_with(right) || right.starts_with(left) {
			return Err("controlled smoke execution, artifact, and summary paths must be separate"
				.to_owned());
		}
	}

	Ok(ControlledSmokeConfig {
		task_root,
		baseline_root,
		evaluator_root,
		evaluator_runtime,
		corpus_commitment,
		codex_binary,
		codex_home,
		permission_probe_binary,
		toolchain_root,
		execution_lock,
		execution_root,
		artifact_root,
		output,
	})
}

fn controlled_smoke_denied_roots(
	config: &ControlledSmokeConfig,
	repository_root: &Path,
	model_toolchain_root: &Path,
) -> Result<Vec<PathBuf>, String> {
	let protected = vec![
		ProtectedBenchmarkPath { category: "repository_source", path: repository_root.to_owned() },
		ProtectedBenchmarkPath { category: "codex_home", path: config.codex_home.clone() },
		ProtectedBenchmarkPath { category: "hidden_tasks", path: config.task_root.clone() },
		ProtectedBenchmarkPath {
			category: "workspace_baselines",
			path: config.baseline_root.clone(),
		},
		ProtectedBenchmarkPath {
			category: "evaluator_registry",
			path: config.evaluator_root.clone(),
		},
		ProtectedBenchmarkPath {
			category: "corpus_commitment",
			path: config.corpus_commitment.clone(),
		},
		ProtectedBenchmarkPath { category: "artifact_root", path: config.artifact_root.clone() },
	];
	let resolved = protected
		.iter()
		.map(|entry| {
			isolation::resolve_policy_path(&entry.path).map(|path| (entry.category, path)).map_err(
				|error| {
					format!(
						"controlled smoke protected category {} is invalid: {error}",
						entry.category
					)
				},
			)
		})
		.collect::<Result<Vec<_>, _>>()?;

	for (index, (left_category, left)) in resolved.iter().enumerate() {
		for (right_category, right) in &resolved[index + 1..] {
			if left.starts_with(right) || right.starts_with(left) {
				return Err(format!(
					"controlled smoke protected categories {left_category} and {right_category} must use separate roots"
				));
			}
		}
	}

	isolation::validate_protected_layout(
		&protected,
		Some(&config.execution_root),
		&[model_toolchain_root.to_owned()],
	)
	.map_err(|error| format!("controlled smoke isolation layout is invalid: {error}"))?;

	Ok(protected.into_iter().map(|entry| entry.path).collect())
}

fn controlled_smoke_denied_canaries(
	denied_roots: &[PathBuf],
	artifact_root: &Path,
) -> Result<(Vec<PathBuf>, ControlledSmokeArtifactCanary), String> {
	let artifact_canary = ControlledSmokeArtifactCanary::create(artifact_root)?;
	let canaries = denied_roots
		.iter()
		.map(|root| {
			if root == artifact_root {
				fs::canonicalize(&artifact_canary.path)
					.map_err(|error| format!("cannot resolve artifact canary: {error}"))
			} else {
				find_controlled_smoke_canary(root)
			}
		})
		.collect::<Result<Vec<_>, _>>();

	match canaries {
		Ok(canaries) => Ok((canaries, artifact_canary)),
		Err(error) => match artifact_canary.cleanup() {
			Ok(()) => Err(error),
			Err(cleanup_error) => Err(format!("{error}; cleanup failed: {cleanup_error}")),
		},
	}
}

fn find_controlled_smoke_canary(root: &Path) -> Result<PathBuf, String> {
	let metadata = fs::symlink_metadata(root)
		.map_err(|error| format!("controlled smoke denied root is unavailable: {error}"))?;

	if metadata.file_type().is_symlink() {
		return Err("controlled smoke denied root must not be a symlink".to_owned());
	}
	if metadata.is_file() {
		return fs::canonicalize(root)
			.map_err(|error| format!("cannot resolve controlled smoke denied file: {error}"));
	}

	let mut pending = vec![(root.to_owned(), 0_u8)];
	let mut inspected = 0_usize;

	while let Some((directory, depth)) = pending.pop() {
		let mut entries = fs::read_dir(&directory)
			.map_err(|error| format!("cannot inspect controlled smoke denied root: {error}"))?
			.collect::<Result<Vec<_>, _>>()
			.map_err(|error| format!("cannot inspect controlled smoke denied root: {error}"))?;

		entries.sort_by_key(DirEntry::file_name);

		for entry in entries {
			inspected = inspected
				.checked_add(1)
				.ok_or_else(|| "controlled smoke canary traversal overflowed".to_owned())?;

			if inspected > 4_096 {
				return Err("controlled smoke canary traversal exceeded 4,096 entries".to_owned());
			}

			let path = entry.path();
			let metadata = fs::symlink_metadata(&path)
				.map_err(|error| format!("cannot inspect controlled smoke canary: {error}"))?;

			if metadata.file_type().is_symlink() {
				continue;
			}
			if metadata.is_file() {
				return fs::canonicalize(path)
					.map_err(|error| format!("cannot resolve controlled smoke canary: {error}"));
			}
			if metadata.is_dir() && depth < 8 {
				pending.push((path, depth + 1));
			}
		}
	}

	Err(format!("controlled smoke denied root has no regular file: {}", root.display()))
}

fn cleanup_new_directory_error(path: &Path, primary: String) -> String {
	match fs::remove_dir(path) {
		Ok(()) => primary,
		Err(error) => format!("{primary}; cleanup failed: {error}"),
	}
}

fn cleanup_pinned_directory_error(identity: &PinnedDirectoryIdentity, primary: String) -> String {
	let cleanup = identity
		.verify()
		.and_then(|()| fs::remove_dir(identity.path()).map_err(|error| error.to_string()));

	match cleanup {
		Ok(()) => primary,
		Err(error) => format!("{primary}; cleanup failed: {error}"),
	}
}

fn load_controlled_task(task_root: &Path) -> Result<TaskDefinition, String> {
	let report = DirectoryTaskSource::new(task_root, Some(Visibility::Hidden)).load();

	if !report.issues.is_empty() {
		return Err(format!("controlled hidden task failed validation: {:?}", report.issues));
	}
	if report.tasks.len() != 1 {
		return Err(format!("controlled task root has {} tasks; expected one", report.tasks.len()));
	}

	let task = report
		.tasks
		.into_iter()
		.next()
		.ok_or_else(|| "controlled hidden task root is empty".to_owned())?;

	if task.schema_version != TASK_SCHEMA_VERSION
		|| task.task_id != CONTROLLED_TASK_ID
		|| task.task_version != CONTROLLED_TASK_VERSION
		|| task.visibility != Visibility::Hidden
		|| task.evaluator.as_ref().and_then(|value| value.external.as_ref()).is_none()
		|| !task.validation_issues().is_empty()
	{
		return Err(
			"controlled smoke requires the fixed valid hidden task and evaluator".to_owned()
		);
	}

	Ok(task)
}

fn load_controlled_corpus(
	path: &Path,
	task: &TaskDefinition,
	source_root: &Path,
	runtime: &EvaluatorRuntime,
	toolchain_root: &Path,
) -> Result<ControlledSmokeCorpus, String> {
	let selected = slice::from_ref(task);
	let commitment = corpus_commitment::validate_corpus_commitment(path, selected, source_root)
		.map_err(|error| format!("controlled corpus commitment is invalid: {error}"))?;

	commitment.validate_evaluator_runtime(runtime).map_err(|error| error.to_string())?;

	let model_toolchain = commitment
		.validate_model_toolchain(toolchain_root, runtime)
		.map_err(|error| error.to_string())?;
	let baseline_workspace_sha256 = commitment
		.baseline_workspace_digests()
		.get(CONTROLLED_TASK_ID)
		.cloned()
		.ok_or_else(|| "corpus commitment lacks the fixed baseline".to_owned())?;

	Ok(ControlledSmokeCorpus {
		release_id: commitment.release_id().to_owned(),
		commitment_sha256: commitment.canonical_sha256().to_owned(),
		baseline_workspace_sha256,
		model_toolchain,
	})
}

fn controlled_commitments(
	task: &TaskDefinition,
	config: &ControlledSmokeConfig,
	runtime: &EvaluatorRuntime,
	corpus: &ControlledSmokeCorpus,
) -> Result<ControlledSmokeCommitments, String> {
	let evaluator =
		task.evaluator.as_ref().and_then(|value| value.external.as_ref()).ok_or_else(|| {
			"controlled smoke task lacks an external evaluator binding".to_owned()
		})?;

	evaluator
		.validate_registry(&config.evaluator_root)
		.map_err(|error| format!("controlled evaluator commitment is invalid: {error}"))?;

	if evaluator.runtime_executable_digest != runtime.executable_digest() {
		return Err("controlled evaluator runtime does not match the task".to_owned());
	}

	let baseline = config.baseline_root.join(CONTROLLED_TASK_ID);
	let metadata = fs::symlink_metadata(&baseline)
		.map_err(|error| format!("controlled baseline is unavailable: {error}"))?;

	if metadata.file_type().is_symlink() || !metadata.is_dir() {
		return Err("controlled baseline must be an ordinary directory".to_owned());
	}

	let baseline_workspace_sha256 = protocol::canonical_hash(
		&runner::build_workspace_manifest(&baseline)
			.map_err(|error| format!("cannot compute controlled baseline commitment: {error}"))?,
	)
	.map_err(|error| error.to_string())?;

	if baseline_workspace_sha256 != corpus.baseline_workspace_sha256 {
		return Err("controlled baseline does not match its corpus commitment".to_owned());
	}

	Ok(ControlledSmokeCommitments {
		corpus_release_id: corpus.release_id.clone(),
		corpus_commitment_sha256: corpus.commitment_sha256.clone(),
		task_definition_sha256: task.content_hash().map_err(|error| error.to_string())?,
		baseline_workspace_sha256,
		evaluator_binding_sha256: protocol::canonical_hash(
			task.evaluator.as_ref().ok_or_else(|| "task evaluator is missing".to_owned())?,
		)
		.map_err(|error| error.to_string())?,
		evaluator_executable_sha256: evaluator.executable_digest.clone(),
		evaluator_runtime_sha256: runtime.executable_digest().to_owned(),
	})
}

fn checked_attempt_count(attempts: &AtomicUsize) -> Result<usize, String> {
	let attempts = attempts.load(Ordering::SeqCst);

	if attempts != 1 {
		return Err(format!("smoke requires exactly one model attempt; observed {attempts}"));
	}

	Ok(attempts)
}

fn checked_score(result: &TaskResult) -> Result<f64, String> {
	if result.status != ResultStatus::Completed || result.provenance.synthetic {
		return Err("smoke requires a completed non-synthetic result".to_owned());
	}

	let score = result
		.task_score
		.filter(|score| score.is_finite() && (0.0..=1.0).contains(score))
		.ok_or_else(|| "smoke result lacks a valid score".to_owned())?;
	let consistent = match result.evaluation {
		EvaluationOutcome::Correct => score == 1.0,
		EvaluationOutcome::Partial => score > 0.0 && score < 1.0,
		EvaluationOutcome::Incorrect => score == 0.0,
		EvaluationOutcome::NotEvaluated => false,
	};

	if !consistent {
		return Err("smoke outcome and score are inconsistent".to_owned());
	}

	Ok(score)
}

fn public_summary(
	task: &TaskDefinition,
	result: &TaskResult,
	codex_version: String,
	codex_binary_sha256: String,
	attempts: usize,
) -> Result<SmokeSummary, String> {
	if attempts != 1 || result.evaluation != EvaluationOutcome::Correct {
		return Err("public smoke requires one correct model attempt".to_owned());
	}

	Ok(SmokeSummary {
		schema_version: "aiq.subscription-smoke.v1",
		classification: "local_subscription_smoke_non_official",
		task_id: PUBLIC_TASK_ID,
		model: MODEL_MATRIX[0].key(),
		task_definition_sha256: task.content_hash().map_err(|error| error.to_string())?,
		corpus_release_id: None,
		corpus_commitment_sha256: None,
		baseline_workspace_sha256: None,
		evaluator_binding_sha256: None,
		evaluator_executable_sha256: None,
		evaluator_runtime_sha256: None,
		codex_version,
		codex_binary_sha256,
		status: result.status,
		outcome: result.evaluation,
		task_score: checked_score(result)?,
		latency_ms: result.latency.wall_ms,
		model_invocation_attempt_count: attempts,
		synthetic: false,
		official_eligible: false,
	})
}

fn controlled_summary(
	result: &TaskResult,
	commitments: ControlledSmokeCommitments,
	codex_version: String,
	codex_binary_sha256: String,
	attempts: usize,
) -> Result<SmokeSummary, String> {
	if attempts != 1 {
		return Err("controlled smoke requires exactly one model attempt".to_owned());
	}

	Ok(SmokeSummary {
		schema_version: "aiq.controlled-subscription-smoke.v1",
		classification: "local_controlled_subscription_smoke_non_official",
		task_id: CONTROLLED_TASK_ID,
		model: MODEL_MATRIX[0].key(),
		task_definition_sha256: commitments.task_definition_sha256,
		corpus_release_id: Some(commitments.corpus_release_id),
		corpus_commitment_sha256: Some(commitments.corpus_commitment_sha256),
		baseline_workspace_sha256: Some(commitments.baseline_workspace_sha256),
		evaluator_binding_sha256: Some(commitments.evaluator_binding_sha256),
		evaluator_executable_sha256: Some(commitments.evaluator_executable_sha256),
		evaluator_runtime_sha256: Some(commitments.evaluator_runtime_sha256),
		codex_version,
		codex_binary_sha256,
		status: result.status,
		outcome: result.evaluation,
		task_score: checked_score(result)?,
		latency_ms: result.latency.wall_ms,
		model_invocation_attempt_count: attempts,
		synthetic: false,
		official_eligible: false,
	})
}

fn verify_controlled_smoke_permission_admission(
	config: &ControlledSmokeConfig,
	execution_config: &CodexExecutionConfig,
	artifacts: &LocalArtifactSink,
) -> Result<String, String> {
	require_chatgpt_subscription(&config.codex_binary, execution_config)?;

	let permission_adapter = CodexAdapter::new(
		SystemExecutor,
		artifacts.clone(),
		config.codex_binary.display().to_string(),
		execution_config.clone(),
	);
	let codex_version = permission_adapter.probe_version().map_err(|error| error.to_string())?;
	let managed_profile = permission_adapter
		.verify_managed_permission_profile(&config.execution_root)
		.map_err(|error| error.to_string())?;

	if !managed_profile.official_eligible
		|| managed_profile.managed_requirements_status != "exact"
		|| managed_profile.default_permissions != "aiq_benchmark"
		|| managed_profile.allowed_permission_profile != "aiq_benchmark"
		|| managed_profile.active_permission_profile != "aiq_benchmark"
	{
		return Err(
			"controlled smoke did not observe the exact Official managed requirements".to_owned()
		);
	}

	verify_controlled_smoke_permission_canaries(
		&permission_adapter,
		&execution_config.denied_roots,
		&config.artifact_root,
		&config.execution_root,
	)?;

	Ok(codex_version)
}

fn verify_controlled_smoke_permission_canaries<E, S>(
	adapter: &CodexAdapter<E, S>,
	denied_roots: &[PathBuf],
	artifact_root: &Path,
	execution_root: &Path,
) -> Result<(), String>
where
	E: Executor,
	S: ArtifactSink,
{
	let (denied_canaries, artifact_canary) =
		controlled_smoke_denied_canaries(denied_roots, artifact_root)?;
	let workspace = match ControlledSmokePermissionWorkspace::create(execution_root) {
		Ok(workspace) => workspace,
		Err(error) => {
			return combine_operation_and_cleanup(Err(error), [artifact_canary.cleanup()]);
		},
	};
	let writable_path = workspace.writable_path();
	let operation = adapter
		.verify_permission_boundary(
			&workspace.path,
			workspace.allowed_path(),
			&denied_canaries,
			&writable_path,
		)
		.map_err(|error| error.to_string());
	let workspace_cleanup = workspace.cleanup();
	let artifact_cleanup = artifact_canary.cleanup();

	combine_operation_and_cleanup(operation, [workspace_cleanup, artifact_cleanup])
}

fn combine_operation_and_cleanup(
	operation: Result<(), String>,
	cleanups: impl IntoIterator<Item = Result<(), String>>,
) -> Result<(), String> {
	let mut failures = Vec::new();

	if let Err(error) = operation {
		failures.push(error);
	}

	for cleanup in cleanups {
		if let Err(error) = cleanup {
			failures.push(format!("cleanup failed: {error}"));
		}
	}

	if failures.is_empty() { Ok(()) } else { Err(failures.join("; ")) }
}

fn write_summary(output: &Path, summary: &SmokeSummary) -> Result<(), String> {
	let mut bytes = protocol::canonical_json(summary).map_err(|error| error.to_string())?;

	bytes.push(b'\n');

	let mut options = OpenOptions::new();

	options.write(true).create_new(true).mode(0o600).custom_flags(O_NOFOLLOW);

	let mut file = options
		.open(output)
		.map_err(|error| format!("cannot create subscription smoke summary: {error}"))?;

	file.write_all(&bytes)
		.and_then(|()| file.sync_all())
		.map_err(|error| format!("cannot persist subscription smoke summary: {error}"))
}

fn environment() -> BTreeMap<String, String> {
	[
		"AIQ_ALLOW_PAID_SUBSCRIPTION_SMOKE",
		"AIQ_ALLOW_PAID_CONTROLLED_SUBSCRIPTION_SMOKE",
		"AIQ_REAL_CODEX_BINARY",
		"AIQ_REAL_CODEX_HOME",
		"AIQ_REAL_PERMISSION_PROBE_BINARY",
		"AIQ_REAL_CODEX_TOOLCHAIN_ROOT",
		"AIQ_SUBSCRIPTION_SMOKE_EXECUTION_LOCK",
		"AIQ_SUBSCRIPTION_SMOKE_OUTPUT",
		"AIQ_CONTROLLED_SUBSCRIPTION_SMOKE_TASK_ROOT",
		"AIQ_CONTROLLED_SUBSCRIPTION_SMOKE_BASELINE_ROOT",
		"AIQ_CONTROLLED_SUBSCRIPTION_SMOKE_EVALUATOR_ROOT",
		"AIQ_CONTROLLED_SUBSCRIPTION_SMOKE_EVALUATOR_RUNTIME",
		"AIQ_CONTROLLED_SUBSCRIPTION_SMOKE_CORPUS_COMMITMENT",
		"AIQ_CONTROLLED_SUBSCRIPTION_SMOKE_EXECUTION_ROOT",
		"AIQ_CONTROLLED_SUBSCRIPTION_SMOKE_ARTIFACT_ROOT",
		"AIQ_CONTROLLED_SUBSCRIPTION_SMOKE_OUTPUT",
	]
	.into_iter()
	.filter_map(|name| env::var(name).ok().map(|value| (name.to_owned(), value)))
	.collect()
}

fn fixed_public_task(repository_root: &Path) -> TaskDefinition {
	let path =
		repository_root.join("benchmarks/examples/tasks/public-example-instruction-following.json");
	let metadata = fs::symlink_metadata(&path).expect("fixed task metadata");

	assert!(metadata.is_file() && !metadata.file_type().is_symlink());

	let bytes = fs::read(path).expect("fixed task bytes");

	assert_eq!(format!("sha256:{}", hex::encode(Sha256::digest(&bytes))), PUBLIC_TASK_BYTES_SHA256);

	let task: TaskDefinition = serde_json::from_slice(&bytes).expect("fixed task definition");

	assert_eq!(task.task_id, PUBLIC_TASK_ID);
	assert!(task.validation_issues().is_empty());
	assert_eq!(task.visibility, Visibility::PublicExample);
	assert_eq!(task.allowed_tools, ["none"]);
	assert_eq!(task.evaluator.as_ref().map(|value| value.kind.as_str()), Some("exact_match"));
	assert_eq!(
		task.evaluator.as_ref().and_then(|value| value.expected.as_deref()),
		Some("bounded")
	);

	assert_fixed_model();

	task
}

fn assert_fixed_model() {
	assert_eq!(MODEL_MATRIX[0].family.codex_name(), "gpt-5.6-sol");
	assert_eq!(MODEL_MATRIX[0].reasoning_effort.to_string(), "low");
}

fn smoke_manifest(codex_binary_sha256: &str, codex_version: String) -> CapabilityManifest {
	CapabilityManifest {
		schema_version: "aiq.capabilities.v1".to_owned(),
		node_id: format!("node_{}", codex_binary_sha256.trim_start_matches("sha256:")),
		observed_at: "subscription-smoke-not-preflighted".to_owned(),
		codex_version,
		models: Vec::new(),
	}
}

#[test]
fn smoke_guards_require_exact_opt_in_and_fixed_model() {
	for value in [None, Some("true"), Some("0")] {
		let mut public = BTreeMap::new();
		let mut controlled = BTreeMap::new();

		if let Some(value) = value {
			public.insert("AIQ_ALLOW_PAID_SUBSCRIPTION_SMOKE".to_owned(), value.to_owned());
			controlled.insert(
				"AIQ_ALLOW_PAID_CONTROLLED_SUBSCRIPTION_SMOKE".to_owned(),
				value.to_owned(),
			);
		}

		assert!(public_smoke_guard(&public).is_err());
		assert!(controlled_smoke_guard(&controlled).is_err());
	}

	assert_fixed_model();

	assert_eq!(CONTROLLED_TASK_VERSION, crate::scoring::AIQ_TASK_SET_VERSION);
}

#[test]
fn controlled_smoke_direct_egress_strips_inherited_proxy_environment() {
	let requests = Rc::new(RefCell::new(Vec::new()));
	let mut execution_config = CodexExecutionConfig::isolated("/controlled/codex-home");

	for (key, value) in [
		("HTTP_PROXY", "http://203.0.113.1:8080"),
		("HTTPS_PROXY", "http://203.0.113.2:8080"),
		("ALL_PROXY", "socks5://203.0.113.3:8080"),
		("http_proxy", "http://203.0.113.4:8080"),
		("https_proxy", "http://203.0.113.5:8080"),
		("all_proxy", "socks5://203.0.113.6:8080"),
		("NO_PROXY", "*"),
		("no_proxy", "localhost"),
	] {
		execution_config.allowed_environment.insert(key.to_owned(), value.to_owned());
	}

	let adapter = CodexAdapter::new(
		RecordingExecutor {
			requests: Rc::clone(&requests),
			exit_code: 0,
			stdout: b"codex-cli 0.146.0".to_vec(),
		},
		TestArtifactSink,
		"codex",
		execution_config,
	);

	adapter.probe_version().expect("version probe");

	let requests = requests.borrow();
	let request = requests.first().expect("captured version request");

	for forbidden in [
		"HTTP_PROXY",
		"HTTPS_PROXY",
		"ALL_PROXY",
		"http_proxy",
		"https_proxy",
		"all_proxy",
		"NO_PROXY",
		"no_proxy",
	] {
		assert!(!request.environment.contains_key(forbidden));
	}

	assert_eq!(requests.len(), 1, "the continuity check must not invoke a model");
}

#[test]
fn controlled_smoke_login_status_strips_inherited_proxy_environment() {
	let mut execution_config = CodexExecutionConfig::isolated("/controlled/codex-home");

	for (key, value) in [
		("HTTP_PROXY", "http://203.0.113.1:8080"),
		("HTTPS_PROXY", "http://203.0.113.2:8080"),
		("ALL_PROXY", "socks5://203.0.113.3:8080"),
		("http_proxy", "http://203.0.113.4:8080"),
		("https_proxy", "http://203.0.113.5:8080"),
		("all_proxy", "socks5://203.0.113.6:8080"),
		("NO_PROXY", "*"),
		("no_proxy", "localhost"),
	] {
		execution_config.allowed_environment.insert(key.to_owned(), value.to_owned());
	}

	let request = chatgpt_subscription_request(Path::new("/controlled/codex"), &execution_config);

	assert!(request.clear_environment);
	assert_eq!(request.program, "/controlled/codex");
	assert_eq!(request.args, ["login", "status"]);
	assert_eq!(
		request.environment.get("CODEX_HOME").map(String::as_str),
		Some("/controlled/codex-home")
	);

	for forbidden in [
		"HTTP_PROXY",
		"HTTPS_PROXY",
		"ALL_PROXY",
		"http_proxy",
		"https_proxy",
		"all_proxy",
		"NO_PROXY",
		"no_proxy",
	] {
		assert!(!request.environment.contains_key(forbidden));
	}
}

#[test]
fn controlled_smoke_canary_discovery_failure_cleans_the_artifact_canary() {
	let repository_root = fs::canonicalize(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."))
		.expect("repository root");
	let temp = SmokeTempRoot::create(&repository_root).expect("temporary root");
	let artifact_root = temp.path().join("artifacts");
	let missing_root = temp.path().join("missing-denied-root");

	fs::create_dir(&artifact_root).expect("artifact root fixture");

	let error =
		controlled_smoke_denied_canaries(&[artifact_root.clone(), missing_root], &artifact_root)
			.err()
			.expect("missing denied root must fail discovery");

	assert!(error.contains("denied root is unavailable"));
	assert!(!artifact_root.join(".aiq-controlled-smoke-denied-canary").exists());
}

#[test]
fn controlled_smoke_permission_boundary_failure_cleans_both_owned_canaries() {
	let repository_root = fs::canonicalize(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."))
		.expect("repository root");
	let temp = SmokeTempRoot::create(&repository_root).expect("temporary root");
	let execution_root = temp.path().join("execution");
	let artifact_root = temp.path().join("artifacts");
	let codex_home = temp.path().join("codex-home");
	let toolchain = temp.path().join("toolchain");

	for directory in [&execution_root, &artifact_root, &codex_home, &toolchain] {
		fs::create_dir(directory).expect("permission failure fixture directory");
	}

	fs::write(toolchain.join("node"), b"node").expect("toolchain canary fixture");

	let requests = Rc::new(RefCell::new(Vec::new()));
	let adapter = CodexAdapter::new(
		RecordingExecutor { requests: Rc::clone(&requests), exit_code: 1, stdout: Vec::new() },
		TestArtifactSink,
		"codex",
		CodexExecutionConfig::isolated(codex_home)
			.with_denied_roots(vec![artifact_root.clone()])
			.with_permission_probe_executable(env::current_exe().expect("test executable"))
			.with_model_toolchain(corpus_commitment::fixture_model_toolchain(toolchain)),
	);
	let error = verify_controlled_smoke_permission_canaries(
		&adapter,
		slice::from_ref(&artifact_root),
		&artifact_root,
		&execution_root,
	)
	.expect_err("failed boundary must remain a failure");

	assert!(!error.is_empty());
	assert!(!error.contains("cleanup failed"), "owned cleanup unexpectedly failed: {error}");
	assert!(!artifact_root.join(".aiq-controlled-smoke-denied-canary").exists());
	assert!(!execution_root.join(".permission-admission").exists());
	assert_eq!(requests.borrow().len(), 1, "the model-free boundary executes once");
}

#[test]
fn controlled_smoke_cleanup_refuses_replaced_targets() {
	let repository_root = fs::canonicalize(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."))
		.expect("repository root");
	let temp = SmokeTempRoot::create(&repository_root).expect("temporary root");
	let artifact_root = temp.path().join("artifacts");
	let execution_root = temp.path().join("execution");

	fs::create_dir(&artifact_root).expect("artifact root fixture");
	fs::create_dir(&execution_root).expect("execution root fixture");

	let (_, artifact_canary) =
		controlled_smoke_denied_canaries(slice::from_ref(&artifact_root), &artifact_root)
			.expect("artifact canary fixture");
	let artifact_path = artifact_canary.path.clone();

	fs::remove_file(&artifact_path).expect("replace artifact canary");
	fs::create_dir(&artifact_path).expect("artifact canary replacement");

	assert!(artifact_canary.cleanup().is_err());
	assert!(artifact_path.is_dir(), "cleanup must not remove a replacement directory");

	let workspace =
		ControlledSmokePermissionWorkspace::create(&execution_root).expect("workspace fixture");
	let allowed_path = workspace.allowed_path().to_owned();

	fs::remove_file(&allowed_path).expect("replace allowed canary");
	fs::write(&allowed_path, b"replacement").expect("allowed canary replacement");

	assert!(workspace.cleanup().is_err());
	assert_eq!(fs::read(&allowed_path).expect("retained replacement"), b"replacement");

	fs::remove_dir(&artifact_path).expect("artifact replacement cleanup");
	fs::remove_file(&allowed_path).expect("allowed replacement cleanup");
	fs::remove_dir(execution_root.join(".permission-admission"))
		.expect("workspace replacement cleanup");
}

#[test]
fn capture_failure_fallback_removes_only_the_exact_empty_created_file() {
	let repository_root = fs::canonicalize(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."))
		.expect("repository root");
	let temp = SmokeTempRoot::create(&repository_root).expect("temporary root");
	let parent = temp.path().join("parent");

	fs::create_dir(&parent).expect("fallback parent fixture");

	let parent_identity = PinnedDirectoryIdentity::capture(&parent).expect("pinned parent fixture");
	let exact_path = parent.join("exact");
	let exact_file = OpenOptions::new()
		.read(true)
		.write(true)
		.create_new(true)
		.mode(0o600)
		.custom_flags(O_NOFOLLOW)
		.open(&exact_path)
		.expect("exact empty fixture");

	cleanup_exact_empty_created_file(&parent_identity, &exact_path, &exact_file)
		.expect("exact empty file cleanup");

	assert!(!exact_path.exists());

	let replaced_path = parent.join("replaced");
	let replaced_file = OpenOptions::new()
		.read(true)
		.write(true)
		.create_new(true)
		.mode(0o600)
		.custom_flags(O_NOFOLLOW)
		.open(&replaced_path)
		.expect("replaceable empty fixture");

	fs::remove_file(&replaced_path).expect("unlink exact fixture");
	fs::write(&replaced_path, b"replacement").expect("replacement fixture");

	assert!(
		cleanup_exact_empty_created_file(&parent_identity, &replaced_path, &replaced_file).is_err()
	);
	assert_eq!(fs::read(&replaced_path).expect("retained replacement"), b"replacement");
}

#[test]
fn smoke_paths_and_private_outputs_reject_aliases_and_reuse() {
	let repository_root = fs::canonicalize(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."))
		.expect("repository root");
	let temp = SmokeTempRoot::create(&repository_root).expect("temporary root");
	let input = temp.path().join("input.json");

	fs::write(&input, b"{}").expect("input fixture");

	let values = BTreeMap::from([("INPUT".to_owned(), input.display().to_string())]);

	assert_eq!(canonical_input(&values, "INPUT", InputKind::RegularFile), Ok(input.clone()));

	let alias = temp.path().join("alias.json");

	std::os::unix::fs::symlink(&input, &alias).expect("input alias");

	let alias_values = BTreeMap::from([("INPUT".to_owned(), alias.display().to_string())]);

	assert!(canonical_input(&alias_values, "INPUT", InputKind::RegularFile).is_err());

	let artifact_path = temp.path().join("private-artifacts");
	let artifact = create_private_artifact_root(artifact_path.clone()).expect("private root");
	let metadata = fs::symlink_metadata(&artifact).expect("private root metadata");

	assert_eq!(metadata.permissions().mode() & 0o777, 0o700);
	assert!(create_private_artifact_root(artifact_path).is_err());

	let execution_path = temp.path().join("private-execution");
	let execution =
		create_private_execution_root(execution_path.clone()).expect("private execution root");
	let metadata = fs::symlink_metadata(&execution).expect("private execution root metadata");

	assert_eq!(metadata.permissions().mode() & 0o777, 0o700);
	assert!(create_private_execution_root(execution_path).is_err());
}

#[test]
fn controlled_smoke_layout_separates_execution_from_every_protected_root() {
	let fixture_repository =
		fs::canonicalize(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."))
			.expect("fixture repository");
	let temp = SmokeTempRoot::create(&fixture_repository).expect("temporary root");
	let repository_root = temp.path().join("repository");
	let codex_home = temp.path().join("codex-home");
	let task_root = temp.path().join("tasks");
	let baseline_root = temp.path().join("baselines");
	let evaluator_root = temp.path().join("evaluators");
	let toolchain_root = temp.path().join("toolchain");
	let corpus_commitment = temp.path().join("commitment.json");

	for directory in [
		&repository_root,
		&codex_home,
		&task_root,
		&baseline_root,
		&evaluator_root,
		&toolchain_root,
	] {
		fs::create_dir(directory).expect("layout fixture directory");
	}

	fs::write(&corpus_commitment, b"{}").expect("layout fixture commitment");

	let mut config = ControlledSmokeConfig {
		task_root,
		baseline_root,
		evaluator_root,
		evaluator_runtime: toolchain_root.join("node"),
		corpus_commitment,
		codex_binary: temp.path().join("codex"),
		codex_home,
		permission_probe_binary: temp.path().join("aiq-runner"),
		toolchain_root: toolchain_root.clone(),
		execution_lock: temp.path().join("execution.lock"),
		execution_root: temp.path().join("execution"),
		artifact_root: temp.path().join("artifacts"),
		output: temp.path().join("summary.json"),
	};
	let denied = controlled_smoke_denied_roots(&config, &repository_root, &toolchain_root)
		.expect("disjoint controlled layout");

	assert_eq!(denied.len(), 7);

	let artifact_root = config.artifact_root.clone();
	let task_root = config.task_root.clone();
	let baseline_root = config.baseline_root.clone();

	config.artifact_root = config.task_root.join("artifacts");

	assert!(controlled_smoke_denied_roots(&config, &repository_root, &toolchain_root).is_err());

	config.artifact_root = config.codex_home.join("artifacts");

	assert!(controlled_smoke_denied_roots(&config, &repository_root, &toolchain_root).is_err());

	config.artifact_root = artifact_root;
	config.task_root = repository_root.join("tasks");

	assert!(controlled_smoke_denied_roots(&config, &repository_root, &toolchain_root).is_err());

	config.task_root = task_root.clone();
	config.baseline_root = task_root.join("baselines");

	assert!(controlled_smoke_denied_roots(&config, &repository_root, &toolchain_root).is_err());

	config.baseline_root = baseline_root;

	for protected in &denied {
		config.execution_root = protected.join("overlap");

		assert!(controlled_smoke_denied_roots(&config, &repository_root, &toolchain_root).is_err());
	}

	config.execution_root = toolchain_root.join("overlap");

	assert!(controlled_smoke_denied_roots(&config, &repository_root, &toolchain_root).is_err());

	let repository_alias = temp.path().join("repository-alias");

	std::os::unix::fs::symlink(&repository_root, &repository_alias)
		.expect("repository alias fixture");

	config.execution_root = repository_alias.join("overlap");

	assert!(controlled_smoke_denied_roots(&config, &repository_root, &toolchain_root).is_err());
}

#[test]
fn smoke_lock_is_nonblocking_private_and_preserves_bytes() {
	let repository_root = fs::canonicalize(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."))
		.expect("repository root");
	let temp = SmokeTempRoot::create(&repository_root).expect("temporary root");
	let lock_path = temp.path().join("shared.lock");
	let original = b"existing lock metadata\n";

	fs::write(&lock_path, original).expect("lock fixture");
	fs::set_permissions(&lock_path, Permissions::from_mode(0o600)).expect("lock permissions");

	{
		let lock = SmokeExecutionLock::acquire(&lock_path).expect("shared lock");

		lock.verify_held().expect("held lock");

		assert!(SmokeExecutionLock::acquire(&lock_path).is_err());
		assert_eq!(fs::read(&lock_path).expect("lock bytes"), original);
	}

	assert_eq!(fs::read(&lock_path).expect("released lock bytes"), original);
}

#[test]
fn smoke_attempt_count_and_score_consistency_fail_closed() {
	let attempts = AtomicUsize::new(0);

	assert!(checked_attempt_count(&attempts).is_err());

	attempts.store(1, Ordering::SeqCst);

	assert_eq!(checked_attempt_count(&attempts), Ok(1));

	attempts.store(2, Ordering::SeqCst);

	assert!(checked_attempt_count(&attempts).is_err());

	for (outcome, score, valid) in [
		(EvaluationOutcome::Correct, Some(1.0), true),
		(EvaluationOutcome::Partial, Some(0.5), true),
		(EvaluationOutcome::Incorrect, Some(0.0), true),
		(EvaluationOutcome::Correct, Some(0.5), false),
		(EvaluationOutcome::Partial, Some(0.0), false),
		(EvaluationOutcome::Incorrect, Some(0.5), false),
		(EvaluationOutcome::NotEvaluated, None, false),
	] {
		let mut result = synthetic_result_fixture();

		result.provenance.synthetic = false;
		result.status = ResultStatus::Completed;
		result.evaluation = outcome;
		result.task_score = score;

		assert_eq!(checked_score(&result).is_ok(), valid);
	}
}

fn synthetic_result_fixture() -> TaskResult {
	let slot = ScheduleConfig::default()
		.slot("2026-07-30", ScheduleOccurrence::Day)
		.expect("synthetic slot");

	runner::synthetic_demo(slot, &TestArtifactSink).expect("synthetic result").results.remove(0)
}

#[test]
fn smoke_summary_is_private_create_once_and_public_safe() {
	let digest = format!("sha256:{}", "a".repeat(64));
	let summary = SmokeSummary {
		schema_version: "aiq.controlled-subscription-smoke.v1",
		classification: "local_controlled_subscription_smoke_non_official",
		task_id: CONTROLLED_TASK_ID,
		model: MODEL_MATRIX[0].key(),
		task_definition_sha256: digest.clone(),
		corpus_release_id: Some("corpus_test".to_owned()),
		corpus_commitment_sha256: Some(digest.clone()),
		baseline_workspace_sha256: Some(digest.clone()),
		evaluator_binding_sha256: Some(digest.clone()),
		evaluator_executable_sha256: Some(digest.clone()),
		evaluator_runtime_sha256: Some(digest.clone()),
		codex_version: "codex-cli 0.146.0".to_owned(),
		codex_binary_sha256: digest,
		status: ResultStatus::Completed,
		outcome: EvaluationOutcome::Incorrect,
		task_score: 0.0,
		latency_ms: 1,
		model_invocation_attempt_count: 1,
		synthetic: false,
		official_eligible: false,
	};
	let value = serde_json::to_value(&summary).expect("summary JSON");
	let object = value.as_object().expect("summary object");

	assert_eq!(object.get("synthetic").and_then(Value::as_bool), Some(false));
	assert_eq!(object.get("official_eligible").and_then(Value::as_bool), Some(false));

	for forbidden in ["prompt", "response", "stdout", "stderr", "codex_home", "secret"] {
		assert!(!object.contains_key(forbidden));
	}

	let repository_root = fs::canonicalize(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."))
		.expect("repository root");
	let temp = SmokeTempRoot::create(&repository_root).expect("temporary root");
	let output = temp.path().join("summary.json");

	write_summary(&output, &summary).expect("write summary");

	let metadata = fs::symlink_metadata(&output).expect("summary metadata");

	assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
	assert!(write_summary(&output, &summary).is_err());
}

#[test]
#[ignore = "requires explicit paid subscription smoke authorization and canonical real-Codex inputs"]
fn real_codex_subscription_smoke_executes_fixed_public_example_once() {
	let config = public_smoke_guard(&environment()).expect("public smoke guard");
	let repository_root = fs::canonicalize(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."))
		.expect("repository root");
	let task = fixed_public_task(&repository_root);
	let runtime =
		EvaluatorRuntime::resolve(&config.toolchain_root.join("node")).expect("toolchain Node.js");
	let toolchain =
		corpus_commitment::fixture_validated_model_toolchain(&config.toolchain_root, &runtime);
	let codex_binary_sha256 =
		corpus_commitment::codex_executable_digest(&config.codex_binary.display().to_string())
			.expect("Codex binary digest");
	let execution_lock =
		SmokeExecutionLock::acquire(&config.execution_lock).expect("nonblocking execution lock");
	let temp = SmokeTempRoot::create(&repository_root).expect("subscription smoke root");
	let attempts = Arc::new(AtomicUsize::new(0));
	let run_result = (|| -> Result<(), String> {
		let artifacts = LocalArtifactSink::new(temp.path().join("artifacts"))
			.map_err(|error| error.to_string())?;
		let execution_config = CodexExecutionConfig::isolated(config.codex_home.clone())
			.with_denied_roots(vec![repository_root.clone(), config.codex_home.clone()])
			.with_model_toolchain(toolchain);

		require_chatgpt_subscription(&config.codex_binary, &execution_config)?;

		let codex_version = CodexAdapter::new(
			SystemExecutor,
			artifacts.clone(),
			config.codex_binary.display().to_string(),
			execution_config.clone(),
		)
		.probe_version()
		.map_err(|error| error.to_string())?;
		let adapter = CodexAdapter::new(
			CountingExecutor { attempts: Arc::clone(&attempts) },
			artifacts,
			config.codex_binary.display().to_string(),
			execution_config,
		);
		let manifest = smoke_manifest(&codex_binary_sha256, codex_version.clone());
		let provider = EmptyWorkspace { root: temp.path().to_owned() };
		let result = runner::execute_task(
			&adapter,
			&provider,
			&manifest,
			&task,
			MODEL_MATRIX[0],
			PUBLIC_RUN_ID,
			&manifest.codex_version,
			&manifest.observed_at,
			None,
			None,
		)
		.map_err(|error| error.to_string())?;
		let attempts = checked_attempt_count(&attempts)?;

		execution_lock.verify_held()?;

		let summary = public_summary(&task, &result, codex_version, codex_binary_sha256, attempts)?;

		write_summary(&config.output, &summary)
	})();

	run_result.expect("fixed paid subscription smoke");
}

#[test]
#[ignore = "requires explicit paid controlled subscription smoke authorization and canonical private inputs"]
fn real_codex_controlled_subscription_smoke_executes_fixed_hidden_task_once() {
	let config = controlled_smoke_guard(&environment()).expect("controlled smoke guard");
	let repository_root = fs::canonicalize(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."))
		.expect("repository root");
	let task = load_controlled_task(&config.task_root).expect("fixed controlled hidden task");
	let runtime =
		EvaluatorRuntime::resolve(&config.evaluator_runtime).expect("controlled evaluator runtime");
	let corpus = load_controlled_corpus(
		&config.corpus_commitment,
		&task,
		&repository_root,
		&runtime,
		&config.toolchain_root,
	)
	.expect("owning controlled corpus commitment");
	let commitments =
		controlled_commitments(&task, &config, &runtime, &corpus).expect("controlled commitments");
	let denied_roots =
		controlled_smoke_denied_roots(&config, &repository_root, corpus.model_toolchain.root())
			.expect("controlled smoke isolation layout");
	let codex_binary_sha256 =
		corpus_commitment::codex_executable_digest(&config.codex_binary.display().to_string())
			.expect("Codex binary digest");
	let execution_lock =
		SmokeExecutionLock::acquire(&config.execution_lock).expect("nonblocking execution lock");
	let retained =
		create_private_artifact_root(config.artifact_root.clone()).expect("private artifact root");
	let execution = create_private_execution_root(config.execution_root.clone())
		.expect("private execution root");
	let artifacts = LocalArtifactSink::new(retained.join("artifacts")).expect("artifact sink");
	let attempts = Arc::new(AtomicUsize::new(0));
	let baseline_digests = BTreeMap::from([(
		CONTROLLED_TASK_ID.to_owned(),
		commitments.baseline_workspace_sha256.clone(),
	)]);
	let provider =
		LocalDirectoryWorkspaceProvider::new(&config.baseline_root, execution, baseline_digests)
			.expect("controlled workspace provider");
	let execution_config = CodexExecutionConfig::isolated(config.codex_home.clone())
		.with_denied_roots(denied_roots)
		.with_permission_probe_executable(config.permission_probe_binary.clone())
		.with_model_toolchain(corpus.model_toolchain);
	let codex_version =
		verify_controlled_smoke_permission_admission(&config, &execution_config, &artifacts)
			.expect("model-free controlled smoke permission admission");
	let adapter = CodexAdapter::new(
		CountingExecutor { attempts: Arc::clone(&attempts) },
		artifacts,
		config.codex_binary.display().to_string(),
		execution_config,
	);
	let manifest = smoke_manifest(&codex_binary_sha256, codex_version.clone());
	let result = runner::execute_task(
		&adapter,
		&provider,
		&manifest,
		&task,
		MODEL_MATRIX[0],
		CONTROLLED_RUN_ID,
		&manifest.codex_version,
		&manifest.observed_at,
		Some(&config.evaluator_root),
		Some(&runtime),
	)
	.expect("normal external evaluator task execution");
	let attempts = checked_attempt_count(&attempts).expect("exactly one model attempt");

	execution_lock.verify_held().expect("execution lock remained held");

	let summary =
		controlled_summary(&result, commitments, codex_version, codex_binary_sha256, attempts)
			.expect("valid controlled smoke result");

	write_summary(&config.output, &summary).expect("create controlled smoke summary");
}
