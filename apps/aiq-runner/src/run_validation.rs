//! Strict semantic validation for saved run records.

use std::{
	collections::{BTreeMap, BTreeSet},
	error::Error,
	fmt::{Display, Formatter},
};

use sha2::{Digest, Sha256};

use crate::runner::{self, MAX_RUN_JOBS};
use crate::{
	adapter::{
		self, AdapterFailure, ArtifactReference, CapabilityValidationReport,
		CapabilityValidationStatus, ConfigurationProbeStatus, MAX_INLINE_PREVIEW_BYTES,
		PREFLIGHT_MARKER_ARTIFACT_KIND, PREFLIGHT_MARKER_BYTES, PREFLIGHT_MARKER_SHA256,
		ProbeStatus,
	},
	benchmark_qualification::CANDIDATE_QUALIFICATION_MODEL_MATRIX,
	candidate_catalog::{self, CANDIDATE_TASK_SET_VERSION},
	corpus_commitment::{self, RunClass, ValidatedCorpusCommitment},
	model::{MODEL_MATRIX, ModelConfig},
	protocol, resume,
	runner::{
		CALIBRATION_RUN_SCHEMA_VERSION, CalibrationRunRecord, EVALUATOR_RESULTS_SCHEMA_VERSION,
		EvaluationOutcome, EvaluatorResultsBundle, FailureKind,
		MAX_COMPLETED_COMMAND_DIGEST_ENTRIES_PER_RUN, MAX_EVALUATOR_RESULTS_BUNDLE_BYTES,
		MAX_RESULT_PREVIEW_BYTES, RESULT_SCHEMA_VERSION, RUN_SCHEMA_VERSION, ResultStatus,
		RunRecord, TaskResult,
	},
	schedule,
	scoring::{self, AIQ_SCORING_VERSION},
	task::{
		self, EVALUATOR_RESULT_SCHEMA_VERSION, EvaluationResult, EvaluatorOutcome, TaskDefinition,
	},
};

const MAX_RESULT_ARTIFACT_REFERENCES: usize = 4;
const MAX_PREFLIGHT_ARTIFACT_REFERENCES: usize = 3;
const MAX_ARTIFACT_REFERENCE_BYTES: u64 = 4 * 1_024 * 1_024;
const MAX_PREFLIGHT_REASON_BYTES: usize = 128;
const MAX_FAILURE_MESSAGE_BYTES: usize = 128;
const MAX_TOOL_USAGE_KINDS: usize = 4;
const MAX_TOOL_KIND_BYTES: usize = 32;
const MAX_COMPLETED_COMMAND_DIGESTS: usize = MAX_COMPLETED_COMMAND_DIGEST_ENTRIES_PER_RUN;
const MAX_TASK_ID_BYTES: usize = 64;
const MAX_TASK_VERSION_BYTES: usize = 32;
const MAX_RUNNER_VERSION_BYTES: usize = 32;
const MAX_JCS_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const CALIBRATION_SOURCE_1_0_7_SCORING_VERSION: &str = "1.0.7";

/// A saved run failed semantic validation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RunValidationError {
	message: String,
}
impl RunValidationError {
	fn new(message: impl Into<String>) -> Self {
		Self { message: message.into() }
	}
}

impl Error for RunValidationError {}

impl Display for RunValidationError {
	fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
		formatter.write_str(&self.message)
	}
}

/// In-process calibration validation authority carried across one runner operation.
///
/// Candidate authority can be created only from an exact validated candidate corpus and exact
/// candidate tasks. Callers cannot select it from saved-run provenance or a loose package-time
/// switch.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct CalibrationValidationContext {
	kind: CalibrationValidationKind,
}
impl CalibrationValidationContext {
	/// Uses the active AIQ Core 1.0.7 and Contrast calibration boundary.
	#[must_use]
	pub(crate) const fn current() -> Self {
		Self { kind: CalibrationValidationKind::Current }
	}

	/// Binds candidate validation to the exact corpus and task authority selected in preparation.
	pub(crate) fn candidate_qualification(
		corpus: &ValidatedCorpusCommitment,
		tasks: &[TaskDefinition],
	) -> Result<Self, RunValidationError> {
		let candidate = candidate_catalog::checked_candidate_catalog_authority()
			.map_err(|error| RunValidationError::new(error.to_string()))?;

		candidate
			.require_frozen_candidate()
			.map_err(|error| RunValidationError::new(error.to_string()))?;

		if corpus.catalog_digest() != candidate.task_metadata_digest
			|| !candidate_catalog::task_bindings_match_checked_candidate(tasks)
		{
			return Err(RunValidationError::new(
				"candidate validation context does not match the prepared corpus and tasks",
			));
		}

		Ok(Self {
			kind: CalibrationValidationKind::CandidateQualification(Box::new(
				CandidateQualificationContext {
					corpus_release_id: corpus.release_id().to_owned(),
					corpus_commitment_sha256: corpus.canonical_sha256().to_owned(),
					catalog_digest: candidate.task_metadata_digest,
					evaluator_digest: corpus_commitment::evaluator_digest(tasks)
						.map_err(|error| RunValidationError::new(error.to_string()))?,
					harness_digest: corpus.harness_digest().to_owned(),
					prompt_digest: corpus.prompt_digest().to_owned(),
					tool_policy_digest: corpus.tool_policy_digest().to_owned(),
					network_policy_digest: corpus.network_policy_digest().to_owned(),
					environment_digest: corpus.environment_digest().to_owned(),
					source_manifest_digest: corpus.source_manifest_digest().to_owned(),
				},
			)),
		})
	}

