---
title: "Installation"
description: "Install @smthrs/mcp, the platform services a stdio connection requires, the import forms, and the packages a host composition adds."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/mcp/docs/installation.md"
---

## Install the package

```bash
pnpm add @smthrs/mcp
```

The package requires Node.js 22.19.0 or later and ships as both ESM and
CommonJS with TypeScript declarations. Its runtime dependencies, including
[`effect`](https://effect.website) and the `@smthrs/*` packages the adapter
composes, install with it.

## Provide a process spawner

Every constructor that opens a connection requires two services from the
caller's environment:

| Requirement           | Why                                                                                     |
| --------------------- | --------------------------------------------------------------------------------------- |
| `ChildProcessSpawner` | An MCP server is a subprocess. The spawner is Effect's process port, not a Node import. |
| `Scope`               | The connection is scoped. Closing the scope tears the server process down.              |

On Node, `@effect/platform-node` provides the spawner:

```bash
pnpm add @effect/platform-node
```

```ts
import { NodeServices } from "@effect/platform-node"
import { Effect } from "effect"

const runnable = Effect.provide(Effect.scoped(program), NodeServices.layer)
```

These are the same services a host already provides for
`StandardFlows.shell`, so a composition that runs shell commands already has
them.

## Import forms

The root entry point re-exports every module as a namespace:

```ts
import { McpClient, McpError, McpFlows } from "@smthrs/mcp"
```

Each module is also importable from its own subpath, which is the form the
[API reference](/reference/api/) uses in its examples:

```ts
import * as McpClient from "@smthrs/mcp/McpClient"
import * as McpFlows from "@smthrs/mcp/McpFlows"
```

`McpError` is a namespace either way. The error class is `McpError.McpError`:

```ts
import * as McpError from "@smthrs/mcp/McpError"

const failure = new McpError.McpError({ code: "timeout", message: "...", server: "github" })
```

Two subpath forms are not public: `@smthrs/mcp/internal/*` and
`@smthrs/mcp/*/index`. Both are blocked in the package's export map, so the
JSON-RPC codec and the stdio transport are not importable.
`@smthrs/mcp/package.json` is exported.

## What a host composition adds

The projected `FlowBinding.Source` is only useful to something that composes a
flow catalog. [`@smthrs/harness`](https://harness.smithers.sh/reference/api/),
[`@smthrs/capability`](https://capability.smithers.sh/reference/api/), and [`@smthrs/registry`](https://registry.smithers.sh/reference/api/)
are runtime dependencies of this package and install with it:

- `@smthrs/harness` owns `FlowBinding`, the contract this package implements.
  `FlowBinding.catalog` merges this source with the others a host offers. See
  [Bind flows](https://harness.smithers.sh/guides/bind-flows/).
- `@smthrs/capability` owns the action vocabulary `McpFlows.capabilities` is
  derived from.

What a host adds is the thing that runs the cell loop:

```bash
pnpm add @smthrs/agent
```

[`@smthrs/agent`](https://agent.smithers.sh/reference/api/) takes the projected sources as its `flows` option,
alongside `StandardFlows.filesystem` and the rest.

The CLI already wires all of this. `smthrs --mcp-config <path>` connects every
server the file names and adds its flows to a run's catalog; see
[Configure servers for the CLI](/guides/configure-servers-for-the-cli/).

## Next step

Connect to a real server and call one of its tools in the
[Quickstart](/quickstart/).
