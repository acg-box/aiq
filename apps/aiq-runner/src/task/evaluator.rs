//! Supervised external evaluator protocol for controlled hidden task payloads.

#[cfg(all(test, unix))]
mod tests {
	use crate::protocol;

	use std::{
		collections::BTreeMap,
		env, fs,
		fs::Permissions,
		io::Error,
		os::unix::fs::{PermissionsExt, symlink},
		path::{Path, PathBuf},
		process,
		process::{Command, Stdio},
		sync::{Arc, Barrier, Mutex, OnceLock, mpsc},
		thread,
		time::{Duration, Instant, SystemTime, UNIX_EPOCH},
	};

	use libc::ESRCH;

	use serde_json::Value;

	use sha2::{Digest, Sha256};

	use crate::{
		model::MODEL_MATRIX,
		task::evaluator::{
			EVALUATOR_CONFIG_SCHEMA_VERSION, EVALUATOR_PROTOCOL_VERSION,
			EVALUATOR_RESULT_SCHEMA_VERSION, EvaluationErrorKind, EvaluationResult, EvaluatorCheck,
			EvaluatorCheckFailureClass, EvaluatorContext, EvaluatorExecutionObserver,
			EvaluatorOutcome, EvaluatorRuntime, EvaluatorRuntimeKind, ExternalEvaluatorBinding,
			ExternalEvaluatorGate, MAX_EVALUATOR_CHECKS_PER_RESULT, NormalizedToolEvidence,
			SupervisedEvaluatorCommand, execute_supervised,
			force_evaluator_thread_spawn_failure_for_test,
		},
	};

	#[derive(Default)]
	struct TestExecutionObserver {
		spawned: Vec<usize>,
		reaped: Vec<usize>,
	}

	impl EvaluatorExecutionObserver for TestExecutionObserver {
		fn pass_started(&mut self, _pass: usize) {}

		fn pass_finished(&mut self, _pass: usize) {}

		fn child_spawned(&mut self, pass: usize, _pid: u32) {
			self.spawned.push(pass);
		}

		fn child_reaped(&mut self, pass: usize, _pid: u32, _exit_code: Option<i32>) {
			self.reaped.push(pass);
		}

		fn result_observed(
			&mut self,
			_pass: usize,
			_result: &EvaluationResult,
			_raw_stdout_sha256: &str,
		) {
		}
	}

	fn executable_digest(path: &Path) -> String {
		let path = fs::canonicalize(path).expect("fixture executable must resolve");

		format!(
			"sha256:{}",
			hex::encode(Sha256::digest(
				fs::read(path).expect("fixture executable must be readable")
			))
		)
	}

	fn resolve_node_runtime(root: &Path) -> EvaluatorRuntime {
		let actual = env::split_paths(&env::var_os("PATH").expect("test PATH"))
			.map(|directory| directory.join(format!("node{}", env::consts::EXE_SUFFIX)))
			.find(|candidate| candidate.is_file())
			.expect("Node.js must be available for evaluator tests");
		let actual = fs::canonicalize(actual).expect("canonical Node.js runtime");
		let actual = actual.to_str().expect("UTF-8 Node.js runtime");

		assert!(!actual.contains('\''), "test Node.js path must be shell-quotable");

		fs::create_dir_all(root).expect("test Node.js wrapper root");

		let wrapper = root.join("node");

		fs::write(
			&wrapper,
			format!(
				"#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then printf 'v1.0.0\\n'; exit 0; fi\nexec '{actual}' \"$@\"\n"
			),
		)
		.expect("test Node.js wrapper");
		fs::set_permissions(&wrapper, Permissions::from_mode(0o700))
			.expect("test Node.js wrapper permissions");

		EvaluatorRuntime::resolve(&wrapper).expect("Node.js wrapper runtime must resolve")
	}

	fn node_runtime() -> EvaluatorRuntime {
		static RUNTIME: OnceLock<EvaluatorRuntime> = OnceLock::new();

		let configured = RUNTIME.get_or_init(|| {
			resolve_node_runtime(
				&env::temp_dir().join(format!("aiq-node-wrapper-runtime-{}", process::id())),
			)
		});

		EvaluatorRuntime::resolve_committed(configured.executable(), configured.version())
			.expect("test Node.js runtime must remain pinned")
	}

	#[test]
	fn committed_runtime_resolution_does_not_execute_the_runtime() {
		let root = env::temp_dir().join(format!(
			"aiq-evaluator-static-runtime-{}-{}",
			process::id(),
			SystemTime::now().duration_since(UNIX_EPOCH).expect("fixture clock").as_nanos()
		));
		let runtime_path = root.join("node");
		let sentinel_path = root.join("executed");

		fs::create_dir_all(&root).expect("fixture root");
		fs::write(
			&runtime_path,
			format!("#!/bin/sh\n: > '{}'\nprintf 'v22.0.0\\n'\n", sentinel_path.display()),
		)
		.expect("runtime fixture");
		fs::set_permissions(&runtime_path, Permissions::from_mode(0o700))
			.expect("runtime permissions");

		let runtime = EvaluatorRuntime::resolve_committed(&runtime_path, "v22.0.0")
			.expect("static committed resolution");

		assert_eq!(runtime.version(), "v22.0.0");
		assert!(!sentinel_path.exists(), "committed resolution executed the runtime");

		fs::remove_dir_all(root).expect("fixture cleanup");
	}

	fn fixture_registry() -> PathBuf {
		Path::new(env!("CARGO_MANIFEST_DIR")).to_owned()
	}

	fn formal_configuration() -> BTreeMap<String, Value> {
		serde_json::from_value(serde_json::json!({
			"schema_version": EVALUATOR_CONFIG_SCHEMA_VERSION,
			"completion_policy": "natural_completion"
		}))
		.expect("formal evaluator configuration")
	}

	fn echo_binding(output: &str) -> ExternalEvaluatorBinding {
		let executable =
			Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/echo-evaluator.mjs");
		let runtime = node_runtime();
		let configuration = formal_configuration();

		ExternalEvaluatorBinding {
			protocol_version: EVALUATOR_PROTOCOL_VERSION.to_owned(),
			scorer_version: "1.0.0".to_owned(),
			runtime_kind: crate::task::EvaluatorRuntimeKind::Node,
			runtime_executable_digest: runtime.executable_digest().to_owned(),
			executable_ref: Path::new("tests/fixtures/echo-evaluator.mjs").to_owned(),
			executable_digest: executable_digest(&executable),
			configuration_digest: protocol::canonical_hash(&configuration)
				.expect("formal configuration must hash"),
			arguments: vec![
				"-c".to_owned(),
				"cat >/dev/null; printf '%s\\n' \"$1\"".to_owned(),
				"aiq-evaluator-test".to_owned(),
				output.to_owned(),
			],
			max_input_bytes: 8_192,
			max_output_bytes: 8_192,
			configuration,
		}
	}

	fn with_configuration(
		mut binding: ExternalEvaluatorBinding,
		configuration: Value,
	) -> ExternalEvaluatorBinding {
		binding.configuration =
			serde_json::from_value(configuration).expect("configuration must be an object");
		binding.configuration_digest = protocol::canonical_hash(&binding.configuration)
			.expect("configuration must have a canonical digest");

		binding
	}

	fn result_json(passed: bool) -> String {
		let score = if passed { 1.0 } else { 0.0 };
		let outcome = if passed { "correct" } else { "incorrect" };

		serde_json::json!({
			"schema_version": "aiq.evaluator-result.v3",
			"outcome": outcome,
			"score": score,
			"checks": [{
				"check_id": "repository_test",
				"weight": 1,
				"passed": passed,
				"failure_class": if passed { "none" } else { "value" },
				"evidence_digest":
					"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
			}]
		})
		.to_string()
	}

	fn gate_test_binding(
		evaluator_root: &Path,
		runtime: &EvaluatorRuntime,
		delay_ms: u64,
	) -> ExternalEvaluatorBinding {
		let executable = evaluator_root.join("gate-evaluator.mjs");

		fs::write(
			&executable,
			format!(
				r#"process.stdin.resume();
process.stdin.on('end', () => {{
  setTimeout(() => process.stdout.write(process.argv.at(-1)), {delay_ms});
}});
"#
			),
		)
		.expect("gate evaluator fixture");

		let configuration = formal_configuration();

		ExternalEvaluatorBinding {
			protocol_version: EVALUATOR_PROTOCOL_VERSION.to_owned(),
			scorer_version: "1.0.0".to_owned(),
			runtime_kind: EvaluatorRuntimeKind::Node,
			runtime_executable_digest: runtime.executable_digest().to_owned(),
			executable_ref: Path::new("gate-evaluator.mjs").to_owned(),
			executable_digest: executable_digest(&executable),
			configuration_digest: protocol::canonical_hash(&configuration)
				.expect("formal configuration must hash"),
			arguments: vec![result_json(true)],
			max_input_bytes: 8_192,
			max_output_bytes: 8_192,
			configuration,
		}
	}

	fn evaluate_fixture_with_runtime(
		binding: &ExternalEvaluatorBinding,
		response: &str,
		evaluator_root: &Path,
		workspace: &Path,
		runtime: &EvaluatorRuntime,
	) -> Result<crate::task::EvaluationResult, crate::task::EvaluationError> {
		let tool_evidence =
			NormalizedToolEvidence { steps: 1, total_calls: 0, by_tool: BTreeMap::new() };
		let context = EvaluatorContext {
			task_id: "coding-01",
			task_version: "1.0.0",
			run_id: "run_fixture",
			model: MODEL_MATRIX[0],
			final_response: response,
			candidate_workspace: workspace,
			workspace_manifest_sha256: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
			tool_evidence: &tool_evidence,
		};

		binding.evaluate_at_root("repository_test_suite", &context, evaluator_root, runtime)
	}

	fn evaluate_fixture(
		binding: &ExternalEvaluatorBinding,
		response: &str,
		evaluator_root: &Path,
		workspace: &Path,
	) -> Result<crate::task::EvaluationResult, crate::task::EvaluationError> {
		let runtime = node_runtime();

		evaluate_fixture_with_runtime(binding, response, evaluator_root, workspace, &runtime)
	}

	fn evaluate_observation_fixture(
		binding: &ExternalEvaluatorBinding,
		response: &str,
		evaluator_root: &Path,
		workspace: &Path,
	) -> Result<super::CheckedEvaluatorObservation, crate::task::EvaluationError> {
		let tool_evidence =
			NormalizedToolEvidence { steps: 1, total_calls: 0, by_tool: BTreeMap::new() };
		let context = EvaluatorContext {
			task_id: "coding-01",
			task_version: "1.0.0",
			run_id: "run_fixture",
			model: MODEL_MATRIX[0],
			final_response: response,
			candidate_workspace: workspace,
			workspace_manifest_sha256: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
			tool_evidence: &tool_evidence,
		};

		binding.evaluate_observation_at_root(
			"repository_test_suite",
			&context,
			evaluator_root,
			&node_runtime(),
		)
	}

	#[test]
	fn evaluator_commitment_uses_a_stable_logical_reference() {
		let value = serde_json::to_value(echo_binding("{}")).expect("binding must serialize");

		assert_eq!(value["executable_ref"], "tests/fixtures/echo-evaluator.mjs");
		assert!(value.get("executable").is_none());
		assert!(value.get("evaluator_root").is_none());
	}

	#[test]
	fn evaluator_runtime_resolution_fails_closed_for_invalid_paths_and_digest_drift() {
		let runtime = node_runtime();
		let unique =
			SystemTime::now().duration_since(UNIX_EPOCH).expect("fixture clock").as_nanos();
		let root = env::temp_dir().join(format!("aiq-runtime-paths-{}-{unique}", process::id()));

		fs::create_dir(&root).expect("runtime fixture root");

		assert!(EvaluatorRuntime::resolve(Path::new("node")).is_err());
		assert!(EvaluatorRuntime::resolve(&root.join("missing")).is_err());
		assert!(EvaluatorRuntime::resolve(&root).is_err());

		let runtime_link = root.join("node-link");

		symlink(runtime.executable(), &runtime_link).expect("runtime symlink");

		assert!(EvaluatorRuntime::resolve(&runtime_link).is_err());

		let mut binding = echo_binding(&result_json(true));

		binding.runtime_executable_digest = format!("sha256:{}", "0".repeat(64));

		assert!(binding.validate_runtime(&runtime).is_err());

		fs::remove_dir_all(root).expect("runtime fixture cleanup");
	}

	#[test]
	fn production_evaluator_gate_enforces_the_default_permit_bound() {
		let gate = Arc::new(ExternalEvaluatorGate::new(super::MAX_PARALLEL_EXTERNAL_EVALUATORS));
		let mut permits = (0..super::MAX_PARALLEL_EXTERNAL_EVALUATORS)
			.map(|_| gate.enter().expect("configured permit"))
			.collect::<Vec<_>>();
		let started = Arc::new(Barrier::new(2));
		let (acquired_tx, acquired_rx) = mpsc::channel();
		let (release_tx, release_rx) = mpsc::channel();
		let worker_gate = Arc::clone(&gate);
		let worker_started = Arc::clone(&started);
		let worker = thread::spawn(move || {
			worker_started.wait();

			let _permit = worker_gate.enter().expect("queued permit");

			acquired_tx.send(()).expect("acquisition signal");
			release_rx.recv().expect("release signal");
		});

		started.wait();

		assert!(acquired_rx.recv_timeout(Duration::from_millis(50)).is_err());

		drop(permits.pop());

		acquired_rx
			.recv_timeout(Duration::from_secs(1))
			.expect("queued evaluator must acquire after one release");
		release_tx.send(()).expect("release worker");
		worker.join().expect("permit worker must not panic");
	}

	#[test]
	fn shared_runtime_gate_serializes_each_complete_runner_evaluation() {
		let unique =
			SystemTime::now().duration_since(UNIX_EPOCH).expect("fixture clock").as_nanos();
		let root = env::temp_dir().join(format!("aiq-evaluator-gate-{}-{unique}", process::id()));
		let evaluator_root = root.join("evaluators");
		let runtime_root = root.join("runtime");
		let workspaces = [root.join("candidate-0"), root.join("candidate-1")];

		fs::create_dir_all(&evaluator_root).expect("evaluator root");

		for workspace in &workspaces {
			fs::create_dir_all(workspace).expect("candidate workspace");
		}

		let runtime = resolve_node_runtime(&runtime_root).serialize_external_evaluators();
		let binding = gate_test_binding(&evaluator_root, &runtime, 75);
		let start = Arc::new(Barrier::new(workspaces.len() + 1));
		let pass_starts = Arc::new(Mutex::new(Vec::new()));
		let elapsed = Instant::now();
		let results = thread::scope(|scope| {
			let mut handles = Vec::new();

			for (worker, workspace) in workspaces.iter().enumerate() {
				let start = Arc::clone(&start);
				let pass_starts = Arc::clone(&pass_starts);
				let binding = &binding;
				let evaluator_root = &evaluator_root;
				let runtime = &runtime;

				handles.push(scope.spawn(move || {
					let tool_evidence = NormalizedToolEvidence {
						steps: 1,
						total_calls: 0,
						by_tool: BTreeMap::new(),
					};
					let task_id = format!("coding-{worker:02}");
					let context = EvaluatorContext {
						task_id: &task_id,
						task_version: "1.0.0",
						run_id: "run_gate",
						model: MODEL_MATRIX[0],
						final_response: "candidate response",
						candidate_workspace: workspace,
						workspace_manifest_sha256:
							"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
						tool_evidence: &tool_evidence,
					};

					start.wait();

					binding.evaluate_at_root_observed(
						"repository_test_suite",
						&context,
						evaluator_root,
						runtime,
						&mut |pass, started| {
							if started {
								pass_starts.lock().expect("pass order lock").push((worker, pass));
							}
						},
					)
				}));
			}

			start.wait();

			handles
				.into_iter()
				.map(|handle| handle.join().expect("evaluator worker must not panic"))
				.collect::<Vec<_>>()
		});

		for result in results {
			result.expect("serialized evaluator must complete");
		}

		assert!(elapsed.elapsed() >= Duration::from_millis(125));

		let pass_starts = pass_starts.lock().expect("pass order lock");

		assert_eq!(pass_starts.len(), workspaces.len());

		for worker in 0..workspaces.len() {
			assert_eq!(
				pass_starts
					.iter()
					.filter_map(
						|(observed_worker, pass)| (*observed_worker == worker).then_some(*pass)
					)
					.collect::<Vec<_>>(),
				vec![1]
			);
		}

		drop(pass_starts);

		fs::remove_dir_all(root).expect("gate fixture cleanup");
	}

