---
title: "API reference"
description: "Every export of @smthrs/platform-bun: the BunHost layers and their refusal, the containment options, the implementation identities, and the BunFileSystem escape hatch."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/platform-bun/docs/api.md"
---

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
This entry point is Node-only in the browser-bundle sense: it falls back to the
`@effect/platform-node` adapters off Bun and so resolves `node:fs`, which puts
it on the repository's `NODE_ONLY` list. It runs on Bun and on Node; what it
does not do is bundle for a browser. `scripts/browser-check.mjs` pins that.
:::

The complete host bundles require jj 0.39.0 or newer. Each bundle builds its jj
layer with one version probe; construction can fail with `JjError`, including
`not_installed` or `unsupported_version`. The contained bundles route that probe
through their process spawner and retire its ledger entry when it exits.

## Entry points

| Import                               | Source                                                                                                                             | Platform  |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `@smthrs/platform-bun`               | [src/index.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/platform-bun/src/index.ts)                 | Bun, Node |
| `@smthrs/platform-bun/BunHost`       | [src/BunHost.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/platform-bun/src/BunHost.ts)             | Bun, Node |
| `@smthrs/platform-bun/BunFileSystem` | [src/BunFileSystem.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/platform-bun/src/BunFileSystem.ts) | Bun, Node |

The root entry point exports exactly two names, `BunHost` and `BunFileSystem`,
each the namespace of the module above. `@smthrs/platform-bun/internal/*` and
`@smthrs/platform-bun/*/index` are blocked in the export map;
`@smthrs/platform-bun/package.json` is exported.

Supported runtimes are Bun >=1.3.0 and Node.js >=22.19.0.

## BunHost

The complete closed Host bundle. Four layers, one error, three types, one
identity record, and four re-exports.

### Layers

| Export             | Signature                                                                            |
| ------------------ | ------------------------------------------------------------------------------------ |
| `layer`            | `Layer<BunHost>`                                                                     |
| `layerAt`          | `(root: string) => Layer<BunHost>`                                                   |
| `layerContained`   | `(options?: ContainedOptions) => Layer<BunHost, never, ProcessLedger>`               |
| `layerContainedAt` | `(root: string, options?: ContainedOptions) => Layer<BunHost, never, ProcessLedger>` |

`layer` provides all five Host services, including the runtime-independent
`Path`. `Jj` is bound to the process working directory.

