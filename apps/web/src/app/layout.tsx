import type { Metadata } from 'next';
import { IBM_Plex_Mono, Manrope } from 'next/font/google';
import Link from 'next/link';

import { SiteHeader } from '../components/site-header.tsx';
import { inspectDeploymentProfile } from '../data/deployment-profile.ts';
import { classifyPublicDataConfiguration } from '../data/repository.ts';
// oxlint-disable-next-line import/no-unassigned-import -- Next.js loads global CSS by side effect.
import './globals.css';

const sans = Manrope({ subsets: ['latin'], variable: '--font-sans' });
const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-mono',
});

const deploymentProfile = inspectDeploymentProfile();

export const metadata: Metadata = {
  title:
    deploymentProfile.profile === 'preview'
      ? {
          default: 'AIQ Wiki — synthetic preview',
          template: '%s · Preview · AIQ Wiki',
        }
      : { default: 'AIQ Wiki — fixed-fixture agent evaluation', template: '%s · AIQ Wiki' },
  description:
    deploymentProfile.profile === 'preview'
      ? 'AIQ Wiki read-only preview with synthetic fixtures and live Supabase read validation.'
      : 'A transparent index of AIQ v1 fixed-fixture outcomes, sensitivity, history, and provenance.',
  robots:
    deploymentProfile.profile === 'standard'
      ? undefined
      : { index: false, follow: false, noarchive: true, nocache: true },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const publicDataConfiguration = classifyPublicDataConfiguration();
  const currentDeploymentProfile = inspectDeploymentProfile().profile;
  return (
    <html lang="en" data-scroll-behavior="smooth">
      <body
        className={`${sans.variable} ${mono.variable}`}
        data-deployment-profile={currentDeploymentProfile}
      >
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        {currentDeploymentProfile === 'preview' ? (
          <aside className="preview-banner" aria-label="Deployment status">
            AIQ Wiki preview · synthetic · read-only · not production
          </aside>
        ) : null}
        <SiteHeader
          configuration={publicDataConfiguration}
          deploymentProfile={currentDeploymentProfile}
        />
        <main id="main">{children}</main>
        <footer>
          <div>
            <strong>AIQ Wiki</strong>
            <p>Evidence before order. Uncertainty beside every score.</p>
          </div>
          <div>
            <Link href="/method">Scoring method</Link>
            <Link href="/radar">Network provenance</Link>
          </div>
          <p className="footer-note">
            {currentDeploymentProfile === 'preview'
              ? 'AIQ Wiki preview · live Supabase read validation · synthetic fixtures only'
              : publicDataConfiguration === 'live'
                ? 'RLS-protected public views · AIQ v1 · inspect each scoring version'
                : publicDataConfiguration === 'invalid'
                  ? 'Invalid public data configuration · review both browser-safe Supabase variables'
                  : 'Demo values are synthetic seed data · AIQ v1 · scoring 1.0.0'}
          </p>
        </footer>
      </body>
    </html>
  );
}
