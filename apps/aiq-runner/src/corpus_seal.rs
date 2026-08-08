//! Deterministic authoring boundary for a complete controlled corpus seal.

use std::error::Error;
use std::io::Read;
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt as _, OpenOptionsExt as _, PermissionsExt as _};
use std::{
	collections::{BTreeMap, BTreeSet},
	env::consts::{ARCH, OS},
	fs::{self, File, OpenOptions, Permissions},
	io::Write as _,
	path::{Path, PathBuf},
	process::{self, Command},
	sync::atomic::{AtomicU64, Ordering},
};

use clap::ValueEnum;
#[cfg(unix)]
use libc::O_NOFOLLOW;
use serde::{Deserialize, Serialize};
use serde_json::{self, Value};
use sha2::{Digest as _, Sha256};

use crate::{
	cli,
	corpus_commitment::{self, ExecutionToolPolicy, ToolchainCommand},
	protocol, runner,
	task::{
		DirectoryTaskSource, EvaluatorRuntime, EvaluatorRuntimeKind, TaskDefinition, TaskSource,
		Visibility, evaluator,
	},
};

const MAX_SOURCE_FILE_BYTES: u64 = 16 * 1_024 * 1_024;
const MAX_FILE_BYTES: u64 = 256 * 1_024 * 1_024;
const MAX_TREE_FILES: usize = 4_096;
const MAX_TREE_BYTES: u64 = 512 * 1_024 * 1_024;
const CORE_REQUIRED_CLASSES: [&str; 4] =
	["adversarial_format", "alternate_correct", "gold", "partial"];
const CORE_OPTIONAL_CLASSES: [&str; 2] = ["empty", "timeout"];
const CONTRAST_REQUIRED_CLASSES: [&str; 6] =
	["challenge", "empty", "format", "near_miss", "reference", "tamper"];
const NO_OPTIONAL_CLASSES: [&str; 0] = [];
const CORE_CATALOG: &str = "benchmarks/candidates/aiq-core-1.0.6/catalog.json";
const CONTRAST_CATALOG: &str = "benchmarks/candidates/aiq-core-1.0.6/contrast-catalog.json";
const SOURCE_INVENTORY: &str = "benchmarks/corpus-source-inventory-v1.json";
const CATALOG_GENERATOR: &str = "scripts/candidates/aiq-core-1.0.6/generate-benchmark-catalog.ts";
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Complete explicit inputs for one create-new seal.
pub struct SealOptions {
	/// Catalog authority for this seal.
	pub corpus_kind: CorpusKind,
	/// New release identity.
	pub release_id: String,
	/// Exact hidden-task directory.
	pub tasks_root: PathBuf,
	/// Exact per-task baseline directory.
	pub baselines_root: PathBuf,
	/// Exact per-task acceptance directory.
	pub acceptance_root: PathBuf,
	/// Exact evaluator registry root.
	pub evaluator_root: PathBuf,
	/// Exact Node.js evaluator executable.
	pub evaluator_runtime: PathBuf,
	/// Exact Node.js and ripgrep directory.
	pub codex_toolchain_root: PathBuf,
	/// Clean repository source root.
	pub source_root: PathBuf,
	/// Supplied exact Git commit identity.
	pub source_commit: String,
	/// Supplied exact Git tree identity.
	pub source_tree: String,
	/// Typed runtime-authority input file.
	pub runtime_authority: PathBuf,
	/// Create-new atomic sealed output directory.
	pub output: PathBuf,
}

/// Corpus authority selected before any private input is read.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize, ValueEnum)]
#[serde(rename_all = "snake_case")]
pub enum CorpusKind {
	/// The exact 72-task AIQ Core catalog.
	Core,
	/// The exact six-task calibration-only Contrast catalog.
	Contrast,
}
impl CorpusKind {
	fn catalog_path(self) -> &'static str {
		match self {
			Self::Core => CORE_CATALOG,
			Self::Contrast => CONTRAST_CATALOG,
		}
	}

	fn task_count(self) -> usize {
		match self {
			Self::Core => 72,
			Self::Contrast => 6,
		}
	}

	fn acceptance_policy(self) -> AcceptancePolicy {
		match self {
			Self::Core => AcceptancePolicy {
				required: &CORE_REQUIRED_CLASSES,
				optional: &CORE_OPTIONAL_CLASSES,
			},
			Self::Contrast => AcceptancePolicy {
				required: &CONTRAST_REQUIRED_CLASSES,
				optional: &NO_OPTIONAL_CLASSES,
			},
		}
	}

	fn harness_schema(self) -> &'static str {
		match self {
			Self::Core => "aiq.core-authoring-harness.v3",
			Self::Contrast => "aiq.contrast-authoring-harness.v3",
		}
	}
}

#[derive(Clone, Copy)]
struct AcceptancePolicy {
	required: &'static [&'static str],
	optional: &'static [&'static str],
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RuntimeAuthority {
	schema_version: String,
	operating_system: OperatingSystem,
	locale_and_timezone: LocaleAndTimezone,
	node_release: NodeRelease,
	node_components: BTreeMap<String, Option<String>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct OperatingSystem {
	platform: String,
	architecture: String,
	#[serde(rename = "type")]
	type_name: String,
	release: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct LocaleAndTimezone {
	environment: RuntimeEnvironment,
	resolved_locale: String,
	resolved_time_zone: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
#[allow(non_snake_case)]
struct RuntimeEnvironment {
	LANG: Option<String>,
	LC_ALL: Option<String>,
	OPENSSL_CONF: String,
	TZ: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct NodeRelease {
	name: String,
	source_url: Option<String>,
	headers_url: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
struct GeneratorAuthority {
	name: &'static str,
	version: &'static str,
	toolchain_source: &'static str,
	source_path: &'static str,
	source_sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SourceInventory {
	schema_version: String,
	recursive_roots: Vec<String>,
	explicit_paths: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
struct ManifestEntry {
	path: String,
	sha256: String,
}

#[derive(Clone, Debug, Serialize)]
struct ControlledTree {
	schema_version: &'static str,
	entries: Vec<ManifestEntry>,
}

#[derive(Clone, Debug, Serialize)]
struct SourceManifest {
	schema_version: &'static str,
	package: &'static str,
	scope: &'static str,
	path_base: &'static str,
	entries: Vec<ManifestEntry>,
}

#[derive(Clone, Debug, Serialize)]
struct LeakageReview<'a> {
	schema_version: &'static str,
	task_id: &'a str,
	task_version: &'a str,
	reviewed: bool,
	status: &'static str,
	leakage_notes: &'a [String],
}

#[derive(Clone, Debug, Serialize)]
struct TaskCommitment {
	task_id: String,
	task_version: String,
	task_definition_sha256: String,
	baseline_workspace_tree_sha256: String,
	fixture_bundle_sha256: String,
	catalog_entry_sha256: String,
	evaluator_runtime_kind: &'static str,
	evaluator_runtime_executable_sha256: String,
	evaluator_executable_sha256: String,
	evaluator_configuration_sha256: String,
	acceptance_suite_sha256: String,
	leakage_review_sha256: String,
}

struct WrittenTaskAssets {
	commitments: Vec<TaskCommitment>,
	acceptance_classes_by_task: BTreeMap<String, Vec<String>>,
}

#[derive(Serialize)]
struct AuthoringInputManifest<'a> {
	schema_version: &'static str,
	corpus_kind: CorpusKind,
	release_id: &'a str,
	source_commit: &'a str,
	source_tree: &'a str,
	task_count: usize,
	acceptance_required_classes: &'static [&'static str],
	acceptance_optional_classes: &'static [&'static str],
	acceptance_classes_by_task: &'a BTreeMap<String, Vec<String>>,
	tasks_tree_sha256: String,
	baselines_tree_sha256: String,
	acceptance_tree_sha256: String,
	evaluator_tree_sha256: String,
	toolchain_tree_sha256: String,
	source_manifest_sha256: String,
	runtime_authority_sha256: String,
}

#[derive(Serialize)]
struct HarnessManifest<'a> {
	schema_version: &'static str,
	corpus_kind: CorpusKind,
	task_count: usize,
	acceptance_required_classes: &'static [&'static str],
	acceptance_optional_classes: &'static [&'static str],
	acceptance_classes_by_task: &'a BTreeMap<String, Vec<String>>,
	source_commit: &'a str,
	source_tree: &'a str,
	source_manifest_sha256: &'a str,
	sealer_source_sha256: String,
	input_contract_schema_sha256: BTreeMap<String, String>,
	task_catalog_corpus_evaluator_schema_sha256: BTreeMap<String, String>,
	evaluator_sha256: &'a str,
	node_sha256: &'a str,
	rg_sha256: &'a str,
	catalog_generator: &'a GeneratorAuthority,
	algorithm_ids: [&'static str; 5],
	ordered_task_commitment_aggregate_sha256: String,
}

#[derive(Serialize)]
struct SealReceipt<'a> {
	schema_version: &'static str,
	corpus_kind: CorpusKind,
	release_id: &'a str,
	catalog_identity_sha256: &'a str,
	task_count: usize,
	source_commit: &'a str,
	source_tree: &'a str,
	source_manifest_sha256: &'a str,
	commitment_canonical_sha256: &'a str,
	commitment_raw_file_sha256: &'a str,
	authoring_input_manifest_sha256: &'a str,
	harness_manifest_sha256: &'a str,
	sealed_tree_sha256: String,
	output_trees: BTreeMap<&'static str, String>,
}

