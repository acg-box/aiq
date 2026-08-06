import {
  inspectPublicSupabaseConfiguration,
  isSupabasePublicKey,
} from '../data/public-configuration.ts';
import { isAiqNodeId, isSupabaseRoleTokenKeyConfigured } from './supabase-role-token.ts';
import { AIQ_RUNNER_ARTIFACT_BUCKET, AIQ_SUBMISSION_PACKAGE_BUCKET } from './storage-buckets.ts';

export type RuntimeMode = 'production' | 'non_production' | 'unknown';

export interface ValidatedSubmissionConfiguration {
  serviceUrl: string;
  secretKey: string;
  runnerToken: string;
  packageBucket: string;
}

export interface ValidatedArtifactIngressConfiguration {
  serviceUrl: string;
  secretKey: string;
  runnerToken: string;
  artifactBucket: string;
}

export interface ValidatedVerifierClaimConfiguration {
  serviceUrl: string;
  secretKey: string;
  verifierToken: string;
  publishableKey: string;
  privateJwk: string;
}

export interface ValidatedVerificationConfiguration {
  serviceUrl: string;
  verifierToken: string;
  publishableKey: string;
  privateJwk: string;
  publisherNodeId: string;
}

export interface ValidatedProductionConfiguration
  extends
    ValidatedSubmissionConfiguration,
    ValidatedArtifactIngressConfiguration,
    ValidatedVerifierClaimConfiguration,
    ValidatedVerificationConfiguration {
  publicUrl: string;
  publicPublishableKey: string;
}

export interface ConfigurationInspection<T> {
  mode: RuntimeMode;
  values?: T;
  issues: readonly string[];
}

export type ProductionConfiguration = ConfigurationInspection<ValidatedProductionConfiguration>;

type Environment = Readonly<Record<string, string | undefined>>;

const SECRET_KEY = /^sb_secret_[A-Za-z0-9_-]+(?![\s\S])/;
const VISIBLE_ASCII_SECRET = /^[\x21-\x7e]+(?![\s\S])/;

function runtimeMode(nodeEnvironment: string | undefined): RuntimeMode {
  if (nodeEnvironment === 'production') return 'production';
  if (nodeEnvironment === 'development' || nodeEnvironment === 'test') return 'non_production';
  return 'unknown';
}

function beginInspection(environment: Environment): {
  mode: RuntimeMode;
  issues: string[];
} {
  const mode = runtimeMode(environment.NODE_ENV?.trim());
  const issues: string[] = [];
  if (mode === 'unknown') issues.push('NODE_ENV must be production, development, or test');
  return { mode, issues };
}

function requiredValue(
  environment: Environment,
  name: string,
  issues: string[],
): string | undefined {
  const rawValue = environment[name];
  const value = rawValue?.trim();
  if (!value) {
    issues.push(`${name} is missing`);
    return undefined;
  }
  if (rawValue !== value) issues.push(`${name} must not contain leading or trailing whitespace`);
  return value;
}

function parseSupabaseUrl(
  name: string,
  value: string | undefined,
  mode: RuntimeMode,
  issues: string[],
): URL | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    const localHttp =
      mode === 'non_production' &&
      parsed.protocol === 'http:' &&
      (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
    if (parsed.protocol !== 'https:' && !localHttp) issues.push(`${name} must use HTTPS`);
    if (
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      (parsed.pathname !== '' && parsed.pathname !== '/')
    ) {
      issues.push(`${name} must be an origin without credentials, a path, a query, or a fragment`);
    }
    if (value !== parsed.origin) issues.push(`${name} must use its canonical origin form`);
    return parsed;
  } catch {
    issues.push(`${name} is not a valid absolute URL`);
    return undefined;
  }
}

function serviceUrl(
  environment: Environment,
  mode: RuntimeMode,
  issues: string[],
): string | undefined {
  return parseSupabaseUrl(
    'SUPABASE_URL',
    requiredValue(environment, 'SUPABASE_URL', issues),
    mode,
    issues,
  )?.origin;
}

function secretKey(environment: Environment, issues: string[]): string | undefined {
  const value = requiredValue(environment, 'SUPABASE_SECRET_KEY', issues);
  if (value && !SECRET_KEY.test(value)) {
    issues.push('SUPABASE_SECRET_KEY has an invalid secret-key shape');
  }
  return value;
}

function visibleToken(
  environment: Environment,
  name: string,
  issues: string[],
): string | undefined {
  const value = requiredValue(environment, name, issues);
  if (value && !VISIBLE_ASCII_SECRET.test(value)) {
    issues.push(`${name} must contain only visible ASCII characters without whitespace`);
  }
  return value;
}

function publishableKey(environment: Environment, issues: string[]): string | undefined {
  const value = requiredValue(environment, 'AIQ_SUPABASE_PUBLISHABLE_KEY', issues);
  if (value && !isSupabasePublicKey(value)) {
    issues.push('AIQ_SUPABASE_PUBLISHABLE_KEY has an invalid publishable-key shape');
  }
  return value;
}

