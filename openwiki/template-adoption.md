---
type: 'Guide'
title: 'Template Adoption'
description: 'Repository-specific ownership after template adoption.'
tags: ['template', 'maintenance']
---

# Template Adoption

AIQ is an adopted repository, not an unconfigured template. Current source,
schemas, tests, and OpenWiki pages own its behavior.

## Maintained surfaces

- Root manifests own the Rust and JavaScript workspaces and task names.
- `apps/` owns executable product behavior.
- `benchmarks/` owns public benchmark contracts.
- `databases/schema.sql` owns desired database state.
- `databases/init.ts` owns fresh database initialization.
- `.github/` owns checked-in CI behavior.
- `openwiki/` owns repository navigation and maintained explanations.

## Marker checks

List remaining template markers with the checked-in task:

```sh
cargo make list-template-markers
```

Review each result against source authority. Do not replace real product values
with generic examples. Do not add deployment resources, secrets, schedules, or
automation only to remove a marker.

The source-head public constants include AIQ Core and scoring version `1.0.6`,
72 tasks, 17 model configurations, three production identities, ordered
task-metadata digest
`sha256:6dc43022b04333de889abc08de118d63652aeab6ee2c3b8610905a2faa91e460`,
release-policy identity `aiq-core/1.0.6`, and public release digest
`sha256:fb2a1e088def5e88434ef383e92e0201b406d556c261e294c9ae86ea9bf3ae78`.
The public catalog is deterministic and identity-frozen. Two controlled
generations produced one matching tree, and the reviewed 72-task database
commitment is bound in source. Final controlled corpus identities remain
calibration candidates. Contrast generation is pending. The first
`1.0.4` 1,224-cell calibration is preserved as non-Official failed statistical
evidence, not as an all-execution failure. The `1.0.6` sequence requires a
debugging-02-by-17 runtime-budget pilot before the full 17-by-5 non-Official pilot
and 17-by-72 calibration. Final
native build verification, a real Official run, publication, and final
deployment remain pending. The sole production tuple is AIQ Core `1.0.6`,
scoring `1.0.6`, and measurement `2.0.0`; no legacy fallback is supported.
