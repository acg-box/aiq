# Release dependency review, 2026-10-22

The release review found known advisories in the existing Web dependency graph.
The scoped patch roll changes Next.js 16.3.0 to 16.3.8, Sharp 0.35.3 to 0.35.5,
source-map-js 1.2.1 to 1.2.2, and Tinypool 2.1.0 to 2.1.2. Node, npm, React,
TypeScript, Playwright, and the formatter version are unchanged.

Next stays on the 16.3 line. Its [16.3.8 release](https://github.com/vercel/next.js/releases/tag/v16.3.8)
maps to commit `b0fad0d45eb4c4430fda5eeeb442e8a5af08a5f6` and was published on
2026-09-30. The obsolete Sharp override is removed so Next can use its patched
image dependency. The formatter's Tinypool override selects the patched 2.1
line without a formatter upgrade. See the
[Sharp advisory](https://github.com/advisories/GHSA-wq5f-xc86-pv6w) and
[Tinypool advisory](https://github.com/advisories/GHSA-85c8-ppgw-ccpr).

The generated lockfile changes only existing package identities, including
platform-specific SWC and Sharp binaries. Package sources remain the npm
registry; no changed package declares an install script. Resolution and install
used `--ignore-scripts`. The 2026-10-22 npm advisory scan changed from five
affected packages to zero. Registry checks verified 57 package signatures in
both graphs, with 36 baseline and 37 final provenance attestations. These checks
establish the stated origin and known-advisory evidence, not a general safety
guarantee. The complete repository verification gate runs on the final locked
graph before merge.

Dependency decision: `risk_coverage: complete`, `risk_delta: improved`,
`decision: proceed`. Unrelated Dependabot updates remain outside this patch
roll. The detailed baseline, final audit, signature, and graph records are in
the release receipt directory named below.

---

# Release regression: unified benchmark workspace, 2026-10-22

This review covers the homepage and the AI Intelligence, Harness Rank, and Mem
workspaces, including Data, Method, Records, and evidence details. The boards
share compact navigation, typography, table headings, disclosure controls, and
comparison colors. Historical Core results retain their original identity.
Harness Rank contains 24 draft task specifications and no measured trials.

The final local build passed 286 browser checks across seven suites. The main
interaction suite covers desktop Chromium, mobile Chromium, desktop Firefox,
and tablet WebKit, including 320 px layouts. Three checks are inapplicable to
non-mobile viewports. Additional suites cover invalid, malformed, missing,
empty, published, and production-contract fixture states. They do not run a
model or change the production database.

The review repaired keyboard focus after view changes, Safari return focus,
and the shared row component's unnecessary dependency on the Next.js router.
Data appears at full contrast during its entrance motion. Tests now open the
same compact disclosures that readers use, while retaining checks for exact
scores, units, source identity, and publication requirements.
Cancelling a pending view change preserves the reading position. Ten repeated
mobile checks cover both immediate cancellation and a completed round trip,
using pointer taps without an automation-induced scroll.

Source validation passed 699 Rust tests and 557 TypeScript tests. Type checks,
lint, formatting, schema checks, and the study checker passed. The study checker
verified 47 cases and all 193 source references backed by 189 distinct files.
The Session Pooler connection check passed with TLS 1.3 and a read-only
transaction. Before deployment, the public database snapshot contained 17
leaderboard rows, 34 run rows, and 2,448 task-result rows.

Production website acceptance uses `cargo make smoke-workspace-web`. It checks
all board views, About, calibration and verification records, retired routes,
task definition downloads, all retained cases, and original file hashes. It is
separate from the Official publication gate. Deployment and before/after data
receipts are stored outside the repository under
`CODEX_HOME/visualizations/2026/10/20/01a1587e-dfb9-7770-a228-c2b5549a3140/release-closeout-2026-10-22/`.

---

# Design QA: ELF retirement and retained evidence, 2026-10-22

The public catalogue now contains only retained OpenViking, RAGFlow, and model
replay records. ELF import and catalogue-generation scripts, import metadata,
measurements, case observations, and dedicated originals are removed. The
repository reads the cleaned catalogue directly. Retained original files use
`/evidence/studies/`; the old `/evidence/elf/` path returns 404.

The retained catalogue has three studies, six comparisons, 47 case pages,
193 source records, and 189 distinct files. Original bytes and historical
source provenance stay intact. Native comparisons use their own product
summary and reviews. Case protocols and expected-fact links now identify the
correct files; duplicate filenames include their relative path and source bundle.
All referenced reader baseline answers appear in the owning study's Data view.

Desktop and mobile review covers the homepage, Mem comparisons, all three
studies' Data, Method, Records, and case pages. The final case check expands
saved JSON and inspects original-file links at 1440 and 390 px. Long JSON
regions accept keyboard focus. The checked pages have no document overflow
or browser errors. The production build, repository and Web type checks,
TypeScript lint, study checks, and all 66 selected desktop/mobile browser
tests pass. Study checks verify all 193 original hashes and study-scoped
references. No model or harness experiment was run.

The database retirement and credential receipt is in `databases/README.md`.
The remote inventory required no data deletion. Local ELF database volumes
were removed. Captures and count-only receipts are in
`CODEX_HOME/visualizations/2026/10/20/01a1587e-dfb9-7770-a228-c2b5549a3140/elf-retirement/`.

---

# Prior design QA: Overview before configuration, 2026-10-21

Mem opens with all six retained comparisons. Each row identifies the study and workload,
compared profiles, complete source-bound answers, resource ranges, and inputs per profile.
Writer quality stays unmeasured. Each workload keeps its own denominator and cost scope.
The overview does not combine studies into an overall score.

Overview links update the detailed charts and table on the same page, then scroll and focus
the comparison heading. Browser history and evidence return paths retain the selected test.
Refine comparison contains the optional controls and is closed by default. Core shows all
available configurations before its controls. Harness shows its task design and unmeasured
status before its controls. Data remains the original-file and download view.

Mobile uses unframed rows with local measure labels. Header counts, comparison links, and
currency ranges fit at 320 px. Desktop uses one continuous table with no surrounding panel.

The production build, repository and Web type checks, TypeScript lint, 365 Web unit tests,
and the study evidence checker pass. Browser verification passes 44 cross-browser journeys
and seven published-state fixture journeys. After the final mobile typography changes,
all eight affected Mem journeys pass again in Chromium, Firefox, and WebKit. The responsive
audit passes 27 page and state checks at 1440, 900, 768, 760, 390, and 320 px, with no document
overflow, runtime errors, or Axe violations in the inspected states. The real Core preview
retains its historical publication label. Fixture publications are separate from real results.
No model or harness experiment was executed.

Captures and the responsive audit are in
`CODEX_HOME/visualizations/2026/10/20/01a1587e-dfb9-7770-a228-c2b5549a3140/overview-first/`.

---

# Prior design QA: Workspace surfaces and typography, 2026-10-21

This review replaces the intermediate nested-card treatment. It applies to AI Intelligence,
Harness Rank, Mem, and their shared detail views.

- Use a continuous content canvas. Separate sections with space and horizontal rules. Remove
  the outer page card, table perimeter, coverage badges, and segmented tab container. Keep
  rounded controls and modal boundaries where they identify an action or a separate layer.
- Use Inter for headings, navigation, prose, table labels, measurements, and chart text. Use
  lining tabular figures for numeric comparisons. Reserve IBM Plex Mono for technical notation,
  code, source identifiers, model IDs, and hashes. Keep explicit Chinese system-font fallbacks.
- Use 28 px board titles at weight 600, 20 px section headings, 13–14 px reading text, and
  11–12 px metadata. Use weight and spacing for hierarchy. Keep secondary source IDs subordinate
  to the model or profile name. Render task acceptance gates as one numbered list with rules.
- Keep search, reset, browser-history restoration, sticky table headers, navigation progress,
  focus restoration, backdrop dismissal, and reduced-motion behavior. Use motion for state and
  layer changes. Change theme text and background colors together to preserve contrast.

The production Web build, repository/Web type checks, repository TypeScript lint, all 365 Web
unit tests, and 32 selected browser journeys pass. Browser checks cover Chromium, Firefox,
WebKit, mobile and tablet layouts, 320 px task details, both themes, and Axe assertions.
The live preview was also reviewed with 17 historical Core configurations and actual Mem study
records. The inspected title and numeric cells resolve to Inter; numeric cells enable tabular
figures. This review does not execute model or harness experiments.

Current captures are in
`CODEX_HOME/visualizations/2026/10/20/01a1587e-dfb9-7770-a228-c2b5549a3140/workspace-ux/`:
`13-flat-intelligence.png`, `14-flat-memory.png`, `15-flat-intelligence-mobile.png`,
`16-flat-task-320.png`, and `17-flat-memory-mobile.png`.

---

# Prior design QA: Unified benchmark workspace cutover, 2026-10-20

This record supersedes the earlier page-structure acceptance below. Earlier screenshots and test
counts describe their source revision, not this cutover.

## Structure and behavior

- Compact top navigation connects the peer AI Intelligence, Harness Rank, and Mem boards. Core is a
  benchmark definition inside AI Intelligence. Each board has Leaderboard, Records, Method, and Data.
- The old Core, compare, trends, runs, method, studies, calibrations, and radar entry routes are
  removed. They return HTTP 404 without a compatibility redirect. Run, calibration, verification,
  and memory case details use their owning board namespace. The sitemap and internal links use
  those canonical paths.
- Removed duplicate workbench, ranking, matrix chart, study landing, and comparison components,
  together with their unused styles and obsolete interaction tests. Retained scientific identity,
  score, interval, cost, task-result, and publication checks.
- Model, effort, dataset, study, workload, and sort selections survive view changes and reloads.
  Complete run and calibration records retain a return URL. Case return retains the study and
  workload. Evidence drawers return focus to their trigger on close, including WebKit.
- The comparison table precedes interpretation. Mobile shows key measures together and keeps the
  complete diagnostic columns in All metrics. The 320-pixel case navigation shows all four views.
- Method reads the frozen repository definition and links to its exact catalogue revision. Domain
  counts come from that catalogue. This removes the stale Supabase active-tuple error without
  presenting synthetic measurements or a fabricated publication date.

## Source and verification

The real read-only Supabase preview contains 17 historical Core 1.0.7 configurations and 1,224
retained task results. The model family is GPT-5.6 and aggregate scoring is 1.0.8. Current Core
1.1.0 remains explicitly empty. The populated current Official state uses the scorer-owned local
contract fixture, which is separate from the real preview.

- Production Web build, repository and Web TypeScript checks, and repository TypeScript lint pass.
- All 363 Web unit tests pass. All 99 browser cases pass across the seven repository suites.
  The publication contract checks all 17 runs and 1,224 task cells, including exact identity,
  provenance, cost-status distribution, token coverage, and priced subtotal.
- The final responsive rerun passes 12 journeys in Chromium, Firefox, and WebKit. These include
  removed-route checks, source hash binding, case navigation, focus restoration, and Axe checks.
- Real-source review covers 1440 by 900, 390 by 844, and 320 by 844 viewports. It exercises ranking,
  combined filters, sorting, evidence drawers and originals, Records, Method, Data, case return,
  light and dark themes, and horizontal overflow. Browser console and page-error checks pass.
- Study checks retain three studies, 47 case pages, and 228 indexed evidence hashes. Original
  evidence bytes and the private archive boundary are unchanged.
- Web and changed-document formatting pass. A repository-wide format check still reports the two
  pre-existing candidate-generator files outside this UI cutover.

Current captures and the real-source verification record are in
`CODEX_HOME/visualizations/2026/10/20/01a1587e-dfb9-7770-a228-c2b5549a3140/unified-workspace/`.
The main files are `intelligence-1440.png`, `intelligence-390.png`, `memory-390.png`,
`memory-dark-320.png`, `memory-case-320.png`, `intelligence-method-390.png`, and `verification.json`.
IAB also captures the final desktop workspace. This is local UI acceptance. No database or Storage
write, new paid benchmark run, or production deployment is part of this cutover. Automated Axe
checks do not establish complete accessibility compliance.

---

# Prior design QA: Live Supabase Core results, 2026-10-20

The AI Intelligence board now reads real public Supabase results. The source
contains 17 non-synthetic configurations, each with 72 task results, completed
on August 28, 2026. Their benchmark is `aiq-core@1.0.7`, aggregate scoring is
`1.0.8`, and model names are GPT-5.6. These are historical measurements. They
are not current Core `1.1.0` or GPT-6 results.

## Findings and changes

- The active repository correctly rejects the older benchmark version. A
  separate archive read joins the published scores to exact run, configuration,
  scoring-version, provenance, and completion identities. The active repository
  still rejects these same historical run records.
- Dataset selection keeps current and historical results separate. The board
  selects the available historical data initially. Current Core remains empty.
- Ability order uses recorded values. The table shows three decimal places,
  conditional intervals, strict pass counts, coverage, and a source link. Equal
  recorded ability shares a competition rank: Sol max and ultra are both sixth.
- Model and effort filters retain ability rank across the complete dataset.
  Sorting strict pass changes row order without changing that ability rank.
  An unsupported filter combination has a clear empty state and reset action.
- Mobile keeps rank, model/version, ability/interval, strict pass, and source in
  the same view. Removing a duplicate sample count prevents the pass-rate text
  from colliding with the source button. Model and effort selectors use the
  compact All option because their labels already identify the filter.
- The Rank header initially failed light-theme contrast at 4.39:1. It now uses
  the main header color. Small interval and version text has a larger mobile size.
- Each historical source opens separately and retains filters and ordering.
  Its JSON response contains the normalized leaderboard row, public run record,
  observation time, original benchmark identity, and an explicit historical flag.
  It does not claim to be an immutable submitted package or a new verification.

## Verification and limits

IAB was used for actual desktop/mobile inspection, live model/effort filtering,
and light/dark review. Repository Playwright checked the real Supabase-backed
page at 1440 by 900 and 390 by 844. A 320 by 760 check covers narrower layout.
At 390 pixels, the table fits its 354-pixel region and four full data rows are
visible in the first viewport. The checks compare all 17 displayed abilities,
source identities, ordering, and tie ranks with the direct public API read.
They also cover combined filters, empty/reset, metric sorting, source popup
continuity, version switching, axe, and console/page errors. All checked live
states pass. Screenshots and `live-qa.json` are under
`CODEX_HOME/visualizations/2026/10/20/01a1587e-dfb9-7770-a228-c2b5549a3140/leaderboard-audit/core-live/`.

The production build, TypeScript lint, and 392 Web tests pass. Six existing
desktop/mobile study checks pass. The archive identity test also proves that
the active run-summary path continues to reject the historical version.
The current Core populated state is not claimed: this source has no `1.1.0`
publication. Historical data stays in Supabase; no snapshot is added to Git.
No database or Storage write, new model run, deployment, or secret-file write
is part of this local acceptance. Read credentials enter only the preview
process through Personal Infisical. Browser plugin is absent; repository
Playwright supplements the available IAB tools.

---

# Prior design QA: Leaderboard layout audit, 2026-10-20

This pass inspects the rendered AI Intelligence and Mem pages in IAB before
editing them. It keeps the existing peer-board design and fixes the density,
metric presentation, mobile comparison, and empty-state problems found in the
current screenshots. It does not select a new visual concept.

## Steps and findings

| Step                           | Before                                                                                                                                                                | Fix and result                                                                                                                                                                                                                                                                                                        |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Mem desktop                 | The table starts near 435 CSS pixels. A duplicate Results heading, stacked labels, introductory prose, and a second study register compete with the comparison.       | Inline selectors and compact sample/date metadata put the table at 306 pixels in a 1280 by 720 IAB viewport. The study register stays in Versions. Protocol details remain available below the result.                                                                                                                |
| 2. Mem mobile                  | The table starts near 615 pixels. The first view exposes one quality metric; cost and time require horizontal navigation.                                             | The table starts at 440 pixels. Key metrics show quality, measured time, total cost, and a source link together. Native and reader tables fit the 354-pixel content region at a 390-pixel viewport. All metrics restores the complete diagnostic table and horizontal scrolling.                                      |
| 3. Metric comparison           | Long currency values and missing units slow scanning. Native timing has a sort action although no comparable values exist. Source navigation replaces the comparison. | Headers state answers, matched/emitted quotes, seconds, and total USD. Costs show six decimals; tooltips and original files retain recorded precision. Sorting uses recorded numbers. Missing or single-profile columns do not offer a sort action. Sources open in a separate tab and retain the current comparison. |
| 4. AI Intelligence             | The empty table uses a large centered panel and repeats interpretation in multiple blocks.                                                                            | A compact left-aligned state retains the benchmark, scoring version, design counts, and configuration comparison link. Numeric headers align with their values. Scoring and interpretation use one disclosure. Unavailable measurements remain distinct from zero published measurements.                             |
| 5. Light and dark presentation | New small unit labels initially fail the light-header contrast check at 4.39:1. In dark mode, units have stronger emphasis than metric names.                         | Metric names use the main text color. Unit labels use a legible secondary mix. Both board results pass the checked axe states in light and dark themes.                                                                                                                                                               |

Workload selectors name the comparison method: native retrieval with a shared
reader, a separate nightly version check, fixed-context reader replay, or
extraction prompt replay. Reader and writer inputs, denominators, and cost
scopes do not merge. No new overall score, statistical winner, or ranking data
is introduced. The original source files and recorded metrics do not change.

## Verification

The flow is: peer-board directory -> Mem -> select a study and workload -> sort
cost -> open a source in a new tab -> return to the same comparison -> inspect
a failed case and original file. Additional checks exercise mobile key/all
metrics, optional charts, keyboard board tabs, exact versions, all 47 case
links, Core navigation, preview and unavailable states, and unknown-route 404.

- Six desktop/mobile Chromium checks pass. They include light/dark axe checks,
  mobile table-width and first-viewport row checks, cost rounding with recorded
  precision, real numeric ordering, source-tab continuity, and exact downloads.
- One separate production missing-configuration check passes.
- Production build, TypeScript, lint, and the existing 389 Web tests pass.
- The evidence check verifies three studies, 47 case pages, and 228 indexed
  original hashes. They still map to 224 distinct files.
- IAB provides the current manual desktop/mobile and dark-theme review.
  Repository Playwright provides the repeatable checks. No application errors
  occur in those browser flows. The standalone Browser plugin is absent.

IAB uses its default 1280 by 720 desktop viewport and a temporary 390 by 844
mobile override. The override is reset before handoff. Repeatable captures use
1469 by 1071 and 390 by 844. Screenshots and detailed notes are under
`CODEX_HOME/visualizations/2026/10/20/01a1587e-dfb9-7770-a228-c2b5549a3140/leaderboard-audit/`.
The numbered `01` to `05` captures show the initial states. The final `07` to
`12` captures show desktop/mobile results and writer key/all metrics. IAB
captures preserve the manual review states. Older non-final captures stay as
comparison records, not acceptance evidence for later source changes.

## Limits

This is local UI acceptance. The preview and unavailable Core states are
exercised; a real Official dataset is not loaded. Populated Official row data,
additional browser engines, production deployment, and new model experiments
are outside this pass. Automated axe checks do not establish full accessibility
compliance. The research pages stay independent of Core publication. No paid
model call, private archive read, database write, or Storage upload is part of
this change.

---

# Prior design QA: Study reading path, 2026-10-20

## Scope and design sources

The first implementation provided research discovery, study comparison, case,
and original-evidence pages. The board revision above replaces its top-level
hierarchy. This record and the earlier Core control audit remain as historical
evidence.

The selected Image Gen concepts are preview references under `CODEX_HOME`:

- `generated_images/01a1587e-dfb9-7770-a228-c2b5549a3140/exec-b20992fd-fb18-4910-b062-0586c540157e.png`: homepage, 1505 by 1045 pixels.
- `generated_images/01a1587e-dfb9-7770-a228-c2b5549a3140/exec-3795fc37-0aac-4707-a71a-d2f2e71891b8.png`: study page, 1036 by 1518 pixels.

The brief required a white editorial library, open rows, clear typography,
blue links, separate quality/time/cost, case access, and exact originals.
Concept images are references only. The interface uses native HTML controls,
Next.js server pages, the existing fonts and Phosphor icons, and ECharts SVG.
No raster screenshot replaces an interface.

## Visual and interaction verification

The in-app browser was used to inspect the homepage in dark and light modes
and to navigate to a study. Repository Playwright checks captured the final
page states. The concept and implementation images were inspected with
`view_image` in the same review pass. Playwright supplements the manual IAB
review; it is not a fallback for an unavailable browser.

The homepage was captured at its concept viewport of 1505 by 1045 CSS pixels.
The study used 1036 by 1518 CSS pixels. Full-page capture extends below those
viewports because the real conditions and evidence require more space than
the concept text. Mobile checks use 390 by 844 CSS pixels. The live IAB viewport
was also inspected at 1265 by 714 pixels.

| Comparison point                    | Implementation and result                                                                                                                                                                                       |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Main copy and navigation            | The main headline, supporting reading path, study titles, Studies / How to read / AIQ Core labels, and Open study action match the concept.                                                                     |
| Layout                              | Open study rows, fine dividers, a single reading hierarchy, and two condition/limit columns preserve the concept. Mobile stacks the columns and keeps the navigation visible.                                   |
| Typography                          | Existing Manrope and IBM Plex Mono remain the owners. Headings, prose, controls, numeric values, and metadata have separate sizes. Core's inherited uppercase table headings were removed from research tables. |
| Palette                             | Light pages use true white, near-black type, muted gray, and blue `#2558cb`. Existing system/light/dark preferences remain available. No gradient or decorative overlay was added.                              |
| Icons and assets                    | The existing Phosphor arrow and theme controls remain native icons. The typographic AIQ mark remains code. No generated placeholder art or simulated data is present.                                           |
| Comparison behavior                 | Reader and writer buttons switch real result groups. Native October 15 data and the nightly version check use separate groups. Null time/cost stays unavailable.                                                |
| Case depth                          | The first three notable cases are visible. Remaining cases, exact contexts, citations, and supporting files use disclosure controls. A missing paired control is explicit and has no invented model output.     |
| Evidence access                     | The path from a failed citation to its original JSON download was exercised. Download bytes match the content-addressed SHA-256 filename.                                                                       |
| Accessibility and responsive layout | Desktop and mobile case paths pass axe. The evidence links now have underlines. The checked mobile path has no page-level horizontal overflow; wide result tables scroll within a named region.                 |

The above-the-fold copy comparison retains the approved main wording. The
following deviations are deliberate and come from the recorded study evidence:

- Use “recorded conditions” instead of “same conditions.” Compared effort and
  model profiles do not always use equal reasoning compute or output allowances.
- Keep exact sample counts, the three paired writer inputs, calibration scope,
  and all individual quote denominators. The concept simplified those fields.
- Replace exploratory or unsupported concept prose with the retained review.
  Keep the original report and the later interpretation separate.
- Include full conditions, limits, and SHA-256 values. Put supporting files in
  a disclosure. This makes study pages longer than the concept image.
- Retain the existing three-choice theme control. The concept showed one icon.
- Round only the large writer-cost summary to six decimals for small screens,
  label it as rounded, and retain nine decimals in the source table and files.

The final interface was faithfully checked against the selected design and
these listed evidence-driven deviations. No unresolved material rendering or
interaction mismatch was found in the checked reading path.

## Validation boundary

- Base: AIQ main `e12a22c794d4610c6131199743fe2bc0c43ed7be` plus this task's local change.
- Three studies, 47 case pages, and 228 selected original-file hashes pass
  `cargo make check-studies`. Reader totals reconcile with retained case reviews.
- The production Web build, TypeScript check, and TypeScript lint pass.
  The TypeScript suites pass 182 repository tests and 389 Web tests. Three
  disposable-database integration checks are skipped because their opt-in
  environment is absent. Desktop/mobile study browser checks pass four cases.
- A focused Core navigation check verifies the moved `/core` entry point.
- Unknown studies return HTTP 404 through the normal `notFound()` path.
- No new model benchmark ran. No database was initialized or reset, no evidence
  was uploaded to Storage, and no production deployment was performed.
- Rust execution, accounting, checkpoint, signed-package, and evaluator replay
  code is unchanged. A Rust runtime or benchmark acceptance claim is out of scope.

---

# Design QA: Analytical Control Alignment

## Evidence

- Source visual truth: `/var/folders/yj/gq3z3n7521v92h2j1s6668jr0000gn/T/codex-clipboard-f35d388a-f629-4bac-9eec-e1d998478b1e.png`
- Browser-rendered implementation: `/tmp/aiq-controls-after.png`
- Focused implementation crop: `/tmp/aiq-controls-after-focused.png`
- Combined focused comparison: `/tmp/aiq-controls-comparison.png`
- Local route: `http://127.0.0.1:3001/#results`
- State: dark theme, synthetic seed data, matrix controls visible. The source screenshot is the rejected efficiency-control state. The focused implementation uses the same control pattern with matrix data because the local seed does not render the published efficiency plot.
- Viewport: Chrome at 1440 x 1000 CSS px. The document client width was 1425 CSS px because of the visible scrollbar.
- Pixel dimensions: source 792 x 184; full implementation 1425 x 990; focused implementation 792 x 184; combined comparison 792 x 368.
- Density normalization: both focused images are 792 x 184 pixels at 1x. The implementation screenshot was cropped without rescaling.

## Findings

- No actionable P0, P1, or P2 differences remain in the control-alignment scope.
- P3, expected content difference: the source shows `Measure` and `Read configuration` with a live `Sol · low` value. The focused local capture shows `Family`, `View`, and `Read configuration` with synthetic `Sol · ultra` data. This does not affect the reusable layout contract. The live-published browser test renders the efficiency group and verifies the same geometry.

## Required Fidelity Surfaces

- Fonts and typography: existing font family, optical weights, color, and text sizes stay unchanged. Analytical labels now share a 14 px line box. Actions retain the existing 0.72 rem text style. No text wraps or truncates at the checked widths.
- Spacing and layout rhythm: each analytical control uses a 14 px label row, a 6 px gap, and a 38 px action row. Desktop label tops and action tops differ by no more than 0.5 px within each group. The comparison `vs` marker and the calibration submit button align with their select action rows.
- Colors and visual tokens: the existing dark and light theme tokens are unchanged. The fix adds no border, fill, shadow, radius, or accent treatment.
- Image quality and asset fidelity: the target contains no product image, logo, illustration, or non-standard icon. No image or icon substitute was added.
- Copy and content: all visible copy is unchanged. Span wrappers provide stable layout rows without changing accessible names.
- Responsiveness and accessibility: 390 px Chrome inspection found no horizontal overflow and kept a 6 px label-to-action gap. The full synthetic suite also covers 320 px, 390 px, desktop Chromium, Firefox, mobile Chromium, and tablet WebKit. Coarse pointers retain the 44 px action target override.
- States and interactions: matrix chart mode, configuration selection, and trend line/bar selection were exercised in Chrome. Compare and calibration controls were measured in desktop and mobile layouts. Browser logs contained only development information and hot-reload messages, with no warning or error entries.

## Full-view Comparison Evidence

The source artifact is a focused defect screenshot, so it does not define a full-page composition. The 1425 x 990 browser capture was reviewed for unintended layout drift. The flat visual system, section hierarchy, chart frame, ranking column, palette, and border treatment remain unchanged. Only analytical control alignment changed.

## Focused Comparison Evidence

The combined 792 x 368 image places the rejected source state above the corrected implementation crop. In the source, `Measure` begins lower than `Read configuration`, and its action row also begins lower. In the implementation, all labels share one top line and all actions share one top line. The select underline starts on the same action row as the text buttons.

## Comparison History

1. Initial finding, P1: sibling controls used different action heights and parent bottom alignment. The labels and actions did not share baselines, which made the filter group look broken.
    - Fix: introduced one shared label/action row contract, changed analytical groups to top alignment, normalized text buttons and selects, and added explicit label wrappers where needed.
2. Post-fix review: `/tmp/aiq-controls-comparison.png` shows the aligned rows. Desktop geometry checks passed for matrix, trend, compare, calibration, and the live-published efficiency fixture. Mobile checks found no overflow or collapsed control text. No further P0, P1, or P2 finding remains.

## Implementation Checklist

- [x] Apply the shared row contract to matrix and efficiency controls.
- [x] Apply the same contract to trends, comparison, and calibration controls.
- [x] Preserve flat styling and existing theme colors.
- [x] Add a published-data geometry regression test.
- [x] Verify desktop, mobile, interactions, accessibility suites, and production build.

## Follow-up Polish

No separate polish item is required for this scoped fix.

final result: passed
