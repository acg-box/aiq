//! Signed, bounded wire types for deferred distributed benchmark coordination.
//!
//! This module defines data exchange only. It does not register nodes, issue
//! keys, schedule network work, or execute a lease.

use std::{
	collections::{BTreeMap, BTreeSet},
	error::Error,
	fmt::{Display, Formatter},
	path::Component,
};

use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};

use crate::{
	model::{CapabilityStatus, MODEL_MATRIX, ModelCapability, ModelConfig},
	protocol::{self, NodeIdentity},
	submission::MAX_SUBMISSION_BYTES,
	task::{self, EVALUATOR_PROTOCOL_VERSION, TASK_SCHEMA_VERSION, TaskDefinition, Visibility},
};

/// Schema for every distributed control envelope.
pub const CONTROL_ENVELOPE_SCHEMA: &str = "aiq.distributed-envelope.v1";
/// Signed coordinator task-package payload type.
pub const TASK_PACKAGE_TYPE: &str = "aiq.distributed-task-package.v1";
/// Signed coordinator assignment payload type.
pub const ASSIGNMENT_TYPE: &str = "aiq.distributed-assignment.v1";
/// Signed node capability payload type.
pub const CAPABILITY_TYPE: &str = "aiq.distributed-capability.v1";
/// Signed node lifecycle observation payload type.
pub const OBSERVATION_TYPE: &str = "aiq.distributed-observation.v1";
/// Signed result-package receipt payload type.
pub const RECEIPT_TYPE: &str = "aiq.distributed-result-receipt.v1";
/// Deterministic aggregation-input schema.
pub const AGGREGATION_INPUT_SCHEMA: &str = "aiq.distributed-aggregation-input.v1";

const TASK_PACKAGE_DOMAIN: &str = "aiq.distributed/task-package/v1";
const ASSIGNMENT_DOMAIN: &str = "aiq.distributed/assignment/v1";
const CAPABILITY_DOMAIN: &str = "aiq.distributed/capability/v1";
const OBSERVATION_DOMAIN: &str = "aiq.distributed/observation/v1";
const RECEIPT_DOMAIN: &str = "aiq.distributed/result-receipt/v1";
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_CONTROL_BYTES: usize = 4 * 1_024 * 1_024;
const MAX_TASKS: usize = 72;
const MAX_MODELS: usize = MODEL_MATRIX.len();
const MAX_ASSIGNMENTS: usize = MAX_TASKS * MAX_MODELS;
const MAX_REFERENCES: usize = 64;
const MAX_REASON_BYTES: usize = 512;
const MAX_URI_BYTES: usize = 2_048;
const MAX_VERSION_BYTES: usize = 128;
const MAX_PROMPT_BYTES: usize = 1_024 * 1_024;
const MAX_LEASE_SECONDS: u64 = 24 * 60 * 60;
const MAX_CAPABILITY_SECONDS: u64 = 24 * 60 * 60;
const MAX_OBSERVATION_SECONDS: u64 = 15 * 60;
const MAX_ATTEMPT: u32 = 100;

/// A typed payload that has a fixed signature domain.
pub trait ControlPayload: Serialize + DeserializeOwned + Clone {
	/// Exact payload type included in the signed bytes.
	const PAYLOAD_TYPE: &'static str;
	/// Exact signature domain included in the signed bytes.
	const SIGNATURE_DOMAIN: &'static str;

	/// Validates payload semantics and signer ownership.
	fn validate(&self, signer: &NodeIdentity) -> Result<(), DistributedError>;
}

/// A distributed-protocol validation or verification error.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DistributedError {
	message: String,
}
impl DistributedError {
	fn new(message: impl Into<String>) -> Self {
		Self { message: message.into() }
	}
}

impl Display for DistributedError {
	fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
		formatter.write_str(&self.message)
	}
}

impl Error for DistributedError {}

/// Receiver-side signer authorization. A signature alone does not grant trust.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ReceiverPolicy {
	/// Node identifiers that this receiver currently authorizes.
	pub trusted_signers: BTreeSet<String>,
}

/// A content-addressed and domain-separated signed control message.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields, bound(deserialize = "T: DeserializeOwned"))]
pub struct SignedControlEnvelope<T> {
	/// Control-envelope schema version.
	pub schema_version: String,
	/// Exact payload type.
	pub payload_type: String,
	/// Signature domain. This prevents replay as another message purpose.
	pub signature_domain: String,
	/// JCS SHA-256 address of the typed payload.
	pub content_hash: String,
	/// Public signing identity.
	pub signer: NodeIdentity,
	/// Typed payload.
	pub payload: T,
	/// Ed25519 signature encoded as lowercase hexadecimal.
	pub signature: String,
}
impl<T> SignedControlEnvelope<T>
where
	T: ControlPayload,
{
	/// Creates a signed envelope from deployment-supplied Ed25519 key material.
	pub fn sign(secret: [u8; 32], payload: T) -> Result<Self, DistributedError> {
		let signing_key = SigningKey::from_bytes(&secret);
		let public_key = signing_key.verifying_key();
		let signer = identity_from_key(&public_key);

		payload.validate(&signer)?;

		let content_hash = protocol::canonical_hash(&payload).map_err(protocol_error)?;
		let unsigned = UnsignedControlEnvelope {
			schema_version: CONTROL_ENVELOPE_SCHEMA,
			payload_type: T::PAYLOAD_TYPE,
			signature_domain: T::SIGNATURE_DOMAIN,
			content_hash: &content_hash,
			signer: &signer,
			payload: &payload,
		};
		let bytes = protocol::canonical_json(&unsigned).map_err(protocol_error)?;

		if bytes.len() > MAX_CONTROL_BYTES {
			return Err(DistributedError::new("control envelope exceeds the byte limit"));
		}

		let signature = signing_key.sign(&bytes);

		Ok(Self {
			schema_version: CONTROL_ENVELOPE_SCHEMA.to_owned(),
			payload_type: T::PAYLOAD_TYPE.to_owned(),
			signature_domain: T::SIGNATURE_DOMAIN.to_owned(),
			content_hash,
			signer,
			payload,
			signature: hex::encode(signature.to_bytes()),
		})
	}

	/// Verifies shape, identity, payload commitment, signature, and receiver trust.
	pub fn verify(&self, policy: &ReceiverPolicy) -> Result<VerifiedControl<T>, DistributedError> {
		if self.schema_version != CONTROL_ENVELOPE_SCHEMA {
			return Err(DistributedError::new("unsupported control-envelope schema"));
		}
		if self.payload_type != T::PAYLOAD_TYPE || self.signature_domain != T::SIGNATURE_DOMAIN {
			return Err(DistributedError::new("payload type or signature domain is incorrect"));
		}

		validate_node_identity(&self.signer)?;
		validate_hash(&self.content_hash, "content hash")?;
		validate_lower_hex(&self.signature, 128, "signature")?;

		self.payload.validate(&self.signer)?;

		if protocol::canonical_hash(&self.payload).map_err(protocol_error)? != self.content_hash {
			return Err(DistributedError::new("payload content hash does not match"));
		}

		let public_bytes = hex::decode(&self.signer.public_key)
			.map_err(|error| DistributedError::new(format!("invalid public key: {error}")))?;
		let public_array: [u8; 32] = public_bytes
			.try_into()
			.map_err(|_| DistributedError::new("public key must contain 32 bytes"))?;
		let public_key = VerifyingKey::from_bytes(&public_array)
			.map_err(|error| DistributedError::new(format!("invalid public key: {error}")))?;
		let signature_bytes = hex::decode(&self.signature)
			.map_err(|error| DistributedError::new(format!("invalid signature: {error}")))?;
		let signature = Signature::from_slice(&signature_bytes)
			.map_err(|error| DistributedError::new(format!("invalid signature: {error}")))?;
		let unsigned = UnsignedControlEnvelope {
			schema_version: &self.schema_version,
			payload_type: &self.payload_type,
			signature_domain: &self.signature_domain,
			content_hash: &self.content_hash,
			signer: &self.signer,
			payload: &self.payload,
		};
		let bytes = protocol::canonical_json(&unsigned).map_err(protocol_error)?;

		if bytes.len() > MAX_CONTROL_BYTES {
			return Err(DistributedError::new("control envelope exceeds the byte limit"));
		}

		public_key.verify(&bytes, &signature).map_err(|error| {
			DistributedError::new(format!("signature verification failed: {error}"))
		})?;

		let receiver_trust = if policy.trusted_signers.contains(&self.signer.node_id) {
			ReceiverTrust::ReceiverVerifiedTrusted
		} else {
			ReceiverTrust::SignedUntrusted
		};

		Ok(VerifiedControl {
			content_hash: self.content_hash.clone(),
			signer: self.signer.clone(),
			receiver_trust,
			payload: self.payload.clone(),
		})
	}
}

