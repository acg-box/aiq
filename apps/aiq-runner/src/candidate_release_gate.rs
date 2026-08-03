//! Private candidate release-gate execution authorization and output handling.
//!
//! The public TypeScript `aiq.release-gate-admission.v1` document is the only
//! release-gate admission contract. This module consumes that contract. It
//! does not create a second public admission. The Rust-only authorization
//! signs the exact private execution plan, controlled commitment references,
//! and create-once output locations before any model callback can run.

use std::fs::Metadata;
use std::io::ErrorKind;
use std::process;
use std::{
	collections::{BTreeMap, BTreeSet},
	env,
	fmt::{Display, Formatter},
	fs::{self, File, OpenOptions},
	io::{self, Read as _, Seek as _, SeekFrom, Write as _},
	path::{Component, Path, PathBuf},
	sync::atomic::{AtomicU64, Ordering},
};
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::{ffi::CString, os::unix::ffi::OsStrExt as _};
#[cfg(unix)]
use std::{
	os::fd::AsRawFd as _,
	os::unix::fs::{MetadataExt as _, OpenOptionsExt as _, PermissionsExt as _},
};

use ed25519_dalek::{Signature, Signer as _, SigningKey, Verifier as _, VerifyingKey};
use jiff::Timestamp;
#[cfg(target_os = "macos")]
use libc::RENAME_SWAP;
#[cfg(target_os = "linux")]
use libc::{AT_FDCWD, RENAME_EXCHANGE, SYS_renameat2};
#[cfg(unix)]
use libc::{LOCK_EX, LOCK_NB, O_CLOEXEC, O_NOFOLLOW};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest as _, Sha256};

use crate::runner::MAX_RUN_JOBS;
use crate::{corpus_commitment, protocol, task::EvaluatorRuntime};

/// Candidate task-set version.
pub const CANDIDATE_TASK_SET_VERSION: &str = "1.0.2";
/// Candidate evaluator version.
pub const CANDIDATE_SCORER_VERSION: &str = "1.0.2";
/// Exact ordered public candidate task metadata identity.
pub const CANDIDATE_TASK_IDENTITY_SHA256: &str =
	"sha256:2c5efe162b49e710e6e52b0f3a4e33d1127d0dd54d4f15694f88911bcb7fc937";
/// Exact candidate catalog release identity.
pub const CANDIDATE_CATALOG_RELEASE_IDENTITY_SHA256: &str =
	"sha256:45bf2e9d5287fd4f83e46bc3cb5c3ccb8778756465e81bfd567d111480eefc4b";
/// Exact canonical-to-execution model mapping commitment.
pub const CANDIDATE_MODEL_ID_MAPPING_SHA256: &str =
	"sha256:f8912fa9d2360077736993daf01dd023c1d7a0d97f208380a761f65e8401e592";
/// Exact fixed ordered four-field model-matrix commitment.
pub const CANDIDATE_MODEL_MATRIX_SHA256: &str =
	"sha256:c385d79e02d233b4594800a66199c2da59e8f6fd623fb808812a669ccba29757";
/// Protected runtime pin for the public candidate release trust policy.
pub const CANDIDATE_TRUST_POLICY_DIGEST_ENV: &str = "AIQ_CORE_1_0_2_RELEASE_TRUST_POLICY_SHA256";
/// Public release admission schema owned by the TypeScript release protocol.
pub const RELEASE_GATE_ADMISSION_SCHEMA: &str = "aiq.release-gate-admission.v1";
/// Small public-safe outer corpus manifest schema.
pub const RELEASE_GATE_CORPUS_MANIFEST_SCHEMA: &str = "aiq.release-gate-corpus-manifest.v1";
/// Private execution plan schema.
pub const CANDIDATE_EXECUTION_PLAN_SCHEMA: &str = "aiq.candidate-execution-plan.v1";
/// Private authorization schema. It is intentionally not an admission schema.
pub const CANDIDATE_EXECUTION_AUTHORIZATION_SCHEMA: &str =
	"aiq.candidate-execution-authorization.v1";
/// Four-component candidate evaluator result schema.
pub const CANDIDATE_EVALUATOR_RESULT_SCHEMA: &str = "aiq.candidate-evaluator-result.v1";
/// Immutable candidate release identity shared by private artifact protocols.
pub const RELEASE_IDENTITY: &str = "aiq-core/1.0.2";
/// Exact runner-side proxy endpoint for the fixed candidate container topology.
pub const CANDIDATE_CODEX_EGRESS_PROXY_ENDPOINT: &str = "http://10.248.34.2:3128";
/// Maximum canonical public authority or trust-policy document size.
pub const MAX_CANDIDATE_PUBLIC_AUTHORITY_BYTES: u64 = 4 * 1_024 * 1_024;
/// Number of public core tasks.
pub const CANDIDATE_CORE_TASK_COUNT: usize = CORE_TASK_COUNT;
/// Number of canonical model configurations.
pub const CANDIDATE_MODEL_COUNT: usize = MODEL_COUNT;
/// Number of preregistered repeats.
pub const CANDIDATE_REPEAT_COUNT: usize = REPEAT_COUNT;
/// Number of exact execution units across all repeats.
pub const CANDIDATE_EXECUTION_UNIT_COUNT: usize = EXECUTION_UNIT_COUNT;
/// Number of create-once unit bundle paths.
pub const CANDIDATE_UNIT_OUTPUT_COUNT: usize = UNIT_OUTPUT_COUNT;
/// Number of create-once unit and aggregate paths.
pub const CANDIDATE_TOTAL_OUTPUT_COUNT: usize = UNIT_OUTPUT_COUNT + 2;
/// Number of public core observations.
pub const CANDIDATE_CORE_OBSERVATION_COUNT: u64 = CORE_OBSERVATION_COUNT;
/// Number of paired contrast comparisons.
pub const CANDIDATE_CONTRAST_PAIR_COUNT: u64 = CONTRAST_PAIR_COUNT;
/// Number of contrast-arm observations.
pub const CANDIDATE_CONTRAST_OBSERVATION_COUNT: u64 = CONTRAST_OBSERVATION_COUNT;
/// Total core and contrast observations.
pub const CANDIDATE_TOTAL_OBSERVATION_COUNT: u64 = TOTAL_OBSERVATION_COUNT;

const SORTED_KEY_JSON: &str = "aiq.sorted-key-json.v1";
const CANDIDATE_PLAN_PURPOSE: &str = "private_candidate_release_gate_execution";
const CANDIDATE_AUTHORIZATION_PURPOSE: &str = "authorize_private_candidate_execution";
const MAX_ADMISSION_BYTES: u64 = 1_024 * 1_024;
const MAX_CORPUS_MANIFEST_BYTES: u64 = 64 * 1_024;
const MAX_INNER_COMMITMENT_BYTES: u64 = 4 * 1_024 * 1_024;
const MAX_AUTHORIZATION_BYTES: u64 = 4 * 1_024 * 1_024;
const MAX_RESUMED_OUTPUT_BYTES: u64 = 64 * 1_024 * 1_024;
const CORE_TASK_COUNT: usize = 72;
const MODEL_COUNT: usize = 17;
const REPEAT_COUNT: usize = 3;
const CONTRAST_COUNT: usize = 3;
const CONTRAST_ARMS_PER_REPEAT: usize = CONTRAST_COUNT * 2;
const EXECUTION_UNIT_COUNT: usize = REPEAT_COUNT * (1 + CONTRAST_ARMS_PER_REPEAT);
const UNIT_OUTPUT_COUNT: usize = EXECUTION_UNIT_COUNT * 4;
const CORE_OBSERVATION_COUNT: u64 = 3_672;
const CONTRAST_PAIR_COUNT: u64 = 153;
const CONTRAST_OBSERVATION_COUNT: u64 = 306;
const TOTAL_OBSERVATION_COUNT: u64 = 3_978;
const CANDIDATE_CATALOG_JSON: &str =
	include_str!("../../../benchmarks/candidates/aiq-core-1.0.2/catalog.json");
const CONTRAST_IDS: [&str; 3] =
	["coupled_constraints", "ambiguous_recovery_state", "plausible_incomplete_evidence"];
const MODEL_IDENTITIES: [ModelIdentity; 17] = [
	ModelIdentity {
		canonical_model_id: "sol-low",
		execution_model_id: "gpt-5.6-sol-low",
		family: "sol",
		reasoning_effort: "low",
		model_name: "gpt-5.6-sol",
	},
	ModelIdentity {
		canonical_model_id: "sol-medium",
		execution_model_id: "gpt-5.6-sol-medium",
		family: "sol",
		reasoning_effort: "medium",
		model_name: "gpt-5.6-sol",
	},
	ModelIdentity {
		canonical_model_id: "sol-high",
		execution_model_id: "gpt-5.6-sol-high",
		family: "sol",
		reasoning_effort: "high",
		model_name: "gpt-5.6-sol",
	},
	ModelIdentity {
		canonical_model_id: "sol-xhigh",
		execution_model_id: "gpt-5.6-sol-xhigh",
		family: "sol",
		reasoning_effort: "xhigh",
		model_name: "gpt-5.6-sol",
	},
	ModelIdentity {
		canonical_model_id: "sol-max",
		execution_model_id: "gpt-5.6-sol-max",
		family: "sol",
		reasoning_effort: "max",
		model_name: "gpt-5.6-sol",
	},
	ModelIdentity {
		canonical_model_id: "sol-ultra",
		execution_model_id: "gpt-5.6-sol-ultra",
		family: "sol",
		reasoning_effort: "ultra",
		model_name: "gpt-5.6-sol",
	},
	ModelIdentity {
		canonical_model_id: "terra-low",
		execution_model_id: "gpt-5.6-terra-low",
		family: "terra",
		reasoning_effort: "low",
		model_name: "gpt-5.6-terra",
	},
	ModelIdentity {
		canonical_model_id: "terra-medium",
		execution_model_id: "gpt-5.6-terra-medium",
		family: "terra",
		reasoning_effort: "medium",
		model_name: "gpt-5.6-terra",
	},
	ModelIdentity {
		canonical_model_id: "terra-high",
		execution_model_id: "gpt-5.6-terra-high",
		family: "terra",
		reasoning_effort: "high",
		model_name: "gpt-5.6-terra",
	},
	ModelIdentity {
		canonical_model_id: "terra-xhigh",
		execution_model_id: "gpt-5.6-terra-xhigh",
		family: "terra",
		reasoning_effort: "xhigh",
		model_name: "gpt-5.6-terra",
	},
	ModelIdentity {
		canonical_model_id: "terra-max",
		execution_model_id: "gpt-5.6-terra-max",
		family: "terra",
		reasoning_effort: "max",
		model_name: "gpt-5.6-terra",
	},
	ModelIdentity {
		canonical_model_id: "terra-ultra",
		execution_model_id: "gpt-5.6-terra-ultra",
		family: "terra",
		reasoning_effort: "ultra",
		model_name: "gpt-5.6-terra",
	},
	ModelIdentity {
		canonical_model_id: "luna-low",
		execution_model_id: "gpt-5.6-luna-low",
		family: "luna",
		reasoning_effort: "low",
		model_name: "gpt-5.6-luna",
	},
	ModelIdentity {
		canonical_model_id: "luna-medium",
		execution_model_id: "gpt-5.6-luna-medium",
		family: "luna",
		reasoning_effort: "medium",
		model_name: "gpt-5.6-luna",
	},
	ModelIdentity {
		canonical_model_id: "luna-high",
		execution_model_id: "gpt-5.6-luna-high",
		family: "luna",
		reasoning_effort: "high",
		model_name: "gpt-5.6-luna",
	},
	ModelIdentity {
		canonical_model_id: "luna-xhigh",
		execution_model_id: "gpt-5.6-luna-xhigh",
		family: "luna",
		reasoning_effort: "xhigh",
		model_name: "gpt-5.6-luna",
	},
	ModelIdentity {
		canonical_model_id: "luna-max",
		execution_model_id: "gpt-5.6-luna-max",
		family: "luna",
		reasoning_effort: "max",
		model_name: "gpt-5.6-luna",
	},
];

static TEMPORARY_OUTPUT_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Stable candidate gate failure that does not include controlled data.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CandidateGateError {
	message: String,
}
impl CandidateGateError {
	/// Creates a redaction-safe candidate gate failure.
	#[must_use]
	pub fn new(message: impl Into<String>) -> Self {
		Self { message: message.into() }
	}
}

impl Display for CandidateGateError {
	fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
		formatter.write_str(&self.message)
	}
}

impl std::error::Error for CandidateGateError {}

impl From<io::Error> for CandidateGateError {
	fn from(error: io::Error) -> Self {
		Self::new(format!("candidate I/O operation failed: {error}"))
	}
}

/// Signer reference carried by the canonical public admission.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ReleaseGateAdmissionSigner {
	/// Stable identifier for the admission signing key.
	pub key_id: String,
	/// Signature algorithm used by the admission signer.
	pub algorithm: String,
}

/// One signed repeat slot and its counterbalanced contrast-arm order.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ReleaseGateRepeat {
	/// Stable identifier for the repeat.
	pub repeat_id: String,
	/// Scheduled start time for the repeat.
	pub scheduled_at: String,
	/// Ordered contrast arms for the repeat.
	pub contrast_arm_order: Vec<String>,
}

/// Exact public observation universe.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ReleaseGateObservationUniverse {
	/// Ordered identifiers for all core tasks.
	pub task_ids: Vec<String>,
	/// Ordered identifiers for all model configurations.
	pub model_ids: Vec<String>,
	/// Number of core task and model cells.
	pub raw_cell_count: u64,
	/// Number of paired contrast comparisons.
	pub contrast_pair_count: u64,
	/// Number of individual contrast-arm observations.
	pub contrast_observation_count: u64,
}

/// Signed infrastructure-only retry policy.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ReleaseGateRetryPolicy {
	/// Maximum number of attempts for one observation.
	pub max_attempts: u8,
	/// Backoff intervals in seconds between retry attempts.
	pub backoff_seconds: Vec<u64>,
	/// Failure classifications that permit a retry.
	pub retryable_classifications: Vec<String>,
	/// Whether model or evaluator failures permit a retry.
	pub model_or_evaluator_failures_retryable: bool,
}

/// One public model-matrix entry.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ReleaseGateModelConfiguration {
	/// Canonical public model identifier.
	pub model_id: String,
	/// Model family identifier.
	pub family: String,
	/// Configured reasoning-effort level.
	pub reasoning_effort: String,
	/// Synthetic identifier used to select the execution model.
	pub execution_model_id: String,
}

/// Signed fixed model matrix.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ReleaseGateModelMatrix {
	/// Digest of the complete fixed model matrix.
	pub digest: String,
	/// Ordered configurations in the fixed model matrix.
	pub configurations: Vec<ReleaseGateModelConfiguration>,
}

/// Signed digest binding for one paired contrast.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ReleaseGateContrastBinding {
	/// Stable identifier for the paired contrast.
	pub contrast_id: String,
	/// Digest of the reference task variant.
	pub reference_variant_digest: String,
	/// Digest of the challenge task variant.
	pub challenge_variant_digest: String,
}

/// Canonical public admission generated and signed by the TypeScript release protocol.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ReleaseGateAdmissionV1 {
	/// Schema identifier for the admission document.
	pub schema_version: String,
	/// Domain separator for the admission signature.
	pub signature_domain: String,
	/// Canonical encoding used for the signature preimage.
	pub signature_encoding: String,
	/// Candidate release identity authorized by the admission.
	pub release_identity: String,
	/// Digest of the exact candidate catalog release identity.
	pub catalog_release_identity_digest: String,
	/// Digest of the ordered public task metadata identity.
	pub task_metadata_identity_digest: String,
	/// Digest of the outer corpus commitment manifest.
	pub corpus_commitment_digest: String,
	/// Stable identifier for the private execution plan.
	pub plan_id: String,
	/// Digest of the private execution plan identity.
	pub execution_plan_digest: String,
	/// Digest of the canonical-to-execution model mapping.
	pub model_id_mapping_digest: String,
	/// Time when the authority issued the admission.
	pub issued_at: String,
	/// Earliest permitted collection time.
	pub collection_not_before: String,
	/// Latest permitted collection time.
	pub collection_not_after: String,
	/// Signed schedule for all repeats.
	pub repeat_schedule: Vec<ReleaseGateRepeat>,
	/// Exact public observation universe.
	pub observation_universe: ReleaseGateObservationUniverse,
	/// Signed infrastructure-only retry policy.
	pub infrastructure_retry_policy: ReleaseGateRetryPolicy,
	/// Signed fixed model matrix.
	pub model_matrix: ReleaseGateModelMatrix,
	/// Signed digest bindings for all paired contrasts.
	pub contrast_bindings: Vec<ReleaseGateContrastBinding>,
	/// Public identity of the admission signer.
	pub signer: ReleaseGateAdmissionSigner,
	/// Signature over the canonical admission preimage.
	pub signature: String,
}
impl ReleaseGateAdmissionV1 {
	/// Validates the complete immutable public universe and the expected authority key ID.
	pub fn validate(&self, expected_key_id: &str) -> Result<(), CandidateGateError> {
		if self.schema_version != RELEASE_GATE_ADMISSION_SCHEMA
			|| self.signature_domain != RELEASE_GATE_ADMISSION_SCHEMA
			|| self.signature_encoding != SORTED_KEY_JSON
			|| self.release_identity != RELEASE_IDENTITY
			|| self.catalog_release_identity_digest != CANDIDATE_CATALOG_RELEASE_IDENTITY_SHA256
			|| self.task_metadata_identity_digest != CANDIDATE_TASK_IDENTITY_SHA256
		{
			return Err(CandidateGateError::new(
				"release-gate admission identity is not the immutable candidate identity",
			));
		}
		if !valid_digest(&self.corpus_commitment_digest)
			|| !valid_digest(&self.execution_plan_digest)
			|| self.model_id_mapping_digest != CANDIDATE_MODEL_ID_MAPPING_SHA256
			|| !valid_identifier(&self.plan_id)
		{
			return Err(CandidateGateError::new(
				"release-gate admission plan or commitment identity is invalid",
			));
		}
		if self.signer.key_id != expected_key_id
			|| !valid_identifier(&self.signer.key_id)
			|| self.signer.algorithm != "ed25519"
			|| !valid_base64_ed25519_signature(&self.signature)
		{
			return Err(CandidateGateError::new(
				"release-gate admission signer binding is invalid",
			));
		}

		let issued_at = parse_canonical_timestamp(&self.issued_at)?;
		let not_before = parse_canonical_timestamp(&self.collection_not_before)?;
		let not_after = parse_canonical_timestamp(&self.collection_not_after)?;

		if issued_at >= not_before || not_before >= not_after {
			return Err(CandidateGateError::new(
				"release-gate admission collection window is invalid",
			));
		}
		if self.repeat_schedule.len() != REPEAT_COUNT {
			return Err(CandidateGateError::new(
				"release-gate admission must contain exactly three repeats",
			));
		}

		let mut repeat_ids = BTreeSet::new();
		let mut previous_schedule = None;

		for (index, repeat) in self.repeat_schedule.iter().enumerate() {
			let scheduled_at = parse_canonical_timestamp(&repeat.scheduled_at)?;

			if !valid_identifier(&repeat.repeat_id)
				|| !repeat_ids.insert(repeat.repeat_id.as_str())
				|| scheduled_at < not_before
				|| scheduled_at > not_after
				|| previous_schedule.is_some_and(|previous| scheduled_at <= previous)
				|| repeat.contrast_arm_order != expected_contrast_arm_order(index)
			{
				return Err(CandidateGateError::new("release-gate repeat schedule is invalid"));
			}

			previous_schedule = Some(scheduled_at);
		}

		let task_ids = candidate_task_ids()?;
		let canonical_model_ids = canonical_model_ids();

		if self.observation_universe.task_ids != task_ids
			|| self.observation_universe.model_ids != canonical_model_ids
			|| self.observation_universe.raw_cell_count != CORE_OBSERVATION_COUNT
			|| self.observation_universe.contrast_pair_count != CONTRAST_PAIR_COUNT
			|| self.observation_universe.contrast_observation_count != CONTRAST_OBSERVATION_COUNT
		{
			return Err(CandidateGateError::new("release-gate observation universe is invalid"));
		}

		self.validate_retry_policy()?;
		self.validate_model_matrix()?;
		self.validate_contrast_bindings()?;

		Ok(())
	}

	/// Ensures execution occurs in the signed collection window.
	pub fn validate_execution_time(&self, observed_at: &str) -> Result<(), CandidateGateError> {
		let observed = parse_canonical_timestamp(observed_at)?;
		let not_before = parse_canonical_timestamp(&self.collection_not_before)?;
		let not_after = parse_canonical_timestamp(&self.collection_not_after)?;

		if observed < not_before || observed > not_after {
			return Err(CandidateGateError::new(
				"candidate execution is outside the signed collection window",
			));
		}

		Ok(())
	}

	/// Validates one selected repeat's nonoverlapping signed time partition.
	pub fn validate_repeat_execution_time(
		&self,
		repeat_id: &str,
		observed_at: &str,
	) -> Result<(), CandidateGateError> {
		self.validate_execution_time(observed_at)?;

		let observed = parse_canonical_timestamp(observed_at)?;
		let index = self
			.repeat_schedule
			.iter()
			.position(|repeat| repeat.repeat_id == repeat_id)
			.ok_or_else(|| {
				CandidateGateError::new("candidate repeat is not in the signed schedule")
			})?;
		let scheduled = parse_canonical_timestamp(&self.repeat_schedule[index].scheduled_at)?;
		let before_next = self
			.repeat_schedule
			.get(index + 1)
			.map(|repeat| parse_canonical_timestamp(&repeat.scheduled_at))
			.transpose()?
			.is_none_or(|next| observed < next);

		if observed < scheduled || !before_next {
			return Err(CandidateGateError::new(
				"candidate execution is outside the selected repeat time partition",
			));
		}

		Ok(())
	}

	/// Returns the scheduled delay for an exact one-based attempt number.
	pub fn scheduled_attempt_delay(&self, attempt_number: u8) -> Result<u64, CandidateGateError> {
		if !(1..=self.infrastructure_retry_policy.max_attempts).contains(&attempt_number) {
			return Err(CandidateGateError::new(
				"candidate attempt number is outside the signed retry policy",
			));
		}

		Ok(self.infrastructure_retry_policy.backoff_seconds[usize::from(attempt_number - 1)])
	}

	/// Returns the next delay only for a pre-model retryable infrastructure failure.
	pub fn retry_after_failure(
		&self,
		attempt_number: u8,
		model_started: bool,
		classification: CandidateAttemptFailure,
	) -> Result<Option<u64>, CandidateGateError> {
		self.scheduled_attempt_delay(attempt_number)?;

		if model_started || !classification.is_retryable_infrastructure() {
			return Ok(None);
		}

		let next_attempt = attempt_number.saturating_add(1);

		if next_attempt > self.infrastructure_retry_policy.max_attempts {
			return Ok(None);
		}

		Ok(Some(self.scheduled_attempt_delay(next_attempt)?))
	}

	fn validate_retry_policy(&self) -> Result<(), CandidateGateError> {
		let policy = &self.infrastructure_retry_policy;

		if policy.max_attempts != 3
			|| policy.backoff_seconds != [0, 30, 90]
			|| policy.retryable_classifications != ["pre_model_admission"]
			|| policy.model_or_evaluator_failures_retryable
		{
			return Err(CandidateGateError::new(
				"release-gate retry policy is not the immutable infrastructure-only policy",
			));
		}

		Ok(())
	}

