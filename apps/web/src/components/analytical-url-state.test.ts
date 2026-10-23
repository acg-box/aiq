import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  type AnalyticalUrlHost,
  createAnalyticalUrlStore,
  hrefWithParams,
  readBoundedIntegerParam,
  readDistinctIdPair,
  readEnumParam,
  readIdParam,
} from './analytical-url-state.ts';

class FakeUrlHost implements AnalyticalUrlHost {
  href: string;
  readonly pushed: string[] = [];
  readonly replaced: string[] = [];
  private readonly listeners = new Map<string, Set<() => void>>();

  constructor(href: string) {
    this.href = href;
  }

  currentHref = () => this.href;
  currentSearch = () => new URL(this.href).search;
  pushState = (url: string) => {
    this.pushed.push(url);
    this.href = new URL(url, this.href).href;
  };
  replaceState = (url: string) => {
    this.replaced.push(url);
    this.href = new URL(url, this.href).href;
  };
  addEventListener = (type: string, listener: () => void) => {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  };
  removeEventListener = (type: string, listener: () => void) => {
    this.listeners.get(type)?.delete(listener);
  };
  emitAnalyticalChange = () => this.emit('aiq:analytical-url-change');

  restore(href: string): void {
    this.href = href;
    this.emit('popstate');
  }

  private emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

void describe('analytical URL state codecs', () => {
  void it('preserves workspace query order, unrelated scope, and anchors through updates', () => {
    const host = new FakeUrlHost(
      'https://aiq.wiki/benchmarks/harness?view=method&workload=workflow#tasks',
    );
    const store = createAnalyticalUrlStore(host);
    store.update({ difficulty: 'hard', stack: 'TypeScript' }, { sort: false });
    assert.deepEqual(host.pushed, [
      '/benchmarks/harness?view=method&workload=workflow&difficulty=hard&stack=TypeScript#tasks',
    ]);
    assert.equal(
      hrefWithParams(
        '/benchmarks/harness',
        new URL(host.href).searchParams,
        { view: 'data' },
        { sort: false },
      ),
      '/benchmarks/harness?view=data&workload=workflow&difficulty=hard&stack=TypeScript',
    );
    assert.equal(store.update({ stack: 'TypeScript' }, { sort: false }), false);
  });

  void it('replaces state without a history entry and merges successive updates from the current URL', () => {
    const host = new FakeUrlHost('https://aiq.wiki/benchmarks/intelligence?view=records#results');
    const store = createAnalyticalUrlStore(host);
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });

    store.update({ family: 'Sol' });
    store.update({ effort: 'low' }, { replace: true });
    assert.deepEqual(host.pushed, ['/benchmarks/intelligence?family=Sol&view=records#results']);
    assert.deepEqual(host.replaced, [
      '/benchmarks/intelligence?effort=low&family=Sol&view=records#results',
    ]);
    assert.equal(notifications, 2);
    assert.equal(store.update({ family: 'Sol' }, { replace: true }), false);
    assert.equal(notifications, 2);
    unsubscribe();
  });

  void it('accepts only declared enum and id values', () => {
    const params = new URLSearchParams('encoding=bar&family=unknown&model=terra-high');
    assert.equal(readEnumParam(params, 'encoding', ['line', 'bar'], 'line'), 'bar');
    assert.equal(readEnumParam(params, 'family', ['Sol', 'Terra', 'Luna'], 'Sol'), 'Sol');
    assert.equal(readIdParam(params, 'model', ['sol-low', 'terra-high'], 'sol-low'), 'terra-high');
    assert.equal(readIdParam(params, 'missing', ['sol-low'], 'sol-low'), 'sol-low');
  });

  void it('rejects malformed and out-of-range integer state', () => {
    assert.equal(readBoundedIntegerParam(new URLSearchParams('zoom=4'), 'zoom', 0, 8), 4);
    assert.equal(readBoundedIntegerParam(new URLSearchParams('zoom=-1'), 'zoom', 0, 8), null);
    assert.equal(readBoundedIntegerParam(new URLSearchParams('zoom=9'), 'zoom', 0, 8), null);
    assert.equal(readBoundedIntegerParam(new URLSearchParams('zoom=2.5'), 'zoom', 0, 8), null);
  });

  void it('normalizes duplicate comparison selections to a valid distinct pair', () => {
    const ids = ['sol-low', 'terra-high', 'luna-max'];
    assert.deepEqual(
      readDistinctIdPair(
        new URLSearchParams('first=terra-high&second=terra-high'),
        'first',
        'second',
        ids,
        'sol-low',
        'luna-max',
      ),
      ['terra-high', 'sol-low'],
    );
  });

  void it('preserves unrelated state and emits deterministic links', () => {
    assert.equal(
      hrefWithParams('/benchmarks/intelligence', new URLSearchParams('tf=Terra&range=week&tz=3'), {
        range: 'month',
        tz: null,
      }),
      '/benchmarks/intelligence?range=month&tf=Terra',
    );
  });

  void it('pushes state, publishes the URL change, and restores popstate snapshots', () => {
    const host = new FakeUrlHost(
      'https://aiq.wiki/benchmarks/intelligence?range=week&trendFamily=Sol#chart',
    );
    const store = createAnalyticalUrlStore(host);
    const snapshots: string[] = [];
    const unsubscribe = store.subscribe(() => snapshots.push(store.getSnapshot()));

    store.update({ trendFamily: 'Terra', trendEncoding: 'bar' });
    assert.deepEqual(host.pushed, [
      '/benchmarks/intelligence?range=week&trendEncoding=bar&trendFamily=Terra#chart',
    ]);
    assert.deepEqual(snapshots, ['?range=week&trendEncoding=bar&trendFamily=Terra']);

    host.restore('https://aiq.wiki/benchmarks/intelligence?range=week&trendFamily=Sol#chart');
    assert.deepEqual(snapshots, [
      '?range=week&trendEncoding=bar&trendFamily=Terra',
      '?range=week&trendFamily=Sol',
    ]);

    host.restore(
      'https://aiq.wiki/benchmarks/intelligence?range=week&trendEncoding=bar&trendFamily=Terra#chart',
    );
    assert.deepEqual(snapshots, [
      '?range=week&trendEncoding=bar&trendFamily=Terra',
      '?range=week&trendFamily=Sol',
      '?range=week&trendEncoding=bar&trendFamily=Terra',
    ]);

    unsubscribe();
    host.restore('https://aiq.wiki/benchmarks/intelligence?range=month&trendFamily=Luna#chart');
    assert.equal(snapshots.length, 3);
  });

  void it('does not push literal or rendered-state semantic no-ops', () => {
    const host = new FakeUrlHost('https://aiq.wiki/#leaderboard');
    const store = createAnalyticalUrlStore(host);
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });

    assert.equal(store.update({ matrixEncoding: 'dots' }, { hasSemanticChange: false }), false);
    assert.equal(store.update({ matrixFamily: 'All' }, { hasSemanticChange: false }), false);
    assert.deepEqual(host.pushed, []);
    assert.equal(notifications, 0);

    assert.equal(store.update({ matrixEncoding: 'bars' }), true);
    assert.equal(store.update({ matrixEncoding: 'bars' }), false);
    assert.deepEqual(host.pushed, ['/?matrixEncoding=bars#leaderboard']);
    assert.equal(notifications, 1);

    host.restore('https://aiq.wiki/#leaderboard');
    assert.equal(store.getSnapshot(), '');
    assert.equal(notifications, 2);
    unsubscribe();
  });
});
