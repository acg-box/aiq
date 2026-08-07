//! Test-only public projections generated from the production scoring path.
//!
//! This module is intentionally not a result-package or database publication
//! format. It gives browser contract tests a complete 1.0.6-shaped response
//! without allowing test observations to become Official evidence.

use std::{
	collections::{BTreeMap, BTreeSet},
	error::Error,
	fmt::{Display, Formatter},
};

use serde::{Deserialize, Serialize};

use crate::model::ModelFamily;
use crate::{
	model::{MODEL_MATRIX, ModelConfig},
	protocol::{self, ResultProvenance, TrustTier},
	runner::{
		self, EvaluationOutcome, Latency, RESULT_SCHEMA_VERSION, ResultStatus, TaskResult,
		ToolUsage,
	},
	scoring::{
		self, AIQ_BENCHMARK_VERSION, AIQ_MEASUREMENT_VERSION, AIQ_SCORING_VERSION, FalseOnly,
		OfficialCalibrationDiagnostic, ScoreContext, ScoreOptions, ScoreReport, ScoreTier,
	},
	task::TaskDefinition,
};

/// Schema for the browser-only generated projection.
pub const TEST_GENERATED_PUBLIC_FIXTURE_SCHEMA_VERSION: &str =
	"aiq.test-generated-public-fixture.v1";
/// Explicit provenance value carried by every generated fixture.
pub const TEST_GENERATED_FIXTURE_PROVENANCE: &str = "test_generated";
/// Fixed bootstrap count used by the committed browser fixture.
pub const TEST_GENERATED_BOOTSTRAP_SAMPLES: usize = 256;
/// Fixed non-zero bootstrap seed used by the committed browser fixture.
pub const TEST_GENERATED_BOOTSTRAP_SEED: u64 = 0x41_49_51_5f_54_45_53_54;

// Keep latent values in the committed browser projection byte-stable across
// the macOS runner used to generate it and Linux CI. The production scorer
// intentionally keeps full f64 precision; only this test projection is normalized.
const TEST_GENERATED_LATENT_FLOAT_SCALE: f64 = 100_000_000_000_000.0;
const RECORDED_AT: &str = "2026-01-01T00:00:00.000Z";
const BUCKET_STARTED_AT: &str = "2025-12-31T23:59:59.000Z";
const BUCKET_ENDED_AT: &str = "2026-01-01T00:00:01.000Z";

