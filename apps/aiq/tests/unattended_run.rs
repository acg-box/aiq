//! No-model shipped-binary acceptance for unattended `aiq run`.

#![cfg(unix)]

use std::env;
use std::{
	fs::{self, Permissions},
	os::unix::fs::PermissionsExt as _,
	path::{Path, PathBuf},
	process::{self, Command},
	sync::atomic::{AtomicU64, Ordering},
	thread,
	time::{Duration, Instant},
};

use clap as _;
use hex as _;
use jiff as _;
use libc as _;
use serde as _;
use sha2::{Digest as _, Sha256};
use ureq as _;

use aiq::{
	release::{self, InstalledRelease},
	schedule,
};

const RUNNER_PATH: &str = "bin/aiq-runner";
const VERIFIER_PATH: &str = "bin/aiq-verifier";
const CODEX_PATH: &str = "codex-runtime/codex";
const CODEX_HOST_PATH: &str = "codex-runtime/codex-code-mode-host";
const LEGACY_UNPUBLISHED_DETAIL: &str = "speed not published; Official preserved but not published: 2/1224 non-semantic result(s) (evaluator_failure=2); no model rerun";
const GIT_EXECUTABLE: &str = match option_env!("AIQ_BUILD_GIT") {
	Some(path) => path,
	None => "git",
};

static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy)]
enum FixtureMode {
	Immediate,
	BlockOfficial,
	BlockSpeedThenFail,
}

struct Fixture {
	root: PathBuf,
	home: PathBuf,
	state: PathBuf,
	configuration: PathBuf,
	provider_log: PathBuf,
	child_log: PathBuf,
	outside_repository: PathBuf,
	slot_id: String,
	gate_started: PathBuf,
	gate_release: PathBuf,
}
impl Fixture {
	fn new() -> Self {
		Self::with_mode(FixtureMode::Immediate)
	}

	fn with_mode(mode: FixtureMode) -> Self {
		let sequence = NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed);
		let requested = env::temp_dir()
			.join(format!("aiq-unattended-run-contract-{}-{sequence}", process::id(),));
		let _ = fs::remove_dir_all(&requested);

		private_directory(&requested);

		let root = fs::canonicalize(requested).expect("canonical fixture root");
		let home = root.join("home");
		let state = root.join("state");
		let bin = root.join("provider-bin");
		let outside_repository = root.join("outside-repository");
		let provider_log = root.join("provider.log");
		let child_log = root.join("children.log");
		let gate_started = root.join("gate-started");
		let gate_release = root.join("gate-release");

		for path in [&home, &state, &bin, &outside_repository] {
			private_directory(path);
		}

		let timeout = bin.join("timeout");
		let security = bin.join("security");
		let infisical = bin.join("infisical");

		write_script(&timeout, "shift 3\nexec \"$@\"\n");
		write_runtime_security(&security, &home);
		write_runtime_infisical(&infisical, &state, &provider_log);

		let installed = install_fake_release(&root, &child_log, mode, &gate_started, &gate_release);
		let auth = root.join("auth.json");

		fs::write(&auth, b"{}\n").expect("Codex authentication fixture");
		fs::set_permissions(&auth, Permissions::from_mode(0o600)).expect("Codex auth mode");

		let slot = schedule::current_surrounding_slots().expect("current slots").latest;
		let run = state.join("slots").join(&slot.id).join("official/state/run.json");

		private_directory(run.parent().expect("run parent"));

		fs::write(
			&run,
			serde_json::to_vec(&serde_json::json!({
				"schema_version": "aiq.run.v4",
				"results": vec![serde_json::json!({"status":"completed","task_score":1.0}); 1_224]
			}))
			.expect("complete run"),
		)
		.expect("complete run fixture");

		let configuration = root.join("continuous-observation.json");

		write_runtime_configuration(
			&configuration,
			&installed,
			&state,
			&auth,
			&infisical,
			&timeout,
			&security,
		);

