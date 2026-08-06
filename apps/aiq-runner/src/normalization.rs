//! Versioned normalization of one signed matrix batch into per-model records.

use std::{
	collections::{BTreeMap, BTreeSet},
	error::Error,
	fmt::{Display, Formatter},
};

use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::calibration_verification;
use crate::calibration_verification::ApiEquivalentPricingModel;
use crate::calibration_verification::CalibrationEfficiencyAggregate;
use crate::calibration_verification::CalibrationResultEfficiency;
use crate::runner::MAX_RUN_JOBS;
use crate::{
	adapter::ArtifactReference,
	corpus_commitment::{self, RunClass, RunProvenanceCommitment},
	model::{MODEL_MATRIX, ModelConfig, ModelFamily, ReasoningEffort},
	protocol::{self, NodeIdentity, ResultProvenance},
	run_validation,
	runner::{
		EvaluationOutcome, FailureKind, Latency, ResultFailure, ResultStatus, RunRecord,
		TaskResult, ToolUsage,
	},
	scoring::{
		self, AIQ_BENCHMARK_VERSION, AIQ_TASK_SET_ID, AIQ_TASK_SET_VERSION, ScoreContext,
		ScoreOptions, ScoreReport, ScoreTier,
	},
	submission,
	task::{Domain, TaskDefinition},
};

/// Normalized batch schema.
pub const NORMALIZATION_SCHEMA_VERSION: &str = "aiq.normalized-batch.v3";
/// Normalized child-run schema.
pub const NORMALIZED_MODEL_RUN_SCHEMA_VERSION: &str = "aiq.normalized-model-run.v1";
/// Normalized result schema.
pub const NORMALIZED_RESULT_SCHEMA_VERSION: &str = "aiq.normalized-result.v1";
/// Verifier attestation schema.
pub const VERIFIER_ATTESTATION_SCHEMA_VERSION: &str = "aiq.verifier-attestation.v3";
/// Signature algorithm used by verifier attestations.
pub const VERIFIER_SIGNATURE_ALGORITHM: &str = "ed25519";
/// Signature framing and serialization version.
pub const VERIFIER_SIGNATURE_VERSION: &str = "aiq.ed25519-jcs.v1";
/// Exact number of model configurations in one matrix batch.
pub const NORMALIZED_MODEL_COUNT: usize = 17;
/// Exact number of tasks in one model run.
pub const NORMALIZED_TASK_COUNT: usize = 72;
/// Largest serialized verifier request accepted by the verification gateway.
pub const MAX_VERIFICATION_REQUEST_BYTES: usize = 4 * 1_024 * 1_024;
/// Bytes reserved for request framing and the signed verifier attestation.
pub const VERIFICATION_REQUEST_RESERVE_BYTES: usize = 16 * 1_024;
/// Largest canonical normalized stage after verifier-request overhead.
pub const MAX_NORMALIZED_STAGE_BYTES: usize =
	MAX_VERIFICATION_REQUEST_BYTES - VERIFICATION_REQUEST_RESERVE_BYTES;

const MAX_JCS_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// Normalization or attestation validation failed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NormalizationError {
	message: String,
}
impl NormalizationError {
	fn new(message: impl Into<String>) -> Self {
		Self { message: message.into() }
	}
}

impl Error for NormalizationError {}

impl Display for NormalizationError {
	fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
		formatter.write_str(&self.message)
	}
}

/// Immutable package identity established before normalization.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VerifiedPackageIdentity {
	/// SHA-256 of the complete submitted package, without a prefix.
	pub package_sha256: String,
	/// Signed payload content address.
	pub content_hash: String,
	/// Identity that signed the source package.
	pub signer: NodeIdentity,
}

/// Deployment metadata attested by the verifier but absent from `RunRecord`.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AttestedDeploymentMetadata {
	/// Stable task-set identifier.
	pub task_set_id: String,
	/// Semantic task-set version.
	pub task_set_version: String,
	/// Benchmark version. It must be `<task_set_id>@<task_set_version>`.
	pub benchmark_version: String,
	/// Content address of the exact prompts.
	pub prompt_set_digest: String,
	/// Git commit of the runner.
	pub runner_commit: String,
	/// Deployment region.
	pub region: String,
	/// Scheduled Unix time in milliseconds.
	pub scheduled_unix_ms: u64,
	/// Attested execution start in Unix milliseconds.
	pub started_unix_ms: u64,
	/// Attested execution end in Unix milliseconds.
	pub finished_unix_ms: u64,
	/// Whether the destination is an isolated synthetic-test environment.
	pub synthetic_test: bool,
}

/// One source result with an explicit database disposition.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct NormalizedTaskResult {
	/// Normalized result schema.
	pub schema_version: String,
	/// Signed source result identifier.
	pub source_result_id: String,
	/// Signed matrix-batch identifier.
	pub matrix_batch_id: String,
	/// Derived child run identifier.
	pub run_id: String,
	/// Stable task identifier.
	pub task_id: String,
	/// Task version.
	pub task_version: String,
	/// Content address of the task definition.
	pub task_hash: String,
	/// Task domain from the immutable task source.
	pub domain: Domain,
	/// Scorer version from the immutable task source.
	pub scorer_version: String,
	/// Exact source model configuration.
	pub model: ModelConfig,
	/// Exact source status.
	pub source_status: ResultStatus,
	/// Exact source evaluator outcome.
	pub source_evaluation: EvaluationOutcome,
	/// Explicit database-compatible outcome.
	pub outcome: NormalizedOutcome,
	/// Exact measured task score.
	pub task_score: Option<f64>,
	/// Failure responsibility, if any.
	pub failure_responsibility: Option<FailureResponsibility>,
	/// Exact source failure.
	pub failure: Option<ResultFailure>,
	/// Bounded source response preview.
	pub response: Option<String>,
	/// Complete-response digest.
	pub response_sha256: Option<String>,
	/// Exact checked external evaluator stdout digest.
	pub evaluator_stdout_sha256: Option<String>,
	/// Source artifact references.
	pub artifacts: Vec<ArtifactReference>,
	/// Measured Codex adapter elapsed time.
	pub latency: Latency,
	/// Measured tool usage.
	pub tool_usage: ToolUsage,
	/// Signed result provenance.
	pub provenance: ResultProvenance,
}

/// One deterministic child model run.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct NormalizedModelRun {
	/// Child-run schema.
	pub schema_version: String,
	/// Derived child identifier.
	pub run_id: String,
	/// Signed matrix-batch identifier.
	pub matrix_batch_id: String,
	/// Stable database model-configuration identifier.
	pub model_config_id: String,
	/// Exact model configuration.
	pub model: ModelConfig,
	/// Revalidated score report.
	pub score: ScoreReport,
	/// Exactly 72 normalized task results.
	pub results: Vec<NormalizedTaskResult>,
}

/// Complete normalized stage record. The digest commits to all other fields.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct NormalizedBatchStage {
	/// Stage schema.
	pub schema_version: String,
	/// Signed matrix-batch identifier.
	pub matrix_batch_id: String,
	/// Immutable submitted-package digest.
	pub package_sha256: String,
	/// Immutable signed-content address.
	pub content_hash: String,
	/// Source package signer.
	pub signer: NodeIdentity,
	/// Task-set identifier.
	pub task_set_id: String,
	/// Task-set version.
	pub task_set_version: String,
	/// Signed task-set content address.
	pub task_set_hash: String,
	/// Signed capability-validation content address, when a production preflight exists.
	pub capability_validation_digest: Option<String>,
	/// Signed committed corpus and method identities, absent only for synthetic data.
	pub provenance: Option<RunProvenanceCommitment>,
	/// Explicit signed execution class, absent only for synthetic test data.
	pub run_class: Option<RunClass>,
	/// Benchmark version.
	pub benchmark_version: String,
	/// Prompt-set content address.
	pub prompt_set_digest: String,
	/// Scoring implementation version.
	pub scoring_version: String,
	/// Runner commit.
	pub runner_commit: String,
	/// Deployment region.
	pub region: String,
	/// Scheduled Unix milliseconds.
	pub scheduled_unix_ms: u64,
	/// Start Unix milliseconds.
	pub started_unix_ms: u64,
	/// Finish Unix milliseconds.
	pub finished_unix_ms: u64,
	/// Source and destination synthetic policy.
	pub synthetic: bool,
	/// Exactly 17 deterministic child runs.
	pub runs: Vec<NormalizedModelRun>,
	/// Exact bounded concurrency used by the source run.
	pub execution_concurrency: usize,
	/// Verifier-recomputed per-task time, token, and API-equivalent cost evidence.
	pub result_efficiency: Vec<CalibrationResultEfficiency>,
	/// Per-model efficiency aggregates, separate from scores.
	pub efficiency: Vec<CalibrationEfficiencyAggregate>,
	/// Explicit fixed-point comparison-rate method.
	pub pricing: ApiEquivalentPricingModel,
	/// RFC 8785 SHA-256 commitment to this record with this field excluded.
	pub normalization_digest: String,
}
impl NormalizedBatchStage {
	/// Recomputes the normalization commitment.
	pub fn compute_normalization_digest(&self) -> Result<String, NormalizationError> {
		protocol::canonical_hash(&UnsignedNormalizedStage::from(self))
			.map_err(|error| NormalizationError::new(error.to_string()))
	}

