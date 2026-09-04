---
title: "Commands"
description: "Every smithers-build command, argument, option, exit code, and error code, plus the global flags incur adds and the environment variables the CLI reads."
---

```text
smithers-build <command> [arguments] [options]
```

`makeCli` registers fourteen commands. `normalizeArgv` adds a fifteenth
spelling: an argv whose first token starts with `//` or `:` is rewritten to
`target <label>`, so `smithers-build //packages/smithers/flows/flow:lint` runs
the bare-label form.

Option names are the kebab-case form of their schema key, so `cacheDir` is
`--cache-dir`. A boolean option that defaults to true is turned off with its
`--no-` form, so `--cache` becomes `--no-cache` and `--link` becomes
`--no-link`.

## Workspace options

Every command except `create-app` takes these.

| Option        | Alias | Type   | Default                | Meaning                                                         |
| ------------- | ----- | ------ | ---------------------- | --------------------------------------------------------------- |
| `--workspace` | `-w`  | string | the working directory  | A directory inside the workspace. Discovery walks up from it.   |
| `--cache-dir` |       | string | the declared directory | Workspace-relative cache directory, overriding the declaration. |

`--cache-dir` must be relative, non-empty, and free of `..` segments; anything
else fails the command. Precedence is the flag, then the `S.Cache({ directory })`
in the workspace declaration, then `.flows`. See
[Caching](./concepts/caching.md).

## Execution options

`build`, `test`, `lint`, `docs`, `review`, `run`, `target`, and `ci` add these
to the workspace options.

| Option                   | Alias | Type       | Default          | Meaning                                                         |
| ------------------------ | ----- | ---------- | ---------------- | --------------------------------------------------------------- |
| `--plan`                 |       | boolean    | `false`          | Print the inert plan and execute nothing.                       |
| `--jobs`                 | `-j`  | integer 1+ | host parallelism | Maximum concurrent targets.                                     |
| `--cache` / `--no-cache` |       | boolean    | `true`           | Consult the cache before running. `--no-cache` still publishes. |

## Global options

`--ui <auto|tty|stream|plain>` is the one global `smithers-build` adds. It
picks the renderer that draws progress on standard error: `tty` draws in
place, `stream` colours without moving the cursor, `plain` prints bare lines,
and `auto` resolves from the environment and the streams. It never changes the
structured envelope on standard output. See
[Output and renderers](./concepts/output.md).

