import type { Metadata } from 'next';

import { ReadStateNote } from '../../components/read-state-note.tsx';
import {
  classifyObservationRecency,
  formatLastObservation,
  formatProtocolToken,
  formatRegistryStatus,
  formatTrustLevel,
  TRUST_LEVELS,
} from '../../data/format.ts';
import type { RegistryStatus } from '../../data/types.ts';
import { readPublicData } from '../../data/read-state.ts';
import { createAiqRepository } from '../../data/repository.ts';
import { createPageMetadata } from '../site-metadata.ts';

export const metadata: Metadata = createPageMetadata({
  title: 'Radar',
  path: '/radar',
  description: 'Inspect AIQ runner identity, signed observations, assignments, and trust evidence.',
});
export const dynamic = 'force-dynamic';

const registryStatuses: readonly RegistryStatus[] = [
  'pending',
  'active',
  'degraded',
  'offline',
  'revoked',
];

export default async function RadarPage() {
  const repository = createAiqRepository();
  const result = await readPublicData(
    repository,
    () => repository.listRadarNodes(),
    [],
    (value) => value.length === 0,
    (value) => value.map((node) => node.synthetic),
  );
  const nodes = result.data;
  const now = new Date();
  const statusSummary = registryStatuses
    .map(
      (status) =>
        `${formatRegistryStatus(status)} ${nodes.filter((node) => node.registryStatus === status).length}`,
    )
    .join(' · ');
  const trustSummary = TRUST_LEVELS.map(
    (trust) =>
      `${formatTrustLevel(trust)} ${nodes.filter((node) => node.registryTrust === trust).length}`,
  ).join(' · ');
  const recency = nodes.map((node) => classifyObservationRecency(node.registryLastSeenAt, now));
  return (
    <section className="page-shell inner-page">
      <div className="page-intro">
        <span className="eyebrow">Runner evidence</span>
        <h1>Runner provenance</h1>
        <p>
          Registry identity, signed capability and observation records, assignment history, and
          trust-layer aggregation are separate evidence. None of these records is a live heartbeat.
        </p>
      </div>
      <ReadStateNote result={result} />
      {result.state === 'unavailable' ? null : (
        <>
          <section className="radar-summary" aria-labelledby="runner-summary-heading">
            <div className="section-heading compact">
              <div>
                <span className="eyebrow">Exact retained records</span>
                <h2 id="runner-summary-heading">Registry and evidence summary</h2>
              </div>
              <p>No distance, angle, or animation is used to imply topology or liveness.</p>
            </div>
            <dl className="radar-summary-grid">
              <div>
                <dt>Nodes</dt>
                <dd>{nodes.length}</dd>
              </div>
              <div>
                <dt>Registry status</dt>
                <dd>{statusSummary || 'No nodes'}</dd>
              </div>
              <div>
                <dt>Registry trust</dt>
                <dd>{trustSummary || 'No nodes'}</dd>
              </div>
              <div>
                <dt>Registry record recency</dt>
                <dd>
                  recent {recency.filter((value) => value === 'recent').length} · stale{' '}
                  {recency.filter((value) => value === 'stale').length} · never/unavailable{' '}
                  {recency.filter((value) => value === 'never' || value === 'unavailable').length}
                </dd>
              </div>
              <div>
                <dt>Verified observation signatures</dt>
                <dd>
                  {
                    nodes.filter((node) => node.latestObservation?.signatureStatus === 'verified')
                      .length
                  }
                </dd>
              </div>
              <div>
                <dt>Capability records</dt>
                <dd>
                  {nodes.filter((node) => node.latestCapability !== null).length}/{nodes.length}
                </dd>
              </div>
              <div>
                <dt>Observation records</dt>
                <dd>
                  {nodes.filter((node) => node.latestObservation !== null).length}/{nodes.length}
                </dd>
              </div>
              <div>
                <dt>Evidence provenance</dt>
                <dd>
                  published {nodes.filter((node) => !node.synthetic).length} · synthetic{' '}
                  {nodes.filter((node) => node.synthetic).length}
                </dd>
              </div>
              <div>
                <dt>Trusted aggregation inputs</dt>
                <dd>
                  {nodes.reduce(
                    (total, node) => total + node.aggregation.receiverVerifiedTrusted,
                    0,
                  )}
                </dd>
              </div>
            </dl>
          </section>
          <div
            className="table-scroll radar-register"
            role="region"
            aria-label="Runner registry evidence"
            tabIndex={0}
          >
            <table>
              <caption>
                Exact registry, trust, recency, signature, and provenance state for each public
                node.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Node</th>
                  <th scope="col">Registry</th>
                  <th scope="col">Trust</th>
                  <th scope="col">Registry record</th>
                  <th scope="col">Capability evidence</th>
                  <th scope="col">Observation evidence</th>
                  <th scope="col">Provenance</th>
                </tr>
              </thead>
              <tbody>
                {nodes.map((node) => (
                  <tr key={node.id}>
                    <th scope="row">
                      {node.name}
                      <small>{node.operator}</small>
                    </th>
                    <td>{formatRegistryStatus(node.registryStatus)}</td>
                    <td>{formatTrustLevel(node.registryTrust)}</td>
                    <td>{formatLastObservation(node.registryLastSeenAt, now)}</td>
                    <td>
                      {node.latestCapability
                        ? `${formatProtocolToken(node.latestCapability.status)} · signature ${formatProtocolToken(node.latestCapability.signatureStatus)} · ${formatLastObservation(node.latestCapability.observedAt, now)}`
                        : 'No published record'}
                    </td>
                    <td>
                      {node.latestObservation
                        ? `${formatProtocolToken(node.latestObservation.state)} · ${formatProtocolToken(node.latestObservation.recordStatus)} · signature ${formatProtocolToken(node.latestObservation.signatureStatus)} · ${formatLastObservation(node.latestObservation.observedAt, now)}`
                        : 'No published record'}
                    </td>
                    <td>{node.synthetic ? 'Synthetic and unverified' : 'Published'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="node-grid">
            {nodes.map((node) => (
              <article className="node-card" key={node.id}>
                <header>
                  <div>
                    <span className={`status-dot ${node.registryStatus}`} aria-hidden="true" />
                    <span>Registry: {formatRegistryStatus(node.registryStatus)}</span>
                  </div>
                  <span className={`trust ${node.registryTrust}`}>
                    Registry trust: {formatTrustLevel(node.registryTrust)}
                  </span>
                </header>
                <h2>{node.name}</h2>
                <p>{node.operator}</p>
                <dl className="node-identity">
                  <div>
                    <dt>Identity</dt>
                    <dd>
                      <code>{node.publicKeyFingerprint}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Registry last-seen record</dt>
                    <dd>{formatLastObservation(node.registryLastSeenAt)}</dd>
                  </div>
                  <div>
                    <dt>Evidence</dt>
                    <dd>{node.synthetic ? 'Synthetic and unverified' : 'Published'}</dd>
                  </div>
                </dl>
                <section className="radar-evidence" aria-label={`${node.name} capability evidence`}>
                  <h3>Latest signed capability record</h3>
                  {node.latestCapability ? (
                    <dl>
                      <div>
                        <dt>Schema</dt>
                        <dd>{node.latestCapability.schemaVersion}</dd>
                      </div>
                      <div>
                        <dt>Record / signature</dt>
                        <dd>
                          {formatProtocolToken(node.latestCapability.status)} /{' '}
                          {formatProtocolToken(node.latestCapability.signatureStatus)}
                        </dd>
                      </div>
                      <div>
                        <dt>Observed at</dt>
                        <dd>{formatLastObservation(node.latestCapability.observedAt)}</dd>
                      </div>
                      <div>
                        <dt>Content hash</dt>
                        <dd>
                          <code>{node.latestCapability.contentHash}</code>
                        </dd>
                      </div>
                    </dl>
                  ) : (
                    <p>No capability record is published.</p>
                  )}
                </section>
                <section
                  className="radar-evidence"
                  aria-label={`${node.name} observation evidence`}
                >
                  <h3>Latest signed observation record</h3>
                  {node.latestObservation ? (
                    <dl>
                      <div>
                        <dt>Reported node state</dt>
                        <dd>{formatProtocolToken(node.latestObservation.state)}</dd>
                      </div>
                      <div>
                        <dt>Receiver disposition</dt>
                        <dd>{formatProtocolToken(node.latestObservation.recordStatus)}</dd>
                      </div>
                      <div>
                        <dt>Sequence / signature</dt>
                        <dd>
                          {node.latestObservation.sequence} /{' '}
                          {formatProtocolToken(node.latestObservation.signatureStatus)}
                        </dd>
                      </div>
                      <div>
                        <dt>Schema</dt>
                        <dd>{node.latestObservation.schemaVersion}</dd>
                      </div>
                      <div>
                        <dt>Observed at</dt>
                        <dd>{formatLastObservation(node.latestObservation.observedAt)}</dd>
                      </div>
                      <div>
                        <dt>Content / provenance hashes</dt>
                        <dd>
                          <code>{node.latestObservation.contentHash}</code>
                          <br />
                          <code>{node.latestObservation.provenanceHash}</code>
                        </dd>
                      </div>
                    </dl>
                  ) : (
                    <p>No observation record is published.</p>
                  )}
                </section>
                <section className="radar-evidence" aria-label={`${node.name} assignment history`}>
                  <h3>Assignment lifecycle</h3>
                  <dl className="count-grid">
                    {Object.entries(node.assignmentCounts).map(([label, count]) => (
                      <div key={label}>
                        <dt>{formatProtocolToken(label)}</dt>
                        <dd>{count}</dd>
                      </div>
                    ))}
                  </dl>
                  <h3>Result receipts</h3>
                  <dl className="count-grid">
                    {Object.entries(node.receiptCounts).map(([label, count]) => (
                      <div key={label}>
                        <dt>{formatProtocolToken(label)}</dt>
                        <dd>{count}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
                <section
                  className="radar-evidence trust-aggregation"
                  aria-label={`${node.name} trust-layer aggregation`}
                >
                  <h3>Trust-layer aggregation</h3>
                  <dl className="count-grid">
                    <div>
                      <dt>Receiver-verified trusted</dt>
                      <dd>{node.aggregation.receiverVerifiedTrusted}</dd>
                    </div>
                    <div>
                      <dt>Signed untrusted</dt>
                      <dd>{node.aggregation.signedUntrusted}</dd>
                    </div>
                    <div>
                      <dt>Rejected</dt>
                      <dd>{node.aggregation.rejected}</dd>
                    </div>
                    <div>
                      <dt>Missing</dt>
                      <dd>{node.aggregation.missing}</dd>
                    </div>
                    <div>
                      <dt>Aggregated at</dt>
                      <dd>
                        {node.aggregation.aggregatedAt
                          ? formatLastObservation(node.aggregation.aggregatedAt)
                          : 'Not aggregated'}
                      </dd>
                    </div>
                  </dl>
                </section>
              </article>
            ))}
          </div>
          <article className="explain-card">
            <span className="eyebrow">How trust works</span>
            <h2>A signature proves origin, not quality.</h2>
            <p>
              Signature status, registry trust, and receiver aggregation are independent. A signed
              but untrusted input is not a receiver-verified trusted input. Synthetic seed records
              do not prove identity, liveness, deployment, coordination, or signature verification.
            </p>
          </article>
        </>
      )}
    </section>
  );
}