	fn validate_model_matrix(&self) -> Result<(), CandidateGateError> {
		if self.model_matrix.configurations.len() != MODEL_COUNT
			|| self.model_matrix.digest != CANDIDATE_MODEL_MATRIX_SHA256
		{
			return Err(CandidateGateError::new("release-gate model matrix is invalid"));
		}

		for (configuration, expected) in
			self.model_matrix.configurations.iter().zip(MODEL_IDENTITIES)
		{
			if configuration.model_id != expected.canonical_model_id
				|| configuration.execution_model_id != expected.execution_model_id
				|| configuration.family != expected.family
				|| configuration.reasoning_effort != expected.reasoning_effort
			{
				return Err(CandidateGateError::new("release-gate model matrix entry is invalid"));
			}
		}

		let mut digest_configurations = self.model_matrix.configurations.clone();

		digest_configurations.sort_by(|left, right| left.model_id.cmp(&right.model_id));

		let digest = canonical_digest(&digest_configurations)?;

		if digest != self.model_matrix.digest {
			return Err(CandidateGateError::new(
				"release-gate model matrix digest does not match its configurations",
			));
		}

		Ok(())
	}

	fn validate_contrast_bindings(&self) -> Result<(), CandidateGateError> {
		if self.contrast_bindings.len() != CONTRAST_COUNT {
			return Err(CandidateGateError::new(
				"release-gate admission must bind exactly three contrasts",
			));
		}

		let mut digests = BTreeSet::new();

		for (binding, expected_id) in self.contrast_bindings.iter().zip(CONTRAST_IDS) {
			if binding.contrast_id != expected_id
				|| !valid_digest(&binding.reference_variant_digest)
				|| !valid_digest(&binding.challenge_variant_digest)
				|| !digests.insert(binding.reference_variant_digest.as_str())
				|| !digests.insert(binding.challenge_variant_digest.as_str())
			{
				return Err(CandidateGateError::new(
					"release-gate contrast binding is invalid or reused",
				));
			}
		}

		Ok(())
	}
}

/// A canonical admission after its bounded file identity has been checked.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifiedReleaseGateAdmission {
	/// Validated canonical admission document.
	pub admission: ReleaseGateAdmissionV1,
	/// SHA-256 digest of the canonical admission bytes.
	pub canonical_sha256: String,
}

/// Public-safe outer manifest that separates the 72-task core commitment from
/// the private six-task contrast commitment.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ReleaseGateCorpusManifestV1 {
	/// Schema identifier for the corpus manifest.
	pub schema_version: String,
	/// Candidate release identity bound by the manifest.
	pub release_identity: String,
	/// Digest of the exact candidate catalog release identity.
	pub catalog_release_identity_digest: String,
	/// Digest of the ordered public task metadata identity.
	pub task_metadata_identity_digest: String,
	/// Canonical JSON encoding used for the manifest.
	pub canonicalization: String,
	/// Number of tasks in the core corpus.
	pub core_task_count: u64,
	/// Number of tasks in the contrast corpus.
	pub contrast_task_count: u64,
	/// SHA-256 digest of the private core corpus commitment.
	pub core_corpus_commitment_sha256: String,
	/// SHA-256 digest of the private contrast corpus commitment.
	pub contrast_corpus_commitment_sha256: String,
}
impl ReleaseGateCorpusManifestV1 {
	fn validate(&self) -> Result<(), CandidateGateError> {
		if self.schema_version != RELEASE_GATE_CORPUS_MANIFEST_SCHEMA
			|| self.release_identity != RELEASE_IDENTITY
			|| self.catalog_release_identity_digest != CANDIDATE_CATALOG_RELEASE_IDENTITY_SHA256
			|| self.task_metadata_identity_digest != CANDIDATE_TASK_IDENTITY_SHA256
			|| self.canonicalization != SORTED_KEY_JSON
			|| self.core_task_count != CORE_TASK_COUNT as u64
			|| self.contrast_task_count != (CONTRAST_COUNT * 2) as u64
			|| !valid_digest(&self.core_corpus_commitment_sha256)
			|| !valid_digest(&self.contrast_corpus_commitment_sha256)
			|| self.core_corpus_commitment_sha256 == self.contrast_corpus_commitment_sha256
		{
			return Err(CandidateGateError::new("release-gate corpus manifest is invalid"));
		}

		Ok(())
	}
}

/// Verified outer manifest and its two distinct inner commitments.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifiedReleaseGateCorpus {
	/// Validated public-safe outer corpus manifest.
	pub manifest: ReleaseGateCorpusManifestV1,
	/// SHA-256 digest of the canonical manifest bytes.
	pub manifest_sha256: String,
}

/// Resolved real runtime selector for one synthetic public execution ID.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CandidateResolvedModel {
	/// Canonical public model identifier.
	pub canonical_model_id: String,
	/// Synthetic model identifier used for execution selection.
	pub execution_model_id: String,
	/// Real model name supplied to the runtime.
	pub model_name: String,
	/// Reasoning-effort level supplied to the runtime.
	pub reasoning_effort: String,
}

/// Permanent non-release classification for all candidate output.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CandidateClassification {
	/// Trust tier assigned to candidate output.
	pub trust_tier: String,
	/// Whether candidate output is official.
	pub official: bool,
	/// Whether candidate output can enter rankings.
	pub ranking_eligible: bool,
	/// Permanent disposition assigned to candidate output.
	pub disposition: String,
}
impl CandidateClassification {
	fn validate(&self) -> Result<(), CandidateGateError> {
		if self != &Self::default() {
			return Err(CandidateGateError::new(
				"candidate classification must remain nonofficial, nonranking, and untrusted",
			));
		}

		Ok(())
	}
}

impl Default for CandidateClassification {
	fn default() -> Self {
		Self {
			trust_tier: "untrusted".to_owned(),
			official: false,
			ranking_eligible: false,
			disposition: "candidate_release_gate_only".to_owned(),
		}
	}
}

/// Digests for the exact runner and evaluator runtime selected before execution.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CandidateRuntimeBindings {
	/// SHA-256 digest of the runner executable.
	pub runner_executable_sha256: String,
	/// SHA-256 digest of the independent verifier executable.
	pub verifier_executable_sha256: String,
	/// SHA-256 digest of the evaluator runtime.
	pub evaluator_runtime_sha256: String,
	/// SHA-256 digest of the core harness.
	pub core_harness_sha256: String,
	/// SHA-256 digest of the core tool policy.
	pub core_tool_policy_sha256: String,
	/// SHA-256 digest of the core network policy.
	pub core_network_policy_sha256: String,
	/// SHA-256 digest of the contrast harness.
	pub contrast_harness_sha256: String,
	/// SHA-256 digest of the contrast tool policy.
	pub contrast_tool_policy_sha256: String,
	/// SHA-256 digest of the contrast network policy.
	pub contrast_network_policy_sha256: String,
}
impl CandidateRuntimeBindings {
	fn validate(&self) -> Result<(), CandidateGateError> {
		for digest in [
			&self.runner_executable_sha256,
			&self.verifier_executable_sha256,
			&self.evaluator_runtime_sha256,
			&self.core_harness_sha256,
			&self.core_tool_policy_sha256,
			&self.core_network_policy_sha256,
			&self.contrast_harness_sha256,
			&self.contrast_tool_policy_sha256,
			&self.contrast_network_policy_sha256,
		] {
			if !valid_digest(digest) {
				return Err(CandidateGateError::new(
					"candidate runtime binding contains an invalid digest",
				));
			}
		}

		if self.core_tool_policy_sha256 == self.contrast_tool_policy_sha256 {
			return Err(CandidateGateError::new(
				"core and contrast tool-policy commitments must remain distinct",
			));
		}

		Ok(())
	}

	/// Compares semantic identities from the validated 72-task commitment.
	pub fn validate_core_commitment_bindings(
		&self,
		harness_sha256: &str,
		tool_policy_sha256: &str,
		network_policy_sha256: &str,
	) -> Result<(), CandidateGateError> {
		self.validate()?;

		if self.core_harness_sha256 != harness_sha256
			|| self.core_tool_policy_sha256 != tool_policy_sha256
			|| self.core_network_policy_sha256 != network_policy_sha256
		{
			return Err(CandidateGateError::new(
				"candidate core runtime does not match the validated core commitment",
			));
		}

		Ok(())
	}

	/// Compares semantic identities from the validated six-task commitment.
	pub fn validate_contrast_commitment_bindings(
		&self,
		harness_sha256: &str,
		tool_policy_sha256: &str,
		network_policy_sha256: &str,
	) -> Result<(), CandidateGateError> {
		self.validate()?;

		if self.contrast_harness_sha256 != harness_sha256
			|| self.contrast_tool_policy_sha256 != tool_policy_sha256
			|| self.contrast_network_policy_sha256 != network_policy_sha256
		{
			return Err(CandidateGateError::new(
				"candidate contrast runtime does not match the validated contrast commitment",
			));
		}

		Ok(())
	}
}

/// Closed set of model-capable controlled inputs signed by the private plan.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CandidateControlledInputs {
	/// Root directory for controlled core tasks.
	pub core_tasks_root: PathBuf,
	/// Root directory for controlled contrast tasks.
	pub contrast_tasks_root: PathBuf,
	/// Root directory for controlled source files.
	pub source_root: PathBuf,
	/// Root directory for core task workspaces.
	pub core_workspace_root: PathBuf,
	/// Root directory for contrast task workspaces.
	pub contrast_workspace_root: PathBuf,
	/// Root directory for task execution.
	pub execution_root: PathBuf,
	/// Root directory for evaluator inputs.
	pub evaluator_root: PathBuf,
	/// Path to the evaluator runtime executable.
	pub evaluator_runtime: PathBuf,
	/// Root directory for the controlled Codex toolchain.
	pub codex_toolchain_root: PathBuf,
	/// Path to the runtime capability document.
	pub capabilities: PathBuf,
	/// Path to the controlled execution schedule.
	pub schedule: PathBuf,
	/// Path to the controlled Codex executable.
	pub codex_binary: PathBuf,
	/// Controlled Codex home directory.
	pub codex_home: PathBuf,
	/// Exact Codex egress proxy endpoint for the fixed candidate runner topology.
	pub codex_egress_proxy: String,
	/// Root directory for execution artifacts.
	pub artifact_root: PathBuf,
	/// Root directory for transient execution work.
	pub work_root: PathBuf,
	/// Isolated root directory for verifier replay.
	pub verifier_replay_root: PathBuf,
	/// Maximum number of concurrent runner jobs.
	pub jobs: usize,
	/// Node identifier for the runner signer.
	pub runner_signer_node_id: String,
	/// Distinct node identifier for the verifier signer.
	pub verifier_signer_node_id: String,
}
impl CandidateControlledInputs {
	/// Validates normalized paths, concurrency, fixed egress, and signer separation.
	pub fn validate(&self) -> Result<(), CandidateGateError> {
		let directory_paths = [
			self.core_tasks_root.as_path(),
			self.contrast_tasks_root.as_path(),
			self.source_root.as_path(),
			self.core_workspace_root.as_path(),
			self.contrast_workspace_root.as_path(),
			self.execution_root.as_path(),
			self.evaluator_root.as_path(),
			self.codex_toolchain_root.as_path(),
			self.codex_home.as_path(),
			self.artifact_root.as_path(),
			self.work_root.as_path(),
			self.verifier_replay_root.as_path(),
		];
		let file_paths = [
			self.evaluator_runtime.as_path(),
			self.capabilities.as_path(),
			self.schedule.as_path(),
			self.codex_binary.as_path(),
		];
		let mut paths = BTreeSet::new();

		for path in directory_paths {
			validate_absolute_directory_path(path)?;

			if !paths.insert(path.to_path_buf()) {
				return Err(CandidateGateError::new(
					"candidate controlled input paths must be exact and distinct",
				));
			}
		}
		for path in file_paths {
			validate_absolute_file_path(path)?;

			if !paths.insert(path.to_path_buf()) {
				return Err(CandidateGateError::new(
					"candidate controlled input paths must be exact and distinct",
				));
			}
		}

		if self
			.paths()
			.filter(|path| *path != self.verifier_replay_root.as_path())
			.any(|path| candidate_paths_overlap(path, &self.verifier_replay_root))
		{
			return Err(CandidateGateError::new(
				"candidate verifier replay root must not overlap runner-controlled inputs",
			));
		}
		if !(1..=MAX_RUN_JOBS).contains(&self.jobs) {
			return Err(CandidateGateError::new(
				"candidate jobs are outside the runner concurrency bound",
			));
		}
		if !valid_node_id(&self.runner_signer_node_id)
			|| !valid_node_id(&self.verifier_signer_node_id)
			|| self.runner_signer_node_id == self.verifier_signer_node_id
		{
			return Err(CandidateGateError::new(
				"candidate runner and verifier signer identities are invalid or not distinct",
			));
		}
		if self.codex_egress_proxy != CANDIDATE_CODEX_EGRESS_PROXY_ENDPOINT {
			return Err(CandidateGateError::new(
				"candidate Codex egress proxy does not match the fixed runner topology",
			));
		}

		Ok(())
	}

	fn paths(&self) -> impl Iterator<Item = &Path> {
		[
			self.core_tasks_root.as_path(),
			self.contrast_tasks_root.as_path(),
			self.source_root.as_path(),
			self.core_workspace_root.as_path(),
			self.contrast_workspace_root.as_path(),
			self.execution_root.as_path(),
			self.evaluator_root.as_path(),
			self.evaluator_runtime.as_path(),
			self.codex_toolchain_root.as_path(),
			self.capabilities.as_path(),
			self.schedule.as_path(),
			self.codex_binary.as_path(),
			self.codex_home.as_path(),
			self.artifact_root.as_path(),
			self.work_root.as_path(),
			self.verifier_replay_root.as_path(),
		]
		.into_iter()
	}
}

/// Private binding from each contrast identity to exactly one controlled task.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CandidateContrastTaskBinding {
	/// Stable identifier for the paired contrast.
	pub contrast_id: String,
	/// Controlled task identifier for the reference arm.
	pub reference_task_id: String,
	/// Controlled task identifier for the challenge arm.
	pub challenge_task_id: String,
}

/// Four distinct create-once output paths for one execution unit.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CandidateUnitOutputs {
	/// Canonical bundle of per-observation signed result packages.
	pub result_package_bundle: PathBuf,
	/// Canonical bundle of per-observation evaluator results.
	pub evaluator_result_bundle: PathBuf,
	/// Canonical bundle of per-observation independent replay proofs.
	pub verifier_replay_bundle: PathBuf,
	/// Canonical bundle of per-observation attempt records.
	pub attempt_log_bundle: PathBuf,
}
impl CandidateUnitOutputs {
	fn keyed_paths(&self, unit_id: &str) -> [(String, &Path); 4] {
		[
			(format!("{unit_id}/result_package_bundle"), self.result_package_bundle.as_path()),
			(format!("{unit_id}/evaluator_result_bundle"), self.evaluator_result_bundle.as_path()),
			(format!("{unit_id}/verifier_replay_bundle"), self.verifier_replay_bundle.as_path()),
			(format!("{unit_id}/attempt_log_bundle"), self.attempt_log_bundle.as_path()),
		]
	}
}

/// One of exactly twenty-one plan-bound execution units.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CandidateExecutionUnit {
	/// Deterministic identifier for the execution unit.
	pub unit_id: String,
	/// Identifier for the repeat that owns the unit.
	pub repeat_id: String,
	/// Identifier for the scheduled slot within the repeat.
	pub slot_id: String,
	/// Kind of tasks executed by the unit.
	pub kind: CandidateExecutionUnitKind,
	/// Contrast identifier for a contrast unit.
	pub contrast_id: Option<String>,
	/// Scheduled arm for a contrast unit.
	pub contrast_arm: Option<CandidateContrastArm>,
	/// Bound task-variant digest for a contrast unit.
	pub variant_sha256: Option<String>,
	/// Ordered task identifiers executed by the unit.
	pub ordered_task_ids: Vec<String>,
	/// Ordered model configurations executed by the unit.
	pub models: Vec<CandidateResolvedModel>,
	/// Path to the corpus commitment used by the unit.
	pub corpus_commitment_path: PathBuf,
	/// SHA-256 digest of the unit corpus commitment.
	pub corpus_commitment_sha256: String,
	/// Path to the unit checkpoint.
	pub checkpoint_path: PathBuf,
	/// Path to the unit preflight record.
	pub preflight_path: PathBuf,
	/// Path to the unit attempt journal.
	pub attempt_journal_path: PathBuf,
	/// Create-once output paths for the unit.
	pub outputs: CandidateUnitOutputs,
}

/// Separate final aggregate outputs. They cannot alias any unit output.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CandidateAggregateOutputs {
	/// Path to the aggregate source observations.
	pub source_observations: PathBuf,
	/// Path to the aggregate release-gate evidence.
	pub release_gate_evidence: PathBuf,
}

/// Pinned inputs for deterministic private-plan construction.
///
/// There are no task or model selectors. The builder derives all fixed tasks,
/// models, contrast arms, unit identifiers, and output paths from the signed
/// admission and one absolute output root. It does not create directories or
/// write files.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CandidatePlanInputs {
	/// Path to the canonical signed admission.
	pub signed_admission_path: PathBuf,
	/// SHA-256 digest of the complete signed admission.
	pub signed_admission_sha256: String,
	/// Pinned key identifier for the admission signer.
	pub signed_admission_key_id: String,
	/// Canonical public release trust-policy path.
	pub release_trust_policy_path: PathBuf,
	/// Protected digest of the canonical release trust policy.
	pub release_trust_policy_sha256: String,
	/// Path to the public-safe corpus manifest.
	pub corpus_manifest_path: PathBuf,
	/// SHA-256 digest of the corpus manifest.
	pub corpus_manifest_sha256: String,
	/// Path to the private core corpus commitment.
	pub core_corpus_commitment_path: PathBuf,
	/// SHA-256 digest of the core corpus commitment.
	pub core_corpus_commitment_sha256: String,
	/// Path to the private contrast corpus commitment.
	pub contrast_corpus_commitment_path: PathBuf,
	/// SHA-256 digest of the contrast corpus commitment.
	pub contrast_corpus_commitment_sha256: String,
	/// Create-once path for the private authorization.
	pub authorization_path: PathBuf,
	/// Digests for the selected runner and evaluator runtime.
	pub runtime: CandidateRuntimeBindings,
	/// Controlled model-capable input paths and settings.
	pub controlled_inputs: CandidateControlledInputs,
	/// Root directory for all create-once outputs.
	pub output_root: PathBuf,
}

/// Exact private plan signed by a distinct execution authorization.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CandidateExecutionPlan {
	/// Schema identifier for the private execution plan.
	pub schema_version: String,
	/// Fixed purpose of the private execution plan.
	pub purpose: String,
	/// Candidate release identity bound by the plan.
	pub release_identity: String,
	/// Digest of the exact candidate catalog release identity.
	pub catalog_release_identity_digest: String,
	/// Digest of the ordered public task metadata identity.
	pub task_metadata_identity_digest: String,
	/// Digest that identifies the execution plan in the admission.
	pub execution_plan_digest: String,
	/// Digest of the canonical-to-execution model mapping.
	pub model_id_mapping_digest: String,
	/// Path to the canonical signed admission.
	pub signed_admission_path: PathBuf,
	/// SHA-256 digest of the complete signed admission.
	pub signed_admission_sha256: String,
	/// Pinned key identifier for the admission signer.
	pub signed_admission_key_id: String,
	/// Canonical public release trust-policy path.
	pub release_trust_policy_path: PathBuf,
	/// Protected digest of the canonical release trust policy.
	pub release_trust_policy_sha256: String,
	/// Path to the public-safe corpus manifest.
	pub corpus_manifest_path: PathBuf,
	/// SHA-256 digest of the corpus manifest.
	pub corpus_manifest_sha256: String,
	/// Path to the private core corpus commitment.
	pub core_corpus_commitment_path: PathBuf,
	/// SHA-256 digest of the core corpus commitment.
	pub core_corpus_commitment_sha256: String,
	/// Path to the private contrast corpus commitment.
	pub contrast_corpus_commitment_path: PathBuf,
	/// SHA-256 digest of the contrast corpus commitment.
	pub contrast_corpus_commitment_sha256: String,
	/// Create-once path for the private authorization.
	pub authorization_path: PathBuf,
	/// Digests for the selected runner and evaluator runtime.
	pub runtime: CandidateRuntimeBindings,
	/// Controlled model-capable input paths and settings.
	pub controlled_inputs: CandidateControlledInputs,
	/// Root directory for all create-once outputs.
	pub output_root: PathBuf,
	/// Private task bindings for all paired contrasts.
	pub contrast_task_bindings: Vec<CandidateContrastTaskBinding>,
	/// Complete ordered set of plan-bound execution units.
	pub execution_units: Vec<CandidateExecutionUnit>,
	/// Separate final aggregate output paths.
	pub aggregate_outputs: CandidateAggregateOutputs,
	/// Permanent non-release classification for all output.
	pub classification: CandidateClassification,
}
impl CandidateExecutionPlan {
	/// Validates all twenty-one units against the complete canonical admission.
	pub fn validate_against_admission(
		&self,
		admission: &ReleaseGateAdmissionV1,
	) -> Result<(), CandidateGateError> {
		admission.validate(&self.signed_admission_key_id)?;

		let observed_admission_digest = canonical_digest(admission)?;

		if self.schema_version != CANDIDATE_EXECUTION_PLAN_SCHEMA
			|| self.purpose != CANDIDATE_PLAN_PURPOSE
			|| self.release_identity != RELEASE_IDENTITY
			|| self.catalog_release_identity_digest != CANDIDATE_CATALOG_RELEASE_IDENTITY_SHA256
			|| self.task_metadata_identity_digest != CANDIDATE_TASK_IDENTITY_SHA256
			|| self.execution_plan_digest != admission.execution_plan_digest
			|| self.model_id_mapping_digest != CANDIDATE_MODEL_ID_MAPPING_SHA256
			|| self.signed_admission_sha256 != observed_admission_digest
			|| self.corpus_manifest_sha256 != admission.corpus_commitment_digest
		{
			return Err(CandidateGateError::new(
				"candidate private plan does not match the canonical admission",
			));
		}

		for digest in [
			&self.execution_plan_digest,
			&self.signed_admission_sha256,
			&self.release_trust_policy_sha256,
			&self.corpus_manifest_sha256,
			&self.core_corpus_commitment_sha256,
			&self.contrast_corpus_commitment_sha256,
		] {
			if !valid_digest(digest) {
				return Err(CandidateGateError::new(
					"candidate private plan contains an invalid digest",
				));
			}
		}

		if self.core_corpus_commitment_sha256 == self.contrast_corpus_commitment_sha256 {
			return Err(CandidateGateError::new(
				"core and contrast corpus commitments must remain distinct",
			));
		}

		self.runtime.validate()?;

		validate_absolute_file_path(&self.release_trust_policy_path)?;

		self.controlled_inputs.validate()?;

		validate_absolute_directory_path(&self.output_root)?;

		self.classification.validate()?;
		self.validate_contrast_task_bindings()?;

		if self.execution_units.len() != EXECUTION_UNIT_COUNT {
			return Err(CandidateGateError::new(
				"candidate private plan must contain exactly twenty-one execution units",
			));
		}

		let expected_models = expected_resolved_models()?;
		let core_task_ids = candidate_task_ids()?;
		let unit_derivation = CandidateUnitDerivation::from_plan(self, &expected_models);
		let expected_units = build_candidate_execution_units(
			admission,
			&unit_derivation,
			&core_task_ids,
			&self.contrast_task_bindings,
		)?;

		if self.execution_units != expected_units {
			return Err(CandidateGateError::new(
				"candidate execution units do not match the signed deterministic plan",
			));
		}

		let mut unit_ids = BTreeSet::new();
		let mut derived_observations = 0_u64;

		for unit in &self.execution_units {
			validate_unit_id(&unit.unit_id, &mut unit_ids)?;

			derived_observations = derived_observations
				.checked_add((unit.ordered_task_ids.len() * unit.models.len()) as u64)
				.ok_or_else(|| CandidateGateError::new("candidate observation count overflows"))?;
		}

		if derived_observations != TOTAL_OBSERVATION_COUNT {
			return Err(CandidateGateError::new(
				"candidate execution plan does not prove exactly 3,978 observations",
			));
		}

		let expected_aggregates = CandidateAggregateOutputs {
			source_observations: self.output_root.join("aggregate-source-observations.json"),
			release_gate_evidence: self.output_root.join("aggregate-release-gate-evidence.json"),
		};

		if self.aggregate_outputs != expected_aggregates {
			return Err(CandidateGateError::new(
				"candidate aggregate outputs are not derived from the signed output root",
			));
		}

		self.validate_paths()?;

		Ok(())
	}

