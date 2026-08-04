export interface ScientificScoreContext {
  sampleSize: number;
  coverage: string;
  runtime: string;
  missing: string;
  status: string;
  scoringVersion: string;
  provenance: string;
}

export function formatScientificScoreContextHtml(context: ScientificScoreContext): string {
  return `score n=${context.sampleSize} · coverage ${context.coverage}<br/>runtime ${context.runtime} · missing ${context.missing}<br/>status ${context.status} · scoring ${context.scoringVersion} · ${context.provenance}`;
}
