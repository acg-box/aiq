'use client';

import { ArrowRightIcon } from '@phosphor-icons/react/dist/ssr/ArrowRight';
import { XIcon } from '@phosphor-icons/react/dist/csr/X';
import { useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { evidencePositionKey, useSavedWorkspacePosition } from './workspace-position.ts';

export function EvidenceDrawer({
  title,
  label,
  contextLabel = 'Result evidence',
  closeLabel = 'Close evidence details',
  triggerContent,
  triggerClassName,
  children,
}: {
  title: string;
  label: string;
  contextLabel?: string;
  closeLabel?: string;
  triggerContent?: ReactNode;
  triggerClassName?: string | undefined;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const saved = useSavedWorkspacePosition();
  useLayoutEffect(() => {
    const current = dialog.current;
    if (
      !current ||
      !trigger.current?.getClientRects().length ||
      !saved?.dialogs.includes(evidencePositionKey(current))
    )
      return;
    current.inert = false;
    current.setAttribute('aria-hidden', 'false');
    current.showModal();
  }, [label, saved]);
  function closeDrawer() {
    const current = dialog.current;
    if (!current) return;
    current.close();
    trigger.current?.focus({ preventScroll: true });
    current.inert = true;
    current.setAttribute('aria-hidden', 'true');
  }
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={triggerClassName ?? 'ui-action evidence-trigger'}
        aria-label={triggerContent ? undefined : `Details: ${label}`}
        aria-haspopup="dialog"
        onClick={() => {
          const current = dialog.current;
          if (!current) return;
          current.inert = false;
          current.setAttribute('aria-hidden', 'false');
          current.showModal();
          current.scrollTop = 0;
        }}
      >
        {triggerContent ?? (
          <>
            <span>Details</span>
            <ArrowRightIcon size={15} aria-hidden="true" />
          </>
        )}
      </button>
      <dialog
        ref={dialog}
        className="evidence-drawer"
        data-evidence-label={label}
        aria-hidden="true"
        inert
        onCancel={(event) => {
          event.preventDefault();
          closeDrawer();
        }}
        onClick={(event) => {
          if (event.target !== event.currentTarget) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < bounds.left ||
            event.clientX > bounds.right ||
            event.clientY < bounds.top ||
            event.clientY > bounds.bottom
          )
            closeDrawer();
        }}
        aria-labelledby={titleId}
      >
        <header className="evidence-drawer-header">
          <div>
            <p>{contextLabel}</p>
            <h2 id={titleId}>{title}</h2>
          </div>
          <button
            className="ui-action ui-icon-action"
            type="button"
            aria-label={closeLabel}
            onClick={closeDrawer}
          >
            <XIcon size={18} aria-hidden="true" />
          </button>
        </header>
        <div className="evidence-drawer-body">{children}</div>
      </dialog>
    </>
  );
}