#[derive(Deserialize)]
struct Catalog {
	schema_version: String,
	task_set_id: String,
	task_set_version: String,
	identity_sha256: Option<String>,
	identity_scope: Option<String>,
	task_metadata_identity: Option<CatalogMetadataIdentity>,
	tasks: Vec<Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CatalogMetadataIdentity {
	algorithm: String,
	canonicalization: String,
	digest: String,
	scope: String,
}

struct PreparedSeal {
	source_root: PathBuf,
	tasks_root: PathBuf,
	baselines_root: PathBuf,
	acceptance_root: PathBuf,
	evaluator_root: PathBuf,
	toolchain_root: PathBuf,
	runtime: EvaluatorRuntime,
	authority: RuntimeAuthority,
	generator_authority: GeneratorAuthority,
	tasks: Vec<TaskDefinition>,
	catalog: Catalog,
	catalog_identity_sha256: String,
	catalog_identity_scope: String,
	catalog_bytes: Vec<u8>,
	catalog_by_id: BTreeMap<String, String>,
	policy: ExecutionToolPolicy,
	node_sha256: String,
	rg_sha256: String,
	evaluator_sha256: String,
	source_manifest: SourceManifest,
	source_manifest_sha256: String,
}

struct DerivedExecution {
	runtime_provenance: Value,
	environment_sha256: String,
	tool_policy_sha256: String,
	network_policy_sha256: String,
	runner_prompt_sha256: String,
}

/// Seals a complete unchanged asset set and returns its canonical commitment digest.
pub fn seal_corpus(options: &SealOptions) -> Result<String, Box<dyn Error>> {
	validate_token(&options.release_id, "release id")?;
	validate_git_identity(&options.source_commit, "source commit")?;
	validate_git_identity(&options.source_tree, "source tree")?;

	if fs::symlink_metadata(&options.output).is_ok() {
		return Err("sealed output already exists".into());
	}

	let parent = options
		.output
		.parent()
		.filter(|path| !path.as_os_str().is_empty())
		.unwrap_or(Path::new("."));
	let parent = fs::canonicalize(parent)?;
	let output_name = options.output.file_name().ok_or("sealed output has no final component")?;
	let output = parent.join(output_name);
	let temporary = parent.join(format!(
		".{}.aiq-seal-{}-{}",
		output_name.to_string_lossy(),
		process::id(),
		TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
	));

	fs::create_dir(&temporary)?;

	#[cfg(unix)]
	{
		fs::set_permissions(&temporary, Permissions::from_mode(0o700))?;
	}

	let result = build_seal(options, &temporary).and_then(|canonical_sha256| {
		File::open(&temporary)?.sync_all()?;
		cli::atomic_rename_no_replace(&temporary, &output).map_err(|error| -> Box<dyn Error> {
			format!("cannot install create-new sealed directory: {error}").into()
		})?;
		File::open(&parent)?.sync_all()?;

		Ok(canonical_sha256)
	});

	if result.is_err() {
		let _ = fs::remove_dir_all(&temporary);
	}

	result
}

fn build_seal(options: &SealOptions, output: &Path) -> Result<String, Box<dyn Error>> {
	let prepared = prepare_seal(options)?;
	let task_assets = write_task_assets(options, output, &prepared)?;

	write_shared_assets(output, &prepared)?;

	let execution = derive_execution(&prepared)?;
	let (input_manifest_sha256, harness_sha256) = write_authoring_documents(
		options,
		output,
		&prepared,
		&task_assets.commitments,
		&task_assets.acceptance_classes_by_task,
	)?;

	write_commitment_and_receipt(
		options,
		output,
		&prepared,
		&task_assets.commitments,
		&execution,
		&input_manifest_sha256,
		&harness_sha256,
	)
}

fn prepare_seal(options: &SealOptions) -> Result<PreparedSeal, Box<dyn Error>> {
	let source_root = canonical_directory(&options.source_root, "source root")?;

	validate_git_source_identity(&source_root, &options.source_commit, &options.source_tree)?;

	let tasks_root = canonical_directory(&options.tasks_root, "task root")?;
	let baselines_root = canonical_directory(&options.baselines_root, "baseline root")?;
	let acceptance_root = canonical_directory(&options.acceptance_root, "acceptance root")?;
	let evaluator_root = canonical_directory(&options.evaluator_root, "evaluator root")?;
	let toolchain_root = canonical_directory(&options.codex_toolchain_root, "toolchain root")?;
	let runtime = EvaluatorRuntime::resolve(&options.evaluator_runtime)?;
	let authority: RuntimeAuthority =
		read_canonical_input(&options.runtime_authority, 128 * 1_024)?;

	validate_runtime_authority(&authority)?;

	let task_report = DirectoryTaskSource::new(&tasks_root, Some(Visibility::Hidden)).load();

	if !task_report.issues.is_empty() {
		return Err(format!("controlled tasks are invalid: {:?}", task_report.issues).into());
	}

	let mut tasks = task_report.tasks;

	if tasks.len() != options.corpus_kind.task_count() {
		return Err("controlled task count does not match corpus kind".into());
	}

	let catalog_bytes = read_regular_bounded(
		&source_root.join(options.corpus_kind.catalog_path()),
		MAX_FILE_BYTES,
	)?;
	let catalog: Catalog = serde_json::from_slice(&catalog_bytes)?;
	let (catalog_identity_sha256, catalog_identity_scope) =
		validate_catalog(options.corpus_kind, &catalog, &mut tasks)?;
	let catalog_by_id = catalog
		.tasks
		.iter()
		.map(|entry| {
			let id =
				entry.get("task_id").and_then(Value::as_str).ok_or("catalog task omits task_id")?;

			Ok((id.to_owned(), protocol::canonical_hash(entry)?))
		})
		.collect::<Result<BTreeMap<_, _>, Box<dyn Error>>>()?;
	let (policy, node_sha256, rg_sha256) =
		prepare_toolchain(&authority, &toolchain_root, &runtime)?;
	let source_manifest = build_source_manifest(&source_root)?;
	let source_manifest_sha256 = protocol::canonical_hash(&source_manifest)?;
	let generator_authority = GeneratorAuthority {
		name: "aiq-core-catalog-generator",
		version: "1.0.6",
		toolchain_source: "repository_source",
		source_path: CATALOG_GENERATOR,
		source_sha256: raw_file_sha256_bounded(
			&source_root.join(CATALOG_GENERATOR),
			MAX_SOURCE_FILE_BYTES,
		)?,
	};
	let evaluator_sha256 = validate_evaluator_assets(&tasks, &evaluator_root, &runtime)?;

	Ok(PreparedSeal {
		source_root,
		tasks_root,
		baselines_root,
		acceptance_root,
		evaluator_root,
		toolchain_root,
		runtime,
		authority,
		generator_authority,
		tasks,
		catalog,
		catalog_identity_sha256,
		catalog_identity_scope,
		catalog_bytes,
		catalog_by_id,
		policy,
		node_sha256,
		rg_sha256,
		evaluator_sha256,
		source_manifest,
		source_manifest_sha256,
	})
}

fn prepare_toolchain(
	authority: &RuntimeAuthority,
	root: &Path,
	runtime: &EvaluatorRuntime,
) -> Result<(ExecutionToolPolicy, String, String), Box<dyn Error>> {
	let (platform, architecture, minimal_path) = host_platform()?;

	if authority.operating_system.platform != platform
		|| authority.operating_system.architecture != architecture
	{
		return Err("runtime authority does not match the sealing host".into());
	}

	let expected_openssl = if platform == "win32" { "NUL" } else { "/dev/null" };

	if authority.locale_and_timezone.environment.OPENSSL_CONF != expected_openssl {
		return Err("runtime authority OPENSSL_CONF does not match the platform".into());
	}

	let node_name = if cfg!(windows) { "node.exe" } else { "node" };
	let rg_name = if cfg!(windows) { "rg.exe" } else { "rg" };
	let node_sha256 = raw_file_sha256(&root.join(node_name))?;
	let rg_sha256 = raw_file_sha256(&root.join(rg_name))?;

	if node_sha256 != runtime.executable_digest() {
		return Err("evaluator runtime must be the exact controlled Node.js executable".into());
	}

	let policy = ExecutionToolPolicy {
		schema_version: "aiq.execution-tool-policy.v1".to_owned(),
		platform: platform.to_owned(),
		architecture: architecture.to_owned(),
		platform_minimal_path: minimal_path.to_owned(),
		inherit_path: false,
		use_shell_profile: false,
		commands: vec![
			ToolchainCommand {
				name: "node".to_owned(),
				executable_ref: node_name.to_owned(),
				executable_sha256: node_sha256.clone(),
				version: runtime.version().to_owned(),
			},
			ToolchainCommand {
				name: "rg".to_owned(),
				executable_ref: rg_name.to_owned(),
				executable_sha256: rg_sha256.clone(),
				version: probe_version(&root.join(rg_name))?,
			},
		],
	};

	corpus_commitment::validate_model_toolchain(root, &policy, runtime)?;

	Ok((policy, node_sha256, rg_sha256))
}

fn validate_evaluator_assets(
	tasks: &[TaskDefinition],
	root: &Path,
	runtime: &EvaluatorRuntime,
) -> Result<String, Box<dyn Error>> {
	let bindings = tasks
		.iter()
		.map(|task| {
			task.evaluator
				.as_ref()
				.and_then(|value| value.external.as_ref())
				.ok_or("task lacks external evaluator")
		})
		.collect::<Result<Vec<_>, _>>()?;
	let paths =
		bindings.iter().map(|binding| binding.executable_ref.clone()).collect::<BTreeSet<_>>();

	if paths.len() != 1 {
		return Err("tasks must reference exactly one evaluator".into());
	}

	let evaluator_path = paths.first().expect("one evaluator");
	let evaluator_sha256 = validate_evaluator_tree(root, evaluator_path)?;

	validate_shared_runtime_identities(
		bindings
			.iter()
			.map(|binding| (binding.runtime_kind, binding.runtime_executable_digest.as_str())),
		runtime.executable_digest(),
	)?;

	bindings.first().expect("tasks are nonempty").validate_runtime(runtime)?;

	for binding in bindings {
		binding.validate_registry(root)?;

		if protocol::canonical_hash(&binding.configuration)? != binding.configuration_digest {
			return Err("evaluator configuration does not match its canonical digest".into());
		}
	}

	Ok(evaluator_sha256)
}

fn validate_shared_runtime_identities<'a>(
	bindings: impl IntoIterator<Item = (EvaluatorRuntimeKind, &'a str)>,
	expected_digest: &str,
) -> Result<(), Box<dyn Error>> {
	let mut count = 0_usize;

	for (kind, digest) in bindings {
		count += 1;

		if kind != EvaluatorRuntimeKind::Node || digest != expected_digest {
			return Err("task evaluator runtime identity does not match the shared runtime".into());
		}
	}

	if count == 0 {
		return Err("task set has no evaluator runtime identity".into());
	}

	Ok(())
}

fn validate_evaluator_tree(root: &Path, evaluator_path: &Path) -> Result<String, Box<dyn Error>> {
	let evaluator =
		evaluator_path.to_str().ok_or("evaluator path is not UTF-8")?.replace('\\', "/");

	validate_relative_path(&evaluator)?;

	let marker_path = evaluator_path
		.parent()
		.ok_or("evaluator path has no controlled parent")?
		.join(".aiq-controlled-generated-v1");
	let marker =
		marker_path.to_str().ok_or("evaluator marker path is not UTF-8")?.replace('\\', "/");
	let observed =
		controlled_tree(root)?.entries.into_iter().map(|entry| entry.path).collect::<BTreeSet<_>>();
	let evaluator_only = BTreeSet::from([evaluator.clone()]);
	let evaluator_and_marker = BTreeSet::from([evaluator, marker.clone()]);

	if observed != evaluator_only && observed != evaluator_and_marker {
		return Err("evaluator root contains an uncommitted path".into());
	}
	if observed.contains(&marker)
		&& read_regular_bounded(&root.join(marker_path), 10)? != b"generated\n"
	{
		return Err("evaluator generated marker is invalid".into());
	}

	raw_file_sha256(&root.join(evaluator_path))
}

fn write_task_assets(
	options: &SealOptions,
	output: &Path,
	prepared: &PreparedSeal,
) -> Result<WrittenTaskAssets, Box<dyn Error>> {
	let output_tasks = output.join("tasks");
	let output_baselines = output.join("baselines");
	let output_acceptance = output.join("acceptance");
	let output_leakage = output.join("leakage-reviews");

	for path in [&output_tasks, &output_baselines, &output_acceptance, &output_leakage] {
		fs::create_dir(path)?;
	}

	let mut task_commitments = Vec::with_capacity(prepared.tasks.len());
	let mut acceptance_classes_by_task = BTreeMap::new();

	for task in &prepared.tasks {
		validate_fixture_refs(task)?;

		let baseline = prepared.baselines_root.join(&task.task_id);
		let acceptance = prepared.acceptance_root.join(&task.task_id);
		let acceptance_classes =
			validate_acceptance_classes(&acceptance, options.corpus_kind.acceptance_policy())?;

		acceptance_classes_by_task.insert(task.task_id.clone(), acceptance_classes);

		let baseline_manifest = runner::build_workspace_manifest(&baseline)?;
		let baseline_sha256 = protocol::canonical_hash(&baseline_manifest)?;
		let fixture_sha256 = protocol::canonical_hash(&controlled_tree(&baseline)?)?;
		let acceptance_sha256 = protocol::canonical_hash(&controlled_tree(&acceptance)?)?;
		let leakage = LeakageReview {
			schema_version: "aiq.leakage-review.v1",
			task_id: &task.task_id,
			task_version: &task.task_version,
			reviewed: true,
			status: "reviewed",
			leakage_notes: &task.leakage_notes,
		};
		let leakage_sha256 = protocol::canonical_hash(&leakage)?;

		write_canonical_json(&output_tasks.join(format!("{}.json", task.task_id)), task)?;
		copy_tree(&baseline, &output_baselines.join(&task.task_id))?;
		copy_tree(&acceptance, &output_acceptance.join(&task.task_id))?;
		write_canonical_json(&output_leakage.join(format!("{}.json", task.task_id)), &leakage)?;

		let binding = task
			.evaluator
			.as_ref()
			.and_then(|value| value.external.as_ref())
			.expect("validated evaluator");
		let catalog_entry_sha256 =
			prepared.catalog_by_id.get(&task.task_id).ok_or("task is absent from catalog")?.clone();

		if task.catalog_entry_digest.as_deref() != Some(&catalog_entry_sha256) {
			return Err("task catalog entry digest is not derived from the selected catalog".into());
		}

		task_commitments.push(TaskCommitment {
			task_id: task.task_id.clone(),
			task_version: task.task_version.clone(),
			task_definition_sha256: task.content_hash()?,
			baseline_workspace_tree_sha256: baseline_sha256,
			fixture_bundle_sha256: fixture_sha256,
			catalog_entry_sha256,
			evaluator_runtime_kind: "node",
			evaluator_runtime_executable_sha256: prepared.runtime.executable_digest().to_owned(),
			evaluator_executable_sha256: binding.executable_digest.clone(),
			evaluator_configuration_sha256: binding.configuration_digest.clone(),
			acceptance_suite_sha256: acceptance_sha256,
			leakage_review_sha256: leakage_sha256,
		});
	}

	Ok(WrittenTaskAssets { commitments: task_commitments, acceptance_classes_by_task })
}

fn write_shared_assets(output: &Path, prepared: &PreparedSeal) -> Result<(), Box<dyn Error>> {
	copy_tree(&prepared.evaluator_root, &output.join("evaluator"))?;
	copy_tree(&prepared.toolchain_root, &output.join("toolchain"))?;
	copy_source_snapshot(
		&prepared.source_root,
		&prepared.source_manifest,
		&output.join("source-snapshot"),
	)?;
	write_canonical_json(
		&output.join("catalog.json"),
		&serde_json::from_slice::<Value>(&prepared.catalog_bytes)?,
	)?;
	write_canonical_json(&output.join("source-manifest.json"), &prepared.source_manifest)?;
	write_canonical_json(&output.join("runtime-authority.json"), &prepared.authority)?;

	Ok(())
}

fn derive_execution(prepared: &PreparedSeal) -> Result<DerivedExecution, Box<dyn Error>> {
	let runtime_provenance = serde_json::json!({
		"schema_version": "aiq.execution-provenance.v1",
		"operating_system": prepared.authority.operating_system,
		"locale_and_timezone": prepared.authority.locale_and_timezone,
		"node_runtime": {
			"executable_sha256": prepared.runtime.executable_digest(),
			"version": prepared.runtime.version(),
			"release": prepared.authority.node_release,
			"components": prepared.authority.node_components,
		},
		"model_toolchain": prepared.policy,
		"evaluator": {
			"executable_sha256": prepared.evaluator_sha256,
			"dependency_model": "node_builtin_modules_only",
			"acceptance_invocation": {"executable":"committed_node_runtime","arguments":["<committed-evaluator-script>"],"cwd":"repository_root","environment":"empty"},
			"scenario_invocation": {
				"executable":"committed_node_runtime",
				"arguments":["--no-warnings","--abort-on-uncaught-exception","--unhandled-rejections=strict","--disable-sigusr1","--experimental-vm-modules","--max-old-space-size=128","--permission","--allow-fs-read=<candidate-workspace>","<scenario-launcher-in-disposable-workspace>"],
				"hidden_source_transport":"inherited descriptor 3 consumed by the launcher before candidate import",
				"authentication_transport":"random HMAC key and nonce on inherited descriptor 4 consumed before candidate import",
				"trusted_completion_transport":"HMAC-SHA-256 completion record on inherited descriptor 5",
				"optional_write_argument":"--allow-fs-write=<candidate-workspace>","environment":"empty"
			}
		},
		"runner": {"identity_kind":"source_only","source_manifest":prepared.source_manifest,"source_manifest_sha256":prepared.source_manifest_sha256,"built_binary_sha256":null},
		"codex": {"invoked":false,"binary_sha256":null,"version":null}
	});
	let environment_sha256 = protocol::canonical_hash(&runtime_provenance)?;
	let tool_policy_sha256 = protocol::canonical_hash(&serde_json::json!({
		"protocol":"aiq.tool-policy.v1","evidence_class":"declared_policy_commitment",
		"catalog": prepared.tasks.iter().map(|task| serde_json::json!({"task_id":task.task_id,"allowed_tools":task.allowed_tools})).collect::<Vec<_>>(),
		"model_toolchain": runtime_provenance["model_toolchain"]
	}))?;
	let network_policy_sha256 = protocol::canonical_hash(&serde_json::json!({
		"protocol":"aiq.network-policy.v1","evidence_class":"declared_policy_commitment",
		"codex_web_search":"disabled_for_controlled_corpus","codex_mcp":"disabled",
		"evaluator_node_scenario":"network_denied_by_node_permission_model"
	}))?;
	let runner_prompt_sha256 = prepared
		.source_manifest
		.entries
		.iter()
		.find(|entry| entry.path == "apps/aiq-runner/src/runner.rs")
		.ok_or("source inventory omits runner.rs")?
		.sha256
		.clone();

	Ok(DerivedExecution {
		runtime_provenance,
		environment_sha256,
		tool_policy_sha256,
		network_policy_sha256,
		runner_prompt_sha256,
	})
}

fn write_authoring_documents(
	options: &SealOptions,
	output: &Path,
	prepared: &PreparedSeal,
	task_commitments: &[TaskCommitment],
	acceptance_classes_by_task: &BTreeMap<String, Vec<String>>,
) -> Result<(String, String), Box<dyn Error>> {
	let acceptance_policy = options.corpus_kind.acceptance_policy();
	let input_manifest = AuthoringInputManifest {
		schema_version: "aiq.corpus-authoring-input.v1",
		corpus_kind: options.corpus_kind,
		release_id: &options.release_id,
		source_commit: &options.source_commit,
		source_tree: &options.source_tree,
		task_count: prepared.tasks.len(),
		acceptance_required_classes: acceptance_policy.required,
		acceptance_optional_classes: acceptance_policy.optional,
		acceptance_classes_by_task,
		tasks_tree_sha256: protocol::canonical_hash(&controlled_tree(&prepared.tasks_root)?)?,
		baselines_tree_sha256: protocol::canonical_hash(&controlled_tree(
			&prepared.baselines_root,
		)?)?,
		acceptance_tree_sha256: protocol::canonical_hash(&controlled_tree(
			&prepared.acceptance_root,
		)?)?,
		evaluator_tree_sha256: protocol::canonical_hash(&controlled_tree(
			&prepared.evaluator_root,
		)?)?,
		toolchain_tree_sha256: protocol::canonical_hash(&controlled_tree(
			&prepared.toolchain_root,
		)?)?,
		source_manifest_sha256: prepared.source_manifest_sha256.clone(),
		runtime_authority_sha256: protocol::canonical_hash(&prepared.authority)?,
	};
	let input_manifest_sha256 = protocol::canonical_hash(&input_manifest)?;

	write_canonical_json(&output.join("authoring-input.json"), &input_manifest)?;

	let schema_paths = [
		"benchmarks/schema/corpus-authoring-harness-v3.schema.json",
		"benchmarks/schema/corpus-authoring-input-v1.schema.json",
		"benchmarks/schema/corpus-runtime-authority-v1.schema.json",
		"benchmarks/schema/corpus-seal-receipt-v1.schema.json",
	];
	let domain_schema_paths = [
		"benchmarks/candidates/aiq-core-1.0.6/task.schema.json",
		options.corpus_kind.catalog_path(),
		"benchmarks/schema/corpus-commitment-v2.schema.json",
		"benchmarks/schema/leakage-review-v1.schema.json",
	];
	let schema_digests = digest_source_paths(&prepared.source_root, &schema_paths)?;
	let domain_schema_digests = digest_source_paths(&prepared.source_root, &domain_schema_paths)?;
	let aggregate_sha256 = protocol::canonical_hash(&task_commitments)?;
	let sealer_source_sha256 = prepared
		.source_manifest
		.entries
		.iter()
		.find(|entry| entry.path == "apps/aiq-runner/src/corpus_seal.rs")
		.ok_or("source inventory omits sealer source")?
		.sha256
		.clone();
	let harness = HarnessManifest {
		schema_version: options.corpus_kind.harness_schema(),
		corpus_kind: options.corpus_kind,
		task_count: prepared.tasks.len(),
		acceptance_required_classes: acceptance_policy.required,
		acceptance_optional_classes: acceptance_policy.optional,
		acceptance_classes_by_task,
		source_commit: &options.source_commit,
		source_tree: &options.source_tree,
		source_manifest_sha256: &prepared.source_manifest_sha256,
		sealer_source_sha256,
		input_contract_schema_sha256: schema_digests,
		task_catalog_corpus_evaluator_schema_sha256: domain_schema_digests,
		evaluator_sha256: &prepared.evaluator_sha256,
		node_sha256: &prepared.node_sha256,
		rg_sha256: &prepared.rg_sha256,
		catalog_generator: &prepared.generator_authority,
		algorithm_ids: [
			"rfc8785-jcs-sha256",
			"aiq.workspace-manifest.v1",
			"aiq.controlled-tree.v1",
			"sha256-raw-file-v1",
			"aiq.runner-source-manifest.v1",
		],
		ordered_task_commitment_aggregate_sha256: aggregate_sha256,
	};
	let harness_sha256 = protocol::canonical_hash(&harness)?;

	write_canonical_json(&output.join("harness.json"), &harness)?;

	Ok((input_manifest_sha256, harness_sha256))
}

#[allow(clippy::too_many_arguments)]
fn write_commitment_and_receipt(
	options: &SealOptions,
	output: &Path,
	prepared: &PreparedSeal,
	task_commitments: &[TaskCommitment],
	execution: &DerivedExecution,
	input_manifest_sha256: &str,
	harness_sha256: &str,
) -> Result<String, Box<dyn Error>> {
	let commitment = serde_json::json!({
		"schema_version":"aiq.corpus-commitment.v2","release_id":options.release_id,
		"controlled":true,"synthetic":false,
		"catalog":{"schema_version":prepared.catalog.schema_version,"task_set_id":prepared.catalog.task_set_id,"task_set_version":prepared.catalog.task_set_version,"identity_sha256":prepared.catalog_identity_sha256,"identity_scope":prepared.catalog_identity_scope},
		"execution":{"harness_sha256":harness_sha256,"runner_prompt_source_sha256":execution.runner_prompt_sha256,"declared_tool_policy_sha256":execution.tool_policy_sha256,"declared_network_policy_sha256":execution.network_policy_sha256,"environment_sha256":execution.environment_sha256,"runtime_provenance":execution.runtime_provenance},
		"tasks":task_commitments
	});
	let commitment_sha256 = protocol::canonical_hash(&commitment)?;
	let commitment_bytes = canonical_bytes(&commitment)?;
	let commitment_raw_sha256 = raw_sha256(&commitment_bytes);

	write_bytes(&output.join("commitment.json"), &commitment_bytes)?;
	validate_sealed_output(options.corpus_kind, output, &commitment_sha256, task_commitments)?;

	let mut output_trees = BTreeMap::new();

	for (name, directory) in [
		("tasks", "tasks"),
		("baselines", "baselines"),
		("acceptance", "acceptance"),
		("leakage_reviews", "leakage-reviews"),
		("evaluator", "evaluator"),
		("toolchain", "toolchain"),
		("source_snapshot", "source-snapshot"),
	] {
		output_trees
			.insert(name, protocol::canonical_hash(&controlled_tree(&output.join(directory))?)?);
	}

	let sealed_tree_sha256 = protocol::canonical_hash(&controlled_tree(output)?)?;
	let receipt = SealReceipt {
		schema_version: "aiq.corpus-seal-receipt.v1",
		corpus_kind: options.corpus_kind,
		release_id: &options.release_id,
		catalog_identity_sha256: &prepared.catalog_identity_sha256,
		task_count: prepared.tasks.len(),
		source_commit: &options.source_commit,
		source_tree: &options.source_tree,
		source_manifest_sha256: &prepared.source_manifest_sha256,
		commitment_canonical_sha256: &commitment_sha256,
		commitment_raw_file_sha256: &commitment_raw_sha256,
		authoring_input_manifest_sha256: input_manifest_sha256,
		harness_manifest_sha256: harness_sha256,
		sealed_tree_sha256,
		output_trees,
	};

	write_canonical_json(&output.join("receipt.json"), &receipt)?;

	Ok(commitment_sha256)
}

fn validate_sealed_output(
	kind: CorpusKind,
	output: &Path,
	expected: &str,
	task_commitments: &[TaskCommitment],
) -> Result<(), Box<dyn Error>> {
	let runtime = EvaluatorRuntime::resolve(&sealed_node_path(output))?;
	let report = DirectoryTaskSource::new(output.join("tasks"), Some(Visibility::Hidden)).load();

	if !report.issues.is_empty() {
		return Err("sealed task round-trip failed".into());
	}

	let corpus = match kind {
		CorpusKind::Core => corpus_commitment::validate_core_corpus_commitment(
			&output.join("commitment.json"),
			&report.tasks,
			&output.join("source-snapshot"),
		)?,
		CorpusKind::Contrast => corpus_commitment::validate_contrast_corpus_commitment(
			&output.join("commitment.json"),
			&report.tasks,
			&output.join("source-snapshot"),
			expected,
		)?,
	};
	let bindings = report
		.tasks
		.iter()
		.map(|task| {
			task.evaluator
				.as_ref()
				.and_then(|value| value.external.as_ref())
				.ok_or("sealed task omits evaluator")
		})
		.collect::<Result<Vec<_>, _>>()?;

	validate_shared_runtime_identities(
		bindings
			.iter()
			.map(|binding| (binding.runtime_kind, binding.runtime_executable_digest.as_str())),
		runtime.executable_digest(),
	)?;

	corpus.validate_evaluator_runtime(&runtime)?;
	corpus.validate_model_toolchain(&output.join("toolchain"), &runtime)?;

	for (task, binding) in report.tasks.iter().zip(bindings) {
		binding.validate_registry(&output.join("evaluator"))?;

		let observed = protocol::canonical_hash(&runner::build_workspace_manifest(
			&output.join("baselines").join(&task.task_id),
		)?)?;

		if corpus.baseline_workspace_digests().get(&task.task_id) != Some(&observed) {
			return Err("sealed baseline round-trip failed".into());
		}
	}

	validate_sealed_asset_digests(output, task_commitments)?;

	Ok(())
}

fn sealed_node_path(output: &Path) -> PathBuf {
	output.join("toolchain").join(if cfg!(windows) { "node.exe" } else { "node" })
}

fn validate_sealed_asset_digests(
	output: &Path,
	task_commitments: &[TaskCommitment],
) -> Result<(), Box<dyn Error>> {
	for task in task_commitments {
		let fixture = protocol::canonical_hash(&controlled_tree(
			&output.join("baselines").join(&task.task_id),
		)?)?;
		let acceptance = protocol::canonical_hash(&controlled_tree(
			&output.join("acceptance").join(&task.task_id),
		)?)?;
		let leakage: Value = read_canonical_input(
			&output.join("leakage-reviews").join(format!("{}.json", task.task_id)),
			MAX_FILE_BYTES,
		)?;
		let leakage = protocol::canonical_hash(&leakage)?;

		if fixture != task.fixture_bundle_sha256
			|| acceptance != task.acceptance_suite_sha256
			|| leakage != task.leakage_review_sha256
		{
			return Err("sealed fixture, acceptance, or leakage-review digest mismatch".into());
		}
	}

	Ok(())
}

fn build_source_manifest(root: &Path) -> Result<SourceManifest, Box<dyn Error>> {
	let inventory_path = root.join(SOURCE_INVENTORY);
	let inventory: SourceInventory = read_canonical_input(&inventory_path, 128 * 1_024)?;

	if inventory.schema_version != "aiq.corpus-source-inventory.v1" {
		return Err("unsupported source inventory".into());
	}

	let mut paths = BTreeSet::new();

	for explicit in inventory.explicit_paths {
		validate_relative_path(&explicit)?;

		paths.insert(explicit);
	}
	for recursive in inventory.recursive_roots {
		validate_relative_path(&recursive)?;
		collect_relative_files(root, &root.join(&recursive), &mut paths)?;
	}

	if !paths.contains(SOURCE_INVENTORY) {
		return Err("source inventory must include itself".into());
	}

	let entries = paths
		.into_iter()
		.map(|path| {
			Ok(ManifestEntry {
				sha256: raw_file_sha256_bounded(&root.join(&path), MAX_SOURCE_FILE_BYTES)?,
				path,
			})
		})
		.collect::<Result<Vec<_>, Box<dyn Error>>>()?;

	Ok(SourceManifest {
		schema_version: "aiq.runner-source-manifest.v1",
		package: "aiq-runner",
		scope: "cargo_build_and_test_inputs",
		path_base: "repository_root",
		entries,
	})
}

fn copy_source_snapshot(
	root: &Path,
	manifest: &SourceManifest,
	destination: &Path,
) -> Result<(), Box<dyn Error>> {
	fs::create_dir(destination)?;

	for entry in &manifest.entries {
		copy_file(&root.join(&entry.path), &destination.join(&entry.path))?;
	}

	Ok(())
}

fn controlled_tree(root: &Path) -> Result<ControlledTree, Box<dyn Error>> {
	let root = canonical_directory(root, "controlled tree root")?;
	let mut paths = BTreeSet::new();

	collect_relative_files(&root, &root, &mut paths)?;

	let entries = paths
		.into_iter()
		.map(|path| Ok(ManifestEntry { sha256: raw_file_sha256(&root.join(&path))?, path }))
		.collect::<Result<Vec<_>, Box<dyn Error>>>()?;

	Ok(ControlledTree { schema_version: "aiq.controlled-tree.v1", entries })
}

fn collect_relative_files(
	base: &Path,
	current: &Path,
	paths: &mut BTreeSet<String>,
) -> Result<(), Box<dyn Error>> {
	let metadata = fs::symlink_metadata(current)?;

	if metadata.file_type().is_symlink() || !metadata.is_dir() {
		return Err("controlled tree contains a non-directory traversal root".into());
	}

	for entry in fs::read_dir(current)? {
		let entry = entry?;
		let path = entry.path();
		let metadata = fs::symlink_metadata(&path)?;

		if metadata.file_type().is_symlink() {
			return Err("controlled tree contains a symlink".into());
		}
		if metadata.is_dir() {
			collect_relative_files(base, &path, paths)?;
		} else if metadata.is_file() {
			let relative = path
				.strip_prefix(base)?
				.to_str()
				.ok_or("controlled path is not UTF-8")?
				.replace('\\', "/");

			validate_relative_path(&relative)?;

			if !paths.insert(relative) || paths.len() > MAX_TREE_FILES {
				return Err("controlled tree has duplicate or too many files".into());
			}
		} else {
			return Err("controlled tree contains a special file".into());
		}
	}

	Ok(())
}

fn copy_tree(source: &Path, destination: &Path) -> Result<(), Box<dyn Error>> {
	let source = canonical_directory(source, "copy source")?;

	fs::create_dir(destination)?;

	let mut paths = BTreeSet::new();

	collect_relative_files(&source, &source, &mut paths)?;

	let mut total = 0_u64;

	for path in paths {
		let source_file = source.join(&path);
		let bytes = read_regular_bounded(&source_file, MAX_FILE_BYTES)?;

		total = total.checked_add(bytes.len() as u64).ok_or("tree size overflow")?;

		if total > MAX_TREE_BYTES {
			return Err("controlled tree exceeds byte limit".into());
		}

		let target = destination.join(path);

		write_bytes(&target, &bytes)?;
		copy_executable_mode(&source_file, &target)?;
	}

	Ok(())
}

fn copy_file(source: &Path, destination: &Path) -> Result<(), Box<dyn Error>> {
	let bytes = read_regular_bounded(source, MAX_FILE_BYTES)?;

	write_bytes(destination, &bytes)?;

	copy_executable_mode(source, destination)
}

#[cfg(unix)]
fn copy_executable_mode(source: &Path, destination: &Path) -> Result<(), Box<dyn Error>> {
	let source_mode = fs::metadata(source)?.permissions().mode();
	let mode = if source_mode & 0o111 == 0 { 0o600 } else { 0o700 };

	fs::set_permissions(destination, Permissions::from_mode(mode))?;

	Ok(())
}

#[cfg(not(unix))]
fn copy_executable_mode(_source: &Path, _destination: &Path) -> Result<(), Box<dyn Error>> {
	Ok(())
}
fn write_bytes(path: &Path, bytes: &[u8]) -> Result<(), Box<dyn Error>> {
	if let Some(parent) = path.parent() {
		fs::create_dir_all(parent)?;
	}

	let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;

	file.write_all(bytes)?;
	file.sync_all()?;

	Ok(())
}
fn write_canonical_json(path: &Path, value: &impl Serialize) -> Result<(), Box<dyn Error>> {
	write_bytes(path, &canonical_bytes(value)?)
}
fn canonical_bytes(value: &impl Serialize) -> Result<Vec<u8>, Box<dyn Error>> {
	let value = serde_json::to_value(value)?;

	Ok(serde_json_canonicalizer::to_vec(&value)?)
}

fn read_canonical_input<T>(path: &Path, maximum: u64) -> Result<T, Box<dyn Error>>
where
	T: for<'de> Deserialize<'de>,
{
	Ok(serde_json::from_slice(&read_regular_bounded(path, maximum)?)?)
}
fn read_regular_bounded(path: &Path, maximum: u64) -> Result<Vec<u8>, Box<dyn Error>> {
	let before = fs::symlink_metadata(path)?;

	if before.file_type().is_symlink() || !before.is_file() || before.len() > maximum {
		return Err("input must be a bounded non-symlink regular file".into());
	}

	let mut options = OpenOptions::new();

	options.read(true);
	#[cfg(unix)]
	{
		options.custom_flags(O_NOFOLLOW);
	}

	let mut file = options.open(path)?;
	let mut bytes = Vec::new();
	let mut limited = Read::take(&mut file, maximum + 1);

	Read::read_to_end(&mut limited, &mut bytes)?;

	let after = fs::symlink_metadata(path)?;

	if after.file_type().is_symlink()
		|| !after.is_file()
		|| after.len() != bytes.len() as u64
		|| bytes.len() as u64 > maximum
	{
		return Err("input changed or exceeded its byte limit".into());
	}

	#[cfg(unix)]
	{
		if before.dev() != after.dev()
			|| before.ino() != after.ino()
			|| before.mtime() != after.mtime()
			|| before.mtime_nsec() != after.mtime_nsec()
			|| before.nlink() != 1
			|| after.nlink() != 1
		{
			return Err("input identity changed or is hard-linked".into());
		}
	}

	Ok(bytes)
}
fn raw_file_sha256(path: &Path) -> Result<String, Box<dyn Error>> {
	raw_file_sha256_bounded(path, MAX_FILE_BYTES)
}
fn raw_file_sha256_bounded(path: &Path, maximum: u64) -> Result<String, Box<dyn Error>> {
	Ok(raw_sha256(&read_regular_bounded(path, maximum)?))
}
fn raw_sha256(bytes: &[u8]) -> String {
	format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
}

fn canonical_directory(path: &Path, label: &str) -> Result<PathBuf, Box<dyn Error>> {
	let metadata = fs::symlink_metadata(path)?;

	if metadata.file_type().is_symlink() || !metadata.is_dir() {
		return Err(format!("{label} must be a non-symlink directory").into());
	}

	Ok(fs::canonicalize(path)?)
}
fn validate_relative_path(path: &str) -> Result<(), Box<dyn Error>> {
	if path.is_empty()
		|| path.len() > 240
		|| path.starts_with('/')
		|| path.split('/').any(|part| {
			part.is_empty()
				|| matches!(part, "." | "..")
				|| !part
					.bytes()
					.all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
		}) {
		return Err("inventory contains an unsafe relative path".into());
	}

	Ok(())
}
fn validate_token(value: &str, label: &str) -> Result<(), Box<dyn Error>> {
	if value.is_empty()
		|| value.len() > 128
		|| !value
			.bytes()
			.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b'/'))
	{
		return Err(format!("{label} is invalid").into());
	}

	Ok(())
}
fn validate_git_identity(value: &str, label: &str) -> Result<(), Box<dyn Error>> {
	if value.len() != 40
		|| !value.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
	{
		return Err(format!("{label} must be an exact lowercase SHA-1 identity").into());
	}

	Ok(())
}

