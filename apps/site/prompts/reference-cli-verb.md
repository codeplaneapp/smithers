# Write a CLI verb reference page

You write one reference page for one `smithers` verb. Follow
`apps/site/prompts/reference-style.md` for voice, entry format, code, links,
and the truthfulness rule. This prompt fixes the inputs, the output, and the
section skeleton.

The verb is the file name in your write-set: `docs/reference/cli/<verb>.md`
documents `smithers <verb>`.

## Inputs

- `packages/smithers/src/Verb.ts`: the shipped verb table. The `help` string
  there is the one-line description; `aliases` are the alternate spellings;
  `flowId` names the reserved system flow when the verb has one.
- `packages/smithers/src/Command.ts` and the module the verb's handler lives
  in (`Init.ts`, `Doctor.ts`, `Gc.ts`, `Serve.ts`, `Bug.ts`, `Update.ts`,
  `McpServer.ts`, `Detached.ts`, and so on): the argument and flag
  registrations, defaults, exit codes, and the documents the verb prints.
- `packages/smithers/src/Unsupported.ts`: the removed 0.x flags and verbs
  that exit 1 with a migration link.
- `packages/smithers/src/CliError.ts` and `Output.ts`: exit codes and output
  envelopes.
- `packages/smithers/README.md` and `docs/*.md`: vocabulary.
- `apps/site/src/data/help/<verb>.txt` when present: the captured `--help`
  output, a deterministic input for the flag list and the usage line.
- `apps/site/prompts/reference-style.md`.

## Output

One file at the write-set path. Frontmatter:

```md
---
title: "smithers <verb>"
description: "<the help string from Verb.ts, verbatim>"
area: cli
order: <the verb's index in Verb.ts shipped, times 10>
---
```

## Skeleton

Sections in this order, no others:

1. `## Synopsis`: one `text` fence with the usage line in the four notations
   (`[optional]`, `{a|b}`, `...`, `UPPER_SNAKE`). Positional arguments and
   the verb's own flags only; global flags go in their own section.
2. `## Description`: one to three paragraphs stating what the verb does,
   what it never does, and what it prints. Aliases in the first paragraph
   when `Verb.ts` lists any.
3. `## Arguments`: a table with `Name`, `Type`, `Required`, and
   `Description` columns, one row per positional argument. Omit the section
   when the verb takes none.
4. `## Flags`: a table with `Flag`, `Type`, `Default`, and `Description`
   columns, one row per flag the parser registers for this verb, in
   registration order. Enumerated values as `` `once` \| `run` ``. A removed
   0.x flag is not a flag; it belongs in Exit codes under the exit-1 row.
5. `## Global flags`: one sentence naming `--root`, `--remote`,
   `--credential`, `--json`, `--quiet`, `--mcp-config`, and `--log-level`
   with a link to `/docs/reference/cli/`, only when the verb accepts them.
6. `## Output`: what the verb prints on success, structurally, and verbatim
   only where a source file pins the text. Human rendering and `--json`
   document are separate paragraphs when both exist.
7. `## Exit codes`: a table with `Code` and `When` columns. Include only the
   codes this verb can produce, from the handler and `CliError.ts`. The
   brief's contract is 0 success, 1 failure, 2 usage, 3 parked at
   waiting-approval, 130 SIGINT, 143 SIGTERM.
8. `## Example`: one `bash` fence with the command, then one `text` fence
   with structurally described or source-pinned output. Introduce each with
   a sentence.
9. `## See also`: the sibling verbs this one pairs with, as
   `/docs/reference/cli/<verb>/` links with one clause each, and the guide
   in the route map that shows the procedure.
10. `## Sources`: the workspace-relative paths you read.

## Verification before you finish

- Every flag row has a registration in the parser you read. Grep the flag
  name. A flag in `--help` output but absent from the parser is a defect to
  report, not a row to write.
- Every default is the value in the registration.
- Every exit code is produced by a code path you read.
- Every `system/` flow id, environment variable, and file path is spelled
  as the source spells it.
- The description sentence in the frontmatter is the `help` string from
  `Verb.ts`, unchanged.
- No H1, no em dash, sentence-case headings, every fence tagged, every link
  absolute with a trailing slash.
