//! End-to-end observation workflow.

mod official;
mod speed;

/// Protected runtime secret names.
pub use crate::credentials::PROTECTED_SECRETS;

use std::fs::Permissions;
use std::io::ErrorKind;
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::process;
#[cfg(target_os = "macos")]
use std::process::Command;
use std::thread::ScopedJoinHandle;
use std::{
	collections::BTreeMap,
	env,
	ffi::{OsStr, OsString},
	fs::{self, File, OpenOptions},
	io::Write,
	path::{Path, PathBuf},
	process::{Output, Stdio},
	thread,
	time::{SystemTime, UNIX_EPOCH},
};

use jiff::Timestamp;
#[cfg(unix)]
use libc::O_NOFOLLOW;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::{
	Error, Result, ResultContext,
	config::Configuration,
	credentials::RuntimeSecrets,
	lock::ProcessLock,
	release::{Release, ReleasePaths},
	schedule::{self, ScheduledSlot, SurroundingSlots},
	supervisor,
};

const STATUS_SCHEMA: &str = "aiq.continuous-observation-status.v3";
#[cfg(test)]
const LEGACY_STATUS_SCHEMA: &str = "aiq.continuous-observation-status.v2";
const PUBLICATION_STATUS_SCHEMA: &str = "aiq.observation-publication-status.v1";
const OFFICIAL_RUN_SCHEMA: &str = "aiq.run.v4";
const OFFICIAL_RESULT_COUNT: usize = 1_224;
const OFFICIAL_DISPATCH_GRACE_MILLISECONDS: i64 = 2 * 60 * 60 * 1_000;
const REQUIRED_OFFICIAL_JOBS: u8 = 32;
const SUBSCRIPTION_BACKPRESSURE_EXIT_CODE: i32 = 75;
const BASE_ENVIRONMENT: [&str; 15] = [
	"HOME",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"NO_PROXY",
	"PATH",
	"SSL_CERT_DIR",
	"SSL_CERT_FILE",
	"TEMP",
	"TMP",
	"TMPDIR",
	"http_proxy",
	"https_proxy",
	"no_proxy",
	"TZ",
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum StepSecrets {
	None,
	RunnerSigning,
	RunnerSubmission,
	Verifier,
}
impl StepSecrets {
	const fn names(self) -> &'static [&'static str] {
		match self {
			Self::None => &[],
			Self::RunnerSigning => &["AIQ_RUNNER_SIGNING_KEY"],
			Self::RunnerSubmission => &["AIQ_RUNNER_SUBMISSION_TOKEN"],
			Self::Verifier => &["AIQ_VERIFIER_INGRESS_TOKEN", "AIQ_VERIFIER_SIGNING_KEY"],
		}
	}
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CaptureKind {
	Submission,
	Verifier,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PublicationOwner {
	Speed,
	Official,
}
impl PublicationOwner {
	const fn label(self) -> &'static str {
		match self {
			Self::Speed => "Speed",
			Self::Official => "Official",
		}
	}

	const fn value(self) -> &'static str {
		match self {
			Self::Speed => "speed",
			Self::Official => "official",
		}
	}
}

#[derive(Debug, Serialize)]
pub(crate) struct DoctorReport {
	status: &'static str,
	release_id: String,
	validated_source: PathBuf,
	latest_slot: ScheduledSlot,
	next_slot: ScheduledSlot,
}

#[derive(Clone, Debug)]
struct CommandStep {
	name: &'static str,
	executable: PathBuf,
	args: Vec<OsString>,
	output: PathBuf,
	capture: Option<CaptureKind>,
	secrets: StepSecrets,
}

enum CommandOutcome {
	Completed(Vec<u8>),
	Failed { error: Error, stdout: Vec<u8> },
}

#[derive(Clone, Debug)]
struct SlotPaths {
	root: PathBuf,
	log: PathBuf,
	status: PathBuf,
	speed: SpeedPaths,
	official: OfficialPaths,
}

#[derive(Clone, Debug)]
struct SpeedPaths {
	root: PathBuf,
	status: PathBuf,
	home: PathBuf,
	artifacts: PathBuf,
	workspace: PathBuf,
	checkpoints: PathBuf,
	batch: PathBuf,
	receipt: PathBuf,
}

#[derive(Clone, Debug)]
struct OfficialPaths {
	root: PathBuf,
	status: PathBuf,
	home: PathBuf,
	artifacts: PathBuf,
	execution: PathBuf,
	state: PathBuf,
	records: PathBuf,
	verification: PathBuf,
	admission: PathBuf,
	preflight: PathBuf,
	checkpoint: PathBuf,
	run: PathBuf,
	score: PathBuf,
	package: PathBuf,
	submission_receipt: PathBuf,
	environment: PathBuf,
	verifier_records: PathBuf,
	verifier_attempts: PathBuf,
}

