import catalogue from '../../../../benchmarks/candidates/aiq-core-1.1.0/catalog.json' with { type: 'json' };
import { AIQ_CORE_BENCHMARK_VERSION, AIQ_CORE_SCORING_VERSION } from '../aiq-core-contract.ts';

export const coreCatalogueSource =
  'https://github.com/acg-box/aiq/blob/e12a22c794d4610c6131199743fe2bc0c43ed7be/benchmarks/candidates/aiq-core-1.1.0/catalog.json';

export const benchmarkDomainConfig = Object.entries(catalogue.distribution.domains).map(
  ([domain, taskCount]) => ({ domain, taskCount }),
);

export const coreDefinition = {
  benchmarkVersion: AIQ_CORE_BENCHMARK_VERSION,
  scoringVersion: AIQ_CORE_SCORING_VERSION,
  domainWeights: benchmarkDomainConfig.map((domain) => ({
    domain: domain.domain,
    weight: 0.1,
    taskCount: domain.taskCount,
  })),
  principles: [
    'Estimate a one-dimensional latent ability on the committed AIQ Core fixed-fixture set. Do not claim general intelligence or a population IQ norm.',
    'For non-synthetic Official evidence, jointly estimate model locations and one Rasch task difficulty per task from the complete 17-configuration matrix with weak priors on a centered item scale. The published theta interval is conditional on that released item bank.',
    'Publish 100 × logistic(theta) as the calibrated average-task ability score. Keep the raw equal-domain fixed-fixture mean as a separate quality diagnostic.',
    'Strict pass rate is strict successes divided by every attributable task with a semantic task score. Partial scores are non-passes in the denominator; missing, infrastructure-invalid, and unscored tasks are excluded. Wilson bounds use the same denominator.',
    'Keep hidden fixture payloads behind the commitment boundary. Publish versions, counts, outcomes, and provenance.',
    'Do not fabricate or substitute work when a required capability is unavailable.',
  ],
  missingPolicy:
    'Missing and invalid results block Official and remain in completion accounting. A complete synthetic fixture is descriptive, never Official, and not ranked. A Provisional point estimate averages valid observed tasks within each domain; fixed-fixture completion bounds retain every planned task and assign unobserved tasks zero or one. Provisional requires at least 60 results and at least 4 in every domain, and is not ranked.',
  failurePolicy:
    'Only completed semantic correct, partial, and incorrect outcomes contribute a task score. Runtime failures have no semantic score and remain visible as runtime issues. Invalid infrastructure attempts are audited and rerun. A whole configuration can be N/A only when preflight proves it unavailable.',
  sensitivityPolicy:
    'The canonical fixed-fixture sensitivity interval draws committed clusters with replacement inside each domain, includes all task scores in each drawn cluster, and recomputes the raw equal-domain diagnostic. It expands each raw 95-percentile deviation from the observed fixture score by the versioned 1.3 correction and clamps the endpoints to 0 through 100. It is not a universal confidence interval for model capability. Latent standard error is conditional on the frozen calibration bank.',
};
