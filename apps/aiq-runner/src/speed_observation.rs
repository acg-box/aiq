//! Auxiliary Normal/Fast subscription observations that never affect AIQ scoring.

use std::error::Error;
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};
use std::{
	collections::{BTreeMap, BTreeSet},
	fmt::{Display, Formatter},
	fs::{self, OpenOptions, Permissions},
	io::Write as _,
	path::{Path, PathBuf},
	sync::{
		atomic::{AtomicUsize, Ordering},
		mpsc,
	},
	thread,
	time::Instant,
};

use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

use crate::adapter::CodexOutput;
use crate::{
	adapter::{
		self, AdapterFailure, ArtifactReference, CodexAdapter, CodexExecutionConfig,
		CodexServiceTier, InvocationRequest, LocalArtifactSink, SandboxPolicy, SystemExecutor,
	},
	corpus_commitment::{self, ValidatedModelToolchain},
	model::{MODEL_MATRIX, ModelConfig, ModelFamily},
	protocol,
	runner::{self, ProviderTokenUsage, ToolUsage},
};

/// Current auxiliary observation schema.
pub const SPEED_OBSERVATION_SCHEMA_VERSION: &str = "aiq.speed-observation-batch.v1";
/// ChatGPT Codex subscription credit rate card used for estimates.
pub const CODEX_CREDIT_RATE_CARD_VERSION: &str = "openai-codex-rate-card-2026-08-10";

const MAX_TRIALS_PER_MODE: u8 = 10;
const MAX_OBSERVATION_JOBS: usize = 17;
const FIXED_OUTPUT_END: u16 = 400;

/// Complete inputs for one resumable auxiliary observation batch.
#[derive(Clone)]
pub struct SpeedObservationOptions {
	/// Exact selected matrix entries.
	pub models: Vec<ModelConfig>,
	/// Canonical `unix-ms:<milliseconds>` observation identity.
	pub observed_at: String,
	/// Repeated trials for each transport and model configuration.
	pub trials_per_mode: u8,
	/// Maximum concurrently observed model configurations.
	pub jobs: usize,
	/// Exact controlled Codex executable.
	pub codex_binary: String,
	/// Isolated ChatGPT subscription home.
	pub codex_home: PathBuf,
	/// Private, resumable model workspace root for this batch.
	pub workspace_root: PathBuf,
	/// Private create-once trial checkpoint root for this batch.
	pub checkpoint_root: PathBuf,
	/// Private content-addressed raw artifact root.
	pub artifact_root: PathBuf,
	/// Corpus-bound Node.js and ripgrep toolchain.
	pub model_toolchain: ValidatedModelToolchain,
}

/// Normal or Fast ChatGPT subscription transport.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SpeedMode {
	/// Normal subscription transport.
	Normal,
	/// Fast subscription transport.
	Fast,
}
impl SpeedMode {
	const fn credit_multiplier_basis_points(self) -> u64 {
		match self {
			Self::Normal => 10_000,
			Self::Fast => 25_000,
		}
	}
}

/// Model-catalog availability of one exact transport and reasoning configuration.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SpeedCapabilityStatus {
	/// The live Codex catalog advertises this exact combination.
	Available,
	/// The live catalog explicitly omits this combination.
	Unsupported,
	/// A live catalog could not establish support.
	Unavailable,
}

/// Result status for one paid auxiliary trial.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SpeedTrialStatus {
	/// The exact requested response completed.
	Completed,
	/// Codex completed, but the response did not match the measurement sentinel.
	InvalidResponse,
	/// Codex did not complete successfully.
	Failed,
}

/// Status of one model-free catalog probe.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CatalogProbeStatus {
	/// The live catalog was read and parsed.
	Available,
	/// The live catalog could not be established.
	Unavailable,
}

/// Public-safe evidence from the model-free live Codex catalog.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SpeedCatalogEvidence {
	/// Probe result.
	pub status: CatalogProbeStatus,
	/// Exact safe Codex version when available.
	pub codex_version: Option<String>,
	/// SHA-256 of the complete bounded catalog response when available.
	pub catalog_sha256: Option<String>,
	/// Stable public-safe explanation when unavailable.
	pub unavailable_reason: Option<String>,
}

/// Live capability state for one exact model, effort, and transport.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SpeedCapabilityObservation {
	/// Exact matrix configuration.
	pub model: ModelConfig,
	/// Subscription transport.
	pub mode: SpeedMode,
	/// Catalog-derived status.
	pub status: SpeedCapabilityStatus,
	/// Stable public-safe reason.
	pub reason: String,
}

/// Measurement fields that the current Codex JSONL transport does not expose.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct UnavailableMetric {
	/// Stable metric name.
	pub metric: String,
	/// Why no value can be reported without guessing.
	pub reason: String,
}

/// Public-safe failure for one trial.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SpeedTrialFailure {
	/// Stable adapter failure kind.
	pub kind: String,
	/// Bounded diagnostic message.
	pub message: String,
	/// Process exit code when observed.
	pub exit_code: Option<i32>,
}