#[derive(Debug, Eq, PartialEq)]
struct VerifierPackageIdentity {
	idempotency_key: String,
	package_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PublicationStatus {
	schema_version: String,
	owner: String,
	slot_id: String,
	phase: String,
	detail: String,
	updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct RetainedStatus {
	schema_version: String,
	slot_id: String,
	observed_at: String,
	phase: String,
	detail: String,
	updated_at: String,
	#[serde(skip_serializing_if = "Option::is_none")]
	speed: Option<PublicationStatus>,
	#[serde(skip_serializing_if = "Option::is_none")]
	official: Option<PublicationStatus>,
}

#[derive(Debug, Serialize)]
struct ScheduleStatus {
	schema_version: &'static str,
	checked_at: String,
	latest_slot: ScheduledSlot,
	latest_slot_state: Option<Value>,
	next_slot: ScheduledSlot,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct PaidWorkRecoveryState {
	completed_results: usize,
	deferred_cells: usize,
	legacy_terminal_results: bool,
	pending_evaluations: usize,
}

/// Returns schedule and retained state without validating the release.
pub(crate) fn status(configuration: &Configuration) -> Result<Value> {
	let slots = schedule::current_surrounding_slots()?;

	status_at(configuration, slots)
}

/// Performs model-free release and disposable-source validation.
pub(crate) fn doctor(configuration: &Configuration) -> Result<DoctorReport> {
	private_directory(&configuration.state_root)?;

	let _lock = ProcessLock::try_acquire(&configuration.state_root)?
		.ok_or_else(|| Error::new("another AIQ observation process holds the active lock"))?;
	let slots = schedule::current_surrounding_slots()?;
	let release =
		Release::open(&configuration.release_root, &configuration.release_manifest_sha256)?;
	let source = release.prepare_source(&configuration.state_root, &slots.latest)?;

	release.cleanup_source(&configuration.state_root, &slots.latest)?;

	Ok(DoctorReport {
		status: "ok",
		release_id: release.id().to_owned(),
		validated_source: source,
		latest_slot: slots.latest,
		next_slot: slots.next,
	})
}

/// Runs one selected due slot with exact create-once resume semantics.
pub(crate) fn run(configuration: &Configuration, selected: Option<ScheduledSlot>) -> Result<()> {
	let slots = schedule::current_surrounding_slots()?;

	private_directory(&configuration.state_root)?;

	let slot = match selected {
		Some(slot) => slot,
		None => paid_work_recovery_slot(configuration, &slots.latest)?
			.unwrap_or_else(|| slots.latest.clone()),
	};

	if slot.timestamp_ms > slots.latest.timestamp_ms {
		return Err(Error::new("selected observation slot is in the future"));
	}

	let Some(_lock) = ProcessLock::try_acquire(&configuration.state_root)? else {
		return Ok(());
	};
	let paths = slot_paths(&configuration.state_root, &slot);

	prepare_slot_directories(&paths)?;

	if retained_current_terminal(&paths, &slot)? {
		cleanup_codex_home(&paths.speed.home)?;
		cleanup_codex_home(&paths.official.home)?;

		return Ok(());
	}

	initialize_publication_statuses(&paths, &slot)?;
	write_composed_status(&paths, &slot)?;

	if retained_phase(&paths, &slot)?.as_deref().is_some_and(is_terminal_phase) {
		cleanup_codex_home(&paths.speed.home)?;
		cleanup_codex_home(&paths.official.home)?;

		return Ok(());
	}

	run_locked(configuration, &slot, &paths)
}

fn is_terminal_phase(phase: &str) -> bool {
	matches!(
		phase,
		"complete"
			| "complete_with_unpublished_official"
			| "complete_with_unpublished_speed"
			| "complete_with_unpublished_speed_and_official"
			| "missed_window"
	)
}

fn paid_work_recovery_slot(
	configuration: &Configuration,
	latest: &ScheduledSlot,
) -> Result<Option<ScheduledSlot>> {
	let slots_root = configuration.state_root.join("slots");
	let entries = match fs::read_dir(&slots_root) {
		Ok(entries) => entries,
		Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
		Err(error) => {
			return Err(Error::new(format!("cannot inspect retained observation slots: {error}",)));
		},
	};
	let mut candidate = None;

	for entry in entries {
		let entry = entry.context("cannot inspect retained observation slot")?;
		let metadata =
			entry.file_type().context("cannot inspect retained observation slot type")?;

		if !metadata.is_dir() || metadata.is_symlink() {
			continue;
		}

		let Some(name) = entry.file_name().to_str().map(str::to_owned) else { continue };
		let Ok(slot) = schedule::scheduled_slot(&name) else { continue };

		if slot.timestamp_ms > latest.timestamp_ms {
			continue;
		}

		let paths = slot_paths(&configuration.state_root, &slot);
		let Some(phase) = retained_phase(&paths, &slot)? else { continue };
		let Some(state) = official::paid_work_recovery_state(&paths.official.checkpoint)? else {
			continue;
		};

		if phase != "waiting_for_subscription"
			&& !(phase == "retryable_failure"
				&& (state.legacy_terminal_results || state.pending_evaluations > 0))
		{
			continue;
		}
		if candidate
			.as_ref()
			.is_none_or(|existing: &ScheduledSlot| slot.timestamp_ms < existing.timestamp_ms)
		{
			candidate = Some(slot);
		}
	}

	Ok(candidate)
}

fn status_at(configuration: &Configuration, slots: SurroundingSlots) -> Result<Value> {
	let paths = slot_paths(&configuration.state_root, &slots.latest);
	let latest_slot_state = slot_status_value(&paths, &slots.latest)?;

	serde_json::to_value(ScheduleStatus {
		schema_version: STATUS_SCHEMA,
		checked_at: now_string()?,
		latest_slot: slots.latest,
		latest_slot_state,
		next_slot: slots.next,
	})
	.context("cannot serialize schedule status")
}

fn run_locked(
	configuration: &Configuration,
	slot: &ScheduledSlot,
	paths: &SlotPaths,
) -> Result<()> {
	let release =
		match Release::open(&configuration.release_root, &configuration.release_manifest_sha256) {
			Ok(release) => release,
			Err(error) => return record_shared_failure(paths, slot, error),
		};
	let now_unix_ms = match current_unix_ms() {
		Ok(now_unix_ms) => now_unix_ms,
		Err(error) => return record_shared_failure(paths, slot, error),
	};
	let speed_dispatch = speed::dispatch(slot, paths, now_unix_ms);
	let official_dispatch = official::dispatch(slot, paths, now_unix_ms);
	let needs_secrets = speed_dispatch.as_ref().is_ok_and(|dispatch| dispatch.needs_secrets())
		|| official_dispatch.as_ref().is_ok_and(|dispatch| dispatch.needs_secrets());
	let secrets =
		if needs_secrets { RuntimeSecrets::resolve(configuration).map(Some) } else { Ok(None) };
	let (speed_result, official_result) = thread::scope(|scope| {
		let speed_handle = scope.spawn(|| {
			run_speed_path(configuration, release.paths(), paths, slot, &speed_dispatch, &secrets)
		});
		let official_handle = scope.spawn(|| {
			run_official_path(configuration, &release, paths, slot, &official_dispatch, &secrets)
		});

		(
			join_publication(speed_handle, PublicationOwner::Speed),
			join_publication(official_handle, PublicationOwner::Official),
		)
	});

	if let Err(error) = &speed_result {
		record_owner_failure(paths, slot, PublicationOwner::Speed, error)?;
	}
	if let Err(error) = &official_result {
		record_owner_failure(paths, slot, PublicationOwner::Official, error)?;
	}

	write_composed_status(paths, slot)?;

	let result = combine_publication_results(speed_result, official_result);

	if let Err(error) = &result {
		append_log(&paths.log, "slot_failed", &safe_detail(&error.to_string()))?;
	}

	result
}

fn run_speed_path(
	configuration: &Configuration,
	release: &ReleasePaths,
	paths: &SlotPaths,
	slot: &ScheduledSlot,
	dispatch: &Result<speed::Dispatch>,
	secrets: &Result<Option<RuntimeSecrets>>,
) -> Result<()> {
	let dispatch = match dispatch.as_ref() {
		Ok(dispatch) => dispatch,
		Err(error) => {
			let error = Error::new(error.to_string());

			record_owner_failure(paths, slot, PublicationOwner::Speed, &error)?;

			return Err(error);
		},
	};
	let secrets = match publication_secrets(dispatch.needs_secrets(), secrets) {
		Ok(secrets) => secrets,
		Err(error) => {
			record_owner_failure(paths, slot, PublicationOwner::Speed, &error)?;

			return Err(error);
		},
	};

	speed::run(configuration, release, paths, slot, *dispatch, secrets)
}

fn run_official_path(
	configuration: &Configuration,
	release: &Release,
	paths: &SlotPaths,
	slot: &ScheduledSlot,
	dispatch: &Result<official::Dispatch>,
	secrets: &Result<Option<RuntimeSecrets>>,
) -> Result<()> {
	let dispatch = match dispatch.as_ref() {
		Ok(dispatch) => dispatch,
		Err(error) => {
			let error = Error::new(error.to_string());

			record_owner_failure(paths, slot, PublicationOwner::Official, &error)?;

			return Err(error);
		},
	};
	let secrets = match publication_secrets(dispatch.needs_secrets(), secrets) {
		Ok(secrets) => secrets,
		Err(error) => {
			record_owner_failure(paths, slot, PublicationOwner::Official, &error)?;

			return Err(error);
		},
	};

	official::run(configuration, release, paths, slot, *dispatch, secrets)
}

fn publication_secrets(
	required: bool,
	secrets: &Result<Option<RuntimeSecrets>>,
) -> Result<Option<&RuntimeSecrets>> {
	match secrets {
		Ok(secrets) => Ok(secrets.as_ref()),
		Err(error) if required => Err(Error::new(error.to_string())),
		Err(_) => Ok(None),
	}
}

fn join_publication(
	handle: ScopedJoinHandle<'_, Result<()>>,
	owner: PublicationOwner,
) -> Result<()> {
	handle.join().map_err(|_| Error::new(format!("{} publication path panicked", owner.label())))?
}

fn combine_publication_results(speed: Result<()>, official: Result<()>) -> Result<()> {
	match (speed, official) {
		(Ok(()), Ok(())) => Ok(()),
		(Err(error), Ok(())) => Err(Error::new(format!("Speed publication failed: {error}"))),
		(Ok(()), Err(error)) => Err(Error::new(format!("Official publication failed: {error}"))),
		(Err(speed), Err(official)) => Err(Error::new(format!(
			"Speed publication failed: {speed}; Official publication failed: {official}",
		))),
	}
}

fn record_shared_failure(paths: &SlotPaths, slot: &ScheduledSlot, error: Error) -> Result<()> {
	for owner in [PublicationOwner::Speed, PublicationOwner::Official] {
		record_owner_failure(paths, slot, owner, &error)?;
	}

	write_composed_status(paths, slot)?;
	append_log(&paths.log, "slot_failed", &safe_detail(&error.to_string()))?;

	Err(error)
}

fn official_steps(
	configuration: &Configuration,
	release: &Release,
	paths: &SlotPaths,
	slot: &ScheduledSlot,
	target_source: &Path,
) -> [CommandStep; 8] {
	[
		official_admission_step(configuration, release.paths(), paths, slot),
		official_preflight_step(release.paths(), paths),
		official_run_step(configuration, release.paths(), paths, slot),
		official_score_step(release.paths(), paths),
		official_package_step(configuration, release.paths(), paths),
		official_submit_step(configuration, release.paths(), paths),
		official_environment_step(release.paths(), paths),
		official_verifier_step(configuration, release, paths, target_source),
	]
}

fn official_common_plan(
	configuration: &Configuration,
	release: &ReleasePaths,
	paths: &SlotPaths,
	slot: &ScheduledSlot,
) -> Vec<OsString> {
	args([
		"--hidden-tasks",
		release.tasks.to_string_lossy().as_ref(),
		"--corpus-commitment",
		release.commitment.to_string_lossy().as_ref(),
		"--source-root",
		release.corpus_source_snapshot.to_string_lossy().as_ref(),
		"--capabilities",
		release.capabilities.to_string_lossy().as_ref(),
		"--workspace-root",
		release.workspaces.to_string_lossy().as_ref(),
		"--execution-root",
		paths.official.execution.to_string_lossy().as_ref(),
		"--evaluator-root",
		release.evaluator.to_string_lossy().as_ref(),
		"--evaluator-runtime",
		release.runtime.to_string_lossy().as_ref(),
		"--codex-toolchain-root",
		release.toolchain.to_string_lossy().as_ref(),
		"--schedule",
		release.schedule.to_string_lossy().as_ref(),
		"--slot-date",
		&slot.slot_date,
		"--occurrence",
		slot.occurrence,
		"--observed-at",
		&slot.observed_at,
		"--codex-binary",
		release.codex.to_string_lossy().as_ref(),
		"--codex-home",
		paths.official.home.to_string_lossy().as_ref(),
		"--artifact-root",
		paths.official.artifacts.to_string_lossy().as_ref(),
		"--preflight-cache",
		paths.official.preflight.to_string_lossy().as_ref(),
		"--checkpoint",
		paths.official.checkpoint.to_string_lossy().as_ref(),
		"--jobs",
		&configuration.official_jobs.to_string(),
	])
}

fn official_admission_step(
	configuration: &Configuration,
	release: &ReleasePaths,
	paths: &SlotPaths,
	slot: &ScheduledSlot,
) -> CommandStep {
	let mut command_args = vec![OsString::from("admit-permissions")];

	command_args.extend(official_common_plan(configuration, release, paths, slot));
	command_args.extend(args([
		"--calibration-admission",
		release.calibration_admission.to_string_lossy().as_ref(),
		"--planned-output",
		paths.official.run.to_string_lossy().as_ref(),
		"--planned-score-output",
		paths.official.score.to_string_lossy().as_ref(),
		"--planned-package-output",
		paths.official.package.to_string_lossy().as_ref(),
		"--output",
		paths.official.admission.to_string_lossy().as_ref(),
	]));
	CommandStep {
		name: "official_admit",
		executable: release.runner.clone(),
		args: command_args,
		output: paths.official.admission.clone(),
		capture: None,
		secrets: StepSecrets::None,
	}
}

fn official_preflight_step(release: &ReleasePaths, paths: &SlotPaths) -> CommandStep {
	CommandStep {
		name: "official_preflight",
		executable: release.runner.clone(),
		args: args([
			"preflight",
			"--capabilities",
			release.capabilities.to_string_lossy().as_ref(),
			"--corpus-commitment",
			release.commitment.to_string_lossy().as_ref(),
			"--evaluator-runtime",
			release.runtime.to_string_lossy().as_ref(),
			"--codex-toolchain-root",
			release.toolchain.to_string_lossy().as_ref(),
			"--codex-binary",
			release.codex.to_string_lossy().as_ref(),
			"--codex-home",
			paths.official.home.to_string_lossy().as_ref(),
			"--artifact-root",
			paths.official.artifacts.to_string_lossy().as_ref(),
			"--expires-in-seconds",
			"86400",
			"--output",
			paths.official.preflight.to_string_lossy().as_ref(),
			"--official-admission",
			paths.official.admission.to_string_lossy().as_ref(),
		]),
		output: paths.official.preflight.clone(),
		capture: None,
		secrets: StepSecrets::None,
	}
}

fn official_run_step(
	configuration: &Configuration,
	release: &ReleasePaths,
	paths: &SlotPaths,
	slot: &ScheduledSlot,
) -> CommandStep {
	let mut command_args = vec![OsString::from("run")];

	command_args.extend(official_common_plan(configuration, release, paths, slot));
	command_args.extend(args([
		"--official-admission",
		paths.official.admission.to_string_lossy().as_ref(),
		"--run-class",
		"official",
		"--output",
		paths.official.run.to_string_lossy().as_ref(),
	]));
	CommandStep {
		name: "official_run",
		executable: release.runner.clone(),
		args: command_args,
		output: paths.official.run.clone(),
		capture: None,
		secrets: StepSecrets::None,
	}
}

fn official_score_step(release: &ReleasePaths, paths: &SlotPaths) -> CommandStep {
	CommandStep {
		name: "official_score",
		executable: release.runner.clone(),
		args: args([
			"score",
			"--hidden-tasks",
			release.tasks.to_string_lossy().as_ref(),
			"--results",
			paths.official.run.to_string_lossy().as_ref(),
			"--official-admission",
			paths.official.admission.to_string_lossy().as_ref(),
			"--output",
			paths.official.score.to_string_lossy().as_ref(),
		]),
		output: paths.official.score.clone(),
		capture: None,
		secrets: StepSecrets::None,
	}
}

fn official_package_step(
	configuration: &Configuration,
	release: &ReleasePaths,
	paths: &SlotPaths,
) -> CommandStep {
	CommandStep {
		name: "official_package",
		executable: release.runner.clone(),
		args: args([
			"package",
			"--run",
			paths.official.run.to_string_lossy().as_ref(),
			"--artifact-root",
			paths.official.artifacts.to_string_lossy().as_ref(),
			"--execution-concurrency",
			&configuration.official_jobs.to_string(),
			"--official-admission",
			paths.official.admission.to_string_lossy().as_ref(),
			"--output",
			paths.official.package.to_string_lossy().as_ref(),
		]),
		output: paths.official.package.clone(),
		capture: None,
		secrets: StepSecrets::RunnerSigning,
	}
}

fn official_submit_step(
	configuration: &Configuration,
	release: &ReleasePaths,
	paths: &SlotPaths,
) -> CommandStep {
	CommandStep {
		name: "official_submit",
		executable: release.runner.clone(),
		args: args([
			"submit",
			"--package",
			paths.official.package.to_string_lossy().as_ref(),
			"--artifact-root",
			paths.official.artifacts.to_string_lossy().as_ref(),
			"--endpoint",
			&configuration.endpoint,
			"--artifact-upload-concurrency",
			"8",
		]),
		output: paths.official.submission_receipt.clone(),
		capture: Some(CaptureKind::Submission),
		secrets: StepSecrets::RunnerSubmission,
	}
}

fn official_environment_step(release: &ReleasePaths, paths: &SlotPaths) -> CommandStep {
	CommandStep {
		name: "official_environment",
		executable: release.runtime.clone(),
		args: args([
			release.environment_generator.to_string_lossy().as_ref(),
			paths.official.package.to_string_lossy().as_ref(),
			release.commitment.to_string_lossy().as_ref(),
			release.seal_receipt.to_string_lossy().as_ref(),
			release.build_receipt.to_string_lossy().as_ref(),
			release.production_reference.to_string_lossy().as_ref(),
			paths.official.environment.to_string_lossy().as_ref(),
		]),
		output: paths.official.environment.clone(),
		capture: None,
		secrets: StepSecrets::None,
	}
}

fn official_verifier_step(
	configuration: &Configuration,
	release: &Release,
	paths: &SlotPaths,
	target_source: &Path,
) -> CommandStep {
	let runtime = release.paths();

	CommandStep {
		name: "official_verify_publish",
		executable: runtime.verifier.clone(),
		args: official_verifier_arguments(
			configuration,
			runtime,
			release.production_reference_sha256(),
			release.build_receipt_sha256(),
			paths,
			target_source,
		),
		output: paths.official.verifier_records.clone(),
		capture: Some(CaptureKind::Verifier),
		secrets: StepSecrets::Verifier,
	}
}

fn official_verifier_arguments(
	configuration: &Configuration,
	runtime: &ReleasePaths,
	production_reference_sha256: &str,
	build_receipt_sha256: &str,
	paths: &SlotPaths,
	target_source: &Path,
) -> Vec<OsString> {
	args([
		"--endpoint",
		&configuration.endpoint,
		"--tasks",
		runtime.tasks.to_string_lossy().as_ref(),
		"--environment",
		paths.official.environment.to_string_lossy().as_ref(),
		"--evaluator-root",
		runtime.evaluator.to_string_lossy().as_ref(),
		"--corpus-commitment",
		runtime.commitment.to_string_lossy().as_ref(),
		"--codex-toolchain-root",
		runtime.toolchain.to_string_lossy().as_ref(),
		"--evaluator-runtime",
		runtime.runtime.to_string_lossy().as_ref(),
		"--calibration-admission",
		runtime.calibration_admission.to_string_lossy().as_ref(),
		"--corpus-source-root",
		runtime.corpus_source_snapshot.to_string_lossy().as_ref(),
		"--target-source-root",
		target_source.to_string_lossy().as_ref(),
		"--runner-binary",
		runtime.runner.to_string_lossy().as_ref(),
		"--codex-binary",
		runtime.codex.to_string_lossy().as_ref(),
		"--production-reference",
		runtime.production_reference.to_string_lossy().as_ref(),
		"--expected-production-reference-sha256",
		production_reference_sha256,
		"--build-receipt",
		runtime.build_receipt.to_string_lossy().as_ref(),
		"--expected-build-receipt-sha256",
		build_receipt_sha256,
		"--replay-root",
		paths.official.verification.join("replay").to_string_lossy().as_ref(),
		"--replay-jobs",
		&configuration.verifier_replay_jobs.to_string(),
		"--max-claims",
		"1",
		"--max-idle-polls",
		"1",
		"--max-retries",
		"10",
		"--backoff-ms",
		"1000",
	])
}

fn run_create_once_step(
	step: &CommandStep,
	paths: &SlotPaths,
	slot: &ScheduledSlot,
	secrets: &RuntimeSecrets,
	owner: PublicationOwner,
) -> Result<()> {
	if existing_regular_file(&step.output)? {
		if existing_step_output_is_complete(step, paths)? {
			return Ok(());
		}

		remove_failed_step_output(&step.output)?;
		append_log(&paths.log, "step_retrying", step.name)?;
	}

	write_publication_status(paths, slot, owner, step.name, "running")?;

	let outcome = match run_command(step, &paths.log, secrets) {
		Ok(outcome) => outcome,
		Err(error) => {
			remove_failed_step_output(&step.output).map_err(|cleanup| {
				Error::new(format!("{error}; cannot remove failed {} output: {cleanup}", step.name))
			})?;

			return Err(error);
		},
	};
	let stdout = match outcome {
		CommandOutcome::Completed(stdout) => stdout,
		CommandOutcome::Failed { error, stdout } => {
			let retention = if step.capture == Some(CaptureKind::Verifier) {
				retain_verifier_attempt(&paths.official.verifier_attempts, &stdout, step.name)
			} else {
				Ok(())
			};

			remove_failed_step_output(&step.output).map_err(|cleanup| {
				Error::new(format!("{error}; cannot remove failed {} output: {cleanup}", step.name))
			})?;

			retention.map_err(|retention| {
				Error::new(format!("{error}; cannot retain verifier attempt: {retention}"))
			})?;

			return Err(error);
		},
	};

	if let Some(kind) = step.capture {
		let record = parse_captured_record(&stdout, step.name)?;

		match kind {
			CaptureKind::Submission => validate_submission_receipt(&record, step.name)?,
			CaptureKind::Verifier => {
				let expected = verifier_package_identity(&paths.official.package)?;

				if let Err(error) = validate_verifier_receipt(&record, &expected, step.name) {
					retain_verifier_attempt(&paths.official.verifier_attempts, &stdout, step.name)?;

					return Err(error);
				}
			},
		}

		write_create_once(
			&step.output,
			&serde_json::to_vec(&record).context("cannot serialize receipt")?,
		)?;
	} else if !existing_regular_file(&step.output)? {
		return Err(Error::new(format!(
			"{} completed without creating {}",
			step.name,
			step.output.display()
		)));
	}

	Ok(())
}

fn existing_step_output_is_complete(step: &CommandStep, paths: &SlotPaths) -> Result<bool> {
	if let Some(kind) = step.capture {
		return match kind {
			CaptureKind::Submission => submission_receipt_is_complete(&step.output),
			CaptureKind::Verifier => {
				verifier_receipt_is_complete(&step.output, &paths.official.package)
			},
		};
	}

	if step.name == "official_run" {
		return official::run_is_complete(&step.output);
	}
	if step.name != "official_admit" {
		return Ok(true);
	}

	let bytes =
		fs::read(&step.output).context(format!("cannot read existing {} output", step.name))?;
	let Ok(record) = serde_json::from_slice::<Value>(&bytes) else {
		return Ok(false);
	};

	Ok(record.get("schema_version").and_then(Value::as_str)
		== Some("aiq.official-permission-admission.v2")
		&& record.get("official_permission_eligible").and_then(Value::as_bool) == Some(true)
		&& record.get("model_invoked").and_then(Value::as_bool) == Some(false)
		&& record.get("failure").is_some_and(Value::is_null)
		&& record.get("plan").is_some_and(Value::is_object))
}

fn submission_receipt_is_complete(path: &Path) -> Result<bool> {
	if !existing_regular_file(path)? {
		return Ok(false);
	}

	let bytes =
		fs::read(path).context(format!("cannot read captured receipt {}", path.display()))?;
	let Ok(record) = serde_json::from_slice::<Value>(&bytes) else {
		return Ok(false);
	};

	Ok(validate_submission_receipt(&record, "captured receipt").is_ok())
}

fn verifier_receipt_is_complete(receipt: &Path, package: &Path) -> Result<bool> {
	if !existing_regular_file(receipt)? {
		return Ok(false);
	}

	let bytes =
		fs::read(receipt).context(format!("cannot read verifier receipt {}", receipt.display()))?;
	let Ok(record) = serde_json::from_slice::<Value>(&bytes) else {
		return Ok(false);
	};
	let expected = verifier_package_identity(package)?;

	Ok(validate_verifier_receipt(&record, &expected, "captured verifier receipt").is_ok())
}

fn remove_failed_step_output(path: &Path) -> Result<()> {
	let metadata = match fs::symlink_metadata(path) {
		Ok(metadata) => metadata,
		Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
		Err(error) => {
			return Err(Error::new(format!("cannot inspect {}: {error}", path.display())));
		},
	};

	if metadata.file_type().is_symlink() || metadata.is_file() {
		fs::remove_file(path).context(format!("cannot remove failed output {}", path.display()))
	} else {
		Err(Error::new(format!("refusing to remove non-file failed output: {}", path.display())))
	}
}

fn run_command(
	step: &CommandStep,
	log_path: &Path,
	secrets: &RuntimeSecrets,
) -> Result<CommandOutcome> {
	append_log(log_path, "step_started", step.name)?;

	let environment = child_environment(env::vars_os(), step.secrets, secrets)?;
	let mut command = supervisor::guarded_command(&step.executable, &step.args, &environment)?;
	let output =
		if step.capture.is_some() {
			command.stdout(Stdio::piped()).stderr(Stdio::piped());

			let mut child = command.spawn().context(format!("cannot start {}", step.name))?;
			let _parent_liveness = child.stdin.take().ok_or_else(|| {
				Error::new(format!("{} has no supervisor liveness pipe", step.name))
			})?;

			child.wait_with_output().context(format!("cannot wait for {}", step.name))?
		} else {
			let log = open_append(log_path)?;
			let stderr = log.try_clone().context("cannot clone operator log descriptor")?;

			command.stdout(Stdio::from(log)).stderr(Stdio::from(stderr));

			let mut child = command.spawn().context(format!("cannot start {}", step.name))?;
			let _parent_liveness = child.stdin.take().ok_or_else(|| {
				Error::new(format!("{} has no supervisor liveness pipe", step.name))
			})?;
			let status = child.wait().context(format!("cannot wait for {}", step.name))?;

			Output { status, stdout: Vec::new(), stderr: Vec::new() }
		};

	if !output.status.success() {
		if step.name == "official_run"
			&& output.status.code() == Some(SUBSCRIPTION_BACKPRESSURE_EXIT_CODE)
		{
			return Ok(CommandOutcome::Failed {
				error: Error::subscription_backpressure(
					"Official subscription capacity is unavailable; checkpoint retained",
				),
				stdout: output.stdout,
			});
		}

		let detail = if step.capture.is_some() {
			safe_detail(&String::from_utf8_lossy(&output.stderr))
		} else {
			"see operator log".to_owned()
		};

		return Ok(CommandOutcome::Failed {
			error: Error::new(format!(
				"{} failed with status {}: {detail}",
				step.name, output.status
			)),
			stdout: output.stdout,
		});
	}

	append_log(log_path, "step_completed", step.name)?;

	Ok(CommandOutcome::Completed(output.stdout))
}

fn child_environment<I>(
	parent: I,
	step_secrets: StepSecrets,
	runtime_secrets: &RuntimeSecrets,
) -> Result<BTreeMap<OsString, OsString>>
where
	I: IntoIterator<Item = (OsString, OsString)>,
{
	let parent: BTreeMap<OsString, OsString> = parent.into_iter().collect();
	let mut selected = BTreeMap::new();

	for name in BASE_ENVIRONMENT {
		if let Some(value) = parent.get(OsStr::new(name)) {
			selected.insert(OsString::from(name), value.clone());
		}
	}

	runtime_secrets.insert(step_secrets.names(), &mut selected)?;

	Ok(selected)
}

fn parse_captured_record(stdout: &[u8], step_name: &str) -> Result<Value> {
	serde_json::from_slice(stdout)
		.context(format!("{step_name} did not produce a valid JSON record"))
}

fn validate_submission_receipt(record: &Value, step_name: &str) -> Result<()> {
	let valid = record
		.get("package")
		.and_then(|package| package.get("kind"))
		.or_else(|| record.get("kind"))
		.and_then(Value::as_str)
		.is_some_and(|value| matches!(value, "accepted" | "duplicate"));

	if valid {
		Ok(())
	} else {
		Err(Error::new(format!("{step_name} receipt did not confirm success")))
	}
}

fn validate_verifier_record(record: &Value, step_name: &str) -> Result<()> {
	let valid = record.get("schema_version").and_then(Value::as_str)
		== Some("aiq.verifier-record.v2")
		&& record.get("inbox_id").and_then(Value::as_str).is_some_and(|value| !value.is_empty())
		&& record.get("idempotency_key").and_then(Value::as_str).is_some_and(valid_run_id)
		&& record.get("package_sha256").and_then(Value::as_str).is_some_and(valid_sha256)
		&& record.get("disposition").and_then(Value::as_str).is_some_and(|value| {
			matches!(value, "verified" | "rejected" | "lease_lost" | "retry" | "worker_error")
		}) && record.get("attempt").and_then(Value::as_u64).is_some_and(|value| value > 0);

	if valid {
		Ok(())
	} else {
		Err(Error::new(format!("{step_name} produced an invalid verifier record")))
	}
}

fn validate_verifier_receipt(
	record: &Value,
	expected: &VerifierPackageIdentity,
	step_name: &str,
) -> Result<()> {
	validate_verifier_record(record, step_name)?;

	match record.get("disposition").and_then(Value::as_str) {
		Some("verified") => {},
		Some("rejected") => {
			return Err(Error::verifier_rejection(format!(
				"{step_name} recorded a terminal verifier rejection"
			)));
		},
		_ => {
			return Err(Error::new(format!(
				"{step_name} verifier record did not confirm publication"
			)));
		},
	}

	if record.get("package_sha256").and_then(Value::as_str)
		!= Some(expected.package_sha256.as_str())
		|| record.get("idempotency_key").and_then(Value::as_str)
			!= Some(expected.idempotency_key.as_str())
	{
		return Err(Error::new(format!("{step_name} verified a different package identity")));
	}

	Ok(())
}

fn verifier_package_identity(path: &Path) -> Result<VerifierPackageIdentity> {
	if !existing_regular_file(path)? {
		return Err(Error::new(format!("Official package is absent: {}", path.display())));
	}

	let bytes =
		fs::read(path).context(format!("cannot read Official package {}", path.display()))?;
	let package: Value = serde_json::from_slice(&bytes)
		.context(format!("invalid Official package {}", path.display()))?;
	let idempotency_key = package
		.get("idempotency_key")
		.and_then(Value::as_str)
		.filter(|value| valid_run_id(value))
		.ok_or_else(|| Error::new("Official package has no valid idempotency identity"))?;
	let run_id = package
		.get("payload")
		.and_then(|payload| payload.get("run_id"))
		.and_then(Value::as_str)
		.ok_or_else(|| Error::new("Official package has no payload run identity"))?;

	if run_id != idempotency_key {
		return Err(Error::new("Official package idempotency and payload run identities differ"));
	}

	Ok(VerifierPackageIdentity {
		idempotency_key: idempotency_key.to_owned(),
		package_sha256: hex::encode(Sha256::digest(bytes)),
	})
}

fn retain_verifier_attempt(path: &Path, stdout: &[u8], step_name: &str) -> Result<()> {
	let record = parse_captured_record(stdout, step_name)?;

	validate_verifier_record(&record, step_name)?;

	let bytes = serde_json::to_vec(&record).context("cannot serialize verifier attempt")?;
	let mut attempts = open_append(path)?;

	attempts
		.write_all(&bytes)
		.context(format!("cannot append verifier attempt {}", path.display()))?;
	attempts
		.write_all(b"\n")
		.context(format!("cannot finish verifier attempt {}", path.display()))?;

	attempts.sync_all().context(format!("cannot sync verifier attempts {}", path.display()))
}

fn valid_run_id(value: &str) -> bool {
	value.len() == 68 && value.starts_with("run_") && valid_sha256(&value[4..])
}

fn valid_sha256(value: &str) -> bool {
	value.len() == 64
		&& value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn slot_paths(state_root: &Path, slot: &ScheduledSlot) -> SlotPaths {
	let root = state_root.join("slots").join(&slot.id);
	let speed_root = root.join("speed");
	let official_root = root.join("official");
	let state = official_root.join("state");
	let records = official_root.join("records");
	let verification = official_root.join("verification");

	SlotPaths {
		log: root.join("operator.log"),
		status: root.join("status.json"),
		speed: SpeedPaths {
			status: speed_root.join("status.json"),
			home: speed_root.join("codex-home"),
			artifacts: speed_root.join("artifacts"),
			workspace: speed_root.join("workspace"),
			checkpoints: speed_root.join("checkpoints"),
			batch: speed_root.join("batch.json"),
			receipt: speed_root.join("submission.json"),
			root: speed_root,
		},
		official: OfficialPaths {
			status: official_root.join("status.json"),
			home: official_root.join("codex-home"),
			artifacts: official_root.join("artifacts"),
			execution: official_root.join("execution"),
			admission: records.join("permission-admission.json"),
			preflight: state.join("preflight.json"),
			checkpoint: state.join("checkpoint.json"),
			run: state.join("run.json"),
			score: state.join("score.json"),
			package: state.join("package.json"),
			submission_receipt: state.join("submission.json"),
			environment: records.join("verifier-environment.json"),
			verifier_records: verification.join("records.jsonl"),
			verifier_attempts: verification.join("attempts.jsonl"),
			root: official_root,
			state,
			records,
			verification,
		},
		root,
	}
}

fn prepare_slot_directories(paths: &SlotPaths) -> Result<()> {
	for path in [
		&paths.root,
		&paths.speed.root,
		&paths.speed.artifacts,
		&paths.speed.workspace,
		&paths.speed.checkpoints,
		&paths.official.root,
		&paths.official.artifacts,
		&paths.official.execution,
		&paths.official.state,
		&paths.official.records,
		&paths.official.verification,
	] {
		private_directory(path)?;
	}

	private_directory(&paths.official.verification.join("replay"))
}

fn prepare_codex_home(home: &Path, auth_source: &Path) -> Result<()> {
	cleanup_codex_home(home)?;
	private_directory(home)?;

	let source = fs::symlink_metadata(auth_source)
		.context(format!("cannot inspect Codex authentication source {}", auth_source.display()))?;

	if source.file_type().is_symlink() || !source.is_file() {
		return Err(Error::new("Codex authentication source must be a non-symlink regular file"));
	}

	let target = home.join("auth.json");

	fs::copy(auth_source, &target).context("cannot copy isolated Codex authentication")?;
	#[cfg(unix)]
	fs::set_permissions(&target, Permissions::from_mode(0o600))
		.context("cannot protect isolated Codex authentication")?;

	#[cfg(target_os = "macos")]
	run_utility("/usr/bin/chflags", [OsStr::new("uchg"), target.as_os_str()])?;

	Ok(())
}

fn cleanup_codex_home(home: &Path) -> Result<()> {
	if !home.exists() {
		return Ok(());
	}

	#[cfg(target_os = "macos")]
	let auth = home.join("auth.json");

	#[cfg(target_os = "macos")]
	if auth.exists() {
		run_utility("/usr/bin/chflags", [OsStr::new("nouchg"), auth.as_os_str()])?;
	}

	remove_managed(home, home.parent().ok_or_else(|| Error::new("invalid Codex home"))?)
}

#[cfg(test)]
fn cleanup_terminal_state(paths: &SlotPaths) -> Result<()> {
	speed::cleanup(paths)?;

	official::cleanup_state(paths)
}

fn initialize_publication_statuses(paths: &SlotPaths, slot: &ScheduledSlot) -> Result<()> {
	for owner in [PublicationOwner::Speed, PublicationOwner::Official] {
		if read_publication_status(paths, owner)?.is_some() {
			continue;
		}

		let (phase, detail) = match owner {
			PublicationOwner::Speed if speed::is_published(paths)? => {
				("published", "Speed evidence published")
			},
			PublicationOwner::Speed if existing_regular_file(&paths.speed.batch)? => {
				("pending", "Speed submission is ready to resume")
			},
			PublicationOwner::Speed => ("pending", "Speed publication is pending"),
			PublicationOwner::Official if official::is_published(paths)? => {
				("published", "Official evidence published")
			},
			PublicationOwner::Official if official::run_is_complete(&paths.official.run)? => {
				("pending", "Official publication is ready to resume")
			},
			PublicationOwner::Official => ("pending", "Official publication is pending"),
		};

		write_publication_status(paths, slot, owner, phase, detail)?;
	}

	Ok(())
}

fn slot_status_value(paths: &SlotPaths, slot: &ScheduledSlot) -> Result<Option<Value>> {
	if paths.speed.status.exists() || paths.official.status.exists() {
		return serde_json::to_value(compose_status(paths, slot)?)
			.context("cannot serialize composed slot status")
			.map(Some);
	}
	if paths.status.exists() {
		return read_json_value(&paths.status, "slot status").map(Some);
	}

	Ok(None)
}

fn retained_phase(paths: &SlotPaths, slot: &ScheduledSlot) -> Result<Option<String>> {
	if paths.speed.status.exists() || paths.official.status.exists() {
		return compose_status(paths, slot).map(|status| Some(status.phase));
	}
	if !paths.status.exists() {
		return Ok(None);
	}

	let status: RetainedStatus = read_json(&paths.status, "slot status")?;

	Ok(Some(status.phase))
}

fn retained_current_terminal(paths: &SlotPaths, slot: &ScheduledSlot) -> Result<bool> {
	if paths.speed.status.exists() || paths.official.status.exists() {
		return Ok(retained_phase(paths, slot)?.as_deref().is_some_and(is_terminal_phase));
	}
	if !paths.status.exists() {
		return Ok(false);
	}

	let status: RetainedStatus = read_json(&paths.status, "slot status")?;

	Ok(status.schema_version == STATUS_SCHEMA && is_terminal_phase(&status.phase))
}

fn compose_status(paths: &SlotPaths, slot: &ScheduledSlot) -> Result<RetainedStatus> {
	let speed = read_publication_status(paths, PublicationOwner::Speed)?
		.unwrap_or(publication_pending(slot, PublicationOwner::Speed)?);
	let official = read_publication_status(paths, PublicationOwner::Official)?
		.unwrap_or(publication_pending(slot, PublicationOwner::Official)?);

	if speed.slot_id != slot.id || official.slot_id != slot.id {
		return Err(Error::new("publication status does not match its observation slot"));
	}

	let phase = compose_phase(&speed, &official);
	let detail = safe_detail(&format!(
		"Speed {}: {}; Official {}: {}",
		speed.phase, speed.detail, official.phase, official.detail,
	));

	Ok(RetainedStatus {
		schema_version: STATUS_SCHEMA.to_owned(),
		slot_id: slot.id.clone(),
		observed_at: slot.observed_at.clone(),
		phase: phase.to_owned(),
		detail,
		updated_at: now_string()?,
		speed: Some(speed),
		official: Some(official),
	})
}

fn compose_phase(speed: &PublicationStatus, official: &PublicationStatus) -> &'static str {
	if publication_is_running(speed) || publication_is_running(official) {
		return "running";
	}
	if official.phase == "waiting_for_subscription" {
		return "waiting_for_subscription";
	}
	if publication_is_retryable(speed) || publication_is_retryable(official) {
		return "retryable_failure";
	}
	if speed.phase == "published" && official.phase == "published" {
		return "complete";
	}
	if speed.phase == "published" {
		return "complete_with_unpublished_official";
	}
	if official.phase == "published" {
		return "complete_with_unpublished_speed";
	}
	if speed.phase == "missed_window" && official.phase == "missed_window" {
		return "missed_window";
	}

	"complete_with_unpublished_speed_and_official"
}

fn publication_is_running(status: &PublicationStatus) -> bool {
	!publication_is_terminal(status) && !publication_is_retryable(status)
}

fn publication_is_retryable(status: &PublicationStatus) -> bool {
	matches!(status.phase.as_str(), "retryable_failure" | "waiting_for_subscription")
}

fn publication_is_terminal(status: &PublicationStatus) -> bool {
	matches!(status.phase.as_str(), "published" | "unpublished" | "missed_window")
}

fn publication_pending(slot: &ScheduledSlot, owner: PublicationOwner) -> Result<PublicationStatus> {
	Ok(PublicationStatus {
		schema_version: PUBLICATION_STATUS_SCHEMA.to_owned(),
		owner: owner.value().to_owned(),
		slot_id: slot.id.clone(),
		phase: "pending".to_owned(),
		detail: format!("{} publication is pending", owner.label()),
		updated_at: now_string()?,
	})
}

fn read_publication_status(
	paths: &SlotPaths,
	owner: PublicationOwner,
) -> Result<Option<PublicationStatus>> {
	let path = publication_status_path(paths, owner);

	if !existing_regular_file(path)? {
		return Ok(None);
	}

	let status: PublicationStatus = read_json(path, "publication status")?;

	if status.schema_version != PUBLICATION_STATUS_SCHEMA || status.owner != owner.value() {
		return Err(Error::new(format!("invalid {} publication status identity", owner.label())));
	}

	Ok(Some(status))
}

fn publication_status_path(paths: &SlotPaths, owner: PublicationOwner) -> &Path {
	match owner {
		PublicationOwner::Speed => &paths.speed.status,
		PublicationOwner::Official => &paths.official.status,
	}
}

fn write_publication_status(
	paths: &SlotPaths,
	slot: &ScheduledSlot,
	owner: PublicationOwner,
	phase: &str,
	detail: &str,
) -> Result<()> {
	let document = PublicationStatus {
		schema_version: PUBLICATION_STATUS_SCHEMA.to_owned(),
		owner: owner.value().to_owned(),
		slot_id: slot.id.clone(),
		phase: phase.to_owned(),
		detail: safe_detail(detail),
		updated_at: now_string()?,
	};

	write_json_atomically(publication_status_path(paths, owner), &document, "publication status")
}

fn record_owner_failure(
	paths: &SlotPaths,
	slot: &ScheduledSlot,
	owner: PublicationOwner,
	error: &Error,
) -> Result<()> {
	let detail = safe_detail(&error.to_string());

	if let Some(status) = read_publication_status(paths, owner)?
		&& (publication_is_terminal(&status)
			|| (status.phase == "retryable_failure" && status.detail == detail))
	{
		return Ok(());
	}

	let event = match owner {
		PublicationOwner::Speed => "speed_failed",
		PublicationOwner::Official => "official_failed",
	};

	append_log(&paths.log, event, &detail)?;

	write_publication_status(paths, slot, owner, "retryable_failure", &detail)
}

fn write_composed_status(paths: &SlotPaths, slot: &ScheduledSlot) -> Result<()> {
	write_json_atomically(&paths.status, &compose_status(paths, slot)?, "slot status")
}

#[cfg(test)]
fn write_status(path: &Path, slot: &ScheduledSlot, phase: &str, detail: &str) -> Result<()> {
	let document = RetainedStatus {
		schema_version: LEGACY_STATUS_SCHEMA.to_owned(),
		slot_id: slot.id.clone(),
		observed_at: slot.observed_at.clone(),
		phase: phase.to_owned(),
		detail: safe_detail(detail),
		updated_at: now_string()?,
		speed: None,
		official: None,
	};

	write_json_atomically(path, &document, "slot status")
}

fn write_json_atomically<T>(path: &Path, document: &T, label: &str) -> Result<()>
where
	T: Serialize,
{
	let bytes = serde_json::to_vec_pretty(document).context(format!("cannot serialize {label}"))?;
	let temporary = path.with_extension(format!("json.new.{}", process::id()));

	if temporary.exists() {
		fs::remove_file(&temporary).context("cannot remove stale status staging file")?;
	}

	write_create_once(&temporary, &bytes)?;

	fs::rename(&temporary, path).context(format!("cannot atomically replace {label}"))
}

fn append_log(path: &Path, event: &str, detail: &str) -> Result<()> {
	let mut log = open_append(path)?;

	writeln!(log, "{} {event} {}", now_string()?, safe_detail(detail))
		.context("cannot append operator log")
}

fn open_append(path: &Path) -> Result<File> {
	let mut options = OpenOptions::new();

	options.append(true).create(true);
	#[cfg(unix)]
	options.mode(0o600).custom_flags(O_NOFOLLOW);

	options.open(path).context(format!("cannot open operator log {}", path.display()))
}

fn write_create_once(path: &Path, bytes: &[u8]) -> Result<()> {
	let mut options = OpenOptions::new();

	options.write(true).create_new(true);
	#[cfg(unix)]
	options.mode(0o600);

	let mut file = options.open(path).context(format!("cannot create {}", path.display()))?;

	file.write_all(bytes).context(format!("cannot write {}", path.display()))?;
	file.write_all(b"\n").context(format!("cannot finish {}", path.display()))?;

	file.sync_all().context(format!("cannot sync {}", path.display()))
}

fn existing_regular_file(path: &Path) -> Result<bool> {
	let metadata = match fs::symlink_metadata(path) {
		Ok(metadata) => metadata,
		Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
		Err(error) => {
			return Err(Error::new(format!("cannot inspect {}: {error}", path.display())));
		},
	};

	if metadata.file_type().is_symlink() || !metadata.is_file() {
		return Err(Error::new(format!(
			"managed output must be a non-symlink regular file: {}",
			path.display()
		)));
	}

	Ok(true)
}

fn private_directory(path: &Path) -> Result<()> {
	fs::create_dir_all(path)
		.context(format!("cannot create private directory {}", path.display()))?;

	let metadata = fs::symlink_metadata(path)
		.context(format!("cannot inspect private directory {}", path.display()))?;

	if metadata.file_type().is_symlink() || !metadata.is_dir() {
		return Err(Error::new(format!("private path is not a directory: {}", path.display())));
	}

	#[cfg(unix)]
	fs::set_permissions(path, Permissions::from_mode(0o700))
		.context(format!("cannot protect private directory {}", path.display()))?;

	Ok(())
}

fn remove_managed(path: &Path, parent: &Path) -> Result<()> {
	if path == parent || !path.starts_with(parent) {
		return Err(Error::new("refusing to remove a path outside managed slot state"));
	}

	let metadata = match fs::symlink_metadata(path) {
		Ok(metadata) => metadata,
		Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
		Err(error) => {
			return Err(Error::new(format!("cannot inspect {}: {error}", path.display())));
		},
	};

	if metadata.file_type().is_symlink() || metadata.is_file() {
		fs::remove_file(path).context(format!("cannot remove {}", path.display()))
	} else {
		fs::remove_dir_all(path).context(format!("cannot remove {}", path.display()))
	}
}

fn read_json<T>(path: &Path, label: &str) -> Result<T>
where
	T: for<'de> Deserialize<'de>,
{
	let bytes = fs::read(path).context(format!("cannot read {label} {}", path.display()))?;

	serde_json::from_slice(&bytes).context(format!("invalid {label} {}", path.display()))
}

fn read_json_value(path: &Path, label: &str) -> Result<Value> {
	read_json(path, label)
}

fn now_string() -> Result<String> {
	let milliseconds = current_unix_ms()?;

	Timestamp::from_millisecond(milliseconds)
		.context("current system time is outside the supported range")
		.map(|timestamp| timestamp.to_string())
}

fn current_unix_ms() -> Result<i64> {
	let milliseconds = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.context("current system time is before the Unix epoch")?
		.as_millis();

	i64::try_from(milliseconds).context("current system time is outside the supported range")
}

#[cfg(target_os = "macos")]
fn run_utility<I, S>(executable: &str, arguments: I) -> Result<()>
where
	I: IntoIterator<Item = S>,
	S: AsRef<OsStr>,
{
	let output = Command::new(executable)
		.args(arguments)
		.output()
		.context(format!("cannot start {executable}"))?;

	if output.status.success() {
		Ok(())
	} else {
		Err(Error::new(format!(
			"{executable} failed with status {}: {}",
			output.status,
			safe_detail(&String::from_utf8_lossy(&output.stderr))
		)))
	}
}

fn args<const N: usize>(values: [&str; N]) -> Vec<OsString> {
	values.into_iter().map(OsString::from).collect()
}

fn safe_detail(value: &str) -> String {
	value.replace(['\r', '\n'], " ").chars().take(1_000).collect::<String>()
}

#[cfg(test)]
mod tests {
	use std::process;
	use std::{
		collections::BTreeSet,
		env,
		ffi::{OsStr, OsString},
		fs,
		path::{Path, PathBuf},
	};

	use crate::{
		config::{CONFIG_SCHEMA, Configuration},
		credentials::RuntimeSecrets,
		lock::ProcessLock,
		release::ReleasePaths,
		schedule::{self},
		workflow::{
			self, CommandStep, PROTECTED_SECRETS, RetainedStatus, StepSecrets, official, speed,
		},
	};

	fn parent_environment() -> Vec<(OsString, OsString)> {
		let mut values = vec![
			(OsString::from("PATH"), OsString::from("/usr/bin")),
			(OsString::from("UNRELATED_SECRET"), OsString::from("do-not-forward")),
		];

		values
			.extend(PROTECTED_SECRETS.map(|name| (OsString::from(name), OsString::from("secret"))));

		values
	}

	fn write_test_official_package(
		paths: &workflow::SlotPaths,
		identity_byte: char,
	) -> workflow::VerifierPackageIdentity {
		let run_id = format!("run_{}", identity_byte.to_string().repeat(64));
		let package = serde_json::to_vec(&serde_json::json!({
			"idempotency_key": run_id.as_str(),
			"payload": { "run_id": run_id.as_str() },
		}))
		.expect("test Official package JSON");

		fs::write(&paths.official.package, package).expect("test Official package");

		workflow::verifier_package_identity(&paths.official.package)
			.expect("test Official package identity")
	}

	fn verifier_record(
		identity: &workflow::VerifierPackageIdentity,
		disposition: &str,
		attempt: u64,
	) -> String {
		serde_json::to_string(&serde_json::json!({
			"schema_version": "aiq.verifier-record.v2",
			"inbox_id": "223e4567-e89b-42d3-a456-426614174000",
			"idempotency_key": identity.idempotency_key.as_str(),
			"package_sha256": identity.package_sha256.as_str(),
			"disposition": disposition,
			"attempt": attempt,
		}))
		.expect("test verifier record")
	}

	fn verifier_command_step(
		paths: &workflow::SlotPaths,
		record: String,
		exit_code: u8,
	) -> CommandStep {
		CommandStep {
			name: "official_verify_publish",
			executable: PathBuf::from("/bin/sh"),
			args: vec![
				OsString::from("-c"),
				OsString::from("printf '%s\\n' \"$1\"; exit \"$2\""),
				OsString::from("aiq-test"),
				OsString::from(record),
				OsString::from(exit_code.to_string()),
			],
			output: paths.official.verifier_records.clone(),
			capture: Some(workflow::CaptureKind::Verifier),
			secrets: StepSecrets::None,
		}
	}

	fn verifier_attempt_records(path: &Path) -> Vec<serde_json::Value> {
		fs::read_to_string(path)
			.expect("verifier attempts")
			.lines()
			.map(|line| serde_json::from_str(line).expect("verifier attempt JSON"))
			.collect()
	}

	fn environment_names(secrets: StepSecrets) -> BTreeSet<String> {
		workflow::child_environment(parent_environment(), secrets, &RuntimeSecrets::test())
			.expect("child environment")
			.keys()
			.map(|name| name.to_string_lossy().into_owned())
			.collect()
	}

	fn command_argument<'a>(arguments: &'a [OsString], name: &str) -> &'a OsStr {
		let index = arguments
			.iter()
			.position(|argument| argument == name)
			.unwrap_or_else(|| panic!("missing command argument {name}"));

		arguments.get(index + 1).expect("command argument value")
	}

	#[test]
	fn production_command_plans_pass_distinct_corpus_and_target_sources() {
		let root = PathBuf::from("/controlled/release");
		let core = root.join("core-a");
		let release = ReleasePaths {
			runner: root.join("bin/aiq-runner"),
			verifier: root.join("bin/aiq-verifier"),
			codex: root.join("codex-runtime/codex"),
			tasks: core.join("tasks"),
			workspaces: core.join("baselines"),
			evaluator: core.join("evaluator"),
			runtime: core.join("toolchain/node"),
			toolchain: core.join("toolchain"),
			commitment: core.join("commitment.json"),
			corpus_source_snapshot: core.join("source-snapshot"),
			seal_receipt: core.join("receipt.json"),
			calibration_admission: root.join("calibration-policy-v2/admission-v3.json"),
			capabilities: root.join("official-r1/inputs/capabilities.json"),
			schedule: root.join("official-r1/inputs/schedule.json"),
			environment_generator: root
				.join("official-r1/records/generate-verifier-environment.mjs"),
			production_reference: root.join("records/production-reference.json"),
			build_receipt: root.join("records/final-build-receipt.v2.json"),
		};
		let configuration = Configuration {
			schema_version: CONFIG_SCHEMA.to_owned(),
			release_root: root,
			release_manifest_sha256: format!("sha256:{}", "a".repeat(64)),
			state_root: PathBuf::from("/controlled/state"),
			codex_auth_source: PathBuf::from("/controlled/auth.json"),
			endpoint: "https://aiq.wiki".to_owned(),
			official_jobs: 32,
			verifier_replay_jobs: 4,
			speed_jobs: 1,
			speed_trials: 1,
			unattended_secrets: None,
		};
		let slot = schedule::scheduled_slot("2026-08-10T03-00Z").expect("command-plan slot");
		let paths = workflow::slot_paths(&configuration.state_root, &slot);
		let target_source = PathBuf::from("/controlled/state/scratch/current-target/source");
		let runner_arguments =
			workflow::official_common_plan(&configuration, &release, &paths, &slot);
		let verifier_arguments = workflow::official_verifier_arguments(
			&configuration,
			&release,
			&format!("sha256:{}", "b".repeat(64)),
			&format!("sha256:{}", "c".repeat(64)),
			&paths,
			&target_source,
		);

		assert_eq!(
			command_argument(&runner_arguments, "--source-root"),
			release.corpus_source_snapshot.as_os_str()
		);
		assert_eq!(
			command_argument(&verifier_arguments, "--corpus-source-root"),
			release.corpus_source_snapshot.as_os_str()
		);
		assert_eq!(
			command_argument(&verifier_arguments, "--target-source-root"),
			target_source.as_os_str()
		);
		assert_ne!(release.corpus_source_snapshot, target_source);
		assert!(!verifier_arguments.iter().any(|argument| argument == "--source-root"));
	}

	#[test]
	fn child_environment_isolates_each_credential_boundary() {
		assert_eq!(environment_names(StepSecrets::None), BTreeSet::from(["PATH".to_owned()]));
		assert_eq!(
			environment_names(StepSecrets::RunnerSigning),
			BTreeSet::from(["AIQ_RUNNER_SIGNING_KEY".to_owned(), "PATH".to_owned()])
		);
		assert_eq!(
			environment_names(StepSecrets::RunnerSubmission),
			BTreeSet::from(["AIQ_RUNNER_SUBMISSION_TOKEN".to_owned(), "PATH".to_owned()])
		);
		assert_eq!(
			environment_names(StepSecrets::Verifier),
			BTreeSet::from([
				"AIQ_VERIFIER_INGRESS_TOKEN".to_owned(),
				"AIQ_VERIFIER_SIGNING_KEY".to_owned(),
				"PATH".to_owned(),
			])
		);
	}

	#[test]
	fn official_summary_preserves_non_semantic_failures() {
		let root = env::temp_dir().join(format!("aiq-summary-test-{}", process::id()));
		let _ = fs::remove_dir_all(&root);

		fs::create_dir_all(&root).expect("summary fixture root");

		let path = root.join("run.json");

		fs::write(
			&path,
			br#"{"results":[{"status":"completed","task_score":0.75},{"status":"failed","task_score":null,"failure":{"kind":"evaluator_failure"}},{"status":"failed","task_score":0.5,"failure":{"kind":"evaluator_failure"}}]}"#,
		)
		.expect("summary fixture");

		let summary = official::summarize_run(&path).expect("summary");

		assert_eq!(summary.total_results, 3);
		assert_eq!(summary.non_semantic_results, 2);
		assert_eq!(summary.failure_kinds.get("evaluator_failure"), Some(&2));

		fs::remove_dir_all(root).expect("remove summary fixture");
	}

	#[test]
	fn publication_status_composes_independent_owner_outcomes() {
		let root = env::temp_dir().join(format!("aiq-status-composition-test-{}", process::id()));
		let _ = fs::remove_dir_all(&root);
		let slot = schedule::scheduled_slot("2026-08-10T03-00Z").expect("status slot");
		let paths = workflow::slot_paths(&root, &slot);

		workflow::prepare_slot_directories(&paths).expect("status directories");
		workflow::write_publication_status(
			&paths,
			&slot,
			workflow::PublicationOwner::Speed,
			"published",
			"Speed evidence published",
		)
		.expect("Speed status");
		workflow::write_publication_status(
			&paths,
			&slot,
			workflow::PublicationOwner::Official,
			"retryable_failure",
			"Official infrastructure failed",
		)
		.expect("Official retry status");

		let retryable = workflow::compose_status(&paths, &slot).expect("retryable composition");

		assert_eq!(retryable.phase, "retryable_failure");
		assert_eq!(retryable.speed.as_ref().map(|status| status.phase.as_str()), Some("published"));
		assert_eq!(
			retryable.official.as_ref().map(|status| status.phase.as_str()),
			Some("retryable_failure")
		);

		workflow::write_publication_status(
			&paths,
			&slot,
			workflow::PublicationOwner::Official,
			"unpublished",
			"Official evidence retained",
		)
		.expect("Official terminal status");

		assert_eq!(
			workflow::compose_status(&paths, &slot).expect("terminal composition").phase,
			"complete_with_unpublished_official"
		);

		fs::remove_dir_all(root).expect("remove status fixture");
	}

	#[test]
	fn cleanup_rejects_the_managed_parent() {
		let parent = Path::new("/private/state/slots/example");

		assert!(workflow::remove_managed(parent, parent).is_err());
	}

	#[test]
	fn missing_release_creates_retryable_slot_state_before_secret_or_model_work() {
		let root = env::temp_dir().join(format!("aiq-missing-release-test-{}", process::id()));
		let _ = fs::remove_dir_all(&root);
		let configuration = Configuration {
			schema_version: CONFIG_SCHEMA.to_owned(),
			release_root: root.join("missing-release"),
			release_manifest_sha256: format!("sha256:{}", "a".repeat(64)),
			state_root: root.join("state"),
			codex_auth_source: root.join("missing-auth.json"),
			endpoint: "https://aiq.wiki".to_owned(),
			official_jobs: 1,
			verifier_replay_jobs: 1,
			speed_jobs: 1,
			speed_trials: 1,
			unattended_secrets: None,
		};
		let slots = schedule::current_surrounding_slots().expect("current slots");

		assert!(workflow::run(&configuration, Some(slots.latest.clone())).is_err());

		let retained: RetainedStatus = workflow::read_json(
			&workflow::slot_paths(&configuration.state_root, &slots.latest).status,
			"test slot status",
		)
		.expect("retained retry state");

		assert_eq!(retained.phase, "retryable_failure");
		assert!(retained.detail.contains("release root"));

		fs::remove_dir_all(root).expect("remove missing release fixture");
	}

	#[test]
	fn scheduled_run_coalesces_when_another_process_holds_the_lock() {
		let root = env::temp_dir().join(format!("aiq-coalesce-test-{}", process::id()));
		let _ = fs::remove_dir_all(&root);
		let state_root = root.join("state");
		let lock = ProcessLock::try_acquire(&state_root)
			.expect("observation lock")
			.expect("lock acquired");
		let configuration = Configuration {
			schema_version: CONFIG_SCHEMA.to_owned(),
			release_root: root.join("unused-release"),
			release_manifest_sha256: format!("sha256:{}", "a".repeat(64)),
			state_root,
			codex_auth_source: root.join("unused-auth.json"),
			endpoint: "https://aiq.wiki".to_owned(),
			official_jobs: 1,
			verifier_replay_jobs: 1,
			speed_jobs: 1,
			speed_trials: 1,
			unattended_secrets: None,
		};

		assert!(workflow::run(&configuration, None).is_ok());

		drop(lock);

		fs::remove_dir_all(root).expect("remove coalescing fixture");
	}

	#[test]
	fn expired_slot_resumes_each_owner_only_from_its_retained_output() {
		let root = env::temp_dir().join(format!("aiq-expired-slot-test-{}", process::id()));
		let _ = fs::remove_dir_all(&root);
		let expired = schedule::scheduled_slot("2026-08-10T03-00Z").expect("expired slot");
		let paths = workflow::slot_paths(&root, &expired);
		let after_window = expired.timestamp_ms + workflow::speed::DISPATCH_WINDOW_MILLISECONDS;

		assert_eq!(
			speed::dispatch(&expired, &paths, after_window).expect("closed Speed"),
			workflow::speed::Dispatch::Close
		);
		assert_eq!(
			official::dispatch(&expired, &paths, after_window).expect("closed Official"),
			workflow::official::Dispatch::Close
		);

		workflow::prepare_slot_directories(&paths).expect("expired fixture directories");
		fs::write(&paths.speed.batch, "completed Speed dispatch\n")
			.expect("completed Speed run fixture");

		assert_eq!(
			speed::dispatch(&expired, &paths, after_window).expect("Speed resume"),
			workflow::speed::Dispatch::ResumeSubmission
		);
		assert_eq!(
			official::dispatch(&expired, &paths, after_window).expect("Official remains closed"),
			workflow::official::Dispatch::Close
		);

		fs::remove_file(&paths.speed.batch).expect("remove Speed fixture");
		fs::write(
			&paths.official.run,
			serde_json::to_vec(&serde_json::json!({
				"schema_version": workflow::OFFICIAL_RUN_SCHEMA,
				"results": vec![serde_json::json!({}); workflow::OFFICIAL_RESULT_COUNT],
			}))
			.expect("complete Official fixture"),
		)
		.expect("completed Official run fixture");

		assert_eq!(
			official::dispatch(&expired, &paths, after_window).expect("Official resume"),
			workflow::official::Dispatch::ResumeAfterModel
		);
		assert_eq!(
			speed::dispatch(&expired, &paths, after_window).expect("Speed remains closed"),
			workflow::speed::Dispatch::Close
		);

		fs::remove_dir_all(root).expect("remove expired slot fixture");
	}

	#[test]
	fn expired_subscription_backpressure_slot_is_resumable_and_preferred() {
		let root =
			env::temp_dir().join(format!("aiq-subscription-recovery-test-{}", process::id()));
		let _ = fs::remove_dir_all(&root);
		let blocked = schedule::scheduled_slot("2026-08-10T03-00Z").expect("blocked slot");
		let latest = schedule::scheduled_slot("2026-08-11T15-00Z").expect("latest slot");
		let paths = workflow::slot_paths(&root, &blocked);
		let configuration = Configuration {
			schema_version: CONFIG_SCHEMA.to_owned(),
			release_root: root.join("unused-release"),
			release_manifest_sha256: format!("sha256:{}", "a".repeat(64)),
			state_root: root.clone(),
			codex_auth_source: root.join("unused-auth.json"),
			endpoint: "https://aiq.wiki".to_owned(),
			official_jobs: 32,
			verifier_replay_jobs: 1,
			speed_jobs: 1,
			speed_trials: 1,
			unattended_secrets: None,
		};

		workflow::prepare_slot_directories(&paths).expect("subscription slot directories");
		fs::write(
			&paths.official.checkpoint,
			serde_json::to_vec_pretty(&serde_json::json!({
				"schema_version": "aiq.run-checkpoint.v10",
				"in_flight": [],
				"pending_evaluations": [],
				"subscription_backpressure": {
					"schema_version": "aiq.subscription-backpressure.v1",
					"deferred_results": [],
				},
				"results": [{"status": "completed"}, {"status": "failed", "failure": {"kind": "evaluator_failure"}}],
			}))
			.expect("checkpoint JSON"),
		)
		.expect("subscription checkpoint fixture");
		workflow::write_status(
			&paths.status,
			&blocked,
			"waiting_for_subscription",
			"checkpoint retained",
		)
		.expect("subscription status");

		let state = official::paid_work_recovery_state(&paths.official.checkpoint)
			.expect("subscription state")
			.expect("subscription recovery");

		assert_eq!(state.completed_results, 2);
		assert_eq!(state.deferred_cells, workflow::OFFICIAL_RESULT_COUNT - 2);
		assert_eq!(state.pending_evaluations, 0);
		assert_eq!(
			official::dispatch(
				&blocked,
				&paths,
				blocked.timestamp_ms + workflow::OFFICIAL_DISPATCH_GRACE_MILLISECONDS,
			)
			.expect("late subscription recovery"),
			workflow::official::Dispatch::StartModel
		);
		assert_eq!(
			workflow::paid_work_recovery_slot(&configuration, &latest)
				.expect("selected recovery slot"),
			Some(blocked)
		);

		fs::remove_dir_all(root).expect("remove subscription recovery fixture");
	}

	#[test]
	fn interrupted_evaluator_checkpoint_remains_resumable_after_the_slot_window() {
		let root = env::temp_dir().join(format!("aiq-evaluator-recovery-test-{}", process::id()));
		let _ = fs::remove_dir_all(&root);
		let blocked = schedule::scheduled_slot("2026-08-10T03-00Z").expect("blocked slot");
		let paths = workflow::slot_paths(&root, &blocked);

		workflow::prepare_slot_directories(&paths).expect("evaluator recovery directories");
		fs::write(
			&paths.official.checkpoint,
			serde_json::to_vec_pretty(&serde_json::json!({
				"schema_version": "aiq.run-checkpoint.v10",
				"in_flight": [],
				"pending_evaluations": [{"schema_version": "aiq.pending-evaluation.v1"}],
				"subscription_backpressure": null,
				"results": [{"status": "completed"}],
			}))
			.expect("checkpoint JSON"),
		)
		.expect("evaluator recovery checkpoint");
		workflow::write_status(
			&paths.status,
			&blocked,
			"retryable_failure",
			"evaluator process interrupted",
		)
		.expect("evaluator recovery status");

		let state = official::paid_work_recovery_state(&paths.official.checkpoint)
			.expect("evaluator state")
			.expect("evaluator recovery");

		assert_eq!(state.pending_evaluations, 1);
		assert_eq!(
			official::dispatch(
				&blocked,
				&paths,
				blocked.timestamp_ms + workflow::OFFICIAL_DISPATCH_GRACE_MILLISECONDS,
			)
			.expect("late evaluator recovery"),
			workflow::official::Dispatch::StartModel
		);

		fs::remove_dir_all(root).expect("remove evaluator recovery fixture");
	}

	#[test]
	fn legacy_subscription_limit_checkpoint_is_recovered_from_retryable_state() {
		let root = env::temp_dir()
			.join(format!("aiq-legacy-subscription-recovery-test-{}", process::id()));
		let _ = fs::remove_dir_all(&root);
		let blocked = schedule::scheduled_slot("2026-08-10T03-00Z").expect("blocked slot");
		let latest = schedule::scheduled_slot("2026-08-10T15-00Z").expect("latest slot");
		let paths = workflow::slot_paths(&root, &blocked);
		let configuration = Configuration {
			schema_version: CONFIG_SCHEMA.to_owned(),
			release_root: root.join("unused-release"),
			release_manifest_sha256: format!("sha256:{}", "a".repeat(64)),
			state_root: root.clone(),
			codex_auth_source: root.join("unused-auth.json"),
			endpoint: "https://aiq.wiki".to_owned(),
			official_jobs: 32,
			verifier_replay_jobs: 1,
			speed_jobs: 1,
			speed_trials: 1,
			unattended_secrets: None,
		};

		workflow::prepare_slot_directories(&paths).expect("legacy slot directories");
		fs::write(
			&paths.official.checkpoint,
			serde_json::to_vec_pretty(&serde_json::json!({
				"schema_version": "aiq.run-checkpoint.v8",
				"in_flight": [],
				"results": [
					{"status": "completed"},
					{"status": "failed", "failure": {"kind": "subscription_limit"}},
				],
			}))
			.expect("legacy checkpoint JSON"),
		)
		.expect("legacy checkpoint fixture");
		workflow::write_status(
			&paths.status,
			&blocked,
			"retryable_failure",
			"legacy paid-run boundary failure",
		)
		.expect("legacy retryable status");

		let state = official::paid_work_recovery_state(&paths.official.checkpoint)
			.expect("legacy state")
			.expect("legacy subscription recovery");

		assert!(state.legacy_terminal_results);
		assert_eq!(state.completed_results, 1);
		assert_eq!(
			workflow::paid_work_recovery_slot(&configuration, &latest)
				.expect("selected legacy recovery slot"),
			Some(blocked)
		);

		fs::remove_dir_all(root).expect("remove legacy subscription fixture");
	}

	#[test]
	fn official_dispatch_starts_only_during_the_early_slot_grace() {
		let slot = schedule::scheduled_slot("2026-08-10T15-00Z").expect("dispatch slot");
		let grace = workflow::OFFICIAL_DISPATCH_GRACE_MILLISECONDS;

		assert!(
			!official::dispatch_window_is_open(&slot, slot.timestamp_ms - 1).expect("before slot")
		);
		assert!(official::dispatch_window_is_open(&slot, slot.timestamp_ms).expect("slot start"));
		assert!(
			official::dispatch_window_is_open(&slot, slot.timestamp_ms + grace - 1,)
				.expect("inside grace")
		);
		assert!(
			!official::dispatch_window_is_open(&slot, slot.timestamp_ms + grace,)
				.expect("closed grace")
		);
	}

	#[test]
	fn speed_dispatch_remains_open_after_the_official_grace() {
		let slot = schedule::scheduled_slot("2026-08-10T15-00Z").expect("dispatch slot");
		let root = env::temp_dir().join(format!("aiq-late-slot-test-{}", process::id()));
		let _ = fs::remove_dir_all(&root);
		let paths = workflow::slot_paths(&root, &slot);
		let now = slot.timestamp_ms + workflow::OFFICIAL_DISPATCH_GRACE_MILLISECONDS;

		workflow::prepare_slot_directories(&paths).expect("late slot directories");

		assert!(!official::dispatch_window_is_open(&slot, now).expect("closed dispatch window"));
		assert_eq!(
			official::dispatch(&slot, &paths, now).expect("closed late dispatch"),
			workflow::official::Dispatch::Close
		);
		assert_eq!(
			speed::dispatch(&slot, &paths, now).expect("independent Speed dispatch"),
			workflow::speed::Dispatch::Start
		);

		fs::write(&paths.speed.batch, "completed speed model output\n")
			.expect("speed model fixture");

		assert_eq!(
			official::dispatch(&slot, &paths, now).expect("speed-only late dispatch"),
			workflow::official::Dispatch::Close
		);
		assert_eq!(
			speed::dispatch(&slot, &paths, now).expect("model-free Speed resume"),
			workflow::speed::Dispatch::ResumeSubmission
		);

		fs::write(
			&paths.official.run,
			serde_json::to_vec(&serde_json::json!({
				"schema_version": workflow::OFFICIAL_RUN_SCHEMA,
				"results": vec![serde_json::json!({}); workflow::OFFICIAL_RESULT_COUNT],
			}))
			.expect("complete Official fixture"),
		)
		.expect("Official model fixture");

		assert_eq!(
			official::dispatch(&slot, &paths, now).expect("model-free late resume"),
			workflow::official::Dispatch::ResumeAfterModel
		);

		fs::remove_dir_all(root).expect("remove late slot fixture");
	}

	#[test]
	fn official_reservation_is_resumable_only_inside_the_dispatch_grace() {
		let slot = schedule::scheduled_slot("2026-08-10T15-00Z").expect("dispatch slot");
		let root = env::temp_dir().join(format!("aiq-reservation-test-{}", process::id()));
		let _ = fs::remove_dir_all(&root);
		let paths = workflow::slot_paths(&root, &slot);

		workflow::prepare_slot_directories(&paths).expect("reservation slot directories");
		fs::write(
			&paths.official.run,
			format!("AIQ_OFFICIAL_OUTPUT_RESERVED_V1 run_{}\n", "a".repeat(64)),
		)
		.expect("Official reservation fixture");

		assert!(!official::run_is_complete(&paths.official.run).expect("reservation"));
		assert_eq!(
			official::dispatch(&slot, &paths, slot.timestamp_ms).expect("early resume"),
			workflow::official::Dispatch::StartModel
		);
		assert_eq!(
			official::dispatch(
				&slot,
				&paths,
				slot.timestamp_ms + workflow::OFFICIAL_DISPATCH_GRACE_MILLISECONDS,
			)
			.expect("late reservation"),
			workflow::official::Dispatch::Close
		);

		fs::remove_dir_all(root).expect("remove reservation fixture");
	}

	#[test]
	fn official_dispatch_requires_full_supported_concurrency() {
		assert!(official::require_dispatch_capacity(32).is_ok());
		assert!(official::require_dispatch_capacity(31).is_err());
	}

	#[test]
	fn missed_window_is_terminal() {
		assert!(workflow::is_terminal_phase("complete"));
		assert!(workflow::is_terminal_phase("complete_with_unpublished_official"));
		assert!(workflow::is_terminal_phase("complete_with_unpublished_speed"));
		assert!(workflow::is_terminal_phase("complete_with_unpublished_speed_and_official"));
		assert!(workflow::is_terminal_phase("missed_window"));
		assert!(!workflow::is_terminal_phase("retryable_failure"));
		assert!(!workflow::is_terminal_phase("waiting_for_subscription"));
	}

	#[test]
	fn retry_skips_a_completed_create_once_step() {
		let root = env::temp_dir().join(format!("aiq-retry-test-{}", process::id()));
		let _ = fs::remove_dir_all(&root);
		let slot = schedule::scheduled_slot("2026-08-10T03-00Z").expect("retry slot");
		let paths = workflow::slot_paths(&root, &slot);

		workflow::prepare_slot_directories(&paths).expect("retry fixture directories");
		fs::write(&paths.speed.batch, "complete\n").expect("completed create-once output");

		let step = CommandStep {
			name: "must_not_run",
			executable: PathBuf::from("/usr/bin/false"),
			args: Vec::new(),
			output: paths.speed.batch.clone(),
			capture: None,
			secrets: StepSecrets::None,
		};

		workflow::run_create_once_step(
			&step,
			&paths,
			&slot,
			&RuntimeSecrets::test(),
			workflow::PublicationOwner::Speed,
		)
		.expect("completed step is skipped");
		fs::remove_dir_all(root).expect("remove retry fixture");
	}

	#[cfg(unix)]
	#[test]
	fn retry_replaces_a_truncated_captured_receipt() {
		let root = env::temp_dir().join(format!("aiq-receipt-retry-test-{}", process::id()));
		let _ = fs::remove_dir_all(&root);
		let slot = schedule::scheduled_slot("2026-08-10T03-00Z").expect("receipt retry slot");
		let paths = workflow::slot_paths(&root, &slot);

		workflow::prepare_slot_directories(&paths).expect("receipt retry fixture directories");
		fs::write(&paths.speed.receipt, br#"{"kind":"acc"#).expect("truncated receipt fixture");

		let step = CommandStep {
			name: "speed_submit",
			executable: PathBuf::from("/bin/sh"),
			args: vec![
				OsString::from("-c"),
				OsString::from(r#"printf '%s\n' '{"kind":"accepted"}'"#),
			],
			output: paths.speed.receipt.clone(),
			capture: Some(workflow::CaptureKind::Submission),
			secrets: StepSecrets::None,
		};

		workflow::run_create_once_step(
			&step,
			&paths,
			&slot,
			&RuntimeSecrets::test(),
			workflow::PublicationOwner::Speed,
		)
		.expect("truncated captured receipt is retried");

		assert!(
			workflow::submission_receipt_is_complete(&paths.speed.receipt)
				.expect("validated replacement receipt")
		);

		fs::remove_dir_all(root).expect("remove receipt retry fixture");
	}

	#[cfg(unix)]
	#[test]
	fn verifier_failure_attempt_is_retained_separately_from_later_success() {
		let root = env::temp_dir().join(format!("aiq-verifier-attempt-test-{}", process::id()));
		let _ = fs::remove_dir_all(&root);
		let slot = schedule::scheduled_slot("2026-08-10T03-00Z").expect("verifier retry slot");
		let paths = workflow::slot_paths(&root, &slot);

		workflow::prepare_slot_directories(&paths).expect("verifier retry directories");

		let identity = write_test_official_package(&paths, 'a');
		let retry = verifier_command_step(&paths, verifier_record(&identity, "retry", 1), 1);
		let error = workflow::run_create_once_step(
			&retry,
			&paths,
			&slot,
			&RuntimeSecrets::test(),
			workflow::PublicationOwner::Official,
		)
		.expect_err("retryable verifier attempt must remain unverified");

		assert!(error.to_string().contains("failed with status"));
		assert!(!paths.official.verifier_records.exists());
		assert_eq!(verifier_attempt_records(&paths.official.verifier_attempts).len(), 1);

		let retained_attempts = fs::read(&paths.official.verifier_attempts).expect("attempt bytes");

		fs::write(&paths.official.verifier_records, b"{\"disposition\":")
			.expect("incomplete verifier receipt fixture");

		let verified = verifier_command_step(&paths, verifier_record(&identity, "verified", 2), 0);

		workflow::run_create_once_step(
			&verified,
			&paths,
			&slot,
			&RuntimeSecrets::test(),
			workflow::PublicationOwner::Official,
		)
		.expect("later verifier success");

		assert!(
			workflow::verifier_receipt_is_complete(
				&paths.official.verifier_records,
				&paths.official.package,
			)
			.expect("verified receipt identity")
		);
		assert_eq!(
			fs::read(&paths.official.verifier_attempts).expect("retained attempt bytes"),
			retained_attempts
		);

		fs::remove_dir_all(root).expect("remove verifier retry fixture");
	}

	#[cfg(unix)]
	#[test]
	fn wrong_package_verifier_success_cannot_publish_the_slot() {
		let root =
			env::temp_dir().join(format!("aiq-wrong-verifier-package-test-{}", process::id()));
		let _ = fs::remove_dir_all(&root);
		let slot = schedule::scheduled_slot("2026-08-10T03-00Z").expect("identity slot");
		let paths = workflow::slot_paths(&root, &slot);

		workflow::prepare_slot_directories(&paths).expect("identity test directories");

		let _expected = write_test_official_package(&paths, 'a');
		let wrong = workflow::VerifierPackageIdentity {
			idempotency_key: format!("run_{}", "b".repeat(64)),
			package_sha256: "c".repeat(64),
		};
		let step = verifier_command_step(&paths, verifier_record(&wrong, "verified", 1), 0);
		let error = workflow::run_create_once_step(
			&step,
			&paths,
			&slot,
			&RuntimeSecrets::test(),
			workflow::PublicationOwner::Official,
		)
		.expect_err("wrong package receipt must fail closed");

		assert!(error.to_string().contains("different package identity"));
		assert!(!paths.official.verifier_records.exists());
		assert_eq!(verifier_attempt_records(&paths.official.verifier_attempts).len(), 1);

		fs::remove_dir_all(root).expect("remove identity test fixture");
	}

	#[cfg(unix)]
	#[test]
	fn verifier_rejection_keeps_its_terminal_classification() {
		let root = env::temp_dir().join(format!("aiq-verifier-rejection-test-{}", process::id()));
		let _ = fs::remove_dir_all(&root);
		let slot = schedule::scheduled_slot("2026-08-10T03-00Z").expect("rejection slot");
		let paths = workflow::slot_paths(&root, &slot);

		workflow::prepare_slot_directories(&paths).expect("rejection test directories");

		let identity = write_test_official_package(&paths, 'a');
		let step = verifier_command_step(&paths, verifier_record(&identity, "rejected", 1), 0);
		let error = workflow::run_create_once_step(
			&step,
			&paths,
			&slot,
			&RuntimeSecrets::test(),
			workflow::PublicationOwner::Official,
		)
		.expect_err("terminal verifier rejection");

		assert!(error.is_verifier_rejection());
		assert!(!paths.official.verifier_records.exists());
		assert_eq!(verifier_attempt_records(&paths.official.verifier_attempts).len(), 1);

		fs::remove_dir_all(root).expect("remove rejection test fixture");
	}

	#[cfg(unix)]
	#[test]
	fn verifier_retry_runs_only_post_model_steps() {
		let root = env::temp_dir().join(format!("aiq-verifier-no-model-test-{}", process::id()));
		let _ = fs::remove_dir_all(&root);
		let slot = schedule::scheduled_slot("2026-08-10T03-00Z").expect("post-model slot");
		let paths = workflow::slot_paths(&root, &slot);
		let model_invocation = root.join("model-invoked");

		workflow::prepare_slot_directories(&paths).expect("post-model directories");

		let identity = write_test_official_package(&paths, 'a');
		let mut steps = Vec::new();

		for (index, name) in
			["official_admit", "official_preflight", "official_run"].into_iter().enumerate()
		{
			steps.push(CommandStep {
				name,
				executable: PathBuf::from("/bin/sh"),
				args: vec![
					OsString::from("-c"),
					OsString::from("touch \"$1\""),
					OsString::from("aiq-test"),
					model_invocation.clone().into_os_string(),
				],
				output: root.join(format!("model-step-{index}")),
				capture: None,
				secrets: StepSecrets::None,
			});
		}
		for index in 0..4 {
			let output = root.join(format!("completed-post-model-step-{index}"));

			fs::write(&output, b"complete\n").expect("completed post-model fixture");

			steps.push(CommandStep {
				name: "completed_post_model_step",
				executable: PathBuf::from("/usr/bin/false"),
				args: Vec::new(),
				output,
				capture: None,
				secrets: StepSecrets::None,
			});
		}

		steps.push(verifier_command_step(&paths, verifier_record(&identity, "retry", 1), 1));

		assert!(
			official::run_steps_after_model(&steps, &paths, &slot, &RuntimeSecrets::test(),)
				.is_err()
		);
		assert!(!model_invocation.exists());
		assert!(paths.official.package.exists());
		assert_eq!(verifier_attempt_records(&paths.official.verifier_attempts).len(), 1);

		fs::remove_dir_all(root).expect("remove post-model fixture");
	}

	#[cfg(unix)]
	#[test]
	fn failed_command_output_is_removed_before_retry() {
		let root = env::temp_dir().join(format!("aiq-failed-output-test-{}", process::id()));
		let _ = fs::remove_dir_all(&root);
		let slot = schedule::scheduled_slot("2026-08-10T03-00Z").expect("failure slot");
		let paths = workflow::slot_paths(&root, &slot);

		workflow::prepare_slot_directories(&paths).expect("failure fixture directories");

		let step = CommandStep {
			name: "failing_step",
			executable: PathBuf::from("/bin/sh"),
			args: vec![
				OsString::from("-c"),
				OsString::from("printf 'failed\\n' > \"$1\"; exit 1"),
				OsString::from("aiq-test"),
				paths.speed.batch.clone().into_os_string(),
			],
			output: paths.speed.batch.clone(),
			capture: None,
			secrets: StepSecrets::None,
		};

		assert!(
			workflow::run_create_once_step(
				&step,
				&paths,
				&slot,
				&RuntimeSecrets::test(),
				workflow::PublicationOwner::Speed,
			)
			.is_err()
		);
		assert!(!paths.speed.batch.exists());

		fs::remove_dir_all(root).expect("remove failed output fixture");
	}

	#[cfg(unix)]
	#[test]
	fn official_subscription_exit_becomes_typed_backpressure() {
		let root = env::temp_dir().join(format!("aiq-subscription-exit-test-{}", process::id()));
		let _ = fs::remove_dir_all(&root);
		let slot = schedule::scheduled_slot("2026-08-10T03-00Z").expect("subscription slot");
		let paths = workflow::slot_paths(&root, &slot);

		workflow::prepare_slot_directories(&paths).expect("subscription fixture directories");

		let step = CommandStep {
			name: "official_run",
			executable: PathBuf::from("/bin/sh"),
			args: vec![OsString::from("-c"), OsString::from("exit 75")],
			output: paths.official.run.clone(),
			capture: None,
			secrets: StepSecrets::None,
		};
		let error = workflow::run_create_once_step(
			&step,
			&paths,
			&slot,
			&RuntimeSecrets::test(),
			workflow::PublicationOwner::Official,
		)
		.expect_err("subscription backpressure must stop the create-once step");

		assert!(error.is_subscription_backpressure());
		assert!(!paths.official.run.exists());

		fs::remove_dir_all(root).expect("remove subscription exit fixture");
	}

	#[cfg(unix)]
	#[test]
	fn failed_permission_admission_is_replaced_on_retry() {
		let root = env::temp_dir().join(format!("aiq-admission-retry-test-{}", process::id()));
		let _ = fs::remove_dir_all(&root);
		let slot = schedule::scheduled_slot("2026-08-10T03-00Z").expect("admission slot");
		let paths = workflow::slot_paths(&root, &slot);

		workflow::prepare_slot_directories(&paths).expect("admission fixture directories");
		fs::write(
			&paths.official.admission,
			br#"{"schema_version":"aiq.official-permission-admission.v2","official_permission_eligible":false,"model_invoked":false,"failure":"denied","plan":null}"#,
		)
		.expect("failed admission fixture");

		let step = CommandStep {
			name: "official_admit",
			executable: PathBuf::from("/bin/sh"),
			args: vec![
				OsString::from("-c"),
				OsString::from(
					r#"printf '%s\n' '{"schema_version":"aiq.official-permission-admission.v2","official_permission_eligible":true,"model_invoked":false,"failure":null,"plan":{}}' > "$1""#,
				),
				OsString::from("aiq-test"),
				paths.official.admission.clone().into_os_string(),
			],
			output: paths.official.admission.clone(),
			capture: None,
			secrets: StepSecrets::None,
		};

		workflow::run_create_once_step(
			&step,
			&paths,
			&slot,
			&RuntimeSecrets::test(),
			workflow::PublicationOwner::Official,
		)
		.expect("failed admission is retried");

		let admission =
			workflow::read_json_value(&paths.official.admission, "retried permission admission")
				.expect("retried admission JSON");

		assert_eq!(
			admission.get("official_permission_eligible").and_then(serde_json::Value::as_bool),
			Some(true)
		);

		fs::remove_dir_all(root).expect("remove admission retry fixture");
	}

	#[test]
	fn terminal_cleanup_keeps_compact_evidence_and_removes_scratch() {
		let root = env::temp_dir().join(format!("aiq-cleanup-test-{}", process::id()));
		let _ = fs::remove_dir_all(&root);
		let slot = schedule::scheduled_slot("2026-08-10T15-00Z").expect("cleanup slot");
		let paths = workflow::slot_paths(&root, &slot);

		workflow::prepare_slot_directories(&paths).expect("cleanup fixture directories");

		for path in [
			&paths.speed.batch,
			&paths.speed.receipt,
			&paths.official.run,
			&paths.official.package,
			&paths.official.verifier_records,
			&paths.official.verifier_attempts,
			&paths.official.checkpoint,
		] {
			fs::write(path, "evidence\n").expect("cleanup fixture file");
		}

		workflow::cleanup_terminal_state(&paths).expect("terminal cleanup");

		for retained in [
			&paths.speed.batch,
			&paths.speed.receipt,
			&paths.official.run,
			&paths.official.package,
			&paths.official.verifier_records,
			&paths.official.verifier_attempts,
		] {
			assert!(retained.exists());
		}
		for removed in [
			&paths.speed.workspace,
			&paths.speed.artifacts,
			&paths.speed.checkpoints,
			&paths.official.execution,
			&paths.official.artifacts,
			&paths.official.checkpoint,
		] {
			assert!(!removed.exists());
		}

		fs::remove_dir_all(root).expect("remove cleanup fixture");
	}
}
