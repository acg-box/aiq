//! Isolated verification evidence for signed, non-Official calibration runs.

use std::iter;
use std::{
	collections::BTreeSet,
	error::Error,
	fmt::{Display, Formatter},
};

use ed25519_dalek::{Signature, Verifier as _, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::adapter::ArtifactReference;
use crate::runner::TaskResult;
use crate::runner::{self, MAX_RUN_JOBS};
use crate::scoring::{
	AIQ_BENCHMARK_VERSION, AIQ_SCORING_VERSION, AIQ_TASK_SET_ID, AIQ_TASK_SET_VERSION,
	FrozenCalibrationBankV2, OfficialCalibrationDiagnostic, OfficialCalibrationPolicy,
};
use crate::{
	adapter::{CapabilityValidationStatus, ConfigurationProbeStatus, ProbeStatus},
	corpus_commitment::{self, RunClass, RunProvenanceCommitment},
	model::{MODEL_MATRIX, ModelConfig, ModelFamily},
	normalization::{
		AttestedDeploymentMetadata, VERIFIER_SIGNATURE_ALGORITHM, VERIFIER_SIGNATURE_VERSION,
		VerifiedPackageIdentity, VerifierSigningIdentity,
	},
	protocol::{self, NodeIdentity, TrustTier},
	run_validation,
	runner::{CalibrationRunRecord, FailureKind, ProviderTokenUsage},
	scoring::{self, CalibrationScoreReport, FalseOnly, ScoreContext, ScoreOptions},
	submission,
	task::TaskDefinition,
};

/// Calibration verifier-stage schema.
pub const CALIBRATION_VERIFIED_STAGE_SCHEMA_VERSION: &str = "aiq.calibration-verified-stage.v2";
/// Calibration verifier-attestation schema.
pub const CALIBRATION_VERIFIER_ATTESTATION_SCHEMA_VERSION: &str =
	"aiq.calibration-verifier-attestation.v2";
/// Private verifier-signed admission for one complete calibration matrix.
pub const CALIBRATION_ADMISSION_SCHEMA_VERSION: &str = "aiq.calibration-admission.v3";
/// Self-contained admission bundle that duplicates the transactionally published evidence.
pub const CALIBRATION_ADMISSION_BUNDLE_SCHEMA_VERSION: &str = "aiq.calibration-admission-bundle.v3";
/// Efficiency observation schema.
pub const CALIBRATION_EFFICIENCY_SCHEMA_VERSION: &str = "aiq.calibration-efficiency.v1";
/// API-equivalent pricing model version.
pub const API_EQUIVALENT_PRICING_VERSION: &str = "aiq.standard-api-equivalent-usd.v1";

const MAX_JCS_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_SHORT_CONTEXT_INPUT_TOKENS: u64 = 272_000;
const PRICING_SOURCE: &str = "https://developers.openai.com/api/docs/pricing";
const PRICING_AS_OF: &str = "2026-08-02";

/// Calibration verification or attestation failed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CalibrationVerificationError {
	message: String,
}
impl CalibrationVerificationError {
	fn new(message: impl Into<String>) -> Self {
		Self { message: message.into() }
	}
}

impl Display for CalibrationVerificationError {
	fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
		formatter.write_str(&self.message)
	}
}

impl Error for CalibrationVerificationError {}

/// Standard API token rates for one model family.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ApiEquivalentTokenRates {
	/// API model identifier used for the comparison.
	pub model: String,
	/// Standard input rate in USD nanos for one token.
	pub input_usd_nanos_per_token: u64,
	/// Cached input rate in USD nanos for one token.
	pub cached_input_usd_nanos_per_token: u64,
	/// Cache-write input rate in USD nanos for one token.
	pub cache_write_input_usd_nanos_per_token: u64,
	/// Output rate in USD nanos for one token.
	pub output_usd_nanos_per_token: u64,
}

/// Versioned pricing method used only for a standard API-equivalent estimate.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ApiEquivalentPricingModel {
	/// Estimate method.
	pub method: String,
	/// Versioned formula contract.
	pub version: String,
	/// Rate-card observation date.
	pub as_of: String,
	/// Authoritative rate source.
	pub source: String,
	/// ISO currency code.
	pub currency: String,
	/// API processing tier used by the comparison rate card.
	pub processing_tier: String,
	/// Sol, Terra, and Luna standard rates.
	pub rates: Vec<ApiEquivalentTokenRates>,
	/// Exact formula and exclusions.
	pub formula: String,
	/// Hosted tools are disabled by the benchmark and no hosted-tool fees are estimated.
	pub hosted_tool_fees_included: bool,
	/// Important interpretation limit.
	pub limitation: String,
}
impl Default for ApiEquivalentPricingModel {
	fn default() -> Self {
		Self {
			method: "standard_api_equivalent_text_token_estimate".to_owned(),
			version: API_EQUIVALENT_PRICING_VERSION.to_owned(),
			as_of: PRICING_AS_OF.to_owned(),
			source: PRICING_SOURCE.to_owned(),
			currency: "USD".to_owned(),
			processing_tier: "standard".to_owned(),
			rates: vec![
				rates("gpt-5.6-sol", 5_000, 500, 6_250, 30_000),
				rates("gpt-5.6-terra", 2_000, 200, 2_500, 12_000),
				rates("gpt-5.6-luna", 200, 20, 250, 1_200),
			],
			formula: "(input-cached_input-cache_write_input)*input_usd_nanos_per_token + cached_input*cached_input_usd_nanos_per_token + cache_write_input*cache_write_input_usd_nanos_per_token + output*output_usd_nanos_per_token; reasoning is a subset of output and is not added again".to_owned(),
			hosted_tool_fees_included: false,
			limitation: "Standard short-context API-equivalent comparison only. Prompts above 272000 input tokens use 2x input and 1.5x output rates, but aggregate usage cannot identify each request context band; a result above 272000 aggregate input tokens is therefore unpriced. Regional processing uplift and hosted tool fees are excluded. This is not actual subscription spend. Long-context rule: https://developers.openai.com/api/docs/pricing".to_owned(),
		}
	}
}

/// Public-safe efficiency observation for one signed result.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CalibrationResultEfficiency {
	/// Signed source result identifier.
	pub source_result_id: String,
	/// Selected task identifier.
	pub task_id: String,
	/// Selected model configuration.
	pub model: ModelConfig,
	/// Observed Codex adapter elapsed time. Uninvoked cells remain unknown.
	pub observed_wall_ms: Option<u64>,
	/// Codex adapter elapsed-time authority classification.
	pub wall_time_evidence_level: Option<EfficiencyEvidenceLevel>,
	/// Provider-reported counters. Missing counters remain omitted.
	pub provider_tokens: ProviderTokenUsage,
	/// Original source of the token counters.
	pub provider_tokens_source: Option<EfficiencyEvidenceLevel>,
	/// Verification applied to the retained provider event.
	pub provider_tokens_evidence_level: Option<EfficiencyEvidenceLevel>,
	/// Standard API-equivalent estimate, when all required counters exist.
	pub standard_api_equivalent_usd_nanos: Option<u64>,
	/// Estimate availability classification.
	pub cost_status: CostEstimateStatus,
	/// Authority for the deterministic estimate.
	pub cost_evidence_level: Option<EfficiencyEvidenceLevel>,
}

/// Number of selected tasks that reported each provider counter.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderTokenCoverage {
	/// Number of selected task results.
	pub selected_tasks: usize,
	/// Number of results with an input-token counter.
	pub input_tasks: usize,
	/// Number of results with a cached-input counter.
	pub cached_input_tasks: usize,
	/// Number of results with a cache-write counter.
	pub cache_write_input_tasks: usize,
	/// Number of results with an output-token counter.
	pub output_tasks: usize,
	/// Number of results with a reasoning-token counter.
	pub reasoning_tasks: usize,
	/// Number of results with a total-token counter.
	pub total_tasks: usize,
}

/// Transparent efficiency aggregate for one model selection.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CalibrationEfficiencyAggregate {
	/// Efficiency aggregate schema.
	pub schema_version: String,
	/// Model configuration for this aggregate.
	pub model: ModelConfig,
	/// Number of selected task results.
	pub selected_tasks: usize,
	/// Results with observed Codex adapter elapsed time.
	pub observed_wall_tasks: usize,
	/// Total observed Codex adapter elapsed time.
	pub total_observed_wall_ms: Option<u64>,
	/// Median observed Codex adapter elapsed time.
	pub median_observed_wall_ms: Option<u64>,
	/// 95th-percentile observed Codex adapter elapsed time.
	pub p95_observed_wall_ms: Option<u64>,
	/// Sums of each available provider token counter.
	pub provider_token_totals: ProviderTokenUsage,
	/// Per-counter provider token coverage.
	pub provider_token_coverage: ProviderTokenCoverage,
	/// Number of task results with an API-equivalent cost estimate.
	pub estimated_cost_tasks: usize,
	/// Total API-equivalent cost when every selected result has an estimate.
	pub standard_api_equivalent_usd_nanos: Option<u64>,
}

/// One recomputed calibration score paired with separate efficiency evidence.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CalibrationVerifiedScore {
	/// Model configuration for the score.
	pub model: ModelConfig,
	/// Recomputed transparent correctness score.
	pub score: CalibrationScoreReport,
	/// Separate time, token, and cost evidence.
	pub efficiency: CalibrationEfficiencyAggregate,
}

/// Public non-Official stage created only after artifact and evaluator replay.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CalibrationVerifiedStageV1 {
	/// Calibration stage schema.
	pub schema_version: String,
	/// Stable run identifier.
	pub run_id: String,
	/// SHA-256 digest of the exact signed package bytes.
	pub package_sha256: String,
	/// Signed package content commitment.
	pub content_hash: String,
	/// Runner identity from the signed package.
	pub runner: NodeIdentity,
	/// Permanent non-Official classification.
	pub classification: String,
	/// Calibration run class.
	pub run_class: RunClass,
	/// False-only Official eligibility marker.
	pub official_eligible: FalseOnly,
	/// False-only ranking eligibility marker.
	pub ranking_eligible: FalseOnly,
	/// Public trust tier for this stage.
	pub trust: TrustTier,
	/// Committed controlled task-set hash.
	pub task_set_hash: String,
	/// Digest of the complete one-terminal-observation lineage.
	pub terminal_attempt_lineage_digest: String,
	/// Digest of the ordered task selection.
	pub task_selection_digest: String,
	/// Digest of the ordered model selection.
	pub model_selection_digest: String,
	/// Digest of the recomputed score reports.
	pub score_reports_digest: String,
	/// Digest of per-result efficiency evidence.
	pub telemetry_digest: String,
	/// Digest of the capability validation record.
	pub capability_validation_digest: String,
	/// Run provenance commitment.
	pub provenance: RunProvenanceCommitment,
	/// Content-addressed deterministic evaluator-result artifact.
	pub evaluator_results_artifact: ArtifactReference,
	/// Correctness scoring contract version.
	pub scoring_version: String,
	/// Bound model-execution concurrency.
	pub execution_concurrency: usize,
	/// Ordered selected task identifiers.
	pub task_ids: Vec<String>,
	/// Ordered selected model configurations.
	pub models: Vec<ModelConfig>,
	/// Recomputed score and efficiency report for each model.
	pub scores: Vec<CalibrationVerifiedScore>,
	/// Per-result public-safe efficiency observations.
	pub result_efficiency: Vec<CalibrationResultEfficiency>,
	/// Versioned Standard API-equivalent pricing method.
	pub pricing: ApiEquivalentPricingModel,
	/// Controlled task-set identifier.
	pub task_set_id: String,
	/// Controlled task-set version.
	pub task_set_version: String,
	/// Benchmark protocol version.
	pub benchmark_version: String,
	/// Committed prompt-set digest.
	pub prompt_set_digest: String,
	/// Runner source commit.
	pub runner_commit: String,
	/// Runner region label.
	pub region: String,
	/// Idempotent schedule slot in Unix milliseconds.
	pub scheduled_unix_ms: u64,
	/// Runner start time in Unix milliseconds.
	pub started_unix_ms: u64,
	/// Runner finish time in Unix milliseconds.
	pub finished_unix_ms: u64,
	/// JCS commitment over the stage without this field.
	pub stage_digest: String,
}
impl CalibrationVerifiedStageV1 {
	/// Recomputes the full-stage JCS commitment with `stage_digest` excluded.
	pub fn compute_stage_digest(&self) -> Result<String, CalibrationVerificationError> {
		protocol::canonical_hash(&UnsignedCalibrationStage::from(self))
			.map_err(|error| CalibrationVerificationError::new(error.to_string()))
	}

