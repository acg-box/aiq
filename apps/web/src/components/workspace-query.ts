'use client';

import { usePathname, useSearchParams } from 'next/navigation';

export function useWorkspaceQuery() {
  const pathname = usePathname();
  const params = useSearchParams();
  function href(changes: Record<string, string | null>) {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    const query = next.toString();
    return `${pathname}${query ? `?${query}` : ''}`;
  }
  return {
    params,
    href,
    update: (changes: Record<string, string | null>, options?: { replace?: boolean }) => {
      const next = href(changes);
      if (next === `${window.location.pathname}${window.location.search}`) return;
      if (options?.replace) window.history.replaceState(null, '', next);
      else window.history.pushState(null, '', next);
    },
  };
}
