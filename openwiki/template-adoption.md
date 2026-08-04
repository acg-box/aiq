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

The source-head project constants include AIQ Core and scoring version `1.0.3`,
72 tasks, 17 model configurations, three production identities, ordered
task-metadata digest
`sha256:0e315fe2bbcf0efe59ddcd69173addf89ef0fb281ec3ef523234bdc01b3d66a1`,
release-policy identity `aiq-core/1.0.3`, and catalog release-identity digest
`sha256:0dd4f11c49a1e295a75e6ca1e3b7b4f9c38e0160b9eda75ca75a47703e47f80d`.
The scorer-manifest identity is
`sha256:c898902ef5a604ce2db735819c98d7ebb127733b069bb69bd9a32e26cca8ba4d`,
and the evaluator identity is
`sha256:d4ffd4bc57a1e6d6cbea5f8c5bb830cd2448145668263b6fde6a41794084d60c`.
Model-free candidate validation passes. The final clean source commit,
create-new source-only corpus regeneration, final native build verification,
its private audit receipt, real execution, and publication remain pending. Live
production retains the historical AIQ Core `1.0.2` matrix.
