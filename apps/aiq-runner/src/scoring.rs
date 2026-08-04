//! Transparent, versioned AIQ scoring.

use std::{
	collections::BTreeMap,
	fmt::{Display, Formatter},
};

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;

use crate::{
	model::ModelConfig,
	protocol::{self, TrustTier},
	runner::{EvaluationOutcome, FailureKind, ResultStatus, TaskResult},
	task::{Domain, TaskDefinition},
};

/// Current scoring implementation version.
pub const AIQ_SCORING_VERSION: &str = "1.0.2";
/// Current controlled AIQ Core task-set identifier.
pub const AIQ_TASK_SET_ID: &str = "aiq-core";
/// Current controlled AIQ Core task-set release.
pub const AIQ_TASK_SET_VERSION: &str = "1.0.2";
/// Current benchmark release identifier.
pub const AIQ_BENCHMARK_VERSION: &str = "aiq-core@1.0.2";
/// Frozen full-metadata commitment for the current AIQ Core release.
pub const AIQ_CORE_TASK_IDENTITY_SHA256: &str =
	"sha256:2c5efe162b49e710e6e52b0f3a4e33d1127d0dd54d4f15694f88911bcb7fc937";
/// Default production resampling replicate count.
pub const DEFAULT_BOOTSTRAP_SAMPLES: usize = 10_000;
/// Default deterministic bootstrap seed.
pub const DEFAULT_BOOTSTRAP_SEED: u64 = 0x41_49_51_5f_56_31;

const TASK_RESAMPLING_SENSITIVITY_METHOD: &str =
	"finite_cluster_calibrated_percentile_sensitivity_v1";
const SCORE_RULE: &str = "AIQ v1: 100 × the equal-weight mean of 10 domain scores; each domain is the equal-weight mean of valid task scores. Coverage and difficulty do not alter weights. Official requires non-synthetic 72/72 coverage and 10/10 domains. A complete synthetic fixture is descriptive, has no Official AIQ, and is not ranking eligible. Provisional requires at least 60/72 and at least four valid tasks per domain, is conditional, and is not ranking eligible. Lower coverage publishes no estimate. The task-resampling interval uses finite_cluster_calibrated_percentile_sensitivity_v1 with a versioned 1.3 deviation correction calibrated for this fixed benchmark fixture. It is a fixed-fixture calibrated sensitivity interval, not a universal confidence interval for model capability.";
const CALIBRATION_SCORE_RULE: &str = "Calibration analysis only. Values are transparent descriptive aggregates for the selected evidence. This report has no publication classification and is not ranking eligible. When present, the task-resampling interval uses finite_cluster_calibrated_percentile_sensitivity_v1 with a versioned 1.3 deviation correction calibrated for this fixed benchmark fixture. It is a fixed-fixture calibrated sensitivity interval, not a universal confidence interval for model capability.";

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

/// Diagnostic binary micro average and Wilson interval.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BinaryMicroDiagnostic {
	/// Binary task-score sample size. Partial scores are excluded.
	pub sample_size: usize,
	/// Binary successes.
	pub successes: usize,
	/// Micro-average binary correctness.
	pub proportion: Option<f64>,
	/// Wilson 95% lower bound.
	pub wilson_lower: Option<f64>,
	/// Wilson 95% upper bound.
	pub wilson_upper: Option<f64>,
}

/// Coverage and disposition counts.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CoverageSummary {
	/// Expected tasks.
	pub expected_tasks: usize,
	/// Tasks with a valid score, including valid zero scores.
	pub valid_tasks: usize,
	/// Invalid results caused by fixture, scorer, container, authentication, or platform failure.
	pub invalid_tasks: usize,
	/// Tasks that never started and have no result.
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
	/// Invalid task results.
	pub invalid_tasks: usize,
	/// Missing task results.
	pub missing_tasks: usize,
	/// Capability-unavailable task results.
	pub not_applicable_tasks: usize,
	/// Zero scores caused by model, tool, timeout, budget, or wrong-artifact failure.
	pub zero_failure_tasks: usize,
	/// Equal-weight mean of valid task scores.
	pub score: Option<f64>,
}

/// A transparent AIQ v1 score report.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ScoreReport {
	/// Score report schema.
	pub schema_version: String,
	/// Scoring implementation version.
	pub scoring_version: String,
	/// Scored model configuration.
	pub model: ModelConfig,
	/// Publication tier.
	pub tier: ScoreTier,
	/// Official ranking score. It is present only for the Official tier.
	pub official_aiq: Option<f64>,
	/// Conditional observed estimate. Synthetic and Provisional estimates are not ranking eligible.
	pub conditional_observed_aiq: Option<f64>,
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
	/// Analyzed model configuration.
	pub model: ModelConfig,
	/// Descriptive coverage state, not a publication tier.
	pub descriptive_status: CalibrationDescriptiveStatus,
	/// Whether this analysis can be interpreted as Official. This is always false.
	pub official_eligible: FalseOnly,
	/// Whether this analysis can participate in ranking. This is always false.
	pub ranking_eligible: FalseOnly,
	/// Equal-domain fixed-fixture value for exact complete coverage.
	pub fixed_fixture_aiq: Option<f64>,
	/// Equal-domain conditional value when the existing coverage threshold is met.
	pub conditional_observed_aiq: Option<f64>,
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

