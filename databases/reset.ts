import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  assertDatabaseTarget,
  databaseConnectionEnvironment,
  initializeDatabase,
  type InitializationReceipt,
  type PreparedInitialization,
  prepareInitializationFromFiles,
} from './init.ts';

const PROJECT_REF = 'xxnszykaeapolqdnhalx';
const STORAGE_ORIGIN = `https://${PROJECT_REF}.supabase.co`;
const PRIVATE_SCHEMA = 'aiq_private';
const BUCKETS = ['aiq-runner-artifacts', 'aiq-submission-packages'] as const;
const BUCKET_SET = new Set<string>(BUCKETS);
const CONFIRMATION = `${PROJECT_REF}:${PRIVATE_SCHEMA}`;
const PAGE_SIZE = 100;
const MAX_PAGES_PER_BUCKET = 10_000;
const DELETE_BATCH_SIZE = 100;
const DELETE_CONCURRENCY = 4;
const MAX_PSQL_OUTPUT_BYTES = 1_000_000;

interface SchemaNames {
  readonly functions: readonly string[];
  readonly policies: readonly {
    readonly name: string;
    readonly relation: string;
    readonly schema: string;
  }[];
  readonly views: readonly string[];
}

interface DatabaseInventory {
  readonly schema_exists: boolean;
  readonly roles: readonly string[];
  readonly public_functions: readonly string[];
  readonly public_views: readonly string[];
  readonly storage_buckets: readonly { readonly id: string; readonly name: string }[];
  readonly unexpected_namespaces: readonly string[];
  readonly unexpected_external_dependencies: readonly string[];
  readonly unexpected_public_functions: readonly string[];
  readonly unexpected_public_relations: readonly string[];
  readonly unexpected_public_view_name_collisions: readonly string[];
  readonly unexpected_roles: readonly string[];
  readonly unexpected_storage_buckets: readonly string[];
  readonly unexpected_role_memberships: readonly string[];
  readonly unexpected_role_dependencies: readonly string[];
}

export interface ResetInventory {
  readonly project_ref: typeof PROJECT_REF;
  readonly namespace: typeof PRIVATE_SCHEMA;
  readonly database: DatabaseInventory;
  readonly storage: Readonly<
    Record<
      (typeof BUCKETS)[number],
      { readonly object_count: number; readonly object_paths_sha256: string }
    >
  >;
}

export interface ResetReceipt {
  readonly schema_version: 'aiq.production-reset-receipt.v1';
  readonly reset: true;
  readonly inventory: ResetInventory;
  readonly initialization: InitializationReceipt;
}

export interface ResetDependencies {
  readonly fetch?: typeof fetch;
  readonly initialize?: typeof initializeDatabase;
  readonly prepare?: typeof prepareInitializationFromFiles;
  readonly psqlCommand?: string;
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: string[] = [];
  for (const item of Array.from<unknown>(value)) {
    if (typeof item !== 'string') return undefined;
    result.push(item);
  }
  return result;
}

