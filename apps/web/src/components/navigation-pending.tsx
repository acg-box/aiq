'use client';

import { CircleNotchIcon } from '@phosphor-icons/react/dist/csr/CircleNotch';
import { useLinkStatus } from 'next/link';

export function NavigationPending() {
  const { pending } = useLinkStatus();
  return (
    <>
      <span className="navigation-pending" data-pending={pending || undefined} aria-hidden="true">
        <CircleNotchIcon size={14} />
      </span>
      <span className="sr-only" role="status">
        {pending ? 'Opening view…' : ''}
      </span>
    </>
  );
}
