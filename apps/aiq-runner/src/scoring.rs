//! Transparent, versioned AIQ scoring.

use std::{
	collections::{BTreeMap, BTreeSet},
	fmt::{Display, Formatter},
};

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;

use crate::{
	model::{MODEL_MATRIX, ModelConfig},
	protocol::{self, TrustTier},
	runner::{EvaluationOutcome, FailureKind, ResultStatus, TaskResult},
	task::{Domain, TaskDefinition},
};

type CalibrationMatrix<'a> = BTreeMap<(&'a str, ModelConfig), &'a TaskResult>;

type CalibrationMatrixEvidence<'a> = (CalibrationMatrix<'a>, BTreeSet<Domain>);

type CalibrationTaskStatistics<'a> = BTreeMap<&'a str, (f64, f64)>;

type CalibrationStatisticsEvidence<'a> =
	(CalibrationTaskStatistics<'a>, UniversalCalibrationCounts);

/// Current scoring implementation version.
pub const AIQ_SCORING_VERSION: &str = "1.0.6";
/// Current measurement model version. This is deliberately separate from the
/// task evaluator release: item scoring and ability estimation are different
/// measurement layers.
pub const AIQ_MEASUREMENT_VERSION: &str = "2.0.0";
/// Calibrated latent-trait estimator used for Official ranking.
pub const LATENT_ABILITY_METHOD: &str = "rasch_fractional_joint_map_v1";
/// Current controlled AIQ Core task-set identifier.
pub const AIQ_TASK_SET_ID: &str = "aiq-core";
/// Current controlled AIQ Core task-set release.
pub const AIQ_TASK_SET_VERSION: &str = "1.0.6";
/// Current benchmark release identifier.
pub const AIQ_BENCHMARK_VERSION: &str = "aiq-core@1.0.6";
/// Frozen full-metadata commitment for the current AIQ Core release.
pub const AIQ_CORE_TASK_IDENTITY_SHA256: &str =
	"sha256:6dc43022b04333de889abc08de118d63652aeab6ee2c3b8610905a2faa91e460";
/// Default production resampling replicate count.
pub const DEFAULT_BOOTSTRAP_SAMPLES: usize = 10_000;
/// Default deterministic bootstrap seed.
pub const DEFAULT_BOOTSTRAP_SEED: u64 = 0x41_49_51_5f_56_32;
/// Fixed empirical publication-calibration policy identity.
pub const OFFICIAL_CALIBRATION_POLICY_VERSION: &str = "aiq.official-calibration-policy.v1";
/// Complete fixed-fixture task count required by the calibration policy.
pub const OFFICIAL_CALIBRATION_TASKS: usize = 72;
/// Inclusive lower bound for an informative item's mean credit across the matrix.
pub const OFFICIAL_CALIBRATION_INFORMATIVE_FACILITY_MIN: f64 = 0.10;
/// Inclusive upper bound for an informative item's mean credit across the matrix.
pub const OFFICIAL_CALIBRATION_INFORMATIVE_FACILITY_MAX: f64 = 0.90;
/// Minimum across-model task-credit range for an informative item.
pub const OFFICIAL_CALIBRATION_INFORMATIVE_TASK_RANGE_MIN: f64 = 0.10;
/// Minimum fraction of tasks whose facility is in the informative band.
pub const OFFICIAL_CALIBRATION_MIN_INFORMATIVE_TASK_RATE: f64 = 0.50;
/// Minimum fraction of tasks with non-uniform credit across configurations.
pub const OFFICIAL_CALIBRATION_MIN_NON_UNIFORM_TASK_RATE: f64 = 0.50;
/// Maximum fraction of tasks with universal semantic zero credit.
pub const OFFICIAL_CALIBRATION_MAX_UNIVERSAL_SEMANTIC_ZERO_RATE: f64 = 0.10;
/// Maximum fraction of tasks with universal full credit.
pub const OFFICIAL_CALIBRATION_MAX_UNIVERSAL_FULL_CREDIT_RATE: f64 = 0.10;
/// Inclusive lower bound for each domain's mean facility.
pub const OFFICIAL_CALIBRATION_DOMAIN_FACILITY_MIN: f64 = 0.10;
/// Inclusive upper bound for each domain's mean facility.
pub const OFFICIAL_CALIBRATION_DOMAIN_FACILITY_MAX: f64 = 0.90;
/// Minimum range, on the 0-100 scale, across model macro-domain scores.
pub const OFFICIAL_CALIBRATION_MIN_MODEL_SCORE_RANGE: f64 = 3.0;
/// Minimum range, on the 0-100 calibrated average-item scale, across models.
pub const OFFICIAL_CALIBRATION_MIN_LATENT_SCORE_RANGE: f64 = 3.0;

const TASK_RESAMPLING_SENSITIVITY_METHOD: &str =
	"finite_cluster_calibrated_percentile_sensitivity_v1";
const CALIBRATION_COMPARISON_TOLERANCE: f64 = 1e-12;
const RASCH_WALD_Z_95: f64 = 1.959_963_984_540_054;
const RASCH_PRIOR_PRECISION: f64 = 1.0 / 9.0;
const RASCH_MAX_ITERATIONS: usize = 128;
const RASCH_MAX_INNER_ITERATIONS: usize = 24;
const RASCH_MAX_ABS_PARAMETER: f64 = 8.0;
const RASCH_CONVERGENCE: f64 = 1e-10;
const LATENT_RELIABILITY_STATUS: &str = "single_matrix_information_only";
const SCORE_RULE: &str = "AIQ measurement 2.0: the Official ranking score is 100 × the Rasch fractional MAP estimate's predicted success probability on an average calibrated task. The latent estimate uses jointly estimated item difficulties and model locations from the complete 17-configuration by 72-task calibration matrix, with weak N(0, 3²) priors and a centered item scale; it reports theta, observed information, and standard error. The theta and score Wald interval is conditional on the released item bank and excludes item-bank calibration uncertainty. The raw equal-domain fixed-fixture mean remains a criterion-referenced diagnostic and is not the ranking score. The strict-pass diagnostic is strict successes divided by all attributable tasks with a valid semantic task score; partial scores are non-passes and remain in this denominator, while missing, infrastructure-invalid, runtime-failed, and unscored tasks are excluded. Its Wilson interval uses the same denominator. Coverage semantics are explicit: invalid_tasks counts an observed result record that failed at runtime or infrastructure validation, while missing_tasks is reserved for an expected cell with no result record; neither contributes to semantic aggregates. Public result rows label timeout, budget, tool, policy, and artifact failures as runtime_issue, not as incorrect model answers. Official requires non-synthetic 72/72 semantic coverage, 10/10 domains, a complete calibration matrix, and a passed calibration release gate. A complete synthetic fixture is descriptive, has no Official AIQ, and is not ranking eligible. Provisional requires at least 60/72 and at least four valid tasks per domain, is conditional, and is not ranking eligible. Lower coverage publishes no estimate. The task-resampling interval is finite_cluster_calibrated_percentile_sensitivity_v1 with a versioned 1.3 deviation correction; it is a fixed-fixture calibrated sensitivity interval for task-mix sensitivity, not a universal confidence interval for model capability. Time and cost remain separate measures.";
const CALIBRATION_SCORE_RULE: &str = "Calibration analysis only. Values are transparent descriptive aggregates for the selected evidence. The joint Rasch fractional MAP estimate is emitted only when a complete 17-configuration by 72-task calibration matrix is available. Its uncertainty is conditional on the fitted item bank and excludes item-bank calibration uncertainty. This report has no publication classification and is not ranking eligible. The task-resampling interval uses finite_cluster_calibrated_percentile_sensitivity_v1 with a versioned 1.3 deviation correction; it is a fixed-fixture calibrated sensitivity interval for task-mix sensitivity, not a universal confidence interval for model capability.";

/// Score classification tier.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScoreTier {
	/// All 72 tasks and all 10 domains have valid scores.
	Official,
	/// A complete 72-task synthetic fixture with descriptive estimates only.
	SyntheticComplete,
	/// At least 60 of 72 tasks are valid, with at least four valid tasks per domain.
	Provisional,
	/// Coverage is reported, but an AIQ score is not published.
	CoverageOnly,
	/// The complete model configuration was declared unavailable before the run.
	NotApplicable,
}

/// Descriptive state for a calibration score report.
///
/// These values describe coverage only. They are not publication tiers.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CalibrationDescriptiveStatus {
	/// The exact frozen fixture has complete valid coverage.
	CompleteFixture,
	/// The existing conditional-observation coverage threshold is met.
	ConditionalObserved,
	/// Coverage is available without an aggregate estimate.
	CoverageOnly,
	/// Preflight and every task disposition declare the model unavailable.
	NotApplicable,
}

/// Deterministic bootstrap configuration.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct ScoreOptions {
	/// Number of percentile bootstrap replicates.
	pub bootstrap_samples: usize,
	/// Fixed pseudo-random seed.
	pub bootstrap_seed: u64,
}
impl Default for ScoreOptions {
	fn default() -> Self {
		Self {
			bootstrap_samples: DEFAULT_BOOTSTRAP_SAMPLES,
			bootstrap_seed: DEFAULT_BOOTSTRAP_SEED,
		}
	}
}

/// Run-level evidence needed to classify a whole configuration as not applicable.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Deserialize, Serialize)]
pub struct ScoreContext {
	/// A valid preflight declared the whole model configuration unsupported.
	pub preflight_configuration_not_applicable: bool,
	/// A trusted receiver or verifier explicitly authorized ranking publication.
	///
	/// Complete local task results do not grant this authority.
	pub receiver_authorized_publication: bool,
}

/// Versioned fixed-fixture publication-calibration policy.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OfficialCalibrationPolicy {
	/// Stable policy identity.
	pub version: String,
	/// Required task count.
	pub required_tasks: usize,
	/// Required model-configuration count.
	pub required_model_configurations: usize,
	/// Inclusive informative-facility lower bound.
	pub informative_facility_min: f64,
	/// Inclusive informative-facility upper bound.
	pub informative_facility_max: f64,
	/// Minimum across-model task-credit range for an informative item.
	pub informative_task_range_min: f64,
	/// Minimum informative-task fraction.
	pub min_informative_task_rate: f64,
	/// Minimum non-uniform-task fraction.
	pub min_non_uniform_task_rate: f64,
	/// Maximum universal semantic-zero fraction.
	pub max_universal_semantic_zero_rate: f64,
	/// Maximum universal full-credit fraction.
	pub max_universal_full_credit_rate: f64,
	/// Inclusive per-domain mean-facility lower bound.
	pub domain_facility_min: f64,
	/// Inclusive per-domain mean-facility upper bound.
	pub domain_facility_max: f64,
	/// Minimum range across 0-100 macro-domain model scores.
	pub min_model_score_range: f64,
	/// Minimum range across 0-100 latent average-item scores.
	pub min_latent_score_range: f64,
}
impl Default for OfficialCalibrationPolicy {
	fn default() -> Self {
		Self {
			version: OFFICIAL_CALIBRATION_POLICY_VERSION.to_owned(),
			required_tasks: OFFICIAL_CALIBRATION_TASKS,
			required_model_configurations: MODEL_MATRIX.len(),
			informative_facility_min: OFFICIAL_CALIBRATION_INFORMATIVE_FACILITY_MIN,
			informative_facility_max: OFFICIAL_CALIBRATION_INFORMATIVE_FACILITY_MAX,
			informative_task_range_min: OFFICIAL_CALIBRATION_INFORMATIVE_TASK_RANGE_MIN,
			min_informative_task_rate: OFFICIAL_CALIBRATION_MIN_INFORMATIVE_TASK_RATE,
			min_non_uniform_task_rate: OFFICIAL_CALIBRATION_MIN_NON_UNIFORM_TASK_RATE,
			max_universal_semantic_zero_rate: OFFICIAL_CALIBRATION_MAX_UNIVERSAL_SEMANTIC_ZERO_RATE,
			max_universal_full_credit_rate: OFFICIAL_CALIBRATION_MAX_UNIVERSAL_FULL_CREDIT_RATE,
			domain_facility_min: OFFICIAL_CALIBRATION_DOMAIN_FACILITY_MIN,
			domain_facility_max: OFFICIAL_CALIBRATION_DOMAIN_FACILITY_MAX,
			min_model_score_range: OFFICIAL_CALIBRATION_MIN_MODEL_SCORE_RANGE,
			min_latent_score_range: OFFICIAL_CALIBRATION_MIN_LATENT_SCORE_RANGE,
		}
	}
}

/// One domain's fixed-fixture facility diagnostics.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OfficialCalibrationDomainSummary {
	/// Domain identity.
	pub domain: Domain,
	/// Number of tasks in this domain.
	pub tasks: usize,
	/// Mean task credit across every model and task in this domain.
	pub mean_facility: f64,
	/// Tasks in the inclusive informative facility band.
	pub informative_tasks: usize,
	/// Tasks with the minimum across-model credit range.
	pub non_uniform_tasks: usize,
}

/// Matrix-level calibration evidence kept separate from the AIQ score.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OfficialCalibrationSummary {
	/// Stable policy identity applied to this observation.
	pub policy_version: String,
	/// Observed fixed-fixture task count.
	pub tasks: usize,
	/// Observed model-configuration count.
	pub model_configurations: usize,
	/// Tasks in the inclusive informative facility band.
	pub informative_tasks: usize,
	/// Informative tasks divided by all tasks.
	pub informative_task_rate: f64,
	/// Tasks with the minimum across-model credit range.
	pub non_uniform_tasks: usize,
	/// Non-uniform tasks divided by all tasks.
	pub non_uniform_task_rate: f64,
	/// Tasks for which every model received a valid zero.
	pub universal_zero_tasks: usize,
	/// Tasks for which every model completed but received an incorrect zero.
	pub universal_semantic_zero_tasks: usize,
	/// Tasks for which every model received an attributable runtime-failure zero.
	pub universal_runtime_zero_tasks: usize,
	/// Tasks whose universal zeros mix semantic rejection and runtime failure.
	pub universal_mixed_zero_tasks: usize,
	/// Tasks for which every model received full credit.
	pub universal_full_credit_tasks: usize,
	/// Per-domain fixed-fixture facility evidence.
	pub domains: Vec<OfficialCalibrationDomainSummary>,
	/// Lowest 0-100 macro-domain model score.
	pub min_model_score: f64,
	/// Highest 0-100 macro-domain model score.
	pub max_model_score: f64,
	/// Highest minus lowest macro-domain model score.
	pub model_score_range: f64,
	/// Lowest 0-100 latent average-item model score.
	pub min_latent_score: f64,
	/// Highest 0-100 latent average-item model score.
	pub max_latent_score: f64,
	/// Highest minus lowest latent average-item model score.
	pub latent_score_range: f64,
	/// Largest model standard error in the calibrated latent estimate.
	pub max_latent_standard_error: f64,
}

/// Transparent result of applying the fixed calibration policy.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OfficialCalibrationDiagnostic {
	/// Exact fixed policy.
	pub policy: OfficialCalibrationPolicy,
	/// Exact observed summary.
	pub observed: OfficialCalibrationSummary,
	/// Deterministically ordered publication-blocking findings.
	pub violations: Vec<String>,
}
impl OfficialCalibrationDiagnostic {
	/// Whether the matrix meets every fixed policy threshold.
	#[must_use]
	pub fn passed(&self) -> bool {
		self.violations.is_empty()
	}
}

/// A zero-sized value whose JSON representation is always boolean `false`.
///
/// Deserialization rejects `true`, so public contracts that use this type cannot
/// be constructed with an affirmative eligibility value.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct FalseOnly;
impl Serialize for FalseOnly {
	fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
	where
		S: Serializer,
	{
		serializer.serialize_bool(false)
	}
}

impl<'de> Deserialize<'de> for FalseOnly {
	fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
	where
		D: Deserializer<'de>,
	{
		if bool::deserialize(deserializer)? {
			Err(serde::de::Error::custom("value must be false"))
		} else {
			Ok(Self)
		}
	}
}

/// Fixed-fixture calibrated task-resampling sensitivity interval.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TaskResamplingSensitivityInterval {
	/// Interval method.
	pub method: String,
	/// Lower AIQ bound.
	pub lower: f64,
	/// Upper AIQ bound.
	pub upper: f64,
	/// Central percentile mass.
	pub central_mass: f64,
	/// Bootstrap replicate count.
	pub samples: usize,
	/// Fixed seed.
	pub seed: u64,
}

/// Best- and worst-case completion bounds over the planned fixed fixture.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CompletionBounds {
	/// All unobserved planned tasks receive zero.
	pub lower: f64,
	/// All unobserved planned tasks receive one.
	pub upper: f64,
}

/// Descriptive difficulty coverage. Difficulty does not affect score weights.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DifficultyCoverage {
	/// Planned task count.
	pub expected_tasks: usize,
	/// Valid observed task scores.
	pub valid_tasks: usize,
}

/// Strict-pass diagnostic and Wilson interval.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BinaryMicroDiagnostic {
	/// Valid semantic task-score sample size. Partial scores remain in the denominator.
	pub sample_size: usize,
	/// Strict successes with a task score of exactly one.
	pub successes: usize,
	/// Strict successes divided by the valid semantic task-score sample size.
	pub proportion: Option<f64>,
	/// Wilson 95% lower bound.
	pub wilson_lower: Option<f64>,
	/// Wilson 95% upper bound.
	pub wilson_upper: Option<f64>,
}