export function canonicalSchemaNames(schema: string): SchemaNames {
  const functions = [...schema.matchAll(/^create function public\.([a-z][a-z0-9_]*)\s*\(/gim)].map(
    (match) => match[1] ?? '',
  );
  const views = [...schema.matchAll(/^create view public\.([a-z][a-z0-9_]*)\b/gim)].map(
    (match) => match[1] ?? '',
  );
  const policies = [
    ...schema.matchAll(
      /^create policy ([a-z][a-z0-9_]*) on ([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)\b/gim,
    ),
  ].map((match) => ({
    name: match[1] ?? '',
    schema: match[2] ?? '',
    relation: match[3] ?? '',
  }));
  if (
    functions.length === 0 ||
    policies.length === 0 ||
    policies.some(({ schema: policySchema }) => policySchema !== PRIVATE_SCHEMA) ||
    new Set(
      policies.map(
        ({ name, relation, schema: policySchema }) => `${policySchema}.${relation}.${name}`,
      ),
    ).size !== policies.length ||
    views.length === 0
  ) {
    throw new Error('schema.sql does not define the canonical AIQ public namespace');
  }
  return {
    functions: [...new Set(functions)].toSorted(),
    policies: policies.toSorted((left, right) =>
      `${left.schema}.${left.relation}.${left.name}`.localeCompare(
        `${right.schema}.${right.relation}.${right.name}`,
      ),
    ),
    views: [...new Set(views)].toSorted(),
  };
}

async function runPsql(
  command: string,
  databaseUrl: string,
  sql: string,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const childEnvironment = databaseConnectionEnvironment(databaseUrl);
    for (const key of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'PATHEXT']) {
      if (environment[key] !== undefined) childEnvironment[key] = environment[key];
    }
    const child = spawn(
      command,
      ['-X', '--no-psqlrc', '--quiet', '--tuples-only', '--no-align', '--set', 'ON_ERROR_STOP=1'],
      { env: childEnvironment, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const stdout: Buffer[] = [];
    let bytes = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_PSQL_OUTPUT_BYTES) child.kill();
      else stdout.push(chunk);
    });
    child.stderr.resume();
    child.on('error', () => rejectPromise(new Error('psql could not start')));
    child.on('close', (code) => {
      if (code !== 0 || bytes > MAX_PSQL_OUTPUT_BYTES) {
        rejectPromise(new Error('AIQ database reset SQL did not complete'));
      } else {
        resolvePromise(Buffer.concat(stdout).toString('utf8'));
      }
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(sql);
  });
}

