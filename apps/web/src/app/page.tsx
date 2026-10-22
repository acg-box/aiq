import Link from 'next/link';
import { BenchmarkBoards } from '../components/benchmark-boards.tsx';

export default function HomePage() {
  return (
    <div className="research-shell benchmark-workspace">
      <header className="benchmark-heading">
        <div>
          <h1>Overview</h1>
          <p>Available results, comparison conditions and evidence across all three boards.</p>
        </div>
      </header>
      <BenchmarkBoards />
      <p className="directory-note">
        Metrics belong to the selected benchmark.{' '}
        <Link href="/about">Metric definitions and evidence scope</Link>
      </p>
    </div>
  );
}
