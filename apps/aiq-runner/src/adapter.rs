//! Injectable, isolated Codex CLI process adapter.

pub(crate) mod process_group;

#[cfg(test)]
use std::cell::Cell;
#[cfg(unix)]
use std::ffi::OsStr;
use std::fmt::Debug;
#[cfg(unix)]
use std::fs::Permissions;
#[cfg(not(any(unix, windows)))]
use std::io::{Seek, SeekFrom};
#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::mem::MaybeUninit;
#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::os::fd::AsRawFd;
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::sync::mpsc::Receiver;
use std::{
	collections::{BTreeMap, BTreeSet},
	env,
	fmt::{Display, Formatter},
	fs::{self, File, Metadata, OpenOptions},
	io::{self, ErrorKind, Read, Write},
	iter,
	net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream},
	path::{Path, PathBuf},
	process::{self, Child, ChildStderr, ChildStdin, ChildStdout, Command, ExitStatus, Stdio},
	sync::{
		Arc,
		mpsc::{self, RecvTimeoutError, Sender, SyncSender},
	},
	thread::{self, Builder, JoinHandle},
	time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[cfg(unix)]
use libc;
#[cfg(unix)]
use libc::O_NOFOLLOW;
#[cfg(target_os = "linux")]
use libc::ST_RDONLY;
#[cfg(target_os = "macos")]
use libc::UF_IMMUTABLE;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem;

#[cfg(test)]
use crate::corpus_commitment;
use crate::{
	corpus_commitment::ValidatedModelToolchain,
	isolation::{self, PLATFORM_MINIMAL_ROOTS_VERSION, ProtectedBenchmarkPath},
	model::{CapabilityManifest, CapabilityStatus, MODEL_MATRIX, ModelConfig},
	pinned_path::{PinnedDirectoryIdentity, PinnedPathIdentity},
	protocol::{self, ProtocolError},
};
use process_group::ProcessGroupCleanupError;
use process_group::ProcessGroupPoll;

#[cfg(test)]
thread_local! {
	static FORCED_PROCESS_THREAD_SPAWN_FAILURE: std::cell::Cell<Option<usize>> =
		const { std::cell::Cell::new(None) };
	static LAST_JSON_RPC_CHILD_PID: std::cell::Cell<Option<u32>> =
		const { std::cell::Cell::new(None) };
	#[cfg(target_os = "linux")]
	static FORCE_JSON_RPC_STOP_FAILURE: std::cell::Cell<bool> =
		const { std::cell::Cell::new(false) };
}

type CaptureThread = JoinHandle<std::io::Result<(Vec<u8>, bool)>>;

/// Maximum complete bytes accepted independently for stdout and stderr.
pub const MAX_CAPTURE_BYTES: usize = 4 * 1_024 * 1_024;
/// Maximum bytes retained inline for a captured stream or final response.
///
/// Complete streams above this limit are retained as content-addressed
/// artifacts. Keeping the signed preview small makes the maximum 1,224-result
/// submission fit below the guarded ingress limit.
pub const MAX_INLINE_PREVIEW_BYTES: usize = 64;
/// Maximum unescaped ASCII bytes in an observed Codex version.
pub const MAX_CODEX_VERSION_BYTES: usize = 32;
/// Maximum prompt bytes written to a Codex child.
pub const MAX_STDIN_BYTES: usize = 256 * 1_024;

/// Normalization contract for Codex `exec --json` item events.
pub(crate) const CODEX_ITEM_ACCOUNTING_VERSION: &str = "codex.exec-json-items.v1";

const DISABLED_CODEX_FEATURES: &[&str] = &[
	"apps",
	"auth_elicitation",
	"browser_use",
	"browser_use_external",
	"browser_use_full_cdp_access",
	"code_mode_host",
	"computer_use",
	"goals",
	"hooks",
	"image_generation",
	"in_app_browser",
	"multi_agent",
	"plugin_sharing",
	"plugins",
	"remote_plugin",
	"request_permissions_tool",
	"skill_mcp_dependency_install",
	"skill_search",
	"tool_suggest",
	"workspace_dependencies",
];
const BENCHMARK_PERMISSION_PROFILE: &str = "aiq_benchmark";
const MAX_AUTH_JSON_BYTES: u64 = 1_024 * 1_024;
const MAX_ID_TOKEN_PAYLOAD_BYTES: usize = 128 * 1_024;
const CODEX_PROXY_ENVIRONMENT_KEYS: [&str; 6] =
	["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];

/// An injectable process execution seam.
pub trait Executor {
	/// Executes one direct child process.
	fn execute(&self, request: &CommandRequest) -> Result<ExecutionCapture, ExecutorError>;

	/// Executes one child while exposing its actual spawn and reap boundaries.
	fn execute_observed(
		&self,
		request: &CommandRequest,
		_observer: &dyn ChildProcessObserver,
	) -> Result<ExecutionCapture, ExecutorError> {
		self.execute(request)
	}

	/// Executes a bounded JSONL RPC exchange while keeping standard input open.
	fn execute_json_rpc(
		&self,
		request: &CommandRequest,
		_expected_response_ids: &[u64],
	) -> Result<ExecutionCapture, ExecutorError> {
		self.execute(request)
	}
}

/// Receives actual direct-child lifecycle boundaries from a process executor.
pub trait ChildProcessObserver: Send + Sync {
	/// Called only after the operating system returns a child process identifier.
	fn child_spawned(&self, pid: u32);
	/// Called after the direct child has been reaped.
	fn child_reaped(&self, pid: u32, exit_code: Option<i32>);
}

/// Sink for raw execution artifacts.
pub trait ArtifactSink {
	/// Stores one bounded artifact and returns a content-addressed reference.
	fn put(&self, kind: &str, bytes: &[u8]) -> Result<ArtifactReference, ExecutorError>;
}

/// A process request that does not use a shell.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommandRequest {
	/// Executable path.
	pub program: String,
	/// Direct process arguments.
	pub args: Vec<String>,
	/// Standard-input bytes.
	pub stdin: Vec<u8>,
	/// Hard wall-clock timeout, including standard-input delivery.
	pub timeout: Duration,
	/// Maximum accepted bytes for each output stream.
	pub max_capture_bytes: usize,
	/// Maximum observed completed items.
	pub max_steps: u32,
	/// Maximum observed tool calls.
	pub max_tool_calls: u32,
	/// Whether the inherited environment is removed.
	pub clear_environment: bool,
	/// Exact child environment after clearing.
	pub environment: BTreeMap<String, String>,
}

/// Captured process output.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExecutionCapture {
	/// Process exit code, if the platform supplied one.
	pub exit_code: Option<i32>,
	/// Complete bounded standard output.
	pub stdout: Vec<u8>,
	/// Complete bounded standard error.
	pub stderr: Vec<u8>,
	/// Whether the executor killed the process after its deadline.
	pub timed_out: bool,
	/// Live budget that terminated the child.
	pub budget_exceeded: Option<LiveBudgetKind>,
	/// Whether stdout exceeded its byte limit.
	pub stdout_truncated: bool,
	/// Whether stderr exceeded its byte limit.
	pub stderr_truncated: bool,
}

/// A low-level executor error.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExecutorError {
	message: String,
}
impl ExecutorError {
	/// Creates an executor error.
	#[must_use]
	pub fn new(message: impl Into<String>) -> Self {
		Self { message: message.into() }
	}
}

impl std::error::Error for ExecutorError {}

impl Display for ExecutorError {
	fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
		formatter.write_str(&self.message)
	}
}

/// A structured Codex CLI failure.
#[derive(Clone, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AdapterFailure {
	/// Stable failure kind.
	pub kind: AdapterFailureKind,
	/// Process exit code.
	pub exit_code: Option<i32>,
	/// Bounded standard-error preview.
	pub stderr: String,
	/// Human-readable detail.
	pub message: String,
	/// Whether stdout exceeded its byte limit.
	pub stdout_truncated: bool,
	/// Whether stderr exceeded its byte limit.
	pub stderr_truncated: bool,
	/// Content-addressed references for retained raw failure streams.
	pub artifacts: Vec<ArtifactReference>,
	/// Complete bounded stdout retained only in the invoking process so failed
	/// attempts can sign the same tool and provider counters as their artifact.
	#[serde(skip)]
	pub(crate) stdout_full: String,
}
impl AdapterFailure {
	/// Returns whether inline provider text was removed for durable preflight evidence.
	#[must_use]
	pub fn is_normalized_preflight(&self) -> bool {
		self.stderr.is_empty() && self.message == normalized_preflight_failure_message(self.kind)
	}
}

impl Debug for AdapterFailure {
	fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
		formatter
			.debug_struct("AdapterFailure")
			.field("kind", &self.kind)
			.field("exit_code", &self.exit_code)
			.field("stderr", &"[REDACTED]")
			.field("message", &self.message)
			.field("stdout_truncated", &self.stdout_truncated)
			.field("stderr_truncated", &self.stderr_truncated)
			.field("artifacts", &self.artifacts)
			.field("stdout_full", &"[REDACTED]")
			.finish()
	}
}

impl std::error::Error for AdapterFailure {}

impl Display for AdapterFailure {
	fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
		write!(formatter, "{:?}: {}", self.kind, self.message)
	}
}

/// Content-addressed reference to a retained execution artifact.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ArtifactReference {
	/// Artifact content kind.
	pub kind: String,
	/// SHA-256 content digest.
	pub content_hash: String,
	/// Sink-independent content address.
	pub uri: String,
	/// Artifact size in bytes.
	pub bytes: u64,
}

/// Controlled local artifact sink. A deployment can replace this trait implementation.
#[derive(Clone, Debug)]
pub struct LocalArtifactSink {
	#[cfg(not(unix))]
	root: PathBuf,
	#[cfg(unix)]
	pinned: Arc<PinnedDirectoryIdentity>,
}
impl LocalArtifactSink {
	/// Creates a sink rooted at an operator-controlled directory.
	pub fn new(root: impl Into<PathBuf>) -> Result<Self, ExecutorError> {
		let root = root.into();

		if fs::symlink_metadata(&root).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
			return Err(ExecutorError::new("artifact root must not be a symbolic link"));
		}

		fs::create_dir_all(&root)
			.map_err(|error| ExecutorError::new(format!("artifact root unavailable: {error}")))?;
		#[cfg(unix)]
		fs::set_permissions(&root, Permissions::from_mode(0o700)).map_err(|error| {
			ExecutorError::new(format!("cannot restrict artifact root permissions: {error}"))
		})?;

		let root = fs::canonicalize(root)
			.map_err(|error| ExecutorError::new(format!("artifact root unavailable: {error}")))?;
		#[cfg(unix)]
		let pinned =
			Arc::new(PinnedDirectoryIdentity::capture(&root).map_err(|error| {
				ExecutorError::new(format!("cannot pin artifact root: {error}"))
			})?);

		Ok(Self {
			#[cfg(not(unix))]
			root,
			#[cfg(unix)]
			pinned,
		})
	}

	/// Verifies that the sink still resolves to the held root and parent identities.
	pub(crate) fn verify_pinned(&self) -> Result<(), ExecutorError> {
		#[cfg(unix)]
		{
			self.pinned.verify().map_err(|error| {
				ExecutorError::new(format!("artifact root identity changed: {error}"))
			})
		}

		#[cfg(not(unix))]
		{
			let canonical = fs::canonicalize(&self.root)
				.map_err(|_| ExecutorError::new("artifact root identity changed"))?;

			if canonical != self.root {
				return Err(ExecutorError::new("artifact root identity changed"));
			}

			Ok(())
		}
	}
}

impl LocalArtifactSink {
	#[cfg(all(test, unix))]
	fn put_with_post_publish_hook(
		&self,
		kind: &str,
		bytes: &[u8],
		post_publish: impl FnOnce(),
	) -> Result<ArtifactReference, ExecutorError> {
		self.put_inner(kind, bytes, post_publish)
	}

	fn put_inner(
		&self,
		kind: &str,
		bytes: &[u8],
		post_publish: impl FnOnce(),
	) -> Result<ArtifactReference, ExecutorError> {
		if kind.is_empty()
			|| !kind.bytes().all(|byte| byte.is_ascii_alphanumeric() || b".-_".contains(&byte))
		{
			return Err(ExecutorError::new("artifact kind contains unsafe path characters"));
		}

		self.verify_pinned()?;

		let content_hash = sha256(bytes)?;
		let digest = content_hash.trim_start_matches("sha256:").to_owned();

		#[cfg(unix)]
		{
			let directory = self
				.pinned
				.child_directory(OsStr::new(&digest), true)
				.map_err(ExecutorError::new)?;
			let temporary = format!(
				".tmp-{}-{}-{kind}",
				process::id(),
				SystemTime::now()
					.duration_since(UNIX_EPOCH)
					.map_or(0, |duration| duration.as_nanos())
			);
			let mut file = self
				.pinned
				.create_child_file(&directory, OsStr::new(&temporary))
				.map_err(ExecutorError::new)?;

			file.write_all(bytes)
				.and_then(|()| file.sync_all())
				.map_err(|_| ExecutorError::new("artifact write failed"))?;

			drop(file);

			let published =
				self.pinned.link_child_file(&directory, OsStr::new(&temporary), OsStr::new(kind));

			self.pinned
				.unlink_child_file(&directory, OsStr::new(&temporary))
				.map_err(ExecutorError::new)?;

			if let Err(error) = published
				&& error.kind() != ErrorKind::AlreadyExists
			{
				return Err(ExecutorError::new("cannot publish artifact atomically"));
			}

			let mut existing = self
				.pinned
				.open_child_file(&directory, OsStr::new(kind))
				.map_err(ExecutorError::new)?;

			verify_existing_artifact_file(&mut existing, bytes, &content_hash)?;
			post_publish();

			directory
				.sync_all()
				.map_err(|_| ExecutorError::new("cannot synchronize artifact directory"))?;
			self.pinned.sync().map_err(ExecutorError::new)?;
			self.pinned
				.verify_child_file(OsStr::new(&digest), &directory, OsStr::new(kind), &existing)
				.map_err(ExecutorError::new)?;
		}
		#[cfg(not(unix))]
		{
			let directory = self.root.join(&digest);

			if fs::symlink_metadata(&directory)
				.is_ok_and(|metadata| metadata.file_type().is_symlink())
			{
				return Err(ExecutorError::new("artifact digest directory is a symbolic link"));
			}

			fs::create_dir_all(&directory).map_err(|error| {
				ExecutorError::new(format!("artifact directory unavailable: {error}"))
			})?;

			let path = directory.join(kind);

			if path.exists() {
				verify_existing_artifact(&path, bytes, &content_hash)?;
			} else {
				let mut options = OpenOptions::new();

				options.write(true).create_new(true);

				let mut file = options.open(&path).map_err(|error| {
					ExecutorError::new(format!("cannot create artifact: {error}"))
				})?;

				file.write_all(bytes).and_then(|()| file.sync_all()).map_err(|error| {
					ExecutorError::new(format!("artifact write failed: {error}"))
				})?;
			}

			post_publish();
		}

		self.verify_pinned()?;

		Ok(ArtifactReference {
			kind: kind.to_owned(),
			content_hash,
			uri: format!("aiq-artifact://sha256/{digest}/{kind}"),
			bytes: u64::try_from(bytes.len()).unwrap_or(u64::MAX),
		})
	}
}

impl ArtifactSink for LocalArtifactSink {
	fn put(&self, kind: &str, bytes: &[u8]) -> Result<ArtifactReference, ExecutorError> {
		self.put_inner(kind, bytes, || {})
	}
}

/// Successful Codex CLI output.
#[derive(Clone, Eq, PartialEq)]
pub struct CodexOutput {
	/// Small bounded standard-output preview.
	pub stdout: String,
	/// Small bounded standard-error preview.
	pub stderr: String,
	/// Successful exit code.
	pub exit_code: Option<i32>,
	/// References for large raw streams.
	pub artifacts: Vec<ArtifactReference>,
	pub(crate) stdout_full: String,
}
impl Debug for CodexOutput {
	fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
		formatter
			.debug_struct("CodexOutput")
			.field("stdout", &"[REDACTED]")
			.field("stderr", &"[REDACTED]")
			.field("exit_code", &self.exit_code)
			.field("artifacts", &self.artifacts)
			.field("stdout_full", &"[REDACTED]")
			.finish()
	}
}

/// One controlled Codex invocation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InvocationRequest {
	/// Model configuration.
	pub model: ModelConfig,
	/// Complete benchmark prompt.
	pub prompt: String,
	/// Hard wall-clock timeout.
	pub timeout: Duration,
	/// Maximum completed items.
	pub max_steps: u32,
	/// Maximum tool calls.
	pub max_tool_calls: u32,
	/// Canonical controlled workspace directory.
	pub workspace_dir: PathBuf,
	/// Safe sandbox policy.
	pub sandbox: SandboxPolicy,
}

/// Isolated Codex subscription configuration.
#[derive(Clone, Debug)]
pub struct CodexExecutionConfig {
	/// Operator-controlled Codex home.
	pub codex_home: PathBuf,
	/// Explicit safe environment inherited by the child.
	pub allowed_environment: BTreeMap<String, String>,
	/// Canonical roots that model-generated commands must never read.
	pub denied_roots: Vec<PathBuf>,
	/// Optional explicit AIQ runner executable used for the permission canary.
	pub permission_probe_executable: Option<PathBuf>,
	/// Committed model-visible Node.js and ripgrep toolchain.
	pub model_toolchain: Option<ValidatedModelToolchain>,
}
impl CodexExecutionConfig {
	/// Builds an explicit environment allowlist. Provider/API-key variables are never included.
	#[must_use]
	pub fn isolated(codex_home: impl Into<PathBuf>) -> Self {
		let mut allowed_environment = BTreeMap::new();

		for key in ["LANG", "LC_ALL"] {
			if let Ok(value) = env::var(key) {
				allowed_environment.insert(key.to_owned(), value);
			}
		}
		#[cfg(windows)]
		for key in ["COMSPEC", "PATHEXT", "SYSTEMROOT", "WINDIR"] {
			if let Ok(value) = env::var(key) {
				allowed_environment.insert(key.to_owned(), value);
			}
		}

		Self {
			codex_home: codex_home.into(),
			allowed_environment,
			denied_roots: Vec::new(),
			permission_probe_executable: None,
			model_toolchain: {
				#[cfg(test)]
				{
					Some(corpus_commitment::fixture_model_toolchain(PathBuf::from("/toolchain")))
				}
				#[cfg(not(test))]
				{
					None
				}
			},
		}
	}

	/// Adds canonical sensitive roots that the benchmark workspace may be nested inside.
	#[must_use]
	pub fn with_denied_roots(mut self, denied_roots: Vec<PathBuf>) -> Self {
		self.denied_roots = denied_roots;

		self
	}

	/// Overrides the current AIQ runner executable used for the permission canary.
	#[must_use]
	pub fn with_permission_probe_executable(mut self, executable: impl Into<PathBuf>) -> Self {
		self.permission_probe_executable = Some(executable.into());

		self
	}

	/// Installs the committed model-visible command toolchain and exact child PATH.
	#[must_use]
	pub fn with_model_toolchain(mut self, toolchain: ValidatedModelToolchain) -> Self {
		self.allowed_environment.insert("PATH".to_owned(), toolchain.path_value());
		#[cfg(windows)]
		self.allowed_environment.insert("PATHEXT".to_owned(), ".COM;.EXE;.BAT;.CMD".to_owned());

		self.model_toolchain = Some(toolchain);

		self
	}
}

/// Public-safe proof that Codex selected the explicit benchmark permission profile.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ManagedPermissionProfileEvidence {
	/// Evidence schema.
	pub schema_version: String,
	/// Exact observed Codex CLI version.
	pub codex_version: String,
	/// Exact default permission profile supplied through strict CLI configuration.
	pub default_permissions: String,
	/// Exact selectable permission profile reported after applying strict CLI configuration.
	pub allowed_permission_profile: String,
	/// Exact active profile returned by model-free `thread/start`.
	pub active_permission_profile: String,
	/// Whether the explicit profile is eligible for a later Official run.
	pub official_eligible: bool,
	/// Public-safe classification of the external managed-requirements state.
	pub managed_requirements_status: String,
	/// Digest of the externally observed requirements result returned by Codex.
	pub managed_requirements_digest: String,
	/// Digest of the exact active model-free profile selection.
	pub profile_selection_digest: String,
	/// Digest of all preceding public fields.
	pub evidence_digest: String,
}
impl ManagedPermissionProfileEvidence {
	/// Returns the digest of the observed external managed-requirements state.
	#[must_use]
	pub fn managed_requirements_digest(&self) -> &str {
		&self.managed_requirements_digest
	}

	/// Returns the exact model-free profile-selection digest.
	#[must_use]
	pub fn profile_selection_digest(&self) -> &str {
		&self.profile_selection_digest
	}
}

/// Expected digests for the explicit profile required by an Official run.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExpectedOfficialPermissionProfileDigests {
	managed_requirements_digest: String,
	profile_selection_digest: String,
}
impl ExpectedOfficialPermissionProfileDigests {
	/// Returns the digest of the expected absent managed-requirements state.
	#[must_use]
	pub fn managed_requirements_digest(&self) -> &str {
		&self.managed_requirements_digest
	}

	/// Returns the exact required profile-selection digest.
	#[must_use]
	pub fn profile_selection_digest(&self) -> &str {
		&self.profile_selection_digest
	}
}

/// Codex CLI adapter with injectable execution and artifact storage.
pub struct CodexAdapter<E, S> {
	executor: E,
	sink: S,
	codex_binary: String,
	config: CodexExecutionConfig,
}
impl<E, S> CodexAdapter<E, S> {
	/// Creates an isolated Codex adapter.
	#[must_use]
	pub fn new(
		executor: E,
		sink: S,
		codex_binary: impl Into<String>,
		config: CodexExecutionConfig,
	) -> Self {
		Self { executor, sink, codex_binary: codex_binary.into(), config }
	}
}

impl<E, S> CodexAdapter<E, S>
where
	E: Executor,
	S: ArtifactSink,
{
	/// Digests the exact filesystem and network policy passed to benchmark children.
	pub fn permission_policy_digest(&self, workspace: &Path) -> Result<String, AdapterFailure> {
		permission_policy_digest(
			workspace,
			&self.config.denied_roots,
			self.config.model_toolchain.as_ref(),
		)
	}

	/// Probes the local Codex CLI version without invoking a model.
	pub fn probe_version(&self) -> Result<String, AdapterFailure> {
		let capture = self.execute_request(
			vec!["--version".to_owned()],
			Vec::new(),
			Duration::from_secs(10),
			u32::MAX,
			u32::MAX,
		)?;
		let version = classify_capture(capture, &self.sink, false)?.stdout.trim().to_owned();

		if !safe_codex_version(&version) {
			return Err(adapter_failure(
				AdapterFailureKind::NonZeroExit,
				"Codex CLI returned an invalid or overlong version",
			));
		}

		Ok(version)
	}

	/// Runs one model configuration through the isolated subscription environment.
	pub(crate) fn invoke(
		&self,
		invocation: &InvocationRequest,
	) -> Result<CodexOutput, AdapterFailure> {
		self.invoke_inner(invocation)
	}

	fn invoke_inner(&self, invocation: &InvocationRequest) -> Result<CodexOutput, AdapterFailure> {
		if invocation.prompt.len() > MAX_STDIN_BYTES {
			return Err(adapter_failure(
				AdapterFailureKind::BudgetExceeded,
				"benchmark prompt exceeds the bounded standard-input limit",
			));
		}
		if invocation.sandbox.workspace_access().is_some() && self.config.denied_roots.is_empty() {
			return Err(adapter_failure(
				AdapterFailureKind::Spawn,
				"benchmark filesystem access requires at least one explicit denied root",
			));
		}
		if invocation.sandbox.workspace_access().is_some() {
			let toolchain = self.config.model_toolchain.as_ref().ok_or_else(|| {
				adapter_failure(AdapterFailureKind::Spawn, "model execution requires a toolchain")
			})?;
			let protected = self
				.config
				.denied_roots
				.iter()
				.cloned()
				.map(|path| ProtectedBenchmarkPath { category: "denied_root", path })
				.collect::<Vec<_>>();

			isolation::validate_protected_layout(
				&protected,
				Some(&invocation.workspace_dir),
				&[toolchain.root().to_owned()],
			)
			.map_err(|error| adapter_failure(AdapterFailureKind::Spawn, error.to_string()))?;
		}

		let scratch = WorkspaceScratch::create(&invocation.workspace_dir)?;
		let scratch_environment = scratch.environment();
		let capture = self.execute_request_with_environment(
			invocation_args(
				invocation.model,
				invocation.sandbox,
				&invocation.workspace_dir,
				&self.config.denied_roots,
				self.config.model_toolchain.as_ref(),
			)?,
			invocation.prompt.as_bytes().to_vec(),
			invocation.timeout,
			invocation.max_steps,
			invocation.max_tool_calls,
			&scratch_environment,
		);
		let capture = match capture {
			Ok(capture) => capture,
			Err(failure) => {
				let _ = scratch.cleanup();

				return Err(failure);
			},
		};
		let classified = classify_capture(capture, &self.sink, true);

		if scratch.cleanup().is_err() {
			return Err(post_execution_integrity_failure(
				classified,
				"post-invocation scratch cleanup failed",
			));
		}

		classified
	}

	/// Proves explicit profile policy and active selection without starting a model turn.
	pub fn verify_managed_permission_profile(
		&self,
		workspace: &Path,
	) -> Result<ManagedPermissionProfileEvidence, AdapterFailure> {
		let workspace = fs::canonicalize(workspace).map_err(|error| {
			adapter_failure(
				AdapterFailureKind::Spawn,
				format!("cannot resolve managed-profile workspace: {error}"),
			)
		})?;
		let protected = self
			.config
			.denied_roots
			.iter()
			.cloned()
			.map(|path| ProtectedBenchmarkPath { category: "denied_root", path })
			.collect::<Vec<_>>();
		let toolchain = self.config.model_toolchain.as_ref().ok_or_else(|| {
			adapter_failure(
				AdapterFailureKind::Spawn,
				"permission profile probe requires a toolchain",
			)
		})?;

		isolation::validate_protected_layout(
			&protected,
			Some(&workspace),
			&[toolchain.root().to_owned()],
		)
		.map_err(|error| adapter_failure(AdapterFailureKind::Spawn, error.to_string()))?;

		let version = self.probe_version()?;

		if !codex_version_at_least(&version, 0, 138, 0) {
			return Err(adapter_failure(
				AdapterFailureKind::Unsupported,
				"permission profiles require Codex CLI 0.138.0 or later",
			));
		}

		let (args, stdin) = managed_profile_exchange(&workspace, &self.config.denied_roots)?;
		let scratch = WorkspaceScratch::create(&workspace)?;
		let scratch_environment = scratch.environment();
		let capture = self.execute_json_rpc_request(
			args,
			stdin,
			Duration::from_secs(20),
			&[0, 1, 2, 3],
			&scratch_environment,
		);
		let cleanup = scratch.cleanup();

		cleanup?;

		let capture = capture?;

		managed_profile_evidence(&capture.stdout, version)
	}

	/// Stores a final response that is too large for inline retention.
	pub fn store_artifact(
		&self,
		kind: &str,
		bytes: &[u8],
	) -> Result<ArtifactReference, ExecutorError> {
		self.sink.put(kind, bytes)
	}

	/// Proves that the active Codex CLI enforces the benchmark permission profile.
	pub fn verify_permission_boundary(
		&self,
		workspace: &Path,
		allowed_file: &Path,
		denied_files: &[PathBuf],
		writable_file: &Path,
	) -> Result<(), AdapterFailure> {
		let PermissionProbePaths { workspace, allowed_file, denied_files, writable_file } =
			canonicalize_permission_probe_paths(
				workspace,
				allowed_file,
				denied_files,
				writable_file,
			)?;
		let probe_executable =
			resolve_probe_executable(self.config.permission_probe_executable.as_deref())?;
		let toolchain = self.config.model_toolchain.as_ref().ok_or_else(|| {
			adapter_failure(
				AdapterFailureKind::Spawn,
				"permission probe requires a model toolchain",
			)
		})?;
		let read_only_file = toolchain.root().join(&toolchain.policy().commands[0].executable_ref);
		let read_only_write_file = toolchain.root().join(".aiq-read-only-canary");

		require_permission_canaries_absent(&writable_file, &read_only_write_file)?;

		if !allowed_file.starts_with(&workspace)
			|| !writable_file.starts_with(&workspace)
			|| denied_files.is_empty()
			|| denied_files.iter().any(|path| path.starts_with(&workspace))
			|| self
				.config
				.denied_roots
				.iter()
				.any(|root| !denied_files.iter().any(|path| path.starts_with(root)))
		{
			return Err(adapter_failure(
				AdapterFailureKind::Spawn,
				"isolation-probe paths do not define one allowed workspace and one denied external file",
			));
		}

		validate_permission_probe_files(&allowed_file, &denied_files)?;

		let protected = self
			.config
			.denied_roots
			.iter()
			.cloned()
			.map(|path| ProtectedBenchmarkPath { category: "denied_root", path })
			.collect::<Vec<_>>();

		isolation::validate_protected_layout(
			&protected,
			Some(&workspace),
			&[toolchain.root().to_owned()],
		)
		.map_err(|error| adapter_failure(AdapterFailureKind::Spawn, error.to_string()))?;

		let probe_executable = TemporaryProbeExecutable::copy_into(&workspace, &probe_executable)?;
		let listener =
			TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)).map_err(|error| {
				adapter_failure(
					AdapterFailureKind::Spawn,
					format!("cannot bind isolation-probe network sentinel: {error}"),
				)
			})?;
		let network_sentinel_port = listener.local_addr().map_err(|error| {
			adapter_failure(
				AdapterFailureKind::Spawn,
				format!("cannot resolve isolation-probe network sentinel: {error}"),
			)
		})?;
		let scratch = WorkspaceScratch::create(&workspace)?;
		let scratch_environment = scratch.environment();
		let capture = self.execute_request_with_environment(
			permission_probe_args(
				&workspace,
				&allowed_file,
				&denied_files,
				&writable_file,
				network_sentinel_port.port(),
				&probe_executable.path,
				&self.config.denied_roots,
				&self
					.config
					.model_toolchain
					.as_ref()
					.map(|toolchain| vec![toolchain.root().to_owned()])
					.unwrap_or_default(),
				&read_only_file,
				&read_only_write_file,
			)?,
			Vec::new(),
			Duration::from_secs(20),
			u32::MAX,
			u32::MAX,
			&scratch_environment,
		);
		let canary_cleanup =
			cleanup_permission_probe_canaries(&writable_file, &read_only_write_file);
		let scratch_cleanup = scratch.cleanup();
		let executable_cleanup = probe_executable.cleanup();
		let canary_observation = canary_cleanup?;

		if let Err(failure) = scratch_cleanup.and(executable_cleanup) {
			return preserve_permission_canary_evidence(Err(failure), canary_observation);
		}

		let output = preserve_permission_canary_evidence(
			capture.and_then(|capture| classify_capture(capture, &self.sink, false)),
			canary_observation,
		)?;

		if output.stdout.trim() != "AIQ_ISOLATION_OK" {
			return Err(adapter_failure(
				AdapterFailureKind::NonZeroExit,
				"Codex permission-profile isolation probe did not produce the exact clean sentinel",
			));
		}

		Ok(())
	}

	fn execute_request(
		&self,
		args: Vec<String>,
		stdin: Vec<u8>,
		timeout: Duration,
		max_steps: u32,
		max_tool_calls: u32,
	) -> Result<ExecutionCapture, AdapterFailure> {
		self.execute_request_with_environment(
			args,
			stdin,
			timeout,
			max_steps,
			max_tool_calls,
			&BTreeMap::new(),
		)
	}

	fn execute_request_with_environment(
		&self,
		args: Vec<String>,
		stdin: Vec<u8>,
		timeout: Duration,
		max_steps: u32,
		max_tool_calls: u32,
		extra_environment: &BTreeMap<String, String>,
	) -> Result<ExecutionCapture, AdapterFailure> {
		let codex_home = self.config.codex_home.display().to_string();
		let mut environment = self.config.allowed_environment.clone();

		environment.insert("CODEX_HOME".to_owned(), codex_home);
		environment.extend(extra_environment.clone());

		clear_outer_proxy_environment(&mut environment);

		let request = CommandRequest {
			program: self.codex_binary.clone(),
			args,
			stdin,
			timeout,
			max_capture_bytes: MAX_CAPTURE_BYTES,
			max_steps,
			max_tool_calls,
			clear_environment: true,
			environment,
		};

		self.executor
			.execute(&request)
			.map_err(|error| adapter_failure(AdapterFailureKind::Spawn, error.to_string()))
	}

	fn execute_json_rpc_request(
		&self,
		args: Vec<String>,
		stdin: Vec<u8>,
		timeout: Duration,
		expected_response_ids: &[u64],
		extra_environment: &BTreeMap<String, String>,
	) -> Result<ExecutionCapture, AdapterFailure> {
		let codex_home = self.config.codex_home.display().to_string();
		let mut environment = self.config.allowed_environment.clone();

		environment.insert("CODEX_HOME".to_owned(), codex_home);
		environment.extend(extra_environment.clone());

		clear_outer_proxy_environment(&mut environment);

		self.executor
			.execute_json_rpc(
				&CommandRequest {
					program: self.codex_binary.clone(),
					args,
					stdin,
					timeout,
					max_capture_bytes: MAX_CAPTURE_BYTES,
					max_steps: u32::MAX,
					max_tool_calls: u32::MAX,
					clear_environment: true,
					environment,
				},
				expected_response_ids,
			)
			.map_err(|error| adapter_failure(AdapterFailureKind::Spawn, error.to_string()))
	}

	/// Actively probes every configuration and validates it against the version-bound manifest.
	#[must_use]
	pub fn validate_capabilities(
		&self,
		manifest: &CapabilityManifest,
	) -> CapabilityValidationReport {
		self.validate_capabilities_inner(manifest)
	}

	fn validate_capabilities_inner(
		&self,
		manifest: &CapabilityManifest,
	) -> CapabilityValidationReport {
		let version = self.probe_version();
		let manifest_issues = validate_capability_manifest(manifest);
		let cli_probe = match &version {
			Ok(observed) => CliProbe {
				status: ProbeStatus::Available,
				version: Some(observed.clone()),
				failure: None,
			},
			Err(failure) => CliProbe {
				status: ProbeStatus::Unavailable,
				version: None,
				failure: Some(failure.clone()),
			},
		};
		let authentication = self.probe_authentication();
		let authentication_probe = match &authentication {
			Ok(mode) => AuthenticationProbe {
				status: ProbeStatus::Available,
				mode: Some(mode.clone()),
				failure: None,
			},
			Err(failure) => AuthenticationProbe {
				status: ProbeStatus::Unavailable,
				mode: None,
				failure: Some(failure.clone()),
			},
		};
		let version_matches =
			version.as_ref().is_ok_and(|observed| observed.trim() == manifest.codex_version.trim());
		let can_probe_configurations =
			authentication.is_ok() && manifest_issues.is_empty() && version_matches;
		let models = MODEL_MATRIX
			.into_iter()
			.map(|model| {
				let observed_at = observation_time();
				let active = if can_probe_configurations {
					self.probe_configuration(model)
				} else if let Err(failure) = &authentication {
					Err(failure.clone())
				} else {
					Err(adapter_failure(
						AdapterFailureKind::NonZeroExit,
						"configuration probes skipped because manifest/version preflight failed",
					))
				};

				validate_model(
					manifest,
					model,
					version.as_ref().ok(),
					version_matches,
					manifest_issues.is_empty(),
					observed_at,
					active,
				)
			})
			.collect();
		let mut report = CapabilityValidationReport {
			schema_version: "aiq.capability-validation.v2".to_owned(),
			node_id: manifest.node_id.clone(),
			manifest_issues,
			cli_probe,
			authentication_probe,
			models,
		};

		normalize_preflight_report(&mut report);

		report
	}

	fn probe_authentication(&self) -> Result<String, AdapterFailure> {
		let capture = self.execute_request(
			vec!["login".to_owned(), "status".to_owned()],
			Vec::new(),
			Duration::from_secs(10),
			u32::MAX,
			u32::MAX,
		)?;
		let output = classify_capture(capture, &self.sink, false)?;

		if [output.stdout.trim(), output.stderr.trim()].contains(&"Logged in using ChatGPT") {
			Ok("chatgpt_subscription".to_owned())
		} else {
			Err(adapter_failure(
				AdapterFailureKind::Authentication,
				"Codex login mode is not a recognized ChatGPT subscription",
			))
		}
	}

	fn probe_configuration(&self, model: ModelConfig) -> Result<CodexOutput, AdapterFailure> {
		let scratch = WorkspaceScratch::create(&self.config.codex_home)?;
		let scratch_environment = scratch.environment();
		let capture = self.execute_request_with_environment(
			invocation_args(
				model,
				SandboxPolicy::NoTools,
				Path::new("."),
				&self.config.denied_roots,
				self.config.model_toolchain.as_ref(),
			)?,
			b"Reply with exactly AIQ_PREFLIGHT_OK. Do not use tools.".to_vec(),
			Duration::from_secs(30),
			1,
			0,
			&scratch_environment,
		);
		let cleanup = scratch.cleanup();

		cleanup?;

		let capture = capture?;
		let output = classify_capture(capture, &self.sink, false)?;

		if extract_probe_response(&output.stdout_full).as_deref() != Some("AIQ_PREFLIGHT_OK") {
			return Err(adapter_failure(
				AdapterFailureKind::NonZeroExit,
				"configuration probe did not return the exact preflight sentinel",
			));
		}

		Ok(output)
	}
}

