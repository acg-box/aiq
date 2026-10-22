# Study records and retained evidence

AIQ groups tests into peer capability boards. AI Intelligence contains AIQ Core;
Mem contains the three initial memory studies. Harness Rank owns model–harness
comparisons; its [first protocol](../harness-rank/README.md) is design only.
Reader and writer model replays
belong to Mem because they test the memory workflow. They are not general model
intelligence tests. Board discovery, a test comparison, a case, and original
evidence form one reading path. Each benchmark owns its measures and
interpretation. Do not combine these studies into a global AIQ or IQ score.

## Owners

ELF is retired. Its import scripts, adapter, import plan, indexed measurements,
case observations, and dedicated public originals have been removed. There is
no runtime filter that hides a second catalogue. OpenViking, RAGFlow, and model
replays retain their original measurements and source bytes.

| Owner                                                             | Responsibility                                                                                           |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `apps/web/src/benchmarks/boards.ts`                               | Peer benchmark boards and study membership; separate from within-board test types                        |
| `apps/web/src/benchmarks/memory-board.tsx`                        | Mem coverage, study/version register, case index, and original-file views                                |
| `apps/web/src/benchmarks/memory-results.tsx`                      | Shows all study comparisons first; links to a scoped chart, result table, and evidence                   |
| `apps/web/src/benchmarks/core-board.tsx`                          | Intelligence workspace; keeps current Official and historical datasets separate                          |
| `apps/web/src/components/benchmark-heading.tsx`, `board-tabs.tsx` | Compact board metadata and shared Leaderboard, Records, Method, and Data views                           |
| `apps/web/src/components/study-results-table.tsx`                 | Sortable scoped measurements, exact versions, missing values, and source links                           |
| `apps/web/src/studies/presentation.ts`                            | Neutral display labels and scoped findings; does not replace original records                            |
| `apps/web/src/studies/types.ts`                                   | Small display records for a study, subject/configuration, run, result, case, and evidence file           |
| `apps/web/src/studies/catalogue.json`                             | Reviewed study records and original-file identities; server components select only the data a page needs |
| `apps/web/public/evidence/studies/`                               | Byte-identical retained originals, named by SHA-256                                                      |
| `scripts/check-studies.ts`                                        | Checks original hashes, study-scoped references, case denominators, and reader totals                    |
| `databases/`                                                      | Sole Supabase SQL authority; unchanged by the snapshot import                                            |
| `apps/aiq-runner`, `apps/aiq-verifier`                            | Existing execution, usage accounting, checkpoints, package integrity, and evaluator replay               |

The versioned public catalogue and static files meet the current read-only
workload without a database or upload service for studies.
The 193 indexed source records map to 189 distinct SHA-256 files. Mem shows the
distinct file count and labels reused case inputs. These counts are not counts
of independent experiments. Its display records stay static and do not read Core data.
This is not a claim that study metadata was loaded into Supabase or evidence
was uploaded to Storage. Add a query or upload path when there is an actual
authoring need. Keep that change under the existing database and Storage owners.
Do not create a second SQL root or make the old Core initializer part of this path.

## Navigation

The boards share compact top navigation and Leaderboard, Records, Method, and Data views.
Filters are URL state. Result details open beside the table. Memory case pages
live at `/benchmarks/memory/records/[studyId]/[caseId]`; intelligence run details
live at `/benchmarks/intelligence/records/[id]`. Board context and return filters
stay with each detail page. During a page session, returning to a view restores
its scroll position, expanded evidence, and keyboard focus. Opening raw JSON
leaves the comparison in place. Mobile result details use the page scroll and include a close
action below the content. Retired Core, study, comparison, method, and history
entrypoints are removed rather than redirected. Original evidence remains at its
content-addressed path.

