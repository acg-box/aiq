//! Isolated verification evidence for signed, non-Official calibration runs.

use std::{
	error::Error,
	fmt::{Display, Formatter},
};

use ed25519_dalek::{Signature, Verifier as _, VerifyingKey};
use serde::{Deserialize, Serialize};

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
	scoring::{
		CalibrationScoreReport, FalseOnly, ScoreContext, ScoreOptions,
		score_calibration_model_with_context,
	},
	submission,
	task::TaskDefinition,
};

/// Calibration verifier-stage schema.
pub const CALIBRATION_VERIFIED_STAGE_SCHEMA_VERSION: &str = "aiq.calibration-verified-stage.v1";
/// Calibration verifier-attestation schema.
pub const CALIBRATION_VERIFIER_ATTESTATION_SCHEMA_VERSION: &str =
	"aiq.calibration-verifier-attestation.v1";
/// Efficiency observation schema.
pub const CALIBRATION_EFFICIENCY_SCHEMA_VERSION: &str = "aiq.calibration-efficiency.v1";
/// API-equivalent pricing model version.
pub const API_EQUIVALENT_PRICING_VERSION: &str = "aiq.standard-api-equivalent-usd.v1";

const MAX_JCS_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const PRICING_SOURCE: &str = "https://developers.openai.com/api/docs/models/compare";
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
	pub input_usd_nanos_per_token: u64,
	pub cached_input_usd_nanos_per_token: u64,
	pub cache_write_input_usd_nanos_per_token: u64,
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
			rates: vec![
				rates("gpt-5.6-sol", 5_000, 500, 6_250, 30_000),
				rates("gpt-5.6-terra", 2_500, 250, 3_125, 15_000),
				rates("gpt-5.6-luna", 1_000, 100, 1_250, 6_000),
			],
			formula: "(input-cached_input-cache_write_input)*input_usd_nanos_per_token + cached_input*cached_input_usd_nanos_per_token + cache_write_input*cache_write_input_usd_nanos_per_token + output*output_usd_nanos_per_token; reasoning is a subset of output and is not added again".to_owned(),
			hosted_tool_fees_included: false,
			limitation: "Standard API-equivalent comparison only. Aggregated turn usage does not expose per-request long-context multipliers. This is not actual subscription spend.".to_owned(),
		}
	}
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
	/// Observed task wall time. Unattempted cells remain unknown.
	pub observed_wall_ms: Option<u64>,
	/// Wall-time authority classification.
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
	pub selected_tasks: usize,
	pub input_tasks: usize,
	pub cached_input_tasks: usize,
	pub cache_write_input_tasks: usize,
	pub output_tasks: usize,
	pub reasoning_tasks: usize,
	pub total_tasks: usize,
}

/// Transparent efficiency aggregate for one model selection.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CalibrationEfficiencyAggregate {
	pub schema_version: String,
	pub model: ModelConfig,
	pub selected_tasks: usize,
	pub observed_wall_tasks: usize,
	pub total_observed_wall_ms: Option<u64>,
	pub median_observed_wall_ms: Option<u64>,
	pub p95_observed_wall_ms: Option<u64>,
	pub provider_token_totals: ProviderTokenUsage,
	pub provider_token_coverage: ProviderTokenCoverage,
	pub estimated_cost_tasks: usize,
	pub standard_api_equivalent_usd_nanos: Option<u64>,
}

/// One recomputed calibration score paired with separate efficiency evidence.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CalibrationVerifiedScore {
	pub model: ModelConfig,
	pub score: CalibrationScoreReport,
	pub efficiency: CalibrationEfficiencyAggregate,
}

