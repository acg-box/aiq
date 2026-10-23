//! CLI argument definitions and parsing; workflow execution stays in the parent module.

use std::path::{Path, PathBuf};

use clap::{Subcommand, ValueEnum};

use crate::{
	cli,
	corpus_commitment::RunClass,
	corpus_seal::CorpusKind,
	normalization::ReplayStatus,
	submission::{DEFAULT_ARTIFACT_UPLOAD_CONCURRENCY, MAX_ARTIFACT_UPLOAD_CONCURRENCY},
};

#[allow(clippy::large_enum_variant)]
#[derive(Debug, Subcommand)]
pub(super) enum Command {
	/// Print the exact static model matrix.
	Matrix {
		/// Machine-readable JSON output file, or `-` for standard output.
		#[arg(long, default_value = "-")]
		output: PathBuf,
	},
	/// Observe Normal and Fast subscription transport without changing any AIQ score.
	ObserveSpeed {
		/// Current corpus commitment used only to validate the controlled command toolchain.
		#[arg(long)]
		corpus_commitment: PathBuf,
		/// Exact Node.js executable committed by the corpus.
		#[arg(long)]
		evaluator_runtime: PathBuf,
		/// Exact controlled Node.js and ripgrep directory.
		#[arg(long)]
		codex_toolchain_root: PathBuf,
		/// Absolute controlled Codex executable with its required sibling host.
		#[arg(long, value_parser = parse_controlled_codex_binary)]
		codex_binary: String,
		/// Isolated existing ChatGPT subscription Codex home.
		#[arg(long, value_parser = parse_controlled_codex_home)]
		codex_home: PathBuf,
		/// Private content-addressed raw artifact root.
		#[arg(long)]
		artifact_root: PathBuf,
		/// Private resumable workspace root for this scheduled observation.
		#[arg(long)]
		workspace_root: PathBuf,
		/// Private create-once per-trial checkpoint root.
		#[arg(long)]
		checkpoint_root: PathBuf,
		/// Canonical observation identity.
		#[arg(long, value_parser = parse_run_observed_at)]
		observed_at: String,
		/// Exact model key to observe. Repeat to select a subset; omit for all 17.
		#[arg(long = "model")]
		models: Vec<String>,
		/// Trials per transport and model configuration.
		#[arg(long, default_value_t = 5)]
		trials: u8,
		/// Maximum model configurations observed concurrently.
		#[arg(long, default_value_t = 4)]
		jobs: usize,
		/// New machine-readable observation batch.
		#[arg(long)]
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
	/// Seal complete retained controlled assets into a new corpus without invoking Codex.
	SealCorpus {
		/// Exact catalog authority to enforce.
		#[arg(long, value_enum)]
		corpus_kind: CorpusKind,
		/// New release identity. The sealer never copies a predecessor identity.
		#[arg(long)]
		release_id: String,
		#[arg(long)]
		/// Directory containing exactly one canonical hidden task JSON per task.
		tasks_root: PathBuf,
		#[arg(long)]
		/// Directory containing one runtime baseline directory per task identifier.
		baselines_root: PathBuf,
		#[arg(long)]
		/// Directory containing one policy-valid acceptance directory per task identifier.
		acceptance_root: PathBuf,
		#[arg(long)]
		/// Directory containing exactly one supplied leakage-review record per task.
		leakage_reviews_root: PathBuf,
		#[arg(long)]
		/// Controlled root containing the one evaluator referenced by every task.
		evaluator_root: PathBuf,
		#[arg(long)]
		/// Exact Node.js executable used by the evaluator and controlled toolchain.
		evaluator_runtime: PathBuf,
		#[arg(long)]
		/// Controlled directory containing exactly the committed Node.js and ripgrep tools.
		codex_toolchain_root: PathBuf,
		#[arg(long)]
		/// Clean repository root covered by the checked-in source inventory.
		source_root: PathBuf,
		/// Exact lowercase Git commit identity for the source snapshot.
		#[arg(long)]
		source_commit: String,
		/// Exact lowercase Git tree identity for the source snapshot.
		#[arg(long)]
		source_tree: String,
		/// Typed `aiq.corpus-runtime-authority.v1` input.
		#[arg(long)]
		runtime_authority: PathBuf,
		/// New private directory installed atomically after complete round-trip validation.
		#[arg(long)]
		output: PathBuf,
	},
	/// Qualify one exact candidate from one predeclared complete calibration matrix.
	///
	/// This command is model-free and never publishes or relabels the child matrix.
	QualifyCandidate {
		/// Exact predeclared candidate, policy, and child manifest.
		#[arg(long)]
		manifest: PathBuf,
		/// Independently retained canonical SHA-256 of the predeclared manifest.
		#[arg(long)]
		expected_manifest_sha256: String,
		/// Exact qualification-ready AIQ Core 1.1.0 public catalog.
		#[arg(long)]
		catalog: PathBuf,
		/// The one replay-verified candidate calibration stage.
		#[arg(long = "stage", required = true)]
		stages: Vec<PathBuf>,
		/// The signed verifier attestation paired with the stage.
		#[arg(long = "attestation", required = true)]
		attestations: Vec<PathBuf>,
		/// Create-new deterministic qualification artifact.
		#[arg(long)]
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
		/// Verifier-signed calibration admission v3 containing the frozen item bank.
		#[arg(long)]
		calibration_admission: PathBuf,
		/// Current public-safe controlled-corpus commitment.
		#[arg(long)]
		corpus_commitment: PathBuf,
		/// Retained corpus source snapshot used to verify every committed runner source byte.
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
		/// Corpus source root used to verify the committed runner source manifest.
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
		/// Retained corpus source snapshot used to verify every committed runner source byte.
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
		/// Select the isolated complete AIQ Core 1.1.0 candidate qualification route.
		/// This cannot be combined with Official execution or partial selections.
		#[arg(long, default_value_t = false, conflicts_with = "official_admission")]
		candidate_qualification: bool,
		/// Run output path. Official requires a durable path and writes one create-once
		/// reservation.
		#[arg(long, default_value = "-")]
		output: PathBuf,
	},
	/// Score a saved run with the transparent AIQ 2.0 Rasch rules.
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
		#[arg(long, default_value_t = 0x41_49_51_5f_56_32_u64)]
		bootstrap_seed: u64,
		/// Output JSON file, or `-` for standard output.
		#[arg(long, default_value = "-")]
		output: PathBuf,
		/// Exact Official admission receipt required for a real Official run.
		#[arg(long)]
		official_admission: Option<PathBuf>,
	},
	/// Rescore a historical run offline after repairing only legacy runtime-zero cells.
	///
	/// This command never produces an `aiq.score-bundle.v2`, never accepts an Official
	/// admission receipt, and writes a permanently non-publication diagnostic report.
	HistoricalDiagnosticRescore {
		/// Directory of public-example task JSON files.
		#[arg(long)]
		public_tasks: Option<PathBuf>,
		/// Controlled directory of hidden task JSON files.
		#[arg(long)]
		hidden_tasks: Option<PathBuf>,
		/// Historical saved run JSON. It is read but never modified.
		#[arg(long)]
		results: PathBuf,
		/// Deterministic cluster-bootstrap replicates.
		#[arg(long, default_value_t = 10_000)]
		bootstrap_samples: usize,
		/// Deterministic bootstrap seed.
		#[arg(long, default_value_t = 0x41_49_51_5f_56_32_u64)]
		bootstrap_seed: u64,
		/// New durable JSON output for the non-publication diagnostic.
		#[arg(long)]
		output: PathBuf,
	},
	/// Generate a browser-only 1.1.0 public projection from deterministic test observations.
	///
	/// The output is explicitly test-generated and cannot be submitted, normalized, or
	/// published as Official evidence.
	GenerateTestPublicFixture {
		/// Output JSON file, or `-` for standard output.
		#[arg(long, default_value = "benchmarks/fixtures/aiq-2.0-test-generated-public.json")]
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
	/// Submit one validated auxiliary Normal/Fast observation to the controlled gateway.
	SubmitSpeed {
		/// Persisted `aiq.speed-observation-batch.v1` JSON.
		#[arg(long)]
		observation: PathBuf,
		/// Vercel deployment origin. The runner posts to `/api/observations/speed`.
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
		/// Declared maximum concurrent task executions. Required when a real saved run predates this binding.
		#[arg(long)]
		execution_concurrency: Option<usize>,
		/// Directory of public-example candidate task JSON files.
		#[arg(long)]
		public_tasks: Option<PathBuf>,
		/// Controlled directory of hidden candidate task JSON files.
		#[arg(long)]
		hidden_tasks: Option<PathBuf>,
		/// Exact candidate corpus commitment. Requires candidate tasks and `--source-root`.
		#[arg(long)]
		corpus_commitment: Option<PathBuf>,
		/// Exact source root committed by the candidate corpus.
		#[arg(long)]
		source_root: Option<PathBuf>,
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
		/// Output path for the exact `aiq.normalized-batch.v4` database stage.
		#[arg(long)]
		stage_output: PathBuf,
		/// Output path for the signed `aiq.verifier-attestation.v4`.
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
pub(super) enum ReplayMode {
	/// The verifier replayed scoring and commitments only; production is not publishable.
	CommitmentsVerified,
	/// Verification failed. This result is rejection evidence and is not publishable.
	Failed,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
pub(super) enum RunClassArgument {
	/// Local best-effort calibration. This can never become Official.
	Calibration,
	/// Complete non-synthetic 72-task by 17-model run.
	Official,
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

fn parse_controlled_codex_binary(value: &str) -> Result<String, String> {
	cli::controlled_codex_binary(value).map_err(|error| error.to_string())
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

fn parse_controlled_codex_home(value: &str) -> Result<PathBuf, String> {
	cli::controlled_codex_home(Path::new(value)).map_err(|error| error.to_string())
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
