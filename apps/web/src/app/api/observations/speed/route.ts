// oxlint-disable-next-line import/no-unassigned-import -- This marker blocks client bundling.
import 'server-only';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { storeExactPrivateStorageObject } from '../../../../server/private-storage-object.ts';
import { inspectArtifactIngressConfiguration } from '../../../../server/production-configuration.ts';
import {
  handleSpeedObservation,
  type SpeedObservationObjectIdentity,
} from '../../../../server/speed-observation-handler.ts';
import { createSupabaseApiKeyFetch } from '../../../../server/supabase-http.ts';
import { registerStorageObject } from '../../../../server/storage-lifecycle-registration.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const configuration = inspectArtifactIngressConfiguration(process.env).values;
  let client: SupabaseClient | undefined;
  function serviceClient(): SupabaseClient {
    if (!configuration) throw new Error('Speed observation service is not configured.');
    client ??= createClient(configuration.serviceUrl, configuration.secretKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: createSupabaseApiKeyFetch(configuration.secretKey, request.signal) },
    });
    return client;
  }

  return handleSpeedObservation(request, {
    configured: configuration !== undefined,
    expectedToken: configuration?.runnerToken ?? '',
    async storeObservation(observation): Promise<SpeedObservationObjectIdentity> {
      if (!configuration) throw new Error('Speed observation service is not configured.');
      const key = `sha256/${observation.storageSha256}/speed-observation.json`;
      const disposition = await storeExactPrivateStorageObject({
        bucket: serviceClient().storage.from(configuration.artifactBucket),
        key,
        rawBytes: observation.canonicalBytes,
        expectedBytes: observation.canonicalBytes.byteLength,
        expectedDigest: observation.storageSha256,
        contentType: 'application/json',
        serviceOrigin: configuration.serviceUrl,
        parentSignal: request.signal,
      });
      if (disposition === 'conflict') {
        throw new Error('Stored speed observation identity does not match.');
      }
      return {
        bucket: configuration.artifactBucket,
        key,
        digest: observation.storageSha256,
        bytes: observation.canonicalBytes.byteLength,
      };
    },
    async registerStoredObject(identity): Promise<string> {
      return registerStorageObject({
        object: {
          objectType: 'runner_artifact',
          artifactKind: 'speed-observation.json',
          bucket: identity.bucket,
          path: identity.key,
          digest: identity.digest,
          bytes: identity.bytes,
        },
        retentionClass: 'audit_1y',
        rpc: async (functionName, parameters) => {
          const result = await serviceClient().rpc(functionName, parameters);
          return { data: result.data, error: result.error };
        },
      });
    },
    async recordObservation(observation, objectId, identity) {
      const result = await serviceClient().rpc('aiq_record_speed_observation', {
        supplied_batch: observation.batch,
        supplied_object_id: objectId,
        supplied_object_identity: {
          bucket: identity.bucket,
          key: identity.key,
          sha256: identity.digest,
          bytes: identity.bytes,
        },
      });
      const disposition: unknown = result.data;
      if (result.error || (disposition !== 'accepted' && disposition !== 'duplicate')) {
        throw new Error('Speed observation record failed.');
      }
      return disposition;
    },
    signalReconciliation(identity, observation, reason): void {
      console.error(
        JSON.stringify({
          event: 'aiq_speed_observation_reconciliation_required',
          reason,
          batch_id: observation.batchId,
          bucket: identity.bucket,
          key: identity.key,
          sha256: identity.digest,
          bytes: identity.bytes,
        }),
      );
    },
  });
}
