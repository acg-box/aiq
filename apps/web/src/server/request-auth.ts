import { createHash, timingSafeEqual } from 'node:crypto';

function tokenDigest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function hasValidBearerToken(
  authorizationHeader: string | null,
  expectedToken: string,
): boolean {
  if (!authorizationHeader?.startsWith('Bearer ') || expectedToken.length === 0) {
    return false;
  }
  const suppliedToken = authorizationHeader.slice('Bearer '.length);
  return timingSafeEqual(tokenDigest(suppliedToken), tokenDigest(expectedToken));
}

export const MAX_VERIFICATION_AUTHORIZATION_BYTES = 4_096;

export function hasValidVerificationBearerToken(
  authorizationHeader: string | null,
  expectedToken: string,
): boolean {
  if (
    !authorizationHeader?.startsWith('Bearer ') ||
    Buffer.byteLength(authorizationHeader, 'utf8') > MAX_VERIFICATION_AUTHORIZATION_BYTES ||
    expectedToken.length === 0 ||
    Buffer.byteLength(expectedToken, 'utf8') >
      MAX_VERIFICATION_AUTHORIZATION_BYTES - Buffer.byteLength('Bearer ', 'utf8')
  ) {
    return false;
  }
  return hasValidBearerToken(authorizationHeader, expectedToken);
}