		Self {
			root,
			home,
			state,
			configuration,
			provider_log,
			child_log,
			outside_repository,
			slot_id: slot.id,
			gate_started,
			gate_release,
		}
	}

	fn command(&self) -> Command {
		let mut command = Command::new(env!("CARGO_BIN_EXE_aiq"));

		command
			.args(["run", "--config"])
			.arg(&self.configuration)
			.args(["--slot", &self.slot_id])
			.current_dir(&self.outside_repository)
			.env_clear()
			.env("AMBIENT_SECRET", "must-not-reach-a-child")
			.env("HOME", &self.home)
			.env("LANG", "en_US.UTF-8")
			.env("LOGNAME", "aiq-test")
			.env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
			.env("USER", "aiq-test");

		command
	}

	fn status(&self) -> serde_json::Value {
		let output = Command::new(env!("CARGO_BIN_EXE_aiq"))
			.args(["status", "--config"])
			.arg(&self.configuration)
			.current_dir(&self.outside_repository)
			.output()
			.expect("unattended status");

		assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));

		serde_json::from_slice(&output.stdout).expect("status JSON")
	}

	fn seed_legacy_unpublished_status(&self) -> Vec<u8> {
		let slot = schedule::scheduled_slot(&self.slot_id).expect("legacy status slot");
		let slot_root = self.state.join("slots").join(&self.slot_id);
		let run = slot_root.join("official/state/run.json");
		let mut results = vec![serde_json::json!({"status":"completed","task_score":1.0}); 1_222];

		results.extend([
			serde_json::json!({
				"status": "failed",
				"task_score": null,
				"failure": {"kind": "evaluator_failure"},
			}),
			serde_json::json!({
				"status": "failed",
				"task_score": null,
				"failure": {"kind": "evaluator_failure"},
			}),
		]);

		let run_bytes = serde_json::to_vec(&serde_json::json!({
			"schema_version": "aiq.run.v4",
			"results": results,
		}))
		.expect("legacy Official run");

		fs::write(&run, &run_bytes).expect("legacy Official run fixture");
		fs::write(
			slot_root.join("status.json"),
			serde_json::to_vec_pretty(&serde_json::json!({
				"schema_version": "aiq.continuous-observation-status.v2",
				"slot_id": slot.id,
				"observed_at": slot.observed_at,
				"phase": "complete_with_unpublished_official",
				"detail": LEGACY_UNPUBLISHED_DETAIL,
				"updated_at": "2026-08-27T20:00:00Z",
			}))
			.expect("legacy status JSON"),
		)
		.expect("legacy status fixture");

		run_bytes
	}
}

impl Drop for Fixture {
	fn drop(&mut self) {
		let _ = fs::remove_dir_all(&self.root);
	}
}

#[test]
fn shipped_run_retrieves_exact_secrets_outside_a_repository() {
	let fixture = Fixture::new();
	let output = fixture.command().output().expect("unattended run");

	assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
	assert!(output.stdout.is_empty());
	assert!(output.stderr.is_empty());
	assert_eq!(
		fs::read_to_string(&fixture.provider_log).expect("provider selector log"),
		"RUNNER_SIGNING_KEY\nRUNNER_SUBMISSION_TOKEN\nVERIFIER_INGRESS_TOKEN\nVERIFIER_SIGNING_KEY\n",
	);
	assert!(!fixture.state.join("provider/session").exists());

	let child_log = fs::read_to_string(&fixture.child_log).expect("child boundary log");

	for required in
		["score:none", "package:runner-signing", "submit:runner-submission", "verifier:verifier"]
	{
		assert!(child_log.lines().any(|line| line == required), "missing child proof {required}");
	}

	assert!(!child_log.contains("bootstrap-secret-sentinel"));
	assert!(!child_log.contains("access-token-sentinel"));
}

