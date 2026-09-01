//! Deterministic candidate release qualification shared by the runner and verifier.

use std::{
	error::Error,
	fmt::{Display, Formatter},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
	calibration_verification::{CalibrationVerifiedStageV1, CalibrationVerifierAttestationV1},
	candidate_catalog::{
		CANDIDATE_TASK_SET_VERSION, CandidateCatalogAuthority, CandidateCatalogStatus,
	},
	corpus_commitment::RunClass,
	model::{ModelConfig, ModelFamily, ReasoningEffort},
	protocol::{self, NodeIdentity},
	runner::{EvaluationOutcome, ResultStatus, TaskResult},
	scoring::{AIQ_SCORING_VERSION, AIQ_TASK_SET_ID},
};

/// Exact family-representative model matrix used only for candidate release qualification.
pub const CANDIDATE_QUALIFICATION_MODEL_MATRIX: [ModelConfig; 3] = [
	ModelConfig { family: ModelFamily::Sol, reasoning_effort: ReasoningEffort::Medium },
	ModelConfig { family: ModelFamily::Terra, reasoning_effort: ReasoningEffort::Medium },
	ModelConfig { family: ModelFamily::Luna, reasoning_effort: ReasoningEffort::Medium },
];
/// Predeclared qualification-manifest schema.
pub const QUALIFICATION_MANIFEST_SCHEMA_VERSION: &str = "aiq.benchmark-qualification-manifest.v3";
/// Verifier-owned candidate cell-projection schema.
pub const QUALIFICATION_PROJECTION_SCHEMA_VERSION: &str =
	"aiq.benchmark-qualification-projection.v2";
/// Deterministic qualification artifact schema.
pub const QUALIFICATION_ARTIFACT_SCHEMA_VERSION: &str = "aiq.benchmark-qualification.v3";
/// Exact candidate release-qualification policy identity.
pub const QUALIFICATION_POLICY_VERSION: &str = "aiq.benchmark-qualification-policy.v2";
/// Exact identity-and-completeness qualification method.
pub const QUALIFICATION_METHOD_VERSION: &str =
	"aiq.single-replay-verified-complete-family-matrix-qualification.v1";
/// Exact positive scope of the qualification claim.
pub const QUALIFICATION_PROVES: &str = "end_to_end_execution_and_exact_corpus_source_package_verifier_identity_with_complete_family_representative_coverage";
/// Claims deliberately excluded from this one-run execution qualification.
pub const QUALIFICATION_EXCLUDED_CLAIMS: [&str; 4] =
	["prediction_interval", "spearman_correlation", "run_variance", "precise_ranking"];

const QUALIFICATION_MATRIX_SCHEMA_VERSION: &str = "aiq.benchmark-qualification-matrix.v3";
const REQUIRED_TASKS: usize = 72;
const REQUIRED_COMPLETED_CELLS: usize = 216;

/// Exact candidate release-qualification policy.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BenchmarkQualificationPolicy {
	/// Stable policy identity.
	pub version: String,
	/// Required catalog-ordered tasks.
	pub required_tasks: usize,
	/// Exact one-per-family representative configuration selection.
	pub required_models: [ModelConfig; 3],
	/// Required completed semantic cells.
	pub required_completed_cells: usize,
}
impl Default for BenchmarkQualificationPolicy {
	fn default() -> Self {
		Self {
			version: QUALIFICATION_POLICY_VERSION.to_owned(),
			required_tasks: REQUIRED_TASKS,
			required_models: CANDIDATE_QUALIFICATION_MODEL_MATRIX,
			required_completed_cells: REQUIRED_COMPLETED_CELLS,
		}
	}
}

/// All exact identities that must match the replay-verified matrix.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct QualificationCandidateIdentity {
	/// New candidate identity. It must change after a failed candidate is revised.
	pub candidate_id: String,
	/// Complete public candidate catalog digest.
	pub catalog_digest: String,
	/// Ordered full task-metadata identity committed by the candidate corpus.
	pub task_metadata_digest: String,
	/// Complete private task-set digest.
	pub task_set_digest: String,
	/// Controlled corpus release identifier.
	pub corpus_release_id: String,
	/// Complete corpus commitment digest.
	pub corpus_commitment_digest: String,
	/// Selected evaluator identity.
	pub evaluator_digest: String,
	/// Controlled benchmark harness identity.
	pub harness_digest: String,
	/// Exact prompt-source identity.
	pub prompt_digest: String,
	/// Declared model-visible tool policy identity.
	pub tool_policy_digest: String,
	/// Declared network policy identity.
	pub network_policy_digest: String,
	/// Controlled execution environment identity.
	pub environment_digest: String,
	/// Source-manifest identity.
	pub source_manifest_digest: String,
	/// Exact three-configuration model-selection identity.
	pub model_selection_digest: String,
}

/// One child identity declared before qualification reads replayed cells.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PredeclaredQualificationChild {
	/// Stable child identity.
	pub child_id: String,
	/// Exact source run identity expected for this child.
	pub source_run_id: String,
	/// Exact trusted verifier identity fixed before qualification analysis.
	pub verifier: NodeIdentity,
}

/// Predeclared candidate and single-child contract.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BenchmarkQualificationManifest {
	/// Manifest schema.
	pub schema_version: String,
	/// Exact candidate identity.
	pub candidate: QualificationCandidateIdentity,
	/// Exact immutable identity-and-completeness policy.
	pub policy: BenchmarkQualificationPolicy,
	/// The one predeclared run and verifier binding.
	pub child: PredeclaredQualificationChild,
}

