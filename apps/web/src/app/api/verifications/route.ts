// oxlint-disable-next-line import/no-unassigned-import -- This marker blocks client bundling.
import 'server-only';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import {
  handleVerification,
  verificationRpcFailureDiagnostic,
  verificationRoleClientOptions,
} from '../../../server/verification-handler.ts';
import { inspectVerificationConfiguration } from '../../../server/production-configuration.ts';
import { createSupabaseRoleTokenIssuer } from '../../../server/supabase-role-token.ts';
import type {
  ValidatedCalibrationVerification,
  ValidatedVerification,
  VerificationClaim,
  VerifierRejection,
} from '../../../server/verification-contract.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RpcClient {
  rpc(
    functionName: string,
    parameters: Readonly<Record<string, unknown>>,
  ): ReturnType<SupabaseClient['rpc']>;
}

function signalRpcFailure(
  functionName: string,
  error: { code?: string; message?: string } | undefined,
): void {
  console.error(JSON.stringify(verificationRpcFailureDiagnostic(functionName, error)));
}

async function callRpc(
  client: RpcClient,
  functionName: string,
  parameters: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  let result: Awaited<ReturnType<RpcClient['rpc']>>;
  try {
    result = await client.rpc(functionName, parameters);
  } catch {
    signalRpcFailure(functionName, undefined);
    throw new Error('Verification RPC failed.');
  }
  if (result.error) {
    signalRpcFailure(functionName, result.error);
    throw new Error('Verification RPC failed.');
  }
  return result.data;
}

export async function POST(request: Request): Promise<Response> {
  const configuration = inspectVerificationConfiguration(process.env).values;
  let verifier: RpcClient | undefined;
  let publisher: RpcClient | undefined;
  const issueRoleToken = configuration
    ? createSupabaseRoleTokenIssuer(configuration.privateJwk)
    : undefined;
  function verifierClient(): RpcClient {
    if (!configuration || !issueRoleToken) {
      throw new Error('Verification service is not configured.');
    }
    verifier ??= createClient(
      configuration.serviceUrl,
      configuration.publishableKey,
      verificationRoleClientOptions(() => issueRoleToken({ role: 'aiq_verifier' }), request.signal),
    );
    return verifier;
  }
  function publisherClient(): RpcClient {
    if (!configuration || !issueRoleToken) {
      throw new Error('Verification service is not configured.');
    }
    publisher ??= createClient(
      configuration.serviceUrl,
      configuration.publishableKey,
      verificationRoleClientOptions(
        () =>
          issueRoleToken({
            role: 'aiq_publisher',
            publisherNodeId: configuration.publisherNodeId,
          }),
        request.signal,
      ),
    );
    return publisher;
  }
  return handleVerification(request, {
    configured: configuration !== undefined,
    expectedToken: configuration?.verifierToken ?? '',
    async stage(verification: ValidatedVerification): Promise<unknown> {
      return callRpc(verifierClient(), 'aiq_stage_verifier_result', {
        stage: verification.stage,
        target_inbox_id: verification.claim.inbox_id,
        supplied_lease_token: verification.claim.lease_token,
        supplied_attempt: verification.claim.attempt,
      });
    },
    async recordAttestation(verification: ValidatedVerification): Promise<void> {
      await callRpc(verifierClient(), 'aiq_record_verifier_attestation', {
        target_run_id: verification.stage.matrix_batch_id,
        target_package_sha256: verification.stage.package_sha256,
        attestation: verification.attestation,
        target_inbox_id: verification.claim.inbox_id,
        supplied_lease_token: verification.claim.lease_token,
        supplied_attempt: verification.claim.attempt,
      });
    },
    async publish(verification: ValidatedVerification): Promise<void> {
      await callRpc(publisherClient(), 'aiq_verify_and_publish', {
        target_run_id: verification.stage.matrix_batch_id,
        target_package_sha256: verification.stage.package_sha256,
        target_inbox_id: verification.claim.inbox_id,
        supplied_lease_token: verification.claim.lease_token,
        supplied_attempt: verification.claim.attempt,
      });
    },
    async stageCalibration(verification: ValidatedCalibrationVerification): Promise<unknown> {
      return callRpc(verifierClient(), 'aiq_stage_calibration_verification', {
        stage: verification.stage,
        target_inbox_id: verification.claim.inbox_id,
        supplied_lease_token: verification.claim.lease_token,
        supplied_attempt: verification.claim.attempt,
      });
    },
    async recordCalibrationAttestation(
      verification: ValidatedCalibrationVerification,
    ): Promise<unknown> {
      return callRpc(verifierClient(), 'aiq_record_calibration_attestation', {
        attestation: verification.attestation,
        target_inbox_id: verification.claim.inbox_id,
        supplied_lease_token: verification.claim.lease_token,
        supplied_attempt: verification.claim.attempt,
      });
    },
    async publishCalibration(verification: ValidatedCalibrationVerification): Promise<unknown> {
      return callRpc(publisherClient(), 'aiq_publish_calibration_evidence', {
        target_run_id: verification.stage.run_id,
        target_package_sha256: verification.stage.package_sha256,
        target_inbox_id: verification.claim.inbox_id,
        supplied_lease_token: verification.claim.lease_token,
        supplied_attempt: verification.claim.attempt,
      });
    },
    async reject(claim: VerificationClaim, rejection: VerifierRejection): Promise<void> {
      await callRpc(verifierClient(), 'aiq_record_verification_rejection', {
        target_run_id: rejection.matrix_batch_id,
        target_package_sha256: rejection.package_sha256,
        rejection,
        target_inbox_id: claim.inbox_id,
        supplied_lease_token: claim.lease_token,
        supplied_attempt: claim.attempt,
      });
    },
  });
}
