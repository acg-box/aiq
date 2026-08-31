export const AIQ_CORE_TASK_SET_VERSION = '1.1.0';
export const AIQ_CORE_BENCHMARK_VERSION = `aiq-core@${AIQ_CORE_TASK_SET_VERSION}`;
export const AIQ_CORE_SCORING_VERSION = '1.0.8';
export const AIQ_CORE_TASK_SCORER_VERSION = '1.0.6';
export const AIQ_CORE_RELEASE_IDENTITY = `aiq-core/${AIQ_CORE_TASK_SET_VERSION}-candidate.20`;
export const AIQ_CORE_TASK_METADATA_IDENTITY =
  'sha256:3580555315d49a62b28b6947491819276dca5b261ade802f10b33808569d1708';
export const AIQ_CORE_CATALOG_RELEASE_IDENTITY =
  'sha256:5b651845280ea0b27a8cfc2aec4efe4c149bbbfdeeb0e5a9c883174938b58d69';
export const AIQ_CORE_TASK_SET_IDENTITY =
  'sha256:c7481e46c64dbf5ff9f50a85c83608d48390a03cbf9e94a1d89ab36aeb6df89a';
export const AIQ_CORE_EVALUATOR_IDENTITY =
  'sha256:748e0a6c07eb7e3407cc22d50b65eb6d055305cb6e1d719ca3cfd3a109bec809';

export const AIQ_CORE_TASK_SCORING_CONTRACT = {
  aggregation: 'configured_weighted_binary_check_fraction_with_hard_gates',
  check_scoring: 'binary',
  check_weighting: 'nonnegative_integer_weight_per_committed_check',
  weight_source: 'private_content_addressed_evaluator_configuration',
  formula: 'hard_gate_or_structural_failure ? 0 : sum(weight_i * passed_i) / sum(weight_i)',
  denominator_requirement: 'sum_of_positive_check_weights_greater_than_zero',
  hard_gate_definition: 'hard_gate_true_or_check_type_workspace_policy',
  hard_gate_rule: 'any_failed_committed_hard_gate_or_structural_failure_sets_score_to_zero',
  zero_weight_rule: 'only_committed_hard_gates_may_have_zero_weight',
  positive_weight_gate_rule:
    'positive_weight_hard_gate_also_participates_in_weighted_fraction_when_all_hard_gates_pass',
  evaluator_error_policy: 'unscored_invalid_evidence',
  attributable_runtime_failure_policy: 'task_score_null_excluded_from_semantic_scoring',
  outcome_rule: {
    correct: 'score_equals_one',
    partial: 'score_strictly_between_zero_and_one',
    incorrect: 'score_equals_zero',
  },
  rounding: 'no_evaluator_rounding_exact_replay',
  score_range: [0, 1],
  maximum_checks_per_result: 16,
  public_criteria_role: 'coverage_summary_not_weight_partition',
  verification: 'committed_configuration_and_result_checks_are_content_addressed_and_replayed',
} as const;
