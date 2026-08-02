//! Bounded HTTPS submission of signed result packages.

use std::{
	collections::{BTreeMap, BTreeSet},
	error::Error,
	fmt::{self, Debug, Display},
	fs, iter,
	path::{Path, PathBuf},
	time::Duration,
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use ureq::http::{Uri, uri::PathAndQuery};

use crate::adapter::CapabilityValidationReport;
use crate::protocol::{CALIBRATION_RUN_PAYLOAD_TYPE, RUN_PAYLOAD_TYPE, TrustTier};
use crate::runner::MAX_RUN_JOBS;
use crate::{
	adapter::ArtifactReference,
	protocol::{self, SubmissionEnvelope},
	run_validation,
	runner::{CalibrationRunRecord, MAX_EVALUATOR_RESULTS_BUNDLE_BYTES, RunRecord, TaskResult},
};

/// Maximum signed package size accepted for submission.
pub const MAX_SUBMISSION_BYTES: usize = 4 * 1_024 * 1_024;
/// Maximum canonical signed package size produced and accepted by the runner.
pub const MAX_SIGNED_PACKAGE_BYTES: usize = MAX_SUBMISSION_BYTES - 240 * 1_024;
/// Maximum retained artifact accepted through the Vercel ingress boundary.
pub const MAX_ARTIFACT_BYTES: usize = 4 * 1_024 * 1_024;

/// Injectable outbound submission transport.
pub trait SubmissionTransport {
	/// Sends one bounded signed package.
	fn send(&self, request: &SubmissionRequest) -> Result<TransportResponse, TransportFailure>;
}

/// Injectable outbound artifact transport.
pub trait ArtifactUploadTransport {
	/// Uploads one bounded, content-addressed artifact.
	fn upload(
		&self,
		request: &ArtifactUploadRequest,
	) -> Result<TransportResponse, TransportFailure>;
}

/// Strictly decoded and semantically validated signed-package payload.
///
/// Calibration remains a separate type so callers cannot accidentally pass it
/// to Official normalization or publication code as a [`RunRecord`].
#[derive(Clone, Debug, PartialEq)]
pub enum ValidatedSubmissionPayload {
	/// Existing `aiq.run.v3` payload.
	Official(RunRecord),
	/// Explicitly non-Official `aiq.calibration-run.v3` payload.
	Calibration(CalibrationRunRecord),
}
impl ValidatedSubmissionPayload {
	fn evaluator_results_artifact(&self) -> &ArtifactReference {
		match self {
			Self::Official(run) => &run.evaluator_results_artifact,
			Self::Calibration(run) => &run.evaluator_results_artifact,
		}
	}

	fn results(&self) -> &[TaskResult] {
		match self {
			Self::Official(run) => &run.results,
			Self::Calibration(run) => &run.results,
		}
	}

	fn capability_validation(&self) -> Option<&CapabilityValidationReport> {
		match self {
			Self::Official(run) => run.capability_validation.as_ref(),
			Self::Calibration(run) => Some(&run.capability_validation),
		}
	}
}

/// Low-level network failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TransportFailureKind {
	/// Connection, DNS, TLS, or protocol failure.
	Network,
	/// Global transport timeout.
	Timeout,
}

/// Classified submission outcome.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SubmissionOutcomeKind {
	/// Server accepted the package into the unverified queue.
	Accepted,
	/// Server reports that the idempotency key was already accepted.
	Duplicate,
	/// Server reports a conflicting idempotency key or payload.
	Conflict,
	/// Other client-side HTTP error.
	ClientError,
	/// Server-side HTTP error.
	ServerError,
	/// Network, DNS, TLS, or protocol failure.
	Network,
	/// Transport timeout.
	Timeout,
	/// Local configuration or package validation failure.
	Configuration,
}

/// A bearer token that does not implement serialization and redacts debug output.
pub struct SecretToken(String);
impl SecretToken {
	/// Wraps a deployment-provided bearer token.
	pub fn new(value: String) -> Result<Self, SubmissionError> {
		if value.trim().is_empty() {
			return Err(SubmissionError::new(
				SubmissionOutcomeKind::Configuration,
				"submission token must not be empty",
			));
		}

		Ok(Self(value))
	}

	fn expose(&self) -> &str {
		&self.0
	}

	fn duplicate(&self) -> Self {
		Self(self.0.clone())
	}
}

impl Debug for SecretToken {
	fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		formatter.write_str("SecretToken([REDACTED])")
	}
}

/// Request passed to an injectable submission transport.
pub struct SubmissionRequest {
	/// Exact HTTPS URL.
	pub url: String,
	/// Signed JSON body.
	pub body: Vec<u8>,
	/// Stable run or package idempotency key.
	pub idempotency_key: String,
	/// Deployment bearer token.
	pub bearer_token: SecretToken,
}

/// Request passed to the authenticated binary artifact transport.
pub struct ArtifactUploadRequest {
	/// Exact HTTPS URL.
	pub url: String,
	/// Exact retained artifact bytes.
	pub body: Vec<u8>,
	/// Run that claims the artifact.
	pub idempotency_key: String,
	/// Stable artifact kind.
	pub kind: String,
	/// Lowercase SHA-256 digest without a prefix.
	pub digest: String,
	/// Deployment bearer token.
	pub bearer_token: SecretToken,
}

/// Minimal HTTP transport response.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TransportResponse {
	/// HTTP status code.
	pub status: u16,
}

/// Low-level transport failure.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TransportFailure {
	/// Stable failure class.
	pub kind: TransportFailureKind,
	/// Human-readable detail that contains no bearer token.
	pub message: String,
}

/// Blocking HTTPS transport backed by ureq and rustls.
pub struct HttpsTransport {
	timeout: Duration,
	allow_loopback_http: bool,
}
impl HttpsTransport {
	/// Creates a transport with a global request timeout.
	#[must_use]
	pub const fn new(timeout: Duration, allow_loopback_http: bool) -> Self {
		Self { timeout, allow_loopback_http }
	}
}

impl SubmissionTransport for HttpsTransport {
	fn send(&self, request: &SubmissionRequest) -> Result<TransportResponse, TransportFailure> {
		if !transport_url_is_allowed(&request.url, self.allow_loopback_http) {
			return Err(TransportFailure {
				kind: TransportFailureKind::Network,
				message:
					"submission URL must use HTTPS or an explicitly allowed loopback HTTP origin"
						.to_owned(),
			});
		}

		let config = ureq::Agent::config_builder().timeout_global(Some(self.timeout)).build();
		let agent: ureq::Agent = config.into();
		let response = agent
			.post(&request.url)
			.header("Authorization", &format!("Bearer {}", request.bearer_token.expose()))
			.header("Content-Type", "application/json")
			.header("Idempotency-Key", &request.idempotency_key)
			.send(&request.body);

		match response {
			Ok(response) => Ok(TransportResponse { status: response.status().as_u16() }),
			Err(ureq::Error::StatusCode(status)) => Ok(TransportResponse { status }),
			Err(error) => Err(TransportFailure {
				kind: if matches!(error, ureq::Error::Timeout(_)) {
					TransportFailureKind::Timeout
				} else {
					TransportFailureKind::Network
				},
				message: error.to_string(),
			}),
		}
	}
}

impl ArtifactUploadTransport for HttpsTransport {
	fn upload(
		&self,
		request: &ArtifactUploadRequest,
	) -> Result<TransportResponse, TransportFailure> {
		if !transport_url_is_allowed(&request.url, self.allow_loopback_http) {
			return Err(TransportFailure {
				kind: TransportFailureKind::Network,
				message:
					"artifact URL must use HTTPS or an explicitly allowed loopback HTTP origin"
						.to_owned(),
			});
		}

		let config = ureq::Agent::config_builder().timeout_global(Some(self.timeout)).build();
		let agent: ureq::Agent = config.into();
		let response = agent
			.post(&request.url)
			.header("Authorization", &format!("Bearer {}", request.bearer_token.expose()))
			.header("Content-Type", "application/octet-stream")
			.header("Content-Length", &request.body.len().to_string())
			.header("Idempotency-Key", &request.idempotency_key)
			.header("X-AIQ-Artifact-Kind", &request.kind)
			.header("X-AIQ-Artifact-SHA256", &request.digest)
			.header("X-AIQ-Artifact-Bytes", &request.body.len().to_string())
			.send(&request.body);

		match response {
			Ok(response) => Ok(TransportResponse { status: response.status().as_u16() }),
			Err(ureq::Error::StatusCode(status)) => Ok(TransportResponse { status }),
			Err(error) => Err(TransportFailure {
				kind: if matches!(error, ureq::Error::Timeout(_)) {
					TransportFailureKind::Timeout
				} else {
					TransportFailureKind::Network
				},
				message: error.to_string(),
			}),
		}
	}
}

/// User-facing submission result.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct SubmissionOutcome {
	/// Stable outcome class.
	pub kind: SubmissionOutcomeKind,
	/// HTTP status when a server responded.
	pub status: Option<u16>,
	/// Server handling contract.
	pub server_disposition: String,
}

/// Complete runner-to-ingress result. The package is never submitted before every artifact.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct SubmissionBundleOutcome {
	/// Machine-readable outcome schema.
	pub schema_version: &'static str,
	/// Number of unique signed artifact references uploaded or confirmed.
	pub artifacts_total: usize,
	/// Number of artifact objects newly stored by the gateway.
	pub artifacts_stored: usize,
	/// Number of exact artifact objects already present at the gateway.
	pub artifacts_duplicate: usize,
	/// Result-package queue outcome.
	pub package: SubmissionOutcome,
}

/// Local submission error.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SubmissionError {
	kind: SubmissionOutcomeKind,
	message: String,
}
impl SubmissionError {
	fn new(kind: SubmissionOutcomeKind, message: impl Into<String>) -> Self {
		Self { kind, message: message.into() }
	}

	/// Returns the stable error class.
	#[must_use]
	pub const fn kind(&self) -> SubmissionOutcomeKind {
		self.kind
	}
}

impl Error for SubmissionError {}

impl Display for SubmissionError {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter.write_str(&self.message)
	}
}

