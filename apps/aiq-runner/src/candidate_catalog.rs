//! AIQ Core 1.1.0 candidate-catalog authority shared by authoring and qualification.

use std::{
	collections::{BTreeMap, BTreeSet},
	error::Error,
	fmt::{Display, Formatter},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
	protocol,
	task::{Domain, TaskDefinition},
};

/// Candidate catalog schema introduced for explicit fixture applicability.
pub const CANDIDATE_CATALOG_SCHEMA_VERSION: &str = "aiq.catalog.v2";
/// Exact source-foundation task-set version.
pub const CANDIDATE_TASK_SET_VERSION: &str = "1.1.0";
/// Exact source-only candidate identity accepted by the checked candidate boundary.
pub const CANDIDATE_ID: &str = "aiq-core/1.1.0-candidate.14";
/// Exact candidate catalog path. This does not replace the active 1.0.7 catalog.
pub const CANDIDATE_CATALOG_PATH: &str = "benchmarks/candidates/aiq-core-1.1.0/catalog.json";
/// Exact candidate task schema path.
pub const CANDIDATE_TASK_SCHEMA_PATH: &str =
	"benchmarks/candidates/aiq-core-1.1.0/task.schema.json";
/// Generator that owns the candidate catalog bytes.
pub const CANDIDATE_CATALOG_GENERATOR_PATH: &str =
	"scripts/candidates/aiq-core-1.1.0/generate-benchmark-catalog.ts";
/// Generic source validator shared with private candidate authoring checks.
pub const CANDIDATE_PRIVATE_AUTHORING_VALIDATOR_PATH: &str =
	"scripts/candidates/aiq-core-1.1.0/private-authoring-validator.ts";
/// Independent public-safe task response-mode and location authority.
pub const CANDIDATE_TASK_RESPONSE_AUTHORITY_PATH: &str =
	"benchmarks/candidates/aiq-core-1.1.0/task-response-authority.json";

const REQUIRED_ACCEPTANCE_CLASSES: [&str; 4] =
	["adversarial_format", "alternate_correct", "gold", "partial"];
const OPTIONAL_ACCEPTANCE_CLASSES: [&str; 2] = ["empty", "timeout"];

/// Candidate lifecycle state recorded in the public catalog.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CandidateCatalogStatus {
	/// Public source foundation with unresolved controlled authoring inputs.
	DraftSourceFoundation,
	/// Immutable source identity ready for independent review and later sealing.
	FrozenCandidate,
	/// Immutable rejected candidate. A new candidate identity is required for another attempt.
	Failed,
}

/// Explicit per-task design decision.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CandidateTaskDecision {
	/// Retain the predecessor task semantics under the new candidate identity.
	Retained,
	/// Revise task semantics under the new candidate identity.
	Revised,
}

/// Catalog-owned applicability for one acceptance fixture class.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FixtureApplicability {
	/// The controlled acceptance suite must contain this class.
	Required,
	/// The controlled acceptance suite must not contain this class.
	NotApplicable,
	/// Private evidence is not yet reconciled; sealing must fail closed.
	PendingPrivateReconciliation,
}

/// One catalog task after candidate-authority validation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CandidateTaskAuthority {
	/// Ordered task identifier.
	pub task_id: String,
	/// Stable task domain.
	pub domain: Domain,
	/// Explicit within-domain qualification cluster.
	pub cluster_id: String,
	/// Explicit retained or revised decision.
	pub decision: CandidateTaskDecision,
	/// Canonical digest of the exact full public catalog entry.
	pub catalog_entry_digest: String,
	fixture_applicability: BTreeMap<String, FixtureApplicability>,
}
impl CandidateTaskAuthority {
	/// Returns the exact class set expected by this catalog entry.
	///
	/// A draft entry with an unresolved class returns an error and cannot be sealed.
	pub fn expected_acceptance_classes(&self) -> Result<BTreeSet<String>, CandidateCatalogError> {
		if self
			.fixture_applicability
			.values()
			.any(|value| *value == FixtureApplicability::PendingPrivateReconciliation)
		{
			return Err(CandidateCatalogError::new(format!(
				"candidate task {} has unresolved fixture applicability",
				self.task_id
			)));
		}

		Ok(self
			.fixture_applicability
			.iter()
			.filter(|(_, applicability)| **applicability == FixtureApplicability::Required)
			.map(|(class, _)| class.clone())
			.collect())
	}
}

