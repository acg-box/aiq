//! Durable unit-attempt state for the private candidate release gate.
//!
//! The journal is not public evidence. It is a crash-recovery boundary that
//! prevents an infrastructure retry after a task-model boundary was crossed.
//! The runner later converts its validated history into signed per-cell attempt
//! evidence after independent verifier artifacts exist.

use std::io::ErrorKind;
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt as _, OpenOptionsExt as _, PermissionsExt as _};
use std::{
	fs::{self, OpenOptions},
	io::Read as _,
	path::{Component, Path, PathBuf},
};

use jiff::Timestamp;
use libc::O_CLOEXEC;
use libc::O_NOFOLLOW;
use serde::{Deserialize, Serialize};

use crate::{
	candidate_release_gate::{
		CandidateAttemptFailure, CandidateExecutionAuthorization, CandidateExecutionUnit,
		CandidateGateError, ReleaseGateAdmissionV1,
	},
	resume,
};

/// Private durable journal schema.
pub const CANDIDATE_ATTEMPT_JOURNAL_SCHEMA: &str = "aiq.candidate-attempt-journal.v1";

const MAX_JOURNAL_BYTES: u64 = 64 * 1_024;

/// Durable state of one unit-level execution attempt.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CandidateUnitAttemptState {
	/// Model-free preparation can safely be resumed as the same attempt.
	Prepared,
	/// The task-model boundary was durably recorded before dispatch.
	ModelStarted,
	/// A signed-policy infrastructure retry can start at its next logical time.
	RetryableInfrastructure,
	/// The third infrastructure failure exhausted the immutable retry policy.
	TerminalInfrastructure,
	/// The unit produced its immutable runner and evaluator bundles.
	Completed,
}

/// One unit-level attempt retained before signed per-cell evidence is built.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CandidateUnitAttempt {
	/// One-based number of this unit attempt.
	pub attempt_number: u8,
	/// Policy delay from the initial scheduled time.
	pub scheduled_delay_seconds: u64,
	/// Canonical timestamp at which the attempt became eligible.
	pub scheduled_for: String,
	/// Canonical timestamp at which the attempt started.
	pub started_at: String,
	/// Whether the attempt crossed the task-model boundary.
	pub model_started: bool,
	/// Durable state of the attempt.
	pub state: CandidateUnitAttemptState,
	/// Optional pre-model infrastructure failure class.
	pub infrastructure_classification: Option<CandidateAttemptFailure>,
}

/// Exact private journal bound to one authorized execution unit.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CandidateAttemptJournal {
	/// Journal schema identifier.
	pub schema_version: String,
	/// SHA-256 digest of the execution authorization.
	pub authorization_sha256: String,
	/// Digest of the authorized execution plan.
	pub execution_plan_digest: String,
	/// SHA-256 digest of the signed admission.
	pub signed_admission_sha256: String,
	/// Identifier of the planned repeat.
	pub repeat_id: String,
	/// Identifier of the execution unit.
	pub unit_id: String,
	/// Canonical scheduled timestamp of the unit.
	pub scheduled_at: String,
	/// Ordered durable attempt history for the unit.
	pub attempts: Vec<CandidateUnitAttempt>,
}

/// Whether one invocation starts, resumes, or observes a terminal unit attempt.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CandidateAttemptDecision {
	/// Start the returned new attempt.
	Start(CandidateUnitAttempt),
	/// Resume the returned interrupted attempt.
	Resume(CandidateUnitAttempt),
	/// Observe the returned completed attempt.
	Completed(CandidateUnitAttempt),
	/// Observe the returned terminal infrastructure attempt.
	TerminalInfrastructure(CandidateUnitAttempt),
}

