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
  onDataPointClick,
  onBlankClick,
}: {
  option: EChartsCoreOption;
  label: string;
  className: string;
  onDataPointClick?: (event: unknown) => void;
  onBlankClick?: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<ReturnType<typeof init> | null>(null);
  const optionRef = useRef(option);
  const appliedOptionRef = useRef<EChartsCoreOption | null>(null);
  const interactionRef = useRef({ onDataPointClick, onBlankClick });
  const descriptionId = useId();
  const [description, setDescription] = useState(
    'Interactive chart. The complete values are available in the following data table.',
  );
  optionRef.current = option;
  interactionRef.current = { onDataPointClick, onBlankClick };

  useEffect(() => {
    if (!host.current) return undefined;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const instance = init(host.current, undefined, { renderer: 'svg' });
    chart.current = instance;
    const syncDescription = () => {
      const generated = host.current?.querySelector('[aria-label]')?.getAttribute('aria-label');
      setDescription(
        generated?.trim() ||
          'Interactive chart. The complete values are available in the following data table.',
      );
    };
    const render = () => {
      const motionEnabled = !reducedMotion.matches;
      const themedOption: EChartsCoreOption = {
        ...optionRef.current,
        animation: motionEnabled,
        animationDuration: motionEnabled ? 260 : 0,
        animationDurationUpdate: motionEnabled ? 180 : 0,
        animationEasing: 'cubicOut',
        animationEasingUpdate: 'cubicOut',
      };
      instance.setOption(themedOption, { notMerge: true });
      appliedOptionRef.current = optionRef.current;
    };
    const pointClick = (event: unknown) => interactionRef.current.onDataPointClick?.(event);
    const blankClick = (event: unknown) => {
      if (typeof event === 'object' && event !== null && 'target' in event && event.target) {
        return;
      }
      interactionRef.current.onBlankClick?.();
    };
    instance.on('finished', syncDescription);
    instance.on('click', pointClick);
    instance.getZr().on('click', blankClick);
    render();
    window.addEventListener('aiq-themechange', render);
    reducedMotion.addEventListener('change', render);
    const resize = new ResizeObserver(() => instance.resize());
    resize.observe(host.current);
    return () => {
      window.removeEventListener('aiq-themechange', render);
      reducedMotion.removeEventListener('change', render);
      resize.disconnect();
      instance.off('finished', syncDescription);
      instance.off('click', pointClick);
      instance.getZr().off('click', blankClick);
      instance.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    const instance = chart.current;
    if (!instance || appliedOptionRef.current === option) return;
    const motionEnabled = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    instance.setOption(
      {
        ...option,
        animation: motionEnabled,
        animationDuration: motionEnabled ? 260 : 0,
        animationDurationUpdate: motionEnabled ? 180 : 0,
        animationEasing: 'cubicOut',
        animationEasingUpdate: 'cubicOut',
      },
      { notMerge: true },
    );
    appliedOptionRef.current = option;
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