impl SignedControlEnvelope<TaskAssignment> {
	/// Verifies an assignment against its exact package, node, capability, and time.
	pub fn verify_for_node(
		&self,
		policy: &ReceiverPolicy,
		now: u64,
		expected_node_id: &str,
		package: &VerifiedControl<CoordinatorTaskPackage>,
		capability: &VerifiedControl<NodeCapabilityDeclaration>,
	) -> Result<VerifiedControl<TaskAssignment>, DistributedError> {
		validate_time(now, "receiver time")?;

		let verified = self.verify(policy)?;
		let assignment = &verified.payload;

		if assignment.target_node_id != expected_node_id
			|| capability.payload.node_id != expected_node_id
			|| capability.signer.node_id != expected_node_id
		{
			return Err(DistributedError::new("assignment targets a different node"));
		}
		if assignment.coordinator_id != package.signer.node_id {
			return Err(DistributedError::new(
				"assignment and task package have different coordinators",
			));
		}
		if assignment.task_package_hash != package.content_hash
			|| assignment.run.task_package_hash != package.content_hash
		{
			return Err(DistributedError::new(
				"assignment does not bind the supplied task package",
			));
		}
		if assignment.target_capability_hash != capability.content_hash {
			return Err(DistributedError::new(
				"assignment does not bind the supplied capability claim",
			));
		}
		if assignment.lease.issued_at < package.payload.valid_from
			|| assignment.lease.expires_at > package.payload.expires_at
		{
			return Err(DistributedError::new("assignment lease is outside package validity"));
		}
		if now < assignment.lease.not_before || now >= assignment.lease.expires_at {
			return Err(DistributedError::new("assignment lease is not currently active"));
		}
		if now >= capability.payload.expires_at
			|| assignment.lease.issued_at < capability.payload.observed_at
			|| assignment.lease.expires_at > capability.payload.expires_at
		{
			return Err(DistributedError::new("assignment capability binding is stale"));
		}
		if matches!(
			assignment.lease.state,
			LeaseState::Completed | LeaseState::Revoked | LeaseState::Expired
		) {
			return Err(DistributedError::new("assignment lease is terminal"));
		}

		for model in &assignment.models {
			if capability.payload.capability(*model).map(|claim| &claim.status)
				!= Some(&CapabilityStatus::Available)
			{
				return Err(DistributedError::new(
					"target capability does not declare every assigned model available",
				));
			}
		}

		Ok(verified)
	}
}

impl SignedControlEnvelope<NodeObservation> {
	/// Verifies a live heartbeat against its exact node capability declaration.
	pub fn verify_at(
		&self,
		policy: &ReceiverPolicy,
		now: u64,
		capability: &VerifiedControl<NodeCapabilityDeclaration>,
	) -> Result<VerifiedControl<NodeObservation>, DistributedError> {
		validate_time(now, "receiver time")?;

		let verified = self.verify(policy)?;

		if verified.payload.node_id != capability.payload.node_id
			|| verified.signer.node_id != capability.signer.node_id
		{
			return Err(DistributedError::new(
				"observation and capability refer to different nodes",
			));
		}
		if verified.payload.capability_hash != capability.content_hash {
			return Err(DistributedError::new(
				"observation does not bind the supplied capability declaration",
			));
		}
		if now < verified.payload.observed_at
			|| now >= verified.payload.valid_until
			|| now >= capability.payload.expires_at
		{
			return Err(DistributedError::new("observation or capability declaration is stale"));
		}

		Ok(verified)
	}
}

impl SignedControlEnvelope<ResultPackageReceipt> {
	/// Verifies receipt provenance against the coordinator assignment it closes.
	pub fn verify_for_assignment(
		&self,
		policy: &ReceiverPolicy,
		assignment: &VerifiedControl<TaskAssignment>,
	) -> Result<VerifiedControl<ResultPackageReceipt>, DistributedError> {
		let verified = self.verify(policy)?;
		let receipt = &verified.payload;
		let assigned = &assignment.payload;

		if receipt.producer_node_id != assigned.target_node_id
			|| receipt.assignment_id != assigned.assignment_id
			|| receipt.run_id != assigned.run_id
			|| receipt.attempt != assigned.lease.attempt
			|| receipt.capability_hash != assigned.target_capability_hash
		{
			return Err(DistributedError::new(
				"result receipt does not bind the supplied assignment provenance",
			));
		}
		if receipt.completed_at < assigned.lease.not_before
			|| receipt.completed_at >= assigned.lease.expires_at
		{
			return Err(DistributedError::new("result completion is outside the assignment lease"));
		}

		Ok(verified)
	}
}

/// A verified control message with receiver-evaluated trust.
#[derive(Clone, Debug, PartialEq)]
pub struct VerifiedControl<T> {
	/// Verified payload address.
	pub content_hash: String,
	/// Verified signing identity.
	pub signer: NodeIdentity,
	/// Receiver trust decision.
	pub receiver_trust: ReceiverTrust,
	/// Validated typed payload.
	pub payload: T,
}

/// Separate commitments for content that must not change during a run.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TaskContentCommitments {
	/// Hash of the complete task definition.
	pub task_hash: String,
	/// Hash of the evaluator definition, or `None` when the task has no evaluator.
	pub evaluator_hash: Option<String>,
	/// Hash of the ordered fixture-reference list.
	pub fixture_refs_hash: String,
}

/// One task and its independently checkable content commitments.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CommittedTask {
	/// Complete controlled task definition.
	pub task: TaskDefinition,
	/// Immutable task, evaluator, and fixture commitments.
	pub commitments: TaskContentCommitments,
}
impl CommittedTask {
	/// Creates exact commitments for a task definition.
	pub fn from_task(task: TaskDefinition) -> Result<Self, DistributedError> {
		let commitments = TaskContentCommitments {
			task_hash: task.content_hash().map_err(protocol_error)?,
			evaluator_hash: task
				.evaluator
				.as_ref()
				.map(crate::protocol::canonical_hash)
				.transpose()
				.map_err(protocol_error)?,
			fixture_refs_hash: protocol::canonical_hash(&task.fixture_refs)
				.map_err(protocol_error)?,
		};

		Ok(Self { task, commitments })
	}

	fn validate(&self) -> Result<(), DistributedError> {
		validate_wire_task(&self.task)?;
		validate_hash(&self.commitments.task_hash, "task hash")?;
		validate_hash(&self.commitments.fixture_refs_hash, "fixture reference hash")?;

		if self.task.content_hash().map_err(protocol_error)? != self.commitments.task_hash {
			return Err(DistributedError::new("task definition does not match its commitment"));
		}

		let evaluator_hash = self
			.task
			.evaluator
			.as_ref()
			.map(crate::protocol::canonical_hash)
			.transpose()
			.map_err(protocol_error)?;

		if evaluator_hash != self.commitments.evaluator_hash {
			return Err(DistributedError::new("evaluator does not match its commitment"));
		}
		if protocol::canonical_hash(&self.task.fixture_refs).map_err(protocol_error)?
			!= self.commitments.fixture_refs_hash
		{
			return Err(DistributedError::new("fixture references do not match their commitment"));
		}

		Ok(())
	}
}

/// A signed task package issued by a coordinator.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CoordinatorTaskPackage {
	/// Payload schema.
	pub schema_version: String,
	/// Stable package identifier.
	pub package_id: String,
	/// Coordinator that is authorized to sign this package.
	pub coordinator_id: String,
	/// Controlled corpus-release identifier.
	pub corpus_release_id: String,
	/// Hash of the ordered committed tasks.
	pub task_set_hash: String,
	/// First Unix second in which assignments can use this package.
	pub valid_from: u64,
	/// Last Unix second in which assignments can use this package.
	pub expires_at: u64,
	/// Ordered committed tasks.
	pub tasks: Vec<CommittedTask>,
}
impl CoordinatorTaskPackage {
	/// Assigns the deterministic package and task-set identifiers.
	pub fn finalize(&mut self) -> Result<(), DistributedError> {
		self.task_set_hash = protocol::canonical_hash(
			&self.tasks.iter().map(|task| &task.commitments).collect::<Vec<_>>(),
		)
		.map_err(protocol_error)?;
		self.package_id = prefixed_hash(
			"taskpkg_",
			&(
				&self.coordinator_id,
				&self.corpus_release_id,
				&self.task_set_hash,
				self.valid_from,
				self.expires_at,
			),
		)?;

		Ok(())
	}
}

impl ControlPayload for CoordinatorTaskPackage {
	const PAYLOAD_TYPE: &'static str = TASK_PACKAGE_TYPE;
	const SIGNATURE_DOMAIN: &'static str = TASK_PACKAGE_DOMAIN;

	fn validate(&self, signer: &NodeIdentity) -> Result<(), DistributedError> {
		if self.schema_version != TASK_PACKAGE_TYPE {
			return Err(DistributedError::new("unsupported task-package schema"));
		}
		if signer.node_id != self.coordinator_id {
			return Err(DistributedError::new("task package is not bound to its coordinator"));
		}

		validate_prefixed_hash(&self.package_id, "taskpkg_", "package identifier")?;
		validate_hash(&self.task_set_hash, "task-set hash")?;
		validate_token(&self.corpus_release_id, 128, "corpus release identifier")?;
		validate_interval(self.valid_from, self.expires_at, 90 * 24 * 60 * 60, "package")?;
		bounded_nonempty(&self.tasks, MAX_TASKS, "tasks")?;

		let mut task_keys = BTreeSet::new();

		for task in &self.tasks {
			task.validate()?;

			if !task_keys.insert((task.task.task_id.clone(), task.task.task_version.clone())) {
				return Err(DistributedError::new("task package contains a duplicate task"));
			}
		}

		let expected_set = protocol::canonical_hash(
			&self.tasks.iter().map(|task| &task.commitments).collect::<Vec<_>>(),
		)
		.map_err(protocol_error)?;

		if expected_set != self.task_set_hash {
			return Err(DistributedError::new("task set does not match its commitment"));
		}

		let expected_id = prefixed_hash(
			"taskpkg_",
			&(
				&self.coordinator_id,
				&self.corpus_release_id,
				&self.task_set_hash,
				self.valid_from,
				self.expires_at,
			),
		)?;

		if expected_id != self.package_id {
			return Err(DistributedError::new("package identifier is not deterministic"));
		}

		Ok(())
	}
}

