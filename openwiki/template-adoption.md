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
`sha256:46ab8d9d6aac8077e917ecb3718392d913c95fcc4a24c2cbc6435203512851c7`,
release-policy identity `aiq-core/1.0.5`, and public release digest
`sha256:496b40f54dc7c3dc92d8880201373344c723001a0570a4debd28e539cfe4030d`.
The controlled Core, Contrast, scorer-manifest, evaluator, runtime task-set,
generated-task tree, and database commitment identities are pending. The first
`1.0.4` 1,224-cell calibration is preserved as non-Official failed statistical
evidence, not as an all-execution failure. The `1.0.5` sequence requires a
17-by-4 targeted pilot before the full 17-by-72 non-Official calibration. Final
native build verification, a real Official run, publication, and final
deployment remain pending. Live production retains the historical AIQ Core
`1.0.2` matrix.
