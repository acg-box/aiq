'use client';

import dynamic from 'next/dynamic';
import { useEffect, useRef, useState } from 'react';

import type {
  BenchmarkRunSummary,
  LeaderboardEntry,
  PublicCalibrationScore,
  PublicModelEfficiency,
} from '../data/types.ts';
import { isScoredLeaderboardEntry } from '../data/types.ts';

const ModelMatrixChart = dynamic(
  () => import('./model-matrix-chart.tsx').then(({ ModelMatrixChart: Component }) => Component),
  { ssr: false, loading: () => <AnalyticsLoading kind="matrix" /> },
);
const EfficiencyPlot = dynamic(
  () => import('./efficiency-plot.tsx').then(({ EfficiencyPlot: Component }) => Component),
  { ssr: false, loading: () => <AnalyticsLoading kind="efficiency" /> },
);
const CalibrationEfficiency = dynamic(
  () =>
    import('./calibration-efficiency.tsx').then(
      ({ CalibrationEfficiency: Component }) => Component,
    ),
  { ssr: false, loading: () => <AnalyticsLoading kind="calibration" /> },
);

type AnalyticsKind = 'matrix' | 'efficiency' | 'calibration';

const loadingLabels: Readonly<Record<AnalyticsKind, string>> = {
  matrix: 'Loading interactive configuration matrix',
  efficiency: 'Loading interactive efficiency analysis',
  calibration: 'Loading interactive calibration analysis',
};

function AnalyticsLoading({ kind }: { kind: AnalyticsKind }) {
  return (
    <p
      className="homepage-analytics-loading"
      data-homepage-analytics-loading={kind}
      role="status"
      aria-atomic="true"
      aria-live="polite"
    >
      {loadingLabels[kind]}…
    </p>
  );
}

function useNearViewport() {
  const host = useRef<HTMLDivElement>(null);
  const [shouldLoad, setShouldLoad] = useState(false);

  useEffect(() => {
    const element = host.current;
    if (!element) return undefined;
    if (!('IntersectionObserver' in window)) {
      setShouldLoad(true);
      return undefined;
    }

    const observationTarget = element.closest('details') ?? element;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        setShouldLoad(true);
        observer.disconnect();
      },
      { rootMargin: '500px 0px' },
    );
    observer.observe(observationTarget);
    return () => observer.disconnect();
  }, []);

  return { host, shouldLoad };
}

export function DeferredModelMatrixChart({ entries }: { entries: readonly LeaderboardEntry[] }) {
  const { host, shouldLoad } = useNearViewport();
  const [hasVisualization, setHasVisualization] = useState(() =>
    entries.some(isScoredLeaderboardEntry),
  );
  return (
    <div
      ref={host}
      className={`homepage-analytics homepage-analytics-matrix${hasVisualization ? '' : ' homepage-analytics-empty'}`}
      data-homepage-analytics="matrix"
    >
      {shouldLoad ? (
        <ModelMatrixChart entries={entries} onVisualizationPresenceChange={setHasVisualization} />
      ) : (
        <AnalyticsLoading kind="matrix" />
      )}
    </div>
  );
}

export function DeferredEfficiencyPlot({
  entries,
  runSummaries,
  rows,
}: {
  entries: readonly LeaderboardEntry[];
  runSummaries: readonly BenchmarkRunSummary[];
  rows: readonly PublicModelEfficiency[];
}) {
  const { host, shouldLoad } = useNearViewport();
  const [hasVisualization, setHasVisualization] = useState(
    () => rows.length > 0 && runSummaries.length > 0 && entries.some(isScoredLeaderboardEntry),
  );
  return (
    <div
      ref={host}
      className={`homepage-analytics homepage-analytics-efficiency${hasVisualization ? '' : ' homepage-analytics-empty'}`}
      data-homepage-analytics="efficiency"
    >
      {shouldLoad ? (
        <EfficiencyPlot
          entries={entries}
          runSummaries={runSummaries}
          rows={rows}
          onVisualizationPresenceChange={setHasVisualization}
        />
      ) : (
        <AnalyticsLoading kind="efficiency" />
      )}
    </div>
  );
}

export function DeferredCalibrationEfficiency({
  scores,
  scoringVersion,
}: {
  scores: readonly PublicCalibrationScore[];
  scoringVersion: string | null;
}) {
  const { host, shouldLoad } = useNearViewport();
  return (
    <div
      ref={host}
      className="homepage-analytics homepage-analytics-calibration"
      data-homepage-analytics="calibration"
    >
      {shouldLoad ? (
        <CalibrationEfficiency scores={scores} scoringVersion={scoringVersion} />
      ) : (
        <AnalyticsLoading kind="calibration" />
      )}
    </div>
  );
}