	/// Checks immutable digests and the permanent non-Official boundary.
	pub fn verify(&self) -> Result<(), CalibrationVerificationError> {
		let model_set = self.models.iter().copied().collect::<BTreeSet<_>>();
		let task_set = self.task_ids.iter().map(String::as_str).collect::<BTreeSet<_>>();

		if self.schema_version != CALIBRATION_VERIFIED_STAGE_SCHEMA_VERSION
			|| self.classification != "local_calibration_non_official"
			|| self.run_class != RunClass::Calibration
			|| self.trust != TrustTier::Untrusted
			|| self.models.is_empty()
			|| self.models.len() > MODEL_MATRIX.len()
			|| model_set.len() != self.models.len()
			|| !model_set.iter().all(|model| MODEL_MATRIX.contains(model))
			|| !(1..=MAX_RUN_JOBS).contains(&self.execution_concurrency)
			|| self.task_ids.is_empty()
			|| self.task_ids.len() > 72
			|| task_set.len() != self.task_ids.len()
			|| self.task_ids.iter().any(|task_id| !is_identifier(task_id, 64))
			|| self.scores.len() != self.models.len()
			|| self.result_efficiency.len() != self.models.len().saturating_mul(self.task_ids.len())
			|| self.started_unix_ms > self.finished_unix_ms
			|| [self.scheduled_unix_ms, self.started_unix_ms, self.finished_unix_ms]
				.into_iter()
				.any(|value| value > MAX_JCS_SAFE_INTEGER)
			|| self.scores.iter().zip(&self.models).any(|(score, model)| {
				score.model != *model
					|| score.score.model != *model
					|| score.efficiency.model != *model
					|| score.score.schema_version != "aiq.calibration-score-report.v2"
					|| score.score.run_class != "calibration"
					|| score.score.scoring_version != self.scoring_version
					|| score.score.coverage.expected_tasks != self.task_ids.len()
					|| score.score.official_eligible != FalseOnly
					|| score.score.ranking_eligible != FalseOnly
			}) {
			return Err(CalibrationVerificationError::new(
				"calibration stage classification or cardinality is invalid",
			));
		}

		let aggregates =
			self.scores.iter().map(|score| score.efficiency.clone()).collect::<Vec<_>>();

		validate_efficiency_evidence_contract(
			&self.models,
			&self.task_ids,
			&self.result_efficiency,
			&aggregates,
			&self.pricing,
		)?;
		validate_node(&self.runner)?;
		validate_hash(&self.package_sha256, false)?;

		for digest in [
			&self.content_hash,
			&self.task_set_hash,
			&self.terminal_attempt_lineage_digest,
			&self.task_selection_digest,
			&self.model_selection_digest,
			&self.score_reports_digest,
			&self.telemetry_digest,
			&self.capability_validation_digest,
			&self.prompt_set_digest,
			&self.stage_digest,
		] {
			validate_hash(digest, true)?;
		}

		if protocol::canonical_hash(&self.task_ids).ok().as_ref()
			!= Some(&self.task_selection_digest)
			|| protocol::canonical_hash(&self.models).ok().as_ref()
				!= Some(&self.model_selection_digest)
			|| protocol::canonical_hash(&self.scores).ok().as_ref()
				!= Some(&self.score_reports_digest)
			|| protocol::canonical_hash(&self.result_efficiency).ok().as_ref()
				!= Some(&self.telemetry_digest)
			|| self.provenance.run_class != RunClass::Calibration
			|| self.provenance.prompt_digest != self.prompt_set_digest
			|| self.compute_stage_digest()? != self.stage_digest
		{
			return Err(CalibrationVerificationError::new(
				"calibration stage commitment does not match",
			));
		}

		corpus_commitment::validate_run_provenance(
			&self.provenance,
			&self.task_set_hash,
			&self.capability_validation_digest,
		)
		.map_err(|error| CalibrationVerificationError::new(error.to_string()))
	}
}

/// Signed verifier binding for one calibration stage.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CalibrationVerifierAttestationV1 {
	/// Calibration attestation schema.
	pub schema_version: String,
	/// Signature algorithm identifier.
	pub signature_algorithm: String,
	/// Signature contract version.
	pub signature_version: String,
	/// Bound run identifier.
	pub run_id: String,
	/// Bound SHA-256 digest of the exact package bytes.
	pub package_sha256: String,
	/// Bound signed package content commitment.
	pub content_hash: String,
	/// Bound calibration stage digest.
	pub stage_digest: String,
	/// Bound runner identity.
	pub runner: NodeIdentity,
	/// Distinct verifier identity.
	pub verifier: NodeIdentity,
	/// Bound permanent non-Official classification.
	pub classification: String,
	/// Calibration run class.
	pub run_class: RunClass,
	/// False-only Official eligibility marker.
	pub official_eligible: FalseOnly,
	/// False-only ranking eligibility marker.
	pub ranking_eligible: FalseOnly,
	/// Public trust tier for this attestation.
	pub trust: TrustTier,
	/// Bound controlled task-set hash.
	pub task_set_hash: String,
	/// Bound terminal-attempt lineage digest.
	pub terminal_attempt_lineage_digest: String,
	/// Bound ordered task-selection digest.
	pub task_selection_digest: String,
	/// Bound ordered model-selection digest.
	pub model_selection_digest: String,
	/// Bound recomputed score-report digest.
	pub score_reports_digest: String,
	/// Bound efficiency-evidence digest.
	pub telemetry_digest: String,
	/// Bound capability-validation digest.
	pub capability_validation_digest: String,
	/// Bound correctness scoring version.
	pub scoring_version: String,
	/// Bound model-execution concurrency.
	pub execution_concurrency: usize,
	/// Verifier observation time in Unix milliseconds.
	pub observed_unix_ms: u64,
	/// Successful deterministic replay disposition.
	pub replay_status: CalibrationReplayStatus,
	/// Hex-encoded verifier signature.
	pub signature: String,
}
impl CalibrationVerifierAttestationV1 {
	/// Verifies every duplicated stage binding, identity separation, and signature.
	pub fn verify(
		&self,
		stage: &CalibrationVerifiedStageV1,
		expected_verifier: &NodeIdentity,
	) -> Result<(), CalibrationVerificationError> {
		if self.schema_version != CALIBRATION_VERIFIER_ATTESTATION_SCHEMA_VERSION
			|| self.signature_algorithm != VERIFIER_SIGNATURE_ALGORITHM
			|| self.signature_version != VERIFIER_SIGNATURE_VERSION
			|| &self.verifier != expected_verifier
			|| self.runner == self.verifier
			|| self.runner != stage.runner
			|| self.run_id != stage.run_id
			|| self.package_sha256 != stage.package_sha256
			|| self.content_hash != stage.content_hash
			|| self.stage_digest != stage.stage_digest
			|| self.classification != stage.classification
			|| self.run_class != RunClass::Calibration
			|| self.trust != TrustTier::Untrusted
			|| self.task_set_hash != stage.task_set_hash
			|| self.terminal_attempt_lineage_digest != stage.terminal_attempt_lineage_digest
			|| self.task_selection_digest != stage.task_selection_digest
			|| self.model_selection_digest != stage.model_selection_digest
			|| self.score_reports_digest != stage.score_reports_digest
			|| self.telemetry_digest != stage.telemetry_digest
			|| self.capability_validation_digest != stage.capability_validation_digest
			|| self.scoring_version != stage.scoring_version
			|| self.execution_concurrency != stage.execution_concurrency
			|| self.observed_unix_ms > MAX_JCS_SAFE_INTEGER
			|| !is_lower_hex(&self.signature, 128)
		{
			return Err(CalibrationVerificationError::new(
				"calibration attestation bindings are invalid",
			));
		}

		stage.verify()?;

		validate_node(&self.verifier)?;

		let public: [u8; 32] = hex::decode(&self.verifier.public_key)
			.map_err(|error| CalibrationVerificationError::new(error.to_string()))?
			.try_into()
			.map_err(|_| CalibrationVerificationError::new("verifier public key is invalid"))?;
		let signature = Signature::from_slice(
			&hex::decode(&self.signature)
				.map_err(|error| CalibrationVerificationError::new(error.to_string()))?,
		)
		.map_err(|error| CalibrationVerificationError::new(error.to_string()))?;
		let key = VerifyingKey::from_bytes(&public)
			.map_err(|error| CalibrationVerificationError::new(error.to_string()))?;
		let bytes = protocol::canonical_json(&UnsignedCalibrationAttestation::from(self))
			.map_err(|error| CalibrationVerificationError::new(error.to_string()))?;

		key.verify(&bytes, &signature)
			.map_err(|error| CalibrationVerificationError::new(error.to_string()))
	}
}

/// Exact controlled identities supplied independently of the signed runner package.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CalibrationAdmissionBindings {
	/// SHA-256 of the protected production identity reference.
	pub production_reference_sha256: String,
	/// SHA-256 of the independently pinned private final-build receipt.
	pub build_receipt_sha256: String,
	/// Runner identity approved by that reference.
	pub approved_runner: NodeIdentity,
	/// Verifier identity approved by that reference.
	pub approved_verifier: NodeIdentity,
	/// Canonical corpus commitment identity.
	pub corpus_commitment_sha256: String,
	/// Validated source-manifest identity.
	pub source_manifest_digest: String,
	/// Frozen runner source commit.
	pub runner_commit: String,
	/// Git tree object for the exact detached runner source commit.
	pub runner_source_tree: String,
	/// Recomputed task-set identity.
	pub task_set_digest: String,
	/// Recomputed evaluator identity.
	pub evaluator_digest: String,
	/// Validated model toolchain identity.
	pub model_toolchain_digest: String,
	/// Validated evaluator runtime executable identity.
	pub evaluator_runtime_digest: String,
	/// SHA-256 of the supplied frozen runner binary.
	pub runner_executable_digest: String,
	/// SHA-256 of the supplied frozen Codex binary.
	pub codex_executable_digest: String,
	/// SHA-256 of the supplied frozen Codex code-mode host.
	pub codex_code_mode_host_digest: String,
	/// SHA-256 of the verifier binary that issued the admission.
	pub verifier_executable_digest: String,
}

/// Immutable claims covered by one private calibration admission signature.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CalibrationAdmissionClaims {
	/// Stable calibration run identity.
	pub run_id: String,
	/// SHA-256 of the exact signed package bytes.
	pub package_sha256: String,
	/// Signed package content commitment.
	pub content_hash: String,
	/// Digest of the replay-verified calibration stage.
	pub stage_digest: String,
	/// Digest of the complete signed verifier attestation.
	pub attestation_digest: String,
	/// Retained calibration runner identity from the replayed package and stage.
	pub replay_runner: NodeIdentity,
	/// Current verifier identity that replayed and admitted the package.
	pub admission_verifier: NodeIdentity,
	/// Permanent non-Official classification.
	pub classification: String,
	/// Calibration-only execution class.
	pub run_class: RunClass,
	/// False-only Official marker.
	pub official_eligible: FalseOnly,
	/// False-only ranking marker.
	pub ranking_eligible: FalseOnly,
	/// Local evidence remains untrusted for Official publication.
	pub trust: TrustTier,
	/// Successful deterministic replay disposition.
	pub replay_status: CalibrationReplayStatus,
	/// Exact selected task count.
	pub task_count: usize,
	/// Exact selected model-configuration count.
	pub model_configuration_count: usize,
	/// Task-set content address.
	pub task_set_hash: String,
	/// Digest of the source run's terminal-attempt lineage.
	pub terminal_attempt_lineage_digest: String,
	/// Ordered task-selection identity.
	pub task_selection_digest: String,
	/// Ordered model-selection identity.
	pub model_selection_digest: String,
	/// Correctness scoring contract identity.
	pub scoring_version: String,
	/// Complete centered item bank fitted from the replayed calibration package.
	pub calibration_bank: FrozenCalibrationBankV2,
	/// Canonical digest of `calibration_bank`.
	pub calibration_bank_digest: String,
	/// Complete signed provenance of the replayed calibration package.
	pub replay_provenance: RunProvenanceCommitment,
	/// Applied fixed calibration policy identity.
	pub policy_digest: String,
	/// Applied diagnostic identity.
	pub diagnostic_digest: String,
	/// Complete passing fixed calibration diagnostic.
	pub diagnostic: OfficialCalibrationDiagnostic,
	/// Independently supplied current issuance and build authority bindings.
	pub issuance_bindings: CalibrationAdmissionBindings,
	/// Safe Unix-millisecond verifier observation time.
	pub observed_unix_ms: u64,
}

