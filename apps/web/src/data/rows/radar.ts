import type {
  CapabilityRecordStatus,
  ObservationRecordStatus,
  ObservationState,
  RadarNode,
  SignatureStatus,
} from '../types.ts';
import { PUBLIC_VIEW_NAMES } from '../public-views.ts';
import {
  SHA256,
  isBoundedText,
  isTimestamp,
  isOptionalTimestamp,
  isCount,
  isPositiveCount,
  safeCountSum,
  groupIsComplete,
  isEnumValue,
} from './validation.ts';

export interface DistributedRadarRow {
  node_id: string;
  name: string;
  operator: string;
  public_key_fingerprint: string;
  registry_trust: RadarNode['registryTrust'];
  registry_status: RadarNode['registryStatus'];
  last_seen_at: string | null;
  synthetic: boolean;
  latest_capability_schema_version: string | null;
  latest_capability_hash: string | null;
  latest_capability_status: CapabilityRecordStatus | null;
  latest_capability_signature_status: SignatureStatus | null;
  latest_capability_observed_at: string | null;
  latest_observation_schema_version: string | null;
  latest_observation_state: ObservationState | null;
  latest_observation_sequence: number | null;
  latest_observation_hash: string | null;
  latest_observation_status: ObservationRecordStatus | null;
  latest_observation_signature_status: SignatureStatus | null;
  latest_observation_observed_at: string | null;
  latest_observation_provenance_hash: string | null;
  assignment_total_count: number;
  assignment_offered_count: number;
  assignment_accepted_count: number;
  assignment_running_count: number;
  assignment_completed_count: number;
  assignment_revoked_count: number;
  assignment_expired_count: number;
  receipt_total_count: number;
  receipt_received_count: number;
  receipt_accepted_count: number;
  receipt_rejected_count: number;
  receiver_verified_trusted_count: number;
  signed_untrusted_count: number;
  rejected_count: number;
  missing_count: number;
  aggregated_at: string | null;
}

const REGISTRY_TRUST = new Set([
  'unverified',
  'signed_community',
  'trusted_verified',
  'independently_reproduced',
]);

const REGISTRY_STATUS = new Set(['pending', 'active', 'degraded', 'offline', 'revoked']);

const CAPABILITY_STATUS = new Set(['declared', 'validated', 'rejected', 'expired']);

const SIGNATURE_STATUS = new Set(['unverified', 'verified', 'rejected']);

const OBSERVATION_STATE = new Set(['ready', 'busy', 'draining', 'degraded', 'offline']);

const OBSERVATION_STATUS = new Set(['observed', 'accepted', 'rejected', 'stale']);

const NODE_ID = /^node_[0-9a-f]{64}$/;

const CAPABILITY_SCHEMA = 'aiq.distributed-capability.v1';

const OBSERVATION_SCHEMA = 'aiq.distributed-observation.v1';

