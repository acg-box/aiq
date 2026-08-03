//! Independent candidate reconstruction and deterministic evaluator replay.

#[cfg(all(test, unix))]
mod tests {
	#[cfg(unix)]
	use std::os::unix::fs::PermissionsExt as _;
	use std::{
		collections::{BTreeMap, BTreeSet},
		env, fs,
		path::{Path, PathBuf},
		process,
		sync::atomic::{AtomicU64, Ordering},
	};

	use sha2::{Digest, Sha256};

	use crate::{ArtifactResolverClient, ReasonCode, WorkerError, replay};
	#[cfg(unix)]
	use aiq_runner::task::{
		EVALUATOR_PROTOCOL_VERSION, EvaluatorRuntime, EvaluatorRuntimeKind,
		ExternalEvaluatorBinding,
	};
	use aiq_runner::{
		adapter::ArtifactReference,
		model::MODEL_MATRIX,
		protocol::{self, ResultProvenance, TrustTier},
		runner::{
			self, EVALUATOR_RESULTS_SCHEMA_VERSION, EvaluationOutcome, EvaluatorResultsBundle,
			FailureKind, Latency, MAX_RESULT_PREVIEW_BYTES, RESULT_SCHEMA_VERSION,
			RUN_SCHEMA_VERSION, ResultFailure, ResultStatus, RunRecord, TaskResult,
			WorkspaceManifest, WorkspaceManifestEntry, WorkspaceSnapshot, WorkspaceSnapshotEntry,
		},
		schedule::{ScheduleConfig, ScheduleOccurrence},
		scoring::AIQ_SCORING_VERSION,
		task::{
			EVALUATOR_RESULT_SCHEMA_VERSION, EvaluationResult, EvaluatorCheck,
			EvaluatorCheckFailureClass, EvaluatorOutcome, TaskDefinition,
		},
	};

	static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(1);

	#[derive(Clone)]
	struct MemoryResolver {
		objects: BTreeMap<(String, String), Vec<u8>>,
	}

	struct FailingLeaseResolver {
		inner: MemoryResolver,
	}

	impl ArtifactResolverClient for MemoryResolver {
		fn resolve(
			&self,
			digest: &str,
			kind: &str,
			expected_bytes: u64,
		) -> Result<Vec<u8>, WorkerError> {
			let bytes =
				self.objects.get(&(digest.to_owned(), kind.to_owned())).cloned().ok_or_else(
					|| {
						WorkerError::terminal(
							ReasonCode::ArtifactEvidenceUnavailable,
							"fixture artifact is unavailable",
						)
					},
				)?;

			if u64::try_from(bytes.len()).ok() != Some(expected_bytes) {
				return Err(WorkerError::terminal(
					ReasonCode::ArtifactEvidenceMismatch,
					"fixture artifact size differs",
				));
			}

			Ok(bytes)
		}
	}

	impl ArtifactResolverClient for FailingLeaseResolver {
		fn maintain_lease(&self) -> Result<(), WorkerError> {
			Err(WorkerError::transient("fixture lease renewal failed"))
		}

		fn resolve(
			&self,
			digest: &str,
			kind: &str,
			expected_bytes: u64,
		) -> Result<Vec<u8>, WorkerError> {
			self.inner.resolve(digest, kind, expected_bytes)
		}
	}

	struct Fixture {
		root: PathBuf,
		evaluator_root: PathBuf,
		evaluator_runtime: EvaluatorRuntime,
		replay_root: PathBuf,
		tasks: Vec<TaskDefinition>,
		run: RunRecord,
		resolver: MemoryResolver,
	}

	impl Fixture {
		fn completed(response: &str) -> Self {
			let root = fixture_root();
			let evaluator_root = root.join("evaluators");
			let replay_root = root.join("replay");

			fs::create_dir(&evaluator_root).expect("evaluator root");
			fs::create_dir(&replay_root).expect("replay root");

			let evaluator_runtime = fixture_evaluator_runtime(&root);
			let mut task_values = runner::synthetic_demo_tasks();
			let task = task_values.remove(0);
			let evaluation = task
				.evaluator
				.as_ref()
				.expect("evaluator")
				.evaluate_checked(response, None)
				.expect("evaluation");
			let (manifest, snapshot, mut objects) = candidate_evidence(Vec::new());
			let stdout = serde_json::json!({
				"type": "item.completed",
				"item": {
					"id": "message-1",
					"type": "agent_message",
					"text": response
				}
			})
			.to_string();
			let stdout_reference = artifact("stdout.jsonl", stdout.as_bytes());

			objects.insert(
				(
					stdout_reference.content_hash.trim_start_matches("sha256:").to_owned(),
					stdout_reference.kind.clone(),
				),
				stdout.as_bytes().to_vec(),
			);

			let tool_usage = runner::parse_codex_tool_usage(&stdout);
			let model = MODEL_MATRIX[0];
			let result = TaskResult {
				schema_version: RESULT_SCHEMA_VERSION.to_owned(),
				result_id: format!("result_{}", "1".repeat(64)),
				run_id: format!("run_{}", "2".repeat(64)),
				task_id: task.task_id.clone(),
				task_version: task.task_version.clone(),
				task_hash: task.content_hash().expect("task hash"),
				model,
				status: ResultStatus::Completed,
				evaluation: match evaluation.outcome {
					EvaluatorOutcome::Correct => EvaluationOutcome::Correct,
					EvaluatorOutcome::Partial => EvaluationOutcome::Partial,
					EvaluatorOutcome::Incorrect => EvaluationOutcome::Incorrect,
				},
				task_score: Some(evaluation.score),
				response: Some(response.to_owned()),
				response_sha256: Some(format!(
					"sha256:{}",
					hex::encode(Sha256::digest(response.as_bytes()))
				)),
				evaluator_result_sha256: Some(
					protocol::canonical_hash(&evaluation).expect("evaluator-result digest"),
				),
				evaluator_stdout_sha256: None,
				artifacts: vec![snapshot, stdout_reference],
				failure: None,
				latency: Latency { wall_ms: 1 },
				tool_usage,
				evaluator_checks: evaluation.checks.clone(),
				workspace_manifest: Some(manifest),
				provenance: ResultProvenance {
					node_id: format!("node_{}", "3".repeat(64)),
					runner_version: "0.1.0".to_owned(),
					codex_version: "fixture".to_owned(),
					observed_at: "2026-07-25T00:00:00Z".to_owned(),
					synthetic: false,
					local_trust: TrustTier::Untrusted,
				},
			};
			let bundle_bytes = evaluator_result_bundle(evaluation);
			let bundle_reference = artifact("evaluator-results.json", &bundle_bytes);

			objects.insert(
				(
					bundle_reference.content_hash.trim_start_matches("sha256:").to_owned(),
					bundle_reference.kind.clone(),
				),
				bundle_bytes,
			);

			let run = RunRecord {
				schema_version: RUN_SCHEMA_VERSION.to_owned(),
				run_id: result.run_id.clone(),
				schedule_slot: ScheduleConfig::default()
					.slot("2026-07-25", ScheduleOccurrence::Day)
					.expect("slot"),
				task_set_hash: format!("sha256:{}", "4".repeat(64)),
				scoring_version: AIQ_SCORING_VERSION.to_owned(),
				execution_concurrency: Some(1),
				models: vec![model],
				started_unix_ms: 1,
				finished_unix_ms: 2,
				synthetic: false,
				capability_validation: None,
				provenance: None,
				evaluator_results_artifact: bundle_reference,
				results: vec![result],
			};

			Self {
				root,
				evaluator_root,
				evaluator_runtime,
				replay_root,
				tasks: vec![task],
				run,
				resolver: MemoryResolver { objects },
			}
		}

		fn verify(&self) -> Result<(), WorkerError> {
			self.verify_usage().map(drop)
		}

		fn verify_usage(&self) -> Result<Vec<runner::ProviderTokenUsage>, WorkerError> {
			self.verify_usage_with_jobs(1)
		}

		fn verify_usage_with_jobs(
			&self,
			replay_jobs: usize,
		) -> Result<Vec<runner::ProviderTokenUsage>, WorkerError> {
			replay::verify_production_run(
				&self.run,
				&self.tasks,
				&self.resolver,
				&self.evaluator_root,
				&self.evaluator_runtime,
				&self.replay_root,
				"123e4567-e89b-42d3-a456-426614174000",
				replay_jobs,
			)
		}

		fn replay_evidence(&self) -> Result<replay::ProductionReplayEvidence, WorkerError> {
			self.replay_evidence_with_jobs(1)
		}

		fn replay_evidence_with_jobs(
			&self,
			replay_jobs: usize,
		) -> Result<replay::ProductionReplayEvidence, WorkerError> {
			replay::replay_production_run(
				&self.run,
				&self.tasks,
				&self.resolver,
				&self.evaluator_root,
				&self.evaluator_runtime,
				&self.replay_root,
				"123e4567-e89b-42d3-a456-426614174000",
				replay_jobs,
			)
		}

		fn expand_results(&mut self, count: usize) {
			let result = self.run.results[0].clone();
			let reference = self.run.evaluator_results_artifact.clone();
			let bytes = self
				.resolver
				.objects
				.get(&(
					reference.content_hash.trim_start_matches("sha256:").to_owned(),
					reference.kind.clone(),
				))
				.expect("evaluator-results bytes");
			let bundle: EvaluatorResultsBundle =
				serde_json::from_slice(bytes).expect("evaluator-results bundle");
			let evaluation = bundle.results[0].clone();

			self.run.results = (0..count)
				.map(|index| {
					let mut result = result.clone();

					result.result_id = format!("result_{index:064x}");

					result
				})
				.collect();

			let expanded = EvaluatorResultsBundle {
				schema_version: EVALUATOR_RESULTS_SCHEMA_VERSION.to_owned(),
				results: (0..count).map(|_| evaluation.clone()).collect(),
			};

			self.replace_evaluator_bundle_bytes(
				protocol::canonical_json(&expanded).expect("expanded evaluator results"),
			);
		}

		fn make_failed(&mut self, kind: FailureKind) {
			let result = &mut self.run.results[0];

			result.status = ResultStatus::Failed;
			result.evaluation = EvaluationOutcome::NotEvaluated;
			result.task_score = matches!(
				kind,
				FailureKind::Timeout
					| FailureKind::UnsupportedModel
					| FailureKind::NonZeroExit
					| FailureKind::MissingResponse
					| FailureKind::BudgetExceeded
					| FailureKind::OutputTruncated
			)
			.then_some(0.0);
			result.response = None;
			result.response_sha256 = None;
			result.evaluator_result_sha256 = None;
			result.evaluator_stdout_sha256 = None;

			result.evaluator_checks.clear();

			result.failure = Some(ResultFailure {
				kind,
				message: "controlled failed-result fixture".to_owned(),
				exit_code: Some(17),
				retryable: true,
			});

			self.replace_evaluator_result(None);
		}