/// Private operational evidence that a complete signed calibration passed replay and diagnostics.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CalibrationAdmissionV3 {
	/// Admission schema.
	pub schema_version: String,
	/// Signature algorithm identifier.
	pub signature_algorithm: String,
	/// Signature contract version.
	pub signature_version: String,
	/// Immutable admission claims.
	pub claims: CalibrationAdmissionClaims,
	/// Canonical SHA-256 of `claims`.
	pub admission_digest: String,
	/// Verifier Ed25519 signature over the schema, claims, and digest.
	pub signature: String,
}
impl CalibrationAdmissionV3 {
	/// Verifies a signed admission for Official consumption without re-fitting its bank.
	pub fn verify_for_official(
		&self,
		expected_bindings: &CalibrationAdmissionBindings,
		tasks: &[TaskDefinition],
	) -> Result<(), CalibrationVerificationError> {
		let claims = &self.claims;
		let expected_verifier = &expected_bindings.approved_verifier;

		claims
			.calibration_bank
			.validate(tasks)
			.map_err(|error| CalibrationVerificationError::new(error.to_string()))?;

		if self.schema_version != CALIBRATION_ADMISSION_SCHEMA_VERSION
			|| self.signature_algorithm != VERIFIER_SIGNATURE_ALGORITHM
			|| self.signature_version != VERIFIER_SIGNATURE_VERSION
			|| claims.classification != "local_calibration_non_official"
			|| claims.run_class != RunClass::Calibration
			|| claims.trust != TrustTier::Untrusted
			|| claims.replay_status != CalibrationReplayStatus::EvaluatorReplayed
			|| claims.task_count != 72
			|| claims.model_configuration_count != MODEL_MATRIX.len()
			|| &claims.admission_verifier != expected_verifier
			|| &claims.issuance_bindings != expected_bindings
			|| claims.replay_runner != claims.issuance_bindings.approved_runner
			|| claims.admission_verifier != claims.issuance_bindings.approved_verifier
			|| claims.replay_runner == claims.admission_verifier
			|| claims.replay_provenance.run_class != RunClass::Calibration
			|| claims.replay_provenance.task_set_digest != claims.issuance_bindings.task_set_digest
			|| claims.replay_provenance.evaluator_digest
				!= claims.issuance_bindings.evaluator_digest
			|| claims.task_set_hash != claims.issuance_bindings.task_set_digest
			|| claims.scoring_version != AIQ_SCORING_VERSION
			|| claims.calibration_bank.source_package_sha256
				!= format!("sha256:{}", claims.package_sha256)
			|| claims.calibration_bank.task_set_digest != claims.task_set_hash
			|| claims.calibration_bank.task_set_digest != claims.issuance_bindings.task_set_digest
			|| claims.calibration_bank.evaluator_digest != claims.issuance_bindings.evaluator_digest
			|| claims.calibration_bank.policy_digest != claims.policy_digest
			|| claims.calibration_bank_digest
				!= claims
					.calibration_bank
					.digest()
					.map_err(|error| CalibrationVerificationError::new(error.to_string()))?
			|| claims.diagnostic.policy != OfficialCalibrationPolicy::default()
			|| claims.diagnostic.policy.version != claims.diagnostic.observed.policy_version
			|| claims.diagnostic.observed.tasks != 72
			|| claims.diagnostic.observed.model_configurations != MODEL_MATRIX.len()
			|| !claims.diagnostic.passed()
			|| claims.observed_unix_ms > MAX_JCS_SAFE_INTEGER
			|| !is_lower_hex(&claims.issuance_bindings.runner_commit, 40)
			|| !is_lower_hex(&claims.issuance_bindings.runner_source_tree, 40)
			|| !is_lower_hex(&claims.package_sha256, 64)
			|| !is_lower_hex(&self.signature, 128)
		{
			return Err(CalibrationVerificationError::new(
				"calibration admission bindings are invalid",
			));
		}

		self.verify_digest_bindings()?;

		validate_node(&claims.replay_runner)?;
		validate_node(&claims.admission_verifier)?;

		corpus_commitment::validate_run_provenance(
			&claims.replay_provenance,
			&claims.task_set_hash,
			&claims.replay_provenance.preflight_digest,
		)
		.map_err(|error| CalibrationVerificationError::new(error.to_string()))?;

		if protocol::canonical_hash(&claims.diagnostic.policy).ok().as_ref()
			!= Some(&claims.policy_digest)
			|| protocol::canonical_hash(&claims.diagnostic).ok().as_ref()
				!= Some(&claims.diagnostic_digest)
			|| protocol::canonical_hash(claims).ok().as_ref() != Some(&self.admission_digest)
		{
			return Err(CalibrationVerificationError::new(
				"calibration admission commitment does not match",
			));
		}

		let public: [u8; 32] = hex::decode(&claims.admission_verifier.public_key)
			.map_err(|error| CalibrationVerificationError::new(error.to_string()))?
			.try_into()
			.map_err(|_| CalibrationVerificationError::new("verifier public key is invalid"))?;
		let signature = Signature::from_slice(
			&hex::decode(&self.signature)
				.map_err(|error| CalibrationVerificationError::new(error.to_string()))?,
		)
		.map_err(|error| CalibrationVerificationError::new(error.to_string()))?;
		let key = VerifyingKey::from_bytes(&public)
			.map_err(|error| CalibrationVerificationError::new(error.to_string()))?;
		let bytes = protocol::canonical_json(&UnsignedCalibrationAdmission::from(self))
			.map_err(|error| CalibrationVerificationError::new(error.to_string()))?;

		key.verify(&bytes, &signature)
			.map_err(|error| CalibrationVerificationError::new(error.to_string()))
	}

	fn verify_digest_bindings(&self) -> Result<(), CalibrationVerificationError> {
		let claims = &self.claims;

		for digest in [
			&claims.content_hash,
			&claims.stage_digest,
			&claims.attestation_digest,
			&claims.task_set_hash,
			&claims.terminal_attempt_lineage_digest,
			&claims.task_selection_digest,
			&claims.model_selection_digest,
			&claims.policy_digest,
			&claims.diagnostic_digest,
			&claims.calibration_bank_digest,
			&claims.issuance_bindings.production_reference_sha256,
			&claims.issuance_bindings.build_receipt_sha256,
			&claims.issuance_bindings.corpus_commitment_sha256,
			&claims.issuance_bindings.source_manifest_digest,
			&claims.issuance_bindings.task_set_digest,
			&claims.issuance_bindings.evaluator_digest,
			&claims.issuance_bindings.model_toolchain_digest,
			&claims.issuance_bindings.evaluator_runtime_digest,
			&claims.issuance_bindings.runner_executable_digest,
			&claims.issuance_bindings.codex_executable_digest,
			&claims.issuance_bindings.codex_code_mode_host_digest,
			&claims.issuance_bindings.verifier_executable_digest,
			&self.admission_digest,
		] {
			validate_hash(digest, true)?;
		}

		Ok(())
	}

	/// Verifies the admission against external trust anchors and the complete source matrix.
	pub fn verify(
		&self,
		expected_bindings: &CalibrationAdmissionBindings,
		tasks: &[TaskDefinition],
		results: &[TaskResult],
	) -> Result<(), CalibrationVerificationError> {
		self.verify_for_official(expected_bindings, tasks)?;

		let claims = &self.claims;
		let expected_diagnostic = scoring::diagnose_official_calibration(tasks, results)
			.map_err(|error| CalibrationVerificationError::new(error.to_string()))?;
		let expected_bank = scoring::derive_frozen_calibration_bank(
			tasks,
			results,
			&claims.package_sha256,
			&claims.calibration_bank.source_scoring_version,
			&expected_bindings.task_set_digest,
			&expected_bindings.evaluator_digest,
		)
		.map_err(|error| CalibrationVerificationError::new(error.to_string()))?;
		let expected_lineage = protocol::canonical_hash(&runner::terminal_attempt_lineage(results))
			.map_err(|error| CalibrationVerificationError::new(error.to_string()))?;

		if claims.terminal_attempt_lineage_digest != expected_lineage
			|| claims.calibration_bank != expected_bank
			|| claims.diagnostic != expected_diagnostic
		{
			return Err(CalibrationVerificationError::new(
				"calibration admission source matrix does not match",
			));
		}

		Ok(())
	}
}

/// One transactionally published calibration evidence bundle.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CalibrationAdmissionBundleV3 {
	/// Bundle schema.
	pub schema_version: String,
	/// Replay-verified complete calibration stage.
	pub stage: CalibrationVerifiedStageV1,
	/// Verifier attestation bound to `stage`.
	pub attestation: CalibrationVerifierAttestationV1,
	/// Operational admission bound to the stage and attestation.
	pub admission: CalibrationAdmissionV3,
}
impl CalibrationAdmissionBundleV3 {
	/// Verifies a complete signed bundle for Official consumption without source results.
	pub fn verify_for_official(
		&self,
		expected_bindings: &CalibrationAdmissionBindings,
		tasks: &[TaskDefinition],
	) -> Result<(), CalibrationVerificationError> {
		self.verify_common(expected_bindings, tasks, None)
	}

	/// Verifies all bundle links against external trust anchors and the complete matrix.
	pub fn verify(
		&self,
		expected_bindings: &CalibrationAdmissionBindings,
		tasks: &[TaskDefinition],
		results: &[TaskResult],
	) -> Result<(), CalibrationVerificationError> {
		self.verify_common(expected_bindings, tasks, Some(results))
	}

	fn verify_common(
		&self,
		expected_bindings: &CalibrationAdmissionBindings,
		tasks: &[TaskDefinition],
		results: Option<&[TaskResult]>,
	) -> Result<(), CalibrationVerificationError> {
		if self.schema_version != CALIBRATION_ADMISSION_BUNDLE_SCHEMA_VERSION {
			return Err(CalibrationVerificationError::new(
				"calibration admission bundle schema is invalid",
			));
		}

		self.stage.verify()?;
		self.attestation.verify(&self.stage, &expected_bindings.approved_verifier)?;

		if let Some(results) = results {
			self.admission.verify(expected_bindings, tasks, results)?;
		} else {
			self.admission.verify_for_official(expected_bindings, tasks)?;
		}

		if self.admission.claims.run_id != self.stage.run_id
			|| self.admission.claims.package_sha256 != self.stage.package_sha256
			|| self.admission.claims.content_hash != self.stage.content_hash
			|| self.admission.claims.replay_runner != self.stage.runner
			|| self.admission.claims.classification != self.stage.classification
			|| self.admission.claims.task_set_hash != self.stage.task_set_hash
			|| self.admission.claims.terminal_attempt_lineage_digest
				!= self.stage.terminal_attempt_lineage_digest
			|| self.admission.claims.task_selection_digest != self.stage.task_selection_digest
			|| self.admission.claims.model_selection_digest != self.stage.model_selection_digest
			|| self.admission.claims.replay_provenance != self.stage.provenance
			|| self.admission.claims.observed_unix_ms != self.attestation.observed_unix_ms
			|| self.admission.claims.stage_digest != self.stage.stage_digest
			|| self.admission.claims.attestation_digest
				!= protocol::canonical_hash(&self.attestation)
					.map_err(|error| CalibrationVerificationError::new(error.to_string()))?
		{
			return Err(CalibrationVerificationError::new(
				"calibration admission bundle bindings are invalid",
			));
		}

		Ok(())
	}
}

