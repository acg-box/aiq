import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const pageSourceUrl = new URL('./page.tsx', import.meta.url);
const analyticsSourceUrl = new URL('../components/homepage-analytics.tsx', import.meta.url);
const workspaceStylesUrl = new URL('./workspace.css', import.meta.url);
const globalStylesUrl = new URL('./globals.css', import.meta.url);

void describe('homepage evidence and loading contract', () => {
  void it('binds the snapshot to exact highlighted-run evidence', async () => {
    const source = await readFile(pageSourceUrl, 'utf8');

    assert.doesNotMatch(source, /getNewestCompletedRun|Newest retained run/);
    assert.match(source, /selectedEstimateEvidence\?\.state === 'exact'/);
    assert.match(source, /highlightedRun \?/);
    assert.match(source, /Exact run <Link href=/);
    assert.match(source, /<details className="evidence-notes"/);
    assert.doesNotMatch(source, /<code>\{highlightedRun\.id\}<\/code>/);
  });

  void it('presents fixed-task analysis without winner or batch-aggregate implications', async () => {
    const source = await readFile(pageSourceUrl, 'utf8');
    const workbenchSource = await readFile(
      new URL('../components/configuration-workbench-view.tsx', import.meta.url),
      'utf8',
    );
    const outcomeSource = await readFile(
      new URL('../components/run-outcome-card.tsx', import.meta.url),
      'utf8',
    );

    assert.match(source, /conditional\s+95%\s+interval/i);
    assert.doesNotMatch(source, /general intelligence/);
    assert.match(workbenchSource, /Compare configurations/);
    assert.match(workbenchSource, /remain independent observations/);
    assert.match(workbenchSource, /Trade-off shortlist/);
    assert.match(workbenchSource, /Pareto options/);
    assert.doesNotMatch(workbenchSource, /overall score|efficiency score/i);
    assert.match(outcomeSource, /equal weight across/);
    assert.match(outcomeSource, /Any credit/);
    assert.match(outcomeSource, /A zero\s+is a scored outcome, not missing data/);
    assert.match(outcomeSource, /runs\/\$\{run\.id\}/);
  });

  void it('keeps first-screen analysis in one deferred client boundary', async () => {
    const [pageSource, analyticsSource, workspaceStyles] = await Promise.all([
      readFile(pageSourceUrl, 'utf8'),
      readFile(analyticsSourceUrl, 'utf8'),
      readFile(workspaceStylesUrl, 'utf8'),
    ]);

    assert.doesNotMatch(pageSource, /components\/(model-matrix-chart|efficiency-plot|three)/);
    assert.match(analyticsSource, /dynamic\(/);
    assert.match(analyticsSource, /ssr: false/);
    assert.match(analyticsSource, /IntersectionObserver/);
    assert.match(analyticsSource, /rootMargin: '500px 0px'/);
    assert.match(analyticsSource, /useNearViewport\(eager\)/);
    assert.match(pageSource, /<ConfigurationWorkbench rows={exactOfficialEfficiency\.rows} \/>/);
    assert.match(pageSource, /<DeferredModelMatrixChart entries={leaderboard} eager \/>/);
    assert.match(analyticsSource, /loading: \(\) => <AnalyticsLoading/);
    assert.match(analyticsSource, /role="status"/);
    assert.match(analyticsSource, /aria-live="polite"/);
    assert.match(workspaceStyles, /\.homepage-analytics-loading \{[\s\S]+min-height: 320px;/);
    assert.match(workspaceStyles, /\.workbench-visualization \{[\s\S]+min-height: 430px;/);
    assert.match(workspaceStyles, /@media \(max-width: 760px\)[\s\S]+min-height: 360px;/);
    assert.match(analyticsSource, /onVisualizationPresenceChange={setHasVisualization}/);
  });

  void it('keeps exact-run identity in the evidence layer instead of the first-screen metrics', async () => {
    const [source, workspaceStyles] = await Promise.all([
      readFile(pageSourceUrl, 'utf8'),
      readFile(workspaceStylesUrl, 'utf8'),
    ]);

    const strip = source.slice(
      source.indexOf('<header className="benchmark-strip"'),
      source.indexOf('</header>'),
    );
    assert.doesNotMatch(strip, /highlightedRun\.id/);
    assert.match(source, /Exact run <Link href=/);
    assert.match(workspaceStyles, /\.evidence-notes/);
  });

  void it('keeps sortable table headings available on a narrow viewport', async () => {
    const [source, workbenchSource, workspaceStyles, globalStyles] = await Promise.all([
      readFile(pageSourceUrl, 'utf8'),
      readFile(new URL('../components/configuration-workbench-view.tsx', import.meta.url), 'utf8'),
      readFile(workspaceStylesUrl, 'utf8'),
      readFile(globalStylesUrl, 'utf8'),
    ]);

    assert.doesNotMatch(source, /TrophyIcon|ChartBarIcon|TargetIcon/);
    assert.match(
      workspaceStyles,
      /@media \(max-width: 760px\)[\s\S]+\.workbench-summaries \{[\s\S]+grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/,
    );
    assert.match(
      workspaceStyles,
      /@media \(max-width: 760px\)[\s\S]+\.workbench-table \{[\s\S]+overflow-x: auto;/,
    );
    assert.match(
      workspaceStyles,
      /@media \(max-width: 760px\)[\s\S]+\.workbench-table table \{[\s\S]+min-width: 760px;/,
    );
    assert.match(workbenchSource, /aria-controls="workbench-filter-content"/);
    assert.match(
      workspaceStyles,
      /\.workbench-filter-content\[data-open='false'\] \{[\s\S]+display: none;/,
    );
    assert.match(
      workspaceStyles,
      /\.workbench-filter-toggle \{[\s\S]+display: flex;[\s\S]+border-bottom: 1px solid var\(--line\);/,
    );
    assert.doesNotMatch(workspaceStyles, /\.workbench-table thead \{\s+display: none;/);
    assert.match(globalStyles, /html \{[\s\S]+overflow-x: clip;/);
  });

  void it('keeps methodology detail typography subordinate to the page hierarchy', async () => {
    const workspaceStyles = await readFile(workspaceStylesUrl, 'utf8');
    assert.match(workspaceStyles, /\.method-layout > article > h2 \{[\s\S]+font-size: 0\.96rem;/);
    assert.match(workspaceStyles, /\.principle-list li \{[\s\S]+font-size: 0\.78rem;/);
  });

  void it('uses real efficiency evidence when present and a real score matrix otherwise', async () => {
    const source = await readFile(pageSourceUrl, 'utf8');
    assert.match(source, /const hasEfficiencyEvidence =/);
    assert.match(source, /hasEfficiencyEvidence \? \([\s\S]+<ConfigurationWorkbench/);
    assert.match(source, /\) : \([\s\S]+<DeferredModelMatrixChart/);
    assert.match(
      source,
      /<div[\s\S]+className="results-main-grid"[\s\S]+id="compare"[\s\S]+data-workspace-section[\s\S]+data-nav-section="compare"/,
    );
    assert.doesNotMatch(source, /<div id="compare" className="sr-only"/);
    assert.match(source, /rankedEntries\.length === 0[\s\S]+<LeaderboardTable entries=/);
    assert.doesNotMatch(source, /standardApiEquivalentUsdNanos: [0-9]/);
  });

  void it('composes the primary product into one anchored workspace', async () => {
    const source = await readFile(pageSourceUrl, 'utf8');
    const workbenchSource = await readFile(
      new URL('../components/configuration-workbench-view.tsx', import.meta.url),
      'utf8',
    );

    assert.doesNotMatch(source, /import ComparePage from '\.\/compare\/page\.tsx'/);
    assert.match(source, /import TrendsPage from '\.\/trends\/page\.tsx'/);
    assert.match(source, /import RunsPage from '\.\/runs\/page\.tsx'/);
    assert.match(source, /import MethodPage from '\.\/method\/page\.tsx'/);
    assert.match(source, /import RadarPage from '\.\/radar\/page\.tsx'/);
    for (const section of ['results', 'trends', 'runs', 'method', 'radar']) {
      assert.match(source, new RegExp(`id="${section}"[\\s\\S]+data-workspace-section`));
    }
    assert.match(workbenchSource, /id="compare"[\s\S]+data-workspace-section/);
    assert.match(workbenchSource, /data-nav-section="compare"/);
    assert.match(source, /<TrendsPage searchParams={searchParams} \/>/);
    assert.match(source, /<ConfigurationWorkbench rows={exactOfficialEfficiency\.rows} \/>/);
    assert.match(source, /<RunsPage searchParams={searchParams} \/>/);
    assert.match(source, /<MethodPage \/>/);
    assert.match(source, /<RadarPage \/>/);
    assert.match(source, /<a className="text-link" href="#method">/);
  });

  void it('keeps embedded archive pagination inside the one-page workspace', async () => {
    const [source, archiveSource, detailSource] = await Promise.all([
      readFile(pageSourceUrl, 'utf8'),
      readFile(new URL('./runs/page.tsx', import.meta.url), 'utf8'),
      readFile(new URL('./runs/[id]/page.tsx', import.meta.url), 'utf8'),
    ]);

    assert.match(source, /<RunsPage searchParams={searchParams} \/>/);
    assert.match(archiveSource, /`\/\?\$\{parameter}/);
    assert.match(archiveSource, /#runs`/);
    assert.match(detailSource, /href="\/#runs"/);
  });

  void it('uses whitespace and semantic rows instead of nested decorative frames', async () => {
    const [workspaceStyles, globalStyles] = await Promise.all([
      readFile(workspaceStylesUrl, 'utf8'),
      readFile(globalStylesUrl, 'utf8'),
    ]);

    assert.match(
      workspaceStyles,
      /\.analysis-panel \{[\s\S]+border: 0;[\s\S]+background: transparent;[\s\S]+box-shadow: none;/,
    );
    assert.match(
      workspaceStyles,
      /\.task-list > article \{[\s\S]+border: 0;[\s\S]+border-bottom: 1px solid var\(--line\);[\s\S]+background: transparent;/,
    );
    assert.match(globalStyles, /\.data-note \{[\s\S]+border: 0;[\s\S]+background: transparent;/);
    assert.doesNotMatch(globalStyles, /\.data-note \{[\s\S]+border-left:/);
    assert.match(
      workspaceStyles,
      /\.evidence-notes \{[\s\S]+border: 0;[\s\S]+background: transparent;/,
    );
    assert.match(
      workspaceStyles,
      /\.evidence-status-disclosure \{[\s\S]+border: 0;[\s\S]+background: transparent;/,
    );
    assert.doesNotMatch(workspaceStyles, /\.evidence-notes > summary::after/);
    assert.match(
      workspaceStyles,
      /\.chart-switch,[\s\S]+\.range-tabs \{[\s\S]+border: 0;[\s\S]+background: transparent;/,
    );
    assert.match(
      workspaceStyles,
      /\.chart-switch button\[aria-pressed='true'\],[\s\S]+background: transparent;[\s\S]+box-shadow: none;/,
    );
    assert.match(globalStyles, /\.quiet-button \{[\s\S]+border: 0;[\s\S]+background: transparent;/);
    assert.match(
      globalStyles,
      /button \{[\s\S]+appearance: none;[\s\S]+border-radius: 0;[\s\S]+background: transparent;[\s\S]+box-shadow: none;/,
    );
    assert.match(
      globalStyles,
      /\.button\.primary \{[\s\S]+background: transparent;[\s\S]+border-radius: 0;[\s\S]+box-shadow: none;/,
    );
  });
});