/// A calibrated one-dimensional latent ability estimate.
///
/// `score` is the predicted probability of success on an average calibrated
/// task, expressed as 0--100. It is a convenient bounded display value, not an
/// IQ norm, a population percentile, or an unbounded claim about intelligence.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LatentAbilityEstimate {
	/// Measurement method identity.
	pub method: String,
	/// Calibration-bank identity that fixes the item scale.
	pub calibration_digest: String,
	/// Model location on the anchored logit scale.
	pub theta: f64,
	/// Conditional standard error from observed Fisher information plus the ability prior, given the released item bank.
	pub standard_error: f64,
	/// Conditional Wald 95% lower bound on the latent logit scale, given the item bank.
	pub theta_ci_low: f64,
	/// Conditional Wald 95% upper bound on the latent logit scale, given the item bank.
	pub theta_ci_high: f64,
	/// Observed Fisher information before the prior contribution.
	pub observed_information: f64,
	/// Predicted success probability on an average calibrated task, 0--100.
	pub score: f64,
	/// Conditional Wald 95% lower bound after mapping the latent interval to 0--100.
	pub score_ci_low: f64,
	/// Conditional Wald 95% upper bound after mapping the latent interval to 0--100.
	pub score_ci_high: f64,
	/// Reliability statement for a single matrix estimate.
	pub reliability_status: String,
	/// Number of valid task observations used for this estimate.
	pub items_used: usize,
	/// Number of tasks in the frozen calibration bank.
	pub calibration_task_count: usize,
	/// Number of model configurations used to fit the bank.
	pub calibration_model_count: usize,
}

/// Coverage and disposition counts.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CoverageSummary {
	/// Expected tasks.
	pub expected_tasks: usize,
	/// Tasks with a completed evaluator-backed semantic score. Semantic zero
	/// scores are included; runtime-failure zeros are not.
	pub valid_tasks: usize,
	/// Observed result records that failed at runtime or infrastructure validation;
	/// these are not malformed model answers and never enter semantic aggregates.
	pub invalid_tasks: usize,
	/// Expected cells with no result record. A timeout or other observed failure is
	/// invalid, not missing.
	pub missing_tasks: usize,
	/// Tasks that are not applicable because the capability is unavailable.
	pub not_applicable_tasks: usize,
	/// Expected domains.
	pub expected_domains: usize,
	/// Domains with at least one valid score.
	pub covered_domains: usize,
}

/// Transparent inputs and score for one domain.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DomainScore {
	/// Stable domain.
	pub domain: Domain,
	/// Expected tasks.
	pub expected_tasks: usize,
	/// Valid task scores.
	pub valid_tasks: usize,
	/// Observed runtime or infrastructure failures; excluded from the semantic mean.
	pub invalid_tasks: usize,
	/// Expected cells with no result record.
	pub missing_tasks: usize,
	/// Capability-unavailable task results.
	pub not_applicable_tasks: usize,
	/// Historical/runtime failures that carried a zero on the wire; diagnostic only
	/// and never included in `valid_tasks` or `score`.
	pub zero_failure_tasks: usize,
	/// Equal-weight mean of valid task scores.
	pub score: Option<f64>,
}

/// A transparent AIQ 2.0 score report.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ScoreReport {
	/// Score report schema.
	pub schema_version: String,
	/// Scoring implementation version.
	pub scoring_version: String,
	/// Measurement-model version.
	pub measurement_version: String,
	/// Scored model configuration.
	pub model: ModelConfig,
	/// Publication tier.
	pub tier: ScoreTier,
	/// Calibrated latent score. It is present only for the Official tier.
	pub score: Option<f64>,
	/// Raw equal-domain criterion score. It is a diagnostic, not the ranking score.
	pub quality_score: Option<f64>,
	/// Calibrated latent ability evidence. Official reports require this field.
	pub latent_ability: Option<LatentAbilityEstimate>,
	/// Whether this report can participate in an official ranking.
	pub ranking_eligible: bool,
	/// Fixed-fixture completion bounds.
	pub completion_bounds: Option<CompletionBounds>,
	/// Fixed-fixture calibrated sensitivity interval, not a universal capability CI.
	pub task_resampling_sensitivity_interval: Option<TaskResamplingSensitivityInterval>,
	/// Binary micro Wilson diagnostic. It is not the main AIQ interval.
	pub binary_micro_diagnostic: BinaryMicroDiagnostic,
	/// Overall coverage.
	pub coverage: CoverageSummary,
	/// Descriptive coverage by difficulty. It adds no score weight.
	#[serde(deserialize_with = "deserialize_difficulty_coverage")]
	pub difficulty_coverage: BTreeMap<String, DifficultyCoverage>,
	/// Additional results for the same task and model.
	pub duplicate_results: usize,
	/// Per-domain transparent inputs.
	pub domains: Vec<DomainScore>,
	/// Human-readable rule summary.
	pub rule: String,
}

/// Explicitly non-publication analysis for one calibration model.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CalibrationScoreReport {
	/// Calibration report schema.
	pub schema_version: String,
	/// Run class. This is always `calibration`.
	pub run_class: String,
	/// Scoring implementation version.
	pub scoring_version: String,
	/// Measurement-model version.
	pub measurement_version: String,
	/// Analyzed model configuration.
	pub model: ModelConfig,
	/// Descriptive coverage state, not a publication tier.
	pub descriptive_status: CalibrationDescriptiveStatus,
	/// Whether this analysis can be interpreted as Official. This is always false.
	pub official_eligible: FalseOnly,
	/// Whether this analysis can participate in ranking. This is always false.
	pub ranking_eligible: FalseOnly,
	/// Equal-domain criterion score when the coverage threshold is met.
	pub quality_score: Option<f64>,
	/// Calibrated latent ability evidence when the complete bank is available.
	pub latent_ability: Option<LatentAbilityEstimate>,
	/// Fixed-fixture completion bounds.
	pub completion_bounds: Option<CompletionBounds>,
	/// Fixed-fixture calibrated task-resampling sensitivity analysis.
	pub task_resampling_sensitivity_interval: Option<TaskResamplingSensitivityInterval>,
	/// Binary micro Wilson diagnostic.
	pub binary_micro_diagnostic: BinaryMicroDiagnostic,
	/// Overall coverage.
	pub coverage: CoverageSummary,
	/// Descriptive coverage by difficulty.
	pub difficulty_coverage: BTreeMap<String, DifficultyCoverage>,
	/// Additional results for the same task and model.
	pub duplicate_results: usize,
	/// Per-domain descriptive inputs.
	pub domains: Vec<DomainScore>,
	/// Human-readable calibration rule summary.
	pub rule: String,
}

/// Scoring input error.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScoreError {
	message: String,
}
impl ScoreError {
	fn new(message: impl Into<String>) -> Self {
		Self { message: message.into() }
	}
}

impl Display for ScoreError {
	fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
		formatter.write_str(&self.message)
	}
}

impl std::error::Error for ScoreError {}

#[derive(Clone, Copy, Debug, Default)]
struct UniversalCalibrationCounts {
	all_zero: usize,
	semantic_zero: usize,
	runtime_zero: usize,
	mixed_zero: usize,
	full_credit: usize,
}

#[derive(Default)]
struct DomainAccumulator {
	expected: usize,
	invalid: usize,
	missing: usize,
	not_applicable: usize,
	zero_failures: usize,
	observations: Vec<Observation>,
}

#[derive(Clone)]
struct Observation {
	score: f64,
	cluster: String,
}

#[derive(Clone, Debug, Serialize)]
struct CalibrationTaskParameter {
	task_id: String,
	task_version: String,
	domain: Domain,
	facility: f64,
	difficulty: f64,
	mean_item_information: f64,
}

#[derive(Clone, Debug, Serialize)]
struct CalibrationBankIdentity {
	measurement_version: &'static str,
	method: &'static str,
	task_set_id: &'static str,
	task_set_version: &'static str,
	tasks: Vec<CalibrationTaskParameter>,
}

#[derive(Clone, Debug)]
struct CalibrationBank {
	digest: String,
	items: BTreeMap<String, CalibrationTaskParameter>,
	model_count: usize,
}

#[derive(Deserialize)]
struct FrozenCatalog {
	task_set_id: String,
	task_set_version: String,
	#[serde(alias = "task_metadata_identity")]
	identity_commitment: FrozenIdentityCommitment,
	tasks: Vec<FrozenCatalogTask>,
}

#[derive(Deserialize)]
struct FrozenIdentityCommitment {
	digest: String,
}

#[derive(Deserialize, Serialize)]
struct FrozenCatalogTask {
	task_id: String,
	task_version: String,
	domain: Domain,
	difficulty: String,
	cluster_id: String,
	evaluator: FrozenCatalogEvaluator,
	#[serde(flatten)]
	extra: BTreeMap<String, Value>,
}

#[derive(Deserialize, Serialize)]
struct FrozenCatalogEvaluator {
	scorer_version: String,
	#[serde(flatten)]
	extra: BTreeMap<String, Value>,
}

struct DeterministicRandom {
	state: u64,
}
impl DeterministicRandom {
	fn new(seed: u64) -> Self {
		debug_assert_ne!(seed, 0);

		Self { state: seed }
	}

	fn next_u64(&mut self) -> u64 {
		self.state ^= self.state >> 12;
		self.state ^= self.state << 25;
		self.state ^= self.state >> 27;

		self.state.wrapping_mul(0x2545_F491_4F6C_DD1D)
	}

	fn index(&mut self, upper: usize) -> usize {
		debug_assert_ne!(upper, 0);

		let range = 1_u128 << 64;
		let bound = upper as u128;
		let limit = range - (range % bound);

		loop {
			let value = u128::from(self.next_u64());

			if value < limit {
				return (value % bound) as usize;
			}
		}
	}
}

/// Normalizes the one historical wire defect that is safe to repair for an
/// offline diagnostic: a failed runtime result that carried `task_score: 0`.
///
/// This function is intentionally not used by the production `score`, package,
/// or verifier paths. It only supports a caller that has explicitly selected a
/// non-publication diagnostic workflow. A failed result is not a semantic
/// incorrect answer, so its score is removed and its content address is
/// recomputed without changing the source record on disk.
pub(crate) fn normalize_historical_runtime_zeroes(
	results: &mut [TaskResult],
) -> Result<usize, ScoreError> {
	let mut normalized = 0;

	for result in results {
		if result.status != ResultStatus::Failed || result.task_score != Some(0.0) {
			continue;
		}
		if result.evaluation != EvaluationOutcome::NotEvaluated {
			return Err(ScoreError::new(
				"historical runtime-zero result has a semantic evaluation",
			));
		}

		let Some(failure) = result.failure.as_ref() else {
			return Err(ScoreError::new("historical runtime-zero result lacks a failure taxonomy"));
		};

		if !matches!(
			failure.kind,
			FailureKind::Spawn
				| FailureKind::Timeout
				| FailureKind::UnsupportedModel
				| FailureKind::Authentication
				| FailureKind::SubscriptionLimit
				| FailureKind::NonZeroExit
				| FailureKind::CapabilityValidationFailed
				| FailureKind::MissingResponse
				| FailureKind::EvaluatorFailure
				| FailureKind::BudgetExceeded
				| FailureKind::OutputTruncated
				| FailureKind::WorkspaceUnavailable
				| FailureKind::WorkspaceIntegrity
		) {
			return Err(ScoreError::new(
				"historical runtime-zero result has an incompatible failure taxonomy",
			));
		}

		result.task_score = None;

		let content_hash = result
			.content_hash()
			.map_err(|error| ScoreError::new(format!("historical result hash failed: {error}")))?;

		result.result_id = format!("result_{}", content_hash.trim_start_matches("sha256:"));
		normalized += 1;
	}

	Ok(normalized)
}

pub(crate) fn frozen_catalog_entry_digests() -> Option<BTreeMap<(String, String), String>> {
	let catalog = frozen_catalog().ok()?;

	catalog
		.tasks
		.into_iter()
		.map(|task| {
			let digest = protocol::canonical_hash(&task).ok()?;

			Some(((task.task_id.clone(), task.task_version.clone()), digest))
		})
		.collect()
}

pub(crate) fn task_bindings_match_frozen_catalog(tasks: &[TaskDefinition]) -> bool {
	let Ok(catalog) = frozen_catalog() else {
		return false;
	};

	task_bindings_match_catalog(tasks, catalog, AIQ_SCORING_VERSION)
}

pub(crate) fn task_bindings_match_core_catalog(tasks: &[TaskDefinition]) -> bool {
	task_bindings_match_frozen_catalog(tasks)
}

/// Diagnoses one complete 17-by-72 Official matrix without changing AIQ weights.
pub fn diagnose_official_calibration(
	tasks: &[TaskDefinition],
	results: &[TaskResult],
) -> Result<OfficialCalibrationDiagnostic, ScoreError> {
	let policy = OfficialCalibrationPolicy::default();
	let (matrix, expected_domains) = calibration_matrix(tasks, results, &policy)?;
	let (task_statistics, counts) = calibration_task_statistics(tasks, &matrix)?;
	let informative_tasks = task_statistics
		.values()
		.filter(|(facility, range)| calibration_informative(&policy, *facility, *range))
		.count();
	let informative_task_rate = informative_tasks as f64 / tasks.len() as f64;
	let non_uniform_tasks = task_statistics
		.values()
		.filter(|(_, range)| calibration_non_uniform(&policy, *range))
		.count();
	let non_uniform_task_rate = non_uniform_tasks as f64 / tasks.len() as f64;
	let domains = calibration_domain_summaries(tasks, &task_statistics, expected_domains, &policy);
	let (min_model_score, max_model_score, model_score_range) =
		calibration_model_score_range(tasks, &matrix, &domains);
	let bank = calibration_bank_from_matrix(tasks, &matrix)?;
	let model_abilities = MODEL_MATRIX
		.iter()
		.map(|model| estimate_model_ability(tasks, &matrix, *model, &bank))
		.collect::<Result<Vec<_>, _>>()?;
	let (min_latent_score, max_latent_score) = model_abilities
		.iter()
		.map(|estimate| estimate.score)
		.fold((f64::INFINITY, f64::NEG_INFINITY), |(minimum, maximum), score| {
			(minimum.min(score), maximum.max(score))
		});
	let latent_score_range = max_latent_score - min_latent_score;
	let max_latent_standard_error =
		model_abilities.iter().map(|estimate| estimate.standard_error).fold(0.0, f64::max);
	let observed = OfficialCalibrationSummary {
		policy_version: policy.version.clone(),
		tasks: tasks.len(),
		model_configurations: MODEL_MATRIX.len(),
		informative_tasks,
		informative_task_rate,
		non_uniform_tasks,
		non_uniform_task_rate,
		universal_zero_tasks: counts.all_zero,
		universal_semantic_zero_tasks: counts.semantic_zero,
		universal_runtime_zero_tasks: counts.runtime_zero,
		universal_mixed_zero_tasks: counts.mixed_zero,
		universal_full_credit_tasks: counts.full_credit,
		domains,
		min_model_score,
		max_model_score,
		model_score_range,
		min_latent_score,
		max_latent_score,
		latent_score_range,
		max_latent_standard_error,
	};
	let violations = calibration_violations(&policy, &observed);

	Ok(OfficialCalibrationDiagnostic { policy, observed, violations })
}

/// Scores one model with production AIQ 2.0 bootstrap settings.
pub fn score_model(
	tasks: &[TaskDefinition],
	results: &[TaskResult],
	model: ModelConfig,
) -> Result<ScoreReport, ScoreError> {
	score_model_with_options(tasks, results, model, ScoreOptions::default())
}

/// Scores one model with explicit deterministic bootstrap settings.
///
/// AIQ 2.0 is a Rasch fractional MAP estimate mapped to 0--100. The raw
/// equal-domain mean remains a criterion-referenced diagnostic. Coverage does
/// not multiply or otherwise alter either point estimate.
pub fn score_model_with_options(
	tasks: &[TaskDefinition],
	results: &[TaskResult],
	model: ModelConfig,
	options: ScoreOptions,
) -> Result<ScoreReport, ScoreError> {
	score_model_with_context(tasks, results, model, ScoreContext::default(), options)
}