/// Validated public authority for one exact AIQ Core 1.1.0 candidate.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CandidateCatalogAuthority {
	/// Candidate lifecycle state.
	pub status: CandidateCatalogStatus,
	/// Exact candidate identity. A failed candidate must not reuse it.
	pub candidate_id: String,
	/// Canonical digest of the ordered full task metadata.
	pub task_metadata_digest: String,
	/// Canonical digest of the complete catalog document supplied to the validator.
	pub catalog_digest: String,
	/// Ordered task authorities.
	pub tasks: Vec<CandidateTaskAuthority>,
}
impl CandidateCatalogAuthority {
	/// Returns task authority by exact identifier.
	#[must_use]
	pub fn task(&self, task_id: &str) -> Option<&CandidateTaskAuthority> {
		self.tasks.iter().find(|task| task.task_id == task_id)
	}

	/// Requires a frozen, resolved candidate before sealing or qualification.
	pub fn require_frozen_candidate(&self) -> Result<(), CandidateCatalogError> {
		if self.status != CandidateCatalogStatus::FrozenCandidate {
			return Err(CandidateCatalogError::new("candidate catalog is not frozen_candidate"));
		}

		for task in &self.tasks {
			task.expected_acceptance_classes()?;
		}

		Ok(())
	}
}

/// Candidate catalog validation failure.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CandidateCatalogError {
	message: String,
}
impl CandidateCatalogError {
	fn new(message: impl Into<String>) -> Self {
		Self { message: message.into() }
	}
}
impl Error for CandidateCatalogError {}
impl Display for CandidateCatalogError {
	fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
		formatter.write_str(&self.message)
	}
}

#[derive(Deserialize)]
struct CandidateCatalogInput {
	schema_version: String,
	task_set_id: String,
	task_set_version: String,
	scoring_version: String,
	status: CandidateCatalogStatus,
	candidate_identity: CandidateIdentityInput,
	tasks: Vec<CandidateTaskInput>,
}

#[derive(Deserialize)]
struct CandidateIdentityInput {
	candidate_id: String,
	task_metadata_digest: String,
}

#[derive(Deserialize)]
struct CandidateTaskInput {
	task_id: String,
	task_version: String,
	domain: Domain,
	cluster_id: String,
	design_revision: CandidateDesignRevisionInput,
	evaluator: CandidateEvaluatorInput,
}

#[derive(Deserialize)]
struct CandidateDesignRevisionInput {
	supersedes_task_version: String,
	decision: CandidateTaskDecision,
	decision_record: String,
}

#[derive(Deserialize)]
struct CandidateEvaluatorInput {
	scorer_version: String,
	acceptance_fixture_commitments: BTreeMap<String, FixtureDeclarationInput>,
}

#[derive(Deserialize)]
struct FixtureDeclarationInput {
	applicability: FixtureApplicability,
	handle: Option<String>,
}

/// Validates the exact public candidate document without consulting private inputs.
pub fn validate_candidate_catalog(
	value: &Value,
) -> Result<CandidateCatalogAuthority, CandidateCatalogError> {
	let input: CandidateCatalogInput = serde_json::from_value(value.clone()).map_err(|error| {
		CandidateCatalogError::new(format!("candidate catalog is invalid: {error}"))
	})?;
	let task_values = value
		.get("tasks")
		.and_then(Value::as_array)
		.ok_or_else(|| CandidateCatalogError::new("candidate catalog tasks are not an array"))?;

	validate_catalog_header(&input)?;

	if input.tasks.len() != 72 || task_values.len() != input.tasks.len() {
		return Err(CandidateCatalogError::new("candidate catalog must contain exactly 72 tasks"));
	}

	let observed_task_metadata_digest = protocol::canonical_hash(task_values).map_err(|error| {
		CandidateCatalogError::new(format!("cannot hash candidate task metadata: {error}"))
	})?;

	if observed_task_metadata_digest != input.candidate_identity.task_metadata_digest {
		return Err(CandidateCatalogError::new(
			"candidate task metadata does not match its declared digest",
		));
	}

	let mut task_ids = BTreeSet::new();
	let supersedes_task_version = if matches!(
		input.candidate_identity.candidate_id.as_str(),
		"aiq-core/1.1.0-candidate.3"
			| "aiq-core/1.1.0-candidate.4"
			| "aiq-core/1.1.0-candidate.5"
			| "aiq-core/1.1.0-candidate.6"
			| "aiq-core/1.1.0-candidate.7"
			| "aiq-core/1.1.0-candidate.8"
			| "aiq-core/1.1.0-candidate.9"
			| "aiq-core/1.1.0-candidate.10"
			| "aiq-core/1.1.0-candidate.11"
			| "aiq-core/1.1.0-candidate.12"
			| "aiq-core/1.1.0-candidate.13"
			| "aiq-core/1.1.0-candidate.14"
	) {
		"1.1.0"
	} else {
		"1.0.7"
	};
	let tasks = input
		.tasks
		.into_iter()
		.zip(task_values)
		.map(|(task, raw)| {
			validate_candidate_task(task, raw, input.status, supersedes_task_version, &mut task_ids)
		})
		.collect::<Result<Vec<_>, _>>()?;
	let catalog_digest = protocol::canonical_hash(value).map_err(|error| {
		CandidateCatalogError::new(format!("cannot hash candidate catalog: {error}"))
	})?;

	Ok(CandidateCatalogAuthority {
		status: input.status,
		candidate_id: input.candidate_identity.candidate_id,
		task_metadata_digest: observed_task_metadata_digest,
		catalog_digest,
		tasks,
	})
}