/// Complete test-generated public projection for browser live-published mocks.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TestGeneratedPublicFixture {
	schema_version: String,
	fixture_provenance: String,
	test_generated: bool,
	production_publishable: FalseOnly,
	official_eligible: FalseOnly,
	ranking_eligible: FalseOnly,
	synthetic: bool,
	benchmark_version: String,
	scoring_version: String,
	measurement_version: String,
	matrix_batch_id: String,
	task_count: usize,
	configuration_count: usize,
	cell_count: usize,
	bootstrap_samples: usize,
	bootstrap_seed: u64,
	calibration_gate: TestGeneratedCalibrationGate,
	leaderboard: Vec<PublicLeaderboardRow>,
	trend: Vec<PublicTrendRow>,
	task_cells: Vec<TestGeneratedTaskCell>,
}
impl TestGeneratedPublicFixture {
	/// Validates the fixture boundary and its browser-facing invariants.
	pub fn validate(&self) -> Result<(), TestGeneratedFixtureError> {
		if self.schema_version != TEST_GENERATED_PUBLIC_FIXTURE_SCHEMA_VERSION {
			return Err(error("unsupported test-generated public fixture schema"));
		}
		if self.fixture_provenance != TEST_GENERATED_FIXTURE_PROVENANCE
			|| !self.test_generated
			|| !self.synthetic
			|| self.production_publishable != FalseOnly
			|| self.official_eligible != FalseOnly
			|| self.ranking_eligible != FalseOnly
		{
			return Err(error("test-generated fixture provenance is not isolated"));
		}
		if self.benchmark_version != AIQ_BENCHMARK_VERSION
			|| self.scoring_version != AIQ_SCORING_VERSION
			|| self.measurement_version != AIQ_MEASUREMENT_VERSION
			|| self.task_count != 72
			|| self.configuration_count != MODEL_MATRIX.len()
			|| self.cell_count != self.task_count * self.configuration_count
			|| self.leaderboard.len() != MODEL_MATRIX.len()
			|| self.trend.len() != MODEL_MATRIX.len()
			|| self.task_cells.len() != self.cell_count
		{
			return Err(error("test-generated fixture has an incomplete matrix shape"));
		}
		if !self.calibration_gate.passed || !self.calibration_gate.violations.is_empty() {
			return Err(error("test-generated matrix did not pass its calibration fixture gate"));
		}

		let expected_matrix_ids =
			MODEL_MATRIX.iter().map(|model| matrix_id(*model)).collect::<Vec<_>>();
		let expected_task_keys = runner::synthetic_demo_tasks()
			.into_iter()
			.map(|task| (task.task_id, task.task_version))
			.collect::<BTreeSet<_>>();
		let expected_matrix_set = expected_matrix_ids.iter().cloned().collect::<BTreeSet<_>>();
		let leaderboard_ids =
			self.leaderboard.iter().map(|row| row.matrix_id.clone()).collect::<BTreeSet<_>>();
		let trend_ids = self.trend.iter().map(|row| row.matrix_id.clone()).collect::<BTreeSet<_>>();

		if leaderboard_ids != expected_matrix_set || trend_ids != expected_matrix_set {
			return Err(error("public projections do not cover the canonical model matrix"));
		}

		let mut semantic_counts = BTreeMap::<String, (usize, usize)>::new();
		let mut task_keys_per_matrix = BTreeMap::<String, BTreeSet<(String, String)>>::new();

		for cell in &self.task_cells {
			if cell.provenance != TEST_GENERATED_FIXTURE_PROVENANCE
				|| cell.task_version != AIQ_SCORING_VERSION
				|| !cell.task_score.is_finite()
				|| !(0.0..=1.0).contains(&cell.task_score)
			{
				return Err(error("task cell has invalid test-generated provenance or score"));
			}

			let counts = semantic_counts.entry(cell.matrix_id.clone()).or_default();

			counts.0 += 1;

			if cell.task_score == 1.0 {
				counts.1 += 1;
			}
			if !task_keys_per_matrix
				.entry(cell.matrix_id.clone())
				.or_default()
				.insert((cell.task_id.clone(), cell.task_version.clone()))
			{
				return Err(error("duplicate task cell in the generated matrix"));
			}
		}

		if expected_matrix_ids
			.iter()
			.any(|id| semantic_counts.get(id).is_none_or(|(sample, _)| *sample != 72))
		{
			return Err(error("each test-generated model must contain exactly 72 cells"));
		}
		if expected_matrix_ids
			.iter()
			.any(|id| task_keys_per_matrix.get(id).is_none_or(|keys| keys != &expected_task_keys))
		{
			return Err(error("each generated model must cover the exact 1.0.6 task set"));
		}

		for row in &self.leaderboard {
			validate_official_shaped_row(row)?;

			let (sample_size, successes) = semantic_counts
				.get(&row.matrix_id)
				.ok_or_else(|| error("leaderboard row has no task-cell evidence"))?;

			if row.strict_pass_sample_size != *sample_size
				|| row.strict_pass_successes != *successes
			{
				return Err(error(
					"strict-pass row is not derived from its semantic task denominator",
				));
			}
		}
		for row in &self.trend {
			validate_official_shaped_trend(row)?;

			let (sample_size, successes) = semantic_counts
				.get(&row.matrix_id)
				.ok_or_else(|| error("trend row has no task-cell evidence"))?;

			if row.strict_pass_sample_size != *sample_size
				|| row.strict_pass_successes != *successes
			{
				return Err(error(
					"trend strict-pass row is not derived from its semantic task denominator",
				));
			}
		}

		Ok(())
	}

	/// Explicit production gate. This fixture has no production admission path.
	pub fn production_admission(&self) -> Result<(), TestGeneratedFixtureError> {
		Err(error(
			"test-generated public fixtures are never accepted by production or Official cutover",
		))
	}
}

/// Generation and contract-validation failure.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TestGeneratedFixtureError {
	message: String,
}
impl Display for TestGeneratedFixtureError {
	fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
		formatter.write_str(&self.message)
	}
}

impl Error for TestGeneratedFixtureError {}

