//! Bounded HTTP transport and origin policy for verifier gateway requests.

use std::{thread, time::Duration};

use ureq::{
	self, Body, Error,
	http::{Response, Uri, uri::PathAndQuery},
};

use crate::{Secret, WorkerError};
use aiq_runner::submission::{MAX_ARTIFACT_BYTES, MAX_SUBMISSION_BYTES};

const MAX_GATEWAY_RESPONSE_BYTES: usize = 64 * 1_024;
const MAX_OBJECT_RESPONSE_BYTES: usize = MAX_SUBMISSION_BYTES + 1;
const MAX_ARTIFACT_RESPONSE_BYTES: usize = MAX_ARTIFACT_BYTES + 1;

pub(super) trait Transport: Sync {
	fn post_json(
		&self,
		url: &str,
		token: &Secret,
		body: &[u8],
	) -> Result<HttpResponse, WorkerError>;
	fn get_object(&self, url: &str) -> Result<HttpResponse, WorkerError>;
	fn get_artifact_object(&self, url: &str) -> Result<HttpResponse, WorkerError>;
}

#[derive(Clone, Debug)]
pub(super) struct HttpResponse {
	pub(super) status: u16,
	pub(super) body: Vec<u8>,
}

pub(super) struct UreqTransport {
	agent: ureq::Agent,
	allow_loopback_http: bool,
}
impl UreqTransport {
	pub(super) fn new(timeout: Duration, allow_loopback_http: bool, replay_jobs: usize) -> Self {
		let config = ureq::Agent::config_builder()
			.timeout_global(Some(timeout))
			.max_idle_connections(replay_jobs)
			.max_idle_connections_per_host(replay_jobs)
			.build();

		Self { agent: config.into(), allow_loopback_http }
	}

	fn validate_url(&self, url: &str) -> Result<(), WorkerError> {
		if transport_url_is_allowed(url, self.allow_loopback_http) {
			Ok(())
		} else {
			Err(WorkerError::configuration("URLs must use HTTPS; test HTTP is limited to loopback"))
		}
	}

	fn collect(
		result: Result<Response<Body>, Error>,
		limit: usize,
	) -> Result<HttpResponse, WorkerError> {
		let mut response = match result {
			Ok(response) => response,
			Err(ureq::Error::StatusCode(status)) => {
				return Ok(HttpResponse { status, body: Vec::new() });
			},
			Err(ureq::Error::Timeout(_)) => {
				return Err(WorkerError::transient("HTTP request timed out"));
			},
			Err(_) => return Err(WorkerError::transient("HTTP transport failed")),
		};
		let status = response.status().as_u16();
		let body = response
			.body_mut()
			.with_config()
			.limit((limit + 1) as u64)
			.read_to_vec()
			.map_err(|_| WorkerError::transient("HTTP response body could not be read"))?;

		if body.len() > limit {
			return Err(WorkerError::transient("HTTP response exceeds its byte limit"));
		}

		Ok(HttpResponse { status, body })
	}
}

impl Transport for UreqTransport {
	fn post_json(
		&self,
		url: &str,
		token: &Secret,
		body: &[u8],
	) -> Result<HttpResponse, WorkerError> {
		self.validate_url(url)?;

		Self::collect(
			self.agent
				.post(url)
				.header("Authorization", &format!("Bearer {}", token.expose()))
				.header("Content-Type", "application/json")
				.send(body),
			MAX_GATEWAY_RESPONSE_BYTES,
		)
	}

	fn get_object(&self, url: &str) -> Result<HttpResponse, WorkerError> {
		self.validate_url(url)?;

		Self::collect(self.agent.get(url).call(), MAX_OBJECT_RESPONSE_BYTES)
	}

	fn get_artifact_object(&self, url: &str) -> Result<HttpResponse, WorkerError> {
		self.validate_url(url)?;

		Self::collect(self.agent.get(url).call(), MAX_ARTIFACT_RESPONSE_BYTES)
	}
}

pub(super) fn retry_transient<R>(
	max_attempts: u32,
	backoff: Duration,
	mut operation: impl FnMut() -> Result<R, WorkerError>,
) -> Result<R, WorkerError> {
	let mut delay = backoff;

	for attempt in 1..=max_attempts {
		match operation() {
			Ok(value) => return Ok(value),
			Err(error) if error.is_transient() && attempt < max_attempts => {
				thread::sleep(delay);

				delay = delay.saturating_mul(2);
			},
			Err(error) => return Err(error),
		}
	}

	Err(WorkerError::transient("retry budget exhausted"))
}