/// Immutable schedule and run identity inputs.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RunIdentity {
	/// Stable schedule occurrence identifier.
	pub schedule_id: String,
	/// Hash of the concrete schedule slot.
	pub schedule_slot_hash: String,
	/// Signed task-package content hash.
	pub task_package_hash: String,
	/// Exact ordered model matrix for the run.
	pub models: Vec<ModelConfig>,
	/// Scoring implementation version.
	pub scoring_version: String,
}
impl RunIdentity {
	/// Returns the deterministic run identifier.
	pub fn run_id(&self) -> Result<String, DistributedError> {
		self.validate()?;

		prefixed_hash("run_", self)
	}

	fn validate(&self) -> Result<(), DistributedError> {
		validate_prefixed_hash(&self.schedule_id, "schedule_", "schedule identifier")?;
		validate_hash(&self.schedule_slot_hash, "schedule-slot hash")?;
		validate_hash(&self.task_package_hash, "task-package hash")?;
		validate_version(&self.scoring_version, "scoring version")?;

		validate_models(&self.models, true)
	}
}

/// One bounded attempt to execute an assignment.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Lease {
	/// Deterministic identifier for this assignment attempt.
	pub lease_id: String,
	/// One-based attempt number.
	pub attempt: u32,
	/// Current signed lease state.
	pub state: LeaseState,
	/// Lease issue time as a Unix second.
	pub issued_at: u64,
	/// First permitted execution time.
	pub not_before: u64,
	/// Exclusive expiry time.
	pub expires_at: u64,
}

/// A signed coordinator assignment to one exact node and capability claim.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TaskAssignment {
	/// Payload schema.
	pub schema_version: String,
	/// Stable assignment identifier across bounded retries.
	pub assignment_id: String,
	/// Coordinator that signs the assignment.
	pub coordinator_id: String,
	/// Deterministic run identifier.
	pub run_id: String,
	/// Immutable schedule and run identity.
	pub run: RunIdentity,
	/// Signed task-package content hash.
	pub task_package_hash: String,
	/// Models allocated to this node.
	pub models: Vec<ModelConfig>,
	/// Exact target node.
	pub target_node_id: String,
	/// Exact signed capability-declaration content hash.
	pub target_capability_hash: String,
	/// Current lease attempt.
	pub lease: Lease,
}
impl TaskAssignment {
	/// Assigns deterministic run, assignment, and lease identifiers.
	pub fn finalize(&mut self) -> Result<(), DistributedError> {
		self.run_id = self.run.run_id()?;
		self.assignment_id = prefixed_hash(
			"assignment_",
			&(&self.run_id, &self.task_package_hash, &self.models, &self.target_node_id),
		)?;
		self.lease.lease_id = prefixed_hash("lease_", &(&self.assignment_id, self.lease.attempt))?;

		Ok(())
	}

	fn validate_semantics(&self) -> Result<(), DistributedError> {
		if self.schema_version != ASSIGNMENT_TYPE {
			return Err(DistributedError::new("unsupported assignment schema"));
		}

		validate_prefixed_hash(&self.assignment_id, "assignment_", "assignment identifier")?;
		validate_prefixed_hash(&self.lease.lease_id, "lease_", "lease identifier")?;
		validate_node_id(&self.target_node_id)?;
		validate_hash(&self.target_capability_hash, "target capability hash")?;
		validate_hash(&self.task_package_hash, "task-package hash")?;

		self.run.validate()?;

		if self.run.task_package_hash != self.task_package_hash {
			return Err(DistributedError::new("assignment and run bind different task packages"));
		}
		if self.run.run_id()? != self.run_id {
			return Err(DistributedError::new("run identifier is not idempotent"));
		}

		validate_models(&self.models, false)?;

		if self.models.iter().any(|model| !self.run.models.contains(model)) {
			return Err(DistributedError::new("assigned model is not in the committed run matrix"));
		}
		if self.lease.attempt == 0 || self.lease.attempt > MAX_ATTEMPT {
			return Err(DistributedError::new("lease attempt is outside its bound"));
		}

		validate_safe_integer(self.lease.attempt.into(), "lease attempt")?;
		validate_interval(self.lease.issued_at, self.lease.expires_at, MAX_LEASE_SECONDS, "lease")?;
		validate_time(self.lease.not_before, "lease not-before time")?;

		if self.lease.not_before < self.lease.issued_at
			|| self.lease.not_before >= self.lease.expires_at
		{
			return Err(DistributedError::new("lease times are not ordered"));
		}

		let expected_assignment = prefixed_hash(
			"assignment_",
			&(&self.run_id, &self.task_package_hash, &self.models, &self.target_node_id),
		)?;

		if expected_assignment != self.assignment_id {
			return Err(DistributedError::new("assignment identifier is not deterministic"));
		}

		let expected_lease = prefixed_hash("lease_", &(&self.assignment_id, self.lease.attempt))?;

		if expected_lease != self.lease.lease_id {
			return Err(DistributedError::new("lease identifier is not deterministic"));
		}

		Ok(())
	}
}

impl ControlPayload for TaskAssignment {
	const PAYLOAD_TYPE: &'static str = ASSIGNMENT_TYPE;
	const SIGNATURE_DOMAIN: &'static str = ASSIGNMENT_DOMAIN;

	fn validate(&self, signer: &NodeIdentity) -> Result<(), DistributedError> {
		if signer.node_id != self.coordinator_id {
			return Err(DistributedError::new("assignment is not bound to its coordinator"));
		}

		self.validate_semantics()
	}
}

/// Signed declaration of one node's current model capabilities.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct NodeCapabilityDeclaration {
	/// Payload schema.
	pub schema_version: String,
	/// Declaring node.
	pub node_id: String,
	/// Observation time as a Unix second.
	pub observed_at: u64,
	/// Exclusive claim expiry time.
	pub expires_at: u64,
	/// Exact runner version.
	pub runner_version: String,
	/// Exact Codex CLI version.
	pub codex_version: String,
	/// Unique matrix capability declarations.
	pub models: Vec<ModelCapability>,
}
impl NodeCapabilityDeclaration {
	fn capability(&self, model: ModelConfig) -> Option<&ModelCapability> {
		self.models.iter().find(|claim| claim.model == model)
	}
}

impl ControlPayload for NodeCapabilityDeclaration {
	const PAYLOAD_TYPE: &'static str = CAPABILITY_TYPE;
	const SIGNATURE_DOMAIN: &'static str = CAPABILITY_DOMAIN;

	fn validate(&self, signer: &NodeIdentity) -> Result<(), DistributedError> {
		if self.schema_version != CAPABILITY_TYPE {
			return Err(DistributedError::new("unsupported capability schema"));
		}
		if self.node_id != signer.node_id {
			return Err(DistributedError::new("capability declaration is not bound to its node"));
		}

		validate_interval(
			self.observed_at,
			self.expires_at,
			MAX_CAPABILITY_SECONDS,
			"capability declaration",
		)?;
		validate_version(&self.runner_version, "runner version")?;
		validate_version(&self.codex_version, "Codex version")?;
		bounded_nonempty(&self.models, MAX_MODELS, "capability models")?;

		let matrix = MODEL_MATRIX.into_iter().collect::<BTreeSet<_>>();
		let mut models = BTreeSet::new();

		for claim in &self.models {
			if !matrix.contains(&claim.model) {
				return Err(DistributedError::new("capability model is outside the fixed matrix"));
			}
			if !models.insert(claim.model) {
				return Err(DistributedError::new(
					"capability declaration contains a duplicate model",
				));
			}

			match (&claim.status, &claim.reason) {
				(CapabilityStatus::Available, None) => {},
				(CapabilityStatus::Unsupported, Some(reason)) => {
					validate_text(reason, MAX_REASON_BYTES, "capability reason")?;
				},
				_ => {
					return Err(DistributedError::new(
						"capability reason does not match its status",
					));
				},
			}
		}

		Ok(())
	}
}

/// A signed lifecycle and heartbeat observation from one node.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct NodeObservation {
	/// Payload schema.
	pub schema_version: String,
	/// Stable observation identifier.
	pub observation_id: String,
	/// Observed node.
	pub node_id: String,
	/// Strictly increasing node-local sequence number.
	pub sequence: u64,
	/// Observation time as a Unix second.
	pub observed_at: u64,
	/// Exclusive validity time.
	pub valid_until: u64,
	/// Current lifecycle.
	pub lifecycle: NodeLifecycle,
	/// Capability declaration used by this observation.
	pub capability_hash: String,
	/// Active assignment identifiers in sorted order.
	pub active_assignment_ids: Vec<String>,
	/// Previous observation content hash, absent only at sequence one.
	pub previous_observation_hash: Option<String>,
}
impl NodeObservation {
	/// Assigns the deterministic observation identifier.
	pub fn finalize(&mut self) -> Result<(), DistributedError> {
		self.observation_id =
			prefixed_hash("observation_", &(&self.node_id, self.sequence, self.observed_at))?;

		Ok(())
	}
}

