//! Public-safe identities for the current controlled benchmark corpus.

#[cfg(unix)]
use std::os::unix::fs::{MetadataExt as _, PermissionsExt};
use std::{
	collections::{BTreeMap, BTreeSet},
	env::{
		self,
		consts::{ARCH, OS},
	},
	error::Error,
	fmt::{Display, Formatter},
	fs::{self, DirEntry, File},
	io::{self, Read as _, Take},
	path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest as _, Sha256};

#[cfg(test)]
use crate::scoring::AIQ_TASK_SET_VERSION;
use crate::{
	candidate_catalog::{
		self, CANDIDATE_CATALOG_SCHEMA_VERSION, CANDIDATE_TASK_SET_VERSION,
		CandidateCatalogAuthority,
	},
	protocol,
	scoring::{AIQ_CORE_TASK_IDENTITY_SHA256, AIQ_TASK_SET_ID},
	task::{
		EvaluatorRuntime, EvaluatorRuntimeKind, TaskBudgets, TaskDefinition, Visibility, evaluator,
	},
};

/// Ordered full-task-metadata identity for the six controlled contrast variants.
pub const CONTROLLED_CONTRAST_CATALOG_IDENTITY_SHA256: &str =
	"sha256:09d3b4532f3dcd7a6b07c31bc4c59e25d432889ee8cce0b75d15285a42d3e077";

const CONTROLLED_CONTRAST_TASK_SET_VERSION: &str = "1.0.7";
const CODEX_MAIN_EXECUTABLE_NAME: &str = if cfg!(windows) { "codex.exe" } else { "codex" };
const CODEX_CODE_MODE_HOST_EXECUTABLE_NAME: &str =
	if cfg!(windows) { "codex-code-mode-host.exe" } else { "codex-code-mode-host" };
const CORE_CATALOG_JSON: &str =
	include_str!("../../../benchmarks/candidates/aiq-core-1.1.0/catalog.json");
const CANDIDATE_CORE_CATALOG_JSON: &str =
	include_str!("../../../benchmarks/candidates/aiq-core-1.1.0/catalog.json");
#[cfg(test)]
const CANDIDATE_CORE_COMMITMENT_SCHEMA_JSON: &str =
	include_str!("../../../benchmarks/schema/corpus-commitment-v3.schema.json");
#[cfg(test)]
const CONTRAST_PUBLIC_CATALOG_JSON: &str =
	include_str!("../../../benchmarks/candidates/aiq-core-1.0.7/contrast-catalog.json");
const CORE_CATALOG: CatalogContract<'static> = CatalogContract {
	commitment_schema_version: "aiq.corpus-commitment.v3",
	catalog_schema_version: CANDIDATE_CATALOG_SCHEMA_VERSION,
	task_set_id: AIQ_TASK_SET_ID,
	task_set_version: CANDIDATE_TASK_SET_VERSION,
	identity_sha256: AIQ_CORE_TASK_IDENTITY_SHA256,
	identity_scope: "ordered_full_task_metadata",
	tasks: CatalogTaskAuthority::Embedded(CORE_CATALOG_JSON),
};
const CONTRAST_TASK_IDS: [&str; 6] = [
	"contrast-coupled-challenge-01",
	"contrast-coupled-reference-01",
	"contrast-evidence-challenge-01",
	"contrast-evidence-reference-01",
	"contrast-recovery-challenge-01",
	"contrast-recovery-reference-01",
];
const CONTRAST_CATALOG: CatalogContract<'static> = CatalogContract {
	commitment_schema_version: "aiq.corpus-commitment.v2",
	catalog_schema_version: "aiq.contrast-corpus.v1",
	task_set_id: "aiq-core-contrast",
	task_set_version: CONTROLLED_CONTRAST_TASK_SET_VERSION,
	identity_sha256: CONTROLLED_CONTRAST_CATALOG_IDENTITY_SHA256,
	identity_scope: "ordered_full_task_metadata",
	tasks: CatalogTaskAuthority::FixedOrderedIds(&CONTRAST_TASK_IDS),
};

/// Explicit execution class selected before any benchmark work starts.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RunClass {
	/// Local best-effort calibration that can never become Official.
	Calibration,
	/// Complete non-synthetic 72-task by 17-model execution.
	Official,
}

#[derive(Clone, Copy)]
enum CatalogTaskAuthority {
	Embedded(&'static str),
	FixedOrderedIds(&'static [&'static str]),
}

/// Signed public-safe benchmark identities required to replay a real run.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RunProvenanceCommitment {
	/// Provenance contract version.
	pub schema_version: String,
	/// Explicit execution class.
	pub run_class: RunClass,
	/// Current controlled-corpus identifier.
	pub corpus_release_id: String,
	/// RFC 8785 SHA-256 commitment to the complete corpus commitment document.
	pub corpus_commitment_sha256: String,
	/// Frozen ordered full-catalog metadata commitment.
	pub catalog_digest: String,
	/// Content address of the selected task definitions.
	pub task_set_digest: String,
	/// Content address of the selected evaluator identities.
	pub evaluator_digest: String,
	/// Runner and result protocol commitment.
	pub runtime_digest: String,
	/// Exact capability-validation report commitment.
	pub preflight_digest: String,
	/// Controlled benchmark harness commitment.
	pub harness_digest: String,
	/// Exact runner prompt-source commitment.
	pub prompt_digest: String,
	/// Declared tool-policy commitment.
	pub tool_policy_digest: String,
	/// Declared network-policy commitment.
	pub network_policy_digest: String,
	/// Controlled execution-environment commitment.
	pub environment_digest: String,
	/// Runner build-and-test source-manifest commitment.
	pub source_manifest_digest: String,
	/// SHA-256 of the actual runner executable.
	pub runner_executable_digest: String,
	/// SHA-256 of the actual Codex executable.
	pub codex_executable_digest: String,
	/// SHA-256 of the sibling code-mode host executable used by Codex.
	pub codex_code_mode_host_digest: String,
	/// Deterministic digest of permission policy, requirements, profile, and canary evidence.
	pub permission_evidence_digest: String,
}

/// A corpus commitment after source and catalog validation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ValidatedCorpusCommitment {
	release_id: String,
	canonical_sha256: String,
	catalog_digest: String,
	harness_digest: String,
	prompt_digest: String,
	tool_policy_digest: String,
	network_policy_digest: String,
	environment_digest: String,
	source_manifest_digest: String,
	evaluator_runtime_executable_digest: String,
	evaluator_runtime_version: String,
	model_toolchain_policy: ExecutionToolPolicy,
	baseline_workspace_digests: BTreeMap<String, String>,
}
impl ValidatedCorpusCommitment {
	/// Returns the current corpus identifier.
	#[must_use]
	pub fn release_id(&self) -> &str {
		&self.release_id
	}

	/// Returns the canonical digest of the complete corpus commitment.
	#[must_use]
	pub fn canonical_sha256(&self) -> &str {
		&self.canonical_sha256
	}

	/// Returns the exact catalog identity committed by this corpus.
	#[must_use]
	pub fn catalog_digest(&self) -> &str {
		&self.catalog_digest
	}

	/// Returns the controlled harness commitment.
	#[must_use]
	pub fn harness_digest(&self) -> &str {
		&self.harness_digest
	}

	/// Returns the exact runner prompt-source commitment.
	#[must_use]
	pub fn prompt_digest(&self) -> &str {
		&self.prompt_digest
	}

	/// Returns the declared tool-policy commitment.
	#[must_use]
	pub fn tool_policy_digest(&self) -> &str {
		&self.tool_policy_digest
	}

	/// Returns the declared network-policy commitment.
	#[must_use]
	pub fn network_policy_digest(&self) -> &str {
		&self.network_policy_digest
	}

	/// Returns the controlled execution-environment commitment.
	#[must_use]
	pub fn environment_digest(&self) -> &str {
		&self.environment_digest
	}

	/// Returns the canonical source-manifest digest.
	#[must_use]
	pub fn source_manifest_digest(&self) -> &str {
		&self.source_manifest_digest
	}

	/// Returns the baseline-tree commitment for every selected task.
	#[must_use]
	pub fn baseline_workspace_digests(&self) -> &BTreeMap<String, String> {
		&self.baseline_workspace_digests
	}

	/// Checks the selected Node.js runtime against the committed execution provenance.
	pub fn validate_evaluator_runtime(
		&self,
		runtime: &EvaluatorRuntime,
	) -> Result<(), CorpusCommitmentError> {
		if runtime.executable_digest() != self.evaluator_runtime_executable_digest
			|| runtime.version() != self.evaluator_runtime_version
		{
			return Err(CorpusCommitmentError::new(
				"evaluator runtime does not match the corpus commitment",
			));
		}

		Ok(())
	}

	/// Validates the configured model toolchain against the committed policy.
	pub fn validate_model_toolchain(
		&self,
		root: &Path,
		runtime: &EvaluatorRuntime,
	) -> Result<ValidatedModelToolchain, CorpusCommitmentError> {
		validate_model_toolchain(root, &self.model_toolchain_policy, runtime)
	}

	/// Validates committed toolchain files without executing their version commands.
	pub fn validate_model_toolchain_static(
		&self,
		root: &Path,
		runtime: &EvaluatorRuntime,
	) -> Result<ValidatedModelToolchain, CorpusCommitmentError> {
		validate_model_toolchain_static(root, &self.model_toolchain_policy, runtime)
	}

	/// Builds the complete signed identity set for one selected run.
	#[must_use]
	#[allow(clippy::too_many_arguments)]
	pub fn run_provenance(
		&self,
		run_class: RunClass,
		task_set_digest: String,
		evaluator_digest: String,
		runtime_digest: String,
		preflight_digest: String,
		runner_executable_digest: String,
		codex_executable_digest: String,
		codex_code_mode_host_digest: String,
		permission_evidence_digest: String,
	) -> RunProvenanceCommitment {
		RunProvenanceCommitment {
			schema_version: "aiq.run-provenance.v3".to_owned(),
			run_class,
			corpus_release_id: self.release_id.clone(),
			corpus_commitment_sha256: self.canonical_sha256.clone(),
			catalog_digest: self.catalog_digest.clone(),
			task_set_digest,
			evaluator_digest,
			runtime_digest,
			preflight_digest,
			harness_digest: self.harness_digest.clone(),
			prompt_digest: self.prompt_digest.clone(),
			tool_policy_digest: self.tool_policy_digest.clone(),
			network_policy_digest: self.network_policy_digest.clone(),
			environment_digest: self.environment_digest.clone(),
			source_manifest_digest: self.source_manifest_digest.clone(),
			runner_executable_digest,
			codex_executable_digest,
			codex_code_mode_host_digest,
			permission_evidence_digest,
		}
	}
}

/// Corpus commitment validation failure.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CorpusCommitmentError {
	message: String,
}
impl CorpusCommitmentError {
	fn new(message: impl Into<String>) -> Self {
		Self { message: message.into() }
	}
}

impl Display for CorpusCommitmentError {
	fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
		formatter.write_str(&self.message)
	}
}

impl Error for CorpusCommitmentError {}

/// Committed model-visible command toolchain policy.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionToolPolicy {
	/// Policy schema.
	pub schema_version: String,
	/// Node platform token.
	pub platform: String,
	/// Node architecture token.
	pub architecture: String,
	/// Versioned fixed platform path mapping.
	pub platform_minimal_path: String,
	/// Ambient PATH inheritance is forbidden.
	pub inherit_path: bool,
	/// Shell profile loading is forbidden.
	pub use_shell_profile: bool,
	/// Ordered Node.js and ripgrep identities.
	pub commands: Vec<ToolchainCommand>,
}

/// One command exposed to model-generated shell commands.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ToolchainCommand {
	/// Stable command name.
	pub name: String,
	/// Exact root-relative executable filename.
	pub executable_ref: String,
	/// Executable SHA-256.
	pub executable_sha256: String,
	/// Exact bounded `--version` output.
	pub version: String,
}

/// Canonical validated model toolchain selected for one run.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ValidatedModelToolchain {
	root: PathBuf,
	policy: ExecutionToolPolicy,
	digest: String,
}
impl ValidatedModelToolchain {
	/// Canonical toolchain root.
	#[must_use]
	pub fn root(&self) -> &Path {
		&self.root
	}

	/// Exact execution policy.
	#[must_use]
	pub fn policy(&self) -> &ExecutionToolPolicy {
		&self.policy
	}

	/// Canonical policy digest.
	#[must_use]
	pub fn digest(&self) -> &str {
		&self.digest
	}

	/// Exact PATH supplied to Codex and model shells.
	#[must_use]
	pub fn path_value(&self) -> String {
		let separator = if cfg!(windows) { ";" } else { ":" };
		let mut entries = vec![self.root.display().to_string()];

		entries.extend(platform_minimal_path_entries().iter().map(ToString::to_string));

		entries.join(separator)
	}
}

