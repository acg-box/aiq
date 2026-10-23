import { readBoundedBody } from './bounded-body.ts';
import { createClient } from '@supabase/supabase-js';
import {
  AIQ_CORE_EVALUATOR_IDENTITY,
  AIQ_CORE_TASK_METADATA_IDENTITY,
  AIQ_CORE_TASK_SET_IDENTITY,
} from '../aiq-core-contract.ts';
import { PUBLIC_VIEW_NAMES } from '../data/public-views.ts';
import {
  inspectProductionConfiguration,
  type ValidatedProductionConfiguration,
} from './production-configuration.ts';
import { createSupabaseRoleTokenIssuer, type SupabaseGatewayRole } from './supabase-role-token.ts';
import { createBoundedSupabaseFetch, createSupabaseApiKeyFetch } from './supabase-http.ts';
import {
  isRecord,
  isUnknownArray,
  REQUIRED_RPC_CONTRACT,
  PUBLIC_VIEW_PROBES,
} from './readiness-contract.ts';

export type ReadinessState =
  | 'local_synthetic'
  | 'local_dependencies_ready'
  | 'configuration_error'
  | 'bounded_dependency_probe_passed'
  | 'dependencies_unavailable';

export type ProductionDependencyProbe = (
  configuration: ValidatedProductionConfiguration & {
    signal: AbortSignal;
    requireProductionReference: boolean;
  },
) => Promise<void>;

type DependencyName =
  | 'public_reads'
  | 'storage_buckets'
  | 'role_scoped_rpc_contract'
  | 'production_reference'
  | 'verifier_rpc'
  | 'publisher_rpc';

class DependencyProbeError extends Error {
  readonly dependency: DependencyName;

  constructor(dependency: DependencyName) {
    super(`${dependency} probe failed`);
    this.dependency = dependency;
  }
}

async function fetchJson(
  url: string,
  headers: Readonly<Record<string, string>>,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await createBoundedSupabaseFetch(signal)(url, {
    headers,
    method: 'GET',
    cache: 'no-store',
  });
  if (!response.ok) throw new Error('dependency request failed');
  return readBoundedJson(response, 2_000_000);
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const contentLengthHeader = response.headers.get('content-length');
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);
    if (
      !/^(0|[1-9][0-9]*)(?![\s\S])/.test(contentLengthHeader) ||
      !Number.isSafeInteger(contentLength) ||
      contentLength > maxBytes
    ) {
      await response.body?.cancel();
      throw new Error('dependency response has an invalid byte bound');
    }
  }
  if (!response.body) throw new Error('dependency response body is unavailable');
  const bytes = await readBoundedBody(response.body, maxBytes);
  if (!bytes) throw new Error('dependency response exceeded the bound');
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function isTrendPoint(candidate: unknown): boolean {
  return (
    isRecord(candidate) &&
    typeof candidate.matrix_id === 'string' &&
    typeof candidate.run_id === 'string' &&
    typeof candidate.scoring_version === 'string' &&
    typeof candidate.recorded_at === 'string' &&
    typeof candidate.bucket_started_at === 'string' &&
    typeof candidate.bucket_ended_at === 'string' &&
    typeof candidate.score === 'number' &&
    typeof candidate.sensitivity_low === 'number' &&
    typeof candidate.sensitivity_high === 'number' &&
    typeof candidate.sample_size === 'number' &&
    typeof candidate.represented_run_count === 'number' &&
    typeof candidate.resolution_seconds === 'number' &&
    typeof candidate.synthetic === 'boolean'
  );
}

async function probePublicTrendPoints(
  publicUrl: string,
  publicPublishableKey: string,
  signal: AbortSignal,
): Promise<void> {
  const response = await createBoundedSupabaseFetch(signal)(
    `${publicUrl}/rest/v1/rpc/public_trend_points`,
    {
      method: 'POST',
      headers: {
        apikey: publicPublishableKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ supplied_range: 'day' }),
    },
  );
  if (!response.ok) throw new Error('public trend points are unavailable');
  const document: unknown = await readBoundedJson(response, 512_000);
  if (!Array.isArray(document) || document.length > 340 || !document.every(isTrendPoint)) {
    throw new Error('public trend points are unavailable');
  }
}

