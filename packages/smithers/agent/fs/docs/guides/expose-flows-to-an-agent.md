---
title: "Expose flows to an agent"
description: "Build a Command surface from scanned routes and drive it with list, parse, execute, and typed call."
sidebar:
  order: 1
---

The `Command` surface is how an agent drives your flows: one command string
in, one schema-checked result out. This guide assumes you have scanned routes
already; for that step, see [Quickstart](../quickstart.md).

## Build the surface

Pass the scanned routes to `Command.make`. It validates every route, filters
to executable ones (module kind with `modelInvocable` true), and freezes the
projection:

```ts
import { Command, FileRouter } from "@smthrs/fs"
import { Effect } from "effect"
import { resolve } from "node:path"

const program = Effect.gen(function*() {
  const { routes } = yield* FileRouter.scan({ root: resolve("flows") })
  return yield* Command.make(routes)
})
```

A malformed route fails `make` even when it would never enter the executable
projection, and two routes claiming one command name fail with
`duplicate_route`.

## List the advertised commands

`list` returns the executable routes in stable segment order without loading
any module:

```ts
const listed = commands.list()
// [ { name: "review", description: "Review a pull request." } ]
```

Routes that are hidden (`modelInvocable` false), Markdown, or skill bodies
never appear here. They remain available from the scan for inspection.

## Parse without invoking

To inspect what a command string would do, use `parse`. It lexes the string,
resolves the longest command prefix, loads the selected module, and decodes
the input, stopping before invocation:

```ts
const parsed = yield* commands.parse("review --number 42 --tags one --tags two")
// parsed.route.name === "review"
// parsed.input === { number: 42, tags: ["one", "two"] }
```

A listed name resolves with slashes or with spaces: `"nested/visible"` and
`"nested visible"` select the same route. Quoting follows shell rules without
a shell: single quotes are literal, double-quoted and unquoted text honor
backslash escapes, and substitutions stay literal text. An unterminated quote
fails with `parse_failed`; an unmatched name fails with `unknown_command`.

## Execute through the invoker

`execute` runs the full pipeline: parse, invoke through `FlowInvoker`, then
encode the output through the flow's output schema. Provide the invoker your
harness installs:

```ts
import { FlowInvoker } from "@smthrs/fs"
import { Effect, Layer } from "effect"

const output = yield* commands.execute("review --number 42").pipe(
  Effect.provide(Layer.succeed(FlowInvoker.FlowInvoker, invoker))
)
```

The invocation the service receives is frozen: the route name, the loaded
flow, and the decoded input. An `FsError` the invoker fails with passes
through unchanged; an output the flow's schema rejects fails with
`encode_failed`.

## Call a route by name with typed input

For programmatic calls, skip the command string with `call`. The name must
match exactly, and the input is snapshotted to inert JSON before the module
loads, so later mutation cannot reach the in-flight invocation:

```ts
const output = yield* commands.call("review", { number: 42 }).pipe(
  Effect.provide(Layer.succeed(FlowInvoker.FlowInvoker, invoker))
)
```

To narrow names and value types, augment `Route.Manifest` in generated code:

```ts
declare module "@smthrs/fs/Route" {
  interface Manifest {
    review: {
      readonly input: { readonly number: number }
      readonly output: { readonly accepted: boolean; readonly number: number }
    }
  }
}
```

With the manifest declared, `call` accepts only manifest names and checks
input and output types against it. Without one, names stay `string` and
values stay `unknown`, so development discovery can proceed.

## Handle the failures

Every failure is an `FsError`; branch on `code`:

```ts
import { Cause, Effect, Option } from "effect"

const exit = await Effect.runPromise(Effect.exit(commands.execute(commandString)))
if (exit._tag === "Failure") {
  const error = Cause.findErrorOption(exit.cause)
  if (Option.isSome(error)) console.error(error.value.code)
}
```

The codes an agent surface produces: `resource_limit` for oversized commands,
`parse_failed` for malformed strings, `unknown_command` for unmatched names,
`load_failed` when the module cannot be imported or exports no flow,
`unsupported_schema` when the route's locator cannot describe input,
`decode_failed` when input fails decoding, `encode_failed` when output fails
encoding, and `invocation_unavailable` when no invoker is installed. Error
values never retain raw arguments or input values, so they are safe to return
to the agent. For causes and fixes, see
[Troubleshooting](../troubleshooting.md).