	/// Returns the exact seven ordered units for one signed repeat ID.
	///
	/// This is the only run-unit selector. It validates the complete plan first
	/// and does not accept task or model selectors.
	pub fn units_for_repeat<'a>(
		&'a self,
		admission: &ReleaseGateAdmissionV1,
		repeat_id: &str,
	) -> Result<&'a [CandidateExecutionUnit], CandidateGateError> {
		self.validate_against_admission(admission)?;

		let repeat_index = admission
			.repeat_schedule
			.iter()
			.position(|repeat| repeat.repeat_id == repeat_id)
			.ok_or_else(|| {
				CandidateGateError::new("candidate repeat is not in the signed schedule")
			})?;
		let units_per_repeat = 1 + CONTRAST_ARMS_PER_REPEAT;
		let start = repeat_index * units_per_repeat;
		let end = start + units_per_repeat;

		Ok(&self.execution_units[start..end])
	}

	/// Ordered unit and aggregate output keys. There are exactly 84 unit outputs.
	pub fn output_paths(&self) -> Vec<(String, &Path)> {
		let mut outputs = Vec::with_capacity(UNIT_OUTPUT_COUNT + 2);

		for unit in &self.execution_units {
			outputs.extend(unit.outputs.keyed_paths(&unit.unit_id));
		}

		outputs.push((
			"aggregate/source_observations".to_owned(),
			self.aggregate_outputs.source_observations.as_path(),
		));
		outputs.push((
			"aggregate/release_gate_evidence".to_owned(),
			self.aggregate_outputs.release_gate_evidence.as_path(),
		));

		outputs
	}

	fn validate_contrast_task_bindings(&self) -> Result<(), CandidateGateError> {
		if self.contrast_task_bindings.len() != CONTRAST_COUNT {
			return Err(CandidateGateError::new(
				"candidate plan must contain three private contrast task bindings",
			));
		}

		let core_tasks = candidate_task_ids()?.into_iter().collect::<BTreeSet<_>>();
		let expected = [
			(
				"coupled_constraints",
				"contrast-coupled-reference-01",
				"contrast-coupled-challenge-01",
			),
			(
				"ambiguous_recovery_state",
				"contrast-recovery-reference-01",
				"contrast-recovery-challenge-01",
			),
			(
				"plausible_incomplete_evidence",
				"contrast-evidence-reference-01",
				"contrast-evidence-challenge-01",
			),
		];
		let mut contrast_tasks = BTreeSet::new();

		for (binding, (expected_id, expected_reference, expected_challenge)) in
			self.contrast_task_bindings.iter().zip(expected)
		{
			if binding.contrast_id != expected_id
				|| binding.reference_task_id != expected_reference
				|| binding.challenge_task_id != expected_challenge
				|| !valid_identifier(&binding.reference_task_id)
				|| !valid_identifier(&binding.challenge_task_id)
				|| core_tasks.contains(&binding.reference_task_id)
				|| core_tasks.contains(&binding.challenge_task_id)
				|| !contrast_tasks.insert(binding.reference_task_id.as_str())
				|| !contrast_tasks.insert(binding.challenge_task_id.as_str())
			{
				return Err(CandidateGateError::new(
					"candidate private contrast task binding is invalid or aliases a core task",
				));
			}
		}

		Ok(())
	}

	fn validate_paths(&self) -> Result<(), CandidateGateError> {
		let input_paths = [
			self.signed_admission_path.as_path(),
			self.corpus_manifest_path.as_path(),
			self.core_corpus_commitment_path.as_path(),
			self.contrast_corpus_commitment_path.as_path(),
		];
		let mut all_paths = BTreeSet::new();

		for path in input_paths {
			validate_absolute_file_path(path)?;

			if !all_paths.insert(path.to_path_buf()) {
				return Err(CandidateGateError::new("candidate plan input paths must be distinct"));
			}
		}
		for path in self.controlled_inputs.paths() {
			if !all_paths.insert(path.to_path_buf()) {
				return Err(CandidateGateError::new(
					"candidate controlled, admission, and corpus paths must be exact and distinct",
				));
			}
		}

		if !all_paths.insert(self.output_root.clone()) {
			return Err(CandidateGateError::new(
				"candidate output root must not alias a controlled or signed input path",
			));
		}

		validate_absolute_file_path(&self.authorization_path)?;

		if !all_paths.insert(self.authorization_path.clone()) {
			return Err(CandidateGateError::new("candidate authorization path aliases an input"));
		}

		let outputs = self.output_paths();

		if outputs.len() != UNIT_OUTPUT_COUNT + 2 {
			return Err(CandidateGateError::new(
				"candidate output plan does not contain 84 unit outputs and two aggregates",
			));
		}

		let mut output_keys = BTreeSet::new();

		for (key, path) in outputs {
			if !output_keys.insert(key) {
				return Err(CandidateGateError::new("candidate output key is duplicated"));
			}

			validate_absolute_file_path(path)?;

			if !all_paths.insert(path.to_path_buf()) {
				return Err(CandidateGateError::new(
					"candidate input, authorization, unit, and aggregate paths must all be distinct",
				));
			}
		}
		for unit in &self.execution_units {
			for path in [
				unit.checkpoint_path.as_path(),
				unit.preflight_path.as_path(),
				unit.attempt_journal_path.as_path(),
			] {
				validate_absolute_file_path(path)?;

				if !all_paths.insert(path.to_path_buf()) {
					return Err(CandidateGateError::new(
						"candidate controlled, work, input, and output paths must be exact and distinct",
					));
				}
			}
		}

		let verifier_replay_root = self.controlled_inputs.verifier_replay_root.as_path();

		if all_paths.iter().any(|path| {
			path.as_path() != verifier_replay_root
				&& candidate_paths_overlap(path, verifier_replay_root)
		}) {
			return Err(CandidateGateError::new(
				"candidate verifier replay root must not overlap plan inputs, work, or outputs",
			));
		}

		Ok(())
	}
}

/// One deterministic binary assertion in a candidate evaluator component.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CandidateAssertion {
	/// Stable identifier for the binary assertion.
	pub assertion_id: String,
	/// Whether the evaluator assertion passed.
	pub passed: bool,
	/// SHA-256 digest of the assertion evidence.
	pub evidence_sha256: String,
}

/// One of four ordered candidate evaluator components.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CandidateEvaluatorComponent {
	/// Stable identifier for the evaluator component.
	pub component_id: String,
	/// Component weight in basis points.
	pub weight_basis_points: u32,
	/// Ordered binary assertions in the component.
	pub assertions: Vec<CandidateAssertion>,
}

/// Exact four-component evaluator result exchanged with the independent verifier.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CandidateEvaluatorResult {
	/// Schema identifier for the evaluator result.
	pub schema_version: String,
	/// Identifier for the evaluated task.
	pub task_id: String,
	/// Version of the evaluated task set.
	pub task_version: String,
	/// Version of the candidate scorer.
	pub scorer_version: String,
	/// Four ordered evaluator components.
	pub components: Vec<CandidateEvaluatorComponent>,
	/// Exact numerator of the candidate score.
	pub score_numerator: u64,
	/// Exact denominator of the candidate score.
	pub score_denominator: u64,
	/// Candidate score rounded to six decimal places.
	pub score_decimal_6: String,
}
impl CandidateEvaluatorResult {
	/// Validates component order, weights, assertion evidence, and exact score.
	pub fn validate(&self) -> Result<(), CandidateGateError> {
		if self.schema_version != CANDIDATE_EVALUATOR_RESULT_SCHEMA
			|| self.task_version != CANDIDATE_TASK_SET_VERSION
			|| self.scorer_version != CANDIDATE_SCORER_VERSION
			|| !valid_identifier(&self.task_id)
		{
			return Err(CandidateGateError::new("candidate evaluator result identity is invalid"));
		}

		let (numerator, denominator) = candidate_score_fraction(&self.components)?;

		if self.score_numerator != numerator
			|| self.score_denominator != denominator
			|| self.score_decimal_6 != decimal_score_6(numerator, denominator)?
		{
			return Err(CandidateGateError::new(
				"candidate evaluator score does not match its binary assertions",
			));
		}

		Ok(())
	}

	/// Returns the canonical result digest after complete validation.
	pub fn digest(&self) -> Result<String, CandidateGateError> {
		self.validate()?;

		canonical_digest(self)
	}
}

/// Public identity of the private execution-authorization signer.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CandidateAuthorizationSigner {
	/// Stable node identifier derived from the public key.
	pub node_id: String,
	/// Hex-encoded public verification key.
	pub public_key: String,
	/// Signature algorithm used by the authorization signer.
	pub algorithm: String,
}

/// Isolated signing identity for the private execution authorization.
pub struct CandidateAuthorizationIdentity {
	signing_key: SigningKey,
	signer: CandidateAuthorizationSigner,
}
impl CandidateAuthorizationIdentity {
	/// Creates an authorization identity from one deployment-provided secret.
	#[must_use]
	pub fn from_secret(secret: [u8; 32]) -> Self {
		let signing_key = SigningKey::from_bytes(&secret);
		let public_bytes = signing_key.verifying_key().to_bytes();
		let public_key = hex::encode(public_bytes);
		let node_id = candidate_authorization_node_id(&public_bytes);

		Self {
			signing_key,
			signer: CandidateAuthorizationSigner {
				node_id,
				public_key,
				algorithm: "ed25519".to_owned(),
			},
		}
	}

	/// Returns the nonsecret signer identity for out-of-band pinning.
	#[must_use]
	pub fn signer(&self) -> &CandidateAuthorizationSigner {
		&self.signer
	}

	/// Issues a private authorization over the complete validated plan.
	pub fn authorize(
		&self,
		plan: CandidateExecutionPlan,
		admission: &ReleaseGateAdmissionV1,
	) -> Result<CandidateExecutionAuthorization, CandidateGateError> {
		plan.validate_against_admission(admission)?;

		let plan_sha256 = canonical_digest(&plan)?;
		let mut authorization = CandidateExecutionAuthorization {
			schema_version: CANDIDATE_EXECUTION_AUTHORIZATION_SCHEMA.to_owned(),
			signature_domain: CANDIDATE_EXECUTION_AUTHORIZATION_SCHEMA.to_owned(),
			signature_encoding: SORTED_KEY_JSON.to_owned(),
			purpose: CANDIDATE_AUTHORIZATION_PURPOSE.to_owned(),
			release_identity: RELEASE_IDENTITY.to_owned(),
			execution_plan_digest: plan.execution_plan_digest.clone(),
			signed_admission_sha256: plan.signed_admission_sha256.clone(),
			private_plan_sha256: plan_sha256,
			plan,
			signer: self.signer.clone(),
			signature: String::new(),
		};
		let signature = self.signing_key.sign(&authorization.signing_bytes()?);

		authorization.signature = hex::encode(signature.to_bytes());

		Ok(authorization)
	}
}

/// Distinct private authorization over the complete private execution plan.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CandidateExecutionAuthorization {
	/// Schema identifier for the private authorization.
	pub schema_version: String,
	/// Domain separator for the authorization signature.
	pub signature_domain: String,
	/// Canonical encoding used for the signature preimage.
	pub signature_encoding: String,
	/// Fixed purpose of the private authorization.
	pub purpose: String,
	/// Candidate release identity authorized for execution.
	pub release_identity: String,
	/// Digest that identifies the execution plan in the admission.
	pub execution_plan_digest: String,
	/// SHA-256 digest of the complete signed admission.
	pub signed_admission_sha256: String,
	/// SHA-256 digest of the complete private plan.
	pub private_plan_sha256: String,
	/// Complete private execution plan covered by the signature.
	pub plan: CandidateExecutionPlan,
	/// Public identity of the authorization signer.
	pub signer: CandidateAuthorizationSigner,
	/// Signature over the canonical authorization preimage.
	pub signature: String,
}
impl CandidateExecutionAuthorization {
	fn signing_bytes(&self) -> Result<Vec<u8>, CandidateGateError> {
		protocol::canonical_json(&UnsignedCandidateExecutionAuthorization {
			schema_version: &self.schema_version,
			signature_domain: &self.signature_domain,
			signature_encoding: &self.signature_encoding,
			purpose: &self.purpose,
			release_identity: &self.release_identity,
			execution_plan_digest: &self.execution_plan_digest,
			signed_admission_sha256: &self.signed_admission_sha256,
			private_plan_sha256: &self.private_plan_sha256,
			plan: &self.plan,
			signer: &self.signer,
		})
		.map_err(|_| CandidateGateError::new("candidate authorization cannot be canonicalized"))
	}

	/// Verifies the authorization signature and all admission/plan bindings.
	pub fn verify(
		&self,
		admission: &ReleaseGateAdmissionV1,
		expected_signer_node_id: &str,
		expected_signer_public_key: &str,
	) -> Result<(), CandidateGateError> {
		if self.schema_version != CANDIDATE_EXECUTION_AUTHORIZATION_SCHEMA
			|| self.signature_domain != CANDIDATE_EXECUTION_AUTHORIZATION_SCHEMA
			|| self.signature_encoding != SORTED_KEY_JSON
			|| self.purpose != CANDIDATE_AUTHORIZATION_PURPOSE
			|| self.release_identity != RELEASE_IDENTITY
			|| self.execution_plan_digest != self.plan.execution_plan_digest
			|| self.signed_admission_sha256 != self.plan.signed_admission_sha256
			|| self.private_plan_sha256 != canonical_digest(&self.plan)?
		{
			return Err(CandidateGateError::new(
				"candidate execution authorization identity or plan binding is invalid",
			));
		}
		if self.signer.node_id != expected_signer_node_id
			|| self.signer.public_key != expected_signer_public_key
			|| self.signer.algorithm != "ed25519"
			|| !valid_lower_hex(&self.signer.public_key, 64)
			|| candidate_authorization_node_id_from_hex(&self.signer.public_key)?
				!= self.signer.node_id
			|| !valid_lower_hex(&self.signature, 128)
		{
			return Err(CandidateGateError::new(
				"candidate execution authorization signer is invalid or unpinned",
			));
		}

		let public_bytes = hex::decode(&self.signer.public_key).map_err(|_| {
			CandidateGateError::new("candidate authorization public key is invalid")
		})?;
		let public_array: [u8; 32] = public_bytes.try_into().map_err(|_| {
			CandidateGateError::new("candidate authorization public key is invalid")
		})?;
		let verifying_key = VerifyingKey::from_bytes(&public_array).map_err(|_| {
			CandidateGateError::new("candidate authorization public key is invalid")
		})?;
		let signature_bytes = hex::decode(&self.signature)
			.map_err(|_| CandidateGateError::new("candidate authorization signature is invalid"))?;
		let signature = Signature::from_slice(&signature_bytes)
			.map_err(|_| CandidateGateError::new("candidate authorization signature is invalid"))?;

		verifying_key.verify(&self.signing_bytes()?, &signature).map_err(|_| {
			CandidateGateError::new("candidate authorization signature does not verify")
		})?;

		self.plan.validate_against_admission(admission)
	}

	/// Returns the canonical full-document digest, including the signature.
	pub fn digest(&self) -> Result<String, CandidateGateError> {
		canonical_digest(self)
	}
}

/// Held create-once reservations for every output in the signed plan.
///
/// Empty files are reservations, not completed output. `fill` writes a private
/// sibling, synchronizes it, and atomically exchanges it with the held empty
/// inode. A resumed nonempty output is immutable and can never be overwritten.
pub struct CandidateOutputReservations {
	outputs: BTreeMap<String, ReservedCandidateOutput>,
}
impl CandidateOutputReservations {
	/// Creates every exact output path before a model can start.
	pub fn reserve(
		plan: &CandidateExecutionPlan,
		admission: &ReleaseGateAdmissionV1,
	) -> Result<Self, CandidateGateError> {
		plan.validate_against_admission(admission)?;

		let mut reservations = Self { outputs: BTreeMap::new() };

		for (key, path) in plan.output_paths() {
			validate_secure_output_parent(path)?;

			let (file, identity, created) = create_or_recover_candidate_reservation(path)?;

			reservations.outputs.insert(
				key,
				ReservedCandidateOutput {
					path: path.to_path_buf(),
					file: Some(file),
					identity,
					remove_if_unfilled: created,
					state: CandidateOutputState::Reserved,
				},
			);
		}
		for output in reservations.outputs.values() {
			let file = output.file.as_ref().ok_or_else(|| {
				CandidateGateError::new("candidate output reservation is not held")
			})?;
			let metadata = file.metadata().map_err(|_| {
				CandidateGateError::new("candidate reservation metadata is unavailable")
			})?;

			validate_reserved_metadata(&metadata, true)?;

			if file_identity(&metadata)? != output.identity
				|| path_identity(&output.path)? != output.identity
			{
				return Err(CandidateGateError::new(
					"candidate output reservation changed during set construction",
				));
			}
		}
		// The complete create-or-recover set is durable before model work. Drop
		// cleanup is only for new files in a failed partial construction.
		for output in reservations.outputs.values_mut() {
			output.remove_if_unfilled = false;
		}

		Ok(reservations)
	}

	/// Reopens every exact output path from the signed plan without selectors.
	///
	/// All paths must already exist. Nonempty paths are recorded as immutable
	/// completed output. Empty paths remain held reservations for a later fill.
	pub fn resume(
		plan: &CandidateExecutionPlan,
		admission: &ReleaseGateAdmissionV1,
	) -> Result<Self, CandidateGateError> {
		plan.validate_against_admission(admission)?;

		let mut reservations = Self { outputs: BTreeMap::new() };

		for (key, path) in plan.output_paths() {
			validate_secure_output_parent(path)?;

			let mut options = OpenOptions::new();

			options.read(true).write(true);
			#[cfg(unix)]
			options.custom_flags(O_NOFOLLOW | O_CLOEXEC);

			let mut file = options.open(path).map_err(|_| {
				CandidateGateError::new("candidate resume requires every exact plan output")
			})?;
			let metadata = file
				.metadata()
				.map_err(|_| CandidateGateError::new("candidate resume metadata is unavailable"))?;

			validate_reserved_metadata(&metadata, false)?;

			let identity = file_identity(&metadata)?;
			let state = if metadata.len() == 0 {
				lock_candidate_reservation(&file)?;

				CandidateOutputState::Reserved
			} else {
				if metadata.len() > MAX_RESUMED_OUTPUT_BYTES {
					return Err(CandidateGateError::new(
						"candidate resumed output exceeds its verification limit",
					));
				}

				let mut hasher = Sha256::new();

				file.seek(SeekFrom::Start(0))?;

				let mut buffer = [0_u8; 16 * 1_024];

				loop {
					let read = file.read(&mut buffer)?;

					if read == 0 {
						break;
					}

					hasher.update(&buffer[..read]);
				}

				let digest = format!("sha256:{}", hex::encode(hasher.finalize()));

				CandidateOutputState::Filled { sha256: digest }
			};

			reservations.outputs.insert(
				key,
				ReservedCandidateOutput {
					path: path.to_path_buf(),
					file: Some(file),
					identity,
					remove_if_unfilled: false,
					state,
				},
			);
		}

		Ok(reservations)
	}

	/// Returns the exact output keys and their current states.
	#[must_use]
	pub fn states(&self) -> BTreeMap<String, CandidateOutputState> {
		self.outputs.iter().map(|(key, output)| (key.clone(), output.state.clone())).collect()
	}

	/// Returns the exact plan-bound path for an output key.
	#[must_use]
	pub fn path(&self, key: &str) -> Option<&Path> {
		self.outputs.get(key).map(|output| output.path.as_path())
	}

	/// Reads one immutable completed output through its held plan-bound inode.
	pub fn read_filled(&mut self, key: &str) -> Result<Vec<u8>, CandidateGateError> {
		let output = self.outputs.get_mut(key).ok_or_else(|| {
			CandidateGateError::new("candidate output key is not in the signed plan")
		})?;
		let expected_digest = match &output.state {
			CandidateOutputState::Filled { sha256 } => sha256.clone(),
			CandidateOutputState::Reserved => {
				return Err(CandidateGateError::new(
					"candidate aggregate requires every unit output to be filled",
				));
			},
		};
		let file = output
			.file
			.as_mut()
			.ok_or_else(|| CandidateGateError::new("candidate filled output inode is not held"))?;
		let before = file.metadata().map_err(|_| {
			CandidateGateError::new("candidate filled output metadata is unavailable")
		})?;

		validate_filled_metadata(&before, before.len())?;

		if file_identity(&before)? != output.identity
			|| path_identity(&output.path)? != output.identity
		{
			return Err(CandidateGateError::new(
				"candidate filled output was replaced before aggregate read",
			));
		}

		file.seek(SeekFrom::Start(0))?;

		let mut bytes = Vec::with_capacity(before.len() as usize);

		(&mut *file).take(MAX_RESUMED_OUTPUT_BYTES + 1).read_to_end(&mut bytes)?;

		let after = file.metadata().map_err(|_| {
			CandidateGateError::new("candidate filled output metadata is unavailable")
		})?;

		if bytes.len() as u64 != before.len()
			|| before.len() != after.len()
			|| file_identity(&after)? != output.identity
			|| path_identity(&output.path)? != output.identity
			|| digest_bytes(&bytes) != expected_digest
		{
			return Err(CandidateGateError::new(
				"candidate filled output changed during aggregate read",
			));
		}

		Ok(bytes)
	}

