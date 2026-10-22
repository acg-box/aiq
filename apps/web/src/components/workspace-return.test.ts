import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveWorkspaceReturn } from './workspace-return.ts';

void describe('detail return paths', () => {
  void it('returns to a bare board homepage instead of falling back to Records', () => {
    const back = resolveWorkspaceReturn('intelligence', '/benchmarks/intelligence');
    assert.equal(back.href, '/benchmarks/intelligence');
    assert.equal(back.label, 'Back to leaderboard');
  });

  void it('retains the selected study, test and source anchor', () => {
    const source = '/benchmarks/memory?view=records&study=luna-effort&test=writer#case-index';
    const back = resolveWorkspaceReturn('memory', source);
    assert.equal(back.href, source);
    assert.equal(back.label, 'Back to Mem records');
    assert.equal(back.query.get('study'), 'luna-effort');
    assert.equal(back.query.get('test'), 'writer');
    assert.equal(back.query.get('view'), 'records');
  });

  void it('returns one level to the calibration register while keeping board filters', () => {
    const source = '/benchmarks/intelligence?view=records&model=Terra&effort=medium';
    const register = `/benchmarks/intelligence/calibrations?${new URLSearchParams({ before: 'cursor-2', return: source })}`;
    const back = resolveWorkspaceReturn('intelligence', register);
    assert.equal(back.href, register);
    assert.equal(back.label, 'Back to calibrations');
    assert.equal(back.query.get('model'), 'Terra');
    assert.equal(back.query.get('effort'), 'medium');
    assert.equal(back.query.has('before'), false);
    assert.equal(back.query.has('return'), false);
  });

  void it('uses the owning board fallback for unrelated or external destinations', () => {
    const fallback = '/benchmarks/memory?view=records&study=luna-effort';
    for (const candidate of [
      null,
      '/benchmarks/intelligence?view=data',
      '//other.test',
      'https://other.test',
    ]) {
      const back = resolveWorkspaceReturn('memory', candidate, fallback);
      assert.equal(back.href, fallback);
      assert.equal(back.query.get('study'), 'luna-effort');
    }
  });
});
