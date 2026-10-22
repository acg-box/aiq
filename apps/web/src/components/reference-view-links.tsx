'use client';

import Link from 'next/link';
import { useWorkspaceQuery } from './workspace-query.ts';

export function ReferenceViewLinks({
  links,
}: {
  links: readonly { view: string; label: string }[];
}) {
  const { href } = useWorkspaceQuery();
  return (
    <nav className="reference-actions" aria-label="Related views">
      {links.map((link) => (
        <Link key={link.view} className="ui-action" href={href({ view: link.view })}>
          {link.label} →
        </Link>
      ))}
    </nav>
  );
}
