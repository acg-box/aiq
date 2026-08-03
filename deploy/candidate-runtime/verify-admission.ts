import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type ObjectJson = { [key: string]: Json };

function json(value: unknown, label: string): Json {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item) => json(item, label));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, json(item, label)]));
  }
  throw new Error(`${label} is not JSON`);
}

function object(value: Json, label: string): ObjectJson {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function required(value: ObjectJson, key: string, label: string): Json {
  const result = value[key];
  if (result === undefined) throw new Error(`${label} is absent`);
  return result;
}

function canonical(value: Json): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return JSON.stringify(value);
    throw new Error('non-finite numbers are not JSON');
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${canonical(required(value, key, key))}`)
    .join(',')}}`;
}

function exactKeys(value: ObjectJson, expected: readonly string[], label: string): void {
  if (canonical(Object.keys(value).toSorted()) !== canonical([...expected].toSorted())) {
    throw new Error(`${label} has unsupported fields`);
  }
}

function digest(value: Json): string {
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
}

async function canonicalObjectFile(path: string, label: string): Promise<ObjectJson> {
  const source = await readFile(path, 'utf8');
  const parsed: unknown = JSON.parse(source);
  const value = object(json(parsed, label), label);
  const encoded = canonical(value);
  if (source !== encoded && source !== `${encoded}\n`) {
    throw new Error(`${label} is not canonical JSON`);
  }
  return value;
}

function canonicalBase64(value: Json, bytes: number, label: string): Buffer {
  if (typeof value !== 'string') throw new Error(`${label} is invalid`);
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== bytes || decoded.toString('base64') !== value) {
    throw new Error(`${label} is not canonical base64`);
  }
  return decoded;
}

async function main(): Promise<void> {
  if (process.argv.length !== 5) throw new Error('invalid invocation');
  const admissionPath = process.argv[2];
  const policyPath = process.argv[3];
  const pinPath = process.argv[4];
  if (admissionPath === undefined || policyPath === undefined || pinPath === undefined) {
    throw new Error('invalid invocation');
  }
  const admission = await canonicalObjectFile(admissionPath, 'admission');
  const policy = await canonicalObjectFile(policyPath, 'policy');
  const pin = (await readFile(pinPath, 'utf8')).trim();

  exactKeys(
    policy,
    ['schema_version', 'release_identity', 'authority_signers', 'promotion_signers'],
    'policy',
  );
  if (
    policy.schema_version !== 'aiq.release-gate-trust.v1' ||
    policy.release_identity !== 'aiq-core/1.0.2' ||
    digest(policy) !== pin ||
    !/^sha256:(?!0{64}$)[0-9a-f]{64}$/u.test(pin)
  )
    throw new Error('protected trust policy mismatch');

  const signerRef = object(required(admission, 'signer', 'admission signer'), 'admission signer');
  if (
    admission.schema_version !== 'aiq.release-gate-admission.v1' ||
    admission.signature_domain !== admission.schema_version ||
    admission.signature_encoding !== 'aiq.sorted-key-json.v1' ||
    admission.release_identity !== policy.release_identity ||
    signerRef.algorithm !== 'ed25519' ||
    typeof signerRef.key_id !== 'string' ||
    typeof admission.signature !== 'string'
  )
    throw new Error('admission identity mismatch');

  const authoritySigners = Array.isArray(policy.authority_signers) ? policy.authority_signers : [];
  const promotionSigners = Array.isArray(policy.promotion_signers) ? policy.promotion_signers : [];
  if (authoritySigners.length === 0 || promotionSigners.length === 0) {
    throw new Error('trust policy signer roles are empty');
  }
  const keyIds = new Set<string>();
  const fingerprints = new Set<string>();
  const validatedAuthority = authoritySigners.map((value) => object(value, 'authority signer'));
  for (const trusted of [
    ...validatedAuthority,
    ...promotionSigners.map((value) => object(value, 'promotion signer')),
  ]) {
    exactKeys(
      trusted,
      ['key_id', 'algorithm', 'public_key_spki_base64', 'public_key_fingerprint'],
      'trusted signer',
    );
    if (
      trusted.algorithm !== 'ed25519' ||
      typeof trusted.key_id !== 'string' ||
      !/^[a-z0-9][a-z0-9._-]*$/u.test(trusted.key_id) ||
      typeof trusted.public_key_spki_base64 !== 'string' ||
      typeof trusted.public_key_fingerprint !== 'string'
    )
      throw new Error('trusted signer is invalid');
    const der = canonicalBase64(trusted.public_key_spki_base64, 44, 'trusted signer key');
    const fingerprint = `sha256:${createHash('sha256').update(der).digest('hex')}`;
    if (
      !der.subarray(0, 12).equals(Buffer.from('302a300506032b6570032100', 'hex')) ||
      trusted.public_key_fingerprint !== fingerprint ||
      keyIds.has(trusted.key_id) ||
      fingerprints.has(fingerprint)
    )
      throw new Error('trusted signer identity is invalid');
    keyIds.add(trusted.key_id);
    fingerprints.add(fingerprint);
  }
  const matches = validatedAuthority.filter((value) => value.key_id === signerRef.key_id);
  if (matches.length !== 1) throw new Error('admission signer is not uniquely trusted');
  const trusted = matches[0];
  if (trusted === undefined) throw new Error('admission signer is absent');
  exactKeys(
    trusted,
    ['key_id', 'algorithm', 'public_key_spki_base64', 'public_key_fingerprint'],
    'authority signer',
  );
  if (trusted.algorithm !== 'ed25519' || typeof trusted.public_key_spki_base64 !== 'string') {
    throw new Error('trusted signer is invalid');
  }
  const keyBytes = canonicalBase64(trusted.public_key_spki_base64, 44, 'authority signer key');
  const key = createPublicKey({ key: keyBytes, format: 'der', type: 'spki' });
  const fingerprint = `sha256:${createHash('sha256').update(keyBytes).digest('hex')}`;
  if (key.asymmetricKeyType !== 'ed25519' || trusted.public_key_fingerprint !== fingerprint) {
    throw new Error('trusted signer fingerprint mismatch');
  }
  const unsigned = Object.fromEntries(
    Object.entries(admission).filter(([field]) => field !== 'signature'),
  );
  const signature = canonicalBase64(
    required(admission, 'signature', 'admission signature'),
    64,
    'admission signature',
  );
  if (!verify(null, Buffer.from(canonical(unsigned), 'utf8'), key, signature)) {
    throw new Error('admission signature is not trusted');
  }
  process.stdout.write('admission_trusted=true\n');
}

try {
  await main();
} catch {
  process.stderr.write('candidate admission trust verification failed\n');
  process.exitCode = 1;
}