/// One paid, non-scoring Normal or Fast trial.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SpeedTrial {
	/// Content-addressed trial identity.
	pub trial_id: String,
	/// Canonical observation identity inherited from the batch.
	pub observed_at: String,
	/// Exact matrix configuration.
	pub model: ModelConfig,
	/// Subscription transport.
	pub mode: SpeedMode,
	/// Zero-based trial number within this model and transport.
	pub trial_index: u8,
	/// Terminal trial state.
	pub status: SpeedTrialStatus,
	/// Runner-observed end-to-end elapsed milliseconds.
	pub elapsed_ms: u64,
	/// First-token latency. It remains null until Codex exposes an event timestamp.
	pub ttft_ms: Option<u64>,
	/// Output throughput after the first token. It remains null for the same reason.
	pub post_first_token_output_tps_millis: Option<u64>,
	/// Output tokens per second over the full invocation, in thousandths.
	pub aggregate_output_tps_millis: Option<u64>,
	/// Provider token counters from `turn.completed`.
	pub tokens: ProviderTokenUsage,
	/// Exact observed item and tool accounting.
	pub tool_usage: ToolUsage,
	/// Estimated ChatGPT Codex subscription credits, in billionths of one credit.
	pub estimated_credits_nanos: Option<u64>,
	/// Digest of the final response when one was observed.
	pub response_sha256: Option<String>,
	/// Raw content-addressed execution evidence.
	pub artifacts: Vec<ArtifactReference>,
	/// Structured terminal failure, if any.
	pub failure: Option<SpeedTrialFailure>,
}

/// One complete auxiliary observation batch. None of these values enter AIQ scoring.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SpeedObservationBatch {
	/// Observation schema.
	pub schema_version: String,
	/// Content-addressed batch identifier.
	pub batch_id: String,
	/// Exact scheduled observation identity.
	pub observed_at: String,
	/// Number of requested trials for each available model and transport.
	pub trials_per_mode: u8,
	/// Fixed prompt digest.
	pub prompt_sha256: String,
	/// Exact final runner executable digest.
	pub runner_executable_sha256: String,
	/// Exact Codex executable digest.
	pub codex_executable_sha256: String,
	/// Exact sibling Codex code-mode host digest.
	pub codex_code_mode_host_sha256: String,
	/// Rate card identity for credit estimates.
	pub credit_rate_card_version: String,
	/// Live model-free catalog evidence.
	pub catalog: SpeedCatalogEvidence,
	/// Structured unsupported or unavailable combinations.
	pub capabilities: Vec<SpeedCapabilityObservation>,
	/// Metrics deliberately left null instead of inferred.
	pub unavailable_metrics: Vec<UnavailableMetric>,
	/// Paid observations, in matrix, trial, and interleaved transport order.
	pub trials: Vec<SpeedTrial>,
	/// SHA-256 over every preceding field except this digest and `batch_id`.
	pub content_sha256: String,
}

/// Bounded auxiliary observation error.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SpeedObservationError {
	message: String,
}
impl SpeedObservationError {
	fn new(message: impl Into<String>) -> Self {
		Self { message: message.into() }
	}
}
impl Display for SpeedObservationError {
	fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
		formatter.write_str(&self.message)
	}
}
impl Error for SpeedObservationError {}

#[derive(Deserialize)]
struct LiveCatalog {
	models: Vec<LiveCatalogModel>,
}

#[derive(Deserialize)]
struct LiveCatalogModel {
	slug: String,
	#[serde(default)]
	supported_reasoning_levels: Vec<LiveReasoningLevel>,
	#[serde(default)]
	additional_speed_tiers: Vec<String>,
}

#[derive(Deserialize)]
struct LiveReasoningLevel {
	effort: String,
}

struct CatalogObservation {
	evidence: SpeedCatalogEvidence,
	capabilities: Vec<SpeedCapabilityObservation>,
}

struct TrialContext<'a> {
	options: &'a SpeedObservationOptions,
	sink: &'a LocalArtifactSink,
	workspace_root: &'a Path,
	checkpoint_root: &'a Path,
	execution_identity: &'a str,
	prompt: &'a str,
	expected_response: &'a str,
}

#[derive(Serialize)]
struct BatchIdentity<'a> {
	schema_version: &'a str,
	observed_at: &'a str,
	trials_per_mode: u8,
	prompt_sha256: &'a str,
	runner_executable_sha256: &'a str,
	codex_executable_sha256: &'a str,
	codex_code_mode_host_sha256: &'a str,
	credit_rate_card_version: &'a str,
	catalog: &'a SpeedCatalogEvidence,
	capabilities: &'a [SpeedCapabilityObservation],
	unavailable_metrics: &'a [UnavailableMetric],
	trials: &'a [SpeedTrial],
}