/// A flat row matching the public leaderboard view contract.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PublicLeaderboardRow {
	matrix_id: String,
	run_id: String,
	score: f64,
	theta: f64,
	standard_error: f64,
	theta_ci_low: f64,
	theta_ci_high: f64,
	score_ci_low: f64,
	score_ci_high: f64,
	information: f64,
	quality_score: f64,
	strict_pass_rate: f64,
	strict_pass_low: f64,
	strict_pass_high: f64,
	strict_pass_sample_size: usize,
	strict_pass_successes: usize,
	reliability_status: String,
	calibration_status: String,
	sensitivity_low: f64,
	sensitivity_high: f64,
	sample_size: usize,
	coverage_percent: f64,
	runtime_issues: usize,
	missing: usize,
	scoring_version: String,
	score_status: String,
	/// This is false to exercise the published row shape. The enclosing fixture
	/// remains test-generated and is not publication evidence.
	synthetic: bool,
}

/// A flat row matching the public trend RPC contract.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PublicTrendRow {
	matrix_id: String,
	run_id: String,
	scoring_version: String,
	recorded_at: String,
	bucket_started_at: String,
	bucket_ended_at: String,
	score: f64,
	theta: f64,
	standard_error: f64,
	theta_ci_low: f64,
	theta_ci_high: f64,
	score_ci_low: f64,
	score_ci_high: f64,
	information: f64,
	quality_score: f64,
	strict_pass_rate: f64,
	strict_pass_low: f64,
	strict_pass_high: f64,
	strict_pass_sample_size: usize,
	strict_pass_successes: usize,
	reliability_status: String,
	calibration_status: String,
	sensitivity_low: f64,
	sensitivity_high: f64,
	sample_size: usize,
	represented_run_count: usize,
	resolution_seconds: u64,
	/// This is false to exercise the published row shape. The enclosing fixture
	/// remains test-generated and is not publication evidence.
	synthetic: bool,
}

/// Public-safe task-level cells used by browser consistency tests.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct TestGeneratedTaskCell {
	matrix_id: String,
	task_id: String,
	task_version: String,
	task_score: f64,
	evaluation: String,
	provenance: String,
}

/// Calibration-gate evidence for the generated matrix.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct TestGeneratedCalibrationGate {
	policy_version: String,
	passed: bool,
	violations: Vec<String>,
}

/// Generates the deterministic browser fixture through the production scorer.
pub fn generate_test_generated_public_fixture()
-> Result<TestGeneratedPublicFixture, TestGeneratedFixtureError> {
	let tasks = runner::synthetic_demo_tasks();

	if tasks.len() != 72 {
		return Err(error("the frozen 1.0.6 fixture task shape is not 72 tasks"));
	}

	let results = generated_matrix_results(&tasks)?;
	let calibration = scoring::diagnose_official_calibration(&tasks, &results)
		.map_err(|error| error_message("calibration fixture diagnosis failed", error))?;

	if !calibration.passed() {
		return Err(error(format!(
			"generated calibration fixture failed its release gate: {:?}",
			calibration.violations
		)));
	}

	let matrix_batch_id = fixture_matrix_batch_id()?;
	let options = ScoreOptions {
		bootstrap_samples: TEST_GENERATED_BOOTSTRAP_SAMPLES,
		bootstrap_seed: TEST_GENERATED_BOOTSTRAP_SEED,
	};
	let mut leaderboard = Vec::with_capacity(MODEL_MATRIX.len());
	let mut trend = Vec::with_capacity(MODEL_MATRIX.len());

	for model in MODEL_MATRIX {
		let model_id = matrix_id(model);
		let run_id = fixture_run_id(&matrix_batch_id, &model_id)?;
		let report = scoring::score_model_with_context(
			&tasks,
			&results,
			model,
			ScoreContext::default(),
			options,
		)
		.map_err(|error| error_message("formal AIQ 2.0 scoring failed", error))?;

		if report.tier != ScoreTier::Official || report.ranking_eligible {
			return Err(error(
				"test-generated scorer output has an invalid Official-shaped or eligibility state",
			));
		}

		let row = public_leaderboard_row(&report, model_id, run_id.clone())?;

		trend.push(public_trend_row(&row));
		leaderboard.push(row);
	}

	let task_cells = results
		.iter()
		.map(|result| TestGeneratedTaskCell {
			matrix_id: matrix_id(result.model),
			task_id: result.task_id.clone(),
			task_version: result.task_version.clone(),
			task_score: result.task_score.expect("generated matrix cells are scored"),
			evaluation: evaluation_name(result.evaluation).to_owned(),
			provenance: TEST_GENERATED_FIXTURE_PROVENANCE.to_owned(),
		})
		.collect::<Vec<_>>();
	let fixture = TestGeneratedPublicFixture {
		schema_version: TEST_GENERATED_PUBLIC_FIXTURE_SCHEMA_VERSION.to_owned(),
		fixture_provenance: TEST_GENERATED_FIXTURE_PROVENANCE.to_owned(),
		test_generated: true,
		production_publishable: FalseOnly,
		official_eligible: FalseOnly,
		ranking_eligible: FalseOnly,
		synthetic: true,
		benchmark_version: AIQ_BENCHMARK_VERSION.to_owned(),
		scoring_version: AIQ_SCORING_VERSION.to_owned(),
		measurement_version: AIQ_MEASUREMENT_VERSION.to_owned(),
		matrix_batch_id,
		task_count: tasks.len(),
		configuration_count: MODEL_MATRIX.len(),
		cell_count: task_cells.len(),
		bootstrap_samples: options.bootstrap_samples,
		bootstrap_seed: options.bootstrap_seed,
		calibration_gate: calibration_gate(&calibration),
		leaderboard,
		trend,
		task_cells,
	};

	fixture.validate()?;

	Ok(fixture)
}