	/// Checks cardinality, deterministic identities, and the normalization commitment.
	pub fn verify(&self) -> Result<(), NormalizationError> {
		if self.schema_version != NORMALIZATION_SCHEMA_VERSION
			|| self.runs.len() != NORMALIZED_MODEL_COUNT
			|| !(1..=MAX_RUN_JOBS).contains(&self.execution_concurrency)
			|| self.result_efficiency.len() != NORMALIZED_MODEL_COUNT * NORMALIZED_TASK_COUNT
			|| self.efficiency.len() != NORMALIZED_MODEL_COUNT
		{
			return Err(NormalizationError::new("invalid normalized batch schema or cardinality"));
		}

		validate_hash("package_sha256", &self.package_sha256, false)?;
		validate_hash("content_hash", &self.content_hash, true)?;
		validate_hash("task_set_hash", &self.task_set_hash, true)?;
		validate_hash("prompt_set_digest", &self.prompt_set_digest, true)?;

		match (
			self.synthetic,
			self.capability_validation_digest.as_deref(),
			self.provenance.as_ref(),
			self.run_class,
		) {
			(true, None, None, None) => {},
			(false, Some(preflight_digest), Some(provenance), Some(RunClass::Official)) => {
				corpus_commitment::validate_run_provenance(
					provenance,
					&self.task_set_hash,
					preflight_digest,
				)
				.map_err(|error| NormalizationError::new(error.to_string()))?;

				if provenance.run_class != RunClass::Official
					|| provenance.prompt_digest != self.prompt_set_digest
				{
					return Err(NormalizationError::new(
						"normalized provenance differs from stage commitments",
					));
				}
			},
			_ => {
				return Err(NormalizationError::new(
					"normalized capability and provenance policy is invalid",
				));
			},
		}

		validate_node(&self.signer)?;
		validate_safe_times(self.scheduled_unix_ms, self.started_unix_ms, self.finished_unix_ms)?;

		self.verify_children_and_efficiency()?;

		if self.compute_normalization_digest()? != self.normalization_digest {
			return Err(NormalizationError::new("normalization digest does not match"));
		}

		let bytes = protocol::canonical_json(self)
			.map_err(|error| NormalizationError::new(error.to_string()))?;

		if bytes.len() > MAX_NORMALIZED_STAGE_BYTES {
			return Err(NormalizationError::new("normalized stage exceeds the byte bound"));
		}

		Ok(())
	}

	fn verify_children_and_efficiency(&self) -> Result<(), NormalizationError> {
		let expected_task_keys = self.runs[0]
			.results
			.iter()
			.map(|result| (&result.task_id, &result.task_version))
			.collect::<BTreeSet<_>>();
		let mut ids = BTreeSet::new();

		for (expected_model, child) in MODEL_MATRIX.iter().zip(&self.runs) {
			let config_id = model_config_id(*expected_model)?;
			let task_keys = child
				.results
				.iter()
				.map(|result| (&result.task_id, &result.task_version))
				.collect::<BTreeSet<_>>();

			if child.schema_version != NORMALIZED_MODEL_RUN_SCHEMA_VERSION
				|| child.matrix_batch_id != self.matrix_batch_id
				|| child.model != *expected_model
				|| child.model_config_id != config_id
				|| child.run_id != child_run_id(&self.matrix_batch_id, &config_id)
				|| child.results.len() != NORMALIZED_TASK_COUNT
				|| task_keys.len() != NORMALIZED_TASK_COUNT
				|| task_keys != expected_task_keys
				|| child.score.model != *expected_model
				|| child.score.schema_version != "aiq.score-report.v2"
				|| child.score.scoring_version != self.scoring_version
				|| child.score.coverage.expected_tasks != NORMALIZED_TASK_COUNT
				|| !ids.insert(child.run_id.clone())
			{
				return Err(NormalizationError::new("invalid normalized child identity"));
			}

			validate_finite_numbers(&child.score)?;

			for result in &child.results {
				if result.schema_version != NORMALIZED_RESULT_SCHEMA_VERSION
					|| result.matrix_batch_id != self.matrix_batch_id
					|| result.run_id != child.run_id
					|| result.model != child.model
					|| (!self.synthetic && result.provenance.node_id != self.signer.node_id)
					|| result.task_score.is_some_and(|score| !score.is_finite())
					|| result.artifacts.iter().any(|artifact| {
						!run_validation::valid_normalized_artifact_reference(artifact)
					}) {
					return Err(NormalizationError::new("invalid normalized result binding"));
				}
			}
		}

		let task_ids =
			self.runs[0].results.iter().map(|result| result.task_id.clone()).collect::<Vec<_>>();

		calibration_verification::validate_efficiency_evidence_contract(
			&MODEL_MATRIX,
			&task_ids,
			&self.result_efficiency,
			&self.efficiency,
			&self.pricing,
		)
		.map_err(|error| NormalizationError::new(error.to_string()))?;

		let normalized_sources = self
			.runs
			.iter()
			.flat_map(|run| &run.results)
			.map(|result| (result.source_result_id.as_str(), result.task_id.as_str(), result.model))
			.collect::<BTreeSet<_>>();
		let efficiency_sources = self
			.result_efficiency
			.iter()
			.map(|result| (result.source_result_id.as_str(), result.task_id.as_str(), result.model))
			.collect::<BTreeSet<_>>();

		if normalized_sources.len() != NORMALIZED_MODEL_COUNT * NORMALIZED_TASK_COUNT
			|| normalized_sources != efficiency_sources
		{
			return Err(NormalizationError::new(
				"normalized efficiency evidence does not bind the exact source result matrix",
			));
		}

		for source in self.runs.iter().flat_map(|run| &run.results) {
			let evidence = self
				.result_efficiency
				.iter()
				.find(|evidence| evidence.source_result_id == source.source_result_id)
				.ok_or_else(|| {
					NormalizationError::new("source result lacks efficiency evidence")
				})?;
			let adapter_invoked = !self.synthetic
				&& !matches!(
					source.failure.as_ref().map(|failure| failure.kind),
					Some(
						FailureKind::CapabilityUnavailable
							| FailureKind::CapabilityValidationFailed
							| FailureKind::WorkspaceUnavailable
					)
				);
			let expected_wall_ms = adapter_invoked.then_some(source.latency.wall_ms);

			if evidence.observed_wall_ms != expected_wall_ms {
				return Err(NormalizationError::new(
					"normalized wall-time evidence does not match the source result",
				));
			}
		}

		Ok(())
	}
}

/// Signed verifier attestation over a normalized stage.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VerifierAttestationV2 {
	/// Attestation schema.
	pub schema_version: String,
	/// Signature algorithm.
	pub signature_algorithm: String,
	/// Signature framing version.
	pub signature_version: String,
	/// Signed matrix-batch identifier.
	pub matrix_batch_id: String,
	/// Submitted-package digest.
	pub package_sha256: String,
	/// Signed-content address.
	pub content_hash: String,
	/// Normalization commitment.
	pub normalization_digest: String,
	/// Task-set content address.
	pub task_set_hash: String,
	/// Capability-validation content address, when present.
	pub capability_validation_digest: Option<String>,
	/// Signed committed corpus and method identities, when present.
	pub provenance: Option<RunProvenanceCommitment>,
	/// Benchmark version.
	pub benchmark_version: String,
	/// Prompt-set content address.
	pub prompt_set_digest: String,
	/// Scoring version.
	pub scoring_version: String,
	/// Verifier public identity.
	pub verifier: NodeIdentity,
	/// Observation time as safe Unix milliseconds.
	pub observed_unix_ms: u64,
	/// Replay result.
	pub replay_status: ReplayStatus,
	/// Synthetic/production isolation policy.
	pub policy: VerificationPolicy,
	/// Whether the normalized source is synthetic.
	pub synthetic: bool,
	/// Ed25519 signature over all preceding fields.
	pub signature: String,
}
impl VerifierAttestationV2 {
	/// Verifies the bound identity, policy, stage commitments, and signature.
	pub fn verify(
		&self,
		stage: &NormalizedBatchStage,
		expected_verifier: &NodeIdentity,
	) -> Result<(), NormalizationError> {
		if self.schema_version != VERIFIER_ATTESTATION_SCHEMA_VERSION
			|| self.signature_algorithm != VERIFIER_SIGNATURE_ALGORITHM
			|| self.signature_version != VERIFIER_SIGNATURE_VERSION
			|| &self.verifier != expected_verifier
			|| !verifier_is_distinct_from_stage(&self.verifier, stage)
			|| self.matrix_batch_id != stage.matrix_batch_id
			|| self.package_sha256 != stage.package_sha256
			|| self.content_hash != stage.content_hash
			|| self.normalization_digest != stage.normalization_digest
			|| self.task_set_hash != stage.task_set_hash
			|| self.capability_validation_digest != stage.capability_validation_digest
			|| self.provenance != stage.provenance
			|| self.benchmark_version != stage.benchmark_version
			|| self.prompt_set_digest != stage.prompt_set_digest
			|| self.scoring_version != stage.scoring_version
			|| self.synthetic != stage.synthetic
			|| self.policy
				!= if stage.synthetic {
					VerificationPolicy::SyntheticTest
				} else {
					VerificationPolicy::Production
				} || !valid_verification_outcome(self.synthetic, self.policy, self.replay_status)
			|| self.observed_unix_ms > MAX_JCS_SAFE_INTEGER
		{
			return Err(NormalizationError::new("attestation bindings are invalid"));
		}

		stage.verify()?;

		validate_node(&self.verifier)?;

		if !is_lower_hex_exact(&self.signature, 128) {
			return Err(NormalizationError::new(
				"attestation signature is not lowercase Ed25519 hex",
			));
		}

		let public: [u8; 32] = hex::decode(&self.verifier.public_key)
			.map_err(|error| NormalizationError::new(error.to_string()))?
			.try_into()
			.map_err(|_| NormalizationError::new("verifier public key is not 32 bytes"))?;
		let signature = Signature::from_slice(
			&hex::decode(&self.signature)
				.map_err(|error| NormalizationError::new(error.to_string()))?,
		)
		.map_err(|error| NormalizationError::new(error.to_string()))?;
		let key = VerifyingKey::from_bytes(&public)
			.map_err(|error| NormalizationError::new(error.to_string()))?;
		let signed_bytes = protocol::canonical_json(&UnsignedAttestation::from(self))
			.map_err(|error| NormalizationError::new(error.to_string()))?;

		key.verify(&signed_bytes, &signature).map_err(|error| {
			NormalizationError::new(format!("attestation signature failed: {error}"))
		})
	}
}