/// Public non-Official stage created only after artifact and evaluator replay.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CalibrationVerifiedStageV1 {
	pub schema_version: String,
	pub run_id: String,
	pub package_sha256: String,
	pub content_hash: String,
	pub runner: NodeIdentity,
	pub classification: String,
	pub run_class: RunClass,
	pub official_eligible: FalseOnly,
	pub ranking_eligible: FalseOnly,
	pub trust: TrustTier,
	pub task_set_hash: String,
	pub task_selection_digest: String,
	pub model_selection_digest: String,
	pub score_reports_digest: String,
	pub telemetry_digest: String,
	pub capability_validation_digest: String,
	pub provenance: RunProvenanceCommitment,
	pub evaluator_results_artifact: crate::adapter::ArtifactReference,
	pub scoring_version: String,
	pub execution_concurrency: Option<usize>,
	pub task_ids: Vec<String>,
	pub models: Vec<ModelConfig>,
	pub scores: Vec<CalibrationVerifiedScore>,
	pub result_efficiency: Vec<CalibrationResultEfficiency>,
	pub pricing: ApiEquivalentPricingModel,
	pub task_set_id: String,
	pub task_set_version: String,
	pub benchmark_version: String,
	pub prompt_set_digest: String,
	pub runner_commit: String,
	pub region: String,
	pub scheduled_unix_ms: u64,
	pub started_unix_ms: u64,
	pub finished_unix_ms: u64,
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
		if self.schema_version != CALIBRATION_VERIFIED_STAGE_SCHEMA_VERSION
			|| self.classification != "local_calibration_non_official"
			|| self.run_class != RunClass::Calibration
			|| self.trust != TrustTier::Untrusted
			|| self.models.is_empty()
			|| !self
				.execution_concurrency
				.is_some_and(|jobs| (1..=crate::runner::MAX_RUN_JOBS).contains(&jobs))
			|| self.task_ids.is_empty()
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
					|| score.score.official_eligible != FalseOnly
					|| score.score.ranking_eligible != FalseOnly
			}) {
			return Err(CalibrationVerificationError::new(
				"calibration stage classification or cardinality is invalid",
			));
		}

		validate_node(&self.runner)?;
		validate_hash(&self.package_sha256, false)?;
		for digest in [
			&self.content_hash,
			&self.task_set_hash,
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
	pub schema_version: String,
	pub signature_algorithm: String,
	pub signature_version: String,
	pub run_id: String,
	pub package_sha256: String,
	pub content_hash: String,
	pub stage_digest: String,
	pub runner: NodeIdentity,
	pub verifier: NodeIdentity,
	pub classification: String,
	pub run_class: RunClass,
	pub official_eligible: FalseOnly,
	pub ranking_eligible: FalseOnly,
	pub trust: TrustTier,
	pub task_set_hash: String,
	pub task_selection_digest: String,
	pub model_selection_digest: String,
	pub score_reports_digest: String,
	pub telemetry_digest: String,
	pub capability_validation_digest: String,
	pub scoring_version: String,
	pub execution_concurrency: Option<usize>,
	pub observed_unix_ms: u64,
	pub replay_status: CalibrationReplayStatus,
	pub signature: String,
}

/// The only successful calibration replay disposition.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CalibrationReplayStatus {
	EvaluatorReplayed,
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
			|| self.task_selection_digest != stage.task_selection_digest
			|| self.model_selection_digest != stage.model_selection_digest
			|| self.score_reports_digest != stage.score_reports_digest
			|| self.telemetry_digest != stage.telemetry_digest
			|| self.capability_validation_digest != stage.capability_validation_digest
			|| self.scoring_version != stage.scoring_version
			|| self.execution_concurrency != stage.execution_concurrency
			|| self.observed_unix_ms > MAX_JCS_SAFE_INTEGER
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

