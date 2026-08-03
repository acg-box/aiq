//! Independent replay comparison for AIQ Core 1.0.2 candidate evaluators.

use serde::{Deserialize, Serialize};

use aiq_runner::candidate_release_gate::{CandidateEvaluatorResult, CandidateGateError};

/// Schema emitted for an independently replayed candidate evaluator result.
pub const CANDIDATE_REPLAY_PROOF_SCHEMA: &str = "aiq.candidate-evaluator-replay-proof.v1";

/// Digest-only proof for the release-evidence assembler.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CandidateReplayProof {
	/// Closed schema identifier for this proof.
	pub schema_version: String,
	/// Task whose evaluator output was replayed.
	pub task_id: String,
	/// Digest committed by the candidate result package.
	pub committed_result_sha256: String,
	/// Digest calculated by the independent replay.
	pub replayed_result_sha256: String,
	/// Exact replayed score numerator.
	pub score_numerator: u64,
	/// Exact replayed score denominator.
	pub score_denominator: u64,
	/// Six-decimal score rendering checked against the exact fraction.
	pub score_decimal_6: String,
	/// Closed replay outcome used by the release-evidence assembler.
	pub disposition: String,
}

/// Validates both ordered four-component results and requires byte-semantic replay equality.
pub fn verify_candidate_evaluator_replay(
	committed: &CandidateEvaluatorResult,
	replayed: &CandidateEvaluatorResult,
) -> Result<CandidateReplayProof, CandidateGateError> {
	let committed_digest = committed.digest()?;
	let replayed_digest = replayed.digest()?;

	if committed != replayed || committed_digest != replayed_digest {
		return Err(CandidateGateError::new(
			"candidate evaluator replay does not match the committed result",
		));
	}

	Ok(CandidateReplayProof {
		schema_version: CANDIDATE_REPLAY_PROOF_SCHEMA.to_owned(),
		task_id: committed.task_id.clone(),
		committed_result_sha256: committed_digest,
		replayed_result_sha256: replayed_digest,
		score_numerator: committed.score_numerator,
		score_denominator: committed.score_denominator,
		score_decimal_6: committed.score_decimal_6.clone(),
		disposition: "candidate_evaluator_replayed".to_owned(),
	})
}

#[cfg(test)]
mod tests {
	use crate::candidate_release_gate::{self, CandidateEvaluatorResult};
	use aiq_runner::candidate_release_gate::{
		CANDIDATE_EVALUATOR_RESULT_SCHEMA, CandidateAssertion, CandidateEvaluatorComponent,
	};

	fn result() -> CandidateEvaluatorResult {
		let weights = [3_000, 2_500, 2_500, 2_000];

		CandidateEvaluatorResult {
			schema_version: CANDIDATE_EVALUATOR_RESULT_SCHEMA.to_owned(),
			task_id: "coding-01".to_owned(),
			task_version: "1.0.2".to_owned(),
			scorer_version: "1.0.2".to_owned(),
			components: weights
				.into_iter()
				.enumerate()
				.map(|(component, weight_basis_points)| CandidateEvaluatorComponent {
					component_id: format!("component_{:02}", component + 1),
					weight_basis_points,
					assertions: (0..3)
						.map(|assertion| CandidateAssertion {
							assertion_id: format!("assertion_{assertion}"),
							passed: true,
							evidence_sha256: format!(
								"sha256:{}",
								char::from(b'a' + assertion as u8).to_string().repeat(64)
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
	fn verifier_replays_and_emits_assembler_digests() {
		let evaluation = result();
		let proof =
			candidate_release_gate::verify_candidate_evaluator_replay(&evaluation, &evaluation)
				.expect("proof");

		assert_eq!(proof.committed_result_sha256, proof.replayed_result_sha256);
		assert_eq!(proof.disposition, "candidate_evaluator_replayed");
	}

	#[test]
	fn verifier_rejects_one_changed_binary_assertion() {
		let committed = result();
		let mut replayed = result();

		replayed.components[0].assertions[0].passed = false;

		assert!(
			candidate_release_gate::verify_candidate_evaluator_replay(&committed, &replayed)
				.is_err()
		);
	}
}