/// Held durable journal for one exact plan-bound unit.
pub struct CandidateAttemptJournalStore {
	path: PathBuf,
	journal: CandidateAttemptJournal,
}
impl CandidateAttemptJournalStore {
	/// Opens an existing journal or prepares a new empty journal in memory.
	pub fn open(
		path: &Path,
		authorization: &CandidateExecutionAuthorization,
		unit: &CandidateExecutionUnit,
	) -> Result<Self, CandidateGateError> {
		validate_private_journal_path(path)?;

		let authorization_sha256 = authorization.digest()?;
		let journal = match fs::symlink_metadata(path) {
			Ok(_) => read_journal(path)?,
			Err(error) if error.kind() == ErrorKind::NotFound => CandidateAttemptJournal {
				schema_version: CANDIDATE_ATTEMPT_JOURNAL_SCHEMA.to_owned(),
				authorization_sha256,
				execution_plan_digest: authorization.execution_plan_digest.clone(),
				signed_admission_sha256: authorization.signed_admission_sha256.clone(),
				repeat_id: unit.repeat_id.clone(),
				unit_id: unit.unit_id.clone(),
				scheduled_at: unit.slot_id.clone(),
				attempts: Vec::new(),
			},
			Err(_) => {
				return Err(CandidateGateError::new(
					"candidate attempt journal metadata is unavailable",
				));
			},
		};
		let store = Self { path: path.to_path_buf(), journal };

		store.validate(authorization, unit)?;

		Ok(store)
	}

	/// Returns the validated durable history.
	#[must_use]
	pub fn journal(&self) -> &CandidateAttemptJournal {
		&self.journal
	}

	/// Revalidates every retained actual start against the signed repeat window.
	pub fn validate_against_admission(
		&self,
		authorization: &CandidateExecutionAuthorization,
		unit: &CandidateExecutionUnit,
		admission: &ReleaseGateAdmissionV1,
	) -> Result<(), CandidateGateError> {
		self.validate(authorization, unit)?;

		for attempt in &self.journal.attempts {
			admission.validate_repeat_execution_time(&unit.repeat_id, &attempt.started_at)?;

			if admission.scheduled_attempt_delay(attempt.attempt_number)?
				!= attempt.scheduled_delay_seconds
			{
				return Err(CandidateGateError::new(
					"candidate attempt journal does not match the signed retry schedule",
				));
			}
		}

		Ok(())
	}

	/// Starts the next policy-bound attempt or resumes an interrupted one.
	pub fn begin_or_resume(
		&mut self,
		authorization: &CandidateExecutionAuthorization,
		unit: &CandidateExecutionUnit,
		admission: &ReleaseGateAdmissionV1,
		started_at: &str,
	) -> Result<CandidateAttemptDecision, CandidateGateError> {
		self.validate(authorization, unit)?;
		admission.validate_repeat_execution_time(&unit.repeat_id, started_at)?;

		parse_canonical_timestamp(started_at)?;

		if let Some(last) = self.journal.attempts.last() {
			return match last.state {
				CandidateUnitAttemptState::Prepared => {
					Ok(CandidateAttemptDecision::Resume(last.clone()))
				},
				CandidateUnitAttemptState::ModelStarted => Err(CandidateGateError::new(
					"candidate model-started attempt cannot be resumed automatically",
				)),
				CandidateUnitAttemptState::Completed => {
					Ok(CandidateAttemptDecision::Completed(last.clone()))
				},
				CandidateUnitAttemptState::TerminalInfrastructure => {
					Ok(CandidateAttemptDecision::TerminalInfrastructure(last.clone()))
				},
				CandidateUnitAttemptState::RetryableInfrastructure => {
					let next_number = last.attempt_number.checked_add(1).ok_or_else(|| {
						CandidateGateError::new("candidate attempt number overflows")
					})?;

					self.start_attempt(authorization, unit, admission, next_number, started_at)
				},
			};
		}

		self.start_attempt(authorization, unit, admission, 1, started_at)
	}

	/// Durably records the task-model boundary before dispatch.
	pub fn mark_model_started(
		&mut self,
		authorization: &CandidateExecutionAuthorization,
		unit: &CandidateExecutionUnit,
		attempt_number: u8,
	) -> Result<(), CandidateGateError> {
		self.validate(authorization, unit)?;

		let attempt = self.current_attempt_mut(attempt_number)?;

		if attempt.state == CandidateUnitAttemptState::ModelStarted {
			return Ok(());
		}
		if attempt.state != CandidateUnitAttemptState::Prepared
			|| attempt.model_started
			|| attempt.infrastructure_classification.is_some()
		{
			return Err(CandidateGateError::new(
				"candidate model boundary cannot change this attempt state",
			));
		}

		attempt.model_started = true;
		attempt.state = CandidateUnitAttemptState::ModelStarted;

		self.persist(authorization, unit)
	}

