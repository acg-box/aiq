import type { Metadata } from 'next';

export const SITE_NAME = 'AIQ';
export const SITE_ORIGIN = new URL('https://aiq.wiki');
export const SITE_DESCRIPTION =
  'Transparent, reproducible fixed-fixture benchmarks for practical AI and agent work.';

type PageMetadataOptions = {
  title: string;
  path: string;
  description: string;
};

export function createPageMetadata({ title, path, description }: PageMetadataOptions): Metadata {
  return {
    title,
    description,
    alternates: { canonical: path },
    robots: { index: true, follow: true },
    openGraph: {
      type: 'website',
      siteName: SITE_NAME,
      title: `${title} · ${SITE_NAME}`,
      description,
      url: path,
    },
  };
}