		fn remove_artifact(&mut self, kind: &str) {
			self.resolver.objects.retain(|(_, object_kind), _| object_kind != kind);
			self.run.results[0].artifacts.retain(|artifact| artifact.kind != kind);
		}

		fn replace_snapshot(&mut self, snapshot: WorkspaceSnapshot) {
			let bytes = protocol::canonical_json(&snapshot).expect("snapshot JSON");

			self.replace_artifact("workspace-snapshot.json", bytes);
		}

		fn replace_artifact(&mut self, kind: &str, bytes: Vec<u8>) {
			let reference = artifact(kind, &bytes);

			self.resolver.objects.retain(|(_, object_kind), _| object_kind != kind);
			self.resolver.objects.insert(
				(
					reference.content_hash.trim_start_matches("sha256:").to_owned(),
					reference.kind.clone(),
				),
				bytes,
			);

			let artifacts = &mut self.run.results[0].artifacts;

			artifacts.retain(|artifact| artifact.kind != kind);
			artifacts.push(reference);
		}

		fn replace_evaluator_result(&mut self, evaluation: Option<EvaluationResult>) {
			self.run.results[0].evaluator_result_sha256 = evaluation
				.as_ref()
				.map(protocol::canonical_hash)
				.transpose()
				.expect("evaluator-result digest");

			let bundle = EvaluatorResultsBundle {
				schema_version: EVALUATOR_RESULTS_SCHEMA_VERSION.to_owned(),
				results: vec![evaluation],
			};
			let bytes = protocol::canonical_json(&bundle).expect("evaluator-results JSON");

			self.replace_evaluator_bundle_bytes(bytes);
		}

		fn replace_evaluator_bundle_bytes(&mut self, bytes: Vec<u8>) {
			self.resolver
				.objects
				.retain(|(_, object_kind), _| object_kind != "evaluator-results.json");

			let reference = artifact("evaluator-results.json", &bytes);

			self.resolver.objects.insert(
				(
					reference.content_hash.trim_start_matches("sha256:").to_owned(),
					reference.kind.clone(),
				),
				bytes,
			);

			self.run.evaluator_results_artifact = reference;
		}
	}

	impl Drop for Fixture {
		fn drop(&mut self) {
			let _ = fs::remove_dir_all(&self.root);
		}
	}

	fn fixture_evaluator_runtime(root: &Path) -> EvaluatorRuntime {
		let runtime_path = root.join("node-test-runtime");

		fs::write(
			&runtime_path,
			"#!/bin/sh\nif [ \"$1\" = --version ]; then printf 'v0.0.0-test\\n'; else exec /bin/sh \"$@\"; fi\n",
		)
		.expect("test runtime");
		fs::set_permissions(&runtime_path, fs::Permissions::from_mode(0o700))
			.expect("test runtime permissions");

		EvaluatorRuntime::resolve(&runtime_path).expect("shell-backed test runtime")
	}

	fn evaluator_result_bundle(evaluation: EvaluationResult) -> Vec<u8> {
		let bundle = EvaluatorResultsBundle {
			schema_version: EVALUATOR_RESULTS_SCHEMA_VERSION.to_owned(),
			results: vec![Some(evaluation)],
		};

		protocol::canonical_json(&bundle).expect("evaluator-results JSON")
	}

	fn fixture_root() -> PathBuf {
		let sequence = NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed);
		let root =
			env::temp_dir().join(format!("aiq-verifier-replay-{}-{sequence}", process::id()));

		fs::create_dir(&root).expect("fixture root");

