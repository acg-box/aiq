import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import snapshot from './catalogue.json' with { type: 'json' };
import { findEvidence, findStudy, listStudies, studyEvidence } from './repository.ts';
import { formatMetric } from './format.ts';
import type { CaseObservation, StudyCase, StudyResult, Subject } from './types.ts';

function original(id: string): unknown {
  const file = findEvidence(id);
  assert.ok(file);
  return JSON.parse(readFileSync(new URL(`../../public${file.href}`, import.meta.url), 'utf8'));
}

void test('the catalogue removes retired measurements and serves retained records directly', () => {
  assert.deepEqual(listStudies(), snapshot.studies);
  assert.doesNotMatch(JSON.stringify(snapshot.studies), /\belf\b/i);
  assert.ok(snapshot.evidence.every((file) => !/\belf\b/i.test(file.id)));
  assert.equal(findEvidence('2026-10-15-elf-native-kb-memory/review-elf.json'), undefined);
  const current = findStudy('native-memory');
  assert.ok(current);
  assert.deepEqual(
    current.subjects.map((subject) => subject.id),
    ['openviking', 'ragflow', 'ragflow-nightly'],
  );
  assert.equal(current.cases.length, 13);
  for (const item of current.cases) {
    assert.deepEqual(
      item.observations.map((observation) => observation.subject),
      ['OpenViking', 'RAGFlow nightly', 'RAGFlow rc1'],
    );
  }
});

void test('native measurements and case judgments match the retained product originals', () => {
  const study = findStudy('native-memory');
  assert.ok(study);
  const native = study.groups.find((group) => group.id === 'native');
  assert.ok(native);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The retained product summary has this reviewed shape; check-studies verifies its bytes.
  const summary = original('2026-10-15-native-kb-memory/results-summary.json') as {
    speed_comparison_allowed: boolean;
    products: Record<
      string,
      {
        correct: number;
        formal_paid_usd: number;
        query_mean_seconds: number;
        quote_bindings: { pass: number; total: number };
      }
    >;
  };
  assert.equal(summary.speed_comparison_allowed, false);
  const timeMetric = native.metrics.find((metric) => metric.key === 'time');
  assert.ok(timeMetric);
  const files = new Set(studyEvidence(study).map((file) => file.id));
  for (const run of native.runs) {
    assert.ok(run.evidenceIds.includes('2026-10-15-native-kb-memory/results-summary.json'));
    assert.ok(run.evidenceIds.every((id) => files.has(id)));
    const result: StudyResult | undefined = native.results.find((entry) => entry.runId === run.id);
    assert.ok(result);
    const product = summary.products[run.subjectId];
    assert.ok(product);
    assert.ok(product.query_mean_seconds > 0);
    assert.equal(result.values.time, null);
    assert.equal(formatMetric(result.values.time, timeMetric), 'Withheld from comparison');
    assert.equal(result.values.cost, product.formal_paid_usd);
    assert.deepEqual(result.values.quotes, product.quote_bindings);
    assert.deepEqual(result.values.complete, { pass: product.correct, total: run.sampleSize });
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- These are the retained per-case reviews for this exact product.
    const reviews = original(`2026-10-15-native-kb-memory/review-${run.subjectId}.json`) as {
      phase: string;
      case_id: string;
      correct: boolean;
      quote_binding: boolean;
    }[];
    assert.deepEqual(result.values.bound, {
      pass: reviews.filter((review) => review.correct && review.quote_binding).length,
      total: reviews.length,
    });
    const subject: Subject | undefined = study.subjects.find((entry) => entry.id === run.subjectId);
    for (const review of reviews) {
      const item: StudyCase | undefined = study.cases.find(
        (entry) => entry.id === `${review.phase}-${review.case_id}`,
      );
      const observation: CaseObservation | undefined = item?.observations.find(
        (entry) => entry.subject === subject?.label,
      );
      assert.ok(observation);
      assert.equal(observation.semanticComplete, review.correct);
      assert.equal(observation.quotesBound, review.quote_binding);
    }
  }
});
