//! Content addressing, signed envelopes, node claims, and provenance.

use std::{
	collections::BTreeSet,
	error::Error,
	fmt::{Display, Formatter},
};

use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::model::ModelCapability;

/// Signed result-package schema version.
pub const PROTOCOL_SCHEMA_VERSION: &str = "aiq.result-package.v4";
/// Run payload type accepted by the result-package protocol.
pub const RUN_PAYLOAD_TYPE: &str = "aiq.run.v4";
/// Calibration payload type accepted for signed, non-submittable calibration evidence.
pub const CALIBRATION_RUN_PAYLOAD_TYPE: &str = "aiq.calibration-run.v4";

const MAX_JCS_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_JCS_SAFE_INTEGER_I64: i64 = 9_007_199_254_740_991;

/// A serialization, digest, or signature error.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProtocolError {
	message: String,
}
impl ProtocolError {
	pub(crate) fn new(message: impl Into<String>) -> Self {
		Self { message: message.into() }
	}
}

impl Error for ProtocolError {}

impl Display for ProtocolError {
	fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
		formatter.write_str(&self.message)
	}
}

/// Public node identity.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct NodeIdentity {
	/// Identifier derived from the public key.
	pub node_id: String,
	/// Ed25519 public key encoded as lowercase hexadecimal.
	pub public_key: String,
}

/// Signing identity backed by deployment-provided Ed25519 key material.
pub struct SigningIdentity {
	signing_key: SigningKey,
	node: NodeIdentity,
}
impl SigningIdentity {
	/// Creates an identity from a 32-byte Ed25519 secret.
	#[must_use]
	pub fn from_secret(secret: [u8; 32]) -> Self {
		let signing_key = SigningKey::from_bytes(&secret);
		let public_key = hex::encode(signing_key.verifying_key().as_bytes());
		let node_id = node_id(signing_key.verifying_key().as_bytes());

		Self { signing_key, node: NodeIdentity { node_id, public_key } }
	}

	/// Returns the public identity.
	#[must_use]
	pub fn node(&self) -> &NodeIdentity {
		&self.node
	}

	/// Signs a payload and returns a submission envelope.
	pub fn sign<T>(
		&self,
		idempotency_key: &str,
		payload_type: &str,
		payload: &T,
		claimed_trust: TrustTier,
	) -> Result<SubmissionEnvelope, ProtocolError>
	where
		T: Serialize,
	{
		validate_run_key(idempotency_key)?;

		let payload =
			serde_json::to_value(payload).map_err(|error| ProtocolError::new(error.to_string()))?;
		let content_hash = canonical_hash(&payload)?;
		let unsigned = UnsignedEnvelope {
			schema_version: PROTOCOL_SCHEMA_VERSION,
			idempotency_key,
			payload_type,
			content_hash: &content_hash,
			signer: &self.node,
			claimed_trust,
			payload: &payload,
		};
		let signature = self.signing_key.sign(&canonical_json(&unsigned)?);

		Ok(SubmissionEnvelope {
			schema_version: PROTOCOL_SCHEMA_VERSION.to_owned(),
			idempotency_key: idempotency_key.to_owned(),
			payload_type: payload_type.to_owned(),
			content_hash,
			signer: self.node.clone(),
			claimed_trust,
			payload,
			signature: hex::encode(signature.to_bytes()),
		})
	}
}

/// A signed content-addressed submission.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SubmissionEnvelope {
	/// Protocol schema version.
	pub schema_version: String,
	/// Stable run idempotency key included in the signed bytes.
	pub idempotency_key: String,
	/// Stable payload type.
	pub payload_type: String,
	/// Content address of the payload.
	pub content_hash: String,
	/// Public signer identity.
	pub signer: NodeIdentity,
	/// Trust requested by the signer.
	pub claimed_trust: TrustTier,
	/// Submitted payload.
	pub payload: Value,
	/// Ed25519 signature encoded as lowercase hexadecimal.
	pub signature: String,
}
impl SubmissionEnvelope {
	/// Verifies identity, content address, and signature.
	///
	/// Effective trusted status requires both a trusted claim and receiver-side
	/// allow-list membership.
	pub fn verify(
		&self,
		trusted_nodes: &BTreeSet<String>,
	) -> Result<VerifiedSubmission, ProtocolError> {
		if self.schema_version != PROTOCOL_SCHEMA_VERSION {
			return Err(ProtocolError::new("unsupported protocol schema"));
		}

		validate_run_key(&self.idempotency_key)?;

		if !matches!(self.payload_type.as_str(), RUN_PAYLOAD_TYPE | CALIBRATION_RUN_PAYLOAD_TYPE) {
			return Err(ProtocolError::new("unsupported payload type"));
		}

		self.validate_payload_contract()?;

		self.verify_authenticated(trusted_nodes)
	}

