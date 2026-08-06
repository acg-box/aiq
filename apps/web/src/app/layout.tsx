import type { Metadata } from 'next';
import { IBM_Plex_Mono, Manrope } from 'next/font/google';
import Link from 'next/link';

import { AIQ_CORE_SCORING_VERSION } from '../aiq-core-contract.ts';
import { SiteHeader } from '../components/site-header.tsx';
import { classifyPublicDataConfiguration } from '../data/repository.ts';
import { SITE_DESCRIPTION, SITE_NAME, SITE_ORIGIN } from './site-metadata.ts';
// oxlint-disable-next-line import/no-unassigned-import -- Next.js loads global CSS by side effect.
import './globals.css';
// oxlint-disable-next-line import/no-unassigned-import -- Next.js loads the workspace layer after base styles.
import './workspace.css';

const sans = Manrope({ subsets: ['latin'], variable: '--font-sans' });
const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-mono',
});

export const metadata: Metadata = {
  metadataBase: SITE_ORIGIN,
  applicationName: SITE_NAME,
  title: { default: 'AIQ — fixed-fixture agent evaluation', template: '%s · AIQ' },
  description: SITE_DESCRIPTION,
  alternates: { canonical: '/' },
  category: 'technology',
  robots: { index: true, follow: true },
  openGraph: {
    type: 'website',
    siteName: SITE_NAME,
    title: 'AIQ — fixed-fixture agent evaluation',
    description: SITE_DESCRIPTION,
    url: '/',
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const publicDataConfiguration = classifyPublicDataConfiguration();
  return (
    <html lang="en" data-scroll-behavior="smooth" suppressHydrationWarning>
      <head>
        <script
          // Apply the persisted or device theme before CSS paints to prevent a color flash.
          dangerouslySetInnerHTML={{
            __html:
              "(()=>{try{const s=localStorage.getItem('aiq-theme');const v=s==='light'||s==='dark'||s==='system'?s:'system';const d=matchMedia('(prefers-color-scheme: dark)').matches;const t=v==='system'?(d?'dark':'light'):v;const e=document.documentElement;e.dataset.theme=t;e.dataset.themeSetting=v;e.style.colorScheme=t}catch{}})()",
          }}
        />
      </head>
      <body className={`${sans.variable} ${mono.variable}`}>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <SiteHeader configuration={publicDataConfiguration} />
        <main id="main">{children}</main>
        <footer className="site-footer">
          <div>
            <strong>AIQ</strong>
            <p>Practical AI capability, measured in public.</p>
          </div>
          <div>
            <Link href="/#runs">Run archive</Link>
            <Link href="/#method">Method</Link>
            <Link href="/#radar">Radar</Link>
          </div>
          <p className="footer-note">
            {publicDataConfiguration === 'live'
              ? 'RLS-protected public views · AIQ v1 · inspect each scoring version'
              : publicDataConfiguration === 'invalid'
                ? 'Invalid public data configuration · review both browser-safe Supabase variables'
                : `Demo values are synthetic seed data · AIQ v1 · scoring ${AIQ_CORE_SCORING_VERSION}`}
          </p>
        </footer>
      </body>
    </html>
  );
}