/// Codex CLI probe details.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CliProbe {
	/// Probe status.
	pub status: ProbeStatus,
	/// Observed version.
	pub version: Option<String>,
	/// Structured probe failure.
	pub failure: Option<AdapterFailure>,
}

/// Subscription authentication probe.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AuthenticationProbe {
	/// Whether a recognized subscription mode was observed.
	pub status: ProbeStatus,
	/// Stable recognized mode.
	pub mode: Option<String>,
	/// Rejection or probe failure.
	pub failure: Option<AdapterFailure>,
}

/// Receiver-verifiable per-configuration evidence.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ConfigurationProbe {
	/// Active observation.
	pub status: ConfigurationProbeStatus,
	/// Version observed before this configuration was interpreted.
	pub codex_version: Option<String>,
	/// Local observation time.
	pub observed_at: String,
	/// Digest of the exact bounded successful probe output.
	pub result_digest: Option<String>,
	/// Bounded successful probe-output preview.
	pub result_preview: Option<String>,
	/// Structured references when probe evidence exceeds the preview bound.
	pub artifacts: Vec<ArtifactReference>,
	/// Digest binding version, configuration, time, and bounded probe result.
	pub evidence_digest: String,
	/// Structured failure, if any.
	pub failure: Option<AdapterFailure>,
}

/// Validation of one matrix entry.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CapabilityValidation {
	/// Model configuration.
	pub model: ModelConfig,
	/// Effective status.
	pub status: CapabilityValidationStatus,
	/// Evidence or failure reason.
	pub reason: String,
	/// Active exact-configuration probe evidence.
	pub probe: ConfigurationProbe,
}

/// Complete matrix validation report.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CapabilityValidationReport {
	/// Validation schema version.
	pub schema_version: String,
	/// Claiming node identifier.
	pub node_id: String,
	/// Structural capability-manifest issues.
	pub manifest_issues: Vec<String>,
	/// Local CLI probe.
	pub cli_probe: CliProbe,
	/// Subscription-only login probe.
	pub authentication_probe: AuthenticationProbe,
	/// Exactly 17 effective model statuses.
	pub models: Vec<CapabilityValidation>,
}
impl CapabilityValidationReport {
	/// Returns the effective validation for one model.
	#[must_use]
	pub fn model(&self, model: ModelConfig) -> Option<&CapabilityValidation> {
		self.models.iter().find(|entry| entry.model == model)
	}

	/// Returns whether all entries have current usable evidence.
	#[must_use]
	pub fn is_usable(&self) -> bool {
		self.schema_version == "aiq.capability-validation.v2"
			&& self.manifest_issues.is_empty()
			&& self.cli_probe.status == ProbeStatus::Available
			&& self.authentication_probe.status == ProbeStatus::Available
			&& self.authentication_probe.mode.as_deref() == Some("chatgpt_subscription")
			&& self.models.len() == MODEL_MATRIX.len()
			&& self.models.iter().all(|model| {
				model.status != CapabilityValidationStatus::Unavailable
					&& matches!(
						(model.status, model.probe.status),
						(
							CapabilityValidationStatus::Available,
							ConfigurationProbeStatus::Available
						) | (
							CapabilityValidationStatus::Unsupported,
							ConfigurationProbeStatus::ObservedUnsupported
						)
					)
			})
	}
}

/// The crate-owned production child-process executor.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct SystemExecutor;
impl Executor for SystemExecutor {
	fn execute(&self, request: &CommandRequest) -> Result<ExecutionCapture, ExecutorError> {
		execute_system_process(request, None)
	}

	fn execute_observed(
		&self,
		request: &CommandRequest,
		observer: &dyn ChildProcessObserver,
	) -> Result<ExecutionCapture, ExecutorError> {
		execute_system_process(request, Some(observer))
	}

	fn execute_json_rpc(
		&self,
		request: &CommandRequest,
		expected_response_ids: &[u64],
	) -> Result<ExecutionCapture, ExecutorError> {
		execute_json_rpc_process(request, expected_response_ids)
	}
}

/// Public-safe observation of one exact controlled ChatGPT credential file.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub(crate) struct ChatgptCredentialObservation {
	/// Digest of locally decoded account, user, and plan claims.
	///
	/// These local observations are not cryptographically authenticated claims.
	pub account_claim_digest: String,
	/// Domain-separated digest of every byte in the bounded credential file.
	pub credential_digest: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct NormalizedCodexItem {
	pub version: &'static str,
	pub phase: CodexItemPhase,
	pub item_id: Option<String>,
	pub raw_type: String,
	pub is_tool_call: bool,
}

struct SystemPipes {
	stdout: ChildStdout,
	stderr: ChildStderr,
	stdin: ChildStdin,
}

struct JsonRpcIoThreads {
	stdout: JoinHandle<()>,
	stdout_events: Receiver<JsonRpcStdoutEvent>,
	stderr: CaptureThread,
	breach_events: Receiver<LiveBudgetKind>,
	stdin: JoinHandle<()>,
	stdin_events: Receiver<Result<(), String>>,
	stdin_close: Sender<()>,
}

struct ProcessWaitOutcome {
	status: ExitStatus,
	timed_out: bool,
	budget_exceeded: Option<LiveBudgetKind>,
}

struct JsonRpcExchangeOutcome {
	captured: Vec<u8>,
	failure: Option<String>,
}

#[derive(Serialize)]
struct ManagedPermissionProfileEvidenceBody<'a> {
	schema_version: &'a str,
	codex_version: &'a str,
	default_permissions: &'a str,
	allowed_permission_profile: &'a str,
	active_permission_profile: &'a str,
	official_eligible: bool,
	managed_requirements_status: &'a str,
	managed_requirements_digest: &'a str,
	profile_selection_digest: &'a str,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ConfigRequirementsReadResult {
	requirements: Option<Value>,
}

#[derive(Deserialize)]
struct PermissionProfileListResult {
	data: Vec<PermissionProfileSummary>,
}

#[derive(Deserialize)]
struct PermissionProfileSummary {
	id: String,
	allowed: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadStartProfileResult {
	active_permission_profile: Option<ActivePermissionProfile>,
}

#[derive(Deserialize)]
struct ActivePermissionProfile {
	id: String,
}

#[derive(Deserialize)]
struct JsonRpcResponse<T> {
	id: u64,
	result: Option<T>,
	error: Option<Value>,
}

struct WorkspaceScratch {
	path: PathBuf,
	cleaned: bool,
}
impl WorkspaceScratch {
	fn create(workspace: &Path) -> Result<Self, AdapterFailure> {
		let workspace = fs::canonicalize(workspace).map_err(|error| {
			adapter_failure(
				AdapterFailureKind::Spawn,
				format!("cannot resolve controlled scratch workspace: {error}"),
			)
		})?;

		for nonce in 0_u8..16 {
			let timestamp =
				SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |value| value.as_nanos());
			let path =
				workspace.join(format!(".aiq-scratch-{}-{}-{nonce}", process::id(), timestamp));

			match fs::create_dir(&path) {
				Ok(()) => {
					#[cfg(unix)]
					fs::set_permissions(&path, Permissions::from_mode(0o700)).map_err(|error| {
						adapter_failure(
							AdapterFailureKind::Spawn,
							format!("cannot restrict controlled scratch directory: {error}"),
						)
					})?;

					return Ok(Self { path, cleaned: false });
				},
				Err(error) if error.kind() == ErrorKind::AlreadyExists => {},
				Err(error) => {
					return Err(adapter_failure(
						AdapterFailureKind::Spawn,
						format!("cannot create controlled scratch directory: {error}"),
					));
				},
			}
		}

		Err(adapter_failure(
			AdapterFailureKind::Spawn,
			"cannot allocate a unique controlled scratch directory",
		))
	}

	fn environment(&self) -> BTreeMap<String, String> {
		let value = self.path.display().to_string();
		#[cfg(not(windows))]
		let environment = BTreeMap::from([("TMPDIR".to_owned(), value)]);
		#[cfg(windows)]
		let mut environment = BTreeMap::from([("TMPDIR".to_owned(), value.clone())]);

		#[cfg(windows)]
		{
			environment.insert("TEMP".to_owned(), value.clone());
			environment.insert("TMP".to_owned(), value);
		}

		environment
	}

	fn cleanup(mut self) -> Result<(), AdapterFailure> {
		self.remove()?;

		self.cleaned = true;

		Ok(())
	}

	fn remove(&self) -> Result<(), AdapterFailure> {
		let metadata = match fs::symlink_metadata(&self.path) {
			Ok(metadata) => metadata,
			Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
			Err(error) => {
				return Err(adapter_failure(
					AdapterFailureKind::Spawn,
					format!("cannot inspect controlled scratch directory: {error}"),
				));
			},
		};

		if metadata.file_type().is_symlink() || !metadata.is_dir() {
			return Err(adapter_failure(
				AdapterFailureKind::Spawn,
				"controlled scratch path changed type before cleanup",
			));
		}

		match fs::remove_dir_all(&self.path) {
			Ok(()) => Ok(()),
			Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
			Err(error) => Err(adapter_failure(
				AdapterFailureKind::Spawn,
				format!("cannot remove controlled scratch directory: {error}"),
			)),
		}
	}
}

impl Drop for WorkspaceScratch {
	fn drop(&mut self) {
		if !self.cleaned {
			let _ = self.remove();
		}
	}
}

struct TemporaryProbeExecutable {
	path: PathBuf,
	cleaned: bool,
}
impl TemporaryProbeExecutable {
	fn copy_into(workspace: &Path, source: &Path) -> Result<Self, AdapterFailure> {
		let extension = if cfg!(windows) { ".exe" } else { "" };
		let path = workspace.join(format!(".aiq-permission-probe-{extension}"));

		if fs::symlink_metadata(&path).is_ok() {
			return Err(adapter_failure(
				AdapterFailureKind::Spawn,
				"controlled permission-probe executable path already exists",
			));
		}

		fs::copy(source, &path).map_err(|error| {
			adapter_failure(
				AdapterFailureKind::Spawn,
				format!("cannot copy controlled permission-probe executable: {error}"),
			)
		})?;
		#[cfg(unix)]
		fs::set_permissions(&path, Permissions::from_mode(0o700)).map_err(|error| {
			adapter_failure(
				AdapterFailureKind::Spawn,
				format!("cannot restrict controlled permission-probe executable: {error}"),
			)
		})?;

		Ok(Self { path, cleaned: false })
	}

	fn cleanup(mut self) -> Result<(), AdapterFailure> {
		self.remove()?;

		self.cleaned = true;

		Ok(())
	}

	fn remove(&self) -> Result<(), AdapterFailure> {
		let metadata = fs::symlink_metadata(&self.path).map_err(|error| {
			adapter_failure(
				AdapterFailureKind::Spawn,
				format!("cannot inspect controlled permission-probe executable: {error}"),
			)
		})?;

		if metadata.file_type().is_symlink() || !metadata.is_file() {
			return Err(adapter_failure(
				AdapterFailureKind::Spawn,
				"controlled permission-probe executable changed type before cleanup",
			));
		}

		fs::remove_file(&self.path).map_err(|error| {
			adapter_failure(
				AdapterFailureKind::Spawn,
				format!("cannot remove controlled permission-probe executable: {error}"),
			)
		})
	}
}

impl Drop for TemporaryProbeExecutable {
	fn drop(&mut self) {
		if !self.cleaned {
			let _ = self.remove();
		}
	}
}

#[derive(Default)]
struct LiveItemAccounting {
	steps: u32,
	tool_calls: u32,
	pending_ids: BTreeMap<String, String>,
	pending_types: BTreeMap<String, u32>,
}
impl LiveItemAccounting {
	fn observe(&mut self, line: &[u8]) {
		let Some(item) = normalize_codex_item(line) else {
			return;
		};

		if item.phase == CodexItemPhase::Completed {
			self.steps = self.steps.saturating_add(1);
		}
		if !item.is_tool_call {
			return;
		}

		match (item.phase, item.item_id) {
			(CodexItemPhase::Started, Some(item_id)) => {
				if self.pending_ids.insert(item_id, item.raw_type).is_none() {
					self.tool_calls = self.tool_calls.saturating_add(1);
				}
			},
			(CodexItemPhase::Completed, Some(item_id)) => {
				if self.pending_ids.remove(&item_id).as_deref() != Some(&item.raw_type) {
					self.tool_calls = self.tool_calls.saturating_add(1);
				}
			},
			(CodexItemPhase::Started, None) => {
				let pending = self.pending_types.entry(item.raw_type).or_default();

				*pending = pending.saturating_add(1);
				self.tool_calls = self.tool_calls.saturating_add(1);
			},
			(CodexItemPhase::Completed, None) => {
				let pending = self.pending_types.entry(item.raw_type).or_default();

				if *pending == 0 {
					self.tool_calls = self.tool_calls.saturating_add(1);
				} else {
					*pending -= 1;
				}
			},
		}
	}
}

struct PermissionProbePaths {
	workspace: PathBuf,
	allowed_file: PathBuf,
	denied_files: Vec<PathBuf>,
	writable_file: PathBuf,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct PermissionCanaryObservation {
	writable_created: bool,
	read_only_created: bool,
}
impl PermissionCanaryObservation {
	fn occurred(self) -> bool {
		self.writable_created || self.read_only_created
	}

	fn evidence(self) -> &'static str {
		match (self.writable_created, self.read_only_created) {
			(true, true) => {
				"permission probe left writable and read-only canary files; both were removed"
			},
			(true, false) => "permission probe left a writable canary file; it was removed",
			(false, true) => {
				"permission probe created a file in the read-only toolchain; it was removed"
			},
			(false, false) => "permission probe created no canary files",
		}
	}
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CodexItemPhase {
	Started,
	Completed,
}

/// A live budget that caused the executor to terminate the child.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LiveBudgetKind {
	/// A captured stream exceeded its byte limit.
	Output,
	/// Completed Codex items exceeded the step limit.
	Steps,
	/// Tool calls exceeded the tool-call limit.
	ToolCalls,
}

/// Classified adapter failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AdapterFailureKind {
	/// The process could not start or could not be observed.
	Spawn,
	/// The process exceeded its hard deadline.
	Timeout,
	/// An active configuration probe observed unsupported.
	Unsupported,
	/// Codex requires authentication or authorization.
	Authentication,
	/// The subscription reached a stable usage limit or quota boundary.
	UsageLimit,
	/// Codex exited unsuccessfully for another reason.
	NonZeroExit,
	/// A live output, step, or tool budget was exceeded.
	BudgetExceeded,
	/// A captured stream exceeded the retained byte limit.
	OutputTruncated,
	/// A paid invocation completed, but its evidence or scratch cleanup failed.
	WorkspaceIntegrity,
}

/// Sandbox policy accepted by safe benchmark invocations.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SandboxPolicy {
	/// Disable all tool execution.
	NoTools,
	/// Enable only controlled Codex web search.
	WebOnly,
	/// Disallow workspace writes.
	ReadOnly,
	/// Read-only workspace plus controlled web search.
	ReadOnlyWeb,
	/// Allow writes inside the controlled workspace.
	WorkspaceWrite,
	/// Workspace writes plus controlled web search.
	WorkspaceWriteWeb,
}
impl SandboxPolicy {
	fn workspace_access(self) -> Option<&'static str> {
		match self {
			Self::NoTools | Self::WebOnly => None,
			Self::ReadOnly | Self::ReadOnlyWeb => Some("read"),
			Self::WorkspaceWrite | Self::WorkspaceWriteWeb => Some("write"),
		}
	}

	fn permits_web_search(self) -> bool {
		matches!(self, Self::WebOnly | Self::ReadOnlyWeb | Self::WorkspaceWriteWeb)
	}

	fn permits_shell(self) -> bool {
		!matches!(self, Self::NoTools | Self::WebOnly)
	}

	/// Converts an enforceable task tool policy into a sandbox.
	pub fn from_allowed_tools(tools: &[String]) -> Result<Self, ExecutorError> {
		if tools.iter().any(|tool| tool == "none") {
			if tools.len() == 1 {
				return Ok(Self::NoTools);
			}

			return Err(ExecutorError::new(
				"the none tool policy is exclusive and cannot be combined",
			));
		}

		let supported = BTreeSet::from([
			"filesystem_read",
			"filesystem_write",
			"web_search",
			"command_execution",
		]);

		if let Some(tool) = tools.iter().find(|tool| !supported.contains(tool.as_str())) {
			return Err(ExecutorError::new(format!(
				"task requests unenforceable tool policy: {tool}"
			)));
		}

		if tools.iter().any(|tool| tool == "command_execution")
			&& !tools
				.iter()
				.any(|tool| matches!(tool.as_str(), "filesystem_read" | "filesystem_write"))
		{
			return Err(ExecutorError::new(
				"command_execution requires filesystem_read or filesystem_write",
			));
		}

		let web = tools.iter().any(|tool| tool == "web_search");

		Ok(if tools.is_empty() {
			Self::NoTools
		} else if tools.iter().any(|tool| tool == "filesystem_write") {
			if web { Self::WorkspaceWriteWeb } else { Self::WorkspaceWrite }
		} else if tools.iter().any(|tool| tool == "filesystem_read") {
			if web { Self::ReadOnlyWeb } else { Self::ReadOnly }
		} else if web {
			Self::WebOnly
		} else {
			Self::NoTools
		})
	}
}

/// Codex CLI probe status.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProbeStatus {
	/// Probe completed.
	Available,
	/// Probe failed.
	Unavailable,
}

/// Active per-configuration probe status.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConfigurationProbeStatus {
	/// The exact configuration completed the bounded probe.
	Available,
	/// The exact configuration was actively observed as unsupported.
	ObservedUnsupported,
	/// The probe failed without establishing support.
	Failed,
}

/// Effective availability after claim and active probe validation.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityValidationStatus {
	/// Capability can be invoked.
	Available,
	/// An active current probe observed unsupported.
	Unsupported,
	/// Current evidence cannot establish support.
	Unavailable,
}

enum JsonRpcStdoutEvent {
	Chunk(Vec<u8>),
	CaptureLimitExceeded,
	ReadFailed(String),
	End,
}

/// Observes a private credential from a platform-protected controlled source.
pub(crate) fn chatgpt_credential_observation(
	codex_home: &Path,
) -> Result<ChatgptCredentialObservation, ExecutorError> {
	let (_, _, _, _, observation) = open_and_observe_credential(codex_home, true)?;

	Ok(observation)
}

#[cfg(test)]
pub(crate) fn chatgpt_credential_observation_for_test(
	codex_home: &Path,
) -> Result<ChatgptCredentialObservation, ExecutorError> {
	let (_, _, _, _, observation) = open_and_observe_credential(codex_home, false)?;

	Ok(observation)
}

pub(crate) fn normalize_codex_item(line: &[u8]) -> Option<NormalizedCodexItem> {
	let Ok(value) = serde_json::from_slice::<Value>(line) else {
		return None;
	};
	let phase = match value.get("type").and_then(Value::as_str) {
		Some("item.started") => CodexItemPhase::Started,
		Some("item.completed") => CodexItemPhase::Completed,
		_ => return None,
	};
	let item = value.get("item")?.as_object()?;
	let raw_type = item.get("type")?.as_str()?;

	if raw_type.is_empty() {
		return None;
	}

	// Known presentation/reasoning items are not tools. A future item type is
	// conservatively a tool so a Codex format addition cannot bypass a task budget.
	let is_tool_call = !matches!(raw_type, "agent_message" | "message" | "reasoning" | "todo_list");

	Some(NormalizedCodexItem {
		version: CODEX_ITEM_ACCOUNTING_VERSION,
		phase,
		item_id: item.get("id").and_then(Value::as_str).map(ToOwned::to_owned),
		raw_type: raw_type.to_owned(),
		is_tool_call,
	})
}

pub(crate) fn safe_codex_version(value: &str) -> bool {
	!value.is_empty()
		&& value.len() <= MAX_CODEX_VERSION_BYTES
		&& value.bytes().all(|byte| (b' '..=b'~').contains(&byte) && !matches!(byte, b'"' | b'\\'))
}

/// Recomputes the signed-data commitment for one active configuration probe.
#[allow(clippy::too_many_arguments)]
pub fn configuration_evidence_digest(
	model: ModelConfig,
	codex_version: Option<&String>,
	observed_at: &str,
	status: ConfigurationProbeStatus,
	result_digest: Option<&str>,
	result_preview: Option<&str>,
	artifacts: &[ArtifactReference],
	failure: Option<&AdapterFailure>,
) -> Result<String, ProtocolError> {
	protocol::canonical_hash(&(
		model,
		codex_version,
		observed_at,
		status,
		result_digest,
		result_preview,
		artifacts,
		failure,
	))
}

/// Runs the hidden, model-free permission canary inside `codex sandbox`.
#[doc(hidden)]
pub fn run_permission_probe(
	allowed_file: &Path,
	denied_files: &[PathBuf],
	writable_file: &Path,
	read_only_file: &Path,
	read_only_write_file: &Path,
	network_sentinel_port: u16,
) -> Result<(), ExecutorError> {
	let allowed = fs::read_to_string(allowed_file)
		.map_err(|error| ExecutorError::new(format!("cannot read allowed canary: {error}")))?;

	if allowed.trim() != "AIQ_ALLOWED" {
		return Err(ExecutorError::new("allowed canary content mismatch"));
	}
	if denied_files.is_empty() {
		return Err(ExecutorError::new("permission probe received no denied canary"));
	}

	let mut read_only = OpenOptions::new()
		.read(true)
		.open(read_only_file)
		.map_err(|error| ExecutorError::new(format!("cannot open read-only canary: {error}")))?;
	let mut first_byte = [0_u8; 1];

	read_only
		.read_exact(&mut first_byte)
		.map_err(|error| ExecutorError::new(format!("cannot read read-only canary: {error}")))?;

	match OpenOptions::new().write(true).create_new(true).open(read_only_write_file) {
		Ok(_) => return Err(ExecutorError::new("read-only canary root was writable")),
		Err(error) if error.kind() == ErrorKind::PermissionDenied => {},
		Err(error) => {
			return Err(ExecutorError::new(format!(
				"read-only write canary failed for an unexpected reason: {error}"
			)));
		},
	}

	for denied_file in denied_files {
		match fs::read(denied_file) {
			Ok(_) => return Err(ExecutorError::new("a denied canary was readable")),
			Err(error) if error.kind() == ErrorKind::PermissionDenied => {},
			Err(error) => {
				return Err(ExecutorError::new(format!(
					"denied canary failed for an unexpected reason: {error}"
				)));
			},
		}
	}

	let mut options = OpenOptions::new();

	options.write(true).create_new(true);

	#[cfg(unix)]
	std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);

	let mut writable = options
		.open(writable_file)
		.map_err(|error| ExecutorError::new(format!("cannot create writable canary: {error}")))?;

	writable
		.write_all(b"AIQ_WRITE")
		.map_err(|error| ExecutorError::new(format!("cannot write writable canary: {error}")))?;

	drop(writable);

	let written = fs::read(writable_file)
		.map_err(|error| ExecutorError::new(format!("cannot read writable canary: {error}")))?;

	fs::remove_file(writable_file)
		.map_err(|error| ExecutorError::new(format!("cannot remove writable canary: {error}")))?;

	if written != b"AIQ_WRITE" {
		return Err(ExecutorError::new("writable canary content mismatch"));
	}

	match TcpStream::connect(SocketAddrV4::new(Ipv4Addr::LOCALHOST, network_sentinel_port)) {
		Ok(_) => return Err(ExecutorError::new("loopback network canary was reachable")),
		Err(error) if error.kind() == ErrorKind::PermissionDenied => {},
		Err(error) => {
			return Err(ExecutorError::new(format!(
				"network canary failed for an unexpected reason: {error}"
			)));
		},
	}

	io::stdout()
		.write_all(b"AIQ_ISOLATION_OK")
		.map_err(|error| ExecutorError::new(format!("cannot write isolation sentinel: {error}")))
}

