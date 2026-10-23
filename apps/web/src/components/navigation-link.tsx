import Link from 'next/link';
import type { ComponentProps } from 'react';

/** Load internal routes on navigation; cancelled speculative loads fail in WebKit. */
export function NavigationLink(props: Omit<ComponentProps<typeof Link>, 'prefetch'>) {
  return <Link {...props} prefetch={false} />;
}
