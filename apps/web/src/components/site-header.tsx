'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { DotsThreeIcon } from '@phosphor-icons/react/dist/csr/DotsThree';
import { useEffect, useRef } from 'react';

import type { AiqRepository } from '../data/types.ts';
import { ThemeControl } from './theme-control.tsx';

const primaryNavigation = [
  ['Results', '/'],
  ['Compare', '/compare'],
  ['History', '/trends'],
  ['Method', '/method'],
] as const;

const secondaryNavigation = [
  ['Run archive', '/runs'],
  ['Radar', '/radar'],
  ['Calibration', '/calibrations'],
] as const;

export function SiteHeader({ configuration }: { configuration: AiqRepository['configuration'] }) {
  const pathname = usePathname();
  const moreMenuRef = useRef<HTMLDetailsElement>(null);
  const statusClass =
    configuration === 'live'
      ? 'status-public'
      : configuration === 'invalid'
        ? 'status-invalid'
        : 'status-seed';

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const moreMenu = moreMenuRef.current;
      if (!moreMenu || event.key !== 'Escape' || !moreMenu.open) return;

      event.preventDefault();
      moreMenu.open = false;
      moreMenu.querySelector('summary')?.focus();
    }

    function handlePointerDown(event: PointerEvent) {
      const moreMenu = moreMenuRef.current;
      if (moreMenu && event.target instanceof Node && !moreMenu.contains(event.target)) {
        moreMenu.open = false;
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('pointerdown', handlePointerDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, []);

  useEffect(() => {
    if (moreMenuRef.current) moreMenuRef.current.open = false;
  }, [pathname]);

  return (
    <header className="site-header">
      <Link className="brand" href="/" aria-label="AIQ home" prefetch={false}>
        <span>AIQ</span>
      </Link>
      <nav aria-label="Main navigation">
        {primaryNavigation.map(([label, href]) => {
          const current =
            pathname === href ||
            (href === '/trends' && (pathname === '/runs' || pathname.startsWith('/runs/'))) ||
            (href !== '/' && pathname.startsWith(`${href}/`));
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
        <details ref={moreMenuRef} className="site-more">
          <summary
            aria-label="More pages"
            title="More pages"
            className={
              secondaryNavigation.some(
                ([, href]) =>
                  href !== '/runs' && (href === pathname || pathname.startsWith(`${href}/`)),
              )
                ? 'is-active'
                : undefined
            }
          >
            <DotsThreeIcon aria-hidden="true" size={20} weight="bold" />
            <span className="sr-only">More pages</span>
          </summary>
          <div className="site-more-menu" aria-label="More navigation">
            {secondaryNavigation.map(([label, href]) => {
              const current =
                href !== '/runs' && (pathname === href || pathname.startsWith(`${href}/`));
              return (
                <Link
                  key={href}
                  href={href}
                  aria-current={current ? 'page' : undefined}
                  prefetch={false}
                  onNavigate={() => {
                    if (moreMenuRef.current) moreMenuRef.current.open = false;
                  }}
                >
                  {label}
                </Link>
              );
            })}
          </div>
        </details>
      </nav>
      <div className="header-tools">
        <ThemeControl />
        <span
          className={`live-pill ${statusClass}`}
          title={
            configuration === 'live'
              ? 'Published public data'
              : configuration === 'invalid'
                ? 'Public data configuration is invalid'
                : 'Synthetic seed data'
          }
        >
          <span aria-hidden="true" />
          {configuration === 'live'
            ? 'Live'
            : configuration === 'invalid'
              ? 'Config error'
              : 'Seed'}
        </span>
      </div>
    </header>
  );
}
