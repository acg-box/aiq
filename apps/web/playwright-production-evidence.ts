export interface ProductionEfficiencyEvidence {
  readonly resultCount: number;
  readonly attemptedCount: number;
  readonly invokedCount: number;
  readonly elapsedObservedCount: number;
  readonly durationEvidenceLevel: string | null;
  readonly tokenObservedCount: number;
  readonly tokenEvidenceLevel: string | null;
  readonly tokenCategories: readonly {
    readonly valueAvailable: boolean;
    readonly coverageCount: number | null;
    readonly coveragePercent: number | null;
  }[];
  readonly pricedCount: number;
  readonly costStatus: string;
  readonly costUsd: number | null;
  readonly costEvidenceLevel: string | null;
}

export interface ProductionTaskCostEvidence {
  readonly costStatus: string;
  readonly costUsdNanos: number | null;
  readonly tokenEvidenceLevel: string | null;
  readonly costEvidenceLevel: string | null;
}

export interface ProductionEvidenceNote {
  readonly label: string;
  readonly state: string;
}

export interface ProductionPageEvidenceExpectation {
  readonly requiredPublishedLabels: readonly string[];
  readonly allowedEmptyLabels: readonly string[];
}

function require(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid production efficiency evidence: ${message}`);
}

function isBoundedCount(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function requirePageEvidence(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid production page evidence: ${message}`);
}

export function productionPageEvidenceExpectation(path: string): ProductionPageEvidenceExpectation {
  const pathname = new URL(path, 'https://aiq.invalid').pathname;
  if (pathname === '/') {
    return {
      requiredPublishedLabels: ['Data provenance', 'Official efficiency provenance'],
      allowedEmptyLabels: ['Latest calibration status', 'Calibration score matrix status'],
    };
  }
  if (pathname === '/trends') {
    return {
      requiredPublishedLabels: [
        'Matrix entries provenance',
        'Trend points provenance',
        'Historical efficiency provenance',
      ],
      allowedEmptyLabels: [],
    };
  }
  if (pathname === '/calibrations') {
    return {
      requiredPublishedLabels: [],
      allowedEmptyLabels: ['Calibration register status', 'Selected-run score matrix status'],
    };
  }
  if (/^\/runs\/[^/]+$/.test(pathname)) {
    return {
      requiredPublishedLabels: ['Data provenance', 'Official run efficiency provenance'],
      allowedEmptyLabels: [],
    };
  }
  return { requiredPublishedLabels: ['Data provenance'], allowedEmptyLabels: [] };
}

export function validateProductionPageEvidence(
  notes: readonly ProductionEvidenceNote[],
  expectation: ProductionPageEvidenceExpectation,
): void {
  const allowedEmptyLabels = new Set(expectation.allowedEmptyLabels);
  const statesByLabel = new Map<string, string[]>();

  for (const note of notes) {
    requirePageEvidence(note.label.length > 0, 'evidence note without an accessible label');
    const states = statesByLabel.get(note.label) ?? [];
    states.push(note.state);
    statesByLabel.set(note.label, states);

    if (note.state === 'No published evidence') {
      requirePageEvidence(allowedEmptyLabels.has(note.label), `${note.label} must not be empty`);
      continue;
    }
    requirePageEvidence(note.state === 'Published evidence', `${note.label} is ${note.state}`);
  }

  for (const label of expectation.requiredPublishedLabels) {
    const states = statesByLabel.get(label) ?? [];
    requirePageEvidence(
      states.length === 1 && states[0] === 'Published evidence',
      `${label} must contain exactly one Published evidence note`,
    );
  }
}

export function validateProductionEfficiencyEvidence(evidence: ProductionEfficiencyEvidence): void {
  require(evidence.resultCount === 72, 'result count');
  require(isBoundedCount(evidence.attemptedCount, evidence.resultCount), 'attempted count');
  require(isBoundedCount(evidence.invokedCount, evidence.attemptedCount), 'invoked count');
  require(isBoundedCount(
    evidence.elapsedObservedCount,
    evidence.invokedCount,
  ), 'elapsed-observed count');
  require((evidence.elapsedObservedCount === 0 && evidence.durationEvidenceLevel === null) ||
    (evidence.elapsedObservedCount > 0 &&
      evidence.durationEvidenceLevel === 'runner-observed'), 'duration evidence');
  require(isBoundedCount(evidence.tokenObservedCount, evidence.invokedCount), 'token count');
  require((evidence.tokenObservedCount === 0 && evidence.tokenEvidenceLevel === null) ||
    (evidence.tokenObservedCount > 0 &&
      evidence.tokenEvidenceLevel === 'verifier-recomputed'), 'token evidence');
  require(evidence.tokenCategories.length === 6, 'token categories');

  for (const category of evidence.tokenCategories) {
    const coverageUnavailable =
      category.coverageCount === null && category.coveragePercent === null;
    require(coverageUnavailable ||
      (category.coverageCount !== null &&
        category.coveragePercent !== null &&
        category.coverageCount > 0 &&
        category.coverageCount <= evidence.tokenObservedCount &&
        category.coveragePercent ===
          Number(
            ((100 * category.coverageCount) / evidence.resultCount).toFixed(1),
          )), 'token category coverage');
    require(category.valueAvailable === !coverageUnavailable, 'token value and coverage');
  }

  require(isBoundedCount(evidence.pricedCount, evidence.tokenObservedCount), 'priced count');
  if (evidence.costStatus === 'estimated') {
    require(evidence.costUsd !== null && evidence.costUsd > 0, 'estimated cost');
    require(evidence.costEvidenceLevel === 'verifier-recomputed', 'cost evidence');
    require(evidence.pricedCount === evidence.resultCount, 'estimated cost coverage');
    require(evidence.tokenObservedCount === evidence.resultCount, 'estimated token coverage');
    require(evidence.tokenCategories
      .slice(0, 4)
      .every(
        (category) =>
          category.coverageCount === evidence.resultCount && category.coveragePercent === 100,
      ), 'estimated pricing-input coverage');
  } else {
    require(evidence.costStatus.startsWith('unavailable-'), 'unavailable cost status');
    require(evidence.costUsd === null, 'unavailable cost value');
    require(evidence.costEvidenceLevel === null, 'unavailable cost evidence');
  }
}

export function validateProductionTaskCostEvidence(evidence: ProductionTaskCostEvidence): void {
  if (evidence.costStatus === 'estimated') {
    require(evidence.costUsdNanos !== null &&
      Number.isSafeInteger(evidence.costUsdNanos) &&
      evidence.costUsdNanos >= 0, 'task estimated cost');
    require(evidence.tokenEvidenceLevel === 'verifier-recomputed', 'task token evidence');
    require(evidence.costEvidenceLevel === 'verifier-recomputed', 'task cost evidence');
    return;
  }

  require(evidence.costStatus.startsWith('unavailable-'), 'task unavailable cost status');
  require(evidence.costUsdNanos === null, 'task unavailable cost value');
  require(evidence.costEvidenceLevel === null, 'task unavailable cost evidence');
  if (evidence.costStatus === 'unavailable-context-band') {
    require(evidence.tokenEvidenceLevel === 'verifier-recomputed', 'task context-band evidence');
  }
  if (evidence.costStatus === 'unavailable-missing-usage') {
    require(evidence.tokenEvidenceLevel === null, 'task missing-usage evidence');
  }
}
