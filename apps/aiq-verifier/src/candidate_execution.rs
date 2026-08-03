//! Candidate execution-unit verification and independent evaluator replay.

use std::path::Path;

use crate::replay;
use crate::{ArtifactResolverClient, ReasonCode, WorkerError, candidate_release_gate};
use aiq_runner::runner::TaskResult;
use aiq_runner::{
	candidate_artifacts::{
		CANDIDATE_CELL_VERIFICATION_PAYLOAD_TYPE, CandidateArtifactError,
		CandidateCellEvaluatorPayload, CandidateCellVerificationPayload,
		CandidateEvaluatorResultBundle, CandidateResultPackageBundle, CandidateSigningIdentity,
		CandidateUnitBinding, CandidateVerificationDisposition, CandidateVerifierReplayBundle,
	},
	candidate_evidence,
	candidate_release_gate::{
		CandidateEvaluatorResult, CandidateExecutionAuthorization, CandidateExecutionUnit,
		CandidateGateError,
	},
	runner::ResultStatus,
	task::{EvaluationResult, EvaluatorRuntime, TaskDefinition},
};

#[derive(Debug, Eq, PartialEq)]
struct CellReplayDisposition {
	replayed_evaluator_sha256: Option<String>,
	verified: bool,
	disposition: CandidateVerificationDisposition,
}

/// Verifies both runner bundles, independently replays the embedded unit run,
/// and signs one exact verifier disposition for every cell.
#[allow(clippy::too_many_arguments)]
pub(crate) fn verify_candidate_execution_unit<R>(
	authorization: &CandidateExecutionAuthorization,
	unit: &CandidateExecutionUnit,
	results: &CandidateResultPackageBundle,
	evaluators: &CandidateEvaluatorResultBundle,
	tasks: &[TaskDefinition],
	resolver: &R,
	evaluator_root: &Path,
	evaluator_runtime: &EvaluatorRuntime,
	replay_root: &Path,
	claim_identity: &str,
	verifier_identity: &CandidateSigningIdentity,
) -> Result<CandidateVerifierReplayBundle, WorkerError>
where
	R: ArtifactResolverClient + ?Sized,
{
	require_authorized_verifier(authorization, verifier_identity)?;

	let unit_payload = results.verify(authorization, unit).map_err(invalid_candidate_artifact)?;
	let committed =
		evaluators.verify(authorization, unit, results).map_err(invalid_candidate_artifact)?;
	let replay = replay::replay_production_run(
		&unit_payload.run,
		tasks,
		resolver,
		evaluator_root,
		evaluator_runtime,
		replay_root,
		claim_identity,
	)?;

	if replay.evaluator_results.len() != unit_payload.run.results.len()
		|| committed.len() != unit_payload.run.results.len()
	{
		return Err(WorkerError::terminal(
			ReasonCode::InvalidReplayEvidence,
			"candidate replay result count does not match the authorized unit",
		));
	}

	let mut payloads = Vec::with_capacity(unit_payload.run.results.len());

	for (index, ((result, committed), replayed)) in
		unit_payload.run.results.iter().zip(&committed).zip(replay.evaluator_results).enumerate()
	{
		let replayed = replayed
			.as_ref()
			.map(|evaluation| replayed_candidate_result(result, evaluation))
			.transpose()?;
		let disposition = cell_replay_disposition(
			result.status,
			committed.evaluator.as_ref(),
			replayed.as_ref(),
		)?;

		payloads.push(cell_verification_payload(
			&results.unit,
			committed,
			results.cells[index].digest().map_err(invalid_candidate_artifact)?,
			evaluators.cells[index].digest().map_err(invalid_candidate_artifact)?,
			disposition,
		));
	}

	CandidateVerifierReplayBundle::sign(
		authorization,
		unit,
		results,
		evaluators,
		payloads,
		verifier_identity,
	)
	.map_err(invalid_candidate_artifact)
}

fn require_authorized_verifier(
	authorization: &CandidateExecutionAuthorization,
	identity: &CandidateSigningIdentity,
) -> Result<(), WorkerError> {
	let controlled = &authorization.plan.controlled_inputs;

	if identity.node().node_id != controlled.verifier_signer_node_id
		|| identity.node().node_id == controlled.runner_signer_node_id
	{
		return Err(WorkerError::terminal(
			ReasonCode::InvalidPackageSignature,
			"candidate verifier identity is not the distinct authorized verifier",
		));
	}

	Ok(())
}

fn replayed_candidate_result(
	result: &TaskResult,
	evaluation: &EvaluationResult,
) -> Result<CandidateEvaluatorResult, WorkerError> {
	candidate_evidence::candidate_evaluator_result_from_persisted(
		&result.task_id,
		&result.task_version,
		evaluation,
	)
	.map_err(candidate_replay_mismatch)
}

fn cell_replay_disposition(
	status: ResultStatus,
	committed: Option<&CandidateEvaluatorResult>,
	replayed: Option<&CandidateEvaluatorResult>,
) -> Result<CellReplayDisposition, WorkerError> {
	if status == ResultStatus::Completed {
		let committed = committed.ok_or_else(|| {
			WorkerError::terminal(
				ReasonCode::EvaluatorReplayMismatch,
				"completed candidate cell lacks its committed evaluator result",
			)
		})?;
		let replayed = replayed.ok_or_else(|| {
			WorkerError::terminal(
				ReasonCode::EvaluatorReplayMismatch,
				"completed candidate cell lacks an independent replay result",
			)
		})?;
		let proof = candidate_release_gate::verify_candidate_evaluator_replay(committed, replayed)
			.map_err(candidate_replay_mismatch)?;

		return Ok(CellReplayDisposition {
			replayed_evaluator_sha256: Some(proof.replayed_result_sha256),
			verified: true,
			disposition: CandidateVerificationDisposition::CandidateEvaluatorReplayed,
		});
	}
	if committed.is_some() || replayed.is_some() {
		return Err(WorkerError::terminal(
			ReasonCode::EvaluatorReplayMismatch,
			"noncompleted candidate cell contains evaluator replay evidence",
		));
	}

	Ok(CellReplayDisposition {
		replayed_evaluator_sha256: None,
		verified: false,
		disposition: CandidateVerificationDisposition::CandidateResultNoncompletedNotVerified,
	})
}