function inventoryExpression(names: SchemaNames): string {
  const functions = names.functions.map(sqlLiteral).join(', ');
  const policies = names.policies
    .map(
      ({ name, relation, schema }) =>
        `(${sqlLiteral(name)}, ${sqlLiteral(schema)}, ${sqlLiteral(relation)})`,
    )
    .join(', ');
  const views = names.views.map(sqlLiteral).join(', ');
  return `json_build_object(
  'schema_exists', exists(select 1 from pg_namespace where nspname = '${PRIVATE_SCHEMA}'),
  'roles', coalesce((select json_agg(rolname order by rolname) from pg_roles where rolname in ('aiq_publisher', 'aiq_verifier')), '[]'::json),
  'public_functions', coalesce((select json_agg(distinct proname order by proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and proname in (${functions})), '[]'::json),
  'public_views', coalesce((select json_agg(c.relname order by c.relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('v','m') and c.relname in (${views})), '[]'::json),
  'storage_buckets', coalesce((select json_agg(json_build_object('id', id, 'name', name) order by id) from storage.buckets where id in ('aiq-runner-artifacts', 'aiq-submission-packages') or name in ('aiq-runner-artifacts', 'aiq-submission-packages')), '[]'::json),
  'unexpected_namespaces', coalesce((select json_agg(nspname order by nspname) from pg_namespace where nspname like 'aiq\\_%' escape '\\' and nspname <> '${PRIVATE_SCHEMA}'), '[]'::json),
  'unexpected_external_dependencies', coalesce((
    with aiq_objects(classid, objid) as (
      select 'pg_class'::regclass::oid, c.oid
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = '${PRIVATE_SCHEMA}'
      union all
      select 'pg_proc'::regclass::oid, p.oid
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = '${PRIVATE_SCHEMA}'
      union all
      select 'pg_type'::regclass::oid, t.oid
      from pg_type t join pg_namespace n on n.oid = t.typnamespace
      where n.nspname = '${PRIVATE_SCHEMA}'
      union all
      select 'pg_constraint'::regclass::oid, c.oid
      from pg_constraint c join pg_namespace n on n.oid = c.connamespace
      where n.nspname = '${PRIVATE_SCHEMA}'
      union all
      select 'pg_class'::regclass::oid, c.oid
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('v', 'm') and c.relname in (${views})
      union all
      select 'pg_proc'::regclass::oid, p.oid
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname in (${functions})
    )
    select json_agg(identity order by identity) from (
      select distinct pg_describe_object(d.classid, d.objid, d.objsubid) as identity
      from pg_depend d join aiq_objects owned
        on owned.classid = d.refclassid and owned.objid = d.refobjid
      where not (
        (d.classid = 'pg_class'::regclass and exists (
          select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where c.oid = d.objid and n.nspname = '${PRIVATE_SCHEMA}'
        ))
        or (d.classid = 'pg_class'::regclass and exists (
          select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where c.reltoastrelid = d.objid and n.nspname = '${PRIVATE_SCHEMA}'
        ))
        or (d.classid = 'pg_proc'::regclass and exists (
          select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where p.oid = d.objid and n.nspname = '${PRIVATE_SCHEMA}'
        ))
        or (d.classid = 'pg_type'::regclass and exists (
          select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
          where t.oid = d.objid and n.nspname = '${PRIVATE_SCHEMA}'
        ))
        or (d.classid = 'pg_type'::regclass and exists (
          select 1 from pg_type t join pg_class c on c.oid = t.typrelid
          join pg_namespace n on n.oid = c.relnamespace
          where t.oid = d.objid and n.nspname = 'public'
            and c.relkind in ('v', 'm') and c.relname in (${views})
        ))
        or (d.classid = 'pg_constraint'::regclass and exists (
          select 1 from pg_constraint c join pg_namespace n on n.oid = c.connamespace
          where c.oid = d.objid and n.nspname = '${PRIVATE_SCHEMA}'
        ))
        or (d.classid = 'pg_rewrite'::regclass and exists (
          select 1 from pg_rewrite r join pg_class c on c.oid = r.ev_class
          join pg_namespace n on n.oid = c.relnamespace
          where r.oid = d.objid and (
            n.nspname = '${PRIVATE_SCHEMA}'
            or (n.nspname = 'public' and c.relname in (${views}))
          )
        ))
        or (d.classid = 'pg_trigger'::regclass and exists (
          select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
          join pg_namespace n on n.oid = c.relnamespace
          where t.oid = d.objid and n.nspname = '${PRIVATE_SCHEMA}'
        ))
        or (d.classid = 'pg_attrdef'::regclass and exists (
          select 1 from pg_attrdef a join pg_class c on c.oid = a.adrelid
          join pg_namespace n on n.oid = c.relnamespace
          where a.oid = d.objid and n.nspname = '${PRIVATE_SCHEMA}'
        ))
        or (d.classid = 'pg_policy'::regclass and exists (
          select 1 from pg_policy p join pg_class c on c.oid = p.polrelid
          join pg_namespace n on n.oid = c.relnamespace
          where p.oid = d.objid and n.nspname = '${PRIVATE_SCHEMA}'
        ))
        or (d.classid = 'pg_proc'::regclass and exists (
          select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where p.oid = d.objid and n.nspname = 'public' and p.proname in (${functions})
        ))
      )
    ) dependency
  ), '[]'::json),
  'unexpected_public_functions', coalesce((select json_agg(distinct proname order by proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and proname like 'aiq\\_%' escape '\\' and proname not in (${functions})), '[]'::json),
  'unexpected_public_relations', coalesce((select json_agg(c.relname order by c.relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname like 'aiq\\_%' escape '\\'), '[]'::json),
  'unexpected_public_view_name_collisions', coalesce((select json_agg(c.relname order by c.relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname in (${views}) and c.relkind not in ('v','m')), '[]'::json),
  'unexpected_roles', coalesce((select json_agg(rolname order by rolname) from pg_roles where rolname like 'aiq\\_%' escape '\\' and rolname not in ('aiq_publisher', 'aiq_verifier')), '[]'::json),
  'unexpected_storage_buckets', coalesce((select json_agg(id order by id) from storage.buckets where (id like 'aiq-%' or name like 'aiq-%') and not (id = name and id in ('aiq-runner-artifacts', 'aiq-submission-packages'))), '[]'::json),
  'unexpected_role_memberships', coalesce((
    select json_agg(identity order by identity) from (
      select distinct format('%I is a member of %I', member.rolname, granted.rolname) as identity
      from pg_auth_members membership
      join pg_roles granted on granted.oid = membership.roleid
      join pg_roles member on member.oid = membership.member
      where (
        granted.rolname in ('aiq_publisher', 'aiq_verifier')
        or member.rolname in ('aiq_publisher', 'aiq_verifier')
      ) and not (
        member.rolname = 'authenticator'
        and granted.rolname in ('aiq_publisher', 'aiq_verifier')
      )
    ) role_membership
  ), '[]'::json),
  'unexpected_role_dependencies', coalesce((
    select json_agg(identity order by identity) from (
      select distinct pg_describe_object(d.classid, d.objid, d.objsubid) as identity
      from pg_shdepend d join pg_roles r on r.oid = d.refobjid
      where r.rolname in ('aiq_publisher', 'aiq_verifier')
        and d.deptype in ('a', 'o', 'r')
        and not (d.classid = 'pg_class'::regclass and exists (
          select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where c.oid = d.objid and (
            n.nspname = '${PRIVATE_SCHEMA}'
            or (n.nspname = 'public' and c.relkind in ('v', 'm') and c.relname in (${views}))
          )
        ))
        and not (d.classid = 'pg_proc'::regclass and exists (
          select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where p.oid = d.objid and (
            n.nspname = '${PRIVATE_SCHEMA}'
            or (n.nspname = 'public' and p.proname in (${functions}))
          )
        ))
        and not (d.deptype = 'r' and d.classid = 'pg_policy'::regclass and exists (
          select 1 from pg_policy p join pg_class c on c.oid = p.polrelid
          join pg_namespace n on n.oid = c.relnamespace
          where p.oid = d.objid and (p.polname, n.nspname, c.relname) in (${policies})
        ))
    ) dependency
  ), '[]'::json)
)`;
}

