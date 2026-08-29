//! Bounded queue consumption, package verification, normalization, and acknowledgement.

mod replay;

use std::collections::BTreeMap;
use std::ops::Range;
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::str;
#[cfg(test)]
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread::{self, Builder};
use std::{
	collections::BTreeSet,
	env, error,
	ffi::OsString,
	fmt::{Debug, Display, Formatter},
	fs::{self, OpenOptions},
	io::{Read, Write},
	path::{Path, PathBuf},
	process::{self, Command},
	sync::{Condvar, Mutex},
	time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use clap::{ArgGroup, Parser};
use libc::O_NOFOLLOW;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use sha2::{Digest, Sha256};
use ureq::{
	self, Body,
	http::{Response, Uri, uri::PathAndQuery},
};

use crate::replay::PRODUCTION_REPLAY_SCOPE;
use aiq_runner::{
	benchmark_qualification::{
		self, BenchmarkQualificationArtifact, BenchmarkQualificationManifest,
	},
	calibration_verification::{
		self, CALIBRATION_ADMISSION_BUNDLE_SCHEMA_VERSION, CalibrationAdmissionBindings,
		CalibrationAdmissionBundleV3, CalibrationVerifiedStageV1, CalibrationVerifierAttestationV1,
	},
	candidate_catalog::{self, CANDIDATE_TASK_SET_VERSION},
	corpus_commitment::{
		self, RunClass, RunProvenanceCommitment, ValidatedCorpusCommitment, ValidatedModelToolchain,
	},
	model::{MODEL_MATRIX, ModelConfig},
	normalization::{
		self, AttestedDeploymentMetadata, MAX_VERIFICATION_REQUEST_BYTES, NormalizedBatchStage,
		ReplayStatus, VerifiedPackageIdentity, VerifierAttestationV2, VerifierSigningIdentity,
	},
	protocol::{
		self, CALIBRATION_RUN_PAYLOAD_TYPE, NodeIdentity, RUN_PAYLOAD_TYPE, SubmissionEnvelope,
		TrustTier, VerifiedSubmission,
	},
	run_validation,
	runner::{
		self, CalibrationRunRecord, FailureKind, ProviderTokenUsage, ResultStatus, RunRecord,
		TaskResult,
	},
	scoring::{
		self, AIQ_CORE_TASK_IDENTITY_SHA256, AIQ_SCORING_VERSION, AIQ_TASK_SCORER_VERSION,
		AIQ_TASK_SET_ID, FalseOnly, OfficialCalibrationDiagnostic, OfficialCalibrationPolicy,
		OfficialCalibrationSummary, ScoreContext, ScoreOptions, ScoreReport,
	},
	submission::{self, MAX_ARTIFACT_BYTES, MAX_SUBMISSION_BYTES},
	task::{
		self, DirectoryTaskSource, EvaluationResult, EvaluatorOutcome, EvaluatorRuntime,
		TaskDefinition, TaskSource, Visibility,
	},
};

const MAX_GATEWAY_RESPONSE_BYTES: usize = 64 * 1_024;
const MAX_OBJECT_RESPONSE_BYTES: usize = MAX_SUBMISSION_BYTES + 1;
const MAX_ARTIFACT_RESPONSE_BYTES: usize = MAX_ARTIFACT_BYTES + 1;
const RENEWED_LEASE_SECONDS: u64 = 900;
const LEASE_RENEWAL_INTERVAL: Duration = Duration::from_secs(300);
const DEFAULT_GATEWAY_TIMEOUT_SECONDS: u64 = 120;
const DEFAULT_REPLAY_JOBS: usize = 4;
const MAX_REPLAY_JOBS: usize = 32;
const VERIFIER_REJECTION_SCHEMA: &str = "aiq.verifier-rejection.v2";
const RECORD_SCHEMA: &str = "aiq.verifier-record.v2";
const MAX_OPERATOR_ERROR_DETAIL_BYTES: usize = 256;
const REDACTED_ERROR_CODE: &str = "details_redacted";
const REDACTED_ERROR_DETAIL: &str = "Additional error detail was redacted.";
const UNCONFIRMED_EVALUATOR_REPLAY_MISMATCH: &str =
	"evaluator replay output differed on its first claim attempt";
const ADDITIONAL_MODES_HELP: &str = "Additional modes:
  aiq-verifier validate-environment --environment <ENVIRONMENT>
      Validate production environment metadata without secrets or service access.
  aiq-verifier verify-local --help
      Replay one production package offline and write create-new stage and attestation files.
      This mode does not publish or assign cloud trust.
  aiq-verifier renew-calibration-admission --help
      Rebind one valid signed calibration bundle to a fully validated target release.
      This mode does not require replay artifacts or execute a model or task evaluator.
  aiq-verifier diagnose-rescore --help
      Verify one source package, then replay it with a candidate evaluator set.
      This mode writes one permanently non-Official create-new diagnostic report.
  aiq-verifier verify-qualification --help
      Recompute one three-matrix candidate qualification without models or publication.

Run `aiq-verifier <mode> --help` for the exact mode arguments.";

/// Narrow client contract for authenticated content-addressed artifact resolution.
pub trait ArtifactResolverClient: Sync {
	/// Renews the claim when replay work approaches the lease maintenance interval.
	fn maintain_lease(&self) -> Result<(), WorkerError> {
		Ok(())
	}

	/// Resolves one claim-bound artifact and fetches its short-lived private object.
	fn resolve(
		&self,
		digest: &str,
		kind: &str,
		expected_bytes: u64,
	) -> Result<Vec<u8>, WorkerError>;
}

trait Transport: Sync {
	fn post_json(
		&self,
		url: &str,
		token: &Secret,
		body: &[u8],
	) -> Result<HttpResponse, WorkerError>;
	fn get_object(&self, url: &str) -> Result<HttpResponse, WorkerError>;
	fn get_artifact_object(&self, url: &str) -> Result<HttpResponse, WorkerError>;
}

trait LeaseMaintenance: Sync {
	fn maintain(&self) -> Result<(), WorkerError>;
}

/// Command-line settings for one bounded verifier invocation.
#[derive(Debug, Parser)]
#[command(name = "aiq-verifier", version, about, after_help = ADDITIONAL_MODES_HELP)]
pub struct Cli {
	/// Vercel deployment origin. The worker uses `/api/claims` and `/api/verifications`.
	#[arg(long)]
	endpoint: String,
	/// Controlled directory containing the exact private task definitions.
	#[arg(
		long,
		required_unless_present = "synthetic_demo_tasks",
		conflicts_with = "synthetic_demo_tasks"
	)]
	tasks: Option<PathBuf>,
	/// Use the built-in synthetic 72-task set for an isolated local demo.
	#[arg(long, default_value_t = false, conflicts_with = "tasks")]
	synthetic_demo_tasks: bool,
	/// Verifier-owned environment metadata.
	#[arg(long)]
	environment: PathBuf,
	/// Production-only controlled registry root for committed external evaluators.
	#[arg(
		long,
		required_unless_present = "synthetic_demo_tasks",
		conflicts_with = "synthetic_demo_tasks"
	)]
	evaluator_root: Option<PathBuf>,
	/// Production-only committed corpus commitment used to bind the evaluator runtime.
	#[arg(
		long,
		required_unless_present = "synthetic_demo_tasks",
		conflicts_with = "synthetic_demo_tasks"
	)]
	corpus_commitment: Option<PathBuf>,
	/// Production-only absolute controlled Node.js and ripgrep toolchain root.
	#[arg(
		long,
		required_unless_present = "synthetic_demo_tasks",
		conflicts_with = "synthetic_demo_tasks"
	)]
	codex_toolchain_root: Option<PathBuf>,
	/// Production-only absolute Node.js runtime path for committed external evaluator scripts.
	#[arg(
		long,
		required_unless_present = "synthetic_demo_tasks",
		conflicts_with = "synthetic_demo_tasks"
	)]
	evaluator_runtime: Option<PathBuf>,
	/// Private verifier-signed calibration admission required for Official claims.
	#[arg(
		long,
		required_unless_present = "synthetic_demo_tasks",
		conflicts_with = "synthetic_demo_tasks"
	)]
	calibration_admission: Option<PathBuf>,
	/// Retained corpus source snapshot bound by the corpus source manifest.
	#[arg(
		long,
		required_unless_present = "synthetic_demo_tasks",
		conflicts_with = "synthetic_demo_tasks"
	)]
	corpus_source_root: Option<PathBuf>,
	/// Clean detached current release source bound by the environment and final-build receipt.
	#[arg(
		long,
		required_unless_present = "synthetic_demo_tasks",
		conflicts_with = "synthetic_demo_tasks"
	)]
	target_source_root: Option<PathBuf>,
	/// Exact frozen runner binary approved for Official execution.
	#[arg(
		long,
		required_unless_present = "synthetic_demo_tasks",
		conflicts_with = "synthetic_demo_tasks"
	)]
	runner_binary: Option<PathBuf>,
	/// Main executable in the exact frozen two-file Codex runtime.
	#[arg(
		long,
		required_unless_present = "synthetic_demo_tasks",
		conflicts_with = "synthetic_demo_tasks"
	)]
	codex_binary: Option<PathBuf>,
	/// Protected production reference approving the runner and verifier identities.
	#[arg(
		long,
		required_unless_present = "synthetic_demo_tasks",
		conflicts_with = "synthetic_demo_tasks"
	)]
	production_reference: Option<PathBuf>,
	/// Independently supplied SHA-256 of the protected production reference.
	#[arg(
		long,
		required_unless_present = "synthetic_demo_tasks",
		conflicts_with = "synthetic_demo_tasks"
	)]
	expected_production_reference_sha256: Option<String>,
	/// Private final-build receipt for the current source and binaries.
	#[arg(
		long,
		required_unless_present = "synthetic_demo_tasks",
		conflicts_with = "synthetic_demo_tasks"
	)]
	build_receipt: Option<PathBuf>,
	/// Independently supplied SHA-256 of the private final-build receipt.
	#[arg(
		long,
		required_unless_present = "synthetic_demo_tasks",
		conflicts_with = "synthetic_demo_tasks"
	)]
	expected_build_receipt_sha256: Option<String>,
	/// Controlled parent for fresh reconstructed candidate workspaces.
	#[arg(long)]
	replay_root: PathBuf,
	/// Environment variable containing the shared verifier ingress token.
	#[arg(long, default_value = "AIQ_VERIFIER_INGRESS_TOKEN")]
	token_env: String,
	/// Environment variable containing the verifier's 32-byte Ed25519 secret.
	#[arg(long, default_value = "AIQ_VERIFIER_SIGNING_KEY")]
	signing_key_env: String,
	/// Claim lease duration.
	#[arg(long, default_value_t = 300, value_parser = clap::value_parser!(u64).range(30..=900))]
	lease_seconds: u64,
	/// Maximum packages to claim before exit.
	#[arg(long, default_value_t = 1, value_parser = clap::value_parser!(u64).range(1..))]
	max_claims: u64,
	/// Maximum consecutive empty polls before exit.
	#[arg(long, default_value_t = 1, value_parser = clap::value_parser!(u64).range(1..))]
	max_idle_polls: u64,
	/// Maximum attempts for one transient HTTP operation.
	#[arg(long, default_value_t = 3, value_parser = clap::value_parser!(u32).range(1..=10))]
	max_retries: u32,
	/// Initial exponential-backoff delay.
	#[arg(long, default_value_t = 250, value_parser = clap::value_parser!(u64).range(1..=60_000))]
	backoff_ms: u64,
	/// Global timeout for each HTTP request.
	#[arg(
		long,
		default_value_t = DEFAULT_GATEWAY_TIMEOUT_SECONDS,
		value_parser = clap::value_parser!(u64).range(1..=300)
	)]
	timeout_seconds: u64,
	/// Maximum candidate replays that may run at the same time.
	#[arg(
		long,
		default_value_t = DEFAULT_REPLAY_JOBS,
		value_parser = parse_replay_jobs
	)]
	replay_jobs: usize,
	/// Permit plain HTTP only when the endpoint is a loopback address.
	#[arg(long, default_value_t = false)]
	allow_loopback_http: bool,
}

/// Verifier-owned metadata that is not present in a signed run package.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VerifierEnvironment {
	/// Configuration schema.
	pub schema_version: String,
	/// Stable task-set identifier.
	pub task_set_id: String,
	/// Semantic task-set version.
	pub task_set_version: String,
	/// Exact benchmark identity.
	pub benchmark_version: String,
	/// Digest of the exact prompt set.
	pub prompt_set_digest: String,
	/// Exact signed corpus and method identities accepted by this worker.
	pub expected_provenance: Option<RunProvenanceCommitment>,
	/// Runner source commit accepted by this environment.
	pub runner_commit: String,
	/// Deployment region.
	pub region: String,
	/// Whether this worker is isolated for synthetic tests.
	pub synthetic_test: bool,
	/// Optional artifact resolver origin. The gateway origin is the default.
	pub artifact_resolver_endpoint: Option<String>,
}

/// A secret that always redacts its debug representation.
pub struct Secret(String);
impl Secret {
	fn from_environment(name: &str) -> Result<Self, WorkerError> {
		let value = env::var(name)
			.map_err(|_| WorkerError::configuration(format!("{name} is not configured")))?;

		if value.is_empty() || value.len() > 4_000 {
			return Err(WorkerError::configuration(format!("{name} has an invalid length")));
		}
		if placeholder_text(&value) {
			return Err(WorkerError::configuration(format!(
				"{name} must not use a placeholder secret"
			)));
		}

		Ok(Self(value))
	}

	fn expose(&self) -> &str {
		&self.0
	}
}

impl Debug for Secret {
	fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
		formatter.write_str("Secret([REDACTED])")
	}
}

/// Stable worker failure.
#[derive(Clone, Debug, PartialEq)]
pub struct WorkerError {
	kind: ErrorKind,
	message: String,
	official_calibration: Option<Box<OfficialCalibrationDiagnostic>>,
}
impl WorkerError {
	pub(crate) fn configuration(message: impl Into<String>) -> Self {
		Self { kind: ErrorKind::Configuration, message: message.into(), official_calibration: None }
	}

	pub(crate) fn transient(message: impl Into<String>) -> Self {
		Self { kind: ErrorKind::Transient, message: message.into(), official_calibration: None }
	}

	pub(crate) fn terminal(code: ReasonCode, message: impl Into<String>) -> Self {
		Self {
			kind: ErrorKind::Terminal(code),
			message: message.into(),
			official_calibration: None,
		}
	}

	fn is_transient(&self) -> bool {
		self.kind == ErrorKind::Transient
	}

	fn operator_diagnostic(&self) -> OperatorDiagnostic {
		match self.kind {
			ErrorKind::Configuration => {
				operator_diagnostic_for_message(OperatorErrorClass::Configuration, &self.message)
			},
			ErrorKind::Transient => {
				operator_diagnostic_for_message(OperatorErrorClass::Transient, &self.message)
			},
			ErrorKind::Terminal(reason) => OperatorDiagnostic::bounded(
				OperatorErrorClass::Terminal,
				reason.as_str(),
				reason.operator_detail(),
			),
		}
	}
}

impl Display for WorkerError {
	fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
		formatter.write_str(&self.message)
	}
}

impl error::Error for WorkerError {}

/// Machine-readable record written after every claimed package.
#[derive(Clone, Debug, Serialize)]
pub struct VerificationRecord {
	schema_version: &'static str,
	inbox_id: String,
	idempotency_key: String,
	package_sha256: String,
	disposition: &'static str,
	reason_code: Option<ReasonCode>,
	worker_name: &'static str,
	worker_version: &'static str,
	worker_binary_sha256: String,
	environment_sha256: String,
	official_calibration_policy: OfficialCalibrationPolicy,
	#[serde(skip_serializing_if = "Option::is_none")]
	official_calibration_observed: Option<OfficialCalibrationSummary>,
	replay_scope: &'static str,
	attempt: u64,
	#[serde(skip_serializing_if = "Option::is_none")]
	error_class: Option<OperatorErrorClass>,
	#[serde(skip_serializing_if = "Option::is_none")]
	error_code: Option<&'static str>,
	#[serde(skip_serializing_if = "Option::is_none")]
	error_detail: Option<String>,
}
impl VerificationRecord {
	fn requires_operator_attention(&self) -> bool {
		matches!(self.disposition, "lease_lost" | "retry" | "worker_error")
	}
}

/// Offline production replay settings for one exact signed package.
#[derive(Debug, Parser)]
#[command(
	name = "aiq-verifier verify-local",
	version,
	about = "Replay one exact production package offline without publishing or assigning cloud trust",
	group(ArgGroup::new("admission_mode").args(["admission_output", "calibration_admission"]).multiple(false))
)]
struct VerifyLocalCli {
	/// Exact signed result-package bytes.
	#[arg(long)]
	package: PathBuf,
	/// Local content-addressed artifact root using `<sha256>/<kind>` paths.
	#[arg(long)]
	artifact_root: PathBuf,
	/// Controlled directory containing the exact 72 private task definitions.
	#[arg(long)]
	tasks: PathBuf,
	/// Verifier-owned production environment metadata.
	#[arg(long)]
	environment: PathBuf,
	/// Controlled registry root for committed external evaluators.
	#[arg(long)]
	evaluator_root: PathBuf,
	/// Current corpus commitment that binds the evaluator runtime and toolchain.
	#[arg(long)]
	corpus_commitment: PathBuf,
	/// Absolute controlled Node.js runtime for committed external evaluators.
	#[arg(long)]
	evaluator_runtime: PathBuf,
	/// Absolute controlled Node.js and ripgrep toolchain root.
	#[arg(long)]
	codex_toolchain_root: PathBuf,
	/// Private parent for fresh reconstructed candidate workspaces.
	#[arg(long)]
	replay_root: PathBuf,
	/// Maximum candidate replays that may run at the same time.
	#[arg(
		long,
		default_value_t = DEFAULT_REPLAY_JOBS,
		value_parser = parse_replay_jobs
	)]
	replay_jobs: usize,
	/// Environment variable containing the verifier's 32-byte Ed25519 secret.
	#[arg(long, default_value = "AIQ_VERIFIER_SIGNING_KEY")]
	signing_key_env: String,
	/// Safe Unix-millisecond time when offline verification completed.
	#[arg(long)]
	observed_unix_ms: u64,
	/// New output path for the exact `aiq.normalized-batch.v4` stage.
	#[arg(long)]
	stage_output: PathBuf,
	/// New output path for the signed `aiq.verifier-attestation.v4`.
	#[arg(long)]
	attestation_output: PathBuf,
	/// Select the isolated complete AIQ Core 1.1.0 candidate qualification replay.
	/// This route cannot issue or consume an Official calibration admission.
	#[arg(
		long,
		default_value_t = false,
		requires = "candidate_source_root",
		conflicts_with_all = [
			"calibration_admission",
			"calibration_source_1_0_7",
			"admission_output"
		]
	)]
	candidate_qualification: bool,
	/// Clean candidate source root bound by the candidate corpus commitment.
	#[arg(long, requires = "candidate_qualification")]
	candidate_source_root: Option<PathBuf>,
	/// Private verifier-signed calibration admission required for Official replay.
	#[arg(
		long,
		conflicts_with = "admission_output",
		requires_all = [
			"admission_tasks",
			"admission_environment",
			"admission_evaluator_root",
			"admission_corpus_commitment",
			"admission_evaluator_runtime",
			"admission_codex_toolchain_root",
			"admission_corpus_source_root",
			"admission_target_source_root",
			"admission_runner_binary",
			"admission_codex_binary",
			"production_reference",
			"expected_production_reference_sha256",
			"build_receipt",
			"expected_build_receipt_sha256"
		]
	)]
	calibration_admission: Option<PathBuf>,
	/// Accept one exact signed 1.0.7 calibration package only for one-way,
	/// no-model derivation of admission v3 and its frozen bank.
	#[arg(long, default_value_t = false, requires = "admission_output")]
	calibration_source_1_0_7: bool,
	/// New private verifier-signed admission output for an exact full 72-by-17 calibration.
	#[arg(
		long,
		requires_all = [
			"admission_tasks",
			"admission_environment",
			"admission_evaluator_root",
			"admission_corpus_commitment",
			"admission_evaluator_runtime",
			"admission_codex_toolchain_root",
			"admission_corpus_source_root",
			"admission_target_source_root",
			"admission_runner_binary",
			"admission_codex_binary",
			"production_reference",
			"expected_production_reference_sha256",
			"build_receipt",
			"expected_build_receipt_sha256"
		]
	)]
	admission_output: Option<PathBuf>,
	/// Current controlled tasks used to derive and bind the frozen bank.
	#[arg(long, requires = "admission_mode")]
	admission_tasks: Option<PathBuf>,
	/// Current verifier environment used only for admission authority bindings.
	#[arg(long, requires = "admission_mode")]
	admission_environment: Option<PathBuf>,
	/// Current controlled evaluator registry used only for admission bindings.
	#[arg(long, requires = "admission_mode")]
	admission_evaluator_root: Option<PathBuf>,
	/// Current corpus commitment used only for admission authority bindings.
	#[arg(long, requires = "admission_mode")]
	admission_corpus_commitment: Option<PathBuf>,
	/// Current controlled evaluator runtime used only for admission bindings.
	#[arg(long, requires = "admission_mode")]
	admission_evaluator_runtime: Option<PathBuf>,
	/// Current controlled model toolchain used only for admission bindings.
	#[arg(long, requires = "admission_mode")]
	admission_codex_toolchain_root: Option<PathBuf>,
	/// Retained corpus source snapshot validated by the admission corpus commitment.
	#[arg(long, requires = "admission_mode")]
	admission_corpus_source_root: Option<PathBuf>,
	/// Clean detached current release source validated against the admission environment.
	#[arg(long, requires = "admission_mode")]
	admission_target_source_root: Option<PathBuf>,
	/// Current frozen runner binary approved for Official execution.
	#[arg(long, requires = "admission_mode")]
	admission_runner_binary: Option<PathBuf>,
	/// Current frozen Codex binary approved for Official execution.
	#[arg(long, requires = "admission_mode")]
	admission_codex_binary: Option<PathBuf>,
	/// Protected production reference approving distinct runner and verifier identities.
	#[arg(long, requires = "admission_mode")]
	production_reference: Option<PathBuf>,
	/// Independently supplied exact SHA-256 of the protected production reference.
	#[arg(long, requires = "admission_mode")]
	expected_production_reference_sha256: Option<String>,
	/// Private final-build receipt that binds the retained binaries to source identity.
	#[arg(long, requires = "admission_mode")]
	build_receipt: Option<PathBuf>,
	/// Independently supplied exact SHA-256 of the private final-build receipt.
	#[arg(long, requires = "admission_mode")]
	expected_build_receipt_sha256: Option<String>,
}

/// Model-free admission renewal settings for one qualified target release.
#[derive(Debug, Parser)]
#[command(
	name = "aiq-verifier renew-calibration-admission",
	version,
	about = "Rebind one valid signed calibration bundle to a fully validated target release"
)]
struct RenewCalibrationAdmissionCli {
	/// Previously valid complete signed calibration admission bundle.
	#[arg(long)]
	source_bundle: PathBuf,
	/// Controlled directory containing the exact target 72-task set.
	#[arg(long)]
	tasks: PathBuf,
	/// Target verifier environment with the target source and binary identities.
	#[arg(long)]
	environment: PathBuf,
	/// Controlled target registry root for committed external evaluators.
	#[arg(long)]
	evaluator_root: PathBuf,
	/// Target corpus commitment that binds source, evaluator, runtime, and toolchain identities.
	#[arg(long)]
	corpus_commitment: PathBuf,
	/// Absolute controlled target Node.js runtime for committed external evaluators.
	#[arg(long)]
	evaluator_runtime: PathBuf,
	/// Absolute controlled target Node.js and ripgrep toolchain root.
	#[arg(long)]
	codex_toolchain_root: PathBuf,
	/// Retained corpus source snapshot bound by the immutable source manifest.
	#[arg(long)]
	corpus_source_root: PathBuf,
	/// Clean detached target repository source tree.
	#[arg(long)]
	target_source_root: PathBuf,
	/// Final target runner executable.
	#[arg(long)]
	runner_binary: PathBuf,
	/// Main executable in the exact target two-file Codex runtime.
	#[arg(long)]
	codex_binary: PathBuf,
	/// Protected production reference independently approving runner and verifier identities.
	#[arg(long)]
	production_reference: PathBuf,
	/// Independently supplied exact SHA-256 of the protected production reference.
	#[arg(long)]
	expected_production_reference_sha256: String,
	/// Private final-build receipt for the target source and binaries.
	#[arg(long)]
	build_receipt: PathBuf,
	/// Independently supplied exact SHA-256 of the target final-build receipt.
	#[arg(long)]
	expected_build_receipt_sha256: String,
	/// Create-new output path for the renewed complete signed bundle.
	#[arg(long)]
	output: PathBuf,
	/// Environment variable containing the approved verifier's 32-byte Ed25519 secret.
	#[arg(long, default_value = "AIQ_VERIFIER_SIGNING_KEY")]
	signing_key_env: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OperationalProductionReference {
	schema_version: String,
	published_at: String,
	corpus_commitment: Value,
	nodes: Vec<OperationalReferenceNode>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OperationalReferenceNode {
	schema_version: String,
	role: String,
	node_id: String,
	display_name: String,
	key_fingerprint: String,
	public_key: String,
	signature_algorithm: String,
	status: String,
	trust_tier: String,
	operator_class: String,
	capabilities: Vec<String>,
	source: String,
	signature_status: String,
	provenance: String,
	synthetic: bool,
	public_visible: bool,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct FinalBuildReceipt {
	schema_version: String,
	source_commit: String,
	source_tree: String,
	runner_executable_sha256: String,
	verifier_executable_sha256: String,
	codex_executable_sha256: String,
	codex_code_mode_host_sha256: String,
}

/// Offline source-verification and candidate-evaluator diagnostic settings.
#[derive(Debug, Parser)]
#[command(
	name = "aiq-verifier diagnose-rescore",
	version,
	about = "Verify one source package and rescore it with candidate evaluators without publication"
)]
struct DiagnoseRescoreCli {
	#[arg(long)]
	package: PathBuf,
	#[arg(long)]
	artifact_root: PathBuf,
	#[arg(long)]
	source_tasks: PathBuf,
	#[arg(long)]
	source_environment: PathBuf,
	#[arg(long)]
	source_evaluator_root: PathBuf,
	#[arg(long)]
	source_corpus_commitment: PathBuf,
	#[arg(long)]
	source_evaluator_runtime: PathBuf,
	#[arg(long)]
	source_codex_toolchain_root: PathBuf,
	#[arg(long)]
	candidate_tasks: PathBuf,
	#[arg(long)]
	candidate_source_root: PathBuf,
	#[arg(long)]
	candidate_evaluator_root: PathBuf,
	#[arg(long)]
	candidate_corpus_commitment: PathBuf,
	#[arg(long)]
	candidate_evaluator_runtime: PathBuf,
	#[arg(long)]
	candidate_codex_toolchain_root: PathBuf,
	#[arg(long)]
	replay_root: PathBuf,
	#[arg(
		long,
		default_value_t = DEFAULT_REPLAY_JOBS,
		value_parser = parse_replay_jobs
	)]
	replay_jobs: usize,
	/// New path for the permanently non-Official diagnostic report.
	#[arg(long)]
	output: PathBuf,
}

#[derive(Debug, Serialize)]
#[serde(deny_unknown_fields)]
struct DiagnosticRescoreCell {
	task_id: String,
	model: ModelConfig,
	source_status: ResultStatus,
	source_evaluation: runner::EvaluationOutcome,
	source_task_score: Option<f64>,
	candidate_evaluation: runner::EvaluationOutcome,
	candidate_task_score: Option<f64>,
	preserved_runtime_failure: bool,
}

#[derive(Debug, Serialize)]
#[serde(deny_unknown_fields)]
struct DiagnosticRescoreReport {
	schema_version: &'static str,
	classification: &'static str,
	official_eligible: FalseOnly,
	ranking_eligible: FalseOnly,
	source_package_sha256: String,
	source_run_id: String,
	source_corpus_commitment_sha256: String,
	candidate_corpus_commitment_sha256: String,
	candidate_task_set_digest: String,
	candidate_evaluator_digest: String,
	replay_scope: &'static str,
	result_count: usize,
	replayed_result_count: usize,
	preserved_runtime_failure_count: usize,
	cells: Vec<DiagnosticRescoreCell>,
	official_calibration: OfficialCalibrationDiagnostic,
}

/// Production verifier-environment validation settings.
#[derive(Debug, Parser)]
#[command(
	name = "aiq-verifier validate-environment",
	version,
	about = "Validate one verifier environment without reading process secrets or contacting a service"
)]
struct ValidateEnvironmentCli {
	/// Verifier-owned production environment metadata.
	#[arg(long)]
	environment: PathBuf,
}

/// Offline deterministic candidate-qualification verification settings.
#[derive(Debug, Parser)]
#[command(
	name = "aiq-verifier verify-qualification",
	version,
	about = "Recompute one exact three-matrix candidate qualification without publication"
)]
struct VerifyQualificationCli {
	/// Qualification or rejection artifact to verify.
	#[arg(long)]
	artifact: PathBuf,
	/// Exact predeclared candidate, policy, and child manifest.
	#[arg(long)]
	manifest: PathBuf,
	/// Independently retained canonical SHA-256 of the predeclared manifest.
	#[arg(long)]
	expected_manifest_sha256: String,
	/// Exact qualification-ready AIQ Core 1.1.0 public catalog.
	#[arg(long)]
	catalog: PathBuf,
	/// Replay-verified candidate calibration stage. Repeat exactly three times in predeclared order.
	#[arg(long = "stage", required = true)]
	stages: Vec<PathBuf>,
	/// Signed verifier attestation paired with each stage in the same order.
	#[arg(long = "attestation", required = true)]
	attestations: Vec<PathBuf>,
}

struct OperatorDiagnostic {
	class: OperatorErrorClass,
	code: &'static str,
	detail: String,
}
impl OperatorDiagnostic {
	fn bounded(class: OperatorErrorClass, code: &'static str, detail: impl Into<String>) -> Self {
		let detail = detail.into();
		let (code, detail) = if detail.len() <= MAX_OPERATOR_ERROR_DETAIL_BYTES {
			(code, detail)
		} else {
			(REDACTED_ERROR_CODE, REDACTED_ERROR_DETAIL.to_owned())
		};

		Self { class, code, detail }
	}
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ClaimResponse {
	claim: Claim,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Claim {
	inbox_id: String,
	idempotency_key: String,
	package_sha256: String,
	body_bytes: usize,
	object_content_sha256: String,
	lease_token: String,
	lease_expires_at: String,
	attempt: u64,
	object_url: String,
	object_url_expires_in_seconds: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct GatewayStatus {
	status: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct VerificationGatewayResponse {
	status: String,
	matrix_batch_id: String,
	package_sha256: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CalibrationVerificationGatewayResponse {
	status: String,
	run_id: String,
	package_sha256: String,
	official_eligible: bool,
	ranking_eligible: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RejectionGatewayResponse {
	status: String,
	published: bool,
	matrix_batch_id: String,
	package_sha256: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct LeaseRenewalResponse {
	status: String,
	inbox_id: String,
	lease_token: String,
	lease_expires_at: String,
	attempt: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ArtifactResolveResponse {
	artifact: ResolvedArtifact,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ResolvedArtifact {
	kind: String,
	content_sha256: String,
	bytes: u64,
	url: String,
	url_expires_in_seconds: u64,
}

#[derive(Clone, Copy, Debug, Serialize)]
struct TerminalClaim<'a> {
	inbox_id: &'a str,
	lease_token: &'a str,
	attempt: u64,
}
impl<'a> From<&'a Claim> for TerminalClaim<'a> {
	fn from(claim: &'a Claim) -> Self {
		Self { inbox_id: &claim.inbox_id, lease_token: &claim.lease_token, attempt: claim.attempt }
	}
}

#[derive(Clone, Debug, Serialize)]
struct RejectionRequest<'a> {
	claim: TerminalClaim<'a>,
	rejection: Rejection,
}

#[derive(Clone, Debug, Serialize)]
struct Rejection {
	schema_version: &'static str,
	matrix_batch_id: String,
	package_sha256: String,
	observed_at: String,
	production: bool,
	reason_code: &'static str,
	reason_detail: String,
	synthetic: bool,
	verifier_node_id: String,
}

#[derive(Clone, Debug, Serialize)]
struct VerificationRequest<'a> {
	claim: TerminalClaim<'a>,
	stage: &'a NormalizedBatchStage,
	attestation: &'a VerifierAttestationV2,
}

#[derive(Clone, Debug, Serialize)]
struct CalibrationVerificationRequest<'a> {
	claim: TerminalClaim<'a>,
	stage: &'a CalibrationVerifiedStageV1,
	attestation: &'a CalibrationVerifierAttestationV1,
}

#[derive(Clone, Debug)]
struct HttpResponse {
	status: u16,
	body: Vec<u8>,
}

struct HttpArtifactResolver<'a, T> {
	transport: &'a T,
	token: &'a Secret,
	endpoint: &'a str,
	inbox_id: &'a str,
	lease_token: &'a str,
	lease: Option<&'a dyn LeaseMaintenance>,
	max_retries: u32,
	backoff: Duration,
}
impl<T> HttpArtifactResolver<'_, T>
where
	T: Transport,
{
	fn resolve_once(
		&self,
		digest: &str,
		kind: &str,
		expected_bytes: u64,
	) -> Result<Vec<u8>, ArtifactResolveAttemptError> {
		self.maintain_lease().map_err(ArtifactResolveAttemptError::from_transport)?;

		let body = serde_json::to_vec(&serde_json::json!({
			"digest": digest,
			"inbox_id": self.inbox_id,
			"kind": kind,
			"lease_token": self.lease_token,
		}))
		.map_err(|error| {
			ArtifactResolveAttemptError::Final(WorkerError::configuration(error.to_string()))
		})?;
		let response = self
			.transport
			.post_json(&format!("{}/api/artifacts/resolve", self.endpoint), self.token, &body)
			.map_err(ArtifactResolveAttemptError::from_transport)?;

		match response.status {
			200 => {},
			404 => {
				return Err(ArtifactResolveAttemptError::Final(WorkerError::terminal(
					ReasonCode::ArtifactEvidenceUnavailable,
					"required claim artifact is absent",
				)));
			},
			408 | 409 | 429 | 500..=599 => {
				return Err(ArtifactResolveAttemptError::Retry(WorkerError::transient(
					"artifact resolver is unavailable",
				)));
			},
			401 | 403 => {
				return Err(ArtifactResolveAttemptError::Final(WorkerError::configuration(
					"artifact resolver authorization failed",
				)));
			},
			_ => {
				return Err(ArtifactResolveAttemptError::Final(WorkerError::terminal(
					ReasonCode::ArtifactEvidenceUnavailable,
					"artifact resolver denied required workspace evidence",
				)));
			},
		}

		let resolved: ArtifactResolveResponse =
			parse_json(&response.body, "artifact resolver response")
				.map_err(ArtifactResolveAttemptError::Final)?;

		if resolved.artifact.kind != kind
			|| resolved.artifact.content_sha256 != digest
			|| resolved.artifact.bytes != expected_bytes
			|| resolved.artifact.url_expires_in_seconds == 0
		{
			return Err(ArtifactResolveAttemptError::Final(WorkerError::terminal(
				ReasonCode::ArtifactEvidenceMismatch,
				"artifact resolver returned a mismatched object identity",
			)));
		}

		let object = self
			.transport
			.get_artifact_object(&resolved.artifact.url)
			.map_err(ArtifactResolveAttemptError::from_transport)?;

		match object.status {
			200 => Ok(object.body),
			404 => Err(ArtifactResolveAttemptError::Final(WorkerError::terminal(
				ReasonCode::ArtifactEvidenceUnavailable,
				"resolved artifact object is absent",
			))),
			// Supabase can return 403 when a short-lived signed object URL expires or is
			// temporarily invalid. Re-resolving obtains a fresh claim-bound URL.
			403 | 408 | 409 | 429 | 500..=599 => Err(ArtifactResolveAttemptError::Retry(
				WorkerError::transient("resolved artifact object is unavailable"),
			)),
			_ => Err(ArtifactResolveAttemptError::Final(WorkerError::terminal(
				ReasonCode::ArtifactEvidenceUnavailable,
				"resolved artifact object could not be read",
			))),
		}
	}
}

impl<T> ArtifactResolverClient for HttpArtifactResolver<'_, T>
where
	T: Transport,
{
	fn maintain_lease(&self) -> Result<(), WorkerError> {
		if let Some(lease) = self.lease { lease.maintain() } else { Ok(()) }
	}

	fn resolve(
		&self,
		digest: &str,
		kind: &str,
		expected_bytes: u64,
	) -> Result<Vec<u8>, WorkerError> {
		let mut delay = self.backoff;

		for attempt in 1..=self.max_retries.max(1) {
			match self.resolve_once(digest, kind, expected_bytes) {
				Ok(bytes) => return Ok(bytes),
				Err(ArtifactResolveAttemptError::Retry(_)) if attempt < self.max_retries.max(1) => {
					thread::sleep(delay);

					delay = delay.saturating_mul(2);
				},
				Err(ArtifactResolveAttemptError::Retry(error)) => return Err(error),
				Err(ArtifactResolveAttemptError::Final(error)) => return Err(error),
			}
		}

		Err(WorkerError::transient("artifact retry budget exhausted"))
	}
}

struct LocalArtifactResolver {
	root: PathBuf,
}
impl LocalArtifactResolver {
	fn new(root: &Path) -> Result<Self, WorkerError> {
		Ok(Self { root: controlled_root(root, "artifact root")? })
	}
}

impl ArtifactResolverClient for LocalArtifactResolver {
	fn resolve(
		&self,
		digest: &str,
		kind: &str,
		expected_bytes: u64,
	) -> Result<Vec<u8>, WorkerError> {
		if digest.len() != 64
			|| !digest.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
			|| !matches!(
				kind,
				"evaluator-results.json"
					| "stdout.jsonl"
					| "stderr.txt" | "capability-marker.txt"
					| "final-response.txt"
					| "workspace-manifest.json"
					| "workspace-snapshot.json"
			) {
			return Err(WorkerError::terminal(
				ReasonCode::ArtifactEvidenceMismatch,
				"local artifact identity is not canonical",
			));
		}

		let digest_root = self.root.join(digest);
		let digest_metadata = fs::symlink_metadata(&digest_root).map_err(|_| {
			WorkerError::terminal(
				ReasonCode::ArtifactEvidenceUnavailable,
				"required local artifact digest directory is absent",
			)
		})?;

		if digest_metadata.file_type().is_symlink() || !digest_metadata.is_dir() {
			return Err(WorkerError::terminal(
				ReasonCode::ArtifactEvidenceMismatch,
				"local artifact digest path is not a regular directory",
			));
		}

		let path = digest_root.join(kind);
		let metadata = fs::symlink_metadata(&path).map_err(|_| {
			WorkerError::terminal(
				ReasonCode::ArtifactEvidenceUnavailable,
				"required local artifact is absent",
			)
		})?;

		if metadata.file_type().is_symlink()
			|| !metadata.is_file()
			|| metadata.len() != expected_bytes
		{
			return Err(WorkerError::terminal(
				ReasonCode::ArtifactEvidenceMismatch,
				"local artifact type or byte count differs from the signed reference",
			));
		}

		let expected_bytes = usize::try_from(expected_bytes).map_err(|_| {
			WorkerError::terminal(
				ReasonCode::ArtifactEvidenceMismatch,
				"local artifact byte count is outside the verifier limit",
			)
		})?;
		let input = read_owned_regular_input(&path, "local replay artifact", expected_bytes)
			.map_err(|_| {
				WorkerError::terminal(
					ReasonCode::ArtifactEvidenceMismatch,
					"local artifact changed while it was read",
				)
			})?;

		if !input.canonical_path.starts_with(&self.root) {
			return Err(WorkerError::terminal(
				ReasonCode::ArtifactEvidenceMismatch,
				"local artifact escapes its controlled root",
			));
		}
		if input.bytes.len() != expected_bytes
			|| hex::encode(Sha256::digest(&input.bytes)) != digest
		{
			return Err(WorkerError::terminal(
				ReasonCode::ArtifactEvidenceMismatch,
				"local artifact bytes do not match the signed content address",
			));
		}

		Ok(input.bytes)
	}
}

struct UreqTransport {
	agent: ureq::Agent,
	allow_loopback_http: bool,
}
impl UreqTransport {
	fn new(timeout: Duration, allow_loopback_http: bool, replay_jobs: usize) -> Self {
		let config = ureq::Agent::config_builder()
			.timeout_global(Some(timeout))
			.max_idle_connections(replay_jobs)
			.max_idle_connections_per_host(replay_jobs)
			.build();

		Self { agent: config.into(), allow_loopback_http }
	}

	fn validate_url(&self, url: &str) -> Result<(), WorkerError> {
		if transport_url_is_allowed(url, self.allow_loopback_http) {
			Ok(())
		} else {
			Err(WorkerError::configuration("URLs must use HTTPS; test HTTP is limited to loopback"))
		}
	}

	fn collect(
		result: Result<Response<Body>, ureq::Error>,
		limit: usize,
	) -> Result<HttpResponse, WorkerError> {
		let mut response = match result {
			Ok(response) => response,
			Err(ureq::Error::StatusCode(status)) => {
				return Ok(HttpResponse { status, body: Vec::new() });
			},
			Err(ureq::Error::Timeout(_)) => {
				return Err(WorkerError::transient("HTTP request timed out"));
			},
			Err(_) => return Err(WorkerError::transient("HTTP transport failed")),
		};
		let status = response.status().as_u16();
		let body = response
			.body_mut()
			.with_config()
			.limit((limit + 1) as u64)
			.read_to_vec()
			.map_err(|_| WorkerError::transient("HTTP response body could not be read"))?;

		if body.len() > limit {
			return Err(WorkerError::transient("HTTP response exceeds its byte limit"));
		}

		Ok(HttpResponse { status, body })
	}
}

impl Transport for UreqTransport {
	fn post_json(
		&self,
		url: &str,
		token: &Secret,
		body: &[u8],
	) -> Result<HttpResponse, WorkerError> {
		self.validate_url(url)?;

		Self::collect(
			self.agent
				.post(url)
				.header("Authorization", &format!("Bearer {}", token.expose()))
				.header("Content-Type", "application/json")
				.send(body),
			MAX_GATEWAY_RESPONSE_BYTES,
		)
	}

	fn get_object(&self, url: &str) -> Result<HttpResponse, WorkerError> {
		self.validate_url(url)?;

		Self::collect(self.agent.get(url).call(), MAX_OBJECT_RESPONSE_BYTES)
	}

	fn get_artifact_object(&self, url: &str) -> Result<HttpResponse, WorkerError> {
		self.validate_url(url)?;

		Self::collect(self.agent.get(url).call(), MAX_ARTIFACT_RESPONSE_BYTES)
	}
}

struct Worker<T> {
	transport: T,
	endpoint: String,
	token: Secret,
	signing_identity: VerifierSigningIdentity,
	tasks: Vec<TaskDefinition>,
	environment: VerifierEnvironment,
	environment_sha256: String,
	worker_binary_sha256: String,
	lease_seconds: u64,
	max_retries: u32,
	backoff: Duration,
	evaluator_root: PathBuf,
	evaluator_runtime: Option<EvaluatorRuntime>,
	official_admission: Option<VerifiedOfficialCalibrationAdmission>,
	replay_root: PathBuf,
	replay_jobs: usize,
	#[cfg(test)]
	preparation_calls: AtomicUsize,
}
impl<T> Worker<T>
where
	T: Transport,
{
	fn run(&self, max_claims: u64, max_idle_polls: u64) -> Result<(), WorkerError> {
		let mut claims = 0;
		let mut idle_polls = 0;
		let mut incomplete_claims = 0_u64;

		while claims < max_claims && idle_polls < max_idle_polls {
			match self.retry(|| self.claim_one())? {
				ClaimResult::NoWork => {
					idle_polls += 1;

					if idle_polls < max_idle_polls {
						thread::sleep(self.backoff);
					}
				},
				ClaimResult::Claimed(claim) => {
					idle_polls = 0;
					claims += 1;

					let record = self.process_claim(&claim);

					incomplete_claims += u64::from(record.requires_operator_attention());

					println!(
						"{}",
						serde_json::to_string(&record).map_err(|error| {
							WorkerError::configuration(format!(
								"verification record serialization failed: {error}"
							))
						})?
					);
				},
			}
		}

		if incomplete_claims > 0 {
			return Err(WorkerError::transient(format!(
				"{incomplete_claims} claimed package(s) remained incomplete"
			)));
		}

		Ok(())
	}

	fn claim_one(&self) -> Result<ClaimResult, WorkerError> {
		let body = serde_json::to_vec(&serde_json::json!({
			"action": "claim",
			"lease_seconds": self.lease_seconds,
		}))
		.map_err(|error| WorkerError::configuration(error.to_string()))?;
		let response = self.transport.post_json(
			&format!("{}/api/claims", self.endpoint),
			&self.token,
			&body,
		)?;

		match response.status {
			204 => Ok(ClaimResult::NoWork),
			200 => {
				let value: ClaimResponse = parse_json(&response.body, "claim response")?;

				validate_claim(&value.claim)?;

				Ok(ClaimResult::Claimed(value.claim))
			},
			500..=599 => Err(WorkerError::transient("claim gateway is unavailable")),
			status => Err(WorkerError::configuration(format!(
				"claim gateway returned non-retryable HTTP {status}"
			))),
		}
	}

	fn renew_claim(&self, claim: &Claim) -> Result<(), WorkerError> {
		let body = serde_json::to_vec(&serde_json::json!({
			"action": "renew",
			"inbox_id": claim.inbox_id,
			"lease_seconds": RENEWED_LEASE_SECONDS,
			"lease_token": claim.lease_token,
		}))
		.map_err(|error| WorkerError::configuration(error.to_string()))?;
		let response = self.transport.post_json(
			&format!("{}/api/claims", self.endpoint),
			&self.token,
			&body,
		)?;

		match response.status {
			200 => {},
			409 | 500..=599 => {
				return Err(WorkerError::transient("claim lease renewal is unavailable"));
			},
			status => {
				return Err(WorkerError::configuration(format!(
					"claim lease renewal returned HTTP {status}"
				)));
			},
		}

		let renewal: LeaseRenewalResponse = parse_json(&response.body, "lease renewal response")?;

		if renewal.status != "renewed"
			|| renewal.inbox_id != claim.inbox_id
			|| renewal.lease_token != claim.lease_token
			|| renewal.lease_expires_at.is_empty()
			|| renewal.attempt != claim.attempt
		{
			return Err(WorkerError::transient(
				"claim lease renewal returned a mismatched identity",
			));
		}

		Ok(())
	}

	fn process_claim(&self, claim: &Claim) -> VerificationRecord {
		self.record_claim_result(claim, self.verify_claim(claim))
	}

	fn record_claim_result(
		&self,
		claim: &Claim,
		result: Result<PackageDisposition, WorkerError>,
	) -> VerificationRecord {
		let (disposition, reason_code, replay_scope, diagnostic, calibration) = match result {
			Ok(PackageDisposition::Verified(scope, calibration)) => {
				("verified", None, scope, None, calibration)
			},
			Ok(PackageDisposition::Rejected(reason, calibration)) => (
				"rejected",
				Some(reason),
				"verification_rejected",
				Some(OperatorDiagnostic::bounded(
					OperatorErrorClass::Terminal,
					reason.as_str(),
					reason.operator_detail(),
				)),
				calibration,
			),
			Ok(PackageDisposition::LeaseLost(scope)) => (
				"lease_lost",
				None,
				scope,
				Some(OperatorDiagnostic::bounded(
					OperatorErrorClass::Transient,
					"claim_lease_lost",
					"The claim lease was lost before terminal acknowledgement.",
				)),
				None,
			),
			Err(error) => {
				let diagnostic = error.operator_diagnostic();
				let _release_result = self.retry(|| self.acknowledge(claim, "retry"));

				if error.is_transient() {
					("retry", None, "verification_incomplete", Some(diagnostic), None)
				} else {
					("worker_error", None, "verification_incomplete", Some(diagnostic), None)
				}
			},
		};
		let (error_class, error_code, error_detail) = diagnostic
			.map_or((None, None, None), |diagnostic| {
				(Some(diagnostic.class), Some(diagnostic.code), Some(diagnostic.detail))
			});

		VerificationRecord {
			schema_version: RECORD_SCHEMA,
			inbox_id: claim.inbox_id.clone(),
			idempotency_key: claim.idempotency_key.clone(),
			package_sha256: claim.package_sha256.clone(),
			disposition,
			reason_code,
			worker_name: env!("CARGO_PKG_NAME"),
			worker_version: env!("CARGO_PKG_VERSION"),
			worker_binary_sha256: self.worker_binary_sha256.clone(),
			environment_sha256: self.environment_sha256.clone(),
			official_calibration_policy: OfficialCalibrationPolicy::default(),
			official_calibration_observed: calibration.map(|value| value.observed),
			replay_scope,
			attempt: claim.attempt,
			error_class,
			error_code,
			error_detail,
		}
	}

	fn verify_claim(&self, claim: &Claim) -> Result<PackageDisposition, WorkerError> {
		let lease = ClaimLease::new(self, claim);

		lease.force()?;

		lease.with_heartbeat(|| self.verify_claim_with_lease(claim, &lease))
	}

	fn verify_claim_with_lease(
		&self,
		claim: &Claim,
		lease: &ClaimLease<'_, T>,
	) -> Result<PackageDisposition, WorkerError> {
		let package_bytes = match self.retry(|| {
			lease.maintain()?;

			self.download_package(claim)
		}) {
			Ok(bytes) => bytes,
			Err(error) if error.is_transient() => return Err(error),
			Err(error) => return self.reject_and_complete(claim, lease, error),
		};

		if let Err(error) = validate_package_official_admission_before_replay(
			&package_bytes,
			&self.tasks,
			self.official_admission.as_ref(),
		) {
			return self.reject_and_complete(claim, lease, error);
		}

		let prepared = match self.prepare_verification(claim, &package_bytes, lease) {
			Ok(prepared) => prepared,
			Err(error) => {
				let error = apply_replay_confirmation_policy(error, claim.attempt);

				return self.reject_and_complete(claim, lease, error);
			},
		};
		let body = match serialize_prepared_verification(claim, &prepared) {
			Ok(body) => body,
			Err(error) => return self.reject_and_complete(claim, lease, error),
		};
		let response = self.retry(|| {
			lease.with_terminal_lease(
				|| self.post_verification(&body, "verification gateway is unavailable"),
				|response| {
					response.status == 200
						&& verification_response_matches(&response.body, &prepared)
				},
			)
		})?;

		if response.status != 200 {
			if response.status >= 500 {
				return Err(WorkerError::transient("verification gateway is unavailable"));
			}

			return self.reject_and_complete(
				claim,
				lease,
				WorkerError::terminal(
					ReasonCode::NormalizationMismatch,
					"verification gateway rejected the locally validated normalization",
				),
			);
		}
		if !verification_response_matches(&response.body, &prepared) {
			return Ok(PackageDisposition::LeaseLost(prepared.replay_scope));
		}

		let _acknowledgement = self.retry(|| self.acknowledge(claim, "completed"));

		Ok(PackageDisposition::Verified(prepared.replay_scope, prepared.official_calibration))
	}

	fn download_package(&self, claim: &Claim) -> Result<Vec<u8>, WorkerError> {
		let response = self.transport.get_object(&claim.object_url)?;

		if response.status >= 500 {
			return Err(WorkerError::transient("private object storage is unavailable"));
		}
		if response.status != 200 {
			return Err(WorkerError::transient("private object could not be fetched"));
		}
		if response.body.len() != claim.body_bytes || response.body.len() > MAX_SUBMISSION_BYTES {
			return Err(WorkerError::terminal(
				ReasonCode::PackageIntegrityMismatch,
				"private object byte count does not match the claim",
			));
		}

		let digest = hex::encode(Sha256::digest(&response.body));

		if digest != claim.package_sha256 || digest != claim.object_content_sha256 {
			return Err(WorkerError::terminal(
				ReasonCode::PackageIntegrityMismatch,
				"private object SHA-256 does not match the claim",
			));
		}

		Ok(response.body)
	}

	fn prepare_verification(
		&self,
		claim: &Claim,
		package_bytes: &[u8],
		lease: &dyn LeaseMaintenance,
	) -> Result<PreparedVerification, WorkerError> {
		#[cfg(test)]
		self.preparation_calls.fetch_add(1, Ordering::Relaxed);

		let endpoint =
			self.environment.artifact_resolver_endpoint.as_deref().unwrap_or(&self.endpoint);
		let resolver = HttpArtifactResolver {
			transport: &self.transport,
			token: &self.token,
			endpoint: endpoint.trim_end_matches('/'),
			inbox_id: &claim.inbox_id,
			lease_token: &claim.lease_token,
			lease: Some(lease),
			max_retries: self.max_retries,
			backoff: self.backoff,
		};

		prepare_package_verification(PreparationRequest {
			package_bytes,
			package_sha256: &claim.package_sha256,
			expected_idempotency_key: Some(&claim.idempotency_key),
			replay_identity: &claim.inbox_id,
			resolver: &resolver,
			tasks: &self.tasks,
			environment: &self.environment,
			evaluator_root: &self.evaluator_root,
			evaluator_runtime: self.evaluator_runtime.as_ref(),
			replay_root: &self.replay_root,
			signing_identity: &self.signing_identity,
			official_admission: self.official_admission.as_ref(),
			require_official_admission: true,
			observed_unix_ms: now_unix_ms()?,
			require_production: false,
			replay_jobs: self.replay_jobs,
		})
	}

	fn reject_and_complete(
		&self,
		claim: &Claim,
		lease: &ClaimLease<'_, T>,
		error: WorkerError,
	) -> Result<PackageDisposition, WorkerError> {
		let ErrorKind::Terminal(reason) = error.kind else {
			return Err(error);
		};
		let official_calibration = error.official_calibration.as_deref().cloned();
		let matrix_batch_id = claim.idempotency_key.clone();
		let rejection = RejectionRequest {
			claim: claim.into(),
			rejection: Rejection {
				schema_version: VERIFIER_REJECTION_SCHEMA,
				matrix_batch_id,
				package_sha256: claim.package_sha256.clone(),
				observed_at: now_utc_timestamp()?,
				production: !self.environment.synthetic_test,
				reason_code: reason.as_str(),
				reason_detail: error.message,
				synthetic: self.environment.synthetic_test,
				verifier_node_id: self.signing_identity.node().node_id.clone(),
			},
		};
		let body = serde_json::to_vec(&rejection)
			.map_err(|serialize_error| WorkerError::configuration(serialize_error.to_string()))?;
		let response = self.retry(|| {
			lease.with_terminal_lease(
				|| self.post_verification(&body, "rejection gateway is unavailable"),
				|response| {
					response.status == 200 && rejection_response_matches(&response.body, claim)
				},
			)
		})?;

		if response.status != 200 {
			return if response.status >= 500 {
				Err(WorkerError::transient("rejection gateway is unavailable"))
			} else {
				Err(WorkerError::configuration(format!(
					"rejection gateway returned HTTP {}",
					response.status
				)))
			};
		}
		if !rejection_response_matches(&response.body, claim) {
			return Ok(PackageDisposition::LeaseLost("verification_rejected"));
		}

		let _acknowledgement = self.retry(|| self.acknowledge(claim, "completed"));

		Ok(PackageDisposition::Rejected(reason, official_calibration))
	}

	fn post_verification(
		&self,
		body: &[u8],
		unavailable_message: &'static str,
	) -> Result<HttpResponse, WorkerError> {
		let response = self.transport.post_json(
			&format!("{}/api/verifications", self.endpoint),
			&self.token,
			body,
		)?;

		if retryable_verification_status(response.status) {
			return Err(WorkerError::transient(unavailable_message));
		}

		Ok(response)
	}

	fn acknowledge(&self, claim: &Claim, disposition: &str) -> Result<(), WorkerError> {
		let body = serde_json::to_vec(&serde_json::json!({
			"action": "ack",
			"disposition": disposition,
			"inbox_id": claim.inbox_id,
			"lease_token": claim.lease_token,
		}))
		.map_err(|error| WorkerError::configuration(error.to_string()))?;
		let response = self.transport.post_json(
			&format!("{}/api/claims", self.endpoint),
			&self.token,
			&body,
		)?;

		match response.status {
			200 => {
				let status: GatewayStatus = parse_json(&response.body, "acknowledgement response")?;

				if status.status == "acknowledged" || status.status == "idempotent" {
					Ok(())
				} else {
					Err(WorkerError::transient("claim acknowledgement returned an unknown status"))
				}
			},
			409 => Err(WorkerError::terminal(
				ReasonCode::InvalidPackageProtocol,
				"claim lease was lost or already acknowledged",
			)),
			500..=599 => Err(WorkerError::transient("claim acknowledgement is unavailable")),
			status => Err(WorkerError::configuration(format!(
				"claim acknowledgement returned HTTP {status}"
			))),
		}
	}

	fn retry<F, R>(&self, mut operation: F) -> Result<R, WorkerError>
	where
		F: FnMut() -> Result<R, WorkerError>,
	{
		let mut delay = self.backoff;

		for attempt in 1..=self.max_retries {
			match operation() {
				Ok(value) => return Ok(value),
				Err(error) if error.is_transient() && attempt < self.max_retries => {
					thread::sleep(delay);

					delay = delay.saturating_mul(2);
				},
				Err(error) => return Err(error),
			}
		}

		Err(WorkerError::transient("retry budget exhausted"))
	}
}

struct ClaimLease<'a, T> {
	worker: &'a Worker<T>,
	claim: &'a Claim,
	state: Mutex<ClaimLeaseState>,
	wakeup: Condvar,
	interval: Duration,
	#[cfg(test)]
	heartbeat_spawn_failure: bool,
}
impl<'a, T> ClaimLease<'a, T>
where
	T: Transport,
{
	fn new(worker: &'a Worker<T>, claim: &'a Claim) -> Self {
		Self {
			worker,
			claim,
			state: Mutex::new(ClaimLeaseState {
				last_renewed: Instant::now(),
				lost: None,
				stopped: false,
				terminal: false,
			}),
			wakeup: Condvar::new(),
			interval: LEASE_RENEWAL_INTERVAL,
			#[cfg(test)]
			heartbeat_spawn_failure: false,
		}
	}

	#[cfg(test)]
	fn with_interval(worker: &'a Worker<T>, claim: &'a Claim, interval: Duration) -> Self {
		let mut lease = Self::new(worker, claim);

		lease.interval = interval;

		lease
	}

	fn force(&self) -> Result<(), WorkerError> {
		self.renew(true)
	}

	fn renew(&self, force: bool) -> Result<(), WorkerError> {
		let mut state = self
			.state
			.lock()
			.map_err(|_| WorkerError::transient("claim lease state is unavailable"))?;

		if let Some(error) = &state.lost {
			return Err(error.clone());
		}

		if state.terminal {
			return Ok(());
		}
		if state.stopped {
			return Err(WorkerError::transient("claim lease heartbeat stopped"));
		}
		if !force && state.last_renewed.elapsed() < self.interval {
			return Ok(());
		}

		if let Err(error) = self.worker.retry(|| self.worker.renew_claim(self.claim)) {
			state.lost = Some(error.clone());

			self.wakeup.notify_all();

			return Err(error);
		}

		state.last_renewed = Instant::now();

		Ok(())
	}

	fn with_heartbeat(
		&self,
		operation: impl FnOnce() -> Result<PackageDisposition, WorkerError>,
	) -> Result<PackageDisposition, WorkerError> {
		thread::scope(|scope| {
			let stop_guard = ClaimLeaseStopGuard { lease: self };

			#[cfg(test)]
			if self.heartbeat_spawn_failure {
				return Err(WorkerError::transient("claim lease heartbeat could not start"));
			}

			let heartbeat = Builder::new()
				.name("aiq-verifier-lease-heartbeat".to_owned())
				.spawn_scoped(scope, || self.run_heartbeat())
				.map_err(|_| WorkerError::transient("claim lease heartbeat could not start"))?;
			let result = operation();

			drop(stop_guard);

			let heartbeat_result = heartbeat
				.join()
				.map_err(|_| WorkerError::transient("claim lease heartbeat failed"))?;

			match (result, heartbeat_result) {
				(Ok(PackageDisposition::Verified(scope, calibration)), _) => {
					Ok(PackageDisposition::Verified(scope, calibration))
				},
				(Ok(PackageDisposition::Rejected(reason, calibration)), _) => {
					Ok(PackageDisposition::Rejected(reason, calibration))
				},
				(Ok(PackageDisposition::LeaseLost(scope)), _) => {
					Ok(PackageDisposition::LeaseLost(scope))
				},
				(_, Err(lease_error)) => Err(lease_error),
				(result, Ok(())) => result,
			}
		})
	}

	fn run_heartbeat(&self) -> Result<(), WorkerError> {
		loop {
			let state = self
				.state
				.lock()
				.map_err(|_| WorkerError::transient("claim lease state is unavailable"))?;

			if state.stopped {
				return state.lost.clone().map_or(Ok(()), Err);
			}

			if let Some(error) = &state.lost {
				return Err(error.clone());
			}

			let wait = self.interval.saturating_sub(state.last_renewed.elapsed());
			let (state, _) = self
				.wakeup
				.wait_timeout(state, wait)
				.map_err(|_| WorkerError::transient("claim lease heartbeat is unavailable"))?;

			if state.stopped {
				return state.lost.clone().map_or(Ok(()), Err);
			}

			if let Some(error) = &state.lost {
				return Err(error.clone());
			}

			if state.last_renewed.elapsed() < self.interval {
				continue;
			}

			drop(state);

			self.renew(false)?;
		}
	}

	fn stop(&self) {
		let mut state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());

		state.stopped = true;

		self.wakeup.notify_all();
	}

	fn with_terminal_lease<R>(
		&self,
		operation: impl FnOnce() -> Result<R, WorkerError>,
		terminal_response: impl FnOnce(&R) -> bool,
	) -> Result<R, WorkerError> {
		self.renew(false)?;

		let mut state = self
			.state
			.lock()
			.map_err(|_| WorkerError::transient("claim lease state is unavailable"))?;

		if let Some(error) = &state.lost {
			return Err(error.clone());
		}

		if state.stopped {
			return Err(WorkerError::transient("claim lease heartbeat stopped"));
		}

		let result = operation();
		let terminal = result.as_ref().is_ok_and(terminal_response);

		if terminal {
			state.terminal = true;
			state.stopped = true;

			self.wakeup.notify_all();
		}

		drop(state);

		result
	}
}

impl<T> LeaseMaintenance for ClaimLease<'_, T>
where
	T: Transport,
{
	fn maintain(&self) -> Result<(), WorkerError> {
		self.renew(false)
	}
}

struct ClaimLeaseStopGuard<'lease, 'worker, T>
where
	T: Transport,
{
	lease: &'lease ClaimLease<'worker, T>,
}
impl<T> Drop for ClaimLeaseStopGuard<'_, '_, T>
where
	T: Transport,
{
	fn drop(&mut self) {
		self.lease.stop();
	}
}

struct ClaimLeaseState {
	last_renewed: Instant,
	lost: Option<WorkerError>,
	stopped: bool,
	terminal: bool,
}

#[derive(Debug)]
struct PreparedVerification {
	evidence: PreparedEvidence,
	replay_scope: &'static str,
	official_calibration: Option<OfficialCalibrationDiagnostic>,
	calibration_source: Option<CalibrationRunRecord>,
	calibration_source_scoring_version: Option<String>,
}
impl PreparedVerification {
	fn run_id(&self) -> &str {
		match &self.evidence {
			PreparedEvidence::Official { stage, .. } => &stage.matrix_batch_id,
			PreparedEvidence::Calibration { stage, .. } => &stage.run_id,
		}
	}

	fn package_sha256(&self) -> &str {
		match &self.evidence {
			PreparedEvidence::Official { stage, .. } => &stage.package_sha256,
			PreparedEvidence::Calibration { stage, .. } => &stage.package_sha256,
		}
	}

	fn expected_gateway_status(&self) -> &'static str {
		match self.evidence {
			PreparedEvidence::Official { .. } => "verified_published",
			PreparedEvidence::Calibration { .. } => "calibration_verified_published",
		}
	}
}

struct PreparationRequest<'a> {
	package_bytes: &'a [u8],
	package_sha256: &'a str,
	expected_idempotency_key: Option<&'a str>,
	replay_identity: &'a str,
	resolver: &'a dyn ArtifactResolverClient,
	tasks: &'a [TaskDefinition],
	environment: &'a VerifierEnvironment,
	evaluator_root: &'a Path,
	evaluator_runtime: Option<&'a EvaluatorRuntime>,
	replay_root: &'a Path,
	signing_identity: &'a VerifierSigningIdentity,
	official_admission: Option<&'a VerifiedOfficialCalibrationAdmission>,
	require_official_admission: bool,
	observed_unix_ms: u64,
	require_production: bool,
	replay_jobs: usize,
}

struct OutputTarget {
	path: PathBuf,
	parent: PathBuf,
	file_name: String,
}
impl OutputTarget {
	fn new(path: &Path, label: &str) -> Result<Self, WorkerError> {
		if path == Path::new("-") || fs::symlink_metadata(path).is_ok() {
			return Err(WorkerError::configuration(format!(
				"{label} must be a new regular-file path"
			)));
		}

		let parent =
			path.parent().filter(|value| !value.as_os_str().is_empty()).unwrap_or(Path::new("."));
		let parent = controlled_root(parent, &format!("{label} parent"))?;
		let file_name = path
			.file_name()
			.and_then(|value| value.to_str())
			.filter(|value| !value.is_empty() && *value != "." && *value != "..")
			.ok_or_else(|| WorkerError::configuration(format!("{label} has an invalid file name")))?
			.to_owned();
		let path = parent.join(&file_name);

		if fs::symlink_metadata(&path).is_ok() {
			return Err(WorkerError::configuration(format!("{label} must not already exist")));
		}

		Ok(Self { path, parent, file_name })
	}
}

struct TemporaryOutput {
	path: PathBuf,
}
impl Drop for TemporaryOutput {
	fn drop(&mut self) {
		let _ = fs::remove_file(&self.path);
	}
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct FileIdentity {
	#[cfg(unix)]
	device: u64,
	#[cfg(unix)]
	inode: u64,
}
impl FileIdentity {
	fn from_metadata(metadata: &fs::Metadata) -> Self {
		Self {
			#[cfg(unix)]
			device: metadata.dev(),
			#[cfg(unix)]
			inode: metadata.ino(),
		}
	}

	fn matches(self, metadata: &fs::Metadata) -> bool {
		#[cfg(unix)]
		{
			self.device == metadata.dev() && self.inode == metadata.ino()
		}

		#[cfg(not(unix))]
		{
			let _ = metadata;

			true
		}
	}
}

struct RegularInput {
	bytes: Vec<u8>,
	canonical_path: PathBuf,
}

struct ConfiguredEvaluatorSet {
	tasks: Vec<TaskDefinition>,
	evaluator_root: PathBuf,
	evaluator_runtime: EvaluatorRuntime,
	toolchain_root: PathBuf,
	corpus_commitment_sha256: String,
	task_set_digest: String,
	evaluator_digest: String,
}

struct ConfiguredSourceEvaluatorSet {
	set: ConfiguredEvaluatorSet,
	environment: VerifierEnvironment,
}

struct ConfiguredCandidateEvaluatorSet {
	set: ConfiguredEvaluatorSet,
	source_root: PathBuf,
}

struct DiagnosticSourcePackage {
	run: RunRecord,
	sha256: String,
}

struct OperationalAdmissionContext {
	bindings: CalibrationAdmissionBindings,
	tasks: Vec<TaskDefinition>,
}

#[derive(Clone, Copy)]
struct OperationalAdmissionPaths<'a> {
	tasks: &'a Path,
	environment: &'a Path,
	evaluator_root: &'a Path,
	corpus_commitment: &'a Path,
	evaluator_runtime: &'a Path,
	codex_toolchain_root: &'a Path,
	corpus_source_root: &'a Path,
	target_source_root: &'a Path,
	runner_binary: &'a Path,
	codex_binary: &'a Path,
	production_reference: &'a Path,
	expected_production_reference_sha256: &'a str,
	build_receipt: &'a Path,
	expected_build_receipt_sha256: &'a str,
}

struct VerifiedOfficialCalibrationAdmission {
	bundle: CalibrationAdmissionBundleV3,
	bindings: CalibrationAdmissionBindings,
}

struct OperationalAdmissionAssets {
	tasks: Vec<TaskDefinition>,
	environment: VerifierEnvironment,
	evaluator_runtime: EvaluatorRuntime,
	corpus: ValidatedCorpusCommitment,
	model_toolchain: ValidatedModelToolchain,
	target_source_tree: String,
	task_set_digest: String,
	evaluator_digest: String,
}

/// Stable rejection reason understood by operators and automation.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReasonCode {
	/// Claimed object bytes do not match the queue commitment.
	PackageIntegrityMismatch,
	/// Package JSON or its result protocol is invalid.
	InvalidPackageProtocol,
	/// Package signature, identity, content hash, or signer binding is invalid.
	InvalidPackageSignature,
	/// Signed run provenance or controlled task binding is invalid.
	InvalidRunProvenance,
	/// Deterministic scoring or normalization replay failed.
	NormalizationMismatch,
	/// Required retained execution evidence is absent.
	ArtifactEvidenceUnavailable,
	/// Retained execution evidence does not match its content address.
	ArtifactEvidenceMismatch,
	/// Workspace replay evidence has an invalid or ambiguous shape.
	InvalidReplayEvidence,
	/// Controlled evaluator replay failed or differed from the signed result.
	EvaluatorReplayMismatch,
}
impl ReasonCode {
	fn as_str(self) -> &'static str {
		match self {
			Self::PackageIntegrityMismatch => "package_integrity_mismatch",
			Self::InvalidPackageProtocol => "invalid_package_protocol",
			Self::InvalidPackageSignature => "invalid_package_signature",
			Self::InvalidRunProvenance => "invalid_run_provenance",
			Self::NormalizationMismatch => "normalization_mismatch",
			Self::ArtifactEvidenceUnavailable => "artifact_evidence_unavailable",
			Self::ArtifactEvidenceMismatch => "artifact_evidence_mismatch",
			Self::InvalidReplayEvidence => "invalid_replay_evidence",
			Self::EvaluatorReplayMismatch => "evaluator_replay_mismatch",
		}
	}

	fn operator_detail(self) -> &'static str {
		match self {
			Self::PackageIntegrityMismatch => {
				"The package bytes do not match the queue commitment."
			},
			Self::InvalidPackageProtocol => "The package protocol is invalid.",
			Self::InvalidPackageSignature => "The package signature or signer binding is invalid.",
			Self::InvalidRunProvenance => "The run provenance does not match the verifier policy.",
			Self::NormalizationMismatch => "Deterministic normalization did not match.",
			Self::ArtifactEvidenceUnavailable => "Required artifact evidence is unavailable.",
			Self::ArtifactEvidenceMismatch => "Artifact evidence does not match its commitment.",
			Self::InvalidReplayEvidence => "Replay evidence is invalid.",
			Self::EvaluatorReplayMismatch => "Evaluator replay did not match the signed result.",
		}
	}
}

enum ArtifactResolveAttemptError {
	Retry(WorkerError),
	Final(WorkerError),
}
impl ArtifactResolveAttemptError {
	fn from_transport(error: WorkerError) -> Self {
		if error.is_transient() { Self::Retry(error) } else { Self::Final(error) }
	}
}

#[derive(Debug)]
enum PreparedEvidence {
	Official { stage: NormalizedBatchStage, attestation: VerifierAttestationV2 },
	Calibration { stage: CalibrationVerifiedStageV1, attestation: CalibrationVerifierAttestationV1 },
}

#[derive(Clone, Copy)]
enum CalibrationReplayMode {
	Current,
	PromotedSource1_0_7,
	CandidateQualification,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum OperatorErrorClass {
	Configuration,
	Transient,
	Terminal,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ErrorKind {
	Configuration,
	Transient,
	Terminal(ReasonCode),
}

enum ClaimResult {
	NoWork,
	Claimed(Claim),
}

#[derive(Debug)]
enum PackageDisposition {
	Verified(&'static str, Option<OfficialCalibrationDiagnostic>),
	Rejected(ReasonCode, Option<OfficialCalibrationDiagnostic>),
	LeaseLost(&'static str),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PublicationPoint {
	Install(usize),
	Rollback(usize),
}

/// Parses configuration and runs one bounded worker invocation or offline replay.
pub fn run_cli() -> Result<(), WorkerError> {
	let arguments = env::args_os().collect::<Vec<_>>();

	if let Some(command) = arguments.get(1) {
		if command == "verify-local" {
			let mut local_arguments = vec![OsString::from("aiq-verifier verify-local")];

			local_arguments.extend(arguments.iter().skip(2).cloned());

			return run_verify_local(VerifyLocalCli::parse_from(local_arguments));
		}
		if command == "renew-calibration-admission" {
			let mut renewal_arguments =
				vec![OsString::from("aiq-verifier renew-calibration-admission")];

			renewal_arguments.extend(arguments.iter().skip(2).cloned());

			return run_renew_calibration_admission(RenewCalibrationAdmissionCli::parse_from(
				renewal_arguments,
			));
		}
		if command == "diagnose-rescore" {
			let mut diagnostic_arguments = vec![OsString::from("aiq-verifier diagnose-rescore")];

			diagnostic_arguments.extend(arguments.iter().skip(2).cloned());

			return run_diagnose_rescore(DiagnoseRescoreCli::parse_from(diagnostic_arguments));
		}
		if command == "validate-environment" {
			let mut validate_arguments = vec![OsString::from("aiq-verifier validate-environment")];

			validate_arguments.extend(arguments.iter().skip(2).cloned());

			return run_validate_environment(ValidateEnvironmentCli::parse_from(
				validate_arguments,
			));
		}
		if command == "verify-qualification" {
			let mut qualification_arguments =
				vec![OsString::from("aiq-verifier verify-qualification")];

			qualification_arguments.extend(arguments.iter().skip(2).cloned());

			return run_verify_qualification(VerifyQualificationCli::parse_from(
				qualification_arguments,
			));
		}
	}

	run_worker(Cli::parse_from(arguments))
}

fn retryable_verification_status(status: u16) -> bool {
	matches!(status, 408 | 409 | 429 | 500..=599)
}

fn apply_replay_confirmation_policy(error: WorkerError, claim_attempt: u64) -> WorkerError {
	if claim_attempt == 1 && error.kind == ErrorKind::Terminal(ReasonCode::EvaluatorReplayMismatch)
	{
		WorkerError::transient(UNCONFIRMED_EVALUATOR_REPLAY_MISMATCH)
	} else {
		error
	}
}

fn prepare_package_verification(
	request: PreparationRequest<'_>,
) -> Result<PreparedVerification, WorkerError> {
	let observed_package_sha256 = hex::encode(Sha256::digest(request.package_bytes));

	if observed_package_sha256 != request.package_sha256 {
		return Err(WorkerError::terminal(
			ReasonCode::PackageIntegrityMismatch,
			"package bytes do not match the expected SHA-256",
		));
	}

	let envelope: SubmissionEnvelope =
		serde_json::from_slice(request.package_bytes).map_err(|_| {
			WorkerError::terminal(
				ReasonCode::InvalidPackageProtocol,
				"package is not a valid result envelope",
			)
		})?;

	if request.expected_idempotency_key.is_some_and(|expected| envelope.idempotency_key != expected)
	{
		return Err(WorkerError::terminal(
			ReasonCode::InvalidPackageProtocol,
			"expected idempotency key does not match the package",
		));
	}

	let verified = envelope.verify(&BTreeSet::new()).map_err(|_| {
		WorkerError::terminal(
			ReasonCode::InvalidPackageSignature,
			"package identity, content hash, or signature is invalid",
		)
	})?;

	match verified.payload_type.as_str() {
		RUN_PAYLOAD_TYPE => prepare_official_verification(request, verified),
		CALIBRATION_RUN_PAYLOAD_TYPE => {
			if envelope.claimed_trust != TrustTier::Untrusted {
				return Err(WorkerError::terminal(
					ReasonCode::InvalidPackageProtocol,
					"calibration package must claim untrusted handling",
				));
			}

			prepare_calibration_verification(request, verified)
		},
		_ => Err(WorkerError::terminal(
			ReasonCode::InvalidPackageProtocol,
			"package payload type is unsupported",
		)),
	}
}

fn prepare_candidate_qualification_verification(
	request: PreparationRequest<'_>,
) -> Result<PreparedVerification, WorkerError> {
	let observed_package_sha256 = hex::encode(Sha256::digest(request.package_bytes));

	if observed_package_sha256 != request.package_sha256 {
		return Err(WorkerError::terminal(
			ReasonCode::PackageIntegrityMismatch,
			"candidate package bytes do not match the expected SHA-256",
		));
	}

	let envelope: SubmissionEnvelope =
		serde_json::from_slice(request.package_bytes).map_err(|_| {
			WorkerError::terminal(
				ReasonCode::InvalidPackageProtocol,
				"candidate package is not a valid result envelope",
			)
		})?;

	if request.expected_idempotency_key.is_some_and(|expected| envelope.idempotency_key != expected)
	{
		return Err(WorkerError::terminal(
			ReasonCode::InvalidPackageProtocol,
			"expected idempotency key does not match the candidate package",
		));
	}
	if envelope.claimed_trust != TrustTier::Untrusted {
		return Err(WorkerError::terminal(
			ReasonCode::InvalidPackageProtocol,
			"candidate qualification package must claim untrusted handling",
		));
	}

	let verified = envelope.verify(&BTreeSet::new()).map_err(|_| {
		WorkerError::terminal(
			ReasonCode::InvalidPackageSignature,
			"candidate package identity, content hash, or signature is invalid",
		)
	})?;

	if verified.payload_type != CALIBRATION_RUN_PAYLOAD_TYPE {
		return Err(WorkerError::terminal(
			ReasonCode::InvalidPackageProtocol,
			"candidate qualification accepts only a signed calibration package",
		));
	}

	prepare_calibration_verification_inner(
		request,
		verified,
		CalibrationReplayMode::CandidateQualification,
	)
}

fn prepare_calibration_source_1_0_7_verification(
	request: PreparationRequest<'_>,
) -> Result<PreparedVerification, WorkerError> {
	let observed_package_sha256 = hex::encode(Sha256::digest(request.package_bytes));

	if observed_package_sha256 != request.package_sha256 {
		return Err(WorkerError::terminal(
			ReasonCode::PackageIntegrityMismatch,
			"package bytes do not match the expected SHA-256",
		));
	}

	let envelope: SubmissionEnvelope =
		serde_json::from_slice(request.package_bytes).map_err(|_| {
			WorkerError::terminal(
				ReasonCode::InvalidPackageProtocol,
				"calibration source is not a valid result envelope",
			)
		})?;

	if request.expected_idempotency_key.is_some_and(|expected| envelope.idempotency_key != expected)
	{
		return Err(WorkerError::terminal(
			ReasonCode::InvalidPackageProtocol,
			"expected idempotency key does not match the calibration source",
		));
	}

	let verified = envelope.verify_calibration_source_v4().map_err(|_| {
		WorkerError::terminal(
			ReasonCode::InvalidPackageSignature,
			"calibration source identity, content hash, or signature is invalid",
		)
	})?;
	let mut payload = verified.payload;
	let object = payload.as_object_mut().ok_or_else(|| {
		WorkerError::terminal(
			ReasonCode::InvalidPackageProtocol,
			"calibration source payload is invalid",
		)
	})?;
	let results = serde_json::from_value::<Vec<TaskResult>>(
		object.get("results").cloned().ok_or_else(|| {
			WorkerError::terminal(
				ReasonCode::InvalidPackageProtocol,
				"calibration source results are missing",
			)
		})?,
	)
	.map_err(|_| {
		WorkerError::terminal(
			ReasonCode::InvalidPackageProtocol,
			"calibration source results are invalid",
		)
	})?;

	object.insert(
		"schema_version".to_owned(),
		Value::String(CALIBRATION_RUN_PAYLOAD_TYPE.to_owned()),
	);
	object.insert("scoring_version".to_owned(), Value::String(AIQ_SCORING_VERSION.to_owned()));
	object.insert("calibration_admission_digest".to_owned(), Value::Null);
	object.insert("calibration_bank".to_owned(), Value::Null);
	object.insert(
		"terminal_attempt_lineage".to_owned(),
		serde_json::to_value(runner::terminal_attempt_lineage(&results)).map_err(|_| {
			WorkerError::terminal(
				ReasonCode::InvalidPackageProtocol,
				"calibration source lineage derivation failed",
			)
		})?,
	);

	let promoted = VerifiedSubmission {
		payload_type: CALIBRATION_RUN_PAYLOAD_TYPE.to_owned(),
		content_hash: verified.content_hash,
		signer: verified.signer,
		effective_trust: verified.effective_trust,
		payload,
	};
	let mut prepared = prepare_calibration_verification_inner(
		request,
		promoted,
		CalibrationReplayMode::PromotedSource1_0_7,
	)?;

	prepared.calibration_source_scoring_version = Some(AIQ_TASK_SCORER_VERSION.to_owned());

	Ok(prepared)
}

fn prepare_official_verification(
	request: PreparationRequest<'_>,
	verified: VerifiedSubmission,
) -> Result<PreparedVerification, WorkerError> {
	let run: RunRecord = serde_json::from_value(verified.payload).map_err(|_| {
		WorkerError::terminal(
			ReasonCode::InvalidPackageProtocol,
			"package payload is not a run record",
		)
	})?;

	validate_requested_official_admission(&run, &request)?;

	run_validation::validate_run_record(&run, Some(request.tasks)).map_err(|_| {
		WorkerError::terminal(
			ReasonCode::InvalidRunProvenance,
			"signed run does not match the controlled tasks",
		)
	})?;
	submission::validate_run_signer_binding(&run, &verified.signer.node_id).map_err(|_| {
		WorkerError::terminal(
			ReasonCode::InvalidPackageSignature,
			"package signer does not match signed run provenance",
		)
	})?;

	if request.require_production && run.synthetic {
		return Err(WorkerError::terminal(
			ReasonCode::InvalidRunProvenance,
			"local production replay cannot accept a synthetic run",
		));
	}
	if run.synthetic != request.environment.synthetic_test {
		return Err(WorkerError::terminal(
			ReasonCode::InvalidRunProvenance,
			"run synthetic policy does not match the verifier environment",
		));
	}
	if run.provenance != request.environment.expected_provenance {
		return Err(WorkerError::terminal(
			ReasonCode::InvalidRunProvenance,
			"signed run provenance does not match the verifier environment",
		));
	}

	let (replay_status, replay_scope, provider_usage) = official_replay_evidence(&run, &request)?;
	let official_calibration = validated_official_calibration(request.tasks, &run)?;
	let scores = recompute_scores(request.tasks, &run)?;
	let metadata = metadata_for(&run, request.environment)?;
	let package = VerifiedPackageIdentity {
		package_sha256: request.package_sha256.to_owned(),
		content_hash: verified.content_hash,
		signer: verified.signer,
	};
	let mut stage =
		normalization::normalize_verified_batch(&run, request.tasks, &scores, &package, &metadata)
			.map_err(|_| {
				WorkerError::terminal(
					ReasonCode::NormalizationMismatch,
					"deterministic normalization replay failed",
				)
			})?;
	let (result_efficiency, efficiency, pricing) =
		calibration_verification::build_efficiency_evidence(
			&run.results,
			&provider_usage,
			run.synthetic,
		)
		.map_err(|_| {
			WorkerError::terminal(
				ReasonCode::NormalizationMismatch,
				"deterministic efficiency recomputation failed",
			)
		})?;

	stage.result_efficiency = result_efficiency;
	stage.efficiency = efficiency;
	stage.pricing = pricing;
	stage.normalization_digest = stage.compute_normalization_digest().map_err(|_| {
		WorkerError::terminal(
			ReasonCode::NormalizationMismatch,
			"efficiency-bound normalization digest failed",
		)
	})?;

	stage.verify().map_err(|_| {
		WorkerError::terminal(
			ReasonCode::NormalizationMismatch,
			"efficiency-bound normalization validation failed",
		)
	})?;

	let attestation = request
		.signing_identity
		.attest(&stage, request.observed_unix_ms, replay_status)
		.map_err(|_| {
			WorkerError::terminal(
				ReasonCode::NormalizationMismatch,
				"verifier attestation construction failed",
			)
		})?;

	self_check_attestation(&attestation, &stage, request.signing_identity)?;

	Ok(PreparedVerification {
		evidence: PreparedEvidence::Official { stage, attestation },
		replay_scope,
		official_calibration,
		calibration_source: None,
		calibration_source_scoring_version: None,
	})
}

fn validate_requested_official_admission(
	run: &RunRecord,
	request: &PreparationRequest<'_>,
) -> Result<(), WorkerError> {
	if run.synthetic || !request.require_official_admission {
		return Ok(());
	}

	let admission = request.official_admission.ok_or_else(|| {
		WorkerError::terminal(
			ReasonCode::InvalidRunProvenance,
			"Official package has no independently verified calibration admission",
		)
	})?;

	verify_official_calibration_admission_binding(
		run,
		&admission.bundle,
		&admission.bindings,
		request.tasks,
	)
}

fn validated_official_calibration(
	tasks: &[TaskDefinition],
	run: &RunRecord,
) -> Result<Option<OfficialCalibrationDiagnostic>, WorkerError> {
	if run.synthetic {
		return Ok(None);
	}

	let diagnostic =
		scoring::diagnose_official_calibration(tasks, &run.results).map_err(|error| {
			WorkerError::terminal(
				ReasonCode::NormalizationMismatch,
				format!("Official publication calibration failed: {error}"),
			)
		})?;

	Ok(Some(diagnostic))
}

fn official_replay_evidence(
	run: &RunRecord,
	request: &PreparationRequest<'_>,
) -> Result<(ReplayStatus, &'static str, Vec<ProviderTokenUsage>), WorkerError> {
	if run.synthetic {
		return Ok((
			ReplayStatus::CommitmentsVerified,
			"commitments_verified",
			vec![runner::ProviderTokenUsage::default(); run.results.len()],
		));
	}

	let capability_validation = run.capability_validation.as_ref().ok_or_else(|| {
		WorkerError::terminal(
			ReasonCode::InvalidReplayEvidence,
			"production run lacks capability validation evidence",
		)
	})?;

	replay::verify_capability_artifacts(capability_validation, request.resolver)?;

	let provider_usage = replay::verify_production_run(
		run,
		request.tasks,
		request.resolver,
		request.evaluator_root,
		request.evaluator_runtime.ok_or_else(|| {
			WorkerError::configuration("production replay lacks an evaluator runtime")
		})?,
		request.replay_root,
		request.replay_identity,
		request.replay_jobs,
	)?;

	Ok((ReplayStatus::EvaluatorReplayed, PRODUCTION_REPLAY_SCOPE, provider_usage))
}

fn prepare_calibration_verification(
	request: PreparationRequest<'_>,
	verified: VerifiedSubmission,
) -> Result<PreparedVerification, WorkerError> {
	prepare_calibration_verification_inner(request, verified, CalibrationReplayMode::Current)
}

fn prepare_calibration_verification_inner(
	request: PreparationRequest<'_>,
	verified: VerifiedSubmission,
	mode: CalibrationReplayMode,
) -> Result<PreparedVerification, WorkerError> {
	let (run, tasks, package) = validated_calibration_source(&request, verified, mode)?;
	let provider_usage = replay::verify_production_run(
		&run,
		&tasks,
		request.resolver,
		request.evaluator_root,
		request.evaluator_runtime.ok_or_else(|| {
			WorkerError::configuration("calibration replay lacks an evaluator runtime")
		})?,
		request.replay_root,
		request.replay_identity,
		request.replay_jobs,
	)?;
	let metadata = calibration_metadata_for(&run, request.environment)?;
	let verification = match mode {
		CalibrationReplayMode::PromotedSource1_0_7 => {
			calibration_verification::verify_and_attest_calibration_source_1_0_7(
				request.signing_identity,
				&run,
				&tasks,
				&package,
				&metadata,
				&provider_usage,
				request.observed_unix_ms,
			)
		},
		CalibrationReplayMode::Current => {
			calibration_verification::verify_and_attest_calibration_run(
				request.signing_identity,
				&run,
				&tasks,
				&package,
				&metadata,
				&provider_usage,
				request.observed_unix_ms,
			)
		},
		CalibrationReplayMode::CandidateQualification => {
			calibration_verification::verify_and_attest_candidate_qualification_run(
				request.signing_identity,
				&run,
				&tasks,
				&package,
				&metadata,
				&provider_usage,
				request.observed_unix_ms,
			)
		},
	};
	let (stage, attestation) = verification.map_err(|error| {
		WorkerError::terminal(
			ReasonCode::NormalizationMismatch,
			format!(
				"calibration recomputation or verifier attestation construction failed: {error}"
			),
		)
	})?;

	verify_calibration_attestation_for_mode(&stage, &attestation, request.signing_identity, mode)?;

	Ok(PreparedVerification {
		evidence: PreparedEvidence::Calibration { stage, attestation },
		replay_scope: PRODUCTION_REPLAY_SCOPE,
		official_calibration: None,
		calibration_source: Some(run),
		calibration_source_scoring_version: Some(AIQ_TASK_SCORER_VERSION.to_owned()),
	})
}

fn validated_calibration_source(
	request: &PreparationRequest<'_>,
	verified: VerifiedSubmission,
	mode: CalibrationReplayMode,
) -> Result<(CalibrationRunRecord, Vec<TaskDefinition>, VerifiedPackageIdentity), WorkerError> {
	let run: CalibrationRunRecord = serde_json::from_value(verified.payload).map_err(|_| {
		WorkerError::terminal(
			ReasonCode::InvalidPackageProtocol,
			"package payload is not a calibration run record",
		)
	})?;
	let tasks = selected_calibration_tasks(&run, request.tasks)?;
	let validation = match mode {
		CalibrationReplayMode::Current => {
			run_validation::validate_calibration_run_record_with_tasks(&run, &tasks)
		},
		CalibrationReplayMode::PromotedSource1_0_7 => {
			run_validation::validate_calibration_source_1_0_7_with_tasks(&run, &tasks)
		},
		CalibrationReplayMode::CandidateQualification => {
			run_validation::validate_candidate_qualification_calibration_with_tasks(&run, &tasks)
		},
	};

	validation.map_err(|_| {
		WorkerError::terminal(
			ReasonCode::InvalidRunProvenance,
			"signed calibration does not match the controlled task selection",
		)
	})?;

	submission::validate_calibration_signer_binding(&run, &verified.signer.node_id).map_err(
		|_| {
			WorkerError::terminal(
				ReasonCode::InvalidPackageSignature,
				"package signer does not match signed calibration provenance",
			)
		},
	)?;

	if request.environment.synthetic_test {
		return Err(WorkerError::terminal(
			ReasonCode::InvalidRunProvenance,
			"calibration evidence requires a non-synthetic verifier environment",
		));
	}

	let mut expected_provenance =
		request.environment.expected_provenance.clone().ok_or_else(|| {
			WorkerError::terminal(
				ReasonCode::InvalidRunProvenance,
				"calibration verifier environment lacks expected provenance",
			)
		})?;

	expected_provenance.run_class = RunClass::Calibration;

	if run.provenance != expected_provenance {
		return Err(WorkerError::terminal(
			ReasonCode::InvalidRunProvenance,
			"signed calibration provenance does not match the verifier environment",
		));
	}

	let package = VerifiedPackageIdentity {
		package_sha256: request.package_sha256.to_owned(),
		content_hash: verified.content_hash,
		signer: verified.signer,
	};

	Ok((run, tasks, package))
}

fn verify_calibration_attestation_for_mode(
	stage: &CalibrationVerifiedStageV1,
	attestation: &CalibrationVerifierAttestationV1,
	identity: &VerifierSigningIdentity,
	mode: CalibrationReplayMode,
) -> Result<(), WorkerError> {
	let result = match mode {
		CalibrationReplayMode::CandidateQualification => {
			attestation.verify_candidate_qualification(stage, identity.node())
		},
		CalibrationReplayMode::Current | CalibrationReplayMode::PromotedSource1_0_7 => {
			attestation.verify(stage, identity.node())
		},
	};

	result.map_err(|_| {
		WorkerError::terminal(
			ReasonCode::NormalizationMismatch,
			"calibration verifier attestation self-check failed",
		)
	})
}

fn selected_calibration_tasks(
	run: &CalibrationRunRecord,
	tasks: &[TaskDefinition],
) -> Result<Vec<TaskDefinition>, WorkerError> {
	let mut selected = Vec::with_capacity(run.task_ids.len());
	let mut seen = BTreeSet::new();

	for task_id in &run.task_ids {
		let task = tasks.iter().find(|task| &task.task_id == task_id).ok_or_else(|| {
			WorkerError::terminal(
				ReasonCode::InvalidRunProvenance,
				"calibration selects a task absent from controlled sources",
			)
		})?;

		if !seen.insert(task_id) {
			return Err(WorkerError::terminal(
				ReasonCode::InvalidRunProvenance,
				"calibration task selection contains duplicates",
			));
		}

		selected.push(task.clone());
	}

	Ok(selected)
}

fn self_check_attestation(
	attestation: &VerifierAttestationV2,
	stage: &NormalizedBatchStage,
	identity: &VerifierSigningIdentity,
) -> Result<(), WorkerError> {
	attestation.verify(stage, identity.node()).map_err(|_| {
		WorkerError::terminal(
			ReasonCode::NormalizationMismatch,
			"verifier attestation self-check failed",
		)
	})
}

fn verify_and_write_local(
	request: PreparationRequest<'_>,
	stage_output: &Path,
	attestation_output: &Path,
) -> Result<PreparedVerification, WorkerError> {
	let stage_target = OutputTarget::new(stage_output, "stage output")?;
	let attestation_target = OutputTarget::new(attestation_output, "attestation output")?;

	if stage_target.path == attestation_target.path {
		return Err(WorkerError::configuration(
			"stage and attestation outputs must use different paths",
		));
	}

	let prepared = prepare_package_verification(request)?;

	if prepared.replay_scope != PRODUCTION_REPLAY_SCOPE {
		return Err(WorkerError::terminal(
			ReasonCode::EvaluatorReplayMismatch,
			"offline production replay did not derive evaluator_replayed",
		));
	}

	match &prepared.evidence {
		PreparedEvidence::Official { stage, attestation } => {
			if attestation.replay_status != ReplayStatus::EvaluatorReplayed {
				return Err(WorkerError::terminal(
					ReasonCode::EvaluatorReplayMismatch,
					"offline production replay did not derive evaluator_replayed",
				));
			}

			write_outputs_atomically(stage_output, attestation_output, stage, attestation)?;
		},
		PreparedEvidence::Calibration { stage, attestation } => {
			write_outputs_atomically(stage_output, attestation_output, stage, attestation)?;
		},
	}

	Ok(prepared)
}

fn verify_and_write_candidate_qualification(
	request: PreparationRequest<'_>,
	stage_output: &Path,
	attestation_output: &Path,
) -> Result<(), WorkerError> {
	let stage_target = OutputTarget::new(stage_output, "candidate qualification stage output")?;
	let attestation_target =
		OutputTarget::new(attestation_output, "candidate qualification attestation output")?;

	if stage_target.path == attestation_target.path {
		return Err(WorkerError::configuration(
			"candidate stage and attestation outputs must use different paths",
		));
	}

	let expected_verifier = request.signing_identity.node().clone();
	let prepared = prepare_candidate_qualification_verification(request)?;
	let PreparedEvidence::Calibration { stage, attestation } = &prepared.evidence else {
		return Err(WorkerError::configuration(
			"candidate qualification requires a calibration package",
		));
	};

	stage.verify_candidate_qualification().map_err(|error| {
		WorkerError::terminal(
			ReasonCode::NormalizationMismatch,
			format!("candidate qualification stage self-check failed: {error}"),
		)
	})?;
	attestation.verify_candidate_qualification(stage, &expected_verifier).map_err(|error| {
		WorkerError::terminal(
			ReasonCode::NormalizationMismatch,
			format!("candidate qualification attestation self-check failed: {error}"),
		)
	})?;

	write_outputs_atomically(stage_output, attestation_output, stage, attestation)
}

fn verify_and_write_local_with_admission(
	request: PreparationRequest<'_>,
	stage_output: &Path,
	attestation_output: &Path,
	admission_output: &Path,
	context: &OperationalAdmissionContext,
	calibration_source_1_0_7: bool,
) -> Result<(), WorkerError> {
	let stage_target = OutputTarget::new(stage_output, "stage output")?;
	let attestation_target = OutputTarget::new(attestation_output, "attestation output")?;
	let admission_target = OutputTarget::new(admission_output, "calibration admission output")?;

	if stage_target.path == attestation_target.path
		|| stage_target.path == admission_target.path
		|| attestation_target.path == admission_target.path
	{
		return Err(WorkerError::configuration(
			"stage, attestation, and calibration admission outputs must use different paths",
		));
	}

	let replay_tasks = request.tasks;
	let admission_tasks = context.tasks.as_slice();
	let signing_identity = request.signing_identity;
	let prepared = if calibration_source_1_0_7 {
		prepare_calibration_source_1_0_7_verification(request)?
	} else {
		prepare_package_verification(request)?
	};

	if prepared.replay_scope != PRODUCTION_REPLAY_SCOPE {
		return Err(WorkerError::terminal(
			ReasonCode::EvaluatorReplayMismatch,
			"offline production replay did not derive evaluator_replayed",
		));
	}

	let PreparedEvidence::Calibration { stage, attestation } = &prepared.evidence else {
		return Err(WorkerError::configuration(
			"calibration admission requires a signed calibration package",
		));
	};
	let run = prepared.calibration_source.as_ref().ok_or_else(|| {
		WorkerError::configuration("calibration admission requires a calibration payload")
	})?;
	let source_scoring_version =
		prepared.calibration_source_scoring_version.as_deref().ok_or_else(|| {
			WorkerError::configuration("calibration source scoring version is missing")
		})?;
	let replay_task_set_digest = task::task_set_hash(replay_tasks)
		.map_err(|error| WorkerError::configuration(error.to_string()))?;
	let admission_task_set_digest = task::task_set_hash(admission_tasks)
		.map_err(|error| WorkerError::configuration(error.to_string()))?;
	let replay_evaluator_digest = corpus_commitment::evaluator_digest(replay_tasks)
		.map_err(|error| WorkerError::configuration(error.to_string()))?;

	if replay_task_set_digest != admission_task_set_digest
		|| replay_task_set_digest != context.bindings.task_set_digest
		|| replay_evaluator_digest != context.bindings.evaluator_digest
	{
		return Err(WorkerError::terminal(
			ReasonCode::InvalidRunProvenance,
			"calibration replay assets do not match the current admission task and evaluator identities",
		));
	}

	let admission = calibration_verification::sign_full_calibration_admission(
		signing_identity,
		stage,
		attestation,
		admission_tasks,
		&run.results,
		source_scoring_version,
		context.bindings.clone(),
	)
	.map_err(|error| {
		WorkerError::terminal(
			ReasonCode::NormalizationMismatch,
			format!("calibration admission failed: {error}"),
		)
	})?;
	let bundle = CalibrationAdmissionBundleV3 {
		schema_version: CALIBRATION_ADMISSION_BUNDLE_SCHEMA_VERSION.to_owned(),
		stage: stage.clone(),
		attestation: attestation.clone(),
		admission,
	};

	bundle.verify(&context.bindings, admission_tasks, &run.results).map_err(|error| {
		WorkerError::terminal(
			ReasonCode::NormalizationMismatch,
			format!("calibration admission bundle failed: {error}"),
		)
	})?;

	write_admission_outputs_atomically(
		&stage_target,
		&attestation_target,
		&admission_target,
		stage,
		attestation,
		&bundle,
	)
}

fn metadata_for(
	run: &RunRecord,
	environment: &VerifierEnvironment,
) -> Result<AttestedDeploymentMetadata, WorkerError> {
	let scheduled_unix_ms = schedule_unix_ms(run)?;
	let prompt_set_digest = run
		.provenance
		.as_ref()
		.map_or_else(|| environment.prompt_set_digest.clone(), |value| value.prompt_digest.clone());

	Ok(AttestedDeploymentMetadata {
		task_set_id: environment.task_set_id.clone(),
		task_set_version: environment.task_set_version.clone(),
		benchmark_version: environment.benchmark_version.clone(),
		prompt_set_digest,
		runner_commit: environment.runner_commit.clone(),
		region: environment.region.clone(),
		scheduled_unix_ms,
		started_unix_ms: run.started_unix_ms,
		finished_unix_ms: run.finished_unix_ms,
		synthetic_test: environment.synthetic_test,
	})
}

fn calibration_metadata_for(
	run: &CalibrationRunRecord,
	environment: &VerifierEnvironment,
) -> Result<AttestedDeploymentMetadata, WorkerError> {
	Ok(AttestedDeploymentMetadata {
		task_set_id: environment.task_set_id.clone(),
		task_set_version: environment.task_set_version.clone(),
		benchmark_version: environment.benchmark_version.clone(),
		prompt_set_digest: run.provenance.prompt_digest.clone(),
		runner_commit: environment.runner_commit.clone(),
		region: environment.region.clone(),
		scheduled_unix_ms: run.schedule_slot.scheduled_unix_ms().map_err(|error| {
			WorkerError::terminal(
				ReasonCode::InvalidRunProvenance,
				format!("calibration schedule conversion failed: {error}"),
			)
		})?,
		started_unix_ms: run.started_unix_ms,
		finished_unix_ms: run.finished_unix_ms,
		synthetic_test: false,
	})
}

fn create_temporary_output(
	target: &OutputTarget,
	label: &str,
	bytes: &[u8],
) -> Result<TemporaryOutput, WorkerError> {
	for attempt in 0..32_u8 {
		let path = target.parent.join(format!(
			".{}.aiq-verifier-{}-{label}-{attempt}.tmp",
			target.file_name,
			process::id()
		));
		let mut options = OpenOptions::new();

		options.write(true).create_new(true);
		#[cfg(unix)]
		options.mode(0o600);

		match options.open(&path) {
			Ok(mut file) => {
				if let Err(error) = file.write_all(bytes).and_then(|()| file.sync_all()) {
					let _ = fs::remove_file(&path);

					return Err(WorkerError::configuration(format!(
						"cannot write temporary {label}: {error}"
					)));
				}

				return Ok(TemporaryOutput { path });
			},
			Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {},
			Err(error) => {
				return Err(WorkerError::configuration(format!(
					"cannot create temporary {label}: {error}"
				)));
			},
		}
	}

	Err(WorkerError::configuration(format!("cannot reserve a temporary {label} path")))
}

fn write_outputs_atomically<S, A>(
	stage_output: &Path,
	attestation_output: &Path,
	stage: &S,
	attestation: &A,
) -> Result<(), WorkerError>
where
	S: Serialize,
	A: Serialize,
{
	let stage_target = OutputTarget::new(stage_output, "stage output")?;
	let attestation_target = OutputTarget::new(attestation_output, "attestation output")?;

	if stage_target.path == attestation_target.path {
		return Err(WorkerError::configuration(
			"stage and attestation outputs must use different paths",
		));
	}

	let stage_bytes = serialize_json_output(stage, "stage")?;
	let attestation_bytes = serialize_json_output(attestation, "attestation")?;

	publish_outputs_atomically(
		&[
			(&stage_target, "stage", stage_bytes.as_slice()),
			(&attestation_target, "attestation", attestation_bytes.as_slice()),
		],
		|_| Ok(()),
	)
}

fn write_admission_outputs_atomically<S, A, B>(
	stage_target: &OutputTarget,
	attestation_target: &OutputTarget,
	admission_target: &OutputTarget,
	stage: &S,
	attestation: &A,
	admission: &B,
) -> Result<(), WorkerError>
where
	S: Serialize,
	A: Serialize,
	B: Serialize,
{
	let stage_bytes = serialize_json_output(stage, "stage")?;
	let attestation_bytes = serialize_json_output(attestation, "attestation")?;
	let admission_bytes = serialize_json_output(admission, "calibration admission")?;

	publish_outputs_atomically(
		&[
			(stage_target, "stage", stage_bytes.as_slice()),
			(attestation_target, "attestation", attestation_bytes.as_slice()),
			(admission_target, "calibration admission", admission_bytes.as_slice()),
		],
		|_| Ok(()),
	)
}

fn serialize_json_output<T>(value: &T, label: &str) -> Result<Vec<u8>, WorkerError>
where
	T: Serialize,
{
	let mut bytes = serde_json::to_vec_pretty(value).map_err(|error| {
		WorkerError::configuration(format!("{label} serialization failed: {error}"))
	})?;

	bytes.push(b'\n');

	Ok(bytes)
}

fn publish_outputs_atomically<F>(
	outputs: &[(&OutputTarget, &str, &[u8])],
	mut fault: F,
) -> Result<(), WorkerError>
where
	F: FnMut(PublicationPoint) -> std::io::Result<()>,
{
	let temporaries = outputs
		.iter()
		.map(|(target, label, bytes)| create_temporary_output(target, label, bytes))
		.collect::<Result<Vec<_>, _>>()?;
	let mut installed = Vec::with_capacity(outputs.len());

	for (index, ((target, label, _), temporary)) in
		outputs.iter().zip(temporaries.iter()).enumerate()
	{
		let install = fault(PublicationPoint::Install(index))
			.and_then(|()| fs::hard_link(&temporary.path, &target.path));

		if let Err(error) = install {
			let mut rollback_errors = Vec::new();

			for installed_index in installed.iter().rev().copied() {
				let (installed_target, installed_label, _) = outputs[installed_index];

				if let Err(rollback_error) = fault(PublicationPoint::Rollback(installed_index)) {
					rollback_errors.push(format!(
						"{installed_label} rollback injection failed: {rollback_error}"
					));
				}
				if let Err(rollback_error) = fs::remove_file(&installed_target.path) {
					rollback_errors.push(format!(
						"cannot roll back {installed_label} output: {rollback_error}"
					));
				}
			}

			let rollback = if rollback_errors.is_empty() {
				String::new()
			} else {
				format!("; rollback failures: {}", rollback_errors.join("; "))
			};

			return Err(WorkerError::configuration(format!(
				"cannot install {label} output without overwrite: {error}{rollback}"
			)));
		}

		installed.push(index);
	}

	Ok(())
}

fn write_create_new_json<T>(
	target: &OutputTarget,
	value: &T,
	label: &str,
) -> Result<(), WorkerError>
where
	T: Serialize,
{
	let bytes = serialize_json_output(value, label)?;
	let temporary = create_temporary_output(target, label, &bytes)?;

	fs::hard_link(&temporary.path, &target.path).map_err(|error| {
		WorkerError::configuration(format!(
			"cannot install {label} output without overwrite: {error}"
		))
	})
}

fn regular_file_bytes(path: &Path, label: &str, max_bytes: usize) -> Result<Vec<u8>, WorkerError> {
	let metadata = fs::symlink_metadata(path)
		.map_err(|error| WorkerError::configuration(format!("{label}: {error}")))?;

	if metadata.file_type().is_symlink()
		|| !metadata.is_file()
		|| usize::try_from(metadata.len()).ok().is_none_or(|size| size > max_bytes)
	{
		return Err(WorkerError::configuration(format!("{label} must be a bounded regular file")));
	}

	fs::read(path).map_err(|error| WorkerError::configuration(format!("{label}: {error}")))
}

fn has_one_link(metadata: &std::fs::Metadata) -> bool {
	#[cfg(unix)]
	{
		metadata.nlink() == 1
	}

	#[cfg(not(unix))]
	{
		let _ = metadata;

		true
	}
}

fn read_owned_regular_input(
	path: &Path,
	label: &str,
	max_bytes: usize,
) -> Result<RegularInput, WorkerError> {
	if path == Path::new("-") {
		return Err(WorkerError::configuration(format!("{label} must be a regular-file path")));
	}

	let before = fs::symlink_metadata(path)
		.map_err(|error| WorkerError::configuration(format!("{label}: {error}")))?;

	if before.file_type().is_symlink()
		|| !before.is_file()
		|| !has_one_link(&before)
		|| usize::try_from(before.len()).ok().is_none_or(|size| size > max_bytes)
	{
		return Err(WorkerError::configuration(format!(
			"{label} must be a bounded, single-link regular file"
		)));
	}

	let canonical_path = fs::canonicalize(path)
		.map_err(|error| WorkerError::configuration(format!("{label}: {error}")))?;
	let mut options = OpenOptions::new();

	options.read(true);
	#[cfg(unix)]
	options.custom_flags(O_NOFOLLOW);

	let mut file = options
		.open(path)
		.map_err(|error| WorkerError::configuration(format!("{label}: {error}")))?;
	let opened =
		file.metadata().map_err(|error| WorkerError::configuration(format!("{label}: {error}")))?;
	let identity = FileIdentity::from_metadata(&opened);
	let after_open = fs::symlink_metadata(path)
		.map_err(|error| WorkerError::configuration(format!("{label}: {error}")))?;

	if !opened.is_file()
		|| !has_one_link(&opened)
		|| !identity.matches(&before)
		|| after_open.file_type().is_symlink()
		|| !identity.matches(&after_open)
	{
		return Err(WorkerError::configuration(format!(
			"{label} changed identity while it was opened"
		)));
	}

	let mut bytes = Vec::new();

	Read::by_ref(&mut file)
		.take(u64::try_from(max_bytes).unwrap_or(u64::MAX) + 1)
		.read_to_end(&mut bytes)
		.map_err(|error| WorkerError::configuration(format!("{label}: {error}")))?;

	let after_read =
		file.metadata().map_err(|error| WorkerError::configuration(format!("{label}: {error}")))?;
	let path_after_read = fs::symlink_metadata(path)
		.map_err(|error| WorkerError::configuration(format!("{label}: {error}")))?;

	if bytes.len() > max_bytes
		|| u64::try_from(bytes.len()).ok() != Some(after_read.len())
		|| !has_one_link(&after_read)
		|| !identity.matches(&after_read)
		|| path_after_read.file_type().is_symlink()
		|| !identity.matches(&path_after_read)
	{
		return Err(WorkerError::configuration(format!("{label} changed while it was read")));
	}

	Ok(RegularInput { bytes, canonical_path })
}

fn protected_executable_digest(path: &Path, label: &str) -> Result<String, WorkerError> {
	if !path.is_absolute() {
		return Err(WorkerError::configuration(format!("{label} must use an absolute path")));
	}

	let input = read_owned_regular_input(path, label, 256 * 1_024 * 1_024)?;
	let metadata = fs::metadata(&input.canonical_path)
		.map_err(|error| WorkerError::configuration(format!("{label}: {error}")))?;

	#[cfg(unix)]
	if metadata.permissions().mode() & 0o111 == 0 {
		return Err(WorkerError::configuration(format!("{label} must be executable")));
	}

	Ok(format!("sha256:{}", hex::encode(Sha256::digest(&input.bytes))))
}

fn git_output(root: &Path, arguments: &[&str], label: &str) -> Result<String, WorkerError> {
	let output = Command::new("git")
		.arg("-C")
		.arg(root)
		.args(arguments)
		.env_clear()
		.env("PATH", "/usr/bin:/bin:/usr/local/bin")
		.output()
		.map_err(|error| WorkerError::configuration(format!("{label}: {error}")))?;

	if !output.status.success() {
		return Err(WorkerError::configuration(format!("{label} failed")));
	}

	String::from_utf8(output.stdout)
		.map(|value| value.trim().to_owned())
		.map_err(|_| WorkerError::configuration(format!("{label} returned non-UTF-8 output")))
}

fn validate_detached_source_identity(
	root: &Path,
	expected_commit: &str,
) -> Result<String, WorkerError> {
	if !valid_git_oid(expected_commit) {
		return Err(WorkerError::configuration("expected source commit is invalid"));
	}

	let symbolic = Command::new("git")
		.arg("-C")
		.arg(root)
		.args(["symbolic-ref", "-q", "HEAD"])
		.env_clear()
		.env("PATH", "/usr/bin:/bin:/usr/local/bin")
		.status()
		.map_err(|error| WorkerError::configuration(format!("source Git HEAD: {error}")))?;

	if symbolic.success() {
		return Err(WorkerError::configuration("admission source root must use detached HEAD"));
	}

	let commit = git_output(root, &["rev-parse", "--verify", "HEAD"], "source Git commit")?;
	let tree = git_output(root, &["rev-parse", "--verify", "HEAD^{tree}"], "source Git tree")?;
	let status = git_output(
		root,
		&["status", "--porcelain=v1", "--untracked-files=all"],
		"source Git status",
	)?;

	if commit != expected_commit || !status.is_empty() || !valid_git_oid(&tree) {
		return Err(WorkerError::configuration(
			"admission source root does not match the exact clean detached source identity",
		));
	}

	Ok(tree)
}

fn validated_build_receipt(
	path: &Path,
	expected_digest: &str,
) -> Result<(FinalBuildReceipt, String), WorkerError> {
	let input = read_owned_regular_input(path, "final-build receipt", MAX_SUBMISSION_BYTES)?;
	let digest = format!("sha256:{}", hex::encode(Sha256::digest(&input.bytes)));

	if !valid_sha256_digest(expected_digest) || digest != expected_digest {
		return Err(WorkerError::configuration(
			"final-build receipt does not match the independently expected digest",
		));
	}

	let receipt: FinalBuildReceipt = serde_json::from_slice(&input.bytes)
		.map_err(|error| WorkerError::configuration(format!("final-build receipt: {error}")))?;

	if receipt.schema_version != "aiq.final-build-receipt.v2"
		|| !valid_git_oid(&receipt.source_commit)
		|| !valid_git_oid(&receipt.source_tree)
		|| !valid_sha256_digest(&receipt.runner_executable_sha256)
		|| !valid_sha256_digest(&receipt.verifier_executable_sha256)
		|| !valid_sha256_digest(&receipt.codex_executable_sha256)
		|| !valid_sha256_digest(&receipt.codex_code_mode_host_sha256)
	{
		return Err(WorkerError::configuration("final-build receipt is invalid"));
	}

	Ok((receipt, digest))
}

fn validate_final_build_receipt_bindings(
	receipt: &FinalBuildReceipt,
	bindings: &CalibrationAdmissionBindings,
) -> Result<(), WorkerError> {
	if receipt.source_commit != bindings.runner_commit
		|| receipt.source_tree != bindings.runner_source_tree
		|| receipt.runner_executable_sha256 != bindings.runner_executable_digest
		|| receipt.verifier_executable_sha256 != bindings.verifier_executable_digest
		|| receipt.codex_executable_sha256 != bindings.codex_executable_digest
		|| receipt.codex_code_mode_host_sha256 != bindings.codex_code_mode_host_digest
	{
		return Err(WorkerError::configuration(
			"operational admission inputs do not match frozen signed provenance",
		));
	}

	Ok(())
}

fn is_canonical_millisecond_utc(value: &str) -> bool {
	let bytes = value.as_bytes();
	let separators =
		[(4, b'-'), (7, b'-'), (10, b'T'), (13, b':'), (16, b':'), (19, b'.'), (23, b'Z')];

	if !(bytes.len() == 24
		&& separators.iter().all(|(index, expected)| bytes[*index] == *expected)
		&& bytes.iter().enumerate().all(|(index, byte)| {
			separators.iter().any(|(separator, _)| *separator == index) || byte.is_ascii_digit()
		})) {
		return false;
	}

	let number = |range: Range<usize>| {
		str::from_utf8(&bytes[range]).ok().and_then(|part| part.parse::<u32>().ok())
	};
	let (Some(year), Some(month), Some(day), Some(hour), Some(minute), Some(second)) =
		(number(0..4), number(5..7), number(8..10), number(11..13), number(14..16), number(17..19))
	else {
		return false;
	};
	let leap = year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400));
	let days = match month {
		1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
		4 | 6 | 9 | 11 => 30,
		2 if leap => 29,
		2 => 28,
		_ => return false,
	};

	year != 0 && (1..=days).contains(&day) && hour < 24 && minute < 60 && second < 60
}

fn valid_sha256_digest(value: &str) -> bool {
	value.strip_prefix("sha256:").is_some_and(|hex| {
		hex.len() == 64
			&& hex.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
	})
}

fn valid_git_oid(value: &str) -> bool {
	value.len() == 40
		&& value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn approved_operational_nodes(
	path: &Path,
	expected_reference_sha256: &str,
) -> Result<(NodeIdentity, NodeIdentity, String, String), WorkerError> {
	let input = read_owned_regular_input(path, "production reference", MAX_SUBMISSION_BYTES)?;
	let production_reference_sha256 =
		format!("sha256:{}", hex::encode(Sha256::digest(&input.bytes)));

	if !valid_sha256_digest(expected_reference_sha256)
		|| production_reference_sha256 != expected_reference_sha256
	{
		return Err(WorkerError::configuration(
			"production reference does not match the independently expected digest",
		));
	}

	let reference: OperationalProductionReference = serde_json::from_slice(&input.bytes)
		.map_err(|error| WorkerError::configuration(format!("production reference: {error}")))?;

	if reference.schema_version != "aiq.production-reference.v1"
		|| reference.nodes.len() != 3
		|| !is_canonical_millisecond_utc(&reference.published_at)
	{
		return Err(WorkerError::configuration("production reference is invalid"));
	}

	let corpus_commitment_sha256 = protocol::canonical_hash(&reference.corpus_commitment)
		.map_err(|error| WorkerError::configuration(format!("production reference: {error}")))?;
	let mut identities = BTreeMap::new();

	for node in reference.nodes {
		let expected_operator_class = if node.role == "verifier" { "verifier" } else { "official" };
		let expected_trust_tier =
			if node.role == "verifier" { "independently_reproduced" } else { "trusted_verified" };

		if node.schema_version != "aiq.public-node-identity.v1"
			|| !matches!(node.role.as_str(), "runner" | "verifier" | "publisher")
			|| node.signature_algorithm != "ed25519"
			|| node.status != "active"
			|| node.trust_tier != expected_trust_tier
			|| node.operator_class != expected_operator_class
			|| node.capabilities.as_slice() != [node.role.as_str()]
			|| node.signature_status != "verified"
			|| node.display_name.is_empty()
			|| node.source.is_empty()
			|| node.provenance.is_empty()
			|| node.synthetic
			|| !node.public_visible
			|| !node.node_id.strip_prefix("node_").is_some_and(|value| {
				value.len() == 64
					&& value
						.bytes()
						.all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
			}) || node.public_key.len() != 64
			|| !node
				.public_key
				.bytes()
				.all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
		{
			return Err(WorkerError::configuration("production reference node is invalid"));
		}

		let public = hex::decode(&node.public_key)
			.map_err(|_| WorkerError::configuration("production reference node is invalid"))?;
		let expected = format!("node_{}", hex::encode(Sha256::digest(public)));
		let expected_fingerprint = expected.replacen("node_", "sha256:", 1);

		if node.node_id != expected
			|| node.key_fingerprint != expected_fingerprint
			|| identities
				.insert(
					node.role,
					NodeIdentity { node_id: node.node_id, public_key: node.public_key },
				)
				.is_some()
		{
			return Err(WorkerError::configuration("production reference node is invalid"));
		}
	}

	let runner = identities
		.remove("runner")
		.ok_or_else(|| WorkerError::configuration("production reference omits runner"))?;
	let verifier = identities
		.remove("verifier")
		.ok_or_else(|| WorkerError::configuration("production reference omits verifier"))?;
	let publisher = identities
		.remove("publisher")
		.ok_or_else(|| WorkerError::configuration("production reference omits publisher"))?;

	if runner == verifier || runner == publisher || verifier == publisher {
		return Err(WorkerError::configuration("production reference identities must be distinct"));
	}

	Ok((runner, verifier, production_reference_sha256, corpus_commitment_sha256))
}

fn read_regular_json<T>(path: &Path, label: &str) -> Result<T, WorkerError>
where
	T: DeserializeOwned,
{
	let bytes = regular_file_bytes(path, label, MAX_SUBMISSION_BYTES)?;

	serde_json::from_slice(&bytes)
		.map_err(|error| WorkerError::configuration(format!("{label}: {error}")))
}

fn load_local_tasks(root: &Path) -> Result<Vec<TaskDefinition>, WorkerError> {
	for entry in fs::read_dir(root)
		.map_err(|error| WorkerError::configuration(format!("task root: {error}")))?
	{
		let entry =
			entry.map_err(|error| WorkerError::configuration(format!("task root: {error}")))?;
		let metadata = fs::symlink_metadata(entry.path()).map_err(|error| {
			WorkerError::configuration(format!("controlled task entry: {error}"))
		})?;

		if metadata.file_type().is_symlink() {
			return Err(WorkerError::configuration(
				"controlled task directory must not contain symbolic links",
			));
		}
	}

	load_tasks(root)
}

fn roots_overlap(left: &Path, right: &Path) -> bool {
	left == right || left.starts_with(right) || right.starts_with(left)
}

fn validate_evaluator_bindings(
	tasks: &[TaskDefinition],
	evaluator_root: &Path,
	evaluator_runtime: &EvaluatorRuntime,
) -> Result<(), WorkerError> {
	for task in tasks {
		if let Some(binding) = task.evaluator.as_ref().and_then(|value| value.external.as_ref()) {
			let mut candidate = evaluator_root.to_owned();

			for component in binding.executable_ref.components() {
				candidate.push(component);

				if fs::symlink_metadata(&candidate)
					.is_ok_and(|metadata| metadata.file_type().is_symlink())
				{
					return Err(WorkerError::configuration(
						"controlled evaluator path must not contain symbolic links",
					));
				}
			}

			binding
				.validate_registry(evaluator_root)
				.and_then(|()| binding.validate_runtime(evaluator_runtime))
				.map_err(|error| WorkerError::configuration(error.to_string()))?;
		}
	}

	Ok(())
}

fn run_worker(cli: Cli) -> Result<(), WorkerError> {
	let token = Secret::from_environment(&cli.token_env)?;
	let signing_key = signing_key_from_environment(&cli.signing_key_env)?;
	let environment: VerifierEnvironment =
		read_regular_json(&cli.environment, "verifier environment")?;

	validate_environment(&environment)?;

	let environment_sha256 = protocol::canonical_hash(&environment).map_err(|error| {
		WorkerError::configuration(format!("environment digest failed: {error}"))
	})?;
	let tasks = load_configured_tasks(
		cli.tasks.as_deref(),
		cli.synthetic_demo_tasks,
		environment.synthetic_test,
	)?;
	let worker_binary_sha256 = executable_digest()?;
	let endpoint = validate_endpoint(&cli.endpoint, cli.allow_loopback_http)?;
	let replay_root = controlled_root(&cli.replay_root, "replay root")?;
	let evaluator_root = cli
		.evaluator_root
		.as_deref()
		.map(|path| controlled_root(path, "evaluator root"))
		.transpose()?
		.unwrap_or_else(|| replay_root.clone());
	let evaluator_runtime = cli
		.evaluator_runtime
		.as_deref()
		.map(EvaluatorRuntime::resolve)
		.transpose()
		.map_err(|error| WorkerError::configuration(error.to_string()))?;

	if let Some(path) = cli.corpus_commitment.as_deref() {
		let expected = environment.expected_provenance.as_ref().ok_or_else(|| {
			WorkerError::configuration(
				"production verifier environment lacks expected corpus provenance",
			)
		})?;

		corpus_commitment::validate_evaluator_runtime_commitment(
			path,
			&expected.corpus_commitment_sha256,
			evaluator_runtime.as_ref().ok_or_else(|| {
				WorkerError::configuration("production verifier requires --evaluator-runtime")
			})?,
			cli.codex_toolchain_root.as_deref().ok_or_else(|| {
				WorkerError::configuration("production verifier requires --codex-toolchain-root")
			})?,
		)
		.map_err(|error| WorkerError::configuration(error.to_string()))?;
	}

	validate_worker_evaluator_bindings(&tasks, &evaluator_root, evaluator_runtime.as_ref())?;

	if !cli.synthetic_demo_tasks
		&& (evaluator_root == replay_root
			|| evaluator_root.starts_with(&replay_root)
			|| replay_root.starts_with(&evaluator_root))
	{
		return Err(WorkerError::configuration(
			"evaluator and replay roots must be separate directory trees",
		));
	}

	let signing_identity = VerifierSigningIdentity::from_secret(signing_key);
	let official_admission = if cli.synthetic_demo_tasks {
		None
	} else {
		let context = operational_admission_context(
			worker_operational_admission_paths(&cli)?,
			&signing_identity,
		)?;

		Some(load_verified_official_admission(
			cli.calibration_admission.as_deref().ok_or_else(|| {
				WorkerError::configuration("production worker calibration admission is missing")
			})?,
			context,
			&tasks,
		)?)
	};
	let worker = Worker {
		transport: UreqTransport::new(
			Duration::from_secs(cli.timeout_seconds),
			cli.allow_loopback_http,
			cli.replay_jobs,
		),
		endpoint,
		token,
		signing_identity,
		tasks,
		environment,
		environment_sha256,
		worker_binary_sha256,
		lease_seconds: cli.lease_seconds,
		max_retries: cli.max_retries,
		backoff: Duration::from_millis(cli.backoff_ms),
		evaluator_root,
		evaluator_runtime,
		official_admission,
		replay_root,
		replay_jobs: cli.replay_jobs,
		#[cfg(test)]
		preparation_calls: AtomicUsize::new(0),
	};

	worker.run(cli.max_claims, cli.max_idle_polls)
}

fn validate_worker_evaluator_bindings(
	tasks: &[TaskDefinition],
	evaluator_root: &Path,
	evaluator_runtime: Option<&EvaluatorRuntime>,
) -> Result<(), WorkerError> {
	for task in tasks {
		if let Some(binding) =
			task.evaluator.as_ref().and_then(|evaluator| evaluator.external.as_ref())
		{
			let runtime = evaluator_runtime.ok_or_else(|| {
				WorkerError::configuration("external tasks require --evaluator-runtime")
			})?;

			binding
				.validate_registry(evaluator_root)
				.and_then(|()| binding.validate_runtime(runtime))
				.map_err(|error| WorkerError::configuration(error.to_string()))?;
		}
	}

	Ok(())
}

fn operational_admission_context(
	paths: OperationalAdmissionPaths<'_>,
	signing_identity: &VerifierSigningIdentity,
) -> Result<OperationalAdmissionContext, WorkerError> {
	let OperationalAdmissionAssets {
		tasks,
		environment,
		evaluator_runtime,
		corpus,
		model_toolchain,
		target_source_tree,
		task_set_digest,
		evaluator_digest,
	} = operational_admission_assets(paths)?;
	let runner_executable_digest =
		protected_executable_digest(paths.runner_binary, "frozen runner binary")?;
	let codex_executable_digest = protected_executable_digest(paths.codex_binary, "Codex binary")?;
	let codex_code_mode_host_path = corpus_commitment::codex_code_mode_host_path(
		paths
			.codex_binary
			.to_str()
			.ok_or_else(|| WorkerError::configuration("Codex binary path is invalid"))?,
	)
	.map_err(|error| WorkerError::configuration(error.to_string()))?;
	let codex_code_mode_host_digest =
		protected_executable_digest(&codex_code_mode_host_path, "Codex code-mode host")?;
	let verifier_executable_digest =
		corpus_commitment::current_executable_digest("verifier executable")
			.map_err(|error| WorkerError::configuration(error.to_string()))?;
	let (
		approved_runner,
		approved_verifier,
		production_reference_sha256,
		reference_corpus_commitment_sha256,
	) = approved_operational_nodes(
		paths.production_reference,
		paths.expected_production_reference_sha256,
	)?;
	let (build_receipt, build_receipt_sha256) =
		validated_build_receipt(paths.build_receipt, paths.expected_build_receipt_sha256)?;
	let expected = environment.expected_provenance.as_ref().ok_or_else(|| {
		WorkerError::configuration("production verifier environment lacks expected provenance")
	})?;

	if !valid_git_oid(&environment.runner_commit)
		|| reference_corpus_commitment_sha256 != corpus.canonical_sha256()
		|| corpus.canonical_sha256() != expected.corpus_commitment_sha256
		|| corpus.release_id() != expected.corpus_release_id
		|| corpus.catalog_digest() != expected.catalog_digest
		|| corpus.source_manifest_digest() != expected.source_manifest_digest
		|| task_set_digest != expected.task_set_digest
		|| evaluator_digest != expected.evaluator_digest
		|| runner_executable_digest != expected.runner_executable_digest
		|| codex_executable_digest != expected.codex_executable_digest
		|| codex_code_mode_host_digest != expected.codex_code_mode_host_digest
		|| signing_identity.node() != &approved_verifier
	{
		return Err(WorkerError::configuration(
			"operational admission inputs do not match frozen signed provenance",
		));
	}

	let bindings = CalibrationAdmissionBindings {
		production_reference_sha256,
		build_receipt_sha256,
		approved_runner,
		approved_verifier,
		corpus_commitment_sha256: corpus.canonical_sha256().to_owned(),
		source_manifest_digest: corpus.source_manifest_digest().to_owned(),
		runner_commit: environment.runner_commit.clone(),
		runner_source_tree: target_source_tree,
		task_set_digest,
		evaluator_digest,
		model_toolchain_digest: model_toolchain.digest().to_owned(),
		evaluator_runtime_digest: evaluator_runtime.executable_digest().to_owned(),
		runner_executable_digest,
		codex_executable_digest,
		codex_code_mode_host_digest,
		verifier_executable_digest,
	};

	validate_final_build_receipt_bindings(&build_receipt, &bindings)?;

	Ok(OperationalAdmissionContext { bindings, tasks })
}

fn has_operational_admission_inputs(cli: &VerifyLocalCli) -> bool {
	[
		cli.admission_tasks.as_ref(),
		cli.admission_environment.as_ref(),
		cli.admission_evaluator_root.as_ref(),
		cli.admission_corpus_commitment.as_ref(),
		cli.admission_evaluator_runtime.as_ref(),
		cli.admission_codex_toolchain_root.as_ref(),
		cli.admission_corpus_source_root.as_ref(),
		cli.admission_target_source_root.as_ref(),
		cli.admission_runner_binary.as_ref(),
		cli.admission_codex_binary.as_ref(),
		cli.production_reference.as_ref(),
		cli.build_receipt.as_ref(),
	]
	.into_iter()
	.any(|value| value.is_some())
		|| cli.expected_production_reference_sha256.is_some()
		|| cli.expected_build_receipt_sha256.is_some()
}

fn required_path<'a>(value: &'a Option<PathBuf>, label: &str) -> Result<&'a Path, WorkerError> {
	value.as_deref().ok_or_else(|| WorkerError::configuration(format!("{label} is missing")))
}

fn required_text<'a>(value: &'a Option<String>, label: &str) -> Result<&'a str, WorkerError> {
	value.as_deref().ok_or_else(|| WorkerError::configuration(format!("{label} is missing")))
}

fn local_operational_admission_paths(
	cli: &VerifyLocalCli,
) -> Result<OperationalAdmissionPaths<'_>, WorkerError> {
	Ok(OperationalAdmissionPaths {
		tasks: required_path(&cli.admission_tasks, "admission task root")?,
		environment: required_path(&cli.admission_environment, "admission environment")?,
		evaluator_root: required_path(&cli.admission_evaluator_root, "admission evaluator root")?,
		corpus_commitment: required_path(
			&cli.admission_corpus_commitment,
			"admission corpus commitment",
		)?,
		evaluator_runtime: required_path(
			&cli.admission_evaluator_runtime,
			"admission evaluator runtime",
		)?,
		codex_toolchain_root: required_path(
			&cli.admission_codex_toolchain_root,
			"admission model toolchain root",
		)?,
		corpus_source_root: required_path(
			&cli.admission_corpus_source_root,
			"admission corpus source root",
		)?,
		target_source_root: required_path(
			&cli.admission_target_source_root,
			"admission target source root",
		)?,
		runner_binary: required_path(&cli.admission_runner_binary, "admission runner binary")?,
		codex_binary: required_path(&cli.admission_codex_binary, "admission Codex binary")?,
		production_reference: required_path(&cli.production_reference, "production reference")?,
		expected_production_reference_sha256: required_text(
			&cli.expected_production_reference_sha256,
			"expected production reference digest",
		)?,
		build_receipt: required_path(&cli.build_receipt, "final-build receipt")?,
		expected_build_receipt_sha256: required_text(
			&cli.expected_build_receipt_sha256,
			"expected final-build receipt digest",
		)?,
	})
}

fn worker_operational_admission_paths(
	cli: &Cli,
) -> Result<OperationalAdmissionPaths<'_>, WorkerError> {
	Ok(OperationalAdmissionPaths {
		tasks: required_path(&cli.tasks, "task root")?,
		environment: &cli.environment,
		evaluator_root: required_path(&cli.evaluator_root, "evaluator root")?,
		corpus_commitment: required_path(&cli.corpus_commitment, "corpus commitment")?,
		evaluator_runtime: required_path(&cli.evaluator_runtime, "evaluator runtime")?,
		codex_toolchain_root: required_path(&cli.codex_toolchain_root, "model toolchain root")?,
		corpus_source_root: required_path(&cli.corpus_source_root, "corpus source root")?,
		target_source_root: required_path(&cli.target_source_root, "target source root")?,
		runner_binary: required_path(&cli.runner_binary, "runner binary")?,
		codex_binary: required_path(&cli.codex_binary, "Codex binary")?,
		production_reference: required_path(&cli.production_reference, "production reference")?,
		expected_production_reference_sha256: required_text(
			&cli.expected_production_reference_sha256,
			"expected production reference digest",
		)?,
		build_receipt: required_path(&cli.build_receipt, "final-build receipt")?,
		expected_build_receipt_sha256: required_text(
			&cli.expected_build_receipt_sha256,
			"expected final-build receipt digest",
		)?,
	})
}

fn renewal_operational_admission_paths(
	cli: &RenewCalibrationAdmissionCli,
) -> OperationalAdmissionPaths<'_> {
	OperationalAdmissionPaths {
		tasks: &cli.tasks,
		environment: &cli.environment,
		evaluator_root: &cli.evaluator_root,
		corpus_commitment: &cli.corpus_commitment,
		evaluator_runtime: &cli.evaluator_runtime,
		codex_toolchain_root: &cli.codex_toolchain_root,
		corpus_source_root: &cli.corpus_source_root,
		target_source_root: &cli.target_source_root,
		runner_binary: &cli.runner_binary,
		codex_binary: &cli.codex_binary,
		production_reference: &cli.production_reference,
		expected_production_reference_sha256: &cli.expected_production_reference_sha256,
		build_receipt: &cli.build_receipt,
		expected_build_receipt_sha256: &cli.expected_build_receipt_sha256,
	}
}

fn load_verified_official_admission(
	path: &Path,
	context: OperationalAdmissionContext,
	tasks: &[TaskDefinition],
) -> Result<VerifiedOfficialCalibrationAdmission, WorkerError> {
	let bundle: CalibrationAdmissionBundleV3 =
		read_regular_json(path, "calibration admission bundle")?;
	let task_set_digest = task::task_set_hash(tasks)
		.map_err(|error| WorkerError::configuration(error.to_string()))?;
	let admission_task_set_digest = task::task_set_hash(&context.tasks)
		.map_err(|error| WorkerError::configuration(error.to_string()))?;

	if task_set_digest != admission_task_set_digest
		|| bundle.verify_for_official(&context.bindings, tasks).is_err()
	{
		return Err(WorkerError::configuration(
			"calibration admission does not match current verifier authority",
		));
	}

	Ok(VerifiedOfficialCalibrationAdmission { bundle, bindings: context.bindings })
}

fn validate_official_calibration_admission(
	cli: &VerifyLocalCli,
	package_bytes: &[u8],
	tasks: &[TaskDefinition],
	context: Option<&OperationalAdmissionContext>,
) -> Result<Option<VerifiedOfficialCalibrationAdmission>, WorkerError> {
	let envelope: SubmissionEnvelope = serde_json::from_slice(package_bytes).map_err(|_| {
		WorkerError::terminal(
			ReasonCode::InvalidPackageProtocol,
			"package is not a valid result envelope",
		)
	})?;

	if envelope.payload_type != RUN_PAYLOAD_TYPE {
		if cli.calibration_admission.is_some() {
			return Err(WorkerError::configuration(
				"calibration admission input is valid only for an Official package",
			));
		}

		return Ok(None);
	}

	let admission_path = cli.calibration_admission.as_deref().ok_or_else(|| {
		WorkerError::configuration(
			"Official verify-local requires a private calibration admission bundle",
		)
	})?;
	let context = context.ok_or_else(|| {
		WorkerError::configuration("Official calibration admission authority is missing")
	})?;
	let bundle: CalibrationAdmissionBundleV3 =
		read_regular_json(admission_path, "calibration admission bundle")?;
	let run: RunRecord = serde_json::from_value(envelope.payload).map_err(|_| {
		WorkerError::terminal(
			ReasonCode::InvalidPackageProtocol,
			"package payload is not a run record",
		)
	})?;
	let task_set_digest = task::task_set_hash(tasks)
		.map_err(|error| WorkerError::configuration(error.to_string()))?;
	let admission_task_set_digest = task::task_set_hash(&context.tasks)
		.map_err(|error| WorkerError::configuration(error.to_string()))?;

	if task_set_digest != admission_task_set_digest {
		return Err(WorkerError::configuration(
			"Official task root differs from calibration admission authority",
		));
	}

	verify_official_calibration_admission_binding(&run, &bundle, &context.bindings, tasks)?;

	Ok(Some(VerifiedOfficialCalibrationAdmission { bundle, bindings: context.bindings.clone() }))
}

fn verify_official_calibration_admission_binding(
	run: &RunRecord,
	bundle: &CalibrationAdmissionBundleV3,
	bindings: &CalibrationAdmissionBindings,
	tasks: &[TaskDefinition],
) -> Result<(), WorkerError> {
	if bundle.verify_for_official(bindings, tasks).is_err() {
		return Err(WorkerError::terminal(
			ReasonCode::InvalidRunProvenance,
			"calibration admission signature or issuance binding is invalid",
		));
	}

	let bundle_digest = protocol::canonical_hash(&bundle).map_err(|_| {
		WorkerError::terminal(
			ReasonCode::InvalidRunProvenance,
			"calibration admission digest cannot be recomputed",
		)
	})?;

	if run.calibration_admission_digest.as_ref() != Some(&bundle_digest)
		|| run.calibration_bank.as_ref() != Some(&bundle.admission.claims.calibration_bank)
	{
		return Err(WorkerError::terminal(
			ReasonCode::InvalidRunProvenance,
			"Official run does not match the independently verified calibration admission",
		));
	}

	Ok(())
}

fn validate_package_official_admission_before_replay(
	package_bytes: &[u8],
	tasks: &[TaskDefinition],
	admission: Option<&VerifiedOfficialCalibrationAdmission>,
) -> Result<(), WorkerError> {
	let envelope: SubmissionEnvelope = serde_json::from_slice(package_bytes).map_err(|_| {
		WorkerError::terminal(
			ReasonCode::InvalidPackageProtocol,
			"package is not a valid result envelope",
		)
	})?;

	if envelope.payload_type != RUN_PAYLOAD_TYPE {
		return Ok(());
	}

	let run: RunRecord = serde_json::from_value(envelope.payload).map_err(|_| {
		WorkerError::terminal(
			ReasonCode::InvalidPackageProtocol,
			"package payload is not a run record",
		)
	})?;

	if run.synthetic {
		return Ok(());
	}

	let admission = admission.ok_or_else(|| {
		WorkerError::terminal(
			ReasonCode::InvalidRunProvenance,
			"Official package has no independently verified calibration admission",
		)
	})?;

	verify_official_calibration_admission_binding(
		&run,
		&admission.bundle,
		&admission.bindings,
		tasks,
	)
}

fn operational_admission_assets(
	paths: OperationalAdmissionPaths<'_>,
) -> Result<OperationalAdmissionAssets, WorkerError> {
	let tasks_root = controlled_root(paths.tasks, "admission task root")?;
	let tasks = load_local_tasks(&tasks_root)?;
	let environment: VerifierEnvironment =
		read_regular_json(paths.environment, "admission verifier environment")?;

	validate_environment(&environment)?;

	if environment.synthetic_test || environment.expected_provenance.is_none() {
		return Err(WorkerError::configuration(
			"admission requires a production verifier environment",
		));
	}

	let evaluator_root = controlled_root(paths.evaluator_root, "admission evaluator root")?;
	let evaluator_runtime = EvaluatorRuntime::resolve(paths.evaluator_runtime)
		.map_err(|error| WorkerError::configuration(error.to_string()))?;
	let toolchain_root =
		controlled_root(paths.codex_toolchain_root, "admission model toolchain root")?;

	validate_evaluator_bindings(&tasks, &evaluator_root, &evaluator_runtime)?;

	let (corpus, target_source_tree) = validate_operational_source_authorities(
		paths.corpus_commitment,
		paths.corpus_source_root,
		paths.target_source_root,
		&tasks,
		&environment.runner_commit,
	)?;

	corpus
		.validate_evaluator_runtime(&evaluator_runtime)
		.map_err(|error| WorkerError::configuration(error.to_string()))?;

	let model_toolchain = corpus
		.validate_model_toolchain(&toolchain_root, &evaluator_runtime)
		.map_err(|error| WorkerError::configuration(error.to_string()))?;
	let task_set_digest = task::task_set_hash(&tasks)
		.map_err(|error| WorkerError::configuration(error.to_string()))?;
	let evaluator_digest = corpus_commitment::evaluator_digest(&tasks)
		.map_err(|error| WorkerError::configuration(error.to_string()))?;

	Ok(OperationalAdmissionAssets {
		tasks,
		environment,
		evaluator_runtime,
		corpus,
		model_toolchain,
		target_source_tree,
		task_set_digest,
		evaluator_digest,
	})
}

fn validate_operational_source_authorities(
	corpus_commitment_path: &Path,
	corpus_source_root_path: &Path,
	target_source_root_path: &Path,
	tasks: &[TaskDefinition],
	runner_commit: &str,
) -> Result<(ValidatedCorpusCommitment, String), WorkerError> {
	let corpus_source_root =
		controlled_root(corpus_source_root_path, "admission corpus source root")?;
	let target_source_root =
		controlled_root(target_source_root_path, "admission target source root")?;
	let target_source_tree = validate_detached_source_identity(&target_source_root, runner_commit)?;
	let corpus = corpus_commitment::validate_core_corpus_commitment(
		corpus_commitment_path,
		tasks,
		&corpus_source_root,
	)
	.map_err(|error| WorkerError::configuration(error.to_string()))?;

	Ok((corpus, target_source_tree))
}

fn run_renew_calibration_admission(cli: RenewCalibrationAdmissionCli) -> Result<(), WorkerError> {
	let output = OutputTarget::new(&cli.output, "renewed calibration admission output")?;
	let signing_identity =
		VerifierSigningIdentity::from_secret(signing_key_from_environment(&cli.signing_key_env)?);
	let target = operational_admission_context(
		renewal_operational_admission_paths(&cli),
		&signing_identity,
	)?;
	let source: CalibrationAdmissionBundleV3 =
		read_regular_json(&cli.source_bundle, "source calibration admission bundle")?;
	let renewed = calibration_verification::renew_calibration_admission(
		&signing_identity,
		&source,
		target.bindings,
		&target.tasks,
	)
	.map_err(|error| {
		WorkerError::configuration(format!("calibration admission renewal failed: {error}"))
	})?;

	write_create_new_json(&output, &renewed, "renewed calibration admission")
}

fn run_verify_local(cli: VerifyLocalCli) -> Result<(), WorkerError> {
	let stage_target = OutputTarget::new(&cli.stage_output, "stage output")?;
	let attestation_target = OutputTarget::new(&cli.attestation_output, "attestation output")?;

	if stage_target.path == attestation_target.path {
		return Err(WorkerError::configuration(
			"stage and attestation outputs must use different paths",
		));
	}

	let package_bytes = regular_file_bytes(&cli.package, "signed package", MAX_SUBMISSION_BYTES)?;
	let package_sha256 = hex::encode(Sha256::digest(&package_bytes));
	let environment: VerifierEnvironment =
		read_regular_json(&cli.environment, "verifier environment")?;

	if cli.candidate_qualification {
		validate_candidate_qualification_environment(&environment)?;
	} else {
		validate_environment(&environment)?;
	}
	if environment.synthetic_test || environment.expected_provenance.is_none() {
		return Err(WorkerError::configuration(
			"verify-local requires a production verifier environment",
		));
	}

	let tasks_root = controlled_root(&cli.tasks, "task root")?;
	let tasks = load_local_tasks(&tasks_root)?;
	let evaluator_root = controlled_root(&cli.evaluator_root, "evaluator root")?;
	let replay_root = controlled_root(&cli.replay_root, "replay root")?;
	let artifact_resolver = LocalArtifactResolver::new(&cli.artifact_root)?;
	let toolchain_root = controlled_root(&cli.codex_toolchain_root, "model toolchain root")?;

	validate_local_root_separation(
		&artifact_resolver,
		&evaluator_root,
		&replay_root,
		&toolchain_root,
	)?;

	let evaluator_runtime = EvaluatorRuntime::resolve(&cli.evaluator_runtime)
		.map_err(|error| WorkerError::configuration(error.to_string()))?;

	validate_local_replay_assets(
		&cli,
		&tasks,
		&environment,
		&evaluator_root,
		&evaluator_runtime,
		&toolchain_root,
	)?;

	let signing_identity =
		VerifierSigningIdentity::from_secret(signing_key_from_environment(&cli.signing_key_env)?);
	let admission_mode = cli.admission_output.is_some() || cli.calibration_admission.is_some();

	if cli.candidate_qualification && admission_mode {
		return Err(WorkerError::configuration(
			"candidate qualification cannot issue or consume an Official calibration admission",
		));
	}
	if has_operational_admission_inputs(&cli) && !admission_mode {
		return Err(WorkerError::configuration(
			"operational admission inputs require admission issuance or Official consumption",
		));
	}

	let admission = if admission_mode {
		Some(operational_admission_context(
			local_operational_admission_paths(&cli)?,
			&signing_identity,
		)?)
	} else {
		None
	};
	let official_admission = if cli.candidate_qualification {
		None
	} else {
		validate_official_calibration_admission(&cli, &package_bytes, &tasks, admission.as_ref())?
	};
	let request = PreparationRequest {
		package_bytes: &package_bytes,
		package_sha256: &package_sha256,
		expected_idempotency_key: None,
		replay_identity: &format!("local-{package_sha256}"),
		resolver: &artifact_resolver,
		tasks: &tasks,
		environment: &environment,
		evaluator_root: &evaluator_root,
		evaluator_runtime: Some(&evaluator_runtime),
		replay_root: &replay_root,
		signing_identity: &signing_identity,
		official_admission: official_admission.as_ref(),
		require_official_admission: true,
		observed_unix_ms: cli.observed_unix_ms,
		require_production: true,
		replay_jobs: cli.replay_jobs,
	};

	if cli.candidate_qualification {
		verify_and_write_candidate_qualification(
			request,
			&cli.stage_output,
			&cli.attestation_output,
		)
	} else if let (Some(output), Some(context)) =
		(cli.admission_output.as_deref(), admission.as_ref())
	{
		verify_and_write_local_with_admission(
			request,
			&cli.stage_output,
			&cli.attestation_output,
			output,
			context,
			cli.calibration_source_1_0_7,
		)
	} else {
		verify_and_write_local(request, &cli.stage_output, &cli.attestation_output).map(|_| ())
	}
}

fn validate_local_replay_assets(
	cli: &VerifyLocalCli,
	tasks: &[TaskDefinition],
	environment: &VerifierEnvironment,
	evaluator_root: &Path,
	evaluator_runtime: &EvaluatorRuntime,
	toolchain_root: &Path,
) -> Result<(), WorkerError> {
	let _corpus_bytes =
		regular_file_bytes(&cli.corpus_commitment, "corpus commitment", MAX_SUBMISSION_BYTES)?;
	let expected = environment.expected_provenance.as_ref().ok_or_else(|| {
		WorkerError::configuration("production verifier environment lacks expected provenance")
	})?;

	if cli.candidate_qualification {
		let source_root = controlled_root(
			cli.candidate_source_root.as_deref().ok_or_else(|| {
				WorkerError::configuration(
					"candidate qualification requires --candidate-source-root",
				)
			})?,
			"candidate source root",
		)?;
		let corpus = corpus_commitment::validate_candidate_core_corpus_commitment_v1_1_0(
			&cli.corpus_commitment,
			tasks,
			&source_root,
		)
		.map_err(|error| WorkerError::configuration(error.to_string()))?;

		corpus
			.validate_evaluator_runtime(evaluator_runtime)
			.and_then(|()| {
				corpus.validate_model_toolchain(toolchain_root, evaluator_runtime).map(|_| ())
			})
			.map_err(|error| WorkerError::configuration(error.to_string()))?;

		let task_set_digest = task::task_set_hash(tasks)
			.map_err(|error| WorkerError::configuration(error.to_string()))?;
		let evaluator_digest = corpus_commitment::evaluator_digest(tasks)
			.map_err(|error| WorkerError::configuration(error.to_string()))?;

		if corpus.canonical_sha256() != expected.corpus_commitment_sha256
			|| corpus.catalog_digest() != expected.catalog_digest
			|| corpus.source_manifest_digest() != expected.source_manifest_digest
			|| task_set_digest != expected.task_set_digest
			|| evaluator_digest != expected.evaluator_digest
		{
			return Err(WorkerError::configuration(
				"candidate corpus, source, task, or evaluator identity differs from the verifier environment",
			));
		}
	} else {
		corpus_commitment::validate_evaluator_runtime_commitment(
			&cli.corpus_commitment,
			&expected.corpus_commitment_sha256,
			evaluator_runtime,
			toolchain_root,
		)
		.map_err(|error| WorkerError::configuration(error.to_string()))?;
	}

	validate_evaluator_bindings(tasks, evaluator_root, evaluator_runtime)
}

fn validate_local_root_separation(
	artifact_resolver: &LocalArtifactResolver,
	evaluator_root: &Path,
	replay_root: &Path,
	toolchain_root: &Path,
) -> Result<(), WorkerError> {
	for (left_label, left, right_label, right) in [
		("artifact root", artifact_resolver.root.as_path(), "evaluator root", evaluator_root),
		("artifact root", artifact_resolver.root.as_path(), "replay root", replay_root),
		("artifact root", artifact_resolver.root.as_path(), "model toolchain root", toolchain_root),
		("evaluator root", evaluator_root, "replay root", replay_root),
		("model toolchain root", toolchain_root, "replay root", replay_root),
	] {
		if roots_overlap(left, right) {
			return Err(WorkerError::configuration(format!(
				"{left_label} and {right_label} must be separate directory trees"
			)));
		}
	}

	Ok(())
}

#[allow(clippy::too_many_arguments)]
fn configure_source_evaluator_set(
	tasks_path: &Path,
	environment_path: &Path,
	evaluator_root_path: &Path,
	corpus_commitment: &Path,
	evaluator_runtime_path: &Path,
	toolchain_root_path: &Path,
	label: &str,
) -> Result<ConfiguredSourceEvaluatorSet, WorkerError> {
	let environment: VerifierEnvironment =
		read_regular_json(environment_path, &format!("{label} verifier environment"))?;

	validate_environment(&environment)?;

	if environment.synthetic_test || environment.expected_provenance.is_none() {
		return Err(WorkerError::configuration(format!(
			"{label} requires a production verifier environment"
		)));
	}

	let tasks_root = controlled_root(tasks_path, &format!("{label} task root"))?;
	let tasks = load_local_tasks(&tasks_root)?;
	let evaluator_root = controlled_root(evaluator_root_path, &format!("{label} evaluator root"))?;
	let toolchain_root =
		controlled_root(toolchain_root_path, &format!("{label} model toolchain root"))?;
	let evaluator_runtime = EvaluatorRuntime::resolve(evaluator_runtime_path)
		.map_err(|error| WorkerError::configuration(error.to_string()))?;
	let expected = environment.expected_provenance.as_ref().ok_or_else(|| {
		WorkerError::configuration(format!("{label} environment lacks expected provenance"))
	})?;

	corpus_commitment::validate_evaluator_runtime_commitment(
		corpus_commitment,
		&expected.corpus_commitment_sha256,
		&evaluator_runtime,
		&toolchain_root,
	)
	.map_err(|error| WorkerError::configuration(error.to_string()))?;

	validate_evaluator_bindings(&tasks, &evaluator_root, &evaluator_runtime)?;

	let task_set_digest = task::task_set_hash(&tasks)
		.map_err(|error| WorkerError::configuration(error.to_string()))?;
	let evaluator_digest = corpus_commitment::evaluator_digest(&tasks)
		.map_err(|error| WorkerError::configuration(error.to_string()))?;

	if task_set_digest != expected.task_set_digest || evaluator_digest != expected.evaluator_digest
	{
		return Err(WorkerError::configuration(format!(
			"{label} tasks do not match the configured corpus identity"
		)));
	}

	let corpus_commitment_sha256 = expected.corpus_commitment_sha256.clone();

	Ok(ConfiguredSourceEvaluatorSet {
		environment,
		set: ConfiguredEvaluatorSet {
			tasks,
			evaluator_root,
			evaluator_runtime,
			toolchain_root,
			corpus_commitment_sha256,
			task_set_digest,
			evaluator_digest,
		},
	})
}

#[allow(clippy::too_many_arguments)]
fn configure_candidate_evaluator_set(
	tasks_path: &Path,
	source_root_path: &Path,
	evaluator_root_path: &Path,
	corpus_commitment_path: &Path,
	evaluator_runtime_path: &Path,
	toolchain_root_path: &Path,
) -> Result<ConfiguredCandidateEvaluatorSet, WorkerError> {
	let tasks_root = controlled_root(tasks_path, "candidate task root")?;
	let source_root = controlled_root(source_root_path, "candidate source root")?;
	let evaluator_root = controlled_root(evaluator_root_path, "candidate evaluator root")?;
	let toolchain_root = controlled_root(toolchain_root_path, "candidate model toolchain root")?;
	let evaluator_runtime = EvaluatorRuntime::resolve(evaluator_runtime_path)
		.map_err(|error| WorkerError::configuration(error.to_string()))?;
	let tasks = load_local_tasks(&tasks_root)?;
	let corpus = corpus_commitment::validate_candidate_core_corpus_commitment_v1_1_0(
		corpus_commitment_path,
		&tasks,
		&source_root,
	)
	.map_err(|error| WorkerError::configuration(error.to_string()))?;

	corpus
		.validate_evaluator_runtime(&evaluator_runtime)
		.and_then(|()| {
			corpus.validate_model_toolchain(&toolchain_root, &evaluator_runtime).map(|_| ())
		})
		.map_err(|error| WorkerError::configuration(error.to_string()))?;

	validate_evaluator_bindings(&tasks, &evaluator_root, &evaluator_runtime)?;

	let task_set_digest = task::task_set_hash(&tasks)
		.map_err(|error| WorkerError::configuration(error.to_string()))?;
	let evaluator_digest = corpus_commitment::evaluator_digest(&tasks)
		.map_err(|error| WorkerError::configuration(error.to_string()))?;

	Ok(ConfiguredCandidateEvaluatorSet {
		source_root,
		set: ConfiguredEvaluatorSet {
			tasks,
			evaluator_root,
			evaluator_runtime,
			toolchain_root,
			corpus_commitment_sha256: corpus.canonical_sha256().to_owned(),
			task_set_digest,
			evaluator_digest,
		},
	})
}

fn read_diagnostic_source_package(path: &Path) -> Result<DiagnosticSourcePackage, WorkerError> {
	let package_bytes = regular_file_bytes(path, "signed package", MAX_SUBMISSION_BYTES)?;
	let sha256 = hex::encode(Sha256::digest(&package_bytes));
	let envelope: SubmissionEnvelope = serde_json::from_slice(&package_bytes).map_err(|_| {
		WorkerError::terminal(
			ReasonCode::InvalidPackageProtocol,
			"package is not a valid result envelope",
		)
	})?;
	let verified = envelope.verify(&BTreeSet::new()).map_err(|_| {
		WorkerError::terminal(
			ReasonCode::InvalidPackageSignature,
			"package identity, content hash, or signature is invalid",
		)
	})?;

	if verified.payload_type != RUN_PAYLOAD_TYPE {
		return Err(WorkerError::terminal(
			ReasonCode::InvalidPackageProtocol,
			"diagnostic rescore requires an Official source run package",
		));
	}

	let run: RunRecord = serde_json::from_value(verified.payload).map_err(|_| {
		WorkerError::terminal(
			ReasonCode::InvalidPackageProtocol,
			"package payload is not a run record",
		)
	})?;

	submission::validate_run_signer_binding(&run, &verified.signer.node_id).map_err(|_| {
		WorkerError::terminal(
			ReasonCode::InvalidPackageSignature,
			"package signer does not match source run provenance",
		)
	})?;

	Ok(DiagnosticSourcePackage { run, sha256 })
}

fn validate_diagnostic_roots(
	source: &ConfiguredSourceEvaluatorSet,
	candidate: &ConfiguredCandidateEvaluatorSet,
	artifact_resolver: &LocalArtifactResolver,
	replay_root: &Path,
) -> Result<(), WorkerError> {
	for (label, root) in [
		("source evaluator root", source.set.evaluator_root.as_path()),
		("source model toolchain root", source.set.toolchain_root.as_path()),
		("candidate source root", candidate.source_root.as_path()),
		("candidate evaluator root", candidate.set.evaluator_root.as_path()),
		("candidate model toolchain root", candidate.set.toolchain_root.as_path()),
	] {
		if roots_overlap(root, replay_root) || roots_overlap(root, &artifact_resolver.root) {
			return Err(WorkerError::configuration(format!(
				"{label} must be separate from the artifact and replay roots"
			)));
		}
	}

	if roots_overlap(&artifact_resolver.root, replay_root) {
		return Err(WorkerError::configuration(
			"artifact and replay roots must be separate directory trees",
		));
	}

	Ok(())
}

fn validate_diagnostic_source_run(
	run: &RunRecord,
	source: &ConfiguredSourceEvaluatorSet,
	artifact_resolver: &LocalArtifactResolver,
) -> Result<usize, WorkerError> {
	run_validation::validate_run_record(run, Some(&source.set.tasks)).map_err(|_| {
		WorkerError::terminal(
			ReasonCode::InvalidRunProvenance,
			"source run does not match its controlled tasks",
		)
	})?;

	if run.synthetic || run.provenance.as_ref() != source.environment.expected_provenance.as_ref() {
		return Err(WorkerError::terminal(
			ReasonCode::InvalidRunProvenance,
			"source run is not the expected non-synthetic matrix",
		));
	}

	let failure_count =
		run.results.iter().filter(|result| result.status == ResultStatus::Failed).count();
	let capability_validation = run.capability_validation.as_ref().ok_or_else(|| {
		WorkerError::terminal(
			ReasonCode::InvalidReplayEvidence,
			"source run lacks capability validation evidence",
		)
	})?;

	replay::verify_capability_artifacts(capability_validation, artifact_resolver)?;

	Ok(failure_count)
}

fn run_diagnose_rescore(cli: DiagnoseRescoreCli) -> Result<(), WorkerError> {
	let output_target = OutputTarget::new(&cli.output, "diagnostic output")?;
	let source_package = read_diagnostic_source_package(&cli.package)?;
	let run = &source_package.run;
	let source = configure_source_evaluator_set(
		&cli.source_tasks,
		&cli.source_environment,
		&cli.source_evaluator_root,
		&cli.source_corpus_commitment,
		&cli.source_evaluator_runtime,
		&cli.source_codex_toolchain_root,
		"source",
	)?;
	let candidate = configure_candidate_evaluator_set(
		&cli.candidate_tasks,
		&cli.candidate_source_root,
		&cli.candidate_evaluator_root,
		&cli.candidate_corpus_commitment,
		&cli.candidate_evaluator_runtime,
		&cli.candidate_codex_toolchain_root,
	)?;
	let artifact_resolver = LocalArtifactResolver::new(&cli.artifact_root)?;
	let replay_root = controlled_root(&cli.replay_root, "replay root")?;

	validate_diagnostic_roots(&source, &candidate, &artifact_resolver, &replay_root)?;

	let failure_count = validate_diagnostic_source_run(run, &source, &artifact_resolver)?;

	replay::verify_production_run(
		run,
		&source.set.tasks,
		&artifact_resolver,
		&source.set.evaluator_root,
		&source.set.evaluator_runtime,
		&replay_root,
		&format!("diagnostic-source-{}", source_package.sha256),
		cli.replay_jobs,
	)?;

	let rescored = replay::diagnose_rescore_run(
		run,
		&candidate.set.tasks,
		&artifact_resolver,
		&candidate.set.evaluator_root,
		&candidate.set.evaluator_runtime,
		&replay_root,
		&format!("diagnostic-candidate-{}", source_package.sha256),
		cli.replay_jobs,
	)?;
	let (diagnostic_results, cells) =
		materialize_diagnostic_results(run, &candidate.set.tasks, &rescored.evaluator_results)?;
	let official_calibration =
		scoring::diagnose_official_calibration(&candidate.set.tasks, &diagnostic_results).map_err(
			|error| {
				WorkerError::terminal(
					ReasonCode::NormalizationMismatch,
					format!("candidate Official calibration diagnosis failed: {error}"),
				)
			},
		)?;
	let report = DiagnosticRescoreReport {
		schema_version: "aiq.diagnostic-rescore.v1",
		classification: "historical_candidate_evaluator_diagnostic_non_official",
		official_eligible: FalseOnly,
		ranking_eligible: FalseOnly,
		source_package_sha256: format!("sha256:{}", source_package.sha256),
		source_run_id: run.run_id.clone(),
		source_corpus_commitment_sha256: source.set.corpus_commitment_sha256,
		candidate_corpus_commitment_sha256: candidate.set.corpus_commitment_sha256,
		candidate_task_set_digest: candidate.set.task_set_digest,
		candidate_evaluator_digest: candidate.set.evaluator_digest,
		replay_scope: "source_verified_and_candidate_evaluator_replayed",
		result_count: cells.len(),
		replayed_result_count: cells.len() - failure_count,
		preserved_runtime_failure_count: failure_count,
		cells,
		official_calibration,
	};

	write_create_new_json(&output_target, &report, "diagnostic")
}

fn materialize_diagnostic_results(
	run: &RunRecord,
	candidate_tasks: &[TaskDefinition],
	evaluator_results: &[Option<EvaluationResult>],
) -> Result<(Vec<TaskResult>, Vec<DiagnosticRescoreCell>), WorkerError> {
	if evaluator_results.len() != run.results.len() {
		return Err(WorkerError::terminal(
			ReasonCode::EvaluatorReplayMismatch,
			"candidate evaluator results are not aligned with the source matrix",
		));
	}

	let tasks = candidate_tasks
		.iter()
		.map(|task| (task.task_id.as_str(), task))
		.collect::<BTreeMap<_, _>>();
	let mut diagnostic_results = Vec::with_capacity(run.results.len());
	let mut cells = Vec::with_capacity(run.results.len());

	for (source, candidate_result) in run.results.iter().zip(evaluator_results) {
		let task = tasks.get(source.task_id.as_str()).ok_or_else(|| {
			WorkerError::terminal(
				ReasonCode::InvalidReplayEvidence,
				"candidate task mapping is incomplete",
			)
		})?;
		let mut diagnostic = source.clone();

		diagnostic.result_id.clear();
		diagnostic.task_version.clone_from(&task.task_version);

		diagnostic.task_hash =
			task.content_hash().map_err(|error| WorkerError::configuration(error.to_string()))?;

		let (evaluation, score, preserved_runtime_failure) = match candidate_result {
			Some(result) if source.status == ResultStatus::Completed => {
				let evaluation = match result.outcome {
					EvaluatorOutcome::Correct => runner::EvaluationOutcome::Correct,
					EvaluatorOutcome::Partial => runner::EvaluationOutcome::Partial,
					EvaluatorOutcome::Incorrect => runner::EvaluationOutcome::Incorrect,
				};

				diagnostic.evaluation = evaluation;
				diagnostic.task_score = Some(result.score);
				diagnostic.failure = None;

				(evaluation, Some(result.score), false)
			},
			None if source.status == ResultStatus::Failed
				&& source.evaluation == runner::EvaluationOutcome::NotEvaluated
				&& source.task_score.is_none()
				&& source.failure.is_some() =>
			{
				(diagnostic.evaluation, None, true)
			},
			_ => {
				return Err(WorkerError::terminal(
					ReasonCode::EvaluatorReplayMismatch,
					"candidate outcomes do not preserve source runtime failures",
				));
			},
		};

		cells.push(DiagnosticRescoreCell {
			task_id: source.task_id.clone(),
			model: source.model,
			source_status: source.status,
			source_evaluation: source.evaluation,
			source_task_score: source.task_score,
			candidate_evaluation: evaluation,
			candidate_task_score: score,
			preserved_runtime_failure,
		});
		diagnostic_results.push(diagnostic);
	}

	Ok((diagnostic_results, cells))
}

fn run_validate_environment(cli: ValidateEnvironmentCli) -> Result<(), WorkerError> {
	let environment: VerifierEnvironment =
		read_regular_json(&cli.environment, "verifier environment")?;

	validate_environment(&environment)?;

	let digest = protocol::canonical_hash(&environment).map_err(|error| {
		WorkerError::configuration(format!("environment digest failed: {error}"))
	})?;

	println!("verifier environment is structurally and semantically self-consistent: {digest}");

	Ok(())
}

fn run_verify_qualification(cli: VerifyQualificationCli) -> Result<(), WorkerError> {
	if cli.stages.len() != 3 || cli.attestations.len() != 3 {
		return Err(WorkerError::configuration(
			"verify-qualification requires exactly three --stage and three --attestation inputs",
		));
	}

	let artifact: BenchmarkQualificationArtifact =
		read_regular_json(&cli.artifact, "qualification artifact")?;
	let manifest: BenchmarkQualificationManifest =
		read_regular_json(&cli.manifest, "qualification manifest")?;
	let catalog_value: Value = read_regular_json(&cli.catalog, "candidate catalog")?;
	let catalog = candidate_catalog::validate_candidate_catalog(&catalog_value)
		.map_err(|error| WorkerError::configuration(error.to_string()))?;
	let stages = cli
		.stages
		.iter()
		.map(|path| {
			read_regular_json::<CalibrationVerifiedStageV1>(path, "candidate qualification stage")
		})
		.collect::<Result<Vec<_>, _>>()?;
	let attestations = cli
		.attestations
		.iter()
		.map(|path| {
			read_regular_json::<CalibrationVerifierAttestationV1>(
				path,
				"candidate qualification attestation",
			)
		})
		.collect::<Result<Vec<_>, _>>()?;

	benchmark_qualification::verify_qualification_artifact(
		&artifact,
		&manifest,
		&cli.expected_manifest_sha256,
		&catalog,
		&stages,
		&attestations,
	)
	.map_err(|error| WorkerError::configuration(error.to_string()))?;

	println!(
		"qualification artifact is structurally and semantically self-consistent: {}",
		artifact.claims_digest
	);

	Ok(())
}

fn operator_diagnostic_for_message(class: OperatorErrorClass, message: &str) -> OperatorDiagnostic {
	let known = match message {
		"HTTP request timed out" => Some(("http_request_timed_out", message)),
		"HTTP response body could not be read" => Some(("http_response_body_unreadable", message)),
		"HTTP response exceeds its byte limit" => Some(("http_response_too_large", message)),
		"HTTP transport failed" => Some(("http_transport_failed", message)),
		"artifact resolver is unavailable" => Some(("artifact_resolver_unavailable", message)),
		"artifact resolver authorization failed" => {
			Some(("artifact_resolver_authorization_failed", message))
		},
		"artifact retry budget exhausted" => Some(("artifact_retry_budget_exhausted", message)),
		"cannot clean claim replay directory" => Some(("claim_replay_cleanup_failed", message)),
		"cannot create claim replay directory" => Some(("claim_replay_create_failed", message)),
		"cannot restrict claim replay directory" => {
			Some(("claim_replay_permissions_failed", message))
		},
		"claim acknowledgement is unavailable" => {
			Some(("claim_acknowledgement_unavailable", message))
		},
		"claim acknowledgement returned an unknown status" => {
			Some(("claim_acknowledgement_status_unknown", message))
		},
		"claim gateway is unavailable" => Some(("claim_gateway_unavailable", message)),
		"claim lease renewal is unavailable" => Some(("claim_lease_renewal_unavailable", message)),
		"claim lease renewal returned a mismatched identity" => {
			Some(("claim_lease_renewal_identity_mismatch", message))
		},
		"claim replay directory is unavailable" => {
			Some(("claim_replay_directory_unavailable", message))
		},
		"fresh claim replay directory is unavailable" => {
			Some(("fresh_claim_replay_directory_unavailable", message))
		},
		"private object could not be fetched" => Some(("private_object_fetch_failed", message)),
		"private object storage is unavailable" => {
			Some(("private_object_storage_unavailable", message))
		},
		"rejection gateway is unavailable" => Some(("rejection_gateway_unavailable", message)),
		"resolved artifact object is unavailable" => {
			Some(("resolved_artifact_unavailable", message))
		},
		"retry budget exhausted" => Some(("retry_budget_exhausted", message)),
		"verification gateway is unavailable" => {
			Some(("verification_gateway_unavailable", message))
		},
		"claim gateway returned an invalid claim contract" => {
			Some(("claim_contract_invalid", message))
		},
		"claim replay identity is unsafe" => Some(("claim_replay_identity_unsafe", message)),
		"controlled task source is required" => Some(("controlled_task_source_missing", message)),
		"external tasks require --evaluator-runtime" => {
			Some(("evaluator_runtime_missing", message))
		},
		"controlled evaluator replay failed" => Some(("evaluator_replay_failed", message)),
		UNCONFIRMED_EVALUATOR_REPLAY_MISMATCH => {
			Some(("evaluator_replay_mismatch_unconfirmed", message))
		},
		"production replay lacks an evaluator runtime" => {
			Some(("production_evaluator_runtime_missing", message))
		},
		"production verifier requires --codex-toolchain-root" => {
			Some(("codex_toolchain_root_missing", message))
		},
		"production verifier requires --evaluator-runtime" => {
			Some(("production_evaluator_runtime_missing", message))
		},
		"system clock exceeds the supported range" => Some(("system_clock_out_of_range", message)),
		"system clock is before the Unix epoch" => Some(("system_clock_before_epoch", message)),
		"timestamp exceeds the supported range" => Some(("timestamp_out_of_range", message)),
		"verifier environment is invalid" => Some(("verifier_environment_invalid", message)),
		"verifier environment provenance is invalid" => {
			Some(("verifier_environment_provenance_invalid", message))
		},
		_ => None,
	};

	if let Some((code, detail)) = known {
		return OperatorDiagnostic::bounded(class, code, detail);
	}

	for (prefix, code) in [
		("claim gateway returned HTTP ", "claim_gateway_http_error"),
		("claim lease renewal returned HTTP ", "claim_lease_renewal_http_error"),
		("claim acknowledgement returned HTTP ", "claim_acknowledgement_http_error"),
		("rejection gateway returned HTTP ", "rejection_gateway_http_error"),
		("verification gateway returned HTTP ", "verification_gateway_http_error"),
	] {
		if let Some(status) = message.strip_prefix(prefix)
			&& status.len() == 3
			&& status.bytes().all(|byte| byte.is_ascii_digit())
		{
			return OperatorDiagnostic::bounded(class, code, format!("{prefix}{status}"));
		}
	}

	OperatorDiagnostic::bounded(class, REDACTED_ERROR_CODE, REDACTED_ERROR_DETAIL)
}

fn serialize_verification_request(
	request: &VerificationRequest<'_>,
) -> Result<Vec<u8>, WorkerError> {
	let body = serde_json::to_vec(request)
		.map_err(|error| WorkerError::configuration(error.to_string()))?;

	enforce_verification_request_bound(&body)?;

	Ok(body)
}

fn serialize_prepared_verification(
	claim: &Claim,
	prepared: &PreparedVerification,
) -> Result<Vec<u8>, WorkerError> {
	match &prepared.evidence {
		PreparedEvidence::Official { stage, attestation } => {
			serialize_verification_request(&VerificationRequest {
				claim: claim.into(),
				stage,
				attestation,
			})
		},
		PreparedEvidence::Calibration { stage, attestation } => {
			let body = serde_json::to_vec(&CalibrationVerificationRequest {
				claim: claim.into(),
				stage,
				attestation,
			})
			.map_err(|error| WorkerError::configuration(error.to_string()))?;

			enforce_verification_request_bound(&body)?;

			Ok(body)
		},
	}
}

fn verification_response_matches(body: &[u8], prepared: &PreparedVerification) -> bool {
	match &prepared.evidence {
		PreparedEvidence::Official { .. } => {
			parse_json::<VerificationGatewayResponse>(body, "verification response").is_ok_and(
				|status| {
					status.status == prepared.expected_gateway_status()
						&& status.matrix_batch_id == prepared.run_id()
						&& status.package_sha256 == prepared.package_sha256()
				},
			)
		},
		PreparedEvidence::Calibration { .. } => {
			parse_json::<CalibrationVerificationGatewayResponse>(
				body,
				"calibration verification response",
			)
			.is_ok_and(|status| {
				status.status == prepared.expected_gateway_status()
					&& status.run_id == prepared.run_id()
					&& status.package_sha256 == prepared.package_sha256()
					&& !status.official_eligible
					&& !status.ranking_eligible
			})
		},
	}
}

fn rejection_response_matches(body: &[u8], claim: &Claim) -> bool {
	let Ok(status) = parse_json::<RejectionGatewayResponse>(body, "rejection response") else {
		return false;
	};

	status.status == "rejection_recorded_not_published"
		&& !status.published
		&& status.matrix_batch_id == claim.idempotency_key
		&& status.package_sha256 == claim.package_sha256
}

fn enforce_verification_request_bound(body: &[u8]) -> Result<(), WorkerError> {
	if body.len() > MAX_VERIFICATION_REQUEST_BYTES {
		return Err(WorkerError::terminal(
			ReasonCode::NormalizationMismatch,
			"verification request exceeds the gateway byte bound",
		));
	}

	Ok(())
}

fn recompute_scores(
	tasks: &[TaskDefinition],
	run: &RunRecord,
) -> Result<Vec<ScoreReport>, WorkerError> {
	MODEL_MATRIX
		.into_iter()
		.map(|model| {
			let model_results =
				run.results.iter().filter(|result| result.model == model).collect::<Vec<_>>();
			let context = ScoreContext {
				preflight_configuration_not_applicable: model_results.iter().all(|result| {
					result.status == ResultStatus::Unsupported
						&& result.failure.as_ref().is_some_and(|failure| {
							failure.kind == FailureKind::CapabilityUnavailable
						})
				}),
				receiver_authorized_publication: false,
			};
			let score = if run.synthetic {
				scoring::score_model_with_context(
					tasks,
					&run.results,
					model,
					context,
					ScoreOptions::default(),
				)
			} else {
				scoring::score_official_model_with_bank(
					tasks,
					&run.results,
					model,
					run.calibration_bank.as_ref().ok_or_else(|| {
						WorkerError::terminal(
							ReasonCode::NormalizationMismatch,
							"Official package omits its frozen calibration bank",
						)
					})?,
					context,
					ScoreOptions::default(),
				)
			};

			score.map_err(|_| {
				WorkerError::terminal(
					ReasonCode::NormalizationMismatch,
					"deterministic score replay failed",
				)
			})
		})
		.collect()
}

fn validate_endpoint(endpoint: &str, allow_loopback_http: bool) -> Result<String, WorkerError> {
	let endpoint = endpoint.trim_end_matches('/');

	if endpoint_origin_is_allowed(endpoint, allow_loopback_http) {
		Ok(endpoint.to_owned())
	} else {
		Err(WorkerError::configuration(
			"endpoint must be an HTTPS origin; test HTTP is limited to a loopback origin",
		))
	}
}

fn parsed_uri_is_allowed(uri: &Uri, allow_loopback_http: bool) -> bool {
	let Some(authority) = uri.authority() else {
		return false;
	};

	if authority.as_str().contains('@') {
		return false;
	}

	let loopback = matches!(uri.host(), Some("localhost" | "127.0.0.1" | "::1" | "[::1]"));

	uri.scheme_str() == Some("https")
		|| (allow_loopback_http && uri.scheme_str() == Some("http") && loopback)
}

fn transport_url_is_allowed(url: &str, allow_loopback_http: bool) -> bool {
	if url.contains('#') {
		return false;
	}

	url.parse::<Uri>().is_ok_and(|uri| parsed_uri_is_allowed(&uri, allow_loopback_http))
}

fn endpoint_origin_is_allowed(endpoint: &str, allow_loopback_http: bool) -> bool {
	if endpoint.contains('#') {
		return false;
	}

	let Ok(uri) = endpoint.parse::<Uri>() else {
		return false;
	};
	let path_and_query = uri.path_and_query().map(PathAndQuery::as_str);

	parsed_uri_is_allowed(&uri, allow_loopback_http)
		&& matches!(path_and_query, None | Some("") | Some("/"))
}

fn parse_replay_jobs(value: &str) -> Result<usize, String> {
	let jobs = value
		.parse::<usize>()
		.map_err(|_| "replay jobs must be an integer between 1 and 32".to_owned())?;

	if !(1..=MAX_REPLAY_JOBS).contains(&jobs) {
		return Err("replay jobs must be between 1 and 32".to_owned());
	}

	Ok(jobs)
}

fn validate_claim(claim: &Claim) -> Result<(), WorkerError> {
	let valid_digest = |value: &str| {
		value.len() == 64
			&& value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
	};

	if !claim.idempotency_key.starts_with("run_")
		|| claim.idempotency_key.len() != 68
		|| !valid_digest(&claim.idempotency_key[4..])
		|| !valid_digest(&claim.package_sha256)
		|| claim.object_content_sha256 != claim.package_sha256
		|| claim.body_bytes == 0
		|| claim.body_bytes > MAX_SUBMISSION_BYTES
		|| !valid_uuid(&claim.inbox_id)
		|| !valid_uuid(&claim.lease_token)
		|| claim.lease_expires_at.is_empty()
		|| claim.attempt == 0
		|| claim.object_url_expires_in_seconds == 0
	{
		return Err(WorkerError::configuration("claim gateway returned an invalid claim contract"));
	}

	Ok(())
}

fn valid_uuid(value: &str) -> bool {
	let bytes = value.as_bytes();

	bytes.len() == 36
		&& bytes.get(8) == Some(&b'-')
		&& bytes.get(13) == Some(&b'-')
		&& bytes.get(18) == Some(&b'-')
		&& bytes.get(23) == Some(&b'-')
		&& bytes.get(14).is_some_and(|byte| (b'1'..=b'5').contains(byte))
		&& bytes.get(19).is_some_and(|byte| matches!(byte, b'8' | b'9' | b'a' | b'b'))
		&& bytes.iter().enumerate().all(|(index, byte)| {
			matches!(index, 8 | 13 | 18 | 23)
				|| byte.is_ascii_digit()
				|| (b'a'..=b'f').contains(byte)
		})
}

fn validate_environment(environment: &VerifierEnvironment) -> Result<(), WorkerError> {
	if verifier_environment_has_placeholders(environment) {
		return Err(WorkerError::configuration(
			"verifier environment contains placeholder commitments",
		));
	}

	if let Some(provenance) = &environment.expected_provenance {
		corpus_commitment::validate_run_provenance(
			provenance,
			&provenance.task_set_digest,
			&provenance.preflight_digest,
		)
		.map_err(|_| WorkerError::configuration("verifier environment provenance is invalid"))?;
	}

	if environment.schema_version != "aiq.verifier-environment.v2"
		|| environment.task_set_id.is_empty()
		|| environment.task_set_version.is_empty()
		|| environment.benchmark_version
			!= format!("{}@{}", environment.task_set_id, environment.task_set_version)
		|| !environment.prompt_set_digest.starts_with("sha256:")
		|| environment.prompt_set_digest.len() != 71
		|| environment.synthetic_test != environment.expected_provenance.is_none()
		|| environment.expected_provenance.as_ref().is_some_and(|provenance| {
			provenance.prompt_digest != environment.prompt_set_digest
				|| provenance.catalog_digest != AIQ_CORE_TASK_IDENTITY_SHA256
		}) || environment.runner_commit.len() < 7
		|| environment.runner_commit.len() > 40
		|| !environment.runner_commit.bytes().all(|byte| byte.is_ascii_hexdigit())
		|| !valid_identifier(&environment.region, 64)
		|| environment
			.artifact_resolver_endpoint
			.as_ref()
			.is_some_and(|url| url.ends_with('/') || !endpoint_origin_is_allowed(url, false))
	{
		return Err(WorkerError::configuration("verifier environment is invalid"));
	}

	Ok(())
}

fn validate_candidate_qualification_environment(
	environment: &VerifierEnvironment,
) -> Result<(), WorkerError> {
	if verifier_environment_has_placeholders(environment) {
		return Err(WorkerError::configuration(
			"candidate verifier environment contains placeholder commitments",
		));
	}

	let provenance = environment.expected_provenance.as_ref().ok_or_else(|| {
		WorkerError::configuration("candidate verifier environment lacks expected provenance")
	})?;

	corpus_commitment::validate_candidate_qualification_provenance_v1_1_0(
		provenance,
		&provenance.task_set_digest,
		&provenance.preflight_digest,
	)
	.map_err(|_| WorkerError::configuration("candidate verifier provenance is invalid"))?;

	if environment.schema_version != "aiq.verifier-environment.v2"
		|| environment.task_set_id != AIQ_TASK_SET_ID
		|| environment.task_set_version != CANDIDATE_TASK_SET_VERSION
		|| environment.benchmark_version
			!= format!("{}@{}", AIQ_TASK_SET_ID, candidate_catalog::CANDIDATE_TASK_SET_VERSION)
		|| environment.prompt_set_digest != provenance.prompt_digest
		|| environment.synthetic_test
		|| environment.runner_commit.len() < 7
		|| environment.runner_commit.len() > 40
		|| !environment.runner_commit.bytes().all(|byte| byte.is_ascii_hexdigit())
		|| !valid_identifier(&environment.region, 64)
		|| environment
			.artifact_resolver_endpoint
			.as_ref()
			.is_some_and(|url| url.ends_with('/') || !endpoint_origin_is_allowed(url, false))
	{
		return Err(WorkerError::configuration("candidate verifier environment is invalid"));
	}

	Ok(())
}

fn valid_identifier(value: &str, maximum_bytes: usize) -> bool {
	!value.is_empty()
		&& value.len() <= maximum_bytes
		&& value
			.bytes()
			.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn verifier_environment_has_placeholders(environment: &VerifierEnvironment) -> bool {
	if placeholder_text(&environment.task_set_id)
		|| placeholder_text(&environment.task_set_version)
		|| placeholder_text(&environment.benchmark_version)
		|| placeholder_digest(&environment.prompt_set_digest)
		|| placeholder_text(&environment.runner_commit)
		|| placeholder_text(&environment.region)
	{
		return true;
	}

	let Some(provenance) = environment.expected_provenance.as_ref() else {
		return false;
	};
	let digests = [
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
	];

	placeholder_text(&provenance.corpus_release_id)
		|| digests.into_iter().any(|value| placeholder_digest(value))
}

fn placeholder_digest(value: &str) -> bool {
	placeholder_text(value)
}

fn placeholder_text(value: &str) -> bool {
	let normalized = value.to_ascii_lowercase().replace(['-', '_', ' ', '<', '>'], "");

	normalized.starts_with("replace")
		|| normalized.contains("placeholder")
		|| normalized.starts_with("changeme")
		|| normalized == "exampleonly"
		|| normalized == "dummy"
		|| (normalized.starts_with("your") && normalized.ends_with("here"))
}

fn load_tasks(path: &Path) -> Result<Vec<TaskDefinition>, WorkerError> {
	let report = DirectoryTaskSource::new(path, Some(Visibility::Hidden)).load();

	if !report.issues.is_empty() || report.tasks.len() != 72 {
		return Err(WorkerError::configuration(
			"controlled task source must contain 72 valid hidden tasks",
		));
	}

	Ok(report.tasks)
}

fn load_configured_tasks(
	path: Option<&Path>,
	synthetic_demo_tasks: bool,
	synthetic_environment: bool,
) -> Result<Vec<TaskDefinition>, WorkerError> {
	if synthetic_demo_tasks {
		if !synthetic_environment {
			return Err(WorkerError::configuration(
				"built-in demo tasks require a synthetic verifier environment",
			));
		}

		return Ok(runner::synthetic_demo_tasks());
	}

	let path =
		path.ok_or_else(|| WorkerError::configuration("controlled task source is required"))?;

	load_tasks(path)
}

fn controlled_root(path: &Path, label: &str) -> Result<PathBuf, WorkerError> {
	let metadata = fs::symlink_metadata(path)
		.map_err(|error| WorkerError::configuration(format!("{label}: {error}")))?;

	if metadata.file_type().is_symlink() || !metadata.is_dir() {
		return Err(WorkerError::configuration(format!("{label} must be a regular directory")));
	}

	fs::canonicalize(path).map_err(|error| WorkerError::configuration(format!("{label}: {error}")))
}

fn parse_json<T>(bytes: &[u8], subject: &str) -> Result<T, WorkerError>
where
	T: DeserializeOwned,
{
	serde_json::from_slice(bytes)
		.map_err(|_| WorkerError::transient(format!("{subject} is invalid JSON")))
}

fn signing_key_from_environment(name: &str) -> Result<[u8; 32], WorkerError> {
	let secret = Secret::from_environment(name)?;

	parse_signing_key(name, secret.expose())
}

fn parse_signing_key(name: &str, value: &str) -> Result<[u8; 32], WorkerError> {
	if value.len() != 64
		|| !value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
	{
		return Err(WorkerError::configuration(format!(
			"{name} must contain exactly 64 lowercase hexadecimal characters"
		)));
	}

	let chunks = value.as_bytes().as_chunks::<2>().0;

	if chunks.first().is_some_and(|first| chunks.iter().all(|chunk| chunk == first)) {
		return Err(WorkerError::configuration(format!(
			"{name} must not use repeated placeholder key material"
		)));
	}

	let bytes = hex::decode(value).map_err(|_| {
		WorkerError::configuration(format!(
			"{name} must contain exactly 64 lowercase hexadecimal characters"
		))
	})?;

	bytes
		.try_into()
		.map_err(|_| WorkerError::configuration(format!("{name} has an invalid decoded length")))
}

fn executable_digest() -> Result<String, WorkerError> {
	let path = env::current_exe()
		.map_err(|error| WorkerError::configuration(format!("current executable: {error}")))?;
	let bytes = fs::read(path).map_err(|error| {
		WorkerError::configuration(format!("current executable digest: {error}"))
	})?;

	Ok(format!("sha256:{}", hex::encode(Sha256::digest(bytes))))
}

fn now_unix_ms() -> Result<u64, WorkerError> {
	let duration = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map_err(|_| WorkerError::configuration("system clock is before the Unix epoch"))?;

	u64::try_from(duration.as_millis())
		.map_err(|_| WorkerError::configuration("system clock exceeds the supported range"))
}

fn now_utc_timestamp() -> Result<String, WorkerError> {
	let seconds = now_unix_ms()? / 1_000;
	let (year, month, day, hour, minute, second) = utc_components(seconds)?;

	Ok(format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z"))
}

fn schedule_unix_ms(run: &RunRecord) -> Result<u64, WorkerError> {
	run.schedule_slot.scheduled_unix_ms().map_err(|error| {
		WorkerError::terminal(
			ReasonCode::InvalidRunProvenance,
			format!("production schedule conversion failed: {error}"),
		)
	})
}

fn utc_components(seconds: u64) -> Result<(i64, i64, i64, u64, u64, u64), WorkerError> {
	let days = i64::try_from(seconds / 86_400)
		.map_err(|_| WorkerError::configuration("timestamp exceeds the supported range"))?;
	let remainder = seconds % 86_400;
	let z = days + 719_468;
	let era = z.div_euclid(146_097);
	let day_of_era = z - era * 146_097;
	let year_of_era =
		(day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
	let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
	let month_prime = (5 * day_of_year + 2) / 153;
	let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
	let month = month_prime + if month_prime < 10 { 3 } else { -9 };
	let mut year = year_of_era + era * 400;

	year += i64::from(month <= 2);

	Ok((year, month, day, remainder / 3_600, remainder % 3_600 / 60, remainder % 60))
}

#[cfg(test)]
mod tests {
	use std::panic;
	#[cfg(unix)]
	use std::{
		collections::{BTreeSet, VecDeque},
		env, fs,
		io::{Read as _, Write as _},
		net::TcpListener,
		path::{Path, PathBuf},
		process,
		sync::{
			Arc, Barrier, Mutex, OnceLock,
			atomic::{AtomicBool, AtomicUsize, Ordering},
		},
		thread,
		time::{Duration, Instant, SystemTime, UNIX_EPOCH},
	};

	use clap::Parser;
	use ed25519_dalek::{Signer as _, SigningKey};
	use sha2::{Digest, Sha256};

	use crate::{
		ArtifactResolveAttemptError, ArtifactResolverClient, Claim, ClaimLease, Cli,
		DEFAULT_REPLAY_JOBS, DiagnoseRescoreCli, ErrorKind, HttpArtifactResolver, HttpResponse,
		LEASE_RENEWAL_INTERVAL, LeaseMaintenance, LocalArtifactResolver,
		MAX_OPERATOR_ERROR_DETAIL_BYTES, MAX_VERIFICATION_REQUEST_BYTES, OperatorDiagnostic,
		OperatorErrorClass, PackageDisposition, PreparationRequest, PreparedEvidence,
		PreparedVerification, RECORD_SCHEMA, REDACTED_ERROR_CODE, REDACTED_ERROR_DETAIL,
		RENEWED_LEASE_SECONDS, ReasonCode, RejectionGatewayResponse, RenewCalibrationAdmissionCli,
		Secret, Transport, UreqTransport, ValidateEnvironmentCli, VerificationGatewayResponse,
		VerificationRecord, VerifierEnvironment, VerifyLocalCli, VerifyQualificationCli, Worker,
		WorkerError, replay,
	};
	use aiq_runner::calibration_verification::{
		self, CALIBRATION_ADMISSION_BUNDLE_SCHEMA_VERSION,
		CALIBRATION_VERIFIER_ATTESTATION_SCHEMA_VERSION, CalibrationAdmissionBindings,
		CalibrationAdmissionBundleV3, CalibrationAdmissionV3, CalibrationReplayStatus,
		CalibrationVerifiedStageV1, CalibrationVerifierAttestationV1,
	};
	use aiq_runner::{
		AIQ_BENCHMARK_VERSION, AIQ_TASK_SET_ID, AIQ_TASK_SET_VERSION,
		adapter::{
			self, ArtifactReference, ArtifactSink, AuthenticationProbe, CapabilityValidation,
			CapabilityValidationReport, CapabilityValidationStatus, CliProbe, ConfigurationProbe,
			ConfigurationProbeStatus, ExecutorError, ProbeStatus,
		},
		benchmark_qualification::{
			self, BenchmarkQualificationManifest, BenchmarkQualificationStatus,
			PredeclaredQualificationChild, QualificationCandidateIdentity, QualificationCell,
			QualificationCellStatus, QualificationChildDisposition,
		},
		candidate_catalog,
		corpus_commitment::{self, RunClass, RunProvenanceCommitment},
		model::MODEL_MATRIX,
		normalization::{
			NormalizedBatchStage, ReplayStatus, VERIFIER_SIGNATURE_ALGORITHM,
			VERIFIER_SIGNATURE_VERSION, VerifierAttestationV2, VerifierSigningIdentity,
		},
		protocol::{self, NodeIdentity, SigningIdentity, TrustTier},
		resume, run_validation,
		runner::{self, CalibrationRunRecord, RunRecord, WorkspaceManifest, WorkspaceSnapshot},
		schedule::{ScheduleConfig, ScheduleOccurrence},
		scoring::{self, FalseOnly, OfficialCalibrationPolicy},
		submission,
		task::{self, EvaluatorRuntime},
	};

	static LOCAL_REPLAY_FIXTURE_SEQUENCE: AtomicUsize = AtomicUsize::new(0);

	struct FakeTransport {
		package: Vec<u8>,
		posts: Mutex<VecDeque<String>>,
		terminal_claims: Mutex<Vec<serde_json::Value>>,
		verification_request_bytes: Mutex<Vec<usize>>,
	}

	struct ArtifactTransport {
		bytes: Vec<u8>,
		kind: &'static str,
	}

	struct RetryArtifactTransport {
		bytes: Vec<u8>,
		resolver_statuses: Mutex<VecDeque<u16>>,
		object_statuses: Mutex<VecDeque<u16>>,
		resolver_calls: Mutex<usize>,
		object_calls: Mutex<usize>,
	}

	struct AckConflictTransport {
		inner: FakeTransport,
	}

	struct RetryVerificationTransport {
		package: Vec<u8>,
		verification_statuses: Mutex<VecDeque<u16>>,
		verification_bodies: Mutex<Vec<Vec<u8>>>,
		object_calls: Mutex<usize>,
		requests: Mutex<Vec<String>>,
	}

	struct TestArtifactSink;

	struct RenewalTransport {
		status: u16,
		requests: Mutex<Vec<serde_json::Value>>,
	}

	struct NoopLease;

	struct LocalReplayFixture {
		root: PathBuf,
		artifact_root: PathBuf,
		evaluator_root: PathBuf,
		replay_root: PathBuf,
		tasks: Vec<aiq_runner::task::TaskDefinition>,
		environment: VerifierEnvironment,
		evaluator_runtime: EvaluatorRuntime,
		package: Vec<u8>,
		package_sha256: String,
		evaluator_results_path: PathBuf,
		manifest_path: PathBuf,
		capability_artifact_path: PathBuf,
	}

	#[cfg(unix)]
	struct OperationalSourceFixture {
		root: PathBuf,
		corpus_source_root: PathBuf,
		corpus_source_file: PathBuf,
		target_source_root: PathBuf,
		target_source_file: PathBuf,
		corpus_commitment: PathBuf,
		tasks: Vec<task::TaskDefinition>,
		target_commit: String,
		target_tree: String,
	}

	#[cfg(unix)]
	struct PreparedOperationalSources {
		corpus_source_root: PathBuf,
		corpus_source_file: PathBuf,
		target_source_root: PathBuf,
		target_source_file: PathBuf,
		target_commit: String,
		target_tree: String,
	}

	impl ArtifactSink for TestArtifactSink {
		fn put(&self, kind: &str, bytes: &[u8]) -> Result<ArtifactReference, ExecutorError> {
			let digest = hex::encode(Sha256::digest(bytes));

			Ok(ArtifactReference {
				kind: kind.to_owned(),
				content_hash: format!("sha256:{digest}"),
				uri: format!("aiq-artifact://sha256/{digest}/{kind}"),
				bytes: u64::try_from(bytes.len())
					.map_err(|_| ExecutorError::new("fixture artifact is too large"))?,
			})
		}
	}

	impl LeaseMaintenance for NoopLease {
		fn maintain(&self) -> Result<(), WorkerError> {
			Ok(())
		}
	}

	impl Transport for RenewalTransport {
		fn post_json(
			&self,
			url: &str,
			_token: &Secret,
			body: &[u8],
		) -> Result<HttpResponse, WorkerError> {
			assert_eq!(url, "https://gateway.invalid/api/claims");

			let request: serde_json::Value = serde_json::from_slice(body)
				.map_err(|error| WorkerError::transient(error.to_string()))?;

			self.requests
				.lock()
				.map_err(|_| WorkerError::transient("renewal request lock failed"))?
				.push(request.clone());

			let is_ack = request["action"] == "ack";
			let response_body = if is_ack {
				serde_json::json!({ "status": "acknowledged" })
			} else {
				serde_json::json!({
					"status": "renewed",
					"inbox_id": request["inbox_id"],
					"lease_token": request["lease_token"],
					"lease_expires_at": "2026-07-25T12:20:00Z",
					"attempt": 1
				})
			};

			Ok(HttpResponse {
				status: if is_ack { 200 } else { self.status },
				body: serde_json::to_vec(&response_body)
					.map_err(|error| WorkerError::transient(error.to_string()))?,
			})
		}

		fn get_object(&self, _url: &str) -> Result<HttpResponse, WorkerError> {
			Err(WorkerError::transient("object download is not expected"))
		}

		fn get_artifact_object(&self, _url: &str) -> Result<HttpResponse, WorkerError> {
			Err(WorkerError::transient("artifact download is not expected"))
		}
	}

	impl Transport for ArtifactTransport {
		fn post_json(
			&self,
			url: &str,
			_token: &Secret,
			body: &[u8],
		) -> Result<HttpResponse, WorkerError> {
			assert_eq!(url, "https://gateway.invalid/api/artifacts/resolve");

			let request: serde_json::Value = serde_json::from_slice(body)
				.map_err(|error| WorkerError::transient(error.to_string()))?;

			assert_eq!(request["inbox_id"], "inbox");
			assert_eq!(request["lease_token"], "lease");

			let digest = hex::encode(Sha256::digest(&self.bytes));

			Ok(HttpResponse {
				status: 200,
				body: serde_json::to_vec(&serde_json::json!({
					"artifact": {
						"kind": self.kind,
						"content_sha256": digest,
						"bytes": self.bytes.len(),
						"url": "https://storage.invalid/signed",
						"url_expires_in_seconds": 120
					}
				}))
				.map_err(|error| WorkerError::transient(error.to_string()))?,
			})
		}

		fn get_object(&self, _url: &str) -> Result<HttpResponse, WorkerError> {
			Err(WorkerError::transient("package download is not expected"))
		}

		fn get_artifact_object(&self, url: &str) -> Result<HttpResponse, WorkerError> {
			assert_eq!(url, "https://storage.invalid/signed");

			Ok(HttpResponse { status: 200, body: self.bytes.clone() })
		}
	}

	impl Transport for RetryArtifactTransport {
		fn post_json(
			&self,
			url: &str,
			_token: &Secret,
			_body: &[u8],
		) -> Result<HttpResponse, WorkerError> {
			assert_eq!(url, "https://gateway.invalid/api/artifacts/resolve");

			*self.resolver_calls.lock().expect("resolver calls") += 1;

			let status = self
				.resolver_statuses
				.lock()
				.expect("resolver statuses")
				.pop_front()
				.unwrap_or(200);
			let digest = hex::encode(Sha256::digest(&self.bytes));
			let body = if status == 200 {
				serde_json::to_vec(&serde_json::json!({
					"artifact": {
						"kind": "workspace-snapshot.json",
						"content_sha256": digest,
						"bytes": self.bytes.len(),
						"url": "https://storage.invalid/signed",
						"url_expires_in_seconds": 120
					}
				}))
				.expect("resolve response")
			} else {
				Vec::new()
			};

			Ok(HttpResponse { status, body })
		}

		fn get_object(&self, _url: &str) -> Result<HttpResponse, WorkerError> {
			Err(WorkerError::transient("package download is not expected"))
		}

		fn get_artifact_object(&self, url: &str) -> Result<HttpResponse, WorkerError> {
			assert_eq!(url, "https://storage.invalid/signed");

			*self.object_calls.lock().expect("object calls") += 1;

			let status =
				self.object_statuses.lock().expect("object statuses").pop_front().unwrap_or(200);

			Ok(HttpResponse {
				status,
				body: if status == 200 { self.bytes.clone() } else { Vec::new() },
			})
		}
	}

	impl Transport for FakeTransport {
		fn post_json(
			&self,
			url: &str,
			_token: &Secret,
			body: &[u8],
		) -> Result<HttpResponse, WorkerError> {
			let request_bytes = body.len();
			let body: serde_json::Value = serde_json::from_slice(body)
				.map_err(|error| WorkerError::transient(error.to_string()))?;
			let disposition =
				if body.get("action").and_then(serde_json::Value::as_str) == Some("renew") {
					"renewed"
				} else if url.ends_with("/api/verifications") {
					self.terminal_claims
						.lock()
						.map_err(|_| WorkerError::transient("terminal claim lock failed"))?
						.push(body.get("claim").cloned().unwrap_or(serde_json::Value::Null));

					if body.get("stage").is_some() {
						self.verification_request_bytes
							.lock()
							.map_err(|_| {
								WorkerError::transient("verification request size lock failed")
							})?
							.push(request_bytes);
						"verified_published"
					} else {
						"rejection_recorded_not_published"
					}
				} else {
					"acknowledged"
				};

			self.posts
				.lock()
				.map_err(|_| WorkerError::transient("fake transport lock failed"))?
				.push_back(disposition.to_owned());

			let response_body = if disposition == "renewed" {
				serde_json::json!({
					"status": disposition,
					"inbox_id": body["inbox_id"],
					"lease_token": body["lease_token"],
					"lease_expires_at": "2026-07-25T12:20:00Z",
					"attempt": 1
				})
			} else if disposition == "verified_published" {
				serde_json::json!({
					"status": disposition,
					"matrix_batch_id": body["stage"]["matrix_batch_id"],
					"package_sha256": body["stage"]["package_sha256"]
				})
			} else if disposition == "rejection_recorded_not_published" {
				serde_json::json!({
					"status": disposition,
					"published": false,
					"matrix_batch_id": body["rejection"]["matrix_batch_id"],
					"package_sha256": body["rejection"]["package_sha256"]
				})
			} else {
				serde_json::json!({ "status": disposition })
			};

			Ok(HttpResponse {
				status: 200,
				body: serde_json::to_vec(&response_body)
					.map_err(|error| WorkerError::transient(error.to_string()))?,
			})
		}

		fn get_object(&self, _url: &str) -> Result<HttpResponse, WorkerError> {
			Ok(HttpResponse { status: 200, body: self.package.clone() })
		}

		fn get_artifact_object(&self, _url: &str) -> Result<HttpResponse, WorkerError> {
			Err(WorkerError::transient(
				"synthetic verification must not resolve production artifacts",
			))
		}
	}

	impl Transport for AckConflictTransport {
		fn post_json(
			&self,
			url: &str,
			token: &Secret,
			body: &[u8],
		) -> Result<HttpResponse, WorkerError> {
			let request: serde_json::Value = serde_json::from_slice(body)
				.map_err(|error| WorkerError::transient(error.to_string()))?;

			if request.get("action").and_then(serde_json::Value::as_str) == Some("ack") {
				self.inner
					.posts
					.lock()
					.map_err(|_| WorkerError::transient("fake transport lock failed"))?
					.push_back("ack_conflict".to_owned());

				return Ok(HttpResponse { status: 409, body: Vec::new() });
			}

			self.inner.post_json(url, token, body)
		}

		fn get_object(&self, url: &str) -> Result<HttpResponse, WorkerError> {
			self.inner.get_object(url)
		}

		fn get_artifact_object(&self, url: &str) -> Result<HttpResponse, WorkerError> {
			self.inner.get_artifact_object(url)
		}
	}

	impl Transport for RetryVerificationTransport {
		fn post_json(
			&self,
			url: &str,
			_token: &Secret,
			body: &[u8],
		) -> Result<HttpResponse, WorkerError> {
			let request: serde_json::Value = serde_json::from_slice(body)
				.map_err(|error| WorkerError::transient(error.to_string()))?;

			if request.get("action").and_then(serde_json::Value::as_str) == Some("renew") {
				self.requests.lock().expect("requests").push("renewed".to_owned());

				return Ok(HttpResponse {
					status: 200,
					body: serde_json::to_vec(&serde_json::json!({
						"status": "renewed",
						"inbox_id": request["inbox_id"],
						"lease_token": request["lease_token"],
						"lease_expires_at": "2026-07-25T12:20:00Z",
						"attempt": 1
					}))
					.expect("renewal response"),
				});
			}
			if request.get("action").and_then(serde_json::Value::as_str) == Some("ack") {
				let disposition = request["disposition"].as_str().expect("ack disposition");

				self.requests.lock().expect("requests").push(format!("ack_{disposition}"));

				return Ok(HttpResponse {
					status: 200,
					body: serde_json::to_vec(&serde_json::json!({ "status": "acknowledged" }))
						.expect("ack response"),
				});
			}

			assert_eq!(url, "https://gateway.invalid/api/verifications");

			self.verification_bodies.lock().expect("verification bodies").push(body.to_vec());

			let status = self
				.verification_statuses
				.lock()
				.expect("verification statuses")
				.pop_front()
				.unwrap_or(200);

			self.requests.lock().expect("requests").push(format!("verification_{status}"));

			let response_body = if status == 200 {
				serde_json::to_vec(&serde_json::json!({
					"status": "verified_published",
					"matrix_batch_id": request["stage"]["matrix_batch_id"],
					"package_sha256": request["stage"]["package_sha256"]
				}))
				.expect("verification response")
			} else {
				Vec::new()
			};

			Ok(HttpResponse { status, body: response_body })
		}

		fn get_object(&self, _url: &str) -> Result<HttpResponse, WorkerError> {
			*self.object_calls.lock().expect("object calls") += 1;

			Ok(HttpResponse { status: 200, body: self.package.clone() })
		}

		fn get_artifact_object(&self, _url: &str) -> Result<HttpResponse, WorkerError> {
			Err(WorkerError::transient(
				"synthetic verification must not resolve production artifacts",
			))
		}
	}

	impl LocalReplayFixture {
		fn new() -> Self {
			let unique = Self::unique();
			let root =
				env::temp_dir().join(format!("aiq-verifier-local-{}-{unique}", process::id()));
			let artifact_root = root.join("artifacts");
			let evaluator_root = root.join("evaluators");
			let replay_root = root.join("replay");

			for directory in [&artifact_root, &evaluator_root, &replay_root] {
				fs::create_dir_all(directory).expect("fixture directory");
			}

			let tasks = runner::synthetic_demo_tasks();
			let artifact_sink =
				adapter::LocalArtifactSink::new(&artifact_root).expect("fixture artifact sink");
			let runner_identity = SigningIdentity::from_secret([7; 32]);
			let runner_node_id = runner_identity.node().node_id.clone();
			let codex_version = "codex fixture".to_owned();
			let (capability_artifact, capability_artifact_path, capability_marker) =
				Self::capability_artifacts(&artifact_root);
			let preflight = local_fixture_preflight(
				runner_node_id.clone(),
				&codex_version,
				vec![capability_artifact, capability_marker],
			);
			let preflight_digest = protocol::canonical_hash(&preflight).expect("preflight digest");
			let mut run = runner::synthetic_demo(
				ScheduleConfig::default()
					.slot("2026-07-25", ScheduleOccurrence::Day)
					.expect("fixture slot"),
				&artifact_sink,
			)
			.expect("synthetic base run");
			let mut provenance =
				local_fixture_provenance(run.task_set_hash.clone(), preflight_digest);

			provenance.evaluator_digest =
				corpus_commitment::evaluator_digest(&tasks).expect("fixture evaluator digest");

			let run_id = resume::classified_run_id(
				&run.schedule_slot,
				&run.task_set_hash,
				&provenance.corpus_commitment_sha256,
				&run.models,
				RunClass::Official,
			)
			.expect("official run id");
			let (manifest_reference, manifest_path, snapshot_reference, stdout_reference) =
				Self::candidate_artifacts(&artifact_root);
			let evaluator_results_reference = run.evaluator_results_artifact.clone();
			let evaluator_results_path = artifact_root
				.join(evaluator_results_reference.content_hash.trim_start_matches("sha256:"))
				.join(&evaluator_results_reference.kind);

			run.synthetic = false;

			run.run_id.clone_from(&run_id);

			run.capability_validation = Some(preflight);
			run.provenance = Some(provenance.clone());
			run.evaluator_results_artifact = evaluator_results_reference;

			for result in &mut run.results {
				result.run_id.clone_from(&run_id);

				result.artifacts = vec![snapshot_reference.clone(), stdout_reference.clone()];
				result.workspace_manifest = Some(manifest_reference.clone());

				result.provenance.node_id.clone_from(&runner_node_id);
				result.provenance.codex_version.clone_from(&codex_version);

				result.provenance.synthetic = false;
				result.provenance.observed_at = "unix-ms:1".to_owned();

				let result_hash = result.content_hash().expect("result hash");

				result.result_id = format!("result_{}", result_hash.trim_start_matches("sha256:"));
			}

			run.calibration_admission_digest = Some(format!("sha256:{}", "3".repeat(64)));
			run.calibration_bank = Some(fixture_frozen_bank(&tasks));
			run.terminal_attempt_lineage = runner::terminal_attempt_lineage(&run.results);

			run_validation::validate_run_record(&run, Some(&tasks)).expect("production fixture");

			let envelope = runner_identity
				.sign(&run.run_id, protocol::RUN_PAYLOAD_TYPE, &run, TrustTier::Untrusted)
				.expect("signed production package");
			let package = submission::serialize_signed_package(&envelope).expect("package bytes");
			let package_sha256 = hex::encode(Sha256::digest(&package));
			let environment = VerifierEnvironment {
				schema_version: "aiq.verifier-environment.v2".to_owned(),
				task_set_id: AIQ_TASK_SET_ID.to_owned(),
				task_set_version: AIQ_TASK_SET_VERSION.to_owned(),
				benchmark_version: AIQ_BENCHMARK_VERSION.to_owned(),
				prompt_set_digest: provenance.prompt_digest.clone(),
				expected_provenance: Some(provenance),
				runner_commit: "d".repeat(40),
				region: "local-test".to_owned(),
				synthetic_test: false,
				artifact_resolver_endpoint: None,
			};
			let evaluator_runtime = Self::node_evaluator_runtime();

			Self {
				root,
				artifact_root,
				evaluator_root,
				replay_root,
				tasks,
				environment,
				evaluator_runtime,
				package,
				package_sha256,
				evaluator_results_path,
				manifest_path,
				capability_artifact_path,
			}
		}

		fn node_evaluator_runtime() -> EvaluatorRuntime {
			let node = env::split_paths(&env::var_os("PATH").expect("test PATH"))
				.map(|directory| directory.join(format!("node{}", env::consts::EXE_SUFFIX)))
				.find(|candidate| candidate.is_file())
				.expect("Node.js runtime");

			EvaluatorRuntime::resolve(&fs::canonicalize(node).expect("canonical Node.js runtime"))
				.expect("evaluator runtime")
		}

		fn capability_artifacts(root: &Path) -> (ArtifactReference, PathBuf, ArtifactReference) {
			let (stdout, stdout_path) =
				Self::write_artifact(root, "stdout.jsonl", b"{\"type\":\"capability.probe\"}\n");
			let (marker, _) = Self::write_artifact(
				root,
				adapter::PREFLIGHT_MARKER_ARTIFACT_KIND,
				adapter::PREFLIGHT_MARKER_BYTES,
			);

			(stdout, stdout_path, marker)
		}

		fn unique() -> String {
			let timestamp =
				SystemTime::now().duration_since(UNIX_EPOCH).expect("fixture clock").as_nanos();
			let sequence = LOCAL_REPLAY_FIXTURE_SEQUENCE.fetch_add(1, Ordering::Relaxed);

			format!("{timestamp}-{sequence}")
		}

		fn candidate_artifacts(
			root: &Path,
		) -> (ArtifactReference, PathBuf, ArtifactReference, ArtifactReference) {
			let manifest = WorkspaceManifest {
				schema_version: "aiq.workspace-manifest.v1",
				entries: Vec::new(),
			};
			let manifest_bytes = protocol::canonical_json(&manifest).expect("manifest JSON");
			let snapshot = WorkspaceSnapshot {
				schema_version: "aiq.workspace-snapshot.v1".to_owned(),
				manifest_sha256: protocol::canonical_hash(&manifest).expect("manifest hash"),
				entries: Vec::new(),
			};
			let snapshot_bytes = protocol::canonical_json(&snapshot).expect("snapshot JSON");
			let (manifest_reference, manifest_path) =
				Self::write_artifact(root, "workspace-manifest.json", &manifest_bytes);
			let (snapshot_reference, _) =
				Self::write_artifact(root, "workspace-snapshot.json", &snapshot_bytes);
			let (stdout_reference, _) =
				Self::write_artifact(root, "stdout.jsonl", b"{\"type\":\"thread.started\"}\n");

			(manifest_reference, manifest_path, snapshot_reference, stdout_reference)
		}

		fn convert_to_calibration(&mut self) {
			self.convert_to_calibration_task_count(self.tasks.len());
		}

		fn convert_to_candidate_calibration(&mut self) {
			self.convert_to_calibration();

			let catalog_value: serde_json::Value = serde_json::from_str(include_str!(
				"../../../benchmarks/candidates/aiq-core-1.1.0/catalog.json"
			))
			.expect("candidate catalog JSON");
			let catalog = candidate_catalog::validate_candidate_catalog(&catalog_value)
				.expect("candidate catalog authority");
			let catalog_tasks = catalog_value["tasks"].as_array().expect("candidate catalog tasks");
			let positions = catalog
				.tasks
				.iter()
				.enumerate()
				.map(|(index, task)| (task.task_id.as_str(), index))
				.collect::<std::collections::BTreeMap<_, _>>();

			for task in &mut self.tasks {
				let authority = catalog.task(&task.task_id).expect("candidate task authority");
				let raw = catalog_tasks
					.iter()
					.find(|entry| entry["task_id"].as_str() == Some(&task.task_id))
					.expect("candidate catalog task");

				task.task_version = candidate_catalog::CANDIDATE_TASK_SET_VERSION.to_owned();
				task.domain = authority.domain;
				task.cluster_id = Some(authority.cluster_id.clone());
				task.allowed_tools = serde_json::from_value(raw["allowed_tools"].clone())
					.expect("candidate allowed tools");
				task.budgets =
					serde_json::from_value(raw["budget"].clone()).expect("candidate budget");
				task.catalog_entry_digest =
					Some(protocol::canonical_hash(raw).expect("candidate catalog entry digest"));
				task.scorer_version = "1.0.6".to_owned();
			}

			self.tasks.sort_by_key(|task| {
				positions.get(task.task_id.as_str()).copied().unwrap_or(usize::MAX)
			});

			let envelope: protocol::SubmissionEnvelope =
				serde_json::from_slice(&self.package).expect("current calibration envelope");
			let task_hashes = self
				.tasks
				.iter()
				.map(|task| {
					(task.task_id.as_str(), task.content_hash().expect("candidate task digest"))
				})
				.collect::<std::collections::BTreeMap<_, _>>();
			let task_set_hash = task::task_set_hash(&self.tasks).expect("candidate task-set hash");
			let evaluator_digest = corpus_commitment::evaluator_digest(&self.tasks)
				.expect("candidate evaluator digest");
			let mut run: CalibrationRunRecord =
				serde_json::from_value(envelope.payload).expect("current calibration payload");

			run.task_ids = self.tasks.iter().map(|task| task.task_id.clone()).collect();

			run.task_set_hash.clone_from(&task_set_hash);

			run.provenance.corpus_release_id = "corpus_candidate_package_fixture".to_owned();
			run.provenance.corpus_commitment_sha256 = format!("sha256:{}", "c".repeat(64));

			run.provenance.catalog_digest.clone_from(&catalog.task_metadata_digest);
			run.provenance.task_set_digest.clone_from(&task_set_hash);
			run.provenance.evaluator_digest.clone_from(&evaluator_digest);

			run.run_id = resume::classified_run_id(
				&run.schedule_slot,
				&task_set_hash,
				&run.provenance.corpus_commitment_sha256,
				&run.models,
				RunClass::Calibration,
			)
			.expect("candidate calibration run id");

			for result in &mut run.results {
				result.run_id.clone_from(&run.run_id);

				result.task_version = candidate_catalog::CANDIDATE_TASK_SET_VERSION.to_owned();
				result.task_hash = task_hashes
					.get(result.task_id.as_str())
					.expect("candidate result task")
					.clone();
				result.result_id = format!(
					"result_{}",
					result
						.content_hash()
						.expect("candidate result digest")
						.trim_start_matches("sha256:")
				);
			}

			run.terminal_attempt_lineage = runner::terminal_attempt_lineage(&run.results);

			run_validation::validate_candidate_qualification_calibration_with_tasks(
				&run,
				&self.tasks,
			)
			.expect("candidate calibration validation");

			self.environment.task_set_version =
				candidate_catalog::CANDIDATE_TASK_SET_VERSION.to_owned();
			self.environment.benchmark_version =
				format!("{}@{}", AIQ_TASK_SET_ID, candidate_catalog::CANDIDATE_TASK_SET_VERSION);
			self.environment.expected_provenance = Some(run.provenance.clone());

			let identity = SigningIdentity::from_secret([7; 32]);
			let envelope = identity
				.sign(
					&run.run_id,
					protocol::CALIBRATION_RUN_PAYLOAD_TYPE,
					&run,
					TrustTier::Untrusted,
				)
				.expect("signed candidate calibration package");

			self.package = protocol::canonical_json(&envelope)
				.expect("candidate local-verification package bytes");
			self.package_sha256 = hex::encode(Sha256::digest(&self.package));
		}

		fn convert_to_calibration_task_count(&mut self, task_count: usize) {
			let envelope: protocol::SubmissionEnvelope =
				serde_json::from_slice(&self.package).expect("official envelope");
			let official: runner::RunRecord =
				serde_json::from_value(envelope.payload).expect("official payload");
			let mut provenance = official.provenance.expect("production provenance");

			provenance.run_class = RunClass::Calibration;

			let task_ids = self
				.tasks
				.iter()
				.take(task_count)
				.map(|task| task.task_id.clone())
				.collect::<Vec<_>>();
			let selected_task_ids = task_ids.iter().cloned().collect::<BTreeSet<_>>();
			let evaluator_results_path = self
				.artifact_root
				.join(
					official.evaluator_results_artifact.content_hash.trim_start_matches("sha256:"),
				)
				.join(&official.evaluator_results_artifact.kind);
			let evaluator_results: runner::EvaluatorResultsBundle = serde_json::from_slice(
				&fs::read(evaluator_results_path).expect("evaluator-results bytes"),
			)
			.expect("evaluator-results bundle");
			let (mut results, evaluator_results): (Vec<_>, Vec<_>) = official
				.results
				.into_iter()
				.zip(evaluator_results.results)
				.filter(|(result, _)| selected_task_ids.contains(&result.task_id))
				.unzip();
			let evaluator_results = runner::EvaluatorResultsBundle {
				schema_version: runner::EVALUATOR_RESULTS_SCHEMA_VERSION.to_owned(),
				results: evaluator_results,
			};
			let evaluator_results_bytes = protocol::canonical_json(&evaluator_results)
				.expect("subset evaluator-results JSON");
			let (evaluator_results_artifact, _) = Self::write_artifact(
				&self.artifact_root,
				"evaluator-results.json",
				&evaluator_results_bytes,
			);
			let task_set_hash =
				task::task_set_hash(&self.tasks[..task_count]).expect("task-set hash");

			provenance.task_set_digest.clone_from(&task_set_hash);
			self.environment
				.expected_provenance
				.as_mut()
				.expect("expected provenance")
				.task_set_digest
				.clone_from(&task_set_hash);

			let run_id = resume::classified_run_id(
				&official.schedule_slot,
				&task_set_hash,
				&provenance.corpus_commitment_sha256,
				&official.models,
				RunClass::Calibration,
			)
			.expect("calibration run id");

			for result in &mut results {
				result.run_id.clone_from(&run_id);

				result.result_id = format!(
					"result_{}",
					result
						.content_hash()
						.expect("calibration result hash")
						.trim_start_matches("sha256:")
				);
			}

			let calibration = CalibrationRunRecord {
				schema_version: runner::CALIBRATION_RUN_SCHEMA_VERSION.to_owned(),
				official_eligible: false,
				classification: "local_calibration_non_official".to_owned(),
				run_id: run_id.clone(),
				schedule_slot: official.schedule_slot,
				task_set_hash,
				scoring_version: official.scoring_version,
				calibration_admission_digest: None,
				calibration_bank: None,
				execution_concurrency: Some(17),
				models: official.models,
				task_ids,
				started_unix_ms: official.started_unix_ms,
				finished_unix_ms: official.finished_unix_ms,
				capability_validation: official.capability_validation.expect("preflight"),
				provenance,
				evaluator_results_artifact,
				terminal_attempt_lineage: runner::terminal_attempt_lineage(&results),
				results,
			};
			let identity = SigningIdentity::from_secret([7; 32]);
			let envelope = identity
				.sign(
					&run_id,
					protocol::CALIBRATION_RUN_PAYLOAD_TYPE,
					&calibration,
					TrustTier::Untrusted,
				)
				.expect("signed calibration package");

			self.package =
				submission::serialize_signed_package(&envelope).expect("calibration package bytes");
			self.package_sha256 = hex::encode(Sha256::digest(&self.package));
		}

		fn write_artifact(root: &Path, kind: &str, bytes: &[u8]) -> (ArtifactReference, PathBuf) {
			let sink = adapter::LocalArtifactSink::new(root).expect("fixture artifact sink");
			let reference = sink.put(kind, bytes).expect("fixture artifact bytes");
			let path = root.join(reference.content_hash.trim_start_matches("sha256:")).join(kind);

			(reference, path)
		}

		fn prepare(
			&self,
			stage_output: &Path,
			attestation_output: &Path,
		) -> Result<super::PreparedVerification, WorkerError> {
			self.prepare_with_jobs(stage_output, attestation_output, DEFAULT_REPLAY_JOBS)
		}

		fn prepare_candidate(&self) -> Result<super::PreparedVerification, WorkerError> {
			let resolver = LocalArtifactResolver::new(&self.artifact_root)?;
			let signing_identity = VerifierSigningIdentity::from_secret([8; 32]);

			crate::prepare_candidate_qualification_verification(PreparationRequest {
				package_bytes: &self.package,
				package_sha256: &self.package_sha256,
				expected_idempotency_key: None,
				replay_identity: &format!("candidate-local-{}", self.package_sha256),
				resolver: &resolver,
				tasks: &self.tasks,
				environment: &self.environment,
				evaluator_root: &self.evaluator_root,
				evaluator_runtime: Some(&self.evaluator_runtime),
				replay_root: &self.replay_root,
				signing_identity: &signing_identity,
				official_admission: None,
				require_official_admission: false,
				observed_unix_ms: 1_000,
				require_production: true,
				replay_jobs: DEFAULT_REPLAY_JOBS,
			})
		}

		fn prepare_with_jobs(
			&self,
			stage_output: &Path,
			attestation_output: &Path,
			replay_jobs: usize,
		) -> Result<super::PreparedVerification, WorkerError> {
			self.prepare_bytes(
				&self.package,
				&self.package_sha256,
				stage_output,
				attestation_output,
				replay_jobs,
			)
		}

		fn prepare_bytes(
			&self,
			package: &[u8],
			package_sha256: &str,
			stage_output: &Path,
			attestation_output: &Path,
			replay_jobs: usize,
		) -> Result<super::PreparedVerification, WorkerError> {
			let resolver = LocalArtifactResolver::new(&self.artifact_root)?;
			let signing_identity = VerifierSigningIdentity::from_secret([8; 32]);

			crate::verify_and_write_local(
				PreparationRequest {
					package_bytes: package,
					package_sha256,
					expected_idempotency_key: None,
					replay_identity: &format!("local-{package_sha256}"),
					resolver: &resolver,
					tasks: &self.tasks,
					environment: &self.environment,
					evaluator_root: &self.evaluator_root,
					evaluator_runtime: Some(&self.evaluator_runtime),
					replay_root: &self.replay_root,
					signing_identity: &signing_identity,
					official_admission: None,
					require_official_admission: false,
					observed_unix_ms: 1_000,
					require_production: true,
					replay_jobs,
				},
				stage_output,
				attestation_output,
			)
		}

		fn admission_context(&self) -> super::OperationalAdmissionContext {
			let digest = |byte: char| format!("sha256:{}", byte.to_string().repeat(64));
			let task_set_digest = task::task_set_hash(&self.tasks).expect("task-set hash");
			let evaluator_digest =
				corpus_commitment::evaluator_digest(&self.tasks).expect("evaluator digest");

			super::OperationalAdmissionContext {
				bindings: CalibrationAdmissionBindings {
					production_reference_sha256: digest('1'),
					build_receipt_sha256: digest('5'),
					approved_runner: SigningIdentity::from_secret([7; 32]).node().clone(),
					approved_verifier: VerifierSigningIdentity::from_secret([8; 32]).node().clone(),
					corpus_commitment_sha256: digest('1'),
					source_manifest_digest: digest('7'),
					runner_commit: self.environment.runner_commit.clone(),
					runner_source_tree: "e".repeat(40),
					task_set_digest,
					evaluator_digest,
					model_toolchain_digest: digest('2'),
					evaluator_runtime_digest: digest('3'),
					runner_executable_digest: digest('8'),
					codex_executable_digest: digest('9'),
					codex_code_mode_host_digest: digest('b'),
					verifier_executable_digest: digest('4'),
				},
				tasks: self.tasks.clone(),
			}
		}

		fn prepare_admission(
			&self,
			stage_output: &Path,
			attestation_output: &Path,
			admission_output: &Path,
			context: &super::OperationalAdmissionContext,
		) -> Result<(), WorkerError> {
			let resolver = LocalArtifactResolver::new(&self.artifact_root)?;
			let signing_identity = VerifierSigningIdentity::from_secret([8; 32]);

			crate::verify_and_write_local_with_admission(
				PreparationRequest {
					package_bytes: &self.package,
					package_sha256: &self.package_sha256,
					expected_idempotency_key: None,
					replay_identity: &format!("local-{}", self.package_sha256),
					resolver: &resolver,
					tasks: &self.tasks,
					environment: &self.environment,
					evaluator_root: &self.evaluator_root,
					evaluator_runtime: Some(&self.evaluator_runtime),
					replay_root: &self.replay_root,
					signing_identity: &signing_identity,
					official_admission: None,
					require_official_admission: false,
					observed_unix_ms: 1_000,
					require_production: true,
					replay_jobs: DEFAULT_REPLAY_JOBS,
				},
				stage_output,
				attestation_output,
				admission_output,
				context,
				false,
			)
		}
	}

	impl Drop for LocalReplayFixture {
		fn drop(&mut self) {
			let _ = fs::remove_dir_all(&self.root);
		}
	}

	#[cfg(unix)]
	impl OperationalSourceFixture {
		fn new() -> Self {
			let root = temporary_test_root("operational-sources");
			let PreparedOperationalSources {
				corpus_source_root,
				corpus_source_file,
				target_source_root,
				target_source_file,
				target_commit,
				target_tree,
			} = prepare_operational_sources(&root);
			let (tasks, catalog) = operational_source_tasks();
			let commitment = operational_corpus_commitment(&corpus_source_file, &tasks, &catalog);
			let corpus_commitment = root.join("core-a/commitment.json");

			fs::write(
				&corpus_commitment,
				serde_json::to_vec(&commitment).expect("corpus commitment JSON"),
			)
			.expect("corpus commitment");

			Self {
				root,
				corpus_source_root,
				corpus_source_file,
				target_source_root,
				target_source_file,
				corpus_commitment,
				tasks,
				target_commit,
				target_tree,
			}
		}
	}

	#[cfg(unix)]
	impl Drop for OperationalSourceFixture {
		fn drop(&mut self) {
			let _ = fs::remove_dir_all(&self.root);
		}
	}

	fn fixture_frozen_bank(tasks: &[task::TaskDefinition]) -> scoring::FrozenCalibrationBankV2 {
		scoring::FrozenCalibrationBankV2 {
			schema_version: scoring::CALIBRATION_BANK_SCHEMA_VERSION.to_owned(),
			scoring_version: scoring::AIQ_SCORING_VERSION.to_owned(),
			measurement_version: scoring::AIQ_MEASUREMENT_VERSION.to_owned(),
			method: scoring::LATENT_ABILITY_METHOD.to_owned(),
			source_package_sha256: format!("sha256:{}", "1".repeat(64)),
			source_scoring_version: scoring::AIQ_TASK_SCORER_VERSION.to_owned(),
			task_set_id: AIQ_TASK_SET_ID.to_owned(),
			task_set_version: AIQ_TASK_SET_VERSION.to_owned(),
			task_set_digest: task::task_set_hash(tasks).expect("fixture task-set digest"),
			catalog_digest: scoring::AIQ_CORE_TASK_IDENTITY_SHA256.to_owned(),
			evaluator_digest: corpus_commitment::evaluator_digest(tasks)
				.expect("fixture evaluator digest"),
			policy_digest: format!("sha256:{}", "2".repeat(64)),
			calibration_model_count: MODEL_MATRIX.len(),
			items: tasks
				.iter()
				.map(|task| scoring::CalibrationTaskParameter {
					task_id: task.task_id.clone(),
					task_version: task.task_version.clone(),
					domain: task.domain,
					facility: 0.5,
					difficulty: 0.0,
					mean_item_information: 0.25,
				})
				.collect(),
		}
	}

	fn official_evidence(
		prepared: &PreparedVerification,
	) -> (&NormalizedBatchStage, &VerifierAttestationV2) {
		match &prepared.evidence {
			PreparedEvidence::Official { stage, attestation } => (stage, attestation),
			PreparedEvidence::Calibration { .. } => panic!("expected Official evidence"),
		}
	}

	fn candidate_qualification_catalog() -> candidate_catalog::CandidateCatalogAuthority {
		let value: serde_json::Value = serde_json::from_str(include_str!(
			"../../../benchmarks/candidates/aiq-core-1.1.0/catalog.json"
		))
		.expect("candidate catalog JSON");

		candidate_catalog::validate_candidate_catalog(&value).expect("candidate catalog")
	}

	fn candidate_qualification_stage(
		mut stage: CalibrationVerifiedStageV1,
		index: usize,
	) -> (CalibrationVerifiedStageV1, CalibrationVerifierAttestationV1, [u8; 32]) {
		let catalog = candidate_qualification_catalog();
		let task_ids = catalog.tasks.iter().map(|task| task.task_id.clone()).collect::<Vec<_>>();
		let run_shift = [-0.005, 0.0, 0.005][index];
		let cells = MODEL_MATRIX
			.iter()
			.enumerate()
			.flat_map(|(model_index, model)| {
				task_ids.iter().enumerate().map(move |(task_index, task_id)| QualificationCell {
					task_id: task_id.clone(),
					model: *model,
					status: QualificationCellStatus::Completed,
					semantic_score: Some(
						0.12 + model_index as f64 * 0.045
							+ (task_index % 5) as f64 * 0.01
							+ run_shift,
					),
				})
			})
			.collect();
		let identity_character = char::from(b'1' + index as u8);

		stage.run_id = format!("run_{}", identity_character.to_string().repeat(64));
		stage.package_sha256 = identity_character.to_string().repeat(64);
		stage.content_hash = format!("sha256:{}", identity_character.to_string().repeat(64));
		stage.task_ids = task_ids.clone();
		stage.task_selection_digest = protocol::canonical_hash(&task_ids).expect("task selection");
		stage.task_set_version = candidate_catalog::CANDIDATE_TASK_SET_VERSION.to_owned();
		stage.benchmark_version =
			format!("{}@{}", AIQ_TASK_SET_ID, candidate_catalog::CANDIDATE_TASK_SET_VERSION);
		stage.provenance.run_class = RunClass::Calibration;
		stage.provenance.corpus_release_id = "corpus_candidate_qualification_fixture".to_owned();
		stage.provenance.catalog_digest = catalog.task_metadata_digest;

		stage.provenance.task_set_digest.clone_from(&stage.task_set_hash);

		for (result_index, result) in stage.result_efficiency.iter_mut().enumerate() {
			result.task_id.clone_from(&task_ids[result_index % task_ids.len()]);
		}

		stage.telemetry_digest =
			protocol::canonical_hash(&stage.result_efficiency).expect("candidate telemetry");
		stage.qualification_projection =
			Some(aiq_runner::benchmark_qualification::CandidateQualificationProjection {
				schema_version: benchmark_qualification::QUALIFICATION_PROJECTION_SCHEMA_VERSION
					.to_owned(),
				candidate_id: catalog.candidate_id,
				disposition: QualificationChildDisposition::Accepted,
				synthetic: false,
				cells,
			});
		stage.stage_digest = stage.compute_stage_digest().expect("candidate stage digest");

		stage.verify_candidate_qualification().expect("candidate stage");

		let verifier_secret = [80 + index as u8; 32];
		let attestation =
			sign_candidate_qualification_attestation(&stage, verifier_secret, 100 + index as u64);

		attestation
			.verify_candidate_qualification(
				&stage,
				VerifierSigningIdentity::from_secret(verifier_secret).node(),
			)
			.expect("candidate attestation");

		(stage, attestation, verifier_secret)
	}

	fn sign_candidate_qualification_attestation(
		stage: &CalibrationVerifiedStageV1,
		secret: [u8; 32],
		observed_unix_ms: u64,
	) -> CalibrationVerifierAttestationV1 {
		let verifier = VerifierSigningIdentity::from_secret(secret).node().clone();
		let mut attestation = CalibrationVerifierAttestationV1 {
			schema_version: CALIBRATION_VERIFIER_ATTESTATION_SCHEMA_VERSION.to_owned(),
			signature_algorithm: VERIFIER_SIGNATURE_ALGORITHM.to_owned(),
			signature_version: VERIFIER_SIGNATURE_VERSION.to_owned(),
			run_id: stage.run_id.clone(),
			package_sha256: stage.package_sha256.clone(),
			content_hash: stage.content_hash.clone(),
			stage_digest: stage.stage_digest.clone(),
			runner: stage.runner.clone(),
			verifier,
			classification: stage.classification.clone(),
			run_class: RunClass::Calibration,
			official_eligible: FalseOnly,
			ranking_eligible: FalseOnly,
			trust: TrustTier::Untrusted,
			task_set_hash: stage.task_set_hash.clone(),
			terminal_attempt_lineage_digest: stage.terminal_attempt_lineage_digest.clone(),
			task_selection_digest: stage.task_selection_digest.clone(),
			model_selection_digest: stage.model_selection_digest.clone(),
			score_reports_digest: stage.score_reports_digest.clone(),
			telemetry_digest: stage.telemetry_digest.clone(),
			capability_validation_digest: stage.capability_validation_digest.clone(),
			scoring_version: stage.scoring_version.clone(),
			execution_concurrency: stage.execution_concurrency,
			observed_unix_ms,
			replay_status: CalibrationReplayStatus::EvaluatorReplayed,
			signature: String::new(),
		};
		let unsigned = serde_json::json!({
			"schema_version": &attestation.schema_version,
			"signature_algorithm": &attestation.signature_algorithm,
			"signature_version": &attestation.signature_version,
			"run_id": &attestation.run_id,
			"package_sha256": &attestation.package_sha256,
			"content_hash": &attestation.content_hash,
			"stage_digest": &attestation.stage_digest,
			"runner": &attestation.runner,
			"verifier": &attestation.verifier,
			"classification": &attestation.classification,
			"run_class": attestation.run_class,
			"official_eligible": false,
			"ranking_eligible": false,
			"trust": attestation.trust,
			"task_set_hash": &attestation.task_set_hash,
			"terminal_attempt_lineage_digest": &attestation.terminal_attempt_lineage_digest,
			"task_selection_digest": &attestation.task_selection_digest,
			"model_selection_digest": &attestation.model_selection_digest,
			"score_reports_digest": &attestation.score_reports_digest,
			"telemetry_digest": &attestation.telemetry_digest,
			"capability_validation_digest": &attestation.capability_validation_digest,
			"scoring_version": &attestation.scoring_version,
			"execution_concurrency": attestation.execution_concurrency,
			"observed_unix_ms": attestation.observed_unix_ms,
			"replay_status": attestation.replay_status,
		});
		let bytes = protocol::canonical_json(&unsigned).expect("candidate attestation bytes");

		attestation.signature =
			hex::encode(SigningKey::from_bytes(&secret).sign(&bytes).to_bytes());

		attestation
	}

	fn candidate_qualification_manifest(
		catalog: &candidate_catalog::CandidateCatalogAuthority,
		stages: &[CalibrationVerifiedStageV1],
		attestations: &[CalibrationVerifierAttestationV1],
	) -> BenchmarkQualificationManifest {
		let stage = &stages[0];
		let provenance = &stage.provenance;

		BenchmarkQualificationManifest {
			schema_version: benchmark_qualification::QUALIFICATION_MANIFEST_SCHEMA_VERSION
				.to_owned(),
			candidate: QualificationCandidateIdentity {
				candidate_id: catalog.candidate_id.clone(),
				catalog_digest: catalog.catalog_digest.clone(),
				task_metadata_digest: catalog.task_metadata_digest.clone(),
				task_set_digest: stage.task_set_hash.clone(),
				corpus_release_id: provenance.corpus_release_id.clone(),
				corpus_commitment_digest: provenance.corpus_commitment_sha256.clone(),
				evaluator_digest: provenance.evaluator_digest.clone(),
				harness_digest: provenance.harness_digest.clone(),
				prompt_digest: provenance.prompt_digest.clone(),
				tool_policy_digest: provenance.tool_policy_digest.clone(),
				network_policy_digest: provenance.network_policy_digest.clone(),
				environment_digest: provenance.environment_digest.clone(),
				source_manifest_digest: provenance.source_manifest_digest.clone(),
				model_selection_digest: stage.model_selection_digest.clone(),
			},
			policy: benchmark_qualification::BenchmarkQualificationPolicy::default(),
			children: stages
				.iter()
				.zip(attestations)
				.enumerate()
				.map(|(index, (stage, attestation))| PredeclaredQualificationChild {
					child_id: format!("candidate-child-{}", index + 1),
					source_run_id: stage.run_id.clone(),
					verifier: attestation.verifier.clone(),
				})
				.collect(),
		}
	}

	fn assert_candidate_authentication_mutations_rejected(
		manifest: &BenchmarkQualificationManifest,
		manifest_digest: &str,
		catalog: &candidate_catalog::CandidateCatalogAuthority,
		stages: &[CalibrationVerifiedStageV1],
		attestations: &[CalibrationVerifierAttestationV1],
	) {
		let mut changed_stages = stages.to_vec();

		changed_stages[0].qualification_projection.as_mut().expect("projection").cells[0]
			.semantic_score = Some(0.99);

		assert!(
			benchmark_qualification::qualify_candidate(
				manifest,
				manifest_digest,
				catalog,
				&changed_stages,
				attestations,
			)
			.is_err(),
			"cell tamper must invalidate the signed stage"
		);

		let mut swapped_attestations = attestations.to_vec();

		swapped_attestations.swap(0, 1);

		assert!(
			benchmark_qualification::qualify_candidate(
				manifest,
				manifest_digest,
				catalog,
				stages,
				&swapped_attestations,
			)
			.is_err(),
			"stage and attestation swap must fail"
		);

		let mut reused_stages = stages.to_vec();
		let mut reused_attestations = attestations.to_vec();

		reused_stages[1] = reused_stages[0].clone();
		reused_attestations[1] = reused_attestations[0].clone();

		assert!(
			benchmark_qualification::qualify_candidate(
				manifest,
				manifest_digest,
				catalog,
				&reused_stages,
				&reused_attestations,
			)
			.is_err(),
			"reused child evidence must fail"
		);

		let mut untrusted_attestations = attestations.to_vec();

		untrusted_attestations[0] =
			sign_candidate_qualification_attestation(&stages[0], [99; 32], 500);

		assert!(
			benchmark_qualification::qualify_candidate(
				manifest,
				manifest_digest,
				catalog,
				stages,
				&untrusted_attestations,
			)
			.is_err(),
			"an untrusted self-selected verifier must fail"
		);

		let mut unsigned_attestations = attestations.to_vec();

		unsigned_attestations[0].signature.clear();

		assert!(
			benchmark_qualification::qualify_candidate(
				manifest,
				manifest_digest,
				catalog,
				stages,
				&unsigned_attestations,
			)
			.is_err(),
			"unsigned evidence must fail"
		);

		let mut changed_manifest = manifest.clone();

		changed_manifest.candidate.candidate_id = "aiq-core/1.1.0-candidate.changed".to_owned();

		assert!(
			benchmark_qualification::qualify_candidate(
				&changed_manifest,
				manifest_digest,
				catalog,
				stages,
				attestations,
			)
			.is_err(),
			"changed candidate identity must fail"
		);
	}

	fn assert_candidate_state_and_source_mutations_rejected(
		manifest: &BenchmarkQualificationManifest,
		manifest_digest: &str,
		catalog: &candidate_catalog::CandidateCatalogAuthority,
		stages: &[CalibrationVerifiedStageV1],
		attestations: &[CalibrationVerifierAttestationV1],
		secrets: &[[u8; 32]],
	) {
		for mutation in 0..4 {
			let mut changed_stages = stages.to_vec();
			let projection =
				changed_stages[0].qualification_projection.as_mut().expect("projection");

			match mutation {
				0 => projection.disposition = QualificationChildDisposition::Rejected,
				1 => {
					projection.cells[0].status = QualificationCellStatus::RuntimeInvalid;
					projection.cells[0].semantic_score = None;
				},
				2 => projection.synthetic = true,
				_ => {
					projection.cells.pop();
				},
			}

			changed_stages[0].stage_digest =
				changed_stages[0].compute_stage_digest().expect("mutated stage digest");

			let mut changed_attestations = attestations.to_vec();

			changed_attestations[0] = sign_candidate_qualification_attestation(
				&changed_stages[0],
				secrets[0],
				600 + mutation,
			);

			assert!(
				benchmark_qualification::qualify_candidate(
					manifest,
					manifest_digest,
					catalog,
					&changed_stages,
					&changed_attestations,
				)
				.is_err(),
				"rejected, runtime-invalid, synthetic, or incomplete evidence mutation {mutation} must fail"
			);
		}

		let mut changed_stages = stages.to_vec();

		changed_stages[0].package_sha256 = "f".repeat(64);

		assert!(
			benchmark_qualification::qualify_candidate(
				manifest,
				manifest_digest,
				catalog,
				&changed_stages,
				attestations,
			)
			.is_err(),
			"changed package digest must fail"
		);

		changed_stages[0] = stages[0].clone();
		changed_stages[0].run_id = format!("run_{}", "e".repeat(64));
		changed_stages[0].stage_digest =
			changed_stages[0].compute_stage_digest().expect("changed source stage digest");

		let mut changed_attestations = attestations.to_vec();

		changed_attestations[0] =
			sign_candidate_qualification_attestation(&changed_stages[0], secrets[0], 700);

		assert!(
			benchmark_qualification::qualify_candidate(
				manifest,
				manifest_digest,
				catalog,
				&changed_stages,
				&changed_attestations,
			)
			.is_err(),
			"changed source run identity must fail"
		);
	}

	fn diagnostic_source_run(fixture: &LocalReplayFixture) -> runner::RunRecord {
		let envelope: protocol::SubmissionEnvelope =
			serde_json::from_slice(&fixture.package).expect("diagnostic source envelope");

		serde_json::from_value(envelope.payload).expect("diagnostic source run")
	}

	fn make_diagnostic_timeout(result: &mut runner::TaskResult, task_score: Option<f64>) {
		result.status = runner::ResultStatus::Failed;
		result.evaluation = runner::EvaluationOutcome::NotEvaluated;
		result.task_score = task_score;
		result.response = None;
		result.response_sha256 = None;
		result.evaluator_result_sha256 = None;
		result.evaluator_stdout_sha256 = None;
		result.failure = Some(runner::ResultFailure {
			kind: runner::FailureKind::Timeout,
			message: "diagnostic timeout".to_owned(),
			exit_code: None,
			retryable: true,
		});
	}

	fn admission_bindings(
		stage: &CalibrationVerifiedStageV1,
		attestation: &CalibrationVerifierAttestationV1,
	) -> CalibrationAdmissionBindings {
		let digest = |byte: char| format!("sha256:{}", byte.to_string().repeat(64));

		CalibrationAdmissionBindings {
			production_reference_sha256: digest('1'),
			build_receipt_sha256: digest('5'),
			approved_runner: stage.runner.clone(),
			approved_verifier: attestation.verifier.clone(),
			corpus_commitment_sha256: stage.provenance.corpus_commitment_sha256.clone(),
			source_manifest_digest: stage.provenance.source_manifest_digest.clone(),
			runner_commit: stage.runner_commit.clone(),
			runner_source_tree: "e".repeat(40),
			task_set_digest: stage.provenance.task_set_digest.clone(),
			evaluator_digest: stage.provenance.evaluator_digest.clone(),
			model_toolchain_digest: digest('2'),
			evaluator_runtime_digest: digest('3'),
			runner_executable_digest: stage.provenance.runner_executable_digest.clone(),
			codex_executable_digest: stage.provenance.codex_executable_digest.clone(),
			codex_code_mode_host_digest: stage.provenance.codex_code_mode_host_digest.clone(),
			verifier_executable_digest: digest('4'),
		}
	}

	fn retained_calibration_evidence() -> (CalibrationAdmissionBundleV3, Vec<task::TaskDefinition>)
	{
		static EVIDENCE: OnceLock<(CalibrationAdmissionBundleV3, Vec<task::TaskDefinition>)> =
			OnceLock::new();

		EVIDENCE
			.get_or_init(|| {
				let mut fixture = LocalReplayFixture::new();

				fixture.convert_to_calibration();

				let stage = fixture.root.join("retained-stage.json");
				let attestation = fixture.root.join("retained-attestation.json");
				let admission = fixture.root.join("retained-admission.json");
				let context = fixture.admission_context();

				fixture
					.prepare_admission(&stage, &attestation, &admission, &context)
					.expect("retained signed admission bundle");

				let bundle = serde_json::from_slice::<CalibrationAdmissionBundleV3>(
					&fs::read(admission).expect("retained admission bytes"),
				)
				.expect("retained admission JSON");

				(bundle, fixture.tasks.clone())
			})
			.clone()
	}

	fn target_renewal_bindings(
		source: &CalibrationAdmissionBundleV3,
	) -> CalibrationAdmissionBindings {
		let digest = |byte: char| format!("sha256:{}", byte.to_string().repeat(64));
		let mut target = source.admission.claims.issuance_bindings.clone();

		target.build_receipt_sha256 = digest('a');
		target.runner_commit = "a".repeat(40);
		target.runner_source_tree = "b".repeat(40);
		target.runner_executable_digest = digest('c');
		target.verifier_executable_digest = digest('d');

		target
	}

	fn different_digest(current: &str) -> String {
		let candidate = format!("sha256:{}", "f".repeat(64));

		if candidate == current { format!("sha256:{}", "e".repeat(64)) } else { candidate }
	}

	fn assert_calibration_attestation_mutations_rejected(
		stage: &CalibrationVerifiedStageV1,
		attestation: &CalibrationVerifierAttestationV1,
	) {
		let mut changed = stage.clone();

		changed.pricing.currency = "EUR".to_owned();
		changed.stage_digest = changed.compute_stage_digest().expect("changed stage digest");

		assert!(attestation.verify(&changed, &attestation.verifier).is_err());

		let mut changed = stage.clone();

		changed.scores[0].score.schema_version = "aiq.calibration-score-report.future".to_owned();
		changed.score_reports_digest =
			protocol::canonical_hash(&changed.scores).expect("changed score digest");
		changed.stage_digest = changed.compute_stage_digest().expect("changed stage digest");

		assert!(attestation.verify(&changed, &attestation.verifier).is_err());

		let mut changed = stage.clone();

		changed.scores[0].score.quality_score =
			changed.scores[0].score.quality_score.map(|value| (value - 0.01).max(0.0));
		changed.score_reports_digest =
			protocol::canonical_hash(&changed.scores).expect("changed score digest");
		changed.stage_digest = changed.compute_stage_digest().expect("changed stage digest");

		assert!(attestation.verify(&changed, &attestation.verifier).is_err());

		let mut uppercase_signature = attestation.clone();

		uppercase_signature.signature = uppercase_signature.signature.to_ascii_uppercase();

		assert_ne!(uppercase_signature.signature, attestation.signature);
		assert!(uppercase_signature.verify(stage, &attestation.verifier).is_err());
	}

	fn assert_calibration_admission_mutations_rejected(
		admission: &CalibrationAdmissionV3,
		expected_bindings: &CalibrationAdmissionBindings,
		fixture: &LocalReplayFixture,
		run: &CalibrationRunRecord,
	) {
		for mutation in 0..6 {
			let mut changed = admission.clone();

			match mutation {
				0 => {
					let replacement =
						if changed.claims.package_sha256.starts_with('f') { "e" } else { "f" };

					changed.claims.package_sha256.replace_range(0..1, replacement);
				},
				1 => {
					changed.claims.issuance_bindings.runner_executable_digest =
						format!("sha256:{}", "a".repeat(64))
				},
				2 => {
					changed.claims.issuance_bindings.source_manifest_digest =
						format!("sha256:{}", "b".repeat(64))
				},
				3 => {
					changed.claims.issuance_bindings.verifier_executable_digest =
						format!("sha256:{}", "c".repeat(64))
				},
				4 => changed.claims.diagnostic.violations.push("forced failure".to_owned()),
				_ => changed.claims.diagnostic.policy.min_informative_task_rate = 0.0,
			}

			assert!(
				changed.verify(expected_bindings, &fixture.tasks, &run.results).is_err(),
				"mutation {mutation} must fail"
			);
		}
	}

	fn resign_calibration_admission(admission: &mut CalibrationAdmissionV3, secret: [u8; 32]) {
		admission.admission_digest =
			protocol::canonical_hash(&admission.claims).expect("mutated claims digest");

		let unsigned = serde_json::json!({
			"schema_version": &admission.schema_version,
			"signature_algorithm": &admission.signature_algorithm,
			"signature_version": &admission.signature_version,
			"claims": &admission.claims,
			"admission_digest": &admission.admission_digest,
		});
		let bytes = protocol::canonical_json(&unsigned).expect("mutated admission bytes");

		admission.signature = hex::encode(SigningKey::from_bytes(&secret).sign(&bytes).to_bytes());
	}

	fn assert_official_consumer_bank_bindings(
		fixture: &LocalReplayFixture,
		stage: &CalibrationVerifiedStageV1,
		attestation: &CalibrationVerifierAttestationV1,
		admission: &CalibrationAdmissionV3,
		expected_bindings: &CalibrationAdmissionBindings,
		official_run: &mut RunRecord,
	) {
		let bundle = CalibrationAdmissionBundleV3 {
			schema_version: CALIBRATION_ADMISSION_BUNDLE_SCHEMA_VERSION.to_owned(),
			stage: stage.clone(),
			attestation: attestation.clone(),
			admission: admission.clone(),
		};

		bundle
			.verify_for_official(expected_bindings, &fixture.tasks)
			.expect("Official consumer verifies signed bank without re-fitting");

		for mutation in 0..4 {
			let mut inconsistent = bundle.clone();

			match mutation {
				0 => {
					inconsistent.admission.claims.calibration_bank.source_package_sha256 =
						format!("sha256:{}", "a".repeat(64));
				},
				1 => {
					inconsistent.admission.claims.calibration_bank.task_set_digest =
						format!("sha256:{}", "b".repeat(64));
				},
				2 => {
					inconsistent.admission.claims.calibration_bank.evaluator_digest =
						format!("sha256:{}", "c".repeat(64));
				},
				_ => {
					inconsistent.admission.claims.calibration_bank.policy_digest =
						format!("sha256:{}", "d".repeat(64));
				},
			}

			inconsistent.admission.claims.calibration_bank_digest = inconsistent
				.admission
				.claims
				.calibration_bank
				.digest()
				.expect("mutated bank digest");

			resign_calibration_admission(&mut inconsistent.admission, [8; 32]);

			assert!(
				inconsistent.verify_for_official(expected_bindings, &fixture.tasks).is_err(),
				"approved-verifier re-signed internal bank mismatch {mutation} must reject"
			);
		}

		official_run.calibration_admission_digest =
			Some(protocol::canonical_hash(&bundle).expect("bundle digest"));
		official_run.calibration_bank = Some(admission.claims.calibration_bank.clone());

		crate::verify_official_calibration_admission_binding(
			official_run,
			&bundle,
			expected_bindings,
			&fixture.tasks,
		)
		.expect("Official run matches the independently verified bank");

		let mut missing_admission_digest = official_run.clone();

		missing_admission_digest.calibration_admission_digest = None;

		assert!(
			crate::verify_official_calibration_admission_binding(
				&missing_admission_digest,
				&bundle,
				expected_bindings,
				&fixture.tasks,
			)
			.is_err(),
			"Official consumption rejects a missing admission digest"
		);

		let mut replaced_bank = official_run.clone();

		replaced_bank.calibration_bank.as_mut().expect("embedded bank").items[0].difficulty += 0.01;

		assert!(
			crate::verify_official_calibration_admission_binding(
				&replaced_bank,
				&bundle,
				expected_bindings,
				&fixture.tasks,
			)
			.is_err(),
			"Official consumption rejects a replaced embedded bank"
		);
	}

	fn assert_attacker_admission_rejected(
		fixture: &LocalReplayFixture,
		stage: &CalibrationVerifiedStageV1,
		attestation: &CalibrationVerifierAttestationV1,
		admission: &CalibrationAdmissionV3,
		expected_bindings: &CalibrationAdmissionBindings,
		official_run: &RunRecord,
		run: &CalibrationRunRecord,
	) {
		let attacker = VerifierSigningIdentity::from_secret([10; 32]);
		let attacker_attestation = calibration_verification::attest_calibration_stage(
			&attacker,
			stage,
			attestation.observed_unix_ms,
		)
		.expect("attacker-owned attestation");
		let mut attacker_bindings = expected_bindings.clone();

		attacker_bindings.approved_verifier = attacker.node().clone();

		let attacker_admission = calibration_verification::sign_full_calibration_admission(
			&attacker,
			stage,
			&attacker_attestation,
			&fixture.tasks,
			&run.results,
			scoring::AIQ_TASK_SCORER_VERSION,
			attacker_bindings,
		)
		.expect("attacker-owned re-signed admission");
		let attacker_bundle = CalibrationAdmissionBundleV3 {
			schema_version: CALIBRATION_ADMISSION_BUNDLE_SCHEMA_VERSION.to_owned(),
			stage: stage.clone(),
			attestation: attacker_attestation,
			admission: attacker_admission.clone(),
		};

		assert!(
			attacker_admission.verify(expected_bindings, &fixture.tasks, &run.results).is_err(),
			"external verifier and production-reference bindings reject an attacker-owned admission"
		);
		assert!(
			crate::verify_official_calibration_admission_binding(
				official_run,
				&attacker_bundle,
				expected_bindings,
				&fixture.tasks,
			)
			.is_err(),
			"Official consumption rejects an attacker re-signed admission bundle"
		);
		assert!(
			admission
				.verify(
					&CalibrationAdmissionBindings {
						approved_verifier: attacker.node().clone(),
						..expected_bindings.clone()
					},
					&fixture.tasks,
					&run.results,
				)
				.is_err()
		);
	}

	#[test]
	fn verifier_cli_requires_production_runtime_bindings_but_keeps_synthetic_demo_minimal() {
		assert!(
			<Cli as clap::CommandFactory>::command().get_arguments().all(|argument| !matches!(
				argument.get_id().as_str(),
				"candidate_qualification" | "candidate_source_root"
			)),
			"the production worker must not expose candidate qualification"
		);

		let base = [
			"aiq-verifier",
			"--endpoint",
			"https://gateway.invalid",
			"--environment",
			"environment.json",
			"--replay-root",
			"replay",
		];
		let mut production = base.to_vec();

		production.extend(["--tasks", "tasks"]);

		assert!(Cli::try_parse_from(&production).is_err());

		production.extend([
			"--evaluator-root",
			"evaluators",
			"--corpus-commitment",
			"corpus.json",
			"--evaluator-runtime",
			"/toolchain/node",
			"--codex-toolchain-root",
			"/toolchain",
			"--calibration-admission",
			"calibration-admission.json",
			"--corpus-source-root",
			"corpus-source-snapshot",
			"--target-source-root",
			"target-source",
			"--runner-binary",
			"bin/aiq-runner",
			"--codex-binary",
			"codex-runtime/codex",
			"--production-reference",
			"production-reference.json",
			"--expected-production-reference-sha256",
			"sha256:1111111111111111111111111111111111111111111111111111111111111111",
			"--build-receipt",
			"final-build-receipt.json",
			"--expected-build-receipt-sha256",
			"sha256:2222222222222222222222222222222222222222222222222222222222222222",
		]);

		assert!(Cli::try_parse_from(production).is_ok());

		let mut synthetic = base.to_vec();

		synthetic.push("--synthetic-demo-tasks");

		assert!(Cli::try_parse_from(&synthetic).is_ok());

		synthetic.extend(["--evaluator-runtime", "/toolchain/node"]);

		assert!(Cli::try_parse_from(synthetic).is_err());
	}

	#[test]
	fn replay_jobs_default_and_bounds_are_strict() {
		let base = [
			"aiq-verifier",
			"--endpoint",
			"https://gateway.invalid",
			"--synthetic-demo-tasks",
			"--environment",
			"environment.json",
			"--replay-root",
			"replay",
		];
		let parsed = Cli::try_parse_from(base).expect("default replay jobs");

		assert_eq!(parsed.timeout_seconds, crate::DEFAULT_GATEWAY_TIMEOUT_SECONDS);
		assert_eq!(parsed.replay_jobs, DEFAULT_REPLAY_JOBS);

		for accepted in ["1", "32"] {
			let mut arguments = base.to_vec();

			arguments.extend(["--replay-jobs", accepted]);

			assert_eq!(
				Cli::try_parse_from(arguments).expect("bounded replay jobs").replay_jobs,
				accepted.parse::<usize>().expect("fixture integer")
			);
		}
		for rejected in ["0", "33", "not-an-integer"] {
			let mut arguments = base.to_vec();

			arguments.extend(["--replay-jobs", rejected]);

			assert!(Cli::try_parse_from(arguments).is_err());
		}
	}

	#[test]
	fn top_level_help_exposes_offline_and_environment_validation_modes() {
		let help = <Cli as clap::CommandFactory>::command().render_long_help().to_string();

		assert!(help.contains("aiq-verifier validate-environment --environment <ENVIRONMENT>"));
		assert!(help.contains("without secrets or service access"));
		assert!(help.contains("aiq-verifier verify-local --help"));
		assert!(help.contains("write create-new stage and attestation files"));
		assert!(help.contains("does not publish or assign cloud trust"));
		assert!(help.contains("aiq-verifier renew-calibration-admission --help"));
		assert!(help.contains("fully validated target release"));
		assert!(help.contains("does not require replay artifacts"));
		assert!(help.contains("aiq-verifier diagnose-rescore --help"));
		assert!(help.contains("permanently non-Official create-new diagnostic report"));
		assert!(help.contains("aiq-verifier verify-qualification --help"));
		assert!(help.contains("without models or publication"));
	}

	#[test]
	fn qualification_verifier_requires_three_explicit_stage_and_attestation_pairs() {
		let parsed = VerifyQualificationCli::try_parse_from([
			"aiq-verifier verify-qualification",
			"--artifact",
			"qualification.json",
			"--manifest",
			"manifest.json",
			"--expected-manifest-sha256",
			"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			"--catalog",
			"catalog.json",
			"--stage",
			"stage-1.json",
			"--stage",
			"stage-2.json",
			"--stage",
			"stage-3.json",
			"--attestation",
			"attestation-1.json",
			"--attestation",
			"attestation-2.json",
			"--attestation",
			"attestation-3.json",
		])
		.expect("qualification CLI");

		assert_eq!(parsed.stages.len(), 3);
		assert_eq!(parsed.attestations.len(), 3);
		assert!(
			crate::run_verify_qualification(VerifyQualificationCli {
				artifact: PathBuf::from("qualification.json"),
				manifest: PathBuf::from("manifest.json"),
				expected_manifest_sha256:
					"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
						.to_owned(),
				catalog: PathBuf::from("catalog.json"),
				stages: vec![PathBuf::from("stage-1.json")],
				attestations: vec![PathBuf::from("attestation-1.json")],
			})
			.is_err()
		);
	}

	#[test]
	fn renewal_cli_requires_complete_target_authority_and_has_no_replay_inputs() {
		let arguments = [
			"aiq-verifier renew-calibration-admission",
			"--source-bundle",
			"source-bundle.json",
			"--tasks",
			"tasks",
			"--environment",
			"environment.json",
			"--evaluator-root",
			"evaluators",
			"--corpus-commitment",
			"corpus.json",
			"--evaluator-runtime",
			"/toolchain/node",
			"--codex-toolchain-root",
			"/toolchain",
			"--corpus-source-root",
			"/retained/core-a/source-snapshot",
			"--target-source-root",
			"/target/source",
			"--runner-binary",
			"/target/aiq-runner",
			"--codex-binary",
			"/target/codex",
			"--production-reference",
			"/controlled/production-reference.json",
			"--expected-production-reference-sha256",
			"sha256:1111111111111111111111111111111111111111111111111111111111111111",
			"--build-receipt",
			"/controlled/final-build-receipt.json",
			"--expected-build-receipt-sha256",
			"sha256:2222222222222222222222222222222222222222222222222222222222222222",
			"--output",
			"renewed-bundle.json",
		];

		assert!(RenewCalibrationAdmissionCli::try_parse_from(arguments).is_ok());
		assert!(
			RenewCalibrationAdmissionCli::try_parse_from(&arguments[..arguments.len() - 2])
				.is_err()
		);

		for required in ["--corpus-source-root", "--target-source-root"] {
			let mut incomplete = arguments.to_vec();
			let index = incomplete
				.iter()
				.position(|argument| *argument == required)
				.expect("required source argument");

			incomplete.drain(index..=index + 1);

			assert!(RenewCalibrationAdmissionCli::try_parse_from(incomplete).is_err());
		}

		let mut legacy_alias = arguments.to_vec();

		for removed in ["--corpus-source-root", "--target-source-root"] {
			let index = legacy_alias
				.iter()
				.position(|argument| *argument == removed)
				.expect("source argument to replace");

			legacy_alias.drain(index..=index + 1);
		}

		legacy_alias.extend(["--source-root", "/target/source"]);

		assert!(RenewCalibrationAdmissionCli::try_parse_from(legacy_alias).is_err());

		for forbidden in ["--package", "--artifact-root", "--replay-root", "--observed-unix-ms"] {
			let mut attempted = arguments.to_vec();

			attempted.extend([forbidden, "forbidden"]);

			assert!(RenewCalibrationAdmissionCli::try_parse_from(attempted).is_err());
		}
	}

	#[test]
	fn verify_local_cli_requires_every_controlled_input_and_has_no_replay_status_override() {
		let arguments = [
			"aiq-verifier verify-local",
			"--package",
			"package.json",
			"--artifact-root",
			"artifacts",
			"--tasks",
			"tasks",
			"--environment",
			"environment.json",
			"--evaluator-root",
			"evaluators",
			"--corpus-commitment",
			"corpus.json",
			"--evaluator-runtime",
			"/toolchain/node",
			"--codex-toolchain-root",
			"/toolchain",
			"--replay-root",
			"replay",
			"--observed-unix-ms",
			"1",
			"--stage-output",
			"stage.json",
			"--attestation-output",
			"attestation.json",
		];

		assert!(VerifyLocalCli::try_parse_from(arguments).is_ok());
		assert!(VerifyLocalCli::try_parse_from(&arguments[..arguments.len() - 2]).is_err());

		let mut overridden = arguments.to_vec();

		overridden.extend(["--replay-status", "evaluator-replayed"]);

		assert!(VerifyLocalCli::try_parse_from(overridden).is_err());

		let mut candidate = arguments.to_vec();

		candidate.extend([
			"--candidate-qualification",
			"--candidate-source-root",
			"/candidate/source",
		]);

		assert!(VerifyLocalCli::try_parse_from(&candidate).is_ok());
		assert!(
			VerifyLocalCli::try_parse_from(
				[arguments.as_slice(), ["--candidate-qualification"].as_slice(),].concat()
			)
			.is_err()
		);

		let admitted = admission_issuer_arguments(&arguments);

		assert!(VerifyLocalCli::try_parse_from(&admitted).is_ok());
		assert!(VerifyLocalCli::try_parse_from(&admitted[..admitted.len() - 2]).is_err());

		let mut calibration_source = admitted.clone();

		calibration_source.push("--calibration-source-1-0-7");

		assert!(VerifyLocalCli::try_parse_from(calibration_source).is_ok());

		let mut candidate_with_admission = admitted.clone();

		candidate_with_admission.extend([
			"--candidate-qualification",
			"--candidate-source-root",
			"/candidate/source",
		]);

		assert!(VerifyLocalCli::try_parse_from(candidate_with_admission).is_err());

		let mut obsolete_calibration_source = admitted.clone();

		obsolete_calibration_source.push("--calibration-source-1-0-6");

		assert!(VerifyLocalCli::try_parse_from(obsolete_calibration_source).is_err());

		let consuming = official_consumer_arguments(&arguments);

		assert!(VerifyLocalCli::try_parse_from(&consuming).is_ok());
		assert!(VerifyLocalCli::try_parse_from(&consuming[..consuming.len() - 2]).is_err());

		let mut conflicting = consuming;

		conflicting.extend(["--admission-output", "new-admission.json"]);

		assert!(VerifyLocalCli::try_parse_from(conflicting).is_err());

		let mut incomplete = arguments.to_vec();

		incomplete.extend(["--admission-output", "admission.json"]);

		assert!(VerifyLocalCli::try_parse_from(incomplete).is_err());
	}

	fn admission_issuer_arguments<'a>(base: &'a [&'a str]) -> Vec<&'a str> {
		let mut arguments = base.to_vec();

		arguments.extend([
			"--admission-output",
			"admission.json",
			"--admission-tasks",
			"/current/tasks",
			"--admission-environment",
			"/current/environment.json",
			"--admission-evaluator-root",
			"/current/evaluators",
			"--admission-corpus-commitment",
			"/current/corpus.json",
			"--admission-evaluator-runtime",
			"/current/toolchain/node",
			"--admission-codex-toolchain-root",
			"/current/toolchain",
			"--admission-corpus-source-root",
			"/retained/core-a/source-snapshot",
			"--admission-target-source-root",
			"/target/source",
			"--admission-runner-binary",
			"/frozen/aiq-runner",
			"--admission-codex-binary",
			"/frozen/codex",
			"--production-reference",
			"/controlled/production-reference.json",
			"--expected-production-reference-sha256",
			"sha256:1111111111111111111111111111111111111111111111111111111111111111",
			"--build-receipt",
			"/controlled/final-build-receipt.json",
			"--expected-build-receipt-sha256",
			"sha256:2222222222222222222222222222222222222222222222222222222222222222",
		]);

		arguments
	}

	fn official_consumer_arguments<'a>(base: &'a [&'a str]) -> Vec<&'a str> {
		let mut arguments = base.to_vec();

		arguments.extend([
			"--calibration-admission",
			"/current/calibration-admission.json",
			"--admission-tasks",
			"/current/tasks",
			"--admission-environment",
			"/current/environment.json",
			"--admission-evaluator-root",
			"/current/evaluators",
			"--admission-corpus-commitment",
			"/current/corpus.json",
			"--admission-evaluator-runtime",
			"/current/toolchain/node",
			"--admission-codex-toolchain-root",
			"/current/toolchain",
			"--admission-corpus-source-root",
			"/retained/core-a/source-snapshot",
			"--admission-target-source-root",
			"/target/source",
			"--admission-runner-binary",
			"/frozen/aiq-runner",
			"--admission-codex-binary",
			"/frozen/codex",
			"--production-reference",
			"/controlled/production-reference.json",
			"--expected-production-reference-sha256",
			"sha256:1111111111111111111111111111111111111111111111111111111111111111",
			"--build-receipt",
			"/controlled/final-build-receipt.json",
			"--expected-build-receipt-sha256",
			"sha256:2222222222222222222222222222222222222222222222222222222222222222",
		]);

		arguments
	}

	#[test]
	fn operational_reference_approves_exact_distinct_nodes_and_rejects_tampering() {
		let root = env::temp_dir().join(format!(
			"aiq-verifier-reference-{}-{}",
			process::id(),
			SystemTime::now().duration_since(UNIX_EPOCH).expect("clock").as_nanos()
		));

		fs::create_dir(&root).expect("reference root");

		let path = root.join("production-reference.json");
		let runner = SigningIdentity::from_secret([7; 32]).node().clone();
		let verifier = VerifierSigningIdentity::from_secret([8; 32]).node().clone();
		let publisher = SigningIdentity::from_secret([9; 32]).node().clone();
		let node = |role: &str, identity: &NodeIdentity| {
			serde_json::json!({
				"schema_version": "aiq.public-node-identity.v1",
				"role": role,
				"node_id": identity.node_id,
				"display_name": format!("test {role}"),
				"key_fingerprint": identity.node_id.replacen("node_", "sha256:", 1),
				"public_key": identity.public_key,
				"signature_algorithm": "ed25519",
				"status": "active",
				"trust_tier": if role == "verifier" { "independently_reproduced" } else { "trusted_verified" },
				"operator_class": if role == "verifier" { "verifier" } else { "official" },
				"capabilities": [role],
				"source": "test fixture",
				"signature_status": "verified",
				"provenance": "test fixture",
				"synthetic": false,
				"public_visible": true
			})
		};
		let corpus_commitment = serde_json::json!({
			"schema_version": "aiq.corpus-commitment.v2",
			"release_id": "test"
		});
		let mut reference = serde_json::json!({
			"schema_version": "aiq.production-reference.v1",
			"published_at": "2026-08-05T12:00:00.000Z",
			"corpus_commitment": corpus_commitment,
			"nodes": [
				node("runner", &runner),
				node("verifier", &verifier),
				node("publisher", &publisher)
			]
		});
		let reference_bytes = serde_json::to_vec(&reference).expect("reference JSON");
		let expected_reference_sha256 =
			format!("sha256:{}", hex::encode(Sha256::digest(&reference_bytes)));

		fs::write(&path, &reference_bytes).expect("reference file");

		let (approved_runner, approved_verifier, digest, corpus_digest) =
			super::approved_operational_nodes(&path, &expected_reference_sha256)
				.expect("approved nodes");

		assert_eq!(approved_runner, runner);
		assert_eq!(approved_verifier, verifier);
		assert!(digest.starts_with("sha256:"));
		assert_eq!(
			corpus_digest,
			protocol::canonical_hash(&corpus_commitment).expect("corpus digest")
		);

		reference["nodes"][0]["node_id"] = serde_json::json!(publisher.node_id);

		fs::write(&path, serde_json::to_vec(&reference).expect("tampered JSON"))
			.expect("tampered reference");

		assert!(super::approved_operational_nodes(&path, &expected_reference_sha256).is_err());

		fs::remove_dir_all(root).expect("remove reference root");
	}

	#[test]
	fn production_reference_timestamp_requires_a_real_utc_calendar_instant() {
		assert!(super::is_canonical_millisecond_utc("2024-02-29T23:59:59.999Z"));

		for invalid in [
			"2023-02-29T12:00:00.000Z",
			"2026-04-31T12:00:00.000Z",
			"2026-13-01T12:00:00.000Z",
			"2026-01-01T24:00:00.000Z",
			"2026-01-01T12:60:00.000Z",
			"2026-01-01T12:00:60.000Z",
		] {
			assert!(!super::is_canonical_millisecond_utc(invalid), "accepted {invalid}");
		}
	}

	#[cfg(unix)]
	fn prepare_operational_sources(root: &Path) -> PreparedOperationalSources {
		let corpus_source_root = root.join("core-a/source-snapshot");
		let corpus_source_file = corpus_source_root.join("apps/aiq-runner/src/runner.rs");
		let target_source_root = root.join("target-source");
		let target_source_file = target_source_root.join("apps/aiq-runner/src/runner.rs");

		fs::create_dir_all(corpus_source_file.parent().expect("corpus source parent"))
			.expect("corpus source root");
		fs::create_dir_all(target_source_file.parent().expect("target source parent"))
			.expect("target source root");
		fs::write(&corpus_source_file, b"retained corpus runner source\n")
			.expect("corpus source bytes");
		fs::write(&target_source_file, b"upgraded target runner source\n")
			.expect("target source bytes");

		let git = |arguments: &[&str]| {
			let status = process::Command::new("git")
				.arg("-C")
				.arg(&target_source_root)
				.args(arguments)
				.env("GIT_AUTHOR_NAME", "AIQ Test")
				.env("GIT_AUTHOR_EMAIL", "aiq@example.invalid")
				.env("GIT_COMMITTER_NAME", "AIQ Test")
				.env("GIT_COMMITTER_EMAIL", "aiq@example.invalid")
				.status()
				.expect("operational source Git command");

			assert!(status.success(), "Git command failed: {arguments:?}");
		};

		git(&["init", "-q"]);
		git(&["add", "apps/aiq-runner/src/runner.rs"]);
		git(&["-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture"]);

		let target_commit =
			super::git_output(&target_source_root, &["rev-parse", "HEAD"], "target source commit")
				.expect("target source commit");
		let target_tree = super::git_output(
			&target_source_root,
			&["rev-parse", "HEAD^{tree}"],
			"target source tree",
		)
		.expect("target source tree");

		git(&["checkout", "-q", "--detach", "HEAD"]);

		PreparedOperationalSources {
			corpus_source_root,
			corpus_source_file,
			target_source_root,
			target_source_file,
			target_commit,
			target_tree,
		}
	}

	#[cfg(unix)]
	fn operational_source_tasks() -> (Vec<task::TaskDefinition>, serde_json::Value) {
		let catalog: serde_json::Value = serde_json::from_str(include_str!(
			"../../../benchmarks/candidates/aiq-core-1.0.7/catalog.json"
		))
		.expect("fixture Core catalog");
		let catalog_tasks = catalog["tasks"].as_array().expect("fixture catalog tasks");
		let evaluator_runtime_digest = format!("sha256:{}", "3".repeat(64));
		let evaluator_executable_digest = format!("sha256:{}", "4".repeat(64));
		let configuration: std::collections::BTreeMap<String, serde_json::Value> =
			serde_json::from_value(serde_json::json!({
				"schema_version": task::EVALUATOR_CONFIG_SCHEMA_VERSION,
				"completion_policy": "natural_completion"
			}))
			.expect("fixture evaluator configuration");
		let configuration_digest =
			protocol::canonical_hash(&configuration).expect("fixture configuration digest");
		let mut tasks = runner::synthetic_demo_tasks();

		for task in &mut tasks {
			let catalog_task = catalog_tasks
				.iter()
				.find(|entry| entry["task_id"].as_str() == Some(&task.task_id))
				.expect("fixture catalog task");

			task.budgets = serde_json::from_value(catalog_task["budget"].clone())
				.expect("fixture task budget");
			task.visibility = task::Visibility::Hidden;
			task.evaluator = Some(task::Evaluator {
				kind: "controlled_fixture".to_owned(),
				expected: None,
				case_sensitive: false,
				external: Some(task::ExternalEvaluatorBinding {
					protocol_version: task::EVALUATOR_PROTOCOL_VERSION.to_owned(),
					scorer_version: task.scorer_version.clone(),
					runtime_kind: task::EvaluatorRuntimeKind::Node,
					runtime_executable_digest: evaluator_runtime_digest.clone(),
					executable_ref: PathBuf::from("fixture/evaluator"),
					executable_digest: evaluator_executable_digest.clone(),
					configuration_digest: configuration_digest.clone(),
					arguments: Vec::new(),
					timeout_ms: None,
					max_input_bytes: 1_024,
					max_output_bytes: 1_024,
					configuration: configuration.clone(),
				}),
			});
		}

		(tasks, catalog)
	}

	#[cfg(unix)]
	fn operational_model_toolchain() -> serde_json::Value {
		let (platform, architecture, platform_minimal_path) =
			match (std::env::consts::OS, std::env::consts::ARCH) {
				("macos", "aarch64") => ("darwin", "arm64", "darwin_v1"),
				("macos", "x86_64") => ("darwin", "x64", "darwin_v1"),
				("linux", "aarch64") => ("linux", "arm64", "linux_v1"),
				("linux", "x86_64") => ("linux", "x64", "linux_v1"),
				(other_os, other_arch) => {
					panic!("unsupported operational source fixture host {other_os}/{other_arch}")
				},
			};

		serde_json::json!({
			"schema_version": "aiq.execution-tool-policy.v1",
			"platform": platform,
			"architecture": architecture,
			"platform_minimal_path": platform_minimal_path,
			"inherit_path": false,
			"use_shell_profile": false,
			"commands": [{
				"name": "node",
				"executable_ref": "node",
				"executable_sha256": format!("sha256:{}", "3".repeat(64)),
				"version": "v24.18.0",
			}, {
				"name": "rg",
				"executable_ref": "rg",
				"executable_sha256": format!("sha256:{}", "5".repeat(64)),
				"version": "ripgrep 15.1.0",
			}],
		})
	}

	#[cfg(unix)]
	fn operational_committed_tasks(tasks: &[task::TaskDefinition]) -> Vec<serde_json::Value> {
		tasks
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
					"task_definition_sha256": task.content_hash().expect("task digest"),
					"baseline_workspace_tree_sha256": format!("sha256:{}", "6".repeat(64)),
					"fixture_bundle_sha256": format!("sha256:{}", "7".repeat(64)),
					"catalog_entry_sha256": task.catalog_entry_digest.as_ref().expect("catalog digest"),
					"evaluator_runtime_kind": "node",
					"evaluator_runtime_executable_sha256": external.runtime_executable_digest,
					"evaluator_executable_sha256": external.executable_digest,
					"evaluator_configuration_sha256": external.configuration_digest,
					"acceptance_suite_sha256": format!("sha256:{}", "8".repeat(64)),
					"leakage_review_sha256": format!("sha256:{}", "9".repeat(64)),
				})
			})
			.collect()
	}

	#[cfg(unix)]
	fn operational_corpus_commitment(
		corpus_source_file: &Path,
		tasks: &[task::TaskDefinition],
		catalog: &serde_json::Value,
	) -> serde_json::Value {
		let catalog_tasks = catalog["tasks"].as_array().expect("fixture catalog tasks");
		let corpus_source_digest = format!(
			"sha256:{}",
			hex::encode(Sha256::digest(fs::read(corpus_source_file).expect("corpus source bytes")))
		);
		let source_manifest = serde_json::json!({
			"schema_version": "aiq.runner-source-manifest.v1",
			"package": "aiq-runner",
			"scope": "cargo_build_and_test_inputs",
			"path_base": "repository_root",
			"entries": [{
				"path": "apps/aiq-runner/src/runner.rs",
				"sha256": corpus_source_digest,
			}],
		});
		let source_manifest_digest =
			protocol::canonical_hash(&source_manifest).expect("source manifest digest");
		let model_toolchain = operational_model_toolchain();
		let runtime_provenance = serde_json::json!({
			"operating_system": {"platform": model_toolchain["platform"]},
			"locale_and_timezone": {"environment": {"OPENSSL_CONF": "/dev/null"}},
			"node_runtime": {
				"executable_sha256": format!("sha256:{}", "3".repeat(64)),
				"version": "v24.18.0",
			},
			"model_toolchain": model_toolchain,
			"runner": {
				"identity_kind": "source_only",
				"source_manifest": source_manifest,
				"source_manifest_sha256": source_manifest_digest,
				"built_binary_sha256": null,
			},
		});
		let tool_policy_tasks = catalog_tasks
			.iter()
			.map(|task| {
				serde_json::json!({
					"task_id": task["task_id"],
					"allowed_tools": task["allowed_tools"],
				})
			})
			.collect::<Vec<_>>();
		let tool_policy = serde_json::json!({
			"protocol": "aiq.tool-policy.v1",
			"evidence_class": "declared_policy_commitment",
			"catalog": tool_policy_tasks,
			"model_toolchain": runtime_provenance["model_toolchain"],
		});
		let network_policy = serde_json::json!({
			"protocol": "aiq.network-policy.v1",
			"evidence_class": "declared_policy_commitment",
			"codex_web_search": "disabled_for_controlled_corpus",
			"codex_mcp": "disabled",
			"evaluator_node_scenario": "network_denied_by_node_permission_model",
		});

		serde_json::json!({
			"schema_version": "aiq.corpus-commitment.v2",
			"release_id": "corpus_operational_source_fixture",
			"controlled": true,
			"synthetic": false,
			"catalog": {
				"schema_version": "aiq.catalog.v1",
				"task_set_id": AIQ_TASK_SET_ID,
				"task_set_version": AIQ_TASK_SET_VERSION,
				"identity_sha256": scoring::AIQ_CORE_TASK_IDENTITY_SHA256,
				"identity_scope": "ordered_full_task_metadata",
			},
			"execution": {
				"harness_sha256": format!("sha256:{}", "a".repeat(64)),
				"runner_prompt_source_sha256": corpus_source_digest,
				"declared_tool_policy_sha256": protocol::canonical_hash(&tool_policy)
					.expect("tool policy digest"),
				"declared_network_policy_sha256": protocol::canonical_hash(&network_policy)
					.expect("network policy digest"),
				"environment_sha256": protocol::canonical_hash(&runtime_provenance)
					.expect("runtime provenance digest"),
				"runtime_provenance": runtime_provenance,
			},
			"tasks": operational_committed_tasks(tasks),
		})
	}

	#[cfg(unix)]
	#[test]
	fn renewal_operational_admission_accepts_distinct_sources_and_rejects_changes_to_either() {
		let fixture = OperationalSourceFixture::new();
		let (_, target_tree) = super::validate_operational_source_authorities(
			&fixture.corpus_commitment,
			&fixture.corpus_source_root,
			&fixture.target_source_root,
			&fixture.tasks,
			&fixture.target_commit,
		)
		.expect("distinct corpus and target sources");

		assert_eq!(target_tree, fixture.target_tree);
		assert_ne!(
			fs::read(&fixture.corpus_source_file).expect("corpus source bytes"),
			fs::read(&fixture.target_source_file).expect("target source bytes")
		);
		assert!(
			super::validate_operational_source_authorities(
				&fixture.corpus_commitment,
				&fixture.target_source_root,
				&fixture.target_source_root,
				&fixture.tasks,
				&fixture.target_commit,
			)
			.is_err(),
			"the target source must not stand in for the corpus snapshot"
		);

		fs::write(&fixture.corpus_source_file, b"changed corpus source\n")
			.expect("change corpus source");

		assert!(
			super::validate_operational_source_authorities(
				&fixture.corpus_commitment,
				&fixture.corpus_source_root,
				&fixture.target_source_root,
				&fixture.tasks,
				&fixture.target_commit,
			)
			.is_err(),
			"changed corpus source must fail"
		);

		fs::write(&fixture.corpus_source_file, b"retained corpus runner source\n")
			.expect("restore corpus source");
		fs::write(&fixture.target_source_file, b"dirty target source\n")
			.expect("change target source");

		assert!(
			super::validate_operational_source_authorities(
				&fixture.corpus_commitment,
				&fixture.corpus_source_root,
				&fixture.target_source_root,
				&fixture.tasks,
				&fixture.target_commit,
			)
			.is_err(),
			"changed target source must fail"
		);
	}

	#[test]
	fn detached_source_identity_rejects_a_branch_dirty_tree_and_arbitrary_commit() {
		let root = temporary_test_root("detached-source");
		let git = |arguments: &[&str]| {
			let status = process::Command::new("git")
				.arg("-C")
				.arg(&root)
				.args(arguments)
				.env("GIT_AUTHOR_NAME", "AIQ Test")
				.env("GIT_AUTHOR_EMAIL", "aiq@example.invalid")
				.env("GIT_COMMITTER_NAME", "AIQ Test")
				.env("GIT_COMMITTER_EMAIL", "aiq@example.invalid")
				.status()
				.expect("git command");

			assert!(status.success(), "git command failed: {arguments:?}");
		};

		git(&["init", "-q"]);

		fs::write(root.join("source.rs"), "fn main() {}\n").expect("source");

		git(&["add", "source.rs"]);
		git(&["-c", "core.hooksPath=/dev/null", "commit", "-qm", "test: fixture"]);

		let commit =
			super::git_output(&root, &["rev-parse", "HEAD"], "fixture commit").expect("commit");

		assert!(super::validate_detached_source_identity(&root, &commit).is_err());

		git(&["checkout", "-q", "--detach", "HEAD"]);

		let tree = super::validate_detached_source_identity(&root, &commit).expect("detached tree");

		assert_eq!(tree.len(), 40);
		assert!(super::validate_detached_source_identity(&root, &"f".repeat(40)).is_err());

		fs::write(root.join("source.rs"), "changed\n").expect("dirty source");

		assert!(super::validate_detached_source_identity(&root, &commit).is_err());

		fs::remove_dir_all(root).expect("remove source fixture");
	}

	#[test]
	fn final_build_receipt_requires_external_digest_and_semantic_source_ids() {
		let root = temporary_test_root("build-receipt");
		let path = root.join("final-build-receipt.json");
		let digest = |byte: char| format!("sha256:{}", byte.to_string().repeat(64));
		let mut receipt = serde_json::json!({
			"schema_version": "aiq.final-build-receipt.v2",
			"source_commit": "a".repeat(40),
			"source_tree": "b".repeat(40),
			"runner_executable_sha256": digest('1'),
			"verifier_executable_sha256": digest('2'),
			"codex_executable_sha256": digest('3'),
			"codex_code_mode_host_sha256": digest('4')
		});
		let write_receipt = |value: &serde_json::Value| {
			let bytes = serde_json::to_vec(value).expect("receipt JSON");
			let expected = format!("sha256:{}", hex::encode(Sha256::digest(&bytes)));

			fs::write(&path, bytes).expect("receipt file");

			expected
		};
		let expected = write_receipt(&receipt);

		super::validated_build_receipt(&path, &expected).expect("digest-pinned build receipt");

		assert!(super::validated_build_receipt(&path, &digest('f')).is_err());

		receipt["source_commit"] = serde_json::json!("A".repeat(40));

		let invalid_expected = write_receipt(&receipt);

		assert!(super::validated_build_receipt(&path, &invalid_expected).is_err());

		fs::remove_dir_all(root).expect("remove build receipt fixture");
	}

	#[test]
	fn diagnose_rescore_cli_requires_source_provenance_and_candidate_source_authority() {
		let arguments = [
			"aiq-verifier diagnose-rescore",
			"--package",
			"package.json",
			"--artifact-root",
			"artifacts",
			"--source-tasks",
			"source-tasks",
			"--source-environment",
			"source-environment.json",
			"--source-evaluator-root",
			"source-evaluators",
			"--source-corpus-commitment",
			"source-corpus.json",
			"--source-evaluator-runtime",
			"/source/node",
			"--source-codex-toolchain-root",
			"/source/toolchain",
			"--candidate-tasks",
			"candidate-tasks",
			"--candidate-source-root",
			"candidate-source-snapshot",
			"--candidate-evaluator-root",
			"candidate-evaluators",
			"--candidate-corpus-commitment",
			"candidate-corpus.json",
			"--candidate-evaluator-runtime",
			"/candidate/node",
			"--candidate-codex-toolchain-root",
			"/candidate/toolchain",
			"--replay-root",
			"replay",
			"--output",
			"diagnostic.json",
		];

		assert!(DiagnoseRescoreCli::try_parse_from(arguments).is_ok());
		assert!(DiagnoseRescoreCli::try_parse_from(&arguments[..arguments.len() - 2]).is_err());

		let mut obsolete_candidate_environment = arguments.to_vec();

		obsolete_candidate_environment
			.extend(["--candidate-environment", "candidate-environment.json"]);

		assert!(DiagnoseRescoreCli::try_parse_from(obsolete_candidate_environment).is_err());

		let mut forbidden = arguments.to_vec();

		forbidden.extend(["--attestation-output", "attestation.json"]);

		assert!(DiagnoseRescoreCli::try_parse_from(forbidden).is_err());
	}

	#[test]
	fn diagnostic_rescore_preserves_runtime_failure_as_null() {
		let fixture = LocalReplayFixture::new();
		let mut run = diagnostic_source_run(&fixture);

		run.results.truncate(1);

		make_diagnostic_timeout(&mut run.results[0], None);

		let (results, cells) = super::materialize_diagnostic_results(&run, &fixture.tasks, &[None])
			.expect("runtime-null diagnostic result");

		assert_eq!(results[0].task_score, None);
		assert_eq!(results[0].evaluation, runner::EvaluationOutcome::NotEvaluated);
		assert_eq!(cells[0].candidate_task_score, None);
		assert!(cells[0].preserved_runtime_failure);

		let wire = serde_json::to_value(&cells[0]).expect("diagnostic cell JSON");

		assert!(wire["candidate_task_score"].is_null());
	}

	#[test]
	fn diagnostic_rescore_rejects_legacy_runtime_zero() {
		let fixture = LocalReplayFixture::new();
		let mut run = diagnostic_source_run(&fixture);

		run.results.truncate(1);

		make_diagnostic_timeout(&mut run.results[0], Some(0.0));

		let error = super::materialize_diagnostic_results(&run, &fixture.tasks, &[None])
			.expect_err("legacy runtime zero must fail closed");

		assert!(matches!(error.kind, ErrorKind::Terminal(ReasonCode::EvaluatorReplayMismatch)));
	}

	#[test]
	fn diagnostic_rescore_keeps_completed_semantic_incorrect_as_zero() {
		let fixture = LocalReplayFixture::new();
		let mut run = diagnostic_source_run(&fixture);

		run.results.truncate(1);

		let candidate = task::EvaluationResult {
			schema_version: task::EVALUATOR_RESULT_SCHEMA_VERSION.to_owned(),
			outcome: task::EvaluatorOutcome::Incorrect,
			score: 0.0,
			checks: Vec::new(),
			raw_stdout_sha256: None,
		};
		let (results, cells) =
			super::materialize_diagnostic_results(&run, &fixture.tasks, &[Some(candidate)])
				.expect("semantic incorrect diagnostic result");

		assert_eq!(results[0].task_score, Some(0.0));
		assert_eq!(results[0].evaluation, runner::EvaluationOutcome::Incorrect);
		assert_eq!(cells[0].candidate_task_score, Some(0.0));
		assert!(!cells[0].preserved_runtime_failure);
	}

	#[test]
	fn diagnostic_output_is_create_new_and_preserves_the_first_report() {
		let root = temporary_test_root("diagnostic-create-new");
		let output = root.join("diagnostic.json");
		let target =
			super::OutputTarget::new(&output, "diagnostic output").expect("new diagnostic output");

		super::write_create_new_json(&target, &serde_json::json!({ "sequence": 1 }), "diagnostic")
			.expect("first diagnostic report");

		let first = fs::read(&output).expect("first diagnostic bytes");
		let error = super::write_create_new_json(
			&target,
			&serde_json::json!({ "sequence": 2 }),
			"diagnostic",
		)
		.expect_err("existing diagnostic output must not be overwritten");

		assert_eq!(
			serde_json::from_slice::<serde_json::Value>(&first).expect("diagnostic JSON"),
			serde_json::json!({ "sequence": 1 })
		);
		assert_eq!(fs::read(&output).expect("preserved diagnostic bytes"), first);
		assert_eq!(error.kind, ErrorKind::Configuration);

		fs::remove_dir_all(root).expect("remove fixture");
	}

	#[test]
	fn diagnostic_source_accepts_a_valid_official_matrix_with_reused_artifact_content() {
		let fixture = LocalReplayFixture::new();
		let envelope: protocol::SubmissionEnvelope =
			serde_json::from_slice(&fixture.package).expect("signed Official fixture package");
		let run: runner::RunRecord =
			serde_json::from_value(envelope.payload).expect("Official fixture run");
		let source = super::ConfiguredSourceEvaluatorSet {
			environment: fixture.environment.clone(),
			set: super::ConfiguredEvaluatorSet {
				tasks: fixture.tasks.clone(),
				evaluator_root: fixture.evaluator_root.clone(),
				evaluator_runtime: fixture.evaluator_runtime.clone(),
				toolchain_root: fixture.root.join("toolchain"),
				corpus_commitment_sha256: "sha256:fixture".to_owned(),
				task_set_digest: run.task_set_hash.clone(),
				evaluator_digest: "sha256:fixture".to_owned(),
			},
		};
		let resolver =
			LocalArtifactResolver::new(&fixture.artifact_root).expect("fixture artifact resolver");

		assert_eq!(
			super::validate_diagnostic_source_run(&run, &source, &resolver)
				.expect("valid Official source matrix"),
			0
		);
	}

	fn temporary_test_root(label: &str) -> PathBuf {
		let unique =
			SystemTime::now().duration_since(UNIX_EPOCH).expect("fixture clock").as_nanos();
		let root = env::temp_dir().join(format!("aiq-verifier-{label}-{}-{unique}", process::id()));

		fs::create_dir(&root).expect("fixture directory");

		root
	}

	#[test]
	fn local_replay_reconstructs_all_1224_results_and_writes_deterministic_evidence() {
		let fixture = LocalReplayFixture::new();
		let first_stage = fixture.root.join("first-stage.json");
		let first_attestation = fixture.root.join("first-attestation.json");
		let first = fixture
			.prepare_with_jobs(&first_stage, &first_attestation, 1)
			.expect("single-job offline replay");
		let second_stage = fixture.root.join("second-stage.json");
		let second_attestation = fixture.root.join("second-attestation.json");
		let second = fixture
			.prepare_with_jobs(&second_stage, &second_attestation, DEFAULT_REPLAY_JOBS)
			.expect("parallel offline replay");
		let request =
			super::serialize_prepared_verification(&test_claim(first.run_id().to_owned()), &first)
				.expect("bounded Official verification request");
		let (first_stage_evidence, first_attestation_evidence) = official_evidence(&first);
		let (second_stage_evidence, second_attestation_evidence) = official_evidence(&second);

		assert_eq!(first_stage_evidence.runs.len(), 17);
		assert!(request.len() <= MAX_VERIFICATION_REQUEST_BYTES);
		assert!(first_stage_evidence.runs.iter().all(|run| run.results.len() == 72));
		assert!(!first_stage_evidence.synthetic);
		assert_eq!(first_attestation_evidence.replay_status, ReplayStatus::EvaluatorReplayed);
		assert_eq!(
			first_attestation_evidence.policy,
			aiq_runner::normalization::VerificationPolicy::Production
		);
		assert_eq!(first.replay_scope, replay::PRODUCTION_REPLAY_SCOPE);
		assert_eq!(first_stage_evidence, second_stage_evidence);
		assert_eq!(first_attestation_evidence, second_attestation_evidence);
		assert_eq!(
			fs::read(first_stage).expect("first stage"),
			fs::read(second_stage).expect("second stage")
		);
		assert_eq!(
			fs::read(first_attestation).expect("first attestation"),
			fs::read(second_attestation).expect("second attestation")
		);
		assert_eq!(fs::read_dir(&fixture.replay_root).expect("replay root").count(), 0);
	}

	#[test]
	fn local_calibration_replay_publishes_only_non_official_efficiency_evidence() {
		let mut fixture = LocalReplayFixture::new();

		fixture.convert_to_calibration();

		let prepared = fixture
			.prepare(
				&fixture.root.join("calibration-stage.json"),
				&fixture.root.join("calibration-attestation.json"),
			)
			.expect("calibration offline replay");
		let request = super::serialize_prepared_verification(
			&test_claim(prepared.run_id().to_owned()),
			&prepared,
		)
		.expect("bounded calibration verification request");
		let PreparedEvidence::Calibration { stage, attestation } = prepared.evidence else {
			panic!("expected calibration evidence");
		};

		assert_eq!(stage.execution_concurrency, 17);

		let mut missing_stage = serde_json::to_value(&stage).expect("serialize calibration stage");

		missing_stage
			.as_object_mut()
			.expect("calibration stage object")
			.remove("execution_concurrency");

		assert!(
			serde_json::from_value::<
				aiq_runner::calibration_verification::CalibrationVerifiedStageV1,
			>(missing_stage)
			.is_err()
		);

		let mut null_attestation =
			serde_json::to_value(&attestation).expect("serialize calibration attestation");

		null_attestation["execution_concurrency"] = serde_json::Value::Null;

		assert!(
			serde_json::from_value::<
				aiq_runner::calibration_verification::CalibrationVerifierAttestationV1,
			>(null_attestation)
			.is_err()
		);
		assert!(request.len() <= MAX_VERIFICATION_REQUEST_BYTES);
		assert_eq!(stage.result_efficiency.len(), 72 * 17);
		assert_eq!(stage.scores.len(), 17);
		assert_eq!(stage.trust, TrustTier::Untrusted);
		assert!(stage.qualification_projection.is_none());
		assert!(
			serde_json::to_value(&stage)
				.expect("calibration stage JSON")
				.get("qualification_projection")
				.is_none(),
			"existing calibration stages must remain byte-compatible"
		);
		assert_eq!(attestation.stage_digest, stage.stage_digest);
		assert_ne!(attestation.runner.node_id, attestation.verifier.node_id);

		assert_calibration_attestation_mutations_rejected(&stage, &attestation);
	}

	#[test]
	fn candidate_local_package_is_accepted_by_the_offline_verifier() {
		let mut fixture = LocalReplayFixture::new();

		fixture.convert_to_candidate_calibration();

		let prepared = fixture.prepare_candidate().expect("candidate offline replay");
		let PreparedEvidence::Calibration { stage, attestation } = prepared.evidence else {
			panic!("expected candidate calibration evidence");
		};
		let projection =
			stage.qualification_projection.as_ref().expect("candidate qualification projection");

		assert_eq!(projection.candidate_id, "aiq-core/1.1.0-candidate.12");
		assert_eq!(projection.cells.len(), 1_224);
		assert_eq!(stage.trust, TrustTier::Untrusted);
		assert_eq!(attestation.stage_digest, stage.stage_digest);
		assert_ne!(attestation.runner.node_id, attestation.verifier.node_id);
	}

	#[test]
	fn candidate_qualification_replay_rejects_official_before_evaluator_work() {
		let fixture = LocalReplayFixture::new();
		let resolver =
			LocalArtifactResolver::new(&fixture.artifact_root).expect("artifact resolver");
		let signing_identity = VerifierSigningIdentity::from_secret([8; 32]);
		let error = crate::prepare_candidate_qualification_verification(PreparationRequest {
			package_bytes: &fixture.package,
			package_sha256: &fixture.package_sha256,
			expected_idempotency_key: None,
			replay_identity: "candidate-official-rejection",
			resolver: &resolver,
			tasks: &fixture.tasks,
			environment: &fixture.environment,
			evaluator_root: &fixture.evaluator_root,
			evaluator_runtime: Some(&fixture.evaluator_runtime),
			replay_root: &fixture.replay_root,
			signing_identity: &signing_identity,
			official_admission: None,
			require_official_admission: false,
			observed_unix_ms: 1_000,
			require_production: true,
			replay_jobs: DEFAULT_REPLAY_JOBS,
		})
		.expect_err("candidate mode must reject an Official package");

		assert_eq!(error.kind, ErrorKind::Terminal(ReasonCode::InvalidPackageProtocol));
		assert_eq!(fs::read_dir(&fixture.replay_root).expect("replay root").count(), 0);
	}

	#[test]
	fn replay_verified_candidate_qualification_rejects_fabrication_and_substitution() {
		let mut fixture = LocalReplayFixture::new();

		fixture.convert_to_calibration();

		let prepared = fixture
			.prepare(
				&fixture.root.join("candidate-base-stage.json"),
				&fixture.root.join("candidate-base-attestation.json"),
			)
			.expect("base calibration replay");
		let PreparedEvidence::Calibration { stage: base_stage, .. } = prepared.evidence else {
			panic!("expected calibration evidence");
		};
		let evidence = (0..3)
			.map(|index| candidate_qualification_stage(base_stage.clone(), index))
			.collect::<Vec<_>>();
		let stages = evidence.iter().map(|(stage, _, _)| stage.clone()).collect::<Vec<_>>();
		let attestations =
			evidence.iter().map(|(_, attestation, _)| attestation.clone()).collect::<Vec<_>>();
		let secrets = evidence.iter().map(|(_, _, secret)| *secret).collect::<Vec<_>>();
		let catalog = candidate_qualification_catalog();
		let manifest = candidate_qualification_manifest(&catalog, &stages, &attestations);
		let manifest_digest = protocol::canonical_hash(&manifest).expect("manifest digest");
		let artifact = benchmark_qualification::qualify_candidate(
			&manifest,
			&manifest_digest,
			&catalog,
			&stages,
			&attestations,
		)
		.expect("replay-verified qualification");

		assert_eq!(artifact.claims.status, BenchmarkQualificationStatus::Qualified);

		benchmark_qualification::verify_qualification_artifact(
			&artifact,
			&manifest,
			&manifest_digest,
			&catalog,
			&stages,
			&attestations,
		)
		.expect("qualification verification");

		assert_candidate_authentication_mutations_rejected(
			&manifest,
			&manifest_digest,
			&catalog,
			&stages,
			&attestations,
		);
		assert_candidate_state_and_source_mutations_rejected(
			&manifest,
			&manifest_digest,
			&catalog,
			&stages,
			&attestations,
			&secrets,
		);
	}

	#[test]
	fn legacy_calibration_subset_remains_valid_but_admission_rejects_it() {
		let mut fixture = LocalReplayFixture::new();

		fixture.convert_to_calibration_task_count(71);

		let stage_path = fixture.root.join("subset-stage.json");
		let attestation_path = fixture.root.join("subset-attestation.json");
		let prepared =
			fixture.prepare(&stage_path, &attestation_path).expect("legacy subset replay");
		let PreparedEvidence::Calibration { stage, attestation } = prepared.evidence else {
			panic!("expected calibration evidence");
		};

		assert_eq!(stage.task_ids.len(), 71);

		stage.verify().expect("legacy subset stage contract");
		attestation
			.verify(&stage, &attestation.verifier)
			.expect("legacy subset attestation contract");

		let envelope: protocol::SubmissionEnvelope =
			serde_json::from_slice(&fixture.package).expect("subset envelope");
		let run: CalibrationRunRecord =
			serde_json::from_value(envelope.payload).expect("subset calibration run");
		let verifier = VerifierSigningIdentity::from_secret([8; 32]);

		assert!(
			calibration_verification::sign_full_calibration_admission(
				&verifier,
				&stage,
				&attestation,
				&fixture.tasks,
				&run.results,
				scoring::AIQ_TASK_SCORER_VERSION,
				admission_bindings(&stage, &attestation),
			)
			.is_err(),
			"admission must reject a legacy-valid subset"
		);
	}

	#[test]
	#[ignore = "explicitly rewrites the checked-in calibration package example"]
	fn rewrite_calibration_package_example() {
		let mut fixture = LocalReplayFixture::new();

		fixture.convert_to_calibration_task_count(1);

		let path = Path::new(env!("CARGO_MANIFEST_DIR"))
			.join("../../benchmarks/fixtures/calibration-result-package-v4.example.json");

		fs::write(path, &fixture.package).expect("write calibration package example");
	}

	#[test]
	fn full_calibration_admission_is_signed_hashed_and_tamper_evident() {
		let mut fixture = LocalReplayFixture::new();
		let official_envelope: protocol::SubmissionEnvelope =
			serde_json::from_slice(&fixture.package).expect("Official envelope");
		let mut official_run: RunRecord =
			serde_json::from_value(official_envelope.payload).expect("Official run");

		fixture.convert_to_calibration();

		let prepared = fixture
			.prepare(
				&fixture.root.join("admission-stage.json"),
				&fixture.root.join("admission-attestation.json"),
			)
			.expect("calibration replay");
		let PreparedEvidence::Calibration { stage, attestation } = prepared.evidence else {
			panic!("expected calibration evidence");
		};
		let envelope: protocol::SubmissionEnvelope =
			serde_json::from_slice(&fixture.package).expect("calibration envelope");
		let run: CalibrationRunRecord =
			serde_json::from_value(envelope.payload).expect("calibration run");
		let diagnostic = scoring::diagnose_official_calibration(&fixture.tasks, &run.results)
			.expect("full diagnostic");

		assert!(diagnostic.passed(), "fixture must pass: {:?}", diagnostic.violations);

		let verifier = VerifierSigningIdentity::from_secret([8; 32]);
		let bindings = admission_bindings(&stage, &attestation);
		let expected_bindings = bindings.clone();
		let admission = calibration_verification::sign_full_calibration_admission(
			&verifier,
			&stage,
			&attestation,
			&fixture.tasks,
			&run.results,
			scoring::AIQ_TASK_SCORER_VERSION,
			bindings,
		)
		.expect("signed admission");

		admission
			.verify(&expected_bindings, &fixture.tasks, &run.results)
			.expect("externally anchored admission");

		assert_official_consumer_bank_bindings(
			&fixture,
			&stage,
			&attestation,
			&admission,
			&expected_bindings,
			&mut official_run,
		);

		assert_eq!(admission.claims.task_count, 72);
		assert_eq!(admission.claims.model_configuration_count, 17);
		assert_eq!(admission.claims.official_eligible, FalseOnly);
		assert_eq!(admission.claims.ranking_eligible, FalseOnly);
		assert_eq!(admission.claims.trust, TrustTier::Untrusted);

		assert_calibration_admission_mutations_rejected(
			&admission,
			&expected_bindings,
			&fixture,
			&run,
		);
		assert_attacker_admission_rejected(
			&fixture,
			&stage,
			&attestation,
			&admission,
			&expected_bindings,
			&official_run,
			&run,
		);

		assert!(
			admission
				.verify(
					&CalibrationAdmissionBindings {
						production_reference_sha256: format!("sha256:{}", "f".repeat(64)),
						..expected_bindings.clone()
					},
					&fixture.tasks,
					&run.results
				)
				.is_err()
		);

		let mut incomplete_results = run.results.clone();

		incomplete_results.pop();

		assert!(
			calibration_verification::sign_full_calibration_admission(
				&verifier,
				&stage,
				&attestation,
				&fixture.tasks,
				&incomplete_results,
				scoring::AIQ_TASK_SCORER_VERSION,
				admission_bindings(&stage, &attestation),
			)
			.is_err()
		);
	}

	#[test]
	fn renewal_rebinds_only_release_fields_without_package_artifacts_or_replay() {
		let (source, tasks) = retained_calibration_evidence();
		let target = target_renewal_bindings(&source);
		let verifier = VerifierSigningIdentity::from_secret([8; 32]);
		let renewed = calibration_verification::renew_calibration_admission(
			&verifier,
			&source,
			target.clone(),
			&tasks,
		)
		.expect("model-free admission renewal");

		renewed
			.verify_for_official(&target, &tasks)
			.expect("renewed bundle verifies for Official consumption");

		let mut expected_claims = source.admission.claims.clone();

		expected_claims.issuance_bindings = target;

		assert_eq!(renewed.stage, source.stage);
		assert_eq!(renewed.attestation, source.attestation);
		assert_eq!(renewed.admission.claims, expected_claims);
		assert_eq!(
			renewed.admission.claims.observed_unix_ms,
			source.admission.claims.observed_unix_ms
		);
		assert_eq!(
			renewed.admission.claims.replay_provenance,
			source.admission.claims.replay_provenance
		);
		assert_ne!(renewed.admission.admission_digest, source.admission.admission_digest);
		assert_ne!(renewed.admission.signature, source.admission.signature);

		let root = temporary_test_root("renewal-create-new");
		let output = root.join("renewed-admission.json");
		let output_target =
			super::OutputTarget::new(&output, "renewed admission output").expect("new output");

		super::write_create_new_json(&output_target, &renewed, "renewed calibration admission")
			.expect("atomic renewed admission output");

		let first = fs::read(&output).expect("first renewed admission bytes");
		let error =
			super::write_create_new_json(&output_target, &source, "renewed calibration admission")
				.expect_err("renewal output must be create-once");

		assert_eq!(fs::read(&output).expect("preserved renewal output"), first);
		assert_eq!(
			serde_json::from_slice::<CalibrationAdmissionBundleV3>(&first)
				.expect("renewed output JSON"),
			renewed
		);
		assert_eq!(error.kind, ErrorKind::Configuration);
		assert_eq!(fs::read_dir(&root).expect("renewal output root").count(), 1);

		fs::remove_dir_all(root).expect("remove renewal output root");
	}

	#[test]
	fn renewal_preserves_distinct_historical_replay_corpus_and_source_provenance() {
		let (mut source, tasks) = retained_calibration_evidence();
		let verifier = VerifierSigningIdentity::from_secret([8; 32]);
		let historical_replay = source.admission.claims.replay_provenance.clone();
		let historical_replay_bytes =
			protocol::canonical_json(&historical_replay).expect("historical replay provenance");

		source.admission.claims.issuance_bindings.corpus_commitment_sha256 =
			different_digest(&historical_replay.corpus_commitment_sha256);
		source.admission.claims.issuance_bindings.source_manifest_digest =
			different_digest(&historical_replay.source_manifest_digest);

		resign_calibration_admission(&mut source.admission, [8; 32]);

		let source_bindings = source.admission.claims.issuance_bindings.clone();

		source
			.verify_for_official(&source_bindings, &tasks)
			.expect("signed Official source with historical replay provenance");

		assert_ne!(
			historical_replay.corpus_commitment_sha256,
			source_bindings.corpus_commitment_sha256
		);
		assert_ne!(
			historical_replay.source_manifest_digest,
			source_bindings.source_manifest_digest
		);

		let target = target_renewal_bindings(&source);
		let renewed = calibration_verification::renew_calibration_admission(
			&verifier,
			&source,
			target.clone(),
			&tasks,
		)
		.expect("renewal preserves historical replay provenance");

		renewed
			.verify_for_official(&target, &tasks)
			.expect("renewed historical bundle verifies for Official consumption");

		assert_eq!(renewed.admission.claims.replay_provenance, historical_replay);
		assert_eq!(
			protocol::canonical_json(&renewed.admission.claims.replay_provenance)
				.expect("renewed replay provenance"),
			historical_replay_bytes
		);

		let mut changed = target.clone();

		changed.corpus_commitment_sha256 = different_digest(&changed.corpus_commitment_sha256);

		assert!(
			calibration_verification::renew_calibration_admission(
				&verifier, &source, changed, &tasks,
			)
			.is_err(),
			"target corpus drift must fail"
		);

		let mut changed = target;

		changed.source_manifest_digest = different_digest(&changed.source_manifest_digest);

		assert!(
			calibration_verification::renew_calibration_admission(
				&verifier, &source, changed, &tasks,
			)
			.is_err(),
			"target source-manifest drift must fail"
		);
	}

	#[test]
	fn renewal_rejects_replay_task_evaluator_and_codex_identity_drift() {
		let (source, tasks) = retained_calibration_evidence();
		let verifier = VerifierSigningIdentity::from_secret([8; 32]);

		for mutation in 0..4 {
			let mut changed = source.clone();
			let identity = match mutation {
				0 => {
					changed.admission.claims.issuance_bindings.task_set_digest = different_digest(
						&source.admission.claims.replay_provenance.task_set_digest,
					);

					"task set"
				},
				1 => {
					changed.admission.claims.issuance_bindings.evaluator_digest = different_digest(
						&source.admission.claims.replay_provenance.evaluator_digest,
					);

					"evaluator"
				},
				2 => {
					changed.admission.claims.issuance_bindings.codex_executable_digest =
						different_digest(
							&source.admission.claims.replay_provenance.codex_executable_digest,
						);

					"Codex executable"
				},
				_ => {
					changed.admission.claims.issuance_bindings.codex_code_mode_host_digest =
						different_digest(
							&source.admission.claims.replay_provenance.codex_code_mode_host_digest,
						);

					"Codex code-mode host"
				},
			};

			resign_calibration_admission(&mut changed.admission, [8; 32]);

			let target = target_renewal_bindings(&changed);

			assert!(
				calibration_verification::renew_calibration_admission(
					&verifier, &changed, target, &tasks,
				)
				.is_err(),
				"replay {identity} drift must fail"
			);
		}
	}

	#[test]
	fn renewal_rejects_tampered_source_stage_attestation_admission_bank_and_diagnostic() {
		let (source, tasks) = retained_calibration_evidence();
		let target = target_renewal_bindings(&source);
		let verifier = VerifierSigningIdentity::from_secret([8; 32]);
		let mut tampered = Vec::new();
		let mut changed = source.clone();

		changed.stage.stage_digest = different_digest(&changed.stage.stage_digest);

		tampered.push(changed);

		let mut changed = source.clone();
		let replacement = if changed.attestation.signature.starts_with('f') { "e" } else { "f" };

		changed.attestation.signature.replace_range(0..1, replacement);
		tampered.push(changed);

		let mut changed = source.clone();
		let replacement = if changed.admission.signature.starts_with('f') { "e" } else { "f" };

		changed.admission.signature.replace_range(0..1, replacement);
		tampered.push(changed);

		let mut changed = source.clone();

		changed.admission.admission_digest = different_digest(&changed.admission.admission_digest);

		tampered.push(changed);

		let mut changed = source.clone();

		changed.admission.claims.calibration_bank.items[0].difficulty += 0.01;

		tampered.push(changed);

		let mut changed = source.clone();

		changed.admission.claims.diagnostic.violations.push("tampered".to_owned());
		tampered.push(changed);

		for changed in tampered {
			assert!(
				calibration_verification::renew_calibration_admission(
					&verifier,
					&changed,
					target.clone(),
					&tasks,
				)
				.is_err()
			);
		}
	}

	#[test]
	fn renewal_rejects_unapproved_keys_and_changed_immutable_authority() {
		let (source, tasks) = retained_calibration_evidence();
		let target = target_renewal_bindings(&source);
		let verifier = VerifierSigningIdentity::from_secret([8; 32]);
		let attacker = VerifierSigningIdentity::from_secret([10; 32]);

		assert!(
			calibration_verification::renew_calibration_admission(
				&attacker,
				&source,
				target.clone(),
				&tasks,
			)
			.is_err()
		);

		for mutation in 0..11 {
			let mut changed = target.clone();

			match mutation {
				0 => {
					changed.production_reference_sha256 =
						different_digest(&changed.production_reference_sha256)
				},
				1 => {
					changed.approved_runner = SigningIdentity::from_secret([11; 32]).node().clone()
				},
				2 => changed.approved_verifier = attacker.node().clone(),
				3 => {
					changed.corpus_commitment_sha256 =
						different_digest(&changed.corpus_commitment_sha256)
				},
				4 => {
					changed.source_manifest_digest =
						different_digest(&changed.source_manifest_digest)
				},
				5 => changed.task_set_digest = different_digest(&changed.task_set_digest),
				6 => changed.evaluator_digest = different_digest(&changed.evaluator_digest),
				7 => {
					changed.model_toolchain_digest =
						different_digest(&changed.model_toolchain_digest)
				},
				8 => {
					changed.evaluator_runtime_digest =
						different_digest(&changed.evaluator_runtime_digest)
				},
				9 => {
					changed.codex_executable_digest =
						different_digest(&changed.codex_executable_digest)
				},
				_ => {
					changed.codex_code_mode_host_digest =
						different_digest(&changed.codex_code_mode_host_digest)
				},
			}

			assert!(
				calibration_verification::renew_calibration_admission(
					&verifier, &source, changed, &tasks,
				)
				.is_err(),
				"immutable authority mutation {mutation} must fail"
			);
		}

		let mut changed_tasks = tasks.clone();

		changed_tasks.pop();

		assert!(
			calibration_verification::renew_calibration_admission(
				&verifier,
				&source,
				target,
				&changed_tasks,
			)
			.is_err()
		);
	}

	#[test]
	fn renewal_rejects_invalid_target_build_source_and_binary_bindings() {
		let (source, tasks) = retained_calibration_evidence();
		let target = target_renewal_bindings(&source);
		let verifier = VerifierSigningIdentity::from_secret([8; 32]);
		let receipt = super::FinalBuildReceipt {
			schema_version: "aiq.final-build-receipt.v2".to_owned(),
			source_commit: target.runner_commit.clone(),
			source_tree: target.runner_source_tree.clone(),
			runner_executable_sha256: target.runner_executable_digest.clone(),
			verifier_executable_sha256: target.verifier_executable_digest.clone(),
			codex_executable_sha256: target.codex_executable_digest.clone(),
			codex_code_mode_host_sha256: target.codex_code_mode_host_digest.clone(),
		};

		super::validate_final_build_receipt_bindings(&receipt, &target)
			.expect("exact target build receipt bindings");

		for mutation in 0..6 {
			let mut changed = receipt.clone();

			match mutation {
				0 => changed.source_commit = "c".repeat(40),
				1 => changed.source_tree = "d".repeat(40),
				2 => {
					changed.runner_executable_sha256 =
						different_digest(&changed.runner_executable_sha256)
				},
				3 => {
					changed.verifier_executable_sha256 =
						different_digest(&changed.verifier_executable_sha256)
				},
				4 => {
					changed.codex_executable_sha256 =
						different_digest(&changed.codex_executable_sha256)
				},
				_ => {
					changed.codex_code_mode_host_sha256 =
						different_digest(&changed.codex_code_mode_host_sha256)
				},
			}

			assert!(super::validate_final_build_receipt_bindings(&changed, &target).is_err());
		}
		for mutation in 0..5 {
			let mut changed = target.clone();

			match mutation {
				0 => changed.build_receipt_sha256 = "sha256:invalid".to_owned(),
				1 => changed.runner_commit = "A".repeat(40),
				2 => changed.runner_source_tree = "short".to_owned(),
				3 => changed.runner_executable_digest = "sha256:invalid".to_owned(),
				_ => changed.verifier_executable_digest = "sha256:invalid".to_owned(),
			}

			assert!(
				calibration_verification::renew_calibration_admission(
					&verifier, &source, changed, &tasks,
				)
				.is_err(),
				"invalid target binding {mutation} must fail"
			);
		}
	}

	#[test]
	fn admission_outputs_are_atomic_and_identity_mismatch_leaves_no_files() {
		let mut fixture = LocalReplayFixture::new();

		fixture.convert_to_calibration();

		let stage = fixture.root.join("atomic-stage.json");
		let attestation = fixture.root.join("atomic-attestation.json");
		let admission = fixture.root.join("atomic-admission.json");
		let context = fixture.admission_context();

		fixture
			.prepare_admission(&stage, &attestation, &admission, &context)
			.expect("atomic admitted replay");

		let value: CalibrationAdmissionBundleV3 =
			serde_json::from_slice(&fs::read(&admission).expect("admission bytes"))
				.expect("admission JSON");
		let envelope: protocol::SubmissionEnvelope =
			serde_json::from_slice(&fixture.package).expect("calibration envelope");
		let run: CalibrationRunRecord =
			serde_json::from_value(envelope.payload).expect("calibration run");

		value
			.verify(&context.bindings, &fixture.tasks, &run.results)
			.expect("persisted admission signature");

		assert_eq!(
			serde_json::from_slice::<CalibrationVerifiedStageV1>(
				&fs::read(&stage).expect("stage bytes")
			)
			.expect("stage JSON"),
			value.stage
		);
		assert_eq!(
			serde_json::from_slice::<CalibrationVerifierAttestationV1>(
				&fs::read(&attestation).expect("attestation bytes")
			)
			.expect("attestation JSON"),
			value.attestation
		);

		let failed_stage = fixture.root.join("failed-stage.json");
		let failed_attestation = fixture.root.join("failed-attestation.json");
		let failed_admission = fixture.root.join("failed-admission.json");
		let mut mismatched = fixture.admission_context();

		mismatched.bindings.evaluator_digest = format!("sha256:{}", "a".repeat(64));

		fixture
			.prepare_admission(&failed_stage, &failed_attestation, &failed_admission, &mismatched)
			.expect_err("replay-to-issuance evaluator mismatch must reject admission");

		assert!(!failed_stage.exists());
		assert!(!failed_attestation.exists());
		assert!(!failed_admission.exists());

		let attacker_stage = fixture.root.join("attacker-stage.json");
		let attacker_attestation = fixture.root.join("attacker-attestation.json");
		let attacker_admission = fixture.root.join("attacker-admission.json");
		let mut attacker_runner = fixture.admission_context();

		attacker_runner.bindings.approved_runner =
			SigningIdentity::from_secret([6; 32]).node().clone();

		fixture
			.prepare_admission(
				&attacker_stage,
				&attacker_attestation,
				&attacker_admission,
				&attacker_runner,
			)
			.expect_err("unanchored replay runner must reject admission");

		assert!(!attacker_stage.exists());
		assert!(!attacker_attestation.exists());
		assert!(!attacker_admission.exists());

		let preserved = fixture.root.join("preserved-admission.json");

		fs::write(&preserved, b"preserve").expect("pre-existing admission");

		let race_stage = fixture.root.join("race-stage.json");
		let race_attestation = fixture.root.join("race-attestation.json");

		fixture
			.prepare_admission(&race_stage, &race_attestation, &preserved, &context)
			.expect_err("existing bundle must reject without partial publication");

		assert_eq!(fs::read(&preserved).expect("preserved bundle"), b"preserve");
		assert!(!race_stage.exists());
		assert!(!race_attestation.exists());
	}

	#[test]
	fn three_output_publication_rolls_back_every_install_and_reports_rollback_failures() {
		for failed_install in 0..3 {
			let root = temporary_test_root(&format!("publication-install-{failed_install}"));
			let paths = [
				root.join("stage.json"),
				root.join("attestation.json"),
				root.join("admission.json"),
			];
			let targets = paths
				.iter()
				.map(|path| super::OutputTarget::new(path, "test output").expect("output target"))
				.collect::<Vec<_>>();
			let error = super::publish_outputs_atomically(
				&[
					(&targets[0], "stage", b"stage"),
					(&targets[1], "attestation", b"attestation"),
					(&targets[2], "calibration admission", b"admission"),
				],
				|point| {
					if point == super::PublicationPoint::Install(failed_install) {
						Err(std::io::Error::other("injected install failure"))
					} else {
						Ok(())
					}
				},
			)
			.expect_err("injected install failure");

			assert!(error.to_string().contains("injected install failure"));
			assert!(paths.iter().all(|path| !path.exists()));

			fs::remove_dir_all(root).expect("remove install-failure fixture");
		}
		for failed_rollback in 0..2 {
			let root = temporary_test_root(&format!("publication-rollback-{failed_rollback}"));
			let paths = [
				root.join("stage.json"),
				root.join("attestation.json"),
				root.join("admission.json"),
			];
			let targets = paths
				.iter()
				.map(|path| super::OutputTarget::new(path, "test output").expect("output target"))
				.collect::<Vec<_>>();
			let error = super::publish_outputs_atomically(
				&[
					(&targets[0], "stage", b"stage"),
					(&targets[1], "attestation", b"attestation"),
					(&targets[2], "calibration admission", b"admission"),
				],
				|point| match point {
					super::PublicationPoint::Install(2) => {
						Err(std::io::Error::other("injected final install failure"))
					},
					super::PublicationPoint::Rollback(index) if index == failed_rollback => {
						Err(std::io::Error::other("injected rollback failure"))
					},
					_ => Ok(()),
				},
			)
			.expect_err("injected rollback failure");

			assert!(error.to_string().contains("rollback failures"));
			assert!(error.to_string().contains("injected rollback failure"));
			assert!(paths.iter().all(|path| !path.exists()));

			fs::remove_dir_all(root).expect("remove rollback-failure fixture");
		}
	}

	#[test]
	fn local_replay_rejects_tampered_or_missing_evidence_without_outputs() {
		for missing in [false, true] {
			let fixture = LocalReplayFixture::new();
			let stage = fixture.root.join("stage.json");
			let attestation = fixture.root.join("attestation.json");

			if missing {
				fs::remove_file(&fixture.manifest_path).expect("remove manifest");
			} else {
				let mut bytes = fs::read(&fixture.manifest_path).expect("manifest bytes");

				bytes[0] = b'[';

				fs::write(&fixture.manifest_path, bytes).expect("tampered manifest");
			}

			let error = fixture.prepare(&stage, &attestation).expect_err("replay must reject");

			assert!(matches!(error.kind, ErrorKind::Terminal(_)));
			assert!(!stage.exists());
			assert!(!attestation.exists());
			assert_eq!(fs::read_dir(&fixture.replay_root).expect("replay root").count(), 0);
		}
	}

	#[test]
	fn local_replay_rejects_tampered_or_missing_evaluator_results_without_outputs() {
		for missing in [false, true] {
			let fixture = LocalReplayFixture::new();
			let stage = fixture.root.join("stage.json");
			let attestation = fixture.root.join("attestation.json");

			if missing {
				fs::remove_file(&fixture.evaluator_results_path)
					.expect("remove evaluator-results bundle");
			} else {
				let mut bytes =
					fs::read(&fixture.evaluator_results_path).expect("evaluator-results bytes");

				bytes[0] = b'[';

				fs::write(&fixture.evaluator_results_path, bytes)
					.expect("tampered evaluator-results bundle");
			}

			let error = fixture.prepare(&stage, &attestation).expect_err("replay must reject");

			assert!(matches!(
				error.kind,
				ErrorKind::Terminal(
					ReasonCode::ArtifactEvidenceUnavailable | ReasonCode::ArtifactEvidenceMismatch
				)
			));
			assert!(!stage.exists());
			assert!(!attestation.exists());
			assert_eq!(fs::read_dir(&fixture.replay_root).expect("replay root").count(), 0);
		}
	}

	#[test]
	fn local_replay_claims_every_capability_probe_artifact() {
		for missing in [false, true] {
			let fixture = LocalReplayFixture::new();
			let stage = fixture.root.join("stage.json");
			let attestation = fixture.root.join("attestation.json");

			if missing {
				fs::remove_file(&fixture.capability_artifact_path)
					.expect("remove capability artifact");
			} else {
				let mut bytes =
					fs::read(&fixture.capability_artifact_path).expect("capability artifact bytes");

				bytes[0] = b'[';

				fs::write(&fixture.capability_artifact_path, bytes)
					.expect("tampered capability artifact");
			}

			let error = fixture.prepare(&stage, &attestation).expect_err("replay must reject");

			assert!(matches!(
				error.kind,
				ErrorKind::Terminal(
					ReasonCode::ArtifactEvidenceUnavailable | ReasonCode::ArtifactEvidenceMismatch
				)
			));
			assert!(!stage.exists());
			assert!(!attestation.exists());
			assert_eq!(fs::read_dir(&fixture.replay_root).expect("replay root").count(), 0);
		}
	}

	#[test]
	fn local_replay_fixture_artifacts_are_idempotent_without_overwriting_mismatches() {
		let root = temporary_test_root("local-artifact-idempotence");
		let (first, path) = LocalReplayFixture::write_artifact(&root, "stdout.jsonl", b"same");
		let (repeated, repeated_path) =
			LocalReplayFixture::write_artifact(&root, "stdout.jsonl", b"same");

		assert_eq!(repeated, first);
		assert_eq!(repeated_path, path);

		fs::write(&path, b"different").expect("replace fixture artifact with mismatched bytes");

		let mismatch = panic::catch_unwind(|| {
			LocalReplayFixture::write_artifact(&root, "stdout.jsonl", b"same");
		});

		assert!(mismatch.is_err());
		assert_eq!(fs::read(&path).expect("preserved mismatched artifact"), b"different");

		fs::remove_dir_all(root).expect("remove fixture");
	}

	#[test]
	fn local_replay_rejects_package_signature_tampering_without_outputs() {
		let fixture = LocalReplayFixture::new();
		let mut envelope: serde_json::Value =
			serde_json::from_slice(&fixture.package).expect("package JSON");
		let signature = envelope["signature"].as_str().expect("signature");

		envelope["signature"] =
			format!("{}{}", if &signature[..1] == "0" { "1" } else { "0" }, &signature[1..]).into();

		let package = protocol::canonical_json(&envelope).expect("tampered package");
		let package_sha256 = hex::encode(Sha256::digest(&package));
		let stage = fixture.root.join("stage.json");
		let attestation = fixture.root.join("attestation.json");
		let error = fixture
			.prepare_bytes(&package, &package_sha256, &stage, &attestation, DEFAULT_REPLAY_JOBS)
			.expect_err("signature tampering must reject");

		assert_eq!(error.kind, ErrorKind::Terminal(ReasonCode::InvalidPackageSignature));
		assert!(!stage.exists());
		assert!(!attestation.exists());
	}

	#[test]
	fn local_replay_never_overwrites_or_collides_outputs() {
		let fixture = LocalReplayFixture::new();
		let existing = fixture.root.join("existing.json");

		fs::write(&existing, b"operator-owned\n").expect("existing output");

		let error = fixture
			.prepare(&existing, &fixture.root.join("attestation.json"))
			.expect_err("existing output must reject");

		assert_eq!(error.kind, ErrorKind::Configuration);
		assert_eq!(fs::read(&existing).expect("existing output"), b"operator-owned\n");
		assert!(!fixture.root.join("attestation.json").exists());

		let collision = fixture.root.join("collision.json");
		let error =
			fixture.prepare(&collision, &collision).expect_err("output collision must reject");

		assert_eq!(error.kind, ErrorKind::Configuration);
		assert!(!collision.exists());
	}

	#[cfg(unix)]
	#[test]
	fn local_artifact_resolver_rejects_symlinks() {
		let fixture = LocalReplayFixture::new();
		let bytes = fs::read(&fixture.manifest_path).expect("manifest bytes");
		let replacement = fixture.root.join("replacement-manifest.json");

		fs::write(&replacement, bytes).expect("replacement bytes");
		fs::remove_file(&fixture.manifest_path).expect("remove manifest");
		std::os::unix::fs::symlink(&replacement, &fixture.manifest_path).expect("manifest symlink");

		let stage = fixture.root.join("stage.json");
		let attestation = fixture.root.join("attestation.json");
		let error = fixture.prepare(&stage, &attestation).expect_err("symlink must reject");

		assert_eq!(error.kind, ErrorKind::Terminal(ReasonCode::ArtifactEvidenceMismatch));
		assert!(!stage.exists());
		assert!(!attestation.exists());
	}

	#[test]
	fn local_artifact_resolver_requires_the_content_address() {
		let root = temporary_test_root("artifact-content-address");
		let artifact_root = root.join("artifacts");
		let bytes = b"plan-bound artifact";
		let digest = hex::encode(Sha256::digest(bytes));
		let digest_root = artifact_root.join(&digest);

		fs::create_dir(&artifact_root).expect("artifact root");
		fs::create_dir(&digest_root).expect("digest root");
		fs::write(digest_root.join("stdout.jsonl"), bytes).expect("artifact");

		let resolver = LocalArtifactResolver::new(&artifact_root).expect("resolver");

		assert_eq!(
			resolver
				.resolve(&digest, "stdout.jsonl", bytes.len() as u64)
				.expect("content-addressed artifact"),
			bytes
		);

		fs::write(digest_root.join("stdout.jsonl"), b"plan-bound artifacU")
			.expect("same-size tamper");

		let error = resolver
			.resolve(&digest, "stdout.jsonl", bytes.len() as u64)
			.expect_err("digest mismatch must reject");

		assert_eq!(error.kind, ErrorKind::Terminal(ReasonCode::ArtifactEvidenceMismatch));

		fs::remove_dir_all(root).expect("remove fixture");
	}

	fn test_worker<T>(transport: T) -> Worker<T> {
		Worker {
			transport,
			endpoint: "https://gateway.invalid".to_owned(),
			token: Secret("token".to_owned()),
			signing_identity: super::VerifierSigningIdentity::from_secret([8; 32]),
			tasks: runner::synthetic_demo_tasks(),
			environment: VerifierEnvironment {
				schema_version: "aiq.verifier-environment.v2".to_owned(),
				task_set_id: AIQ_TASK_SET_ID.to_owned(),
				task_set_version: AIQ_TASK_SET_VERSION.to_owned(),
				benchmark_version: AIQ_BENCHMARK_VERSION.to_owned(),
				prompt_set_digest: format!("sha256:{}", "c".repeat(64)),
				expected_provenance: None,
				runner_commit: "d".repeat(40),
				region: "local-test".to_owned(),
				synthetic_test: true,
				artifact_resolver_endpoint: None,
			},
			environment_sha256: format!("sha256:{}", "e".repeat(64)),
			worker_binary_sha256: format!("sha256:{}", "f".repeat(64)),
			lease_seconds: 300,
			max_retries: 1,
			backoff: Duration::from_millis(1),
			evaluator_root: PathBuf::from("/unused-evaluator"),
			evaluator_runtime: None,
			official_admission: None,
			replay_root: PathBuf::from("/unused-replay"),
			replay_jobs: DEFAULT_REPLAY_JOBS,
			preparation_calls: AtomicUsize::new(0),
		}
	}

	#[test]
	fn worker_rejects_official_without_admission_before_replay_or_stage_submission() {
		let fixture = LocalReplayFixture::new();
		let envelope: protocol::SubmissionEnvelope =
			serde_json::from_slice(&fixture.package).expect("Official envelope");
		let run: RunRecord = serde_json::from_value(envelope.payload).expect("Official run");
		let package_sha256 = hex::encode(Sha256::digest(&fixture.package));
		let transport = FakeTransport {
			package: fixture.package.clone(),
			posts: Mutex::new(VecDeque::new()),
			terminal_claims: Mutex::new(Vec::new()),
			verification_request_bytes: Mutex::new(Vec::new()),
		};
		let worker = test_worker(transport);
		let mut claim = test_claim(run.run_id);

		claim.package_sha256.clone_from(&package_sha256);

		claim.object_content_sha256 = package_sha256;
		claim.body_bytes = fixture.package.len();

		let record = worker.process_claim(&claim);

		assert_eq!(record.disposition, "rejected");
		assert_eq!(record.reason_code, Some(ReasonCode::InvalidRunProvenance));
		assert_eq!(worker.preparation_calls.load(Ordering::Relaxed), 0);
		assert!(worker.transport.verification_request_bytes.lock().expect("requests").is_empty());
		assert_eq!(
			worker.transport.posts.lock().expect("posts").iter().cloned().collect::<Vec<_>>(),
			["renewed", "rejection_recorded_not_published", "acknowledged"]
		);
	}

	fn test_claim(idempotency_key: String) -> Claim {
		Claim {
			inbox_id: "223e4567-e89b-42d3-a456-426614174000".to_owned(),
			idempotency_key,
			package_sha256: "a".repeat(64),
			body_bytes: 1,
			object_content_sha256: "a".repeat(64),
			lease_token: "123e4567-e89b-42d3-a456-426614174000".to_owned(),
			lease_expires_at: "2026-07-25T12:05:00Z".to_owned(),
			attempt: 1,
			object_url: "https://storage.invalid/signed".to_owned(),
			object_url_expires_in_seconds: 300,
		}
	}

	fn retry_verification_fixture(
		statuses: impl IntoIterator<Item = u16>,
		max_retries: u32,
	) -> (Worker<RetryVerificationTransport>, Claim) {
		let runner_identity = SigningIdentity::from_secret([7; 32]);
		let mut run = runner::synthetic_demo(
			ScheduleConfig::default().slot("2000-01-01", ScheduleOccurrence::Day).expect("slot"),
			&TestArtifactSink,
		)
		.expect("run");

		submission::bind_synthetic_run_to_signer(&mut run, &runner_identity.node().node_id)
			.expect("bind");

		let envelope = runner_identity
			.sign(&run.run_id, protocol::RUN_PAYLOAD_TYPE, &run, TrustTier::Untrusted)
			.expect("sign");
		let package = submission::serialize_signed_package(&envelope).expect("serialize");
		let package_sha256 = hex::encode(Sha256::digest(&package));
		let transport = RetryVerificationTransport {
			package: package.clone(),
			verification_statuses: Mutex::new(statuses.into_iter().collect()),
			verification_bodies: Mutex::new(Vec::new()),
			object_calls: Mutex::new(0),
			requests: Mutex::new(Vec::new()),
		};
		let mut worker = test_worker(transport);
		let mut claim = test_claim(run.run_id);

		worker.max_retries = max_retries;
		worker.backoff = Duration::ZERO;

		claim.package_sha256.clone_from(&package_sha256);

		claim.body_bytes = package.len();
		claim.object_content_sha256 = package_sha256;

		(worker, claim)
	}

	fn local_fixture_preflight(
		node_id: String,
		codex_version: &str,
		capability_artifacts: Vec<ArtifactReference>,
	) -> CapabilityValidationReport {
		let codex_version = codex_version.to_owned();
		let marker_artifact = capability_artifacts
			.iter()
			.find(|artifact| artifact.kind == adapter::PREFLIGHT_MARKER_ARTIFACT_KIND)
			.expect("capability marker fixture")
			.clone();
		let models = MODEL_MATRIX
			.into_iter()
			.enumerate()
			.map(|(index, model)| {
				let preview = "AIQ_PREFLIGHT_OK".to_owned();
				let artifacts = if index == 0 {
					capability_artifacts.clone()
				} else {
					vec![marker_artifact.clone()]
				};
				let result_digest =
					artifacts.iter().find(|artifact| artifact.kind == "stdout.jsonl").map_or_else(
						|| format!("sha256:{}", hex::encode(Sha256::digest(preview.as_bytes()))),
						|artifact| artifact.content_hash.clone(),
					);
				let observed_at = "unix-ms:1".to_owned();
				let evidence_digest = adapter::configuration_evidence_digest(
					model,
					Some(&codex_version),
					&observed_at,
					ConfigurationProbeStatus::Available,
					Some(&result_digest),
					Some(&preview),
					&artifacts,
					None,
				)
				.expect("configuration evidence");

				CapabilityValidation {
					model,
					status: CapabilityValidationStatus::Available,
					reason: "active probe succeeded".to_owned(),
					probe: ConfigurationProbe {
						status: ConfigurationProbeStatus::Available,
						codex_version: Some(codex_version.clone()),
						observed_at,
						result_digest: Some(result_digest),
						result_preview: Some(preview),
						artifacts,
						evidence_digest,
						failure: None,
					},
				}
			})
			.collect();

		CapabilityValidationReport {
			schema_version: "aiq.capability-validation.v3".to_owned(),
			node_id,
			manifest_issues: Vec::new(),
			cli_probe: CliProbe {
				status: ProbeStatus::Available,
				version: Some(codex_version),
				failure: None,
			},
			authentication_probe: AuthenticationProbe {
				status: ProbeStatus::Available,
				mode: Some("chatgpt_subscription".to_owned()),
				failure: None,
			},
			models,
		}
	}

	fn local_fixture_provenance(
		task_set_digest: String,
		preflight_digest: String,
	) -> RunProvenanceCommitment {
		RunProvenanceCommitment {
			schema_version: "aiq.run-provenance.v3".to_owned(),
			run_class: RunClass::Official,
			corpus_release_id: "corpus_fixture".to_owned(),
			corpus_commitment_sha256: format!("sha256:{}", "1".repeat(64)),
			catalog_digest: aiq_runner::scoring::AIQ_CORE_TASK_IDENTITY_SHA256.to_owned(),
			task_set_digest,
			evaluator_digest: format!("sha256:{}", "8".repeat(64)),
			runtime_digest: format!("sha256:{}", "9".repeat(64)),
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

	#[test]
	fn utc_conversion_matches_epoch_and_leap_day() {
		assert_eq!(crate::utc_components(0).expect("epoch"), (1_970, 1, 1, 0, 0, 0));
		assert_eq!(
			crate::utc_components(1_709_164_799).expect("leap day"),
			(2_024, 2, 28, 23, 59, 59)
		);
		assert!(crate::now_utc_timestamp().expect("current UTC").ends_with('Z'));
	}

	#[test]
	fn production_schedule_conversion_uses_the_shared_iana_database() {
		let new_york =
			ScheduleConfig { timezone: "America/New_York".to_owned(), ..ScheduleConfig::default() };
		let slot =
			new_york.slot("2026-07-24", ScheduleOccurrence::Day).expect("reviewed IANA slot");
		let run = runner::synthetic_demo(slot, &TestArtifactSink).expect("synthetic run fixture");

		assert_eq!(
			crate::schedule_unix_ms(&run).expect("shared schedule conversion"),
			1_784_919_600_000
		);
	}

	#[test]
	fn secret_debug_output_is_redacted() {
		assert_eq!(format!("{:?}", Secret("sensitive".to_owned())), "Secret([REDACTED])");
	}

	#[test]
	fn common_placeholder_secrets_are_recognized() {
		for value in [
			"REPLACE_WITH_SECRET",
			"replace-me",
			"change-me",
			"placeholder",
			"example-only",
			"dummy",
			"your-token-here",
		] {
			assert!(crate::placeholder_text(value), "{value}");
		}

		assert!(!crate::placeholder_text("test-token"));
		assert!(!crate::placeholder_text("production-region-1"));
	}

	#[test]
	fn verifier_signing_key_requires_exact_lowercase_hex() {
		let lowercase = (0_u8..32).map(|byte| format!("{byte:02x}")).collect::<String>();

		assert_eq!(
			crate::parse_signing_key("TEST_KEY", &lowercase).expect("lowercase key"),
			<[u8; 32]>::try_from((0_u8..32).collect::<Vec<_>>()).expect("32 bytes")
		);

		for rejected in ["AB".repeat(32), format!("aB{}", "ab".repeat(31))] {
			let error = crate::parse_signing_key("TEST_KEY", &rejected)
				.expect_err("uppercase key material must be rejected");

			assert_eq!(error.kind, ErrorKind::Configuration);
			assert_eq!(
				error.message,
				"TEST_KEY must contain exactly 64 lowercase hexadecimal characters"
			);
		}

		let error = crate::parse_signing_key("TEST_KEY", &"ab".repeat(32))
			.expect_err("repeated placeholder key material must be rejected");

		assert_eq!(error.message, "TEST_KEY must not use repeated placeholder key material");
	}

	#[test]
	fn packaged_environment_example_matches_the_deserializer_and_fails_closed() {
		let source = include_str!("../../../config/verifier-environment.example.json");
		let environment: VerifierEnvironment =
			serde_json::from_str(source).expect("example must match the exact Rust shape");
		let serialized = serde_json::to_string(
			&serde_json::from_str::<serde_json::Value>(source).expect("example JSON"),
		)
		.expect("example serialization");

		assert_eq!(environment.schema_version, "aiq.verifier-environment.v2");
		assert_eq!(
			environment.expected_provenance.as_ref().expect("provenance").run_class,
			RunClass::Official
		);
		assert!(!serialized.to_ascii_lowercase().contains("secret"));
		assert_eq!(
			crate::validate_environment(&environment)
				.expect_err("unreplaced example must fail closed")
				.message,
			"verifier environment contains placeholder commitments"
		);
	}

	#[test]
	fn packaged_verifier_guide_has_no_second_complete_environment_template() {
		let guide = include_str!("../README.md");

		assert!(guide.contains("config/verifier-environment.example.json"));
		assert!(guide.contains("structurally and semantically self-consistent"));
		assert!(!guide.contains("\"schema_version\": \"aiq.verifier-environment.v2\""));
	}

	#[test]
	fn test_owned_valid_environment_fixture_succeeds() {
		let source = include_str!("../tests/fixtures/valid-synthetic-verifier-environment.json");
		let environment: VerifierEnvironment = serde_json::from_str(source)
			.expect("test-owned fixture must match the exact Rust shape");

		assert!(environment.synthetic_test);
		assert!(environment.expected_provenance.is_none());

		crate::validate_environment(&environment)
			.expect("test-owned fixture must remain structurally and semantically self-consistent");
	}

	#[test]
	fn verifier_region_uses_the_public_identifier_grammar() {
		let source = include_str!("../tests/fixtures/valid-synthetic-verifier-environment.json");
		let environment: VerifierEnvironment = serde_json::from_str(source)
			.expect("test-owned fixture must match the exact Rust shape");

		for invalid in ["us east 1".to_owned(), "x".repeat(65)] {
			let mut changed = environment.clone();

			changed.region = invalid;

			assert_eq!(
				crate::validate_environment(&changed)
					.expect_err("invalid region must fail closed")
					.message,
				"verifier environment is invalid"
			);
		}
	}

	#[test]
	fn environment_validation_command_requires_one_environment_path() {
		assert!(
			ValidateEnvironmentCli::try_parse_from([
				"aiq-verifier validate-environment",
				"--environment",
				"environment.json",
			])
			.is_ok()
		);
		assert!(
			ValidateEnvironmentCli::try_parse_from(["aiq-verifier validate-environment"]).is_err()
		);
	}

	#[test]
	fn verifier_url_policy_parses_the_authority_before_allowing_loopback_http() {
		for allowed in [
			"http://127.0.0.1:3100/api/claims",
			"http://localhost:3100/api/claims?lease=1",
			"http://[::1]:3100/api/claims",
			"https://gateway.invalid/api/claims",
		] {
			assert!(crate::transport_url_is_allowed(allowed, true), "{allowed}");
		}
		for rejected in [
			"http://localhost:3100@remote.invalid/api/claims",
			"http://127.0.0.1:3100@remote.invalid/api/claims",
			"http://localhost.invalid:3100/api/claims",
			"http://remote.invalid/api/claims",
			"https://user@gateway.invalid/api/claims",
			"not-a-url",
		] {
			assert!(!crate::transport_url_is_allowed(rejected, true), "{rejected}");
		}

		assert!(!crate::transport_url_is_allowed("http://localhost:3100/api/claims", false));
	}

	#[test]
	fn verifier_endpoint_policy_requires_one_exact_origin() {
		assert_eq!(
			crate::validate_endpoint("http://localhost:3100/", true).expect("loopback origin"),
			"http://localhost:3100"
		);
		assert_eq!(
			crate::validate_endpoint("https://gateway.invalid/", false).expect("HTTPS origin"),
			"https://gateway.invalid"
		);

		for rejected in [
			"http://localhost:3100@remote.invalid",
			"https://user@gateway.invalid",
			"https://gateway.invalid/api",
			"https://gateway.invalid?query=1",
			"https://gateway.invalid#fragment",
		] {
			assert!(crate::validate_endpoint(rejected, true).is_err(), "{rejected}");
		}
	}

	#[test]
	fn built_in_demo_tasks_are_explicit_and_synthetic_only() {
		let required = [
			"aiq-verifier",
			"--endpoint",
			"http://127.0.0.1:3100",
			"--environment",
			"environment.json",
			"--replay-root",
			"replay",
			"--allow-loopback-http",
		];
		let mut demo_arguments = required.to_vec();

		demo_arguments.push("--synthetic-demo-tasks");

		let demo = Cli::try_parse_from(demo_arguments).expect("explicit synthetic demo");

		assert!(demo.synthetic_demo_tasks);
		assert!(demo.tasks.is_none());
		assert!(Cli::try_parse_from(required).is_err());

		let mut conflicting = required.to_vec();

		conflicting.extend(["--synthetic-demo-tasks", "--tasks", "hidden"]);

		assert!(Cli::try_parse_from(conflicting).is_err());
		assert_eq!(
			crate::load_configured_tasks(None, true, true).expect("synthetic task source").len(),
			72
		);
		assert!(crate::load_configured_tasks(None, true, false).is_err());
	}

	#[test]
	fn incomplete_claim_dispositions_require_a_nonzero_worker_exit() {
		let record = |disposition| VerificationRecord {
			schema_version: RECORD_SCHEMA,
			inbox_id: "223e4567-e89b-42d3-a456-426614174000".to_owned(),
			idempotency_key: format!("run_{}", "d".repeat(64)),
			package_sha256: "a".repeat(64),
			disposition,
			reason_code: None,
			worker_name: "aiq-verifier",
			worker_version: "0.1.0",
			worker_binary_sha256: format!("sha256:{}", "b".repeat(64)),
			environment_sha256: format!("sha256:{}", "c".repeat(64)),
			official_calibration_policy: OfficialCalibrationPolicy::default(),
			official_calibration_observed: None,
			replay_scope: "verification_incomplete",
			attempt: 1,
			error_class: None,
			error_code: None,
			error_detail: None,
		};

		for disposition in ["lease_lost", "retry", "worker_error"] {
			assert!(record(disposition).requires_operator_attention());
		}
		for disposition in ["verified", "rejected"] {
			assert!(!record(disposition).requires_operator_attention());
		}
	}

	#[test]
	fn shared_protocol_rejects_a_modified_package() {
		let identity = SigningIdentity::from_secret([7; 32]);
		let mut run = runner::synthetic_demo(
			ScheduleConfig::default().slot("2000-01-01", ScheduleOccurrence::Day).expect("slot"),
			&TestArtifactSink,
		)
		.expect("run");

		submission::bind_synthetic_run_to_signer(&mut run, &identity.node().node_id).expect("bind");

		let mut envelope = identity
			.sign(&run.run_id, protocol::RUN_PAYLOAD_TYPE, &run, TrustTier::Untrusted)
			.expect("sign");
		let replacement = if &envelope.content_hash[7..8] == "f" { "e" } else { "f" };

		envelope.content_hash.replace_range(7..8, replacement);

		assert!(envelope.verify(&BTreeSet::new()).is_err());
	}

	#[test]
	fn terminal_rejection_accepts_the_exact_gateway_response_and_acknowledges() {
		let runner_identity = SigningIdentity::from_secret([7; 32]);
		let mut run = runner::synthetic_demo(
			ScheduleConfig::default().slot("2000-01-01", ScheduleOccurrence::Day).expect("slot"),
			&TestArtifactSink,
		)
		.expect("run");

		submission::bind_synthetic_run_to_signer(&mut run, &runner_identity.node().node_id)
			.expect("bind");

		let mut envelope = runner_identity
			.sign(&run.run_id, protocol::RUN_PAYLOAD_TYPE, &run, TrustTier::Untrusted)
			.expect("sign");

		envelope.signature.replace_range(0..2, "00");

		let package = protocol::canonical_json(&envelope).expect("serialize tampered envelope");
		let package_sha256 = hex::encode(Sha256::digest(&package));
		let transport = FakeTransport {
			package: package.clone(),
			posts: Mutex::new(VecDeque::new()),
			terminal_claims: Mutex::new(Vec::new()),
			verification_request_bytes: Mutex::new(Vec::new()),
		};
		let worker = test_worker(transport);
		let mut claim = test_claim(run.run_id);

		claim.package_sha256.clone_from(&package_sha256);

		claim.body_bytes = package.len();
		claim.object_content_sha256 = package_sha256;

		assert!(matches!(
			worker.verify_claim(&claim).expect("terminal rejection"),
			PackageDisposition::Rejected(ReasonCode::InvalidPackageSignature, None)
		));
		assert_eq!(
			worker.transport.posts.lock().expect("posts").iter().collect::<Vec<_>>(),
			vec!["renewed", "rejection_recorded_not_published", "acknowledged"]
		);
		assert_eq!(
			worker.transport.terminal_claims.lock().expect("terminal claims").as_slice(),
			[serde_json::json!({
				"inbox_id": claim.inbox_id,
				"lease_token": claim.lease_token,
				"attempt": claim.attempt,
			})]
		);
	}

	#[test]
	fn terminal_gateway_responses_are_strict_and_identity_bound() {
		assert!(
			crate::parse_json::<VerificationGatewayResponse>(
				br#"{"status":"verified_published","matrix_batch_id":"run","package_sha256":"package"}"#,
				"verification response",
			)
			.is_ok()
		);
		assert!(
			crate::parse_json::<VerificationGatewayResponse>(
				br#"{"status":"verified_published","matrix_batch_id":"run","package_sha256":"package","unexpected":true}"#,
				"verification response",
			)
			.is_err()
		);
		assert!(
			crate::parse_json::<RejectionGatewayResponse>(
				br#"{"status":"rejection_recorded_not_published","published":false,"matrix_batch_id":"run","package_sha256":"package"}"#,
				"rejection response",
			)
			.is_ok()
		);
		assert!(
			crate::parse_json::<RejectionGatewayResponse>(
				br#"{"status":"rejection_recorded_not_published","published":"false","matrix_batch_id":"run","package_sha256":"package"}"#,
				"rejection response",
			)
			.is_err()
		);
	}

	#[test]
	fn fake_loopback_server_exercises_bounded_storage_download() {
		let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
		let address = listener.local_addr().expect("address");
		let observed = Arc::new(Mutex::new(Vec::new()));
		let server_observed = Arc::clone(&observed);
		let server = thread::spawn(move || {
			let (mut stream, _) = listener.accept().expect("accept");
			let mut request = [0_u8; 2_048];
			let read = stream.read(&mut request).expect("read");

			server_observed.lock().expect("observed").extend_from_slice(&request[..read]);

			let body = b"private-package";

			write!(
				stream,
				"HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
				body.len()
			)
			.expect("headers");

			stream.write_all(body).expect("body");
		});
		let transport = UreqTransport::new(Duration::from_secs(2), true, DEFAULT_REPLAY_JOBS);
		let response =
			transport.get_object(&format!("http://{address}/signed-object")).expect("download");

		server.join().expect("server");

		assert_eq!(response.status, 200);
		assert_eq!(response.body, b"private-package");

		let request = observed.lock().expect("observed");

		assert!(request.starts_with(b"GET /signed-object HTTP/1.1"));
	}

	#[test]
	fn claim_bound_artifact_resolver_fetches_a_short_lived_private_object() {
		let bytes = br#"{"results":[],"schema_version":"aiq.evaluator-results.v1"}"#.to_vec();
		let transport = ArtifactTransport { bytes: bytes.clone(), kind: "evaluator-results.json" };
		let token = Secret("token".to_owned());
		let lease = NoopLease;
		let resolver = HttpArtifactResolver {
			transport: &transport,
			token: &token,
			endpoint: "https://gateway.invalid",
			inbox_id: "inbox",
			lease_token: "lease",
			lease: Some(&lease),
			max_retries: 3,
			backoff: Duration::from_millis(1),
		};
		let digest = hex::encode(Sha256::digest(&bytes));

		assert_eq!(
			resolver
				.resolve(
					&digest,
					"evaluator-results.json",
					u64::try_from(bytes.len()).expect("size"),
				)
				.expect("resolve"),
			bytes
		);
	}

	#[test]
	fn artifact_resolver_retries_transient_gateway_statuses() {
		for status in [408, 409, 429, 500, 599] {
			let bytes = b"workspace snapshot".to_vec();
			let transport = RetryArtifactTransport {
				bytes: bytes.clone(),
				resolver_statuses: Mutex::new(VecDeque::from([status, 200])),
				object_statuses: Mutex::new(VecDeque::from([200])),
				resolver_calls: Mutex::new(0),
				object_calls: Mutex::new(0),
			};
			let token = Secret("token".to_owned());
			let lease = NoopLease;
			let resolver = HttpArtifactResolver {
				transport: &transport,
				token: &token,
				endpoint: "https://gateway.invalid",
				inbox_id: "inbox",
				lease_token: "lease",
				lease: Some(&lease),
				max_retries: 2,
				backoff: Duration::ZERO,
			};
			let digest = hex::encode(Sha256::digest(&bytes));

			assert_eq!(
				resolver
					.resolve(&digest, "workspace-snapshot.json", bytes.len() as u64)
					.expect("transient resolver status must recover"),
				bytes,
				"HTTP {status}"
			);
			assert_eq!(*transport.resolver_calls.lock().expect("resolver calls"), 2);
			assert_eq!(*transport.object_calls.lock().expect("object calls"), 1);
		}
	}

	#[test]
	fn artifact_resolver_refreshes_signed_urls_after_transient_object_statuses() {
		for status in [403, 408, 409, 429, 500, 599] {
			let bytes = b"workspace snapshot".to_vec();
			let transport = RetryArtifactTransport {
				bytes: bytes.clone(),
				resolver_statuses: Mutex::new(VecDeque::new()),
				object_statuses: Mutex::new(VecDeque::from([status, 200])),
				resolver_calls: Mutex::new(0),
				object_calls: Mutex::new(0),
			};
			let token = Secret("token".to_owned());
			let lease = NoopLease;
			let resolver = HttpArtifactResolver {
				transport: &transport,
				token: &token,
				endpoint: "https://gateway.invalid",
				inbox_id: "inbox",
				lease_token: "lease",
				lease: Some(&lease),
				max_retries: 2,
				backoff: Duration::ZERO,
			};
			let digest = hex::encode(Sha256::digest(&bytes));

			assert_eq!(
				resolver
					.resolve(&digest, "workspace-snapshot.json", bytes.len() as u64)
					.expect("transient signed-object status must recover"),
				bytes,
				"HTTP {status}"
			);
			assert_eq!(*transport.resolver_calls.lock().expect("resolver calls"), 2);
			assert_eq!(*transport.object_calls.lock().expect("object calls"), 2);
		}
	}

	#[test]
	fn exhausted_signed_object_retries_remain_transient() {
		let bytes = b"workspace snapshot".to_vec();
		let transport = RetryArtifactTransport {
			bytes: bytes.clone(),
			resolver_statuses: Mutex::new(VecDeque::new()),
			object_statuses: Mutex::new(VecDeque::from([403, 403, 403])),
			resolver_calls: Mutex::new(0),
			object_calls: Mutex::new(0),
		};
		let token = Secret("token".to_owned());
		let lease = NoopLease;
		let resolver = HttpArtifactResolver {
			transport: &transport,
			token: &token,
			endpoint: "https://gateway.invalid",
			inbox_id: "inbox",
			lease_token: "lease",
			lease: Some(&lease),
			max_retries: 3,
			backoff: Duration::ZERO,
		};
		let digest = hex::encode(Sha256::digest(&bytes));
		let error = resolver
			.resolve(&digest, "workspace-snapshot.json", bytes.len() as u64)
			.expect_err("retry budget must be bounded");

		assert!(error.is_transient());
		assert_eq!(*transport.resolver_calls.lock().expect("resolver calls"), 3);
		assert_eq!(*transport.object_calls.lock().expect("object calls"), 3);
	}

	#[test]
	fn artifact_resolver_preserves_missing_and_identity_failures_as_terminal() {
		let bytes = b"workspace snapshot".to_vec();
		let token = Secret("token".to_owned());
		let lease = NoopLease;
		let missing_transport = RetryArtifactTransport {
			bytes: bytes.clone(),
			resolver_statuses: Mutex::new(VecDeque::from([404])),
			object_statuses: Mutex::new(VecDeque::new()),
			resolver_calls: Mutex::new(0),
			object_calls: Mutex::new(0),
		};
		let missing_resolver = HttpArtifactResolver {
			transport: &missing_transport,
			token: &token,
			endpoint: "https://gateway.invalid",
			inbox_id: "inbox",
			lease_token: "lease",
			lease: Some(&lease),
			max_retries: 3,
			backoff: Duration::ZERO,
		};
		let digest = hex::encode(Sha256::digest(&bytes));
		let missing = missing_resolver
			.resolve(&digest, "workspace-snapshot.json", bytes.len() as u64)
			.expect_err("missing artifact must reject");

		assert_eq!(missing.kind, ErrorKind::Terminal(ReasonCode::ArtifactEvidenceUnavailable));
		assert_eq!(*missing_transport.resolver_calls.lock().expect("resolver calls"), 1);
		assert_eq!(*missing_transport.object_calls.lock().expect("object calls"), 0);

		let identity_transport =
			ArtifactTransport { bytes: bytes.clone(), kind: "workspace-snapshot.json" };
		let identity_resolver = HttpArtifactResolver {
			transport: &identity_transport,
			token: &token,
			endpoint: "https://gateway.invalid",
			inbox_id: "inbox",
			lease_token: "lease",
			lease: Some(&lease),
			max_retries: 3,
			backoff: Duration::ZERO,
		};
		let mismatch = identity_resolver
			.resolve(&"0".repeat(64), "workspace-snapshot.json", bytes.len() as u64)
			.expect_err("mismatched resolver identity must reject");

		assert_eq!(mismatch.kind, ErrorKind::Terminal(ReasonCode::ArtifactEvidenceMismatch));
	}

	#[test]
	fn artifact_resolver_does_not_retry_terminal_http_statuses() {
		let bytes = b"workspace snapshot".to_vec();
		let digest = hex::encode(Sha256::digest(&bytes));
		let token = Secret("token".to_owned());
		let lease = NoopLease;

		for status in [400, 401, 403, 404] {
			let transport = RetryArtifactTransport {
				bytes: bytes.clone(),
				resolver_statuses: Mutex::new(VecDeque::from([status])),
				object_statuses: Mutex::new(VecDeque::new()),
				resolver_calls: Mutex::new(0),
				object_calls: Mutex::new(0),
			};
			let resolver = HttpArtifactResolver {
				transport: &transport,
				token: &token,
				endpoint: "https://gateway.invalid",
				inbox_id: "inbox",
				lease_token: "lease",
				lease: Some(&lease),
				max_retries: 3,
				backoff: Duration::ZERO,
			};
			let error = resolver
				.resolve(&digest, "workspace-snapshot.json", bytes.len() as u64)
				.expect_err("terminal resolver response must fail");

			if matches!(status, 401 | 403) {
				assert_eq!(error.kind, ErrorKind::Configuration, "HTTP {status}");
			} else {
				assert_eq!(
					error.kind,
					ErrorKind::Terminal(ReasonCode::ArtifactEvidenceUnavailable),
					"HTTP {status}"
				);
			}

			assert_eq!(*transport.resolver_calls.lock().expect("resolver calls"), 1);
			assert_eq!(*transport.object_calls.lock().expect("object calls"), 0);
		}
		for status in [400, 401, 404] {
			let transport = RetryArtifactTransport {
				bytes: bytes.clone(),
				resolver_statuses: Mutex::new(VecDeque::new()),
				object_statuses: Mutex::new(VecDeque::from([status])),
				resolver_calls: Mutex::new(0),
				object_calls: Mutex::new(0),
			};
			let resolver = HttpArtifactResolver {
				transport: &transport,
				token: &token,
				endpoint: "https://gateway.invalid",
				inbox_id: "inbox",
				lease_token: "lease",
				lease: Some(&lease),
				max_retries: 3,
				backoff: Duration::ZERO,
			};
			let error = resolver
				.resolve(&digest, "workspace-snapshot.json", bytes.len() as u64)
				.expect_err("terminal signed-object response must fail");

			assert!(matches!(error.kind, ErrorKind::Terminal(_)), "HTTP {status}");
			assert_eq!(*transport.resolver_calls.lock().expect("resolver calls"), 1);
			assert_eq!(*transport.object_calls.lock().expect("object calls"), 1);
		}
	}

	#[test]
	fn artifact_transport_errors_retry_only_when_transient() {
		assert!(matches!(
			ArtifactResolveAttemptError::from_transport(WorkerError::transient("network")),
			ArtifactResolveAttemptError::Retry(_)
		));
		assert!(matches!(
			ArtifactResolveAttemptError::from_transport(WorkerError::configuration("URL")),
			ArtifactResolveAttemptError::Final(_)
		));
	}

	#[test]
	fn verification_http_status_contract_separates_retryable_and_terminal_responses() {
		for status in [408, 409, 429, 500, 502, 599] {
			assert!(crate::retryable_verification_status(status), "HTTP {status}");
		}
		for status in [200, 400, 401, 403, 404, 422] {
			assert!(!crate::retryable_verification_status(status), "HTTP {status}");
		}
	}

	#[test]
	fn verification_retries_reuse_prepared_replay_until_success() {
		let (worker, claim) = retry_verification_fixture([500, 502, 200], 3);

		assert!(matches!(
			worker.verify_claim(&claim).expect("verification retry must recover"),
			PackageDisposition::Verified("commitments_verified", _)
		));
		assert_eq!(*worker.transport.object_calls.lock().expect("object calls"), 1);
		assert_eq!(worker.preparation_calls.load(Ordering::Relaxed), 1);
		assert_eq!(
			worker.transport.requests.lock().expect("requests").as_slice(),
			[
				"renewed",
				"verification_500",
				"verification_502",
				"verification_200",
				"ack_completed",
			]
		);

		let bodies = worker.transport.verification_bodies.lock().expect("verification bodies");

		assert_eq!(bodies.len(), 3);
		assert!(bodies.windows(2).all(|pair| pair[0] == pair[1]));
	}

	#[test]
	fn exhausted_verification_retries_acknowledge_queue_retry_without_replay() {
		let (worker, claim) = retry_verification_fixture([500, 502, 503], 3);
		let record = worker.process_claim(&claim);

		assert_eq!(record.disposition, "retry");
		assert_eq!(record.replay_scope, "verification_incomplete");
		assert_eq!(record.error_class, Some(OperatorErrorClass::Transient));
		assert_eq!(record.error_code, Some("verification_gateway_unavailable"));
		assert_eq!(record.error_detail.as_deref(), Some("verification gateway is unavailable"));
		assert_eq!(*worker.transport.object_calls.lock().expect("object calls"), 1);
		assert_eq!(worker.preparation_calls.load(Ordering::Relaxed), 1);
		assert_eq!(
			worker.transport.requests.lock().expect("requests").as_slice(),
			["renewed", "verification_500", "verification_502", "verification_503", "ack_retry",]
		);

		let bodies = worker.transport.verification_bodies.lock().expect("verification bodies");

		assert_eq!(bodies.len(), 3);
		assert!(bodies.windows(2).all(|pair| pair[0] == pair[1]));
	}

	#[test]
	fn evaluator_replay_failures_acknowledge_retry_without_rejection() {
		for error in [
			WorkerError::transient("controlled evaluator replay failed"),
			crate::apply_replay_confirmation_policy(
				WorkerError::terminal(
					ReasonCode::EvaluatorReplayMismatch,
					"first replay output differed",
				),
				1,
			),
		] {
			let worker =
				test_worker(RenewalTransport { status: 200, requests: Mutex::new(Vec::new()) });
			let claim = test_claim(format!("run_{}", "b".repeat(64)));
			let record = worker.record_claim_result(&claim, Err(error));

			assert_eq!(record.disposition, "retry");
			assert_eq!(record.reason_code, None);
			assert_eq!(record.error_class, Some(OperatorErrorClass::Transient));
			assert_eq!(record.idempotency_key, claim.idempotency_key);

			let requests = worker.transport.requests.lock().expect("requests");

			assert_eq!(requests.len(), 1);
			assert_eq!(requests[0]["action"], "ack");
			assert_eq!(requests[0]["disposition"], "retry");
		}
	}

	#[test]
	fn repeated_evaluator_output_difference_remains_terminal() {
		let error = crate::apply_replay_confirmation_policy(
			WorkerError::terminal(
				ReasonCode::EvaluatorReplayMismatch,
				"repeated replay output differed",
			),
			2,
		);

		assert_eq!(error.kind, ErrorKind::Terminal(ReasonCode::EvaluatorReplayMismatch));
	}

	#[test]
	fn fake_gateway_and_storage_verify_and_ack_a_complete_package() {
		let runner_identity = SigningIdentity::from_secret([7; 32]);
		let mut run = runner::synthetic_demo(
			ScheduleConfig::default().slot("2000-01-01", ScheduleOccurrence::Day).expect("slot"),
			&TestArtifactSink,
		)
		.expect("run");

		submission::bind_synthetic_run_to_signer(&mut run, &runner_identity.node().node_id)
			.expect("bind");

		let envelope = runner_identity
			.sign(&run.run_id, protocol::RUN_PAYLOAD_TYPE, &run, TrustTier::Untrusted)
			.expect("sign");
		let package = submission::serialize_signed_package(&envelope).expect("serialize");
		let package_sha256 = hex::encode(Sha256::digest(&package));

		assert_eq!(run.results.len(), 1_224);

		let transport = FakeTransport {
			package: package.clone(),
			posts: Mutex::new(VecDeque::new()),
			terminal_claims: Mutex::new(Vec::new()),
			verification_request_bytes: Mutex::new(Vec::new()),
		};
		let worker = test_worker(transport);
		let mut claim = test_claim(run.run_id);

		claim.package_sha256.clone_from(&package_sha256);

		claim.body_bytes = package.len();
		claim.object_content_sha256 = package_sha256;

		assert!(matches!(
			worker.verify_claim(&claim).expect("verify"),
			PackageDisposition::Verified("commitments_verified", _)
		));
		assert_eq!(
			worker.transport.posts.lock().expect("posts").iter().collect::<Vec<_>>(),
			vec!["renewed", "verified_published", "acknowledged"]
		);

		let request_bytes =
			worker.transport.verification_request_bytes.lock().expect("request sizes");

		assert_eq!(request_bytes.len(), 1);
		assert!(request_bytes[0] <= MAX_VERIFICATION_REQUEST_BYTES);
		assert_eq!(
			worker.transport.terminal_claims.lock().expect("terminal claims").as_slice(),
			[serde_json::json!({
				"inbox_id": claim.inbox_id,
				"lease_token": claim.lease_token,
				"attempt": claim.attempt,
			})]
		);
	}

	#[test]
	fn confirmed_publication_is_not_downgraded_by_post_terminal_ack_conflict() {
		let runner_identity = SigningIdentity::from_secret([7; 32]);
		let mut run = runner::synthetic_demo(
			ScheduleConfig::default().slot("2000-01-01", ScheduleOccurrence::Day).expect("slot"),
			&TestArtifactSink,
		)
		.expect("run");

		submission::bind_synthetic_run_to_signer(&mut run, &runner_identity.node().node_id)
			.expect("bind");

		let envelope = runner_identity
			.sign(&run.run_id, protocol::RUN_PAYLOAD_TYPE, &run, TrustTier::Untrusted)
			.expect("sign");
		let package = submission::serialize_signed_package(&envelope).expect("serialize");
		let package_sha256 = hex::encode(Sha256::digest(&package));
		let transport = AckConflictTransport {
			inner: FakeTransport {
				package: package.clone(),
				posts: Mutex::new(VecDeque::new()),
				terminal_claims: Mutex::new(Vec::new()),
				verification_request_bytes: Mutex::new(Vec::new()),
			},
		};
		let worker = test_worker(transport);
		let mut claim = test_claim(run.run_id);

		claim.package_sha256.clone_from(&package_sha256);

		claim.body_bytes = package.len();
		claim.object_content_sha256 = package_sha256;

		assert!(matches!(
			worker.verify_claim(&claim).expect("confirmed verification"),
			PackageDisposition::Verified("commitments_verified", _)
		));
		assert_eq!(
			worker.transport.inner.posts.lock().expect("posts").iter().collect::<Vec<_>>(),
			vec!["renewed", "verified_published", "ack_conflict"]
		);
	}

	#[test]
	fn recomputed_recovery_attestation_is_fresh_valid_and_semantically_identical() {
		let runner_identity = SigningIdentity::from_secret([7; 32]);
		let mut run = runner::synthetic_demo(
			ScheduleConfig::default().slot("2000-01-01", ScheduleOccurrence::Day).expect("slot"),
			&TestArtifactSink,
		)
		.expect("run");

		submission::bind_synthetic_run_to_signer(&mut run, &runner_identity.node().node_id)
			.expect("bind");

		let envelope = runner_identity
			.sign(&run.run_id, protocol::RUN_PAYLOAD_TYPE, &run, TrustTier::Untrusted)
			.expect("sign");
		let package = submission::serialize_signed_package(&envelope).expect("serialize");
		let package_sha256 = hex::encode(Sha256::digest(&package));
		let transport = FakeTransport {
			package: package.clone(),
			posts: Mutex::new(VecDeque::new()),
			terminal_claims: Mutex::new(Vec::new()),
			verification_request_bytes: Mutex::new(Vec::new()),
		};
		let worker = test_worker(transport);
		let mut claim = test_claim(run.run_id);

		claim.package_sha256.clone_from(&package_sha256);

		claim.body_bytes = package.len();
		claim.object_content_sha256 = package_sha256;

		let first =
			worker.prepare_verification(&claim, &package, &NoopLease).expect("first preparation");

		thread::sleep(Duration::from_millis(2));

		let recovered = worker
			.prepare_verification(&claim, &package, &NoopLease)
			.expect("recovered preparation");
		let (first_stage, first_attestation) = official_evidence(&first);
		let (recovered_stage, recovered_attestation) = official_evidence(&recovered);

		assert_eq!(first_stage, recovered_stage);

		first_attestation
			.verify(first_stage, worker.signing_identity.node())
			.expect("first signature");
		recovered_attestation
			.verify(recovered_stage, worker.signing_identity.node())
			.expect("recovery signature");

		let mut first_value = serde_json::to_value(first_attestation).expect("first JSON");
		let mut recovered_value =
			serde_json::to_value(recovered_attestation).expect("recovery JSON");
		let first_object = first_value.as_object_mut().expect("first object");
		let recovered_object = recovered_value.as_object_mut().expect("recovery object");

		assert_ne!(
			first_object.remove("observed_unix_ms"),
			recovered_object.remove("observed_unix_ms")
		);
		assert_ne!(first_object.remove("signature"), recovered_object.remove("signature"));
		assert_eq!(first_value, recovered_value);
	}

	#[test]
	fn synthetic_metadata_preserves_the_signed_schedule_slot() {
		let run = runner::synthetic_demo(
			ScheduleConfig::default()
				.slot("2026-07-25", ScheduleOccurrence::Day)
				.expect("fixture slot"),
			&TestArtifactSink,
		)
		.expect("synthetic run");
		let scheduled_unix_ms =
			run.schedule_slot.scheduled_unix_ms().expect("resolved signed schedule");
		let environment = VerifierEnvironment {
			schema_version: "aiq.verifier-environment.v2".to_owned(),
			task_set_id: AIQ_TASK_SET_ID.to_owned(),
			task_set_version: AIQ_TASK_SET_VERSION.to_owned(),
			benchmark_version: AIQ_BENCHMARK_VERSION.to_owned(),
			prompt_set_digest: run.task_set_hash.clone(),
			expected_provenance: None,
			runner_commit: "0000000000000000000000000000000000000000".to_owned(),
			region: "local-synthetic".to_owned(),
			synthetic_test: true,
			artifact_resolver_endpoint: None,
		};
		let metadata = crate::metadata_for(&run, &environment).expect("synthetic metadata");

		assert_ne!(scheduled_unix_ms, 0);
		assert_eq!(run.started_unix_ms, scheduled_unix_ms);
		assert_eq!(metadata.scheduled_unix_ms, scheduled_unix_ms);
	}

	#[test]
	fn verification_request_boundary_is_enforced_locally() {
		assert!(
			crate::enforce_verification_request_bound(&vec![0; MAX_VERIFICATION_REQUEST_BYTES])
				.is_ok()
		);

		let error =
			crate::enforce_verification_request_bound(&vec![0; MAX_VERIFICATION_REQUEST_BYTES + 1])
				.expect_err("oversized verification request");

		assert_eq!(error.kind, ErrorKind::Terminal(ReasonCode::NormalizationMismatch));
	}

	#[test]
	fn periodic_lease_renewal_uses_the_exact_claim_contract() {
		let worker =
			test_worker(RenewalTransport { status: 200, requests: Mutex::new(Vec::new()) });
		let claim = test_claim(format!("run_{}", "b".repeat(64)));
		let lease = ClaimLease::new(&worker, &claim);

		lease.state.lock().expect("lease state").last_renewed =
			Instant::now() - LEASE_RENEWAL_INTERVAL;

		lease.maintain().expect("renew lease");

		let requests = worker.transport.requests.lock().expect("renewal requests");

		assert_eq!(requests.len(), 1);
		assert_eq!(
			requests[0],
			serde_json::json!({
				"action": "renew",
				"inbox_id": claim.inbox_id,
				"lease_seconds": RENEWED_LEASE_SECONDS,
				"lease_token": claim.lease_token,
			})
		);
	}

	#[test]
	fn heartbeat_records_lease_loss_and_blocks_terminal_operations() {
		let worker =
			test_worker(RenewalTransport { status: 409, requests: Mutex::new(Vec::new()) });
		let claim = test_claim(format!("run_{}", "b".repeat(64)));
		let lease = ClaimLease::with_interval(&worker, &claim, Duration::from_millis(1));
		let heartbeat_error = thread::scope(|scope| {
			let heartbeat = scope.spawn(|| lease.run_heartbeat());

			heartbeat.join().expect("heartbeat joins").expect_err("lease loss")
		});

		assert!(heartbeat_error.is_transient());

		let called = AtomicBool::new(false);
		let blocked = lease
			.with_terminal_lease(
				|| {
					called.store(true, Ordering::SeqCst);

					Ok(())
				},
				|_| true,
			)
			.expect_err("lost lease blocks terminal operation");

		assert!(blocked.is_transient());
		assert!(!called.load(Ordering::SeqCst));
	}

	#[test]
	fn heartbeat_renews_and_joins_before_claim_completion() {
		let worker =
			test_worker(RenewalTransport { status: 200, requests: Mutex::new(Vec::new()) });
		let claim = test_claim(format!("run_{}", "b".repeat(64)));
		let lease = ClaimLease::with_interval(&worker, &claim, Duration::from_millis(1));

		thread::scope(|scope| {
			let heartbeat = scope.spawn(|| lease.run_heartbeat());
			let deadline = Instant::now() + Duration::from_secs(1);

			while worker.transport.requests.lock().expect("renewal requests").is_empty() {
				assert!(Instant::now() < deadline, "heartbeat did not renew the lease");

				thread::yield_now();
			}

			lease.stop();
			heartbeat.join().expect("heartbeat joins").expect("heartbeat stops cleanly");
		});

		assert!(!worker.transport.requests.lock().expect("renewal requests").is_empty());
	}

	#[test]
	fn heartbeat_stop_guard_survives_unwind() {
		let worker =
			test_worker(RenewalTransport { status: 200, requests: Mutex::new(Vec::new()) });
		let claim = test_claim(format!("run_{}", "b".repeat(64)));
		let lease = ClaimLease::with_interval(&worker, &claim, Duration::from_secs(60));
		let started = Instant::now();
		let unwind = panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
			let _ = lease.with_heartbeat(|| panic!("fixture claim panic"));
		}));

		assert!(unwind.is_err());
		assert!(started.elapsed() < Duration::from_secs(1));
		assert!(lease.state.lock().expect("lease state").stopped);
	}

	#[test]
	fn heartbeat_creation_failure_stops_without_running_the_claim() {
		let worker =
			test_worker(RenewalTransport { status: 200, requests: Mutex::new(Vec::new()) });
		let claim = test_claim(format!("run_{}", "b".repeat(64)));
		let called = AtomicBool::new(false);
		let mut lease = ClaimLease::with_interval(&worker, &claim, Duration::from_secs(60));

		lease.heartbeat_spawn_failure = true;

		let error = lease
			.with_heartbeat(|| {
				called.store(true, Ordering::SeqCst);

				Ok(PackageDisposition::LeaseLost("fixture"))
			})
			.expect_err("heartbeat creation failure");

		assert!(error.is_transient());
		assert!(!called.load(Ordering::SeqCst));
		assert!(lease.state.lock().expect("lease state").stopped);
		assert!(worker.transport.requests.lock().expect("renewal requests").is_empty());
	}

	#[test]
	fn terminal_response_stops_a_due_heartbeat_before_unlock() {
		let worker =
			test_worker(RenewalTransport { status: 409, requests: Mutex::new(Vec::new()) });
		let claim = test_claim(format!("run_{}", "b".repeat(64)));
		let lease = ClaimLease::with_interval(&worker, &claim, Duration::from_millis(100));

		thread::scope(|scope| {
			let heartbeat = thread::Builder::new()
				.spawn_scoped(scope, || lease.run_heartbeat())
				.expect("heartbeat starts");
			let response = lease
				.with_terminal_lease(
					|| {
						thread::sleep(Duration::from_millis(200));

						Ok(HttpResponse { status: 200, body: Vec::new() })
					},
					|response| response.status == 200,
				)
				.expect("terminal response");

			assert_eq!(response.status, 200);

			heartbeat.join().expect("heartbeat joins").expect("terminal heartbeat stop");
		});

		let state = lease.state.lock().expect("lease state");

		assert!(state.terminal);
		assert!(state.stopped);
		assert!(state.lost.is_none());
		assert!(worker.transport.requests.lock().expect("renewal requests").is_empty());
	}

	#[test]
	fn concurrent_lease_maintenance_renews_only_once_per_interval() {
		let worker =
			test_worker(RenewalTransport { status: 200, requests: Mutex::new(Vec::new()) });
		let claim = test_claim(format!("run_{}", "b".repeat(64)));
		let lease = ClaimLease::new(&worker, &claim);
		let callers = 8;
		let barrier = Barrier::new(callers + 1);

		lease.state.lock().expect("lease state").last_renewed =
			Instant::now() - LEASE_RENEWAL_INTERVAL;
		thread::scope(|scope| {
			let mut workers = Vec::new();

			for _ in 0..callers {
				workers.push(
					thread::Builder::new()
						.spawn_scoped(scope, || {
							barrier.wait();

							lease.maintain()
						})
						.expect("maintenance thread starts"),
				);
			}

			barrier.wait();

			for worker in workers {
				worker.join().expect("maintenance thread joins").expect("lease maintenance");
			}
		});

		assert_eq!(worker.transport.requests.lock().expect("renewal requests").len(), 1);
	}

	#[test]
	fn lease_renewal_conflict_is_retryable() {
		let worker =
			test_worker(RenewalTransport { status: 409, requests: Mutex::new(Vec::new()) });
		let claim = test_claim(format!("run_{}", "b".repeat(64)));
		let lease = ClaimLease::new(&worker, &claim);
		let error = lease.force().expect_err("renewal conflict");

		assert!(error.is_transient());
	}

	#[test]
	fn retry_record_preserves_the_original_operator_diagnostic() {
		let worker =
			test_worker(RenewalTransport { status: 409, requests: Mutex::new(Vec::new()) });
		let claim = test_claim(format!("run_{}", "b".repeat(64)));
		let record = worker.process_claim(&claim);

		assert_eq!(record.disposition, "retry");
		assert_eq!(record.reason_code, None);
		assert_eq!(record.error_class, Some(OperatorErrorClass::Transient));
		assert_eq!(record.error_code, Some("claim_lease_renewal_unavailable"));
		assert_eq!(record.error_detail.as_deref(), Some("claim lease renewal is unavailable"));

		let requests = worker.transport.requests.lock().expect("requests");

		assert_eq!(requests.len(), 2);
		assert_eq!(requests[0]["action"], "renew");
		assert_eq!(requests[1]["action"], "ack");
		assert_eq!(requests[1]["disposition"], "retry");
	}

	#[test]
	fn terminal_reasons_are_stable_snake_case() {
		assert_eq!(ReasonCode::EvaluatorReplayMismatch.as_str(), "evaluator_replay_mismatch");

		let error = WorkerError::terminal(ReasonCode::InvalidPackageProtocol, "invalid");

		assert!(!error.is_transient());
	}

	#[test]
	fn retry_diagnostics_are_stable_and_operator_safe() {
		let diagnostic =
			WorkerError::transient("claim lease renewal is unavailable").operator_diagnostic();

		assert_eq!(diagnostic.class, OperatorErrorClass::Transient);
		assert_eq!(diagnostic.code, "claim_lease_renewal_unavailable");
		assert_eq!(diagnostic.detail, "claim lease renewal is unavailable");
	}

	#[test]
	fn configuration_diagnostics_are_stable_and_operator_safe() {
		let diagnostic =
			WorkerError::configuration("verifier environment is invalid").operator_diagnostic();

		assert_eq!(diagnostic.class, OperatorErrorClass::Configuration);
		assert_eq!(diagnostic.code, "verifier_environment_invalid");
		assert_eq!(diagnostic.detail, "verifier environment is invalid");
	}

	#[test]
	fn terminal_diagnostics_use_the_public_reason_contract() {
		let diagnostic = WorkerError::terminal(
			ReasonCode::InvalidRunProvenance,
			"controlled task content must not enter operator logs",
		)
		.operator_diagnostic();

		assert_eq!(diagnostic.class, OperatorErrorClass::Terminal);
		assert_eq!(diagnostic.code, "invalid_run_provenance");
		assert_eq!(diagnostic.detail, "The run provenance does not match the verifier policy.");
	}

	#[test]
	fn unknown_diagnostics_redact_secrets_paths_and_controlled_content() {
		let secret = "Bearer secret-token /controlled/tasks hidden-package-body";
		let diagnostic = WorkerError::transient(secret).operator_diagnostic();

		assert_eq!(diagnostic.code, REDACTED_ERROR_CODE);
		assert_eq!(diagnostic.detail, REDACTED_ERROR_DETAIL);
		assert!(!diagnostic.detail.contains("secret-token"));
		assert!(!diagnostic.detail.contains("/controlled"));
		assert!(diagnostic.detail.len() <= MAX_OPERATOR_ERROR_DETAIL_BYTES);
	}

	#[test]
	fn operator_diagnostic_detail_has_a_hard_byte_bound() {
		let diagnostic = OperatorDiagnostic::bounded(
			OperatorErrorClass::Transient,
			"test_detail",
			"x".repeat(MAX_OPERATOR_ERROR_DETAIL_BYTES + 1),
		);

		assert_eq!(diagnostic.code, REDACTED_ERROR_CODE);
		assert_eq!(diagnostic.detail, REDACTED_ERROR_DETAIL);
		assert!(diagnostic.detail.len() <= MAX_OPERATOR_ERROR_DETAIL_BYTES);
	}

	#[test]
	fn verifier_record_diagnostics_are_additive_and_optional() {
		let mut record = VerificationRecord {
			schema_version: RECORD_SCHEMA,
			inbox_id: "223e4567-e89b-42d3-a456-426614174000".to_owned(),
			idempotency_key: format!("run_{}", "d".repeat(64)),
			package_sha256: "a".repeat(64),
			disposition: "verified",
			reason_code: None,
			worker_name: "aiq-verifier",
			worker_version: "0.1.0",
			worker_binary_sha256: format!("sha256:{}", "b".repeat(64)),
			environment_sha256: format!("sha256:{}", "c".repeat(64)),
			official_calibration_policy: OfficialCalibrationPolicy::default(),
			official_calibration_observed: None,
			replay_scope: "commitments_verified",
			attempt: 1,
			error_class: None,
			error_code: None,
			error_detail: None,
		};
		let compatible = serde_json::to_value(&record).expect("serialize compatible record");

		assert_eq!(compatible["schema_version"], RECORD_SCHEMA);
		assert_eq!(compatible["idempotency_key"], record.idempotency_key);
		assert_eq!(
			compatible["official_calibration_policy"]["version"],
			scoring::OFFICIAL_CALIBRATION_POLICY_VERSION
		);
		assert!(compatible.get("official_calibration_observed").is_none());
		assert!(compatible.get("error_class").is_none());
		assert!(compatible.get("error_code").is_none());
		assert!(compatible.get("error_detail").is_none());

		record.disposition = "retry";
		record.error_class = Some(OperatorErrorClass::Transient);
		record.error_code = Some("retry_budget_exhausted");
		record.error_detail = Some("retry budget exhausted".to_owned());

		let diagnosed = serde_json::to_value(record).expect("serialize diagnosed record");

		assert_eq!(diagnosed["error_class"], "transient");
		assert_eq!(diagnosed["error_code"], "retry_budget_exhausted");
		assert_eq!(diagnosed["error_detail"], "retry budget exhausted");
	}

	#[test]
	fn production_replay_status_and_scope_name_evaluator_work() {
		assert_eq!(
			serde_json::to_value(ReplayStatus::EvaluatorReplayed).expect("serialize"),
			"evaluator_replayed"
		);
		assert_eq!(
			replay::PRODUCTION_REPLAY_SCOPE,
			"candidate_reconstructed_and_evaluator_replayed"
		);
	}
}