/// Serializes a signed package as compact JCS and enforces the transport bound.
pub fn serialize_signed_package(envelope: &SubmissionEnvelope) -> Result<Vec<u8>, SubmissionError> {
	envelope.verify(&BTreeSet::new()).map_err(|error| {
		SubmissionError::new(
			SubmissionOutcomeKind::Configuration,
			format!("signed package verification failed: {error}"),
		)
	})?;

	decode_validated_payload(envelope)?;

	let bytes = protocol::canonical_json(envelope).map_err(|error| {
		SubmissionError::new(
			SubmissionOutcomeKind::Configuration,
			format!("signed package serialization failed: {error}"),
		)
	})?;

	if bytes.len() > MAX_SIGNED_PACKAGE_BYTES {
		return Err(SubmissionError::new(
			SubmissionOutcomeKind::Configuration,
			"signed package exceeds the guarded submission limit",
		));
	}

	Ok(bytes)
}

/// Rebinds synthetic result provenance to the key that will sign the package.
///
/// Real runs are never rewritten. Their preflight identity is authoritative.
pub fn bind_synthetic_run_to_signer(
	run: &mut RunRecord,
	signer_node_id: &str,
) -> Result<(), SubmissionError> {
	if !run.synthetic {
		return Err(SubmissionError::new(
			SubmissionOutcomeKind::Configuration,
			"only synthetic runs can be rebound during packaging",
		));
	}

	for result in &mut run.results {
		result.provenance.node_id = signer_node_id.to_owned();
		result.result_id = format!(
			"result_{}",
			result
				.content_hash()
				.map_err(|error| {
					SubmissionError::new(
						SubmissionOutcomeKind::Configuration,
						format!("synthetic result identity failed: {error}"),
					)
				})?
				.trim_start_matches("sha256:")
		);
	}

	Ok(())
}

/// Confirms that a signed run's preflight and result provenance name its package signer.
pub fn validate_run_signer_binding(
	run: &RunRecord,
	signer_node_id: &str,
) -> Result<(), SubmissionError> {
	let provenance_matches =
		run.results.iter().all(|result| result.provenance.node_id == signer_node_id);
	let preflight_matches = run.synthetic
		|| run
			.capability_validation
			.as_ref()
			.is_some_and(|report| report.node_id == signer_node_id);

	if !provenance_matches || !preflight_matches {
		return Err(SubmissionError::new(
			SubmissionOutcomeKind::Configuration,
			"signed package signer does not match run provenance and preflight node_id",
		));
	}

	Ok(())
}

/// Confirms that a signed calibration's preflight and result provenance name
/// its package signer.
pub fn validate_calibration_signer_binding(
	run: &CalibrationRunRecord,
	signer_node_id: &str,
) -> Result<(), SubmissionError> {
	let provenance_matches =
		run.results.iter().all(|result| result.provenance.node_id == signer_node_id);
	let preflight_matches = run.capability_validation.node_id == signer_node_id;

	if !provenance_matches || !preflight_matches {
		return Err(SubmissionError::new(
			SubmissionOutcomeKind::Configuration,
			"signed calibration package signer does not match run provenance and preflight node_id",
		));
	}

	Ok(())
}

/// Uploads every unique signed artifact before submitting the package that claims it.
pub fn submit_signed_package_with_artifacts<T>(
	transport: &T,
	endpoint: &str,
	body: Vec<u8>,
	artifact_root: &Path,
	bearer_token: SecretToken,
) -> Result<SubmissionBundleOutcome, SubmissionError>
where
	T: ArtifactUploadTransport + SubmissionTransport,
{
	submit_signed_package_with_artifacts_policy(
		transport,
		endpoint,
		body,
		artifact_root,
		bearer_token,
		false,
	)
}

/// Uploads and submits through an HTTP endpoint only when it is a loopback origin.
pub fn submit_signed_package_with_artifacts_allowing_loopback<T>(
	transport: &T,
	endpoint: &str,
	body: Vec<u8>,
	artifact_root: &Path,
	bearer_token: SecretToken,
) -> Result<SubmissionBundleOutcome, SubmissionError>
where
	T: ArtifactUploadTransport + SubmissionTransport,
{
	submit_signed_package_with_artifacts_policy(
		transport,
		endpoint,
		body,
		artifact_root,
		bearer_token,
		true,
	)
}

/// Validates and submits one signed package.
pub fn submit_signed_package<T>(
	transport: &T,
	endpoint: &str,
	body: Vec<u8>,
	bearer_token: SecretToken,
) -> Result<SubmissionOutcome, SubmissionError>
where
	T: SubmissionTransport,
{
	submit_signed_package_policy(transport, endpoint, body, bearer_token, false)
}

/// Reads and verifies the evaluator-results artifact bound by a saved run.
pub fn read_evaluator_results_artifact(
	artifact_root: &Path,
	artifact: &ArtifactReference,
) -> Result<Vec<u8>, SubmissionError> {
	if artifact.kind != "evaluator-results.json" {
		return Err(SubmissionError::new(
			SubmissionOutcomeKind::Configuration,
			"run does not reference an evaluator-results artifact",
		));
	}

	let root = canonical_artifact_root(artifact_root)?;
	let digest = artifact.content_hash.strip_prefix("sha256:").ok_or_else(|| {
		SubmissionError::new(
			SubmissionOutcomeKind::Configuration,
			"evaluator-results artifact hash is not a SHA-256 address",
		)
	})?;

	read_artifact(&root, &artifact.kind, digest, artifact.bytes)
}

fn validate_signed_package(
	body: &[u8],
) -> Result<(SubmissionEnvelope, ValidatedSubmissionPayload), SubmissionError> {
	if body.len() > MAX_SIGNED_PACKAGE_BYTES {
		return Err(SubmissionError::new(
			SubmissionOutcomeKind::Configuration,
			"signed package exceeds the guarded submission limit",
		));
	}

	let envelope = serde_json::from_slice::<SubmissionEnvelope>(body).map_err(|error| {
		SubmissionError::new(
			SubmissionOutcomeKind::Configuration,
			format!("signed package is invalid JSON: {error}"),
		)
	})?;

	envelope.verify(&BTreeSet::new()).map_err(|error| {
		SubmissionError::new(
			SubmissionOutcomeKind::Configuration,
			format!("signed package verification failed: {error}"),
		)
	})?;

	let payload = decode_validated_payload(&envelope)?;

	Ok((envelope, payload))
}

fn decode_validated_payload(
	envelope: &SubmissionEnvelope,
) -> Result<ValidatedSubmissionPayload, SubmissionError> {
	match envelope.payload_type.as_str() {
		RUN_PAYLOAD_TYPE => {
			let run: RunRecord =
				serde_json::from_value(envelope.payload.clone()).map_err(|error| {
					SubmissionError::new(
						SubmissionOutcomeKind::Configuration,
						format!("signed package payload is not a RunRecord: {error}"),
					)
				})?;

			run_validation::validate_run_record(&run, None).map_err(|error| {
				SubmissionError::new(
					SubmissionOutcomeKind::Configuration,
					format!("signed package RunRecord validation failed: {error}"),
				)
			})?;

			require_packaged_execution_concurrency(run.execution_concurrency, "Official")?;
			validate_run_signer_binding(&run, &envelope.signer.node_id)?;

			Ok(ValidatedSubmissionPayload::Official(run))
		},
		CALIBRATION_RUN_PAYLOAD_TYPE => {
			if envelope.claimed_trust != TrustTier::Untrusted {
				return Err(SubmissionError::new(
					SubmissionOutcomeKind::Configuration,
					"calibration packages must claim untrusted handling",
				));
			}

			let run: CalibrationRunRecord = serde_json::from_value(envelope.payload.clone())
				.map_err(|error| {
					SubmissionError::new(
						SubmissionOutcomeKind::Configuration,
						format!("signed package payload is not a CalibrationRunRecord: {error}"),
					)
				})?;

			run_validation::validate_calibration_run_record(&run).map_err(|error| {
				SubmissionError::new(
					SubmissionOutcomeKind::Configuration,
					format!("signed package CalibrationRunRecord validation failed: {error}"),
				)
			})?;

			require_packaged_execution_concurrency(run.execution_concurrency, "calibration")?;
			validate_calibration_signer_binding(&run, &envelope.signer.node_id)?;

			Ok(ValidatedSubmissionPayload::Calibration(run))
		},
		_ => Err(SubmissionError::new(
			SubmissionOutcomeKind::Configuration,
			"signed package payload type is unsupported",
		)),
	}
}

fn require_packaged_execution_concurrency(
	execution_concurrency: Option<usize>,
	classification: &str,
) -> Result<(), SubmissionError> {
	if execution_concurrency.is_some_and(|jobs| (1..=MAX_RUN_JOBS).contains(&jobs)) {
		Ok(())
	} else {
		Err(SubmissionError::new(
			SubmissionOutcomeKind::Configuration,
			format!("{classification} packages require a bound execution concurrency"),
		))
	}
}

fn artifact_kind_limit(kind: &str) -> Option<usize> {
	match kind {
		"workspace-manifest.json" | "workspace-snapshot.json" => Some(MAX_ARTIFACT_BYTES),
		"evaluator-results.json" => Some(MAX_EVALUATOR_RESULTS_BUNDLE_BYTES),
		"final-response.txt" | "stderr.txt" | "stdout.jsonl" => Some(MAX_SUBMISSION_BYTES),
		_ => None,
	}
}

fn collect_artifact_references(
	payload: &ValidatedSubmissionPayload,
) -> Result<BTreeMap<(String, String), u64>, SubmissionError> {
	let result_artifacts = payload
		.results()
		.iter()
		.flat_map(|result| result.artifacts.iter().chain(result.workspace_manifest.iter()));
	let preflight_artifacts = payload.capability_validation().into_iter().flat_map(|report| {
		report.models.iter().flat_map(|validation| validation.probe.artifacts.iter())
	});
	let mut references = BTreeMap::new();

	for artifact in iter::once(payload.evaluator_results_artifact())
		.chain(result_artifacts)
		.chain(preflight_artifacts)
	{
		let digest = artifact.content_hash.strip_prefix("sha256:").ok_or_else(|| {
			SubmissionError::new(
				SubmissionOutcomeKind::Configuration,
				"artifact content hash is not a SHA-256 address",
			)
		})?;

		if digest.len() != 64
			|| !digest.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
			|| artifact_kind_limit(&artifact.kind).is_none()
			|| artifact.uri != format!("aiq-artifact://sha256/{digest}/{}", artifact.kind)
			|| artifact.bytes == 0
		{
			return Err(SubmissionError::new(
				SubmissionOutcomeKind::Configuration,
				"artifact reference is not a supported canonical content address",
			));
		}

		let key = (artifact.kind.clone(), digest.to_owned());

		if references.insert(key, artifact.bytes).is_some_and(|bytes| bytes != artifact.bytes) {
			return Err(SubmissionError::new(
				SubmissionOutcomeKind::Configuration,
				"duplicate artifact reference has conflicting byte counts",
			));
		}
	}

	Ok(references)
}