#[test]
fn terminal_legacy_v2_status_recovers_speed_without_rerunning_official_model_work() {
	let fixture = Fixture::new();
	let retained_run = fixture.seed_legacy_unpublished_status();
	let output = fixture.command().output().expect("legacy recovery run");

	assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
	assert!(output.stdout.is_empty());
	assert!(output.stderr.is_empty());

	let slot_root = fixture.state.join("slots").join(&fixture.slot_id);
	let speed_status: serde_json::Value = serde_json::from_slice(
		&fs::read(slot_root.join("speed/status.json")).expect("migrated Speed status"),
	)
	.expect("Speed status JSON");
	let official_status: serde_json::Value = serde_json::from_slice(
		&fs::read(slot_root.join("official/status.json")).expect("migrated Official status"),
	)
	.expect("Official status JSON");

	assert_eq!(speed_status.get("phase").and_then(serde_json::Value::as_str), Some("published"));
	assert_eq!(
		official_status.get("phase").and_then(serde_json::Value::as_str),
		Some("unpublished")
	);
	assert_eq!(
		official_status.get("detail").and_then(serde_json::Value::as_str),
		Some(
			"Official preserved but not published: 2/1224 non-semantic result(s) (evaluator_failure=2); no model rerun"
		)
	);
	assert_eq!(
		fs::read(slot_root.join("official/state/run.json")).expect("retained Official run"),
		retained_run
	);
	assert_eq!(
		fs::read_to_string(&fixture.child_log).expect("legacy recovery child log"),
		"speed:none\nsubmit:runner-submission\n"
	);

	let final_status = fixture.status();

	assert_eq!(
		final_status
			.pointer("/latest_slot_state/schema_version")
			.and_then(serde_json::Value::as_str),
		Some("aiq.continuous-observation-status.v3")
	);
	assert_eq!(
		final_status.pointer("/latest_slot_state/phase").and_then(serde_json::Value::as_str),
		Some("complete_with_unpublished_official")
	);
}

#[test]
fn current_v3_terminal_status_is_idempotent() {
	let fixture = Fixture::new();
	let first = fixture.command().output().expect("first terminal run");

	assert!(first.status.success(), "{}", String::from_utf8_lossy(&first.stderr));
	assert!(first.stdout.is_empty());
	assert!(first.stderr.is_empty());

	let slot_root = fixture.state.join("slots").join(&fixture.slot_id);
	let status_path = slot_root.join("status.json");
	let speed_status_path = slot_root.join("speed/status.json");
	let official_status_path = slot_root.join("official/status.json");
	let status = fs::read(&status_path).expect("terminal aggregate status");
	let speed_status = fs::read(&speed_status_path).expect("terminal Speed status");
	let official_status = fs::read(&official_status_path).expect("terminal Official status");
	let child_log = fs::read(&fixture.child_log).expect("terminal child log");
	let second = fixture.command().output().expect("terminal rerun");

	assert!(second.status.success(), "{}", String::from_utf8_lossy(&second.stderr));
	assert!(second.stdout.is_empty());
	assert!(second.stderr.is_empty());
	assert_eq!(fs::read(status_path).expect("unchanged aggregate status"), status);
	assert_eq!(fs::read(speed_status_path).expect("unchanged Speed status"), speed_status);
	assert_eq!(fs::read(official_status_path).expect("unchanged Official status"), official_status);
	assert_eq!(fs::read(&fixture.child_log).expect("unchanged child log"), child_log);
}

#[test]
fn slow_official_path_does_not_starve_speed_publication() {
	let fixture = Fixture::with_mode(FixtureMode::BlockOfficial);
	let child = fixture.command().spawn().expect("blocked Official run");
	let official_started = wait_for_path(&fixture.gate_started);
	let speed_status = fixture.state.join("slots").join(&fixture.slot_id).join("speed/status.json");
	let speed_published = official_started && wait_for_phase(&speed_status, "published");
	let live_status = speed_published.then(|| fixture.status());

	fs::write(&fixture.gate_release, b"release\n").expect("release Official gate");

	let status = child.wait_with_output().expect("blocked Official child").status;

	assert!(official_started, "Official fixture did not reach the blocking step");
	assert!(speed_published, "Speed did not publish while Official remained blocked");
	assert!(status.success());

	let live_status = live_status.expect("live sibling status");

	assert_eq!(
		live_status.pointer("/latest_slot_state/speed/phase").and_then(serde_json::Value::as_str),
		Some("published")
	);
	assert_eq!(
		live_status
			.pointer("/latest_slot_state/official/phase")
			.and_then(serde_json::Value::as_str),
		Some("official_score")
	);
}

