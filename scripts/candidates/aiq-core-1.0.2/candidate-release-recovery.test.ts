import { rejects, strictEqual } from 'node:assert/strict';
import { link, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { writeJsonCreateOrVerify } from './candidate-release.ts';

async function withTemporaryDirectory(
  callback: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'aiq-candidate-release-recovery-'));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

void test('lifecycle output retry verifies exact bytes without replacing the inode', async () => {
  await withTemporaryDirectory(async (directory) => {
    const output = join(directory, 'authority.json');
    const value = { schema_version: 'aiq.test.v1', digest: `sha256:${'a'.repeat(64)}` };

    await writeJsonCreateOrVerify(output, value);
    const first = await lstat(output);
    const bytes = await readFile(output);
    await writeJsonCreateOrVerify(output, value);
    const retried = await lstat(output);

    strictEqual(first.ino, retried.ino);
    strictEqual(retried.nlink, 1);
    strictEqual(retried.mode & 0o777, 0o600);
    strictEqual((await readFile(output)).equals(bytes), true);
  });
});

void test('conflicting lifecycle retry fails without changing prior output', async () => {
  await withTemporaryDirectory(async (directory) => {
    const output = join(directory, 'receipt.json');
    const original = { schema_version: 'aiq.test.v1', state: 'first' };
    await writeJsonCreateOrVerify(output, original);
    const before = await readFile(output);
    const identity = await lstat(output);

    await rejects(
      writeJsonCreateOrVerify(output, { schema_version: 'aiq.test.v1', state: 'conflict' }),
      /conflicts with the expected canonical bytes/u,
    );

    strictEqual((await readFile(output)).equals(before), true);
    strictEqual((await lstat(output)).ino, identity.ino);
  });
});

void test('lifecycle retry rejects a symbolic link without changing its target', async () => {
  await withTemporaryDirectory(async (directory) => {
    const target = join(directory, 'protected.json');
    const output = join(directory, 'manifest.json');
    await writeFile(target, 'protected\n', { mode: 0o600 });
    await symlink(target, output);

    await rejects(
      writeJsonCreateOrVerify(output, { schema_version: 'aiq.test.v1' }),
      /cannot be opened without following links/u,
    );
    strictEqual(await readFile(target, 'utf8'), 'protected\n');
    strictEqual((await lstat(output)).isSymbolicLink(), true);
  });
});

void test('interrupted or multiply linked output is rejected without corruption', async () => {
  await withTemporaryDirectory(async (directory) => {
    const interrupted = join(directory, 'interrupted.json');
    await writeFile(interrupted, '', { mode: 0o600 });
    await rejects(
      writeJsonCreateOrVerify(interrupted, { schema_version: 'aiq.test.v1' }),
      /conflicts with the expected canonical bytes/u,
    );
    strictEqual((await readFile(interrupted)).length, 0);

    const linked = join(directory, 'linked.json');
    await link(interrupted, linked);
    await rejects(
      writeJsonCreateOrVerify(interrupted, { schema_version: 'aiq.test.v1' }),
      /bounded single-link mode-0600 regular file/u,
    );
    strictEqual((await readFile(interrupted)).length, 0);
    strictEqual((await readFile(linked)).length, 0);
  });
});
