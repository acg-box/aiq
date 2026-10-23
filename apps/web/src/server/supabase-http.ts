const DEFAULT_SUPABASE_HTTP_TIMEOUT_MS = 10_000;
export const VERIFICATION_SUPABASE_HTTP_TIMEOUT_MS = 120_000;

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

export function createBoundedSupabaseFetch(
  parentSignal?: AbortSignal,
  {
    fetchImplementation = globalThis.fetch,
    timeoutMs = DEFAULT_SUPABASE_HTTP_TIMEOUT_MS,
  }: { fetchImplementation?: typeof fetch; timeoutMs?: number } = {},
): typeof fetch {
  return async (input, init) => {
    const suppliedSignal = inputSignal(input, init);
    if (parentSignal?.aborted) throw parentSignal.reason;
    if (suppliedSignal?.aborted) throw suppliedSignal.reason;
    // The native deadline remains active through response-body consumption.
    const deadline = AbortSignal.timeout(timeoutMs);
    const signals = [parentSignal, suppliedSignal, deadline].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
    const signal = AbortSignal.any(signals);
    const rejection = signalRejection(signal);

    try {
      return await Promise.race([
        fetchImplementation(input, { ...init, signal }),
        rejection.promise,
      ]);
    } catch {
      if (parentSignal?.aborted) throw parentSignal.reason;
      if (suppliedSignal?.aborted) throw suppliedSignal.reason;
      if (deadline.aborted) throw new SupabaseHttpTimeoutError();
      throw new SupabaseHttpRequestError();
    } finally {
      rejection.removeListener();
    }
  };
}

export function createSupabaseRoleClientOptions(
  issueRoleToken: () => string,
  parentSignal?: AbortSignal,
  timeoutMs = DEFAULT_SUPABASE_HTTP_TIMEOUT_MS,
) {
  return {
    accessToken: async () => issueRoleToken(),
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: { fetch: createBoundedSupabaseFetch(parentSignal, { timeoutMs }) },
  };
}

export function createSupabaseApiKeyFetch(
  apiKey: string,
  parentSignal?: AbortSignal,
  fetchImplementation: typeof fetch = globalThis.fetch,
  timeoutMs = DEFAULT_SUPABASE_HTTP_TIMEOUT_MS,
): typeof fetch {
  const boundedFetch = createBoundedSupabaseFetch(parentSignal, { fetchImplementation, timeoutMs });
  return async (input, init) => {
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    if (headers.get('authorization') === `Bearer ${apiKey}`) {
      headers.delete('authorization');
    }
    if (!headers.has('apikey')) headers.set('apikey', apiKey);
    return boundedFetch(input, { ...init, headers });
  };
}
