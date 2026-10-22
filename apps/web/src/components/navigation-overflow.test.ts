import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitNavigationItems } from './navigation-overflow.ts';

void test('navigation uses the available width rather than a board count', () => {
  assert.deepEqual(
    fitNavigationItems([80, 90, 30, 100, 70], 3, 600, 60, 20, false),
    [0, 1, 2, 3, 4],
  );
  assert.deepEqual(fitNavigationItems([80, 90, 30], 2, 180, 60, 20, false), [2]);
  assert.deepEqual(fitNavigationItems([80, 90, 30], 2, 210, 60, 20, false), [0, 2]);
});

void test('the current board survives overflow and visible peers stay alphabetical', () => {
  assert.deepEqual(fitNavigationItems([80, 90, 30, 100, 70], 3, 330, 60, 20, false), [0, 2, 3]);
  assert.deepEqual(fitNavigationItems([300, 90, 30], 0, 160, 60, 20, false), [0]);
});

void test('the more control is reserved only when needed, including compact utilities', () => {
  assert.deepEqual(fitNavigationItems([80, 90, 30], 1, 240, 60, 20, false), [0, 1, 2]);
  assert.deepEqual(fitNavigationItems([80, 90, 30], 1, 240, 60, 20, true), [1, 2]);
  assert.deepEqual(fitNavigationItems([80, 90, 30], -1, 170, 60, 20, false), [0]);
});