	/// Validates one completed calibration under this exact authority.
	pub(crate) fn validate(
		&self,
		run: &CalibrationRunRecord,
		tasks: Option<&[TaskDefinition]>,
	) -> Result<(), RunValidationError> {
		match &self.kind {
			CalibrationValidationKind::Current => match tasks {
				Some(tasks) => validate_calibration_run_record_with_tasks(run, tasks),
				None => validate_calibration_run_record(run),
			},
			CalibrationValidationKind::CandidateQualification(candidate) => {
				let tasks = tasks.ok_or_else(|| {
					RunValidationError::new(
						"candidate validation requires exact supplied task definitions",
					)
				})?;

				if run.provenance.corpus_release_id != candidate.corpus_release_id
					|| run.provenance.corpus_commitment_sha256 != candidate.corpus_commitment_sha256
					|| run.provenance.catalog_digest != candidate.catalog_digest
					|| run.provenance.evaluator_digest != candidate.evaluator_digest
					|| run.provenance.harness_digest != candidate.harness_digest
					|| run.provenance.prompt_digest != candidate.prompt_digest
					|| run.provenance.tool_policy_digest != candidate.tool_policy_digest
					|| run.provenance.network_policy_digest != candidate.network_policy_digest
					|| run.provenance.environment_digest != candidate.environment_digest
					|| run.provenance.source_manifest_digest != candidate.source_manifest_digest
				{
					return Err(RunValidationError::new(
						"completed run does not match its candidate validation context",
					));
				}

				validate_candidate_qualification_calibration_with_tasks(run, tasks)
			},
		}
	}
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct CandidateQualificationContext {
	corpus_release_id: String,
	corpus_commitment_sha256: String,
	catalog_digest: String,
	evaluator_digest: String,
	harness_digest: String,
	prompt_digest: String,
	tool_policy_digest: String,
	network_policy_digest: String,
	environment_digest: String,
	source_manifest_digest: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum CalibrationValidationKind {
	Current,
	CandidateQualification(Box<CandidateQualificationContext>),
}

/// Validates a signed, explicitly non-Official selected calibration run.
pub fn validate_calibration_run_record(
	run: &CalibrationRunRecord,
) -> Result<(), RunValidationError> {
	validate_calibration_run_record_inner(run, false, AIQ_SCORING_VERSION)
}

/// Validates a calibration against the exact supplied task definitions and frozen catalog bindings.
pub fn validate_calibration_run_record_with_tasks(
	run: &CalibrationRunRecord,
	tasks: &[TaskDefinition],
) -> Result<(), RunValidationError> {
	validate_calibration_run_record(run)?;

	validate_calibration_task_bindings(run, tasks, scoring::task_bindings_match_frozen_catalog)
}

/// Validates a promoted 1.0.7 calibration source without changing its signed run identity.
pub fn validate_calibration_source_1_0_7_with_tasks(
	run: &CalibrationRunRecord,
	tasks: &[TaskDefinition],
) -> Result<(), RunValidationError> {
	validate_calibration_run_record_inner(run, true, CALIBRATION_SOURCE_1_0_7_SCORING_VERSION)?;

	validate_calibration_task_bindings(run, tasks, scoring::task_bindings_match_frozen_catalog)
}

/// Validates one complete candidate-only qualification calibration.
pub fn validate_candidate_qualification_calibration(
	run: &CalibrationRunRecord,
) -> Result<(), RunValidationError> {
	validate_calibration_run_record_inner(run, true, AIQ_SCORING_VERSION)?;

	let preflight_digest =
		protocol::canonical_hash(&run.capability_validation).map_err(|error| {
			RunValidationError::new(format!("capability commitment failed: {error}"))
		})?;

	corpus_commitment::validate_candidate_qualification_provenance_v1_1_0(
		&run.provenance,
		&run.task_set_hash,
		&preflight_digest,
	)
	.map_err(|error| RunValidationError::new(error.to_string()))?;

	let candidate = candidate_catalog::checked_candidate_catalog_authority()
		.map_err(|error| RunValidationError::new(error.to_string()))?;

	candidate
		.require_frozen_candidate()
		.map_err(|error| RunValidationError::new(error.to_string()))?;

	let expected_task_ids =
		candidate.tasks.iter().map(|task| task.task_id.as_str()).collect::<Vec<_>>();
	let observed_task_ids = run.task_ids.iter().map(String::as_str).collect::<Vec<_>>();

	if run.models != CANDIDATE_QUALIFICATION_MODEL_MATRIX
		|| run.task_ids.len() != 72
		|| run.results.len() != 216
		|| observed_task_ids != expected_task_ids
		|| run.results.iter().any(|result| result.task_version != CANDIDATE_TASK_SET_VERSION)
	{
		return Err(RunValidationError::new(
			"candidate qualification requires one exact complete 3-by-72 calibration",
		));
	}

	Ok(())
}

/// Validates one complete candidate-only qualification calibration with exact task sources.
pub fn validate_candidate_qualification_calibration_with_tasks(
	run: &CalibrationRunRecord,
	tasks: &[TaskDefinition],
) -> Result<(), RunValidationError> {
	validate_candidate_qualification_calibration(run)?;

	validate_calibration_task_bindings(
		run,
		tasks,
		candidate_catalog::task_bindings_match_checked_candidate,
	)
}

/// Validates a complete run. Supplied tasks add source-authoritative hash checks.
pub fn validate_run_record(
	run: &RunRecord,
	tasks: Option<&[TaskDefinition]>,
) -> Result<(), RunValidationError> {
	if run.schema_version != RUN_SCHEMA_VERSION {
		return Err(RunValidationError::new("run schema_version is not aiq.run.v4"));
	}

	runner::validate_terminal_attempt_lineage(&run.results, &run.terminal_attempt_lineage)
		.map_err(|error| RunValidationError::new(error.to_string()))?;

	validate_run_calibration_bank(run, tasks)?;

	run.schedule_slot
		.validate()
		.map_err(|error| RunValidationError::new(format!("invalid schedule slot: {error}")))?;

	if run.scoring_version != AIQ_SCORING_VERSION {
		return Err(RunValidationError::new("run scoring version is not current"));
	}
	if run.execution_concurrency.is_some_and(|jobs| !(1..=MAX_RUN_JOBS).contains(&jobs)) {
		return Err(RunValidationError::new("run execution concurrency is invalid"));
	}
	if run.models != MODEL_MATRIX {
		return Err(RunValidationError::new("run models must equal the ordered 17-entry matrix"));
	}
	if run.finished_unix_ms < run.started_unix_ms {
		return Err(RunValidationError::new("run finish time precedes its start time"));
	}
	if run.started_unix_ms > MAX_JCS_SAFE_INTEGER || run.finished_unix_ms > MAX_JCS_SAFE_INTEGER {
		return Err(RunValidationError::new("run timestamps exceed the JCS-safe integer bound"));
	}

	validate_evaluator_results_artifact(&run.evaluator_results_artifact)?;
	validate_provenance(run)?;

	let task_metadata = collect_task_metadata(&run.results)?;

	if task_metadata.len() != 72 {
		return Err(RunValidationError::new("run must contain exactly 72 distinct tasks"));
	}

	let expected_results = task_metadata
		.len()
		.checked_mul(MODEL_MATRIX.len())
		.ok_or_else(|| RunValidationError::new("result cardinality overflows"))?;

	if run.results.len() != expected_results || run.results.len() != 1_224 {
		return Err(RunValidationError::new(
			"run must contain exactly one result per task and matrix configuration",
		));
	}

	validate_completed_command_digest_entry_count(&run.results)?;

	let task_hash = if let Some(tasks) = tasks {
		validate_tasks(tasks, &task_metadata)?
	} else {
		let mut hashes = task_metadata.values().map(|(_, hash)| hash.clone()).collect::<Vec<_>>();

		hashes.sort();

		protocol::canonical_hash(&hashes)
			.map_err(|error| RunValidationError::new(format!("task-set hash failed: {error}")))?
	};

	if task_hash != run.task_set_hash {
		return Err(RunValidationError::new("task_set_hash does not match the saved tasks"));
	}

	let expected_run_id = if run.synthetic {
		schedule::idempotent_run_id(
			&run.schedule_slot,
			&run.task_set_hash,
			&run.models,
			&run.scoring_version,
		)
		.map_err(|error| RunValidationError::new(format!("run identifier failed: {error}")))?
	} else {
		let corpus_commitment_sha256 = &run
			.provenance
			.as_ref()
			.ok_or_else(|| RunValidationError::new("real run omits signed provenance"))?
			.corpus_commitment_sha256;

		resume::classified_run_id(
			&run.schedule_slot,
			&run.task_set_hash,
			corpus_commitment_sha256,
			&run.models,
			RunClass::Official,
		)
		.map_err(|error| RunValidationError::new(format!("run identifier failed: {error}")))?
	};

	if run.run_id != expected_run_id {
		return Err(RunValidationError::new("run_id does not match the stable run identity"));
	}

	validate_preflight(run)?;

	let mut pairs = BTreeSet::new();

	for result in &run.results {
		validate_result(run, result, &task_metadata, tasks)?;

		if !pairs.insert((result.task_id.clone(), result.model)) {
			return Err(RunValidationError::new(
				"run contains a duplicate task and model configuration",
			));
		}
	}
	for task_id in task_metadata.keys() {
		for model in MODEL_MATRIX {
			if !pairs.contains(&(task_id.clone(), model)) {
				return Err(RunValidationError::new("run omits a task and model configuration"));
			}
		}
	}

	Ok(())
}

/// Parses and validates the exact evaluator-results artifact bound by a run.
pub fn validate_evaluator_results_bundle(
	run: &RunRecord,
	bytes: &[u8],
) -> Result<EvaluatorResultsBundle, RunValidationError> {
	validate_evaluator_results_bundle_parts(&run.evaluator_results_artifact, &run.results, bytes)
}

/// Parses and validates the exact evaluator-results artifact bound by a calibration.
pub fn validate_calibration_evaluator_results_bundle(
	run: &CalibrationRunRecord,
	bytes: &[u8],
) -> Result<EvaluatorResultsBundle, RunValidationError> {
	validate_evaluator_results_bundle_parts(&run.evaluator_results_artifact, &run.results, bytes)
}

/// Validates an immutable calibration for the non-publication historical
/// diagnostic path. It retains result, task-set, and run-local bindings but
/// does not require the source catalog identity to equal the current catalog.
pub(crate) fn validate_calibration_run_record_for_historical_diagnostic(
	run: &CalibrationRunRecord,
	tasks: &[TaskDefinition],
) -> Result<(), RunValidationError> {
	validate_calibration_run_record_inner(run, true, AIQ_SCORING_VERSION)?;

	validate_calibration_task_content(run, tasks)
}

pub(crate) fn valid_artifact_reference(artifact: &ArtifactReference) -> bool {
	let Some(digest) = artifact.content_hash.strip_prefix("sha256:") else {
		return false;
	};

	is_sha256(&artifact.content_hash)
		&& artifact.uri == format!("aiq-artifact://sha256/{digest}/{}", artifact.kind)
		&& (1..=MAX_ARTIFACT_REFERENCE_BYTES).contains(&artifact.bytes)
		&& matches!(
			artifact.kind.as_str(),
			"stdout.jsonl"
				| "stderr.txt"
				| "final-response.txt"
				| "evaluator-results.json"
				| "workspace-manifest.json"
				| "workspace-snapshot.json"
				| PREFLIGHT_MARKER_ARTIFACT_KIND
		)
}

pub(crate) fn valid_normalized_artifact_reference(artifact: &ArtifactReference) -> bool {
	valid_artifact_reference(artifact)
		&& matches!(
			artifact.kind.as_str(),
			"stdout.jsonl" | "stderr.txt" | "final-response.txt" | "workspace-snapshot.json"
		)
}

fn validate_run_calibration_bank(
	run: &RunRecord,
	tasks: Option<&[TaskDefinition]>,
) -> Result<(), RunValidationError> {
	match (run.synthetic, &run.calibration_admission_digest, &run.calibration_bank) {
		(true, None, None) => Ok(()),
		(false, Some(admission_digest), Some(bank)) => {
			if !is_sha256(admission_digest) {
				return Err(RunValidationError::new("calibration admission digest is invalid"));
			}

			if let Some(tasks) = tasks {
				bank.validate(tasks).map_err(|error| RunValidationError::new(error.to_string()))?;
			}

			Ok(())
		},
		_ => Err(RunValidationError::new("run calibration-bank binding is invalid")),
	}
}

fn validate_calibration_run_record_inner(
	run: &CalibrationRunRecord,
	allow_historical_catalog: bool,
	identity_scoring_version: &str,
) -> Result<(), RunValidationError> {
	if !valid_calibration_run_identity(run) {
		return Err(RunValidationError::new(
			"calibration run identity or classification is invalid",
		));
	}

	runner::validate_terminal_attempt_lineage(&run.results, &run.terminal_attempt_lineage)
		.map_err(|error| RunValidationError::new(error.to_string()))?;

	if run.calibration_admission_digest.is_some() || run.calibration_bank.is_some() {
		return Err(RunValidationError::new(
			"calibration runs must not consume an Official frozen bank",
		));
	}

	validate_evaluator_results_artifact(&run.evaluator_results_artifact)?;

	run.schedule_slot.validate().map_err(|error| {
		RunValidationError::new(format!("invalid calibration schedule slot: {error}"))
	})?;

	validate_preflight_report(&run.capability_validation, true)?;

	let model_set = run.models.iter().copied().collect::<BTreeSet<_>>();
	let task_set = run.task_ids.iter().collect::<BTreeSet<_>>();
	let canonical_models =
		MODEL_MATRIX.into_iter().filter(|model| model_set.contains(model)).collect::<Vec<_>>();

	if model_set.len() != run.models.len()
		|| !model_set.iter().all(|model| MODEL_MATRIX.contains(model))
		|| run.models != canonical_models
		|| task_set.len() != run.task_ids.len()
		|| run.results.len()
			!= run.models.len().checked_mul(run.task_ids.len()).ok_or_else(|| {
				RunValidationError::new("calibration result cardinality overflows")
			})? {
		return Err(RunValidationError::new("calibration selection or cardinality is invalid"));
	}

	let preflight_model_set =
		run.capability_validation.models.iter().map(|entry| entry.model).collect::<BTreeSet<_>>();

	if !calibration_preflight_covers_models(&preflight_model_set, &model_set) {
		return Err(RunValidationError::new(
			"calibration preflight does not cover the selected model set",
		));
	}

	let preflight_digest =
		protocol::canonical_hash(&run.capability_validation).map_err(|error| {
			RunValidationError::new(format!("capability commitment failed: {error}"))
		})?;
	let provenance_validation = if allow_historical_catalog {
		corpus_commitment::validate_historical_calibration_provenance(
			&run.provenance,
			&run.task_set_hash,
			&preflight_digest,
		)
	} else {
		corpus_commitment::validate_run_provenance(
			&run.provenance,
			&run.task_set_hash,
			&preflight_digest,
		)
	};

	provenance_validation.map_err(|error| RunValidationError::new(error.to_string()))?;

	if run.provenance.run_class != RunClass::Calibration {
		return Err(RunValidationError::new(
			"calibration run provenance is not classified as calibration",
		));
	}

	let mut task_hashes = BTreeMap::new();

	for result in &run.results {
		if task_hashes
			.insert(result.task_id.as_str(), result.task_hash.as_str())
			.is_some_and(|hash| hash != result.task_hash.as_str())
		{
			return Err(RunValidationError::new("calibration task hashes are inconsistent"));
		}
	}

	let mut addresses = task_hashes.values().copied().collect::<Vec<_>>();

	addresses.sort_unstable();

	let task_set_hash = protocol::canonical_hash(&addresses).map_err(|error| {
		RunValidationError::new(format!("calibration task-set hash failed: {error}"))
	})?;

	if task_set_hash != run.task_set_hash
		|| resume::classified_run_id_for_scoring_version(
			&run.schedule_slot,
			&run.task_set_hash,
			&run.provenance.corpus_commitment_sha256,
			&run.models,
			RunClass::Calibration,
			identity_scoring_version,
		)
		.map_err(|error| RunValidationError::new(error.to_string()))?
			!= run.run_id
	{
		return Err(RunValidationError::new(
			"calibration task set or class-domain-separated run identity is invalid",
		));
	}

	validate_calibration_results(run, &model_set, &task_set)
}

fn valid_calibration_run_identity(run: &CalibrationRunRecord) -> bool {
	run.schema_version == CALIBRATION_RUN_SCHEMA_VERSION
		&& !run.official_eligible
		&& run.classification == "local_calibration_non_official"
		&& run.scoring_version == AIQ_SCORING_VERSION
		&& !run.models.is_empty()
		&& run.execution_concurrency.is_none_or(|jobs| (1..=MAX_RUN_JOBS).contains(&jobs))
		&& !run.task_ids.is_empty()
		&& run.finished_unix_ms >= run.started_unix_ms
		&& run.started_unix_ms <= MAX_JCS_SAFE_INTEGER
		&& run.finished_unix_ms <= MAX_JCS_SAFE_INTEGER
}

fn validate_calibration_task_bindings(
	run: &CalibrationRunRecord,
	tasks: &[TaskDefinition],
	bindings_match: fn(&[TaskDefinition]) -> bool,
) -> Result<(), RunValidationError> {
	let task_ids = tasks.iter().map(|task| task.task_id.as_str()).collect::<Vec<_>>();
	let selected_ids = run.task_ids.iter().map(String::as_str).collect::<Vec<_>>();

	if task_ids != selected_ids {
		return Err(RunValidationError::new(
			"supplied tasks do not equal the ordered calibration task selection",
		));
	}
	if !bindings_match(tasks) {
		return Err(RunValidationError::new(
			"supplied calibration tasks do not match the selected catalog identity",
		));
	}

	validate_calibration_task_content(run, tasks)
}

fn validate_calibration_task_content(
	run: &CalibrationRunRecord,
	tasks: &[TaskDefinition],
) -> Result<(), RunValidationError> {
	let task_metadata = collect_task_metadata(&run.results)?;
	let task_set_hash = validate_tasks(tasks, &task_metadata)?;

	if task_set_hash != run.task_set_hash {
		return Err(RunValidationError::new(
			"supplied calibration task definitions do not match the selected task-set hash",
		));
	}

	Ok(())
}

fn calibration_preflight_covers_models(
	preflight_models: &BTreeSet<ModelConfig>,
	selected_models: &BTreeSet<ModelConfig>,
) -> bool {
	preflight_models.iter().all(|model| MODEL_MATRIX.contains(model))
		&& selected_models.is_subset(preflight_models)
}

fn validate_calibration_results<'a>(
	run: &'a CalibrationRunRecord,
	model_set: &BTreeSet<ModelConfig>,
	task_set: &BTreeSet<&'a String>,
) -> Result<(), RunValidationError> {
	validate_completed_command_digest_entry_count(&run.results)?;

	let mut pairs = BTreeSet::new();

	for (index, result) in run.results.iter().enumerate() {
		let expected_model = run.models[index / run.task_ids.len()];
		let expected_task_id = &run.task_ids[index % run.task_ids.len()];
		let execution_attempted = !matches!(
			result.failure.as_ref().map(|failure| failure.kind),
			Some(
				FailureKind::CapabilityUnavailable
					| FailureKind::CapabilityValidationFailed
					| FailureKind::WorkspaceUnavailable
			)
		);

		if result.schema_version != RESULT_SCHEMA_VERSION
			|| !is_sha256(&result.task_hash)
			|| !bounded_identifier(&result.task_id, MAX_TASK_ID_BYTES)
			|| !bounded_identifier(&result.task_version, MAX_TASK_VERSION_BYTES)
		{
			return Err(RunValidationError::new("calibration result identity fields are invalid"));
		}

		validate_response_artifacts(result, execution_attempted)?;
		validate_result_budgets(result, None)?;
		validate_result_status(result, Some(&run.capability_validation))?;
		validate_result_preflight_report(&run.capability_validation, result)?;
		validate_evaluator_and_workspace_evidence(result, execution_attempted, false)?;

		if result.run_id != run.run_id
			|| result.model != expected_model
			|| &result.task_id != expected_task_id
			|| !model_set.contains(&result.model)
			|| !task_set.contains(&result.task_id)
			|| result.provenance.synthetic
			|| result.provenance.node_id != run.capability_validation.node_id
			|| result.provenance.codex_version
				!= run.capability_validation.cli_probe.version.as_deref().unwrap_or_default()
			|| !pairs.insert((result.model, result.task_id.as_str()))
			|| result.content_hash().map_err(|error| RunValidationError::new(error.to_string()))?
				!= result.result_id.replacen("result_", "sha256:", 1)
		{
			return Err(RunValidationError::new(
				"calibration result does not match the signed selection",
			));
		}
	}

	Ok(())
}

fn validate_evaluator_results_bundle_parts(
	artifact: &ArtifactReference,
	results: &[TaskResult],
	bytes: &[u8],
) -> Result<EvaluatorResultsBundle, RunValidationError> {
	if bytes.len() > MAX_EVALUATOR_RESULTS_BUNDLE_BYTES
		|| u64::try_from(bytes.len()).ok() != Some(artifact.bytes)
		|| format!("sha256:{}", hex::encode(Sha256::digest(bytes))) != artifact.content_hash
	{
		return Err(RunValidationError::new(
			"evaluator-results artifact bytes do not match the signed reference",
		));
	}

	let bundle: EvaluatorResultsBundle = serde_json::from_slice(bytes).map_err(|error| {
		RunValidationError::new(format!("evaluator-results artifact is invalid JSON: {error}"))
	})?;
	let canonical = protocol::canonical_json(&bundle)
		.map_err(|error| RunValidationError::new(error.to_string()))?;

	if canonical != bytes
		|| bundle.schema_version != EVALUATOR_RESULTS_SCHEMA_VERSION
		|| bundle.results.len() != results.len()
	{
		return Err(RunValidationError::new(
			"evaluator-results artifact shape or canonical representation is invalid",
		));
	}

	for (result, evaluator_result) in results.iter().zip(&bundle.results) {
		if evaluator_result.is_some() != (result.status == ResultStatus::Completed) {
			return Err(RunValidationError::new(
				"evaluator-results artifact is not aligned with result status",
			));
		}

		let Some(evaluator_result) = evaluator_result else {
			continue;
		};

		evaluator_result.validate_persisted().map_err(|error| {
			RunValidationError::new(format!("evaluator result is invalid: {error}"))
		})?;

		let expected_outcome = match result.evaluation {
			EvaluationOutcome::Correct => EvaluatorOutcome::Correct,
			EvaluationOutcome::Partial => EvaluatorOutcome::Partial,
			EvaluationOutcome::Incorrect => EvaluatorOutcome::Incorrect,
			EvaluationOutcome::NotEvaluated => {
				return Err(RunValidationError::new("completed result lacks an evaluator outcome"));
			},
		};
		let digest = protocol::canonical_hash(evaluator_result)
			.map_err(|error| RunValidationError::new(error.to_string()))?;

		if evaluator_result.outcome != expected_outcome
			|| Some(evaluator_result.score) != result.task_score
			|| Some(digest.as_str()) != result.evaluator_result_sha256.as_deref()
		{
			return Err(RunValidationError::new(
				"evaluator result does not match its signed task result",
			));
		}
	}

	Ok(bundle)
}

fn validate_evaluator_results_artifact(
	artifact: &ArtifactReference,
) -> Result<(), RunValidationError> {
	if artifact.kind != "evaluator-results.json"
		|| artifact.bytes == 0
		|| artifact.bytes > MAX_EVALUATOR_RESULTS_BUNDLE_BYTES as u64
		|| !valid_artifact_reference(artifact)
	{
		return Err(RunValidationError::new("run evaluator-results artifact reference is invalid"));
	}

	Ok(())
}

fn validate_provenance(run: &RunRecord) -> Result<(), RunValidationError> {
	match (&run.provenance, &run.capability_validation, run.synthetic) {
		(None, None, true) => Ok(()),
		(Some(provenance), Some(preflight), false) => {
			let preflight_digest = protocol::canonical_hash(preflight).map_err(|error| {
				RunValidationError::new(format!("capability commitment failed: {error}"))
			})?;

			corpus_commitment::validate_run_provenance(
				provenance,
				&run.task_set_hash,
				&preflight_digest,
			)
			.map_err(|error| RunValidationError::new(error.to_string()))?;

			if provenance.run_class != RunClass::Official {
				return Err(RunValidationError::new(
					"non-synthetic RunRecord is not classified as Official",
				));
			}

			Ok(())
		},
		_ => Err(RunValidationError::new(
			"synthetic runs must omit provenance and real runs must sign complete provenance",
		)),
	}
}

fn collect_task_metadata(
	results: &[TaskResult],
) -> Result<BTreeMap<String, (String, String)>, RunValidationError> {
	let mut metadata = BTreeMap::new();

	for result in results {
		let candidate = (result.task_version.clone(), result.task_hash.clone());

		if metadata
			.insert(result.task_id.clone(), candidate.clone())
			.is_some_and(|existing| existing != candidate)
		{
			return Err(RunValidationError::new(
				"task metadata differs between results for the same task",
			));
		}
	}

	Ok(metadata)
}

fn validate_tasks(
	tasks: &[TaskDefinition],
	metadata: &BTreeMap<String, (String, String)>,
) -> Result<String, RunValidationError> {
	let ids = tasks.iter().map(|task| task.task_id.as_str()).collect::<BTreeSet<_>>();

	if ids.len() != tasks.len() || ids.len() != metadata.len() {
		return Err(RunValidationError::new(
			"task sources contain duplicates or do not match the saved run",
		));
	}

	for task in tasks {
		let expected_hash = task
			.content_hash()
			.map_err(|error| RunValidationError::new(format!("task hash failed: {error}")))?;

		if metadata.get(&task.task_id) != Some(&(task.task_version.clone(), expected_hash)) {
			return Err(RunValidationError::new(
				"saved task version or hash differs from the task source",
			));
		}
	}

	task::task_set_hash(tasks)
		.map_err(|error| RunValidationError::new(format!("task-set hash failed: {error}")))
}

fn validate_preflight(run: &RunRecord) -> Result<(), RunValidationError> {
	if run.synthetic {
		if run.capability_validation.is_some()
			|| run.results.iter().any(|result| !result.provenance.synthetic)
		{
			return Err(RunValidationError::new(
				"synthetic run and result provenance are inconsistent",
			));
		}

		return Ok(());
	}
	if run.results.iter().any(|result| result.provenance.synthetic) {
		return Err(RunValidationError::new(
			"non-synthetic run contains synthetic result provenance",
		));
	}

	let report = run
		.capability_validation
		.as_ref()
		.ok_or_else(|| RunValidationError::new("non-synthetic run lacks preflight evidence"))?;

	if run.results.iter().any(|result| result.provenance.node_id != report.node_id) {
		return Err(RunValidationError::new(
			"result provenance node_id does not match preflight node_id",
		));
	}

	validate_preflight_report(report, true)
}

fn validate_preflight_report(
	report: &CapabilityValidationReport,
	require_full_matrix: bool,
) -> Result<(), RunValidationError> {
	if invalid_preflight_report_header(report, require_full_matrix) {
		return Err(RunValidationError::new("preflight report is incomplete or invalid"));
	}

	let observed_version = report.cli_probe.version.as_deref();
	let mut models = BTreeSet::new();

	for entry in &report.models {
		let recomputed = adapter::configuration_evidence_digest(
			entry.model,
			entry.probe.codex_version.as_ref(),
			&entry.probe.observed_at,
			entry.probe.status,
			entry.probe.result_digest.as_deref(),
			entry.probe.result_preview.as_deref(),
			&entry.probe.artifacts,
			entry.probe.failure.as_ref(),
		)
		.map_err(|error| {
			RunValidationError::new(format!("preflight evidence hash failed: {error}"))
		})?;

		if !models.insert(entry.model)
			|| entry.probe.codex_version.as_deref() != observed_version
			|| !bounded_unescaped_ascii(&entry.reason, MAX_PREFLIGHT_REASON_BYTES)
			|| !is_sha256(&entry.probe.evidence_digest)
			|| entry.probe.evidence_digest != recomputed
			|| !is_unix_millis_observation(&entry.probe.observed_at)
			|| entry
				.probe
				.result_preview
				.as_ref()
				.is_some_and(|preview| preview.len() > MAX_INLINE_PREVIEW_BYTES)
			|| entry.probe.failure.as_ref().is_some_and(|failure| !valid_adapter_failure(failure))
			|| validate_artifact_references(
				&entry.probe.artifacts,
				None,
				MAX_PREFLIGHT_ARTIFACT_REFERENCES,
				&["stdout.jsonl", "stderr.txt", PREFLIGHT_MARKER_ARTIFACT_KIND],
			)
			.is_err() || match entry.probe.status {
			ConfigurationProbeStatus::Available => {
				entry.probe.result_digest.as_ref().is_none_or(|value| !is_sha256(value))
					|| entry.probe.result_preview.is_none()
					|| entry.probe.failure.is_some()
					|| entry
						.probe
						.artifacts
						.iter()
						.filter(|artifact| artifact.kind == PREFLIGHT_MARKER_ARTIFACT_KIND)
						.count() != 1 || !entry.probe.artifacts.iter().any(valid_preflight_marker_reference)
			},
			ConfigurationProbeStatus::ObservedUnsupported | ConfigurationProbeStatus::Failed => {
				entry.probe.result_digest.is_some()
					|| entry.probe.result_preview.is_some()
					|| entry.probe.failure.is_none()
					|| entry
						.probe
						.artifacts
						.iter()
						.any(|artifact| artifact.kind == PREFLIGHT_MARKER_ARTIFACT_KIND)
			},
		} || !matches!(
			(entry.status, entry.probe.status),
			(CapabilityValidationStatus::Available, ConfigurationProbeStatus::Available)
				| (
					CapabilityValidationStatus::Unsupported,
					ConfigurationProbeStatus::ObservedUnsupported
				) | (CapabilityValidationStatus::Unavailable, _)
		) {
			return Err(RunValidationError::new(
				"preflight configuration evidence is inconsistent",
			));
		}
		if entry.probe.status == ConfigurationProbeStatus::Available {
			let digest = entry.probe.result_digest.as_deref().expect("checked above");
			let stdout_artifact =
				entry.probe.artifacts.iter().find(|artifact| artifact.kind == "stdout.jsonl");

			if stdout_artifact.is_some_and(|artifact| artifact.content_hash != digest)
				|| stdout_artifact.is_none()
					&& format!(
						"sha256:{}",
						hex::encode(Sha256::digest(
							entry.probe.result_preview.as_deref().unwrap_or_default().as_bytes()
						))
					) != digest
			{
				return Err(RunValidationError::new(
					"preflight output commitment is not reproducible",
				));
			}
		}
	}

	if require_full_matrix && models != MODEL_MATRIX.into_iter().collect() {
		return Err(RunValidationError::new("preflight does not cover the exact model matrix"));
	}

	Ok(())
}

fn invalid_preflight_report_header(
	report: &CapabilityValidationReport,
	require_full_matrix: bool,
) -> bool {
	report.schema_version != "aiq.capability-validation.v3"
		|| !is_node_id(&report.node_id)
		|| report
			.cli_probe
			.version
			.as_deref()
			.is_none_or(|version| !adapter::safe_codex_version(version))
		|| report.cli_probe.failure.as_ref().is_some_and(|failure| !valid_adapter_failure(failure))
		|| report
			.authentication_probe
			.failure
			.as_ref()
			.is_some_and(|failure| !valid_adapter_failure(failure))
		|| report
			.authentication_probe
			.mode
			.as_deref()
			.is_some_and(|mode| !bounded_identifier(mode, MAX_TOOL_KIND_BYTES))
		|| report.manifest_issues.len() > MODEL_MATRIX.len()
		|| report
			.manifest_issues
			.iter()
			.any(|issue| !bounded_unescaped_ascii(issue, MAX_FAILURE_MESSAGE_BYTES))
		|| report.models.is_empty()
		|| report.models.len() > MODEL_MATRIX.len()
		|| require_full_matrix
			&& (report.cli_probe.status != ProbeStatus::Available
				|| report.authentication_probe.status != ProbeStatus::Available
				|| report.authentication_probe.mode.as_deref() != Some("chatgpt_subscription")
				|| report.authentication_probe.failure.is_some()
				|| !report.manifest_issues.is_empty()
				|| report.models.len() != MODEL_MATRIX.len())
}

fn valid_preflight_marker_reference(artifact: &ArtifactReference) -> bool {
	artifact.kind == PREFLIGHT_MARKER_ARTIFACT_KIND
		&& artifact.content_hash == PREFLIGHT_MARKER_SHA256
		&& artifact.uri
			== format!(
				"aiq-artifact://sha256/{}/{}",
				PREFLIGHT_MARKER_SHA256.trim_start_matches("sha256:"),
				PREFLIGHT_MARKER_ARTIFACT_KIND
			) && artifact.bytes == PREFLIGHT_MARKER_BYTES.len() as u64
}

fn validate_result(
	run: &RunRecord,
	result: &TaskResult,
	metadata: &BTreeMap<String, (String, String)>,
	tasks: Option<&[TaskDefinition]>,
) -> Result<(), RunValidationError> {
	validate_result_identity(run, result, metadata)?;
	validate_response_artifacts(result, execution_attempted(run, result))?;
	validate_result_budgets(result, tasks)?;
	validate_result_status(result, run.capability_validation.as_ref())?;
	validate_result_preflight(run, result)?;

	let selected_task = tasks.and_then(|tasks| {
		tasks
			.iter()
			.find(|task| task.task_id == result.task_id && task.task_version == result.task_version)
	});

	if let Some(task) = selected_task {
		let mut projected = result.tool_usage.clone();

		runner::project_completed_command_digests(task, &mut projected);

		if projected.completed_command_sha256 != result.tool_usage.completed_command_sha256 {
			return Err(RunValidationError::new(
				"completed-command digest evidence is not declared by the task",
			));
		}
	}

	let external_evaluator = selected_task.is_some_and(|task| {
		task.evaluator.as_ref().and_then(|evaluator| evaluator.external.as_ref()).is_some()
	});

	validate_evaluator_and_workspace_evidence(
		result,
		execution_attempted(run, result),
		external_evaluator,
	)?;

	if !run.synthetic
		&& result.provenance.codex_version
			!= run
				.capability_validation
				.as_ref()
				.and_then(|report| report.cli_probe.version.clone())
				.unwrap_or_default()
	{
		return Err(RunValidationError::new(
			"result provenance Codex version does not match preflight",
		));
	}

	Ok(())
}

fn validate_evaluator_and_workspace_evidence(
	result: &TaskResult,
	execution_attempted: bool,
	external_evaluator: bool,
) -> Result<(), RunValidationError> {
	if result.status == ResultStatus::Completed {
		if !is_sha256(result.evaluator_result_sha256.as_deref().unwrap_or_default()) {
			return Err(RunValidationError::new(
				"completed result lacks an evaluator-result digest",
			));
		}
		if external_evaluator
			&& !is_sha256(result.evaluator_stdout_sha256.as_deref().unwrap_or_default())
		{
			return Err(RunValidationError::new(
				"completed external evaluator result lacks its raw stdout digest",
			));
		}
		if !result.evaluator_checks.is_empty() {
			let outcome = match result.evaluation {
				EvaluationOutcome::Correct => EvaluatorOutcome::Correct,
				EvaluationOutcome::Partial => EvaluatorOutcome::Partial,
				EvaluationOutcome::Incorrect => EvaluatorOutcome::Incorrect,
				EvaluationOutcome::NotEvaluated => {
					return Err(RunValidationError::new(
						"completed result lacks an evaluator outcome",
					));
				},
			};
			let evaluation = EvaluationResult {
				schema_version: EVALUATOR_RESULT_SCHEMA_VERSION.to_owned(),
				outcome,
				score: result
					.task_score
					.ok_or_else(|| RunValidationError::new("completed result lacks a score"))?,
				checks: result.evaluator_checks.clone(),
				raw_stdout_sha256: result.evaluator_stdout_sha256.clone(),
			};

			evaluation.validate_persisted().map_err(|error| {
				RunValidationError::new(format!(
					"evaluator check evidence is inconsistent: {error}"
				))
			})?;

			if protocol::canonical_hash(&evaluation)
				.map_err(|error| RunValidationError::new(error.to_string()))?
				!= result.evaluator_result_sha256.as_deref().unwrap_or_default()
			{
				return Err(RunValidationError::new(
					"evaluator check evidence does not match its digest",
				));
			}
		}
	} else if result.evaluator_result_sha256.is_some()
		|| result.evaluator_stdout_sha256.is_some()
		|| !result.evaluator_checks.is_empty()
	{
		return Err(RunValidationError::new(
			"non-completed result contains evaluator-result evidence",
		));
	}

	match (&result.workspace_manifest, execution_attempted) {
		(Some(artifact), true)
			if valid_artifact_reference(artifact) && artifact.kind == "workspace-manifest.json" =>
		{
			Ok(())
		},
		(None, true)
			if result
				.failure
				.as_ref()
				.is_some_and(|failure| failure.kind == FailureKind::WorkspaceIntegrity) =>
		{
			Ok(())
		},
		(None, false) => Ok(()),
		_ => Err(RunValidationError::new(
			"workspace manifest evidence is inconsistent with execution status",
		)),
	}
}

fn execution_attempted(run: &RunRecord, result: &TaskResult) -> bool {
	!run.synthetic
		&& !matches!(
			result.failure.as_ref().map(|failure| failure.kind),
			Some(
				FailureKind::CapabilityUnavailable
					| FailureKind::CapabilityValidationFailed
					| FailureKind::WorkspaceUnavailable
			)
		)
}

fn validate_result_identity(
	run: &RunRecord,
	result: &TaskResult,
	metadata: &BTreeMap<String, (String, String)>,
) -> Result<(), RunValidationError> {
	if result.schema_version != RESULT_SCHEMA_VERSION
		|| result.run_id != run.run_id
		|| !run.models.contains(&result.model)
		|| !bounded_identifier(&result.task_id, MAX_TASK_ID_BYTES)
		|| !bounded_identifier(&result.task_version, MAX_TASK_VERSION_BYTES)
		|| !is_sha256(&result.task_hash)
		|| metadata.get(&result.task_id)
			!= Some(&(result.task_version.clone(), result.task_hash.clone()))
	{
		return Err(RunValidationError::new("result identity fields are inconsistent"));
	}

	let expected_result_id = format!(
		"result_{}",
		result
			.content_hash()
			.map_err(|error| RunValidationError::new(format!("result hash failed: {error}")))?
			.trim_start_matches("sha256:")
	);

	if result.result_id != expected_result_id {
		return Err(RunValidationError::new("result_id does not match result content"));
	}

	Ok(())
}

fn validate_result_budgets(
	result: &TaskResult,
	tasks: Option<&[TaskDefinition]>,
) -> Result<(), RunValidationError> {
	let provider_tokens = &result.tool_usage.provider_tokens;
	let provider_counters = [
		provider_tokens.input,
		provider_tokens.cached_input,
		provider_tokens.cache_write_input,
		provider_tokens.output,
		provider_tokens.reasoning,
		provider_tokens.total,
	];

	if result.tool_usage.by_tool.len() > MAX_TOOL_USAGE_KINDS
		|| result.tool_usage.completed_command_sha256.len() > MAX_COMPLETED_COMMAND_DIGESTS
		|| result.latency.wall_ms > MAX_JCS_SAFE_INTEGER
		|| result.latency.evaluator_ms > MAX_JCS_SAFE_INTEGER
		|| provider_counters.into_iter().flatten().any(|value| value > MAX_JCS_SAFE_INTEGER)
		|| matches!((provider_tokens.input, provider_tokens.cached_input), (Some(input), Some(cached)) if cached > input)
		|| matches!(
			(provider_tokens.input, provider_tokens.cached_input, provider_tokens.cache_write_input),
			(Some(input), Some(cached), Some(cache_write)) if cached.saturating_add(cache_write) > input
		) || matches!((provider_tokens.output, provider_tokens.reasoning), (Some(output), Some(reasoning)) if reasoning > output)
		|| result
			.tool_usage
			.by_tool
			.keys()
			.any(|kind| !bounded_identifier(kind, MAX_TOOL_KIND_BYTES))
		|| result.tool_usage.by_tool.values().fold(0_u32, |sum, count| sum.saturating_add(*count))
			!= result.tool_usage.total_calls
		|| result
			.tool_usage
			.completed_command_sha256
			.iter()
			.any(|(digest, count)| !is_lower_sha256(digest) || *count == 0)
		|| result
			.tool_usage
			.completed_command_sha256
			.values()
			.map(|count| u64::from(*count))
			.sum::<u64>()
			> u64::from(result.tool_usage.by_tool.get("command_execution").copied().unwrap_or(0))
		|| !bounded_unescaped_ascii(&result.provenance.runner_version, MAX_RUNNER_VERSION_BYTES)
		|| !adapter::safe_codex_version(&result.provenance.codex_version)
		|| if result.provenance.synthetic {
			result.provenance.observed_at != "synthetic"
		} else {
			!is_unix_millis_observation(&result.provenance.observed_at)
		} || result.failure.as_ref().is_some_and(|failure| {
		!bounded_unescaped_ascii(&failure.message, MAX_FAILURE_MESSAGE_BYTES)
	}) {
		return Err(RunValidationError::new(
			"result signed strings or tool counters exceed their wire bounds",
		));
	}

	if let Some(task) =
		tasks.and_then(|tasks| tasks.iter().find(|task| task.task_id == result.task_id))
	{
		let exceeds_wall_budget = task.budgets.wall_seconds.is_some_and(|wall_seconds| {
			result.latency.wall_ms > wall_seconds.saturating_mul(1_000).saturating_add(1_000)
		});
		let budget_failure = result
			.failure
			.as_ref()
			.is_some_and(|failure| failure.kind == FailureKind::BudgetExceeded);

		if exceeds_wall_budget
			|| (!budget_failure
				&& task.budgets.max_steps.is_some_and(|limit| result.tool_usage.steps > limit))
			|| (!budget_failure
				&& task
					.budgets
					.max_tool_calls
					.is_some_and(|limit| result.tool_usage.total_calls > limit))
		{
			return Err(RunValidationError::new(
				"Codex adapter elapsed time or live tool counters exceed the task budgets",
			));
		}
	}

	Ok(())
}

fn validate_completed_command_digest_entry_count(
	results: &[TaskResult],
) -> Result<(), RunValidationError> {
	let entries = results.iter().try_fold(0_usize, |total, result| {
		total.checked_add(result.tool_usage.completed_command_sha256.len())
	});

	if entries.is_none_or(|entries| entries > MAX_COMPLETED_COMMAND_DIGEST_ENTRIES_PER_RUN) {
		return Err(RunValidationError::new(
			"run has too many task-declared completed-command digest entries",
		));
	}

	Ok(())
}

fn bounded_identifier(value: &str, maximum: usize) -> bool {
	!value.is_empty()
		&& value.len() <= maximum
		&& value
			.bytes()
			.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn bounded_unescaped_ascii(value: &str, maximum: usize) -> bool {
	!value.is_empty()
		&& value.len() <= maximum
		&& value.bytes().all(|byte| (b' '..=b'~').contains(&byte) && !matches!(byte, b'"' | b'\\'))
}

fn is_unix_millis_observation(value: &str) -> bool {
	value.strip_prefix("unix-ms:").is_some_and(|milliseconds| {
		!milliseconds.is_empty()
			&& milliseconds.len() <= u128::MAX.to_string().len()
			&& milliseconds.bytes().all(|byte| byte.is_ascii_digit())
	})
}

fn valid_adapter_failure(failure: &AdapterFailure) -> bool {
	bounded_unescaped_ascii(&failure.message, MAX_FAILURE_MESSAGE_BYTES)
		&& failure.stderr.len() <= MAX_INLINE_PREVIEW_BYTES
		&& validate_artifact_references(
			&failure.artifacts,
			None,
			MAX_PREFLIGHT_ARTIFACT_REFERENCES,
			&["stdout.jsonl", "stderr.txt"],
		)
		.is_ok()
}

fn validate_result_status(
	result: &TaskResult,
	capability_validation: Option<&CapabilityValidationReport>,
) -> Result<(), RunValidationError> {
	match result.status {
		ResultStatus::Completed => {
			let score_consistent = match (result.evaluation, result.task_score) {
				(EvaluationOutcome::Correct, Some(score)) => score == 1.0,
				(EvaluationOutcome::Incorrect, Some(score)) => score == 0.0,
				(EvaluationOutcome::Partial, Some(score)) => score > 0.0 && score < 1.0,
				_ => false,
			};

			if !score_consistent || result.failure.is_some() || result.response.is_none() {
				return Err(RunValidationError::new("completed result fields are inconsistent"));
			}
		},
		ResultStatus::Unevaluated => {
			if result.evaluation != EvaluationOutcome::NotEvaluated
				|| result.task_score.is_some()
				|| result.response.is_none()
				|| result.failure.as_ref().map(|failure| failure.kind)
					!= Some(FailureKind::MissingEvaluator)
			{
				return Err(RunValidationError::new("unevaluated result fields are inconsistent"));
			}
		},
		ResultStatus::Unsupported => {
			let report = capability_validation.ok_or_else(|| {
				RunValidationError::new("unsupported result lacks preflight evidence")
			})?;

			if result.evaluation != EvaluationOutcome::NotEvaluated
				|| result.task_score.is_some()
				|| result.response.is_some()
				|| result.failure.as_ref().map(|failure| failure.kind)
					!= Some(FailureKind::CapabilityUnavailable)
				|| !report.model(result.model).is_some_and(|entry| {
					entry.status == CapabilityValidationStatus::Unsupported
						&& entry.probe.status == ConfigurationProbeStatus::ObservedUnsupported
				}) {
				return Err(RunValidationError::new(
					"unsupported result is not backed by active preflight evidence",
				));
			}
		},
		ResultStatus::Failed => {
			if result.evaluation != EvaluationOutcome::NotEvaluated || result.failure.is_none() {
				return Err(RunValidationError::new("failed result fields are inconsistent"));
			}

			let failure = result.failure.as_ref().expect("checked above");
			let expected_score = match failure.kind {
				FailureKind::Timeout
				| FailureKind::UnsupportedModel
				| FailureKind::NonZeroExit
				| FailureKind::MissingResponse
				| FailureKind::BudgetExceeded
				| FailureKind::OutputTruncated
				| FailureKind::Spawn
				| FailureKind::Authentication
				| FailureKind::SubscriptionLimit
				| FailureKind::CapabilityValidationFailed
				| FailureKind::EvaluatorFailure
				| FailureKind::WorkspaceUnavailable
				| FailureKind::WorkspaceIntegrity => None,
				FailureKind::CapabilityUnavailable | FailureKind::MissingEvaluator => {
					return Err(RunValidationError::new(
						"failure taxonomy is incompatible with failed status",
					));
				},
			};

			if result.task_score != expected_score {
				return Err(RunValidationError::new(
					"failed result score does not match its failure taxonomy",
				));
			}

			let evaluator_failure = failure.kind == FailureKind::EvaluatorFailure;

			if result.response.is_some() != evaluator_failure {
				return Err(RunValidationError::new(
					"failed result response is inconsistent with its failure taxonomy",
				));
			}
		},
	}

	Ok(())
}

fn validate_result_preflight(
	run: &RunRecord,
	result: &TaskResult,
) -> Result<(), RunValidationError> {
	if let Some(report) = run.capability_validation.as_ref() {
		validate_result_preflight_report(report, result)?;
	}

	Ok(())
}

fn validate_result_preflight_report(
	report: &CapabilityValidationReport,
	result: &TaskResult,
) -> Result<(), RunValidationError> {
	if let Some(entry) = report.model(result.model) {
		match entry.status {
			CapabilityValidationStatus::Available if result.status == ResultStatus::Unsupported => {
				return Err(RunValidationError::new(
					"available preflight configuration has an unsupported result",
				));
			},
			CapabilityValidationStatus::Unsupported
				if result.status != ResultStatus::Unsupported =>
			{
				return Err(RunValidationError::new(
					"observed-unsupported preflight does not match its results",
				));
			},
			CapabilityValidationStatus::Unavailable
				if result.status != ResultStatus::Failed
					|| result.failure.as_ref().map(|failure| failure.kind)
						!= Some(FailureKind::CapabilityValidationFailed) =>
			{
				return Err(RunValidationError::new(
					"unavailable preflight does not match its validation-failure results",
				));
			},
			_ => {},
		}
	}

	Ok(())
}

fn validate_response_artifacts(
	result: &TaskResult,
	execution_attempted: bool,
) -> Result<(), RunValidationError> {
	if result.response.as_ref().is_some_and(|response| response.len() > MAX_RESULT_PREVIEW_BYTES) {
		return Err(RunValidationError::new("result response exceeds the inline preview bound"));
	}

	validate_artifact_references(
		&result.artifacts,
		result.workspace_manifest.as_ref(),
		MAX_RESULT_ARTIFACT_REFERENCES,
		&["stdout.jsonl", "stderr.txt", "final-response.txt", "workspace-snapshot.json"],
	)?;

	let workspace_snapshots = result
		.artifacts
		.iter()
		.filter(|artifact| artifact.kind == "workspace-snapshot.json")
		.count();
	let workspace_integrity = result
		.failure
		.as_ref()
		.is_some_and(|failure| failure.kind == FailureKind::WorkspaceIntegrity);

	if execution_attempted && !workspace_integrity && workspace_snapshots != 1 {
		return Err(RunValidationError::new(
			"attempted result requires exactly one workspace snapshot",
		));
	}
	if workspace_integrity && workspace_snapshots > 1 {
		return Err(RunValidationError::new(
			"workspace-integrity result contains duplicate workspace snapshots",
		));
	}
	if workspace_integrity && (result.workspace_manifest.is_some() != (workspace_snapshots == 1)) {
		return Err(RunValidationError::new(
			"workspace-integrity result must retain both workspace commitments or neither",
		));
	}
	if !execution_attempted
		&& result.artifacts.iter().any(|artifact| artifact.kind == "workspace-snapshot.json")
	{
		return Err(RunValidationError::new("unattempted result contains a workspace snapshot"));
	}

	match (&result.response, &result.response_sha256) {
		(None, None) => Ok(()),
		(Some(response), Some(digest)) if is_sha256(digest) => {
			if let Some(artifact) =
				result.artifacts.iter().find(|artifact| artifact.kind == "final-response.txt")
			{
				if &artifact.content_hash != digest {
					return Err(RunValidationError::new(
						"final response artifact and digest differ",
					));
				}
			} else {
				let expected =
					format!("sha256:{}", hex::encode(Sha256::digest(response.as_bytes())));

				if &expected != digest {
					return Err(RunValidationError::new(
						"inline response does not match its digest",
					));
				}
			}

			Ok(())
		},
		_ => Err(RunValidationError::new("response and complete-response digest are inconsistent")),
	}
}

fn validate_artifact_references(
	artifacts: &[ArtifactReference],
	workspace_manifest: Option<&ArtifactReference>,
	max_artifacts: usize,
	allowed_kinds: &[&str],
) -> Result<(), RunValidationError> {
	if artifacts.len() > max_artifacts {
		return Err(RunValidationError::new("artifact reference count exceeds its bound"));
	}

	let mut kinds = BTreeSet::new();
	let mut content_hashes = BTreeMap::new();
	let mut uris = BTreeSet::new();

	for artifact in artifacts.iter().chain(workspace_manifest) {
		if !valid_artifact_reference(artifact)
			|| !kinds.insert(artifact.kind.as_str())
			|| !uris.insert(artifact.uri.as_str())
			|| content_hashes
				.insert(artifact.content_hash.as_str(), artifact.bytes)
				.is_some_and(|bytes| bytes != artifact.bytes)
		{
			return Err(RunValidationError::new(
				"artifact references are invalid, duplicated, or ambiguous",
			));
		}
	}

	if artifacts.iter().any(|artifact| !allowed_kinds.contains(&artifact.kind.as_str())) {
		return Err(RunValidationError::new("artifact role is invalid at this boundary"));
	}
	if workspace_manifest.is_some_and(|artifact| artifact.kind != "workspace-manifest.json") {
		return Err(RunValidationError::new("workspace manifest artifact role is invalid"));
	}

	Ok(())
}

fn is_sha256(value: &str) -> bool {
	value.strip_prefix("sha256:").is_some_and(|digest| {
		digest.len() == 64
			&& digest.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
			&& !digest.bytes().all(|byte| byte == b'0')
	})
}

fn is_lower_sha256(value: &str) -> bool {
	value.strip_prefix("sha256:").is_some_and(|digest| {
		digest.len() == 64
			&& digest.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
	})
}

fn is_node_id(value: &str) -> bool {
	value.strip_prefix("node_").is_some_and(|digest| {
		digest.len() == 64
			&& digest.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
	})
}

#[cfg(test)]
mod tests {
	use std::{
		collections::{BTreeMap, BTreeSet},
		mem,
	};

	use sha2::{Digest, Sha256};

	use crate::{
		adapter::{
			self, ArtifactReference, ArtifactSink, AuthenticationProbe, CapabilityValidation,
			CapabilityValidationReport, CapabilityValidationStatus, CliProbe, ConfigurationProbe,
			ConfigurationProbeStatus, ProbeStatus,
		},
		corpus_commitment::{self, RunClass},
		model::{MODEL_MATRIX, ModelConfig, ModelFamily, ReasoningEffort},
		protocol::{self, ResultProvenance, TrustTier},
		resume, run_validation,
		runner::{
			self, EvaluationOutcome, FailureKind, Latency, RESULT_SCHEMA_VERSION, ResultFailure,
			ResultStatus, RunRecord, TaskResult, ToolUsage,
		},
		schedule::{self, ScheduleConfig, ScheduleOccurrence},
		scoring::{self, AIQ_SCORING_VERSION},
		task::{self, EvaluatorCheck, EvaluatorCheckFailureClass},
	};

	#[test]
	fn stable_workspace_integrity_message_satisfies_the_signed_wire_bound() {
		let slot = ScheduleConfig::default()
			.slot("2026-08-02", ScheduleOccurrence::Day)
			.expect("fixture slot");
		let mut run =
			runner::synthetic_demo(slot, &runner::TestArtifactSink).expect("synthetic fixture");
		let result = &mut run.results[0];

		result.failure = Some(ResultFailure {
			kind: FailureKind::WorkspaceIntegrity,
			message: "post-evaluation workspace integrity or cleanup failed".to_owned(),
			exit_code: Some(17),
			retryable: true,
		});

		super::validate_result_budgets(result, None)
			.expect("stable workspace-integrity message must fit the wire");

		result.failure.as_mut().expect("failure").message = r#"hostile "quoted" path"#.to_owned();

		assert!(super::validate_result_budgets(result, None).is_err());

		result.failure.as_mut().expect("failure").message = "x".repeat(129);

		assert!(super::validate_result_budgets(result, None).is_err());
	}

	#[test]
	fn unbounded_tasks_accept_elapsed_time_steps_and_tool_calls_as_measurements() {
		let slot = ScheduleConfig::default()
			.slot("2026-08-02", ScheduleOccurrence::Day)
			.expect("fixture slot");
		let mut run =
			runner::synthetic_demo(slot, &runner::TestArtifactSink).expect("synthetic fixture");
		let mut tasks = runner::synthetic_tasks();
		let result = &mut run.results[0];
		let task_index = tasks
			.iter_mut()
			.position(|task| task.task_id == result.task_id)
			.expect("matching task");

		result.latency.wall_ms = 600_000;
		tasks[task_index].budgets.wall_seconds = Some(1);

		assert!(super::validate_result_budgets(result, Some(&tasks)).is_err());

		tasks[task_index].budgets.wall_seconds = None;
		result.latency.evaluator_ms = super::MAX_JCS_SAFE_INTEGER;

		super::validate_result_budgets(result, Some(&tasks))
			.expect("model and evaluator elapsed time are descriptive without a model deadline");

		result.latency.wall_ms = 1_000;
		tasks[task_index].budgets.wall_seconds = Some(1);

		super::validate_result_budgets(result, Some(&tasks))
			.expect("evaluator elapsed time cannot enter the model wall-time gate");

		tasks[task_index].budgets.wall_seconds = None;
		tasks[task_index].budgets.max_steps = None;
		tasks[task_index].budgets.max_tool_calls = None;
		result.tool_usage.steps = 10_000;
		result.tool_usage.total_calls = 9_999;
		result.tool_usage.by_tool =
			BTreeMap::from([("command_execution".to_owned(), result.tool_usage.total_calls)]);

		super::validate_result_budgets(result, Some(&tasks))
			.expect("steps and tool calls are descriptive when their limits are null");

		tasks[task_index].budgets.max_steps = Some(9_999);

		assert!(super::validate_result_budgets(result, Some(&tasks)).is_err());

		tasks[task_index].budgets.max_steps = None;
		tasks[task_index].budgets.max_tool_calls = Some(9_998);

		assert!(super::validate_result_budgets(result, Some(&tasks)).is_err());
	}

	#[test]
	fn completed_command_digest_counts_are_bounded_and_cannot_exceed_command_calls() {
		let slot = ScheduleConfig::default()
			.slot("2026-08-02", ScheduleOccurrence::Day)
			.expect("fixture slot");
		let mut run =
			runner::synthetic_demo(slot, &runner::TestArtifactSink).expect("synthetic fixture");
		let result = &mut run.results[0];
		let digest = "sha256:6763cc80f8294b52c6494f1c9891e41a8e3cd1c466ca622377c59643a0466319";

		result.tool_usage.total_calls = 1;
		result.tool_usage.by_tool = BTreeMap::from([("command_execution".to_owned(), 1)]);
		result.tool_usage.completed_command_sha256 = BTreeMap::from([(digest.to_owned(), 1)]);

		super::validate_result_budgets(result, None).expect("bounded completed command digest");

		result.tool_usage.completed_command_sha256.insert(digest.to_owned(), 2);

		assert!(super::validate_result_budgets(result, None).is_err());

		result.tool_usage.completed_command_sha256.insert(digest.to_owned(), 0);

		assert!(super::validate_result_budgets(result, None).is_err());

		result.tool_usage.completed_command_sha256 = BTreeMap::from([(
			"sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".to_owned(),
			1,
		)]);

		assert!(super::validate_result_budgets(result, None).is_err());

		result.tool_usage.total_calls = u32::MAX;
		result.tool_usage.by_tool = BTreeMap::from([("command_execution".to_owned(), u32::MAX)]);
		result.tool_usage.completed_command_sha256 = (1..=super::MAX_COMPLETED_COMMAND_DIGESTS + 1)
			.map(|index| (format!("sha256:{index:064x}"), 1))
			.collect();

		assert!(super::validate_result_budgets(result, None).is_err());
	}

	#[test]
	fn calibration_preflight_may_retain_the_full_matrix_but_must_cover_the_selection() {
		let selected = [MODEL_MATRIX[0]].into_iter().collect();
		let full_preflight = MODEL_MATRIX.into_iter().collect();

		assert!(super::calibration_preflight_covers_models(&full_preflight, &selected));
		assert!(!super::calibration_preflight_covers_models(&BTreeSet::new(), &selected));

		let mut invalid_preflight = full_preflight;

		invalid_preflight.insert(ModelConfig {
			family: ModelFamily::Luna,
			reasoning_effort: ReasoningEffort::Ultra,
		});

		assert!(!super::calibration_preflight_covers_models(&invalid_preflight, &selected));
	}

	#[test]
	fn terminal_attempt_replacement_and_multiple_selection_fail_closed() {
		let (tasks, mut run) = large_synthetic_fixture();
		let selected = run.terminal_attempt_lineage.first_mut().expect("lineage cell");

		selected.terminal_result_ids.push(format!("result_{}", "f".repeat(64)));

		selected.selected_result_id = selected.terminal_result_ids[1].clone();

		let error = super::validate_run_record(&run, Some(&tasks))
			.expect_err("replacement lineage must be rejected");

		assert!(error.to_string().contains("terminal-attempt lineage"));
	}

	fn large_synthetic_fixture() -> (Vec<crate::task::TaskDefinition>, RunRecord) {
		let template = runner::synthetic_tasks().remove(0);
		let tasks = (0..72)
			.map(|index| {
				let mut task = template.clone();

				task.task_id = format!("scale-{index:02}");

				task
			})
			.collect::<Vec<_>>();
		let slot = ScheduleConfig::default()
			.slot("2024-02-29", ScheduleOccurrence::Day)
			.expect("slot must validate");
		let set_hash = task::task_set_hash(&tasks).expect("tasks must hash");
		let run_id =
			schedule::idempotent_run_id(&slot, &set_hash, &MODEL_MATRIX, AIQ_SCORING_VERSION)
				.expect("run id");
		let mut results = Vec::new();

		for model in MODEL_MATRIX {
			for task in &tasks {
				let response = "OK".to_owned();
				let mut result = TaskResult {
					schema_version: RESULT_SCHEMA_VERSION.to_owned(),
					result_id: String::new(),
					run_id: run_id.clone(),
					task_id: task.task_id.clone(),
					task_version: task.task_version.clone(),
					task_hash: task.content_hash().expect("task hash"),
					model,
					status: ResultStatus::Completed,
					evaluation: EvaluationOutcome::Correct,
					task_score: Some(1.0),
					response: Some(response.clone()),
					response_sha256: Some(format!(
						"sha256:{}",
						hex::encode(Sha256::digest(response.as_bytes()))
					)),
					evaluator_result_sha256: None,
					evaluator_stdout_sha256: None,
					artifacts: Vec::new(),
					failure: None,
					latency: Latency { wall_ms: 1, evaluator_ms: 0 },
					tool_usage: ToolUsage::default(),
					evaluator_checks: vec![EvaluatorCheck {
						check_id: "exact_match".to_owned(),
						weight: 1,
						passed: true,
						failure_class: EvaluatorCheckFailureClass::None,
						evidence_digest: format!(
							"sha256:{}",
							hex::encode(Sha256::digest(response.as_bytes()))
						),
					}],
					workspace_manifest: None,
					provenance: ResultProvenance {
						node_id: "node_synthetic".to_owned(),
						runner_version: env!("CARGO_PKG_VERSION").to_owned(),
						codex_version: "synthetic-not-invoked".to_owned(),
						observed_at: "synthetic".to_owned(),
						synthetic: true,
						local_trust: TrustTier::Untrusted,
					},
				};

				result.bind_evaluator_result_digest().expect("evaluator digest");

				result.result_id = format!(
					"result_{}",
					result.content_hash().expect("result hash").trim_start_matches("sha256:")
				);

				results.push(result);
			}
		}

		(
			tasks,
			RunRecord {
				schema_version: super::RUN_SCHEMA_VERSION.to_owned(),
				run_id,
				schedule_slot: slot,
				task_set_hash: set_hash,
				scoring_version: AIQ_SCORING_VERSION.to_owned(),
				calibration_admission_digest: None,
				calibration_bank: None,
				execution_concurrency: Some(1),
				models: MODEL_MATRIX.to_vec(),
				started_unix_ms: 0,
				finished_unix_ms: 0,
				synthetic: true,
				capability_validation: None,
				provenance: None,
				evaluator_results_artifact: ArtifactReference {
					kind: "evaluator-results.json".to_owned(),
					content_hash: format!("sha256:{}", "a".repeat(64)),
					uri: format!("aiq-artifact://sha256/{}/evaluator-results.json", "a".repeat(64)),
					bytes: 1,
				},
				terminal_attempt_lineage: runner::terminal_attempt_lineage(&results),
				results,
			},
		)
	}

	fn assert_artifact_invariants(tasks: &[crate::task::TaskDefinition], run: &RunRecord) {
		let mut missing_snapshot = run.clone();

		missing_snapshot.results[0].artifacts.clear();

		missing_snapshot.results[0].result_id = format!(
			"result_{}",
			missing_snapshot.results[0]
				.content_hash()
				.expect("result hash")
				.trim_start_matches("sha256:")
		);

		assert!(run_validation::validate_run_record(&missing_snapshot, Some(tasks)).is_err());

		let mut duplicate_role = run.clone();
		let duplicate = duplicate_role.results[0].artifacts[0].clone();

		duplicate_role.results[0].artifacts.push(duplicate);

		duplicate_role.results[0].result_id = format!(
			"result_{}",
			duplicate_role.results[0]
				.content_hash()
				.expect("result hash")
				.trim_start_matches("sha256:")
		);

		assert!(run_validation::validate_run_record(&duplicate_role, Some(tasks)).is_err());

		let mut shared_digest = run.clone();
		let response_digest =
			shared_digest.results[0].response_sha256.clone().expect("response digest");

		shared_digest.results[0].artifacts.push(ArtifactReference {
			kind: "stdout.jsonl".to_owned(),
			content_hash: response_digest.clone(),
			uri: format!(
				"aiq-artifact://sha256/{}/stdout.jsonl",
				response_digest.trim_start_matches("sha256:")
			),
			bytes: 2,
		});
		shared_digest.results[0].artifacts.push(ArtifactReference {
			kind: "final-response.txt".to_owned(),
			content_hash: response_digest.clone(),
			uri: format!(
				"aiq-artifact://sha256/{}/final-response.txt",
				response_digest.trim_start_matches("sha256:")
			),
			bytes: 2,
		});

		shared_digest.results[0].result_id = format!(
			"result_{}",
			shared_digest.results[0]
				.content_hash()
				.expect("result hash")
				.trim_start_matches("sha256:")
		);
		shared_digest.terminal_attempt_lineage =
			runner::terminal_attempt_lineage(&shared_digest.results);

		run_validation::validate_run_record(&shared_digest, Some(tasks))
			.expect("distinct roles may bind the same exact bytes");

		let mut conflicting_size = shared_digest;

		conflicting_size.results[0].artifacts[1].bytes = 3;
		conflicting_size.results[0].result_id = format!(
			"result_{}",
			conflicting_size.results[0]
				.content_hash()
				.expect("result hash")
				.trim_start_matches("sha256:")
		);

		assert!(run_validation::validate_run_record(&conflicting_size, Some(tasks)).is_err());

		let mut malformed_address = run.clone();

		malformed_address.results[0].artifacts[0].uri =
			"aiq-artifact://sha256/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/stderr.txt"
				.to_owned();
		malformed_address.results[0].result_id = format!(
			"result_{}",
			malformed_address.results[0]
				.content_hash()
				.expect("result hash")
				.trim_start_matches("sha256:")
		);

		assert!(run_validation::validate_run_record(&malformed_address, Some(tasks)).is_err());
	}

	fn artifact_reference(kind: &str, marker: char, bytes: u64) -> ArtifactReference {
		let digest = marker.to_string().repeat(64);

		ArtifactReference {
			kind: kind.to_owned(),
			content_hash: format!("sha256:{digest}"),
			uri: format!("aiq-artifact://sha256/{digest}/{kind}"),
			bytes,
		}
	}

	#[test]
	fn validates_full_1224_result_record_and_detects_tampering() {
		let (tasks, mut run) = large_synthetic_fixture();

		assert_eq!(run.results.len(), 1_224);

		run_validation::validate_run_record(&run, Some(&tasks)).expect("large run must validate");

		run.results[0].task_score = Some(0.0);

		assert!(run_validation::validate_run_record(&run, Some(&tasks)).is_err());
	}

	#[test]
	fn completed_command_digest_run_cap_preserves_the_signed_package_bound() {
		fn add_digest(run: &mut RunRecord, index: usize, digest: &str) {
			let result = &mut run.results[index];

			result.tool_usage.total_calls = 1;
			result.tool_usage.by_tool = BTreeMap::from([("command_execution".to_owned(), 1)]);
			result.tool_usage.completed_command_sha256 = BTreeMap::from([(digest.to_owned(), 1)]);
			result.result_id = format!(
				"result_{}",
				result.content_hash().expect("result hash").trim_start_matches("sha256:")
			);

			let lineage = &mut run.terminal_attempt_lineage[index];

			lineage.terminal_result_ids = vec![result.result_id.clone()];
			lineage.selected_result_id = result.result_id.clone();
		}

		let (_tasks, mut run) = large_synthetic_fixture();
		let digest = format!("sha256:{}", "f".repeat(64));

		for index in 0..runner::MAX_COMPLETED_COMMAND_DIGEST_ENTRIES_PER_RUN {
			add_digest(&mut run, index, &digest);
		}

		super::validate_completed_command_digest_entry_count(&run.results)
			.expect("run-wide completed command digest cap");

		add_digest(&mut run, runner::MAX_COMPLETED_COMMAND_DIGEST_ENTRIES_PER_RUN, &digest);

		assert!(super::validate_completed_command_digest_entry_count(&run.results).is_err());
	}

	#[test]
	fn rejects_zero_signed_digests_and_rebound_zero_task_hashes() {
		let (tasks, run) = large_synthetic_fixture();
		let zero_digest = format!("sha256:{}", "0".repeat(64));
		let mut zero_bundle = run.clone();

		zero_bundle.evaluator_results_artifact.content_hash = zero_digest.clone();
		zero_bundle.evaluator_results_artifact.uri =
			format!("aiq-artifact://sha256/{}/evaluator-results.json", "0".repeat(64));

		assert!(run_validation::validate_run_record(&zero_bundle, Some(&tasks)).is_err());

		let mut zero_evaluator = run.clone();

		zero_evaluator.results[0].evaluator_checks.clear();

		zero_evaluator.results[0].evaluator_result_sha256 = Some(zero_digest.clone());
		zero_evaluator.results[0].result_id = format!(
			"result_{}",
			zero_evaluator.results[0]
				.content_hash()
				.expect("zero evaluator fixture hash")
				.trim_start_matches("sha256:")
		);

		assert!(run_validation::validate_run_record(&zero_evaluator, Some(&tasks)).is_err());

		let mut zero_response = run.clone();

		zero_response.results[0].response_sha256 = Some(zero_digest.clone());

		zero_response.results[0].artifacts.push(ArtifactReference {
			kind: "final-response.txt".to_owned(),
			content_hash: zero_digest.clone(),
			uri: format!("aiq-artifact://sha256/{}/final-response.txt", "0".repeat(64)),
			bytes: 2,
		});

		zero_response.results[0].result_id = format!(
			"result_{}",
			zero_response.results[0]
				.content_hash()
				.expect("zero response fixture hash")
				.trim_start_matches("sha256:")
		);

		assert!(run_validation::validate_run_record(&zero_response, Some(&tasks)).is_err());

		let mut zero_task = run;
		let target_task = zero_task.results[0].task_id.clone();

		for result in &mut zero_task.results {
			if result.task_id == target_task {
				result.task_hash.clone_from(&zero_digest);
			}
		}

		let mut task_hashes = zero_task
			.results
			.iter()
			.map(|result| (result.task_id.clone(), result.task_hash.clone()))
			.collect::<BTreeMap<_, _>>()
			.into_values()
			.collect::<Vec<_>>();

		task_hashes.sort();

		zero_task.task_set_hash = protocol::canonical_hash(&task_hashes).expect("task-set hash");
		zero_task.run_id = schedule::idempotent_run_id(
			&zero_task.schedule_slot,
			&zero_task.task_set_hash,
			&zero_task.models,
			&zero_task.scoring_version,
		)
		.expect("rebound run id");

		for result in &mut zero_task.results {
			result.run_id.clone_from(&zero_task.run_id);

			result.result_id = format!(
				"result_{}",
				result.content_hash().expect("rebound result hash").trim_start_matches("sha256:")
			);
		}

		assert!(run_validation::validate_run_record(&zero_task, None).is_err());
	}

	#[test]
	fn evaluator_results_bundle_is_canonical_positional_and_digest_bound() {
		let (_, mut run) = large_synthetic_fixture();
		let (bundle, bytes) = runner::build_evaluator_results_bundle(&run.results).expect("bundle");

		run.evaluator_results_artifact = runner::TestArtifactSink
			.put("evaluator-results.json", &bytes)
			.expect("bundle reference");

		run_validation::validate_evaluator_results_bundle(&run, &bytes)
			.expect("bundle must validate");

		let mut changed = bundle;

		changed.results[0].as_mut().expect("completed result").checks[0].evidence_digest =
			format!("sha256:{}", "b".repeat(64));

		let changed = protocol::canonical_json(&changed).expect("changed bundle");
		let changed_reference = runner::TestArtifactSink
			.put("evaluator-results.json", &changed)
			.expect("changed reference");
		let original_reference =
			mem::replace(&mut run.evaluator_results_artifact, changed_reference);

		assert!(run_validation::validate_evaluator_results_bundle(&run, &changed).is_err());

		run.evaluator_results_artifact = original_reference;

		let noncanonical = [bytes.as_slice(), b"\n"].concat();

		assert!(run_validation::validate_evaluator_results_bundle(&run, &noncanonical).is_err());
	}

	#[test]
	fn signed_task_result_rejects_unsupported_inline_evaluator_checks() {
		let (_, run) = large_synthetic_fixture();
		let mut value = serde_json::to_value(&run.results[0]).expect("result value");

		value
			.as_object_mut()
			.expect("result object")
			.insert("evaluator_checks".to_owned(), serde_json::json!([]));

		assert!(serde_json::from_value::<TaskResult>(value).is_err());
	}

	#[test]
	fn signed_task_result_requires_explicit_evaluator_stdout_binding() {
		let (_, run) = large_synthetic_fixture();
		let mut value = serde_json::to_value(&run.results[0]).expect("result value");

		value
			.as_object_mut()
			.expect("result object")
			.remove("evaluator_stdout_sha256")
			.expect("explicit evaluator stdout binding");

		assert!(serde_json::from_value::<TaskResult>(value).is_err());
	}

	#[test]
	fn rejects_duplicate_task_model_pairs() {
		let (tasks, mut run) = large_synthetic_fixture();

		run.results[1] = run.results[0].clone();

		assert!(run_validation::validate_run_record(&run, Some(&tasks)).is_err());
	}

	fn rebind_preflight(candidate: &mut RunRecord) {
		let report = candidate.capability_validation.as_mut().expect("preflight report");
		let entry = report.models.first_mut().expect("first capability entry");

		entry.probe.evidence_digest = adapter::configuration_evidence_digest(
			entry.model,
			entry.probe.codex_version.as_ref(),
			&entry.probe.observed_at,
			entry.probe.status,
			entry.probe.result_digest.as_deref(),
			entry.probe.result_preview.as_deref(),
			&entry.probe.artifacts,
			entry.probe.failure.as_ref(),
		)
		.expect("rebound capability evidence");
		candidate.provenance.as_mut().expect("production provenance").preflight_digest =
			protocol::canonical_hash(report).expect("rebound preflight digest");
	}

	fn assert_functional_marker_binding(tasks: &[crate::task::TaskDefinition], run: &RunRecord) {
		let mut missing_marker = run.clone();

		missing_marker.capability_validation.as_mut().expect("report").models[0]
			.probe
			.artifacts
			.clear();

		rebind_preflight(&mut missing_marker);

		assert!(run_validation::validate_run_record(&missing_marker, Some(tasks)).is_err());

		let mut wrong_marker = run.clone();
		let marker = &mut wrong_marker.capability_validation.as_mut().expect("report").models[0]
			.probe
			.artifacts[0];

		marker.content_hash = format!("sha256:{}", "a".repeat(64));
		marker.uri = format!(
			"aiq-artifact://sha256/{}/{}",
			"a".repeat(64),
			adapter::PREFLIGHT_MARKER_ARTIFACT_KIND
		);

		rebind_preflight(&mut wrong_marker);

		assert!(run_validation::validate_run_record(&wrong_marker, Some(tasks)).is_err());
	}

	#[test]
	fn non_synthetic_preflight_digest_and_node_identity_are_bound() {
		let (tasks, mut run) = large_synthetic_fixture();
		let node_id = format!("node_{}", "b".repeat(64));
		let codex_version = "codex fixture".to_owned();
		let models = MODEL_MATRIX
			.into_iter()
			.map(|model| {
				let preview = "AIQ_PREFLIGHT_OK".to_owned();
				let artifacts = vec![adapter::preflight_marker_artifact_reference()];
				let result_digest =
					format!("sha256:{}", hex::encode(Sha256::digest(preview.as_bytes())));
				let observed_at = "unix-ms:1".to_owned();
				let evidence_digest = adapter::configuration_evidence_digest(
					model,
					Some(&codex_version),
					&observed_at,
					ConfigurationProbeStatus::Available,
					Some(&result_digest),
					Some(&preview),
					&artifacts,
					None,
				)
				.expect("evidence digest");

				CapabilityValidation {
					model,
					status: CapabilityValidationStatus::Available,
					reason: "active probe succeeded".to_owned(),
					probe: ConfigurationProbe {
						status: ConfigurationProbeStatus::Available,
						codex_version: Some(codex_version.clone()),
						observed_at,
						result_digest: Some(result_digest),
						result_preview: Some(preview),
						artifacts,
						evidence_digest,
						failure: None,
					},
				}
			})
			.collect();

		run.synthetic = false;
		run.run_id = resume::classified_run_id(
			&run.schedule_slot,
			&run.task_set_hash,
			&format!("sha256:{}", "1".repeat(64)),
			&run.models,
			RunClass::Official,
		)
		.expect("official run id");
		run.capability_validation = Some(CapabilityValidationReport {
			schema_version: "aiq.capability-validation.v3".to_owned(),
			node_id: node_id.clone(),
			manifest_issues: Vec::new(),
			cli_probe: CliProbe {
				status: ProbeStatus::Available,
				version: Some(codex_version.clone()),
				failure: None,
			},
			authentication_probe: AuthenticationProbe {
				status: ProbeStatus::Available,
				mode: Some("chatgpt_subscription".to_owned()),
				failure: None,
			},
			models,
		});

		let preflight_digest =
			protocol::canonical_hash(run.capability_validation.as_ref().expect("report"))
				.expect("preflight digest");

		run.provenance = Some(corpus_commitment::fixture_run_provenance(
			run.task_set_hash.clone(),
			format!("sha256:{}", "8".repeat(64)),
			format!("sha256:{}", "9".repeat(64)),
			preflight_digest,
		));

		for result in &mut run.results {
			result.run_id.clone_from(&run.run_id);

			result.provenance.synthetic = false;
			result.provenance.node_id = node_id.clone();
			result.provenance.observed_at = "unix-ms:1".to_owned();

			result.artifacts.push(artifact_reference("workspace-snapshot.json", 'b', 84));

			result.workspace_manifest =
				Some(artifact_reference("workspace-manifest.json", 'a', 42));

			result.provenance.codex_version.clone_from(&codex_version);

			result.result_id = format!(
				"result_{}",
				result.content_hash().expect("result hash").trim_start_matches("sha256:")
			);
		}

		run.calibration_bank = Some(scoring::fixture_frozen_calibration_bank(&tasks));
		run.calibration_admission_digest = Some(format!("sha256:{}", "2".repeat(64)));
		run.terminal_attempt_lineage = runner::terminal_attempt_lineage(&run.results);

		run_validation::validate_run_record(&run, Some(&tasks))
			.expect("bound real run must validate");

		assert_artifact_invariants(&tasks, &run);
		assert_functional_marker_binding(&tasks, &run);

		run.capability_validation.as_mut().expect("report").models[0].probe.evidence_digest =
			format!("sha256:{}", "c".repeat(64));

		assert!(run_validation::validate_run_record(&run, Some(&tasks)).is_err());
	}
}
