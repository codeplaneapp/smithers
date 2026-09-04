---
title: "Cli"
description: "Executes PACKAGE.ts target graphs with content-addressed caching"
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/build/build-cli/docs/cli.md"
---

`makeCli` registers fourteen commands. `normalizeArgv` adds a fifteenth spelling:
an argv whose first token starts with `//` or `:` is rewritten to `target
<label>`, so `smithers-build //packages/smithers/flows/flow:lint` runs the bare-label form.

Every command accepts the global `--ui <auto|tty|stream|plain>`, which selects
the renderer: `tty` draws in place, `stream` colours without cursor motion,
`plain` prints bare lines, and `auto` picks `tty` on a terminal and `plain`
under a pipe, in CI, under `NO_COLOR`, or with an explicit `--format`.

## Workspace commands

These take `--workspace, -w <dir>` (default: the current directory) and
`--cache-dir <dir>` (workspace-relative; see [caching](/caching/)).

| Command    | Argument    | Own options     |
| ---------- | ----------- | --------------- |
| `install`  | —           | —               |
| `query`    | `<expr>`    | —               |
| `graph`    | `<pattern>` | `--mermaid, -m` |
| `gitHooks` | —           | `--write`       |
| `owners`   | `[paths…]`  | `--diff, -d`    |

`query` takes a label, a pattern, `deps(<label>)`, `rdeps(<label>)`, or
`owners(<label>)`. `owners` resolves the owners, reasons, and agent policy of
workspace paths, or of every path `--diff <base>` reports changed, from the
PACKAGE.ts `owners` declarations. `graph` prints the target
graph without executing it; `--mermaid` renders a flowchart instead of a text
tree, in both build system and build system.

`install` plans and executes the install Flow under the package manager and
runtime named by the root PACKAGE.ts `Install` declaration. It falls back to pnpm
on node when the workspace declares none, and refuses to run in build system.

## Execution commands

These add `--plan`, `--jobs, -j <n>`, and `--cache` / `--no-cache` to the
workspace options above. `--plan` prints the inert plan instead of executing.
`--no-cache` bypasses cache reads; results are still published.

| Command  | Argument    | Own options                                                   |
| -------- | ----------- | ------------------------------------------------------------- |
| `build`  | `<pattern>` | —                                                             |
| `test`   | `<pattern>` | —                                                             |
| `lint`   | `<pattern>` | `--fix`                                                       |
| `docs`   | `<pattern>` | —                                                             |
| `review` | `<pattern>` | —                                                             |
| `ci`     | `<pattern>` | —                                                             |
| `run`    | `<pattern>` | `--name, -n`, `--message, -m`, `--sweep`, `--input, -i`       |
| `target` | `<label>`   | `--write`, `--fix`, `--message, -m`, `--sweep`, `--input, -i` |

`ci` executes build, test, lint, and documentation targets over one merged
graph. It does NOT include `review`: a review target expands a git diff against
a base revision at plan time and then spawns a model CLI, so planning one on a
shallow checkout fails the whole aggregate and running one needs a binary and a
credential an unattended pipeline does not have. `review` executes the
model-review targets, which participate in that verb alone; a target whose
engine CLI is not installed is reported skipped, with a notice naming the
executable, rather than failed. `run` executes run targets; `--name` supplies a
package name to scaffold targets. `target` is the bare-label form: it runs one
build-system label under the verb its rule flavour implies, and is the one way
to run a review target without naming the verb.

`--fix` applies agent lint fixes inside the declared `fixes` write set.
`--write` applies `Diff`, `Generate`, and `CiGen` targets instead of checking
them for drift. `--input name=value` is repeatable and becomes an agent
target's payload; repeating one name fails the command. `--sweep` lets a
`Git.Commit` target with no declared path scope commit the whole working tree;
without it, such a target refuses with `unrelated_changes` when the tree
carries changes the commit does not own.

## Scaffolding

`create-app <dir>` scaffolds an app from a `@smthrs/create-app` template. Its
only options are `--template <name>` (default `default`; `aomi` is the other)
and `--link` / `--no-link`, which decides whether the generated `@smthrs/*`
dependencies point at the checkout the templates came from or at published
versions. It takes neither `--workspace` nor `--cache-dir`.

## Runtime

The package requires Node 22.19 or newer. `src/main.js` boots the programmatic
`tsx` loader that ships as a CLI dependency, then loads the TypeScript command
modules and the declaration modules. PACKAGE.ts and PACKAGE.ts files must use
erasable TypeScript syntax and top-level imports.