/// Runs one resumable auxiliary Normal/Fast observation batch.
pub fn observe_speed(
	options: &SpeedObservationOptions,
) -> Result<SpeedObservationBatch, SpeedObservationError> {
	validate_options(options)?;

	let workspace_root = prepare_private_root(&options.workspace_root, "speed workspace root")?;
	let checkpoint_root = prepare_private_root(&options.checkpoint_root, "speed checkpoint root")?;
	let sink = LocalArtifactSink::new(&options.artifact_root)
		.map_err(|error| SpeedObservationError::new(error.to_string()))?;
	let prompt = speed_prompt();
	let expected_response = expected_speed_response();
	let prompt_sha256 = raw_sha256(prompt.as_bytes());
	let runner_digest = corpus_commitment::runner_executable_digest()
		.map_err(|error| SpeedObservationError::new(error.to_string()))?;
	let codex_digest = corpus_commitment::codex_executable_digest(&options.codex_binary)
		.map_err(|error| SpeedObservationError::new(error.to_string()))?;
	let host_digest = corpus_commitment::codex_code_mode_host_digest(&options.codex_binary)
		.map_err(|error| SpeedObservationError::new(error.to_string()))?;
	let catalog = observe_catalog(options, &sink);
	let execution_identity = protocol::canonical_hash(&(
		&options.observed_at,
		&prompt_sha256,
		&runner_digest,
		&codex_digest,
		&host_digest,
		&catalog.evidence,
	))
	.map_err(|error| SpeedObservationError::new(error.to_string()))?;
	let trials = run_trials(
		options,
		&catalog.capabilities,
		TrialContext {
			options,
			sink: &sink,
			workspace_root: &workspace_root,
			checkpoint_root: &checkpoint_root,
			execution_identity: &execution_identity,
			prompt: &prompt,
			expected_response: &expected_response,
		},
	)?;
	let unavailable_metrics = unavailable_metrics();
	let identity = BatchIdentity {
		schema_version: SPEED_OBSERVATION_SCHEMA_VERSION,
		observed_at: &options.observed_at,
		trials_per_mode: options.trials_per_mode,
		prompt_sha256: &prompt_sha256,
		runner_executable_sha256: &runner_digest,
		codex_executable_sha256: &codex_digest,
		codex_code_mode_host_sha256: &host_digest,
		credit_rate_card_version: CODEX_CREDIT_RATE_CARD_VERSION,
		catalog: &catalog.evidence,
		capabilities: &catalog.capabilities,
		unavailable_metrics: &unavailable_metrics,
		trials: &trials,
	};
	let content_sha256 = protocol::canonical_hash(&identity)
		.map_err(|error| SpeedObservationError::new(error.to_string()))?;
	let batch_id = format!("speed_{}", content_sha256.trim_start_matches("sha256:"));
	let batch = SpeedObservationBatch {
		schema_version: SPEED_OBSERVATION_SCHEMA_VERSION.to_owned(),
		batch_id,
		observed_at: options.observed_at.clone(),
		trials_per_mode: options.trials_per_mode,
		prompt_sha256,
		runner_executable_sha256: runner_digest,
		codex_executable_sha256: codex_digest,
		codex_code_mode_host_sha256: host_digest,
		credit_rate_card_version: CODEX_CREDIT_RATE_CARD_VERSION.to_owned(),
		catalog: catalog.evidence,
		capabilities: catalog.capabilities,
		unavailable_metrics,
		trials,
		content_sha256,
	};

	validate_speed_observation_batch(&batch)?;

	Ok(batch)
}

/// Revalidates one persisted auxiliary observation without invoking a model.
pub fn validate_speed_observation_batch(
	batch: &SpeedObservationBatch,
) -> Result<(), SpeedObservationError> {
	if batch.schema_version != SPEED_OBSERVATION_SCHEMA_VERSION
		|| batch.credit_rate_card_version != CODEX_CREDIT_RATE_CARD_VERSION
		|| batch.trials_per_mode == 0
		|| batch.trials_per_mode > MAX_TRIALS_PER_MODE
		|| !valid_sha256(&batch.prompt_sha256)
		|| !valid_nonzero_sha256(&batch.runner_executable_sha256)
		|| !valid_nonzero_sha256(&batch.codex_executable_sha256)
		|| !valid_nonzero_sha256(&batch.codex_code_mode_host_sha256)
		|| batch.unavailable_metrics != unavailable_metrics()
	{
		return Err(SpeedObservationError::new("speed observation batch metadata is invalid"));
	}

	validate_catalog_and_capabilities(batch)?;
	validate_trials(batch)?;

	let identity = BatchIdentity {
		schema_version: &batch.schema_version,
		observed_at: &batch.observed_at,
		trials_per_mode: batch.trials_per_mode,
		prompt_sha256: &batch.prompt_sha256,
		runner_executable_sha256: &batch.runner_executable_sha256,
		codex_executable_sha256: &batch.codex_executable_sha256,
		codex_code_mode_host_sha256: &batch.codex_code_mode_host_sha256,
		credit_rate_card_version: &batch.credit_rate_card_version,
		catalog: &batch.catalog,
		capabilities: &batch.capabilities,
		unavailable_metrics: &batch.unavailable_metrics,
		trials: &batch.trials,
	};
	let expected = protocol::canonical_hash(&identity)
		.map_err(|error| SpeedObservationError::new(error.to_string()))?;
	let expected_id = format!("speed_{}", expected.trim_start_matches("sha256:"));

	if batch.content_sha256 != expected || batch.batch_id != expected_id {
		return Err(SpeedObservationError::new("speed observation content identity mismatch"));
	}

	Ok(())
}