#[test]
fn slow_failed_speed_path_does_not_block_official_publication() {
	let fixture = Fixture::with_mode(FixtureMode::BlockSpeedThenFail);
	let child = fixture.command().spawn().expect("blocked Speed run");
	let speed_started = wait_for_path(&fixture.gate_started);
	let official_status =
		fixture.state.join("slots").join(&fixture.slot_id).join("official/status.json");
	let official_published = speed_started && wait_for_phase(&official_status, "published");
	let live_status = official_published.then(|| fixture.status());

	fs::write(&fixture.gate_release, b"release\n").expect("release Speed gate");

	let status = child.wait_with_output().expect("blocked Speed child").status;

	assert!(speed_started, "Speed fixture did not reach the blocking step");
	assert!(official_published, "Official did not publish while Speed remained blocked");
	assert!(!status.success(), "retryable Speed failure must keep a failing process result");

	let live_status = live_status.expect("live sibling status");

	assert_eq!(
		live_status
			.pointer("/latest_slot_state/official/phase")
			.and_then(serde_json::Value::as_str),
		Some("published")
	);

	let final_status = fixture.status();

	assert_eq!(
		final_status.pointer("/latest_slot_state/phase").and_then(serde_json::Value::as_str),
		Some("retryable_failure")
	);
	assert_eq!(
		final_status.pointer("/latest_slot_state/speed/phase").and_then(serde_json::Value::as_str),
		Some("retryable_failure")
	);
	assert_eq!(
		final_status
			.pointer("/latest_slot_state/official/phase")
			.and_then(serde_json::Value::as_str),
		Some("published")
	);
}

fn wait_for_path(path: &Path) -> bool {
	let deadline = Instant::now() + Duration::from_secs(20);

	while Instant::now() < deadline {
		if path.exists() {
			return true;
		}

		thread::sleep(Duration::from_millis(10));
	}

	false
}

fn wait_for_phase(path: &Path, expected: &str) -> bool {
	let deadline = Instant::now() + Duration::from_secs(20);

	while Instant::now() < deadline {
		if fs::read(path)
			.ok()
			.and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
			.and_then(|status| {
				status.get("phase").and_then(serde_json::Value::as_str).map(str::to_owned)
			})
			.as_deref()
			== Some(expected)
		{
			return true;
		}

		thread::sleep(Duration::from_millis(10));
	}

	false
}

fn install_fake_release(
	root: &Path,
	child_log: &Path,
	mode: FixtureMode,
	gate_started: &Path,
	gate_release: &Path,
) -> InstalledRelease {
	let source_release = root.join("source-release");
	let repository = root.join("repository");
	let releases = root.join("releases");

	prepare_release_tree(&source_release, child_log, mode, gate_started, gate_release);
	prepare_source_repository(&repository);
	private_directory(&releases);
	write_build_receipt(&source_release, &repository);

	release::install_release(
		&source_release,
		&repository,
		&releases.join("fixture-1.0.7"),
		"fixture-1.0.7",
	)
	.expect("installed fixture release")
}

fn prepare_release_tree(
	release_root: &Path,
	child_log: &Path,
	mode: FixtureMode,
	gate_started: &Path,
	gate_release: &Path,
) {
	for relative in [
		"bin",
		"calibration-policy-v2",
		"codex-runtime",
		"core-a/tasks",
		"core-a/baselines",
		"core-a/evaluator",
		"core-a/toolchain",
		"official-r1/inputs",
		"official-r1/records",
		"records",
	] {
		fs::create_dir_all(release_root.join(relative)).expect("release directory");
	}

	write_fake_runner(&release_root.join(RUNNER_PATH), child_log, mode, gate_started, gate_release);
	write_fake_verifier(&release_root.join(VERIFIER_PATH), child_log);
	write_script(&release_root.join(CODEX_PATH), "exit 90\n");
	write_script(&release_root.join(CODEX_HOST_PATH), "exit 91\n");
	write_fake_runtime(&release_root.join("core-a/toolchain/node"), child_log);

	for relative in [
		"core-a/commitment.json",
		"core-a/receipt.json",
		"calibration-policy-v2/admission-v3.json",
		"official-r1/inputs/capabilities.json",
		"official-r1/records/generate-verifier-environment.mjs",
		"records/production-reference.json",
	] {
		fs::write(release_root.join(relative), format!("fixture:{relative}\n"))
			.expect("release fixture file");
	}

	fs::write(
		release_root.join("official-r1/inputs/schedule.json"),
		br#"{"schema_version":"aiq.schedule.v1","timezone":"UTC","day_local_time":"15:00","night_local_time":"03:00"}"#,
	)
	.expect("release schedule");
}