export function inventorySql(names: SchemaNames): string {
  return `select ${inventoryExpression(names)}::text;`;
}

export function cleanupSql(names: SchemaNames): string {
  const functionNames = names.functions.map(sqlLiteral).join(', ');
  const viewNames = names.views.map(sqlLiteral).join(', ');
  const guardedArrays = [
    'storage_buckets',
    'unexpected_namespaces',
    'unexpected_external_dependencies',
    'unexpected_public_functions',
    'unexpected_public_relations',
    'unexpected_public_view_name_collisions',
    'unexpected_roles',
    'unexpected_storage_buckets',
    'unexpected_role_memberships',
    'unexpected_role_dependencies',
  ]
    .map(sqlLiteral)
    .join(', ');
  return `\\set ON_ERROR_STOP on
begin;
select pg_advisory_xact_lock(hashtextextended('aiq-production-reset:${PROJECT_REF}', 0));
lock table pg_catalog.pg_depend, pg_catalog.pg_shdepend, pg_catalog.pg_auth_members,
  pg_catalog.pg_authid, pg_catalog.pg_proc, pg_catalog.pg_class,
  pg_catalog.pg_namespace in share mode;
lock table storage.buckets in share mode;
do $aiq_reset_relation_locks$
declare target record;
begin
  for target in
    select c.oid::regclass as identity
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p', 'v', 'm', 'f') and (
      n.nspname = '${PRIVATE_SCHEMA}'
      or (n.nspname = 'public' and c.relname in (${viewNames}))
    )
    order by c.oid
  loop
    execute format('lock table %s in access exclusive mode', target.identity);
  end loop;
end
$aiq_reset_relation_locks$;
do $aiq_reset_boundary_guard$
declare current_inventory json;
begin
  current_inventory := ${inventoryExpression(names)};
  if exists (
    select 1 from json_each(current_inventory) entry
    where entry.key in (${guardedArrays}) and json_array_length(entry.value) > 0
  ) then
    raise exception 'AIQ_RESET_BOUNDARY_CHANGED' using errcode = '55000';
  end if;
end
$aiq_reset_boundary_guard$;
-- AIQ_RESET_BOUNDARY_LOCKED
do $aiq_reset_functions$
declare target record;
begin
  for target in
    select p.oid::regprocedure as identity
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (${functionNames})
  loop
    execute format('drop function %s', target.identity);
  end loop;
end
$aiq_reset_functions$;
do $aiq_reset_views$
declare target record;
begin
  for target in
    select c.relname, c.relkind
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('v', 'm')
      and c.relname in (${viewNames})
  loop
    if target.relkind = 'm' then
      execute format('drop materialized view public.%I', target.relname);
    else
      execute format('drop view public.%I', target.relname);
    end if;
  end loop;
end
$aiq_reset_views$;
-- The boundary guard and retained catalog/object locks confine this cascade to
-- dependencies inside the canonical AIQ surface.
drop schema if exists ${PRIVATE_SCHEMA} cascade;
drop role if exists aiq_publisher;
drop role if exists aiq_verifier;
commit;`;
}

