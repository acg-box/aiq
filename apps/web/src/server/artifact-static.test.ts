import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '../../../..');

await test('artifact transport keeps private metadata and narrow role RPCs', async () => {
  const schema = await readFile(resolve(repositoryRoot, 'databases/schema.sql'), 'utf8');
  assert.match(schema, /create table aiq_private\.aiq_artifact_ingress_objects/);
  assert.match(schema, /create table aiq_private\.aiq_artifact_ingress_claims/);
  assert.match(schema, /create table aiq_private\.aiq_artifact_claim_bindings/);
  assert.doesNotMatch(schema, /create table public\.aiq_artifact/);
  assert.doesNotMatch(schema, /insert into storage\.buckets|create bucket/i);
  assert.match(
    schema,
    /grant all on function public\.aiq_record_artifact_ingress\(target_run_id text, supplied_kind text, supplied_sha256 text, supplied_byte_size bigint, object_identity jsonb\) to service_role;/,
  );
  assert.match(
    schema,
    /grant all on function public\.aiq_resolve_claim_artifact\(target_inbox_id uuid, supplied_lease_token uuid, requested_kind text, requested_sha256 text\) to aiq_verifier;/,
  );
  assert.match(
    schema,
    /grant all on function public\.aiq_purge_expired_artifact_ingress\(max_rows integer\) to service_role;/,
  );
  assert.doesNotMatch(
    schema,
    /grant all on function public\.aiq_resolve_claim_artifact\([^;]+\) to (?:anon|authenticated|service_role|aiq_publisher);/,
  );
  assert.match(schema, /perform aiq_private\.require_request_role\('service_role'\)/);
  assert.match(schema, /perform aiq_private\.require_request_role\('aiq_verifier'\)/);
  const artifactResolutionStart = schema.indexOf(
    'create function aiq_private.aiq_resolve_claim_artifact_reference_core(',
  );
  const artifactResolutionEnd = schema.indexOf('\n$_$;', artifactResolutionStart);
  assert.ok(artifactResolutionStart >= 0 && artifactResolutionEnd > artifactResolutionStart);
  const artifactResolutionFunction = schema.slice(artifactResolutionStart, artifactResolutionEnd);
  assert.match(artifactResolutionFunction, /database_now timestamptz := clock_timestamp\(\);/);
  assert.match(artifactResolutionFunction, /claimed\.claim_expires_at <= database_now/);
  assert.match(schema, /reference ->> 'kind' = requested_kind/);
  assert.match(schema, /reference ->> 'content_hash'\s+= 'sha256:' \|\| requested_sha256/);
  assert.match(
    schema,
    /reference ->> 'uri'\s+= 'aiq-artifact:\/\/sha256\/' \|\| requested_sha256 \|\| '\/' \|\| requested_kind/,
  );
  assert.match(
    schema,
    /requested_kind = 'evaluator-results\.json'[\s\S]*evaluator_results_artifact,content_hash[\s\S]*requested_sha256[\s\S]*evaluator_results_artifact,bytes[\s\S]*artifact\.byte_size/,
  );
  assert.match(
    artifactResolutionFunction,
    /claimed\.envelope #> '\{payload,capability_validation,models\}'/,
  );
  assert.match(artifactResolutionFunction, /capability_model #> '\{probe,artifacts\}'/);
  assert.match(
    artifactResolutionFunction,
    /select capability_reference\.reference[\s\S]*\) claimed_reference\(reference\)[\s\S]*reference ->> 'kind' = requested_kind[\s\S]*reference ->> 'content_hash' = 'sha256:' \|\| requested_sha256[\s\S]*reference ->> 'uri' = 'aiq-artifact:\/\/sha256\/' \|\| requested_sha256 \|\| '\/' \|\| requested_kind[\s\S]*reference ->> 'bytes'[\s\S]*artifact\.byte_size/,
  );
});

await test('artifact HTTP routes do not return private Storage identity', async () => {
  const [upload, resolveRoute, uploadHandler, resolveHandler, immutableStorage] = await Promise.all(
    [
      readFile(resolve(repositoryRoot, 'apps/web/src/app/api/artifacts/route.ts'), 'utf8'),
      readFile(resolve(repositoryRoot, 'apps/web/src/app/api/artifacts/resolve/route.ts'), 'utf8'),
      readFile(resolve(repositoryRoot, 'apps/web/src/server/artifact-handler.ts'), 'utf8'),
      readFile(resolve(repositoryRoot, 'apps/web/src/server/artifact-resolve-handler.ts'), 'utf8'),
      readFile(resolve(repositoryRoot, 'apps/web/src/server/private-storage-object.ts'), 'utf8'),
    ],
  );
  assert.match(upload, /storeExactPrivateStorageObject/);
  assert.match(immutableStorage, /upsert: false/);
  assert.match(upload, /sha256\/\$\{receipt\.digest\}\/\$\{receipt\.kind\}/);
  assert.match(resolveRoute, /createSignedUrl\(artifact\.key, expiresInSeconds\)/);
  assert.match(uploadHandler, /hasValidBearerToken[\s\S]*readBoundedBinary/);
  assert.match(resolveHandler, /hasValidBearerToken[\s\S]*readBody/);
  const responseStart = resolveHandler.indexOf('return json(200');
  assert.ok(responseStart >= 0);
  assert.doesNotMatch(resolveHandler.slice(responseStart), /artifact\.bucket|artifact\.key/);
});
