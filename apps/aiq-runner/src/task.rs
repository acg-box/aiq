//! Benchmark task schemas and controlled task sources.

pub(crate) mod evaluator;

pub use evaluator::{
	CheckedEvaluatorObservation, EVALUATOR_CONFIG_SCHEMA_VERSION, EVALUATOR_PROTOCOL_VERSION,
	EVALUATOR_RESULT_SCHEMA_VERSION, EXTERNAL_EVALUATOR_REPLAY_PASSES, EvaluationError,
	EvaluationErrorKind, EvaluationResult, EvaluatorCheck, EvaluatorCheckFailureClass,
	EvaluatorContext, EvaluatorOutcome, EvaluatorRuntime, EvaluatorRuntimeKind,
	ExternalEvaluatorBinding, MAX_EVALUATOR_TIMEOUT_MS, MAX_PARALLEL_EXTERNAL_EVALUATORS,
	NODE_SCENARIO_CLEANUP_RESERVE_MS, NODE_SCENARIO_COPY_RESERVE_MS,
	NODE_SCENARIO_PASS_OVERHEAD_MS, NODE_SCENARIO_SPAWN_RESERVE_MS, NormalizedToolEvidence,
	minimum_node_scenario_evaluator_timeout_ms,
};

#[cfg(unix)]
use std::os::unix::fs::MetadataExt;
use std::{
	collections::{BTreeMap, BTreeSet},
	fs, iter,
	path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Digest as _;

use crate::{
	pinned_path::PinnedDirectoryIdentity,
	protocol::{self, ProtocolError},
};

/// The task schema version accepted by this runner.
pub const TASK_SCHEMA_VERSION: &str = "aiq.task.v2";

const MAX_DIRECTORY_TASK_FILES: usize = 128;
const MAX_DIRECTORY_TASK_FILE_BYTES: usize = 1_024 * 1_024;
const MAX_DIRECTORY_TASK_AGGREGATE_BYTES: usize = 16 * 1_024 * 1_024;

/// A controlled source of benchmark tasks.
pub trait TaskSource {
	/// Loads and validates every task visible through this source.
	fn load(&self) -> TaskLoadReport;
}

/// A future private object-storage backend.
pub trait StorageBackend {
	/// Lists controlled task object keys.
	fn list_task_keys(&self) -> Result<Vec<String>, String>;
	/// Reads one task object.
	fn read_task(&self, key: &str) -> Result<Vec<u8>, String>;
}

/// A stable AIQ task domain.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Domain {
	/// Code creation and modification.
	Coding,
	/// Fault isolation and repair.
	Debugging,
	/// Repository navigation and comprehension.
	RepositoryUnderstanding,
	/// Data transformation and analysis.
	DataProcessing,
	/// Retrieval with source verification.
	RetrievalVerification,
	/// Technical documentation and communication.
	DocumentationCommunication,
	/// Multi-step planning and execution.
	PlanningExecution,
	/// Correct and efficient tool use.
	ToolUse,
	/// Compliance with explicit instructions.
	InstructionFollowing,
	/// Failure handling and recovery.
	ReliabilityRecovery,
}

/// Task visibility.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Visibility {
	/// A public example task.
	PublicExample,
	/// A task whose content must stay in a controlled source.
	Hidden,
}

/// Per-task resource budgets.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TaskBudgets {
	/// Maximum Codex adapter elapsed time. `None` means that task execution has no deadline.
	pub wall_seconds: Option<u64>,
	/// Maximum agent steps.
	pub max_steps: u32,
	/// Maximum tool calls.
	pub max_tool_calls: u32,
}

/// Evaluator declaration.
///
/// Public synthetic tasks use the built-in `exact_match` kind. Every other kind
/// must provide a controlled external evaluator binding.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Evaluator {
	/// Stable evaluator kind.
	pub kind: String,
	/// Expected response for the built-in exact-match evaluator.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub expected: Option<String>,
	/// Whether built-in exact matching is case-sensitive.
	#[serde(default, skip_serializing_if = "is_false")]
	pub case_sensitive: bool,
	/// Controlled executable binding for a production evaluator.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub external: Option<ExternalEvaluatorBinding>,
}
impl Evaluator {
	/// Creates the built-in exact-match evaluator.
	#[must_use]
	pub fn exact_match(expected: impl Into<String>, case_sensitive: bool) -> Self {
		Self {
			kind: "exact_match".to_owned(),
			expected: Some(expected.into()),
			case_sensitive,
			external: None,
		}
	}

	/// Evaluates a response through the built-in or controlled external scorer.
	pub fn evaluate_checked(
		&self,
		response: &str,
		_context: Option<&EvaluatorContext<'_>>,
	) -> Result<EvaluationResult, EvaluationError> {
		if self.kind == "exact_match" {
			let expected = self
				.expected
				.as_deref()
				.ok_or_else(|| EvaluationError::configuration("exact_match requires expected"))?;
			let correct = if self.case_sensitive {
				response.trim() == expected.trim()
			} else {
				response.trim().to_lowercase() == expected.trim().to_lowercase()
			};
			let evidence_digest =
				format!("sha256:{}", hex::encode(sha2::Sha256::digest(response.as_bytes())));

			return Ok(EvaluationResult::binary(correct, evidence_digest));
		}

		Err(EvaluationError::configuration(
			"external evaluators require an explicit registry and committed runtime",
		))
	}

