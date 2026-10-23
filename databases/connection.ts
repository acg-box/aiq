const PRODUCTION_SUPABASE_PROJECT_REF = 'xxnszykaeapolqdnhalx';

const PRODUCTION_DATABASE_POOLER_HOST = 'aws-0-ca-central-1.pooler.supabase.com';

const PRODUCTION_DATABASE_POOLER_USER = `postgres.${PRODUCTION_SUPABASE_PROJECT_REF}`;

export function databaseConnectionEnvironment(databaseUrl: string): NodeJS.ProcessEnv {
  const parsed = new URL(databaseUrl);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));

  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    parsed.hostname === '' ||
    database === '' ||
    parsed.hash !== ''
  ) {
    throw new Error('AIQ_DATABASE_URL must contain one PostgreSQL connection URL');
  }

  const result: NodeJS.ProcessEnv = {
    PGHOST: parsed.hostname.replace(/^\[(.*)]$/, '$1'),
    PGDATABASE: database,
  };
  if (parsed.port !== '') result.PGPORT = parsed.port;
  if (parsed.username !== '') result.PGUSER = decodeURIComponent(parsed.username);
  if (parsed.password !== '') result.PGPASSWORD = decodeURIComponent(parsed.password);

  const queryEnvironment = new Map([
    ['application_name', 'PGAPPNAME'],
    ['channel_binding', 'PGCHANNELBINDING'],
    ['connect_timeout', 'PGCONNECT_TIMEOUT'],
    ['gssencmode', 'PGGSSENCMODE'],
    ['krbsrvname', 'PGKRBSRVNAME'],
    ['options', 'PGOPTIONS'],
    ['sslcert', 'PGSSLCERT'],
    ['sslcrl', 'PGSSLCRL'],
    ['sslcrldir', 'PGSSLCRLDIR'],
    ['sslkey', 'PGSSLKEY'],
    ['sslmode', 'PGSSLMODE'],
    ['sslnegotiation', 'PGSSLNEGOTIATION'],
    ['sslpassword', 'PGSSLPASSWORD'],
    ['sslrootcert', 'PGSSLROOTCERT'],
    ['target_session_attrs', 'PGTARGETSESSIONATTRS'],
  ]);

  for (const [key, value] of parsed.searchParams) {
    const environmentName = queryEnvironment.get(key);
    if (environmentName === undefined || value === '') {
      throw new Error('AIQ_DATABASE_URL contains an unsupported connection option');
    }
    result[environmentName] = value;
  }

  return result;
}

export function assertDatabaseTarget(databaseUrl: string, environment: NodeJS.ProcessEnv): void {
  let parsed: URL;
  try {
    if (databaseUrl.length > 2048 || /\s/.test(databaseUrl)) throw new Error('invalid URL');
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('AIQ_DATABASE_URL must contain one PostgreSQL connection URL');
  }
  const postgresProtocol = parsed.protocol === 'postgres:' || parsed.protocol === 'postgresql:';
  const sessionPoolerProductionTarget =
    postgresProtocol &&
    parsed.hostname === PRODUCTION_DATABASE_POOLER_HOST &&
    parsed.pathname === '/postgres' &&
    parsed.port === '5432' &&
    parsed.username === PRODUCTION_DATABASE_POOLER_USER &&
    parsed.hash === '';
  if (sessionPoolerProductionTarget) return;
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  const localOverride =
    postgresProtocol &&
    parsed.pathname !== '' &&
    parsed.pathname !== '/' &&
    parsed.hash === '' &&
    environment.AIQ_DATABASE_ALLOW_LOCAL_TEST_TARGET === 'true' &&
    (environment.NODE_ENV === 'development' || environment.NODE_ENV === 'test') &&
    loopback;
  if (!localOverride) {
    throw new Error(
      `AIQ_DATABASE_URL must target Supabase project ${PRODUCTION_SUPABASE_PROJECT_REF} through its Session Pooler on port 5432`,
    );
  }
}
