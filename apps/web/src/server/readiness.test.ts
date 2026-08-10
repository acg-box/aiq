import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  createReadinessHandler,
  inspectProductionConfiguration,
  probeProductionDependencies,
  REQUIRED_RPC_CONTRACT,
  PUBLIC_VIEW_SELECTS,
  type ProductionDependencyProbe,
} from './readiness.ts';
import { AIQ_CORE_EVALUATOR_IDENTITY, AIQ_CORE_TASK_SET_IDENTITY } from '../aiq-core-contract.ts';
import { FROZEN_CATALOG_DIGEST } from './run-provenance.ts';

const privateJwk = {
  ...generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({
    format: 'jwk',
  }),
  alg: 'ES256',
  kid: 'readiness-test-key',
};

const validEnvironment = {
  NODE_ENV: 'production',
  NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_public_example',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SECRET_KEY: 'sb_secret_service_example',
  AIQ_RUNNER_SUBMISSION_TOKEN: 'runner-secret-value',
  AIQ_SUBMISSION_PACKAGE_BUCKET: 'aiq-submission-packages',
  AIQ_RUNNER_ARTIFACT_BUCKET: 'aiq-runner-artifacts',
  AIQ_VERIFIER_INGRESS_TOKEN: 'verifier-secret-value',
  AIQ_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_gateway_example',
  AIQ_SUPABASE_JWT_PRIVATE_JWK: JSON.stringify(privateJwk),
  AIQ_PUBLISHER_NODE_ID: `node_${'a'.repeat(64)}`,
} as const;

const validLocalEnvironment = {
  ...validEnvironment,
  NODE_ENV: 'test',
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_URL: 'http://127.0.0.1:54321',
  AIQ_SUPABASE_PUBLISHABLE_KEY: validEnvironment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
} as const;

const successfulProbe: ProductionDependencyProbe = async ({ signal }) => {
  assert.equal(signal.aborted, false);
};

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null;
}

function encodeJson(value: Readonly<Record<string, unknown>>): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

type RpcResponseKind = 'contract' | 'reference' | 'trend' | 'verifier' | 'publisher';

function isPublicViewName(value: string): value is keyof typeof PUBLIC_VIEW_SELECTS {
  return Object.hasOwn(PUBLIC_VIEW_SELECTS, value);
}

function roleTokenPayload(request: Request): Record<string, unknown> {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) {
    assert.fail('gateway role probe must use a bearer token');
  }
  const segments = authorization.slice('Bearer '.length).split('.');
  assert.equal(segments.length, 3);
  const [encodedHeader, encodedPayload, encodedSignature] = segments;
  assert.ok(encodedHeader);
  assert.ok(encodedPayload);
  assert.ok(encodedSignature);
  const header: unknown = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'));
  assert.deepEqual(header, { alg: 'ES256', kid: 'readiness-test-key', typ: 'JWT' });
  const payload: unknown = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  assert.ok(isRecord(payload));
  return payload;
}