impl ControlPayload for NodeObservation {
	const PAYLOAD_TYPE: &'static str = OBSERVATION_TYPE;
	const SIGNATURE_DOMAIN: &'static str = OBSERVATION_DOMAIN;

	fn validate(&self, signer: &NodeIdentity) -> Result<(), DistributedError> {
		if self.schema_version != OBSERVATION_TYPE {
			return Err(DistributedError::new("unsupported observation schema"));
		}
		if self.node_id != signer.node_id {
			return Err(DistributedError::new("observation is not bound to its node"));
		}

		validate_prefixed_hash(&self.observation_id, "observation_", "observation identifier")?;

		if self.sequence == 0 {
			return Err(DistributedError::new("observation sequence must be positive"));
		}

		validate_safe_integer(self.sequence, "observation sequence")?;
		validate_interval(
			self.observed_at,
			self.valid_until,
			MAX_OBSERVATION_SECONDS,
			"observation",
		)?;
		validate_hash(&self.capability_hash, "capability hash")?;
		bounded(&self.active_assignment_ids, MAX_ASSIGNMENTS, "active assignments")?;
		validate_sorted_unique_prefixed(
			&self.active_assignment_ids,
			"assignment_",
			"active assignments",
		)?;

		match (self.sequence, &self.previous_observation_hash) {
			(1, None) => {},
			(1, Some(_)) | (_, None) => {
				return Err(DistributedError::new("observation chain does not match its sequence"));
			},
			(_, Some(hash)) => validate_hash(hash, "previous observation hash")?,
		}

		if self.lifecycle == NodeLifecycle::Ready && !self.active_assignment_ids.is_empty() {
			return Err(DistributedError::new("a ready observation cannot report active work"));
		}

		let expected =
			prefixed_hash("observation_", &(&self.node_id, self.sequence, self.observed_at))?;

		if expected != self.observation_id {
			return Err(DistributedError::new("observation identifier is not deterministic"));
		}

		Ok(())
	}
}

/// A bounded content-addressed object reference.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ContentReference {
	/// Stable reference kind.
	pub kind: String,
	/// SHA-256 address of the referenced bytes.
	pub content_hash: String,
	/// Storage-independent or receiver-owned URI.
	pub uri: String,
	/// Referenced byte count.
	pub bytes: u64,
}
impl ContentReference {
	fn validate(&self, maximum_bytes: u64) -> Result<(), DistributedError> {
		validate_token(&self.kind, 64, "reference kind")?;
		validate_hash(&self.content_hash, "reference content hash")?;
		validate_text(&self.uri, MAX_URI_BYTES, "reference URI")?;

		if self.uri.chars().any(char::is_whitespace) || !self.uri.contains(':') {
			return Err(DistributedError::new("reference URI is not an absolute URI"));
		}

		validate_safe_integer(self.bytes, "reference byte count")?;

		if self.bytes == 0 || self.bytes > maximum_bytes {
			return Err(DistributedError::new("reference byte count is outside its bound"));
		}

		Ok(())
	}
}

/// Signed receiver receipt for one exact result package and its provenance.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ResultPackageReceipt {
	/// Payload schema.
	pub schema_version: String,
	/// Stable receipt identifier.
	pub receipt_id: String,
	/// Receiver that signs the receipt.
	pub receiver_id: String,
	/// Producing node.
	pub producer_node_id: String,
	/// Assignment and lease that authorized the result.
	pub assignment_id: String,
	/// Run identifier.
	pub run_id: String,
	/// Lease attempt.
	pub attempt: u32,
	/// Exact capability declaration used for execution.
	pub capability_hash: String,
	/// Signed result-package reference.
	pub result_package: ContentReference,
	/// Additional immutable provenance references.
	pub provenance: Vec<ContentReference>,
	/// Node completion time.
	pub completed_at: u64,
	/// Receiver observation time.
	pub received_at: u64,
}
impl ResultPackageReceipt {
	/// Assigns the deterministic receipt identifier.
	pub fn finalize(&mut self) -> Result<(), DistributedError> {
		self.receipt_id = prefixed_hash(
			"receipt_",
			&(
				&self.receiver_id,
				&self.assignment_id,
				self.attempt,
				&self.result_package.content_hash,
			),
		)?;

		Ok(())
	}
}

impl ControlPayload for ResultPackageReceipt {
	const PAYLOAD_TYPE: &'static str = RECEIPT_TYPE;
	const SIGNATURE_DOMAIN: &'static str = RECEIPT_DOMAIN;

	fn validate(&self, signer: &NodeIdentity) -> Result<(), DistributedError> {
		if self.schema_version != RECEIPT_TYPE {
			return Err(DistributedError::new("unsupported result-receipt schema"));
		}
		if self.receiver_id != signer.node_id {
			return Err(DistributedError::new("result receipt is not bound to its receiver"));
		}

		validate_node_id(&self.producer_node_id)?;
		validate_prefixed_hash(&self.receipt_id, "receipt_", "receipt identifier")?;
		validate_prefixed_hash(&self.assignment_id, "assignment_", "assignment identifier")?;
		validate_prefixed_hash(&self.run_id, "run_", "run identifier")?;
		validate_hash(&self.capability_hash, "capability hash")?;

		if self.attempt == 0 || self.attempt > MAX_ATTEMPT {
			return Err(DistributedError::new("receipt attempt is outside its bound"));
		}

		let maximum_package_bytes = u64::try_from(MAX_SUBMISSION_BYTES)
			.map_err(|_| DistributedError::new("submission byte limit is not representable"))?;

		self.result_package.validate(maximum_package_bytes)?;

		if self.result_package.kind != "result_package" {
			return Err(DistributedError::new("receipt primary reference is not a result package"));
		}

		bounded(&self.provenance, MAX_REFERENCES, "provenance references")?;

		let mut references = BTreeSet::new();

		for reference in &self.provenance {
			reference.validate(maximum_package_bytes)?;

			if !references.insert((reference.kind.clone(), reference.content_hash.clone())) {
				return Err(DistributedError::new(
					"receipt contains a duplicate provenance reference",
				));
			}
		}

		validate_time(self.completed_at, "completion time")?;
		validate_time(self.received_at, "receipt time")?;

		if self.completed_at > self.received_at {
			return Err(DistributedError::new("result was received before completion"));
		}

		let expected = prefixed_hash(
			"receipt_",
			&(
				&self.receiver_id,
				&self.assignment_id,
				self.attempt,
				&self.result_package.content_hash,
			),
		)?;

		if expected != self.receipt_id {
			return Err(DistributedError::new("receipt identifier is not deterministic"));
		}

		Ok(())
	}
}

/// Why a signed or expected contribution cannot enter trusted aggregation.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Rejection {
	/// Stable bounded reason code.
	pub reason_code: String,
	/// Optional content hash of the rejected signed message.
	pub evidence_hash: Option<String>,
}

/// Deterministic trust-layer input for a later aggregation stage.
///
/// This type contains no scores and does not decide benchmark outcomes.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AggregationInput {
	/// Aggregation DTO schema.
	pub schema_version: String,
	/// Exact run identifier.
	pub run_id: String,
	/// One contribution for every expected assignment and model.
	pub contributions: Vec<AggregationContribution>,
}
impl AggregationInput {
	/// Sorts and validates contributions without computing a benchmark score.
	pub fn new(
		run_id: String,
		mut contributions: Vec<AggregationContribution>,
	) -> Result<Self, DistributedError> {
		contributions.sort_by(|left, right| left.key().cmp(&right.key()));

		let value =
			Self { schema_version: AGGREGATION_INPUT_SCHEMA.to_owned(), run_id, contributions };

		value.validate()?;

		Ok(value)
	}

	/// Validates stable ordering, uniqueness, bounds, and trust-layer shape.
	pub fn validate(&self) -> Result<(), DistributedError> {
		if self.schema_version != AGGREGATION_INPUT_SCHEMA {
			return Err(DistributedError::new("unsupported aggregation-input schema"));
		}

		validate_prefixed_hash(&self.run_id, "run_", "run identifier")?;
		bounded_nonempty(&self.contributions, MAX_ASSIGNMENTS, "aggregation contributions")?;

		let mut previous = None;

		for contribution in &self.contributions {
			contribution.validate()?;

			let key = (contribution.key().0.to_owned(), contribution.key().1);

			if previous.as_ref().is_some_and(|prior| prior >= &key) {
				return Err(DistributedError::new(
					"aggregation contributions are not sorted and unique",
				));
			}

			previous = Some(key);
		}

		Ok(())
	}

	/// Returns counts by receiver trust layer, without inspecting scores.
	#[must_use]
	pub fn disposition_counts(&self) -> BTreeMap<&'static str, usize> {
		let mut counts = BTreeMap::from([
			("receiver_verified_trusted", 0),
			("signed_untrusted", 0),
			("rejected", 0),
			("missing", 0),
		]);