/// Returns public-safe structural issues in a capability manifest.
#[must_use]
pub fn validate_capability_manifest(manifest: &CapabilityManifest) -> Vec<String> {
	let mut issues = Vec::new();

	if manifest.schema_version != "aiq.capabilities.v1" {
		issues.push("schema_version must be aiq.capabilities.v1".to_owned());
	}
	if !is_node_id(&manifest.node_id) {
		issues.push(
			"node_id must be node_ followed by 64 lowercase hexadecimal characters".to_owned(),
		);
	}
	if !is_utc_timestamp(&manifest.observed_at) {
		issues.push("observed_at must use YYYY-MM-DDTHH:MM:SSZ UTC form".to_owned());
	}
	if !safe_codex_version(manifest.codex_version.trim()) {
		issues.push("codex_version must be bounded printable ASCII".to_owned());
	}

	let claimed = manifest.models.iter().map(|claim| claim.model).collect::<BTreeSet<_>>();
	let expected = MODEL_MATRIX.into_iter().collect::<BTreeSet<_>>();

	if manifest.models.len() != MODEL_MATRIX.len() || claimed != expected {
		issues.push("models must contain each of the 17 matrix entries exactly once".to_owned());
	}
	if manifest.models.iter().any(|claim| {
		claim.status == CapabilityStatus::Unsupported
			&& claim.reason.as_deref().is_none_or(|reason| reason.trim().is_empty())
	}) {
		issues.push("each unsupported model claim must have a nonempty reason".to_owned());
	}

	issues
}

/// Digests the exact filesystem and network policy without executing Codex.
pub fn permission_policy_digest(
	workspace: &Path,
	denied_roots: &[PathBuf],
	model_toolchain: Option<&ValidatedModelToolchain>,
) -> Result<String, AdapterFailure> {
	let workspace = fs::canonicalize(workspace).map_err(|error| {
		adapter_failure(
			AdapterFailureKind::Spawn,
			format!("cannot resolve permission-policy workspace: {error}"),
		)
	})?;
	let filesystem = permission_filesystem_config(
		SandboxPolicy::WorkspaceWrite,
		utf8_path(&workspace, "permission-policy workspace")?,
		denied_roots,
		&model_toolchain.map(|toolchain| vec![toolchain.root().to_owned()]).unwrap_or_default(),
	)?;

	protocol::canonical_hash(&(
		"aiq.permission-policy.v1",
		PLATFORM_MINIMAL_ROOTS_VERSION,
		filesystem,
		format!("permissions.{BENCHMARK_PERMISSION_PROFILE}.network.enabled=false"),
	))
	.map_err(|error| {
		adapter_failure(
			AdapterFailureKind::Spawn,
			format!("cannot digest permission policy: {error}"),
		)
	})
}

/// Computes the exact explicit-profile digests an Official probe must observe.
pub fn expected_official_permission_profile_digests(
	codex_version: &str,
) -> Result<ExpectedOfficialPermissionProfileDigests, AdapterFailure> {
	let codex_version = codex_version.trim();

	if !safe_codex_version(codex_version) {
		return Err(adapter_failure(
			AdapterFailureKind::Spawn,
			"cannot plan Official permissions from an invalid Codex version",
		));
	}

	let requirements = ConfigRequirementsReadResult { requirements: None };
	let managed_requirements_digest = protocol::canonical_hash(&(
		"aiq.managed-permission-requirements.v1",
		codex_version,
		&requirements,
	))
	.map_err(|error| {
		adapter_failure(
			AdapterFailureKind::Spawn,
			format!("cannot digest expected absent managed requirements: {error}"),
		)
	})?;
	let profile_selection_digest = protocol::canonical_hash(&(
		"aiq.permission-profile-selection.v1",
		codex_version,
		BENCHMARK_PERMISSION_PROFILE,
	))
	.map_err(|error| {
		adapter_failure(
			AdapterFailureKind::Spawn,
			format!("cannot digest expected permission profile: {error}"),
		)
	})?;

	Ok(ExpectedOfficialPermissionProfileDigests {
		managed_requirements_digest,
		profile_selection_digest,
	})
}

fn clear_outer_proxy_environment(environment: &mut BTreeMap<String, String>) {
	for key in CODEX_PROXY_ENVIRONMENT_KEYS {
		environment.remove(key);
	}

	environment.remove("NO_PROXY");
	environment.remove("no_proxy");
}

