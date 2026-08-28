//! Deterministic three-matrix qualification shared by the runner and verifier.

use std::{
	collections::{BTreeMap, BTreeSet},
	error::Error,
	fmt::{Display, Formatter},
};

use serde::{Deserialize, Serialize};

use crate::candidate_catalog::CandidateTaskAuthority;
use crate::{
	candidate_catalog::{CandidateCatalogAuthority, CandidateCatalogStatus},
	model::{MODEL_MATRIX, ModelConfig},
	protocol,
	task::Domain,
};

/// Predeclared qualification-manifest schema.
pub const QUALIFICATION_MANIFEST_SCHEMA_VERSION: &str = "aiq.benchmark-qualification-manifest.v1";
/// One independently identified child-matrix schema.
pub const QUALIFICATION_MATRIX_SCHEMA_VERSION: &str = "aiq.benchmark-qualification-matrix.v1";
/// Deterministic qualification artifact schema.
pub const QUALIFICATION_ARTIFACT_SCHEMA_VERSION: &str = "aiq.benchmark-qualification.v1";
/// Exact hard-policy identity.
pub const QUALIFICATION_POLICY_VERSION: &str = "aiq.benchmark-qualification-policy.v1";
/// Exact analysis method identity.
pub const QUALIFICATION_METHOD_VERSION: &str = "aiq.three-complete-matrix-qualification.v1";
/// Separate run-to-run prediction-interval method.
pub const PREDICTION_INTERVAL_METHOD: &str = "student_t_future_single_run_n3_95_v1";
/// Deterministic uncertainty-aware comparison grouping method.
pub const COMPARISON_GROUP_METHOD: &str = "prediction_interval_overlap_components_v1";

const PUBLICATION_UNIT: &str = "one_complete_1224_cell_matrix";
const COMPARISON_TOLERANCE: f64 = 1e-12;
const T_975_DF_2: f64 = 4.302_652_729_911_275;

/// Exact benchmark-qualification policy.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BenchmarkQualificationPolicy {
	/// Stable policy identity.
	pub version: String,
	/// Required independently identified matrices.
	pub required_matrices: usize,
	/// Required tasks in each matrix.
	pub required_tasks: usize,
	/// Required task domains.
	pub required_domains: usize,
	/// Required model configurations.
	pub required_model_configurations: usize,
	/// Minimum distinct bootstrap clusters.
	pub minimum_clusters: usize,
	/// Maximum tasks in one cluster.
	pub maximum_tasks_per_cluster: usize,
	/// Inclusive informative-facility lower bound.
	pub informative_facility_min: f64,
	/// Inclusive informative-facility upper bound.
	pub informative_facility_max: f64,
	/// Minimum across-configuration task-score range.
	pub informative_task_range_min: f64,
	/// Minimum informative tasks in each matrix.
	pub minimum_informative_tasks: usize,
	/// Minimum informative tasks in every domain.
	pub minimum_domain_informative_tasks: usize,
	/// Minimum non-uniform tasks in every domain.
	pub minimum_domain_non_uniform_tasks: usize,
	/// Maximum universal semantic-zero tasks in each matrix.
	pub maximum_universal_semantic_zero_tasks: usize,
	/// Maximum universal full-credit tasks in each matrix.
	pub maximum_universal_full_credit_tasks: usize,
	/// Minimum median of the three pairwise Spearman values.
	pub minimum_median_rank_spearman: f64,
	/// Maximum configuration mean movement between any matrix pair, in AIQ points.
	pub maximum_configuration_mean_shift: f64,
}
impl Default for BenchmarkQualificationPolicy {
	fn default() -> Self {
		Self {
			version: QUALIFICATION_POLICY_VERSION.to_owned(),
			required_matrices: 3,
			required_tasks: 72,
			required_domains: 10,
			required_model_configurations: MODEL_MATRIX.len(),
			minimum_clusters: 60,
			maximum_tasks_per_cluster: 2,
			informative_facility_min: 0.10,
			informative_facility_max: 0.90,
			informative_task_range_min: 0.10,
			minimum_informative_tasks: 48,
			minimum_domain_informative_tasks: 3,
			minimum_domain_non_uniform_tasks: 4,
			maximum_universal_semantic_zero_tasks: 3,
			maximum_universal_full_credit_tasks: 3,
			minimum_median_rank_spearman: 0.70,
			maximum_configuration_mean_shift: 5.0,
		}
	}
}

/// All exact identities that must remain equal across the three matrices.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct QualificationCandidateIdentity {
	/// New candidate identity. It must change after a failed candidate is revised.
	pub candidate_id: String,
	/// Complete public candidate catalog digest.
	pub catalog_digest: String,
	/// Complete private task-set digest.
	pub task_set_digest: String,
	/// Controlled corpus release identifier.
	pub corpus_release_id: String,
	/// Complete corpus commitment digest.
	pub corpus_commitment_digest: String,
	/// Selected evaluator identity.
	pub evaluator_digest: String,
	/// Runtime identity.
	pub runtime_digest: String,
	/// Exact model-visible toolchain identity.
	pub toolchain_digest: String,
	/// Source-manifest identity.
	pub source_manifest_digest: String,
	/// Exact ordered model-selection identity.
	pub model_selection_digest: String,
}

/// One child identity declared before qualification reads matrix cells.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PredeclaredQualificationChild {
	/// Stable child identity.
	pub child_id: String,
	/// Exact source run identity expected for this child.
	pub source_run_id: String,
	/// Exact canonical digest of the completed source run.
	pub source_run_digest: String,
	/// Exact verifier-attestation digest for the completed source run.
	pub verifier_attestation_digest: String,
}

/// Predeclared candidate and three-child contract.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BenchmarkQualificationManifest {
	/// Manifest schema.
	pub schema_version: String,
	/// Exact candidate identity.
	pub candidate: QualificationCandidateIdentity,
	/// Exact immutable policy. Changed thresholds are unsupported.
	pub policy: BenchmarkQualificationPolicy,
	/// Exactly three unique children in deterministic analysis order.
	pub children: Vec<PredeclaredQualificationChild>,
}

/// One exact task-model cell in a qualification child.
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

/// One complete independently identified qualification matrix.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct QualificationMatrix {
	/// Matrix schema.
	pub schema_version: String,
	/// Predeclared child identity.
	pub child_id: String,
	/// Exact originating run identity.
	pub source_run_id: String,
	/// Canonical digest of the complete originating run.
	pub source_run_digest: String,
	/// Digest of the independent verifier evidence for the originating run.
	pub verifier_attestation_digest: String,
	/// Whether upstream verification accepted or rejected this child.
	pub disposition: QualificationChildDisposition,
	/// Exact rejection evidence when the child was rejected.
	pub rejection_digest: Option<String>,
	/// Synthetic matrices are never qualification inputs.
	pub synthetic: bool,
	/// Exact candidate identities repeated in every child.
	pub candidate: QualificationCandidateIdentity,
	/// Exact ordered 17-configuration selection.
	pub models: Vec<ModelConfig>,
	/// Exact ordered 72-task selection.
	pub task_ids: Vec<String>,
	/// Model-major, then task-major complete semantic cells.
	pub cells: Vec<QualificationCell>,
}

/// Exact child identity bound by the qualification artifact.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct QualificationChildBinding {
	/// Predeclared child identity.
	pub child_id: String,
	/// Exact source run identity.
	pub source_run_id: String,
	/// Exact source run digest.
	pub source_run_digest: String,
	/// Exact independent verifier evidence digest.
	pub verifier_attestation_digest: String,
	/// Canonical digest of the complete supplied matrix.
	pub matrix_digest: String,
}

