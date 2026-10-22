'use client';

import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { CaretDownIcon } from '@phosphor-icons/react/dist/csr/CaretDown';

export function ReferenceDisclosure({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  const disclosure = useRef<HTMLDetailsElement>(null);
  useLayoutEffect(() => {
    function revealAnchor() {
      const element = disclosure.current;
      const targetId = window.location.hash.slice(1);
      if (!element || !targetId) return;
      const target = document.getElementById(targetId);
      if (!target || !element.contains(target)) return;
      element.open = true;
      const heading = element.querySelector<HTMLElement>('h3');
      heading?.focus({ preventScroll: true });
      heading?.scrollIntoView({ block: 'start' });
    }
    revealAnchor();
    window.addEventListener('hashchange', revealAnchor);
    window.addEventListener('popstate', revealAnchor);
    return () => {
      window.removeEventListener('hashchange', revealAnchor);
      window.removeEventListener('popstate', revealAnchor);
    };
  }, []);
  return (
    <details id={id} ref={disclosure} className="reference-disclosure">
      <summary>
        <div>
          <h3 id={`${id}-heading`} tabIndex={-1}>
            {title}
          </h3>
          <small>{description}</small>
        </div>
        <CaretDownIcon size={16} aria-hidden="true" />
      </summary>
      <div className="reference-disclosure-body">{children}</div>
    </details>
  );
}
