//! Signed, non-Official artifacts for the AIQ Core candidate release gate.
//!
//! Candidate envelopes are intentionally distinct from `SubmissionEnvelope`.
//! They cannot enter the public submission path, and their trust tier is always
//! untrusted. A unit bundle can contain one signed run plus unique signed cell
//! leaves without duplicating the complete run payload for every observation.

use std::collections::BTreeSet;
use std::error::Error;
use std::fmt::{Display, Formatter};

use ed25519_dalek::{Signature, Signer as _, SigningKey, Verifier as _, VerifyingKey};
use jiff::Timestamp;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest as _, Sha256};

use crate::{
	candidate_evidence,
	candidate_release_gate::{
		CANDIDATE_TASK_IDENTITY_SHA256, CandidateContrastArm, CandidateEvaluatorResult,
		CandidateExecutionAuthorization, CandidateExecutionUnit, CandidateExecutionUnitKind,
		CandidateGateError, RELEASE_IDENTITY,
	},
	corpus_commitment::{CANDIDATE_CONTRAST_CATALOG_IDENTITY_SHA256, RunClass},
	protocol::{self, NodeIdentity, ProtocolError, TrustTier},
	runner::{CalibrationRunRecord, EvaluatorResultsBundle, FailureKind, ResultStatus, TaskResult},
	scoring::AIQ_SCORING_VERSION,
};

/// Candidate-only signed-envelope schema.
pub const CANDIDATE_SIGNED_ENVELOPE_SCHEMA: &str = "aiq.candidate-signed-envelope.v1";
/// Signed payload containing one exact plan-bound calibration unit.
pub const CANDIDATE_UNIT_RUN_PAYLOAD_TYPE: &str = "aiq.candidate-unit-run.v1";
/// Signed leaf binding one planned observation to its unit run result.
pub const CANDIDATE_CELL_RESULT_PAYLOAD_TYPE: &str = "aiq.candidate-cell-result.v1";
/// Signed leaf binding one planned observation to its persisted evaluator result.
pub const CANDIDATE_CELL_EVALUATOR_PAYLOAD_TYPE: &str = "aiq.candidate-cell-evaluator.v1";
/// Signed verifier attestation for one independently replayed observation.
pub const CANDIDATE_CELL_VERIFICATION_PAYLOAD_TYPE: &str = "aiq.candidate-cell-verification.v1";
/// Signed runner attempt history for one planned observation.
pub const CANDIDATE_CELL_ATTEMPT_LOG_PAYLOAD_TYPE: &str = "aiq.candidate-cell-attempt-log.v1";
/// Canonical runner bundle for one complete candidate execution unit.
pub const CANDIDATE_RESULT_PACKAGE_BUNDLE_SCHEMA: &str = "aiq.candidate-result-package-bundle.v1";
/// Canonical evaluator bundle for one complete candidate execution unit.
pub const CANDIDATE_EVALUATOR_RESULT_BUNDLE_SCHEMA: &str =
	"aiq.candidate-evaluator-result-bundle.v1";
/// Canonical verifier bundle for one independently replayed execution unit.
pub const CANDIDATE_VERIFIER_REPLAY_BUNDLE_SCHEMA: &str = "aiq.candidate-verifier-replay-bundle.v1";
/// Canonical attempt-log bundle for one complete candidate execution unit.
pub const CANDIDATE_ATTEMPT_LOG_BUNDLE_SCHEMA: &str = "aiq.candidate-attempt-log.v1";

/// Candidate artifact validation or signing failure.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CandidateArtifactError {
	message: String,
}
impl CandidateArtifactError {
	/// Creates one candidate artifact error without exposing controlled contents.
	pub fn new(message: impl Into<String>) -> Self {
		Self { message: message.into() }
	}
}

impl Display for CandidateArtifactError {
	fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
		formatter.write_str(&self.message)
	}
}

impl Error for CandidateArtifactError {}

impl From<ProtocolError> for CandidateArtifactError {
	fn from(error: ProtocolError) -> Self {
		Self::new(error.to_string())
	}
}

impl From<CandidateGateError> for CandidateArtifactError {
	fn from(error: CandidateGateError) -> Self {
		Self::new(error.to_string())
	}
}

/// Candidate-only Ed25519 identity.
///
/// The node identifier is identical to the normal runner/verifier identity
/// derivation, but this type can sign only candidate envelopes.
pub struct CandidateSigningIdentity {
	signing_key: SigningKey,
	node: NodeIdentity,
}
impl CandidateSigningIdentity {
	/// Creates one identity from a deployment-provided 32-byte secret.
	#[must_use]
	pub fn from_secret(secret: [u8; 32]) -> Self {
		let signing_key = SigningKey::from_bytes(&secret);
		let public_bytes = signing_key.verifying_key().to_bytes();
		let public_key = hex::encode(public_bytes);
		let node_id = candidate_node_id(&public_bytes);

		Self { signing_key, node: NodeIdentity { node_id, public_key } }
	}

	/// Returns the public node identity.
	#[must_use]
	pub fn node(&self) -> &NodeIdentity {
		&self.node
	}

	/// Signs one closed candidate payload as permanently untrusted evidence.
	pub fn sign<T>(
		&self,
		idempotency_key: &str,
		payload_type: &str,
		payload: &T,
	) -> Result<CandidateSignedEnvelope, CandidateArtifactError>
	where
		T: Serialize,
	{
		validate_candidate_key(idempotency_key)?;
		validate_candidate_payload_type(payload_type)?;

		let payload = serde_json::to_value(payload)
			.map_err(|_| CandidateArtifactError::new("candidate payload cannot be serialized"))?;

		validate_payload_schema(payload_type, &payload)?;

		let content_hash = protocol::canonical_hash(&payload)?;
		let unsigned = UnsignedCandidateEnvelope {
			schema_version: CANDIDATE_SIGNED_ENVELOPE_SCHEMA,
			idempotency_key,
			payload_type,
			content_hash: &content_hash,
			signer: &self.node,
			claimed_trust: TrustTier::Untrusted,
			payload: &payload,
		};
		let signature = self.signing_key.sign(&protocol::canonical_json(&unsigned)?);

		Ok(CandidateSignedEnvelope {
			schema_version: CANDIDATE_SIGNED_ENVELOPE_SCHEMA.to_owned(),
			idempotency_key: idempotency_key.to_owned(),
			payload_type: payload_type.to_owned(),
			content_hash,
			signer: self.node.clone(),
			claimed_trust: TrustTier::Untrusted,
			payload,
			signature: hex::encode(signature.to_bytes()),
		})
	}
}

