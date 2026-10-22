import Link from 'next/link';
import { WorkspaceDetailLink } from '../components/workspace-detail-link.tsx';
import { CoreMethod } from './core-method.tsx';
import { CoreTrends } from './core-trends.tsx';
import catalogue from '../../../../benchmarks/candidates/aiq-core-1.1.0/catalog.json' with { type: 'json' };
import {
  AIQ_CORE_SCORING_VERSION,
  AIQ_CORE_TASK_SET_VERSION,
  AIQ_CORE_TASK_SCORER_VERSION,
} from '../aiq-core-contract.ts';
import { BenchmarkHeading } from '../components/benchmark-heading.tsx';
import { BoardTabs } from '../components/board-tabs.tsx';
import { OfficialEfficiencyTable } from '../components/official-efficiency-table.tsx';
import { ReadStateNote } from '../components/read-state-note.tsx';
import { resolveExactEfficiencyRowsWithAvailability } from '../components/scientific-evidence-resolution.ts';
import { CoreResultsTable } from '../components/core-results-table.tsx';
import { readPublicData } from '../data/read-state.ts';
import { CALIBRATION_MODEL_CONFIGURATIONS } from '../data/repository.ts';
import { readCoreResults } from './core-data.ts';
import { ReferenceDisclosure } from '../components/reference-disclosure.tsx';
import { ReferenceViewLinks } from '../components/reference-view-links.tsx';
import { ReferenceHeader, SourceDownload } from '../components/reference-layout.tsx';

export async function CoreBoardContent({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const selectedView = query.view;
  const trendQuery = new URLSearchParams(
    Object.entries(query).flatMap(([key, value]) =>
      typeof value === 'string' ? [[key, value]] : [],
    ),
  );
  trendQuery.set('view', 'records');
  trendQuery.set('range', 'all');
  const trendSearch = Promise.resolve(
    typeof query.range === 'string' ? { range: query.range } : {},
  );
  const { repository, verified, unavailable, datasets } = await readCoreResults();
  const efficiency =
    selectedView === 'data' && verified.length > 0
      ? await readPublicData(
          repository,
          () => repository.listModelEfficiency(verified.map(({ run }) => run.id)),
          [],
          (rows) => rows.length === 0,
          () => [],
        )
      : null;
  const efficiencyEvidence = efficiency
    ? resolveExactEfficiencyRowsWithAvailability({
        runs: verified.map(({ run }) => run),
        entries: verified.map(({ entry }) => entry),
        efficiencyRows: efficiency.data,
        expectedRunIds: verified.map(({ run }) => run.id),
      })
    : null;
  const domains = [...new Set(catalogue.tasks.map((task) => task.domain))];
  const measuredDataset = datasets.find((dataset) => dataset.rows.length > 0);

  return (
    <>
      <BenchmarkHeading
        title="AI Intelligence"
        description="Model performance on controlled practical tasks."
        facts={[
          measuredDataset
            ? `${measuredDataset.rows.reduce((count, { entry }) => count + entry.sampleSize, 0).toLocaleString('en-US')} task results`
            : `${catalogue.tasks.length} tasks in design`,
          measuredDataset
            ? `${new Set(measuredDataset.rows.map(({ entry }) => entry.modelFamily)).size} model families`
            : `${domains.length} domains in design`,
          measuredDataset
            ? `${measuredDataset.rows.length} ${measuredDataset.historical ? 'historical' : 'Official'} configurations`
            : unavailable
              ? 'Measurements unavailable'
              : `${verified.length} Official configurations`,
        ]}
      />
      <BoardTabs
        tabs={[
          {
            id: 'leaderboard',
            label: 'Leaderboard',
            content: <CoreResultsTable datasets={datasets} />,
          },
          {
            id: 'records',
            label: 'Records',
            content: (
              <>
                <CoreResultsTable datasets={datasets} records />
                <section className="records-registers">
                  <h3>Additional records</h3>
                  <p className="research-caption">
                    Calibration checks, measurement history, and publication evidence.
                  </p>
                  <nav aria-label="Evidence registers" className="record-register-links">
                    <WorkspaceDetailLink href="/benchmarks/intelligence/calibrations">
                      Calibration records
                    </WorkspaceDetailLink>
                    <Link href={`/benchmarks/intelligence?${trendQuery}`}>
                      Time series and observation records
                    </Link>
                    <WorkspaceDetailLink href="/benchmarks/intelligence/verification">
                      Verification and provenance records
                    </WorkspaceDetailLink>
                  </nav>
                </section>
                {selectedView === 'records' && typeof query.range === 'string' ? (
                  <details className="research-disclosure" open>
                    <summary>Retained time series and speed observations</summary>
                    <CoreTrends searchParams={trendSearch} />
                  </details>
                ) : null}
              </>
            ),
          },
          {
            id: 'method',
            label: 'Method',
            content: <CoreMethod />,
          },
          {
            id: 'data',
            label: 'Data',
            content: (
              <div className="reference-page">
                <ReferenceHeader
                  title="Study files"
                  description="Download the task definitions, or open Records for measured runs and their original evidence."
                />
                <SourceDownload
                  href="/api/benchmarks/intelligence/catalog"
                  label="Frozen Core task catalogue · JSON"
                  detail={`${catalogue.tasks.length} task definitions · ${domains.length} domains · Core ${AIQ_CORE_TASK_SET_VERSION}`}
                  actionLabel="JSON ↓"
                >
                  Task catalogue
                </SourceDownload>
                <ReferenceViewLinks
                  links={[
                    { view: 'records', label: 'Open measured records' },
                    { view: 'method', label: 'Read method' },
                  ]}
                />
                <p className="reference-note">
                  This download defines Core {AIQ_CORE_TASK_SET_VERSION}.
                  {measuredDataset?.historical
                    ? ` Available measurements use Core ${measuredDataset.version}; each record retains that version.`
                    : ' Each result record identifies its own task and scoring versions.'}
                </p>
                {efficiency && efficiencyEvidence ? (
                  <section className="research-section">
                    <h3>Current Official efficiency evidence</h3>
                    <ReadStateNote result={efficiency} subject="Official efficiency" />
                    <OfficialEfficiencyTable
                      rows={efficiencyEvidence.rows}
                      expectedCount={efficiencyEvidence.expectedCount}
                      unavailableCount={efficiencyEvidence.unavailableCount}
                      rejectedCount={efficiencyEvidence.rejectedCount}
                    />
                  </section>
                ) : null}
                <ReferenceDisclosure
                  id="core-versions"
                  title="Current benchmark versions"
                  description="Task scorer, aggregate scoring, and configuration design"
                >
                  <dl className="evidence-facts">
                    <div>
                      <dt>Task set</dt>
                      <dd>
                        {AIQ_CORE_TASK_SET_VERSION} · {catalogue.tasks.length} tasks in{' '}
                        {domains.length} domains
                      </dd>
                    </div>
                    <div>
                      <dt>Task scorer</dt>
                      <dd>{AIQ_CORE_TASK_SCORER_VERSION}</dd>
                    </div>
                    <div>
                      <dt>Aggregate scoring</dt>
                      <dd>{AIQ_CORE_SCORING_VERSION}</dd>
                    </div>
                    <div>
                      <dt>Configuration design</dt>
                      <dd>
                        {CALIBRATION_MODEL_CONFIGURATIONS.length} configurations; design count, not
                        completed runs
                      </dd>
                    </div>
                  </dl>
                </ReferenceDisclosure>
              </div>
            ),
          },
        ]}
      />
    </>
  );
}
