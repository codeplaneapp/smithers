---
title: "@smthrs/build-cli"
description: "The smithers-build command-line entry point: fourteen verbs that select declared targets by label, plan them, consult a content-addressed cache, and run what is missing."
---

`@smthrs/build-cli` is the `smithers-build` binary and everything behind it.

A verb selects targets by label or pattern, the CLI plans them, consults a
content-addressed cache, and runs whatever is missing. Targets declare their
inputs, their outputs, and their permissions; they never carry per-command
scripts, so the same plan runs the same way on a laptop and in CI.

```bash
pnpm exec smithers-build ci '//packages/...'
```

The package holds the whole run path: workspace discovery, the planner, the
executor, the local and remote caches, write-set confinement, the sandbox
boundary, the service supervisor, and the query, graph, and terminal
renderers. The rules those targets are built from live in
[`@smthrs/targets`](/api/targets); the install flow and the toolchain layers
live in [`@smthrs/build`](/api/smithers-build).

## Who uses this package

Anyone running a Smithers workspace uses the binary. Programs that embed the
build, a test harness or a hosted runner, use `makeCli` and `Entry.main` to
drive the same commands with injected terminals, an injected environment, and
an `AbortSignal` they own.

## Install

The package is `private: true` and publishes nothing. A workspace reaches it
through a workspace dependency:

```json
{
  "devDependencies": {
    "@smthrs/build-cli": "workspace:*",
    "@smthrs/targets": "workspace:*"
  }
}
```

For the runtime requirements and the loader the binary boots, see
[Installation](./installation.md).

## The smallest real run

Declare a workspace, declare one target, and run it:

```ts
// WORKSPACE.ts
import { Smithers as S } from "@smthrs/targets"

const packageJson = S.file("//package.json")

export const Workspace = S.Workspace("demo", {
  repository: "git+https://example.invalid/demo.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: ">=22.19.0" }),
  packageManager: S.PackageManager.Pnpm({
    manifest: packageJson,
    lockfile: S.file("//pnpm-lock.yaml")
  }),
  nodeModules: S.Npm.NodeModules({ packageJson })
})
```

```ts
// PACKAGE.ts
import { Smithers as S } from "@smthrs/targets"

const greet = S.Shell.Test({ command: "echo hello" })

export const Package = S.Package({ targets: { greet } })
```

```bash
pnpm exec smithers-build test '//:greet'
```

The second run of that command reports a cache hit and spawns nothing. The
[Quickstart](./quickstart.md) walks the same workspace through planning,
querying, and a cached rerun.

## The verbs at a glance

| Verb                            | What it does                                                                 |
| ------------------------------- | ---------------------------------------------------------------------------- |
| `build`, `test`, `lint`, `docs` | Execute the targets a pattern selects under that kind.                       |
| `review`                        | Execute model-review targets, skipping the ones whose engine CLI is absent.  |
| `ci`                            | Execute lint, build, test, and docs over one merged graph.                   |
| `run`                           | Execute run targets: generators, publishes, agent tasks, commits.            |
| `target`                        | Execute one label under the verb its rule implies. Also the bare-label form. |
| `query`, `graph`, `owners`      | Read the workspace without executing anything.                               |
| `install`                       | Plan and execute the workspace install flow.                                 |
| `gitHooks`                      | Check the declared git hooks against `.git/hooks`, or install them.          |
| `create-app`                    | Scaffold a Smithers app from a template.                                     |

Every flag of every verb is on the [command reference](./cli.md).

## Where to go next

- [Installation](./installation.md): the runtime, the loader, and the
  TypeScript syntax declaration modules may use.
- [Quickstart](./quickstart.md): one workspace, one target, planned, run,
  cached, and queried.
- [Commands](./cli.md): every command, argument, option, and exit code.
- Guides: [select the targets a command runs](./guides/select-targets.md),
  [inspect a workspace without running it](./guides/inspect-a-workspace.md),
  [share results through a remote cache](./guides/share-a-remote-cache.md),
  [scaffold an app](./guides/scaffold-an-app.md), and
  [embed the CLI in another program](./guides/embed-the-cli.md).
- Concepts: [the invocation pipeline](./concepts/invocation.md),
  [workspace discovery](./concepts/discovery.md),
  [output and renderers](./concepts/output.md),
  [caching](./concepts/caching.md), and
  [target execution](./concepts/execution.md).
- [Troubleshooting](./troubleshooting.md): the refusals this CLI reports, what
  causes each one, and what to change.
- [API reference](./api.md): the exports a program embedding the CLI uses.
