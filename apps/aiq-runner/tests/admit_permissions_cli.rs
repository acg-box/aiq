//! Public CLI contract for model-free Official permission admission.

use std::process::Command;

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
	] {
		assert!(stdout.contains(required), "help omits {required}");
	}
	assert!(stdout.contains("without invoking a model"));
	assert!(stdout.contains("does not reserve it"));
}
