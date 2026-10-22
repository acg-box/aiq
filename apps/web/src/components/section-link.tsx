'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';

export function SectionLink({
  targetId,
  href = `#${targetId}`,
  label,
  current = false,
  preserveVisibleTarget = false,
  children,
}: {
  targetId: string;
  href?: string;
  label?: string;
  current?: boolean;
  preserveVisibleTarget?: boolean;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-label={label}
      aria-current={current ? 'location' : undefined}
      prefetch={false}
      onNavigate={(event) => {
        const target = document.getElementById(targetId);
        if (!target) return;
        event.preventDefault();
        for (
          let ancestor: HTMLElement | null = target;
          ancestor;
          ancestor = ancestor.parentElement
        ) {
          if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
        }
        if (new URL(href, window.location.href).href !== window.location.href)
          window.history.pushState(null, '', href);
        target.focus({ preventScroll: true });
        const bounds = target.getBoundingClientRect();
        const topInset = Number.parseFloat(
          getComputedStyle(document.documentElement).scrollPaddingTop,
        );
        if (
          !preserveVisibleTarget ||
          bounds.top < topInset - 1 ||
          bounds.top > window.innerHeight / 2
        )
          target.scrollIntoView({ block: 'start' });
      }}
    >
      {children}
    </Link>
  );
}