fn generated_matrix_results(
	tasks: &[TaskDefinition],
) -> Result<Vec<TaskResult>, TestGeneratedFixtureError> {
	MODEL_MATRIX
		.iter()
		.enumerate()
		.flat_map(|(model_index, model)| {
			tasks.iter().enumerate().map(move |(task_index, task)| {
				let task_score = generated_task_score(model_index, task_index);

				Ok(TaskResult {
					schema_version: RESULT_SCHEMA_VERSION.to_owned(),
					result_id: format!("test_result_{model_index:02}_{task_index:02}"),
					run_id: "test_generated_fixture".to_owned(),
					task_id: task.task_id.clone(),
					task_version: task.task_version.clone(),
					task_hash: task
						.content_hash()
						.map_err(|error| error_message("generated task hash failed", error))?,
					model: *model,
					status: ResultStatus::Completed,
					evaluation: evaluation_for_score(task_score),
					task_score: Some(task_score),
					response: Some("test-generated public fixture".to_owned()),
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
						node_id: "test_generated".to_owned(),
						runner_version: "test_generated".to_owned(),
						codex_version: "test_generated".to_owned(),
						observed_at: "test_generated".to_owned(),
						// The scorer needs a complete non-synthetic observation matrix to
						// exercise the latent path. The enclosing fixture is the
						// authoritative synthetic marker and cannot be packaged.
						synthetic: false,
						local_trust: TrustTier::Untrusted,
					},
				})
			})
		})
		.collect()
}

fn generated_task_score(model_index: usize, task_index: usize) -> f64 {
	let model_location = -1.2 + model_index as f64 * 0.15;
	let difficulty = (task_index as f64 - 35.5) * 0.025;
	let probability = logistic(model_location - difficulty);

	// Keep a small, deterministic strict-pass and incorrect tail so browser
	// tests exercise partial-denominator semantics as well as Wilson bounds.
	if probability >= 0.62 && (model_index + task_index * 3).is_multiple_of(41) {
		1.0
	} else if probability <= 0.38 && (model_index * 5 + task_index).is_multiple_of(47) {
		0.0
	} else {
		probability
	}
}

fn logistic(value: f64) -> f64 {
	if value >= 0.0 {
		1.0 / (1.0 + (-value).exp())
	} else {
		let exponential = value.exp();

		exponential / (1.0 + exponential)
	}
}

fn evaluation_for_score(score: f64) -> EvaluationOutcome {
	if score == 1.0 {
		EvaluationOutcome::Correct
	} else if score == 0.0 {
		EvaluationOutcome::Incorrect
	} else {
		EvaluationOutcome::Partial
	}
}

fn evaluation_name(evaluation: EvaluationOutcome) -> &'static str {
	match evaluation {
		EvaluationOutcome::Correct => "correct",
		EvaluationOutcome::Incorrect => "incorrect",
		EvaluationOutcome::NotEvaluated => "not_evaluated",
		EvaluationOutcome::Partial => "partial",
	}
}

fn matrix_id(model: ModelConfig) -> String {
	let family = match model.family {
		ModelFamily::Sol => "sol",
		ModelFamily::Terra => "terra",
		ModelFamily::Luna => "luna",
	};

	format!("{family}-{}", model.reasoning_effort)
}