/// One signed candidate-only payload.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CandidateSignedEnvelope {
	/// Candidate envelope schema identifier.
	pub schema_version: String,
	/// Key that identifies this signed operation.
	pub idempotency_key: String,
	/// Closed type identifier for the payload.
	pub payload_type: String,
	/// Canonical SHA-256 digest of the payload.
	pub content_hash: String,
	/// Public identity of the signing node.
	pub signer: NodeIdentity,
	/// Trust tier claimed for the candidate payload.
	pub claimed_trust: TrustTier,
	/// Candidate payload covered by the signature.
	pub payload: Value,
	/// Hex-encoded Ed25519 signature of the envelope.
	pub signature: String,
}
impl CandidateSignedEnvelope {
	/// Verifies the closed payload type, signer, digest, and Ed25519 signature.
	pub fn verify(
		&self,
		expected_payload_type: &str,
		expected_signer_node_id: &str,
	) -> Result<&Value, CandidateArtifactError> {
		validate_candidate_payload_type(expected_payload_type)?;

		if self.schema_version != CANDIDATE_SIGNED_ENVELOPE_SCHEMA
			|| self.payload_type != expected_payload_type
			|| self.claimed_trust != TrustTier::Untrusted
			|| self.signer.node_id != expected_signer_node_id
		{
			return Err(CandidateArtifactError::new(
				"candidate envelope identity, payload type, signer, or trust tier is invalid",
			));
		}

		validate_candidate_key(&self.idempotency_key)?;
		validate_payload_schema(&self.payload_type, &self.payload)?;

		if protocol::canonical_hash(&self.payload)? != self.content_hash
			|| !valid_digest(&self.content_hash)
			|| !valid_node(&self.signer)
			|| !valid_lower_hex(&self.signature, 128)
		{
			return Err(CandidateArtifactError::new(
				"candidate envelope content address, signer, or signature encoding is invalid",
			));
		}

		let public_bytes = hex::decode(&self.signer.public_key)
			.map_err(|_| CandidateArtifactError::new("candidate public key is invalid"))?;
		let public_bytes: [u8; 32] = public_bytes
			.try_into()
			.map_err(|_| CandidateArtifactError::new("candidate public key is invalid"))?;
		let verifying_key = VerifyingKey::from_bytes(&public_bytes)
			.map_err(|_| CandidateArtifactError::new("candidate public key is invalid"))?;
		let signature = hex::decode(&self.signature)
			.map_err(|_| CandidateArtifactError::new("candidate signature is invalid"))?;
		let signature = Signature::from_slice(&signature)
			.map_err(|_| CandidateArtifactError::new("candidate signature is invalid"))?;
		let unsigned = UnsignedCandidateEnvelope {
			schema_version: &self.schema_version,
			idempotency_key: &self.idempotency_key,
			payload_type: &self.payload_type,
			content_hash: &self.content_hash,
			signer: &self.signer,
			claimed_trust: self.claimed_trust,
			payload: &self.payload,
		};

		verifying_key
			.verify(&protocol::canonical_json(&unsigned)?, &signature)
			.map_err(|_| CandidateArtifactError::new("candidate signature does not verify"))?;

		Ok(&self.payload)
	}

	/// Returns the canonical digest of the complete signed envelope.
	pub fn digest(&self) -> Result<String, CandidateArtifactError> {
		Ok(protocol::canonical_hash(self)?)
	}

	/// Verifies and decodes one closed candidate payload.
	pub fn verify_payload<T>(
		&self,
		expected_payload_type: &str,
		expected_signer_node_id: &str,
	) -> Result<T, CandidateArtifactError>
	where
		T: for<'de> Deserialize<'de>,
	{
		let payload = self.verify(expected_payload_type, expected_signer_node_id)?;

		serde_json::from_value(payload.clone())
			.map_err(|_| CandidateArtifactError::new("candidate payload shape is invalid"))
	}
}

/// Closed plan binding repeated in every candidate artifact.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CandidateUnitBinding {
	/// Fixed release identity for the candidate gate.
	pub release_identity: String,
	/// Digest of the authorized execution plan.
	pub execution_plan_digest: String,
	/// SHA-256 digest of the private execution plan.
	pub private_plan_sha256: String,
	/// SHA-256 digest of the signed admission.
	pub signed_admission_sha256: String,
	/// Identifier of the planned repeat.
	pub repeat_id: String,
	/// Identifier of the execution unit.
	pub unit_id: String,
	/// Identifier of the scheduled execution slot.
	pub slot_id: String,
	/// Kind of execution unit.
	pub kind: CandidateExecutionUnitKind,
	/// Optional identifier of the contrast pair.
	pub contrast_id: Option<String>,
	/// Optional arm of the contrast pair.
	pub contrast_arm: Option<CandidateContrastArm>,
	/// Optional SHA-256 digest of the contrast variant.
	pub variant_sha256: Option<String>,
	/// SHA-256 digest of the bound corpus commitment.
	pub corpus_commitment_sha256: String,
}
impl CandidateUnitBinding {
	/// Derives the only valid binding for one authorized execution unit.
	pub fn from_authorization(
		authorization: &CandidateExecutionAuthorization,
		unit: &CandidateExecutionUnit,
	) -> Result<Self, CandidateArtifactError> {
		if authorization.private_plan_sha256 != protocol::canonical_hash(&authorization.plan)?
			|| !authorization.plan.execution_units.iter().any(|candidate| candidate == unit)
		{
			return Err(CandidateArtifactError::new(
				"candidate unit is not bound by the private execution authorization",
			));
		}

		Ok(Self {
			release_identity: RELEASE_IDENTITY.to_owned(),
			execution_plan_digest: authorization.execution_plan_digest.clone(),
			private_plan_sha256: authorization.private_plan_sha256.clone(),
			signed_admission_sha256: authorization.signed_admission_sha256.clone(),
			repeat_id: unit.repeat_id.clone(),
			unit_id: unit.unit_id.clone(),
			slot_id: unit.slot_id.clone(),
			kind: unit.kind,
			contrast_id: unit.contrast_id.clone(),
			contrast_arm: unit.contrast_arm,
			variant_sha256: unit.variant_sha256.clone(),
			corpus_commitment_sha256: unit.corpus_commitment_sha256.clone(),
		})
	}
}

/// Stable identity of one observation inside a plan-bound unit.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CandidateCellIdentity {
	/// Identifier of the planned repeat.
	pub repeat_id: String,
	/// Identifier of the execution unit.
	pub unit_id: String,
	/// Zero-based position of the result in the unit run.
	pub result_index: usize,
	/// Identifier of the benchmark task.
	pub task_id: String,
	/// Version of the benchmark task.
	pub task_version: String,
	/// Identifier of the planned model configuration.
	pub model_id: String,
	/// Provider model identifier used for execution.
	pub execution_model_id: String,
}

/// Signed complete selected-run record for one unit.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CandidateUnitRunPayload {
	/// Payload schema identifier.
	pub schema_version: String,
	/// Authorized execution-unit binding.
	pub unit: CandidateUnitBinding,
	/// Complete selected run for the unit.
	pub run: CalibrationRunRecord,
}

/// Signed result leaf for one observation.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CandidateCellResultPayload {
	/// Payload schema identifier.
	pub schema_version: String,
	/// Authorized execution-unit binding.
	pub unit: CandidateUnitBinding,
	/// Identity of the result cell.
	pub cell: CandidateCellIdentity,
	/// SHA-256 digest of the signed unit-run envelope.
	pub unit_run_envelope_sha256: String,
	/// SHA-256 digest of the task result.
	pub result_sha256: String,
	/// Identifier of the task result.
	pub result_id: String,
}