Mem opens with all six comparisons grouped by readers, systems, and writers.
Study labels give the source context. Each row shows recorded outcomes, resource
ranges and inputs per profile, and links to the scoped charts and result table
in the selected workspace. On wide screens, the overview and selected comparison
appear side by side. Writer quality remains unmeasured, and separate workloads
are not pooled.
Comparison controls are closed by default under Refine comparison. Core opens
with all available configurations; Harness opens with the comparison scope
and a task matrix. Each task opens its specification and acceptance gates. The
planned task counts remain separate from the unmeasured results. One set of
filters controls charts and tables. Links from a
chart move to the result table on the same page. Data contains original files,
benchmark definitions, and downloads. Mem uses the selected study and workload
for both charts and the ranked table.
AI Intelligence keeps the complete model and reasoning effort matrix beside the
filtered ranking on wide screens. A matrix value selects the same dataset, model,
and effort as the ranking. Filtering does not change recorded ranks or the
interval scale.
Answer rates use a zero-to-100% scale. Time and settled cost have separate
zero-based scales. Unavailable values distinguish unmeasured data from values
withheld from comparison. The native report records query times but forbids a
speed comparison because platforms and context sizes differ. Charts, rows, and
details label those times as withheld. Writer resource charts do not imply a
semantic quality score. Core's ranked rows retain the scorer's estimate
and 95% interval on one dataset-wide scale after filtering. Calibration, verification,
and time-series registers belong to Records. Harness charts show task-design counts only.
Filters remain in the URL when the reader opens detailed evidence or downloads.

Data, Method, Records, and case details share compact text, ruled sections,
source actions, and evidence controls. Method indexes link to sections on the
same page. Study selection stays behind Change study in these reference views.
The Core catalogue download is served at
`/api/benchmarks/intelligence/catalog`; the frozen repository link remains its
source reference. No endpoint runs an evaluation.
The top bar shows peer boards directly for the initial three-board catalogue.
Larger catalogues use the complete alphabetical board menu. Pending navigation
does not reserve space beside a link label or change its width.

## Historical provenance

The retained October 15 originals came from source commit
`233de86ac91e5f9249fd534134286d5f0f3fc858`. Their upstream repository URLs are
historical provenance, not an integration or execution dependency. The import
scripts and task have been removed. Use `cargo make check-studies` to check
the catalogue against the retained originals without model calls.

The original reports retain their old relative links. Use each study's evidence
index to find the corresponding public files. An original manifest also lists
unselected files; it is a source-bundle inventory, not a promise that private or
unselected contents are public. Locally completed October 20 reports have no
upstream Git URL. Label them as preserved local reports and provide their hashes.

Do not import the private `all-local-evidence.tar`, full budget ledger, logs,
private configs, or raw provider receipts. The complete original source and
archive remain under the transfer owner's custody. Repository archival does
not authorize deletion of those originals.

## First three studies

- Native OpenViking/RAGFlow: show the retained October 15 measurements; show October
  20 RAGFlow nightly as a separate version check. Separate shared-reader results
  from the three native Agent probes. Product summaries and reviews, rather than
  a retired system's combined report, support the table and case findings.
- Luna/DeepSeek Flash 1017: compare 13 fixed reader contexts and three paired
  English writer requests. The extra Chinese writer has no paired control in
  that campaign. Later controls do not change that historical condition.
- Luna effort: 13 reader inputs and four writer inputs per profile. Keep the
  workloads separate. Retain the original exploratory suggestion, but show the
  later judgment to keep one medium default as a separate interpretation.

An exact quote can belong to the wrong project. A source hash does not prove
semantic entailment. Native retrieval, extraction, parsing, storage, and final
Agent behavior are distinct evidence. A request failure or missing measurement
is not a semantic zero. Atom count is not a quality score. Settled spend, cost
estimates, conservative reservations, and operating costs remain distinct.

## Checks and limits

`cargo make check-studies` verifies every selected original hash and reference.
It reconciles displayed reader totals with the retained per-case reviews.
`cargo make test-browser-studies` checks desktop/mobile discovery, workload
selection, metric sorting, keyboard tabs, a real failure, and exact downloads.

These checks validate the catalogue and reading path. They do not rerun models,
establish statistical significance, independently endorse semantic judgments,
or prove production deployment. Core's 17-configuration matrix, Rasch fixed bank,
Calibration and Official requirements remain under its own benchmark contract.

No new paid evaluation is part of this change. Original budget statements cover
their recorded campaign periods. They are not a combined cost for the retained
comparisons or a current account balance.