/// Scores one model with explicit run-level capability evidence.
pub fn score_model_with_context(
	tasks: &[TaskDefinition],
	results: &[TaskResult],
	model: ModelConfig,
	context: ScoreContext,
	options: ScoreOptions,
) -> Result<ScoreReport, ScoreError> {
	let frozen_catalog = catalog_identity_is_frozen(tasks);
	let expected = validated_expected_tasks(tasks, options)?;
	let matching = matching_model_results(results, model);
	let has_synthetic_results = selected_model_uses_synthetic_results(&matching)?;

	ensure_uniform_result_provenance(results)?;

	let uniform_capability_unavailable = expected.len() == matching.len()
		&& expected.keys().all(|key| {
			matching.get(key).is_some_and(
				|found| matches!(found.as_slice(), [result] if preflight_not_applicable_result(result)),
			)
		});

	if context.preflight_configuration_not_applicable && !uniform_capability_unavailable {
		return Err(ScoreError::new(
			"preflight N/A evidence conflicts with the task-result disposition",
		));
	}

	let uniform_out_of_scope =
		context.preflight_configuration_not_applicable && uniform_capability_unavailable;
	let trusted_non_synthetic_results = expected.keys().all(|key| {
		matching.get(key).is_some_and(|found| {
			matches!(found.as_slice(), [result] if !result.provenance.synthetic
				&& result.provenance.local_trust == TrustTier::Trusted)
		})
	});
	let mut accumulators = BTreeMap::<Domain, DomainAccumulator>::new();
	let mut duplicate_results = 0;

	for (key, task) in expected {
		let accumulator = accumulators.entry(task.domain).or_default();

		accumulator.expected += 1;

		match matching.get(&key).map(Vec::as_slice) {
			None | Some([]) => accumulator.missing += 1,
			Some([result]) => {
				classify_result(task, result, accumulator, uniform_out_of_scope)?;
			},
			Some(found) => {
				accumulator.invalid += 1;
				duplicate_results += found.len() - 1;
			},
		}
	}

	let coverage = coverage_summary(&accumulators);
	let coverage_tier = publication_tier(&coverage, &accumulators, frozen_catalog);
	let calibration_gate_passed =
		official_calibration_gate_passed(tasks, results, coverage_tier, has_synthetic_results)?;
	let tier = resolved_score_tier(coverage_tier, has_synthetic_results, calibration_gate_passed);
	let domain_scores = domain_scores(&accumulators);
	let quality_score = if matches!(
		tier,
		ScoreTier::Official | ScoreTier::SyntheticComplete | ScoreTier::Provisional
	) {
		Some(macro_score(&accumulators)? * 100.0)
	} else {
		None
	};
	let latent_ability = if tier == ScoreTier::Official && !has_synthetic_results {
		let matrix = calibration_matrix(tasks, results, &OfficialCalibrationPolicy::default())?.0;
		let bank = calibration_bank_from_matrix(tasks, &matrix)?;

		Some(estimate_model_ability(tasks, &matrix, model, &bank)?)
	} else {
		None
	};
	let score = if tier == ScoreTier::Official {
		Some(
			latent_ability
				.as_ref()
				.ok_or_else(|| {
					ScoreError::new("Official score requires a complete calibration matrix")
				})?
				.score,
		)
	} else {
		None
	};
	let has_latent_ability = latent_ability.is_some();
	let task_resampling_sensitivity_interval = if quality_score.is_some() {
		Some(cluster_bootstrap(&accumulators, options)?)
	} else {
		None
	};
	let completion_bounds = quality_score
		.map(|observed_aiq| completion_bounds(&accumulators, observed_aiq))
		.transpose()?;

	Ok(ScoreReport {
		schema_version: "aiq.score-report.v2".to_owned(),
		scoring_version: AIQ_SCORING_VERSION.to_owned(),
		measurement_version: AIQ_MEASUREMENT_VERSION.to_owned(),
		model,
		tier,
		score,
		quality_score,
		latent_ability,
		ranking_eligible: tier == ScoreTier::Official
			&& has_latent_ability
			&& context.receiver_authorized_publication
			&& trusted_non_synthetic_results,
		completion_bounds,
		task_resampling_sensitivity_interval,
		binary_micro_diagnostic: binary_micro_diagnostic(&accumulators),
		coverage,
		difficulty_coverage: difficulty_coverage(tasks, results, model, uniform_out_of_scope),
		duplicate_results,
		domains: domain_scores,
		rule: SCORE_RULE.to_owned(),
	})
}

/// Analyzes one calibration model without exposing publication semantics.
pub fn score_calibration_model_with_context(
	tasks: &[TaskDefinition],
	results: &[TaskResult],
	model: ModelConfig,
	context: ScoreContext,
	options: ScoreOptions,
) -> Result<CalibrationScoreReport, ScoreError> {
	let report = score_model_with_context(tasks, results, model, context, options)?;
	let descriptive_status = match report.tier {
		ScoreTier::Official | ScoreTier::SyntheticComplete => {
			CalibrationDescriptiveStatus::CompleteFixture
		},
		ScoreTier::Provisional => CalibrationDescriptiveStatus::ConditionalObserved,
		ScoreTier::CoverageOnly => CalibrationDescriptiveStatus::CoverageOnly,
		ScoreTier::NotApplicable => CalibrationDescriptiveStatus::NotApplicable,
	};
	let quality_score = matches!(
		report.tier,
		ScoreTier::Official | ScoreTier::SyntheticComplete | ScoreTier::Provisional
	)
	.then_some(report.quality_score)
	.flatten();

	Ok(CalibrationScoreReport {
		schema_version: "aiq.calibration-score-report.v2".to_owned(),
		run_class: "calibration".to_owned(),
		scoring_version: report.scoring_version,
		measurement_version: report.measurement_version,
		model: report.model,
		descriptive_status,
		official_eligible: FalseOnly,
		ranking_eligible: FalseOnly,
		quality_score,
		latent_ability: report.latent_ability,
		completion_bounds: report.completion_bounds,
		task_resampling_sensitivity_interval: report.task_resampling_sensitivity_interval,
		binary_micro_diagnostic: report.binary_micro_diagnostic,
		coverage: report.coverage,
		difficulty_coverage: report.difficulty_coverage,
		duplicate_results: report.duplicate_results,
		domains: report.domains,
		rule: CALIBRATION_SCORE_RULE.to_owned(),
	})
}

fn ensure_uniform_result_provenance(results: &[TaskResult]) -> Result<(), ScoreError> {
	let has_synthetic_inputs = results.iter().any(|result| result.provenance.synthetic);
	let has_non_synthetic_inputs = results.iter().any(|result| !result.provenance.synthetic);

	if has_synthetic_inputs && has_non_synthetic_inputs {
		return Err(ScoreError::new(
			"score inputs mix synthetic and non-synthetic result provenance",
		));
	}

	Ok(())
}

fn official_calibration_gate_passed(
	tasks: &[TaskDefinition],
	results: &[TaskResult],
	coverage_tier: ScoreTier,
	has_synthetic_results: bool,
) -> Result<bool, ScoreError> {
	let has_complete_matrix = tasks
		.len()
		.checked_mul(MODEL_MATRIX.len())
		.is_some_and(|expected_cells| results.len() == expected_cells);
	let has_complete_semantic_matrix =
		has_complete_matrix && results.iter().all(is_semantic_result);

	if coverage_tier == ScoreTier::Official
		&& !has_synthetic_results
		&& has_complete_semantic_matrix
	{
		return Ok(diagnose_official_calibration(tasks, results)?.passed());
	}

	Ok(false)
}

fn resolved_score_tier(
	coverage_tier: ScoreTier,
	has_synthetic_results: bool,
	calibration_gate_passed: bool,
) -> ScoreTier {
	if coverage_tier == ScoreTier::Official && has_synthetic_results {
		ScoreTier::SyntheticComplete
	} else if coverage_tier == ScoreTier::Official && !calibration_gate_passed {
		ScoreTier::CoverageOnly
	} else {
		coverage_tier
	}
}

fn validated_expected_tasks(
	tasks: &[TaskDefinition],
	options: ScoreOptions,
) -> Result<BTreeMap<(&str, &str), &TaskDefinition>, ScoreError> {
	if tasks.is_empty() {
		return Err(ScoreError::new("cannot score an empty task set"));
	}
	if options.bootstrap_samples == 0 {
		return Err(ScoreError::new("bootstrap_samples must be greater than zero"));
	}
	if options.bootstrap_seed == 0 {
		return Err(ScoreError::new("bootstrap_seed must be greater than zero"));
	}

	let expected = tasks
		.iter()
		.map(|task| ((task.task_id.as_str(), task.task_version.as_str()), task))
		.collect::<BTreeMap<_, _>>();

	if expected.len() != tasks.len() {
		return Err(ScoreError::new("task identifiers and versions must be unique"));
	}

	Ok(expected)
}

fn matching_model_results(
	results: &[TaskResult],
	model: ModelConfig,
) -> BTreeMap<(&str, &str), Vec<&TaskResult>> {
	let mut matching = BTreeMap::<(&str, &str), Vec<&TaskResult>>::new();

	for result in results.iter().filter(|result| result.model == model) {
		matching.entry((&result.task_id, &result.task_version)).or_default().push(result);
	}

	matching
}

fn calibration_matrix<'a>(
	tasks: &[TaskDefinition],
	results: &'a [TaskResult],
	policy: &OfficialCalibrationPolicy,
) -> Result<CalibrationMatrixEvidence<'a>, ScoreError> {
	if tasks.len() != policy.required_tasks {
		return Err(ScoreError::new(format!(
			"Official calibration requires exactly {} tasks",
			policy.required_tasks
		)));
	}

	let tasks_by_id =
		tasks.iter().map(|task| (task.task_id.as_str(), task)).collect::<BTreeMap<_, _>>();

	if tasks_by_id.len() != tasks.len() {
		return Err(ScoreError::new("Official calibration task identifiers must be unique"));
	}

	let expected_domains = tasks.iter().map(|task| task.domain).collect::<BTreeSet<_>>();

	if expected_domains.len() != 10 {
		return Err(ScoreError::new("Official calibration requires all 10 domains"));
	}

	let mut matrix = BTreeMap::new();

	for result in results {
		let Some(task) = tasks_by_id.get(result.task_id.as_str()) else {
			return Err(ScoreError::new(
				"Official calibration results contain an unexpected task or model",
			));
		};

		if result.task_version != task.task_version || !MODEL_MATRIX.contains(&result.model) {
			return Err(ScoreError::new(
				"Official calibration results contain an unexpected task or model",
			));
		}
		if !is_semantic_result(result) {
			return Err(ScoreError::new(format!(
				"Official calibration requires a completed semantic task score for task {}",
				result.task_id
			)));
		}
		if matrix.insert((result.task_id.as_str(), result.model), result).is_some() {
			return Err(ScoreError::new(
				"Official calibration results contain a duplicate task-model cell",
			));
		}
	}

	let expected_cells = tasks
		.len()
		.checked_mul(MODEL_MATRIX.len())
		.ok_or_else(|| ScoreError::new("Official calibration matrix cardinality overflows"))?;

	if matrix.len() != expected_cells {
		return Err(ScoreError::new("Official calibration requires a complete model-task matrix"));
	}

	Ok((matrix, expected_domains))
}

fn calibration_task_statistics<'a>(
	tasks: &'a [TaskDefinition],
	matrix: &CalibrationMatrix<'_>,
) -> Result<CalibrationStatisticsEvidence<'a>, ScoreError> {
	let mut statistics = BTreeMap::new();
	let mut counts = UniversalCalibrationCounts::default();

	for task in tasks {
		let task_results = MODEL_MATRIX
			.iter()
			.map(|model| {
				matrix
					.get(&(task.task_id.as_str(), *model))
					.copied()
					.ok_or_else(|| ScoreError::new("Official calibration matrix cell is missing"))
			})
			.collect::<Result<Vec<_>, _>>()?;
		let scores = task_results
			.iter()
			.map(|result| {
				result.task_score.filter(|score| score.is_finite() && (0.0..=1.0).contains(score))
			})
			.collect::<Option<Vec<_>>>()
			.ok_or_else(|| {
				ScoreError::new("Official calibration requires a valid score in every cell")
			})?;
		let facility = scores.iter().sum::<f64>() / scores.len() as f64;
		let minimum = scores.iter().copied().fold(f64::INFINITY, f64::min);
		let maximum = scores.iter().copied().fold(f64::NEG_INFINITY, f64::max);

		statistics.insert(task.task_id.as_str(), (facility, maximum - minimum));

		let semantic_zero = task_results.iter().all(|result| {
			result.status == ResultStatus::Completed
				&& result.evaluation == EvaluationOutcome::Incorrect
				&& result.task_score == Some(0.0)
				&& result.failure.is_none()
		});
		let runtime_zero = task_results.iter().all(|result| {
			result.status == ResultStatus::Failed
				&& result.evaluation == EvaluationOutcome::NotEvaluated
				&& result.task_score == Some(0.0)
				&& zero_failure(result)
		});
		let valid_zero = task_results.iter().all(|result| {
			result.task_score == Some(0.0)
				&& (result.status == ResultStatus::Completed && result.failure.is_none()
					|| result.status == ResultStatus::Failed && zero_failure(result))
		});

		if valid_zero {
			counts.all_zero += 1;

			if semantic_zero {
				counts.semantic_zero += 1;
			} else if runtime_zero {
				counts.runtime_zero += 1;
			} else {
				counts.mixed_zero += 1;
			}
		}
		if scores.iter().all(|score| *score == 1.0) {
			counts.full_credit += 1;
		}
	}

	Ok((statistics, counts))
}

fn calibration_in_facility_band(policy: &OfficialCalibrationPolicy, facility: f64) -> bool {
	facility + CALIBRATION_COMPARISON_TOLERANCE >= policy.informative_facility_min
		&& facility <= policy.informative_facility_max + CALIBRATION_COMPARISON_TOLERANCE
}

fn calibration_non_uniform(policy: &OfficialCalibrationPolicy, range: f64) -> bool {
	range + CALIBRATION_COMPARISON_TOLERANCE >= policy.informative_task_range_min
}

fn calibration_informative(policy: &OfficialCalibrationPolicy, facility: f64, range: f64) -> bool {
	calibration_in_facility_band(policy, facility) && calibration_non_uniform(policy, range)
}

fn calibration_domain_summaries(
	tasks: &[TaskDefinition],
	statistics: &CalibrationTaskStatistics<'_>,
	domains: BTreeSet<Domain>,
	policy: &OfficialCalibrationPolicy,
) -> Vec<OfficialCalibrationDomainSummary> {
	domains
		.into_iter()
		.map(|domain| {
			let facilities = tasks
				.iter()
				.filter(|task| task.domain == domain)
				.map(|task| statistics[task.task_id.as_str()])
				.collect::<Vec<_>>();

			OfficialCalibrationDomainSummary {
				domain,
				tasks: facilities.len(),
				mean_facility: facilities.iter().map(|(facility, _)| facility).sum::<f64>()
					/ facilities.len() as f64,
				informative_tasks: facilities
					.iter()
					.filter(|(facility, range)| calibration_informative(policy, *facility, *range))
					.count(),
				non_uniform_tasks: facilities
					.iter()
					.filter(|(_, range)| calibration_non_uniform(policy, *range))
					.count(),
			}
		})
		.collect()
}

fn calibration_model_score_range(
	tasks: &[TaskDefinition],
	matrix: &CalibrationMatrix<'_>,
	domains: &[OfficialCalibrationDomainSummary],
) -> (f64, f64, f64) {
	let model_scores = MODEL_MATRIX.iter().map(|model| {
		let domain_total = domains
			.iter()
			.map(|domain| {
				let scores = tasks
					.iter()
					.filter(|task| task.domain == domain.domain)
					.map(|task| matrix[&(task.task_id.as_str(), *model)].task_score.unwrap_or(0.0));
				let (sum, count) =
					scores.fold((0.0, 0_usize), |(sum, count), score| (sum + score, count + 1));

				sum / count as f64
			})
			.sum::<f64>();

		domain_total / domains.len() as f64 * 100.0
	});
	let (minimum, maximum) = model_scores
		.fold((f64::INFINITY, f64::NEG_INFINITY), |(minimum, maximum), score| {
			(minimum.min(score), maximum.max(score))
		});

	(minimum, maximum, maximum - minimum)
}

fn calibration_bank_from_matrix(
	tasks: &[TaskDefinition],
	matrix: &CalibrationMatrix<'_>,
) -> Result<CalibrationBank, ScoreError> {
	let (model_locations, difficulties) = fit_joint_rasch_parameters(tasks, matrix)?;
	let mut parameters = Vec::with_capacity(tasks.len());

	for (task_index, task) in tasks.iter().enumerate() {
		let scores = MODEL_MATRIX
			.iter()
			.map(|model| {
				matrix
					.get(&(task.task_id.as_str(), *model))
					.and_then(|result| result.task_score)
					.filter(|score| score.is_finite() && (0.0..=1.0).contains(score))
					.ok_or_else(|| {
						ScoreError::new("calibration requires a finite task score in every cell")
					})
			})
			.collect::<Result<Vec<_>, _>>()?;
		let facility = scores.iter().sum::<f64>() / scores.len() as f64;
		let mean_item_information = model_locations
			.iter()
			.map(|location| {
				let probability = logistic(*location - difficulties[task_index]);

				probability * (1.0 - probability)
			})
			.sum::<f64>()
			/ model_locations.len() as f64;

		parameters.push(CalibrationTaskParameter {
			task_id: task.task_id.clone(),
			task_version: task.task_version.clone(),
			domain: task.domain,
			facility,
			difficulty: difficulties[task_index],
			mean_item_information,
		});
	}

	let identity = CalibrationBankIdentity {
		measurement_version: AIQ_MEASUREMENT_VERSION,
		method: LATENT_ABILITY_METHOD,
		task_set_id: AIQ_TASK_SET_ID,
		task_set_version: AIQ_TASK_SET_VERSION,
		tasks: parameters.clone(),
	};
	let digest = protocol::canonical_hash(&identity)
		.map_err(|error| ScoreError::new(format!("calibration identity failed: {error}")))?;
	let items = parameters
		.into_iter()
		.map(|parameter| (parameter.task_id.clone(), parameter))
		.collect::<BTreeMap<_, _>>();

	Ok(CalibrationBank { digest, items, model_count: MODEL_MATRIX.len() })
}

/// Fits a one-dimensional fractional Rasch model to the complete calibration
/// matrix. Model locations and item difficulties are updated alternately with
/// weak normal priors. Item difficulties are centered after every outer step;
/// model locations receive the same translation so that theta minus difficulty
/// remains unchanged.
fn fit_joint_rasch_parameters(
	tasks: &[TaskDefinition],
	matrix: &CalibrationMatrix<'_>,
) -> Result<(Vec<f64>, Vec<f64>), ScoreError> {
	fit_joint_rasch_parameters_with_limit(tasks, matrix, RASCH_MAX_ITERATIONS)
}