fn cell_verification_payload(
	unit: &CandidateUnitBinding,
	committed: &CandidateCellEvaluatorPayload,
	result_package_sha256: String,
	evaluator_package_sha256: String,
	disposition: CellReplayDisposition,
) -> CandidateCellVerificationPayload {
	CandidateCellVerificationPayload {
		schema_version: CANDIDATE_CELL_VERIFICATION_PAYLOAD_TYPE.to_owned(),
		unit: unit.clone(),
		cell: committed.cell.clone(),
		result_package_sha256,
		evaluator_package_sha256,
		replayed_evaluator_sha256: disposition.replayed_evaluator_sha256,
		verified: disposition.verified,
		disposition: disposition.disposition,
	}
}

fn invalid_candidate_artifact(error: CandidateArtifactError) -> WorkerError {
	WorkerError::terminal(ReasonCode::InvalidPackageSignature, error.to_string())
}

fn candidate_replay_mismatch(error: CandidateGateError) -> WorkerError {
	WorkerError::terminal(ReasonCode::EvaluatorReplayMismatch, error.to_string())
}

#[cfg(test)]
mod tests {
	use crate::candidate_execution::{self, CandidateEvaluatorResult, ResultStatus};
	use aiq_runner::candidate_artifacts::CandidateVerificationDisposition;
	use aiq_runner::candidate_release_gate::{
		CANDIDATE_EVALUATOR_RESULT_SCHEMA, CandidateAssertion, CandidateEvaluatorComponent,
	};

	fn candidate_result() -> CandidateEvaluatorResult {
		let weights = [3_000, 2_500, 2_500, 2_000];

		CandidateEvaluatorResult {
			schema_version: CANDIDATE_EVALUATOR_RESULT_SCHEMA.to_owned(),
			task_id: "coding-01".to_owned(),
			task_version: "1.0.2".to_owned(),
			scorer_version: "1.0.2".to_owned(),
			components: weights
				.into_iter()
				.enumerate()
				.map(|(component_index, weight_basis_points)| CandidateEvaluatorComponent {
					component_id: format!("component_{:02}", component_index + 1),
					weight_basis_points,
					assertions: (0..4)
						.map(|assertion_index| CandidateAssertion {
							assertion_id: format!(
								"component_{:02}_assertion_{:02}",
								component_index + 1,
								assertion_index + 1
							),
							passed: true,
							evidence_sha256: format!(
								"sha256:{}",
								char::from(b'a' + assertion_index as u8).to_string().repeat(64)
							),
						})
						.collect(),
				})
				.collect(),
			score_numerator: 1,
			score_denominator: 1,
			score_decimal_6: "1.000000".to_owned(),
		}
	}

	#[test]
	fn completed_cell_requires_equal_replay_and_records_digest() {
		let result = candidate_result();
		let expected_digest = result.digest().expect("digest");
		let disposition = candidate_execution::cell_replay_disposition(
			ResultStatus::Completed,
			Some(&result),
			Some(&result),
		)
		.expect("disposition");

		assert!(disposition.verified);
		assert_eq!(
			disposition.replayed_evaluator_sha256.as_deref(),
			Some(expected_digest.as_str())
		);
		assert_eq!(
			disposition.disposition,
			CandidateVerificationDisposition::CandidateEvaluatorReplayed
		);
	}

	#[test]
	fn completed_cell_rejects_changed_replay() {
		let committed = candidate_result();
		let mut replayed = committed.clone();

		replayed.components[0].assertions[0].passed = false;

		assert!(
			candidate_execution::cell_replay_disposition(
				ResultStatus::Completed,
				Some(&committed),
				Some(&replayed),
			)
			.is_err()
		);
	}

	#[test]
	fn completed_cell_rejects_missing_replay_or_commitment() {
		let result = candidate_result();

		assert!(
			candidate_execution::cell_replay_disposition(
				ResultStatus::Completed,
				Some(&result),
				None
			)
			.is_err()
		);
		assert!(
			candidate_execution::cell_replay_disposition(
				ResultStatus::Completed,
				None,
				Some(&result)
			)
			.is_err()
		);
	}

	#[test]
	fn noncompleted_cell_stays_explicitly_nonverified() {
		let disposition =
			candidate_execution::cell_replay_disposition(ResultStatus::Failed, None, None)
				.expect("disposition");

		assert!(!disposition.verified);
		assert_eq!(disposition.replayed_evaluator_sha256, None);
		assert_eq!(
			disposition.disposition,
			CandidateVerificationDisposition::CandidateResultNoncompletedNotVerified
		);
	}

	#[test]
	fn noncompleted_cell_rejects_any_evaluator_evidence() {
		let result = candidate_result();

		assert!(
			candidate_execution::cell_replay_disposition(ResultStatus::Failed, Some(&result), None)
				.is_err()
		);
		assert!(
			candidate_execution::cell_replay_disposition(
				ResultStatus::Unsupported,
				None,
				Some(&result)
			)
			.is_err()
		);
	}
}