		for contribution in &self.contributions {
			let key = match contribution {
				AggregationContribution::ReceiverVerifiedTrusted { .. } => {
					"receiver_verified_trusted"
				},
				AggregationContribution::SignedUntrusted { .. } => "signed_untrusted",
				AggregationContribution::Rejected { .. } => "rejected",
				AggregationContribution::Missing { .. } => "missing",
			};

			*counts.get_mut(key).expect("all disposition keys are initialized") += 1;
		}

		counts
	}
}

#[derive(Serialize)]
struct UnsignedControlEnvelope<'a, T> {
	schema_version: &'a str,
	payload_type: &'a str,
	signature_domain: &'a str,
	content_hash: &'a str,
	signer: &'a NodeIdentity,
	payload: &'a T,
}

/// Receiver evaluation of a cryptographically valid control message.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReceiverTrust {
	/// The signature is valid and the receiver authorizes the signer.
	ReceiverVerifiedTrusted,
	/// The signature is valid, but the receiver does not authorize the signer.
	SignedUntrusted,
}

/// State of one coordinator-issued lease attempt.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LeaseState {
	/// The node can accept the offered work.
	Offered,
	/// The node accepted the lease.
	Accepted,
	/// The node reports active execution.
	Running,
	/// The node reports completed execution.
	Completed,
	/// The coordinator revoked the lease.
	Revoked,
	/// The lease elapsed without completion.
	Expired,
}

/// Node lifecycle reported in a signed observation.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeLifecycle {
	/// The node accepts work.
	Ready,
	/// The node executes leased work.
	Busy,
	/// The node is degraded and does not accept new work.
	Degraded,
	/// The node is draining active work.
	Draining,
	/// The node reports an orderly offline transition.
	Offline,
}

/// One model contribution with an explicit receiver trust layer.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(tag = "disposition", rename_all = "snake_case")]
pub enum AggregationContribution {
	/// A receiver-authorized signed receipt.
	ReceiverVerifiedTrusted {
		/// Assignment identity.
		assignment_id: String,
		/// Model identity.
		model: ModelConfig,
		/// Producer node.
		node_id: String,
		/// Signed receipt envelope hash.
		receipt_hash: String,
		/// Result-package hash.
		result_package_hash: String,
	},
	/// A valid signature without receiver authorization.
	SignedUntrusted {
		/// Assignment identity.
		assignment_id: String,
		/// Model identity.
		model: ModelConfig,
		/// Producer node.
		node_id: String,
		/// Signed receipt envelope hash.
		receipt_hash: String,
		/// Result-package hash.
		result_package_hash: String,
	},
	/// A contribution rejected before aggregation.
	Rejected {
		/// Assignment identity.
		assignment_id: String,
		/// Model identity.
		model: ModelConfig,
		/// Expected or observed node.
		node_id: String,
		/// Rejection evidence.
		rejection: Rejection,
	},
	/// An expected contribution with no receipt.
	Missing {
		/// Assignment identity.
		assignment_id: String,
		/// Model identity.
		model: ModelConfig,
		/// Expected node.
		node_id: String,
	},
}
impl AggregationContribution {
	fn key(&self) -> (&str, ModelConfig) {
		match self {
			Self::ReceiverVerifiedTrusted { assignment_id, model, .. }
			| Self::SignedUntrusted { assignment_id, model, .. }
			| Self::Rejected { assignment_id, model, .. }
			| Self::Missing { assignment_id, model, .. } => (assignment_id, *model),
		}
	}

	fn validate(&self) -> Result<(), DistributedError> {
		let (assignment_id, _) = self.key();

		validate_prefixed_hash(assignment_id, "assignment_", "assignment identifier")?;

		if !MODEL_MATRIX.contains(&self.key().1) {
			return Err(DistributedError::new("aggregation model is outside the fixed matrix"));
		}

		match self {
			Self::ReceiverVerifiedTrusted {
				node_id, receipt_hash, result_package_hash, ..
			}
			| Self::SignedUntrusted { node_id, receipt_hash, result_package_hash, .. } => {
				validate_node_id(node_id)?;
				validate_hash(receipt_hash, "receipt envelope hash")?;
				validate_hash(result_package_hash, "result-package hash")?;
			},
			Self::Rejected { node_id, rejection, .. } => {
				validate_node_id(node_id)?;
				validate_token(&rejection.reason_code, 64, "rejection reason code")?;

				if let Some(hash) = &rejection.evidence_hash {
					validate_hash(hash, "rejection evidence hash")?;
				}
			},
			Self::Missing { node_id, .. } => validate_node_id(node_id)?,
		}

		Ok(())
	}
}

fn identity_from_key(key: &VerifyingKey) -> NodeIdentity {
	let public_key = hex::encode(key.as_bytes());
	let node_id = format!("node_{}", hex::encode(Sha256::digest(key.as_bytes())));

	NodeIdentity { node_id, public_key }
}

fn validate_node_identity(identity: &NodeIdentity) -> Result<(), DistributedError> {
	validate_node_id(&identity.node_id)?;
	validate_lower_hex(&identity.public_key, 64, "public key")?;

	let bytes = hex::decode(&identity.public_key)
		.map_err(|error| DistributedError::new(format!("invalid public key: {error}")))?;
	let bytes: [u8; 32] =
		bytes.try_into().map_err(|_| DistributedError::new("public key must contain 32 bytes"))?;
	let expected = format!("node_{}", hex::encode(Sha256::digest(bytes)));

	if expected != identity.node_id {
		return Err(DistributedError::new("node identifier does not match the public key"));
	}

	Ok(())
}

fn validate_wire_task(task: &TaskDefinition) -> Result<(), DistributedError> {
	if task.schema_version != TASK_SCHEMA_VERSION {
		return Err(DistributedError::new("unsupported task schema"));
	}

	validate_text(&task.task_id, 128, "task identifier")?;

	if !task::is_task_id(&task.task_id) {
		return Err(DistributedError::new("task identifier is not a canonical task token"));
	}

	validate_text(&task.task_version, MAX_VERSION_BYTES, "task version")?;
	validate_text(&task.title, 512, "task title")?;
	validate_text(&task.prompt, MAX_PROMPT_BYTES, "task prompt")?;
	validate_version(&task.scorer_version, "scorer version")?;

	if task.title.trim().is_empty()
		|| task.prompt.trim().is_empty()
		|| !task::is_semantic_version(&task.task_version)
		|| !task::is_semantic_version(&task.scorer_version)
		|| !matches!(task.difficulty.as_str(), "easy" | "medium" | "hard")
	{
		return Err(DistributedError::new(
			"task identity, version, text, or difficulty is invalid",
		));
	}

	if let Some(wall_seconds) = task.budgets.wall_seconds {
		validate_safe_integer(wall_seconds, "Codex adapter elapsed-time budget")?;
	}
	if let Some(max_steps) = task.budgets.max_steps {
		validate_safe_integer(max_steps.into(), "task step budget")?;
	}
	if let Some(max_tool_calls) = task.budgets.max_tool_calls {
		validate_safe_integer(max_tool_calls.into(), "task tool-call budget")?;
	}

	if task.budgets.wall_seconds == Some(0) || task.budgets.max_steps == Some(0) {
		return Err(DistributedError::new("task budgets must permit execution"));
	}

	bounded_nonempty(&task.allowed_tools, 16, "allowed tools")?;
	validate_unique_text(&task.allowed_tools, 64, "allowed tools")?;

	for tool in &task.allowed_tools {
		if !matches!(
			tool.as_str(),
			"none" | "filesystem_read" | "filesystem_write" | "web_search" | "command_execution"
		) {
			return Err(DistributedError::new("task contains an unsupported tool"));
		}
	}

	if task.allowed_tools.iter().any(|tool| tool == "none") && task.allowed_tools.len() != 1 {
		return Err(DistributedError::new("none must be the only task tool when selected"));
	}
	if task.allowed_tools.iter().any(|tool| tool == "command_execution")
		&& !task
			.allowed_tools
			.iter()
			.any(|tool| matches!(tool.as_str(), "filesystem_read" | "filesystem_write"))
	{
		return Err(DistributedError::new("command execution requires a filesystem scope"));
	}

	bounded_nonempty(&task.tags, 64, "task tags")?;
	validate_unique_text(&task.tags, 128, "task tags")?;

	if task.tags.iter().any(|tag| !task::is_lower_snake_token(tag)) {
		return Err(DistributedError::new("task tag is not a canonical token"));
	}

	bounded_nonempty(&task.leakage_notes, 64, "leakage notes")?;
	validate_unique_text(&task.leakage_notes, 2_048, "leakage notes")?;

	if task.leakage_notes.iter().any(|note| note.trim().is_empty()) {
		return Err(DistributedError::new("task leakage note is blank"));
	}

	bounded_nonempty(&task.fixture_refs, MAX_REFERENCES, "fixture references")?;
	validate_unique_text(&task.fixture_refs, MAX_URI_BYTES, "fixture references")?;

	for reference in &task.fixture_refs {
		validate_text(reference, MAX_URI_BYTES, "fixture reference")?;

		if !task::is_fixture_reference(reference) {
			return Err(DistributedError::new("fixture reference is not a canonical URI"));
		}
	}

	if task.cluster_id.as_ref().is_some_and(|cluster| !task::is_cluster_id(cluster)) {
		return Err(DistributedError::new("task cluster identifier is not canonical"));
	}
	if task.provenance.is_empty() || task.provenance.len() > MAX_REFERENCES {
		return Err(DistributedError::new(
			"task provenance is empty or exceeds its property bound",
		));
	}

	for key in task.provenance.keys() {
		validate_token(key, 128, "task provenance key")?;
	}

	if protocol::canonical_json(&task.provenance).map_err(protocol_error)?.len() > 64 * 1_024 {
		return Err(DistributedError::new("task provenance exceeds its byte bound"));
	}

	validate_wire_evaluator(task)
}