	/// Evaluates through an explicit evaluator registry and runtime.
	pub fn evaluate_checked_at_root(
		&self,
		response: &str,
		context: Option<&EvaluatorContext<'_>>,
		root: &Path,
		runtime: &EvaluatorRuntime,
	) -> Result<EvaluationResult, EvaluationError> {
		if self.kind == "exact_match" {
			return self.evaluate_checked(response, context);
		}

		let binding = self.external.as_ref().ok_or_else(|| {
			EvaluationError::configuration(format!(
				"evaluator kind {} requires a controlled external binding",
				self.kind
			))
		})?;
		let context = context.ok_or_else(|| {
			EvaluationError::configuration(
				"external evaluators require complete execution and workspace evidence",
			)
		})?;

		binding.evaluate_at_root(&self.kind, context, root, runtime)
	}

	/// Evaluates through the checked two-pass external boundary and returns the
	/// independently observed raw stdout digest.
	pub fn evaluate_checked_observation_at_root(
		&self,
		_response: &str,
		context: Option<&EvaluatorContext<'_>>,
		root: &Path,
		runtime: &EvaluatorRuntime,
	) -> Result<CheckedEvaluatorObservation, EvaluationError> {
		let binding = self.external.as_ref().ok_or_else(|| {
			EvaluationError::configuration(format!(
				"evaluator kind {} requires a controlled external binding for raw stdout proof",
				self.kind
			))
		})?;
		let context = context.ok_or_else(|| {
			EvaluationError::configuration(
				"external evaluators require complete execution and workspace evidence",
			)
		})?;

		binding.evaluate_observation_at_root(&self.kind, context, root, runtime)
	}

	/// Evaluates with a complete explicit external execution configuration.
	pub fn evaluate_checked_with_execution(
		&self,
		response: &str,
		context: Option<&EvaluatorContext<'_>>,
		execution: Option<(&Path, &EvaluatorRuntime)>,
	) -> Result<EvaluationResult, EvaluationError> {
		if self.external.is_none() {
			return self.evaluate_checked(response, context);
		}

		let (root, runtime) = execution.ok_or_else(|| {
			EvaluationError::configuration(
				"external evaluators require an explicit registry and committed runtime",
			)
		})?;

		self.evaluate_checked_at_root(response, context, root, runtime)
	}

	/// Evaluates through the controlled two-pass boundary and reports each actual pass edge.
	pub fn evaluate_checked_with_execution_observed(
		&self,
		response: &str,
		context: Option<&EvaluatorContext<'_>>,
		execution: Option<(&Path, &EvaluatorRuntime)>,
		observer: &mut dyn FnMut(usize, bool),
	) -> Result<EvaluationResult, EvaluationError> {
		if self.external.is_none() {
			return self.evaluate_checked(response, context);
		}

		let (root, runtime) = execution.ok_or_else(|| {
			EvaluationError::configuration(
				"external evaluators require an explicit registry and committed runtime",
			)
		})?;
		let binding = self.external.as_ref().ok_or_else(|| {
			EvaluationError::configuration("external evaluator binding disappeared")
		})?;
		let context = context.ok_or_else(|| {
			EvaluationError::configuration(
				"external evaluators require complete execution and workspace evidence",
			)
		})?;

		binding.evaluate_at_root_observed(&self.kind, context, root, runtime, observer)
	}
}

/// A versioned benchmark task.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TaskDefinition {
	/// Task schema version.
	pub schema_version: String,
	/// Stable task identifier.
	pub task_id: String,
	/// Version of this task.
	pub task_version: String,
	/// Human-readable title.
	pub title: String,
	/// Stable AIQ domain.
	pub domain: Domain,
	/// Repository-defined difficulty label.
	pub difficulty: String,
	/// Prompt sent to the model.
	pub prompt: String,
	/// Tools that the task permits.
	pub allowed_tools: Vec<String>,
	/// Resource budgets.
	pub budgets: TaskBudgets,
	/// Searchable task tags.
	pub tags: Vec<String>,
	/// Optional within-domain bootstrap cluster. The task identifier is the fallback.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub cluster_id: Option<String>,
	/// RFC 8785 SHA-256 commitment to the exact public catalog entry.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub catalog_entry_digest: Option<String>,
	/// Scorer version that owns expected evaluation.
	pub scorer_version: String,
	/// Public-safe leakage review notes.
	pub leakage_notes: Vec<String>,
	/// Controlled fixture references.
	pub fixture_refs: Vec<String>,
	/// Task visibility.
	pub visibility: Visibility,
	/// Task provenance. Keys are serialized in stable order.
	pub provenance: BTreeMap<String, Value>,
	/// Required built-in or controlled external evaluator.
	pub evaluator: Option<Evaluator>,
}
impl TaskDefinition {
	/// Returns the content address of the complete task package.
	pub fn content_hash(&self) -> Result<String, ProtocolError> {
		protocol::canonical_hash(self)
	}

	/// Returns structured validation issues.
	#[must_use]
	pub fn validation_issues(&self) -> Vec<ValidationIssue> {
		let mut issues = Vec::new();

		self.validate_identity_fields(&mut issues);
		self.validate_budget_and_tools(&mut issues);
		self.validate_metadata_fields(&mut issues);
		self.validate_evaluator(&mut issues);

		issues
	}

