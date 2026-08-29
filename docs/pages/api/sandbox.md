---
description: "Provider-neutral remote process execution and sandbox liveness, above Effect's ChildProcessSpawner."
---

# @smthrs/sandbox

Provider-neutral remote process execution and sandbox liveness. Provider packages adapt their SDK sessions to `RemoteChildProcessSpawner.Provider`; this package converts them onto Effect's `ChildProcessSpawner` contract and adds the health taxonomy above it.

```ts
import { RemoteChildProcessSpawner } from "@smthrs/sandbox"
import * as Effect from "effect/Effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

const provider = RemoteChildProcessSpawner.TestRemote.make({
  scripts: { "echo hi": { stdout: "hi" } }
})

const program = Effect.gen(function*() {
  const spawner = yield* ChildProcessSpawner
  return yield* spawner.string(ChildProcess.make("echo", ["hi"]))
}).pipe(Effect.provide(RemoteChildProcessSpawner.layer(provider)))
```

The package depends on `@smthrs/kernel`, for `CommandLine.render` alone, and on nothing else in the workspace: a sandbox is one way to satisfy `ChildProcessSpawner`, so it sits above the closed host list rather than inside it. It bundles for the browser, because it only runs the effect a provider hands it.

## Entry points

| Import | Source |
| --- | --- |
| `@smthrs/sandbox` | [src/index.ts](https://github.com/smithersai/smithers/blob/main/packages/sandbox/src/index.ts) |
| `@smthrs/sandbox/RemoteChildProcessSpawner` | [src/RemoteChildProcessSpawner/](https://github.com/smithersai/smithers/tree/main/packages/sandbox/src/RemoteChildProcessSpawner) |
| `@smthrs/sandbox/SandboxHealth` | [src/SandboxHealth/](https://github.com/smithersai/smithers/tree/main/packages/sandbox/src/SandboxHealth) |

## RemoteChildProcessSpawner

| Export | Kind | Notes |
| --- | --- | --- |
| `ProviderErrorCode` | const + type | `aborted`, `timeout`, `unavailable`, `spawn_error`, `unknown`: this seam's own closed set |
| `ProviderError` | class | tagged `@smthrs/sandbox/RemoteChildProcessSpawner/ProviderError` |
| `Provider` | interface + service tag | `session`, scoped `open`, scoped `spawn` |
| `RemoteProcess`, `RemoteOptions` | interfaces | a started remote process (`stdout`, `stderr`, `exitCode`) and the `cwd`/`env` carried across |
| `layer` | layer | a `ChildProcessSpawner` backed by a provider; acquisition is tied to the layer scope |
| `TestScript`, `TestRemoteState`, `TestRemoteProvider` | interfaces | scripted provider fixtures |
| `TestRemote` | const | `make(options?)`, a deterministic scripted provider |

`layer` rejects command-supplied stdin streams, additional file descriptors,
custom shell paths, detached processes, and non-default pipeline routing with a
`BadArgument` `PlatformError`. Those options cannot be represented by the
provider contract and are never silently dropped. Output dispositions and
output sinks are applied by the adapter.

:::warning[Two divergences the error channel cannot report]
`extendEnv` is ignored, because the remote session's ambient environment never
crosses the seam. `isRunning` turns `false` when a caller observes `exitCode`
rather than when the remote process ends. Both are stated in the module header.
:::

## SandboxHealth

| Export | Kind | Notes |
| --- | --- | --- |
| `Healthy`, `Unhealthy` | classes | health states; `Unhealthy.component` is `"sandbox"` |
| `HealthState` | const + type | union schema |
| `UnhealthyReason` | const + type | `unresponsive`, `ping_failed` |
| `PingProvider`, `ProbeOptions`, `Service` | interfaces | probe inputs |
| `probe` | function | one ping under a deadline (5 seconds by default); never fails |
| `SandboxHealth` | service tag | `@smthrs/sandbox/SandboxHealth` |
| `make`, `makeNoop` | constructors | `makeNoop` always reports `Healthy` |
| `layer`, `layerNoop` | layers | |

## Reading next

[`@smthrs/kernel`](kernel.md) owns the closed host list this satisfies a slot of, and the `proc:spawn` check written against the same rendered command line the provider receives. [`@smthrs/run-store`](run-store.md) owns the run-ownership heartbeat that detects a dead engine owner rather than a dead sandbox.
