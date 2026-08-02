import type { Metadata } from 'next';

import { ReadStateNote } from '../../components/read-state-note.tsx';
import { readPublicValue } from '../../data/read-state.ts';
import { createAiqRepository } from '../../data/repository.ts';

export const metadata: Metadata = { title: 'Method' };
export const dynamic = 'force-dynamic';

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
        <span className="eyebrow">Methodology</span>
        <h1>Transparent scoring, version by version.</h1>
        <p>
          AIQ v1 estimates outcomes on one committed 72-task fixture set. It does not estimate
          general intelligence or universal model capability.
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
              <div className="domain-bars">
                {result.data.domainWeights.map((domain) => (
                  <div key={domain.domain}>
                    <span>
                      <strong>{domain.domain}</strong>
                      <small>
                        {domain.taskCount} tasks · {(domain.weight * 100).toFixed(0)}%
                      </small>
                    </span>
                    <div aria-hidden="true">
                      <i style={{ width: `${domain.weight * 100}%` }} />
                    </div>
                  </div>
                ))}
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
            <article>
              <span className="eyebrow">04 · Sensitivity, not generalization</span>
              <h2>What the interval can and cannot say</h2>
              <p>{result.data.confidencePolicy}</p>
              <div className="formula">
                <span>Fixed-fixture or conditional AIQ</span>
                <strong>equal-weight mean of 10 frozen-fixture domain means</strong>
              </div>
            </article>
          </div>
        </>
      )}
    </section>
  );
}