fn validate_catalog_and_capabilities(
	batch: &SpeedObservationBatch,
) -> Result<(), SpeedObservationError> {
	match batch.catalog.status {
		CatalogProbeStatus::Available
			if batch.catalog.codex_version.as_deref().is_some_and(|value| !value.is_empty())
				&& batch.catalog.catalog_sha256.as_deref().is_some_and(valid_sha256)
				&& batch.catalog.unavailable_reason.is_none() => {},
		CatalogProbeStatus::Unavailable
			if batch.catalog.codex_version.is_none()
				&& batch.catalog.catalog_sha256.is_none()
				&& batch
					.catalog
					.unavailable_reason
					.as_deref()
					.is_some_and(|value| !value.is_empty()) => {},
		_ => return Err(SpeedObservationError::new("speed catalog evidence is invalid")),
	}

	let mut identities = BTreeSet::new();

	for capability in &batch.capabilities {
		if !MODEL_MATRIX.contains(&capability.model)
			|| capability.reason.is_empty()
			|| !identities.insert((capability.model, capability.mode))
		{
			return Err(SpeedObservationError::new("speed capability matrix is invalid"));
		}
		if batch.catalog.status == CatalogProbeStatus::Unavailable
			&& capability.status != SpeedCapabilityStatus::Unavailable
		{
			return Err(SpeedObservationError::new("unavailable catalog advertised a capability"));
		}
	}

	let models = batch.capabilities.iter().map(|entry| entry.model).collect::<BTreeSet<_>>();
	let expected = models
		.iter()
		.copied()
		.flat_map(|model| {
			[SpeedMode::Normal, SpeedMode::Fast].into_iter().map(move |mode| (model, mode))
		})
		.collect::<BTreeSet<_>>();

	if models.is_empty() || identities != expected {
		return Err(SpeedObservationError::new("speed capability matrix is incomplete"));
	}

	Ok(())
}

fn validate_trials(batch: &SpeedObservationBatch) -> Result<(), SpeedObservationError> {
	let available = batch
		.capabilities
		.iter()
		.filter(|entry| entry.status == SpeedCapabilityStatus::Available)
		.map(|entry| (entry.model, entry.mode))
		.collect::<BTreeSet<_>>();
	let expected_response_sha256 = raw_sha256(expected_speed_response().as_bytes());
	let mut identities = BTreeSet::new();
	let mut counts = BTreeMap::new();

	for trial in &batch.trials {
		if trial.observed_at != batch.observed_at
			|| !available.contains(&(trial.model, trial.mode))
			|| trial.trial_index >= batch.trials_per_mode
			|| !valid_trial_id(&trial.trial_id)
			|| !identities.insert(trial.trial_id.clone())
			|| trial.ttft_ms.is_some()
			|| trial.post_first_token_output_tps_millis.is_some()
			|| trial.tool_usage.total_calls != 0
			|| !trial.tool_usage.by_tool.is_empty()
			|| !trial.tool_usage.completed_command_sha256.is_empty()
			|| trial.artifacts.len() > 2
			|| trial.artifacts.iter().any(|artifact| {
				!matches!(artifact.kind.as_str(), "stdout.jsonl" | "stderr.txt")
					|| !valid_sha256(&artifact.content_hash)
					|| artifact.bytes == 0
					|| artifact.uri
						!= format!(
							"aiq-artifact://sha256/{}/{}",
							artifact.content_hash.trim_start_matches("sha256:"),
							artifact.kind
						)
			}) || trial.aggregate_output_tps_millis
			!= trial
				.tokens
				.output
				.and_then(|tokens| aggregate_output_tps_millis(tokens, trial.elapsed_ms))
			|| trial.estimated_credits_nanos
				!= estimate_credits_nanos(trial.model.family, trial.mode, &trial.tokens)
		{
			return Err(SpeedObservationError::new("speed trial measurement is invalid"));
		}

		match trial.status {
			SpeedTrialStatus::Completed
				if trial.failure.is_none()
					&& trial.response_sha256.as_deref() == Some(&expected_response_sha256) => {},
			SpeedTrialStatus::InvalidResponse
				if trial.failure.is_none()
					&& trial.response_sha256.as_deref().is_some_and(valid_sha256)
					&& trial.response_sha256.as_deref() != Some(&expected_response_sha256) => {},
			SpeedTrialStatus::Failed
				if trial.response_sha256.is_none() && trial.failure.is_some() => {},
			_ => return Err(SpeedObservationError::new("speed trial terminal state is invalid")),
		}

		*counts.entry((trial.model, trial.mode)).or_insert(0_u8) += 1;
	}

	if counts.len() != available.len()
		|| counts.values().any(|count| *count != batch.trials_per_mode)
	{
		return Err(SpeedObservationError::new("speed trial coverage is incomplete"));
	}

	Ok(())
}

fn validate_options(options: &SpeedObservationOptions) -> Result<(), SpeedObservationError> {
	if options.trials_per_mode == 0 || options.trials_per_mode > MAX_TRIALS_PER_MODE {
		return Err(SpeedObservationError::new("trials per mode must be between 1 and 10"));
	}
	if options.jobs == 0 || options.jobs > MAX_OBSERVATION_JOBS {
		return Err(SpeedObservationError::new("speed observation jobs must be between 1 and 17"));
	}

	let selected = options.models.iter().copied().collect::<BTreeSet<_>>();
	let matrix = MODEL_MATRIX.into_iter().collect::<BTreeSet<_>>();

	if selected.len() != options.models.len() || selected.is_empty() || !selected.is_subset(&matrix)
	{
		return Err(SpeedObservationError::new(
			"speed observation models must be a nonempty unique matrix subset",
		));
	}
	if !options.observed_at.strip_prefix("unix-ms:").is_some_and(|value| {
		!value.is_empty()
			&& value.bytes().all(|byte| byte.is_ascii_digit())
			&& value.parse::<u64>().is_ok_and(|parsed| parsed > 0)
	}) {
		return Err(SpeedObservationError::new("speed observed_at must be canonical unix-ms"));
	}

	Ok(())
}