fn canonical_artifact_root(root: &Path) -> Result<PathBuf, SubmissionError> {
	let metadata = fs::symlink_metadata(root).map_err(|error| {
		SubmissionError::new(
			SubmissionOutcomeKind::Configuration,
			format!("artifact root is unavailable: {error}"),
		)
	})?;

	if metadata.file_type().is_symlink() || !metadata.is_dir() {
		return Err(SubmissionError::new(
			SubmissionOutcomeKind::Configuration,
			"artifact root must be a regular directory",
		));
	}

	fs::canonicalize(root).map_err(|error| {
		SubmissionError::new(
			SubmissionOutcomeKind::Configuration,
			format!("artifact root is unavailable: {error}"),
		)
	})
}

fn read_artifact(
	root: &Path,
	kind: &str,
	digest: &str,
	expected_bytes: u64,
) -> Result<Vec<u8>, SubmissionError> {
	let limit = artifact_kind_limit(kind).ok_or_else(|| {
		SubmissionError::new(
			SubmissionOutcomeKind::Configuration,
			"artifact kind is not accepted by the ingress contract",
		)
	})?;

	if expected_bytes > u64::try_from(limit).unwrap_or(u64::MAX) {
		return Err(SubmissionError::new(
			SubmissionOutcomeKind::Configuration,
			"artifact exceeds its ingress byte limit",
		));
	}

	let directory = root.join(digest);
	let directory_metadata = fs::symlink_metadata(&directory).map_err(|error| {
		SubmissionError::new(
			SubmissionOutcomeKind::Configuration,
			format!("artifact digest directory is unavailable: {error}"),
		)
	})?;

	if directory_metadata.file_type().is_symlink() || !directory_metadata.is_dir() {
		return Err(SubmissionError::new(
			SubmissionOutcomeKind::Configuration,
			"artifact digest directory must be a regular directory",
		));
	}

	let path = directory.join(kind);
	let metadata = fs::symlink_metadata(&path).map_err(|error| {
		SubmissionError::new(
			SubmissionOutcomeKind::Configuration,
			format!("artifact object is unavailable: {error}"),
		)
	})?;

	if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() != expected_bytes
	{
		return Err(SubmissionError::new(
			SubmissionOutcomeKind::Configuration,
			"artifact object type or byte count does not match its signed reference",
		));
	}

	let canonical_path = fs::canonicalize(&path).map_err(|error| {
		SubmissionError::new(
			SubmissionOutcomeKind::Configuration,
			format!("artifact object is unavailable: {error}"),
		)
	})?;

	if !canonical_path.starts_with(root) {
		return Err(SubmissionError::new(
			SubmissionOutcomeKind::Configuration,
			"artifact object escapes the controlled artifact root",
		));
	}

	let bytes = fs::read(canonical_path).map_err(|error| {
		SubmissionError::new(
			SubmissionOutcomeKind::Configuration,
			format!("artifact object cannot be read: {error}"),
		)
	})?;

	if bytes.len() != usize::try_from(expected_bytes).unwrap_or(usize::MAX)
		|| hex::encode(Sha256::digest(&bytes)) != digest
	{
		return Err(SubmissionError::new(
			SubmissionOutcomeKind::Configuration,
			"artifact object bytes do not match their signed content address",
		));
	}

	Ok(bytes)
}

fn submit_signed_package_with_artifacts_policy<T>(
	transport: &T,
	endpoint: &str,
	body: Vec<u8>,
	artifact_root: &Path,
	bearer_token: SecretToken,
	allow_loopback_http: bool,
) -> Result<SubmissionBundleOutcome, SubmissionError>
where
	T: ArtifactUploadTransport + SubmissionTransport,
{
	validate_endpoint(endpoint, allow_loopback_http)?;

	let (envelope, payload) = validate_signed_package(&body)?;
	let root = canonical_artifact_root(artifact_root)?;
	let references = collect_artifact_references(&payload)?;
	let mut stored = 0;
	let mut duplicate = 0;

	for ((kind, digest), expected_bytes) in &references {
		let bytes = read_artifact(&root, kind, digest, *expected_bytes)?;
		let response = transport
			.upload(&ArtifactUploadRequest {
				url: format!("{}/api/artifacts", endpoint.trim_end_matches('/')),
				body: bytes,
				idempotency_key: envelope.idempotency_key.clone(),
				kind: kind.clone(),
				digest: digest.clone(),
				bearer_token: bearer_token.duplicate(),
			})
			.map_err(|failure| {
				SubmissionError::new(
					match failure.kind {
						TransportFailureKind::Network => SubmissionOutcomeKind::Network,
						TransportFailureKind::Timeout => SubmissionOutcomeKind::Timeout,
					},
					failure.message,
				)
			})?;

		match response.status {
			200..=207 | 209..=299 => stored += 1,
			208 => duplicate += 1,
			409 => {
				return Err(SubmissionError::new(
					SubmissionOutcomeKind::Conflict,
					"artifact ingress reported an immutable content-address conflict",
				));
			},
			400..=499 => {
				return Err(SubmissionError::new(
					SubmissionOutcomeKind::ClientError,
					format!(
						"artifact ingress rejected the signed reference with HTTP {}",
						response.status
					),
				));
			},
			500..=599 => {
				return Err(SubmissionError::new(
					SubmissionOutcomeKind::ServerError,
					format!("artifact ingress is unavailable with HTTP {}", response.status),
				));
			},
			_ => {
				return Err(SubmissionError::new(
					SubmissionOutcomeKind::Network,
					"artifact ingress returned an invalid HTTP status",
				));
			},
		}
	}

	let package = submit_signed_package_policy(
		transport,
		endpoint,
		body,
		bearer_token.duplicate(),
		allow_loopback_http,
	)?;

	Ok(SubmissionBundleOutcome {
		schema_version: "aiq.submission-outcome.v1",
		artifacts_total: references.len(),
		artifacts_stored: stored,
		artifacts_duplicate: duplicate,
		package,
	})
}

fn submit_signed_package_policy<T>(
	transport: &T,
	endpoint: &str,
	body: Vec<u8>,
	bearer_token: SecretToken,
	allow_loopback_http: bool,
) -> Result<SubmissionOutcome, SubmissionError>
where
	T: SubmissionTransport,
{
	validate_endpoint(endpoint, allow_loopback_http)?;

	let (envelope, _) = validate_signed_package(&body)?;
	let idempotency_key = envelope.idempotency_key;
	let url = format!("{}/api/submissions", endpoint.trim_end_matches('/'));
	let response = transport
		.send(&SubmissionRequest { url, body, idempotency_key, bearer_token })
		.map_err(|failure| {
			SubmissionError::new(
				match failure.kind {
					TransportFailureKind::Network => SubmissionOutcomeKind::Network,
					TransportFailureKind::Timeout => SubmissionOutcomeKind::Timeout,
				},
				failure.message,
			)
		})?;
	let kind = match response.status {
		200..=207 | 209..=299 => SubmissionOutcomeKind::Accepted,
		208 => SubmissionOutcomeKind::Duplicate,
		409 => SubmissionOutcomeKind::Conflict,
		400..=499 => SubmissionOutcomeKind::ClientError,
		500..=599 => SubmissionOutcomeKind::ServerError,
		_ => SubmissionOutcomeKind::Network,
	};

	Ok(SubmissionOutcome {
		kind,
		status: Some(response.status),
		server_disposition: "Accepted packages enter an unverified queue. Official eligibility requires a separate verifier attestation."
			.to_owned(),
	})
}

fn validate_endpoint(endpoint: &str, allow_loopback_http: bool) -> Result<(), SubmissionError> {
	let uri = endpoint.parse::<Uri>().map_err(|_| {
		SubmissionError::new(
			SubmissionOutcomeKind::Configuration,
			"submission endpoint must be an absolute origin",
		)
	})?;
	let scheme = uri.scheme_str();
	let host = uri.host();
	let path_and_query = uri.path_and_query().map(PathAndQuery::as_str);
	let is_origin_path = matches!(path_and_query, None | Some("") | Some("/"));
	let loopback = matches!(host, Some("localhost" | "127.0.0.1" | "::1" | "[::1]"));
	let allowed_scheme =
		scheme == Some("https") || (allow_loopback_http && scheme == Some("http") && loopback);

	if uri.authority().is_none() || !is_origin_path || !allowed_scheme {
		return Err(SubmissionError::new(
			SubmissionOutcomeKind::Configuration,
			"submission endpoint must use HTTPS; test HTTP is limited to a loopback origin",
		));
	}

	Ok(())
}

fn transport_url_is_allowed(url: &str, allow_loopback_http: bool) -> bool {
	let Ok(uri) = url.parse::<Uri>() else {
		return false;
	};

	uri.scheme_str() == Some("https")
		|| (allow_loopback_http
			&& uri.scheme_str() == Some("http")
			&& matches!(uri.host(), Some("localhost" | "127.0.0.1" | "::1" | "[::1]")))
}

#[cfg(test)]
mod tests {
	use std::slice;
	use std::{
		cell::RefCell,
		collections::{BTreeMap, BTreeSet},
		env, fs,
		path::PathBuf,
		process,
		time::{SystemTime, UNIX_EPOCH},
	};

	use serde_json;
	use sha2::{Digest, Sha256};

