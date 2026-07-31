import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '../../../..');

await test('upload routes register Storage lifecycle before attaching metadata references', async () => {
  const [submissionRoute, artifactRoute, submissionHandler, artifactHandler, registration] =
    await Promise.all(
      [
        'apps/web/src/app/api/submissions/route.ts',
        'apps/web/src/app/api/artifacts/route.ts',
        'apps/web/src/server/submission-handler.ts',
        'apps/web/src/server/artifact-handler.ts',
        'apps/web/src/server/storage-lifecycle-registration.ts',
      ].map((path) => readFile(resolve(repositoryRoot, path), 'utf8')),
    );
  assert.ok(
    submissionRoute && artifactRoute && submissionHandler && artifactHandler && registration,
  );

  for (const route of [submissionRoute, artifactRoute]) {
    assert.match(route, /registerStorageObject/);
    assert.match(route, /signal(?:Orphan|Reconciliation)[\s\S]*reason/);
    assert.match(route, /console\.error\([\s\S]*JSON\.stringify/);
    assert.doesNotMatch(route, /aiq_attach_storage_reference/);
  }
  assert.match(submissionRoute, /event: 'aiq_submission_orphan_reconciliation_required'/);
  assert.match(artifactRoute, /event: 'aiq_artifact_reconciliation_required'/);
  assert.match(artifactRoute, /bucket: identity\.bucket[\s\S]*key: identity\.key/);
  assert.match(registration, /rpc\('aiq_register_storage_object'/);
  assert.ok(
    submissionHandler.indexOf('dependencies.registerStoredObject') <
      submissionHandler.indexOf('dependencies.enqueue'),
  );
  assert.ok(
    artifactHandler.indexOf('dependencies.registerStoredObject') <
      artifactHandler.indexOf('dependencies.recordArtifact'),
  );
});