	#[test]
	fn public_observer_runs_after_the_gate_and_can_reenter_the_runtime() {
		let unique =
			SystemTime::now().duration_since(UNIX_EPOCH).expect("fixture clock").as_nanos();
		let root =
			env::temp_dir().join(format!("aiq-evaluator-reentry-{}-{unique}", process::id()));
		let evaluator_root = root.join("evaluators");
		let workspace = root.join("candidate");

		fs::create_dir_all(&evaluator_root).expect("evaluator root");
		fs::create_dir_all(&workspace).expect("candidate workspace");

		let runtime = resolve_node_runtime(&root.join("runtime"));
		let binding = gate_test_binding(&evaluator_root, &runtime, 0);
		let tool_evidence =
			NormalizedToolEvidence { steps: 1, total_calls: 0, by_tool: BTreeMap::new() };
		let context = EvaluatorContext {
			task_id: "coding-01",
			task_version: "1.0.0",
			run_id: "run_reentry",
			model: MODEL_MATRIX[0],
			final_response: "candidate response",
			candidate_workspace: &workspace,
			workspace_manifest_sha256: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
			tool_evidence: &tool_evidence,
		};
		let mut reentered = false;

		binding
			.evaluate_at_root_observed(
				"repository_test_suite",
				&context,
				&evaluator_root,
				&runtime,
				&mut |pass, started| {
					if pass == 1 && started && !reentered {
						assert!(runtime.external_evaluator_gate.active.try_lock().is_ok());

						evaluate_fixture_with_runtime(
							&binding,
							"candidate response",
							&evaluator_root,
							&workspace,
							&runtime,
						)
						.expect("observer re-entry must acquire the released gate");

						reentered = true;
					}
				},
			)
			.expect("outer observed evaluation");

		assert!(reentered);

		fs::remove_dir_all(root).expect("reentry fixture cleanup");
	}

	#[test]
	fn evaluator_gate_queue_wait_does_not_change_natural_completion() {
		let unique =
			SystemTime::now().duration_since(UNIX_EPOCH).expect("fixture clock").as_nanos();
		let root = env::temp_dir().join(format!("aiq-evaluator-queue-{}-{unique}", process::id()));
		let evaluator_root = root.join("evaluators");
		let workspace = root.join("candidate");

		fs::create_dir_all(&evaluator_root).expect("evaluator root");
		fs::create_dir_all(&workspace).expect("candidate workspace");

		let mut runtime = resolve_node_runtime(&root.join("runtime"));

		runtime.external_evaluator_gate = Arc::new(ExternalEvaluatorGate::new(1));

		let binding = gate_test_binding(&evaluator_root, &runtime, 0);
		let gate = runtime.enter_external_evaluator().expect("test must acquire evaluator gate");
		let start = Arc::new(Barrier::new(2));
		let (result, elapsed) = thread::scope(|scope| {
			let start_for_worker = Arc::clone(&start);
			let binding = &binding;
			let evaluator_root = &evaluator_root;
			let workspace = &workspace;
			let runtime = &runtime;
			let handle = scope.spawn(move || {
				start_for_worker.wait();

				let started = Instant::now();
				let result = evaluate_fixture_with_runtime(
					binding,
					"candidate response",
					evaluator_root,
					workspace,
					runtime,
				);

				(result, started.elapsed())
			});

			start.wait();

			thread::sleep(Duration::from_millis(600));

			drop(gate);

			handle.join().expect("queued evaluator must not panic")
		});

		result.expect("queue wait must not change the evaluator result");

		assert!(elapsed >= Duration::from_millis(600));

		fs::remove_dir_all(root).expect("queue fixture cleanup");
	}

	#[test]
	fn formal_evaluator_elapsed_time_does_not_terminate_evidence() {
		let unique =
			SystemTime::now().duration_since(UNIX_EPOCH).expect("fixture clock").as_nanos();
		let root =
			env::temp_dir().join(format!("aiq-evaluator-no-deadline-{}-{unique}", process::id()));
		let evaluator_root = root.join("evaluators");
		let workspace = root.join("candidate");

		fs::create_dir_all(&evaluator_root).expect("evaluator root");
		fs::create_dir_all(&workspace).expect("candidate workspace");

		let runtime = resolve_node_runtime(&root.join("runtime"));
		let binding = gate_test_binding(&evaluator_root, &runtime, 40);
		let started = Instant::now();
		let result = evaluate_fixture_with_runtime(
			&binding,
			"candidate response",
			&evaluator_root,
			&workspace,
			&runtime,
		)
		.expect("formal evaluator work must complete without an elapsed-time deadline");

		assert_eq!(result.outcome, EvaluatorOutcome::Correct);
		assert!(started.elapsed() >= Duration::from_millis(40));

		fs::remove_dir_all(root).expect("no-deadline fixture cleanup");
	}

	#[test]
	fn node_scenario_exceeding_the_old_per_check_deadline_completes() {
		let unique =
			SystemTime::now().duration_since(UNIX_EPOCH).expect("fixture clock").as_nanos();
		let root = env::temp_dir()
			.join(format!("aiq-node-scenario-no-deadline-{}-{unique}", process::id()));
		let evaluator_root = root.join("evaluators");
		let workspace = root.join("candidate");

		fs::create_dir_all(&evaluator_root).expect("evaluator root");
		fs::create_dir_all(&workspace).expect("candidate workspace");

		let runtime = resolve_node_runtime(&root.join("runtime"));
		let binding = with_configuration(
			gate_test_binding(&evaluator_root, &runtime, 1_050),
			serde_json::json!({
				"schema_version": EVALUATOR_CONFIG_SCHEMA_VERSION,
				"completion_policy": "natural_completion",
				"checks": [{
					"check_id": "repository_test",
					"type": "node_scenario",
					"weight": 1
				}]
			}),
		);
		let started = Instant::now();
		let result = evaluate_fixture_with_runtime(
			&binding,
			"candidate response",
			&evaluator_root,
			&workspace,
			&runtime,
		)
		.expect("formal Node.js scenario must run to natural completion");

		assert_eq!(result.outcome, EvaluatorOutcome::Correct);
		assert!(started.elapsed() >= Duration::from_millis(1_050));

		fs::remove_dir_all(root).expect("node-scenario fixture cleanup");
	}

	#[test]
	fn evaluator_failure_releases_the_gate_for_the_next_checked_evaluation() {
		let unique =
			SystemTime::now().duration_since(UNIX_EPOCH).expect("fixture clock").as_nanos();
		let root = env::temp_dir().join(format!("aiq-evaluator-error-{}-{unique}", process::id()));
		let evaluator_root = root.join("evaluators");
		let workspace = root.join("candidate");

		fs::create_dir_all(&evaluator_root).expect("evaluator root");
		fs::create_dir_all(&workspace).expect("candidate workspace");

		let mut runtime = resolve_node_runtime(&root.join("runtime"));

		runtime.external_evaluator_gate = Arc::new(ExternalEvaluatorGate::new(1));

		// Force the execution-error path so host scheduling cannot change the
		// failure class being tested.
		let binding = gate_test_binding(&evaluator_root, &runtime, 0);

		force_evaluator_thread_spawn_failure_for_test(0);

		let error = evaluate_fixture_with_runtime(
			&binding,
			"candidate response",
			&evaluator_root,
			&workspace,
			&runtime,
		)
		.expect_err("evaluator process failure must remain visible");

		assert_eq!(error.kind(), EvaluationErrorKind::Execution);
		assert_eq!(*runtime.external_evaluator_gate.active.lock().expect("gate state"), 0);

		evaluate_fixture_with_runtime(
			&binding,
			"candidate response",
			&evaluator_root,
			&workspace,
			&runtime,
		)
		.expect("a returned evaluator error must release the gate");

		fs::remove_dir_all(root).expect("error fixture cleanup");
	}

	#[test]
	fn poisoned_evaluator_gate_fails_closed_without_starting_a_pass() {
		let unique =
			SystemTime::now().duration_since(UNIX_EPOCH).expect("fixture clock").as_nanos();
		let root = env::temp_dir().join(format!("aiq-evaluator-poison-{}-{unique}", process::id()));
		let evaluator_root = root.join("evaluators");
		let workspace = root.join("candidate");

		fs::create_dir_all(&evaluator_root).expect("evaluator root");
		fs::create_dir_all(&workspace).expect("candidate workspace");

		let runtime = resolve_node_runtime(&root.join("runtime"));
		let binding = gate_test_binding(&evaluator_root, &runtime, 0);
		let gate = Arc::clone(&runtime.external_evaluator_gate);

		assert!(
			thread::spawn(move || {
				let _guard = gate.active.lock().expect("fresh evaluator gate");

				panic!("poison evaluator gate fixture");
			})
			.join()
			.is_err()
		);

		let tool_evidence =
			NormalizedToolEvidence { steps: 1, total_calls: 0, by_tool: BTreeMap::new() };
		let context = EvaluatorContext {
			task_id: "coding-01",
			task_version: "1.0.0",
			run_id: "run_poison",
			model: MODEL_MATRIX[0],
			final_response: "candidate response",
			candidate_workspace: &workspace,
			workspace_manifest_sha256: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
			tool_evidence: &tool_evidence,
		};
		let mut started_passes = 0;
		let error = binding
			.evaluate_at_root_observed(
				"repository_test_suite",
				&context,
				&evaluator_root,
				&runtime,
				&mut |_, started| {
					if started {
						started_passes += 1;
					}
				},
			)
			.expect_err("a poisoned evaluator gate must fail closed");

		assert_eq!(error.kind(), EvaluationErrorKind::Execution);
		assert_eq!(error.to_string(), "external evaluator execution gate is poisoned");
		assert_eq!(started_passes, 0);

		fs::remove_dir_all(root).expect("poison fixture cleanup");
	}

	#[test]
	fn external_protocol_accepts_correct_partial_and_incorrect_results() {
		let workspace = env::temp_dir();
		let partial = serde_json::json!({
			"schema_version": "aiq.evaluator-result.v3",
			"outcome": "partial",
			"score": 0.5,
			"checks": [
				{
					"check_id": "first",
					"weight": 1,
					"passed": true,
					"failure_class": "none",
					"evidence_digest":
						"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
				},
				{
					"check_id": "second",
					"weight": 1,
					"passed": false,
					"failure_class": "value",
					"evidence_digest":
						"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
				}
			]
		})
		.to_string();

		for (fixture, expected_score, expected_outcome) in [
			(result_json(true), 1.0, EvaluatorOutcome::Correct),
			(partial, 0.5, EvaluatorOutcome::Partial),
			(result_json(false), 0.0, EvaluatorOutcome::Incorrect),
		] {
			let result = evaluate_fixture(
				&echo_binding(&fixture),
				"candidate output",
				&fixture_registry(),
				&workspace,
			)
			.expect("strict result fixture must evaluate");

			assert_eq!(result.score, expected_score);
			assert_eq!(result.outcome, expected_outcome);
		}
	}

	#[test]
	fn checked_observation_returns_the_independent_raw_stdout_digest() {
		let stdout = result_json(true);
		let binding = echo_binding(&stdout);
		let observation = evaluate_observation_fixture(
			&binding,
			"candidate output",
			&fixture_registry(),
			&env::temp_dir(),
		)
		.expect("checked observation");

		assert_eq!(observation.result.outcome, EvaluatorOutcome::Correct);
		assert_eq!(
			observation.raw_stdout_sha256,
			format!("sha256:{}", hex::encode(Sha256::digest(stdout.as_bytes())))
		);
	}

	#[test]
	fn external_protocol_rejects_an_all_zero_evidence_digest() {
		let output = serde_json::json!({
			"schema_version": "aiq.evaluator-result.v3",
			"outcome": "correct",
			"score": 1.0,
			"checks": [{
				"check_id": "answer",
				"weight": 1,
				"passed": true,
				"failure_class": "none",
				"evidence_digest": format!("sha256:{}", "0".repeat(64))
			}]
		})
		.to_string();

		assert!(
			evaluate_fixture(
				&echo_binding(&output),
				"candidate output",
				&fixture_registry(),
				&env::temp_dir(),
			)
			.is_err()
		);
	}

	#[test]
	fn external_protocol_accepts_configured_zero_weight_hard_gate() {
		let output = serde_json::json!({
			"schema_version": "aiq.evaluator-result.v3",
			"outcome": "partial",
			"score": 0.8,
			"checks": [
				{
					"check_id": "golden_csv",
					"weight": 1,
					"passed": false,
					"failure_class": "value",
					"evidence_digest":
						"sha256:1c8adaf9b8b5dd4ce3c890fd75d25130e04c00bbbcf2a490a411a89302bdbe1f"
				},
				{
					"check_id": "malformed_rows",
					"weight": 1,
					"passed": true,
					"failure_class": "none",
					"evidence_digest":
						"sha256:a8791942598a56b3d85ee13c159e3a8110e280bbbbc6de27b7c3592df4220e3c"
				},
				{
					"check_id": "provenance",
					"weight": 1,
					"passed": true,
					"failure_class": "none",
					"evidence_digest":
						"sha256:24ce56010b699d87bd3945b5abb316e019caec2dee79ce566b53e4f164518b80"
				},
				{
					"check_id": "reconciles",
					"weight": 1,
					"passed": true,
					"failure_class": "none",
					"evidence_digest":
						"sha256:dff9a8a8b85f92f1281c746a98f4bd20b7cd130a89563a26a38dd4aea9036b16"
				},
				{
					"check_id": "fixtures_unchanged",
					"weight": 1,
					"passed": true,
					"failure_class": "none",
					"evidence_digest":
						"sha256:4ede8cb91024b36059440061940bf1d7b2ec387865c005f0442db6beae00df06"
				},
				{
					"check_id": "complete_workspace_policy",
					"weight": 0,
					"passed": true,
					"failure_class": "none",
					"evidence_digest":
						"sha256:d9889475a0d2efdbf07fa0d6deb93082189f75856d27676d2c9962e30c25a0b8"
				}
			]
		})
		.to_string();
		let configuration = serde_json::json!({
			"schema_version": EVALUATOR_CONFIG_SCHEMA_VERSION,
			"completion_policy": "natural_completion",
			"checks": [
				{"check_id": "golden_csv", "type": "csv", "weight": 1},
				{"check_id": "malformed_rows", "type": "json", "weight": 1},
				{"check_id": "provenance", "type": "json", "weight": 1},
				{"check_id": "reconciles", "type": "node_scenario", "weight": 1},
				{"check_id": "fixtures_unchanged", "type": "workspace_policy", "weight": 1},
				{
					"check_id": "complete_workspace_policy",
					"type": "workspace_policy",
					"hard_gate": true,
					"weight": 0
				}
			]
		});
		let result = evaluate_fixture(
			&with_configuration(echo_binding(&output), configuration),
			"candidate output",
			&fixture_registry(),
			&env::temp_dir(),
		)
		.expect("accepted-corpus evaluator result must satisfy the configured protocol");

		assert_eq!(result.score, 0.8);
		assert_eq!(result.outcome, EvaluatorOutcome::Partial);
		assert_eq!(result.checks.len(), 6);
	}

