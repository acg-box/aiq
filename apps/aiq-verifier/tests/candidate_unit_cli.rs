//! Executable-level coverage for the synthetic AIQ Core 1.0.2 candidate verifier path.

#![cfg(unix)]

use std::fs::Permissions;
use std::slice;
use std::{
	collections::BTreeMap,
	env, fs,
	os::unix::fs::PermissionsExt as _,
	path::{Path, PathBuf},
	process::{self, Command, Output},
	time::{SystemTime, UNIX_EPOCH},
};

use aiq_verifier as _;
use clap as _;
use ed25519_dalek::{Signer as _, SigningKey};
use libc as _;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest as _, Sha256};
use ureq as _;

use aiq_runner::{
	adapter::{
		self, ArtifactReference, AuthenticationProbe, CapabilityValidation,
		CapabilityValidationReport, CapabilityValidationStatus, CliProbe, ConfigurationProbe,
		ConfigurationProbeStatus, ProbeStatus,
	},
	candidate_artifacts::{
		CandidateEvaluatorResultBundle, CandidateResultPackageBundle, CandidateSigningIdentity,
	},
	candidate_release_gate::{
		self, CANDIDATE_CATALOG_RELEASE_IDENTITY_SHA256, CANDIDATE_CODEX_EGRESS_PROXY_ENDPOINT,
		CANDIDATE_MODEL_ID_MAPPING_SHA256, CANDIDATE_TASK_IDENTITY_SHA256,
		CANDIDATE_TRUST_POLICY_DIGEST_ENV, CandidateAuthorizationIdentity,
		CandidateControlledInputs, CandidateExecutionAuthorization, CandidateExecutionExpectations,
		CandidateExecutionPlan, CandidateExecutionUnit, CandidateOutputReservations,
		CandidatePlanInputs, CandidateRuntimeBindings, RELEASE_GATE_ADMISSION_SCHEMA,
		RELEASE_IDENTITY, ReleaseGateAdmissionSigner, ReleaseGateAdmissionV1,
		ReleaseGateContrastBinding, ReleaseGateModelConfiguration, ReleaseGateModelMatrix,
		ReleaseGateObservationUniverse, ReleaseGateRepeat, ReleaseGateRetryPolicy,
	},
	corpus_commitment::{
		CANDIDATE_CONTRAST_CATALOG_IDENTITY_SHA256, RunClass, RunProvenanceCommitment,
	},
	model::MODEL_MATRIX,
	protocol::{self, ResultProvenance, TrustTier},
	resume,
	runner::{
		self, CALIBRATION_RUN_SCHEMA_VERSION, CalibrationRunRecord,
		EVALUATOR_RESULTS_SCHEMA_VERSION, EvaluationOutcome, EvaluatorResultsBundle, Latency,
		RESULT_SCHEMA_VERSION, ResultStatus, TaskResult, WorkspaceManifest, WorkspaceSnapshot,
	},
	schedule::{ScheduleOccurrence, ScheduleSlot},
	scoring::AIQ_SCORING_VERSION,
	task::{
		self, EVALUATOR_PROTOCOL_VERSION, EVALUATOR_RESULT_SCHEMA_VERSION, EvaluationResult,
		Evaluator, EvaluatorCheck, EvaluatorCheckFailureClass, EvaluatorContext, EvaluatorOutcome,
		EvaluatorRuntime, EvaluatorRuntimeKind, ExternalEvaluatorBinding, NormalizedToolEvidence,
		TaskDefinition, Visibility,
	},
};

const VERIFIER_KEY_ENV: &str = "AIQ_TEST_CANDIDATE_VERIFIER_KEY";
const RESPONSE: &str = "SYNTHETIC_CANDIDATE_RESPONSE";
const VERIFIER_SECRET: [u8; 32] = [
	1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26,
	27, 28, 29, 30, 31, 32,
];
const WRONG_VERIFIER_SECRET: [u8; 32] = [
	32, 31, 30, 29, 28, 27, 26, 25, 24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9,
	8, 7, 6, 5, 4, 3, 2, 1,
];
const CONTRAST_TASK_IDS: [&str; 6] = [
	"contrast-coupled-challenge-01",
	"contrast-coupled-reference-01",
	"contrast-evidence-challenge-01",
	"contrast-evidence-reference-01",
	"contrast-recovery-challenge-01",
	"contrast-recovery-reference-01",
];

struct Fixture {
	_root: TestDirectory,
	authorization: CandidateExecutionAuthorization,
	unit: CandidateExecutionUnit,
	expectations_path: PathBuf,
	trust_policy_digest: String,
}
impl Fixture {
	fn new() -> Self {
		Self::new_with_verifier_digest(file_digest(Path::new(env!("CARGO_BIN_EXE_aiq-verifier"))))
	}