fn spawn_process_thread<F, T>(name: &'static str, function: F) -> std::io::Result<JoinHandle<T>>
where
	F: FnOnce() -> T + Send + 'static,
	T: Send + 'static,
{
	#[cfg(test)]
	if FORCED_PROCESS_THREAD_SPAWN_FAILURE.with(|forced| match forced.get() {
		Some(0) => {
			forced.set(None);

			true
		},
		Some(remaining) => {
			forced.set(Some(remaining - 1));

			false
		},
		None => false,
	}) {
		return Err(std::io::Error::other("forced process thread spawn failure"));
	}

	Builder::new().name(name.to_owned()).spawn(function)
}

#[cfg(test)]
fn force_process_thread_spawn_failure_for_test(index: usize) {
	FORCED_PROCESS_THREAD_SPAWN_FAILURE.with(|forced| forced.set(Some(index)));
}

#[cfg(test)]
fn take_last_json_rpc_child_pid_for_test() -> Option<u32> {
	LAST_JSON_RPC_CHILD_PID.with(Cell::take)
}

#[cfg(all(test, target_os = "linux"))]
fn force_json_rpc_stop_failure_for_test() {
	FORCE_JSON_RPC_STOP_FAILURE.with(|forced| forced.set(true));
}

fn open_and_observe_credential(
	codex_home: &Path,
	require_protected_source: bool,
) -> Result<
	(PinnedDirectoryIdentity, PathBuf, File, PinnedPathIdentity, ChatgptCredentialObservation),
	ExecutorError,
> {
	let home_metadata = fs::symlink_metadata(codex_home)
		.map_err(|_| ExecutorError::new("controlled Codex authentication is unavailable"))?;

	if home_metadata.file_type().is_symlink() || !home_metadata.is_dir() {
		return Err(ExecutorError::new("controlled Codex authentication is unavailable"));
	}

	let canonical_home = fs::canonicalize(codex_home)
		.map_err(|_| ExecutorError::new("controlled Codex authentication is unavailable"))?;
	let canonical_home_metadata = fs::metadata(&canonical_home)
		.map_err(|_| ExecutorError::new("controlled Codex authentication is unavailable"))?;
	let home = PinnedDirectoryIdentity::capture(&canonical_home)
		.map_err(|_| ExecutorError::new("controlled Codex authentication home cannot be pinned"))?;
	let auth_path = canonical_home.join("auth.json");
	let path_metadata = fs::symlink_metadata(&auth_path)
		.map_err(|_| ExecutorError::new("controlled Codex authentication is unavailable"))?;

	validate_auth_metadata(&path_metadata)?;

	let mut options = OpenOptions::new();

	options.read(true);

	#[cfg(unix)]
	std::os::unix::fs::OpenOptionsExt::custom_flags(&mut options, O_NOFOLLOW);
	#[cfg(windows)]
	std::os::windows::fs::OpenOptionsExt::custom_flags(
		&mut options,
		FileSystem::FILE_FLAG_OPEN_REPARSE_POINT,
	);

	let auth_file = options
		.open(&auth_path)
		.map_err(|_| ExecutorError::new("controlled Codex authentication is unavailable"))?;
	let opened_metadata = auth_file
		.metadata()
		.map_err(|_| ExecutorError::new("controlled Codex authentication is unavailable"))?;

	validate_auth_metadata(&opened_metadata)?;

	if !same_auth_file(&path_metadata, &opened_metadata) {
		return Err(ExecutorError::new("controlled Codex authentication changed while opening"));
	}

	verify_auth_identity(
		&canonical_home,
		&canonical_home_metadata,
		&auth_path,
		&path_metadata,
		&auth_file,
	)?;

	if require_protected_source {
		require_protected_credential_source(&auth_file)?;
	}

	let auth_identity = PinnedPathIdentity::capture(&auth_path, &auth_file)
		.map_err(|_| ExecutorError::new("controlled Codex authentication cannot be pinned"))?;
	let observation = observe_credential_file(&auth_file)?;

	home.verify()
		.map_err(|_| ExecutorError::new("controlled Codex authentication home changed"))?;
	auth_identity
		.verify(&auth_path, &auth_file)
		.map_err(|_| ExecutorError::new("controlled Codex authentication changed"))?;

	Ok((home, auth_path, auth_file, auth_identity, observation))
}

fn observe_credential_file(
	auth_file: &File,
) -> Result<ChatgptCredentialObservation, ExecutorError> {
	let metadata = auth_file
		.metadata()
		.map_err(|_| ExecutorError::new("controlled Codex authentication cannot be inspected"))?;

	validate_auth_metadata(&metadata)?;

	let expected_len = usize::try_from(metadata.len())
		.map_err(|_| ExecutorError::new("controlled Codex authentication has an invalid size"))?;
	let mut bytes = vec![0_u8; expected_len];
	let mut offset = 0_usize;

	while offset < bytes.len() {
		let file_offset = u64::try_from(offset).map_err(|_| {
			ExecutorError::new("controlled Codex authentication has an invalid size")
		})?;
		let read = read_file_at(auth_file, &mut bytes[offset..], file_offset)
			.map_err(|_| ExecutorError::new("controlled Codex authentication cannot be read"))?;

		if read == 0 {
			bytes.fill(0);

			return Err(ExecutorError::new(
				"controlled Codex authentication changed while reading",
			));
		}

		offset = offset.checked_add(read).ok_or_else(|| {
			ExecutorError::new("controlled Codex authentication has an invalid size")
		})?;
	}

	let mut extra = [0_u8; 1];

	if read_file_at(auth_file, &mut extra, metadata.len())
		.map_err(|_| ExecutorError::new("controlled Codex authentication cannot be read"))?
		!= 0
	{
		bytes.fill(0);

		return Err(ExecutorError::new("controlled Codex authentication changed while reading"));
	}
	if bytes.is_empty() || u64::try_from(bytes.len()).unwrap_or(u64::MAX) > MAX_AUTH_JSON_BYTES {
		bytes.fill(0);

		return Err(ExecutorError::new("controlled Codex authentication has an invalid size"));
	}

	let raw_sha256 = sha256(&bytes)?;
	let document = serde_json::from_slice(&bytes);

	bytes.fill(0);

	let document: Value =
		document.map_err(|_| ExecutorError::new("controlled Codex authentication is invalid"))?;
	let tokens = document
		.get("tokens")
		.and_then(Value::as_object)
		.ok_or_else(|| ExecutorError::new("controlled Codex authentication is incomplete"))?;
	let account_id = tokens
		.get("account_id")
		.and_then(Value::as_str)
		.filter(|value| valid_private_claim(value, 16, 256))
		.ok_or_else(|| ExecutorError::new("controlled Codex authentication is incomplete"))?;

	tokens
		.get("access_token")
		.and_then(Value::as_str)
		.filter(|value| (16..=MAX_AUTH_JSON_BYTES as usize).contains(&value.len()))
		.ok_or_else(|| ExecutorError::new("controlled Codex authentication is incomplete"))?;

	let id_token = tokens
		.get("id_token")
		.and_then(Value::as_str)
		.filter(|value| value.len() <= MAX_AUTH_JSON_BYTES as usize)
		.ok_or_else(|| ExecutorError::new("controlled Codex authentication is incomplete"))?;
	let claims = decode_id_token_claims(id_token)?;
	let authentication =
		claims.get("https://api.openai.com/auth").and_then(Value::as_object).ok_or_else(|| {
			ExecutorError::new("controlled Codex authentication claims are incomplete")
		})?;
	let user_id = authentication
		.get("chatgpt_user_id")
		.and_then(Value::as_str)
		.filter(|value| valid_private_claim(value, 16, 256))
		.ok_or_else(|| {
			ExecutorError::new("controlled Codex authentication claims are incomplete")
		})?;
	let claim_account_id = authentication
		.get("chatgpt_account_id")
		.and_then(Value::as_str)
		.filter(|value| valid_private_claim(value, 16, 256))
		.ok_or_else(|| {
			ExecutorError::new("controlled Codex authentication claims are incomplete")
		})?;
	let plan = authentication
		.get("chatgpt_plan_type")
		.and_then(Value::as_str)
		.filter(|value| valid_private_claim(value, 1, 64))
		.ok_or_else(|| {
			ExecutorError::new("controlled Codex authentication claims are incomplete")
		})?;

	validate_account_binding(account_id, claim_account_id)?;

	let account_claim_digest = protocol::canonical_hash(&(
		"aiq.chatgpt-reviewer-attested-account-claims.v1",
		account_id,
		user_id,
		claim_account_id,
		plan,
	))
	.map_err(|_| ExecutorError::new("cannot bind controlled ChatGPT account claims"))?;
	let credential_digest =
		protocol::canonical_hash(&("aiq.chatgpt-complete-credential-file.v1", raw_sha256))
			.map_err(|_| ExecutorError::new("cannot bind controlled ChatGPT credential"))?;

	Ok(ChatgptCredentialObservation { account_claim_digest, credential_digest })
}

fn validate_account_binding(account_id: &str, claim_account_id: &str) -> Result<(), ExecutorError> {
	if account_id != claim_account_id {
		return Err(ExecutorError::new(
			"controlled Codex authentication account bindings do not match",
		));
	}

	Ok(())
}

#[cfg(unix)]
fn read_file_at(file: &File, bytes: &mut [u8], offset: u64) -> io::Result<usize> {
	std::os::unix::fs::FileExt::read_at(file, bytes, offset)
}

#[cfg(windows)]
fn read_file_at(file: &File, bytes: &mut [u8], offset: u64) -> io::Result<usize> {
	std::os::windows::fs::FileExt::seek_read(file, bytes, offset)
}

#[cfg(not(any(unix, windows)))]
fn read_file_at(file: &File, bytes: &mut [u8], offset: u64) -> io::Result<usize> {
	let mut reader = file.try_clone()?;

	reader.seek(SeekFrom::Start(offset))?;

	reader.read(bytes)
}

fn require_protected_credential_source(auth_file: &File) -> Result<(), ExecutorError> {
	#[cfg(target_os = "linux")]
	{
		let mut status = MaybeUninit::zeroed();

		if unsafe { libc::fstatvfs(auth_file.as_raw_fd(), status.as_mut_ptr()) } != 0 {
			return Err(ExecutorError::new(
				"controlled Codex credential mount cannot be inspected",
			));
		}

		let status = unsafe { status.assume_init() };

		if status.f_flag & ST_RDONLY == 0 {
			return Err(ExecutorError::new(
				"controlled Codex credential must be on a read-only mount",
			));
		}

		Ok(())
	}
	#[cfg(target_os = "macos")]
	{
		let mut status = MaybeUninit::zeroed();

		if unsafe { libc::fstat(auth_file.as_raw_fd(), status.as_mut_ptr()) } != 0 {
			return Err(ExecutorError::new(
				"controlled Codex credential flags cannot be inspected",
			));
		}

		let status = unsafe { status.assume_init() };

		if status.st_flags & UF_IMMUTABLE == 0 {
			return Err(ExecutorError::new("controlled Codex credential must be owner immutable"));
		}

		Ok(())
	}
	#[cfg(not(any(target_os = "linux", target_os = "macos")))]
	{
		let _ = auth_file;

		Err(ExecutorError::new("controlled Codex credential protection is unsupported"))
	}
}

fn validate_auth_metadata(metadata: &Metadata) -> Result<(), ExecutorError> {
	if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_AUTH_JSON_BYTES {
		return Err(ExecutorError::new("controlled Codex authentication is not a bounded file"));
	}

	#[cfg(unix)]
	validate_unix_auth_metadata(metadata)?;

	Ok(())
}

#[cfg(unix)]
fn validate_unix_auth_metadata(metadata: &Metadata) -> Result<(), ExecutorError> {
	let effective_uid = unsafe { libc::geteuid() };

	if MetadataExt::nlink(metadata) != 1
		|| PermissionsExt::mode(&metadata.permissions()) & 0o077 != 0
		|| MetadataExt::uid(metadata) != effective_uid
	{
		return Err(ExecutorError::new("controlled Codex authentication is not private"));
	}

	Ok(())
}

#[cfg(unix)]
fn same_auth_file(left: &Metadata, right: &Metadata) -> bool {
	MetadataExt::dev(left) == MetadataExt::dev(right)
		&& MetadataExt::ino(left) == MetadataExt::ino(right)
		&& MetadataExt::nlink(left) == MetadataExt::nlink(right)
}

#[cfg(not(unix))]
fn same_auth_file(left: &Metadata, right: &Metadata) -> bool {
	left.len() == right.len()
		&& left.created().ok() == right.created().ok()
		&& left.modified().ok() == right.modified().ok()
}

fn verify_auth_identity(
	canonical_home: &Path,
	home_metadata: &Metadata,
	auth_path: &Path,
	path_metadata: &Metadata,
	auth_file: &File,
) -> Result<(), ExecutorError> {
	let current_home = fs::canonicalize(canonical_home)
		.map_err(|_| ExecutorError::new("controlled Codex authentication parent changed"))?;
	let current_home_metadata = fs::metadata(&current_home)
		.map_err(|_| ExecutorError::new("controlled Codex authentication parent changed"))?;
	let current_path_metadata = fs::symlink_metadata(auth_path)
		.map_err(|_| ExecutorError::new("controlled Codex authentication path changed"))?;
	let current_opened_metadata = auth_file
		.metadata()
		.map_err(|_| ExecutorError::new("controlled Codex authentication path changed"))?;

	validate_auth_metadata(&current_path_metadata)?;
	validate_auth_metadata(&current_opened_metadata)?;

	if current_home != canonical_home
		|| !same_auth_file(home_metadata, &current_home_metadata)
		|| !same_auth_file(path_metadata, &current_path_metadata)
		|| !same_auth_file(path_metadata, &current_opened_metadata)
	{
		return Err(ExecutorError::new("controlled Codex authentication identity changed"));
	}

	Ok(())
}

fn decode_id_token_claims(id_token: &str) -> Result<Value, ExecutorError> {
	let mut segments = id_token.split('.');
	let header = segments.next().unwrap_or_default();
	let payload = segments.next().unwrap_or_default();
	let signature = segments.next().unwrap_or_default();

	if header.is_empty()
		|| payload.is_empty()
		|| signature.is_empty()
		|| segments.next().is_some()
		|| payload.len() > MAX_ID_TOKEN_PAYLOAD_BYTES * 2
	{
		return Err(ExecutorError::new("controlled Codex identity token is invalid"));
	}

	let decoded = decode_base64url(payload)?;

	if decoded.is_empty() || decoded.len() > MAX_ID_TOKEN_PAYLOAD_BYTES {
		return Err(ExecutorError::new("controlled Codex identity token is invalid"));
	}

	serde_json::from_slice(&decoded)
		.map_err(|_| ExecutorError::new("controlled Codex identity token is invalid"))
}

fn decode_base64url(input: &str) -> Result<Vec<u8>, ExecutorError> {
	if input.len() % 4 == 1 || input.bytes().any(|byte| byte == b'=') {
		return Err(ExecutorError::new("controlled Codex identity token is invalid"));
	}

	let mut output = Vec::with_capacity(input.len().saturating_mul(3) / 4);
	let mut accumulator = 0_u32;
	let mut bits = 0_u8;

	for byte in input.bytes() {
		let value = match byte {
			b'A'..=b'Z' => byte - b'A',
			b'a'..=b'z' => byte - b'a' + 26,
			b'0'..=b'9' => byte - b'0' + 52,
			b'-' => 62,
			b'_' => 63,
			_ => return Err(ExecutorError::new("controlled Codex identity token is invalid")),
		};

		accumulator = (accumulator << 6) | u32::from(value);
		bits += 6;

		if bits >= 8 {
			bits -= 8;

			output.push(((accumulator >> bits) & 0xff) as u8);
		}
	}

	if bits > 0 && accumulator & ((1_u32 << bits) - 1) != 0 {
		return Err(ExecutorError::new("controlled Codex identity token is invalid"));
	}

	Ok(output)
}

fn valid_private_claim(value: &str, minimum: usize, maximum: usize) -> bool {
	(minimum..=maximum).contains(&value.len())
		&& value.bytes().all(|byte| byte.is_ascii_graphic() && !matches!(byte, b'\"' | b'\\'))
}

fn execute_system_process(
	request: &CommandRequest,
	observer: Option<&dyn ChildProcessObserver>,
) -> Result<ExecutionCapture, ExecutorError> {
	execute_system_process_inner(request, observer)
}

fn execute_system_process_inner(
	request: &CommandRequest,
	observer: Option<&dyn ChildProcessObserver>,
) -> Result<ExecutionCapture, ExecutorError> {
	#[cfg(test)]
	let _process_test_guard = crate::process_test_read_lock();
	let mut command = prepare_system_command(request)?;
	let mut child = spawn_system_command(&mut command)?;
	let child_pid = child.id();

	if let Some(observer) = observer {
		observer.child_spawned(child_pid);
	}

	let SystemPipes { stdout, stderr, stdin } = take_system_pipes(&mut child, child_pid, observer)?;
	let (breach_tx, breach_rx) = mpsc::channel();
	let stdout_thread = {
		let breach_tx = breach_tx.clone();
		let limit = request.max_capture_bytes;
		let max_steps = request.max_steps;
		let max_tool_calls = request.max_tool_calls;

		spawn_process_thread("aiq-system-stdout", move || {
			read_stdout_stream(stdout, limit, max_steps, max_tool_calls, breach_tx)
		})
	};
	let stdout_thread = match stdout_thread {
		Ok(thread) => thread,
		Err(error) => {
			return Err(system_thread_spawn_failure(
				&mut child,
				child_pid,
				observer,
				"stdout capture",
				error,
				Vec::new(),
			));
		},
	};
	let stderr_thread = {
		let breach_tx = breach_tx.clone();
		let limit = request.max_capture_bytes;

		spawn_process_thread("aiq-system-stderr", move || {
			read_bounded_stream(stderr, limit, breach_tx)
		})
	};
	let stderr_thread = match stderr_thread {
		Ok(thread) => thread,
		Err(error) => {
			return Err(system_thread_spawn_failure(
				&mut child,
				child_pid,
				observer,
				"stderr capture",
				error,
				vec![(stdout_thread, "stdout")],
			));
		},
	};
	let input = request.stdin.clone();
	let (stdin_tx, stdin_rx) = mpsc::channel();
	let stdin_thread = match spawn_process_thread("aiq-system-stdin", move || {
		let mut stdin = stdin;
		let result = stdin.write_all(&input).and_then(|()| stdin.flush());
		let _ = stdin_tx.send(result.map_err(|error| error.to_string()));
	}) {
		Ok(thread) => thread,
		Err(error) => {
			return Err(system_thread_spawn_failure(
				&mut child,
				child_pid,
				observer,
				"stdin writer",
				error,
				vec![(stdout_thread, "stdout"), (stderr_thread, "stderr")],
			));
		},
	};
	let wait = wait_for_system_process(
		&mut child,
		child_pid,
		&breach_rx,
		&stdin_rx,
		request.timeout,
		observer,
	)?;

	// Do not let a same-group member or an escaped process that retained the pipe
	// extend the request deadline.
	// Dropping a JoinHandle detaches the bounded writer thread.
	drop(stdin_thread);

	let pipe_deadline = Instant::now() + Duration::from_millis(500);
	let (stdout, stdout_truncated) = join_capture_thread(stdout_thread, pipe_deadline, "stdout")?;
	let (stderr, stderr_truncated) = join_capture_thread(stderr_thread, pipe_deadline, "stderr")?;

	Ok(ExecutionCapture {
		exit_code: wait.status.code(),
		stdout,
		stderr,
		timed_out: wait.timed_out,
		budget_exceeded: wait.budget_exceeded,
		stdout_truncated,
		stderr_truncated,
	})
}

fn spawn_system_command(command: &mut Command) -> Result<Child, ExecutorError> {
	command.spawn().map_err(|error| ExecutorError::new(format!("failed to spawn process: {error}")))
}

fn take_system_pipes(
	child: &mut Child,
	child_pid: u32,
	observer: Option<&dyn ChildProcessObserver>,
) -> Result<SystemPipes, ExecutorError> {
	let stdout = match child.stdout.take() {
		Some(stdout) => stdout,
		None => {
			stop_spawned_system_process(child, child_pid, observer, "missing stdout")?;

			return Err(ExecutorError::new("failed to capture stdout"));
		},
	};
	let stderr = match child.stderr.take() {
		Some(stderr) => stderr,
		None => {
			stop_spawned_system_process(child, child_pid, observer, "missing stderr")?;

			return Err(ExecutorError::new("failed to capture stderr"));
		},
	};
	let stdin = match child.stdin.take() {
		Some(stdin) => stdin,
		None => {
			stop_spawned_system_process(child, child_pid, observer, "missing stdin")?;

			return Err(ExecutorError::new("failed to open process input"));
		},
	};

	Ok(SystemPipes { stdout, stderr, stdin })
}

fn system_thread_spawn_failure(
	child: &mut Child,
	child_pid: u32,
	observer: Option<&dyn ChildProcessObserver>,
	context: &str,
	spawn_error: std::io::Error,
	readers: Vec<(CaptureThread, &'static str)>,
) -> ExecutorError {
	let mut failures = vec![format!("failed to start {context} thread: {spawn_error}")];

	if let Err(error) =
		stop_spawned_system_process(child, child_pid, observer, "thread creation failure")
	{
		failures.push(error.to_string());
	}

	let deadline = Instant::now() + Duration::from_millis(500);

	for (reader, stream_name) in readers {
		match join_capture_thread(reader, deadline, stream_name) {
			Ok((_, true)) => {
				failures.push(format!(
					"{stream_name} capture remained open after process-group termination"
				));
			},
			Ok((_, false)) => {},
			Err(error) => failures.push(error.to_string()),
		}
	}

	ExecutorError::new(failures.join("; "))
}

fn stop_spawned_system_process(
	child: &mut Child,
	child_pid: u32,
	observer: Option<&dyn ChildProcessObserver>,
	context: &str,
) -> Result<(), ExecutorError> {
	match process_group::kill_and_reap_group(child) {
		Ok(status) => {
			if let Some(observer) = observer {
				observer.child_reaped(child_pid, status.code());
			}

			Ok(())
		},
		Err(error) => {
			observe_process_group_cleanup_error(observer, child_pid, &error);

			Err(ExecutorError::new(format!(
				"failed to clean up spawned process group after {context}: {error}"
			)))
		},
	}
}

fn observe_process_group_cleanup_error(
	observer: Option<&dyn ChildProcessObserver>,
	child_pid: u32,
	error: &ProcessGroupCleanupError,
) {
	if error.release_observed_pid()
		&& let Some(observer) = observer
	{
		observer.child_reaped(child_pid, error.exit_code());
	}
}

fn prepare_system_command(request: &CommandRequest) -> Result<Command, ExecutorError> {
	if request.stdin.len() > MAX_STDIN_BYTES {
		return Err(ExecutorError::new("process input exceeds the bounded prompt limit"));
	}

	let mut command = Command::new(&request.program);

	command.args(&request.args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());

	process_group::configure(&mut command);

	if request.clear_environment {
		command.env_clear();
	}

	command.envs(&request.environment);

	Ok(command)
}

fn wait_for_system_process(
	child: &mut Child,
	child_pid: u32,
	breach_rx: &Receiver<LiveBudgetKind>,
	stdin_rx: &Receiver<Result<(), String>>,
	timeout: Duration,
	observer: Option<&dyn ChildProcessObserver>,
) -> Result<ProcessWaitOutcome, ExecutorError> {
	let started = Instant::now();
	let mut timed_out = false;
	let mut budget_exceeded = None;
	let status = loop {
		if let Ok(kind) = breach_rx.try_recv() {
			budget_exceeded = Some(kind);

			break match process_group::kill_and_reap_group(child) {
				Ok(status) => status,
				Err(error) => {
					observe_process_group_cleanup_error(observer, child_pid, &error);

					return Err(ExecutorError::new(format!(
						"failed to stop and reap process group: {error}"
					)));
				},
			};
		}
		if let Ok(Err(error)) = stdin_rx.try_recv() {
			match process_group::kill_and_reap_group(child) {
				Ok(status) => {
					if let Some(observer) = observer {
						observer.child_reaped(child_pid, status.code());
					}
				},
				Err(cleanup_error) => {
					observe_process_group_cleanup_error(observer, child_pid, &cleanup_error);

					return Err(ExecutorError::new(format!(
						"failed to clean up process group after process-input failure: {cleanup_error}"
					)));
				},
			}

			return Err(ExecutorError::new(format!("failed to write process input: {error}")));
		}

		let exited = match process_group::poll_exit_without_reaping(child) {
			Ok(exited) => exited,
			Err(error) => {
				return Err(ExecutorError::new(format!(
					"failed to poll process; cached process group was not signaled: {error}"
				)));
			},
		};

		match exited {
			ProcessGroupPoll::Exited => {
				break match process_group::cleanup_after_poll(child, exited) {
					Ok(status) => status,
					Err(error) => {
						observe_process_group_cleanup_error(observer, child_pid, &error);

						return Err(ExecutorError::new(format!(
							"failed to clean up exited process group: {error}"
						)));
					},
				};
			},
			ProcessGroupPoll::NotSignalable => {
				if let Some(observer) = observer {
					observer.child_reaped(child_pid, None);
				}

				return Err(ExecutorError::new(
					"process-group leader is no longer waitable; cached process group was not signaled",
				));
			},
			ProcessGroupPoll::Running if started.elapsed() >= timeout => {
				timed_out = true;

				break match process_group::kill_and_reap_group(child) {
					Ok(status) => status,
					Err(error) => {
						observe_process_group_cleanup_error(observer, child_pid, &error);

						return Err(ExecutorError::new(format!(
							"failed to stop and reap timed-out process group: {error}"
						)));
					},
				};
			},
			ProcessGroupPoll::Running => thread::sleep(Duration::from_millis(5)),
		}
	};

	if let Some(observer) = observer {
		observer.child_reaped(child_pid, status.code());
	}

	Ok(ProcessWaitOutcome { status, timed_out, budget_exceeded })
}

fn execute_json_rpc_process(
	request: &CommandRequest,
	expected_response_ids: &[u64],
) -> Result<ExecutionCapture, ExecutorError> {
	execute_json_rpc_process_inner(request, expected_response_ids)
}

fn execute_json_rpc_process_inner(
	request: &CommandRequest,
	expected_response_ids: &[u64],
) -> Result<ExecutionCapture, ExecutorError> {
	#[cfg(test)]
	let _process_test_guard = crate::process_test_read_lock();

	if request.stdin.len() > MAX_STDIN_BYTES || expected_response_ids.is_empty() {
		return Err(ExecutorError::new("invalid bounded JSON-RPC request"));
	}

	let started = Instant::now();
	let mut command = Command::new(&request.program);

	command.args(&request.args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());

	process_group::configure(&mut command);

	if request.clear_environment {
		command.env_clear();
	}

	command.envs(&request.environment);

	let mut child = command.spawn().map_err(|error| {
		ExecutorError::new(format!("failed to spawn JSON-RPC process: {error}"))
	})?;

	#[cfg(test)]
	LAST_JSON_RPC_CHILD_PID.with(|pid| pid.set(Some(child.id())));

	let SystemPipes { stdout, stderr, stdin } = take_json_rpc_pipes(&mut child)?;
	let JsonRpcIoThreads {
		stdout: stdout_thread,
		stdout_events: stdout_rx,
		stderr: stderr_thread,
		breach_events: breach_rx,
		stdin: stdin_thread,
		stdin_events: stdin_rx,
		stdin_close: stdin_close_tx,
	} = spawn_json_rpc_threads(&mut child, stdout, stderr, stdin, request)?;
	let JsonRpcExchangeOutcome { mut captured, failure: response_failure } =
		receive_json_rpc_responses(
			request,
			expected_response_ids,
			started,
			&stdout_rx,
			&breach_rx,
			&stdin_rx,
		);
	let _ = stdin_close_tx.send(());
	let stop_failure = stop_json_rpc_child(&mut child).err().map(|error| error.to_string());

	// Do not let a child that retained stdin extend the request deadline.
	drop(stdin_thread);

	let pipe_deadline = Instant::now() + Duration::from_millis(500);
	let (stdout_truncated, stdout_failure) = match finish_json_rpc_stdout(
		stdout_thread,
		&stdout_rx,
		&mut captured,
		request.max_capture_bytes,
		pipe_deadline,
	) {
		Ok(outcome) => outcome,
		Err(error) => (false, Some(error.to_string())),
	};
	let (stderr, stderr_truncated, stderr_failure) =
		match join_capture_thread(stderr_thread, pipe_deadline, "JSON-RPC stderr") {
			Ok((stderr, truncated)) => (stderr, truncated, None),
			Err(error) => (Vec::new(), false, Some(error.to_string())),
		};
	let mut failures = Vec::new();

	failures.extend(response_failure);
	failures.extend(stdout_failure);
	failures.extend(
		stdout_truncated
			.then(|| "JSON-RPC stdout remained open after process-group termination".to_owned()),
	);
	failures.extend(stderr_failure);
	failures.extend(stderr_truncated.then(|| {
		"JSON-RPC stderr was truncated or remained open after process-group termination".to_owned()
	}));
	failures.extend(stop_failure);

	if !failures.is_empty() {
		let message = failures.join("; ");
		let stderr = String::from_utf8_lossy(&stderr);

		return Err(ExecutorError::new(if stderr.is_empty() {
			message
		} else {
			format!("{message}: {stderr}")
		}));
	}

	Ok(ExecutionCapture {
		exit_code: Some(0),
		stdout: captured,
		stderr,
		timed_out: false,
		budget_exceeded: None,
		stdout_truncated,
		stderr_truncated,
	})
}

fn take_json_rpc_pipes(child: &mut Child) -> Result<SystemPipes, ExecutorError> {
	let stdout = match child.stdout.take() {
		Some(stdout) => stdout,
		None => {
			stop_spawned_json_rpc_process(child, "missing stdout")?;

			return Err(ExecutorError::new("failed to capture JSON-RPC stdout"));
		},
	};
	let stderr = match child.stderr.take() {
		Some(stderr) => stderr,
		None => {
			stop_spawned_json_rpc_process(child, "missing stderr")?;

			return Err(ExecutorError::new("failed to capture JSON-RPC stderr"));
		},
	};
	let stdin = match child.stdin.take() {
		Some(stdin) => stdin,
		None => {
			stop_spawned_json_rpc_process(child, "missing stdin")?;

			return Err(ExecutorError::new("failed to open JSON-RPC stdin"));
		},
	};

	Ok(SystemPipes { stdout, stderr, stdin })
}

fn spawn_json_rpc_threads(
	child: &mut Child,
	stdout: ChildStdout,
	stderr: ChildStderr,
	stdin: ChildStdin,
	request: &CommandRequest,
) -> Result<JsonRpcIoThreads, ExecutorError> {
	let (stdout_tx, stdout_rx) = mpsc::sync_channel(1);
	let stdout_limit = request.max_capture_bytes;
	let stdout_thread = match spawn_process_thread("aiq-json-rpc-stdout", move || {
		forward_bounded_json_rpc_stdout(stdout, stdout_limit, stdout_tx);
	}) {
		Ok(thread) => thread,
		Err(error) => {
			return Err(json_rpc_thread_spawn_failure(
				child,
				"stdout capture",
				error,
				None,
				&stdout_rx,
				None,
			));
		},
	};
	let (breach_tx, breach_rx) = mpsc::channel();
	let max_capture_bytes = request.max_capture_bytes;
	let stderr_thread = match spawn_process_thread("aiq-json-rpc-stderr", move || {
		read_bounded_stream(stderr, max_capture_bytes, breach_tx)
	}) {
		Ok(thread) => thread,
		Err(error) => {
			return Err(json_rpc_thread_spawn_failure(
				child,
				"stderr capture",
				error,
				Some(stdout_thread),
				&stdout_rx,
				None,
			));
		},
	};
	let input = request.stdin.clone();
	let (stdin_tx, stdin_rx) = mpsc::channel();
	let (stdin_close_tx, stdin_close_rx) = mpsc::channel();
	let stdin_thread = match spawn_process_thread("aiq-json-rpc-stdin", move || {
		let mut stdin = stdin;
		let result = stdin.write_all(&input).and_then(|()| stdin.flush());
		let write_succeeded = result.is_ok();
		let _ = stdin_tx.send(result.map_err(|error| error.to_string()));

		if write_succeeded {
			let _ = stdin_close_rx.recv();
		}
	}) {
		Ok(thread) => thread,
		Err(error) => {
			return Err(json_rpc_thread_spawn_failure(
				child,
				"stdin writer",
				error,
				Some(stdout_thread),
				&stdout_rx,
				Some(stderr_thread),
			));
		},
	};

	Ok(JsonRpcIoThreads {
		stdout: stdout_thread,
		stdout_events: stdout_rx,
		stderr: stderr_thread,
		breach_events: breach_rx,
		stdin: stdin_thread,
		stdin_events: stdin_rx,
		stdin_close: stdin_close_tx,
	})
}

fn json_rpc_thread_spawn_failure(
	child: &mut Child,
	context: &str,
	spawn_error: std::io::Error,
	stdout_thread: Option<JoinHandle<()>>,
	stdout_rx: &Receiver<JsonRpcStdoutEvent>,
	stderr_thread: Option<CaptureThread>,
) -> ExecutorError {
	let mut failures = vec![format!("failed to start JSON-RPC {context} thread: {spawn_error}")];

	if let Err(error) = stop_spawned_json_rpc_process(child, "thread creation failure") {
		failures.push(error.to_string());
	}

	let deadline = Instant::now() + Duration::from_millis(500);

	if let Some(stdout_thread) = stdout_thread {
		let mut captured = Vec::new();

		match finish_json_rpc_stdout(
			stdout_thread,
			stdout_rx,
			&mut captured,
			MAX_CAPTURE_BYTES,
			deadline,
		) {
			Ok((true, failure)) => {
				failures.push(
					"JSON-RPC stdout remained open after process-group termination".to_owned(),
				);
				failures.extend(failure);
			},
			Ok((false, failure)) => failures.extend(failure),
			Err(error) => failures.push(error.to_string()),
		}
	}
	if let Some(stderr_thread) = stderr_thread {
		match join_capture_thread(stderr_thread, deadline, "JSON-RPC stderr") {
			Ok((_, true)) => failures
				.push("JSON-RPC stderr remained open after process-group termination".to_owned()),
			Ok((_, false)) => {},
			Err(error) => failures.push(error.to_string()),
		}
	}

	ExecutorError::new(failures.join("; "))
}

fn stop_spawned_json_rpc_process(child: &mut Child, context: &str) -> Result<(), ExecutorError> {
	process_group::kill_and_reap_group(child).map(|_| ()).map_err(|error| {
		ExecutorError::new(format!(
			"failed to clean up spawned JSON-RPC process group after {context}: {error}"
		))
	})
}

fn stop_json_rpc_child(child: &mut Child) -> Result<(), ExecutorError> {
	let result = match process_group::poll_exit_without_reaping(child) {
		Ok(poll @ ProcessGroupPoll::Exited) => {
			process_group::cleanup_after_poll(child, poll).map(|_| ()).map_err(|error| {
				ExecutorError::new(format!("failed to clean up JSON-RPC process group: {error}"))
			})
		},
		Ok(ProcessGroupPoll::Running) => {
			process_group::kill_and_reap_group(child).map(|_| ()).map_err(|error| {
				ExecutorError::new(format!(
					"failed to stop and reap JSON-RPC process group: {error}"
				))
			})
		},
		Ok(ProcessGroupPoll::NotSignalable) => Err(ExecutorError::new(
			"JSON-RPC process-group leader is no longer waitable; cached process group was not signaled",
		)),
		Err(error) => Err(ExecutorError::new(format!(
			"failed to poll JSON-RPC process; cached process group was not signaled: {error}"
		))),
	};

	#[cfg(all(test, target_os = "linux"))]
	if FORCE_JSON_RPC_STOP_FAILURE.with(Cell::take) {
		let forced = "forced JSON-RPC cleanup failure";

		return match result {
			Ok(()) => Err(ExecutorError::new(forced)),
			Err(error) => Err(ExecutorError::new(format!("{error}; {forced}"))),
		};
	}

	result
}

fn receive_json_rpc_responses(
	request: &CommandRequest,
	expected_response_ids: &[u64],
	started: Instant,
	stdout_rx: &Receiver<JsonRpcStdoutEvent>,
	breach_rx: &Receiver<LiveBudgetKind>,
	stdin_rx: &Receiver<Result<(), String>>,
) -> JsonRpcExchangeOutcome {
	let expected = expected_response_ids.iter().copied().collect::<BTreeSet<_>>();
	let mut observed = BTreeSet::new();
	let mut captured = Vec::new();
	let mut parsed_through = 0;
	let mut failure = None;

	while observed != expected {
		if breach_rx.try_recv().is_ok() {
			failure = Some("JSON-RPC stderr exceeded the safe capture limit".to_owned());

			break;
		}

		if let Ok(Err(error)) = stdin_rx.try_recv() {
			failure = Some(format!("failed to write JSON-RPC input: {error}"));

			break;
		}

		let elapsed = started.elapsed();

		if elapsed >= request.timeout {
			failure = Some("JSON-RPC process exceeded its response deadline".to_owned());

			break;
		}

		let poll_interval = (request.timeout - elapsed).min(Duration::from_millis(10));

		match stdout_rx.recv_timeout(poll_interval) {
			Ok(JsonRpcStdoutEvent::Chunk(chunk)) => {
				if captured.len().saturating_add(chunk.len()) > request.max_capture_bytes {
					failure = Some("JSON-RPC stdout exceeded the safe capture limit".to_owned());

					break;
				}

				captured.extend_from_slice(&chunk);

				observe_json_rpc_responses(
					&captured,
					&mut parsed_through,
					&expected,
					&mut observed,
				);
			},
			Ok(JsonRpcStdoutEvent::CaptureLimitExceeded) => {
				failure = Some("JSON-RPC stdout exceeded the safe capture limit".to_owned());

				break;
			},
			Ok(JsonRpcStdoutEvent::ReadFailed(error)) => {
				failure = Some(format!("failed to read JSON-RPC stdout: {error}"));

				break;
			},
			Ok(JsonRpcStdoutEvent::End) | Err(RecvTimeoutError::Disconnected) => {
				failure = Some("JSON-RPC process closed stdout before all responses".to_owned());

				break;
			},
			Err(RecvTimeoutError::Timeout) => {},
		}
	}

	JsonRpcExchangeOutcome { captured, failure }
}

fn forward_bounded_json_rpc_stdout(
	mut stdout: impl Read,
	limit: usize,
	event_tx: SyncSender<JsonRpcStdoutEvent>,
) {
	let mut observed = 0_usize;
	let mut buffer = [0_u8; 8_192];

	loop {
		match stdout.read(&mut buffer) {
			Ok(0) => {
				let _ = event_tx.send(JsonRpcStdoutEvent::End);

				break;
			},
			Ok(read) => {
				if observed.saturating_add(read) > limit {
					let _ = event_tx.send(JsonRpcStdoutEvent::CaptureLimitExceeded);

					break;
				}

				observed += read;

				if event_tx.send(JsonRpcStdoutEvent::Chunk(buffer[..read].to_vec())).is_err() {
					break;
				}
			},
			Err(error) => {
				let _ = event_tx.send(JsonRpcStdoutEvent::ReadFailed(error.to_string()));

				break;
			},
		}
	}
}

fn observe_json_rpc_responses(
	captured: &[u8],
	parsed_through: &mut usize,
	expected: &BTreeSet<u64>,
	observed: &mut BTreeSet<u64>,
) {
	while let Some(relative_end) =
		captured[*parsed_through..].iter().position(|byte| *byte == b'\n')
	{
		let line_end = parsed_through.saturating_add(relative_end);

		if let Ok(value) = serde_json::from_slice::<Value>(&captured[*parsed_through..line_end])
			&& let Some(id) = value.get("id").and_then(Value::as_u64)
			&& expected.contains(&id)
		{
			observed.insert(id);
		}

		*parsed_through = line_end.saturating_add(1);
	}
}

fn finish_json_rpc_stdout(
	thread: JoinHandle<()>,
	event_rx: &Receiver<JsonRpcStdoutEvent>,
	captured: &mut Vec<u8>,
	limit: usize,
	deadline: Instant,
) -> Result<(bool, Option<String>), ExecutorError> {
	let mut failure = None;

	while !thread.is_finished() && Instant::now() < deadline {
		match event_rx.recv_timeout(Duration::from_millis(1)) {
			Ok(event) => record_json_rpc_stdout_event(event, captured, limit, &mut failure),
			Err(RecvTimeoutError::Disconnected | RecvTimeoutError::Timeout) => {},
		}
	}

	if !thread.is_finished() {
		// An escaped descendant can retain the pipe after the direct process
		// group is stopped. Detach the bounded reader instead of extending the
		// request deadline.
		return Ok((true, failure));
	}

	thread.join().map_err(|_| ExecutorError::new("JSON-RPC stdout capture thread panicked"))?;

	while let Ok(event) = event_rx.try_recv() {
		record_json_rpc_stdout_event(event, captured, limit, &mut failure);
	}

	Ok((false, failure))
}

fn record_json_rpc_stdout_event(
	event: JsonRpcStdoutEvent,
	captured: &mut Vec<u8>,
	limit: usize,
	failure: &mut Option<String>,
) {
	match event {
		JsonRpcStdoutEvent::Chunk(chunk) => {
			if captured.len().saturating_add(chunk.len()) > limit {
				*failure = Some("JSON-RPC stdout exceeded the safe capture limit".to_owned());
			} else {
				captured.extend_from_slice(&chunk);
			}
		},
		JsonRpcStdoutEvent::CaptureLimitExceeded => {
			*failure = Some("JSON-RPC stdout exceeded the safe capture limit".to_owned());
		},
		JsonRpcStdoutEvent::ReadFailed(error) => {
			*failure = Some(format!("failed to read JSON-RPC stdout: {error}"));
		},
		JsonRpcStdoutEvent::End => {},
	}
}

fn managed_profile_exchange(
	workspace: &Path,
	denied_roots: &[PathBuf],
) -> Result<(Vec<String>, Vec<u8>), AdapterFailure> {
	let workspace = utf8_path(workspace, "managed-profile workspace")?;
	let mut args = vec![
		"app-server".to_owned(),
		"--strict-config".to_owned(),
		"--config".to_owned(),
		"mcp_servers={}".to_owned(),
		"--config".to_owned(),
		"approval_policy=\"never\"".to_owned(),
		"--config".to_owned(),
		format!("default_permissions=\"{BENCHMARK_PERMISSION_PROFILE}\""),
		"--config".to_owned(),
		permission_filesystem_config(SandboxPolicy::WorkspaceWrite, workspace, denied_roots, &[])?,
		"--config".to_owned(),
		format!("permissions.{BENCHMARK_PERMISSION_PROFILE}.network.enabled=false"),
	];

	for feature in DISABLED_CODEX_FEATURES {
		args.extend(["--disable".to_owned(), (*feature).to_owned()]);
	}

	let requests = [
		serde_json::json!({
			"method": "initialize",
			"id": 0,
			"params": {
				"clientInfo": {
					"name": "aiq_runner",
					"title": "AIQ Runner",
					"version": env!("CARGO_PKG_VERSION")
				},
				"capabilities": {
					"experimentalApi": true,
					"optOutNotificationMethods": ["mcpServer/startupStatus/updated"]
				}
			}
		}),
		serde_json::json!({"method": "initialized"}),
		serde_json::json!({"method": "configRequirements/read", "id": 1, "params": null}),
		serde_json::json!({
			"method": "permissionProfile/list",
			"id": 2,
			"params": {"cwd": workspace}
		}),
		serde_json::json!({
			"method": "thread/start",
			"id": 3,
			"params": {
				"cwd": workspace,
				"ephemeral": true,
				"permissions": BENCHMARK_PERMISSION_PROFILE,
				"approvalPolicy": "never"
			}
		}),
	];
	let mut stdin = Vec::new();

	for request in requests {
		serde_json::to_writer(&mut stdin, &request).map_err(|error| {
			adapter_failure(
				AdapterFailureKind::Spawn,
				format!("cannot encode managed-profile request: {error}"),
			)
		})?;

		stdin.push(b'\n');
	}

	Ok((args, stdin))
}

fn managed_profile_evidence(
	stdout: &[u8],
	version: String,
) -> Result<ManagedPermissionProfileEvidence, AdapterFailure> {
	let requirements: ConfigRequirementsReadResult =
		json_rpc_result(stdout, 1, "configRequirements/read")?;
	let profiles: PermissionProfileListResult =
		json_rpc_result(stdout, 2, "permissionProfile/list")?;
	let thread: ThreadStartProfileResult = json_rpc_result(stdout, 3, "thread/start")?;
	let selectable = profiles
		.data
		.iter()
		.filter(|profile| profile.allowed)
		.map(|profile| profile.id.as_str())
		.collect::<Vec<_>>();

	if !selectable.contains(&BENCHMARK_PERMISSION_PROFILE) {
		return Err(adapter_failure(
			AdapterFailureKind::Spawn,
			"effective permissionProfile/list does not allow aiq_benchmark",
		));
	}
	if thread.active_permission_profile.as_ref().map(|profile| profile.id.as_str())
		!= Some(BENCHMARK_PERMISSION_PROFILE)
	{
		return Err(adapter_failure(
			AdapterFailureKind::Spawn,
			"model-free thread/start did not activate aiq_benchmark",
		));
	}

	build_managed_profile_evidence(version, requirements)
}

fn build_managed_profile_evidence(
	version: String,
	requirements: ConfigRequirementsReadResult,
) -> Result<ManagedPermissionProfileEvidence, AdapterFailure> {
	let managed_requirements_digest = protocol::canonical_hash(&(
		"aiq.managed-permission-requirements.v1",
		&version,
		&requirements,
	))
	.map_err(|error| {
		adapter_failure(
			AdapterFailureKind::Spawn,
			format!("cannot digest managed requirements: {error}"),
		)
	})?;
	let profile_selection_digest = protocol::canonical_hash(&(
		"aiq.permission-profile-selection.v1",
		&version,
		BENCHMARK_PERMISSION_PROFILE,
	))
	.map_err(|error| {
		adapter_failure(
			AdapterFailureKind::Spawn,
			format!("cannot digest active permission profile: {error}"),
		)
	})?;
	let (official_eligible, managed_requirements_status) =
		classify_managed_requirements(requirements.requirements.as_ref());
	let schema_version = "aiq.managed-permission-profile-evidence.v1";
	let body = ManagedPermissionProfileEvidenceBody {
		schema_version,
		codex_version: &version,
		default_permissions: BENCHMARK_PERMISSION_PROFILE,
		allowed_permission_profile: BENCHMARK_PERMISSION_PROFILE,
		active_permission_profile: BENCHMARK_PERMISSION_PROFILE,
		official_eligible,
		managed_requirements_status,
		managed_requirements_digest: &managed_requirements_digest,
		profile_selection_digest: &profile_selection_digest,
	};
	let evidence_digest = protocol::canonical_hash(&body).map_err(|error| {
		adapter_failure(
			AdapterFailureKind::Spawn,
			format!("cannot digest managed-profile evidence: {error}"),
		)
	})?;

	Ok(ManagedPermissionProfileEvidence {
		schema_version: schema_version.to_owned(),
		codex_version: version,
		default_permissions: BENCHMARK_PERMISSION_PROFILE.to_owned(),
		allowed_permission_profile: BENCHMARK_PERMISSION_PROFILE.to_owned(),
		active_permission_profile: BENCHMARK_PERMISSION_PROFILE.to_owned(),
		official_eligible,
		managed_requirements_status: managed_requirements_status.to_owned(),
		managed_requirements_digest,
		profile_selection_digest,
		evidence_digest,
	})
}

fn classify_managed_requirements(requirements: Option<&Value>) -> (bool, &'static str) {
	match requirements {
		None => (true, "absent_expected"),
		Some(_) => (false, "present_unexpected"),
	}
}

fn require_permission_canaries_absent(
	writable_file: &Path,
	read_only_write_file: &Path,
) -> Result<(), AdapterFailure> {
	require_permission_canary_absent(read_only_write_file, "toolchain read-only canary target")?;

	require_permission_canary_absent(writable_file, "workspace writable canary target")
}

fn require_permission_canary_absent(path: &Path, label: &str) -> Result<(), AdapterFailure> {
	match fs::symlink_metadata(path) {
		Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
		Err(error) => Err(adapter_failure(
			AdapterFailureKind::Spawn,
			format!("cannot confirm that {label} is absent: {error}"),
		)),
		Ok(_) => Err(adapter_failure(AdapterFailureKind::Spawn, format!("{label} already exists"))),
	}
}

fn cleanup_permission_probe_canaries(
	writable_file: &Path,
	read_only_write_file: &Path,
) -> Result<PermissionCanaryObservation, AdapterFailure> {
	let writable = cleanup_permission_probe_canary(writable_file, "workspace writable canary");
	let read_only =
		cleanup_permission_probe_canary(read_only_write_file, "toolchain read-only canary");

	match (writable, read_only) {
		(Ok(writable_created), Ok(read_only_created)) => {
			Ok(PermissionCanaryObservation { writable_created, read_only_created })
		},
		(Err(writable), Ok(_)) => Err(writable),
		(Ok(_), Err(read_only)) => Err(read_only),
		(Err(writable), Err(read_only)) => Err(adapter_failure(
			AdapterFailureKind::Spawn,
			format!(
				"permission canary cleanup failed for both targets: {}; {}",
				writable.message, read_only.message
			),
		)),
	}
}

fn cleanup_permission_probe_canary(path: &Path, label: &str) -> Result<bool, AdapterFailure> {
	let metadata = match fs::symlink_metadata(path) {
		Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
		Err(error) => {
			return Err(adapter_failure(
				AdapterFailureKind::Spawn,
				format!("cannot inspect {label} after the permission probe: {error}"),
			));
		},
		Ok(metadata) => metadata,
	};

	if metadata.file_type().is_symlink() || !metadata.is_file() {
		return Err(adapter_failure(
			AdapterFailureKind::Spawn,
			format!("{label} appeared with an unsafe file type; refusing cleanup"),
		));
	}

	fs::remove_file(path).map_err(|error| {
		adapter_failure(
			AdapterFailureKind::Spawn,
			format!("cannot remove {label} after the permission probe: {error}"),
		)
	})?;

	match fs::symlink_metadata(path) {
		Err(error) if error.kind() == ErrorKind::NotFound => Ok(true),
		Err(error) => Err(adapter_failure(
			AdapterFailureKind::Spawn,
			format!("cannot verify {label} cleanup: {error}"),
		)),
		Ok(_) => Err(adapter_failure(
			AdapterFailureKind::Spawn,
			format!("{label} still exists after cleanup"),
		)),
	}
}

fn preserve_permission_canary_evidence<T>(
	result: Result<T, AdapterFailure>,
	observation: PermissionCanaryObservation,
) -> Result<T, AdapterFailure> {
	if !observation.occurred() {
		return result;
	}

	match result {
		Ok(_) => Err(adapter_failure(AdapterFailureKind::NonZeroExit, observation.evidence())),
		Err(mut failure) => {
			failure.message = format!("{}; {}", failure.message, observation.evidence());

			Err(failure)
		},
	}
}

fn canonicalize_permission_probe_paths(
	workspace: &Path,
	allowed_file: &Path,
	denied_files: &[PathBuf],
	writable_file: &Path,
) -> Result<PermissionProbePaths, AdapterFailure> {
	let workspace = fs::canonicalize(workspace).map_err(|error| {
		adapter_failure(
			AdapterFailureKind::Spawn,
			format!("cannot resolve isolation-probe workspace: {error}"),
		)
	})?;
	let allowed_file = fs::canonicalize(allowed_file).map_err(|error| {
		adapter_failure(
			AdapterFailureKind::Spawn,
			format!("cannot resolve isolation-probe allowed file: {error}"),
		)
	})?;
	let denied_files = canonicalize_denied_files(denied_files)?;
	let writable_parent = writable_file.parent().ok_or_else(|| {
		adapter_failure(AdapterFailureKind::Spawn, "isolation-probe writable file has no parent")
	})?;
	let writable_parent = fs::canonicalize(writable_parent).map_err(|error| {
		adapter_failure(
			AdapterFailureKind::Spawn,
			format!("cannot resolve isolation-probe writable parent: {error}"),
		)
	})?;
	let writable_name = writable_file.file_name().ok_or_else(|| {
		adapter_failure(AdapterFailureKind::Spawn, "isolation-probe writable file has no name")
	})?;

	Ok(PermissionProbePaths {
		workspace,
		allowed_file,
		denied_files,
		writable_file: writable_parent.join(writable_name),
	})
}

fn validate_permission_probe_files(
	allowed_file: &Path,
	denied_files: &[PathBuf],
) -> Result<(), AdapterFailure> {
	for (field, path) in iter::once(("allowed", allowed_file))
		.chain(denied_files.iter().map(|path| ("denied", path.as_path())))
	{
		let metadata = fs::symlink_metadata(path).map_err(|error| {
			adapter_failure(
				AdapterFailureKind::Spawn,
				format!("cannot inspect isolation-probe {field} file: {error}"),
			)
		})?;

		if metadata.file_type().is_symlink() || !metadata.is_file() {
			return Err(adapter_failure(
				AdapterFailureKind::Spawn,
				format!("isolation-probe {field} path must be a regular file"),
			));
		}
	}

	Ok(())
}

fn canonicalize_denied_files(denied_files: &[PathBuf]) -> Result<Vec<PathBuf>, AdapterFailure> {
	denied_files
		.iter()
		.map(|path| {
			fs::canonicalize(path).map_err(|error| {
				adapter_failure(
					AdapterFailureKind::Spawn,
					format!("cannot resolve isolation-probe denied file: {error}"),
				)
			})
		})
		.collect()
}

fn join_capture_thread(
	thread: CaptureThread,
	deadline: Instant,
	stream_name: &str,
) -> Result<(Vec<u8>, bool), ExecutorError> {
	while !thread.is_finished() && Instant::now() < deadline {
		thread::sleep(Duration::from_millis(1));
	}

	if !thread.is_finished() {
		// A non-Unix descendant can retain an inherited pipe after the direct child
		// is stopped. Detach the reader and report an incomplete capture.
		return Ok((Vec::new(), true));
	}

	thread
		.join()
		.map_err(|_| ExecutorError::new(format!("{stream_name} capture thread panicked")))?
		.map_err(|error| ExecutorError::new(format!("failed to read {stream_name}: {error}")))
}

fn read_bounded_stream(
	mut stream: impl Read,
	limit: usize,
	breach_tx: Sender<LiveBudgetKind>,
) -> std::io::Result<(Vec<u8>, bool)> {
	let mut bytes = Vec::new();
	let mut buffer = [0_u8; 8_192];
	let mut truncated = false;

	loop {
		let read = stream.read(&mut buffer)?;

		if read == 0 {
			break;
		}

		let retained = read.min(limit.saturating_sub(bytes.len()));

		bytes.extend_from_slice(&buffer[..retained]);

		if retained < read && !truncated {
			truncated = true;

			let _ = breach_tx.send(LiveBudgetKind::Output);
		}
	}

	Ok((bytes, truncated))
}

fn read_stdout_stream(
	mut stream: impl Read,
	limit: usize,
	max_steps: u32,
	max_tool_calls: u32,
	breach_tx: Sender<LiveBudgetKind>,
) -> std::io::Result<(Vec<u8>, bool)> {
	let mut bytes = Vec::new();
	let mut pending = Vec::new();
	let mut buffer = [0_u8; 8_192];
	let mut truncated = false;
	let mut accounting = LiveItemAccounting::default();
	let mut step_breach_sent = false;
	let mut tool_breach_sent = false;

	loop {
		let read = stream.read(&mut buffer)?;

		if read == 0 {
			break;
		}

		let retained = read.min(limit.saturating_sub(bytes.len()));

		bytes.extend_from_slice(&buffer[..retained]);

		if retained < read && !truncated {
			truncated = true;

			let _ = breach_tx.send(LiveBudgetKind::Output);
		}

		pending.extend_from_slice(&buffer[..retained]);

		while let Some(index) = pending.iter().position(|byte| *byte == b'\n') {
			let line: Vec<_> = pending.drain(..=index).collect();

			accounting.observe(&line);

			if accounting.steps > max_steps && !step_breach_sent {
				step_breach_sent = true;

				let _ = breach_tx.send(LiveBudgetKind::Steps);
			}
			if accounting.tool_calls > max_tool_calls && !tool_breach_sent {
				tool_breach_sent = true;

				let _ = breach_tx.send(LiveBudgetKind::ToolCalls);
			}
		}
	}

	Ok((bytes, truncated))
}

#[cfg(not(unix))]
fn verify_existing_artifact(
	path: &Path,
	bytes: &[u8],
	content_hash: &str,
) -> Result<(), ExecutorError> {
	let metadata = fs::symlink_metadata(path)
		.map_err(|error| ExecutorError::new(format!("cannot inspect artifact: {error}")))?;

	if metadata.file_type().is_symlink() || !metadata.is_file() {
		return Err(ExecutorError::new("artifact object is not a regular file"));
	}
	if metadata.len() != u64::try_from(bytes.len()).unwrap_or(u64::MAX) {
		return Err(ExecutorError::new("existing artifact size does not match its address"));
	}

	let mut file = File::open(path)
		.map_err(|error| ExecutorError::new(format!("cannot read existing artifact: {error}")))?;

	verify_existing_artifact_file(&mut file, bytes, content_hash)
}

fn verify_existing_artifact_file(
	file: &mut File,
	bytes: &[u8],
	content_hash: &str,
) -> Result<(), ExecutorError> {
	let metadata =
		file.metadata().map_err(|_| ExecutorError::new("cannot inspect existing artifact"))?;

	if !metadata.is_file() || metadata.len() != u64::try_from(bytes.len()).unwrap_or(u64::MAX) {
		return Err(ExecutorError::new("existing artifact size does not match its address"));
	}

	#[cfg(unix)]
	require_single_artifact_link(&metadata)?;

	let mut existing = Vec::with_capacity(bytes.len());

	Read::by_ref(file)
		.take(u64::try_from(bytes.len()).unwrap_or(u64::MAX) + 1)
		.read_to_end(&mut existing)
		.map_err(|_| ExecutorError::new("cannot read existing artifact"))?;

	if sha256(&existing)? != content_hash || existing != bytes {
		return Err(ExecutorError::new("existing artifact content does not match its address"));
	}

	Ok(())
}

#[cfg(unix)]
fn require_single_artifact_link(metadata: &Metadata) -> Result<(), ExecutorError> {
	if MetadataExt::nlink(metadata) != 1 {
		return Err(ExecutorError::new("existing artifact has an unsafe link count"));
	}

	Ok(())
}

fn sha256(bytes: &[u8]) -> Result<String, ExecutorError> {
	Ok(format!("sha256:{}", hex::encode(Sha256::digest(bytes))))
}

fn extract_probe_response(stdout: &str) -> Option<String> {
	let mut response = None;

	for line in stdout.lines() {
		let Ok(value) = serde_json::from_str::<Value>(line) else {
			continue;
		};
		let item = value.get("item").unwrap_or(&value);

		if matches!(item.get("type").and_then(Value::as_str), Some("agent_message" | "message"))
			&& let Some(text) = item.get("text").and_then(Value::as_str)
		{
			response = Some(text.trim().to_owned());
		}
	}

	response.or_else(|| {
		let trimmed = stdout.trim();

		(!trimmed.is_empty() && serde_json::from_str::<Value>(stdout).is_err())
			.then(|| trimmed.to_owned())
	})
}

fn invocation_args(
	model: ModelConfig,
	sandbox: SandboxPolicy,
	workspace: &Path,
	denied_roots: &[PathBuf],
	model_toolchain: Option<&ValidatedModelToolchain>,
) -> Result<Vec<String>, AdapterFailure> {
	let workspace = utf8_path(workspace, "benchmark workspace")?;
	let toolchain = model_toolchain.ok_or_else(|| {
		adapter_failure(
			AdapterFailureKind::Spawn,
			"model execution requires a committed Codex toolchain",
		)
	})?;
	let toolchain_paths = vec![toolchain.root().to_owned()];
	let mut args = vec![
		"exec".to_owned(),
		"--ignore-user-config".to_owned(),
		"--ignore-rules".to_owned(),
		"--strict-config".to_owned(),
		"--model".to_owned(),
		model.family.codex_name().to_owned(),
		"--config".to_owned(),
		format!("model_reasoning_effort={}", model.reasoning_effort),
		"--config".to_owned(),
		format!(
			"web_search=\"{}\"",
			if sandbox.permits_web_search() { "live" } else { "disabled" }
		),
		"--config".to_owned(),
		"mcp_servers={}".to_owned(),
		"--config".to_owned(),
		"shell_environment_policy.inherit=\"none\"".to_owned(),
		"--config".to_owned(),
		"shell_environment_policy.experimental_use_profile=false".to_owned(),
		"--config".to_owned(),
		format!("shell_environment_policy.set.PATH={}", toml_basic_string(&toolchain.path_value())),
		"--config".to_owned(),
		"approval_policy=\"never\"".to_owned(),
		"--config".to_owned(),
		format!("default_permissions=\"{BENCHMARK_PERMISSION_PROFILE}\""),
		"--config".to_owned(),
		permission_filesystem_config(sandbox, workspace, denied_roots, &toolchain_paths)?,
		"--config".to_owned(),
		format!("permissions.{BENCHMARK_PERMISSION_PROFILE}.network.enabled=false"),
		"--cd".to_owned(),
		workspace.to_owned(),
		"--ephemeral".to_owned(),
		"--skip-git-repo-check".to_owned(),
		"--json".to_owned(),
		"-".to_owned(),
	];

	#[cfg(windows)]
	args.extend([
		"--config".to_owned(),
		"shell_environment_policy.set.PATHEXT=\".COM;.EXE;.BAT;.CMD\"".to_owned(),
	]);

	for feature in DISABLED_CODEX_FEATURES {
		args.extend(["--disable".to_owned(), (*feature).to_owned()]);
	}

	if !sandbox.permits_shell() {
		args.extend(["--disable".to_owned(), "shell_tool".to_owned()]);
		args.extend(["--disable".to_owned(), "unified_exec".to_owned()]);
	}

	Ok(args)
}

fn permission_filesystem_config(
	sandbox: SandboxPolicy,
	workspace: &str,
	denied_roots: &[PathBuf],
	additional_read_paths: &[PathBuf],
) -> Result<String, AdapterFailure> {
	let mut rules = vec![format!("{}=\"read\"", toml_basic_string(":minimal"))];

	for root in denied_roots {
		rules.push(format!(
			"{}=\"deny\"",
			toml_basic_string(utf8_path(root, "benchmark denied root")?)
		));
	}
	for path in additional_read_paths {
		rules.push(format!(
			"{}=\"read\"",
			toml_basic_string(utf8_path(path, "benchmark additional read path")?)
		));
	}

	if let Some(access) = sandbox.workspace_access() {
		rules.push(format!("{}={}", toml_basic_string(workspace), toml_basic_string(access)));
	}

	Ok(format!("permissions.{BENCHMARK_PERMISSION_PROFILE}.filesystem={{{}}}", rules.join(",")))
}

#[allow(clippy::too_many_arguments)]
fn permission_probe_args(
	workspace: &Path,
	allowed_file: &Path,
	denied_files: &[PathBuf],
	writable_file: &Path,
	network_sentinel_port: u16,
	probe_executable: &Path,
	denied_roots: &[PathBuf],
	additional_read_paths: &[PathBuf],
	read_only_file: &Path,
	read_only_write_file: &Path,
) -> Result<Vec<String>, AdapterFailure> {
	let workspace = utf8_path(workspace, "isolation-probe workspace")?;
	let allowed_file = utf8_path(allowed_file, "isolation-probe allowed file")?;
	let writable_file = utf8_path(writable_file, "isolation-probe writable file")?;
	let probe_executable_path = utf8_path(probe_executable, "isolation-probe executable")?;
	let read_only_file = utf8_path(read_only_file, "isolation-probe read-only file")?;
	let read_only_write_file =
		utf8_path(read_only_write_file, "isolation-probe read-only write file")?;
	let mut args = vec![
		"sandbox".to_owned(),
		"--permission-profile".to_owned(),
		BENCHMARK_PERMISSION_PROFILE.to_owned(),
		"--include-managed-config".to_owned(),
		"--config".to_owned(),
		format!("default_permissions=\"{BENCHMARK_PERMISSION_PROFILE}\""),
		"--config".to_owned(),
		permission_filesystem_config(
			SandboxPolicy::WorkspaceWrite,
			workspace,
			denied_roots,
			additional_read_paths,
		)?,
		"--config".to_owned(),
		format!("permissions.{BENCHMARK_PERMISSION_PROFILE}.network.enabled=false"),
		"--cd".to_owned(),
		workspace.to_owned(),
		probe_executable_path.to_owned(),
		"__permission-probe".to_owned(),
		"--allowed-file".to_owned(),
		allowed_file.to_owned(),
		"--writable-file".to_owned(),
		writable_file.to_owned(),
		"--read-only-file".to_owned(),
		read_only_file.to_owned(),
		"--read-only-write-file".to_owned(),
		read_only_write_file.to_owned(),
		"--network-sentinel-port".to_owned(),
		network_sentinel_port.to_string(),
	];

	for denied_file in denied_files {
		args.extend([
			"--denied-file".to_owned(),
			utf8_path(denied_file, "isolation-probe denied file")?.to_owned(),
		]);
	}

	Ok(args)
}

fn resolve_probe_executable(explicit: Option<&Path>) -> Result<PathBuf, AdapterFailure> {
	let executable =
		explicit.map_or_else(env::current_exe, |path| Ok(path.to_owned())).map_err(|error| {
			adapter_failure(
				AdapterFailureKind::Spawn,
				format!("cannot identify isolation-probe executable: {error}"),
			)
		})?;

	fs::canonicalize(executable).map_err(|error| {
		adapter_failure(
			AdapterFailureKind::Spawn,
			format!("cannot resolve isolation-probe executable: {error}"),
		)
	})
}

fn utf8_path<'a>(path: &'a Path, field: &str) -> Result<&'a str, AdapterFailure> {
	path.to_str().ok_or_else(|| {
		adapter_failure(
			AdapterFailureKind::Spawn,
			format!("{field} is not valid UTF-8 and cannot be passed to Codex"),
		)
	})
}

