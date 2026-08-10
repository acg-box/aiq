// oxlint-disable-next-line import/no-unassigned-import -- This marker blocks client bundling.
import 'server-only';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { handleSubmission } from '../../../server/submission-handler.ts';
import {
  createEnqueueRpcArguments,
  type SubmissionObjectIdentity,
  type SubmissionReceipt,
  type ValidatedSubmission,
} from '../../../server/submission-contract.ts';
import { storeExactPrivateStorageObject } from '../../../server/private-storage-object.ts';
import { inspectSubmissionConfiguration } from '../../../server/production-configuration.ts';
import {
  createSupabaseApiKeyFetch,
  VERIFICATION_SUPABASE_HTTP_TIMEOUT_MS,
} from '../../../server/supabase-http.ts';
import { registerStorageObject } from '../../../server/storage-lifecycle-registration.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const configuration = inspectSubmissionConfiguration(process.env).values;
  let client: SupabaseClient | undefined;
  function serviceClient(): SupabaseClient {
    if (!configuration) throw new Error('Submission service is not configured.');
    client ??= createClient(configuration.serviceUrl, configuration.secretKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        fetch: createSupabaseApiKeyFetch(
          configuration.secretKey,
          request.signal,
          globalThis.fetch,
          VERIFICATION_SUPABASE_HTTP_TIMEOUT_MS,
        ),
      },
    });
    return client;
  }
  return handleSubmission(request, {
    configured: configuration !== undefined,
    expectedToken: configuration?.runnerToken ?? '',
    async storePackage(
      rawBytes: Uint8Array,
      receipt: SubmissionReceipt,
    ): Promise<SubmissionObjectIdentity> {
      if (!configuration) {
        throw new Error('Submission service is not configured.');
      }
      const key = `sha256/${receipt.packageSha256}`;
      const bucket = serviceClient().storage.from(configuration.packageBucket);
      const disposition = await storeExactPrivateStorageObject({
        bucket,
        key,
        rawBytes,
        expectedBytes: receipt.bodyBytes,
        expectedDigest: receipt.packageSha256,
        contentType: 'application/json',
        serviceOrigin: configuration.serviceUrl,
        parentSignal: request.signal,
      });
      if (disposition === 'conflict') {
        throw new Error('Stored submission object identity does not match.');
      }
      return {
        bucket: configuration.packageBucket,
        key,
        contentSha256: receipt.packageSha256,
        bytes: receipt.bodyBytes,
      };
    },
    async registerStoredObject(objectIdentity): Promise<void> {
      await registerStorageObject({
        object: {
          objectType: 'submission_package',
          artifactKind: null,
          bucket: objectIdentity.bucket,
          path: objectIdentity.key,
          digest: objectIdentity.contentSha256,
          bytes: objectIdentity.bytes,
        },
        rpc: async (functionName, parameters) => {
          const result = await serviceClient().rpc(functionName, parameters);
          return { data: result.data, error: result.error };
        },
      });
    },
    async enqueue(
      submission: ValidatedSubmission,
      receipt: SubmissionReceipt,
      objectIdentity: SubmissionObjectIdentity,
    ): Promise<unknown> {
      if (!configuration) {
        throw new Error('Submission service is not configured.');
      }
      const result = await serviceClient().rpc(
        'aiq_enqueue_submission',
        createEnqueueRpcArguments(submission, receipt, objectIdentity),
      );
      if (result.error) {
        throw new Error('Submission enqueue failed.');
      }
      return result.data;
    },
    signalOrphan(objectIdentity, receipt, reason): void {
      console.error(
        JSON.stringify({
          event: 'aiq_submission_orphan_reconciliation_required',
          reason,
          bucket: objectIdentity.bucket,
          key: objectIdentity.key,
          package_sha256: receipt.packageSha256,
          body_bytes: receipt.bodyBytes,
        }),
      );
    },
  });
}
