<!-- OPENWIKI:START -->

## OpenWiki

This repository has a generated `openwiki/` evidence index. It is optional just-in-time context, not required startup reading.

- Treat source code and tests as authoritative. A brief's unknowns and review items are verification gaps, not automatic requirements.
- Prefer the narrowest quiet validation that proves the changed behavior. Preserve complete failure output.

The scheduled OpenWiki GitHub Actions workflow refreshes the repository wiki. Do not hand-edit generated OpenWiki pages unless explicitly asked; prefer updating source code/docs and letting OpenWiki regenerate.

<!-- OPENWIKI:END -->

## Study and benchmark ownership

- Keep capability boards at the same level. `apps/web/src/benchmarks/boards.ts`
  owns board membership. AIQ Core belongs to AI Intelligence; memory system,
  reader, and writer studies belong to Mem. A test type is not a new board.
- Sort peer boards, harnesses, models, studies, views, and file lists by their
  displayed English names in alphabetical order. Keep score rankings, dates,
  and semantic levels in their defined order.
- Harness Rank owns model–harness comparisons. Its V1 scope is Codex, Hermes, and
  Pi. `benchmarks/harness-rank/protocol.json` owns the draft design. Keep
  documentation review, runtime compatibility, and measured results distinct.
- Make each board homepage a data comparison workspace. Use compact scope,
  subject, and sample metadata; show the test table before interpretation.
  Keep versions, cases, and originals in separate views. Avoid promotional
  headlines and conclusion cards. Keep design counts separate from measurements.
- Read `benchmarks/studies/README.md` for study imports and display records.
  Keep metrics and interpretation under the benchmark that owns them.
- The fixed Core matrix, Rasch, Calibration, and Official gates apply to Core.
  Do not require them for independent study display or relabel research evidence.
- Preserve original reports and outputs. Record a later interpretation separately.
  Do not read or publish the private ELF archive as a public dataset.
- ELF is retired. Do not add or use integration, import, or execution paths for it.
  Omit ELF configurations, measurements, and observations from the public workspace.
  Remove its adapters and dedicated evidence files. Preserve the exact bytes and
  source provenance of retained OpenViking, RAGFlow, and model replay evidence.
- Keep new study pages independent of the Core repository and production gate.
  Use `cargo make check-studies` and the narrow browser task for this path.