#[derive(Clone, Copy)]
struct CatalogContract<'a> {
	commitment_schema_version: &'static str,
	catalog_schema_version: &'static str,
	task_set_id: &'static str,
	task_set_version: &'static str,
	identity_sha256: &'a str,
	identity_scope: &'static str,
	tasks: CatalogTaskAuthority,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CorpusCommitment {
	schema_version: String,
	release_id: String,
	controlled: bool,
	synthetic: bool,
	catalog: CorpusCatalog,
	execution: CorpusExecution,
	tasks: Vec<CorpusTask>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CorpusCatalog {
	schema_version: String,
	task_set_id: String,
	task_set_version: String,
	identity_sha256: String,
	identity_scope: String,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct CorpusExecution {
	harness_sha256: String,
	runner_prompt_source_sha256: String,
	declared_tool_policy_sha256: String,
	declared_network_policy_sha256: String,
	environment_sha256: String,
	runtime_provenance: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CorpusTask {
	task_id: String,
	task_version: String,
	task_definition_sha256: String,
	baseline_workspace_tree_sha256: String,
	fixture_bundle_sha256: String,
	catalog_entry_sha256: String,
	evaluator_runtime_kind: String,
	evaluator_runtime_executable_sha256: String,
	evaluator_executable_sha256: String,
	evaluator_configuration_sha256: String,
	acceptance_suite_sha256: String,
	leakage_review_sha256: String,
}

#[derive(Deserialize)]
struct FrozenCatalog {
	tasks: Vec<FrozenTask>,
}

#[derive(Deserialize)]
struct FrozenTask {
	task_id: String,
	task_version: String,
	allowed_tools: Vec<String>,
	budget: TaskBudgets,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SourceManifest {
	schema_version: String,
	package: String,
	scope: String,
	path_base: String,
	entries: Vec<SourceManifestEntry>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SourceManifestEntry {
	path: String,
	sha256: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RunnerRuntimeProvenance {
	identity_kind: String,
	source_manifest: Value,
	source_manifest_sha256: String,
	built_binary_sha256: Value,
}

#[cfg(test)]
pub(crate) fn fixture_model_toolchain(root: PathBuf) -> ValidatedModelToolchain {
	let (platform, architecture, minimal_path) =
		host_toolchain_identity().expect("test host toolchain identity");

	ValidatedModelToolchain {
		root,
		policy: ExecutionToolPolicy {
			schema_version: "aiq.execution-tool-policy.v1".to_owned(),
			platform: platform.to_owned(),
			architecture: architecture.to_owned(),
			platform_minimal_path: minimal_path.to_owned(),
			inherit_path: false,
			use_shell_profile: false,
			commands: vec![
				ToolchainCommand {
					name: "node".to_owned(),
					executable_ref: if cfg!(windows) { "node.exe" } else { "node" }.to_owned(),
					executable_sha256: format!("sha256:{}", "a".repeat(64)),
					version: "v0.0.0".to_owned(),
				},
				ToolchainCommand {
					name: "rg".to_owned(),
					executable_ref: if cfg!(windows) { "rg.exe" } else { "rg" }.to_owned(),
					executable_sha256: format!("sha256:{}", "b".repeat(64)),
					version: "ripgrep 0.0.0".to_owned(),
				},
			],
		},
		digest: format!("sha256:{}", "a".repeat(64)),
	}
}

#[cfg(test)]
pub(crate) fn fixture_validated_model_toolchain(
	root: &Path,
	runtime: &EvaluatorRuntime,
) -> ValidatedModelToolchain {
	let (platform, architecture, minimal_path) =
		host_toolchain_identity().expect("test host toolchain identity");
	let suffix = if cfg!(windows) { ".exe" } else { "" };
	let commands = ["node", "rg"]
		.into_iter()
		.map(|name| {
			let executable_ref = format!("{name}{suffix}");
			let path = root.join(&executable_ref);
			let digest = format!(
				"sha256:{}",
				hex::encode(Sha256::digest(fs::read(&path).expect("toolchain executable")))
			);
			let version = evaluator::probe_executable_version(&path, &["--version".to_owned()])
				.expect("toolchain version")
				.lines()
				.next()
				.expect("toolchain version line")
				.to_owned();

			ToolchainCommand {
				name: name.to_owned(),
				executable_ref,
				executable_sha256: digest,
				version,
			}
		})
		.collect();
	let policy = ExecutionToolPolicy {
		schema_version: "aiq.execution-tool-policy.v1".to_owned(),
		platform: platform.to_owned(),
		architecture: architecture.to_owned(),
		platform_minimal_path: minimal_path.to_owned(),
		inherit_path: false,
		use_shell_profile: false,
		commands,
	};

	validate_model_toolchain(root, &policy, runtime).expect("validated fixture toolchain")
}

#[cfg(test)]
pub(crate) fn fixture_run_provenance(
	task_set_digest: String,
	evaluator_digest: String,
	runtime_digest: String,
	preflight_digest: String,
) -> RunProvenanceCommitment {
	fixture_run_provenance_for_class(
		RunClass::Official,
		task_set_digest,
		evaluator_digest,
		runtime_digest,
		preflight_digest,
	)
}

#[cfg(test)]
pub(crate) fn fixture_run_provenance_for_class(
	run_class: RunClass,
	task_set_digest: String,
	evaluator_digest: String,
	runtime_digest: String,
	preflight_digest: String,
) -> RunProvenanceCommitment {
	RunProvenanceCommitment {
		schema_version: "aiq.run-provenance.v3".to_owned(),
		run_class,
		corpus_release_id: "corpus_fixture".to_owned(),
		corpus_commitment_sha256: format!("sha256:{}", "1".repeat(64)),
		catalog_digest: AIQ_CORE_TASK_IDENTITY_SHA256.to_owned(),
		task_set_digest,
		evaluator_digest,
		runtime_digest,
		preflight_digest,
		harness_digest: format!("sha256:{}", "2".repeat(64)),
		prompt_digest: format!("sha256:{}", "3".repeat(64)),
		tool_policy_digest: format!("sha256:{}", "4".repeat(64)),
		network_policy_digest: format!("sha256:{}", "5".repeat(64)),
		environment_digest: format!("sha256:{}", "6".repeat(64)),
		source_manifest_digest: format!("sha256:{}", "7".repeat(64)),
		runner_executable_digest: format!("sha256:{}", "8".repeat(64)),
		codex_executable_digest: format!("sha256:{}", "9".repeat(64)),
		codex_code_mode_host_digest: format!("sha256:{}", "b".repeat(64)),
		permission_evidence_digest: format!("sha256:{}", "a".repeat(64)),
	}
}

/// Verifies the corpus document identity and its committed evaluator runtime.
pub fn validate_evaluator_runtime_commitment(
	path: &Path,
	expected_canonical_sha256: &str,
	runtime: &EvaluatorRuntime,
	toolchain_root: &Path,
) -> Result<(), CorpusCommitmentError> {
	let metadata = fs::symlink_metadata(path)
		.map_err(|_| CorpusCommitmentError::new("corpus commitment is unavailable"))?;

	if metadata.file_type().is_symlink()
		|| !metadata.is_file()
		|| metadata.len() == 0
		|| metadata.len() > 4 * 1_024 * 1_024
	{
		return Err(CorpusCommitmentError::new("corpus commitment must be a bounded regular file"));
	}

	let value: Value = serde_json::from_slice(&fs::read(path).map_err(|error| {
		CorpusCommitmentError::new(format!("cannot read corpus commitment: {error}"))
	})?)
	.map_err(|error| CorpusCommitmentError::new(format!("invalid corpus commitment: {error}")))?;
	let observed = protocol::canonical_hash(&value).map_err(|error| {
		CorpusCommitmentError::new(format!("cannot hash corpus commitment: {error}"))
	})?;

	if observed != expected_canonical_sha256
		|| value.pointer("/schema_version").and_then(Value::as_str)
			!= Some("aiq.corpus-commitment.v3")
		|| value
			.pointer("/execution/runtime_provenance/node_runtime/executable_sha256")
			.and_then(Value::as_str)
			!= Some(runtime.executable_digest())
		|| value
			.pointer("/execution/runtime_provenance/node_runtime/version")
			.and_then(Value::as_str)
			!= Some(runtime.version())
	{
		return Err(CorpusCommitmentError::new(
			"evaluator runtime or corpus identity does not match the signed provenance",
		));
	}

	let policy: ExecutionToolPolicy = serde_json::from_value(
		value
			.pointer("/execution/runtime_provenance/model_toolchain")
			.cloned()
			.ok_or_else(|| CorpusCommitmentError::new("corpus commitment omits model toolchain"))?,
	)
	.map_err(|_| CorpusCommitmentError::new("corpus model toolchain policy is invalid"))?;
	let commitment: CorpusCommitment = serde_json::from_value(value.clone())
		.map_err(|_| CorpusCommitmentError::new("corpus commitment v3 shape is invalid"))?;
	let catalog_contract = catalog_contract(&commitment.catalog)?;
	let runner_provenance =
		validate_runner_runtime_provenance(&commitment.execution.runtime_provenance)?;

	validate_deterministic_execution_digests(
		&commitment.execution,
		&runner_provenance.source_manifest,
		&policy,
		catalog_contract,
		None,
	)?;
	validate_model_toolchain(toolchain_root, &policy, runtime)?;

	Ok(())
}

/// Reads the strict execution tool policy from the schema selected by the isolated run route.
pub fn read_execution_tool_policy(
	path: &Path,
	_candidate_qualification: bool,
) -> Result<ExecutionToolPolicy, CorpusCommitmentError> {
	let metadata = fs::symlink_metadata(path)
		.map_err(|_| CorpusCommitmentError::new("corpus commitment is unavailable"))?;

	if metadata.file_type().is_symlink()
		|| !metadata.is_file()
		|| metadata.len() == 0
		|| metadata.len() > 4 * 1_024 * 1_024
	{
		return Err(CorpusCommitmentError::new("corpus commitment must be a bounded regular file"));
	}

	let value: Value = serde_json::from_slice(&fs::read(path).map_err(|error| {
		CorpusCommitmentError::new(format!("cannot read corpus commitment: {error}"))
	})?)
	.map_err(|error| CorpusCommitmentError::new(format!("invalid corpus commitment: {error}")))?;

	if value.pointer("/schema_version").and_then(Value::as_str) != Some("aiq.corpus-commitment.v3")
	{
		return Err(CorpusCommitmentError::new("corpus commitment schema is not v3"));
	}

	serde_json::from_value(
		value
			.pointer("/execution/runtime_provenance/model_toolchain")
			.cloned()
			.ok_or_else(|| CorpusCommitmentError::new("corpus commitment omits model toolchain"))?,
	)
	.map_err(|_| CorpusCommitmentError::new("corpus model toolchain policy is invalid"))
}

/// Validates the exact model-visible Node.js and ripgrep toolchain.
pub fn validate_model_toolchain(
	root: &Path,
	policy: &ExecutionToolPolicy,
	evaluator_runtime: &EvaluatorRuntime,
) -> Result<ValidatedModelToolchain, CorpusCommitmentError> {
	validate_model_toolchain_impl(root, policy, evaluator_runtime, true)
}

/// Validates committed toolchain paths and bytes without executing them.
pub fn validate_model_toolchain_static(
	root: &Path,
	policy: &ExecutionToolPolicy,
	evaluator_runtime: &EvaluatorRuntime,
) -> Result<ValidatedModelToolchain, CorpusCommitmentError> {
	validate_model_toolchain_impl(root, policy, evaluator_runtime, false)
}

/// Loads and validates the current public commitment before any model invocation.
pub fn validate_corpus_commitment(
	path: &Path,
	tasks: &[TaskDefinition],
	source_root: &Path,
) -> Result<ValidatedCorpusCommitment, CorpusCommitmentError> {
	validate_candidate_core_corpus_commitment_v1_1_0(path, tasks, source_root)
}

/// Loads and validates the immutable 72-task AIQ Core 1.1.0 corpus.
pub fn validate_core_corpus_commitment(
	path: &Path,
	tasks: &[TaskDefinition],
	source_root: &Path,
) -> Result<ValidatedCorpusCommitment, CorpusCommitmentError> {
	validate_candidate_core_corpus_commitment_v1_1_0(path, tasks, source_root)
}

/// Loads and validates an isolated AIQ Core 1.1.0 candidate commitment.
///
/// The retained name keeps candidate qualification evidence readable. The same
/// checked authority is now the active AIQ Core 1.1.0 production corpus.
pub fn validate_candidate_core_corpus_commitment_v1_1_0(
	path: &Path,
	tasks: &[TaskDefinition],
	source_root: &Path,
) -> Result<ValidatedCorpusCommitment, CorpusCommitmentError> {
	let authority = validated_candidate_core_catalog()?;

	validate_corpus_commitment_inner(
		path,
		tasks,
		source_root,
		candidate_core_catalog_contract(&authority),
	)
}

/// Loads the six controlled AIQ Core 1.0.7 contrast variants.
///
/// The caller supplies the expected canonical commitment digest. Contrast tasks
/// are calibration-only and are not part of the 72-task core catalog.
pub fn validate_contrast_corpus_commitment(
	path: &Path,
	tasks: &[TaskDefinition],
	source_root: &Path,
	expected_canonical_sha256: &str,
) -> Result<ValidatedCorpusCommitment, CorpusCommitmentError> {
	if !valid_digest(expected_canonical_sha256) {
		return Err(CorpusCommitmentError::new("contrast corpus digest is invalid"));
	}

	let validated = validate_corpus_commitment_inner(path, tasks, source_root, CONTRAST_CATALOG)?;

	if validated.canonical_sha256() != expected_canonical_sha256 {
		return Err(CorpusCommitmentError::new(
			"contrast corpus does not match the expected canonical commitment",
		));
	}

	Ok(validated)
}

/// Computes the ordered selected evaluator identity commitment.
pub fn evaluator_digest(tasks: &[TaskDefinition]) -> Result<String, CorpusCommitmentError> {
	protocol::canonical_hash(
		&tasks
			.iter()
			.map(|task| (&task.task_id, &task.scorer_version, &task.evaluator))
			.collect::<Vec<_>>(),
	)
	.map_err(|error| {
		CorpusCommitmentError::new(format!("cannot hash evaluator identities: {error}"))
	})
}

/// Validates a signed production provenance object and its run-local bindings.
pub fn validate_run_provenance(
	provenance: &RunProvenanceCommitment,
	task_set_hash: &str,
	preflight_digest: &str,
) -> Result<(), CorpusCommitmentError> {
	validate_run_provenance_inner(provenance, task_set_hash, preflight_digest, false)
}

/// Validates retained calibration provenance for an offline diagnostic.
///
/// Historical catalog identities are accepted only for calibration records.
/// The normal production validator remains strict, and diagnostic output is
/// never an Official or ranking input.
pub fn validate_historical_calibration_provenance(
	provenance: &RunProvenanceCommitment,
	task_set_hash: &str,
	preflight_digest: &str,
) -> Result<(), CorpusCommitmentError> {
	validate_run_provenance_inner(provenance, task_set_hash, preflight_digest, true)
}

/// Validates the isolated AIQ Core 1.1.0 candidate qualification provenance.
///
/// This boundary accepts only Calibration evidence for the exact embedded candidate. Active
/// production uses the same task authority through the ordinary run-provenance validator.
pub fn validate_candidate_qualification_provenance_v1_1_0(
	provenance: &RunProvenanceCommitment,
	task_set_hash: &str,
	preflight_digest: &str,
) -> Result<(), CorpusCommitmentError> {
	let authority = validated_candidate_core_catalog()?;

	if provenance.run_class != RunClass::Calibration
		|| provenance.catalog_digest != authority.task_metadata_digest
	{
		return Err(CorpusCommitmentError::new(
			"candidate qualification provenance does not match the exact embedded candidate",
		));
	}

	validate_run_provenance_inner(provenance, task_set_hash, preflight_digest, true)
}

/// Hashes the actual runner executable without recording its path.
pub fn runner_executable_digest() -> Result<String, CorpusCommitmentError> {
	current_executable_digest("runner executable")
}

/// Hashes the executable for the current process without recording its path.
pub fn current_executable_digest(label: &str) -> Result<String, CorpusCommitmentError> {
	let path = env::current_exe()
		.map_err(|_| CorpusCommitmentError::new(format!("{label} cannot be resolved")))?;

	hash_executable(&path, label)
}

/// Resolves and hashes the exact Codex selector without recording its path.
pub fn codex_executable_digest(selector: &str) -> Result<String, CorpusCommitmentError> {
	let candidate = resolve_codex_executable(selector)?;

	hash_executable(&candidate, "Codex executable")
}

/// Resolves and hashes the required sibling code-mode host used by the selected Codex CLI.
pub fn codex_code_mode_host_digest(selector: &str) -> Result<String, CorpusCommitmentError> {
	let candidate = codex_code_mode_host_path(selector)?;

	hash_executable(&candidate, "Codex code-mode host executable")
}

/// Resolves the required code-mode host from an exact two-file Codex runtime directory.
pub fn codex_code_mode_host_path(selector: &str) -> Result<PathBuf, CorpusCommitmentError> {
	let codex = resolve_codex_executable(selector)?;
	let parent = codex
		.parent()
		.ok_or_else(|| CorpusCommitmentError::new("Codex executable has no runtime directory"))?;
	let parent_metadata = fs::symlink_metadata(parent)
		.map_err(|_| CorpusCommitmentError::new("Codex runtime directory is unavailable"))?;

	if parent_metadata.file_type().is_symlink() || !parent_metadata.is_dir() {
		return Err(CorpusCommitmentError::new(
			"Codex runtime directory must be a non-symlink directory",
		));
	}
	#[cfg(unix)]
	if PermissionsExt::mode(&parent_metadata.permissions()) & 0o022 != 0 {
		return Err(CorpusCommitmentError::new(
			"Codex runtime directory must not be group- or other-writable",
		));
	}

	let mut entries = fs::read_dir(parent)
		.map_err(|_| CorpusCommitmentError::new("Codex runtime directory cannot be read"))?
		.collect::<Result<Vec<_>, _>>()
		.map_err(|_| CorpusCommitmentError::new("Codex runtime directory cannot be read"))?;

	entries.sort_by_key(DirEntry::file_name);

	let mut expected = vec![
		CODEX_MAIN_EXECUTABLE_NAME.to_owned(),
		CODEX_CODE_MODE_HOST_EXECUTABLE_NAME.to_owned(),
	];

	expected.sort();

	if entries
		.iter()
		.map(|entry| entry.file_name().to_string_lossy().into_owned())
		.collect::<Vec<_>>()
		!= expected
		|| codex.file_name().and_then(|name| name.to_str()) != Some(CODEX_MAIN_EXECUTABLE_NAME)
	{
		return Err(CorpusCommitmentError::new(
			"Codex runtime directory must contain exactly the main executable and code-mode host",
		));
	}

	let host = parent.join(CODEX_CODE_MODE_HOST_EXECUTABLE_NAME);

	hash_executable(&codex, "Codex executable")?;
	hash_executable(&host, "Codex code-mode host executable")?;

	Ok(host)
}

fn validated_candidate_core_catalog() -> Result<CandidateCatalogAuthority, CorpusCommitmentError> {
	let value: Value = serde_json::from_str(CANDIDATE_CORE_CATALOG_JSON).map_err(|error| {
		CorpusCommitmentError::new(format!("embedded candidate catalog is invalid: {error}"))
	})?;
	let authority = candidate_catalog::validate_candidate_catalog(&value).map_err(|error| {
		CorpusCommitmentError::new(format!("embedded candidate catalog is invalid: {error}"))
	})?;

	authority.require_frozen_candidate().map_err(|error| {
		CorpusCommitmentError::new(format!("embedded candidate catalog is not sealable: {error}"))
	})?;

	Ok(authority)
}

fn candidate_core_catalog_contract(authority: &CandidateCatalogAuthority) -> CatalogContract<'_> {
	CatalogContract {
		commitment_schema_version: "aiq.corpus-commitment.v3",
		catalog_schema_version: CANDIDATE_CATALOG_SCHEMA_VERSION,
		task_set_id: AIQ_TASK_SET_ID,
		task_set_version: CANDIDATE_TASK_SET_VERSION,
		identity_sha256: &authority.task_metadata_digest,
		identity_scope: "ordered_full_task_metadata",
		tasks: CatalogTaskAuthority::Embedded(CANDIDATE_CORE_CATALOG_JSON),
	}
}

fn resolve_codex_executable(selector: &str) -> Result<PathBuf, CorpusCommitmentError> {
	if selector.trim().is_empty() {
		return Err(CorpusCommitmentError::new("Codex executable selector is empty"));
	}

	let candidate = if Path::new(selector).components().count() > 1 {
		Path::new(selector).to_path_buf()
	} else {
		env::split_paths(
			&env::var_os("PATH")
				.ok_or_else(|| CorpusCommitmentError::new("PATH is unavailable"))?,
		)
		.map(|directory| directory.join(selector))
		.find(|candidate| candidate.exists())
		.ok_or_else(|| CorpusCommitmentError::new("Codex executable cannot be resolved"))?
	};

	fs::canonicalize(candidate)
		.map_err(|_| CorpusCommitmentError::new("Codex executable cannot be resolved"))
}

fn validate_run_provenance_inner(
	provenance: &RunProvenanceCommitment,
	task_set_hash: &str,
	preflight_digest: &str,
	allow_historical_calibration_catalog: bool,
) -> Result<(), CorpusCommitmentError> {
	let catalog_allowed =
		if allow_historical_calibration_catalog && provenance.run_class == RunClass::Calibration {
			valid_digest(&provenance.catalog_digest)
		} else {
			match provenance.run_class {
				RunClass::Official => provenance.catalog_digest == AIQ_CORE_TASK_IDENTITY_SHA256,
				RunClass::Calibration => {
					provenance.catalog_digest == AIQ_CORE_TASK_IDENTITY_SHA256
						|| provenance.catalog_digest == CONTRAST_CATALOG.identity_sha256
				},
			}
		};

	if provenance.schema_version != "aiq.run-provenance.v3"
		|| !catalog_allowed
		|| provenance.task_set_digest != task_set_hash
		|| provenance.preflight_digest != preflight_digest
		|| !valid_release_id(&provenance.corpus_release_id)
	{
		return Err(CorpusCommitmentError::new("signed run provenance bindings are invalid"));
	}

	for digest in [
		&provenance.corpus_commitment_sha256,
		&provenance.catalog_digest,
		&provenance.task_set_digest,
		&provenance.evaluator_digest,
		&provenance.runtime_digest,
		&provenance.preflight_digest,
		&provenance.harness_digest,
		&provenance.prompt_digest,
		&provenance.tool_policy_digest,
		&provenance.network_policy_digest,
		&provenance.environment_digest,
		&provenance.source_manifest_digest,
		&provenance.runner_executable_digest,
		&provenance.codex_executable_digest,
		&provenance.codex_code_mode_host_digest,
		&provenance.permission_evidence_digest,
	] {
		if !valid_digest(digest) {
			return Err(CorpusCommitmentError::new(
				"signed run provenance contains an invalid digest",
			));
		}
	}

	Ok(())
}

fn validate_model_toolchain_impl(
	root: &Path,
	policy: &ExecutionToolPolicy,
	evaluator_runtime: &EvaluatorRuntime,
	probe_versions: bool,
) -> Result<ValidatedModelToolchain, CorpusCommitmentError> {
	if !root.is_absolute() {
		return Err(CorpusCommitmentError::new("Codex toolchain root must be absolute"));
	}

	let metadata = fs::symlink_metadata(root)
		.map_err(|_| CorpusCommitmentError::new("Codex toolchain root is unavailable"))?;

	if metadata.file_type().is_symlink() || !metadata.is_dir() {
		return Err(CorpusCommitmentError::new("Codex toolchain root must be a regular directory"));
	}

	let root = fs::canonicalize(root)
		.map_err(|_| CorpusCommitmentError::new("Codex toolchain root cannot be resolved"))?;
	let (platform, architecture, minimal_path) = host_toolchain_identity()?;
	let executable_suffix = if cfg!(windows) { ".exe" } else { "" };
	let expected_refs = [format!("node{executable_suffix}"), format!("rg{executable_suffix}")];

	if policy.schema_version != "aiq.execution-tool-policy.v1"
		|| policy.platform != platform
		|| policy.architecture != architecture
		|| policy.platform_minimal_path != minimal_path
		|| policy.inherit_path
		|| policy.use_shell_profile
		|| policy.commands.len() != 2
		|| policy.commands[0].name != "node"
		|| policy.commands[1].name != "rg"
		|| policy.commands[0].executable_ref != expected_refs[0]
		|| policy.commands[1].executable_ref != expected_refs[1]
	{
		return Err(CorpusCommitmentError::new(
			"model toolchain policy is incompatible with this host",
		));
	}

	let mut entries = fs::read_dir(&root)
		.map_err(|_| CorpusCommitmentError::new("Codex toolchain root cannot be read"))?
		.collect::<Result<Vec<_>, _>>()
		.map_err(|_| CorpusCommitmentError::new("Codex toolchain entries cannot be read"))?;

	entries.sort_by_key(DirEntry::file_name);

	if entries.len() != 2
		|| entries
			.iter()
			.map(|entry| entry.file_name().to_string_lossy().into_owned())
			.collect::<Vec<_>>()
			!= expected_refs
	{
		return Err(CorpusCommitmentError::new(
			"Codex toolchain root must contain exactly the committed executables",
		));
	}

	for (command, entry) in policy.commands.iter().zip(entries) {
		let path = entry.path();
		let metadata = fs::symlink_metadata(&path)
			.map_err(|_| CorpusCommitmentError::new("Codex toolchain executable is unavailable"))?;

		if metadata.file_type().is_symlink() || !metadata.is_file() {
			return Err(CorpusCommitmentError::new(
				"Codex toolchain entries must be regular executable files",
			));
		}
		#[cfg(unix)]
		if PermissionsExt::mode(&metadata.permissions()) & 0o111 == 0 {
			return Err(CorpusCommitmentError::new("Codex toolchain entry is not executable"));
		}

		let canonical = fs::canonicalize(&path).map_err(|_| {
			CorpusCommitmentError::new("Codex toolchain executable cannot be resolved")
		})?;
		let digest = format!(
			"sha256:{}",
			hex::encode(Sha256::digest(fs::read(&canonical).map_err(|_| {
				CorpusCommitmentError::new("Codex toolchain executable cannot be read")
			},)?))
		);
		let observed_version = if probe_versions {
			let output = evaluator::probe_executable_version(&canonical, &["--version".to_owned()])
				.map_err(|error| CorpusCommitmentError::new(error.to_string()))?;

			output.lines().next().unwrap_or_default().to_owned()
		} else {
			command.version.clone()
		};
		let version = observed_version.as_str();

		if digest != command.executable_sha256 || version != command.version {
			return Err(CorpusCommitmentError::new(
				"Codex toolchain executable identity does not match its commitment",
			));
		}
		if command.name == "node"
			&& (canonical != evaluator_runtime.executable()
				|| digest != evaluator_runtime.executable_digest()
				|| version != evaluator_runtime.version())
		{
			return Err(CorpusCommitmentError::new(
				"model and evaluator Node.js runtimes must have one exact identity",
			));
		}
	}

	let digest = protocol::canonical_hash(policy)
		.map_err(|error| CorpusCommitmentError::new(error.to_string()))?;

	Ok(ValidatedModelToolchain { root, policy: policy.clone(), digest })
}

fn validate_corpus_commitment_inner(
	path: &Path,
	tasks: &[TaskDefinition],
	source_root: &Path,
	catalog_contract: CatalogContract<'_>,
) -> Result<ValidatedCorpusCommitment, CorpusCommitmentError> {
	let metadata = fs::symlink_metadata(path)
		.map_err(|_| CorpusCommitmentError::new("corpus commitment is unavailable"))?;

	if metadata.file_type().is_symlink()
		|| !metadata.is_file()
		|| metadata.len() == 0
		|| metadata.len() > 4 * 1_024 * 1_024
	{
		return Err(CorpusCommitmentError::new("corpus commitment must be a bounded regular file"));
	}

	let bytes = fs::read(path).map_err(|error| {
		CorpusCommitmentError::new(format!("cannot read corpus commitment: {error}"))
	})?;
	let value: Value = serde_json::from_slice(&bytes).map_err(|error| {
		CorpusCommitmentError::new(format!("invalid corpus commitment: {error}"))
	})?;
	let canonical_sha256 = protocol::canonical_hash(&value).map_err(|error| {
		CorpusCommitmentError::new(format!("cannot hash corpus commitment: {error}"))
	})?;
	let commitment: CorpusCommitment = serde_json::from_value(value).map_err(|error| {
		CorpusCommitmentError::new(format!("invalid corpus commitment: {error}"))
	})?;

	validate_header(&commitment, catalog_contract)?;
	validate_catalog_tasks(&commitment.tasks, catalog_contract)?;
	validate_selected_catalog_budgets(tasks, catalog_contract)?;

	let baseline_workspace_digests = validate_selected_tasks(&commitment.tasks, tasks)?;
	let runner_provenance =
		validate_runner_runtime_provenance(&commitment.execution.runtime_provenance)?;
	let source_manifest = &runner_provenance.source_manifest;
	let source_manifest_digest = &runner_provenance.source_manifest_sha256;
	let evaluator_runtime_executable_digest = string_at(
		&commitment.execution.runtime_provenance,
		"/node_runtime/executable_sha256",
		"evaluator runtime executable digest",
	)?;
	let evaluator_runtime_version = bounded_string_at(
		&commitment.execution.runtime_provenance,
		"/node_runtime/version",
		"evaluator runtime version",
	)?;
	let model_toolchain_policy: ExecutionToolPolicy = serde_json::from_value(
		commitment
			.execution
			.runtime_provenance
			.pointer("/model_toolchain")
			.cloned()
			.ok_or_else(|| CorpusCommitmentError::new("corpus commitment omits model toolchain"))?,
	)
	.map_err(|_| CorpusCommitmentError::new("corpus model toolchain policy is invalid"))?;

	if !valid_digest(evaluator_runtime_executable_digest)
		|| evaluator_runtime_version.is_empty()
		|| evaluator_runtime_version.len() > 128
	{
		return Err(CorpusCommitmentError::new("corpus evaluator runtime identity is invalid"));
	}

	validate_deterministic_execution_digests(
		&commitment.execution,
		source_manifest,
		&model_toolchain_policy,
		catalog_contract,
		Some(tasks),
	)?;

	let source_manifest: SourceManifest = serde_json::from_value(source_manifest.clone())
		.map_err(|_| CorpusCommitmentError::new("runner source manifest is invalid"))?;

	validate_source_manifest(&source_manifest, source_root)?;

	// The harness aggregate also covers controlled materializer, evaluator, and schema bytes that
	// are not deployed with the runner. The canonical corpus identity binds that digest;
	// the runner independently recomputes every deterministic public execution digest above.
	Ok(ValidatedCorpusCommitment {
		release_id: commitment.release_id,
		canonical_sha256,
		catalog_digest: catalog_contract.identity_sha256.to_owned(),
		harness_digest: commitment.execution.harness_sha256,
		prompt_digest: commitment.execution.runner_prompt_source_sha256,
		tool_policy_digest: commitment.execution.declared_tool_policy_sha256,
		network_policy_digest: commitment.execution.declared_network_policy_sha256,
		environment_digest: commitment.execution.environment_sha256,
		source_manifest_digest: source_manifest_digest.clone(),
		evaluator_runtime_executable_digest: evaluator_runtime_executable_digest.to_owned(),
		evaluator_runtime_version: evaluator_runtime_version.to_owned(),
		model_toolchain_policy,
		baseline_workspace_digests,
	})
}

fn validate_runner_runtime_provenance(
	runtime_provenance: &Value,
) -> Result<RunnerRuntimeProvenance, CorpusCommitmentError> {
	let runner: RunnerRuntimeProvenance =
		serde_json::from_value(runtime_provenance.pointer("/runner").cloned().ok_or_else(
			|| CorpusCommitmentError::new("corpus commitment omits runner provenance"),
		)?)
		.map_err(|_| CorpusCommitmentError::new("runner runtime provenance contract is invalid"))?;

	if runner.identity_kind != "source_only" || !runner.built_binary_sha256.is_null() {
		return Err(CorpusCommitmentError::new(
			"runner runtime provenance must use source-only identity",
		));
	}
	if !valid_digest(&runner.source_manifest_sha256) {
		return Err(CorpusCommitmentError::new(
			"corpus commitment has an invalid runner source-manifest digest",
		));
	}

	let observed_source_manifest =
		protocol::canonical_hash(&runner.source_manifest).map_err(|error| {
			CorpusCommitmentError::new(format!("cannot hash runner source manifest: {error}"))
		})?;

	if observed_source_manifest != runner.source_manifest_sha256 {
		return Err(CorpusCommitmentError::new(
			"runner source manifest does not match its commitment",
		));
	}

	Ok(runner)
}

fn host_toolchain_identity()
-> Result<(&'static str, &'static str, &'static str), CorpusCommitmentError> {
	let platform = match OS {
		"macos" => "darwin",
		"linux" => "linux",
		"windows" => "win32",
		_ => return Err(CorpusCommitmentError::new("unsupported model toolchain platform")),
	};
	let architecture = match ARCH {
		"aarch64" => "arm64",
		"x86_64" => "x64",
		_ => return Err(CorpusCommitmentError::new("unsupported model toolchain architecture")),
	};
	let minimal = match platform {
		"darwin" => "darwin_v1",
		"linux" => "linux_v1",
		"win32" => "windows_v1",
		_ => unreachable!(),
	};

	Ok((platform, architecture, minimal))
}

fn platform_minimal_path_entries() -> &'static [&'static str] {
	#[cfg(target_os = "macos")]
	let entries = &["/usr/bin", "/bin", "/usr/sbin", "/sbin"][..];
	#[cfg(target_os = "linux")]
	let entries = &["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"][..];
	#[cfg(target_os = "windows")]
	let entries = &[r"C:\Windows\System32", r"C:\Windows"][..];
	#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
	let entries = &[];

	entries
}

fn catalog_tool_policy_tasks(
	catalog_contract: CatalogContract<'_>,
	selected_tasks: Option<&[TaskDefinition]>,
) -> Result<Vec<Value>, CorpusCommitmentError> {
	match catalog_contract.tasks {
		CatalogTaskAuthority::Embedded(catalog_json) => {
			let catalog: FrozenCatalog = serde_json::from_str(catalog_json).map_err(|error| {
				CorpusCommitmentError::new(format!("embedded catalog is invalid: {error}"))
			})?;

			Ok(catalog
				.tasks
				.into_iter()
				.map(|task| {
					serde_json::json!({
						"task_id": task.task_id,
						"allowed_tools": task.allowed_tools,
					})
				})
				.collect())
		},
		CatalogTaskAuthority::FixedOrderedIds(expected_ids) => {
			let tasks = selected_tasks.ok_or_else(|| {
				CorpusCommitmentError::new("contrast tool policy requires the exact selected tasks")
			})?;

			if tasks.len() != expected_ids.len()
				|| tasks.iter().zip(expected_ids).any(|(task, expected)| task.task_id != *expected)
			{
				return Err(CorpusCommitmentError::new(
					"contrast tasks are missing, duplicated, or reordered",
				));
			}

			Ok(tasks
				.iter()
				.map(|task| {
					serde_json::json!({
						"task_id": task.task_id,
						"allowed_tools": task.allowed_tools,
					})
				})
				.collect())
		},
	}
}

fn validate_controlled_openssl_environment(
	runtime_provenance: &Value,
	model_toolchain_policy: &ExecutionToolPolicy,
) -> Result<(), CorpusCommitmentError> {
	let operating_system_platform = runtime_provenance
		.pointer("/operating_system/platform")
		.and_then(Value::as_str)
		.ok_or_else(|| {
			CorpusCommitmentError::new("corpus commitment omits operating-system platform")
		})?;
	let openssl_conf = runtime_provenance
		.pointer("/locale_and_timezone/environment/OPENSSL_CONF")
		.and_then(Value::as_str)
		.ok_or_else(|| {
			CorpusCommitmentError::new("corpus commitment omits controlled OpenSSL configuration")
		})?;

	if operating_system_platform != model_toolchain_policy.platform {
		return Err(CorpusCommitmentError::new(
			"corpus operating-system platform does not match the model toolchain",
		));
	}

	let expected = match model_toolchain_policy.platform.as_str() {
		"darwin" | "linux" => "/dev/null",
		"win32" => "NUL",
		_ => {
			return Err(CorpusCommitmentError::new(
				"corpus commitment has an unsupported OpenSSL platform",
			));
		},
	};

	if openssl_conf != expected {
		return Err(CorpusCommitmentError::new(
			"corpus OpenSSL configuration does not match the model toolchain platform",
		));
	}

	Ok(())
}

fn validate_deterministic_execution_digests(
	execution: &CorpusExecution,
	source_manifest: &Value,
	model_toolchain_policy: &ExecutionToolPolicy,
	catalog_contract: CatalogContract<'_>,
	selected_tasks: Option<&[TaskDefinition]>,
) -> Result<(), CorpusCommitmentError> {
	validate_controlled_openssl_environment(&execution.runtime_provenance, model_toolchain_policy)?;

	let tool_policy_tasks = catalog_tool_policy_tasks(catalog_contract, selected_tasks)?;
	let observed_environment = protocol::canonical_hash(&execution.runtime_provenance)
		.map_err(|error| CorpusCommitmentError::new(error.to_string()))?;
	let runner_prompt = source_manifest
		.pointer("/entries")
		.and_then(Value::as_array)
		.and_then(|entries| {
			entries.iter().find(|entry| {
				entry.pointer("/path").and_then(Value::as_str)
					== Some("apps/aiq-runner/src/runner.rs")
			})
		})
		.and_then(|entry| entry.pointer("/sha256").and_then(Value::as_str))
		.ok_or_else(|| CorpusCommitmentError::new("runner source manifest omits runner.rs"))?;
	let observed_tool_policy = protocol::canonical_hash(&serde_json::json!({
		"protocol": "aiq.tool-policy.v1",
		"evidence_class": "declared_policy_commitment",
		"catalog": tool_policy_tasks,
		"model_toolchain": model_toolchain_policy,
	}))
	.map_err(|error| CorpusCommitmentError::new(error.to_string()))?;
	let observed_network_policy = protocol::canonical_hash(&serde_json::json!({
		"protocol": "aiq.network-policy.v1",
		"evidence_class": "declared_policy_commitment",
		"codex_web_search": "disabled_for_controlled_corpus",
		"codex_mcp": "disabled",
		"evaluator_node_scenario": "network_denied_by_node_permission_model",
	}))
	.map_err(|error| CorpusCommitmentError::new(error.to_string()))?;

	if execution.environment_sha256 != observed_environment
		|| execution.runner_prompt_source_sha256 != runner_prompt
		|| execution.declared_tool_policy_sha256 != observed_tool_policy
		|| execution.declared_network_policy_sha256 != observed_network_policy
	{
		return Err(CorpusCommitmentError::new(
			"corpus deterministic execution digests do not match their source values",
		));
	}

	Ok(())
}

fn validate_header(
	commitment: &CorpusCommitment,
	catalog_contract: CatalogContract<'_>,
) -> Result<(), CorpusCommitmentError> {
	let catalog = &commitment.catalog;

	if commitment.schema_version != catalog_contract.commitment_schema_version
		|| !valid_release_id(&commitment.release_id)
		|| !commitment.controlled
		|| commitment.synthetic
		|| catalog.schema_version != catalog_contract.catalog_schema_version
		|| catalog.task_set_id != catalog_contract.task_set_id
		|| catalog.task_set_version != catalog_contract.task_set_version
		|| catalog.identity_sha256 != catalog_contract.identity_sha256
		|| catalog.identity_scope != catalog_contract.identity_scope
	{
		return Err(CorpusCommitmentError::new("corpus commitment header is invalid"));
	}

	for digest in [
		&commitment.execution.harness_sha256,
		&commitment.execution.runner_prompt_source_sha256,
		&commitment.execution.declared_tool_policy_sha256,
		&commitment.execution.declared_network_policy_sha256,
		&commitment.execution.environment_sha256,
	] {
		if !valid_digest(digest) {
			return Err(CorpusCommitmentError::new(
				"corpus execution identity is not a valid SHA-256 commitment",
			));
		}
	}

	Ok(())
}

fn catalog_contract(
	catalog: &CorpusCatalog,
) -> Result<CatalogContract<'static>, CorpusCommitmentError> {
	[CORE_CATALOG]
		.into_iter()
		.find(|contract| {
			catalog.task_set_id == AIQ_TASK_SET_ID
				&& catalog.task_set_version == contract.task_set_version
				&& catalog.identity_sha256 == contract.identity_sha256
		})
		.ok_or_else(|| CorpusCommitmentError::new("corpus catalog identity is unsupported"))
}

fn validate_source_manifest(
	manifest: &SourceManifest,
	source_root: &Path,
) -> Result<(), CorpusCommitmentError> {
	if manifest.schema_version != "aiq.runner-source-manifest.v1"
		|| manifest.package != "aiq-runner"
		|| manifest.scope != "cargo_build_and_test_inputs"
		|| manifest.path_base != "repository_root"
		|| manifest.entries.is_empty()
		|| manifest.entries.len() > 128
	{
		return Err(CorpusCommitmentError::new("runner source manifest contract is invalid"));
	}

	let root_metadata = fs::symlink_metadata(source_root)
		.map_err(|_| CorpusCommitmentError::new("runner source root is unavailable"))?;

	if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
		return Err(CorpusCommitmentError::new("runner source root must be a regular directory"));
	}

	let canonical_root = fs::canonicalize(source_root)
		.map_err(|_| CorpusCommitmentError::new("runner source root cannot be resolved"))?;
	let mut previous = None;

	for entry in &manifest.entries {
		if !valid_source_path(&entry.path)
			|| !valid_digest(&entry.sha256)
			|| previous.as_ref().is_some_and(|path: &String| path >= &entry.path)
		{
			return Err(CorpusCommitmentError::new(
				"runner source manifest entries are invalid or unordered",
			));
		}

		let candidate = canonical_root.join(&entry.path);
		let metadata = fs::symlink_metadata(&candidate)
			.map_err(|_| CorpusCommitmentError::new("committed runner source is unavailable"))?;

		if metadata.file_type().is_symlink() || !metadata.is_file() {
			return Err(CorpusCommitmentError::new(
				"committed runner source must be a regular file",
			));
		}

		let canonical = fs::canonicalize(&candidate).map_err(|_| {
			CorpusCommitmentError::new("committed runner source cannot be resolved")
		})?;

		if !canonical.starts_with(&canonical_root)
			|| hash_bounded_file(&canonical, 16 * 1_024 * 1_024, "committed runner source")?
				!= entry.sha256
		{
			return Err(CorpusCommitmentError::new(
				"committed runner source does not match current bytes",
			));
		}

		previous = Some(entry.path.clone());
	}

	Ok(())
}

fn hash_executable(path: &Path, label: &str) -> Result<String, CorpusCommitmentError> {
	let path_metadata = fs::symlink_metadata(path)
		.map_err(|_| CorpusCommitmentError::new(format!("{label} is unavailable")))?;

	if path_metadata.file_type().is_symlink() || !path_metadata.is_file() {
		return Err(CorpusCommitmentError::new(format!(
			"{label} must be a non-symlink regular file"
		)));
	}
	#[cfg(unix)]
	if PermissionsExt::mode(&path_metadata.permissions()) & 0o111 == 0
		|| PermissionsExt::mode(&path_metadata.permissions()) & 0o022 != 0
		|| path_metadata.nlink() != 1
	{
		return Err(CorpusCommitmentError::new(format!(
			"{label} must be single-link, executable, and not group- or other-writable"
		)));
	}

	let canonical = fs::canonicalize(path)
		.map_err(|_| CorpusCommitmentError::new(format!("{label} cannot be resolved")))?;
	let mut file = File::open(&canonical)
		.map_err(|_| CorpusCommitmentError::new(format!("{label} cannot be read")))?;
	let metadata = file
		.metadata()
		.map_err(|_| CorpusCommitmentError::new(format!("{label} metadata is unavailable")))?;

	if !metadata.is_file() {
		return Err(CorpusCommitmentError::new(format!("{label} is not a regular file")));
	}
	if !valid_executable_file_size(metadata.len()) {
		return Err(CorpusCommitmentError::new(format!("{label} is empty")));
	}

	let mut hasher = Sha256::new();
	let bytes = io::copy(&mut file, &mut hasher)
		.map_err(|_| CorpusCommitmentError::new(format!("{label} cannot be hashed")))?;

	if bytes != metadata.len() {
		return Err(CorpusCommitmentError::new(format!("{label} changed while hashing")));
	}

	let current = fs::symlink_metadata(path)
		.map_err(|_| CorpusCommitmentError::new(format!("{label} changed while hashing")))?;

	#[cfg(unix)]
	if current.dev() != path_metadata.dev()
		|| current.ino() != path_metadata.ino()
		|| current.len() != path_metadata.len()
	{
		return Err(CorpusCommitmentError::new(format!("{label} changed while hashing")));
	}
	#[cfg(not(unix))]
	if current.len() != path_metadata.len() {
		return Err(CorpusCommitmentError::new(format!("{label} changed while hashing")));
	}

	Ok(format!("sha256:{}", hex::encode(hasher.finalize())))
}

fn valid_executable_file_size(length: u64) -> bool {
	length > 0
}

fn hash_bounded_file(
	path: &Path,
	max_bytes: u64,
	label: &str,
) -> Result<String, CorpusCommitmentError> {
	let file = File::open(path)
		.map_err(|_| CorpusCommitmentError::new(format!("{label} cannot be read")))?;
	let length = file
		.metadata()
		.map_err(|_| CorpusCommitmentError::new(format!("{label} metadata is unavailable")))?
		.len();

	if !valid_bounded_file_size(length, max_bytes) {
		return Err(CorpusCommitmentError::new(format!("{label} has an invalid size")));
	}

	let mut reader: Take<File> = file.take(max_bytes + 1);
	let mut hasher = Sha256::new();
	let bytes = io::copy(&mut reader, &mut hasher)
		.map_err(|_| CorpusCommitmentError::new(format!("{label} cannot be hashed")))?;

	if bytes != length {
		return Err(CorpusCommitmentError::new(format!("{label} changed while hashing")));
	}

	Ok(format!("sha256:{}", hex::encode(hasher.finalize())))
}

fn valid_bounded_file_size(length: u64, max_bytes: u64) -> bool {
	(1..=max_bytes).contains(&length)
}

fn valid_source_path(value: &str) -> bool {
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

fn validate_catalog_tasks(
	tasks: &[CorpusTask],
	catalog_contract: CatalogContract<'_>,
) -> Result<(), CorpusCommitmentError> {
	match catalog_contract.tasks {
		CatalogTaskAuthority::Embedded(catalog_json) => {
			let catalog: FrozenCatalog = serde_json::from_str(catalog_json).map_err(|error| {
				CorpusCommitmentError::new(format!("embedded catalog is invalid: {error}"))
			})?;
			let expected = catalog
				.tasks
				.into_iter()
				.map(|task| (task.task_id, task.task_version))
				.collect::<BTreeMap<_, _>>();
			let observed = tasks
				.iter()
				.map(|task| (task.task_id.clone(), task.task_version.clone()))
				.collect::<BTreeMap<_, _>>();

			if tasks.len() != 72
				|| expected.len() != 72
				|| observed.len() != 72
				|| observed != expected
			{
				return Err(CorpusCommitmentError::new(
					"corpus commitment does not cover the exact frozen catalog",
				));
			}
		},
		CatalogTaskAuthority::FixedOrderedIds(expected_ids) => {
			if tasks.len() != expected_ids.len()
				|| tasks.iter().zip(expected_ids).any(|(task, expected_id)| {
					task.task_id != *expected_id
						|| task.task_version != catalog_contract.task_set_version
				}) {
				return Err(CorpusCommitmentError::new(
					"contrast commitment does not cover the exact six ordered variants",
				));
			}
		},
	}

	for task in tasks {
		for digest in [
			&task.task_definition_sha256,
			&task.baseline_workspace_tree_sha256,
			&task.fixture_bundle_sha256,
			&task.catalog_entry_sha256,
			&task.evaluator_runtime_executable_sha256,
			&task.evaluator_executable_sha256,
			&task.evaluator_configuration_sha256,
			&task.acceptance_suite_sha256,
			&task.leakage_review_sha256,
		] {
			if !valid_digest(digest) {
				return Err(CorpusCommitmentError::new(
					"corpus task identity is not a valid SHA-256 commitment",
				));
			}
		}

		if task.evaluator_runtime_kind != "node" {
			return Err(CorpusCommitmentError::new(
				"corpus task evaluator runtime kind is unsupported",
			));
		}
	}

	Ok(())
}

fn validate_selected_tasks(
	committed: &[CorpusTask],
	selected: &[TaskDefinition],
) -> Result<BTreeMap<String, String>, CorpusCommitmentError> {
	if selected.is_empty() {
		return Err(CorpusCommitmentError::new("selected task set is empty"));
	}

	let committed =
		committed.iter().map(|task| (task.task_id.as_str(), task)).collect::<BTreeMap<_, _>>();
	let mut selected_ids = BTreeSet::new();
	let mut baseline_workspace_digests = BTreeMap::new();

	for task in selected {
		let expected = committed.get(task.task_id.as_str()).ok_or_else(|| {
			CorpusCommitmentError::new("selected task is absent from the corpus commitment")
		})?;
		let external =
			task.evaluator.as_ref().and_then(|evaluator| evaluator.external.as_ref()).ok_or_else(
				|| CorpusCommitmentError::new("real runs require committed external evaluators"),
			)?;
		let task_hash = task.content_hash().map_err(|error| {
			CorpusCommitmentError::new(format!("cannot hash selected task: {error}"))
		})?;

		if !selected_ids.insert(task.task_id.as_str())
			|| task.visibility != Visibility::Hidden
			|| task.task_version != expected.task_version
			|| task_hash != expected.task_definition_sha256
			|| task.catalog_entry_digest.as_deref() != Some(&expected.catalog_entry_sha256)
			|| external.runtime_kind != EvaluatorRuntimeKind::Node
			|| expected.evaluator_runtime_kind != "node"
			|| external.runtime_executable_digest != expected.evaluator_runtime_executable_sha256
			|| external.executable_digest != expected.evaluator_executable_sha256
			|| external.configuration_digest != expected.evaluator_configuration_sha256
		{
			return Err(CorpusCommitmentError::new(
				"selected task does not match the committed corpus commitment",
			));
		}

		baseline_workspace_digests
			.insert(task.task_id.clone(), expected.baseline_workspace_tree_sha256.clone());
	}

	Ok(baseline_workspace_digests)
}

fn validate_selected_catalog_budgets(
	selected: &[TaskDefinition],
	catalog_contract: CatalogContract<'_>,
) -> Result<(), CorpusCommitmentError> {
	let CatalogTaskAuthority::Embedded(catalog_json) = catalog_contract.tasks else {
		return Ok(());
	};
	let catalog: FrozenCatalog = serde_json::from_str(catalog_json).map_err(|error| {
		CorpusCommitmentError::new(format!("embedded catalog is invalid: {error}"))
	})?;
	let expected = catalog
		.tasks
		.into_iter()
		.map(|task| (task.task_id, task.budget))
		.collect::<BTreeMap<_, _>>();

	if selected.iter().any(|task| expected.get(&task.task_id) != Some(&task.budgets)) {
		return Err(CorpusCommitmentError::new(
			"selected Core task budget does not match the frozen public catalog",
		));
	}

	Ok(())
}

fn string_at<'a>(
	value: &'a Value,
	pointer: &str,
	label: &str,
) -> Result<&'a str, CorpusCommitmentError> {
	let value = value
		.pointer(pointer)
		.and_then(Value::as_str)
		.ok_or_else(|| CorpusCommitmentError::new(format!("corpus commitment omits {label}")))?;

	if !valid_digest(value) {
		return Err(CorpusCommitmentError::new(format!(
			"corpus commitment has an invalid {label}",
		)));
	}

	Ok(value)
}

fn bounded_string_at<'a>(
	value: &'a Value,
	pointer: &str,
	label: &str,
) -> Result<&'a str, CorpusCommitmentError> {
	let value = value
		.pointer(pointer)
		.and_then(Value::as_str)
		.ok_or_else(|| CorpusCommitmentError::new(format!("corpus commitment omits {label}")))?;

	if value.is_empty() || value.len() > 128 || value.chars().any(char::is_control) {
		return Err(CorpusCommitmentError::new(format!(
			"corpus commitment has an invalid {label}",
		)));
	}

	Ok(value)
}