fn probe_version(path: &Path) -> Result<String, Box<dyn Error>> {
	let output = evaluator::probe_executable_version(path, &["--version".to_owned()])?;
	let value = output.lines().next().unwrap_or_default().to_owned();

	if value.is_empty() {
		return Err("controlled executable returned an empty version".into());
	}

	Ok(value)
}

fn validate_git_source_identity(
	root: &Path,
	expected_commit: &str,
	expected_tree: &str,
) -> Result<(), Box<dyn Error>> {
	let git = if cfg!(windows) { "git" } else { "/usr/bin/git" };
	let probe = |argument: &str| -> Result<String, Box<dyn Error>> {
		let output = Command::new(git)
			.args(["-C", root.to_str().ok_or("source root is not UTF-8")?, "rev-parse", argument])
			.env_clear()
			.output()?;

		if !output.status.success() || !output.stderr.is_empty() || output.stdout.len() > 128 {
			return Err("cannot resolve the supplied source Git identity".into());
		}

		Ok(String::from_utf8(output.stdout)?.trim().to_owned())
	};
	let commit = probe("HEAD^{commit}")?;
	let tree = probe("HEAD^{tree}")?;

	if commit != expected_commit || tree != expected_tree {
		return Err("source root does not match the supplied commit and tree identities".into());
	}

	let status = Command::new(git)
		.args([
			"-C",
			root.to_str().ok_or("source root is not UTF-8")?,
			"status",
			"--porcelain",
			"--untracked-files=all",
		])
		.env_clear()
		.output()?;

	if !status.status.success() || !status.stdout.is_empty() || !status.stderr.is_empty() {
		return Err("source root must be clean at the supplied Git identity".into());
	}

	Ok(())
}
fn host_platform() -> Result<(&'static str, &'static str, &'static str), Box<dyn Error>> {
	let platform = match OS {
		"macos" => "darwin",
		"linux" => "linux",
		"windows" => "win32",
		_ => return Err("unsupported sealing platform".into()),
	};
	let architecture = match ARCH {
		"aarch64" => "arm64",
		"x86_64" => "x64",
		_ => return Err("unsupported sealing architecture".into()),
	};
	let minimal = match platform {
		"darwin" => "darwin_v1",
		"linux" => "linux_v1",
		"win32" => "windows_v1",
		_ => unreachable!(),
	};

	Ok((platform, architecture, minimal))
}

