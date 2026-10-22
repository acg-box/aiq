import catalogue from './catalogue.json' with { type: 'json' };
import type { EvidenceFile, Study, StudyCatalogue } from './types.ts';

// These reviewed snapshots are public research, independent of the Core database.
// Keep this module on the server: client comparisons receive only their own rows.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Reviewed catalogue; cargo make check-studies verifies its records and original files.
const data = catalogue as StudyCatalogue;
const studies = data.studies;

export function listStudies(): Study[] {
  return studies;
}

export function findStudy(id: string): Study | undefined {
  return studies.find((study) => study.id === id);
}

export function findEvidence(id: string): EvidenceFile | undefined {
  return data.evidence.find((file) => file.id === id);
}

export function studyEvidence(study: Study): EvidenceFile[] {
  return data.evidence.filter(
    (file) =>
      study.evidenceBundles.includes(file.bundle) || study.relatedEvidenceIds.includes(file.id),
  );
}

export function studySummaries() {
  return studies.map(({ id, title, summary, category, date, sample }) => ({
    id,
    title,
    summary,
    category,
    date,
    sample,
  }));
}
