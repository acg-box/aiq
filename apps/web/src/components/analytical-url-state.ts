import { useMemo, useSyncExternalStore } from 'react';

const ANALYTICAL_URL_CHANGE = 'aiq:analytical-url-change';
type AnalyticalUrlEvent = 'popstate' | typeof ANALYTICAL_URL_CHANGE;

export interface AnalyticalUrlHost {
  currentHref: () => string;
  currentSearch: () => string;
  pushState: (url: string) => void;
  addEventListener: (type: AnalyticalUrlEvent, listener: () => void) => void;
  removeEventListener: (type: AnalyticalUrlEvent, listener: () => void) => void;
  emitAnalyticalChange: () => void;
}

export interface AnalyticalUrlPushOptions {
  hasSemanticChange?: boolean;
}

export function createAnalyticalUrlStore(host: AnalyticalUrlHost) {
  return {
    getSnapshot: host.currentSearch,
    subscribe(onStoreChange: () => void): () => void {
      host.addEventListener('popstate', onStoreChange);
      host.addEventListener(ANALYTICAL_URL_CHANGE, onStoreChange);
      return () => {
        host.removeEventListener('popstate', onStoreChange);
        host.removeEventListener(ANALYTICAL_URL_CHANGE, onStoreChange);
      };
    },
    push(
      updates: Readonly<Record<string, string | null>>,
      { hasSemanticChange = true }: AnalyticalUrlPushOptions = {},
    ): boolean {
      if (!hasSemanticChange) return false;
      const url = new URL(host.currentHref());
      const next = hrefWithParams(url.pathname, url.searchParams, updates);
      const nextHref = `${next}${url.hash}`;
      const currentHref = `${hrefWithParams(url.pathname, url.searchParams, {})}${url.hash}`;
      if (nextHref === currentHref) return false;
      host.pushState(nextHref);
      host.emitAnalyticalChange();
      return true;
    },
  };
}

const browserStore = createAnalyticalUrlStore({
  currentHref: () => window.location.href,
  currentSearch: () => window.location.search,
  pushState: (url) => window.history.pushState(null, '', url),
  addEventListener: (type, listener) => window.addEventListener(type, listener),
  removeEventListener: (type, listener) => window.removeEventListener(type, listener),
  emitAnalyticalChange: () => window.dispatchEvent(new Event(ANALYTICAL_URL_CHANGE)),
});

function subscribeToUrlChange(onStoreChange: () => void): () => void {
  return browserStore.subscribe(onStoreChange);
}

function browserSearchSnapshot(): string {
  return browserStore.getSnapshot();
}

function serverSearchSnapshot(): string {
  return '';
}

export function useAnalyticalSearchParams(): URLSearchParams {
  const search = useSyncExternalStore(
    subscribeToUrlChange,
    browserSearchSnapshot,
    serverSearchSnapshot,
  );
  return useMemo(() => new URLSearchParams(search), [search]);
}

export function readEnumParam<const Value extends string>(
  params: URLSearchParams,
  key: string,
  allowed: readonly Value[],
  fallback: Value,
): Value {
  const value = params.get(key);
  return allowed.find((candidate) => candidate === value) ?? fallback;
}

export function readIdParam(
  params: URLSearchParams,
  key: string,
  allowed: readonly string[],
  fallback: string,
): string {
  const value = params.get(key);
  return value !== null && allowed.includes(value) ? value : fallback;
}

export function readBoundedIntegerParam(
  params: URLSearchParams,
  key: string,
  minimum: number,
  maximum: number,
): number | null {
  const value = params.get(key);
  if (value === null || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

export function readDistinctIdPair(
  params: URLSearchParams,
  leftKey: string,
  rightKey: string,
  allowed: readonly string[],
  defaultLeft: string,
  defaultRight: string,
): readonly [string, string] {
  const left = readIdParam(params, leftKey, allowed, defaultLeft);
  const requestedRight = readIdParam(params, rightKey, allowed, defaultRight);
  const right =
    requestedRight === left
      ? (allowed.find((candidate) => candidate !== left) ?? '')
      : requestedRight;
  return [left, right];
}

export function hrefWithParams(
  pathname: string,
  current: URLSearchParams,
  updates: Readonly<Record<string, string | null>>,
): string {
  const params = new URLSearchParams(current);
  for (const [key, value] of Object.entries(updates)) {
    if (value === null) params.delete(key);
    else params.set(key, value);
  }
  params.sort();
  const search = params.toString();
  return search.length > 0 ? `${pathname}?${search}` : pathname;
}

export function pushAnalyticalUrl(
  updates: Readonly<Record<string, string | null>>,
  options?: AnalyticalUrlPushOptions,
): void {
  browserStore.push(updates, options);
}