		root
	}

	fn candidate_evidence(
		entries: Vec<WorkspaceSnapshotEntry>,
	) -> (ArtifactReference, ArtifactReference, BTreeMap<(String, String), Vec<u8>>) {
		let manifest = WorkspaceManifest {
			schema_version: "aiq.workspace-manifest.v1",
			entries: entries
				.iter()
				.map(|entry| WorkspaceManifestEntry {
					path: entry.path.clone(),
					kind: if entry.kind == "directory" { "directory" } else { "file" },
					bytes: entry.bytes,
					sha256: entry.sha256.clone(),
				})
				.collect(),
		};
		let manifest_bytes = protocol::canonical_json(&manifest).expect("manifest JSON");
		let manifest_hash = protocol::canonical_hash(&manifest).expect("manifest hash");
		let snapshot = WorkspaceSnapshot {
			schema_version: "aiq.workspace-snapshot.v1".to_owned(),
			manifest_sha256: manifest_hash,
			entries,
		};
		let snapshot_bytes = protocol::canonical_json(&snapshot).expect("snapshot JSON");
		let manifest_reference = artifact("workspace-manifest.json", &manifest_bytes);
		let snapshot_reference = artifact("workspace-snapshot.json", &snapshot_bytes);
		let mut objects = BTreeMap::new();

		for (reference, bytes) in
			[(&manifest_reference, manifest_bytes), (&snapshot_reference, snapshot_bytes)]
		{
			objects.insert(
				(
					reference.content_hash.trim_start_matches("sha256:").to_owned(),
					reference.kind.clone(),
				),
				bytes,
			);
		}

		(manifest_reference, snapshot_reference, objects)
	}

	fn artifact(kind: &str, bytes: &[u8]) -> ArtifactReference {
		let digest = hex::encode(Sha256::digest(bytes));

		ArtifactReference {
			kind: kind.to_owned(),
			content_hash: format!("sha256:{digest}"),
			uri: format!("aiq-artifact://sha256/{digest}/{kind}"),
			bytes: u64::try_from(bytes.len()).expect("artifact size"),
		}
	}

	#[cfg(unix)]
	fn install_shell_evaluator(fixture: &mut Fixture, script: &str) {
		let executable_ref = PathBuf::from("evaluator.sh");
		let executable = fixture.evaluator_root.join(&executable_ref);

		fs::write(&executable, script).expect("write evaluator script");
		fs::set_permissions(&executable, fs::Permissions::from_mode(0o700))
			.expect("evaluator executable permissions");

		let executable_bytes = fs::read(&executable).expect("evaluator executable bytes");
		let configuration = BTreeMap::new();
		let binding = ExternalEvaluatorBinding {
			protocol_version: EVALUATOR_PROTOCOL_VERSION.to_owned(),
			scorer_version: fixture.tasks[0].scorer_version.clone(),
			runtime_kind: EvaluatorRuntimeKind::Node,
			runtime_executable_digest: fixture.evaluator_runtime.executable_digest().to_owned(),
			executable_ref,
			executable_digest: format!("sha256:{}", hex::encode(Sha256::digest(&executable_bytes))),
			configuration_digest: protocol::canonical_hash(&configuration)
				.expect("configuration hash"),
			arguments: Vec::new(),
			timeout_ms: 2_000,
			max_input_bytes: 64 * 1_024,
			max_output_bytes: 64 * 1_024,
			configuration,
		};
		let evaluator = fixture.tasks[0].evaluator.as_mut().expect("evaluator");

		evaluator.kind = "repository_test_suite".to_owned();
		evaluator.expected = None;
		evaluator.external = Some(binding);
		fixture.run.results[0].task_hash =
			fixture.tasks[0].content_hash().expect("updated task hash");
	}

	#[cfg(unix)]
	fn current_evaluator_stdout(fixture: &Fixture) -> String {
		let reference = &fixture.run.evaluator_results_artifact;
		let bytes = fixture
			.resolver
			.objects
			.get(&(
				reference.content_hash.trim_start_matches("sha256:").to_owned(),
				reference.kind.clone(),
			))
			.expect("evaluator-results bytes");
		let bundle: EvaluatorResultsBundle =
			serde_json::from_slice(bytes).expect("evaluator-results bundle");
		let mut evaluation = bundle.results[0].clone().expect("evaluator result");

		evaluation.raw_stdout_sha256 = None;

		format!(
			"{}\n",
			String::from_utf8(protocol::canonical_json(&evaluation).expect("evaluator JSON"))
				.expect("evaluator UTF-8")
		)
	}

	#[cfg(unix)]
	fn bind_external_evaluator_stdout(fixture: &mut Fixture, stdout: &str) {
		let digest = format!("sha256:{}", hex::encode(Sha256::digest(stdout.as_bytes())));
		let mut evaluation: EvaluationResult =
			serde_json::from_str(stdout).expect("external evaluator result");

		evaluation.raw_stdout_sha256 = Some(digest.clone());
		fixture.run.results[0].evaluator_stdout_sha256 = Some(digest);

		fixture.replace_evaluator_result(Some(evaluation));
	}

	fn snapshot_from(fixture: &Fixture) -> WorkspaceSnapshot {
		let reference = fixture.run.results[0]
			.artifacts
			.iter()
			.find(|artifact| artifact.kind == "workspace-snapshot.json")
			.expect("snapshot reference");
		let bytes = fixture
			.resolver
			.objects
			.get(&(
				reference.content_hash.trim_start_matches("sha256:").to_owned(),
				reference.kind.clone(),
			))
			.expect("snapshot bytes");

		serde_json::from_slice(bytes).expect("snapshot")
	}

	fn assert_replay_error(error: WorkerError, expected: ReasonCode) {
		assert_eq!(error.kind, crate::ErrorKind::Terminal(expected));
	}

	#[test]
	fn valid_completed_replay_uses_inline_response_and_cleans_workspace() {
		let fixture = Fixture::completed("OK");
		let evidence = fixture.replay_evidence().expect("valid replay evidence");

		assert_eq!(evidence.provider_usage.len(), 1);

		let replayed = evidence.evaluator_results[0].as_ref().expect("replayed evaluator result");

		assert_eq!(replayed.outcome, EvaluatorOutcome::Correct);
		assert_eq!(replayed.score, 1.0);
		assert!(!replayed.checks.is_empty());
		assert_eq!(fs::read_dir(&fixture.replay_root).expect("replay root").count(), 0);
	}

	#[test]
	fn evaluator_results_bundle_reference_is_canonical_and_bounded() {
		let mut wrong_kind = Fixture::completed("OK");

		wrong_kind.run.evaluator_results_artifact.kind = "stdout.jsonl".to_owned();

		assert_replay_error(
			wrong_kind.verify().expect_err("wrong evaluator-results kind"),
			ReasonCode::ArtifactEvidenceMismatch,
		);

		let mut oversized = Fixture::completed("OK");

		oversized.run.evaluator_results_artifact.bytes =
			(runner::MAX_EVALUATOR_RESULTS_BUNDLE_BYTES + 1) as u64;

		assert_replay_error(
			oversized.verify().expect_err("oversized evaluator-results reference"),
			ReasonCode::ArtifactEvidenceMismatch,
		);
	}

	#[test]
	fn evaluator_results_bundle_rejects_noncanonical_malformed_and_extra_entries() {
		let mut noncanonical = Fixture::completed("OK");
		let canonical_reference = &noncanonical.run.evaluator_results_artifact;
		let canonical = noncanonical
			.resolver
			.objects
			.get(&(
				canonical_reference.content_hash.trim_start_matches("sha256:").to_owned(),
				canonical_reference.kind.clone(),
			))
			.expect("bundle bytes");
		let mut spaced = Vec::with_capacity(canonical.len() + 1);

		spaced.push(b' ');
		spaced.extend_from_slice(canonical);
		noncanonical.replace_evaluator_bundle_bytes(spaced);

		assert_replay_error(
			noncanonical.verify().expect_err("noncanonical evaluator-results bundle"),
			ReasonCode::InvalidReplayEvidence,
		);

		let mut malformed = Fixture::completed("OK");

		malformed.replace_evaluator_bundle_bytes(b"{".to_vec());

		assert_replay_error(
			malformed.verify().expect_err("malformed evaluator-results bundle"),
			ReasonCode::InvalidReplayEvidence,
		);

		let mut extra = Fixture::completed("OK");
		let reference = &extra.run.evaluator_results_artifact;
		let bytes = extra
			.resolver
			.objects
			.get(&(
				reference.content_hash.trim_start_matches("sha256:").to_owned(),
				reference.kind.clone(),
			))
			.expect("bundle bytes");
		let mut bundle: EvaluatorResultsBundle =
			serde_json::from_slice(bytes).expect("evaluator-results bundle");

		bundle.results.push(None);
		extra.replace_evaluator_bundle_bytes(
			protocol::canonical_json(&bundle).expect("extra evaluator-results JSON"),
		);

		assert_replay_error(
			extra.verify().expect_err("extra evaluator-results entry"),
			ReasonCode::InvalidReplayEvidence,
		);
	}

	#[test]
	fn evaluator_results_bundle_rejects_null_and_digest_mismatch_for_completed_result() {
		let bundle = EvaluatorResultsBundle {
			schema_version: EVALUATOR_RESULTS_SCHEMA_VERSION.to_owned(),
			results: vec![None],
		};
		let mut missing_entry = Fixture::completed("OK");

		missing_entry.replace_evaluator_bundle_bytes(
			protocol::canonical_json(&bundle).expect("null evaluator-results JSON"),
		);

		assert_replay_error(
			missing_entry.verify().expect_err("null completed evaluator result"),
			ReasonCode::InvalidReplayEvidence,
		);

		let mismatched = EvaluationResult {
			schema_version: EVALUATOR_RESULT_SCHEMA_VERSION.to_owned(),
			outcome: EvaluatorOutcome::Incorrect,
			score: 0.0,
			checks: vec![EvaluatorCheck {
				check_id: "exact_match".to_owned(),
				weight: 1,
				passed: false,
				failure_class: EvaluatorCheckFailureClass::Value,
				evidence_digest: format!("sha256:{}", "d".repeat(64)),
			}],
			raw_stdout_sha256: None,
		};
		let bundle = EvaluatorResultsBundle {
			schema_version: EVALUATOR_RESULTS_SCHEMA_VERSION.to_owned(),
			results: vec![Some(mismatched)],
		};
		let mut digest_mismatch = Fixture::completed("OK");

		digest_mismatch.replace_evaluator_bundle_bytes(
			protocol::canonical_json(&bundle).expect("mismatched evaluator-results JSON"),
		);

		assert_replay_error(
			digest_mismatch.verify().expect_err("evaluator-result digest mismatch"),
			ReasonCode::InvalidReplayEvidence,
		);
	}

	#[test]
	fn evaluator_results_bundle_rejects_duplicate_fields_reordering_and_too_many_checks() {
		let mut duplicate_field = Fixture::completed("OK");
		let reference = &duplicate_field.run.evaluator_results_artifact;
		let canonical = duplicate_field
			.resolver
			.objects
			.get(&(
				reference.content_hash.trim_start_matches("sha256:").to_owned(),
				reference.kind.clone(),
			))
			.expect("bundle bytes");
		let canonical = str::from_utf8(canonical).expect("bundle UTF-8");
		let duplicate =
			canonical.replacen("{", "{\"schema_version\":\"aiq.evaluator-results.v1\",", 1);

		duplicate_field.replace_evaluator_bundle_bytes(duplicate.into_bytes());

		assert_replay_error(
			duplicate_field.verify().expect_err("duplicate bundle field"),
			ReasonCode::InvalidReplayEvidence,
		);

		let mut reordered = Fixture::completed("OK");
		let correct_reference = &reordered.run.evaluator_results_artifact;
		let correct_bytes = reordered
			.resolver
			.objects
			.get(&(
				correct_reference.content_hash.trim_start_matches("sha256:").to_owned(),
				correct_reference.kind.clone(),
			))
			.expect("bundle bytes");
		let correct_bundle: EvaluatorResultsBundle =
			serde_json::from_slice(correct_bytes).expect("bundle");
		let correct = correct_bundle.results[0].clone().expect("correct evaluator result");
		let incorrect = EvaluationResult {
			schema_version: EVALUATOR_RESULT_SCHEMA_VERSION.to_owned(),
			outcome: EvaluatorOutcome::Incorrect,
			score: 0.0,
			checks: vec![EvaluatorCheck {
				check_id: "exact_match".to_owned(),
				weight: 1,
				passed: false,
				failure_class: EvaluatorCheckFailureClass::Value,
				evidence_digest: format!("sha256:{}", "c".repeat(64)),
			}],
			raw_stdout_sha256: None,
		};
		let mut second = reordered.run.results[0].clone();

		second.evaluation = EvaluationOutcome::Incorrect;
		second.task_score = Some(0.0);
		second.evaluator_result_sha256 =
			Some(protocol::canonical_hash(&incorrect).expect("incorrect digest"));

		reordered.run.results.push(second);

		let bundle = EvaluatorResultsBundle {
			schema_version: EVALUATOR_RESULTS_SCHEMA_VERSION.to_owned(),
			results: vec![Some(incorrect), Some(correct)],
		};

		reordered.replace_evaluator_bundle_bytes(
			protocol::canonical_json(&bundle).expect("reordered bundle JSON"),
		);

		assert_replay_error(
			reordered.verify().expect_err("reordered evaluator results"),
			ReasonCode::InvalidReplayEvidence,
		);

		let evaluation = EvaluationResult {
			schema_version: EVALUATOR_RESULT_SCHEMA_VERSION.to_owned(),
			outcome: EvaluatorOutcome::Correct,
			score: 1.0,
			checks: (0..17)
				.map(|index| EvaluatorCheck {
					check_id: format!("check-{index}"),
					weight: 1,
					passed: true,
					failure_class: EvaluatorCheckFailureClass::None,
					evidence_digest: format!("sha256:{}", format!("{:x}", index % 16).repeat(64)),
				})
				.collect(),
			raw_stdout_sha256: None,
		};
		let mut too_many_checks = Fixture::completed("OK");

		too_many_checks.run.results[0].evaluator_result_sha256 =
			Some(protocol::canonical_hash(&evaluation).expect("oversized check digest"));

		let bundle = EvaluatorResultsBundle {
			schema_version: EVALUATOR_RESULTS_SCHEMA_VERSION.to_owned(),
			results: vec![Some(evaluation)],
		};

		too_many_checks.replace_evaluator_bundle_bytes(
			protocol::canonical_json(&bundle).expect("oversized check bundle JSON"),
		);

		assert_replay_error(
			too_many_checks.verify().expect_err("too many evaluator checks"),
			ReasonCode::InvalidReplayEvidence,
		);
	}

	#[test]
	fn lease_renewal_failure_cleans_reconstructed_workspace() {
		let fixture = Fixture::completed("OK");
		let resolver = FailingLeaseResolver { inner: fixture.resolver.clone() };
		let error = replay::verify_production_run(
			&fixture.run,
			&fixture.tasks,
			&resolver,
			&fixture.evaluator_root,
			&fixture.evaluator_runtime,
			&fixture.replay_root,
			"123e4567-e89b-42d3-a456-426614174000",
			1,
		)
		.expect_err("lease failure");

		assert!(error.is_transient());
		assert_eq!(fs::read_dir(&fixture.replay_root).expect("replay root").count(), 0);
	}

	#[test]
	fn long_response_requires_and_verifies_final_response_artifact() {
		let response = format!("{}OK", "x".repeat(runner::MAX_RESULT_PREVIEW_BYTES + 16));
		let mut fixture = Fixture::completed(&response);
		let reference = artifact("final-response.txt", response.as_bytes());

		fixture.resolver.objects.insert(
			(
				reference.content_hash.trim_start_matches("sha256:").to_owned(),
				reference.kind.clone(),
			),
			response.as_bytes().to_vec(),
		);

		fixture.run.results[0].response = Some(response[..MAX_RESULT_PREVIEW_BYTES].to_owned());

		fixture.run.results[0].artifacts.push(reference);

		fixture.tasks[0].evaluator.as_mut().expect("evaluator").expected = Some(response);

		let evaluation = fixture.tasks[0]
			.evaluator
			.as_ref()
			.expect("evaluator")
			.evaluate_checked(
				fixture.tasks[0]
					.evaluator
					.as_ref()
					.and_then(|evaluator| evaluator.expected.as_deref())
					.expect("expected"),
				None,
			)
			.expect("evaluation");

		fixture.run.results[0].evaluation = EvaluationOutcome::Correct;
		fixture.run.results[0].task_score = Some(evaluation.score);
		fixture.run.results[0].evaluator_checks = evaluation.checks.clone();

		fixture.replace_evaluator_result(Some(evaluation));
		fixture.verify().expect("long response replay");
	}

	#[test]
	fn shared_stdout_parser_recomputes_tool_evidence_for_replay() {
		let stdout = [
			r#"{"type":"item.completed","item":{"id":"cmd-1","type":"command_execution","status":"completed"}}"#,
			r#"{"type":"item.completed","item":{"id":"message-1","type":"agent_message","text":"OK"}}"#,
		]
		.join("\n");
		let mut fixture = Fixture::completed("OK");

		fixture.replace_artifact("stdout.jsonl", stdout.as_bytes().to_vec());

		fixture.run.results[0].tool_usage = runner::parse_codex_tool_usage(&stdout);

		fixture.verify().expect("shared parser replay");
	}

	fn failed_usage_stdout() -> String {
		[
			r#"{"type":"item.completed","item":{"id":"cmd-1","type":"command_execution","status":"completed"}}"#,
			r#"{"type":"turn.completed","usage":{"input_tokens":11,"cached_input_tokens":2,"cache_write_input_tokens":1,"output_tokens":5,"reasoning_output_tokens":3,"total_tokens":16}}"#,
		]
		.join("\n")
	}

	#[test]
	fn failed_results_replay_signed_tool_and_provider_usage() {
		for kind in [FailureKind::NonZeroExit, FailureKind::Timeout] {
			let stdout = failed_usage_stdout();
			let expected = runner::parse_codex_tool_usage(&stdout);
			let mut fixture = Fixture::completed("OK");

			fixture.make_failed(kind);
			fixture.replace_artifact("stdout.jsonl", stdout.into_bytes());

			fixture.run.results[0].tool_usage = expected.clone();

			let usage = fixture.verify_usage().expect("failed-result evidence replay");

			assert_eq!(usage, vec![expected.provider_tokens]);
		}
	}

	#[test]
	fn failed_result_without_stdout_accepts_only_default_counters() {
		let mut fixture = Fixture::completed("OK");

		fixture.make_failed(FailureKind::NonZeroExit);
		fixture.remove_artifact("stdout.jsonl");

		fixture.run.results[0].tool_usage = runner::ToolUsage::default();

		assert_eq!(
			fixture.verify_usage().expect("empty failed-result usage"),
			vec![runner::ProviderTokenUsage::default()]
		);

		fixture.run.results[0].tool_usage.total_calls = 1;

		assert_replay_error(
			fixture.verify().expect_err("unsigned failed-result counters"),
			ReasonCode::ArtifactEvidenceMismatch,
		);
	}

	#[test]
	fn workspace_integrity_replays_with_or_without_paired_workspace_evidence() {
		for retain_workspace in [false, true] {
			let stdout = failed_usage_stdout();
			let expected = runner::parse_codex_tool_usage(&stdout);
			let mut fixture = Fixture::completed("OK");

			fixture.make_failed(FailureKind::WorkspaceIntegrity);
			fixture.replace_artifact("stdout.jsonl", stdout.into_bytes());

			fixture.run.results[0].tool_usage = expected.clone();

			if !retain_workspace {
				fixture.run.results[0].workspace_manifest = None;

				fixture.remove_artifact("workspace-snapshot.json");
			}

			let usage = fixture.verify_usage().expect("workspace-integrity replay");

			assert_eq!(usage, vec![expected.provider_tokens]);
		}
	}

	#[test]
	fn workspace_integrity_rejects_one_sided_workspace_evidence() {
		let mut manifest_only = Fixture::completed("OK");

		manifest_only.make_failed(FailureKind::WorkspaceIntegrity);
		manifest_only.remove_artifact("workspace-snapshot.json");

		assert_replay_error(
			manifest_only.verify().expect_err("manifest-only workspace evidence"),
			ReasonCode::InvalidReplayEvidence,
		);

		let mut snapshot_only = Fixture::completed("OK");

		snapshot_only.make_failed(FailureKind::WorkspaceIntegrity);

		snapshot_only.run.results[0].workspace_manifest = None;

		assert_replay_error(
			snapshot_only.verify().expect_err("snapshot-only workspace evidence"),
			ReasonCode::InvalidReplayEvidence,
		);
	}

	#[test]
	fn signed_tool_counters_and_stdout_bytes_must_match() {
		let mut counters = Fixture::completed("OK");

		counters.run.results[0].tool_usage.steps += 1;

		assert_replay_error(
			counters.verify().expect_err("tool counter drift"),
			ReasonCode::ArtifactEvidenceMismatch,
		);

		let mut bytes = Fixture::completed("OK");
		let stdout = bytes.run.results[0]
			.artifacts
			.iter()
			.find(|artifact| artifact.kind == "stdout.jsonl")
			.expect("stdout reference");
		let key =
			(stdout.content_hash.trim_start_matches("sha256:").to_owned(), stdout.kind.clone());
		let object = bytes.resolver.objects.get_mut(&key).expect("stdout bytes");

		object[0] = b'[';

		assert_replay_error(
			bytes.verify().expect_err("stdout byte tamper"),
			ReasonCode::ArtifactEvidenceMismatch,
		);
	}

	#[test]
	fn completed_result_requires_one_strict_utf8_stdout_artifact() {
		let mut missing = Fixture::completed("OK");

		missing.run.results[0].artifacts.retain(|artifact| artifact.kind != "stdout.jsonl");

		assert_replay_error(
			missing.verify().expect_err("missing stdout"),
			ReasonCode::InvalidReplayEvidence,
		);

		let mut duplicate = Fixture::completed("OK");
		let stdout = duplicate.run.results[0]
			.artifacts
			.iter()
			.find(|artifact| artifact.kind == "stdout.jsonl")
			.expect("stdout reference")
			.clone();

		duplicate.run.results[0].artifacts.push(stdout);

		assert_replay_error(
			duplicate.verify().expect_err("duplicate stdout"),
			ReasonCode::InvalidReplayEvidence,
		);

		let mut misplaced_bundle = Fixture::completed("OK");
		let bundle_reference = misplaced_bundle.run.evaluator_results_artifact.clone();

		misplaced_bundle.run.results[0].artifacts.push(bundle_reference);

		assert_replay_error(
			misplaced_bundle.verify().expect_err("misplaced evaluator-results bundle"),
			ReasonCode::InvalidReplayEvidence,
		);

		let mut invalid_utf8 = Fixture::completed("OK");

		invalid_utf8.replace_artifact("stdout.jsonl", vec![0xff]);

		assert_replay_error(
			invalid_utf8.verify().expect_err("non-UTF-8 stdout"),
			ReasonCode::InvalidReplayEvidence,
		);
	}

	#[test]
	fn snapshot_manifest_mismatch_is_rejected() {
		let mut fixture = Fixture::completed("OK");
		let mut snapshot = snapshot_from(&fixture);

		snapshot.manifest_sha256 = format!("sha256:{}", "f".repeat(64));

		fixture.replace_snapshot(snapshot);

		assert_replay_error(
			fixture.verify().expect_err("mismatch"),
			ReasonCode::ArtifactEvidenceMismatch,
		);
	}

	#[test]
	fn traversal_snapshot_is_rejected_and_cleaned() {
		let mut fixture = Fixture::completed("OK");
		let bytes = b"escape";
		let snapshot = WorkspaceSnapshot {
			schema_version: "aiq.workspace-snapshot.v1".to_owned(),
			manifest_sha256: fixture.run.results[0]
				.workspace_manifest
				.as_ref()
				.expect("manifest")
				.content_hash
				.clone(),
			entries: vec![WorkspaceSnapshotEntry {
				path: "../escape".to_owned(),
				kind: "file".to_owned(),
				bytes: Some(u64::try_from(bytes.len()).expect("size")),
				sha256: Some(format!("sha256:{}", hex::encode(Sha256::digest(bytes)))),
				content_hex: Some(hex::encode(bytes)),
			}],
		};

		fixture.replace_snapshot(snapshot);

		assert_replay_error(
			fixture.verify().expect_err("traversal"),
			ReasonCode::InvalidReplayEvidence,
		);

		assert_eq!(fs::read_dir(&fixture.replay_root).expect("replay root").count(), 0);
	}

	#[test]
	fn missing_and_duplicate_snapshots_are_rejected() {
		let mut missing = Fixture::completed("OK");

		missing.run.results[0]
			.artifacts
			.retain(|artifact| artifact.kind != "workspace-snapshot.json");

		assert_replay_error(
			missing.verify().expect_err("missing snapshot"),
			ReasonCode::InvalidReplayEvidence,
		);

		let mut duplicate = Fixture::completed("OK");
		let snapshot = duplicate.run.results[0].artifacts[0].clone();

		duplicate.run.results[0].artifacts.push(snapshot);

		assert_replay_error(
			duplicate.verify().expect_err("duplicate snapshot"),
			ReasonCode::InvalidReplayEvidence,
		);
	}

	#[test]
	fn evaluator_score_and_ordered_check_drift_are_rejected() {
		let mut score = Fixture::completed("OK");

		score.run.results[0].evaluation = EvaluationOutcome::Partial;
		score.run.results[0].task_score = Some(0.5);

		score.replace_evaluator_result(Some(EvaluationResult {
			schema_version: EVALUATOR_RESULT_SCHEMA_VERSION.to_owned(),
			outcome: EvaluatorOutcome::Partial,
			score: 0.5,
			checks: vec![
				EvaluatorCheck {
					check_id: "first".to_owned(),
					weight: 1,
					passed: true,
					failure_class: EvaluatorCheckFailureClass::None,
					evidence_digest: format!("sha256:{}", "a".repeat(64)),
				},
				EvaluatorCheck {
					check_id: "second".to_owned(),
					weight: 1,
					passed: false,
					failure_class: EvaluatorCheckFailureClass::Value,
					evidence_digest: format!("sha256:{}", "b".repeat(64)),
				},
			],
			raw_stdout_sha256: None,
		}));

		assert_replay_error(
			score.verify().expect_err("score drift"),
			ReasonCode::EvaluatorReplayMismatch,
		);

		let mut checks = Fixture::completed("OK");

		checks.replace_evaluator_result(Some(EvaluationResult {
			schema_version: EVALUATOR_RESULT_SCHEMA_VERSION.to_owned(),
			outcome: EvaluatorOutcome::Correct,
			score: 1.0,
			checks: vec![EvaluatorCheck {
				check_id: "exact_match".to_owned(),
				weight: 1,
				passed: true,
				failure_class: EvaluatorCheckFailureClass::None,
				evidence_digest: format!("sha256:{}", "e".repeat(64)),
			}],
			raw_stdout_sha256: None,
		}));

		assert_replay_error(
			checks.verify().expect_err("check drift"),
			ReasonCode::EvaluatorReplayMismatch,
		);
	}

	#[cfg(unix)]
	#[test]
	fn nondeterministic_external_evaluator_is_rejected_and_cleaned() {
		let mut fixture = Fixture::completed("OK");

		install_shell_evaluator(
			&mut fixture,
			r#"cat >/dev/null
if [ -e replay-counter ]; then
  printf '%s\n' '{"schema_version":"aiq.evaluator-result.v3","outcome":"incorrect","score":0.0,"checks":[{"check_id":"repository_test","weight":1,"passed":false,"failure_class":"value","evidence_digest":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}]}'
else
  : > replay-counter
  printf '%s\n' '{"schema_version":"aiq.evaluator-result.v3","outcome":"correct","score":1.0,"checks":[{"check_id":"repository_test","weight":1,"passed":true,"failure_class":"none","evidence_digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]}'
fi"#,
		);
		assert_replay_error(
			fixture.verify().expect_err("nondeterministic evaluator"),
			ReasonCode::EvaluatorReplayMismatch,
		);

		assert_eq!(fs::read_dir(&fixture.replay_root).expect("replay root").count(), 0);
	}

	#[cfg(unix)]
	#[test]
	fn external_evaluator_requires_and_replays_exact_raw_stdout_digest() {
		let mut missing = Fixture::completed("OK");
		let stdout = current_evaluator_stdout(&missing);
		let script = format!("cat >/dev/null\nprintf '%s' '{stdout}'");

		install_shell_evaluator(&mut missing, &script);
		assert_replay_error(
			missing.verify().expect_err("missing raw stdout digest"),
			ReasonCode::EvaluatorReplayMismatch,
		);

		let mut exact = Fixture::completed("OK");
		let stdout = current_evaluator_stdout(&exact);
		let script = format!("cat >/dev/null\nprintf '%s' '{stdout}'");

		install_shell_evaluator(&mut exact, &script);
		bind_external_evaluator_stdout(&mut exact, &stdout);

		exact.verify().expect("exact raw stdout digest");

		let mut mutated = Fixture::completed("OK");
		let stdout = current_evaluator_stdout(&mutated);
		let script = format!("cat >/dev/null\nprintf '%s' '{stdout}'");

		install_shell_evaluator(&mut mutated, &script);
		bind_external_evaluator_stdout(&mut mutated, &stdout);

		let wrong_digest = format!("sha256:{}", "9".repeat(64));
		let reference = &mutated.run.evaluator_results_artifact;
		let bytes = mutated
			.resolver
			.objects
			.get(&(
				reference.content_hash.trim_start_matches("sha256:").to_owned(),
				reference.kind.clone(),
			))
			.expect("evaluator-results bytes");
		let bundle: EvaluatorResultsBundle =
			serde_json::from_slice(bytes).expect("evaluator-results bundle");
		let mut evaluation = bundle.results[0].clone().expect("evaluator result");

		evaluation.raw_stdout_sha256 = Some(wrong_digest.clone());
		mutated.run.results[0].evaluator_stdout_sha256 = Some(wrong_digest);

		mutated.replace_evaluator_result(Some(evaluation));

		assert_replay_error(
			mutated.verify().expect_err("mutated raw stdout digest"),
			ReasonCode::EvaluatorReplayMismatch,
		);
	}

	#[cfg(unix)]
	#[test]
	fn external_evaluator_execution_failure_is_rejected() {
		let mut fixture = Fixture::completed("OK");

		install_shell_evaluator(&mut fixture, "cat >/dev/null; exit 7");
		assert_replay_error(
			fixture.verify().expect_err("evaluator execution failure"),
			ReasonCode::EvaluatorReplayMismatch,
		);
	}

	#[cfg(unix)]
	#[test]
	fn external_evaluator_ambiguous_failure_class_is_rejected_by_shared_validation() {
		let mut fixture = Fixture::completed("OK");

		install_shell_evaluator(
			&mut fixture,
			r#"cat >/dev/null
printf '%s\n' '{"schema_version":"aiq.evaluator-result.v3","outcome":"incorrect","score":0.0,"checks":[{"check_id":"repository_test","weight":1,"passed":false,"failure_class":"none","evidence_digest":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}]}'"#,
		);
		assert_replay_error(
			fixture.verify().expect_err("ambiguous evaluator failure class"),
			ReasonCode::EvaluatorReplayMismatch,
		);
	}

	#[test]
	fn attempted_model_failure_verifies_artifacts_without_claiming_model_reexecution() {
		let mut fixture = Fixture::completed("OK");
		let result = &mut fixture.run.results[0];

		result.status = ResultStatus::Failed;
		result.evaluation = EvaluationOutcome::NotEvaluated;
		result.task_score = Some(0.0);
		result.response = None;
		result.response_sha256 = None;

		result.evaluator_checks.clear();

		result.failure = Some(ResultFailure {
			kind: FailureKind::MissingResponse,
			message: "fixture model produced no response".to_owned(),
			exit_code: Some(1),
			retryable: true,
		});

		fixture.replace_evaluator_result(None);
		fixture.verify().expect("failed model evidence policy");
	}

	#[test]
	fn failed_model_artifact_and_taxonomy_drift_are_rejected() {
		let mut missing_artifact = Fixture::completed("OK");
		let result = &mut missing_artifact.run.results[0];

		result.status = ResultStatus::Failed;
		result.evaluation = EvaluationOutcome::NotEvaluated;
		result.task_score = Some(0.0);
		result.response = None;
		result.response_sha256 = None;

		result.evaluator_checks.clear();

		result.failure = Some(ResultFailure {
			kind: FailureKind::NonZeroExit,
			message: "fixture model failed".to_owned(),
			exit_code: Some(1),
			retryable: true,
		});

		result.artifacts.push(artifact("stderr.txt", b"missing"));
		missing_artifact.replace_evaluator_result(None);

		assert_replay_error(
			missing_artifact.verify().expect_err("missing failed artifact"),
			ReasonCode::ArtifactEvidenceUnavailable,
		);

		let mut taxonomy = Fixture::completed("OK");
		let result = &mut taxonomy.run.results[0];

		result.status = ResultStatus::Failed;
		result.evaluation = EvaluationOutcome::NotEvaluated;
		result.task_score = None;
		result.response = None;
		result.response_sha256 = None;

		result.evaluator_checks.clear();

		result.failure = Some(ResultFailure {
			kind: FailureKind::NonZeroExit,
			message: "fixture model failed".to_owned(),
			exit_code: Some(1),
			retryable: true,
		});

		taxonomy.replace_evaluator_result(None);

		assert_replay_error(
			taxonomy.verify().expect_err("invalid failure taxonomy"),
			ReasonCode::InvalidReplayEvidence,
		);
	}

	#[test]
	fn evaluator_failure_without_a_committed_result_is_rejected() {
		let mut fixture = Fixture::completed("OK");
		let result = &mut fixture.run.results[0];

		result.status = ResultStatus::Failed;
		result.evaluation = EvaluationOutcome::NotEvaluated;
		result.task_score = None;

		result.evaluator_checks.clear();

		result.failure = Some(ResultFailure {
			kind: FailureKind::EvaluatorFailure,
			message: "fixture evaluator failed".to_owned(),
			exit_code: Some(0),
			retryable: true,
		});

		fixture.replace_evaluator_result(None);

		assert_replay_error(
			fixture.verify().expect_err("evaluator failure"),
			ReasonCode::EvaluatorReplayMismatch,
		);
	}

	#[test]
	fn oversized_artifact_reference_fails_before_resolution() {
		let mut fixture = Fixture::completed("OK");

		fixture.run.results[0].artifacts[0].bytes = (4 * 1_024 * 1_024 + 1) as u64;

		assert_replay_error(
			fixture.verify().expect_err("oversized"),
			ReasonCode::ArtifactEvidenceMismatch,
		);
	}

	#[test]
	fn fixture_paths_are_unique() {
		let first = fixture_root();
		let second = fixture_root();

		assert_ne!(first, second);

		for path in [first, second] {
			fs::remove_dir_all(path).expect("cleanup");
		}
	}

	#[test]
	fn resolver_fixture_contains_unique_content_addresses() {
		let fixture = Fixture::completed("OK");
		let keys = fixture.resolver.objects.keys().collect::<BTreeSet<_>>();

		assert_eq!(keys.len(), fixture.resolver.objects.len());
		assert!(Path::new(&fixture.replay_root).is_dir());
	}

	#[test]
	fn parallel_replay_matches_single_job_order_and_evidence() {
		let mut fixture = Fixture::completed("OK");

		fixture.expand_results(16);

		let single = fixture.replay_evidence_with_jobs(1).expect("single-job replay");
		let parallel = fixture.replay_evidence_with_jobs(4).expect("parallel replay");

		assert_eq!(parallel.provider_usage, single.provider_usage);
		assert_eq!(parallel.evaluator_results, single.evaluator_results);
		assert_eq!(fs::read_dir(&fixture.replay_root).expect("replay root").count(), 0);
	}

	#[test]
	fn parallel_replay_preserves_provider_usage_indices() {
		let mut fixture = Fixture::completed("OK");

		fixture.expand_results(12);

		let stdout = failed_usage_stdout();
		let expected = runner::parse_codex_tool_usage(&stdout);
		let reference = artifact("stdout.jsonl", stdout.as_bytes());

		fixture.resolver.objects.insert(
			(
				reference.content_hash.trim_start_matches("sha256:").to_owned(),
				reference.kind.clone(),
			),
			stdout.into_bytes(),
		);

		for (index, result) in fixture.run.results.iter_mut().enumerate() {
			if index % 2 == 1 {
				result.artifacts.retain(|artifact| artifact.kind != "stdout.jsonl");
				result.artifacts.push(reference.clone());

				result.tool_usage = expected.clone();
			}
		}

		let usage = fixture.verify_usage_with_jobs(4).expect("parallel provider replay");

		for (index, observed) in usage.iter().enumerate() {
			if index % 2 == 1 {
				assert_eq!(observed, &expected.provider_tokens);
			} else {
				assert_eq!(observed, &runner::ProviderTokenUsage::default());
			}
		}
	}

	#[test]
	fn parallel_failure_uses_lowest_result_index_and_cleans_after_join() {
		let mut fixture = Fixture::completed("OK");

		fixture.expand_results(16);
		fixture.run.results[2].artifacts.retain(|artifact| artifact.kind != "stdout.jsonl");

		fixture.run.results[5]
			.workspace_manifest
			.as_mut()
			.expect("workspace manifest")
			.content_hash = format!("sha256:{}", "9".repeat(64));

		let error = fixture.verify_usage_with_jobs(8).expect_err("parallel failure");

		assert_replay_error(error, ReasonCode::InvalidReplayEvidence);

		assert_eq!(fs::read_dir(&fixture.replay_root).expect("replay root").count(), 0);
	}

	#[test]
	fn maximum_official_shape_replays_with_bounded_parallelism() {
		let mut fixture = Fixture::completed("OK");

		fixture.expand_results(1_224);

		let usage = fixture.verify_usage_with_jobs(32).expect("maximum-shape replay");

		assert_eq!(usage.len(), 1_224);
		assert_eq!(fs::read_dir(&fixture.replay_root).expect("replay root").count(), 0);
	}
}

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt as _;
use std::{
	collections::{BTreeMap, BTreeSet},
	fs,
	path::{Path, PathBuf},
	str,
	sync::Mutex,
	thread,
};