/// One exact task-model cell in the qualification matrix.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct QualificationCell {
	/// Exact task identifier.
	pub task_id: String,
	/// Exact model configuration.
	pub model: ModelConfig,
	/// Semantic completion state.
	pub status: QualificationCellStatus,
	/// Semantic score from zero through one. Runtime-invalid cells use null.
	pub semantic_score: Option<f64>,
}

/// Candidate-only semantic-cell projection created inside verifier replay.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CandidateQualificationProjection {
	/// Projection schema.
	pub schema_version: String,
	/// Exact candidate identity selected by the verified corpus.
	pub candidate_id: String,
	/// Only replay-accepted evidence can support qualification.
	pub disposition: QualificationChildDisposition,
	/// Synthetic evidence is permanently ineligible.
	pub synthetic: bool,
	/// Model-major, then task-major complete semantic cells.
	pub cells: Vec<QualificationCell>,
}

/// Exact replay-verified child identity bound by the qualification artifact.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct QualificationChildBinding {
	/// Predeclared child identity.
	pub child_id: String,
	/// Exact source run identity.
	pub source_run_id: String,
	/// Exact source run digest.
	pub source_run_digest: String,
	/// SHA-256 of the exact signed package bytes.
	pub source_package_sha256: String,
	/// Signed package content commitment.
	pub source_package_content_hash: String,
	/// Runner identity authenticated by the verifier attestation.
	pub runner: NodeIdentity,
	/// Trusted verifier identity that signed this child evidence.
	pub verifier: NodeIdentity,
	/// Exact independent verifier evidence digest.
	pub verifier_attestation_digest: String,
	/// Exact signed run-provenance digest for this child.
	pub run_provenance_digest: String,
	/// Canonical digest of the complete supplied matrix.
	pub matrix_digest: String,
}

/// Explicit boundary on what one qualification artifact does and does not claim.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct QualificationClaimScope {
	/// Exact positive evidence claim.
	pub proves: String,
	/// Statistical and ranking claims that this protocol does not make.
	pub excludes: [String; 4],
}
impl Default for QualificationClaimScope {
	fn default() -> Self {
		Self {
			proves: QUALIFICATION_PROVES.to_owned(),
			excludes: QUALIFICATION_EXCLUDED_CLAIMS.map(str::to_owned),
		}
	}
}

/// Canonical qualification claims covered by the artifact digest.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BenchmarkQualificationClaims {
	/// Qualified result. Invalid or incomplete evidence produces no artifact.
	pub status: BenchmarkQualificationStatus,
	/// Exact candidate identities.
	pub candidate: QualificationCandidateIdentity,
	/// Exact applied policy.
	pub policy: BenchmarkQualificationPolicy,
	/// Canonical policy digest.
	pub policy_digest: String,
	/// Canonical predeclared manifest digest.
	pub manifest_digest: String,
	/// Exact identity-and-completeness method.
	pub method_version: String,
	/// Explicit positive and excluded claim scope.
	pub scope: QualificationClaimScope,
	/// Exact package, runner, verifier, provenance, and matrix bindings.
	pub child: QualificationChildBinding,
	/// Exact catalog-ordered task count.
	pub task_count: usize,
	/// Exact one-per-family configuration selection.
	pub models: [ModelConfig; 3],
	/// Exact completed cell count.
	pub completed_cells: usize,
}

/// Content-addressed qualification result.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BenchmarkQualificationArtifact {
	/// Artifact schema.
	pub schema_version: String,
	/// Canonical digest of `claims`.
	pub claims_digest: String,
	/// Complete deterministic claims.
	pub claims: BenchmarkQualificationClaims,
}

/// Structural qualification failure.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BenchmarkQualificationError {
	message: String,
}
impl BenchmarkQualificationError {
	fn new(message: impl Into<String>) -> Self {
		Self { message: message.into() }
	}
}
impl Error for BenchmarkQualificationError {}
impl Display for BenchmarkQualificationError {
	fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
		formatter.write_str(&self.message)
	}
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct QualificationMatrix {
	schema_version: String,
	child_id: String,
	source_run_id: String,
	source_run_digest: String,
	source_package_sha256: String,
	source_package_content_hash: String,
	runner: NodeIdentity,
	verifier: NodeIdentity,
	verifier_attestation_digest: String,
	run_provenance_digest: String,
	disposition: QualificationChildDisposition,
	rejection_digest: Option<String>,
	synthetic: bool,
	candidate: QualificationCandidateIdentity,
	models: Vec<ModelConfig>,
	task_ids: Vec<String>,
	cells: Vec<QualificationCell>,
}

struct ValidatedMatrix<'a> {
	matrix: &'a QualificationMatrix,
	digest: String,
}

/// Child verification disposition supplied to qualification.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum QualificationChildDisposition {
	/// The child is eligible for qualification.
	Accepted,
	/// The child was already rejected and can never support success.
	Rejected,
}

/// Cell state supplied by the child-matrix producer.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum QualificationCellStatus {
	/// A semantic evaluator completed and supplied a valid score.
	Completed,
	/// Runtime, infrastructure, or evaluator evidence is invalid.
	RuntimeInvalid,
}