/// Signed evaluator leaf for one observation.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CandidateCellEvaluatorPayload {
	/// Payload schema identifier.
	pub schema_version: String,
	/// Authorized execution-unit binding.
	pub unit: CandidateUnitBinding,
	/// Identity of the evaluated cell.
	pub cell: CandidateCellIdentity,
	/// SHA-256 digest of the signed result package.
	pub result_package_sha256: String,
	/// Optional SHA-256 digest of the persisted evaluator result.
	pub persisted_evaluator_sha256: Option<String>,
	/// Optional normalized candidate evaluator result.
	pub evaluator: Option<CandidateEvaluatorResult>,
}

/// Signed independent replay disposition for one observation.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CandidateCellVerificationPayload {
	/// Payload schema identifier.
	pub schema_version: String,
	/// Authorized execution-unit binding.
	pub unit: CandidateUnitBinding,
	/// Identity of the verified cell.
	pub cell: CandidateCellIdentity,
	/// SHA-256 digest of the signed result package.
	pub result_package_sha256: String,
	/// SHA-256 digest of the signed evaluator package.
	pub evaluator_package_sha256: String,
	/// Optional SHA-256 digest of the replayed evaluator result.
	pub replayed_evaluator_sha256: Option<String>,
	/// Whether independent replay verified the cell.
	pub verified: bool,
	/// Verifier disposition for the replayed cell.
	pub disposition: CandidateVerificationDisposition,
}

/// One logical attempt and its actual unit-attempt start time.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CandidateAttempt {
	/// One-based number of the logical attempt.
	pub attempt_number: usize,
	/// Policy delay from the initial scheduled time.
	pub scheduled_delay_seconds: u64,
	/// Canonical timestamp at which the attempt became eligible.
	pub scheduled_for: String,
	/// Canonical timestamp at which the attempt started.
	pub started_at: String,
	/// Whether the attempt crossed the task-model boundary.
	pub model_started: bool,
	/// Final disposition of the attempt.
	pub disposition: CandidateAttemptDisposition,
	/// Optional pre-model infrastructure failure class.
	pub infrastructure_classification: Option<CandidateInfrastructureClassification>,
	/// Optional digest of the task result.
	pub result_digest: Option<String>,
	/// Optional digest of the signed result package.
	pub result_package_digest: Option<String>,
	/// Optional digest of the verifier attestation.
	pub verifier_attestation_digest: Option<String>,
}

/// Signed attempt history for one exact model-major candidate cell.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CandidateCellAttemptLogPayload {
	/// Payload schema identifier.
	pub schema_version: String,
	/// Authorized execution-unit binding.
	pub unit: CandidateUnitBinding,
	/// Identity of the attempted cell.
	pub cell: CandidateCellIdentity,
	/// SHA-256 digest of the signed result package.
	pub result_package_sha256: String,
	/// SHA-256 digest of the signed evaluator package.
	pub evaluator_package_sha256: String,
	/// SHA-256 digest of the signed verifier attestation.
	pub verifier_attestation_sha256: String,
	/// Ordered attempt history for the cell.
	pub attempts: Vec<CandidateAttempt>,
}

/// Runner-signed result packages for one complete execution unit.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CandidateResultPackageBundle {
	/// Bundle schema identifier.
	pub schema_version: String,
	/// Authorized execution-unit binding.
	pub unit: CandidateUnitBinding,
	/// Signed envelope for the complete unit run.
	pub unit_run: CandidateSignedEnvelope,
	/// Ordered signed result envelopes for all cells.
	pub cells: Vec<CandidateSignedEnvelope>,
}
impl CandidateResultPackageBundle {
	/// Signs one unit run and one unique leaf for every ordered observation.
	pub fn sign(
		authorization: &CandidateExecutionAuthorization,
		unit: &CandidateExecutionUnit,
		run: CalibrationRunRecord,
		identity: &CandidateSigningIdentity,
	) -> Result<Self, CandidateArtifactError> {
		require_runner_signer(authorization, identity)?;
		validate_unit_run_shape(authorization, unit, &run)?;

		let unit_binding = CandidateUnitBinding::from_authorization(authorization, unit)?;
		let unit_payload = CandidateUnitRunPayload {
			schema_version: CANDIDATE_UNIT_RUN_PAYLOAD_TYPE.to_owned(),
			unit: unit_binding.clone(),
			run,
		};
		let unit_run = identity.sign(
			&format!("{}.unit-run", unit.unit_id),
			CANDIDATE_UNIT_RUN_PAYLOAD_TYPE,
			&unit_payload,
		)?;
		let unit_run_envelope_sha256 = unit_run.digest()?;
		let cells = unit_payload
			.run
			.results
			.iter()
			.enumerate()
			.map(|(index, result)| {
				let cell = candidate_cell_identity(unit, result, index)?;
				let payload = CandidateCellResultPayload {
					schema_version: CANDIDATE_CELL_RESULT_PAYLOAD_TYPE.to_owned(),
					unit: unit_binding.clone(),
					cell,
					unit_run_envelope_sha256: unit_run_envelope_sha256.clone(),
					result_sha256: result.content_hash()?,
					result_id: result.result_id.clone(),
				};

				identity.sign(
					&format!("{}.cell-result.{:04}", unit.unit_id, index + 1),
					CANDIDATE_CELL_RESULT_PAYLOAD_TYPE,
					&payload,
				)
			})
			.collect::<Result<Vec<_>, _>>()?;
		let bundle = Self {
			schema_version: CANDIDATE_RESULT_PACKAGE_BUNDLE_SCHEMA.to_owned(),
			unit: unit_binding,
			unit_run,
			cells,
		};

		bundle.verify(authorization, unit)?;

		Ok(bundle)
	}

	/// Verifies the runner signer, complete unit run, ordering, and unique cell leaves.
	pub fn verify(
		&self,
		authorization: &CandidateExecutionAuthorization,
		unit: &CandidateExecutionUnit,
	) -> Result<CandidateUnitRunPayload, CandidateArtifactError> {
		let expected_unit = CandidateUnitBinding::from_authorization(authorization, unit)?;

		if self.schema_version != CANDIDATE_RESULT_PACKAGE_BUNDLE_SCHEMA
			|| self.unit != expected_unit
		{
			return Err(CandidateArtifactError::new(
				"candidate result bundle does not match its authorized unit",
			));
		}

		let signer = &authorization.plan.controlled_inputs.runner_signer_node_id;
		let unit_payload: CandidateUnitRunPayload =
			self.unit_run.verify_payload(CANDIDATE_UNIT_RUN_PAYLOAD_TYPE, signer)?;

		if unit_payload.schema_version != CANDIDATE_UNIT_RUN_PAYLOAD_TYPE
			|| unit_payload.unit != expected_unit
		{
			return Err(CandidateArtifactError::new(
				"candidate signed unit payload is inconsistent",
			));
		}

		validate_unit_run_shape(authorization, unit, &unit_payload.run)?;

		if self.cells.len() != unit_payload.run.results.len() {
			return Err(CandidateArtifactError::new(
				"candidate result bundle has the wrong cell count",
			));
		}

		let unit_digest = self.unit_run.digest()?;
		let mut cell_digests = BTreeSet::new();

		for (index, (envelope, result)) in
			self.cells.iter().zip(&unit_payload.run.results).enumerate()
		{
			let payload: CandidateCellResultPayload =
				envelope.verify_payload(CANDIDATE_CELL_RESULT_PAYLOAD_TYPE, signer)?;

			if payload.schema_version != CANDIDATE_CELL_RESULT_PAYLOAD_TYPE
				|| payload.unit != expected_unit
				|| payload.cell != candidate_cell_identity(unit, result, index)?
				|| payload.unit_run_envelope_sha256 != unit_digest
				|| payload.result_sha256 != result.content_hash()?
				|| payload.result_id != result.result_id
				|| !cell_digests.insert(envelope.digest()?)
			{
				return Err(CandidateArtifactError::new(
					"candidate signed result cell is inconsistent or duplicated",
				));
			}
		}

		Ok(unit_payload)
	}
}

