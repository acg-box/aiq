import { rejects, strictEqual, throws } from 'node:assert';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import { databaseConnectionEnvironment } from './init.ts';
import { canonicalSchemaNames, cleanupSql, inventorySql } from './reset.ts';

const databaseUrl = process.env.AIQ_RESET_POSTGRES_URL;
const RESET_TEST_CONFIRMATION = 'delete-loopback-aiq-reset-fixture';
const confirmed = hasExactConfirmation(process.env.AIQ_RESET_POSTGRES_CONFIRM);
const enabled = databaseUrl !== undefined && databaseUrl !== '' && confirmed;
const root = resolve(import.meta.dirname, '..');

function hasExactConfirmation(value: string | undefined): boolean {
  return value === RESET_TEST_CONFIRMATION;
}

function stringListProperty(output: string, property: string): string[] {
  const parsed: unknown = JSON.parse(output);
  if (typeof parsed !== 'object' || parsed === null) throw new Error('inventory is not an object');
  const value: unknown = Reflect.get(parsed, property);
  if (!Array.isArray(value)) throw new Error(`inventory ${property} is not a string list`);
  const result: string[] = [];
  for (const item of Array.from<unknown>(value)) {
    if (typeof item !== 'string') throw new Error(`inventory ${property} is not a string list`);
    result.push(item);
  }
  return result;
}

function assertDisposableTarget(target: string): void {
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    throw new Error('AIQ_RESET_POSTGRES_URL must contain one PostgreSQL connection URL');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  const databaseName = decodeURIComponent(parsed.pathname.slice(1));
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    !loopback ||
    !/^aiq_reset_[a-z0-9_]+$/.test(databaseName)
  ) {
    throw new Error('AIQ reset integration tests require a loopback aiq_reset_* database');
  }
}

void test('PostgreSQL reset integration target gate accepts only loopback disposable names', () => {
  assertDisposableTarget('postgresql://postgres:test@127.0.0.1:5432/aiq_reset_fixture');
  throws(
    () => assertDisposableTarget('postgresql://postgres:test@db.example.com/aiq_reset_fixture'),
    /loopback aiq_reset_\* database/,
  );
  throws(
    () => assertDisposableTarget('postgresql://postgres:test@127.0.0.1:5432/postgres'),
    /loopback aiq_reset_\* database/,
  );
});

void test('PostgreSQL reset integration confirmation is exact', () => {
  strictEqual(hasExactConfirmation('delete-loopback-aiq-reset-fixture'), true);
  strictEqual(hasExactConfirmation('delete-loopback-aiq-reset-fixture '), false);
  strictEqual(hasExactConfirmation(undefined), false);
});

