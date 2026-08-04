//! Bounded queue consumption, package verification, normalization, and acknowledgement.

mod replay;

#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::thread::{self, Builder};
use std::{
	collections::BTreeSet,
	env, error,
	ffi::OsString,
	fmt::{Debug, Display, Formatter},
	fs::{self, OpenOptions},
	io::{Read, Write},
	path::{Path, PathBuf},
	process,
	sync::{Condvar, Mutex},
	time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use clap::Parser;
use libc::O_NOFOLLOW;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use ureq::{self, Body, http::Response};

use crate::replay::PRODUCTION_REPLAY_SCOPE;
use aiq_runner::{
	calibration_verification::{
		self, CalibrationVerifiedStageV1, CalibrationVerifierAttestationV1,
	},
	corpus_commitment::{self, RunClass, RunProvenanceCommitment},
	model::MODEL_MATRIX,
	normalization::{
		self, AttestedDeploymentMetadata, MAX_VERIFICATION_REQUEST_BYTES, NormalizedBatchStage,
		ReplayStatus, VerifiedPackageIdentity, VerifierAttestationV2, VerifierSigningIdentity,
	},
	protocol::{
		self, CALIBRATION_RUN_PAYLOAD_TYPE, RUN_PAYLOAD_TYPE, SubmissionEnvelope, TrustTier,
		VerifiedSubmission,
	},
	run_validation,
	runner::{
		self, CalibrationRunRecord, FailureKind, ProviderTokenUsage, ResultStatus, RunRecord,
	},
	scoring::{self, AIQ_CORE_TASK_IDENTITY_SHA256, ScoreContext, ScoreOptions, ScoreReport},
	submission::{self, MAX_ARTIFACT_BYTES, MAX_SUBMISSION_BYTES},
	task::{DirectoryTaskSource, EvaluatorRuntime, TaskDefinition, TaskSource, Visibility},
};

const MAX_GATEWAY_RESPONSE_BYTES: usize = 64 * 1_024;
const MAX_OBJECT_RESPONSE_BYTES: usize = MAX_SUBMISSION_BYTES + 1;
const MAX_ARTIFACT_RESPONSE_BYTES: usize = MAX_ARTIFACT_BYTES + 1;
const RENEWED_LEASE_SECONDS: u64 = 900;
const LEASE_RENEWAL_INTERVAL: Duration = Duration::from_secs(300);
const DEFAULT_REPLAY_JOBS: usize = 4;
const MAX_REPLAY_JOBS: usize = 32;
const VERIFIER_REJECTION_SCHEMA: &str = "aiq.verifier-rejection.v2";
const RECORD_SCHEMA: &str = "aiq.verifier-record.v1";
const MAX_OPERATOR_ERROR_DETAIL_BYTES: usize = 256;
const REDACTED_ERROR_CODE: &str = "details_redacted";
const REDACTED_ERROR_DETAIL: &str = "Additional error detail was redacted.";
const ADDITIONAL_MODES_HELP: &str = "Additional modes:
  aiq-verifier validate-environment --environment <ENVIRONMENT>
      Validate production environment metadata without secrets or service access.
  aiq-verifier verify-local --help
      Replay one production package offline and write create-new stage and attestation files.
      This mode does not publish or assign cloud trust.

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
	#[arg(long, default_value_t = 30, value_parser = clap::value_parser!(u64).range(1..=300))]
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
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkerError {
	kind: ErrorKind,
	message: String,
}
impl WorkerError {
	pub(crate) fn configuration(message: impl Into<String>) -> Self {
		Self { kind: ErrorKind::Configuration, message: message.into() }
	}

	pub(crate) fn transient(message: impl Into<String>) -> Self {
		Self { kind: ErrorKind::Transient, message: message.into() }
	}

	pub(crate) fn terminal(code: ReasonCode, message: impl Into<String>) -> Self {
		Self { kind: ErrorKind::Terminal(code), message: message.into() }
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
	package_sha256: String,
	disposition: &'static str,
	reason_code: Option<ReasonCode>,
	worker_name: &'static str,
	worker_version: &'static str,
	worker_binary_sha256: String,
	environment_sha256: String,
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
	about = "Replay one exact production package offline without publishing or assigning cloud trust"
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
	/// New output path for the exact `aiq.normalized-batch.v3` stage.
	#[arg(long)]
	stage_output: PathBuf,
	/// New output path for the signed `aiq.verifier-attestation.v3`.
	#[arg(long)]
	attestation_output: PathBuf,
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
					| "stderr.txt" | "final-response.txt"
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
		if url.starts_with("https://")
			|| (self.allow_loopback_http
				&& (url.starts_with("http://127.0.0.1:") || url.starts_with("http://localhost:")))
		{
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
	replay_root: PathBuf,
	replay_jobs: usize,
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
		let result = self.verify_claim(claim);
		let (disposition, reason_code, replay_scope, diagnostic) = match result {
			Ok(PackageDisposition::Verified(scope)) => ("verified", None, scope, None),
			Ok(PackageDisposition::Rejected(reason)) => (
				"rejected",
				Some(reason),
				"verification_rejected",
				Some(OperatorDiagnostic::bounded(
					OperatorErrorClass::Terminal,
					reason.as_str(),
					reason.operator_detail(),
				)),
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
			),
			Err(error) => {
				let diagnostic = error.operator_diagnostic();
				let _release_result = self.retry(|| self.acknowledge(claim, "retry"));

				if error.is_transient() {
					("retry", None, "verification_incomplete", Some(diagnostic))
				} else {
					("worker_error", None, "verification_incomplete", Some(diagnostic))
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
			package_sha256: claim.package_sha256.clone(),
			disposition,
			reason_code,
			worker_name: env!("CARGO_PKG_NAME"),
			worker_version: env!("CARGO_PKG_VERSION"),
			worker_binary_sha256: self.worker_binary_sha256.clone(),
			environment_sha256: self.environment_sha256.clone(),
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
		let prepared = match self.prepare_verification(claim, &package_bytes, lease) {
			Ok(prepared) => prepared,
			Err(error) => return self.reject_and_complete(claim, lease, error),
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

		Ok(PackageDisposition::Verified(prepared.replay_scope))
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

		Ok(PackageDisposition::Rejected(reason))
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

fn retryable_verification_status(status: u16) -> bool {
	matches!(status, 408 | 409 | 429 | 500..=599)
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
				(Ok(PackageDisposition::Verified(scope)), _) => {
					Ok(PackageDisposition::Verified(scope))
				},
				(Ok(PackageDisposition::Rejected(reason)), _) => {
					Ok(PackageDisposition::Rejected(reason))
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
	Verified(&'static str),
	Rejected(ReasonCode),
	LeaseLost(&'static str),
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
		if command == "validate-environment" {
			let mut validate_arguments = vec![OsString::from("aiq-verifier validate-environment")];

			validate_arguments.extend(arguments.iter().skip(2).cloned());

			return run_validate_environment(ValidateEnvironmentCli::parse_from(
				validate_arguments,
			));
		}
	}

	run_worker(Cli::parse_from(arguments))
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
	})
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
	let run: CalibrationRunRecord = serde_json::from_value(verified.payload).map_err(|_| {
		WorkerError::terminal(
			ReasonCode::InvalidPackageProtocol,
			"package payload is not a calibration run record",
		)
	})?;
	let tasks = selected_calibration_tasks(&run, request.tasks)?;

	run_validation::validate_calibration_run_record_with_tasks(&run, &tasks).map_err(|_| {
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
	let package = VerifiedPackageIdentity {
		package_sha256: request.package_sha256.to_owned(),
		content_hash: verified.content_hash,
		signer: verified.signer,
	};
	let (stage, attestation) = calibration_verification::verify_and_attest_calibration_run(
		request.signing_identity,
		&run,
		&tasks,
		&package,
		&metadata,
		&provider_usage,
		request.observed_unix_ms,
	)
	.map_err(|_| {
		WorkerError::terminal(
			ReasonCode::NormalizationMismatch,
			"calibration recomputation or verifier attestation construction failed",
		)
	})?;

	attestation.verify(&stage, request.signing_identity.node()).map_err(|_| {
		WorkerError::terminal(
			ReasonCode::NormalizationMismatch,
			"calibration verifier attestation self-check failed",
		)
	})?;

	Ok(PreparedVerification {
		evidence: PreparedEvidence::Calibration { stage, attestation },
		replay_scope: PRODUCTION_REPLAY_SCOPE,
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

	let mut stage_bytes = serde_json::to_vec_pretty(stage).map_err(|error| {
		WorkerError::configuration(format!("stage serialization failed: {error}"))
	})?;
	let mut attestation_bytes = serde_json::to_vec_pretty(attestation).map_err(|error| {
		WorkerError::configuration(format!("attestation serialization failed: {error}"))
	})?;

	stage_bytes.push(b'\n');
	attestation_bytes.push(b'\n');

	let stage_temporary = create_temporary_output(&stage_target, "stage", &stage_bytes)?;
	let attestation_temporary =
		create_temporary_output(&attestation_target, "attestation", &attestation_bytes)?;

	fs::hard_link(&stage_temporary.path, &stage_target.path).map_err(|error| {
		WorkerError::configuration(format!(
			"cannot install stage output without overwrite: {error}"
		))
	})?;

	if let Err(error) = fs::hard_link(&attestation_temporary.path, &attestation_target.path) {
		if let Err(cleanup) = fs::remove_file(&stage_target.path) {
			return Err(WorkerError::configuration(format!(
				"cannot install attestation output: {error}; cannot roll back stage output: {cleanup}"
			)));
		}

		return Err(WorkerError::configuration(format!(
			"cannot install attestation output without overwrite: {error}"
		)));
	}

	Ok(())
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

	for task in &tasks {
		if let Some(binding) =
			task.evaluator.as_ref().and_then(|evaluator| evaluator.external.as_ref())
		{
			let evaluator_runtime = evaluator_runtime.as_ref().ok_or_else(|| {
				WorkerError::configuration("external tasks require --evaluator-runtime")
			})?;

			binding
				.validate_registry(&evaluator_root)
				.and_then(|()| binding.validate_runtime(evaluator_runtime))
				.map_err(|error| WorkerError::configuration(error.to_string()))?;
		}
	}

	if !cli.synthetic_demo_tasks
		&& (evaluator_root == replay_root
			|| evaluator_root.starts_with(&replay_root)
			|| replay_root.starts_with(&evaluator_root))
	{
		return Err(WorkerError::configuration(
			"evaluator and replay roots must be separate directory trees",
		));
	}

	let worker = Worker {
		transport: UreqTransport::new(
			Duration::from_secs(cli.timeout_seconds),
			cli.allow_loopback_http,
			cli.replay_jobs,
		),
		endpoint,
		token,
		signing_identity: VerifierSigningIdentity::from_secret(signing_key),
		tasks,
		environment,
		environment_sha256,
		worker_binary_sha256,
		lease_seconds: cli.lease_seconds,
		max_retries: cli.max_retries,
		backoff: Duration::from_millis(cli.backoff_ms),
		evaluator_root,
		evaluator_runtime,
		replay_root,
		replay_jobs: cli.replay_jobs,
	};

	worker.run(cli.max_claims, cli.max_idle_polls)
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

	validate_environment(&environment)?;

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

	for (left_label, left, right_label, right) in [
		(
			"artifact root",
			artifact_resolver.root.as_path(),
			"evaluator root",
			evaluator_root.as_path(),
		),
		("artifact root", artifact_resolver.root.as_path(), "replay root", replay_root.as_path()),
		(
			"artifact root",
			artifact_resolver.root.as_path(),
			"model toolchain root",
			toolchain_root.as_path(),
		),
		("evaluator root", evaluator_root.as_path(), "replay root", replay_root.as_path()),
		("model toolchain root", toolchain_root.as_path(), "replay root", replay_root.as_path()),
	] {
		if roots_overlap(left, right) {
			return Err(WorkerError::configuration(format!(
				"{left_label} and {right_label} must be separate directory trees"
			)));
		}
	}

	let evaluator_runtime = EvaluatorRuntime::resolve(&cli.evaluator_runtime)
		.map_err(|error| WorkerError::configuration(error.to_string()))?;
	let _corpus_bytes =
		regular_file_bytes(&cli.corpus_commitment, "corpus commitment", MAX_SUBMISSION_BYTES)?;
	let expected = environment.expected_provenance.as_ref().ok_or_else(|| {
		WorkerError::configuration("production verifier environment lacks expected provenance")
	})?;

	corpus_commitment::validate_evaluator_runtime_commitment(
		&cli.corpus_commitment,
		&expected.corpus_commitment_sha256,
		&evaluator_runtime,
		&toolchain_root,
	)
	.map_err(|error| WorkerError::configuration(error.to_string()))?;

	validate_evaluator_bindings(&tasks, &evaluator_root, &evaluator_runtime)?;

	let signing_identity =
		VerifierSigningIdentity::from_secret(signing_key_from_environment(&cli.signing_key_env)?);

	verify_and_write_local(
		PreparationRequest {
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
			observed_unix_ms: cli.observed_unix_ms,
			require_production: true,
			replay_jobs: cli.replay_jobs,
		},
		&cli.stage_output,
		&cli.attestation_output,
	)
	.map(|_| ())
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

			scoring::score_model_with_context(
				tasks,
				&run.results,
				model,
				context,
				ScoreOptions::default(),
			)
			.map_err(|_| {
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

	if endpoint.starts_with("https://")
		|| (allow_loopback_http
			&& (endpoint.starts_with("http://127.0.0.1:")
				|| endpoint.starts_with("http://localhost:")))
	{
		Ok(endpoint.to_owned())
	} else {
		Err(WorkerError::configuration("endpoint must use HTTPS; test HTTP is limited to loopback"))
	}
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
		|| environment.artifact_resolver_endpoint.as_ref().is_some_and(|url| {
			!url.starts_with("https://")
				|| url.ends_with('/')
				|| url.contains('?')
				|| url.contains('#')
		}) {
		return Err(WorkerError::configuration("verifier environment is invalid"));
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
	if value
		.as_bytes()
		.chunks_exact(2)
		.next()
		.is_some_and(|first| value.as_bytes().chunks_exact(2).all(|chunk| chunk == first))
	{
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
			Arc, Barrier, Mutex,
			atomic::{AtomicBool, Ordering},
		},
		thread,
		time::{Duration, Instant, SystemTime, UNIX_EPOCH},
	};

	use clap::Parser;
	use sha2::{Digest, Sha256};

	use crate::{
		ArtifactResolveAttemptError, ArtifactResolverClient, Claim, ClaimLease, Cli,
		DEFAULT_REPLAY_JOBS, ErrorKind, HttpArtifactResolver, HttpResponse, LEASE_RENEWAL_INTERVAL,
		LeaseMaintenance, LocalArtifactResolver, MAX_OPERATOR_ERROR_DETAIL_BYTES,
		MAX_VERIFICATION_REQUEST_BYTES, OperatorDiagnostic, OperatorErrorClass, PackageDisposition,
		PreparationRequest, PreparedEvidence, PreparedVerification, RECORD_SCHEMA,
		REDACTED_ERROR_CODE, REDACTED_ERROR_DETAIL, RENEWED_LEASE_SECONDS, ReasonCode,
		RejectionGatewayResponse, Secret, Transport, UreqTransport, ValidateEnvironmentCli,
		VerificationGatewayResponse, VerificationRecord, VerifierEnvironment, VerifyLocalCli,
		Worker, WorkerError, replay, retryable_verification_status,
	};
	use aiq_runner::calibration_verification::{
		CalibrationVerifiedStageV1, CalibrationVerifierAttestationV1,
	};
	use aiq_runner::{
		AIQ_BENCHMARK_VERSION, AIQ_TASK_SET_ID, AIQ_TASK_SET_VERSION,
		adapter::{
			self, ArtifactReference, ArtifactSink, AuthenticationProbe, CapabilityValidation,
			CapabilityValidationReport, CapabilityValidationStatus, CliProbe, ConfigurationProbe,
			ConfigurationProbeStatus, ExecutorError, ProbeStatus,
		},
		corpus_commitment::{RunClass, RunProvenanceCommitment},
		model::MODEL_MATRIX,
		normalization::{
			NormalizedBatchStage, ReplayStatus, VerifierAttestationV2, VerifierSigningIdentity,
		},
		protocol::{self, SigningIdentity, TrustTier},
		resume, run_validation,
		runner::{self, CalibrationRunRecord, WorkspaceManifest, WorkspaceSnapshot},
		schedule::{ScheduleConfig, ScheduleOccurrence},
		submission,
		task::EvaluatorRuntime,
	};

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
			let unique =
				SystemTime::now().duration_since(UNIX_EPOCH).expect("fixture clock").as_nanos();
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
			let mut run = runner::synthetic_demo(
				ScheduleConfig::default()
					.slot("2026-07-25", ScheduleOccurrence::Day)
					.expect("fixture slot"),
				&artifact_sink,
			)
			.expect("synthetic base run");
			let runner_identity = SigningIdentity::from_secret([7; 32]);
			let runner_node_id = runner_identity.node().node_id.clone();
			let codex_version = "codex fixture".to_owned();
			let preflight = local_fixture_preflight(runner_node_id.clone(), &codex_version);
			let preflight_digest = protocol::canonical_hash(&preflight).expect("preflight digest");
			let provenance = local_fixture_provenance(run.task_set_hash.clone(), preflight_digest);
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
			let node = env::split_paths(&env::var_os("PATH").expect("test PATH"))
				.map(|directory| directory.join(format!("node{}", env::consts::EXE_SUFFIX)))
				.find(|candidate| candidate.is_file())
				.expect("Node.js runtime");
			let evaluator_runtime = EvaluatorRuntime::resolve(
				&fs::canonicalize(node).expect("canonical Node.js runtime"),
			)
			.expect("evaluator runtime");

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
			}
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
			let envelope: protocol::SubmissionEnvelope =
				serde_json::from_slice(&self.package).expect("official envelope");
			let official: runner::RunRecord =
				serde_json::from_value(envelope.payload).expect("official payload");
			let mut provenance = official.provenance.expect("production provenance");

			provenance.run_class = RunClass::Calibration;

			let run_id = resume::classified_run_id(
				&official.schedule_slot,
				&official.task_set_hash,
				&provenance.corpus_commitment_sha256,
				&official.models,
				RunClass::Calibration,
			)
			.expect("calibration run id");
			let mut results = official.results;

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
				task_set_hash: official.task_set_hash,
				scoring_version: official.scoring_version,
				execution_concurrency: Some(17),
				models: official.models,
				task_ids: self.tasks.iter().map(|task| task.task_id.clone()).collect(),
				started_unix_ms: official.started_unix_ms,
				finished_unix_ms: official.finished_unix_ms,
				capability_validation: official.capability_validation.expect("preflight"),
				provenance,
				evaluator_results_artifact: official.evaluator_results_artifact,
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
			let digest = hex::encode(Sha256::digest(bytes));
			let directory = root.join(&digest);
			let path = directory.join(kind);

			fs::create_dir(&directory).expect("artifact digest directory");
			fs::write(&path, bytes).expect("artifact bytes");

			(
				ArtifactReference {
					kind: kind.to_owned(),
					content_hash: format!("sha256:{digest}"),
					uri: format!("aiq-artifact://sha256/{digest}/{kind}"),
					bytes: u64::try_from(bytes.len()).expect("artifact size"),
				},
				path,
			)
		}

		fn prepare(
			&self,
			stage_output: &Path,
			attestation_output: &Path,
		) -> Result<super::PreparedVerification, WorkerError> {
			self.prepare_with_jobs(stage_output, attestation_output, DEFAULT_REPLAY_JOBS)
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
					observed_unix_ms: 1_000,
					require_production: true,
					replay_jobs,
				},
				stage_output,
				attestation_output,
			)
		}
	}

	impl Drop for LocalReplayFixture {
		fn drop(&mut self) {
			let _ = fs::remove_dir_all(&self.root);
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

		changed.scores[0].score.fixed_fixture_aiq =
			changed.scores[0].score.fixed_fixture_aiq.map(|value| (value - 0.01).max(0.0));
		changed.score_reports_digest =
			protocol::canonical_hash(&changed.scores).expect("changed score digest");
		changed.stage_digest = changed.compute_stage_digest().expect("changed stage digest");

		assert!(attestation.verify(&changed, &attestation.verifier).is_err());

		let mut uppercase_signature = attestation.clone();

		uppercase_signature.signature = uppercase_signature.signature.to_ascii_uppercase();

		assert_ne!(uppercase_signature.signature, attestation.signature);
		assert!(uppercase_signature.verify(stage, &attestation.verifier).is_err());
	}

	#[test]
	fn verifier_cli_requires_production_runtime_bindings_but_keeps_synthetic_demo_minimal() {
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
		assert_eq!(attestation.stage_digest, stage.stage_digest);
		assert_ne!(attestation.runner.node_id, attestation.verifier.node_id);

		assert_calibration_attestation_mutations_rejected(&stage, &attestation);
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
			replay_root: PathBuf::from("/unused-replay"),
			replay_jobs: DEFAULT_REPLAY_JOBS,
		}
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

	fn local_fixture_preflight(node_id: String, codex_version: &str) -> CapabilityValidationReport {
		let codex_version = codex_version.to_owned();
		let models = MODEL_MATRIX
			.into_iter()
			.map(|model| {
				let preview = "AIQ_PREFLIGHT_OK".to_owned();
				let result_digest =
					format!("sha256:{}", hex::encode(Sha256::digest(preview.as_bytes())));
				let observed_at = "unix-ms:1".to_owned();
				let evidence_digest = adapter::configuration_evidence_digest(
					model,
					Some(&codex_version),
					&observed_at,
					ConfigurationProbeStatus::Available,
					Some(&result_digest),
					Some(&preview),
					&[],
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
						artifacts: Vec::new(),
						evidence_digest,
						failure: None,
					},
				}
			})
			.collect();

		CapabilityValidationReport {
			schema_version: "aiq.capability-validation.v2".to_owned(),
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
			schema_version: "aiq.run-provenance.v2".to_owned(),
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
			schema_version: "aiq.verifier-record.v1",
			inbox_id: "223e4567-e89b-42d3-a456-426614174000".to_owned(),
			package_sha256: "a".repeat(64),
			disposition,
			reason_code: None,
			worker_name: "aiq-verifier",
			worker_version: "0.1.0",
			worker_binary_sha256: format!("sha256:{}", "b".repeat(64)),
			environment_sha256: format!("sha256:{}", "c".repeat(64)),
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
			PackageDisposition::Rejected(ReasonCode::InvalidPackageSignature)
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
			assert!(retryable_verification_status(status), "HTTP {status}");
		}

		for status in [200, 400, 401, 403, 404, 422] {
			assert!(!retryable_verification_status(status), "HTTP {status}");
		}
	}

	#[test]
	fn verification_retries_reuse_prepared_replay_until_success() {
		let (worker, claim) = retry_verification_fixture([500, 502, 200], 3);

		assert!(matches!(
			worker.verify_claim(&claim).expect("verification retry must recover"),
			PackageDisposition::Verified("commitments_verified")
		));
		assert_eq!(*worker.transport.object_calls.lock().expect("object calls"), 1);
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
		assert_eq!(
			worker.transport.requests.lock().expect("requests").as_slice(),
			["renewed", "verification_500", "verification_502", "verification_503", "ack_retry",]
		);

		let bodies = worker.transport.verification_bodies.lock().expect("verification bodies");

		assert_eq!(bodies.len(), 3);
		assert!(bodies.windows(2).all(|pair| pair[0] == pair[1]));
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
			PackageDisposition::Verified("commitments_verified")
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
			PackageDisposition::Verified("commitments_verified")
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
			package_sha256: "a".repeat(64),
			disposition: "verified",
			reason_code: None,
			worker_name: "aiq-verifier",
			worker_version: "0.1.0",
			worker_binary_sha256: format!("sha256:{}", "b".repeat(64)),
			environment_sha256: format!("sha256:{}", "c".repeat(64)),
			replay_scope: "commitments_verified",
			attempt: 1,
			error_class: None,
			error_code: None,
			error_detail: None,
		};
		let compatible = serde_json::to_value(&record).expect("serialize compatible record");

		assert_eq!(compatible["schema_version"], RECORD_SCHEMA);
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
