# @smthrs/fs

Portable filesystem routing and command projections for flows. It discovers flow metadata without evaluating modules, resolves path-derived commands, and defers selected execution through an injectable invoker.

```sh
npm install @smthrs/fs
```

## Public API

`@smthrs/fs` re-exports every public module from its root, and each module is also importable from its own subpath.

| Import                   | Public exports                                                          | Description                                                                |
| ------------------------ | ----------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `@smthrs/fs/Command`     | `ListedCommand`, `ParsedCommand`, `CommandSurface`, `make`              | Builds the agent-facing list, parse, execute, and call surface for routes. |
| `@smthrs/fs/CommandTree` | `CommandTree`, `Resolved`, `make`, `resolve`, `traverse`                | Builds a stable route trie and performs longest-prefix resolution.         |
| `@smthrs/fs/Directive`   | `Literal`, `compile`                                                    | Compiles client, local, sandbox, and remote placement directives.          |
| `@smthrs/fs/FileRouter`  | `ScanConfig`, `Warning`, `ScanResult`, `scan`                           | Scans a filesystem root into metadata-only routes and diagnostics.         |
| `@smthrs/fs/FlowInvoker` | `Invocation`, `Service`, `FlowInvoker`, `make`, `makeNoop`, `layerNoop` | Defines the lazy flow-execution service boundary.                          |
| `@smthrs/fs/FsError`     | `Code`, `FsError`                                                       | Defines typed scan, parse, load, schema, and encoding failures.            |
| `@smthrs/fs/Incur`       | `createCli`                                                             | Projects routes into an Incur CLI.                                         |
| `@smthrs/fs/Route`       | `Kind`, `Route`, `Name`, `Input`, `Output`, `load`                      | Defines route models and lazily loads selected module routes.              |

```ts
import { Command, FileRouter, FlowInvoker } from "@smthrs/fs"
import { Effect, Layer } from "effect"

const invoker = FlowInvoker.make({ invoke: () => Effect.succeed({}) })

const program = Effect.gen(function*() {
  const { routes } = yield* FileRouter.scan({ root: "./flows" })
  const commands = yield* Command.make(routes)
  return yield* commands.execute("review --title notes")
}).pipe(Effect.provide(Layer.succeed(FlowInvoker.FlowInvoker, invoker)))
```

`@smthrs/fs/package.json` is exported; `internal/*` and nested `*/index` subpaths are blocked. There is no `@smthrs/fs/vite` entry: nothing in this tree consumes one, so the manifest does not promise it. `vite` stays an optional peer dependency for whenever that entry is built.