/// Deployment-backed verifier signing identity.
pub struct VerifierSigningIdentity {
	signing_key: SigningKey,
	node: NodeIdentity,
}
impl VerifierSigningIdentity {
	/// Creates a deterministic identity from deployment-supplied 32-byte key material.
	#[must_use]
	pub fn from_secret(secret: [u8; 32]) -> Self {
		let signing_key = SigningKey::from_bytes(&secret);
		let public_key = hex::encode(signing_key.verifying_key().as_bytes());
		let node_id =
			format!("node_{}", hex::encode(Sha256::digest(signing_key.verifying_key().as_bytes())));

		Self { signing_key, node: NodeIdentity { node_id, public_key } }
	}

	/// Returns the verifier public identity.
	#[must_use]
	pub fn node(&self) -> &NodeIdentity {
		&self.node
	}

	pub(crate) fn sign_calibration_bytes(&self, bytes: &[u8]) -> String {
		hex::encode(self.signing_key.sign(bytes).to_bytes())
	}

	/// Signs all immutable normalization bindings.
	pub fn attest(
		&self,
		stage: &NormalizedBatchStage,
		observed_unix_ms: u64,
		replay_status: ReplayStatus,
	) -> Result<VerifierAttestationV2, NormalizationError> {
		stage.verify()?;

		if !verifier_is_distinct_from_stage(&self.node, stage) {
			return Err(NormalizationError::new(
				"verifier signer must be distinct from the runner package signer",
			));
		}
		if observed_unix_ms > MAX_JCS_SAFE_INTEGER {
			return Err(NormalizationError::new("attestation time exceeds the JCS safe range"));
		}

		let policy = if stage.synthetic {
			VerificationPolicy::SyntheticTest
		} else {
			VerificationPolicy::Production
		};

		if !valid_verification_outcome(stage.synthetic, policy, replay_status) {
			return Err(NormalizationError::new(
				"attestation replay status is invalid for its verification policy",
			));
		}

		let mut attestation = VerifierAttestationV2 {
			schema_version: VERIFIER_ATTESTATION_SCHEMA_VERSION.to_owned(),
			signature_algorithm: VERIFIER_SIGNATURE_ALGORITHM.to_owned(),
			signature_version: VERIFIER_SIGNATURE_VERSION.to_owned(),
			matrix_batch_id: stage.matrix_batch_id.clone(),
			package_sha256: stage.package_sha256.clone(),
			content_hash: stage.content_hash.clone(),
			normalization_digest: stage.normalization_digest.clone(),
			task_set_hash: stage.task_set_hash.clone(),
			capability_validation_digest: stage.capability_validation_digest.clone(),
			provenance: stage.provenance.clone(),
			benchmark_version: stage.benchmark_version.clone(),
			prompt_set_digest: stage.prompt_set_digest.clone(),
			scoring_version: stage.scoring_version.clone(),
			verifier: self.node.clone(),
			observed_unix_ms,
			replay_status,
			policy,
			synthetic: stage.synthetic,
			signature: String::new(),
		};
		let signed_bytes = protocol::canonical_json(&UnsignedAttestation::from(&attestation))
			.map_err(|error| NormalizationError::new(error.to_string()))?;
		let signature = self.signing_key.sign(&signed_bytes);

		attestation.signature = hex::encode(signature.to_bytes());

		Ok(attestation)
	}
}

#[derive(Serialize)]
struct UnsignedNormalizedStage<'a> {
	schema_version: &'a str,
	matrix_batch_id: &'a str,
	package_sha256: &'a str,
	content_hash: &'a str,
	signer: &'a NodeIdentity,
	task_set_id: &'a str,
	task_set_version: &'a str,
	task_set_hash: &'a str,
	capability_validation_digest: &'a Option<String>,
	provenance: &'a Option<RunProvenanceCommitment>,
	run_class: Option<RunClass>,
	benchmark_version: &'a str,
	prompt_set_digest: &'a str,
	scoring_version: &'a str,
	runner_commit: &'a str,
	region: &'a str,
	scheduled_unix_ms: u64,
	started_unix_ms: u64,
	finished_unix_ms: u64,
	synthetic: bool,
	runs: &'a [NormalizedModelRun],
	execution_concurrency: usize,
	result_efficiency: &'a [CalibrationResultEfficiency],
	efficiency: &'a [CalibrationEfficiencyAggregate],
	pricing: &'a ApiEquivalentPricingModel,
}
impl<'a> From<&'a NormalizedBatchStage> for UnsignedNormalizedStage<'a> {
	fn from(value: &'a NormalizedBatchStage) -> Self {
		Self {
			schema_version: &value.schema_version,
			matrix_batch_id: &value.matrix_batch_id,
			package_sha256: &value.package_sha256,
			content_hash: &value.content_hash,
			signer: &value.signer,
			task_set_id: &value.task_set_id,
			task_set_version: &value.task_set_version,
			task_set_hash: &value.task_set_hash,
			capability_validation_digest: &value.capability_validation_digest,
			provenance: &value.provenance,
			run_class: value.run_class,
			benchmark_version: &value.benchmark_version,
			prompt_set_digest: &value.prompt_set_digest,
			scoring_version: &value.scoring_version,
			runner_commit: &value.runner_commit,
			region: &value.region,
			scheduled_unix_ms: value.scheduled_unix_ms,
			started_unix_ms: value.started_unix_ms,
			finished_unix_ms: value.finished_unix_ms,
			synthetic: value.synthetic,
			runs: &value.runs,
			execution_concurrency: value.execution_concurrency,
			result_efficiency: &value.result_efficiency,
			efficiency: &value.efficiency,
			pricing: &value.pricing,
		}
	}
}

#[derive(Serialize)]
struct UnsignedAttestation<'a> {
	schema_version: &'a str,
	signature_algorithm: &'a str,
	signature_version: &'a str,
	matrix_batch_id: &'a str,
	package_sha256: &'a str,
	content_hash: &'a str,
	normalization_digest: &'a str,
	task_set_hash: &'a str,
	capability_validation_digest: &'a Option<String>,
	provenance: &'a Option<RunProvenanceCommitment>,
	benchmark_version: &'a str,
	prompt_set_digest: &'a str,
	scoring_version: &'a str,
	verifier: &'a NodeIdentity,
	observed_unix_ms: u64,
	replay_status: ReplayStatus,
	policy: VerificationPolicy,
	synthetic: bool,
}
impl<'a> From<&'a VerifierAttestationV2> for UnsignedAttestation<'a> {
	fn from(value: &'a VerifierAttestationV2) -> Self {
		Self {
			schema_version: &value.schema_version,
			signature_algorithm: &value.signature_algorithm,
			signature_version: &value.signature_version,
			matrix_batch_id: &value.matrix_batch_id,
			package_sha256: &value.package_sha256,
			content_hash: &value.content_hash,
			normalization_digest: &value.normalization_digest,
			task_set_hash: &value.task_set_hash,
			capability_validation_digest: &value.capability_validation_digest,
			provenance: &value.provenance,
			benchmark_version: &value.benchmark_version,
			prompt_set_digest: &value.prompt_set_digest,
			scoring_version: &value.scoring_version,
			verifier: &value.verifier,
			observed_unix_ms: value.observed_unix_ms,
			replay_status: value.replay_status,
			policy: value.policy,
			synthetic: value.synthetic,
		}
	}
}