function isDistributedRadarRow(value: unknown): value is DistributedRadarRow {
  if (typeof value !== 'object' || value === null) return false;
  const get = (key: keyof DistributedRadarRow): unknown => Reflect.get(value, key);
  const capability = [
    get('latest_capability_schema_version'),
    get('latest_capability_hash'),
    get('latest_capability_status'),
    get('latest_capability_signature_status'),
    get('latest_capability_observed_at'),
  ];
  const observation = [
    get('latest_observation_schema_version'),
    get('latest_observation_state'),
    get('latest_observation_sequence'),
    get('latest_observation_hash'),
    get('latest_observation_status'),
    get('latest_observation_signature_status'),
    get('latest_observation_observed_at'),
    get('latest_observation_provenance_hash'),
  ];
  const counts: readonly (keyof DistributedRadarRow)[] = [
    'assignment_total_count',
    'assignment_offered_count',
    'assignment_accepted_count',
    'assignment_running_count',
    'assignment_completed_count',
    'assignment_revoked_count',
    'assignment_expired_count',
    'receipt_total_count',
    'receipt_received_count',
    'receipt_accepted_count',
    'receipt_rejected_count',
    'receiver_verified_trusted_count',
    'signed_untrusted_count',
    'rejected_count',
    'missing_count',
  ];
  const assignmentStatusCounts = [
    get('assignment_offered_count'),
    get('assignment_accepted_count'),
    get('assignment_running_count'),
    get('assignment_completed_count'),
    get('assignment_revoked_count'),
    get('assignment_expired_count'),
  ];
  const receiptStatusCounts = [
    get('receipt_received_count'),
    get('receipt_accepted_count'),
    get('receipt_rejected_count'),
  ];
  const aggregationCounts = [
    get('receiver_verified_trusted_count'),
    get('signed_untrusted_count'),
    get('rejected_count'),
    get('missing_count'),
  ];
  const assignmentStatusTotal = safeCountSum(assignmentStatusCounts);
  const receiptStatusTotal = safeCountSum(receiptStatusCounts);
  const aggregationTotal = safeCountSum(aggregationCounts);
  const synthetic = get('synthetic');
  const registryTrust = get('registry_trust');
  const capabilitySignature = get('latest_capability_signature_status');
  const observationSignature = get('latest_observation_signature_status');
  const trustedAggregationCount = get('receiver_verified_trusted_count');
  const aggregatedAt = get('aggregated_at');
  const nodeId = get('node_id');
  const publicKeyFingerprint = get('public_key_fingerprint');
  return (
    isBoundedText(nodeId) &&
    NODE_ID.test(nodeId) &&
    isBoundedText(get('name')) &&
    isBoundedText(get('operator')) &&
    typeof publicKeyFingerprint === 'string' &&
    SHA256.test(publicKeyFingerprint) &&
    isEnumValue(registryTrust, REGISTRY_TRUST) &&
    isEnumValue(get('registry_status'), REGISTRY_STATUS) &&
    isOptionalTimestamp(get('last_seen_at')) &&
    typeof synthetic === 'boolean' &&
    groupIsComplete(capability) &&
    (capability[0] === null ||
      (capability[0] === CAPABILITY_SCHEMA &&
        typeof capability[1] === 'string' &&
        SHA256.test(capability[1]) &&
        typeof capability[2] === 'string' &&
        CAPABILITY_STATUS.has(capability[2]) &&
        typeof capability[3] === 'string' &&
        SIGNATURE_STATUS.has(capability[3]) &&
        isTimestamp(capability[4]))) &&
    groupIsComplete(observation) &&
    (observation[0] === null ||
      (observation[0] === OBSERVATION_SCHEMA &&
        typeof observation[1] === 'string' &&
        OBSERVATION_STATE.has(observation[1]) &&
        isPositiveCount(observation[2]) &&
        typeof observation[3] === 'string' &&
        SHA256.test(observation[3]) &&
        typeof observation[4] === 'string' &&
        OBSERVATION_STATUS.has(observation[4]) &&
        typeof observation[5] === 'string' &&
        SIGNATURE_STATUS.has(observation[5]) &&
        isTimestamp(observation[6]) &&
        typeof observation[7] === 'string' &&
        SHA256.test(observation[7]))) &&
    counts.every((key) => isCount(get(key))) &&
    assignmentStatusTotal === get('assignment_total_count') &&
    receiptStatusTotal === get('receipt_total_count') &&
    aggregationTotal !== null &&
    isOptionalTimestamp(aggregatedAt) &&
    ((aggregationTotal === 0 && aggregatedAt === null) ||
      (aggregationTotal > 0 && isTimestamp(aggregatedAt))) &&
    (!synthetic ||
      (registryTrust === 'unverified' &&
        capabilitySignature !== 'verified' &&
        observationSignature !== 'verified' &&
        trustedAggregationCount === 0))
  );
}

function requireRadarValue<Value>(value: Value | null): Value {
  if (value === null) {
    throw new Error(`Cannot read ${PUBLIC_VIEW_NAMES.distributedRadar}: incomplete response row`);
  }
  return value;
}

export function parseDistributedRadarRows(value: unknown): readonly RadarNode[] {
  if (!Array.isArray(value) || !value.every(isDistributedRadarRow)) {
    throw new Error(`Cannot read ${PUBLIC_VIEW_NAMES.distributedRadar}: invalid response shape`);
  }
  return value.map((row) => ({
    id: row.node_id,
    name: row.name,
    operator: row.operator,
    publicKeyFingerprint: row.public_key_fingerprint,
    registryTrust: row.registry_trust,
    registryStatus: row.registry_status,
    registryLastSeenAt: row.last_seen_at,
    latestCapability:
      row.latest_capability_schema_version === null
        ? null
        : {
            schemaVersion: row.latest_capability_schema_version,
            contentHash: requireRadarValue(row.latest_capability_hash),
            status: requireRadarValue(row.latest_capability_status),
            signatureStatus: requireRadarValue(row.latest_capability_signature_status),
            observedAt: requireRadarValue(row.latest_capability_observed_at),
          },
    latestObservation:
      row.latest_observation_schema_version === null
        ? null
        : {
            schemaVersion: row.latest_observation_schema_version,
            state: requireRadarValue(row.latest_observation_state),
            sequence: requireRadarValue(row.latest_observation_sequence),
            contentHash: requireRadarValue(row.latest_observation_hash),
            recordStatus: requireRadarValue(row.latest_observation_status),
            signatureStatus: requireRadarValue(row.latest_observation_signature_status),
            observedAt: requireRadarValue(row.latest_observation_observed_at),
            provenanceHash: requireRadarValue(row.latest_observation_provenance_hash),
          },
    assignmentCounts: {
      total: row.assignment_total_count,
      offered: row.assignment_offered_count,
      accepted: row.assignment_accepted_count,
      running: row.assignment_running_count,
      completed: row.assignment_completed_count,
      revoked: row.assignment_revoked_count,
      expired: row.assignment_expired_count,
    },
    receiptCounts: {
      total: row.receipt_total_count,
      received: row.receipt_received_count,
      accepted: row.receipt_accepted_count,
      rejected: row.receipt_rejected_count,
    },
    aggregation: {
      receiverVerifiedTrusted: row.receiver_verified_trusted_count,
      signedUntrusted: row.signed_untrusted_count,
      rejected: row.rejected_count,
      missing: row.missing_count,
      aggregatedAt: row.aggregated_at,
    },
    synthetic: row.synthetic,
  }));
}