#[derive(Serialize)]
struct UnsignedCalibrationAdmission<'a> {
	schema_version: &'a str,
	signature_algorithm: &'a str,
	signature_version: &'a str,
	claims: &'a CalibrationAdmissionClaims,
	admission_digest: &'a str,
}
impl<'a> From<&'a CalibrationAdmissionV3> for UnsignedCalibrationAdmission<'a> {
	fn from(admission: &'a CalibrationAdmissionV3) -> Self {
		Self {
			schema_version: &admission.schema_version,
			signature_algorithm: &admission.signature_algorithm,
			signature_version: &admission.signature_version,
			claims: &admission.claims,
			admission_digest: &admission.admission_digest,
		}
	}
}

#[derive(Serialize)]
struct UnsignedCalibrationStage<'a> {
	schema_version: &'a str,
	run_id: &'a str,
	package_sha256: &'a str,
	content_hash: &'a str,
	runner: &'a NodeIdentity,
	classification: &'a str,
	run_class: RunClass,
	official_eligible: FalseOnly,
	ranking_eligible: FalseOnly,
	trust: TrustTier,
	task_set_hash: &'a str,
	terminal_attempt_lineage_digest: &'a str,
	task_selection_digest: &'a str,
	model_selection_digest: &'a str,
	score_reports_digest: &'a str,
	telemetry_digest: &'a str,
	capability_validation_digest: &'a str,
	provenance: &'a RunProvenanceCommitment,
	evaluator_results_artifact: &'a ArtifactReference,
	scoring_version: &'a str,
	execution_concurrency: usize,
	task_ids: &'a [String],
	models: &'a [ModelConfig],
	scores: &'a [CalibrationVerifiedScore],
	result_efficiency: &'a [CalibrationResultEfficiency],
	pricing: &'a ApiEquivalentPricingModel,
	task_set_id: &'a str,
	task_set_version: &'a str,
	benchmark_version: &'a str,
	prompt_set_digest: &'a str,
	runner_commit: &'a str,
	region: &'a str,
	scheduled_unix_ms: u64,
	started_unix_ms: u64,
	finished_unix_ms: u64,
}
impl<'a> From<&'a CalibrationVerifiedStageV1> for UnsignedCalibrationStage<'a> {
	fn from(stage: &'a CalibrationVerifiedStageV1) -> Self {
		Self {
			schema_version: &stage.schema_version,
			run_id: &stage.run_id,
			package_sha256: &stage.package_sha256,
			content_hash: &stage.content_hash,
			runner: &stage.runner,
			classification: &stage.classification,
			run_class: stage.run_class,
			official_eligible: stage.official_eligible,
			ranking_eligible: stage.ranking_eligible,
			trust: stage.trust,
			task_set_hash: &stage.task_set_hash,
			terminal_attempt_lineage_digest: &stage.terminal_attempt_lineage_digest,
			task_selection_digest: &stage.task_selection_digest,
			model_selection_digest: &stage.model_selection_digest,
			score_reports_digest: &stage.score_reports_digest,
			telemetry_digest: &stage.telemetry_digest,
			capability_validation_digest: &stage.capability_validation_digest,
			provenance: &stage.provenance,
			evaluator_results_artifact: &stage.evaluator_results_artifact,
			scoring_version: &stage.scoring_version,
			execution_concurrency: stage.execution_concurrency,
			task_ids: &stage.task_ids,
			models: &stage.models,
			scores: &stage.scores,
			result_efficiency: &stage.result_efficiency,
			pricing: &stage.pricing,
			task_set_id: &stage.task_set_id,
			task_set_version: &stage.task_set_version,
			benchmark_version: &stage.benchmark_version,
			prompt_set_digest: &stage.prompt_set_digest,
			runner_commit: &stage.runner_commit,
			region: &stage.region,
			scheduled_unix_ms: stage.scheduled_unix_ms,
			started_unix_ms: stage.started_unix_ms,
			finished_unix_ms: stage.finished_unix_ms,
		}
	}
}

#[derive(Serialize)]
struct UnsignedCalibrationAttestation<'a> {
	schema_version: &'a str,
	signature_algorithm: &'a str,
	signature_version: &'a str,
	run_id: &'a str,
	package_sha256: &'a str,
	content_hash: &'a str,
	stage_digest: &'a str,
	runner: &'a NodeIdentity,
	verifier: &'a NodeIdentity,
	classification: &'a str,
	run_class: RunClass,
	official_eligible: FalseOnly,
	ranking_eligible: FalseOnly,
	trust: TrustTier,
	task_set_hash: &'a str,
	terminal_attempt_lineage_digest: &'a str,
	task_selection_digest: &'a str,
	model_selection_digest: &'a str,
	score_reports_digest: &'a str,
	telemetry_digest: &'a str,
	capability_validation_digest: &'a str,
	scoring_version: &'a str,
	execution_concurrency: usize,
	observed_unix_ms: u64,
	replay_status: CalibrationReplayStatus,
}
impl<'a> From<&'a CalibrationVerifierAttestationV1> for UnsignedCalibrationAttestation<'a> {
	fn from(attestation: &'a CalibrationVerifierAttestationV1) -> Self {
		Self {
			schema_version: &attestation.schema_version,
			signature_algorithm: &attestation.signature_algorithm,
			signature_version: &attestation.signature_version,
			run_id: &attestation.run_id,
			package_sha256: &attestation.package_sha256,
			content_hash: &attestation.content_hash,
			stage_digest: &attestation.stage_digest,
			runner: &attestation.runner,
			verifier: &attestation.verifier,
			classification: &attestation.classification,
			run_class: attestation.run_class,
			official_eligible: attestation.official_eligible,
			ranking_eligible: attestation.ranking_eligible,
			trust: attestation.trust,
			task_set_hash: &attestation.task_set_hash,
			terminal_attempt_lineage_digest: &attestation.terminal_attempt_lineage_digest,
			task_selection_digest: &attestation.task_selection_digest,
			model_selection_digest: &attestation.model_selection_digest,
			score_reports_digest: &attestation.score_reports_digest,
			telemetry_digest: &attestation.telemetry_digest,
			capability_validation_digest: &attestation.capability_validation_digest,
			scoring_version: &attestation.scoring_version,
			execution_concurrency: attestation.execution_concurrency,
			observed_unix_ms: attestation.observed_unix_ms,
			replay_status: attestation.replay_status,
		}
	}
}

/// Why an API-equivalent estimate is present or unavailable.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CostEstimateStatus {
	/// Every counter required by the standard-rate formula was reported.
	Estimated,
	/// At least one required provider counter was absent.
	UnavailableMissingUsage,
	/// Provider counters were internally inconsistent.
	UnavailableInvalidUsage,
	/// Aggregate input cannot prove that every request used short-context rates.
	UnavailableContextBand,
}

/// Evidence authority for one efficiency field.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EfficiencyEvidenceLevel {
	/// Measured by the runner clock and not independently reproducible.
	RunnerObserved,
	/// Numeric provider metadata extracted from retained evidence.
	ProviderReported,
	/// Independently parsed again by the verifier from exact retained bytes.
	VerifierRecomputed,
}

/// The only successful calibration replay disposition.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CalibrationReplayStatus {
	/// The verifier replayed every deterministic evaluator.
	EvaluatorReplayed,
}

/// Validates, recomputes, and creates a calibration stage without using Official normalization.
pub(crate) fn verify_calibration_run(
	run: &CalibrationRunRecord,
	tasks: &[TaskDefinition],
	package: &VerifiedPackageIdentity,
	metadata: &AttestedDeploymentMetadata,
	provider_usage: &[ProviderTokenUsage],
) -> Result<CalibrationVerifiedStageV1, CalibrationVerificationError> {
	verify_calibration_run_inner(run, tasks, package, metadata, provider_usage, false)
}

/// Checks the exact persisted time, token, and pricing contract for one complete matrix.
pub(crate) fn validate_efficiency_evidence_contract(
	models: &[ModelConfig],
	task_ids: &[String],
	result_efficiency: &[CalibrationResultEfficiency],
	aggregates: &[CalibrationEfficiencyAggregate],
	pricing: &ApiEquivalentPricingModel,
) -> Result<(), CalibrationVerificationError> {
	let model_set = models.iter().copied().collect::<BTreeSet<_>>();
	let task_set = task_ids.iter().map(String::as_str).collect::<BTreeSet<_>>();

	if pricing != &ApiEquivalentPricingModel::default()
		|| models.is_empty()
		|| models.len() > MODEL_MATRIX.len()
		|| model_set.len() != models.len()
		|| !model_set.iter().all(|model| MODEL_MATRIX.contains(model))
		|| task_ids.is_empty()
		|| task_ids.len() > 72
		|| task_set.len() != task_ids.len()
		|| task_ids.iter().any(|task_id| !is_identifier(task_id, 64))
		|| aggregates.len() != models.len()
		|| result_efficiency.len() != models.len().saturating_mul(task_ids.len())
	{
		return Err(CalibrationVerificationError::new(
			"efficiency evidence selection or pricing is outside the persisted contract",
		));
	}

	let mut pairs = BTreeSet::new();
	let mut source_result_ids = BTreeSet::new();

	for evidence in result_efficiency {
		validate_result_efficiency(evidence, pricing)?;

		if !models.contains(&evidence.model)
			|| !task_ids.contains(&evidence.task_id)
			|| !pairs.insert((evidence.model, evidence.task_id.as_str()))
			|| !source_result_ids.insert(evidence.source_result_id.as_str())
		{
			return Err(CalibrationVerificationError::new(
				"result efficiency evidence does not form one unique selected model-task matrix",
			));
		}
	}
	for (model, aggregate) in models.iter().copied().zip(aggregates) {
		let model_results =
			result_efficiency.iter().filter(|evidence| evidence.model == model).collect::<Vec<_>>();
		let expected = aggregate_efficiency(model, &model_results)?;

		if aggregate.model != model || aggregate != &expected {
			return Err(CalibrationVerificationError::new(
				"calibration efficiency aggregate does not match its result evidence",
			));
		}
	}

	Ok(())
}

/// Recomputes and signs one calibration run through one indivisible verifier boundary.
#[allow(clippy::too_many_arguments)]
pub fn verify_and_attest_calibration_run(
	identity: &VerifierSigningIdentity,
	run: &CalibrationRunRecord,
	tasks: &[TaskDefinition],
	package: &VerifiedPackageIdentity,
	metadata: &AttestedDeploymentMetadata,
	provider_usage: &[ProviderTokenUsage],
	observed_unix_ms: u64,
) -> Result<
	(CalibrationVerifiedStageV1, CalibrationVerifierAttestationV1),
	CalibrationVerificationError,
> {
	let stage = verify_calibration_run(run, tasks, package, metadata, provider_usage)?;
	let attestation = attest_calibration_stage(identity, &stage, observed_unix_ms)?;

	Ok((stage, attestation))
}

/// Recomputes and signs one promoted 1.0.7 calibration source without changing its run identity.
#[allow(clippy::too_many_arguments)]
pub fn verify_and_attest_calibration_source_1_0_7(
	identity: &VerifierSigningIdentity,
	run: &CalibrationRunRecord,
	tasks: &[TaskDefinition],
	package: &VerifiedPackageIdentity,
	metadata: &AttestedDeploymentMetadata,
	provider_usage: &[ProviderTokenUsage],
	observed_unix_ms: u64,
) -> Result<
	(CalibrationVerifiedStageV1, CalibrationVerifierAttestationV1),
	CalibrationVerificationError,
> {
	let stage = verify_calibration_run_inner(run, tasks, package, metadata, provider_usage, true)?;
	let attestation = attest_calibration_stage(identity, &stage, observed_unix_ms)?;

	Ok((stage, attestation))
}

