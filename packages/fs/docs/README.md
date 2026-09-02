# `@smthrs/fs`

Private metadata routing and schema-checked command projections for Smithers
flows.

This package is private at 1.0.0-rc.0 and has no supported external consumer.
Do not install it. It remains in the workspace as an internal adapter while
the registry and command surfaces settle.

`FileRouter.scan` reads registry metadata without importing flow modules. It
returns module, Markdown, and skill routes for inspection. `Command.make` and
`Incur.createCli` expose only model-invocable module routes, because Markdown
and skill execution is not implemented here. A selected module is loaded only
when invoked, its real Effect input schema decodes the request, and its output
schema encodes the result around the injected `FlowInvoker` boundary.

```ts
import { Command, FileRouter, FlowInvoker } from "@smthrs/fs"
import { Effect, Layer } from "effect"
import { resolve } from "node:path"

const invoker = FlowInvoker.make({ invoke: () => Effect.succeed({ accepted: true }) })

const program = Effect.gen(function*() {
  const { routes } = yield* FileRouter.scan({ root: resolve("flows") })
  const commands = yield* Command.make(routes)
  return yield* commands.execute("review --title notes")
}).pipe(Effect.provide(Layer.succeed(FlowInvoker.FlowInvoker, invoker)))
```

## Package-owned contract

- [`docs/README.md`](./docs/README.md) is the editable source for this generated
  package README.
- [`docs/api.md`](./docs/api.md) describes the eight namespaces and their
  composition.
- [`docs/contract.md`](./docs/contract.md) defines visibility, schema,
  path, snapshot, resource, and error behavior.
- [`docs/exports.md`](./docs/exports.md) is generated from exported JSDoc.

Run `node packages/fs/scripts/docs.mjs` from the workspace root to regenerate
this README and the export index. `//packages/fs:docsPages` drift-checks both.

The root and named module subpaths are workspace surfaces only.
`./internal/*` and nested `*/index` paths are blocked. There is no Vite entry
or Vite peer contract.
