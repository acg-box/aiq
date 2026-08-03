//! Exact model-free Official planning and permission-admission receipt contract.

use serde::{Deserialize, Serialize};

use crate::{adapter::ManagedPermissionProfileEvidence, schedule::ScheduleSlot};

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct OfficialOutputPlan {
	pub(crate) preflight_cache: String,
	pub(crate) preflight_attempt: String,
	pub(crate) checkpoint: String,
	pub(crate) run_output: String,
	pub(crate) score_output: String,
	pub(crate) package_output: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct OfficialPlanBinding {
	pub(crate) run_id: String,
	pub(crate) task_ids: Vec<String>,
	pub(crate) task_set_hash: String,
	pub(crate) corpus_commitment_digest: String,
	pub(crate) catalog_digest: String,
	pub(crate) source_manifest_digest: String,
	pub(crate) evaluator_digest: String,
	pub(crate) capability_manifest_digest: String,
	pub(crate) model_toolchain_digest: String,
	pub(crate) evaluator_runtime_digest: String,
	pub(crate) runner_executable_digest: String,
	pub(crate) codex_executable_digest: String,
	pub(crate) codex_credential_digest: String,
	pub(crate) public_tasks: Option<String>,
	pub(crate) hidden_tasks: Option<String>,
	pub(crate) corpus_commitment: String,
	pub(crate) capabilities: String,
	pub(crate) source_root: String,
	pub(crate) workspace_root: String,
	pub(crate) execution_root: String,
	pub(crate) evaluator_root: String,
	pub(crate) evaluator_runtime: String,
	pub(crate) codex_toolchain_root: String,
	pub(crate) artifact_root: String,
	pub(crate) codex_home: String,
	pub(crate) codex_binary: String,
	pub(crate) codex_egress_proxy: String,
	pub(crate) schedule: String,
	pub(crate) schedule_digest: String,
	pub(crate) slot: ScheduleSlot,
	pub(crate) observed_at: String,
	pub(crate) jobs: usize,
	pub(crate) conservative_capacity_digest: String,
	pub(crate) outputs: OfficialOutputPlan,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PermissionAdmissionReport {
	pub(crate) schema_version: String,
	pub(crate) official_permission_eligible: bool,
	pub(crate) model_invoked: bool,
	pub(crate) observed_unix_ms: u64,
	pub(crate) managed_profile: Option<ManagedPermissionProfileEvidence>,
	pub(crate) permission_policy_digest: Option<String>,
	pub(crate) canary_digest: Option<String>,
	pub(crate) permission_evidence_digest: Option<String>,
	pub(crate) plan: Option<OfficialPlanBinding>,
	pub(crate) failure: Option<String>,
}