/// Creates one verifier-signed operational admission for an exact full calibration.
///
/// This artifact remains permanently non-Official and non-ranking. It is not an
/// input to the frozen Official runner protocol.
pub fn sign_full_calibration_admission(
	identity: &VerifierSigningIdentity,
	stage: &CalibrationVerifiedStageV1,
	attestation: &CalibrationVerifierAttestationV1,
	tasks: &[TaskDefinition],
	results: &[TaskResult],
	source_scoring_version: &str,
	bindings: CalibrationAdmissionBindings,
) -> Result<CalibrationAdmissionV3, CalibrationVerificationError> {
	stage.verify()?;
	attestation.verify(stage, identity.node())?;

	let diagnostic = scoring::diagnose_official_calibration(tasks, results)
		.map_err(|error| CalibrationVerificationError::new(error.to_string()))?;

	if stage.task_ids.len() != 72
		|| stage.models != MODEL_MATRIX
		|| stage.runner != bindings.approved_runner
		|| identity.node() != &bindings.approved_verifier
		|| stage.runner == *identity.node()
		|| stage.provenance.task_set_digest != bindings.task_set_digest
		|| stage.provenance.evaluator_digest != bindings.evaluator_digest
		|| stage.provenance.corpus_commitment_sha256 != bindings.corpus_commitment_sha256
		|| stage.provenance.source_manifest_digest != bindings.source_manifest_digest
		|| stage.provenance.runner_executable_digest != bindings.runner_executable_digest
		|| stage.provenance.codex_executable_digest != bindings.codex_executable_digest
		|| stage.provenance.codex_code_mode_host_digest != bindings.codex_code_mode_host_digest
		|| stage.runner_commit != bindings.runner_commit
		|| stage.task_set_hash != bindings.task_set_digest
		|| diagnostic.policy != OfficialCalibrationPolicy::default()
		|| !diagnostic.passed()
		|| diagnostic.observed.tasks != 72
		|| diagnostic.observed.model_configurations != MODEL_MATRIX.len()
	{
		return Err(CalibrationVerificationError::new(
			"only an exact passing replay-verified 72-by-17 calibration can be admitted",
		));
	}

	let calibration_bank = scoring::derive_frozen_calibration_bank(
		tasks,
		results,
		&stage.package_sha256,
		source_scoring_version,
		&bindings.task_set_digest,
		&bindings.evaluator_digest,
	)
	.map_err(|error| CalibrationVerificationError::new(error.to_string()))?;
	let calibration_bank_digest = calibration_bank
		.digest()
		.map_err(|error| CalibrationVerificationError::new(error.to_string()))?;
	let claims = CalibrationAdmissionClaims {
		run_id: stage.run_id.clone(),
		package_sha256: stage.package_sha256.clone(),
		content_hash: stage.content_hash.clone(),
		stage_digest: stage.stage_digest.clone(),
		attestation_digest: protocol::canonical_hash(attestation)
			.map_err(|error| CalibrationVerificationError::new(error.to_string()))?,
		replay_runner: stage.runner.clone(),
		admission_verifier: identity.node().clone(),
		classification: stage.classification.clone(),
		run_class: RunClass::Calibration,
		official_eligible: FalseOnly,
		ranking_eligible: FalseOnly,
		trust: TrustTier::Untrusted,
		replay_status: CalibrationReplayStatus::EvaluatorReplayed,
		task_count: stage.task_ids.len(),
		model_configuration_count: stage.models.len(),
		task_set_hash: stage.task_set_hash.clone(),
		terminal_attempt_lineage_digest: stage.terminal_attempt_lineage_digest.clone(),
		task_selection_digest: stage.task_selection_digest.clone(),
		model_selection_digest: stage.model_selection_digest.clone(),
		scoring_version: AIQ_SCORING_VERSION.to_owned(),
		calibration_bank,
		calibration_bank_digest,
		replay_provenance: stage.provenance.clone(),
		policy_digest: protocol::canonical_hash(&diagnostic.policy)
			.map_err(|error| CalibrationVerificationError::new(error.to_string()))?,
		diagnostic_digest: protocol::canonical_hash(&diagnostic)
			.map_err(|error| CalibrationVerificationError::new(error.to_string()))?,
		diagnostic,
		issuance_bindings: bindings,
		observed_unix_ms: attestation.observed_unix_ms,
	};
	let admission = sign_calibration_admission_claims(identity, claims)?;

	admission.verify(&admission.claims.issuance_bindings, tasks, results)?;

	Ok(admission)
}

/// Renews only the operational issuance bindings of a previously valid admission bundle.
///
/// The target bindings must retain every immutable calibration authority. The source package,
/// result artifacts, model, and evaluator are not inputs to this operation.
pub fn renew_calibration_admission(
	identity: &VerifierSigningIdentity,
	source: &CalibrationAdmissionBundleV3,
	target_bindings: CalibrationAdmissionBindings,
	tasks: &[TaskDefinition],
) -> Result<CalibrationAdmissionBundleV3, CalibrationVerificationError> {
	let source_bindings = &source.admission.claims.issuance_bindings;

	if !same_immutable_calibration_authority(source_bindings, &target_bindings)
		|| identity.node() != &target_bindings.approved_verifier
	{
		return Err(CalibrationVerificationError::new(
			"calibration admission renewal changed immutable calibration authority",
		));
	}

	// The independently supplied target identities are compared above before this verifies the
	// source signatures with the source bundle's approved verifier key.
	source.verify_for_official(source_bindings, tasks)?;

	let provenance = &source.admission.claims.replay_provenance;

	// Corpus and source provenance identify the historical replay inputs. They remain signed
	// evidence across renewal; only replay identities shared with issuance authority must match.
	if provenance.task_set_digest != source_bindings.task_set_digest
		|| provenance.evaluator_digest != source_bindings.evaluator_digest
		|| provenance.codex_executable_digest != source_bindings.codex_executable_digest
		|| provenance.codex_code_mode_host_digest != source_bindings.codex_code_mode_host_digest
	{
		return Err(CalibrationVerificationError::new(
			"source calibration admission does not match its immutable replay authority",
		));
	}

	let mut claims = source.admission.claims.clone();

	claims.issuance_bindings = target_bindings.clone();

	let admission = sign_calibration_admission_claims(identity, claims)?;
	let renewed = CalibrationAdmissionBundleV3 {
		schema_version: source.schema_version.clone(),
		stage: source.stage.clone(),
		attestation: source.attestation.clone(),
		admission,
	};

	renewed.verify_for_official(&target_bindings, tasks)?;

	Ok(renewed)
}

/// Builds verifier-facing efficiency evidence without changing score semantics.
pub fn build_efficiency_evidence(
	results: &[TaskResult],
	provider_usage: &[ProviderTokenUsage],
	synthetic_uninvoked: bool,
) -> Result<
	(
		Vec<CalibrationResultEfficiency>,
		Vec<CalibrationEfficiencyAggregate>,
		ApiEquivalentPricingModel,
	),
	CalibrationVerificationError,
> {
	if results.len() != provider_usage.len() {
		return Err(CalibrationVerificationError::new(
			"provider usage must align with every source result",
		));
	}

	let pricing = ApiEquivalentPricingModel::default();
	let observations = results
		.iter()
		.zip(provider_usage)
		.map(|(result, usage)| result_efficiency(result, usage, &pricing, synthetic_uninvoked))
		.collect::<Result<Vec<_>, CalibrationVerificationError>>()?;
	let aggregates = MODEL_MATRIX
		.iter()
		.copied()
		.filter(|model| results.iter().any(|result| result.model == *model))
		.map(|model| {
			let model_results =
				observations.iter().filter(|result| result.model == model).collect::<Vec<_>>();

			aggregate_efficiency(model, &model_results)
		})
		.collect::<Result<Vec<_>, CalibrationVerificationError>>()?;

	Ok((observations, aggregates, pricing))
}

/// Signs one already verified non-Official calibration stage with a distinct verifier identity.
pub fn attest_calibration_stage(
	identity: &VerifierSigningIdentity,
	stage: &CalibrationVerifiedStageV1,
	observed_unix_ms: u64,
) -> Result<CalibrationVerifierAttestationV1, CalibrationVerificationError> {
	stage.verify()?;

	if identity.node() == &stage.runner || observed_unix_ms > MAX_JCS_SAFE_INTEGER {
		return Err(CalibrationVerificationError::new(
			"calibration verifier identity or observation time is invalid",
		));
	}

	let mut attestation = CalibrationVerifierAttestationV1 {
		schema_version: CALIBRATION_VERIFIER_ATTESTATION_SCHEMA_VERSION.to_owned(),
		signature_algorithm: VERIFIER_SIGNATURE_ALGORITHM.to_owned(),
		signature_version: VERIFIER_SIGNATURE_VERSION.to_owned(),
		run_id: stage.run_id.clone(),
		package_sha256: stage.package_sha256.clone(),
		content_hash: stage.content_hash.clone(),
		stage_digest: stage.stage_digest.clone(),
		runner: stage.runner.clone(),
		verifier: identity.node().clone(),
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
	let bytes = protocol::canonical_json(&UnsignedCalibrationAttestation::from(&attestation))
		.map_err(|error| CalibrationVerificationError::new(error.to_string()))?;

	attestation.signature = identity.sign_calibration_bytes(&bytes);

	attestation.verify(stage, identity.node())?;

	Ok(attestation)
}

fn same_immutable_calibration_authority(
	source: &CalibrationAdmissionBindings,
	target: &CalibrationAdmissionBindings,
) -> bool {
	// The build receipt, repository commit/tree, and runner/verifier executable digests are the
	// complete renewal allowlist. Every field compared here is immutable across renewal.
	source.production_reference_sha256 == target.production_reference_sha256
		&& source.approved_runner == target.approved_runner
		&& source.approved_verifier == target.approved_verifier
		&& source.corpus_commitment_sha256 == target.corpus_commitment_sha256
		&& source.source_manifest_digest == target.source_manifest_digest
		&& source.task_set_digest == target.task_set_digest
		&& source.evaluator_digest == target.evaluator_digest
		&& source.model_toolchain_digest == target.model_toolchain_digest
		&& source.evaluator_runtime_digest == target.evaluator_runtime_digest
		&& source.codex_executable_digest == target.codex_executable_digest
		&& source.codex_code_mode_host_digest == target.codex_code_mode_host_digest
}

fn sign_calibration_admission_claims(
	identity: &VerifierSigningIdentity,
	claims: CalibrationAdmissionClaims,
) -> Result<CalibrationAdmissionV3, CalibrationVerificationError> {
	let admission_digest = protocol::canonical_hash(&claims)
		.map_err(|error| CalibrationVerificationError::new(error.to_string()))?;
	let mut admission = CalibrationAdmissionV3 {
		schema_version: CALIBRATION_ADMISSION_SCHEMA_VERSION.to_owned(),
		signature_algorithm: VERIFIER_SIGNATURE_ALGORITHM.to_owned(),
		signature_version: VERIFIER_SIGNATURE_VERSION.to_owned(),
		claims,
		admission_digest,
		signature: String::new(),
	};
	let bytes = protocol::canonical_json(&UnsignedCalibrationAdmission::from(&admission))
		.map_err(|error| CalibrationVerificationError::new(error.to_string()))?;

	admission.signature = identity.sign_calibration_bytes(&bytes);

	Ok(admission)
}

fn verify_calibration_run_inner(
	run: &CalibrationRunRecord,
	tasks: &[TaskDefinition],
	package: &VerifiedPackageIdentity,
	metadata: &AttestedDeploymentMetadata,
	provider_usage: &[ProviderTokenUsage],
	calibration_source_1_0_7: bool,
) -> Result<CalibrationVerifiedStageV1, CalibrationVerificationError> {
	runner::validate_terminal_attempt_lineage(&run.results, &run.terminal_attempt_lineage)
		.map_err(|error| CalibrationVerificationError::new(error.to_string()))?;

	let execution_concurrency = run.execution_concurrency.ok_or_else(|| {
		CalibrationVerificationError::new(
			"calibration verification requires a bound execution concurrency",
		)
	})?;

	if provider_usage.len() != run.results.len() {
		return Err(CalibrationVerificationError::new(
			"provider usage must align with every calibration result",
		));
	}

	validate_calibration_run_identity(run, tasks, calibration_source_1_0_7)?;

	submission::validate_calibration_signer_binding(run, &package.signer.node_id)
		.map_err(|error| CalibrationVerificationError::new(error.to_string()))?;

	validate_metadata(run, package, metadata)?;

	let pricing = ApiEquivalentPricingModel::default();
	let result_efficiency = run
		.results
		.iter()
		.zip(provider_usage)
		.map(|(result, usage)| result_efficiency(result, usage, &pricing, false))
		.collect::<Result<Vec<_>, CalibrationVerificationError>>()?;
	let scores = run
		.models
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
			let score = scoring::score_calibration_model_with_context(
				tasks,
				&run.results,
				model,
				ScoreContext {
					preflight_configuration_not_applicable,
					receiver_authorized_publication: false,
				},
				ScoreOptions::default(),
			)
			.map_err(|error| CalibrationVerificationError::new(error.to_string()))?;
			let model_results =
				result_efficiency.iter().filter(|result| result.model == model).collect::<Vec<_>>();

			Ok(CalibrationVerifiedScore {
				model,
				score,
				efficiency: aggregate_efficiency(model, &model_results)?,
			})
		})
		.collect::<Result<Vec<_>, CalibrationVerificationError>>()?;
	let capability_validation_digest = protocol::canonical_hash(&run.capability_validation)
		.map_err(|error| CalibrationVerificationError::new(error.to_string()))?;
	let mut stage = CalibrationVerifiedStageV1 {
		schema_version: CALIBRATION_VERIFIED_STAGE_SCHEMA_VERSION.to_owned(),
		run_id: run.run_id.clone(),
		package_sha256: package.package_sha256.clone(),
		content_hash: package.content_hash.clone(),
		runner: package.signer.clone(),
		classification: run.classification.clone(),
		run_class: RunClass::Calibration,
		official_eligible: FalseOnly,
		ranking_eligible: FalseOnly,
		trust: TrustTier::Untrusted,
		task_set_hash: run.task_set_hash.clone(),
		terminal_attempt_lineage_digest: protocol::canonical_hash(&run.terminal_attempt_lineage)
			.map_err(|error| CalibrationVerificationError::new(error.to_string()))?,
		task_selection_digest: protocol::canonical_hash(&run.task_ids)
			.map_err(|error| CalibrationVerificationError::new(error.to_string()))?,
		model_selection_digest: protocol::canonical_hash(&run.models)
			.map_err(|error| CalibrationVerificationError::new(error.to_string()))?,
		score_reports_digest: protocol::canonical_hash(&scores)
			.map_err(|error| CalibrationVerificationError::new(error.to_string()))?,
		telemetry_digest: protocol::canonical_hash(&result_efficiency)
			.map_err(|error| CalibrationVerificationError::new(error.to_string()))?,
		capability_validation_digest,
		provenance: run.provenance.clone(),
		evaluator_results_artifact: run.evaluator_results_artifact.clone(),
		scoring_version: run.scoring_version.clone(),
		execution_concurrency,
		task_ids: run.task_ids.clone(),
		models: run.models.clone(),
		scores,
		result_efficiency,
		pricing,
		task_set_id: metadata.task_set_id.clone(),
		task_set_version: metadata.task_set_version.clone(),
		benchmark_version: metadata.benchmark_version.clone(),
		prompt_set_digest: metadata.prompt_set_digest.clone(),
		runner_commit: metadata.runner_commit.clone(),
		region: metadata.region.clone(),
		scheduled_unix_ms: metadata.scheduled_unix_ms,
		started_unix_ms: metadata.started_unix_ms,
		finished_unix_ms: metadata.finished_unix_ms,
		stage_digest: String::new(),
	};

	stage.stage_digest = stage.compute_stage_digest()?;

	stage.verify()?;

	Ok(stage)
}