function privateJwk(environment: Environment, issues: string[]): string | undefined {
  const value = requiredValue(environment, 'AIQ_SUPABASE_JWT_PRIVATE_JWK', issues);
  if (value && !isSupabaseRoleTokenKeyConfigured(value)) {
    issues.push('AIQ_SUPABASE_JWT_PRIVATE_JWK is not a valid private ES256 JWK');
  }
  return value;
}

function publisherNodeId(environment: Environment, issues: string[]): string | undefined {
  const value = requiredValue(environment, 'AIQ_PUBLISHER_NODE_ID', issues);
  if (value && !isAiqNodeId(value)) {
    issues.push('AIQ_PUBLISHER_NODE_ID is not a valid AIQ node ID');
  }
  if (environment.NEXT_PUBLIC_AIQ_PUBLISHER_NODE_ID !== undefined) {
    issues.push('AIQ_PUBLISHER_NODE_ID must not use a NEXT_PUBLIC client boundary');
  }
  return value;
}

function bucket(
  environment: Environment,
  name: string,
  expected: string,
  issues: string[],
): string | undefined {
  const value = requiredValue(environment, name, issues);
  if (value && value !== expected) issues.push(`${name} must be ${expected}`);
  return value;
}

function rejectCredentialReuse(
  entries: readonly (readonly [string, string | undefined])[],
  issues: string[],
  allowedPair?: readonly [string, string],
): void {
  const firstOwner = new Map<string, string>();
  for (const [name, value] of entries) {
    if (!value) continue;
    const owner = firstOwner.get(value);
    if (!owner) {
      firstOwner.set(value, name);
      continue;
    }
    if (allowedPair && owner === allowedPair[0] && name === allowedPair[1]) continue;
    issues.push(`${name} must not reuse ${owner}`);
  }
}

export function inspectSubmissionConfiguration(
  environment: Environment,
): ConfigurationInspection<ValidatedSubmissionConfiguration> {
  const inspection = beginInspection(environment);
  const url = serviceUrl(environment, inspection.mode, inspection.issues);
  const key = secretKey(environment, inspection.issues);
  const token = visibleToken(environment, 'AIQ_RUNNER_SUBMISSION_TOKEN', inspection.issues);
  const packageBucket = bucket(
    environment,
    'AIQ_SUBMISSION_PACKAGE_BUCKET',
    AIQ_SUBMISSION_PACKAGE_BUCKET,
    inspection.issues,
  );
  rejectCredentialReuse(
    [
      ['SUPABASE_SECRET_KEY', key],
      ['AIQ_RUNNER_SUBMISSION_TOKEN', token],
    ],
    inspection.issues,
  );
  if (inspection.issues.length || !url || !key || !token || !packageBucket) return inspection;
  return {
    ...inspection,
    values: { serviceUrl: url, secretKey: key, runnerToken: token, packageBucket },
  };
}

export function inspectArtifactIngressConfiguration(
  environment: Environment,
): ConfigurationInspection<ValidatedArtifactIngressConfiguration> {
  const inspection = beginInspection(environment);
  const url = serviceUrl(environment, inspection.mode, inspection.issues);
  const key = secretKey(environment, inspection.issues);
  const token = visibleToken(environment, 'AIQ_RUNNER_SUBMISSION_TOKEN', inspection.issues);
  const artifactBucket = bucket(
    environment,
    'AIQ_RUNNER_ARTIFACT_BUCKET',
    AIQ_RUNNER_ARTIFACT_BUCKET,
    inspection.issues,
  );
  rejectCredentialReuse(
    [
      ['SUPABASE_SECRET_KEY', key],
      ['AIQ_RUNNER_SUBMISSION_TOKEN', token],
    ],
    inspection.issues,
  );
  if (inspection.issues.length || !url || !key || !token || !artifactBucket) return inspection;
  return {
    ...inspection,
    values: { serviceUrl: url, secretKey: key, runnerToken: token, artifactBucket },
  };
}

export function inspectVerifierClaimConfiguration(
  environment: Environment,
): ConfigurationInspection<ValidatedVerifierClaimConfiguration> {
  const inspection = beginInspection(environment);
  const url = serviceUrl(environment, inspection.mode, inspection.issues);
  const key = secretKey(environment, inspection.issues);
  const token = visibleToken(environment, 'AIQ_VERIFIER_INGRESS_TOKEN', inspection.issues);
  const gatewayKey = publishableKey(environment, inspection.issues);
  const jwk = privateJwk(environment, inspection.issues);
  rejectCredentialReuse(
    [
      ['SUPABASE_SECRET_KEY', key],
      ['AIQ_VERIFIER_INGRESS_TOKEN', token],
      ['AIQ_SUPABASE_PUBLISHABLE_KEY', gatewayKey],
      ['AIQ_SUPABASE_JWT_PRIVATE_JWK', jwk],
    ],
    inspection.issues,
  );
  if (inspection.issues.length || !url || !key || !token || !gatewayKey || !jwk) return inspection;
  return {
    ...inspection,
    values: {
      serviceUrl: url,
      secretKey: key,
      verifierToken: token,
      publishableKey: gatewayKey,
      privateJwk: jwk,
    },
  };
}

