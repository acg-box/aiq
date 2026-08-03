import type { Metadata } from 'next';
import { IBM_Plex_Mono, Manrope } from 'next/font/google';
import Link from 'next/link';

import { SiteHeader } from '../components/site-header.tsx';
import { classifyPublicDataConfiguration } from '../data/repository.ts';
// oxlint-disable-next-line import/no-unassigned-import -- Next.js loads global CSS by side effect.
import './globals.css';

const sans = Manrope({ subsets: ['latin'], variable: '--font-sans' });
const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-mono',
});

export const metadata: Metadata = {
  title: { default: 'AIQ — fixed-fixture agent evaluation', template: '%s · AIQ' },
  description:
    'A transparent index of AIQ v1 fixed-fixture outcomes, sensitivity, history, and provenance.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const publicDataConfiguration = classifyPublicDataConfiguration();
  return (
    <html lang="en" data-scroll-behavior="smooth">
      <body className={`${sans.variable} ${mono.variable}`}>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <SiteHeader configuration={publicDataConfiguration} />
        <main id="main">{children}</main>
        <footer>
          <div>
            <strong>AIQ</strong>
            <p>Evidence before order. Uncertainty beside every score.</p>
          </div>
          <div>
            <Link href="/method">Scoring method</Link>
            <Link href="/radar">Network provenance</Link>
          </div>
          <p className="footer-note">
            {publicDataConfiguration === 'live'
              ? 'RLS-protected public views · AIQ v1 · inspect each scoring version'
              : publicDataConfiguration === 'invalid'
                ? 'Invalid public data configuration · review both browser-safe Supabase variables'
                : 'Demo values are synthetic seed data · AIQ v1 · scoring 1.0.2'}
          </p>
        </footer>
      </body>
    </html>
  );
}