/// Qualification outcome encoded in the immutable artifact.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BenchmarkQualificationStatus {
	/// Every identity and completeness requirement passed.
	Qualified,
}

pub(crate) fn candidate_projection_from_replayed_results(
	candidate_id: &str,
	models: &[ModelConfig],
	task_ids: &[String],
	results: &[TaskResult],
) -> Result<CandidateQualificationProjection, BenchmarkQualificationError> {
	if !valid_token(candidate_id, 128)
		|| models != CANDIDATE_QUALIFICATION_MODEL_MATRIX
		|| task_ids.len() != REQUIRED_TASKS
		|| results.len() != REQUIRED_COMPLETED_CELLS
	{
		return Err(BenchmarkQualificationError::new(
			"candidate qualification projection requires one complete 3-by-72 result matrix",
		));
	}

	let cells = results
		.iter()
		.enumerate()
		.map(|(index, result)| {
			let expected_model = CANDIDATE_QUALIFICATION_MODEL_MATRIX[index / task_ids.len()];
			let expected_task_id = &task_ids[index % task_ids.len()];
			let score = result.task_score.ok_or_else(|| {
				BenchmarkQualificationError::new(
					"candidate qualification result has no semantic score",
				)
			})?;

			if result.model != expected_model
				|| &result.task_id != expected_task_id
				|| result.status != ResultStatus::Completed
				|| result.evaluation == EvaluationOutcome::NotEvaluated
				|| !score.is_finite()
				|| !(0.0..=1.0).contains(&score)
			{
				return Err(BenchmarkQualificationError::new(
					"candidate qualification result is incomplete, reordered, or runtime-invalid",
				));
			}

			Ok(QualificationCell {
				task_id: result.task_id.clone(),
				model: result.model,
				status: QualificationCellStatus::Completed,
				semantic_score: Some(score),
			})
		})
		.collect::<Result<Vec<_>, _>>()?;

	Ok(CandidateQualificationProjection {
		schema_version: QUALIFICATION_PROJECTION_SCHEMA_VERSION.to_owned(),
		candidate_id: candidate_id.to_owned(),
		disposition: QualificationChildDisposition::Accepted,
		synthetic: false,
		cells,
	})
}

pub(crate) fn validate_candidate_projection(
	projection: &CandidateQualificationProjection,
	candidate_id: &str,
	models: &[ModelConfig],
	task_ids: &[String],
) -> Result<(), BenchmarkQualificationError> {
	if projection.schema_version != QUALIFICATION_PROJECTION_SCHEMA_VERSION
		|| projection.candidate_id != candidate_id
		|| projection.disposition != QualificationChildDisposition::Accepted
		|| projection.synthetic
		|| models != CANDIDATE_QUALIFICATION_MODEL_MATRIX
		|| task_ids.len() != REQUIRED_TASKS
		|| projection.cells.len() != REQUIRED_COMPLETED_CELLS
	{
		return Err(BenchmarkQualificationError::new(
			"candidate qualification projection is not accepted complete evidence",
		));
	}

	for (index, cell) in projection.cells.iter().enumerate() {
		validate_cell(cell, index, task_ids, candidate_id)?;
	}

	Ok(())
}

/// Applies the exact qualification protocol to one replay-verified child stage.
pub fn qualify_candidate(
	manifest: &BenchmarkQualificationManifest,
	expected_manifest_digest: &str,
	catalog: &CandidateCatalogAuthority,
	stage: &CalibrationVerifiedStageV1,
	attestation: &CalibrationVerifierAttestationV1,
) -> Result<BenchmarkQualificationArtifact, BenchmarkQualificationError> {
	if !valid_digest(expected_manifest_digest)
		|| canonical_hash(manifest, "qualification manifest")? != expected_manifest_digest
	{
		return Err(BenchmarkQualificationError::new(
			"qualification manifest does not match the independently expected predeclaration digest",
		));
	}

	let matrix = derive_verified_matrix(manifest, catalog, stage, attestation)?;

	qualify_derived_matrix(manifest, catalog, &matrix)
}

/// Recomputes the complete qualification and requires byte-semantic artifact equality.
pub fn verify_qualification_artifact(
	artifact: &BenchmarkQualificationArtifact,
	manifest: &BenchmarkQualificationManifest,
	expected_manifest_digest: &str,
	catalog: &CandidateCatalogAuthority,
	stage: &CalibrationVerifiedStageV1,
	attestation: &CalibrationVerifierAttestationV1,
) -> Result<(), BenchmarkQualificationError> {
	if artifact.schema_version != QUALIFICATION_ARTIFACT_SCHEMA_VERSION {
		return Err(BenchmarkQualificationError::new(
			"qualification artifact uses an unsupported schema version",
		));
	}
	if canonical_hash(&artifact.claims, "qualification claims")? != artifact.claims_digest {
		return Err(BenchmarkQualificationError::new(
			"qualification artifact claims digest does not match",
		));
	}

	let expected =
		qualify_candidate(manifest, expected_manifest_digest, catalog, stage, attestation)?;

	if artifact != &expected {
		return Err(BenchmarkQualificationError::new(
			"qualification artifact does not equal deterministic recomputation",
		));
	}

	Ok(())
}