	/// Atomically fills one held empty reservation exactly once.
	pub fn fill(&mut self, key: &str, bytes: &[u8]) -> Result<String, CandidateGateError> {
		if bytes.is_empty() {
			return Err(CandidateGateError::new("candidate completed output must not be empty"));
		}
		if bytes.len() as u64 > MAX_RESUMED_OUTPUT_BYTES {
			return Err(CandidateGateError::new(
				"candidate completed output exceeds its byte limit",
			));
		}

		let output = self.outputs.get_mut(key).ok_or_else(|| {
			CandidateGateError::new("candidate output key is not in the signed plan")
		})?;

		if !matches!(output.state, CandidateOutputState::Reserved) {
			return Err(CandidateGateError::new(
				"candidate completed output cannot be overwritten",
			));
		}

		let held_file = output
			.file
			.as_ref()
			.ok_or_else(|| CandidateGateError::new("candidate output reservation is not held"))?;
		let held_metadata = held_file.metadata().map_err(|_| {
			CandidateGateError::new("candidate reservation metadata is unavailable")
		})?;

		validate_reserved_metadata(&held_metadata, true)?;

		if file_identity(&held_metadata)? != output.identity
			|| path_identity(&output.path)? != output.identity
		{
			return Err(CandidateGateError::new(
				"candidate output reservation was replaced before fill",
			));
		}

		let (temporary_path, temporary_identity) = write_candidate_output_sibling(output, bytes)?;

		if path_identity(&output.path)? != output.identity {
			remove_file_if_identity(&temporary_path, temporary_identity);

			return Err(CandidateGateError::new(
				"candidate output reservation was replaced before atomic fill",
			));
		}

		if let Err(error) = atomic_exchange(&temporary_path, &output.path) {
			remove_file_if_identity(&temporary_path, temporary_identity);

			return Err(CandidateGateError::new(format!(
				"candidate output cannot be atomically filled: {error}"
			)));
		}

		let digest = digest_bytes(bytes);

		output.state = CandidateOutputState::Filled { sha256: digest.clone() };
		output.remove_if_unfilled = false;

		output.file.take();

		let exchanged_reservation = path_identity(&temporary_path)?;
		let filled_identity = path_identity(&output.path)?;

		if exchanged_reservation != output.identity || filled_identity != temporary_identity {
			return Err(CandidateGateError::new(
				"candidate atomic output identities do not match the held reservation",
			));
		}

		let filled_metadata = fs::symlink_metadata(&output.path).map_err(|_| {
			CandidateGateError::new("candidate filled output metadata is unavailable")
		})?;

		validate_filled_metadata(&filled_metadata, bytes.len() as u64)?;
		remove_file_if_identity(&temporary_path, output.identity);

		if fs::symlink_metadata(&temporary_path).is_ok() {
			return Err(CandidateGateError::new(
				"candidate exchanged reservation cannot be removed",
			));
		}

		sync_parent_directory(&output.path)?;

		Ok(digest)
	}
}

impl Drop for CandidateOutputReservations {
	fn drop(&mut self) {
		for output in self.outputs.values_mut() {
			if output.remove_if_unfilled
				&& matches!(output.state, CandidateOutputState::Reserved)
				&& path_identity(&output.path).ok() == Some(output.identity)
				&& fs::metadata(&output.path).ok().is_some_and(|metadata| metadata.len() == 0)
			{
				output.file.take();

				remove_file_if_identity(&output.path, output.identity);
			}
		}
	}
}

/// Out-of-band pins required before the authorized callback can run.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CandidateExecutionExpectations {
	/// Pinned path to the private authorization.
	pub authorization_path: PathBuf,
	/// Pinned SHA-256 digest of the private authorization.
	pub authorization_sha256: String,
	/// Pinned node identifier for the authorization signer.
	pub authorization_signer_node_id: String,
	/// Pinned public key for the authorization signer.
	pub authorization_signer_public_key: String,
	/// Pinned path to the canonical signed admission.
	pub signed_admission_path: PathBuf,
	/// Pinned SHA-256 digest of the complete signed admission.
	pub signed_admission_sha256: String,
	/// Pinned key identifier for the admission signer.
	pub signed_admission_key_id: String,
	/// Pinned canonical public release trust-policy path.
	pub release_trust_policy_path: PathBuf,
	/// Independently protected release trust-policy digest.
	pub release_trust_policy_sha256: String,
	/// Pinned digest that identifies the execution plan.
	pub execution_plan_sha256: String,
	/// Pinned path to the public-safe corpus manifest.
	pub corpus_manifest_path: PathBuf,
	/// Pinned SHA-256 digest of the corpus manifest.
	pub corpus_manifest_sha256: String,
	/// Pinned path to the private core corpus commitment.
	pub core_corpus_commitment_path: PathBuf,
	/// Pinned SHA-256 digest of the core corpus commitment.
	pub core_corpus_commitment_sha256: String,
	/// Pinned path to the private contrast corpus commitment.
	pub contrast_corpus_commitment_path: PathBuf,
	/// Pinned SHA-256 digest of the contrast corpus commitment.
	pub contrast_corpus_commitment_sha256: String,
	/// Pinned isolated root directory for verifier replay.
	pub verifier_replay_root: PathBuf,
	/// Trusted observation time used for collection-window checks.
	pub observed_at: String,
}
impl CandidateExecutionExpectations {
	fn validate_plan_references(
		&self,
		plan: &CandidateExecutionPlan,
	) -> Result<(), CandidateGateError> {
		if plan.authorization_path != self.authorization_path
			|| plan.signed_admission_path != self.signed_admission_path
			|| plan.signed_admission_sha256 != self.signed_admission_sha256
			|| plan.signed_admission_key_id != self.signed_admission_key_id
			|| plan.release_trust_policy_path != self.release_trust_policy_path
			|| plan.release_trust_policy_sha256 != self.release_trust_policy_sha256
			|| plan.execution_plan_digest != self.execution_plan_sha256
			|| plan.corpus_manifest_path != self.corpus_manifest_path
			|| plan.corpus_manifest_sha256 != self.corpus_manifest_sha256
			|| plan.core_corpus_commitment_path != self.core_corpus_commitment_path
			|| plan.core_corpus_commitment_sha256 != self.core_corpus_commitment_sha256
			|| plan.contrast_corpus_commitment_path != self.contrast_corpus_commitment_path
			|| plan.contrast_corpus_commitment_sha256 != self.contrast_corpus_commitment_sha256
			|| plan.controlled_inputs.verifier_replay_root != self.verifier_replay_root
		{
			return Err(CandidateGateError::new(
				"candidate private plan does not match the out-of-band execution pins",
			));
		}

		Ok(())
	}
}

/// Closed model-free inputs for the final candidate aggregate lifecycle.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CandidateAggregateExpectations {
	/// Exact authorization, admission, corpus, and observation-time pins.
	pub execution: CandidateExecutionExpectations,
	/// Canonical signed release authority document.
	pub release_authority_path: PathBuf,
	/// Canonical digest of the complete signed release authority.
	pub release_authority_sha256: String,
	/// Public trust-policy material independently pinned by the protected runtime environment.
	pub release_trust_policy_path: PathBuf,
	/// Public-safe collection time emitted into the aggregate observations.
	pub collected_at: String,
}
impl CandidateAggregateExpectations {
	/// Validates pins that are independent of the signed private plan.
	pub fn validate(&self) -> Result<(), CandidateGateError> {
		if !valid_digest(&self.release_authority_sha256)
			|| self.collected_at != self.execution.observed_at
			|| self.release_trust_policy_path != self.execution.release_trust_policy_path
		{
			return Err(CandidateGateError::new(
				"candidate aggregate authority or collection-time pin is invalid",
			));
		}

		for path in [&self.release_authority_path, &self.release_trust_policy_path] {
			validate_absolute_file_path(path)?;
		}

		if self.release_authority_path == self.release_trust_policy_path {
			return Err(CandidateGateError::new(
				"candidate aggregate authority and trust policy must be distinct",
			));
		}

		Ok(())
	}
}

/// Exact signed repeat checkpoint supplied to a model-capable callback.
pub struct CandidateRepeatExecution<'a> {
	/// Signed schedule entry for the selected repeat.
	pub repeat: &'a ReleaseGateRepeat,
	/// Seven plan-bound units in the selected repeat.
	pub units: &'a [CandidateExecutionUnit],
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CandidateReleaseTrustPolicy {
	schema_version: String,
	release_identity: String,
	authority_signers: Vec<CandidateTrustedSigner>,
	promotion_signers: Vec<CandidateTrustedSigner>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CandidateTrustedSigner {
	key_id: String,
	algorithm: String,
	public_key_spki_base64: String,
	public_key_fingerprint: String,
}

#[derive(Clone, Copy)]
struct ModelIdentity {
	canonical_model_id: &'static str,
	execution_model_id: &'static str,
	family: &'static str,
	reasoning_effort: &'static str,
	model_name: &'static str,
}

struct CandidateUnitDerivation<'a> {
	models: &'a [CandidateResolvedModel],
	work_root: &'a Path,
	output_root: &'a Path,
	core_corpus_commitment_path: &'a Path,
	core_corpus_commitment_sha256: &'a str,
	contrast_corpus_commitment_path: &'a Path,
	contrast_corpus_commitment_sha256: &'a str,
}
impl<'a> CandidateUnitDerivation<'a> {
	fn from_inputs(inputs: &'a CandidatePlanInputs, models: &'a [CandidateResolvedModel]) -> Self {
		Self {
			models,
			work_root: &inputs.controlled_inputs.work_root,
			output_root: &inputs.output_root,
			core_corpus_commitment_path: &inputs.core_corpus_commitment_path,
			core_corpus_commitment_sha256: &inputs.core_corpus_commitment_sha256,
			contrast_corpus_commitment_path: &inputs.contrast_corpus_commitment_path,
			contrast_corpus_commitment_sha256: &inputs.contrast_corpus_commitment_sha256,
		}
	}

	fn from_plan(plan: &'a CandidateExecutionPlan, models: &'a [CandidateResolvedModel]) -> Self {
		Self {
			models,
			work_root: &plan.controlled_inputs.work_root,
			output_root: &plan.output_root,
			core_corpus_commitment_path: &plan.core_corpus_commitment_path,
			core_corpus_commitment_sha256: &plan.core_corpus_commitment_sha256,
			contrast_corpus_commitment_path: &plan.contrast_corpus_commitment_path,
			contrast_corpus_commitment_sha256: &plan.contrast_corpus_commitment_sha256,
		}
	}
}

struct CandidateContrastUnitSpec<'a> {
	contrast_index: usize,
	contrast_id: &'a str,
	arm: CandidateContrastArm,
	variant_sha256: &'a str,
	task_id: &'a str,
}

#[derive(Serialize)]
struct UnsignedCandidateExecutionAuthorization<'a> {
	schema_version: &'a str,
	signature_domain: &'a str,
	signature_encoding: &'a str,
	purpose: &'a str,
	release_identity: &'a str,
	execution_plan_digest: &'a str,
	signed_admission_sha256: &'a str,
	private_plan_sha256: &'a str,
	plan: &'a CandidateExecutionPlan,
	signer: &'a CandidateAuthorizationSigner,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct FileIdentity {
	device: u64,
	inode: u64,
}

struct ReservedCandidateOutput {
	path: PathBuf,
	file: Option<File>,
	identity: FileIdentity,
	remove_if_unfilled: bool,
	state: CandidateOutputState,
}

/// One classified attempt failure. Only admission failure can be retried, and
/// only before the model starts.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CandidateAttemptFailure {
	/// Admission failed before the model started.
	PreModelAdmission,
	/// The model failed after execution started.
	ModelFailure,
	/// The evaluator failed after model execution.
	EvaluatorFailure,
}
impl CandidateAttemptFailure {
	fn is_retryable_infrastructure(self) -> bool {
		matches!(self, Self::PreModelAdmission)
	}
}

/// Kind of one private execution unit.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CandidateExecutionUnitKind {
	/// Unit that executes all core tasks.
	Core,
	/// Unit that executes one contrast arm.
	Contrast,
}

/// Contrast arm selected by the signed repeat schedule.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CandidateContrastArm {
	/// Reference arm of a paired contrast.
	Reference,
	/// Challenge arm of a paired contrast.
	Challenge,
}

/// Released surfaces that must never consume candidate calibration output.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ForbiddenCandidatePath {
	/// Official result-package creation path.
	OfficialPackage,
	/// Official submission path.
	OfficialSubmission,
	/// Public ranking path.
	Ranking,
	/// Released catalog path.
	ReleasedCatalog,
}

/// Whether output files must be fresh or may reopen the complete signed plan.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CandidateReservationMode {
	/// Require every signed output path to be absent.
	Fresh,
	/// Reopen output paths from the exact signed plan.
	ResumeExactPlan,
}

/// Observable state of one exact signed output path.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CandidateOutputState {
	/// Output path is held as an empty create-once reservation.
	Reserved,
	/// Output path contains immutable completed output.
	Filled {
		/// SHA-256 digest of the completed output bytes.
		sha256: String,
	},
}

#[derive(Clone, Copy)]
enum CandidateExecutableRole {
	Runner,
	Verifier,
}

/// Reads and validates the exact canonical public admission reference.
///
/// The expected digest is the digest of the complete signed admission, not the
/// Ed25519 signing preimage. The authority signature itself remains verified by
/// the TypeScript trust-root protocol; the pinned full-document digest and key
/// ID prevent Rust execution from selecting another signed admission.
pub fn verify_canonical_admission_reference(
	path: &Path,
	expected_admission_sha256: &str,
	expected_execution_plan_sha256: &str,
	expected_corpus_manifest_sha256: &str,
	expected_key_id: &str,
) -> Result<VerifiedReleaseGateAdmission, CandidateGateError> {
	if !valid_digest(expected_admission_sha256)
		|| !valid_digest(expected_execution_plan_sha256)
		|| !valid_digest(expected_corpus_manifest_sha256)
	{
		return Err(CandidateGateError::new(
			"expected admission, execution-plan, or corpus-manifest digest is invalid",
		));
	}

	let (value, canonical_bytes) = read_canonical_json_file(path, MAX_ADMISSION_BYTES)?;
	let admission: ReleaseGateAdmissionV1 = serde_json::from_value(value)
		.map_err(|_| CandidateGateError::new("release-gate admission shape is invalid"))?;

	admission.validate(expected_key_id)?;

	let canonical_sha256 = digest_bytes(&canonical_bytes);

	if canonical_sha256 != expected_admission_sha256
		|| admission.execution_plan_digest != expected_execution_plan_sha256
		|| admission.corpus_commitment_digest != expected_corpus_manifest_sha256
	{
		return Err(CandidateGateError::new(
			"release-gate admission does not match its pinned references",
		));
	}

	Ok(VerifiedReleaseGateAdmission { admission, canonical_sha256 })
}

/// Verifies the outer manifest and both bounded canonical inner commitments.
pub fn verify_release_gate_corpus_references(
	manifest_path: &Path,
	expected_manifest_sha256: &str,
	core_commitment_path: &Path,
	expected_core_sha256: &str,
	contrast_commitment_path: &Path,
	expected_contrast_sha256: &str,
) -> Result<VerifiedReleaseGateCorpus, CandidateGateError> {
	let (value, manifest_bytes) =
		read_canonical_json_file(manifest_path, MAX_CORPUS_MANIFEST_BYTES)?;
	let manifest: ReleaseGateCorpusManifestV1 = serde_json::from_value(value)
		.map_err(|_| CandidateGateError::new("release-gate corpus manifest shape is invalid"))?;

	manifest.validate()?;

	let manifest_sha256 = digest_bytes(&manifest_bytes);

	if manifest_sha256 != expected_manifest_sha256
		|| manifest.core_corpus_commitment_sha256 != expected_core_sha256
		|| manifest.contrast_corpus_commitment_sha256 != expected_contrast_sha256
		|| manifest_path == core_commitment_path
		|| manifest_path == contrast_commitment_path
		|| core_commitment_path == contrast_commitment_path
	{
		return Err(CandidateGateError::new(
			"release-gate corpus references do not match the private plan",
		));
	}

	let (_, core_bytes) =
		read_canonical_json_file(core_commitment_path, MAX_INNER_COMMITMENT_BYTES)?;
	let (_, contrast_bytes) =
		read_canonical_json_file(contrast_commitment_path, MAX_INNER_COMMITMENT_BYTES)?;

	if digest_bytes(&core_bytes) != expected_core_sha256
		|| digest_bytes(&contrast_bytes) != expected_contrast_sha256
	{
		return Err(CandidateGateError::new(
			"release-gate inner corpus commitment identity is invalid",
		));
	}

	Ok(VerifiedReleaseGateCorpus { manifest, manifest_sha256 })
}

/// Resolves only one of the seventeen preregistered synthetic execution IDs.
pub fn resolve_candidate_execution_identity(
	execution_model_id: &str,
) -> Result<CandidateResolvedModel, CandidateGateError> {
	let identity = MODEL_IDENTITIES
		.iter()
		.find(|identity| identity.execution_model_id == execution_model_id)
		.ok_or_else(|| CandidateGateError::new("unknown candidate execution model identity"))?;

	Ok(CandidateResolvedModel {
		canonical_model_id: identity.canonical_model_id.to_owned(),
		execution_model_id: identity.execution_model_id.to_owned(),
		model_name: identity.model_name.to_owned(),
		reasoning_effort: identity.reasoning_effort.to_owned(),
	})
}

/// Builds the only supported twenty-one-unit private execution plan.
pub fn build_candidate_execution_plan(
	admission: &ReleaseGateAdmissionV1,
	inputs: CandidatePlanInputs,
) -> Result<CandidateExecutionPlan, CandidateGateError> {
	admission.validate(&inputs.signed_admission_key_id)?;

	validate_absolute_directory_path(&inputs.output_root)?;

	let models = expected_resolved_models()?;
	let core_tasks = candidate_task_ids()?;
	let contrast_task_bindings = fixed_contrast_task_bindings();
	let unit_derivation = CandidateUnitDerivation::from_inputs(&inputs, &models);
	let execution_units = build_candidate_execution_units(
		admission,
		&unit_derivation,
		&core_tasks,
		&contrast_task_bindings,
	)?;
	let plan = CandidateExecutionPlan {
		schema_version: CANDIDATE_EXECUTION_PLAN_SCHEMA.to_owned(),
		purpose: CANDIDATE_PLAN_PURPOSE.to_owned(),
		release_identity: RELEASE_IDENTITY.to_owned(),
		catalog_release_identity_digest: CANDIDATE_CATALOG_RELEASE_IDENTITY_SHA256.to_owned(),
		task_metadata_identity_digest: CANDIDATE_TASK_IDENTITY_SHA256.to_owned(),
		execution_plan_digest: admission.execution_plan_digest.clone(),
		model_id_mapping_digest: CANDIDATE_MODEL_ID_MAPPING_SHA256.to_owned(),
		signed_admission_path: inputs.signed_admission_path,
		signed_admission_sha256: inputs.signed_admission_sha256,
		signed_admission_key_id: inputs.signed_admission_key_id,
		release_trust_policy_path: inputs.release_trust_policy_path,
		release_trust_policy_sha256: inputs.release_trust_policy_sha256,
		corpus_manifest_path: inputs.corpus_manifest_path,
		corpus_manifest_sha256: inputs.corpus_manifest_sha256,
		core_corpus_commitment_path: inputs.core_corpus_commitment_path,
		core_corpus_commitment_sha256: inputs.core_corpus_commitment_sha256,
		contrast_corpus_commitment_path: inputs.contrast_corpus_commitment_path,
		contrast_corpus_commitment_sha256: inputs.contrast_corpus_commitment_sha256,
		authorization_path: inputs.authorization_path,
		runtime: inputs.runtime,
		controlled_inputs: inputs.controlled_inputs,
		output_root: inputs.output_root.clone(),
		contrast_task_bindings,
		execution_units,
		aggregate_outputs: CandidateAggregateOutputs {
			source_observations: inputs.output_root.join("aggregate-source-observations.json"),
			release_gate_evidence: inputs.output_root.join("aggregate-release-gate-evidence.json"),
		},
		classification: CandidateClassification::default(),
	};

	plan.validate_against_admission(admission)?;

	Ok(plan)
}

/// Reads one exact bounded canonical candidate reference without disclosing it.
pub fn read_canonical_candidate_reference(
	path: &Path,
	max_bytes: u64,
) -> Result<(Value, Vec<u8>), CandidateGateError> {
	read_canonical_json_file(path, max_bytes)
}

/// Rejects every attempt to route candidate output into a released surface.
pub fn reject_released_path(path: ForbiddenCandidatePath) -> Result<(), CandidateGateError> {
	let surface = match path {
		ForbiddenCandidatePath::OfficialPackage => "Official package",
		ForbiddenCandidatePath::OfficialSubmission => "Official submission",
		ForbiddenCandidatePath::Ranking => "ranking",
		ForbiddenCandidatePath::ReleasedCatalog => "released catalog",
	};

	Err(CandidateGateError::new(format!(
		"AIQ Core 1.0.2 candidate output cannot enter the {surface} path"
	)))
}

/// Computes the reduced exact score fraction for four ordered components.
pub fn candidate_score_fraction(
	components: &[CandidateEvaluatorComponent],
) -> Result<(u64, u64), CandidateGateError> {
	const LAYOUT: [(&str, u32); 4] = [
		("component_01", 3_000),
		("component_02", 2_500),
		("component_03", 2_500),
		("component_04", 2_000),
	];

	if components.len() != LAYOUT.len() {
		return Err(CandidateGateError::new(
			"candidate evaluator must contain exactly four ordered components",
		));
	}

	let mut numerator = 0_u64;
	let mut denominator = 1_u64;

	for (component, (expected_id, expected_weight)) in components.iter().zip(LAYOUT) {
		if component.component_id != expected_id
			|| component.weight_basis_points != expected_weight
			|| !(3..=64).contains(&component.assertions.len())
		{
			return Err(CandidateGateError::new(
				"candidate evaluator component identity, weight, or assertion count is invalid",
			));
		}

		let mut passed = 0_u64;
		let mut assertion_ids = BTreeSet::new();

		for assertion in &component.assertions {
			if !valid_identifier(&assertion.assertion_id)
				|| !assertion_ids.insert(assertion.assertion_id.as_str())
				|| !valid_digest(&assertion.evidence_sha256)
			{
				return Err(CandidateGateError::new(
					"candidate evaluator assertion identity or evidence is invalid",
				));
			}

			passed += u64::from(assertion.passed);
		}

		let term_numerator = u64::from(component.weight_basis_points)
			.checked_mul(passed)
			.ok_or_else(|| CandidateGateError::new("candidate score overflows"))?;
		let term_denominator = 10_000_u64
			.checked_mul(component.assertions.len() as u64)
			.ok_or_else(|| CandidateGateError::new("candidate score overflows"))?;
		let combined_numerator = numerator
			.checked_mul(term_denominator)
			.and_then(|value| {
				term_numerator.checked_mul(denominator).and_then(|term| value.checked_add(term))
			})
			.ok_or_else(|| CandidateGateError::new("candidate score overflows"))?;
		let combined_denominator = denominator
			.checked_mul(term_denominator)
			.ok_or_else(|| CandidateGateError::new("candidate score overflows"))?;
		let divisor = greatest_common_divisor(combined_numerator, combined_denominator);

		numerator = combined_numerator / divisor;
		denominator = combined_denominator / divisor;
	}

	Ok((numerator, denominator))
}

