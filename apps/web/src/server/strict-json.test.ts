import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DuplicateJsonKeyError, parseJsonWithoutDuplicateKeys } from './strict-json.ts';

function nestedArray(depth: number): string {
  return '['.repeat(depth) + '0' + ']'.repeat(depth);
}

void describe('strict JSON parser', () => {
  void it('rejects duplicate keys at every object depth and after escape decoding', () => {
    for (const source of [
      '{"value":1,"value":2}',
      '{"outer":{"value":1,"value":2}}',
      '{"outer":[{"value":1,"value":2}]}',
      '{"value":1,"\\u0076alue":2}',
      '{"\\u0061":1,"a":2}',
      '{"\\ud83d\\ude00":1,"😀":2}',
    ]) {
      assert.throws(
        () => parseJsonWithoutDuplicateKeys(source),
        (error: unknown) =>
          error instanceof DuplicateJsonKeyError &&
          error.message === 'The JSON body contains a duplicate object key.',
      );
    }
  });

  void it('accepts the complete JSON value grammar through the bounded depth', () => {
    const value = parseJsonWithoutDuplicateKeys(
      `{"array":[null,true,false,-0,0,1.25,1e+2,"\\b\\f\\n\\r\\t\\\\\\/\\"","\\ud83d\\ude00"],"nested":${nestedArray(
        30,
      )}}`,
    );
    assert.equal(typeof value, 'object');
  });

  void it('rejects malformed numbers, escapes, surrogates, excess depth, and trailing data', () => {
    for (const source of [
      '01',
      '-',
      '1.',
      '1e',
      '1e+',
      'NaN',
      'Infinity',
      '"\\x00"',
      '"\\u12xz"',
      '"\\ud800"',
      '"\\udc00"',
      nestedArray(33),
      '{}{}',
      'true false',
    ]) {
      assert.throws(() => parseJsonWithoutDuplicateKeys(source), SyntaxError);
    }
  });

  void it('does not include attacker-controlled JSON in parser errors', () => {
    const marker = 'private-signed-input-marker';
    for (const source of [`{"${marker}":1,"${marker}":2}`, `{"value":"${marker}"`]) {
      assert.throws(
        () => parseJsonWithoutDuplicateKeys(source),
        (error: unknown) => error instanceof SyntaxError && !error.message.includes(marker),
      );
    }
  });
});
