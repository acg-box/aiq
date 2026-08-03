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

The source-head project constants include AIQ Core and scoring version `1.0.2`,
72 tasks, 17 model configurations, three production identities, ordered
task-metadata digest
`sha256:2c5efe162b49e710e6e52b0f3a4e33d1127d0dd54d4f15694f88911bcb7fc937`,
release-policy identity `aiq-core/1.0.2`, and catalog release-identity digest
`sha256:45bf2e9d5287fd4f83e46bc3cb5c3ccb8778756465e81bfd567d111480eefc4b`.
The production foundation remains on the historical `1.0.1` predecessor until
the unpromoted candidate completes its authorized cutover.
