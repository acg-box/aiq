import Link from 'next/link';
import { createPageMetadata } from '../site-metadata.ts';

export const metadata = createPageMetadata({
  title: 'How to read the evidence',
  path: '/about',
  description:
    'Understand AIQ study conditions, completeness, source binding, time, costs, and limits.',
});

export default function AboutPage() {
  return (
    <article className="research-shell research-inner research-about">
      <h1>Read the evidence, then decide.</h1>
      <p className="research-lead">
        Start with a benchmark board, then choose a test. AI Intelligence, Harness Rank, and Mem are
        peer boards. Each board has its own comparisons, studies, cases, and original evidence.
      </p>
      <section className="research-section">
        <h2>A board groups tests of one capability</h2>
        <p>
          <Link href="/benchmarks/intelligence">AI Intelligence</Link> contains AIQ Core.{' '}
          <Link href="/benchmarks/harness">Harness Rank</Link> studies model–harness combinations,
          beginning with Codex, Hermes, and Pi. Its first protocol is design only.{' '}
          <Link href="/benchmarks/memory">Mem</Link> contains native memory, reader, and writer
          comparisons. A leaderboard belongs to a particular benchmark and its recorded conditions.
          New capability boards can have their own tests; scores do not combine across boards.
        </p>
      </section>
      <section className="research-section">
        <h2>Start with the task</h2>
        <p>
          A model replay, native retrieval test, extraction replay, and complete Agent workflow
          measure different behavior. Compare subjects within the same recorded study and workload.
          Model version, provider, effort, output allowance, parser, embedding width, and system
          version can change the result.
        </p>
      </section>
      <section className="research-section">
        <h2>Separate quality, time, and cost</h2>
        <p>
          Complete answers, literal quote bindings, and per-quote checks use different denominators.
          Read all three. A matching quote can still describe the wrong project or fail to support a
          claim. Missing and infrastructure-invalid results remain unavailable; they are not
          semantic zeros.
        </p>
        <p>
          Settled USD is actual reported API spend for the stated calls. An estimate is labelled as
          an estimate. Neither includes local hardware, operator time, or subscription usage unless
          the study says so. A single non-streaming request time is not a stable provider speed
          ranking.
        </p>
      </section>
      <section className="research-section">
        <h2>Open a case</h2>
        <p>
          Follow the comparison to a saved question, answer, citations, and returned context. Check
          whether a failure happened before retrieval, during extraction, or in the final answer.
          Keep a failed output even when later work repairs the problem.
        </p>
      </section>
      <section className="research-section">
        <h2>Inspect the original files</h2>
        <p>
          Selected originals keep their exact bytes, SHA-256, and source links. A hash proves file
          identity, not scientific validity. Private archives and provider credentials stay outside
          the public library.
        </p>
        <p>
          Mem compares OpenViking, RAGFlow, and fixed-context model replays. Each study has its own
          limits. They are not AIQ Core Calibration or Official publications. No universal AIQ score
          combines these studies.
        </p>
      </section>
      <section className="research-section">
        <h2>AIQ Core has its own contract</h2>
        <p>
          The fixed task matrix, Rasch measurement, Calibration, and Official publication rules
          belong to the <Link href="/benchmarks/intelligence?view=method">AIQ Core benchmark</Link>.
          Its Rust runner retains usage accounting, checkpoints, content-addressed packages, and
          independent evaluator replay. Those rules do not block clearly identified independent
          study pages.
        </p>
      </section>
      <Link className="research-text-link" href="/">
        Explore the studies
      </Link>
    </article>
  );
}