/// Runner-signed evaluator packages aligned with one result bundle.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CandidateEvaluatorResultBundle {
	/// Bundle schema identifier.
	pub schema_version: String,
	/// Authorized execution-unit binding.
	pub unit: CandidateUnitBinding,
	/// SHA-256 digest of the result bundle.
	pub result_bundle_sha256: String,
	/// Ordered signed evaluator envelopes for all cells.
	pub cells: Vec<CandidateSignedEnvelope>,
}
impl CandidateEvaluatorResultBundle {
	/// Converts persisted evaluator evidence and signs one cell-bound evaluator leaf.
	pub fn sign(
		authorization: &CandidateExecutionAuthorization,
		unit: &CandidateExecutionUnit,
		results: &CandidateResultPackageBundle,
		evaluator_results: &EvaluatorResultsBundle,
		identity: &CandidateSigningIdentity,
	) -> Result<Self, CandidateArtifactError> {
		require_runner_signer(authorization, identity)?;

		let unit_payload = results.verify(authorization, unit)?;

		if evaluator_results.results.len() != unit_payload.run.results.len() {
			return Err(CandidateArtifactError::new(
				"candidate evaluator bundle is not aligned with the unit run",
			));
		}

		let result_bundle_sha256 = protocol::canonical_hash(results)?;
		let mut cells = Vec::with_capacity(unit_payload.run.results.len());

		for (index, (result, evaluation)) in
			unit_payload.run.results.iter().zip(&evaluator_results.results).enumerate()
		{
			let result_package_sha256 = results.cells[index].digest()?;
			let evaluator = evaluation
				.as_ref()
				.map(|value| {
					candidate_evidence::candidate_evaluator_result_from_persisted(
						&result.task_id,
						&result.task_version,
						value,
					)
				})
				.transpose()?;
			let persisted_evaluator_sha256 =
				evaluation.as_ref().map(protocol::canonical_hash).transpose()?;

			if persisted_evaluator_sha256 != result.evaluator_result_sha256 {
				return Err(CandidateArtifactError::new(
					"candidate persisted evaluator digest differs from the task result",
				));
			}

			let payload = CandidateCellEvaluatorPayload {
				schema_version: CANDIDATE_CELL_EVALUATOR_PAYLOAD_TYPE.to_owned(),
				unit: results.unit.clone(),
				cell: candidate_cell_identity(unit, result, index)?,
				result_package_sha256,
				persisted_evaluator_sha256,
				evaluator,
			};

			cells.push(identity.sign(
				&format!("{}.cell-evaluator.{:04}", unit.unit_id, index + 1),
				CANDIDATE_CELL_EVALUATOR_PAYLOAD_TYPE,
				&payload,
			)?);
		}

		let bundle = Self {
			schema_version: CANDIDATE_EVALUATOR_RESULT_BUNDLE_SCHEMA.to_owned(),
			unit: results.unit.clone(),
			result_bundle_sha256,
			cells,
		};

		bundle.verify(authorization, unit, results)?;

		Ok(bundle)
	}

	/// Verifies evaluator leaf ordering and every runner signature.
	pub fn verify(
		&self,
		authorization: &CandidateExecutionAuthorization,
		unit: &CandidateExecutionUnit,
		results: &CandidateResultPackageBundle,
	) -> Result<Vec<CandidateCellEvaluatorPayload>, CandidateArtifactError> {
		let unit_payload = results.verify(authorization, unit)?;

		if self.schema_version != CANDIDATE_EVALUATOR_RESULT_BUNDLE_SCHEMA
			|| self.unit != results.unit
			|| self.result_bundle_sha256 != protocol::canonical_hash(results)?
			|| self.cells.len() != unit_payload.run.results.len()
		{
			return Err(CandidateArtifactError::new(
				"candidate evaluator bundle header or count is invalid",
			));
		}

		let signer = &authorization.plan.controlled_inputs.runner_signer_node_id;
		let mut payloads = Vec::with_capacity(self.cells.len());
		let mut digests = BTreeSet::new();

		for (index, (envelope, result)) in
			self.cells.iter().zip(&unit_payload.run.results).enumerate()
		{
			let payload: CandidateCellEvaluatorPayload =
				envelope.verify_payload(CANDIDATE_CELL_EVALUATOR_PAYLOAD_TYPE, signer)?;
			let candidate_digest =
				payload.evaluator.as_ref().map(|value| value.digest()).transpose()?;

			if payload.schema_version != CANDIDATE_CELL_EVALUATOR_PAYLOAD_TYPE
				|| payload.unit != self.unit
				|| payload.cell != candidate_cell_identity(unit, result, index)?
				|| payload.result_package_sha256 != results.cells[index].digest()?
				|| payload.persisted_evaluator_sha256 != result.evaluator_result_sha256
				|| payload.evaluator.is_some() != payload.persisted_evaluator_sha256.is_some()
				|| candidate_digest.is_some() != payload.persisted_evaluator_sha256.is_some()
				|| !digests.insert(envelope.digest()?)
			{
				return Err(CandidateArtifactError::new(
					"candidate signed evaluator cell is inconsistent or duplicated",
				));
			}

			payloads.push(payload);
		}

		Ok(payloads)
	}
}

