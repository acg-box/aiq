import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';

import {
  createBoundedSupabaseFetch,
  createSupabaseApiKeyFetch,
  createSupabaseRoleClientOptions,
  VERIFICATION_SUPABASE_HTTP_TIMEOUT_MS,
} from './supabase-http.ts';

void describe('bounded Supabase HTTP fetch', () => {
  void it('keeps its deadline active while a response body is still arriving', async (t) => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"ok":');
      const completion = setTimeout(() => response.end('true}'), 400);
      response.on('close', () => clearTimeout(completion));
    });
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const boundedFetch = createBoundedSupabaseFetch(undefined, {
      fetchImplementation: globalThis.fetch,
      timeoutMs: 150,
    });
    const response = await boundedFetch(`http://127.0.0.1:${address.port}/slow-body`);
    assert.equal(response.status, 200);
    await assert.rejects(
      response.json(),
      (error: unknown) =>
        error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name),
    );
  });

  void it('preserves Request headers while removing an API-key bearer fallback', async () => {
    let observedHeaders = new Headers();
    const fetchWithApiKey = createSupabaseApiKeyFetch(
      'publishable-test-key',
      undefined,
      async (_input, init) => {
        observedHeaders = new Headers(init?.headers);
        return new Response();
      },
    );
    const input = new Request('https://example.supabase.co/rest/v1/public_runs', {
      headers: {
        authorization: 'Bearer publishable-test-key',
        'x-client-info': 'request-client',
      },
    });
    await fetchWithApiKey(input);
    assert.equal(observedHeaders.get('x-client-info'), 'request-client');
    assert.equal(observedHeaders.get('apikey'), 'publishable-test-key');
    assert.equal(observedHeaders.has('authorization'), false);
    assert.equal(input.headers.get('authorization'), 'Bearer publishable-test-key');
  });

  void it('keeps ordinary calls at 10 seconds and verification RPCs at 120 seconds', async (t) => {
    assert.equal(VERIFICATION_SUPABASE_HTTP_TIMEOUT_MS, 120_000);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    t.mock.method(AbortSignal, 'timeout', (delay: number) => {
      const controller = new AbortController();
      setTimeout(
        () => controller.abort(new DOMException('Deadline reached', 'TimeoutError')),
        delay,
      );
      return controller.signal;
    });
    let observedSignal: AbortSignal | undefined;
    t.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      observedSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    });

    const ordinaryRequest = createBoundedSupabaseFetch()(
      'https://example.supabase.co/rest/v1/public_runs',
    );
    t.mock.timers.tick(9_999);
    assert.equal(observedSignal?.aborted, false);
    t.mock.timers.tick(1);
    await assert.rejects(ordinaryRequest, { name: 'SupabaseHttpTimeoutError' });

    const verificationRequest = createSupabaseRoleClientOptions(
      () => 'test-role',
      undefined,
      VERIFICATION_SUPABASE_HTTP_TIMEOUT_MS,
    ).global.fetch('https://example.supabase.co/rest/v1/rpc/aiq_stage_verifier_result');
    t.mock.timers.tick(119_999);
    assert.equal(observedSignal?.aborted, false);
    t.mock.timers.tick(1);
    await assert.rejects(verificationRequest, { name: 'SupabaseHttpTimeoutError' });

    const submissionRequest = createSupabaseApiKeyFetch(
      'private-test-key',
      undefined,
      globalThis.fetch,
      VERIFICATION_SUPABASE_HTTP_TIMEOUT_MS,
    )('https://example.supabase.co/rest/v1/rpc/aiq_enqueue_submission');
    t.mock.timers.tick(119_999);
    assert.equal(observedSignal?.aborted, false);
    t.mock.timers.tick(1);
    await assert.rejects(submissionRequest, { name: 'SupabaseHttpTimeoutError' });
  });

  void it('returns a successful response unchanged', async () => {
    const expected = Response.json({ ok: true }, { status: 201 });
    const boundedFetch = createBoundedSupabaseFetch(undefined, {
      fetchImplementation: async () => expected,
      timeoutMs: 100,
    });

    const actual = await boundedFetch('https://example.supabase.co/rest/v1/public_runs');

    assert.equal(actual, expected);
    assert.equal(actual.status, 201);
  });

  void it('rejects a hanging request at its deadline and aborts the fetch signal', async () => {
    let observedSignal: AbortSignal | undefined;
    const boundedFetch = createBoundedSupabaseFetch(undefined, {
      fetchImplementation: async (_input, init) => {
        observedSignal = init?.signal ?? undefined;
        return new Promise<Response>(() => {});
      },
      timeoutMs: 20,
    });

    await assert.rejects(
      boundedFetch('https://example.supabase.co/rest/v1/public_runs'),
      (error: unknown) =>
        error instanceof Error &&
        error.name === 'SupabaseHttpTimeoutError' &&
        error.message === 'Supabase request timed out.',
    );
    assert.equal(observedSignal?.aborted, true);
  });

  void it('preserves an external abort reason and forwards the abort to fetch', async () => {
    const controller = new AbortController();
    const reason = new Error('caller stopped the request');
    let observedSignal: AbortSignal | undefined;
    const boundedFetch = createBoundedSupabaseFetch(controller.signal, {
      fetchImplementation: async (_input, init) => {
        observedSignal = init?.signal ?? undefined;
        return new Promise<Response>(() => {});
      },
      timeoutMs: 1_000,
    });
    const request = boundedFetch('https://example.supabase.co/rest/v1/public_runs');

    controller.abort(reason);

    await assert.rejects(request, (error: unknown) => error === reason);
    assert.equal(observedSignal?.aborted, true);
    assert.equal(observedSignal?.reason, reason);
  });

  void it('does not start a request when its supplied signal is already aborted', async () => {
    const controller = new AbortController();
    const reason = new Error('request was already cancelled');
    let called = false;
    controller.abort(reason);
    const boundedFetch = createBoundedSupabaseFetch(undefined, {
      fetchImplementation: async () => {
        called = true;
        return new Response();
      },
      timeoutMs: 100,
    });

    await assert.rejects(
      boundedFetch('https://example.supabase.co/rest/v1/public_runs', {
        signal: controller.signal,
      }),
      (error: unknown) => error === reason,
    );
    assert.equal(called, false);
  });

  void it('does not expose request URLs, authorization values, or upstream errors', async () => {
    const secret = 'custom_role_token_do_not_disclose';
    const url = `https://example.supabase.co/rest/v1/private?token=${secret}`;
    const boundedFetch = createBoundedSupabaseFetch(undefined, {
      fetchImplementation: async () => {
        throw new Error(`network failure for ${url} with Bearer ${secret}`);
      },
      timeoutMs: 100,
    });

    let failure: unknown;
    try {
      await boundedFetch(url, { headers: { authorization: `Bearer ${secret}` } });
    } catch (error) {
      failure = error;
    }

    assert.ok(failure instanceof Error);
    assert.equal(failure.message, 'Supabase request failed.');
    assert.doesNotMatch(String(failure), /do_not_disclose|Bearer|token=/);
    assert.equal(failure.cause, undefined);
  });
});