fn toml_basic_string(value: &str) -> String {
	let mut encoded = String::with_capacity(value.len().saturating_add(2));

	encoded.push('"');

	for character in value.chars() {
		match character {
			'"' => encoded.push_str("\\\""),
			'\\' => encoded.push_str("\\\\"),
			'\u{0008}' => encoded.push_str("\\b"),
			'\t' => encoded.push_str("\\t"),
			'\n' => encoded.push_str("\\n"),
			'\u{000c}' => encoded.push_str("\\f"),
			'\r' => encoded.push_str("\\r"),
			character if character <= '\u{001f}' || character == '\u{007f}' => {
				encoded.push_str(&format!("\\u{:04X}", u32::from(character)));
			},
			character => encoded.push(character),
		}
	}

	encoded.push('"');

	encoded
}

fn codex_version_at_least(value: &str, major: u64, minor: u64, patch: u64) -> bool {
	let Some(version) = value
		.split_ascii_whitespace()
		.find(|part| part.as_bytes().first().is_some_and(u8::is_ascii_digit))
	else {
		return false;
	};
	let numeric = version.split('-').next().unwrap_or(version);
	let mut components = numeric.split('.').map(str::parse::<u64>);
	let observed = match (components.next(), components.next(), components.next()) {
		(Some(Ok(major)), Some(Ok(minor)), Some(Ok(patch))) => (major, minor, patch),
		_ => return false,
	};

	observed >= (major, minor, patch)
}

fn json_rpc_result<T>(stdout: &[u8], expected_id: u64, method: &str) -> Result<T, AdapterFailure>
where
	T: for<'de> Deserialize<'de>,
{
	for line in stdout.split(|byte| *byte == b'\n').filter(|line| !line.is_empty()) {
		let Ok(response) = serde_json::from_slice::<JsonRpcResponse<T>>(line) else {
			continue;
		};

		if response.id != expected_id {
			continue;
		}
		if response.error.is_some() {
			return Err(adapter_failure(
				AdapterFailureKind::Spawn,
				format!("model-free Codex {method} returned an error"),
			));
		}

		return response.result.ok_or_else(|| {
			adapter_failure(
				AdapterFailureKind::Spawn,
				format!("model-free Codex {method} returned no result"),
			)
		});
	}

	Err(adapter_failure(
		AdapterFailureKind::Spawn,
		format!("model-free Codex {method} response is missing"),
	))
}

fn classify_capture<S>(
	capture: ExecutionCapture,
	sink: &S,
	retain_stdout: bool,
) -> Result<CodexOutput, AdapterFailure>
where
	S: ArtifactSink,
{
	let stdout_full = String::from_utf8_lossy(&capture.stdout).into_owned();
	let stderr_full = String::from_utf8_lossy(&capture.stderr).into_owned();
	let stderr = preview(&stderr_full);
	let artifacts =
		capture_artifacts(&capture, sink, retain_stdout).map_err(|artifacts| AdapterFailure {
			kind: AdapterFailureKind::WorkspaceIntegrity,
			exit_code: capture.exit_code,
			stderr: stderr.clone(),
			message: "post-invocation output evidence retention failed".to_owned(),
			stdout_truncated: capture.stdout_truncated,
			stderr_truncated: capture.stderr_truncated,
			artifacts,
			stdout_full: stdout_full.clone(),
		})?;

	if capture.timed_out {
		return Err(AdapterFailure {
			kind: AdapterFailureKind::Timeout,
			exit_code: capture.exit_code,
			stderr,
			message: "Codex CLI exceeded the configured timeout".to_owned(),
			stdout_truncated: capture.stdout_truncated,
			stderr_truncated: capture.stderr_truncated,
			artifacts,
			stdout_full,
		});
	}

	if let Some(kind) = capture.budget_exceeded {
		return Err(AdapterFailure {
			kind: if kind == LiveBudgetKind::Output {
				AdapterFailureKind::OutputTruncated
			} else {
				AdapterFailureKind::BudgetExceeded
			},
			exit_code: capture.exit_code,
			stderr,
			message: format!("Codex CLI exceeded the live {kind:?} budget"),
			stdout_truncated: capture.stdout_truncated,
			stderr_truncated: capture.stderr_truncated,
			artifacts,
			stdout_full,
		});
	}

	if capture.stdout_truncated || capture.stderr_truncated {
		return Err(AdapterFailure {
			kind: AdapterFailureKind::OutputTruncated,
			exit_code: capture.exit_code,
			stderr,
			message: "Codex CLI output exceeded the safe capture limit".to_owned(),
			stdout_truncated: capture.stdout_truncated,
			stderr_truncated: capture.stderr_truncated,
			artifacts,
			stdout_full,
		});
	}
	if capture.exit_code != Some(0) {
		let diagnostic = format!("{stdout_full}\n{stderr_full}").to_lowercase();
		let (kind, message) = if [
			"unsupported model",
			"model is not supported",
			"unknown model",
			"invalid reasoning effort",
		]
		.iter()
		.any(|needle| diagnostic.contains(needle))
		{
			(AdapterFailureKind::Unsupported, "Codex CLI exited unsuccessfully")
		} else if ["rate limit"].iter().any(|needle| diagnostic.contains(needle)) {
			(AdapterFailureKind::UsageLimit, "Codex subscription rate limit was reached")
		} else if ["quota exceeded", "insufficient quota"]
			.iter()
			.any(|needle| diagnostic.contains(needle))
		{
			(AdapterFailureKind::UsageLimit, "Codex subscription quota was reached")
		} else if ["usage limit", "subscription limit", "weighted tokens left"]
			.iter()
			.any(|needle| diagnostic.contains(needle))
		{
			(AdapterFailureKind::UsageLimit, "Codex subscription usage limit was reached")
		} else if [
			"not logged in",
			"authentication",
			"unauthorized",
			"please login",
			"please log in",
		]
		.iter()
		.any(|needle| diagnostic.contains(needle))
		{
			(AdapterFailureKind::Authentication, "Codex CLI exited unsuccessfully")
		} else {
			(AdapterFailureKind::NonZeroExit, "Codex CLI exited unsuccessfully")
		};

		return Err(AdapterFailure {
			kind,
			exit_code: capture.exit_code,
			stderr,
			message: message.to_owned(),
			stdout_truncated: false,
			stderr_truncated: false,
			artifacts,
			stdout_full,
		});
	}

	Ok(CodexOutput {
		stdout: preview(&stdout_full),
		stderr: preview(&stderr_full),
		exit_code: capture.exit_code,
		artifacts,
		stdout_full,
	})
}

fn normalize_preflight_report(report: &mut CapabilityValidationReport) {
	normalize_optional_failure(&mut report.cli_probe.failure);
	normalize_optional_failure(&mut report.authentication_probe.failure);

	for entry in &mut report.models {
		normalize_optional_failure(&mut entry.probe.failure);

		entry.probe.evidence_digest = configuration_evidence_digest(
			entry.model,
			entry.probe.codex_version.as_ref(),
			&entry.probe.observed_at,
			entry.probe.status,
			entry.probe.result_digest.as_deref(),
			entry.probe.result_preview.as_deref(),
			&entry.probe.artifacts,
			entry.probe.failure.as_ref(),
		)
		.unwrap_or_else(|_| "sha256:unavailable".to_owned());
	}
}

fn normalize_optional_failure(failure: &mut Option<AdapterFailure>) {
	let Some(failure) = failure else { return };

	failure.stderr.clear();
	failure.stdout_full.clear();

	failure.message = normalized_preflight_failure_message(failure.kind).to_owned();
}

fn normalized_preflight_failure_message(kind: AdapterFailureKind) -> &'static str {
	match kind {
		AdapterFailureKind::Spawn => "Codex CLI could not be executed or observed",
		AdapterFailureKind::Timeout => "Codex CLI exceeded the configured timeout",
		AdapterFailureKind::Unsupported => "Codex rejected the exact model configuration",
		AdapterFailureKind::Authentication => {
			"Codex authentication or subscription authorization failed"
		},
		AdapterFailureKind::UsageLimit => "Codex subscription usage limit or quota was reached",
		AdapterFailureKind::NonZeroExit => "Codex CLI exited unsuccessfully",
		AdapterFailureKind::BudgetExceeded => "Codex CLI exceeded a configured live budget",
		AdapterFailureKind::OutputTruncated => "Codex CLI output exceeded the safe capture limit",
		AdapterFailureKind::WorkspaceIntegrity => {
			"post-invocation output evidence or scratch cleanup failed"
		},
	}
}

fn capture_artifacts<S>(
	capture: &ExecutionCapture,
	sink: &S,
	retain_stdout: bool,
) -> Result<Vec<ArtifactReference>, Vec<ArtifactReference>>
where
	S: ArtifactSink,
{
	let mut artifacts = Vec::new();

	if !capture.stdout.is_empty()
		&& (retain_stdout || capture.stdout.len() > MAX_INLINE_PREVIEW_BYTES)
	{
		let stdout = sink.put("stdout.jsonl", &capture.stdout).map_err(|_| artifacts.clone())?;

		artifacts.push(stdout);
	}
	if capture.stderr.len() > MAX_INLINE_PREVIEW_BYTES {
		let stderr = sink.put("stderr.txt", &capture.stderr).map_err(|_| artifacts.clone())?;

		artifacts.push(stderr);
	}

	Ok(artifacts)
}

fn post_execution_integrity_failure(
	classified: Result<CodexOutput, AdapterFailure>,
	message: &'static str,
) -> AdapterFailure {
	match classified {
		Ok(output) => AdapterFailure {
			kind: AdapterFailureKind::WorkspaceIntegrity,
			exit_code: output.exit_code,
			stderr: output.stderr,
			message: message.to_owned(),
			stdout_truncated: false,
			stderr_truncated: false,
			artifacts: output.artifacts,
			stdout_full: output.stdout_full,
		},
		Err(mut failure) => {
			failure.kind = AdapterFailureKind::WorkspaceIntegrity;
			failure.message = message.to_owned();

			failure
		},
	}
}

fn preview(value: &str) -> String {
	let end = value.floor_char_boundary(MAX_INLINE_PREVIEW_BYTES.min(value.len()));

	value[..end].to_owned()
}

fn adapter_failure(kind: AdapterFailureKind, message: impl Into<String>) -> AdapterFailure {
	AdapterFailure {
		kind,
		exit_code: None,
		stderr: String::new(),
		message: message.into(),
		stdout_truncated: false,
		stderr_truncated: false,
		artifacts: Vec::new(),
		stdout_full: String::new(),
	}
}

fn validate_model(
	manifest: &CapabilityManifest,
	model: ModelConfig,
	observed_version: Option<&String>,
	version_matches: bool,
	manifest_valid: bool,
	observed_at: String,
	active: Result<CodexOutput, AdapterFailure>,
) -> CapabilityValidation {
	let claim = manifest.claim(model);
	let active_status = match &active {
		Ok(_) => ConfigurationProbeStatus::Available,
		Err(failure) if failure.kind == AdapterFailureKind::Unsupported => {
			ConfigurationProbeStatus::ObservedUnsupported
		},
		Err(_) => ConfigurationProbeStatus::Failed,
	};
	let result_digest = active
		.as_ref()
		.ok()
		.map(|output| sha256(output.stdout_full.as_bytes()).expect("SHA-256 cannot fail"));
	let result_preview = active.as_ref().ok().map(|output| output.stdout.clone());
	let artifacts = active
		.as_ref()
		.map_or_else(|failure| failure.artifacts.clone(), |output| output.artifacts.clone());
	let failure = active.as_ref().err().cloned();
	let evidence_digest = configuration_evidence_digest(
		model,
		observed_version,
		&observed_at,
		active_status,
		result_digest.as_deref(),
		result_preview.as_deref(),
		&artifacts,
		failure.as_ref(),
	)
	.unwrap_or_else(|_| "sha256:unavailable".to_owned());
	let probe = ConfigurationProbe {
		status: active_status,
		codex_version: observed_version.cloned(),
		observed_at,
		result_digest,
		result_preview,
		artifacts,
		evidence_digest,
		failure,
	};

	if !manifest_valid {
		return unavailable_validation(model, "capability manifest is structurally invalid", probe);
	}
	if observed_version.is_none() {
		return unavailable_validation(model, "Codex CLI version probe failed", probe);
	}
	if !version_matches {
		return unavailable_validation(
			model,
			"capability manifest version does not match the observed Codex CLI",
			probe,
		);
	}

	let Some(claim) = claim else {
		return unavailable_validation(model, "capability manifest has no matrix claim", probe);
	};

	match (&claim.status, active_status) {
		(_, ConfigurationProbeStatus::Failed) => unavailable_validation(
			model,
			"active configuration probe failed without establishing support",
			probe,
		),
		(CapabilityStatus::Available, ConfigurationProbeStatus::Available) => {
			CapabilityValidation {
				model,
				status: CapabilityValidationStatus::Available,
				reason: "version-bound manifest and active configuration probe agree".to_owned(),
				probe,
			}
		},
		(CapabilityStatus::Unsupported, ConfigurationProbeStatus::ObservedUnsupported) => {
			CapabilityValidation {
				model,
				status: CapabilityValidationStatus::Unsupported,
				reason: "active probe confirmed the version-bound unsupported claim".to_owned(),
				probe,
			}
		},
		(CapabilityStatus::Available, ConfigurationProbeStatus::ObservedUnsupported) => {
			CapabilityValidation {
				model,
				status: CapabilityValidationStatus::Unsupported,
				reason:
					"active probe observed unsupported; the stale available claim was not trusted"
						.to_owned(),
				probe,
			}
		},
		(CapabilityStatus::Unsupported, ConfigurationProbeStatus::Available) => {
			unavailable_validation(model, "active probe contradicted the unsupported claim", probe)
		},
	}
}

fn unavailable_validation(
	model: ModelConfig,
	reason: impl Into<String>,
	probe: ConfigurationProbe,
) -> CapabilityValidation {
	CapabilityValidation {
		model,
		status: CapabilityValidationStatus::Unavailable,
		reason: reason.into(),
		probe,
	}
}

fn is_node_id(value: &str) -> bool {
	value.strip_prefix("node_").is_some_and(|digest| {
		digest.len() == 64
			&& digest.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
	})
}

fn is_utc_timestamp(value: &str) -> bool {
	let bytes = value.as_bytes();

	bytes.len() == 20
		&& bytes[0..4].iter().all(u8::is_ascii_digit)
		&& bytes[4] == b'-'
		&& bytes[5..7].iter().all(u8::is_ascii_digit)
		&& bytes[7] == b'-'
		&& bytes[8..10].iter().all(u8::is_ascii_digit)
		&& bytes[10] == b'T'
		&& bytes[11..13].iter().all(u8::is_ascii_digit)
		&& bytes[13] == b':'
		&& bytes[14..16].iter().all(u8::is_ascii_digit)
		&& bytes[16] == b':'
		&& bytes[17..19].iter().all(u8::is_ascii_digit)
		&& bytes[19] == b'Z'
		&& value[5..7].parse::<u8>().is_ok_and(|month| (1..=12).contains(&month))
		&& value[8..10].parse::<u8>().is_ok_and(|day| (1..=31).contains(&day))
		&& value[11..13].parse::<u8>().is_ok_and(|hour| hour < 24)
		&& value[14..16].parse::<u8>().is_ok_and(|minute| minute < 60)
		&& value[17..19].parse::<u8>().is_ok_and(|second| second < 60)
}

fn observation_time() -> String {
	let milliseconds =
		SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |duration| duration.as_millis());

	format!("unix-ms:{milliseconds}")
}

#[cfg(test)]
mod tests {
	#[cfg(target_os = "macos")]
	use std::fs::File;
	#[cfg(unix)]
	use std::os::unix::process::CommandExt as _;
	#[cfg(unix)]
	use std::os::{fd::AsRawFd as _, unix::fs::PermissionsExt as _};
	#[cfg(unix)]
	use std::process::{Command, Stdio};
	use std::{
		cell::RefCell,
		collections::{BTreeMap, BTreeSet},
		env, fs,
		io::{self, Read as _, Write as _},
		path::PathBuf,
		process, slice,
		sync::{
			OnceLock,
			atomic::{AtomicU32, AtomicU64, Ordering},
			mpsc,
		},
		thread,
		time::{Duration, Instant},
	};

	#[cfg(target_os = "linux")]
	use crate::adapter::process_group;
	use crate::{
		adapter::{
			AdapterFailureKind, ArtifactReference, ArtifactSink, CODEX_ITEM_ACCOUNTING_VERSION,
			CapabilityValidationStatus, ChildProcessObserver, CodexAdapter, CodexExecutionConfig,
			CodexItemPhase, CommandRequest, ConfigurationProbeStatus, ExecutionCapture, Executor,
			ExecutorError, InvocationRequest, LiveBudgetKind, LiveItemAccounting,
			LocalArtifactSink, MAX_INLINE_PREVIEW_BYTES, SandboxPolicy, SystemExecutor,
		},
		corpus_commitment,
		model::{CapabilityManifest, CapabilityStatus, MODEL_MATRIX, ModelCapability},
	};

	static AUTH_FIXTURE_SEQUENCE: AtomicU64 = AtomicU64::new(0);
	static PROCESS_FIXTURE_SEQUENCE: AtomicU64 = AtomicU64::new(0);
	static TEST_CONTROLLED_ROOT: OnceLock<PathBuf> = OnceLock::new();

	#[derive(Default)]
	struct FakeExecutor {
		captures: RefCell<Vec<Result<ExecutionCapture, ExecutorError>>>,
		requests: RefCell<Vec<CommandRequest>>,
	}

	struct CanaryWritingExecutor {
		capture: RefCell<Option<ExecutionCapture>>,
		write_writable: bool,
		read_only_kind: Option<CanaryFileKind>,
	}

	struct ScratchReplacingExecutor {
		capture: RefCell<Option<ExecutionCapture>>,
		replacement: RefCell<Option<PathBuf>>,
	}

	#[derive(Clone, Copy)]
	enum CanaryFileKind {
		Regular,
		Directory,
	}

	#[derive(Default)]
	struct MemorySink {
		values: RefCell<Vec<Vec<u8>>>,
	}

	struct FailingSink;

	#[derive(Default)]
	struct RecordingChildObserver {
		spawned: AtomicU32,
		reaped: AtomicU32,
	}

	#[cfg(target_os = "macos")]
	struct OwnerImmutableAuthFixture {
		root: PathBuf,
	}

	impl ChildProcessObserver for RecordingChildObserver {
		fn child_spawned(&self, pid: u32) {
			self.spawned.store(pid, Ordering::SeqCst);
		}

		fn child_reaped(&self, pid: u32, _exit_code: Option<i32>) {
			self.reaped.store(pid, Ordering::SeqCst);
		}
	}

	impl FakeExecutor {
		fn from_order(captures: Vec<Result<ExecutionCapture, ExecutorError>>) -> Self {
			Self { captures: RefCell::new(captures.into_iter().rev().collect()), ..Self::default() }
		}
	}

	impl Executor for FakeExecutor {
		fn execute(&self, request: &CommandRequest) -> Result<ExecutionCapture, ExecutorError> {
			self.requests.borrow_mut().push(request.clone());

			self.captures.borrow_mut().pop().expect("test must provide a capture")
		}
	}

	impl Executor for CanaryWritingExecutor {
		fn execute(&self, request: &CommandRequest) -> Result<ExecutionCapture, ExecutorError> {
			if self.write_writable {
				fs::write(request_argument_path(request, "--writable-file"), b"AIQ_WRITE")
					.expect("create fixture writable canary");
			}

			if let Some(kind) = self.read_only_kind {
				let path = request_argument_path(request, "--read-only-write-file");

				match kind {
					CanaryFileKind::Regular => {
						fs::write(path, []).expect("create fixture read-only canary");
					},
					CanaryFileKind::Directory => {
						fs::create_dir(path).expect("create fixture read-only canary directory");
					},
				}
			}

			Ok(self.capture.borrow_mut().take().expect("test must provide a capture"))
		}
	}

