import type { MetadataRoute } from 'next';

import { SITE_ORIGIN } from './site-metadata.ts';

const PUBLIC_ROUTES = ['/', '/runs', '/calibrations', '/compare', '/trends', '/radar', '/method'];

export default function sitemap(): MetadataRoute.Sitemap {
  return PUBLIC_ROUTES.map((path) => ({
    url: new URL(path, SITE_ORIGIN).href,
    changeFrequency: path === '/' ? 'weekly' : 'monthly',
    priority: path === '/' ? 1 : 0.7,
  }));
}