fn qualify_derived_matrix(
	manifest: &BenchmarkQualificationManifest,
	catalog: &CandidateCatalogAuthority,
	matrix: &QualificationMatrix,
) -> Result<BenchmarkQualificationArtifact, BenchmarkQualificationError> {
	validate_manifest(manifest, catalog)?;

	let task_ids = catalog.tasks.iter().map(|task| task.task_id.clone()).collect::<Vec<_>>();
	let evidence = validate_matrix(&manifest.child, matrix, &manifest.candidate, &task_ids)?;
	let claims = BenchmarkQualificationClaims {
		status: BenchmarkQualificationStatus::Qualified,
		candidate: manifest.candidate.clone(),
		policy: manifest.policy.clone(),
		policy_digest: canonical_hash(&manifest.policy, "qualification policy")?,
		manifest_digest: canonical_hash(manifest, "qualification manifest")?,
		method_version: QUALIFICATION_METHOD_VERSION.to_owned(),
		scope: QualificationClaimScope::default(),
		child: child_binding(&evidence),
		task_count: catalog.tasks.len(),
		models: CANDIDATE_QUALIFICATION_MODEL_MATRIX,
		completed_cells: matrix.cells.len(),
	};
	let claims_digest = canonical_hash(&claims, "qualification claims")?;

	Ok(BenchmarkQualificationArtifact {
		schema_version: QUALIFICATION_ARTIFACT_SCHEMA_VERSION.to_owned(),
		claims_digest,
		claims,
	})
}

#[cfg(test)]
fn verify_derived_qualification_artifact(
	artifact: &BenchmarkQualificationArtifact,
	manifest: &BenchmarkQualificationManifest,
	catalog: &CandidateCatalogAuthority,
	matrix: &QualificationMatrix,
) -> Result<(), BenchmarkQualificationError> {
	if artifact.schema_version != QUALIFICATION_ARTIFACT_SCHEMA_VERSION
		|| canonical_hash(&artifact.claims, "qualification claims")? != artifact.claims_digest
	{
		return Err(BenchmarkQualificationError::new("qualification artifact identity is invalid"));
	}
	if artifact != &qualify_derived_matrix(manifest, catalog, matrix)? {
		return Err(BenchmarkQualificationError::new(
			"qualification artifact does not equal deterministic recomputation",
		));
	}

	Ok(())
}

fn derive_verified_matrix(
	manifest: &BenchmarkQualificationManifest,
	catalog: &CandidateCatalogAuthority,
	stage: &CalibrationVerifiedStageV1,
	attestation: &CalibrationVerifierAttestationV1,
) -> Result<QualificationMatrix, BenchmarkQualificationError> {
	validate_manifest(manifest, catalog)?;

	stage.verify_candidate_qualification().map_err(|error| {
		BenchmarkQualificationError::new(format!(
			"qualification child {} stage is not accepted candidate evidence: {error}",
			manifest.child.child_id
		))
	})?;
	attestation.verify_candidate_qualification(stage, &manifest.child.verifier).map_err(
		|error| {
			BenchmarkQualificationError::new(format!(
				"qualification child {} attestation is not trusted: {error}",
				manifest.child.child_id
			))
		},
	)?;

	validate_stage_candidate_identity(stage, &manifest.candidate, catalog)?;

	let expected_task_ids =
		catalog.tasks.iter().map(|task| task.task_id.clone()).collect::<Vec<_>>();
	let projection = stage.qualification_projection.as_ref().ok_or_else(|| {
		BenchmarkQualificationError::new(format!(
			"qualification child {} has no verifier-derived projection",
			manifest.child.child_id
		))
	})?;

	if stage.run_id != manifest.child.source_run_id
		|| projection.schema_version != QUALIFICATION_PROJECTION_SCHEMA_VERSION
		|| projection.candidate_id != manifest.candidate.candidate_id
		|| projection.disposition != QualificationChildDisposition::Accepted
		|| projection.synthetic
		|| stage.models != CANDIDATE_QUALIFICATION_MODEL_MATRIX
		|| stage.task_ids != expected_task_ids
	{
		return Err(BenchmarkQualificationError::new(format!(
			"qualification child {} has swapped, rejected, synthetic, or drifted evidence",
			manifest.child.child_id
		)));
	}

	Ok(QualificationMatrix {
		schema_version: QUALIFICATION_MATRIX_SCHEMA_VERSION.to_owned(),
		child_id: manifest.child.child_id.clone(),
		source_run_id: stage.run_id.clone(),
		source_run_digest: stage.stage_digest.clone(),
		source_package_sha256: stage.package_sha256.clone(),
		source_package_content_hash: stage.content_hash.clone(),
		runner: stage.runner.clone(),
		verifier: attestation.verifier.clone(),
		verifier_attestation_digest: canonical_hash(attestation, "verifier attestation")?,
		run_provenance_digest: canonical_hash(&stage.provenance, "run provenance")?,
		disposition: projection.disposition,
		rejection_digest: None,
		synthetic: projection.synthetic,
		candidate: manifest.candidate.clone(),
		models: stage.models.clone(),
		task_ids: stage.task_ids.clone(),
		cells: projection.cells.clone(),
	})
}

