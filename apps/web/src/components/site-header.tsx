'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { AiqRepository } from '../data/types.ts';
import { ThemeControl } from './theme-control.tsx';

const workspaceNavigation = [
  ['Results', 'results'],
  ['Trends', 'trends'],
  ['Compare', 'compare'],
  ['Evidence', 'runs'],
] as const;

function scrollWorkspaceSection(section: HTMLElement): void {
  window.requestAnimationFrame(() =>
    section.scrollIntoView({ behavior: 'instant', block: 'start' }),
  );
}

export function SiteHeader({ configuration }: { configuration: AiqRepository['configuration'] }) {
  const pathname = usePathname();
  const [activeSection, setActiveSection] = useState('results');
  const navigationTarget = useRef<string | null>(null);
  const navigationTargetFallback = useRef<number | null>(null);
  const statusClass =
    configuration === 'live'
      ? 'status-public'
      : configuration === 'invalid'
        ? 'status-invalid'
        : 'status-seed';

  const activateNavigationTarget = useCallback((section: string) => {
    navigationTarget.current = section;
    setActiveSection(section);
    if (navigationTargetFallback.current !== null) {
      window.clearTimeout(navigationTargetFallback.current);
    }
    navigationTargetFallback.current = window.setTimeout(() => {
      navigationTarget.current = null;
      navigationTargetFallback.current = null;
    }, 3000);
  }, []);

  useEffect(() => {
    if (pathname !== '/') return undefined;
    const observedSections = new Set<HTMLElement>();
    let navigationFrame: number | null = null;

    const updateActiveSection = () => {
      navigationFrame = null;
      const activationOffset = Math.min(120, Math.max(96, window.innerHeight * 0.2));
      const activationPosition = window.scrollY + activationOffset;
      const section = [...observedSections]
        .map((candidate) => ({
          candidate,
          position: candidate.getBoundingClientRect().top + window.scrollY,
        }))
        .filter(({ position }) => position <= activationPosition)
        .toSorted((left, right) => right.position - left.position)[0]?.candidate;
      const visibleSection = section?.dataset.navSection;
      if (!visibleSection) return;
      if (navigationTarget.current !== null && navigationTarget.current !== visibleSection) return;
      if (navigationTarget.current === visibleSection) {
        navigationTarget.current = null;
        if (navigationTargetFallback.current !== null) {
          window.clearTimeout(navigationTargetFallback.current);
          navigationTargetFallback.current = null;
        }
      }
      setActiveSection(visibleSection);
    };

    const scheduleNavigationUpdate = () => {
      if (navigationFrame !== null) return;
      navigationFrame = window.requestAnimationFrame(updateActiveSection);
    };

    const observer = new IntersectionObserver(scheduleNavigationUpdate, {
      threshold: [0, 0.05, 0.2],
    });

    const alignToHash = () => {
      const id = window.location.hash.slice(1);
      const section = id ? document.getElementById(id) : null;
      if (!section) return;
      if (section.dataset.navSection) activateNavigationTarget(section.dataset.navSection);
      scrollWorkspaceSection(section);
    };

    const observeSections = () => {
      const hashId = window.location.hash.slice(1);
      let discoveredHashTarget = false;
      document.querySelectorAll<HTMLElement>('[data-workspace-section]').forEach((section) => {
        if (observedSections.has(section)) return;
        observedSections.add(section);
        observer.observe(section);
        if (section.id === hashId) discoveredHashTarget = true;
      });
      if (discoveredHashTarget) alignToHash();
      else scheduleNavigationUpdate();
    };

    observeSections();
    const mutationObserver = new MutationObserver(observeSections);
    mutationObserver.observe(document.body, { childList: true, subtree: true });
    alignToHash();
    window.addEventListener('hashchange', alignToHash);
    window.addEventListener('scroll', scheduleNavigationUpdate, { passive: true });
    window.addEventListener('resize', scheduleNavigationUpdate);
    return () => {
      if (navigationFrame !== null) window.cancelAnimationFrame(navigationFrame);
      if (navigationTargetFallback.current !== null) {
        window.clearTimeout(navigationTargetFallback.current);
        navigationTargetFallback.current = null;
      }
      navigationTarget.current = null;
      mutationObserver.disconnect();
      observer.disconnect();
      window.removeEventListener('hashchange', alignToHash);
      window.removeEventListener('scroll', scheduleNavigationUpdate);
      window.removeEventListener('resize', scheduleNavigationUpdate);
    };
  }, [activateNavigationTarget, pathname]);

  return (
    <header className="site-header">
      <Link className="brand" href="/" aria-label="AIQ home" prefetch={false}>
        <span>AIQ</span>
      </Link>
      <nav aria-label="Main navigation">
        {workspaceNavigation.map(([label, section]) => {
          const navigationSection = section === 'runs' ? 'evidence' : section;
          const current =
            pathname === '/'
              ? activeSection === navigationSection
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
              onClick={(event) => {
                if (
                  event.button !== 0 ||
                  event.altKey ||
                  event.ctrlKey ||
                  event.metaKey ||
                  event.shiftKey
                ) {
                  return;
                }
                activateNavigationTarget(navigationSection);
                if (pathname === '/') {
                  event.preventDefault();
                  const destination = `${window.location.pathname}${window.location.search}#${section}`;
                  const currentLocation = `${window.location.pathname}${window.location.search}${window.location.hash}`;
                  if (currentLocation !== destination) {
                    window.history.pushState(null, '', destination);
                  }
                  const target = document.getElementById(section);
                  if (target) scrollWorkspaceSection(target);
                }
              }}
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