/// Creates or verifies an authorization with owner-only durable storage.
///
/// A retry after a crash accepts only the exact canonical bytes at the exact
/// private, single-link path. It never overwrites an existing path.
pub fn write_execution_authorization_create_once(
	path: &Path,
	authorization: &CandidateExecutionAuthorization,
	admission: &ReleaseGateAdmissionV1,
	expected_signer_node_id: &str,
	expected_signer_public_key: &str,
) -> Result<String, CandidateGateError> {
	validate_secure_output_parent(path)?;

	if authorization.plan.authorization_path != path {
		return Err(CandidateGateError::new(
			"candidate authorization path does not match the signed private plan",
		));
	}

	authorization.verify(admission, expected_signer_node_id, expected_signer_public_key)?;

	let canonical = protocol::canonical_json(authorization)
		.map_err(|_| CandidateGateError::new("candidate authorization cannot be canonicalized"))?;
	let digest = digest_bytes(&canonical);
	let mut bytes = canonical;

	bytes.push(b'\n');

	persist_or_verify_candidate_bytes(path, &bytes, "candidate authorization")?;

	Ok(digest)
}

/// Creates or verifies one canonical candidate lifecycle document.
///
/// A retry after a crash accepts only the exact canonical bytes at the exact
/// private, single-link path. It never overwrites an existing path.
pub fn write_candidate_canonical_create_once(
	path: &Path,
	value: &impl Serialize,
) -> Result<String, CandidateGateError> {
	validate_secure_output_parent(path)?;

	let canonical = protocol::canonical_json(value)
		.map_err(|_| CandidateGateError::new("candidate document cannot be canonicalized"))?;
	let digest = digest_bytes(&canonical);
	let mut bytes = canonical;

	bytes.push(b'\n');

	persist_or_verify_candidate_bytes(path, &bytes, "candidate document")?;

	Ok(digest)
}

/// Reads one pinned canonical private authorization and verifies its signature.
pub fn read_verified_execution_authorization(
	path: &Path,
	expected_authorization_sha256: &str,
	admission: &ReleaseGateAdmissionV1,
	expected_signer_node_id: &str,
	expected_signer_public_key: &str,
) -> Result<CandidateExecutionAuthorization, CandidateGateError> {
	let (value, canonical) = read_canonical_json_file(path, MAX_AUTHORIZATION_BYTES)?;

	if digest_bytes(&canonical) != expected_authorization_sha256 {
		return Err(CandidateGateError::new(
			"candidate authorization does not match its pinned digest",
		));
	}

	let authorization: CandidateExecutionAuthorization = serde_json::from_value(value)
		.map_err(|_| CandidateGateError::new("candidate authorization shape is invalid"))?;

	if authorization.plan.authorization_path != path {
		return Err(CandidateGateError::new(
			"candidate authorization location does not match its signed plan",
		));
	}

	authorization.verify(admission, expected_signer_node_id, expected_signer_public_key)?;

	Ok(authorization)
}

/// Verifies admission, private authorization, collection time, corpus split,
/// and all output reservations before invoking the only model-capable callback.
pub fn execute_after_authorization<T, F>(
	expectations: &CandidateExecutionExpectations,
	reservation_mode: CandidateReservationMode,
	callback: F,
) -> Result<T, CandidateGateError>
where
	F: FnOnce(
		&CandidateExecutionAuthorization,
		&ReleaseGateAdmissionV1,
		&VerifiedReleaseGateCorpus,
		&mut CandidateOutputReservations,
	) -> Result<T, CandidateGateError>,
{
	execute_after_authorization_for_role(
		expectations,
		reservation_mode,
		CandidateExecutableRole::Runner,
		None,
		callback,
	)
}

/// Verifier-only variant that binds the current executable before corpus access.
pub fn execute_verifier_after_authorization<T, F>(
	expectations: &CandidateExecutionExpectations,
	reservation_mode: CandidateReservationMode,
	verifier_signer_node_id: &str,
	callback: F,
) -> Result<T, CandidateGateError>
where
	F: FnOnce(
		&CandidateExecutionAuthorization,
		&ReleaseGateAdmissionV1,
		&VerifiedReleaseGateCorpus,
		&mut CandidateOutputReservations,
	) -> Result<T, CandidateGateError>,
{
	execute_after_authorization_for_role(
		expectations,
		reservation_mode,
		CandidateExecutableRole::Verifier,
		Some(verifier_signer_node_id),
		callback,
	)
}

/// Executes only one seven-unit signed repeat in its nonoverlapping time partition.
///
/// Repeat one creates all 86 reservations. Later repeats must reopen the entire
/// exact plan. A resumed first repeat is also allowed after an interrupted run.
pub fn execute_repeat_after_authorization<T, F>(
	expectations: &CandidateExecutionExpectations,
	reservation_mode: CandidateReservationMode,
	repeat_id: &str,
	runner_signer_node_id: &str,
	callback: F,
) -> Result<T, CandidateGateError>
where
	F: FnOnce(
		&CandidateExecutionAuthorization,
		&ReleaseGateAdmissionV1,
		&VerifiedReleaseGateCorpus,
		CandidateRepeatExecution<'_>,
		&mut CandidateOutputReservations,
	) -> Result<T, CandidateGateError>,
{
	let (authorization, admission, corpus) = verify_candidate_execution(
		expectations,
		CandidateExecutableRole::Runner,
		Some(runner_signer_node_id),
	)?;

	admission.validate_repeat_execution_time(repeat_id, &expectations.observed_at)?;

	let repeat_index = admission
		.repeat_schedule
		.iter()
		.position(|repeat| repeat.repeat_id == repeat_id)
		.ok_or_else(|| CandidateGateError::new("candidate repeat is not in the signed schedule"))?;

	if repeat_index > 0 && reservation_mode != CandidateReservationMode::ResumeExactPlan {
		return Err(CandidateGateError::new(
			"candidate repeats after the first must resume the exact pre-reserved plan",
		));
	}

	let units = authorization.plan.units_for_repeat(&admission, repeat_id)?;
	let mut outputs =
		open_candidate_output_reservations(&authorization.plan, &admission, reservation_mode)?;

	callback(
		&authorization,
		&admission,
		&corpus,
		CandidateRepeatExecution { repeat: &admission.repeat_schedule[repeat_index], units },
		&mut outputs,
	)
}

/// Validates the signed runner control plane before any private corpus is opened.
///
/// This entry point intentionally omits the collection-window check so the
/// operator can complete model-free corpus validation before a scheduled repeat.
pub fn verify_candidate_runner_preparation_authorization(
	expectations: &CandidateExecutionExpectations,
) -> Result<
	(CandidateExecutionAuthorization, ReleaseGateAdmissionV1, VerifiedReleaseGateCorpus),
	CandidateGateError,
> {
	let (authorization, admission) =
		verify_candidate_control_plane(expectations, CandidateExecutableRole::Runner, None, false)?;
	let corpus = verify_release_gate_corpus_references(
		&expectations.corpus_manifest_path,
		&expectations.corpus_manifest_sha256,
		&expectations.core_corpus_commitment_path,
		&expectations.core_corpus_commitment_sha256,
		&expectations.contrast_corpus_commitment_path,
		&expectations.contrast_corpus_commitment_sha256,
	)?;

	Ok((authorization, admission, corpus))
}

/// Verifies the protected policy and admission signature without opening private inputs.
pub fn verify_trusted_candidate_admission(
	expectations: &CandidateExecutionExpectations,
) -> Result<VerifiedReleaseGateAdmission, CandidateGateError> {
	let verified_admission = verify_canonical_admission_reference(
		&expectations.signed_admission_path,
		&expectations.signed_admission_sha256,
		&expectations.execution_plan_sha256,
		&expectations.corpus_manifest_sha256,
		&expectations.signed_admission_key_id,
	)?;

	verify_candidate_admission_trust_reference(
		&expectations.release_trust_policy_path,
		&expectations.release_trust_policy_sha256,
		&verified_admission.admission,
	)?;

	Ok(verified_admission)
}

/// Reads one canonical admission and verifies it against the protected trust policy.
pub fn read_trusted_candidate_admission(
	admission_path: &Path,
	policy_path: &Path,
) -> Result<ReleaseGateAdmissionV1, CandidateGateError> {
	let (value, _) = read_canonical_json_file(admission_path, MAX_ADMISSION_BYTES)?;
	let admission: ReleaseGateAdmissionV1 = serde_json::from_value(value)
		.map_err(|_| CandidateGateError::new("release-gate admission shape is invalid"))?;

	admission.validate(&admission.signer.key_id)?;

	let protected_digest = env::var(CANDIDATE_TRUST_POLICY_DIGEST_ENV).map_err(|_| {
		CandidateGateError::new("candidate protected release trust-policy digest is unavailable")
	})?;

	verify_candidate_admission_trust_reference(policy_path, &protected_digest, &admission)?;

	Ok(admission)
}

/// Verifies that the current process is the runner executable pinned by the plan.
pub fn validate_candidate_runner_executable_binding(
	plan: &CandidateExecutionPlan,
) -> Result<(), CandidateGateError> {
	validate_candidate_current_executable_binding(plan, CandidateExecutableRole::Runner)
}

fn write_candidate_output_sibling(
	output: &ReservedCandidateOutput,
	bytes: &[u8],
) -> Result<(PathBuf, FileIdentity), CandidateGateError> {
	let (temporary_path, mut temporary_file, temporary_identity) =
		create_private_output_sibling(&output.path)?;
	let result = (|| {
		temporary_file.write_all(bytes).and_then(|()| temporary_file.sync_all()).map_err(
			|error| CandidateGateError::new(format!("candidate output cannot be written: {error}")),
		)?;

		let metadata = temporary_file.metadata().map_err(|_| {
			CandidateGateError::new("candidate temporary output metadata is unavailable")
		})?;

		validate_filled_metadata(&metadata, bytes.len() as u64)?;

		if file_identity(&metadata)? != temporary_identity {
			return Err(CandidateGateError::new(
				"candidate temporary output identity changed while held",
			));
		}
		if temporary_identity == output.identity {
			return Err(CandidateGateError::new(
				"candidate temporary output aliases its reservation",
			));
		}

		Ok(())
	})();

	drop(temporary_file);

	if let Err(error) = result {
		remove_file_if_identity(&temporary_path, temporary_identity);

		return Err(error);
	}

	Ok((temporary_path, temporary_identity))
}

fn candidate_core_execution_unit(
	context: &CandidateUnitDerivation<'_>,
	repeat_index: usize,
	repeat: &ReleaseGateRepeat,
	core_tasks: &[String],
) -> CandidateExecutionUnit {
	let unit_id = deterministic_core_unit_id(repeat_index);

	CandidateExecutionUnit {
		unit_id: unit_id.clone(),
		repeat_id: repeat.repeat_id.clone(),
		slot_id: repeat.scheduled_at.clone(),
		kind: CandidateExecutionUnitKind::Core,
		contrast_id: None,
		contrast_arm: None,
		variant_sha256: None,
		ordered_task_ids: core_tasks.to_vec(),
		models: context.models.to_vec(),
		corpus_commitment_path: context.core_corpus_commitment_path.to_owned(),
		corpus_commitment_sha256: context.core_corpus_commitment_sha256.to_owned(),
		checkpoint_path: derived_unit_work_path(context.work_root, &unit_id, "checkpoint"),
		preflight_path: derived_unit_work_path(context.work_root, &unit_id, "preflight"),
		attempt_journal_path: derived_unit_work_path(
			context.work_root,
			&unit_id,
			"attempt-journal",
		),
		outputs: derived_unit_outputs(context.output_root, &unit_id),
	}
}

fn candidate_contrast_execution_unit(
	context: &CandidateUnitDerivation<'_>,
	repeat_index: usize,
	repeat: &ReleaseGateRepeat,
	spec: CandidateContrastUnitSpec<'_>,
) -> CandidateExecutionUnit {
	let unit_id = deterministic_contrast_unit_id(repeat_index, spec.contrast_index, spec.arm);

	CandidateExecutionUnit {
		unit_id: unit_id.clone(),
		repeat_id: repeat.repeat_id.clone(),
		slot_id: repeat.scheduled_at.clone(),
		kind: CandidateExecutionUnitKind::Contrast,
		contrast_id: Some(spec.contrast_id.to_owned()),
		contrast_arm: Some(spec.arm),
		variant_sha256: Some(spec.variant_sha256.to_owned()),
		ordered_task_ids: vec![spec.task_id.to_owned()],
		models: context.models.to_vec(),
		corpus_commitment_path: context.contrast_corpus_commitment_path.to_owned(),
		corpus_commitment_sha256: context.contrast_corpus_commitment_sha256.to_owned(),
		checkpoint_path: derived_unit_work_path(context.work_root, &unit_id, "checkpoint"),
		preflight_path: derived_unit_work_path(context.work_root, &unit_id, "preflight"),
		attempt_journal_path: derived_unit_work_path(
			context.work_root,
			&unit_id,
			"attempt-journal",
		),
		outputs: derived_unit_outputs(context.output_root, &unit_id),
	}
}

fn build_candidate_execution_units(
	admission: &ReleaseGateAdmissionV1,
	context: &CandidateUnitDerivation<'_>,
	core_tasks: &[String],
	contrast_task_bindings: &[CandidateContrastTaskBinding],
) -> Result<Vec<CandidateExecutionUnit>, CandidateGateError> {
	let task_map = contrast_task_bindings
		.iter()
		.map(|binding| (binding.contrast_id.as_str(), binding))
		.collect::<BTreeMap<_, _>>();
	let digest_map = admission
		.contrast_bindings
		.iter()
		.map(|binding| (binding.contrast_id.as_str(), binding))
		.collect::<BTreeMap<_, _>>();
	let mut execution_units = Vec::with_capacity(EXECUTION_UNIT_COUNT);

	for (repeat_index, repeat) in admission.repeat_schedule.iter().enumerate() {
		execution_units.push(candidate_core_execution_unit(
			context,
			repeat_index,
			repeat,
			core_tasks,
		));

		for arm_binding in &repeat.contrast_arm_order {
			let (contrast_id, arm) = parse_contrast_arm_binding(arm_binding)?;
			let contrast_index = CONTRAST_IDS
				.iter()
				.position(|candidate| *candidate == contrast_id)
				.ok_or_else(|| CandidateGateError::new("candidate contrast identity is unknown"))?;
			let task_binding = task_map.get(contrast_id).ok_or_else(|| {
				CandidateGateError::new("candidate fixed contrast task binding is missing")
			})?;
			let digest_binding = digest_map.get(contrast_id).ok_or_else(|| {
				CandidateGateError::new("candidate signed contrast digest binding is missing")
			})?;
			let (task_id, variant_sha256) = match arm {
				CandidateContrastArm::Reference => (
					task_binding.reference_task_id.as_str(),
					digest_binding.reference_variant_digest.as_str(),
				),
				CandidateContrastArm::Challenge => (
					task_binding.challenge_task_id.as_str(),
					digest_binding.challenge_variant_digest.as_str(),
				),
			};

			execution_units.push(candidate_contrast_execution_unit(
				context,
				repeat_index,
				repeat,
				CandidateContrastUnitSpec {
					contrast_index,
					contrast_id,
					arm,
					variant_sha256,
					task_id,
				},
			));
		}
	}

	Ok(execution_units)
}

fn fixed_contrast_task_bindings() -> Vec<CandidateContrastTaskBinding> {
	vec![
		CandidateContrastTaskBinding {
			contrast_id: "coupled_constraints".to_owned(),
			reference_task_id: "contrast-coupled-reference-01".to_owned(),
			challenge_task_id: "contrast-coupled-challenge-01".to_owned(),
		},
		CandidateContrastTaskBinding {
			contrast_id: "ambiguous_recovery_state".to_owned(),
			reference_task_id: "contrast-recovery-reference-01".to_owned(),
			challenge_task_id: "contrast-recovery-challenge-01".to_owned(),
		},
		CandidateContrastTaskBinding {
			contrast_id: "plausible_incomplete_evidence".to_owned(),
			reference_task_id: "contrast-evidence-reference-01".to_owned(),
			challenge_task_id: "contrast-evidence-challenge-01".to_owned(),
		},
	]
}

fn deterministic_core_unit_id(repeat_index: usize) -> String {
	format!("repeat-{:02}-core", repeat_index + 1)
}

fn deterministic_contrast_unit_id(
	repeat_index: usize,
	contrast_index: usize,
	arm: CandidateContrastArm,
) -> String {
	let arm = match arm {
		CandidateContrastArm::Reference => "reference",
		CandidateContrastArm::Challenge => "challenge",
	};

	format!("repeat-{:02}-contrast-{:02}-{arm}", repeat_index + 1, contrast_index + 1)
}

fn derived_unit_outputs(output_root: &Path, unit_id: &str) -> CandidateUnitOutputs {
	CandidateUnitOutputs {
		result_package_bundle: output_root.join(format!("{unit_id}.result-packages.json")),
		evaluator_result_bundle: output_root.join(format!("{unit_id}.evaluator-results.json")),
		verifier_replay_bundle: output_root.join(format!("{unit_id}.verifier-replays.json")),
		attempt_log_bundle: output_root.join(format!("{unit_id}.attempt-log.json")),
	}
}

fn derived_unit_work_path(work_root: &Path, unit_id: &str, kind: &str) -> PathBuf {
	work_root.join(format!("{unit_id}.{kind}.json"))
}

fn validate_unit_id<'a>(
	unit_id: &'a str,
	seen: &mut BTreeSet<&'a str>,
) -> Result<(), CandidateGateError> {
	if !valid_identifier(unit_id) || !seen.insert(unit_id) {
		return Err(CandidateGateError::new(
			"candidate execution unit identifier is invalid or duplicated",
		));
	}

	Ok(())
}

fn parse_contrast_arm_binding(
	binding: &str,
) -> Result<(&str, CandidateContrastArm), CandidateGateError> {
	let (contrast_id, arm) = binding
		.split_once(':')
		.ok_or_else(|| CandidateGateError::new("release-gate contrast arm binding is malformed"))?;
	let arm = match arm {
		"reference" => CandidateContrastArm::Reference,
		"challenge" => CandidateContrastArm::Challenge,
		_ => {
			return Err(CandidateGateError::new("release-gate contrast arm binding is malformed"));
		},
	};

	Ok((contrast_id, arm))
}

fn expected_contrast_arm_order(repeat_index: usize) -> Vec<String> {
	CONTRAST_IDS
		.into_iter()
		.flat_map(|contrast_id| {
			let arms = if repeat_index.is_multiple_of(2) {
				["reference", "challenge"]
			} else {
				["challenge", "reference"]
			};

			arms.map(|arm| format!("{contrast_id}:{arm}"))
		})
		.collect()
}

fn canonical_model_ids() -> Vec<String> {
	MODEL_IDENTITIES.iter().map(|identity| identity.canonical_model_id.to_owned()).collect()
}

fn expected_resolved_models() -> Result<Vec<CandidateResolvedModel>, CandidateGateError> {
	MODEL_IDENTITIES
		.iter()
		.map(|identity| resolve_candidate_execution_identity(identity.execution_model_id))
		.collect()
}

fn candidate_task_ids() -> Result<Vec<String>, CandidateGateError> {
	#[derive(Deserialize)]
	struct Catalog {
		tasks: Vec<CatalogTask>,
	}

	#[derive(Deserialize)]
	struct CatalogTask {
		task_id: String,
	}

	let catalog: Catalog = serde_json::from_str(CANDIDATE_CATALOG_JSON)
		.map_err(|_| CandidateGateError::new("embedded candidate catalog is invalid"))?;
	let task_ids = catalog.tasks.into_iter().map(|task| task.task_id).collect::<Vec<_>>();

	if task_ids.len() != CORE_TASK_COUNT
		|| task_ids.iter().any(|task_id| !valid_identifier(task_id))
		|| task_ids.iter().collect::<BTreeSet<_>>().len() != CORE_TASK_COUNT
	{
		return Err(CandidateGateError::new(
			"embedded candidate catalog does not contain 72 unique ordered task IDs",
		));
	}

	Ok(task_ids)
}

fn valid_identifier(value: &str) -> bool {
	let mut bytes = value.bytes();

	bytes.next().is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
		&& bytes.all(|byte| {
			byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
		})
}

fn valid_node_id(value: &str) -> bool {
	value.strip_prefix("node_").is_some_and(|digest| valid_lower_hex(digest, 64))
}

fn valid_digest(value: &str) -> bool {
	value.strip_prefix("sha256:").is_some_and(|digest| {
		digest.len() == 64
			&& digest != "0".repeat(64)
			&& digest.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
	})
}

fn valid_base64_ed25519_signature(value: &str) -> bool {
	value.len() == 88
		&& value.ends_with("==")
		&& value[..86]
			.bytes()
			.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/'))
}

fn parse_canonical_timestamp(value: &str) -> Result<Timestamp, CandidateGateError> {
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
		return Err(CandidateGateError::new(
			"release-gate timestamp must be canonical ISO milliseconds in UTC",
		));
	}

	value
		.parse::<Timestamp>()
		.map_err(|_| CandidateGateError::new("release-gate timestamp must be a valid UTC instant"))
}

fn canonical_digest<T>(value: &T) -> Result<String, CandidateGateError>
where
	T: Serialize,
{
	protocol::canonical_hash(value)
		.map_err(|_| CandidateGateError::new("candidate value cannot be canonically hashed"))
}

fn digest_bytes(bytes: &[u8]) -> String {
	format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
}

fn validate_absolute_file_path(path: &Path) -> Result<(), CandidateGateError> {
	if !path.is_absolute()
		|| path.file_name().is_none()
		|| path.components().any(|component| {
			matches!(component, Component::ParentDir | Component::CurDir | Component::Prefix(_))
		}) {
		return Err(CandidateGateError::new(
			"candidate plan paths must be normalized absolute file paths",
		));
	}

	Ok(())
}

fn validate_absolute_directory_path(path: &Path) -> Result<(), CandidateGateError> {
	if !path.is_absolute()
		|| path.file_name().is_none()
		|| path.components().any(|component| {
			matches!(component, Component::ParentDir | Component::CurDir | Component::Prefix(_))
		}) {
		return Err(CandidateGateError::new(
			"candidate output root must be a normalized absolute directory path",
		));
	}

	Ok(())
}

fn candidate_paths_overlap(left: &Path, right: &Path) -> bool {
	left == right || left.starts_with(right) || right.starts_with(left)
}

fn read_canonical_json_file(
	path: &Path,
	max_bytes: u64,
) -> Result<(Value, Vec<u8>), CandidateGateError> {
	validate_absolute_file_path(path)?;

	let parent = path
		.parent()
		.ok_or_else(|| CandidateGateError::new("candidate reference has no parent directory"))?;

	if fs::canonicalize(parent)
		.map_err(|_| CandidateGateError::new("candidate reference parent is unavailable"))?
		!= parent
	{
		return Err(CandidateGateError::new(
			"candidate reference parent must not contain symbolic-link indirection",
		));
	}

	let mut options = OpenOptions::new();

	options.read(true);
	#[cfg(unix)]
	options.custom_flags(O_NOFOLLOW | O_CLOEXEC);

	let file = options
		.open(path)
		.map_err(|_| CandidateGateError::new("candidate reference is unavailable"))?;
	let metadata = file
		.metadata()
		.map_err(|_| CandidateGateError::new("candidate reference metadata is unavailable"))?;

	if !metadata.is_file() || metadata.len() == 0 || metadata.len() > max_bytes {
		return Err(CandidateGateError::new(
			"candidate reference must be a nonempty bounded regular file",
		));
	}
	#[cfg(unix)]
	if metadata.nlink() != 1 {
		return Err(CandidateGateError::new(
			"candidate reference must have exactly one filesystem link",
		));
	}

	let mut bytes = Vec::with_capacity(metadata.len() as usize);

	file.take(max_bytes + 1)
		.read_to_end(&mut bytes)
		.map_err(|_| CandidateGateError::new("candidate reference cannot be read"))?;

	if bytes.len() as u64 > max_bytes {
		return Err(CandidateGateError::new("candidate reference exceeds its byte limit"));
	}

	let value: Value = serde_json::from_slice(&bytes)
		.map_err(|_| CandidateGateError::new("candidate reference is not valid JSON"))?;
	let canonical = protocol::canonical_json(&value)
		.map_err(|_| CandidateGateError::new("candidate reference cannot be canonicalized"))?;
	let exact = bytes == canonical
		|| bytes.strip_suffix(b"\n").is_some_and(|without_newline| without_newline == canonical);

	if !exact {
		return Err(CandidateGateError::new("candidate reference bytes are not canonical JSON"));
	}

	Ok((value, canonical))
}