`layerAt` is `layer` with `Jj` bound to `root` instead. `root` must be an
absolute path; see [BunHostError](#bunhosterror).

`layerContained` is `layer` with process containment turned on: every child is
spawned through `@smthrs/kernel`'s `ContainedSpawner`, so it leads a recorded
process group with a `SIGTERM`-then-`SIGKILL` deadline and a `ProcessLedger`
record, and `@smthrs/platform-node`'s `ProcessReaper` sweeps the records a
crashed incarnation left behind while the layer is built. `Jj` is built over
that same spawner (`BunJj.layerSpawner`), so a `jj` a dead host left running is
a ledger record like any other. The `ProcessLedger` requirement is deliberate:
only the program knows whether it has a durable one.

`layerContainedAt` is `layerContained` with `Jj` bound to `root`
(`BunJj.layerSpawnerAt`). It refuses a root exactly as `layerAt` does.

### BunHostError

```ts
class BunHostError extends Error {
  readonly name: "BunHostError"
  readonly code: BunHostErrorCode
  constructor(options: { readonly code: BunHostErrorCode; readonly message: string })
}

type BunHostErrorCode = "invalid_repository_root"
```

The refusal `layerAt` and `layerContainedAt` throw when `root` is not absolute,
the empty string included. It is thrown rather than failed because a factory
runs while a program composes its layers, where there is no fiber to fail into
and a wrong root is a composition mistake, not a runtime outcome. The check
runs when the factory is called, before any layer exists.

It is this package's class rather than the `Jj` adapter's: a Bun caller
composed `BunHost` and should learn nothing about the adapter behind the `Jj`
slot from an error message. The message names the Bun factory that refused,
never `NodeJj`, and repeats at most 64 code points of the root before reporting
its true length, so a root taken from input cannot flood a log line. Branch on
`code`; the message is for a person.

### Models

| Export              | Type                                                                 | Meaning                                             |
| ------------------- | -------------------------------------------------------------------- | --------------------------------------------------- |
| `BunHost`           | `FileSystem \| Path \| ChildProcessSpawner \| Jj \| HttpClient`      | The closed Host service union this bundle provides. |
| `BunHostErrorCode`  | `"invalid_repository_root"`                                          | The stable codes a factory refuses with.            |
| `ContainedOptions`  | `Omit<ContainedSpawner.Options, "platform"> & ProcessReaper.Options` | What a caller may configure about containment.      |
| `implementationIds` | `Readonly<Record<HostServiceIds[number], string>>`                   | The module actually behind each closed Host slot.   |

`ContainedOptions` carries three fields:

| Field      | Meaning                                                                                                               |
| ---------- | --------------------------------------------------------------------------------------------------------------------- |
| `graceMs`  | Milliseconds between the `SIGTERM` that asks a child to stop and the `SIGKILL` that makes it. Default 2000.           |
| `ownerPid` | The pid the reaper must never signal a group for. Default `process.pid`.                                              |
| `system`   | The operating-system seam the reaper reads liveness and start times through. Default: chosen from `process.platform`. |

`platform` is deliberately not part of it. It decides only whether a command
that names no `detached` option gets a process group of its own, and the
spawner underneath is Effect's Node spawner, which decides that from the real
`process.platform` whatever it is told. A caller-supplied `"win32"` on a POSIX
host could therefore only make the ledger record `pgid: null` for a child that
genuinely leads a group, which `ProcessReaper.reap` then retires as `no-group`
without signalling anything: a durable lie rather than a compile error.

Each factory reads its options when it is called and splits them into the
spawner half and the reaper half, so a field meant for one can never be read by
the other and mutating the object afterwards changes neither layer.

`implementationIds` names the implementation behind each slot rather than the
specifier you import it through, which is why the filesystem entry is
`@smthrs/platform-node/AtomicFileSystem`:

```ts
{
  "effect/FileSystem": "@smthrs/platform-node/AtomicFileSystem",
  "effect/Path": "effect/Path",
  "effect/process/ChildProcessSpawner": "@effect/platform-bun/BunChildProcessSpawner",
  "@smthrs/jj/Jj": "@smthrs/jj/bun/BunJj",
  "effect/HttpClient": "@effect/platform-bun/BunHttpClient"
}
```

The keys are written as literals rather than `HostServiceIds` positions, so
reordering the closed list cannot silently pair a slot with another slot's
implementation. Nothing digests the record yet: [`@smthrs/plan`](https://plan.smithers.sh/reference/api/)'s
step key carries a `layers` component these values are meant to feed, but no
planner derives it from a host bundle today, so changing one invalidates no
cached step.

### Re-exports

`BunHost` re-exports four modules so a program that should reach only part of
the host has one place to take it from:

| Export                   | What it is                                                                      |
| ------------------------ | ------------------------------------------------------------------------------- |
| `AtomicFileSystem`       | `@smthrs/platform-node/AtomicFileSystem`, the filesystem implementation itself. |
| `BunChildProcessSpawner` | `@effect/platform-bun/BunChildProcessSpawner`.                                  |
| `BunFileSystem`          | This package's `BunFileSystem` module.                                          |
| `BunHttpClient`          | `@effect/platform-bun/BunHttpClient`.                                           |

`AtomicFileSystem` is in the set for the same reason `NodeHost` re-exports it:
it owns the only configuration escape hatch the filesystem slot has, and a Bun
program whose python3 is not at `/usr/bin/python3` must reach
`AtomicFileSystem.layerWith` without adding
[`@smthrs/platform-node`](https://platform-node.smithers.sh/reference/api/) as a second dependency.

`BunJj` is deliberately absent. It belongs to [`@smthrs/jj`](https://jj.smithers.sh/reference/api/) and is
imported from there, never re-exported here.

## BunFileSystem

The filesystem slot on its own.

| Export      | Signature                                 | Meaning                                                                                        |
| ----------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `layer`     | `Layer<FileSystem>`                       | The filesystem slot, carrying the kernel's atomic host extension. Is `AtomicFileSystem.layer`. |
| `layerWith` | `(options: Options) => Layer<FileSystem>` | The same filesystem against an explicitly configured interpreter and byte limits.              |
| `Options`   | `AtomicFileSystem.Options`                | The interpreter, concurrency ceiling, timeout, and byte limits `layerWith` accepts.            |

`layer` is `@smthrs/platform-node`'s `AtomicFileSystem.layer`, the same value
behind `NodeHost`'s filesystem slot, by identity and not by resemblance.

`layerWith` is the escape hatch for a host whose python3 is not at
`/usr/bin/python3`, such as an alpine or nix image. `executable` is
re-validated per request, because the file it names can be replaced while the
host runs; everything else is snapshotted when the layer is built.

## Shell and HTTP

There is no shell service, and no runtime detection either, because Bun's
spawner _is_ the Node one. The old `Shell` wrapper and its hand-rolled
`Bun.spawn` detection were deleted together.

There is no HTTP service either. `BunHost` provides
`@effect/platform-bun`'s fetch-backed `HttpClient` with
`RequestInit { redirect: "manual" }`, so the runtime never walks to a second
origin behind the capability kernel's back. Following a redirect is
[@smthrs/kernel](https://kernel.smithers.sh/reference/api/)'s guarded `HttpClient.layer`, which rechecks
every hop.

## Filesystem

`BunFileSystem.layer` is [@smthrs/platform-node](https://platform-node.smithers.sh/reference/api/)'s
`AtomicFileSystem.layer`, the same layer behind `NodeHost`'s filesystem slot.
Under [@smthrs/kernel](https://kernel.smithers.sh/reference/api/)'s `FileSystem.layer` every guarded path
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
a root that is not absolute, the empty string included, by throwing
`BunHost.BunHostError` with `code: "invalid_repository_root"` when the factory
is called. The error is this package's: its message names the Bun factory that
refused, never the adapter behind the `Jj` slot, and repeats at most 64
characters of the root. Branch on `code`, never on the message.

## Conformance

The package runs the shared suite from
[`@smthrs/kernel/test/contract`](https://kernel.smithers.sh/reference/api/) against `BunHost.layerAt`, with a
loopback server behind the HTTP probes so the success path is asserted rather
than only connection refusal. That server is mandatory: a bind failure fails the
file rather than quietly falling back to the closed-port probe, which would
report green while asserting nothing about the HTTP success path.

Every suite here executes under Node. The `//packages/smithers/flows/platform-bun:bunTest`
target re-runs these files through Bun's package runner (`bun x vitest`, with no
`--bun`), but the
`vitest` bin that resolves to is a `/bin/sh` shim, and every branch of it
`exec`s `node`, so that lane is Node as well. Executing this suite on the Bun
runtime is tracked work; nothing below should be read as a claim about it.

Process spawning is literally the same module on both runtimes, so there is no
Bun-only spawn path left to fake. The filesystem is not: its no-follow extension
runs every guarded operation in a CPython 3 subprocess rather than in-process, so
a guarded read, write, rename, and one symlink refusal run here against the
adapter this bundle actually installs. The byte ceilings, the Unicode matrix, and
the full refusal matrix are not restaged; they already run against the
byte-identical module in
[@smthrs/platform-node](https://platform-node.smithers.sh/reference/api/).

Containment is driven over real processes rather than doubles: a group a dead
incarnation abandoned is reaped while the layer is built, a child that ignores
`SIGTERM` is ended by the `graceMs` escalation, and a `jj` invocation appears in
the ledger like any other child, which is what proves `layerContainedAt` routes
`jj` through the contained spawner instead of around it.

## Reading next

[@smthrs/kernel](https://kernel.smithers.sh/reference/api/) owns the closed list and decorates these same tags
with capability checks. [@smthrs/platform-node](https://platform-node.smithers.sh/reference/api/) and
[@smthrs/platform-browser](https://platform-browser.smithers.sh/reference/api/) are the sibling bundles.
[The Host surface on Bun](/concepts/host-surface/) explains what each slot
buys, and [Troubleshooting](/troubleshooting/) lists the failures these
exports produce.