	impl Executor for ScratchReplacingExecutor {
		fn execute(&self, request: &CommandRequest) -> Result<ExecutionCapture, ExecutorError> {
			let scratch = request
				.environment
				.get("TMPDIR")
				.map(PathBuf::from)
				.expect("controlled scratch environment");

			fs::remove_dir(&scratch).expect("remove controlled scratch directory");
			fs::write(&scratch, b"hostile replacement").expect("replace scratch with file");

			*self.replacement.borrow_mut() = Some(scratch);

			Ok(self.capture.borrow_mut().take().expect("test must provide a capture"))
		}
	}

	impl ArtifactSink for MemorySink {
		fn put(&self, kind: &str, bytes: &[u8]) -> Result<ArtifactReference, ExecutorError> {
			self.values.borrow_mut().push(bytes.to_vec());

			Ok(ArtifactReference {
				kind: kind.to_owned(),
				content_hash: format!("sha256:{}", "a".repeat(64)),
				uri: format!("aiq-artifact://fixture/{kind}"),
				bytes: bytes.len() as u64,
			})
		}
	}

	impl ArtifactSink for FailingSink {
		fn put(&self, _kind: &str, _bytes: &[u8]) -> Result<ArtifactReference, ExecutorError> {
			Err(ExecutorError::new("synthetic sink failure"))
		}
	}

	#[cfg(target_os = "macos")]
	impl OwnerImmutableAuthFixture {
		fn new(account_id: &str, claim_account_id: &str) -> Self {
			let fixture = Self { root: synthetic_auth_fixture(account_id, claim_account_id) };
			let auth_file =
				File::open(fixture.root.join("auth.json")).expect("open immutable auth fixture");

			assert_eq!(
				unsafe { libc::fchflags(auth_file.as_raw_fd(), libc::UF_IMMUTABLE) },
				0,
				"make auth fixture owner immutable",
			);

			fixture
		}
	}

	#[cfg(target_os = "macos")]
	impl Drop for OwnerImmutableAuthFixture {
		fn drop(&mut self) {
			if let Ok(auth_file) = File::open(self.root.join("auth.json")) {
				unsafe {
					libc::fchflags(auth_file.as_raw_fd(), 0);
				}
			}

			let _ = fs::remove_dir_all(&self.root);
		}
	}

	fn request_argument_path(request: &CommandRequest, flag: &str) -> PathBuf {
		let index = request
			.args
			.iter()
			.position(|argument| argument == flag)
			.expect("fixture request flag");

		PathBuf::from(request.args.get(index + 1).expect("fixture request path"))
	}

	#[test]
	fn adapter_failure_debug_redacts_captured_provider_streams() {
		let mut failure =
			super::adapter_failure(AdapterFailureKind::NonZeroExit, "controlled failure");

		failure.stderr = "private stderr prompt".to_owned();
		failure.stdout_full = "private stdout prompt".to_owned();

		let debug = format!("{failure:?}");

		assert!(!debug.contains("private stderr prompt"));
		assert!(!debug.contains("private stdout prompt"));
		assert!(debug.matches("[REDACTED]").count() >= 2);
	}

	fn base64url(bytes: &[u8]) -> String {
		const ALPHABET: &[u8; 64] =
			b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

		let mut output = String::new();
		let mut index = 0;

		while index < bytes.len() {
			let first = bytes[index];
			let second = bytes.get(index + 1).copied();
			let third = bytes.get(index + 2).copied();

			output.push(char::from(ALPHABET[usize::from(first >> 2)]));
			output.push(char::from(
				ALPHABET[usize::from((first & 0x03) << 4 | second.unwrap_or(0) >> 4)],
			));

			if let Some(second) = second {
				output.push(char::from(
					ALPHABET[usize::from((second & 0x0f) << 2 | third.unwrap_or(0) >> 6)],
				));
			}
			if let Some(third) = third {
				output.push(char::from(ALPHABET[usize::from(third & 0x3f)]));
			}

			index += 3;
		}

		output
	}