fn valid_release_id(value: &str) -> bool {
	let Some(suffix) = value.strip_prefix("corpus_") else {
		return false;
	};
	let alphanumeric = |byte: u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();

	(1..=64).contains(&suffix.len())
		&& suffix.bytes().next().is_some_and(alphanumeric)
		&& suffix.bytes().last().is_some_and(alphanumeric)
		&& suffix.bytes().all(|byte| alphanumeric(byte) || matches!(byte, b'.' | b'_' | b'-'))
}

fn valid_digest(value: &str) -> bool {
	value.len() == 71
		&& value.starts_with("sha256:")
		&& value[7..].bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
		&& !value[7..].bytes().all(|byte| byte == b'0')
}

#[cfg(test)]
pub(crate) mod tests {
	use std::{env, fs, process, slice};
	#[cfg(unix)]
	use std::{
		ffi::OsString,
		os::unix::{ffi::OsStringExt as _, fs::PermissionsExt as _, net::UnixListener},
	};

	use serde_json::{self, Value};
	use sha2::{Digest as _, Sha256};

	use crate::candidate_catalog;
	use crate::cli;
	use crate::{
		corpus_commitment::{
			self, CorpusCatalog, CorpusCommitment, CorpusExecution, SourceManifest,
			SourceManifestEntry,
		},
		protocol, runner,
		scoring::{AIQ_CORE_TASK_IDENTITY_SHA256, AIQ_TASK_SET_ID, AIQ_TASK_SET_VERSION},
	};