fn fit_joint_rasch_parameters_with_limit(
	tasks: &[TaskDefinition],
	matrix: &CalibrationMatrix<'_>,
	max_iterations: usize,
) -> Result<(Vec<f64>, Vec<f64>), ScoreError> {
	if tasks.is_empty() {
		return Err(ScoreError::new("Rasch calibration requires at least one task"));
	}
	if max_iterations == 0 {
		return Err(ScoreError::new("Rasch calibration requires a positive iteration limit"));
	}

	let mut scores = vec![vec![0.0; tasks.len()]; MODEL_MATRIX.len()];

	for (model_index, model) in MODEL_MATRIX.iter().enumerate() {
		for (task_index, task) in tasks.iter().enumerate() {
			scores[model_index][task_index] = matrix
				.get(&(task.task_id.as_str(), *model))
				.and_then(|result| result.task_score)
				.filter(|score| score.is_finite() && (0.0..=1.0).contains(score))
				.ok_or_else(|| {
					ScoreError::new("calibration requires a finite task score in every cell")
				})?;
		}
	}

	let mut difficulties = tasks
		.iter()
		.enumerate()
		.map(|(task_index, _)| {
			let mean_score = scores.iter().map(|model| model[task_index]).sum::<f64>()
				/ MODEL_MATRIX.len() as f64;

			-logit(mean_score)
		})
		.collect::<Vec<_>>();
	let mut model_locations = vec![0.0; MODEL_MATRIX.len()];

	center_rasch_scale(&mut model_locations, &mut difficulties);

	let mut converged = false;

	for _ in 0..max_iterations {
		let previous_locations = model_locations.clone();
		let previous_difficulties = difficulties.clone();

		for model_index in 0..MODEL_MATRIX.len() {
			model_locations[model_index] = fit_theta_given_items(
				&scores[model_index],
				&difficulties,
				model_locations[model_index],
			)?
			.0;
		}

		fit_item_difficulties_given_models(&scores, &model_locations, &mut difficulties)?;
		center_rasch_scale(&mut model_locations, &mut difficulties);

		let max_change = model_locations
			.iter()
			.zip(previous_locations)
			.map(|(current, previous)| (current - previous).abs())
			.chain(
				difficulties
					.iter()
					.zip(previous_difficulties)
					.map(|(current, previous)| (current - previous).abs()),
			)
			.fold(0.0, f64::max);

		if max_change < RASCH_CONVERGENCE
			&& rasch_score_equation_residual(&scores, &model_locations, &difficulties)?
				< RASCH_CONVERGENCE
		{
			converged = true;

			break;
		}
	}

	if !converged {
		return Err(ScoreError::new(format!(
			"Rasch calibration did not converge within {max_iterations} outer iterations"
		)));
	}

	center_rasch_scale(&mut model_locations, &mut difficulties);

	let residual = rasch_score_equation_residual(&scores, &model_locations, &difficulties)?;

	if residual >= RASCH_CONVERGENCE {
		return Err(ScoreError::new(format!(
			"Rasch calibration score-equation residual {residual:.3e} exceeds tolerance"
		)));
	}

	Ok((model_locations, difficulties))
}

fn center_rasch_scale(model_locations: &mut [f64], difficulties: &mut [f64]) {
	let difficulty_center = difficulties.iter().sum::<f64>() / difficulties.len() as f64;

	for difficulty in difficulties {
		*difficulty -= difficulty_center;
	}
	for location in model_locations {
		*location -= difficulty_center;
	}
}

fn fit_theta_given_items(
	scores: &[f64],
	difficulties: &[f64],
	initial: f64,
) -> Result<(f64, f64), ScoreError> {
	let mut theta = initial.clamp(-RASCH_MAX_ABS_PARAMETER, RASCH_MAX_ABS_PARAMETER);
	let mut converged = false;

	for _ in 0..RASCH_MAX_INNER_ITERATIONS {
		let (gradient, information) = scores.iter().zip(difficulties).fold(
			(-theta * RASCH_PRIOR_PRECISION, RASCH_PRIOR_PRECISION),
			|(gradient, information), (score, difficulty)| {
				let probability = logistic(theta - difficulty);

				(gradient + score - probability, information + probability * (1.0 - probability))
			},
		);

		if !gradient.is_finite() || !information.is_finite() || information <= 0.0 {
			return Err(ScoreError::new("Rasch ability update produced a non-finite equation"));
		}

		let step = gradient / information;

		if !step.is_finite() {
			return Err(ScoreError::new("Rasch ability update produced a non-finite step"));
		}

		theta = (theta + step).clamp(-RASCH_MAX_ABS_PARAMETER, RASCH_MAX_ABS_PARAMETER);

		if step.abs() < RASCH_CONVERGENCE {
			converged = true;

			break;
		}
	}

	if !converged {
		return Err(ScoreError::new(
			"Rasch ability update did not converge within its inner iteration limit",
		));
	}

	let observed_information = difficulties
		.iter()
		.map(|difficulty| {
			let probability = logistic(theta - difficulty);

			probability * (1.0 - probability)
		})
		.sum::<f64>();

	if !theta.is_finite() || !observed_information.is_finite() {
		return Err(ScoreError::new("Rasch ability update produced a non-finite parameter"));
	}

	Ok((theta, observed_information))
}

fn fit_item_difficulties_given_models(
	scores: &[Vec<f64>],
	model_locations: &[f64],
	difficulties: &mut [f64],
) -> Result<(), ScoreError> {
	for _ in 0..RASCH_MAX_INNER_ITERATIONS {
		let mut gradients = Vec::with_capacity(difficulties.len());
		let mut informations = Vec::with_capacity(difficulties.len());

		for (task_index, difficulty) in difficulties.iter().enumerate() {
			let (gradient, information) = scores.iter().zip(model_locations).fold(
				(-difficulty * RASCH_PRIOR_PRECISION, RASCH_PRIOR_PRECISION),
				|(gradient, information), (model_scores, location)| {
					let probability = logistic(location - difficulty);

					(
						gradient + probability - model_scores[task_index],
						information + probability * (1.0 - probability),
					)
				},
			);

			if !gradient.is_finite() || !information.is_finite() || information <= 0.0 {
				return Err(ScoreError::new("Rasch item update produced a non-finite equation"));
			}

			gradients.push(gradient);
			informations.push(information);
		}

		let multiplier = -gradients
			.iter()
			.zip(&informations)
			.map(|(gradient, information)| gradient / information)
			.sum::<f64>()
			/ informations.iter().map(|information| 1.0 / information).sum::<f64>();

		if !multiplier.is_finite() {
			return Err(ScoreError::new(
				"Rasch item update produced a non-finite constraint multiplier",
			));
		}

		let mut max_step: f64 = 0.0;

		for (index, difficulty) in difficulties.iter_mut().enumerate() {
			let step = (gradients[index] + multiplier) / informations[index];

			if !step.is_finite() {
				return Err(ScoreError::new("Rasch item update produced a non-finite step"));
			}

			*difficulty =
				(*difficulty + step).clamp(-RASCH_MAX_ABS_PARAMETER, RASCH_MAX_ABS_PARAMETER);
			max_step = max_step.max(step.abs());
		}

		if max_step < RASCH_CONVERGENCE {
			return Ok(());
		}
	}

	Err(ScoreError::new("Rasch item update did not converge within its inner iteration limit"))
}

fn rasch_score_equation_residual(
	scores: &[Vec<f64>],
	model_locations: &[f64],
	difficulties: &[f64],
) -> Result<f64, ScoreError> {
	let mut maximum = 0.0_f64;

	for (model_scores, location) in scores.iter().zip(model_locations) {
		let residual = model_scores
			.iter()
			.zip(difficulties)
			.map(|(score, difficulty)| score - logistic(location - difficulty))
			.sum::<f64>()
			- location * RASCH_PRIOR_PRECISION;

		if !residual.is_finite() {
			return Err(ScoreError::new("Rasch score equation produced a non-finite residual"));
		}

		maximum = maximum.max(residual.abs());
	}

	let item_residuals = difficulties
		.iter()
		.enumerate()
		.map(|(task_index, difficulty)| {
			let residual = scores
				.iter()
				.zip(model_locations)
				.map(|(model_scores, location)| {
					logistic(location - difficulty) - model_scores[task_index]
				})
				.sum::<f64>()
				- difficulty * RASCH_PRIOR_PRECISION;

			if !residual.is_finite() {
				return Err(ScoreError::new("Rasch item equation produced a non-finite residual"));
			}

			Ok(residual)
		})
		.collect::<Result<Vec<_>, ScoreError>>()?;
	let item_mean = item_residuals.iter().sum::<f64>() / item_residuals.len() as f64;

	maximum = maximum.max(
		item_residuals.iter().map(|residual| (residual - item_mean).abs()).fold(0.0, f64::max),
	);

	if !maximum.is_finite() {
		return Err(ScoreError::new("Rasch score-equation residual is non-finite"));
	}

	Ok(maximum)
}

fn estimate_model_ability(
	tasks: &[TaskDefinition],
	matrix: &CalibrationMatrix<'_>,
	model: ModelConfig,
	bank: &CalibrationBank,
) -> Result<LatentAbilityEstimate, ScoreError> {
	let observations = tasks
		.iter()
		.map(|task| {
			let item = bank
				.items
				.get(&task.task_id)
				.ok_or_else(|| ScoreError::new("calibration bank is missing a task parameter"))?;
			let score = matrix
				.get(&(task.task_id.as_str(), model))
				.and_then(|result| result.task_score)
				.filter(|score| score.is_finite() && (0.0..=1.0).contains(score))
				.ok_or_else(|| {
					ScoreError::new("latent ability requires valid task observations")
				})?;

			Ok((score, item.difficulty))
		})
		.collect::<Result<Vec<_>, ScoreError>>()?;
	let (scores, difficulties): (Vec<_>, Vec<_>) = observations.into_iter().unzip();

	if scores.is_empty() {
		return Err(ScoreError::new("latent ability requires at least one task"));
	}

	let (theta, observed_information) = fit_theta_given_items(&scores, &difficulties, 0.0)?;
	let standard_error = (observed_information + RASCH_PRIOR_PRECISION).sqrt().recip();
	let theta_ci_low = theta - RASCH_WALD_Z_95 * standard_error;
	let theta_ci_high = theta + RASCH_WALD_Z_95 * standard_error;
	let score_ci_low = logistic(theta_ci_low) * 100.0;
	let score_ci_high = logistic(theta_ci_high) * 100.0;

	Ok(LatentAbilityEstimate {
		method: LATENT_ABILITY_METHOD.to_owned(),
		calibration_digest: bank.digest.clone(),
		theta,
		standard_error,
		theta_ci_low,
		theta_ci_high,
		observed_information,
		score: logistic(theta) * 100.0,
		score_ci_low,
		score_ci_high,
		reliability_status: LATENT_RELIABILITY_STATUS.to_owned(),
		items_used: scores.len(),
		calibration_task_count: bank.items.len(),
		calibration_model_count: bank.model_count,
	})
}

fn logistic(value: f64) -> f64 {
	if value >= 0.0 {
		1.0 / (1.0 + (-value).exp())
	} else {
		let exponential = value.exp();

		exponential / (1.0 + exponential)
	}
}

fn logit(probability: f64) -> f64 {
	let probability = probability.clamp(0.001, 0.999);

	(probability / (1.0 - probability)).ln()
}

fn calibration_violations(
	policy: &OfficialCalibrationPolicy,
	observed: &OfficialCalibrationSummary,
) -> Vec<String> {
	let mut violations = Vec::new();

	if observed.universal_runtime_zero_tasks > 0 || observed.universal_mixed_zero_tasks > 0 {
		violations.push(format!(
			"universal runtime-failure zeros are not permitted (runtime: {}, mixed: {})",
			observed.universal_runtime_zero_tasks, observed.universal_mixed_zero_tasks
		));
	}

	let semantic_zero_rate = observed.universal_semantic_zero_tasks as f64 / observed.tasks as f64;

	if semantic_zero_rate > policy.max_universal_semantic_zero_rate {
		violations.push(format!(
			"universal semantic-zero rate {semantic_zero_rate:.6} exceeds {:.6}",
			policy.max_universal_semantic_zero_rate
		));
	}

	let full_credit_rate = observed.universal_full_credit_tasks as f64 / observed.tasks as f64;

	if full_credit_rate > policy.max_universal_full_credit_rate {
		violations.push(format!(
			"universal full-credit rate {full_credit_rate:.6} exceeds {:.6}",
			policy.max_universal_full_credit_rate
		));
	}
	if observed.informative_task_rate < policy.min_informative_task_rate {
		violations.push(format!(
			"informative-task rate {:.6} is below {:.6}",
			observed.informative_task_rate, policy.min_informative_task_rate
		));
	}
	if observed.non_uniform_task_rate < policy.min_non_uniform_task_rate {
		violations.push(format!(
			"non-uniform-task rate {:.6} is below {:.6}",
			observed.non_uniform_task_rate, policy.min_non_uniform_task_rate
		));
	}

	for domain in &observed.domains {
		if domain.mean_facility + CALIBRATION_COMPARISON_TOLERANCE < policy.domain_facility_min
			|| domain.mean_facility > policy.domain_facility_max + CALIBRATION_COMPARISON_TOLERANCE
			|| domain.informative_tasks == 0
			|| domain.non_uniform_tasks == 0
		{
			violations.push(format!(
				"domain {:?} is degenerate (mean facility {:.6}, informative tasks {}, non-uniform tasks {})",
				domain.domain,
				domain.mean_facility,
				domain.informative_tasks,
				domain.non_uniform_tasks
			));
		}
	}

	if observed.model_score_range + CALIBRATION_COMPARISON_TOLERANCE < policy.min_model_score_range
	{
		violations.push(format!(
			"macro-domain model-score range {:.6} is below {:.6}",
			observed.model_score_range, policy.min_model_score_range
		));
	}
	if observed.latent_score_range + CALIBRATION_COMPARISON_TOLERANCE
		< policy.min_latent_score_range
	{
		violations.push(format!(
			"latent average-item score range {:.6} is below {:.6}",
			observed.latent_score_range, policy.min_latent_score_range
		));
	}

	violations
}

fn task_bindings_match_catalog(
	tasks: &[TaskDefinition],
	catalog: FrozenCatalog,
	expected_scorer_version: &str,
) -> bool {
	let expected = catalog
		.tasks
		.into_iter()
		.map(|task| ((task.task_id.clone(), task.task_version.clone()), task))
		.collect::<BTreeMap<_, _>>();

	!tasks.is_empty()
		&& tasks.iter().all(|task| {
			expected.get(&(task.task_id.clone(), task.task_version.clone())).is_some_and(|frozen| {
				let frozen_digest = protocol::canonical_hash(frozen).ok();

				task.catalog_entry_digest.as_ref() == frozen_digest.as_ref()
					&& task.domain == frozen.domain
					&& task.difficulty == frozen.difficulty
					&& task.cluster_id.as_deref() == Some(frozen.cluster_id.as_str())
					&& task.scorer_version == expected_scorer_version
					&& task.scorer_version == frozen.evaluator.scorer_version
			})
		})
}

fn selected_model_uses_synthetic_results(
	matching: &BTreeMap<(&str, &str), Vec<&TaskResult>>,
) -> Result<bool, ScoreError> {
	let has_synthetic_results =
		matching.values().flatten().any(|result| result.provenance.synthetic);
	let has_non_synthetic_results =
		matching.values().flatten().any(|result| !result.provenance.synthetic);

	if has_synthetic_results && has_non_synthetic_results {
		return Err(ScoreError::new(
			"score inputs mix synthetic and non-synthetic result provenance",
		));
	}

	Ok(has_synthetic_results)
}

fn deserialize_difficulty_coverage<'de, D>(
	deserializer: D,
) -> Result<BTreeMap<String, DifficultyCoverage>, D::Error>
where
	D: Deserializer<'de>,
{
	let coverage = BTreeMap::<String, DifficultyCoverage>::deserialize(deserializer)?;

	if coverage.is_empty() {
		return Err(serde::de::Error::custom(
			"difficulty_coverage must contain at least one entry",
		));
	}

	if let Some(unexpected) =
		coverage.keys().find(|key| !matches!(key.as_str(), "easy" | "medium" | "hard"))
	{
		return Err(serde::de::Error::custom(format!(
			"difficulty_coverage contains unsupported key {unexpected:?}"
		)));
	}

	Ok(coverage)
}

fn capability_unavailable(result: &TaskResult) -> bool {
	result
		.failure
		.as_ref()
		.is_some_and(|failure| failure.kind == FailureKind::CapabilityUnavailable)
}

fn preflight_not_applicable_result(result: &TaskResult) -> bool {
	result.status == ResultStatus::Unsupported
		&& result.evaluation == EvaluationOutcome::NotEvaluated
		&& result.task_score.is_none()
		&& result.response.is_none()
		&& capability_unavailable(result)
}

/// Returns true only for an attributable, evaluator-scored semantic result.
///
/// A historical result can contain `task_score: 0` even when execution failed.
/// That wire value is not evidence of an incorrect answer and must never enter
/// a semantic aggregate, calibration matrix, or strict-pass denominator.
fn is_semantic_result(result: &TaskResult) -> bool {
	result.status == ResultStatus::Completed
		&& matches!(
			result.evaluation,
			EvaluationOutcome::Correct | EvaluationOutcome::Partial | EvaluationOutcome::Incorrect
		) && result.failure.is_none()
		&& result.task_score.is_some_and(|score| score.is_finite() && (0.0..=1.0).contains(&score))
}

