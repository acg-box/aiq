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

The source-head public constants include AIQ Core and scoring version `1.0.4`,
72 tasks, 17 model configurations, three production identities, ordered
task-metadata digest
`sha256:2b009bfe1c590898b143c13b264b738f950cbda5c42dae104aaf9dd63426a59e`,
release-policy identity `aiq-core/1.0.4`, and public release digest
`sha256:f529aa9c7431f17e7b51ad8cc3524eea063edb154853b8ee49702cb0e9462279`.
The controlled Core, Contrast, scorer-manifest, evaluator, runtime task-set,
generated-task tree, and database commitment identities are pending. Full
calibration, final native build verification, a real Official run, publication,
and final deployment remain pending. Live production retains the historical
AIQ Core `1.0.2` matrix.