/// One domain's qualification diagnostics for one matrix.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct QualificationDomainDiagnostic {
	/// Stable domain.
	pub domain: Domain,
	/// Tasks in this domain.
	pub tasks: usize,
	/// Informative tasks in this domain.
	pub informative_tasks: usize,
	/// Non-uniform tasks in this domain.
	pub non_uniform_tasks: usize,
}

/// One configuration's 0--100 equal-domain mean in one child matrix.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ConfigurationMeanScore {
	/// Exact configuration.
	pub model: ModelConfig,
	/// Equal-domain mean semantic score in AIQ points.
	pub mean_score: f64,
}

/// Policy diagnostics for one complete child matrix.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct QualificationMatrixDiagnostic {
	/// Predeclared child identity.
	pub child_id: String,
	/// Exact completed semantic cells.
	pub semantic_cells: usize,
	/// Informative tasks.
	pub informative_tasks: usize,
	/// Universal semantic-zero tasks.
	pub universal_semantic_zero_tasks: usize,
	/// Universal full-credit tasks.
	pub universal_full_credit_tasks: usize,
	/// Per-domain evidence.
	pub domains: Vec<QualificationDomainDiagnostic>,
	/// Per-configuration equal-domain means.
	pub configuration_means: Vec<ConfigurationMeanScore>,
}

/// Pairwise run-to-run diagnostics. Agreement diagnostics are not gates.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct QualificationPairwiseDiagnostic {
	/// First child in manifest order.
	pub first_child_id: String,
	/// Second child in manifest order.
	pub second_child_id: String,
	/// Spearman correlation of the 17 configuration mean-score ranks.
	pub configuration_rank_spearman: f64,
	/// Cells with exactly equal semantic scores.
	pub exact_cell_agreement_count: usize,
	/// Exact-cell agreement fraction. This is diagnostic only.
	pub exact_cell_agreement_rate: f64,
	/// Mean absolute semantic cell delta. This is diagnostic only.
	pub mean_absolute_cell_delta: f64,
	/// Largest equal-domain configuration mean movement in AIQ points.
	pub maximum_configuration_mean_shift: f64,
}

/// Separate run-to-run prediction interval for one configuration.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RunToRunPredictionInterval {
	/// Versioned deterministic method.
	pub method: String,
	/// Interval level.
	pub level: f64,
	/// Independent complete matrices used.
	pub observations: usize,
	/// Mean of the three equal-domain configuration scores.
	pub mean: f64,
	/// Sample standard deviation across the three runs.
	pub sample_standard_deviation: f64,
	/// Lower prediction bound, clamped to 0--100.
	pub low: f64,
	/// Upper prediction bound, clamped to 0--100.
	pub high: f64,
}

/// One configuration's repeatability evidence across all three matrices.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct QualificationConfigurationSummary {
	/// Exact configuration.
	pub model: ModelConfig,
	/// Scores in manifest child order.
	pub child_mean_scores: Vec<f64>,
	/// Separate run-to-run prediction interval.
	pub run_to_run_prediction_interval: RunToRunPredictionInterval,
}

/// Uncertainty-aware group formed from overlapping prediction intervals.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct QualificationComparisonGroup {
	/// Deterministic group identity.
	pub group_id: String,
	/// Configurations in descending three-run mean order.
	pub models: Vec<ModelConfig>,
}

/// Canonical qualification claims covered by the artifact digest.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BenchmarkQualificationClaims {
	/// Qualified or rejected result.
	pub status: BenchmarkQualificationStatus,
	/// Exact candidate identities.
	pub candidate: QualificationCandidateIdentity,
	/// Exact applied policy.
	pub policy: BenchmarkQualificationPolicy,
	/// Canonical policy digest.
	pub policy_digest: String,
	/// Canonical predeclared manifest digest.
	pub manifest_digest: String,
	/// Exact analysis method.
	pub method_version: String,
	/// Qualification never pools or publishes child matrices.
	pub official_publication_unit: String,
	/// Exact child bindings.
	pub children: Vec<QualificationChildBinding>,
	/// Per-matrix policy evidence.
	pub matrices: Vec<QualificationMatrixDiagnostic>,
	/// All three pairwise diagnostics.
	pub pairwise: Vec<QualificationPairwiseDiagnostic>,
	/// Median of all three pairwise Spearman values.
	pub median_configuration_rank_spearman: f64,
	/// Per-configuration repeatability evidence.
	pub configurations: Vec<QualificationConfigurationSummary>,
	/// Prediction-interval overlap groups.
	pub comparison_group_method: String,
	/// Prediction-interval overlap groups.
	pub comparison_groups: Vec<QualificationComparisonGroup>,
	/// Deterministically ordered falsifiers. Empty only for a qualified candidate.
	pub violations: Vec<String>,
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

struct ValidatedMatrix<'a> {
	matrix: &'a QualificationMatrix,
	digest: String,
	scores: Vec<f64>,
}

/// Child verification disposition supplied to qualification.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum QualificationChildDisposition {
	/// The child is eligible for qualification analysis.
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
	/// Every structural and policy requirement passed.
	Qualified,
	/// Structurally valid observations falsified at least one policy threshold.
	Rejected,
}

/// Applies the exact qualification protocol to three structurally valid child matrices.
pub fn qualify_candidate(
	manifest: &BenchmarkQualificationManifest,
	catalog: &CandidateCatalogAuthority,
	matrices: &[QualificationMatrix],
) -> Result<BenchmarkQualificationArtifact, BenchmarkQualificationError> {
	validate_manifest(manifest, catalog)?;

	let matrix_evidence = validate_matrices(manifest, catalog, matrices)?;
	let diagnostics = matrix_evidence
		.iter()
		.map(|evidence| matrix_diagnostic(catalog, evidence, &manifest.policy))
		.collect::<Vec<_>>();
	let mut violations = static_shape_violations(catalog, &manifest.policy);

	for diagnostic in &diagnostics {
		violations.extend(matrix_policy_violations(diagnostic, &manifest.policy));
	}

	let pairwise = pairwise_diagnostics(&matrix_evidence, &diagnostics);

	for pair in &pairwise {
		if pair.maximum_configuration_mean_shift
			> manifest.policy.maximum_configuration_mean_shift + COMPARISON_TOLERANCE
		{
			violations.push(format!(
				"children {} and {} move one configuration mean by {:.6} AIQ points, above {:.6}",
				pair.first_child_id,
				pair.second_child_id,
				pair.maximum_configuration_mean_shift,
				manifest.policy.maximum_configuration_mean_shift
			));
		}
	}

	let median_configuration_rank_spearman = median_three([
		pairwise[0].configuration_rank_spearman,
		pairwise[1].configuration_rank_spearman,
		pairwise[2].configuration_rank_spearman,
	]);

	if median_configuration_rank_spearman + COMPARISON_TOLERANCE
		< manifest.policy.minimum_median_rank_spearman
	{
		violations.push(format!(
			"median configuration-rank Spearman {:.6} is below {:.6}",
			median_configuration_rank_spearman, manifest.policy.minimum_median_rank_spearman
		));
	}

	let configurations = configuration_summaries(&diagnostics);
	let comparison_groups = comparison_groups(&configurations);
	let children = child_bindings(&matrix_evidence);
	let status = if violations.is_empty() {
		BenchmarkQualificationStatus::Qualified
	} else {
		BenchmarkQualificationStatus::Rejected
	};
	let claims = BenchmarkQualificationClaims {
		status,
		candidate: manifest.candidate.clone(),
		policy: manifest.policy.clone(),
		policy_digest: canonical_hash(&manifest.policy, "qualification policy")?,
		manifest_digest: canonical_hash(manifest, "qualification manifest")?,
		method_version: QUALIFICATION_METHOD_VERSION.to_owned(),
		official_publication_unit: PUBLICATION_UNIT.to_owned(),
		children,
		matrices: diagnostics,
		pairwise,
		median_configuration_rank_spearman,
		configurations,
		comparison_group_method: COMPARISON_GROUP_METHOD.to_owned(),
		comparison_groups,
		violations,
	};
	let claims_digest = canonical_hash(&claims, "qualification claims")?;

	Ok(BenchmarkQualificationArtifact {
		schema_version: QUALIFICATION_ARTIFACT_SCHEMA_VERSION.to_owned(),
		claims_digest,
		claims,
	})
}

