import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const pageSourceUrl = new URL('./page.tsx', import.meta.url);
const analyticsSourceUrl = new URL('../components/homepage-analytics.tsx', import.meta.url);
const workspaceStylesUrl = new URL('./workspace.css', import.meta.url);

void describe('homepage evidence and loading contract', () => {
  void it('binds the snapshot to exact highlighted-run evidence', async () => {
    const source = await readFile(pageSourceUrl, 'utf8');

    assert.doesNotMatch(source, /getNewestCompletedRun|Newest retained run/);
    assert.match(source, /highestPointEvidence\?\.state === 'exact'/);
    assert.match(source, /Exact run completed/);
    assert.doesNotMatch(source, /snapshot-metrics" tabIndex/);
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
    assert.match(analyticsSource, /loading: \(\) => <AnalyticsLoading/);
    assert.match(analyticsSource, /role="status"/);
    assert.match(analyticsSource, /aria-live="polite"/);
    assert.match(workspaceStyles, /\.homepage-analytics-matrix \{\s+min-height: 680px;/);
    assert.match(workspaceStyles, /\.homepage-analytics-efficiency \{\s+min-height: 720px;/);
    assert.match(workspaceStyles, /\.homepage-analytics-calibration \{\s+min-height: 1100px;/);
    assert.match(workspaceStyles, /@media \(max-width: 760px\)[\s\S]+min-height: 1080px;/);
    assert.match(
      workspaceStyles,
      /\.homepage-analytics-matrix\.homepage-analytics-empty \{\s+min-height: 300px;/,
    );
    assert.match(
      workspaceStyles,
      /\.homepage-analytics-efficiency\.homepage-analytics-empty \{\s+min-height: 280px;/,
    );
    assert.match(analyticsSource, /onVisualizationPresenceChange={setHasVisualization}/);
  });

  void it('keeps the exact-run identity readable in a wider desktop evidence column', async () => {
    const workspaceStyles = await readFile(workspaceStylesUrl, 'utf8');

    assert.match(
      workspaceStyles,
      /grid-template-columns: minmax\(440px, 0\.42fr\) minmax\(0, 1fr\);/,
    );
    assert.match(workspaceStyles, /@media \(max-width: 1050px\)[\s\S]+\.benchmark-snapshot/);
    assert.match(workspaceStyles, /\.snapshot-estimate small,[\s\S]+overflow-wrap: anywhere;/);
  });

  void it('keeps the compact matrix headers separated on a narrow viewport', async () => {
    const workspaceStyles = await readFile(workspaceStylesUrl, 'utf8');

    assert.match(workspaceStyles, /\.compact-ranking-table th:first-child,[\s\S]+width: 64px;/);
    assert.match(
      workspaceStyles,
      /\.compact-ranking-table thead th:first-child \{\s+white-space: nowrap;/,
    );
    assert.match(workspaceStyles, /\.compact-ranking > header > a \{\s+max-width: 18ch;/);
  });

  void it('places the efficiency visualization under its own evidence heading', async () => {
    const source = await readFile(pageSourceUrl, 'utf8');
    const headingIndex = source.indexOf('id="efficiency-heading"');
    const plotIndex = source.indexOf('<DeferredEfficiencyPlot');

    assert.notEqual(headingIndex, -1);
    assert.notEqual(plotIndex, -1);
    assert.ok(headingIndex < plotIndex);
  });
});
