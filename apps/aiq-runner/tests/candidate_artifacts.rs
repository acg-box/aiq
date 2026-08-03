//! Public candidate-artifact protocol integration coverage.

use std::{
	collections::BTreeSet,
	env, fs,
	path::{Path, PathBuf},
	process::{self, Command},
	time::{SystemTime, UNIX_EPOCH},
};

use clap as _;
use ed25519_dalek as _;
use ed25519_dalek::{Signer as _, SigningKey};
use hex as _;
use jiff as _;
use jiff_tzdb as _;
#[cfg(unix)]
use libc as _;
use serde as _;
use serde::Serialize;
use serde_json::Value;
use serde_json_canonicalizer as _;
use sha2 as _;
use sha2::{Digest as _, Sha256};
use ureq as _;

use aiq_runner::candidate_release_gate::CANDIDATE_CODEX_EGRESS_PROXY_ENDPOINT;
use aiq_runner::{
	adapter::ArtifactReference,
	candidate_artifacts::{
		CANDIDATE_CELL_VERIFICATION_PAYLOAD_TYPE, CandidateAttempt, CandidateAttemptDisposition,
		CandidateAttemptLogBundle, CandidateCellVerificationPayload,
		CandidateEvaluatorResultBundle, CandidateInfrastructureClassification,
		CandidateResultPackageBundle, CandidateSigningIdentity, CandidateVerificationDisposition,
		CandidateVerifierReplayBundle,
	},
	candidate_release_gate::{
		CANDIDATE_CATALOG_RELEASE_IDENTITY_SHA256, CANDIDATE_EXECUTION_AUTHORIZATION_SCHEMA,
		CANDIDATE_EXECUTION_PLAN_SCHEMA, CANDIDATE_MODEL_ID_MAPPING_SHA256,
		CANDIDATE_TASK_IDENTITY_SHA256, CandidateAggregateOutputs, CandidateAuthorizationIdentity,
		CandidateAuthorizationSigner, CandidateClassification, CandidateControlledInputs,
		CandidateExecutionAuthorization, CandidateExecutionExpectations, CandidateExecutionPlan,
		CandidateExecutionUnit, CandidateExecutionUnitKind, CandidateOutputReservations,
		CandidatePlanInputs, CandidateResolvedModel, CandidateRuntimeBindings,
		CandidateUnitOutputs, RELEASE_GATE_ADMISSION_SCHEMA, RELEASE_IDENTITY,
		ReleaseGateAdmissionSigner, ReleaseGateAdmissionV1, ReleaseGateContrastBinding,
		ReleaseGateModelConfiguration, ReleaseGateModelMatrix, ReleaseGateObservationUniverse,
		ReleaseGateRepeat, ReleaseGateRetryPolicy,
	},
	corpus_commitment::{
		CANDIDATE_CONTRAST_CATALOG_IDENTITY_SHA256, RunClass, RunProvenanceCommitment,
	},
	model::{MODEL_MATRIX, ModelConfig, ModelFamily, ReasoningEffort},
	protocol::{self, ResultProvenance, TrustTier},
	runner::{
		CALIBRATION_RUN_SCHEMA_VERSION, CalibrationRunRecord, EVALUATOR_RESULTS_SCHEMA_VERSION,
		EvaluationOutcome, EvaluatorResultsBundle, FailureKind, Latency, RESULT_SCHEMA_VERSION,
		ResultFailure, ResultStatus, TaskResult, ToolUsage,
	},
	schedule::{ScheduleOccurrence, ScheduleSlot},
	scoring::AIQ_SCORING_VERSION,
	task::{
		EVALUATOR_RESULT_SCHEMA_VERSION, EvaluationResult, EvaluatorCheck,
		EvaluatorCheckFailureClass, EvaluatorOutcome, EvaluatorRuntime,
	},
};

const DIGEST_A: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DIGEST_B: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TRUST_POLICY_DIGEST_ENV: &str = "AIQ_CORE_1_0_2_RELEASE_TRUST_POLICY_SHA256";
const FULL_FIXTURE_PRIVATE_RESPONSE: &str = "PRIVATE_CANDIDATE_RESPONSE_MUST_NOT_ESCAPE";

struct Fixture {
	authorization: CandidateExecutionAuthorization,
	unit: CandidateExecutionUnit,
	run: CalibrationRunRecord,
	evaluators: EvaluatorResultsBundle,
	runner: CandidateSigningIdentity,
	verifier: CandidateSigningIdentity,
}

struct FullLifecycleFixture {
	_root: TestDirectory,
	expectations_path: PathBuf,
	source_output: PathBuf,
	evidence_output: PathBuf,
	trust_policy_digest: String,
	source_observations_digest: String,
	private_path_sentinel: String,
}
impl FullLifecycleFixture {
	fn create() -> Self {
		let root = TestDirectory::new("full-lifecycle");
		let output_root = create_output_root(&root);
		let node = find_node_runtime();
		let runtime = EvaluatorRuntime::resolve(&node).expect("Node runtime");
		let authority_key = SigningKey::from_bytes(&[21; 32]);
		let runner = CandidateSigningIdentity::from_secret([22; 32]);
		let verifier = CandidateSigningIdentity::from_secret([23; 32]);
		let authorization_identity = CandidateAuthorizationIdentity::from_secret([24; 32]);
		let inputs = full_lifecycle_inputs(&root, &authority_key);
		let trust_policy_path = inputs.trust_policy_path;
		let trust_policy_digest = inputs.trust_policy_digest;
		let core_path = inputs.core_path;
		let core_digest = inputs.core_digest;
		let contrast_path = inputs.contrast_path;
		let contrast_digest = inputs.contrast_digest;
		let manifest_path = inputs.manifest_path;
		let manifest_digest = inputs.manifest_digest;
		let admission = inputs.admission;
		let admission_path = inputs.admission_path;
		let admission_digest = inputs.admission_digest;
		let authorization_path = root.path().join("authorization.json");
		let controlled = controlled_inputs(root.path(), &node, &runner, &verifier);
		let plan_inputs = CandidatePlanInputs {
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
			runtime: CandidateRuntimeBindings {
				runner_executable_sha256: file_digest(Path::new(env!("CARGO_BIN_EXE_aiq-runner"))),
				verifier_executable_sha256: test_digest("verifier"),
				evaluator_runtime_sha256: runtime.executable_digest().to_owned(),
				core_harness_sha256: test_digest("core-harness"),
				core_tool_policy_sha256: test_digest("core-tool"),
				core_network_policy_sha256: test_digest("core-network"),
				contrast_harness_sha256: test_digest("contrast-harness"),
				contrast_tool_policy_sha256: test_digest("contrast-tool"),
				contrast_network_policy_sha256: test_digest("contrast-network"),
			},
			controlled_inputs: controlled,
			output_root: output_root.clone(),
		};
		let plan_inputs_path = root.path().join("plan-inputs.json");

		write_canonical(&plan_inputs_path, &plan_inputs);

		let authorization = plan_and_authorize_candidate(
			&admission_path,
			&trust_policy_path,
			&trust_policy_digest,
			&plan_inputs_path,
			&authorization_path,
		);
		let collected_at = "2026-08-02T03:30:00.000Z".to_owned();
		let execution_expectations = CandidateExecutionExpectations {
			authorization_path: authorization_path.clone(),
			authorization_sha256: authorization.digest().expect("authorization digest"),
			authorization_signer_node_id: authorization_identity.signer().node_id.clone(),
			authorization_signer_public_key: authorization_identity.signer().public_key.clone(),
			signed_admission_path: admission_path.clone(),
			signed_admission_sha256: admission_digest.clone(),
			signed_admission_key_id: "candidate-authority-test".to_owned(),
			release_trust_policy_path: trust_policy_path.clone(),
			release_trust_policy_sha256: trust_policy_digest.clone(),
			execution_plan_sha256: test_digest("execution-plan"),
			corpus_manifest_path: manifest_path.clone(),
			corpus_manifest_sha256: manifest_digest.clone(),
			core_corpus_commitment_path: core_path.clone(),
			core_corpus_commitment_sha256: core_digest.clone(),
			contrast_corpus_commitment_path: contrast_path.clone(),
			contrast_corpus_commitment_sha256: contrast_digest.clone(),
			verifier_replay_root: authorization.plan.controlled_inputs.verifier_replay_root.clone(),
			observed_at: collected_at.clone(),
		};
		let execution_expectations_path = root.path().join("execution-expectations.json");

		write_canonical(&execution_expectations_path, &execution_expectations);

		let mut reservations =
			CandidateOutputReservations::reserve(&authorization.plan, &admission)
				.expect("reservations");

		rust_emit_all_unit_artifacts(&authorization, &runner, &verifier, &mut reservations);
		drop(reservations);

		let (expectations_path, source_observations_digest) = prepare_candidate_aggregate(
			&root,
			&node,
			&authority_key,
			&execution_expectations_path,
			(&trust_policy_path, &trust_policy_digest),
		);

		Self {
			source_output: authorization.plan.aggregate_outputs.source_observations.clone(),
			evidence_output: authorization.plan.aggregate_outputs.release_gate_evidence.clone(),
			_root: root,
			expectations_path,
			trust_policy_digest,
			source_observations_digest,
			private_path_sentinel: authorization
				.plan
				.controlled_inputs
				.core_tasks_root
				.to_string_lossy()
				.into_owned(),
		}
	}
}