/// Validates, recomputes, and creates a calibration stage without using Official normalization.
pub fn verify_calibration_run(
	run: &CalibrationRunRecord,
	tasks: &[TaskDefinition],
	package: &VerifiedPackageIdentity,
	metadata: &AttestedDeploymentMetadata,
	provider_usage: &[ProviderTokenUsage],
) -> Result<CalibrationVerifiedStageV1, CalibrationVerificationError> {
	if run.execution_concurrency.is_none() {
		return Err(CalibrationVerificationError::new(
			"calibration verification requires a bound execution concurrency",
		));
	}
	if provider_usage.len() != run.results.len() {
		return Err(CalibrationVerificationError::new(
			"provider usage must align with every calibration result",
		));
	}
	run_validation::validate_calibration_run_record_with_tasks(run, tasks)
		.map_err(|error| CalibrationVerificationError::new(error.to_string()))?;
	submission::validate_calibration_signer_binding(run, &package.signer.node_id)
		.map_err(|error| CalibrationVerificationError::new(error.to_string()))?;
	validate_metadata(run, package, metadata)?;

	let pricing = ApiEquivalentPricingModel::default();
	let result_efficiency = run
		.results
		.iter()
		.zip(provider_usage)
		.map(|(result, usage)| result_efficiency(result, usage, &pricing))
		.collect::<Vec<_>>();
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
			let score = score_calibration_model_with_context(
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
				efficiency: aggregate_efficiency(model, &model_results),
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
		execution_concurrency: run.execution_concurrency,
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

/// Signs a validated calibration stage with a distinct verifier identity.
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

fn result_efficiency(
	result: &crate::runner::TaskResult,
	provider_usage: &ProviderTokenUsage,
	pricing: &ApiEquivalentPricingModel,
) -> CalibrationResultEfficiency {
	let provider_tokens = provider_usage.clone();
	let (standard_api_equivalent_usd_nanos, cost_status) =
		estimate_cost(result.model, &provider_tokens, pricing);
	let attempted = !matches!(
		result.failure.as_ref().map(|failure| failure.kind),
		Some(
			FailureKind::CapabilityUnavailable
				| FailureKind::CapabilityValidationFailed
				| FailureKind::WorkspaceUnavailable
		)
	);

	let observed_wall_ms = attempted.then_some(result.latency.wall_ms);
	let has_provider_usage = !provider_tokens.is_empty();

	CalibrationResultEfficiency {
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
	}
}

/// Builds verifier-facing efficiency evidence without changing score semantics.
pub fn build_efficiency_evidence(
	results: &[crate::runner::TaskResult],
	provider_usage: &[ProviderTokenUsage],
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
		.map(|(result, usage)| result_efficiency(result, usage, &pricing))
		.collect::<Vec<_>>();
	let aggregates = MODEL_MATRIX
		.iter()
		.copied()
		.filter(|model| results.iter().any(|result| result.model == *model))
		.map(|model| {
			let model_results =
				observations.iter().filter(|result| result.model == model).collect::<Vec<_>>();

			aggregate_efficiency(model, &model_results)
		})
		.collect();

	Ok((observations, aggregates, pricing))
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
) -> CalibrationEfficiencyAggregate {
	let mut walls = results.iter().filter_map(|result| result.observed_wall_ms).collect::<Vec<_>>();

	walls.sort_unstable();

	let provider_token_totals = ProviderTokenUsage {
		input: sum_present(results, |usage| usage.input),
		cached_input: sum_present(results, |usage| usage.cached_input),
		cache_write_input: sum_present(results, |usage| usage.cache_write_input),
		output: sum_present(results, |usage| usage.output),
		reasoning: sum_present(results, |usage| usage.reasoning),
		total: sum_present(results, |usage| usage.total),
	};
	let estimated = results
		.iter()
		.filter_map(|result| result.standard_api_equivalent_usd_nanos)
		.collect::<Vec<_>>();
	let total_wall = (!walls.is_empty()).then(|| walls.iter().copied().sum());
	let median = (!walls.is_empty()).then(|| {
		let middle = walls.len() / 2;

		if walls.len() % 2 == 0 {
			walls[middle - 1].saturating_add(walls[middle]) / 2
		} else {
			walls[middle]
		}
	});
	let p95 = (!walls.is_empty()).then(|| walls[(walls.len() * 95).div_ceil(100) - 1]);

	CalibrationEfficiencyAggregate {
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
		standard_api_equivalent_usd_nanos: (!estimated.is_empty())
			.then(|| estimated.iter().copied().fold(0_u64, u64::saturating_add)),
	}
}

fn count_present<F>(results: &[&CalibrationResultEfficiency], field: F) -> usize
where
	F: Fn(&ProviderTokenUsage) -> Option<u64>,
{
	results.iter().filter(|result| field(&result.provider_tokens).is_some()).count()
}

fn sum_present<F>(results: &[&CalibrationResultEfficiency], field: F) -> Option<u64>
where
	F: Fn(&ProviderTokenUsage) -> Option<u64>,
{
	let values =
		results.iter().filter_map(|result| field(&result.provider_tokens)).collect::<Vec<_>>();

	(!values.is_empty()).then(|| values.into_iter().fold(0_u64, u64::saturating_add))
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
		|| metadata.task_set_id != "aiq-core"
		|| metadata.task_set_version != crate::scoring::AIQ_SCORING_VERSION
		|| metadata.benchmark_version != "aiq-core@1.0.0"
		|| metadata.prompt_set_digest != run.provenance.prompt_digest
		|| metadata.started_unix_ms != run.started_unix_ms
		|| metadata.finished_unix_ms != run.finished_unix_ms
		|| metadata.region.is_empty()
		|| metadata.region.len() > 64
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
	task_selection_digest: &'a str,
	model_selection_digest: &'a str,
	score_reports_digest: &'a str,
	telemetry_digest: &'a str,
	capability_validation_digest: &'a str,
	provenance: &'a RunProvenanceCommitment,
	evaluator_results_artifact: &'a crate::adapter::ArtifactReference,
	scoring_version: &'a str,
	execution_concurrency: Option<usize>,
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
	task_selection_digest: &'a str,
	model_selection_digest: &'a str,
	score_reports_digest: &'a str,
	telemetry_digest: &'a str,
	capability_validation_digest: &'a str,
	scoring_version: &'a str,
	execution_concurrency: Option<usize>,
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

#[cfg(test)]
mod tests {
	use super::{
		ApiEquivalentPricingModel, CostEstimateStatus, build_efficiency_evidence, estimate_cost,
	};
	use crate::{
		model::MODEL_MATRIX,
		runner::{FailureKind, ProviderTokenUsage, ResultFailure, synthetic_demo},
		schedule::{ScheduleConfig, ScheduleOccurrence},
	};

	#[test]
	fn standard_cost_formula_separates_cache_reads_writes_and_output() {
		let usage = ProviderTokenUsage {
			input: Some(1_000_000),
			cached_input: Some(200_000),
			cache_write_input: Some(100_000),
			output: Some(10_000),
			reasoning: Some(4_000),
			total: None,
		};
		let (cost, status) =
			estimate_cost(MODEL_MATRIX[0], &usage, &ApiEquivalentPricingModel::default());

		assert_eq!(status, CostEstimateStatus::Estimated);
		assert_eq!(cost, Some(4_525_000_000));
	}

	#[test]
	fn missing_or_inconsistent_usage_never_becomes_zero_cost() {
		let pricing = ApiEquivalentPricingModel::default();
		let missing = ProviderTokenUsage { input: Some(1), ..ProviderTokenUsage::default() };

		assert_eq!(
			estimate_cost(MODEL_MATRIX[0], &missing, &pricing),
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
			estimate_cost(MODEL_MATRIX[0], &invalid, &pricing),
			(None, CostEstimateStatus::UnavailableInvalidUsage)
		);
	}

	#[test]
	fn non_invoked_and_missing_usage_evidence_labels_remain_absent() {
		let mut run = synthetic_demo(
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

		let (observations, _, _) =
			build_efficiency_evidence(&run.results[..1], &[ProviderTokenUsage::default()])
				.expect("efficiency evidence");
		let observation = &observations[0];

		assert_eq!(observation.observed_wall_ms, None);
		assert_eq!(observation.wall_time_evidence_level, None);
		assert_eq!(observation.provider_tokens_source, None);
		assert_eq!(observation.provider_tokens_evidence_level, None);
		assert_eq!(observation.standard_api_equivalent_usd_nanos, None);
		assert_eq!(observation.cost_evidence_level, None);
	}
}