/// Recomputes the complete qualification and requires byte-semantic artifact equality.
pub fn verify_qualification_artifact(
	artifact: &BenchmarkQualificationArtifact,
	manifest: &BenchmarkQualificationManifest,
	catalog: &CandidateCatalogAuthority,
	matrices: &[QualificationMatrix],
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

	let expected = qualify_candidate(manifest, catalog, matrices)?;

	if artifact != &expected {
		return Err(BenchmarkQualificationError::new(
			"qualification artifact does not equal deterministic recomputation",
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

	if catalog.status != CandidateCatalogStatus::QualificationReady
		|| catalog.require_qualification_ready().is_err()
		|| manifest.candidate.candidate_id != catalog.candidate_id
		|| manifest.candidate.catalog_digest != catalog.catalog_digest
	{
		return Err(BenchmarkQualificationError::new(
			"qualification manifest does not bind a qualification-ready exact catalog",
		));
	}
	if manifest.children.len() != manifest.policy.required_matrices {
		return Err(BenchmarkQualificationError::new(
			"qualification manifest must predeclare exactly three children",
		));
	}

	let child_ids =
		manifest.children.iter().map(|child| child.child_id.as_str()).collect::<BTreeSet<_>>();
	let run_ids =
		manifest.children.iter().map(|child| child.source_run_id.as_str()).collect::<BTreeSet<_>>();
	let run_digests = manifest
		.children
		.iter()
		.map(|child| child.source_run_digest.as_str())
		.collect::<BTreeSet<_>>();
	let verifier_digests = manifest
		.children
		.iter()
		.map(|child| child.verifier_attestation_digest.as_str())
		.collect::<BTreeSet<_>>();

	if child_ids.len() != manifest.children.len()
		|| run_ids.len() != manifest.children.len()
		|| run_digests.len() != manifest.children.len()
		|| verifier_digests.len() != manifest.children.len()
		|| manifest.children.iter().any(|child| {
			!valid_token(&child.child_id, 128)
				|| !valid_token(&child.source_run_id, 256)
				|| !valid_digest(&child.source_run_digest)
				|| !valid_digest(&child.verifier_attestation_digest)
		}) {
		return Err(BenchmarkQualificationError::new(
			"qualification child declarations are invalid or reused",
		));
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
			&identity.task_set_digest,
			&identity.corpus_commitment_digest,
			&identity.evaluator_digest,
			&identity.runtime_digest,
			&identity.toolchain_digest,
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

	let expected_model_selection = canonical_hash(&MODEL_MATRIX, "model selection")?;

	if identity.model_selection_digest != expected_model_selection {
		return Err(BenchmarkQualificationError::new(
			"candidate model-selection identity does not match the exact 17 configurations",
		));
	}

	Ok(())
}

fn validate_matrices<'a>(
	manifest: &BenchmarkQualificationManifest,
	catalog: &CandidateCatalogAuthority,
	matrices: &'a [QualificationMatrix],
) -> Result<Vec<ValidatedMatrix<'a>>, BenchmarkQualificationError> {
	if matrices.len() != manifest.policy.required_matrices {
		return Err(BenchmarkQualificationError::new(
			"qualification requires exactly three child matrices",
		));
	}

	let expected_task_ids =
		catalog.tasks.iter().map(|task| task.task_id.clone()).collect::<Vec<_>>();
	let mut source_run_digests = BTreeSet::new();
	let mut verifier_digests = BTreeSet::new();
	let mut matrix_digests = BTreeSet::new();
	let mut validated = Vec::with_capacity(matrices.len());

	for ((declaration, matrix), index) in manifest.children.iter().zip(matrices).zip(0_usize..) {
		let evidence =
			validate_matrix(declaration, matrix, &manifest.candidate, &expected_task_ids, index)?;

		if !source_run_digests.insert(matrix.source_run_digest.as_str())
			|| !verifier_digests.insert(matrix.verifier_attestation_digest.as_str())
			|| !matrix_digests.insert(evidence.digest.clone())
		{
			return Err(BenchmarkQualificationError::new(
				"qualification reuses a child run, verifier attestation, or matrix identity",
			));
		}

		validated.push(evidence);
	}

	Ok(validated)
}

fn validate_matrix<'a>(
	declaration: &PredeclaredQualificationChild,
	matrix: &'a QualificationMatrix,
	candidate: &QualificationCandidateIdentity,
	expected_task_ids: &[String],
	index: usize,
) -> Result<ValidatedMatrix<'a>, BenchmarkQualificationError> {
	if matrix.schema_version != QUALIFICATION_MATRIX_SCHEMA_VERSION {
		return Err(BenchmarkQualificationError::new(format!(
			"qualification child {index} uses an unsupported matrix schema"
		)));
	}
	if matrix.child_id != declaration.child_id
		|| matrix.source_run_id != declaration.source_run_id
		|| matrix.source_run_digest != declaration.source_run_digest
		|| matrix.verifier_attestation_digest != declaration.verifier_attestation_digest
		|| &matrix.candidate != candidate
		|| matrix.models != MODEL_MATRIX
		|| matrix.task_ids != expected_task_ids
		|| matrix.synthetic
		|| !valid_digest(&matrix.source_run_digest)
		|| !valid_digest(&matrix.verifier_attestation_digest)
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

	let expected_cells =
		MODEL_MATRIX.len().checked_mul(expected_task_ids.len()).ok_or_else(|| {
			BenchmarkQualificationError::new("qualification cell cardinality overflows")
		})?;

	if matrix.cells.len() != expected_cells || matrix.cells.len() != 1_224 {
		return Err(BenchmarkQualificationError::new(format!(
			"qualification child {} is not a complete 1,224-cell matrix",
			declaration.child_id
		)));
	}

	let scores = matrix
		.cells
		.iter()
		.enumerate()
		.map(|(cell_index, cell)| {
			validate_cell(cell, cell_index, expected_task_ids, declaration.child_id.as_str())
		})
		.collect::<Result<Vec<_>, _>>()?;
	let digest = canonical_hash(matrix, "qualification child matrix")?;

	Ok(ValidatedMatrix { matrix, digest, scores })
}

fn validate_cell(
	cell: &QualificationCell,
	index: usize,
	task_ids: &[String],
	child_id: &str,
) -> Result<f64, BenchmarkQualificationError> {
	let task_count = task_ids.len();
	let expected_model = MODEL_MATRIX[index / task_count];
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

	Ok(score)
}

