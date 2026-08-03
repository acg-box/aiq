import assert from 'node:assert/strict';
import test from 'node:test';

import robots from './robots.ts';
import { SITE_ORIGIN, createPageMetadata } from './site-metadata.ts';
import sitemap from './sitemap.ts';

void test('public metadata uses the canonical AIQ origin', () => {
  const metadata = createPageMetadata({
    title: 'Run history',
    path: '/runs',
    description: 'Public run history.',
  });

  assert.equal(SITE_ORIGIN.href, 'https://aiq.wiki/');
  assert.equal(metadata.alternates?.canonical, '/runs');
  assert.equal(metadata.openGraph?.url, '/runs');
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
      'https://aiq.wiki/runs',
      'https://aiq.wiki/calibrations',
      'https://aiq.wiki/compare',
      'https://aiq.wiki/trends',
      'https://aiq.wiki/radar',
      'https://aiq.wiki/method',
    ],
  );
});
