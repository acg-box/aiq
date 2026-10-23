'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { hrefWithParams, updateAnalyticalUrl } from './analytical-url-state.ts';

export function useWorkspaceQuery() {
  const pathname = usePathname();
  const params = useSearchParams();
  function href(changes: Record<string, string | null>) {
    return hrefWithParams(pathname, new URLSearchParams(params.toString()), changes, {
      sort: false,
    });
  }
  return {
    params,
    href,
    update: (changes: Record<string, string | null>, options?: { replace?: boolean }) =>
      updateAnalyticalUrl(changes, { ...options, sort: false }),
  };
}