/// Database-compatible result outcome.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NormalizedOutcome {
	/// The evaluator accepted the response.
	Correct,
	/// The evaluator awarded partial credit.
	Partial,
	/// The evaluator rejected the response.
	Incorrect,
	/// A task-level timeout produced a valid zero.
	Timeout,
	/// A task-level budget limit produced a valid zero.
	BudgetExhausted,
	/// A model or tool execution failure produced a valid zero.
	ToolFailure,
	/// A policy or controlled-output failure produced a valid zero.
	PolicyFailure,
	/// The expected artifact was not produced and the result is a valid zero.
	WrongArtifact,
	/// Benchmark infrastructure or platform evidence is invalid and requires rerun.
	Invalid,
	/// The complete model configuration was actively found unsupported.
	NotApplicable,
}

/// Party or subsystem responsible for a failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureResponsibility {
	/// The agent produced an incorrect or unusable result.
	Agent,
	/// The selected model rejected the request.
	Model,
	/// A permitted tool failed.
	Tool,
	/// The task timed out.
	Timeout,
	/// A declared resource budget was exhausted.
	Budget,
	/// The expected artifact was absent or truncated.
	WrongArtifact,
	/// Fixture, evaluator, or workspace infrastructure failed.
	BenchmarkInfrastructure,
	/// Authentication, process, or capability-validation infrastructure failed.
	Platform,
}

/// Verifier replay disposition.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReplayStatus {
	/// The verifier reconstructed candidate workspaces and replayed deterministic evaluators.
	EvaluatorReplayed,
	/// Deterministic scoring and commitments were replayed without candidate reconstruction.
	CommitmentsVerified,
	/// Replay failed. Such an attestation is evidence of rejection, not publication eligibility.
	Failed,
}

/// Synthetic/production isolation asserted by the verifier.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VerificationPolicy {
	/// Production-only verification.
	Production,
	/// Isolated synthetic-test verification.
	SyntheticTest,
}

/// Maps a matrix configuration to its stable database identifier.
pub fn model_config_id(model: ModelConfig) -> Result<String, NormalizationError> {
	let family = match model.family {
		ModelFamily::Sol => "sol",
		ModelFamily::Terra => "terra",
		ModelFamily::Luna => "luna",
	};

	if model.family == ModelFamily::Luna && model.reasoning_effort == ReasoningEffort::Ultra {
		return Err(NormalizationError::new("luna-ultra is not in the model matrix"));
	}
	if !MODEL_MATRIX.contains(&model) {
		return Err(NormalizationError::new("model configuration is not in the matrix"));
	}

	Ok(format!("{family}-{}", model.reasoning_effort))
}

/// Derives a child identifier from the exact versioned identity bytes.
#[must_use]
pub fn child_run_id(matrix_batch_id: &str, model_config_id: &str) -> String {
	let identity = format!("aiq.model-run-identity.v1\n{matrix_batch_id}\n{model_config_id}");

	format!("run_{}", hex::encode(Sha256::digest(identity.as_bytes())))
}

/// Strictly validates and normalizes one complete 17 by 72 matrix batch.
pub fn normalize_verified_batch(
	run: &RunRecord,
	tasks: &[TaskDefinition],
	score_reports: &[ScoreReport],
	package: &VerifiedPackageIdentity,
	metadata: &AttestedDeploymentMetadata,
) -> Result<NormalizedBatchStage, NormalizationError> {
	run_validation::validate_run_record(run, Some(tasks))
		.map_err(|error| NormalizationError::new(format!("source run is invalid: {error}")))?;

	let execution_concurrency = run.execution_concurrency.ok_or_else(|| {
		NormalizationError::new("normalization requires a bound execution concurrency")
	})?;

	submission::validate_run_signer_binding(run, &package.signer.node_id).map_err(|error| {
		NormalizationError::new(format!("source run signer binding is invalid: {error}"))
	})?;

	if tasks.len() != NORMALIZED_TASK_COUNT {
		return Err(NormalizationError::new("normalization requires exactly 72 task definitions"));
	}

	validate_inputs(run, tasks, score_reports, package, metadata)?;

	let children = normalized_model_runs(run, tasks, score_reports)?;
	let empty_provider_usage =
		vec![crate::runner::ProviderTokenUsage::default(); run.results.len()];
	let (result_efficiency, efficiency, pricing) =
		calibration_verification::build_efficiency_evidence(
			&run.results,
			&empty_provider_usage,
			run.synthetic,
		)
		.map_err(|error| NormalizationError::new(error.to_string()))?;
	let mut stage = NormalizedBatchStage {
		schema_version: NORMALIZATION_SCHEMA_VERSION.to_owned(),
		matrix_batch_id: run.run_id.clone(),
		package_sha256: package.package_sha256.clone(),
		content_hash: package.content_hash.clone(),
		signer: package.signer.clone(),
		task_set_id: metadata.task_set_id.clone(),
		task_set_version: metadata.task_set_version.clone(),
		task_set_hash: run.task_set_hash.clone(),
		capability_validation_digest: run
			.capability_validation
			.as_ref()
			.map(crate::protocol::canonical_hash)
			.transpose()
			.map_err(|error| {
				NormalizationError::new(format!("capability commitment failed: {error}"))
			})?,
		provenance: run.provenance.clone(),
		run_class: run.provenance.as_ref().map(|provenance| provenance.run_class),
		benchmark_version: metadata.benchmark_version.clone(),
		prompt_set_digest: metadata.prompt_set_digest.clone(),
		scoring_version: run.scoring_version.clone(),
		runner_commit: metadata.runner_commit.clone(),
		region: metadata.region.clone(),
		scheduled_unix_ms: metadata.scheduled_unix_ms,
		started_unix_ms: metadata.started_unix_ms,
		finished_unix_ms: metadata.finished_unix_ms,
		synthetic: run.synthetic,
		runs: children,
		execution_concurrency,
		result_efficiency,
		efficiency,
		pricing,
		normalization_digest: String::new(),
	};

	stage.normalization_digest = stage.compute_normalization_digest()?;

	stage.verify()?;

	Ok(stage)
}

fn normalized_model_runs(
	run: &RunRecord,
	tasks: &[TaskDefinition],
	score_reports: &[ScoreReport],
) -> Result<Vec<NormalizedModelRun>, NormalizationError> {
	let task_map =
		tasks.iter().map(|task| (task.task_id.as_str(), task)).collect::<BTreeMap<_, _>>();
	let score_map =
		score_reports.iter().map(|report| (report.model, report)).collect::<BTreeMap<_, _>>();
	let mut children = Vec::with_capacity(NORMALIZED_MODEL_COUNT);

	for model in MODEL_MATRIX {
		let config_id = model_config_id(model)?;
		let child_id = child_run_id(&run.run_id, &config_id);
		let source_results =
			run.results.iter().filter(|result| result.model == model).collect::<Vec<_>>();
		let recomputed = recompute_score(tasks, run, model, &source_results)?;
		let supplied = score_map
			.get(&model)
			.ok_or_else(|| NormalizationError::new("score report is missing a model"))?;

		validate_score_report(supplied, &recomputed)?;

		let mut results = Vec::with_capacity(NORMALIZED_TASK_COUNT);

		for result in source_results {
			let task = task_map.get(result.task_id.as_str()).ok_or_else(|| {
				NormalizationError::new("result task is absent from task sources")
			})?;
			let (outcome, responsibility) = map_outcome(result, supplied.tier)?;

			results.push(NormalizedTaskResult {
				schema_version: NORMALIZED_RESULT_SCHEMA_VERSION.to_owned(),
				source_result_id: result.result_id.clone(),
				matrix_batch_id: run.run_id.clone(),
				run_id: child_id.clone(),
				task_id: result.task_id.clone(),
				task_version: result.task_version.clone(),
				task_hash: result.task_hash.clone(),
				domain: task.domain,
				scorer_version: task.scorer_version.clone(),
				model: result.model,
				source_status: result.status,
				source_evaluation: result.evaluation,
				outcome,
				task_score: result.task_score,
				failure_responsibility: responsibility,
				failure: result.failure.clone(),
				response: result.response.clone(),
				response_sha256: result.response_sha256.clone(),
				evaluator_stdout_sha256: result.evaluator_stdout_sha256.clone(),
				artifacts: result.artifacts.clone(),
				latency: result.latency.clone(),
				tool_usage: result.tool_usage.clone(),
				provenance: result.provenance.clone(),
			});
		}

		results.sort_by(|left, right| {
			(&left.task_id, &left.task_version).cmp(&(&right.task_id, &right.task_version))
		});
		children.push(NormalizedModelRun {
			schema_version: NORMALIZED_MODEL_RUN_SCHEMA_VERSION.to_owned(),
			run_id: child_id,
			matrix_batch_id: run.run_id.clone(),
			model_config_id: config_id,
			model,
			score: recomputed,
			results,
		});
	}

	Ok(children)
}

fn verifier_is_distinct_from_stage(verifier: &NodeIdentity, stage: &NormalizedBatchStage) -> bool {
	verifier.node_id != stage.signer.node_id
}

const fn valid_verification_outcome(
	synthetic: bool,
	policy: VerificationPolicy,
	replay_status: ReplayStatus,
) -> bool {
	matches!(
		(synthetic, policy, replay_status),
		(false, VerificationPolicy::Production, ReplayStatus::EvaluatorReplayed)
			| (
				true,
				VerificationPolicy::SyntheticTest,
				ReplayStatus::CommitmentsVerified | ReplayStatus::EvaluatorReplayed
			)
	)
}