fn validate_runtime_authority(value: &RuntimeAuthority) -> Result<(), Box<dyn Error>> {
	if value.schema_version != "aiq.corpus-runtime-authority.v1"
		|| value.node_release.name != "node"
		|| value.node_components.len() < 7
	{
		return Err("runtime authority contract is invalid".into());
	}

	for required in ["icu", "tz", "unicode", "v8", "modules", "openssl", "zlib"] {
		if !value.node_components.contains_key(required) {
			return Err("runtime authority omits a required Node.js component".into());
		}
	}

	Ok(())
}
fn validate_catalog(
	kind: CorpusKind,
	catalog: &Catalog,
	tasks: &mut [TaskDefinition],
) -> Result<(String, String), Box<dyn Error>> {
	let (schema, id) = match kind {
		CorpusKind::Core => ("aiq.catalog.v1", "aiq-core"),
		CorpusKind::Contrast => ("aiq.contrast-corpus.v1", "aiq-core-contrast"),
	};

	if catalog.schema_version != schema
		|| catalog.task_set_id != id
		|| catalog.task_set_version != "1.0.6"
		|| catalog.tasks.len() != kind.task_count()
	{
		return Err("catalog does not match corpus kind".into());
	}

	let task_ids = tasks.iter().map(|v| v.task_id.as_str()).collect::<Vec<_>>();
	let positions = catalog_task_positions(&catalog.tasks, &task_ids)?;

	tasks.sort_by_key(|task| positions.get(&task.task_id).copied().unwrap_or(usize::MAX));

	let (digest, scope) = validate_catalog_identity(kind, catalog)?;

	Ok((digest.to_owned(), scope.to_owned()))
}

