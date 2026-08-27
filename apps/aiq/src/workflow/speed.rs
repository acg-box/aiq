//! Auxiliary Speed publication owner.

use crate::{
	Error, Result, config::Configuration, credentials::RuntimeSecrets, release::ReleasePaths,
	schedule::ScheduledSlot,
};
use crate::workflow::{self, CaptureKind, CommandStep, PublicationOwner, SlotPaths, StepSecrets};

pub(super) const DISPATCH_WINDOW_MILLISECONDS: i64 = 12 * 60 * 60 * 1_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum Dispatch {
	Complete,
	Start,
	ResumeSubmission,
	Close,
}
impl Dispatch {
	pub(super) const fn needs_secrets(self) -> bool {
		matches!(self, Self::Start | Self::ResumeSubmission)
	}
}

pub(super) fn dispatch(
	slot: &ScheduledSlot,
	paths: &SlotPaths,
	now_unix_ms: i64,
) -> Result<Dispatch> {
	if is_published(paths)? {
		Ok(Dispatch::Complete)
	} else if workflow::existing_regular_file(&paths.speed.batch)? {
		Ok(Dispatch::ResumeSubmission)
	} else if dispatch_window_is_open(slot, now_unix_ms)? {
		Ok(Dispatch::Start)
	} else {
		Ok(Dispatch::Close)
	}
}

pub(super) fn dispatch_window_is_open(slot: &ScheduledSlot, now_unix_ms: i64) -> Result<bool> {
	let deadline = slot
		.timestamp_ms
		.checked_add(DISPATCH_WINDOW_MILLISECONDS)
		.ok_or_else(|| Error::new("Speed dispatch deadline is outside the supported range"))?;

	Ok(now_unix_ms >= slot.timestamp_ms && now_unix_ms < deadline)
}

pub(super) fn is_published(paths: &SlotPaths) -> Result<bool> {
	Ok(workflow::existing_regular_file(&paths.speed.batch)?
		&& workflow::captured_receipt_is_complete(&paths.speed.receipt, CaptureKind::Submission)?)
}

pub(super) fn run(
	configuration: &Configuration,
	release: &ReleasePaths,
	paths: &SlotPaths,
	slot: &ScheduledSlot,
	dispatch: Dispatch,
	secrets: Option<&RuntimeSecrets>,
) -> Result<()> {
	let result = match dispatch {
		Dispatch::Complete => Ok(()),
		Dispatch::Close => {
			cleanup(paths)?;

			workflow::append_log(
				&paths.log,
				"speed_terminal",
				"Speed observation window closed before model dispatch",
			)?;

			return workflow::write_publication_status(
				paths,
				slot,
				PublicationOwner::Speed,
				"missed_window",
				"Speed observation window closed before model dispatch",
			);
		},
		Dispatch::Start | Dispatch::ResumeSubmission => {
			let secrets =
				secrets.ok_or_else(|| Error::new("Speed runtime secrets are unavailable"))?;

			run_observation(configuration, release, paths, slot, secrets)
		},
	};

	match result {
		Ok(()) => {
			cleanup(paths)?;

			workflow::append_log(&paths.log, "speed_published", "Speed evidence published")?;

			workflow::write_publication_status(
				paths,
				slot,
				PublicationOwner::Speed,
				"published",
				"Speed evidence published",
			)
		},
		Err(error) => {
			let retryable = workflow::existing_regular_file(&paths.speed.batch)?
				|| dispatch_window_is_open(slot, workflow::current_unix_ms()?)?;
			let phase = if retryable { "retryable_failure" } else { "unpublished" };
			let detail = workflow::safe_detail(&error.to_string());

			workflow::append_log(&paths.log, "speed_failed", &detail)?;
			workflow::write_publication_status(paths, slot, PublicationOwner::Speed, phase, &detail)?;

			if retryable { Err(error) } else { Ok(()) }
		},
	}
}

pub(super) fn cleanup(paths: &SlotPaths) -> Result<()> {
	workflow::cleanup_codex_home(&paths.speed.home)?;

	for path in [&paths.speed.workspace, &paths.speed.artifacts, &paths.speed.checkpoints] {
		workflow::remove_managed(path, &paths.speed.root)?;
	}

	Ok(())
}

fn run_observation(
	configuration: &Configuration,
	release: &ReleasePaths,
	paths: &SlotPaths,
	slot: &ScheduledSlot,
	secrets: &RuntimeSecrets,
) -> Result<()> {
	if workflow::existing_regular_file(&paths.speed.batch)? {
		workflow::cleanup_codex_home(&paths.speed.home)?;
	} else {
		workflow::prepare_codex_home(&paths.speed.home, &configuration.codex_auth_source)?;
	}

	let result = steps(configuration, release, paths, slot).iter().try_for_each(|step| {
		workflow::run_create_once_step(step, paths, slot, secrets, PublicationOwner::Speed)
	});
	let home_cleanup = workflow::cleanup_codex_home(&paths.speed.home);

	result.and(home_cleanup)
}

fn steps(
	configuration: &Configuration,
	release: &ReleasePaths,
	paths: &SlotPaths,
	slot: &ScheduledSlot,
) -> [CommandStep; 2] {
	let observe = CommandStep {
		name: "speed_observe",
		executable: release.runner.clone(),
		args: workflow::args([
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
		args: workflow::args([
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