	/// Records one retryable or terminal pre-model infrastructure failure.
	pub fn mark_infrastructure_failure(
		&mut self,
		authorization: &CandidateExecutionAuthorization,
		unit: &CandidateExecutionUnit,
		admission: &ReleaseGateAdmissionV1,
		attempt_number: u8,
		classification: CandidateAttemptFailure,
	) -> Result<(), CandidateGateError> {
		self.validate(authorization, unit)?;

		if !matches!(classification, CandidateAttemptFailure::PreModelAdmission) {
			return Err(CandidateGateError::new(
				"candidate retry journal accepts only pre-model infrastructure failures",
			));
		}

		let retry = admission.retry_after_failure(attempt_number, false, classification)?;
		let attempt = self.current_attempt_mut(attempt_number)?;

		if attempt.state != CandidateUnitAttemptState::Prepared
			|| attempt.model_started
			|| attempt.infrastructure_classification.is_some()
		{
			return Err(CandidateGateError::new(
				"candidate infrastructure failure cannot change this attempt state",
			));
		}

		attempt.infrastructure_classification = Some(classification);
		attempt.state = if retry.is_some() {
			CandidateUnitAttemptState::RetryableInfrastructure
		} else {
			CandidateUnitAttemptState::TerminalInfrastructure
		};

		self.persist(authorization, unit)
	}

	/// Marks the model-started attempt complete after immutable runner outputs exist.
	pub fn mark_completed(
		&mut self,
		authorization: &CandidateExecutionAuthorization,
		unit: &CandidateExecutionUnit,
		attempt_number: u8,
	) -> Result<(), CandidateGateError> {
		self.validate(authorization, unit)?;

		let attempt = self.current_attempt_mut(attempt_number)?;

		if attempt.state == CandidateUnitAttemptState::Completed {
			return Ok(());
		}
		if attempt.state != CandidateUnitAttemptState::ModelStarted
			|| !attempt.model_started
			|| attempt.infrastructure_classification.is_some()
		{
			return Err(CandidateGateError::new(
				"candidate completion requires the durable model-started boundary",
			));
		}

		attempt.state = CandidateUnitAttemptState::Completed;

		self.persist(authorization, unit)
	}

	fn start_attempt(
		&mut self,
		authorization: &CandidateExecutionAuthorization,
		unit: &CandidateExecutionUnit,
		admission: &ReleaseGateAdmissionV1,
		attempt_number: u8,
		started_at: &str,
	) -> Result<CandidateAttemptDecision, CandidateGateError> {
		let delay = admission.scheduled_attempt_delay(attempt_number)?;
		let scheduled_for = add_seconds(&unit.slot_id, delay)?;
		let scheduled = parse_canonical_timestamp(&scheduled_for)?;
		let started = parse_canonical_timestamp(started_at)?;

		if started < scheduled {
			return Err(CandidateGateError::new(
				"candidate retry cannot start before its signed logical time",
			));
		}
		if self.journal.attempts.last().is_some_and(|previous| {
			parse_canonical_timestamp(&previous.started_at).is_ok_and(|time| started <= time)
		}) {
			return Err(CandidateGateError::new(
				"candidate retry start must follow the previous actual start",
			));
		}

		let attempt = CandidateUnitAttempt {
			attempt_number,
			scheduled_delay_seconds: delay,
			scheduled_for,
			started_at: started_at.to_owned(),
			model_started: false,
			state: CandidateUnitAttemptState::Prepared,
			infrastructure_classification: None,
		};

		self.journal.attempts.push(attempt.clone());
		self.persist(authorization, unit)?;

		Ok(CandidateAttemptDecision::Start(attempt))
	}

	fn current_attempt_mut(
		&mut self,
		attempt_number: u8,
	) -> Result<&mut CandidateUnitAttempt, CandidateGateError> {
		let attempt = self
			.journal
			.attempts
			.last_mut()
			.ok_or_else(|| CandidateGateError::new("candidate attempt journal is empty"))?;

		if attempt.attempt_number != attempt_number {
			return Err(CandidateGateError::new(
				"candidate attempt transition does not target the current attempt",
			));
		}

		Ok(attempt)
	}

	fn persist(
		&self,
		authorization: &CandidateExecutionAuthorization,
		unit: &CandidateExecutionUnit,
	) -> Result<(), CandidateGateError> {
		self.validate(authorization, unit)?;

		resume::atomic_write_json(&self.path, &self.journal)
			.map_err(|error| CandidateGateError::new(error.to_string()))
	}