fn catalog_task_positions(
	catalog_tasks: &[Value],
	observed_ids: &[&str],
) -> Result<BTreeMap<String, usize>, Box<dyn Error>> {
	let mut positions = BTreeMap::new();

	for (index, task) in catalog_tasks.iter().enumerate() {
		let id = task.get("task_id").and_then(Value::as_str).ok_or("catalog task omits task_id")?;

		if id.is_empty() || positions.insert(id.to_owned(), index).is_some() {
			return Err("catalog contains an invalid or duplicate task id".into());
		}
	}

	let observed = observed_ids.iter().map(|id| (*id).to_owned()).collect::<BTreeSet<_>>();

	if observed.len() != observed_ids.len()
		|| observed.len() != positions.len()
		|| observed.iter().any(|id| !positions.contains_key(id))
	{
		return Err("tasks do not match the exact unique catalog task-id set".into());
	}

	Ok(positions)
}

fn validate_catalog_identity(
	kind: CorpusKind,
	catalog: &Catalog,
) -> Result<(&str, &str), Box<dyn Error>> {
	let (digest, scope) = match kind {
		CorpusKind::Core => {
			if catalog.identity_sha256.is_some() || catalog.identity_scope.is_some() {
				return Err("Core catalog must use its task-metadata identity authority".into());
			}

			let identity = catalog
				.task_metadata_identity
				.as_ref()
				.ok_or("Core catalog omits its task-metadata identity authority")?;

			if identity.algorithm != "sha256"
				|| identity.canonicalization != "aiq.sorted-key-json.v1"
			{
				return Err("Core catalog task-metadata identity algorithm is invalid".into());
			}

			(&identity.digest, &identity.scope)
		},
		CorpusKind::Contrast => {
			if catalog.task_metadata_identity.is_some() {
				return Err("Contrast catalog must use its top-level identity authority".into());
			}

			(
				catalog.identity_sha256.as_ref().ok_or("Contrast catalog omits identity_sha256")?,
				catalog.identity_scope.as_ref().ok_or("Contrast catalog omits identity_scope")?,
			)
		},
	};

	if !digest.starts_with("sha256:")
		|| digest.len() != 71
		|| !digest[7..].bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
		|| scope != "ordered_full_task_metadata"
	{
		return Err("catalog identity authority is invalid".into());
	}

	Ok((digest, scope))
}
fn validate_fixture_refs(task: &TaskDefinition) -> Result<(), Box<dyn Error>> {
	let expected = BTreeSet::from([
		format!("aiq-controlled-fixture://aiq-core/1.0.6/{}", task.task_id),
		format!("aiq-controlled-acceptance://aiq-core/1.0.6/{}", task.task_id),
	]);

	if task.fixture_refs.iter().cloned().collect::<BTreeSet<_>>() != expected
		|| task.fixture_refs.len() != 2
	{
		return Err(
			"task does not bind the exact controlled fixture and acceptance references".into()
		);
	}

	Ok(())
}
fn validate_acceptance_classes(
	root: &Path,
	policy: AcceptancePolicy,
) -> Result<Vec<String>, Box<dyn Error>> {
	let root = canonical_directory(root, "acceptance task root")?;
	let mut observed = BTreeSet::new();

	for entry in fs::read_dir(root)? {
		let entry = entry?;
		let metadata = fs::symlink_metadata(entry.path())?;

		if metadata.file_type().is_symlink() || !(metadata.is_file() || metadata.is_dir()) {
			return Err("acceptance suite contains an unsafe entry".into());
		}

		let name = entry
			.file_name()
			.to_str()
			.ok_or("acceptance class is not UTF-8")?
			.trim_end_matches(".json")
			.to_owned();

		if !observed.insert(name) {
			return Err("acceptance suite contains a duplicate class".into());
		}
	}

	let required = policy.required.iter().map(|value| (*value).to_owned()).collect::<BTreeSet<_>>();
	let allowed = policy
		.required
		.iter()
		.chain(policy.optional)
		.map(|value| (*value).to_owned())
		.collect::<BTreeSet<_>>();

	if !required.is_subset(&observed) || !observed.is_subset(&allowed) {
		return Err("acceptance suite does not satisfy the corpus-kind class policy".into());
	}

	Ok(observed.into_iter().collect())
}
fn digest_source_paths(
	root: &Path,
	paths: &[&str],
) -> Result<BTreeMap<String, String>, Box<dyn Error>> {
	paths.iter().map(|path| Ok(((*path).to_owned(), raw_file_sha256(&root.join(path))?))).collect()
}

