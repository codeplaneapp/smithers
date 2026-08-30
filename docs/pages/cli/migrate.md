---
description: "Convert a Smithers 0.x project to the 1.0 authoring model"
---

# smithers migrate

Convert a Smithers 0.x project to the 1.0 authoring model.

## Usage

```sh
smithers migrate [flags] [<path>]
```

## Behavior

The reserved `system/migrate` flow id is retired so the verb does not collide with the project flow.

## Flags

| Flag | Meaning |
| --- | --- |
| `--scan` | Inventory the project and write the report without planning any unit |
| `--apply` | Convert the project source, instead of planning the conversion |
| `--seat string` | The model seat the migration's agent runs on |
| `--allow-unsafe string` | Accept the named unsafe constructs, or `all` |
| `--acknowledge-run-state` | Accept the 0.x run state the report lists and migrate the source anyway |
| `--allow-no-vcs` | Accept a file copy as the only checkpoint, in a project under no version control |
| `--keep-old-sources` | Leave the 0.x sources in place beside the flows written from them |
| `--unit string` | Migrate only these units, comma separated |
| `--max-repair-rounds integer` | How many times one unit may be repaired before it is reported as failed |
| `--report-dir string` | Where the report is written, relative to the project root |
| `--flows-dir string` | Where the written flows go, instead of `flows/` |
| `--verify-install string` | The command that installs dependencies, instead of the one the lockfile implies |
| `--verify-format string` | The command that formats the project, instead of the one its config implies |
| `--verify-typecheck string` | The command that typechecks the project, repeatable; one empty value runs no typecheck at all |
| `--verify-test string` | The command that runs the tests, instead of the project's own test script |

## Removed flags

These flags existed in Smithers 0.x. `smithers migrate` declares each one so it fails with a migration message instead of a usage error, and exits 1.

| Flag | Reason |
| --- | --- |
| `--to &lt;backend&gt;` | SQLite only; the 0.x database move is removed |

## Source

This page is generated from the binary's `--help` output and section 4.1 of the
[release contract](https://github.com/smithersai/smithers/blob/main/docs/migration/rc-contract.md).
Run `pnpm docs:pages` after changing either.