fn static_shape_violations(
	catalog: &CandidateCatalogAuthority,
	policy: &BenchmarkQualificationPolicy,
) -> Vec<String> {
	let domains = catalog.tasks.iter().map(|task| task.domain).collect::<BTreeSet<_>>();
	let mut violations = Vec::new();
	let mut clusters = BTreeMap::<&str, Vec<&CandidateTaskAuthority>>::new();

	for task in &catalog.tasks {
		clusters.entry(&task.cluster_id).or_default().push(task);
	}

	if catalog.tasks.len() != policy.required_tasks || domains.len() != policy.required_domains {
		violations.push(format!(
			"candidate shape has {} tasks and {} domains; exactly {} and {} are required",
			catalog.tasks.len(),
			domains.len(),
			policy.required_tasks,
			policy.required_domains
		));
	}
	if clusters.len() < policy.minimum_clusters {
		violations.push(format!(
			"candidate has {} clusters, below {}",
			clusters.len(),
			policy.minimum_clusters
		));
	}

	for (cluster_id, tasks) in clusters {
		let cluster_domains = tasks.iter().map(|task| task.domain).collect::<BTreeSet<_>>();

		if tasks.len() > policy.maximum_tasks_per_cluster {
			violations.push(format!(
				"cluster {cluster_id} contains {} tasks, above {}",
				tasks.len(),
				policy.maximum_tasks_per_cluster
			));
		}
		if tasks.len() > 1 && cluster_domains.len() != 1 {
			violations.push(format!("multi-task cluster {cluster_id} crosses domains"));
		}
	}

	violations
}

fn matrix_diagnostic(
	catalog: &CandidateCatalogAuthority,
	evidence: &ValidatedMatrix<'_>,
	policy: &BenchmarkQualificationPolicy,
) -> QualificationMatrixDiagnostic {
	let task_count = catalog.tasks.len();
	let mut task_statistics = Vec::with_capacity(task_count);
	let mut universal_semantic_zero_tasks = 0_usize;
	let mut universal_full_credit_tasks = 0_usize;

	for task_index in 0..task_count {
		let scores = (0..MODEL_MATRIX.len())
			.map(|model_index| evidence.scores[model_index * task_count + task_index])
			.collect::<Vec<_>>();
		let facility = scores.iter().sum::<f64>() / scores.len() as f64;
		let low = scores.iter().copied().fold(f64::INFINITY, f64::min);
		let high = scores.iter().copied().fold(f64::NEG_INFINITY, f64::max);

		task_statistics.push((facility, high - low));

		universal_semantic_zero_tasks += usize::from(scores.iter().all(|score| *score == 0.0));
		universal_full_credit_tasks += usize::from(scores.iter().all(|score| *score == 1.0));
	}

	let informative_tasks = task_statistics
		.iter()
		.filter(|(facility, range)| informative(policy, *facility, *range))
		.count();
	let domains = domain_diagnostics(catalog, &task_statistics, policy);
	let configuration_means = configuration_means(catalog, evidence, &domains);

	QualificationMatrixDiagnostic {
		child_id: evidence.matrix.child_id.clone(),
		semantic_cells: evidence.scores.len(),
		informative_tasks,
		universal_semantic_zero_tasks,
		universal_full_credit_tasks,
		domains,
		configuration_means,
	}
}

fn informative(policy: &BenchmarkQualificationPolicy, facility: f64, range: f64) -> bool {
	facility + COMPARISON_TOLERANCE >= policy.informative_facility_min
		&& facility <= policy.informative_facility_max + COMPARISON_TOLERANCE
		&& range + COMPARISON_TOLERANCE >= policy.informative_task_range_min
}

fn non_uniform(policy: &BenchmarkQualificationPolicy, range: f64) -> bool {
	range + COMPARISON_TOLERANCE >= policy.informative_task_range_min
}

fn domain_diagnostics(
	catalog: &CandidateCatalogAuthority,
	statistics: &[(f64, f64)],
	policy: &BenchmarkQualificationPolicy,
) -> Vec<QualificationDomainDiagnostic> {
	let domains = catalog.tasks.iter().map(|task| task.domain).collect::<BTreeSet<_>>();

	domains
		.into_iter()
		.map(|domain| {
			let values = catalog
				.tasks
				.iter()
				.enumerate()
				.filter(|(_, task)| task.domain == domain)
				.map(|(index, _)| statistics[index])
				.collect::<Vec<_>>();

			QualificationDomainDiagnostic {
				domain,
				tasks: values.len(),
				informative_tasks: values
					.iter()
					.filter(|(facility, range)| informative(policy, *facility, *range))
					.count(),
				non_uniform_tasks: values
					.iter()
					.filter(|(_, range)| non_uniform(policy, *range))
					.count(),
			}
		})
		.collect()
}

fn configuration_means(
	catalog: &CandidateCatalogAuthority,
	evidence: &ValidatedMatrix<'_>,
	domains: &[QualificationDomainDiagnostic],
) -> Vec<ConfigurationMeanScore> {
	let task_count = catalog.tasks.len();

	MODEL_MATRIX
		.iter()
		.enumerate()
		.map(|(model_index, model)| {
			let domain_total = domains
				.iter()
				.map(|domain| {
					let scores = catalog
						.tasks
						.iter()
						.enumerate()
						.filter(|(_, task)| task.domain == domain.domain)
						.map(|(task_index, _)| {
							evidence.scores[model_index * task_count + task_index]
						});
					let (sum, count) =
						scores.fold((0.0, 0_usize), |(sum, count), score| (sum + score, count + 1));

					sum / count as f64
				})
				.sum::<f64>();

			ConfigurationMeanScore {
				model: *model,
				mean_score: domain_total / domains.len() as f64 * 100.0,
			}
		})
		.collect()
}

fn matrix_policy_violations(
	diagnostic: &QualificationMatrixDiagnostic,
	policy: &BenchmarkQualificationPolicy,
) -> Vec<String> {
	let mut violations = Vec::new();

	if diagnostic.informative_tasks < policy.minimum_informative_tasks {
		violations.push(format!(
			"child {} has {} informative tasks, below {}",
			diagnostic.child_id, diagnostic.informative_tasks, policy.minimum_informative_tasks
		));
	}
	if diagnostic.universal_semantic_zero_tasks > policy.maximum_universal_semantic_zero_tasks {
		violations.push(format!(
			"child {} has {} universal semantic-zero tasks, above {}",
			diagnostic.child_id,
			diagnostic.universal_semantic_zero_tasks,
			policy.maximum_universal_semantic_zero_tasks
		));
	}
	if diagnostic.universal_full_credit_tasks > policy.maximum_universal_full_credit_tasks {
		violations.push(format!(
			"child {} has {} universal full-credit tasks, above {}",
			diagnostic.child_id,
			diagnostic.universal_full_credit_tasks,
			policy.maximum_universal_full_credit_tasks
		));
	}

	for domain in &diagnostic.domains {
		if domain.informative_tasks < policy.minimum_domain_informative_tasks {
			violations.push(format!(
				"child {} domain {:?} has {} informative tasks, below {}",
				diagnostic.child_id,
				domain.domain,
				domain.informative_tasks,
				policy.minimum_domain_informative_tasks
			));
		}
		if domain.non_uniform_tasks < policy.minimum_domain_non_uniform_tasks {
			violations.push(format!(
				"child {} domain {:?} has {} non-uniform tasks, below {}",
				diagnostic.child_id,
				domain.domain,
				domain.non_uniform_tasks,
				policy.minimum_domain_non_uniform_tasks
			));
		}
	}

	violations
}