fn classify_result(
	task: &TaskDefinition,
	result: &TaskResult,
	accumulator: &mut DomainAccumulator,
	uniform_out_of_scope: bool,
) -> Result<(), ScoreError> {
	if capability_unavailable(result) && !uniform_out_of_scope {
		accumulator.invalid += 1;

		return Ok(());
	}

	if let Some(score) = result.task_score {
		if !score.is_finite() || !(0.0..=1.0).contains(&score) {
			return Err(ScoreError::new(format!(
				"task {} has a score outside [0,1]",
				task.task_id
			)));
		}
		if uniform_out_of_scope {
			accumulator.not_applicable += 1;

			return Ok(());
		}
		if score == 0.0 && zero_failure(result) {
			accumulator.zero_failures += 1;
		}
	}

	if !is_semantic_result(result) {
		if uniform_out_of_scope {
			accumulator.not_applicable += 1;
		} else {
			accumulator.invalid += 1;
		}

		return Ok(());
	}

	let score = result.task_score.expect("is_semantic_result guarantees a semantic task score");

	accumulator.observations.push(Observation {
		score,
		cluster: task.cluster_id.clone().unwrap_or_else(|| task.task_id.clone()),
	});

	Ok(())
}

fn zero_failure(result: &TaskResult) -> bool {
	result.failure.as_ref().is_some_and(|failure| {
		matches!(
			failure.kind,
			FailureKind::Timeout
				| FailureKind::BudgetExceeded
				| FailureKind::MissingResponse
				| FailureKind::UnsupportedModel
				| FailureKind::NonZeroExit
				| FailureKind::OutputTruncated
		)
	})
}

fn coverage_summary(accumulators: &BTreeMap<Domain, DomainAccumulator>) -> CoverageSummary {
	CoverageSummary {
		expected_tasks: accumulators.values().map(|domain| domain.expected).sum(),
		valid_tasks: accumulators.values().map(|domain| domain.observations.len()).sum(),
		invalid_tasks: accumulators.values().map(|domain| domain.invalid).sum(),
		missing_tasks: accumulators.values().map(|domain| domain.missing).sum(),
		not_applicable_tasks: accumulators.values().map(|domain| domain.not_applicable).sum(),
		expected_domains: accumulators.len(),
		covered_domains: accumulators
			.values()
			.filter(|domain| !domain.observations.is_empty())
			.count(),
	}
}

fn publication_tier(
	coverage: &CoverageSummary,
	accumulators: &BTreeMap<Domain, DomainAccumulator>,
	catalog_shape_is_frozen: bool,
) -> ScoreTier {
	let all_domains = coverage.expected_domains == 10 && coverage.covered_domains == 10;

	if coverage.not_applicable_tasks == coverage.expected_tasks {
		ScoreTier::NotApplicable
	} else if catalog_shape_is_frozen && coverage.valid_tasks == 72 && all_domains {
		ScoreTier::Official
	} else if catalog_shape_is_frozen
		&& coverage.valid_tasks >= 60
		&& all_domains
		&& accumulators.values().all(|domain| domain.observations.len() >= 4)
	{
		ScoreTier::Provisional
	} else {
		ScoreTier::CoverageOnly
	}
}

fn frozen_catalog() -> Result<FrozenCatalog, serde_json::Error> {
	serde_json::from_str(include_str!("../../../benchmarks/candidates/aiq-core-1.0.6/catalog.json"))
}

fn catalog_identity_is_frozen(tasks: &[TaskDefinition]) -> bool {
	let Ok(catalog) = frozen_catalog() else {
		return false;
	};

	if catalog.task_set_id != AIQ_TASK_SET_ID
		|| catalog.task_set_version != AIQ_TASK_SET_VERSION
		|| catalog.identity_commitment.digest != AIQ_CORE_TASK_IDENTITY_SHA256
		|| catalog.tasks.len() != 72
		|| tasks.len() != catalog.tasks.len()
	{
		return false;
	}

	let expected = catalog
		.tasks
		.into_iter()
		.map(|task| ((task.task_id.clone(), task.task_version.clone()), task))
		.collect::<BTreeMap<_, _>>();

	if expected.len() != tasks.len() {
		return false;
	}

	tasks.iter().all(|task| {
		expected.get(&(task.task_id.clone(), task.task_version.clone())).is_some_and(|frozen| {
			let frozen_digest = protocol::canonical_hash(frozen).ok();

			task.catalog_entry_digest.as_ref() == frozen_digest.as_ref()
				&& task.domain == frozen.domain
				&& task.difficulty == frozen.difficulty
				&& task.cluster_id.as_deref() == Some(frozen.cluster_id.as_str())
				&& task.scorer_version == AIQ_SCORING_VERSION
				&& task.scorer_version == frozen.evaluator.scorer_version
		})
	})
}

fn completion_bounds(
	accumulators: &BTreeMap<Domain, DomainAccumulator>,
	quality_score: f64,
) -> Result<CompletionBounds, ScoreError> {
	if accumulators.len() != 10 {
		return Err(ScoreError::new("completion bounds require 10 planned domains"));
	}
	if accumulators.values().any(|domain| domain.expected == 0) {
		return Err(ScoreError::new("completion bounds require planned tasks in every domain"));
	}
	if accumulators.values().all(|domain| domain.observations.len() == domain.expected) {
		return Ok(CompletionBounds { lower: quality_score, upper: quality_score });
	}

	let mut lower = 0.0;
	let mut upper = 0.0;

	for domain in accumulators.values() {
		let planned = domain.expected as f64;
		let observed = domain.observations.len() as f64;
		let score_sum = domain.observations.iter().map(|item| item.score).sum::<f64>();

		lower += score_sum / planned;
		upper += (score_sum + planned - observed) / planned;
	}

	// The 0/1 missing-task construction contains the conditional score
	// mathematically. Clamp only a floating-point boundary crossing back to that
	// independently computed score.
	let lower = (10.0 * lower).min(quality_score);
	let upper = (10.0 * upper).max(quality_score);

	Ok(CompletionBounds { lower, upper })
}

fn difficulty_coverage(
	tasks: &[TaskDefinition],
	results: &[TaskResult],
	model: ModelConfig,
	uniform_out_of_scope: bool,
) -> BTreeMap<String, DifficultyCoverage> {
	let mut matching = BTreeMap::<(&str, &str), Vec<&TaskResult>>::new();

	for result in results.iter().filter(|result| result.model == model) {
		matching.entry((&result.task_id, &result.task_version)).or_default().push(result);
	}

	let mut coverage = BTreeMap::<String, DifficultyCoverage>::new();

	for task in tasks {
		let entry = coverage
			.entry(task.difficulty.clone())
			.or_insert(DifficultyCoverage { expected_tasks: 0, valid_tasks: 0 });

		entry.expected_tasks += 1;

		if !uniform_out_of_scope
			&& matching.get(&(task.task_id.as_str(), task.task_version.as_str())).is_some_and(
				|found| {
					matches!(
						found.as_slice(),
						[result] if is_semantic_result(result)
					)
				},
			) {
			entry.valid_tasks += 1;
		}
	}

	coverage
}

fn domain_scores(accumulators: &BTreeMap<Domain, DomainAccumulator>) -> Vec<DomainScore> {
	accumulators
		.iter()
		.map(|(domain, accumulator)| DomainScore {
			domain: *domain,
			expected_tasks: accumulator.expected,
			valid_tasks: accumulator.observations.len(),
			invalid_tasks: accumulator.invalid,
			missing_tasks: accumulator.missing,
			not_applicable_tasks: accumulator.not_applicable,
			zero_failure_tasks: accumulator.zero_failures,
			score: mean(
				&accumulator
					.observations
					.iter()
					.map(|observation| observation.score)
					.collect::<Vec<_>>(),
			),
		})
		.collect()
}

fn macro_score(accumulators: &BTreeMap<Domain, DomainAccumulator>) -> Result<f64, ScoreError> {
	let scores = accumulators
		.values()
		.map(|domain| {
			mean(
				&domain
					.observations
					.iter()
					.map(|observation| observation.score)
					.collect::<Vec<_>>(),
			)
			.ok_or_else(|| ScoreError::new("cannot publish AIQ with an uncovered domain"))
		})
		.collect::<Result<Vec<_>, _>>()?;

	mean(&scores).ok_or_else(|| ScoreError::new("cannot publish AIQ without domains"))
}

fn cluster_bootstrap(
	accumulators: &BTreeMap<Domain, DomainAccumulator>,
	options: ScoreOptions,
) -> Result<TaskResamplingSensitivityInterval, ScoreError> {
	let grouped = accumulators
		.values()
		.map(|domain| {
			let mut clusters = BTreeMap::<String, Vec<f64>>::new();

			for observation in &domain.observations {
				clusters.entry(observation.cluster.clone()).or_default().push(observation.score);
			}

			if clusters.is_empty() {
				return Err(ScoreError::new("cannot bootstrap an uncovered domain"));
			}

			Ok(clusters.into_values().collect::<Vec<_>>())
		})
		.collect::<Result<Vec<_>, _>>()?;
	let mut random = DeterministicRandom::new(options.bootstrap_seed);
	let mut samples = Vec::with_capacity(options.bootstrap_samples);

	for _ in 0..options.bootstrap_samples {
		let mut domain_means = Vec::with_capacity(grouped.len());

		for clusters in &grouped {
			let tuple_space = clusters
				.len()
				.checked_pow(
					u32::try_from(clusters.len())
						.map_err(|_| ScoreError::new("cluster tuple space is too large"))?,
				)
				.ok_or_else(|| ScoreError::new("cluster tuple space is too large"))?;
			let mut values = Vec::new();
			let mut tuple_index = random.index(tuple_space);

			for _ in 0..clusters.len() {
				let index = tuple_index % clusters.len();

				tuple_index /= clusters.len();

				values.extend_from_slice(&clusters[index]);
			}

			if let Some(value) = mean(&values) {
				domain_means.push(value);
			}
		}

		let value = mean(&domain_means)
			.ok_or_else(|| ScoreError::new("bootstrap replicate had no domains"))?;

		samples.push(value * 100.0);
	}

	samples.sort_by(f64::total_cmp);

	let last = samples.len() - 1;
	let lower_index = ((last as f64) * 0.025).floor() as usize;
	let upper_index = ((last as f64) * 0.975).ceil() as usize;
	let center = macro_score(accumulators)? * 100.0;
	let lower = (center + 1.3 * (samples[lower_index] - center)).clamp(0.0, 100.0);
	let upper = (center + 1.3 * (samples[upper_index.min(last)] - center)).clamp(0.0, 100.0);

	Ok(TaskResamplingSensitivityInterval {
		method: TASK_RESAMPLING_SENSITIVITY_METHOD.to_owned(),
		lower,
		upper,
		central_mass: 0.95,
		samples: options.bootstrap_samples,
		seed: options.bootstrap_seed,
	})
}

fn binary_micro_diagnostic(
	accumulators: &BTreeMap<Domain, DomainAccumulator>,
) -> BinaryMicroDiagnostic {
	let valid_semantic_tasks =
		accumulators.values().flat_map(|domain| &domain.observations).collect::<Vec<_>>();
	let sample_size = valid_semantic_tasks.len();
	let successes =
		valid_semantic_tasks.iter().filter(|observation| observation.score == 1.0).count();
	let (proportion, wilson_lower, wilson_upper) = if sample_size == 0 {
		(None, None, None)
	} else {
		let (lower, upper) = wilson95(successes, sample_size);

		(Some(successes as f64 / sample_size as f64), Some(lower), Some(upper))
	};

	BinaryMicroDiagnostic { sample_size, successes, proportion, wilson_lower, wilson_upper }
}

fn wilson95(successes: usize, samples: usize) -> (f64, f64) {
	const Z: f64 = 1.959_963_984_540_054;

	let samples = samples as f64;
	let probability = successes as f64 / samples;
	let z_squared = Z * Z;
	let denominator = 1.0 + z_squared / samples;
	let center = probability + z_squared / (2.0 * samples);
	let margin = Z
		* ((probability * (1.0 - probability) / samples + z_squared / (4.0 * samples * samples))
			.sqrt());

	((center - margin) / denominator, (center + margin) / denominator)
}

fn mean(values: &[f64]) -> Option<f64> {
	if values.is_empty() { None } else { Some(values.iter().sum::<f64>() / values.len() as f64) }
}

#[cfg(test)]
mod tests {
	use std::{
		collections::{BTreeMap, BTreeSet},
		mem,
	};

	use crate::{
		model::{MODEL_MATRIX, ModelConfig},
		protocol::{self, ResultProvenance, TrustTier},
		runner::{
			self, EvaluationOutcome, FailureKind, Latency, RESULT_SCHEMA_VERSION, ResultFailure,
			ResultStatus, TaskResult, ToolUsage,
		},
		scoring::{
			self, AIQ_SCORING_VERSION, SCORE_RULE, ScoreContext, ScoreOptions, ScoreTier,
			TASK_RESAMPLING_SENSITIVITY_METHOD,
		},
		task::TaskDefinition,
	};

	fn official_tasks() -> Vec<TaskDefinition> {
		let bases = runner::synthetic_tasks();

		scoring::frozen_catalog()
			.expect("checked-in catalog must deserialize")
			.tasks
			.into_iter()
			.map(|frozen| {
				let catalog_entry_digest =
					protocol::canonical_hash(&frozen).expect("catalog entry hash");
				let mut task = bases
					.iter()
					.find(|base| base.domain == frozen.domain)
					.expect("every frozen domain must have a synthetic base")
					.clone();

				task.task_id = frozen.task_id;
				task.task_version = frozen.task_version;
				task.difficulty = frozen.difficulty;
				task.scorer_version = frozen.evaluator.scorer_version;
				task.cluster_id = Some(frozen.cluster_id);
				task.catalog_entry_digest = Some(catalog_entry_digest);

				task
			})
			.collect()
	}

	fn result(task: &TaskDefinition, score: f64) -> TaskResult {
		TaskResult {
			schema_version: RESULT_SCHEMA_VERSION.to_owned(),
			result_id: "fixture".to_owned(),
			run_id: "run_fixture".to_owned(),
			task_id: task.task_id.clone(),
			task_version: task.task_version.clone(),
			task_hash: task.content_hash().expect("fixture task must hash"),
			model: MODEL_MATRIX[0],
			status: ResultStatus::Completed,
			evaluation: if score == 1.0 {
				EvaluationOutcome::Correct
			} else {
				EvaluationOutcome::Incorrect
			},
			task_score: Some(score),
			response: Some("fixture".to_owned()),
			response_sha256: None,
			evaluator_result_sha256: None,
			evaluator_stdout_sha256: None,
			artifacts: Vec::new(),
			failure: None,
			latency: Latency { wall_ms: 1 },
			tool_usage: ToolUsage::default(),
			evaluator_checks: Vec::new(),
			workspace_manifest: None,
			provenance: ResultProvenance {
				node_id: "fixture".to_owned(),
				runner_version: "fixture".to_owned(),
				codex_version: "fixture".to_owned(),
				observed_at: "fixture".to_owned(),
				synthetic: true,
				local_trust: TrustTier::Untrusted,
			},
		}
	}

	fn matrix_results(tasks: &[TaskDefinition]) -> Vec<TaskResult> {
		MODEL_MATRIX
			.into_iter()
			.enumerate()
			.flat_map(|(model_index, model)| {
				tasks.iter().map(move |task| {
					let mut result = result(task, model_index as f64 / 16.0);

					result.model = model;

					if result.task_score.is_some_and(|score| score > 0.0 && score < 1.0) {
						result.evaluation = EvaluationOutcome::Partial;
					}

					result
				})
			})
			.collect()
	}

	fn known_rasch_results(
		tasks: &[TaskDefinition],
		shift: f64,
	) -> (Vec<f64>, Vec<f64>, Vec<TaskResult>) {
		let model_locations = MODEL_MATRIX
			.iter()
			.enumerate()
			.map(|(index, _)| -1.2 + index as f64 * 0.15 + shift)
			.collect::<Vec<_>>();
		let difficulties = tasks
			.iter()
			.enumerate()
			.map(|(index, _)| (index as f64 - 35.5) * 0.025 + shift)
			.collect::<Vec<_>>();
		let results = MODEL_MATRIX
			.iter()
			.enumerate()
			.flat_map(|(model_index, model)| {
				let model_location = model_locations[model_index];
				let difficulty_values = &difficulties;

				tasks.iter().enumerate().map(move |(task_index, task)| {
					let score = super::logistic(model_location - difficulty_values[task_index]);
					let mut result = result(task, score);

					result.model = *model;
					result.evaluation = EvaluationOutcome::Partial;

					result
				})
			})
			.collect();

		(model_locations, difficulties, results)
	}

	fn calibration_matrix(results: &[TaskResult]) -> BTreeMap<(&str, ModelConfig), &TaskResult> {
		results.iter().map(|result| ((result.task_id.as_str(), result.model), result)).collect()
	}

	#[test]
	fn official_calibration_rejects_floor_and_ceiling_saturation() {
		let tasks = official_tasks();

		for score in [0.0, 1.0] {
			let mut results = matrix_results(&tasks);

			for result in &mut results {
				result.task_score = Some(score);
				result.evaluation = if score == 0.0 {
					EvaluationOutcome::Incorrect
				} else {
					EvaluationOutcome::Correct
				};
			}

			let diagnostic =
				scoring::diagnose_official_calibration(&tasks, &results).expect("complete matrix");

			assert!(!diagnostic.passed());
			assert!(diagnostic.violations.iter().any(|value| value.contains(if score == 0.0 {
				"semantic-zero"
			} else {
				"full-credit"
			})));
		}
	}

