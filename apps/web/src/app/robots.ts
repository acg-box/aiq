import type { MetadataRoute } from 'next';

import { SITE_ORIGIN } from './site-metadata.ts';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: '/api/',
    },
    sitemap: new URL('/sitemap.xml', SITE_ORIGIN).href,
    host: SITE_ORIGIN.href,
  };
}
