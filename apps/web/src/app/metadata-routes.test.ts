import assert from 'node:assert/strict';
import test from 'node:test';

import robots from './robots.ts';
import { SITE_ORIGIN, createPageMetadata } from './site-metadata.ts';
import sitemap from './sitemap.ts';
import { listStudies } from '../studies/repository.ts';

void test('public metadata uses the canonical AIQ origin', () => {
  const metadata = createPageMetadata({
    title: 'Run history',
    path: '/benchmarks/intelligence',
    description: 'Public run history.',
  });

  assert.equal(SITE_ORIGIN.href, 'https://aiq.wiki/');
  assert.equal(metadata.alternates?.canonical, '/benchmarks/intelligence');
  assert.equal(metadata.openGraph?.url, '/benchmarks/intelligence');
  assert.deepEqual(metadata.robots, { index: true, follow: true });
});

void test('robots allows public pages, excludes APIs, and advertises the sitemap', () => {
  assert.deepEqual(robots(), {
    rules: { userAgent: '*', allow: '/', disallow: '/api/' },
    sitemap: 'https://aiq.wiki/sitemap.xml',
    host: 'https://aiq.wiki/',
  });
});

void test('sitemap includes each static public route on the canonical origin', () => {
  assert.deepEqual(
    sitemap().map((entry) => entry.url),
    [
      'https://aiq.wiki/',
      'https://aiq.wiki/about',
      'https://aiq.wiki/benchmarks/intelligence/calibrations',
      'https://aiq.wiki/benchmarks/intelligence/verification',
      'https://aiq.wiki/benchmarks/intelligence',
      'https://aiq.wiki/benchmarks/harness',
      'https://aiq.wiki/benchmarks/memory',
      ...listStudies().flatMap((study) =>
        study.cases.map(
          (item) => `https://aiq.wiki/benchmarks/memory/records/${study.id}/${item.id}`,
        ),
      ),
    ],
  );
});