	#[test]
	fn official_calibration_universal_semantic_zero_count_boundary_is_exact() {
		let tasks = official_tasks();
		let one_per_domain = tasks
			.iter()
			.fold(BTreeMap::new(), |mut selected, task| {
				selected.entry(task.domain).or_insert_with(|| task.task_id.clone());

				selected
			})
			.into_values()
			.collect::<Vec<_>>();

		for (count, expected_pass) in [(7, true), (8, false)] {
			let selected = one_per_domain.iter().take(count).collect::<BTreeSet<_>>();
			let mut results = matrix_results(&tasks);

			for result in &mut results {
				if selected.contains(&result.task_id) {
					result.task_score = Some(0.0);
					result.evaluation = EvaluationOutcome::Incorrect;
				}
			}

			let diagnostic =
				scoring::diagnose_official_calibration(&tasks, &results).expect("matrix");

			assert_eq!(diagnostic.observed.universal_semantic_zero_tasks, count);
			assert_eq!(diagnostic.passed(), expected_pass, "{:?}", diagnostic.violations);
		}
	}

	#[test]
	fn official_calibration_rejects_runtime_zero_cells_before_fitting() {
		let tasks = official_tasks();
		let mut results = matrix_results(&tasks);
		let semantic_id = tasks[0].task_id.clone();
		let runtime_id = tasks[1].task_id.clone();
		let mixed_id = tasks[2].task_id.clone();

		for result in &mut results {
			if result.task_id == semantic_id
				|| result.task_id == runtime_id
				|| result.task_id == mixed_id
			{
				result.evaluation = EvaluationOutcome::Incorrect;
				result.task_score = Some(0.0);
			}
			if result.task_id == runtime_id
				|| result.task_id == mixed_id && result.model == MODEL_MATRIX[0]
			{
				result.status = ResultStatus::Failed;
				result.evaluation = EvaluationOutcome::NotEvaluated;
				result.response = None;
				result.failure = Some(ResultFailure {
					kind: FailureKind::Timeout,
					message: "fixture timeout".to_owned(),
					exit_code: None,
					retryable: false,
				});
			}
		}

		let error = scoring::diagnose_official_calibration(&tasks, &results)
			.expect_err("runtime-failure cells cannot enter calibration");

		assert!(error.to_string().contains("completed semantic task score"));
	}

	#[test]
	fn official_calibration_requires_informative_items_domain_coverage_and_model_spread() {
		let tasks = official_tasks();
		let mut uninformative = matrix_results(&tasks);

		for result in &mut uninformative {
			result.task_score = Some(0.95);
			result.evaluation = EvaluationOutcome::Partial;
		}

		let diagnostic = scoring::diagnose_official_calibration(&tasks, &uninformative)
			.expect("complete matrix");

		assert!(diagnostic.violations.iter().any(|value| value.contains("informative-task")));
		assert!(diagnostic.violations.iter().any(|value| value.contains("domain")));
		assert!(diagnostic.violations.iter().any(|value| value.contains("model-score range")));
	}

	#[test]
	fn official_calibration_rejects_one_degenerate_domain() {
		let tasks = official_tasks();
		let mut results = matrix_results(&tasks);
		let domain = tasks[0].domain;

		for result in &mut results {
			if tasks
				.iter()
				.find(|task| task.task_id == result.task_id)
				.is_some_and(|task| task.domain == domain)
			{
				result.task_score = Some(0.05);
				result.evaluation = EvaluationOutcome::Partial;
			}
		}

		let diagnostic = scoring::diagnose_official_calibration(&tasks, &results).expect("matrix");

		assert!(
			diagnostic.violations.iter().any(|value| value.contains(&format!("domain {domain:?}")))
		);
	}

	#[test]
	fn official_calibration_rejects_inadequate_model_spread() {
		let tasks = official_tasks();
		let mut results = matrix_results(&tasks);

		for result in &mut results {
			result.task_score = Some(0.5);
			result.evaluation = EvaluationOutcome::Partial;
		}

		let diagnostic = scoring::diagnose_official_calibration(&tasks, &results).expect("matrix");

		assert_eq!(diagnostic.observed.model_score_range, 0.0);
		assert_eq!(diagnostic.observed.informative_tasks, 0);
		assert_eq!(diagnostic.observed.non_uniform_tasks, 0);
		assert!(diagnostic.violations.iter().any(|value| value.contains("non-uniform-task")));
		assert!(diagnostic.violations.iter().any(|value| value.contains("model-score range")));
	}

	#[test]
	fn complete_non_synthetic_matrix_without_calibration_gate_is_coverage_only() {
		let tasks = official_tasks();
		let mut results = matrix_results(&tasks);

		for result in &mut results {
			result.provenance.synthetic = false;
			result.task_score = Some(0.5);
			result.evaluation = EvaluationOutcome::Partial;
		}

		let report = scoring::score_model_with_options(
			&tasks,
			&results,
			MODEL_MATRIX[0],
			ScoreOptions { bootstrap_samples: 10, bootstrap_seed: 1 },
		)
		.expect("a failed calibration gate must still produce a coverage report");

		assert_eq!(report.tier, ScoreTier::CoverageOnly);
		assert!(report.score.is_none());
		assert!(report.quality_score.is_none());
		assert_eq!(report.coverage.valid_tasks, 72);
	}

	#[test]
	fn runtime_null_in_full_matrix_is_reportable_without_official_latent_or_ranking() {
		let tasks = official_tasks();
		let mut results = matrix_results(&tasks);

		for result in &mut results {
			result.provenance.synthetic = false;
		}

		let runtime = results
			.iter_mut()
			.find(|result| result.model == MODEL_MATRIX[0] && result.task_id == tasks[0].task_id)
			.expect("full matrix must contain the selected cell");

		runtime.status = ResultStatus::Failed;
		runtime.evaluation = EvaluationOutcome::NotEvaluated;
		runtime.task_score = None;
		runtime.response = None;
		runtime.failure = Some(ResultFailure {
			kind: FailureKind::Timeout,
			message: "fixture runtime timeout".to_owned(),
			exit_code: None,
			retryable: true,
		});

		let reports = MODEL_MATRIX
			.iter()
			.map(|model| {
				scoring::score_calibration_model_with_context(
					&tasks,
					&results,
					*model,
					ScoreContext::default(),
					ScoreOptions { bootstrap_samples: 10, bootstrap_seed: 1 },
				)
			})
			.collect::<Result<Vec<_>, _>>()
			.expect("incomplete calibration matrix must remain reportable");

		assert_eq!(reports.len(), MODEL_MATRIX.len());
		assert_eq!(reports[0].coverage.valid_tasks, 71);
		assert_eq!(reports[0].coverage.invalid_tasks, 1);
		assert_eq!(reports[0].coverage.missing_tasks, 0);
		assert_eq!(
			reports[0].domains.iter().map(|domain| domain.zero_failure_tasks).sum::<usize>(),
			0
		);

		for report in &reports {
			assert_eq!(report.official_eligible, scoring::FalseOnly);
			assert_eq!(report.ranking_eligible, scoring::FalseOnly);
			assert!(report.latent_ability.is_none());
			assert!(!matches!(
				report.descriptive_status,
				scoring::CalibrationDescriptiveStatus::CompleteFixture
			));
		}

		let serialized = serde_json::to_value(&reports).expect("diagnostic reports serialize");

		assert_eq!(serialized.as_array().map(Vec::len), Some(MODEL_MATRIX.len()));
		assert!(serialized.to_string().contains("coverage_only"));
	}

	#[test]
	fn semantic_duplicate_or_unexpected_matrix_cells_still_fail_closed() {
		let tasks = official_tasks();
		let mut duplicate_results = matrix_results(&tasks);

		for result in &mut duplicate_results {
			result.provenance.synthetic = false;
		}

		duplicate_results[1] = duplicate_results[0].clone();

		let duplicate_error = scoring::score_model_with_options(
			&tasks,
			&duplicate_results,
			MODEL_MATRIX[1],
			ScoreOptions { bootstrap_samples: 10, bootstrap_seed: 1 },
		)
		.expect_err("semantic duplicate matrix cells must remain an error");

		assert!(duplicate_error.to_string().contains("duplicate"));

		let mut unexpected_results = matrix_results(&tasks);

		for result in &mut unexpected_results {
			result.provenance.synthetic = false;
		}

		unexpected_results[0].task_id = "unexpected-task".to_owned();

		let unexpected_error = scoring::score_model_with_options(
			&tasks,
			&unexpected_results,
			MODEL_MATRIX[1],
			ScoreOptions { bootstrap_samples: 10, bootstrap_seed: 1 },
		)
		.expect_err("semantic unexpected matrix cells must remain an error");

		assert!(unexpected_error.to_string().contains("unexpected task or model"));
	}

	#[test]
	fn official_calibration_is_deterministic_and_includes_exact_boundaries() {
		let tasks = official_tasks();
		let mut results = matrix_results(&tasks);
		let low_id = tasks[0].task_id.clone();
		let high_id = tasks[1].task_id.clone();

		for result in &mut results {
			if result.task_id == low_id {
				result.task_score = Some(0.10);
			} else if result.task_id == high_id {
				result.task_score = Some(0.90);
			}
			if result.task_score.is_some_and(|score| score > 0.0 && score < 1.0) {
				result.evaluation = EvaluationOutcome::Partial;
			}
		}

		let first = scoring::diagnose_official_calibration(&tasks, &results).expect("matrix");
		let second = scoring::diagnose_official_calibration(&tasks, &results).expect("matrix");

		assert_eq!(first, second);
		assert!(first.passed(), "{:?}", first.violations);
		assert_eq!(first.observed.informative_tasks, 70);

		for result in &mut results {
			let score = if result.model == MODEL_MATRIX[0] {
				0.45
			} else if result.model == MODEL_MATRIX[16] {
				0.55
			} else {
				0.5
			};

			result.task_score = Some(score);
			result.evaluation = EvaluationOutcome::Partial;
		}

		let exact_task_range =
			scoring::diagnose_official_calibration(&tasks, &results).expect("boundary matrix");

		assert!(exact_task_range.passed(), "{:?}", exact_task_range.violations);
		assert_eq!(exact_task_range.observed.informative_tasks, 72);

		for result in &mut results {
			result.task_score = Some(if result.model == MODEL_MATRIX[0] {
				0.485
			} else if result.model == MODEL_MATRIX[16] {
				0.515
			} else {
				0.5
			});
		}

		let exact_spread =
			scoring::diagnose_official_calibration(&tasks, &results).expect("boundary matrix");

		assert!(
			(exact_spread.observed.model_score_range
				- scoring::OFFICIAL_CALIBRATION_MIN_MODEL_SCORE_RANGE)
				.abs() < 1e-10
		);
		assert!(!exact_spread.violations.iter().any(|value| value.contains("model-score range")));
	}

	#[test]
	fn official_calibration_rejects_duplicates_and_incomplete_cells() {
		let tasks = official_tasks();
		let mut duplicate = matrix_results(&tasks);

		duplicate.push(duplicate[0].clone());

		assert!(
			scoring::diagnose_official_calibration(&tasks, &duplicate)
				.expect_err("duplicate")
				.to_string()
				.contains("duplicate")
		);

		let mut incomplete = matrix_results(&tasks);

		incomplete.pop();

		assert!(
			scoring::diagnose_official_calibration(&tasks, &incomplete)
				.expect_err("incomplete")
				.to_string()
				.contains("complete model-task matrix")
		);
	}

	#[test]
	fn synthetic_complete_macro_and_cluster_bootstrap_are_deterministic() {
		let tasks = official_tasks();
		let results = tasks
			.iter()
			.map(|task| {
				let index = task
					.task_id
					.rsplit('-')
					.next()
					.and_then(|value| value.parse::<usize>().ok())
					.expect("fixture identifier must end in an index");

				result(task, if index % 2 == 1 { 1.0 } else { 0.0 })
			})
			.collect::<Vec<_>>();
		let options = ScoreOptions { bootstrap_samples: 2_000, bootstrap_seed: 42 };
		let first = scoring::score_model_with_options(&tasks, &results, MODEL_MATRIX[0], options)
			.expect("fixture must score");
		let second = scoring::score_model_with_options(&tasks, &results, MODEL_MATRIX[0], options)
			.expect("fixture must score");

		assert_eq!(first, second);
		assert_eq!(first.scoring_version, AIQ_SCORING_VERSION);
		assert_eq!(first.tier, ScoreTier::SyntheticComplete);
		assert_eq!(first.coverage.valid_tasks, 72);
		assert_eq!(first.coverage.covered_domains, 10);
		assert!(first.score.is_none());
		assert!(
			(first.quality_score.expect("synthetic descriptive score") - 54.285_714_285_714_285)
				.abs() < 1e-10
		);
		assert_eq!(first.binary_micro_diagnostic.successes, 39);
		assert!(
			(first.binary_micro_diagnostic.proportion.expect("micro diagnostic")
				- 0.541_666_666_666_666_6)
				.abs() < 1e-10
		);
		assert!(!first.ranking_eligible);

		let interval =
			first.task_resampling_sensitivity_interval.expect("synthetic descriptive interval");

		assert_eq!(interval.lower, 44.071_428_571_428_57);
		assert_eq!(interval.upper, 66.078_571_428_571_42);
		assert_eq!(interval.method, TASK_RESAMPLING_SENSITIVITY_METHOD);
		assert_eq!(first.rule, SCORE_RULE);
	}

	#[test]
	fn interval_public_contract_discloses_calibrated_fixed_fixture_scope() {
		assert_eq!(
			TASK_RESAMPLING_SENSITIVITY_METHOD,
			"finite_cluster_calibrated_percentile_sensitivity_v1"
		);

		for rule in [SCORE_RULE, super::CALIBRATION_SCORE_RULE] {
			assert!(rule.contains("versioned 1.3 deviation correction"));
			assert!(rule.contains("fixed-fixture calibrated sensitivity interval"));
			assert!(rule.contains("not a universal confidence interval"));
		}
	}

	#[test]
	fn calibrated_bootstrap_prng_matches_the_cross_language_vectors() {
		let mut random = super::DeterministicRandom::new(0x0000_4149_515f_5631);

		assert_eq!(
			(0..8).map(|_| random.next_u64()).collect::<Vec<_>>(),
			[
				0x4509_64d8_b5a1_ecc9,
				0x1416_7b57_1347_af76,
				0xfee6_3dc1_9eed_fdb1,
				0x68d2_9489_7d20_65ec,
				0x85a6_560c_7470_fe30,
				0xb8df_b341_112b_9cb3,
				0x0bec_27ee_2885_1764,
				0x2b2a_7a57_f60b_50bf,
			]
		);

		let mut random = super::DeterministicRandom::new(0x0000_4149_515f_5631);

		assert_eq!(
			[27, 256, 27, 256, 27, 256, 27, 256]
				.into_iter()
				.map(|bound| random.index(bound))
				.collect::<Vec<_>>(),
			[18, 118, 6, 236, 9, 179, 22, 191]
		);
	}

	#[test]
	fn unrelated_task_set_cannot_be_official_or_provisional() {
		let mut tasks = official_tasks();

		tasks[0].task_id = "unrelated-01".to_owned();

		let results = tasks.iter().map(|task| result(task, 1.0)).collect::<Vec<_>>();
		let report = scoring::score_model_with_options(
			&tasks,
			&results,
			MODEL_MATRIX[0],
			ScoreOptions { bootstrap_samples: 10, bootstrap_seed: 1 },
		)
		.expect("coverage remains reportable");

		assert_eq!(report.tier, ScoreTier::CoverageOnly);
		assert!(report.quality_score.is_none());
	}

	#[test]
	fn score_report_wire_objects_reject_unknown_fields() {
		let tasks = official_tasks();
		let results = tasks.iter().map(|task| result(task, 1.0)).collect::<Vec<_>>();
		let report = scoring::score_model_with_options(
			&tasks,
			&results,
			MODEL_MATRIX[0],
			ScoreOptions { bootstrap_samples: 10, bootstrap_seed: 1 },
		)
		.expect("official score fixture");
		let value = serde_json::to_value(&report).expect("score report serialization");

		serde_json::from_value::<scoring::ScoreReport>(value.clone())
			.expect("valid score report must deserialize");

		for (label, pointer) in [
			("score report", ""),
			("completion bounds", "/completion_bounds"),
			("task resampling sensitivity interval", "/task_resampling_sensitivity_interval"),
			("binary micro diagnostic", "/binary_micro_diagnostic"),
			("coverage summary", "/coverage"),
			("difficulty coverage", "/difficulty_coverage/easy"),
			("domain score", "/domains/0"),
		] {
			let mut changed = value.clone();

			changed
				.pointer_mut(pointer)
				.and_then(serde_json::Value::as_object_mut)
				.unwrap_or_else(|| panic!("{label} fixture must be an object"))
				.insert("unexpected".to_owned(), serde_json::Value::Bool(true));

			assert!(
				serde_json::from_value::<scoring::ScoreReport>(changed).is_err(),
				"{label} must reject unknown fields"
			);
		}

		let mut extra_difficulty = value.clone();
		let difficulty = extra_difficulty
			.pointer_mut("/difficulty_coverage")
			.and_then(serde_json::Value::as_object_mut)
			.expect("difficulty coverage fixture must be an object");
		let example = difficulty.get("easy").cloned().expect("easy difficulty coverage fixture");

		difficulty.insert("unexpected".to_owned(), example);

		assert!(
			serde_json::from_value::<scoring::ScoreReport>(extra_difficulty).is_err(),
			"difficulty coverage map must reject unknown keys"
		);

		let mut empty_difficulty = value;

		empty_difficulty
			.pointer_mut("/difficulty_coverage")
			.and_then(serde_json::Value::as_object_mut)
			.expect("difficulty coverage fixture must be an object")
			.clear();

		assert!(
			serde_json::from_value::<scoring::ScoreReport>(empty_difficulty).is_err(),
			"difficulty coverage map must reject an empty object"
		);
	}