	fn validate_identity_fields(&self, issues: &mut Vec<ValidationIssue>) {
		if self.schema_version != TASK_SCHEMA_VERSION {
			issues.push(ValidationIssue::field(
				"schema_version",
				"unsupported_schema",
				format!("expected {TASK_SCHEMA_VERSION}"),
			));
		}

		for (field, value) in [
			("task_id", self.task_id.as_str()),
			("title", self.title.as_str()),
			("difficulty", self.difficulty.as_str()),
			("prompt", self.prompt.as_str()),
			("scorer_version", self.scorer_version.as_str()),
		] {
			if value.trim().is_empty() {
				issues.push(ValidationIssue::field(field, "empty_field", "must not be empty"));
			}
		}

		if !is_semantic_version(&self.task_version) {
			issues.push(ValidationIssue::field(
				"task_version",
				"invalid_version",
				"must use numeric MAJOR.MINOR.PATCH format",
			));
		}
		if !is_semantic_version(&self.scorer_version) {
			issues.push(ValidationIssue::field(
				"scorer_version",
				"invalid_version",
				"must use numeric MAJOR.MINOR.PATCH format",
			));
		}
		if !is_task_id(&self.task_id) {
			issues.push(ValidationIssue::field(
				"task_id",
				"invalid_token",
				"must use lowercase domain words followed by a two-digit ordinal",
			));
		}
		if !matches!(self.difficulty.as_str(), "easy" | "medium" | "hard") {
			issues.push(ValidationIssue::field(
				"difficulty",
				"invalid_difficulty",
				"must be easy, medium, or hard",
			));
		}
	}

	fn validate_budget_and_tools(&self, issues: &mut Vec<ValidationIssue>) {
		if self.budgets.wall_seconds == Some(0) {
			issues.push(ValidationIssue::field(
				"budgets.wall_seconds",
				"invalid_budget",
				"must be null or greater than zero",
			));
		}
		if self.budgets.max_steps == 0 {
			issues.push(ValidationIssue::field(
				"budgets.max_steps",
				"invalid_budget",
				"must be greater than zero",
			));
		}

		validate_nonempty_unique(issues, "allowed_tools", &self.allowed_tools, true);

		const ALLOWED_TOOLS: [&str; 5] =
			["none", "filesystem_read", "filesystem_write", "web_search", "command_execution"];

		for tool in &self.allowed_tools {
			if !ALLOWED_TOOLS.contains(&tool.as_str()) {
				issues.push(ValidationIssue::field(
					"allowed_tools",
					"unknown_tool",
					format!("unsupported tool token {tool}"),
				));
			}
		}

		if self.allowed_tools.iter().any(|tool| tool == "none") && self.allowed_tools.len() != 1 {
			issues.push(ValidationIssue::field(
				"allowed_tools",
				"mixed_none_tool",
				"none must be the only allowed tool",
			));
		}
		if self.allowed_tools.iter().any(|tool| tool == "command_execution")
			&& !self
				.allowed_tools
				.iter()
				.any(|tool| matches!(tool.as_str(), "filesystem_read" | "filesystem_write"))
		{
			issues.push(ValidationIssue::field(
				"allowed_tools",
				"command_execution_without_filesystem_scope",
				"command_execution requires filesystem_read or filesystem_write",
			));
		}
	}

	fn validate_metadata_fields(&self, issues: &mut Vec<ValidationIssue>) {
		validate_nonempty_unique(issues, "tags", &self.tags, true);
		validate_nonempty_unique(issues, "leakage_notes", &self.leakage_notes, true);
		validate_nonempty_unique(issues, "fixture_refs", &self.fixture_refs, true);

		for tag in &self.tags {
			if !is_lower_snake_token(tag) {
				issues.push(ValidationIssue::field(
					"tags",
					"invalid_token",
					"tags must start with a lowercase letter and contain lowercase letters, digits, or underscores",
				));
			}
		}
		for fixture_ref in &self.fixture_refs {
			if !is_fixture_reference(fixture_ref) {
				issues.push(ValidationIssue::field(
					"fixture_refs",
					"invalid_reference",
					"fixture references must use a safe repo or exact controlled fixture URI",
				));
			}
		}

		if self.cluster_id.as_ref().is_some_and(|cluster| !is_cluster_id(cluster)) {
			issues.push(ValidationIssue::field(
				"cluster_id",
				"invalid_token",
				"must use a lowercase domain cluster token and two-digit ordinal",
			));
		}
		if self.provenance.is_empty() {
			issues.push(ValidationIssue::field(
				"provenance",
				"missing_provenance",
				"must contain at least one provenance entry",
			));
		}

		match (&self.visibility, &self.catalog_entry_digest) {
			(Visibility::Hidden, None) => issues.push(ValidationIssue::field(
				"catalog_entry_digest",
				"missing_catalog_entry_digest",
				"hidden tasks must bind the exact public catalog entry",
			)),
			(_, Some(digest)) if !is_sha256_digest(digest) => issues.push(ValidationIssue::field(
				"catalog_entry_digest",
				"invalid_digest",
				"must be sha256: plus 64 lowercase hexadecimal characters",
			)),
			_ => {},
		}

		if self.evaluator.as_ref().is_some_and(|evaluator| !is_lower_snake_token(&evaluator.kind)) {
			issues.push(ValidationIssue::field(
				"evaluator.kind",
				"invalid_token",
				"must start with a lowercase letter and contain lowercase letters, digits, or underscores",
			));
		}
	}

