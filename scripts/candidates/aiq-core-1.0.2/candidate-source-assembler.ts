import { createHash, createPublicKey, verify } from 'node:crypto';
import {
  buildCatalog,
  evaluateReleaseGate,
  releaseAdmissionDigest,
  releaseCellEvidenceBindingDigest,
  releaseEvidenceSourceDigest,
  runtimePinnedReleaseGateTrustRoot,
  type ComponentEvidence,
  type ReleaseGateAuthority,
  type ReleaseGateAttempt,
  type ReleaseGateAttemptDisposition,
  type ReleaseGateEvidence,
  type ReleaseGateRawCell,
  type ReleaseGateResult,
  type ReleaseGateTrustPolicy,
} from './generate-benchmark-catalog.ts';
import { assembleReleaseEvidence, matchesSchema } from './candidate-release.ts';

type JsonObject = Record<string, unknown>;

// The runner copies this fixed assembler into an isolated execution directory.
// Keep the exact public projection schema in the fixed program so validation
// does not depend on a repository-relative path at execution time.
export const SOURCE_OBSERVATIONS_SCHEMA_JSON = String.raw`
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://aiq.wiki/schema/release-gate-source-observations.v1.json",
  "title": "AIQ Core release-gate source observations",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schema_version",
    "release_identity",
    "catalog_release_identity_digest",
    "task_metadata_identity_digest",
    "corpus_commitment_digest",
    "model_matrix_digest",
    "collected_at",
    "repeat_ids",
    "raw_cells",
    "paired_contrasts"
  ],
  "properties": {
    "schema_version": {
      "const": "aiq.release-gate-source-observations.v1"
    },
    "release_identity": {
      "const": "aiq-core/1.0.2"
    },
    "catalog_release_identity_digest": {
      "const": "sha256:45bf2e9d5287fd4f83e46bc3cb5c3ccb8778756465e81bfd567d111480eefc4b"
    },
    "task_metadata_identity_digest": {
      "const": "sha256:2c5efe162b49e710e6e52b0f3a4e33d1127d0dd54d4f15694f88911bcb7fc937"
    },
    "corpus_commitment_digest": {
      "$ref": "#/$defs/digest"
    },
    "model_matrix_digest": {
      "const": "sha256:c385d79e02d233b4594800a66199c2da59e8f6fd623fb808812a669ccba29757"
    },
    "collected_at": {
      "type": "string",
      "format": "date-time"
    },
    "repeat_ids": {
      "type": "array",
      "minItems": 3,
      "maxItems": 3,
      "uniqueItems": true,
      "items": {
        "$ref": "#/$defs/identifier"
      }
    },
    "raw_cells": {
      "type": "array",
      "minItems": 3672,
      "maxItems": 3672,
      "items": {
        "$ref": "#/$defs/rawCell"
      }
    },
    "paired_contrasts": {
      "type": "array",
      "minItems": 3,
      "maxItems": 3,
      "prefixItems": [
        {
          "$ref": "#/$defs/coupledConstraints"
        },
        {
          "$ref": "#/$defs/ambiguousRecoveryState"
        },
        {
          "$ref": "#/$defs/plausibleIncompleteEvidence"
        }
      ],
      "items": false
    }
  },
  "$defs": {
    "digest": {
      "type": "string",
      "pattern": "^sha256:(?!0{64}(?![\\s\\S]))[a-f0-9]{64}(?![\\s\\S])"
    },
    "identifier": {
      "type": "string",
      "pattern": "^[a-z0-9][a-z0-9._-]*(?![\\s\\S])"
    },
    "assertion": {
      "type": "object",
      "additionalProperties": false,
      "required": ["assertion_id", "passed", "evidence_digest"],
      "properties": {
        "assertion_id": {
          "type": "string",
          "pattern": "^assertion_(?:00[1-9]|0[1-5][0-9]|06[0-4])(?![\\s\\S])"
        },
        "passed": {
          "type": "boolean"
        },
        "evidence_digest": {
          "$ref": "#/$defs/digest"
        }
      }
    },
    "component": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "component_id",
        "weight_basis_points",
        "passed_assertions",
        "total_assertions",
        "assertions"
      ],
      "properties": {
        "component_id": {
          "type": "string"
        },
        "weight_basis_points": {
          "enum": [3000, 2500, 2000]
        },
        "passed_assertions": {
          "type": "integer",
          "minimum": 0,
          "maximum": 64
        },
        "total_assertions": {
          "type": "integer",
          "minimum": 3,
          "maximum": 64
        },
        "assertions": {
          "type": "array",
          "minItems": 3,
          "maxItems": 64,
          "items": {
            "$ref": "#/$defs/assertion"
          }
        }
      }
    },
    "components": {
      "type": "array",
      "minItems": 4,
      "maxItems": 4,
      "prefixItems": [
        {
          "allOf": [
            {
              "$ref": "#/$defs/component"
            },
            {
              "properties": {
                "component_id": {
                  "const": "component_01"
                },
                "weight_basis_points": {
                  "const": 3000
                }
              }
            }
          ]
        },
        {
          "allOf": [
            {
              "$ref": "#/$defs/component"
            },
            {
              "properties": {
                "component_id": {
                  "const": "component_02"
                },
                "weight_basis_points": {
                  "const": 2500
                }
              }
            }
          ]
        },
        {
          "allOf": [
            {
              "$ref": "#/$defs/component"
            },
            {
              "properties": {
                "component_id": {
                  "const": "component_03"
                },
                "weight_basis_points": {
                  "const": 2500
                }
              }
            }
          ]
        },
        {
          "allOf": [
            {
              "$ref": "#/$defs/component"
            },
            {
              "properties": {
                "component_id": {
                  "const": "component_04"
                },
                "weight_basis_points": {
                  "const": 2000
                }
              }
            }
          ]
        }
      ],
      "items": false
    },
    "rawCell": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "repeat_id",
        "task_id",
        "domain",
        "model_id",
        "status",
        "reported_score",
        "components",
        "evaluator_digest",
        "result_digest",
        "result_package_digest",
        "verification_digest",
        "verification_status",
        "attempts"
      ],
      "properties": {
        "repeat_id": {
          "$ref": "#/$defs/identifier"
        },
        "task_id": {
          "type": "string",
          "pattern": "^[a-z0-9-]+-[0-9]{2}(?![\\s\\S])"
        },
        "domain": {
          "enum": [
            "coding",
            "debugging",
            "repository_understanding",
            "data_processing",
            "retrieval_verification",
            "documentation_communication",
            "planning_execution",
            "tool_use",
            "instruction_following",
            "reliability_recovery"
          ]
        },
        "model_id": {
          "$ref": "#/$defs/identifier"
        },
        "status": {
          "enum": [
            "completed",
            "infrastructure_failure",
            "model_failure",
            "evaluator_failure",
            "unsupported",
            "unevaluated"
          ]
        },
        "reported_score": {
          "type": ["number", "null"]
        },
        "components": {
          "oneOf": [
            {
              "$ref": "#/$defs/components"
            },
            {
              "type": "null"
            }
          ]
        },
        "evaluator_digest": {
          "oneOf": [
            {
              "$ref": "#/$defs/digest"
            },
            {
              "type": "null"
            }
          ]
        },
        "result_digest": {
          "oneOf": [
            {
              "$ref": "#/$defs/digest"
            },
            {
              "type": "null"
            }
          ]
        },
        "result_package_digest": {
          "oneOf": [
            {
              "$ref": "#/$defs/digest"
            },
            {
              "type": "null"
            }
          ]
        },
        "verification_digest": {
          "oneOf": [
            {
              "$ref": "#/$defs/digest"
            },
            {
              "type": "null"
            }
          ]
        },
        "verification_status": {
          "enum": ["verified", "failed"]
        },
        "attempts": {
          "type": "array",
          "minItems": 1,
          "maxItems": 3,
          "prefixItems": [
            {
              "allOf": [
                {
                  "$ref": "#/$defs/attempt"
                },
                {
                  "properties": {
                    "attempt_number": {
                      "const": 1
                    },
                    "scheduled_delay_seconds": {
                      "const": 0
                    }
                  }
                }
              ]
            },
            {
              "allOf": [
                {
                  "$ref": "#/$defs/attempt"
                },
                {
                  "properties": {
                    "attempt_number": {
                      "const": 2
                    },
                    "scheduled_delay_seconds": {
                      "const": 30
                    }
                  }
                }
              ]
            },
            {
              "allOf": [
                {
                  "$ref": "#/$defs/attempt"
                },
                {
                  "properties": {
                    "attempt_number": {
                      "const": 3
                    },
                    "scheduled_delay_seconds": {
                      "const": 90
                    }
                  }
                }
              ]
            }
          ],
          "items": false
        }
      },
      "allOf": [
        {
          "if": {
            "properties": {
              "status": {
                "const": "completed"
              }
            },
            "required": ["status"]
          },
          "then": {
            "properties": {
              "reported_score": {
                "type": "number",
                "minimum": 0,
                "maximum": 1
              },
              "components": {
                "$ref": "#/$defs/components"
              },
              "evaluator_digest": {
                "$ref": "#/$defs/digest"
              },
              "result_digest": {
                "$ref": "#/$defs/digest"
              },
              "result_package_digest": {
                "$ref": "#/$defs/digest"
              },
              "verification_digest": {
                "$ref": "#/$defs/digest"
              },
              "verification_status": {
                "const": "verified"
              }
            }
          },
          "else": {
            "properties": {
              "reported_score": {
                "type": "null"
              },
              "components": {
                "type": "null"
              },
              "evaluator_digest": {
                "type": "null"
              },
              "result_digest": {
                "type": "null"
              },
              "result_package_digest": {
                "type": "null"
              },
              "verification_digest": {
                "type": "null"
              },
              "verification_status": {
                "const": "failed"
              }
            }
          }
        }
      ]
    },
    "attempt": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "attempt_number",
        "scheduled_delay_seconds",
        "scheduled_for",
        "started_at",
        "model_started",
        "disposition",
        "infrastructure_classification",
        "result_digest",
        "result_package_digest",
        "verifier_attestation_digest"
      ],
      "properties": {
        "attempt_number": {
          "type": "integer",
          "minimum": 1,
          "maximum": 3
        },
        "scheduled_delay_seconds": {
          "enum": [0, 30, 90]
        },
        "scheduled_for": {
          "type": "string",
          "format": "date-time",
          "description": "Logical attempt time fixed by the signed repeat schedule and retry policy."
        },
        "started_at": {
          "type": "string",
          "format": "date-time",
          "description": "Actual start of the unit-level execution attempt that contains this cell. Cells in one unit can share this value."
        },
        "model_started": {
          "type": "boolean",
          "description": "Whether this cell crossed the model-execution boundary during the unit attempt."
        },
        "disposition": {
          "enum": [
            "completed",
            "infrastructure_retryable",
            "infrastructure_terminal",
            "model_failure",
            "evaluator_failure",
            "unsupported",
            "unevaluated"
          ]
        },
        "infrastructure_classification": {
          "enum": ["pre_model_admission", null]
        },
        "result_digest": {
          "oneOf": [
            {
              "$ref": "#/$defs/digest"
            },
            {
              "type": "null"
            }
          ]
        },
        "result_package_digest": {
          "oneOf": [
            {
              "$ref": "#/$defs/digest"
            },
            {
              "type": "null"
            }
          ]
        },
        "verifier_attestation_digest": {
          "oneOf": [
            {
              "$ref": "#/$defs/digest"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "allOf": [
        {
          "if": {
            "properties": {
              "disposition": {
                "enum": ["infrastructure_retryable", "infrastructure_terminal"]
              }
            },
            "required": ["disposition"]
          },
          "then": {
            "properties": {
              "model_started": {
                "const": false
              },
              "infrastructure_classification": {
                "const": "pre_model_admission"
              },
              "result_digest": {
                "type": "null"
              },
              "result_package_digest": {
                "type": "null"
              },
              "verifier_attestation_digest": {
                "type": "null"
              }
            }
          }
        },
        {
          "if": {
            "properties": {
              "disposition": {
                "const": "completed"
              }
            },
            "required": ["disposition"]
          },
          "then": {
            "properties": {
              "model_started": {
                "const": true
              },
              "infrastructure_classification": {
                "type": "null"
              },
              "result_digest": {
                "$ref": "#/$defs/digest"
              },
              "result_package_digest": {
                "$ref": "#/$defs/digest"
              },
              "verifier_attestation_digest": {
                "$ref": "#/$defs/digest"
              }
            }
          }
        },
        {
          "if": {
            "properties": {
              "disposition": {
                "enum": ["model_failure", "evaluator_failure", "unsupported", "unevaluated"]
              }
            },
            "required": ["disposition"]
          },
          "then": {
            "properties": {
              "infrastructure_classification": {
                "type": "null"
              },
              "result_digest": {
                "type": "null"
              },
              "result_package_digest": {
                "type": "null"
              },
              "verifier_attestation_digest": {
                "type": "null"
              }
            }
          }
        },
        {
          "if": {
            "properties": {
              "disposition": {
                "const": "evaluator_failure"
              }
            },
            "required": ["disposition"]
          },
          "then": {
            "properties": {
              "model_started": {
                "const": true
              }
            }
          }
        },
        {
          "if": {
            "properties": {
              "disposition": {
                "const": "unsupported"
              }
            },
            "required": ["disposition"]
          },
          "then": {
            "properties": {
              "model_started": {
                "const": false
              }
            }
          }
        }
      ]
    },
    "contrastPair": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "repeat_id",
        "model_id",
        "reference_score",
        "challenge_score",
        "reference_result_digest",
        "reference_result_package_digest",
        "reference_verifier_attestation_digest",
        "challenge_result_digest",
        "challenge_result_package_digest",
        "challenge_verifier_attestation_digest"
      ],
      "properties": {
        "repeat_id": {
          "$ref": "#/$defs/identifier"
        },
        "model_id": {
          "$ref": "#/$defs/identifier"
        },
        "reference_score": {
          "type": "number",
          "minimum": 0,
          "maximum": 1
        },
        "challenge_score": {
          "type": "number",
          "minimum": 0,
          "maximum": 1
        },
        "reference_result_digest": {
          "$ref": "#/$defs/digest"
        },
        "reference_result_package_digest": {
          "$ref": "#/$defs/digest"
        },
        "reference_verifier_attestation_digest": {
          "$ref": "#/$defs/digest"
        },
        "challenge_result_digest": {
          "$ref": "#/$defs/digest"
        },
        "challenge_result_package_digest": {
          "$ref": "#/$defs/digest"
        },
        "challenge_verifier_attestation_digest": {
          "$ref": "#/$defs/digest"
        }
      }
    },
    "contrast": {
      "type": "object",
      "additionalProperties": false,
      "required": ["contrast_id", "reference_variant_digest", "challenge_variant_digest", "pairs"],
      "properties": {
        "contrast_id": {
          "type": "string"
        },
        "reference_variant_digest": {
          "$ref": "#/$defs/digest"
        },
        "challenge_variant_digest": {
          "$ref": "#/$defs/digest"
        },
        "pairs": {
          "type": "array",
          "minItems": 51,
          "maxItems": 51,
          "items": {
            "$ref": "#/$defs/contrastPair"
          }
        }
      }
    },
    "coupledConstraints": {
      "allOf": [
        {
          "$ref": "#/$defs/contrast"
        },
        {
          "properties": {
            "contrast_id": {
              "const": "coupled_constraints"
            }
          }
        }
      ]
    },
    "ambiguousRecoveryState": {
      "allOf": [
        {
          "$ref": "#/$defs/contrast"
        },
        {
          "properties": {
            "contrast_id": {
              "const": "ambiguous_recovery_state"
            }
          }
        }
      ]
    },
    "plausibleIncompleteEvidence": {
      "allOf": [
        {
          "$ref": "#/$defs/contrast"
        },
        {
          "properties": {
            "contrast_id": {
              "const": "plausible_incomplete_evidence"
            }
          }
        }
      ]
    }
  }
}

`;
export const RELEASE_GATE_EVIDENCE_SCHEMA_JSON = String.raw`
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://aiq.wiki/schema/release-gate-evidence.v1.json",
  "title": "AIQ Core controlled release-gate evidence",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schema_version",
    "release_identity",
    "catalog_release_identity_digest",
    "task_metadata_identity_digest",
    "corpus_commitment_digest",
    "model_matrix_digest",
    "source_observations_digest",
    "authority_digest",
    "admission_digest",
    "execution_plan_digest",
    "model_id_mapping_digest",
    "collected_at",
    "repeat_ids",
    "raw_cells",
    "paired_contrasts"
  ],
  "properties": {
    "schema_version": {
      "const": "aiq.release-gate-evidence.v1"
    },
    "release_identity": {
      "const": "aiq-core/1.0.2"
    },
    "catalog_release_identity_digest": {
      "const": "sha256:45bf2e9d5287fd4f83e46bc3cb5c3ccb8778756465e81bfd567d111480eefc4b"
    },
    "task_metadata_identity_digest": {
      "const": "sha256:2c5efe162b49e710e6e52b0f3a4e33d1127d0dd54d4f15694f88911bcb7fc937"
    },
    "corpus_commitment_digest": {
      "$ref": "#/$defs/digest"
    },
    "model_matrix_digest": {
      "const": "sha256:c385d79e02d233b4594800a66199c2da59e8f6fd623fb808812a669ccba29757"
    },
    "source_observations_digest": {
      "$ref": "#/$defs/digest"
    },
    "authority_digest": {
      "$ref": "#/$defs/digest"
    },
    "admission_digest": {
      "$ref": "#/$defs/digest"
    },
    "execution_plan_digest": {
      "$ref": "#/$defs/digest"
    },
    "model_id_mapping_digest": {
      "$ref": "#/$defs/digest"
    },
    "collected_at": {
      "type": "string",
      "format": "date-time"
    },
    "repeat_ids": {
      "type": "array",
      "minItems": 3,
      "maxItems": 3,
      "uniqueItems": true,
      "items": {
        "$ref": "#/$defs/identifier"
      }
    },
    "raw_cells": {
      "type": "array",
      "minItems": 3672,
      "maxItems": 3672,
      "items": {
        "$ref": "#/$defs/rawCell"
      }
    },
    "paired_contrasts": {
      "type": "array",
      "minItems": 3,
      "maxItems": 3,
      "prefixItems": [
        {
          "$ref": "#/$defs/coupledConstraints"
        },
        {
          "$ref": "#/$defs/ambiguousRecoveryState"
        },
        {
          "$ref": "#/$defs/plausibleIncompleteEvidence"
        }
      ],
      "items": false
    }
  },
  "$defs": {
    "digest": {
      "type": "string",
      "pattern": "^sha256:(?!0{64}(?![\\s\\S]))[a-f0-9]{64}(?![\\s\\S])"
    },
    "identifier": {
      "type": "string",
      "pattern": "^[a-z0-9][a-z0-9._-]*(?![\\s\\S])"
    },
    "assertion": {
      "type": "object",
      "additionalProperties": false,
      "required": ["assertion_id", "passed", "evidence_digest"],
      "properties": {
        "assertion_id": {
          "type": "string",
          "pattern": "^assertion_(?:00[1-9]|0[1-5][0-9]|06[0-4])(?![\\s\\S])"
        },
        "passed": {
          "type": "boolean"
        },
        "evidence_digest": {
          "$ref": "#/$defs/digest"
        }
      }
    },
    "component": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "component_id",
        "weight_basis_points",
        "passed_assertions",
        "total_assertions",
        "assertions"
      ],
      "properties": {
        "component_id": {
          "type": "string"
        },
        "weight_basis_points": {
          "enum": [3000, 2500, 2000]
        },
        "passed_assertions": {
          "type": "integer",
          "minimum": 0,
          "maximum": 64
        },
        "total_assertions": {
          "type": "integer",
          "minimum": 3,
          "maximum": 64
        },
        "assertions": {
          "type": "array",
          "minItems": 3,
          "maxItems": 64,
          "items": {
            "$ref": "#/$defs/assertion"
          }
        }
      }
    },
    "components": {
      "type": "array",
      "minItems": 4,
      "maxItems": 4,
      "prefixItems": [
        {
          "allOf": [
            {
              "$ref": "#/$defs/component"
            },
            {
              "properties": {
                "component_id": {
                  "const": "component_01"
                },
                "weight_basis_points": {
                  "const": 3000
                }
              }
            }
          ]
        },
        {
          "allOf": [
            {
              "$ref": "#/$defs/component"
            },
            {
              "properties": {
                "component_id": {
                  "const": "component_02"
                },
                "weight_basis_points": {
                  "const": 2500
                }
              }
            }
          ]
        },
        {
          "allOf": [
            {
              "$ref": "#/$defs/component"
            },
            {
              "properties": {
                "component_id": {
                  "const": "component_03"
                },
                "weight_basis_points": {
                  "const": 2500
                }
              }
            }
          ]
        },
        {
          "allOf": [
            {
              "$ref": "#/$defs/component"
            },
            {
              "properties": {
                "component_id": {
                  "const": "component_04"
                },
                "weight_basis_points": {
                  "const": 2000
                }
              }
            }
          ]
        }
      ],
      "items": false
    },
    "rawCell": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "universe_slot",
        "repeat_id",
        "task_id",
        "domain",
        "model_id",
        "status",
        "reported_score",
        "components",
        "evaluator_digest",
        "result_digest",
        "result_package_digest",
        "verification_digest",
        "cell_evidence_binding_digest",
        "verification_status",
        "attempts"
      ],
      "properties": {
        "universe_slot": {
          "type": "integer",
          "minimum": 1,
          "maximum": 3672
        },
        "repeat_id": {
          "$ref": "#/$defs/identifier"
        },
        "task_id": {
          "type": "string",
          "pattern": "^[a-z0-9-]+-[0-9]{2}(?![\\s\\S])"
        },
        "domain": {
          "enum": [
            "coding",
            "debugging",
            "repository_understanding",
            "data_processing",
            "retrieval_verification",
            "documentation_communication",
            "planning_execution",
            "tool_use",
            "instruction_following",
            "reliability_recovery"
          ]
        },
        "model_id": {
          "$ref": "#/$defs/identifier"
        },
        "status": {
          "enum": [
            "completed",
            "infrastructure_failure",
            "model_failure",
            "evaluator_failure",
            "unsupported",
            "unevaluated"
          ]
        },
        "reported_score": {
          "type": ["number", "null"]
        },
        "components": {
          "oneOf": [
            {
              "$ref": "#/$defs/components"
            },
            {
              "type": "null"
            }
          ]
        },
        "evaluator_digest": {
          "oneOf": [
            {
              "$ref": "#/$defs/digest"
            },
            {
              "type": "null"
            }
          ]
        },
        "result_digest": {
          "oneOf": [
            {
              "$ref": "#/$defs/digest"
            },
            {
              "type": "null"
            }
          ]
        },
        "result_package_digest": {
          "oneOf": [
            {
              "$ref": "#/$defs/digest"
            },
            {
              "type": "null"
            }
          ]
        },
        "verification_digest": {
          "oneOf": [
            {
              "$ref": "#/$defs/digest"
            },
            {
              "type": "null"
            }
          ]
        },
        "cell_evidence_binding_digest": {
          "oneOf": [
            {
              "$ref": "#/$defs/digest"
            },
            {
              "type": "null"
            }
          ]
        },
        "verification_status": {
          "enum": ["verified", "failed"]
        },
        "attempts": {
          "type": "array",
          "minItems": 1,
          "maxItems": 3,
          "prefixItems": [
            {
              "allOf": [
                {
                  "$ref": "#/$defs/attempt"
                },
                {
                  "properties": {
                    "attempt_number": {
                      "const": 1
                    },
                    "scheduled_delay_seconds": {
                      "const": 0
                    }
                  }
                }
              ]
            },
            {
              "allOf": [
                {
                  "$ref": "#/$defs/attempt"
                },
                {
                  "properties": {
                    "attempt_number": {
                      "const": 2
                    },
                    "scheduled_delay_seconds": {
                      "const": 30
                    }
                  }
                }
              ]
            },
            {
              "allOf": [
                {
                  "$ref": "#/$defs/attempt"
                },
                {
                  "properties": {
                    "attempt_number": {
                      "const": 3
                    },
                    "scheduled_delay_seconds": {
                      "const": 90
                    }
                  }
                }
              ]
            }
          ],
          "items": false
        }
      },
      "allOf": [
        {
          "if": {
            "properties": {
              "status": {
                "const": "completed"
              }
            },
            "required": ["status"]
          },
          "then": {
            "properties": {
              "reported_score": {
                "type": "number",
                "minimum": 0,
                "maximum": 1
              },
              "components": {
                "$ref": "#/$defs/components"
              },
              "evaluator_digest": {
                "$ref": "#/$defs/digest"
              },
              "result_digest": {
                "$ref": "#/$defs/digest"
              },
              "result_package_digest": {
                "$ref": "#/$defs/digest"
              },
              "verification_digest": {
                "$ref": "#/$defs/digest"
              },
              "cell_evidence_binding_digest": {
                "$ref": "#/$defs/digest"
              },
              "verification_status": {
                "const": "verified"
              }
            }
          },
          "else": {
            "properties": {
              "reported_score": {
                "type": "null"
              },
              "components": {
                "type": "null"
              },
              "evaluator_digest": {
                "type": "null"
              },
              "result_digest": {
                "type": "null"
              },
              "result_package_digest": {
                "type": "null"
              },
              "verification_digest": {
                "type": "null"
              },
              "cell_evidence_binding_digest": {
                "type": "null"
              },
              "verification_status": {
                "const": "failed"
              }
            }
          }
        }
      ]
    },
    "attempt": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "attempt_number",
        "scheduled_delay_seconds",
        "scheduled_for",
        "started_at",
        "model_started",
        "disposition",
        "infrastructure_classification",
        "result_digest",
        "result_package_digest",
        "verifier_attestation_digest"
      ],
      "properties": {
        "attempt_number": {
          "type": "integer",
          "minimum": 1,
          "maximum": 3
        },
        "scheduled_delay_seconds": {
          "enum": [0, 30, 90]
        },
        "scheduled_for": {
          "type": "string",
          "format": "date-time",
          "description": "Logical attempt time fixed by the signed repeat schedule and retry policy."
        },
        "started_at": {
          "type": "string",
          "format": "date-time",
          "description": "Actual start of the unit-level execution attempt that contains this cell. Cells in one unit can share this value."
        },
        "model_started": {
          "type": "boolean",
          "description": "Whether this cell crossed the model-execution boundary during the unit attempt."
        },
        "disposition": {
          "enum": [
            "completed",
            "infrastructure_retryable",
            "infrastructure_terminal",
            "model_failure",
            "evaluator_failure",
            "unsupported",
            "unevaluated"
          ]
        },
        "infrastructure_classification": {
          "enum": ["pre_model_admission", null]
        },
        "result_digest": {
          "oneOf": [
            {
              "$ref": "#/$defs/digest"
            },
            {
              "type": "null"
            }
          ]
        },
        "result_package_digest": {
          "oneOf": [
            {
              "$ref": "#/$defs/digest"
            },
            {
              "type": "null"
            }
          ]
        },
        "verifier_attestation_digest": {
          "oneOf": [
            {
              "$ref": "#/$defs/digest"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "allOf": [
        {
          "if": {
            "properties": {
              "disposition": {
                "enum": ["infrastructure_retryable", "infrastructure_terminal"]
              }
            },
            "required": ["disposition"]
          },
          "then": {
            "properties": {
              "model_started": {
                "const": false
              },
              "infrastructure_classification": {
                "const": "pre_model_admission"
              },
              "result_digest": {
                "type": "null"
              },
              "result_package_digest": {
                "type": "null"
              },
              "verifier_attestation_digest": {
                "type": "null"
              }
            }
          }
        },
        {
          "if": {
            "properties": {
              "disposition": {
                "const": "completed"
              }
            },
            "required": ["disposition"]
          },
          "then": {
            "properties": {
              "model_started": {
                "const": true
              },
              "infrastructure_classification": {
                "type": "null"
              },
              "result_digest": {
                "$ref": "#/$defs/digest"
              },
              "result_package_digest": {
                "$ref": "#/$defs/digest"
              },
              "verifier_attestation_digest": {
                "$ref": "#/$defs/digest"
              }
            }
          }
        },
        {
          "if": {
            "properties": {
              "disposition": {
                "enum": ["model_failure", "evaluator_failure", "unsupported", "unevaluated"]
              }
            },
            "required": ["disposition"]
          },
          "then": {
            "properties": {
              "infrastructure_classification": {
                "type": "null"
              },
              "result_digest": {
                "type": "null"
              },
              "result_package_digest": {
                "type": "null"
              },
              "verifier_attestation_digest": {
                "type": "null"
              }
            }
          }
        },
        {
          "if": {
            "properties": {
              "disposition": {
                "const": "evaluator_failure"
              }
            },
            "required": ["disposition"]
          },
          "then": {
            "properties": {
              "model_started": {
                "const": true
              }
            }
          }
        },
        {
          "if": {
            "properties": {
              "disposition": {
                "const": "unsupported"
              }
            },
            "required": ["disposition"]
          },
          "then": {
            "properties": {
              "model_started": {
                "const": false
              }
            }
          }
        }
      ]
    },
    "contrastPair": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "repeat_id",
        "model_id",
        "reference_score",
        "challenge_score",
        "reference_result_digest",
        "reference_result_package_digest",
        "reference_verifier_attestation_digest",
        "challenge_result_digest",
        "challenge_result_package_digest",
        "challenge_verifier_attestation_digest"
      ],
      "properties": {
        "repeat_id": {
          "$ref": "#/$defs/identifier"
        },
        "model_id": {
          "$ref": "#/$defs/identifier"
        },
        "reference_score": {
          "type": "number",
          "minimum": 0,
          "maximum": 1
        },
        "challenge_score": {
          "type": "number",
          "minimum": 0,
          "maximum": 1
        },
        "reference_result_digest": {
          "$ref": "#/$defs/digest"
        },
        "reference_result_package_digest": {
          "$ref": "#/$defs/digest"
        },
        "reference_verifier_attestation_digest": {
          "$ref": "#/$defs/digest"
        },
        "challenge_result_digest": {
          "$ref": "#/$defs/digest"
        },
        "challenge_result_package_digest": {
          "$ref": "#/$defs/digest"
        },
        "challenge_verifier_attestation_digest": {
          "$ref": "#/$defs/digest"
        }
      }
    },
    "contrast": {
      "type": "object",
      "additionalProperties": false,
      "required": ["contrast_id", "reference_variant_digest", "challenge_variant_digest", "pairs"],
      "properties": {
        "contrast_id": {
          "type": "string"
        },
        "reference_variant_digest": {
          "$ref": "#/$defs/digest"
        },
        "challenge_variant_digest": {
          "$ref": "#/$defs/digest"
        },
        "pairs": {
          "type": "array",
          "minItems": 51,
          "maxItems": 51,
          "items": {
            "$ref": "#/$defs/contrastPair"
          }
        }
      }
    },
    "coupledConstraints": {
      "allOf": [
        {
          "$ref": "#/$defs/contrast"
        },
        {
          "properties": {
            "contrast_id": {
              "const": "coupled_constraints"
            }
          }
        }
      ]
    },
    "ambiguousRecoveryState": {
      "allOf": [
        {
          "$ref": "#/$defs/contrast"
        },
        {
          "properties": {
            "contrast_id": {
              "const": "ambiguous_recovery_state"
            }
          }
        }
      ]
    },
    "plausibleIncompleteEvidence": {
      "allOf": [
        {
          "$ref": "#/$defs/contrast"
        },
        {
          "properties": {
            "contrast_id": {
              "const": "plausible_incomplete_evidence"
            }
          }
        }
      ]
    }
  }
}

`;
export type CandidateArtifactClass =
  | 'result_package_bundle'
  | 'evaluator_result_bundle'
  | 'verifier_replay_bundle'
  | 'attempt_log_bundle';

