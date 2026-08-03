//! Deterministic bridge from persisted runner evaluator results to the
//! immutable AIQ Core 1.0.2 four-component release-gate protocol.
//!
//! The bridge depends only on public check identifiers, integer weights, pass
//! bits, and content digests. It does not read controlled prompts, fixtures, or
//! evaluator configuration content.

use crate::{
	candidate_release_gate::{
		self, CANDIDATE_EVALUATOR_RESULT_SCHEMA, CANDIDATE_SCORER_VERSION,
		CANDIDATE_TASK_SET_VERSION, CandidateAssertion, CandidateEvaluatorComponent,
		CandidateEvaluatorResult, CandidateGateError,
	},
	task::{EvaluationResult, EvaluatorCheckFailureClass},
};

const COMPONENT_LAYOUT: [(&str, u32, u32); 4] = [
	("component_01", 3_000, 750),
	("component_02", 2_500, 625),
	("component_03", 2_500, 625),
	("component_04", 2_000, 500),
];
const ASSERTIONS_PER_COMPONENT: usize = 4;
const CANDIDATE_CHECK_COUNT: usize = COMPONENT_LAYOUT.len() * ASSERTIONS_PER_COMPONENT;

/// Converts one validated persisted evaluator result into the exact candidate
/// component protocol used by release-gate evidence and independent replay.
///
/// The input must contain exactly sixteen checks in canonical component and
/// assertion order. This prevents an assembler from reinterpreting a legacy or
/// unrelated evaluator result as AIQ Core 1.0.2 evidence.
pub fn candidate_evaluator_result_from_persisted(
	task_id: &str,
	task_version: &str,
	evaluation: &EvaluationResult,
) -> Result<CandidateEvaluatorResult, CandidateGateError> {
	evaluation.validate_persisted().map_err(|error| {
		CandidateGateError::new(format!("candidate evaluator result is invalid: {error}"))
	})?;

	if task_version != CANDIDATE_TASK_SET_VERSION {
		return Err(CandidateGateError::new(
			"candidate evaluator conversion requires task version 1.0.2",
		));
	}
	if evaluation.checks.len() != CANDIDATE_CHECK_COUNT {
		return Err(CandidateGateError::new(
			"candidate evaluator conversion requires exactly sixteen ordered checks",
		));
	}

	let mut components = Vec::with_capacity(COMPONENT_LAYOUT.len());
	let mut cursor = 0_usize;

	for (component_id, component_weight, assertion_weight) in COMPONENT_LAYOUT {
		let mut assertions = Vec::with_capacity(ASSERTIONS_PER_COMPONENT);

		for assertion_index in 1..=ASSERTIONS_PER_COMPONENT {
			let check = &evaluation.checks[cursor];
			let expected_id = format!("{component_id}_assertion_{assertion_index:02}");

			if check.check_id != expected_id
				|| check.weight != assertion_weight
				|| check.failure_class == EvaluatorCheckFailureClass::Structural
			{
				return Err(CandidateGateError::new(
					"candidate evaluator check identity, order, weight, or failure class is invalid",
				));
			}

			assertions.push(CandidateAssertion {
				assertion_id: check.check_id.clone(),
				passed: check.passed,
				evidence_sha256: check.evidence_digest.clone(),
			});

			cursor += 1;
		}

		components.push(CandidateEvaluatorComponent {
			component_id: component_id.to_owned(),
			weight_basis_points: component_weight,
			assertions,
		});
	}

	let (score_numerator, score_denominator) =
		candidate_release_gate::candidate_score_fraction(&components)?;
	let reconstructed_score = score_numerator as f64 / score_denominator as f64;

	if (evaluation.score - reconstructed_score).abs() > f64::EPSILON * 4.0 {
		return Err(CandidateGateError::new(
			"candidate evaluator flat score differs from the four-component score",
		));
	}

	let result = CandidateEvaluatorResult {
		schema_version: CANDIDATE_EVALUATOR_RESULT_SCHEMA.to_owned(),
		task_id: task_id.to_owned(),
		task_version: task_version.to_owned(),
		scorer_version: CANDIDATE_SCORER_VERSION.to_owned(),
		components,
		score_numerator,
		score_denominator,
		score_decimal_6: decimal_6(score_numerator, score_denominator)?,
	};

	result.validate()?;

	Ok(result)
}

fn decimal_6(numerator: u64, denominator: u64) -> Result<String, CandidateGateError> {
	let scaled = numerator
		.checked_mul(1_000_000)
		.and_then(|value| value.checked_add(denominator / 2))
		.ok_or_else(|| CandidateGateError::new("candidate decimal score overflows"))?
		/ denominator;

	Ok(format!("{}.{:06}", scaled / 1_000_000, scaled % 1_000_000))
}