	/// Verifies one exact signed 1.0.6 calibration source for the isolated,
	/// one-way calibration-bank derivation command. Production ingestion never
	/// calls this method and remains hard-bound to the current greenfield wire.
	pub fn verify_calibration_source_v3(&self) -> Result<VerifiedSubmission, ProtocolError> {
		if self.schema_version != "aiq.result-package.v3"
			|| self.payload_type != "aiq.calibration-run.v3"
			|| self.claimed_trust != TrustTier::Untrusted
		{
			return Err(ProtocolError::new("unsupported calibration source protocol"));
		}

		validate_run_key(&self.idempotency_key)?;

		let payload = self
			.payload
			.as_object()
			.ok_or_else(|| ProtocolError::new("payload must be an object"))?;

		if payload.get("schema_version").and_then(Value::as_str) != Some("aiq.calibration-run.v3")
			|| payload.get("run_id").and_then(Value::as_str) != Some(&self.idempotency_key)
			|| payload.get("scoring_version").and_then(Value::as_str) != Some("1.0.6")
			|| payload.get("official_eligible").and_then(Value::as_bool) != Some(false)
			|| payload.get("classification").and_then(Value::as_str)
				!= Some("local_calibration_non_official")
			|| payload
				.get("provenance")
				.and_then(|value| value.get("run_class"))
				.and_then(Value::as_str)
				!= Some("calibration")
		{
			return Err(ProtocolError::new("calibration source payload contract is invalid"));
		}

		self.verify_authenticated(&BTreeSet::new())
	}

	fn verify_authenticated(
		&self,
		trusted_nodes: &BTreeSet<String>,
	) -> Result<VerifiedSubmission, ProtocolError> {
		if !is_lower_hex(&self.signer.public_key, 64) {
			return Err(ProtocolError::new(
				"public key must contain 64 lowercase hexadecimal characters",
			));
		}
		if !self.signer.node_id.strip_prefix("node_").is_some_and(|digest| is_lower_hex(digest, 64))
		{
			return Err(ProtocolError::new(
				"node identifier must be node_ followed by 64 lowercase hexadecimal characters",
			));
		}
		if !self.content_hash.strip_prefix("sha256:").is_some_and(|digest| is_lower_hex(digest, 64))
		{
			return Err(ProtocolError::new(
				"content hash must be sha256: followed by 64 lowercase hexadecimal characters",
			));
		}
		if !is_lower_hex(&self.signature, 128) {
			return Err(ProtocolError::new(
				"signature must contain 128 lowercase hexadecimal characters",
			));
		}

		let public_bytes = hex::decode(&self.signer.public_key)
			.map_err(|error| ProtocolError::new(format!("invalid public key: {error}")))?;
		let public_array: [u8; 32] = public_bytes
			.try_into()
			.map_err(|_| ProtocolError::new("public key must contain 32 bytes"))?;

		if node_id(&public_array) != self.signer.node_id {
			return Err(ProtocolError::new("node identifier does not match the public key"));
		}
		if canonical_hash(&self.payload)? != self.content_hash {
			return Err(ProtocolError::new("payload content hash does not match"));
		}

		let signature_bytes = hex::decode(&self.signature)
			.map_err(|error| ProtocolError::new(format!("invalid signature: {error}")))?;
		let signature = Signature::from_slice(&signature_bytes)
			.map_err(|error| ProtocolError::new(format!("invalid signature: {error}")))?;
		let verifying_key = VerifyingKey::from_bytes(&public_array)
			.map_err(|error| ProtocolError::new(format!("invalid public key: {error}")))?;
		let unsigned = UnsignedEnvelope {
			schema_version: &self.schema_version,
			idempotency_key: &self.idempotency_key,
			payload_type: &self.payload_type,
			content_hash: &self.content_hash,
			signer: &self.signer,
			claimed_trust: self.claimed_trust,
			payload: &self.payload,
		};

		verifying_key.verify(&canonical_json(&unsigned)?, &signature).map_err(|error| {
			ProtocolError::new(format!("signature verification failed: {error}"))
		})?;

		let effective_trust = if self.claimed_trust == TrustTier::Trusted
			&& trusted_nodes.contains(&self.signer.node_id)
		{
			TrustTier::Trusted
		} else {
			TrustTier::Untrusted
		};

		Ok(VerifiedSubmission {
			payload_type: self.payload_type.clone(),
			content_hash: self.content_hash.clone(),
			signer: self.signer.clone(),
			effective_trust,
			payload: self.payload.clone(),
		})
	}