fn validate_calibration_run_identity(
	run: &CalibrationRunRecord,
	tasks: &[TaskDefinition],
	calibration_source_1_0_7: bool,
) -> Result<(), CalibrationVerificationError> {
	let validation = if calibration_source_1_0_7 {
		run_validation::validate_calibration_source_1_0_7_with_tasks(run, tasks)
	} else {
		run_validation::validate_calibration_run_record_with_tasks(run, tasks)
	};

	validation.map_err(|error| CalibrationVerificationError::new(error.to_string()))
}

fn rates(
	model: &str,
	input: u64,
	cached: u64,
	cache_write: u64,
	output: u64,
) -> ApiEquivalentTokenRates {
	ApiEquivalentTokenRates {
		model: model.to_owned(),
		input_usd_nanos_per_token: input,
		cached_input_usd_nanos_per_token: cached,
		cache_write_input_usd_nanos_per_token: cache_write,
		output_usd_nanos_per_token: output,
	}
}

fn result_efficiency(
	result: &TaskResult,
	provider_usage: &ProviderTokenUsage,
	pricing: &ApiEquivalentPricingModel,
	synthetic_uninvoked: bool,
) -> Result<CalibrationResultEfficiency, CalibrationVerificationError> {
	validate_provider_token_usage(provider_usage)?;

	let provider_tokens = provider_usage.clone();
	let (standard_api_equivalent_usd_nanos, cost_status) =
		estimate_cost(result.model, &provider_tokens, pricing);
	let adapter_invoked = !synthetic_uninvoked
		&& !matches!(
			result.failure.as_ref().map(|failure| failure.kind),
			Some(
				FailureKind::CapabilityUnavailable
					| FailureKind::CapabilityValidationFailed
					| FailureKind::WorkspaceUnavailable
			)
		);

	if !adapter_invoked && !provider_tokens.is_empty() {
		return Err(CalibrationVerificationError::new(
			"an adapter-uninvoked calibration result cannot report provider usage",
		));
	}

	let observed_wall_ms = adapter_invoked.then_some(result.latency.wall_ms);
	let has_provider_usage = !provider_tokens.is_empty();
	let observation = CalibrationResultEfficiency {
		source_result_id: result.result_id.clone(),
		task_id: result.task_id.clone(),
		model: result.model,
		observed_wall_ms,
		wall_time_evidence_level: observed_wall_ms.map(|_| EfficiencyEvidenceLevel::RunnerObserved),
		provider_tokens,
		provider_tokens_source: has_provider_usage
			.then_some(EfficiencyEvidenceLevel::ProviderReported),
		provider_tokens_evidence_level: has_provider_usage
			.then_some(EfficiencyEvidenceLevel::VerifierRecomputed),
		standard_api_equivalent_usd_nanos,
		cost_status,
		cost_evidence_level: standard_api_equivalent_usd_nanos
			.map(|_| EfficiencyEvidenceLevel::VerifierRecomputed),
	};

	validate_result_efficiency(&observation, pricing)?;

	Ok(observation)
}

fn estimate_cost(
	model: ModelConfig,
	usage: &ProviderTokenUsage,
	pricing: &ApiEquivalentPricingModel,
) -> (Option<u64>, CostEstimateStatus) {
	let (Some(input), Some(cached), Some(cache_write), Some(output)) =
		(usage.input, usage.cached_input, usage.cache_write_input, usage.output)
	else {
		return (None, CostEstimateStatus::UnavailableMissingUsage);
	};

	if input > MAX_SHORT_CONTEXT_INPUT_TOKENS {
		return (None, CostEstimateStatus::UnavailableContextBand);
	}

	let Some(non_cached) =
		input.checked_sub(cached).and_then(|value| value.checked_sub(cache_write))
	else {
		return (None, CostEstimateStatus::UnavailableInvalidUsage);
	};
	let model_id = match model.family {
		ModelFamily::Sol => "gpt-5.6-sol",
		ModelFamily::Terra => "gpt-5.6-terra",
		ModelFamily::Luna => "gpt-5.6-luna",
	};
	let Some(rate) = pricing.rates.iter().find(|rate| rate.model == model_id) else {
		return (None, CostEstimateStatus::UnavailableMissingUsage);
	};
	let estimate = non_cached
		.checked_mul(rate.input_usd_nanos_per_token)
		.and_then(|value| {
			cached
				.checked_mul(rate.cached_input_usd_nanos_per_token)
				.and_then(|cached| value.checked_add(cached))
		})
		.and_then(|value| {
			cache_write
				.checked_mul(rate.cache_write_input_usd_nanos_per_token)
				.and_then(|cache_write| value.checked_add(cache_write))
		})
		.and_then(|value| {
			output
				.checked_mul(rate.output_usd_nanos_per_token)
				.and_then(|output| value.checked_add(output))
		});

	match estimate {
		Some(estimate) if estimate <= MAX_JCS_SAFE_INTEGER => {
			(Some(estimate), CostEstimateStatus::Estimated)
		},
		_ => (None, CostEstimateStatus::UnavailableInvalidUsage),
	}
}

fn aggregate_efficiency(
	model: ModelConfig,
	results: &[&CalibrationResultEfficiency],
) -> Result<CalibrationEfficiencyAggregate, CalibrationVerificationError> {
	if results.is_empty() || results.len() > 72 {
		return Err(CalibrationVerificationError::new(
			"efficiency aggregate task count is invalid",
		));
	}

	let mut walls = results.iter().filter_map(|result| result.observed_wall_ms).collect::<Vec<_>>();

	walls.sort_unstable();

	let provider_token_totals = ProviderTokenUsage {
		input: sum_present(results, |usage| usage.input)?,
		cached_input: sum_present(results, |usage| usage.cached_input)?,
		cache_write_input: sum_present(results, |usage| usage.cache_write_input)?,
		output: sum_present(results, |usage| usage.output)?,
		reasoning: sum_present(results, |usage| usage.reasoning)?,
		total: sum_present(results, |usage| usage.total)?,
	};

	validate_provider_token_usage(&provider_token_totals)?;

	let estimated = results
		.iter()
		.filter_map(|result| result.standard_api_equivalent_usd_nanos)
		.collect::<Vec<_>>();
	let total_estimated_cost = if estimated.len() == results.len() {
		estimated
			.iter()
			.copied()
			.try_fold(0_u64, u64::checked_add)
			.filter(|total| *total <= MAX_JCS_SAFE_INTEGER)
	} else {
		None
	};
	let total_wall = if walls.is_empty() {
		None
	} else {
		Some(checked_jcs_sum(walls.iter().copied(), "observed wall time")?)
	};
	let median = (!walls.is_empty()).then(|| {
		let middle = walls.len() / 2;

		if walls.len() % 2 == 0 {
			let lower = walls[middle - 1];
			let upper = walls[middle];

			lower + (upper - lower) / 2
		} else {
			walls[middle]
		}
	});
	let p95 = (!walls.is_empty()).then(|| walls[(walls.len() * 95).div_ceil(100) - 1]);

	Ok(CalibrationEfficiencyAggregate {
		schema_version: CALIBRATION_EFFICIENCY_SCHEMA_VERSION.to_owned(),
		model,
		selected_tasks: results.len(),
		observed_wall_tasks: walls.len(),
		total_observed_wall_ms: total_wall,
		median_observed_wall_ms: median,
		p95_observed_wall_ms: p95,
		provider_token_totals,
		provider_token_coverage: ProviderTokenCoverage {
			selected_tasks: results.len(),
			input_tasks: count_present(results, |usage| usage.input),
			cached_input_tasks: count_present(results, |usage| usage.cached_input),
			cache_write_input_tasks: count_present(results, |usage| usage.cache_write_input),
			output_tasks: count_present(results, |usage| usage.output),
			reasoning_tasks: count_present(results, |usage| usage.reasoning),
			total_tasks: count_present(results, |usage| usage.total),
		},
		estimated_cost_tasks: estimated.len(),
		standard_api_equivalent_usd_nanos: total_estimated_cost,
	})
}

fn count_present<F>(results: &[&CalibrationResultEfficiency], field: F) -> usize
where
	F: Fn(&ProviderTokenUsage) -> Option<u64>,
{
	results.iter().filter(|result| field(&result.provider_tokens).is_some()).count()
}

fn sum_present<F>(
	results: &[&CalibrationResultEfficiency],
	field: F,
) -> Result<Option<u64>, CalibrationVerificationError>
where
	F: Fn(&ProviderTokenUsage) -> Option<u64>,
{
	let values = results.iter().filter_map(|result| field(&result.provider_tokens));

	checked_optional_jcs_sum(values, "provider token total")
}

fn checked_optional_jcs_sum(
	values: impl IntoIterator<Item = u64>,
	label: &str,
) -> Result<Option<u64>, CalibrationVerificationError> {
	let mut values = values.into_iter();
	let Some(first) = values.next() else { return Ok(None) };

	checked_jcs_sum(iter::once(first).chain(values), label).map(Some)
}