	fn validate_evaluator(&self, issues: &mut Vec<ValidationIssue>) {
		match (&self.visibility, &self.evaluator) {
			(_, None) => issues.push(ValidationIssue::field(
				"evaluator",
				"missing_evaluator",
				"every task must declare an evaluator",
			)),
			(Visibility::PublicExample, Some(evaluator)) => {
				if evaluator.kind != "exact_match"
					|| evaluator.expected.is_none()
					|| evaluator.external.is_some()
				{
					issues.push(ValidationIssue::field(
						"evaluator",
						"invalid_public_evaluator",
						"public examples must use the built-in exact_match evaluator",
					));
				}
			},
			(Visibility::Hidden, Some(evaluator)) => {
				if evaluator.kind == "exact_match" {
					issues.push(ValidationIssue::field(
						"evaluator.kind",
						"invalid_hidden_evaluator",
						"controlled hidden tasks must use a controlled external evaluator",
					));
				} else if evaluator.expected.is_some() || evaluator.case_sensitive {
					issues.push(ValidationIssue::field(
						"evaluator",
						"invalid_external_evaluator",
						"controlled external evaluators cannot declare exact-match fields",
					));
				} else if let Some(binding) = &evaluator.external {
					for message in binding.validation_issues(&self.scorer_version) {
						issues.push(ValidationIssue::field(
							"evaluator.external",
							"invalid_external_evaluator",
							message,
						));
					}
				} else {
					issues.push(ValidationIssue::field(
						"evaluator.external",
						"missing_external_evaluator",
						"production evaluator kinds require a controlled executable binding",
					));
				}
			},
		}
	}
}

/// A machine-readable task validation issue.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct ValidationIssue {
	/// Stable issue code.
	pub code: String,
	/// Field associated with the issue.
	pub field: Option<String>,
	/// Human-readable detail.
	pub message: String,
}
impl ValidationIssue {
	fn field(field: &str, code: &str, message: impl Into<String>) -> Self {
		Self { code: code.to_owned(), field: Some(field.to_owned()), message: message.into() }
	}

	fn general(code: &str, message: impl Into<String>) -> Self {
		Self { code: code.to_owned(), field: None, message: message.into() }
	}
}

/// A source-specific task loading error.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct TaskLoadIssue {
	/// Source path or storage key.
	pub source: String,
	/// Structured validation or input issue.
	pub issue: ValidationIssue,
}

/// Tasks and errors returned by a source.
#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
pub struct TaskLoadReport {
	/// Valid tasks.
	pub tasks: Vec<TaskDefinition>,
	/// Invalid task records and source errors.
	pub issues: Vec<TaskLoadIssue>,
}

/// A local controlled directory task source.
#[derive(Clone, Debug)]
pub struct DirectoryTaskSource {
	root: PathBuf,
	expected_visibility: Option<Visibility>,
}
impl DirectoryTaskSource {
	/// Creates a local source.
	#[must_use]
	pub fn new(root: impl Into<PathBuf>, expected_visibility: Option<Visibility>) -> Self {
		Self { root: root.into(), expected_visibility }
	}
}

impl TaskSource for DirectoryTaskSource {
	fn load(&self) -> TaskLoadReport {
		let source_failure = |message: String| TaskLoadReport {
			tasks: Vec::new(),
			issues: vec![TaskLoadIssue {
				source: self.root.display().to_string(),
				issue: ValidationIssue::general("source_unavailable", message),
			}],
		};
		let root_metadata = match fs::symlink_metadata(&self.root) {
			Ok(metadata) => metadata,
			Err(error) => return source_failure(error.to_string()),
		};

		if !root_metadata.is_dir() || root_metadata.file_type().is_symlink() {
			return source_failure("controlled task root must be an ordinary directory".to_owned());
		}

		let canonical_root = match fs::canonicalize(&self.root) {
			Ok(path) => path,
			Err(error) => return source_failure(error.to_string()),
		};
		let pinned = match PinnedDirectoryIdentity::capture(&canonical_root) {
			Ok(identity) => identity,
			Err(error) => return source_failure(error),
		};
		let entries = match fs::read_dir(pinned.path()) {
			Ok(entries) => entries,
			Err(error) => return source_failure(error.to_string()),
		};
		let mut files = Vec::new();

		for entry in entries {
			let entry = match entry {
				Ok(entry) => entry,
				Err(error) => return source_failure(error.to_string()),
			};
			let metadata = match fs::symlink_metadata(entry.path()) {
				Ok(metadata) => metadata,
				Err(error) => return source_failure(error.to_string()),
			};

			if !metadata.is_file() || metadata.file_type().is_symlink() {
				return source_failure(format!(
					"controlled task directory contains a non-ordinary entry: {}",
					entry.path().display()
				));
			}
			#[cfg(unix)]
			if MetadataExt::nlink(&metadata) != 1 {
				return source_failure(format!(
					"controlled task directory contains a hard-linked file: {}",
					entry.path().display()
				));
			}
			if entry.path().extension().is_some_and(|extension| extension == "json") {
				files.push(entry.file_name());

				if files.len() > MAX_DIRECTORY_TASK_FILES {
					return source_failure(
						"controlled task file count exceeds the limit".to_owned(),
					);
				}
			}
		}

		files.sort();

		let mut aggregate_bytes = 0_usize;
		let mut records = Vec::with_capacity(files.len());

		for name in files {
			let source = canonical_root.join(&name).display().to_string();
			let bytes = match pinned.read_child_file_bounded(&name, MAX_DIRECTORY_TASK_FILE_BYTES) {
				Ok(bytes) => bytes,
				Err(error) => return source_failure(error),
			};

			aggregate_bytes = match aggregate_bytes.checked_add(bytes.len()) {
				Some(total) if total <= MAX_DIRECTORY_TASK_AGGREGATE_BYTES => total,
				_ => {
					return source_failure(
						"controlled task aggregate exceeds the byte limit".to_owned(),
					);
				},
			};

			records.push((source, Ok::<Vec<u8>, String>(bytes)));
		}

		load_records(records, self.expected_visibility)
	}
}

