// oxlint-disable-next-line import/no-unassigned-import -- This marker blocks client bundling.
import 'server-only';

import { createClient } from '@supabase/supabase-js';

import {
  handleArtifactUpload,
  type ArtifactObjectIdentity,
  type ArtifactReceipt,
} from '../../../server/artifact-handler.ts';
import { storeExactPrivateStorageObject } from '../../../server/private-storage-object.ts';
import { inspectArtifactIngressConfiguration } from '../../../server/production-configuration.ts';
import { createSupabaseApiKeyFetch } from '../../../server/supabase-http.ts';
import { registerStorageObject } from '../../../server/storage-lifecycle-registration.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const configuration = inspectArtifactIngressConfiguration(process.env).values;
  const client = configuration
    ? createClient(configuration.serviceUrl, configuration.secretKey, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { fetch: createSupabaseApiKeyFetch(configuration.secretKey, request.signal) },
      })
    : null;

  return handleArtifactUpload(request, {
    configured: configuration !== undefined,
    expectedToken: configuration?.runnerToken ?? '',
    async storeArtifact(rawBytes: Uint8Array, receipt: ArtifactReceipt) {
      if (!client || !configuration) {
        throw new Error('Artifact service is not configured.');
      }
      const key = `sha256/${receipt.digest}/${receipt.kind}`;
      const identity: ArtifactObjectIdentity = {
        ...receipt,
        bucket: configuration.artifactBucket,
        key,
      };
      const bucket = client.storage.from(configuration.artifactBucket);
      const disposition = await storeExactPrivateStorageObject({
        bucket,
        key,
        rawBytes,
        expectedBytes: receipt.bytes,
        expectedDigest: receipt.digest,
        contentType: 'application/octet-stream',
        serviceOrigin: configuration.serviceUrl,
        parentSignal: request.signal,
      });
      return { disposition, identity };
    },
    async registerStoredObject(identity): Promise<void> {
      if (!client) throw new Error('Artifact service is not configured.');
      await registerStorageObject({
        object: {
          objectType: 'runner_artifact',
          artifactKind: identity.kind,
          bucket: identity.bucket,
          path: identity.key,
          digest: identity.digest,
          bytes: identity.bytes,
        },
        rpc: async (functionName, parameters) => {
          const result = await client.rpc(functionName, parameters);
          return { data: result.data, error: result.error };
        },
      });
    },
    async recordArtifact(identity: ArtifactObjectIdentity) {
      if (!client) throw new Error('Artifact service is not configured.');
      const result = await client.rpc('aiq_record_artifact_ingress', {
        target_run_id: identity.runId,
        supplied_kind: identity.kind,
        supplied_sha256: identity.digest,
        supplied_byte_size: identity.bytes,
        object_identity: {
          bucket: identity.bucket,
          key: identity.key,
        },
      });
      if (result.error || (result.data !== 'accepted' && result.data !== 'duplicate')) {
        throw new Error('Artifact metadata recording failed.');
      }
      return result.data === 'accepted' ? 'accepted' : 'duplicate';
    },
    signalReconciliation(identity, reason): void {
      console.error(
        JSON.stringify({
          event: 'aiq_artifact_reconciliation_required',
          reason,
          run_id: identity.runId,
          artifact_kind: identity.kind,
          bucket: identity.bucket,
          key: identity.key,
          content_sha256: identity.digest,
          byte_size: identity.bytes,
        }),
      );
    },
  });
}
