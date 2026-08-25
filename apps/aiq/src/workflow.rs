//! End-to-end observation workflow.

/// Protected runtime secret names.
pub use crate::credentials::PROTECTED_SECRETS;

use std::fs::Permissions;
use std::io::ErrorKind;
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};
use std::process;
#[cfg(target_os = "macos")]
use std::process::Command;
use std::{
	collections::BTreeMap,
	env,
	ffi::{OsStr, OsString},
	fs::{self, File, OpenOptions},
	io::Write as _,
	path::{Path, PathBuf},
	process::{Output, Stdio},
	time::{SystemTime, UNIX_EPOCH},
};

use jiff::Timestamp;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
	Error, Result, ResultContext,
	config::Configuration,
	credentials::RuntimeSecrets,
	lock::ProcessLock,
	release::{Release, ReleasePaths},
	schedule::{self, ScheduledSlot, SurroundingSlots},
	supervisor,
};

const STATUS_SCHEMA: &str = "aiq.continuous-observation-status.v2";
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
enum OfficialDispatch {
	StartModel,
	ResumeAfterModel,
	Close,
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
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct RetainedStatus {
	schema_version: String,
	slot_id: String,
	observed_at: String,
	phase: String,
	detail: String,
	updated_at: String,
}

#[derive(Debug, Serialize)]
struct ScheduleStatus {
	schema_version: &'static str,
	checked_at: String,
	latest_slot: ScheduledSlot,
	latest_slot_state: Option<Value>,
	next_slot: ScheduledSlot,
}

#[derive(Debug)]
struct OfficialRunSummary {
	total_results: usize,
	non_semantic_results: usize,
	failure_kinds: BTreeMap<String, usize>,
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

	if retained_phase(&paths.status)?.as_deref().is_some_and(is_terminal_phase) {
		cleanup_codex_home(&paths.speed.home)?;
		cleanup_codex_home(&paths.official.home)?;

		return Ok(());
	}

	write_status(&paths.status, &slot, "validating_release", "running")?;

	let result = if !slot_can_continue(&slot, &slots.latest, &paths)? {
		close_expired_slot(configuration, &slot, &paths)
	} else {
		run_locked(configuration, &slot, &paths)
	};

	if let Err(error) = &result {
		if error.is_subscription_backpressure()
			&& let Some(state) = paid_work_recovery_state(&paths.official.checkpoint)?
		{
			let detail = format!(
				"subscription capacity unavailable; retained {} completed result(s); {} cell(s) deferred for scheduled resume",
				state.completed_results, state.deferred_cells,
			);

			append_log(&paths.log, "slot_waiting", &detail)?;
			write_status(&paths.status, &slot, "waiting_for_subscription", &detail)?;

			return Ok(());
		}

		let detail = safe_detail(&error.to_string());

		append_log(&paths.log, "slot_failed", &detail)?;
		write_status(&paths.status, &slot, "retryable_failure", &detail)?;
	}

