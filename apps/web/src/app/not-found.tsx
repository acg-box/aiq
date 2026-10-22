import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Not found',
  robots: { index: false, follow: false },
};

export default function NotFound() {
  return (
    <section className="page-shell empty-page">
      <span className="eyebrow">404 · Not found</span>
      <h1>This evidence is not in the index.</h1>
      <p>The study, case, or run may not exist, or its public source is unavailable.</p>
      <Link className="button primary" href="/">
        Return to the index
      </Link>
    </section>
  );
}