/// Verifier-signed replay packages aligned with the two runner bundles.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CandidateVerifierReplayBundle {
	/// Bundle schema identifier.
	pub schema_version: String,
	/// Authorized execution-unit binding.
	pub unit: CandidateUnitBinding,
	/// SHA-256 digest of the result bundle.
	pub result_bundle_sha256: String,
	/// SHA-256 digest of the evaluator bundle.
	pub evaluator_bundle_sha256: String,
	/// Ordered signed verifier envelopes for all cells.
	pub cells: Vec<CandidateSignedEnvelope>,
}
impl CandidateVerifierReplayBundle {
	/// Signs already independently replayed cell dispositions.
	pub fn sign(
		authorization: &CandidateExecutionAuthorization,
		unit: &CandidateExecutionUnit,
		results: &CandidateResultPackageBundle,
		evaluators: &CandidateEvaluatorResultBundle,
		payloads: Vec<CandidateCellVerificationPayload>,
		identity: &CandidateSigningIdentity,
	) -> Result<Self, CandidateArtifactError> {
		require_verifier_signer(authorization, identity)?;

		let unit_payload = results.verify(authorization, unit)?;
		let evaluator_payloads = evaluators.verify(authorization, unit, results)?;

		if payloads.len() != unit_payload.run.results.len() {
			return Err(CandidateArtifactError::new("candidate verifier payload count is invalid"));
		}

		let mut cells = Vec::with_capacity(payloads.len());

		for (index, payload) in payloads.into_iter().enumerate() {
			let result_package_sha256 = results.cells[index].digest()?;
			let evaluator_package_sha256 = evaluators.cells[index].digest()?;

			if payload.schema_version != CANDIDATE_CELL_VERIFICATION_PAYLOAD_TYPE
				|| payload.unit != results.unit
				|| payload.cell != evaluator_payloads[index].cell
				|| payload.result_package_sha256 != result_package_sha256
				|| payload.evaluator_package_sha256 != evaluator_package_sha256
			{
				return Err(CandidateArtifactError::new(
					"candidate verifier payload is not aligned with its runner evidence",
				));
			}

			validate_candidate_verification_payload(
				&unit_payload.run.results[index],
				evaluator_payloads[index].evaluator.as_ref(),
				&payload,
			)?;

			cells.push(identity.sign(
				&format!("{}.cell-verification.{:04}", unit.unit_id, index + 1),
				CANDIDATE_CELL_VERIFICATION_PAYLOAD_TYPE,
				&payload,
			)?);
		}

		let bundle = Self {
			schema_version: CANDIDATE_VERIFIER_REPLAY_BUNDLE_SCHEMA.to_owned(),
			unit: results.unit.clone(),
			result_bundle_sha256: protocol::canonical_hash(results)?,
			evaluator_bundle_sha256: protocol::canonical_hash(evaluators)?,
			cells,
		};

		bundle.verify(authorization, unit, results, evaluators)?;

		Ok(bundle)
	}

	/// Verifies exact alignment and all verifier signatures.
	pub fn verify(
		&self,
		authorization: &CandidateExecutionAuthorization,
		unit: &CandidateExecutionUnit,
		results: &CandidateResultPackageBundle,
		evaluators: &CandidateEvaluatorResultBundle,
	) -> Result<Vec<CandidateCellVerificationPayload>, CandidateArtifactError> {
		let unit_payload = results.verify(authorization, unit)?;
		let evaluator_payloads = evaluators.verify(authorization, unit, results)?;

		if self.schema_version != CANDIDATE_VERIFIER_REPLAY_BUNDLE_SCHEMA
			|| self.unit != results.unit
			|| self.result_bundle_sha256 != protocol::canonical_hash(results)?
			|| self.evaluator_bundle_sha256 != protocol::canonical_hash(evaluators)?
			|| self.cells.len() != evaluator_payloads.len()
		{
			return Err(CandidateArtifactError::new(
				"candidate verifier bundle header or count is invalid",
			));
		}

		let signer = &authorization.plan.controlled_inputs.verifier_signer_node_id;
		let mut payloads = Vec::with_capacity(self.cells.len());
		let mut digests = BTreeSet::new();

		for (index, envelope) in self.cells.iter().enumerate() {
			let payload: CandidateCellVerificationPayload =
				envelope.verify_payload(CANDIDATE_CELL_VERIFICATION_PAYLOAD_TYPE, signer)?;

			if payload.schema_version != CANDIDATE_CELL_VERIFICATION_PAYLOAD_TYPE
				|| payload.unit != self.unit
				|| payload.cell != evaluator_payloads[index].cell
				|| payload.result_package_sha256 != results.cells[index].digest()?
				|| payload.evaluator_package_sha256 != evaluators.cells[index].digest()?
				|| !digests.insert(envelope.digest()?)
			{
				return Err(CandidateArtifactError::new(
					"candidate signed verifier cell is inconsistent or duplicated",
				));
			}

			validate_candidate_verification_payload(
				&unit_payload.run.results[index],
				evaluator_payloads[index].evaluator.as_ref(),
				&payload,
			)?;

			payloads.push(payload);
		}

		Ok(payloads)
	}
}

/// Runner-signed attempt histories aligned with all result, evaluator, and replay evidence.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CandidateAttemptLogBundle {
	/// Bundle schema identifier.
	pub schema_version: String,
	/// Authorized execution-unit binding.
	pub unit: CandidateUnitBinding,
	/// SHA-256 digest of the result bundle.
	pub result_bundle_sha256: String,
	/// SHA-256 digest of the evaluator bundle.
	pub evaluator_bundle_sha256: String,
	/// SHA-256 digest of the verifier bundle.
	pub verifier_bundle_sha256: String,
	/// Ordered signed attempt-log envelopes for all cells.
	pub cells: Vec<CandidateSignedEnvelope>,
}
impl CandidateAttemptLogBundle {
	/// Validates and signs one ordered attempt history per candidate observation.
	pub fn sign(
		authorization: &CandidateExecutionAuthorization,
		unit: &CandidateExecutionUnit,
		results: &CandidateResultPackageBundle,
		evaluators: &CandidateEvaluatorResultBundle,
		replays: &CandidateVerifierReplayBundle,
		attempts: Vec<Vec<CandidateAttempt>>,
		identity: &CandidateSigningIdentity,
	) -> Result<Self, CandidateArtifactError> {
		require_runner_signer(authorization, identity)?;

		let unit_payload = results.verify(authorization, unit)?;
		let evaluator_payloads = evaluators.verify(authorization, unit, results)?;
		let replay_payloads = replays.verify(authorization, unit, results, evaluators)?;

		if attempts.len() != unit_payload.run.results.len() {
			return Err(CandidateArtifactError::new("candidate attempt-log cell count is invalid"));
		}

		let mut cells = Vec::with_capacity(attempts.len());

		for (index, attempts) in attempts.into_iter().enumerate() {
			let result = &unit_payload.run.results[index];
			let result_package_sha256 = results.cells[index].digest()?;
			let evaluator_package_sha256 = evaluators.cells[index].digest()?;
			let verifier_attestation_sha256 = replays.cells[index].digest()?;

			validate_candidate_attempts(
				unit,
				result,
				&evaluator_payloads[index],
				&replay_payloads[index],
				&result_package_sha256,
				&verifier_attestation_sha256,
				&attempts,
			)?;

			let payload = CandidateCellAttemptLogPayload {
				schema_version: CANDIDATE_CELL_ATTEMPT_LOG_PAYLOAD_TYPE.to_owned(),
				unit: results.unit.clone(),
				cell: candidate_cell_identity(unit, result, index)?,
				result_package_sha256,
				evaluator_package_sha256,
				verifier_attestation_sha256,
				attempts,
			};

			cells.push(identity.sign(
				&format!("{}.cell-attempt-log.{:04}", unit.unit_id, index + 1),
				CANDIDATE_CELL_ATTEMPT_LOG_PAYLOAD_TYPE,
				&payload,
			)?);
		}

		let bundle = Self {
			schema_version: CANDIDATE_ATTEMPT_LOG_BUNDLE_SCHEMA.to_owned(),
			unit: results.unit.clone(),
			result_bundle_sha256: protocol::canonical_hash(results)?,
			evaluator_bundle_sha256: protocol::canonical_hash(evaluators)?,
			verifier_bundle_sha256: protocol::canonical_hash(replays)?,
			cells,
		};

		bundle.verify(authorization, unit, results, evaluators, replays)?;

		Ok(bundle)
	}