	#[test]
	fn configured_zero_weight_hard_gate_failure_forces_zero() {
		let result: EvaluationResult = serde_json::from_value(serde_json::json!({
			"schema_version": "aiq.evaluator-result.v3",
			"outcome": "incorrect",
			"score": 0.0,
			"checks": [
				{
					"check_id": "behavior",
					"weight": 3,
					"passed": true,
					"failure_class": "none",
					"evidence_digest":
						"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
				},
				{
					"check_id": "policy",
					"weight": 0,
					"passed": false,
					"failure_class": "value",
					"evidence_digest":
						"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
				}
			]
		}))
		.expect("result must deserialize");
		let configuration = serde_json::from_value(serde_json::json!({
			"checks": [
				{"check_id": "behavior", "type": "text", "weight": 3},
				{"check_id": "policy", "type": "text", "hard_gate": true, "weight": 0}
			]
		}))
		.expect("configuration must deserialize");

		result
			.validate_against_configuration(&configuration)
			.expect("a failed zero-weight hard gate must force score zero");
	}

	#[test]
	fn configured_positive_weight_hard_gate_participates_and_can_force_zero() {
		let configuration = serde_json::from_value(serde_json::json!({
			"checks": [
				{"check_id": "gate", "type": "text", "hard_gate": true, "weight": 3},
				{"check_id": "detail", "type": "text", "weight": 1}
			]
		}))
		.expect("configuration must deserialize");
		let passed_gate: EvaluationResult = serde_json::from_value(serde_json::json!({
			"schema_version": "aiq.evaluator-result.v3",
			"outcome": "partial",
			"score": 0.75,
			"checks": [
				{
					"check_id": "gate",
					"weight": 3,
					"passed": true,
					"failure_class": "none",
					"evidence_digest":
						"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
				},
				{
					"check_id": "detail",
					"weight": 1,
					"passed": false,
					"failure_class": "value",
					"evidence_digest":
						"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
				}
			]
		}))
		.expect("passed-gate result must deserialize");
		let failed_gate: EvaluationResult = serde_json::from_value(serde_json::json!({
			"schema_version": "aiq.evaluator-result.v3",
			"outcome": "incorrect",
			"score": 0.0,
			"checks": [
				{
					"check_id": "gate",
					"weight": 3,
					"passed": false,
					"failure_class": "value",
					"evidence_digest":
						"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
				},
				{
					"check_id": "detail",
					"weight": 1,
					"passed": true,
					"failure_class": "none",
					"evidence_digest":
						"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
				}
			]
		}))
		.expect("failed-gate result must deserialize");

		passed_gate
			.validate_against_configuration(&configuration)
			.expect("a passing positive-weight gate must participate in the weighted fraction");
		failed_gate
			.validate_against_configuration(&configuration)
			.expect("a failed positive-weight gate must force score zero");
	}

	#[test]
	fn configured_checks_require_a_positive_weight_denominator() {
		let result: EvaluationResult = serde_json::from_value(serde_json::json!({
			"schema_version": "aiq.evaluator-result.v3",
			"outcome": "incorrect",
			"score": 0.0,
			"checks": [{
				"check_id": "policy",
				"weight": 0,
				"passed": true,
				"failure_class": "none",
				"evidence_digest":
					"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
			}]
		}))
		.expect("result must deserialize");
		let configuration = serde_json::from_value(serde_json::json!({
			"checks": [
				{"check_id": "policy", "type": "workspace_policy", "weight": 0}
			]
		}))
		.expect("configuration must deserialize");

		assert_eq!(
			result
				.validate_against_configuration(&configuration)
				.expect_err("all-zero configured weights must fail")
				.to_string(),
			"evaluator result must contain at least one scored check"
		);
	}

	#[test]
	fn configured_workspace_policy_failure_is_a_hard_gate() {
		let result: EvaluationResult = serde_json::from_value(serde_json::json!({
			"schema_version": "aiq.evaluator-result.v3",
			"outcome": "incorrect",
			"score": 0.0,
			"checks": [
				{
					"check_id": "answer",
					"weight": 1,
					"passed": true,
					"failure_class": "none",
					"evidence_digest":
						"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
				},
				{
					"check_id": "workspace",
					"weight": 1,
					"passed": false,
					"failure_class": "value",
					"evidence_digest":
						"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
				}
			]
		}))
		.expect("result must deserialize");
		let configuration = serde_json::from_value(serde_json::json!({
			"checks": [
				{"check_id": "answer", "type": "text", "weight": 1},
				{"check_id": "workspace", "type": "workspace_policy", "weight": 1}
			]
		}))
		.expect("configuration must deserialize");

		result
			.validate_against_configuration(&configuration)
			.expect("a failed configured workspace policy must produce an incorrect result");
	}

	#[test]
	fn structural_failure_reduces_score_without_discarding_independent_passed_evidence() {
		let result: EvaluationResult = serde_json::from_value(serde_json::json!({
			"schema_version": "aiq.evaluator-result.v3",
			"outcome": "incorrect",
			"score": 0.0,
			"checks": [
				{
					"check_id": "independent_behavior",
					"weight": 1,
					"passed": true,
					"failure_class": "none",
					"evidence_digest":
						"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
				},
				{
					"check_id": "response_shape",
					"weight": 1,
					"passed": false,
					"failure_class": "structural",
					"evidence_digest":
						"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
				}
			]
		}))
		.expect("result must deserialize");
		let configuration = serde_json::from_value(serde_json::json!({
			"checks": [
				{"check_id": "independent_behavior", "type": "text", "weight": 1},
				{"check_id": "response_shape", "type": "response_json", "weight": 1}
			]
		}))
		.expect("configuration must deserialize");

		result
			.validate_against_configuration(&configuration)
			.expect("structural failure must reduce the score to zero");

		assert!(result.checks[0].passed);
		assert_eq!(result.checks[0].failure_class, EvaluatorCheckFailureClass::None);
	}

	#[test]
	fn exact_key_adjacent_value_failure_can_remain_partial() {
		let result: EvaluationResult = serde_json::from_value(serde_json::json!({
			"schema_version": "aiq.evaluator-result.v3",
			"outcome": "partial",
			"score": 0.5,
			"checks": [
				{
					"check_id": "content",
					"weight": 1,
					"passed": true,
					"failure_class": "none",
					"evidence_digest":
						"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
				},
				{
					"check_id": "document_values",
					"weight": 1,
					"passed": false,
					"failure_class": "value",
					"evidence_digest":
						"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
				}
			]
		}))
		.expect("result must deserialize");

		for exact_key_field in ["exact_keys", "document_exact_keys"] {
			let mut configuration = serde_json::json!({
				"checks": [
					{"check_id": "content", "type": "text", "weight": 1},
					{"check_id": "document_values", "type": "json", "weight": 1}
				]
			});

			configuration["checks"][1]
				.as_object_mut()
				.expect("configured check must be an object")
				.insert(exact_key_field.to_owned(), serde_json::json!(["answer"]));

			let configuration =
				serde_json::from_value(configuration).expect("configuration must deserialize");

			result
				.validate_against_configuration(&configuration)
				.expect("ordinary JSON value mismatch must remain eligible for partial credit");
		}
	}

	#[test]
	fn malformed_or_ambiguous_failure_classes_fail_closed() {
		for output in [
			serde_json::json!({
				"schema_version": "aiq.evaluator-result.v3",
				"outcome": "correct",
				"score": 1.0,
				"checks": [{
					"check_id": "answer",
					"weight": 1,
					"passed": true,
					"evidence_digest":
						"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
				}]
			}),
			serde_json::json!({
				"schema_version": "aiq.evaluator-result.v3",
				"outcome": "incorrect",
				"score": 0.0,
				"checks": [{
					"check_id": "answer",
					"weight": 1,
					"passed": false,
					"failure_class": "none",
					"evidence_digest":
						"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
				}]
			}),
			serde_json::json!({
				"schema_version": "aiq.evaluator-result.v3",
				"outcome": "correct",
				"score": 1.0,
				"checks": [{
					"check_id": "answer",
					"weight": 1,
					"passed": true,
					"failure_class": "value",
					"evidence_digest":
						"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
				}]
			}),
		] {
			let parsed = serde_json::from_value::<EvaluationResult>(output);

			assert!(parsed.map_or(true, |result| result.validate().is_err()));
		}

		let structural_text: EvaluationResult = serde_json::from_value(serde_json::json!({
			"schema_version": "aiq.evaluator-result.v3",
			"outcome": "incorrect",
			"score": 0.0,
			"checks": [{
				"check_id": "answer",
				"weight": 1,
				"passed": false,
				"failure_class": "structural",
				"evidence_digest":
					"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
			}]
		}))
		.expect("result must deserialize");
		let configuration = serde_json::from_value(serde_json::json!({
			"checks": [{"check_id": "answer", "type": "text", "weight": 1}]
		}))
		.expect("configuration must deserialize");

		assert!(structural_text.validate_against_configuration(&configuration).is_err());
	}

	#[test]
	fn evaluator_check_cardinality_is_bounded_in_configuration_and_output() {
		let maximum_checks = (0..MAX_EVALUATOR_CHECKS_PER_RESULT)
			.map(|index| {
				serde_json::json!({
					"check_id": format!("check_{index}"),
					"type": "text",
					"weight": 1
				})
			})
			.collect::<Vec<_>>();
		let maximum_binding =
			with_configuration(echo_binding("{}"), serde_json::json!({ "checks": maximum_checks }));

		assert!(
			maximum_binding
				.validation_issues("1.0.0")
				.iter()
				.all(|issue| !issue.contains("configuration checks must contain at most"))
		);

		let maximum_output_checks = (0..MAX_EVALUATOR_CHECKS_PER_RESULT)
			.map(|index| EvaluatorCheck {
				check_id: format!("check_{index}"),
				weight: 1,
				passed: true,
				failure_class: EvaluatorCheckFailureClass::None,
				evidence_digest: format!("sha256:{}", "a".repeat(64)),
			})
			.collect();
		let maximum_result = EvaluationResult {
			schema_version: EVALUATOR_RESULT_SCHEMA_VERSION.to_owned(),
			outcome: EvaluatorOutcome::Correct,
			score: 1.0,
			checks: maximum_output_checks,
			raw_stdout_sha256: None,
		};

		maximum_result.validate().expect("maximum evaluator check count must pass");

		let checks = (0..=MAX_EVALUATOR_CHECKS_PER_RESULT)
			.map(|index| {
				serde_json::json!({
					"check_id": format!("check_{index}"),
					"type": "text",
					"weight": 1
				})
			})
			.collect::<Vec<_>>();
		let binding =
			with_configuration(echo_binding("{}"), serde_json::json!({ "checks": checks }));

		assert!(binding.validation_issues("1.0.0").iter().any(|issue| {
			issue
				== &format!(
					"configuration checks must contain at most {MAX_EVALUATOR_CHECKS_PER_RESULT} items"
				)
		}));

		let output_checks = (0..=MAX_EVALUATOR_CHECKS_PER_RESULT)
			.map(|index| EvaluatorCheck {
				check_id: format!("check_{index}"),
				weight: 1,
				passed: true,
				failure_class: EvaluatorCheckFailureClass::None,
				evidence_digest: format!("sha256:{}", "a".repeat(64)),
			})
			.collect();
		let result = EvaluationResult {
			schema_version: EVALUATOR_RESULT_SCHEMA_VERSION.to_owned(),
			outcome: EvaluatorOutcome::Correct,
			score: 1.0,
			checks: output_checks,
			raw_stdout_sha256: None,
		};

		assert_eq!(
			result.validate().expect_err("one check over the maximum must fail").to_string(),
			format!(
				"evaluator result must contain at most {MAX_EVALUATOR_CHECKS_PER_RESULT} checks"
			)
		);
	}

	#[test]
	fn formal_node_scenario_configuration_has_one_natural_completion_contract() {
		let binding = with_configuration(
			echo_binding("{}"),
			serde_json::json!({
				"schema_version": EVALUATOR_CONFIG_SCHEMA_VERSION,
				"completion_policy": "natural_completion",
				"checks": [{
					"check_id": "scenario",
					"type": "node_scenario",
					"weight": 1
				}]
			}),
		);

		assert!(binding.validation_issues("1.0.0").is_empty());
	}

	#[test]
	fn formal_node_scenario_configuration_rejects_per_check_deadlines() {
		let binding = with_configuration(
			echo_binding("{}"),
			serde_json::json!({
				"schema_version": EVALUATOR_CONFIG_SCHEMA_VERSION,
				"completion_policy": "natural_completion",
				"checks": [{
					"check_id": "scenario",
					"type": "node_scenario",
					"timeout_ms": 1_000,
					"weight": 1
				}]
			}),
		);

		assert!(binding.validation_issues("1.0.0").iter().any(|issue| {
			issue == "configuration checks[0] node_scenario must not declare timeout_ms"
		}));
	}

	#[test]
	fn formal_configuration_rejects_every_deadline_alias_at_both_scopes() {
		for field in super::FORMAL_DEADLINE_FIELDS {
			let mut evaluator_configuration = serde_json::json!({
				"schema_version": EVALUATOR_CONFIG_SCHEMA_VERSION,
				"completion_policy": "natural_completion"
			});

			evaluator_configuration[field] = serde_json::json!(1);

			assert!(
				with_configuration(echo_binding("{}"), evaluator_configuration)
					.validation_issues("1.0.0")
					.iter()
					.any(|issue| issue.contains(field))
			);

			let mut check = serde_json::json!({
				"check_id": "scenario",
				"type": "node_scenario",
				"weight": 1
			});

			check[field] = serde_json::json!(1);

			let check_configuration = serde_json::json!({
				"schema_version": EVALUATOR_CONFIG_SCHEMA_VERSION,
				"completion_policy": "natural_completion",
				"checks": [check]
			});

			assert!(
				with_configuration(echo_binding("{}"), check_configuration)
					.validation_issues("1.0.0")
					.iter()
					.any(|issue| issue.contains(field))
			);
		}
	}

	#[test]
	fn legacy_or_implicit_completion_configuration_is_rejected() {
		for configuration in [
			serde_json::json!({
				"schema_version": "aiq.evaluator-config.v1",
				"completion_policy": "natural_completion"
			}),
			serde_json::json!({
				"schema_version": EVALUATOR_CONFIG_SCHEMA_VERSION
			}),
		] {
			let binding = with_configuration(echo_binding("{}"), configuration);

			assert!(!binding.validation_issues("1.0.0").is_empty());
		}
	}

