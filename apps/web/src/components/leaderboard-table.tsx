import Link from 'next/link';

import { sortLeaderboardByPointEstimate } from '../data/format.ts';
import { presentLeaderboardEntry } from '../data/leaderboard-presentation.ts';
import type { LeaderboardEntry } from '../data/types.ts';

export function LeaderboardTable({ entries }: { entries: readonly LeaderboardEntry[] }) {
  const ordered = sortLeaderboardByPointEstimate(entries);
  return (
    <div
      className="table-scroll"
      tabIndex={0}
      role="region"
      aria-label="Descriptively ordered public index table"
    >
      <table>
        <caption>
          Descriptive order by fixed-fixture AIQ index, high to low. This is a task index, not an IQ
          estimate, and the order does not identify a statistical winner.
        </caption>
        <thead>
          <tr>
            <th scope="col">Model / reasoning</th>
            <th scope="col">AIQ index</th>
            <th scope="col">Task sensitivity</th>
            <th scope="col">Samples</th>
            <th scope="col">Coverage</th>
            <th scope="col">Runtime issues</th>
            <th scope="col">Scoring</th>
            <th scope="col">Completeness</th>
            <th scope="col">Evidence</th>
            <th scope="col">Run</th>
          </tr>
        </thead>
        <tbody>
          {ordered.map((entry) => {
            const presentation = presentLeaderboardEntry(entry);
            return (
              <tr key={entry.id}>
                <th scope="row">
                  <strong>{entry.modelFamily}</strong>
                  <span>
                    {entry.modelName} · {entry.reasoningTier}
                  </span>
                </th>
                <td className="score">{presentation.score}</td>
                <td>{presentation.confidenceInterval}</td>
                <td>{presentation.samples}</td>
                <td>{presentation.coverage}</td>
                <td>{presentation.runtimeIssues ?? '—'}</td>
                <td>
                  {presentation.scoringVersion ? <code>{presentation.scoringVersion}</code> : '—'}
                </td>
                <td>{presentation.status}</td>
                <td>{presentation.evidence}</td>
                <td>
                  {presentation.runHref ? <Link href={presentation.runHref}>Inspect</Link> : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