	fn validate(
		&self,
		authorization: &CandidateExecutionAuthorization,
		unit: &CandidateExecutionUnit,
	) -> Result<(), CandidateGateError> {
		if self.journal.schema_version != CANDIDATE_ATTEMPT_JOURNAL_SCHEMA
			|| self.journal.authorization_sha256 != authorization.digest()?
			|| self.journal.execution_plan_digest != authorization.execution_plan_digest
			|| self.journal.signed_admission_sha256 != authorization.signed_admission_sha256
			|| self.journal.repeat_id != unit.repeat_id
			|| self.journal.unit_id != unit.unit_id
			|| self.journal.scheduled_at != unit.slot_id
			|| !authorization.plan.execution_units.iter().any(|candidate| candidate == unit)
			|| self.journal.attempts.len() > 3
		{
			return Err(CandidateGateError::new(
				"candidate attempt journal does not match the authorized unit",
			));
		}

		parse_canonical_timestamp(&self.journal.scheduled_at)?;

		for (index, attempt) in self.journal.attempts.iter().enumerate() {
			let number = u8::try_from(index + 1)
				.map_err(|_| CandidateGateError::new("candidate attempt index overflows"))?;
			let expected_delay = match number {
				1 => 0,
				2 => 30,
				3 => 90,
				_ => return Err(CandidateGateError::new("candidate attempt count is invalid")),
			};

			if attempt.attempt_number != number
				|| attempt.scheduled_delay_seconds != expected_delay
				|| attempt.scheduled_for != add_seconds(&unit.slot_id, expected_delay)?
				|| parse_canonical_timestamp(&attempt.started_at)?
					< parse_canonical_timestamp(&attempt.scheduled_for)?
				|| (index > 0
					&& parse_canonical_timestamp(&attempt.started_at)?
						<= parse_canonical_timestamp(&self.journal.attempts[index - 1].started_at)?)
			{
				return Err(CandidateGateError::new(
					"candidate attempt sequence or timing is invalid",
				));
			}

			let is_last = index + 1 == self.journal.attempts.len();

			match attempt.state {
				CandidateUnitAttemptState::Prepared => {
					if !is_last
						|| attempt.model_started
						|| attempt.infrastructure_classification.is_some()
					{
						return Err(CandidateGateError::new(
							"candidate prepared attempt is invalid",
						));
					}
				},
				CandidateUnitAttemptState::ModelStarted => {
					if !is_last
						|| !attempt.model_started
						|| attempt.infrastructure_classification.is_some()
					{
						return Err(CandidateGateError::new(
							"candidate model-started attempt is invalid",
						));
					}
				},
				CandidateUnitAttemptState::RetryableInfrastructure => {
					if attempt.model_started
						|| !matches!(
							attempt.infrastructure_classification,
							Some(CandidateAttemptFailure::PreModelAdmission)
						) || number >= 3
					{
						return Err(CandidateGateError::new(
							"candidate retryable attempt is invalid",
						));
					}
				},
				CandidateUnitAttemptState::TerminalInfrastructure => {
					if !is_last
						|| attempt.model_started
						|| !matches!(
							attempt.infrastructure_classification,
							Some(CandidateAttemptFailure::PreModelAdmission)
						) || number != 3
					{
						return Err(CandidateGateError::new(
							"candidate terminal attempt is invalid",
						));
					}
				},
				CandidateUnitAttemptState::Completed => {
					if !is_last
						|| !attempt.model_started
						|| attempt.infrastructure_classification.is_some()
					{
						return Err(CandidateGateError::new(
							"candidate completed attempt is invalid",
						));
					}
				},
			}
		}

		Ok(())
	}
}

/// Returns the current UTC instant in the release gate's canonical millisecond form.
pub fn canonical_now() -> Result<String, CandidateGateError> {
	let milliseconds = i64::try_from(resume::unix_ms())
		.map_err(|_| CandidateGateError::new("candidate current timestamp overflows"))?;

	canonical_timestamp(milliseconds)
}

fn add_seconds(value: &str, seconds: u64) -> Result<String, CandidateGateError> {
	let instant = parse_canonical_timestamp(value)?;
	let milliseconds = i64::try_from(seconds)
		.ok()
		.and_then(|seconds| seconds.checked_mul(1_000))
		.and_then(|delta| instant.as_millisecond().checked_add(delta))
		.ok_or_else(|| CandidateGateError::new("candidate attempt schedule overflows"))?;

	canonical_timestamp(milliseconds)
}