	#[cfg(unix)]
	pub(crate) struct RunnerProvenancePathFixture {
		pub(crate) root: std::path::PathBuf,
		pub(crate) source_root: std::path::PathBuf,
		pub(crate) evaluator_root: std::path::PathBuf,
		toolchain_root: std::path::PathBuf,
		pub(crate) runtime: crate::task::EvaluatorRuntime,
		core_tasks: Vec<crate::task::TaskDefinition>,
		pub(crate) candidate_tasks: Vec<crate::task::TaskDefinition>,
		contrast_tasks: Vec<crate::task::TaskDefinition>,
		core_commitment: serde_json::Value,
		pub(crate) candidate_commitment: serde_json::Value,
		contrast_commitment: serde_json::Value,
	}

	#[cfg(unix)]
	impl RunnerProvenancePathFixture {
		pub(crate) fn new(label: &str) -> Self {
			let root = env::temp_dir().join(format!(
				"aiq-runner-provenance-{label}-{}-{}",
				process::id(),
				std::time::SystemTime::now()
					.duration_since(std::time::UNIX_EPOCH)
					.expect("fixture clock")
					.as_nanos()
			));
			let source_root = root.join("repository");
			let runner_source = source_root.join("apps/aiq-runner/src/runner.rs");
			let executable_source = root.join("executables");
			let evaluator_root = root.join("evaluators");
			let evaluator_path = evaluator_root.join("fixture/evaluator");
			let toolchain_root = root.join("toolchain");

			fs::create_dir_all(runner_source.parent().expect("runner source parent"))
				.expect("fixture source root");
			fs::create_dir_all(&executable_source).expect("fixture executable source");
			fs::create_dir_all(evaluator_path.parent().expect("fixture evaluator parent"))
				.expect("fixture evaluator root");
			fs::create_dir(&toolchain_root).expect("fixture toolchain root");
			fs::write(&runner_source, b"committed runner source").expect("fixture runner source");

			let (evaluator_digest, runtime, policy) =
				Self::runtime_fixture(&evaluator_path, &executable_source, &toolchain_root);
			let mut core_tasks = runner::synthetic_demo_tasks();

			Self::bind_external_evaluators(
				&mut core_tasks,
				runtime.executable_digest(),
				&evaluator_digest,
			);

			let mut contrast_tasks = core_tasks[..super::CONTRAST_TASK_IDS.len()].to_vec();

			for (task, task_id) in contrast_tasks.iter_mut().zip(super::CONTRAST_TASK_IDS) {
				task.task_id = task_id.to_owned();
				task.task_version = super::CONTRAST_CATALOG.task_set_version.to_owned();
				task.catalog_entry_digest = Some(format!("sha256:{}", "c".repeat(64)));
			}

			Self::apply_core_catalog_budgets(&mut core_tasks);

			let candidate_value: serde_json::Value =
				serde_json::from_str(super::CANDIDATE_CORE_CATALOG_JSON)
					.expect("embedded candidate catalog");
			let candidate_authority =
				candidate_catalog::validate_candidate_catalog(&candidate_value)
					.expect("candidate authority");
			let candidate_contract = super::candidate_core_catalog_contract(&candidate_authority);
			let candidate_tasks = Self::candidate_tasks(
				&candidate_value,
				&candidate_authority,
				runtime.executable_digest(),
				&evaluator_digest,
			);
			let core_commitment =
				Self::commitment(super::CORE_CATALOG, &core_tasks, &source_root, &runtime, &policy);
			let candidate_commitment = Self::commitment(
				candidate_contract,
				&candidate_tasks,
				&source_root,
				&runtime,
				&policy,
			);
			let contrast_commitment = Self::commitment(
				super::CONTRAST_CATALOG,
				&contrast_tasks,
				&source_root,
				&runtime,
				&policy,
			);

			Self {
				root,
				source_root,
				evaluator_root,
				toolchain_root,
				runtime,
				core_tasks,
				candidate_tasks,
				contrast_tasks,
				core_commitment,
				candidate_commitment,
				contrast_commitment,
			}
		}