pub(super) fn validate_endpoint(
	endpoint: &str,
	allow_loopback_http: bool,
) -> Result<String, WorkerError> {
	let endpoint = endpoint.trim_end_matches('/');

	if endpoint_origin_is_allowed(endpoint, allow_loopback_http) {
		Ok(endpoint.to_owned())
	} else {
		Err(WorkerError::configuration(
			"endpoint must be an HTTPS origin; test HTTP is limited to a loopback origin",
		))
	}
}

pub(super) fn endpoint_origin_is_allowed(endpoint: &str, allow_loopback_http: bool) -> bool {
	if endpoint.contains('#') {
		return false;
	}

	let Ok(uri) = endpoint.parse::<Uri>() else {
		return false;
	};
	let path_and_query = uri.path_and_query().map(PathAndQuery::as_str);

	parsed_uri_is_allowed(&uri, allow_loopback_http)
		&& matches!(path_and_query, None | Some("") | Some("/"))
}

fn parsed_uri_is_allowed(uri: &Uri, allow_loopback_http: bool) -> bool {
	let Some(authority) = uri.authority() else {
		return false;
	};

	if authority.as_str().contains('@') {
		return false;
	}

	let loopback = matches!(uri.host(), Some("localhost" | "127.0.0.1" | "::1" | "[::1]"));

	uri.scheme_str() == Some("https")
		|| (allow_loopback_http && uri.scheme_str() == Some("http") && loopback)
}

fn transport_url_is_allowed(url: &str, allow_loopback_http: bool) -> bool {
	if url.contains('#') {
		return false;
	}

	url.parse::<Uri>().is_ok_and(|uri| parsed_uri_is_allowed(&uri, allow_loopback_http))
}

#[cfg(test)]
mod tests {
	#[test]
	fn retries_only_transient_errors_and_preserves_the_final_error() {
		for (error, expected_calls) in [
			(crate::WorkerError::transient("network"), 3),
			(crate::WorkerError::configuration("URL"), 1),
			(
				crate::WorkerError::terminal(crate::ReasonCode::ArtifactEvidenceMismatch, "digest"),
				1,
			),
		] {
			let mut calls = 0;
			let result: Result<(), _> = super::retry_transient(3, super::Duration::ZERO, || {
				calls += 1;

				Err(error.clone())
			});

			assert_eq!(calls, expected_calls);
			assert_eq!(result.expect_err("operation must fail"), error);
		}
	}

	#[test]
	fn verifier_url_policy_parses_the_authority_before_allowing_loopback_http() {
		for allowed in [
			"http://127.0.0.1:3100/api/claims",
			"http://localhost:3100/api/claims?lease=1",
			"http://[::1]:3100/api/claims",
			"https://gateway.invalid/api/claims",
		] {
			assert!(super::transport_url_is_allowed(allowed, true), "{allowed}");
		}
		for rejected in [
			"http://localhost:3100@remote.invalid/api/claims",
			"http://127.0.0.1:3100@remote.invalid/api/claims",
			"http://localhost.invalid:3100/api/claims",
			"http://remote.invalid/api/claims",
			"https://user@gateway.invalid/api/claims",
			"not-a-url",
		] {
			assert!(!super::transport_url_is_allowed(rejected, true), "{rejected}");
		}

		assert!(!super::transport_url_is_allowed("http://localhost:3100/api/claims", false));
	}

	#[test]
	fn verifier_endpoint_policy_requires_one_exact_origin() {
		assert_eq!(
			super::validate_endpoint("http://localhost:3100/", true).expect("loopback origin"),
			"http://localhost:3100"
		);
		assert_eq!(
			super::validate_endpoint("https://gateway.invalid/", false).expect("HTTPS origin"),
			"https://gateway.invalid"
		);

		for rejected in [
			"http://localhost:3100@remote.invalid",
			"https://user@gateway.invalid",
			"https://gateway.invalid/api",
			"https://gateway.invalid?query=1",
			"https://gateway.invalid#fragment",
		] {
			assert!(super::validate_endpoint(rejected, true).is_err(), "{rejected}");
		}
	}
}
