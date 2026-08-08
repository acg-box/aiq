//! Deterministic direct capacity metadata for one benchmark run.

use std::{
	error::Error,
	fmt::{Display, Formatter},
};

use serde::{Deserialize, Serialize};

use crate::task::MAX_PARALLEL_EXTERNAL_EVALUATORS;
use crate::{
	model::{MODEL_MATRIX, ModelConfig},
	protocol,
	runner::MAX_RUN_JOBS,
	task::TaskDefinition,
};

/// Direct capacity estimate schema version.
pub const CAPACITY_ADMISSION_SCHEMA_VERSION: &str = "aiq.capacity-admission.v2";

/// Deterministic capacity data for one selected run.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CapacityAdmission {
	/// Capacity estimate schema version.
	pub schema_version: String,
	/// Digest of the active capability report.
	pub capability_validation_digest: String,
	/// Ordered actively available model configurations.
	pub available_models: Vec<ModelConfig>,
	/// Ordered actively observed-unsupported model configurations.
	pub observed_unsupported_models: Vec<ModelConfig>,
	/// Operator-selected worker count.
	pub configured_jobs: usize,
	/// Workers that can execute actively available cells.
	pub effective_jobs: usize,
	/// Number of selected task and model cells.
	pub selected_cells: usize,
	/// Number of selected cells that invoke an available model.
	pub runnable_cell_count: usize,
	/// Sum of declared wall budgets for available cells, or `None` for unbounded execution.
	pub declared_wall_budget_sum_seconds: Option<u64>,
	/// Maximum declared wall budget for one available cell, or `None` for unbounded execution.
	pub maximum_cell_wall_budget_seconds: Option<u64>,
	/// Conservative list-scheduling bound for Codex execution, or `None` when it is unbounded.
	pub model_execution_bound_seconds: Option<u64>,
	/// Sum of aggregate two-pass evaluator deadlines for every runnable cell.
	pub declared_evaluator_budget_sum_ms: u64,
	/// Shared-runtime evaluator permits available to this run.
	pub effective_evaluator_jobs: usize,
	/// Conservative bound for the bounded evaluator pool.
	pub evaluator_bound_seconds: u64,
	/// Explicit local orchestration and artifact finalization reserve.
	pub orchestration_reserve_seconds: u64,
	/// Exact interval from this slot to the next configured slot.
	pub seconds_until_next_slot: u64,
	/// End-to-end bound, or `None` because any selected model execution is unbounded.
	pub conservative_bound_seconds: Option<u64>,
}
impl CapacityAdmission {
	/// Returns the canonical estimate content address.
	pub fn digest(&self) -> Result<String, CapacityError> {
		protocol::canonical_hash(self).map_err(|error| CapacityError::new(error.to_string()))
	}

	/// Converts this estimate to the immutable checkpoint and provenance binding.
	pub fn commitment(&self) -> Result<CapacityCommitment, CapacityError> {
		Ok(CapacityCommitment {
			capability_validation_digest: self.capability_validation_digest.clone(),
			runnable_cell_count: self.runnable_cell_count,
			admission_digest: self.digest()?,
			configured_jobs: self.configured_jobs,
			effective_jobs: self.effective_jobs,
			seconds_until_next_slot: self.seconds_until_next_slot,
			conservative_bound_seconds: self.conservative_bound_seconds,
		})
	}
}

/// Immutable checkpoint and provenance binding for direct capacity data.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CapacityCommitment {
	/// Digest of the active capability report.
	pub capability_validation_digest: String,
	/// Number of selected cells that invoke an available model.
	pub runnable_cell_count: usize,
	/// Canonical capacity estimate content address.
	pub admission_digest: String,
	/// Operator-selected worker count.
	pub configured_jobs: usize,
	/// Workers that can execute actively available cells.
	pub effective_jobs: usize,
	/// Exact interval to the next configured slot.
	pub seconds_until_next_slot: u64,
	/// Deterministic conservative estimate, or `None` for unbounded model execution.
	pub conservative_bound_seconds: Option<u64>,
}