fn write_fake_runner(
	path: &Path,
	log: &Path,
	mode: FixtureMode,
	gate_started: &Path,
	gate_release: &Path,
) {
	let official_gate = match mode {
		FixtureMode::BlockOfficial => format!(
			"printf '%s\\n' started >{started}\nwhile [ ! -f {release} ]; do sleep 0.01; done\n",
			started = shell_quote(gate_started),
			release = shell_quote(gate_release),
		),
		FixtureMode::Immediate | FixtureMode::BlockSpeedThenFail => String::new(),
	};
	let speed_gate = match mode {
		FixtureMode::BlockSpeedThenFail => format!(
			"printf '%s\\n' started >{started}\nwhile [ ! -f {release} ]; do sleep 0.01; done\nexit 96\n",
			started = shell_quote(gate_started),
			release = shell_quote(gate_release),
		),
		FixtureMode::Immediate | FixtureMode::BlockOfficial => String::new(),
	};

	write_script(
		path,
		&format!(
			r#"assert_provider_absent() {{
  [ -z "${{INFISICAL_TOKEN+x}}" ]
  [ -z "${{INFISICAL_UNIVERSAL_AUTH_CLIENT_ID+x}}" ]
  [ -z "${{INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET+x}}" ]
  [ -z "${{AMBIENT_SECRET+x}}" ]
}}
output_arg() {{
  previous=
  for argument in "$@"; do
    if [ "$previous" = "--output" ]; then printf %s "$argument"; return; fi
    previous=$argument
  done
  return 1
}}
assert_provider_absent
case "$1" in
  score)
    [ -z "${{AIQ_RUNNER_SIGNING_KEY+x}}" ]
    [ -z "${{AIQ_RUNNER_SUBMISSION_TOKEN+x}}" ]
    {official_gate}
    printf '%s\n' score:none >>{log}
    printf '{{}}\n' >"$(output_arg "$@")"
    ;;
  package)
    [ "$AIQ_RUNNER_SIGNING_KEY" = runner-signing-sentinel ]
    [ -z "${{AIQ_RUNNER_SUBMISSION_TOKEN+x}}" ]
    [ -z "${{AIQ_VERIFIER_INGRESS_TOKEN+x}}" ]
    printf '%s\n' package:runner-signing >>{log}
    printf '{{}}\n' >"$(output_arg "$@")"
    ;;
  submit|submit-speed)
    [ "$AIQ_RUNNER_SUBMISSION_TOKEN" = runner-submission-sentinel ]
    [ -z "${{AIQ_RUNNER_SIGNING_KEY+x}}" ]
    [ -z "${{AIQ_VERIFIER_INGRESS_TOKEN+x}}" ]
    printf '%s\n' submit:runner-submission >>{log}
    printf '%s\n' '{{"kind":"accepted"}}'
    ;;
  observe-speed)
    [ -z "${{AIQ_RUNNER_SIGNING_KEY+x}}" ]
    [ -z "${{AIQ_RUNNER_SUBMISSION_TOKEN+x}}" ]
    printf '%s\n' speed:none >>{log}
    {speed_gate}
    printf '{{}}\n' >"$(output_arg "$@")"
    ;;
  *) exit 92 ;;
esac
"#,
			log = shell_quote(log),
			official_gate = official_gate,
			speed_gate = speed_gate,
		),
	);
}