fn validate_stage_candidate_identity(
	stage: &CalibrationVerifiedStageV1,
	identity: &QualificationCandidateIdentity,
	catalog: &CandidateCatalogAuthority,
) -> Result<(), BenchmarkQualificationError> {
	let provenance = &stage.provenance;

	if identity.candidate_id != catalog.candidate_id
		|| identity.catalog_digest != catalog.catalog_digest
		|| identity.task_metadata_digest != catalog.task_metadata_digest
		|| provenance.run_class != RunClass::Calibration
		|| provenance.corpus_release_id != identity.corpus_release_id
		|| provenance.corpus_commitment_sha256 != identity.corpus_commitment_digest
		|| provenance.catalog_digest != identity.task_metadata_digest
		|| provenance.task_set_digest != identity.task_set_digest
		|| stage.task_set_hash != identity.task_set_digest
		|| provenance.evaluator_digest != identity.evaluator_digest
		|| provenance.harness_digest != identity.harness_digest
		|| provenance.prompt_digest != identity.prompt_digest
		|| provenance.tool_policy_digest != identity.tool_policy_digest
		|| provenance.network_policy_digest != identity.network_policy_digest
		|| provenance.environment_digest != identity.environment_digest
		|| provenance.source_manifest_digest != identity.source_manifest_digest
		|| stage.model_selection_digest != identity.model_selection_digest
		|| stage.task_set_id != AIQ_TASK_SET_ID
		|| stage.task_set_version != CANDIDATE_TASK_SET_VERSION
		|| stage.benchmark_version != format!("{}@{}", AIQ_TASK_SET_ID, CANDIDATE_TASK_SET_VERSION)
		|| stage.scoring_version != AIQ_SCORING_VERSION
	{
		return Err(BenchmarkQualificationError::new(
			"qualification stage does not bind the exact candidate identity",
		));
	}

	Ok(())
}

fn validate_manifest(
	manifest: &BenchmarkQualificationManifest,
	catalog: &CandidateCatalogAuthority,
) -> Result<(), BenchmarkQualificationError> {
	if manifest.schema_version != QUALIFICATION_MANIFEST_SCHEMA_VERSION {
		return Err(BenchmarkQualificationError::new(
			"qualification manifest uses an unsupported schema version",
		));
	}
	if manifest.policy != BenchmarkQualificationPolicy::default() {
		return Err(BenchmarkQualificationError::new(
			"qualification manifest changes or uses an unsupported policy",
		));
	}

	validate_candidate_identity(&manifest.candidate)?;

	if catalog.status != CandidateCatalogStatus::FrozenCandidate
		|| catalog.require_frozen_candidate().is_err()
		|| manifest.candidate.candidate_id != catalog.candidate_id
		|| manifest.candidate.catalog_digest != catalog.catalog_digest
		|| manifest.candidate.task_metadata_digest != catalog.task_metadata_digest
	{
		return Err(BenchmarkQualificationError::new(
			"qualification manifest does not bind a qualification-ready exact catalog",
		));
	}
	if !valid_token(&manifest.child.child_id, 128)
		|| !valid_token(&manifest.child.source_run_id, 256)
		|| !valid_node(&manifest.child.verifier)
	{
		return Err(BenchmarkQualificationError::new("qualification child declaration is invalid"));
	}

	Ok(())
}

fn validate_candidate_identity(
	identity: &QualificationCandidateIdentity,
) -> Result<(), BenchmarkQualificationError> {
	if !valid_token(&identity.candidate_id, 128)
		|| !valid_token(&identity.corpus_release_id, 128)
		|| [
			&identity.catalog_digest,
			&identity.task_metadata_digest,
			&identity.task_set_digest,
			&identity.corpus_commitment_digest,
			&identity.evaluator_digest,
			&identity.harness_digest,
			&identity.prompt_digest,
			&identity.tool_policy_digest,
			&identity.network_policy_digest,
			&identity.environment_digest,
			&identity.source_manifest_digest,
			&identity.model_selection_digest,
		]
		.into_iter()
		.any(|digest| !valid_digest(digest))
	{
		return Err(BenchmarkQualificationError::new(
			"qualification candidate identity is invalid",
		));
	}

	let expected_model_selection =
		canonical_hash(&CANDIDATE_QUALIFICATION_MODEL_MATRIX, "model selection")?;

	if identity.model_selection_digest != expected_model_selection {
		return Err(BenchmarkQualificationError::new(
			"candidate model-selection identity does not match the exact three configurations",
		));
	}

	Ok(())
}

