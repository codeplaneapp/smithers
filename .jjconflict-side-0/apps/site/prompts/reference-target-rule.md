# Write a target rule reference page

You write one reference page for one rule of the `@smthrs/targets` catalog:
one `Target.make` declaration, reached from a `PACKAGE.ts` as
`Smithers.<Namespace>.<Rule>` or `Smithers.<Rule>`. Follow
`apps/site/prompts/reference-style.md` for voice, entry format, code, links,
and the truthfulness rule. This prompt fixes the inputs, the output, and the
section skeleton.

The rule is the file name in your write-set: `docs/reference/<slug>.md`
documents the rule whose kebab-case name is `<slug>` (`filegroup` is
`Filegroup`, `agent-diff` is `Agent.Diff`).

## Inputs

- `packages/smithers/build/targets/src/<Module>.ts`: the `Target.make` call
  (its `attrs` schema, `kinds`, `cache`, `outputs`, `success`, `error`, and
  `implementation`), the attrs schema's JSDoc, and any `Target.guard` that
  refuses attr combinations.
- `packages/smithers/build/targets/docs/rules.md`: the row for this rule
  (module, verbs, cacheable, declares outputs, route).
- `packages/smithers/build/targets/README.md` and `docs/*.md`: vocabulary.
- The seed page from `packages/smithers/build/docs/reference/targets/`,
  when one was given: reuse its example and its section content where the
  source still agrees; correct it where it does not.
- `apps/site/prompts/reference-style.md`.

## Output

One file at the write-set path. Frontmatter:

```md
---
title: "<Namespace.Rule>"
description: "<One sentence: what the rule declares and which verbs run it.>"
area: targets
order: <alphabetical position is fine; use 100>
---
```

## Skeleton

Sections in this order, no others:

1. Opening: one sentence stating what the rule declares, then one `ts` fence
   showing a minimal declaration in a `PACKAGE.ts` (`import { Smithers }
   from "@smthrs/targets"` and one call with the required attrs). The fence
   compiles.
2. `## Attributes`: a table with `Name`, `Type`, `Default`, and
   `Description` columns, one row per field of the attrs schema, in schema
   order. `Type` is the schema's type as the definition spells it, in code
   font. `Default` is `required` when the field has no default and is not
   optional. A `Target.guard` constraint (exactly one of, requires) is a
   sentence after the table.
3. `## Behavior`: what the implementation plans, in one to three
   paragraphs: the process it spawns or the action it calls, what is key
   material, what the write-set or outputs are, and what a verb does with it
   (`lint` maps to check, `--write` applies, and so on) when the rule has a
   mode.
4. `## Channels`: a table with `Channel` and `Type` columns for `Success`
   and `Error`, naming the schemas the declaration passes.
5. `## Status`: a table with `Property` and `Value` columns for `Kinds`,
   `Cacheable`, `Declares outputs`, and `Route`, copied from the rules.md
   row, plus `Executes` when the seed page states it.
6. `## Example`: one `ts` fence, 10 to 30 lines, a realistic declaration
   that composes with a sibling target, followed by the `smithers-build`
   command that runs it in a `bash` fence. Introduce each with a sentence.
7. `## See also`: sibling rule pages as `/docs/reference/targets/<slug>/`
   links and the `@smthrs/targets` package page at
   `/docs/reference/api/targets/`.
8. `## Sources`: the workspace-relative paths you read.

## Verification before you finish

- Every attribute row matches a field in the attrs `Schema.Struct`. Grep
  the field name in the module. Count: rows written equals fields declared.
- `Kinds`, `Cacheable`, `Declares outputs`, and `Route` match the rules.md
  row and the `Target.make` call.
- Every `ts` fence compiles under strict `tsc` against `@smthrs/targets`.
- The `smithers-build` command names a verb the rule's `kinds` include, or
  `target <label> --write` for a check-by-default rule.
- No H1, no em dash, sentence-case headings, every fence tagged, every link
  absolute with a trailing slash.
