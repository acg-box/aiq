import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const schema = await readFile(resolvePath(import.meta.dirname, 'schema.sql'), 'utf8');
const databaseUrl = process.env.AIQ_DATABASE_CONCURRENCY_TEST_URL;
const psqlCommand = process.env.AIQ_DATABASE_CONCURRENCY_TEST_PSQL;
const inboxId = '71783153-6205-4929-a173-183153620529';
const leaseToken = '18315362-0529-4717-8315-362052971783';
const runId = `run_${'7'.repeat(64)}`;
const artifactBucket = 'resolver-concurrency-artifacts';
const rejectionBucket = 'resolver-rejection-artifacts';
const resultArtifacts = [
  ['evaluator-results.json', '1'.repeat(64), 101],
  ['final-response.txt', '2'.repeat(64), 102],
  ['stderr.txt', '3'.repeat(64), 103],
  ['stdout.jsonl', '4'.repeat(64), 104],
  ['workspace-manifest.json', '5'.repeat(64), 105],
  ['workspace-snapshot.json', '6'.repeat(64), 106],
] as const;
const capabilityArtifacts = [
  ['stdout.jsonl', '7'.repeat(64), 107],
  ['stderr.txt', '8'.repeat(64), 108],
] as const;
const artifacts = [...resultArtifacts, ...capabilityArtifacts] as const;
const rejectedArtifacts = [
  ['stderr.txt', '9'.repeat(64), 109, 'missing'],
  ['stderr.txt', 'a'.repeat(64), 110, 'kind'],
  ['stderr.txt', 'b'.repeat(64), 111, 'hash'],
  ['stdout.jsonl', 'c'.repeat(64), 112, 'uri'],
  ['stderr.txt', 'd'.repeat(64), 113, 'bytes'],
  ['stdout.jsonl', 'e'.repeat(64), 114, 'undeclared'],
] as const;

function databaseEnvironment(url: string, applicationName: string): NodeJS.ProcessEnv {
  const parsed = new URL(url);
  return {
    ...process.env,
    PGAPPNAME: applicationName,
    PGDATABASE: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
    PGHOST: parsed.hostname,
    PGPASSWORD: decodeURIComponent(parsed.password),
    PGPORT: parsed.port,
    PGUSER: decodeURIComponent(parsed.username),
  };
}

async function runPsql(
  command: string,
  url: string,
  sql: string,
  applicationName: string,
): Promise<string> {
  const { stdout } = await execFileAsync(
    command,
    [
      '-X',
      '--no-psqlrc',
      '--quiet',
      '--tuples-only',
      '--no-align',
      '--set',
      'ON_ERROR_STOP=1',
      '--set',
      'VERBOSITY=verbose',
      '--command',
      sql,
    ],
    {
      env: databaseEnvironment(url, applicationName),
      timeout: 20_000,
    },
  );
  return stdout.trim();
}

