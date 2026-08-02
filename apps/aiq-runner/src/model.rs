//! Model matrix and capability declarations.

use std::fmt::{Display, Formatter};

use serde::{Deserialize, Serialize};

/// The complete AIQ model matrix.
pub const MODEL_MATRIX: [ModelConfig; 17] = [
	ModelConfig { family: ModelFamily::Sol, reasoning_effort: ReasoningEffort::Low },
	ModelConfig { family: ModelFamily::Sol, reasoning_effort: ReasoningEffort::Medium },
	ModelConfig { family: ModelFamily::Sol, reasoning_effort: ReasoningEffort::High },
	ModelConfig { family: ModelFamily::Sol, reasoning_effort: ReasoningEffort::Xhigh },
	ModelConfig { family: ModelFamily::Sol, reasoning_effort: ReasoningEffort::Max },
	ModelConfig { family: ModelFamily::Sol, reasoning_effort: ReasoningEffort::Ultra },
	ModelConfig { family: ModelFamily::Terra, reasoning_effort: ReasoningEffort::Low },
	ModelConfig { family: ModelFamily::Terra, reasoning_effort: ReasoningEffort::Medium },
	ModelConfig { family: ModelFamily::Terra, reasoning_effort: ReasoningEffort::High },
	ModelConfig { family: ModelFamily::Terra, reasoning_effort: ReasoningEffort::Xhigh },
	ModelConfig { family: ModelFamily::Terra, reasoning_effort: ReasoningEffort::Max },
	ModelConfig { family: ModelFamily::Terra, reasoning_effort: ReasoningEffort::Ultra },
	ModelConfig { family: ModelFamily::Luna, reasoning_effort: ReasoningEffort::Low },
	ModelConfig { family: ModelFamily::Luna, reasoning_effort: ReasoningEffort::Medium },
	ModelConfig { family: ModelFamily::Luna, reasoning_effort: ReasoningEffort::High },
	ModelConfig { family: ModelFamily::Luna, reasoning_effort: ReasoningEffort::Xhigh },
	ModelConfig { family: ModelFamily::Luna, reasoning_effort: ReasoningEffort::Max },
];

/// A model family in the AIQ matrix.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelFamily {
	/// The Sol family.
	Sol,
	/// The Terra family.
	Terra,
	/// The Luna family.
	Luna,
}
impl ModelFamily {
	/// Returns the model name passed to Codex CLI.
	#[must_use]
	pub const fn codex_name(self) -> &'static str {
		match self {
			Self::Sol => "gpt-5.6-sol",
			Self::Terra => "gpt-5.6-terra",
			Self::Luna => "gpt-5.6-luna",
		}
	}
}

/// A supported reasoning effort.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReasoningEffort {
	/// Low reasoning effort.
	Low,
	/// Medium reasoning effort.
	Medium,
	/// High reasoning effort.
	High,
	/// Extra-high reasoning effort.
	Xhigh,
	/// Maximum reasoning effort.
	Max,
	/// Ultra reasoning effort.
	Ultra,
}
impl Display for ReasoningEffort {
	fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
		let value = match self {
			Self::Low => "low",
			Self::Medium => "medium",
			Self::High => "high",
			Self::Xhigh => "xhigh",
			Self::Max => "max",
			Self::Ultra => "ultra",
		};

		formatter.write_str(value)
	}
}

/// Availability reported by an observed capability claim.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityStatus {
	/// The configuration was observed as available.
	Available,
	/// The configuration is not supported.
	Unsupported,
}

/// One model and reasoning-effort combination.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ModelConfig {
	/// Model family.
	pub family: ModelFamily,
	/// Reasoning effort.
	pub reasoning_effort: ReasoningEffort,
}
impl ModelConfig {
	/// Returns a stable key for reports and content-addressed identifiers.
	#[must_use]
	pub fn key(self) -> String {
		format!("{}-{}", self.family.codex_name(), self.reasoning_effort)
	}
}

/// A capability claim for one matrix entry.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ModelCapability {
	/// Claimed model configuration.
	pub model: ModelConfig,
	/// Claimed status.
	pub status: CapabilityStatus,
	/// Evidence or a reason for an unsupported status.
	pub reason: Option<String>,
}

/// A node capability manifest.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CapabilityManifest {
	/// Protocol schema version.
	pub schema_version: String,
	/// Claiming node identifier.
	pub node_id: String,
	/// Observation time supplied by the capability probe.
	pub observed_at: String,
	/// Observed Codex CLI version.
	pub codex_version: String,
	/// Claims for model configurations.
	pub models: Vec<ModelCapability>,
}
impl CapabilityManifest {
	/// Returns the claim for a matrix entry.
	#[must_use]
	pub fn claim(&self, model: ModelConfig) -> Option<&ModelCapability> {
		self.models.iter().find(|claim| claim.model == model)
	}
}

#[cfg(test)]
mod tests {
	use std::collections::BTreeSet;

	use crate::model::{MODEL_MATRIX, ModelFamily, ReasoningEffort};

	#[test]
	fn matrix_has_exactly_the_required_seventeen_unique_entries() {
		let entries = MODEL_MATRIX.into_iter().collect::<BTreeSet<_>>();

		assert_eq!(entries.len(), 17);
		assert_eq!(entries.iter().filter(|model| model.family == ModelFamily::Sol).count(), 6);
		assert_eq!(entries.iter().filter(|model| model.family == ModelFamily::Terra).count(), 6);
		assert_eq!(entries.iter().filter(|model| model.family == ModelFamily::Luna).count(), 5);
		assert!(!entries.contains(&super::ModelConfig {
			family: ModelFamily::Luna,
			reasoning_effort: ReasoningEffort::Ultra,
		}));
	}
}