	#[test]
	fn configured_results_must_preserve_committed_check_identity_and_weight() {
		let result: EvaluationResult = serde_json::from_value(serde_json::json!({
			"schema_version": "aiq.evaluator-result.v3",
			"outcome": "correct",
			"score": 1.0,
			"checks": [{
				"check_id": "answer",
				"weight": 2,
				"passed": true,
				"failure_class": "none",
				"evidence_digest":
					"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
			}]
		}))
		.expect("result must deserialize");
		let configuration = serde_json::from_value(serde_json::json!({
			"checks": [{"check_id": "answer", "type": "text", "weight": 1}]
		}))
		.expect("configuration must deserialize");
		let error = result
			.validate_against_configuration(&configuration)
			.expect_err("the result must not replace a committed weight");

		assert_eq!(error.kind(), EvaluationErrorKind::InvalidOutput);
		assert_eq!(error.to_string(), "evaluator checks do not match the committed configuration");
	}

	#[test]
	fn external_protocol_rejects_malformed_output() {
		let workspace = env::temp_dir();
		let malformed = serde_json::json!({
			"schema_version": "aiq.evaluator-result.v3",
			"outcome": "correct",
			"score": 1.0,
			"checks": [{
				"check_id": "failed",
				"weight": 1,
				"passed": false,
				"failure_class": "value",
				"evidence_digest":
					"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
			}]
		})
		.to_string();
		let error = evaluate_fixture(
			&echo_binding(&malformed),
			"candidate output",
			&fixture_registry(),
			&workspace,
		)
		.expect_err("malformed result must fail");

		assert_eq!(error.kind(), EvaluationErrorKind::InvalidOutput);
	}

	#[test]
	fn public_evaluator_fixtures_match_the_current_semantic_contract() {
		let fixture_root =
			Path::new(env!("CARGO_MANIFEST_DIR")).join("../../benchmarks/fixtures/evaluator");

		for (name, expected_score, expected_outcome) in [
			("correct.json", 1.0, EvaluatorOutcome::Correct),
			("incorrect.json", 0.0, EvaluatorOutcome::Incorrect),
			("partial.json", 0.75, EvaluatorOutcome::Partial),
		] {
			let bytes = fs::read(fixture_root.join(name)).expect("public fixture must be readable");
			let result: EvaluationResult =
				serde_json::from_slice(&bytes).expect("public fixture must deserialize");

			result.validate().expect("public fixture must satisfy the semantic contract");

			assert_eq!(result.score, expected_score);
			assert_eq!(result.outcome, expected_outcome);
		}

		let bytes = fs::read(fixture_root.join("malformed.json"))
			.expect("malformed fixture must be readable");
		let result: EvaluationResult =
			serde_json::from_slice(&bytes).expect("malformed fixture must deserialize");
		let error = result.validate().expect_err("malformed fixture must fail semantic validation");

		assert_eq!(error.kind(), EvaluationErrorKind::InvalidOutput);
		assert_eq!(
			error.to_string(),
			"evaluator outcome or score is inconsistent with its weighted checks"
		);
	}

	#[test]
	fn external_protocol_scores_the_canonical_candidate_workspace() {
		let unique = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.expect("fixture clock must follow Unix epoch")
			.as_nanos();
		let root = env::temp_dir().join(format!("aiq-evaluator-files-{}-{unique}", process::id()));
		let evaluator_root = root.join("evaluators");
		let workspace = root.join("candidate");

		fs::create_dir_all(&evaluator_root).expect("evaluator root");
		fs::create_dir_all(&workspace).expect("candidate workspace");
		fs::write(workspace.join("answer.txt"), "42\n").expect("candidate file");

		let canonical_workspace = fs::canonicalize(&workspace).expect("canonical workspace");
		let executable = evaluator_root.join("evaluator");
		let passed = result_json(true);
		let failed = result_json(false);
		let script = format!(
			r#"import fs from 'node:fs';
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {{
  const value = JSON.parse(input);
	  const valid = value.schema_version === 'aiq.evaluator-input.v2' &&
    value.task_id === 'coding-01' &&
    value.candidate_workspace === {workspace:?};
  const answer = valid ? fs.readFileSync(`${{value.candidate_workspace}}/answer.txt`, 'utf8').trim() : '';
  process.stdout.write(answer === '42' ? {passed:?} : {failed:?});
}});
"#,
			workspace = canonical_workspace.to_string_lossy(),
		);

		fs::write(&executable, script).expect("evaluator executable");
		fs::set_permissions(&executable, Permissions::from_mode(0o700))
			.expect("evaluator permissions");

		let mut binding = echo_binding(&passed);

		binding.executable_ref = Path::new("evaluator").to_owned();
		binding.executable_digest = executable_digest(&executable);

		binding.arguments.clear();

		let result =
			evaluate_fixture(&binding, "complete candidate response", &evaluator_root, &workspace)
				.expect("repository evaluator must score the candidate workspace");

		assert_eq!(result.score, 1.0);
		assert_eq!(result.outcome, EvaluatorOutcome::Correct);

		fs::remove_dir_all(&root).expect("fixture root must be removed");
	}

	#[test]
	#[allow(clippy::zombie_processes)]
	fn descendant_pipe_fixture() {
		let Ok(directory) = env::current_dir() else {
			return;
		};

		if !directory.join("spawn-descendant").exists() {
			return;
		}

		let marker = directory.join("descendant.pid");

		if !marker.exists() {
			let executable = env::current_exe().expect("test executable");
			let descendant = Command::new(executable)
				.args(["--exact", "task::evaluator::tests::descendant_pipe_fixture", "--nocapture"])
				.stdin(Stdio::null())
				.spawn()
				.expect("descendant must start");

			fs::write(&marker, descendant.id().to_string())
				.expect("descendant PID must be recorded");
		}

		thread::sleep(Duration::from_secs(30));
	}

	#[test]
	fn thread_spawn_failure_fixture() {
		if env::current_dir()
			.is_ok_and(|directory| directory.join("force-thread-spawn-failure").is_file())
		{
			thread::sleep(Duration::from_secs(30));
		}
	}

	#[test]
	fn evaluator_thread_spawn_failures_reap_the_spawned_child() {
		let unique = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.expect("fixture clock must follow Unix epoch")
			.as_nanos();
		let root = env::temp_dir()
			.join(format!("aiq-evaluator-thread-failure-{}-{unique}", process::id()));

		fs::create_dir(&root).expect("fixture root");
		fs::write(root.join("force-thread-spawn-failure"), []).expect("fixture marker");

		let executable = env::current_exe().expect("test executable");
		let arguments = vec![
			"--exact".to_owned(),
			"task::evaluator::tests::thread_spawn_failure_fixture".to_owned(),
			"--nocapture".to_owned(),
		];

		for failure_index in 0..3 {
			force_evaluator_thread_spawn_failure_for_test(failure_index);

			let mut observer = TestExecutionObserver::default();
			let started = Instant::now();
			let error = execute_supervised(
				SupervisedEvaluatorCommand {
					executable: executable.clone(),
					controlled_cwd: &root,
					arguments: &arguments,
					input: Vec::new(),
					diagnostic_timeout: Some(Duration::from_secs(5)),
					output_limit: 4_096,
				},
				None,
				Some((1, &mut observer)),
			)
			.err()
			.expect("forced evaluator thread creation failure must fail closed");

			assert!(error.to_string().contains("forced evaluator thread spawn failure"));
			assert_eq!(observer.spawned, vec![1]);
			assert_eq!(observer.reaped, vec![1]);
			assert!(started.elapsed() < Duration::from_secs(2));
		}

		fs::remove_dir_all(root).expect("fixture cleanup");
	}

	#[test]
	fn diagnostic_process_timeout_kills_same_group_descendants_that_retain_output_pipes() {
		let unique = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.expect("fixture clock must follow Unix epoch")
			.as_nanos();
		let root = env::temp_dir().join(format!("aiq-evaluator-tree-{}-{unique}", process::id()));

		fs::create_dir(&root).expect("fixture root must be created");
		fs::write(root.join("spawn-descendant"), []).expect("fixture control must be written");

		let executable = env::current_exe().expect("test executable");
		let arguments = vec![
			"--exact".to_owned(),
			"task::evaluator::tests::descendant_pipe_fixture".to_owned(),
			"--nocapture".to_owned(),
		];
		let started = Instant::now();
		let capture = execute_supervised(
			SupervisedEvaluatorCommand {
				executable,
				controlled_cwd: &root,
				arguments: &arguments,
				input: Vec::new(),
				diagnostic_timeout: Some(Duration::from_millis(100)),
				output_limit: 8_192,
			},
			None,
			None,
		)
		.expect("diagnostic supervisor must return after terminating the process group");

		assert!(capture.timed_out);
		assert!(started.elapsed() < Duration::from_secs(2));

		let descendant = fs::read_to_string(root.join("descendant.pid"))
			.expect("fixture must report its descendant")
			.parse::<i32>()
			.expect("descendant PID must be numeric");

		assert_process_exits(descendant);

		fs::remove_dir_all(&root).expect("fixture root must be removed");
	}

	fn assert_process_exits(pid: i32) {
		let deadline = Instant::now() + Duration::from_secs(1);

		loop {
			// SAFETY: Signal zero performs an existence check and does not modify the
			// process. The PID came from the descendant created by this test.
			let result = unsafe { libc::kill(pid, 0) };

			if result == -1 && Error::last_os_error().raw_os_error() == Some(ESRCH) {
				return;
			}

			assert!(Instant::now() < deadline, "descendant {pid} remained after group termination");

			thread::sleep(Duration::from_millis(5));
		}
	}

	#[test]
	fn evaluator_registry_rejects_symlink_escape() {
		let unique = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.expect("fixture clock must follow Unix epoch")
			.as_nanos();
		let root = env::temp_dir().join(format!("aiq-evaluator-root-{}-{unique}", process::id()));

		fs::create_dir(&root).expect("fixture root must be created");

		symlink("/bin/echo", root.join("escape")).expect("fixture symlink must be created");

		let mut binding = echo_binding(&result_json(true));

		binding.executable_ref = Path::new("escape").to_owned();

		let error = evaluate_fixture(&binding, "candidate output", &root, Path::new("/"))
			.expect_err("registry escape must fail");

		fs::remove_dir_all(&root).expect("fixture root must be removed");

		assert_eq!(error.kind(), EvaluationErrorKind::Configuration);
		assert!(error.to_string().contains("escapes"));
	}

	#[test]
	fn runner_executes_formal_evaluator_exactly_once_in_the_controlled_cwd() {
		let unique = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.expect("fixture clock must follow Unix epoch")
			.as_nanos();
		let root = env::temp_dir().join(format!("aiq-evaluator-once-{}-{unique}", process::id()));
		let workspace = root.join("workspace");

		fs::create_dir_all(&workspace).expect("fixture workspace must be created");

		let executable = root.join("evaluator");

		fs::write(
			&executable,
			concat!(
				"import fs from 'node:fs';\n",
				"process.stdin.resume();\n",
				"process.stdin.on('end', () => {\n",
				" const path = 'runner-evaluation-count';\n",
				" const count = fs.existsSync(path) ? Number(fs.readFileSync(path, 'utf8')) : 0;\n",
				" fs.writeFileSync(path, String(count + 1));\n",
				" process.stdout.write(JSON.stringify({schema_version:'aiq.evaluator-result.v3',",
				"outcome:'correct',score:1,checks:[{check_id:'x',",
				"weight:1,passed:true,failure_class:'none',evidence_digest:",
				"'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'}]}));\n",
				"});\n",
			),
		)
		.expect("fixture evaluator must be written");
		fs::set_permissions(&executable, Permissions::from_mode(0o700))
			.expect("fixture evaluator must be executable");

		let mut binding = echo_binding(&result_json(true));

		binding.executable_ref = Path::new("evaluator").to_owned();
		binding.executable_digest = executable_digest(&executable);

		binding.arguments.clear();

		let observation =
			evaluate_observation_fixture(&binding, "candidate output", &root, &workspace)
				.expect("the single runner evaluator execution must complete");

		assert_eq!(observation.result.outcome, EvaluatorOutcome::Correct);
		assert_eq!(
			fs::read_to_string(root.join("runner-evaluation-count")).expect("attempt count"),
			"1"
		);

		fs::remove_dir_all(&root).expect("fixture root must be removed");
	}
}

#[cfg(target_os = "linux")]
use std::ffi::OsStr;
#[cfg(not(any(unix, windows)))]
use std::io::{Seek as _, SeekFrom};
#[cfg(target_os = "linux")]
use std::os::fd::AsRawFd as _;
#[cfg(target_os = "linux")]
use std::os::unix::fs::MetadataExt as _;
#[cfg(unix)]
use std::os::unix::{
	fs::{FileExt as _, OpenOptionsExt as _, PermissionsExt},
	process::CommandExt as _,
};
#[cfg(windows)]
use std::os::windows::fs::FileExt as _;
#[cfg(target_os = "linux")]
use std::process;
use std::sync::PoisonError;
use std::{
	collections::{BTreeMap, BTreeSet},
	fmt::{self, Debug, Display, Formatter},
	fs::{self, File, OpenOptions},
	io::{Read, Write as _},
	iter,
	path::{Component, Path, PathBuf},
	process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, ExitStatus, Stdio},
	sync::{Arc, Condvar, Mutex},
	thread::{self, Builder, JoinHandle},
	time::{Duration, Instant},
};

#[cfg(unix)]
use libc;
#[cfg(unix)]
use libc::{O_CLOEXEC, O_NOFOLLOW};
use serde::{Deserialize, Serialize};
use serde_json::{self, Value};
use sha2::{Digest, Sha256};

use crate::adapter::process_group::{self, ProcessGroupCleanupError, ProcessGroupPoll};
#[cfg(unix)]
use crate::pinned_path::PinnedPathIdentity;
use crate::{model::ModelConfig, protocol};

#[cfg(test)]
thread_local! {
	static FORCED_EVALUATOR_THREAD_SPAWN_FAILURE: std::cell::Cell<Option<usize>> =
		const { std::cell::Cell::new(None) };
}

type ReaderThread = JoinHandle<std::io::Result<(Vec<u8>, bool)>>;

/// Input protocol used by controlled external evaluators.
pub const EVALUATOR_PROTOCOL_VERSION: &str = "aiq.evaluator-input.v2";
/// Result schema returned by controlled external evaluators.
pub const EVALUATOR_RESULT_SCHEMA_VERSION: &str = "aiq.evaluator-result.v3";
/// Configuration schema whose formal work runs to natural completion.
pub const EVALUATOR_CONFIG_SCHEMA_VERSION: &str = "aiq.evaluator-config.v2";
/// Maximum committed checks in one evaluator result.
pub const MAX_EVALUATOR_CHECKS_PER_RESULT: usize = 16;
/// Maximum checked evaluators that can execute through one runtime.
///
/// The bound matches the complete 17-configuration AIQ model matrix.
pub const MAX_PARALLEL_EXTERNAL_EVALUATORS: usize = 17;

const MAX_EVALUATOR_IO_BYTES: usize = 1_024 * 1_024;
const MAX_EVALUATOR_CONFIG_BYTES: usize = 64 * 1_024;
const MAX_EVALUATOR_ARGUMENTS: usize = 64;
const FORMAL_DEADLINE_FIELDS: [&str; 7] = [
	"timeout_ms",
	"timeout_seconds",
	"deadline_ms",
	"deadline_seconds",
	"max_elapsed_ms",
	"max_duration_ms",
	"scenario_timeout_ms",
];

