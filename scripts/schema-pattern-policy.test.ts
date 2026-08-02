/* oxlint-disable typescript/no-floating-promises, typescript/no-unsafe-type-assertion */

import { strictEqual } from 'node:assert';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

type JsonObject = Record<string, unknown>;

const schemaDirectory = new URL('../benchmarks/schema/', import.meta.url);

function collectPatterns(value: unknown, path: string, patterns: Map<string, string>): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) => collectPatterns(child, `${path}[${String(index)}]`, patterns));
    return;
  }
  if (typeof value !== 'object' || value === null) {
    return;
  }
  for (const [key, child] of Object.entries(value as JsonObject)) {
    const childPath = `${path}.${key}`;
    if (key === 'pattern') {
      strictEqual(typeof child, 'string', `${childPath} must be a string`);
      patterns.set(childPath, child as string);
    } else {
      collectPatterns(child, childPath, patterns);
    }
  }
}

test('public JSON Schema patterns do not use the pre-line-terminator dollar anchor', async () => {
  const names = (await readdir(schemaDirectory))
    .filter((name) => name.endsWith('.schema.json'))
    .toSorted();
  strictEqual(names.length > 0, true);

  const schemas = await Promise.all(
    names.map(async (name) => {
      const source = await readFile(new URL(name, schemaDirectory), 'utf8');
      return [name, JSON.parse(source) as JsonObject] as const;
    }),
  );
  for (const [name, schema] of schemas) {
    const patterns = new Map<string, string>();
    collectPatterns(schema, name, patterns);
    for (const [path, pattern] of patterns) {
      strictEqual(
        pattern.includes('$'),
        false,
        `${path} must not use the pre-line-terminator $ anchor`,
      );
      RegExp(pattern);
    }
  }
});