struct FullLifecycleInputs {
	trust_policy_path: PathBuf,
	trust_policy_digest: String,
	core_path: PathBuf,
	core_digest: String,
	contrast_path: PathBuf,
	contrast_digest: String,
	manifest_path: PathBuf,
	manifest_digest: String,
	admission: ReleaseGateAdmissionV1,
	admission_path: PathBuf,
	admission_digest: String,
}

struct TestDirectory(PathBuf);
impl TestDirectory {
	fn new(label: &str) -> Self {
		for counter in 0..128_u64 {
			let nonce = SystemTime::now().duration_since(UNIX_EPOCH).expect("clock").as_nanos();
			let path = env::temp_dir()
				.join(format!("aiq-candidate-{label}-{}-{nonce}-{counter}", process::id()));

			if fs::create_dir(&path).is_ok() {
				return Self(fs::canonicalize(path).expect("canonical test directory"));
			}
		}

		panic!("test directory namespace exhausted");
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

fn full_lifecycle_inputs(root: &TestDirectory, authority_key: &SigningKey) -> FullLifecycleInputs {
	let trust_policy_path = root.path().join("trust-policy.json");
	let trust_policy_digest = write_canonical(&trust_policy_path, &trust_policy(authority_key));
	let core_path = root.path().join("core-commitment.json");
	let contrast_path = root.path().join("contrast-commitment.json");
	let core_digest = write_canonical(&core_path, &serde_json::json!({"kind": "core"}));
	let contrast_digest = write_canonical(&contrast_path, &serde_json::json!({"kind": "contrast"}));
	let manifest_path = root.path().join("corpus-manifest.json");
	let manifest = serde_json::json!({
		"schema_version": "aiq.release-gate-corpus-manifest.v1", "release_identity": RELEASE_IDENTITY,
		"catalog_release_identity_digest": CANDIDATE_CATALOG_RELEASE_IDENTITY_SHA256,
		"task_metadata_identity_digest": CANDIDATE_TASK_IDENTITY_SHA256,
		"canonicalization": "aiq.sorted-key-json.v1", "core_task_count": 72, "contrast_task_count": 6,
		"core_corpus_commitment_sha256": core_digest, "contrast_corpus_commitment_sha256": contrast_digest,
	});
	let manifest_digest = write_canonical(&manifest_path, &manifest);
	let mut admission = full_admission(&manifest_digest);

	admission.signature = sign_value_without_signature(&admission, authority_key);

	let admission_path = root.path().join("admission.json");
	let admission_digest = write_canonical(&admission_path, &admission);

	FullLifecycleInputs {
		trust_policy_path,
		trust_policy_digest,
		core_path,
		core_digest,
		contrast_path,
		contrast_digest,
		manifest_path,
		manifest_digest,
		admission,
		admission_path,
		admission_digest,
	}
}

#[test]
fn result_and_evaluator_bundles_enforce_signed_cell_alignment() {
	let fixture = fixture();
	let results = CandidateResultPackageBundle::sign(
		&fixture.authorization,
		&fixture.unit,
		fixture.run.clone(),
		&fixture.runner,
	)
	.expect("sign result bundle");
	let verified_run =
		results.verify(&fixture.authorization, &fixture.unit).expect("verify result bundle");

	assert_eq!(verified_run.run.results.len(), 4);

	let result_digests = results
		.cells
		.iter()
		.map(|cell| cell.digest().expect("result cell digest"))
		.collect::<BTreeSet<_>>();

	assert_eq!(result_digests.len(), results.cells.len());

	let evaluators = CandidateEvaluatorResultBundle::sign(
		&fixture.authorization,
		&fixture.unit,
		&results,
		&fixture.evaluators,
		&fixture.runner,
	)
	.expect("sign evaluator bundle");
	let evaluator_payloads = evaluators
		.verify(&fixture.authorization, &fixture.unit, &results)
		.expect("verify evaluator bundle");
	let evaluator_digests = evaluators
		.cells
		.iter()
		.map(|cell| cell.digest().expect("evaluator cell digest"))
		.collect::<BTreeSet<_>>();

	assert_eq!(evaluator_digests.len(), evaluators.cells.len());

	let observed_order = evaluator_payloads
		.iter()
		.map(|payload| {
			(
				payload.cell.result_index,
				payload.cell.execution_model_id.as_str(),
				payload.cell.task_id.as_str(),
			)
		})
		.collect::<Vec<_>>();

	assert_eq!(
		observed_order,
		vec![
			(0, "gpt-5.6-sol-medium", "task-a"),
			(1, "gpt-5.6-sol-medium", "task-b"),
			(2, "gpt-5.6-terra-high", "task-a"),
			(3, "gpt-5.6-terra-high", "task-b"),
		]
	);

	let mut tampered_results = results.clone();

	tampered_results.cells[0].payload["result_id"] = serde_json::json!("result_tampered");

	assert!(tampered_results.verify(&fixture.authorization, &fixture.unit).is_err());

	let mut tampered_evaluators = evaluators.clone();

	tampered_evaluators.cells[0].payload["persisted_evaluator_sha256"] =
		serde_json::json!(DIGEST_B);

	assert!(tampered_evaluators.verify(&fixture.authorization, &fixture.unit, &results).is_err());

	let wrong_runner = CandidateSigningIdentity::from_secret([31; 32]);

	assert!(
		CandidateResultPackageBundle::sign(
			&fixture.authorization,
			&fixture.unit,
			fixture.run.clone(),
			&wrong_runner,
		)
		.is_err()
	);

	let mut misaligned = fixture.evaluators.clone();

	misaligned.results.swap(0, 1);

	assert!(
		CandidateEvaluatorResultBundle::sign(
			&fixture.authorization,
			&fixture.unit,
			&results,
			&misaligned,
			&fixture.runner,
		)
		.is_err()
	);
}

#[test]
fn verifier_replay_requires_a_distinct_authorized_identity() {
	let fixture = fixture();

	assert_ne!(fixture.runner.node().node_id, fixture.verifier.node().node_id);

	let results = CandidateResultPackageBundle::sign(
		&fixture.authorization,
		&fixture.unit,
		fixture.run.clone(),
		&fixture.runner,
	)
	.expect("sign result bundle");
	let evaluators = CandidateEvaluatorResultBundle::sign(
		&fixture.authorization,
		&fixture.unit,
		&results,
		&fixture.evaluators,
		&fixture.runner,
	)
	.expect("sign evaluator bundle");
	let evaluator_payloads = evaluators
		.verify(&fixture.authorization, &fixture.unit, &results)
		.expect("verify evaluator bundle");
	let payloads = evaluator_payloads
		.into_iter()
		.enumerate()
		.map(|(index, evaluator)| CandidateCellVerificationPayload {
			schema_version: CANDIDATE_CELL_VERIFICATION_PAYLOAD_TYPE.to_owned(),
			unit: results.unit.clone(),
			cell: evaluator.cell,
			result_package_sha256: results.cells[index].digest().expect("result digest"),
			evaluator_package_sha256: evaluators.cells[index].digest().expect("evaluator digest"),
			replayed_evaluator_sha256: evaluator
				.evaluator
				.as_ref()
				.map(|value| value.digest().expect("candidate evaluator digest")),
			verified: true,
			disposition: CandidateVerificationDisposition::CandidateEvaluatorReplayed,
		})
		.collect::<Vec<_>>();
	let replays = CandidateVerifierReplayBundle::sign(
		&fixture.authorization,
		&fixture.unit,
		&results,
		&evaluators,
		payloads.clone(),
		&fixture.verifier,
	)
	.expect("sign verifier replay bundle");
	let mut ambiguous_payloads = payloads.clone();

	ambiguous_payloads[0].disposition =
		CandidateVerificationDisposition::CandidateResultNoncompletedNotVerified;

	assert!(
		CandidateVerifierReplayBundle::sign(
			&fixture.authorization,
			&fixture.unit,
			&results,
			&evaluators,
			ambiguous_payloads,
			&fixture.verifier,
		)
		.is_err()
	);
	assert_eq!(
		replays
			.verify(&fixture.authorization, &fixture.unit, &results, &evaluators)
			.expect("verify replay bundle"),
		payloads
	);
	assert_eq!(
		replays
			.cells
			.iter()
			.map(|cell| cell.digest().expect("replay cell digest"))
			.collect::<BTreeSet<_>>()
			.len(),
		replays.cells.len()
	);
	assert_eq!(
		replays.cells.iter().map(|cell| &cell.signer.node_id).collect::<BTreeSet<_>>(),
		BTreeSet::from([&fixture.verifier.node().node_id])
	);
	assert!(
		CandidateVerifierReplayBundle::sign(
			&fixture.authorization,
			&fixture.unit,
			&results,
			&evaluators,
			payloads.clone(),
			&fixture.runner,
		)
		.is_err()
	);

	let wrong_verifier = CandidateSigningIdentity::from_secret([41; 32]);

	assert!(
		CandidateVerifierReplayBundle::sign(
			&fixture.authorization,
			&fixture.unit,
			&results,
			&evaluators,
			payloads,
			&wrong_verifier,
		)
		.is_err()
	);

	let mut tampered = replays;

	tampered.cells[0].payload["verified"] = serde_json::json!(false);

	assert!(tampered.verify(&fixture.authorization, &fixture.unit, &results, &evaluators).is_err());
}

#[test]
fn attempt_logs_bind_retries_and_completed_provenance_in_model_major_order() {
	let fixture = fixture();
	let (results, evaluators, replays) = signed_bundles(&fixture);
	let attempts = completed_attempts(&fixture, &results, &replays);
	let logs = CandidateAttemptLogBundle::sign(
		&fixture.authorization,
		&fixture.unit,
		&results,
		&evaluators,
		&replays,
		attempts.clone(),
		&fixture.runner,
	)
	.expect("sign attempt logs");
	let payloads = logs
		.verify(&fixture.authorization, &fixture.unit, &results, &evaluators, &replays)
		.expect("verify attempt logs");

	assert_eq!(
		payloads.iter().map(|payload| payload.cell.result_index).collect::<Vec<_>>(),
		vec![0, 1, 2, 3]
	);
	assert_eq!(payloads[0].attempts.len(), 3);
	assert_eq!(payloads[0].attempts[1].scheduled_delay_seconds, 30);
	assert_eq!(payloads[0].attempts[2].scheduled_delay_seconds, 90);
	assert_eq!(
		logs.cells
			.iter()
			.map(|cell| cell.digest().expect("attempt-log cell digest"))
			.collect::<BTreeSet<_>>()
			.len(),
		logs.cells.len()
	);

	let mut tampered = logs.clone();

	tampered.cells[0].payload["attempts"][2]["started_at"] =
		serde_json::json!("2026-08-03T12:00:46.000Z");

	assert!(
		tampered
			.verify(&fixture.authorization, &fixture.unit, &results, &evaluators, &replays)
			.is_err()
	);

	let mut reordered = logs.clone();

	reordered.cells.swap(0, 1);

	assert!(
		reordered
			.verify(&fixture.authorization, &fixture.unit, &results, &evaluators, &replays)
			.is_err()
	);

	let mut duplicated = logs.clone();

	duplicated.cells[1] = duplicated.cells[0].clone();

	assert!(
		duplicated
			.verify(&fixture.authorization, &fixture.unit, &results, &evaluators, &replays)
			.is_err()
	);

	assert_attempt_log_rejections(&fixture, &results, &evaluators, &replays, attempts);
}

fn assert_attempt_log_rejections(
	fixture: &Fixture,
	results: &CandidateResultPackageBundle,
	evaluators: &CandidateEvaluatorResultBundle,
	replays: &CandidateVerifierReplayBundle,
	attempts: Vec<Vec<CandidateAttempt>>,
) {
	let sign = |attempts, signer| {
		CandidateAttemptLogBundle::sign(
			&fixture.authorization,
			&fixture.unit,
			results,
			evaluators,
			replays,
			attempts,
			signer,
		)
	};
	let wrong_runner = CandidateSigningIdentity::from_secret([51; 32]);

	assert!(sign(attempts.clone(), &wrong_runner).is_err());

	let mut wrong_retry = attempts.clone();

	wrong_retry[0][1].scheduled_delay_seconds = 90;

	assert!(sign(wrong_retry, &fixture.runner).is_err());

	let mut early = attempts.clone();

	early[1][0].started_at = "2026-08-03T11:59:59.000Z".to_owned();

	assert!(sign(early, &fixture.runner).is_err());

	let mut missing_provenance = attempts;

	missing_provenance[2][0].verifier_attestation_digest = None;

	assert!(sign(missing_provenance, &fixture.runner).is_err());
}

#[test]
fn incomplete_attempts_cannot_invent_model_artifacts() {
	let fixture = incomplete_fixture();
	let (results, evaluators, replays) = signed_bundles(&fixture);
	let attempts = mixed_attempts(&fixture, &results, &replays);
	let logs = CandidateAttemptLogBundle::sign(
		&fixture.authorization,
		&fixture.unit,
		&results,
		&evaluators,
		&replays,
		attempts.clone(),
		&fixture.runner,
	)
	.expect("sign incomplete attempt logs without invented provenance");
	let payloads = logs
		.verify(&fixture.authorization, &fixture.unit, &results, &evaluators, &replays)
		.expect("verify incomplete attempt logs");

	assert_eq!(payloads[2].attempts.len(), 3);
	assert_eq!(
		payloads[2].attempts.iter().map(|attempt| attempt.disposition).collect::<Vec<_>>(),
		vec![
			CandidateAttemptDisposition::InfrastructureRetryable,
			CandidateAttemptDisposition::InfrastructureRetryable,
			CandidateAttemptDisposition::InfrastructureTerminal,
		]
	);

	for index in 0..3 {
		let mut invented = attempts.clone();

		invented[index][0].result_digest = Some(DIGEST_A.to_owned());

		assert!(
			CandidateAttemptLogBundle::sign(
				&fixture.authorization,
				&fixture.unit,
				&results,
				&evaluators,
				&replays,
				invented,
				&fixture.runner,
			)
			.is_err(),
			"incomplete cell {index} accepted invented result provenance"
		);
	}
}

#[test]
fn rust_emitted_full_candidate_lifecycle_fills_exact_cross_language_aggregates() {
	let fixture = FullLifecycleFixture::create();
	let command = || {
		let mut process = Command::new(env!("CARGO_BIN_EXE_aiq-runner"));

		process.args(["candidate", "aggregate", "--expectations"]).arg(&fixture.expectations_path);

		process
	};
	let missing = command().env_remove(TRUST_POLICY_DIGEST_ENV).output().expect("missing anchor");

	assert!(!missing.status.success());

	let malformed = command()
		.env(TRUST_POLICY_DIGEST_ENV, "sha256:not-canonical")
		.output()
		.expect("malformed anchor");

	assert!(!malformed.status.success());

	let mismatch = command()
		.env(TRUST_POLICY_DIGEST_ENV, format!("sha256:{}", "f".repeat(64)))
		.output()
		.expect("mismatched anchor");

	assert!(!mismatch.status.success());

	let first = command()
		.env(TRUST_POLICY_DIGEST_ENV, &fixture.trust_policy_digest)
		.output()
		.expect("aggregate candidate artifacts");

	assert!(first.status.success(), "{}", String::from_utf8_lossy(&first.stderr));

	let source = fs::read(&fixture.source_output).expect("source observations");
	let evidence = fs::read(&fixture.evidence_output).expect("release evidence");

	assert!(!source.is_empty() && !evidence.is_empty());
	assert!(!String::from_utf8_lossy(&source).contains(FULL_FIXTURE_PRIVATE_RESPONSE));
	assert!(!String::from_utf8_lossy(&evidence).contains(FULL_FIXTURE_PRIVATE_RESPONSE));
	assert!(!String::from_utf8_lossy(&source).contains(&fixture.private_path_sentinel));
	assert!(!String::from_utf8_lossy(&evidence).contains(&fixture.private_path_sentinel));

	let source_value: Value = serde_json::from_slice(&source).expect("source JSON");

	assert_eq!(source_value["raw_cells"].as_array().expect("raw cells").len(), 3_672);

	let pairs = source_value["paired_contrasts"]
		.as_array()
		.expect("paired contrasts")
		.iter()
		.map(|contrast| contrast["pairs"].as_array().expect("pairs").len())
		.sum::<usize>();

	assert_eq!(pairs, 153);
	assert_eq!(pairs * 2, 306);

	let evidence_value: Value = serde_json::from_slice(&evidence).expect("evidence JSON");

	assert_eq!(evidence_value["source_observations_digest"], fixture.source_observations_digest);

	let resumed = command()
		.env(TRUST_POLICY_DIGEST_ENV, &fixture.trust_policy_digest)
		.output()
		.expect("resume exact aggregates");

	assert!(resumed.status.success(), "{}", String::from_utf8_lossy(&resumed.stderr));
	assert_eq!(fs::read(&fixture.source_output).expect("resumed source"), source);
	assert_eq!(fs::read(&fixture.evidence_output).expect("resumed evidence"), evidence);
}

#[test]
fn plan_and_authorize_reject_untrusted_admission_before_private_inputs() {
	let root = TestDirectory::new("untrusted-bootstrap");
	let trusted_key = SigningKey::from_bytes(&[41; 32]);
	let untrusted_key = SigningKey::from_bytes(&[42; 32]);
	let policy_path = root.path().join("trust-policy.json");
	let policy_digest = write_canonical(&policy_path, &trust_policy(&trusted_key));
	let mut admission = full_admission(&test_digest("untrusted-bootstrap-manifest"));

	admission.signature = sign_value_without_signature(&admission, &untrusted_key);

	let admission_path = root.path().join("admission.json");

	write_canonical(&admission_path, &admission);

	let missing_inputs = root.path().join("missing-private-plan-inputs.json");
	let missing_plan = root.path().join("missing-private-plan.json");

	for output in [
		Command::new(env!("CARGO_BIN_EXE_aiq-runner"))
			.args(["candidate", "plan", "--admission"])
			.arg(&admission_path)
			.args(["--release-trust-policy"])
			.arg(&policy_path)
			.args(["--inputs"])
			.arg(&missing_inputs)
			.args(["--output"])
			.arg(root.path().join("execution-plan.json"))
			.env(TRUST_POLICY_DIGEST_ENV, &policy_digest)
			.output()
			.expect("untrusted plan command"),
		Command::new(env!("CARGO_BIN_EXE_aiq-runner"))
			.args(["candidate", "authorize", "--admission"])
			.arg(&admission_path)
			.args(["--release-trust-policy"])
			.arg(&policy_path)
			.args(["--plan"])
			.arg(&missing_plan)
			.args(["--signing-key-env", "AIQ_MISSING_AUTHORIZATION_KEY", "--output"])
			.arg(root.path().join("authorization.json"))
			.env(TRUST_POLICY_DIGEST_ENV, &policy_digest)
			.env_remove("AIQ_MISSING_AUTHORIZATION_KEY")
			.output()
			.expect("untrusted authorize command"),
	] {
		assert!(!output.status.success());
		assert!(
			String::from_utf8_lossy(&output.stderr)
				.contains("candidate admission signature does not verify"),
			"{}",
			String::from_utf8_lossy(&output.stderr)
		);
	}

	assert!(!root.path().join("execution-plan.json").exists());
	assert!(!root.path().join("authorization.json").exists());
}

fn create_output_root(root: &TestDirectory) -> PathBuf {
	let output_root = root.path().join("outputs");

	fs::create_dir(&output_root).expect("output root");

	output_root
}

fn plan_and_authorize_candidate(
	admission_path: &Path,
	trust_policy_path: &Path,
	trust_policy_digest: &str,
	plan_inputs_path: &Path,
	authorization_path: &Path,
) -> CandidateExecutionAuthorization {
	let plan_path = authorization_path.with_file_name("execution-plan.json");
	let planned = Command::new(env!("CARGO_BIN_EXE_aiq-runner"))
		.args(["candidate", "plan", "--admission"])
		.arg(admission_path)
		.args(["--release-trust-policy"])
		.arg(trust_policy_path)
		.args(["--inputs"])
		.arg(plan_inputs_path)
		.args(["--output"])
		.arg(&plan_path)
		.env(TRUST_POLICY_DIGEST_ENV, trust_policy_digest)
		.output()
		.expect("candidate plan command");

	assert!(planned.status.success(), "{}", String::from_utf8_lossy(&planned.stderr));

	assert_canonical_file(&plan_path);

	let plan: CandidateExecutionPlan =
		serde_json::from_slice(&fs::read(&plan_path).expect("plan bytes")).expect("execution plan");
	let authorized = Command::new(env!("CARGO_BIN_EXE_aiq-runner"))
		.args(["candidate", "authorize", "--admission"])
		.arg(admission_path)
		.args(["--release-trust-policy"])
		.arg(trust_policy_path)
		.args(["--plan"])
		.arg(&plan_path)
		.args(["--signing-key-env", "AIQ_TEST_AUTHORIZATION_KEY", "--output"])
		.arg(authorization_path)
		.env("AIQ_TEST_AUTHORIZATION_KEY", hex::encode([24; 32]))
		.env(TRUST_POLICY_DIGEST_ENV, trust_policy_digest)
		.output()
		.expect("candidate authorize command");

	assert!(authorized.status.success(), "{}", String::from_utf8_lossy(&authorized.stderr));

	let authorization: CandidateExecutionAuthorization =
		serde_json::from_slice(&fs::read(authorization_path).expect("authorization bytes"))
			.expect("authorization");

	assert_eq!(authorization.plan, plan);

	authorization
}

fn prepare_candidate_aggregate(
	root: &TestDirectory,
	node: &Path,
	authority_key: &SigningKey,
	execution_expectations_path: &Path,
	trust: (&Path, &str),
) -> (PathBuf, String) {
	let (trust_policy_path, trust_policy_digest) = trust;
	let derivation = Command::new(env!("CARGO_BIN_EXE_aiq-runner"))
		.args(["candidate", "derive-aggregate-source", "--expectations"])
		.arg(execution_expectations_path)
		.env(TRUST_POLICY_DIGEST_ENV, trust_policy_digest)
		.output()
		.expect("derive source observations");

	assert!(derivation.status.success(), "{}", String::from_utf8_lossy(&derivation.stderr));

	let derivation: Value =
		serde_json::from_slice(&derivation.stdout).expect("source derivation output");
	let source_observations_digest = derivation["source_observations_digest"]
		.as_str()
		.expect("derived source digest")
		.to_owned();
	let authority_input_path = root.path().join("authority-input.json");
	let authority_input = Command::new(env!("CARGO_BIN_EXE_aiq-runner"))
		.args(["candidate", "release-authority-input", "--expectations"])
		.arg(execution_expectations_path)
		.args(["--signer-key-id", "candidate-authority-test", "--output"])
		.arg(&authority_input_path)
		.env(TRUST_POLICY_DIGEST_ENV, trust_policy_digest)
		.output()
		.expect("build release authority input");

	assert!(
		authority_input.status.success(),
		"{}",
		String::from_utf8_lossy(&authority_input.stderr)
	);

	assert_canonical_file(&authority_input_path);

	let authority_path = root.path().join("authority.json");
	let authority_sign = Command::new(node)
		.arg("--experimental-strip-types")
		.arg(concat!(
			env!("CARGO_MANIFEST_DIR"),
			"/../../scripts/candidates/aiq-core-1.0.2/candidate-release.ts"
		))
		.args(["sign-authority", "--input"])
		.arg(&authority_input_path)
		.args(["--trust-policy"])
		.arg(trust_policy_path)
		.args(["--key-env", "AIQ_TEST_AUTHORITY_PEM", "--output"])
		.arg(&authority_path)
		.env(TRUST_POLICY_DIGEST_ENV, trust_policy_digest)
		.env("AIQ_TEST_AUTHORITY_PEM", signing_key_pem(authority_key))
		.output()
		.expect("sign release authority");

	assert!(authority_sign.status.success(), "{}", String::from_utf8_lossy(&authority_sign.stderr));

	let expectations_path = root.path().join("aggregate-expectations.json");
	let aggregate_expectations = Command::new(env!("CARGO_BIN_EXE_aiq-runner"))
		.args(["candidate", "aggregate-expectations", "--execution-expectations"])
		.arg(execution_expectations_path)
		.args(["--release-authority"])
		.arg(&authority_path)
		.args(["--release-trust-policy"])
		.arg(trust_policy_path)
		.args(["--output"])
		.arg(&expectations_path)
		.env(TRUST_POLICY_DIGEST_ENV, trust_policy_digest)
		.output()
		.expect("build aggregate expectations");

	assert!(
		aggregate_expectations.status.success(),
		"{}",
		String::from_utf8_lossy(&aggregate_expectations.stderr)
	);

	assert_canonical_file(&expectations_path);

	(expectations_path, source_observations_digest)
}

fn full_admission(corpus_manifest_digest: &str) -> ReleaseGateAdmissionV1 {
	let configurations = MODEL_MATRIX
		.into_iter()
		.map(|model| {
			let value = serde_json::to_value(model).expect("model value");
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
	let mut digest_configurations = configurations.clone();

	digest_configurations.sort_by(|left, right| left.model_id.cmp(&right.model_id));

	let matrix_digest = protocol::canonical_hash(&digest_configurations).expect("matrix digest");
	let contrast_ids =
		["coupled_constraints", "ambiguous_recovery_state", "plausible_incomplete_evidence"];

	ReleaseGateAdmissionV1 {
		schema_version: RELEASE_GATE_ADMISSION_SCHEMA.to_owned(),
		signature_domain: RELEASE_GATE_ADMISSION_SCHEMA.to_owned(),
		signature_encoding: "aiq.sorted-key-json.v1".to_owned(),
		release_identity: RELEASE_IDENTITY.to_owned(),
		catalog_release_identity_digest: CANDIDATE_CATALOG_RELEASE_IDENTITY_SHA256.to_owned(),
		task_metadata_identity_digest: CANDIDATE_TASK_IDENTITY_SHA256.to_owned(),
		corpus_commitment_digest: corpus_manifest_digest.to_owned(),
		plan_id: "candidate-release-plan-test".to_owned(),
		execution_plan_digest: test_digest("execution-plan"),
		model_id_mapping_digest: CANDIDATE_MODEL_ID_MAPPING_SHA256.to_owned(),
		issued_at: "2026-08-01T00:00:00.000Z".to_owned(),
		collection_not_before: "2026-08-02T00:00:00.000Z".to_owned(),
		collection_not_after: "2026-08-02T04:00:00.000Z".to_owned(),
		repeat_schedule: (0..3)
			.map(|index| ReleaseGateRepeat {
				repeat_id: format!("repeat-{}", index + 1),
				scheduled_at: format!("2026-08-02T0{}:00:00.000Z", index + 1),
				contrast_arm_order: contrast_ids
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
			task_ids: candidate_catalog_tasks()
				.into_iter()
				.map(|task| task["task_id"].as_str().expect("task ID").to_owned())
				.collect(),
			model_ids: configurations.iter().map(|item| item.model_id.clone()).collect(),
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
		model_matrix: ReleaseGateModelMatrix { digest: matrix_digest, configurations },
		contrast_bindings: contrast_ids
			.into_iter()
			.map(|contrast_id| ReleaseGateContrastBinding {
				contrast_id: contrast_id.to_owned(),
				reference_variant_digest: test_digest(&format!("{contrast_id}-reference")),
				challenge_variant_digest: test_digest(&format!("{contrast_id}-challenge")),
			})
			.collect(),
		signer: ReleaseGateAdmissionSigner {
			key_id: "candidate-authority-test".to_owned(),
			algorithm: "ed25519".to_owned(),
		},
		signature: String::new(),
	}
}

fn controlled_inputs(
	root: &Path,
	node: &Path,
	runner: &CandidateSigningIdentity,
	verifier: &CandidateSigningIdentity,
) -> CandidateControlledInputs {
	let path = |name: &str| root.join(name);

	CandidateControlledInputs {
		core_tasks_root: path("core-tasks"),
		contrast_tasks_root: path("contrast-tasks"),
		source_root: path("source"),
		core_workspace_root: path("core-workspace"),
		contrast_workspace_root: path("contrast-workspace"),
		execution_root: path("execution"),
		evaluator_root: path("evaluators"),
		evaluator_runtime: node.to_owned(),
		codex_toolchain_root: path("toolchain"),
		capabilities: path("capabilities.json"),
		schedule: path("schedule.json"),
		codex_binary: path("codex"),
		codex_home: path("codex-home"),
		codex_egress_proxy: CANDIDATE_CODEX_EGRESS_PROXY_ENDPOINT.to_owned(),
		artifact_root: path("artifacts"),
		work_root: path("work"),
		verifier_replay_root: path("verifier-replay"),
		jobs: 1,
		runner_signer_node_id: runner.node().node_id.clone(),
		verifier_signer_node_id: verifier.node().node_id.clone(),
	}
}

fn rust_emit_all_unit_artifacts(
	authorization: &CandidateExecutionAuthorization,
	runner: &CandidateSigningIdentity,
	verifier: &CandidateSigningIdentity,
	reservations: &mut CandidateOutputReservations,
) {
	let mut evaluator_digests = BTreeSet::new();

	for unit in &authorization.plan.execution_units {
		let mut run = full_calibration_run(unit);

		bind_run_provenance(&mut run, authorization, unit);

		let evaluations = (0..run.results.len())
			.map(|result_index| {
				let mut evaluation = evaluation(&[]);

				for check in &mut evaluation.checks {
					check.evidence_digest =
						test_digest(&format!("{}-{result_index}-{}", unit.unit_id, check.check_id));
				}

				evaluation
			})
			.collect::<Vec<_>>();

		for (result, evaluation) in run.results.iter_mut().zip(&evaluations) {
			result.evaluator_result_sha256 =
				Some(protocol::canonical_hash(evaluation).expect("evaluator digest"));
			result.result_id = format!(
				"result_{}",
				result.content_hash().expect("result hash").trim_start_matches("sha256:")
			);
		}

		let results = CandidateResultPackageBundle::sign(authorization, unit, run, runner)
			.expect("result bundle");
		let evaluator_bundle = CandidateEvaluatorResultBundle::sign(
			authorization,
			unit,
			&results,
			&EvaluatorResultsBundle {
				schema_version: EVALUATOR_RESULTS_SCHEMA_VERSION.to_owned(),
				results: evaluations.into_iter().map(Some).collect(),
			},
			runner,
		)
		.expect("evaluator bundle");
		let evaluator_payloads =
			evaluator_bundle.verify(authorization, unit, &results).expect("evaluator payloads");

		for evaluator in &evaluator_payloads {
			let digest = evaluator
				.evaluator
				.as_ref()
				.expect("completed evaluator")
				.digest()
				.expect("candidate evaluator digest");

			assert!(
				evaluator_digests.insert(digest),
				"full lifecycle fixture reused an evaluator evidence digest"
			);
		}

		let replay_payloads = evaluator_payloads
			.iter()
			.enumerate()
			.map(|(index, evaluator)| CandidateCellVerificationPayload {
				schema_version: CANDIDATE_CELL_VERIFICATION_PAYLOAD_TYPE.to_owned(),
				unit: results.unit.clone(),
				cell: evaluator.cell.clone(),
				result_package_sha256: results.cells[index].digest().expect("result envelope"),
				evaluator_package_sha256: evaluator_bundle.cells[index]
					.digest()
					.expect("evaluator envelope"),
				replayed_evaluator_sha256: evaluator
					.evaluator
					.as_ref()
					.map(|value| value.digest().expect("candidate evaluator digest")),
				verified: true,
				disposition: CandidateVerificationDisposition::CandidateEvaluatorReplayed,
			})
			.collect();
		let replays = CandidateVerifierReplayBundle::sign(
			authorization,
			unit,
			&results,
			&evaluator_bundle,
			replay_payloads,
			verifier,
		)
		.expect("replay bundle");
		let attempts = full_lifecycle_completed_attempts(authorization, unit, &results, &replays);
		let attempt_bundle = CandidateAttemptLogBundle::sign(
			authorization,
			unit,
			&results,
			&evaluator_bundle,
			&replays,
			attempts.clone(),
			runner,
		)
		.expect("attempt bundle");

		for (class, document) in [
			("result_package_bundle", serde_json::to_value(&results).expect("results value")),
			(
				"evaluator_result_bundle",
				serde_json::to_value(&evaluator_bundle).expect("evaluators value"),
			),
			("verifier_replay_bundle", serde_json::to_value(&replays).expect("replays value")),
			("attempt_log_bundle", serde_json::to_value(&attempt_bundle).expect("attempts value")),
		] {
			reservations
				.fill(&format!("{}/{class}", unit.unit_id), &canonical_document(&document))
				.expect("fill Rust artifact");
		}
	}
}

fn full_lifecycle_completed_attempts(
	authorization: &CandidateExecutionAuthorization,
	unit: &CandidateExecutionUnit,
	results: &CandidateResultPackageBundle,
	replays: &CandidateVerifierReplayBundle,
) -> Vec<Vec<CandidateAttempt>> {
	results
		.verify(authorization, unit)
		.expect("run payload")
		.run
		.results
		.iter()
		.enumerate()
		.map(|(index, result)| {
			vec![CandidateAttempt {
				attempt_number: 1,
				scheduled_delay_seconds: 0,
				scheduled_for: unit.slot_id.clone(),
				started_at: unit.slot_id.clone(),
				model_started: true,
				disposition: CandidateAttemptDisposition::Completed,
				infrastructure_classification: None,
				result_digest: Some(result.content_hash().expect("result digest")),
				result_package_digest: Some(
					results.cells[index].digest().expect("result package digest"),
				),
				verifier_attestation_digest: Some(
					replays.cells[index].digest().expect("verifier digest"),
				),
			}]
		})
		.collect()
}

fn full_calibration_run(unit: &CandidateExecutionUnit) -> CalibrationRunRecord {
	let models = unit
		.models
		.iter()
		.map(|planned| {
			MODEL_MATRIX
				.into_iter()
				.find(|model| model_execution_id(*model) == planned.execution_model_id)
				.expect("planned model")
		})
		.collect::<Vec<_>>();
	let results = models
		.iter()
		.flat_map(|model| unit.ordered_task_ids.iter().map(move |task| (*model, task)))
		.map(|(model, task_id)| TaskResult {
			schema_version: RESULT_SCHEMA_VERSION.to_owned(),
			result_id: String::new(),
			run_id: format!("run-{}", unit.unit_id),
			task_id: task_id.clone(),
			task_version: "1.0.2".to_owned(),
			task_hash: test_digest(task_id),
			model,
			status: ResultStatus::Completed,
			evaluation: EvaluationOutcome::Correct,
			task_score: Some(1.0),
			response: Some(FULL_FIXTURE_PRIVATE_RESPONSE.to_owned()),
			response_sha256: Some(test_digest(FULL_FIXTURE_PRIVATE_RESPONSE)),
			evaluator_result_sha256: None,
			evaluator_stdout_sha256: Some(DIGEST_B.to_owned()),
			artifacts: Vec::new(),
			failure: None,
			latency: Latency { wall_ms: 1 },
			tool_usage: ToolUsage::default(),
			evaluator_checks: Vec::new(),
			workspace_manifest: None,
			provenance: ResultProvenance {
				node_id: "node_fixture".to_owned(),
				runner_version: "test".to_owned(),
				codex_version: "test".to_owned(),
				observed_at: unit.slot_id.clone(),
				synthetic: false,
				local_trust: TrustTier::Untrusted,
			},
		})
		.collect();

	CalibrationRunRecord {
		schema_version: CALIBRATION_RUN_SCHEMA_VERSION.to_owned(),
		official_eligible: false,
		classification: "local_calibration_non_official".to_owned(),
		run_id: format!("run-{}", unit.unit_id),
		schedule_slot: ScheduleSlot {
			local_date: "2026-08-02".to_owned(),
			occurrence: ScheduleOccurrence::Day,
			local_time: "00:00".to_owned(),
			timezone: "UTC".to_owned(),
		},
		task_set_hash: test_digest(&unit.unit_id),
		scoring_version: AIQ_SCORING_VERSION.to_owned(),
		execution_concurrency: Some(1),
		models,
		task_ids: unit.ordered_task_ids.clone(),
		started_unix_ms: 1,
		finished_unix_ms: 2,
		capability_validation: serde_json::from_value(serde_json::json!({
			"schema_version": "aiq.capability-validation.v2",
			"node_id": "node_fixture",
			"manifest_issues": [],
			"cli_probe": { "status": "available", "version": "test", "failure": null },
			"authentication_probe": {"status": "available", "mode": "chatgpt_subscription", "failure": null},
			"models": []
		}))
		.expect("capability report"),
		provenance: RunProvenanceCommitment {
			schema_version: "aiq.run-provenance.v2".to_owned(),
			run_class: RunClass::Calibration,
			corpus_release_id: "candidate".to_owned(),
			corpus_commitment_sha256: unit.corpus_commitment_sha256.clone(),
			catalog_digest: DIGEST_A.to_owned(),
			task_set_digest: DIGEST_A.to_owned(),
			evaluator_digest: DIGEST_A.to_owned(),
			runtime_digest: DIGEST_A.to_owned(),
			preflight_digest: DIGEST_A.to_owned(),
			harness_digest: DIGEST_A.to_owned(),
			prompt_digest: DIGEST_A.to_owned(),
			tool_policy_digest: DIGEST_A.to_owned(),
			network_policy_digest: DIGEST_A.to_owned(),
			environment_digest: DIGEST_A.to_owned(),
			source_manifest_digest: DIGEST_A.to_owned(),
			runner_executable_digest: DIGEST_A.to_owned(),
			codex_executable_digest: DIGEST_A.to_owned(),
			permission_evidence_digest: DIGEST_A.to_owned(),
		},
		evaluator_results_artifact: ArtifactReference {
			kind: "evaluator_results".to_owned(),
			content_hash: DIGEST_A.to_owned(),
			uri: "artifact://candidate/evaluators".to_owned(),
			bytes: 1,
		},
		results,
	}
}

fn candidate_catalog_tasks() -> Vec<Value> {
	serde_json::from_str::<Value>(include_str!(
		"../../../benchmarks/candidates/aiq-core-1.0.2/catalog.json"
	))
	.expect("candidate catalog")["tasks"]
		.as_array()
		.expect("catalog tasks")
		.clone()
}

fn model_execution_id(model: ModelConfig) -> String {
	let value = serde_json::to_value(model).expect("model value");

	format!(
		"gpt-5.6-{}-{}",
		value["family"].as_str().expect("family"),
		value["reasoning_effort"].as_str().expect("effort")
	)
}

fn trust_policy(key: &SigningKey) -> Value {
	let promotion_key = SigningKey::from_bytes(&[25; 32]);
	let trusted_signer = |key_id: &str, key: &SigningKey| {
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
		"authority_signers": [trusted_signer("candidate-authority-test", key)],
		"promotion_signers": [trusted_signer("candidate-promotion-test", &promotion_key)],
	})
}

fn sign_value_without_signature<T>(value: &T, key: &SigningKey) -> String
where
	T: Serialize,
{
	let mut value = serde_json::to_value(value).expect("signing value");

	value.as_object_mut().expect("object").remove("signature");

	base64(&key.sign(&protocol::canonical_json(&value).expect("signing bytes")).to_bytes())
}

fn base64(bytes: &[u8]) -> String {
	const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

	let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);

	for chunk in bytes.chunks(3) {
		let value = (u32::from(chunk[0]) << 16)
			| (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
			| u32::from(*chunk.get(2).unwrap_or(&0));

		output.push(TABLE[((value >> 18) & 63) as usize] as char);
		output.push(TABLE[((value >> 12) & 63) as usize] as char);
		output.push(if chunk.len() > 1 {
			TABLE[((value >> 6) & 63) as usize] as char
		} else {
			'='
		});
		output.push(if chunk.len() > 2 { TABLE[(value & 63) as usize] as char } else { '=' });
	}

	output
}

fn write_canonical(path: &Path, value: &impl Serialize) -> String {
	let bytes = canonical_document(value);

	fs::write(path, &bytes).expect("write canonical fixture");

	protocol::canonical_hash(value).expect("canonical fixture digest")
}

fn assert_canonical_file(path: &Path) {
	let bytes = fs::read(path).expect("canonical file");
	let value: Value = serde_json::from_slice(&bytes).expect("canonical JSON");
	let mut expected = protocol::canonical_json(&value).expect("canonical bytes");

	expected.push(b'\n');

	assert_eq!(bytes, expected, "{} is not canonical", path.display());
}

fn canonical_document(value: &impl Serialize) -> Vec<u8> {
	let mut bytes = protocol::canonical_json(value).expect("canonical fixture");

	bytes.push(b'\n');

	bytes
}

fn test_digest(label: &str) -> String {
	format!("sha256:{}", hex::encode(Sha256::digest(label.as_bytes())))
}

fn file_digest(path: &Path) -> String {
	format!("sha256:{}", hex::encode(Sha256::digest(fs::read(path).expect("read executable"))))
}

fn signing_key_pem(key: &SigningKey) -> String {
	let mut der = hex::decode("302e020100300506032b657004220420").expect("PKCS8 prefix");

	der.extend_from_slice(key.as_bytes());

	const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

	let mut encoded = String::new();

	for chunk in der.chunks(3) {
		let value = (u32::from(chunk[0]) << 16)
			| (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
			| u32::from(*chunk.get(2).unwrap_or(&0));

		encoded.push(ALPHABET[((value >> 18) & 63) as usize] as char);
		encoded.push(ALPHABET[((value >> 12) & 63) as usize] as char);
		encoded.push(if chunk.len() > 1 {
			ALPHABET[((value >> 6) & 63) as usize] as char
		} else {
			'='
		});
		encoded.push(if chunk.len() > 2 { ALPHABET[(value & 63) as usize] as char } else { '=' });
	}

	format!("-----BEGIN PRIVATE KEY-----\n{encoded}\n-----END PRIVATE KEY-----\n")
}

fn find_node_runtime() -> PathBuf {
	let path = env::var_os("PATH").expect("PATH");

	env::split_paths(&path)
		.map(|directory| directory.join("node"))
		.find(|candidate| candidate.is_file())
		.and_then(|candidate| fs::canonicalize(candidate).ok())
		.expect("absolute Node runtime")
}

fn signed_bundles(
	fixture: &Fixture,
) -> (CandidateResultPackageBundle, CandidateEvaluatorResultBundle, CandidateVerifierReplayBundle) {
	let results = CandidateResultPackageBundle::sign(
		&fixture.authorization,
		&fixture.unit,
		fixture.run.clone(),
		&fixture.runner,
	)
	.expect("sign result bundle");
	let evaluators = CandidateEvaluatorResultBundle::sign(
		&fixture.authorization,
		&fixture.unit,
		&results,
		&fixture.evaluators,
		&fixture.runner,
	)
	.expect("sign evaluator bundle");
	let evaluator_payloads = evaluators
		.verify(&fixture.authorization, &fixture.unit, &results)
		.expect("verify evaluator bundle");
	let replay_payloads = evaluator_payloads
		.into_iter()
		.enumerate()
		.map(|(index, evaluator)| CandidateCellVerificationPayload {
			schema_version: CANDIDATE_CELL_VERIFICATION_PAYLOAD_TYPE.to_owned(),
			unit: results.unit.clone(),
			cell: evaluator.cell,
			result_package_sha256: results.cells[index].digest().expect("result digest"),
			evaluator_package_sha256: evaluators.cells[index].digest().expect("evaluator digest"),
			replayed_evaluator_sha256: evaluator
				.evaluator
				.as_ref()
				.map(|value| value.digest().expect("candidate evaluator digest")),
			verified: evaluator.evaluator.is_some(),
			disposition: if evaluator.evaluator.is_some() {
				CandidateVerificationDisposition::CandidateEvaluatorReplayed
			} else {
				CandidateVerificationDisposition::CandidateResultNoncompletedNotVerified
			},
		})
		.collect();
	let replays = CandidateVerifierReplayBundle::sign(
		&fixture.authorization,
		&fixture.unit,
		&results,
		&evaluators,
		replay_payloads,
		&fixture.verifier,
	)
	.expect("sign replay bundle");

	(results, evaluators, replays)
}

fn completed_attempts(
	fixture: &Fixture,
	results: &CandidateResultPackageBundle,
	replays: &CandidateVerifierReplayBundle,
) -> Vec<Vec<CandidateAttempt>> {
	fixture
		.run
		.results
		.iter()
		.enumerate()
		.map(|(index, result)| {
			let completed = CandidateAttempt {
				attempt_number: if index == 0 { 3 } else { 1 },
				scheduled_delay_seconds: if index == 0 { 90 } else { 0 },
				scheduled_for: if index == 0 {
					"2026-08-03T12:01:30.000Z"
				} else {
					"2026-08-03T12:00:00.000Z"
				}
				.to_owned(),
				started_at: if index == 0 {
					"2026-08-03T12:01:45.000Z"
				} else {
					"2026-08-03T12:00:05.123Z"
				}
				.to_owned(),
				model_started: true,
				disposition: CandidateAttemptDisposition::Completed,
				infrastructure_classification: None,
				result_digest: Some(result.content_hash().expect("result content digest")),
				result_package_digest: Some(
					results.cells[index].digest().expect("result package digest"),
				),
				verifier_attestation_digest: Some(
					replays.cells[index].digest().expect("verifier digest"),
				),
			};

			if index == 0 {
				vec![
					CandidateAttempt {
						attempt_number: 1,
						scheduled_delay_seconds: 0,
						scheduled_for: "2026-08-03T12:00:00.000Z".to_owned(),
						started_at: "2026-08-03T12:00:05.000Z".to_owned(),
						model_started: false,
						disposition: CandidateAttemptDisposition::InfrastructureRetryable,
						infrastructure_classification: Some(
							CandidateInfrastructureClassification::PreModelAdmission,
						),
						result_digest: None,
						result_package_digest: None,
						verifier_attestation_digest: None,
					},
					CandidateAttempt {
						attempt_number: 2,
						scheduled_delay_seconds: 30,
						scheduled_for: "2026-08-03T12:00:30.000Z".to_owned(),
						started_at: "2026-08-03T12:00:45.000Z".to_owned(),
						model_started: false,
						disposition: CandidateAttemptDisposition::InfrastructureRetryable,
						infrastructure_classification: Some(
							CandidateInfrastructureClassification::PreModelAdmission,
						),
						result_digest: None,
						result_package_digest: None,
						verifier_attestation_digest: None,
					},
					completed,
				]
			} else {
				vec![completed]
			}
		})
		.collect()
}

fn mixed_attempts(
	fixture: &Fixture,
	results: &CandidateResultPackageBundle,
	replays: &CandidateVerifierReplayBundle,
) -> Vec<Vec<CandidateAttempt>> {
	let mut attempts = completed_attempts(fixture, results, replays);

	for (index, disposition) in [
		CandidateAttemptDisposition::Unsupported,
		CandidateAttemptDisposition::Unevaluated,
		CandidateAttemptDisposition::InfrastructureTerminal,
	]
	.into_iter()
	.enumerate()
	{
		let terminal = CandidateAttempt {
			attempt_number: 1,
			scheduled_delay_seconds: 0,
			scheduled_for: "2026-08-03T12:00:00.000Z".to_owned(),
			started_at: "2026-08-03T12:00:05.000Z".to_owned(),
			model_started: false,
			disposition,
			infrastructure_classification: if index == 2 {
				Some(CandidateInfrastructureClassification::PreModelAdmission)
			} else {
				None
			},
			result_digest: None,
			result_package_digest: None,
			verifier_attestation_digest: None,
		};

		attempts[index] = if disposition == CandidateAttemptDisposition::InfrastructureTerminal {
			vec![
				CandidateAttempt {
					disposition: CandidateAttemptDisposition::InfrastructureRetryable,
					..terminal.clone()
				},
				CandidateAttempt {
					attempt_number: 2,
					scheduled_delay_seconds: 30,
					scheduled_for: "2026-08-03T12:00:30.000Z".to_owned(),
					started_at: "2026-08-03T12:00:45.000Z".to_owned(),
					disposition: CandidateAttemptDisposition::InfrastructureRetryable,
					..terminal.clone()
				},
				CandidateAttempt {
					attempt_number: 3,
					scheduled_delay_seconds: 90,
					scheduled_for: "2026-08-03T12:01:30.000Z".to_owned(),
					started_at: "2026-08-03T12:01:45.000Z".to_owned(),
					..terminal
				},
			]
		} else {
			vec![terminal]
		};
	}

	attempts
}

fn fixture() -> Fixture {
	let runner = CandidateSigningIdentity::from_secret([11; 32]);
	let verifier = CandidateSigningIdentity::from_secret([12; 32]);
	let models = vec![
		CandidateResolvedModel {
			canonical_model_id: "sol-medium".to_owned(),
			execution_model_id: "gpt-5.6-sol-medium".to_owned(),
			model_name: "gpt-5.6-sol".to_owned(),
			reasoning_effort: "medium".to_owned(),
		},
		CandidateResolvedModel {
			canonical_model_id: "terra-high".to_owned(),
			execution_model_id: "gpt-5.6-terra-high".to_owned(),
			model_name: "gpt-5.6-terra".to_owned(),
			reasoning_effort: "high".to_owned(),
		},
	];
	let unit = CandidateExecutionUnit {
		unit_id: "repeat-01-core".to_owned(),
		repeat_id: "repeat-01".to_owned(),
		slot_id: "2026-08-03T12:00:00.000Z".to_owned(),
		kind: CandidateExecutionUnitKind::Core,
		contrast_id: None,
		contrast_arm: None,
		variant_sha256: None,
		ordered_task_ids: vec!["task-a".to_owned(), "task-b".to_owned()],
		models,
		corpus_commitment_path: PathBuf::from("/candidate/core-corpus.json"),
		corpus_commitment_sha256: DIGEST_A.to_owned(),
		checkpoint_path: PathBuf::from("/candidate/checkpoint.json"),
		preflight_path: PathBuf::from("/candidate/preflight.json"),
		attempt_journal_path: PathBuf::from("/candidate/attempts.json"),
		outputs: CandidateUnitOutputs {
			result_package_bundle: PathBuf::from("/candidate/results.json"),
			evaluator_result_bundle: PathBuf::from("/candidate/evaluators.json"),
			verifier_replay_bundle: PathBuf::from("/candidate/replays.json"),
			attempt_log_bundle: PathBuf::from("/candidate/attempt-log.json"),
		},
	};
	let plan = minimal_plan(&unit, &runner, &verifier);
	let private_plan_sha256 = protocol::canonical_hash(&plan).expect("plan digest");
	let authorization = CandidateExecutionAuthorization {
		schema_version: CANDIDATE_EXECUTION_AUTHORIZATION_SCHEMA.to_owned(),
		signature_domain: CANDIDATE_EXECUTION_AUTHORIZATION_SCHEMA.to_owned(),
		signature_encoding: "rfc8785_sorted_key_json".to_owned(),
		purpose: "private_candidate_execution_authorization".to_owned(),
		release_identity: RELEASE_IDENTITY.to_owned(),
		execution_plan_digest: plan.execution_plan_digest.clone(),
		signed_admission_sha256: plan.signed_admission_sha256.clone(),
		private_plan_sha256,
		plan,
		signer: CandidateAuthorizationSigner {
			node_id: format!("node_{}", "c".repeat(64)),
			public_key: "d".repeat(64),
			algorithm: "ed25519".to_owned(),
		},
		signature: "e".repeat(128),
	};
	let evaluations = vec![evaluation(&[]), evaluation(&[0]), evaluation(&[5]), evaluation(&[15])];
	let mut run = calibration_run(&unit);

	bind_run_provenance(&mut run, &authorization, &unit);

	for (result, evaluation) in run.results.iter_mut().zip(&evaluations) {
		result.evaluator_result_sha256 =
			Some(protocol::canonical_hash(evaluation).expect("evaluator digest"));
		result.result_id = format!(
			"result_{}",
			result.content_hash().expect("result content hash").trim_start_matches("sha256:")
		);
	}

	Fixture {
		authorization,
		unit,
		run,
		evaluators: EvaluatorResultsBundle {
			schema_version: EVALUATOR_RESULTS_SCHEMA_VERSION.to_owned(),
			results: evaluations.into_iter().map(Some).collect(),
		},
		runner,
		verifier,
	}
}

fn incomplete_fixture() -> Fixture {
	let mut fixture = fixture();

	fixture.run.results[0].status = ResultStatus::Unsupported;
	fixture.run.results[0].evaluation = EvaluationOutcome::NotEvaluated;
	fixture.run.results[0].task_score = None;
	fixture.run.results[1].status = ResultStatus::Unevaluated;
	fixture.run.results[1].evaluation = EvaluationOutcome::NotEvaluated;
	fixture.run.results[1].task_score = None;
	fixture.run.results[2].status = ResultStatus::Failed;
	fixture.run.results[2].evaluation = EvaluationOutcome::NotEvaluated;
	fixture.run.results[2].task_score = None;
	fixture.run.results[2].failure = Some(ResultFailure {
		kind: FailureKind::CapabilityUnavailable,
		message: "pre-model admission unavailable".to_owned(),
		exit_code: None,
		retryable: false,
	});

	for index in 0..3 {
		fixture.run.results[index].evaluator_result_sha256 = None;
		fixture.evaluators.results[index] = None;
		fixture.run.results[index].result_id = format!(
			"result_{}",
			fixture.run.results[index]
				.content_hash()
				.expect("incomplete result content hash")
				.trim_start_matches("sha256:")
		);
	}

	fixture
}

fn minimal_plan(
	unit: &CandidateExecutionUnit,
	runner: &CandidateSigningIdentity,
	verifier: &CandidateSigningIdentity,
) -> CandidateExecutionPlan {
	let digest = |character: char| format!("sha256:{}", character.to_string().repeat(64));
	let paths = [
		"core-tasks",
		"contrast-tasks",
		"source",
		"core-workspace",
		"contrast-workspace",
		"execution",
		"evaluator",
		"evaluator-runtime",
		"toolchain",
		"capabilities",
		"schedule",
		"codex",
		"codex-home",
		"artifacts",
		"work",
		"verifier-replay",
	]
	.map(|name| PathBuf::from(format!("/candidate/{name}")));

	CandidateExecutionPlan {
		schema_version: CANDIDATE_EXECUTION_PLAN_SCHEMA.to_owned(),
		purpose: "private_candidate_release_gate_execution".to_owned(),
		release_identity: RELEASE_IDENTITY.to_owned(),
		catalog_release_identity_digest: digest('1'),
		task_metadata_identity_digest: digest('2'),
		execution_plan_digest: digest('3'),
		model_id_mapping_digest: digest('4'),
		signed_admission_path: PathBuf::from("/candidate/admission.json"),
		signed_admission_sha256: digest('5'),
		signed_admission_key_id: "candidate-key".to_owned(),
		release_trust_policy_path: PathBuf::from("/candidate/release-trust-policy.json"),
		release_trust_policy_sha256: digest('0'),
		corpus_manifest_path: PathBuf::from("/candidate/corpus.json"),
		corpus_manifest_sha256: digest('6'),
		core_corpus_commitment_path: unit.corpus_commitment_path.clone(),
		core_corpus_commitment_sha256: unit.corpus_commitment_sha256.clone(),
		contrast_corpus_commitment_path: PathBuf::from("/candidate/contrast-corpus.json"),
		contrast_corpus_commitment_sha256: DIGEST_B.to_owned(),
		authorization_path: PathBuf::from("/candidate/authorization.json"),
		runtime: CandidateRuntimeBindings {
			runner_executable_sha256: digest('7'),
			verifier_executable_sha256: digest('f'),
			evaluator_runtime_sha256: digest('8'),
			core_harness_sha256: digest('9'),
			core_tool_policy_sha256: digest('a'),
			core_network_policy_sha256: digest('b'),
			contrast_harness_sha256: digest('c'),
			contrast_tool_policy_sha256: digest('d'),
			contrast_network_policy_sha256: digest('e'),
		},
		controlled_inputs: CandidateControlledInputs {
			core_tasks_root: paths[0].clone(),
			contrast_tasks_root: paths[1].clone(),
			source_root: paths[2].clone(),
			core_workspace_root: paths[3].clone(),
			contrast_workspace_root: paths[4].clone(),
			execution_root: paths[5].clone(),
			evaluator_root: paths[6].clone(),
			evaluator_runtime: paths[7].clone(),
			codex_toolchain_root: paths[8].clone(),
			capabilities: paths[9].clone(),
			schedule: paths[10].clone(),
			codex_binary: paths[11].clone(),
			codex_home: paths[12].clone(),
			codex_egress_proxy: CANDIDATE_CODEX_EGRESS_PROXY_ENDPOINT.to_owned(),
			artifact_root: paths[13].clone(),
			work_root: paths[14].clone(),
			verifier_replay_root: paths[15].clone(),
			jobs: 1,
			runner_signer_node_id: runner.node().node_id.clone(),
			verifier_signer_node_id: verifier.node().node_id.clone(),
		},
		output_root: PathBuf::from("/candidate/output"),
		contrast_task_bindings: Vec::new(),
		execution_units: vec![unit.clone()],
		aggregate_outputs: CandidateAggregateOutputs {
			source_observations: PathBuf::from("/candidate/source-observations.json"),
			release_gate_evidence: PathBuf::from("/candidate/release-evidence.json"),
		},
		classification: CandidateClassification::default(),
	}
}

fn calibration_run(unit: &CandidateExecutionUnit) -> CalibrationRunRecord {
	let models = vec![
		ModelConfig { family: ModelFamily::Sol, reasoning_effort: ReasoningEffort::Medium },
		ModelConfig { family: ModelFamily::Terra, reasoning_effort: ReasoningEffort::High },
	];
	let results = models
		.iter()
		.flat_map(|model| unit.ordered_task_ids.iter().map(move |task_id| (*model, task_id)))
		.map(|(model, task_id)| TaskResult {
			schema_version: RESULT_SCHEMA_VERSION.to_owned(),
			result_id: String::new(),
			run_id: "candidate-run".to_owned(),
			task_id: task_id.clone(),
			task_version: "1.0.2".to_owned(),
			task_hash: DIGEST_A.to_owned(),
			model,
			status: ResultStatus::Completed,
			evaluation: EvaluationOutcome::Correct,
			task_score: Some(1.0),
			response: Some("candidate response".to_owned()),
			response_sha256: Some(DIGEST_A.to_owned()),
			evaluator_result_sha256: None,
			evaluator_stdout_sha256: Some(DIGEST_B.to_owned()),
			artifacts: Vec::new(),
			failure: None,
			latency: Latency { wall_ms: 1 },
			tool_usage: ToolUsage::default(),
			evaluator_checks: Vec::new(),
			workspace_manifest: None,
			provenance: ResultProvenance {
				node_id: "node_fixture".to_owned(),
				runner_version: "test".to_owned(),
				codex_version: "test".to_owned(),
				observed_at: "2026-08-03T12:00:00Z".to_owned(),
				synthetic: false,
				local_trust: TrustTier::Untrusted,
			},
		})
		.collect();

	CalibrationRunRecord {
		schema_version: CALIBRATION_RUN_SCHEMA_VERSION.to_owned(),
		official_eligible: false,
		classification: "local_calibration_non_official".to_owned(),
		run_id: "candidate-run".to_owned(),
		schedule_slot: ScheduleSlot {
			local_date: "2026-08-03".to_owned(),
			occurrence: ScheduleOccurrence::Day,
			local_time: "12:00".to_owned(),
			timezone: "UTC".to_owned(),
		},
		task_set_hash: DIGEST_A.to_owned(),
		scoring_version: AIQ_SCORING_VERSION.to_owned(),
		execution_concurrency: Some(1),
		models,
		task_ids: unit.ordered_task_ids.clone(),
		started_unix_ms: 1,
		finished_unix_ms: 2,
		capability_validation: serde_json::from_value(serde_json::json!({
			"schema_version": "aiq.capability-validation.v2",
			"node_id": "node_fixture",
			"manifest_issues": [],
			"cli_probe": { "status": "available", "version": "test", "failure": null },
			"authentication_probe": {
				"status": "available", "mode": "chatgpt_subscription", "failure": null
			},
			"models": []
		}))
		.expect("capability report"),
		provenance: RunProvenanceCommitment {
			schema_version: "aiq.run-provenance.v2".to_owned(),
			run_class: RunClass::Calibration,
			corpus_release_id: "candidate".to_owned(),
			corpus_commitment_sha256: unit.corpus_commitment_sha256.clone(),
			catalog_digest: DIGEST_A.to_owned(),
			task_set_digest: DIGEST_A.to_owned(),
			evaluator_digest: DIGEST_A.to_owned(),
			runtime_digest: DIGEST_A.to_owned(),
			preflight_digest: DIGEST_A.to_owned(),
			harness_digest: DIGEST_A.to_owned(),
			prompt_digest: DIGEST_A.to_owned(),
			tool_policy_digest: DIGEST_A.to_owned(),
			network_policy_digest: DIGEST_A.to_owned(),
			environment_digest: DIGEST_A.to_owned(),
			source_manifest_digest: DIGEST_A.to_owned(),
			runner_executable_digest: DIGEST_A.to_owned(),
			codex_executable_digest: DIGEST_A.to_owned(),
			permission_evidence_digest: DIGEST_A.to_owned(),
		},
		evaluator_results_artifact: ArtifactReference {
			kind: "evaluator_results".to_owned(),
			content_hash: DIGEST_A.to_owned(),
			uri: "artifact://candidate/evaluators".to_owned(),
			bytes: 1,
		},
		results,
	}
}

fn bind_run_provenance(
	run: &mut CalibrationRunRecord,
	authorization: &CandidateExecutionAuthorization,
	unit: &CandidateExecutionUnit,
) {
	let runtime = &authorization.plan.runtime;
	let (catalog, harness, tool, network) = match unit.kind {
		CandidateExecutionUnitKind::Core => (
			CANDIDATE_TASK_IDENTITY_SHA256,
			&runtime.core_harness_sha256,
			&runtime.core_tool_policy_sha256,
			&runtime.core_network_policy_sha256,
		),
		CandidateExecutionUnitKind::Contrast => (
			CANDIDATE_CONTRAST_CATALOG_IDENTITY_SHA256,
			&runtime.contrast_harness_sha256,
			&runtime.contrast_tool_policy_sha256,
			&runtime.contrast_network_policy_sha256,
		),
	};

	run.provenance.run_class = RunClass::Calibration;
	run.provenance.corpus_commitment_sha256 = unit.corpus_commitment_sha256.clone();
	run.provenance.catalog_digest = catalog.to_owned();
	run.provenance.task_set_digest = run.task_set_hash.clone();
	run.provenance.preflight_digest =
		protocol::canonical_hash(&run.capability_validation).expect("preflight digest");
	run.provenance.runner_executable_digest = runtime.runner_executable_sha256.clone();
	run.provenance.harness_digest = harness.clone();
	run.provenance.tool_policy_digest = tool.clone();
	run.provenance.network_policy_digest = network.clone();
}

fn evaluation(failed: &[usize]) -> EvaluationResult {
	let layout: [(&str, u32); 4] = [
		("component_01", 750),
		("component_02", 625),
		("component_03", 625),
		("component_04", 500),
	];
	let mut checks = Vec::new();
	let mut passed_weight = 0_u64;

	for (component_index, (component_id, weight)) in layout.into_iter().enumerate() {
		for assertion_index in 1..=4 {
			let index = component_index * 4 + assertion_index - 1;
			let passed = !failed.contains(&index);

			passed_weight += if passed { u64::from(weight) } else { 0 };

			checks.push(EvaluatorCheck {
				check_id: format!("{component_id}_assertion_{assertion_index:02}"),
				weight,
				passed,
				failure_class: if passed {
					EvaluatorCheckFailureClass::None
				} else {
					EvaluatorCheckFailureClass::Value
				},
				evidence_digest: format!("sha256:{:064x}", index + 1),
			});
		}
	}

	let score = passed_weight as f64 / 10_000.0;

	EvaluationResult {
		schema_version: EVALUATOR_RESULT_SCHEMA_VERSION.to_owned(),
		outcome: if score == 1.0 { EvaluatorOutcome::Correct } else { EvaluatorOutcome::Partial },
		score,
		checks,
		raw_stdout_sha256: Some(DIGEST_B.to_owned()),
	}
}