		fn runtime_fixture(
			evaluator_path: &std::path::Path,
			executable_source: &std::path::Path,
			toolchain_root: &std::path::Path,
		) -> (String, crate::task::EvaluatorRuntime, super::ExecutionToolPolicy) {
			fs::write(
				evaluator_path,
				concat!(
					"#!/bin/sh\n",
					"cat >/dev/null\n",
					"printf '%s\\n' '",
					r#"{"schema_version":"aiq.evaluator-result.v3","outcome":"correct","score":1.0,"checks":[{"check_id":"fixture","weight":1,"passed":true,"failure_class":"none","evidence_digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]}"#,
					"'\n",
				),
			)
			.expect("fixture evaluator");

			let evaluator_digest = format!(
				"sha256:{}",
				hex::encode(Sha256::digest(
					fs::read(evaluator_path).expect("fixture evaluator bytes")
				))
			);

			for (name, version) in [("node", "v24.18.0"), ("rg", "ripgrep 15.1.0")] {
				let source = executable_source.join(name);
				let contents = if name == "node" {
					format!(
						"#!/bin/sh\nif [ \"$1\" = --version ]; then printf '%s\\n' '{version}'; else exec /bin/sh \"$@\"; fi\n"
					)
				} else {
					format!("#!/bin/sh\nprintf '%s\\n' '{version}'\n")
				};

				fs::write(&source, contents).expect("fixture executable");
				fs::set_permissions(&source, fs::Permissions::from_mode(0o700))
					.expect("fixture executable mode");
				fs::hard_link(&source, toolchain_root.join(name)).expect("toolchain hard link");
			}

			let runtime = crate::task::EvaluatorRuntime::resolve(&toolchain_root.join("node"))
				.expect("fixture Node runtime");
			let policy =
				super::fixture_validated_model_toolchain(toolchain_root, &runtime).policy().clone();

			(evaluator_digest, runtime, policy)
		}

		fn candidate_tasks(
			candidate_value: &serde_json::Value,
			candidate_authority: &candidate_catalog::CandidateCatalogAuthority,
			runtime_digest: &str,
			evaluator_digest: &str,
		) -> Vec<crate::task::TaskDefinition> {
			let candidate_catalog: super::FrozenCatalog =
				serde_json::from_value(candidate_value.clone()).expect("candidate frozen catalog");
			let candidate_raw_tasks =
				candidate_value["tasks"].as_array().expect("candidate task metadata");
			let mut tasks = runner::synthetic_demo_tasks();

			for (((task, frozen), raw), expected) in tasks
				.iter_mut()
				.zip(candidate_catalog.tasks)
				.zip(candidate_raw_tasks)
				.zip(&candidate_authority.tasks)
			{
				task.task_id = frozen.task_id;
				task.task_version = frozen.task_version;
				task.domain = expected.domain;
				task.cluster_id = Some(expected.cluster_id.clone());
				task.allowed_tools = frozen.allowed_tools;
				task.budgets = frozen.budget;
				task.catalog_entry_digest =
					Some(protocol::canonical_hash(raw).expect("candidate catalog entry digest"));
				task.scorer_version = "1.0.6".to_owned();
			}

			Self::bind_external_evaluators(&mut tasks, runtime_digest, evaluator_digest);

			tasks
		}

		fn bind_external_evaluators(
			tasks: &mut [crate::task::TaskDefinition],
			runtime_digest: &str,
			evaluator_digest: &str,
		) {
			for task in tasks {
				let configuration = serde_json::from_value(serde_json::json!({
					"schema_version": crate::task::EVALUATOR_CONFIG_SCHEMA_VERSION,
					"completion_policy": "natural_completion",
					"checks": [{"check_id":"fixture","type":"text","weight":1}]
				}))
				.expect("formal evaluator configuration");
				let configuration_digest =
					protocol::canonical_hash(&configuration).expect("configuration digest");

				task.visibility = crate::task::Visibility::Hidden;
				task.evaluator = Some(crate::task::Evaluator {
					kind: "controlled_fixture".to_owned(),
					expected: None,
					case_sensitive: false,
					external: Some(crate::task::ExternalEvaluatorBinding {
						protocol_version: crate::task::EVALUATOR_PROTOCOL_VERSION.to_owned(),
						scorer_version: task.scorer_version.clone(),
						runtime_kind: crate::task::EvaluatorRuntimeKind::Node,
						runtime_executable_digest: runtime_digest.to_owned(),
						executable_ref: std::path::PathBuf::from("fixture/evaluator"),
						executable_digest: evaluator_digest.to_owned(),
						configuration_digest,
						arguments: Vec::new(),
						timeout_ms: None,
						max_input_bytes: 1_024,
						max_output_bytes: 1_024,
						configuration,
					}),
				});
			}
		}

		fn apply_core_catalog_budgets(tasks: &mut [crate::task::TaskDefinition]) {
			let catalog: super::FrozenCatalog =
				serde_json::from_str(super::CORE_CATALOG_JSON).expect("embedded Core catalog");
			let budgets = catalog
				.tasks
				.into_iter()
				.map(|task| (task.task_id, task.budget))
				.collect::<std::collections::BTreeMap<_, _>>();

			for task in tasks {
				task.budgets = budgets.get(&task.task_id).expect("Core task budget").clone();
			}
		}

		fn commitment(
			catalog: super::CatalogContract<'_>,
			tasks: &[crate::task::TaskDefinition],
			source_root: &std::path::Path,
			runtime: &crate::task::EvaluatorRuntime,
			policy: &super::ExecutionToolPolicy,
		) -> serde_json::Value {
			let runner_source = fs::read(source_root.join("apps/aiq-runner/src/runner.rs"))
				.expect("fixture runner source");
			let runner_source_digest =
				format!("sha256:{}", hex::encode(Sha256::digest(runner_source)));
			let source_manifest = serde_json::json!({
				"schema_version": "aiq.runner-source-manifest.v1",
				"package": "aiq-runner",
				"scope": "cargo_build_and_test_inputs",
				"path_base": "repository_root",
				"entries": [{
					"path": "apps/aiq-runner/src/runner.rs",
					"sha256": runner_source_digest,
				}],
			});
			let source_manifest_digest =
				protocol::canonical_hash(&source_manifest).expect("source manifest digest");
			let runtime_provenance = serde_json::json!({
				"operating_system": {
					"platform": policy.platform.as_str(),
				},
				"locale_and_timezone": {
					"environment": {
						"OPENSSL_CONF": if policy.platform == "win32" { "NUL" } else { "/dev/null" },
					},
				},
				"node_runtime": {
					"executable_sha256": runtime.executable_digest(),
					"version": runtime.version(),
				},
				"model_toolchain": policy,
				"runner": {
					"identity_kind": "source_only",
					"source_manifest": source_manifest,
					"source_manifest_sha256": source_manifest_digest,
					"built_binary_sha256": null,
				},
			});
			let network_policy = serde_json::json!({
				"protocol": "aiq.network-policy.v1",
				"evidence_class": "declared_policy_commitment",
				"codex_web_search": "disabled_for_controlled_corpus",
				"codex_mcp": "disabled",
				"evaluator_node_scenario": "network_denied_by_node_permission_model",
			});
			let tool_policy_tasks = super::catalog_tool_policy_tasks(catalog, Some(tasks))
				.expect("fixture catalog tool policy");
			let tool_policy = serde_json::json!({
				"protocol": "aiq.tool-policy.v1",
				"evidence_class": "declared_policy_commitment",
				"catalog": tool_policy_tasks,
				"model_toolchain": policy,
			});
			let committed_tasks = tasks
				.iter()
				.map(|task| {
					let external = task
						.evaluator
						.as_ref()
						.and_then(|evaluator| evaluator.external.as_ref())
						.expect("fixture external evaluator");

					serde_json::json!({
						"task_id": task.task_id,
						"task_version": task.task_version,
						"task_definition_sha256": task.content_hash().expect("fixture task digest"),
						"baseline_workspace_tree_sha256": format!("sha256:{}", "b".repeat(64)),
						"fixture_bundle_sha256": format!("sha256:{}", "f".repeat(64)),
						"catalog_entry_sha256": task.catalog_entry_digest.as_ref().expect("catalog digest"),
						"evaluator_runtime_kind": "node",
						"evaluator_runtime_executable_sha256": external.runtime_executable_digest,
						"evaluator_executable_sha256": external.executable_digest,
						"evaluator_configuration_sha256": external.configuration_digest,
						"acceptance_suite_sha256": format!("sha256:{}", "a".repeat(64)),
						"leakage_review_sha256": format!("sha256:{}", "d".repeat(64)),
					})
				})
				.collect::<Vec<_>>();

			serde_json::json!({
				"schema_version": catalog.commitment_schema_version,
				"release_id": "corpus_runner_provenance_fixture",
				"controlled": true,
				"synthetic": false,
				"catalog": {
					"schema_version": catalog.catalog_schema_version,
					"task_set_id": catalog.task_set_id,
					"task_set_version": catalog.task_set_version,
					"identity_sha256": catalog.identity_sha256,
					"identity_scope": catalog.identity_scope,
				},
				"execution": {
					"harness_sha256": format!("sha256:{}", "8".repeat(64)),
					"runner_prompt_source_sha256": runner_source_digest,
					"declared_tool_policy_sha256": protocol::canonical_hash(&tool_policy).expect("tool digest"),
					"declared_network_policy_sha256": protocol::canonical_hash(&network_policy).expect("network digest"),
					"environment_sha256": protocol::canonical_hash(&runtime_provenance).expect("environment digest"),
					"runtime_provenance": runtime_provenance,
				},
				"tasks": committed_tasks,
			})
		}

