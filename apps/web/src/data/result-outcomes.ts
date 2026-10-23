import type { CalibrationOutcome, ExecutionStatus } from './types.ts';
import { CALIBRATION_OUTCOMES } from './types.ts';
import { isFiniteNumber } from './rows/validation.ts';

export function executionStatusForOutcome(outcome: CalibrationOutcome): ExecutionStatus {
  if (outcome === 'correct' || outcome === 'partial' || outcome === 'incorrect') return 'completed';
  if (outcome === 'invalid' || outcome === 'missing' || outcome === 'not_applicable') {
    return outcome;
  }
  return 'runtime_issue';
}

const RESULT_EXPLANATION_SUMMARIES = {
  incorrect: 'The evaluator rejected the response.',
  timeout:
    'Execution ended at an external runtime or safety boundary; no semantic score was assigned.',
  budget_exhausted:
    'Execution ended at a non-scoring safety or provider boundary; no semantic score was assigned.',
  tool_failure: 'A permitted execution tool failed.',
  policy_failure: 'The result violated a controlled-output policy.',
  wrong_artifact: 'The expected artifact was not produced.',
  invalid: 'Benchmark infrastructure invalidated this result; an audited rerun is required.',
  missing: 'No task result was available.',
  not_applicable: 'The complete model configuration was unavailable.',
} as const satisfies Partial<Record<CalibrationOutcome, string>>;

export function isSafeResultCode(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 64 &&
    /^[a-z0-9][a-z0-9._:-]*$/.test(value)
  );
}

function isSafeExplanationSummary(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 512 ||
    !value.isWellFormed()
  ) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 31 || codeUnit === 127) return false;
  }
  return true;
}

export function resultExplanationSummaryForOutcome(outcome: CalibrationOutcome): string | null {
  if (outcome === 'correct' || outcome === 'partial') return null;
  return RESULT_EXPLANATION_SUMMARIES[outcome];
}

export function resultFailureCodeForOutcome(outcome: CalibrationOutcome): string | null {
  if (
    outcome === 'correct' ||
    outcome === 'partial' ||
    outcome === 'incorrect' ||
    outcome === 'missing'
  ) {
    return null;
  }
  if (outcome === 'timeout') return 'timeout';
  if (outcome === 'budget_exhausted') return 'budget_exceeded';
  if (outcome === 'tool_failure') return 'unsupported_model';
  if (outcome === 'policy_failure') return 'output_truncated';
  if (outcome === 'wrong_artifact') return 'missing_response';
  if (outcome === 'invalid') return 'evaluator_failure';
  return 'capability_unavailable';
}

function hasValidResultFailureCode(outcome: CalibrationOutcome, failureCode: unknown): boolean {
  if (resultFailureCodeForOutcome(outcome) === null) return failureCode === null;
  if (!isSafeResultCode(failureCode)) return false;
  if (outcome === 'tool_failure') {
    return failureCode === 'unsupported_model' || failureCode === 'non_zero_exit';
  }
  if (outcome === 'invalid') {
    return [
      'evaluator_failure',
      'workspace_unavailable',
      'missing_evaluator',
      'spawn',
      'authentication',
      'subscription_limit',
      'capability_validation_failed',
      'workspace_integrity',
    ].includes(failureCode);
  }
  return failureCode === resultFailureCodeForOutcome(outcome);
}

export function hasValidResultTaskScore(outcome: CalibrationOutcome, taskScore: unknown): boolean {
  if (outcome === 'correct') return taskScore === 1;
  if (outcome === 'partial') {
    return isFiniteNumber(taskScore) && taskScore > 0 && taskScore < 1;
  }
  if (outcome === 'incorrect') return taskScore === 0;
  return taskScore === null;
}

export function hasValidResultExplanation(
  outcome: CalibrationOutcome,
  failureCode: unknown,
  explanationCode: unknown,
  explanationSummary: unknown,
): boolean {
  const expectedSummary = resultExplanationSummaryForOutcome(outcome);
  if (expectedSummary === null) {
    return failureCode === null && explanationCode === null && explanationSummary === null;
  }
  return (
    hasValidResultFailureCode(outcome, failureCode) &&
    explanationCode === failureCode &&
    isSafeExplanationSummary(explanationSummary) &&
    explanationSummary === expectedSummary
  );
}

export function isResultOutcome(value: unknown): value is CalibrationOutcome {
  return CALIBRATION_OUTCOMES.some((outcome) => outcome === value);
}

export function isExecutionStatus(value: unknown): value is ExecutionStatus {
  return (
    value === 'completed' ||
    value === 'runtime_issue' ||
    value === 'invalid' ||
    value === 'missing' ||
    value === 'not_applicable'
  );
}
