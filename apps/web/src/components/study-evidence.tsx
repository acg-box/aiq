import { findEvidence } from '../studies/repository.ts';
import { alphabetical } from '../display-order.ts';
import type { EvidenceFile } from '../studies/types.ts';
import { DownloadSimpleIcon } from '@phosphor-icons/react/dist/ssr/DownloadSimple';
import { ReferenceViewLinks } from './reference-view-links.tsx';
import { TableColumnHeading } from './table-column-heading.tsx';

export function EvidenceLinks({ ids }: { ids: string[] }) {
  const files = [...new Set(ids)].flatMap((id) => {
    const file = findEvidence(id);
    return file ? [file] : [];
  });
  const names = files.map((file) => file.path.split('/').at(-1) ?? file.path);
  const duplicateNames = new Set(names.filter((name, index) => names.indexOf(name) !== index));
  const displayName = (file: EvidenceFile) => {
    const name = file.path.split('/').at(-1) ?? file.path;
    return duplicateNames.has(name) ? file.path : name;
  };
  const orderedFiles = alphabetical(files, (file) => `${displayName(file)} ${file.bundle}`);
  return (
    <ul className="research-file-links">
      {orderedFiles.map((file) => (
        <li key={file.id}>
          <a
            href={file.href}
            download={file.path.split('/').at(-1)}
            aria-label={
              duplicateNames.has(file.path.split('/').at(-1) ?? file.path)
                ? `${file.path} · ${file.bundle}`
                : undefined
            }
          >
            <DownloadSimpleIcon size={15} aria-hidden="true" />
            {displayName(file)}
          </a>
          {duplicateNames.has(file.path.split('/').at(-1) ?? file.path) ? (
            <span className="research-file-bundle">{file.bundle}</span>
          ) : null}
          <details className="source-identity">
            <summary>File identity</summary>
            <dl className="file-identity-facts">
              <div>
                <dt>SHA-256</dt>
                <dd>
                  <code>{file.sha256}</code>
                </dd>
              </div>
              <div>
                <dt>Size</dt>
                <dd>{file.bytes.toLocaleString('en-US')} bytes</dd>
              </div>
              <div>
                <dt>Source</dt>
                <dd>
                  {file.sourceUrl ? (
                    <a href={file.sourceUrl}>Frozen source ↗</a>
                  ) : (
                    'Preserved local report'
                  )}
                </dd>
              </div>
            </dl>
          </details>
        </li>
      ))}
    </ul>
  );
}

const evidenceNames: Record<string, string> = {
  'metrics.json': 'Measured summary',
  'protocol.json': 'Protocol and settings',
  'reader-review.json': 'Reader review',
  'report.md': 'Study report',
  'results-summary.json': 'Results summary',
  'review-openviking.json': 'OpenViking review',
  'review-ragflow.json': 'RAGFlow review',
  'writer-review.json': 'Writer review',
};
const evidenceScopes: Record<string, string> = {
  '2026-10-15-native-kb-memory': 'Native retrieval · October 15',
  'deepseek-flash-1017-20261020': 'Luna / DeepSeek · October 20',
  'luna-reasoning-20261020': 'Luna effort · October 20',
  'ragflow-nightly-20261020': 'RAGFlow nightly · October 20',
  'retained-reports': 'Native retrieval · October 15',
};
function evidenceName(file: EvidenceFile) {
  return (
    evidenceNames[file.path] ?? (file.bundle === 'retained-reports' ? 'Study report' : file.path)
  );
}

function EvidenceFiles({
  files,
  supporting = false,
}: {
  files: EvidenceFile[];
  supporting?: boolean;
}) {
  return (
    <div
      className="research-table-scroll"
      role="region"
      tabIndex={0}
      aria-label={supporting ? 'Supporting files' : 'Evidence files'}
    >
      <table className="research-table study-download-table">
        <caption className="sr-only">
          Original evidence downloads with file identity and provenance on demand
        </caption>
        <thead>
          <tr>
            <th scope="col">
              <TableColumnHeading label="File" unit="download" />
            </th>
            <th scope="col">
              <TableColumnHeading label="Applies to" />
            </th>
            <th scope="col">
              <TableColumnHeading label="Identity" unit="and origin" />
            </th>
          </tr>
        </thead>
        <tbody>
          {files.map((file) => (
            <tr key={file.id}>
              <th scope="row">
                <a href={file.href} download={file.path.split('/').at(-1)}>
                  <DownloadSimpleIcon size={15} aria-hidden="true" />
                  {evidenceName(file)}
                </a>
                {evidenceName(file) !== file.path ? (
                  <small className="study-download-path">{file.path}</small>
                ) : null}
              </th>
              <td className="study-download-scope">{evidenceScopes[file.bundle] ?? file.bundle}</td>
              <td className="study-download-identity">
                <details className="file-integrity">
                  <summary>File details</summary>
                  <dl className="file-identity-facts">
                    <div>
                      <dt>Size</dt>
                      <dd>{new Intl.NumberFormat('en-US').format(file.bytes)} bytes</dd>
                    </div>
                    <div>
                      <dt>SHA-256</dt>
                      <dd>
                        <code className="research-hash">{file.sha256}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>Source</dt>
                      <dd>
                        {file.sourceUrl ? (
                          <a href={file.sourceUrl}>Frozen source ↗</a>
                        ) : (
                          'Preserved local report'
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>Bundle</dt>
                      <dd>
                        <code>{file.bundle}</code>
                      </dd>
                    </div>
                  </dl>
                </details>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function StudyEvidence({ files }: { files: EvidenceFile[] }) {
  const primary = alphabetical(
    files.filter((file) => evidenceNames[file.path] || file.bundle === 'retained-reports'),
    (file) => `${evidenceName(file)} ${evidenceScopes[file.bundle] ?? file.bundle}`,
  );
  const primaryIds = new Set(primary.map((file) => file.id));
  const supporting = alphabetical(
    files.filter((file) => !primaryIds.has(file.id)),
    (file) => file.path,
  );
  return (
    <section className="reference-page" id="evidence">
      <div className="reference-availability">
        <p>
          {primary.length} report, protocol, and review files · {supporting.length} supporting
          records
        </p>
        <ReferenceViewLinks
          links={[
            { view: 'records', label: 'Browse cases' },
            { view: 'method', label: 'Read method' },
          ]}
        />
      </div>
      <EvidenceFiles files={primary} />
      <details className="research-disclosure">
        <summary>
          All supporting evidence, contexts, and outputs · {supporting.length} files
        </summary>
        <EvidenceFiles files={supporting} supporting />
      </details>
      <details className="research-disclosure evidence-reading-notes">
        <summary>File counts, checksums, and preservation</summary>
        <p>
          {files.length} source records reference {new Set(files.map((file) => file.sha256)).size}{' '}
          distinct files. A file can appear in more than one source record.
        </p>
        <p>
          SHA-256 identifies file contents, not conclusion validity. Download a file and compare its
          full checksum in File details. Private archives and provider credentials are excluded.
        </p>
      </details>
    </section>
  );
}