fn recompute_score(
	tasks: &[TaskDefinition],
	run: &RunRecord,
	model: ModelConfig,
	source_results: &[&TaskResult],
) -> Result<ScoreReport, NormalizationError> {
	let context = ScoreContext {
		preflight_configuration_not_applicable: source_results.iter().all(|result| {
			result.status == ResultStatus::Unsupported
				&& result
					.failure
					.as_ref()
					.is_some_and(|failure| failure.kind == FailureKind::CapabilityUnavailable)
		}),
		receiver_authorized_publication: false,
	};

	scoring::score_model_with_context(tasks, &run.results, model, context, ScoreOptions::default())
		.map_err(|error| NormalizationError::new(format!("score recomputation failed: {error}")))
}

fn validate_inputs(
	run: &RunRecord,
	tasks: &[TaskDefinition],
	score_reports: &[ScoreReport],
	package: &VerifiedPackageIdentity,
	metadata: &AttestedDeploymentMetadata,
) -> Result<(), NormalizationError> {
	validate_hash("package_sha256", &package.package_sha256, false)?;
	validate_hash("content_hash", &package.content_hash, true)?;
	validate_node(&package.signer)?;
	validate_hash("prompt_set_digest", &metadata.prompt_set_digest, true)?;

	if metadata.task_set_id.is_empty()
		|| metadata.task_set_id.len() > 128
		|| !is_semver(&metadata.task_set_version)
		|| metadata.benchmark_version
			!= format!("{}@{}", metadata.task_set_id, metadata.task_set_version)
		|| metadata.region.is_empty()
		|| metadata.region.len() > 64
		|| !is_lower_hex_range(&metadata.runner_commit, 7, 40)
	{
		return Err(NormalizationError::new("attested deployment metadata is invalid"));
	}

	validate_safe_times(
		metadata.scheduled_unix_ms,
		metadata.started_unix_ms,
		metadata.finished_unix_ms,
	)?;

	if metadata.started_unix_ms != run.started_unix_ms
		|| metadata.finished_unix_ms != run.finished_unix_ms
	{
		return Err(NormalizationError::new(
			"attested execution timestamps differ from the signed run",
		));
	}
	if metadata.synthetic_test != run.synthetic {
		return Err(NormalizationError::new("synthetic input and destination policy do not match"));
	}

	if let Some(provenance) = &run.provenance
		&& (metadata.task_set_id != AIQ_TASK_SET_ID
			|| metadata.task_set_version != AIQ_TASK_SET_VERSION
			|| metadata.benchmark_version != AIQ_BENCHMARK_VERSION
			|| metadata.prompt_set_digest != provenance.prompt_digest)
	{
		return Err(NormalizationError::new(
			"deployment metadata differs from signed run provenance",
		));
	}

	let task_keys =
		tasks.iter().map(|task| (&task.task_id, &task.task_version)).collect::<BTreeSet<_>>();

	if task_keys.len() != tasks.len() {
		return Err(NormalizationError::new("task definitions contain duplicates"));
	}

	let report_models = score_reports.iter().map(|report| report.model).collect::<BTreeSet<_>>();

	if score_reports.len() != NORMALIZED_MODEL_COUNT
		|| report_models != MODEL_MATRIX.into_iter().collect()
	{
		return Err(NormalizationError::new("score reports must cover the exact model matrix"));
	}

	let result_ids =
		run.results.iter().map(|result| result.result_id.as_str()).collect::<BTreeSet<_>>();

	if result_ids.len() != run.results.len() {
		return Err(NormalizationError::new("source result identifiers contain duplicates"));
	}

	Ok(())
}

fn validate_score_report(
	supplied: &ScoreReport,
	recomputed: &ScoreReport,
) -> Result<(), NormalizationError> {
	validate_finite_numbers(supplied)?;

	if supplied != recomputed {
		return Err(NormalizationError::new(
			"score report differs from deterministic score recomputation",
		));
	}

	match supplied.tier {
		ScoreTier::Official
			if supplied.coverage.valid_tasks != NORMALIZED_TASK_COUNT
				|| supplied.score.is_none() =>
		{
			Err(NormalizationError::new("official score tier is inconsistent"))
		},
		ScoreTier::SyntheticComplete
			if supplied.coverage.valid_tasks != NORMALIZED_TASK_COUNT
				|| supplied.score.is_some()
				|| supplied.quality_score.is_none()
				|| supplied.ranking_eligible =>
		{
			Err(NormalizationError::new("synthetic-complete score tier is inconsistent"))
		},
		ScoreTier::NotApplicable
			if supplied.coverage.not_applicable_tasks != NORMALIZED_TASK_COUNT
				|| supplied.score.is_some()
				|| supplied.quality_score.is_some() =>
		{
			Err(NormalizationError::new("not-applicable score tier is inconsistent"))
		},
		_ => Ok(()),
	}
}

fn validate_finite_numbers(report: &ScoreReport) -> Result<(), NormalizationError> {
	let value =
		serde_json::to_value(report).map_err(|error| NormalizationError::new(error.to_string()))?;

	fn walk(value: &Value) -> bool {
		match value {
			serde_json::Value::Number(number) => {
				number.as_f64().is_some_and(f64::is_finite)
					&& number.as_u64().is_none_or(|value| value <= MAX_JCS_SAFE_INTEGER)
					&& number
						.as_i64()
						.is_none_or(|value| value.unsigned_abs() <= MAX_JCS_SAFE_INTEGER)
			},
			serde_json::Value::Array(values) => values.iter().all(walk),
			serde_json::Value::Object(values) => values.values().all(walk),
			_ => true,
		}
	}

	if walk(&value) {
		Ok(())
	} else {
		Err(NormalizationError::new("score report contains an unsafe number"))
	}
}

fn map_outcome(
	result: &TaskResult,
	tier: ScoreTier,
) -> Result<(NormalizedOutcome, Option<FailureResponsibility>), NormalizationError> {
	if tier == ScoreTier::NotApplicable {
		if result.status == ResultStatus::Unsupported
			&& result
				.failure
				.as_ref()
				.is_some_and(|failure| failure.kind == FailureKind::CapabilityUnavailable)
		{
			return Ok((NormalizedOutcome::NotApplicable, None));
		}

		return Err(NormalizationError::new(
			"not-applicable tier contains a partial capability failure",
		));
	}

	match (result.status, result.evaluation, result.failure.as_ref().map(|value| value.kind)) {
		(ResultStatus::Completed, EvaluationOutcome::Correct, None) => {
			Ok((NormalizedOutcome::Correct, None))
		},
		(ResultStatus::Completed, EvaluationOutcome::Partial, None) => {
			Ok((NormalizedOutcome::Partial, None))
		},
		(ResultStatus::Completed, EvaluationOutcome::Incorrect, None) => {
			Ok((NormalizedOutcome::Incorrect, Some(FailureResponsibility::Agent)))
		},
		(ResultStatus::Failed, _, Some(FailureKind::Timeout)) => {
			Ok((NormalizedOutcome::Timeout, Some(FailureResponsibility::Timeout)))
		},
		(ResultStatus::Failed, _, Some(FailureKind::BudgetExceeded)) => {
			Ok((NormalizedOutcome::BudgetExhausted, Some(FailureResponsibility::Budget)))
		},
		(ResultStatus::Failed, _, Some(FailureKind::UnsupportedModel)) => {
			Ok((NormalizedOutcome::ToolFailure, Some(FailureResponsibility::Model)))
		},
		(ResultStatus::Failed, _, Some(FailureKind::NonZeroExit)) => {
			Ok((NormalizedOutcome::ToolFailure, Some(FailureResponsibility::Tool)))
		},
		(ResultStatus::Failed, _, Some(FailureKind::MissingResponse)) => {
			Ok((NormalizedOutcome::WrongArtifact, Some(FailureResponsibility::WrongArtifact)))
		},
		(ResultStatus::Failed, _, Some(FailureKind::OutputTruncated)) => {
			Ok((NormalizedOutcome::PolicyFailure, Some(FailureResponsibility::WrongArtifact)))
		},
		(
			ResultStatus::Failed,
			_,
			Some(
				FailureKind::EvaluatorFailure
				| FailureKind::WorkspaceUnavailable
				| FailureKind::WorkspaceIntegrity
				| FailureKind::MissingEvaluator,
			),
		)
		| (ResultStatus::Unevaluated, _, Some(FailureKind::MissingEvaluator)) => {
			Ok((NormalizedOutcome::Invalid, Some(FailureResponsibility::BenchmarkInfrastructure)))
		},
		(
			ResultStatus::Failed,
			_,
			Some(
				FailureKind::Spawn
				| FailureKind::Authentication
				| FailureKind::SubscriptionLimit
				| FailureKind::CapabilityValidationFailed,
			),
		) => Ok((NormalizedOutcome::Invalid, Some(FailureResponsibility::Platform))),
		(ResultStatus::Unsupported, _, Some(FailureKind::CapabilityUnavailable)) => {
			Err(NormalizationError::new("partial capability failure cannot map to not_applicable"))
		},
		_ => Err(NormalizationError::new("source result has no lossless outcome mapping")),
	}
}