/// Receives actual evaluator and direct-child lifecycle boundaries.
trait EvaluatorExecutionObserver {
	/// Called immediately before one evaluator execution starts.
	fn pass_started(&mut self, pass: usize);
	/// Called after one evaluator execution reaches its terminal result.
	fn pass_finished(&mut self, pass: usize);
	/// Called only after the evaluator child has an operating-system process ID.
	fn child_spawned(&mut self, pass: usize, pid: u32);
	/// Called after the evaluator direct child has been reaped.
	fn child_reaped(&mut self, pass: usize, pid: u32, exit_code: Option<i32>);
	/// Called with the exact validated result and raw stdout digest returned by
	/// the evaluator execution.
	fn result_observed(&mut self, pass: usize, result: &EvaluationResult, raw_stdout_sha256: &str);
}

/// Supported runtime for a controlled external evaluator.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EvaluatorRuntimeKind {
	/// A committed Node.js runtime.
	Node,
}

/// Strict outcome class returned by a controlled evaluator.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EvaluatorOutcome {
	/// Fully correct.
	Correct,
	/// Auditable partial credit.
	Partial,
	/// Incorrect.
	Incorrect,
}

/// Stable external evaluator failure class.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EvaluationErrorKind {
	/// Invalid controlled binding.
	Configuration,
	/// Serialized input exceeded its commitment.
	InputTooLarge,
	/// Output exceeded its commitment.
	OutputTooLarge,
	/// The process could not run successfully.
	Execution,
	/// Output did not match the strict result contract.
	InvalidOutput,
}

/// Stable failure class for one evaluator check.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EvaluatorCheckFailureClass {
	/// The check passed.
	None,
	/// An ordinary value comparison failed.
	Value,
	/// A configured JSON structure was invalid.
	Structural,
}

/// Canonical executable selected once at process configuration time.
#[derive(Clone)]
pub struct EvaluatorRuntime {
	executable: PathBuf,
	executable_digest: String,
	version: String,
	pinned: Arc<PinnedEvaluatorFile>,
	external_evaluator_gate: Arc<ExternalEvaluatorGate>,
}
impl EvaluatorRuntime {
	/// Resolves one explicit absolute runtime path.
	pub fn resolve(path: &Path) -> Result<Self, EvaluationError> {
		let pinned = Arc::new(PinnedEvaluatorFile::open(path, "evaluator runtime")?);
		let executable = pinned.path.clone();
		#[cfg(unix)]
		let metadata = pinned
			.file
			.metadata()
			.map_err(|_| EvaluationError::configuration("cannot inspect evaluator runtime"))?;

		#[cfg(unix)]
		if PermissionsExt::mode(&metadata.permissions()) & 0o111 == 0 {
			return Err(EvaluationError::configuration("evaluator runtime must be executable"));
		}

		let version = probe_pinned_executable_version(&pinned, &["--version".to_owned()])?;
		let version = version.trim();

		if !valid_node_runtime_version(version) {
			return Err(EvaluationError::configuration(
				"evaluator runtime returned an invalid Node.js version",
			));
		}

		Ok(Self {
			executable,
			executable_digest: pinned.digest.clone(),
			version: version.to_owned(),
			pinned,
			external_evaluator_gate: Arc::new(ExternalEvaluatorGate::new(
				MAX_PARALLEL_EXTERNAL_EVALUATORS,
			)),
		})
	}

	/// Pins one explicit runtime without executing it and uses an exact committed version.
	///
	/// This constructor is for non-executing planning. The caller must subsequently
	/// validate the digest and version against the committed corpus commitment.
	pub fn resolve_committed(path: &Path, version: &str) -> Result<Self, EvaluationError> {
		let pinned = Arc::new(PinnedEvaluatorFile::open(path, "evaluator runtime")?);
		let executable = pinned.path.clone();
		#[cfg(unix)]
		let metadata = pinned
			.file
			.metadata()
			.map_err(|_| EvaluationError::configuration("cannot inspect evaluator runtime"))?;

		#[cfg(unix)]
		if PermissionsExt::mode(&metadata.permissions()) & 0o111 == 0 {
			return Err(EvaluationError::configuration("evaluator runtime must be executable"));
		}

		let version = version.trim();

		if !valid_node_runtime_version(version) {
			return Err(EvaluationError::configuration(
				"committed evaluator runtime version is invalid",
			));
		}

		Ok(Self {
			executable,
			executable_digest: pinned.digest.clone(),
			version: version.to_owned(),
			pinned,
			external_evaluator_gate: Arc::new(ExternalEvaluatorGate::new(
				MAX_PARALLEL_EXTERNAL_EVALUATORS,
			)),
		})
	}

	/// Returns the canonical runtime executable path.
	#[must_use]
	pub fn executable(&self) -> &Path {
		&self.executable
	}

	/// Returns the SHA-256 identity of the runtime executable.
	#[must_use]
	pub fn executable_digest(&self) -> &str {
		&self.executable_digest
	}

	/// Returns the exact version reported by the runtime under an empty environment.
	#[must_use]
	pub fn version(&self) -> &str {
		&self.version
	}

	fn enter_external_evaluator(&self) -> Result<ExternalEvaluatorPermit<'_>, EvaluationError> {
		self.external_evaluator_gate.enter()
	}

	/// Serializes model-bound evaluator work while model processes are active.
	pub(crate) fn serialize_external_evaluators(mut self) -> Self {
		self.external_evaluator_gate = Arc::new(ExternalEvaluatorGate::new(1));

		self
	}
}

impl Debug for EvaluatorRuntime {
	fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("EvaluatorRuntime")
			.field("executable", &self.executable)
			.field("executable_digest", &self.executable_digest)
			.field("version", &self.version)
			.finish()
	}
}

impl PartialEq for EvaluatorRuntime {
	fn eq(&self, other: &Self) -> bool {
		self.executable == other.executable
			&& self.executable_digest == other.executable_digest
			&& self.version == other.version
	}
}

impl Eq for EvaluatorRuntime {}

/// Controlled external evaluator configuration stored only in a hidden task.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ExternalEvaluatorBinding {
	/// Evaluator input protocol version.
	pub protocol_version: String,
	/// Versioned scorer implementation commitment.
	pub scorer_version: String,
	/// Runtime family required by this evaluator.
	pub runtime_kind: EvaluatorRuntimeKind,
	/// SHA-256 commitment for the selected runtime executable.
	pub runtime_executable_digest: String,
	/// Stable path relative to the operator-controlled evaluator root.
	pub executable_ref: PathBuf,
	/// SHA-256 commitment for the evaluator executable.
	pub executable_digest: String,
	/// RFC 8785 SHA-256 commitment for evaluator configuration.
	pub configuration_digest: String,
	/// Direct arguments. No shell parses these values.
	#[serde(default)]
	pub arguments: Vec<String>,
	/// Maximum serialized evaluator input.
	pub max_input_bytes: usize,
	/// Maximum retained evaluator output for each stream.
	pub max_output_bytes: usize,
	/// Evaluator-specific controlled configuration.
	#[serde(default)]
	pub configuration: BTreeMap<String, Value>,
}
impl ExternalEvaluatorBinding {
	/// Returns configuration errors without starting an evaluator.
	#[must_use]
	pub fn validation_issues(&self, task_scorer_version: &str) -> Vec<String> {
		let mut issues = Vec::new();

		if self.protocol_version != EVALUATOR_PROTOCOL_VERSION {
			issues.push(format!("protocol_version must be {EVALUATOR_PROTOCOL_VERSION}"));
		}
		if self.scorer_version != task_scorer_version {
			issues.push("binding scorer_version must match the task scorer_version".to_owned());
		}
		if !super::is_semantic_version(&self.scorer_version) {
			issues.push(
				"binding scorer_version must use semantic MAJOR.MINOR.PATCH format".to_owned(),
			);
		}
		if !valid_sha256(&self.runtime_executable_digest) {
			issues.push(
				"runtime_executable_digest must be sha256: plus 64 lowercase hexadecimal characters"
					.to_owned(),
			);
		}
		if !valid_executable_ref(&self.executable_ref) {
			issues.push(
				"executable_ref must contain only normal relative path components".to_owned(),
			);
		}
		if !valid_sha256(&self.executable_digest) {
			issues.push(
				"executable_digest must be sha256: plus 64 lowercase hexadecimal characters"
					.to_owned(),
			);
		}
		if !valid_sha256(&self.configuration_digest) {
			issues.push(
				"configuration_digest must be sha256: plus 64 lowercase hexadecimal characters"
					.to_owned(),
			);
		}
		if self.arguments.len() > MAX_EVALUATOR_ARGUMENTS {
			issues.push(format!("arguments must contain at most {MAX_EVALUATOR_ARGUMENTS} items"));
		}

		for (field, value) in
			[("max_input_bytes", self.max_input_bytes), ("max_output_bytes", self.max_output_bytes)]
		{
			if value == 0 || value > MAX_EVALUATOR_IO_BYTES {
				issues.push(format!("{field} must be from 1 through {MAX_EVALUATOR_IO_BYTES}"));
			}
		}

		if serde_json::to_vec(&self.configuration)
			.map_or(true, |bytes| bytes.len() > MAX_EVALUATOR_CONFIG_BYTES)
		{
			issues.push(format!(
				"configuration must serialize within {MAX_EVALUATOR_CONFIG_BYTES} bytes"
			));
		}
		if self
			.configuration
			.get("checks")
			.and_then(Value::as_array)
			.is_some_and(|checks| checks.len() > MAX_EVALUATOR_CHECKS_PER_RESULT)
		{
			issues.push(format!(
				"configuration checks must contain at most {MAX_EVALUATOR_CHECKS_PER_RESULT} items"
			));
		}

		issues.extend(self.formal_completion_policy_issues());

		match protocol::canonical_hash(&self.configuration) {
			Ok(observed) if observed != self.configuration_digest => issues
				.push("evaluator configuration digest does not match its commitment".to_owned()),
			Err(error) => issues.push(format!("cannot hash evaluator configuration: {error}")),
			Ok(_) => {},
		}

		issues
	}

	fn formal_completion_policy_issues(&self) -> Vec<String> {
		let mut issues = Vec::new();

		if self.configuration.get("schema_version").and_then(Value::as_str)
			!= Some(EVALUATOR_CONFIG_SCHEMA_VERSION)
		{
			issues.push(format!(
				"configuration schema_version must be {EVALUATOR_CONFIG_SCHEMA_VERSION}"
			));
		}
		if self.configuration.get("completion_policy").and_then(Value::as_str)
			!= Some("natural_completion")
		{
			issues.push("configuration completion_policy must be natural_completion".to_owned());
		}

		for field in FORMAL_DEADLINE_FIELDS {
			if self.configuration.contains_key(field) {
				issues
					.push(format!("configuration must not declare formal deadline field {field}"));
			}
		}

		let Some(checks_value) = self.configuration.get("checks") else {
			return issues;
		};
		let Some(checks) = checks_value.as_array() else {
			issues.push(format!("{EVALUATOR_CONFIG_SCHEMA_VERSION} checks must be an array"));

			return issues;
		};

		for (index, check) in checks.iter().enumerate() {
			for field in FORMAL_DEADLINE_FIELDS {
				if check.get(field).is_some() {
					let check_type = check.get("type").and_then(Value::as_str).unwrap_or("check");

					issues.push(format!(
						"configuration checks[{index}] {check_type} must not declare {field}"
					));
				}
			}
		}

		issues
	}

	/// Checks the committed evaluator script against an explicit registry root.
	pub fn validate_registry(&self, root: &Path) -> Result<(), EvaluationError> {
		self.resolve_executable(root).map(|_| ())
	}

	/// Pins the exact runtime and evaluator script for checked evaluation.
	fn pin_at_root(
		&self,
		root: &Path,
		runtime: &EvaluatorRuntime,
	) -> Result<PinnedExternalEvaluator, EvaluationError> {
		let issues = self.validation_issues_without_registry(&self.scorer_version);

		if !issues.is_empty() {
			return Err(EvaluationError::configuration(issues.join("; ")));
		}

		self.validate_runtime(runtime)?;

		let controlled_cwd = fs::canonicalize(root).map_err(|error| {
			EvaluationError::configuration(format!("evaluator registry unavailable: {error}"))
		})?;

		if !controlled_cwd.is_dir() {
			return Err(EvaluationError::configuration("evaluator registry must be a directory"));
		}

		let executable = self.resolve_executable(&controlled_cwd)?;
		let observed_configuration_digest = protocol::canonical_hash(&self.configuration)
			.map_err(|error| EvaluationError::configuration(error.to_string()))?;

		if observed_configuration_digest != self.configuration_digest {
			return Err(EvaluationError::configuration(
				"evaluator configuration digest does not match its commitment",
			));
		}

		Ok(PinnedExternalEvaluator { controlled_cwd, executable })
	}

	fn build_input(
		&self,
		evaluator_kind: &str,
		context: &EvaluatorContext<'_>,
		controlled_cwd: &Path,
	) -> Result<Vec<u8>, EvaluationError> {
		let resolved_candidate =
			fs::canonicalize(context.candidate_workspace).map_err(|error| {
				EvaluationError::configuration(format!("candidate workspace unavailable: {error}"))
			})?;

		if !resolved_candidate.is_dir() || resolved_candidate == controlled_cwd {
			return Err(EvaluationError::configuration(
				"candidate workspace and evaluator registry must be separate directories",
			));
		}

		#[cfg(target_os = "linux")]
		let candidate_workspace = if is_strict_proc_self_fd_path(context.candidate_workspace) {
			context.candidate_workspace.to_owned()
		} else {
			resolved_candidate
		};
		#[cfg(not(target_os = "linux"))]
		let candidate_workspace = resolved_candidate;
		let input = serde_json::to_vec(&EvaluatorInput {
			schema_version: EVALUATOR_PROTOCOL_VERSION,
			evaluator_kind,
			scorer_version: &self.scorer_version,
			task_id: context.task_id,
			task_version: context.task_version,
			run_id: context.run_id,
			model: context.model,
			final_response: context.final_response,
			candidate_workspace: &candidate_workspace,
			workspace_manifest_sha256: context.workspace_manifest_sha256,
			tool_evidence: context.tool_evidence,
			configuration: &self.configuration,
		})
		.map_err(|error| EvaluationError::configuration(error.to_string()))?;

		if input.len() > self.max_input_bytes {
			return Err(EvaluationError::input_too_large());
		}

		Ok(input)
	}

	/// Executes through an explicit evaluator registry root.
	///
	/// The runner executes the evaluator once. The independent verifier performs
	/// the second execution before publication. Deployment isolation must
	/// separately deny uncontrolled network and host resources because this
	/// portable process boundary cannot.
	pub fn evaluate_at_root(
		&self,
		evaluator_kind: &str,
		context: &EvaluatorContext<'_>,
		root: &Path,
		runtime: &EvaluatorRuntime,
	) -> Result<EvaluationResult, EvaluationError> {
		self.evaluate_at_root_observed(evaluator_kind, context, root, runtime, &mut |_, _| {})
	}