	fn new_with_verifier_digest(verifier_executable_sha256: String) -> Self {
		let root = TestDirectory::new();
		let (output_root, tasks_root, source_root, artifact_root, replay_root) =
			candidate_directories(&root);
		let CandidateEvaluatorFixture {
			evaluator_root,
			node,
			runtime,
			evaluator_digest,
			evaluator_stdout,
			tasks,
		} = candidate_evaluator_fixture(&root);

		write_candidate_tasks(&tasks_root, &tasks);

		let PreparedCandidatePlan {
			admission,
			admission_path,
			admission_digest,
			trust_policy_path,
			trust_policy_digest,
			manifest_path,
			manifest_digest,
			core_path,
			core_digest,
			contrast_path,
			contrast_digest,
			authorization_path,
			authorization_digest,
			authorization_identity,
			authorization,
			unit,
			runner,
		} = prepare_candidate_plan(PrepareCandidatePlanInputs {
			root: &root,
			output_root,
			tasks_root: &tasks_root,
			source_root: &source_root,
			artifact_root: &artifact_root,
			evaluator_root: &evaluator_root,
			node: &node,
			replay_root: &replay_root,
			runtime: &runtime,
			evaluator_digest: &evaluator_digest,
			tasks: &tasks,
			verifier_executable_sha256,
		});
		let selected_task = tasks
			.iter()
			.find(|task| task.task_id == unit.ordered_task_ids[0])
			.expect("selected task")
			.clone();
		let evaluator_stdout_digest =
			format!("sha256:{}", hex::encode(Sha256::digest(evaluator_stdout.as_bytes())));
		let evaluation = candidate_evaluation(Some(evaluator_stdout_digest.clone()));
		let evaluator_bundle = EvaluatorResultsBundle {
			schema_version: EVALUATOR_RESULTS_SCHEMA_VERSION.to_owned(),
			results: (0..MODEL_MATRIX.len()).map(|_| Some(evaluation.clone())).collect(),
		};
		let evaluator_bundle_bytes =
			protocol::canonical_json(&evaluator_bundle).expect("persisted evaluator results");
		let evaluator_results_reference =
			write_artifact(&artifact_root, "evaluator-results.json", &evaluator_bundle_bytes);
		let (manifest_reference, snapshot_reference) = workspace_artifacts(&artifact_root);
		let stdout_reference = write_artifact(
			&artifact_root,
			"stdout.jsonl",
			format!("{{\"type\":\"thread.started\"}}\n{{\"type\":\"item.completed\",\"item\":{{\"id\":\"message-1\",\"type\":\"agent_message\",\"text\":{RESPONSE:?}}}}}\n").as_bytes(),
		);
		let run = candidate_run(CandidateRunInputs {
			authorization: &authorization,
			unit: &unit,
			task: &selected_task,
			evaluator_results_artifact: evaluator_results_reference,
			manifest: &manifest_reference,
			snapshot: &snapshot_reference,
			stdout: &stdout_reference,
			evaluation,
			evaluator_stdout_sha256: evaluator_stdout_digest,
		});
		let results = CandidateResultPackageBundle::sign(&authorization, &unit, run, &runner)
			.expect("signed candidate results");
		let evaluators = CandidateEvaluatorResultBundle::sign(
			&authorization,
			&unit,
			&results,
			&evaluator_bundle,
			&runner,
		)
		.expect("signed candidate evaluators");

		fill_candidate_outputs(&authorization, &admission, &unit, &results, &evaluators);

		let expectations = CandidateExecutionExpectations {
			authorization_path,
			authorization_sha256: authorization_digest,
			authorization_signer_node_id: authorization_identity.signer().node_id.clone(),
			authorization_signer_public_key: authorization_identity.signer().public_key.clone(),
			signed_admission_path: admission_path,
			signed_admission_sha256: admission_digest,
			signed_admission_key_id: admission.signer.key_id.clone(),
			release_trust_policy_path: trust_policy_path,
			release_trust_policy_sha256: trust_policy_digest.clone(),
			execution_plan_sha256: admission.execution_plan_digest.clone(),
			corpus_manifest_path: manifest_path,
			corpus_manifest_sha256: manifest_digest,
			core_corpus_commitment_path: core_path,
			core_corpus_commitment_sha256: core_digest,
			contrast_corpus_commitment_path: contrast_path,
			contrast_corpus_commitment_sha256: contrast_digest,
			verifier_replay_root: replay_root,
			observed_at: "2026-08-02T01:30:00.000Z".to_owned(),
		};
		let expectations_path = root.path().join("expectations.json");

		write_canonical(&expectations_path, &expectations);

		Self { _root: root, authorization, unit, expectations_path, trust_policy_digest }
	}

	fn command(&self, expectations: &Path, key: [u8; 32]) -> Output {
		self.command_with_pin(expectations, key, &self.trust_policy_digest)
	}

	fn command_with_pin(&self, expectations: &Path, key: [u8; 32], pin: &str) -> Output {
		self.command_with_pin_and_tasks(
			expectations,
			key,
			pin,
			&self.authorization.plan.controlled_inputs.contrast_tasks_root,
		)
	}

	fn command_with_pin_and_tasks(
		&self,
		expectations: &Path,
		key: [u8; 32],
		pin: &str,
		tasks: &Path,
	) -> Output {
		let controlled = &self.authorization.plan.controlled_inputs;

		Command::new(env!("CARGO_BIN_EXE_aiq-verifier"))
			.args(["verify-candidate-unit", "--expectations"])
			.arg(expectations)
			.args(["--unit-id", &self.unit.unit_id, "--tasks"])
			.arg(tasks)
			.args(["--source-root"])
			.arg(&controlled.source_root)
			.args(["--artifact-root"])
			.arg(&controlled.artifact_root)
			.args(["--evaluator-root"])
			.arg(&controlled.evaluator_root)
			.args(["--evaluator-runtime"])
			.arg(&controlled.evaluator_runtime)
			.args(["--replay-root"])
			.arg(&controlled.verifier_replay_root)
			.args(["--signing-key-env", VERIFIER_KEY_ENV])
			.env(VERIFIER_KEY_ENV, hex::encode(key))
			.env(CANDIDATE_TRUST_POLICY_DIGEST_ENV, pin)
			.output()
			.expect("candidate verifier command")
	}
}

struct CandidateEvaluatorFixture {
	evaluator_root: PathBuf,
	node: PathBuf,
	runtime: EvaluatorRuntime,
	evaluator_digest: String,
	evaluator_stdout: String,
	tasks: Vec<TaskDefinition>,
}

struct PrepareCandidatePlanInputs<'a> {
	root: &'a TestDirectory,
	output_root: PathBuf,
	tasks_root: &'a Path,
	source_root: &'a Path,
	artifact_root: &'a Path,
	evaluator_root: &'a Path,
	node: &'a Path,
	replay_root: &'a Path,
	runtime: &'a EvaluatorRuntime,
	evaluator_digest: &'a str,
	tasks: &'a [TaskDefinition],
	verifier_executable_sha256: String,
}

struct PreparedCandidatePlan {
	admission: ReleaseGateAdmissionV1,
	admission_path: PathBuf,
	admission_digest: String,
	trust_policy_path: PathBuf,
	trust_policy_digest: String,
	manifest_path: PathBuf,
	manifest_digest: String,
	core_path: PathBuf,
	core_digest: String,
	contrast_path: PathBuf,
	contrast_digest: String,
	authorization_path: PathBuf,
	authorization_digest: String,
	authorization_identity: CandidateAuthorizationIdentity,
	authorization: CandidateExecutionAuthorization,
	unit: CandidateExecutionUnit,
	runner: CandidateSigningIdentity,
}

struct CandidateRunInputs<'a> {
	authorization: &'a CandidateExecutionAuthorization,
	unit: &'a CandidateExecutionUnit,
	task: &'a TaskDefinition,
	evaluator_results_artifact: ArtifactReference,
	manifest: &'a ArtifactReference,
	snapshot: &'a ArtifactReference,
	stdout: &'a ArtifactReference,
	evaluation: EvaluationResult,
	evaluator_stdout_sha256: String,
}

struct ControlledInputFixture<'a> {
	root: &'a Path,
	tasks_root: &'a Path,
	source_root: &'a Path,
	artifact_root: &'a Path,
	evaluator_root: &'a Path,
	node: &'a Path,
	replay_root: &'a Path,
	runner: &'a CandidateSigningIdentity,
	verifier: &'a CandidateSigningIdentity,
}