fn validate_matrix<'a>(
	declaration: &PredeclaredQualificationChild,
	matrix: &'a QualificationMatrix,
	candidate: &QualificationCandidateIdentity,
	expected_task_ids: &[String],
) -> Result<ValidatedMatrix<'a>, BenchmarkQualificationError> {
	if matrix.schema_version != QUALIFICATION_MATRIX_SCHEMA_VERSION {
		return Err(BenchmarkQualificationError::new(
			"qualification child uses an unsupported matrix schema",
		));
	}
	if matrix.child_id != declaration.child_id
		|| matrix.source_run_id != declaration.source_run_id
		|| matrix.verifier != declaration.verifier
		|| matrix.runner == matrix.verifier
		|| &matrix.candidate != candidate
		|| matrix.models != CANDIDATE_QUALIFICATION_MODEL_MATRIX
		|| matrix.task_ids != expected_task_ids
		|| matrix.synthetic
		|| !valid_plain_digest(&matrix.source_package_sha256)
		|| !valid_digest(&matrix.source_package_content_hash)
		|| !valid_digest(&matrix.source_run_digest)
		|| !valid_digest(&matrix.verifier_attestation_digest)
		|| !valid_digest(&matrix.run_provenance_digest)
		|| !valid_node(&matrix.runner)
		|| !valid_node(&matrix.verifier)
	{
		return Err(BenchmarkQualificationError::new(format!(
			"qualification child {} has swapped, synthetic, or drifted identity",
			declaration.child_id
		)));
	}

	match (matrix.disposition, matrix.rejection_digest.as_deref()) {
		(QualificationChildDisposition::Accepted, None) => {},
		(QualificationChildDisposition::Rejected, Some(digest)) if valid_digest(digest) => {
			return Err(BenchmarkQualificationError::new(format!(
				"qualification child {} was already rejected",
				declaration.child_id
			)));
		},
		_ => {
			return Err(BenchmarkQualificationError::new(format!(
				"qualification child {} has an invalid disposition",
				declaration.child_id
			)));
		},
	}

	let expected_cells = CANDIDATE_QUALIFICATION_MODEL_MATRIX
		.len()
		.checked_mul(expected_task_ids.len())
		.ok_or_else(|| {
			BenchmarkQualificationError::new("qualification cell cardinality overflows")
		})?;

	if matrix.cells.len() != expected_cells || matrix.cells.len() != REQUIRED_COMPLETED_CELLS {
		return Err(BenchmarkQualificationError::new(format!(
			"qualification child {} is not a complete 216-cell matrix",
			declaration.child_id
		)));
	}

	for (cell_index, cell) in matrix.cells.iter().enumerate() {
		validate_cell(cell, cell_index, expected_task_ids, declaration.child_id.as_str())?;
	}

	let digest = canonical_hash(matrix, "qualification child matrix")?;

	Ok(ValidatedMatrix { matrix, digest })
}

fn validate_cell(
	cell: &QualificationCell,
	index: usize,
	task_ids: &[String],
	child_id: &str,
) -> Result<(), BenchmarkQualificationError> {
	let task_count = task_ids.len();
	let expected_model = CANDIDATE_QUALIFICATION_MODEL_MATRIX[index / task_count];
	let expected_task = &task_ids[index % task_count];
	let Some(score) = cell.semantic_score else {
		return Err(BenchmarkQualificationError::new(format!(
			"qualification child {child_id} contains a missing or runtime-invalid cell"
		)));
	};

	if cell.status != QualificationCellStatus::Completed
		|| cell.model != expected_model
		|| &cell.task_id != expected_task
		|| !score.is_finite()
		|| !(0.0..=1.0).contains(&score)
	{
		return Err(BenchmarkQualificationError::new(format!(
			"qualification child {child_id} contains a duplicate, reordered, or invalid cell"
		)));
	}

	Ok(())
}

fn child_binding(evidence: &ValidatedMatrix<'_>) -> QualificationChildBinding {
	QualificationChildBinding {
		child_id: evidence.matrix.child_id.clone(),
		source_run_id: evidence.matrix.source_run_id.clone(),
		source_run_digest: evidence.matrix.source_run_digest.clone(),
		source_package_sha256: evidence.matrix.source_package_sha256.clone(),
		source_package_content_hash: evidence.matrix.source_package_content_hash.clone(),
		runner: evidence.matrix.runner.clone(),
		verifier: evidence.matrix.verifier.clone(),
		verifier_attestation_digest: evidence.matrix.verifier_attestation_digest.clone(),
		run_provenance_digest: evidence.matrix.run_provenance_digest.clone(),
		matrix_digest: evidence.digest.clone(),
	}
}

fn canonical_hash(
	value: &impl Serialize,
	label: &str,
) -> Result<String, BenchmarkQualificationError> {
	protocol::canonical_hash(value)
		.map_err(|error| BenchmarkQualificationError::new(format!("cannot hash {label}: {error}")))
}

fn valid_token(value: &str, maximum: usize) -> bool {
	(1..=maximum).contains(&value.len())
		&& value.bytes().all(|byte| {
			byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b'/' | b':')
		})
}

