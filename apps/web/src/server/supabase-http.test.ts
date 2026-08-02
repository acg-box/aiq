import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createBoundedSupabaseFetchForTests } from './supabase-http.ts';

void describe('bounded Supabase HTTP fetch', () => {
  void it('returns a successful response unchanged', async () => {
    const expected = Response.json({ ok: true }, { status: 201 });
    const boundedFetch = createBoundedSupabaseFetchForTests({
      fetchImplementation: async () => expected,
      timeoutMs: 100,
    });

    const actual = await boundedFetch('https://example.supabase.co/rest/v1/public_runs');

    assert.equal(actual, expected);
    assert.equal(actual.status, 201);
  });

  void it('rejects a hanging request at its deadline and aborts the fetch signal', async () => {
    let observedSignal: AbortSignal | undefined;
    const boundedFetch = createBoundedSupabaseFetchForTests({
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
    const boundedFetch = createBoundedSupabaseFetchForTests({
      fetchImplementation: async (_input, init) => {
        observedSignal = init?.signal ?? undefined;
        return new Promise<Response>(() => {});
      },
      parentSignal: controller.signal,
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
    const boundedFetch = createBoundedSupabaseFetchForTests({
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
    const boundedFetch = createBoundedSupabaseFetchForTests({
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