#[cfg(test)]
mod tests {
	#[cfg(unix)]
	use std::os::unix::fs::PermissionsExt as _;
	use std::slice;
	use std::{
		collections::BTreeSet,
		env, fs,
		path::{Path, PathBuf},
		process,
		sync::atomic::Ordering,
	};

	use crate::{
		corpus_seal::{
			self, AcceptancePolicy, CONTRAST_REQUIRED_CLASSES, CORE_OPTIONAL_CLASSES,
			CORE_REQUIRED_CLASSES, CorpusKind, LeakageReview, NO_OPTIONAL_CLASSES, SealOptions,
			TEMP_SEQUENCE,
		},
		protocol, runner,
		task::EvaluatorRuntimeKind,
	};

	fn temporary_root(label: &str) -> PathBuf {
		let path = env::temp_dir().join(format!(
			"aiq-seal-{label}-{}-{}",
			process::id(),
			TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
		));
		let _ = fs::remove_dir_all(&path);

		fs::create_dir(&path).expect("temporary root");

		path
	}

	fn repository_root() -> PathBuf {
		PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().expect("repository")
	}

	#[test]
	fn current_core_and_contrast_catalog_identities_validate() {
		let root = repository_root();

		for (kind, path) in [
			(CorpusKind::Core, corpus_seal::CORE_CATALOG),
			(CorpusKind::Contrast, corpus_seal::CONTRAST_CATALOG),
		] {
			let bytes = fs::read(root.join(path)).expect("catalog");
			let catalog: corpus_seal::Catalog =
				serde_json::from_slice(&bytes).expect("parse catalog");
			let (digest, scope) =
				corpus_seal::validate_catalog_identity(kind, &catalog).expect("catalog identity");

			assert!(digest.starts_with("sha256:"));
			assert_eq!(scope, "ordered_full_task_metadata");
		}
	}

