---
title: "@smthrs/fs"
description: "Private metadata routing and schema-checked command projections for Smithers flows."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/fs/docs/README.md"
---

`@smthrs/fs` connects registry discovery to the surfaces that run Smithers
flows. It scans a flows tree without importing any flow module, freezes the
discovered metadata into path-named routes, and projects the executable
subset onto agent, CLI, HTTP, and MCP surfaces where the flow's own Effect
schema checks every input and output.

This package is private at 1.0.0-rc.0 and has no supported external consumer.
Do not install it from a registry. It remains in the workspace as an internal
adapter while the registry and command surfaces settle.

## What it does

Two halves share one immutable route model:

- **Metadata routing.** `FileRouter.scan` reads [registry](https://registry.smithers.sh/reference/api/)
  metadata without importing flow modules and returns module, Markdown, and
  skill routes for inspection. `Route` validates and freezes that metadata,
  `CommandTree` indexes routes for lookup, and `Directive` compiles placement
  literals into [core](https://core.smithers.sh/reference/api/) placement values.
- **Command projections.** `Command.make` exposes the model-invocable module
  routes to an agent as list, parse, execute, and typed call operations.
  `Incur.createCli` serves the same routes as a CLI and as HTTP, OpenAPI, and
  MCP surfaces. Neither projection executes a flow: both dispatch through the
  injected `FlowInvoker` seam, and every failure arrives as a sanitized
  `FsError`.

A selected module loads only when invoked. Its real Effect input schema
decodes the request, and its output schema encodes the result.

## Install

The package never publishes, so there is nothing to install from npm. Inside
the Smithers workspace, add it as a dependency:

```bash
pnpm add @smthrs/fs
```

## The smallest working example

Scan a flows directory, build the agent command surface, and execute one
command through a stub invoker:

```ts
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Command, FileRouter, FlowInvoker } from "@smthrs/fs"
import { Effect, Layer } from "effect"
import { resolve } from "node:path"

const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer)

const invoker = FlowInvoker.make({
  invoke: ({ input }) => Effect.succeed({ accepted: true, number: (input as { readonly number: number }).number })
})

const program = Effect.gen(function*() {
  const { routes } = yield* FileRouter.scan({ root: resolve("flows") })
  const commands = yield* Command.make(routes)
  return yield* commands.execute("review --number 42")
}).pipe(
  Effect.provide(Layer.succeed(FlowInvoker.FlowInvoker, invoker)),
  Effect.provide(platform)
)

Effect.runPromise(program).then(console.log)
```

`FileRouter.scan` requires the platform `FileSystem` and `Path` services, and
`execute` requires a `FlowInvoker`. For the guided version of this program,
see [Quickstart](/quickstart/).

## Where to go next

- [Quickstart](/quickstart/): scan a flows tree and run one command end to end.
- [Expose flows to an agent](/guides/expose-flows-to-an-agent/): list, parse, execute, and call routes programmatically.
- [Serve flows over CLI, HTTP, and MCP](/guides/serve-over-cli-http-and-mcp/): project routes onto an Incur CLI.
- [Test flow invocation](/guides/test-flow-invocation/): stub the invocation boundary.
- [Metadata routing](/concepts/metadata-routing/): how filesystem paths become routes.
- [Command projections](/concepts/command-projections/): how routes become schema-checked surfaces.
- [Filesystem routing contract](/contract/): the normative visibility, schema, path, snapshot, resource, and error behavior.
- [API reference](/reference/api/): every export, with signatures, requirements, and errors.
- [Exported members](/exports/): the public surface as one index.
- [Troubleshooting](/troubleshooting/): the `FsError` codes, their causes, and their fixes.