export function inspectVerificationConfiguration(
  environment: Environment,
): ConfigurationInspection<ValidatedVerificationConfiguration> {
  const inspection = beginInspection(environment);
  const url = serviceUrl(environment, inspection.mode, inspection.issues);
  const token = visibleToken(environment, 'AIQ_VERIFIER_INGRESS_TOKEN', inspection.issues);
  const gatewayKey = publishableKey(environment, inspection.issues);
  const jwk = privateJwk(environment, inspection.issues);
  const nodeId = publisherNodeId(environment, inspection.issues);
  rejectCredentialReuse(
    [
      ['AIQ_VERIFIER_INGRESS_TOKEN', token],
      ['AIQ_SUPABASE_PUBLISHABLE_KEY', gatewayKey],
      ['AIQ_SUPABASE_JWT_PRIVATE_JWK', jwk],
    ],
    inspection.issues,
  );
  if (inspection.issues.length || !url || !token || !gatewayKey || !jwk || !nodeId) {
    return inspection;
  }
  return {
    ...inspection,
    values: {
      serviceUrl: url,
      verifierToken: token,
      publishableKey: gatewayKey,
      privateJwk: jwk,
      publisherNodeId: nodeId,
    },
  };
}

export function inspectProductionConfiguration(environment: Environment): ProductionConfiguration {
  const inspection = beginInspection(environment);
  const publicConfiguration = inspectPublicSupabaseConfiguration(environment);
  for (const issue of publicConfiguration.issues) {
    if (!inspection.issues.includes(issue)) inspection.issues.push(issue);
  }
  const publicUrl = publicConfiguration.url ? new URL(publicConfiguration.url) : undefined;
  const publicPublishableKey = requiredValue(
    environment,
    'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
    inspection.issues,
  );
  const url = serviceUrl(environment, inspection.mode, inspection.issues);
  const parsedServiceUrl = url ? new URL(url) : undefined;
  if (publicUrl && parsedServiceUrl && publicUrl.origin !== parsedServiceUrl.origin) {
    inspection.issues.push('SUPABASE_URL must match NEXT_PUBLIC_SUPABASE_URL');
  }
  const key = secretKey(environment, inspection.issues);
  const runnerToken = visibleToken(environment, 'AIQ_RUNNER_SUBMISSION_TOKEN', inspection.issues);
  const packageBucket = bucket(
    environment,
    'AIQ_SUBMISSION_PACKAGE_BUCKET',
    AIQ_SUBMISSION_PACKAGE_BUCKET,
    inspection.issues,
  );
  const artifactBucket = bucket(
    environment,
    'AIQ_RUNNER_ARTIFACT_BUCKET',
    AIQ_RUNNER_ARTIFACT_BUCKET,
    inspection.issues,
  );
  const verifierToken = visibleToken(environment, 'AIQ_VERIFIER_INGRESS_TOKEN', inspection.issues);
  const gatewayKey = publishableKey(environment, inspection.issues);
  const jwk = privateJwk(environment, inspection.issues);
  const nodeId = publisherNodeId(environment, inspection.issues);
  if (packageBucket && packageBucket === artifactBucket) {
    inspection.issues.push('package and artifact buckets must be distinct');
  }
  const allowLocalPublicApiKeyReuse =
    inspection.mode === 'non_production' &&
    publicUrl?.protocol === 'http:' &&
    parsedServiceUrl?.protocol === 'http:' &&
    (publicUrl.hostname === 'localhost' || publicUrl.hostname === '127.0.0.1') &&
    publicUrl.origin === parsedServiceUrl.origin;
  rejectCredentialReuse(
    [
      ['NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', publicPublishableKey],
      ['SUPABASE_SECRET_KEY', key],
      ['AIQ_RUNNER_SUBMISSION_TOKEN', runnerToken],
      ['AIQ_VERIFIER_INGRESS_TOKEN', verifierToken],
      ['AIQ_SUPABASE_PUBLISHABLE_KEY', gatewayKey],
      ['AIQ_SUPABASE_JWT_PRIVATE_JWK', jwk],
    ],
    inspection.issues,
    allowLocalPublicApiKeyReuse
      ? ['NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'AIQ_SUPABASE_PUBLISHABLE_KEY']
      : undefined,
  );
  if (
    inspection.issues.length ||
    !publicUrl ||
    !publicPublishableKey ||
    !url ||
    !key ||
    !runnerToken ||
    !packageBucket ||
    !artifactBucket ||
    !verifierToken ||
    !gatewayKey ||
    !jwk ||
    !nodeId
  ) {
    return inspection;
  }
  return {
    ...inspection,
    values: {
      publicUrl: publicUrl.origin,
      publicPublishableKey,
      serviceUrl: url,
      secretKey: key,
      runnerToken,
      verifierToken,
      publishableKey: gatewayKey,
      privateJwk: jwk,
      publisherNodeId: nodeId,
      packageBucket,
      artifactBucket,
    },
  };
}