pub(crate) fn task_bindings_match_checked_candidate(tasks: &[TaskDefinition]) -> bool {
	let Ok(catalog) = checked_candidate_catalog_authority() else { return false };

	tasks.len() == catalog.tasks.len()
		&& tasks.iter().zip(&catalog.tasks).all(|(task, expected)| {
			task.task_id == expected.task_id
				&& task.task_version == CANDIDATE_TASK_SET_VERSION
				&& task.domain == expected.domain
				&& task.cluster_id.as_deref() == Some(expected.cluster_id.as_str())
				&& task.catalog_entry_digest.as_deref()
					== Some(expected.catalog_entry_digest.as_str())
				&& task.scorer_version == "1.0.6"
		})
}

/// Orders exact candidate task sources by the checked catalog authority.
pub(crate) fn order_tasks_by_checked_candidate(
	tasks: &mut [TaskDefinition],
) -> Result<(), CandidateCatalogError> {
	let catalog = checked_candidate_catalog_authority()?;
	let positions = catalog
		.tasks
		.iter()
		.enumerate()
		.map(|(index, task)| (task.task_id.as_str(), index))
		.collect::<BTreeMap<_, _>>();

	if tasks.len() != catalog.tasks.len()
		|| tasks.iter().any(|task| !positions.contains_key(task.task_id.as_str()))
	{
		return Err(CandidateCatalogError::new(
			"candidate task sources do not match the checked catalog",
		));
	}

	tasks.sort_by_key(|task| positions.get(task.task_id.as_str()).copied().unwrap_or(usize::MAX));

	Ok(())
}

pub(crate) fn checked_candidate_catalog_authority()
-> Result<CandidateCatalogAuthority, CandidateCatalogError> {
	let value = serde_json::from_str::<Value>(include_str!(
		"../../../benchmarks/candidates/aiq-core-1.1.0/catalog.json"
	))
	.map_err(|error| CandidateCatalogError::new(format!("checked candidate catalog: {error}")))?;

	validate_candidate_catalog(&value)
}

fn validate_catalog_header(input: &CandidateCatalogInput) -> Result<(), CandidateCatalogError> {
	if input.schema_version != CANDIDATE_CATALOG_SCHEMA_VERSION
		|| input.task_set_id != "aiq-core"
		|| input.task_set_version != CANDIDATE_TASK_SET_VERSION
		|| input.scoring_version != "1.0.6"
		|| input.candidate_identity.candidate_id != CANDIDATE_ID
		|| !valid_candidate_id(&input.candidate_identity.candidate_id)
		|| !valid_digest(&input.candidate_identity.task_metadata_digest)
	{
		return Err(CandidateCatalogError::new("candidate catalog header or identity is invalid"));
	}

	Ok(())
}

