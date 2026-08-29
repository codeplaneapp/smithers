---
name: migrate-smithers-v1
description: Upgrade a Smithers 0.x (JSX) project to Smithers 1.0 flows with an auditable report.
---

# Migrate a Smithers 0.x project

Rule 0: if `SMITHERS_INSIDE_RUN` is set you are already a worker inside a run. Do the node's work with your ordinary tools and never launch a migration from inside one.

## When to use this

A project qualifies when any of these is true:

- a manifest depends on `smthrs`, `smithers-orchestrator`, or an `@smthrs/*` package below `1.0.0-rc.0`;
- a file has `@jsxImportSource smthrs` or a `tsconfig.json` sets `jsxImportSource` to either name;
- there is a `.smithers/workflows/*.tsx` pack, or a `*.jsx` workflow calling `createSmithers`.

The tool rewrites application source to `Flow`, `Action`, and Effect, archives the old sources, and writes a report. It is not a compatibility library: it never recreates the JSX runtime, never puts a scheduler in application code, never hides an untranslatable construct behind `any`, and never rewrites or resumes 0.x run state.

## Before you run it

- Node 22.19 or newer.
- A jj or git checkout. Uncommitted work is preserved: the checkpoint writes a ref or opens a change and never touches the working tree. Commit anyway, because a diff you can read is worth more than one you have to reconstruct.
- Model credentials for the seat you name: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `OPENROUTER_API_KEY`.

## The three commands

```sh
npx @smthrs/migrate                       # plan: read the project, write the report, change nothing
# read .smithers-migrate/report.md
npx @smthrs/migrate --apply --seat anthropic:<model>
```

Inside a migrated project the same flow is `smithers migrate`, and `smithers plan migrate` / `approve` / `run` runs it durably.

`--apply` refuses twice, and each refusal exits 3 with the project untouched:

- **Run state.** The project still holds a 0.x database, an execution directory, or a Postgres or PGlite setting. Finish the runs, archive the database, or discard it, then pass `--acknowledge-run-state`. The report lists live runs first, parked runs second, and the archive step last. The tool never migrates that data; a 1.0 runtime cannot read it.
- **Unsupported constructs.** Something in the project has no safe translation: a workflow UI, a worktree, `continueAsNew`, a direct store read, a Postgres backend, an integration. Decide what happens to each, then pass `--allow-unsafe <name,...>`, or `--allow-unsafe all` to accept a `TODO(migrate-smithers-v1)` marker and a report entry for every one of them.

Other flags: `--scan` (read only, writes no report), `--unit <id,...>` to rerun part of a plan, `--keep-old-sources`, `--allow-no-vcs`, `--max-repair-rounds`, `--report-dir`, `--flows-dir`, `--json`.

When the report names a verification command the project does not really run, correct it rather than working around it: `--verify-install`, `--verify-format`, `--verify-typecheck` (repeatable), `--verify-test`. Every unit is verified with these lines and the agent's shell is allowed exactly them, so a wrong one blocks the migration. `--verify-typecheck ""` runs no typecheck at all.

## What it does to the project

One unit at a time, in this order: dependencies, then one unit per workflow file in dependency order, then one per integration, then the project itself. Each unit takes a checkpoint, rewrites, and verifies with the project's own install, format, typecheck, test, and flow-discovery commands. A unit that fails is handed back to the agent with the failing output up to `--max-repair-rounds` times, and then restored from its checkpoint and recorded as failed. The run continues.

Migrated flows land in `flows/<name>/flow.ts`. The sources the migration replaced move to `.smithers-migrate/archive/<original path>`. The files a 1.0 project keeps (`package.json`, `tsconfig*.json`, `.gitignore`) are rewritten where they are and never moved.

A unit may write only the files it declared. The tool digests the whole tree before the unit starts and compares afterwards, so a write outside that set fails the unit and is named in the report whether or not the agent mentioned it.

## Reading the report

`.smithers-migrate/report.md` and `report.json`. Commit `report.md`: it is the record of what changed, what could not be translated, and what a person still has to decide.

- **Summary**: mode, exit code, counts. Exit 0 finished, 1 a unit failed and was restored, 3 a gate refused.
- **Run state**: the operator instructions, in the order to do them.
- **Units**: per unit, the checkpoint and the command that restores it, the files changed, the decisions the agent made and why, what it could not settle, what has no counterpart, and the verification.
- **Manual follow-ups**: a checkbox list. `must` items are blocking.

## The follow-up loop

1. Fix each `unresolved` entry. Every agent pool is one: a `fallbackAgents` chain or a subscription CLI agent is an operator decision, and the tool preserves it as a pool rather than picking a seat for you.
2. Decide each `unsupported` entry. Every one has a `TODO(migrate-smithers-v1)` marker in the source and the closest 1.0 composition in the report.
3. Rerun a single unit with `--unit <id>` after you change something it depends on.
4. Restore a unit by hand with the command in its report section, if you would rather redo it.

## What it will not do

It will not touch `smithers.db`, `.smithers/smithers.db`, `.smithers/executions/`, or anything the report lists under run state. Three separate things hold that line, and it is worth knowing which is which:

- The kernel refuses every write the agent makes under a run-state path, so a prompt cannot talk it into one.
- The kernel refuses every shell command that is not one of this unit's own verification commands, so it cannot reach a database through `sqlite3` or `rm` either.
- The unit records a digest of every run-state file before it starts and checks it after. If the bytes moved anyway, which a project's own test command could do, the unit fails its checks and is restored from its checkpoint.

It will not install a package outside the approved list. It will not edit a file outside the unit it is working on. It will not delete uncommitted work.
