import plan from '../../../../benchmarks/harness-rank/protocol.json' with { type: 'json' };
import { alphabetical } from '../display-order.ts';

export const harnessPlan = {
  ...plan,
  harnesses: alphabetical(plan.harnesses, (item) => item.name),
  comparisons: alphabetical(plan.comparisons, (item) => item.name),
  workloads: alphabetical(plan.workloads, (item) => item.name),
  tasks: alphabetical(plan.tasks, (item) => item.name),
};

export type HarnessTask = (typeof plan.tasks)[number];

export const harnessProtocolHref = '/api/benchmarks/harness/protocol';

const artifactNames: Record<string, string> = {
  'accounting.json': 'Cost and usage',
  'answer.md': 'Final answer',
  'attempt.json': 'Run record',
  'config.json': 'Harness configuration',
  'grade.json': 'Acceptance results',
  'manifest.json': 'File checksums',
  'originals/': 'Original session',
  'repository.diff': 'Code changes',
  'task.json': 'Task definition',
  'transport.jsonl': 'Model requests',
};

export const harnessEvidenceFiles = alphabetical(
  plan.artifacts.map((artifact) => ({
    path: artifact.path,
    purpose: artifact.purpose,
    name: artifactNames[artifact.path] ?? artifact.path,
  })),
  (artifact) => artifact.name,
);