fn greatest_common_divisor(mut left: u64, mut right: u64) -> u64 {
	while right != 0 {
		let remainder = left % right;

		left = right;
		right = remainder;
	}

	left.max(1)
}

fn decimal_score_6(numerator: u64, denominator: u64) -> Result<String, CandidateGateError> {
	if denominator == 0 || numerator > denominator {
		return Err(CandidateGateError::new("candidate score fraction is invalid"));
	}

	let scaled = numerator
		.checked_mul(1_000_000)
		.and_then(|value| value.checked_add(denominator / 2))
		.ok_or_else(|| CandidateGateError::new("candidate score overflows"))?
		/ denominator;

	Ok(format!("{}.{:06}", scaled / 1_000_000, scaled % 1_000_000))
}

fn persist_or_verify_candidate_bytes(
	path: &Path,
	bytes: &[u8],
	label: &str,
) -> Result<(), CandidateGateError> {
	let mut options = OpenOptions::new();

	options.read(true).write(true).create_new(true);
	#[cfg(unix)]
	options.mode(0o600).custom_flags(O_NOFOLLOW | O_CLOEXEC);

	let mut file = match options.open(path) {
		Ok(file) => file,
		Err(error) if error.kind() == ErrorKind::AlreadyExists => {
			return verify_existing_candidate_bytes(path, bytes, label);
		},
		Err(_) => {
			return Err(CandidateGateError::new(format!("{label} output is unavailable")));
		},
	};
	let metadata = file
		.metadata()
		.map_err(|_| CandidateGateError::new(format!("{label} metadata is unavailable")))?;

	validate_reserved_metadata(&metadata, true)?;

	let identity = file_identity(&metadata)?;

	if let Err(error) = (|| -> io::Result<()> {
		file.write_all(bytes)?;
		file.sync_all()?;

		let metadata = file.metadata()?;

		if metadata.len() != bytes.len() as u64
			|| file_identity(&metadata).ok() != Some(identity)
			|| path_identity(path).ok() != Some(identity)
		{
			return Err(io::Error::other("candidate output identity changed during persistence"));
		}

		sync_parent_directory(path)
	})() {
		drop(file);
		remove_file_if_identity(path, identity);

		return Err(CandidateGateError::new(format!("{label} cannot be persisted: {error}")));
	}

	Ok(())
}

fn verify_existing_candidate_bytes(
	path: &Path,
	expected: &[u8],
	label: &str,
) -> Result<(), CandidateGateError> {
	let mut options = OpenOptions::new();

	options.read(true);
	#[cfg(unix)]
	options.custom_flags(O_NOFOLLOW | O_CLOEXEC);

	let mut file = options.open(path).map_err(|_| {
		CandidateGateError::new(format!("existing {label} cannot be opened safely"))
	})?;
	let before = file.metadata().map_err(|_| {
		CandidateGateError::new(format!("existing {label} metadata is unavailable"))
	})?;

	validate_filled_metadata(&before, expected.len() as u64)?;

	let identity = file_identity(&before)?;

	if path_identity(path)? != identity {
		return Err(CandidateGateError::new(format!("existing {label} path identity is unstable")));
	}

	let mut observed = Vec::with_capacity(expected.len());

	(&mut file)
		.take(expected.len() as u64 + 1)
		.read_to_end(&mut observed)
		.map_err(|_| CandidateGateError::new(format!("existing {label} cannot be read")))?;

	let after = file.metadata().map_err(|_| {
		CandidateGateError::new(format!("existing {label} metadata is unavailable"))
	})?;

	if observed != expected
		|| after.len() != before.len()
		|| file_identity(&after)? != identity
		|| path_identity(path)? != identity
	{
		return Err(CandidateGateError::new(format!(
			"existing {label} does not match the canonical document"
		)));
	}

	file.sync_all().and_then(|()| sync_parent_directory(path)).map_err(|error| {
		CandidateGateError::new(format!("existing {label} is not durable: {error}"))
	})
}

fn candidate_authorization_node_id(public_key: &[u8; 32]) -> String {
	format!("candidate_node_{}", hex::encode(Sha256::digest(public_key)))
}

fn candidate_authorization_node_id_from_hex(
	public_key: &str,
) -> Result<String, CandidateGateError> {
	let bytes = hex::decode(public_key)
		.map_err(|_| CandidateGateError::new("candidate authorization public key is invalid"))?;
	let array: [u8; 32] = bytes
		.try_into()
		.map_err(|_| CandidateGateError::new("candidate authorization public key is invalid"))?;

	Ok(candidate_authorization_node_id(&array))
}