use sha2::{Digest, Sha256};

use crate::{ArtifactResolverClient, ReasonCode, WorkerError};
use aiq_runner::{
	adapter::ArtifactReference,
	protocol,
	run_validation::{self, RunValidationError},
	runner::{
		self, CalibrationRunRecord, EvaluationOutcome, EvaluatorResultsBundle, FailureKind,
		ResultStatus, RunRecord, TaskResult, WorkspaceSnapshot,
	},
	submission::MAX_ARTIFACT_BYTES,
	task::{
		EvaluationResult, EvaluatorContext, EvaluatorOutcome, EvaluatorRuntime,
		NormalizedToolEvidence, TaskDefinition,
	},
};

/// Successful production replay scope recorded by the worker.
pub(crate) const PRODUCTION_REPLAY_SCOPE: &str = "candidate_reconstructed_and_evaluator_replayed";

pub(crate) trait ReplayRun: Sync {
	fn run_id(&self) -> &str;
	fn results(&self) -> &[TaskResult];
	fn evaluator_results_artifact(&self) -> &ArtifactReference;
	fn validate_evaluator_results(
		&self,
		bytes: &[u8],
	) -> Result<EvaluatorResultsBundle, RunValidationError>;
}

impl ReplayRun for RunRecord {
	fn run_id(&self) -> &str {
		&self.run_id
	}