/// A task source backed by a private storage implementation.
pub struct StorageTaskSource<B> {
	backend: B,
	expected_visibility: Option<Visibility>,
}
impl<B> StorageTaskSource<B> {
	/// Creates a private storage task source.
	#[must_use]
	pub const fn new(backend: B, expected_visibility: Option<Visibility>) -> Self {
		Self { backend, expected_visibility }
	}
}

impl<B> TaskSource for StorageTaskSource<B>
where
	B: StorageBackend,
{
	fn load(&self) -> TaskLoadReport {
		let mut keys = match self.backend.list_task_keys() {
			Ok(keys) => keys,
			Err(error) => {
				return TaskLoadReport {
					tasks: Vec::new(),
					issues: vec![TaskLoadIssue {
						source: "private_storage".to_owned(),
						issue: ValidationIssue::general("source_unavailable", error),
					}],
				};
			},
		};

		keys.sort();

		load_records(
			keys.iter().map(|key| (key.clone(), self.backend.read_task(key))),
			self.expected_visibility,
		)
	}
}

/// Returns a stable hash of a validated task set.
pub fn task_set_hash(tasks: &[TaskDefinition]) -> Result<String, ProtocolError> {
	let mut addresses =
		tasks.iter().map(|task| task.content_hash()).collect::<Result<Vec<_>, _>>()?;

	addresses.sort();

	protocol::canonical_hash(&addresses)
}

/// Reads one task file without creating a source.
pub fn read_task_file(path: &Path) -> TaskLoadReport {
	load_records(
		iter::once((path.display().to_string(), fs::read(path).map_err(|error| error.to_string()))),
		None,
	)
}

pub(crate) fn is_semantic_version(value: &str) -> bool {
	let valid_component = |part: &str| {
		!part.is_empty()
			&& part.bytes().all(|byte| byte.is_ascii_digit())
			&& (part == "0" || !part.starts_with('0'))
	};
	let mut parts = value.split('.');

	(0..3).all(|_| parts.next().is_some_and(valid_component)) && parts.next().is_none()
}

pub(crate) fn is_task_id(value: &str) -> bool {
	let Some((prefix, ordinal)) = value.rsplit_once('-') else {
		return false;
	};

	!prefix.is_empty()
		&& prefix
			.bytes()
			.all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
		&& ordinal.len() == 2
		&& ordinal.bytes().all(|byte| byte.is_ascii_digit())
}

pub(crate) fn is_lower_snake_token(value: &str) -> bool {
	let mut bytes = value.bytes();

	bytes.next().is_some_and(|byte| byte.is_ascii_lowercase())
		&& bytes.all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}

pub(crate) fn is_cluster_id(value: &str) -> bool {
	let Some((domain, ordinal)) = value.rsplit_once("-cluster-") else {
		return false;
	};

	!domain.is_empty()
		&& domain.bytes().all(|byte| byte.is_ascii_lowercase() || byte == b'_')
		&& ordinal.len() == 2
		&& ordinal.bytes().all(|byte| byte.is_ascii_digit())
}

pub(crate) fn is_fixture_reference(value: &str) -> bool {
	if let Some(path) = value.strip_prefix("repo://") {
		return is_safe_uri_path(path);
	}

	for scheme in ["aiq-controlled-fixture://", "aiq-controlled-acceptance://"] {
		if let Some(reference) = value.strip_prefix(scheme)
			&& let Some(task_id) = reference.strip_prefix("aiq-core/1.0.6/")
		{
			return is_task_id(task_id);
		}
	}

	false
}

const fn is_false(value: &bool) -> bool {
	!*value
}

fn is_sha256_digest(value: &str) -> bool {
	value.len() == 71
		&& value.starts_with("sha256:")
		&& value[7..].bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
		&& !value[7..].bytes().all(|byte| byte == b'0')
}

fn is_safe_uri_path(value: &str) -> bool {
	(1..=240).contains(&value.len())
		&& !value.starts_with('/')
		&& !value.ends_with('/')
		&& value.split('/').all(|component| {
			!component.is_empty()
				&& !matches!(component, "." | "..")
				&& component
					.bytes()
					.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
		})
}

fn validate_nonempty_unique(
	issues: &mut Vec<ValidationIssue>,
	field: &str,
	values: &[String],
	require_nonempty: bool,
) {
	if require_nonempty && values.is_empty() {
		issues.push(ValidationIssue::field(
			field,
			"empty_collection",
			"must contain at least one item",
		));

		return;
	}

	let mut unique = BTreeSet::new();

	for value in values {
		if value.trim().is_empty() {
			issues.push(ValidationIssue::field(field, "empty_item", "items must not be empty"));
		}
		if !unique.insert(value) {
			issues.push(ValidationIssue::field(field, "duplicate_item", "items must be unique"));
		}
	}
}

