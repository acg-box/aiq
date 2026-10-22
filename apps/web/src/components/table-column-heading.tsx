'use client';

import { ArrowDownIcon } from '@phosphor-icons/react/dist/ssr/ArrowDown';
import { ArrowUpIcon } from '@phosphor-icons/react/dist/ssr/ArrowUp';
import { ArrowsDownUpIcon } from '@phosphor-icons/react/dist/ssr/ArrowsDownUp';

export function TableColumnHeading({
  label,
  unit,
  accessibleLabel = label,
  direction,
  disabled = false,
  onSort,
}: {
  label: string;
  unit?: string;
  accessibleLabel?: string;
  direction?: 'ascending' | 'descending' | undefined;
  disabled?: boolean;
  onSort?: () => void;
}) {
  const copy = (
    <span className="table-heading-copy">
      <span className="table-heading-title">{label}</span>{' '}
      {unit ? <span className="table-heading-unit">{unit}</span> : null}
    </span>
  );
  if (!onSort)
    return (
      <span className="table-column-heading" title={accessibleLabel}>
        {copy}
      </span>
    );
  return (
    <button
      className="table-column-heading"
      type="button"
      title={accessibleLabel}
      disabled={disabled}
      onClick={onSort}
    >
      {copy}
      <span className="table-heading-sort" aria-hidden="true">
        {disabled ? null : direction === 'descending' ? (
          <ArrowDownIcon size={12} />
        ) : direction === 'ascending' ? (
          <ArrowUpIcon size={12} />
        ) : (
          <ArrowsDownUpIcon size={12} />
        )}
      </span>
    </button>
  );
}