	fn results(&self) -> &[TaskResult] {
		&self.results
	}

	fn evaluator_results_artifact(&self) -> &ArtifactReference {
		&self.evaluator_results_artifact
	}

	fn validate_evaluator_results(
		&self,
		bytes: &[u8],
	) -> Result<EvaluatorResultsBundle, RunValidationError> {
		run_validation::validate_evaluator_results_bundle(self, bytes)
	}
}

impl ReplayRun for CalibrationRunRecord {
	fn run_id(&self) -> &str {
		&self.run_id
	}

	fn results(&self) -> &[TaskResult] {
		&self.results
	}

	fn evaluator_results_artifact(&self) -> &ArtifactReference {
		&self.evaluator_results_artifact
	}

	fn validate_evaluator_results(
		&self,
		bytes: &[u8],
	) -> Result<EvaluatorResultsBundle, RunValidationError> {
		run_validation::validate_calibration_evaluator_results_bundle(self, bytes)
	}
}

/// Evidence produced by one complete deterministic replay.
///
/// The evaluator vector is aligned with the signed run results. Completed
/// results contain the independently recomputed evaluator result; all other
/// terminal states contain `None`.
#[cfg(test)]
pub(crate) struct ProductionReplayEvidence {
	pub provider_usage: Vec<aiq_runner::runner::ProviderTokenUsage>,
	pub evaluator_results: Vec<Option<EvaluationResult>>,
}