	/// Executes once and returns the exact raw stdout commitment.
	pub(crate) fn evaluate_observation_at_root(
		&self,
		evaluator_kind: &str,
		context: &EvaluatorContext<'_>,
		root: &Path,
		runtime: &EvaluatorRuntime,
	) -> Result<CheckedEvaluatorObservation, EvaluationError> {
		#[derive(Default)]
		struct RawStdoutObserver {
			digest: Option<String>,
		}

		impl EvaluatorExecutionObserver for RawStdoutObserver {
			fn pass_started(&mut self, _pass: usize) {}

			fn pass_finished(&mut self, _pass: usize) {}

			fn child_spawned(&mut self, _pass: usize, _pid: u32) {}

			fn child_reaped(&mut self, _pass: usize, _pid: u32, _exit_code: Option<i32>) {}

			fn result_observed(
				&mut self,
				_pass: usize,
				_result: &EvaluationResult,
				raw_stdout_sha256: &str,
			) {
				self.digest = Some(raw_stdout_sha256.to_owned());
			}
		}

		let mut observer = RawStdoutObserver::default();
		let result = self.evaluate_at_root_observed_inner(
			evaluator_kind,
			context,
			root,
			runtime,
			&mut observer,
		)?;
		let raw_stdout_sha256 = observer.digest.ok_or_else(|| {
			EvaluationError::execution("evaluator completed without an observed stdout digest")
		})?;

		Ok(CheckedEvaluatorObservation { result, raw_stdout_sha256 })
	}

	/// Executes once and reports the exact start and terminal edge of the child.
	pub fn evaluate_at_root_observed(
		&self,
		evaluator_kind: &str,
		context: &EvaluatorContext<'_>,
		root: &Path,
		runtime: &EvaluatorRuntime,
		observer: &mut dyn FnMut(usize, bool),
	) -> Result<EvaluationResult, EvaluationError> {
		#[derive(Default)]
		struct CapturedPassObserver {
			edges: Vec<(usize, bool)>,
		}

		impl EvaluatorExecutionObserver for CapturedPassObserver {
			fn pass_started(&mut self, pass: usize) {
				self.edges.push((pass, true));
			}

			fn pass_finished(&mut self, pass: usize) {
				self.edges.push((pass, false));
			}

			fn child_spawned(&mut self, _pass: usize, _pid: u32) {}

			fn child_reaped(&mut self, _pass: usize, _pid: u32, _exit_code: Option<i32>) {}

			fn result_observed(
				&mut self,
				_pass: usize,
				_result: &EvaluationResult,
				_raw_stdout_sha256: &str,
			) {
			}
		}

		let mut captured = CapturedPassObserver::default();
		let result = self.evaluate_at_root_observed_inner(
			evaluator_kind,
			context,
			root,
			runtime,
			&mut captured,
		);

		// Public callbacks can execute arbitrary caller code. Replay the captured
		// execution edges only after the shared evaluator gate has been released, so a
		// callback can safely invoke another evaluation with this runtime.
		for (pass, started) in captured.edges {
			observer(pass, started);
		}

		result
	}

	fn evaluate_at_root_observed_inner(
		&self,
		evaluator_kind: &str,
		context: &EvaluatorContext<'_>,
		root: &Path,
		runtime: &EvaluatorRuntime,
		observer: &mut dyn EvaluatorExecutionObserver,
	) -> Result<EvaluationResult, EvaluationError> {
		// Every clone of one configured runtime shares this gate for the complete
		// single runner observation.
		let _gate = runtime.enter_external_evaluator()?;
		let pinned = self.pin_at_root(root, runtime)?;
		let input = self.build_input(evaluator_kind, context, &pinned.controlled_cwd)?;

		observer.pass_started(1);

		let evaluated = self.evaluate_once(
			runtime,
			&pinned.executable,
			&pinned.controlled_cwd,
			&input,
			Some((1, observer)),
		);

		if let Ok((stdout, result)) = &evaluated {
			let raw_stdout_sha256 = format!("sha256:{}", hex::encode(Sha256::digest(stdout)));

			observer.result_observed(1, result, &raw_stdout_sha256);
		}

		observer.pass_finished(1);

		evaluated.map(|(_, result)| result)
	}

	fn evaluate_once(
		&self,
		runtime: &EvaluatorRuntime,
		script: &PinnedEvaluatorFile,
		controlled_cwd: &Path,
		input: &[u8],
		observer: Option<(usize, &mut dyn EvaluatorExecutionObserver)>,
	) -> Result<(Vec<u8>, EvaluationResult), EvaluationError> {
		let runtime_path = runtime.pinned.invocation_path("evaluator runtime")?;
		let script_path = script.invocation_path("evaluator executable")?;
		let arguments = iter::once(script_path.to_string_lossy().into_owned())
			.chain(self.arguments.iter().cloned())
			.collect::<Vec<_>>();
		let capture = execute_supervised(
			SupervisedEvaluatorCommand {
				executable: runtime_path,
				controlled_cwd,
				arguments: &arguments,
				input: input.to_owned(),
				diagnostic_timeout: None,
				output_limit: self.max_output_bytes,
			},
			Some(EvaluatorFileGuards { runtime: &runtime.pinned, script: Some(script) }),
			observer,
		)?;

		debug_assert!(!capture.timed_out, "formal evaluator execution has no deadline");

		if capture.stdout_truncated || capture.stderr_truncated {
			return Err(EvaluationError::output_too_large());
		}

		if let Some(error) = capture.stdin_error {
			return Err(EvaluationError::execution(error));
		}

		if capture.exit_code != Some(0) {
			return Err(EvaluationError::execution(format!(
				"evaluator exited with status {:?}",
				capture.exit_code
			)));
		}

		let result: EvaluationResult = serde_json::from_slice(&capture.stdout)
			.map_err(|error| EvaluationError::invalid_output(error.to_string()))?;

		result.validate_against_configuration(&self.configuration)?;

		Ok((capture.stdout, result))
	}

	/// Checks that the configured runtime matches this task commitment.
	pub fn validate_runtime(&self, runtime: &EvaluatorRuntime) -> Result<(), EvaluationError> {
		match self.runtime_kind {
			EvaluatorRuntimeKind::Node => {},
		}

		runtime.pinned.verify("evaluator runtime")?;

		if runtime.executable_digest() != self.runtime_executable_digest {
			return Err(EvaluationError::configuration(
				"evaluator runtime executable digest does not match its commitment",
			));
		}

		Ok(())
	}

	fn validation_issues_without_registry(&self, task_scorer_version: &str) -> Vec<String> {
		let mut issues = Vec::new();

		if self.protocol_version != EVALUATOR_PROTOCOL_VERSION {
			issues.push(format!("protocol_version must be {EVALUATOR_PROTOCOL_VERSION}"));
		}
		if self.scorer_version != task_scorer_version {
			issues.push("binding scorer_version must match the task scorer_version".to_owned());
		}
		if !super::is_semantic_version(&self.scorer_version) {
			issues.push(
				"binding scorer_version must use semantic MAJOR.MINOR.PATCH format".to_owned(),
			);
		}
		if !valid_sha256(&self.runtime_executable_digest) {
			issues.push(
				"runtime_executable_digest must be sha256: plus 64 lowercase hexadecimal characters"
					.to_owned(),
			);
		}
		if !valid_executable_ref(&self.executable_ref) {
			issues.push(
				"executable_ref must contain only normal relative path components".to_owned(),
			);
		}
		if !valid_sha256(&self.executable_digest) {
			issues.push(
				"executable_digest must be sha256: plus 64 lowercase hexadecimal characters"
					.to_owned(),
			);
		}
		if !valid_sha256(&self.configuration_digest) {
			issues.push(
				"configuration_digest must be sha256: plus 64 lowercase hexadecimal characters"
					.to_owned(),
			);
		}
		if self.arguments.len() > MAX_EVALUATOR_ARGUMENTS {
			issues.push(format!("arguments must contain at most {MAX_EVALUATOR_ARGUMENTS} items"));
		}

		for (field, value) in
			[("max_input_bytes", self.max_input_bytes), ("max_output_bytes", self.max_output_bytes)]
		{
			if value == 0 || value > MAX_EVALUATOR_IO_BYTES {
				issues.push(format!("{field} must be from 1 through {MAX_EVALUATOR_IO_BYTES}"));
			}
		}

		if serde_json::to_vec(&self.configuration)
			.map_or(true, |bytes| bytes.len() > MAX_EVALUATOR_CONFIG_BYTES)
		{
			issues.push(format!(
				"configuration must serialize within {MAX_EVALUATOR_CONFIG_BYTES} bytes"
			));
		}
		if self
			.configuration
			.get("checks")
			.and_then(Value::as_array)
			.is_some_and(|checks| checks.len() > MAX_EVALUATOR_CHECKS_PER_RESULT)
		{
			issues.push(format!(
				"configuration checks must contain at most {MAX_EVALUATOR_CHECKS_PER_RESULT} items"
			));
		}

		issues.extend(self.formal_completion_policy_issues());

		match protocol::canonical_hash(&self.configuration) {
			Ok(observed) if observed != self.configuration_digest => issues
				.push("evaluator configuration digest does not match its commitment".to_owned()),
			Err(error) => issues.push(format!("cannot hash evaluator configuration: {error}")),
			Ok(_) => {},
		}

		issues
	}

	fn resolve_executable(&self, root: &Path) -> Result<PinnedEvaluatorFile, EvaluationError> {
		if !valid_executable_ref(&self.executable_ref) {
			return Err(EvaluationError::configuration(
				"executable_ref must contain only normal relative path components",
			));
		}

		let root = fs::canonicalize(root).map_err(|error| {
			EvaluationError::configuration(format!("evaluator registry unavailable: {error}"))
		})?;
		let executable = fs::canonicalize(root.join(&self.executable_ref)).map_err(|error| {
			EvaluationError::configuration(format!("evaluator unavailable: {error}"))
		})?;

		if !executable.starts_with(&root) {
			return Err(EvaluationError::configuration(
				"evaluator executable escapes the controlled registry",
			));
		}

		let pinned = PinnedEvaluatorFile::open(&executable, "evaluator executable")?;

		if pinned.digest != self.executable_digest {
			return Err(EvaluationError::configuration(
				"evaluator executable digest does not match its commitment",
			));
		}

		Ok(pinned)
	}
}

/// Validated runner evaluator result and its independently observed raw stdout digest.
#[derive(Clone, Debug, PartialEq)]
pub struct CheckedEvaluatorObservation {
	/// Parsed result from the single runner evaluator execution.
	pub result: EvaluationResult,
	/// SHA-256 digest of the exact raw stdout bytes.
	pub raw_stdout_sha256: String,
}

/// Strict evaluator result.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EvaluationResult {
	/// Result schema.
	pub schema_version: String,
	/// Evaluator outcome.
	pub outcome: EvaluatorOutcome,
	/// Score from zero through one.
	pub score: f64,
	/// Stable weighted checks used to derive the score.
	pub checks: Vec<EvaluatorCheck>,
	/// SHA-256 digest of the exact raw stdout bytes from the checked external evaluator.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub raw_stdout_sha256: Option<String>,
}
impl EvaluationResult {
	pub(super) fn binary(correct: bool, evidence_digest: String) -> Self {
		Self {
			schema_version: EVALUATOR_RESULT_SCHEMA_VERSION.to_owned(),
			outcome: if correct { EvaluatorOutcome::Correct } else { EvaluatorOutcome::Incorrect },
			score: if correct { 1.0 } else { 0.0 },
			checks: vec![EvaluatorCheck {
				check_id: "exact_match".to_owned(),
				weight: 1,
				passed: correct,
				failure_class: if correct {
					EvaluatorCheckFailureClass::None
				} else {
					EvaluatorCheckFailureClass::Value
				},
				evidence_digest,
			}],
			raw_stdout_sha256: None,
		}
	}

	pub(crate) fn validate(&self) -> Result<(), EvaluationError> {
		self.validate_checks(false)?;

		self.validate_reduced_result(false)
	}

	/// Validates evaluator evidence after its committed configuration is no
	/// longer present at the package boundary.
	///
	/// A zero result with a failed check can represent a configured hard gate.
	/// Deterministic verifier replay must still compare the exact result against
	/// the controlled task configuration.
	pub fn validate_persisted(&self) -> Result<(), EvaluationError> {
		self.validate_checks(true)?;

		let hard_failure = self
			.checks
			.iter()
			.any(|check| check.failure_class == EvaluatorCheckFailureClass::Structural)
			|| (self.outcome == EvaluatorOutcome::Incorrect
				&& self.score == 0.0
				&& self.checks.iter().any(|check| !check.passed));

		self.validate_reduced_result(hard_failure)
	}

	fn validate_against_configuration(
		&self,
		configuration: &BTreeMap<String, Value>,
	) -> Result<(), EvaluationError> {
		let Some(configured_checks) = configuration.get("checks").and_then(Value::as_array) else {
			return self.validate();
		};

		if configured_checks.len() != self.checks.len() {
			return Err(EvaluationError::invalid_output(
				"evaluator checks do not match the committed configuration",
			));
		}

		self.validate_checks(true)?;

		let mut hard_failure = false;

		for (check, configured) in self.checks.iter().zip(configured_checks) {
			let configured = configured.as_object().ok_or_else(|| {
				EvaluationError::invalid_output("committed evaluator check is invalid")
			})?;
			let configured_id =
				configured.get("check_id").and_then(Value::as_str).ok_or_else(|| {
					EvaluationError::invalid_output(
						"committed evaluator check identifier is invalid",
					)
				})?;
			let configured_weight =
				configured.get("weight").and_then(Value::as_u64).ok_or_else(|| {
					EvaluationError::invalid_output("committed evaluator check weight is invalid")
				})?;
			let configured_weight = u32::try_from(configured_weight).map_err(|_| {
				EvaluationError::invalid_output("committed evaluator check weight is invalid")
			})?;
			let configured_type = configured.get("type").and_then(Value::as_str);
			let is_configured_hard_gate = configured.get("hard_gate").and_then(Value::as_bool)
				== Some(true)
				|| configured_type == Some("workspace_policy");

			if check.check_id != configured_id
				|| check.weight != configured_weight
				|| (check.weight == 0 && !is_configured_hard_gate)
				|| (check.failure_class == EvaluatorCheckFailureClass::Structural
					&& !matches!(configured_type, Some("json" | "response_json")))
			{
				return Err(EvaluationError::invalid_output(
					"evaluator checks do not match the committed configuration",
				));
			}

			hard_failure |= (!check.passed && is_configured_hard_gate)
				|| check.failure_class == EvaluatorCheckFailureClass::Structural;
		}

		self.validate_reduced_result(hard_failure)
	}

	fn validate_checks(&self, allow_zero_weight: bool) -> Result<(), EvaluationError> {
		if self.schema_version != EVALUATOR_RESULT_SCHEMA_VERSION {
			return Err(EvaluationError::invalid_output("unsupported evaluator result schema"));
		}
		if !self.score.is_finite() || !(0.0..=1.0).contains(&self.score) {
			return Err(EvaluationError::invalid_output(
				"evaluator score must be finite and within [0,1]",
			));
		}
		if self.raw_stdout_sha256.as_deref().is_some_and(|digest| !valid_sha256(digest)) {
			return Err(EvaluationError::invalid_output("evaluator raw stdout digest is invalid"));
		}
		if self.checks.is_empty() {
			return Err(EvaluationError::invalid_output(
				"evaluator result must contain at least one check",
			));
		}
		if self.checks.len() > MAX_EVALUATOR_CHECKS_PER_RESULT {
			return Err(EvaluationError::invalid_output(format!(
				"evaluator result must contain at most {MAX_EVALUATOR_CHECKS_PER_RESULT} checks"
			)));
		}

		let mut ids = BTreeSet::new();

		for check in &self.checks {
			if !safe_check_id(&check.check_id)
				|| !ids.insert(check.check_id.as_str())
				|| (!allow_zero_weight && check.weight == 0)
				|| check.passed != (check.failure_class == EvaluatorCheckFailureClass::None)
				|| (!allow_zero_weight
					&& check.failure_class == EvaluatorCheckFailureClass::Structural)
				|| !valid_sha256(&check.evidence_digest)
			{
				return Err(EvaluationError::invalid_output(
					"evaluator check identifiers, weights, failure classes, or evidence digests are invalid",
				));
			}
		}

		Ok(())
	}