fn validate_wire_evaluator(task: &TaskDefinition) -> Result<(), DistributedError> {
	let evaluator =
		task.evaluator.as_ref().ok_or_else(|| DistributedError::new("task has no evaluator"))?;

	validate_text(&evaluator.kind, 128, "evaluator kind")?;

	if !task::is_lower_snake_token(&evaluator.kind) {
		return Err(DistributedError::new("evaluator kind is not a canonical token"));
	}

	match task.visibility {
		Visibility::PublicExample => {
			if evaluator.kind != "exact_match"
				|| evaluator.expected.as_deref().is_none_or(str::is_empty)
				|| evaluator.external.is_some()
			{
				return Err(DistributedError::new(
					"public task does not use a complete exact-match evaluator",
				));
			}

			validate_text(
				evaluator.expected.as_deref().expect("checked as present"),
				MAX_PROMPT_BYTES,
				"expected response",
			)?;
		},
		Visibility::Hidden => {
			if evaluator.kind == "exact_match"
				|| evaluator.expected.is_some()
				|| evaluator.case_sensitive
			{
				return Err(DistributedError::new(
					"hidden task does not use a controlled external evaluator",
				));
			}

			let binding = evaluator.external.as_ref().ok_or_else(|| {
				DistributedError::new("hidden task has no external evaluator binding")
			})?;

			if binding.protocol_version != EVALUATOR_PROTOCOL_VERSION
				|| binding.scorer_version != task.scorer_version
				|| !task::is_semantic_version(&binding.scorer_version)
			{
				return Err(DistributedError::new(
					"external evaluator version binding is inconsistent",
				));
			}

			let mut components = binding.executable_ref.components();

			if binding.executable_ref.as_os_str().is_empty()
				|| components.any(|component| !matches!(component, Component::Normal(_)))
			{
				return Err(DistributedError::new(
					"external evaluator reference is not a safe relative path",
				));
			}

			validate_hash(&binding.executable_digest, "evaluator executable hash")?;
			validate_hash(&binding.configuration_digest, "evaluator configuration hash")?;

			if protocol::canonical_hash(&binding.configuration).map_err(protocol_error)?
				!= binding.configuration_digest
			{
				return Err(DistributedError::new(
					"evaluator configuration does not match its commitment",
				));
			}

			bounded(&binding.arguments, 64, "evaluator arguments")?;

			for argument in &binding.arguments {
				validate_text(argument, 4_096, "evaluator argument")?;
			}

			validate_safe_integer(binding.timeout_ms, "evaluator timeout")?;
			validate_safe_integer(
				u64::try_from(binding.max_input_bytes)
					.map_err(|_| DistributedError::new("evaluator input bound is too large"))?,
				"evaluator input bound",
			)?;
			validate_safe_integer(
				u64::try_from(binding.max_output_bytes)
					.map_err(|_| DistributedError::new("evaluator output bound is too large"))?,
				"evaluator output bound",
			)?;

			if binding.timeout_ms == 0
				|| binding.timeout_ms > 300_000
				|| binding.max_input_bytes == 0
				|| binding.max_input_bytes > 1_024 * 1_024
				|| binding.max_output_bytes == 0
				|| binding.max_output_bytes > 1_024 * 1_024
				|| protocol::canonical_json(&binding.configuration).map_err(protocol_error)?.len()
					> 64 * 1_024
			{
				return Err(DistributedError::new(
					"external evaluator resource bound is outside its limit",
				));
			}
		},
	}

	Ok(())
}

fn validate_unique_text(
	values: &[String],
	maximum_bytes: usize,
	field: &str,
) -> Result<(), DistributedError> {
	let mut unique = BTreeSet::new();

	for value in values {
		validate_text(value, maximum_bytes, field)?;

		if !unique.insert(value) {
			return Err(DistributedError::new(format!("{field} contains a duplicate")));
		}
	}

	Ok(())
}

fn validate_models(
	models: &[ModelConfig],
	require_full_matrix: bool,
) -> Result<(), DistributedError> {
	bounded_nonempty(models, MAX_MODELS, "models")?;

	let matrix = MODEL_MATRIX.into_iter().collect::<BTreeSet<_>>();
	let observed = models.iter().copied().collect::<BTreeSet<_>>();

	if observed.len() != models.len() {
		return Err(DistributedError::new("models contain a duplicate"));
	}
	if !observed.is_subset(&matrix) {
		return Err(DistributedError::new("model is outside the fixed matrix"));
	}
	if require_full_matrix && (models != MODEL_MATRIX || observed != matrix) {
		return Err(DistributedError::new("run model matrix is not exact or ordered"));
	}

	Ok(())
}

fn validate_sorted_unique_prefixed(
	values: &[String],
	prefix: &str,
	field: &str,
) -> Result<(), DistributedError> {
	let mut previous: Option<&str> = None;

	for value in values {
		validate_prefixed_hash(value, prefix, field)?;

		if previous.is_some_and(|prior| prior >= value.as_str()) {
			return Err(DistributedError::new(format!("{field} must be sorted and unique")));
		}

		previous = Some(value);
	}

	Ok(())
}

fn validate_interval(
	start: u64,
	end: u64,
	maximum_duration: u64,
	field: &str,
) -> Result<(), DistributedError> {
	validate_time(start, field)?;
	validate_time(end, field)?;

	if start >= end || end - start > maximum_duration {
		return Err(DistributedError::new(format!("{field} interval is outside its bound")));
	}

	Ok(())
}

fn validate_time(value: u64, field: &str) -> Result<(), DistributedError> {
	validate_safe_integer(value, field)?;

	if value == 0 {
		return Err(DistributedError::new(format!("{field} must be positive")));
	}

	Ok(())
}

fn validate_safe_integer(value: u64, field: &str) -> Result<(), DistributedError> {
	if value > MAX_SAFE_INTEGER {
		return Err(DistributedError::new(format!(
			"{field} exceeds the interoperable safe-integer range"
		)));
	}

	Ok(())
}

fn validate_hash(value: &str, field: &str) -> Result<(), DistributedError> {
	if value.strip_prefix("sha256:").is_some_and(|digest| is_lower_hex(digest, 64)) {
		Ok(())
	} else {
		Err(DistributedError::new(format!(
			"{field} must be sha256 followed by 64 lowercase hexadecimal characters"
		)))
	}
}

fn validate_node_id(value: &str) -> Result<(), DistributedError> {
	validate_prefixed_hash(value, "node_", "node identifier")
}

fn validate_prefixed_hash(value: &str, prefix: &str, field: &str) -> Result<(), DistributedError> {
	if value.strip_prefix(prefix).is_some_and(|digest| is_lower_hex(digest, 64)) {
		Ok(())
	} else {
		Err(DistributedError::new(format!(
			"{field} must use the required prefix and 64 lowercase hexadecimal characters"
		)))
	}
}

fn validate_lower_hex(value: &str, digits: usize, field: &str) -> Result<(), DistributedError> {
	if is_lower_hex(value, digits) {
		Ok(())
	} else {
		Err(DistributedError::new(format!(
			"{field} must contain {digits} lowercase hexadecimal characters"
		)))
	}
}

fn validate_version(value: &str, field: &str) -> Result<(), DistributedError> {
	validate_text(value, MAX_VERSION_BYTES, field)?;

	if value.bytes().any(|byte| byte.is_ascii_control() || byte.is_ascii_whitespace()) {
		return Err(DistributedError::new(format!("{field} contains unsafe characters")));
	}

	Ok(())
}

fn validate_token(value: &str, maximum: usize, field: &str) -> Result<(), DistributedError> {
	validate_text(value, maximum, field)?;

	if !value
		.bytes()
		.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b'@'))
	{
		return Err(DistributedError::new(format!("{field} contains unsafe characters")));
	}

	Ok(())
}