	#[test]
	fn partial_calibration_emits_only_explicit_descriptive_analysis() {
		let tasks = official_tasks().into_iter().take(8).collect::<Vec<_>>();
		let results = tasks.iter().map(|task| result(task, 1.0)).collect::<Vec<_>>();
		let analysis = scoring::score_calibration_model_with_context(
			&tasks,
			&results,
			MODEL_MATRIX[0],
			ScoreContext::default(),
			ScoreOptions { bootstrap_samples: 10, bootstrap_seed: 1 },
		)
		.expect("partial calibration must remain analyzable");
		let serialized =
			serde_json::to_string(&analysis).expect("calibration analysis must serialize");

		assert_eq!(analysis.schema_version, "aiq.calibration-score-report.v2");
		assert_eq!(analysis.run_class, "calibration");
		assert_eq!(
			analysis.descriptive_status,
			scoring::CalibrationDescriptiveStatus::CoverageOnly
		);
		assert_eq!(analysis.official_eligible, scoring::FalseOnly);
		assert_eq!(analysis.ranking_eligible, scoring::FalseOnly);
		assert_eq!(analysis.coverage.expected_tasks, 8);
		assert_eq!(analysis.coverage.valid_tasks, 8);
		assert!(analysis.quality_score.is_none());
		assert!(!serialized.contains("\"tier\""));
		assert!(!serialized.contains("Official"));
		assert!(!serialized.contains("Provisional"));
	}

	#[test]
	fn calibration_eligibility_is_structurally_false_only_on_the_wire() {
		assert_eq!(mem::size_of::<scoring::FalseOnly>(), 0);
		assert_eq!(
			serde_json::to_value(scoring::FalseOnly).expect("false-only serialization"),
			serde_json::json!(false)
		);
		assert_eq!(
			serde_json::from_value::<scoring::FalseOnly>(serde_json::json!(false))
				.expect("false-only deserialization"),
			scoring::FalseOnly
		);
		assert!(serde_json::from_value::<scoring::FalseOnly>(serde_json::json!(true)).is_err());

		for invalid in [
			serde_json::Value::Null,
			serde_json::json!(0),
			serde_json::json!("false"),
			serde_json::json!([]),
			serde_json::json!({}),
		] {
			assert!(serde_json::from_value::<scoring::FalseOnly>(invalid).is_err());
		}

		let tasks = official_tasks().into_iter().take(8).collect::<Vec<_>>();
		let results = tasks.iter().map(|task| result(task, 1.0)).collect::<Vec<_>>();
		let analysis = scoring::score_calibration_model_with_context(
			&tasks,
			&results,
			MODEL_MATRIX[0],
			ScoreContext::default(),
			ScoreOptions { bootstrap_samples: 10, bootstrap_seed: 1 },
		)
		.expect("calibration fixture");
		let mut value = serde_json::to_value(&analysis).expect("calibration serialization");

		assert_eq!(value["official_eligible"], false);
		assert_eq!(value["ranking_eligible"], false);

		value["official_eligible"] = serde_json::json!(true);

		assert!(serde_json::from_value::<scoring::CalibrationScoreReport>(value.clone()).is_err());

		value["official_eligible"] = serde_json::json!(false);
		value["ranking_eligible"] = serde_json::json!(true);

		assert!(serde_json::from_value::<scoring::CalibrationScoreReport>(value).is_err());
	}

	#[test]
	fn calibration_conditional_analysis_is_direct_and_ineligible() {
		let tasks = official_tasks();
		let mut seen = std::collections::BTreeMap::new();
		let results = tasks
			.iter()
			.filter_map(|task| {
				let count = seen.entry(task.domain).or_insert(0_usize);

				if *count >= 6 {
					return None;
				}

				let score = if *count % 2 == 0 { 1.0 } else { 0.0 };

				*count += 1;

				Some(result(task, score))
			})
			.collect::<Vec<_>>();
		let analysis = scoring::score_calibration_model_with_context(
			&tasks,
			&results,
			MODEL_MATRIX[0],
			ScoreContext::default(),
			ScoreOptions { bootstrap_samples: 100, bootstrap_seed: 7 },
		)
		.expect("conditional calibration analysis");

		assert_eq!(
			analysis.descriptive_status,
			scoring::CalibrationDescriptiveStatus::ConditionalObserved
		);
		assert_eq!(analysis.official_eligible, scoring::FalseOnly);
		assert_eq!(analysis.ranking_eligible, scoring::FalseOnly);
		assert_eq!(analysis.quality_score, Some(50.0));
		assert!(analysis.completion_bounds.is_some());
		assert!(analysis.task_resampling_sensitivity_interval.is_some());
	}

	#[test]
	fn calibration_not_applicable_analysis_is_direct_and_ineligible() {
		let tasks = official_tasks();
		let results = tasks
			.iter()
			.map(|task| {
				let mut unavailable = result(task, 0.0);

				unavailable.status = ResultStatus::Unsupported;
				unavailable.evaluation = EvaluationOutcome::NotEvaluated;
				unavailable.task_score = None;
				unavailable.response = None;
				unavailable.failure = Some(ResultFailure {
					kind: FailureKind::CapabilityUnavailable,
					message: "pre-run capability claim".to_owned(),
					exit_code: None,
					retryable: false,
				});

				unavailable
			})
			.collect::<Vec<_>>();
		let analysis = scoring::score_calibration_model_with_context(
			&tasks,
			&results,
			MODEL_MATRIX[0],
			ScoreContext {
				preflight_configuration_not_applicable: true,
				receiver_authorized_publication: false,
			},
			ScoreOptions { bootstrap_samples: 10, bootstrap_seed: 1 },
		)
		.expect("not-applicable calibration analysis");

		assert_eq!(
			analysis.descriptive_status,
			scoring::CalibrationDescriptiveStatus::NotApplicable
		);
		assert_eq!(analysis.official_eligible, scoring::FalseOnly);
		assert_eq!(analysis.ranking_eligible, scoring::FalseOnly);
		assert!(analysis.quality_score.is_none());
		assert!(analysis.completion_bounds.is_none());
		assert!(analysis.task_resampling_sensitivity_interval.is_none());
		assert_eq!(analysis.coverage.not_applicable_tasks, 72);
	}

	#[test]
	fn mismatched_task_scorer_version_cannot_be_official() {
		let mut tasks = official_tasks();

		tasks[0].scorer_version = "1.0.2".to_owned();

		let results = tasks.iter().map(|task| result(task, 1.0)).collect::<Vec<_>>();
		let report = scoring::score_model_with_options(
			&tasks,
			&results,
			MODEL_MATRIX[0],
			ScoreOptions { bootstrap_samples: 10, bootstrap_seed: 1 },
		)
		.expect("coverage remains reportable");

		assert_eq!(report.tier, ScoreTier::CoverageOnly);
	}

	#[test]
	fn missing_catalog_entry_commitment_cannot_be_official() {
		let mut tasks = official_tasks();

		tasks[0].catalog_entry_digest = None;

		let results = tasks.iter().map(|task| result(task, 1.0)).collect::<Vec<_>>();
		let report = scoring::score_model_with_options(
			&tasks,
			&results,
			MODEL_MATRIX[0],
			ScoreOptions { bootstrap_samples: 10, bootstrap_seed: 1 },
		)
		.expect("coverage remains reportable");

		assert_eq!(report.tier, ScoreTier::CoverageOnly);
	}

	#[test]
	fn mutated_catalog_entry_commitment_cannot_be_official() {
		let mut tasks = official_tasks();

		tasks[0].catalog_entry_digest = Some(format!("sha256:{}", "0".repeat(64)));

		let results = tasks.iter().map(|task| result(task, 1.0)).collect::<Vec<_>>();
		let report = scoring::score_model_with_options(
			&tasks,
			&results,
			MODEL_MATRIX[0],
			ScoreOptions { bootstrap_samples: 10, bootstrap_seed: 1 },
		)
		.expect("coverage remains reportable");

		assert_eq!(report.tier, ScoreTier::CoverageOnly);
	}

	#[test]
	fn ranking_requires_receiver_authorization_and_trusted_non_synthetic_results() {
		let tasks = official_tasks();
		let mut results = matrix_results(&tasks);

		for result in &mut results {
			result.provenance.local_trust = TrustTier::Trusted;
		}

		let context = ScoreContext {
			preflight_configuration_not_applicable: false,
			receiver_authorized_publication: true,
		};
		let synthetic = scoring::score_model_with_context(
			&tasks,
			&results,
			MODEL_MATRIX[0],
			context,
			ScoreOptions { bootstrap_samples: 10, bootstrap_seed: 1 },
		)
		.expect("synthetic fixture must remain mathematically scoreable");

		assert_eq!(synthetic.tier, ScoreTier::SyntheticComplete);
		assert!(synthetic.score.is_none());
		assert_eq!(synthetic.quality_score, Some(0.0));
		assert!(!synthetic.ranking_eligible);
		assert_eq!(
			serde_json::to_value(&synthetic).expect("synthetic report serialization")["tier"],
			"synthetic_complete"
		);

		let mut mixed = results.clone();

		mixed[0].provenance.synthetic = false;

		let error = scoring::score_model_with_context(
			&tasks,
			&mixed,
			MODEL_MATRIX[0],
			context,
			ScoreOptions { bootstrap_samples: 10, bootstrap_seed: 1 },
		)
		.expect_err("mixed synthetic provenance must fail closed");

		assert_eq!(
			error.to_string(),
			"score inputs mix synthetic and non-synthetic result provenance"
		);

		for result in &mut results {
			result.provenance.synthetic = false;
		}

		let report = scoring::score_model_with_context(
			&tasks,
			&results,
			MODEL_MATRIX[0],
			context,
			ScoreOptions { bootstrap_samples: 10, bootstrap_seed: 1 },
		)
		.expect("trusted authorized fixture must score");

		assert_eq!(report.tier, ScoreTier::Official);
		assert!(report.score.is_some());
		assert!(report.latent_ability.is_some());
		assert!(report.ranking_eligible);
	}

	#[test]
	fn latent_ability_is_deterministic_separated_and_reports_uncertainty() {
		let tasks = official_tasks();
		let results = matrix_results(&tasks);
		let (matrix, _) = scoring::calibration_matrix(
			&tasks,
			&results,
			&scoring::OfficialCalibrationPolicy::default(),
		)
		.expect("complete calibration matrix");
		let bank =
			scoring::calibration_bank_from_matrix(&tasks, &matrix).expect("calibration bank");
		let low = scoring::estimate_model_ability(&tasks, &matrix, MODEL_MATRIX[0], &bank)
			.expect("low model estimate");
		let high = scoring::estimate_model_ability(&tasks, &matrix, MODEL_MATRIX[16], &bank)
			.expect("high model estimate");

		assert_eq!(low.calibration_digest, high.calibration_digest);
		assert_eq!(low.items_used, 72);
		assert_eq!(low.calibration_task_count, 72);
		assert_eq!(low.calibration_model_count, 17);
		assert_eq!(low.reliability_status, "single_matrix_information_only");
		assert!(high.theta > low.theta);
		assert!(high.score > low.score);
		assert!(low.standard_error.is_finite() && low.standard_error > 0.0);
		assert!(low.theta_ci_low < low.theta_ci_high);
		assert!(low.score_ci_low < low.score_ci_high);
		assert!(low.score_ci_low <= low.score && low.score <= low.score_ci_high);
	}

	#[test]
	fn zero_bootstrap_seed_is_rejected_instead_of_misreported() {
		let tasks = official_tasks();
		let results = tasks.iter().map(|task| result(task, 1.0)).collect::<Vec<_>>();
		let error = scoring::score_model_with_options(
			&tasks,
			&results,
			MODEL_MATRIX[0],
			ScoreOptions { bootstrap_samples: 10, bootstrap_seed: 0 },
		)
		.expect_err("zero seed must be rejected");

		assert_eq!(error.to_string(), "bootstrap_seed must be greater than zero");
	}

	#[test]
	fn partial_results_publish_only_coverage_below_provisional_threshold() {
		let tasks = official_tasks();
		let results = tasks.iter().take(59).map(|task| result(task, 1.0)).collect::<Vec<_>>();
		let report = scoring::score_model_with_options(
			&tasks,
			&results,
			MODEL_MATRIX[0],
			ScoreOptions { bootstrap_samples: 10, bootstrap_seed: 1 },
		)
		.expect("coverage must report");

		assert_eq!(report.tier, ScoreTier::CoverageOnly);
		assert_eq!(report.coverage.valid_tasks, 59);
		assert!(report.score.is_none());
		assert!(report.quality_score.is_none());
		assert!(report.task_resampling_sensitivity_interval.is_none());
	}

	#[test]
	fn provisional_estimate_is_conditional_and_has_completion_bounds() {
		let tasks = official_tasks();
		let mut seen = std::collections::BTreeMap::new();
		let results = tasks
			.iter()
			.filter_map(|task| {
				let count = seen.entry(task.domain).or_insert(0_usize);

				if *count >= 6 {
					return None;
				}

				let score = if *count % 2 == 0 { 1.0 } else { 0.0 };

				*count += 1;

				Some(result(task, score))
			})
			.collect::<Vec<_>>();
		let report = scoring::score_model_with_options(
			&tasks,
			&results,
			MODEL_MATRIX[0],
			ScoreOptions { bootstrap_samples: 100, bootstrap_seed: 7 },
		)
		.expect("provisional fixture must score");

		assert_eq!(report.tier, ScoreTier::Provisional);
		assert!(!report.ranking_eligible);
		assert!(report.score.is_none());
		assert_eq!(report.quality_score, Some(50.0));

		let bounds = report.completion_bounds.expect("provisional completion bounds");

		assert!((bounds.lower - 41.964_285_714_285_715).abs() < 1e-10);
		assert!((bounds.upper - 58.035_714_285_714_285).abs() < 1e-10);
	}

	#[test]
	fn provisional_completion_bounds_contain_conditional_aiq_at_float_boundaries() {
		let tasks = official_tasks();
		let incomplete_domains = tasks
			.iter()
			.map(|task| task.domain)
			.collect::<std::collections::BTreeSet<_>>()
			.into_iter()
			.take(2)
			.collect::<std::collections::BTreeSet<_>>();

		for boundary_score in [0.0, 1.0] {
			let mut omitted_domains = std::collections::BTreeSet::new();
			let interior_scores = if boundary_score == 0.0 {
				[0.524_270_278, 0.953_256_301, 0.959_894_504, 0.463_890_471]
			} else {
				[0.927_463_856, 0.448_971_087, 0.302_988_898, 0.369_582_169]
			};
			let results = tasks
				.iter()
				.enumerate()
				.filter_map(|(index, task)| {
					if incomplete_domains.contains(&task.domain)
						&& omitted_domains.insert(task.domain)
					{
						return None;
					}

					let score = if incomplete_domains.contains(&task.domain) {
						boundary_score
					} else {
						interior_scores[index % interior_scores.len()]
					};

					Some(result(task, score))
				})
				.collect::<Vec<_>>();
			let report = scoring::score_model_with_options(
				&tasks,
				&results,
				MODEL_MATRIX[0],
				ScoreOptions { bootstrap_samples: 10, bootstrap_seed: 1 },
			)
			.expect("provisional fixture must score");
			let aiq = report.quality_score.expect("conditional AIQ");
			let bounds = report.completion_bounds.expect("provisional completion bounds");

			assert_eq!(report.tier, ScoreTier::Provisional);
			assert!(bounds.lower <= aiq, "lower bound must contain {aiq}");
			assert!(aiq <= bounds.upper, "upper bound must contain {aiq}");

			if boundary_score == 0.0 {
				assert_eq!(bounds.lower, aiq);
			} else {
				assert_eq!(bounds.upper, aiq);
			}
		}
	}

	#[test]
	fn complete_fixture_completion_bounds_preserve_aiq_and_order() {
		let tasks = official_tasks();
		let score_patterns: &[&[f64]] = &[
			&[0.001],
			&[0.1, 0.2, 0.3],
			&[0.123_456_789, 0.987_654_321, 0.333_333_333, 0.777_777_777],
		];

		for pattern in score_patterns {
			let results = tasks
				.iter()
				.enumerate()
				.map(|(index, task)| result(task, pattern[index % pattern.len()]))
				.collect::<Vec<_>>();
			let report = scoring::score_model_with_options(
				&tasks,
				&results,
				MODEL_MATRIX[0],
				ScoreOptions { bootstrap_samples: 10, bootstrap_seed: 1 },
			)
			.expect("complete fixture must score");
			let aiq = report.quality_score.expect("complete fixture AIQ");
			let bounds = report.completion_bounds.expect("complete fixture completion bounds");

			assert_eq!(report.tier, ScoreTier::SyntheticComplete);
			assert_eq!(report.scoring_version, AIQ_SCORING_VERSION);
			assert_eq!(bounds.lower, aiq, "lower bound for pattern {pattern:?}");
			assert_eq!(bounds.upper, aiq, "upper bound for pattern {pattern:?}");
			assert!(bounds.lower <= bounds.upper);
		}
	}

	#[test]
	fn binary_wilson_is_diagnostic_only() {
		let tasks = official_tasks();
		let results = tasks.iter().map(|task| result(task, 1.0)).collect::<Vec<_>>();
		let report = scoring::score_model_with_options(
			&tasks,
			&results,
			MODEL_MATRIX[0],
			ScoreOptions { bootstrap_samples: 10, bootstrap_seed: 1 },
		)
		.expect("fixture must score");

		assert_eq!(report.binary_micro_diagnostic.sample_size, 72);
		assert_eq!(
			report.task_resampling_sensitivity_interval.as_ref().expect("main interval").method,
			TASK_RESAMPLING_SENSITIVITY_METHOD
		);
	}