fn load_records<I>(records: I, expected_visibility: Option<Visibility>) -> TaskLoadReport
where
	I: IntoIterator<Item = (String, Result<Vec<u8>, String>)>,
{
	let mut report = TaskLoadReport::default();
	let mut identifiers = BTreeSet::new();

	for (source, bytes) in records {
		let task = match parse_task(&source, bytes) {
			Ok(task) => task,
			Err(issue) => {
				report.issues.push(issue);

				continue;
			},
		};
		let mut issues = task.validation_issues();

		if expected_visibility.is_some_and(|visibility| task.visibility != visibility) {
			issues.push(ValidationIssue::field(
				"visibility",
				"visibility_mismatch",
				"task visibility does not match its controlled source",
			));
		}
		if !identifiers.insert((task.task_id.clone(), task.task_version.clone())) {
			issues.push(ValidationIssue::field(
				"task_id",
				"duplicate_task",
				"task_id and task_version must be unique",
			));
		}
		if issues.is_empty() {
			report.tasks.push(task);
		} else {
			report.issues.extend(
				issues.into_iter().map(|issue| TaskLoadIssue { source: source.clone(), issue }),
			);
		}
	}

	report.tasks.sort_by(|left, right| left.task_id.cmp(&right.task_id));

	report
}

fn parse_task(
	source: &str,
	bytes: Result<Vec<u8>, String>,
) -> Result<TaskDefinition, TaskLoadIssue> {
	let bytes = bytes.map_err(|message| TaskLoadIssue {
		source: source.to_owned(),
		issue: ValidationIssue::general("read_error", message),
	})?;
	let value = serde_json::from_slice::<Value>(&bytes).map_err(|error| TaskLoadIssue {
		source: source.to_owned(),
		issue: ValidationIssue::general("invalid_json", error.to_string()),
	})?;
	let object = value.as_object().ok_or_else(|| TaskLoadIssue {
		source: source.to_owned(),
		issue: ValidationIssue::general("invalid_task", "task must be a JSON object"),
	})?;

	const REQUIRED_FIELDS: [&str; 16] = [
		"schema_version",
		"task_id",
		"task_version",
		"title",
		"domain",
		"difficulty",
		"prompt",
		"allowed_tools",
		"budgets",
		"tags",
		"scorer_version",
		"leakage_notes",
		"fixture_refs",
		"visibility",
		"provenance",
		"evaluator",
	];

	if let Some(field) = REQUIRED_FIELDS.iter().find(|field| !object.contains_key(**field)) {
		return Err(TaskLoadIssue {
			source: source.to_owned(),
			issue: ValidationIssue::field(field, "missing_field", "required field is missing"),
		});
	}

	serde_json::from_value(value).map_err(|error| TaskLoadIssue {
		source: source.to_owned(),
		issue: ValidationIssue::general("invalid_task", error.to_string()),
	})
}

#[cfg(test)]
mod tests {
	use std::env;
	use std::{
		collections::BTreeMap,
		fs,
		path::PathBuf,
		process,
		time::{SystemTime, UNIX_EPOCH},
	};

	use serde_json;

	use crate::{
		protocol,
		task::{
			DirectoryTaskSource, Domain, EVALUATOR_PROTOCOL_VERSION, Evaluator,
			EvaluatorRuntimeKind, ExternalEvaluatorBinding, TASK_SCHEMA_VERSION, TaskBudgets,
			TaskDefinition, TaskSource, Visibility,
		},
	};

	fn temporary_task_directory(label: &str) -> PathBuf {
		let nonce = SystemTime::now().duration_since(UNIX_EPOCH).expect("fixture clock").as_nanos();
		let path =
			env::temp_dir().join(format!("aiq-task-source-{label}-{}-{nonce}", process::id()));

		fs::create_dir(&path).expect("task source fixture directory");

		path
	}

	fn fixture() -> TaskDefinition {
		TaskDefinition {
			schema_version: TASK_SCHEMA_VERSION.to_owned(),
			task_id: "coding-01".to_owned(),
			task_version: "1.0.0".to_owned(),
			title: "Return one word".to_owned(),
			domain: Domain::Coding,
			difficulty: "easy".to_owned(),
			prompt: "Return OK.".to_owned(),
			allowed_tools: vec!["none".to_owned()],
			budgets: TaskBudgets { wall_seconds: Some(30), max_steps: 4, max_tool_calls: 2 },
			tags: vec!["fixture".to_owned()],
			cluster_id: Some("coding-cluster-01".to_owned()),
			catalog_entry_digest: None,
			scorer_version: "1.0.0".to_owned(),
			leakage_notes: vec!["synthetic fixture".to_owned()],
			fixture_refs: vec!["repo://synthetic-fixture".to_owned()],
			visibility: Visibility::PublicExample,
			provenance: BTreeMap::from([("source".to_owned(), serde_json::json!("unit_test"))]),
			evaluator: Some(Evaluator::exact_match("OK", false)),
		}
	}

	#[test]
	fn task_round_trips_all_contract_fields() {
		let task = fixture();
		let encoded = serde_json::to_vec(&task).expect("fixture must serialize");
		let decoded: TaskDefinition =
			serde_json::from_slice(&encoded).expect("fixture must deserialize");

		assert_eq!(decoded, task);
		assert!(decoded.validation_issues().is_empty());
	}

	#[test]
	fn null_wall_budget_means_no_model_deadline_and_zero_is_rejected() {
		let mut task = fixture();

		task.budgets.wall_seconds = None;

		let encoded = serde_json::to_value(&task).expect("fixture must serialize");

		assert!(encoded.pointer("/budgets/wall_seconds").is_some_and(serde_json::Value::is_null));
		assert!(task.validation_issues().is_empty());

		task.budgets.wall_seconds = Some(0);

		assert!(task.validation_issues().iter().any(|issue| {
			issue.field.as_deref() == Some("budgets.wall_seconds") && issue.code == "invalid_budget"
		}));
	}