fn fixture_matrix_batch_id() -> Result<String, TestGeneratedFixtureError> {
	let digest = protocol::canonical_hash(&serde_json::json!({
		"schema": TEST_GENERATED_PUBLIC_FIXTURE_SCHEMA_VERSION,
		"benchmark": AIQ_BENCHMARK_VERSION,
		"scoring": AIQ_SCORING_VERSION,
		"measurement": AIQ_MEASUREMENT_VERSION,
		"seed": "known_rasch_public_projection_v1",
	}))
	.map_err(|error| error_message("fixture identity failed", error))?;

	Ok(format!("fixture_{}", digest.trim_start_matches("sha256:")))
}

fn fixture_run_id(batch_id: &str, matrix_id: &str) -> Result<String, TestGeneratedFixtureError> {
	let digest = protocol::canonical_hash(&serde_json::json!({
		"batch_id": batch_id,
		"matrix_id": matrix_id,
	}))
	.map_err(|error| error_message("fixture run identity failed", error))?;

	Ok(format!("run_{}", digest.trim_start_matches("sha256:")))
}

fn public_leaderboard_row(
	report: &ScoreReport,
	matrix_id: String,
	run_id: String,
) -> Result<PublicLeaderboardRow, TestGeneratedFixtureError> {
	let latent = report
		.latent_ability
		.as_ref()
		.ok_or_else(|| error("formal scorer omitted latent ability for a complete fixture"))?;
	let sensitivity = report.task_resampling_sensitivity_interval.as_ref().ok_or_else(|| {
		error("formal scorer omitted task-mix sensitivity for a complete fixture")
	})?;
	let score = report.score.ok_or_else(|| error("formal scorer omitted calibrated score"))?;
	let quality_score =
		report.quality_score.ok_or_else(|| error("formal scorer omitted quality score"))?;
	let coverage_percent =
		100.0 * report.coverage.valid_tasks as f64 / report.coverage.expected_tasks as f64;
	let binary = &report.binary_micro_diagnostic;
	let strict_pass_rate =
		binary.proportion.ok_or_else(|| error("formal scorer omitted strict-pass rate"))?;
	let strict_pass_low =
		binary.wilson_lower.ok_or_else(|| error("formal scorer omitted Wilson lower bound"))?;
	let strict_pass_high =
		binary.wilson_upper.ok_or_else(|| error("formal scorer omitted Wilson upper bound"))?;

	Ok(PublicLeaderboardRow {
		matrix_id,
		run_id,
		score: stable_fixture_latent_float(score),
		theta: stable_fixture_latent_float(latent.theta),
		standard_error: stable_fixture_latent_float(latent.standard_error),
		theta_ci_low: stable_fixture_latent_float(latent.theta_ci_low),
		theta_ci_high: stable_fixture_latent_float(latent.theta_ci_high),
		score_ci_low: stable_fixture_latent_float(latent.score_ci_low),
		score_ci_high: stable_fixture_latent_float(latent.score_ci_high),
		information: stable_fixture_latent_float(latent.observed_information),
		quality_score,
		strict_pass_rate,
		strict_pass_low,
		strict_pass_high,
		strict_pass_sample_size: binary.sample_size,
		strict_pass_successes: binary.successes,
		reliability_status: latent.reliability_status.clone(),
		calibration_status: "calibrated".to_owned(),
		sensitivity_low: sensitivity.lower,
		sensitivity_high: sensitivity.upper,
		sample_size: report.coverage.valid_tasks,
		coverage_percent,
		runtime_issues: report.coverage.invalid_tasks,
		missing: report.coverage.missing_tasks,
		scoring_version: report.scoring_version.clone(),
		score_status: "official".to_owned(),
		synthetic: false,
	})
}

fn stable_fixture_latent_float(value: f64) -> f64 {
	(value * TEST_GENERATED_LATENT_FLOAT_SCALE).round() / TEST_GENERATED_LATENT_FLOAT_SCALE
}

