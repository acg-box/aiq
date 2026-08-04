const REQUIRED_VARIABLE = 'AIQ_PRODUCTION_ORIGIN';

export function resolveProductionOrigin(value: string | undefined): string {
  if (value === undefined || value.length === 0) {
    throw new Error(
      `${REQUIRED_VARIABLE} is required. Supply the exact HTTPS production origin to test.`,
    );
  }

  let candidate: URL;
  try {
    candidate = new URL(value);
  } catch {
    throw new Error(`${REQUIRED_VARIABLE} must be a valid absolute URL.`);
  }

  if (candidate.protocol !== 'https:') {
    throw new Error(`${REQUIRED_VARIABLE} must use HTTPS.`);
  }
  if (candidate.username.length > 0 || candidate.password.length > 0) {
    throw new Error(`${REQUIRED_VARIABLE} must not contain credentials.`);
  }
  if (candidate.pathname !== '/' || candidate.search.length > 0 || candidate.hash.length > 0) {
    throw new Error(`${REQUIRED_VARIABLE} must be an origin without a path, query, or fragment.`);
  }

  return candidate.origin;
}
