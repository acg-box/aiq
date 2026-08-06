import type { Metadata } from 'next';

import { AIQ_CORE_TASK_SCORING_CONTRACT } from '../../aiq-core-contract.ts';
import { ReadStateNote } from '../../components/read-state-note.tsx';
import { readPublicValue } from '../../data/read-state.ts';
import { createAiqRepository } from '../../data/repository.ts';
import { createPageMetadata } from '../site-metadata.ts';

export const metadata: Metadata = createPageMetadata({
  title: 'Method',
  path: '/method',
  description:
    'Read the AIQ fixed-fixture benchmark, scoring, task-mix sensitivity, and provenance method.',
});
export const dynamic = 'force-dynamic';

function EfficiencyMethod() {
  return (
    <article>
      <span className="eyebrow">06 · Calibration efficiency estimates</span>
      <h2>Observed Codex adapter elapsed time and estimated token cost stay distinct</h2>
      <p>
        Time is observed Codex adapter elapsed time. Cost is a versioned estimate from covered token
        aggregate usage and the{' '}
        <a href="https://developers.openai.com/api/docs/pricing">
          official OpenAI API pricing documentation
        </a>
        , accessed 2026-08-02. It is not actual Codex subscription billing or necessarily an exact
        API invoice.
      </p>
      <dl className="policy-list">
        <div>
          <dt>Source / as of / estimator version</dt>
          <dd>
            Official OpenAI API pricing · USD · standard processing tier · 2026-08-02 ·
            aiq.standard-api-equivalent-usd.v1
          </dd>
        </div>
        <div>
          <dt>Formula</dt>
          <dd>
            Uncached input = total input − cache-read input − cache-write input. Multiply uncached
            input, cache-read input, cache-write input, and output by their versioned standard
            per-token rates, then sum them. Reasoning tokens are nested within output and are not
            added twice.
          </dd>
        </div>
        <div>
          <dt>Coverage</dt>
          <dd>
            Raw token counters are provider-reported. The verifier recomputes aggregates and the
            cost estimate from those counters. USD displays only when estimator status is estimated
            and token coverage is complete. Missing, invalid, or JCS-overflowed aggregate usage
            displays as unavailable, never zero.{' '}
            <a href="https://developers.openai.com/api/docs/pricing">
              Prompts above 272,000 input tokens use 2× input and 1.5× output rates
            </a>
            . AIQ cannot identify each request context band from aggregate usage, so a result above
            272,000 aggregate input tokens uses the unavailable context band status and is not
            priced.
          </dd>
        </div>
        <div>
          <dt>Observed Codex adapter elapsed time</dt>
          <dd>
            Sum, median, and p95 of Codex adapter elapsed time: model plus allowed tools. It
            excludes workspace setup, artifact sealing, and evaluator replay. Runtime-issue tasks
            consume time; missing or non-invoked cells do not. Full-matrix timings are operational
            resource-profile evidence under the recorded node, execution order, and concurrency (17
            jobs for the current run). Model, tool, network, and local contention vary. This is not
            pure task latency or an isolated API-frontier latency test. Cell durations can overlap
            under concurrency. Signed matrix-stage start and finish times provide the full batch
            wall-clock, which is counted once across the 17 configurations. TTFT and TPS are
            unavailable and are not inferred.
          </dd>
        </div>
        <div>
          <dt>Interpretation</dt>
          <dd>
            AIQ, observed adapter elapsed time, and estimated API-equivalent USD remain separate.
            Scatter and Pareto context do not create a combined ranking.
          </dd>
        </div>
      </dl>
    </article>
  );
}

function TaskScoreMethod() {
  return (
    <article>
      <span className="eyebrow">04 · Task-level score</span>
      <h2>Committed weighted checks with explicit hard gates</h2>
      <p>
        Each task uses at most {AIQ_CORE_TASK_SCORING_CONTRACT.maximum_checks_per_result} binary
        checks from a content-addressed private evaluator configuration. Check names and weights
        remain hidden with the task payload, but their exact identities are committed and the
        verifier replays them.
      </p>
      <div className="formula">
        <span>Valid evaluator result</span>
        <strong>hard gate or structural failure ? 0 : Σ(weight × passed) ÷ Σ(weight)</strong>
      </div>
      <dl className="policy-list">
        <div>
          <dt>Partial credit</dt>
          <dd>
            A passing check contributes its committed nonnegative integer weight. A valid positive
            denominator is required. The evaluator does not round before exact replay.
          </dd>
        </div>
        <div>
          <dt>Hard gates</dt>
          <dd>
            An explicit hard gate or workspace-policy check can force zero. A positive-weight hard
            gate also participates in the weighted fraction when every gate passes. Only a hard gate
            may have zero weight.
          </dd>
        </div>
        <div>
          <dt>Outcome labels</dt>
          <dd>1 is Correct; a score between 0 and 1 is Partial; 0 is Incorrect.</dd>
        </div>
        <div>
          <dt>Execution evidence</dt>
          <dd>
            Attributable runtime failures score zero with an explicit runtime status. Evaluator or
            infrastructure-invalid evidence stays unscored and blocks Official publication; it is
            never converted into semantic Incorrect.
          </dd>
        </div>
      </dl>
    </article>
  );
}

