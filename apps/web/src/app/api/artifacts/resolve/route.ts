// oxlint-disable-next-line import/no-unassigned-import -- This marker blocks client bundling.
import 'server-only';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import {
  artifactResolveRpcError,
  ArtifactResolveNotAvailableError,
  ArtifactResolveUpstreamUnavailableError,
  handleArtifactResolve,
  type ResolvedArtifact,
} from '../../../../server/artifact-resolve-handler.ts';
import { createSupabaseRoleTokenIssuer } from '../../../../server/supabase-role-token.ts';
import { verificationRoleClientOptions } from '../../../../server/verification-handler.ts';
import { inspectVerifierClaimConfiguration } from '../../../../server/production-configuration.ts';
import { createSupabaseApiKeyFetch } from '../../../../server/supabase-http.ts';

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
  const issueRoleToken = configuration
    ? createSupabaseRoleTokenIssuer(configuration.privateJwk)
    : null;
  let verifier: RpcClient | undefined;
  let storage: SupabaseClient | undefined;

  function verifierClient(): RpcClient {
    if (!configuration || !issueRoleToken) {
      throw new Error('Artifact resolver is not configured.');
    }
    verifier ??= createClient(
      configuration.serviceUrl,
      configuration.publishableKey,
      verificationRoleClientOptions(() => issueRoleToken({ role: 'aiq_verifier' }), request.signal),
    );
    return verifier;
  }

  return handleArtifactResolve(request, {
    configured: configuration !== undefined,
    expectedToken: configuration?.verifierToken ?? '',
    async resolve(inboxId, leaseToken, kind, digest): Promise<unknown> {
      try {
        const result = await verifierClient().rpc('aiq_resolve_claim_artifact', {
          target_inbox_id: inboxId,
          supplied_lease_token: leaseToken,
          requested_kind: kind,
          requested_sha256: digest,
        });
        if (result.error) throw artifactResolveRpcError(result.error);
        return result.data;
      } catch (error) {
        if (
          error instanceof ArtifactResolveNotAvailableError ||
          error instanceof ArtifactResolveUpstreamUnavailableError
        ) {
          throw error;
        }
        throw new ArtifactResolveUpstreamUnavailableError();
      }
    },
    async createSignedUrl(artifact: ResolvedArtifact, expiresInSeconds: number): Promise<string> {
      if (!configuration) throw new Error('Artifact storage is not configured.');
      storage ??= createClient(configuration.serviceUrl, configuration.secretKey, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { fetch: createSupabaseApiKeyFetch(configuration.secretKey, request.signal) },
      });
      const result = await storage.storage
        .from(artifact.bucket)
        .createSignedUrl(artifact.key, expiresInSeconds);
      if (result.error || !result.data.signedUrl) {
        throw new Error('Artifact URL signing failed.');
      }
      return result.data.signedUrl;
    },
  });
}