	fn validate_reduced_result(&self, hard_failure: bool) -> Result<(), EvaluationError> {
		let mut total_weight = 0_u64;
		let mut passed_weight = 0_u64;

		for check in &self.checks {
			total_weight = total_weight.checked_add(u64::from(check.weight)).ok_or_else(|| {
				EvaluationError::invalid_output("evaluator check weights overflow")
			})?;

			if check.passed {
				passed_weight =
					passed_weight.checked_add(u64::from(check.weight)).ok_or_else(|| {
						EvaluationError::invalid_output("evaluator passed check weights overflow")
					})?;
			}
		}

		if total_weight == 0 {
			return Err(EvaluationError::invalid_output(
				"evaluator result must contain at least one scored check",
			));
		}

		let reduced_score =
			if hard_failure { 0.0 } else { passed_weight as f64 / total_weight as f64 };
		let reduced_outcome = if reduced_score == 1.0 {
			EvaluatorOutcome::Correct
		} else if reduced_score == 0.0 {
			EvaluatorOutcome::Incorrect
		} else {
			EvaluatorOutcome::Partial
		};
		let consistent = self.outcome == reduced_outcome && self.score == reduced_score;

		if !consistent {
			return Err(EvaluationError::invalid_output(
				"evaluator outcome or score is inconsistent with its weighted checks",
			));
		}

		Ok(())
	}
}

/// One stable evaluator check and its content-addressed evidence.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EvaluatorCheck {
	/// Stable identifier within the evaluator version.
	pub check_id: String,
	/// Nonnegative integer weight. Only a configured hard gate can use zero.
	pub weight: u32,
	/// Whether the candidate passed this check.
	pub passed: bool,
	/// Why a failed check did not pass.
	pub failure_class: EvaluatorCheckFailureClass,
	/// SHA-256 digest of the evidence used for this decision.
	pub evidence_digest: String,
}

/// Normalized tool-use evidence supplied to an external evaluator.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct NormalizedToolEvidence {
	/// Number of completed Codex items.
	pub steps: u32,
	/// Number of tool calls.
	pub total_calls: u32,
	/// Tool calls grouped by stable item type.
	pub by_tool: BTreeMap<String, u32>,
}

/// Complete execution evidence supplied to an external evaluator.
pub struct EvaluatorContext<'a> {
	/// Stable task identifier.
	pub task_id: &'a str,
	/// Task version.
	pub task_version: &'a str,
	/// Stable run identifier.
	pub run_id: &'a str,
	/// Exact model configuration.
	pub model: ModelConfig,
	/// Complete, untruncated final response.
	pub final_response: &'a str,
	/// Canonical candidate workspace path.
	pub candidate_workspace: &'a Path,
	/// Digest of the deterministic post-run workspace manifest.
	pub workspace_manifest_sha256: &'a str,
	/// Normalized tool-use evidence.
	pub tool_evidence: &'a NormalizedToolEvidence,
}

/// Structured external evaluator error.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EvaluationError {
	kind: EvaluationErrorKind,
	message: String,
}
impl EvaluationError {
	pub(super) fn configuration(message: impl Into<String>) -> Self {
		Self { kind: EvaluationErrorKind::Configuration, message: message.into() }
	}

	fn input_too_large() -> Self {
		Self {
			kind: EvaluationErrorKind::InputTooLarge,
			message: "evaluator input exceeds its configured byte limit".to_owned(),
		}
	}

	fn output_too_large() -> Self {
		Self {
			kind: EvaluationErrorKind::OutputTooLarge,
			message: "evaluator output exceeds its configured byte limit".to_owned(),
		}
	}

	fn execution(message: impl Into<String>) -> Self {
		Self { kind: EvaluationErrorKind::Execution, message: message.into() }
	}

	fn invalid_output(message: impl Into<String>) -> Self {
		Self { kind: EvaluationErrorKind::InvalidOutput, message: message.into() }
	}

	/// Returns the stable failure class.
	#[must_use]
	pub const fn kind(&self) -> EvaluationErrorKind {
		self.kind
	}
}

impl std::error::Error for EvaluationError {}

impl Display for EvaluationError {
	fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
		formatter.write_str(&self.message)
	}
}

/// Bounded permit gate shared by every clone of one configured runtime.
struct ExternalEvaluatorGate {
	active: Mutex<usize>,
	available: Condvar,
	limit: usize,
}
impl ExternalEvaluatorGate {
	fn new(limit: usize) -> Self {
		assert!(limit > 0, "external evaluator gate limit must be positive");

		Self { active: Mutex::new(0), available: Condvar::new(), limit }
	}

	fn enter(&self) -> Result<ExternalEvaluatorPermit<'_>, EvaluationError> {
		let mut active = self.active.lock().map_err(|_| {
			EvaluationError::execution("external evaluator execution gate is poisoned")
		})?;

		while *active >= self.limit {
			active = self.available.wait(active).map_err(|_| {
				EvaluationError::execution("external evaluator execution gate is poisoned")
			})?;
		}

		*active += 1;

		Ok(ExternalEvaluatorPermit { gate: self })
	}
}

struct ExternalEvaluatorPermit<'a> {
	gate: &'a ExternalEvaluatorGate,
}
impl Drop for ExternalEvaluatorPermit<'_> {
	fn drop(&mut self) {
		let mut active = self.gate.active.lock().unwrap_or_else(PoisonError::into_inner);

		*active = active.saturating_sub(1);

		self.gate.available.notify_one();
	}
}

/// One held runtime/script pair for a checked evaluator execution.
struct PinnedExternalEvaluator {
	controlled_cwd: PathBuf,
	executable: PinnedEvaluatorFile,
}

struct PinnedEvaluatorFile {
	path: PathBuf,
	file: File,
	#[cfg(unix)]
	identity: PinnedPathIdentity,
	digest: String,
}
impl PinnedEvaluatorFile {
	fn open(path: &Path, label: &str) -> Result<Self, EvaluationError> {
		if !path.is_absolute() {
			return Err(EvaluationError::configuration(format!("{label} path must be absolute")));
		}

		let selected = fs::symlink_metadata(path)
			.map_err(|_| EvaluationError::configuration(format!("{label} is unavailable")))?;

		if selected.file_type().is_symlink() || !selected.is_file() {
			return Err(EvaluationError::configuration(format!(
				"{label} must be a regular non-symlink file"
			)));
		}

		let path = fs::canonicalize(path)
			.map_err(|_| EvaluationError::configuration(format!("{label} is unavailable")))?;
		let mut options = OpenOptions::new();

		options.read(true);
		#[cfg(unix)]
		options.custom_flags(O_NOFOLLOW | O_CLOEXEC);

		let file = options
			.open(&path)
			.map_err(|_| EvaluationError::configuration(format!("{label} is unavailable")))?;

		if !file
			.metadata()
			.map_err(|_| EvaluationError::configuration(format!("cannot inspect {label}")))?
			.is_file()
		{
			return Err(EvaluationError::configuration(format!("{label} must be a regular file")));
		}

		#[cfg(unix)]
		let identity = PinnedPathIdentity::capture_allow_hardlinks(&path, &file)
			.map_err(|_| EvaluationError::configuration(format!("cannot pin {label} identity")))?;
		let digest = digest_pinned_evaluator_file(&file)
			.map_err(|_| EvaluationError::configuration(format!("cannot digest {label}")))?;
		let pinned = Self {
			path,
			file,
			#[cfg(unix)]
			identity,
			digest,
		};

		pinned.verify_identity(label)?;

		Ok(pinned)
	}

	fn verify_identity(&self, label: &str) -> Result<(), EvaluationError> {
		#[cfg(unix)]
		{
			self.identity
				.verify(&self.path, &self.file)
				.map_err(|_| EvaluationError::execution(format!("{label} identity changed")))
		}

		#[cfg(not(unix))]
		{
			let _ = label;

			Ok(())
		}
	}

	fn verify(&self, label: &str) -> Result<(), EvaluationError> {
		self.verify_identity(label)?;

		let digest = digest_pinned_evaluator_file(&self.file)
			.map_err(|_| EvaluationError::execution(format!("cannot re-read {label}")))?;

		if digest != self.digest {
			return Err(EvaluationError::execution(format!("{label} bytes changed")));
		}

		self.verify_identity(label)?;

		Ok(())
	}

	fn invocation_path(&self, label: &str) -> Result<PathBuf, EvaluationError> {
		#[cfg(target_os = "linux")]
		{
			let path =
				PathBuf::from(format!("/proc/{}/fd/{}", process::id(), self.file.as_raw_fd()));
			let held = self
				.file
				.metadata()
				.map_err(|_| EvaluationError::execution(format!("cannot inspect held {label}")))?;
			let exposed = fs::metadata(&path).map_err(|_| {
				EvaluationError::execution(format!("cannot expose held {label} descriptor"))
			})?;

			if held.dev() != exposed.dev() || held.ino() != exposed.ino() {
				return Err(EvaluationError::execution(format!(
					"held {label} descriptor identity changed"
				)));
			}

			Ok(path)
		}
		#[cfg(not(target_os = "linux"))]
		{
			let _ = label;

			Ok(self.path.clone())
		}
	}
}

impl Debug for PinnedEvaluatorFile {
	fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("PinnedEvaluatorFile")
			.field("path", &self.path)
			.field("digest", &self.digest)
			.finish_non_exhaustive()
	}
}

#[derive(Serialize)]
struct EvaluatorInput<'a> {
	schema_version: &'static str,
	evaluator_kind: &'a str,
	scorer_version: &'a str,
	task_id: &'a str,
	task_version: &'a str,
	run_id: &'a str,
	model: ModelConfig,
	final_response: &'a str,
	candidate_workspace: &'a Path,
	workspace_manifest_sha256: &'a str,
	tool_evidence: &'a NormalizedToolEvidence,
	configuration: &'a BTreeMap<String, Value>,
}

struct SupervisedEvaluatorCommand<'a> {
	executable: PathBuf,
	controlled_cwd: &'a Path,
	arguments: &'a [String],
	input: Vec<u8>,
	/// Diagnostic-only deadline. Formal evaluator calls always use `None`.
	diagnostic_timeout: Option<Duration>,
	output_limit: usize,
}

struct Capture {
	exit_code: Option<i32>,
	stdout: Vec<u8>,
	timed_out: bool,
	stdout_truncated: bool,
	stderr_truncated: bool,
	stdin_error: Option<String>,
}

struct CaptureThreads {
	stdout: ReaderThread,
	stderr: ReaderThread,
	stdin: Option<JoinHandle<std::io::Result<()>>>,
}

struct EvaluatorPipes {
	stdout: ChildStdout,
	stderr: ChildStderr,
	stdin: ChildStdin,
}

#[derive(Clone, Copy)]
struct EvaluatorFileGuards<'a> {
	runtime: &'a PinnedEvaluatorFile,
	script: Option<&'a PinnedEvaluatorFile>,
}
impl EvaluatorFileGuards<'_> {
	fn verify(self) -> Result<(), EvaluationError> {
		self.runtime.verify("evaluator runtime")?;

		if let Some(script) = self.script {
			script.verify("evaluator executable")?;
		}

		Ok(())
	}
}

/// Pins one executable, then runs a bounded empty-environment version probe.
pub(crate) fn probe_executable_version(
	executable: &Path,
	arguments: &[String],
) -> Result<String, EvaluationError> {
	let executable = PinnedEvaluatorFile::open(executable, "version-probe executable")?;

	probe_pinned_executable_version(&executable, arguments)
}

fn valid_node_runtime_version(version: &str) -> bool {
	version.len() >= 2
		&& version.len() <= 128
		&& version.starts_with('v')
		&& version[1..]
			.bytes()
			.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'+'))
}

