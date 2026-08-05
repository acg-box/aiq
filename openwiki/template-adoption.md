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

The source-head public constants include AIQ Core and scoring version `1.0.5`,
72 tasks, 17 model configurations, three production identities, ordered
task-metadata digest
`sha256:050ab6937b4e84aad0fc72a3d4489bd2d8dfe70d2bc35d196bd47b5a2cc80d4a`,
release-policy identity `aiq-core/1.0.5`, and public release digest
`sha256:6991fb8e25d18d3ac89e946483c87c9cb24af7f59acdef2bed21f8b8090c4037`.
The controlled Core, Contrast, scorer-manifest, evaluator, runtime task-set,
generated-task tree, and database commitment identities are pending. The first
`1.0.4` 1,224-cell calibration is preserved as non-Official failed statistical
evidence, not as an all-execution failure. The `1.0.5` sequence requires a
17-by-4 targeted pilot before the full 17-by-72 non-Official calibration. Final
native build verification, a real Official run, publication, and final
deployment remain pending. Live production retains the historical AIQ Core
`1.0.2` matrix.