fn write_fake_verifier(path: &Path, log: &Path) {
	write_script(
		path,
		&format!(
			r#"[ "$AIQ_VERIFIER_INGRESS_TOKEN" = verifier-ingress-sentinel ]
[ "$AIQ_VERIFIER_SIGNING_KEY" = verifier-signing-sentinel ]
[ -z "${{AIQ_RUNNER_SIGNING_KEY+x}}" ]
[ -z "${{AIQ_RUNNER_SUBMISSION_TOKEN+x}}" ]
[ -z "${{INFISICAL_TOKEN+x}}" ]
[ -z "${{AMBIENT_SECRET+x}}" ]
printf '%s\n' verifier:verifier >>{log}
printf '%s\n' '{{"disposition":"verified"}}'
"#,
			log = shell_quote(log),
		),
	);
}

fn write_fake_runtime(path: &Path, log: &Path) {
	write_script(
		path,
		&format!(
			r#"[ -z "${{AIQ_RUNNER_SIGNING_KEY+x}}" ]
[ -z "${{AIQ_RUNNER_SUBMISSION_TOKEN+x}}" ]
[ -z "${{AIQ_VERIFIER_INGRESS_TOKEN+x}}" ]
[ -z "${{INFISICAL_TOKEN+x}}" ]
[ -z "${{AMBIENT_SECRET+x}}" ]
for output; do :; done
printf '%s\n' runtime:none >>{log}
printf '{{}}\n' >"$output"
"#,
			log = shell_quote(log),
		),
	);
}

fn prepare_source_repository(repository: &Path) {
	private_directory(repository);
	git(repository, ["init", "--quiet"]);

	fs::write(repository.join("tracked.txt"), b"pinned\n").expect("tracked source");

	git(repository, ["add", "tracked.txt"]);
	git(
		repository,
		[
			"-c",
			"core.hooksPath=/dev/null",
			"-c",
			"user.name=AIQ Test",
			"-c",
			"user.email=aiq@example.invalid",
			"commit",
			"--quiet",
			"-m",
			"fixture",
		],
	);
}

fn write_build_receipt(release_root: &Path, repository: &Path) {
	let commit = git_stdout(repository, ["rev-parse", "HEAD"]);
	let tree = git_stdout(repository, ["rev-parse", "HEAD^{tree}"]);
	let receipt = serde_json::json!({
		"schema_version": "aiq.final-build-receipt.v2",
		"source_commit": commit,
		"source_tree": tree,
		"runner_executable_sha256": digest(&release_root.join(RUNNER_PATH)),
		"verifier_executable_sha256": digest(&release_root.join(VERIFIER_PATH)),
		"codex_executable_sha256": digest(&release_root.join(CODEX_PATH)),
		"codex_code_mode_host_sha256": digest(&release_root.join(CODEX_HOST_PATH))
	});

	fs::write(
		release_root.join("records/final-build-receipt.v2.json"),
		serde_json::to_vec_pretty(&receipt).expect("build receipt"),
	)
	.expect("write build receipt");
}

fn write_runtime_security(path: &Path, home: &Path) {
	write_script(
		path,
		&format!(
			r#"[ "$#" -eq 6 ]
[ "$1" = find-generic-password ]
[ "$2" = -s ]
[ "$3" = infisical-selfhost ]
[ "$4" = -a ]
[ "$5" = AIQ_OBSERVATION_UA_CLIENT_SECRET ]
[ "$6" = -w ]
[ "$HOME" = {home} ]
[ -z "${{AMBIENT_SECRET+x}}" ]
printf '%s\n' bootstrap-secret-sentinel
"#,
			home = shell_quote(home),
		),
	);
}