fn pairwise_diagnostics(
	matrices: &[ValidatedMatrix<'_>],
	diagnostics: &[QualificationMatrixDiagnostic],
) -> Vec<QualificationPairwiseDiagnostic> {
	[(0_usize, 1_usize), (0, 2), (1, 2)]
		.into_iter()
		.map(|(first, second)| {
			let first_scores = &matrices[first].scores;
			let second_scores = &matrices[second].scores;
			let exact_cell_agreement_count = first_scores
				.iter()
				.zip(second_scores)
				.filter(|(left, right)| left == right)
				.count();
			let mean_absolute_cell_delta = first_scores
				.iter()
				.zip(second_scores)
				.map(|(left, right)| (left - right).abs())
				.sum::<f64>()
				/ first_scores.len() as f64;
			let first_means = diagnostics[first]
				.configuration_means
				.iter()
				.map(|value| value.mean_score)
				.collect::<Vec<_>>();
			let second_means = diagnostics[second]
				.configuration_means
				.iter()
				.map(|value| value.mean_score)
				.collect::<Vec<_>>();
			let maximum_configuration_mean_shift = first_means
				.iter()
				.zip(&second_means)
				.map(|(left, right)| (left - right).abs())
				.fold(0.0, f64::max);

			QualificationPairwiseDiagnostic {
				first_child_id: matrices[first].matrix.child_id.clone(),
				second_child_id: matrices[second].matrix.child_id.clone(),
				configuration_rank_spearman: spearman(&first_means, &second_means),
				exact_cell_agreement_count,
				exact_cell_agreement_rate: exact_cell_agreement_count as f64
					/ first_scores.len() as f64,
				mean_absolute_cell_delta,
				maximum_configuration_mean_shift,
			}
		})
		.collect()
}

fn spearman(first: &[f64], second: &[f64]) -> f64 {
	if first.len() != second.len() || first.len() < 2 {
		return 0.0;
	}

	let first_ranks = average_ranks(first);
	let second_ranks = average_ranks(second);
	let mean = (first.len() as f64 + 1.0) / 2.0;
	let mut covariance = 0.0;
	let mut first_variance = 0.0;
	let mut second_variance = 0.0;

	for (first_rank, second_rank) in first_ranks.iter().zip(&second_ranks) {
		let first_delta = first_rank - mean;
		let second_delta = second_rank - mean;

		covariance += first_delta * second_delta;
		first_variance += first_delta * first_delta;
		second_variance += second_delta * second_delta;
	}

	if first_variance == 0.0 || second_variance == 0.0 {
		0.0
	} else {
		(covariance / (first_variance * second_variance).sqrt()).clamp(-1.0, 1.0)
	}
}

fn average_ranks(values: &[f64]) -> Vec<f64> {
	let mut order = (0..values.len()).collect::<Vec<_>>();

	order.sort_by(|left, right| {
		values[*left].total_cmp(&values[*right]).then_with(|| left.cmp(right))
	});

	let mut ranks = vec![0.0; values.len()];
	let mut start = 0_usize;

	while start < order.len() {
		let mut end = start + 1;

		while end < order.len() && values[order[end]] == values[order[start]] {
			end += 1;
		}

		let average = (start + 1 + end) as f64 / 2.0;

		for index in &order[start..end] {
			ranks[*index] = average;
		}

		start = end;
	}

	ranks
}

fn median_three(mut values: [f64; 3]) -> f64 {
	values.sort_by(f64::total_cmp);

	values[1]
}

fn configuration_summaries(
	diagnostics: &[QualificationMatrixDiagnostic],
) -> Vec<QualificationConfigurationSummary> {
	MODEL_MATRIX
		.iter()
		.enumerate()
		.map(|(model_index, model)| {
			let child_mean_scores = diagnostics
				.iter()
				.map(|diagnostic| diagnostic.configuration_means[model_index].mean_score)
				.collect::<Vec<_>>();
			let run_to_run_prediction_interval = prediction_interval(&child_mean_scores);

			QualificationConfigurationSummary {
				model: *model,
				child_mean_scores,
				run_to_run_prediction_interval,
			}
		})
		.collect()
}

fn prediction_interval(values: &[f64]) -> RunToRunPredictionInterval {
	debug_assert_eq!(values.len(), 3);

	let mean = values.iter().sum::<f64>() / values.len() as f64;
	let variance =
		values.iter().map(|value| (value - mean).powi(2)).sum::<f64>() / (values.len() - 1) as f64;
	let sample_standard_deviation = variance.sqrt();
	let prediction_standard_error =
		sample_standard_deviation * (1.0 + 1.0 / values.len() as f64).sqrt();
	let margin = T_975_DF_2 * prediction_standard_error;

	RunToRunPredictionInterval {
		method: PREDICTION_INTERVAL_METHOD.to_owned(),
		level: 0.95,
		observations: values.len(),
		mean,
		sample_standard_deviation,
		low: (mean - margin).clamp(0.0, 100.0),
		high: (mean + margin).clamp(0.0, 100.0),
	}
}

fn comparison_groups(
	configurations: &[QualificationConfigurationSummary],
) -> Vec<QualificationComparisonGroup> {
	let mut parents = (0..configurations.len()).collect::<Vec<_>>();

	for first in 0..configurations.len() {
		for second in first + 1..configurations.len() {
			let first_interval = &configurations[first].run_to_run_prediction_interval;
			let second_interval = &configurations[second].run_to_run_prediction_interval;

			if first_interval.low <= second_interval.high + COMPARISON_TOLERANCE
				&& second_interval.low <= first_interval.high + COMPARISON_TOLERANCE
			{
				union(&mut parents, first, second);
			}
		}
	}

	let mut components = BTreeMap::<usize, Vec<usize>>::new();

	for index in 0..configurations.len() {
		let root = find(&mut parents, index);

		components.entry(root).or_default().push(index);
	}

	let mut components = components.into_values().collect::<Vec<_>>();

	for component in &mut components {
		component.sort_by(|left, right| {
			configurations[*right]
				.run_to_run_prediction_interval
				.mean
				.total_cmp(&configurations[*left].run_to_run_prediction_interval.mean)
				.then_with(|| left.cmp(right))
		});
	}

	components.sort_by(|left, right| {
		configurations[right[0]]
			.run_to_run_prediction_interval
			.mean
			.total_cmp(&configurations[left[0]].run_to_run_prediction_interval.mean)
	});

	components
		.into_iter()
		.enumerate()
		.map(|(index, component)| QualificationComparisonGroup {
			group_id: format!("group-{:02}", index + 1),
			models: component.into_iter().map(|item| configurations[item].model).collect(),
		})
		.collect()
}

fn find(parents: &mut [usize], index: usize) -> usize {
	if parents[index] != index {
		parents[index] = find(parents, parents[index]);
	}

	parents[index]
}

fn union(parents: &mut [usize], first: usize, second: usize) {
	let first_root = find(parents, first);
	let second_root = find(parents, second);

	if first_root != second_root {
		parents[second_root] = first_root;
	}
}

fn child_bindings(matrices: &[ValidatedMatrix<'_>]) -> Vec<QualificationChildBinding> {
	matrices
		.iter()
		.map(|evidence| QualificationChildBinding {
			child_id: evidence.matrix.child_id.clone(),
			source_run_id: evidence.matrix.source_run_id.clone(),
			source_run_digest: evidence.matrix.source_run_digest.clone(),
			verifier_attestation_digest: evidence.matrix.verifier_attestation_digest.clone(),
			matrix_digest: evidence.digest.clone(),
		})
		.collect()
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

#[cfg(test)]
mod tests {
	use serde_json::{self, Value};

	use crate::{
		benchmark_qualification::{
			self, BenchmarkQualificationManifest, BenchmarkQualificationStatus,
			PredeclaredQualificationChild, QualificationCandidateIdentity, QualificationCell,
			QualificationCellStatus, QualificationChildDisposition, QualificationMatrix,
		},
		candidate_catalog,
		model::MODEL_MATRIX,
		protocol,
	};

	const DOMAINS: [&str; 10] = [
		"coding",
		"debugging",
		"repository_understanding",
		"data_processing",
		"retrieval_verification",
		"documentation_communication",
		"planning_execution",
		"tool_use",
		"instruction_following",
		"reliability_recovery",
	];

	fn digest(character: char) -> String {
		format!("sha256:{}", character.to_string().repeat(64))
	}

	fn candidate_catalog_value() -> Value {
		let mut paired_clusters = 0_usize;
		let mut tasks = Vec::new();

		for (domain_index, domain) in DOMAINS.into_iter().enumerate() {
			let count = if domain_index < 2 { 8 } else { 7 };
			let pairs = if domain_index < 2 { 2 } else { 1 };

			for local in 0..count {
				let task_id = format!("{}-{:02}", domain.replace('_', "-"), local + 1);
				let task_index = tasks.len();
				let letter = char::from(b'a' + local as u8);
				let cluster_id = if local < pairs * 2 {
					if local % 2 == 0 {
						paired_clusters += 1;
					}

					let pair = char::from(b'a' + (local / 2) as u8);

					format!("{domain}_pair_{pair}-cluster-01")
				} else {
					format!("{domain}_single_{letter}-cluster-01")
				};

				tasks.push(serde_json::json!({
					"task_id":task_id,
					"task_version":"1.1.0",
					"domain":domain,
					"cluster_id":cluster_id,
					"design_revision":{
						"supersedes_task_version":"1.0.7",
						"decision":"retained",
						"decision_record":"benchmarks/candidates/aiq-core-1.1.0/design-decisions.json"
					},
					"evaluator":{
						"scorer_version":"1.0.6",
						"acceptance_fixture_commitments": acceptance(&task_id, task_index)
					}
				}));
			}
		}

		assert_eq!(paired_clusters, 12);

		let task_metadata_digest = protocol::canonical_hash(&tasks).expect("task digest");

		serde_json::json!({
			"schema_version":"aiq.catalog.v2",
			"task_set_id":"aiq-core",
			"task_set_version":"1.1.0",
			"scoring_version":"1.0.6",
			"status":"qualification_ready",
			"candidate_identity":{
				"candidate_id":"aiq-core/1.1.0-candidate.1",
				"task_metadata_digest":task_metadata_digest
			},
			"tasks":tasks
		})
	}

	fn acceptance(task_id: &str, task_index: usize) -> Value {
		serde_json::json!({
			"adversarial_format":{"applicability":"required","handle":format!("aiq-acceptance://{task_id}/v4/adversarial-format")},
			"alternate_correct":{"applicability":"required","handle":format!("aiq-acceptance://{task_id}/v4/alternate-correct")},
			"empty": if task_index < 57 { serde_json::json!({"applicability":"required","handle":format!("aiq-acceptance://{task_id}/v4/empty")}) } else { serde_json::json!({"applicability":"not_applicable","handle":null}) },
			"gold":{"applicability":"required","handle":format!("aiq-acceptance://{task_id}/v4/gold")},
			"partial":{"applicability":"required","handle":format!("aiq-acceptance://{task_id}/v4/partial")},
			"timeout": if task_index < 4 { serde_json::json!({"applicability":"required","handle":format!("aiq-acceptance://{task_id}/v4/timeout")}) } else { serde_json::json!({"applicability":"not_applicable","handle":null}) }
		})
	}

	fn fixture() -> (
		candidate_catalog::CandidateCatalogAuthority,
		BenchmarkQualificationManifest,
		Vec<QualificationMatrix>,
	) {
		let catalog = candidate_catalog::validate_candidate_catalog(&candidate_catalog_value())
			.expect("catalog");
		let candidate = QualificationCandidateIdentity {
			candidate_id: catalog.candidate_id.clone(),
			catalog_digest: catalog.catalog_digest.clone(),
			task_set_digest: digest('1'),
			corpus_release_id: "aiq-core/1.1.0-candidate.1".to_owned(),
			corpus_commitment_digest: digest('2'),
			evaluator_digest: digest('3'),
			runtime_digest: digest('4'),
			toolchain_digest: digest('5'),
			source_manifest_digest: digest('6'),
			model_selection_digest: protocol::canonical_hash(&MODEL_MATRIX).expect("models"),
		};
		let children = (0..3)
			.map(|index| PredeclaredQualificationChild {
				child_id: format!("child-{}", index + 1),
				source_run_id: format!("run-{}", index + 1),
				source_run_digest: digest(char::from(b'a' + index as u8)),
				verifier_attestation_digest: digest(char::from(b'd' + index as u8)),
			})
			.collect::<Vec<_>>();
		let manifest = BenchmarkQualificationManifest {
			schema_version: benchmark_qualification::QUALIFICATION_MANIFEST_SCHEMA_VERSION
				.to_owned(),
			candidate: candidate.clone(),
			policy: benchmark_qualification::BenchmarkQualificationPolicy::default(),
			children: children.clone(),
		};
		let task_ids = catalog.tasks.iter().map(|task| task.task_id.clone()).collect::<Vec<_>>();
		let matrices = children
			.iter()
			.enumerate()
			.map(|(run_index, child)| matrix(child, &candidate, &task_ids, run_index))
			.collect();

		(catalog, manifest, matrices)
	}

	fn matrix(
		child: &PredeclaredQualificationChild,
		candidate: &QualificationCandidateIdentity,
		task_ids: &[String],
		run_index: usize,
	) -> QualificationMatrix {
		let run_shift = [-0.005, 0.0, 0.005][run_index];
		let cells = MODEL_MATRIX
			.iter()
			.enumerate()
			.flat_map(|(model_index, model)| {
				task_ids.iter().enumerate().map(move |(task_index, task_id)| {
					let task_shift = (task_index % 5) as f64 * 0.01;

					QualificationCell {
						task_id: task_id.clone(),
						model: *model,
						status: QualificationCellStatus::Completed,
						semantic_score: Some(
							0.12 + model_index as f64 * 0.045 + task_shift + run_shift,
						),
					}
				})
			})
			.collect();

		QualificationMatrix {
			schema_version: benchmark_qualification::QUALIFICATION_MATRIX_SCHEMA_VERSION.to_owned(),
			child_id: child.child_id.clone(),
			source_run_id: child.source_run_id.clone(),
			source_run_digest: child.source_run_digest.clone(),
			verifier_attestation_digest: child.verifier_attestation_digest.clone(),
			disposition: QualificationChildDisposition::Accepted,
			rejection_digest: None,
			synthetic: false,
			candidate: candidate.clone(),
			models: MODEL_MATRIX.to_vec(),
			task_ids: task_ids.to_vec(),
			cells,
		}
	}

	#[test]
	fn three_complete_stable_matrices_qualify_deterministically() {
		let (catalog, manifest, matrices) = fixture();
		let first = benchmark_qualification::qualify_candidate(&manifest, &catalog, &matrices)
			.expect("qualification");
		let second = benchmark_qualification::qualify_candidate(&manifest, &catalog, &matrices)
			.expect("qualification again");

		assert_eq!(first, second);
		assert_eq!(first.claims.status, BenchmarkQualificationStatus::Qualified);
		assert_eq!(first.claims.children.len(), 3);
		assert_eq!(first.claims.pairwise.len(), 3);
		assert_eq!(first.claims.configurations.len(), 17);
		assert!(first.claims.violations.is_empty());

		benchmark_qualification::verify_qualification_artifact(
			&first, &manifest, &catalog, &matrices,
		)
		.expect("verification");
	}

	#[test]
	fn structural_matrix_rejections_fail_closed() {
		let (catalog, manifest, matrices) = fixture();

		for mutation in 0..7 {
			let mut changed = matrices.clone();

			match mutation {
				0 => {
					changed[0].cells.pop();
				},
				1 => changed[0].cells[1].task_id = changed[0].cells[0].task_id.clone(),
				2 => {
					changed[0].cells[0].status = QualificationCellStatus::RuntimeInvalid;
					changed[0].cells[0].semantic_score = None;
				},
				3 => changed[0].synthetic = true,
				4 => changed[0].candidate.runtime_digest = digest('9'),
				5 => changed[1].source_run_digest = changed[0].source_run_digest.clone(),
				_ => {
					changed[0].disposition = QualificationChildDisposition::Rejected;
					changed[0].rejection_digest = Some(digest('9'));
				},
			}

			assert!(
				benchmark_qualification::qualify_candidate(&manifest, &catalog, &changed).is_err(),
				"mutation {mutation} must fail"
			);
		}
	}

	#[test]
	fn manifest_policy_and_child_identity_drift_fail_closed() {
		let (catalog, manifest, matrices) = fixture();
		let mut changed = manifest.clone();

		changed.policy.minimum_median_rank_spearman = 0.0;

		assert!(benchmark_qualification::qualify_candidate(&changed, &catalog, &matrices).is_err());

		let mut changed = manifest.clone();

		changed.children[1].child_id = changed.children[0].child_id.clone();

		assert!(benchmark_qualification::qualify_candidate(&changed, &catalog, &matrices).is_err());

		let mut changed = manifest;

		changed.schema_version = "aiq.benchmark-qualification-manifest.v2".to_owned();

		assert!(benchmark_qualification::qualify_candidate(&changed, &catalog, &matrices).is_err());
	}

	#[test]
	fn every_candidate_identity_component_must_match_all_children() {
		let (catalog, manifest, matrices) = fixture();

		for mutation in 0..9 {
			let mut changed = matrices.clone();

			match mutation {
				0 => changed[0].candidate.catalog_digest = digest('7'),
				1 => changed[0].candidate.task_set_digest = digest('7'),
				2 => changed[0].candidate.corpus_release_id = "other-candidate".to_owned(),
				3 => changed[0].candidate.corpus_commitment_digest = digest('7'),
				4 => changed[0].candidate.evaluator_digest = digest('7'),
				5 => changed[0].candidate.runtime_digest = digest('7'),
				6 => changed[0].candidate.toolchain_digest = digest('7'),
				7 => changed[0].candidate.source_manifest_digest = digest('7'),
				_ => changed[0].candidate.model_selection_digest = digest('7'),
			}

			assert!(
				benchmark_qualification::qualify_candidate(&manifest, &catalog, &changed).is_err(),
				"identity mutation {mutation} must fail"
			);
		}
	}

	#[test]
	fn static_shape_and_matrix_threshold_falsifiers_reject() {
		let (catalog, manifest, matrices) = fixture();
		let mut bad_shape = catalog.clone();

		for task in &mut bad_shape.tasks {
			task.cluster_id = "one-cluster".to_owned();
		}

		let artifact = benchmark_qualification::qualify_candidate(&manifest, &bad_shape, &matrices)
			.expect("shape rejection artifact");

		assert_eq!(artifact.claims.status, BenchmarkQualificationStatus::Rejected);

		for mutation in 0..5 {
			let mut changed = matrices.clone();

			match mutation {
				0 => set_task_scores(&mut changed[0], 0..25, |_| 0.5),
				1 => set_task_scores(&mut changed[0], 0..4, |_| 0.0),
				2 => set_task_scores(&mut changed[0], 0..4, |_| 1.0),
				3 => reverse_configuration_order(&mut changed[1]),
				_ => shift_configuration(&mut changed[1], 0, 0.07),
			}

			let artifact =
				benchmark_qualification::qualify_candidate(&manifest, &catalog, &changed)
					.expect("threshold rejection artifact");

			assert_eq!(
				artifact.claims.status,
				BenchmarkQualificationStatus::Rejected,
				"mutation {mutation} must reject"
			);
			assert!(!artifact.claims.violations.is_empty());
		}
	}

	#[test]
	fn every_static_candidate_shape_falsifier_rejects() {
		let (catalog, manifest, matrices) = fixture();
		let mut wrong_domains = catalog.clone();

		for task in &mut wrong_domains.tasks {
			task.domain = crate::task::Domain::Coding;
		}

		let artifact =
			benchmark_qualification::qualify_candidate(&manifest, &wrong_domains, &matrices)
				.expect("domain rejection");

		assert_eq!(artifact.claims.status, BenchmarkQualificationStatus::Rejected);

		let mut oversized = catalog.clone();
		let cluster = oversized.tasks[0].cluster_id.clone();

		oversized.tasks[1].cluster_id.clone_from(&cluster);
		oversized.tasks[2].cluster_id.clone_from(&cluster);

		let artifact = benchmark_qualification::qualify_candidate(&manifest, &oversized, &matrices)
			.expect("cluster-size rejection");

		assert!(artifact.claims.violations.iter().any(|value| value.contains("above 2")));

		let mut cross_domain = catalog;
		let first_cluster = cross_domain.tasks[0].cluster_id.clone();
		let other_domain = cross_domain
			.tasks
			.iter_mut()
			.find(|task| task.domain != crate::task::Domain::Coding)
			.expect("other domain");

		other_domain.cluster_id = first_cluster;

		let artifact =
			benchmark_qualification::qualify_candidate(&manifest, &cross_domain, &matrices)
				.expect("cross-domain rejection");

		assert!(artifact.claims.violations.iter().any(|value| value.contains("crosses domains")));
	}

	fn set_task_scores(
		matrix: &mut QualificationMatrix,
		tasks: std::ops::Range<usize>,
		value: impl Fn(usize) -> f64,
	) {
		let task_count = matrix.task_ids.len();

		for model_index in 0..MODEL_MATRIX.len() {
			for task_index in tasks.clone() {
				matrix.cells[model_index * task_count + task_index].semantic_score =
					Some(value(task_index));
			}
		}
	}

	fn reverse_configuration_order(matrix: &mut QualificationMatrix) {
		let task_count = matrix.task_ids.len();
		let original = matrix.cells.clone();

		for model_index in 0..MODEL_MATRIX.len() {
			let source = MODEL_MATRIX.len() - 1 - model_index;

			for task_index in 0..task_count {
				matrix.cells[model_index * task_count + task_index].semantic_score =
					original[source * task_count + task_index].semantic_score;
			}
		}
	}

	fn shift_configuration(matrix: &mut QualificationMatrix, model_index: usize, delta: f64) {
		let task_count = matrix.task_ids.len();

		for task_index in 0..task_count {
			let cell = &mut matrix.cells[model_index * task_count + task_index];

			cell.semantic_score = cell.semantic_score.map(|score| score + delta);
		}
	}

	fn set_task_indices(matrix: &mut QualificationMatrix, tasks: &[usize], value: f64) {
		let task_count = matrix.task_ids.len();

		for model_index in 0..MODEL_MATRIX.len() {
			for task_index in tasks {
				matrix.cells[model_index * task_count + task_index].semantic_score = Some(value);
			}
		}
	}

	#[test]
	fn artifact_tamper_swapped_children_and_future_versions_fail_closed() {
		let (catalog, manifest, matrices) = fixture();
		let artifact = benchmark_qualification::qualify_candidate(&manifest, &catalog, &matrices)
			.expect("artifact");
		let mut changed = artifact.clone();

		changed.claims.children.swap(0, 1);

		changed.claims_digest = protocol::canonical_hash(&changed.claims).expect("changed digest");

		assert!(
			benchmark_qualification::verify_qualification_artifact(
				&changed, &manifest, &catalog, &matrices,
			)
			.is_err()
		);

		let mut changed = artifact;

		changed.schema_version = "aiq.benchmark-qualification.v2".to_owned();

		assert!(
			benchmark_qualification::verify_qualification_artifact(
				&changed, &manifest, &catalog, &matrices,
			)
			.is_err()
		);
	}

	#[test]
	fn prediction_interval_and_comparison_groups_match_test_vectors() {
		let interval = benchmark_qualification::prediction_interval(&[40.0, 50.0, 60.0]);

		assert!((interval.mean - 50.0).abs() < 1e-12);
		assert!((interval.sample_standard_deviation - 10.0).abs() < 1e-12);
		assert!((interval.low - 0.317_245_763_124_958_56).abs() < 1e-9);
		assert!((interval.high - 99.682_754_236_875_04).abs() < 1e-9);

		let first = [1.0, 2.0, 3.0, 4.0, 5.0];
		let second = [1.0, 2.0, 5.0, 3.0, 4.0];

		assert!((benchmark_qualification::spearman(&first, &second) - 0.7).abs() < 1e-12);

		let (catalog, manifest, matrices) = fixture();
		let artifact = benchmark_qualification::qualify_candidate(&manifest, &catalog, &matrices)
			.expect("artifact");

		assert!(!artifact.claims.comparison_groups.is_empty());
		assert_eq!(
			artifact.claims.configurations[0].run_to_run_prediction_interval.method,
			benchmark_qualification::PREDICTION_INTERVAL_METHOD
		);

		let summaries = [
			configuration_summary(0, 90.0, 80.0, 95.0),
			configuration_summary(1, 87.0, 85.0, 92.0),
			configuration_summary(2, 50.0, 40.0, 60.0),
			configuration_summary(3, 10.0, 5.0, 20.0),
		];
		let groups = benchmark_qualification::comparison_groups(&summaries);

		assert_eq!(groups.len(), 3);
		assert_eq!(groups[0].models, vec![MODEL_MATRIX[0], MODEL_MATRIX[1]]);
		assert_eq!(groups[1].models, vec![MODEL_MATRIX[2]]);
		assert_eq!(groups[2].models, vec![MODEL_MATRIX[3]]);
	}

	fn configuration_summary(
		model_index: usize,
		mean: f64,
		low: f64,
		high: f64,
	) -> benchmark_qualification::QualificationConfigurationSummary {
		benchmark_qualification::QualificationConfigurationSummary {
			model: MODEL_MATRIX[model_index],
			child_mean_scores: vec![mean; 3],
			run_to_run_prediction_interval: benchmark_qualification::RunToRunPredictionInterval {
				method: benchmark_qualification::PREDICTION_INTERVAL_METHOD.to_owned(),
				level: 0.95,
				observations: 3,
				mean,
				sample_standard_deviation: 0.0,
				low,
				high,
			},
		}
	}

	#[test]
	fn exact_floor_and_ceiling_boundaries_are_accepted() {
		let (catalog, manifest, mut matrices) = fixture();

		for matrix in &mut matrices {
			set_task_indices(matrix, &[0, 8, 16], 0.0);
			set_task_indices(matrix, &[23, 30, 37], 1.0);
		}

		let artifact = benchmark_qualification::qualify_candidate(&manifest, &catalog, &matrices)
			.expect("boundary artifact");

		assert_eq!(
			artifact.claims.status,
			BenchmarkQualificationStatus::Qualified,
			"{:?}",
			artifact.claims.violations
		);
		assert!(artifact.claims.matrices.iter().all(|matrix| {
			matrix.universal_semantic_zero_tasks == 3 && matrix.universal_full_credit_tasks == 3
		}));
	}

	#[test]
	fn exact_informative_and_mean_shift_boundaries_are_accepted() {
		let (catalog, manifest, mut matrices) = fixture();
		let domains = [
			crate::task::Domain::Coding,
			crate::task::Domain::Debugging,
			crate::task::Domain::RepositoryUnderstanding,
			crate::task::Domain::DataProcessing,
			crate::task::Domain::RetrievalVerification,
			crate::task::Domain::DocumentationCommunication,
			crate::task::Domain::PlanningExecution,
			crate::task::Domain::ToolUse,
			crate::task::Domain::InstructionFollowing,
			crate::task::Domain::ReliabilityRecovery,
		];
		let mut uniform = Vec::new();

		for domain in domains {
			let indices = catalog
				.tasks
				.iter()
				.enumerate()
				.filter(|(_, task)| task.domain == domain)
				.map(|(index, _)| index)
				.collect::<Vec<_>>();

			uniform.extend(indices.into_iter().take(2));
		}
		for domain in domains.into_iter().take(4) {
			let third = catalog
				.tasks
				.iter()
				.enumerate()
				.filter(|(_, task)| task.domain == domain)
				.nth(2)
				.map(|(index, _)| index)
				.expect("third domain task");

			uniform.push(third);
		}

		assert_eq!(uniform.len(), 24);

		for matrix in &mut matrices {
			set_task_indices(matrix, &uniform, 0.5);
		}

		let artifact = benchmark_qualification::qualify_candidate(&manifest, &catalog, &matrices)
			.expect("48-task boundary");

		assert_eq!(artifact.claims.status, BenchmarkQualificationStatus::Qualified);
		assert!(artifact.claims.matrices.iter().all(|matrix| matrix.informative_tasks == 48));

		let (_, manifest, mut matrices) = fixture();
		let baseline_scores =
			matrices[0].cells.iter().map(|cell| cell.semantic_score).collect::<Vec<_>>();

		for matrix in &mut matrices[1..] {
			for (cell, score) in matrix.cells.iter_mut().zip(&baseline_scores) {
				cell.semantic_score = *score;
			}
		}

		shift_configuration(&mut matrices[1], 0, 0.05);

		let artifact = benchmark_qualification::qualify_candidate(&manifest, &catalog, &matrices)
			.expect("five-point boundary");

		assert_eq!(artifact.claims.status, BenchmarkQualificationStatus::Qualified);
		assert!(
			artifact
				.claims
				.pairwise
				.iter()
				.any(|pair| { (pair.maximum_configuration_mean_shift - 5.0).abs() < 1e-9 })
		);
	}
}