fn public_trend_row(row: &PublicLeaderboardRow) -> PublicTrendRow {
	PublicTrendRow {
		matrix_id: row.matrix_id.clone(),
		run_id: row.run_id.clone(),
		scoring_version: row.scoring_version.clone(),
		recorded_at: RECORDED_AT.to_owned(),
		bucket_started_at: BUCKET_STARTED_AT.to_owned(),
		bucket_ended_at: BUCKET_ENDED_AT.to_owned(),
		score: row.score,
		theta: row.theta,
		standard_error: row.standard_error,
		theta_ci_low: row.theta_ci_low,
		theta_ci_high: row.theta_ci_high,
		score_ci_low: row.score_ci_low,
		score_ci_high: row.score_ci_high,
		information: row.information,
		quality_score: row.quality_score,
		strict_pass_rate: row.strict_pass_rate,
		strict_pass_low: row.strict_pass_low,
		strict_pass_high: row.strict_pass_high,
		strict_pass_sample_size: row.strict_pass_sample_size,
		strict_pass_successes: row.strict_pass_successes,
		reliability_status: row.reliability_status.clone(),
		calibration_status: row.calibration_status.clone(),
		sensitivity_low: row.sensitivity_low,
		sensitivity_high: row.sensitivity_high,
		sample_size: row.sample_size,
		represented_run_count: 1,
		resolution_seconds: 2,
		synthetic: false,
	}
}

fn calibration_gate(diagnostic: &OfficialCalibrationDiagnostic) -> TestGeneratedCalibrationGate {
	TestGeneratedCalibrationGate {
		policy_version: diagnostic.policy.version.clone(),
		passed: diagnostic.passed(),
		violations: diagnostic.violations.clone(),
	}
}

fn validate_official_shaped_row(
	row: &PublicLeaderboardRow,
) -> Result<(), TestGeneratedFixtureError> {
	if row.scoring_version != AIQ_SCORING_VERSION
		|| row.score_status != "official"
		|| row.synthetic
		|| row.calibration_status != "calibrated"
		|| row.reliability_status != "single_matrix_information_only"
		|| row.sample_size != 72
		|| row.coverage_percent != 100.0
		|| row.runtime_issues != 0
		|| row.missing != 0
		|| !(0.0..=100.0).contains(&row.score)
		|| row.standard_error <= 0.0
		|| row.theta_ci_low > row.theta_ci_high
		|| row.score_ci_low < 0.0
		|| row.score_ci_high > 100.0
		|| !(row.score_ci_low <= row.score && row.score <= row.score_ci_high)
		|| !(0.0..=72.0).contains(&row.information)
		|| !(0.0..=100.0).contains(&row.quality_score)
		|| !(row.sensitivity_low <= row.quality_score && row.quality_score <= row.sensitivity_high)
		|| row.sensitivity_low < 0.0
		|| row.sensitivity_high > 100.0
		|| row.strict_pass_sample_size != 72
		|| !(0.0..=1.0).contains(&row.strict_pass_rate)
		|| !(row.strict_pass_low <= row.strict_pass_rate
			&& row.strict_pass_rate <= row.strict_pass_high)
		|| (row.strict_pass_rate
			- row.strict_pass_successes as f64 / row.strict_pass_sample_size as f64)
			.abs() > 1e-12
	{
		return Err(error("leaderboard projection violates the AIQ 2.0 public contract"));
	}

	Ok(())
}

fn validate_official_shaped_trend(row: &PublicTrendRow) -> Result<(), TestGeneratedFixtureError> {
	if row.scoring_version != AIQ_SCORING_VERSION
		|| row.synthetic
		|| row.calibration_status != "calibrated"
		|| row.reliability_status != "single_matrix_information_only"
		|| row.sample_size != 72
		|| row.represented_run_count != 1
		|| row.resolution_seconds == 0
		|| !(0.0..=100.0).contains(&row.score)
		|| row.standard_error <= 0.0
		|| row.theta_ci_low > row.theta_ci_high
		|| row.score_ci_low < 0.0
		|| row.score_ci_high > 100.0
		|| !(row.score_ci_low <= row.score && row.score <= row.score_ci_high)
		|| !(0.0..=72.0).contains(&row.information)
		|| !(0.0..=100.0).contains(&row.quality_score)
		|| !(row.sensitivity_low <= row.quality_score && row.quality_score <= row.sensitivity_high)
		|| row.sensitivity_low < 0.0
		|| row.sensitivity_high > 100.0
		|| row.strict_pass_sample_size != 72
		|| !(0.0..=1.0).contains(&row.strict_pass_rate)
		|| !(row.strict_pass_low <= row.strict_pass_rate
			&& row.strict_pass_rate <= row.strict_pass_high)
		|| (row.strict_pass_rate
			- row.strict_pass_successes as f64 / row.strict_pass_sample_size as f64)
			.abs() > 1e-12
	{
		return Err(error("trend projection violates the AIQ 2.0 public contract"));
	}

	Ok(())
}