fn validate_candidate_task(
	task: CandidateTaskInput,
	raw: &Value,
	status: CandidateCatalogStatus,
	supersedes_task_version: &str,
	task_ids: &mut BTreeSet<String>,
) -> Result<CandidateTaskAuthority, CandidateCatalogError> {
	if !valid_task_id(&task.task_id)
		|| !task_ids.insert(task.task_id.clone())
		|| task.task_version != CANDIDATE_TASK_SET_VERSION
		|| !valid_cluster_id(&task.cluster_id)
		|| task.design_revision.supersedes_task_version != supersedes_task_version
		|| task.design_revision.decision_record
			!= "benchmarks/candidates/aiq-core-1.1.0/design-decisions.json"
		|| task.evaluator.scorer_version != "1.0.6"
	{
		return Err(CandidateCatalogError::new(format!(
			"candidate task {} identity or design decision is invalid",
			task.task_id
		)));
	}

	let fixture_applicability = validate_fixture_declarations(
		&task.task_id,
		task.evaluator.acceptance_fixture_commitments,
		status,
	)?;
	let catalog_entry_digest = protocol::canonical_hash(raw).map_err(|error| {
		CandidateCatalogError::new(format!("cannot hash candidate catalog entry: {error}"))
	})?;

	Ok(CandidateTaskAuthority {
		task_id: task.task_id,
		domain: task.domain,
		cluster_id: task.cluster_id,
		decision: task.design_revision.decision,
		catalog_entry_digest,
		fixture_applicability,
	})
}

fn validate_fixture_declarations(
	task_id: &str,
	declarations: BTreeMap<String, FixtureDeclarationInput>,
	status: CandidateCatalogStatus,
) -> Result<BTreeMap<String, FixtureApplicability>, CandidateCatalogError> {
	let expected = REQUIRED_ACCEPTANCE_CLASSES
		.into_iter()
		.chain(OPTIONAL_ACCEPTANCE_CLASSES)
		.collect::<BTreeSet<_>>();

	if declarations.keys().map(String::as_str).collect::<BTreeSet<_>>() != expected {
		return Err(CandidateCatalogError::new(format!(
			"candidate task {task_id} must declare exactly six acceptance classes"
		)));
	}

	let mut applicability = BTreeMap::new();

	for (class, declaration) in declarations {
		let required_class = REQUIRED_ACCEPTANCE_CLASSES.contains(&class.as_str());

		if required_class && declaration.applicability != FixtureApplicability::Required {
			return Err(CandidateCatalogError::new(format!(
				"candidate task {task_id} makes required class {class} non-required"
			)));
		}
		if status == CandidateCatalogStatus::FrozenCandidate
			&& declaration.applicability == FixtureApplicability::PendingPrivateReconciliation
		{
			return Err(CandidateCatalogError::new(format!(
				"frozen candidate task {task_id} has pending fixture applicability"
			)));
		}

		validate_fixture_handle(task_id, &class, &declaration)?;

		applicability.insert(class, declaration.applicability);
	}

	Ok(applicability)
}

fn validate_fixture_handle(
	task_id: &str,
	class: &str,
	declaration: &FixtureDeclarationInput,
) -> Result<(), CandidateCatalogError> {
	let handle_class = class.replace('_', "-");

	match (declaration.applicability, declaration.handle.as_deref()) {
		(FixtureApplicability::Required, Some(handle))
			if handle.starts_with(&format!("aiq-acceptance://{task_id}/"))
				&& handle.ends_with(&format!("/{handle_class}")) => {},
		(
			FixtureApplicability::NotApplicable
			| FixtureApplicability::PendingPrivateReconciliation,
			None,
		) => {},
		_ => {
			return Err(CandidateCatalogError::new(format!(
				"candidate task {task_id} has an invalid {class} fixture handle"
			)));
		},
	}

	Ok(())
}

fn valid_candidate_id(value: &str) -> bool {
	(1..=128).contains(&value.len())
		&& value
			.bytes()
			.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b'/'))
}

fn valid_task_id(value: &str) -> bool {
	(1..=64).contains(&value.len())
		&& value.split('-').all(|part| {
			!part.is_empty()
				&& part.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
		})
}

fn valid_cluster_id(value: &str) -> bool {
	let Some((prefix, ordinal)) = value.rsplit_once("-cluster-") else {
		return false;
	};

	!prefix.is_empty()
		&& prefix.bytes().all(|byte| byte.is_ascii_lowercase() || byte == b'_')
		&& ordinal.len() == 2
		&& ordinal.bytes().all(|byte| byte.is_ascii_digit())
}

