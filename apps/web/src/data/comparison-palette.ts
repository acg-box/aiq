/** Category colors identify subjects. Blue is reserved for workspace interaction. */
const subjects: Readonly<Record<string, string>> = {
  codex: 'teal',
  deepseek: 'cyan',
  hermes: 'amber',
  luna: 'teal',
  openviking: 'amber',
  pi: 'rose',
  ragflow: 'rose',
  sol: 'amber',
  terra: 'rose',
};

export function comparisonColor(subject: string): string {
  const family = subject.toLowerCase().split(/[\s-]/)[0] ?? '';
  return `var(--plot-${subjects[family] ?? 'neutral'})`;
}

const configurations = {
  none: { pattern: 'dotted', dashArray: '1 3', symbol: 'emptyCircle', fill: 'dots' },
  low: { pattern: 'dashed', dashArray: '2 3', symbol: 'circle', fill: 'stripes' },
  medium: { pattern: 'solid', dashArray: undefined, symbol: 'rect', fill: 'solid' },
  high: { pattern: 'dashed', dashArray: '6 3', symbol: 'triangle', fill: 'stripes' },
  xhigh: { pattern: 'dashed', dashArray: '8 3 2 3', symbol: 'diamond', fill: 'stripes' },
  max: { pattern: 'dotted', dashArray: '2 3 2 6', symbol: 'roundRect', fill: 'dots' },
  ultra: { pattern: 'dashed', dashArray: '12 4', symbol: 'pin', fill: 'stripes' },
} as const;

/** Configuration labels remain visible; texture and line shape add a color-independent cue. */
export function configurationStyle(effort: string) {
  return (
    Object.entries(configurations).find(([name]) => name === effort)?.[1] ?? configurations.medium
  );
}
