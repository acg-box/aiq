import { AIQ_CORE_TASK_SCORING_CONTRACT } from '../aiq-core-contract.ts';
import { AIQ_CORE_TASK_SCORER_VERSION } from '../aiq-core-contract.ts';
import { coreCatalogueSource, coreDefinition } from '../data/core-definition.ts';
import { ReferenceDisclosure } from '../components/reference-disclosure.tsx';
import { ReferenceViewLinks } from '../components/reference-view-links.tsx';
import { alphabetical } from '../display-order.ts';
import { TableColumnHeading } from '../components/table-column-heading.tsx';
import { ReferenceHeader, ReferenceNavigation } from '../components/reference-layout.tsx';

function EfficiencyMethod() {
  return (
    <ReferenceDisclosure
      id="core-efficiency"
      title="Time and cost"
      description="Observed adapter time and estimated API-equivalent USD"
    >
      <h4>Observed Codex adapter elapsed time and estimated token cost stay distinct</h4>
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
            exact cost estimate from those counters when token coverage is complete.{' '}
            <a href="https://developers.openai.com/api/docs/pricing">
              Prompts above 272,000 input tokens use 2× input and 1.5× output rates
            </a>
            . Aggregate counters cannot identify which requests crossed that threshold, so AIQ
            displays a published-rate range: all-standard rates as the lower bound and the full
            long-context uplift as the upper bound. The range is not an exact invoice. Missing,
            invalid, or JCS-overflowed aggregate usage remains unavailable, never zero.
          </dd>
        </div>
        <div>
          <dt>Observed Codex adapter elapsed time</dt>
          <dd>
            Sum, median, and p95 of Codex adapter elapsed time: model plus allowed tools. It
            excludes workspace setup, artifact sealing, and evaluator replay. Runtime-issue tasks
            consume time; missing or non-invoked cells do not. Full-matrix timings are operational
            resource-profile evidence under the recorded node, execution order, and concurrency
            shown with each run. Model, tool, network, and local contention vary. This is not pure
            task latency or an isolated API-frontier latency test. Cell durations can overlap under
            concurrency. Signed matrix-stage start and finish times provide the full batch
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
    </ReferenceDisclosure>
  );
}

function TaskScoreMethod() {
  return (
    <ReferenceDisclosure
      id="core-task-score"
      title="Task-level score"
      description="Weighted checks, partial credit, hard gates, and runtime failures"
    >
      <h4>Committed weighted checks with explicit hard gates</h4>
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
            Runtime failures carry no semantic score and remain visible with an explicit runtime
            status. Evaluator or infrastructure-invalid evidence also stays unscored and blocks
            Official publication; neither state is converted into semantic Incorrect.
          </dd>
        </div>
      </dl>
    </ReferenceDisclosure>
  );
}

