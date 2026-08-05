import { createServer } from 'node:http';

const port = Number.parseInt(process.argv[2] ?? '', 10);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error('Supply one valid mock Supabase port.');
}

const matrix = [
  {
    family: 'sol',
    model: 'gpt-5.6-sol',
    tiers: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  },
  {
    family: 'terra',
    model: 'gpt-5.6-terra',
    tiers: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  },
  {
    family: 'luna',
    model: 'gpt-5.6-luna',
    tiers: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
].flatMap(({ family, model, tiers }) =>
  tiers.map((tier) => ({
    id: `${family}-${tier}`,
    model_family: `${family[0]?.toUpperCase()}${family.slice(1)}`,
    model_name: model,
    reasoning_tier: tier,
  })),
);

const scoringVersion = {
  benchmark_version: 'aiq-core@1.0.3',
  scoring_version: '1.0.3',
  published_at: '2026-07-30T12:00:00Z',
  principles: [
    'Give each of the ten domains weight 0.1.',
    'Keep the frozen domain and difficulty quotas.',
    'Keep missing and invalid tasks in completion accounting and block Official publication.',
    'Treat attributable agent, model, tool, timeout, budget, and wrong-artifact failures as valid zero scores.',
    'Treat benchmark infrastructure failures as invalid and audit a rerun.',
  ],
  missing_policy:
    'Missing and invalid tasks block Official. Provisional output uses observed domain means and fixed-fixture completion bounds.',
  failure_policy:
    'Attributable failures are valid zero scores. Infrastructure failures are invalid and require an audited rerun.',
  sensitivity_policy:
    'The task-resampling interval uses finite_cluster_calibrated_percentile_sensitivity_v1 with a versioned 1.3 deviation correction calibrated for this fixed benchmark fixture. It is a fixed-fixture calibrated sensitivity interval, not a universal confidence interval for model capability.',
  synthetic: false,
};

const taskCoverage = [
  ['coding', 8],
  ['debugging', 8],
  ['repository_understanding', 7],
  ['data_processing', 8],
  ['retrieval_verification', 7],
  ['documentation_communication', 7],
  ['planning_execution', 7],
  ['tool_use', 7],
  ['instruction_following', 6],
  ['reliability_recovery', 7],
].map(([domain, task_count]) => ({
  scoring_version: '1.0.3',
  domain,
  weight: 0.1,
  task_count,
}));

const server = createServer((request, response) => {
  response.setHeader('content-type', 'application/json');
  if (request.url === '/health') {
    response.end('{"status":"ok"}');
    return;
  }
  if (request.url?.startsWith('/rest/v1/public_model_matrix?')) {
    response.end(JSON.stringify(matrix));
    return;
  }
  if (request.url?.startsWith('/rest/v1/public_scoring_versions?')) {
    response.end(JSON.stringify(scoringVersion));
    return;
  }
  if (request.url?.startsWith('/rest/v1/public_task_coverage?')) {
    response.end(JSON.stringify(taskCoverage));
    return;
  }
  if (request.url?.startsWith('/rest/v1/')) {
    response.end('[]');
    return;
  }
  response.statusCode = 404;
  response.end('{"message":"not found"}');
});

server.listen(port, '127.0.0.1');