	fn validate_payload_contract(&self) -> Result<(), ProtocolError> {
		let payload = self
			.payload
			.as_object()
			.ok_or_else(|| ProtocolError::new("payload must be an object"))?;

		if payload.get("schema_version").and_then(Value::as_str) != Some(self.payload_type.as_str())
		{
			return Err(ProtocolError::new("payload schema does not match its type"));
		}
		if payload.get("run_id").and_then(Value::as_str) != Some(&self.idempotency_key) {
			return Err(ProtocolError::new(
				"payload run identifier does not match the idempotency key",
			));
		}

		let provenance = payload.get("provenance").ok_or_else(|| {
			ProtocolError::new("payload must contain an explicit provenance field")
		})?;
		let run_class = provenance.get("run_class").and_then(Value::as_str);

		match self.payload_type.as_str() {
			RUN_PAYLOAD_TYPE => match payload.get("synthetic").and_then(Value::as_bool) {
				Some(true) if provenance.is_null() => Ok(()),
				Some(false) if provenance.is_object() && run_class == Some("official") => Ok(()),
				_ => Err(ProtocolError::new(
					"run payload provenance does not match its synthetic policy",
				)),
			},
			CALIBRATION_RUN_PAYLOAD_TYPE
				if provenance.is_object()
					&& run_class == Some("calibration")
					&& payload.get("official_eligible").and_then(Value::as_bool) == Some(false)
					&& payload.get("classification").and_then(Value::as_str)
						== Some("local_calibration_non_official") =>
			{
				Ok(())
			},
			CALIBRATION_RUN_PAYLOAD_TYPE => Err(ProtocolError::new(
				"calibration payload must contain explicit non-Official calibration provenance",
			)),
			_ => unreachable!("payload type was checked by verify"),
		}
	}
}

/// A verified submission with receiver-evaluated trust.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct VerifiedSubmission {
	/// Stable payload type.
	pub payload_type: String,
	/// Verified content address.
	pub content_hash: String,
	/// Verified signer.
	pub signer: NodeIdentity,
	/// Trust after receiver policy evaluation.
	pub effective_trust: TrustTier,
	/// Verified payload.
	pub payload: Value,
}

/// A node capability claim payload.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct CapabilityClaim {
	/// Protocol schema version.
	pub schema_version: String,
	/// Claiming node.
	pub node: NodeIdentity,
	/// Observation time.
	pub observed_at: String,
	/// Observed Codex CLI version.
	pub codex_version: String,
	/// Observed model capabilities.
	pub capabilities: Vec<ModelCapability>,
}

/// A node status payload.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct NodeStatus {
	/// Protocol schema version.
	pub schema_version: String,
	/// Node identifier.
	pub node_id: String,
	/// Current lifecycle state.
	pub state: NodeState,
	/// Observation time.
	pub observed_at: String,
	/// Active idempotent run identifier, if present.
	pub active_run_id: Option<String>,
	/// Content address of the capability claim.
	pub capability_hash: String,
}

/// Provenance attached to every task result.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ResultProvenance {
	/// Producing node identifier.
	pub node_id: String,
	/// Runner package version.
	pub runner_version: String,
	/// Observed Codex CLI version.
	pub codex_version: String,
	/// Observation time.
	pub observed_at: String,
	/// Whether the result is synthetic.
	pub synthetic: bool,
	/// Local trust before receiver verification.
	pub local_trust: TrustTier,
}

#[derive(Serialize)]
struct UnsignedEnvelope<'a> {
	schema_version: &'a str,
	idempotency_key: &'a str,
	payload_type: &'a str,
	content_hash: &'a str,
	signer: &'a NodeIdentity,
	claimed_trust: TrustTier,
	payload: &'a Value,
}

/// Trust requested by a submitting node.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TrustTier {
	/// The node is not in the receiver's trust policy.
	Untrusted,
	/// The node requests trusted handling.
	Trusted,
}

