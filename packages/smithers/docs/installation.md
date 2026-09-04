---
title: "Installation"
description: "Install the smthrs executable, the Node version it requires, the runners it supports, and the import forms of the library."
sidebar:
  order: 1
---

## Install the executable

```bash
npm install --global @smthrs/cli@next
```

The package installs one executable under two names, `smthrs` and its
`smithers` alias. Both are the same file, `bin/smithers.mjs`.

This documentation describes 1.0.0-rc.0. Release candidates publish under
the `next` dist-tag rather than `latest`, so name that tag when installing:

```bash
npm install --global @smthrs/cli@next
```

Confirm what you got, and what the registry offers, with the CLI itself:

```bash
smthrs --version
smthrs update
```

`smthrs update` compares `Version.packageVersion` against the `next` and
`latest` dist-tags and prints the `npm install` line for the newer one. It
changes nothing.

## Requirements

- Node 22.19.0 or later. The durable engine requires it, `smthrs doctor`
  reports it as a `fail` when the running Node is below the floor, and
  `Doctor.minimumNode` is the constant both read.
- A project directory. Commands that touch durable state resolve a project
  root and write `.flows/` under it. See
  [The project and its state](./concepts/project-and-state.md).
- A provider credential, for flows that call a model. `smthrs doctor` reports
  which of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, and
  `CEREBRAS_API_KEY` are set, and names any that are exported but empty. The
  CLI itself never reads them; the seat resolver does.

## Runners

The shebang in `bin/smithers.mjs` pins Node, because the durable engine is
not supported on Bun. That makes every installation path run on Node:

| Path | Command |
| --- | --- |
| Global install | `smthrs <verb>` |
| One-off through npm | `npx --package @smthrs/cli@next smthrs <verb>` |
| One-off through Bun | `bun x --package @smthrs/cli@next smthrs <verb>` |

Bun honours the shebang, so `bun x` starts Node. Running the CLI with
`bun --bun` overrides the shebang and is not supported.

## Running from a source checkout

A published install ships `dist/esm/bin.js` and the shim runs it. A checkout
has no `dist/`, so the shim runs `src/bin.ts` through Node's own type
stripping instead. `pnpm exec smthrs` therefore runs the working tree with no
build step, and the experimental type-stripping warning is suppressed for that
one path so it does not prepend noise to every invocation.

If a checkout's workspace links point into a git worktree that has since been
removed, the entry fails with `ERR_MODULE_NOT_FOUND` for a package that is
present in the tree. The shim detects that case and prints the real diagnosis
before rethrowing.

## Using the library

The package is also importable. The root entry point re-exports every module
as a namespace:

```ts
import { Command, NodeControl, Output, Verb } from "@smthrs/cli"
```

Each module is also importable from its own subpath, which is the form the
[API reference](./api.md) uses:

```ts
import * as NodeControl from "@smthrs/cli/NodeControl"
import * as Verb from "@smthrs/cli/Verb"
```

`@smthrs/cli/package.json` is exported. Two subpath forms are not public and
are blocked in the export map: `@smthrs/cli/internal/*` and
`@smthrs/cli/*/index`.

The package depends on the whole Smithers stack, including
[`@smthrs/control`](/api/control), [`@smthrs/engine`](/api/engine),
[`@smthrs/agent`](/api/agent), [`@smthrs/gateway`](/api/gateway), and
[`@smthrs/journal`](/api/journal). Installing it installs them, so a host that
embeds the command tree adds no further packages. See
[Embed the command tree](./guides/embed-the-command-tree.md).

## Next step

Run one project from `init` to a settled run in the [Quickstart](./quickstart.md).
