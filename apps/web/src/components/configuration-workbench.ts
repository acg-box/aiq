import type { ModelFamily, ReasoningTier } from '../data/types.ts';
import {
  configurationFrontierKeys,
  orderConfigurationDecisions,
  summarizeConfigurationDecisions,
} from './configuration-decision.ts';
import type { ExactEfficiencyRow } from './scientific-evidence-resolution.ts';
import { resolveConfigurationCost } from './configuration-cost.ts';

export const CONFIGURATION_FAMILIES = ['Sol', 'Terra', 'Luna'] as const;
export const CONFIGURATION_REASONING_TIERS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const;

export type ConfigurationWorkbenchView = 'duration' | 'cost' | 'decision';
export type ConfigurationWorkbenchOrder = 'ability' | 'time' | 'cost' | 'family';

export interface ConfigurationWorkbenchState {
  families: readonly ModelFamily[];
  reasoningTiers: readonly ReasoningTier[];
  configurationIds: readonly string[];
  costOnly: boolean;
  frontierOnly: boolean;
  view: ConfigurationWorkbenchView;
  order: ConfigurationWorkbenchOrder;
  focusId: string | null;
}

function readSelection<const Value extends string>(
  params: URLSearchParams,
  key: string,
  allowed: readonly Value[],
): readonly Value[] {
  const value = params.get(key);
  if (value === null) return allowed;
  if (value === 'none') return [];
  const selected = new Set(value.split(','));
  const recognized = allowed.filter((candidate) => selected.has(candidate));
  return recognized.length === 0 ? allowed : recognized;
}

function readEnum<const Value extends string>(
  params: URLSearchParams,
  key: string,
  allowed: readonly Value[],
  fallback: Value,
): Value {
  const value = params.get(key);
  return allowed.find((candidate) => candidate === value) ?? fallback;
}

export function encodeWorkbenchSelection(
  selected: readonly string[],
  allowed: readonly string[],
): string | null {
  const selectedSet = new Set(selected);
  const ordered = allowed.filter((candidate) => selectedSet.has(candidate));
  if (ordered.length === allowed.length) return null;
  return ordered.length === 0 ? 'none' : ordered.join(',');
}

export function readConfigurationWorkbenchState(
  params: URLSearchParams,
  rows: readonly ExactEfficiencyRow[],
): ConfigurationWorkbenchState {
  const configurationIds = rows.map(({ entry }) => entry.id);
  const focusCandidate = params.get('compareFocus');
  return {
    families: readSelection(params, 'compareFamilies', CONFIGURATION_FAMILIES),
    reasoningTiers: readSelection(params, 'compareReasoning', CONFIGURATION_REASONING_TIERS),
    configurationIds: readSelection(params, 'compareConfigs', configurationIds),
    costOnly: params.get('compareCost') === 'estimated',
    frontierOnly: params.get('compareFrontier') === 'only',
    view: readEnum(params, 'compareView', ['duration', 'cost', 'decision'] as const, 'duration'),
    order: readEnum(
      params,
      'compareOrder',
      ['ability', 'time', 'cost', 'family'] as const,
      'ability',
    ),
    focusId:
      focusCandidate !== null && configurationIds.includes(focusCandidate) ? focusCandidate : null,
  };
}

export function filterConfigurationWorkbenchRows(
  rows: readonly ExactEfficiencyRow[],
  state: ConfigurationWorkbenchState,
): readonly ExactEfficiencyRow[] {
  const families = new Set(state.families);
  const tiers = new Set(state.reasoningTiers);
  const configurations = new Set(state.configurationIds);
  const frontier = configurationFrontierKeys(rows);
  return rows.filter(
    ({ entry, row }) =>
      families.has(entry.modelFamily) &&
      tiers.has(entry.reasoningTier) &&
      configurations.has(entry.id) &&
      (!state.costOnly ||
        (row.costEstimatorStatus === 'estimated' && row.standardApiEquivalentUsdNanos !== null)) &&
      (!state.frontierOnly || frontier.has(entry.id)),
  );
}

export function orderConfigurationWorkbenchRows(
  rows: readonly ExactEfficiencyRow[],
  order: ConfigurationWorkbenchOrder,
): readonly ExactEfficiencyRow[] {
  if (order !== 'family') return orderConfigurationDecisions(rows, order);
  return rows.toSorted(
    (left, right) =>
      CONFIGURATION_FAMILIES.indexOf(left.entry.modelFamily) -
        CONFIGURATION_FAMILIES.indexOf(right.entry.modelFamily) ||
      CONFIGURATION_REASONING_TIERS.indexOf(left.entry.reasoningTier) -
        CONFIGURATION_REASONING_TIERS.indexOf(right.entry.reasoningTier) ||
      left.entry.id.localeCompare(right.entry.id),
  );
}

export function summarizeConfigurationWorkbench(
  rows: readonly ExactEfficiencyRow[],
  visibleRows: readonly ExactEfficiencyRow[],
) {
  const visibleSummary = summarizeConfigurationDecisions(visibleRows);
  const allFrontier = configurationFrontierKeys(rows);
  const visibleFrontierCount = visibleRows.filter(({ entry }) => allFrontier.has(entry.id)).length;
  const costMeasuredCount = visibleRows.filter(
    ({ row }) =>
      row.costEstimatorStatus === 'estimated' && row.standardApiEquivalentUsdNanos !== null,
  ).length;
  const costBoundedCount = visibleRows.filter(
    ({ row }) => resolveConfigurationCost(row).kind === 'bounded',
  ).length;
  const costComparableCount = visibleRows.filter(
    ({ row }) => resolveConfigurationCost(row).kind !== 'unavailable',
  ).length;
  return {
    ...visibleSummary,
    visibleFrontierCount,
    costMeasuredCount,
    costBoundedCount,
    costComparableCount,
    visibleCount: visibleRows.length,
    totalCount: rows.length,
  };
}