/// Capacity arithmetic or input failure.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CapacityError {
	message: String,
}
impl CapacityError {
	fn new(message: impl Into<String>) -> Self {
		Self { message: message.into() }
	}
}

impl Error for CapacityError {}

impl Display for CapacityError {
	fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
		formatter.write_str(&self.message)
	}
}

struct EvaluatorCapacity {
	declared_budget_sum_ms: u64,
	effective_jobs: usize,
	bound_seconds: u64,
}

/// Builds direct capacity data from active support and `--jobs`.
pub fn assess_capacity(
	tasks: &[TaskDefinition],
	selected_models: &[ModelConfig],
	available_models: &[ModelConfig],
	observed_unsupported_models: &[ModelConfig],
	capability_validation_digest: &str,
	configured_jobs: usize,
	seconds_until_next_slot: u64,
) -> Result<CapacityAdmission, CapacityError> {
	if tasks.is_empty() || selected_models.is_empty() {
		return Err(CapacityError::new("capacity selection cannot be empty"));
	}
	if !(1..=MAX_RUN_JOBS).contains(&configured_jobs) {
		return Err(CapacityError::new("configured jobs are outside the accepted range"));
	}
	if seconds_until_next_slot == 0 {
		return Err(CapacityError::new("next schedule interval is unknown or zero"));
	}
	if !valid_digest(capability_validation_digest)
		|| !valid_support_partition(available_models, observed_unsupported_models)
	{
		return Err(CapacityError::new("active capability partition is invalid"));
	}

	let active_models =
		selected_models.iter().filter(|model| available_models.contains(model)).count();
	let selected_cells = tasks
		.len()
		.checked_mul(selected_models.len())
		.ok_or_else(|| CapacityError::new("selected cell count overflows"))?;
	let runnable_cell_count = tasks
		.len()
		.checked_mul(active_models)
		.ok_or_else(|| CapacityError::new("runnable cell count overflows"))?;
	let effective_jobs = configured_jobs.min(runnable_cell_count);
	let wall_budgets =
		tasks.iter().map(|task| task.budgets.wall_seconds).collect::<Option<Vec<_>>>();
	let active_model_count = u64::try_from(active_models)
		.map_err(|_| CapacityError::new("available model count overflows"))?;
	let (declared_wall_budget_sum_seconds, maximum_cell_wall_budget_seconds) =
		declared_wall_budget_metrics(&wall_budgets, active_model_count, runnable_cell_count)?;
	let model_execution_bound_seconds = model_execution_bound(
		declared_wall_budget_sum_seconds,
		maximum_cell_wall_budget_seconds,
		effective_jobs,
	)?;
	let evaluator = assess_evaluator_capacity(tasks, active_models, effective_jobs)?;
	let declared_execution_bound_seconds = model_execution_bound_seconds
		.map(|bound| {
			bound
				.checked_add(evaluator.bound_seconds)
				.ok_or_else(|| CapacityError::new("combined capacity bound overflows"))
		})
		.transpose()?;
	let orchestration_reserve_seconds = if runnable_cell_count == 0 {
		0
	} else {
		declared_execution_bound_seconds.map_or(900, |bound| 900_u64.max(bound.div_ceil(20)))
	};
	let conservative_bound_seconds = declared_execution_bound_seconds
		.map(|bound| {
			bound
				.checked_add(orchestration_reserve_seconds)
				.ok_or_else(|| CapacityError::new("end-to-end capacity bound overflows"))
		})
		.transpose()?;

	if conservative_bound_seconds.is_some_and(|bound| bound >= seconds_until_next_slot) {
		return Err(CapacityError::new(
			"declared model, evaluator, and orchestration bound does not fit before the next slot",
		));
	}

	Ok(CapacityAdmission {
		schema_version: CAPACITY_ADMISSION_SCHEMA_VERSION.to_owned(),
		capability_validation_digest: capability_validation_digest.to_owned(),
		available_models: available_models.to_vec(),
		observed_unsupported_models: observed_unsupported_models.to_vec(),
		configured_jobs,
		effective_jobs,
		selected_cells,
		runnable_cell_count,
		declared_wall_budget_sum_seconds,
		maximum_cell_wall_budget_seconds,
		model_execution_bound_seconds,
		declared_evaluator_budget_sum_ms: evaluator.declared_budget_sum_ms,
		effective_evaluator_jobs: evaluator.effective_jobs,
		evaluator_bound_seconds: evaluator.bound_seconds,
		orchestration_reserve_seconds,
		seconds_until_next_slot,
		conservative_bound_seconds,
	})
}