fn spawn_evaluator_thread<F, T>(name: &'static str, function: F) -> std::io::Result<JoinHandle<T>>
where
	F: FnOnce() -> T + Send + 'static,
	T: Send + 'static,
{
	#[cfg(test)]
	if FORCED_EVALUATOR_THREAD_SPAWN_FAILURE.with(|forced| match forced.get() {
		Some(0) => {
			forced.set(None);

			true
		},
		Some(remaining) => {
			forced.set(Some(remaining - 1));

			false
		},
		None => false,
	}) {
		return Err(std::io::Error::other("forced evaluator thread spawn failure"));
	}

	Builder::new().name(name.to_owned()).spawn(function)
}

#[cfg(test)]
fn force_evaluator_thread_spawn_failure_for_test(index: usize) {
	FORCED_EVALUATOR_THREAD_SPAWN_FAILURE.with(|forced| forced.set(Some(index)));
}

fn digest_pinned_evaluator_file(file: &File) -> std::io::Result<String> {
	let before = file.metadata()?;
	let expected_len = before.len();
	let mut hasher = Sha256::new();
	let mut buffer = [0_u8; 64 * 1_024];
	let mut offset = 0_u64;

	while offset < expected_len {
		let remaining = usize::try_from(expected_len - offset).unwrap_or(usize::MAX);
		let limit = remaining.min(buffer.len());
		let read = read_evaluator_file_at(file, &mut buffer[..limit], offset)?;

		if read == 0 {
			return Err(std::io::Error::other("pinned evaluator file changed while reading"));
		}

		hasher.update(&buffer[..read]);

		offset = offset
			.checked_add(u64::try_from(read).unwrap_or(u64::MAX))
			.ok_or_else(|| std::io::Error::other("pinned evaluator file is too large"))?;
	}

	let mut extra = [0_u8; 1];

	if read_evaluator_file_at(file, &mut extra, expected_len)? != 0
		|| file.metadata()?.len() != expected_len
	{
		return Err(std::io::Error::other("pinned evaluator file changed while reading"));
	}

	Ok(format!("sha256:{}", hex::encode(hasher.finalize())))
}

#[cfg(unix)]
fn read_evaluator_file_at(file: &File, bytes: &mut [u8], offset: u64) -> std::io::Result<usize> {
	file.read_at(bytes, offset)
}

#[cfg(windows)]
fn read_evaluator_file_at(file: &File, bytes: &mut [u8], offset: u64) -> std::io::Result<usize> {
	file.seek_read(bytes, offset)
}

#[cfg(not(any(unix, windows)))]
fn read_evaluator_file_at(file: &File, bytes: &mut [u8], offset: u64) -> std::io::Result<usize> {
	let mut reader = file.try_clone()?;

	reader.seek(SeekFrom::Start(offset))?;

	reader.read(bytes)
}

fn probe_pinned_executable_version(
	executable: &PinnedEvaluatorFile,
	arguments: &[String],
) -> Result<String, EvaluationError> {
	let invocation_path = executable.invocation_path("evaluator runtime")?;
	let probe = execute_supervised(
		SupervisedEvaluatorCommand {
			executable: invocation_path,
			controlled_cwd: executable.path.parent().unwrap_or_else(|| Path::new(".")),
			arguments,
			input: Vec::new(),
			diagnostic_timeout: Some(Duration::from_secs(5)),
			output_limit: 4_096,
		},
		Some(EvaluatorFileGuards { runtime: executable, script: None }),
		None,
	)?;

	if probe.timed_out
		|| probe.stdout_truncated
		|| probe.stderr_truncated
		|| probe.stdin_error.is_some()
		|| probe.exit_code != Some(0)
	{
		return Err(EvaluationError::configuration("executable version probe failed"));
	}

	let stdout = String::from_utf8(probe.stdout)
		.map_err(|_| EvaluationError::configuration("executable version is not UTF-8"))?;
	let version = stdout.trim();

	if version.is_empty() || version.len() > 4_096 {
		return Err(EvaluationError::configuration("executable version output is invalid"));
	}

	Ok(version.to_owned())
}

fn execute_supervised(
	command: SupervisedEvaluatorCommand<'_>,
	file_guards: Option<EvaluatorFileGuards<'_>>,
	observer: Option<(usize, &mut dyn EvaluatorExecutionObserver)>,
) -> Result<Capture, EvaluationError> {
	let result = execute_supervised_inner(command, file_guards, observer);
	let file_verification = file_guards.map_or(Ok(()), EvaluatorFileGuards::verify);
	let mut failures = Vec::new();
	let capture = match result {
		Ok(capture) => Some(capture),
		Err(error) => {
			failures.push(error);

			None
		},
	};

	if let Err(error) = file_verification {
		failures.push(evaluation_error_with_context(
			error,
			"post-execution evaluator file verification failed",
		));
	}

	if failures.is_empty() {
		Ok(capture.expect("successful execution must return a capture"))
	} else {
		Err(combine_evaluation_errors(failures))
	}
}

fn evaluation_error_with_context(error: EvaluationError, context: &str) -> EvaluationError {
	EvaluationError { kind: error.kind, message: format!("{context}: {error}") }
}

fn combine_evaluation_errors(mut errors: Vec<EvaluationError>) -> EvaluationError {
	let primary = errors.remove(0);
	let mut messages = vec![primary.message];

	messages.extend(errors.into_iter().map(|error| error.message));

	EvaluationError { kind: primary.kind, message: messages.join("; ") }
}

fn execute_supervised_inner(
	command: SupervisedEvaluatorCommand<'_>,
	file_guards: Option<EvaluatorFileGuards<'_>>,
	mut observer: Option<(usize, &mut dyn EvaluatorExecutionObserver)>,
) -> Result<Capture, EvaluationError> {
	#[cfg(test)]
	let _process_test_guard = crate::process_test_read_lock();
	let mut child_command = Command::new(command.executable);

	child_command
		.args(command.arguments)
		.current_dir(command.controlled_cwd)
		.env_clear()
		.stdin(Stdio::piped())
		.stdout(Stdio::piped())
		.stderr(Stdio::piped());

	configure_process_group(&mut child_command);

	if let Some(files) = file_guards {
		files.verify()?;
	}

	let spawned = child_command.spawn();
	let mut child = spawned
		.map_err(|error| EvaluationError::execution(format!("cannot start evaluator: {error}")))?;
	let child_pid = child.id();

	if let Some((pass, observer)) = observer.as_mut() {
		observer.child_spawned(*pass, child_pid);
	}

	let file_verification = file_guards.map_or(Ok(()), EvaluatorFileGuards::verify);

	if let Err(error) = file_verification {
		let mut verification_failures = vec![error];

		if let Err(error) = stop_spawned_evaluator(
			&mut child,
			child_pid,
			&mut observer,
			"post-spawn identity verification",
		) {
			verification_failures.push(error);
		}

		return Err(combine_evaluation_errors(verification_failures));
	}

	let pipes = take_evaluator_pipes(&mut child, child_pid, &mut observer)?;
	let capture_threads = spawn_evaluator_capture_threads(
		&mut child,
		child_pid,
		&mut observer,
		pipes,
		command.input,
		command.output_limit,
	)?;
	let (status, timed_out) =
		wait_for_evaluator(&mut child, command.diagnostic_timeout, child_pid, &mut observer)?;

	if let Some((pass, observer)) = observer.as_mut() {
		observer.child_reaped(*pass, child_pid, status.code());
	}

	finish_capture(status, timed_out, capture_threads)
}

fn take_evaluator_pipes(
	child: &mut Child,
	child_pid: u32,
	observer: &mut Option<(usize, &mut dyn EvaluatorExecutionObserver)>,
) -> Result<EvaluatorPipes, EvaluationError> {
	let stdout = match child.stdout.take() {
		Some(stdout) => stdout,
		None => {
			stop_spawned_evaluator(child, child_pid, observer, "missing stdout")?;

			return Err(EvaluationError::execution("cannot capture evaluator stdout"));
		},
	};
	let stderr = match child.stderr.take() {
		Some(stderr) => stderr,
		None => {
			stop_spawned_evaluator(child, child_pid, observer, "missing stderr")?;

			return Err(EvaluationError::execution("cannot capture evaluator stderr"));
		},
	};
	let stdin = match child.stdin.take() {
		Some(stdin) => stdin,
		None => {
			stop_spawned_evaluator(child, child_pid, observer, "missing stdin")?;

			return Err(EvaluationError::execution("cannot open evaluator stdin"));
		},
	};

	Ok(EvaluatorPipes { stdout, stderr, stdin })
}

fn spawn_evaluator_capture_threads(
	child: &mut Child,
	child_pid: u32,
	observer: &mut Option<(usize, &mut dyn EvaluatorExecutionObserver)>,
	pipes: EvaluatorPipes,
	input: Vec<u8>,
	output_limit: usize,
) -> Result<CaptureThreads, EvaluationError> {
	let EvaluatorPipes { stdout, stderr, stdin } = pipes;
	let stdout_thread = match spawn_evaluator_thread("aiq-evaluator-stdout", move || {
		read_stream(stdout, output_limit)
	}) {
		Ok(thread) => thread,
		Err(error) => {
			return Err(evaluator_thread_spawn_failure(
				child,
				child_pid,
				observer,
				"stdout capture",
				error,
				Vec::new(),
			));
		},
	};
	let stderr_thread = match spawn_evaluator_thread("aiq-evaluator-stderr", move || {
		read_stream(stderr, output_limit)
	}) {
		Ok(thread) => thread,
		Err(error) => {
			return Err(evaluator_thread_spawn_failure(
				child,
				child_pid,
				observer,
				"stderr capture",
				error,
				vec![(stdout_thread, "stdout")],
			));
		},
	};
	let stdin_thread = match spawn_evaluator_thread("aiq-evaluator-stdin", move || {
		let mut stdin = stdin;
		let result = stdin.write_all(&input);

		drop(stdin);

		result
	}) {
		Ok(thread) => thread,
		Err(error) => {
			return Err(evaluator_thread_spawn_failure(
				child,
				child_pid,
				observer,
				"stdin writer",
				error,
				vec![(stdout_thread, "stdout"), (stderr_thread, "stderr")],
			));
		},
	};

	Ok(CaptureThreads { stdout: stdout_thread, stderr: stderr_thread, stdin: Some(stdin_thread) })
}

fn evaluator_thread_spawn_failure(
	child: &mut Child,
	child_pid: u32,
	observer: &mut Option<(usize, &mut dyn EvaluatorExecutionObserver)>,
	context: &str,
	spawn_error: std::io::Error,
	readers: Vec<(ReaderThread, &'static str)>,
) -> EvaluationError {
	let mut failures = vec![EvaluationError::execution(format!(
		"cannot start evaluator {context} thread: {spawn_error}"
	))];

	if let Err(error) =
		stop_spawned_evaluator(child, child_pid, observer, "thread creation failure")
	{
		failures.push(error);
	}

	let deadline = Instant::now() + Duration::from_millis(500);

	for (reader, stream_name) in readers {
		match join_reader_thread(reader, deadline, stream_name) {
			Ok((_, true)) => failures.push(EvaluationError::execution(format!(
				"evaluator {stream_name} remained open after process-group termination"
			))),
			Ok((_, false)) => {},
			Err(error) => failures.push(error),
		}
	}

	combine_evaluation_errors(failures)
}

fn stop_spawned_evaluator(
	child: &mut Child,
	child_pid: u32,
	observer: &mut Option<(usize, &mut dyn EvaluatorExecutionObserver)>,
	context: &str,
) -> Result<(), EvaluationError> {
	match kill_and_reap_child(child) {
		Ok(status) => {
			if let Some((pass, observer)) = observer.as_mut() {
				observer.child_reaped(*pass, child_pid, status.code());
			}

			Ok(())
		},
		Err(error) => {
			observe_evaluator_cleanup_error(observer, child_pid, &error);

			Err(EvaluationError::execution(format!(
				"cannot clean up spawned evaluator after {context}: {error}"
			)))
		},
	}
}

fn observe_evaluator_cleanup_error(
	observer: &mut Option<(usize, &mut dyn EvaluatorExecutionObserver)>,
	child_pid: u32,
	error: &ProcessGroupCleanupError,
) {
	if error.release_observed_pid()
		&& let Some((pass, observer)) = observer.as_mut()
	{
		observer.child_reaped(*pass, child_pid, error.exit_code());
	}
}

fn wait_for_evaluator(
	child: &mut Child,
	diagnostic_timeout: Option<Duration>,
	child_pid: u32,
	observer: &mut Option<(usize, &mut dyn EvaluatorExecutionObserver)>,
) -> Result<(ExitStatus, bool), EvaluationError> {
	let started = Instant::now();

	loop {
		let exited = match process_group::poll_exit_without_reaping(child) {
			Ok(exited) => exited,
			Err(error) => {
				return Err(EvaluationError::execution(format!(
					"cannot poll evaluator; cached process group was not signaled: {error}"
				)));
			},
		};

		match exited {
			ProcessGroupPoll::Exited => {
				return match process_group::cleanup_after_poll(child, exited) {
					Ok(status) => Ok((status, false)),
					Err(error) => {
						observe_evaluator_cleanup_error(observer, child_pid, &error);

						Err(EvaluationError::execution(format!(
							"cannot clean up exited evaluator group: {error}"
						)))
					},
				};
			},
			ProcessGroupPoll::NotSignalable => {
				if let Some((pass, observer)) = observer.as_mut() {
					observer.child_reaped(*pass, child_pid, None);
				}

				return Err(EvaluationError::execution(
					"evaluator process-group leader is no longer waitable; cached process group was not signaled",
				));
			},
			ProcessGroupPoll::Running
				if diagnostic_timeout.is_some_and(|timeout| started.elapsed() >= timeout) =>
			{
				return match kill_and_reap_child(child) {
					Ok(status) => Ok((status, true)),
					Err(error) => {
						observe_evaluator_cleanup_error(observer, child_pid, &error);

						Err(EvaluationError::execution(format!(
							"cannot stop and reap evaluator group: {error}"
						)))
					},
				};
			},
			ProcessGroupPoll::Running => thread::sleep(Duration::from_millis(5)),
		}
	}
}

fn finish_capture(
	status: ExitStatus,
	timed_out: bool,
	threads: CaptureThreads,
) -> Result<Capture, EvaluationError> {
	let pipe_deadline = Instant::now() + Duration::from_millis(500);
	let stdin_error =
		threads.stdin.and_then(|stdin_thread| join_stdin_thread(stdin_thread, pipe_deadline));
	let (stdout, stdout_truncated) = join_reader_thread(threads.stdout, pipe_deadline, "stdout")?;
	let (_, stderr_truncated) = join_reader_thread(threads.stderr, pipe_deadline, "stderr")?;

	Ok(Capture {
		exit_code: status.code(),
		stdout,
		timed_out,
		stdout_truncated,
		stderr_truncated,
		stdin_error,
	})
}

#[cfg(unix)]
fn configure_process_group(command: &mut Command) {
	command.process_group(0);
}

#[cfg(not(unix))]
fn configure_process_group(_command: &mut Command) {}

fn kill_and_reap_child(child: &mut Child) -> Result<ExitStatus, ProcessGroupCleanupError> {
	process_group::kill_and_reap_group(child)
}

fn join_stdin_thread(thread: JoinHandle<std::io::Result<()>>, deadline: Instant) -> Option<String> {
	while !thread.is_finished() && Instant::now() < deadline {
		thread::sleep(Duration::from_millis(1));
	}

	if !thread.is_finished() {
		return Some("evaluator input pipe did not close after process termination".to_owned());
	}

	match thread.join() {
		Ok(Ok(())) => None,
		Ok(Err(error)) => Some(format!("cannot write evaluator input: {error}")),
		Err(_) => Some("evaluator stdin thread panicked".to_owned()),
	}
}

fn join_reader_thread(
	thread: ReaderThread,
	deadline: Instant,
	stream_name: &str,
) -> Result<(Vec<u8>, bool), EvaluationError> {
	while !thread.is_finished() && Instant::now() < deadline {
		thread::sleep(Duration::from_millis(1));
	}

	if !thread.is_finished() {
		// A non-Unix descendant can retain an inherited pipe after the direct child
		// is stopped. Detach the reader and report an incomplete capture.
		return Ok((Vec::new(), true));
	}

	thread
		.join()
		.map_err(|_| {
			EvaluationError::execution(format!("evaluator {stream_name} thread panicked"))
		})?
		.map_err(|error| {
			EvaluationError::execution(format!("cannot read evaluator {stream_name}: {error}"))
		})
}

fn read_stream(mut stream: impl Read, limit: usize) -> std::io::Result<(Vec<u8>, bool)> {
	let mut bytes = Vec::new();
	let mut buffer = [0_u8; 8_192];
	let mut truncated = false;

	loop {
		let read = stream.read(&mut buffer)?;

		if read == 0 {
			break;
		}

		let retained = read.min(limit.saturating_sub(bytes.len()));

		bytes.extend_from_slice(&buffer[..retained]);

		truncated |= retained < read;
	}

	Ok((bytes, truncated))
}

fn valid_sha256(value: &str) -> bool {
	value.strip_prefix("sha256:").is_some_and(|digest| {
		digest.len() == 64
			&& digest.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
			&& !digest.bytes().all(|byte| byte == b'0')
	})
}

fn safe_check_id(value: &str) -> bool {
	!value.is_empty()
		&& value.len() <= 128
		&& value
			.bytes()
			.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

#[cfg(target_os = "linux")]
fn is_strict_proc_self_fd_path(value: &Path) -> bool {
	let mut components = value.components();

	if !matches!(components.next(), Some(Component::RootDir))
		|| components.next() != Some(Component::Normal(OsStr::new("proc")))
		|| components.next() != Some(Component::Normal(OsStr::new("self")))
		|| components.next() != Some(Component::Normal(OsStr::new("fd")))
	{
		return false;
	}

	let Some(Component::Normal(descriptor)) = components.next() else {
		return false;
	};
	let descriptor = descriptor.as_encoded_bytes();

	if descriptor.is_empty() || !descriptor.iter().all(u8::is_ascii_digit) {
		return false;
	}

	components.all(|component| matches!(component, Component::Normal(_)))
}

fn valid_executable_ref(value: &Path) -> bool {
	let Some(text) = value.to_str() else {
		return false;
	};

	!text.is_empty()
		&& !value.is_absolute()
		&& value.components().all(|component| matches!(component, Component::Normal(_)))
		&& text.split('/').all(|segment| {
			let mut characters = segment.chars();

			characters.next().is_some_and(|character| character.is_ascii_alphanumeric())
				&& characters.all(|character| {
					character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
				})
		})
}