struct CandidateEvidence {
	manifest_reference: ArtifactReference,
	manifest_bytes: Vec<u8>,
	snapshot: WorkspaceSnapshot,
	artifacts: BTreeMap<String, Vec<u8>>,
}

struct ReplayDirectory {
	path: Option<PathBuf>,
}
impl ReplayDirectory {
	fn create(root: &Path, claim_identity: &str) -> Result<Self, WorkerError> {
		if claim_identity.is_empty()
			|| !claim_identity.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
		{
			return Err(WorkerError::configuration("claim replay identity is unsafe"));
		}

		let path = root.join(format!("claim-{claim_identity}"));

		if !path.starts_with(root) || fs::symlink_metadata(&path).is_ok() {
			return Err(WorkerError::transient("fresh claim replay directory is unavailable"));
		}

		fs::create_dir(&path)
			.map_err(|_| WorkerError::transient("cannot create claim replay directory"))?;

		let replay = Self { path: Some(path) };

		#[cfg(unix)]
		fs::set_permissions(replay.path()?, std::fs::Permissions::from_mode(0o700))
			.map_err(|_| WorkerError::transient("cannot restrict claim replay directory"))?;

		Ok(replay)
	}

	fn path(&self) -> Result<&Path, WorkerError> {
		self.path
			.as_deref()
			.ok_or_else(|| WorkerError::transient("claim replay directory is unavailable"))
	}

	fn cleanup(mut self) -> Result<(), WorkerError> {
		let Some(path) = self.path.take() else {
			return Ok(());
		};

		if fs::remove_dir_all(&path).is_err() {
			self.path = Some(path);

			return Err(WorkerError::transient("cannot clean claim replay directory"));
		}

		Ok(())
	}
}

impl Drop for ReplayDirectory {
	fn drop(&mut self) {
		if let Some(path) = self.path.take() {
			let _ = fs::remove_dir_all(path);
		}
	}
}

struct CandidateReplayOutput {
	provider_usage: runner::ProviderTokenUsage,
	evaluator_result: Option<EvaluationResult>,
}

struct ReplayScheduler {
	next_index: usize,
	failure: Option<(usize, WorkerError)>,
	outputs: Vec<Option<CandidateReplayOutput>>,
}
impl ReplayScheduler {
	fn new(result_count: usize) -> Self {
		Self { next_index: 0, failure: None, outputs: (0..result_count).map(|_| None).collect() }
	}
}

/// Reconstructs all attempted candidates and replays every completed evaluator result.
#[allow(clippy::too_many_arguments)]
pub(crate) fn verify_production_run<R, U>(
	run: &U,
	tasks: &[TaskDefinition],
	resolver: &R,
	evaluator_root: &Path,
	evaluator_runtime: &EvaluatorRuntime,
	replay_root: &Path,
	claim_identity: &str,
	replay_jobs: usize,
) -> Result<Vec<aiq_runner::runner::ProviderTokenUsage>, WorkerError>
where
	R: ArtifactResolverClient + ?Sized,
	U: ReplayRun + ?Sized,
{
	with_replay_directory(replay_root, claim_identity, |claim_root| {
		verify_production_run_in(
			run,
			tasks,
			resolver,
			evaluator_root,
			evaluator_runtime,
			claim_root,
			replay_jobs,
			|_, _| {},
		)
	})
}

/// Reconstructs candidates and returns every independently replayed evaluator result.
#[cfg(test)]
#[allow(clippy::too_many_arguments)]
pub(crate) fn replay_production_run<R, U>(
	run: &U,
	tasks: &[TaskDefinition],
	resolver: &R,
	evaluator_root: &Path,
	evaluator_runtime: &EvaluatorRuntime,
	replay_root: &Path,
	claim_identity: &str,
	replay_jobs: usize,
) -> Result<ProductionReplayEvidence, WorkerError>
where
	R: ArtifactResolverClient + ?Sized,
	U: ReplayRun + ?Sized,
{
	let mut evaluator_results = (0..run.results().len()).map(|_| None).collect::<Vec<_>>();
	let provider_usage = with_replay_directory(replay_root, claim_identity, |claim_root| {
		verify_production_run_in(
			run,
			tasks,
			resolver,
			evaluator_root,
			evaluator_runtime,
			claim_root,
			replay_jobs,
			|index, result| evaluator_results[index] = Some(result),
		)
	})?;

	Ok(ProductionReplayEvidence { provider_usage, evaluator_results })
}

fn with_replay_directory<T>(
	replay_root: &Path,
	claim_identity: &str,
	operation: impl FnOnce(&Path) -> Result<T, WorkerError>,
) -> Result<T, WorkerError> {
	let replay = ReplayDirectory::create(replay_root, claim_identity)?;
	let result = operation(replay.path()?);
	let cleanup = replay.cleanup();

	match (result, cleanup) {
		(Err(primary), _) => Err(primary),
		(Ok(_), Err(cleanup)) => Err(cleanup),
		(Ok(output), Ok(())) => Ok(output),
	}
}

#[allow(clippy::too_many_arguments)]
fn verify_production_run_in<R, U, F>(
	run: &U,
	tasks: &[TaskDefinition],
	resolver: &R,
	evaluator_root: &Path,
	evaluator_runtime: &EvaluatorRuntime,
	claim_root: &Path,
	replay_jobs: usize,
	mut record_evaluator_result: F,
) -> Result<Vec<aiq_runner::runner::ProviderTokenUsage>, WorkerError>
where
	R: ArtifactResolverClient + ?Sized,
	U: ReplayRun + ?Sized,
	F: FnMut(usize, EvaluationResult),
{
	if replay_jobs == 0 || replay_jobs > 32 {
		return Err(WorkerError::configuration("replay jobs must be between 1 and 32"));
	}

	let evaluator_results = resolve_evaluator_results(run, resolver)?;
	let task_map = controlled_task_map(tasks)?;
	let scheduler = Mutex::new(ReplayScheduler::new(run.results().len()));
	let worker_error = thread::scope(|scope| {
		let mut workers = Vec::with_capacity(replay_jobs.min(run.results().len()));

		for _ in 0..replay_jobs.min(run.results().len()) {
			workers.push(scope.spawn(|| -> Result<(), WorkerError> {
				loop {
					let index = {
						let mut scheduler = scheduler.lock().map_err(|_| {
							WorkerError::transient("replay scheduler is unavailable")
						})?;

						if scheduler.failure.is_some()
							|| scheduler.next_index >= run.results().len()
						{
							return Ok(());
						}

						let index = scheduler.next_index;

						scheduler.next_index += 1;

						index
					};
					let result = replay_candidate(
						index,
						run,
						&evaluator_results,
						&task_map,
						resolver,
						claim_root,
						evaluator_root,
						evaluator_runtime,
					);
					let mut scheduler = scheduler
						.lock()
						.map_err(|_| WorkerError::transient("replay scheduler is unavailable"))?;

					match result {
						Ok(output) => scheduler.outputs[index] = Some(output),
						Err(error) => {
							if scheduler.failure.as_ref().is_none_or(|(failed, _)| index < *failed)
							{
								scheduler.failure = Some((index, error));
							}
						},
					}
				}
			}));
		}

		let mut worker_error = None;

		for worker in workers {
			let result = worker.join().unwrap_or_else(|_| {
				Err(WorkerError::transient("candidate replay worker panicked"))
			});

			if let Err(error) = result
				&& worker_error.is_none()
			{
				worker_error = Some(error);
			}
		}

		worker_error
	});
	let mut scheduler = scheduler
		.into_inner()
		.map_err(|_| WorkerError::transient("replay scheduler is unavailable"))?;

	if let Some((_, error)) = scheduler.failure.take() {
		return Err(error);
	}
	if let Some(error) = worker_error {
		return Err(error);
	}

	let mut provider_usage = Vec::with_capacity(scheduler.outputs.len());

	for (index, output) in scheduler.outputs.into_iter().enumerate() {
		let output = output.ok_or_else(|| {
			WorkerError::transient("candidate replay stopped without a recorded failure")
		})?;

		provider_usage.push(output.provider_usage);

		if let Some(evaluator_result) = output.evaluator_result {
			record_evaluator_result(index, evaluator_result);
		}
	}

	resolver.maintain_lease()?;

	Ok(provider_usage)
}

