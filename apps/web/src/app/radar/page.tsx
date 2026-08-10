import type { Metadata } from 'next';

import { ReadStateNote } from '../../components/read-state-note.tsx';
import {
  classifyObservationRecency,
  formatLastObservation,
  formatProtocolToken,
  formatRegistryStatus,
  formatTrustLevel,
} from '../../data/format.ts';
import { readPublicData } from '../../data/read-state.ts';
import { createAiqRepository } from '../../data/repository.ts';
import { createPageMetadata } from '../site-metadata.ts';

export const metadata: Metadata = createPageMetadata({
  title: 'Radar',
  path: '/radar',
  description: 'Inspect AIQ runner identity, signed observations, assignments, and trust evidence.',
});
export const dynamic = 'force-dynamic';

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
  const recency = nodes.map((node) => classifyObservationRecency(node.registryLastSeenAt, now));
  const reportingNodes = nodes.filter(
    (node) =>
      node.registryLastSeenAt !== null ||
      node.latestCapability !== null ||
      node.latestObservation !== null,
  );
  return (
    <section className="page-shell inner-page">
      <div className="page-intro">
        <span className="eyebrow">Distributed radar</span>
        <h1>Runner network</h1>
        <p>
          AIQ has {nodes.length} registered production{' '}
          {nodes.length === 1 ? 'identity' : 'identities'}.
          {reportingNodes.length === 0
            ? ' Radar telemetry is not enabled, so live online or offline state is unknown.'
            : ' This view separates registry identity from signed telemetry and receiver trust.'}
        </p>
      </div>
      <ReadStateNote result={result} subject="Runner network" />
      {result.state === 'unavailable' ? null : (
        <>
          <section className="radar-summary" aria-labelledby="runner-summary-heading">
            <div className="section-heading compact">
              <div>
                <span className="eyebrow">Exact retained records</span>
                <h2 id="runner-summary-heading">Network status</h2>
              </div>
              <p>Counts come from retained registry and signed observation records.</p>
            </div>
            <dl className="radar-summary-grid">
              <div>
                <dt>Nodes</dt>
                <dd>{nodes.length}</dd>
              </div>
              <div>
                <dt>Reporting telemetry</dt>
                <dd>
                  {reportingNodes.length}/{nodes.length}
                </dd>
              </div>
              <div>
                <dt>Recently observed</dt>
                <dd>
                  {recency.filter((value) => value === 'recent').length}/{nodes.length}
                </dd>
              </div>
              <div>
                <dt>Verified observations</dt>
                <dd>
                  {
                    nodes.filter((node) => node.latestObservation?.signatureStatus === 'verified')
                      .length
                  }
                </dd>
              </div>
              <div>
                <dt>Verified trusted results</dt>
                <dd>
                  {nodes.reduce(
                    (total, node) => total + node.aggregation.receiverVerifiedTrusted,
                    0,
                  )}
                </dd>
              </div>
            </dl>
          </section>
          <article className="explain-card radar-explanation">
            <span className="eyebrow">Trust model</span>
            <h2>A signature proves origin, not result quality.</h2>
            <p>
              Node identity, signature verification, and receiver trust are separate checks. Only
              receiver-verified evidence enters the trusted layer; synthetic records prove none of
              these states.
            </p>
          </article>
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
                  <th scope="col">Telemetry</th>
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
                    <td>
                      {node.latestCapability ||
                      node.latestObservation ||
                      node.registryLastSeenAt ? (
                        <span className="radar-telemetry-state">
                          <strong>
                            {node.latestObservation
                              ? `${formatProtocolToken(node.latestObservation.state)} · signature ${formatProtocolToken(node.latestObservation.signatureStatus)}`
                              : node.latestCapability
                                ? `${formatProtocolToken(node.latestCapability.status)} · signature ${formatProtocolToken(node.latestCapability.signatureStatus)}`
                                : 'Registry telemetry only'}
                          </strong>
                          <small>
                            Last record{' '}
                            {formatLastObservation(
                              node.latestObservation?.observedAt ??
                                node.latestCapability?.observedAt ??
                                node.registryLastSeenAt,
                              now,
                            )}
                          </small>
                        </span>
                      ) : (
                        <span className="radar-telemetry-state">
                          <strong>Registered identity</strong>
                          <small>Radar telemetry not enabled · live state unknown</small>
                        </span>
                      )}
                    </td>
                    <td>{node.synthetic ? 'Synthetic and unverified' : 'Published'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details className="evidence-notes radar-node-details">
            <summary>
              <strong>Node evidence</strong>
              <span>Capabilities, observations, assignments, receipts, and hashes</span>
            </summary>
            <div className="evidence-note-body node-grid">
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
                      <dd>
                        {node.registryLastSeenAt
                          ? formatLastObservation(node.registryLastSeenAt)
                          : 'No registry telemetry record'}
                      </dd>
                    </div>
                    <div>
                      <dt>Evidence</dt>
                      <dd>{node.synthetic ? 'Synthetic and unverified' : 'Published'}</dd>
                    </div>
                  </dl>
                  <section
                    className="radar-evidence"
                    aria-label={`${node.name} capability evidence`}
                  >
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
                      <p>Capability telemetry is not enabled for this identity.</p>
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
                      <p>Observation telemetry is not enabled for this identity.</p>
                    )}
                  </section>
                  <section
                    className="radar-evidence"
                    aria-label={`${node.name} assignment history`}
                  >
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
          </details>
        </>
      )}
    </section>
  );
}