async function probeGatewayRole(
  serviceUrl: string,
  publishableKey: string,
  token: string,
  expectedRole: SupabaseGatewayRole,
  signal: AbortSignal,
): Promise<void> {
  const response = await createBoundedSupabaseFetch(signal)(
    `${serviceUrl}/rest/v1/rpc/aiq_gateway_role_probe`,
    {
      method: 'POST',
      headers: {
        apikey: publishableKey,
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: '{}',
    },
  );
  if (!response.ok) throw new Error('gateway role is unavailable');
  const document: unknown = await readBoundedJson(response, 1_024);
  if (document !== expectedRole) throw new Error('gateway role is unavailable');
}

async function probeRpcContract(
  serviceUrl: string,
  secretKey: string,
  signal: AbortSignal,
): Promise<void> {
  const response = await createBoundedSupabaseFetch(signal)(
    `${serviceUrl}/rest/v1/rpc/aiq_describe_web_rpc_contract`,
    {
      method: 'POST',
      headers: {
        apikey: secretKey,
        'content-type': 'application/json',
      },
      body: '{}',
    },
  );
  if (!response.ok) throw new Error('RPC contract is unavailable');
  const document: unknown = await readBoundedJson(response, 64_000);
  if (!Array.isArray(document)) throw new Error('RPC contract is unavailable');
  const contracts = new Map(
    document.flatMap((candidate) =>
      isRecord(candidate) && typeof candidate.name === 'string'
        ? [[candidate.name, candidate] as const]
        : [],
    ),
  );
  if (contracts.size !== Object.keys(REQUIRED_RPC_CONTRACT).length) {
    throw new Error('required RPC contract is unavailable');
  }
  for (const [name, expected] of Object.entries(REQUIRED_RPC_CONTRACT)) {
    const actual = contracts.get(name);
    const actualRoles =
      actual && isRecord(actual.executable_roles) ? actual.executable_roles : undefined;
    if (
      !actual ||
      actual.arguments !== expected.arguments ||
      actual.result !== expected.result ||
      actual.default_count !== expected.defaultCount ||
      !isUnknownArray(actual.argument_modes) ||
      JSON.stringify(actual.argument_modes) !== JSON.stringify(expected.modes) ||
      !actualRoles ||
      Object.entries(expected.grants).some(([role, granted]) => actualRoles[role] !== granted) ||
      Object.keys(actualRoles).length !== Object.keys(expected.grants).length
    ) {
      throw new Error('required RPC contract is unavailable');
    }
  }
}

const EXPECTED_DOMAIN_COUNTS = {
  coding: 8,
  debugging: 8,
  repository_understanding: 7,
  data_processing: 8,
  retrieval_verification: 7,
  documentation_communication: 7,
  planning_execution: 7,
  tool_use: 7,
  instruction_following: 6,
  reliability_recovery: 7,
} as const;

const EXPECTED_CATALOG_IDENTITY = AIQ_CORE_TASK_METADATA_IDENTITY;

async function probeProductionReference(
  serviceUrl: string,
  secretKey: string,
  publisherNodeId: string,
  signal: AbortSignal,
): Promise<void> {
  const response = await createBoundedSupabaseFetch(signal)(
    `${serviceUrl}/rest/v1/rpc/aiq_production_reference_status`,
    {
      method: 'POST',
      headers: {
        apikey: secretKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ expected_publisher_node_id: publisherNodeId }),
    },
  );
  if (!response.ok) throw new Error('production reference status is unavailable');
  const document: unknown = await readBoundedJson(response, 64_000);
  const domainCounts =
    isRecord(document) && isRecord(document.domain_counts) ? document.domain_counts : undefined;
  if (
    !isRecord(document) ||
    Object.keys(document).length !== 24 ||
    document.initialized !== true ||
    document.model_config_count !== 17 ||
    document.model_config_mismatch_count !== 0 ||
    document.scoring_version_count !== 1 ||
    document.scoring_version_valid !== true ||
    document.task_count !== 72 ||
    document.distinct_task_count !== 72 ||
    !domainCounts ||
    Object.keys(domainCounts).length !== 10 ||
    Object.entries(EXPECTED_DOMAIN_COUNTS).some(
      ([domain, count]) => domainCounts[domain] !== count,
    ) ||
    document.catalog_identity_sha256 !== EXPECTED_CATALOG_IDENTITY ||
    document.frozen_catalog_valid !== true ||
    document.task_set_identity_sha256 !== AIQ_CORE_TASK_SET_IDENTITY ||
    document.task_set_identity_valid !== true ||
    document.evaluator_identity_sha256 !== AIQ_CORE_EVALUATOR_IDENTITY ||
    document.evaluator_identity_valid !== true ||
    document.production_node_count !== 3 ||
    document.distinct_production_node_count !== 3 ||
    document.runner_count !== 1 ||
    document.verifier_count !== 1 ||
    document.publisher_count !== 1 ||
    document.private_table_count !== 42 ||
    document.forced_rls_table_count !== 42 ||
    document.public_view_count !== 13 ||
    document.security_invoker_view_count !== 13 ||
    document.hardened_gateway_role_count !== 2
  ) {
    throw new Error('production reference status is invalid');
  }
}