fn declared_wall_budget_metrics(
	wall_budgets: &Option<Vec<u64>>,
	active_model_count: u64,
	runnable_cell_count: usize,
) -> Result<(Option<u64>, Option<u64>), CapacityError> {
	if runnable_cell_count == 0 {
		return Ok((Some(0), Some(0)));
	}

	let Some(wall_budgets) = wall_budgets else {
		return Ok((None, None));
	};
	let one_model_sum = wall_budgets.iter().try_fold(0_u64, |sum, budget| {
		sum.checked_add(*budget)
			.ok_or_else(|| CapacityError::new("declared wall budget sum overflows"))
	})?;
	let sum = one_model_sum
		.checked_mul(active_model_count)
		.ok_or_else(|| CapacityError::new("declared wall budget sum overflows"))?;
	let maximum = wall_budgets.iter().copied().max().unwrap_or(0);

	Ok((Some(sum), Some(maximum)))
}

fn model_execution_bound(
	declared_sum: Option<u64>,
	maximum_cell: Option<u64>,
	effective_jobs: usize,
) -> Result<Option<u64>, CapacityError> {
	if effective_jobs == 0 {
		return Ok(Some(0));
	}

	let (Some(declared_sum), Some(maximum_cell)) = (declared_sum, maximum_cell) else {
		return Ok(None);
	};
	let workers =
		u64::try_from(effective_jobs).map_err(|_| CapacityError::new("effective jobs overflow"))?;
	let bound = declared_sum
		.checked_add(workers - 1)
		.map(|sum| sum / workers)
		.and_then(|bound| bound.checked_add(maximum_cell))
		.ok_or_else(|| CapacityError::new("capacity bound overflows"))?;

	Ok(Some(bound))
}

fn assess_evaluator_capacity(
	tasks: &[TaskDefinition],
	active_models: usize,
	effective_jobs: usize,
) -> Result<EvaluatorCapacity, CapacityError> {
	let one_model_budget_sum_ms = tasks.iter().try_fold(0_u64, |sum, task| {
		let timeout_ms = task
			.evaluator
			.as_ref()
			.and_then(|evaluator| evaluator.external.as_ref())
			.map_or(0, |binding| binding.timeout_ms);

		sum.checked_add(timeout_ms)
			.ok_or_else(|| CapacityError::new("evaluator budget sum overflows"))
	})?;
	let maximum_timeout_ms = tasks
		.iter()
		.filter_map(|task| {
			task.evaluator.as_ref()?.external.as_ref().map(|binding| binding.timeout_ms)
		})
		.max()
		.unwrap_or(0);
	let active_model_count = u64::try_from(active_models)
		.map_err(|_| CapacityError::new("available model count overflows"))?;
	let declared_budget_sum_ms = one_model_budget_sum_ms
		.checked_mul(active_model_count)
		.ok_or_else(|| CapacityError::new("evaluator budget sum overflows"))?;
	let evaluator_cell_count = tasks
		.iter()
		.filter(|task| {
			task.evaluator.as_ref().is_some_and(|evaluator| evaluator.external.is_some())
		})
		.count()
		.checked_mul(active_models)
		.ok_or_else(|| CapacityError::new("evaluator cell count overflows"))?;
	let effective_jobs =
		effective_jobs.min(MAX_PARALLEL_EXTERNAL_EVALUATORS).min(evaluator_cell_count);
	let bound_seconds = if effective_jobs == 0 {
		0
	} else {
		let permits = u64::try_from(effective_jobs)
			.map_err(|_| CapacityError::new("evaluator permit count overflows"))?;
		let bound_ms = declared_budget_sum_ms
			.checked_add(permits - 1)
			.map(|sum| sum / permits)
			.and_then(|bound| bound.checked_add(maximum_timeout_ms))
			.ok_or_else(|| CapacityError::new("evaluator capacity bound overflows"))?;

		bound_ms
			.checked_add(999)
			.map(|milliseconds| milliseconds / 1_000)
			.ok_or_else(|| CapacityError::new("evaluator capacity conversion overflows"))?
	};

	Ok(EvaluatorCapacity { declared_budget_sum_ms, effective_jobs, bound_seconds })
}