export interface CandidateArtifactInput {
  readonly unit_id: string;
  readonly artifact_class: CandidateArtifactClass;
  readonly artifact: JsonObject;
}

export interface CandidateSourceAssemblerInput {
  readonly operation: 'derive_source' | 'finalize';
  readonly admission: ReleaseGateAuthority['admission'];
  readonly authority: ReleaseGateAuthority | null;
  /** Runtime-pinned trust policy; this must not be selected by an artifact caller. */
  readonly runtime_pinned_trust_policy: ReleaseGateTrustPolicy | null;
  readonly expectations: JsonObject;
  readonly authorization: JsonObject;
  /** Exactly 84 entries: four adjacent artifacts for each of the 21 signed plan units. */
  readonly artifacts: readonly CandidateArtifactInput[];
  readonly collected_at: string;
}

export interface CandidateFinalSourceAssemblerInput extends CandidateSourceAssemblerInput {
  readonly operation: 'finalize';
  readonly authority: ReleaseGateAuthority;
  readonly runtime_pinned_trust_policy: ReleaseGateTrustPolicy;
}

export interface CandidateSourceObservations {
  readonly schema_version: 'aiq.release-gate-source-observations.v1';
  readonly release_identity: 'aiq-core/1.0.2';
  readonly catalog_release_identity_digest: string;
  readonly task_metadata_identity_digest: string;
  readonly corpus_commitment_digest: string;
  readonly model_matrix_digest: string;
  readonly collected_at: string;
  readonly repeat_ids: readonly string[];
  readonly raw_cells: readonly Omit<
    ReleaseGateRawCell,
    'cell_evidence_binding_digest' | 'universe_slot'
  >[];
  readonly paired_contrasts: ReleaseGateEvidence['paired_contrasts'];
}