fn validate_text(value: &str, maximum: usize, field: &str) -> Result<(), DistributedError> {
	if value.is_empty()
		|| value.len() > maximum
		|| value.chars().any(|character| {
			character == '\0'
				|| (character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
		}) {
		return Err(DistributedError::new(format!("{field} is empty, unsafe, or too long")));
	}

	Ok(())
}

fn bounded<T>(values: &[T], maximum: usize, field: &str) -> Result<(), DistributedError> {
	if values.len() > maximum {
		return Err(DistributedError::new(format!("{field} exceeds its item bound")));
	}

	Ok(())
}

fn bounded_nonempty<T>(values: &[T], maximum: usize, field: &str) -> Result<(), DistributedError> {
	if values.is_empty() || values.len() > maximum {
		return Err(DistributedError::new(format!("{field} is empty or exceeds its item bound")));
	}

	Ok(())
}

fn prefixed_hash<T>(prefix: &str, value: &T) -> Result<String, DistributedError>
where
	T: Serialize,
{
	let hash = protocol::canonical_hash(value).map_err(protocol_error)?;

	Ok(format!("{prefix}{}", hash.trim_start_matches("sha256:")))
}

fn is_lower_hex(value: &str, digits: usize) -> bool {
	value.len() == digits
		&& value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn protocol_error(error: impl Display) -> DistributedError {
	DistributedError::new(error.to_string())
}

#[cfg(test)]
mod tests {
	use serde_json::{self, Value};

	use crate::{
		ModelConfig,
		distributed::{
			self, ASSIGNMENT_TYPE, AggregationContribution, AggregationInput, BTreeMap, BTreeSet,
			CAPABILITY_TYPE, CapabilityStatus, CommittedTask, ContentReference,
			CoordinatorTaskPackage, Lease, LeaseState, MAX_SAFE_INTEGER, MAX_SUBMISSION_BYTES,
			MODEL_MATRIX, ModelCapability, NodeCapabilityDeclaration, NodeIdentity, NodeLifecycle,
			NodeObservation, OBSERVATION_DOMAIN, OBSERVATION_TYPE, RECEIPT_TYPE, ReceiverPolicy,
			ReceiverTrust, Rejection, ResultPackageReceipt, RunIdentity, SignedControlEnvelope,
			SigningKey, TASK_PACKAGE_TYPE, TaskAssignment, TaskDefinition,
		},
		model::{ModelFamily, ReasoningEffort},
		protocol,
		scoring::AIQ_SCORING_VERSION,
		task::{Domain, Evaluator, TASK_SCHEMA_VERSION, TaskBudgets, Visibility},
	};

	const COORDINATOR_SECRET: [u8; 32] = [11; 32];
	const NODE_SECRET: [u8; 32] = [12; 32];
	const RECEIVER_SECRET: [u8; 32] = [13; 32];
	const NOW: u64 = 1_800_000_100;

	fn identity(secret: [u8; 32]) -> NodeIdentity {
		distributed::identity_from_key(&SigningKey::from_bytes(&secret).verifying_key())
	}

	fn hash(byte: char) -> String {
		format!("sha256:{}", byte.to_string().repeat(64))
	}

	fn task() -> TaskDefinition {
		TaskDefinition {
			schema_version: TASK_SCHEMA_VERSION.to_owned(),
			task_id: "coding-01".to_owned(),
			task_version: "1.0.0".to_owned(),
			title: "Return the fixture token".to_owned(),
			domain: Domain::Coding,
			difficulty: "easy".to_owned(),
			prompt: "Return alpha.".to_owned(),
			allowed_tools: vec!["none".to_owned()],
			budgets: TaskBudgets {
				wall_seconds: Some(30),
				max_steps: Some(4),
				max_tool_calls: Some(0),
			},
			tags: vec!["fixture".to_owned()],
			cluster_id: None,
			catalog_entry_digest: None,
			scorer_version: "1.0.0".to_owned(),
			leakage_notes: vec!["synthetic".to_owned()],
			fixture_refs: vec!["repo://fixture/input.json".to_owned()],
			visibility: Visibility::PublicExample,
			provenance: BTreeMap::<String, Value>::from([(
				"source".to_owned(),
				serde_json::json!("synthetic"),
			)]),
			evaluator: Some(Evaluator {
				kind: "exact_match".to_owned(),
				expected: Some("alpha".to_owned()),
				case_sensitive: true,
				external: None,
			}),
		}
	}

	fn capability() -> SignedControlEnvelope<NodeCapabilityDeclaration> {
		let node = identity(NODE_SECRET);

		SignedControlEnvelope::sign(
			NODE_SECRET,
			NodeCapabilityDeclaration {
				schema_version: CAPABILITY_TYPE.to_owned(),
				node_id: node.node_id,
				observed_at: 1_800_000_000,
				expires_at: 1_800_003_600,
				runner_version: "1.0.0".to_owned(),
				codex_version: "codex-1.0.0".to_owned(),
				models: MODEL_MATRIX
					.into_iter()
					.map(|model| ModelCapability {
						model,
						status: CapabilityStatus::Available,
						reason: None,
					})
					.collect(),
			},
		)
		.expect("capability must sign")
	}

	fn package() -> SignedControlEnvelope<CoordinatorTaskPackage> {
		let coordinator = identity(COORDINATOR_SECRET);
		let mut payload = CoordinatorTaskPackage {
			schema_version: TASK_PACKAGE_TYPE.to_owned(),
			package_id: String::new(),
			coordinator_id: coordinator.node_id,
			corpus_release_id: "corpus_1.0.0".to_owned(),
			task_set_hash: String::new(),
			valid_from: 1_800_000_000,
			expires_at: 1_800_010_000,
			tasks: vec![CommittedTask::from_task(task()).expect("task must commit")],
		};

		payload.finalize().expect("package must finalize");

		SignedControlEnvelope::sign(COORDINATOR_SECRET, payload).expect("package must sign")
	}

	fn assignment(
		package_hash: &str,
		capability_hash: &str,
	) -> SignedControlEnvelope<TaskAssignment> {
		let coordinator = identity(COORDINATOR_SECRET);
		let node = identity(NODE_SECRET);
		let models = MODEL_MATRIX.to_vec();
		let run = RunIdentity {
			schedule_id: format!("schedule_{}", "a".repeat(64)),
			schedule_slot_hash: hash('b'),
			task_package_hash: package_hash.to_owned(),
			models,
			scoring_version: AIQ_SCORING_VERSION.to_owned(),
		};
		let mut payload = TaskAssignment {
			schema_version: ASSIGNMENT_TYPE.to_owned(),
			assignment_id: String::new(),
			coordinator_id: coordinator.node_id,
			run_id: String::new(),
			run,
			task_package_hash: package_hash.to_owned(),
			models: vec![MODEL_MATRIX[0]],
			target_node_id: node.node_id,
			target_capability_hash: capability_hash.to_owned(),
			lease: Lease {
				lease_id: String::new(),
				attempt: 1,
				state: LeaseState::Offered,
				issued_at: 1_800_000_050,
				not_before: 1_800_000_050,
				expires_at: 1_800_000_300,
			},
		};

		payload.finalize().expect("assignment must finalize");

		SignedControlEnvelope::sign(COORDINATOR_SECRET, payload).expect("assignment must sign")
	}

	#[test]
	fn golden_round_trip_and_context_verification_succeeds() {
		let package = package();
		let capability = capability();
		let signed_assignment = assignment(&package.content_hash, &capability.content_hash);
		let bytes = protocol::canonical_json(&signed_assignment).expect("envelope must serialize");
		let decoded: SignedControlEnvelope<TaskAssignment> =
			serde_json::from_slice(&bytes).expect("envelope must deserialize");

		assert_eq!(decoded, signed_assignment);

		let coordinator = identity(COORDINATOR_SECRET);
		let node = identity(NODE_SECRET);
		let policy = ReceiverPolicy {
			trusted_signers: BTreeSet::from([coordinator.node_id.clone(), node.node_id.clone()]),
		};
		let verified_package = package.verify(&policy).expect("package must verify");
		let verified_capability = capability.verify(&policy).expect("capability must verify");
		let verified_assignment = signed_assignment
			.verify_for_node(&policy, NOW, &node.node_id, &verified_package, &verified_capability)
			.expect("assignment must verify");

		assert_eq!(verified_assignment.receiver_trust, ReceiverTrust::ReceiverVerifiedTrusted);
	}

	#[test]
	fn content_signature_and_idempotency_tampering_fail() {
		let package = package();
		let capability = capability();
		let mut content = assignment(&package.content_hash, &capability.content_hash);

		content.payload.models = vec![MODEL_MATRIX[1]];

		assert!(content.verify(&ReceiverPolicy::default()).is_err());

		let mut signature = assignment(&package.content_hash, &capability.content_hash);

		signature.signature.replace_range(0..2, "00");

		assert!(signature.verify(&ReceiverPolicy::default()).is_err());

		let original = assignment(&package.content_hash, &capability.content_hash);
		let mut idempotency = original.payload.clone();

		idempotency.run_id = format!("run_{}", "c".repeat(64));

		assert!(SignedControlEnvelope::sign(COORDINATOR_SECRET, idempotency).is_err());
	}

	#[test]
	fn signature_domains_prevent_cross_purpose_replay() {
		let capability = capability();
		let bytes = serde_json::to_vec(&capability).expect("serialize");
		let replay: SignedControlEnvelope<NodeCapabilityDeclaration> =
			serde_json::from_slice(&bytes).expect("deserialize");
		let mut replay = replay;

		replay.signature_domain = OBSERVATION_DOMAIN.to_owned();

		assert!(replay.verify(&ReceiverPolicy::default()).is_err());
	}

	#[test]
	fn duplicate_tasks_and_models_are_rejected() {
		let mut duplicate_tasks = package().payload;

		duplicate_tasks.tasks.push(duplicate_tasks.tasks[0].clone());
		duplicate_tasks.finalize().expect("hash duplicate package");

		assert!(SignedControlEnvelope::sign(COORDINATOR_SECRET, duplicate_tasks).is_err());

		let package = package();
		let capability = capability();
		let mut duplicate_models =
			assignment(&package.content_hash, &capability.content_hash).payload;

		duplicate_models.models.push(duplicate_models.models[0]);
		duplicate_models.finalize().expect("finalize duplicate assignment");

		assert!(SignedControlEnvelope::sign(COORDINATOR_SECRET, duplicate_models).is_err());
	}

	#[test]
	fn expired_wrong_node_and_stale_capability_bindings_fail() {
		let package = package();
		let capability = capability();
		let signed_assignment = assignment(&package.content_hash, &capability.content_hash);
		let policy = ReceiverPolicy::default();
		let verified_package = package.verify(&policy).expect("package");
		let verified_capability = capability.verify(&policy).expect("capability");

		assert!(
			signed_assignment
				.verify_for_node(
					&policy,
					1_800_000_301,
					&verified_capability.payload.node_id,
					&verified_package,
					&verified_capability,
				)
				.is_err()
		);
		assert!(
			signed_assignment
				.verify_for_node(
					&policy,
					NOW,
					&identity(RECEIVER_SECRET).node_id,
					&verified_package,
					&verified_capability,
				)
				.is_err()
		);

		let mut stale_payload = verified_capability.payload.clone();

		stale_payload.expires_at = 1_800_000_200;

		let stale =
			SignedControlEnvelope::sign(NODE_SECRET, stale_payload).expect("stale claim signs");
		let stale = stale.verify(&policy).expect("stale claim verifies cryptographically");
		let rebound = assignment(&verified_package.content_hash, &stale.content_hash);

		assert!(
			rebound
				.verify_for_node(&policy, NOW, &stale.payload.node_id, &verified_package, &stale,)
				.is_err()
		);
	}

	#[test]
	fn receiver_policy_can_downgrade_valid_signatures() {
		let capability = capability();
		let untrusted = capability.verify(&ReceiverPolicy::default()).expect("signature");

		assert_eq!(untrusted.receiver_trust, ReceiverTrust::SignedUntrusted);

		let trusted = capability
			.verify(&ReceiverPolicy {
				trusted_signers: BTreeSet::from([capability.signer.node_id.clone()]),
			})
			.expect("signature");

		assert_eq!(trusted.receiver_trust, ReceiverTrust::ReceiverVerifiedTrusted);
	}

	#[test]
	fn bounds_safe_integers_and_unknown_fields_fail_closed() {
		let capability = capability();
		let mut unsafe_integer = capability.payload.clone();

		unsafe_integer.expires_at = MAX_SAFE_INTEGER + 1;

		assert!(SignedControlEnvelope::sign(NODE_SECRET, unsafe_integer).is_err());

		let mut too_many = capability.payload;

		too_many.models.push(ModelCapability {
			model: MODEL_MATRIX[0],
			status: CapabilityStatus::Available,
			reason: None,
		});

		assert!(SignedControlEnvelope::sign(NODE_SECRET, too_many).is_err());

		let bytes = serde_json::to_value(package()).expect("serialize");
		let mut object = bytes.as_object().expect("object").clone();

		object.insert("unexpected".to_owned(), serde_json::json!(true));

		assert!(
			serde_json::from_value::<SignedControlEnvelope<CoordinatorTaskPackage>>(Value::Object(
				object
			))
			.is_err()
		);
	}

	#[test]
	fn lifecycle_chain_and_receipt_provenance_are_signed_and_bounded() {
		let node = identity(NODE_SECRET);
		let capability = capability();
		let verified_capability =
			capability.verify(&ReceiverPolicy::default()).expect("capability verifies");
		let mut observation = NodeObservation {
			schema_version: OBSERVATION_TYPE.to_owned(),
			observation_id: String::new(),
			node_id: node.node_id.clone(),
			sequence: 1,
			observed_at: NOW,
			valid_until: NOW + 60,
			lifecycle: NodeLifecycle::Ready,
			capability_hash: capability.content_hash.clone(),
			active_assignment_ids: vec![],
			previous_observation_hash: None,
		};

		observation.finalize().expect("observation");

		SignedControlEnvelope::sign(NODE_SECRET, observation)
			.expect("observation signs")
			.verify_at(&ReceiverPolicy::default(), NOW, &verified_capability)
			.expect("live observation verifies");

		let receiver = identity(RECEIVER_SECRET);
		let package = package();
		let verified_package =
			package.verify(&ReceiverPolicy::default()).expect("package verifies");
		let signed_assignment = assignment(&package.content_hash, &capability.content_hash);
		let verified_assignment = signed_assignment
			.verify_for_node(
				&ReceiverPolicy::default(),
				NOW,
				&node.node_id,
				&verified_package,
				&verified_capability,
			)
			.expect("assignment verifies");
		let mut receipt = ResultPackageReceipt {
			schema_version: RECEIPT_TYPE.to_owned(),
			receipt_id: String::new(),
			receiver_id: receiver.node_id,
			producer_node_id: node.node_id,
			assignment_id: signed_assignment.payload.assignment_id,
			run_id: signed_assignment.payload.run_id,
			attempt: 1,
			capability_hash: signed_assignment.payload.target_capability_hash,
			result_package: ContentReference {
				kind: "result_package".to_owned(),
				content_hash: hash('d'),
				uri: "urn:sha256:result".to_owned(),
				bytes: 1_024,
			},
			provenance: vec![ContentReference {
				kind: "workspace_manifest".to_owned(),
				content_hash: hash('e'),
				uri: "urn:sha256:workspace".to_owned(),
				bytes: 512,
			}],
			completed_at: NOW,
			received_at: NOW + 1,
		};

		receipt.finalize().expect("receipt");

		let mut maximum = receipt.clone();

		maximum.result_package.bytes =
			u64::try_from(MAX_SUBMISSION_BYTES).expect("submission limit fits u64");

		SignedControlEnvelope::sign(RECEIVER_SECRET, maximum)
			.expect("receipt accepts the exact submission limit");

		let mut oversized = receipt.clone();

		oversized.result_package.bytes =
			u64::try_from(MAX_SUBMISSION_BYTES + 1).expect("submission limit fits u64");

		assert!(SignedControlEnvelope::sign(RECEIVER_SECRET, oversized).is_err());

		SignedControlEnvelope::sign(RECEIVER_SECRET, receipt)
			.expect("receipt signs")
			.verify_for_assignment(&ReceiverPolicy::default(), &verified_assignment)
			.expect("receipt provenance verifies");
	}

	#[test]
	fn aggregation_preserves_all_four_trust_layers_without_scores() {
		let assignment_a = format!("assignment_{}", "1".repeat(64));
		let assignment_b = format!("assignment_{}", "2".repeat(64));
		let assignment_c = format!("assignment_{}", "3".repeat(64));
		let assignment_d = format!("assignment_{}", "4".repeat(64));
		let node = identity(NODE_SECRET).node_id;
		let input = AggregationInput::new(
			format!("run_{}", "5".repeat(64)),
			vec![
				AggregationContribution::Missing {
					assignment_id: assignment_d,
					model: MODEL_MATRIX[3],
					node_id: node.clone(),
				},
				AggregationContribution::ReceiverVerifiedTrusted {
					assignment_id: assignment_a,
					model: MODEL_MATRIX[0],
					node_id: node.clone(),
					receipt_hash: hash('6'),
					result_package_hash: hash('7'),
				},
				AggregationContribution::Rejected {
					assignment_id: assignment_c,
					model: MODEL_MATRIX[2],
					node_id: node.clone(),
					rejection: Rejection {
						reason_code: "signature_invalid".to_owned(),
						evidence_hash: Some(hash('8')),
					},
				},
				AggregationContribution::SignedUntrusted {
					assignment_id: assignment_b,
					model: MODEL_MATRIX[1],
					node_id: node,
					receipt_hash: hash('9'),
					result_package_hash: hash('a'),
				},
			],
		)
		.expect("aggregation input");

		assert_eq!(
			input.disposition_counts(),
			BTreeMap::from([
				("missing", 1),
				("receiver_verified_trusted", 1),
				("rejected", 1),
				("signed_untrusted", 1),
			])
		);
		assert!(serde_json::to_string(&input).expect("serialize").find("score").is_none());

		let mut duplicate = input.contributions.clone();

		duplicate.push(duplicate[0].clone());

		assert!(AggregationInput::new(input.run_id, duplicate).is_err());
	}

	#[test]
	fn luna_ultra_is_rejected_as_outside_the_matrix() {
		let package = package();
		let capability = capability();
		let mut payload = assignment(&package.content_hash, &capability.content_hash).payload;

		payload.models = vec![ModelConfig {
			family: ModelFamily::Luna,
			reasoning_effort: ReasoningEffort::Ultra,
		}];

		payload.finalize().expect("identity still hashes");

		assert!(SignedControlEnvelope::sign(COORDINATOR_SECRET, payload).is_err());
	}

	#[test]
	fn wire_tasks_bind_command_execution_to_a_filesystem_scope() {
		let mut candidate = task();

		candidate.allowed_tools = vec!["command_execution".to_owned()];

		assert_eq!(
			super::validate_wire_task(&candidate)
				.expect_err("command-only policy must fail")
				.message,
			"command execution requires a filesystem scope",
		);

		candidate.allowed_tools =
			vec!["filesystem_write".to_owned(), "command_execution".to_owned()];

		super::validate_wire_task(&candidate).expect("scoped command execution must validate");
	}
}
