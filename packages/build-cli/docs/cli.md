# Commands

`makeCli` registers thirteen commands. `normalizeArgv` adds a fourteenth spelling:
an argv whose first token starts with `//` or `:` is rewritten to `target
<label>`, so `smithers-build //packages/flow:lint` runs the bare-label form.

Every command accepts the global `--ui <auto|tty|stream|plain>`, which selects
the renderer: `tty` draws in place, `stream` colours without cursor motion,
`plain` prints bare lines, and `auto` picks `tty` on a terminal and `plain`
under a pipe, in CI, under `NO_COLOR`, or with an explicit `--format`.

## Workspace commands

These take `--workspace, -w <dir>` (default: the current directory) and
`--cache-dir <dir>` (workspace-relative; see [caching](./caching.md)).

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
tree, in both BUILD mode and package mode.

`install` plans and executes the install Flow under the package manager and
runtime named by the root BUILD.ts `Install` declaration. It falls back to pnpm
on node when the workspace declares none, and refuses to run in package mode.

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
| `ci`     | `<pattern>` | —                                                             |
| `run`    | `<pattern>` | `--name, -n`, `--message, -m`, `--sweep`, `--input, -i`       |
| `target` | `<label>`   | `--write`, `--fix`, `--message, -m`, `--sweep`, `--input, -i` |

`ci` executes build, test, lint, and documentation targets over one merged
graph. `run` executes run targets; `--name` supplies a package name to scaffold
targets. `target` is the bare-label form: it runs one package-mode label under
the verb its rule flavour implies.

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
modules and the declaration modules. BUILD.ts and PACKAGE.ts files must use
erasable TypeScript syntax and top-level imports.
