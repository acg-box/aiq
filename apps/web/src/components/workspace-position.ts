'use client';

import { createContext, useContext, useLayoutEffect, useRef } from 'react';

const focusable = 'a, button, input, select, textarea, summary, [tabindex]';
const scrollable = '.research-table-scroll, .evidence-drawer, pre';
type Position = {
  x: number;
  y: number;
  details: boolean[];
  rows: string[];
  dialogs: string[];
  scroll: { left: number; top: number }[];
  focus: number;
};

// Reading state lasts for this page session. Filters remain owned by the URL.
const positions = new Map<string, Position>();
export const WorkspacePositionContext = createContext<Position | undefined>(undefined);

export function useSavedWorkspacePosition() {
  return useContext(WorkspacePositionContext);
}

function keyFor(href: string) {
  const url = new URL(href, 'http://workspace.local');
  if (!url.searchParams.has('view')) url.searchParams.set('view', 'leaderboard');
  url.searchParams.sort();
  return `${url.pathname}?${url.searchParams}`;
}

export function savedWorkspacePosition(href: string) {
  return positions.get(keyFor(href));
}

export function evidencePositionKey(dialog: HTMLElement) {
  const presentation = dialog.closest('.row-expanded-content') ? 'inline' : 'table';
  return `${dialog.dataset.evidenceLabel}:${presentation}`;
}

export function rememberWorkspacePosition(
  key = keyFor(window.location.href),
  focused: Element | null = document.activeElement,
) {
  const main = document.querySelector('main');
  if (!main) return;
  positions.set(key, {
    x: window.scrollX,
    y: window.scrollY,
    details: [...main.querySelectorAll('details')].map((element) => element.open),
    rows: [...main.querySelectorAll<HTMLElement>('[data-expanded-row]')].map(
      (element) => element.dataset.expandedRow ?? '',
    ),
    dialogs: [...main.querySelectorAll<HTMLElement>('dialog[open][data-evidence-label]')].map(
      evidencePositionKey,
    ),
    scroll: [...main.querySelectorAll(scrollable)].map((element) => ({
      left: element.scrollLeft,
      top: element.scrollTop,
    })),
    focus: [...main.querySelectorAll(focusable)].findIndex((element) => element === focused),
  });
}

export function useWorkspacePosition(view: string, href: string) {
  const key = keyFor(href);
  const currentKey = useRef(key);
  const previousView = useRef<string | null>(null);
  const restored = useRef(false);

  useLayoutEffect(() => {
    currentKey.current = key;
    restored.current = false;
    const entering = previousView.current !== view;
    previousView.current = view;
    const position = entering ? positions.get(key) : undefined;
    const main = document.querySelector('main');
    if (!position || !main) return undefined;
    restored.current = true;
    main.querySelectorAll('details').forEach((element, index) => {
      element.open = position.details[index] ?? false;
    });
    const restoreScroll = () => {
      main.querySelectorAll(scrollable).forEach((element, index) => {
        const scroll = position.scroll[index];
        if (scroll) element.scrollTo({ ...scroll, behavior: 'instant' });
      });
      main.querySelectorAll<HTMLElement>(focusable)[position.focus]?.focus({ preventScroll: true });
      window.scrollTo({ left: position.x, top: position.y, behavior: 'instant' });
    };
    restoreScroll();
    // Run after the router's own focus/scroll work as well.
    const frame = requestAnimationFrame(restoreScroll);
    return () => cancelAnimationFrame(frame);
  }, [key, view]);

  useLayoutEffect(() => {
    function beforeLink(event: MouseEvent) {
      if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (!(event.target instanceof Element)) return;
      const link = event.target.closest<HTMLAnchorElement>('a[href]');
      if (!link || link.download || (link.target && link.target !== '_self')) return;
      const next = new URL(link.href);
      if (next.origin !== window.location.origin || !next.pathname.startsWith('/benchmarks/'))
        return;
      if (keyFor(next.href) !== keyFor(window.location.href))
        rememberWorkspacePosition(undefined, link);
    }
    function beforeBack() {
      rememberWorkspacePosition(currentKey.current);
    }
    document.addEventListener('click', beforeLink, true);
    window.addEventListener('popstate', beforeBack);
    return () => {
      document.removeEventListener('click', beforeLink, true);
      window.removeEventListener('popstate', beforeBack);
    };
  }, []);
  return restored;
}