	/// Verifies signer, evidence bindings, model-major order, retries, and provenance.
	pub fn verify(
		&self,
		authorization: &CandidateExecutionAuthorization,
		unit: &CandidateExecutionUnit,
		results: &CandidateResultPackageBundle,
		evaluators: &CandidateEvaluatorResultBundle,
		replays: &CandidateVerifierReplayBundle,
	) -> Result<Vec<CandidateCellAttemptLogPayload>, CandidateArtifactError> {
		let unit_payload = results.verify(authorization, unit)?;
		let evaluator_payloads = evaluators.verify(authorization, unit, results)?;
		let replay_payloads = replays.verify(authorization, unit, results, evaluators)?;

		if self.schema_version != CANDIDATE_ATTEMPT_LOG_BUNDLE_SCHEMA
			|| self.unit != results.unit
			|| self.result_bundle_sha256 != protocol::canonical_hash(results)?
			|| self.evaluator_bundle_sha256 != protocol::canonical_hash(evaluators)?
			|| self.verifier_bundle_sha256 != protocol::canonical_hash(replays)?
			|| self.cells.len() != unit_payload.run.results.len()
		{
			return Err(CandidateArtifactError::new(
				"candidate attempt-log bundle header or count is invalid",
			));
		}

		let signer = &authorization.plan.controlled_inputs.runner_signer_node_id;
		let mut payloads = Vec::with_capacity(self.cells.len());
		let mut digests = BTreeSet::new();

		for (index, envelope) in self.cells.iter().enumerate() {
			let result = &unit_payload.run.results[index];
			let payload: CandidateCellAttemptLogPayload =
				envelope.verify_payload(CANDIDATE_CELL_ATTEMPT_LOG_PAYLOAD_TYPE, signer)?;

			if payload.schema_version != CANDIDATE_CELL_ATTEMPT_LOG_PAYLOAD_TYPE
				|| payload.unit != self.unit
				|| payload.cell != candidate_cell_identity(unit, result, index)?
				|| payload.result_package_sha256 != results.cells[index].digest()?
				|| payload.evaluator_package_sha256 != evaluators.cells[index].digest()?
				|| payload.verifier_attestation_sha256 != replays.cells[index].digest()?
				|| !digests.insert(envelope.digest()?)
			{
				return Err(CandidateArtifactError::new(
					"candidate signed attempt-log cell is inconsistent or duplicated",
				));
			}

			validate_candidate_attempts(
				unit,
				result,
				&evaluator_payloads[index],
				&replay_payloads[index],
				&payload.result_package_sha256,
				&payload.verifier_attestation_sha256,
				&payload.attempts,
			)?;

			payloads.push(payload);
		}

		Ok(payloads)
	}
}

#[derive(Serialize)]
struct UnsignedCandidateEnvelope<'a> {
	schema_version: &'a str,
	idempotency_key: &'a str,
	payload_type: &'a str,
	content_hash: &'a str,
	signer: &'a NodeIdentity,
	claimed_trust: TrustTier,
	payload: &'a Value,
}

/// Signed independent replay disposition for one observation.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CandidateVerificationDisposition {
	/// The independent verifier replayed and matched the completed evaluator.
	CandidateEvaluatorReplayed,
	/// A noncompleted result has no evaluator and was not verified.
	CandidateResultNoncompletedNotVerified,
}

/// Closed disposition set for one candidate cell attempt.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CandidateAttemptDisposition {
	/// The attempt produced the required immutable evidence.
	Completed,
	/// A pre-model infrastructure failure permits a retry.
	InfrastructureRetryable,
	/// A pre-model infrastructure failure permits no retry.
	InfrastructureTerminal,
	/// The model attempt failed after model execution started.
	ModelFailure,
	/// Evaluation of the model result failed.
	EvaluatorFailure,
	/// The planned model or task was unsupported.
	Unsupported,
	/// The attempt has no evaluator result.
	Unevaluated,
}

/// Pre-model infrastructure classification allowed by the release-gate contract.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CandidateInfrastructureClassification {
	/// Admission failed before model execution started.
	PreModelAdmission,
}

fn validate_candidate_attempts(
	unit: &CandidateExecutionUnit,
	result: &TaskResult,
	evaluator: &CandidateCellEvaluatorPayload,
	replay: &CandidateCellVerificationPayload,
	result_package_sha256: &str,
	verifier_attestation_sha256: &str,
	attempts: &[CandidateAttempt],
) -> Result<(), CandidateArtifactError> {
	if attempts.is_empty() || attempts.len() > 3 {
		return Err(CandidateArtifactError::new(
			"candidate attempt history must contain one through three attempts",
		));
	}

	let slot_ms = canonical_timestamp_millis(&unit.slot_id)?;
	let expected_delays = [0_u64, 30, 90];
	let mut previous_started_ms = None;

	for (index, attempt) in attempts.iter().enumerate() {
		let scheduled_ms = canonical_timestamp_millis(&attempt.scheduled_for)?;
		let started_ms = canonical_timestamp_millis(&attempt.started_at)?;
		let delay = expected_delays[index];
		let expected_scheduled_ms = slot_ms
			.checked_add(i64::try_from(delay * 1_000).unwrap_or(i64::MAX))
			.ok_or_else(|| CandidateArtifactError::new("candidate attempt schedule overflows"))?;

		if attempt.attempt_number != index + 1
			|| attempt.scheduled_delay_seconds != delay
			|| scheduled_ms != expected_scheduled_ms
			|| started_ms < scheduled_ms
			|| previous_started_ms.is_some_and(|previous| started_ms <= previous)
		{
			return Err(CandidateArtifactError::new(
				"candidate attempt retry sequence or timing is invalid",
			));
		}

		previous_started_ms = Some(started_ms);

		if index + 1 < attempts.len()
			&& (attempt.disposition != CandidateAttemptDisposition::InfrastructureRetryable
				|| attempt.model_started
				|| attempt.infrastructure_classification.is_none()
				|| candidate_attempt_has_provenance(attempt))
		{
			return Err(CandidateArtifactError::new(
				"candidate nonterminal attempt is not a pre-model infrastructure retry",
			));
		}
	}

	let terminal = attempts.last().expect("nonempty attempt history");
	let expected = expected_terminal_disposition(result)?;

	if terminal.disposition != expected {
		return Err(CandidateArtifactError::new(
			"candidate terminal attempt does not match the task result",
		));
	}

	match terminal.disposition {
		CandidateAttemptDisposition::Completed => {
			let result_digest = result.content_hash()?;

			if !terminal.model_started
				|| terminal.infrastructure_classification.is_some()
				|| evaluator.evaluator.is_none()
				|| !replay.verified
				|| terminal.result_digest.as_deref() != Some(result_digest.as_str())
				|| terminal.result_package_digest.as_deref() != Some(result_package_sha256)
				|| terminal.verifier_attestation_digest.as_deref()
					!= Some(verifier_attestation_sha256)
			{
				return Err(CandidateArtifactError::new(
					"completed candidate attempt lacks verified result provenance",
				));
			}
		},
		CandidateAttemptDisposition::InfrastructureTerminal => {
			if terminal.model_started
				|| terminal.infrastructure_classification.is_none()
				|| candidate_attempt_has_provenance(terminal)
			{
				return Err(CandidateArtifactError::new(
					"terminal infrastructure attempt contains model provenance",
				));
			}
		},
		CandidateAttemptDisposition::EvaluatorFailure => {
			if !terminal.model_started
				|| terminal.infrastructure_classification.is_some()
				|| candidate_attempt_has_provenance(terminal)
			{
				return Err(CandidateArtifactError::new(
					"candidate evaluator failure attempt is invalid",
				));
			}
		},
		CandidateAttemptDisposition::Unsupported => {
			if terminal.model_started
				|| terminal.infrastructure_classification.is_some()
				|| candidate_attempt_has_provenance(terminal)
			{
				return Err(CandidateArtifactError::new(
					"candidate unsupported attempt contains model provenance",
				));
			}
		},
		CandidateAttemptDisposition::ModelFailure | CandidateAttemptDisposition::Unevaluated => {
			if terminal.infrastructure_classification.is_some()
				|| candidate_attempt_has_provenance(terminal)
			{
				return Err(CandidateArtifactError::new(
					"candidate incomplete attempt contains completed provenance",
				));
			}
		},
		CandidateAttemptDisposition::InfrastructureRetryable => {
			return Err(CandidateArtifactError::new(
				"candidate terminal attempt cannot remain retryable",
			));
		},
	}

	Ok(())
}

