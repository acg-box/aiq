import assert from 'node:assert/strict';
import test from 'node:test';
import { benchmarkBoards, boardForPath, boardForStudy } from './boards.ts';

void test('capability boards remain peers and memory replays keep their study owner', () => {
  assert.deepEqual(
    benchmarkBoards.map((board) => board.id),
    ['intelligence', 'harness', 'memory'],
  );
  for (const study of ['native-memory', 'luna-deepseek', 'luna-effort']) {
    assert.equal(boardForStudy(study)?.id, 'memory');
    assert.equal(boardForPath(`/benchmarks/memory/records/${study}/sample`)?.id, 'memory');
  }
  assert.equal(boardForStudy('unknown'), undefined);
});

void test('all evidence and detail routes inherit their board owner', () => {
  for (const path of [
    '/benchmarks/intelligence',
    '/benchmarks/intelligence/records/run_123',
    '/benchmarks/intelligence/calibrations/run_123',
    '/benchmarks/intelligence/verification',
  ])
    assert.equal(boardForPath(path)?.id, 'intelligence');
  assert.equal(boardForPath('/benchmarks/memory')?.id, 'memory');
  assert.equal(boardForPath('/benchmarks/harness')?.id, 'harness');
  for (const path of [
    '/core',
    '/compare',
    '/trends',
    '/runs',
    '/method',
    '/studies/native-memory',
    '/unknown',
  ])
    assert.equal(boardForPath(path), undefined);
});
