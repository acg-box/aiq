export type WorkspaceBoard = 'intelligence' | 'memory';

function isPage(href: string | null, path: string): href is string {
  return href === path || !!href?.startsWith(`${path}?`) || !!href?.startsWith(`${path}#`);
}

function searchOf(href: string) {
  return new URLSearchParams(href.split('#')[0]?.split('?')[1]);
}

// Keep the immediate return destination and the board's comparison scope separate.
export function resolveWorkspaceReturn(
  board: WorkspaceBoard,
  candidate: string | null,
  fallback = `/benchmarks/${board}?view=records`,
) {
  const base = `/benchmarks/${board}`;
  const calibrations = '/benchmarks/intelligence/calibrations';
  const href =
    isPage(candidate, base) || (board === 'intelligence' && isPage(candidate, calibrations))
      ? candidate
      : fallback;
  const parent = searchOf(href).get('return');
  const query = isPage(href, base)
    ? searchOf(href)
    : isPage(parent, base)
      ? searchOf(parent)
      : new URLSearchParams();
  query.delete('return');
  const view = ['data', 'leaderboard', 'method', 'records'].includes(query.get('view') ?? '')
    ? query.get('view')
    : 'leaderboard';
  const label = isPage(href, calibrations)
    ? 'Back to calibrations'
    : `Back to ${board === 'memory' ? 'Mem ' : ''}${view}`;
  return { href, label, query };
}