export default async function MethodPage() {
  const repository = createAiqRepository();
  const result = await readPublicValue(
    repository,
    () => repository.getMethodology(),
    (value) => [value.synthetic],
  );
  return (
    <section className="page-shell inner-page">
      <div className="page-intro">
        <span className="eyebrow">Method</span>
        <h1>How AIQ is scored</h1>
        <p>
          AIQ measures outcomes on one committed set of 72 practical tasks. It is a transparent
          benchmark score, not a claim about general intelligence.
        </p>
      </div>
      <ReadStateNote result={result} />
      {result.state === 'unavailable' ? null : (
        <>
          <div className="version-banner">
            <div>
              <span>Benchmark</span>
              <strong>{result.data.benchmarkVersion}</strong>
            </div>
            <div>
              <span>Scoring</span>
              <strong>{result.data.scoringVersion}</strong>
            </div>
            <div>
              <span>Published</span>
              <strong>{new Date(result.data.publishedAt).toLocaleDateString()}</strong>
            </div>
          </div>
          <div className="method-layout">
            <article>
              <span className="eyebrow">01 · Fixed-fixture estimand</span>
              <h2>Observable outcomes on the committed set</h2>
              <ol className="principle-list">
                {result.data.principles.map((principle) => (
                  <li key={principle}>{principle}</li>
                ))}
              </ol>
            </article>
            <article>
              <span className="eyebrow">02 · Domain coverage</span>
              <h2>72 tasks · 10 equally weighted domains</h2>
              <div className="table-scroll domain-weight-table" tabIndex={0}>
                <table>
                  <caption>
                    Exact fixed-fixture domain task counts and macro-average weights.
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Domain</th>
                      <th scope="col">Tasks</th>
                      <th scope="col">Weight</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.data.domainWeights.map((domain) => (
                      <tr key={domain.domain}>
                        <th scope="row">{domain.domain}</th>
                        <td>{domain.taskCount}</td>
                        <td>{(domain.weight * 100).toFixed(0)}%</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th scope="row">Total</th>
                      <td>
                        {result.data.domainWeights.reduce(
                          (total, domain) => total + domain.taskCount,
                          0,
                        )}
                      </td>
                      <td>
                        {(
                          result.data.domainWeights.reduce(
                            (total, domain) => total + domain.weight,
                            0,
                          ) * 100
                        ).toFixed(0)}
                        %
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </article>
            <article>
              <span className="eyebrow">03 · Completeness and validity</span>
              <h2>Official, complete synthetic, provisional, or coverage-only</h2>
              <dl className="policy-list">
                <div>
                  <dt>Attempted failure</dt>
                  <dd>{result.data.failurePolicy}</dd>
                </div>
                <div>
                  <dt>Missing fixture or result</dt>
                  <dd>{result.data.missingPolicy}</dd>
                </div>
                <div>
                  <dt>Hidden fixture boundary</dt>
                  <dd>
                    Hidden payloads stay sealed behind the published fixture-set commitment.
                    Version, task counts, outcome states, and provenance remain public.
                  </dd>
                </div>
              </dl>
            </article>
            <TaskScoreMethod />
            <article>
              <span className="eyebrow">05 · Sensitivity, not generalization</span>
              <h2>What the interval can and cannot say</h2>
              <p>{result.data.sensitivityPolicy}</p>
              <div className="formula">
                <span>Fixed-fixture or conditional AIQ</span>
                <strong>equal-weight mean of 10 frozen-fixture domain means</strong>
              </div>
            </article>
            <EfficiencyMethod />
          </div>
        </>
      )}
      {result.state === 'unavailable' ? (
        <div className="method-layout">
          <EfficiencyMethod />
        </div>
      ) : null}
    </section>
  );
}
