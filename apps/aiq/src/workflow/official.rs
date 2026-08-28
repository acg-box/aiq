//! Official publication owner.

use std::{collections::BTreeMap, fs, path::Path};

use serde_json::Value;

use crate::{
	Error, Result, ResultContext, config::Configuration, credentials::RuntimeSecrets,
	release::Release, schedule::ScheduledSlot,
};
use crate::workflow::{self, CaptureKind, OFFICIAL_DISPATCH_GRACE_MILLISECONDS, OFFICIAL_RESULT_COUNT, OFFICIAL_RUN_SCHEMA, PaidWorkRecoveryState, PublicationOwner, REQUIRED_OFFICIAL_JOBS, SlotPaths};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum Dispatch {
	Complete,
	StartModel,
	ResumeAfterModel,
	Close,
}
impl Dispatch {
	pub(super) const fn needs_secrets(self) -> bool {
		matches!(self, Self::StartModel | Self::ResumeAfterModel)
	}
}

enum Completion {
	Published,
	Unpublished(RunSummary),
	MissedWindow,
}

#[derive(Debug)]
pub(super) struct RunSummary {
	pub(super) total_results: usize,
	pub(super) non_semantic_results: usize,
	pub(super) failure_kinds: BTreeMap<String, usize>,
}

pub(super) fn dispatch(
	slot: &ScheduledSlot,
	paths: &SlotPaths,
	now_unix_ms: i64,
) -> Result<Dispatch> {
	if is_published(paths)? {
		Ok(Dispatch::Complete)
	} else if run_is_complete(&paths.official.run)? {
		Ok(Dispatch::ResumeAfterModel)
	} else if paid_work_recovery_state(&paths.official.checkpoint)?.is_some()
		|| dispatch_window_is_open(slot, now_unix_ms)?
	{
		Ok(Dispatch::StartModel)
	} else {
		Ok(Dispatch::Close)
	}
}

pub(super) fn dispatch_window_is_open(slot: &ScheduledSlot, now_unix_ms: i64) -> Result<bool> {
	let deadline = slot
		.timestamp_ms
		.checked_add(OFFICIAL_DISPATCH_GRACE_MILLISECONDS)
		.ok_or_else(|| Error::new("Official dispatch deadline is outside the supported range"))?;

	Ok(now_unix_ms >= slot.timestamp_ms && now_unix_ms < deadline)
}

pub(super) fn is_published(paths: &SlotPaths) -> Result<bool> {
	workflow::captured_receipt_is_complete(&paths.official.verifier_records, CaptureKind::Verifier)
}

pub(super) fn run(
	configuration: &Configuration,
	release: &Release,
	paths: &SlotPaths,
	slot: &ScheduledSlot,
	dispatch: Dispatch,
	secrets: Option<&RuntimeSecrets>,
) -> Result<()> {
	let completion = run_inner(configuration, release, paths, slot, dispatch, secrets);

	match completion {
		Ok(Completion::Published) => {
			cleanup(release, configuration, slot, paths)?;

			workflow::append_log(&paths.log, "official_published", "Official evidence published")?;

			workflow::write_publication_status(
				paths,
				slot,
				PublicationOwner::Official,
				"published",
				"Official evidence published",
			)
		},
		Ok(Completion::Unpublished(summary)) => {
			let detail = unpublished_detail(&summary);

			cleanup(release, configuration, slot, paths)?;

			workflow::append_log(&paths.log, "official_unpublished", &detail)?;

			workflow::write_publication_status(
				paths,
				slot,
				PublicationOwner::Official,
				"unpublished",
				&detail,
			)
		},
		Ok(Completion::MissedWindow) => {
			let detail = "Official dispatch grace elapsed before a complete run";

			cleanup(release, configuration, slot, paths)?;

			workflow::append_log(&paths.log, "official_terminal", detail)?;

			workflow::write_publication_status(
				paths,
				slot,
				PublicationOwner::Official,
				"missed_window",
				detail,
			)
		},
		Err(error) if error.is_subscription_backpressure() => {
			if let Some(state) = paid_work_recovery_state(&paths.official.checkpoint)? {
				let detail = format!(
					"subscription capacity unavailable; retained {} completed result(s); {} cell(s) deferred for scheduled resume",
					state.completed_results, state.deferred_cells,
				);

				workflow::append_log(&paths.log, "official_waiting", &detail)?;
				workflow::write_publication_status(
					paths,
					slot,
					PublicationOwner::Official,
					"waiting_for_subscription",
					&detail,
				)?;

				return Ok(());
			}

			record_failure(paths, slot, &error)?;

			Err(error)
		},
		Err(error) => {
			record_failure(paths, slot, &error)?;

			Err(error)
		},
	}
}

