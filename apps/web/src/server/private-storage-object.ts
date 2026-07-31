import { createHash } from 'node:crypto';

import { createBoundedSupabaseFetch } from './supabase-http.ts';

const SIGNED_URL_TTL_SECONDS = 60;
const MAX_PRIVATE_OBJECT_BYTES = 4 * 1024 * 1024;

export interface SignedUrlProvider {
  createSignedUrl(
    key: string,
    expiresIn: number,
  ): Promise<{
    data: { signedUrl?: string } | null;
    error: unknown;
  }>;
}

export interface PrivateStorageBucket extends SignedUrlProvider {
  upload(
    key: string,
    body: Uint8Array,
    options: Readonly<{ contentType: string; upsert: false }>,
  ): Promise<{ error: unknown }>;
}

interface DownloadOptions {
  bucket: SignedUrlProvider;
  key: string;
  expectedBytes: number;
  serviceOrigin: string;
  parentSignal?: AbortSignal;
  fetchImplementation?: typeof fetch;
}

interface StoreOptions extends DownloadOptions {
  bucket: PrivateStorageBucket;
  rawBytes: Uint8Array;
  expectedDigest: string;
  contentType: string;
}

export type PrivateStorageObjectLookup = { kind: 'found'; bytes: Uint8Array } | { kind: 'missing' };

export type PrivateStorageStoreDisposition = 'stored' | 'duplicate' | 'conflict';

class PrivateStorageObjectCommitmentError extends Error {
  constructor() {
    super('Private Storage object byte count differs from its commitment.');
    this.name = 'PrivateStorageObjectCommitmentError';
  }
}

function canonicalExpectedBytes(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_PRIVATE_OBJECT_BYTES;
}

function validateSignedObjectUrl(value: string, serviceOrigin: string): URL {
  let signed: URL;
  let service: URL;
  try {
    signed = new URL(value);
    service = new URL(serviceOrigin);
  } catch {
    throw new Error('Private Storage signed URL is outside the configured service boundary.');
  }
  if (
    signed.origin !== service.origin ||
    signed.username ||
    signed.password ||
    signed.hash ||
    !signed.pathname.startsWith('/storage/v1/object/sign/')
  ) {
    throw new Error('Private Storage signed URL is outside the configured service boundary.');
  }
  return signed;
}

function missingObject(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const statusCode = 'statusCode' in error ? error.statusCode : undefined;
  return statusCode === 404 || statusCode === '404';
}

async function readExactBody(response: Response, expectedBytes: number): Promise<Uint8Array> {
  if (!response.ok || !response.body) {
    throw new Error('Private Storage object is unavailable.');
  }
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (
      !/^(0|[1-9][0-9]*)(?![\s\S])/.test(contentLength) ||
      !Number.isSafeInteger(declaredBytes) ||
      declaredBytes !== expectedBytes
    ) {
      await response.body.cancel();
      throw new PrivateStorageObjectCommitmentError();
    }
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  try {
    for (;;) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- A response stream must be read in order.
      const item = await reader.read();
      if (item.done) break;
      bytesRead += item.value.byteLength;
      if (bytesRead > expectedBytes) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Cancel the active sequential reader.
        await reader.cancel();
        throw new PrivateStorageObjectCommitmentError();
      }
      chunks.push(item.value);
    }
  } catch (error) {
    if (error instanceof PrivateStorageObjectCommitmentError) throw error;
    // oxlint-disable-next-line eslint/preserve-caught-error -- Do not retain upstream details.
    throw new Error('Private Storage object could not be read.');
  }
  if (bytesRead !== expectedBytes) {
    throw new PrivateStorageObjectCommitmentError();
  }
  return new Uint8Array(Buffer.concat(chunks, bytesRead));
}

async function signedObjectUrl({
  bucket,
  key,
  serviceOrigin,
  allowMissing,
}: Pick<DownloadOptions, 'bucket' | 'key' | 'serviceOrigin'> & {
  allowMissing: boolean;
}): Promise<URL | null> {
  const signed = await bucket.createSignedUrl(key, SIGNED_URL_TTL_SECONDS);
  if (signed.error) {
    if (allowMissing && missingObject(signed.error)) return null;
    throw new Error('Private Storage signed URL could not be created.');
  }
  if (!signed.data?.signedUrl) {
    throw new Error('Private Storage signed URL could not be created.');
  }
  return validateSignedObjectUrl(signed.data.signedUrl, serviceOrigin);
}