fn checked_jcs_sum(
	values: impl IntoIterator<Item = u64>,
	label: &str,
) -> Result<u64, CalibrationVerificationError> {
	let total = values.into_iter().try_fold(0_u64, u64::checked_add).ok_or_else(|| {
		CalibrationVerificationError::new(format!("{label} overflows its integer representation"))
	})?;

	if total > MAX_JCS_SAFE_INTEGER {
		return Err(CalibrationVerificationError::new(format!(
			"{label} exceeds the JCS safe integer range"
		)));
	}

	Ok(total)
}

fn validate_provider_token_usage(
	usage: &ProviderTokenUsage,
) -> Result<(), CalibrationVerificationError> {
	let counters = [
		usage.input,
		usage.cached_input,
		usage.cache_write_input,
		usage.output,
		usage.reasoning,
		usage.total,
	];

	if counters.into_iter().flatten().any(|value| value > MAX_JCS_SAFE_INTEGER)
		|| matches!((usage.input, usage.cached_input), (Some(input), Some(cached)) if cached > input)
		|| matches!((usage.output, usage.reasoning), (Some(output), Some(reasoning)) if reasoning > output)
	{
		return Err(CalibrationVerificationError::new(
			"provider token usage is outside the persisted calibration contract",
		));
	}

	Ok(())
}

fn validate_result_efficiency(
	evidence: &CalibrationResultEfficiency,
	pricing: &ApiEquivalentPricingModel,
) -> Result<(), CalibrationVerificationError> {
	validate_provider_token_usage(&evidence.provider_tokens)?;

	let expected_wall_level =
		evidence.observed_wall_ms.map(|_| EfficiencyEvidenceLevel::RunnerObserved);
	let has_provider_usage = !evidence.provider_tokens.is_empty();
	let expected_provider_source =
		has_provider_usage.then_some(EfficiencyEvidenceLevel::ProviderReported);
	let expected_provider_evidence =
		has_provider_usage.then_some(EfficiencyEvidenceLevel::VerifierRecomputed);
	let (expected_cost, expected_cost_status) =
		estimate_cost(evidence.model, &evidence.provider_tokens, pricing);
	let expected_cost_evidence = expected_cost.map(|_| EfficiencyEvidenceLevel::VerifierRecomputed);

	if !evidence
		.source_result_id
		.strip_prefix("result_")
		.is_some_and(|digest| is_lower_hex(digest, 64))
		|| !is_identifier(&evidence.task_id, 64)
		|| !MODEL_MATRIX.contains(&evidence.model)
		|| evidence.observed_wall_ms.is_some_and(|value| value > MAX_JCS_SAFE_INTEGER)
		|| evidence.wall_time_evidence_level != expected_wall_level
		|| evidence.provider_tokens_source != expected_provider_source
		|| evidence.provider_tokens_evidence_level != expected_provider_evidence
		|| evidence.standard_api_equivalent_usd_nanos != expected_cost
		|| evidence.cost_status != expected_cost_status
		|| evidence.cost_evidence_level != expected_cost_evidence
	{
		return Err(CalibrationVerificationError::new(
			"result efficiency evidence is outside the persisted calibration contract",
		));
	}

	Ok(())
}

fn validate_metadata(
	run: &CalibrationRunRecord,
	package: &VerifiedPackageIdentity,
	metadata: &AttestedDeploymentMetadata,
) -> Result<(), CalibrationVerificationError> {
	validate_node(&package.signer)?;
	validate_hash(&package.package_sha256, false)?;
	validate_hash(&package.content_hash, true)?;
	validate_hash(&metadata.prompt_set_digest, true)?;

	if metadata.synthetic_test
		|| metadata.task_set_id != AIQ_TASK_SET_ID
		|| metadata.task_set_version != AIQ_TASK_SET_VERSION
		|| metadata.benchmark_version != AIQ_BENCHMARK_VERSION
		|| metadata.prompt_set_digest != run.provenance.prompt_digest
		|| metadata.started_unix_ms != run.started_unix_ms
		|| metadata.finished_unix_ms != run.finished_unix_ms
		|| !is_identifier(&metadata.region, 64)
		|| !(7..=40).contains(&metadata.runner_commit.len())
		|| !metadata.runner_commit.bytes().all(|byte| byte.is_ascii_hexdigit())
	{
		return Err(CalibrationVerificationError::new(
			"calibration deployment metadata is invalid",
		));
	}

	Ok(())
}

fn validate_node(node: &NodeIdentity) -> Result<(), CalibrationVerificationError> {
	if !node.node_id.strip_prefix("node_").is_some_and(|value| is_lower_hex(value, 64))
		|| !is_lower_hex(&node.public_key, 64)
	{
		return Err(CalibrationVerificationError::new("node identity is invalid"));
	}

	let public_key = hex::decode(&node.public_key)
		.map_err(|_| CalibrationVerificationError::new("node identity is invalid"))?;
	let expected_node_id = format!("node_{}", hex::encode(Sha256::digest(public_key)));

	if node.node_id != expected_node_id {
		return Err(CalibrationVerificationError::new(
			"node identifier does not derive from its public key",
		));
	}

	Ok(())
}

fn validate_hash(value: &str, prefixed: bool) -> Result<(), CalibrationVerificationError> {
	let digest = if prefixed { value.strip_prefix("sha256:") } else { Some(value) };

	if !digest.is_some_and(|digest| is_lower_hex(digest, 64)) {
		return Err(CalibrationVerificationError::new("digest is invalid"));
	}

	Ok(())
}

