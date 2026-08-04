import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolvePlaywrightCompanionPort, resolvePlaywrightPort } from '../playwright-port.ts';

void describe('resolvePlaywrightPort', () => {
  void it('preserves each suite default', () => {
    assert.equal(resolvePlaywrightPort(4_173, undefined), 4_173);
    assert.equal(resolvePlaywrightPort(4_181, undefined), 4_181);
  });

  void it('accepts canonical TCP port boundaries', () => {
    assert.equal(resolvePlaywrightPort(4_173, '1'), 1);
    assert.equal(resolvePlaywrightPort(4_173, '54321'), 54_321);
    assert.equal(resolvePlaywrightPort(4_173, '65535'), 65_535);
  });

  void it('fails closed for invalid values', () => {
    for (const value of ['', '0', '01', '4173.0', '+4173', ' 4173', '65536', 'port']) {
      assert.throws(
        () => resolvePlaywrightPort(4_173, value),
        /AIQ_PLAYWRIGHT_PORT must be a canonical TCP port from 1 to 65535\./,
      );
    }
  });
});

void describe('resolvePlaywrightCompanionPort', () => {
  void it('selects a distinct valid port next to the application port', () => {
    assert.equal(resolvePlaywrightCompanionPort(54_321), 54_322);
    assert.equal(resolvePlaywrightCompanionPort(65_535), 65_534);
  });
});
