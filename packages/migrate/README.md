# @smthrs/migrate

Upgrades a Smithers 0.x (JSX) project to the Smithers 1.0 authoring model and writes an auditable migration report.

```sh
npx @smthrs/migrate
```

This package is not a compatibility library. It rewrites application source to `Flow`, `Action`, and Effect, archives the old sources, and records every decision. It never recreates the JSX runtime, never embeds a scheduler in application code, never hides an untranslatable construct behind `any`, and never rewrites or resumes 0.x run state.

## Modes

| Mode    | What it does                                                                                                               |
| ------- | -------------------------------------------------------------------------------------------------------------------------- |
| `scan`  | Reads the project and writes nothing.                                                                                      |
| `plan`  | Scans, plans the migration units, and writes only the report. The default.                                                 |
| `apply` | Checkpoints, transforms one unit at a time, verifies, archives the old sources, and writes the report. Requires `--apply`. |

Two gates gate `apply` and both exit 3. Persisted or live 0.x run state blocks until `--acknowledge-run-state`. Unsafe constructs block until `--allow-unsafe <construct,...>`.

## Install cost

`scan` and `plan` need `effect`, `@effect/platform-node`, and `typescript`, and nothing else. Every scanner module imports only those and Node built-ins.

`apply` runs the migration flow and its registry discovery check, so it also needs the flow-lane packages. They are `optionalDependencies`: a package manager installs them by default and `--no-optional` leaves them out, which is the install a scan-only user wants. `Checks.discovery` imports `@smthrs/registry` at call time, so importing `@smthrs/migrate` never loads the runtime.

## Scanner modules

The root entry point exports these namespaces; each is also importable from `@smthrs/migrate/<Module>`.

The exports themselves are not listed here. The reference page's [Exports](https://smithers.sh/migration/migrate-tool#exports) table is generated from the JSDoc of every public module, so it names every export, its category, and where to import it from, and a list kept here as well would be a second one to keep right.

