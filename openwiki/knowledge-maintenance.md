---
type: 'Maintenance'
title: 'Knowledge Maintenance'
description: 'Authority and update rules for AIQ repository knowledge.'
tags: ['knowledge', 'maintenance', 'openwiki']
---

# Knowledge Maintenance

OpenWiki is the repository navigation and knowledge surface. It summarizes
checked-in source, tests, schemas, and runbooks. It does not override them.

## Authority order

Use this order when claims differ:

1. user instruction and checked-in `AGENTS.md`;
2. executable source, schema, tests, and task definitions;
3. component README files;
4. OpenWiki pages.

For database work, `databases/schema.sql` is the sole desired state and
`databases/init.ts` is the fresh initialization command. Runtime inspection is
evidence about one environment, not editing authority.

## Update procedure

1. Identify the source that owns the changed behavior.
2. Change and validate that source first.
3. Classify knowledge impact as `none`, `update_required`, or
   `research_required`.
4. When an OpenWiki update is required, use the repository generator by default
   and review its diff against source.
5. Direct page edits are allowed for explicit correction or curation that the
   generator cannot express.
6. Do not authorize recurring OpenWiki automation through a documentation edit.

The greenfield correction used the repository generator. Its output was reviewed
against source authority. Incorrect recurring-automation claims were rejected,
and bounded corrections were curated directly.

## Drift checks

Before completion, search the maintained pages for:

- removed components and commands;
- old schema or package versions;
- wrong task, model, or identity counts;
- stale catalog digests;
- links to missing files or headings;
- commands that are absent from the task runner or CLI;
- claims that deployment has occurred.

Keep deployment status explicit. Synthetic fixtures are not production facts.
Do not copy secrets, private task content, or environment-specific data into
OpenWiki.