	#[test]
	fn strict_pass_denominator_includes_partial_semantic_scores() {
		let tasks = official_tasks();
		let results = tasks
			.iter()
			.enumerate()
			.map(|(index, task)| {
				let score = if index < 10 {
					1.0
				} else if index < 60 {
					0.5
				} else {
					0.0
				};

				result(task, score)
			})
			.collect::<Vec<_>>();
		let report = scoring::score_model_with_options(
			&tasks,
			&results,
			MODEL_MATRIX[0],
			ScoreOptions { bootstrap_samples: 10, bootstrap_seed: 1 },
		)
		.expect("fixture must score");

		assert_eq!(report.binary_micro_diagnostic.sample_size, 72);
		assert_eq!(report.binary_micro_diagnostic.successes, 10);
		assert_eq!(report.binary_micro_diagnostic.proportion, Some(10.0 / 72.0));
		assert!(report.binary_micro_diagnostic.wilson_lower.unwrap() < 10.0 / 72.0);
		assert!(report.binary_micro_diagnostic.wilson_upper.unwrap() > 10.0 / 72.0);
	}

	#[test]
	fn joint_rasch_recovers_known_item_order_and_model_order_deterministically() {
		let tasks = official_tasks();
		let (_known_locations, known_difficulties, results) = known_rasch_results(&tasks, 0.0);
		let matrix = calibration_matrix(&results);
		let first =
			super::calibration_bank_from_matrix(&tasks, &matrix).expect("bank must converge");
		let second =
			super::calibration_bank_from_matrix(&tasks, &matrix).expect("bank must converge");

		assert_eq!(first.digest, second.digest);

		for task in &tasks {
			let first_item = first.items.get(&task.task_id).expect("first item");
			let second_item = second.items.get(&task.task_id).expect("second item");

			assert_eq!(first_item.difficulty, second_item.difficulty);
		}

		let max_difficulty_error = tasks
			.iter()
			.enumerate()
			.map(|(index, task)| {
				(first.items.get(&task.task_id).expect("item").difficulty
					- known_difficulties[index])
					.abs()
			})
			.fold(0.0, f64::max);

		assert!(max_difficulty_error < 0.08, "max item error: {max_difficulty_error}");

		let estimates = MODEL_MATRIX
			.iter()
			.map(|model| {
				super::estimate_model_ability(&tasks, &matrix, *model, &first)
					.expect("known model must estimate")
			})
			.collect::<Vec<_>>();

		assert!(estimates.windows(2).all(|window| window[0].theta < window[1].theta));
		assert!(estimates.iter().all(|estimate| {
			estimate.theta.is_finite()
				&& estimate.standard_error.is_finite()
				&& estimate.score.is_finite()
		}));
	}

	#[test]
	fn joint_rasch_is_invariant_to_common_parameter_translation() {
		let tasks = official_tasks();
		let (_, _, base_results) = known_rasch_results(&tasks, 0.0);
		let (_, _, shifted_results) = known_rasch_results(&tasks, 3.25);
		let base = super::calibration_bank_from_matrix(&tasks, &calibration_matrix(&base_results))
			.expect("base bank must converge");
		let shifted =
			super::calibration_bank_from_matrix(&tasks, &calibration_matrix(&shifted_results))
				.expect("shifted bank must converge");

		for task in &tasks {
			let base_item = base.items.get(&task.task_id).expect("base item");
			let shifted_item = shifted.items.get(&task.task_id).expect("shifted item");

			assert!((base_item.difficulty - shifted_item.difficulty).abs() < 1e-10);
		}
	}

	#[test]
	fn joint_rasch_rejects_a_nonconverged_iteration_limit() {
		let tasks = official_tasks();
		let (_, _, results) = known_rasch_results(&tasks, 0.0);
		let matrix = calibration_matrix(&results);
		let error = super::fit_joint_rasch_parameters_with_limit(&tasks, &matrix, 1)
			.expect_err("one outer iteration must not be publishable");

		assert!(error.to_string().contains("did not converge"));
	}

	#[test]
	fn conditional_map_is_finite_and_prior_shrinks_extreme_responses() {
		let tasks = official_tasks();
		let (_, _, baseline_results) = known_rasch_results(&tasks, 0.0);
		let baseline_matrix = calibration_matrix(&baseline_results);
		let bank = super::calibration_bank_from_matrix(&tasks, &baseline_matrix)
			.expect("baseline bank must converge");

		for (extreme_score, expected_sign) in [(0.0, -1.0), (1.0, 1.0)] {
			let mut results = baseline_results.clone();

			for result in &mut results {
				if result.model == MODEL_MATRIX[0] {
					result.task_score = Some(extreme_score);
					result.evaluation = if extreme_score == 0.0 {
						EvaluationOutcome::Incorrect
					} else {
						EvaluationOutcome::Correct
					};
				}
			}

			let matrix = calibration_matrix(&results);
			let estimate = super::estimate_model_ability(&tasks, &matrix, MODEL_MATRIX[0], &bank)
				.expect("extreme responses must still estimate");

			assert!(estimate.theta.is_finite());
			assert!(estimate.standard_error.is_finite());
			assert!(estimate.theta.abs() < super::RASCH_MAX_ABS_PARAMETER);
			assert!(estimate.theta * expected_sign > 0.0);

			let data_gradient = if extreme_score == 0.0 {
				-tasks
					.iter()
					.map(|task| {
						let difficulty = bank.items.get(&task.task_id).expect("item").difficulty;

						super::logistic(estimate.theta - difficulty)
					})
					.sum::<f64>()
			} else {
				tasks
					.iter()
					.map(|task| {
						let difficulty = bank.items.get(&task.task_id).expect("item").difficulty;

						1.0 - super::logistic(estimate.theta - difficulty)
					})
					.sum::<f64>()
			};

			assert!((data_gradient - estimate.theta * super::RASCH_PRIOR_PRECISION).abs() < 1e-8);
		}
	}

	#[test]
	fn uniformly_predeclared_capability_unavailable_is_not_applicable() {
		let tasks = official_tasks();
		let results = tasks
			.iter()
			.map(|task| {
				let mut unavailable = result(task, 0.0);

				unavailable.status = ResultStatus::Unsupported;
				unavailable.evaluation = EvaluationOutcome::NotEvaluated;
				unavailable.task_score = None;
				unavailable.response = None;
				unavailable.failure = Some(ResultFailure {
					kind: FailureKind::CapabilityUnavailable,
					message: "pre-run capability claim".to_owned(),
					exit_code: None,
					retryable: false,
				});

				unavailable
			})
			.collect::<Vec<_>>();
		let report = scoring::score_model_with_context(
			&tasks,
			&results,
			MODEL_MATRIX[0],
			ScoreContext {
				preflight_configuration_not_applicable: true,
				receiver_authorized_publication: false,
			},
			ScoreOptions { bootstrap_samples: 10, bootstrap_seed: 1 },
		)
		.expect("N/A must report");

		assert_eq!(report.tier, ScoreTier::NotApplicable);
		assert_eq!(report.coverage.not_applicable_tasks, 72);
		assert!(!report.ranking_eligible);
		assert!(report.score.is_none());
	}

	#[test]
	fn impossible_capability_unavailable_evidence_cannot_be_official() {
		let tasks = official_tasks();
		let results = tasks
			.iter()
			.map(|task| {
				let mut unavailable = result(task, 0.0);

				unavailable.status = ResultStatus::Failed;
				unavailable.evaluation = EvaluationOutcome::NotEvaluated;
				unavailable.task_score = None;
				unavailable.response = None;
				unavailable.failure = Some(ResultFailure {
					kind: FailureKind::CapabilityUnavailable,
					message: "unverified capability claim".to_owned(),
					exit_code: None,
					retryable: false,
				});

				unavailable
			})
			.collect::<Vec<_>>();
		let report = scoring::score_model_with_options(
			&tasks,
			&results,
			MODEL_MATRIX[0],
			ScoreOptions { bootstrap_samples: 10, bootstrap_seed: 1 },
		)
		.expect("invalid capability evidence must remain reportable");

		assert_eq!(report.tier, ScoreTier::CoverageOnly);
		assert_eq!(report.score, None);
		assert_eq!(report.coverage.valid_tasks, 0);
		assert_eq!(report.coverage.invalid_tasks, 72);
		assert_eq!(report.coverage.not_applicable_tasks, 0);
	}

	#[test]
	fn partial_capability_unavailable_evidence_cannot_be_official() {
		let tasks = official_tasks();
		let mut results = tasks.iter().map(|task| result(task, 1.0)).collect::<Vec<_>>();
		let invalid = results.first_mut().expect("fixture must contain a result");

		invalid.status = ResultStatus::Failed;
		invalid.evaluation = EvaluationOutcome::NotEvaluated;
		invalid.task_score = None;
		invalid.response = None;
		invalid.failure = Some(ResultFailure {
			kind: FailureKind::CapabilityUnavailable,
			message: "incompatible partial capability disposition".to_owned(),
			exit_code: None,
			retryable: false,
		});

		let report = scoring::score_model_with_options(
			&tasks,
			&results,
			MODEL_MATRIX[0],
			ScoreOptions { bootstrap_samples: 10, bootstrap_seed: 1 },
		)
		.expect("invalid capability evidence must remain reportable");

		assert_eq!(report.tier, ScoreTier::Provisional);
		assert_eq!(report.score, None);
		assert_eq!(report.coverage.valid_tasks, 71);
		assert_eq!(report.coverage.invalid_tasks, 1);
		assert_eq!(report.domains.iter().map(|domain| domain.zero_failure_tasks).sum::<usize>(), 0);
		assert_eq!(
			report.difficulty_coverage.values().map(|coverage| coverage.valid_tasks).sum::<usize>(),
			71
		);
	}

	#[test]
	fn scored_capability_unavailable_evidence_cannot_be_official() {
		let tasks = official_tasks();
		let mut results = tasks.iter().map(|task| result(task, 1.0)).collect::<Vec<_>>();
		let invalid = results.first_mut().expect("fixture must contain a result");

		invalid.status = ResultStatus::Failed;
		invalid.evaluation = EvaluationOutcome::NotEvaluated;
		invalid.task_score = Some(0.0);
		invalid.response = None;
		invalid.failure = Some(ResultFailure {
			kind: FailureKind::CapabilityUnavailable,
			message: "incompatible scored capability disposition".to_owned(),
			exit_code: None,
			retryable: false,
		});

		let report = scoring::score_model_with_options(
			&tasks,
			&results,
			MODEL_MATRIX[0],
			ScoreOptions { bootstrap_samples: 10, bootstrap_seed: 1 },
		)
		.expect("invalid capability evidence must remain reportable");

		assert_eq!(report.tier, ScoreTier::Provisional);
		assert_eq!(report.score, None);
		assert_eq!(report.coverage.valid_tasks, 71);
		assert_eq!(report.coverage.invalid_tasks, 1);
		assert_eq!(report.domains.iter().map(|domain| domain.zero_failure_tasks).sum::<usize>(), 0);
		assert_eq!(
			report.difficulty_coverage.values().map(|coverage| coverage.valid_tasks).sum::<usize>(),
			71
		);
	}

	#[test]
	fn failed_capability_validation_is_invalid_infrastructure_evidence() {
		let tasks = official_tasks();
		let results = tasks
			.iter()
			.map(|task| {
				let mut invalid = result(task, 0.0);

				invalid.status = ResultStatus::Failed;
				invalid.task_score = None;
				invalid.failure = Some(ResultFailure {
					kind: FailureKind::CapabilityValidationFailed,
					message: "Codex CLI probe failed".to_owned(),
					exit_code: None,
					retryable: true,
				});

				invalid
			})
			.collect::<Vec<_>>();
		let report = scoring::score_model_with_options(
			&tasks,
			&results,
			MODEL_MATRIX[0],
			ScoreOptions { bootstrap_samples: 10, bootstrap_seed: 1 },
		)
		.expect("invalid capability evidence must remain reportable");

		assert_eq!(report.tier, ScoreTier::CoverageOnly);
		assert_eq!(report.coverage.invalid_tasks, 72);
		assert_eq!(report.coverage.valid_tasks, 0);
		assert_eq!(report.coverage.not_applicable_tasks, 0);
	}

	#[test]
	fn runtime_failure_cells_are_excluded_from_semantic_aggregates() {
		let tasks = official_tasks();
		let results = tasks
			.iter()
			.map(|task| {
				let mut failed = result(task, 0.0);

				failed.status = ResultStatus::Failed;
				failed.evaluation = EvaluationOutcome::NotEvaluated;
				failed.response = None;
				failed.failure = Some(ResultFailure {
					kind: FailureKind::UnsupportedModel,
					message: "configured capability was absent at runtime".to_owned(),
					exit_code: Some(2),
					retryable: false,
				});

				failed
			})
			.collect::<Vec<_>>();
		let report = scoring::score_model_with_options(
			&tasks,
			&results,
			MODEL_MATRIX[0],
			ScoreOptions { bootstrap_samples: 10, bootstrap_seed: 1 },
		)
		.expect("runtime failures must remain reportable");

		assert_eq!(report.tier, ScoreTier::CoverageOnly);
		assert_eq!(report.score, None);
		assert_eq!(report.quality_score, None);
		assert_eq!(report.coverage.valid_tasks, 0);
		assert_eq!(report.coverage.invalid_tasks, 72);
		assert_eq!(
			report.domains.iter().map(|domain| domain.zero_failure_tasks).sum::<usize>(),
			72
		);
	}

	#[test]
	fn historical_runtime_zero_normalization_clears_only_nonsemantic_failures() {
		let tasks = official_tasks();
		let mut runtime_zero = result(&tasks[0], 0.0);

		runtime_zero.status = ResultStatus::Failed;
		runtime_zero.evaluation = EvaluationOutcome::NotEvaluated;
		runtime_zero.response = None;
		runtime_zero.failure = Some(ResultFailure {
			kind: FailureKind::Timeout,
			message: "historical timeout".to_owned(),
			exit_code: None,
			retryable: true,
		});
		runtime_zero.result_id = "legacy-runtime-zero-id".to_owned();

		let semantic_zero = result(&tasks[1], 0.0);
		let semantic_zero_id = semantic_zero.result_id.clone();
		let mut results = vec![runtime_zero, semantic_zero];

		assert_eq!(
			scoring::normalize_historical_runtime_zeroes(&mut results).expect("normalize once"),
			1
		);
		assert_eq!(results[0].task_score, None);
		assert_eq!(results[0].evaluation, EvaluationOutcome::NotEvaluated);
		assert_ne!(results[0].result_id, "legacy-runtime-zero-id");
		assert_eq!(
			results[0].result_id,
			format!(
				"result_{}",
				results[0]
					.content_hash()
					.expect("normalized result hash")
					.trim_start_matches("sha256:")
			)
		);
		assert_eq!(results[1].task_score, Some(0.0));
		assert_eq!(results[1].result_id, semantic_zero_id);

		let mut incompatible = result(&tasks[2], 0.0);

		incompatible.status = ResultStatus::Failed;
		incompatible.evaluation = EvaluationOutcome::NotEvaluated;
		incompatible.response = None;
		incompatible.failure = Some(ResultFailure {
			kind: FailureKind::MissingEvaluator,
			message: "not a runtime failure taxonomy".to_owned(),
			exit_code: None,
			retryable: false,
		});

		assert!(
			scoring::normalize_historical_runtime_zeroes(&mut [incompatible]).is_err(),
			"incompatible failure taxonomy must not be silently repaired"
		);
	}

	#[test]
	fn partial_runtime_capability_disappearance_is_invalid_not_a_semantic_zero() {
		let tasks = official_tasks();
		let mut results = tasks.iter().map(|task| result(task, 1.0)).collect::<Vec<_>>();
		let failed = results.first_mut().expect("fixture must contain a result");

		failed.status = ResultStatus::Failed;
		failed.evaluation = EvaluationOutcome::NotEvaluated;
		failed.task_score = Some(0.0);
		failed.response = None;
		failed.failure = Some(ResultFailure {
			kind: FailureKind::Timeout,
			message: "task exceeded its runtime budget".to_owned(),
			exit_code: None,
			retryable: true,
		});

		let report = scoring::score_model_with_options(
			&tasks,
			&results,
			MODEL_MATRIX[0],
			ScoreOptions { bootstrap_samples: 10, bootstrap_seed: 1 },
		)
		.expect("runtime capability disappearance must remain reportable");

		assert_eq!(report.tier, ScoreTier::Provisional);
		assert_eq!(report.coverage.valid_tasks, 71);
		assert_eq!(report.coverage.invalid_tasks, 1);
		assert_eq!(report.coverage.missing_tasks, 0);
		assert_eq!(report.domains.iter().map(|domain| domain.zero_failure_tasks).sum::<usize>(), 1);
		assert!(report.score.is_none());
		assert_eq!(report.quality_score, Some(100.0));
		assert_eq!(report.binary_micro_diagnostic.sample_size, 71);
		assert_eq!(report.binary_micro_diagnostic.successes, 71);
		assert_eq!(
			report.difficulty_coverage.values().map(|coverage| coverage.valid_tasks).sum::<usize>(),
			71
		);

		let missing_results = results[1..].to_vec();
		let missing_report = scoring::score_model_with_options(
			&tasks,
			&missing_results,
			MODEL_MATRIX[0],
			ScoreOptions { bootstrap_samples: 10, bootstrap_seed: 1 },
		)
		.expect("a missing cell must remain reportable");

		assert_eq!(missing_report.coverage.valid_tasks, 71);
		assert_eq!(missing_report.coverage.invalid_tasks, 0);
		assert_eq!(missing_report.coverage.missing_tasks, 1);
	}
}