| Module           | Description                                                                                                                                              |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MigrateError`   | The single failure type, with the code the CLI maps onto an exit status.                                                                                 |
| `Constructs`     | The catalog of every 0.x construct application code can import, with its old source path.                                                                |
| `Mapping`        | The old-to-new mapping table, prop-driven class escalation, and the rewrite text for automatic rows.                                                     |
| `Detect`         | Packages, lockfiles, imports, pragmas, tsconfig chains, workflow and prompt files, components, UIs, tests, libraries, scripts, config, and integrations. |
| `RunState`       | Read-only detection of live and parked runs, SQLite databases, Postgres and PGlite settings, state directories, and the operator instructions.           |
| `Inventory`      | Per-file construct hits resolved through imports and `createSmithers` destructuring.                                                                     |
| `ZodSchemaHints` | Classifies zod chains and prints the `effect/Schema` equivalent for the safe subset.                                                                     |
| `PromptHints`    | Classifies MDX prompts and prints the template literal over `payload`.                                                                                   |
| `Units`          | Orders the migration into dependency, workflow, integration, and project units.                                                                          |
| `Checks`         | The deterministic post-transform checks, including registry discovery.                                                                                   |
| `Report`         | The report schema, its writers, and the deterministic Markdown renderer.                                                                                 |
| `Scan`           | The pipeline that composes every module above.                                                                                                           |

## Report

`apply` and `plan` write `.smithers-migrate/report.json` and `.smithers-migrate/report.md` (`--report-dir` moves them). The Markdown is deterministic for a given JSON, so two runs diff cleanly. Its sections, in order: summary, run state and operator instructions, project detection, construct inventory, mapping decisions, units, verification, manual follow-ups, and the commands that restore each checkpoint.

Commit `report.md`. It is the record of what the tool changed, what it could not translate, and what a person still has to decide.

Read the verification output before you commit it. Each command's last 12 KB of stdout and stderr is captured verbatim into `report.json` and rendered into `report.md`, and a failing install or test suite in a 0.x project prints whatever it prints: a registry token, a value read from `.env`, a CI credential. The tool does not redact it, because it cannot tell a secret from a stack frame.

## Fixtures

`test/fixtures` holds real 0.x projects copied byte for byte, each with a `FIXTURE.md` naming its origin and its commit: `jsx-single` (a single-file JSX example), `plue-pack` (a multi-workflow `.smithers` pack), `batch-issues` (a nested pack that depends on the facade by its bare `file:` name), `mixed-api` (one file that imports Smithers 0.x and a foreign authoring API together), and `persisted-db` (a project whose database must trigger the operator instruction). `jsx-single.migrated` is the hand-written 1.0 output the deterministic checks run against.

`test/PlueGolden.test.ts` runs the scanners read only over the pack named by `SMITHERS_MIGRATE_PLUE_PACK`, an unsanitized external pack, and skips with a reason when that directory is not on the machine.

<!-- lane flow appends below -->

## The migration flow

`apply` is one flow execution with one child execution per unit.

| Module        | What it does                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| `Contract`    | The system teaching every unit shares, and the per-unit prompt built from captured source.             |
| `Options`     | What one run was asked to do; the flow's payload.                                                      |
| `Gate`        | The two operator gates, both exit 3.                                                                   |
| `Checkpoint`  | jj change, git ref, or file copy, plus a digest of the whole tree, taken before a unit edits anything. |
| `Transform`   | The model-backed rewrite and the host it runs inside.                                                  |
| `Repair`      | One failing verification round, handed back with the failing output.                                   |
| `Verify`      | Install, format, typecheck, tests, and registry discovery.                                             |
| `Archive`     | Replaced sources moved aside; the manifest, tsconfig, and ignore file rewritten where they are.        |
| `MigrateFlow` | The graph, its actions, and every implementation.                                                      |
| `Layers`      | The Node composition, its grant rules, and the scripted one tests use.                                 |
| `Command`     | The entry point the CLI, the bin, and the control plane share.                                         |

Everything above `Contract`, `Gate`, and `Options` is reached by subpath, as `@smthrs/migrate/flow/Command`, because `import "@smthrs/migrate"` loads the scanners and nothing else. Deciding whether to migrate must not require installing the runtime.

## Running it

```sh
npx @smthrs/migrate                 # plan: scan, write the report, change nothing
npx @smthrs/migrate --apply --seat anthropic:<model>
```

`--apply` refuses a project that still holds 0.x run state until `--acknowledge-run-state`, and refuses a construct with no safe translation until `--allow-unsafe <name,...>` or `--allow-unsafe all`. Both refusals exit 3 with the project untouched. `--scan`, `--allow-no-vcs`, `--keep-old-sources`, `--unit <id,...>`, `--max-repair-rounds`, `--report-dir`, `--flows-dir`, and `--json` do what their names say.

`--report-dir` and `--flows-dir` name directories inside the project: a plain relative path with no `.` or `..` segment, not under `.flows`, `.git`, `.jj`, or `node_modules`, and not inside each other. The report directory is the tool's alone. The scan skips it, so it must be empty, new, or hold only what an earlier run wrote (`report.json`, `report.md`, `units/`, `backup/`, `archive/`, `pending-unit.json`); a symlink on either path that leads out of the project is refused as well. Any of these fails with `invalid-layout` and exit 1 before a byte is read.

`--verify-install`, `--verify-format`, `--verify-typecheck` (repeatable), and `--verify-test` replace the commands the detection ladder derives from the manifests and the lockfile. They matter more than a convenience: every unit is verified with these lines and the agent's shell is granted exactly them, so a project whose typecheck lives in a Makefile has no other way to be migrated. One empty value, `--verify-typecheck ""`, runs no typecheck at all.

A derived command is an executable and its arguments, spawned with no shell: a tsconfig named `tsconfig.;rm -rf .json` is one argument to `tsc`, not a line a shell reads. The derived formatter runs in check mode (`dprint check`, `prettier --check .`), because a verification asks a question and a formatter that rewrites the repository answers it by editing files the unit does not own. Only an operator override keeps shell semantics, because the operator typed it. A `repoCommands.test` in `smithers.config.ts` that needs a shell is not run as written; the plan says which command ran instead and names the override that runs the line.

## What a unit is allowed to write

A unit declares its sources and its targets, and that is the only place it may write. The checkpoint copies every declared path aside, sources and targets alike, and records for each one whether it existed and what its bytes digested to, so a target the operator already had at the path a unit writes comes back byte for byte when the unit fails, and a path that was absent is the only kind a rollback removes. The checkpoint digests the whole tree before the unit starts — everything but `.git`, `.jj`, `node_modules`, the report directory, `.flows/`, and the run-state paths, which have a stricter check of their own — and the diff afterwards is what the unit report's changed files are built from. The agent's own account of what it touched is advisory and is cross-checked against that diff, never trusted in place of it. A write outside the unit's file set fails the unit: a file it added is removed, and a file it modified is named in the report with the command that restores the checkpoint, because the checkpoint copied the unit's own files aside and nothing else.

The agent cannot read run state either. The grant rules deny every filesystem action on each 0.x run-state path and everything under it, so a database, an execution log, or a subscription file is refused by the kernel before its bytes reach a model call; a source that merely shares the directory stays readable. Everything the prompt quotes from the project, sources, hints, snippets, and command output, is fenced so the content cannot end the block, and the contract says in so many words that text inside it is data.

A unit the tool's own steps cannot finish (a checkpoint that cannot be taken, an archive that cannot move a file, a verification that cannot spawn) is recorded as a failed unit with the error's code and message in its report entry, after its restoring scope has put its files back, and the next unit runs; the report still exits 1. The one exception is `no-vcs`, which refuses the whole run before anything is written so the operator sees `--allow-no-vcs`.

Every verification command's output is bounded while it runs: each stream keeps its last 12 KB through a rolling window and the report says how many earlier bytes were dropped. A scan that could not read part of the project (a directory it cannot list, one deeper than twelve levels, a file over 8 MB) records an `incomplete-scan` warning per path; `plan` reports it and `apply` refuses the plan, because a migration of an incomplete plan is a migration of the wrong project.

Before the first unit runs, the flow reads the project once more and compares it with the plan it was given: every unit outline, the run-state roots, the layout, and a digest of every source and target. A project that changed since planning, in any byte the plan covers, is refused with `stale-plan` and exit 1, and nothing is written.

A verified unit then archives what the migration replaced and rewrites what a 1.0 project keeps. `package.json`, `tsconfig*.json`, and `.gitignore` are rewritten in place — old packages out, `effect` pinned, `smithers up <file>` scripts rewritten to `smithers run <flow>`, the JSX compiler options and old path mappings removed, `.flows/` ignored, and a project with no ignore file given one — and never moved. Every other source of a workflow or project unit moves to `.smithers-migrate/archive/<original path>`. A `dependencies` or `integration` unit archives nothing: its files are the ones the migration edits. Archiving is two phases, every copy written before any source is removed, and the whole step runs inside the checkpoint's restoring scope, so a failure anywhere in it — or in anything after it — puts the unit back: the scope re-reads the tree when it fires, restores every file the checkpoint recorded, and takes the archive copies with it.

The tree the archive leaves behind is the tree that gets the last word. Before a unit is called `migrated` it has to satisfy the postconditions of its kind: a workflow unit wrote the flow it was planned for, a dependencies or project unit's manifests still exist, declare no 0.x package in any dependency field, and pin `effect`, a project unit's tsconfigs configure no JSX runtime and its ignore file exists and covers `.flows/`, an integration unit's sources still exist and no longer import the old facade. Then the whole verification runs again over that final tree, install, format, every typecheck, the tests, and registry discovery, and the whole-tree confinement check and the run-state digests run again after it, because the archive and the verification both ran commands. The report records that final verification. A failure at any of these restores the unit. The content checks read the files a unit changed, so a unit that changed nothing passes them vacuously; these are what stop it being recorded as migrated anyway.

The seat is a role: the flow declares `migrate`, and the resolver maps it onto the `provider:model` the operator named. No model id is hard-coded anywhere in this package, and a run with no seat and no key refuses by name instead of guessing.

## Testing it against a real model

`test/flow/MigrateFlow.live.e2e.test.ts` migrates the fixtures with a real seat. It needs two variables, and skips with a reason when either is missing:

| Variable                                                       | Value                                                            |
| -------------------------------------------------------------- | ---------------------------------------------------------------- |
| `SMITHERS_MIGRATE_SEAT`                                        | the `provider:model` seat to run on, such as `anthropic:<model>` |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `OPENROUTER_API_KEY` | that provider's key                                              |

The seat variable exists for the same reason `--seat` does: this package hard-codes no model id, so a key alone does not say which model to spend it on.

```sh
SMITHERS_MIGRATE_SEAT=anthropic:<model> ANTHROPIC_API_KEY=... pnpm --filter @smthrs/migrate test
```

The first live case spawns the built bin, which is what an operator runs. Its `typecheck` and `test` are still overridden, and that is a deviation with a reason: the migrated fixture imports `@smthrs/*@1.0.0-rc.0`, which is unpublished, so a real install cannot resolve it and a real typecheck cannot run until it is. Registry discovery, the deterministic checks, and the assertions do the measuring instead. `test/flow/Bin.test.ts` covers the same executable without credentials — plan mode, the JSON rendering, the verification-override flags, and the exit-3 refusal — so the spawn path is proven whether or not anyone has a seat.

## Guides

- `skills/migrate-smithers-v1/SKILL.md`: when to run it and what to do with the report.
- `docs/pages/migration/1.0.md`: the operator guide.
- `docs/pages/migration/migrate-tool.md`: the API reference.