struct TestDirectory(PathBuf);
impl TestDirectory {
	fn new() -> Self {
		let nonce = SystemTime::now().duration_since(UNIX_EPOCH).expect("clock").as_nanos();
		let path =
			env::temp_dir().join(format!("aiq-verifier-candidate-cli-{}-{nonce}", process::id()));

		fs::create_dir(&path).expect("test directory");
		fs::set_permissions(&path, Permissions::from_mode(0o700)).expect("test permissions");

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

fn candidate_directories(root: &TestDirectory) -> (PathBuf, PathBuf, PathBuf, PathBuf, PathBuf) {
	(
		create_directory(root.path().join("outputs")),
		create_directory(root.path().join("hidden-contrast-tasks")),
		create_directory(root.path().join("controlled-source")),
		create_directory(root.path().join("artifacts")),
		create_directory(root.path().join("verifier-replay")),
	)
}

fn write_candidate_tasks(tasks_root: &Path, tasks: &[TaskDefinition]) {
	for (index, task) in tasks.iter().enumerate() {
		write_canonical(&tasks_root.join(format!("{index:02}.json")), task);
	}
}

#[test]
fn verify_candidate_unit_command_fills_idempotently_and_fails_closed() {
	let fixture = Fixture::new();
	let verifier_output = &fixture.unit.outputs.verifier_replay_bundle;

	assert_eq!(fs::metadata(verifier_output).expect("held verifier reservation").len(), 0);

	let first = fixture.command(&fixture.expectations_path, VERIFIER_SECRET);

	assert_success(&first, "first verifier invocation");

	let replay = fs::read(verifier_output).expect("filled verifier replay");

	assert!(!replay.is_empty());

	let replay_value: Value = serde_json::from_slice(&replay).expect("replay JSON");

	assert_eq!(replay_value["cells"].as_array().expect("replay cells").len(), 17);
	assert!(replay_value["cells"].as_array().expect("replay cells").iter().all(|cell| {
		cell["payload"]["disposition"] == "candidate_evaluator_replayed"
			&& cell["payload"]["verified"] == true
	}));

	let second = fixture.command(&fixture.expectations_path, VERIFIER_SECRET);

	assert_success(&second, "idempotent verifier invocation");

	assert_eq!(fs::read(verifier_output).expect("idempotent replay"), replay);

	let wrong_digest_fixture = Fixture::new_with_verifier_digest(digest("wrong-verifier"));
	let before = output_snapshot(&wrong_digest_fixture.authorization.plan);
	let wrong_digest =
		wrong_digest_fixture.command(&wrong_digest_fixture.expectations_path, VERIFIER_SECRET);

	assert!(!wrong_digest.status.success());

	assert_stderr_contains(
		&wrong_digest,
		"candidate verifier executable does not match the signed private plan",
	);

	assert_eq!(output_snapshot(&wrong_digest_fixture.authorization.plan), before);

	let before = output_snapshot(&fixture.authorization.plan);
	let wrong_pin = fixture.command_with_pin(
		&fixture.expectations_path,
		VERIFIER_SECRET,
		&digest("wrong-trust-pin"),
	);

	assert!(!wrong_pin.status.success());

	assert_stderr_contains(
		&wrong_pin,
		"candidate protected release trust-policy digest does not match the signed plan",
	);

	assert_eq!(output_snapshot(&fixture.authorization.plan), before);

	let before = output_snapshot(&fixture.authorization.plan);
	let wrong_identity = fixture.command(&fixture.expectations_path, WRONG_VERIFIER_SECRET);

	assert!(!wrong_identity.status.success());

	assert_stderr_contains(
		&wrong_identity,
		"candidate verifier identity is not the distinct authorized verifier",
	);

	assert_eq!(output_snapshot(&fixture.authorization.plan), before);
}

#[test]
fn verify_candidate_unit_checks_trust_before_hidden_input_paths() {
	let fixture = Fixture::new();
	let missing_tasks = fixture._root.path().join("missing-hidden-tasks");
	let hidden_tasks_alias = fixture._root.path().join("hidden-tasks-alias");

	std::os::unix::fs::symlink(
		&fixture.authorization.plan.controlled_inputs.contrast_tasks_root,
		&hidden_tasks_alias,
	)
	.expect("hidden task symlink");

	let before = output_snapshot(&fixture.authorization.plan);

	for tasks in [&missing_tasks, &hidden_tasks_alias] {
		let output = fixture.command_with_pin_and_tasks(
			&fixture.expectations_path,
			VERIFIER_SECRET,
			&digest("wrong-trust-pin"),
			tasks,
		);

		assert!(!output.status.success());

		assert_stderr_contains(
			&output,
			"candidate protected release trust-policy digest does not match the signed plan",
		);

		assert_eq!(output_snapshot(&fixture.authorization.plan), before);

		let output = fixture.command_with_pin_and_tasks(
			&fixture.expectations_path,
			WRONG_VERIFIER_SECRET,
			&fixture.trust_policy_digest,
			tasks,
		);

		assert!(!output.status.success());

		assert_stderr_contains(
			&output,
			"candidate verifier identity is not the distinct authorized verifier",
		);

		assert_eq!(output_snapshot(&fixture.authorization.plan), before);
	}
}

#[test]
fn verify_candidate_unit_checks_trust_before_private_authorization() {
	let fixture = Fixture::new();
	let mut expectations: CandidateExecutionExpectations = serde_json::from_slice(
		&fs::read(&fixture.expectations_path).expect("candidate expectations"),
	)
	.expect("candidate expectations JSON");

	expectations.authorization_path =
		fixture._root.path().join("missing-private-authorization.json");

	let sentinel = fixture._root.path().join("untrusted-expectations.json");

	write_canonical(&sentinel, &expectations);

	let output = fixture.command_with_pin(&sentinel, VERIFIER_SECRET, &digest("wrong-trust-pin"));

	assert!(!output.status.success());

	assert_stderr_contains(
		&output,
		"candidate protected release trust-policy digest does not match the signed plan",
	);
}

#[test]
fn verify_candidate_unit_checks_role_before_private_corpus_and_outputs() {
	let fixture = Fixture::new();

	fs::remove_file(&fixture.authorization.plan.contrast_corpus_commitment_path)
		.expect("remove private corpus sentinel");

	let before = output_snapshot(&fixture.authorization.plan);
	let output = fixture.command(&fixture.expectations_path, WRONG_VERIFIER_SECRET);

	assert!(!output.status.success());

	assert_stderr_contains(
		&output,
		"candidate verifier identity is not the distinct authorized verifier",
	);

	assert_eq!(output_snapshot(&fixture.authorization.plan), before);
}

#[test]
fn verify_candidate_unit_rejects_noncanonical_expectations_without_output_changes() {
	let fixture = Fixture::new();
	let value: Value = serde_json::from_slice(
		&fs::read(&fixture.expectations_path).expect("canonical expectations"),
	)
	.expect("expectations JSON");
	let noncanonical_path = fixture._root.path().join("noncanonical-expectations.json");

	fs::write(&noncanonical_path, serde_json::to_vec_pretty(&value).expect("pretty expectations"))
		.expect("noncanonical expectations");

	let before = output_snapshot(&fixture.authorization.plan);
	let output = fixture.command(&noncanonical_path, VERIFIER_SECRET);

	assert!(!output.status.success());

	assert_stderr_contains(&output, "candidate execution expectations are not canonical JSON");

	assert_eq!(output_snapshot(&fixture.authorization.plan), before);
}

fn fill_candidate_outputs(
	authorization: &CandidateExecutionAuthorization,
	admission: &ReleaseGateAdmissionV1,
	unit: &CandidateExecutionUnit,
	results: &CandidateResultPackageBundle,
	evaluators: &CandidateEvaluatorResultBundle,
) {
	let mut reservations = CandidateOutputReservations::reserve(&authorization.plan, admission)
		.expect("held plan reservations");

	reservations
		.fill(&format!("{}/result_package_bundle", unit.unit_id), &canonical_document(results))
		.expect("result reservation");
	reservations
		.fill(&format!("{}/evaluator_result_bundle", unit.unit_id), &canonical_document(evaluators))
		.expect("evaluator reservation");
}

fn candidate_evaluator_fixture(root: &TestDirectory) -> CandidateEvaluatorFixture {
	let evaluator_root = create_directory(root.path().join("evaluators"));
	let installed_node = find_node_runtime();
	let node = root.path().join("node-runtime");
	let escaped_node = installed_node.to_string_lossy().replace('\'', "'\\''");

	fs::write(&node, format!("#!/bin/sh\nexec '{escaped_node}' \"$@\"\n"))
		.expect("controlled Node runtime wrapper");
	fs::set_permissions(&node, Permissions::from_mode(0o700)).expect("Node runtime permissions");

	let node = fs::canonicalize(node).expect("controlled Node runtime");
	let runtime = EvaluatorRuntime::resolve(&node).expect("Node evaluator runtime");
	let evaluation_without_stdout = candidate_evaluation(None);
	let evaluator_stdout = format!(
		"{}\n",
		String::from_utf8(
			protocol::canonical_json(&evaluation_without_stdout).expect("evaluator JSON")
		)
		.expect("UTF-8 evaluator JSON")
	);
	let evaluator_script = format!(
		"import fs from 'node:fs';fs.readFileSync(0);process.stdout.write({:?});\n",
		evaluator_stdout
	);
	let evaluator_path = evaluator_root.join("synthetic-evaluator.mjs");

	fs::write(&evaluator_path, evaluator_script.as_bytes()).expect("synthetic evaluator");
	fs::set_permissions(&evaluator_path, Permissions::from_mode(0o700))
		.expect("evaluator permissions");

	let evaluator_digest = file_digest(&evaluator_path);
	let configuration = BTreeMap::new();
	let evaluator_binding = ExternalEvaluatorBinding {
		protocol_version: EVALUATOR_PROTOCOL_VERSION.to_owned(),
		scorer_version: "1.0.2".to_owned(),
		runtime_kind: EvaluatorRuntimeKind::Node,
		runtime_executable_digest: runtime.executable_digest().to_owned(),
		executable_ref: PathBuf::from("synthetic-evaluator.mjs"),
		executable_digest: evaluator_digest.clone(),
		configuration_digest: protocol::canonical_hash(&configuration)
			.expect("evaluator configuration digest"),
		arguments: Vec::new(),
		timeout_ms: 2_000,
		max_input_bytes: 64 * 1_024,
		max_output_bytes: 64 * 1_024,
		configuration,
	};
	let evaluator_probe_workspace = create_directory(root.path().join("evaluator-probe-workspace"));
	let empty_tool_evidence =
		NormalizedToolEvidence { steps: 0, total_calls: 0, by_tool: BTreeMap::new() };
	let evaluator_probe_manifest = digest("probe-manifest");
	let evaluator_probe_context = EvaluatorContext {
		task_id: CONTRAST_TASK_IDS[0],
		task_version: "1.0.2",
		run_id: "synthetic-evaluator-probe",
		model: MODEL_MATRIX[0],
		final_response: RESPONSE,
		candidate_workspace: &evaluator_probe_workspace,
		workspace_manifest_sha256: &evaluator_probe_manifest,
		tool_evidence: &empty_tool_evidence,
	};

	evaluator_binding
		.evaluate_at_root(
			"repository_test_suite",
			&evaluator_probe_context,
			evaluator_root.as_path(),
			&runtime,
		)
		.unwrap_or_else(|error| panic!("synthetic evaluator probe failed: {error}"));

	let tasks = synthetic_contrast_tasks(&evaluator_binding);

	CandidateEvaluatorFixture {
		evaluator_root,
		node,
		runtime,
		evaluator_digest,
		evaluator_stdout,
		tasks,
	}
}

fn prepare_candidate_plan(inputs: PrepareCandidatePlanInputs<'_>) -> PreparedCandidatePlan {
	let root = inputs.root.path();
	let runner_source = inputs.source_root.join("apps/aiq-runner/src/runner.rs");

	fs::create_dir_all(runner_source.parent().expect("runner source parent"))
		.expect("source hierarchy");
	fs::write(&runner_source, b"synthetic verifier command fixture\n").expect("synthetic source");

	let contrast_commitment =
		contrast_commitment(inputs.tasks, inputs.runtime, inputs.evaluator_digest, &runner_source);
	let contrast_path = root.join("contrast-commitment.json");
	let contrast_digest = write_canonical(&contrast_path, &contrast_commitment);
	let core_path = root.join("core-commitment.json");
	let core_digest =
		write_canonical(&core_path, &serde_json::json!({"synthetic_test_core_pin": true}));
	let manifest_path = root.join("corpus-manifest.json");
	let manifest = serde_json::json!({
		"schema_version": "aiq.release-gate-corpus-manifest.v1",
		"release_identity": RELEASE_IDENTITY,
		"catalog_release_identity_digest": CANDIDATE_CATALOG_RELEASE_IDENTITY_SHA256,
		"task_metadata_identity_digest": CANDIDATE_TASK_IDENTITY_SHA256,
		"canonicalization": "aiq.sorted-key-json.v1",
		"core_task_count": 72,
		"contrast_task_count": 6,
		"core_corpus_commitment_sha256": core_digest,
		"contrast_corpus_commitment_sha256": contrast_digest,
	});
	let manifest_digest = write_canonical(&manifest_path, &manifest);
	let authority = SigningKey::from_bytes(&[30; 32]);
	let trust_policy_path = root.join("trust-policy.json");
	let trust_policy_digest = write_canonical(&trust_policy_path, &trust_policy(&authority));
	let mut admission = admission(&manifest_digest);

	admission.signature = sign_without_signature(&admission, &authority);

	let admission_path = root.join("admission.json");
	let admission_digest = write_canonical(&admission_path, &admission);
	let runner = CandidateSigningIdentity::from_secret([32; 32]);
	let verifier = CandidateSigningIdentity::from_secret(VERIFIER_SECRET);
	let controlled_inputs = controlled_inputs(ControlledInputFixture {
		root,
		tasks_root: inputs.tasks_root,
		source_root: inputs.source_root,
		artifact_root: inputs.artifact_root,
		evaluator_root: inputs.evaluator_root,
		node: inputs.node,
		replay_root: inputs.replay_root,
		runner: &runner,
		verifier: &verifier,
	});
	let authorization_path = root.join("authorization.json");
	let runtime = candidate_runtime_bindings(&inputs, &contrast_commitment);
	let plan = candidate_release_gate::build_candidate_execution_plan(
		&admission,
		CandidatePlanInputs {
			signed_admission_path: admission_path.clone(),
			signed_admission_sha256: admission_digest.clone(),
			signed_admission_key_id: admission.signer.key_id.clone(),
			release_trust_policy_path: trust_policy_path.clone(),
			release_trust_policy_sha256: trust_policy_digest.clone(),
			corpus_manifest_path: manifest_path.clone(),
			corpus_manifest_sha256: manifest_digest.clone(),
			core_corpus_commitment_path: core_path.clone(),
			core_corpus_commitment_sha256: core_digest.clone(),
			contrast_corpus_commitment_path: contrast_path.clone(),
			contrast_corpus_commitment_sha256: contrast_digest.clone(),
			authorization_path: authorization_path.clone(),
			runtime,
			controlled_inputs,
			output_root: inputs.output_root,
		},
	)
	.expect("candidate execution plan");
	let unit = plan
		.execution_units
		.iter()
		.find(|unit| unit.unit_id == "repeat-01-contrast-01-reference")
		.expect("selected contrast unit")
		.clone();
	let authorization_identity = CandidateAuthorizationIdentity::from_secret([31; 32]);
	let authorization = authorization_identity.authorize(plan, &admission).expect("authorization");
	let authorization_digest = candidate_release_gate::write_execution_authorization_create_once(
		&authorization_path,
		&authorization,
		&admission,
		&authorization_identity.signer().node_id,
		&authorization_identity.signer().public_key,
	)
	.expect("authorization output");

	PreparedCandidatePlan {
		admission,
		admission_path,
		admission_digest,
		trust_policy_path,
		trust_policy_digest,
		manifest_path,
		manifest_digest,
		core_path,
		core_digest,
		contrast_path,
		contrast_digest,
		authorization_path,
		authorization_digest,
		authorization_identity,
		authorization,
		unit,
		runner,
	}
}

fn candidate_runtime_bindings(
	inputs: &PrepareCandidatePlanInputs<'_>,
	contrast_commitment: &Value,
) -> CandidateRuntimeBindings {
	CandidateRuntimeBindings {
		runner_executable_sha256: digest("synthetic-runner"),
		verifier_executable_sha256: inputs.verifier_executable_sha256.clone(),
		evaluator_runtime_sha256: inputs.runtime.executable_digest().to_owned(),
		core_harness_sha256: digest("core-harness"),
		core_tool_policy_sha256: digest("core-tool-policy"),
		core_network_policy_sha256: digest("core-network-policy"),
		contrast_harness_sha256: contrast_commitment["execution"]["harness_sha256"]
			.as_str()
			.expect("contrast harness")
			.to_owned(),
		contrast_tool_policy_sha256:
			contrast_commitment["execution"]["declared_tool_policy_sha256"]
				.as_str()
				.expect("contrast tool policy")
				.to_owned(),
		contrast_network_policy_sha256:
			contrast_commitment["execution"]["declared_network_policy_sha256"]
				.as_str()
				.expect("contrast network policy")
				.to_owned(),
	}
}

fn candidate_run(inputs: CandidateRunInputs<'_>) -> CalibrationRunRecord {
	let CandidateRunInputs {
		authorization,
		unit,
		task,
		evaluator_results_artifact,
		manifest,
		snapshot,
		stdout,
		evaluation,
		evaluator_stdout_sha256,
	} = inputs;
	let schedule_slot = candidate_schedule_slot();
	let models = MODEL_MATRIX.to_vec();
	let task_set_hash = task::task_set_hash(slice::from_ref(task)).expect("task-set hash");
	let run_id = resume::classified_run_id(
		&schedule_slot,
		&task_set_hash,
		&unit.corpus_commitment_sha256,
		&models,
		RunClass::Calibration,
	)
	.expect("candidate run ID");
	let preflight = capability_report(&authorization.plan.controlled_inputs.runner_signer_node_id);
	let preflight_digest = protocol::canonical_hash(&preflight).expect("preflight digest");
	let runtime = &authorization.plan.runtime;
	let provenance = RunProvenanceCommitment {
		schema_version: "aiq.run-provenance.v2".to_owned(),
		run_class: RunClass::Calibration,
		corpus_release_id: "corpus_candidate_contrast_1.0.2".to_owned(),
		corpus_commitment_sha256: unit.corpus_commitment_sha256.clone(),
		catalog_digest: CANDIDATE_CONTRAST_CATALOG_IDENTITY_SHA256.to_owned(),
		task_set_digest: task_set_hash.clone(),
		evaluator_digest: digest("evaluator-set"),
		runtime_digest: digest("runtime"),
		preflight_digest,
		harness_digest: runtime.contrast_harness_sha256.clone(),
		prompt_digest: digest("prompt"),
		tool_policy_digest: runtime.contrast_tool_policy_sha256.clone(),
		network_policy_digest: runtime.contrast_network_policy_sha256.clone(),
		environment_digest: digest("environment"),
		source_manifest_digest: digest("source-manifest"),
		runner_executable_digest: runtime.runner_executable_sha256.clone(),
		codex_executable_digest: digest("codex"),
		permission_evidence_digest: digest("permissions"),
	};
	let evaluation_digest = protocol::canonical_hash(&evaluation).expect("evaluation digest");
	let task_hash = task.content_hash().expect("task digest");
	let stdout_text = fs::read_to_string(
		authorization
			.plan
			.controlled_inputs
			.artifact_root
			.join(stdout.content_hash.trim_start_matches("sha256:"))
			.join(&stdout.kind),
	)
	.expect("stdout artifact");
	let tool_usage = runner::parse_codex_tool_usage(&stdout_text);
	let results = models
		.iter()
		.map(|model| {
			let mut result = TaskResult {
				schema_version: RESULT_SCHEMA_VERSION.to_owned(),
				result_id: String::new(),
				run_id: run_id.clone(),
				task_id: task.task_id.clone(),
				task_version: task.task_version.clone(),
				task_hash: task_hash.clone(),
				model: *model,
				status: ResultStatus::Completed,
				evaluation: EvaluationOutcome::Correct,
				task_score: Some(1.0),
				response: Some(RESPONSE.to_owned()),
				response_sha256: Some(digest(RESPONSE)),
				evaluator_result_sha256: Some(evaluation_digest.clone()),
				evaluator_stdout_sha256: Some(evaluator_stdout_sha256.clone()),
				artifacts: vec![snapshot.clone(), stdout.clone()],
				failure: None,
				latency: Latency { wall_ms: 1 },
				tool_usage: tool_usage.clone(),
				evaluator_checks: evaluation.checks.clone(),
				workspace_manifest: Some(manifest.clone()),
				provenance: ResultProvenance {
					node_id: preflight.node_id.clone(),
					runner_version: "synthetic-test-runner".to_owned(),
					codex_version: "synthetic-test-codex".to_owned(),
					observed_at: "unix-ms:1".to_owned(),
					synthetic: false,
					local_trust: TrustTier::Untrusted,
				},
			};

			result.result_id = format!(
				"result_{}",
				result.content_hash().expect("result hash").trim_start_matches("sha256:")
			);

			result
		})
		.collect();

	CalibrationRunRecord {
		schema_version: CALIBRATION_RUN_SCHEMA_VERSION.to_owned(),
		official_eligible: false,
		classification: "local_calibration_non_official".to_owned(),
		run_id,
		schedule_slot,
		task_set_hash,
		scoring_version: AIQ_SCORING_VERSION.to_owned(),
		execution_concurrency: Some(1),
		models,
		task_ids: vec![task.task_id.clone()],
		started_unix_ms: 1,
		finished_unix_ms: 2,
		capability_validation: preflight,
		provenance,
		evaluator_results_artifact,
		results,
	}
}

fn candidate_schedule_slot() -> ScheduleSlot {
	ScheduleSlot {
		local_date: "2026-08-02".to_owned(),
		occurrence: ScheduleOccurrence::Day,
		local_time: "01:00".to_owned(),
		timezone: "UTC".to_owned(),
	}
}

fn capability_report(node_id: &str) -> CapabilityValidationReport {
	let version = "synthetic-test-codex".to_owned();
	let preview = "AIQ_PREFLIGHT_OK".to_owned();
	let preview_digest = digest(&preview);
	let models = MODEL_MATRIX
		.into_iter()
		.map(|model| {
			let observed_at = "unix-ms:1".to_owned();
			let evidence_digest = adapter::configuration_evidence_digest(
				model,
				Some(&version),
				&observed_at,
				ConfigurationProbeStatus::Available,
				Some(&preview_digest),
				Some(&preview),
				&[],
				None,
			)
			.expect("configuration evidence");

			CapabilityValidation {
				model,
				status: CapabilityValidationStatus::Available,
				reason: "synthetic test capability".to_owned(),
				probe: ConfigurationProbe {
					status: ConfigurationProbeStatus::Available,
					codex_version: Some(version.clone()),
					observed_at,
					result_digest: Some(preview_digest.clone()),
					result_preview: Some(preview.clone()),
					artifacts: Vec::new(),
					evidence_digest,
					failure: None,
				},
			}
		})
		.collect();

	CapabilityValidationReport {
		schema_version: "aiq.capability-validation.v2".to_owned(),
		node_id: node_id.to_owned(),
		manifest_issues: Vec::new(),
		cli_probe: CliProbe {
			status: ProbeStatus::Available,
			version: Some(version),
			failure: None,
		},
		authentication_probe: AuthenticationProbe {
			status: ProbeStatus::Available,
			mode: Some("chatgpt_subscription".to_owned()),
			failure: None,
		},
		models,
	}
}

fn candidate_evaluation(raw_stdout_sha256: Option<String>) -> EvaluationResult {
	let weights = [750_u32, 625, 625, 500];
	let checks = weights
		.into_iter()
		.enumerate()
		.flat_map(|(component, weight)| {
			(1..=4).map(move |assertion| EvaluatorCheck {
				check_id: format!("component_{:02}_assertion_{assertion:02}", component + 1),
				weight,
				passed: true,
				failure_class: EvaluatorCheckFailureClass::None,
				evidence_digest: digest(&format!("evidence-{component}-{assertion}")),
			})
		})
		.collect();

	EvaluationResult {
		schema_version: EVALUATOR_RESULT_SCHEMA_VERSION.to_owned(),
		outcome: EvaluatorOutcome::Correct,
		score: 1.0,
		checks,
		raw_stdout_sha256,
	}
}

fn synthetic_contrast_tasks(binding: &ExternalEvaluatorBinding) -> Vec<TaskDefinition> {
	let mut tasks = runner::synthetic_demo_tasks()[..6].to_vec();

	for (task, task_id) in tasks.iter_mut().zip(CONTRAST_TASK_IDS) {
		task.task_id = task_id.to_owned();
		task.task_version = "1.0.2".to_owned();
		task.scorer_version = "1.0.2".to_owned();
		task.visibility = Visibility::Hidden;
		task.catalog_entry_digest = Some(digest(&format!("catalog-{task_id}")));
		task.evaluator = Some(Evaluator {
			kind: "repository_test_suite".to_owned(),
			expected: None,
			case_sensitive: false,
			external: Some(binding.clone()),
		});
	}

	tasks
}

fn contrast_commitment(
	tasks: &[TaskDefinition],
	runtime: &EvaluatorRuntime,
	evaluator_digest: &str,
	runner_source: &Path,
) -> Value {
	let source_sha = file_digest(runner_source);
	let source_manifest = serde_json::json!({
		"schema_version": "aiq.runner-source-manifest.v1",
		"package": "aiq-runner",
		"scope": "cargo_build_and_test_inputs",
		"path_base": "repository_root",
		"entries": [{"path": "apps/aiq-runner/src/runner.rs", "sha256": source_sha}],
	});
	let model_toolchain = serde_json::json!({
		"schema_version": "aiq.execution-tool-policy.v1",
		"platform": match env::consts::OS { "macos" => "darwin", other => other },
		"architecture": match env::consts::ARCH { "aarch64" => "arm64", "x86_64" => "x64", other => other },
		"platform_minimal_path": match env::consts::OS { "macos" => "darwin_v1", "linux" => "linux_v1", _ => "windows_v1" },
		"inherit_path": false,
		"use_shell_profile": false,
		"commands": [
			{"name": "node", "executable_ref": "node", "executable_sha256": runtime.executable_digest(), "version": runtime.version()},
			{"name": "rg", "executable_ref": "rg", "executable_sha256": digest("rg"), "version": "synthetic-rg"},
		],
	});
	let runtime_provenance = serde_json::json!({
		"runner": {
			"source_manifest": source_manifest,
			"source_manifest_sha256": protocol::canonical_hash(&source_manifest).expect("source manifest digest"),
		},
		"node_runtime": {"executable_sha256": runtime.executable_digest(), "version": runtime.version()},
		"model_toolchain": model_toolchain,
	});
	let tool_tasks = tasks
		.iter()
		.map(
			|task| serde_json::json!({"task_id": task.task_id, "allowed_tools": task.allowed_tools}),
		)
		.collect::<Vec<_>>();
	let tool_policy_sha256 = protocol::canonical_hash(&serde_json::json!({
		"protocol": "aiq.tool-policy.v1",
		"evidence_class": "declared_policy_commitment",
		"catalog": tool_tasks,
		"model_toolchain": model_toolchain,
	}))
	.expect("tool policy digest");
	let network_policy_sha256 = protocol::canonical_hash(&serde_json::json!({
		"protocol": "aiq.network-policy.v1",
		"evidence_class": "declared_policy_commitment",
		"codex_web_search": "disabled_for_controlled_corpus",
		"codex_mcp": "disabled",
		"evaluator_node_scenario": "network_denied_by_node_permission_model",
	}))
	.expect("network policy digest");
	let committed_tasks = tasks
		.iter()
		.map(|task| serde_json::json!({
			"task_id": task.task_id,
			"task_version": task.task_version,
			"task_definition_sha256": task.content_hash().expect("task digest"),
			"baseline_workspace_tree_sha256": digest(&format!("workspace-{}", task.task_id)),
			"fixture_bundle_sha256": digest(&format!("fixture-{}", task.task_id)),
			"catalog_entry_sha256": task.catalog_entry_digest.as_ref().expect("catalog digest"),
			"evaluator_runtime_kind": "node",
			"evaluator_runtime_executable_sha256": runtime.executable_digest(),
			"evaluator_executable_sha256": evaluator_digest,
			"evaluator_configuration_sha256": task.evaluator.as_ref().expect("evaluator").external.as_ref().expect("binding").configuration_digest,
			"acceptance_suite_sha256": digest(&format!("acceptance-{}", task.task_id)),
			"leakage_review_sha256": digest(&format!("leakage-{}", task.task_id)),
		}))
		.collect::<Vec<_>>();

	serde_json::json!({
		"schema_version": "aiq.corpus-commitment.v2",
		"release_id": "corpus_candidate_contrast_1.0.2",
		"controlled": true,
		"synthetic": false,
		"catalog": {
			"schema_version": "aiq.candidate-contrast-manifest.v1",
			"task_set_id": "aiq-core-contrast-arms",
			"task_set_version": "1.0.2",
			"identity_sha256": CANDIDATE_CONTRAST_CATALOG_IDENTITY_SHA256,
			"identity_scope": "ordered_six_plan_bound_contrast_variants",
		},
		"execution": {
			"harness_sha256": digest("contrast-harness"),
			"runner_prompt_source_sha256": source_sha,
			"declared_tool_policy_sha256": tool_policy_sha256,
			"declared_network_policy_sha256": network_policy_sha256,
			"environment_sha256": protocol::canonical_hash(&runtime_provenance).expect("environment digest"),
			"runtime_provenance": runtime_provenance,
		},
		"tasks": committed_tasks,
	})
}

fn admission(corpus_manifest_digest: &str) -> ReleaseGateAdmissionV1 {
	let configurations = MODEL_MATRIX
		.into_iter()
		.map(|model| {
			let value = serde_json::to_value(model).expect("model");
			let family = value["family"].as_str().expect("family");
			let effort = value["reasoning_effort"].as_str().expect("effort");

			ReleaseGateModelConfiguration {
				model_id: format!("{family}-{effort}"),
				family: family.to_owned(),
				reasoning_effort: effort.to_owned(),
				execution_model_id: format!("gpt-5.6-{family}-{effort}"),
			}
		})
		.collect::<Vec<_>>();
	let mut sorted = configurations.clone();

	sorted.sort_by(|left, right| left.model_id.cmp(&right.model_id));

	let contrasts =
		["coupled_constraints", "ambiguous_recovery_state", "plausible_incomplete_evidence"];

	ReleaseGateAdmissionV1 {
		schema_version: RELEASE_GATE_ADMISSION_SCHEMA.to_owned(),
		signature_domain: RELEASE_GATE_ADMISSION_SCHEMA.to_owned(),
		signature_encoding: "aiq.sorted-key-json.v1".to_owned(),
		release_identity: RELEASE_IDENTITY.to_owned(),
		catalog_release_identity_digest: CANDIDATE_CATALOG_RELEASE_IDENTITY_SHA256.to_owned(),
		task_metadata_identity_digest: CANDIDATE_TASK_IDENTITY_SHA256.to_owned(),
		corpus_commitment_digest: corpus_manifest_digest.to_owned(),
		plan_id: "synthetic-candidate-verifier-test".to_owned(),
		execution_plan_digest: digest("execution-plan"),
		model_id_mapping_digest: CANDIDATE_MODEL_ID_MAPPING_SHA256.to_owned(),
		issued_at: "2026-08-01T00:00:00.000Z".to_owned(),
		collection_not_before: "2026-08-02T00:00:00.000Z".to_owned(),
		collection_not_after: "2026-08-02T04:00:00.000Z".to_owned(),
		repeat_schedule: (0..3)
			.map(|index| ReleaseGateRepeat {
				repeat_id: format!("repeat-{}", index + 1),
				scheduled_at: format!("2026-08-02T0{}:00:00.000Z", index + 1),
				contrast_arm_order: contrasts
					.into_iter()
					.flat_map(|contrast| {
						let arms = if index % 2 == 0 {
							["reference", "challenge"]
						} else {
							["challenge", "reference"]
						};

						arms.map(|arm| format!("{contrast}:{arm}"))
					})
					.collect(),
			})
			.collect(),
		observation_universe: ReleaseGateObservationUniverse {
			task_ids: candidate_catalog_tasks(),
			model_ids: configurations.iter().map(|value| value.model_id.clone()).collect(),
			raw_cell_count: 3_672,
			contrast_pair_count: 153,
			contrast_observation_count: 306,
		},
		infrastructure_retry_policy: ReleaseGateRetryPolicy {
			max_attempts: 3,
			backoff_seconds: vec![0, 30, 90],
			retryable_classifications: vec!["pre_model_admission".to_owned()],
			model_or_evaluator_failures_retryable: false,
		},
		model_matrix: ReleaseGateModelMatrix {
			digest: protocol::canonical_hash(&sorted).expect("matrix digest"),
			configurations,
		},
		contrast_bindings: contrasts
			.into_iter()
			.map(|contrast_id| ReleaseGateContrastBinding {
				contrast_id: contrast_id.to_owned(),
				reference_variant_digest: digest(&format!("{contrast_id}-reference")),
				challenge_variant_digest: digest(&format!("{contrast_id}-challenge")),
			})
			.collect(),
		signer: ReleaseGateAdmissionSigner {
			key_id: "synthetic-candidate-authority".to_owned(),
			algorithm: "ed25519".to_owned(),
		},
		signature: String::new(),
	}
}

fn controlled_inputs(inputs: ControlledInputFixture<'_>) -> CandidateControlledInputs {
	let ControlledInputFixture {
		root,
		tasks_root,
		source_root,
		artifact_root,
		evaluator_root,
		node,
		replay_root,
		runner,
		verifier,
	} = inputs;
	let directory = |name: &str| create_directory(root.join(name));

	CandidateControlledInputs {
		core_tasks_root: directory("unused-core-tasks"),
		contrast_tasks_root: tasks_root.to_owned(),
		source_root: source_root.to_owned(),
		core_workspace_root: directory("core-workspaces"),
		contrast_workspace_root: directory("contrast-workspaces"),
		execution_root: directory("execution"),
		evaluator_root: evaluator_root.to_owned(),
		evaluator_runtime: node.to_owned(),
		codex_toolchain_root: directory("toolchain"),
		capabilities: root.join("capabilities.json"),
		schedule: root.join("schedule.json"),
		codex_binary: root.join("codex"),
		codex_home: directory("codex-home"),
		codex_egress_proxy: CANDIDATE_CODEX_EGRESS_PROXY_ENDPOINT.to_owned(),
		artifact_root: artifact_root.to_owned(),
		work_root: directory("work"),
		verifier_replay_root: replay_root.to_owned(),
		jobs: 1,
		runner_signer_node_id: runner.node().node_id.clone(),
		verifier_signer_node_id: verifier.node().node_id.clone(),
	}
}

fn workspace_artifacts(root: &Path) -> (ArtifactReference, ArtifactReference) {
	let manifest =
		WorkspaceManifest { schema_version: "aiq.workspace-manifest.v1", entries: Vec::new() };
	let manifest_reference = write_artifact(
		root,
		"workspace-manifest.json",
		&protocol::canonical_json(&manifest).expect("workspace manifest"),
	);
	let snapshot = WorkspaceSnapshot {
		schema_version: "aiq.workspace-snapshot.v1".to_owned(),
		manifest_sha256: manifest_reference.content_hash.clone(),
		entries: Vec::new(),
	};
	let snapshot_reference = write_artifact(
		root,
		"workspace-snapshot.json",
		&protocol::canonical_json(&snapshot).expect("workspace snapshot"),
	);

	(manifest_reference, snapshot_reference)
}

fn write_artifact(root: &Path, kind: &str, bytes: &[u8]) -> ArtifactReference {
	let digest_hex = hex::encode(Sha256::digest(bytes));
	let directory = root.join(&digest_hex);

	fs::create_dir_all(&directory).expect("artifact address");
	fs::write(directory.join(kind), bytes).expect("artifact bytes");

	ArtifactReference {
		kind: kind.to_owned(),
		content_hash: format!("sha256:{digest_hex}"),
		uri: format!("aiq-artifact://sha256/{digest_hex}/{kind}"),
		bytes: bytes.len() as u64,
	}
}

fn trust_policy(authority: &SigningKey) -> Value {
	let promotion = SigningKey::from_bytes(&[35; 32]);
	let signer = |key_id: &str, key: &SigningKey| {
		let mut spki = hex::decode("302a300506032b6570032100").expect("SPKI prefix");

		spki.extend_from_slice(&key.verifying_key().to_bytes());

		serde_json::json!({
			"key_id": key_id,
			"algorithm": "ed25519",
			"public_key_spki_base64": base64(&spki),
			"public_key_fingerprint": format!("sha256:{}", hex::encode(Sha256::digest(&spki))),
		})
	};

	serde_json::json!({
		"schema_version": "aiq.release-gate-trust.v1",
		"release_identity": RELEASE_IDENTITY,
		"authority_signers": [signer("synthetic-candidate-authority", authority)],
		"promotion_signers": [signer("synthetic-candidate-promotion", &promotion)],
	})
}

fn sign_without_signature(value: &impl Serialize, key: &SigningKey) -> String {
	let mut value = serde_json::to_value(value).expect("signing value");

	value.as_object_mut().expect("signing object").remove("signature");

	base64(&key.sign(&protocol::canonical_json(&value).expect("signing bytes")).to_bytes())
}

fn base64(bytes: &[u8]) -> String {
	const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

	let mut output = String::new();

	for chunk in bytes.chunks(3) {
		let word = (u32::from(chunk[0]) << 16)
			| (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
			| u32::from(*chunk.get(2).unwrap_or(&0));

		output.push(TABLE[((word >> 18) & 63) as usize] as char);
		output.push(TABLE[((word >> 12) & 63) as usize] as char);
		output.push(if chunk.len() > 1 { TABLE[((word >> 6) & 63) as usize] as char } else { '=' });
		output.push(if chunk.len() > 2 { TABLE[(word & 63) as usize] as char } else { '=' });
	}

	output
}

fn candidate_catalog_tasks() -> Vec<String> {
	serde_json::from_str::<Value>(include_str!(
		"../../../benchmarks/candidates/aiq-core-1.0.2/catalog.json"
	))
	.expect("candidate catalog")["tasks"]
		.as_array()
		.expect("candidate tasks")
		.iter()
		.map(|task| task["task_id"].as_str().expect("task ID").to_owned())
		.collect()
}

fn canonical_document(value: &impl Serialize) -> Vec<u8> {
	let mut bytes = protocol::canonical_json(value).expect("canonical JSON");

	bytes.push(b'\n');

	bytes
}

fn write_canonical(path: &Path, value: &impl Serialize) -> String {
	fs::write(path, canonical_document(value)).expect("canonical fixture");

	protocol::canonical_hash(value).expect("canonical fixture digest")
}

fn digest(value: &str) -> String {
	format!("sha256:{}", hex::encode(Sha256::digest(value.as_bytes())))
}

fn file_digest(path: &Path) -> String {
	format!("sha256:{}", hex::encode(Sha256::digest(fs::read(path).expect("digest input"))))
}

fn create_directory(path: PathBuf) -> PathBuf {
	fs::create_dir(&path).expect("controlled directory");

	fs::canonicalize(path).expect("canonical directory")
}

fn find_node_runtime() -> PathBuf {
	env::split_paths(&env::var_os("PATH").expect("PATH"))
		.map(|directory| directory.join(format!("node{}", env::consts::EXE_SUFFIX)))
		.find(|candidate| candidate.is_file())
		.and_then(|candidate| fs::canonicalize(candidate).ok())
		.expect("Node.js runtime")
}

fn output_snapshot(plan: &CandidateExecutionPlan) -> Vec<(PathBuf, Vec<u8>)> {
	plan.output_paths()
		.into_iter()
		.map(|(_, path)| (path.to_owned(), fs::read(path).expect("reserved output")))
		.collect()
}

fn assert_success(output: &Output, label: &str) {
	assert!(output.status.success(), "{label} failed: {}", String::from_utf8_lossy(&output.stderr));
}

fn assert_stderr_contains(output: &Output, expected: &str) {
	let stderr = String::from_utf8_lossy(&output.stderr);

	assert!(stderr.contains(expected), "expected {expected:?} in stderr: {stderr}");
}