	#[test]
	fn directory_source_reads_an_ordinary_bounded_task_file() {
		let root = temporary_task_directory("ordinary");

		fs::write(
			root.join("task.json"),
			serde_json::to_vec(&fixture()).expect("serialize task fixture"),
		)
		.expect("write task fixture");

		let report = DirectoryTaskSource::new(&root, Some(Visibility::PublicExample)).load();

		assert_eq!(report.tasks, vec![fixture()]);
		assert!(report.issues.is_empty());

		fs::remove_dir_all(root).expect("remove task source fixture");
	}

	#[cfg(unix)]
	#[test]
	fn directory_source_rejects_symlinks_and_hardlinks() {
		for hard_link in [false, true] {
			let root = temporary_task_directory(if hard_link { "hardlink" } else { "symlink" });
			let outside = root.with_extension("outside.json");

			fs::write(&outside, serde_json::to_vec(&fixture()).expect("serialize task fixture"))
				.expect("write outside fixture");

			if hard_link {
				fs::hard_link(&outside, root.join("task.json")).expect("create hard link");
			} else {
				std::os::unix::fs::symlink(&outside, root.join("task.json"))
					.expect("create symbolic link");
			}

			let report = DirectoryTaskSource::new(&root, Some(Visibility::PublicExample)).load();

			assert!(report.tasks.is_empty());
			assert_eq!(report.issues.len(), 1);

			fs::remove_dir_all(root).expect("remove task source fixture");
			fs::remove_file(outside).expect("remove outside fixture");
		}
	}

	#[test]
	fn directory_source_rejects_oversized_files_before_parsing() {
		let root = temporary_task_directory("oversized");
		let oversized = vec![b' '; super::MAX_DIRECTORY_TASK_FILE_BYTES + 1];

		fs::write(root.join("task.json"), oversized).expect("write oversized fixture");

		let report = DirectoryTaskSource::new(&root, Some(Visibility::PublicExample)).load();

		assert!(report.tasks.is_empty());
		assert_eq!(report.issues.len(), 1);
		assert!(report.issues[0].issue.message.contains("byte limit"));

		fs::remove_dir_all(root).expect("remove task source fixture");
	}

	#[test]
	fn content_hash_changes_when_task_content_changes() {
		let original = fixture();
		let mut changed = original.clone();

		changed.title = "Changed title".to_owned();

		assert_ne!(
			original.content_hash().expect("task must hash"),
			changed.content_hash().expect("task must hash")
		);
	}

	#[test]
	fn unknown_production_evaluator_without_binding_is_rejected_before_execution() {
		let mut task = fixture();

		task.visibility = Visibility::Hidden;
		task.evaluator = Some(Evaluator {
			kind: "repository_test_suite".to_owned(),
			expected: None,
			case_sensitive: false,
			external: None,
		});

		let encoded = serde_json::to_vec(&task).expect("fixture must serialize");
		let decoded: TaskDefinition =
			serde_json::from_slice(&encoded).expect("fixture must deserialize");

		assert_eq!(decoded, task);
		assert!(decoded.validation_issues().iter().any(|issue| {
			issue.code == "missing_external_evaluator"
				&& issue.field.as_deref() == Some("evaluator.external")
		}));
	}

	#[test]
	fn runtime_validation_matches_enum_and_collection_schema_rules() {
		let mut task = fixture();

		task.difficulty = "impossible".to_owned();
		task.scorer_version = "unversioned".to_owned();

		task.tags.push(task.tags[0].clone());
		task.fixture_refs.clear();

		let issues = task.validation_issues();

		assert!(issues.iter().any(|issue| issue.code == "invalid_difficulty"));
		assert!(issues.iter().any(|issue| {
			issue.code == "invalid_version" && issue.field.as_deref() == Some("scorer_version")
		}));
		assert!(issues.iter().any(|issue| issue.code == "duplicate_item"));
		assert!(issues.iter().any(|issue| {
			issue.code == "empty_collection" && issue.field.as_deref() == Some("fixture_refs")
		}));
	}

	#[test]
	fn identifier_version_and_fixture_grammars_are_exact() {
		for task_id in ["coding-01", "repository-understanding-72"] {
			assert!(super::is_task_id(task_id));
		}
		for cluster in ["coding-cluster-01", "repository_understanding-cluster-72"] {
			assert!(super::is_cluster_id(cluster));
		}
		for token in ["exact_match", "repository_test_suite2"] {
			assert!(super::is_lower_snake_token(token));
		}

		assert!(super::is_sha256_digest(&format!("sha256:{}", "a".repeat(64))));
		assert!(!super::is_sha256_digest(&format!("sha256:{}", "0".repeat(64))));

		for reference in [
			"repo://benchmarks/examples/tasks/public-example-coding.json",
			"aiq-controlled-fixture://aiq-core/1.0.6/coding-01",
			"aiq-controlled-acceptance://aiq-core/1.0.6/coding-01",
		] {
			assert!(super::is_fixture_reference(reference), "{reference:?} must be accepted");
		}
		for terminator in ["\n", "\r\n", "\u{2028}", "\u{2029}"] {
			assert!(!super::is_task_id(&format!("coding-01{terminator}")));
			assert!(!super::is_cluster_id(&format!("coding-cluster-01{terminator}")));
			assert!(!super::is_lower_snake_token(&format!("exact_match{terminator}")));
			assert!(!super::is_semantic_version(&format!("1.0.0{terminator}")));
			assert!(!super::is_fixture_reference(&format!("repo://fixture.json{terminator}")));
		}
		for version in ["", "1", "1.0", "1.0.0.0", "01.0.0", "1.00.0", "1.0.00"] {
			assert!(!super::is_semantic_version(version), "{version:?} must be rejected");
		}
		for reference in [
			"repo://",
			"repo:///absolute",
			"repo://.",
			"repo://./file",
			"repo://dir/.",
			"repo://dir/..",
			"repo://dir//file",
			"repo://dir/",
			"repo://dir\\file",
			"aiq-controlled-fixture://aiq-core/1.0.4/coding-01",
			"aiq-controlled-acceptance://aiq-core/1.0.4/coding-01",
			"aiq-controlled-fixture://aiq-core/1.0.2/coding-01",
			"aiq-controlled-fixture://aiq-core/1.0.2/coding-1",
			"aiq-controlled-fixture://other/1.0.0/coding-01",
			"aiq-controlled-acceptance://aiq-core/1.0.0/coding-01",
		] {
			assert!(!super::is_fixture_reference(reference), "{reference:?} must be rejected");
		}

		assert!(!super::is_fixture_reference(&format!("repo://{}", "a".repeat(241))));
	}

