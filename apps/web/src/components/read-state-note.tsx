import type { PublicReadState, PublicValueState } from '../data/read-state.ts';

export function ReadStateNote({
  result,
  subject,
}: {
  result: PublicReadState<unknown> | PublicValueState<unknown>;
  subject?: string;
}) {
  const subjectPrefix = subject ? <strong>{subject}: </strong> : null;
  if (result.state === 'synthetic') {
    return (
      <div
        className="data-note"
        data-state="synthetic"
        aria-label={`${subject ?? 'Data'} provenance`}
        role="note"
      >
        <span className="eyebrow">Synthetic / seed data</span>
        <p>
          {subjectPrefix}Values demonstrate the AIQ v1 product contract. They are not measured model
          claims.
        </p>
      </div>
    );
  }
  if (result.state === 'published') {
    return (
      <div
        className="data-note"
        data-state="published"
        aria-label={`${subject ?? 'Data'} provenance`}
        role="note"
      >
        <span className="eyebrow">Published evidence</span>
        <p>{subjectPrefix}Values come from RLS-protected public reads.</p>
      </div>
    );
  }
  if (result.state === 'mixed') {
    return (
      <div
        className="data-note"
        data-state="mixed"
        aria-label={`${subject ?? 'Data'} provenance`}
        role="note"
      >
        <span className="eyebrow">Mixed evidence</span>
        <p>
          {subjectPrefix}This read contains synthetic demonstration rows and published evidence.
        </p>
      </div>
    );
  }
  if (result.state === 'empty') {
    return (
      <div
        className="data-note"
        data-state="empty"
        aria-label={`${subject ?? 'Data'} status`}
        role="status"
      >
        <span className="eyebrow">No published evidence</span>
        <p>{subjectPrefix}The live public read is available, but it has no evidence to display.</p>
      </div>
    );
  }
  return (
    <div
      className="data-note"
      data-state="invalid"
      aria-label={`${subject ?? 'Data'} status`}
      role="alert"
    >
      <span className="eyebrow">Published evidence unavailable</span>
      <p>
        {subjectPrefix}The live public read could not be read. No synthetic measurements were
        substituted.
      </p>
      <small>{result.detail}</small>
    </div>
  );
}
