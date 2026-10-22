import type { ReactNode } from 'react';
import { CaretDownIcon } from '@phosphor-icons/react/dist/ssr/CaretDown';
import { SlidersHorizontalIcon } from '@phosphor-icons/react/dist/ssr/SlidersHorizontal';

export function ComparisonFilters({
  context,
  label = 'Refine comparison',
  children,
}: {
  context?: string;
  label?: string;
  children: ReactNode;
}) {
  return (
    <details className="comparison-filters">
      <summary>
        <span className="ui-action comparison-filter-trigger">
          <SlidersHorizontalIcon size={16} aria-hidden="true" />
          {label}
          <CaretDownIcon size={12} aria-hidden="true" className="disclosure-caret" />
        </span>
        {context ? <span className="comparison-filter-context">{context}</span> : null}
      </summary>
      {children}
    </details>
  );
}
