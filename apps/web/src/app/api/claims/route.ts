// oxlint-disable-next-line import/no-unassigned-import -- This marker blocks client bundling.
import 'server-only';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { handleVerifierClaim, type VerifierClaim } from '../../../server/verifier-claim-handler.ts';
import { verificationRoleClientOptions } from '../../../server/verification-handler.ts';
import { createSupabaseRoleTokenIssuer } from '../../../server/supabase-role-token.ts';
import { inspectVerifierClaimConfiguration } from '../../../server/production-configuration.ts';
import { createSupabaseApiKeyFetch } from '../../../server/supabase-http.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RpcClient {
  rpc(
    functionName: string,
    parameters: Readonly<Record<string, unknown>>,
  ): ReturnType<SupabaseClient['rpc']>;
}

export async function POST(request: Request): Promise<Response> {
  const configuration = inspectVerifierClaimConfiguration(process.env).values;
  let verifier: RpcClient | undefined;
  let storage: SupabaseClient | undefined;
  const issueRoleToken = configuration
    ? createSupabaseRoleTokenIssuer(configuration.privateJwk)
    : null;
  function verifierClient(): RpcClient {
    if (!configuration || !issueRoleToken) throw new Error('Claim service is not configured.');
    verifier ??= createClient(
      configuration.serviceUrl,
      configuration.publishableKey,
      verificationRoleClientOptions(() => issueRoleToken({ role: 'aiq_verifier' }), request.signal),
    );
    return verifier;
  }
  async function rpc(
    name: string,
    parameters: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    const result = await verifierClient().rpc(name, parameters);
    if (result.error) throw new Error('Claim RPC failed.');
    return result.data;
  }
  return handleVerifierClaim(request, {
    configured: configuration !== undefined,
    expectedToken: configuration?.verifierToken ?? '',
    claim: async (leaseSeconds) =>
      rpc('aiq_claim_submission', { requested_lease_seconds: leaseSeconds }),
    renew: async (inboxId, leaseToken, leaseSeconds) =>
      rpc('aiq_renew_submission_claim', {
        target_inbox_id: inboxId,
        supplied_lease_token: leaseToken,
        requested_lease_seconds: leaseSeconds,
      }),
    acknowledge: async (inboxId, leaseToken, disposition) =>
      rpc('aiq_ack_submission_claim', {
        target_inbox_id: inboxId,
        supplied_lease_token: leaseToken,
        supplied_disposition: disposition,
      }),
    async createSignedObjectUrl(claim: VerifierClaim, expiresInSeconds: number): Promise<string> {
      if (!configuration) throw new Error('Claim storage is not configured.');
      storage ??= createClient(configuration.serviceUrl, configuration.secretKey, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { fetch: createSupabaseApiKeyFetch(configuration.secretKey, request.signal) },
      });
      const result = await storage.storage
        .from(claim.objectBucket)
        .createSignedUrl(claim.objectKey, expiresInSeconds);
      if (result.error || !result.data.signedUrl) throw new Error('Object URL signing failed.');
      return result.data.signedUrl;
    },
  });
}