fn valid_digest(value: &str) -> bool {
	value.len() == 71
		&& value.starts_with("sha256:")
		&& value[7..].bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn valid_plain_digest(value: &str) -> bool {
	value.len() == 64
		&& value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_node(node: &NodeIdentity) -> bool {
	let Ok(public) = hex::decode(&node.public_key) else { return false };

	public.len() == 32
		&& valid_plain_digest(&node.public_key)
		&& node.node_id == format!("node_{}", hex::encode(Sha256::digest(public)))
}

#[cfg(test)]
mod tests {
	use serde_json::Value;

	use crate::{
		benchmark_qualification::{
			self, BenchmarkQualificationManifest, BenchmarkQualificationStatus,
			CANDIDATE_QUALIFICATION_MODEL_MATRIX, PredeclaredQualificationChild,
			QualificationCandidateIdentity, QualificationCell, QualificationCellStatus,
			QualificationChildDisposition, QualificationMatrix,
		},
		candidate_catalog, protocol, runner,
	};

	fn digest(character: char) -> String {
		format!("sha256:{}", character.to_string().repeat(64))
	}

	fn fixture() -> (
		candidate_catalog::CandidateCatalogAuthority,
		BenchmarkQualificationManifest,
		QualificationMatrix,
	) {
		let catalog = candidate_catalog::checked_candidate_catalog_authority()
			.expect("checked candidate catalog");
		let candidate = QualificationCandidateIdentity {
			candidate_id: catalog.candidate_id.clone(),
			catalog_digest: catalog.catalog_digest.clone(),
			task_metadata_digest: catalog.task_metadata_digest.clone(),
			task_set_digest: digest('1'),
			corpus_release_id: "corpus_candidate_qualification_fixture".to_owned(),
			corpus_commitment_digest: digest('2'),
			evaluator_digest: digest('3'),
			harness_digest: digest('4'),
			prompt_digest: digest('5'),
			tool_policy_digest: digest('6'),
			network_policy_digest: digest('7'),
			environment_digest: digest('8'),
			source_manifest_digest: digest('9'),
			model_selection_digest: protocol::canonical_hash(&CANDIDATE_QUALIFICATION_MODEL_MATRIX)
				.expect("models"),
		};
		let child = PredeclaredQualificationChild {
			child_id: "candidate-child-1".to_owned(),
			source_run_id: "run-1".to_owned(),
			verifier: protocol::SigningIdentity::from_secret([10; 32]).node().clone(),
		};
		let manifest = BenchmarkQualificationManifest {
			schema_version: benchmark_qualification::QUALIFICATION_MANIFEST_SCHEMA_VERSION
				.to_owned(),
			candidate: candidate.clone(),
			policy: benchmark_qualification::BenchmarkQualificationPolicy::default(),
			child: child.clone(),
		};
		let task_ids = catalog.tasks.iter().map(|task| task.task_id.clone()).collect::<Vec<_>>();
		let cells = CANDIDATE_QUALIFICATION_MODEL_MATRIX
			.iter()
			.enumerate()
			.flat_map(|(model_index, model)| {
				task_ids.iter().enumerate().map(move |(task_index, task_id)| QualificationCell {
					task_id: task_id.clone(),
					model: *model,
					status: QualificationCellStatus::Completed,
					semantic_score: Some(
						0.2 + model_index as f64 * 0.2 + (task_index % 5) as f64 * 0.01,
					),
				})
			})
			.collect();
		let matrix = QualificationMatrix {
			schema_version: benchmark_qualification::QUALIFICATION_MATRIX_SCHEMA_VERSION.to_owned(),
			child_id: child.child_id.clone(),
			source_run_id: child.source_run_id.clone(),
			source_run_digest: digest('a'),
			source_package_sha256: "7".repeat(64),
			source_package_content_hash: digest('d'),
			runner: protocol::SigningIdentity::from_secret([30; 32]).node().clone(),
			verifier: child.verifier,
			verifier_attestation_digest: digest('b'),
			run_provenance_digest: digest('c'),
			disposition: QualificationChildDisposition::Accepted,
			rejection_digest: None,
			synthetic: false,
			candidate,
			models: CANDIDATE_QUALIFICATION_MODEL_MATRIX.to_vec(),
			task_ids,
			cells,
		};

		(catalog, manifest, matrix)
	}

	#[test]
	fn one_complete_family_representative_matrix_qualifies_without_stability_claims() {
		let (catalog, manifest, matrix) = fixture();
		let first = benchmark_qualification::qualify_derived_matrix(&manifest, &catalog, &matrix)
			.expect("qualification");
		let second = benchmark_qualification::qualify_derived_matrix(&manifest, &catalog, &matrix)
			.expect("qualification again");

		assert_eq!(first, second);
		assert_eq!(first.claims.status, BenchmarkQualificationStatus::Qualified);
		assert_eq!(first.claims.task_count, 72);
		assert_eq!(first.claims.models, CANDIDATE_QUALIFICATION_MODEL_MATRIX);
		assert_eq!(first.claims.completed_cells, 216);
		assert_eq!(first.claims.scope.proves, benchmark_qualification::QUALIFICATION_PROVES);
		assert_eq!(
			first.claims.scope.excludes,
			benchmark_qualification::QUALIFICATION_EXCLUDED_CLAIMS.map(str::to_owned)
		);

		let claims = serde_json::to_value(&first.claims).expect("claims JSON");
		let claims = claims.as_object().expect("claims object");

		for stale in [
			"matrices",
			"pairwise",
			"median_configuration_rank_spearman",
			"configurations",
			"comparison_group_method",
			"comparison_groups",
			"violations",
		] {
			assert!(!claims.contains_key(stale), "stale claim field {stale}");
		}

		benchmark_qualification::verify_derived_qualification_artifact(
			&first, &manifest, &catalog, &matrix,
		)
		.expect("verification");
	}

	#[test]
	fn verifier_projection_is_exactly_three_by_seventy_two_and_complete_only() {
		let tasks = runner::synthetic_demo_tasks();
		let slot = crate::schedule::ScheduleConfig::default()
			.slot("2026-08-30", crate::schedule::ScheduleOccurrence::Day)
			.expect("fixture slot");
		let run = runner::synthetic_demo(slot, &crate::runner::TestArtifactSink)
			.expect("synthetic matrix");
		let task_ids = tasks.iter().map(|task| task.task_id.clone()).collect::<Vec<_>>();
		let results = run
			.results
			.into_iter()
			.filter(|result| CANDIDATE_QUALIFICATION_MODEL_MATRIX.contains(&result.model))
			.collect::<Vec<_>>();
		let projection = benchmark_qualification::candidate_projection_from_replayed_results(
			candidate_catalog::CANDIDATE_ID,
			&CANDIDATE_QUALIFICATION_MODEL_MATRIX,
			&task_ids,
			&results,
		)
		.expect("complete verifier projection");

		assert_eq!(projection.cells.len(), 216);

		for (cell, result) in projection.cells.iter().zip(&results) {
			assert_eq!(cell.task_id, result.task_id);
			assert_eq!(cell.model, result.model);
			assert_eq!(cell.semantic_score, result.task_score);
		}

		let mut invalid = results;

		invalid[0].status = crate::runner::ResultStatus::Failed;

		assert!(
			benchmark_qualification::candidate_projection_from_replayed_results(
				candidate_catalog::CANDIDATE_ID,
				&CANDIDATE_QUALIFICATION_MODEL_MATRIX,
				&task_ids,
				&invalid,
			)
			.is_err()
		);
	}

	#[test]
	fn structural_matrix_rejections_fail_closed() {
		let (catalog, manifest, matrix) = fixture();

		for mutation in 0..7 {
			let mut changed = matrix.clone();

			match mutation {
				0 => {
					changed.cells.pop();
				},
				1 => changed.cells[1].task_id = changed.cells[0].task_id.clone(),
				2 => {
					changed.cells[0].status = QualificationCellStatus::RuntimeInvalid;
					changed.cells[0].semantic_score = None;
				},
				3 => changed.synthetic = true,
				4 => changed.candidate.harness_digest = digest('0'),
				5 => changed.models.swap(0, 1),
				_ => {
					changed.disposition = QualificationChildDisposition::Rejected;
					changed.rejection_digest = Some(digest('0'));
				},
			}

			assert!(
				benchmark_qualification::qualify_derived_matrix(&manifest, &catalog, &changed)
					.is_err(),
				"mutation {mutation} must fail"
			);
		}
	}

	#[test]
	fn stale_candidate_policy_and_schema_identities_reject() {
		let (catalog, manifest, matrix) = fixture();
		let mut changed = manifest.clone();

		changed.policy.required_completed_cells = 215;

		assert!(
			benchmark_qualification::qualify_derived_matrix(&changed, &catalog, &matrix).is_err()
		);

		let mut changed = manifest.clone();

		changed.policy.version = "aiq.benchmark-qualification-policy.v1".to_owned();

		assert!(
			benchmark_qualification::qualify_derived_matrix(&changed, &catalog, &matrix).is_err()
		);

		let mut changed = manifest.clone();

		changed.schema_version = "aiq.benchmark-qualification-manifest.v2".to_owned();

		assert!(
			benchmark_qualification::qualify_derived_matrix(&changed, &catalog, &matrix).is_err()
		);

		let mut changed = manifest;

		changed.candidate.candidate_id = "aiq-core/1.1.0-candidate.13".to_owned();

		assert!(
			benchmark_qualification::qualify_derived_matrix(&changed, &catalog, &matrix).is_err()
		);
	}

	#[test]
	fn every_candidate_identity_component_must_match_the_child() {
		let (catalog, manifest, matrix) = fixture();

		for mutation in 0..14 {
			let mut changed = matrix.clone();

			match mutation {
				0 => changed.candidate.catalog_digest = digest('0'),
				1 => changed.candidate.task_metadata_digest = digest('0'),
				2 => changed.candidate.task_set_digest = digest('0'),
				3 => changed.candidate.corpus_release_id = "other-candidate".to_owned(),
				4 => changed.candidate.corpus_commitment_digest = digest('0'),
				5 => changed.candidate.evaluator_digest = digest('0'),
				6 => changed.candidate.harness_digest = digest('0'),
				7 => changed.candidate.prompt_digest = digest('0'),
				8 => changed.candidate.tool_policy_digest = digest('0'),
				9 => changed.candidate.network_policy_digest = digest('0'),
				10 => changed.candidate.environment_digest = digest('0'),
				11 => changed.candidate.source_manifest_digest = digest('0'),
				12 => changed.candidate.model_selection_digest = digest('0'),
				_ => changed.candidate.candidate_id = "other-candidate".to_owned(),
			}

			assert!(
				benchmark_qualification::qualify_derived_matrix(&manifest, &catalog, &changed)
					.is_err(),
				"identity mutation {mutation} must fail"
			);
		}
	}

	#[test]
	fn old_stability_fields_and_artifact_versions_fail() {
		let (catalog, manifest, matrix) = fixture();
		let artifact =
			benchmark_qualification::qualify_derived_matrix(&manifest, &catalog, &matrix)
				.expect("artifact");
		let mut wire = serde_json::to_value(&artifact).expect("artifact JSON");

		wire["claims"]["pairwise"] = Value::Array(Vec::new());

		assert!(
			serde_json::from_value::<benchmark_qualification::BenchmarkQualificationArtifact>(wire)
				.is_err()
		);

		let mut changed = artifact.clone();

		changed.claims.completed_cells = 215;
		changed.claims_digest = protocol::canonical_hash(&changed.claims).expect("changed digest");

		assert!(
			benchmark_qualification::verify_derived_qualification_artifact(
				&changed, &manifest, &catalog, &matrix,
			)
			.is_err()
		);

		let mut changed = artifact;

		changed.schema_version = "aiq.benchmark-qualification.v2".to_owned();

		assert!(
			benchmark_qualification::verify_derived_qualification_artifact(
				&changed, &manifest, &catalog, &matrix,
			)
			.is_err()
		);
	}
}