function fixtureSql(): string {
  const ordinaryArtifacts = resultArtifacts
    .filter(([kind]) => !['evaluator-results.json', 'workspace-manifest.json'].includes(kind))
    .map(
      ([kind, digest, bytes]) =>
        `jsonb_build_object('kind','${kind}','content_hash','sha256:${digest}',` +
        `'uri','aiq-artifact://sha256/${digest}/${kind}','bytes',${bytes})`,
    )
    .join(',');
  const evaluator = resultArtifacts[0];
  const manifest = resultArtifacts[4];
  const capabilityReferences = [
    `jsonb_build_object('kind','${capabilityArtifacts[0][0]}',` +
      `'content_hash','sha256:${capabilityArtifacts[0][1]}',` +
      `'uri','aiq-artifact://sha256/${capabilityArtifacts[0][1]}/${capabilityArtifacts[0][0]}',` +
      `'bytes',${capabilityArtifacts[0][2]})`,
    `jsonb_build_object('kind','${capabilityArtifacts[1][0]}',` +
      `'content_hash','sha256:${capabilityArtifacts[1][1]}',` +
      `'uri','aiq-artifact://sha256/${capabilityArtifacts[1][1]}/${capabilityArtifacts[1][0]}',` +
      `'bytes',${capabilityArtifacts[1][2]})`,
    `jsonb_build_object('kind','${rejectedArtifacts[0][0]}',` +
      `'content_hash','sha256:${rejectedArtifacts[0][1]}',` +
      `'uri','aiq-artifact://sha256/${rejectedArtifacts[0][1]}/${rejectedArtifacts[0][0]}',` +
      `'bytes',${rejectedArtifacts[0][2]})`,
    `jsonb_build_object('kind','stdout.jsonl',` +
      `'content_hash','sha256:${rejectedArtifacts[1][1]}',` +
      `'uri','aiq-artifact://sha256/${rejectedArtifacts[1][1]}/${rejectedArtifacts[1][0]}',` +
      `'bytes',${rejectedArtifacts[1][2]})`,
    `jsonb_build_object('kind','${rejectedArtifacts[2][0]}',` +
      `'content_hash','sha256:${'f'.repeat(64)}',` +
      `'uri','aiq-artifact://sha256/${rejectedArtifacts[2][1]}/${rejectedArtifacts[2][0]}',` +
      `'bytes',${rejectedArtifacts[2][2]})`,
    `jsonb_build_object('kind','${rejectedArtifacts[3][0]}',` +
      `'content_hash','sha256:${rejectedArtifacts[3][1]}',` +
      `'uri','aiq-artifact://sha256/${rejectedArtifacts[3][1]}/stderr.txt',` +
      `'bytes',${rejectedArtifacts[3][2]})`,
    `jsonb_build_object('kind','${rejectedArtifacts[4][0]}',` +
      `'content_hash','sha256:${rejectedArtifacts[4][1]}',` +
      `'uri','aiq-artifact://sha256/${rejectedArtifacts[4][1]}/${rejectedArtifacts[4][0]}',` +
      `'bytes',${rejectedArtifacts[4][2] + 1})`,
  ];
  const capabilityModels = capabilityReferences
    .map(
      (reference) =>
        `jsonb_build_object('probe',jsonb_build_object('artifacts',jsonb_build_array(${reference})))`,
    )
    .join(',');
  const ingressArtifacts = [
    ...artifacts.map(([kind, digest, bytes]) => [kind, digest, bytes, artifactBucket] as const),
    ...rejectedArtifacts
      .filter(([, , , rejection]) => rejection !== 'missing')
      .map(([kind, digest, bytes]) => [kind, digest, bytes, rejectionBucket] as const),
  ];
  const objectValues = ingressArtifacts
    .map(
      ([kind, digest, bytes, bucket]) =>
        `('${kind}','${digest}','${bucket}','sha256/${digest}/${kind}',${bytes}::bigint)`,
    )
    .join(',\n');
  const claimValues = ingressArtifacts
    .map(([kind, digest]) => `('${runId}','${kind}','${digest}')`)
    .join(',\n');

  return `
begin;
do $$ begin
  execute format('grant aiq_verifier to %I', current_user);
end $$;
insert into aiq_private.aiq_submission_inbox (
  inbox_id,idempotency_key,package_sha256,envelope,request_context,
  received_at,expires_at,claim_token,claim_expires_at,claim_attempts
) values (
  '${inboxId}','${runId}','${'8'.repeat(64)}',
  jsonb_build_object('payload',jsonb_build_object(
    'evaluator_results_artifact',jsonb_build_object(
      'kind','${evaluator[0]}','content_hash','sha256:${evaluator[1]}',
      'uri','aiq-artifact://sha256/${evaluator[1]}/${evaluator[0]}',
      'bytes',${evaluator[2]}
    ),
    'capability_validation',jsonb_build_object(
      'models',jsonb_build_array(${capabilityModels})
    ),
    'results',jsonb_build_array(jsonb_build_object(
      'artifacts',jsonb_build_array(${ordinaryArtifacts}),
      'workspace_manifest',jsonb_build_object(
        'kind','${manifest[0]}','content_hash','sha256:${manifest[1]}',
        'uri','aiq-artifact://sha256/${manifest[1]}/${manifest[0]}',
        'bytes',${manifest[2]}
      )
    ))
  )),
  '{"source":"resolver-concurrency-regression"}'::jsonb,
  clock_timestamp(),clock_timestamp()+interval '30 days',
  '${leaseToken}',clock_timestamp()+interval '10 minutes',1
);
insert into aiq_private.aiq_artifact_ingress_objects (
  artifact_kind,content_sha256,bucket_name,object_path,byte_size
) values
${objectValues};
insert into aiq_private.aiq_artifact_ingress_claims (
  claimed_run_id,artifact_kind,content_sha256
) values
${claimValues};
commit;`;
}