fn error(message: impl Into<String>) -> TestGeneratedFixtureError {
	TestGeneratedFixtureError { message: message.into() }
}

fn error_message(context: &str, cause: impl Display) -> TestGeneratedFixtureError {
	error(format!("{context}: {cause}"))
}

#[cfg(test)]
mod tests {
	use std::sync::OnceLock;

	use crate::AIQ_SCORING_VERSION;
	use crate::public_fixture::TEST_GENERATED_FIXTURE_PROVENANCE;
	use crate::public_fixture::{self, TestGeneratedPublicFixture};
	use crate::runner;
	use crate::scoring::FalseOnly;

	fn fixture() -> &'static TestGeneratedPublicFixture {
		static FIXTURE: OnceLock<TestGeneratedPublicFixture> = OnceLock::new();

		FIXTURE.get_or_init(|| {
			public_fixture::generate_test_generated_public_fixture()
				.expect("test-generated fixture must generate")
		})
	}

	#[test]
	fn generated_fixture_has_complete_matrix_and_public_fields() {
		let fixture = fixture();

		fixture.validate().expect("fixture contract");

		assert_eq!(fixture.configuration_count, 17);
		assert_eq!(fixture.task_count, 72);
		assert_eq!(fixture.cell_count, 17 * 72);
		assert_eq!(fixture.leaderboard.len(), 17);
		assert_eq!(fixture.trend.len(), 17);
		assert!(
			fixture
				.task_cells
				.iter()
				.all(|cell| cell.provenance == TEST_GENERATED_FIXTURE_PROVENANCE)
		);
	}

	#[test]
	fn generated_fixture_keeps_latent_ci_and_sensitivity_semantics_distinct() {
		assert!(fixture().task_cells.iter().any(|cell| cell.evaluation == "partial"));
		assert!(
			fixture()
				.leaderboard
				.iter()
				.any(|row| { row.score < row.sensitivity_low || row.score > row.sensitivity_high })
		);

		for row in &fixture().leaderboard {
			assert!(row.score_ci_low <= row.score && row.score <= row.score_ci_high);
			assert!(row.sensitivity_low <= row.quality_score);
			assert!(row.quality_score <= row.sensitivity_high);
			assert!(
				(row.strict_pass_rate
					- row.strict_pass_successes as f64 / row.strict_pass_sample_size as f64)
					.abs() < 1e-12
			);
			assert_eq!(row.strict_pass_sample_size, 72);
			assert_eq!(row.sample_size, 72);
			assert_eq!(row.scoring_version, AIQ_SCORING_VERSION);
		}
	}

	#[test]
	fn fixture_float_normalization_absorbs_cross_platform_ulp_differences() {
		let baseline = -0.766_030_057_034_348_f64;
		let adjacent = f64::from_bits(baseline.to_bits() + 1);

		assert_ne!(baseline, adjacent);
		assert_eq!(
			public_fixture::stable_fixture_latent_float(baseline),
			public_fixture::stable_fixture_latent_float(adjacent)
		);
	}

	#[test]
	fn test_generated_provenance_cannot_enter_production_admission() {
		let fixture = fixture();

		assert!(fixture.production_admission().is_err());
		assert!(fixture.test_generated);
		assert!(fixture.synthetic);
		assert_eq!(fixture.official_eligible, FalseOnly);
		assert_eq!(fixture.ranking_eligible, FalseOnly);
		assert_eq!(fixture.production_publishable, FalseOnly);

		// The generated projection is deliberately not a RunRecord or a signed
		// package. A production package parser must reject it before publication.
		let value = serde_json::to_value(fixture).expect("fixture JSON");

		assert!(serde_json::from_value::<runner::RunRecord>(value).is_err());

		let mut tampered = serde_json::to_value(fixture).expect("fixture JSON");

		tampered["production_publishable"] = serde_json::json!(true);

		assert!(serde_json::from_value::<TestGeneratedPublicFixture>(tampered).is_err());
	}

	#[test]
	fn committed_browser_fixture_is_generated_by_this_path() {
		let committed = serde_json::from_str::<TestGeneratedPublicFixture>(include_str!(
			"../../../benchmarks/fixtures/aiq-2.0-test-generated-public.json"
		))
		.expect("committed browser fixture JSON");

		assert_eq!(&committed, fixture());
	}
}