/// Scores one model with production AIQ v1 bootstrap settings.
pub fn score_model(
	tasks: &[TaskDefinition],
	results: &[TaskResult],
	model: ModelConfig,
) -> Result<ScoreReport, ScoreError> {
	score_model_with_options(tasks, results, model, ScoreOptions::default())
}

/// Scores one model with explicit deterministic bootstrap settings.
///
/// AIQ v1 is 100 times the equal-weight mean of 10 domain scores. Each domain
/// score is the equal-weight mean of valid task scores from 0 through 1. Coverage
/// does not multiply or otherwise alter the AIQ point estimate.
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
	if tasks.is_empty() {
		return Err(ScoreError::new("cannot score an empty task set"));
	}
	if options.bootstrap_samples == 0 {
		return Err(ScoreError::new("bootstrap_samples must be greater than zero"));
	}
	if options.bootstrap_seed == 0 {
		return Err(ScoreError::new("bootstrap_seed must be greater than zero"));
	}

	let frozen_catalog = catalog_identity_is_frozen(tasks);
	let expected = tasks
		.iter()
		.map(|task| ((task.task_id.as_str(), task.task_version.as_str()), task))
		.collect::<BTreeMap<_, _>>();

	if expected.len() != tasks.len() {
		return Err(ScoreError::new("task identifiers and versions must be unique"));
	}

	let mut matching = BTreeMap::<(&str, &str), Vec<&TaskResult>>::new();

	for result in results.iter().filter(|result| result.model == model) {
		matching.entry((&result.task_id, &result.task_version)).or_default().push(result);
	}

	let has_synthetic_results = selected_model_uses_synthetic_results(&matching)?;
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
	let tier = if coverage_tier == ScoreTier::Official && has_synthetic_results {
		ScoreTier::SyntheticComplete
	} else {
		coverage_tier
	};
	let domain_scores = domain_scores(&accumulators);
	let conditional_observed_aiq = if matches!(
		tier,
		ScoreTier::Official | ScoreTier::SyntheticComplete | ScoreTier::Provisional
	) {
		Some(macro_score(&accumulators)? * 100.0)
	} else {
		None
	};
	let official_aiq =
		(tier == ScoreTier::Official).then_some(conditional_observed_aiq.unwrap_or_default());
	let task_resampling_sensitivity_interval = if conditional_observed_aiq.is_some() {
		Some(cluster_bootstrap(&accumulators, options)?)
	} else {
		None
	};
	let completion_bounds = if conditional_observed_aiq.is_some() {
		Some(completion_bounds(&accumulators)?)
	} else {
		None
	};

	Ok(ScoreReport {
		schema_version: "aiq.score-report.v1".to_owned(),
		scoring_version: AIQ_SCORING_VERSION.to_owned(),
		model,
		tier,
		official_aiq,
		conditional_observed_aiq,
		ranking_eligible: tier == ScoreTier::Official
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
	let fixed_fixture_aiq =
		matches!(report.tier, ScoreTier::Official | ScoreTier::SyntheticComplete)
			.then_some(report.conditional_observed_aiq)
			.flatten();

	Ok(CalibrationScoreReport {
		schema_version: "aiq.calibration-score-report.v1".to_owned(),
		run_class: "calibration".to_owned(),
		scoring_version: report.scoring_version,
		model: report.model,
		descriptive_status,
		official_eligible: FalseOnly,
		ranking_eligible: FalseOnly,
		fixed_fixture_aiq,
		conditional_observed_aiq: (report.tier == ScoreTier::Provisional)
			.then_some(report.conditional_observed_aiq)
			.flatten(),
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

		accumulator.observations.push(Observation {
			score,
			cluster: task.cluster_id.clone().unwrap_or_else(|| task.task_id.clone()),
		});

		return Ok(());
	}

	if uniform_out_of_scope {
		accumulator.not_applicable += 1;
	} else {
		accumulator.invalid += 1;
	}

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
	serde_json::from_str(include_str!("../../../benchmarks/candidates/aiq-core-1.0.2/catalog.json"))
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
) -> Result<CompletionBounds, ScoreError> {
	if accumulators.len() != 10 {
		return Err(ScoreError::new("completion bounds require 10 planned domains"));
	}

	let mut lower = 0.0;
	let mut upper = 0.0;

	for domain in accumulators.values() {
		if domain.expected == 0 {
			return Err(ScoreError::new("completion bounds require planned tasks in every domain"));
		}

		let planned = domain.expected as f64;
		let observed = domain.observations.len() as f64;
		let score_sum = domain.observations.iter().map(|item| item.score).sum::<f64>();

		lower += score_sum / planned;
		upper += (score_sum + planned - observed) / planned;
	}

	Ok(CompletionBounds { lower: 10.0 * lower, upper: 10.0 * upper })
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
						[result] if result.task_score.is_some() && !capability_unavailable(result)
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
	let binary = accumulators
		.values()
		.flat_map(|domain| &domain.observations)
		.filter(|observation| observation.score == 0.0 || observation.score == 1.0)
		.collect::<Vec<_>>();
	let sample_size = binary.len();
	let successes = binary.iter().filter(|observation| observation.score == 1.0).count();
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
	use std::mem;

	use crate::{
		model::MODEL_MATRIX,
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
		assert!(first.official_aiq.is_none());
		assert!(
			(first.conditional_observed_aiq.expect("synthetic descriptive score")
				- 54.285_714_285_714_285)
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
		assert!(report.conditional_observed_aiq.is_none());
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

		assert_eq!(analysis.schema_version, "aiq.calibration-score-report.v1");
		assert_eq!(analysis.run_class, "calibration");
		assert_eq!(
			analysis.descriptive_status,
			scoring::CalibrationDescriptiveStatus::CoverageOnly
		);
		assert_eq!(analysis.official_eligible, scoring::FalseOnly);
		assert_eq!(analysis.ranking_eligible, scoring::FalseOnly);
		assert_eq!(analysis.coverage.expected_tasks, 8);
		assert_eq!(analysis.coverage.valid_tasks, 8);
		assert!(analysis.fixed_fixture_aiq.is_none());
		assert!(analysis.conditional_observed_aiq.is_none());
		assert!(!serialized.contains("\"tier\""));
		assert!(!serialized.contains("official_aiq"));
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
		assert!(analysis.fixed_fixture_aiq.is_none());
		assert_eq!(analysis.conditional_observed_aiq, Some(50.0));
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
		assert!(analysis.fixed_fixture_aiq.is_none());
		assert!(analysis.conditional_observed_aiq.is_none());
		assert!(analysis.completion_bounds.is_none());
		assert!(analysis.task_resampling_sensitivity_interval.is_none());
		assert_eq!(analysis.coverage.not_applicable_tasks, 72);
	}

	#[test]
	fn mismatched_task_scorer_version_cannot_be_official() {
		let mut tasks = official_tasks();

		tasks[0].scorer_version = "1.0.1".to_owned();

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
		let mut results = tasks.iter().map(|task| result(task, 1.0)).collect::<Vec<_>>();

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
		assert!(synthetic.official_aiq.is_none());
		assert_eq!(synthetic.conditional_observed_aiq, Some(100.0));
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
		assert!(report.ranking_eligible);
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
		assert!(report.official_aiq.is_none());
		assert!(report.conditional_observed_aiq.is_none());
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
		assert!(report.official_aiq.is_none());
		assert_eq!(report.conditional_observed_aiq, Some(50.0));

		let bounds = report.completion_bounds.expect("provisional completion bounds");

		assert!((bounds.lower - 41.964_285_714_285_715).abs() < 1e-10);
		assert!((bounds.upper - 58.035_714_285_714_285).abs() < 1e-10);
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
		assert!(report.official_aiq.is_none());
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
		assert_eq!(report.official_aiq, None);
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
		assert_eq!(report.official_aiq, None);
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
		assert_eq!(report.official_aiq, None);
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
	fn unexpectedly_missing_runtime_capability_receives_zero() {
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
		.expect("zero-score failures must score");

		assert_eq!(report.tier, ScoreTier::SyntheticComplete);
		assert_eq!(report.official_aiq, None);
		assert_eq!(report.conditional_observed_aiq, Some(0.0));
		assert_eq!(
			report.domains.iter().map(|domain| domain.zero_failure_tasks).sum::<usize>(),
			72
		);
	}

	#[test]
	fn partial_runtime_capability_disappearance_is_a_valid_zero_not_invalid() {
		let tasks = official_tasks();
		let mut results = tasks.iter().map(|task| result(task, 1.0)).collect::<Vec<_>>();
		let failed = results.first_mut().expect("fixture must contain a result");

		failed.status = ResultStatus::Failed;
		failed.evaluation = EvaluationOutcome::NotEvaluated;
		failed.task_score = Some(0.0);
		failed.response = None;
		failed.failure = Some(ResultFailure {
			kind: FailureKind::UnsupportedModel,
			message: "capability disappeared after the pre-run claim".to_owned(),
			exit_code: Some(2),
			retryable: false,
		});

		let report = scoring::score_model_with_options(
			&tasks,
			&results,
			MODEL_MATRIX[0],
			ScoreOptions { bootstrap_samples: 10, bootstrap_seed: 1 },
		)
		.expect("runtime capability disappearance must score as zero");

		assert_eq!(report.tier, ScoreTier::SyntheticComplete);
		assert_eq!(report.coverage.valid_tasks, 72);
		assert_eq!(report.coverage.invalid_tasks, 0);
		assert_eq!(report.domains.iter().map(|domain| domain.zero_failure_tasks).sum::<usize>(), 1);
		assert!(report.official_aiq.is_none());
		assert!(report.conditional_observed_aiq.expect("synthetic descriptive score") < 100.0);
	}
}
