import { createPrivateKey, sign, type KeyObject } from 'node:crypto';

export const SUPABASE_ROLE_TOKEN_TTL_SECONDS = 300;

export type SupabaseGatewayRole = 'aiq_verifier' | 'aiq_publisher';
export type SupabaseGatewayIdentity =
  | { readonly role: 'aiq_verifier' }
  | { readonly role: 'aiq_publisher'; readonly publisherNodeId: string };

const AIQ_NODE_ID = /^node_[0-9a-f]{64}(?![\s\S])/;

interface RoleTokenSigner {
  key: KeyObject;
  keyId: string;
}

function parseRoleTokenSigner(privateJwkJson: string): RoleTokenSigner {
  const candidate: unknown = JSON.parse(privateJwkJson);
  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    Array.isArray(candidate) ||
    !('kty' in candidate) ||
    candidate.kty !== 'EC' ||
    !('crv' in candidate) ||
    candidate.crv !== 'P-256' ||
    !('d' in candidate) ||
    typeof candidate.d !== 'string' ||
    !('x' in candidate) ||
    typeof candidate.x !== 'string' ||
    !('y' in candidate) ||
    typeof candidate.y !== 'string' ||
    !('kid' in candidate) ||
    typeof candidate.kid !== 'string' ||
    candidate.kid.length === 0 ||
    ('alg' in candidate && candidate.alg !== 'ES256')
  ) {
    throw new Error('The Supabase role-token key must be a private ES256 JWK with a key ID.');
  }
  const key = createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: candidate.d,
      x: candidate.x,
      y: candidate.y,
    },
    format: 'jwk',
  });
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('The Supabase role-token key must use the P-256 curve.');
  }
  return { key, keyId: candidate.kid };
}

function encodeJson(value: Readonly<Record<string, unknown>>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function isSupabaseRoleTokenKeyConfigured(privateJwkJson: string | undefined): boolean {
  if (!privateJwkJson) {
    return false;
  }
  try {
    parseRoleTokenSigner(privateJwkJson);
    return true;
  } catch {
    return false;
  }
}

export function isAiqNodeId(value: string | undefined): value is string {
  return value !== undefined && AIQ_NODE_ID.test(value);
}

export function createSupabaseRoleTokenIssuer(
  privateJwkJson: string,
  nowSeconds: () => number = () => Math.floor(Date.now() / 1_000),
): (identity: SupabaseGatewayIdentity) => string {
  const signer = parseRoleTokenSigner(privateJwkJson);
  return (identity) => {
    const issuedAt = nowSeconds();
    if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) {
      throw new Error('The role-token clock must return nonnegative whole seconds.');
    }
    if (identity.role === 'aiq_publisher' && !isAiqNodeId(identity.publisherNodeId)) {
      throw new Error('The publisher role token requires an exact AIQ publisher node ID.');
    }
    const encodedHeader = encodeJson({
      alg: 'ES256',
      kid: signer.keyId,
      typ: 'JWT',
    });
    const encodedPayload = encodeJson({
      role: identity.role,
      ...(identity.role === 'aiq_publisher'
        ? { aiq_publisher_node_id: identity.publisherNodeId }
        : {}),
      iat: issuedAt,
      exp: issuedAt + SUPABASE_ROLE_TOKEN_TTL_SECONDS,
    });
    const signingInput = `${encodedHeader}.${encodedPayload}`;
    const signature = sign('sha256', Buffer.from(signingInput, 'ascii'), {
      key: signer.key,
      dsaEncoding: 'ieee-p1363',
    });
    return `${signingInput}.${signature.toString('base64url')}`;
  };
}
