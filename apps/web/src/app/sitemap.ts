import type { MetadataRoute } from 'next';
import { benchmarkBoards } from '../benchmarks/boards.ts';

import { listStudies } from '../studies/repository.ts';
import { SITE_ORIGIN } from './site-metadata.ts';

const PUBLIC_ROUTES = [
  '/',
  '/about',
  '/benchmarks/intelligence/calibrations',
  '/benchmarks/intelligence/verification',
];

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    ...PUBLIC_ROUTES,
    ...benchmarkBoards.map((board) => `/benchmarks/${board.id}`),
    ...listStudies().flatMap((study) =>
      study.cases.map((item) => `/benchmarks/memory/records/${study.id}/${item.id}`),
    ),
  ].map((path) => ({
    url: new URL(path, SITE_ORIGIN).href,
    changeFrequency: path === '/' ? 'weekly' : 'monthly',
    priority: path === '/' ? 1 : 0.7,
  }));
}