fn valid_support_partition(
	available_models: &[ModelConfig],
	observed_unsupported_models: &[ModelConfig],
) -> bool {
	let mut available_index = 0;
	let mut unsupported_index = 0;

	for model in MODEL_MATRIX {
		if available_models.get(available_index) == Some(&model) {
			available_index += 1;
		} else if observed_unsupported_models.get(unsupported_index) == Some(&model) {
			unsupported_index += 1;
		} else {
			return false;
		}
	}

	available_index == available_models.len()
		&& unsupported_index == observed_unsupported_models.len()
}

fn valid_digest(value: &str) -> bool {
	value.strip_prefix("sha256:").is_some_and(|hex| {
		hex.len() == 64
			&& hex.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
			&& hex.bytes().any(|byte| byte != b'0')
	})
}

#[cfg(test)]
mod tests {
	use std::{collections::BTreeMap, path::PathBuf};

	use crate::{
		model::MODEL_MATRIX,
		runner,
		task::{EVALUATOR_PROTOCOL_VERSION, EvaluatorRuntimeKind, ExternalEvaluatorBinding},
	};

	fn digest() -> String {
		format!("sha256:{}", "a".repeat(64))
	}

	#[test]
	fn direct_capacity_uses_available_cells_and_jobs() {
		let tasks = runner::synthetic_demo_tasks();
		let available = MODEL_MATRIX[..2].to_vec();
		let unsupported = MODEL_MATRIX[2..].to_vec();
		let estimate = super::assess_capacity(
			&tasks[..2],
			&MODEL_MATRIX,
			&available,
			&unsupported,
			&digest(),
			3,
			43_200,
		)
		.expect("capacity estimate");

		assert_eq!(estimate.selected_cells, 34);
		assert_eq!(estimate.runnable_cell_count, 4);
		assert_eq!(estimate.effective_jobs, 3);
		assert_eq!(estimate.commitment().expect("commitment").configured_jobs, 3);
	}

	#[test]
	fn unbounded_model_tasks_do_not_claim_or_enforce_a_schedule_fit() {
		let mut tasks = runner::synthetic_demo_tasks();

		for task in &mut tasks[..2] {
			task.budgets.wall_seconds = None;
		}

		let available = MODEL_MATRIX[..2].to_vec();
		let unsupported = MODEL_MATRIX[2..].to_vec();
		let estimate = super::assess_capacity(
			&tasks[..2],
			&MODEL_MATRIX,
			&available,
			&unsupported,
			&digest(),
			3,
			1,
		)
		.expect("unbounded model execution must not be rejected by a guessed duration");

		assert_eq!(estimate.schema_version, super::CAPACITY_ADMISSION_SCHEMA_VERSION);
		assert_eq!(estimate.declared_wall_budget_sum_seconds, None);
		assert_eq!(estimate.maximum_cell_wall_budget_seconds, None);
		assert_eq!(estimate.model_execution_bound_seconds, None);
		assert_eq!(estimate.conservative_bound_seconds, None);
		assert_eq!(estimate.commitment().expect("commitment").conservative_bound_seconds, None);
	}

