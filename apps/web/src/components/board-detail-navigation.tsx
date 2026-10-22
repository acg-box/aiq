'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { ArrowLeftIcon } from '@phosphor-icons/react/dist/csr/ArrowLeft';
import { resolveWorkspaceReturn, type WorkspaceBoard } from './workspace-return.ts';
import { NavigationPending } from './navigation-pending.tsx';

export function BoardDetailNavigation({
  board,
  selected = 'records',
  fallback,
}: {
  board: WorkspaceBoard;
  selected?: string;
  fallback?: string;
}) {
  const pathname = usePathname();
  const returnTo = useSearchParams().get('return');
  const base = `/benchmarks/${board}`;
  const back = resolveWorkspaceReturn(
    board,
    returnTo,
    fallback ??
      `${base}?view=records${board === 'memory' ? `&study=${pathname.split('/')[4] ?? 'native-memory'}` : ''}`,
  );
  const query = back.query;
  if (board === 'memory' && !query.has('study'))
    query.set('study', pathname.split('/')[4] ?? 'native-memory');
  function destination(view: string) {
    const next = new URLSearchParams(query);
    next.set('view', view);
    return `${base}?${next}`;
  }
  return (
    <div className="board-detail-toolbar">
      <Link
        className="ui-action workspace-back"
        href={back.href}
        scroll={false}
        prefetch={false}
        aria-label={`← ${back.label}`}
        title={back.label}
      >
        <ArrowLeftIcon size={15} aria-hidden="true" />
        <span>{back.label}</span>
        <NavigationPending />
      </Link>
      <nav className="board-detail-navigation" aria-label="Board views">
        {[
          ['data', 'Data'],
          ['leaderboard', 'Leaderboard'],
          ['method', 'Method'],
          ['records', 'Records'],
        ].map(([id, label]) => (
          <Link
            key={id}
            href={destination(id ?? 'leaderboard')}
            scroll={false}
            aria-label={label}
            prefetch={false}
            aria-current={selected === id ? 'page' : undefined}
          >
            {label}
            <NavigationPending />
          </Link>
        ))}
      </nav>
    </div>
  );
}