fn valid_lower_hex(value: &str, length: usize) -> bool {
	value.len() == length
		&& value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn sync_parent_directory(path: &Path) -> io::Result<()> {
	let parent = path
		.parent()
		.ok_or_else(|| io::Error::new(ErrorKind::InvalidInput, "path has no parent"))?;

	File::open(parent)?.sync_all()
}

fn remove_file_if_identity(path: &Path, expected: FileIdentity) {
	if path_identity(path).ok() == Some(expected) {
		let _ = fs::remove_file(path);
		let _ = sync_parent_directory(path);
	}
}

fn create_or_recover_candidate_reservation(
	path: &Path,
) -> Result<(File, FileIdentity, bool), CandidateGateError> {
	let mut create = OpenOptions::new();

	create.read(true).write(true).create_new(true);
	#[cfg(unix)]
	create.mode(0o600).custom_flags(O_NOFOLLOW | O_CLOEXEC);

	let (file, created) = match create.open(path) {
		Ok(file) => (file, true),
		Err(error) if error.kind() == ErrorKind::AlreadyExists => {
			let mut reopen = OpenOptions::new();

			reopen.read(true).write(true);
			#[cfg(unix)]
			reopen.custom_flags(O_NOFOLLOW | O_CLOEXEC);

			(
				reopen.open(path).map_err(|_| {
					CandidateGateError::new(
						"candidate output reservation cannot be recovered safely",
					)
				})?,
				false,
			)
		},
		Err(_) => {
			return Err(CandidateGateError::new("candidate output reservation cannot be created"));
		},
	};
	let result = (|| {
		let metadata = file.metadata().map_err(|_| {
			CandidateGateError::new("candidate reservation metadata is unavailable")
		})?;

		validate_reserved_metadata(&metadata, true)?;

		let identity = file_identity(&metadata)?;

		lock_candidate_reservation(&file)?;

		if path_identity(path)? != identity {
			return Err(CandidateGateError::new(
				"candidate output reservation changed while it was opened",
			));
		}

		file.sync_all().map_err(|error| {
			CandidateGateError::new(format!(
				"candidate output reservation cannot be synchronized: {error}"
			))
		})?;

		sync_parent_directory(path).map_err(|error| {
			CandidateGateError::new(format!(
				"candidate output reservation directory cannot be synchronized: {error}"
			))
		})?;

		Ok(identity)
	})();

	match result {
		Ok(identity) => Ok((file, identity, created)),
		Err(error) => {
			if created
				&& let Ok(metadata) = file.metadata()
				&& let Ok(identity) = file_identity(&metadata)
			{
				drop(file);
				remove_file_if_identity(path, identity);

				return Err(error);
			}

			Err(error)
		},
	}
}

#[cfg(unix)]
fn lock_candidate_reservation(file: &File) -> Result<(), CandidateGateError> {
	// The held lock is the single-writer boundary for a complete candidate
	// output plan. It is released only when the reservation handle is dropped
	// or atomically exchanged for immutable completed bytes.
	let result = unsafe { libc::flock(file.as_raw_fd(), LOCK_EX | LOCK_NB) };

	if result == 0 {
		Ok(())
	} else {
		Err(CandidateGateError::new(
			"candidate output reservation is already held by another process",
		))
	}
}

#[cfg(not(unix))]
fn lock_candidate_reservation(_file: &File) -> Result<(), CandidateGateError> {
	Err(CandidateGateError::new(
		"candidate output reservations require a supported advisory-lock platform",
	))
}

fn execute_after_authorization_for_role<T, F>(
	expectations: &CandidateExecutionExpectations,
	reservation_mode: CandidateReservationMode,
	executable_role: CandidateExecutableRole,
	role_signer_node_id: Option<&str>,
	callback: F,
) -> Result<T, CandidateGateError>
where
	F: FnOnce(
		&CandidateExecutionAuthorization,
		&ReleaseGateAdmissionV1,
		&VerifiedReleaseGateCorpus,
		&mut CandidateOutputReservations,
	) -> Result<T, CandidateGateError>,
{
	let (authorization, admission, corpus) =
		verify_candidate_execution(expectations, executable_role, role_signer_node_id)?;
	let mut outputs =
		open_candidate_output_reservations(&authorization.plan, &admission, reservation_mode)?;

	callback(&authorization, &admission, &corpus, &mut outputs)
}

fn verify_candidate_execution(
	expectations: &CandidateExecutionExpectations,
	executable_role: CandidateExecutableRole,
	role_signer_node_id: Option<&str>,
) -> Result<
	(CandidateExecutionAuthorization, ReleaseGateAdmissionV1, VerifiedReleaseGateCorpus),
	CandidateGateError,
> {
	let (authorization, admission) =
		verify_candidate_control_plane(expectations, executable_role, role_signer_node_id, true)?;
	let corpus = verify_release_gate_corpus_references(
		&expectations.corpus_manifest_path,
		&expectations.corpus_manifest_sha256,
		&expectations.core_corpus_commitment_path,
		&expectations.core_corpus_commitment_sha256,
		&expectations.contrast_corpus_commitment_path,
		&expectations.contrast_corpus_commitment_sha256,
	)?;

	Ok((authorization, admission, corpus))
}

fn verify_candidate_control_plane(
	expectations: &CandidateExecutionExpectations,
	executable_role: CandidateExecutableRole,
	role_signer_node_id: Option<&str>,
	validate_collection_time: bool,
) -> Result<(CandidateExecutionAuthorization, ReleaseGateAdmissionV1), CandidateGateError> {
	let verified_admission = verify_trusted_candidate_admission(expectations)?;

	if validate_collection_time {
		verified_admission.admission.validate_execution_time(&expectations.observed_at)?;
	}

	let authorization = read_verified_execution_authorization(
		&expectations.authorization_path,
		&expectations.authorization_sha256,
		&verified_admission.admission,
		&expectations.authorization_signer_node_id,
		&expectations.authorization_signer_public_key,
	)?;

	expectations.validate_plan_references(&authorization.plan)?;

	if let Some(node_id) = role_signer_node_id {
		let controlled = &authorization.plan.controlled_inputs;
		let valid_role = match executable_role {
			CandidateExecutableRole::Runner => node_id == controlled.runner_signer_node_id,
			CandidateExecutableRole::Verifier => {
				node_id == controlled.verifier_signer_node_id
					&& node_id != controlled.runner_signer_node_id
			},
		};

		if !valid_role {
			return Err(CandidateGateError::new(match executable_role {
				CandidateExecutableRole::Runner => {
					"candidate runner key does not match the signed private plan"
				},
				CandidateExecutableRole::Verifier => {
					"candidate verifier identity is not the distinct authorized verifier"
				},
			}));
		}
	}

	validate_candidate_current_executable_binding(&authorization.plan, executable_role)?;
	validate_candidate_evaluator_runtime_binding(&authorization.plan)?;

	Ok((authorization, verified_admission.admission))
}

fn verify_candidate_admission_trust_reference(
	policy_path: &Path,
	policy_sha256: &str,
	admission: &ReleaseGateAdmissionV1,
) -> Result<(), CandidateGateError> {
	let protected_digest = env::var(CANDIDATE_TRUST_POLICY_DIGEST_ENV).map_err(|_| {
		CandidateGateError::new("candidate protected release trust-policy digest is unavailable")
	})?;

	if protected_digest != policy_sha256 || !valid_digest(&protected_digest) {
		return Err(CandidateGateError::new(
			"candidate protected release trust-policy digest does not match the signed plan",
		));
	}

	let (value, bytes) =
		read_canonical_json_file(policy_path, MAX_CANDIDATE_PUBLIC_AUTHORITY_BYTES)?;

	if digest_bytes(&bytes) != protected_digest {
		return Err(CandidateGateError::new(
			"candidate release trust-policy bytes do not match the protected pin",
		));
	}

	let policy: CandidateReleaseTrustPolicy = serde_json::from_value(value)
		.map_err(|_| CandidateGateError::new("candidate release trust policy is invalid"))?;

	if policy.schema_version != "aiq.release-gate-trust.v1"
		|| policy.release_identity != RELEASE_IDENTITY
		|| policy.authority_signers.is_empty()
		|| policy.promotion_signers.is_empty()
	{
		return Err(CandidateGateError::new("candidate release trust policy is invalid"));
	}

	let mut key_ids = BTreeSet::new();
	let mut fingerprints = BTreeSet::new();
	let mut authority_key = None;

	for (promotion, signer) in policy
		.authority_signers
		.iter()
		.map(|signer| (false, signer))
		.chain(policy.promotion_signers.iter().map(|signer| (true, signer)))
	{
		let der = decode_canonical_base64(&signer.public_key_spki_base64)?;
		let fingerprint = digest_bytes(&der);

		if !valid_identifier(&signer.key_id)
			|| signer.algorithm != "ed25519"
			|| der.len() != 44
			|| der[..12] != [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]
			|| fingerprint != signer.public_key_fingerprint
			|| !key_ids.insert(signer.key_id.as_str())
			|| !fingerprints.insert(signer.public_key_fingerprint.as_str())
		{
			return Err(CandidateGateError::new(
				"candidate release trust-policy signer is invalid",
			));
		}
		if !promotion && signer.key_id == admission.signer.key_id {
			authority_key = Some(der[12..].try_into().map_err(|_| {
				CandidateGateError::new("candidate admission public key is invalid")
			})?);
		}
	}

	let public_key: [u8; 32] = authority_key
		.ok_or_else(|| CandidateGateError::new("candidate admission signer is not trusted"))?;
	let signature = decode_canonical_base64(&admission.signature)?;
	let signature = Signature::from_slice(&signature)
		.map_err(|_| CandidateGateError::new("candidate admission signature is invalid"))?;
	let mut unsigned = serde_json::to_value(admission)
		.map_err(|_| CandidateGateError::new("candidate admission cannot be serialized"))?;

	unsigned
		.as_object_mut()
		.ok_or_else(|| CandidateGateError::new("candidate admission shape is invalid"))?
		.remove("signature");

	let signing_bytes = protocol::canonical_json(&unsigned)
		.map_err(|_| CandidateGateError::new("candidate admission cannot be canonicalized"))?;

	VerifyingKey::from_bytes(&public_key)
		.map_err(|_| CandidateGateError::new("candidate admission public key is invalid"))?
		.verify(&signing_bytes, &signature)
		.map_err(|_| CandidateGateError::new("candidate admission signature does not verify"))
}

fn decode_canonical_base64(value: &str) -> Result<Vec<u8>, CandidateGateError> {
	if value.is_empty() || !value.len().is_multiple_of(4) {
		return Err(CandidateGateError::new("candidate base64 value is invalid"));
	}

	let mut output = Vec::with_capacity(value.len() / 4 * 3);

	for (chunk_index, chunk) in value.as_bytes().chunks_exact(4).enumerate() {
		let last = chunk_index + 1 == value.len() / 4;
		let padding = chunk.iter().rev().take_while(|byte| **byte == b'=').count();

		if padding > 2 || (!last && padding != 0) {
			return Err(CandidateGateError::new("candidate base64 value is invalid"));
		}

		let mut word = 0_u32;
		let mut sextets = [0_u8; 4];

		for (index, byte) in chunk.iter().enumerate() {
			let sextet = match byte {
				b'A'..=b'Z' => byte - b'A',
				b'a'..=b'z' => byte - b'a' + 26,
				b'0'..=b'9' => byte - b'0' + 52,
				b'+' => 62,
				b'/' => 63,
				b'=' if last && index >= 4 - padding => 0,
				_ => return Err(CandidateGateError::new("candidate base64 value is invalid")),
			};

			sextets[index] = sextet;
			word = (word << 6) | u32::from(sextet);
		}

		if (padding == 2 && sextets[1] & 0x0f != 0) || (padding == 1 && sextets[2] & 0x03 != 0) {
			return Err(CandidateGateError::new("candidate base64 value is not canonical"));
		}

		output.push((word >> 16) as u8);

		if padding < 2 {
			output.push((word >> 8) as u8);
		}
		if padding == 0 {
			output.push(word as u8);
		}
	}

	Ok(output)
}

fn validate_candidate_evaluator_runtime_binding(
	plan: &CandidateExecutionPlan,
) -> Result<(), CandidateGateError> {
	let evaluator_runtime = EvaluatorRuntime::resolve(&plan.controlled_inputs.evaluator_runtime)
		.map_err(|_| CandidateGateError::new("candidate evaluator runtime cannot be verified"))?;

	if evaluator_runtime.executable_digest() != plan.runtime.evaluator_runtime_sha256 {
		return Err(CandidateGateError::new(
			"candidate evaluator runtime does not match the signed private plan",
		));
	}

	Ok(())
}

fn validate_candidate_current_executable_binding(
	plan: &CandidateExecutionPlan,
	role: CandidateExecutableRole,
) -> Result<(), CandidateGateError> {
	let (label, expected_digest) = match role {
		CandidateExecutableRole::Runner => {
			("candidate runner executable", &plan.runtime.runner_executable_sha256)
		},
		CandidateExecutableRole::Verifier => {
			("candidate verifier executable", &plan.runtime.verifier_executable_sha256)
		},
	};
	let observed_digest = corpus_commitment::current_executable_digest(label)
		.map_err(|_| CandidateGateError::new(format!("{label} cannot be verified")))?;

	if &observed_digest != expected_digest {
		return Err(CandidateGateError::new(format!(
			"{label} does not match the signed private plan"
		)));
	}

	Ok(())
}

fn open_candidate_output_reservations(
	plan: &CandidateExecutionPlan,
	admission: &ReleaseGateAdmissionV1,
	reservation_mode: CandidateReservationMode,
) -> Result<CandidateOutputReservations, CandidateGateError> {
	match reservation_mode {
		CandidateReservationMode::Fresh => CandidateOutputReservations::reserve(plan, admission),
		CandidateReservationMode::ResumeExactPlan => {
			CandidateOutputReservations::resume(plan, admission)
		},
	}
}

fn validate_secure_output_parent(path: &Path) -> Result<(), CandidateGateError> {
	validate_absolute_file_path(path)?;

	let parent = path
		.parent()
		.ok_or_else(|| CandidateGateError::new("candidate output has no parent directory"))?;
	let canonical_parent = fs::canonicalize(parent)
		.map_err(|_| CandidateGateError::new("candidate output parent is unavailable"))?;

	if canonical_parent != parent {
		return Err(CandidateGateError::new(
			"candidate output parent must not contain symbolic-link indirection",
		));
	}

	let metadata = fs::symlink_metadata(parent)
		.map_err(|_| CandidateGateError::new("candidate output parent metadata is unavailable"))?;

	if !metadata.is_dir() {
		return Err(CandidateGateError::new("candidate output parent must be a directory"));
	}
	#[cfg(unix)]
	if metadata.permissions().mode() & 0o022 != 0 {
		return Err(CandidateGateError::new(
			"candidate output parent must not be group- or world-writable",
		));
	}

	Ok(())
}

fn validate_reserved_metadata(
	metadata: &Metadata,
	must_be_empty: bool,
) -> Result<(), CandidateGateError> {
	if !metadata.is_file() || (must_be_empty && metadata.len() != 0) {
		return Err(CandidateGateError::new(
			"candidate output reservation must be an empty regular file",
		));
	}
	#[cfg(unix)]
	if metadata.nlink() != 1 || metadata.permissions().mode() & 0o777 != 0o600 {
		return Err(CandidateGateError::new(
			"candidate output reservation must have one link and mode 0600",
		));
	}

	Ok(())
}

fn validate_filled_metadata(
	metadata: &Metadata,
	expected_bytes: u64,
) -> Result<(), CandidateGateError> {
	validate_reserved_metadata(metadata, false)?;

	if metadata.len() != expected_bytes || expected_bytes == 0 {
		return Err(CandidateGateError::new(
			"candidate filled output has an unexpected byte length",
		));
	}

	Ok(())
}

#[cfg(unix)]
fn file_identity(metadata: &Metadata) -> Result<FileIdentity, CandidateGateError> {
	Ok(FileIdentity { device: metadata.dev(), inode: metadata.ino() })
}

#[cfg(not(unix))]
fn file_identity(_metadata: &Metadata) -> Result<FileIdentity, CandidateGateError> {
	Err(CandidateGateError::new(
		"secure candidate output identity checks are unsupported on this platform",
	))
}

fn path_identity(path: &Path) -> Result<FileIdentity, CandidateGateError> {
	let metadata = fs::symlink_metadata(path)
		.map_err(|_| CandidateGateError::new("candidate output path metadata is unavailable"))?;

	if metadata.file_type().is_symlink() || !metadata.is_file() {
		return Err(CandidateGateError::new("candidate output path is not a regular file"));
	}

	file_identity(&metadata)
}

fn create_private_output_sibling(
	path: &Path,
) -> Result<(PathBuf, File, FileIdentity), CandidateGateError> {
	let parent = path
		.parent()
		.ok_or_else(|| CandidateGateError::new("candidate output has no parent directory"))?;
	let file_name = path
		.file_name()
		.ok_or_else(|| CandidateGateError::new("candidate output has no file name"))?
		.to_string_lossy();

	for _ in 0..128 {
		let counter = TEMPORARY_OUTPUT_COUNTER.fetch_add(1, Ordering::Relaxed);
		let temporary_path =
			parent.join(format!(".{file_name}.candidate-fill-{}-{counter}", process::id()));
		let mut options = OpenOptions::new();

		options.read(true).write(true).create_new(true);
		#[cfg(unix)]
		{
			options.mode(0o600).custom_flags(O_NOFOLLOW | O_CLOEXEC);
		}

		match options.open(&temporary_path) {
			Ok(file) => {
				let metadata = file.metadata().map_err(|_| {
					CandidateGateError::new("candidate temporary output metadata is unavailable")
				})?;

				validate_reserved_metadata(&metadata, true)?;

				let identity = file_identity(&metadata)?;

				return Ok((temporary_path, file, identity));
			},
			Err(error) if error.kind() == ErrorKind::AlreadyExists => {},
			Err(_) => {
				return Err(CandidateGateError::new(
					"candidate temporary output cannot be created",
				));
			},
		}
	}

	Err(CandidateGateError::new("candidate temporary output namespace is exhausted"))
}

#[cfg(target_os = "macos")]
fn atomic_exchange(left: &Path, right: &Path) -> io::Result<()> {
	let left = CString::new(left.as_os_str().as_bytes())
		.map_err(|_| io::Error::new(ErrorKind::InvalidInput, "path contains NUL"))?;
	let right = CString::new(right.as_os_str().as_bytes())
		.map_err(|_| io::Error::new(ErrorKind::InvalidInput, "path contains NUL"))?;
	// SAFETY: both C strings are valid for the duration of the call. RENAME_SWAP
	// performs one atomic same-filesystem exchange and does not follow a leaf link.
	let result = unsafe { libc::renamex_np(left.as_ptr(), right.as_ptr(), RENAME_SWAP) };

	if result == 0 { Ok(()) } else { Err(io::Error::last_os_error()) }
}

#[cfg(target_os = "linux")]
fn atomic_exchange(left: &Path, right: &Path) -> io::Result<()> {
	let left = CString::new(left.as_os_str().as_bytes())
		.map_err(|_| io::Error::new(ErrorKind::InvalidInput, "path contains NUL"))?;
	let right = CString::new(right.as_os_str().as_bytes())
		.map_err(|_| io::Error::new(ErrorKind::InvalidInput, "path contains NUL"))?;
	// SAFETY: both C strings are valid for the syscall. RENAME_EXCHANGE is atomic
	// and both paths are required to be on the same controlled filesystem.
	let result = unsafe {
		libc::syscall(
			SYS_renameat2,
			AT_FDCWD,
			left.as_ptr(),
			AT_FDCWD,
			right.as_ptr(),
			RENAME_EXCHANGE,
		)
	};

	if result == 0 { Ok(()) } else { Err(io::Error::last_os_error()) }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn atomic_exchange(_left: &Path, _right: &Path) -> io::Result<()> {
	Err(io::Error::new(
		ErrorKind::Unsupported,
		"atomic candidate output exchange is unsupported on this platform",
	))
}

#[cfg(test)]
mod tests {
	use std::env;
	use std::fs;
	use std::io::Write as _;
	#[cfg(unix)]
	use std::os::unix::fs::OpenOptionsExt as _;
	#[cfg(unix)]
	use std::os::unix::fs::PermissionsExt as _;
	use std::process;
	use std::sync::atomic::{AtomicU64, Ordering};

	use crate::candidate_attempt_journal::{
		CandidateAttemptDecision, CandidateAttemptJournalStore, CandidateUnitAttemptState,
	};
	use crate::candidate_release_gate::CANDIDATE_CODEX_EGRESS_PROXY_ENDPOINT;
	use crate::candidate_release_gate::CANDIDATE_TOTAL_OUTPUT_COUNT;
	use crate::candidate_release_gate::CONTRAST_IDS;
	use crate::candidate_release_gate::CandidateExecutionUnitKind;
	use crate::candidate_release_gate::CandidateGateError;
	use crate::candidate_release_gate::CandidateOutputState;
	use crate::candidate_release_gate::CandidateReservationMode;
	use crate::candidate_release_gate::ReleaseGateContrastBinding;
	use crate::candidate_release_gate::{
		self, CANDIDATE_CATALOG_RELEASE_IDENTITY_SHA256, CANDIDATE_MODEL_ID_MAPPING_SHA256,
		CANDIDATE_TASK_IDENTITY_SHA256, CONTRAST_OBSERVATION_COUNT, CONTRAST_PAIR_COUNT,
		CORE_OBSERVATION_COUNT, CandidateAssertion, CandidateAttemptFailure,
		CandidateAuthorizationIdentity, CandidateControlledInputs, CandidateEvaluatorComponent,
		CandidateExecutionAuthorization, CandidateExecutionExpectations, CandidateExecutionPlan,
		CandidateOutputReservations, CandidatePlanInputs, CandidateRuntimeBindings,
		MODEL_IDENTITIES, OpenOptions, Path, PathBuf, RELEASE_GATE_ADMISSION_SCHEMA,
		RELEASE_GATE_CORPUS_MANIFEST_SCHEMA, RELEASE_IDENTITY, REPEAT_COUNT,
		ReleaseGateAdmissionSigner, ReleaseGateAdmissionV1, ReleaseGateCorpusManifestV1,
		ReleaseGateModelConfiguration, ReleaseGateModelMatrix, ReleaseGateObservationUniverse,
		ReleaseGateRepeat, ReleaseGateRetryPolicy, SORTED_KEY_JSON, Serialize, protocol,
	};

	static TEST_DIRECTORY_COUNTER: AtomicU64 = AtomicU64::new(0);

	struct TestDirectory(PathBuf);

	impl TestDirectory {
		fn new() -> Self {
			let counter = TEST_DIRECTORY_COUNTER.fetch_add(1, Ordering::Relaxed);
			let path = env::temp_dir()
				.join(format!("aiq-candidate-gate-test-{}-{counter}", process::id()));

			fs::create_dir(&path).expect("create test directory");
			#[cfg(unix)]
			fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
				.expect("protect test directory");

			Self(fs::canonicalize(path).expect("canonical test directory"))
		}

		fn path(&self) -> &Path {
			&self.0
		}
	}

	impl Drop for TestDirectory {
		fn drop(&mut self) {
			let _ = fs::remove_dir_all(&self.0);
		}
	}

	fn digest(character: char) -> String {
		format!("sha256:{}", character.to_string().repeat(64))
	}

	fn admission() -> ReleaseGateAdmissionV1 {
		let configurations = MODEL_IDENTITIES
			.iter()
			.map(|identity| ReleaseGateModelConfiguration {
				model_id: identity.canonical_model_id.to_owned(),
				family: identity.family.to_owned(),
				reasoning_effort: identity.reasoning_effort.to_owned(),
				execution_model_id: identity.execution_model_id.to_owned(),
			})
			.collect::<Vec<_>>();
		let mut digest_configurations = configurations.clone();

		digest_configurations.sort_by(|left, right| left.model_id.cmp(&right.model_id));

		let matrix_digest = candidate_release_gate::canonical_digest(&digest_configurations)
			.expect("matrix digest");

		ReleaseGateAdmissionV1 {
			schema_version: RELEASE_GATE_ADMISSION_SCHEMA.to_owned(),
			signature_domain: RELEASE_GATE_ADMISSION_SCHEMA.to_owned(),
			signature_encoding: SORTED_KEY_JSON.to_owned(),
			release_identity: RELEASE_IDENTITY.to_owned(),
			catalog_release_identity_digest: CANDIDATE_CATALOG_RELEASE_IDENTITY_SHA256.to_owned(),
			task_metadata_identity_digest: CANDIDATE_TASK_IDENTITY_SHA256.to_owned(),
			corpus_commitment_digest: digest('a'),
			plan_id: "candidate-release-plan-001".to_owned(),
			execution_plan_digest: digest('b'),
			model_id_mapping_digest: CANDIDATE_MODEL_ID_MAPPING_SHA256.to_owned(),
			issued_at: "2026-08-01T00:00:00.000Z".to_owned(),
			collection_not_before: "2026-08-02T00:00:00.000Z".to_owned(),
			collection_not_after: "2026-08-02T04:00:00.000Z".to_owned(),
			repeat_schedule: (0..REPEAT_COUNT)
				.map(|index| ReleaseGateRepeat {
					repeat_id: format!("repeat-{}", index + 1),
					scheduled_at: format!("2026-08-02T0{}:00:00.000Z", index + 1),
					contrast_arm_order: candidate_release_gate::expected_contrast_arm_order(index),
				})
				.collect(),
			observation_universe: ReleaseGateObservationUniverse {
				task_ids: candidate_release_gate::candidate_task_ids().expect("candidate tasks"),
				model_ids: candidate_release_gate::canonical_model_ids(),
				raw_cell_count: CORE_OBSERVATION_COUNT,
				contrast_pair_count: CONTRAST_PAIR_COUNT,
				contrast_observation_count: CONTRAST_OBSERVATION_COUNT,
			},
			infrastructure_retry_policy: ReleaseGateRetryPolicy {
				max_attempts: 3,
				backoff_seconds: vec![0, 30, 90],
				retryable_classifications: vec!["pre_model_admission".to_owned()],
				model_or_evaluator_failures_retryable: false,
			},
			model_matrix: ReleaseGateModelMatrix { digest: matrix_digest, configurations },
			contrast_bindings: vec![
				ReleaseGateContrastBinding {
					contrast_id: CONTRAST_IDS[0].to_owned(),
					reference_variant_digest: digest('c'),
					challenge_variant_digest: digest('d'),
				},
				ReleaseGateContrastBinding {
					contrast_id: CONTRAST_IDS[1].to_owned(),
					reference_variant_digest: digest('e'),
					challenge_variant_digest: digest('f'),
				},
				ReleaseGateContrastBinding {
					contrast_id: CONTRAST_IDS[2].to_owned(),
					reference_variant_digest: digest('1'),
					challenge_variant_digest: digest('2'),
				},
			],
			signer: ReleaseGateAdmissionSigner {
				key_id: "release-key-2026".to_owned(),
				algorithm: "ed25519".to_owned(),
			},
			signature: format!("{}==", "A".repeat(86)),
		}
	}

	fn plan(root: &Path, admission: &ReleaseGateAdmissionV1) -> CandidateExecutionPlan {
		let output_root = root.join("outputs");

		fs::create_dir_all(&output_root).expect("create candidate output root");

		candidate_release_gate::build_candidate_execution_plan(
			admission,
			CandidatePlanInputs {
				signed_admission_path: root.join("admission.json"),
				signed_admission_sha256: candidate_release_gate::canonical_digest(admission)
					.expect("admission digest"),
				signed_admission_key_id: admission.signer.key_id.clone(),
				release_trust_policy_path: root.join("release-trust-policy.json"),
				release_trust_policy_sha256: digest('a'),
				corpus_manifest_path: root.join("corpus-manifest.json"),
				corpus_manifest_sha256: admission.corpus_commitment_digest.clone(),
				core_corpus_commitment_path: root.join("core-corpus.json"),
				core_corpus_commitment_sha256: digest('8'),
				contrast_corpus_commitment_path: root.join("contrast-corpus.json"),
				contrast_corpus_commitment_sha256: digest('9'),
				authorization_path: root.join("authorization.json"),
				runtime: CandidateRuntimeBindings {
					runner_executable_sha256: digest('1'),
					verifier_executable_sha256: digest('a'),
					evaluator_runtime_sha256: digest('2'),
					core_harness_sha256: digest('3'),
					core_tool_policy_sha256: digest('4'),
					core_network_policy_sha256: digest('5'),
					contrast_harness_sha256: digest('6'),
					contrast_tool_policy_sha256: digest('7'),
					contrast_network_policy_sha256: digest('5'),
				},
				controlled_inputs: controlled_inputs(root),
				output_root,
			},
		)
		.expect("build candidate plan")
	}

	fn controlled_inputs(root: &Path) -> CandidateControlledInputs {
		CandidateControlledInputs {
			core_tasks_root: root.join("controlled-core-tasks"),
			contrast_tasks_root: root.join("controlled-contrast-tasks"),
			source_root: root.join("controlled-source"),
			core_workspace_root: root.join("core-workspaces"),
			contrast_workspace_root: root.join("contrast-workspaces"),
			execution_root: root.join("execution"),
			evaluator_root: root.join("evaluators"),
			evaluator_runtime: root.join("bin-node"),
			codex_toolchain_root: root.join("codex-toolchain"),
			capabilities: root.join("capabilities.json"),
			schedule: root.join("schedule.json"),
			codex_binary: root.join("bin-codex"),
			codex_home: root.join("codex-home"),
			codex_egress_proxy: CANDIDATE_CODEX_EGRESS_PROXY_ENDPOINT.to_owned(),
			artifact_root: root.join("artifacts"),
			work_root: root.join("candidate-work"),
			verifier_replay_root: root.join("verifier-replay"),
			jobs: 1,
			runner_signer_node_id: format!("node_{}", "a".repeat(64)),
			verifier_signer_node_id: format!("node_{}", "b".repeat(64)),
		}
	}

	fn write_canonical(path: &Path, value: &impl Serialize) -> String {
		let canonical = protocol::canonical_json(value).expect("canonical JSON");
		let digest = candidate_release_gate::digest_bytes(&canonical);
		let mut options = OpenOptions::new();

		options.write(true).create_new(true);
		#[cfg(unix)]
		options.mode(0o600);

		let mut file = options.open(path).expect("create canonical file");

		file.write_all(&canonical).expect("write canonical file");
		file.write_all(b"\n").expect("write newline");
		file.sync_all().expect("sync canonical file");

		digest
	}

	fn create_empty_private_file(path: &Path) {
		let mut options = OpenOptions::new();

		options.read(true).write(true).create_new(true);
		#[cfg(unix)]
		options.mode(0o600);

		let file = options.open(path).expect("create empty private file");

		file.sync_all().expect("sync empty private file");

		candidate_release_gate::sync_parent_directory(path).expect("sync private file parent");
	}

	#[test]
	fn validates_public_universe_model_resolution_and_retry_semantics() {
		let admission = admission();

		admission.validate("release-key-2026").expect("valid admission");

		assert_eq!(
			candidate_release_gate::resolve_candidate_execution_identity("gpt-5.6-terra-ultra")
				.expect("resolve terra ultra")
				.model_name,
			"gpt-5.6-terra"
		);
		assert!(
			candidate_release_gate::resolve_candidate_execution_identity("gpt-5.6-luna-ultra")
				.is_err()
		);
		assert_eq!(
			admission
				.retry_after_failure(1, false, CandidateAttemptFailure::PreModelAdmission)
				.expect("retry"),
			Some(30)
		);
		assert_eq!(
			admission
				.retry_after_failure(2, false, CandidateAttemptFailure::PreModelAdmission)
				.expect("retry"),
			Some(90)
		);
		assert_eq!(
			admission
				.retry_after_failure(1, true, CandidateAttemptFailure::PreModelAdmission)
				.expect("no retry"),
			None
		);
		assert_eq!(
			admission
				.retry_after_failure(1, false, CandidateAttemptFailure::EvaluatorFailure)
				.expect("no retry"),
			None
		);
	}

	#[test]
	fn verifier_replay_root_is_distinct_from_runner_controlled_trees() {
		let directory = TestDirectory::new();
		let root = directory.path();
		let inputs = controlled_inputs(root);

		inputs.validate().expect("independent verifier replay root");

		let mut equal = inputs.clone();

		equal.verifier_replay_root.clone_from(&equal.execution_root);

		assert!(equal.validate().is_err());

		let mut nested = inputs.clone();

		nested.verifier_replay_root = nested.artifact_root.join("verifier-replay");

		assert!(nested.validate().is_err());

		let mut parent = inputs;

		parent.verifier_replay_root = root.to_path_buf();

		assert!(parent.validate().is_err());
	}

	#[test]
	fn verifier_replay_root_cannot_overlap_candidate_outputs() {
		let directory = TestDirectory::new();
		let admission = admission();
		let mut candidate = plan(directory.path(), &admission);

		candidate.controlled_inputs.verifier_replay_root =
			candidate.output_root.join("verifier-replay");

		assert!(candidate.validate_against_admission(&admission).is_err());
	}

	#[test]
	fn execution_expectations_pin_the_verifier_replay_root() {
		let directory = TestDirectory::new();
		let admission = admission();
		let candidate = plan(directory.path(), &admission);
		let mut expectations = CandidateExecutionExpectations {
			authorization_path: candidate.authorization_path.clone(),
			authorization_sha256: digest('1'),
			authorization_signer_node_id: format!("node_{}", "a".repeat(64)),
			authorization_signer_public_key: "b".repeat(64),
			signed_admission_path: candidate.signed_admission_path.clone(),
			signed_admission_sha256: candidate.signed_admission_sha256.clone(),
			signed_admission_key_id: candidate.signed_admission_key_id.clone(),
			release_trust_policy_path: candidate.release_trust_policy_path.clone(),
			release_trust_policy_sha256: candidate.release_trust_policy_sha256.clone(),
			execution_plan_sha256: candidate.execution_plan_digest.clone(),
			corpus_manifest_path: candidate.corpus_manifest_path.clone(),
			corpus_manifest_sha256: candidate.corpus_manifest_sha256.clone(),
			core_corpus_commitment_path: candidate.core_corpus_commitment_path.clone(),
			core_corpus_commitment_sha256: candidate.core_corpus_commitment_sha256.clone(),
			contrast_corpus_commitment_path: candidate.contrast_corpus_commitment_path.clone(),
			contrast_corpus_commitment_sha256: candidate.contrast_corpus_commitment_sha256.clone(),
			verifier_replay_root: candidate.controlled_inputs.verifier_replay_root.clone(),
			observed_at: "2026-08-02T01:00:00.000Z".to_owned(),
		};

		expectations.validate_plan_references(&candidate).expect("verifier replay root pin");

		expectations.verifier_replay_root = candidate.controlled_inputs.execution_root.clone();

		assert!(expectations.validate_plan_references(&candidate).is_err());
	}

	fn assert_repeat_rejected_before_reservation(
		expectations: &CandidateExecutionExpectations,
		authorization: &CandidateExecutionAuthorization,
		output_paths: &[PathBuf],
	) {
		assert!(
			candidate_release_gate::execute_repeat_after_authorization(
				expectations,
				CandidateReservationMode::Fresh,
				"repeat-1",
				&authorization.plan.controlled_inputs.runner_signer_node_id,
				|_, _, _, _, _| -> Result<(), CandidateGateError> {
					panic!("rejected repeat callback must not run")
				},
			)
			.is_err()
		);
		assert!(output_paths.iter().all(|path| !path.exists()));
	}

	#[test]
	fn repeat_time_partitions_reject_early_and_next_window_execution() {
		let admission = admission();

		assert!(
			admission
				.validate_repeat_execution_time("repeat-1", "2026-08-02T00:59:59.999Z")
				.is_err()
		);

		admission
			.validate_repeat_execution_time("repeat-1", "2026-08-02T01:30:00.000Z")
			.expect("repeat one partition");

		assert!(
			admission
				.validate_repeat_execution_time("repeat-1", "2026-08-02T02:00:00.000Z")
				.is_err()
		);
		assert!(
			admission
				.validate_repeat_execution_time("repeat-2", "2026-08-02T01:59:59.999Z")
				.is_err()
		);

		admission
			.validate_repeat_execution_time("repeat-3", "2026-08-02T04:00:00.000Z")
			.expect("final repeat includes collection end");
	}

	#[test]
	fn repeat_executor_rejects_wrong_partition_before_output_reservation() {
		let directory = TestDirectory::new();
		let root = directory.path();
		let core_path = root.join("core-corpus.json");
		let contrast_path = root.join("contrast-corpus.json");
		let core_digest = write_canonical(
			&core_path,
			&serde_json::json!({"schema_version": "aiq.corpus-commitment.v2", "side": "core"}),
		);
		let contrast_digest = write_canonical(
			&contrast_path,
			&serde_json::json!({"schema_version": "aiq.corpus-commitment.v2", "side": "contrast"}),
		);
		let manifest = ReleaseGateCorpusManifestV1 {
			schema_version: RELEASE_GATE_CORPUS_MANIFEST_SCHEMA.to_owned(),
			release_identity: RELEASE_IDENTITY.to_owned(),
			catalog_release_identity_digest: CANDIDATE_CATALOG_RELEASE_IDENTITY_SHA256.to_owned(),
			task_metadata_identity_digest: CANDIDATE_TASK_IDENTITY_SHA256.to_owned(),
			canonicalization: SORTED_KEY_JSON.to_owned(),
			core_task_count: 72,
			contrast_task_count: 6,
			core_corpus_commitment_sha256: core_digest.clone(),
			contrast_corpus_commitment_sha256: contrast_digest.clone(),
		};
		let manifest_path = root.join("corpus-manifest.json");
		let manifest_digest = write_canonical(&manifest_path, &manifest);
		let mut admission = admission();

		admission.corpus_commitment_digest.clone_from(&manifest_digest);

		let admission_path = root.join("admission.json");
		let admission_digest = write_canonical(&admission_path, &admission);
		let output_root = root.join("outputs");

		fs::create_dir_all(&output_root).expect("create candidate output root");

		let plan = candidate_release_gate::build_candidate_execution_plan(
			&admission,
			CandidatePlanInputs {
				signed_admission_path: admission_path.clone(),
				signed_admission_sha256: admission_digest.clone(),
				signed_admission_key_id: admission.signer.key_id.clone(),
				release_trust_policy_path: root.join("release-trust-policy.json"),
				release_trust_policy_sha256: digest('a'),
				corpus_manifest_path: manifest_path.clone(),
				corpus_manifest_sha256: manifest_digest.clone(),
				core_corpus_commitment_path: core_path.clone(),
				core_corpus_commitment_sha256: core_digest.clone(),
				contrast_corpus_commitment_path: contrast_path.clone(),
				contrast_corpus_commitment_sha256: contrast_digest.clone(),
				authorization_path: root.join("authorization.json"),
				runtime: CandidateRuntimeBindings {
					runner_executable_sha256: digest('1'),
					verifier_executable_sha256: digest('a'),
					evaluator_runtime_sha256: digest('2'),
					core_harness_sha256: digest('3'),
					core_tool_policy_sha256: digest('4'),
					core_network_policy_sha256: digest('5'),
					contrast_harness_sha256: digest('6'),
					contrast_tool_policy_sha256: digest('7'),
					contrast_network_policy_sha256: digest('5'),
				},
				controlled_inputs: controlled_inputs(root),
				output_root,
			},
		)
		.expect("build executable plan");
		let output_paths =
			plan.output_paths().into_iter().map(|(_, path)| path.to_path_buf()).collect::<Vec<_>>();
		let identity = CandidateAuthorizationIdentity::from_secret([9_u8; 32]);
		let authorization = identity.authorize(plan, &admission).expect("authorize plan");
		let authorization_digest =
			candidate_release_gate::write_execution_authorization_create_once(
				&authorization.plan.authorization_path,
				&authorization,
				&admission,
				&identity.signer().node_id,
				&identity.signer().public_key,
			)
			.expect("write authorization");
		let expectations = CandidateExecutionExpectations {
			authorization_path: authorization.plan.authorization_path.clone(),
			authorization_sha256: authorization_digest,
			authorization_signer_node_id: identity.signer().node_id.clone(),
			authorization_signer_public_key: identity.signer().public_key.clone(),
			signed_admission_path: admission_path,
			signed_admission_sha256: admission_digest,
			signed_admission_key_id: admission.signer.key_id.clone(),
			release_trust_policy_path: authorization.plan.release_trust_policy_path.clone(),
			release_trust_policy_sha256: authorization.plan.release_trust_policy_sha256.clone(),
			execution_plan_sha256: admission.execution_plan_digest.clone(),
			corpus_manifest_path: manifest_path,
			corpus_manifest_sha256: manifest_digest,
			core_corpus_commitment_path: core_path,
			core_corpus_commitment_sha256: core_digest,
			contrast_corpus_commitment_path: contrast_path,
			contrast_corpus_commitment_sha256: contrast_digest,
			verifier_replay_root: authorization.plan.controlled_inputs.verifier_replay_root.clone(),
			observed_at: "2026-08-02T00:30:00.000Z".to_owned(),
		};

		assert_repeat_rejected_before_reservation(&expectations, &authorization, &output_paths);

		let mut next_window = expectations;

		next_window.observed_at = "2026-08-02T02:00:00.000Z".to_owned();

		assert_repeat_rejected_before_reservation(&next_window, &authorization, &output_paths);
	}

	#[test]
	fn private_plan_binds_exact_twenty_one_units_and_six_arm_tasks() {
		let directory = TestDirectory::new();
		let admission = admission();
		let plan = plan(directory.path(), &admission);

		plan.validate_against_admission(&admission).expect("valid private plan");

		assert_eq!(plan.execution_units[0].unit_id, "repeat-01-core");
		assert_eq!(plan.execution_units[1].unit_id, "repeat-01-contrast-01-reference");
		assert_eq!(
			plan.execution_units[0].checkpoint_path,
			directory.path().join("candidate-work/repeat-01-core.checkpoint.json")
		);
		assert_eq!(plan.controlled_inputs.jobs, 1);
		assert_ne!(
			plan.controlled_inputs.runner_signer_node_id,
			plan.controlled_inputs.verifier_signer_node_id
		);

		plan.runtime
			.validate_core_commitment_bindings(&digest('3'), &digest('4'), &digest('5'))
			.expect("core commitment runtime binding");
		plan.runtime
			.validate_contrast_commitment_bindings(&digest('6'), &digest('7'), &digest('5'))
			.expect("contrast commitment runtime binding");

		assert!(
			plan.runtime
				.validate_contrast_commitment_bindings(&digest('3'), &digest('4'), &digest('5'))
				.is_err()
		);

		let second_repeat = plan.units_for_repeat(&admission, "repeat-2").expect("second repeat");

		assert_eq!(second_repeat.len(), 7);
		assert_eq!(second_repeat[0].kind, CandidateExecutionUnitKind::Core);
		assert_eq!(second_repeat[1].ordered_task_ids, ["contrast-coupled-challenge-01"]);
		assert_eq!(second_repeat[2].ordered_task_ids, ["contrast-coupled-reference-01"]);
		assert_eq!(plan.output_paths().len(), 86);

		let mut crossed = plan.clone();

		crossed.execution_units[2].ordered_task_ids =
			vec!["contrast-coupled-reference-01".to_owned()];

		assert!(crossed.validate_against_admission(&admission).is_err());

		let mut crossed_commitment = plan.clone();

		crossed_commitment.execution_units[1].corpus_commitment_path =
			crossed_commitment.core_corpus_commitment_path.clone();
		crossed_commitment.execution_units[1].corpus_commitment_sha256 =
			crossed_commitment.core_corpus_commitment_sha256.clone();

		assert!(crossed_commitment.validate_against_admission(&admission).is_err());

		let mut arbitrary_checkpoint = plan.clone();

		arbitrary_checkpoint.execution_units[0].checkpoint_path =
			directory.path().join("arbitrary-checkpoint.json");

		assert!(arbitrary_checkpoint.validate_against_admission(&admission).is_err());

		let mut invalid_jobs = plan.clone();

		invalid_jobs.controlled_inputs.jobs = crate::runner::MAX_RUN_JOBS + 1;

		assert!(invalid_jobs.validate_against_admission(&admission).is_err());
	}

	#[test]
	fn candidate_proxy_is_exact_before_authorization_reservation_or_model_work() {
		let directory = TestDirectory::new();
		let admission = admission();
		let controlled = controlled_inputs(directory.path());

		controlled.validate().expect("fixed candidate proxy");

		assert_eq!(
			crate::adapter::CodexEgressProxyEndpoint::parse(CANDIDATE_CODEX_EGRESS_PROXY_ENDPOINT)
				.expect("shared RFC1918 proxy parser")
				.to_string(),
			CANDIDATE_CODEX_EGRESS_PROXY_ENDPOINT,
		);
		assert_eq!(
			crate::adapter::CodexEgressProxyEndpoint::parse_candidate_runner(
				CANDIDATE_CODEX_EGRESS_PROXY_ENDPOINT,
			)
			.expect("live candidate proxy parser")
			.to_string(),
			CANDIDATE_CODEX_EGRESS_PROXY_ENDPOINT,
		);

		for invalid in [
			"http://127.0.0.1:3128",
			"http://10.248.34.3:3128",
			"http://10.248.34.2:8080",
			"https://10.248.34.2:3128",
			"http://10.248.34.2:3128/",
			"http://10.248.34.2:3128?mode=test",
			"http://runner@10.248.34.2:3128",
			"http://10.248.34.2:3128#proxy",
		] {
			let mut changed = controlled.clone();

			changed.codex_egress_proxy = invalid.to_owned();

			assert!(changed.validate().is_err(), "accepted candidate proxy {invalid}");
		}

		let mut invalid_plan = plan(directory.path(), &admission);
		let output_paths = invalid_plan
			.output_paths()
			.into_iter()
			.map(|(_, path)| path.to_path_buf())
			.collect::<Vec<_>>();

		invalid_plan.controlled_inputs.codex_egress_proxy = "http://127.0.0.1:3128".to_owned();

		assert!(invalid_plan.validate_against_admission(&admission).is_err());
		assert!(
			CandidateAuthorizationIdentity::from_secret([53_u8; 32])
				.authorize(invalid_plan.clone(), &admission)
				.is_err()
		);
		assert!(CandidateOutputReservations::reserve(&invalid_plan, &admission).is_err());
		assert!(output_paths.iter().all(|path| !path.exists()));
	}

	#[test]
	fn authorization_is_private_signed_and_not_a_public_admission() {
		let directory = TestDirectory::new();
		let admission = admission();
		let identity = CandidateAuthorizationIdentity::from_secret([7_u8; 32]);
		let authorization = identity
			.authorize(plan(directory.path(), &admission), &admission)
			.expect("authorize plan");

		authorization
			.verify(&admission, &identity.signer().node_id, &identity.signer().public_key)
			.expect("verify authorization");

		let value = serde_json::to_value(&authorization).expect("authorization value");

		assert!(serde_json::from_value::<ReleaseGateAdmissionV1>(value).is_err());

		let digest = candidate_release_gate::write_execution_authorization_create_once(
			&authorization.plan.authorization_path,
			&authorization,
			&admission,
			&identity.signer().node_id,
			&identity.signer().public_key,
		)
		.expect("persist authorization");
		let read = candidate_release_gate::read_verified_execution_authorization(
			&authorization.plan.authorization_path,
			&digest,
			&admission,
			&identity.signer().node_id,
			&identity.signer().public_key,
		)
		.expect("read authorization");

		assert_eq!(read, authorization);
	}

	#[test]
	fn canonical_create_once_recovers_exact_bytes_and_rejects_conflicts() {
		let directory = TestDirectory::new();
		let path = directory.path().join("lifecycle.json");
		let value = serde_json::json!({"schema_version": "candidate.test.v1", "value": 1});
		let digest = candidate_release_gate::write_candidate_canonical_create_once(&path, &value)
			.expect("create canonical lifecycle document");

		assert_eq!(
			candidate_release_gate::write_candidate_canonical_create_once(&path, &value)
				.expect("verify crash-recovered lifecycle document"),
			digest
		);

		let original = fs::read(&path).expect("read canonical lifecycle document");

		assert!(
			candidate_release_gate::write_candidate_canonical_create_once(
				&path,
				&serde_json::json!({"schema_version": "candidate.test.v1", "value": 2}),
			)
			.is_err()
		);
		assert_eq!(fs::read(&path).expect("read unchanged lifecycle document"), original);
	}

	#[cfg(unix)]
	#[test]
	fn canonical_create_once_rejects_symbolic_and_hard_links() {
		let directory = TestDirectory::new();
		let value = serde_json::json!({"schema_version": "candidate.test.v1"});
		let target = directory.path().join("target.json");

		candidate_release_gate::write_candidate_canonical_create_once(&target, &value)
			.expect("create target document");

		let symbolic = directory.path().join("symbolic.json");

		std::os::unix::fs::symlink(&target, &symbolic).expect("create symbolic link");

		assert!(
			candidate_release_gate::write_candidate_canonical_create_once(&symbolic, &value)
				.is_err()
		);

		let linked = directory.path().join("linked.json");

		fs::hard_link(&target, &linked).expect("create hard link");

		assert!(
			candidate_release_gate::write_candidate_canonical_create_once(&target, &value).is_err()
		);
	}

	#[test]
	fn authorization_create_once_reverifies_before_recovery() {
		let directory = TestDirectory::new();
		let admission = admission();
		let identity = CandidateAuthorizationIdentity::from_secret([19_u8; 32]);
		let authorization = identity
			.authorize(plan(directory.path(), &admission), &admission)
			.expect("authorize plan");
		let path = authorization.plan.authorization_path.clone();
		let digest = candidate_release_gate::write_execution_authorization_create_once(
			&path,
			&authorization,
			&admission,
			&identity.signer().node_id,
			&identity.signer().public_key,
		)
		.expect("create authorization");

		assert_eq!(
			candidate_release_gate::write_execution_authorization_create_once(
				&path,
				&authorization,
				&admission,
				&identity.signer().node_id,
				&identity.signer().public_key,
			)
			.expect("recover exact authorization"),
			digest
		);

		let mut invalid = authorization;

		invalid.signature.replace_range(..2, "ff");

		assert!(
			candidate_release_gate::write_execution_authorization_create_once(
				&path,
				&invalid,
				&admission,
				&identity.signer().node_id,
				&identity.signer().public_key,
			)
			.is_err()
		);
	}

	#[test]
	fn canonical_admission_and_split_corpus_references_are_exact() {
		let directory = TestDirectory::new();
		let admission = admission();
		let admission_path = directory.path().join("admission.json");
		let admission_digest = write_canonical(&admission_path, &admission);

		candidate_release_gate::verify_canonical_admission_reference(
			&admission_path,
			&admission_digest,
			&admission.execution_plan_digest,
			&admission.corpus_commitment_digest,
			&admission.signer.key_id,
		)
		.expect("canonical admission");

		let core_path = directory.path().join("core.json");
		let contrast_path = directory.path().join("contrast.json");
		let core_digest = write_canonical(
			&core_path,
			&serde_json::json!({"schema_version": "aiq.corpus-commitment.v2", "side": "core"}),
		);
		let contrast_digest = write_canonical(
			&contrast_path,
			&serde_json::json!({"schema_version": "aiq.corpus-commitment.v2", "side": "contrast"}),
		);
		let manifest = ReleaseGateCorpusManifestV1 {
			schema_version: RELEASE_GATE_CORPUS_MANIFEST_SCHEMA.to_owned(),
			release_identity: RELEASE_IDENTITY.to_owned(),
			catalog_release_identity_digest: CANDIDATE_CATALOG_RELEASE_IDENTITY_SHA256.to_owned(),
			task_metadata_identity_digest: CANDIDATE_TASK_IDENTITY_SHA256.to_owned(),
			canonicalization: SORTED_KEY_JSON.to_owned(),
			core_task_count: 72,
			contrast_task_count: 6,
			core_corpus_commitment_sha256: core_digest.clone(),
			contrast_corpus_commitment_sha256: contrast_digest.clone(),
		};
		let manifest_path = directory.path().join("manifest.json");
		let manifest_digest = write_canonical(&manifest_path, &manifest);
		let verified = candidate_release_gate::verify_release_gate_corpus_references(
			&manifest_path,
			&manifest_digest,
			&core_path,
			&core_digest,
			&contrast_path,
			&contrast_digest,
		)
		.expect("split corpus references");

		assert_eq!(verified.manifest.core_task_count, 72);
		assert_eq!(verified.manifest.contrast_task_count, 6);
	}

	#[test]
	fn fresh_reservations_survive_repeat_boundary_and_resume_exact_plan() {
		let directory = TestDirectory::new();
		let admission = admission();
		let plan = plan(directory.path(), &admission);
		let first_repeat =
			plan.units_for_repeat(&admission, "repeat-1").expect("first repeat").to_vec();
		let mut fresh = CandidateOutputReservations::reserve(&plan, &admission)
			.expect("reserve complete output set");

		assert_eq!(fresh.states().len(), 86);

		for unit in &first_repeat {
			for (key, _) in unit.outputs.keyed_paths(&unit.unit_id) {
				fresh.fill(&key, key.as_bytes()).expect("fill repeat-one output");
			}
		}

		drop(fresh);

		let mut resumed = CandidateOutputReservations::resume(&plan, &admission)
			.expect("resume complete output set");
		let states = resumed.states();

		assert_eq!(
			states
				.values()
				.filter(|state| matches!(state, CandidateOutputState::Filled { .. }))
				.count(),
			28
		);
		assert_eq!(
			states.values().filter(|state| matches!(state, CandidateOutputState::Reserved)).count(),
			58
		);
		assert!(resumed.fill("repeat-01-core/result_package_bundle", b"overwrite").is_err());
	}

	#[test]
	fn fresh_reservations_recover_a_crash_created_partial_set() {
		let directory = TestDirectory::new();
		let admission = admission();
		let plan = plan(directory.path(), &admission);
		let paths = plan.output_paths();

		for (_, path) in paths.iter().take(3) {
			create_empty_private_file(path);
		}

		let reservations = CandidateOutputReservations::reserve(&plan, &admission)
			.expect("recover partial reservation set");

		assert_eq!(reservations.states().len(), CANDIDATE_TOTAL_OUTPUT_COUNT);
		assert!(
			reservations
				.states()
				.values()
				.all(|state| matches!(state, CandidateOutputState::Reserved))
		);
	}

	#[test]
	fn failed_partial_recovery_preserves_old_files_and_cleans_new_files() {
		let directory = TestDirectory::new();
		let admission = admission();
		let plan = plan(directory.path(), &admission);
		let paths = plan.output_paths();
		let recovered = paths[0].1;
		let newly_created = paths[1].1;
		let conflict = paths[2].1;

		create_empty_private_file(recovered);

		fs::write(conflict, b"conflict").expect("inject conflicting output");
		#[cfg(unix)]
		fs::set_permissions(conflict, fs::Permissions::from_mode(0o600))
			.expect("protect conflicting output");

		assert!(CandidateOutputReservations::reserve(&plan, &admission).is_err());
		assert!(recovered.exists());
		assert_eq!(fs::metadata(recovered).expect("recovered metadata").len(), 0);
		assert!(!newly_created.exists());
		assert_eq!(fs::read(conflict).expect("read conflict"), b"conflict");
	}

	#[cfg(unix)]
	#[test]
	fn fresh_reservations_reject_symlinked_partial_set() {
		let directory = TestDirectory::new();
		let admission = admission();
		let plan = plan(directory.path(), &admission);
		let path = plan.output_paths()[0].1;
		let target = directory.path().join("reservation-target");

		create_empty_private_file(&target);

		std::os::unix::fs::symlink(&target, path).expect("inject symbolic reservation");

		assert!(CandidateOutputReservations::reserve(&plan, &admission).is_err());
		assert!(target.exists());
	}

	#[cfg(unix)]
	#[test]
	fn live_reservation_set_rejects_a_second_writer() {
		let directory = TestDirectory::new();
		let admission = admission();
		let plan = plan(directory.path(), &admission);
		let first = CandidateOutputReservations::reserve(&plan, &admission)
			.expect("reserve complete output set");

		assert!(CandidateOutputReservations::resume(&plan, &admission).is_err());

		drop(first);

		CandidateOutputReservations::resume(&plan, &admission)
			.expect("released reservation set can be resumed");
	}

	#[test]
	fn cached_preparation_failure_can_retry_before_the_model_boundary() {
		let directory = TestDirectory::new();
		let admission = admission();
		let plan = plan(directory.path(), &admission);
		let authorization = CandidateAuthorizationIdentity::from_secret([31_u8; 32])
			.authorize(plan.clone(), &admission)
			.expect("authorize plan");
		let unit = &plan.execution_units[0];

		fs::create_dir_all(unit.attempt_journal_path.parent().expect("journal parent"))
			.expect("create journal parent");
		#[cfg(unix)]
		fs::set_permissions(
			unit.attempt_journal_path.parent().expect("journal parent"),
			fs::Permissions::from_mode(0o700),
		)
		.expect("protect journal parent");

		let mut journal =
			CandidateAttemptJournalStore::open(&unit.attempt_journal_path, &authorization, unit)
				.expect("open journal");
		let first = journal
			.begin_or_resume(&authorization, unit, &admission, "2026-08-02T01:00:05.000Z")
			.expect("start first attempt");

		assert!(matches!(first, CandidateAttemptDecision::Start(_)));

		journal
			.mark_infrastructure_failure(
				&authorization,
				unit,
				&admission,
				1,
				CandidateAttemptFailure::PreModelAdmission,
			)
			.expect("record retryable failure");

		assert!(
			journal
				.begin_or_resume(&authorization, unit, &admission, "2026-08-02T01:00:29.999Z",)
				.is_err()
		);

		drop(journal);

		let mut journal =
			CandidateAttemptJournalStore::open(&unit.attempt_journal_path, &authorization, unit)
				.expect("resume journal");
		let second = journal
			.begin_or_resume(&authorization, unit, &admission, "2026-08-02T01:00:45.000Z")
			.expect("start second attempt");

		assert!(
			matches!(second, CandidateAttemptDecision::Start(ref attempt) if attempt.attempt_number == 2 && attempt.state == CandidateUnitAttemptState::Prepared)
		);
		assert_eq!(journal.journal().attempts.len(), 2);
	}

	#[test]
	fn active_capability_probe_failure_is_terminal_and_cannot_retry() {
		let directory = TestDirectory::new();
		let admission = admission();
		let plan = plan(directory.path(), &admission);
		let authorization = CandidateAuthorizationIdentity::from_secret([33_u8; 32])
			.authorize(plan.clone(), &admission)
			.expect("authorize plan");
		let unit = &plan.execution_units[0];

		fs::create_dir_all(unit.attempt_journal_path.parent().expect("journal parent"))
			.expect("create journal parent");
		#[cfg(unix)]
		fs::set_permissions(
			unit.attempt_journal_path.parent().expect("journal parent"),
			fs::Permissions::from_mode(0o700),
		)
		.expect("protect journal parent");

		let mut journal =
			CandidateAttemptJournalStore::open(&unit.attempt_journal_path, &authorization, unit)
				.expect("open journal");
		let first = journal
			.begin_or_resume(&authorization, unit, &admission, "2026-08-02T01:00:05.000Z")
			.expect("start first attempt");

		assert!(matches!(first, CandidateAttemptDecision::Start(_)));

		// The candidate runner records this boundary before it starts any active
		// Codex/model capability probe. A later preparation error must not be
		// reclassified as pre-model infrastructure.
		journal.mark_model_started(&authorization, unit, 1).expect("record probe boundary");

		assert!(
			journal
				.mark_infrastructure_failure(
					&authorization,
					unit,
					&admission,
					1,
					CandidateAttemptFailure::PreModelAdmission,
				)
				.is_err()
		);
		assert_eq!(journal.journal().attempts.len(), 1);
		assert_eq!(journal.journal().attempts[0].state, CandidateUnitAttemptState::ModelStarted);
		assert!(journal.journal().attempts[0].infrastructure_classification.is_none());

		drop(journal);

		let mut resumed =
			CandidateAttemptJournalStore::open(&unit.attempt_journal_path, &authorization, unit)
				.expect("reopen terminal probe attempt");
		let error = resumed
			.begin_or_resume(&authorization, unit, &admission, "2026-08-02T01:00:35.000Z")
			.expect_err("active probe attempt must not execute again");

		assert_eq!(
			error.to_string(),
			"candidate model-started attempt cannot be resumed automatically"
		);
		assert_eq!(resumed.journal().attempts.len(), 1);
	}

	#[test]
	fn candidate_attempt_journal_exhausts_exactly_three_infrastructure_attempts() {
		let directory = TestDirectory::new();
		let admission = admission();
		let plan = plan(directory.path(), &admission);
		let authorization = CandidateAuthorizationIdentity::from_secret([32_u8; 32])
			.authorize(plan.clone(), &admission)
			.expect("authorize plan");
		let unit = &plan.execution_units[0];

		fs::create_dir_all(unit.attempt_journal_path.parent().expect("journal parent"))
			.expect("create journal parent");
		#[cfg(unix)]
		fs::set_permissions(
			unit.attempt_journal_path.parent().expect("journal parent"),
			fs::Permissions::from_mode(0o700),
		)
		.expect("protect journal parent");

		let mut journal =
			CandidateAttemptJournalStore::open(&unit.attempt_journal_path, &authorization, unit)
				.expect("open journal");

		for (attempt_number, started_at) in [
			(1, "2026-08-02T01:00:05.000Z"),
			(2, "2026-08-02T01:00:35.000Z"),
			(3, "2026-08-02T01:01:35.000Z"),
		] {
			assert!(matches!(
				journal
					.begin_or_resume(&authorization, unit, &admission, started_at)
					.expect("start planned attempt"),
				CandidateAttemptDecision::Start(_)
			));

			journal
				.mark_infrastructure_failure(
					&authorization,
					unit,
					&admission,
					attempt_number,
					CandidateAttemptFailure::PreModelAdmission,
				)
				.expect("record infrastructure failure");
		}

		assert!(matches!(
			journal
				.begin_or_resume(&authorization, unit, &admission, "2026-08-02T01:02:00.000Z",)
				.expect("observe terminal attempt"),
			CandidateAttemptDecision::TerminalInfrastructure(_)
		));
	}

	#[cfg(unix)]
	#[test]
	fn resume_rejects_hardlinked_reservation() {
		let directory = TestDirectory::new();
		let admission = admission();
		let plan = plan(directory.path(), &admission);
		let reservations =
			CandidateOutputReservations::reserve(&plan, &admission).expect("reserve outputs");

		drop(reservations);

		let path = &plan.execution_units[7].outputs.attempt_log_bundle;

		fs::hard_link(path, directory.path().join("unexpected-hardlink"))
			.expect("create hardlink fixture");

		assert!(CandidateOutputReservations::resume(&plan, &admission).is_err());
	}

	#[test]
	fn evaluator_fraction_is_exact_and_rejects_cross_component_drift() {
		let weights = [3_000, 2_500, 2_500, 2_000];
		let components = weights
			.into_iter()
			.enumerate()
			.map(|(component, weight_basis_points)| CandidateEvaluatorComponent {
				component_id: format!("component_{:02}", component + 1),
				weight_basis_points,
				assertions: (0..4)
					.map(|assertion| CandidateAssertion {
						assertion_id: format!(
							"component_{:02}_assertion_{:02}",
							component + 1,
							assertion + 1
						),
						passed: !(component == 0 && assertion == 0),
						evidence_sha256: digest(char::from(b'a' + assertion as u8)),
					})
					.collect(),
			})
			.collect::<Vec<_>>();

		assert_eq!(
			candidate_release_gate::candidate_score_fraction(&components).expect("score"),
			(37, 40)
		);

		let mut drifted = components;

		drifted.swap(0, 1);

		assert!(candidate_release_gate::candidate_score_fraction(&drifted).is_err());
	}

	#[test]
	fn canonical_base64_rejects_nonzero_unused_bits() {
		assert_eq!(
			candidate_release_gate::decode_canonical_base64("Zg==").expect("canonical one byte"),
			b"f"
		);
		assert_eq!(
			candidate_release_gate::decode_canonical_base64("Zm8=").expect("canonical two bytes"),
			b"fo"
		);
		assert_eq!(
			candidate_release_gate::decode_canonical_base64("Zm9v").expect("canonical three bytes"),
			b"foo"
		);
		assert!(candidate_release_gate::decode_canonical_base64("Zh==").is_err());
		assert!(candidate_release_gate::decode_canonical_base64("Zm9=").is_err());
	}
}
