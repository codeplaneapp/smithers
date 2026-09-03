# @smthrs/sandbox

Provisioned machines, provider-neutral remote process execution, and sandbox
liveness for flows. A provider package adapts its SDK session to one of two
seams: `RemoteChildProcessSpawner.Provider`, which can only run a command line,
or `Sandbox.Provider`, which owns a machine's whole lifecycle and its
filesystem. This package derives Effect's host services, two conformance
suites, health, and supervision from those seams, and ships nine machine
providers built on them.

```sh
pnpm add @smthrs/sandbox
```

## Public API

Every namespace below is also its own import subpath.

{/* generated:sandbox-namespaces start */}

| Namespace                   | Import                                      | What it is                                                                |
| --------------------------- | ------------------------------------------- | ------------------------------------------------------------------------- |
| `RemoteChildProcessSpawner` | `@smthrs/sandbox/RemoteChildProcessSpawner` | Remote implementation of Effect's `ChildProcessSpawner`.                  |
| `ProviderConformance`       | `@smthrs/sandbox/ProviderConformance`       | The conformance suite a provider implementation must pass.                |
| `Sandbox`                   | `@smthrs/sandbox/Sandbox`                   | The provisioned-machine contract and its projections.                     |
| `SandboxConformance`        | `@smthrs/sandbox/SandboxConformance`        | The conformance suite a sandbox session provider must pass.               |
| `DirectorySandbox`          | `@smthrs/sandbox/DirectorySandbox`          | The scratch-directory sandbox provider.                                   |
| `ContainerSandbox`          | `@smthrs/sandbox/ContainerSandbox`          | The container-lifecycle sandbox provider, over a Docker-compatible CLI.   |
| `KubernetesSandbox`         | `@smthrs/sandbox/KubernetesSandbox`         | The Pod-per-session sandbox provider, over `kubectl`.                     |
| `JustBashSandbox`           | `@smthrs/sandbox/JustBashSandbox`           | The in-process interpreter sandbox provider, for hosts that cannot spawn. |
| `MicrosandboxSandbox`       | `@smthrs/sandbox/MicrosandboxSandbox`       | The Microsandbox microVM provider.                                        |
| `VercelSandbox`             | `@smthrs/sandbox/VercelSandbox`             | The Vercel Sandbox provider.                                              |
| `DaytonaSandbox`            | `@smthrs/sandbox/DaytonaSandbox`            | The Daytona sandbox provider.                                             |
| `AwsSandbox`                | `@smthrs/sandbox/AwsSandbox`                | The AWS ECS task provider.                                                |
| `CloudflareSandbox`         | `@smthrs/sandbox/CloudflareSandbox`         | The Cloudflare Durable Object provider.                                   |
| `SandboxHealth`             | `@smthrs/sandbox/SandboxHealth`             | Sandbox health-check contracts.                                           |
| `SandboxSupervision`        | `@smthrs/sandbox/SandboxSupervision`        | Heartbeat supervision over a remote sandbox session.                      |

{/* generated:sandbox-namespaces end */}

Opening a provider is scoped, so interruption closes the layer scope and runs
the provider's cancellation finalizer. No `AbortSignal` crosses this seam.
`Provider.kill` and `Provider.ping` are optional: a provider that implements
them can stop one command without tearing down its session and can be
supervised, and a provider that omits them keeps the narrower contract.
Standard input is not optional. A provider that declares `stdin: true` receives
a command's input collected whole; a provider that does not is handed an
input-fed command's refusal instead, so the bytes are never silently dropped.
Additional file descriptors, `stdin: "inherit"`, custom shell paths, detached
processes, and non-default pipeline routing fail with a `BadArgument`
`PlatformError`, because the provider contract cannot preserve their semantics.
Output `pipe`, `ignore`, and `inherit` options and output sinks are
honored by the adapter.

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

A `Sandbox.Provider` goes further: `acquire` hands back one held machine with
byte-typed file transfer beside the same spawn, and `Sandbox.layerHost` places
`ChildProcessSpawner`, `FileSystem`, `Path`, and `SandboxHealth` on it, which
is the host surface an agent's standard tools consume.

