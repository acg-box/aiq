import type { DataProvenance } from '../data/provenance.ts';

const provenanceCopy: Record<DataProvenance, { label: string; detail: string }> = {
  synthetic: {
    label: 'Synthetic / seed data',
    detail:
      'Values demonstrate the AIQ 2.0 product contract. They are not measured model claims. Configure the public Supabase variables to read RLS-protected views.',
  },
  published: {
    label: 'Published evidence',
    detail:
      'Values come from RLS-protected public views. Inspect coverage, trust, scoring version, and run provenance before comparing entries.',
  },
  mixed: {
    label: 'Mixed evidence',
    detail:
      'This view contains both synthetic demonstration data and published evidence. Each row or point identifies its own provenance.',
  },
  unavailable: {
    label: 'No published evidence',
    detail: 'The fixed model matrix is available, but this view has no scored evidence to display.',
  },
};

export function DataNote({
  provenance,
  subject = 'Data',
}: {
  provenance: DataProvenance;
  subject?: string;
}) {
  const copy = provenanceCopy[provenance];
  return (
    <div
      className="data-note"
      data-state={provenance}
      aria-label={`${subject} provenance`}
      role="note"
    >
      <span className="eyebrow">{copy.label}</span>
      <p>{copy.detail}</p>
    </div>
  );
}