async function psql(sql: string): Promise<string> {
  if (!databaseUrl) throw new Error('AIQ_RESET_POSTGRES_URL is missing');
  return new Promise((resolvePromise, rejectPromise) => {
    const environment = databaseConnectionEnvironment(databaseUrl);
    if (process.env.PATH !== undefined) environment.PATH = process.env.PATH;
    const child = spawn(
      'psql',
      ['-X', '--no-psqlrc', '--quiet', '--tuples-only', '--no-align', '--set', 'ON_ERROR_STOP=1'],
      { env: environment, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', rejectPromise);
    child.on('close', (code) => {
      if (code === 0) resolvePromise(Buffer.concat(stdout).toString('utf8'));
      else
        rejectPromise(
          new Error(
            `disposable PostgreSQL reset fixture failed: ${Buffer.concat(stderr).toString('utf8')}`,
          ),
        );
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(sql);
  });
}

async function pauseCleanupAtBoundary(sql: string): Promise<() => Promise<void>> {
  if (!databaseUrl) throw new Error('AIQ_RESET_POSTGRES_URL is missing');
  const marker = '-- AIQ_RESET_BOUNDARY_LOCKED';
  const markerIndex = sql.indexOf(marker);
  if (markerIndex < 0) throw new Error('cleanup SQL does not contain its boundary marker');
  const splitIndex = markerIndex + marker.length;
  const environment = databaseConnectionEnvironment(databaseUrl);
  if (process.env.PATH !== undefined) environment.PATH = process.env.PATH;
  const child = spawn(
    'psql',
    ['-X', '--no-psqlrc', '--quiet', '--tuples-only', '--no-align', '--set', 'ON_ERROR_STOP=1'],
    { env: environment, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let closedCode: number | null | undefined;
  const closed = new Promise<void>((resolvePromise) => {
    child.on('close', (code) => {
      closedCode = code;
      resolvePromise();
    });
  });
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  const ready = new Promise<void>((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(
      () => rejectPromise(new Error('cleanup did not reach its locked boundary')),
      5_000,
    );
    child.stdout.on('data', (chunk: Buffer) => {
      stdout.push(chunk);
      if (Buffer.concat(stdout).includes('AIQ_BOUNDARY_READY')) {
        clearTimeout(timeout);
        resolvePromise();
      }
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    });
    child.on('close', () => {
      if (!Buffer.concat(stdout).includes('AIQ_BOUNDARY_READY')) {
        clearTimeout(timeout);
        rejectPromise(
          new Error(
            `cleanup closed before its boundary: ${Buffer.concat(stderr).toString('utf8')}`,
          ),
        );
      }
    });
  });
  child.stdin.write(`${sql.slice(0, splitIndex)}\nselect 'AIQ_BOUNDARY_READY';\n`);
  await ready;
  return async () => {
    child.stdin.end(sql.slice(splitIndex));
    await closed;
    if (closedCode !== 0) {
      throw new Error(`paused cleanup failed: ${Buffer.concat(stderr).toString('utf8')}`);
    }
  };
}

async function waitForBlockedQuery(pattern: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    // Polling is sequential because it observes one concurrent backend transition.
    // eslint-disable-next-line no-await-in-loop
    const blocked = await psql(`select count(*) from pg_stat_activity
where pid <> pg_backend_pid()
  and query like '${pattern.replaceAll("'", "''")}'
  and wait_event_type = 'Lock';`);
    if (blocked.trim() !== '0') return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise<void>((resolvePromise) => {
      setTimeout(resolvePromise, 10);
    });
  }
  throw new Error('concurrent PostgreSQL statement did not block on the reset boundary');
}

async function cleanupFixture(names: ReturnType<typeof canonicalSchemaNames>): Promise<void> {
  await psql(`drop view if exists public.reset_dependent_view;
do $reset_fixture_relation$
declare relation_kind "char";
begin
  select c.relkind into relation_kind
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'public_runs';
  if relation_kind = 'm' then
    execute 'drop materialized view public.public_runs';
  elsif relation_kind = 'v' then
    execute 'drop view public.public_runs';
  elsif relation_kind is not null then
    execute 'drop table public.public_runs cascade';
  end if;
end
$reset_fixture_relation$;
drop view if exists public.reset_unrelated_view;
drop function if exists public.reset_unrelated_function();
drop schema if exists reset_unrelated cascade;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'aiq_verifier')
    and exists (select 1 from pg_roles where rolname = 'reset_unrelated_user') then
    execute 'revoke aiq_verifier from reset_unrelated_user';
  end if;
  if exists (select 1 from pg_roles where rolname = 'aiq_publisher')
    and exists (select 1 from pg_roles where rolname = 'reset_unrelated_user') then
    execute 'revoke reset_unrelated_user from aiq_publisher';
  end if;
  if to_regclass('storage.buckets') is not null then
    delete from storage.buckets where id in (
      'aiq-runner-artifacts', 'aiq-submission-packages', 'reset-unrelated-bucket'
    );
  end if;
end $$;
${cleanupSql(names)}
drop role if exists reset_unrelated_user;`);
}

void test(
  'native PostgreSQL reset preserves unrelated objects and permits a fresh desired-state application',
  {
    skip: enabled
      ? false
      : `set AIQ_RESET_POSTGRES_URL to a loopback aiq_reset_* database and AIQ_RESET_POSTGRES_CONFIRM=${RESET_TEST_CONFIRMATION}`,
  },
  async () => {
    if (!databaseUrl) throw new Error('AIQ_RESET_POSTGRES_URL is missing');
    assertDisposableTarget(databaseUrl);
    const schema = await readFile(resolve(root, 'databases/schema.sql'), 'utf8');
    const names = canonicalSchemaNames(schema);
    await psql(`create schema if not exists storage;
create table if not exists storage.buckets (
  id text primary key, name text not null, public boolean not null default false
);
create table if not exists storage.objects (
  bucket_id text not null references storage.buckets(id) on delete cascade,
  name text not null,
  primary key (bucket_id, name)
);`);
    await cleanupFixture(names);
    try {
      await psql(`
create schema if not exists storage;
create table if not exists storage.buckets (id text primary key, name text not null, public boolean not null default false);
create table if not exists storage.objects (
  bucket_id text not null references storage.buckets(id) on delete cascade,
  name text not null,
  primary key (bucket_id, name)
);
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'reset_unrelated_user') then create role reset_unrelated_user login; end if;
end $$;
create schema if not exists reset_unrelated;
create table if not exists reset_unrelated.keep_table (id integer primary key);
create or replace view public.reset_unrelated_view as select 1::integer as value;
create or replace function public.reset_unrelated_function() returns integer language sql immutable as $$ select 1 $$;
insert into storage.buckets (id, name, public) values ('reset-unrelated-bucket', 'reset-unrelated-bucket', false) on conflict (id) do nothing;
${schema}`);

      const baselineInventory = (await psql(inventorySql(names))).trim();
      const baselineExternalDependencies = stringListProperty(
        baselineInventory,
        'unexpected_external_dependencies',
      );
      strictEqual(baselineExternalDependencies.length, 0, baselineExternalDependencies.join('\n'));
      strictEqual(stringListProperty(baselineInventory, 'unexpected_role_dependencies').length, 0);

      await psql(`grant aiq_verifier to reset_unrelated_user;
grant reset_unrelated_user to aiq_publisher;
delete from storage.buckets where id in ('aiq-runner-artifacts', 'aiq-submission-packages');`);
      const roleMemberships = stringListProperty(
        (await psql(inventorySql(names))).trim(),
        'unexpected_role_memberships',
      );
      strictEqual(
        roleMemberships.some((identity) =>
          identity.includes('reset_unrelated_user is a member of aiq_verifier'),
        ),
        true,
      );
      strictEqual(
        roleMemberships.some((identity) =>
          identity.includes('aiq_publisher is a member of reset_unrelated_user'),
        ),
        true,
      );
      await rejects(psql(cleanupSql(names)), /AIQ_RESET_BOUNDARY_CHANGED/);
      strictEqual(
        (
          await psql(`select count(*) from pg_auth_members membership
join pg_roles granted on granted.oid = membership.roleid
join pg_roles member on member.oid = membership.member
where (
  granted.rolname in ('aiq_publisher', 'aiq_verifier')
  or member.rolname in ('aiq_publisher', 'aiq_verifier')
) and not (
  member.rolname = 'authenticator'
  and granted.rolname in ('aiq_publisher', 'aiq_verifier')
);`)
        ).trim(),
        '2',
      );
      await psql(`revoke aiq_verifier from reset_unrelated_user;
revoke reset_unrelated_user from aiq_publisher;`);

      await psql(`alter table reset_unrelated.keep_table enable row level security;
create policy reset_external_aiq_role on reset_unrelated.keep_table
for select to aiq_verifier using (true);`);
      const policyDependencies = stringListProperty(
        (await psql(inventorySql(names))).trim(),
        'unexpected_role_dependencies',
      );
      strictEqual(
        policyDependencies.some((identity) => identity.includes('reset_external_aiq_role')),
        true,
      );
      await psql(`drop policy reset_external_aiq_role on reset_unrelated.keep_table;
alter table reset_unrelated.keep_table disable row level security;`);

      await psql(
        'create view public.reset_dependent_view as select count(*) from public.public_runs;',
      );
      const externalDependencies = stringListProperty(
        (await psql(inventorySql(names))).trim(),
        'unexpected_external_dependencies',
      );
      strictEqual(
        externalDependencies.some((identity) => identity.includes('reset_dependent_view')),
        true,
      );

      await psql('drop view public.reset_dependent_view;');
      const finishCleanup = await pauseCleanupAtBoundary(cleanupSql(names));
      const concurrentDependency = rejects(
        psql(
          'create view public.reset_dependent_view as select count(*) from aiq_private.aiq_runs;',
        ),
        /does not exist/,
      );
      await waitForBlockedQuery('create view public.reset_dependent_view%');
      await finishCleanup();
      await concurrentDependency;
      strictEqual(
        (await psql("select to_regclass('public.reset_dependent_view') is null;")).trim(),
        't',
      );
      await psql('create table public.public_runs (id integer primary key);');
      const viewNameCollisions = stringListProperty(
        (await psql(inventorySql(names))).trim(),
        'unexpected_public_view_name_collisions',
      );
      strictEqual(viewNameCollisions.includes('public_runs'), true);
      await psql(`drop table public.public_runs;
${schema}`);

      const result = await psql(`select json_build_object(
      'aiq_schema', to_regnamespace('aiq_private') is not null,
      'unrelated_table', to_regclass('reset_unrelated.keep_table') is not null,
      'unrelated_view', to_regclass('public.reset_unrelated_view') is not null,
      'unrelated_function', to_regprocedure('public.reset_unrelated_function()') is not null,
      'unrelated_role', exists(select 1 from pg_roles where rolname = 'reset_unrelated_user'),
      'unrelated_bucket', exists(select 1 from storage.buckets where id = 'reset-unrelated-bucket')
    )::text;`);
      strictEqual(
        result.trim(),
        '{"aiq_schema" : true, "unrelated_table" : true, "unrelated_view" : true, "unrelated_function" : true, "unrelated_role" : true, "unrelated_bucket" : true}',
      );
    } finally {
      await cleanupFixture(names);
    }
  },
);
