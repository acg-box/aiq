//! Public CLI contract for model-free Official permission admission.

use std::process::Command;

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
		"--codex-binary",
		"--codex-home",
		"--codex-egress-proxy",
		"--artifact-root",
		"--preflight-cache",
		"--checkpoint",
		"--planned-output",
		"--output",
	] {
		assert!(stdout.contains(required), "help omits {required}");
	}

	assert!(stdout.contains("without invoking a model"));
	assert!(stdout.contains("does not reserve it"));
	assert!(stdout.contains("Durable private permission-admission JSON receipt"));
}

#[test]
fn managed_requirements_example_contains_only_the_exact_official_policy() {
	assert_eq!(
		include_str!("../../../config/codex-requirements.example.toml"),
		"allowed_permission_profiles.aiq_benchmark = true\ndefault_permissions                       = \"aiq_benchmark\"\n"
	);
}