async function withDependencyFetch(
  mutateContracts?: (contracts: Record<string, unknown>[]) => void,
  mutateBuckets?: (buckets: Array<{ name: string; public: boolean }>) => void,
  mutateReference?: (reference: Record<string, unknown>) => void,
  replaceRpcResponse?: (kind: RpcResponseKind, document: unknown) => Response | undefined,
  replaceViewResponse?: (view: keyof typeof PUBLIC_VIEW_SELECTS) => Response | undefined,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const seenViews = new Set<string>();
  const seenGatewayRoles = new Set<string>();
  let trendProbeCount = 0;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname.startsWith('/rest/v1/public_')) {
      const view = url.pathname.slice('/rest/v1/'.length);
      assert.ok(isPublicViewName(view));
      seenViews.add(view);
      assert.equal(url.searchParams.get('select'), PUBLIC_VIEW_SELECTS[view]);
      assert.equal(url.searchParams.get('limit'), '1');
      assert.equal(
        request.headers.get('apikey'),
        validEnvironment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
      );
      assert.equal(request.headers.get('authorization'), null);
      return replaceViewResponse?.(view) ?? Response.json([]);
    }
    if (url.pathname === '/storage/v1/bucket') {
      assert.equal(request.headers.get('apikey'), validEnvironment.SUPABASE_SECRET_KEY);
      assert.equal(request.headers.get('authorization'), null);
      const buckets = [
        { name: 'aiq-submission-packages', public: false },
        { name: 'aiq-runner-artifacts', public: false },
      ];
      mutateBuckets?.(buckets);
      return Response.json(buckets);
    }
    if (url.pathname === '/rest/v1/rpc/public_trend_points') {
      trendProbeCount += 1;
      assert.equal(request.method, 'POST');
      assert.equal(
        request.headers.get('apikey'),
        validEnvironment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
      );
      assert.equal(request.headers.get('authorization'), null);
      assert.deepEqual(await request.json(), { supplied_range: 'day' });
      const points: unknown[] = [];
      return replaceRpcResponse?.('trend', points) ?? Response.json(points);
    }
    if (url.pathname === '/rest/v1/rpc/aiq_describe_web_rpc_contract') {
      assert.equal(request.method, 'POST');
      assert.equal(request.headers.get('apikey'), validEnvironment.SUPABASE_SECRET_KEY);
      assert.equal(request.headers.get('authorization'), null);
      const contracts = Object.entries(REQUIRED_RPC_CONTRACT).map(([name, contract]) => ({
        name,
        arguments: contract.arguments,
        result: contract.result,
        default_count: contract.defaultCount,
        argument_modes: [...contract.modes],
        executable_roles: { ...contract.grants },
      }));
      mutateContracts?.(contracts);
      return replaceRpcResponse?.('contract', contracts) ?? Response.json(contracts);
    }
    if (url.pathname === '/rest/v1/rpc/aiq_production_reference_status') {
      assert.equal(request.method, 'POST');
      assert.equal(request.headers.get('apikey'), validEnvironment.SUPABASE_SECRET_KEY);
      assert.equal(request.headers.get('authorization'), null);
      assert.deepEqual(await request.json(), {
        expected_publisher_node_id: validEnvironment.AIQ_PUBLISHER_NODE_ID,
      });
      const reference: Record<string, unknown> = {
        initialized: true,
        model_config_count: 17,
        model_config_mismatch_count: 0,
        scoring_version_count: 1,
        scoring_version_valid: true,
        task_count: 72,
        distinct_task_count: 72,
        domain_counts: {
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
        },
        catalog_identity_sha256: FROZEN_CATALOG_DIGEST,
        frozen_catalog_valid: true,
        task_set_identity_sha256: AIQ_CORE_TASK_SET_IDENTITY,
        task_set_identity_valid: true,
        evaluator_identity_sha256: AIQ_CORE_EVALUATOR_IDENTITY,
        evaluator_identity_valid: true,
        production_node_count: 3,
        distinct_production_node_count: 3,
        runner_count: 1,
        verifier_count: 1,
        publisher_count: 1,
        private_table_count: 42,
        forced_rls_table_count: 42,
        public_view_count: 13,
        security_invoker_view_count: 13,
        hardened_gateway_role_count: 2,
      };
      assert.equal(Object.keys(reference).length, 24);
      mutateReference?.(reference);
      return replaceRpcResponse?.('reference', reference) ?? Response.json(reference);
    }
    if (url.pathname === '/rest/v1/rpc/aiq_gateway_role_probe') {
      assert.equal(request.method, 'POST');
      assert.equal(request.headers.get('apikey'), validEnvironment.AIQ_SUPABASE_PUBLISHABLE_KEY);
      assert.deepEqual(await request.json(), {});
      const payload = roleTokenPayload(request);
      const role = payload.role;
      assert.ok(role === 'aiq_verifier' || role === 'aiq_publisher');
      if (role === 'aiq_publisher') {
        assert.equal(payload.aiq_publisher_node_id, validEnvironment.AIQ_PUBLISHER_NODE_ID);
      } else {
        assert.equal('aiq_publisher_node_id' in payload, false);
      }
      seenGatewayRoles.add(role);
      const kind = role === 'aiq_verifier' ? 'verifier' : 'publisher';
      return replaceRpcResponse?.(kind, role) ?? Response.json(role);
    }
    return new Response(null, { status: 404 });
  };
  try {
    const configuration = inspectProductionConfiguration(validEnvironment);
    assert.ok(configuration.values);
    await probeProductionDependencies({
      ...configuration.values,
      signal: new AbortController().signal,
      requireProductionReference: true,
    });
    assert.deepEqual(
      seenViews,
      new Set([
        'public_model_matrix',
        'public_leaderboard',
        'public_runs',
        'public_run_results',
        'public_nodes',
        'public_distributed_radar',
        'public_scoring_versions',
        'public_task_coverage',
        'public_calibration_runs',
        'public_calibration_results',
        'public_calibration_scores',
        'public_model_efficiency',
        'public_speed_observations',
      ]),
    );
    assert.equal(trendProbeCount, 1);
    assert.deepEqual(seenGatewayRoles, new Set(['aiq_verifier', 'aiq_publisher']));
  } finally {
    globalThis.fetch = originalFetch;
  }
}