function parseInventory(output: string): DatabaseInventory {
  let value: unknown;
  try {
    value = JSON.parse(output.trim()) as unknown;
  } catch {
    throw new Error('AIQ database inventory did not return one JSON document');
  }
  if (!isRecord(value) || typeof value.schema_exists !== 'boolean') {
    throw new Error('AIQ database inventory has an invalid shape');
  }
  const roles = stringList(value.roles);
  const publicFunctions = stringList(value.public_functions);
  const publicViews = stringList(value.public_views);
  const unexpectedNamespaces = stringList(value.unexpected_namespaces);
  const unexpectedExternalDependencies = stringList(value.unexpected_external_dependencies);
  const unexpectedPublicFunctions = stringList(value.unexpected_public_functions);
  const unexpectedPublicRelations = stringList(value.unexpected_public_relations);
  const unexpectedPublicViewNameCollisions = stringList(
    value.unexpected_public_view_name_collisions,
  );
  const unexpectedRoles = stringList(value.unexpected_roles);
  const unexpectedStorageBuckets = stringList(value.unexpected_storage_buckets);
  const unexpectedRoleMemberships = stringList(value.unexpected_role_memberships);
  const unexpectedRoleDependencies = stringList(value.unexpected_role_dependencies);
  if (
    roles === undefined ||
    publicFunctions === undefined ||
    publicViews === undefined ||
    unexpectedNamespaces === undefined ||
    unexpectedExternalDependencies === undefined ||
    unexpectedPublicFunctions === undefined ||
    unexpectedPublicRelations === undefined ||
    unexpectedPublicViewNameCollisions === undefined ||
    unexpectedRoles === undefined ||
    unexpectedStorageBuckets === undefined ||
    unexpectedRoleMemberships === undefined ||
    unexpectedRoleDependencies === undefined ||
    !Array.isArray(value.storage_buckets)
  ) {
    throw new Error('AIQ database inventory has an invalid shape');
  }
  const storageBuckets: { id: string; name: string }[] = [];
  for (const bucket of Array.from<unknown>(value.storage_buckets)) {
    if (!isRecord(bucket) || typeof bucket.id !== 'string' || typeof bucket.name !== 'string') {
      throw new Error('AIQ database inventory has an invalid Storage bucket');
    }
    storageBuckets.push({ id: bucket.id, name: bucket.name });
  }
  return {
    schema_exists: value.schema_exists,
    roles,
    public_functions: publicFunctions,
    public_views: publicViews,
    storage_buckets: storageBuckets,
    unexpected_namespaces: unexpectedNamespaces,
    unexpected_external_dependencies: unexpectedExternalDependencies,
    unexpected_public_functions: unexpectedPublicFunctions,
    unexpected_public_relations: unexpectedPublicRelations,
    unexpected_public_view_name_collisions: unexpectedPublicViewNameCollisions,
    unexpected_roles: unexpectedRoles,
    unexpected_storage_buckets: unexpectedStorageBuckets,
    unexpected_role_memberships: unexpectedRoleMemberships,
    unexpected_role_dependencies: unexpectedRoleDependencies,
  };
}