fn write_runtime_infisical(path: &Path, state: &Path, log: &Path) {
	write_script(
		path,
		&format!(
			r#"case "$HOME" in
  {state}/provider/session) ;;
  *) exit 93 ;;
esac
[ -z "${{AMBIENT_SECRET+x}}" ]
case "$1:$2" in
  login:--method=universal-auth)
    [ "$INFISICAL_UNIVERSAL_AUTH_CLIENT_ID" = dedicated-client-id ]
    [ "$INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET" = bootstrap-secret-sentinel ]
    [ -z "${{INFISICAL_TOKEN+x}}" ]
    printf '%s\n' access-token-sentinel
    ;;
  secrets:get)
    [ "$#" -eq 14 ]
    [ "$INFISICAL_TOKEN" = access-token-sentinel ]
    [ -z "${{INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET+x}}" ]
    printf '%s\n' "$3" >>{log}
    case "$3" in
      RUNNER_SIGNING_KEY) printf '%s\n' runner-signing-sentinel ;;
      RUNNER_SUBMISSION_TOKEN) printf '%s\n' runner-submission-sentinel ;;
      VERIFIER_INGRESS_TOKEN) printf '%s\n' verifier-ingress-sentinel ;;
      VERIFIER_SIGNING_KEY) printf '%s\n' verifier-signing-sentinel ;;
      *) exit 94 ;;
    esac
    ;;
  *) exit 95 ;;
esac
"#,
			state = shell_quote(state),
			log = shell_quote(log),
		),
	);
}

#[allow(clippy::too_many_arguments)]
fn write_runtime_configuration(
	path: &Path,
	installed: &InstalledRelease,
	state: &Path,
	auth: &Path,
	infisical: &Path,
	timeout: &Path,
	security: &Path,
) {
	fs::write(
		path,
		serde_json::to_vec_pretty(&serde_json::json!({
			"schema_version": "aiq.continuous-observation-config.v2",
			"release_root": installed.release_root,
			"release_manifest_sha256": installed.release_manifest_sha256,
			"state_root": state,
			"codex_auth_source": auth,
			"endpoint": "https://aiq.wiki",
			"official_jobs": 32,
			"verifier_replay_jobs": 1,
			"speed_jobs": 1,
			"speed_trials": 1,
			"unattended_secrets": {
				"infisical_executable": infisical,
				"timeout_executable": timeout,
				"security_executable": security,
				"api_url": "http://127.0.0.1:51888",
				"project_id": "project-id",
				"client_id": "dedicated-client-id",
				"keychain_service": "infisical-selfhost",
				"keychain_account": "AIQ_OBSERVATION_UA_CLIENT_SECRET",
				"environment": "prod",
				"path": "/aiq",
				"selectors": {
					"runner_signing_key": "RUNNER_SIGNING_KEY",
					"runner_submission_token": "RUNNER_SUBMISSION_TOKEN",
					"verifier_ingress_token": "VERIFIER_INGRESS_TOKEN",
					"verifier_signing_key": "VERIFIER_SIGNING_KEY"
				}
			}
		}))
		.expect("runtime configuration"),
	)
	.expect("write runtime configuration");
	fs::set_permissions(path, Permissions::from_mode(0o600)).expect("runtime configuration mode");
}

fn private_directory(path: &Path) {
	fs::create_dir_all(path).expect("private directory");
	fs::set_permissions(path, Permissions::from_mode(0o700)).expect("private directory mode");
}

fn write_script(path: &Path, body: &str) {
	fs::write(path, format!("#!/bin/sh\nset -eu\n{body}")).expect("fixture script");
	fs::set_permissions(path, Permissions::from_mode(0o700)).expect("fixture script mode");
}

fn shell_quote(path: &Path) -> String {
	format!("'{}'", path.display().to_string().replace('\'', "'\\''"))
}

fn digest(path: &Path) -> String {
	format!("sha256:{:x}", Sha256::digest(fs::read(path).expect("digest input")))
}

fn git<const N: usize>(repository: &Path, arguments: [&str; N]) {
	let status = Command::new(GIT_EXECUTABLE)
		.args(["-C"])
		.arg(repository)
		.args(arguments)
		.status()
		.expect("fixture Git command");

	assert!(status.success());
}

fn git_stdout<const N: usize>(repository: &Path, arguments: [&str; N]) -> String {
	let output = Command::new(GIT_EXECUTABLE)
		.args(["-C"])
		.arg(repository)
		.args(arguments)
		.output()
		.expect("fixture Git output");

	assert!(output.status.success());

	String::from_utf8(output.stdout).expect("Git UTF-8").trim().to_owned()
}