	#[test]
	fn multiline_human_text_is_valid_but_machine_tokens_and_external_semver_are_not() {
		let mut task = fixture();

		task.title = "Return\none word".to_owned();
		task.prompt = "Return one of:\nOK\nFAIL".to_owned();
		task.leakage_notes = vec!["Reviewed line one.\nReviewed line two.".to_owned()];

		assert!(task.validation_issues().is_empty());

		task.visibility = Visibility::Hidden;
		task.scorer_version = "01.0.0".to_owned();
		task.evaluator = Some(Evaluator {
			kind: "repository_test_suite".to_owned(),
			expected: None,
			case_sensitive: false,
			external: Some(ExternalEvaluatorBinding {
				protocol_version: EVALUATOR_PROTOCOL_VERSION.to_owned(),
				scorer_version: "01.0.0".to_owned(),
				runtime_kind: EvaluatorRuntimeKind::Node,
				runtime_executable_digest: format!("sha256:{}", "b".repeat(64)),
				executable_ref: PathBuf::from("bin/evaluator"),
				executable_digest: format!("sha256:{}", "a".repeat(64)),
				configuration_digest: protocol::canonical_hash(&BTreeMap::<
					String,
					serde_json::Value,
				>::new())
				.expect("empty configuration must hash"),
				arguments: Vec::new(),
				timeout_ms: 1_000,
				max_input_bytes: 1_024,
				max_output_bytes: 1_024,
				configuration: BTreeMap::new(),
			}),
		});

		let issues = task.validation_issues();

		assert!(issues.iter().any(|issue| {
			issue.field.as_deref() == Some("scorer_version") && issue.code == "invalid_version"
		}));
		assert!(issues.iter().any(|issue| {
			issue.field.as_deref() == Some("evaluator.external")
				&& issue.message.contains("semantic MAJOR.MINOR.PATCH")
		}));
	}

	#[test]
	fn unknown_task_fields_are_rejected_by_deserialization() {
		let mut value = serde_json::to_value(fixture()).expect("fixture must serialize");

		value["unexpected"] = serde_json::json!(true);

		assert!(serde_json::from_value::<TaskDefinition>(value).is_err());
	}

	#[test]
	fn shared_negative_fixtures_fail_runtime_contract_validation() {
		let invalid_contract = super::parse_task(
			"invalid-contract.json",
			Ok(include_bytes!("../../../benchmarks/fixtures/tasks/invalid-contract.json").to_vec()),
		)
		.expect("semantic negative fixture must deserialize");

		assert!(!invalid_contract.validation_issues().is_empty());

		let unknown_field = super::parse_task(
			"unknown-field.json",
			Ok(include_bytes!("../../../benchmarks/fixtures/tasks/unknown-field.json").to_vec()),
		);

		assert!(unknown_field.is_err());

		let hidden_exact = super::parse_task(
			"hidden-exact-match.json",
			Ok(include_bytes!("../../../benchmarks/fixtures/tasks/hidden-exact-match.json")
				.to_vec()),
		)
		.expect("visibility negative fixture must deserialize");

		assert!(hidden_exact.validation_issues().iter().any(|issue| {
			issue.code == "invalid_hidden_evaluator"
				&& issue.field.as_deref() == Some("evaluator.kind")
		}));

		let invalid_tools = super::parse_task(
			"invalid-tools.json",
			Ok(include_bytes!("../../../benchmarks/fixtures/tasks/invalid-tools.json").to_vec()),
		)
		.expect("tool-policy negative fixture must deserialize");
		let issues = invalid_tools.validation_issues();

		assert!(issues.iter().any(|issue| issue.code == "unknown_tool"));
		assert!(issues.iter().any(|issue| issue.code == "mixed_none_tool"));

		let mixed_none = super::parse_task(
			"mixed-none.json",
			Ok(include_bytes!("../../../benchmarks/fixtures/tasks/mixed-none.json").to_vec()),
		)
		.expect("mixed-none negative fixture must deserialize");

		assert!(mixed_none.validation_issues().iter().any(|issue| issue.code == "mixed_none_tool"));
	}

	#[test]
	fn command_execution_requires_an_explicit_filesystem_scope() {
		let mut command_only = fixture();

		command_only.allowed_tools = vec!["command_execution".to_owned()];

		assert!(command_only.validation_issues().iter().any(|issue| {
			issue.field.as_deref() == Some("allowed_tools")
				&& issue.code == "command_execution_without_filesystem_scope"
		}));

		command_only.allowed_tools =
			vec!["filesystem_read".to_owned(), "command_execution".to_owned()];

		assert!(command_only.validation_issues().is_empty());
	}
}
