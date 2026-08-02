---
type: 'Guide'
title: 'Template Adoption'
description: 'Repository-specific ownership after template adoption.'
tags: ['template', 'maintenance']
---

# Template Adoption

AIQ Wiki is an adopted repository, not an unconfigured template. Current source,
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

The current project constants include 72 tasks, 17 model configurations, three
production identities, and catalog digest
`sha256:b518145026b498050e8810b4544674dea13a2d1b8f63d02b0b0e78025ea25ce3`.
