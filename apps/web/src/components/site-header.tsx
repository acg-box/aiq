'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

import type { AiqRepository } from '../data/types.ts';
import { ThemeControl } from './theme-control.tsx';

const workspaceNavigation = [
  ['Results', 'results'],
  ['Trends', 'trends'],
  ['Compare', 'compare'],
  ['Evidence', 'runs'],
] as const;

export function SiteHeader({ configuration }: { configuration: AiqRepository['configuration'] }) {
  const pathname = usePathname();
  const [activeSection, setActiveSection] = useState('results');
  const statusClass =
    configuration === 'live'
      ? 'status-public'
      : configuration === 'invalid'
        ? 'status-invalid'
        : 'status-seed';

  useEffect(() => {
    if (pathname !== '/') return undefined;
    const alignmentTimers: number[] = [];
    const observedSections = new Set<HTMLElement>();
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .toSorted((left, right) => right.intersectionRatio - left.intersectionRatio)[0];
        const section = visible?.target;
        if (section instanceof HTMLElement && section.dataset.navSection) {
          setActiveSection(section.dataset.navSection);
        }
      },
      { rootMargin: '-24% 0px -62% 0px', threshold: [0, 0.05, 0.2] },
    );

    const observeSections = () => {
      document.querySelectorAll<HTMLElement>('[data-workspace-section]').forEach((section) => {
        if (observedSections.has(section)) return;
        observedSections.add(section);
        observer.observe(section);
      });
    };

    const alignToHash = () => {
      alignmentTimers.forEach((timer) => window.clearTimeout(timer));
      alignmentTimers.length = 0;
      const align = () => {
        const id = window.location.hash.slice(1);
        const section = id ? document.getElementById(id) : null;
        if (!section) return;
        if (section.dataset.navSection) setActiveSection(section.dataset.navSection);
        window.requestAnimationFrame(() => section.scrollIntoView({ block: 'start' }));
      };
      align();
      for (const delay of [180, 520, 1100, 2000]) {
        alignmentTimers.push(window.setTimeout(align, delay));
      }
    };

    observeSections();
    const mutationObserver = new MutationObserver(observeSections);
    mutationObserver.observe(document.body, { childList: true, subtree: true });
    alignToHash();
    window.addEventListener('hashchange', alignToHash);
    return () => {
      alignmentTimers.forEach((timer) => window.clearTimeout(timer));
      mutationObserver.disconnect();
      observer.disconnect();
      window.removeEventListener('hashchange', alignToHash);
    };
  }, [pathname]);

  return (
    <header className="site-header">
      <Link className="brand" href="/" aria-label="AIQ home" prefetch={false}>
        <span>AIQ</span>
      </Link>
      <nav aria-label="Main navigation">
        {workspaceNavigation.map(([label, section]) => {
          const current =
            pathname === '/'
              ? activeSection === (section === 'runs' ? 'evidence' : section)
              : (section === 'trends' && pathname === '/trends') ||
                (section === 'compare' && pathname === '/compare') ||
                (section === 'runs' &&
                  (pathname === '/runs' ||
                    pathname.startsWith('/runs/') ||
                    pathname === '/method' ||
                    pathname === '/radar' ||
                    pathname.startsWith('/calibrations')));
          return (
            <Link
              key={section}
              href={`/#${section}`}
              aria-current={current ? 'page' : undefined}
              prefetch={false}
            >
              {label}
            </Link>
          );
        })}
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