#[cfg(test)]
mod tests {
	use crate::candidate_evidence::{
		self, ASSERTIONS_PER_COMPONENT, CANDIDATE_TASK_SET_VERSION, COMPONENT_LAYOUT,
		EvaluationResult, EvaluatorCheckFailureClass,
	};
	use crate::task::{EVALUATOR_RESULT_SCHEMA_VERSION, EvaluatorCheck, EvaluatorOutcome};

	fn digest(character: char) -> String {
		format!("sha256:{}", character.to_string().repeat(64))
	}

	fn indexed_digest(index: usize) -> String {
		format!("sha256:{:064x}", index + 1)
	}

	fn evaluation(failed: &[usize]) -> EvaluationResult {
		let mut checks = Vec::new();
		let mut passed_weight = 0_u64;

		for (component_index, (component_id, _, assertion_weight)) in
			COMPONENT_LAYOUT.into_iter().enumerate()
		{
			for assertion_index in 1..=ASSERTIONS_PER_COMPONENT {
				let index = component_index * ASSERTIONS_PER_COMPONENT + assertion_index - 1;
				let passed = !failed.contains(&index);

				if passed {
					passed_weight += u64::from(assertion_weight);
				}

				checks.push(EvaluatorCheck {
					check_id: format!("{component_id}_assertion_{assertion_index:02}"),
					weight: assertion_weight,
					passed,
					failure_class: if passed {
						EvaluatorCheckFailureClass::None
					} else {
						EvaluatorCheckFailureClass::Value
					},
					evidence_digest: indexed_digest(index),
				});
			}
		}

		let score = passed_weight as f64 / 10_000.0;

		EvaluationResult {
			schema_version: EVALUATOR_RESULT_SCHEMA_VERSION.to_owned(),
			outcome: if score == 1.0 {
				EvaluatorOutcome::Correct
			} else if score == 0.0 {
				EvaluatorOutcome::Incorrect
			} else {
				EvaluatorOutcome::Partial
			},
			score,
			checks,
			raw_stdout_sha256: Some(digest('f')),
		}
	}

	#[test]
	fn converts_exact_sixteen_check_protocol_without_private_inputs() {
		let converted = candidate_evidence::candidate_evaluator_result_from_persisted(
			"coding-01",
			CANDIDATE_TASK_SET_VERSION,
			&evaluation(&[1, 7, 15]),
		)
		.expect("candidate conversion");

		assert_eq!(converted.components.len(), 4);
		assert_eq!(converted.components[0].assertions.len(), 4);
		assert_eq!(converted.components[0].weight_basis_points, 3_000);
		assert_eq!(converted.score_numerator, 13);
		assert_eq!(converted.score_denominator, 16);
		assert_eq!(converted.score_decimal_6, "0.812500");

		converted.validate().expect("candidate result");
	}

	#[test]
	fn rejects_legacy_count_reordering_weight_and_structural_failure() {
		let mut wrong_count = evaluation(&[]);

		wrong_count.checks.pop();

		assert!(
			candidate_evidence::candidate_evaluator_result_from_persisted(
				"coding-01",
				CANDIDATE_TASK_SET_VERSION,
				&wrong_count,
			)
			.is_err()
		);

		let mut reordered = evaluation(&[]);

		reordered.checks.swap(0, 1);

		assert!(
			candidate_evidence::candidate_evaluator_result_from_persisted(
				"coding-01",
				CANDIDATE_TASK_SET_VERSION,
				&reordered,
			)
			.is_err()
		);

		let mut wrong_weight = evaluation(&[]);

		wrong_weight.checks[0].weight = 749;

		assert!(
			candidate_evidence::candidate_evaluator_result_from_persisted(
				"coding-01",
				CANDIDATE_TASK_SET_VERSION,
				&wrong_weight,
			)
			.is_err()
		);

		let mut structural = evaluation(&[0]);

		structural.checks[0].failure_class = EvaluatorCheckFailureClass::Structural;

		assert!(
			candidate_evidence::candidate_evaluator_result_from_persisted(
				"coding-01",
				CANDIDATE_TASK_SET_VERSION,
				&structural,
			)
			.is_err()
		);
	}

	#[test]
	fn rejects_non_candidate_version_and_flat_score_drift() {
		assert!(
			candidate_evidence::candidate_evaluator_result_from_persisted(
				"coding-01",
				"1.0.1",
				&evaluation(&[]),
			)
			.is_err()
		);

		let mut drifted = evaluation(&[0]);

		drifted.score += 0.01;

		assert!(
			candidate_evidence::candidate_evaluator_result_from_persisted(
				"coding-01",
				CANDIDATE_TASK_SET_VERSION,
				&drifted,
			)
			.is_err()
		);
	}
}