		pub(crate) fn write(&self, label: &str, value: &serde_json::Value) -> std::path::PathBuf {
			let path = self.root.join(format!("{label}.json"));

			fs::write(&path, serde_json::to_vec(value).expect("serialize fixture commitment"))
				.expect("write fixture commitment");

			path
		}
	}

	#[cfg(unix)]
	#[test]
	fn execution_tool_policy_uses_the_active_v3_schema_on_both_routes() {
		let fixture = RunnerProvenancePathFixture::new("execution-policy-route");
		let candidate = fixture.write("candidate", &fixture.candidate_commitment);
		let current = fixture.write("current", &fixture.core_commitment);

		assert_eq!(
			super::read_execution_tool_policy(&candidate, true)
				.expect("candidate v3 execution policy")
				.schema_version,
			"aiq.execution-tool-policy.v1"
		);
		assert_eq!(
			super::read_execution_tool_policy(&candidate, false)
				.expect("candidate commitment on the active route")
				.schema_version,
			"aiq.execution-tool-policy.v1"
		);
		assert_eq!(
			super::read_execution_tool_policy(&current, false)
				.expect("active v3 execution policy")
				.schema_version,
			"aiq.execution-tool-policy.v1"
		);
		assert_eq!(
			super::read_execution_tool_policy(&current, true)
				.expect("active commitment on the retained candidate route")
				.schema_version,
			"aiq.execution-tool-policy.v1"
		);

		fs::remove_dir_all(fixture.root).expect("execution-policy route fixture cleanup");
	}

	#[test]
	fn bounded_runtime_version_is_not_parsed_as_a_digest() {
		let value = serde_json::json!({"node_runtime": {"version": "v24.18.0"}});

		assert_eq!(
			super::bounded_string_at(&value, "/node_runtime/version", "runtime version")
				.expect("actual Node.js version"),
			"v24.18.0"
		);
	}

	#[test]
	fn core_task_budgets_must_match_the_frozen_public_catalog() {
		let catalog: super::FrozenCatalog =
			serde_json::from_str(super::CORE_CATALOG_JSON).expect("embedded Core catalog");
		let budgets = catalog
			.tasks
			.into_iter()
			.map(|task| (task.task_id, task.budget))
			.collect::<std::collections::BTreeMap<_, _>>();
		let mut tasks = runner::synthetic_demo_tasks();

		for task in &mut tasks {
			task.budgets = budgets.get(&task.task_id).expect("Core task budget").clone();
		}

		super::validate_selected_catalog_budgets(&tasks, super::CORE_CATALOG)
			.expect("exact Core budgets");

		for field in ["wall_seconds", "max_steps", "max_tool_calls"] {
			let mut mismatched = tasks.clone();

			match field {
				"wall_seconds" => {
					mismatched[0].budgets.wall_seconds = match mismatched[0].budgets.wall_seconds {
						Some(_) => None,
						None => Some(1),
					};
				},
				"max_steps" => mismatched[0].budgets.max_steps = Some(1),
				"max_tool_calls" => mismatched[0].budgets.max_tool_calls = Some(1),
				_ => unreachable!("unknown budget field"),
			}

			let error = super::validate_selected_catalog_budgets(&mismatched, super::CORE_CATALOG)
				.expect_err("mismatched Core budget");

			assert_eq!(
				error.to_string(),
				"selected Core task budget does not match the frozen public catalog",
				"{field} reached the wrong gate"
			);
		}

		super::validate_selected_catalog_budgets(&tasks, super::CONTRAST_CATALOG)
			.expect("Contrast budgets remain corpus-controlled");
	}

	#[cfg(unix)]
	#[test]
	fn core_validation_rejects_each_public_catalog_budget_mismatch() {
		let fixture = RunnerProvenancePathFixture::new("core-budget");
		let path = fixture.write("valid-core", &fixture.core_commitment);

		super::validate_core_corpus_commitment(&path, &fixture.core_tasks, &fixture.source_root)
			.expect("exact Core budgets");

		for field in ["wall_seconds", "max_steps", "max_tool_calls"] {
			let mut mismatched = fixture.core_tasks.clone();

			match field {
				"wall_seconds" => {
					mismatched[0].budgets.wall_seconds = match mismatched[0].budgets.wall_seconds {
						Some(_) => None,
						None => Some(1),
					};
				},
				"max_steps" => mismatched[0].budgets.max_steps = Some(1),
				"max_tool_calls" => mismatched[0].budgets.max_tool_calls = Some(1),
				_ => unreachable!("unknown budget field"),
			}

			let error =
				super::validate_core_corpus_commitment(&path, &mismatched, &fixture.source_root)
					.expect_err("mismatched Core budget");

			assert_eq!(
				error.to_string(),
				"selected Core task budget does not match the frozen public catalog",
				"{field} reached the wrong gate"
			);
		}

		fs::remove_dir_all(&fixture.root).expect("fixture cleanup");
	}

	#[test]
	fn controlled_openssl_environment_has_one_platform_mapping() {
		let mut policy =
			super::fixture_model_toolchain(std::path::PathBuf::from("/toolchain")).policy().clone();

		for (platform, openssl_conf) in
			[("darwin", "/dev/null"), ("linux", "/dev/null"), ("win32", "NUL")]
		{
			policy.platform = platform.to_owned();

			let runtime = serde_json::json!({
				"operating_system": { "platform": platform },
				"locale_and_timezone": {
					"environment": { "OPENSSL_CONF": openssl_conf },
				},
			});

			super::validate_controlled_openssl_environment(&runtime, &policy)
				.expect("platform-bound OpenSSL configuration");

			let mut wrong = runtime;

			wrong["locale_and_timezone"]["environment"]["OPENSSL_CONF"] =
				serde_json::json!(if openssl_conf == "NUL" { "/dev/null" } else { "NUL" });

			assert!(super::validate_controlled_openssl_environment(&wrong, &policy).is_err());
		}
	}

	#[test]
	fn runner_runtime_provenance_requires_exact_source_only_contract() {
		let source_manifest = serde_json::json!({
			"schema_version": "aiq.runner-source-manifest.v1",
			"package": "aiq-runner",
			"scope": "cargo_build_and_test_inputs",
			"path_base": "repository_root",
			"entries": [{
				"path": "apps/aiq-runner/src/runner.rs",
				"sha256": format!("sha256:{}", "1".repeat(64)),
			}],
		});
		let source_manifest_sha256 =
			protocol::canonical_hash(&source_manifest).expect("source manifest digest");
		let runtime_provenance = serde_json::json!({
			"runner": {
				"identity_kind": "source_only",
				"source_manifest": source_manifest,
				"source_manifest_sha256": source_manifest_sha256,
				"built_binary_sha256": null,
			},
		});

		assert!(super::validate_runner_runtime_provenance(&runtime_provenance).is_ok());
		assert!(
			super::validate_runner_runtime_provenance(&serde_json::json!({"runner": []})).is_err()
		);
		assert!(super::validate_runner_runtime_provenance(&serde_json::json!({})).is_err());

		let mut non_source_only = runtime_provenance.clone();

		non_source_only["runner"]["identity_kind"] = serde_json::json!("built_binary");

		assert!(super::validate_runner_runtime_provenance(&non_source_only).is_err());

		let mut non_null_binary = runtime_provenance.clone();

		non_null_binary["runner"]["built_binary_sha256"] =
			serde_json::json!(format!("sha256:{}", "2".repeat(64)));

		assert!(super::validate_runner_runtime_provenance(&non_null_binary).is_err());

		for field in
			["identity_kind", "source_manifest", "source_manifest_sha256", "built_binary_sha256"]
		{
			let mut missing = runtime_provenance.clone();

			missing["runner"].as_object_mut().expect("runner object").remove(field);

			assert!(
				super::validate_runner_runtime_provenance(&missing).is_err(),
				"missing {field} must be rejected"
			);
		}

		let mut extra = runtime_provenance;

		extra["runner"]
			.as_object_mut()
			.expect("runner object")
			.insert("unexpected".to_owned(), serde_json::Value::Null);

		assert!(super::validate_runner_runtime_provenance(&extra).is_err());
	}

	#[cfg(unix)]
	fn mutate_runner_provenance(value: &mut serde_json::Value, mutation: &str) {
		let runner = &mut value["execution"]["runtime_provenance"]["runner"];

		match mutation {
			"legacy identity" => runner["identity_kind"] = serde_json::json!("built_binary"),
			"non-object runner" => *runner = serde_json::json!([]),
			"extra field" => {
				runner
					.as_object_mut()
					.expect("runner object")
					.insert("unexpected".to_owned(), serde_json::Value::Null);
			},
			"missing field" => {
				runner.as_object_mut().expect("runner object").remove("source_manifest_sha256");
			},
			"non-null binary" => {
				runner["built_binary_sha256"] =
					serde_json::json!(format!("sha256:{}", "9".repeat(64)));
			},
			_ => unreachable!("unknown runner mutation"),
		}

		let runtime_provenance = value["execution"]["runtime_provenance"].clone();

		value["execution"]["environment_sha256"] = serde_json::json!(
			protocol::canonical_hash(&runtime_provenance).expect("mutated environment digest")
		);
	}

	#[cfg(unix)]
	#[test]
	fn adopted_candidate_commitment_is_the_active_core_authority() {
		let fixture = RunnerProvenancePathFixture::new("candidate-route");
		let path = fixture.write("candidate", &fixture.candidate_commitment);

		cli::validate_run_corpus(true, &path, &fixture.candidate_tasks, &fixture.source_root)
			.expect("explicit candidate preparation route");
		cli::validate_run_corpus(false, &path, &fixture.candidate_tasks, &fixture.source_root)
			.expect("the ordinary active validator must accept the adopted candidate corpus");
		fs::remove_dir_all(&fixture.root).expect("fixture cleanup");
	}

	#[cfg(unix)]
	#[test]
	fn shared_corpus_validation_rejects_runner_provenance_drift_for_core_and_contrast() {
		let fixture = RunnerProvenancePathFixture::new("shared");
		let core_path = fixture.write("valid-core", &fixture.core_commitment);
		let contrast_path = fixture.write("valid-contrast", &fixture.contrast_commitment);
		let contrast_digest =
			protocol::canonical_hash(&fixture.contrast_commitment).expect("contrast digest");

		super::validate_core_corpus_commitment(
			&core_path,
			&fixture.core_tasks,
			&fixture.source_root,
		)
		.expect("valid Core commitment");
		super::validate_contrast_corpus_commitment(
			&contrast_path,
			&fixture.contrast_tasks,
			&fixture.source_root,
			&contrast_digest,
		)
		.expect("valid Contrast commitment");

		for (catalog, mutation) in [
			("core", "legacy identity"),
			("core", "non-object runner"),
			("core", "extra field"),
			("core", "missing field"),
			("core", "non-null binary"),
			("contrast", "legacy identity"),
			("contrast", "non-object runner"),
			("contrast", "extra field"),
			("contrast", "missing field"),
			("contrast", "non-null binary"),
		] {
			let mut commitment = if catalog == "core" {
				fixture.core_commitment.clone()
			} else {
				fixture.contrast_commitment.clone()
			};

			mutate_runner_provenance(&mut commitment, mutation);

			let path = fixture.write(&format!("{catalog}-{mutation}"), &commitment);
			let error = if catalog == "core" {
				super::validate_core_corpus_commitment(
					&path,
					&fixture.core_tasks,
					&fixture.source_root,
				)
				.expect_err("mutated Core runner provenance")
			} else {
				let digest =
					protocol::canonical_hash(&commitment).expect("mutated contrast digest");

				super::validate_contrast_corpus_commitment(
					&path,
					&fixture.contrast_tasks,
					&fixture.source_root,
					&digest,
				)
				.expect_err("mutated Contrast runner provenance")
			};

			assert!(
				error.to_string().starts_with("runner runtime provenance"),
				"{catalog} {mutation} reached the wrong gate: {error}"
			);
		}

		fs::remove_dir_all(&fixture.root).expect("fixture cleanup");
	}

	#[cfg(unix)]
	#[test]
	fn shared_corpus_validation_enforces_platform_bound_openssl_configuration() {
		let fixture = RunnerProvenancePathFixture::new("openssl-environment");

		for catalog in ["core", "contrast"] {
			for mutation in ["missing", "wrong null device", "platform mismatch"] {
				let mut commitment = if catalog == "core" {
					fixture.core_commitment.clone()
				} else {
					fixture.contrast_commitment.clone()
				};
				let runtime = &mut commitment["execution"]["runtime_provenance"];

				match mutation {
					"missing" => {
						runtime["locale_and_timezone"]["environment"]
							.as_object_mut()
							.expect("environment object")
							.remove("OPENSSL_CONF");
					},
					"wrong null device" => {
						runtime["locale_and_timezone"]["environment"]["OPENSSL_CONF"] =
							serde_json::json!("NUL");
					},
					"platform mismatch" => {
						runtime["operating_system"]["platform"] = serde_json::json!("win32");
					},
					_ => unreachable!("unknown OpenSSL mutation"),
				}

				commitment["execution"]["environment_sha256"] = serde_json::json!(
					protocol::canonical_hash(runtime).expect("mutated environment digest")
				);

				let path = fixture.write(&format!("{catalog}-openssl-{mutation}"), &commitment);
				let error = if catalog == "core" {
					super::validate_core_corpus_commitment(
						&path,
						&fixture.core_tasks,
						&fixture.source_root,
					)
					.expect_err("mutated Core OpenSSL provenance")
				} else {
					let digest =
						protocol::canonical_hash(&commitment).expect("mutated contrast digest");

					super::validate_contrast_corpus_commitment(
						&path,
						&fixture.contrast_tasks,
						&fixture.source_root,
						&digest,
					)
					.expect_err("mutated Contrast OpenSSL provenance")
				};

				assert!(
					error.to_string().contains("OpenSSL")
						|| error.to_string().contains("operating-system platform"),
					"{catalog} {mutation} reached the wrong gate: {error}"
				);
			}
		}

		fs::remove_dir_all(&fixture.root).expect("fixture cleanup");
	}

