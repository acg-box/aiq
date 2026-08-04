'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import type { AiqRepository } from '../data/types.ts';

const navigation = [
  ['Overview', '/'],
  ['Compare', '/compare'],
  ['Trends', '/trends'],
  ['Runs', '/runs'],
] as const;

const secondaryNavigation = [
  ['Calibrations', '/calibrations'],
  ['Method', '/method'],
  ['Radar', '/radar'],
] as const;

export function SiteHeader({ configuration }: { configuration: AiqRepository['configuration'] }) {
  const pathname = usePathname();

  return (
    <header className="site-header">
      <Link className="brand" href="/" aria-label="AIQ home" prefetch={false}>
        <span className="brand-mark" aria-hidden="true">
          A
        </span>
        <span>AIQ</span>
      </Link>
      <nav aria-label="Main navigation">
        {navigation.map(([label, href]) => {
          const current =
            href === '/' ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);

          return (
            <Link
              key={href}
              href={href}
              aria-current={current ? 'page' : undefined}
              prefetch={false}
            >
              {label}
            </Link>
          );
        })}
        <details className="site-more">
          <summary
            className={
              secondaryNavigation.some(
                ([, href]) => href === pathname || pathname.startsWith(`${href}/`),
              )
                ? 'is-active'
                : undefined
            }
          >
            More
          </summary>
          <div className="site-more-menu" aria-label="More navigation">
            {secondaryNavigation.map(([label, href]) => {
              const current = pathname === href || pathname.startsWith(`${href}/`);
              return (
                <Link
                  key={href}
                  href={href}
                  aria-current={current ? 'page' : undefined}
                  prefetch={false}
                >
                  {label}
                </Link>
              );
            })}
          </div>
        </details>
      </nav>
      <span className="live-pill">
        <span aria-hidden="true" />
        {configuration === 'live'
          ? 'public data'
          : configuration === 'invalid'
            ? 'invalid config'
            : 'seed mode'}
      </span>
    </header>
  );
}
