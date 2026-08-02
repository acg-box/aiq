export type PublicDataConfiguration = 'seed' | 'live' | 'invalid';

export interface PublicSupabaseConfiguration {
  state: PublicDataConfiguration;
  url?: string;
  publishableKey?: string;
  issues: readonly string[];
}

const PUBLISHABLE_KEY = /^sb_publishable_[A-Za-z0-9_-]+(?![\s\S])/;

export function isSupabasePublicKey(value: string): boolean {
  return PUBLISHABLE_KEY.test(value);
}

function inspectPublicUrl(
  value: string,
  nodeEnvironment: string | undefined,
  issues: string[],
): string | undefined {
  try {
    const parsed = new URL(value);
    const localHttp =
      (nodeEnvironment === 'development' || nodeEnvironment === 'test') &&
      parsed.protocol === 'http:' &&
      (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
    if (parsed.protocol !== 'https:' && !localHttp) {
      issues.push('NEXT_PUBLIC_SUPABASE_URL must use HTTPS');
    }
    if (
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      (parsed.pathname !== '' && parsed.pathname !== '/')
    ) {
      issues.push(
        'NEXT_PUBLIC_SUPABASE_URL must be an origin without credentials, a path, a query, or a fragment',
      );
    }
    if (value !== parsed.origin) {
      issues.push('NEXT_PUBLIC_SUPABASE_URL must use its canonical origin form');
    }
    return parsed.origin;
  } catch {
    issues.push('NEXT_PUBLIC_SUPABASE_URL is not a valid absolute URL');
    return undefined;
  }
}

export function inspectPublicSupabaseConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): PublicSupabaseConfiguration {
  const rawUrl = environment.NEXT_PUBLIC_SUPABASE_URL;
  const rawPublishableKey = environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const hasUrl = rawUrl !== undefined && rawUrl !== '';
  const hasPublishableKey = rawPublishableKey !== undefined && rawPublishableKey !== '';
  if (!hasUrl && !hasPublishableKey) {
    const nodeEnvironment = environment.NODE_ENV?.trim();
    return nodeEnvironment === 'development' || nodeEnvironment === 'test'
      ? { state: 'seed', issues: [] }
      : {
          state: 'invalid',
          issues: [
            'Synthetic seed mode requires NODE_ENV to be development or test when both public Supabase variables are absent',
          ],
        };
  }

  const issues: string[] = [];
  if (!hasUrl) issues.push('NEXT_PUBLIC_SUPABASE_URL is missing');
  if (!hasPublishableKey) issues.push('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is missing');
  if (rawUrl !== rawUrl?.trim()) {
    issues.push('NEXT_PUBLIC_SUPABASE_URL must not contain leading or trailing whitespace');
  }
  if (rawPublishableKey !== rawPublishableKey?.trim()) {
    issues.push(
      'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY must not contain leading or trailing whitespace',
    );
  }

  const url = hasUrl
    ? inspectPublicUrl(rawUrl ?? '', environment.NODE_ENV?.trim(), issues)
    : undefined;
  if (hasPublishableKey && !isSupabasePublicKey(rawPublishableKey ?? '')) {
    issues.push('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY has an invalid publishable-key shape');
  }
  if (issues.length > 0 || !url || !rawPublishableKey) {
    return url ? { state: 'invalid', url, issues } : { state: 'invalid', issues };
  }
  return { state: 'live', url, publishableKey: rawPublishableKey, issues };
}
