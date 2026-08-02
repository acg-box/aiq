'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import type { AiqRepository } from '../data/types.ts';
import type { DeploymentProfile } from '../data/deployment-profile.ts';

const navigation = [
  ['Overview', '/'],
  ['Runs', '/runs'],
  ['Compare', '/compare'],
  ['Trends', '/trends'],
  ['Method', '/method'],
  ['Radar', '/radar'],
] as const;

export function SiteHeader({
  configuration,
  deploymentProfile,
}: {
  configuration: AiqRepository['configuration'];
  deploymentProfile: DeploymentProfile;
}) {
  const pathname = usePathname();

  return (
    <header className="site-header">
      <Link className="brand" href="/" aria-label="AIQ Wiki home">
        <span className="brand-mark" aria-hidden="true">
          A
        </span>
        <span>
          AIQ <em>Wiki</em>
        </span>
      </Link>
      <nav aria-label="Main navigation">
        {navigation.map(([label, href]) => {
          const current =
            href === '/' ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);

          return (
            <Link key={href} href={href} aria-current={current ? 'page' : undefined}>
              {label}
            </Link>
          );
        })}
      </nav>
      <span className="live-pill">
        <span aria-hidden="true" />
        {deploymentProfile === 'preview'
          ? 'preview data'
          : configuration === 'live'
            ? 'public data'
            : configuration === 'invalid'
              ? 'invalid config'
              : 'seed mode'}
      </span>
    </header>
  );
}
