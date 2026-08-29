---
description: "The Node host bundle: one layer that provides all five tags in the closed host list."
---

# @smthrs/platform-node

The Node.js Host bundle: one layer that provides all five tags in the closed host list, backed by `@effect/platform-node`.

`@effect/platform-node` already ships `FileSystem`, `Path`, `ChildProcessSpawner`, and an Undici-backed `HttpClient`, so this package adds no implementation of its own: it composes those four with the Node `Jj` adapter from [@smthrs/jj](/api/jj).

There is no shell service. Running a command is Effect's `ChildProcess` / `ChildProcessSpawner`; a wall-clock budget is `Effect.timeout` around the effect, and cancellation is fiber interruption, never an `AbortSignal`. There is no HTTP service either: an outgoing request is Effect's `HttpClient`, provided here as `NodeHttpClient.layerUndici`, which installs no redirect interceptor and so leaves every hop visible to the kernel. See [design decisions](/design-decisions) for why the old `Shell` and `HttpTransport` wrappers were deleted.

```ts
import { NodeHost } from "@smthrs/platform-node"
import * as Effect from "effect/Effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

const program = Effect.gen(function*() {
  const spawner = yield* ChildProcessSpawner
  return yield* spawner.string(ChildProcess.make("printf", ["hello"]))
}).pipe(Effect.provide(NodeHost.layer))
```

:::warning
This entry point is Node-only by construction: it resolves `node:child_process`. `scripts/browser-check.mjs` pins that.
:::

## Entry points

| Import | Source | Platform |
| --- | --- | --- |
| `@smthrs/platform-node` | [src/index.ts](https://github.com/smithersai/flows/blob/main/packages/platform-node/src/index.ts) | Node |
| `@smthrs/platform-node/NodeHost` | [src/NodeHost.ts](https://github.com/smithersai/flows/blob/main/packages/platform-node/src/NodeHost.ts) | Node |

## Exports

| Export | Kind | Notes |
| --- | --- | --- |
| `NodeHost.NodeHost` | type | `FileSystem \| Path \| ChildProcessSpawner \| Jj \| HttpClient` |
| `NodeHost.layer` | layer | the complete closed host surface |
| `NodeHost.NodeChildProcessSpawner`, `NodeHost.NodeFileSystem`, `NodeHost.NodeHttpClient` | re-exports | Effect's own Node adapters, re-exported for selective wiring |

## Conformance

The package runs the shared suite from [`@smthrs/kernel/test/contract`](/api/kernel) twice: once with explicit expectations, and once (`NodeHostDefaults`) taking every default the suite offers, against a loopback HTTP server so the `HttpClient` success path is actually asserted rather than only its refusal.

## Reading next

[@smthrs/kernel](/api/kernel) owns the closed list and decorates these same tags with capability checks. [@smthrs/platform-bun](/api/platform-bun) and [@smthrs/platform-browser](/api/platform-browser) are the sibling bundles.
