/** Check retained evidence identity and the public study references, without model calls. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { benchmarkBoards } from '../apps/web/src/benchmarks/boards.ts';

import catalogue from '../apps/web/src/studies/catalogue.json' with { type: 'json' };
import type { StudyCatalogue } from '../apps/web/src/studies/types.ts';

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This reviewed catalogue is checked against its original files and case reviews below.
const data = catalogue as StudyCatalogue;
const root = resolve(import.meta.dirname, '..');
const assignedStudies = benchmarkBoards.flatMap((board) => board.studyIds);
assert.equal(
  new Set(assignedStudies).size,
  assignedStudies.length,
  'Each study belongs to one benchmark board.',
);
assert.deepEqual(
  new Set(assignedStudies),
  new Set(data.studies.map((study) => study.id)),
  'Board membership must cover the study catalogue exactly.',
);
const ids = new Set(data.evidence.map((file) => file.id));
assert.equal(ids.size, data.evidence.length, 'Evidence identifiers must be unique.');
const publicFiles = await readdir(join(root, 'apps/web/public/evidence/studies'));
const selectedNames = new Set(data.evidence.map((file) => file.href.split('/').at(-1)));
assert.deepEqual(
  new Set(publicFiles),
  selectedNames,
  'The public evidence folder must contain only the reviewed selection.',
);
await Promise.all(
  data.evidence.map(async (file) => {
    assert.match(file.href, /^\/evidence\/studies\/[a-f0-9]{64}\.(json|md|txt)$/);
    const bytes = await readFile(join(root, 'apps/web/public', file.href));
    assert.equal(bytes.length, file.bytes, file.id);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, file.id);
    if (file.sourceUrl) assert.ok(file.sourceUrl.includes(data.sourceCommit), file.id);
  }),
);
for (const study of data.studies) {
  const studyFiles = new Set(
    data.evidence
      .filter(
        (file) =>
          study.evidenceBundles.includes(file.bundle) || study.relatedEvidenceIds.includes(file.id),
      )
      .map((file) => file.id),
  );
  const references = (values: string[]) =>
    values.forEach((id) =>
      assert.ok(
        studyFiles.has(id),
        `${study.id}: evidence must be in the study's Data view: ${id}`,
      ),
    );
  assert.match(study.id, /^[a-z0-9-]+$/);
  references(study.relatedEvidenceIds);
  for (const group of study.groups) {
    assert.equal(group.runs.length, group.results.length, study.id);
    for (const run of group.runs) {
      assert.ok(
        study.subjects.some((subject) => subject.id === run.subjectId),
        run.id,
      );
      references(run.evidenceIds);
    }
    for (const result of group.results) {
      assert.ok(
        group.runs.some((run) => run.id === result.runId),
        result.runId,
      );
      for (const metric of group.metrics) {
        const value = result.values[metric.key];
        assert.notEqual(value, undefined, `${study.id}/${result.runId}/${metric.key}`);
        if (typeof value === 'object' && value !== null) {
          assert.ok(value.total > 0 && value.pass >= 0 && value.pass <= value.total);
        }
      }
    }
  }
  for (const item of study.cases) {
    references(item.evidenceIds);
    for (const observation of item.observations) references(observation.evidenceIds);
  }
}
// Regression anchors bind the displayed counts to independently retained case reviews.
for (const study of data.studies) {
  for (const group of study.groups.filter((candidate) => candidate.chartMetric === 'bound')) {
    for (const result of group.results) {
      const run = group.runs.find((candidate) => candidate.id === result.runId);
      const subject = study.subjects.find((candidate) => candidate.id === run?.subjectId);
      const observations = study.cases
        .filter((item) => item.kind === 'reader')
        .flatMap((item) =>
          item.observations.filter(
            (observation) =>
              observation.subject === subject?.label ||
              (subject?.id === 'luna' &&
                observation.subject === 'Luna medium · retained control') ||
              (subject?.id === 'deepseek' && observation.subject === 'DeepSeek Flash 1017 · low'),
          ),
        );
      const complete = result.values.complete;
      const bound = result.values.bound;
      assert.ok(typeof complete === 'object' && complete !== null);
      assert.ok(typeof bound === 'object' && bound !== null);
      assert.equal(observations.length, run?.sampleSize, `${study.id}/${run?.id} case denominator`);
      assert.equal(
        observations.filter((item) => item.semanticComplete).length,
        complete.pass,
        `${study.id}/${run?.id} semantic total`,
      );
      assert.equal(
        observations.filter((item) => item.semanticComplete && item.quotesBound).length,
        bound.pass,
        `${study.id}/${run?.id} bound total`,
      );
    }
  }
}
console.log(
  `Verified ${data.studies.length} studies, ${data.studies.reduce((sum, study) => sum + study.cases.length, 0)} case pages, and ${data.evidence.length} original evidence hashes.`,
);