fn is_lower_hex(value: &str, length: usize) -> bool {
	value.len() == length
		&& value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_identifier(value: &str, maximum_bytes: usize) -> bool {
	!value.is_empty()
		&& value.len() <= maximum_bytes
		&& value
			.bytes()
			.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

#[cfg(test)]
mod tests {
	use std::{fs, path::PathBuf, slice};

	use crate::calibration_verification::{
		self, ApiEquivalentPricingModel, CostEstimateStatus, MAX_JCS_SAFE_INTEGER,
	};
	use crate::{
		model::MODEL_MATRIX,
		protocol::SigningIdentity,
		runner::{self, FailureKind, ProviderTokenUsage, ResultFailure},
		schedule::{ScheduleConfig, ScheduleOccurrence},
	};

	#[test]
	fn node_identity_and_region_metadata_use_the_exact_public_contract() {
		let mut node = SigningIdentity::from_secret([41; 32]).node().clone();

		super::validate_node(&node).expect("derived node identity");

		let replacement = if &node.node_id[5..6] == "a" { "b" } else { "a" };

		node.node_id.replace_range(5..6, replacement);

		assert!(super::validate_node(&node).is_err());
		assert!(super::is_identifier("us-east-1.local", 64));
		assert!(!super::is_identifier("us east 1", 64));
		assert!(!super::is_identifier(&"x".repeat(65), 64));
	}

	#[test]
	fn standard_cost_formula_separates_cache_reads_writes_and_output() {
		let usage = ProviderTokenUsage {
			input: Some(100_000),
			cached_input: Some(20_000),
			cache_write_input: Some(10_000),
			output: Some(10_000),
			reasoning: Some(4_000),
			total: None,
		};
		let pricing = ApiEquivalentPricingModel::default();
		let expected_costs = [
			(MODEL_MATRIX[0], 722_500_000),
			(MODEL_MATRIX[6], 289_000_000),
			(MODEL_MATRIX[12], 28_900_000),
		];

		for (model, expected) in expected_costs {
			let (cost, status) = calibration_verification::estimate_cost(model, &usage, &pricing);

			assert_eq!(status, CostEstimateStatus::Estimated);
			assert_eq!(cost, Some(expected));
		}

		assert_eq!(
			pricing
				.rates
				.iter()
				.map(|rate| (
					rate.model.as_str(),
					rate.input_usd_nanos_per_token,
					rate.cached_input_usd_nanos_per_token,
					rate.cache_write_input_usd_nanos_per_token,
					rate.output_usd_nanos_per_token,
				))
				.collect::<Vec<_>>(),
			vec![
				("gpt-5.6-sol", 5_000, 500, 6_250, 30_000),
				("gpt-5.6-terra", 2_000, 200, 2_500, 12_000),
				("gpt-5.6-luna", 200, 20, 250, 1_200),
			]
		);
	}

	fn contract_section<'a>(source: &'a str, start: &str, end: &str) -> &'a str {
		let start_index = source.find(start).unwrap_or_else(|| panic!("missing {start}"));
		let suffix = &source[start_index..];
		let end_index = suffix.find(end).unwrap_or_else(|| panic!("missing {end}"));

		&suffix[..end_index]
	}

	fn assert_bound_literal(section: &str, binding: &str, literal: &str, label: &str) {
		let binding_index =
			section.find(binding).unwrap_or_else(|| panic!("missing {label} binding"));
		let literal_index = section[binding_index..]
			.find(literal)
			.unwrap_or_else(|| panic!("missing {label} literal"));

		assert!(literal_index < 256, "{label} literal is not bound to its field");
	}

	fn assert_database_and_web_pricing_scalars(
		pricing: &serde_json::Value,
		database: &str,
		web: &str,
	) {
		for field in ["method", "version", "as_of", "source", "currency", "processing_tier"] {
			let literal = pricing[field].as_str().expect("pricing text field must be text");

			assert_bound_literal(database, &format!("candidate->>'{field}'"), literal, field);

			assert!(
				web.contains(&format!("value.{field} === '{literal}'")),
				"web pricing {field} drifted"
			);
		}
		for (field, binding) in [("formula", "pricingFormula"), ("limitation", "pricingLimitation")]
		{
			let literal = pricing[field].as_str().expect("pricing text field must be text");

			assert_bound_literal(database, &format!("candidate->>'{field}'"), literal, field);

			assert!(web.contains(literal), "web pricing {field} literal drifted");
			assert!(
				web.contains(&format!("value.{field} === {binding}")),
				"web pricing {field} binding drifted"
			);
		}

		assert!(
			database.contains("candidate->'hosted_tool_fees_included'='false'::jsonb"),
			"database hosted-tool pricing policy drifted"
		);
		assert!(
			web.contains("value.hosted_tool_fees_included === false"),
			"web hosted-tool pricing policy drifted"
		);
	}

	fn assert_database_and_web_pricing_rates(
		rates: &[serde_json::Value],
		database: &str,
		web: &str,
	) {
		let compact_database = database.split_whitespace().collect::<String>();
		let web_rates = contract_section(web, "const pricingRates = [", "] as const;");
		let compact_web = web.split_whitespace().collect::<String>().replace('_', "");
		let compact_web_rates = web_rates.split_whitespace().collect::<String>().replace('_', "");

		assert_eq!(
			compact_database.matches("jsonb_build_object('model',").count(),
			rates.len(),
			"database pricing rate count drifted"
		);
		assert_eq!(
			compact_web_rates.matches("['").count(),
			rates.len(),
			"web pricing rate count drifted"
		);

		for rate in rates {
			let model = rate["model"].as_str().expect("pricing model must be text");
			let input = rate["input_usd_nanos_per_token"].as_u64().expect("input rate");
			let cached = rate["cached_input_usd_nanos_per_token"].as_u64().expect("cached rate");
			let cache_write =
				rate["cache_write_input_usd_nanos_per_token"].as_u64().expect("cache-write rate");
			let output = rate["output_usd_nanos_per_token"].as_u64().expect("output rate");

			assert!(
				compact_database.contains(&format!(
					"jsonb_build_object('model','{model}','input_usd_nanos_per_token',{input},'cached_input_usd_nanos_per_token',{cached},'cache_write_input_usd_nanos_per_token',{cache_write},'output_usd_nanos_per_token',{output})"
				)),
				"database pricing rate for {model} drifted"
			);
			assert!(
				compact_web.contains(
					&format!("['{model}',{input},{cached},{cache_write},{output}],")
						.replace('_', "")
				),
				"web pricing rate for {model} drifted"
			);
		}
	}

	#[test]
	fn serialized_pricing_default_matches_schema_database_and_web_contracts() {
		let pricing = serde_json::to_value(ApiEquivalentPricingModel::default())
			.expect("pricing default must serialize");
		let repository_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
		let normalized_schema: serde_json::Value = serde_json::from_slice(
			&fs::read(repository_root.join("benchmarks/schema/normalized-batch-v4.schema.json"))
				.expect("normalized schema must be readable"),
		)
		.expect("normalized schema must be JSON");
		let calibration_schema: serde_json::Value = serde_json::from_slice(
			&fs::read(
				repository_root.join("benchmarks/schema/calibration-verified-stage-v2.schema.json"),
			)
			.expect("calibration stage schema must be readable"),
		)
		.expect("calibration stage schema must be JSON");

		for field in [
			"method",
			"version",
			"as_of",
			"source",
			"currency",
			"processing_tier",
			"formula",
			"hosted_tool_fees_included",
			"limitation",
		] {
			assert_eq!(
				normalized_schema["$defs"]["apiEquivalentPricing"]["properties"][field]["const"],
				pricing[field],
				"normalized schema pricing field {field} drifted"
			);
			assert_eq!(
				calibration_schema["$defs"]["pricing"]["properties"][field]["const"],
				pricing[field],
				"calibration schema pricing field {field} drifted"
			);
		}

		let rates = pricing["rates"].as_array().expect("pricing rates must be an array");
		let normalized_rates = normalized_schema["$defs"]["apiEquivalentPricing"]["properties"]
			["rates"]["prefixItems"]
			.as_array()
			.expect("normalized schema rates must be an array");
		let rate_definitions = ["solRate", "terraRate", "lunaRate"];

		assert_eq!(rates.len(), 3, "serialized pricing rate count drifted");
		assert_eq!(
			rates.len(),
			normalized_rates.len(),
			"normalized schema pricing rate count drifted"
		);
		assert_eq!(
			rates.len(),
			rate_definitions.len(),
			"calibration schema pricing rate count drifted"
		);

		for (actual, schema_rate) in rates.iter().zip(normalized_rates) {
			assert_eq!(schema_rate["const"], *actual, "normalized schema rate drifted");
		}
		for (actual, definition) in rates.iter().zip(rate_definitions) {
			for field in [
				"model",
				"input_usd_nanos_per_token",
				"cached_input_usd_nanos_per_token",
				"cache_write_input_usd_nanos_per_token",
				"output_usd_nanos_per_token",
			] {
				assert_eq!(
					calibration_schema["$defs"][definition]["properties"][field]["const"],
					actual[field],
					"calibration schema {definition}.{field} drifted"
				);
			}
		}

		let database = fs::read_to_string(repository_root.join("databases/schema.sql"))
			.expect("database schema must be readable");
		let web = fs::read_to_string(
			repository_root.join("apps/web/src/server/verification-contract.ts"),
		)
		.expect("web verification contract must be readable");
		let database_contract = contract_section(
			&database,
			"create function aiq_private.efficiency_pricing_v1_is_valid",
			"\n$$;",
		);
		let web_contract =
			contract_section(&web, "const pricingFormula =", "function isEvaluatorResultsArtifact");

		assert_database_and_web_pricing_scalars(&pricing, database_contract, web_contract);
		assert_database_and_web_pricing_rates(rates, database_contract, web_contract);
	}

	#[test]
	fn aggregate_usage_above_the_short_context_bound_is_explicitly_unpriced() {
		let usage = ProviderTokenUsage {
			input: Some(272_001),
			cached_input: Some(0),
			cache_write_input: Some(0),
			output: Some(1),
			..ProviderTokenUsage::default()
		};

		assert_eq!(
			calibration_verification::estimate_cost(
				MODEL_MATRIX[0],
				&usage,
				&ApiEquivalentPricingModel::default(),
			),
			(None, CostEstimateStatus::UnavailableContextBand)
		);
	}

	#[test]
	fn missing_or_inconsistent_usage_never_becomes_zero_cost() {
		let pricing = ApiEquivalentPricingModel::default();
		let missing = ProviderTokenUsage { input: Some(1), ..ProviderTokenUsage::default() };

		assert_eq!(
			calibration_verification::estimate_cost(MODEL_MATRIX[0], &missing, &pricing),
			(None, CostEstimateStatus::UnavailableMissingUsage)
		);

		let invalid = ProviderTokenUsage {
			input: Some(1),
			cached_input: Some(2),
			cache_write_input: Some(0),
			output: Some(1),
			..ProviderTokenUsage::default()
		};

		assert_eq!(
			calibration_verification::estimate_cost(MODEL_MATRIX[0], &invalid, &pricing),
			(None, CostEstimateStatus::UnavailableInvalidUsage)
		);
	}

	#[test]
	fn aggregate_cost_is_null_until_every_selected_result_is_priced() {
		let run = runner::synthetic_demo(
			ScheduleConfig::default().slot("2026-08-02", ScheduleOccurrence::Day).expect("slot"),
			&crate::runner::TestArtifactSink,
		)
		.expect("synthetic run");
		let results = vec![run.results[0].clone(), run.results[0].clone()];
		let complete_usage = ProviderTokenUsage {
			input: Some(10),
			cached_input: Some(0),
			cache_write_input: Some(0),
			output: Some(1),
			reasoning: Some(1),
			total: Some(11),
		};
		let (partial_results, partial_aggregates, pricing) =
			calibration_verification::build_efficiency_evidence(
				&results,
				&[complete_usage.clone(), ProviderTokenUsage::default()],
				false,
			)
			.expect("partial efficiency evidence");

		assert_eq!(pricing.currency, "USD");
		assert_eq!(pricing.processing_tier, "standard");
		assert_eq!(partial_aggregates[0].estimated_cost_tasks, 1);
		assert_eq!(partial_aggregates[0].standard_api_equivalent_usd_nanos, None);

		let expected_one =
			partial_results[0].standard_api_equivalent_usd_nanos.expect("one priced result");
		let (_, complete_aggregates, _) = calibration_verification::build_efficiency_evidence(
			&results,
			&[complete_usage.clone(), complete_usage],
			false,
		)
		.expect("complete efficiency evidence");

		assert_eq!(complete_aggregates[0].estimated_cost_tasks, 2);
		assert_eq!(
			complete_aggregates[0].standard_api_equivalent_usd_nanos,
			expected_one.checked_mul(2)
		);
	}

	#[test]
	fn non_invoked_and_missing_usage_evidence_labels_remain_absent() {
		let mut run = runner::synthetic_demo(
			ScheduleConfig::default().slot("2026-08-02", ScheduleOccurrence::Day).expect("slot"),
			&crate::runner::TestArtifactSink,
		)
		.expect("synthetic run");
		let result = &mut run.results[0];

		result.failure = Some(ResultFailure {
			kind: FailureKind::CapabilityUnavailable,
			message: "not invoked".to_owned(),
			exit_code: None,
			retryable: false,
		});

		let (observations, _, _) = calibration_verification::build_efficiency_evidence(
			&run.results[..1],
			&[ProviderTokenUsage::default()],
			false,
		)
		.expect("efficiency evidence");
		let observation = &observations[0];

		assert_eq!(observation.observed_wall_ms, None);
		assert_eq!(observation.wall_time_evidence_level, None);
		assert_eq!(observation.provider_tokens_source, None);
		assert_eq!(observation.provider_tokens_evidence_level, None);
		assert_eq!(observation.standard_api_equivalent_usd_nanos, None);
		assert_eq!(observation.cost_evidence_level, None);
	}

	#[test]
	fn synthetic_results_never_become_runner_observed_invocations() {
		let run = runner::synthetic_demo(
			ScheduleConfig::default().slot("2026-08-02", ScheduleOccurrence::Day).expect("slot"),
			&crate::runner::TestArtifactSink,
		)
		.expect("synthetic run");
		let (observations, aggregates, _) = calibration_verification::build_efficiency_evidence(
			&run.results,
			&vec![ProviderTokenUsage::default(); run.results.len()],
			true,
		)
		.expect("synthetic efficiency evidence");

		assert!(observations.iter().all(|result| {
			result.observed_wall_ms.is_none()
				&& result.wall_time_evidence_level.is_none()
				&& result.provider_tokens.is_empty()
		}));
		assert!(aggregates.iter().all(|aggregate| {
			aggregate.observed_wall_tasks == 0 && aggregate.total_observed_wall_ms.is_none()
		}));

		let usage = ProviderTokenUsage { input: Some(1), ..ProviderTokenUsage::default() };

		assert!(
			calibration_verification::build_efficiency_evidence(&run.results[..1], &[usage], true,)
				.is_err()
		);
	}

	#[test]
	fn persisted_provider_counters_must_be_jcs_safe_and_internally_ordered() {
		let run = runner::synthetic_demo(
			ScheduleConfig::default().slot("2026-08-02", ScheduleOccurrence::Day).expect("slot"),
			&crate::runner::TestArtifactSink,
		)
		.expect("synthetic run");
		let result = run.results[0].clone();
		let invalid = [
			ProviderTokenUsage {
				input: Some(MAX_JCS_SAFE_INTEGER + 1),
				..ProviderTokenUsage::default()
			},
			ProviderTokenUsage {
				input: Some(1),
				cached_input: Some(2),
				..ProviderTokenUsage::default()
			},
			ProviderTokenUsage {
				output: Some(1),
				reasoning: Some(2),
				..ProviderTokenUsage::default()
			},
		];

		for usage in invalid {
			assert!(
				calibration_verification::build_efficiency_evidence(
					slice::from_ref(&result),
					&[usage],
					false,
				)
				.is_err()
			);
		}
	}

	#[test]
	fn aggregate_wall_and_token_totals_fail_closed_outside_jcs_range() {
		let run = runner::synthetic_demo(
			ScheduleConfig::default().slot("2026-08-02", ScheduleOccurrence::Day).expect("slot"),
			&crate::runner::TestArtifactSink,
		)
		.expect("synthetic run");
		let mut first = run.results[0].clone();
		let mut second = first.clone();

		first.latency.wall_ms = MAX_JCS_SAFE_INTEGER;
		second.latency.wall_ms = 1;

		assert!(
			calibration_verification::build_efficiency_evidence(
				&[first.clone(), second.clone()],
				&[ProviderTokenUsage::default(), ProviderTokenUsage::default()],
				false,
			)
			.is_err()
		);

		first.latency.wall_ms = 1;

		let large = ProviderTokenUsage {
			input: Some(MAX_JCS_SAFE_INTEGER),
			..ProviderTokenUsage::default()
		};
		let one = ProviderTokenUsage { input: Some(1), ..ProviderTokenUsage::default() };

		assert!(
			calibration_verification::build_efficiency_evidence(
				&[first, second],
				&[large, one],
				false,
			)
			.is_err()
		);
	}

	#[test]
	fn exact_jcs_maximum_remains_representable_without_fabricating_cost() {
		let run = runner::synthetic_demo(
			ScheduleConfig::default().slot("2026-08-02", ScheduleOccurrence::Day).expect("slot"),
			&crate::runner::TestArtifactSink,
		)
		.expect("synthetic run");
		let usage = ProviderTokenUsage {
			input: Some(MAX_JCS_SAFE_INTEGER),
			cached_input: Some(0),
			cache_write_input: Some(0),
			output: Some(0),
			..ProviderTokenUsage::default()
		};
		let (results, aggregates, _) =
			calibration_verification::build_efficiency_evidence(&run.results[..1], &[usage], false)
				.expect("JCS-safe maximum evidence");

		assert_eq!(results[0].cost_status, CostEstimateStatus::UnavailableContextBand);
		assert_eq!(results[0].standard_api_equivalent_usd_nanos, None);
		assert_eq!(aggregates[0].provider_token_totals.input, Some(MAX_JCS_SAFE_INTEGER));
		assert_eq!(aggregates[0].standard_api_equivalent_usd_nanos, None);
	}

	#[test]
	fn aggregate_provider_subset_relationships_cannot_become_invalid() {
		let run = runner::synthetic_demo(
			ScheduleConfig::default().slot("2026-08-02", ScheduleOccurrence::Day).expect("slot"),
			&crate::runner::TestArtifactSink,
		)
		.expect("synthetic run");
		let results = [run.results[0].clone(), run.results[0].clone()];
		let usage = [
			ProviderTokenUsage { input: Some(1), ..ProviderTokenUsage::default() },
			ProviderTokenUsage { cached_input: Some(2), ..ProviderTokenUsage::default() },
		];

		assert!(
			calibration_verification::build_efficiency_evidence(&results, &usage, false).is_err()
		);
	}
}
