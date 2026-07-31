import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const serverDirectory = dirname(fileURLToPath(import.meta.url));
const apiDirectory = join(serverDirectory, '..', 'app', 'api');

function productionServerFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return productionServerFiles(path);
    }
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

void describe('server boundary pattern policy', () => {
  void it('forbids JavaScript dollar anchors in production server regex literals', () => {
    for (const path of [
      ...productionServerFiles(serverDirectory),
      ...productionServerFiles(apiDirectory),
    ]) {
      const source = readFileSync(path, 'utf8');
      assert.equal(
        source.includes('$/'),
        false,
        `${path} must use a true input-end assertion instead of JavaScript $ semantics`,
      );
    }
  });

  void it('documents the line terminators that true input-end checks must reject', () => {
    const exact = /^canonical(?![\s\S])/;
    for (const suffix of ['\n', '\r\n', '\u2028', '\u2029']) {
      assert.equal(exact.test(`canonical${suffix}`), false);
    }
  });
});
