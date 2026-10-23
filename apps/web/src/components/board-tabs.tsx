'use client';

import { NavigationLink } from './navigation-link.tsx';
import { useRouter } from 'next/navigation';
import { useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { alphabetical } from '../display-order.ts';
import { useWorkspaceQuery } from './workspace-query.ts';
import { NavigationPending } from './navigation-pending.tsx';
import {
  rememberWorkspacePosition,
  savedWorkspacePosition,
  useWorkspacePosition,
  WorkspacePositionContext,
} from './workspace-position.ts';

export function BoardTabs({ tabs }: { tabs: { id: string; label: string; content: ReactNode }[] }) {
  const prefix = useId();
  const { params, href } = useWorkspaceQuery();
  const router = useRouter();
  const defaultView = tabs[0]?.id;
  const activeView = tabs.find((tab) => tab.id === params.get('view'))?.id ?? defaultView;
  const requestedView = useRef<string | null>(null);
  const keyboardView = useRef<string | null>(null);
  const restored = useWorkspacePosition(activeView ?? 'leaderboard', href({}));
  useLayoutEffect(() => {
    if (requestedView.current === activeView && !restored.current)
      window.scrollTo({ top: 0, behavior: 'instant' });
    requestedView.current = null;
    if (keyboardView.current !== activeView) return undefined;
    keyboardView.current = null;
    const focusTab = () =>
      document.getElementById(`${prefix}-${activeView}-tab`)?.focus({ preventScroll: true });
    focusTab();
    const frame = requestAnimationFrame(focusTab);
    return () => cancelAnimationFrame(frame);
  }, [activeView, prefix]);
  function startView(id: string) {
    if (id === activeView) {
      if (requestedView.current === null) window.scrollTo({ top: 0, behavior: 'instant' });
      requestedView.current = null;
    } else {
      rememberWorkspacePosition();
      requestedView.current = id;
    }
  }
  const orderedTabs = alphabetical(tabs, (tab) => tab.label);
  const selected = Math.max(
    0,
    orderedTabs.findIndex((tab) => tab.id === activeView),
  );
  return (
    <WorkspacePositionContext.Provider value={savedWorkspacePosition(href({}))}>
      <div className="board-tabs" role="tablist" aria-label="Board views">
        {orderedTabs.map((tab, index) => (
          <NavigationLink
            key={tab.id}
            id={`${prefix}-${tab.id}-tab`}
            href={href({ view: tab.id })}
            scroll={false}
            onNavigate={() => startView(tab.id)}
            role="tab"
            aria-label={tab.label}
            aria-controls={`${prefix}-${tab.id}-panel`}
            aria-selected={selected === index}
            tabIndex={selected === index ? 0 : -1}
            onKeyDown={(event) => {
              const next =
                event.key === 'ArrowRight'
                  ? (index + 1) % tabs.length
                  : event.key === 'ArrowLeft'
                    ? (index - 1 + tabs.length) % tabs.length
                    : event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? tabs.length - 1
                        : null;
              if (next === null) return;
              event.preventDefault();
              const nextView = orderedTabs[next]?.id ?? defaultView ?? 'leaderboard';
              keyboardView.current = nextView;
              startView(nextView);
              router.push(href({ view: nextView }), {
                scroll: false,
              });
              document.getElementById(`${prefix}-${orderedTabs[next]?.id}-tab`)?.focus();
            }}
          >
            {tab.label}
            <NavigationPending />
          </NavigationLink>
        ))}
      </div>
      {orderedTabs.map((tab, index) => (
        <section
          key={tab.id}
          id={`${prefix}-${tab.id}-panel`}
          role="tabpanel"
          aria-labelledby={`${prefix}-${tab.id}-tab`}
          hidden={selected !== index}
          tabIndex={0}
          className="board-panel"
        >
          {selected === index ? tab.content : null}
        </section>
      ))}
    </WorkspacePositionContext.Provider>
  );
}
