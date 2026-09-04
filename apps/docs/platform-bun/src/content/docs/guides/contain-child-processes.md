---
title: "Contain and reap child processes"
description: "Compose BunHost.layerContained with a ProcessLedger so every child leads a recorded process group with a kill deadline, and a crashed host's abandoned groups are swept by the next incarnation."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/platform-bun/docs/guides/contain-child-processes.md"
---

`BunHost.layer` spawns children the way Effect does: a child is bound to the
scope that spawned it and dies when that scope closes. That is enough while the
host is alive, and nothing at all after it crashes, because a dead process runs
no finalizer. The children it started keep running, nobody remembers them, and
the next incarnation cannot tell them from anyone else's processes.

`BunHost.layerContained` closes that hole with three mechanisms.

## What containment adds

**An escalation deadline.** Every spawn goes through
[`@smthrs/kernel`](https://kernel.smithers.sh/reference/api/)'s `ContainedSpawner`, which rewrites the
command so releasing it cannot hang: the child is asked to stop with `SIGTERM`,
and is made to stop with `SIGKILL` `graceMs` later. A command that already
names its own `killSignal` or `forceKillAfter` is left alone, because it has an
owner who thought about it.

**A durable record.** Each child is recorded in a `ProcessLedger` when it
starts and released when it ends, so a host that dies without running a
finalizer leaves a record its next incarnation can act on. The record carries
the pid, the process group, the host identity, the pid of the incarnation that
started it, and the instant it started.

**A sweep on the way up.** While the layer is built,
[`@smthrs/platform-node`](https://platform-node.smithers.sh/reference/api/)'s `ProcessReaper` reads the
records a previous incarnation of the same `hostId` left behind and signals the
groups they name. The reaper lives in the Node package because the calls it
makes, `process.kill` and `taskkill`, are Node's, and Bun implements them
unchanged.

## Compose it

The ledger is a layer requirement rather than a built-in default, because only
your program knows whether it has a durable one:

```ts
import * as ProcessLedger from "@smthrs/kernel/ProcessLedger"
import { BunHost } from "@smthrs/platform-bun"
import * as Layer from "effect/Layer"

const host = BunHost.layerContainedAt("/srv/repositories/app", {
  graceMs: 2_000,
  ownerPid: process.pid
}).pipe(
  Layer.provide(ProcessLedger.layerMemory({ hostId: "worker-a", ownerPid: process.pid }))
)
```

`ProcessLedger.layerMemory` records nothing durably. A host built on it still
contains the children it holds handles for, because scope closure does that,
but it inherits nothing from a previous incarnation, so the reaper has nothing
to sweep. Use it in tests and in short-lived programs.

`ProcessLedger.layer` writes through a [`@smthrs/journal`](https://journal.smithers.sh/reference/api/)
`Journal`, which is what makes the durable half real. Give two incarnations the
same `hostId` and the second inherits the first's unreleased records.

## The options both contained factories take

`BunHost.ContainedOptions` is the containment configuration plus the reaper's:

| Field      | Meaning                                                                                                               |
| ---------- | --------------------------------------------------------------------------------------------------------------------- |
| `graceMs`  | Milliseconds between the `SIGTERM` that asks a child to stop and the `SIGKILL` that makes it. Default 2000.           |
| `ownerPid` | The pid this host must never signal a group for, so it cannot kill itself. Default `process.pid`.                     |
| `system`   | The operating-system seam the reaper reads liveness and start times through. Default: chosen from `process.platform`. |

Each factory reads the options when you call it, not when the layer is built,
and splits them into the two halves so a field meant for one can never be read
by the other. Mutating the object you passed afterwards changes neither layer.

## Why there is no `platform` option

`ContainedSpawner.Options` has a `platform` field. `ContainedOptions` omits it,
deliberately.

`platform` decides one thing: whether a command that names no `detached` option
gets a process group of its own. The spawner underneath is Effect's Node
spawner, which decides that from the real `process.platform` whatever it is
told. So a caller-supplied `"win32"` on a POSIX host could not change what the
kernel does; it could only make the ledger record `pgid: null` for a child that
genuinely leads a group. `ProcessReaper.reap` retires such a record as
`no-group` without signalling anything, so the orphan would outlive every
incarnation.

That is a durable lie rather than a compile error, which is why the field is
gone from the type instead of documented as unsupported. The package's suite
pins it: a caller that casts `platform: "win32"` back in still gets a record
whose `pgid` is the child's real process group.

## `jj` is contained too

Under `BunHost.layer`, the `Jj` slot spawns the jj CLI through
`node:child_process` directly. A jj child therefore leads no group the host
recorded, appears in no ledger, and outlives the host that ran it.

`layerContained` and `layerContainedAt` build `Jj` over the contained spawner
(`BunJj.layerSpawner` and `BunJj.layerSpawnerAt`) rather than around it, so a
`jj` invocation is a ledger record like any other child:

```ts
import { Jj } from "@smthrs/jj"
import * as Effect from "effect/Effect"

// The ledger records "jj status" while this runs, and retires it when the
// invocation ends.
const status = Effect.flatMap(Jj, (jj) => jj.status()).pipe(
  Effect.provide(host),
  Effect.scoped
)
```

That is the observable difference the package's integration suite drives, with
a `jj` shim installed on `PATH` so the record is asserted rather than assumed.

## What the reaper refuses to kill

A record is not a licence to signal. `ProcessReaper.reap` re-checks each
inherited record and declines when the numbers do not clearly name an
abandoned process: the owning incarnation is still alive, the record names this
host's own group, the pid is gone, the pid exists but did not start when the
record says it did, the record predates the machine's boot, or the host could
not ask the question at all.

Three of those refusals leave the record inherited rather than retiring it:
`owner-alive`, `identity-unverified`, and `own-group-unknown`. A host that
could not ask, or that has no business signalling, must not be the one that
closes the question. A later incarnation that can ask gets the chance.

## Related

- [Bind the host to a repository root](/guides/bind-a-repository-root/): what
  `layerContainedAt` adds beyond containment, and the refusal it throws.
- [Quickstart](/quickstart/): a runnable version of the composition above.
