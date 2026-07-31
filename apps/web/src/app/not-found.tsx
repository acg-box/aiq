import Link from 'next/link';

export default function NotFound() {
  return (
    <section className="page-shell empty-page">
      <span className="eyebrow">404 · Not found</span>
      <h1>This evidence is not in the index.</h1>
      <p>The run may not exist, or the selected public view did not return it.</p>
      <Link className="button primary" href="/">
        Return to the index
      </Link>
    </section>
  );
}