fn validate_node(node: &NodeIdentity) -> Result<(), NormalizationError> {
	if !is_lower_hex_exact(&node.public_key, 64)
		|| !node.node_id.strip_prefix("node_").is_some_and(|value| is_lower_hex_exact(value, 64))
	{
		return Err(NormalizationError::new("node identity encoding is invalid"));
	}

	let public: [u8; 32] = hex::decode(&node.public_key)
		.map_err(|error| NormalizationError::new(error.to_string()))?
		.try_into()
		.map_err(|_| NormalizationError::new("node public key is not 32 bytes"))?;
	let expected = format!("node_{}", hex::encode(Sha256::digest(public)));

	if node.node_id != expected {
		return Err(NormalizationError::new("node identifier does not derive from its public key"));
	}

	Ok(())
}

fn validate_hash(field: &str, value: &str, prefixed: bool) -> Result<(), NormalizationError> {
	let digest = if prefixed { value.strip_prefix("sha256:") } else { Some(value) };

	if digest.is_some_and(|value| is_lower_hex_exact(value, 64)) {
		Ok(())
	} else {
		Err(NormalizationError::new(format!("{field} is not a canonical SHA-256 digest")))
	}
}

fn validate_safe_times(
	scheduled: u64,
	started: u64,
	finished: u64,
) -> Result<(), NormalizationError> {
	if scheduled > MAX_JCS_SAFE_INTEGER
		|| started > MAX_JCS_SAFE_INTEGER
		|| finished > MAX_JCS_SAFE_INTEGER
		|| finished < started
	{
		Err(NormalizationError::new("timestamps are unsafe or out of order"))
	} else {
		Ok(())
	}
}

