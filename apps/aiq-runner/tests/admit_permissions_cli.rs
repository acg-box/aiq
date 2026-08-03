//! Public CLI contract for model-free Official permission admission.

use std::process::Command;
#[cfg(unix)]
use std::{
	env,
	fs::{self, Permissions},
	os::unix::{fs::PermissionsExt as _, process::CommandExt as _},
	process,
	time::{SystemTime, UNIX_EPOCH},
};

use aiq_runner as _;
use clap as _;
use ed25519_dalek as _;
use hex as _;
use jiff as _;
use jiff_tzdb as _;
#[cfg(unix)]
use libc as _;
use serde as _;
use serde_json as _;
use serde_json_canonicalizer as _;
use sha2 as _;
use ureq as _;
#[cfg(windows)]
use windows_sys as _;

#[test]
fn admit_permissions_help_exposes_the_exact_planned_run_paths() {
	let output = Command::new(env!("CARGO_BIN_EXE_aiq-runner"))
		.args(["admit-permissions", "--help"])
		.output()
		.expect("run admit-permissions help");
	let stdout = String::from_utf8(output.stdout).expect("UTF-8 help output");

	assert!(output.status.success());

	for required in [
		"--hidden-tasks",
		"--corpus-commitment",
		"--source-root",
		"--capabilities",
		"--workspace-root",
		"--execution-root",
		"--evaluator-root",
		"--evaluator-runtime",
		"--codex-toolchain-root",
		"--schedule",
		"--slot-date",
		"--occurrence",
		"--observed-at",
		"--codex-binary",
		"--codex-home",
		"--artifact-root",
		"--preflight-cache",
		"--checkpoint",
		"--jobs",
		"--planned-output",
		"--planned-score-output",
		"--planned-package-output",
		"--output",
	] {
		assert!(stdout.contains(required), "help omits {required}");
	}

	assert!(stdout.contains("without invoking a model"));
	assert!(stdout.contains("does not reserve it"));
	assert!(stdout.contains("Durable private permission-admission JSON receipt"));
}

#[test]
fn official_direct_commands_expose_no_proxy_mode() {
	for command in ["admit-permissions", "preflight", "run"] {
		let output = Command::new(env!("CARGO_BIN_EXE_aiq-runner"))
			.args([command, "--help"])
			.output()
			.expect("run Official command help");
		let stdout = String::from_utf8(output.stdout).expect("UTF-8 help output");

		assert!(output.status.success());
		assert!(!stdout.contains("--codex-egress-proxy"));
		assert!(!stdout.to_ascii_lowercase().contains("proxy"));
	}
}

#[test]
fn runner_normalize_cannot_claim_evaluator_replay() {
	let output = Command::new(env!("CARGO_BIN_EXE_aiq-runner"))
		.args(["normalize", "--help"])
		.output()
		.expect("run normalize help");
	let stdout = String::from_utf8(output.stdout).expect("UTF-8 help output");

	assert!(output.status.success());
	assert!(!stdout.contains("evaluator-replayed"));
	assert!(stdout.contains("commitments-verified"));
	assert!(stdout.contains("failed"));
}

#[cfg(unix)]
#[test]
fn protected_output_uses_exact_private_mode_under_a_restrictive_child_umask() {
	let suffix = SystemTime::now().duration_since(UNIX_EPOCH).expect("fixture clock").as_nanos();
	let root = env::temp_dir().join(format!("aiq-output-mode-{}-{suffix}", process::id()));
	let output_path = root.join("matrix.json");

	fs::create_dir(&root).expect("fixture root");
	fs::set_permissions(&root, Permissions::from_mode(0o700)).expect("private fixture root");

	let mut command = Command::new(env!("CARGO_BIN_EXE_aiq-runner"));

	command.args(["matrix", "--output"]).arg(&output_path);
	// SAFETY: this closure runs in the forked child immediately before exec and
	// changes only the child process umask.
	unsafe {
		command.pre_exec(|| {
			libc::umask(0o200);

			Ok(())
		});
	}

	let output = command.output().expect("run matrix with restrictive child umask");

	assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
	assert_eq!(
		fs::metadata(&output_path).expect("protected output metadata").permissions().mode() & 0o777,
		0o600
	);

	fs::remove_dir_all(root).expect("fixture cleanup");
}