async function identifyDependency(
  dependency: DependencyName,
  operation: Promise<unknown>,
): Promise<void> {
  try {
    await operation;
  } catch {
    throw new DependencyProbeError(dependency);
  }
}

export const probeProductionDependencies: ProductionDependencyProbe = async ({
  publicUrl,
  publicPublishableKey,
  serviceUrl,
  secretKey,
  publishableKey,
  privateJwk,
  publisherNodeId,
  packageBucket,
  artifactBucket,
  requireProductionReference,
  signal,
}) => {
  const publicClient = createClient(publicUrl, publicPublishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: createSupabaseApiKeyFetch(publicPublishableKey, signal) },
  });
  const publicViews = Object.values(PUBLIC_VIEW_NAMES).map(async (view) => {
    const probe = PUBLIC_VIEW_PROBES[view];
    const result = await publicClient
      .from(view)
      .select(probe.columns)
      .limit(1)
      .abortSignal(signal)
      .overrideTypes<unknown[], { merge: false }>();
    if (
      result.error ||
      !Array.isArray(result.data) ||
      result.data.length > 1 ||
      (result.data[0] !== undefined && !probe.isRow(result.data[0]))
    ) {
      throw new Error('public view is unavailable');
    }
  });
  const issueRoleToken = createSupabaseRoleTokenIssuer(privateJwk);
  const publicReadProbe = Promise.all([
    ...publicViews,
    probePublicTrendPoints(publicUrl, publicPublishableKey, signal),
  ]);
  const verifierRoleProbe = probeGatewayRole(
    serviceUrl,
    publishableKey,
    issueRoleToken({ role: 'aiq_verifier' }),
    'aiq_verifier',
    signal,
  );
  const publisherRoleProbe = probeGatewayRole(
    serviceUrl,
    publishableKey,
    issueRoleToken({ role: 'aiq_publisher', publisherNodeId }),
    'aiq_publisher',
    signal,
  );

  const bucketProbe = (async () => {
    const candidate = await fetchJson(
      `${serviceUrl}/storage/v1/bucket`,
      { apikey: secretKey },
      signal,
    );
    if (!Array.isArray(candidate)) throw new Error('Storage bucket inventory is unavailable');
    const buckets = new Map(
      candidate.flatMap((bucket) =>
        isRecord(bucket) &&
        'name' in bucket &&
        typeof bucket.name === 'string' &&
        'public' in bucket &&
        typeof bucket.public === 'boolean'
          ? [[bucket.name, bucket.public] as const]
          : [],
      ),
    );
    if (buckets.get(packageBucket) !== false || buckets.get(artifactBucket) !== false) {
      throw new Error('required Storage bucket is unavailable');
    }
  })();

  await Promise.all([
    identifyDependency('public_reads', publicReadProbe),
    identifyDependency('storage_buckets', bucketProbe),
    identifyDependency('role_scoped_rpc_contract', probeRpcContract(serviceUrl, secretKey, signal)),
    identifyDependency('verifier_rpc', verifierRoleProbe),
    identifyDependency('publisher_rpc', publisherRoleProbe),
    ...(requireProductionReference
      ? [
          identifyDependency(
            'production_reference',
            probeProductionReference(serviceUrl, secretKey, publisherNodeId, signal),
          ),
        ]
      : []),
  ]);
};