	use crate::scoring;
	use crate::{
		adapter::{
			self, ArtifactReference, ArtifactSink, AuthenticationProbe, CapabilityValidation,
			CapabilityValidationReport, CapabilityValidationStatus, CliProbe, ConfigurationProbe,
			ConfigurationProbeStatus, LocalArtifactSink, ProbeStatus,
		},
		corpus_commitment,
		model::MODEL_MATRIX,
		protocol::{self, SigningIdentity, SubmissionEnvelope, TrustTier},
		resume, run_validation,
		runner::{
			self, CalibrationRunRecord, EvaluationOutcome, FailureKind, MAX_RESULT_PREVIEW_BYTES,
			ResultFailure, ResultStatus, ToolUsage,
		},
		schedule::{ScheduleConfig, ScheduleOccurrence},
		scoring::{AIQ_CORE_V1_TASK_IDENTITY_SHA256, AIQ_TASK_SET_VERSION},
		submission::{
			self, ArtifactUploadRequest, ArtifactUploadTransport, MAX_SUBMISSION_BYTES,
			SecretToken, SubmissionOutcomeKind, SubmissionRequest, SubmissionTransport,
			TransportFailure, TransportFailureKind, TransportResponse,
		},
		task::{self, EvaluatorCheck, EvaluatorCheckFailureClass},
	};

	struct FakeTransport {
		status: u16,
		request: RefCell<Option<(String, String, usize)>>,
	}

	struct FailingTransport(TransportFailureKind);

	struct BundleTransport {
		artifact_status: u16,
		submission_status: u16,
		events: RefCell<Vec<String>>,
	}

	impl SubmissionTransport for FailingTransport {
		fn send(
			&self,
			_request: &SubmissionRequest,
		) -> Result<TransportResponse, TransportFailure> {
			Err(TransportFailure { kind: self.0, message: "transport fixture".to_owned() })
		}
	}

	impl SubmissionTransport for FakeTransport {
		fn send(&self, request: &SubmissionRequest) -> Result<TransportResponse, TransportFailure> {
			*self.request.borrow_mut() =
				Some((request.url.clone(), request.idempotency_key.clone(), request.body.len()));

			Ok(TransportResponse { status: self.status })
		}
	}

	impl SubmissionTransport for BundleTransport {
		fn send(&self, request: &SubmissionRequest) -> Result<TransportResponse, TransportFailure> {
			self.events.borrow_mut().push(format!(
				"package:{}:{}",
				request.idempotency_key,
				request.body.len()
			));

			Ok(TransportResponse { status: self.submission_status })
		}
	}

	impl ArtifactUploadTransport for BundleTransport {
		fn upload(
			&self,
			request: &ArtifactUploadRequest,
		) -> Result<TransportResponse, TransportFailure> {
			self.events.borrow_mut().push(format!(
				"artifact:{}:{}:{}",
				request.kind,
				request.digest,
				request.body.len()
			));

			Ok(TransportResponse { status: self.artifact_status })
		}
	}

	fn temporary_root(label: &str) -> PathBuf {
		let nonce = SystemTime::now().duration_since(UNIX_EPOCH).expect("fixture clock").as_nanos();

		env::temp_dir().join(format!("aiq-submission-{label}-{}-{nonce}", process::id()))
	}

	fn signed_body() -> Vec<u8> {
		signed_body_with_sink(&runner::TestArtifactSink)
	}

	fn signed_body_with_sink<S>(sink: &S) -> Vec<u8>
	where
		S: ArtifactSink,
	{
		let identity = SigningIdentity::from_secret([9; 32]);
		let mut run = runner::synthetic_demo(
			ScheduleConfig::default()
				.slot("2024-02-29", ScheduleOccurrence::Day)
				.expect("fixture slot"),
			sink,
		)
		.expect("fixture run");

		submission::bind_synthetic_run_to_signer(&mut run, &identity.node().node_id)
			.expect("synthetic fixture must bind");

		let envelope = identity
			.sign(&run.run_id, protocol::RUN_PAYLOAD_TYPE, &run, TrustTier::Untrusted)
			.expect("fixture must sign");

		protocol::canonical_json(&envelope).expect("fixture must serialize")
	}

	fn signed_body_with_artifact(root: &PathBuf, bytes: &[u8]) -> Vec<u8> {
		let sink = LocalArtifactSink::new(root).expect("fixture sink");
		let reference = sink.put("stdout.jsonl", bytes).expect("fixture artifact");
		let identity = SigningIdentity::from_secret([9; 32]);
		let mut run = runner::synthetic_demo(
			ScheduleConfig::default()
				.slot("2024-02-29", ScheduleOccurrence::Day)
				.expect("fixture slot"),
			&sink,
		)
		.expect("fixture run");

		run.results[0].artifacts.push(reference.clone());
		run.results[1].artifacts.push(reference);

		submission::bind_synthetic_run_to_signer(&mut run, &identity.node().node_id)
			.expect("synthetic fixture must bind");

		let envelope = identity
			.sign(&run.run_id, protocol::RUN_PAYLOAD_TYPE, &run, TrustTier::Untrusted)
			.expect("fixture must sign");

		submission::serialize_signed_package(&envelope).expect("fixture package")
	}

	fn signed_body_with_preflight_artifact(
		root: &PathBuf,
		probe_output: &[u8],
	) -> (Vec<u8>, ArtifactReference) {
		assert!(probe_output.len() > adapter::MAX_INLINE_PREVIEW_BYTES);

		let sink = LocalArtifactSink::new(root).expect("fixture sink");
		let preflight_artifact =
			sink.put("stdout.jsonl", probe_output).expect("preflight artifact");
		let workspace_snapshot =
			sink.put("workspace-snapshot.json", b"{}").expect("workspace snapshot");
		let workspace_manifest =
			sink.put("workspace-manifest.json", b"{}").expect("workspace manifest");
		let identity = SigningIdentity::from_secret([8; 32]);
		let node_id = identity.node().node_id.clone();
		let codex_version = "codex fixture".to_owned();
		let preview = String::from_utf8(probe_output[..adapter::MAX_INLINE_PREVIEW_BYTES].to_vec())
			.expect("ASCII fixture preview");
		let models = MODEL_MATRIX
			.into_iter()
			.map(|model| {
				let observed_at = "unix-ms:1".to_owned();
				let evidence_digest = adapter::configuration_evidence_digest(
					model,
					Some(&codex_version),
					&observed_at,
					ConfigurationProbeStatus::Available,
					Some(&preflight_artifact.content_hash),
					Some(&preview),
					slice::from_ref(&preflight_artifact),
					None,
				)
				.expect("preflight evidence digest");

				CapabilityValidation {
					model,
					status: CapabilityValidationStatus::Available,
					reason: "active probe succeeded".to_owned(),
					probe: ConfigurationProbe {
						status: ConfigurationProbeStatus::Available,
						codex_version: Some(codex_version.clone()),
						observed_at,
						result_digest: Some(preflight_artifact.content_hash.clone()),
						result_preview: Some(preview.clone()),
						artifacts: vec![preflight_artifact.clone()],
						evidence_digest,
						failure: None,
					},
				}
			})
			.collect();
		let mut run = runner::synthetic_demo(
			ScheduleConfig::default()
				.slot("2024-02-29", ScheduleOccurrence::Day)
				.expect("fixture slot"),
			&sink,
		)
		.expect("fixture run");

		run.synthetic = false;
		run.run_id = resume::classified_run_id(
			&run.schedule_slot,
			&run.task_set_hash,
			&format!("sha256:{}", "1".repeat(64)),
			&run.models,
			corpus_commitment::RunClass::Official,
		)
		.expect("official run id");
		run.capability_validation = Some(CapabilityValidationReport {
			schema_version: "aiq.capability-validation.v2".to_owned(),
			node_id: node_id.clone(),
			manifest_issues: Vec::new(),
			cli_probe: CliProbe {
				status: ProbeStatus::Available,
				version: Some(codex_version.clone()),
				failure: None,
			},
			authentication_probe: AuthenticationProbe {
				status: ProbeStatus::Available,
				mode: Some("chatgpt_subscription".to_owned()),
				failure: None,
			},
			models,
		});

		let preflight_digest =
			protocol::canonical_hash(run.capability_validation.as_ref().expect("report"))
				.expect("preflight digest");

		run.provenance = Some(corpus_commitment::fixture_run_provenance(
			run.task_set_hash.clone(),
			format!("sha256:{}", "8".repeat(64)),
			format!("sha256:{}", "9".repeat(64)),
			preflight_digest,
		));

		for result in &mut run.results {
			result.run_id.clone_from(&run.run_id);
			result.provenance.node_id.clone_from(&node_id);
			result.provenance.codex_version.clone_from(&codex_version);

			result.provenance.observed_at = "unix-ms:1".to_owned();
			result.provenance.synthetic = false;

			result.artifacts.push(workspace_snapshot.clone());

			result.workspace_manifest = Some(workspace_manifest.clone());
			result.result_id = format!(
				"result_{}",
				result.content_hash().expect("result hash").trim_start_matches("sha256:")
			);
		}

		let envelope = identity
			.sign(&run.run_id, protocol::RUN_PAYLOAD_TYPE, &run, TrustTier::Untrusted)
			.expect("fixture must sign");
		let body = submission::serialize_signed_package(&envelope).expect("fixture package");

		(body, preflight_artifact)
	}