fn observe_catalog(
	options: &SpeedObservationOptions,
	sink: &LocalArtifactSink,
) -> CatalogObservation {
	let adapter = CodexAdapter::new(
		SystemExecutor,
		sink.clone(),
		options.codex_binary.clone(),
		CodexExecutionConfig::isolated(options.codex_home.clone())
			.with_model_toolchain(options.model_toolchain.clone()),
	);
	let version = adapter.probe_version();
	let catalog_output = adapter.probe_model_catalog();

	match (version, catalog_output) {
		(Ok(codex_version), Ok(output)) => {
			parse_catalog_observation(&options.models, codex_version, &output.stdout_full)
				.unwrap_or_else(|reason| unavailable_catalog(&options.models, reason))
		},
		(Err(_), _) => unavailable_catalog(&options.models, "codex_version_probe_failed"),
		(_, Err(_)) => unavailable_catalog(&options.models, "model_catalog_probe_failed"),
	}
}

fn parse_catalog_observation(
	models: &[ModelConfig],
	codex_version: String,
	raw: &str,
) -> Result<CatalogObservation, &'static str> {
	let catalog = serde_json::from_str::<LiveCatalog>(raw.trim())
		.map_err(|_| "model_catalog_response_invalid")?;
	let catalog = &catalog;
	let capabilities = models
		.iter()
		.copied()
		.flat_map(|model| {
			[SpeedMode::Normal, SpeedMode::Fast]
				.into_iter()
				.map(move |mode| catalog_capability(catalog, model, mode))
		})
		.collect();

	Ok(CatalogObservation {
		evidence: SpeedCatalogEvidence {
			status: CatalogProbeStatus::Available,
			codex_version: Some(codex_version),
			catalog_sha256: Some(raw_sha256(raw.as_bytes())),
			unavailable_reason: None,
		},
		capabilities,
	})
}

fn catalog_capability(
	catalog: &LiveCatalog,
	model: ModelConfig,
	mode: SpeedMode,
) -> SpeedCapabilityObservation {
	let Some(entry) = catalog.models.iter().find(|entry| entry.slug == model.family.codex_name())
	else {
		return SpeedCapabilityObservation {
			model,
			mode,
			status: SpeedCapabilityStatus::Unsupported,
			reason: "model_not_advertised".to_owned(),
		};
	};
	let effort = model.reasoning_effort.to_string();
	let effort_supported =
		entry.supported_reasoning_levels.iter().any(|level| level.effort == effort);
	let fast_supported = entry.additional_speed_tiers.iter().any(|tier| tier == "fast");
	let available = effort_supported && (mode == SpeedMode::Normal || fast_supported);

	SpeedCapabilityObservation {
		model,
		mode,
		status: if available {
			SpeedCapabilityStatus::Available
		} else {
			SpeedCapabilityStatus::Unsupported
		},
		reason: if !effort_supported {
			"reasoning_effort_not_advertised"
		} else if !fast_supported {
			"fast_transport_not_advertised"
		} else {
			"live_catalog_advertised"
		}
		.to_owned(),
	}
}

fn unavailable_catalog(models: &[ModelConfig], reason: &str) -> CatalogObservation {
	CatalogObservation {
		evidence: SpeedCatalogEvidence {
			status: CatalogProbeStatus::Unavailable,
			codex_version: None,
			catalog_sha256: None,
			unavailable_reason: Some(reason.to_owned()),
		},
		capabilities: models
			.iter()
			.copied()
			.flat_map(|model| {
				[SpeedMode::Normal, SpeedMode::Fast].into_iter().map(move |mode| {
					SpeedCapabilityObservation {
						model,
						mode,
						status: SpeedCapabilityStatus::Unavailable,
						reason: reason.to_owned(),
					}
				})
			})
			.collect(),
	}
}

fn run_trials(
	options: &SpeedObservationOptions,
	capabilities: &[SpeedCapabilityObservation],
	context: TrialContext<'_>,
) -> Result<Vec<SpeedTrial>, SpeedObservationError> {
	if !capabilities.iter().any(|entry| entry.status == SpeedCapabilityStatus::Available) {
		return Ok(Vec::new());
	}

	let worker_count = options.jobs.min(options.models.len());
	let next_model = AtomicUsize::new(0);
	let (sender, receiver) = mpsc::channel();

	thread::scope(|scope| {
		for _ in 0..worker_count {
			let sender = sender.clone();
			let context = &context;
			let next_model = &next_model;

			scope.spawn(move || {
				loop {
					let index = next_model.fetch_add(1, Ordering::Relaxed);

					if index >= options.models.len() {
						break;
					}

					let model = options.models[index];
					let available = capabilities
						.iter()
						.filter(|entry| {
							entry.model == model && entry.status == SpeedCapabilityStatus::Available
						})
						.map(|entry| entry.mode)
						.collect::<BTreeSet<_>>();
					let result = run_model_trials(model, &available, context);

					if sender.send((index, result)).is_err() {
						break;
					}
				}
			});
		}

		drop(sender);

		let mut grouped = vec![None; options.models.len()];

		for _ in 0..options.models.len() {
			let (index, result) = receiver
				.recv()
				.map_err(|_| SpeedObservationError::new("speed observation worker stopped"))?;

			grouped[index] = Some(result?);
		}

		let trials = grouped.into_iter().flatten().flatten().collect::<Vec<_>>();

		Ok(trials)
	})
}

