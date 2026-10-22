/** Display labels do not replace the preserved report titles or measured records. */
const studyNames: Record<string, string> = {
  'native-memory': 'Native memory systems',
  'luna-deepseek': 'Luna / DeepSeek Flash 1017',
  'luna-effort': 'Luna reasoning effort',
};

export function studyDisplayName(id: string, fallback: string): string {
  return studyNames[id] ?? fallback;
}

const findings: Record<string, Record<string, string>> = {
  'native-memory': {
    native:
      'OpenViking and RAGFlow rc1: 11/13 complete + bound. The RAGFlow nightly version check is separate; workloads are not pooled.',
    nightly:
      'RAGFlow nightly: 11/13 complete + bound. This is a separate version check; the other systems were not rerun.',
  },
  'luna-deepseek': {
    reader:
      'Both readers: 11/13 complete + bound. DeepSeek settled reader spend was about 4× Luna spend on these retained inputs.',
    writer:
      'Three paired writer inputs. No semantic writer-quality score was measured. The extra Chinese input is excluded from this table.',
  },
  'luna-effort': {
    reader:
      'Complete + bound: medium 11/13; low 10/13; none 11/13. The low profile includes a quote to an absent source handle.',
    writer:
      'Four writer inputs per profile; all outputs parsed as direct JSON. Returned atom counts do not measure semantic quality.',
  },
};

export function comparisonFinding(studyId: string, groupId: string): string {
  return findings[studyId]?.[groupId] ?? 'See the study protocol for interpretation and limits.';
}
