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
| `SandboxHealth`             | `HealthState` (`Healthy` / `Unhealthy`), `UnhealthyReason`, `PingProvider`, deadline-bounded `probe`, the service tag, and `make`, `makeNoop`, `layer`, `layerNoop`, `fromProvider`, `layerFromProvider`.                   |
| `SandboxSupervision`        | `Options`, `Reporter` and `loggingReporter`, the `SandboxUnhealthy` event, and `make` / `layer` for a spawner that retires a session its probe declares dead.                                                               |
| `ProviderConformance`       | `Commands`, `Violation`, `format`, and `check`: the suite a provider implementation must pass.                                                                                                                              |

Opening a provider is scoped, so interruption closes the layer scope and runs
the provider's cancellation finalizer. No `AbortSignal` crosses this seam.
`Provider.kill` and `Provider.ping` are optional: a provider that implements
them can stop one command without tearing down its session and can be
supervised, and a provider that omits them keeps the narrower contract.
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

A provider that can be pinged can also be supervised. `SandboxSupervision`
probes the open session on a cadence and retires it when the probe says it is
dead, so the commands running in it fail instead of waiting forever and a
retry policy lands the work on a fresh session:

```ts
import { SandboxSupervision } from "@smthrs/sandbox"

const supervised = SandboxSupervision.layer(provider, { interval: "10 seconds", tolerance: 2 })
```

Provider packages prove their adapter with `ProviderConformance.check`, which
runs the contract as behavior through the real adapter layer and reports every
check that did not hold. `signals-a-running-command` watches the process rather
than the call: a `kill` that answers success and leaves the command running
satisfies the type and leaks a process for every cancelled action, so the check
waits `Commands.stopsWithin` for the command to stop and names it when it does
not.

See the [sandbox reference](../../docs/pages/api/sandbox.md) and the
[kernel reference](../../docs/pages/api/kernel.md).