fn run_model_trials(
	model: ModelConfig,
	available: &BTreeSet<SpeedMode>,
	context: &TrialContext<'_>,
) -> Result<Vec<SpeedTrial>, SpeedObservationError> {
	let model_workspace = context.workspace_root.join(model.key());

	prepare_private_root(&model_workspace, "speed model workspace")?;

	let base_config = CodexExecutionConfig::isolated(context.options.codex_home.clone())
		.with_model_toolchain(context.options.model_toolchain.clone());
	let normal = CodexAdapter::new(
		SystemExecutor,
		context.sink.clone(),
		context.options.codex_binary.clone(),
		base_config.clone().with_service_tier(CodexServiceTier::Standard),
	);
	let fast = CodexAdapter::new(
		SystemExecutor,
		context.sink.clone(),
		context.options.codex_binary.clone(),
		base_config.with_service_tier(CodexServiceTier::Fast),
	);
	let mut trials = Vec::new();

	for (trial_index, mode) in trial_order(context.options.trials_per_mode) {
		if !available.contains(&mode) {
			continue;
		}

		let trial_id = trial_id(context.execution_identity, model, mode, trial_index)?;
		let checkpoint = context.checkpoint_root.join(format!("{trial_id}.json"));

		if checkpoint.exists() {
			trials.push(read_checkpoint(
				&checkpoint,
				&trial_id,
				model,
				mode,
				trial_index,
				&context.options.observed_at,
			)?);

			continue;
		}

		let adapter = match mode {
			SpeedMode::Normal => &normal,
			SpeedMode::Fast => &fast,
		};
		let trial =
			execute_trial(adapter, trial_id, model, mode, trial_index, &model_workspace, context);

		write_checkpoint(&checkpoint, &trial)?;

		trials.push(trial);
	}

	Ok(trials)
}

fn execute_trial(
	adapter: &CodexAdapter<SystemExecutor, LocalArtifactSink>,
	trial_id: String,
	model: ModelConfig,
	mode: SpeedMode,
	trial_index: u8,
	workspace: &Path,
	context: &TrialContext<'_>,
) -> SpeedTrial {
	let started = Instant::now();
	let result = adapter.invoke(&InvocationRequest {
		model,
		prompt: context.prompt.to_owned(),
		timeout: None,
		max_steps: None,
		max_tool_calls: None,
		workspace_dir: workspace.to_owned(),
		sandbox: SandboxPolicy::NoTools,
	});
	let elapsed_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);

	match result {
		Ok(output) => completed_trial(
			trial_id,
			model,
			mode,
			trial_index,
			&context.options.observed_at,
			elapsed_ms,
			output,
			context.expected_response,
		),
		Err(failure) => failed_trial(
			trial_id,
			model,
			mode,
			trial_index,
			&context.options.observed_at,
			elapsed_ms,
			failure,
		),
	}
}

#[allow(clippy::too_many_arguments)]
fn completed_trial(
	trial_id: String,
	model: ModelConfig,
	mode: SpeedMode,
	trial_index: u8,
	observed_at: &str,
	elapsed_ms: u64,
	output: CodexOutput,
	expected_response: &str,
) -> SpeedTrial {
	let usage = runner::parse_codex_tool_usage(&output.stdout_full).unwrap_or_default();
	let response = adapter::extract_probe_response(&output.stdout_full);
	let response_valid = response.as_deref() == Some(expected_response);
	let aggregate_output_tps_millis = usage
		.provider_tokens
		.output
		.and_then(|tokens| aggregate_output_tps_millis(tokens, elapsed_ms));
	let estimated_credits_nanos =
		estimate_credits_nanos(model.family, mode, &usage.provider_tokens);

	SpeedTrial {
		trial_id,
		observed_at: observed_at.to_owned(),
		model,
		mode,
		trial_index,
		status: if response_valid {
			SpeedTrialStatus::Completed
		} else {
			SpeedTrialStatus::InvalidResponse
		},
		elapsed_ms,
		ttft_ms: None,
		post_first_token_output_tps_millis: None,
		aggregate_output_tps_millis,
		tokens: usage.provider_tokens.clone(),
		tool_usage: usage,
		estimated_credits_nanos,
		response_sha256: response.as_deref().map(|value| raw_sha256(value.as_bytes())),
		artifacts: output.artifacts,
		failure: None,
	}
}

#[allow(clippy::too_many_arguments)]
fn failed_trial(
	trial_id: String,
	model: ModelConfig,
	mode: SpeedMode,
	trial_index: u8,
	observed_at: &str,
	elapsed_ms: u64,
	failure: AdapterFailure,
) -> SpeedTrial {
	let usage = runner::parse_codex_tool_usage(&failure.stdout_full).unwrap_or_default();
	let aggregate_output_tps_millis = usage
		.provider_tokens
		.output
		.and_then(|tokens| aggregate_output_tps_millis(tokens, elapsed_ms));
	let estimated_credits_nanos =
		estimate_credits_nanos(model.family, mode, &usage.provider_tokens);

	SpeedTrial {
		trial_id,
		observed_at: observed_at.to_owned(),
		model,
		mode,
		trial_index,
		status: SpeedTrialStatus::Failed,
		elapsed_ms,
		ttft_ms: None,
		post_first_token_output_tps_millis: None,
		aggregate_output_tps_millis,
		tokens: usage.provider_tokens.clone(),
		tool_usage: usage,
		estimated_credits_nanos,
		response_sha256: None,
		artifacts: failure.artifacts,
		failure: Some(SpeedTrialFailure {
			kind: adapter_failure_kind(failure.kind).to_owned(),
			message: failure.message,
			exit_code: failure.exit_code,
		}),
	}
}