#[allow(clippy::too_many_arguments)]
fn replay_candidate<R, U>(
	index: usize,
	run: &U,
	evaluator_results: &EvaluatorResultsBundle,
	task_map: &BTreeMap<(&str, &str), &TaskDefinition>,
	resolver: &R,
	claim_root: &Path,
	evaluator_root: &Path,
	evaluator_runtime: &EvaluatorRuntime,
) -> Result<CandidateReplayOutput, WorkerError>
where
	R: ArtifactResolverClient + ?Sized,
	U: ReplayRun + ?Sized,
{
	let result = &run.results()[index];

	if !execution_attempted(result) {
		if result.workspace_manifest.is_some() || !result.artifacts.is_empty() {
			return Err(WorkerError::terminal(
				ReasonCode::InvalidReplayEvidence,
				"unattempted result contains execution artifacts",
			));
		}

		return Ok(CandidateReplayOutput {
			provider_usage: runner::ProviderTokenUsage::default(),
			evaluator_result: None,
		});
	}

	let task = task_map.get(&(result.task_id.as_str(), result.task_version.as_str())).ok_or_else(
		|| {
			WorkerError::terminal(
				ReasonCode::InvalidReplayEvidence,
				"result does not bind a controlled task",
			)
		},
	)?;
	let workspace_integrity_without_snapshot = result
		.failure
		.as_ref()
		.is_some_and(|failure| failure.kind == FailureKind::WorkspaceIntegrity)
		&& result.workspace_manifest.is_none();

	if workspace_integrity_without_snapshot {
		verify_failed_result_policy(result)?;

		let tool_usage = verified_failed_tool_usage_without_workspace(result, resolver)?;

		resolver.maintain_lease()?;

		return Ok(CandidateReplayOutput {
			provider_usage: tool_usage.provider_tokens,
			evaluator_result: None,
		});
	}

	let destination = claim_root.join(format!("candidate-{index:04}"));
	let evidence = materialize_candidate(result, resolver, &destination)?;

	match result.status {
		ResultStatus::Completed => {
			let evaluator_result =
				evaluator_results.results.get(index).and_then(Option::as_ref).ok_or_else(|| {
					WorkerError::terminal(
						ReasonCode::InvalidReplayEvidence,
						"completed result lacks its signed evaluator-result entry",
					)
				})?;
			let response = complete_response(result, &evidence)?;
			let tool_usage = verified_tool_usage(result, &evidence)?;

			resolver.maintain_lease()?;

			let replayed = replay_evaluator(
				run.run_id(),
				result,
				task,
				&response,
				&tool_usage,
				&destination,
				evaluator_root,
				evaluator_runtime,
				evaluator_result,
			)?;

			resolver.maintain_lease()?;

			Ok(CandidateReplayOutput {
				provider_usage: tool_usage.provider_tokens,
				evaluator_result: Some(replayed),
			})
		},
		ResultStatus::Failed => {
			verify_failed_result_policy(result)?;

			let tool_usage = verified_failed_tool_usage(result, &evidence)?;

			resolver.maintain_lease()?;

			Ok(CandidateReplayOutput {
				provider_usage: tool_usage.provider_tokens,
				evaluator_result: None,
			})
		},
		ResultStatus::Unevaluated => Err(WorkerError::terminal(
			ReasonCode::EvaluatorReplayMismatch,
			"attempted result has no committed evaluator result",
		)),
		ResultStatus::Unsupported => Err(WorkerError::terminal(
			ReasonCode::InvalidReplayEvidence,
			"unsupported result cannot contain attempted candidate evidence",
		)),
	}
}

fn materialize_candidate<R>(
	result: &TaskResult,
	resolver: &R,
	destination: &Path,
) -> Result<CandidateEvidence, WorkerError>
where
	R: ArtifactResolverClient + ?Sized,
{
	let evidence = resolve_candidate_evidence(result, resolver)?;
	let materialized = evidence.snapshot.materialize_verified(destination).map_err(|_| {
		WorkerError::terminal(
			ReasonCode::InvalidReplayEvidence,
			"workspace snapshot could not be reconstructed safely",
		)
	})?;
	let materialized_hash = protocol::canonical_hash(&materialized).map_err(|_| {
		WorkerError::terminal(
			ReasonCode::InvalidReplayEvidence,
			"reconstructed workspace manifest could not be committed",
		)
	})?;
	let materialized_bytes = protocol::canonical_json(&materialized).map_err(|_| {
		WorkerError::terminal(
			ReasonCode::InvalidReplayEvidence,
			"reconstructed workspace manifest could not be serialized",
		)
	})?;

	if materialized_hash != evidence.manifest_reference.content_hash
		|| materialized_bytes != evidence.manifest_bytes
	{
		return Err(WorkerError::terminal(
			ReasonCode::ArtifactEvidenceMismatch,
			"reconstructed workspace differs from the signed manifest reference",
		));
	}

	Ok(evidence)
}

fn controlled_task_map(
	tasks: &[TaskDefinition],
) -> Result<BTreeMap<(&str, &str), &TaskDefinition>, WorkerError> {
	let task_map = tasks
		.iter()
		.map(|task| ((task.task_id.as_str(), task.task_version.as_str()), task))
		.collect::<BTreeMap<_, _>>();

	if task_map.len() != tasks.len() {
		return Err(WorkerError::terminal(
			ReasonCode::InvalidReplayEvidence,
			"controlled task sources contain duplicate identities",
		));
	}

	Ok(task_map)
}

fn resolve_evaluator_results<R, U>(
	run: &U,
	resolver: &R,
) -> Result<EvaluatorResultsBundle, WorkerError>
where
	R: ArtifactResolverClient + ?Sized,
	U: ReplayRun + ?Sized,
{
	let reference = run.evaluator_results_artifact();

	if reference.kind != "evaluator-results.json"
		|| reference.bytes == 0
		|| reference.bytes > aiq_runner::runner::MAX_EVALUATOR_RESULTS_BUNDLE_BYTES as u64
	{
		return Err(WorkerError::terminal(
			ReasonCode::ArtifactEvidenceMismatch,
			"evaluator-results reference is not a bounded canonical content address",
		));
	}

	let bytes = resolve_exact(reference, resolver)?;

	if bytes.len() > aiq_runner::runner::MAX_EVALUATOR_RESULTS_BUNDLE_BYTES {
		return Err(WorkerError::terminal(
			ReasonCode::ArtifactEvidenceMismatch,
			"resolved evaluator-results bundle exceeds its signed size bound",
		));
	}

	let bundle = run.validate_evaluator_results(&bytes).map_err(|_| {
		WorkerError::terminal(
			ReasonCode::InvalidReplayEvidence,
			"evaluator-results bundle is malformed, noncanonical, or misaligned",
		)
	})?;

	if protocol::canonical_json(&bundle).ok().as_deref() != Some(bytes.as_slice()) {
		return Err(WorkerError::terminal(
			ReasonCode::InvalidReplayEvidence,
			"evaluator-results bundle is not canonical JSON",
		));
	}

	resolver.maintain_lease()?;

	Ok(bundle)
}

fn resolve_candidate_evidence<R>(
	result: &TaskResult,
	resolver: &R,
) -> Result<CandidateEvidence, WorkerError>
where
	R: ArtifactResolverClient + ?Sized,
{
	let manifest = result.workspace_manifest.as_ref().ok_or_else(|| {
		WorkerError::terminal(
			ReasonCode::InvalidReplayEvidence,
			"attempted result lacks its workspace manifest",
		)
	})?;

	if manifest.kind != "workspace-manifest.json"
		|| result.artifacts.iter().any(|artifact| {
			matches!(artifact.kind.as_str(), "workspace-manifest.json" | "evaluator-results.json")
		}) {
		return Err(WorkerError::terminal(
			ReasonCode::InvalidReplayEvidence,
			"run-level or workspace-manifest evidence is duplicated or misplaced",
		));
	}

	let mut kinds = BTreeSet::new();

	if result.artifacts.iter().any(|artifact| !kinds.insert(artifact.kind.as_str())) {
		return Err(WorkerError::terminal(
			ReasonCode::InvalidReplayEvidence,
			"result contains duplicate artifact kinds",
		));
	}

	let snapshots = result
		.artifacts
		.iter()
		.filter(|artifact| artifact.kind == "workspace-snapshot.json")
		.collect::<Vec<_>>();
	let [snapshot_reference] = snapshots.as_slice() else {
		return Err(WorkerError::terminal(
			ReasonCode::InvalidReplayEvidence,
			"attempted result requires exactly one workspace snapshot",
		));
	};
	let manifest_bytes = resolve_exact(manifest, resolver)?;
	let mut artifacts = BTreeMap::new();

	for artifact in &result.artifacts {
		artifacts.insert(artifact.kind.clone(), resolve_exact(artifact, resolver)?);
	}

	let snapshot_bytes = artifacts.get(&snapshot_reference.kind).ok_or_else(|| {
		WorkerError::terminal(
			ReasonCode::ArtifactEvidenceUnavailable,
			"resolved workspace snapshot is unavailable",
		)
	})?;
	let snapshot: WorkspaceSnapshot = serde_json::from_slice(snapshot_bytes).map_err(|_| {
		WorkerError::terminal(
			ReasonCode::InvalidReplayEvidence,
			"workspace snapshot is not strict versioned JSON",
		)
	})?;

	if protocol::canonical_json(&snapshot).ok().as_deref() != Some(snapshot_bytes.as_slice()) {
		return Err(WorkerError::terminal(
			ReasonCode::InvalidReplayEvidence,
			"workspace snapshot is not canonical JSON",
		));
	}
	if snapshot.manifest_sha256 != manifest.content_hash {
		return Err(WorkerError::terminal(
			ReasonCode::ArtifactEvidenceMismatch,
			"workspace snapshot does not bind the signed manifest reference",
		));
	}

	Ok(CandidateEvidence {
		manifest_reference: manifest.clone(),
		manifest_bytes,
		snapshot,
		artifacts,
	})
}

fn verified_tool_usage(
	result: &TaskResult,
	evidence: &CandidateEvidence,
) -> Result<aiq_runner::runner::ToolUsage, WorkerError> {
	let stdout = evidence.artifacts.get("stdout.jsonl").ok_or_else(|| {
		WorkerError::terminal(
			ReasonCode::InvalidReplayEvidence,
			"completed result lacks its content-addressed stdout",
		)
	})?;
	let stdout = str::from_utf8(stdout).map_err(|_| {
		WorkerError::terminal(
			ReasonCode::InvalidReplayEvidence,
			"content-addressed stdout is not UTF-8",
		)
	})?;
	let observed = runner::parse_codex_tool_usage(stdout);

	if observed.steps != result.tool_usage.steps
		|| observed.total_calls != result.tool_usage.total_calls
		|| observed.by_tool != result.tool_usage.by_tool
	{
		return Err(WorkerError::terminal(
			ReasonCode::ArtifactEvidenceMismatch,
			"signed tool-use counters differ from content-addressed stdout",
		));
	}

	Ok(observed)
}

fn verified_failed_tool_usage(
	result: &TaskResult,
	evidence: &CandidateEvidence,
) -> Result<aiq_runner::runner::ToolUsage, WorkerError> {
	if evidence.artifacts.contains_key("stdout.jsonl") {
		return verified_tool_usage(result, evidence);
	}
	if result.tool_usage != aiq_runner::runner::ToolUsage::default() {
		return Err(WorkerError::terminal(
			ReasonCode::ArtifactEvidenceMismatch,
			"failed result signs tool-use counters without content-addressed stdout",
		));
	}

	Ok(aiq_runner::runner::ToolUsage::default())
}

fn verified_failed_tool_usage_without_workspace<R>(
	result: &TaskResult,
	resolver: &R,
) -> Result<aiq_runner::runner::ToolUsage, WorkerError>
where
	R: ArtifactResolverClient + ?Sized,
{
	let mut stdout = None;

	for artifact in &result.artifacts {
		let bytes = resolve_exact(artifact, resolver)?;

		if artifact.kind == "workspace-snapshot.json" {
			return Err(WorkerError::terminal(
				ReasonCode::InvalidReplayEvidence,
				"workspace-integrity result has a snapshot without a manifest",
			));
		}
		if artifact.kind == "stdout.jsonl" {
			stdout = Some(bytes);
		}
	}

	let Some(stdout) = stdout else {
		if result.tool_usage != aiq_runner::runner::ToolUsage::default() {
			return Err(WorkerError::terminal(
				ReasonCode::ArtifactEvidenceMismatch,
				"workspace-integrity result signs counters without stdout evidence",
			));
		}

		return Ok(aiq_runner::runner::ToolUsage::default());
	};
	let stdout = str::from_utf8(&stdout).map_err(|_| {
		WorkerError::terminal(
			ReasonCode::InvalidReplayEvidence,
			"content-addressed stdout is not UTF-8",
		)
	})?;
	let observed = runner::parse_codex_tool_usage(stdout);

	if observed.steps != result.tool_usage.steps
		|| observed.total_calls != result.tool_usage.total_calls
		|| observed.by_tool != result.tool_usage.by_tool
	{
		return Err(WorkerError::terminal(
			ReasonCode::ArtifactEvidenceMismatch,
			"workspace-integrity counters differ from content-addressed stdout",
		));
	}

	Ok(observed)
}