function resolverSql(kind: string, digest: string): string {
  return `
begin;
set local deadlock_timeout='100ms';
set local lock_timeout='10s';
set local statement_timeout='15s';
set local role aiq_verifier;
set local request.jwt.claims='{"role":"aiq_verifier"}';
select jsonb_build_object(
  'artifact_kind',resolved.artifact_kind,
  'content_sha256',resolved.content_sha256,
  'object_bucket',resolved.object_bucket,
  'object_key',resolved.object_key,
  'byte_size',resolved.byte_size
)::text
from public.aiq_resolve_claim_artifact(
  '${inboxId}','${leaseToken}','${kind}','${digest}'
) resolved;
commit;`;
}

async function assertResolverRejected(
  command: string,
  url: string,
  artifact: (typeof rejectedArtifacts)[number],
): Promise<void> {
  const [kind, digest, , reason] = artifact;
  await assert.rejects(
    runPsql(command, url, resolverSql(kind, digest), 'aiq-resolver-rejection-worker'),
    (error: unknown) => {
      assert.match(errorText(error), /42501/);
      return true;
    },
    `${reason} capability evidence must not resolve`,
  );
}

async function waitForBlockedResolvers(command: string, url: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const count = Number(
      // oxlint-disable-next-line no-await-in-loop -- Each observation follows the prior lock state.
      await runPsql(
        command,
        url,
        `select count(*) from pg_catalog.pg_stat_activity
         where datname=current_database()
           and application_name='aiq-resolver-concurrency-worker'
           and state='active'
           and wait_event_type='Lock'
           and query like '%aiq_resolve_claim_artifact%';`,
        'aiq-resolver-concurrency-monitor',
      ),
    );
    if (count === artifacts.length) return;
    // oxlint-disable-next-line no-await-in-loop -- The bounded poll must observe a later lock state.
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error('parallel artifact resolvers did not reach the lock barrier');
}

function errorText(reason: unknown): string {
  if (!(reason instanceof Error)) return String(reason);
  const stdout = 'stdout' in reason && typeof reason.stdout === 'string' ? reason.stdout : '';
  const stderr = 'stderr' in reason && typeof reason.stderr === 'string' ? reason.stderr : '';
  return `${reason.message}\n${stdout}\n${stderr}`;
}

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);
}

function parseJsonObject(serialized: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(serialized);
  assert.ok(isRecord(parsed));
  return parsed;
}

void test('locks the claim before artifact binding can enter the Storage gate', () => {
  const resolver =
    schema.match(
      /create function aiq_private\.aiq_resolve_claim_artifact_reference_core[\s\S]*?\n\$_\$;/,
    )?.[0] ?? '';
  const claimLock = resolver.indexOf('for update;');
  const bindingInsert = resolver.indexOf('insert into aiq_private.aiq_artifact_claim_bindings');
  assert.ok(claimLock >= 0, 'artifact resolution must lock its claim row');
  assert.ok(bindingInsert > claimLock, 'the claim lock must precede the binding trigger');
});