export interface CandidateSourceAssembly {
  readonly source_observations: CandidateSourceObservations;
  readonly release_gate_evidence: ReleaseGateEvidence;
  readonly release_gate_result: ReleaseGateResult;
}

export interface CandidateSourceDerivation {
  readonly source_observations: CandidateSourceObservations;
  readonly source_observations_digest: string;
}

const ARTIFACT_CLASSES: readonly CandidateArtifactClass[] = [
  'result_package_bundle',
  'evaluator_result_bundle',
  'verifier_replay_bundle',
  'attempt_log_bundle',
];
const ENVELOPE_SCHEMA = 'aiq.candidate-signed-envelope.v1';
const PAYLOAD_TYPES = {
  unitRun: 'aiq.candidate-unit-run.v1',
  result: 'aiq.candidate-cell-result.v1',
  evaluator: 'aiq.candidate-cell-evaluator.v1',
  verifier: 'aiq.candidate-cell-verification.v1',
  attempt: 'aiq.candidate-cell-attempt-log.v1',
} as const;

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function object(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) {
    throw new Error(`Candidate ${label} has an invalid shape.`);
  }
  return value;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Candidate ${label} has an invalid shape.`);
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`Candidate ${label} has an invalid shape.`);
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(Reflect.get(value, key))}`)
      .join(',')}}`;
  }
  throw new Error('Candidate artifact cannot be canonically encoded.');
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function exact(value: unknown, expected: unknown, label: string): void {
  if (canonicalJson(value) !== canonicalJson(expected)) {
    throw new Error(`Candidate ${label} does not match the signed plan.`);
  }
}

function exactKeys(value: JsonObject, expected: readonly string[], label: string): void {
  if (canonicalJson(Object.keys(value).toSorted()) !== canonicalJson(expected.toSorted())) {
    throw new Error(`Candidate ${label} contains unsupported fields.`);
  }
}

function validateSourceObservations(value: CandidateSourceObservations): void {
  const schemaValue: unknown = JSON.parse(SOURCE_OBSERVATIONS_SCHEMA_JSON);
  const schema = object(schemaValue, 'source observations schema');
  if (!matchesSchema(value, schema, schema)) {
    throw new Error('Candidate source observations do not match their public schema.');
  }
}

function unsigned(value: JsonObject): JsonObject {
  const { signature: _signature, ...remaining } = value;
  return remaining;
}

function verifyHexSignature(value: JsonObject, publicKeyHex: string, label: string): void {
  try {
    const publicBytes = Buffer.from(publicKeyHex, 'hex');
    const publicKey = createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicBytes]),
      format: 'der',
      type: 'spki',
    });
    const signature = Buffer.from(string(value.signature, `${label} signature`), 'hex');
    if (
      publicBytes.length !== 32 ||
      signature.length !== 64 ||
      !verify(null, Buffer.from(canonicalJson(unsigned(value))), publicKey, signature)
    ) {
      throw new Error();
    }
  } catch {
    throw new Error(`Candidate ${label} signature is invalid.`);
  }
}

function verifyAuthorization(input: CandidateSourceAssemblerInput): JsonObject {
  const authorization = input.authorization;
  const plan = object(authorization.plan, 'private plan');
  const signer = object(authorization.signer, 'authorization signer');
  const expectations = input.expectations;
  exactKeys(
    authorization,
    [
      'schema_version',
      'signature_domain',
      'signature_encoding',
      'purpose',
      'release_identity',
      'execution_plan_digest',
      'signed_admission_sha256',
      'private_plan_sha256',
      'plan',
      'signer',
      'signature',
    ],
    'authorization',
  );
  if (
    authorization.schema_version !== 'aiq.candidate-execution-authorization.v1' ||
    authorization.signature_domain !== authorization.schema_version ||
    authorization.signature_encoding !== 'aiq.sorted-key-json.v1' ||
    authorization.release_identity !== 'aiq-core/1.0.2' ||
    authorization.execution_plan_digest !== plan.execution_plan_digest ||
    authorization.signed_admission_sha256 !== plan.signed_admission_sha256 ||
    authorization.private_plan_sha256 !== digest(plan) ||
    expectations.authorization_sha256 !== digest(authorization) ||
    expectations.authorization_signer_node_id !== signer.node_id ||
    expectations.authorization_signer_public_key !== signer.public_key ||
    signer.algorithm !== 'ed25519'
  ) {
    throw new Error('Candidate authorization or expectations do not match.');
  }
  const publicKeyHex = string(signer.public_key, 'authorization public key');
  const nodeId = `candidate_node_${createHash('sha256')
    .update(Buffer.from(publicKeyHex, 'hex'))
    .digest('hex')}`;
  if (nodeId !== signer.node_id) throw new Error('Candidate authorization signer is invalid.');
  verifyHexSignature(authorization, publicKeyHex, 'authorization');

  const admission = input.admission;
  const admissionDigest = releaseAdmissionDigest(admission);
  if (
    plan.signed_admission_sha256 !== admissionDigest ||
    plan.execution_plan_digest !== admission.execution_plan_digest ||
    plan.corpus_manifest_sha256 !== admission.corpus_commitment_digest ||
    expectations.signed_admission_sha256 !== admissionDigest ||
    expectations.execution_plan_sha256 !== admission.execution_plan_digest ||
    expectations.corpus_manifest_sha256 !== admission.corpus_commitment_digest ||
    expectations.authorization_path !== plan.authorization_path ||
    expectations.signed_admission_path !== plan.signed_admission_path ||
    expectations.corpus_manifest_path !== plan.corpus_manifest_path ||
    expectations.core_corpus_commitment_path !== plan.core_corpus_commitment_path ||
    expectations.core_corpus_commitment_sha256 !== plan.core_corpus_commitment_sha256 ||
    expectations.contrast_corpus_commitment_path !== plan.contrast_corpus_commitment_path ||
    expectations.contrast_corpus_commitment_sha256 !== plan.contrast_corpus_commitment_sha256
  ) {
    throw new Error('Candidate plan, admission, and expectations are inconsistent.');
  }
  return plan;
}

function expectedUnitBinding(authorization: JsonObject, unit: JsonObject): JsonObject {
  return {
    release_identity: 'aiq-core/1.0.2',
    execution_plan_digest: authorization.execution_plan_digest,
    private_plan_sha256: authorization.private_plan_sha256,
    signed_admission_sha256: authorization.signed_admission_sha256,
    repeat_id: unit.repeat_id,
    unit_id: unit.unit_id,
    slot_id: unit.slot_id,
    kind: unit.kind,
    contrast_id: unit.contrast_id,
    contrast_arm: unit.contrast_arm,
    variant_sha256: unit.variant_sha256,
    corpus_commitment_sha256: unit.corpus_commitment_sha256,
  } satisfies JsonObject;
}

function verifyEnvelope(
  envelopeValue: unknown,
  payloadType: string,
  signerNodeId: string,
): { envelope: JsonObject; payload: JsonObject; envelopeDigest: string } {
  const envelope = object(envelopeValue, 'signed envelope');
  const signer = object(envelope.signer, 'envelope signer');
  const payload = object(envelope.payload, 'envelope payload');
  exactKeys(
    envelope,
    [
      'schema_version',
      'idempotency_key',
      'payload_type',
      'content_hash',
      'signer',
      'claimed_trust',
      'payload',
      'signature',
    ],
    'signed envelope',
  );
  const payloadKeys: Record<string, readonly string[]> = {
    [PAYLOAD_TYPES.unitRun]: ['schema_version', 'unit', 'run'],
    [PAYLOAD_TYPES.result]: [
      'schema_version',
      'unit',
      'cell',
      'unit_run_envelope_sha256',
      'result_sha256',
      'result_id',
    ],
    [PAYLOAD_TYPES.evaluator]: [
      'schema_version',
      'unit',
      'cell',
      'result_package_sha256',
      'persisted_evaluator_sha256',
      'evaluator',
    ],
    [PAYLOAD_TYPES.verifier]: [
      'schema_version',
      'unit',
      'cell',
      'result_package_sha256',
      'evaluator_package_sha256',
      'replayed_evaluator_sha256',
      'verified',
      'disposition',
    ],
    [PAYLOAD_TYPES.attempt]: [
      'schema_version',
      'unit',
      'cell',
      'result_package_sha256',
      'evaluator_package_sha256',
      'verifier_attestation_sha256',
      'attempts',
    ],
  };
  exactKeys(payload, payloadKeys[payloadType] ?? [], 'signed payload');
  if (
    envelope.schema_version !== ENVELOPE_SCHEMA ||
    envelope.payload_type !== payloadType ||
    envelope.claimed_trust !== 'untrusted' ||
    signer.node_id !== signerNodeId ||
    payload.schema_version !== payloadType ||
    envelope.content_hash !== digest(payload)
  ) {
    throw new Error('Candidate signed artifact identity or digest is invalid.');
  }
  const publicKeyHex = string(signer.public_key, 'artifact signer public key');
  const nodeId = `node_${createHash('sha256').update(Buffer.from(publicKeyHex, 'hex')).digest('hex')}`;
  if (nodeId !== signerNodeId) throw new Error('Candidate artifact signer is invalid.');
  verifyHexSignature(envelope, publicKeyHex, 'artifact');
  return { envelope, payload, envelopeDigest: digest(envelope) };
}

function modelKey(result: JsonObject): string {
  const model = object(result.model, 'result model');
  return `gpt-5.6-${string(model.family, 'model family')}-${string(
    model.reasoning_effort,
    'reasoning effort',
  )}`;
}

function resultDigest(result: JsonObject): string {
  return digest({ ...result, result_id: '' });
}

function statusFor(result: JsonObject): ReleaseGateRawCell['status'] {
  switch (result.status) {
    case 'completed':
      return 'completed';
    case 'unsupported':
      return 'unsupported';
    case 'unevaluated':
      return 'unevaluated';
    case 'failed': {
      const failure = object(result.failure, 'result failure');
      if (
        [
          'capability_unavailable',
          'capability_validation_failed',
          'workspace_unavailable',
        ].includes(string(failure.kind, 'failure kind'))
      )
        return 'infrastructure_failure';
      if (failure.kind === 'evaluator_failure') return 'evaluator_failure';
      return 'model_failure';
    }
    default:
      throw new Error('Candidate result status is invalid.');
  }
}

function expectedAttemptDisposition(status: ReleaseGateRawCell['status']): string {
  return status === 'infrastructure_failure' ? 'infrastructure_terminal' : status;
}

function isAttemptDisposition(value: unknown): value is ReleaseGateAttemptDisposition {
  return (
    value === 'completed' ||
    value === 'infrastructure_retryable' ||
    value === 'infrastructure_terminal' ||
    value === 'model_failure' ||
    value === 'evaluator_failure' ||
    value === 'unsupported' ||
    value === 'unevaluated'
  );
}

function components(value: JsonObject): readonly ComponentEvidence[] {
  return array(value.components, 'evaluator components').map((entry, index) => {
    const component = object(entry, 'evaluator component');
    const assertions = array(component.assertions, 'evaluator assertions').map(
      (item, assertionIndex) => {
        const assertion = object(item, 'evaluator assertion');
        exactKeys(assertion, ['assertion_id', 'evidence_sha256', 'passed'], 'evaluator assertion');
        const privateAssertionId = string(assertion.assertion_id, 'assertion ID');
        const evidenceDigest = string(assertion.evidence_sha256, 'assertion evidence digest');
        if (
          !/^[a-z0-9][a-z0-9._-]*$/u.test(privateAssertionId) ||
          typeof assertion.passed !== 'boolean' ||
          !/^sha256:[0-9a-f]{64}$/u.test(evidenceDigest)
        ) {
          throw new Error('Candidate evaluator assertion is invalid.');
        }
        return {
          privateAssertionId,
          assertion_id: publicAssertionId(assertionIndex),
          passed: assertion.passed,
          evidence_digest: evidenceDigest,
        };
      },
    );
    const expectedIds = ['component_01', 'component_02', 'component_03', 'component_04'] as const;
    const expectedWeights = [3000, 2500, 2500, 2000] as const;
    const expectedId = expectedIds[index];
    const expectedWeight = expectedWeights[index];
    if (
      expectedId === undefined ||
      expectedWeight === undefined ||
      component.component_id !== expectedId ||
      component.weight_basis_points !== expectedWeight
    ) {
      throw new Error('Candidate evaluator component order is invalid.');
    }
    if (
      assertions.length < 3 ||
      assertions.length > 64 ||
      new Set(assertions.map(({ privateAssertionId }) => privateAssertionId)).size !==
        assertions.length
    ) {
      throw new Error('Candidate evaluator assertion count or identity is invalid.');
    }
    return {
      component_id: expectedId,
      weight_basis_points: expectedWeight,
      passed_assertions: assertions.filter(({ passed }) => passed).length,
      total_assertions: assertions.length,
      assertions: assertions.map(
        ({ privateAssertionId: _privateAssertionId, ...assertion }) => assertion,
      ),
    };
  });
}

function publicAssertionId(index: number): string {
  return `assertion_${String(index + 1).padStart(3, '0')}`;
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  while (right !== 0n) [left, right] = [right, left % right];
  return left < 0n ? -left : left;
}

function validateCandidateEvaluator(
  evaluator: JsonObject,
  publicComponents: readonly ComponentEvidence[],
): void {
  if (evaluator.schema_version !== 'aiq.candidate-evaluator-result.v1') {
    throw new Error('Candidate evaluator identity is invalid.');
  }
  let numerator = 0n;
  let denominator = 1n;
  for (const component of publicComponents) {
    const termNumerator =
      BigInt(component.weight_basis_points) * BigInt(component.passed_assertions);
    const termDenominator = 10_000n * BigInt(component.total_assertions);
    const combinedNumerator = numerator * termDenominator + termNumerator * denominator;
    const combinedDenominator = denominator * termDenominator;
    const divisor = greatestCommonDivisor(combinedNumerator, combinedDenominator);
    numerator = combinedNumerator / divisor;
    denominator = combinedDenominator / divisor;
  }
  const suppliedNumerator = evaluator.score_numerator;
  const suppliedDenominator = evaluator.score_denominator;
  const rounded = (numerator * 1_000_000n + denominator / 2n) / denominator;
  const decimal = `${rounded / 1_000_000n}.${String(rounded % 1_000_000n).padStart(6, '0')}`;
  if (
    typeof suppliedNumerator !== 'number' ||
    typeof suppliedDenominator !== 'number' ||
    !Number.isSafeInteger(suppliedNumerator) ||
    !Number.isSafeInteger(suppliedDenominator) ||
    BigInt(suppliedNumerator) !== numerator ||
    BigInt(suppliedDenominator) !== denominator ||
    evaluator.score_decimal_6 !== decimal
  ) {
    throw new Error('Candidate evaluator score does not match its signed assertions.');
  }
}

function verifyAttempts(
  attemptsValue: unknown,
  status: ReleaseGateRawCell['status'],
  unit: JsonObject,
  resultDigestValue: string,
  resultPackageDigest: string,
  verifierDigest: string,
): ReleaseGateRawCell['attempts'] {
  const attempts = array(attemptsValue, 'attempt history').map((item): ReleaseGateAttempt => {
    const attempt = object(item, 'attempt history entry');
    exactKeys(
      attempt,
      [
        'attempt_number',
        'scheduled_delay_seconds',
        'scheduled_for',
        'started_at',
        'model_started',
        'disposition',
        'infrastructure_classification',
        'result_digest',
        'result_package_digest',
        'verifier_attestation_digest',
      ],
      'attempt history entry',
    );
    const attemptNumber = attempt.attempt_number;
    const scheduledDelay = attempt.scheduled_delay_seconds;
    const modelStarted = attempt.model_started;
    const disposition = attempt.disposition;
    const infrastructureClassification = attempt.infrastructure_classification;
    const projectedResultDigest = attempt.result_digest;
    const projectedResultPackageDigest = attempt.result_package_digest;
    const verifierAttestationDigest = attempt.verifier_attestation_digest;
    if (
      typeof attemptNumber !== 'number' ||
      !Number.isInteger(attemptNumber) ||
      (scheduledDelay !== 0 && scheduledDelay !== 30 && scheduledDelay !== 90) ||
      typeof modelStarted !== 'boolean' ||
      !isAttemptDisposition(disposition) ||
      (infrastructureClassification !== null &&
        infrastructureClassification !== 'pre_model_admission') ||
      (projectedResultDigest !== null && typeof projectedResultDigest !== 'string') ||
      (projectedResultPackageDigest !== null && typeof projectedResultPackageDigest !== 'string') ||
      (verifierAttestationDigest !== null && typeof verifierAttestationDigest !== 'string')
    ) {
      throw new Error('Candidate attempt history entry has an invalid shape.');
    }
    return {
      attempt_number: attemptNumber,
      scheduled_delay_seconds: scheduledDelay,
      scheduled_for: string(attempt.scheduled_for, 'attempt schedule'),
      started_at: string(attempt.started_at, 'attempt start'),
      model_started: modelStarted,
      disposition,
      infrastructure_classification: infrastructureClassification,
      result_digest: projectedResultDigest,
      result_package_digest: projectedResultPackageDigest,
      verifier_attestation_digest: verifierAttestationDigest,
    };
  });
  if (attempts.length < 1 || attempts.length > 3) {
    throw new Error('Candidate attempt lifecycle is invalid.');
  }
  const delays = [0, 30, 90] as const;
  const slot = Date.parse(string(unit.slot_id, 'unit slot'));
  attempts.forEach((attempt, index) => {
    const delay = delays[index];
    if (delay === undefined) throw new Error('Candidate attempt lifecycle is invalid.');
    const terminal = index === attempts.length - 1;
    const hasProvenance =
      attempt.result_digest !== null ||
      attempt.result_package_digest !== null ||
      attempt.verifier_attestation_digest !== null;
    if (
      attempt.attempt_number !== index + 1 ||
      attempt.scheduled_delay_seconds !== delay ||
      Date.parse(string(attempt.scheduled_for, 'attempt schedule')) !== slot + delay * 1000 ||
      Date.parse(string(attempt.started_at, 'attempt start')) <
        Date.parse(string(attempt.scheduled_for, 'attempt schedule')) ||
      (index > 0 &&
        Date.parse(string(attempt.started_at, 'attempt start')) <=
          Date.parse(string(attempts[index - 1]?.started_at, 'previous attempt start'))) ||
      (!terminal &&
        (attempt.disposition !== 'infrastructure_retryable' ||
          attempt.model_started ||
          attempt.infrastructure_classification !== 'pre_model_admission' ||
          hasProvenance))
    ) {
      throw new Error('Candidate attempt lifecycle is invalid.');
    }
    if (terminal) {
      if (attempt.disposition !== expectedAttemptDisposition(status)) {
        throw new Error('Candidate terminal attempt does not match its result status.');
      }
      if (status === 'completed') {
        if (
          !attempt.model_started ||
          attempt.infrastructure_classification !== null ||
          attempt.result_digest !== resultDigestValue ||
          attempt.result_package_digest !== resultPackageDigest ||
          attempt.verifier_attestation_digest !== verifierDigest
        )
          throw new Error('Candidate completed attempt provenance is invalid.');
      } else if (hasProvenance) {
        throw new Error('Candidate incomplete attempt contains completed provenance.');
      }
    }
  });
  return attempts;
}

/**
 * Assembles public-safe release observations from exact signed candidate artifacts.
 * The function never logs artifacts and never includes response or controlled-corpus fields in output.
 */
export function assembleCandidateSource(
  input: CandidateFinalSourceAssemblerInput,
): Promise<CandidateSourceAssembly>;
export function assembleCandidateSource(
  input: CandidateSourceAssemblerInput,
): Promise<CandidateSourceAssembly | CandidateSourceDerivation>;
export async function assembleCandidateSource(
  input: CandidateSourceAssemblerInput,
): Promise<CandidateSourceAssembly | CandidateSourceDerivation> {
  const plan = verifyAuthorization(input);
  const units = array(plan.execution_units, 'execution units').map((value) =>
    object(value, 'execution unit'),
  );
  if (units.length !== 21 || input.artifacts.length !== 84) {
    throw new Error('Candidate artifact set must contain four artifacts for each of 21 units.');
  }
  const controlled = object(plan.controlled_inputs, 'controlled inputs');
  const runnerSigner = string(controlled.runner_signer_node_id, 'runner signer');
  const verifierSigner = string(controlled.verifier_signer_node_id, 'verifier signer');
  const catalogDomains = new Map(
    buildCatalog().tasks.map(({ task_id: taskId, domain }) => [taskId, domain]),
  );
  const admission = input.admission;
  const contrastTaskBindings = new Map(
    array(plan.contrast_task_bindings, 'contrast task bindings').map((value) => {
      const binding = object(value, 'contrast task binding');
      return [string(binding.contrast_id, 'contrast ID'), binding] as const;
    }),
  );
  let unitCursor = 0;
  for (const [repeatIndex, repeat] of admission.repeat_schedule.entries()) {
    const core = units[unitCursor++];
    if (
      core?.unit_id !== `repeat-${String(repeatIndex + 1).padStart(2, '0')}-core` ||
      core.repeat_id !== repeat.repeat_id ||
      core.slot_id !== repeat.scheduled_at ||
      core.kind !== 'core' ||
      canonicalJson(core.ordered_task_ids) !==
        canonicalJson(admission.observation_universe.task_ids)
    ) {
      throw new Error('Candidate core execution plan is invalid.');
    }
    for (const armBinding of repeat.contrast_arm_order) {
      const [contrastId, arm] = armBinding.split(':');
      const unit = units[unitCursor++];
      const tasks = contrastTaskBindings.get(contrastId ?? '');
      const admissionBinding = admission.contrast_bindings.find(
        ({ contrast_id: candidate }) => candidate === contrastId,
      );
      const contrastIndex = admission.contrast_bindings.findIndex(
        ({ contrast_id: candidate }) => candidate === contrastId,
      );
      const expectedTask =
        arm === 'reference' ? tasks?.reference_task_id : tasks?.challenge_task_id;
      const expectedVariant =
        arm === 'reference'
          ? admissionBinding?.reference_variant_digest
          : admissionBinding?.challenge_variant_digest;
      if (
        !unit ||
        !tasks ||
        !admissionBinding ||
        contrastIndex < 0 ||
        unit.unit_id !==
          `repeat-${String(repeatIndex + 1).padStart(2, '0')}-contrast-${String(
            contrastIndex + 1,
          ).padStart(2, '0')}-${arm}` ||
        unit.repeat_id !== repeat.repeat_id ||
        unit.slot_id !== repeat.scheduled_at ||
        unit.kind !== 'contrast' ||
        unit.contrast_id !== contrastId ||
        unit.contrast_arm !== arm ||
        unit.variant_sha256 !== expectedVariant ||
        canonicalJson(unit.ordered_task_ids) !== canonicalJson([expectedTask])
      ) {
        throw new Error('Candidate contrast execution plan is invalid.');
      }
    }
  }
  if (unitCursor !== units.length || runnerSigner === verifierSigner) {
    throw new Error('Candidate execution plan unit or signer count is invalid.');
  }
  const expectedModels = admission.model_matrix.configurations.map(
    ({
      model_id: modelId,
      execution_model_id: executionModelId,
      family,
      reasoning_effort: effort,
    }) => ({
      canonical_model_id: modelId,
      execution_model_id: executionModelId,
      model_name: `gpt-5.6-${family}`,
      reasoning_effort: effort,
    }),
  );
  if (units.some((unit) => canonicalJson(unit.models) !== canonicalJson(expectedModels))) {
    throw new Error('Candidate execution plan model identities are invalid.');
  }
  const coreCells = new Map<
    string,
    Omit<ReleaseGateRawCell, 'cell_evidence_binding_digest' | 'universe_slot'>
  >();
  const contrastCells = new Map<
    string,
    { score: number; result: string; package: string; verifier: string }
  >();

  for (const [unitIndex, unit] of units.entries()) {
    const supplied = input.artifacts.slice(unitIndex * 4, unitIndex * 4 + 4);
    for (const [classIndex, artifactInput] of supplied.entries()) {
      if (
        artifactInput?.unit_id !== unit.unit_id ||
        artifactInput.artifact_class !== ARTIFACT_CLASSES[classIndex]
      ) {
        throw new Error('Candidate artifacts are missing, duplicated, extra, or misordered.');
      }
    }
    const [resultInput, evaluatorInput, verifierInput, attemptInput] = supplied;
    if (!resultInput || !evaluatorInput || !verifierInput || !attemptInput) {
      throw new Error('Candidate artifact set is incomplete.');
    }
    const expectedBinding = expectedUnitBinding(input.authorization, unit);
    const resultsBundle = resultInput.artifact;
    const evaluatorsBundle = evaluatorInput.artifact;
    const verifiersBundle = verifierInput.artifact;
    const attemptsBundle = attemptInput.artifact;
    exactKeys(resultsBundle, ['schema_version', 'unit', 'unit_run', 'cells'], 'result bundle');
    exactKeys(
      evaluatorsBundle,
      ['schema_version', 'unit', 'result_bundle_sha256', 'cells'],
      'evaluator bundle',
    );
    exactKeys(
      verifiersBundle,
      ['schema_version', 'unit', 'result_bundle_sha256', 'evaluator_bundle_sha256', 'cells'],
      'verifier bundle',
    );
    exactKeys(
      attemptsBundle,
      [
        'schema_version',
        'unit',
        'result_bundle_sha256',
        'evaluator_bundle_sha256',
        'verifier_bundle_sha256',
        'cells',
      ],
      'attempt bundle',
    );
    exact(resultsBundle.unit, expectedBinding, 'result bundle unit');
    exact(evaluatorsBundle.unit, expectedBinding, 'evaluator bundle unit');
    exact(verifiersBundle.unit, expectedBinding, 'verifier bundle unit');
    exact(attemptsBundle.unit, expectedBinding, 'attempt bundle unit');
    if (
      resultsBundle.schema_version !== 'aiq.candidate-result-package-bundle.v1' ||
      evaluatorsBundle.schema_version !== 'aiq.candidate-evaluator-result-bundle.v1' ||
      verifiersBundle.schema_version !== 'aiq.candidate-verifier-replay-bundle.v1' ||
      attemptsBundle.schema_version !== 'aiq.candidate-attempt-log.v1' ||
      evaluatorsBundle.result_bundle_sha256 !== digest(resultsBundle) ||
      verifiersBundle.result_bundle_sha256 !== digest(resultsBundle) ||
      verifiersBundle.evaluator_bundle_sha256 !== digest(evaluatorsBundle) ||
      attemptsBundle.result_bundle_sha256 !== digest(resultsBundle) ||
      attemptsBundle.evaluator_bundle_sha256 !== digest(evaluatorsBundle) ||
      attemptsBundle.verifier_bundle_sha256 !== digest(verifiersBundle)
    ) {
      throw new Error('Candidate artifact bundle digest chain is invalid.');
    }
    const runEnvelope = verifyEnvelope(resultsBundle.unit_run, PAYLOAD_TYPES.unitRun, runnerSigner);
    exact(runEnvelope.payload.unit, expectedBinding, 'unit run binding');
    const run = object(runEnvelope.payload.run, 'unit run');
    const provenance = object(run.provenance, 'run provenance');
    const taskIds = array(unit.ordered_task_ids, 'ordered task IDs').map((value) =>
      string(value, 'task ID'),
    );
    const models = array(unit.models, 'unit models').map((value) => object(value, 'unit model'));
    const runResults = array(run.results, 'unit results').map((value) => object(value, 'result'));
    if (
      run.schema_version !== 'aiq.calibration-run.v3' ||
      run.official_eligible !== false ||
      run.classification !== 'local_calibration_non_official' ||
      run.scoring_version !== '1.0.2' ||
      canonicalJson(run.task_ids) !== canonicalJson(taskIds) ||
      canonicalJson(run.models) !==
        canonicalJson(
          models.map(({ model_name: modelName, reasoning_effort: effort }) => ({
            family: string(modelName, 'model name').slice('gpt-5.6-'.length),
            reasoning_effort: effort,
          })),
        ) ||
      runResults.length !== taskIds.length * models.length
    ) {
      throw new Error('Candidate unit run does not match its signed execution unit.');
    }
    const runtime = object(plan.runtime, 'plan runtime');
    const expectedCatalog =
      unit.kind === 'core'
        ? 'sha256:2c5efe162b49e710e6e52b0f3a4e33d1127d0dd54d4f15694f88911bcb7fc937'
        : 'sha256:fa0fbbd01a00874791b592a2661b91a44189ea53e691af1616c76d271b6c7a66';
    const prefix = unit.kind === 'core' ? 'core' : 'contrast';
    if (
      provenance.schema_version !== 'aiq.run-provenance.v2' ||
      provenance.run_class !== 'calibration' ||
      provenance.corpus_commitment_sha256 !== unit.corpus_commitment_sha256 ||
      provenance.catalog_digest !== expectedCatalog ||
      provenance.task_set_digest !== run.task_set_hash ||
      provenance.preflight_digest !== digest(run.capability_validation) ||
      provenance.runner_executable_digest !== runtime.runner_executable_sha256 ||
      provenance.harness_digest !== runtime[`${prefix}_harness_sha256`] ||
      provenance.tool_policy_digest !== runtime[`${prefix}_tool_policy_sha256`] ||
      provenance.network_policy_digest !== runtime[`${prefix}_network_policy_sha256`] ||
      !/^sha256:[0-9a-f]{64}$/u.test(string(provenance.runtime_digest, 'runtime digest'))
    ) {
      throw new Error('Candidate unit run provenance does not match its signed execution unit.');
    }
    const resultCells = array(resultsBundle.cells, 'result cells');
    const evaluatorCells = array(evaluatorsBundle.cells, 'evaluator cells');
    const verifierCells = array(verifiersBundle.cells, 'verifier cells');
    const attemptCells = array(attemptsBundle.cells, 'attempt cells');
    if (
      [resultCells, evaluatorCells, verifierCells, attemptCells].some(
        (cells) => cells.length !== runResults.length,
      )
    ) {
      throw new Error('Candidate artifact bundle cell count is invalid.');
    }

    for (const [index, result] of runResults.entries()) {
      const modelIndex = Math.floor(index / taskIds.length);
      const taskIndex = index % taskIds.length;
      const model = models[modelIndex];
      const taskId = taskIds[taskIndex];
      if (model === undefined || taskId === undefined) {
        throw new Error('Candidate result index is outside its signed execution unit.');
      }
      const expectedCell = {
        repeat_id: unit.repeat_id,
        unit_id: unit.unit_id,
        result_index: index,
        task_id: taskId,
        task_version: result.task_version,
        model_id: model.canonical_model_id,
        execution_model_id: model.execution_model_id,
      };
      const observedResultDigest = resultDigest(result);
      if (
        result.task_id !== taskId ||
        modelKey(result) !== model.execution_model_id ||
        result.result_id !== `result_${observedResultDigest.slice('sha256:'.length)}`
      ) {
        throw new Error('Candidate result task, model, order, or content address is invalid.');
      }
      const resultLeaf = verifyEnvelope(resultCells[index], PAYLOAD_TYPES.result, runnerSigner);
      const evaluatorLeaf = verifyEnvelope(
        evaluatorCells[index],
        PAYLOAD_TYPES.evaluator,
        runnerSigner,
      );
      const verifierLeaf = verifyEnvelope(
        verifierCells[index],
        PAYLOAD_TYPES.verifier,
        verifierSigner,
      );
      const attemptLeaf = verifyEnvelope(attemptCells[index], PAYLOAD_TYPES.attempt, runnerSigner);
      for (const leaf of [resultLeaf, evaluatorLeaf, verifierLeaf, attemptLeaf]) {
        exact(leaf.payload.unit, expectedBinding, 'cell unit binding');
        exact(leaf.payload.cell, expectedCell, 'cell identity');
      }
      if (
        resultLeaf.payload.unit_run_envelope_sha256 !== runEnvelope.envelopeDigest ||
        resultLeaf.payload.result_sha256 !== observedResultDigest ||
        resultLeaf.payload.result_id !== result.result_id ||
        evaluatorLeaf.payload.result_package_sha256 !== resultLeaf.envelopeDigest ||
        evaluatorLeaf.payload.persisted_evaluator_sha256 !== result.evaluator_result_sha256 ||
        verifierLeaf.payload.result_package_sha256 !== resultLeaf.envelopeDigest ||
        verifierLeaf.payload.evaluator_package_sha256 !== evaluatorLeaf.envelopeDigest ||
        attemptLeaf.payload.result_package_sha256 !== resultLeaf.envelopeDigest ||
        attemptLeaf.payload.evaluator_package_sha256 !== evaluatorLeaf.envelopeDigest ||
        attemptLeaf.payload.verifier_attestation_sha256 !== verifierLeaf.envelopeDigest
      ) {
        throw new Error('Candidate cell evidence digest chain is invalid.');
      }
      const status = statusFor(result);
      const evaluator =
        evaluatorLeaf.payload.evaluator === null
          ? null
          : object(evaluatorLeaf.payload.evaluator, 'candidate evaluator');
      const completed = status === 'completed';
      if (
        completed !== (evaluator !== null) ||
        completed !== (verifierLeaf.payload.verified === true) ||
        (completed && verifierLeaf.payload.replayed_evaluator_sha256 !== digest(evaluator)) ||
        (!completed && verifierLeaf.payload.replayed_evaluator_sha256 !== null) ||
        (evaluator !== null &&
          (evaluator.task_id !== taskId ||
            evaluator.task_version !== result.task_version ||
            evaluator.scorer_version !== '1.0.2')) ||
        verifierLeaf.payload.disposition !==
          (completed
            ? 'candidate_evaluator_replayed'
            : 'candidate_result_noncompleted_not_verified')
      ) {
        throw new Error('Candidate evaluator or independent verification disposition is invalid.');
      }
      const evaluatorComponents = evaluator === null ? null : components(evaluator);
      if (evaluator !== null && evaluatorComponents !== null) {
        validateCandidateEvaluator(evaluator, evaluatorComponents);
      }
      const score = evaluator === null ? null : Number(string(evaluator.score_decimal_6, 'score'));
      if (score !== null && (!Number.isFinite(score) || score !== result.task_score)) {
        throw new Error('Candidate evaluator score does not match the signed result.');
      }
      const attempts = verifyAttempts(
        attemptLeaf.payload.attempts,
        status,
        unit,
        observedResultDigest,
        resultLeaf.envelopeDigest,
        verifierLeaf.envelopeDigest,
      );
      if (unit.kind === 'core') {
        const domain = catalogDomains.get(taskId);
        if (domain === undefined) throw new Error('Candidate core task identity is unknown.');
        const repeatId = string(unit.repeat_id, 'repeat ID');
        const modelId = string(model.canonical_model_id, 'model ID');
        const key = `${repeatId}\0${taskId}\0${modelId}`;
        if (coreCells.has(key)) throw new Error('Candidate core observation is duplicated.');
        coreCells.set(key, {
          repeat_id: repeatId,
          task_id: taskId,
          domain,
          model_id: modelId,
          status,
          reported_score: score,
          components: evaluatorComponents,
          evaluator_digest: evaluator === null ? null : digest(evaluator),
          result_digest: completed ? observedResultDigest : null,
          result_package_digest: completed ? resultLeaf.envelopeDigest : null,
          verification_digest: completed ? verifierLeaf.envelopeDigest : null,
          verification_status: completed ? 'verified' : 'failed',
          attempts,
        });
      } else {
        if (!completed || score === null) {
          throw new Error('Candidate paired contrast observations must be completed and verified.');
        }
        const contrastId = string(unit.contrast_id, 'contrast ID');
        const repeatId = string(unit.repeat_id, 'repeat ID');
        const modelId = string(model.canonical_model_id, 'model ID');
        const contrastArm = string(unit.contrast_arm, 'contrast arm');
        const key = `${contrastId}\0${repeatId}\0${modelId}\0${contrastArm}`;
        if (contrastCells.has(key))
          throw new Error('Candidate contrast observation is duplicated.');
        contrastCells.set(key, {
          score,
          result: observedResultDigest,
          package: resultLeaf.envelopeDigest,
          verifier: verifierLeaf.envelopeDigest,
        });
      }
    }
  }

  const rawCells = admission.repeat_schedule.flatMap(({ repeat_id: repeatId }) =>
    admission.observation_universe.task_ids.flatMap((taskId) =>
      admission.observation_universe.model_ids.map((modelId) => {
        const cell = coreCells.get(`${repeatId}\0${taskId}\0${modelId}`);
        if (cell === undefined) throw new Error('Candidate core observation set is incomplete.');
        return cell;
      }),
    ),
  );
  const pairedContrasts = admission.contrast_bindings.map((binding) => ({
    ...binding,
    pairs: admission.repeat_schedule.flatMap(({ repeat_id: repeatId }) =>
      admission.observation_universe.model_ids.map((modelId) => {
        const reference = contrastCells.get(
          `${binding.contrast_id}\0${repeatId}\0${modelId}\0reference`,
        );
        const challenge = contrastCells.get(
          `${binding.contrast_id}\0${repeatId}\0${modelId}\0challenge`,
        );
        if (!reference || !challenge) throw new Error('Candidate contrast pair set is incomplete.');
        return {
          repeat_id: repeatId,
          model_id: modelId,
          reference_score: reference.score,
          challenge_score: challenge.score,
          reference_result_digest: reference.result,
          reference_result_package_digest: reference.package,
          reference_verifier_attestation_digest: reference.verifier,
          challenge_result_digest: challenge.result,
          challenge_result_package_digest: challenge.package,
          challenge_verifier_attestation_digest: challenge.verifier,
        };
      }),
    ),
  }));
  if (
    rawCells.length !== 3672 ||
    contrastCells.size !== 306 ||
    pairedContrasts.reduce((sum, item) => sum + item.pairs.length, 0) !== 153
  ) {
    throw new Error('Candidate source observation counts are invalid.');
  }
  const sourceObservations: CandidateSourceObservations = {
    schema_version: 'aiq.release-gate-source-observations.v1',
    release_identity: 'aiq-core/1.0.2',
    catalog_release_identity_digest: admission.catalog_release_identity_digest,
    task_metadata_identity_digest: admission.task_metadata_identity_digest,
    corpus_commitment_digest: admission.corpus_commitment_digest,
    model_matrix_digest: admission.model_matrix.digest,
    collected_at: input.collected_at,
    repeat_ids: admission.repeat_schedule.map(({ repeat_id: repeatId }) => repeatId),
    raw_cells: rawCells,
    paired_contrasts: pairedContrasts,
  };
  validateSourceObservations(sourceObservations);
  const derivedRawCells = sourceObservations.raw_cells.map((cell, index) => {
    const unsignedCell = { universe_slot: index + 1, ...cell };
    return {
      ...unsignedCell,
      cell_evidence_binding_digest:
        cell.status === 'completed' ? releaseCellEvidenceBindingDigest(unsignedCell) : null,
    };
  });
  const sourceObservationsDigest = releaseEvidenceSourceDigest(
    derivedRawCells,
    sourceObservations.paired_contrasts,
  );
  if (input.operation === 'derive_source') {
    if (input.authority !== null || input.runtime_pinned_trust_policy !== null) {
      throw new Error('Candidate source derivation cannot accept release authority inputs.');
    }
    return {
      source_observations: sourceObservations,
      source_observations_digest: sourceObservationsDigest,
    };
  }
  if (input.authority === null || input.runtime_pinned_trust_policy === null) {
    throw new Error('Candidate final assembly requires release authority inputs.');
  }
  exact(input.authority.admission, admission, 'release authority admission');
  const evidenceSchemaValue: unknown = JSON.parse(RELEASE_GATE_EVIDENCE_SCHEMA_JSON);
  const evidence = await assembleReleaseEvidence(
    input.authority,
    sourceObservations,
    object(evidenceSchemaValue, 'release evidence schema'),
  );
  if (sourceObservationsDigest !== input.authority.source_observations_digest) {
    throw new Error('Candidate source observations do not match the signed release authority.');
  }
  const gateResult = evaluateReleaseGate(
    evidence,
    input.authority,
    input.runtime_pinned_trust_policy,
    runtimePinnedReleaseGateTrustRoot(input.runtime_pinned_trust_policy),
  );
  if (
    gateResult.failures.includes('invalid_authority') ||
    gateResult.failures.includes('invalid_evidence')
  ) {
    throw new Error('Candidate release authority, trust policy, or evidence is invalid.');
  }
  return {
    source_observations: sourceObservations,
    release_gate_evidence: evidence,
    release_gate_result: gateResult,
  };
}

async function runCandidateSourceAssemblerCli(): Promise<void> {
  if (process.argv.length !== 2) throw new Error('Candidate assembler accepts no selectors.');
  const chunks: Buffer[] = [];
  let inputBytes = 0;
  for await (const chunk of process.stdin) {
    const value: unknown = chunk;
    if (!Buffer.isBuffer(value)) throw new Error('Candidate assembler input has an invalid type.');
    const bytes = Buffer.from(value);
    inputBytes += bytes.length;
    if (inputBytes > 512 * 1024 * 1024) {
      throw new Error('Candidate assembler input is outside its byte limit.');
    }
    chunks.push(bytes);
  }
  if (inputBytes === 0) {
    throw new Error('Candidate assembler input is outside its byte limit.');
  }
  const bytes = Buffer.concat(chunks, inputBytes);
  const parsed: unknown = JSON.parse(bytes.toString('utf8'));
  const input = object(parsed, 'assembler input');
  exactKeys(
    input,
    [
      'artifacts',
      'admission',
      'authority',
      'authorization',
      'collected_at',
      'expectations',
      'operation',
      'runtime_pinned_trust_policy',
    ],
    'assembler input',
  );
  // The closed shape above and the assembler's field-level checks validate all
  // values before they are used.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const assembly = await assembleCandidateSource(input as unknown as CandidateSourceAssemblerInput);
  process.stdout.write(`${canonicalJson(assembly)}\n`);
}

if (import.meta.main) {
  try {
    await runCandidateSourceAssemblerCli();
  } catch {
    process.stderr.write('Candidate source assembly failed.\n');
    process.exitCode = 1;
  }
}