fn complete_response(
	result: &TaskResult,
	evidence: &CandidateEvidence,
) -> Result<String, WorkerError> {
	let response = result.response.as_deref().ok_or_else(|| {
		WorkerError::terminal(
			ReasonCode::EvaluatorReplayMismatch,
			"completed result lacks a response",
		)
	})?;
	let expected_hash = result.response_sha256.as_deref().ok_or_else(|| {
		WorkerError::terminal(
			ReasonCode::EvaluatorReplayMismatch,
			"completed result lacks a response commitment",
		)
	})?;
	let inline_hash = format!("sha256:{}", hex::encode(Sha256::digest(response.as_bytes())));
	let final_artifacts = result
		.artifacts
		.iter()
		.filter(|artifact| artifact.kind == "final-response.txt")
		.collect::<Vec<_>>();

	if inline_hash == expected_hash {
		if !final_artifacts.is_empty() {
			return Err(WorkerError::terminal(
				ReasonCode::InvalidReplayEvidence,
				"complete inline response has a duplicate final-response artifact",
			));
		}

		return Ok(response.to_owned());
	}

	let [reference] = final_artifacts.as_slice() else {
		return Err(WorkerError::terminal(
			ReasonCode::InvalidReplayEvidence,
			"truncated inline response requires exactly one final-response artifact",
		));
	};

	if reference.content_hash != expected_hash {
		return Err(WorkerError::terminal(
			ReasonCode::ArtifactEvidenceMismatch,
			"final-response artifact does not match the signed response commitment",
		));
	}

	let bytes = evidence.artifacts.get(&reference.kind).cloned().ok_or_else(|| {
		WorkerError::terminal(
			ReasonCode::ArtifactEvidenceUnavailable,
			"resolved final response is unavailable",
		)
	})?;

	String::from_utf8(bytes).map_err(|_| {
		WorkerError::terminal(
			ReasonCode::InvalidReplayEvidence,
			"complete final response is not UTF-8",
		)
	})
}

#[allow(clippy::too_many_arguments)]
fn replay_evaluator(
	run_id: &str,
	result: &TaskResult,
	task: &TaskDefinition,
	response: &str,
	tool_usage: &aiq_runner::runner::ToolUsage,
	candidate_workspace: &Path,
	evaluator_root: &Path,
	evaluator_runtime: &EvaluatorRuntime,
	expected: &EvaluationResult,
) -> Result<EvaluationResult, WorkerError> {
	let evaluator = task.evaluator.as_ref().ok_or_else(|| {
		WorkerError::terminal(
			ReasonCode::EvaluatorReplayMismatch,
			"completed result has no committed evaluator",
		)
	})?;
	let manifest = result.workspace_manifest.as_ref().ok_or_else(|| {
		WorkerError::terminal(
			ReasonCode::InvalidReplayEvidence,
			"completed result lacks its workspace manifest",
		)
	})?;
	let tool_evidence = NormalizedToolEvidence {
		steps: tool_usage.steps,
		total_calls: tool_usage.total_calls,
		by_tool: tool_usage.by_tool.clone(),
	};
	let context = EvaluatorContext {
		task_id: &result.task_id,
		task_version: &result.task_version,
		run_id,
		model: result.model,
		final_response: response,
		candidate_workspace,
		workspace_manifest_sha256: &manifest.content_hash,
		tool_evidence: &tool_evidence,
	};
	let (mut replayed, replayed_raw_stdout_sha256) = if evaluator.kind == "exact_match" {
		(
			evaluator.evaluate_checked(response, Some(&context)).map_err(|_| {
				WorkerError::terminal(
					ReasonCode::EvaluatorReplayMismatch,
					"controlled evaluator replay failed or was nondeterministic",
				)
			})?,
			None,
		)
	} else {
		let observation = evaluator
			.evaluate_checked_observation_at_root(
				response,
				Some(&context),
				evaluator_root,
				evaluator_runtime,
			)
			.map_err(|_| {
				WorkerError::terminal(
					ReasonCode::EvaluatorReplayMismatch,
					"controlled evaluator replay failed or was nondeterministic",
				)
			})?;

		(observation.result, Some(observation.raw_stdout_sha256))
	};
	let external = evaluator.external.is_some();

	if external == (evaluator.kind == "exact_match") {
		return Err(WorkerError::terminal(
			ReasonCode::EvaluatorReplayMismatch,
			"evaluator kind and controlled executable binding are inconsistent",
		));
	}

	replayed.raw_stdout_sha256 = replayed_raw_stdout_sha256;

	let raw_stdout_is_consistent = if external {
		result.evaluator_stdout_sha256.is_some()
			&& result.evaluator_stdout_sha256 == replayed.raw_stdout_sha256
			&& result.evaluator_stdout_sha256 == expected.raw_stdout_sha256
	} else {
		result.evaluator_stdout_sha256.is_none()
			&& replayed.raw_stdout_sha256.is_none()
			&& expected.raw_stdout_sha256.is_none()
	};

	if !raw_stdout_is_consistent {
		return Err(WorkerError::terminal(
			ReasonCode::EvaluatorReplayMismatch,
			"raw evaluator stdout evidence differs across replay and signed commitments",
		));
	}

	let expected_outcome = match result.evaluation {
		EvaluationOutcome::Correct => EvaluatorOutcome::Correct,
		EvaluationOutcome::Partial => EvaluatorOutcome::Partial,
		EvaluationOutcome::Incorrect => EvaluatorOutcome::Incorrect,
		EvaluationOutcome::NotEvaluated => {
			return Err(WorkerError::terminal(
				ReasonCode::EvaluatorReplayMismatch,
				"completed result has no signed evaluator outcome",
			));
		},
	};
	let expected_score = result.task_score.ok_or_else(|| {
		WorkerError::terminal(
			ReasonCode::EvaluatorReplayMismatch,
			"completed result has no signed evaluator score",
		)
	})?;

	if expected.outcome != expected_outcome || expected.score != expected_score {
		return Err(WorkerError::terminal(
			ReasonCode::EvaluatorReplayMismatch,
			"signed evaluator result differs from the signed outcome or score",
		));
	}
	if replayed != *expected {
		return Err(WorkerError::terminal(
			ReasonCode::EvaluatorReplayMismatch,
			"evaluator outcome, score, checks, or evidence digests differ from the signed result",
		));
	}

	Ok(replayed)
}

fn verify_failed_result_policy(result: &TaskResult) -> Result<(), WorkerError> {
	let failure = result.failure.as_ref().ok_or_else(|| {
		WorkerError::terminal(
			ReasonCode::InvalidReplayEvidence,
			"failed result lacks a failure taxonomy",
		)
	})?;

	if failure.kind == FailureKind::EvaluatorFailure {
		return Err(WorkerError::terminal(
			ReasonCode::EvaluatorReplayMismatch,
			"signed result records an evaluator failure instead of a committed outcome",
		));
	}
	if result.evaluation != EvaluationOutcome::NotEvaluated
		|| result.evaluator_result_sha256.is_some()
		|| result.response_sha256.is_some()
	{
		return Err(WorkerError::terminal(
			ReasonCode::InvalidReplayEvidence,
			"failed model-generation result has inconsistent evaluation fields",
		));
	}

	let expected_score = match failure.kind {
		FailureKind::Timeout
		| FailureKind::UnsupportedModel
		| FailureKind::NonZeroExit
		| FailureKind::MissingResponse
		| FailureKind::BudgetExceeded
		| FailureKind::OutputTruncated => Some(0.0),
		FailureKind::Spawn
		| FailureKind::Authentication
		| FailureKind::SubscriptionLimit
		| FailureKind::EvaluatorFailure
		| FailureKind::WorkspaceIntegrity => None,
		FailureKind::CapabilityUnavailable
		| FailureKind::CapabilityValidationFailed
		| FailureKind::MissingEvaluator
		| FailureKind::WorkspaceUnavailable => {
			return Err(WorkerError::terminal(
				ReasonCode::InvalidReplayEvidence,
				"attempted result uses an incompatible failure taxonomy",
			));
		},
	};

	if result.task_score != expected_score || result.response.is_some() {
		return Err(WorkerError::terminal(
			ReasonCode::InvalidReplayEvidence,
			"failed model-generation result does not match its failure taxonomy",
		));
	}

	Ok(())
}

fn resolve_exact<R>(reference: &ArtifactReference, resolver: &R) -> Result<Vec<u8>, WorkerError>
where
	R: ArtifactResolverClient + ?Sized,
{
	let digest = reference.content_hash.strip_prefix("sha256:").ok_or_else(|| {
		WorkerError::terminal(
			ReasonCode::ArtifactEvidenceMismatch,
			"artifact content hash is invalid",
		)
	})?;

	if digest.len() != 64
		|| !digest.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
		|| !matches!(
			reference.kind.as_str(),
			"evaluator-results.json"
				| "stdout.jsonl"
				| "stderr.txt"
				| "final-response.txt"
				| "workspace-manifest.json"
				| "workspace-snapshot.json"
		) || reference.uri != format!("aiq-artifact://sha256/{digest}/{}", reference.kind)
		|| reference.bytes == 0
		|| reference.bytes > MAX_ARTIFACT_BYTES as u64
	{
		return Err(WorkerError::terminal(
			ReasonCode::ArtifactEvidenceMismatch,
			"artifact reference is not a bounded canonical content address",
		));
	}

	let bytes = resolver.resolve(digest, &reference.kind, reference.bytes)?;

	if bytes.len() > MAX_ARTIFACT_BYTES
		|| u64::try_from(bytes.len()).ok() != Some(reference.bytes)
		|| format!("sha256:{}", hex::encode(Sha256::digest(&bytes))) != reference.content_hash
	{
		return Err(WorkerError::terminal(
			ReasonCode::ArtifactEvidenceMismatch,
			"resolved artifact bytes differ from the signed content address",
		));
	}

	Ok(bytes)
}

fn execution_attempted(result: &TaskResult) -> bool {
	!matches!(
		result.failure.as_ref().map(|failure| failure.kind),
		Some(
			FailureKind::CapabilityUnavailable
				| FailureKind::CapabilityValidationFailed
				| FailureKind::WorkspaceUnavailable
		)
	)
}
