import { alphabetical } from '../display-order.ts';

export type BenchmarkBoard = {
  id: string;
  code: string;
  symbol: string;
  title: string;
  summary: string;
  comparisonConditions: string;
  description: string;
  studyIds: readonly string[];
  benchmark?: 'core' | 'harness';
};

export const benchmarkBoards: readonly BenchmarkBoard[] = alphabetical<BenchmarkBoard>(
  [
    {
      id: 'intelligence',
      code: 'AIQ',
      symbol: 'AI',
      title: 'AI Intelligence',
      summary: 'Model × reasoning effort',
      comparisonConditions: 'Same task set and scoring within each benchmark version.',
      description:
        'Compare model configurations on defined tasks. Each benchmark keeps its own scoring method, versions, and publication requirements.',
      studyIds: [],
      benchmark: 'core',
    },
    {
      id: 'memory',
      code: 'MEM',
      symbol: 'M',
      title: 'Mem',
      summary: 'Memory systems, readers and writers',
      comparisonConditions:
        'Compare profiles within each retained test; workloads keep separate measures.',
      description:
        'Compare native memory systems, readers, and writers. Inspect answer quality, source binding, time, and cost under each test’s recorded conditions.',
      studyIds: ['native-memory', 'luna-deepseek', 'luna-effort'],
    },
    {
      id: 'harness',
      code: 'HR',
      symbol: 'H',
      title: 'Harness Rank',
      summary: 'Model × harness',
      comparisonConditions: 'Plan: matched model, tasks and budget for Codex, Hermes and Pi.',
      description:
        'Study Codex, Hermes, and Pi with controlled model comparisons and complete model–harness combinations. The first protocol is design only, with no measured results.',
      studyIds: [],
      benchmark: 'harness',
    },
  ],
  (board) => board.title,
);

export function findBenchmarkBoard(id: string): BenchmarkBoard | undefined {
  return benchmarkBoards.find((board) => board.id === id);
}

export function boardForStudy(id: string): BenchmarkBoard | undefined {
  return benchmarkBoards.find((board) => board.studyIds.includes(id));
}

export function boardForPath(pathname: string): BenchmarkBoard | undefined {
  if (pathname.startsWith('/benchmarks/')) return findBenchmarkBoard(pathname.split('/')[2] ?? '');
  return undefined;
}
