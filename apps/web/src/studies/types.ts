/** Shared display records. Each study owns its metrics and interpretation. */
export interface EvidenceFile {
  id: string;
  bundle: string;
  path: string;
  sha256: string;
  bytes: number;
  href: string;
  sourceUrl: string | null;
}

export interface Subject {
  id: string;
  label: string;
  configuration: Record<string, string>;
}

export interface StudyRun {
  id: string;
  subjectId: string;
  date: string;
  sampleSize: number;
  scope: string;
  evidenceIds: string[];
}

export type MetricValue = number | string | { pass: number; total: number } | null;

export interface StudyResult {
  runId: string;
  values: Record<string, MetricValue>;
}

export interface ComparisonGroup {
  id: string;
  title: string;
  description: string;
  costScope: string;
  metrics: {
    key: string;
    label: string;
    unit: 'ratio' | 'usd' | 'seconds' | 'count' | 'text';
    precision?: number;
    unavailableReason?: string;
  }[];
  chartMetric: string;
  runs: StudyRun[];
  results: StudyResult[];
}

export interface CaseObservation {
  subject: string;
  semanticComplete: boolean | null;
  quotesBound: boolean | null;
  answer: string | null;
  review: string;
  context: { handle: string; text: string }[];
  citations: { handle: string; quote: string }[];
  evidenceIds: string[];
}

export interface StudyCase {
  id: string;
  title: string;
  kind: 'reader' | 'writer';
  question: string;
  explanation: string;
  observations: CaseObservation[];
  evidenceIds: string[];
}

export interface Study {
  id: string;
  category: 'models' | 'memory-systems';
  title: string;
  summary: string;
  date: string;
  sample: string;
  finding: string;
  conditions: string[];
  limitations: string[];
  subjects: Subject[];
  groups: ComparisonGroup[];
  cases: StudyCase[];
  evidenceBundles: string[];
  relatedEvidenceIds: string[];
}

export interface StudyCatalogue {
  schema: 'aiq.studies.v1';
  sourceCommit: string;
  evidence: EvidenceFile[];
  studies: Study[];
}
