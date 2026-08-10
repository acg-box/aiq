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
    const decisionSource = await readFile(
      new URL('../components/configuration-decision-table.tsx', import.meta.url),
      'utf8',
    );
    const outcomeSource = await readFile(
      new URL('../components/run-outcome-card.tsx', import.meta.url),
      'utf8',
    );

    assert.match(source, /conditional\s+95%\s+interval/i);
    assert.doesNotMatch(source, /general intelligence/);
    assert.match(decisionSource, /Choose by ability, time, or cost/);
    assert.match(decisionSource, /never score inputs/);
    assert.match(decisionSource, /Not dominated on AIQ, time, and cost/);
    assert.doesNotMatch(decisionSource, /overall score|efficiency score/i);
    assert.match(outcomeSource, /equal weight across/);
    assert.match(outcomeSource, /Any credit/);
    assert.match(outcomeSource, /A zero\s+is a scored outcome, not missing data/);
    assert.match(outcomeSource, /runs\/\$\{run\.id\}/);
  });

  void it('keeps ECharts consumers behind a viewport-deferred client boundary', async () => {
    const [pageSource, analyticsSource, workspaceStyles] = await Promise.all([
      readFile(pageSourceUrl, 'utf8'),
      readFile(analyticsSourceUrl, 'utf8'),
      readFile(workspaceStylesUrl, 'utf8'),
    ]);

    assert.doesNotMatch(pageSource, /components\/(model-matrix-chart|efficiency-plot)/);
    assert.match(analyticsSource, /dynamic\(/);
    assert.match(analyticsSource, /ssr: false/);
    assert.match(analyticsSource, /IntersectionObserver/);
    assert.match(analyticsSource, /rootMargin: '500px 0px'/);
    assert.match(analyticsSource, /useNearViewport\(eager\)/);
    assert.match(pageSource, /<DeferredEfficiencyPlot[\s\S]+eager/);
    assert.match(pageSource, /<DeferredModelMatrixChart entries={leaderboard} eager \/>/);
    assert.match(analyticsSource, /loading: \(\) => <AnalyticsLoading/);
    assert.match(analyticsSource, /role="status"/);
    assert.match(analyticsSource, /aria-live="polite"/);
    assert.match(workspaceStyles, /\.homepage-analytics-loading \{[\s\S]+min-height: 320px;/);
    assert.match(
      workspaceStyles,
      /\.efficiency-panel > \.homepage-analytics,[\s\S]+min-height: 465px;/,
    );
    assert.match(workspaceStyles, /@media \(max-width: 760px\)[\s\S]+min-height: 430px;/);
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

  void it('keeps the decision table readable on a narrow viewport', async () => {
    const [source, workspaceStyles] = await Promise.all([
      readFile(pageSourceUrl, 'utf8'),
      readFile(workspaceStylesUrl, 'utf8'),
    ]);

    assert.doesNotMatch(source, /TrophyIcon|ChartBarIcon|TargetIcon/);
    assert.match(
      workspaceStyles,
      /@media \(max-width: 760px\)[\s\S]+\.decision-priorities \{[\s\S]+grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/,
    );
    assert.match(
      workspaceStyles,
      /\.decision-table tr \{[\s\S]+grid-template-columns: minmax\(112px, 1\.25fr\) repeat\(3, minmax\(58px, 0\.75fr\)\);/,
    );
    assert.match(workspaceStyles, /\.decision-action \{\s+display: none;/);
  });

  void it('uses real efficiency evidence when present and a real score matrix otherwise', async () => {
    const source = await readFile(pageSourceUrl, 'utf8');
    assert.match(source, /const hasEfficiencyEvidence =/);
    assert.match(source, /hasEfficiencyEvidence \? \([\s\S]+<DeferredEfficiencyPlot/);
    assert.match(source, /\) : \([\s\S]+<DeferredModelMatrixChart/);
    assert.match(source, /id={hasEfficiencyEvidence \? undefined : 'matrix'}/);
    assert.doesNotMatch(source, /<div id="matrix" className="sr-only"/);
    assert.match(source, /rankedEntries\.length === 0[\s\S]+<LeaderboardTable entries=/);
    assert.doesNotMatch(source, /standardApiEquivalentUsdNanos: [0-9]/);
  });

  void it('composes the primary product into one anchored workspace', async () => {
    const source = await readFile(pageSourceUrl, 'utf8');

    assert.match(source, /import ComparePage from '\.\/compare\/page\.tsx'/);
    assert.match(source, /import TrendsPage from '\.\/trends\/page\.tsx'/);
    assert.match(source, /import RunsPage from '\.\/runs\/page\.tsx'/);
    assert.match(source, /import MethodPage from '\.\/method\/page\.tsx'/);
    assert.match(source, /import RadarPage from '\.\/radar\/page\.tsx'/);
    for (const section of ['results', 'trends', 'compare', 'runs', 'method', 'radar']) {
      assert.match(source, new RegExp(`id="${section}"[\\s\\S]+data-workspace-section`));
    }
    assert.match(source, /<TrendsPage searchParams={searchParams} \/>/);
    assert.match(source, /<ComparePage \/>/);
    assert.match(source, /<RunsPage searchParams={searchParams} \/>/);
    assert.match(source, /<MethodPage \/>/);
    assert.match(source, /<RadarPage \/>/);
    assert.match(source, /href="#method"/);
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