	fn synthetic_auth_fixture(account_id: &str, claim_account_id: &str) -> PathBuf {
		let root = env::temp_dir().join(format!(
			"aiq-auth-fixture-{}-{}",
			process::id(),
			AUTH_FIXTURE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
		));

		fs::create_dir(&root).expect("auth fixture root");
		#[cfg(unix)]
		fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
			.expect("private auth fixture root");

		let payload = serde_json::json!({
			"https://api.openai.com/auth": {
				"chatgpt_user_id": "user-synthetic-0123456789abcdef",
				"chatgpt_account_id": claim_account_id,
				"chatgpt_plan_type": "synthetic-team"
			}
		});
		let token = format!(
			"{}.{}.synthetic-signature",
			base64url(br#"{"alg":"synthetic"}"#),
			base64url(&serde_json::to_vec(&payload).expect("synthetic claims"))
		);
		let auth = serde_json::json!({
			"tokens": {
				"account_id": account_id,
				"id_token": token,
				"access_token": "synthetic-access-token-never-read"
			}
		});
		let path = root.join("auth.json");

		fs::write(&path, serde_json::to_vec(&auth).expect("synthetic auth JSON"))
			.expect("synthetic auth fixture");
		#[cfg(unix)]
		fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
			.expect("private auth fixture");

		root
	}

	fn capture(
		exit_code: i32,
		stdout: impl Into<Vec<u8>>,
		stderr: impl Into<Vec<u8>>,
	) -> ExecutionCapture {
		ExecutionCapture {
			exit_code: Some(exit_code),
			stdout: stdout.into(),
			stderr: stderr.into(),
			timed_out: false,
			budget_exceeded: None,
			stdout_truncated: false,
			stderr_truncated: false,
		}
	}

	fn adapter(
		captures: Vec<Result<ExecutionCapture, ExecutorError>>,
	) -> CodexAdapter<FakeExecutor, MemorySink> {
		let root = test_controlled_root();

		CodexAdapter::new(
			FakeExecutor::from_order(captures),
			MemorySink::default(),
			"codex",
			CodexExecutionConfig::isolated(root.join("codex-home"))
				.with_denied_roots(vec![root.join("denied")]),
		)
	}

	fn test_controlled_root() -> PathBuf {
		TEST_CONTROLLED_ROOT
			.get_or_init(|| {
				let base = env::var_os("CARGO_TARGET_TMPDIR")
					.map(PathBuf::from)
					.unwrap_or_else(env::temp_dir);
				let root = base.join(format!("aiq-runner-adapter-unit-{}", process::id()));

				fs::create_dir_all(root.join("codex-home")).expect("controlled Codex home fixture");
				fs::create_dir_all(root.join("task")).expect("controlled workspace fixture");
				#[cfg(unix)]
				fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
					.expect("private controlled fixture");

				fs::canonicalize(root).expect("canonical controlled fixture")
			})
			.clone()
	}

	fn invocation() -> InvocationRequest {
		let root = test_controlled_root();

		InvocationRequest {
			model: MODEL_MATRIX[0],
			prompt: "test".to_owned(),
			timeout: Duration::from_secs(1),
			max_steps: 2,
			max_tool_calls: 0,
			workspace_dir: root.join("task"),
			sandbox: SandboxPolicy::ReadOnly,
		}
	}

	fn manifest(status: CapabilityStatus, version: &str) -> CapabilityManifest {
		CapabilityManifest {
			schema_version: "aiq.capabilities.v1".to_owned(),
			node_id: format!("node_{}", "a".repeat(64)),
			observed_at: "2026-07-24T12:00:00Z".to_owned(),
			codex_version: version.to_owned(),
			models: MODEL_MATRIX
				.into_iter()
				.map(|model| ModelCapability {
					model,
					status: status.clone(),
					reason: Some("fixture claim".to_owned()),
				})
				.collect(),
		}
	}

	#[test]
	fn model_removed_controlled_scratch_is_idempotent_cleanup() {
		let scratch = super::WorkspaceScratch::create(&test_controlled_root().join("task"))
			.expect("controlled scratch");

		fs::remove_dir_all(&scratch.path).expect("model removes its controlled scratch");

		scratch.remove().expect("first missing cleanup");
		scratch.remove().expect("repeated missing cleanup");
		scratch.cleanup().expect("explicit missing cleanup");
	}

	#[test]
	fn controlled_scratch_cleanup_rejects_hostile_type_change() {
		let scratch = super::WorkspaceScratch::create(&test_controlled_root().join("task"))
			.expect("controlled scratch");
		let path = scratch.path.clone();

		fs::remove_dir(&path).expect("remove original scratch directory");
		fs::write(&path, b"hostile replacement").expect("replace scratch with regular file");

		let error = scratch.remove().expect_err("type change must fail closed");

		assert_eq!(error.kind, AdapterFailureKind::Spawn);
		assert!(error.message.contains("changed type"));

		drop(scratch);

		assert!(path.is_file(), "Drop must not remove a hostile replacement");

		fs::remove_file(path).expect("remove hostile test replacement");
	}

	#[test]
	fn paid_capture_survives_hostile_scratch_cleanup_failure() {
		let stdout = br#"{"type":"turn.completed","usage":{"input_tokens":11,"output_tokens":5}}
"#
		.to_vec();
		let adapter = CodexAdapter::new(
			ScratchReplacingExecutor {
				capture: RefCell::new(Some(capture(0, stdout.clone(), Vec::new()))),
				replacement: RefCell::new(None),
			},
			MemorySink::default(),
			"codex",
			CodexExecutionConfig::isolated(test_controlled_root().join("codex-home"))
				.with_denied_roots(vec![test_controlled_root().join("denied")]),
		);
		let failure = adapter.invoke(&invocation()).expect_err("cleanup failure must fail closed");

		assert_eq!(failure.kind, AdapterFailureKind::WorkspaceIntegrity);
		assert_eq!(failure.exit_code, Some(0));
		assert_eq!(failure.stdout_full.as_bytes(), stdout);
		assert!(failure.artifacts.iter().any(|artifact| artifact.kind == "stdout.jsonl"));
		assert_eq!(adapter.sink.values.borrow().as_slice(), [stdout]);

		let replacement =
			adapter.executor.replacement.borrow_mut().take().expect("hostile replacement path");

		fs::remove_file(replacement).expect("remove hostile replacement");
	}

	#[test]
	fn paid_capture_survives_artifact_sink_failure_in_memory() {
		let stdout = br#"{"type":"turn.completed","usage":{"input_tokens":11,"output_tokens":5}}
"#
		.to_vec();
		let root = test_controlled_root();
		let adapter = CodexAdapter::new(
			FakeExecutor::from_order(vec![Ok(capture(0, stdout.clone(), Vec::new()))]),
			FailingSink,
			"codex",
			CodexExecutionConfig::isolated(root.join("codex-home"))
				.with_denied_roots(vec![root.join("denied")]),
		);
		let failure = adapter.invoke(&invocation()).expect_err("sink failure must fail closed");

		assert_eq!(failure.kind, AdapterFailureKind::WorkspaceIntegrity);
		assert_eq!(failure.exit_code, Some(0));
		assert_eq!(failure.stdout_full.as_bytes(), stdout);
		assert!(failure.artifacts.is_empty());
	}

	#[test]
	fn successful_output_debug_redacts_all_inline_provider_text() {
		let secret = "private provider stdout";
		let output = super::CodexOutput {
			stdout: secret.to_owned(),
			stderr: "private provider stderr".to_owned(),
			exit_code: Some(0),
			artifacts: Vec::new(),
			stdout_full: secret.to_owned(),
		};
		let rendered = format!("{output:?}");

		assert!(!rendered.contains(secret));
		assert!(!rendered.contains("private provider stderr"));
		assert!(rendered.contains("[REDACTED]"));
	}

	#[test]
	fn child_request_clears_secrets_and_disables_unapproved_surfaces() {
		let adapter = adapter(vec![Ok(capture(0, b"ok".to_vec(), Vec::new()))]);

		adapter.invoke(&invocation()).expect("capture must succeed");

		let requests = adapter.executor.requests.borrow();
		let request = requests.first().expect("request must be captured");

		assert!(request.clear_environment);
		assert!(!request.environment.contains_key("OPENAI_API_KEY"));
		assert!(!request.environment.contains_key("HOME"));
		assert!(!request.environment.contains_key("TEMP"));
		assert!(!request.environment.contains_key("TMP"));

		for key in super::CODEX_PROXY_ENVIRONMENT_KEYS {
			assert!(!request.environment.contains_key(key));
		}

		assert!(!request.environment.contains_key("NO_PROXY"));
		assert!(!request.environment.contains_key("no_proxy"));

		let scratch = request.environment.get("TMPDIR").expect("controlled scratch");

		assert!(PathBuf::from(scratch).starts_with(test_controlled_root().join("task")));
		assert!(!PathBuf::from(scratch).exists());
		assert_eq!(
			request.environment.get("CODEX_HOME"),
			Some(&test_controlled_root().join("codex-home").display().to_string())
		);
		assert!(request.args.contains(&"--ignore-user-config".to_owned()));
		assert!(request.args.contains(&"--ignore-rules".to_owned()));
		assert!(request.args.contains(&"--strict-config".to_owned()));
		assert!(!request.args.contains(&"--sandbox".to_owned()));
		assert!(request.args.windows(2).any(|pair| pair == ["--config", "mcp_servers={}"]));
		assert!(
			request.args.windows(2).any(|pair| pair == ["--config", "web_search=\"disabled\""])
		);
		assert!(
			request.args.windows(2).any(|pair| pair == ["--config", "approval_policy=\"never\""])
		);
		assert!(
			request
				.args
				.windows(2)
				.any(|pair| pair == ["--config", "default_permissions=\"aiq_benchmark\""])
		);

		let root = test_controlled_root();
		let expected_filesystem = super::permission_filesystem_config(
			SandboxPolicy::ReadOnly,
			root.join("task").to_str().expect("UTF-8 fixture"),
			&[root.join("denied")],
			&[PathBuf::from("/toolchain")],
		)
		.expect("fixture permission policy");

		assert!(
			request
				.args
				.windows(2)
				.any(|pair| { pair == ["--config", expected_filesystem.as_str()] })
		);
		assert!(request.args.windows(2).any(|pair| {
			pair == ["--config", "permissions.aiq_benchmark.network.enabled=false"]
		}));
		assert!(
			request
				.args
				.windows(2)
				.any(|pair| { pair == ["--config", "shell_environment_policy.inherit=\"none\""] })
		);
		assert!(!request.args.iter().any(|argument| argument.contains("HTTP_PROXY")));
		assert!(!request.args.iter().any(|argument| argument.contains("http_proxy")));

		let disabled = request
			.args
			.windows(2)
			.filter(|pair| pair[0] == "--disable")
			.map(|pair| pair[1].as_str())
			.collect::<BTreeSet<_>>();

		assert_eq!(disabled, super::DISABLED_CODEX_FEATURES.iter().copied().collect());
		assert!(!disabled.contains("browser"));
	}

	#[test]
	fn direct_egress_removes_all_inherited_proxy_and_bypass_variables() {
		let mut environment = BTreeMap::from([
			("HTTP_PROXY".to_owned(), "http://203.0.113.1:9999".to_owned()),
			("HTTPS_PROXY".to_owned(), "http://203.0.113.2:9999".to_owned()),
			("ALL_PROXY".to_owned(), "socks5://203.0.113.3:9999".to_owned()),
			("http_proxy".to_owned(), "http://203.0.113.4:9999".to_owned()),
			("https_proxy".to_owned(), "http://203.0.113.5:9999".to_owned()),
			("all_proxy".to_owned(), "socks5://203.0.113.6:9999".to_owned()),
			("NO_PROXY".to_owned(), "*".to_owned()),
			("no_proxy".to_owned(), "localhost".to_owned()),
		]);

		super::clear_outer_proxy_environment(&mut environment);

		for key in super::CODEX_PROXY_ENVIRONMENT_KEYS {
			assert!(!environment.contains_key(key));
		}

		assert!(!environment.contains_key("NO_PROXY"));
		assert!(!environment.contains_key("no_proxy"));
	}

	#[test]
	fn managed_profile_exchange_uses_the_current_app_server_request_shapes() {
		let root = test_controlled_root();
		let (args, stdin) =
			super::managed_profile_exchange(&root.join("task"), &[root.join("denied")])
				.expect("managed profile exchange");
		let requests = stdin
			.split(|byte| *byte == b'\n')
			.filter(|line| !line.is_empty())
			.map(|line| {
				serde_json::from_slice::<serde_json::Value>(line).expect("JSON-RPC request")
			})
			.collect::<Vec<_>>();

		assert_eq!(requests.len(), 5);
		assert!(args.contains(&"--strict-config".to_owned()));
		assert!(
			args.windows(2)
				.any(|pair| { pair == ["--config", "default_permissions=\"aiq_benchmark\""] })
		);
		assert!(args.windows(2).any(|pair| {
			pair == ["--config", "permissions.aiq_benchmark.network.enabled=false"]
		}));
		assert_eq!(requests[1], serde_json::json!({"method": "initialized"}));
		assert_eq!(
			requests[2],
			serde_json::json!({
				"method": "configRequirements/read",
				"id": 1,
				"params": null
			})
		);
	}

	#[test]
	fn model_free_profile_requires_absent_external_managed_requirements_for_official() {
		fn rpc(requirements: &str) -> Vec<u8> {
			format!(
				"{{\"id\":1,\"result\":{{\"requirements\":{requirements}}}}}\n{{\"id\":2,\"result\":{{\"data\":[{{\"id\":\"aiq_benchmark\",\"allowed\":true}}]}}}}\n{{\"id\":3,\"result\":{{\"activePermissionProfile\":{{\"id\":\"aiq_benchmark\"}}}}}}\n"
			)
			.into_bytes()
		}

		let workspace = test_controlled_root().join("task");
		let official = adapter(vec![
			Ok(capture(0, b"codex-cli 0.138.0".to_vec(), Vec::new())),
			Ok(capture(0, rpc("null"), Vec::new())),
		]);
		let official_evidence = official
			.verify_managed_permission_profile(&workspace)
			.expect("explicit profile with absent external requirements");

		assert!(official_evidence.official_eligible);
		assert_eq!(official_evidence.managed_requirements_status, "absent_expected");

		let unexpected = adapter(vec![
			Ok(capture(0, b"codex-cli 0.138.0".to_vec(), Vec::new())),
			Ok(capture(
				0,
				rpc(
					r#"{"allowedPermissionProfiles":{"aiq_benchmark":true},"defaultPermissions":"aiq_benchmark"}"#,
				),
				Vec::new(),
			)),
		]);
		let unexpected_evidence = unexpected
			.verify_managed_permission_profile(&workspace)
			.expect("actual profile selection is reported before Official classification");

		assert!(!unexpected_evidence.official_eligible);
		assert_eq!(unexpected_evidence.managed_requirements_status, "present_unexpected");

		let planned = super::expected_official_permission_profile_digests("codex-cli 0.138.0")
			.expect("Official profile expectation");

		assert_eq!(
			official_evidence.managed_requirements_digest(),
			planned.managed_requirements_digest()
		);
		assert_eq!(
			official_evidence.profile_selection_digest(),
			planned.profile_selection_digest()
		);
		assert_ne!(
			unexpected_evidence.managed_requirements_digest(),
			official_evidence.managed_requirements_digest()
		);
		assert_eq!(
			unexpected_evidence.profile_selection_digest(),
			official_evidence.profile_selection_digest()
		);
	}

	#[test]
	fn official_permission_plan_digests_do_not_invoke_an_executor() {
		let adapter = adapter(Vec::new());
		let workspace = test_controlled_root().join("task");
		let planned_policy = super::permission_policy_digest(
			&workspace,
			&adapter.config.denied_roots,
			adapter.config.model_toolchain.as_ref(),
		)
		.expect("planned permission policy");
		let configured_policy =
			adapter.permission_policy_digest(&workspace).expect("configured permission policy");
		let profile = super::expected_official_permission_profile_digests("codex-cli 0.138.0")
			.expect("planned Official profile");

		assert_eq!(planned_policy, configured_policy);
		assert!(!profile.managed_requirements_digest().is_empty());
		assert!(!profile.profile_selection_digest().is_empty());
		assert!(adapter.executor.requests.borrow().is_empty());
	}

	#[test]
	fn prompt_and_tool_policy_are_bounded_and_enforceable() {
		let adapter = adapter(Vec::new());
		let toolchain = corpus_commitment::fixture_model_toolchain(PathBuf::from("/toolchain"));
		let mut too_large = invocation();

		too_large.prompt = "x".repeat(super::MAX_STDIN_BYTES + 1);

		assert_eq!(
			adapter.invoke(&too_large).expect_err("prompt must fail").kind,
			AdapterFailureKind::BudgetExceeded
		);
		assert!(SandboxPolicy::from_allowed_tools(&["shell".to_owned()]).is_err());
		assert_eq!(
			SandboxPolicy::from_allowed_tools(&["none".to_owned()]).expect("none is enforceable"),
			SandboxPolicy::NoTools
		);
		assert!(
			SandboxPolicy::from_allowed_tools(&["none".to_owned(), "filesystem_read".to_owned()])
				.is_err()
		);
		assert!(
			SandboxPolicy::from_allowed_tools(&["command_execution".to_owned()]).is_err(),
			"command execution must have an explicit filesystem scope"
		);
		assert_eq!(
			SandboxPolicy::from_allowed_tools(&[
				"filesystem_read".to_owned(),
				"command_execution".to_owned(),
			])
			.expect("read-scoped command execution is enforceable"),
			SandboxPolicy::ReadOnly,
		);
		assert_eq!(
			SandboxPolicy::from_allowed_tools(&[
				"filesystem_write".to_owned(),
				"command_execution".to_owned(),
			])
			.expect("write-scoped command execution is enforceable"),
			SandboxPolicy::WorkspaceWrite,
		);

		let none_args = super::invocation_args(
			MODEL_MATRIX[0],
			SandboxPolicy::NoTools,
			PathBuf::from(".").as_path(),
			&[],
			Some(&toolchain),
		)
		.expect("no-tools arguments");

		assert!(none_args.windows(2).any(|pair| pair == ["--disable", "shell_tool"]));
		assert!(none_args.windows(2).any(|pair| pair == ["--disable", "unified_exec"]));
		assert!(none_args.windows(2).any(|pair| pair == ["--config", "web_search=\"disabled\""]));
		assert!(none_args.windows(2).any(|pair| {
			pair == [
				"--config",
				"permissions.aiq_benchmark.filesystem={\":minimal\"=\"read\",\"/toolchain\"=\"read\"}",
			]
		}));

		let web_args = super::invocation_args(
			MODEL_MATRIX[0],
			SandboxPolicy::WebOnly,
			PathBuf::from(".").as_path(),
			&[],
			Some(&toolchain),
		)
		.expect("web-only arguments");

		assert!(web_args.windows(2).any(|pair| pair == ["--disable", "shell_tool"]));
		assert!(web_args.windows(2).any(|pair| pair == ["--disable", "unified_exec"]));
		assert!(web_args.windows(2).any(|pair| pair == ["--config", "web_search=\"live\""]));

		let write_args = super::invocation_args(
			MODEL_MATRIX[0],
			SandboxPolicy::WorkspaceWrite,
			PathBuf::from("/controlled/a\"b\\c").as_path(),
			&[PathBuf::from("/controlled")],
			Some(&toolchain),
		)
		.expect("workspace-write arguments");

		assert!(write_args.windows(2).any(|pair| {
			pair
				== [
					"--config",
					"permissions.aiq_benchmark.filesystem={\":minimal\"=\"read\",\"/controlled\"=\"deny\",\"/toolchain\"=\"read\",\"/controlled/a\\\"b\\\\c\"=\"write\"}",
				]
		}));
	}

	#[test]
	fn filesystem_tasks_fail_before_spawn_without_an_explicit_denied_root() {
		let adapter = CodexAdapter::new(
			FakeExecutor::default(),
			MemorySink::default(),
			"codex",
			CodexExecutionConfig::isolated("/controlled/codex-home"),
		);

		assert_eq!(
			adapter.invoke(&invocation()).expect_err("missing deny boundary must fail").kind,
			AdapterFailureKind::Spawn
		);
		assert!(adapter.executor.requests.borrow().is_empty());
	}

	#[test]
	fn permission_boundary_probe_uses_the_same_named_profile_and_exact_workspace() {
		let suffix = std::time::SystemTime::now()
			.duration_since(std::time::UNIX_EPOCH)
			.expect("fixture clock")
			.as_nanos();
		let root = env::temp_dir().join(format!("aiq-permission-probe-{}-{suffix}", process::id()));
		let workspace = root.join("workspace");
		let protected = root.join("protected");
		let allowed = workspace.join("allowed.txt");
		let denied = protected.join("denied.txt");
		let writable = workspace.join("writable.txt");

		fs::create_dir_all(&workspace).expect("fixture workspace");
		fs::create_dir_all(&protected).expect("fixture protected root");
		fs::write(&allowed, b"AIQ_ALLOWED\n").expect("allowed fixture");
		fs::write(&denied, b"AIQ_DENIED\n").expect("denied fixture");

		let adapter = CodexAdapter::new(
			FakeExecutor::from_order(vec![Ok(capture(
				0,
				b"AIQ_ISOLATION_OK".to_vec(),
				Vec::new(),
			))]),
			MemorySink::default(),
			"codex",
			CodexExecutionConfig::isolated("/controlled/codex-home").with_denied_roots(vec![
				fs::canonicalize(&protected).expect("canonical protected root"),
			]),
		);

		adapter
			.verify_permission_boundary(&workspace, &allowed, slice::from_ref(&denied), &writable)
			.expect("probe must accept the exact sentinel");

		let requests = adapter.executor.requests.borrow();
		let request = requests.first().expect("probe request");
		let canonical_workspace = fs::canonicalize(&workspace).expect("canonical workspace");
		let expected_filesystem = super::permission_filesystem_config(
			SandboxPolicy::WorkspaceWrite,
			canonical_workspace.to_str().expect("UTF-8 fixture path"),
			&adapter.config.denied_roots,
			&[PathBuf::from("/toolchain")],
		)
		.expect("permission profile");

		assert_eq!(request.args.first().map(String::as_str), Some("sandbox"));
		assert!(
			request.args.windows(2).any(|pair| {
				pair == ["--permission-profile", super::BENCHMARK_PERMISSION_PROFILE]
			})
		);
		assert!(request.args.contains(&"--include-managed-config".to_owned()));
		assert!(
			request.args.windows(2).any(|pair| pair == ["--config", expected_filesystem.as_str()])
		);
		assert!(request.args.windows(2).any(|pair| {
			pair == ["--config", "permissions.aiq_benchmark.network.enabled=false"]
		}));
		assert!(!writable.exists());

		fs::remove_dir_all(&root).expect("fixture cleanup");
	}

	#[test]
	fn permission_boundary_cleans_both_canaries_before_classifying_a_nonzero_capture() {
		let suffix = std::time::SystemTime::now()
			.duration_since(std::time::UNIX_EPOCH)
			.expect("fixture clock")
			.as_nanos();
		let root = env::temp_dir()
			.join(format!("aiq-permission-canary-nonzero-{}-{suffix}", process::id()));
		let workspace = root.join("workspace");
		let protected = root.join("protected");
		let toolchain = root.join("toolchain");
		let allowed = workspace.join("allowed.txt");
		let denied = protected.join("denied.txt");
		let writable = workspace.join("writable.txt");
		let read_only_write = toolchain.join(".aiq-read-only-canary");

		for directory in [&workspace, &protected, &toolchain] {
			fs::create_dir_all(directory).expect("fixture directory");
		}

		fs::write(&allowed, b"AIQ_ALLOWED\n").expect("allowed fixture");
		fs::write(&denied, b"AIQ_DENIED\n").expect("denied fixture");

		let adapter = CodexAdapter::new(
			CanaryWritingExecutor {
				capture: RefCell::new(Some(capture(
					1,
					Vec::new(),
					b"sandbox rejected the write".to_vec(),
				))),
				write_writable: true,
				read_only_kind: Some(CanaryFileKind::Regular),
			},
			MemorySink::default(),
			"codex",
			CodexExecutionConfig::isolated("/controlled/codex-home")
				.with_denied_roots(vec![
					fs::canonicalize(&protected).expect("canonical protected root"),
				])
				.with_model_toolchain(corpus_commitment::fixture_model_toolchain(
					fs::canonicalize(&toolchain).expect("canonical toolchain"),
				)),
		);
		let failure = adapter
			.verify_permission_boundary(&workspace, &allowed, slice::from_ref(&denied), &writable)
			.expect_err("nonzero capture and unexpected writes must fail");

		assert_eq!(failure.kind, AdapterFailureKind::NonZeroExit);
		assert_eq!(failure.exit_code, Some(1));
		assert!(failure.message.contains("writable and read-only canary files"));
		assert!(!writable.exists());
		assert!(!read_only_write.exists());

		fs::remove_dir_all(root).expect("fixture cleanup");
	}

	#[test]
	fn permission_boundary_never_turns_a_cleaned_read_only_write_into_success() {
		let suffix = std::time::SystemTime::now()
			.duration_since(std::time::UNIX_EPOCH)
			.expect("fixture clock")
			.as_nanos();
		let root = env::temp_dir()
			.join(format!("aiq-permission-canary-success-{}-{suffix}", process::id()));
		let workspace = root.join("workspace");
		let protected = root.join("protected");
		let toolchain = root.join("toolchain");
		let allowed = workspace.join("allowed.txt");
		let denied = protected.join("denied.txt");
		let writable = workspace.join("writable.txt");
		let read_only_write = toolchain.join(".aiq-read-only-canary");

		for directory in [&workspace, &protected, &toolchain] {
			fs::create_dir_all(directory).expect("fixture directory");
		}

		fs::write(&allowed, b"AIQ_ALLOWED\n").expect("allowed fixture");
		fs::write(&denied, b"AIQ_DENIED\n").expect("denied fixture");

		let adapter = CodexAdapter::new(
			CanaryWritingExecutor {
				capture: RefCell::new(Some(capture(0, b"AIQ_ISOLATION_OK".to_vec(), Vec::new()))),
				write_writable: false,
				read_only_kind: Some(CanaryFileKind::Regular),
			},
			MemorySink::default(),
			"codex",
			CodexExecutionConfig::isolated("/controlled/codex-home")
				.with_denied_roots(vec![
					fs::canonicalize(&protected).expect("canonical protected root"),
				])
				.with_model_toolchain(corpus_commitment::fixture_model_toolchain(
					fs::canonicalize(&toolchain).expect("canonical toolchain"),
				)),
		);
		let failure = adapter
			.verify_permission_boundary(&workspace, &allowed, slice::from_ref(&denied), &writable)
			.expect_err("an unexpected read-only write must override a success capture");

		assert_eq!(failure.kind, AdapterFailureKind::NonZeroExit);
		assert!(failure.message.contains("created a file in the read-only toolchain"));
		assert!(!read_only_write.exists());

		fs::remove_dir_all(root).expect("fixture cleanup");
	}

	#[test]
	fn permission_boundary_refuses_to_delete_an_unexpected_canary_directory() {
		let suffix = std::time::SystemTime::now()
			.duration_since(std::time::UNIX_EPOCH)
			.expect("fixture clock")
			.as_nanos();
		let root =
			env::temp_dir().join(format!("aiq-permission-canary-type-{}-{suffix}", process::id()));
		let workspace = root.join("workspace");
		let protected = root.join("protected");
		let toolchain = root.join("toolchain");
		let allowed = workspace.join("allowed.txt");
		let denied = protected.join("denied.txt");
		let writable = workspace.join("writable.txt");
		let read_only_write = toolchain.join(".aiq-read-only-canary");

		for directory in [&workspace, &protected, &toolchain] {
			fs::create_dir_all(directory).expect("fixture directory");
		}

		fs::write(&allowed, b"AIQ_ALLOWED\n").expect("allowed fixture");
		fs::write(&denied, b"AIQ_DENIED\n").expect("denied fixture");

		let adapter = CodexAdapter::new(
			CanaryWritingExecutor {
				capture: RefCell::new(Some(capture(1, Vec::new(), Vec::new()))),
				write_writable: true,
				read_only_kind: Some(CanaryFileKind::Directory),
			},
			MemorySink::default(),
			"codex",
			CodexExecutionConfig::isolated("/controlled/codex-home")
				.with_denied_roots(vec![
					fs::canonicalize(&protected).expect("canonical protected root"),
				])
				.with_model_toolchain(corpus_commitment::fixture_model_toolchain(
					fs::canonicalize(&toolchain).expect("canonical toolchain"),
				)),
		);
		let failure = adapter
			.verify_permission_boundary(&workspace, &allowed, slice::from_ref(&denied), &writable)
			.expect_err("an unsafe canary type must fail closed");

		assert_eq!(failure.kind, AdapterFailureKind::Spawn);
		assert!(failure.message.contains("unsafe file type; refusing cleanup"));
		assert!(!writable.exists(), "the exact regular writable canary must still be cleaned");
		assert!(read_only_write.is_dir(), "the unexpected directory must not be deleted");

		fs::remove_dir_all(root).expect("fixture cleanup");
	}

	#[test]
	#[ignore = "requires an installed Codex CLI with permission-profile support"]
	fn real_codex_model_free_profile_reports_expected_absent_managed_requirements() {
		let codex_binary =
			env::var("AIQ_REAL_CODEX_BINARY").expect("AIQ_REAL_CODEX_BINARY must name Codex");
		let codex_home =
			env::var("AIQ_REAL_CODEX_HOME").expect("AIQ_REAL_CODEX_HOME must name Codex home");
		let suffix = std::time::SystemTime::now()
			.duration_since(std::time::UNIX_EPOCH)
			.expect("fixture clock")
			.as_nanos();
		let repository_root =
			fs::canonicalize(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."))
				.expect("canonical repository root");
		let root = repository_root
			.join("target")
			.join(format!("aiq-real-managed-profile-{}-{suffix}", process::id()));
		let workspace = root.join("workspace");
		let repository_denied = repository_root.join("Cargo.toml");
		let codex_home_denied =
			fs::canonicalize(&codex_home).expect("canonical Codex home").join("config.toml");

		fs::create_dir_all(&workspace).expect("managed-profile workspace");

		let adapter = CodexAdapter::new(
			SystemExecutor,
			MemorySink::default(),
			codex_binary,
			CodexExecutionConfig::isolated(codex_home)
				.with_denied_roots(vec![repository_denied, codex_home_denied]),
		);
		let evidence = adapter.verify_managed_permission_profile(&workspace);
		let cleanup = fs::remove_dir_all(root);
		let evidence = evidence.expect("model-free explicit profile must select aiq_benchmark");
		let planned = super::expected_official_permission_profile_digests(&evidence.codex_version)
			.expect("planned Official profile");

		assert_eq!(evidence.active_permission_profile, super::BENCHMARK_PERMISSION_PROFILE);
		assert!(evidence.official_eligible);
		assert_eq!(evidence.managed_requirements_status, "absent_expected");
		assert_eq!(evidence.managed_requirements_digest(), planned.managed_requirements_digest());
		assert_eq!(evidence.profile_selection_digest(), planned.profile_selection_digest());
		assert!(!evidence.evidence_digest.is_empty());

		cleanup.expect("fixture cleanup");
	}

	#[test]
	#[ignore = "requires an installed Codex CLI with permission-profile support"]
	fn real_codex_permission_boundary_denies_external_files_and_loopback_network() {
		let codex_binary =
			env::var("AIQ_REAL_CODEX_BINARY").expect("AIQ_REAL_CODEX_BINARY must name Codex");
		let codex_home =
			env::var("AIQ_REAL_CODEX_HOME").expect("AIQ_REAL_CODEX_HOME must name Codex home");
		let permission_probe_binary = env::var("AIQ_REAL_PERMISSION_PROBE_BINARY")
			.expect("AIQ_REAL_PERMISSION_PROBE_BINARY must name aiq-runner");
		let toolchain_root = env::var("AIQ_REAL_CODEX_TOOLCHAIN_ROOT")
			.expect("AIQ_REAL_CODEX_TOOLCHAIN_ROOT must name the controlled Node.js/ripgrep root");
		let toolchain_root = fs::canonicalize(toolchain_root).expect("canonical Codex toolchain");
		let runtime = crate::task::EvaluatorRuntime::resolve(&toolchain_root.join("node"))
			.expect("toolchain Node runtime");
		let model_toolchain =
			corpus_commitment::fixture_validated_model_toolchain(&toolchain_root, &runtime);
		let suffix = std::time::SystemTime::now()
			.duration_since(std::time::UNIX_EPOCH)
			.expect("fixture clock")
			.as_nanos();
		let repository_root =
			fs::canonicalize(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."))
				.expect("canonical repository root");
		let root = repository_root
			.join("target")
			.join(format!("aiq-real-permission-probe-{}-{suffix}", process::id()));
		let workspace = root.join("workspace");
		let protected = root.join("protected");
		let allowed = workspace.join("allowed.txt");
		let denied = protected.join("denied.txt");
		let writable = workspace.join("writable.txt");

		fs::create_dir_all(&workspace).expect("fixture workspace");
		fs::create_dir_all(&protected).expect("fixture protected root");
		fs::write(&allowed, b"AIQ_ALLOWED\n").expect("allowed fixture");
		fs::write(&denied, b"AIQ_DENIED\n").expect("denied fixture");

		let denied_root = fs::canonicalize(&protected).expect("canonical protected fixture root");
		let codex_home_root = fs::canonicalize(&codex_home).expect("canonical Codex home");
		let repository_denied = repository_root.join("Cargo.toml");
		let codex_home_denied = codex_home_root.join("config.toml");
		let denied_files =
			vec![denied.clone(), repository_denied.clone(), codex_home_denied.clone()];
		let adapter = CodexAdapter::new(
			SystemExecutor,
			MemorySink::default(),
			codex_binary,
			CodexExecutionConfig::isolated(codex_home)
				.with_denied_roots(vec![
					denied_root,
					repository_denied.clone(),
					codex_home_denied.clone(),
				])
				.with_model_toolchain(model_toolchain)
				.with_permission_probe_executable(permission_probe_binary),
		);
		let result =
			adapter.verify_permission_boundary(&workspace, &allowed, &denied_files, &writable);
		let cleanup = fs::remove_dir_all(&root);

		result.expect("real Codex permission profile must enforce every canary");
		cleanup.expect("fixture cleanup");
	}

	#[cfg(target_os = "macos")]
	#[test]
	#[ignore = "requires an installed Codex CLI with permission-profile support"]
	fn real_codex_permission_boundary_fails_closed_on_platform_minimal_paths() {
		let codex_binary =
			env::var("AIQ_REAL_CODEX_BINARY").expect("AIQ_REAL_CODEX_BINARY must name Codex");
		let codex_home =
			env::var("AIQ_REAL_CODEX_HOME").expect("AIQ_REAL_CODEX_HOME must name Codex home");
		let permission_probe_binary = env::var("AIQ_REAL_PERMISSION_PROBE_BINARY")
			.expect("AIQ_REAL_PERMISSION_PROBE_BINARY must name aiq-runner");
		let suffix = std::time::SystemTime::now()
			.duration_since(std::time::UNIX_EPOCH)
			.expect("fixture clock")
			.as_nanos();
		let denied_root = PathBuf::from("/private/tmp")
			.join(format!("aiq-minimal-deny-{}-{suffix}", process::id()));
		let repository_root =
			fs::canonicalize(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."))
				.expect("canonical repository root");
		let safe_root = repository_root
			.join("target")
			.join(format!("aiq-minimal-safe-{}-{suffix}", process::id()));
		let workspace = safe_root.join("workspace");
		let allowed = workspace.join("allowed.txt");
		let denied = denied_root.join("denied.txt");
		let writable = workspace.join("writable.txt");

		fs::create_dir_all(&workspace).expect("safe workspace");
		fs::create_dir_all(&denied_root).expect("minimal denied root");
		fs::write(&allowed, b"AIQ_ALLOWED\n").expect("allowed fixture");
		fs::write(&denied, b"AIQ_DENIED\n").expect("denied fixture");

		let adapter = CodexAdapter::new(
			SystemExecutor,
			MemorySink::default(),
			codex_binary,
			CodexExecutionConfig::isolated(codex_home)
				.with_denied_roots(vec![
					fs::canonicalize(&denied_root).expect("canonical denied root"),
				])
				.with_permission_probe_executable(permission_probe_binary),
		);
		let result = adapter.verify_permission_boundary(
			&workspace,
			&allowed,
			slice::from_ref(&denied),
			&writable,
		);
		let expect_collision = env::var_os("AIQ_EXPECT_MINIMAL_PATH_COLLISION").is_some();
		let denied_cleanup = fs::remove_dir_all(&denied_root);
		let safe_cleanup = fs::remove_dir_all(&safe_root);

		match result {
			Ok(()) => assert!(
				!expect_collision,
				"the current Codex runtime unexpectedly stopped reproducing the declared collision"
			),
			Err(failure) => {
				assert!(matches!(
					failure.kind,
					AdapterFailureKind::Spawn | AdapterFailureKind::NonZeroExit
				));
				assert!(
					failure.message.contains("platform-minimal")
						|| failure.stderr.contains("a denied canary was readable")
				);
			},
		}

		denied_cleanup.expect("minimal fixture cleanup");
		safe_cleanup.expect("safe fixture cleanup");
	}

	#[test]
	fn large_stream_uses_artifact_sink_and_small_inline_preview() {
		let output = "x".repeat(MAX_INLINE_PREVIEW_BYTES + 1);
		let adapter = adapter(vec![Ok(capture(0, output.as_bytes().to_vec(), Vec::new()))]);
		let result = adapter.invoke(&invocation()).expect("capture must succeed");

		assert_eq!(result.stdout.len(), MAX_INLINE_PREVIEW_BYTES);
		assert_eq!(result.artifacts.len(), 1);
	}

	#[test]
	fn benchmark_invocation_always_retains_nonempty_stdout_for_verifier_replay() {
		let output =
			br#"{"type":"item.completed","item":{"id":"tool-1","type":"command_execution"}}"#;
		let adapter = adapter(vec![Ok(capture(0, output.to_vec(), Vec::new()))]);
		let result = adapter.invoke(&invocation()).expect("capture must succeed");

		assert_eq!(result.stdout.as_bytes(), &output[..MAX_INLINE_PREVIEW_BYTES]);
		assert_eq!(result.artifacts.len(), 1);
		assert_eq!(result.artifacts[0].kind, "stdout.jsonl");
		assert_eq!(adapter.sink.values.borrow().as_slice(), &[output.to_vec()]);
	}

	#[test]
	fn live_budget_breach_is_classified() {
		let mut exceeded = capture(1, Vec::new(), Vec::new());

		exceeded.budget_exceeded = Some(LiveBudgetKind::ToolCalls);

		let adapter = adapter(vec![Ok(exceeded)]);

		assert_eq!(
			adapter.invoke(&invocation()).expect_err("budget must fail").kind,
			AdapterFailureKind::BudgetExceeded
		);
	}

	#[test]
	fn subscription_usage_limit_has_a_stable_failure_kind() {
		let adapter = adapter(vec![Ok(capture(
			1,
			Vec::new(),
			b"You've hit your usage limit. Retry later.".to_vec(),
		))]);
		let failure = adapter.invoke(&invocation()).expect_err("usage limit must fail");

		assert_eq!(failure.kind, AdapterFailureKind::UsageLimit);
	}

	#[test]
	fn subscription_limit_subtypes_are_public_safe_for_both_streams() {
		for (stdout, stderr, expected) in [
			("rate limit reached", "", "Codex subscription rate limit was reached"),
			("", "insufficient quota", "Codex subscription quota was reached"),
			(
				"weighted tokens left: 0",
				"request stopped",
				"Codex subscription usage limit was reached",
			),
		] {
			let adapter = adapter(vec![Ok(capture(
				1,
				stdout.as_bytes().to_vec(),
				stderr.as_bytes().to_vec(),
			))]);
			let failure = adapter.invoke(&invocation()).expect_err("limit must fail");

			assert_eq!(failure.kind, AdapterFailureKind::UsageLimit);
			assert_eq!(failure.message, expected);
			assert!(stdout.is_empty() || !failure.message.contains(stdout));
			assert!(stderr.is_empty() || !failure.message.contains(stderr));
		}
	}

	#[test]
	fn preflight_failure_report_removes_inline_provider_text() {
		let secret = "usage limit for /private/operator prompt=do-not-persist";
		let mut captures = vec![
			Ok(capture(0, b"codex-cli current".to_vec(), Vec::new())),
			Ok(capture(0, b"Logged in using ChatGPT".to_vec(), Vec::new())),
		];

		captures.extend(
			(0..MODEL_MATRIX.len()).map(|_| Ok(capture(1, Vec::new(), secret.as_bytes().to_vec()))),
		);

		let report = adapter(captures)
			.validate_capabilities(&manifest(CapabilityStatus::Available, "codex-cli current"));
		let json = serde_json::to_string(&report).expect("report JSON");

		assert!(!json.contains(secret));
		assert!(!json.contains("/private/operator"));
		assert!(report.models.iter().all(|entry| {
			entry.probe.failure.as_ref().is_some_and(|failure| {
				failure.kind == AdapterFailureKind::UsageLimit && failure.is_normalized_preflight()
			})
		}));
	}

	#[test]
	fn ordinary_probe_failure_remains_unavailable_and_public_safe() {
		let provider_text = "provider failed for prompt at /private/operator";
		let mut captures = vec![
			Ok(capture(0, b"codex-cli current".to_vec(), Vec::new())),
			Ok(capture(0, b"Logged in using ChatGPT".to_vec(), Vec::new())),
		];

		captures.extend(
			(0..MODEL_MATRIX.len())
				.map(|_| Ok(capture(1, Vec::new(), provider_text.as_bytes().to_vec()))),
		);

		let report = adapter(captures)
			.validate_capabilities(&manifest(CapabilityStatus::Available, "codex-cli current"));
		let json = serde_json::to_string(&report).expect("report JSON");

		assert!(!report.is_usable());
		assert!(!json.contains(provider_text));
		assert!(report.models.iter().all(|entry| {
			entry.status == CapabilityValidationStatus::Unavailable
				&& entry.probe.failure.as_ref().is_some_and(|failure| {
					failure.kind == AdapterFailureKind::NonZeroExit
						&& failure.is_normalized_preflight()
				})
		}));
	}

	#[test]
	fn stale_unsupported_claim_never_produces_not_applicable() {
		let captures = vec![
			Ok(capture(0, b"codex-cli current".to_vec(), Vec::new())),
			Ok(capture(0, b"Logged in using ChatGPT".to_vec(), Vec::new())),
		];
		let adapter = adapter(captures);
		let report = adapter
			.validate_capabilities(&manifest(CapabilityStatus::Unsupported, "codex-cli stale"));

		assert_eq!(adapter.executor.requests.borrow().len(), 2);
		assert!(
			report
				.models
				.iter()
				.all(|entry| entry.status == CapabilityValidationStatus::Unavailable)
		);
		assert!(
			report
				.models
				.iter()
				.all(|entry| entry.probe.status == ConfigurationProbeStatus::Failed)
		);
	}

	#[test]
	fn only_active_unsupported_probe_can_yield_unsupported() {
		let mut captures = vec![
			Ok(capture(0, b"codex-cli current".to_vec(), Vec::new())),
			Ok(capture(0, b"Logged in using ChatGPT".to_vec(), Vec::new())),
		];

		captures.extend(
			(0..MODEL_MATRIX.len()).map(|_| Ok(capture(2, Vec::new(), b"unknown model".to_vec()))),
		);

		let adapter = adapter(captures);
		let report = adapter
			.validate_capabilities(&manifest(CapabilityStatus::Available, "codex-cli current"));

		assert!(
			report
				.models
				.iter()
				.all(|entry| entry.status == CapabilityValidationStatus::Unsupported)
		);
		assert!(report.is_usable());
	}

	#[test]
	fn chatgpt_login_status_on_stderr_allows_model_probes() {
		let mut captures = vec![
			Ok(capture(0, b"codex-cli current".to_vec(), Vec::new())),
			Ok(capture(0, Vec::new(), b"Logged in using ChatGPT".to_vec())),
		];

		captures.extend((0..MODEL_MATRIX.len()).map(|_| {
			Ok(capture(
				0,
				br#"{"type":"item.completed","item":{"type":"agent_message","text":"AIQ_PREFLIGHT_OK"}}"#
					.to_vec(),
				Vec::new(),
			))
		}));

		let adapter = adapter(captures);
		let report = adapter
			.validate_capabilities(&manifest(CapabilityStatus::Available, "codex-cli current"));

		assert_eq!(report.authentication_probe.status, super::ProbeStatus::Available);
		assert!(
			report.models.iter().all(|entry| entry.status == CapabilityValidationStatus::Available)
		);
	}

	#[test]
	fn api_key_or_unknown_login_mode_blocks_model_probes() {
		for login in ["Logged in using an API key", "mystery auth mode"] {
			let adapter = adapter(vec![
				Ok(capture(0, b"codex-cli current".to_vec(), Vec::new())),
				Ok(capture(0, login.as_bytes().to_vec(), Vec::new())),
			]);
			let report = adapter
				.validate_capabilities(&manifest(CapabilityStatus::Available, "codex-cli current"));

			assert_eq!(adapter.executor.requests.borrow().len(), 2);
			assert_eq!(report.authentication_probe.status, super::ProbeStatus::Unavailable);
			assert!(
				report
					.models
					.iter()
					.all(|entry| entry.status == CapabilityValidationStatus::Unavailable)
			);
		}
	}

	#[test]
	fn invalid_manifest_blocks_configuration_probes() {
		let adapter = adapter(vec![
			Ok(capture(0, b"codex-cli current".to_vec(), Vec::new())),
			Ok(capture(0, b"Logged in using ChatGPT".to_vec(), Vec::new())),
		]);
		let mut invalid = manifest(CapabilityStatus::Available, "codex-cli current");

		invalid.models.pop();

		let report = adapter.validate_capabilities(&invalid);

		assert_eq!(adapter.executor.requests.borrow().len(), 2);
		assert!(!report.manifest_issues.is_empty());
		assert!(
			report
				.models
				.iter()
				.all(|entry| entry.status == CapabilityValidationStatus::Unavailable)
		);
	}

	#[test]
	fn manifest_identity_time_and_unsupported_reasons_are_structural() {
		let mut invalid = manifest(CapabilityStatus::Unsupported, "codex-cli current");

		invalid.node_id = "local-example".to_owned();
		invalid.observed_at = "fixture".to_owned();
		invalid.models[0].reason = Some(" ".to_owned());

		let issues = super::validate_capability_manifest(&invalid);

		assert!(issues.iter().any(|issue| issue.starts_with("node_id")));
		assert!(issues.iter().any(|issue| issue.starts_with("observed_at")));
		assert!(issues.iter().any(|issue| issue.contains("nonempty reason")));
	}

	#[test]
	fn packaged_capability_manifest_has_the_complete_valid_matrix_shape() {
		let manifest: CapabilityManifest =
			serde_json::from_str(include_str!("../../../config/capabilities.example.json"))
				.expect("packaged capability manifest must parse");

		assert_eq!(manifest.models.len(), MODEL_MATRIX.len());
		assert!(super::validate_capability_manifest(&manifest).is_empty());
		assert!(manifest.models.iter().all(|claim| claim.status == CapabilityStatus::Unsupported));
	}

	#[test]
	fn child_event_emitter() {
		if env::var("AIQ_CHILD_NO_STDIN").as_deref() == Ok("1") {
			thread::sleep(Duration::from_secs(2));

			return;
		}
		if env::var("AIQ_CHILD_EVENT_EMITTER").as_deref() != Ok("1") {
			return;
		}

		println!();

		let item_type =
			env::var("AIQ_CHILD_ITEM_TYPE").unwrap_or_else(|_| "command_execution".to_owned());
		let event =
			format!(r#"{{"type":"item.started","item":{{"id":"tool-1","type":"{item_type}"}}}}"#);

		println!("{event}");

		io::stdout().flush().expect("child output must flush");
		thread::sleep(Duration::from_secs(2));
	}

	#[test]
	#[allow(clippy::zombie_processes)]
	fn json_rpc_process_fixture() {
		let Ok(role) = env::var("AIQ_JSON_RPC_FIXTURE_ROLE") else {
			return;
		};

		// Libtest writes the test label without a trailing newline before it
		// invokes this fixture. End that diagnostic line so each JSON-RPC
		// response starts at the beginning of its own JSONL record.
		println!();

		io::stdout().flush().expect("fixture line separator must flush");

		match role.as_str() {
			"blocked_stdin" => thread::sleep(Duration::from_secs(2)),
			"complete_then_exit" => {
				println!(r#"{{"id":1,"result":{{"ok":true}}}}"#);

				io::stdout().flush().expect("complete response must flush");
			},
			"incomplete_then_exit" => {
				println!(r#"{{"id":2,"result":{{"ok":true}}}}"#);

				io::stdout().flush().expect("incomplete response must flush");
			},
			"response_requires_open_stdin" => {
				let mut first = [0_u8; 1];
				let mut stdin = io::stdin();

				stdin.read_exact(&mut first).expect("fixture input byte");

				let (eof_tx, eof_rx) = mpsc::channel();

				thread::spawn(move || {
					let mut next = [0_u8; 1];
					let _ = eof_tx.send(stdin.read(&mut next));
				});

				match eof_rx.recv_timeout(Duration::from_millis(100)) {
					Err(mpsc::RecvTimeoutError::Timeout) => {
						println!(r#"{{"id":1,"result":{{"stdin_open":true}}}}"#);

						io::stdout().flush().expect("open-stdin response must flush");
					},
					Ok(Ok(0)) => process::exit(45),
					Ok(Ok(_)) | Ok(Err(_)) | Err(mpsc::RecvTimeoutError::Disconnected) => {
						process::exit(46);
					},
				}
			},
			"oversized_line" => {
				let chunk = [b'x'; 8_192];
				let mut stdout = io::stdout().lock();

				for _ in 0..16 {
					if stdout.write_all(&chunk).is_err() {
						break;
					}
				}

				let _ = stdout.flush();

				thread::sleep(Duration::from_secs(2));
			},
			"many_lines" => {
				let mut stdout = io::stdout().lock();

				for _ in 0..32_768 {
					if stdout.write_all(b"{}\n").is_err() {
						break;
					}
				}

				let _ = stdout.flush();

				thread::sleep(Duration::from_secs(2));
			},
			"oversized_stderr_then_response" => {
				let chunk = [b'e'; 8_192];
				let mut stderr = io::stderr().lock();

				for _ in 0..16 {
					if stderr.write_all(&chunk).is_err() {
						break;
					}
				}

				let _ = stderr.flush();

				println!(r#"{{"id":1,"result":{{"ok":true}}}}"#);

				io::stdout().flush().expect("JSON-RPC response must flush");
				thread::sleep(Duration::from_secs(2));
			},
			"same_group_descendant" => thread::sleep(Duration::from_secs(30)),
			"response_then_exit_with_same_group_descendant" => {
				#[cfg(unix)]
				json_rpc_same_group_descendant_fixture();
			},
			"response_with_escaped_pipe" => {
				#[cfg(unix)]
				json_rpc_escaped_pipe_fixture();
			},
			"escaped_pipe_holder" => thread::sleep(Duration::from_secs(30)),
			"descriptor_probe" => {
				json_rpc_descriptor_probe_fixture();
			},
			_ => process::exit(43),
		}
	}

	fn json_rpc_descriptor_probe_fixture() {
		#[cfg(unix)]
		{
			let descriptor = env::var("AIQ_AMBIENT_DESCRIPTOR")
				.expect("ambient descriptor")
				.parse::<i32>()
				.expect("descriptor number");
			// SAFETY: `fcntl(F_GETFD)` only inspects the supplied descriptor in
			// this disposable child.
			let inherited = unsafe { libc::fcntl(descriptor, libc::F_GETFD) } >= 0;

			if inherited {
				process::exit(42);
			}
		}

		println!(r#"{{"id":1,"result":{{"inherited":false}}}}"#);

		io::stdout().flush().expect("descriptor result must flush");
	}

	#[cfg(unix)]
	fn json_rpc_same_group_descendant_fixture() -> ! {
		let executable = env::current_exe().expect("test executable");
		let descendant = Command::new(executable)
			.args(["--exact", "adapter::tests::json_rpc_process_fixture", "--nocapture"])
			.env_clear()
			.env("AIQ_JSON_RPC_FIXTURE_ROLE", "same_group_descendant")
			.stdin(Stdio::null())
			.stdout(Stdio::null())
			.stderr(Stdio::null())
			.spawn()
			.expect("same-group descendant fixture must start");

		println!(r#"{{"id":1,"result":{{"descendant_pid":{}}}}}"#, descendant.id());

		io::stdout().flush().expect("JSON-RPC response must flush");
		process::exit(0);
	}

	#[cfg(unix)]
	#[allow(clippy::zombie_processes)]
	fn json_rpc_escaped_pipe_fixture() -> ! {
		// SAFETY: The query only reads the process group of this fixture's parent.
		let parent_group = unsafe { libc::getpgid(libc::getppid()) };

		assert!(parent_group > 0, "test parent process group");

		let pid_path = env::var_os("AIQ_ESCAPED_PID_PATH").expect("escaped PID path");
		let executable = env::current_exe().expect("test executable");
		let mut command = Command::new(executable);

		command
			.args(["--exact", "adapter::tests::json_rpc_process_fixture", "--nocapture"])
			.env_clear()
			.env("AIQ_JSON_RPC_FIXTURE_ROLE", "escaped_pipe_holder")
			.stdin(Stdio::null())
			.stdout(Stdio::inherit())
			.stderr(Stdio::null())
			.process_group(parent_group);

		let escaped = command.spawn().expect("escaped pipe holder must start");

		fs::write(pid_path, escaped.id().to_string()).expect("escaped PID fixture");

		println!(r#"{{"id":1,"result":{{"ok":true}}}}"#);

		io::stdout().flush().expect("JSON-RPC response must flush");
		thread::sleep(Duration::from_secs(30));
		process::exit(44);
	}

	#[test]
	fn codex_json_lines_normalize_versioned_items_and_bound_unknowns() {
		let cases = [
			(
				r#"{"type":"item.started","item":{"id":"cmd-1","type":"command_execution","command":"pwd"}}"#,
				Some((CodexItemPhase::Started, "command_execution", true)),
			),
			(
				r#"{"type":"item.completed","item":{"id":"patch-1","type":"file_change","changes":[{"path":"src/lib.rs","kind":"update"}],"status":"completed"}}"#,
				Some((CodexItemPhase::Completed, "file_change", true)),
			),
			(
				r#"{"type":"item.completed","item":{"id":"mcp-1","type":"mcp_tool_call","server":"docs","tool":"search","status":"completed"}}"#,
				Some((CodexItemPhase::Completed, "mcp_tool_call", true)),
			),
			(
				r#"{"type":"item.completed","item":{"id":"web-1","type":"web_search","query":"Rust process groups"}}"#,
				Some((CodexItemPhase::Completed, "web_search", true)),
			),
			(
				r#"{"type":"item.completed","item":{"id":"message-1","type":"agent_message","text":"done"}}"#,
				Some((CodexItemPhase::Completed, "agent_message", false)),
			),
			(
				r#"{"type":"item.completed","item":{"id":"future-1","type":"future_tool","payload":{}}}"#,
				Some((CodexItemPhase::Completed, "future_tool", true)),
			),
			(r#"{"type":"turn.completed","usage":{"input_tokens":1}}"#, None),
			(r#"{"type":"item.completed","item":{"text":"missing type"}}"#, None),
			(r#"not-json"#, None),
		];

		for (line, expected) in cases {
			let actual = crate::adapter::normalize_codex_item(line.as_bytes());

			assert_eq!(
				actual.as_ref().map(|item| (item.phase, item.raw_type.as_str(), item.is_tool_call)),
				expected,
				"{line}"
			);

			if let Some(item) = actual {
				assert_eq!(item.version, CODEX_ITEM_ACCOUNTING_VERSION);
			}
		}
	}

	#[test]
	fn live_accounting_counts_each_tool_once_and_completed_only_file_changes() {
		let mut accounting = LiveItemAccounting::default();

		for line in [
			r#"{"type":"item.started","item":{"id":"cmd-1","type":"command_execution"}}"#,
			r#"{"type":"item.completed","item":{"id":"cmd-1","type":"command_execution"}}"#,
			r#"{"type":"item.completed","item":{"id":"patch-1","type":"file_change"}}"#,
			r#"{"type":"item.completed","item":{"id":"message-1","type":"agent_message","text":"ok"}}"#,
		] {
			accounting.observe(line.as_bytes());
		}

		assert_eq!(accounting.steps, 3);
		assert_eq!(accounting.tool_calls, 2);
	}

	#[cfg(unix)]
	#[test]
	#[allow(clippy::zombie_processes)]
	fn process_tree_fixture() {
		let Ok(role) = env::var("AIQ_PROCESS_TREE_ROLE") else {
			return;
		};

		println!();

		if matches!(role.as_str(), "parent" | "budget_parent") {
			let executable = env::current_exe().expect("test executable");
			let descendant = Command::new(executable)
				.args(["--exact", "adapter::tests::process_tree_fixture", "--nocapture"])
				.env_clear()
				.env("AIQ_PROCESS_TREE_ROLE", "descendant")
				.stdin(Stdio::null())
				.spawn()
				.expect("descendant must start");

			if let Some(pid_path) = env::var_os("AIQ_PROCESS_TREE_PID_PATH") {
				fs::write(pid_path, descendant.id().to_string())
					.expect("descendant PID file must be written");
			}

			println!("AIQ_DESCENDANT_PID={}", descendant.id());

			if role == "budget_parent" {
				println!(r#"{{"type":"item.started","item":{{"type":"command_execution"}}}}"#);
			}

			io::stdout().flush().expect("descendant PID must flush");
		}

		thread::sleep(Duration::from_secs(30));
	}

	#[cfg(unix)]
	#[test]
	fn system_executor_timeout_kills_same_group_descendants_that_retain_output_pipes() {
		let executable = env::current_exe().expect("test executable");
		let pid_path = env::temp_dir().join(format!(
			"aiq-process-tree-timeout-{}-{}",
			process::id(),
			PROCESS_FIXTURE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
		));
		let started = Instant::now();
		let capture = SystemExecutor
			.execute(&CommandRequest {
				program: executable.display().to_string(),
				args: vec![
					"--exact".to_owned(),
					"adapter::tests::process_tree_fixture".to_owned(),
					"--nocapture".to_owned(),
				],
				stdin: Vec::new(),
				timeout: Duration::from_millis(100),
				max_capture_bytes: 16 * 1_024,
				max_steps: u32::MAX,
				max_tool_calls: u32::MAX,
				clear_environment: true,
				environment: BTreeMap::from([
					("AIQ_PROCESS_TREE_ROLE".to_owned(), "parent".to_owned()),
					("AIQ_PROCESS_TREE_PID_PATH".to_owned(), pid_path.display().to_string()),
				]),
			})
			.expect("executor must return after terminating the process group");

		assert!(capture.timed_out);
		assert!(started.elapsed() < Duration::from_secs(2));

		let descendant = fs::read_to_string(&pid_path)
			.expect("fixture must report its descendant")
			.parse::<i32>()
			.expect("descendant PID must be numeric");

		assert_process_exits(descendant);

		fs::remove_file(pid_path).expect("descendant PID fixture cleanup");
	}

	#[cfg(unix)]
	#[test]
	fn system_executor_budget_breach_kills_same_group_descendants_that_retain_output_pipes() {
		let executable = env::current_exe().expect("test executable");
		let pid_path = env::temp_dir().join(format!(
			"aiq-process-tree-budget-{}-{}",
			process::id(),
			PROCESS_FIXTURE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
		));
		let started = Instant::now();
		let capture = SystemExecutor
			.execute(&CommandRequest {
				program: executable.display().to_string(),
				args: vec![
					"--exact".to_owned(),
					"adapter::tests::process_tree_fixture".to_owned(),
					"--nocapture".to_owned(),
				],
				stdin: Vec::new(),
				timeout: Duration::from_secs(5),
				max_capture_bytes: 16 * 1_024,
				max_steps: u32::MAX,
				max_tool_calls: 0,
				clear_environment: true,
				environment: BTreeMap::from([
					("AIQ_PROCESS_TREE_ROLE".to_owned(), "budget_parent".to_owned()),
					("AIQ_PROCESS_TREE_PID_PATH".to_owned(), pid_path.display().to_string()),
				]),
			})
			.expect("executor must return after terminating the process group");

		assert_eq!(capture.budget_exceeded, Some(LiveBudgetKind::ToolCalls));
		assert!(started.elapsed() < Duration::from_secs(2));

		let descendant = fs::read_to_string(&pid_path)
			.expect("fixture must report its descendant")
			.parse::<i32>()
			.expect("descendant PID must be numeric");

		assert_process_exits(descendant);

		fs::remove_file(pid_path).expect("descendant PID fixture cleanup");
	}

	fn json_rpc_fixture_request(
		role: &str,
		stdin: Vec<u8>,
		timeout: Duration,
		max_capture_bytes: usize,
	) -> CommandRequest {
		let executable = env::current_exe().expect("test executable");

		CommandRequest {
			program: executable.display().to_string(),
			args: vec![
				"--exact".to_owned(),
				"adapter::tests::json_rpc_process_fixture".to_owned(),
				"--nocapture".to_owned(),
			],
			stdin,
			timeout,
			max_capture_bytes,
			max_steps: u32::MAX,
			max_tool_calls: u32::MAX,
			clear_environment: true,
			environment: BTreeMap::from([(
				"AIQ_JSON_RPC_FIXTURE_ROLE".to_owned(),
				role.to_owned(),
			)]),
		}
	}

	#[test]
	fn json_rpc_deadline_includes_blocked_stdin_delivery() {
		let request = json_rpc_fixture_request(
			"blocked_stdin",
			vec![b'x'; super::MAX_STDIN_BYTES],
			Duration::from_millis(100),
			16 * 1_024,
		);
		let started = Instant::now();
		let error = SystemExecutor
			.execute_json_rpc(&request, &[1])
			.expect_err("blocked JSON-RPC input must reach the deadline");

		assert!(error.to_string().contains("response deadline"));
		assert!(started.elapsed() < Duration::from_secs(2));
	}

	#[test]
	fn json_rpc_stdout_without_newline_is_bounded_before_parsing() {
		let request = json_rpc_fixture_request(
			"oversized_line",
			Vec::new(),
			Duration::from_secs(2),
			16 * 1_024,
		);
		let started = Instant::now();
		let error = SystemExecutor
			.execute_json_rpc(&request, &[1])
			.expect_err("an oversized JSON-RPC line must fail closed");

		assert!(error.to_string().contains("stdout exceeded the safe capture limit"));
		assert!(started.elapsed() < Duration::from_secs(2));
	}

	#[test]
	fn json_rpc_many_small_lines_use_the_same_aggregate_bound() {
		let request =
			json_rpc_fixture_request("many_lines", Vec::new(), Duration::from_secs(2), 16 * 1_024);
		let started = Instant::now();
		let error = SystemExecutor
			.execute_json_rpc(&request, &[1])
			.expect_err("many JSON-RPC lines must not bypass the aggregate bound");

		assert!(error.to_string().contains("stdout exceeded the safe capture limit"));
		assert!(started.elapsed() < Duration::from_secs(2));
	}

	#[test]
	fn json_rpc_stderr_limit_cannot_race_a_successful_response() {
		let request = json_rpc_fixture_request(
			"oversized_stderr_then_response",
			Vec::new(),
			Duration::from_secs(2),
			16 * 1_024,
		);
		let started = Instant::now();
		let error = SystemExecutor
			.execute_json_rpc(&request, &[1])
			.expect_err("oversized JSON-RPC stderr must fail closed");

		assert!(
			error.to_string().contains("stderr exceeded the safe capture limit")
				|| error.to_string().contains("stderr was truncated"),
			"{error}"
		);
		assert!(started.elapsed() < Duration::from_secs(2));
	}

	#[test]
	fn buffered_complete_response_wins_before_a_following_end_event() {
		let request = json_rpc_fixture_request(
			"complete_then_exit",
			Vec::new(),
			Duration::from_secs(1),
			16 * 1_024,
		);
		let (stdout_tx, stdout_rx) = mpsc::sync_channel(2);
		let (_breach_tx, breach_rx) = mpsc::channel();
		let (_stdin_tx, stdin_rx) = mpsc::channel();

		stdout_tx
			.send(super::JsonRpcStdoutEvent::Chunk(
				b"{\"id\":1,\"result\":{\"ok\":true}}\n".to_vec(),
			))
			.expect("buffered complete response");
		stdout_tx.send(super::JsonRpcStdoutEvent::End).expect("buffered end event");

		let outcome = super::receive_json_rpc_responses(
			&request,
			&[1],
			Instant::now(),
			&stdout_rx,
			&breach_rx,
			&stdin_rx,
		);

		assert_eq!(outcome.failure, None);
		assert_eq!(outcome.captured, b"{\"id\":1,\"result\":{\"ok\":true}}\n");
	}

	#[test]
	fn immediate_leader_exit_preserves_its_complete_response() {
		let request = json_rpc_fixture_request(
			"complete_then_exit",
			Vec::new(),
			Duration::from_secs(1),
			16 * 1_024,
		);
		let capture = SystemExecutor
			.execute_json_rpc(&request, &[1])
			.expect("complete response must survive immediate leader exit");

		assert!(capture.stdout.windows(b"\"id\":1".len()).any(|bytes| bytes == b"\"id\":1"));
	}

	#[test]
	fn json_rpc_keeps_stdin_open_until_the_expected_response() {
		let request = json_rpc_fixture_request(
			"response_requires_open_stdin",
			vec![b'x'],
			Duration::from_secs(1),
			16 * 1_024,
		);
		let capture = SystemExecutor
			.execute_json_rpc(&request, &[1])
			.expect("JSON-RPC stdin must remain open until the response");

		assert!(
			capture
				.stdout
				.windows(b"\"stdin_open\":true".len())
				.any(|bytes| bytes == b"\"stdin_open\":true")
		);
	}

	#[test]
	fn immediate_leader_exit_with_an_incomplete_response_fails_closed() {
		let request = json_rpc_fixture_request(
			"incomplete_then_exit",
			Vec::new(),
			Duration::from_secs(1),
			16 * 1_024,
		);
		let error = SystemExecutor
			.execute_json_rpc(&request, &[1])
			.expect_err("missing expected response must fail closed");

		assert!(error.to_string().contains("closed stdout before all responses"), "{error}");
	}

	#[cfg(unix)]
	#[test]
	fn json_rpc_thread_spawn_failures_reap_the_spawned_child() {
		for failure_index in 0..3 {
			super::force_process_thread_spawn_failure_for_test(failure_index);

			let request = json_rpc_fixture_request(
				"blocked_stdin",
				Vec::new(),
				Duration::from_secs(5),
				16 * 1_024,
			);
			let started = Instant::now();
			let error = SystemExecutor
				.execute_json_rpc(&request, &[1])
				.expect_err("forced JSON-RPC thread creation failure must fail closed");
			let child_pid = super::take_last_json_rpc_child_pid_for_test()
				.and_then(|pid| i32::try_from(pid).ok())
				.expect("JSON-RPC fixture PID");

			assert!(error.to_string().contains("forced process thread spawn failure"));

			assert_process_exits(child_pid);

			assert!(started.elapsed() < Duration::from_secs(2));
		}
	}

	#[cfg(target_os = "linux")]
	#[test]
	fn json_rpc_process_group_escape_is_bounded_reported_and_explicitly_reaped() {
		let mut fixture = Command::new(env::current_exe().expect("test executable"));

		fixture
			.args([
				"--exact",
				"adapter::tests::json_rpc_escaped_pipe_subreaper_fixture",
				"--nocapture",
			])
			.env_clear()
			.env("AIQ_RUN_ESCAPED_PIPE_SUBREAPER", "1")
			.stdin(Stdio::null())
			.stdout(Stdio::null())
			.stderr(Stdio::null());

		let started = Instant::now();
		let mut fixture = fixture.spawn().expect("isolated escaped-pipe fixture");
		let status = loop {
			if let Some(status) = fixture.try_wait().expect("escaped-pipe fixture status") {
				break status;
			}

			if started.elapsed() >= Duration::from_secs(3) {
				fixture.kill().expect("stop stalled escaped-pipe fixture");

				let _ = fixture.wait();

				panic!("escaped-pipe fixture exceeded its bounded deadline");
			}

			thread::sleep(Duration::from_millis(5));
		};

		assert!(status.success(), "isolated escaped-pipe fixture must pass");
		assert!(started.elapsed() < Duration::from_secs(3));
	}

	#[cfg(target_os = "linux")]
	#[test]
	fn json_rpc_escaped_pipe_subreaper_fixture() {
		if env::var("AIQ_RUN_ESCAPED_PIPE_SUBREAPER").as_deref() != Ok("1") {
			return;
		}

		let mut previous_subreaper = 0_i32;

		// SAFETY: This disposable nested test process restores its prior
		// subreaper setting after it exactly reaps the escaped descendant.
		assert_eq!(
			unsafe {
				libc::prctl(libc::PR_GET_CHILD_SUBREAPER, &raw mut previous_subreaper, 0, 0, 0)
			},
			0
		);
		assert_eq!(unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) }, 0);

		let pid_path = env::temp_dir().join(format!(
			"aiq-json-rpc-escaped-pid-{}-{}",
			process::id(),
			super::observation_time()
		));
		let mut request = json_rpc_fixture_request(
			"response_with_escaped_pipe",
			Vec::new(),
			Duration::from_secs(1),
			64 * 1_024,
		);

		request
			.environment
			.insert("AIQ_ESCAPED_PID_PATH".to_owned(), pid_path.display().to_string());

		super::force_json_rpc_stop_failure_for_test();

		let started = Instant::now();
		let result = SystemExecutor.execute_json_rpc(&request, &[1]);
		let escaped_pid = fs::read_to_string(&pid_path)
			.expect("escaped fixture PID")
			.parse::<i32>()
			.expect("escaped fixture numeric PID");

		// SAFETY: The PID belongs to the escaped descendant created beneath this
		// subreaper. The signal is exact, and the bounded wait reaps that child.
		assert_eq!(unsafe { libc::kill(escaped_pid, libc::SIGKILL) }, 0);

		let deadline = Instant::now() + Duration::from_secs(1);
		let mut status = 0;
		let reaped = loop {
			let reaped = unsafe { libc::waitpid(escaped_pid, &mut status, libc::WNOHANG) };

			if reaped == escaped_pid {
				break reaped;
			}

			assert_eq!(reaped, 0, "escaped fixture must remain waitable by the subreaper");
			assert!(Instant::now() < deadline, "escaped fixture reap exceeded its deadline");

			thread::sleep(Duration::from_millis(1));
		};

		fs::remove_file(&pid_path).expect("escaped PID fixture cleanup");

		assert_eq!(
			unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, previous_subreaper, 0, 0, 0) },
			0
		);
		assert_eq!(reaped, escaped_pid, "escaped fixture must be reaped exactly");

		let message = result.expect_err("escaped retained pipe must fail closed").to_string();

		assert!(
			message.contains("stdout remained open after process-group termination"),
			"{message}"
		);
		assert!(message.contains("forced JSON-RPC cleanup failure"), "{message}");
		assert!(started.elapsed() < Duration::from_secs(2));
	}

	#[cfg(unix)]
	#[test]
	fn json_rpc_reaps_same_group_descendants_after_the_leader_exits() {
		let request = json_rpc_fixture_request(
			"response_then_exit_with_same_group_descendant",
			Vec::new(),
			Duration::from_secs(1),
			64 * 1_024,
		);
		let capture = SystemExecutor
			.execute_json_rpc(&request, &[1])
			.expect("the final response must be captured before group cleanup");
		let descendant = String::from_utf8(capture.stdout)
			.expect("fixture output must be UTF-8")
			.lines()
			.filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
			.find_map(|value| value["result"]["descendant_pid"].as_i64())
			.and_then(|pid| i32::try_from(pid).ok())
			.expect("fixture must report its same-group descendant");

		assert_process_exits(descendant);
	}

	#[cfg(unix)]
	#[test]
	fn system_and_json_rpc_children_scrub_ambient_inheritable_descriptors() {
		let path = env::temp_dir().join(format!(
			"aiq-ambient-descriptor-{}-{}",
			process::id(),
			super::observation_time()
		));
		let file = fs::File::create(&path).expect("ambient descriptor fixture");
		let descriptor = file.as_raw_fd();
		// SAFETY: The descriptor is owned by `file` for the duration of this
		// test, and both operations only update its close-on-exec flag.
		let flags = unsafe { libc::fcntl(descriptor, libc::F_GETFD) };

		assert!(flags >= 0);
		// SAFETY: See the ownership argument above.
		assert_eq!(unsafe { libc::fcntl(descriptor, libc::F_SETFD, flags & !libc::FD_CLOEXEC) }, 0);

		let mut request = json_rpc_fixture_request(
			"descriptor_probe",
			Vec::new(),
			Duration::from_secs(1),
			16 * 1_024,
		);

		request.environment.insert("AIQ_AMBIENT_DESCRIPTOR".to_owned(), descriptor.to_string());

		let system_capture =
			SystemExecutor.execute(&request).expect("system child descriptor scrub");

		assert_eq!(system_capture.exit_code, Some(0));

		let json_rpc_fast_capture = SystemExecutor
			.execute_json_rpc(&request, &[1])
			.expect("JSON-RPC child fast descriptor scrub");

		#[cfg(target_os = "linux")]
		process_group::force_close_range_fallback_for_test();

		let json_rpc_fallback_capture = SystemExecutor
			.execute_json_rpc(&request, &[1])
			.expect("JSON-RPC child fallback descriptor scrub");

		for capture in [json_rpc_fast_capture, json_rpc_fallback_capture] {
			assert!(
				capture
					.stdout
					.windows(b"\"inherited\":false".len())
					.any(|bytes| bytes == b"\"inherited\":false")
			);
		}

		// The child-side scrub must not mutate the parent's descriptor flags.
		assert_eq!(unsafe { libc::fcntl(descriptor, libc::F_GETFD) } & libc::FD_CLOEXEC, 0);

		drop(file);

		fs::remove_file(path).expect("ambient descriptor cleanup");
	}

	#[cfg(unix)]
	fn assert_process_exits(pid: i32) {
		let deadline = Instant::now() + Duration::from_secs(1);

		loop {
			// SAFETY: Signal zero performs an existence check and does not modify the
			// process. The PID came from the descendant created by this test.
			let result = unsafe { libc::kill(pid, 0) };

			if result == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
				return;
			}

			assert!(Instant::now() < deadline, "descendant {pid} remained after group termination");

			thread::sleep(Duration::from_millis(5));
		}
	}

	#[test]
	fn system_executor_deadline_includes_blocked_stdin_delivery() {
		let executable = env::current_exe().expect("test executable");
		let started = std::time::Instant::now();
		let capture = SystemExecutor
			.execute(&CommandRequest {
				program: executable.display().to_string(),
				args: vec![
					"--exact".to_owned(),
					"adapter::tests::child_event_emitter".to_owned(),
					"--nocapture".to_owned(),
				],
				stdin: vec![b'x'; super::MAX_STDIN_BYTES],
				timeout: Duration::from_millis(100),
				max_capture_bytes: 16 * 1_024,
				max_steps: 1,
				max_tool_calls: 0,
				clear_environment: true,
				environment: BTreeMap::from([("AIQ_CHILD_NO_STDIN".to_owned(), "1".to_owned())]),
			})
			.expect("executor must observe the child");

		assert!(capture.timed_out);
		assert!(started.elapsed() < Duration::from_secs(2));
	}

	#[test]
	fn system_executor_thread_spawn_failures_reap_the_spawned_child() {
		let executable = env::current_exe().expect("test executable");

		for failure_index in 0..3 {
			super::force_process_thread_spawn_failure_for_test(failure_index);

			let observer = RecordingChildObserver::default();
			let started = Instant::now();
			let error = SystemExecutor
				.execute_observed(
					&CommandRequest {
						program: executable.display().to_string(),
						args: vec![
							"--exact".to_owned(),
							"adapter::tests::child_event_emitter".to_owned(),
							"--nocapture".to_owned(),
						],
						stdin: Vec::new(),
						timeout: Duration::from_secs(5),
						max_capture_bytes: 16 * 1_024,
						max_steps: u32::MAX,
						max_tool_calls: u32::MAX,
						clear_environment: true,
						environment: BTreeMap::from([(
							"AIQ_CHILD_NO_STDIN".to_owned(),
							"1".to_owned(),
						)]),
					},
					&observer,
				)
				.expect_err("forced thread creation failure must fail closed");
			let spawned = observer.spawned.load(Ordering::SeqCst);

			assert!(error.to_string().contains("forced process thread spawn failure"));
			assert_ne!(spawned, 0, "the fixture child must reach the spawn boundary");
			assert_eq!(
				observer.reaped.load(Ordering::SeqCst),
				spawned,
				"the exact fixture child must be reaped before returning"
			);
			assert!(started.elapsed() < Duration::from_secs(2));
		}
	}

	#[test]
	fn system_executor_kills_on_started_tool_before_completion() {
		let executable = env::current_exe().expect("test executable");
		let capture = SystemExecutor
			.execute(&CommandRequest {
				program: executable.display().to_string(),
				args: vec![
					"--exact".to_owned(),
					"adapter::tests::child_event_emitter".to_owned(),
					"--nocapture".to_owned(),
				],
				stdin: Vec::new(),
				timeout: Duration::from_secs(5),
				max_capture_bytes: 16 * 1_024,
				max_steps: 1,
				max_tool_calls: 0,
				clear_environment: true,
				environment: BTreeMap::from([(
					"AIQ_CHILD_EVENT_EMITTER".to_owned(),
					"1".to_owned(),
				)]),
			})
			.expect("executor must observe the child");

		assert_eq!(capture.budget_exceeded, Some(LiveBudgetKind::ToolCalls));
		assert!(!capture.timed_out);
	}

	#[test]
	fn system_executor_file_change_cannot_bypass_the_live_tool_budget() {
		let executable = env::current_exe().expect("test executable");
		let capture = SystemExecutor
			.execute(&CommandRequest {
				program: executable.display().to_string(),
				args: vec![
					"--exact".to_owned(),
					"adapter::tests::child_event_emitter".to_owned(),
					"--nocapture".to_owned(),
				],
				stdin: Vec::new(),
				timeout: Duration::from_secs(5),
				max_capture_bytes: 16 * 1_024,
				max_steps: 1,
				max_tool_calls: 0,
				clear_environment: true,
				environment: BTreeMap::from([
					("AIQ_CHILD_EVENT_EMITTER".to_owned(), "1".to_owned()),
					("AIQ_CHILD_ITEM_TYPE".to_owned(), "file_change".to_owned()),
				]),
			})
			.expect("executor must observe the child");

		assert_eq!(capture.budget_exceeded, Some(LiveBudgetKind::ToolCalls));
		assert!(!capture.timed_out);
	}

	#[test]
	fn local_artifact_sink_rejects_existing_content_substitution() {
		let root = env::temp_dir().join(format!(
			"aiq-artifact-sink-{}-{}",
			process::id(),
			super::observation_time()
		));
		let sink = LocalArtifactSink::new(&root).expect("sink root");
		let reference = sink.put("stdout.jsonl", b"original").expect("first write");
		let digest = reference.content_hash.trim_start_matches("sha256:");

		fs::write(root.join(digest).join("stdout.jsonl"), b"changed")
			.expect("fixture substitution");

		assert!(sink.put("stdout.jsonl", b"original").is_err());

		fs::remove_dir_all(&root).expect("fixture cleanup");
	}

	#[test]
	fn synthetic_chatgpt_account_identity_is_stable_and_public_safe() {
		let root = synthetic_auth_fixture(
			"account-synthetic-0123456789abcdef",
			"account-synthetic-0123456789abcdef",
		);
		let first =
			super::chatgpt_credential_observation_for_test(&root).expect("account identity");
		let second =
			super::chatgpt_credential_observation_for_test(&root).expect("stable account identity");

		assert_eq!(first, second);
		assert!(first.credential_digest.starts_with("sha256:"));
		assert!(first.account_claim_digest.starts_with("sha256:"));

		let public = format!("{first:?}");

		assert!(!public.contains("account-synthetic"));
		assert!(!public.contains("user-synthetic"));
		assert!(!public.contains("synthetic-access-token"));

		fs::remove_dir_all(root).expect("auth fixture cleanup");
	}

	#[test]
	fn synthetic_chatgpt_account_identity_fails_closed_on_claim_mismatch() {
		let root = synthetic_auth_fixture(
			"account-synthetic-0123456789abcdef",
			"account-other-0123456789abcdef00",
		);
		let error = super::chatgpt_credential_observation_for_test(&root)
			.expect_err("mismatched account bindings must fail");

		assert!(!error.to_string().contains("account-synthetic"));
		assert!(!error.to_string().contains("account-other"));

		fs::remove_dir_all(root).expect("auth fixture cleanup");
	}

	#[cfg(unix)]
	#[test]
	fn synthetic_chatgpt_account_identity_detects_file_replacement_and_account_drift() {
		let root = synthetic_auth_fixture(
			"account-synthetic-0123456789abcdef",
			"account-synthetic-0123456789abcdef",
		);
		let replacement = synthetic_auth_fixture(
			"account-replacement-0123456789abcdef",
			"account-replacement-0123456789abcdef",
		);
		let authorized = super::chatgpt_credential_observation_for_test(&root)
			.expect("authorized account identity");

		fs::rename(replacement.join("auth.json"), root.join("auth.json"))
			.expect("replace controlled auth file");

		let observed = super::chatgpt_credential_observation_for_test(&root)
			.expect("replacement account identity");

		assert_ne!(authorized, observed);
		assert!(!format!("{observed:?}").contains("account-replacement"));

		fs::remove_dir_all(root).expect("auth fixture cleanup");
		fs::remove_dir_all(replacement).expect("replacement fixture cleanup");
	}

	#[cfg(unix)]
	#[test]
	fn synthetic_chatgpt_account_identity_rejects_hard_linked_auth_file() {
		let root = synthetic_auth_fixture(
			"account-synthetic-0123456789abcdef",
			"account-synthetic-0123456789abcdef",
		);

		fs::hard_link(root.join("auth.json"), root.join("auth.backup"))
			.expect("hard-linked auth fixture");

		assert!(super::chatgpt_credential_observation_for_test(&root).is_err());

		fs::remove_dir_all(root).expect("auth fixture cleanup");
	}

	#[cfg(target_os = "linux")]
	#[test]
	fn production_credential_observation_rejects_a_writable_test_mount() {
		let root = synthetic_auth_fixture(
			"account-synthetic-0123456789abcdef",
			"account-synthetic-0123456789abcdef",
		);

		assert!(super::chatgpt_credential_observation(&root).is_err());

		fs::remove_dir_all(root).expect("auth fixture cleanup");
	}

	#[cfg(target_os = "macos")]
	#[test]
	fn production_credential_observation_rejects_a_writable_auth_file() {
		let root = synthetic_auth_fixture(
			"account-synthetic-0123456789abcdef",
			"account-synthetic-0123456789abcdef",
		);
		let error = super::chatgpt_credential_observation(&root)
			.expect_err("writable auth file must fail production observation");

		assert_eq!(error.to_string(), "controlled Codex credential must be owner immutable",);

		fs::remove_dir_all(root).expect("auth fixture cleanup");
	}

	#[cfg(target_os = "macos")]
	#[test]
	fn production_credential_observation_accepts_an_owner_immutable_auth_file() {
		let fixture = OwnerImmutableAuthFixture::new(
			"account-synthetic-0123456789abcdef",
			"account-synthetic-0123456789abcdef",
		);

		super::chatgpt_credential_observation(&fixture.root)
			.expect("owner-immutable auth file must pass production observation");
	}

	#[cfg(unix)]
	#[test]
	fn local_artifact_sink_rejects_root_redirection_without_writing_replacement() {
		let parent = env::temp_dir().join(format!(
			"aiq-artifact-root-redirection-{}-{}",
			process::id(),
			super::observation_time()
		));
		let root = parent.join("artifacts");
		let displaced = parent.join("artifacts-displaced");

		fs::create_dir_all(&root).expect("artifact root");

		let sink = LocalArtifactSink::new(&root).expect("pinned artifact sink");

		fs::rename(&root, &displaced).expect("displace pinned artifact root");
		fs::create_dir(&root).expect("replacement artifact root");

		assert!(ArtifactSink::put(&sink, "stdout.jsonl", b"{\"ok\":true}\n").is_err());
		assert_eq!(
			fs::read_dir(&root).expect("replacement directory").count(),
			0,
			"the mutable replacement pathname must stay empty",
		);

		fs::remove_dir_all(parent).expect("artifact fixture cleanup");
	}

	#[cfg(unix)]
	#[test]
	fn local_artifact_sink_rejects_digest_directory_symlink() {
		let root = env::temp_dir().join(format!(
			"aiq-artifact-symlink-{}-{}",
			process::id(),
			super::observation_time()
		));
		let outside = env::temp_dir().join(format!(
			"aiq-artifact-outside-{}-{}",
			process::id(),
			super::observation_time()
		));
		let sink = LocalArtifactSink::new(&root).expect("sink root");

		fs::create_dir_all(&outside).expect("outside fixture");

		let digest = super::sha256(b"symlink").expect("fixture digest");

		std::os::unix::fs::symlink(&outside, root.join(digest.trim_start_matches("sha256:")))
			.expect("fixture symlink");

		assert!(sink.put("stdout.jsonl", b"symlink").is_err());

		fs::remove_dir_all(&root).expect("root cleanup");
		fs::remove_dir_all(&outside).expect("outside cleanup");
	}

	#[cfg(unix)]
	#[test]
	fn local_artifact_publication_rejects_digest_directory_replacement_before_return() {
		let root = env::temp_dir().join(format!(
			"aiq-artifact-publish-identity-{}-{}",
			process::id(),
			super::observation_time()
		));
		let sink = LocalArtifactSink::new(&root).expect("sink root");
		let exact = b"{\"exact\":true}\n";
		let replacement = b"{\"wrong\":true}\n";

		assert_eq!(exact.len(), replacement.len());

		let digest = super::sha256(exact).expect("fixture digest");
		let digest = digest.trim_start_matches("sha256:").to_owned();
		let directory = root.join(&digest);
		let displaced = root.join(format!("{digest}-displaced"));
		let result = sink.put_with_post_publish_hook("stdout.jsonl", exact, || {
			fs::rename(&directory, &displaced).expect("displace published digest directory");
			fs::create_dir(&directory).expect("replacement digest directory");
			fs::write(directory.join("stdout.jsonl"), replacement).expect("replacement artifact");
		});

		assert!(result.is_err());
		assert_eq!(
			fs::read(root.join(&digest).join("stdout.jsonl")).expect("current URI bytes"),
			replacement,
			"publication must reject a URI that no longer resolves to its held bytes",
		);

		fs::remove_dir_all(root).expect("artifact fixture cleanup");
	}
}