	#[test]
	fn current_core_catalog_reorders_an_exact_differently_ordered_id_set() {
		let bytes = fs::read(repository_root().join(corpus_seal::CORE_CATALOG)).expect("catalog");
		let catalog: corpus_seal::Catalog = serde_json::from_slice(&bytes).expect("parse catalog");
		let expected = catalog
			.tasks
			.iter()
			.map(|task| task["task_id"].as_str().expect("task id").to_owned())
			.collect::<Vec<_>>();
		let mut observed = expected.iter().rev().cloned().collect::<Vec<_>>();
		let observed_refs = observed.iter().map(String::as_str).collect::<Vec<_>>();
		let positions =
			corpus_seal::catalog_task_positions(&catalog.tasks, &observed_refs).expect("exact set");

		observed.sort_by_key(|id| positions.get(id).copied().expect("catalog position"));

		assert_eq!(observed, expected);

		let duplicate = [expected[0].as_str(), expected[0].as_str()];

		assert!(corpus_seal::catalog_task_positions(&catalog.tasks, &duplicate).is_err());
	}

	#[test]
	fn checked_source_inventory_covers_build_test_and_generator_inputs() {
		let manifest = corpus_seal::build_source_manifest(&repository_root()).expect("manifest");
		let paths =
			manifest.entries.iter().map(|entry| entry.path.as_str()).collect::<BTreeSet<_>>();

		for required in [
			"rust-toolchain.toml",
			"apps/aiq-verifier/README.md",
			"apps/aiq-runner/tests/admit_permissions_cli.rs",
			"apps/aiq-runner/tests/fixtures/echo-evaluator.mjs",
			"apps/aiq-verifier/tests/fixtures/valid-synthetic-verifier-environment.json",
			"apps/web/src/server/verification-contract.ts",
			"benchmarks/examples/tasks/public-example-instruction-following.json",
			"benchmarks/fixtures/result-package-v3.synthetic.json",
			"benchmarks/schema/calibration-verified-stage-v1.schema.json",
			"benchmarks/schema/normalized-batch-v3.schema.json",
			"config/capabilities.example.json",
			"config/schedule.example.json",
			"config/verifier-environment.example.json",
			"databases/schema.sql",
			corpus_seal::CATALOG_GENERATOR,
			corpus_seal::SOURCE_INVENTORY,
		] {
			assert!(paths.contains(required), "source inventory omits {required}");
		}
	}

	#[test]
	fn controlled_tree_is_sorted_and_rejects_symlinks() {
		let root = temporary_root("tree");

		fs::write(root.join("b"), b"b").expect("b");
		fs::write(root.join("a"), b"a").expect("a");

		let tree = corpus_seal::controlled_tree(&root).expect("tree");

		assert_eq!(
			tree.entries.iter().map(|v| v.path.as_str()).collect::<Vec<_>>(),
			vec!["a", "b"]
		);

		#[cfg(unix)]
		{
			std::os::unix::fs::symlink(root.join("a"), root.join("link")).expect("link");

			assert!(corpus_seal::controlled_tree(&root).is_err());
		}

		fs::remove_dir_all(root).expect("cleanup");
	}

	#[test]
	fn acceptance_classes_are_kind_specific_and_core_allows_only_reviewed_optional_classes() {
		let root = temporary_root("classes");

		for class in CORE_REQUIRED_CLASSES {
			fs::write(root.join(format!("{class}.json")), b"{}").expect("class");
		}

		let core_policy =
			AcceptancePolicy { required: &CORE_REQUIRED_CLASSES, optional: &CORE_OPTIONAL_CLASSES };

		assert_eq!(
			corpus_seal::validate_acceptance_classes(&root, core_policy).expect("core classes"),
			CORE_REQUIRED_CLASSES.map(str::to_owned)
		);

		fs::write(root.join("empty.json"), b"{}").expect("optional class");

		assert!(corpus_seal::validate_acceptance_classes(&root, core_policy).is_ok());

		fs::write(root.join("unknown.json"), b"{}").expect("unknown class");

		assert!(corpus_seal::validate_acceptance_classes(&root, core_policy).is_err());

		fs::remove_file(root.join("unknown.json")).expect("remove unknown class");
		fs::remove_file(root.join("gold.json")).expect("remove required class");

		assert!(corpus_seal::validate_acceptance_classes(&root, core_policy).is_err());

		fs::remove_dir_all(root).expect("cleanup");

		let contrast_root = temporary_root("contrast-classes");

		for class in CONTRAST_REQUIRED_CLASSES {
			fs::write(contrast_root.join(format!("{class}.json")), b"{}").expect("class");
		}

		let contrast_policy = AcceptancePolicy {
			required: &CONTRAST_REQUIRED_CLASSES,
			optional: &NO_OPTIONAL_CLASSES,
		};

		assert!(corpus_seal::validate_acceptance_classes(&contrast_root, contrast_policy).is_ok());

		fs::write(contrast_root.join("partial.json"), b"{}").expect("extra class");

		assert!(corpus_seal::validate_acceptance_classes(&contrast_root, contrast_policy).is_err());

		fs::remove_dir_all(contrast_root).expect("cleanup");
	}

	#[test]
	fn canonical_preimages_are_deterministic_and_tamper_evident() {
		let first_notes = ["reviewed".to_owned()];
		let second_notes = ["changed".to_owned()];
		let first = LeakageReview {
			schema_version: "aiq.leakage-review.v1",
			task_id: "coding-01",
			task_version: "1.0.6",
			reviewed: true,
			status: "reviewed",
			leakage_notes: &first_notes,
		};
		let second = LeakageReview { leakage_notes: &second_notes, ..first };

		assert_eq!(
			corpus_seal::canonical_bytes(&first).expect("first"),
			corpus_seal::canonical_bytes(&first).expect("again")
		);
		assert_ne!(
			protocol::canonical_hash(&first).expect("first hash"),
			protocol::canonical_hash(&second).expect("second hash")
		);
	}

	#[test]
	fn controlled_tree_changes_after_file_tamper() {
		let root = temporary_root("tamper");

		fs::write(root.join("fixture.json"), b"one").expect("fixture");

		let first = protocol::canonical_hash(&corpus_seal::controlled_tree(&root).expect("first"))
			.expect("hash");

		fs::write(root.join("fixture.json"), b"two").expect("tamper");

		let second =
			protocol::canonical_hash(&corpus_seal::controlled_tree(&root).expect("second"))
				.expect("hash");

		assert_ne!(first, second);

		fs::remove_dir_all(root).expect("cleanup");
	}