fn trial_order(trials_per_mode: u8) -> Vec<(u8, SpeedMode)> {
	let mut order = Vec::with_capacity(usize::from(trials_per_mode) * 2);

	for trial_index in 0..trials_per_mode {
		let pair = if trial_index % 2 == 0 {
			[SpeedMode::Normal, SpeedMode::Fast]
		} else {
			[SpeedMode::Fast, SpeedMode::Normal]
		};

		order.extend(pair.into_iter().map(|mode| (trial_index, mode)));
	}

	order
}

fn trial_id(
	execution_identity: &str,
	model: ModelConfig,
	mode: SpeedMode,
	trial_index: u8,
) -> Result<String, SpeedObservationError> {
	let digest = protocol::canonical_hash(&(
		"aiq.speed-observation-trial.v1",
		execution_identity,
		model,
		mode,
		trial_index,
	))
	.map_err(|error| SpeedObservationError::new(error.to_string()))?;

	Ok(format!("speed_trial_{}", digest.trim_start_matches("sha256:")))
}

fn read_checkpoint(
	path: &Path,
	trial_id: &str,
	model: ModelConfig,
	mode: SpeedMode,
	trial_index: u8,
	observed_at: &str,
) -> Result<SpeedTrial, SpeedObservationError> {
	let metadata = fs::symlink_metadata(path).map_err(|error| {
		SpeedObservationError::new(format!("cannot inspect checkpoint: {error}"))
	})?;

	if metadata.file_type().is_symlink()
		|| !metadata.is_file()
		|| metadata.len() > 4 * 1_024 * 1_024
	{
		return Err(SpeedObservationError::new("speed checkpoint is not a bounded regular file"));
	}

	let trial =
		serde_json::from_slice::<SpeedTrial>(&fs::read(path).map_err(|error| {
			SpeedObservationError::new(format!("cannot read checkpoint: {error}"))
		})?)
		.map_err(|_| SpeedObservationError::new("speed checkpoint is invalid"))?;

	if trial.trial_id != trial_id
		|| trial.model != model
		|| trial.mode != mode
		|| trial.trial_index != trial_index
		|| trial.observed_at != observed_at
	{
		return Err(SpeedObservationError::new("speed checkpoint identity mismatch"));
	}

	Ok(trial)
}

fn write_checkpoint(path: &Path, trial: &SpeedTrial) -> Result<(), SpeedObservationError> {
	let mut bytes = serde_json::to_vec(trial).map_err(|error| {
		SpeedObservationError::new(format!("cannot encode checkpoint: {error}"))
	})?;

	bytes.push(b'\n');

	let mut options = OpenOptions::new();

	options.write(true).create_new(true);
	#[cfg(unix)]
	options.mode(0o600);

	let mut file = options.open(path).map_err(|error| {
		SpeedObservationError::new(format!("cannot create checkpoint: {error}"))
	})?;

	file.write_all(&bytes)
		.and_then(|()| file.sync_all())
		.map_err(|error| SpeedObservationError::new(format!("cannot persist checkpoint: {error}")))
}

fn prepare_private_root(path: &Path, label: &str) -> Result<PathBuf, SpeedObservationError> {
	if fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
		return Err(SpeedObservationError::new(format!("{label} must not be a symbolic link")));
	}

	fs::create_dir_all(path)
		.map_err(|error| SpeedObservationError::new(format!("cannot create {label}: {error}")))?;
	#[cfg(unix)]
	fs::set_permissions(path, Permissions::from_mode(0o700))
		.map_err(|error| SpeedObservationError::new(format!("cannot restrict {label}: {error}")))?;

	let canonical = fs::canonicalize(path)
		.map_err(|error| SpeedObservationError::new(format!("cannot resolve {label}: {error}")))?;

	if !canonical.is_dir() {
		return Err(SpeedObservationError::new(format!("{label} must be a directory")));
	}

	Ok(canonical)
}

fn unavailable_metrics() -> Vec<UnavailableMetric> {
	vec![
		UnavailableMetric {
			metric: "ttft_ms".to_owned(),
			reason: "current_codex_jsonl_has_no_first_token_timestamp".to_owned(),
		},
		UnavailableMetric {
			metric: "post_first_token_output_tps_millis".to_owned(),
			reason: "current_codex_jsonl_has_no_first_token_timestamp".to_owned(),
		},
	]
}

fn speed_prompt() -> String {
	format!(
		"Return exactly the comma-separated integers from 1 through {FIXED_OUTPUT_END}, inclusive, in ascending order. Use no spaces, no markdown, no commentary, and no trailing punctuation."
	)
}

fn expected_speed_response() -> String {
	(1..=FIXED_OUTPUT_END).map(|value| value.to_string()).collect::<Vec<_>>().join(",")
}

fn aggregate_output_tps_millis(output_tokens: u64, elapsed_ms: u64) -> Option<u64> {
	if elapsed_ms == 0 {
		return None;
	}

	output_tokens.checked_mul(1_000_000)?.checked_div(elapsed_ms)
}