fn validate_candidate_verification_payload(
	result: &TaskResult,
	evaluator: Option<&CandidateEvaluatorResult>,
	payload: &CandidateCellVerificationPayload,
) -> Result<(), CandidateArtifactError> {
	let completed = result.status == ResultStatus::Completed;
	let expected_digest = evaluator.map(CandidateEvaluatorResult::digest).transpose()?;
	let valid = if completed {
		evaluator.is_some()
			&& payload.verified
			&& payload.disposition == CandidateVerificationDisposition::CandidateEvaluatorReplayed
			&& payload.replayed_evaluator_sha256 == expected_digest
	} else {
		evaluator.is_none()
			&& !payload.verified
			&& payload.disposition
				== CandidateVerificationDisposition::CandidateResultNoncompletedNotVerified
			&& payload.replayed_evaluator_sha256.is_none()
	};

	if !valid {
		return Err(CandidateArtifactError::new(
			"candidate verifier disposition does not match result completion and replay evidence",
		));
	}

	Ok(())
}

fn expected_terminal_disposition(
	result: &TaskResult,
) -> Result<CandidateAttemptDisposition, CandidateArtifactError> {
	match result.status {
		ResultStatus::Completed => Ok(CandidateAttemptDisposition::Completed),
		ResultStatus::Unsupported => Ok(CandidateAttemptDisposition::Unsupported),
		ResultStatus::Unevaluated => Ok(CandidateAttemptDisposition::Unevaluated),
		ResultStatus::Failed => match result.failure.as_ref().map(|failure| failure.kind) {
			Some(
				FailureKind::CapabilityUnavailable
				| FailureKind::CapabilityValidationFailed
				| FailureKind::WorkspaceUnavailable,
			) => Ok(CandidateAttemptDisposition::InfrastructureTerminal),
			Some(FailureKind::EvaluatorFailure) => {
				Ok(CandidateAttemptDisposition::EvaluatorFailure)
			},
			Some(_) => Ok(CandidateAttemptDisposition::ModelFailure),
			None => Err(CandidateArtifactError::new(
				"failed candidate result lacks a failure classification",
			)),
		},
	}
}

fn candidate_attempt_has_provenance(attempt: &CandidateAttempt) -> bool {
	attempt.result_digest.is_some()
		|| attempt.result_package_digest.is_some()
		|| attempt.verifier_attestation_digest.is_some()
}

fn canonical_timestamp_millis(value: &str) -> Result<i64, CandidateArtifactError> {
	let bytes = value.as_bytes();

	if bytes.len() != 24
		|| bytes[4] != b'-'
		|| bytes[7] != b'-'
		|| bytes[10] != b'T'
		|| bytes[13] != b':'
		|| bytes[16] != b':'
		|| bytes[19] != b'.'
		|| bytes[23] != b'Z'
		|| bytes.iter().enumerate().any(|(index, byte)| {
			!matches!(index, 4 | 7 | 10 | 13 | 16 | 19 | 23) && !byte.is_ascii_digit()
		}) {
		return Err(CandidateArtifactError::new(
			"candidate attempt timestamp is not canonical millisecond UTC",
		));
	}

	value
		.parse::<Timestamp>()
		.map(|timestamp| timestamp.as_millisecond())
		.map_err(|_| CandidateArtifactError::new("candidate attempt timestamp is invalid"))
}

fn require_runner_signer(
	authorization: &CandidateExecutionAuthorization,
	identity: &CandidateSigningIdentity,
) -> Result<(), CandidateArtifactError> {
	if identity.node().node_id != authorization.plan.controlled_inputs.runner_signer_node_id {
		return Err(CandidateArtifactError::new(
			"candidate result artifact signer is not the authorized runner",
		));
	}

	Ok(())
}

fn require_verifier_signer(
	authorization: &CandidateExecutionAuthorization,
	identity: &CandidateSigningIdentity,
) -> Result<(), CandidateArtifactError> {
	if identity.node().node_id != authorization.plan.controlled_inputs.verifier_signer_node_id
		|| identity.node().node_id == authorization.plan.controlled_inputs.runner_signer_node_id
	{
		return Err(CandidateArtifactError::new(
			"candidate replay artifact signer is not the distinct authorized verifier",
		));
	}

	Ok(())
}

fn validate_unit_run_shape(
	authorization: &CandidateExecutionAuthorization,
	unit: &CandidateExecutionUnit,
	run: &CalibrationRunRecord,
) -> Result<(), CandidateArtifactError> {
	let plan = &authorization.plan;
	let (harness, tool_policy, network_policy) = match unit.kind {
		CandidateExecutionUnitKind::Core => (
			&plan.runtime.core_harness_sha256,
			&plan.runtime.core_tool_policy_sha256,
			&plan.runtime.core_network_policy_sha256,
		),
		CandidateExecutionUnitKind::Contrast => (
			&plan.runtime.contrast_harness_sha256,
			&plan.runtime.contrast_tool_policy_sha256,
			&plan.runtime.contrast_network_policy_sha256,
		),
	};
	let expected_cells = unit
		.ordered_task_ids
		.len()
		.checked_mul(unit.models.len())
		.ok_or_else(|| CandidateArtifactError::new("candidate unit cell count overflows"))?;
	let catalog_digest = match unit.kind {
		CandidateExecutionUnitKind::Core => CANDIDATE_TASK_IDENTITY_SHA256,
		CandidateExecutionUnitKind::Contrast => CANDIDATE_CONTRAST_CATALOG_IDENTITY_SHA256,
	};
	let preflight_digest = protocol::canonical_hash(&run.capability_validation)?;

	if run.official_eligible
		|| run.classification != "local_calibration_non_official"
		|| run.scoring_version != AIQ_SCORING_VERSION
		|| run.task_ids != unit.ordered_task_ids
		|| run.results.len() != expected_cells
		|| run.models.len() != unit.models.len()
		|| run.provenance.run_class != RunClass::Calibration
		|| run.provenance.corpus_commitment_sha256 != unit.corpus_commitment_sha256
		|| run.provenance.catalog_digest != catalog_digest
		|| run.provenance.task_set_digest != run.task_set_hash
		|| run.provenance.preflight_digest != preflight_digest
		|| run.provenance.runner_executable_digest != plan.runtime.runner_executable_sha256
		|| run.provenance.harness_digest != harness.as_str()
		|| run.provenance.tool_policy_digest != tool_policy.as_str()
		|| run.provenance.network_policy_digest != network_policy.as_str()
		|| run
			.models
			.iter()
			.zip(&unit.models)
			.any(|(model, expected)| model.key() != expected.execution_model_id)
	{
		return Err(CandidateArtifactError::new(
			"candidate calibration run does not match its exact execution unit",
		));
	}

	for (index, result) in run.results.iter().enumerate() {
		candidate_cell_identity(unit, result, index)?;
	}

	Ok(())
}

