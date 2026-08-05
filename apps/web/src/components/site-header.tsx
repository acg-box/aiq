'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';

import type { AiqRepository } from '../data/types.ts';
import { ThemeControl } from './theme-control.tsx';

const secondaryNavigation = [
  ['Compare', '/compare'],
  ['Trends', '/trends'],
  ['Calibrations', '/calibrations'],
  ['Method', '/method'],
  ['Radar', '/radar'],
] as const;

export function SiteHeader({ configuration }: { configuration: AiqRepository['configuration'] }) {
  const pathname = usePathname();
  const analyzeMenuRef = useRef<HTMLDetailsElement>(null);
  const statusClass =
    configuration === 'live'
      ? 'status-public'
      : configuration === 'invalid'
        ? 'status-invalid'
        : 'status-seed';

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const analyzeMenu = analyzeMenuRef.current;
      if (!analyzeMenu || event.key !== 'Escape' || !analyzeMenu.open) return;

      event.preventDefault();
      analyzeMenu.open = false;
      analyzeMenu.querySelector('summary')?.focus();
    }

    function handlePointerDown(event: PointerEvent) {
      const analyzeMenu = analyzeMenuRef.current;
      if (analyzeMenu && event.target instanceof Node && !analyzeMenu.contains(event.target)) {
        analyzeMenu.open = false;
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
    if (analyzeMenuRef.current) analyzeMenuRef.current.open = false;
  }, [pathname]);

  return (
    <header className="site-header">
      <Link className="brand" href="/" aria-label="AIQ home" prefetch={false}>
        <span>AIQ</span>
      </Link>
      <nav aria-label="Main navigation">
        <Link href="/" aria-current={pathname === '/' ? 'page' : undefined} prefetch={false}>
          Overview
        </Link>
        <details ref={analyzeMenuRef} className="site-more">
          <summary
            className={
              secondaryNavigation.some(
                ([, href]) => href === pathname || pathname.startsWith(`${href}/`),
              )
                ? 'is-active'
                : undefined
            }
          >
            Analyze
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
                  onNavigate={() => {
                    if (analyzeMenuRef.current) analyzeMenuRef.current.open = false;
                  }}
                >
                  {label}
                </Link>
              );
            })}
          </div>
        </details>
        <Link
          href="/runs"
          aria-current={pathname === '/runs' || pathname.startsWith('/runs/') ? 'page' : undefined}
          prefetch={false}
        >
          Runs
        </Link>
      </nav>
      <div className="header-tools">
        <ThemeControl />
        <span className={`live-pill ${statusClass}`}>
          <span aria-hidden="true" />
          {configuration === 'live'
            ? 'public data'
            : configuration === 'invalid'
              ? 'invalid config'
              : 'seed mode'}
        </span>
      </div>
    </header>
  );
}