function storageHeaders(token: string): HeadersInit {
  return { apikey: token, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function storageRequest(
  fetchImplementation: typeof fetch,
  token: string,
  path: string,
  init: RequestInit,
): Promise<Response> {
  const response = await fetchImplementation(`${STORAGE_ORIGIN}/storage/v1${path}`, {
    ...init,
    headers: storageHeaders(token),
  });
  if (!response.ok)
    throw new Error(`Supabase Storage API rejected ${init.method ?? 'GET'} ${path}`);
  return response;
}

async function listBucket(
  fetchImplementation: typeof fetch,
  token: string,
  bucket: (typeof BUCKETS)[number],
): Promise<string[]> {
  const pendingPrefixes = [''];
  const objects: string[] = [];
  let pages = 0;
  while (pendingPrefixes.length > 0) {
    const prefix = pendingPrefixes.shift() ?? '';
    for (let offset = 0; ; offset += PAGE_SIZE) {
      pages += 1;
      if (pages > MAX_PAGES_PER_BUCKET)
        throw new Error(`Storage inventory for ${bucket} exceeded its page bound`);
      // Pagination for one prefix is ordered and must be sequential.
      // eslint-disable-next-line no-await-in-loop
      const response = await storageRequest(fetchImplementation, token, `/object/list/${bucket}`, {
        method: 'POST',
        body: JSON.stringify({
          prefix,
          limit: PAGE_SIZE,
          offset,
          sortBy: { column: 'name', order: 'asc' },
        }),
      });
      // JSON parsing is sequential with the corresponding page request.
      // eslint-disable-next-line no-await-in-loop
      const pageValue: unknown = await response.json();
      if (!Array.isArray(pageValue)) throw new Error(`Storage inventory for ${bucket} is invalid`);
      const page = Array.from<unknown>(pageValue);
      for (const entry of page) {
        if (
          !isRecord(entry) ||
          typeof entry.name !== 'string' ||
          entry.name === '' ||
          entry.name.includes('/')
        ) {
          throw new Error(`Storage inventory for ${bucket} contains an invalid path segment`);
        }
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.id == null && entry.metadata == null) pendingPrefixes.push(path);
        else objects.push(path);
      }
      if (page.length < PAGE_SIZE) break;
    }
  }
  return objects.toSorted();
}

function summarizeStoragePaths(paths: readonly string[]): {
  readonly object_count: number;
  readonly object_paths_sha256: string;
} {
  return {
    object_count: paths.length,
    object_paths_sha256: `sha256:${createHash('sha256').update(JSON.stringify(paths)).digest('hex')}`,
  };
}

async function mapBounded<T>(
  values: readonly T[],
  concurrency: number,
  action: (value: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (next < values.length) {
        const value = values[next];
        next += 1;
        // Each worker is sequential. The worker count is the concurrency bound.
        // eslint-disable-next-line no-await-in-loop
        if (value !== undefined) await action(value);
      }
    }),
  );
  if (results.some(({ status }) => status === 'rejected')) {
    throw new Error('One or more bounded Storage requests failed');
  }
}

async function emptyAndDeleteBucket(
  fetchImplementation: typeof fetch,
  token: string,
  bucket: (typeof BUCKETS)[number],
  paths: readonly string[],
): Promise<void> {
  const batches: string[][] = [];
  for (let index = 0; index < paths.length; index += DELETE_BATCH_SIZE) {
    batches.push(paths.slice(index, index + DELETE_BATCH_SIZE));
  }
  try {
    await mapBounded(batches, DELETE_CONCURRENCY, async (prefixes) => {
      await storageRequest(fetchImplementation, token, `/object/${bucket}`, {
        method: 'DELETE',
        body: JSON.stringify({ prefixes }),
      });
    });
  } catch {
    // Read back after all workers settle. A failed response can follow a completed delete.
  }
  const remaining = await listBucket(fetchImplementation, token, bucket);
  if (remaining.length !== 0) {
    throw new Error(
      `Storage deletion for ${bucket} was partial; ${remaining.length} objects remain; rerun the reset`,
    );
  }
  await storageRequest(fetchImplementation, token, `/bucket/${bucket}`, { method: 'DELETE' });
}

