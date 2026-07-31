import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

/* oxlint-disable typescript/no-unsafe-type-assertion -- Tests preserve raw adversarial response headers that Fetch normalizes or rejects. */

import {
  downloadExactPrivateStorageObject,
  findExactPrivateStorageObject,
  storeExactPrivateStorageObject,
  type PrivateStorageBucket,
  type SignedUrlProvider,
} from './private-storage-object.ts';

const origin = 'https://project.supabase.co';
const signedUrl = `${origin}/storage/v1/object/sign/private/sha256/digest?token=opaque`;

function provider(
  value: Readonly<{
    data: { signedUrl?: string } | null;
    error: unknown;
  }> = { data: { signedUrl }, error: null },
): SignedUrlProvider {
  return {
    createSignedUrl: async (_key, expiresIn) => {
      assert.equal(expiresIn, 60);
      return value;
    },
  };
}

function responseWithRawContentLength(body: Uint8Array, contentLength: string): Response {
  const response = new Response(Uint8Array.from(body).buffer);
  return {
    ok: response.ok,
    body: response.body,
    headers: {
      get(name: string) {
        return name.toLowerCase() === 'content-length' ? contentLength : response.headers.get(name);
      },
    },
  } as Response;
}

void describe('exact private Storage object download', () => {
  void it('uses a same-origin short-lived signed URL and returns exact bytes', async () => {
    const expected = Buffer.from('exact-private-object');
    let observedUrl = '';
    const result = await downloadExactPrivateStorageObject({
      bucket: provider(),
      key: 'sha256/digest',
      expectedBytes: expected.length,
      serviceOrigin: origin,
      fetchImplementation: async (input) => {
        observedUrl =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        return new Response(expected, {
          status: 200,
          headers: { 'content-length': String(expected.length) },
        });
      },
    });

    assert.deepEqual(Buffer.from(result), expected);
    assert.equal(observedUrl, signedUrl);
  });

  void it('distinguishes an exact missing-object response from upstream failure', async () => {
    const missing = await findExactPrivateStorageObject({
      bucket: provider({
        data: null,
        error: { status: 400, statusCode: '404' },
      }),
      key: 'missing',
      expectedBytes: 1,
      serviceOrigin: origin,
    });
    assert.deepEqual(missing, { kind: 'missing' });

    await assert.rejects(
      findExactPrivateStorageObject({
        bucket: provider({
          data: null,
          error: { status: 503, statusCode: '503' },
        }),
        key: 'unavailable',
        expectedBytes: 1,
        serviceOrigin: origin,
      }),
      /signed URL could not be created/,
    );
  });

  void it('stores missing bytes and verifies duplicate and conflict objects before upload', async () => {
    const expected = Buffer.from('immutable');
    const expectedDigest = createHash('sha256').update(expected).digest('hex');
    const scenarios = [
      {
        name: 'missing',
        signed: { data: null, error: { statusCode: '404' } },
        returnedBytes: expected,
        expectedDisposition: 'stored',
        expectedUploads: 1,
      },
      {
        name: 'duplicate',
        signed: { data: { signedUrl }, error: null },
        returnedBytes: expected,
        expectedDisposition: 'duplicate',
        expectedUploads: 0,
      },
      {
        name: 'conflict',
        signed: { data: { signedUrl }, error: null },
        returnedBytes: Buffer.from('different'),
        expectedDisposition: 'conflict',
        expectedUploads: 0,
      },
      {
        name: 'size-conflict',
        signed: { data: { signedUrl }, error: null },
        returnedBytes: Buffer.from('different-size'),
        expectedDisposition: 'conflict',
        expectedUploads: 0,
      },
    ] as const;

    await Promise.all(
      scenarios.map(async (scenario) => {
        let uploads = 0;
        const bucket: PrivateStorageBucket = {
          createSignedUrl: async () => scenario.signed,
          upload: async () => {
            uploads += 1;
            return { error: null };
          },
        };
        const disposition = await storeExactPrivateStorageObject({
          bucket,
          key: scenario.name,
          rawBytes: expected,
          expectedBytes: expected.length,
          expectedDigest,
          contentType: 'application/octet-stream',
          serviceOrigin: origin,
          fetchImplementation: async () =>
            new Response(scenario.returnedBytes, {
              headers: { 'content-length': String(scenario.returnedBytes.length) },
            }),
        });
        assert.equal(disposition, scenario.expectedDisposition);
        assert.equal(uploads, scenario.expectedUploads);
      }),
    );
  });

  void it('verifies a concurrent immutable upload winner after a local upload failure', async () => {
    const expected = Buffer.from('raced-object');
    const expectedDigest = createHash('sha256').update(expected).digest('hex');
    let signedCalls = 0;
    const bucket: PrivateStorageBucket = {
      createSignedUrl: async () => {
        signedCalls += 1;
        return signedCalls === 1
          ? { data: null, error: { statusCode: '404' } }
          : { data: { signedUrl }, error: null };
      },
      upload: async () => ({ error: { statusCode: '409' } }),
    };
    const disposition = await storeExactPrivateStorageObject({
      bucket,
      key: 'race',
      rawBytes: expected,
      expectedBytes: expected.length,
      expectedDigest,
      contentType: 'application/octet-stream',
      serviceOrigin: origin,
      fetchImplementation: async () =>
        new Response(expected, {
          headers: { 'content-length': String(expected.length) },
        }),
    });
    assert.equal(disposition, 'duplicate');
    assert.equal(signedCalls, 2);
  });

  void it('rejects cross-origin, credentialed, and non-Storage signed URLs before fetch', async () => {
    await Promise.all(
      [
        'https://attacker.invalid/storage/v1/object/sign/private/key?token=x',
        'https://user:password@project.supabase.co/storage/v1/object/sign/private/key?token=x',
        'https://project.supabase.co/rest/v1/private?token=x',
        'https://project.supabase.co/storage/v1/object/sign/private/key?token=x#fragment',
        'not-a-url',
      ].map(async (unsafe) => {
        let fetched = false;
        await assert.rejects(
          downloadExactPrivateStorageObject({
            bucket: provider({ data: { signedUrl: unsafe }, error: null }),
            key: 'key',
            expectedBytes: 1,
            serviceOrigin: origin,
            fetchImplementation: async () => {
              fetched = true;
              return new Response('x');
            },
          }),
          /outside the configured service boundary/,
        );
        assert.equal(fetched, false);
      }),
    );
  });

  void it('rejects missing URLs, invalid commitments, and non-success responses', async () => {
    await assert.rejects(
      downloadExactPrivateStorageObject({
        bucket: provider({ data: null, error: new Error('secret upstream detail') }),
        key: 'key',
        expectedBytes: 1,
        serviceOrigin: origin,
      }),
      /signed URL could not be created/,
    );
    await assert.rejects(
      downloadExactPrivateStorageObject({
        bucket: provider(),
        key: 'key',
        expectedBytes: 0,
        serviceOrigin: origin,
      }),
      /invalid committed byte count/,
    );
    await assert.rejects(
      downloadExactPrivateStorageObject({
        bucket: provider(),
        key: 'key',
        expectedBytes: 1,
        serviceOrigin: origin,
        fetchImplementation: async () => new Response('missing', { status: 404 }),
      }),
      /object is unavailable/,
    );
  });

  void it('rejects line terminators after private object digests and byte-count headers', async () => {
    const expected = Buffer.from('exact');
    const expectedDigest = createHash('sha256').update(expected).digest('hex');
    for (const suffix of ['\n', '\r\n', '\u2028', '\u2029']) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each immutable commitment case is independent.
      await assert.rejects(
        storeExactPrivateStorageObject({
          bucket: {
            createSignedUrl: async () => ({ data: null, error: { statusCode: '404' } }),
            upload: async () => ({ error: null }),
          },
          key: 'invalid-digest',
          rawBytes: expected,
          expectedBytes: expected.length,
          expectedDigest: `${expectedDigest}${suffix}`,
          contentType: 'application/octet-stream',
          serviceOrigin: origin,
        }),
        /content commitment/,
      );
    }
    for (const suffix of ['\n', '\r\n', '\u2028', '\u2029']) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each raw response-header case is independent.
      await assert.rejects(
        downloadExactPrivateStorageObject({
          bucket: provider(),
          key: 'invalid-length',
          expectedBytes: expected.length,
          serviceOrigin: origin,
          fetchImplementation: async () =>
            responseWithRawContentLength(expected, `${expected.length}${suffix}`),
        }),
        /byte count/,
      );
    }
  });

  void it('rejects declared, streamed, and truncated byte-count mismatches', async () => {
    const cases = [
      new Response('xx', { headers: { 'content-length': '2' } }),
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('xx'));
            controller.close();
          },
        }),
      ),
      new Response(''),
    ];
    await Promise.all(
      cases.map(async (response) => {
        await assert.rejects(
          downloadExactPrivateStorageObject({
            bucket: provider(),
            key: 'key',
            expectedBytes: 1,
            serviceOrigin: origin,
            fetchImplementation: async () => response,
          }),
          /byte count|could not be read/,
        );
      }),
    );
  });
});