async function downloadSignedObject(
  signedUrl: URL,
  expectedBytes: number,
  parentSignal: AbortSignal | undefined,
  fetchImplementation: typeof fetch | undefined,
): Promise<Uint8Array> {
  const boundedFetch = fetchImplementation ?? createBoundedSupabaseFetch(parentSignal);
  const request: RequestInit = { cache: 'no-store' };
  if (parentSignal) request.signal = parentSignal;
  const response = await boundedFetch(signedUrl, request);
  return readExactBody(response, expectedBytes);
}

export async function downloadExactPrivateStorageObject({
  bucket,
  key,
  expectedBytes,
  serviceOrigin,
  parentSignal,
  fetchImplementation,
}: DownloadOptions): Promise<Uint8Array> {
  if (!canonicalExpectedBytes(expectedBytes)) {
    throw new Error('Private Storage object has an invalid committed byte count.');
  }
  const signedUrl = await signedObjectUrl({
    bucket,
    key,
    serviceOrigin,
    allowMissing: false,
  });
  if (!signedUrl) {
    throw new Error('Private Storage signed URL could not be created.');
  }
  return downloadSignedObject(signedUrl, expectedBytes, parentSignal, fetchImplementation);
}

export async function findExactPrivateStorageObject({
  bucket,
  key,
  expectedBytes,
  serviceOrigin,
  parentSignal,
  fetchImplementation,
}: DownloadOptions): Promise<PrivateStorageObjectLookup> {
  if (!canonicalExpectedBytes(expectedBytes)) {
    throw new Error('Private Storage object has an invalid committed byte count.');
  }
  const signedUrl = await signedObjectUrl({
    bucket,
    key,
    serviceOrigin,
    allowMissing: true,
  });
  if (!signedUrl) return { kind: 'missing' };
  return {
    kind: 'found',
    bytes: await downloadSignedObject(signedUrl, expectedBytes, parentSignal, fetchImplementation),
  };
}

function contentDisposition(bytes: Uint8Array, expectedDigest: string) {
  const digest = createHash('sha256').update(bytes).digest('hex');
  return digest === expectedDigest ? ('duplicate' as const) : ('conflict' as const);
}

export async function storeExactPrivateStorageObject({
  bucket,
  key,
  rawBytes,
  expectedBytes,
  expectedDigest,
  contentType,
  serviceOrigin,
  parentSignal,
  fetchImplementation,
}: StoreOptions): Promise<PrivateStorageStoreDisposition> {
  if (
    rawBytes.byteLength !== expectedBytes ||
    !/^[a-f0-9]{64}(?![\s\S])/.test(expectedDigest) ||
    contentDisposition(rawBytes, expectedDigest) !== 'duplicate'
  ) {
    throw new Error('Private Storage upload does not match its content commitment.');
  }
  let lookup: PrivateStorageObjectLookup;
  try {
    lookup = await findExactPrivateStorageObject({
      bucket,
      key,
      expectedBytes,
      serviceOrigin,
      ...(parentSignal ? { parentSignal } : {}),
      ...(fetchImplementation ? { fetchImplementation } : {}),
    });
  } catch (error) {
    if (error instanceof PrivateStorageObjectCommitmentError) return 'conflict';
    throw error;
  }
  if (lookup.kind === 'found') {
    return contentDisposition(lookup.bytes, expectedDigest);
  }

  const upload = await bucket.upload(key, rawBytes, { contentType, upsert: false });
  if (!upload.error) return 'stored';

  try {
    const racedBytes = await downloadExactPrivateStorageObject({
      bucket,
      key,
      expectedBytes,
      serviceOrigin,
      ...(parentSignal ? { parentSignal } : {}),
      ...(fetchImplementation ? { fetchImplementation } : {}),
    });
    return contentDisposition(racedBytes, expectedDigest);
  } catch (error) {
    if (error instanceof PrivateStorageObjectCommitmentError) return 'conflict';
    throw error;
  }
}
