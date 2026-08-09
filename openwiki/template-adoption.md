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

The source-head public constants include AIQ Core `1.0.7`, task scorer `1.0.6`,
and aggregate scoring version `1.0.8`,
72 tasks, 17 model configurations, three production identities, ordered
task-metadata digest
`sha256:84f1d1a271e112c70f59bf7a2637f3b905b1a85d1ebee34172c63b922c9733d1`,
release-policy identity `aiq-core/1.0.7`, and public release digest
`sha256:2e9f2efec15a66a67ce0cf236aaf3d0f5403e03e7de6063ffaf3c28f0eb07aae`.
The public catalog is deterministic and identity-frozen. Fresh Core and
Contrast A/B seals, policy-v2 replay of the retained complete calibration,
fixed-bank admission v3, final native build verification, a separate real
Official run, publication, and deployment remain pending. All formal tasks have
null wall-time, step, and tool-call limits; measured usage is auxiliary only.
The sole production tuple
is AIQ Core `1.0.7`, task scorer `1.0.6`, aggregate scorer `1.0.8`, and
measurement `2.0.0`; no legacy fallback is supported.
