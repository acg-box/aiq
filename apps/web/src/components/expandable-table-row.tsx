'use client';

import { CaretDownIcon } from '@phosphor-icons/react/dist/ssr/CaretDown';
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from 'react';
import { TableColumnHeading } from './table-column-heading.tsx';
import { useSavedWorkspacePosition } from './workspace-position.ts';

/** Keep the desktop table intact and disclose secondary cells below a compact mobile row. */
export function ExpandableTableRow({
  label,
  visibleColumns,
  details,
  children,
  ...props
}: HTMLAttributes<HTMLTableRowElement> & {
  label: string;
  visibleColumns: number;
  details: ReactNode;
}) {
  const id = useId();
  const saved = useSavedWorkspacePosition();
  const [expanded, setExpanded] = useState(() => saved?.rows.includes(label) ?? false);
  const trigger = useRef<HTMLButtonElement>(null);
  const origin = useRef<{ x: number; y: number; parent: Element | null; top: number } | null>(null);
  const closing = useRef(false);
  function close() {
    closing.current = true;
    setExpanded(false);
  }
  useLayoutEffect(() => {
    if (expanded || !closing.current) return;
    closing.current = false;
    trigger.current?.focus({ preventScroll: true });
    const position = origin.current;
    if (position) {
      if (position.parent) position.parent.scrollTop = position.top;
      window.scrollTo({ left: position.x, top: position.y, behavior: 'instant' });
    } else trigger.current?.scrollIntoView({ block: 'center', behavior: 'instant' });
  }, [expanded]);
  return (
    <>
      <tr {...props}>
        {children}
        <td className="row-expand-cell">
          <button
            ref={trigger}
            type="button"
            className="row-expand-button"
            aria-label={`Details for ${label}`}
            aria-expanded={expanded}
            aria-controls={expanded ? id : undefined}
            onClick={() => {
              if (expanded) close();
              else {
                const parent = trigger.current?.closest('.research-table-scroll') ?? null;
                origin.current = {
                  x: window.scrollX,
                  y: window.scrollY,
                  parent,
                  top: parent?.scrollTop ?? 0,
                };
                setExpanded(true);
              }
            }}
          >
            <CaretDownIcon size={15} aria-hidden="true" />
          </button>
        </td>
      </tr>
      {expanded ? (
        <tr className="row-expanded">
          <td colSpan={visibleColumns + 1}>
            <div
              id={id}
              className="row-expanded-content"
              data-expanded-row={label}
              role="region"
              aria-label={`${label} details`}
            >
              {details}
              <button
                type="button"
                className="ui-action row-collapse"
                aria-label={`Close details for ${label}`}
                onClick={close}
              >
                Close details <CaretDownIcon size={14} aria-hidden="true" />
              </button>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

export function TableRowFacts({
  items,
  layout = 'metrics',
}: {
  items: readonly { label: string; unit?: string; value: ReactNode; wide?: boolean }[];
  layout?: 'metrics' | 'rows';
}) {
  return (
    <dl className={`table-row-facts${layout === 'rows' ? ' table-row-facts-rows' : ''}`}>
      {items.map(({ label, unit, value, wide }) => (
        <div key={`${label}-${unit ?? ''}`} className={wide ? 'table-row-fact-wide' : undefined}>
          <dt>
            <TableColumnHeading label={label} {...(unit ? { unit } : {})} />
          </dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function RowDetailContext({
  children,
  label = 'Context & evidence',
}: {
  children: ReactNode;
  label?: string;
}) {
  return (
    <details className="row-detail-context">
      <summary>{label}</summary>
      <div>{children}</div>
    </details>
  );
}