	#[cfg(unix)]
	#[test]
	fn evaluator_runtime_validation_reuses_runner_provenance_gate() {
		let fixture = RunnerProvenancePathFixture::new("evaluator-runtime");
		let valid_path = fixture.write("valid", &fixture.core_commitment);
		let valid_digest =
			protocol::canonical_hash(&fixture.core_commitment).expect("valid commitment digest");

		super::validate_evaluator_runtime_commitment(
			&valid_path,
			&valid_digest,
			&fixture.runtime,
			&fixture.toolchain_root,
		)
		.expect("valid evaluator runtime commitment");

		for mutation in [
			"legacy identity",
			"non-object runner",
			"extra field",
			"missing field",
			"non-null binary",
		] {
			let mut commitment = fixture.core_commitment.clone();

			mutate_runner_provenance(&mut commitment, mutation);

			let path = fixture.write(mutation, &commitment);
			let digest = protocol::canonical_hash(&commitment).expect("mutated commitment digest");
			let error = super::validate_evaluator_runtime_commitment(
				&path,
				&digest,
				&fixture.runtime,
				&fixture.toolchain_root,
			)
			.expect_err("mutated evaluator runner provenance");

			assert!(
				error.to_string().starts_with("runner runtime provenance"),
				"{mutation} reached the wrong gate: {error}"
			);
		}

		fs::remove_dir_all(&fixture.root).expect("fixture cleanup");
	}

	#[test]
	fn executable_size_validation_rejects_empty_files_without_a_maximum() {
		assert!(!super::valid_executable_file_size(0));
		assert!(super::valid_executable_file_size(270_605_984));
		assert!(super::valid_executable_file_size(512 * 1_024 * 1_024 + 1));
		assert!(super::valid_executable_file_size(u64::MAX));
	}

	#[test]
	fn deterministic_execution_digests_use_full_catalog_for_calibration_subset_and_fail_closed() {
		let policy =
			super::fixture_model_toolchain(std::path::PathBuf::from("/toolchain")).policy().clone();
		let runner_digest = format!("sha256:{}", "1".repeat(64));
		let source_manifest = serde_json::json!({
			"entries": [{
				"path": "apps/aiq-runner/src/runner.rs",
				"sha256": runner_digest,
			}],
		});
		let source_manifest_sha256 =
			protocol::canonical_hash(&source_manifest).expect("source manifest digest");
		let runtime_provenance = serde_json::json!({
			"operating_system": {
				"platform": policy.platform.as_str(),
			},
			"locale_and_timezone": {
				"environment": {
					"OPENSSL_CONF": if policy.platform == "win32" { "NUL" } else { "/dev/null" },
				},
			},
			"runner": {
				"identity_kind": "source_only",
				"source_manifest": source_manifest,
				"source_manifest_sha256": source_manifest_sha256,
				"built_binary_sha256": null,
			},
			"model_toolchain": policy,
		});
		let catalog: super::FrozenCatalog = serde_json::from_str(include_str!(
			"../../../benchmarks/candidates/aiq-core-1.1.0/catalog.json"
		))
		.expect("embedded catalog");
		let tool_digest = protocol::canonical_hash(&serde_json::json!({
			"protocol": "aiq.tool-policy.v1",
			"evidence_class": "declared_policy_commitment",
			"catalog": catalog.tasks.iter().map(|task| serde_json::json!({
				"task_id": task.task_id,
				"allowed_tools": task.allowed_tools,
			})).collect::<Vec<_>>(),
			"model_toolchain": policy,
		}))
		.expect("tool digest");
		let one_task_calibration_digest = protocol::canonical_hash(&serde_json::json!({
			"protocol": "aiq.tool-policy.v1",
			"evidence_class": "declared_policy_commitment",
			"catalog": catalog.tasks[..1].iter().map(|task| serde_json::json!({
				"task_id": task.task_id,
				"allowed_tools": task.allowed_tools,
			})).collect::<Vec<_>>(),
			"model_toolchain": policy,
		}))
		.expect("one-task digest");

		assert_ne!(tool_digest, one_task_calibration_digest);

		let network_digest = protocol::canonical_hash(&serde_json::json!({
			"protocol": "aiq.network-policy.v1",
			"evidence_class": "declared_policy_commitment",
			"codex_web_search": "disabled_for_controlled_corpus",
			"codex_mcp": "disabled",
			"evaluator_node_scenario": "network_denied_by_node_permission_model",
		}))
		.expect("network digest");
		let execution = super::CorpusExecution {
			harness_sha256: format!("sha256:{}", "2".repeat(64)),
			runner_prompt_source_sha256: runner_digest,
			declared_tool_policy_sha256: tool_digest,
			declared_network_policy_sha256: network_digest,
			environment_sha256: protocol::canonical_hash(&runtime_provenance)
				.expect("environment digest"),
			runtime_provenance,
		};
		let runner_provenance =
			super::validate_runner_runtime_provenance(&execution.runtime_provenance)
				.expect("runner provenance");
		let source = &runner_provenance.source_manifest;

		super::validate_deterministic_execution_digests(
			&execution,
			source,
			&policy,
			super::CORE_CATALOG,
			None,
		)
		.expect("valid deterministic digests");

		for field in ["prompt", "tool", "network", "environment"] {
			let digest = format!("sha256:{}", "f".repeat(64));
			let mut mutated = execution.clone();

			match field {
				"prompt" => mutated.runner_prompt_source_sha256 = digest,
				"tool" => mutated.declared_tool_policy_sha256 = digest,
				"network" => mutated.declared_network_policy_sha256 = digest,
				"environment" => mutated.environment_sha256 = digest,
				_ => unreachable!(),
			}

			assert!(
				super::validate_deterministic_execution_digests(
					&mutated,
					source,
					&policy,
					super::CORE_CATALOG,
					None,
				)
				.is_err()
			);
		}
	}

	#[cfg(unix)]
	#[test]
	fn controlled_toolchain_rejects_policy_and_filesystem_drift() {
		let fixture = env::temp_dir().join(format!(
			"aiq-toolchain-validator-{}-{}",
			process::id(),
			std::time::SystemTime::now()
				.duration_since(std::time::UNIX_EPOCH)
				.expect("fixture clock")
				.as_nanos()
		));
		let source = fixture.join("source");
		let root = fixture.join("toolchain");

		fs::create_dir_all(&source).expect("fixture source root");
		fs::create_dir(&root).expect("fixture toolchain root");

		for (name, version) in [("node", "v24.18.0"), ("rg", "ripgrep 15.1.0")] {
			let path = source.join(name);

			fs::write(&path, format!("#!/bin/sh\nprintf '%s\\n' '{version}'\n"))
				.expect("fixture executable");
			fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
				.expect("fixture executable mode");
			fs::hard_link(&path, root.join(name)).expect("toolchain hard link");
		}

		let runtime = crate::task::EvaluatorRuntime::resolve(&root.join("node"))
			.expect("fixture Node runtime");
		let validated = super::fixture_validated_model_toolchain(&root, &runtime);
		let mut wrong_platform = validated.policy().clone();

		wrong_platform.platform = "win32".to_owned();

		assert!(super::validate_model_toolchain(&root, &wrong_platform, &runtime).is_err());

		let mut profile = validated.policy().clone();

		profile.use_shell_profile = true;

		assert!(super::validate_model_toolchain(&root, &profile, &runtime).is_err());

		let mut tampered = validated.policy().clone();

		tampered.commands[1].executable_sha256 = format!("sha256:{}", "f".repeat(64));

		assert!(super::validate_model_toolchain(&root, &tampered, &runtime).is_err());

		fs::write(root.join("extra"), b"extra").expect("extra fixture");

		assert!(super::validate_model_toolchain(&root, validated.policy(), &runtime).is_err());

		fs::remove_file(root.join("extra")).expect("extra cleanup");
		fs::remove_file(root.join("rg")).expect("missing fixture");

		assert!(super::validate_model_toolchain(&root, validated.policy(), &runtime).is_err());

		std::os::unix::fs::symlink(source.join("rg"), root.join("rg")).expect("symlink fixture");

		assert!(super::validate_model_toolchain(&root, validated.policy(), &runtime).is_err());

		fs::remove_dir_all(fixture).expect("fixture cleanup");
	}

	fn commitment() -> CorpusCommitment {
		let digest = format!("sha256:{}", "a".repeat(64));

		CorpusCommitment {
			schema_version: "aiq.corpus-commitment.v3".to_owned(),
			release_id: "corpus_2026.07.30".to_owned(),
			controlled: true,
			synthetic: false,
			catalog: CorpusCatalog {
				schema_version: "aiq.catalog.v2".to_owned(),
				task_set_id: AIQ_TASK_SET_ID.to_owned(),
				task_set_version: AIQ_TASK_SET_VERSION.to_owned(),
				identity_sha256: AIQ_CORE_TASK_IDENTITY_SHA256.to_owned(),
				identity_scope: "ordered_full_task_metadata".to_owned(),
			},
			execution: CorpusExecution {
				harness_sha256: digest.clone(),
				runner_prompt_source_sha256: digest.clone(),
				declared_tool_policy_sha256: digest.clone(),
				declared_network_policy_sha256: digest.clone(),
				environment_sha256: digest,
				runtime_provenance: serde_json::json!({}),
			},
			tasks: Vec::new(),
		}
	}

	#[test]
	fn current_and_candidate_corpus_headers_are_strict_across_catalog_and_schema() {
		assert!(corpus_commitment::validate_header(&commitment(), super::CORE_CATALOG).is_ok());

		let candidate_authority = super::validated_candidate_core_catalog()
			.expect("validated embedded candidate catalog");
		let candidate_contract = super::candidate_core_catalog_contract(&candidate_authority);
		let commitment_schema: Value =
			serde_json::from_str(super::CANDIDATE_CORE_COMMITMENT_SCHEMA_JSON)
				.expect("candidate commitment schema");
		let schema_identity = commitment_schema
			.pointer("/properties/catalog/properties/identity_sha256/const")
			.and_then(Value::as_str)
			.expect("candidate commitment schema identity");

		assert_eq!(schema_identity, candidate_authority.task_metadata_digest);

		let mut candidate = commitment();

		candidate.schema_version = candidate_contract.commitment_schema_version.to_owned();
		candidate.catalog.schema_version = candidate_contract.catalog_schema_version.to_owned();
		candidate.catalog.task_set_version = candidate_contract.task_set_version.to_owned();
		candidate.catalog.identity_sha256 = candidate_authority.task_metadata_digest.clone();

		assert!(corpus_commitment::validate_header(&candidate, candidate_contract).is_ok());
		assert!(corpus_commitment::validate_header(&candidate, super::CORE_CATALOG).is_ok());
		assert!(super::catalog_contract(&candidate.catalog).is_ok());

		for stale_identity in [
			"sha256:e613b92fe5fc8847b883a3ea3e7acaafaf0e3cca953bdbc8f29910a1ad75654c",
			"sha256:790894c76532c7e836d547289b09de13fdcf72c356d2e5f41262d9e73d8395eb",
			"sha256:cfac96630c9efe3153d80ed43effd6e541bef751e1e7f766a52cfb2910fa3fc4",
			"sha256:393cb2563b2161ccb42dd5a50ea63a7827f4d5c485ca0a98103e80eef3d0fbe6",
		] {
			candidate.catalog.identity_sha256 = stale_identity.to_owned();

			assert!(corpus_commitment::validate_header(&candidate, candidate_contract).is_err());
		}

		let mut predecessor = commitment();

		predecessor.catalog.task_set_version = "1.0.4".to_owned();
		predecessor.catalog.identity_sha256 =
			"sha256:2b009bfe1c590898b143c13b264b738f950cbda5c42dae104aaf9dd63426a59e".to_owned();

		assert!(corpus_commitment::validate_header(&predecessor, super::CORE_CATALOG).is_err());
		assert!(super::catalog_contract(&predecessor.catalog).is_err());

		let mut historical = commitment();

		historical.catalog.task_set_version = "1.0.2".to_owned();
		historical.catalog.identity_sha256 =
			"sha256:b7ddfd5aaeb1861db57a72e03dc7e9497e7b4b81a98800c1e299e995270af7bc".to_owned();

		assert!(corpus_commitment::validate_header(&historical, super::CORE_CATALOG).is_err());
		assert!(super::catalog_contract(&historical.catalog).is_err());

		let mut contrast = commitment();

		contrast.schema_version = super::CONTRAST_CATALOG.commitment_schema_version.to_owned();
		contrast.catalog.schema_version = super::CONTRAST_CATALOG.catalog_schema_version.to_owned();
		contrast.catalog.task_set_id = super::CONTRAST_CATALOG.task_set_id.to_owned();
		contrast.catalog.task_set_version = super::CONTRAST_CATALOG.task_set_version.to_owned();
		contrast.catalog.identity_sha256 = super::CONTRAST_CATALOG.identity_sha256.to_owned();
		contrast.catalog.identity_scope = super::CONTRAST_CATALOG.identity_scope.to_owned();

		assert_eq!(contrast.catalog.schema_version, "aiq.contrast-corpus.v1");
		assert_eq!(contrast.catalog.task_set_id, "aiq-core-contrast");
		assert_eq!(contrast.catalog.task_set_version, super::CONTROLLED_CONTRAST_TASK_SET_VERSION);
		assert_eq!(contrast.catalog.identity_scope, "ordered_full_task_metadata");
		assert_eq!(
			contrast.catalog.identity_sha256,
			"sha256:09d3b4532f3dcd7a6b07c31bc4c59e25d432889ee8cce0b75d15285a42d3e077"
		);
		assert_eq!(
			super::CONTROLLED_CONTRAST_CATALOG_IDENTITY_SHA256,
			contrast.catalog.identity_sha256
		);
		assert!(corpus_commitment::validate_header(&contrast, super::CONTRAST_CATALOG,).is_ok());
		assert!(corpus_commitment::validate_header(&contrast, super::CORE_CATALOG).is_err());

		contrast.catalog.identity_sha256 =
			"sha256:3efac0059a58869fc4283156b7e5dcaab4141a231e2980b52f1b599732e62f32".to_owned();

		assert_eq!(contrast.catalog.task_set_version, super::CONTROLLED_CONTRAST_TASK_SET_VERSION);
		assert!(corpus_commitment::validate_header(&contrast, super::CONTRAST_CATALOG).is_err());
		assert!(super::catalog_contract(&contrast.catalog).is_err());

		let mut synthetic = commitment();

		synthetic.synthetic = true;

		assert!(corpus_commitment::validate_header(&synthetic, super::CORE_CATALOG).is_err());

		let mut uncontrolled = commitment();

		uncontrolled.controlled = false;

		assert!(corpus_commitment::validate_header(&uncontrolled, super::CORE_CATALOG).is_err());
	}

	#[test]
	fn contrast_identity_is_derived_from_generated_current_catalog() {
		let catalog: serde_json::Value = serde_json::from_str(super::CONTRAST_PUBLIC_CATALOG_JSON)
			.expect("generated Contrast public catalog");

		assert_eq!(
			catalog.get("schema_version").and_then(serde_json::Value::as_str),
			Some("aiq.contrast-corpus.v1")
		);
		assert_eq!(
			catalog.get("task_set_id").and_then(serde_json::Value::as_str),
			Some("aiq-core-contrast")
		);
		assert_eq!(
			catalog.get("task_set_version").and_then(serde_json::Value::as_str),
			Some(super::CONTROLLED_CONTRAST_TASK_SET_VERSION)
		);
		assert_eq!(
			catalog.get("scoring_version").and_then(serde_json::Value::as_str),
			Some(crate::scoring::AIQ_TASK_SCORER_VERSION)
		);
		assert_eq!(
			catalog.get("calibration_only").and_then(serde_json::Value::as_bool),
			Some(true)
		);

		let tasks = catalog
			.get("tasks")
			.and_then(serde_json::Value::as_array)
			.expect("six generated Contrast tasks");

		assert_eq!(tasks.len(), super::CONTRAST_TASK_IDS.len());

		for (task, expected_id) in tasks.iter().zip(super::CONTRAST_TASK_IDS) {
			assert_eq!(task.get("task_id").and_then(serde_json::Value::as_str), Some(expected_id));
			assert_eq!(
				task.get("task_version").and_then(serde_json::Value::as_str),
				Some(super::CONTROLLED_CONTRAST_TASK_SET_VERSION)
			);
		}

		let derived = protocol::canonical_hash(catalog.get("tasks").expect("task metadata"))
			.expect("canonical generated Contrast catalog identity");

		assert_eq!(derived, super::CONTROLLED_CONTRAST_CATALOG_IDENTITY_SHA256);
		assert_eq!(
			catalog.get("identity_sha256").and_then(serde_json::Value::as_str),
			Some(derived.as_str())
		);
	}