export async function resetDatabase(options: {
  readonly confirmation?: string;
  readonly dryRun: boolean;
  readonly environment?: NodeJS.ProcessEnv;
  readonly referencePath?: string;
  readonly repositoryRoot?: string;
  readonly dependencies?: ResetDependencies;
}): Promise<ResetInventory | ResetReceipt> {
  const environment = options.environment ?? process.env;
  const databaseUrl = environment.AIQ_DATABASE_URL;
  if (databaseUrl === undefined) throw new Error('AIQ_DATABASE_URL is required');
  assertDatabaseTarget(databaseUrl, environment);
  if (!options.dryRun && options.confirmation !== CONFIRMATION) {
    throw new Error(`Destructive reset requires --confirm ${CONFIRMATION}`);
  }
  if (!options.dryRun && !options.referencePath)
    throw new Error('A production reference is required for reset and initialization');
  const repositoryRoot = options.repositoryRoot ?? resolve(import.meta.dirname, '..');
  let preparedInitialization: PreparedInitialization | undefined;
  if (!options.dryRun) {
    const referencePath = options.referencePath;
    if (referencePath === undefined)
      throw new Error('A production reference is required for reset and initialization');
    preparedInitialization = await (
      options.dependencies?.prepare ?? prepareInitializationFromFiles
    )({ referencePath, repositoryRoot });
  }
  const storageToken = environment.AIQ_SUPABASE_SERVICE_ROLE_KEY;
  if (!storageToken)
    throw new Error('AIQ_SUPABASE_SERVICE_ROLE_KEY is required for Storage inventory');
  const schema =
    preparedInitialization?.schema ??
    (await readFile(resolve(repositoryRoot, 'databases/schema.sql'), 'utf8'));
  const names = canonicalSchemaNames(schema);
  const psqlCommand = options.dependencies?.psqlCommand ?? 'psql';
  const database = parseInventory(
    await runPsql(psqlCommand, databaseUrl, inventorySql(names), environment),
  );
  if (database.storage_buckets.some(({ id, name }) => id !== name || !BUCKET_SET.has(id))) {
    throw new Error('AIQ Storage bucket identity drift is outside the reset ownership boundary');
  }
  if (
    database.unexpected_namespaces.length > 0 ||
    database.unexpected_external_dependencies.length > 0 ||
    database.unexpected_public_functions.length > 0 ||
    database.unexpected_public_relations.length > 0 ||
    database.unexpected_public_view_name_collisions.length > 0 ||
    database.unexpected_roles.length > 0 ||
    database.unexpected_storage_buckets.length > 0 ||
    database.unexpected_role_memberships.length > 0 ||
    database.unexpected_role_dependencies.length > 0
  ) {
    throw new Error('AIQ namespace drift is outside the reset ownership boundary');
  }
  const fetchImplementation = options.dependencies?.fetch ?? fetch;
  const existingBuckets = new Set(database.storage_buckets.map(({ id }) => id));
  const storageEntries = await Promise.all(
    BUCKETS.map(
      async (bucket) =>
        [
          bucket,
          existingBuckets.has(bucket)
            ? await listBucket(fetchImplementation, storageToken, bucket)
            : [],
        ] as const,
    ),
  );
  const storagePaths: Readonly<Record<(typeof BUCKETS)[number], readonly string[]>> = {
    'aiq-runner-artifacts':
      storageEntries.find(([bucket]) => bucket === 'aiq-runner-artifacts')?.[1] ?? [],
    'aiq-submission-packages':
      storageEntries.find(([bucket]) => bucket === 'aiq-submission-packages')?.[1] ?? [],
  };
  const storage: ResetInventory['storage'] = {
    'aiq-runner-artifacts': summarizeStoragePaths(storagePaths['aiq-runner-artifacts']),
    'aiq-submission-packages': summarizeStoragePaths(storagePaths['aiq-submission-packages']),
  };
  const inventory: ResetInventory = {
    project_ref: PROJECT_REF,
    namespace: PRIVATE_SCHEMA,
    database,
    storage,
  };
  if (options.dryRun) return inventory;

  for (const bucket of BUCKETS) {
    // The fixed order bounds partial failure and makes a retry resume at the remaining bucket.
    if (existingBuckets.has(bucket))
      // eslint-disable-next-line no-await-in-loop
      await emptyAndDeleteBucket(fetchImplementation, storageToken, bucket, storagePaths[bucket]);
  }
  const storageReadback = parseInventory(
    await runPsql(psqlCommand, databaseUrl, inventorySql(names), environment),
  );
  if (storageReadback.storage_buckets.length > 0) {
    throw new Error(
      'Storage bucket readback found remaining AIQ buckets; PostgreSQL did not change',
    );
  }
  if (
    storageReadback.unexpected_namespaces.length > 0 ||
    storageReadback.unexpected_external_dependencies.length > 0 ||
    storageReadback.unexpected_public_functions.length > 0 ||
    storageReadback.unexpected_public_relations.length > 0 ||
    storageReadback.unexpected_public_view_name_collisions.length > 0 ||
    storageReadback.unexpected_roles.length > 0 ||
    storageReadback.unexpected_storage_buckets.length > 0 ||
    storageReadback.unexpected_role_memberships.length > 0 ||
    storageReadback.unexpected_role_dependencies.length > 0
  ) {
    throw new Error(
      'AIQ namespace drift changed during Storage deletion; PostgreSQL did not change',
    );
  }
  await runPsql(psqlCommand, databaseUrl, cleanupSql(names), environment);
  const readback = parseInventory(
    await runPsql(psqlCommand, databaseUrl, inventorySql(names), environment),
  );
  if (
    readback.schema_exists ||
    readback.roles.length > 0 ||
    readback.public_functions.length > 0 ||
    readback.public_views.length > 0 ||
    readback.storage_buckets.length > 0 ||
    readback.unexpected_namespaces.length > 0 ||
    readback.unexpected_external_dependencies.length > 0 ||
    readback.unexpected_public_functions.length > 0 ||
    readback.unexpected_public_relations.length > 0 ||
    readback.unexpected_public_view_name_collisions.length > 0 ||
    readback.unexpected_roles.length > 0 ||
    readback.unexpected_storage_buckets.length > 0 ||
    readback.unexpected_role_memberships.length > 0 ||
    readback.unexpected_role_dependencies.length > 0
  ) {
    throw new Error(
      'Database cleanup readback found remaining AIQ objects; initialization did not start',
    );
  }
  const referencePath = options.referencePath;
  if (referencePath === undefined || preparedInitialization === undefined)
    throw new Error('A production reference is required for reset and initialization');
  const initialization = await (options.dependencies?.initialize ?? initializeDatabase)({
    referencePath,
    environment,
    preparedInitialization,
    psqlCommand,
    repositoryRoot,
  });
  return {
    schema_version: 'aiq.production-reset-receipt.v1',
    reset: true,
    inventory,
    initialization,
  };
}

