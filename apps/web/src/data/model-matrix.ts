import type {
  CalibrationModelFamily,
  CalibrationModelSelection,
  ModelFamily,
  ReasoningTier,
} from './types.ts';

export interface ModelMatrixRow {
  id: string;
  model_family: ModelFamily;
  model_name: string;
  reasoning_tier: ReasoningTier;
}

export const CANONICAL_MODEL_MATRIX = [
  ['sol-low', 'Sol', 'gpt-5.6-sol', 'low'],
  ['sol-medium', 'Sol', 'gpt-5.6-sol', 'medium'],
  ['sol-high', 'Sol', 'gpt-5.6-sol', 'high'],
  ['sol-xhigh', 'Sol', 'gpt-5.6-sol', 'xhigh'],
  ['sol-max', 'Sol', 'gpt-5.6-sol', 'max'],
  ['sol-ultra', 'Sol', 'gpt-5.6-sol', 'ultra'],
  ['terra-low', 'Terra', 'gpt-5.6-terra', 'low'],
  ['terra-medium', 'Terra', 'gpt-5.6-terra', 'medium'],
  ['terra-high', 'Terra', 'gpt-5.6-terra', 'high'],
  ['terra-xhigh', 'Terra', 'gpt-5.6-terra', 'xhigh'],
  ['terra-max', 'Terra', 'gpt-5.6-terra', 'max'],
  ['terra-ultra', 'Terra', 'gpt-5.6-terra', 'ultra'],
  ['luna-low', 'Luna', 'gpt-5.6-luna', 'low'],
  ['luna-medium', 'Luna', 'gpt-5.6-luna', 'medium'],
  ['luna-high', 'Luna', 'gpt-5.6-luna', 'high'],
  ['luna-xhigh', 'Luna', 'gpt-5.6-luna', 'xhigh'],
  ['luna-max', 'Luna', 'gpt-5.6-luna', 'max'],
] as const satisfies ReadonlyArray<readonly [string, ModelFamily, string, ReasoningTier]>;

export const CANONICAL_MODEL_MATRIX_IDS = CANONICAL_MODEL_MATRIX.map(([id]) => id);

function calibrationFamilyForModelFamily(modelFamily: ModelFamily): CalibrationModelFamily {
  if (modelFamily === 'Sol') return 'sol';
  if (modelFamily === 'Terra') return 'terra';
  return 'luna';
}

export const CALIBRATION_MODEL_CONFIGURATIONS: readonly CalibrationModelSelection[] =
  CANONICAL_MODEL_MATRIX.map(([, modelFamily, , reasoningEffort]) => ({
    modelFamily: calibrationFamilyForModelFamily(modelFamily),
    reasoningEffort,
  }));

export function calibrationConfigurationKey(selection: CalibrationModelSelection): string {
  return `${selection.modelFamily}:${selection.reasoningEffort}`;
}

export const CALIBRATION_CONFIGURATION_KEYS = new Set(
  CALIBRATION_MODEL_CONFIGURATIONS.map(calibrationConfigurationKey),
);

export const CALIBRATION_CONFIGURATION_INDEX = new Map(
  CALIBRATION_MODEL_CONFIGURATIONS.map((selection, index) => [
    calibrationConfigurationKey(selection),
    index,
  ]),
);

export function parseCalibrationConfiguration(value: unknown): CalibrationModelSelection | null {
  if (typeof value !== 'string') return null;
  return (
    CALIBRATION_MODEL_CONFIGURATIONS.find(
      (selection) => calibrationConfigurationKey(selection) === value,
    ) ?? null
  );
}

export const CANONICAL_MODEL_MATRIX_BY_ID = new Map<
  string,
  {
    index: number;
    modelFamily: ModelFamily;
    modelName: string;
    reasoningTier: ReasoningTier;
  }
>(
  CANONICAL_MODEL_MATRIX.map(([id, modelFamily, modelName, reasoningTier], index) => [
    id,
    { index, modelFamily, modelName, reasoningTier },
  ]),
);
