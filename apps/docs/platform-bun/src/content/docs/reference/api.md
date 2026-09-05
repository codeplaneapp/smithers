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

`@effect/platform-bun` is a required peer at exactly `4.0.0-rc.112` because
this barrel and `BunHost` import it at module load. It is installed alongside
the package by package managers that resolve required peers. The Effect Node
platform packages and `effect` are also exact peers at `4.0.0-rc.112`.

:::warning
This entry point is Node-only in the browser-bundle sense: it falls back to the
`@effect/platform-node` adapters off Bun, so it resolves `node:fs` and the other
`node:` built-ins. It runs on Bun and on Node. What it does not do is bundle for
a browser; a page composes
[`@smthrs/platform-browser`](https://platform-browser.smithers.sh/reference/api/) instead.
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

Supported runtimes are Bun >=1.4.0 and Node.js >=22.19.0.

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

A key is the slot's stable identity in [`@smthrs/kernel`](https://kernel.smithers.sh/reference/api/)'s closed
list, which is not always the specifier the tag is imported from: the spawner
slot is `effect/process/ChildProcessSpawner` while its tag comes from
`effect/unstable/process/ChildProcessSpawner`. The keys are written as literals
rather than positions in that list, so reordering it cannot silently pair a slot
with another slot's implementation. Nothing digests the record yet:
[`@smthrs/plan`](https://plan.smithers.sh/reference/api/)'s step key carries a `layers` component these values
are meant to feed, but no planner derives it from a host bundle today, so
changing one invalidates no cached step.

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
behind `NodeHost`'s filesystem slot, by identity and not by resemblance. It
carries the kernel's atomic host extension, so under
[@smthrs/kernel](https://kernel.smithers.sh/reference/api/)'s `FileSystem.layer` a guarded path operation runs
descriptor-relative and no-follow instead of failing closed, and a symlink
swapped in after authorization cannot redirect it.

That extension executes its syscalls through a CPython 3 helper, which makes an
interpreter a host prerequisite: a `python3` supporting `O_NOFOLLOW`,
`O_DIRECTORY`, and `dir_fd` at `/usr/bin/python3`. Windows is unsupported.

`layerWith` is the escape hatch for a host whose python3 is not at
`/usr/bin/python3`, such as an alpine or nix image. `BunHost` re-exports the
same escape hatch as `AtomicFileSystem`, for parity with `NodeHost`.
`executable` is re-validated per request, because the file it names can be
replaced while the host runs; everything else is snapshotted when the layer is
built.

## Two services the bundle does not wrap

There is no shell service, and no runtime detection either, because Bun's
spawner _is_ the Node one. Running a command is Effect's `ChildProcess` and
`ChildProcessSpawner`, and there is nothing for a detection branch to choose
between.

There is no HTTP service either. `BunHost` provides `@effect/platform-bun`'s
fetch-backed `HttpClient` with `RequestInit { redirect: "manual" }`, so the
runtime never walks to a second origin behind the capability kernel's back.
Following a redirect is [@smthrs/kernel](https://kernel.smithers.sh/reference/api/)'s guarded
`HttpClient.layer`, which rechecks the capability on every hop.

## Reading next

[@smthrs/kernel](https://kernel.smithers.sh/reference/api/) owns the closed list and decorates these same tags
with capability checks. [@smthrs/platform-node](https://platform-node.smithers.sh/reference/api/) and
[@smthrs/platform-browser](https://platform-browser.smithers.sh/reference/api/) are the sibling bundles.
[The Host surface on Bun](/concepts/host-surface/) explains what each slot
buys, [Runtime parity with Node](/concepts/runtime-parity/) explains how far
the two runtimes are interchangeable, and
[Troubleshooting](/troubleshooting/) lists the failures these exports
produce.