const SCOPE = [
  'runtime_mode',
  'configuration_contract',
  'public_read_views',
  'public_trend_points_rpc',
  'private_storage_buckets',
  'role_scoped_rpc_contract',
  'gateway_role_credentials',
  'production_reference_initialization',
] as const;

function json(body: Readonly<Record<string, unknown>>, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store, max-age=0' },
  });
}

function isLocalLoopbackConfiguration(configuration: ValidatedProductionConfiguration): boolean {
  const publicUrl = new URL(configuration.publicUrl);
  const serviceUrl = new URL(configuration.serviceUrl);
  return (
    publicUrl.protocol === 'http:' &&
    (publicUrl.hostname === 'localhost' || publicUrl.hostname === '127.0.0.1') &&
    publicUrl.origin === serviceUrl.origin
  );
}

export function createReadinessHandler({
  environment = process.env,
  probe = probeProductionDependencies,
  timeoutMs = 2_000,
}: {
  environment?: Readonly<Record<string, string | undefined>>;
  probe?: ProductionDependencyProbe;
  timeoutMs?: number;
} = {}): () => Promise<Response> {
  return async () => {
    const configuration = inspectProductionConfiguration(environment);
    const hasPublicConfiguration = Boolean(
      environment.NEXT_PUBLIC_SUPABASE_URL?.trim() ||
      environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim(),
    );
    if (configuration.mode === 'non_production' && !hasPublicConfiguration) {
      return json({
        state: 'local_synthetic' satisfies ReadinessState,
        scope_ready: true,
        mode: 'local_synthetic',
        checks: {
          runtime_mode: 'non_production',
          configuration: 'synthetic_not_applicable',
          dependencies: 'not_run',
        },
        scope: SCOPE,
      });
    }

    if (!configuration.values) {
      return json(
        {
          state: 'configuration_error' satisfies ReadinessState,
          scope_ready: false,
          mode: configuration.mode,
          checks: {
            runtime_mode: configuration.mode,
            configuration: 'invalid',
            dependencies: 'not_run',
          },
          issues: configuration.issues,
          scope: SCOPE,
        },
        503,
      );
    }

    if (
      configuration.mode === 'non_production' &&
      !isLocalLoopbackConfiguration(configuration.values)
    ) {
      return json(
        {
          state: 'configuration_error' satisfies ReadinessState,
          scope_ready: false,
          mode: configuration.mode,
          checks: {
            runtime_mode: configuration.mode,
            configuration: 'invalid',
            dependencies: 'not_run',
          },
          issues: [
            'Local dependency readiness requires one canonical loopback HTTP Supabase origin',
          ],
          scope: SCOPE,
        },
        503,
      );
    }

    const controller = new AbortController();
    let rejectTimeout: ((reason: Error) => void) | undefined;
    const timeoutFailure = new Promise<never>((_resolve, reject) => {
      rejectTimeout = reject;
    });
    const timeout = setTimeout(() => {
      controller.abort();
      rejectTimeout?.(new Error('readiness dependency probe timed out'));
    }, timeoutMs);
    try {
      await Promise.race([
        probe({
          ...configuration.values,
          signal: controller.signal,
          requireProductionReference: configuration.mode === 'production',
        }),
        timeoutFailure,
      ]);
      const state =
        configuration.mode === 'production'
          ? ('bounded_dependency_probe_passed' satisfies ReadinessState)
          : ('local_dependencies_ready' satisfies ReadinessState);
      return json({
        state,
        scope_ready: true,
        mode: configuration.mode,
        checks: {
          runtime_mode: configuration.mode,
          configuration: 'valid',
          dependencies: 'available',
        },
        scope: SCOPE,
      });
    } catch (error) {
      const failedDependency =
        error instanceof DependencyProbeError
          ? error.dependency
          : controller.signal.aborted
            ? 'timeout'
            : 'unknown';
      return json(
        {
          state: 'dependencies_unavailable' satisfies ReadinessState,
          scope_ready: false,
          mode: configuration.mode,
          checks: {
            runtime_mode: configuration.mode,
            configuration: 'valid',
            dependencies: 'unavailable',
          },
          failed_dependency: failedDependency,
          issues: ['A required Supabase dependency is unavailable or the probe timed out'],
          scope: SCOPE,
        },
        503,
      );
    } finally {
      controller.abort();
      clearTimeout(timeout);
    }
  };
}