```ts
import { ContainerSandbox, Sandbox } from "@smthrs/sandbox"

const provider = ContainerSandbox.make({ spawner, image: "node:22", network: "none" })
const host = Sandbox.layerHost(provider, { session: "run:01J..." })
```

A provider that can be pinged can also be supervised. `SandboxSupervision`
probes the open session on a cadence and retires it when the probe says it is
dead, so the commands running in it fail instead of waiting forever and a
retry policy lands the work on a fresh session:

```ts
import { SandboxSupervision } from "@smthrs/sandbox"

const supervised = SandboxSupervision.layer(provider, { interval: "10 seconds", tolerance: 2 })
```

Provider packages prove their adapter with `ProviderConformance.check` or, for
a lifecycle provider, `SandboxConformance.check`. Both run the contract as
behavior through the real adapter layer and report every check that did not
hold. `signals-a-running-command` watches the process rather than the call: a
`kill` that answers success and leaves the command running satisfies the type
and leaks a process for every cancelled action, so the check waits
`Commands.stopsWithin` for the command to stop and names it when it does not.

## Limits

{/* generated:sandbox-limits start */}

Two things here are bounded and the rest is sized by the host's heap. A caller
placing an agent's file tools on a machine should know which is which.

| Path                                    | Bound                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a command's standard input              | 16 MiB, refused above it. The count runs as the bytes arrive, so an oversized or endless producer is stopped at the bound rather than after it finishes                                                                                                                                                                                                                                                                                                                                                     |
| the signal a closing scope sends        | 5 seconds, or however long it takes the command's exit to be observed, whichever comes first. A finalizer cannot be interrupted, so a provider whose `kill` never answers would hold the closing fiber open forever; the provider's own teardown sends it again. `string` and `lines` close the scope when the output ends rather than when the exit lands, so the exit observation is what keeps a command that already finished from costing its caller the whole bound                                   |
| `Session.readFile`, `Session.writeFile` | none. A file crosses whole, in memory, on every provider                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| a command's `stdout` and `stderr`       | none. `RemoteChildProcessSpawner` and the probe helpers collect a command's output whole                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `Sandbox.fileSystem.readDirectory`      | none, and a listing is materialized twice: once as probe output and once as the parsed entries                                                                                                                                                                                                                                                                                                                                                                                                              |
| `AwsSandbox` command output             | none, and buffered whole by construction: the Session Manager channel carries one session's output as a single stream that is parsed after it ends                                                                                                                                                                                                                                                                                                                                                          |
| `AwsSandbox` file writes                | one remote `aws ecs execute-command` round trip per `ExecTransport.chunkBytes` bytes (default 3072 before base64). A 64 MiB write at the default is roughly 22,000 sequential invocations. The enforced range is 1 through 65536 bytes. Each slice is base64 inside one `--command` argv entry; base64 expands by four thirds, and Linux caps one entry at 128 KiB (`MAX_ARG_STRLEN`, 32 pages), so 64 KiB plus framing stays inside the smallest known limit. AWS publishes no separate SSM document limit |

Command output is byte-exact through `DirectorySandbox`, `ContainerSandbox`,
`KubernetesSandbox`, `MicrosandboxSandbox`, and `JustBashSandbox`. It is not
through `VercelSandbox`, `DaytonaSandbox`, or `CloudflareSandbox`, whose vendor
APIs report a command's output as a string: what those providers stream is that
string re-encoded as UTF-8, so a command writing a tarball or a compiled binary
to stdout comes back changed. `AwsSandbox` reframes output through a
pseudo-terminal, which normalizes line endings and interleaves standard error.
File transfer is byte-exact on all nine, so a caller that needs bytes out of a
command has it write a file and reads that back with `readFile`.

{/* generated:sandbox-limits end */}

See the [sandbox reference](https://smithers.sh/api/sandbox) and the
[kernel reference](https://smithers.sh/api/kernel).