	result
}

fn is_terminal_phase(phase: &str) -> bool {
	matches!(
		phase,
		"complete"
			| "complete_with_unpublished_official"
			| "complete_with_unpublished_speed"
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
		let Some(phase) = retained_phase(&paths.status)? else { continue };
		let Some(state) = paid_work_recovery_state(&paths.official.checkpoint)? else {
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

fn paid_work_recovery_state(path: &Path) -> Result<Option<PaidWorkRecoveryState>> {
	if !existing_regular_file(path)? {
		return Ok(None);
	}

	let checkpoint = read_json_value(path, "Official checkpoint")?;
	let schema = checkpoint.get("schema_version").and_then(Value::as_str);
	let Some(in_flight) = checkpoint.get("in_flight").and_then(Value::as_array) else {
		return Ok(None);
	};
	let Some(results) = checkpoint.get("results").and_then(Value::as_array) else {
		return Ok(None);
	};
	let pending_evaluations =
		checkpoint.get("pending_evaluations").and_then(Value::as_array).map_or(0, Vec::len);

	if (!in_flight.is_empty() && pending_evaluations == 0) || results.len() > OFFICIAL_RESULT_COUNT
	{
		return Ok(None);
	}
	if results.iter().any(|result| {
		matches!(
			result.get("failure").and_then(|failure| failure.get("kind")).and_then(Value::as_str),
			Some("authentication" | "workspace_integrity")
		)
	}) {
		return Ok(None);
	}

	let legacy_limit_results = results
		.iter()
		.filter(|result| {
			result.get("failure").and_then(|failure| failure.get("kind")).and_then(Value::as_str)
				== Some("subscription_limit")
		})
		.count();
	let legacy_terminal_results =
		schema == Some("aiq.run-checkpoint.v8") && legacy_limit_results > 0;
	let current_backpressure =
		matches!(schema, Some("aiq.run-checkpoint.v10" | "aiq.run-checkpoint.v9"))
			&& checkpoint.get("subscription_backpressure").is_some_and(Value::is_object);

	if !legacy_terminal_results && !current_backpressure && pending_evaluations == 0 {
		return Ok(None);
	}

	let completed_results = results.len().saturating_sub(legacy_limit_results);

	Ok(Some(PaidWorkRecoveryState {
		completed_results,
		deferred_cells: OFFICIAL_RESULT_COUNT.saturating_sub(completed_results),
		legacy_terminal_results,
		pending_evaluations,
	}))
}

fn slot_can_continue(
	slot: &ScheduledSlot,
	latest: &ScheduledSlot,
	paths: &SlotPaths,
) -> Result<bool> {
	Ok(slot.timestamp_ms >= latest.timestamp_ms
		|| official_run_is_complete(&paths.official.run)?
		|| existing_regular_file(&paths.speed.batch)?
		|| paid_work_recovery_state(&paths.official.checkpoint)?.is_some())
}

fn close_expired_slot(
	configuration: &Configuration,
	slot: &ScheduledSlot,
	paths: &SlotPaths,
) -> Result<()> {
	let release =
		Release::open(&configuration.release_root, &configuration.release_manifest_sha256)?;
	let speed_published = speed_is_published(paths)?;

	cleanup_terminal(&release, configuration, slot, paths)?;

	let (phase, detail) = if speed_published {
		(
			"complete_with_unpublished_official",
			"Speed evidence published; Official dispatch window closed before task execution",
		)
	} else {
		("missed_window", "observation window closed before Official task dispatch")
	};

	append_log(&paths.log, "slot_terminal", detail)?;

	write_status(&paths.status, slot, phase, detail)
}

fn close_late_official_dispatch(
	release: &Release,
	configuration: &Configuration,
	slot: &ScheduledSlot,
	paths: &SlotPaths,
) -> Result<()> {
	let speed_published = speed_is_published(paths)?;
	let (phase, detail) = if speed_published {
		(
			"complete_with_unpublished_official",
			"Speed evidence published; Official dispatch grace elapsed before a complete run",
		)
	} else {
		("missed_window", "observation dispatch grace elapsed before model work")
	};

	cleanup_terminal(release, configuration, slot, paths)?;
	append_log(&paths.log, "slot_terminal", detail)?;

	write_status(&paths.status, slot, phase, detail)
}

fn speed_is_published(paths: &SlotPaths) -> Result<bool> {
	Ok(existing_regular_file(&paths.speed.batch)?
		&& captured_receipt_is_complete(&paths.speed.receipt, CaptureKind::Submission)?)
}

fn official_dispatch_window_is_open(slot: &ScheduledSlot, now_unix_ms: i64) -> Result<bool> {
	let deadline = slot
		.timestamp_ms
		.checked_add(OFFICIAL_DISPATCH_GRACE_MILLISECONDS)
		.ok_or_else(|| Error::new("Official dispatch deadline is outside the supported range"))?;

	Ok(now_unix_ms >= slot.timestamp_ms && now_unix_ms < deadline)
}

fn official_dispatch(
	slot: &ScheduledSlot,
	paths: &SlotPaths,
	now_unix_ms: i64,
) -> Result<OfficialDispatch> {
	if official_run_is_complete(&paths.official.run)? {
		Ok(OfficialDispatch::ResumeAfterModel)
	} else if paid_work_recovery_state(&paths.official.checkpoint)?.is_some()
		|| official_dispatch_window_is_open(slot, now_unix_ms)?
	{
		Ok(OfficialDispatch::StartModel)
	} else {
		Ok(OfficialDispatch::Close)
	}
}

fn speed_can_continue(slot: &ScheduledSlot, paths: &SlotPaths, now_unix_ms: i64) -> Result<bool> {
	Ok(existing_regular_file(&paths.speed.batch)?
		|| official_dispatch_window_is_open(slot, now_unix_ms)?)
}

fn require_official_dispatch_capacity(official_jobs: u8) -> Result<()> {
	if official_jobs == REQUIRED_OFFICIAL_JOBS {
		Ok(())
	} else {
		Err(Error::new(format!(
			"official_jobs must be {REQUIRED_OFFICIAL_JOBS} before Official model work",
		)))
	}
}

fn status_at(configuration: &Configuration, slots: SurroundingSlots) -> Result<Value> {
	let paths = slot_paths(&configuration.state_root, &slots.latest);
	let latest_slot_state = if paths.status.exists() {
		Some(read_json_value(&paths.status, "slot status")?)
	} else {
		None
	};

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
		Release::open(&configuration.release_root, &configuration.release_manifest_sha256)?;

	if speed_is_published(paths)?
		&& captured_receipt_is_complete(&paths.official.verifier_records, CaptureKind::Verifier)?
	{
		cleanup_terminal(&release, configuration, slot, paths)?;
		write_status(&paths.status, slot, "complete", "already complete")?;

		return Ok(());
	}

	let dispatch = official_dispatch(slot, paths, current_unix_ms()?)?;

	if dispatch == OfficialDispatch::Close {
		if existing_regular_file(&paths.speed.batch)? && !speed_is_published(paths)? {
			let secrets = RuntimeSecrets::resolve(configuration)?;

			run_speed(configuration, release.paths(), paths, slot, &secrets)?;
		}

		return close_late_official_dispatch(&release, configuration, slot, paths);
	}
	if dispatch == OfficialDispatch::StartModel {
		require_official_dispatch_capacity(configuration.official_jobs)?;
	}

	let secrets = RuntimeSecrets::resolve(configuration)?;
	let source = release.prepare_source(&configuration.state_root, slot)?;
	let dispatch = if dispatch == OfficialDispatch::StartModel {
		official_dispatch(slot, paths, current_unix_ms()?)?
	} else {
		dispatch
	};

	if dispatch == OfficialDispatch::Close {
		return close_late_official_dispatch(&release, configuration, slot, paths);
	}

	let summary = match dispatch {
		OfficialDispatch::StartModel => {
			run_official(configuration, &release, paths, slot, &source, &secrets)?
		},
		OfficialDispatch::ResumeAfterModel => {
			run_official_after_model(configuration, &release, paths, slot, &source, &secrets)?
		},
		OfficialDispatch::Close => {
			unreachable!("closed dispatch handled before source preparation")
		},
	};

	if speed_can_continue(slot, paths, current_unix_ms()?)? {
		run_speed(configuration, release.paths(), paths, slot, &secrets)?;
	}

	let speed_published = speed_is_published(paths)?;

	if summary.non_semantic_results > 0 {
		cleanup_terminal(&release, configuration, slot, paths)?;
		write_status(
			&paths.status,
			slot,
			"complete_with_unpublished_official",
			&unpublished_detail(&summary, speed_published),
		)?;

		return Ok(());
	}

	cleanup_terminal(&release, configuration, slot, paths)?;

	if speed_published {
		write_status(&paths.status, slot, "complete", "speed and Official evidence published")
	} else {
		write_status(
			&paths.status,
			slot,
			"complete_with_unpublished_speed",
			"Official evidence published; speed observation was not started after its dispatch grace",
		)
	}
}

fn run_speed(
	configuration: &Configuration,
	release: &ReleasePaths,
	paths: &SlotPaths,
	slot: &ScheduledSlot,
	secrets: &RuntimeSecrets,
) -> Result<()> {
	if existing_regular_file(&paths.speed.batch)? {
		cleanup_codex_home(&paths.speed.home)?;
	} else {
		prepare_codex_home(&paths.speed.home, &configuration.codex_auth_source)?;
	}

	let result = speed_steps(configuration, release, paths, slot)
		.iter()
		.try_for_each(|step| run_create_once_step(step, paths, slot, secrets));
	let home_cleanup = cleanup_codex_home(&paths.speed.home);

	result.and(home_cleanup)?;

	cleanup_speed(paths)
}

fn run_official_after_model(
	configuration: &Configuration,
	release: &Release,
	paths: &SlotPaths,
	slot: &ScheduledSlot,
	source: &Path,
	secrets: &RuntimeSecrets,
) -> Result<OfficialRunSummary> {
	cleanup_codex_home(&paths.official.home)?;

	let summary = summarize_official_run(&paths.official.run)?;

	if summary.non_semantic_results > 0 {
		return Ok(summary);
	}

	let steps = official_steps(configuration, release, paths, slot, source);

	for step in steps.iter().skip(3) {
		run_create_once_step(step, paths, slot, secrets)?;
	}

	summarize_official_run(&paths.official.run)
}

fn run_official(
	configuration: &Configuration,
	release: &Release,
	paths: &SlotPaths,
	slot: &ScheduledSlot,
	source: &Path,
	secrets: &RuntimeSecrets,
) -> Result<OfficialRunSummary> {
	prepare_codex_home(&paths.official.home, &configuration.codex_auth_source)?;

	let steps = official_steps(configuration, release, paths, slot, source);
	let result = (|| {
		for step in &steps {
			run_create_once_step(step, paths, slot, secrets)?;

			if step.name == "official_run" {
				let summary = summarize_official_run(&paths.official.run)?;

				if summary.non_semantic_results > 0 {
					return Ok(summary);
				}
			}
		}

		summarize_official_run(&paths.official.run)
	})();
	let home_cleanup = cleanup_codex_home(&paths.official.home);

	match (result, home_cleanup) {
		(Err(error), _) | (Ok(_), Err(error)) => Err(error),
		(Ok(summary), Ok(())) => Ok(summary),
	}
}

fn speed_steps(
	configuration: &Configuration,
	release: &ReleasePaths,
	paths: &SlotPaths,
	slot: &ScheduledSlot,
) -> [CommandStep; 2] {
	let observe = CommandStep {
		name: "speed_observe",
		executable: release.runner.clone(),
		args: args([
			"observe-speed",
			"--corpus-commitment",
			release.commitment.to_string_lossy().as_ref(),
			"--evaluator-runtime",
			release.runtime.to_string_lossy().as_ref(),
			"--codex-toolchain-root",
			release.toolchain.to_string_lossy().as_ref(),
			"--codex-binary",
			release.codex.to_string_lossy().as_ref(),
			"--codex-home",
			paths.speed.home.to_string_lossy().as_ref(),
			"--artifact-root",
			paths.speed.artifacts.to_string_lossy().as_ref(),
			"--workspace-root",
			paths.speed.workspace.to_string_lossy().as_ref(),
			"--checkpoint-root",
			paths.speed.checkpoints.to_string_lossy().as_ref(),
			"--observed-at",
			&slot.observed_at,
			"--trials",
			&configuration.speed_trials.to_string(),
			"--jobs",
			&configuration.speed_jobs.to_string(),
			"--output",
			paths.speed.batch.to_string_lossy().as_ref(),
		]),
		output: paths.speed.batch.clone(),
		capture: None,
		secrets: StepSecrets::None,
	};
	let submit = CommandStep {
		name: "speed_submit",
		executable: release.runner.clone(),
		args: args([
			"submit-speed",
			"--observation",
			paths.speed.batch.to_string_lossy().as_ref(),
			"--endpoint",
			&configuration.endpoint,
		]),
		output: paths.speed.receipt.clone(),
		capture: Some(CaptureKind::Submission),
		secrets: StepSecrets::RunnerSubmission,
	};

	[observe, submit]
}

fn official_steps(
	configuration: &Configuration,
	release: &Release,
	paths: &SlotPaths,
	slot: &ScheduledSlot,
	source: &Path,
) -> [CommandStep; 8] {
	[
		official_admission_step(configuration, release.paths(), paths, slot, source),
		official_preflight_step(release.paths(), paths),
		official_run_step(configuration, release.paths(), paths, slot, source),
		official_score_step(release.paths(), paths),
		official_package_step(configuration, release.paths(), paths),
		official_submit_step(configuration, release.paths(), paths),
		official_environment_step(release.paths(), paths),
		official_verifier_step(configuration, release, paths, source),
	]
}

fn official_common_plan(
	configuration: &Configuration,
	release: &ReleasePaths,
	paths: &SlotPaths,
	slot: &ScheduledSlot,
	source: &Path,
) -> Vec<OsString> {
	args([
		"--hidden-tasks",
		release.tasks.to_string_lossy().as_ref(),
		"--corpus-commitment",
		release.commitment.to_string_lossy().as_ref(),
		"--source-root",
		source.to_string_lossy().as_ref(),
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
	source: &Path,
) -> CommandStep {
	let mut command_args = vec![OsString::from("admit-permissions")];

	command_args.extend(official_common_plan(configuration, release, paths, slot, source));
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
	source: &Path,
) -> CommandStep {
	let mut command_args = vec![OsString::from("run")];

	command_args.extend(official_common_plan(configuration, release, paths, slot, source));
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
	source: &Path,
) -> CommandStep {
	let runtime = release.paths();

	CommandStep {
		name: "official_verify_publish",
		executable: runtime.verifier.clone(),
		args: args([
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
			"--source-root",
			source.to_string_lossy().as_ref(),
			"--runner-binary",
			runtime.runner.to_string_lossy().as_ref(),
			"--codex-binary",
			runtime.codex.to_string_lossy().as_ref(),
			"--production-reference",
			runtime.production_reference.to_string_lossy().as_ref(),
			"--expected-production-reference-sha256",
			release.production_reference_sha256(),
			"--build-receipt",
			runtime.build_receipt.to_string_lossy().as_ref(),
			"--expected-build-receipt-sha256",
			release.build_receipt_sha256(),
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
		]),
		output: paths.official.verifier_records.clone(),
		capture: Some(CaptureKind::Verifier),
		secrets: StepSecrets::Verifier,
	}
}

fn run_create_once_step(
	step: &CommandStep,
	paths: &SlotPaths,
	slot: &ScheduledSlot,
	secrets: &RuntimeSecrets,
) -> Result<()> {
	if existing_regular_file(&step.output)? {
		if existing_step_output_is_complete(step)? {
			return Ok(());
		}

		remove_failed_step_output(&step.output)?;
		append_log(&paths.log, "step_retrying", step.name)?;
	}

	write_status(&paths.status, slot, step.name, "running")?;

	let stdout = match run_command(step, &paths.log, secrets) {
		Ok(stdout) => stdout,
		Err(error) => {
			remove_failed_step_output(&step.output).map_err(|cleanup| {
				Error::new(format!("{error}; cannot remove failed {} output: {cleanup}", step.name))
			})?;

			return Err(error);
		},
	};

	if let Some(kind) = step.capture {
		let record: Value = serde_json::from_slice(&stdout)
			.context(format!("{} did not produce a valid JSON receipt", step.name))?;

		validate_receipt(&record, kind, step.name)?;
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

fn existing_step_output_is_complete(step: &CommandStep) -> Result<bool> {
	if let Some(kind) = step.capture {
		return captured_receipt_is_complete(&step.output, kind);
	}

	if step.name == "official_run" {
		return official_run_is_complete(&step.output);
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

fn captured_receipt_is_complete(path: &Path, kind: CaptureKind) -> Result<bool> {
	if !existing_regular_file(path)? {
		return Ok(false);
	}

	let bytes =
		fs::read(path).context(format!("cannot read captured receipt {}", path.display()))?;
	let Ok(record) = serde_json::from_slice::<Value>(&bytes) else {
		return Ok(false);
	};

	Ok(validate_receipt(&record, kind, "captured receipt").is_ok())
}

fn official_run_is_complete(path: &Path) -> Result<bool> {
	if !existing_regular_file(path)? {
		return Ok(false);
	}

	let bytes = fs::read(path).context(format!("cannot read Official run {}", path.display()))?;
	let Ok(document) = serde_json::from_slice::<Value>(&bytes) else {
		return Ok(false);
	};

	Ok(document.get("schema_version").and_then(Value::as_str) == Some(OFFICIAL_RUN_SCHEMA)
		&& document.get("results").and_then(Value::as_array).map(Vec::len)
			== Some(OFFICIAL_RESULT_COUNT))
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

fn run_command(step: &CommandStep, log_path: &Path, secrets: &RuntimeSecrets) -> Result<Vec<u8>> {
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
			return Err(Error::subscription_backpressure(
				"Official subscription capacity is unavailable; checkpoint retained",
			));
		}

		let detail = if step.capture.is_some() {
			safe_detail(&String::from_utf8_lossy(&output.stderr))
		} else {
			"see operator log".to_owned()
		};

		return Err(Error::new(format!(
			"{} failed with status {}: {detail}",
			step.name, output.status
		)));
	}

	append_log(log_path, "step_completed", step.name)?;

	Ok(output.stdout)
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

fn validate_receipt(record: &Value, kind: CaptureKind, step_name: &str) -> Result<()> {
	let valid = match kind {
		CaptureKind::Submission => record
			.get("package")
			.and_then(|package| package.get("kind"))
			.or_else(|| record.get("kind"))
			.and_then(Value::as_str)
			.is_some_and(|value| matches!(value, "accepted" | "duplicate")),
		CaptureKind::Verifier => {
			record.get("disposition").and_then(Value::as_str) == Some("verified")
		},
	};

	if valid {
		Ok(())
	} else {
		Err(Error::new(format!("{step_name} receipt did not confirm success")))
	}
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
			home: speed_root.join("codex-home"),
			artifacts: speed_root.join("artifacts"),
			workspace: speed_root.join("workspace"),
			checkpoints: speed_root.join("checkpoints"),
			batch: speed_root.join("batch.json"),
			receipt: speed_root.join("submission.json"),
			root: speed_root,
		},
		official: OfficialPaths {
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

fn cleanup_speed(paths: &SlotPaths) -> Result<()> {
	cleanup_codex_home(&paths.speed.home)?;

	for path in [&paths.speed.workspace, &paths.speed.artifacts, &paths.speed.checkpoints] {
		remove_managed(path, &paths.speed.root)?;
	}

	Ok(())
}

fn cleanup_terminal(
	release: &Release,
	configuration: &Configuration,
	slot: &ScheduledSlot,
	paths: &SlotPaths,
) -> Result<()> {
	cleanup_terminal_state(paths)?;

	release.cleanup_source(&configuration.state_root, slot)
}

fn cleanup_terminal_state(paths: &SlotPaths) -> Result<()> {
	cleanup_speed(paths)?;
	cleanup_codex_home(&paths.official.home)?;

	for path in [&paths.official.execution, &paths.official.artifacts] {
		remove_managed(path, &paths.official.root)?;
	}

	remove_managed(&paths.official.verification.join("replay"), &paths.official.verification)?;

	remove_managed(&paths.official.checkpoint, &paths.official.state)
}

fn summarize_official_run(path: &Path) -> Result<OfficialRunSummary> {
	let document = read_json_value(path, "Official run")?;
	let results = document
		.get("results")
		.and_then(Value::as_array)
		.filter(|results| !results.is_empty())
		.ok_or_else(|| Error::new("Official run results are empty or invalid"))?;
	let mut non_semantic_results = 0;
	let mut failure_kinds = BTreeMap::new();

	for result in results {
		let semantic = result.get("status").and_then(Value::as_str) == Some("completed")
			&& result
				.get("task_score")
				.and_then(Value::as_f64)
				.is_some_and(|score| score.is_finite() && (0.0..=1.0).contains(&score));

		if semantic {
			continue;
		}

		non_semantic_results += 1;

		let kind = result
			.get("failure")
			.and_then(|failure| failure.get("kind"))
			.and_then(Value::as_str)
			.or_else(|| result.get("status").and_then(Value::as_str))
			.unwrap_or("unknown")
			.to_owned();

		*failure_kinds.entry(kind).or_insert(0) += 1;
	}

	Ok(OfficialRunSummary { total_results: results.len(), non_semantic_results, failure_kinds })
}

fn unpublished_detail(summary: &OfficialRunSummary, speed_published: bool) -> String {
	let failures = summary
		.failure_kinds
		.iter()
		.map(|(kind, count)| format!("{kind}={count}"))
		.collect::<Vec<_>>()
		.join(", ");
	let suffix = if failures.is_empty() { String::new() } else { format!(" ({failures})") };
	let speed = if speed_published { "speed published" } else { "speed not published" };

	format!(
		"{speed}; Official preserved but not published: {}/{} non-semantic result(s){suffix}; no model rerun",
		summary.non_semantic_results, summary.total_results
	)
}

fn retained_phase(path: &Path) -> Result<Option<String>> {
	if !path.exists() {
		return Ok(None);
	}

	let status: RetainedStatus = read_json(path, "slot status")?;

	Ok(Some(status.phase))
}

fn write_status(path: &Path, slot: &ScheduledSlot, phase: &str, detail: &str) -> Result<()> {
	let document = RetainedStatus {
		schema_version: STATUS_SCHEMA.to_owned(),
		slot_id: slot.id.clone(),
		observed_at: slot.observed_at.clone(),
		phase: phase.to_owned(),
		detail: safe_detail(detail),
		updated_at: now_string()?,
	};
	let bytes = serde_json::to_vec_pretty(&document).context("cannot serialize slot status")?;
	let temporary = path.with_extension(format!("json.new.{}", process::id()));

	if temporary.exists() {
		fs::remove_file(&temporary).context("cannot remove stale status staging file")?;
	}

	write_create_once(&temporary, &bytes)?;

	fs::rename(&temporary, path).context("cannot atomically replace slot status")
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
	options.mode(0o600);

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
		ffi::OsString,
		fs,
		path::{Path, PathBuf},
	};

	use crate::{
		config::{CONFIG_SCHEMA, Configuration},
		credentials::RuntimeSecrets,
		lock::ProcessLock,
		schedule::{self},
		workflow::{self, CommandStep, PROTECTED_SECRETS, RetainedStatus, StepSecrets},
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

	fn environment_names(secrets: StepSecrets) -> BTreeSet<String> {
		workflow::child_environment(parent_environment(), secrets, &RuntimeSecrets::test())
			.expect("child environment")
			.keys()
			.map(|name| name.to_string_lossy().into_owned())
			.collect()
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
			br#"{"results":[{"status":"completed","task_score":0.75},{"status":"failed","task_score":null,"failure":{"kind":"evaluator_failure"}}]}"#,
		)
		.expect("summary fixture");

		let summary = workflow::summarize_official_run(&path).expect("summary");

		assert_eq!(summary.total_results, 2);
		assert_eq!(summary.non_semantic_results, 1);
		assert_eq!(summary.failure_kinds.get("evaluator_failure"), Some(&1));

		fs::remove_dir_all(root).expect("remove summary fixture");
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
	fn expired_slot_continues_only_after_a_complete_model_output() {
		let root = env::temp_dir().join(format!("aiq-expired-slot-test-{}", process::id()));
		let _ = fs::remove_dir_all(&root);
		let expired = schedule::scheduled_slot("2026-08-10T03-00Z").expect("expired slot");
		let latest = schedule::scheduled_slot("2026-08-10T15-00Z").expect("latest slot");
		let paths = workflow::slot_paths(&root, &expired);

		assert!(!workflow::slot_can_continue(&expired, &latest, &paths).expect("closed window"));
		assert!(workflow::slot_can_continue(&latest, &latest, &paths).expect("current window"));

		workflow::prepare_slot_directories(&paths).expect("expired fixture directories");
		fs::write(&paths.speed.batch, "completed Speed dispatch\n")
			.expect("completed Speed run fixture");

		assert!(workflow::slot_can_continue(&expired, &latest, &paths).expect("Speed resume"));

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

		assert!(workflow::slot_can_continue(&expired, &latest, &paths).expect("resumable output"));

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

		let state = workflow::paid_work_recovery_state(&paths.official.checkpoint)
			.expect("subscription state")
			.expect("subscription recovery");

		assert_eq!(state.completed_results, 2);
		assert_eq!(state.deferred_cells, workflow::OFFICIAL_RESULT_COUNT - 2);
		assert_eq!(state.pending_evaluations, 0);
		assert!(workflow::slot_can_continue(&blocked, &latest, &paths).expect("resumable"));
		assert_eq!(
			workflow::official_dispatch(
				&blocked,
				&paths,
				blocked.timestamp_ms + workflow::OFFICIAL_DISPATCH_GRACE_MILLISECONDS,
			)
			.expect("late subscription recovery"),
			workflow::OfficialDispatch::StartModel
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
		let latest = schedule::scheduled_slot("2026-08-11T15-00Z").expect("latest slot");
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

		let state = workflow::paid_work_recovery_state(&paths.official.checkpoint)
			.expect("evaluator state")
			.expect("evaluator recovery");

		assert_eq!(state.pending_evaluations, 1);
		assert!(workflow::slot_can_continue(&blocked, &latest, &paths).expect("resumable"));
		assert_eq!(
			workflow::official_dispatch(
				&blocked,
				&paths,
				blocked.timestamp_ms + workflow::OFFICIAL_DISPATCH_GRACE_MILLISECONDS,
			)
			.expect("late evaluator recovery"),
			workflow::OfficialDispatch::StartModel
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

		let state = workflow::paid_work_recovery_state(&paths.official.checkpoint)
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
			!workflow::official_dispatch_window_is_open(&slot, slot.timestamp_ms - 1)
				.expect("before slot")
		);
		assert!(
			workflow::official_dispatch_window_is_open(&slot, slot.timestamp_ms)
				.expect("slot start")
		);
		assert!(
			workflow::official_dispatch_window_is_open(&slot, slot.timestamp_ms + grace - 1,)
				.expect("inside grace")
		);
		assert!(
			!workflow::official_dispatch_window_is_open(&slot, slot.timestamp_ms + grace,)
				.expect("closed grace")
		);
	}

	#[test]
	fn late_slot_closes_before_any_new_speed_or_official_model_work() {
		let slot = schedule::scheduled_slot("2026-08-10T15-00Z").expect("dispatch slot");
		let root = env::temp_dir().join(format!("aiq-late-slot-test-{}", process::id()));
		let _ = fs::remove_dir_all(&root);
		let paths = workflow::slot_paths(&root, &slot);
		let now = slot.timestamp_ms + workflow::OFFICIAL_DISPATCH_GRACE_MILLISECONDS;

		workflow::prepare_slot_directories(&paths).expect("late slot directories");

		assert!(
			!workflow::official_dispatch_window_is_open(&slot, now)
				.expect("closed dispatch window")
		);
		assert_eq!(
			workflow::official_dispatch(&slot, &paths, now).expect("closed late dispatch"),
			workflow::OfficialDispatch::Close
		);
		assert!(!workflow::speed_can_continue(&slot, &paths, now).expect("closed speed dispatch"));

		fs::write(&paths.speed.batch, "completed speed model output\n")
			.expect("speed model fixture");

		assert_eq!(
			workflow::official_dispatch(&slot, &paths, now).expect("speed-only late dispatch"),
			workflow::OfficialDispatch::Close
		);
		assert!(workflow::speed_can_continue(&slot, &paths, now).expect("model-free speed resume"));

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
			workflow::official_dispatch(&slot, &paths, now).expect("model-free late resume"),
			workflow::OfficialDispatch::ResumeAfterModel
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

		assert!(!workflow::official_run_is_complete(&paths.official.run).expect("reservation"));
		assert_eq!(
			workflow::official_dispatch(&slot, &paths, slot.timestamp_ms).expect("early resume"),
			workflow::OfficialDispatch::StartModel
		);
		assert_eq!(
			workflow::official_dispatch(
				&slot,
				&paths,
				slot.timestamp_ms + workflow::OFFICIAL_DISPATCH_GRACE_MILLISECONDS,
			)
			.expect("late reservation"),
			workflow::OfficialDispatch::Close
		);

		fs::remove_dir_all(root).expect("remove reservation fixture");
	}

	#[test]
	fn official_dispatch_requires_full_supported_concurrency() {
		assert!(workflow::require_official_dispatch_capacity(32).is_ok());
		assert!(workflow::require_official_dispatch_capacity(31).is_err());
	}

	#[test]
	fn missed_window_is_terminal() {
		assert!(workflow::is_terminal_phase("complete"));
		assert!(workflow::is_terminal_phase("complete_with_unpublished_official"));
		assert!(workflow::is_terminal_phase("complete_with_unpublished_speed"));
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

		workflow::run_create_once_step(&step, &paths, &slot, &RuntimeSecrets::test())
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

		workflow::run_create_once_step(&step, &paths, &slot, &RuntimeSecrets::test())
			.expect("truncated captured receipt is retried");

		assert!(
			workflow::captured_receipt_is_complete(
				&paths.speed.receipt,
				workflow::CaptureKind::Submission,
			)
			.expect("validated replacement receipt")
		);

		fs::remove_dir_all(root).expect("remove receipt retry fixture");
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
			workflow::run_create_once_step(&step, &paths, &slot, &RuntimeSecrets::test()).is_err()
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
		let error = workflow::run_create_once_step(&step, &paths, &slot, &RuntimeSecrets::test())
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

		workflow::run_create_once_step(&step, &paths, &slot, &RuntimeSecrets::test())
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