The CLI is built on [incur](https://github.com/wevm/incur), which supplies the
rest on every command: `--help`, `--version`, `--json`,
`--format <toon|json|yaml|md|jsonl>`, `--filter-output`, `--full-output`,
`--schema`, `--llms`, and the `--token-count`, `--token-limit`, and
`--token-offset` trio. Output is TOON by default. Run
`smithers-build <command> --help` for the list a given version serves.

## Execution commands

Each of these takes a pattern argument, the workspace options, and the
execution options.

| Command  | Argument    | Own options                                                   |
| -------- | ----------- | ------------------------------------------------------------- |
| `build`  | `<pattern>` |                                                               |
| `test`   | `<pattern>` |                                                               |
| `lint`   | `<pattern>` | `--fix`                                                       |
| `docs`   | `<pattern>` |                                                               |
| `review` | `<pattern>` |                                                               |
| `ci`     | `<pattern>` |                                                               |
| `run`    | `<pattern>` | `--name, -n`, `--message, -m`, `--sweep`, `--input, -i`       |
| `target` | `<label>`   | `--write`, `--fix`, `--message, -m`, `--sweep`, `--input, -i` |

### build, test, lint, docs

Execute the targets a pattern selects under that kind. A target participates
in a verb when its rule declares that kind, so `lint` over a package selects
its linters and its drift checks and nothing else. A verb that cannot execute
a selected target reports the unsupported rule rather than returning a false
green.

```bash
pnpm exec smithers-build test '//packages/...'
pnpm exec smithers-build lint '//packages/smithers/flows/flow:lint'
```

`--fix` lets an agent lint target write inside its declared `fixes` write set.
Without it the target checks and reports.

### review

Executes the model-review targets a pattern selects. A review expands a git
diff against a base revision at plan time and then spawns a model CLI, so it
participates in this verb alone.

A target whose engine executable is not installed on the host is reported
skipped, under its own glyph, with a notice naming the executable. A skip
leaves the run green because `ok` counts failures alone, and nothing claims
the review passed. That is the honest report: a machine with no `codex` on
`PATH` cannot say whether the change is clean.

### ci

Plans `lint`, `build`, `test`, and `docs` over one merged graph and executes
it once, so a target two verbs select runs a single time.

```bash
pnpm exec smithers-build ci '//packages/...'
```

Plans merge in that order and the first occurrence of a label wins. Lint comes
first on purpose: a generator target participates in both `build` and `lint`,
and its `lint` form is the non-mutating one. Planning `build` first made
`ci` rewrite checked-in manifests and workflow files as a side effect of
asking whether the repository was green.

`review` and `run` are absent for the same reason. Planning a review on a
shallow pull-request checkout kills the aggregate before any target runs, and
executing one needs a binary and a credential no hosted runner has. `run`
mutates the tree, which is a decision, not a check. Ask for either by name.

If a verb has no targets under the pattern, `ci` continues with the rest. If
none of the four has any, the command fails with the first refusal.

### run

Executes run targets: generators in their writing form, publishes, agent
tasks, and commits.

```bash
pnpm exec smithers-build run '//:changelog'
pnpm exec smithers-build run '//evals/authoring:sftLaunch'
```

`--name` supplies a package name to scaffold targets. The three invocation
flags below apply here and to `target`.

### target

Executes one label under the verb its rule flavour implies, and is what a bare
label resolves to:

```bash
pnpm exec smithers-build target '//packages/smithers/flows/flow:lint'
pnpm exec smithers-build '//packages/smithers/flows/flow:lint'
```

It is the one way to run a `review` target without naming the verb, and the
one way to reach a target whose kind you would otherwise have to remember.

`--write` applies `Diff`, `Generate`, and `CiGen` targets instead of checking
them for drift.

### The invocation flags

`run` and `target` take three flags that change what an outward or agent
target does.

- `--message, -m <text>` overrides the declared commit message of a
  `Git.Commit` target.
- `--sweep` lets a `Git.Commit` target with no declared path scope commit the
  whole working tree. Without it, such a target refuses with
  `unrelated_changes` and names the paths the commit does not own.
- `--input, -i name=value` is repeatable and becomes an agent target's
  payload. A value without `=`, or a name repeated, fails the command.

## Workspace commands

These take the workspace options and execute no targets.

| Command    | Argument    | Own options     |
| ---------- | ----------- | --------------- |
| `install`  |             |                 |
| `query`    | `<expr>`    |                 |
| `graph`    | `<pattern>` | `--mermaid, -m` |
| `owners`   | `[paths…]`  | `--diff, -d`    |
| `gitHooks` |             | `--write`       |

### install

Plans and executes the install flow the root `PACKAGE.ts` declares, under the
runtime and package manager the workspace declaration names. It takes no
label.

```bash
pnpm exec smithers-build install
pnpm exec smithers-build install --workspace /path/to/checkout
```

The root package must declare exactly one `Install` target. Zero or more than
one fails the command before anything runs.

### query

Lists labels, or evaluates one of three functions.

```bash
pnpm exec smithers-build query '//packages/...'
pnpm exec smithers-build query 'deps(//packages/smithers/flows/flow:lib)'
pnpm exec smithers-build query 'rdeps(//packages/smithers/flows/flow:lib)'
pnpm exec smithers-build query 'owners(//packages/smithers/flows/flow:lib)'
```

A label or pattern lists each selected target with its rule, its kinds, and
the one-line summary its declaration carries. `deps(<label>)` prints the
transitive closure below a target with its edges, `rdeps(<label>)` prints
every target that depends on it, and `owners(<label>)` prints the owners,
their roles and reasons, the package's agent policy, and its upstream
packages. All three functions need a single exact or default target and refuse
a pattern that resolves to several.

A `Repo.Target` row that a child workspace could not answer for carries a
`refusal`, rendered for a person and carried in the envelope.

### graph

Prints the target graph a pattern selects without executing it.

```bash
pnpm exec smithers-build graph '//packages/...'
pnpm exec smithers-build graph '//packages/...' --mermaid > graph.mmd
```

`--mermaid` renders a Mermaid flowchart instead of a text tree. Mermaid is
meant for a file or a renderer, so that form is always returned as data and
never drawn to the terminal.

### owners

Resolves owners, reasons, and the agent policy for workspace paths, or for
every path a diff touches.

```bash
pnpm exec smithers-build owners packages/smithers/flows/flow/src/Flow.ts
pnpm exec smithers-build owners --diff main
```

`--diff <base>` adds every path changed since that git base, the same set
`S.gitDiff(base)` expands. The command needs at least one path, from the
argument list or from `--diff`.

### gitHooks

Renders the hook scripts the workspace declaration binds and compares them
byte for byte against `.git/hooks`.

```bash
pnpm exec smithers-build gitHooks
pnpm exec smithers-build gitHooks --write
```

Drift is a red exit that names each drifting file and its status, like every
other generated file. `--write` installs the rendered scripts and reports what
it wrote.

## Scaffolding

### create-app

Scaffolds a Smithers app from a `@smthrs/create-app` template. It takes
neither `--workspace` nor `--cache-dir`, because it creates a directory rather
than reading a workspace.

```bash
pnpm exec smithers-build create-app my-app
pnpm exec smithers-build create-app my-app --template aomi
```

| Option                 | Alias | Type    | Default   | Meaning                                                                 |
| ---------------------- | ----- | ------- | --------- | ----------------------------------------------------------------------- |
| `--template`           | `-t`  | string  | `default` | Template name. `default` and `aomi` ship today.                         |
| `--link` / `--no-link` |       | boolean | `true`    | Point `@smthrs/*` dependencies at the checkout the templates came from. |

The directory's own name becomes the app name, so it must match
`[a-z0-9][a-z0-9._-]*`. The directory must not exist or must be empty. See
[Scaffold an app](./guides/scaffold-an-app.md).

## Exit codes

The CLI exits `0` or `1`. There is no third code.

| Code | When                                                                                                |
| ---- | --------------------------------------------------------------------------------------------------- |
| `0`  | The command completed: every executed target settled green, or the command only read the workspace. |
| `1`  | A target failed, a command refused, argument parsing failed, or a signal interrupted the run.       |

A red run exits 1 whether the failure is reported as a structured error on
standard output or as rendered text on standard error. When a human renderer
has already explained what failed, only the exit code remains to record, so
the envelope's error block is not printed twice.

`SIGINT` and `SIGTERM` abort every running target and set the exit code to 1,
whatever the command was about to report. The second interrupt stops the
process at once. See [The invocation pipeline](./concepts/invocation.md).

## Error codes

A structured failure carries a code alongside its message.

| Code                                                                                                                     | Meaning                                                            |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `targets_failed`                                                                                                         | An executed graph went red. The message counts failures and skips. |
| `build_failed`, `test_failed`, `lint_failed`, `docs_failed`, `review_failed`, `run_failed`, `ci_failed`, `target_failed` | The command threw before or during execution.                      |
| `install_failed`                                                                                                         | Install planning or execution failed.                              |
| `create_app_failed`                                                                                                      | The scaffold refused or failed.                                    |
| `query_failed`, `graph_failed`, `owners_failed`                                                                          | The workspace could not be read, or the expression was rejected.   |
| `git_hooks_failed`                                                                                                       | Rendering or installing the hooks failed.                          |
| `git_hooks_drift`                                                                                                        | Checked hooks differ from the declaration.                         |

## Environment

| Variable                                | Read by                                                                    |
| --------------------------------------- | -------------------------------------------------------------------------- |
| `SMITHERS_CACHE_URL`                    | Overrides the declared remote-cache endpoint for this process.             |
| `SMITHERS_CACHE_TOKEN`                  | The default remote-cache credential.                                       |
| `SMITHERS_CACHE_NAMESPACE`              | The trust domain results publish into. Unset means the trusted domain.     |
| `SMITHERS_JJHUB_API_URL`                | Overrides the jjhub API base that zero-config cache discovery reads.       |
| `SMITHERS_JJHUB_HOSTS`                  | Extra comma-separated hosts whose git remotes identify a jjhub repository. |
| `SMTHRS_UI`                             | The renderer, when `--ui` is `auto`.                                       |
| `SMTHRS_SHARD`                          | `<index>/<total>` selecting one shard of a sharded target.                 |
| `SMTHRS_AGENT_FAKE`                     | A script file that replaces the real agent CLI, for deterministic tests.   |
| `SMTHRS_AGENT_TIMEOUT_MS`               | The agent session timeout.                                                 |
| `SMTHRS_DEBUG_KEYS`                     | A file every node's key material is appended to, for cache-key forensics.  |
| `NO_COLOR`, `TERM`, `CI`, `FORCE_COLOR` | Renderer selection under `--ui auto`.                                      |

`SMITHERS_CACHE_URL` and `SMITHERS_CACHE_TOKEN` are read once by the process
entry point and deleted from the environment before any declaration module
evaluates, so no workspace file can read them. Both names, and every name a
workspace marks sensitive, are also stripped from the environment of every
spawned tool.

## Runtime

The package requires Node 22.19 or newer. `src/main.js` installs the Effect
module resolution hook and boots the programmatic `tsx` loader that ships as a
CLI dependency, which then loads the CLI's own modules and the workspace's
`WORKSPACE.ts` and `PACKAGE.ts` declarations. See
[Installation](./installation.md).