	#[test]
	fn unsupported_cells_have_zero_execution_capacity() {
		let tasks = runner::synthetic_demo_tasks();
		let estimate = super::assess_capacity(
			&tasks[..1],
			&MODEL_MATRIX,
			&[],
			&MODEL_MATRIX,
			&digest(),
			1,
			43_200,
		)
		.expect("capacity estimate");

		assert_eq!(estimate.selected_cells, 17);
		assert_eq!(estimate.runnable_cell_count, 0);
		assert_eq!(estimate.effective_jobs, 0);
		assert_eq!(estimate.conservative_bound_seconds, Some(0));
	}

	#[test]
	fn external_evaluator_deadlines_are_bound_and_must_fit_the_slot() {
		let mut tasks = runner::synthetic_demo_tasks();
		let scorer_version = tasks[0].scorer_version.clone();
		let evaluator = tasks[0].evaluator.as_mut().expect("synthetic evaluator");

		evaluator.kind = "controlled_fixture".to_owned();
		evaluator.expected = None;
		evaluator.external = Some(ExternalEvaluatorBinding {
			protocol_version: EVALUATOR_PROTOCOL_VERSION.to_owned(),
			scorer_version,
			runtime_kind: EvaluatorRuntimeKind::Node,
			runtime_executable_digest: format!("sha256:{}", "b".repeat(64)),
			executable_ref: PathBuf::from("fixture/evaluator.mjs"),
			executable_digest: format!("sha256:{}", "c".repeat(64)),
			configuration_digest: format!("sha256:{}", "d".repeat(64)),
			arguments: Vec::new(),
			timeout_ms: 10_000,
			max_input_bytes: 1_024,
			max_output_bytes: 1_024,
			configuration: BTreeMap::new(),
		});

		let available = MODEL_MATRIX[..2].to_vec();
		let unsupported = MODEL_MATRIX[2..].to_vec();
		let estimate = super::assess_capacity(
			&tasks[..1],
			&MODEL_MATRIX,
			&available,
			&unsupported,
			&digest(),
			2,
			43_200,
		)
		.expect("capacity estimate with evaluator work");

		assert_eq!(estimate.declared_evaluator_budget_sum_ms, 20_000);
		assert_eq!(estimate.effective_evaluator_jobs, 2);
		assert_eq!(estimate.evaluator_bound_seconds, 20);
		assert_eq!(
			estimate.conservative_bound_seconds,
			Some(
				estimate.model_execution_bound_seconds.expect("bounded model estimate")
					+ estimate.evaluator_bound_seconds
					+ estimate.orchestration_reserve_seconds
			)
		);
		assert!(
			super::assess_capacity(
				&tasks[..1],
				&MODEL_MATRIX,
				&available,
				&unsupported,
				&digest(),
				2,
				estimate.conservative_bound_seconds.expect("bounded total estimate"),
			)
			.is_err()
		);
	}

	#[test]
	fn invalid_jobs_and_partitions_fail() {
		let tasks = runner::synthetic_demo_tasks();

		assert!(
			super::assess_capacity(
				&tasks[..1],
				&MODEL_MATRIX,
				&MODEL_MATRIX,
				&[],
				&digest(),
				0,
				43_200,
			)
			.is_err()
		);
		assert!(
			super::assess_capacity(
				&tasks[..1],
				&MODEL_MATRIX,
				&MODEL_MATRIX[..1],
				&[],
				&digest(),
				1,
				43_200,
			)
			.is_err()
		);
	}
}