/// Current node lifecycle state.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeState {
	/// Node can accept work.
	Ready,
	/// Node is running a benchmark.
	Busy,
	/// Node is not accepting work.
	Offline,
	/// Node reported a degraded state.
	Degraded,
}

/// Serializes a value with RFC 8785 JSON Canonicalization Scheme rules.
pub fn canonical_json<T>(value: &T) -> Result<Vec<u8>, ProtocolError>
where
	T: Serialize,
{
	let value =
		serde_json::to_value(value).map_err(|error| ProtocolError::new(error.to_string()))?;

	validate_jcs_value(&value)?;

	serde_json_canonicalizer::to_vec(&value).map_err(|error| ProtocolError::new(error.to_string()))
}

/// Returns a SHA-256 content address.
pub fn canonical_hash<T>(value: &T) -> Result<String, ProtocolError>
where
	T: Serialize,
{
	let bytes = canonical_json(value)?;

	Ok(format!("sha256:{}", hex::encode(Sha256::digest(bytes))))
}

/// Validates the canonical result-package idempotency key.
pub fn validate_run_key(value: &str) -> Result<(), ProtocolError> {
	if value.strip_prefix("run_").is_some_and(|digest| is_lower_hex(digest, 64)) {
		Ok(())
	} else {
		Err(ProtocolError::new(
			"idempotency key must be run_ followed by 64 lowercase hexadecimal characters",
		))
	}
}

fn validate_jcs_value(value: &Value) -> Result<(), ProtocolError> {
	match value {
		Value::Number(number) => {
			if let Some(integer) = number.as_i64() {
				if !(-MAX_JCS_SAFE_INTEGER_I64..=MAX_JCS_SAFE_INTEGER_I64).contains(&integer) {
					return Err(ProtocolError::new(
						"JCS integers must stay within the IEEE-754 safe integer range",
					));
				}
			} else if let Some(integer) = number.as_u64() {
				if integer > MAX_JCS_SAFE_INTEGER {
					return Err(ProtocolError::new(
						"JCS integers must stay within the IEEE-754 safe integer range",
					));
				}
			} else if number.as_f64().is_none_or(|number| !number.is_finite()) {
				return Err(ProtocolError::new("JCS numbers must be finite IEEE-754 values"));
			}
		},
		Value::Array(values) => {
			for value in values {
				validate_jcs_value(value)?;
			}
		},
		Value::Object(values) => {
			for value in values.values() {
				validate_jcs_value(value)?;
			}
		},
		Value::Null | Value::Bool(_) | Value::String(_) => {},
	}

	Ok(())
}

fn node_id(public_key: &[u8; 32]) -> String {
	format!("node_{}", hex::encode(Sha256::digest(public_key)))
}