void describe('bounded readiness probe', () => {
  void it('preserves explicit non-production local synthetic readiness', async () => {
    const response = await createReadinessHandler({
      environment: { NODE_ENV: 'development' },
    })();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0');
    assert.deepEqual(await response.json(), {
      state: 'local_synthetic',
      scope_ready: true,
      mode: 'local_synthetic',
      checks: {
        runtime_mode: 'non_production',
        configuration: 'synthetic_not_applicable',
        dependencies: 'not_run',
      },
      scope: [
        'runtime_mode',
        'configuration_contract',
        'public_read_views',
        'public_trend_points_rpc',
        'private_storage_buckets',
        'role_scoped_rpc_contract',
        'gateway_role_credentials',
        'production_reference_initialization',
      ],
    });
  });

  for (const nodeEnvironment of ['development', 'test']) {
    void it(`never reports production readiness in ${nodeEnvironment} with complete configuration`, async () => {
      let probed = false;
      const response = await createReadinessHandler({
        environment: { ...validEnvironment, NODE_ENV: nodeEnvironment },
        probe: async () => {
          probed = true;
        },
      })();
      const body: unknown = await response.json();
      assert.ok(isRecord(body));
      assert.equal(response.status, 503);
      assert.equal(body.state, 'configuration_error');
      assert.equal(body.scope_ready, false);
      assert.equal(body.mode, 'non_production');
      assert.equal(probed, false);
    });
  }

  void it('reports configured loopback dependencies ready without claiming production', async () => {
    let probed = false;
    const response = await createReadinessHandler({
      environment: validLocalEnvironment,
      probe: async () => {
        probed = true;
      },
    })();
    assert.equal(response.status, 200);
    assert.equal(probed, true);
    assert.deepEqual(await response.json(), {
      state: 'local_dependencies_ready',
      scope_ready: true,
      mode: 'non_production',
      checks: {
        runtime_mode: 'non_production',
        configuration: 'valid',
        dependencies: 'available',
      },
      scope: [
        'runtime_mode',
        'configuration_contract',
        'public_read_views',
        'public_trend_points_rpc',
        'private_storage_buckets',
        'role_scoped_rpc_contract',
        'gateway_role_credentials',
        'production_reference_initialization',
      ],
    });
  });

  void it('fails closed when configured loopback dependencies are unavailable', async () => {
    const response = await createReadinessHandler({
      environment: { ...validLocalEnvironment, NODE_ENV: 'development' },
      probe: async () => {
        throw new Error('local dependency detail');
      },
    })();
    const body: unknown = await response.json();
    assert.equal(response.status, 503);
    assert.ok(isRecord(body));
    assert.equal(body.state, 'dependencies_unavailable');
    assert.equal(body.scope_ready, false);
    assert.equal(body.mode, 'non_production');
    assert.deepEqual(body.checks, {
      runtime_mode: 'non_production',
      configuration: 'valid',
      dependencies: 'unavailable',
    });
  });

  void it('fails closed without probing an incomplete non-production configuration', async () => {
    let probed = false;
    const response = await createReadinessHandler({
      environment: {
        NODE_ENV: 'test',
        NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
      },
      probe: async () => {
        probed = true;
      },
    })();
    const body: unknown = await response.json();
    assert.equal(response.status, 503);
    assert.ok(isRecord(body));
    assert.equal(body.state, 'configuration_error');
    assert.equal(body.scope_ready, false);
    assert.equal(body.mode, 'non_production');
    assert.equal(probed, false);
  });

  void it('fails closed when runtime intent is not explicit', async () => {
    const response = await createReadinessHandler({ environment: {} })();
    assert.equal(response.status, 503);
    const body: unknown = await response.json();
    assert.ok(isRecord(body));
    assert.equal(body.state, 'configuration_error');
  });

  for (const missing of Object.keys(validEnvironment).filter((name) => name !== 'NODE_ENV')) {
    void it(`reports production configuration failure when ${missing} is missing`, async () => {
      const environment: Record<string, string | undefined> = { ...validEnvironment };
      delete environment[missing];
      let probed = false;
      const response = await createReadinessHandler({
        environment,
        probe: async () => {
          probed = true;
        },
      })();
      const body = await response.text();
      assert.equal(response.status, 503);
      assert.equal(probed, false);
      assert.match(body, /"state":"configuration_error"/);
      assert.match(body, new RegExp(`${missing} is missing`));
    });
  }

  void it('rejects malformed and mismatched public configuration', () => {
    const malformed = inspectProductionConfiguration({
      ...validEnvironment,
      NEXT_PUBLIC_SUPABASE_URL: 'http://public.example.com/path?secret=value',
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'not-a-public-key',
    });
    assert.equal(malformed.values, undefined);
    assert.ok(
      malformed.issues.some((issue) => issue.includes('NEXT_PUBLIC_SUPABASE_URL must use HTTPS')),
    );
    assert.ok(
      malformed.issues.some((issue) =>
        issue.includes('NEXT_PUBLIC_SUPABASE_URL must be an origin'),
      ),
    );
    assert.ok(
      malformed.issues.some((issue) =>
        issue.includes('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY has an invalid'),
      ),
    );
    assert.ok(malformed.issues.some((issue) => issue.includes('SUPABASE_URL must match')));
  });

  void it('requires an exact server-only publisher node ID and rejects client exposure', () => {
    const malformed = inspectProductionConfiguration({
      ...validEnvironment,
      AIQ_PUBLISHER_NODE_ID: 'node_invalid',
    });
    assert.equal(malformed.values, undefined);
    assert.ok(malformed.issues.includes('AIQ_PUBLISHER_NODE_ID is not a valid AIQ node ID'));

    const exposed = inspectProductionConfiguration({
      ...validEnvironment,
      NEXT_PUBLIC_AIQ_PUBLISHER_NODE_ID: validEnvironment.AIQ_PUBLISHER_NODE_ID,
    });
    assert.equal(exposed.values, undefined);
    assert.ok(
      exposed.issues.includes('AIQ_PUBLISHER_NODE_ID must not use a NEXT_PUBLIC client boundary'),
    );
  });

  void it('rejects a service-role JWT in a browser-public key variable', () => {
    const serviceRoleJwt = `${encodeJson({ alg: 'HS256', typ: 'JWT' })}.${encodeJson({
      role: 'service_role',
    })}.signature`;
    const configuration = inspectProductionConfiguration({
      ...validEnvironment,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: serviceRoleJwt,
    });
    assert.equal(configuration.values, undefined);
    assert.ok(
      configuration.issues.includes(
        'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY has an invalid publishable-key shape',
      ),
    );
  });

  void it('rejects configuration that readiness would normalize differently from write routes', () => {
    const configuration = inspectProductionConfiguration({
      ...validEnvironment,
      AIQ_RUNNER_SUBMISSION_TOKEN: ` ${validEnvironment.AIQ_RUNNER_SUBMISSION_TOKEN}`,
    });
    assert.equal(configuration.values, undefined);
    assert.ok(
      configuration.issues.includes(
        'AIQ_RUNNER_SUBMISSION_TOKEN must not contain leading or trailing whitespace',
      ),
    );
  });

  void it('rejects line terminators after readiness key and bucket shapes', () => {
    for (const suffix of ['\n', '\r\n', '\u2028', '\u2029']) {
      const configuration = inspectProductionConfiguration({
        ...validEnvironment,
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: `${validEnvironment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY}${suffix}`,
        AIQ_SUBMISSION_PACKAGE_BUCKET: `${validEnvironment.AIQ_SUBMISSION_PACKAGE_BUCKET}${suffix}`,
      });
      assert.equal(configuration.values, undefined);
      assert.ok(configuration.issues.length > 0);
    }
  });

  void it('reports only a bounded dependency pass after the production probe succeeds', async () => {
    let probedValues: Parameters<ProductionDependencyProbe>[0] | undefined;
    const response = await createReadinessHandler({
      environment: validEnvironment,
      probe: async (configuration) => {
        probedValues = configuration;
        await successfulProbe(configuration);
      },
    })();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0');
    assert.equal(probedValues?.packageBucket, 'aiq-submission-packages');
    assert.equal(probedValues?.publisherNodeId, validEnvironment.AIQ_PUBLISHER_NODE_ID);
    const body: unknown = await response.json();
    assert.ok(isRecord(body));
    assert.equal('ready' in body, false);
    assert.deepEqual(body, {
      state: 'bounded_dependency_probe_passed',
      scope_ready: true,
      mode: 'production',
      checks: {
        runtime_mode: 'production',
        configuration: 'valid',
        dependencies: 'available',
      },
      scope: [
        'runtime_mode',
        'configuration_contract',
        'public_read_views',
        'public_trend_points_rpc',
        'private_storage_buckets',
        'role_scoped_rpc_contract',
        'gateway_role_credentials',
        'production_reference_initialization',
      ],
    });
  });

  void it('probes all application reads, both private buckets, and each role credential', async () => {
    await withDependencyFetch();
  });

  void it('keeps empty public views ready and uses exact required-column selects', async () => {
    assert.equal(Object.keys(PUBLIC_VIEW_SELECTS).length, 13);
    assert.ok(Object.values(PUBLIC_VIEW_SELECTS).every((select) => select !== '*'));
    await withDependencyFetch();
  });

  void it('accepts the current public node status contract', async () => {
    await withDependencyFetch(undefined, undefined, undefined, undefined, (view) =>
      view === 'public_nodes'
        ? Response.json([
            {
              id: `node_${'a'.repeat(64)}`,
              name: 'Atlas',
              operator: 'official',
              public_key_fingerprint: 'sha256:fixture',
              capabilities: {},
              source: {},
              trust: 'trusted_verified',
              status: 'online',
              last_seen_at: null,
              signature_status: 'verified',
              provenance: {},
              synthetic: false,
            },
          ])
        : undefined,
    );
  });

  void it('fails closed when a nonempty public view omits a required column', async () => {
    await assert.rejects(
      withDependencyFetch(undefined, undefined, undefined, undefined, (view) =>
        view === 'public_model_matrix'
          ? Response.json([
              {
                id: 'sol-low',
                model_family: 'Sol',
                model_name: 'gpt-5.6-sol',
              },
            ])
          : undefined,
      ),
      /public_reads probe failed/,
    );
  });

  void it('fails closed when a nonempty public view has a malformed basic row shape', async () => {
    await assert.rejects(
      withDependencyFetch(undefined, undefined, undefined, undefined, (view) =>
        view === 'public_task_coverage'
          ? Response.json([
              {
                scoring_version: '1.0.8',
                domain: 'coding',
                weight: 'not-a-number',
                task_count: 8,
              },
            ])
          : undefined,
      ),
      /public_reads probe failed/,
    );
  });

  void it('requires the exact public trend, speed trend, and gateway role probe contracts', () => {
    assert.deepEqual(REQUIRED_RPC_CONTRACT.public_trend_points, {
      arguments: 'supplied_range text',
      result:
        'TABLE(matrix_id text, run_id text, scoring_version text, recorded_at timestamp with time zone, bucket_started_at timestamp with time zone, bucket_ended_at timestamp with time zone, score numeric, theta numeric, standard_error numeric, theta_ci_low numeric, theta_ci_high numeric, score_ci_low numeric, score_ci_high numeric, information numeric, quality_score numeric, strict_pass_rate numeric, strict_pass_low numeric, strict_pass_high numeric, strict_pass_sample_size integer, strict_pass_successes integer, reliability_status text, calibration_status text, sensitivity_low numeric, sensitivity_high numeric, sample_size integer, represented_run_count bigint, resolution_seconds bigint, synthetic boolean)',
      defaultCount: 0,
      modes: ['i', ...Array<string>(28).fill('t')],
      grants: {
        anon: true,
        authenticated: true,
        service_role: false,
        aiq_verifier: false,
        aiq_publisher: false,
      },
    });
    assert.deepEqual(REQUIRED_RPC_CONTRACT.public_speed_trend_points, {
      arguments: 'supplied_range text',
      result:
        'TABLE(model_family text, reasoning_effort text, mode text, recorded_at timestamp with time zone, bucket_started_at timestamp with time zone, bucket_ended_at timestamp with time zone, attempted_trials bigint, completed_trials bigint, represented_batch_count bigint, median_elapsed_ms bigint, p95_elapsed_ms bigint, median_aggregate_output_tps_millis bigint, estimated_credits_nanos numeric, input_tokens numeric, cached_input_tokens numeric, output_tokens numeric, total_tokens numeric, median_agent_steps bigint, median_tool_call_count bigint, resolution_seconds bigint)',
      defaultCount: 0,
      modes: ['i', ...Array<string>(20).fill('t')],
      grants: {
        anon: true,
        authenticated: true,
        service_role: false,
        aiq_verifier: false,
        aiq_publisher: false,
      },
    });
    assert.deepEqual(REQUIRED_RPC_CONTRACT.aiq_gateway_role_probe, {
      arguments: '',
      result: 'text',
      defaultCount: 0,
      modes: [],
      grants: {
        anon: false,
        authenticated: false,
        service_role: false,
        aiq_verifier: true,
        aiq_publisher: true,
      },
    });
  });

  void it('fails closed when the UI trend RPC is unavailable or malformed', async () => {
    await assert.rejects(
      withDependencyFetch(undefined, undefined, undefined, (kind) =>
        kind === 'trend' ? Response.json([{ matrix_id: 'sol-low' }]) : undefined,
      ),
      /public_reads probe failed/,
    );
  });

  for (const [kind, failure] of [
    ['verifier', /verifier_rpc probe failed/],
    ['publisher', /publisher_rpc probe failed/],
  ] as const) {
    void it(`fails closed when the ${kind} JWT assumes the wrong gateway role`, async () => {
      await assert.rejects(
        withDependencyFetch(undefined, undefined, undefined, (candidateKind) =>
          candidateKind === kind
            ? Response.json(kind === 'verifier' ? 'aiq_publisher' : 'aiq_verifier')
            : undefined,
        ),
        failure,
      );
    });
  }

  void it('identifies a missing role-scoped RPC contract', async () => {
    await assert.rejects(
      withDependencyFetch((contracts) => {
        contracts.pop();
      }),
      /role_scoped_rpc_contract probe failed/,
    );
  });

  void it('requires the exact calibration verification and publication RPC contracts', async () => {
    assert.equal(Object.keys(REQUIRED_RPC_CONTRACT).length, 19);
    assert.deepEqual(REQUIRED_RPC_CONTRACT.aiq_stage_calibration_verification, {
      arguments:
        'stage jsonb, target_inbox_id uuid, supplied_lease_token uuid, supplied_attempt integer',
      result: 'text',
      defaultCount: 0,
      modes: [],
      grants: {
        anon: false,
        authenticated: false,
        service_role: false,
        aiq_verifier: true,
        aiq_publisher: false,
      },
    });
    assert.deepEqual(REQUIRED_RPC_CONTRACT.aiq_record_calibration_attestation, {
      arguments:
        'attestation jsonb, target_inbox_id uuid, supplied_lease_token uuid, supplied_attempt integer',
      result: 'text',
      defaultCount: 0,
      modes: [],
      grants: {
        anon: false,
        authenticated: false,
        service_role: false,
        aiq_verifier: true,
        aiq_publisher: false,
      },
    });
    assert.deepEqual(REQUIRED_RPC_CONTRACT.aiq_publish_calibration_evidence, {
      arguments:
        'target_run_id text, target_package_sha256 text, target_inbox_id uuid, supplied_lease_token uuid, supplied_attempt integer',
      result: 'text',
      defaultCount: 0,
      modes: [],
      grants: {
        anon: false,
        authenticated: false,
        service_role: false,
        aiq_verifier: false,
        aiq_publisher: true,
      },
    });

    const assertMissingCalibrationRpc = async (name: string): Promise<void> => {
      await assert.rejects(
        withDependencyFetch((contracts) => {
          const index = contracts.findIndex((contract) => contract.name === name);
          assert.ok(index >= 0);
          contracts.splice(index, 1);
        }),
        /role_scoped_rpc_contract probe failed/,
      );
    };
    await assertMissingCalibrationRpc('aiq_stage_calibration_verification');
    await assertMissingCalibrationRpc('aiq_record_calibration_attestation');
    await assertMissingCalibrationRpc('aiq_publish_calibration_evidence');
  });

  void it('rejects readiness when the Storage lifecycle registration RPC is missing', async () => {
    await assert.rejects(
      withDependencyFetch((contracts) => {
        const index = contracts.findIndex(
          (contract) => contract.name === 'aiq_register_storage_object',
        );
        assert.ok(index >= 0);
        contracts.splice(index, 1);
      }),
      /role_scoped_rpc_contract probe failed/,
    );
  });

  void it('requires the exact service-only Storage lifecycle registration signature', async () => {
    assert.deepEqual(REQUIRED_RPC_CONTRACT.aiq_register_storage_object, {
      arguments:
        'supplied_object_type text, supplied_artifact_kind text, supplied_bucket text, supplied_path text, supplied_sha256 text, supplied_bytes bigint, supplied_retention_class text, supplied_expires_at timestamp with time zone',
      result: 'uuid',
      defaultCount: 0,
      modes: [],
      grants: {
        anon: false,
        authenticated: false,
        service_role: true,
        aiq_verifier: false,
        aiq_publisher: false,
      },
    });
    await assert.rejects(
      withDependencyFetch((contracts) => {
        const registration = contracts.find(
          (contract) => contract.name === 'aiq_register_storage_object',
        );
        assert.ok(registration);
        assert.ok(isRecord(registration.executable_roles));
        registration.executable_roles.service_role = false;
      }),
      /role_scoped_rpc_contract probe failed/,
    );
  });

  void it('requires the service-only production reference status RPC contract', async () => {
    assert.deepEqual(REQUIRED_RPC_CONTRACT.aiq_production_reference_status, {
      arguments: 'expected_publisher_node_id text',
      result: 'jsonb',
      defaultCount: 0,
      modes: [],
      grants: {
        anon: false,
        authenticated: false,
        service_role: true,
        aiq_verifier: false,
        aiq_publisher: false,
      },
    });
  });

  for (const [label, mutate] of [
    ['false initialization', (status: Record<string, unknown>) => (status.initialized = false)],
    ['16 models', (status: Record<string, unknown>) => (status.model_config_count = 16)],
    ['18 models', (status: Record<string, unknown>) => (status.model_config_count = 18)],
    [
      'duplicate model identity',
      (status: Record<string, unknown>) => (status.model_config_mismatch_count = 1),
    ],
    [
      'missing scoring version',
      (status: Record<string, unknown>) => (status.scoring_version_count = 0),
    ],
    [
      'wrong scoring version',
      (status: Record<string, unknown>) => (status.scoring_version_valid = false),
    ],
    [
      'nine-domain scoring',
      (status: Record<string, unknown>) => {
        const domains = status.domain_counts;
        assert.ok(isRecord(domains));
        delete domains.reliability_recovery;
      },
    ],
    [
      'eleven-domain scoring',
      (status: Record<string, unknown>) => {
        const domains = status.domain_counts;
        assert.ok(isRecord(domains));
        domains.extra = 0;
      },
    ],
    [
      'wrong domain count or weight',
      (status: Record<string, unknown>) => {
        const domains = status.domain_counts;
        assert.ok(isRecord(domains));
        domains.coding = 9;
      },
    ],
    ['two nodes', (status: Record<string, unknown>) => (status.production_node_count = 2)],
    ['four nodes', (status: Record<string, unknown>) => (status.production_node_count = 4)],
    ['synthetic node', (status: Record<string, unknown>) => (status.initialized = false)],
    ['unapproved node', (status: Record<string, unknown>) => (status.publisher_count = 0)],
    ['39 private tables', (status: Record<string, unknown>) => (status.private_table_count = 39)],
    [
      '39 forced-RLS tables',
      (status: Record<string, unknown>) => (status.forced_rls_table_count = 39),
    ],
    ['12 public views', (status: Record<string, unknown>) => (status.public_view_count = 12)],
    [
      '11 security-invoker views',
      (status: Record<string, unknown>) => (status.security_invoker_view_count = 11),
    ],
    [
      'one hardened gateway role',
      (status: Record<string, unknown>) => (status.hardened_gateway_role_count = 1),
    ],
    [
      'wrong catalog digest',
      (status: Record<string, unknown>) =>
        (status.catalog_identity_sha256 = `sha256:${'0'.repeat(64)}`),
    ],
    [
      'invalid frozen catalog',
      (status: Record<string, unknown>) => (status.frozen_catalog_valid = false),
    ],
    [
      'wrong task-set identity',
      (status: Record<string, unknown>) =>
        (status.task_set_identity_sha256 = `sha256:${'0'.repeat(64)}`),
    ],
    [
      'invalid task-set identity',
      (status: Record<string, unknown>) => (status.task_set_identity_valid = false),
    ],
    [
      'wrong evaluator identity',
      (status: Record<string, unknown>) =>
        (status.evaluator_identity_sha256 = `sha256:${'0'.repeat(64)}`),
    ],
    [
      'invalid evaluator identity',
      (status: Record<string, unknown>) => (status.evaluator_identity_valid = false),
    ],
    ['malformed response', (status: Record<string, unknown>) => delete status.task_count],
  ] as const) {
    void it(`rejects ${label} in the production reference status`, async () => {
      await assert.rejects(
        withDependencyFetch(undefined, undefined, mutate),
        /production_reference probe failed/,
      );
    });
  }

  void it('rejects an oversized RPC contract from its Content-Length bound', async () => {
    await assert.rejects(
      withDependencyFetch(undefined, undefined, undefined, (kind, document) =>
        kind === 'contract'
          ? new Response(JSON.stringify(document), {
              headers: { 'content-length': '64001', 'content-type': 'application/json' },
            })
          : undefined,
      ),
      /role_scoped_rpc_contract probe failed/,
    );
  });

  void it('rejects an oversized chunked reference response without Content-Length', async () => {
    await assert.rejects(
      withDependencyFetch(undefined, undefined, undefined, (kind) => {
        if (kind !== 'reference') return undefined;
        const chunk = new TextEncoder().encode(`"${'x'.repeat(40_000)}"`);
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(chunk);
              controller.enqueue(chunk);
              controller.close();
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }),
      /production_reference probe failed/,
    );
  });

  for (const [field, replacement] of [
    ['arguments', 'envelope text'],
    ['result', 'text'],
    ['default_count', 0],
    ['argument_modes', ['i']],
  ] as const) {
    void it(`rejects an RPC contract with wrong ${field}`, async () => {
      await assert.rejects(
        withDependencyFetch((contracts) => {
          const claim = contracts.find((contract) => contract.name === 'aiq_claim_submission');
          assert.ok(claim);
          claim[field] = replacement;
        }),
        /role_scoped_rpc_contract probe failed/,
      );
    });
  }

  void it('rejects an RPC contract with an unexpected role grant', async () => {
    await assert.rejects(
      withDependencyFetch((contracts) => {
        const claim = contracts.find((contract) => contract.name === 'aiq_claim_submission');
        assert.ok(claim);
        assert.ok(isRecord(claim.executable_roles));
        claim.executable_roles.service_role = true;
      }),
      /role_scoped_rpc_contract probe failed/,
    );
  });

  void it('rejects configured Storage buckets that are public', async () => {
    await assert.rejects(
      withDependencyFetch(undefined, (buckets) => {
        const packageBucket = buckets.find((bucket) => bucket.name === 'aiq-submission-packages');
        assert.ok(packageBucket);
        packageBucket.public = true;
      }),
      /storage_buckets probe failed/,
    );
  });

  void it('distinguishes a dependency failure from configuration failure', async () => {
    let signal: AbortSignal | undefined;
    const response = await createReadinessHandler({
      environment: validEnvironment,
      probe: async (configuration) => {
        signal = configuration.signal;
        throw new Error('database host and secret detail that must not be exposed');
      },
    })();
    const body = await response.text();
    assert.equal(response.status, 503);
    assert.match(body, /"state":"dependencies_unavailable"/);
    assert.match(body, /"failed_dependency":"unknown"/);
    assert.doesNotMatch(body, /database host|secret detail/);
    assert.equal(signal?.aborted, true);
  });

  void it('bounds a dependency probe that does not observe abort', async () => {
    const startedAt = Date.now();
    const response = await createReadinessHandler({
      environment: validEnvironment,
      timeoutMs: 5,
      probe: () => new Promise(() => {}),
    })();
    assert.equal(response.status, 503);
    assert.ok(Date.now() - startedAt < 500);
    const body: unknown = await response.json();
    assert.ok(isRecord(body));
    assert.equal(body.state, 'dependencies_unavailable');
    assert.equal(body.failed_dependency, 'timeout');
  });

  void it('does not leak any configured secret in success or failure responses', async () => {
    const responses = await Promise.all([
      createReadinessHandler({ environment: validEnvironment, probe: successfulProbe })(),
      createReadinessHandler({
        environment: validEnvironment,
        probe: async () => {
          throw new Error(Object.values(validEnvironment).join(' '));
        },
      })(),
      createReadinessHandler({
        environment: { ...validEnvironment, SUPABASE_SECRET_KEY: 'secret-malformed-value' },
      })(),
    ]);
    const bodies = await Promise.all(responses.map((response) => response.text()));
    const secretValues = [
      validEnvironment.SUPABASE_SECRET_KEY,
      validEnvironment.AIQ_RUNNER_SUBMISSION_TOKEN,
      validEnvironment.AIQ_VERIFIER_INGRESS_TOKEN,
      validEnvironment.AIQ_SUPABASE_JWT_PRIVATE_JWK,
      validEnvironment.AIQ_PUBLISHER_NODE_ID,
    ];
    for (const body of bodies) {
      for (const secret of secretValues) assert.equal(body.includes(secret), false);
    }
  });
});