	#[test]
	fn evaluator_tree_accepts_exact_marker_and_rejects_arbitrary_extras() {
		let root = temporary_root("evaluator-tree");
		let directory = root.join("aiq-core-v1");
		let evaluator = directory.join("evaluator");
		let marker = directory.join(".aiq-controlled-generated-v1");

		fs::create_dir(&directory).expect("evaluator directory");
		fs::write(&evaluator, b"evaluator").expect("evaluator");
		fs::write(&marker, b"generated\n").expect("marker");

		assert!(
			corpus_seal::validate_evaluator_tree(&root, Path::new("aiq-core-v1/evaluator")).is_ok()
		);

		fs::write(directory.join("extra"), b"unexpected").expect("extra");

		assert!(
			corpus_seal::validate_evaluator_tree(&root, Path::new("aiq-core-v1/evaluator"))
				.is_err()
		);

		fs::remove_file(directory.join("extra")).expect("remove extra");
		fs::write(&marker, b"generated?").expect("tamper marker");

		assert!(
			corpus_seal::validate_evaluator_tree(&root, Path::new("aiq-core-v1/evaluator"))
				.is_err()
		);

		fs::remove_dir_all(root).expect("cleanup");
	}

	#[test]
	fn every_task_must_match_the_one_shared_runtime_identity() {
		let digest = format!("sha256:{}", "a".repeat(64));
		let matching =
			(0..72).map(|_| (EvaluatorRuntimeKind::Node, digest.as_str())).collect::<Vec<_>>();

		assert!(corpus_seal::validate_shared_runtime_identities(matching, &digest).is_ok());

		let mismatch = format!("sha256:{}", "b".repeat(64));
		let bindings = [
			(EvaluatorRuntimeKind::Node, digest.as_str()),
			(EvaluatorRuntimeKind::Node, mismatch.as_str()),
		];

		assert!(corpus_seal::validate_shared_runtime_identities(bindings, &digest).is_err());
	}

	#[test]
	fn sealed_runtime_resolves_to_the_single_toolchain_node_path() {
		let root = Path::new("sealed");
		let expected = root.join("toolchain").join(if cfg!(windows) { "node.exe" } else { "node" });

		assert_eq!(corpus_seal::sealed_node_path(root), expected);
		assert_ne!(corpus_seal::sealed_node_path(root), root.join("runtime/node"));
	}

	#[test]
	fn sealed_asset_round_trip_rejects_copied_content_mismatch() {
		let root = temporary_root("sealed-assets");
		let baseline = root.join("baselines/task-1");
		let acceptance = root.join("acceptance/task-1");
		let leakage = root.join("leakage-reviews/task-1.json");

		fs::create_dir_all(&baseline).expect("baseline");
		fs::create_dir_all(&acceptance).expect("acceptance");
		fs::create_dir_all(leakage.parent().expect("leakage parent")).expect("leakage directory");
		fs::write(baseline.join("fixture"), b"fixture").expect("fixture");
		fs::write(acceptance.join("gold"), b"accepted").expect("acceptance");
		fs::write(&leakage, br#"{"reviewed":true}"#).expect("leakage");

		let commitment = corpus_seal::TaskCommitment {
			task_id: "task-1".to_owned(),
			task_version: "1.0.6".to_owned(),
			task_definition_sha256: "unused".to_owned(),
			baseline_workspace_tree_sha256: "unused".to_owned(),
			fixture_bundle_sha256: protocol::canonical_hash(
				&corpus_seal::controlled_tree(&baseline).expect("fixture tree"),
			)
			.expect("fixture digest"),
			catalog_entry_sha256: "unused".to_owned(),
			evaluator_runtime_kind: "node",
			evaluator_runtime_executable_sha256: "unused".to_owned(),
			evaluator_executable_sha256: "unused".to_owned(),
			evaluator_configuration_sha256: "unused".to_owned(),
			acceptance_suite_sha256: protocol::canonical_hash(
				&corpus_seal::controlled_tree(&acceptance).expect("acceptance tree"),
			)
			.expect("acceptance digest"),
			leakage_review_sha256: protocol::canonical_hash(
				&serde_json::from_slice::<serde_json::Value>(
					&fs::read(&leakage).expect("read leakage"),
				)
				.expect("parse leakage"),
			)
			.expect("leakage digest"),
		};

		assert!(
			corpus_seal::validate_sealed_asset_digests(&root, slice::from_ref(&commitment)).is_ok()
		);

		fs::write(acceptance.join("gold"), b"mutated").expect("mutate copied acceptance");

		assert!(
			corpus_seal::validate_sealed_asset_digests(&root, slice::from_ref(&commitment))
				.is_err()
		);

		fs::remove_dir_all(root).expect("cleanup");
	}

	#[test]
	fn independently_built_controlled_trees_are_byte_identical() {
		let first = temporary_root("tree-first");
		let second = temporary_root("tree-second");

		fs::create_dir(first.join("nested")).expect("first nested");
		fs::write(first.join("z"), b"same-z").expect("first z");
		fs::write(first.join("nested/a"), b"same-a").expect("first a");
		fs::write(second.join("z"), b"same-z").expect("second z");
		fs::create_dir(second.join("nested")).expect("second nested");
		fs::write(second.join("nested/a"), b"same-a").expect("second a");

		let first_bytes = corpus_seal::canonical_bytes(
			&corpus_seal::controlled_tree(&first).expect("first tree"),
		)
		.expect("first bytes");
		let second_bytes = corpus_seal::canonical_bytes(
			&corpus_seal::controlled_tree(&second).expect("second tree"),
		)
		.expect("second bytes");

		assert_eq!(first_bytes, second_bytes);

		fs::remove_dir_all(first).expect("first cleanup");
		fs::remove_dir_all(second).expect("second cleanup");
	}

	#[test]
	fn source_inventory_covers_recursive_files_and_fails_closed() {
		let root = temporary_root("inventory");
		let inventory = root.join("benchmarks/corpus-source-inventory-v1.json");

		fs::create_dir_all(inventory.parent().expect("inventory parent")).expect("benchmarks");
		fs::create_dir(root.join("governed")).expect("governed");
		fs::write(root.join("explicit.txt"), b"explicit").expect("explicit");
		fs::write(root.join("governed/new.rs"), b"new source").expect("recursive source");
		fs::write(
			&inventory,
			br#"{"schema_version":"aiq.corpus-source-inventory.v1","recursive_roots":["governed"],"explicit_paths":["benchmarks/corpus-source-inventory-v1.json","explicit.txt"]}"#,
		)
		.expect("inventory");

		let manifest = corpus_seal::build_source_manifest(&root).expect("manifest");

		assert!(manifest.entries.iter().any(|entry| entry.path == "governed/new.rs"));

		fs::remove_file(root.join("explicit.txt")).expect("remove explicit");

		assert!(corpus_seal::build_source_manifest(&root).is_err());

		#[cfg(unix)]
		{
			fs::write(root.join("explicit.txt"), b"explicit").expect("restore explicit");
			std::os::unix::fs::symlink("new.rs", root.join("governed/link.rs")).expect("link");

			assert!(corpus_seal::build_source_manifest(&root).is_err());
		}

		fs::remove_dir_all(root).expect("cleanup");
	}

	#[cfg(unix)]
	#[test]
	fn bounded_input_rejects_hard_linked_files() {
		let root = temporary_root("hard-link");
		let first = root.join("first");

		fs::write(&first, b"controlled").expect("first");
		fs::hard_link(&first, root.join("second")).expect("hard link");

		assert!(corpus_seal::read_regular_bounded(&first, 1_024).is_err());

		fs::remove_dir_all(root).expect("cleanup");
	}

	#[cfg(unix)]
	#[test]
	fn multiline_version_probe_uses_the_canonical_first_line() {
		let root = temporary_root("version-probe");
		let executable = root.join("rg");
		let detail = "feature".repeat(24);

		fs::write(
			&executable,
			format!("#!/bin/sh\nprintf 'ripgrep 15.1.0 (rev af60c2de9d)\\n{detail}\\n'\n"),
		)
		.expect("executable");
		fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).expect("permissions");

		assert_eq!(
			corpus_seal::probe_version(&executable).expect("version"),
			"ripgrep 15.1.0 (rev af60c2de9d)"
		);

		fs::remove_dir_all(root).expect("cleanup");
	}

	#[test]
	fn workspace_manifest_digest_uses_the_production_algorithm() {
		let root = temporary_root("workspace");

		fs::write(root.join("index.js"), b"export default 1;\n").expect("source");

		let first =
			protocol::canonical_hash(&runner::build_workspace_manifest(&root).expect("manifest"))
				.expect("digest");
		let second =
			protocol::canonical_hash(&runner::build_workspace_manifest(&root).expect("manifest"))
				.expect("digest");

		assert_eq!(first, second);

		fs::remove_dir_all(root).expect("cleanup");
	}

	#[test]
	fn existing_target_and_failed_build_leave_no_partial_output() {
		let root = temporary_root("atomic");
		let output = root.join("sealed");

		fs::create_dir(&output).expect("existing target");

		let options = SealOptions {
			corpus_kind: CorpusKind::Core,
			release_id: "core-test".to_owned(),
			tasks_root: root.join("missing"),
			baselines_root: root.join("missing"),
			acceptance_root: root.join("missing"),
			evaluator_root: root.join("missing"),
			evaluator_runtime: root.join("missing"),
			codex_toolchain_root: root.join("missing"),
			source_root: root.join("missing"),
			source_commit: "a".repeat(40),
			source_tree: "b".repeat(40),
			runtime_authority: root.join("missing"),
			output: output.clone(),
		};

		assert!(corpus_seal::seal_corpus(&options).is_err());
		assert!(output.is_dir());

		fs::remove_dir(&output).expect("remove target");

		assert!(corpus_seal::seal_corpus(&options).is_err());
		assert!(!output.exists());
		assert_eq!(fs::read_dir(&root).expect("root entries").count(), 0);

		fs::remove_dir_all(root).expect("cleanup");
	}
}