fn is_lower_hex(value: &str, digits: usize) -> bool {
	value.len() == digits
		&& value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
	use std::collections::BTreeSet;

	use serde_json;

	use crate::protocol::{self, SigningIdentity, TrustTier};

	const RUN_ID: &str = "run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

	fn payload() -> serde_json::Value {
		serde_json::json!({
			"schema_version": super::RUN_PAYLOAD_TYPE,
			"run_id": RUN_ID,
			"synthetic": true,
			"provenance": null,
			"results": []
		})
	}

	#[test]
	fn signature_verification_rejects_payload_tampering() {
		let identity = SigningIdentity::from_secret([7; 32]);
		let mut envelope = identity
			.sign(RUN_ID, super::RUN_PAYLOAD_TYPE, &payload(), TrustTier::Trusted)
			.expect("fixture must sign");

		envelope.payload["synthetic"] = serde_json::json!(false);

		assert!(envelope.verify(&BTreeSet::new()).is_err());
	}

	#[test]
	fn signature_verification_rejects_idempotency_key_tampering() {
		let identity = SigningIdentity::from_secret([7; 32]);
		let tampered_run_id =
			"run_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
		let mut envelope = identity
			.sign(RUN_ID, super::RUN_PAYLOAD_TYPE, &payload(), TrustTier::Trusted)
			.expect("fixture must sign");

		envelope.idempotency_key = tampered_run_id.to_owned();
		envelope.payload["run_id"] = serde_json::json!(tampered_run_id);
		envelope.content_hash =
			super::canonical_hash(&envelope.payload).expect("payload must hash");

		assert!(envelope.verify(&BTreeSet::new()).is_err());
	}

	#[test]
	fn trust_requires_receiver_allow_list_membership() {
		let identity = SigningIdentity::from_secret([8; 32]);
		let envelope = identity
			.sign(RUN_ID, super::RUN_PAYLOAD_TYPE, &payload(), TrustTier::Trusted)
			.expect("fixture must sign");
		let untrusted = envelope.verify(&BTreeSet::new()).expect("signature must verify");

		assert_eq!(untrusted.effective_trust, TrustTier::Untrusted);

		let trusted_nodes = BTreeSet::from([identity.node().node_id.clone()]);
		let trusted = envelope.verify(&trusted_nodes).expect("signature must verify");

		assert_eq!(trusted.effective_trust, TrustTier::Trusted);
	}

	#[test]
	fn run_provenance_distinguishes_missing_null_and_object_values() {
		let identity = SigningIdentity::from_secret([8; 32]);
		let verify = |payload: &serde_json::Value| {
			identity
				.sign(RUN_ID, super::RUN_PAYLOAD_TYPE, payload, TrustTier::Untrusted)
				.expect("fixture must sign")
				.verify(&BTreeSet::new())
		};

		assert!(verify(&payload()).is_ok());

		let mut missing = payload();

		missing.as_object_mut().expect("payload object").remove("provenance");

		assert!(verify(&missing).is_err());

		let mut production_without_provenance = payload();

		production_without_provenance["synthetic"] = serde_json::json!(false);

		assert!(verify(&production_without_provenance).is_err());

		let mut production = production_without_provenance;

		production["provenance"] = serde_json::json!({
			"schema_version": "aiq.run-provenance.v3",
			"run_class": "official"
		});

		assert!(verify(&production).is_ok());

		let mut synthetic_with_provenance = payload();

		synthetic_with_provenance["provenance"] = serde_json::json!({
			"schema_version": "aiq.run-provenance.v3",
			"run_class": "official"
		});

		assert!(verify(&synthetic_with_provenance).is_err());
	}

	#[test]
	fn calibration_type_is_signed_explicitly_and_unsupported_run_type_is_rejected() {
		let identity = SigningIdentity::from_secret([8; 32]);
		let calibration = serde_json::json!({
			"schema_version": super::CALIBRATION_RUN_PAYLOAD_TYPE,
			"run_id": RUN_ID,
			"official_eligible": false,
			"classification": "local_calibration_non_official",
			"provenance": {
				"schema_version": "aiq.run-provenance.v3",
				"run_class": "calibration"
			},
		});
		let envelope = identity
			.sign(RUN_ID, super::CALIBRATION_RUN_PAYLOAD_TYPE, &calibration, TrustTier::Untrusted)
			.expect("calibration must sign");

		assert!(envelope.verify(&BTreeSet::new()).is_ok());

		for (field, value) in [
			("official_eligible", serde_json::json!(true)),
			("classification", serde_json::json!("official")),
		] {
			let mut changed = calibration.clone();

			changed[field] = value;

			let changed = identity
				.sign(RUN_ID, super::CALIBRATION_RUN_PAYLOAD_TYPE, &changed, TrustTier::Untrusted)
				.expect("changed calibration bytes can be signed");

			assert!(changed.verify(&BTreeSet::new()).is_err());
		}

		let unsupported = identity
			.sign(RUN_ID, "aiq.run.unsupported", &payload(), TrustTier::Untrusted)
			.expect("unsupported payload bytes can be signed");

		assert!(unsupported.verify(&BTreeSet::new()).is_err());
	}

	#[test]
	fn canonical_json_uses_jcs_number_and_utf16_key_rules() {
		let value = serde_json::json!({
			"\u{e000}": 2,
			"\u{10000}": 1.0,
		});
		let bytes = protocol::canonical_json(&value).expect("JCS fixture must canonicalize");

		assert_eq!(
			String::from_utf8(bytes).expect("JCS output must be UTF-8"),
			"{\"\u{10000}\":1,\"\u{e000}\":2}"
		);
	}

	#[test]
	fn canonical_json_rejects_integers_outside_the_jcs_safe_range() {
		assert!(protocol::canonical_json(&serde_json::json!(9_007_199_254_740_992_u64)).is_err());
		assert!(protocol::canonical_json(&serde_json::json!(-9_007_199_254_740_992_i64)).is_err());
	}
}