fn canonical_timestamp(milliseconds: i64) -> Result<String, CandidateGateError> {
	let remainder = milliseconds.rem_euclid(1_000);
	let whole_second = milliseconds
		.checked_sub(remainder)
		.ok_or_else(|| CandidateGateError::new("candidate timestamp overflows"))?;
	let raw = Timestamp::from_millisecond(whole_second)
		.map_err(|_| CandidateGateError::new("candidate timestamp is outside the supported range"))?
		.to_string();
	let without_zone = raw
		.strip_suffix('Z')
		.ok_or_else(|| CandidateGateError::new("candidate timestamp is not UTC"))?;
	let second = without_zone.split_once('.').map_or(without_zone, |(second, _)| second);

	Ok(format!("{second}.{remainder:03}Z"))
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
			"candidate timestamp must be canonical ISO milliseconds in UTC",
		));
	}

	value
		.parse::<Timestamp>()
		.map_err(|_| CandidateGateError::new("candidate timestamp is not a valid UTC instant"))
}

fn validate_private_journal_path(path: &Path) -> Result<(), CandidateGateError> {
	if !path.is_absolute()
		|| path.file_name().is_none()
		|| path.components().any(|component| {
			matches!(component, Component::ParentDir | Component::CurDir | Component::Prefix(_))
		}) {
		return Err(CandidateGateError::new(
			"candidate attempt journal path must be normalized and absolute",
		));
	}

	let parent = path
		.parent()
		.ok_or_else(|| CandidateGateError::new("candidate attempt journal has no parent"))?;

	if fs::canonicalize(parent)
		.map_err(|_| CandidateGateError::new("candidate attempt journal parent is unavailable"))?
		!= parent
	{
		return Err(CandidateGateError::new(
			"candidate attempt journal parent must not contain symbolic-link indirection",
		));
	}

	let metadata = fs::metadata(parent)
		.map_err(|_| CandidateGateError::new("candidate attempt journal parent is unavailable"))?;

	if !metadata.is_dir() {
		return Err(CandidateGateError::new(
			"candidate attempt journal parent must be a directory",
		));
	}
	#[cfg(unix)]
	if metadata.permissions().mode() & 0o077 != 0 {
		return Err(CandidateGateError::new(
			"candidate attempt journal parent must not be accessible to group or other users",
		));
	}

	Ok(())
}

fn read_journal(path: &Path) -> Result<CandidateAttemptJournal, CandidateGateError> {
	let metadata = fs::symlink_metadata(path)
		.map_err(|_| CandidateGateError::new("candidate attempt journal is unavailable"))?;

	if metadata.file_type().is_symlink()
		|| !metadata.is_file()
		|| metadata.len() == 0
		|| metadata.len() > MAX_JOURNAL_BYTES
	{
		return Err(CandidateGateError::new(
			"candidate attempt journal must be a nonempty bounded regular file",
		));
	}
	#[cfg(unix)]
	if metadata.nlink() != 1 || metadata.permissions().mode() & 0o077 != 0 {
		return Err(CandidateGateError::new(
			"candidate attempt journal must be private and have one filesystem link",
		));
	}

	let mut options = OpenOptions::new();

	options.read(true);
	#[cfg(unix)]
	options.custom_flags(O_NOFOLLOW | O_CLOEXEC);

	let file = options
		.open(path)
		.map_err(|_| CandidateGateError::new("candidate attempt journal cannot be opened"))?;
	let opened = file.metadata().map_err(|_| {
		CandidateGateError::new("candidate attempt journal metadata is unavailable")
	})?;

	#[cfg(unix)]
	if opened.dev() != metadata.dev() || opened.ino() != metadata.ino() {
		return Err(CandidateGateError::new(
			"candidate attempt journal identity changed while opening",
		));
	}

	let mut bytes = Vec::with_capacity(opened.len() as usize);

	file.take(MAX_JOURNAL_BYTES + 1)
		.read_to_end(&mut bytes)
		.map_err(|_| CandidateGateError::new("candidate attempt journal cannot be read"))?;

	if bytes.len() as u64 > MAX_JOURNAL_BYTES {
		return Err(CandidateGateError::new("candidate attempt journal exceeds its byte limit"));
	}

	serde_json::from_slice(&bytes)
		.map_err(|_| CandidateGateError::new("candidate attempt journal shape is invalid"))
}