fn candidate_cell_identity(
	unit: &CandidateExecutionUnit,
	result: &TaskResult,
	index: usize,
) -> Result<CandidateCellIdentity, CandidateArtifactError> {
	let task_count = unit.ordered_task_ids.len();

	if task_count == 0 {
		return Err(CandidateArtifactError::new("candidate unit task set is empty"));
	}

	let model_index = index / task_count;
	let task_index = index % task_count;
	let expected_task = unit
		.ordered_task_ids
		.get(task_index)
		.ok_or_else(|| CandidateArtifactError::new("candidate task result index is invalid"))?;
	let expected_model = unit
		.models
		.get(model_index)
		.ok_or_else(|| CandidateArtifactError::new("candidate model result index is invalid"))?;

	if result.task_id != *expected_task
		|| result.model.key() != expected_model.execution_model_id
		|| result.result_id
			!= format!("result_{}", result.content_hash()?.trim_start_matches("sha256:"))
	{
		return Err(CandidateArtifactError::new(
			"candidate task result ordering, identity, or content address is invalid",
		));
	}

	Ok(CandidateCellIdentity {
		repeat_id: unit.repeat_id.clone(),
		unit_id: unit.unit_id.clone(),
		result_index: index,
		task_id: result.task_id.clone(),
		task_version: result.task_version.clone(),
		model_id: expected_model.canonical_model_id.clone(),
		execution_model_id: expected_model.execution_model_id.clone(),
	})
}

fn validate_candidate_payload_type(value: &str) -> Result<(), CandidateArtifactError> {
	if matches!(
		value,
		CANDIDATE_UNIT_RUN_PAYLOAD_TYPE
			| CANDIDATE_CELL_RESULT_PAYLOAD_TYPE
			| CANDIDATE_CELL_EVALUATOR_PAYLOAD_TYPE
			| CANDIDATE_CELL_VERIFICATION_PAYLOAD_TYPE
			| CANDIDATE_CELL_ATTEMPT_LOG_PAYLOAD_TYPE
	) {
		Ok(())
	} else {
		Err(CandidateArtifactError::new("candidate payload type is unsupported"))
	}
}

fn validate_payload_schema(
	payload_type: &str,
	payload: &Value,
) -> Result<(), CandidateArtifactError> {
	if payload.as_object().and_then(|value| value.get("schema_version")).and_then(Value::as_str)
		== Some(payload_type)
	{
		Ok(())
	} else {
		Err(CandidateArtifactError::new(
			"candidate payload schema does not match its signed payload type",
		))
	}
}

fn validate_candidate_key(value: &str) -> Result<(), CandidateArtifactError> {
	if (1..=256).contains(&value.len())
		&& value.bytes().all(|byte| {
			byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
		}) {
		Ok(())
	} else {
		Err(CandidateArtifactError::new("candidate idempotency key is invalid"))
	}
}

fn candidate_node_id(public_key: &[u8; 32]) -> String {
	format!("node_{}", hex::encode(Sha256::digest(public_key)))
}

fn valid_node(node: &NodeIdentity) -> bool {
	valid_lower_hex(&node.public_key, 64)
		&& node.node_id.strip_prefix("node_").is_some_and(|digest| valid_lower_hex(digest, 64))
		&& hex::decode(&node.public_key)
			.ok()
			.and_then(|bytes| bytes.try_into().ok())
			.is_some_and(|public_key: [u8; 32]| candidate_node_id(&public_key) == node.node_id)
}

fn valid_digest(value: &str) -> bool {
	value
		.strip_prefix("sha256:")
		.is_some_and(|digest| valid_lower_hex(digest, 64) && digest != "0".repeat(64))
}

fn valid_lower_hex(value: &str, length: usize) -> bool {
	value.len() == length
		&& value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
	use std::collections::BTreeSet;

	use crate::candidate_artifacts::{
		CANDIDATE_CELL_RESULT_PAYLOAD_TYPE, CandidateSigningIdentity, TrustTier, Value,
	};

	#[derive(serde::Serialize)]
	struct Payload<'a> {
		schema_version: &'a str,
		value: &'a str,
	}

	#[test]
	fn candidate_envelope_round_trips_and_is_not_a_submission_envelope() {
		let identity = CandidateSigningIdentity::from_secret([7; 32]);
		let envelope = identity
			.sign(
				"repeat-01-core-cell-0001",
				CANDIDATE_CELL_RESULT_PAYLOAD_TYPE,
				&Payload { schema_version: CANDIDATE_CELL_RESULT_PAYLOAD_TYPE, value: "bound" },
			)
			.expect("candidate envelope");

		assert!(
			envelope.verify(CANDIDATE_CELL_RESULT_PAYLOAD_TYPE, &identity.node().node_id).is_ok()
		);
		assert!(envelope.digest().expect("digest").starts_with("sha256:"));
		assert!(
			serde_json::from_value::<crate::protocol::SubmissionEnvelope>(
				serde_json::to_value(&envelope).expect("candidate value")
			)
			.is_ok() && serde_json::from_value::<crate::protocol::SubmissionEnvelope>(
				serde_json::to_value(&envelope).expect("candidate value")
			)
			.expect("shape-compatible envelope")
			.verify(&BTreeSet::new())
			.is_err()
		);
	}

	#[test]
	fn candidate_envelope_rejects_tampering_wrong_signer_and_trust_upgrade() {
		let identity = CandidateSigningIdentity::from_secret([8; 32]);
		let other = CandidateSigningIdentity::from_secret([9; 32]);
		let envelope = identity
			.sign(
				"repeat-01-core-cell-0002",
				CANDIDATE_CELL_RESULT_PAYLOAD_TYPE,
				&Payload { schema_version: CANDIDATE_CELL_RESULT_PAYLOAD_TYPE, value: "bound" },
			)
			.expect("candidate envelope");

		assert!(
			envelope.verify(CANDIDATE_CELL_RESULT_PAYLOAD_TYPE, &other.node().node_id).is_err()
		);

		let mut tampered = envelope.clone();

		tampered.payload["value"] = Value::String("changed".to_owned());

		assert!(
			tampered.verify(CANDIDATE_CELL_RESULT_PAYLOAD_TYPE, &identity.node().node_id).is_err()
		);

		let mut upgraded = envelope;

		upgraded.claimed_trust = TrustTier::Trusted;

		assert!(
			upgraded.verify(CANDIDATE_CELL_RESULT_PAYLOAD_TYPE, &identity.node().node_id).is_err()
		);
	}
}
