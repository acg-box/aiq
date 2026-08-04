'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { EChartsCoreOption } from 'echarts/core';
import { use } from 'echarts/core';
import { BarChart, CustomChart, LineChart, ScatterChart } from 'echarts/charts';
import {
  AriaComponent,
  DataZoomComponent,
  DatasetComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import { init } from 'echarts/core';

use([
  BarChart,
  CustomChart,
  LineChart,
  ScatterChart,
  AriaComponent,
  DataZoomComponent,
  DatasetComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  SVGRenderer,
]);

export function EChartsChart({
  option,
  label,
  className,
}: {
  option: EChartsCoreOption;
  label: string;
  className: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const descriptionId = useId();
  const [description, setDescription] = useState(
    'Interactive chart. The complete values are available in the following data table.',
  );

  useEffect(() => {
    if (!host.current) return undefined;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const chart = init(host.current, undefined, { renderer: 'svg' });
    const syncDescription = () => {
      const generated = host.current?.querySelector('[aria-label]')?.getAttribute('aria-label');
      setDescription(
        generated?.trim() ||
          'Interactive chart. The complete values are available in the following data table.',
      );
    };
    const render = () => {
      const themedOption: EChartsCoreOption = {
        ...option,
        animation: !reducedMotion.matches,
      };
      chart.setOption(themedOption, { notMerge: true });
      syncDescription();
    };
    chart.on('finished', syncDescription);
    render();
    window.addEventListener('aiq-themechange', render);
    reducedMotion.addEventListener('change', render);
    const resize = new ResizeObserver(() => chart.resize());
    resize.observe(host.current);
    return () => {
      window.removeEventListener('aiq-themechange', render);
      reducedMotion.removeEventListener('change', render);
      resize.disconnect();
      chart.off('finished', syncDescription);
      chart.dispose();
    };
  }, [option]);

  return (
    <>
      <div className={className} role="img" aria-label={label} aria-describedby={descriptionId}>
        <div ref={host} className="echarts-host" aria-hidden="true" />
      </div>
      <p className="sr-only" id={descriptionId}>
        {description}
      </p>
    </>
  );
}
