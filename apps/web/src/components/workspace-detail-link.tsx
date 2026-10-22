'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useWorkspaceQuery } from './workspace-query.ts';

export function WorkspaceDetailLink({
  href,
  children,
  className,
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  const workspace = useWorkspaceQuery();
  return (
    <Link className={className} href={`${href}?return=${encodeURIComponent(workspace.href({}))}`}>
      {children}
    </Link>
  );
}
