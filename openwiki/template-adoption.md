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

The source-head public constants include AIQ Core `1.0.6` and scoring version `1.0.7`,
72 tasks, 17 model configurations, three production identities, ordered
task-metadata digest
`sha256:add2a0514b6cdab99b3329d7065565f5606d13af93338e4bc37a0fbd30019b91`,
release-policy identity `aiq-core/1.0.6`, and public release digest
`sha256:5b33cd2daa5efe15e49de34b7137d35bc2ff980a7f619063e7e8b819a857508f`.
The public catalog is deterministic and identity-frozen. Independent
no-deadline Core and Contrast A/B seals produced the current database task and
fixture commitments. One final clean-source seal remains before the focused
canary. Final controlled corpus identities remain calibration candidates. The first
`1.0.4` 1,224-cell calibration is preserved as non-Official failed statistical
evidence, not as an all-execution failure. The `1.0.6` sequence requires a
focused no-deadline canary before the full 17-by-72 calibration. Final
native build verification, a real Official run, publication, and final
deployment remain pending. The sole production tuple is AIQ Core `1.0.6`,
scoring `1.0.7`, and measurement `2.0.0`; no legacy fallback is supported.
