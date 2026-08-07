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