pub(super) fn require_dispatch_capacity(official_jobs: u8) -> Result<()> {
	if official_jobs == REQUIRED_OFFICIAL_JOBS {
		Ok(())
	} else {
		Err(Error::new(format!(
			"official_jobs must be {REQUIRED_OFFICIAL_JOBS} before Official model work",
		)))
	}
}

pub(super) fn paid_work_recovery_state(path: &Path) -> Result<Option<PaidWorkRecoveryState>> {
	if !workflow::existing_regular_file(path)? {
		return Ok(None);
	}

	let checkpoint = workflow::read_json_value(path, "Official checkpoint")?;
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

pub(super) fn run_is_complete(path: &Path) -> Result<bool> {
	if !workflow::existing_regular_file(path)? {
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

pub(super) fn summarize_run(path: &Path) -> Result<RunSummary> {
	let document = workflow::read_json_value(path, "Official run")?;
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

	Ok(RunSummary { total_results: results.len(), non_semantic_results, failure_kinds })
}

pub(super) fn cleanup(
	release: &Release,
	configuration: &Configuration,
	slot: &ScheduledSlot,
	paths: &SlotPaths,
) -> Result<()> {
	cleanup_state(paths)?;

	release.cleanup_source(&configuration.state_root, slot)
}

pub(super) fn cleanup_state(paths: &SlotPaths) -> Result<()> {
	workflow::cleanup_codex_home(&paths.official.home)?;

	for path in [&paths.official.execution, &paths.official.artifacts] {
		workflow::remove_managed(path, &paths.official.root)?;
	}

	workflow::remove_managed(&paths.official.verification.join("replay"), &paths.official.verification)?;

	workflow::remove_managed(&paths.official.checkpoint, &paths.official.state)
}

fn run_inner(
	configuration: &Configuration,
	release: &Release,
	paths: &SlotPaths,
	slot: &ScheduledSlot,
	selected_dispatch: Dispatch,
	secrets: Option<&RuntimeSecrets>,
) -> Result<Completion> {
	match selected_dispatch {
		Dispatch::Complete => return Ok(Completion::Published),
		Dispatch::Close => return Ok(Completion::MissedWindow),
		Dispatch::StartModel => require_dispatch_capacity(configuration.official_jobs)?,
		Dispatch::ResumeAfterModel => {},
	}

	let secrets = secrets.ok_or_else(|| Error::new("Official runtime secrets are unavailable"))?;
	let source = release.prepare_source(&configuration.state_root, slot)?;
	let dispatch = if selected_dispatch == Dispatch::StartModel {
		dispatch(slot, paths, workflow::current_unix_ms()?)?
	} else {
		selected_dispatch
	};

	if dispatch == Dispatch::Close {
		return Ok(Completion::MissedWindow);
	}

	let summary = match dispatch {
		Dispatch::StartModel => run_model(configuration, release, paths, slot, &source, secrets)?,
		Dispatch::ResumeAfterModel => {
			run_after_model(configuration, release, paths, slot, &source, secrets)?
		},
		Dispatch::Complete => return Ok(Completion::Published),
		Dispatch::Close => return Ok(Completion::MissedWindow),
	};

	if !publication_ready(&summary) {
		Ok(Completion::Unpublished(summary))
	} else if is_published(paths)? {
		Ok(Completion::Published)
	} else {
		Err(Error::new("Official workflow completed without a verified publication receipt"))
	}
}

fn record_failure(paths: &SlotPaths, slot: &ScheduledSlot, error: &Error) -> Result<()> {
	let detail = workflow::safe_detail(&error.to_string());

	workflow::append_log(&paths.log, "official_failed", &detail)?;

	workflow::write_publication_status(paths, slot, PublicationOwner::Official, "retryable_failure", &detail)
}

fn run_after_model(
	configuration: &Configuration,
	release: &Release,
	paths: &SlotPaths,
	slot: &ScheduledSlot,
	source: &Path,
	secrets: &RuntimeSecrets,
) -> Result<RunSummary> {
	workflow::cleanup_codex_home(&paths.official.home)?;

	let summary = summarize_run(&paths.official.run)?;

	if summary.non_semantic_results > 0 {
		return Ok(summary);
	}

	let steps = workflow::official_steps(configuration, release, paths, slot, source);

	for step in steps.iter().skip(3) {
		workflow::run_create_once_step(step, paths, slot, secrets, PublicationOwner::Official)?;
	}

	summarize_run(&paths.official.run)
}

fn run_model(
	configuration: &Configuration,
	release: &Release,
	paths: &SlotPaths,
	slot: &ScheduledSlot,
	source: &Path,
	secrets: &RuntimeSecrets,
) -> Result<RunSummary> {
	workflow::prepare_codex_home(&paths.official.home, &configuration.codex_auth_source)?;

	let steps = workflow::official_steps(configuration, release, paths, slot, source);
	let result = (|| {
		for step in &steps {
			workflow::run_create_once_step(step, paths, slot, secrets, PublicationOwner::Official)?;

			if step.name == "official_run" {
				let summary = summarize_run(&paths.official.run)?;

				if summary.non_semantic_results > 0 {
					return Ok(summary);
				}
			}
		}

		summarize_run(&paths.official.run)
	})();
	let home_cleanup = workflow::cleanup_codex_home(&paths.official.home);

	match (result, home_cleanup) {
		(Err(error), _) | (Ok(_), Err(error)) => Err(error),
		(Ok(summary), Ok(())) => Ok(summary),
	}
}

fn unpublished_detail(summary: &RunSummary) -> String {
	let failures = summary
		.failure_kinds
		.iter()
		.map(|(kind, count)| format!("{kind}={count}"))
		.collect::<Vec<_>>()
		.join(", ");
	let suffix = if failures.is_empty() { String::new() } else { format!(" ({failures})") };

	format!(
		"Official preserved but not published: {}/{} non-semantic result(s){suffix}; no model rerun",
		summary.non_semantic_results, summary.total_results
	)
}

fn publication_ready(summary: &RunSummary) -> bool {
	summary.total_results == OFFICIAL_RESULT_COUNT && summary.non_semantic_results == 0
}

#[cfg(test)]
mod tests {
	use std::{collections::BTreeMap, env, fs, process};

	use serde_json::Value;

	use crate::{
		Error, schedule,
		workflow::{self, OFFICIAL_RESULT_COUNT, official},
	};

	#[test]
	fn publication_requires_a_complete_semantic_official_matrix() {
		assert!(official::publication_ready(&official::RunSummary {
			total_results: OFFICIAL_RESULT_COUNT,
			non_semantic_results: 0,
			failure_kinds: BTreeMap::new(),
		}));
		assert!(!official::publication_ready(&official::RunSummary {
			total_results: OFFICIAL_RESULT_COUNT - 1,
			non_semantic_results: 0,
			failure_kinds: BTreeMap::new(),
		}));
		assert!(!official::publication_ready(&official::RunSummary {
			total_results: OFFICIAL_RESULT_COUNT,
			non_semantic_results: 1,
			failure_kinds: BTreeMap::from([("evaluator_failure".to_owned(), 1)]),
		}));
	}

	#[test]
	fn retryable_official_failure_retains_evaluator_recovery_state() {
		let root =
			env::temp_dir().join(format!("aiq-official-retryable-retention-{}", process::id()));
		let _ = fs::remove_dir_all(&root);
		let slot = schedule::scheduled_slot("2026-08-10T15-00Z").expect("slot");
		let paths = workflow::slot_paths(&root, &slot);

		workflow::prepare_slot_directories(&paths).expect("recovery directories");
		fs::write(&paths.official.checkpoint, "pending evaluator\n").expect("checkpoint");
		fs::write(paths.official.artifacts.join("retained"), "artifact\n").expect("artifact");
		fs::write(paths.official.execution.join("retained"), "workspace\n").expect("workspace");
		official::record_failure(&paths, &slot, &Error::new("retryable evaluator failure"))
			.expect("retryable status");

		let status = workflow::read_json_value(&paths.official.status, "Official status")
			.expect("Official status");

		assert_eq!(status.get("phase").and_then(Value::as_str), Some("retryable_failure"));
		assert!(paths.official.checkpoint.is_file());
		assert!(paths.official.artifacts.join("retained").is_file());
		assert!(paths.official.execution.join("retained").is_file());

		fs::remove_dir_all(root).expect("cleanup");
	}
}