fn is_lower_hex_exact(value: &str, digits: usize) -> bool {
	value.len() == digits
		&& value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_lower_hex_range(value: &str, minimum: usize, maximum: usize) -> bool {
	(minimum..=maximum).contains(&value.len())
		&& value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_semver(value: &str) -> bool {
	let parts = value.split('.').collect::<Vec<_>>();

	parts.len() == 3
		&& parts.iter().all(|part| {
			!part.is_empty()
				&& part.bytes().all(|byte| byte.is_ascii_digit())
				&& (part == &"0" || !part.starts_with('0'))
		})
}

#[cfg(test)]
mod tests {
	use std::collections::BTreeSet;

	use ed25519_dalek::Signer as _;

	use crate::calibration_verification;
	use crate::{
		adapter::ArtifactReference,
		corpus_commitment::{self, RunClass},
		model::MODEL_MATRIX,
		normalization::{
			self, AttestedDeploymentMetadata, MAX_NORMALIZED_STAGE_BYTES, NormalizedOutcome,
			ReplayStatus, VerificationPolicy, VerifiedPackageIdentity, VerifierSigningIdentity,
		},
		protocol::{self, SigningIdentity, TrustTier},
		runner::{self},
		schedule::{ScheduleConfig, ScheduleOccurrence},
		scoring::{
			self, AIQ_BENCHMARK_VERSION, AIQ_TASK_SET_ID, AIQ_TASK_SET_VERSION, ScoreContext,
			ScoreOptions, ScoreTier,
		},
		submission,
	};

	fn fixture() -> (
		crate::runner::RunRecord,
		Vec<crate::task::TaskDefinition>,
		Vec<crate::scoring::ScoreReport>,
		VerifiedPackageIdentity,
		AttestedDeploymentMetadata,
	) {
		let slot = ScheduleConfig::default()
			.slot("2026-07-24", ScheduleOccurrence::Day)
			.expect("fixture slot");
		let tasks = runner::synthetic_demo_tasks();
		let signer = SigningIdentity::from_secret([11; 32]).node().clone();
		let mut run = runner::synthetic_demo(slot, &runner::TestArtifactSink).expect("fixture run");

		submission::bind_synthetic_run_to_signer(&mut run, &signer.node_id)
			.expect("bind synthetic fixture to package signer");

		let scores = MODEL_MATRIX
			.into_iter()
			.map(|model| {
				scoring::score_model_with_context(
					&tasks,
					&run.results,
					model,
					ScoreContext::default(),
					ScoreOptions::default(),
				)
				.expect("fixture score")
			})
			.collect();
		let package = VerifiedPackageIdentity {
			package_sha256: "a".repeat(64),
			content_hash: "sha256:".to_owned() + &"b".repeat(64),
			signer,
		};
		let metadata = AttestedDeploymentMetadata {
			task_set_id: AIQ_TASK_SET_ID.to_owned(),
			task_set_version: AIQ_TASK_SET_VERSION.to_owned(),
			benchmark_version: AIQ_BENCHMARK_VERSION.to_owned(),
			prompt_set_digest: "sha256:".to_owned() + &"c".repeat(64),
			runner_commit: "d".repeat(40),
			region: "local-test".to_owned(),
			scheduled_unix_ms: 0,
			started_unix_ms: run.started_unix_ms,
			finished_unix_ms: run.finished_unix_ms,
			synthetic_test: true,
		};

		(run, tasks, scores, package, metadata)
	}

	fn synthetic_stage() -> normalization::NormalizedBatchStage {
		let (run, tasks, scores, package, metadata) = fixture();

		normalization::normalize_verified_batch(&run, &tasks, &scores, &package, &metadata)
			.expect("normalize")
	}

	fn bind_runner_observed_efficiency(
		stage: &mut normalization::NormalizedBatchStage,
		run: &crate::runner::RunRecord,
	) {
		let provider_usage = vec![crate::runner::ProviderTokenUsage::default(); run.results.len()];
		let (result_efficiency, efficiency, pricing) =
			calibration_verification::build_efficiency_evidence(
				&run.results,
				&provider_usage,
				false,
			)
			.expect("production efficiency evidence");

		stage.result_efficiency = result_efficiency;
		stage.efficiency = efficiency;
		stage.pricing = pricing;
	}

	fn production_stage() -> normalization::NormalizedBatchStage {
		let (run, tasks, scores, package, metadata) = fixture();
		let mut stage =
			normalization::normalize_verified_batch(&run, &tasks, &scores, &package, &metadata)
				.expect("normalize production fixture source");
		let preflight_digest = format!("sha256:{}", "8".repeat(64));
		let provenance = corpus_commitment::fixture_run_provenance(
			stage.task_set_hash.clone(),
			format!("sha256:{}", "9".repeat(64)),
			format!("sha256:{}", "a".repeat(64)),
			preflight_digest.clone(),
		);

		stage.synthetic = false;
		stage.capability_validation_digest = Some(preflight_digest);
		stage.run_class = Some(RunClass::Official);

		stage.prompt_set_digest.clone_from(&provenance.prompt_digest);

		stage.provenance = Some(provenance);

		bind_runner_observed_efficiency(&mut stage, &run);

		stage.normalization_digest = stage.compute_normalization_digest().expect("digest");

		stage
	}

	fn resign_attestation(
		identity: &VerifierSigningIdentity,
		attestation: &mut normalization::VerifierAttestationV2,
	) {
		let bytes =
			protocol::canonical_json(&normalization::UnsignedAttestation::from(&*attestation))
				.expect("unsigned attestation");

		attestation.signature = hex::encode(identity.signing_key.sign(&bytes).to_bytes());
	}

	#[test]
	fn exact_batch_normalizes_with_stable_unique_child_and_source_ids() {
		let (run, tasks, scores, package, metadata) = fixture();
		let stage =
			normalization::normalize_verified_batch(&run, &tasks, &scores, &package, &metadata)
				.expect("normalize");

		assert_eq!(stage.runs.len(), 17);
		assert!(stage.runs.iter().all(|child| child.results.len() == 72));

		let child_ids = stage.runs.iter().map(|child| &child.run_id).collect::<BTreeSet<_>>();

		assert_eq!(child_ids.len(), 17);

		for child in &stage.runs {
			assert_eq!(
				child.run_id,
				normalization::child_run_id(
					&run.run_id,
					&normalization::model_config_id(child.model).expect("matrix model")
				)
			);

			for result in &child.results {
				assert!(
					run.results.iter().any(|source| source.result_id == result.source_result_id)
				);
			}
		}

		assert!(serde_json::to_vec(&stage).expect("serialize").len() <= MAX_NORMALIZED_STAGE_BYTES);
		assert_eq!(
			normalization::child_run_id(
				"run_0000000000000000000000000000000000000000000000000000000000000000",
				"sol-low"
			),
			"run_6e793db27ab19f494068c0d571cb0e064324ad5e1c888ad7fc149347bb8e8ebf"
		);
	}

	#[test]
	fn normalized_production_provenance_rejects_every_zero_digest_and_binding_mismatch() {
		let stage = production_stage();

		stage.verify().expect("production stage");

		for field in [
			"corpus_commitment_sha256",
			"catalog_digest",
			"task_set_digest",
			"evaluator_digest",
			"runtime_digest",
			"preflight_digest",
			"harness_digest",
			"prompt_digest",
			"tool_policy_digest",
			"network_policy_digest",
			"environment_digest",
			"source_manifest_digest",
			"runner_executable_digest",
			"codex_executable_digest",
			"permission_evidence_digest",
		] {
			let mut changed = stage.clone();
			let mut provenance =
				serde_json::to_value(changed.provenance.take().expect("production provenance"))
					.expect("serialize provenance");

			provenance[field] = serde_json::json!(format!("sha256:{}", "0".repeat(64)));
			changed.provenance =
				Some(serde_json::from_value(provenance).expect("deserialize provenance"));
			changed.normalization_digest = changed.compute_normalization_digest().expect("digest");

			assert!(changed.verify().is_err(), "{field} must reject the zero digest");
		}
		for (field, value) in [
			("catalog_digest", format!("sha256:{}", "f".repeat(64))),
			("task_set_digest", format!("sha256:{}", "e".repeat(64))),
			("preflight_digest", format!("sha256:{}", "d".repeat(64))),
			("prompt_digest", format!("sha256:{}", "c".repeat(64))),
		] {
			let mut changed = stage.clone();
			let mut provenance =
				serde_json::to_value(changed.provenance.take().expect("production provenance"))
					.expect("serialize provenance");

			provenance[field] = serde_json::json!(value);
			changed.provenance =
				Some(serde_json::from_value(provenance).expect("deserialize provenance"));
			changed.normalization_digest = changed.compute_normalization_digest().expect("digest");

			assert!(changed.verify().is_err(), "{field} must remain bound");
		}
	}

	#[test]
	fn normalized_synthetic_and_production_provenance_policies_are_exclusive() {
		let synthetic = synthetic_stage();
		let production = production_stage();

		synthetic.verify().expect("synthetic stage");
		production.verify().expect("production stage");

		let mut changed = synthetic.clone();

		changed.capability_validation_digest = Some(format!("sha256:{}", "a".repeat(64)));
		changed.normalization_digest = changed.compute_normalization_digest().expect("digest");

		assert!(changed.verify().is_err());

		let mut changed = synthetic;

		changed.provenance = production.provenance.clone();
		changed.normalization_digest = changed.compute_normalization_digest().expect("digest");

		assert!(changed.verify().is_err());

		let mut changed = production.clone();

		changed.capability_validation_digest = None;
		changed.normalization_digest = changed.compute_normalization_digest().expect("digest");

		assert!(changed.verify().is_err());

		let mut changed = production;

		changed.provenance = None;
		changed.normalization_digest = changed.compute_normalization_digest().expect("digest");

		assert!(changed.verify().is_err());
	}

	#[test]
	fn normalized_artifacts_bind_the_digest_and_supported_kind_into_the_uri() {
		let digest = "a".repeat(64);
		let mut stage = synthetic_stage();

		stage.runs[0].results[0].artifacts.push(ArtifactReference {
			kind: "stdout.jsonl".to_owned(),
			content_hash: format!("sha256:{digest}"),
			uri: format!("aiq-artifact://sha256/{digest}/stdout.jsonl"),
			bytes: 1,
		});

		stage.normalization_digest = stage.compute_normalization_digest().expect("digest");

		stage.verify().expect("canonical artifact");

		let mut wrong_digest = stage.clone();

		wrong_digest.runs[0].results[0].artifacts[0].uri =
			format!("aiq-artifact://sha256/{}/stdout.jsonl", "b".repeat(64));
		wrong_digest.normalization_digest =
			wrong_digest.compute_normalization_digest().expect("digest");

		assert!(wrong_digest.verify().is_err());

		let mut wrong_kind = stage;

		wrong_kind.runs[0].results[0].artifacts[0].kind = "workspace-manifest.json".to_owned();
		wrong_kind.runs[0].results[0].artifacts[0].uri =
			format!("aiq-artifact://sha256/{digest}/workspace-manifest.json");
		wrong_kind.normalization_digest =
			wrong_kind.compute_normalization_digest().expect("digest");

		assert!(wrong_kind.verify().is_err());
	}

	#[test]
	fn verifier_policy_truth_table_and_signing_are_fail_closed() {
		for (synthetic, policy, replay_status, valid) in [
			(false, VerificationPolicy::Production, ReplayStatus::EvaluatorReplayed, true),
			(false, VerificationPolicy::Production, ReplayStatus::CommitmentsVerified, false),
			(false, VerificationPolicy::Production, ReplayStatus::Failed, false),
			(false, VerificationPolicy::SyntheticTest, ReplayStatus::EvaluatorReplayed, false),
			(true, VerificationPolicy::SyntheticTest, ReplayStatus::EvaluatorReplayed, true),
			(true, VerificationPolicy::SyntheticTest, ReplayStatus::CommitmentsVerified, true),
			(true, VerificationPolicy::SyntheticTest, ReplayStatus::Failed, false),
			(true, VerificationPolicy::Production, ReplayStatus::EvaluatorReplayed, false),
		] {
			assert_eq!(
				normalization::valid_verification_outcome(synthetic, policy, replay_status),
				valid
			);
		}

		let verifier = VerifierSigningIdentity::from_secret([21; 32]);
		let synthetic = synthetic_stage();
		let production = production_stage();

		for status in [ReplayStatus::CommitmentsVerified, ReplayStatus::EvaluatorReplayed] {
			verifier.attest(&synthetic, 1_000, status).expect("synthetic status");
		}
		for status in [ReplayStatus::CommitmentsVerified, ReplayStatus::Failed] {
			assert!(verifier.attest(&production, 1_000, status).is_err());
		}

		verifier
			.attest(&production, 1_000, ReplayStatus::EvaluatorReplayed)
			.expect("production evaluator replay");

		assert!(verifier.attest(&synthetic, 1_000, ReplayStatus::Failed).is_err());
	}

	#[test]
	fn verifier_refuses_self_consistent_but_unpublishable_stage_evidence() {
		let verifier = VerifierSigningIdentity::from_secret([21; 32]);
		let stage = synthetic_stage();
		let mut changed = stage.clone();

		changed.pricing.currency = "EUR".to_owned();
		changed.normalization_digest = changed.compute_normalization_digest().expect("digest");

		assert!(changed.verify().is_err());
		assert!(verifier.attest(&changed, 1_000, ReplayStatus::CommitmentsVerified).is_err());

		let mut changed = stage.clone();

		changed.efficiency[0].selected_tasks -= 1;
		changed.normalization_digest = changed.compute_normalization_digest().expect("digest");

		assert!(changed.verify().is_err());
		assert!(verifier.attest(&changed, 1_000, ReplayStatus::CommitmentsVerified).is_err());

		let mut changed = stage.clone();

		changed.result_efficiency[1].source_result_id =
			changed.result_efficiency[0].source_result_id.clone();
		changed.normalization_digest = changed.compute_normalization_digest().expect("digest");

		assert!(changed.verify().is_err());
		assert!(verifier.attest(&changed, 1_000, ReplayStatus::CommitmentsVerified).is_err());

		let mut changed = stage;

		changed.runs[0].score.schema_version = "aiq.score-report.future".to_owned();
		changed.normalization_digest = changed.compute_normalization_digest().expect("digest");

		assert!(changed.verify().is_err());
		assert!(verifier.attest(&changed, 1_000, ReplayStatus::CommitmentsVerified).is_err());
	}

	#[test]
	fn normalization_api_rejects_valid_package_signer_substitution() {
		let (run, tasks, scores, mut package, metadata) = fixture();

		package.signer = SigningIdentity::from_secret([12; 32]).node().clone();

		assert!(
			normalization::normalize_verified_batch(&run, &tasks, &scores, &package, &metadata)
				.is_err()
		);
	}

	#[test]
	fn normalized_v3_requires_one_bounded_execution_concurrency() {
		let (mut run, tasks, scores, package, metadata) = fixture();

		run.execution_concurrency = None;

		assert!(
			normalization::normalize_verified_batch(&run, &tasks, &scores, &package, &metadata)
				.is_err()
		);

		let stage = synthetic_stage();
		let mut missing = serde_json::to_value(&stage).expect("serialize normalized stage");

		missing.as_object_mut().expect("normalized stage object").remove("execution_concurrency");

		assert!(serde_json::from_value::<normalization::NormalizedBatchStage>(missing).is_err());

		let mut null = serde_json::to_value(&stage).expect("serialize normalized stage");

		null["execution_concurrency"] = serde_json::Value::Null;

		assert!(serde_json::from_value::<normalization::NormalizedBatchStage>(null).is_err());

		for invalid in [0, crate::runner::MAX_RUN_JOBS + 1] {
			let mut changed = stage.clone();

			changed.execution_concurrency = invalid;
			changed.normalization_digest =
				changed.compute_normalization_digest().expect("digest invalid stage");

			assert!(changed.verify().is_err());
		}
	}

	#[test]
	fn production_result_runner_must_match_the_package_signer_at_every_entry_point() {
		let verifier = VerifierSigningIdentity::from_secret([21; 32]);
		let substituted_runner = SigningIdentity::from_secret([30; 32]);
		let mut stage = production_stage();
		let mut attestation = verifier
			.attest(&stage, 1_000, ReplayStatus::EvaluatorReplayed)
			.expect("initial attestation");

		stage.runs[0].results[0].provenance.node_id.clone_from(&substituted_runner.node().node_id);

		stage.normalization_digest = stage.compute_normalization_digest().expect("digest");

		attestation.normalization_digest.clone_from(&stage.normalization_digest);

		resign_attestation(&verifier, &mut attestation);

		assert!(stage.verify().is_err());
		assert!(verifier.attest(&stage, 1_001, ReplayStatus::EvaluatorReplayed).is_err());
		assert!(attestation.verify(&stage, verifier.node()).is_err());
	}

	#[test]
	fn verifier_key_must_be_distinct_from_package_key() {
		let synthetic = synthetic_stage();
		let package_verifier = VerifierSigningIdentity::from_secret([11; 32]);

		assert!(
			package_verifier.attest(&synthetic, 1_000, ReplayStatus::CommitmentsVerified).is_err()
		);
	}

	#[test]
	fn valid_attestation_signature_cannot_bypass_package_role_separation() {
		let verifier = VerifierSigningIdentity::from_secret([21; 32]);
		let mut synthetic = synthetic_stage();
		let mut package_substitution = verifier
			.attest(&synthetic, 1_000, ReplayStatus::CommitmentsVerified)
			.expect("initial attestation");

		synthetic.signer = verifier.node().clone();
		synthetic.normalization_digest = synthetic.compute_normalization_digest().expect("digest");

		package_substitution.normalization_digest.clone_from(&synthetic.normalization_digest);

		resign_attestation(&verifier, &mut package_substitution);

		assert!(package_substitution.verify(&synthetic, verifier.node()).is_err());
	}

	#[test]
	fn digest_and_attestation_bind_every_stage_field_and_verifier_key() {
		let (run, tasks, scores, package, metadata) = fixture();
		let stage =
			normalization::normalize_verified_batch(&run, &tasks, &scores, &package, &metadata)
				.expect("normalize");
		let verifier = VerifierSigningIdentity::from_secret([21; 32]);
		let wrong = VerifierSigningIdentity::from_secret([22; 32]);
		let attestation =
			verifier.attest(&stage, 1_000, ReplayStatus::CommitmentsVerified).expect("attest");

		attestation.verify(&stage, verifier.node()).expect("verify");

		assert!(attestation.verify(&stage, wrong.node()).is_err());

		let mut changed = stage.clone();

		changed.region.push('x');

		assert!(changed.verify().is_err());
		assert!(attestation.verify(&changed, verifier.node()).is_err());

		let mut changed_result = stage.clone();

		changed_result.runs[0].results[0].latency.wall_ms += 1;

		assert!(changed_result.verify().is_err());

		let mut altered = attestation.clone();

		altered.matrix_batch_id.push('x');

		assert!(altered.verify(&stage, verifier.node()).is_err());

		let mut altered = attestation.clone();

		altered.package_sha256.replace_range(0..1, "b");

		assert!(altered.verify(&stage, verifier.node()).is_err());

		let mut altered = attestation.clone();

		altered.content_hash.replace_range(7..8, "c");

		assert!(altered.verify(&stage, verifier.node()).is_err());

		let mut altered = attestation.clone();
		let replacement = if &altered.normalization_digest[7..8] == "d" { "e" } else { "d" };

		altered.normalization_digest.replace_range(7..8, replacement);

		assert!(altered.verify(&stage, verifier.node()).is_err());

		let production_stage = production_stage();

		production_stage.verify().expect("production provenance");

		let production_attestation = verifier
			.attest(&production_stage, 1_001, ReplayStatus::EvaluatorReplayed)
			.expect("production attestation");
		let mut changed_provenance = production_stage.clone();

		changed_provenance
			.provenance
			.as_mut()
			.expect("provenance")
			.harness_digest
			.replace_range(7..8, "b");

		assert!(production_attestation.verify(&changed_provenance, verifier.node()).is_err());

		let mut altered = attestation.clone();

		altered.task_set_hash.replace_range(7..8, "e");

		assert!(altered.verify(&stage, verifier.node()).is_err());

		let mut altered = attestation.clone();

		altered.prompt_set_digest.replace_range(7..8, "f");

		assert!(altered.verify(&stage, verifier.node()).is_err());

		let mut altered = attestation.clone();

		altered.scoring_version.push('x');

		assert!(altered.verify(&stage, verifier.node()).is_err());

		let mut altered = attestation.clone();

		altered.observed_unix_ms += 1;

		assert!(altered.verify(&stage, verifier.node()).is_err());

		let mut altered = attestation.clone();

		altered.replay_status = ReplayStatus::Failed;

		assert!(altered.verify(&stage, verifier.node()).is_err());
	}

	#[test]
	fn evaluator_replay_status_uses_the_current_wire_name() {
		assert_eq!(
			serde_json::to_string(&ReplayStatus::EvaluatorReplayed).expect("serialize"),
			"\"evaluator_replayed\""
		);
		assert!(
			serde_json::from_str::<ReplayStatus>("\"reproduced\"").is_err(),
			"unsupported replay status must not deserialize"
		);
	}

	#[test]
	fn duplicate_missing_model_score_and_policy_mismatches_are_rejected() {
		let (mut run, tasks, scores, package, metadata) = fixture();

		run.results[1].result_id = run.results[0].result_id.clone();

		assert!(
			normalization::normalize_verified_batch(&run, &tasks, &scores, &package, &metadata)
				.is_err()
		);

		let (run, mut tasks, scores, package, metadata) = fixture();

		tasks[1] = tasks[0].clone();

		assert!(
			normalization::normalize_verified_batch(&run, &tasks, &scores, &package, &metadata)
				.is_err()
		);

		let (mut run, tasks, _, package, metadata) = fixture();

		run.results.pop();

		assert!(
			normalization::normalize_verified_batch(&run, &tasks, &scores, &package, &metadata)
				.is_err()
		);

		let (run, tasks, mut scores, package, metadata) = fixture();

		scores[1].model = scores[0].model;

		assert!(
			normalization::normalize_verified_batch(&run, &tasks, &scores, &package, &metadata)
				.is_err()
		);

		let (run, tasks, mut scores, package, metadata) = fixture();

		scores[0].score = Some(99.0);

		assert!(
			normalization::normalize_verified_batch(&run, &tasks, &scores, &package, &metadata)
				.is_err()
		);

		let (run, tasks, scores, package, mut metadata2) = fixture();

		metadata2.synthetic_test = false;

		assert!(
			normalization::normalize_verified_batch(&run, &tasks, &scores, &package, &metadata2)
				.is_err()
		);
	}

	#[test]
	fn all_score_tiers_and_lossless_outcomes_are_explicit() {
		let (_, _, scores, _, _) = fixture();

		assert_eq!(scores[0].tier, ScoreTier::SyntheticComplete);
		assert!(scores[0].score.is_none());
		assert!(scores[0].quality_score.is_some());

		let mut result = crate::runner::TaskResult {
			schema_version: String::new(),
			result_id: String::new(),
			run_id: String::new(),
			task_id: String::new(),
			task_version: String::new(),
			task_hash: String::new(),
			model: MODEL_MATRIX[0],
			status: crate::runner::ResultStatus::Completed,
			evaluation: crate::runner::EvaluationOutcome::Correct,
			task_score: Some(1.0),
			response: None,
			response_sha256: None,
			evaluator_result_sha256: None,
			evaluator_stdout_sha256: None,
			artifacts: Vec::new(),
			failure: None,
			latency: crate::runner::Latency { wall_ms: 0 },
			tool_usage: crate::runner::ToolUsage::default(),
			evaluator_checks: Vec::new(),
			workspace_manifest: None,
			provenance: crate::protocol::ResultProvenance {
				node_id: String::new(),
				runner_version: String::new(),
				codex_version: String::new(),
				observed_at: String::new(),
				synthetic: true,
				local_trust: TrustTier::Untrusted,
			},
		};

		assert_eq!(
			normalization::map_outcome(&result, ScoreTier::Official).expect("correct").0,
			NormalizedOutcome::Correct
		);
		assert_eq!(
			normalization::map_outcome(&result, ScoreTier::SyntheticComplete)
				.expect("synthetic correct")
				.0,
			NormalizedOutcome::Correct
		);

		result.evaluation = crate::runner::EvaluationOutcome::Partial;
		result.task_score = Some(0.5);

		assert_eq!(
			normalization::map_outcome(&result, ScoreTier::Provisional).expect("partial").0,
			NormalizedOutcome::Partial
		);

		result.evaluation = crate::runner::EvaluationOutcome::Incorrect;
		result.task_score = Some(0.0);

		assert_eq!(
			normalization::map_outcome(&result, ScoreTier::CoverageOnly).expect("incorrect").0,
			NormalizedOutcome::Incorrect
		);

		result.status = crate::runner::ResultStatus::Unsupported;
		result.evaluation = crate::runner::EvaluationOutcome::NotEvaluated;
		result.task_score = None;
		result.failure = Some(crate::runner::ResultFailure {
			kind: crate::runner::FailureKind::CapabilityUnavailable,
			message: "unsupported".to_owned(),
			exit_code: None,
			retryable: false,
		});

		assert_eq!(
			normalization::map_outcome(&result, ScoreTier::NotApplicable).expect("N/A").0,
			NormalizedOutcome::NotApplicable
		);
		assert!(normalization::map_outcome(&result, ScoreTier::CoverageOnly).is_err());
	}
}