void test('matches capability probe artifacts by exact claim-bound metadata', () => {
  const resolver =
    schema.match(
      /create function aiq_private\.aiq_resolve_claim_artifact_reference_core[\s\S]*?\n\$_\$;/,
    )?.[0] ?? '';
  assert.match(resolver, /payload,capability_validation,models/);
  assert.match(resolver, /capability_model #> '\{probe,artifacts\}'/);
  assert.match(resolver, /reference ->> 'kind' = requested_kind/);
  assert.match(resolver, /reference ->> 'content_hash' = 'sha256:' \|\| requested_sha256/);
  assert.match(
    resolver,
    /reference ->> 'uri' = 'aiq-artifact:\/\/sha256\/' \|\| requested_sha256 \|\| '\/' \|\| requested_kind/,
  );
  assert.match(resolver, /\(reference ->> 'bytes'\)::bigint = artifact\.byte_size/);
});

void test(
  'strictly resolves one claim artifact set concurrently and remains idempotent',
  {
    timeout: 60_000,
    skip:
      databaseUrl === undefined ||
      databaseUrl === '' ||
      psqlCommand === undefined ||
      psqlCommand === ''
        ? 'requires AIQ_DATABASE_CONCURRENCY_TEST_URL and AIQ_DATABASE_CONCURRENCY_TEST_PSQL'
        : false,
  },
  async () => {
    if (
      databaseUrl === undefined ||
      databaseUrl === '' ||
      psqlCommand === undefined ||
      psqlCommand === ''
    ) {
      throw new Error('integration configuration disappeared after test selection');
    }

    const version = await runPsql(
      psqlCommand,
      databaseUrl,
      'show server_version;',
      'aiq-resolver-concurrency-setup',
    );
    assert.match(version, /^17(?:\.|$)/);
    await runPsql(psqlCommand, databaseUrl, fixtureSql(), 'aiq-resolver-concurrency-setup');
    await Promise.all(
      rejectedArtifacts.map((artifact) =>
        assertResolverRejected(psqlCommand, databaseUrl, artifact),
      ),
    );

    const gate = spawn(
      psqlCommand,
      ['-X', '--no-psqlrc', '--quiet', '--tuples-only', '--no-align'],
      {
        env: databaseEnvironment(databaseUrl, 'aiq-resolver-concurrency-gate'),
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const gateExitPromise = once(gate, 'exit');
    let gateOutput = '';
    let gateError = '';
    gate.stdout.setEncoding('utf8');
    gate.stderr.setEncoding('utf8');
    gate.stdout.on('data', (chunk: string) => {
      gateOutput += chunk;
    });
    gate.stderr.on('data', (chunk: string) => {
      gateError += chunk;
    });
    gate.stdin.write(`\\set ON_ERROR_STOP on
begin;
select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
  'aiq.storage.inventory-deletion-gate',71783153620529
));
\\echo AIQ_GATE_READY
`);

    const readyDeadline = Date.now() + 5_000;
    while (!gateOutput.includes('AIQ_GATE_READY') && Date.now() < readyDeadline) {
      if (gate.exitCode !== null) {
        throw new Error(`advisory lock gate exited early: ${gateError}`);
      }
      // oxlint-disable-next-line no-await-in-loop -- Gate readiness is a bounded sequential poll.
      await new Promise((done) => setTimeout(done, 10));
    }
    if (!gateOutput.includes('AIQ_GATE_READY')) gate.kill('SIGTERM');
    assert.match(gateOutput, /AIQ_GATE_READY/);

    const firstWave = Promise.allSettled(
      artifacts.map(([kind, digest]) =>
        runPsql(
          psqlCommand,
          databaseUrl,
          resolverSql(kind, digest),
          'aiq-resolver-concurrency-worker',
        ),
      ),
    );
    let barrierFailure: unknown;
    try {
      await waitForBlockedResolvers(psqlCommand, databaseUrl);
    } catch (error) {
      barrierFailure = error;
    } finally {
      gate.stdin.end('commit;\n\\q\n');
    }
    const gateExit = await gateExitPromise;
    assert.equal(gateExit[0], 0, gateError);

    const firstResults = await firstWave;
    if (barrierFailure !== undefined) {
      throw barrierFailure instanceof Error
        ? barrierFailure
        : new Error('artifact resolver lock barrier failed with a non-Error value');
    }
    const failures = firstResults.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    const failureDetails = failures.map((failure) => errorText(failure.reason)).join('\n');
    assert.doesNotMatch(failureDetails, /40P01|deadlock detected/i);
    assert.deepEqual(failures, [], failureDetails);
    for (const [index, result] of firstResults.entries()) {
      const expected = artifacts[index];
      assert.ok(expected);
      assert.equal(result.status, 'fulfilled');
      if (result.status !== 'fulfilled') continue;
      const returned = parseJsonObject(result.value.split(/\r?\n/).at(-1) ?? 'null');
      assert.deepEqual(returned, {
        artifact_kind: expected[0],
        byte_size: expected[2],
        content_sha256: expected[1],
        object_bucket: artifactBucket,
        object_key: `sha256/${expected[1]}/${expected[0]}`,
      });
    }

    const replayResults = await Promise.allSettled(
      Array.from({ length: 3 }, () =>
        artifacts.map(([kind, digest]) =>
          runPsql(
            psqlCommand,
            databaseUrl,
            resolverSql(kind, digest),
            'aiq-resolver-concurrency-worker',
          ),
        ),
      ).flat(),
    );
    const replayFailures = replayResults.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    const replayFailureDetails = replayFailures
      .map((failure) => errorText(failure.reason))
      .join('\n');
    assert.doesNotMatch(replayFailureDetails, /40P01|deadlock detected/i);
    assert.deepEqual(replayFailures, [], replayFailureDetails);

    const state = parseJsonObject(
      await runPsql(
        psqlCommand,
        databaseUrl,
        `select jsonb_build_object(
          'binding_count',(select count(*) from aiq_private.aiq_artifact_claim_bindings
            where inbox_id='${inboxId}'),
          'activation_count',(select count(*) from aiq_private.aiq_claim_artifact_reference_events
            where inbox_id='${inboxId}' and transition='activated'),
          'active_reference_count',(select count(*)
            from aiq_private.aiq_storage_object_references reference
            join aiq_private.aiq_storage_objects object using(object_id)
            where reference.reference_type='artifact_claim_binding'
              and reference.active and object.bucket_name='${artifactBucket}'),
          'ingress_count',(select count(*) from aiq_private.aiq_artifact_ingress_objects
            where bucket_name='${artifactBucket}'),
          'registry_match_count',(select count(*)
            from aiq_private.aiq_artifact_claim_bindings binding
            join aiq_private.aiq_artifact_ingress_objects ingress
              using(artifact_kind,content_sha256)
            join aiq_private.aiq_storage_objects object
              on object.bucket_name=ingress.bucket_name
              and object.object_path=ingress.object_path
              and object.content_sha256=ingress.content_sha256
              and object.byte_size=ingress.byte_size
              and object.lifecycle_state='active'
            where binding.inbox_id='${inboxId}'),
          'rejected_binding_count',(select count(*)
            from aiq_private.aiq_artifact_claim_bindings binding
            join aiq_private.aiq_artifact_ingress_objects ingress
              using(artifact_kind,content_sha256)
            where binding.inbox_id='${inboxId}'
              and ingress.bucket_name='${rejectionBucket}')
        )::text;`,
        'aiq-resolver-concurrency-state',
      ),
    );
    assert.deepEqual(state, {
      activation_count: artifacts.length,
      active_reference_count: artifacts.length,
      binding_count: artifacts.length,
      ingress_count: artifacts.length,
      rejected_binding_count: 0,
      registry_match_count: artifacts.length,
    });
  },
);