	fn maximum_preflight(node_id: String, codex_version: String) -> CapabilityValidationReport {
		let models = MODEL_MATRIX
			.into_iter()
			.map(|model| {
				let preview = "\0".repeat(adapter::MAX_INLINE_PREVIEW_BYTES);
				let result_digest =
					format!("sha256:{}", hex::encode(Sha256::digest(preview.as_bytes())));
				let observed_at = format!("unix-ms:{}", u128::MAX);
				let artifacts = vec![
					ArtifactReference {
						kind: "stdout.jsonl".to_owned(),
						content_hash: result_digest.clone(),
						uri: format!(
							"aiq-artifact://sha256/{}/stdout.jsonl",
							result_digest.trim_start_matches("sha256:")
						),
						bytes: 4 * 1_024 * 1_024,
					},
					ArtifactReference {
						kind: "stderr.txt".to_owned(),
						content_hash: format!("sha256:{}", "f".repeat(64)),
						uri: format!("aiq-artifact://sha256/{}/stderr.txt", "f".repeat(64)),
						bytes: 4 * 1_024 * 1_024,
					},
				];
				let evidence_digest = adapter::configuration_evidence_digest(
					model,
					Some(&codex_version),
					&observed_at,
					ConfigurationProbeStatus::Available,
					Some(&result_digest),
					Some(&preview),
					&artifacts,
					None,
				)
				.expect("preflight digest");

				CapabilityValidation {
					model,
					status: CapabilityValidationStatus::Available,
					reason: "R".repeat(128),
					probe: ConfigurationProbe {
						status: ConfigurationProbeStatus::Available,
						codex_version: Some(codex_version.to_owned()),
						observed_at,
						result_digest: Some(result_digest),
						result_preview: Some(preview),
						artifacts,
						evidence_digest,
						failure: None,
					},
				}
			})
			.collect();

		CapabilityValidationReport {
			schema_version: "aiq.capability-validation.v2".to_owned(),
			node_id,
			manifest_issues: Vec::new(),
			cli_probe: CliProbe {
				status: ProbeStatus::Available,
				version: Some(codex_version.to_owned()),
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

	fn maximize_completed_result(
		result: &mut runner::TaskResult,
		node_id: &str,
		codex_version: &str,
		task_ids: &BTreeMap<String, String>,
	) {
		let artifact = |kind: &str, marker: char| {
			let digest = marker.to_string().repeat(64);

			ArtifactReference {
				kind: kind.to_owned(),
				content_hash: format!("sha256:{digest}"),
				uri: format!("aiq-artifact://sha256/{digest}/{kind}"),
				bytes: 4 * 1_024 * 1_024,
			}
		};

		result.task_id = task_ids.get(&result.task_id).expect("fixture task identifier").clone();
		result.task_version = "v".repeat(32);
		result.evaluation = EvaluationOutcome::Incorrect;
		result.task_score = Some(0.0);
		result.response = Some("\0".repeat(MAX_RESULT_PREVIEW_BYTES));
		result.response_sha256 = Some(format!("sha256:{}", "c".repeat(64)));
		result.artifacts = vec![
			artifact("stdout.jsonl", 'a'),
			artifact("stderr.txt", 'b'),
			artifact("final-response.txt", 'c'),
			artifact("workspace-snapshot.json", 'd'),
		];
		result.workspace_manifest = Some(artifact("workspace-manifest.json", 'e'));
		result.tool_usage = ToolUsage {
			steps: u32::MAX,
			total_calls: u32::MAX,
			by_tool: BTreeMap::from([
				(format!("a{}", "a".repeat(31)), u32::MAX),
				(format!("b{}", "b".repeat(31)), u32::MAX),
				(format!("c{}", "c".repeat(31)), u32::MAX),
				(format!("d{}", "d".repeat(31)), u32::MAX),
			]),
			provider_tokens: runner::ProviderTokenUsage::default(),
		};
		result.latency.wall_ms = 9_007_199_254_740_991;
		result.evaluator_checks = (0..6)
			.map(|index| EvaluatorCheck {
				check_id: char::from(b'a' + index).to_string().repeat(128),
				weight: u32::MAX,
				passed: false,
				failure_class: EvaluatorCheckFailureClass::Structural,
				evidence_digest: format!(
					"sha256:{}",
					char::from(b'1' + index).to_string().repeat(64)
				),
			})
			.collect();

		result.bind_evaluator_result_digest().expect("evaluator-result digest");

		result.provenance.node_id = node_id.to_owned();
		result.provenance.codex_version = codex_version.to_owned();
		result.provenance.runner_version = "R".repeat(32);
		result.provenance.observed_at = format!("unix-ms:{}", u128::MAX);
		result.provenance.synthetic = false;
		result.result_id = format!(
			"result_{}",
			result.content_hash().expect("fixture result hash").trim_start_matches("sha256:")
		);
	}

	fn maximum_completed_shape()
	-> (SigningIdentity, runner::RunRecord, BTreeMap<String, String>, usize) {
		let identity = SigningIdentity::from_secret([7; 32]);
		let node_id = identity.node().node_id.clone();
		let codex_version = "V".repeat(adapter::MAX_CODEX_VERSION_BYTES);
		let mut run = runner::synthetic_demo(
			ScheduleConfig::default()
				.slot("2024-02-29", ScheduleOccurrence::Day)
				.expect("fixture slot"),
			&runner::TestArtifactSink,
		)
		.expect("fixture run");

		run.synthetic = false;
		run.schedule_slot = ScheduleConfig {
			schema_version: "aiq.schedule.v1".to_owned(),
			timezone: "America/Argentina/ComodRivadavia".to_owned(),
			day_local_time: "10:00".to_owned(),
			night_local_time: "22:00".to_owned(),
		}
		.slot("2024-02-29", ScheduleOccurrence::Night)
		.expect("maximum fixture slot");
		run.started_unix_ms = 9_007_199_254_740_991;
		run.finished_unix_ms = 9_007_199_254_740_991;
		run.run_id = resume::classified_run_id(
			&run.schedule_slot,
			&run.task_set_hash,
			&format!("sha256:{}", "1".repeat(64)),
			&run.models,
			corpus_commitment::RunClass::Official,
		)
		.expect("official run id");
		run.capability_validation = Some(maximum_preflight(node_id.clone(), codex_version.clone()));

		let preflight_digest =
			protocol::canonical_hash(run.capability_validation.as_ref().expect("report"))
				.expect("preflight digest");

		run.provenance = Some(corpus_commitment::fixture_run_provenance(
			run.task_set_hash.clone(),
			format!("sha256:{}", "8".repeat(64)),
			format!("sha256:{}", "9".repeat(64)),
			preflight_digest,
		));
		run.provenance.as_mut().expect("maximum fixture provenance").corpus_release_id =
			format!("corpus_{}", "a".repeat(64));

		let task_ids = run
			.results
			.iter()
			.map(|result| result.task_id.clone())
			.collect::<BTreeSet<_>>()
			.into_iter()
			.enumerate()
			.map(|(index, task_id)| (task_id, format!("{}{:03}", "t".repeat(61), index)))
			.collect::<BTreeMap<_, _>>();

		for result in &mut run.results {
			result.run_id.clone_from(&run.run_id);

			maximize_completed_result(result, &node_id, &codex_version, &task_ids);
		}

		let (_, evaluator_results_bytes) =
			runner::build_evaluator_results_bundle(&run.results).expect("maximum bundle");

		run.evaluator_results_artifact = runner::TestArtifactSink
			.put("evaluator-results.json", &evaluator_results_bytes)
			.expect("maximum bundle reference");

		(identity, run, task_ids, evaluator_results_bytes.len())
	}

	fn replace_evaluator_checks(
		result: &mut runner::TaskResult,
		check_count: usize,
		maximum_width: bool,
	) {
		result.evaluator_checks = (0..check_count)
			.map(|index| {
				let prefix = format!("check-{index:02}");
				let check_id = if maximum_width {
					format!("{prefix}{}", "x".repeat(128 - prefix.len()))
				} else {
					prefix
				};
				let marker = format!("{:x}", index % 15 + 1);

				EvaluatorCheck {
					check_id,
					weight: if maximum_width { u32::MAX } else { 1 },
					passed: false,
					failure_class: EvaluatorCheckFailureClass::Value,
					evidence_digest: format!("sha256:{}", marker.repeat(64)),
				}
			})
			.collect();
		result.evaluation = EvaluationOutcome::Incorrect;
		result.task_score = Some(0.0);

		result.bind_evaluator_result_digest().expect("replacement evaluator-result digest");
	}

	fn maximum_calibration_envelope(
		identity: &SigningIdentity,
		failed_run: &runner::RunRecord,
	) -> SubmissionEnvelope {
		let mut provenance = failed_run.provenance.clone().expect("maximum fixture provenance");

		provenance.run_class = corpus_commitment::RunClass::Calibration;
		provenance.permission_evidence_digest = format!("sha256:{}", "e".repeat(64));

		let run_id = resume::classified_run_id(
			&failed_run.schedule_slot,
			&failed_run.task_set_hash,
			&provenance.corpus_commitment_sha256,
			&failed_run.models,
			corpus_commitment::RunClass::Calibration,
		)
		.expect("calibration run id");
		let mut results = failed_run.results.clone();
		let task_count = results.len() / failed_run.models.len();
		let selected_task_ids =
			results[..task_count].iter().map(|result| result.task_id.clone()).collect();

		for result in &mut results {
			result.run_id.clone_from(&run_id);

			result.result_id = format!(
				"result_{}",
				result
					.content_hash()
					.expect("calibration result hash")
					.trim_start_matches("sha256:")
			);
		}

		let calibration = CalibrationRunRecord {
			schema_version: runner::CALIBRATION_RUN_SCHEMA_VERSION.to_owned(),
			official_eligible: false,
			classification: "local_calibration_non_official".to_owned(),
			run_id: run_id.clone(),
			schedule_slot: failed_run.schedule_slot.clone(),
			task_set_hash: failed_run.task_set_hash.clone(),
			scoring_version: failed_run.scoring_version.clone(),
			execution_concurrency: failed_run.execution_concurrency,
			models: failed_run.models.clone(),
			task_ids: selected_task_ids,
			started_unix_ms: failed_run.started_unix_ms,
			finished_unix_ms: failed_run.finished_unix_ms,
			capability_validation: failed_run
				.capability_validation
				.clone()
				.expect("maximum fixture preflight"),
			provenance,
			evaluator_results_artifact: failed_run.evaluator_results_artifact.clone(),
			results,
		};

		identity
			.sign(
				&run_id,
				protocol::CALIBRATION_RUN_PAYLOAD_TYPE,
				&calibration,
				TrustTier::Untrusted,
			)
			.expect("calibration fixture must sign")
	}

	fn maximum_full_shape_envelopes() -> (
		SubmissionEnvelope,
		usize,
		SubmissionEnvelope,
		usize,
		SubmissionEnvelope,
		SubmissionEnvelope,
	) {
		let (identity, run, _task_ids, evaluator_results_bytes) = maximum_completed_shape();
		let completed = identity
			.sign(&run.run_id, protocol::RUN_PAYLOAD_TYPE, &run, TrustTier::Untrusted)
			.expect("completed fixture must sign");
		let mut failed_run = run;

		for result in &mut failed_run.results {
			result.status = ResultStatus::Failed;
			result.evaluation = EvaluationOutcome::NotEvaluated;
			result.task_score = None;

			result.evaluator_checks.clear();
			result.bind_evaluator_result_digest().expect("clear evaluator-result digest");

			result.failure = Some(ResultFailure {
				kind: FailureKind::EvaluatorFailure,
				message: "F".repeat(128),
				exit_code: Some(i32::MIN),
				retryable: false,
			});
			result.result_id = format!(
				"result_{}",
				result.content_hash().expect("failed result hash").trim_start_matches("sha256:")
			);
		}

		let (_, failed_evaluator_results_bytes) =
			runner::build_evaluator_results_bundle(&failed_run.results)
				.expect("failed evaluator-results bundle");

		failed_run.evaluator_results_artifact = runner::TestArtifactSink
			.put("evaluator-results.json", &failed_evaluator_results_bytes)
			.expect("failed bundle reference");

		let failed = identity
			.sign(&failed_run.run_id, protocol::RUN_PAYLOAD_TYPE, &failed_run, TrustTier::Untrusted)
			.expect("failed fixture must sign");
		let mut overbound_run = failed_run.clone();

		overbound_run.results[0].failure.as_mut().expect("failed result").message.push('F');

		overbound_run.results[0].result_id = format!(
			"result_{}",
			overbound_run.results[0]
				.content_hash()
				.expect("overbound result hash")
				.trim_start_matches("sha256:")
		);

		let overbound = identity
			.sign(
				&overbound_run.run_id,
				protocol::RUN_PAYLOAD_TYPE,
				&overbound_run,
				TrustTier::Untrusted,
			)
			.expect("overbound fixture must sign");
		let calibration = maximum_calibration_envelope(&identity, &failed_run);

		(
			completed,
			evaluator_results_bytes,
			failed,
			failed_evaluator_results_bytes.len(),
			calibration,
			overbound,
		)
	}

	#[test]
	fn fake_transport_receives_fixed_path_and_idempotency_key() {
		let transport = FakeTransport { status: 202, request: RefCell::new(None) };
		let outcome = submission::submit_signed_package(
			&transport,
			"https://example.vercel.app/",
			signed_body(),
			SecretToken::new("secret".to_owned()).expect("fixture token"),
		)
		.expect("submission must classify");

		assert_eq!(outcome.kind, SubmissionOutcomeKind::Accepted);

		let request = transport.request.borrow();
		let (url, key, _) = request.as_ref().expect("request must be captured");

		assert_eq!(url, "https://example.vercel.app/api/submissions");
		assert_eq!(
			key,
			&serde_json::from_slice::<SubmissionEnvelope>(&signed_body())
				.expect("fixture envelope must deserialize")
				.idempotency_key
		);
	}

	#[test]
	fn loopback_http_submission_requires_explicit_local_policy() {
		let root = temporary_root("loopback-policy");

		fs::create_dir_all(&root).expect("fixture root");

		let sink = LocalArtifactSink::new(&root).expect("fixture sink");
		let blocked = BundleTransport {
			artifact_status: 201,
			submission_status: 202,
			events: RefCell::new(Vec::new()),
		};
		let error = submission::submit_signed_package_with_artifacts(
			&blocked,
			"http://127.0.0.1:3100",
			signed_body_with_sink(&sink),
			&root,
			SecretToken::new("secret".to_owned()).expect("fixture token"),
		)
		.expect_err("loopback HTTP must be opt-in");

		assert_eq!(error.kind(), SubmissionOutcomeKind::Configuration);
		assert!(blocked.events.borrow().is_empty());

		let allowed = BundleTransport {
			artifact_status: 201,
			submission_status: 202,
			events: RefCell::new(Vec::new()),
		};
		let outcome = submission::submit_signed_package_with_artifacts_allowing_loopback(
			&allowed,
			"http://localhost:3100/",
			signed_body_with_sink(&sink),
			&root,
			SecretToken::new("secret".to_owned()).expect("fixture token"),
		)
		.expect("explicit loopback HTTP must be accepted");

		assert_eq!(outcome.package.kind, SubmissionOutcomeKind::Accepted);
		assert_eq!(allowed.events.borrow().len(), 2);

		for endpoint in [
			"http://127.0.0.1.evil.invalid:3100",
			"http://example.invalid",
			"http://127.0.0.1:3100/path",
			"http://127.0.0.1:3100/?query=true",
		] {
			let rejected = BundleTransport {
				artifact_status: 201,
				submission_status: 202,
				events: RefCell::new(Vec::new()),
			};

			assert!(
				submission::submit_signed_package_with_artifacts_allowing_loopback(
					&rejected,
					endpoint,
					signed_body(),
					&root,
					SecretToken::new("secret".to_owned()).expect("fixture token"),
				)
				.is_err(),
				"unsafe endpoint was accepted: {endpoint}"
			);
			assert!(rejected.events.borrow().is_empty());
		}

		fs::remove_dir_all(root).expect("fixture cleanup");
	}

	#[test]
	fn concrete_transport_limits_plain_http_to_loopback_when_enabled() {
		assert!(submission::transport_url_is_allowed(
			"https://example.invalid/api/submissions",
			false
		));
		assert!(!submission::transport_url_is_allowed(
			"http://127.0.0.1:3100/api/submissions",
			false
		));
		assert!(submission::transport_url_is_allowed(
			"http://127.0.0.1:3100/api/submissions",
			true
		));
		assert!(submission::transport_url_is_allowed("http://[::1]:3100/api/submissions", true));
		assert!(!submission::transport_url_is_allowed(
			"http://127.0.0.1.evil.invalid/api/submissions",
			true
		));
	}

	#[test]
	fn artifact_aware_submission_uploads_unique_evidence_before_the_package() {
		let root = temporary_root("artifact-order");
		let body = signed_body_with_artifact(&root, b"{\"type\":\"fixture\"}\n");
		let transport = BundleTransport {
			artifact_status: 201,
			submission_status: 202,
			events: RefCell::new(Vec::new()),
		};
		let outcome = submission::submit_signed_package_with_artifacts(
			&transport,
			"https://example.vercel.app/",
			body,
			&root,
			SecretToken::new("secret".to_owned()).expect("fixture token"),
		)
		.expect("bundle must submit");

		assert_eq!(outcome.artifacts_total, 2);
		assert_eq!(outcome.artifacts_stored, 2);
		assert_eq!(outcome.artifacts_duplicate, 0);
		assert_eq!(outcome.package.kind, SubmissionOutcomeKind::Accepted);

		let events = transport.events.borrow();

		assert_eq!(events.len(), 3);
		assert!(events[0].starts_with("artifact:evaluator-results.json:"));
		assert!(events[1].starts_with("artifact:stdout.jsonl:"));
		assert!(events[2].starts_with("package:run_"));

		fs::remove_dir_all(root).expect("fixture cleanup");
	}

	#[test]
	fn preflight_artifact_is_deduplicated_and_uploaded_before_the_package() {
		let root = temporary_root("preflight-artifact-order");
		let private_suffix = "provider-private-output-must-not-enter-transport-events";
		let probe_output =
			format!("{}-{private_suffix}", "AIQ_PREFLIGHT_OK".repeat(8)).into_bytes();
		let (body, preflight_artifact) = signed_body_with_preflight_artifact(&root, &probe_output);
		let transport = BundleTransport {
			artifact_status: 201,
			submission_status: 202,
			events: RefCell::new(Vec::new()),
		};
		let outcome = submission::submit_signed_package_with_artifacts(
			&transport,
			"https://example.vercel.app/",
			body,
			&root,
			SecretToken::new("secret".to_owned()).expect("fixture token"),
		)
		.expect("bundle must submit");

		assert_eq!(outcome.artifacts_total, 4);
		assert_eq!(outcome.artifacts_stored, 4);
		assert_eq!(outcome.artifacts_duplicate, 0);
		assert_eq!(outcome.package.kind, SubmissionOutcomeKind::Accepted);

		let events = transport.events.borrow();
		let preflight_upload = format!(
			"artifact:stdout.jsonl:{}:{}",
			preflight_artifact.content_hash.trim_start_matches("sha256:"),
			preflight_artifact.bytes
		);

		assert_eq!(events.iter().filter(|event| **event == preflight_upload).count(), 1);
		assert!(events.iter().position(|event| event == &preflight_upload).is_some_and(|index| {
			events
				.iter()
				.position(|event| event.starts_with("package:"))
				.is_some_and(|package_index| index < package_index)
		}));
		assert!(events.iter().all(|event| !event.contains(private_suffix)));

		fs::remove_dir_all(root).expect("fixture cleanup");
	}

	#[test]
	fn missing_preflight_artifact_blocks_package_submission() {
		let root = temporary_root("missing-preflight-artifact");
		let probe_output = "AIQ_PREFLIGHT_OK".repeat(8).into_bytes();
		let (body, preflight_artifact) = signed_body_with_preflight_artifact(&root, &probe_output);
		let digest = preflight_artifact.content_hash.trim_start_matches("sha256:");

		fs::remove_file(root.join(digest).join(&preflight_artifact.kind))
			.expect("remove preflight fixture artifact");

		let transport = BundleTransport {
			artifact_status: 201,
			submission_status: 202,
			events: RefCell::new(Vec::new()),
		};
		let error = submission::submit_signed_package_with_artifacts(
			&transport,
			"https://example.vercel.app/",
			body,
			&root,
			SecretToken::new("secret".to_owned()).expect("fixture token"),
		)
		.expect_err("missing preflight evidence must fail closed");

		assert_eq!(error.kind(), SubmissionOutcomeKind::Configuration);
		assert!(transport.events.borrow().iter().all(|event| !event.starts_with("package:")));

		fs::remove_dir_all(root).expect("fixture cleanup");
	}

	#[test]
	fn preflight_artifact_digest_mismatch_blocks_package_submission() {
		let root = temporary_root("mismatched-preflight-artifact");
		let probe_output = "AIQ_PREFLIGHT_OK".repeat(8).into_bytes();
		let (body, preflight_artifact) = signed_body_with_preflight_artifact(&root, &probe_output);
		let digest = preflight_artifact.content_hash.trim_start_matches("sha256:");

		fs::write(root.join(digest).join(&preflight_artifact.kind), vec![b'x'; probe_output.len()])
			.expect("corrupt preflight fixture artifact");

		let transport = BundleTransport {
			artifact_status: 201,
			submission_status: 202,
			events: RefCell::new(Vec::new()),
		};
		let error = submission::submit_signed_package_with_artifacts(
			&transport,
			"https://example.vercel.app/",
			body,
			&root,
			SecretToken::new("secret".to_owned()).expect("fixture token"),
		)
		.expect_err("mismatched preflight evidence must fail closed");

		assert_eq!(error.kind(), SubmissionOutcomeKind::Configuration);
		assert!(transport.events.borrow().iter().all(|event| !event.starts_with("package:")));

		fs::remove_dir_all(root).expect("fixture cleanup");
	}

	#[test]
	fn synthetic_demo_packages_and_submits_its_evaluator_results_bundle() {
		let root = temporary_root("demo-package-submit");
		let sink = LocalArtifactSink::new(&root).expect("fixture sink");
		let identity = SigningIdentity::from_secret([6; 32]);
		let mut run = runner::synthetic_demo(
			ScheduleConfig::default()
				.slot("2024-02-29", ScheduleOccurrence::Day)
				.expect("fixture slot"),
			&sink,
		)
		.expect("synthetic demo");
		let evaluator_results =
			submission::read_evaluator_results_artifact(&root, &run.evaluator_results_artifact)
				.expect("materialized evaluator results");

		run_validation::validate_evaluator_results_bundle(&run, &evaluator_results)
			.expect("demo evaluator results");
		submission::bind_synthetic_run_to_signer(&mut run, &identity.node().node_id)
			.expect("bind synthetic run");

		let envelope = identity
			.sign(&run.run_id, protocol::RUN_PAYLOAD_TYPE, &run, TrustTier::Untrusted)
			.expect("sign run");
		let package = submission::serialize_signed_package(&envelope).expect("package run");
		let transport = BundleTransport {
			artifact_status: 201,
			submission_status: 202,
			events: RefCell::new(Vec::new()),
		};
		let outcome = submission::submit_signed_package_with_artifacts(
			&transport,
			"https://example.vercel.app",
			package,
			&root,
			SecretToken::new("secret".to_owned()).expect("fixture token"),
		)
		.expect("submit demo");

		assert_eq!(outcome.artifacts_total, 1);
		assert_eq!(outcome.artifacts_stored, 1);
		assert_eq!(outcome.package.kind, SubmissionOutcomeKind::Accepted);
		assert!(transport.events.borrow()[0].starts_with("artifact:evaluator-results.json:"));

		fs::remove_dir_all(root).expect("fixture cleanup");
	}

	#[test]
	fn duplicate_artifact_is_success_and_missing_local_evidence_blocks_the_package() {
		let root = temporary_root("artifact-duplicate");
		let body = signed_body_with_artifact(&root, b"{\"type\":\"fixture\"}\n");
		let duplicate = BundleTransport {
			artifact_status: 208,
			submission_status: 208,
			events: RefCell::new(Vec::new()),
		};
		let outcome = submission::submit_signed_package_with_artifacts(
			&duplicate,
			"https://example.vercel.app",
			body.clone(),
			&root,
			SecretToken::new("secret".to_owned()).expect("fixture token"),
		)
		.expect("exact retry must succeed");

		assert_eq!(outcome.artifacts_duplicate, 2);
		assert_eq!(outcome.package.kind, SubmissionOutcomeKind::Duplicate);

		fs::remove_dir_all(&root).expect("fixture cleanup");

		let missing = BundleTransport {
			artifact_status: 201,
			submission_status: 202,
			events: RefCell::new(Vec::new()),
		};
		let error = submission::submit_signed_package_with_artifacts(
			&missing,
			"https://example.vercel.app",
			body,
			&root,
			SecretToken::new("secret".to_owned()).expect("fixture token"),
		)
		.expect_err("missing local evidence must fail closed");

		assert_eq!(error.kind(), SubmissionOutcomeKind::Configuration);
		assert!(missing.events.borrow().is_empty());
	}

	#[test]
	fn artifact_conflict_stops_before_package_submission() {
		let root = temporary_root("artifact-conflict");
		let body = signed_body_with_artifact(&root, b"{\"type\":\"fixture\"}\n");
		let transport = BundleTransport {
			artifact_status: 409,
			submission_status: 202,
			events: RefCell::new(Vec::new()),
		};
		let error = submission::submit_signed_package_with_artifacts(
			&transport,
			"https://example.vercel.app",
			body,
			&root,
			SecretToken::new("secret".to_owned()).expect("fixture token"),
		)
		.expect_err("immutable object conflict must fail closed");

		assert_eq!(error.kind(), SubmissionOutcomeKind::Conflict);
		assert_eq!(transport.events.borrow().len(), 1);

		fs::remove_dir_all(root).expect("fixture cleanup");
	}

	#[test]
	fn status_classes_include_duplicate_conflict_and_server_error() {
		for (status, expected) in [
			(208, SubmissionOutcomeKind::Duplicate),
			(409, SubmissionOutcomeKind::Conflict),
			(422, SubmissionOutcomeKind::ClientError),
			(503, SubmissionOutcomeKind::ServerError),
		] {
			let transport = FakeTransport { status, request: RefCell::new(None) };
			let outcome = submission::submit_signed_package(
				&transport,
				"https://example.vercel.app",
				signed_body(),
				SecretToken::new("secret".to_owned()).expect("fixture token"),
			)
			.expect("status must classify");

			assert_eq!(outcome.kind, expected);
		}
	}

	#[test]
	fn oversized_package_is_rejected_before_transport() {
		let transport = FakeTransport { status: 202, request: RefCell::new(None) };
		let error = submission::submit_signed_package(
			&transport,
			"https://example.vercel.app",
			vec![0; MAX_SUBMISSION_BYTES + 1],
			SecretToken::new("secret".to_owned()).expect("fixture token"),
		)
		.expect_err("oversized package must fail");

		assert_eq!(error.kind(), SubmissionOutcomeKind::Configuration);
		assert!(transport.request.borrow().is_none());
	}

	#[test]
	fn guarded_package_headroom_is_enforced_before_transport() {
		let transport = FakeTransport { status: 202, request: RefCell::new(None) };
		let error = submission::submit_signed_package(
			&transport,
			"https://example.vercel.app",
			vec![0; submission::MAX_SIGNED_PACKAGE_BYTES + 1],
			SecretToken::new("secret".to_owned()).expect("fixture token"),
		)
		.expect_err("package inside Vercel's hard limit but outside the guard must fail");

		assert_eq!(error.kind(), SubmissionOutcomeKind::Configuration);
		assert!(transport.request.borrow().is_none());
	}

	#[test]
	fn oversized_evaluator_results_reference_and_read_are_rejected() {
		let root = temporary_root("oversized-evaluator-results");

		fs::create_dir(&root).expect("artifact root");

		let reference = ArtifactReference {
			kind: "evaluator-results.json".to_owned(),
			content_hash: format!("sha256:{}", "a".repeat(64)),
			uri: format!("aiq-artifact://sha256/{}/evaluator-results.json", "a".repeat(64)),
			bytes: u64::try_from(runner::MAX_EVALUATOR_RESULTS_BUNDLE_BYTES + 1)
				.expect("bundle limit"),
		};

		assert!(
			submission::read_evaluator_results_artifact(&root, &reference).is_err(),
			"the reader must reject the declared size before reading an object"
		);

		let identity = SigningIdentity::from_secret([4; 32]);
		let mut run = runner::synthetic_demo(
			ScheduleConfig::default()
				.slot("2024-02-29", ScheduleOccurrence::Day)
				.expect("fixture slot"),
			&runner::TestArtifactSink,
		)
		.expect("fixture run");

		run.evaluator_results_artifact = reference;

		submission::bind_synthetic_run_to_signer(&mut run, &identity.node().node_id)
			.expect("bind fixture");

		let envelope = identity
			.sign(&run.run_id, protocol::RUN_PAYLOAD_TYPE, &run, TrustTier::Untrusted)
			.expect("sign fixture");

		assert!(submission::serialize_signed_package(&envelope).is_err());

		fs::remove_dir_all(root).expect("fixture cleanup");
	}

	#[test]
	fn oversized_package_is_rejected_during_construction() {
		let run_id = format!("run_{}", "a".repeat(64));
		let envelope = SigningIdentity::from_secret([3; 32])
			.sign(
				&run_id,
				protocol::RUN_PAYLOAD_TYPE,
				&serde_json::json!({
					"schema_version": protocol::RUN_PAYLOAD_TYPE,
					"run_id": run_id,
					"synthetic": true,
					"results": [],
					"oversized": "x".repeat(MAX_SUBMISSION_BYTES)
				}),
				TrustTier::Untrusted,
			)
			.expect("fixture must sign");

		assert!(submission::serialize_signed_package(&envelope).is_err());
	}

	#[test]
	fn full_1224_result_synthetic_package_fits_transport_bound() {
		let envelope: SubmissionEnvelope =
			serde_json::from_slice(&signed_body()).expect("fixture envelope");
		let bytes = submission::serialize_signed_package(&envelope).expect("demo package must fit");

		assert!(bytes.len() <= MAX_SUBMISSION_BYTES);
		assert_eq!(envelope.payload["results"].as_array().map(Vec::len), Some(1_224));
	}

	#[test]
	fn packaged_official_wire_rejects_missing_execution_concurrency() {
		let envelope: SubmissionEnvelope =
			serde_json::from_slice(&signed_body()).expect("fixture envelope");
		let mut run: runner::RunRecord =
			serde_json::from_value(envelope.payload).expect("fixture run");

		run.execution_concurrency = None;

		let envelope = SigningIdentity::from_secret([9; 32])
			.sign(&run.run_id, protocol::RUN_PAYLOAD_TYPE, &run, TrustTier::Untrusted)
			.expect("missing-concurrency envelope remains structurally signable");

		assert!(submission::serialize_signed_package(&envelope).is_err());
	}

	#[test]
	fn checked_in_v3_fixture_is_a_canonical_rust_verified_full_package() {
		let fixture_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
			.join("../../benchmarks/fixtures/result-package-v3.synthetic.json");
		let fixture = fs::read(fixture_path).expect("checked-in v3 fixture");
		let envelope: SubmissionEnvelope =
			serde_json::from_slice(&fixture).expect("checked-in fixture envelope");
		let canonical = submission::serialize_signed_package(&envelope)
			.expect("checked-in fixture must verify");
		let run: runner::RunRecord =
			serde_json::from_value(envelope.payload.clone()).expect("checked-in fixture run");
		let tasks = runner::synthetic_demo_tasks();
		let scheduled_unix_ms =
			run.schedule_slot.scheduled_unix_ms().expect("checked-in fixture schedule");

		assert_eq!(canonical, fixture);
		assert_eq!(canonical, signed_body());
		assert_eq!(run.started_unix_ms, scheduled_unix_ms);
		assert_eq!(run.finished_unix_ms, scheduled_unix_ms);
		assert_eq!(run.execution_concurrency, Some(1));
		assert_eq!(envelope.payload["models"].as_array().map(Vec::len), Some(17));
		assert_eq!(envelope.payload["results"].as_array().map(Vec::len), Some(1_224));
		assert_eq!(AIQ_TASK_SET_VERSION, "1.0.1");
		assert_eq!(
			AIQ_CORE_V1_TASK_IDENTITY_SHA256,
			"sha256:b7ddfd5aaeb1861db57a72e03dc7e9497e7b4b81a98800c1e299e995270af7bc"
		);
		assert!(tasks.iter().all(|task| task.task_version == AIQ_TASK_SET_VERSION));
		assert!(scoring::task_bindings_match_frozen_catalog(&tasks));
		assert_eq!(
			run.task_set_hash,
			task::task_set_hash(&tasks).expect("current synthetic task-set hash")
		);

		for result in &run.results {
			let expected = tasks
				.iter()
				.find(|task| {
					task.task_id == result.task_id && task.task_version == result.task_version
				})
				.expect("fixture result must bind a current catalog task");

			assert_eq!(result.task_version, AIQ_TASK_SET_VERSION);
			assert_eq!(
				result.task_hash,
				expected.content_hash().expect("current synthetic task hash")
			);
		}
	}

	#[test]
	#[ignore = "explicitly rewrites the checked-in synthetic package fixture"]
	fn regenerate_checked_in_v3_fixture() {
		let fixture_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
			.join("../../benchmarks/fixtures/result-package-v3.synthetic.json");

		fs::write(fixture_path, signed_body()).expect("write checked-in v3 fixture");
	}

	#[test]
	fn maximum_inline_previews_fit_full_1224_result_package() {
		let (
			envelope,
			evaluator_results_bytes,
			failed_envelope,
			failed_bundle_bytes,
			calibration_envelope,
			overbound_envelope,
		) = maximum_full_shape_envelopes();
		let bytes =
			submission::serialize_signed_package(&envelope).expect("bounded package must fit");
		let failed_bytes = submission::serialize_signed_package(&failed_envelope)
			.expect("bounded failure package must fit");

		calibration_envelope.verify(&BTreeSet::new()).expect("calibration envelope must verify");

		let calibration_record: CalibrationRunRecord =
			serde_json::from_value(calibration_envelope.payload.clone())
				.expect("calibration payload");

		run_validation::validate_calibration_run_record(&calibration_record)
			.expect("maximum calibration record must validate");

		let mut missing_concurrency = calibration_record.clone();

		missing_concurrency.execution_concurrency = None;

		let missing_concurrency_envelope = SigningIdentity::from_secret([7; 32])
			.sign(
				&missing_concurrency.run_id,
				protocol::CALIBRATION_RUN_PAYLOAD_TYPE,
				&missing_concurrency,
				TrustTier::Untrusted,
			)
			.expect("missing-concurrency calibration remains structurally signable");

		assert!(submission::serialize_signed_package(&missing_concurrency_envelope).is_err());

		let calibration_bytes = submission::serialize_signed_package(&calibration_envelope)
			.expect("valid calibration package must enter artifact submission");
		let transport = FakeTransport { status: 202, request: RefCell::new(None) };
		let calibration_submission = submission::submit_signed_package(
			&transport,
			"https://example.vercel.app",
			calibration_bytes.clone(),
			SecretToken::new("secret".to_owned()).expect("fixture token"),
		)
		.expect("valid calibration package submission");

		assert_eq!(calibration_submission.kind, SubmissionOutcomeKind::Accepted);
		assert_eq!(bytes.len(), 3_746_354);
		assert_eq!(evaluator_results_bytes, 2_310_969);
		assert_eq!(failed_bundle_bytes, 6_177);
		assert_eq!(failed_bytes.len(), 3_920_159);
		assert_eq!(calibration_bytes.len(), 3_925_081);
		assert!(submission::serialize_signed_package(&overbound_envelope).is_err());
		assert_eq!(envelope.payload["results"].as_array().map(Vec::len), Some(1_224));
		assert!(
			evaluator_results_bytes <= runner::MAX_EVALUATOR_RESULTS_BUNDLE_BYTES,
			"maximum evaluator-results bundle is {evaluator_results_bytes} bytes, guarded limit is {}",
			runner::MAX_EVALUATOR_RESULTS_BUNDLE_BYTES
		);
		assert!(
			bytes.len() <= MAX_SUBMISSION_BYTES - 240 * 1_024,
			"maximum official package is {} bytes, guarded limit is {}",
			bytes.len(),
			MAX_SUBMISSION_BYTES - 240 * 1_024
		);
		assert!(
			failed_bytes.len() <= MAX_SUBMISSION_BYTES - 240 * 1_024,
			"maximum failure package is {} bytes, guarded limit is {}",
			failed_bytes.len(),
			MAX_SUBMISSION_BYTES - 240 * 1_024
		);
		assert!(
			calibration_bytes.len() <= submission::MAX_SIGNED_PACKAGE_BYTES,
			"maximum calibration package is {} bytes, guarded limit is {}",
			calibration_bytes.len(),
			submission::MAX_SIGNED_PACKAGE_BYTES
		);
		assert_eq!(bytes, protocol::canonical_json(&envelope).expect("canonical envelope"));

		let decoded: SubmissionEnvelope =
			serde_json::from_slice(&bytes).expect("canonical package must round-trip");

		decoded.verify(&BTreeSet::new()).expect("round-trip signature must verify");

		assert_eq!(
			submission::serialize_signed_package(&decoded).expect("round-trip package"),
			bytes
		);

		let mut tampered = decoded;

		tampered.payload["results"][0]["response"] = serde_json::json!("tampered");

		assert!(tampered.verify(&BTreeSet::new()).is_err());
	}

	#[test]
	fn sixteen_checks_are_accepted_and_a_mixed_full_matrix_fits_the_bundle_guard() {
		let (_, mut run, _, _) = maximum_completed_shape();

		replace_evaluator_checks(&mut run.results[0], 16, false);

		let (_, one_maximum_bytes) =
			runner::build_evaluator_results_bundle(&run.results).expect("one sixteen-check result");

		run.evaluator_results_artifact = runner::TestArtifactSink
			.put("evaluator-results.json", &one_maximum_bytes)
			.expect("sixteen-check artifact reference");

		run_validation::validate_evaluator_results_bundle(&run, &one_maximum_bytes)
			.expect("sixteen-check result must validate");

		for (index, result) in run.results.iter_mut().enumerate() {
			replace_evaluator_checks(result, 5 + index % 12, false);
		}

		let (_, mixed_bytes) =
			runner::build_evaluator_results_bundle(&run.results).expect("mixed full matrix bundle");

		assert!(
			mixed_bytes.len() <= runner::MAX_EVALUATOR_RESULTS_BUNDLE_BYTES,
			"mixed evaluator-results bundle is {} bytes, guarded limit is {}",
			mixed_bytes.len(),
			runner::MAX_EVALUATOR_RESULTS_BUNDLE_BYTES
		);
	}

	#[test]
	fn maximum_width_sixteen_check_full_matrix_is_rejected_by_the_aggregate_guard() {
		let (_, mut run, _, _) = maximum_completed_shape();

		for result in &mut run.results {
			replace_evaluator_checks(result, 16, true);
		}

		let error = runner::build_evaluator_results_bundle(&run.results)
			.expect_err("maximum legal evaluator evidence must exceed the aggregate guard");

		assert!(error.to_string().contains("maximum is"));
	}

	#[test]
	fn seventeen_checks_are_rejected_before_bundle_serialization() {
		let (_, mut run, _, _) = maximum_completed_shape();

		replace_evaluator_checks(&mut run.results[0], 17, false);

		let error = runner::build_evaluator_results_bundle(&run.results)
			.expect_err("seventeen evaluator checks must fail closed");

		assert!(error.to_string().contains("at most 16 checks"));
	}

	#[test]
	fn package_construction_rejects_signer_provenance_mismatch() {
		let run = runner::synthetic_demo(
			ScheduleConfig::default()
				.slot("2024-02-29", ScheduleOccurrence::Day)
				.expect("fixture slot"),
			&runner::TestArtifactSink,
		)
		.expect("fixture run");
		let envelope = SigningIdentity::from_secret([5; 32])
			.sign(&run.run_id, protocol::RUN_PAYLOAD_TYPE, &run, TrustTier::Untrusted)
			.expect("fixture must sign");

		assert!(submission::serialize_signed_package(&envelope).is_err());
	}

	#[test]
	fn structurally_incomplete_calibration_packages_are_not_submittable() {
		let run_id = "run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
		let payload = serde_json::json!({
			"schema_version": protocol::CALIBRATION_RUN_PAYLOAD_TYPE,
			"run_id": run_id,
			"official_eligible": false,
			"classification": "local_calibration_non_official",
			"provenance": {
				"schema_version": "aiq.run-provenance.v2",
				"run_class": "calibration"
			},
			"results": []
		});
		let envelope = SigningIdentity::from_secret([5; 32])
			.sign(run_id, protocol::CALIBRATION_RUN_PAYLOAD_TYPE, &payload, TrustTier::Untrusted)
			.expect("calibration package must be locally signable");
		let bytes =
			protocol::canonical_json(&envelope).expect("calibration package must serialize");

		envelope.verify(&BTreeSet::new()).expect("calibration signature must verify locally");

		let error = submission::validate_signed_package(&bytes)
			.expect_err("calibration packages must not enter the production submission path");

		assert!(error.to_string().contains("RunRecord"));
	}

	#[test]
	fn secret_debug_output_is_redacted() {
		let token = SecretToken::new("highly-secret".to_owned()).expect("fixture token");

		assert_eq!(format!("{token:?}"), "SecretToken([REDACTED])");
	}

	#[test]
	fn network_and_timeout_failures_remain_distinct() {
		for (transport_kind, outcome_kind) in [
			(TransportFailureKind::Network, SubmissionOutcomeKind::Network),
			(TransportFailureKind::Timeout, SubmissionOutcomeKind::Timeout),
		] {
			let error = submission::submit_signed_package(
				&FailingTransport(transport_kind),
				"https://example.vercel.app",
				signed_body(),
				SecretToken::new("secret".to_owned()).expect("fixture token"),
			)
			.expect_err("transport must fail");

			assert_eq!(error.kind(), outcome_kind);
		}
	}
}