export function CoreMethod() {
  return (
    <div className="reference-page">
      <ReferenceHeader
        title="How AIQ is scored"
        description="Compare task performance, read the uncertainty, and trace each score to its evidence."
      />
      <p className="reference-lead">
        72 controlled tasks compare model and reasoning-effort configurations. Results describe this
        task set; they are not a population IQ score.
      </p>
      <dl className="reference-reading-grid">
        <div>
          <dt>Ability · 0–100</dt>
          <dd>Calibrated performance on the committed task set. Higher is better.</dd>
        </div>
        <div>
          <dt>Strict pass · %</dt>
          <dd>Fully correct outcomes as a share of tasks with a semantic score.</dd>
        </div>
        <div>
          <dt>Intervals · conditional 95%</dt>
          <dd>
            Ability uncertainty with the item bank fixed. Point order alone does not establish a
            winner.
          </dd>
        </div>
      </dl>
      <p className="reference-note">
        Current Core definition. Historical records retain their original task and scoring versions.
      </p>
      <ReferenceViewLinks
        links={[
          { view: 'data', label: 'Download files' },
          { view: 'records', label: 'Open records' },
        ]}
      />
      <ReferenceNavigation
        sections={[
          ['core-estimand', 'Scope'],
          ['core-domains', 'Domains'],
          ['core-validity', 'Validity'],
          ['core-task-score', 'Task score'],
          ['core-uncertainty', 'Uncertainty'],
          ['core-efficiency', 'Time & cost'],
        ]}
      />
      <ReferenceDisclosure
        id="core-estimand"
        title="What is measured"
        description="Fixed task scope, calibrated ability, and evidence commitments"
      >
        <div className="reference-version-strip">
          <div>
            <span>Benchmark</span>
            <strong>{coreDefinition.benchmarkVersion}</strong>
          </div>
          <div>
            <span>Scoring</span>
            <strong>{coreDefinition.scoringVersion}</strong>
          </div>
          <div>
            <span>Task scorer</span>
            <strong>{AIQ_CORE_TASK_SCORER_VERSION}</strong>
          </div>
        </div>
        <p className="research-caption">
          <a href={coreCatalogueSource}>Frozen Core task catalogue</a>
        </p>
        <h4>Observable outcomes on the committed set</h4>
        <ol className="principle-list">
          {coreDefinition.principles.map((principle) => (
            <li key={principle}>{principle}</li>
          ))}
        </ol>
      </ReferenceDisclosure>
      <ReferenceDisclosure
        id="core-domains"
        title="Domain coverage"
        description="72 tasks · 10 equally weighted domains"
      >
        <div
          className="research-table-scroll domain-weight-table"
          role="region"
          aria-label="Domain weights"
          tabIndex={0}
        >
          <table className="research-table core-domain-table">
            <caption>Exact fixed-fixture domain task counts and macro-average weights.</caption>
            <thead>
              <tr>
                <th scope="col">
                  <TableColumnHeading label="Domain" />
                </th>
                <th scope="col">
                  <TableColumnHeading label="Tasks" unit="design" />
                </th>
                <th scope="col">
                  <TableColumnHeading label="Weight" unit="%" />
                </th>
              </tr>
            </thead>
            <tbody>
              {alphabetical(coreDefinition.domainWeights, (domain) => domain.domain).map(
                (domain) => (
                  <tr key={domain.domain}>
                    <th scope="row">{domain.domain.replaceAll('_', ' ')}</th>
                    <td>{domain.taskCount}</td>
                    <td>{(domain.weight * 100).toFixed(0)}%</td>
                  </tr>
                ),
              )}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">Total</th>
                <td>
                  {coreDefinition.domainWeights.reduce(
                    (total, domain) => total + domain.taskCount,
                    0,
                  )}
                </td>
                <td>
                  {(
                    coreDefinition.domainWeights.reduce(
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
      </ReferenceDisclosure>
      <ReferenceDisclosure
        id="core-validity"
        title="Completeness and validity"
        description="Missing results, attempted failures, and Official publication requirements"
      >
        <h4>Official, complete synthetic, provisional, or coverage-only</h4>
        <dl className="policy-list">
          <div>
            <dt>Attempted failure</dt>
            <dd>{coreDefinition.failurePolicy}</dd>
          </div>
          <div>
            <dt>Missing fixture or result</dt>
            <dd>{coreDefinition.missingPolicy}</dd>
          </div>
          <div>
            <dt>Hidden fixture boundary</dt>
            <dd>
              Hidden payloads stay sealed behind the published fixture-set commitment. Version, task
              counts, outcome states, and provenance remain public.
            </dd>
          </div>
        </dl>
      </ReferenceDisclosure>
      <TaskScoreMethod />
      <ReferenceDisclosure
        id="core-uncertainty"
        title="Uncertainty and task mix"
        description="Ability intervals, raw quality sensitivity, and interpretation limits"
      >
        <h4>Two intervals with different meanings</h4>
        <p>
          Official calibrated ability uses a conditional 95% interval derived from latent standard
          error while the released item bank stays fixed. The raw quality diagnostic has a separate
          task-mix sensitivity interval. Neither interval includes every source of benchmark or
          deployment uncertainty.
        </p>
        <p>{coreDefinition.sensitivityPolicy}</p>
        <div className="formula">
          <span>Official calibrated ability</span>
          <strong>100 × logistic(theta); raw domain mean is qualityScore</strong>
        </div>
      </ReferenceDisclosure>
      <EfficiencyMethod />
    </div>
  );
}
