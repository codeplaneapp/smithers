# @smthrs/sandbox

Provider-neutral remote process execution and sandbox liveness for flows.
Provider packages adapt their SDK sessions to
`RemoteChildProcessSpawner.Provider`; this package owns the conversion to
Effect's `ChildProcessSpawner` contract and the sandbox health taxonomy.

```sh
pnpm add @smthrs/sandbox
```

## Public API

| Namespace                   | Public exports                                                                                                                                                                                                              |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RemoteChildProcessSpawner` | `ProviderErrorCode` and `ProviderError`, the `Provider` interface/tag with `RemoteProcess`/`RemoteOptions`, and `layer`; scripted-test models `TestScript`, `TestRemoteState`, `TestRemoteProvider`, and `TestRemote.make`. |
| `SandboxHealth`             | `HealthState` (`Healthy` / `Unhealthy`), `UnhealthyReason`, `PingProvider`, deadline-bounded `probe`, the service tag, and `make`, `makeNoop`, `layer`, `layerNoop`.                                                        |

Opening a provider is scoped, so interruption closes the layer scope and runs
the provider's cancellation finalizer. No `AbortSignal` crosses this seam.
Command-supplied stdin streams, additional file descriptors, custom shell
paths, detached processes, and non-default pipeline routing fail with a
`BadArgument` `PlatformError` because the provider contract cannot preserve
their semantics. Output `pipe` / `ignore` / `inherit` dispositions and output
sinks are honored by the adapter.

The package is browser-bundleable: it adapts a provider a caller hands it and
owns no host access of its own. `pnpm run browser` at the repository root pins
that property.

```ts
import { RemoteChildProcessSpawner } from "@smthrs/sandbox"
import { Effect } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

const provider = RemoteChildProcessSpawner.TestRemote.make({
  scripts: { "echo hi": { stdout: "hi" } }
})

const program = Effect.gen(function*() {
  const spawner = yield* ChildProcessSpawner
  return yield* spawner.string(ChildProcess.make("echo", ["hi"]))
}).pipe(Effect.provide(RemoteChildProcessSpawner.layer(provider)))

Effect.runPromise(program)
```

See the [sandbox reference](../../docs/reference/sandbox.md) and the
[kernel reference](../../docs/reference/kernel.md).