function parseArguments(args: readonly string[]): {
  dryRun: boolean;
  confirmation: string | undefined;
  referencePath: string | undefined;
  help: boolean;
} {
  if (args.length === 1 && args[0] === '--help')
    return { dryRun: true, confirmation: undefined, referencePath: undefined, help: true };
  let dryRun = false;
  let confirmation: string | undefined;
  let referencePath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--') continue;
    if (argument === '--help')
      return { dryRun: true, confirmation: undefined, referencePath: undefined, help: true };
    if (argument === '--dry-run') dryRun = true;
    else if (argument === '--confirm') confirmation = args[++index];
    else if (argument === '--reference') referencePath = args[++index];
    else
      throw new Error(
        'Usage: node databases/reset.ts [--dry-run] [--confirm PROJECT_REF:aiq_private] [--reference PATH]',
      );
  }
  return { dryRun, confirmation, referencePath, help: false };
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  try {
    const argumentsValue = parseArguments(process.argv.slice(2));
    if (argumentsValue.help)
      process.stdout.write(
        `Usage: node databases/reset.ts --dry-run | --confirm ${CONFIRMATION} --reference PATH\n`,
      );
    else {
      const referencePath = argumentsValue.referencePath ?? process.env.AIQ_PRODUCTION_REFERENCE;
      const resetOptions: Parameters<typeof resetDatabase>[0] = {
        dryRun: argumentsValue.dryRun,
        ...(argumentsValue.confirmation === undefined
          ? {}
          : { confirmation: argumentsValue.confirmation }),
        ...(referencePath === undefined ? {} : { referencePath }),
      };
      const result = await resetDatabase(resetOptions);
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Database reset failed'}\n`);
    process.exitCode = 1;
  }
}