fn valid_digest(value: &str) -> bool {
	value.len() == 71
		&& value.starts_with("sha256:")
		&& value[7..].bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

#[cfg(test)]
mod tests {
	use serde_json::{self, Value};

	use crate::{candidate_catalog, protocol};

	fn fixture(status: &str) -> Value {
		let tasks = (0..72)
			.map(|index| {
				let task_id = format!("coding-{index:02}");

				serde_json::json!({
					"task_id": task_id,
					"task_version": "1.1.0",
					"domain": "coding",
					"cluster_id": format!("coding-cluster-{index:02}"),
					"design_revision": {
						"supersedes_task_version": "1.1.0",
						"decision": "retained",
						"decision_record": "benchmarks/candidates/aiq-core-1.1.0/design-decisions.json"
					},
					"evaluator": {
						"scorer_version": "1.0.6",
						"acceptance_fixture_commitments": {
							"adversarial_format": {"applicability":"required","handle":format!("aiq-acceptance://{task_id}/v4/adversarial-format")},
							"alternate_correct": {"applicability":"required","handle":format!("aiq-acceptance://{task_id}/v4/alternate-correct")},
							"empty": {"applicability":"pending_private_reconciliation","handle":null},
							"gold": {"applicability":"required","handle":format!("aiq-acceptance://{task_id}/v4/gold")},
							"partial": {"applicability":"required","handle":format!("aiq-acceptance://{task_id}/v4/partial")},
							"timeout": {"applicability":"pending_private_reconciliation","handle":null}
						}
					}
				})
			})
			.collect::<Vec<_>>();
		let task_metadata_digest = protocol::canonical_hash(&tasks).expect("task digest");

		serde_json::json!({
			"schema_version": "aiq.catalog.v2",
			"task_set_id": "aiq-core",
			"task_set_version": "1.1.0",
			"scoring_version": "1.0.6",
			"status": status,
			"candidate_identity": {
				"candidate_id": candidate_catalog::CANDIDATE_ID,
				"task_metadata_digest": task_metadata_digest
			},
			"tasks": tasks
		})
	}

	#[test]
	fn draft_catalog_records_explicit_decisions_but_blocks_sealing() {
		let catalog =
			candidate_catalog::validate_candidate_catalog(&fixture("draft_source_foundation"))
				.expect("draft catalog");

		assert_eq!(catalog.tasks.len(), 72);
		assert!(catalog.require_frozen_candidate().is_err());
	}

	#[test]
	fn checked_in_candidate_is_frozen_resolved_authority() {
		let value: Value = serde_json::from_str(include_str!(
			"../../../benchmarks/candidates/aiq-core-1.1.0/catalog.json"
		))
		.expect("checked candidate catalog");
		let catalog =
			candidate_catalog::validate_candidate_catalog(&value).expect("candidate authority");

		assert_eq!(catalog.tasks.len(), 72);
		assert_eq!(catalog.status, candidate_catalog::CandidateCatalogStatus::FrozenCandidate);
		assert_eq!(catalog.candidate_id, "aiq-core/1.1.0-candidate.14");

		catalog.require_frozen_candidate().expect("frozen candidate");

		let mut stale = value;

		stale["candidate_identity"]["candidate_id"] =
			serde_json::json!("aiq-core/1.1.0-candidate.13");

		assert!(candidate_catalog::validate_candidate_catalog(&stale).is_err());
	}

	#[test]
	fn frozen_catalog_requires_resolved_exact_fixture_authority() {
		let mut value = fixture("frozen_candidate");

		assert!(candidate_catalog::validate_candidate_catalog(&value).is_err());

		for task in value["tasks"].as_array_mut().expect("tasks") {
			let task_id = task["task_id"].as_str().expect("task id").to_owned();

			task["evaluator"]["acceptance_fixture_commitments"]["empty"] = serde_json::json!({"applicability":"required","handle":format!("aiq-acceptance://{task_id}/v6/empty")});
			task["evaluator"]["acceptance_fixture_commitments"]["timeout"] =
				serde_json::json!({"applicability":"not_applicable","handle":null});
		}

		let tasks = value["tasks"].as_array().expect("tasks");

		value["candidate_identity"]["task_metadata_digest"] =
			serde_json::json!(protocol::canonical_hash(tasks).expect("task digest"));

		let catalog =
			candidate_catalog::validate_candidate_catalog(&value).expect("frozen catalog");

		catalog.require_frozen_candidate().expect("frozen authority");

		assert_eq!(catalog.tasks[0].expected_acceptance_classes().expect("classes").len(), 5);
	}

	#[test]
	fn catalog_tamper_and_incomplete_decisions_fail_closed() {
		let mut value = fixture("draft_source_foundation");

		value["tasks"][0]["design_revision"]["decision_record"] = serde_json::json!("other.json");

		assert!(candidate_catalog::validate_candidate_catalog(&value).is_err());

		let mut value = fixture("draft_source_foundation");

		value["tasks"].as_array_mut().expect("tasks").pop();

		assert!(candidate_catalog::validate_candidate_catalog(&value).is_err());
	}
}