fn estimate_credits_nanos(
	family: ModelFamily,
	mode: SpeedMode,
	tokens: &ProviderTokenUsage,
) -> Option<u64> {
	let input = tokens.input?;
	let cached = tokens.cached_input.unwrap_or(0);
	let output = tokens.output?;
	let uncached = input.checked_sub(cached)?;
	let (input_rate, cached_rate, output_rate) = credit_rates_nanos_per_token(family);
	let base = uncached
		.checked_mul(input_rate)?
		.checked_add(cached.checked_mul(cached_rate)?)?
		.checked_add(output.checked_mul(output_rate)?)?;

	base.checked_mul(mode.credit_multiplier_basis_points())?.checked_div(10_000)
}

const fn credit_rates_nanos_per_token(family: ModelFamily) -> (u64, u64, u64) {
	match family {
		ModelFamily::Sol => (125_000, 12_500, 750_000),
		ModelFamily::Terra => (50_000, 5_000, 300_000),
		ModelFamily::Luna => (5_000, 500, 30_000),
	}
}

fn raw_sha256(bytes: &[u8]) -> String {
	format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
}

fn valid_sha256(value: &str) -> bool {
	value.strip_prefix("sha256:").is_some_and(|digest| {
		digest.len() == 64
			&& digest.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
	})
}

fn valid_nonzero_sha256(value: &str) -> bool {
	valid_sha256(value)
		&& value
			.strip_prefix("sha256:")
			.is_some_and(|digest| digest.bytes().any(|byte| byte != b'0'))
}

fn valid_trial_id(value: &str) -> bool {
	value.strip_prefix("speed_trial_").is_some_and(|digest| {
		digest.len() == 64
			&& digest.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
	})
}

const fn adapter_failure_kind(kind: adapter::AdapterFailureKind) -> &'static str {
	match kind {
		adapter::AdapterFailureKind::Spawn => "spawn",
		adapter::AdapterFailureKind::Timeout => "timeout",
		adapter::AdapterFailureKind::Unsupported => "unsupported",
		adapter::AdapterFailureKind::Authentication => "authentication",
		adapter::AdapterFailureKind::UsageLimit => "usage_limit",
		adapter::AdapterFailureKind::NonZeroExit => "non_zero_exit",
		adapter::AdapterFailureKind::BudgetExceeded => "budget_exceeded",
		adapter::AdapterFailureKind::OutputTruncated => "output_truncated",
		adapter::AdapterFailureKind::WorkspaceIntegrity => "workspace_integrity",
	}
}

#[cfg(test)]
mod tests {
	use crate::model::ReasoningEffort;
	use crate::speed_observation::SpeedCapabilityStatus;
	use crate::speed_observation::{self, ModelConfig, ModelFamily, ProviderTokenUsage, SpeedMode};

	fn usage(input: u64, cached: u64, output: u64) -> ProviderTokenUsage {
		ProviderTokenUsage {
			input: Some(input),
			cached_input: Some(cached),
			cache_write_input: None,
			output: Some(output),
			reasoning: None,
			total: Some(input + output),
		}
	}

	#[test]
	fn fast_credit_estimate_is_exactly_two_and_a_half_times_normal() {
		let tokens = usage(1_000, 200, 400);
		let normal =
			speed_observation::estimate_credits_nanos(ModelFamily::Sol, SpeedMode::Normal, &tokens)
				.expect("normal estimate");
		let fast =
			speed_observation::estimate_credits_nanos(ModelFamily::Sol, SpeedMode::Fast, &tokens)
				.expect("fast estimate");

		assert_eq!(fast * 2, normal * 5);
	}

	#[test]
	fn missing_or_inconsistent_provider_tokens_do_not_invent_cost() {
		assert_eq!(
			speed_observation::estimate_credits_nanos(
				ModelFamily::Terra,
				SpeedMode::Normal,
				&ProviderTokenUsage::default(),
			),
			None
		);
		assert_eq!(
			speed_observation::estimate_credits_nanos(
				ModelFamily::Terra,
				SpeedMode::Normal,
				&usage(10, 11, 1),
			),
			None
		);
	}

	#[test]
	fn paired_trials_alternate_normal_and_fast_order() {
		assert_eq!(
			speed_observation::trial_order(3),
			vec![
				(0, SpeedMode::Normal),
				(0, SpeedMode::Fast),
				(1, SpeedMode::Fast),
				(1, SpeedMode::Normal),
				(2, SpeedMode::Normal),
				(2, SpeedMode::Fast),
			]
		);
	}

	#[test]
	fn catalog_parser_requires_exact_reasoning_and_fast_advertisement() {
		let model =
			ModelConfig { family: ModelFamily::Sol, reasoning_effort: ReasoningEffort::Ultra };
		let raw = r#"{"models":[{"slug":"gpt-5.6-sol","supported_reasoning_levels":[{"effort":"ultra"}],"additional_speed_tiers":["fast"]}]}"#;
		let observation = speed_observation::parse_catalog_observation(
			&[model],
			"codex-cli 1.0.0".to_owned(),
			raw,
		)
		.expect("catalog observation");

		assert_eq!(observation.capabilities.len(), 2);
		assert!(
			observation
				.capabilities
				.iter()
				.all(|entry| entry.status == SpeedCapabilityStatus::Available)
		);
	}

	#[test]
	fn aggregate_throughput_includes_the_full_invocation_elapsed_time() {
		assert_eq!(speed_observation::aggregate_output_tps_millis(100, 2_000), Some(50_000));
		assert_eq!(speed_observation::aggregate_output_tps_millis(100, 0), None);
	}
}
