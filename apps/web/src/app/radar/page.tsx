import type { Metadata } from 'next';

import { ReadStateNote } from '../../components/read-state-note.tsx';
import {
  formatLastObservation,
  formatProtocolToken,
  formatRegistryStatus,
  formatTrustLevel,
  radarOrbitPosition,
} from '../../data/format.ts';
import { readPublicData } from '../../data/read-state.ts';
import { createAiqRepository } from '../../data/repository.ts';

export const metadata: Metadata = { title: 'Radar' };
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
  return (
    <section className="page-shell inner-page">
      <div className="page-intro">
        <span className="eyebrow">Execution radar</span>
        <h1>Know the runner behind the result.</h1>
        <p>
          Registry identity, signed capability and observation records, assignment history, and
          trust-layer aggregation are separate evidence. None of these records is a live heartbeat.
        </p>
      </div>
      <ReadStateNote result={result} />
      {result.state === 'unavailable' ? null : (
        <>
          <div className="radar-summary">
            <div className="radar-orbit" aria-hidden="true">
              <i />
              <i />
              <i />
              {nodes.map((node, index) => (
                <span
                  key={node.id}
                  className={node.registryStatus}
                  style={radarOrbitPosition(index)}
                />
              ))}
            </div>
            <dl>
              <div>
                <dt>Nodes</dt>
                <dd>{nodes.length}</dd>
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
                <dt>Active registry entries</dt>
                <dd>{nodes.filter((node) => node.registryStatus === 'active').length}</dd>
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
