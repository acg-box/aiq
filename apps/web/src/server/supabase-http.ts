const DEFAULT_SUPABASE_HTTP_TIMEOUT_MS = 10_000;
export const VERIFICATION_SUPABASE_HTTP_TIMEOUT_MS = 120_000;

interface BoundedFetchOptions {
  fetchImplementation: typeof fetch;
  parentSignal: AbortSignal | undefined;
  timeoutMs: number;
}

export interface BoundedFetchTestOptions {
  fetchImplementation: typeof fetch;
  parentSignal?: AbortSignal;
  timeoutMs: number;
}

class SupabaseHttpTimeoutError extends Error {
  constructor() {
    super('Supabase request timed out.');
    this.name = 'SupabaseHttpTimeoutError';
  }
}

class SupabaseHttpRequestError extends Error {
  constructor() {
    super('Supabase request failed.');
    this.name = 'SupabaseHttpRequestError';
  }
}

function inputSignal(input: RequestInfo | URL, init: RequestInit | undefined) {
  if (init && 'signal' in init) return init.signal ?? undefined;
  return input instanceof Request ? input.signal : undefined;
}

function signalRejection(signal: AbortSignal): {
  promise: Promise<never>;
  removeListener: () => void;
} {
  let rejectAbort: ((reason: unknown) => void) | undefined;
  const onAbort = () => rejectAbort?.(signal.reason);
  const promise = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return {
    promise,
    removeListener: () => signal.removeEventListener('abort', onAbort),
  };
}

function createBoundedFetch({
  fetchImplementation,
  parentSignal,
  timeoutMs,
}: BoundedFetchOptions): typeof fetch {
  return async (input, init) => {
    const suppliedSignal = inputSignal(input, init);
    if (parentSignal?.aborted) throw parentSignal.reason;
    if (suppliedSignal?.aborted) throw suppliedSignal.reason;
    const deadline = new AbortController();
    const timeoutError = new SupabaseHttpTimeoutError();
    const signals = [parentSignal, suppliedSignal, deadline.signal].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
    const signal = AbortSignal.any(signals);
    const timeout = setTimeout(() => deadline.abort(timeoutError), timeoutMs);
    timeout.unref?.();
    const rejection = signalRejection(signal);

    try {
      return await Promise.race([
        fetchImplementation(input, { ...init, signal }),
        rejection.promise,
      ]);
    } catch {
      if (parentSignal?.aborted) throw parentSignal.reason;
      if (suppliedSignal?.aborted) throw suppliedSignal.reason;
      if (deadline.signal.aborted) throw timeoutError;
      throw new SupabaseHttpRequestError();
    } finally {
      clearTimeout(timeout);
      rejection.removeListener();
    }
  };
}

export function createBoundedSupabaseFetch(parentSignal?: AbortSignal): typeof fetch {
  return createBoundedFetch({
    fetchImplementation: globalThis.fetch,
    parentSignal,
    timeoutMs: DEFAULT_SUPABASE_HTTP_TIMEOUT_MS,
  });
}

export function createVerificationSupabaseFetch(parentSignal?: AbortSignal): typeof fetch {
  return createBoundedFetch({
    fetchImplementation: globalThis.fetch,
    parentSignal,
    timeoutMs: VERIFICATION_SUPABASE_HTTP_TIMEOUT_MS,
  });
}

export function createSupabaseApiKeyFetch(
  apiKey: string,
  parentSignal?: AbortSignal,
  fetchImplementation: typeof fetch = globalThis.fetch,
): typeof fetch {
  const boundedFetch = createBoundedFetch({
    fetchImplementation,
    parentSignal,
    timeoutMs: DEFAULT_SUPABASE_HTTP_TIMEOUT_MS,
  });
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    if (headers.get('authorization') === `Bearer ${apiKey}`) {
      headers.delete('authorization');
    }
    if (!headers.has('apikey')) headers.set('apikey', apiKey);
    return boundedFetch(input, { ...init, headers });
  };
}

export function createBoundedSupabaseFetchForTests({
  fetchImplementation,
  parentSignal,
  timeoutMs,
}: BoundedFetchTestOptions): typeof fetch {
  return createBoundedFetch({ fetchImplementation, parentSignal, timeoutMs });
}