	#[test]
	fn contrast_tool_policy_requires_all_six_tasks_in_order() {
		let mut tasks = runner::synthetic_demo_tasks()[..6].to_vec();

		for (task, task_id) in tasks.iter_mut().zip(super::CONTRAST_TASK_IDS) {
			task.task_id = task_id.to_owned();
			task.task_version = super::AIQ_TASK_SET_VERSION.to_owned();
		}

		let policy = super::catalog_tool_policy_tasks(super::CONTRAST_CATALOG, Some(&tasks))
			.expect("contrast tool policy");

		assert_eq!(policy.len(), 6);
		assert_eq!(
			policy[0].pointer("/task_id").and_then(serde_json::Value::as_str),
			Some("contrast-coupled-challenge-01")
		);
		assert!(super::catalog_tool_policy_tasks(super::CONTRAST_CATALOG, None).is_err());

		tasks.swap(0, 1);

		assert!(super::catalog_tool_policy_tasks(super::CONTRAST_CATALOG, Some(&tasks),).is_err());
	}

	#[test]
	fn current_and_contrast_provenance_enforce_run_class() {
		let task_set = format!("sha256:{}", "b".repeat(64));
		let preflight = format!("sha256:{}", "c".repeat(64));
		let mut provenance = corpus_commitment::fixture_run_provenance_for_class(
			super::RunClass::Calibration,
			task_set.clone(),
			format!("sha256:{}", "d".repeat(64)),
			format!("sha256:{}", "e".repeat(64)),
			preflight.clone(),
		);

		assert!(
			corpus_commitment::validate_run_provenance(&provenance, &task_set, &preflight).is_ok()
		);

		provenance.run_class = super::RunClass::Official;

		assert!(
			corpus_commitment::validate_run_provenance(&provenance, &task_set, &preflight).is_ok()
		);

		provenance.catalog_digest = super::CONTRAST_CATALOG.identity_sha256.to_owned();

		assert!(
			corpus_commitment::validate_run_provenance(&provenance, &task_set, &preflight).is_err()
		);

		provenance.run_class = super::RunClass::Calibration;

		assert!(
			corpus_commitment::validate_run_provenance(&provenance, &task_set, &preflight).is_ok()
		);

		provenance.run_class = super::RunClass::Official;

		assert!(
			corpus_commitment::validate_run_provenance(&provenance, &task_set, &preflight).is_err()
		);

		provenance.run_class = super::RunClass::Calibration;
		provenance.catalog_digest = format!("sha256:{}", "f".repeat(64));

		assert!(
			corpus_commitment::validate_run_provenance(&provenance, &task_set, &preflight).is_err()
		);
		assert!(
			corpus_commitment::validate_historical_calibration_provenance(
				&provenance,
				&task_set,
				&preflight,
			)
			.is_ok()
		);

		provenance.run_class = super::RunClass::Official;

		assert!(
			corpus_commitment::validate_historical_calibration_provenance(
				&provenance,
				&task_set,
				&preflight,
			)
			.is_err()
		);
	}

	#[test]
	fn source_manifest_is_checked_against_current_bytes_and_executables_are_hashed() {
		let root = env::temp_dir().join(format!("aiq-source-manifest-{}", process::id()));
		let path = root.join("apps/aiq-runner/src/lib.rs");
		let bytes = b"committed source";

		fs::create_dir_all(path.parent().expect("parent")).expect("create root");
		fs::write(&path, bytes).expect("write source");

		let manifest = SourceManifest {
			schema_version: "aiq.runner-source-manifest.v1".to_owned(),
			package: "aiq-runner".to_owned(),
			scope: "cargo_build_and_test_inputs".to_owned(),
			path_base: "repository_root".to_owned(),
			entries: vec![SourceManifestEntry {
				path: "apps/aiq-runner/src/lib.rs".to_owned(),
				sha256: format!("sha256:{}", hex::encode(Sha256::digest(bytes))),
			}],
		};

		assert!(corpus_commitment::validate_source_manifest(&manifest, &root).is_ok());

		fs::write(&path, b"stale source").expect("mutate source");

		assert!(corpus_commitment::validate_source_manifest(&manifest, &root).is_err());

		let runner_digest =
			corpus_commitment::runner_executable_digest().expect("runner executable digest");
		let current = env::current_exe().expect("current executable");
		let selected_digest =
			corpus_commitment::codex_executable_digest(current.to_str().expect("UTF-8 path"))
				.expect("selector digest");

		assert!(super::valid_digest(&runner_digest));
		assert_eq!(runner_digest, selected_digest);

		fs::remove_dir_all(root).expect("remove root");
	}

	#[test]
	fn selected_hidden_task_must_match_the_exact_corpus_commitment() {
		let runtime_digest = format!("sha256:{}", "a".repeat(64));
		let executable_digest = format!("sha256:{}", "b".repeat(64));
		let catalog_digest = format!("sha256:{}", "c".repeat(64));
		let configuration = serde_json::from_value(serde_json::json!({
			"schema_version": crate::task::EVALUATOR_CONFIG_SCHEMA_VERSION,
			"completion_policy": "natural_completion"
		}))
		.expect("formal evaluator configuration");
		let configuration_digest =
			protocol::canonical_hash(&configuration).expect("configuration digest");
		let mut task = runner::synthetic_tasks().remove(0);

		task.visibility = crate::task::Visibility::Hidden;
		task.catalog_entry_digest = Some(catalog_digest.clone());
		task.evaluator = Some(crate::task::Evaluator {
			kind: "controlled_fixture".to_owned(),
			expected: None,
			case_sensitive: false,
			external: Some(crate::task::ExternalEvaluatorBinding {
				protocol_version: crate::task::EVALUATOR_PROTOCOL_VERSION.to_owned(),
				scorer_version: task.scorer_version.clone(),
				runtime_kind: crate::task::EvaluatorRuntimeKind::Node,
				runtime_executable_digest: runtime_digest.clone(),
				executable_ref: std::path::PathBuf::from("aiq-core-v1/evaluator"),
				executable_digest: executable_digest.clone(),
				configuration_digest: configuration_digest.clone(),
				arguments: Vec::new(),
				timeout_ms: None,
				max_input_bytes: 1_024,
				max_output_bytes: 1_024,
				configuration,
			}),
		});

		let task_definition_sha256 = task.content_hash().expect("task digest");
		let committed = super::CorpusTask {
			task_id: task.task_id.clone(),
			task_version: task.task_version.clone(),
			task_definition_sha256: task_definition_sha256.clone(),
			baseline_workspace_tree_sha256: format!("sha256:{}", "d".repeat(64)),
			fixture_bundle_sha256: format!("sha256:{}", "e".repeat(64)),
			catalog_entry_sha256: catalog_digest,
			evaluator_runtime_kind: "node".to_owned(),
			evaluator_runtime_executable_sha256: runtime_digest,
			evaluator_executable_sha256: executable_digest,
			evaluator_configuration_sha256: configuration_digest,
			acceptance_suite_sha256: format!("sha256:{}", "1".repeat(64)),
			leakage_review_sha256: format!("sha256:{}", "2".repeat(64)),
		};

		assert!(
			super::validate_selected_tasks(slice::from_ref(&committed), slice::from_ref(&task))
				.is_ok()
		);

		let mut mutated_task = task.clone();

		mutated_task.prompt.push_str(" unexpected drift");

		assert!(
			super::validate_selected_tasks(
				slice::from_ref(&committed),
				slice::from_ref(&mutated_task),
			)
			.is_err()
		);

		let mut mutated_commitment = committed;

		mutated_commitment.task_definition_sha256 = format!("sha256:{}", "f".repeat(64));

		assert!(
			super::validate_selected_tasks(
				slice::from_ref(&mutated_commitment),
				slice::from_ref(&task),
			)
			.is_err()
		);
	}

	#[test]
	fn source_manifest_path_grammar_matches_the_public_commitment_contract() {
		assert!(super::valid_source_path("apps/aiq-runner/src/runner.rs"));
		assert!(super::valid_source_path(".github/dependabot.yml"));
		assert!(super::valid_source_path("component.../file_name-01.rs"));

		for path in [
			"",
			"/absolute.rs",
			"./file.rs",
			"dir/./file.rs",
			"dir/../file.rs",
			"../file.rs",
			"dir//file.rs",
			"dir/",
			"dir\\file.rs",
			"C:/file.rs",
			"dir/file.rs\n",
			"dir/file.rs\r\n",
			"dir/file.rs\u{2028}",
			"dir/file.rs\u{2029}",
		] {
			assert!(!super::valid_source_path(path), "{path:?} must be rejected");
		}

		assert!(!super::valid_source_path(&"a".repeat(241)));
	}

	#[cfg(unix)]
	#[test]
	fn codex_runtime_requires_one_exact_private_main_and_host_pair() {
		let root = env::temp_dir().join(format!(
			"aiq-codex-runtime-bundle-{}-{}",
			process::id(),
			std::time::SystemTime::now()
				.duration_since(std::time::UNIX_EPOCH)
				.expect("fixture clock")
				.as_nanos()
		));
		let bundle = root.join("bundle");
		let main = bundle.join(super::CODEX_MAIN_EXECUTABLE_NAME);
		let host = bundle.join(super::CODEX_CODE_MODE_HOST_EXECUTABLE_NAME);

		fs::create_dir_all(&bundle).expect("runtime bundle fixture");
		fs::write(&main, b"codex-main-v1").expect("main fixture");
		fs::write(&host, b"codex-host-v1").expect("host fixture");

		for executable in [&main, &host] {
			fs::set_permissions(executable, fs::Permissions::from_mode(0o700))
				.expect("executable mode");
		}

		let selector = main.to_str().expect("UTF-8 fixture path");

		assert_eq!(
			super::codex_code_mode_host_path(selector).expect("valid runtime pair"),
			fs::canonicalize(&host).expect("canonical host fixture")
		);

		let original_host_digest =
			super::codex_code_mode_host_digest(selector).expect("host digest");

		assert_ne!(
			super::codex_executable_digest(selector).expect("main digest"),
			original_host_digest
		);

		fs::write(bundle.join("unexpected"), b"extra").expect("extra fixture");

		assert!(super::codex_code_mode_host_path(selector).is_err());

		fs::remove_file(bundle.join("unexpected")).expect("remove extra fixture");
		fs::write(&host, b"codex-host-v2").expect("mutated host fixture");

		assert_ne!(
			super::codex_code_mode_host_digest(selector).expect("mutated host digest"),
			original_host_digest
		);

		fs::set_permissions(&host, fs::Permissions::from_mode(0o600))
			.expect("non-executable host mode");

		assert!(super::codex_code_mode_host_digest(selector).is_err());

		fs::remove_file(&host).expect("remove host fixture");

		let external_target = root.join("external-host");

		fs::write(&external_target, b"external host").expect("external target");
		fs::set_permissions(&external_target, fs::Permissions::from_mode(0o700))
			.expect("external executable mode");
		std::os::unix::fs::symlink(&external_target, &host).expect("host symlink fixture");

		assert!(super::codex_code_mode_host_digest(selector).is_err());

		fs::remove_file(&host).expect("remove host symlink");
		fs::write(&host, b"codex-host-v3").expect("restored host fixture");
		fs::set_permissions(&host, fs::Permissions::from_mode(0o700)).expect("restored host mode");
		fs::set_permissions(&bundle, fs::Permissions::from_mode(0o770))
			.expect("writable bundle mode");

		assert!(super::codex_code_mode_host_digest(selector).is_err());

		fs::set_permissions(&bundle, fs::Permissions::from_mode(0o700))
			.expect("private bundle mode");
		fs::hard_link(&main, root.join("main-hardlink")).expect("main hard link fixture");

		assert!(super::codex_executable_digest(selector).is_err());

		fs::remove_dir_all(root).expect("runtime bundle cleanup");
	}

	#[cfg(unix)]
	#[test]
	fn source_manifest_rejects_actual_terminator_non_utf8_symlink_and_special_filenames() {
		let root = env::temp_dir().join(format!("aiq-source-filename-types-{}", process::id()));

		fs::create_dir_all(&root).expect("create root");

		for (index, name) in [
			"line\nfeed.rs",
			"carriage\r\nreturn.rs",
			"line\u{2028}separator.rs",
			"paragraph\u{2029}separator.rs",
		]
		.into_iter()
		.enumerate()
		{
			let bytes = format!("source-{index}").into_bytes();
			let path = root.join(name);

			fs::write(&path, &bytes).expect("write terminator filename");

			let manifest = SourceManifest {
				schema_version: "aiq.runner-source-manifest.v1".to_owned(),
				package: "aiq-runner".to_owned(),
				scope: "cargo_build_and_test_inputs".to_owned(),
				path_base: "repository_root".to_owned(),
				entries: vec![SourceManifestEntry {
					path: name.to_owned(),
					sha256: format!("sha256:{}", hex::encode(Sha256::digest(&bytes))),
				}],
			};

			assert!(corpus_commitment::validate_source_manifest(&manifest, &root).is_err());
		}

		let non_utf8 = OsString::from_vec(b"non-utf8-\xff.rs".to_vec());
		let non_utf8_path = root.join(&non_utf8);
		let lossy_name = non_utf8.to_string_lossy().into_owned();

		assert!(!super::valid_source_path(&lossy_name));

		match fs::write(&non_utf8_path, b"source") {
			Ok(()) => {
				let non_utf8_manifest = SourceManifest {
					schema_version: "aiq.runner-source-manifest.v1".to_owned(),
					package: "aiq-runner".to_owned(),
					scope: "cargo_build_and_test_inputs".to_owned(),
					path_base: "repository_root".to_owned(),
					entries: vec![SourceManifestEntry {
						path: lossy_name,
						sha256: format!("sha256:{}", hex::encode(Sha256::digest(b"source"))),
					}],
				};

				assert!(
					corpus_commitment::validate_source_manifest(&non_utf8_manifest, &root).is_err()
				);
			},
			Err(error) if error.raw_os_error() == Some(92) => {},
			Err(error) => panic!("write non-UTF-8 filename: {error}"),
		}

		fs::write(root.join("target.rs"), b"source").expect("write symlink target");
		std::os::unix::fs::symlink("target.rs", root.join("linked.rs")).expect("create symlink");

		let symlink_manifest = SourceManifest {
			schema_version: "aiq.runner-source-manifest.v1".to_owned(),
			package: "aiq-runner".to_owned(),
			scope: "cargo_build_and_test_inputs".to_owned(),
			path_base: "repository_root".to_owned(),
			entries: vec![SourceManifestEntry {
				path: "linked.rs".to_owned(),
				sha256: format!("sha256:{}", hex::encode(Sha256::digest(b"source"))),
			}],
		};

		assert!(corpus_commitment::validate_source_manifest(&symlink_manifest, &root).is_err());

		let listener = UnixListener::bind(root.join("special.sock")).expect("create special file");
		let special_manifest = SourceManifest {
			schema_version: "aiq.runner-source-manifest.v1".to_owned(),
			package: "aiq-runner".to_owned(),
			scope: "cargo_build_and_test_inputs".to_owned(),
			path_base: "repository_root".to_owned(),
			entries: vec![SourceManifestEntry {
				path: "special.sock".to_owned(),
				sha256: format!("sha256:{}", "a".repeat(64)),
			}],
		};

		assert!(corpus_commitment::validate_source_manifest(&special_manifest, &root).is_err());

		drop(listener);

		fs::remove_dir_all(root).expect("remove root");
	}
}
