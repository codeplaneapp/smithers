```ts
import { BunHost } from "@smthrs/platform-bun"
import * as Effect from "effect/Effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

const program = Effect.gen(function*() {
  const spawner = yield* ChildProcessSpawner
  return yield* spawner.string(ChildProcess.make("printf", ["hello"]))
}).pipe(Effect.provide(BunHost.layer))
```

:::warning
`@effect/platform-bun` is a peer dependency, declared optional, that this
barrel and `BunHost` both import at module load. Install it yourself
(`npm install @effect/platform-bun@4.0.0-rc.108`) or the first import fails
with `ERR_MODULE_NOT_FOUND`. Only
`@smthrs/platform-bun/BunFileSystem` resolves without it.
:::

:::warning
This entry point is Node-only by construction: it falls back to the
`@effect/platform-node` adapters off Bun and resolves `node:fs`.
`scripts/browser-check.mjs` pins that.
:::

`BunHost` also re-exports `AtomicFileSystem`, `BunChildProcessSpawner`,
`BunFileSystem`, and `BunHttpClient`, so a program that should reach only part
of the host has one place to take it from.

## Entry points

| Import                               | Source                                                                                                              | Platform  |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | --------- |
| `@smthrs/platform-bun`               | [src/index.ts](https://github.com/smithersai/smithers/blob/main/packages/platform-bun/src/index.ts)                 | Bun, Node |
| `@smthrs/platform-bun/BunHost`       | [src/BunHost.ts](https://github.com/smithersai/smithers/blob/main/packages/platform-bun/src/BunHost.ts)             | Bun, Node |
| `@smthrs/platform-bun/BunFileSystem` | [src/BunFileSystem.ts](https://github.com/smithersai/smithers/blob/main/packages/platform-bun/src/BunFileSystem.ts) | Bun, Node |

Supported runtimes are Bun >=1.3.0 and Node.js >=22.19.0.

## Shell and HTTP

There is no shell service, and no runtime detection either, because Bun's
spawner _is_ the Node one. See [design decisions](/design-decisions) for why the
old `Shell` wrapper and its hand-rolled `Bun.spawn` detection were deleted
together.

There is no HTTP service either. `BunHost` provides
`@effect/platform-bun`'s fetch-backed `HttpClient` with
`RequestInit { redirect: "manual" }`, so the runtime never walks to a second
origin behind the capability kernel's back. Following a redirect is
[@smthrs/kernel](/api/kernel)'s guarded `HttpClient.layer`, which rechecks
every hop.

## Filesystem

`BunFileSystem.layer` is [@smthrs/platform-node](/api/platform-node)'s
`AtomicFileSystem.layer`, the same layer behind `NodeHost`'s filesystem slot.
Under [@smthrs/kernel](/api/kernel)'s `FileSystem.layer` every guarded path
operation therefore runs descriptor-relative and no-follow instead of failing
closed, so a symlink swapped in after authorization cannot redirect the
operation.

That extension executes its syscalls through a CPython 3 helper, which is a host
prerequisite: a `python3` supporting `O_NOFOLLOW`, `O_DIRECTORY`, and `dir_fd`
at `/usr/bin/python3`. A host that keeps python3 elsewhere calls
`BunFileSystem.layerWith({ executable })`, which `BunHost` also re-exports as
`AtomicFileSystem` for parity with `NodeHost`. Windows is unsupported.

## Containment

`BunHost.layerContained` adds process containment: `ContainedSpawner` gives
every child a `SIGTERM`-then-`SIGKILL` deadline and a `ProcessLedger` record,
and `ProcessReaper` sweeps the records a crashed incarnation left behind while
the layer is built. `jj` is built over that same spawner, so a `jj` a dead host
left running is a ledger record like any other. The ledger is a requirement, not
a default: only the program knows whether it has a durable one.

`layerAt` and `layerContainedAt` are the two layers with `Jj` bound to one
absolute repository root rather than the process working directory. Both refuse
a relative root.

## Conformance

The package runs the shared suite from
[`@smthrs/kernel/test/contract`](/api/kernel) against `BunHost.layerAt`, with a
loopback server behind the HTTP probes so the success path is asserted rather
than only connection refusal. The suite runs on both interpreters: the package
vitest lane under Node, which carries the coverage gate, and the
`//ci:platformBun` target, which re-runs the same files under Bun.

Process spawning is literally the same module on both runtimes, so there is no
Bun-only spawn path left to fake. The filesystem is not: its no-follow extension
runs every guarded operation in a CPython 3 subprocess, so whether that helper
starts and answers is a per-runtime question, and a guarded read, write, rename,
and one symlink refusal run here to settle it. The byte ceilings, the Unicode
matrix, and the full refusal matrix are not restaged; they already run against
the byte-identical module in
[@smthrs/platform-node](/api/platform-node).

Containment is driven over real processes rather than doubles: a group a dead
incarnation abandoned is reaped while the layer is built, a child that ignores
`SIGTERM` is ended by the `graceMs` escalation, and a `jj` invocation appears in
the ledger like any other child, which is what proves `layerContainedAt` routes
`jj` through the contained spawner instead of around it.

## Reading next

[@smthrs/kernel](/api/kernel) owns the closed list and decorates these same tags
with capability checks. [@smthrs/platform-node](/api/platform-node) and
[@smthrs/platform-browser](/api/platform-browser) are the sibling bundles.
