---
title: "Contain child processes"
description: "Compose NodeHost.layerContained with a process ledger so every spawned process gets a kill deadline and a durable record, and a crashed host's orphans are reaped at the next boot."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/platform-node/docs/guides/contain-child-processes.md"
---

Use this when a host spawns long-running children and must not leave them
behind if it dies. Under `NodeHost.layer` a child is signalled when its scope
closes and then waited for, forever if it ignores `SIGTERM`, and a host killed
outright abandons everything it started.

## Choose a ledger

`NodeHost.layerContained` requires a `ProcessLedger` and does not default one,
because the durable half of containment is only as good as the journal
underneath it. The choice belongs to the program that knows which it has.

| Ledger                      | Inherits a crashed incarnation's processes | Requires  |
| --------------------------- | ------------------------------------------ | --------- |
| `ProcessLedger.layer`       | yes                                        | `Journal` |
| `ProcessLedger.layerMemory` | no                                         | nothing   |

`layerMemory` still contains this incarnation: every child gets its deadline.
It simply inherits nothing, so the sweep always finds an empty orphan set.

Both take the same options: `hostId`, the durable identity two incarnations
share, and `ownerPid`, the process id of this one.

## Compose the host

```ts
import * as ProcessLedger from "@smthrs/kernel/ProcessLedger"
import { NodeHost } from "@smthrs/platform-node"
import * as Layer from "effect/Layer"

const host = NodeHost.layerContained({ graceMs: 2000 }).pipe(
  Layer.provide(ProcessLedger.layerMemory({ hostId: "engine-1", ownerPid: process.pid }))
)
```

`host` is a `Layer<NodeHost>`: the same five services `NodeHost.layer` hands
out, spawning through the contained spawner. Swap `layerMemory` for
`ProcessLedger.layer` to get the durable ledger, and provide a `Journal` from
[`@smthrs/journal`](https://journal.smithers.sh/reference/api/) underneath it.

To pin the repository root as well, use `layerContainedAt`:

```ts
const rooted = NodeHost.layerContainedAt("/absolute/repository", { graceMs: 2000 }).pipe(
  Layer.provide(ProcessLedger.layerMemory({ hostId: "engine-1", ownerPid: process.pid }))
)
```

## What building the layer does

Two things happen while the layer is built, in this order:

1. `ProcessReaper.reap` sweeps the records a previous incarnation of the same
   `hostId` left behind, killing the process groups it is willing to signal.
2. The contained services are handed to everything downstream.

So standing a host up is also what cleans up after the incarnation that
crashed. `jj` runs through that same spawner, so a `jj` invocation a crashed
host left running is a ledger record like any other.

## Set the options

`NodeHost.ContainedOptions` has three fields, all optional:

| Field      | Default                          | What it does                                                                                 |
| ---------- | -------------------------------- | -------------------------------------------------------------------------------------------- |
| `graceMs`  | 2000                             | milliseconds between the `SIGTERM` that asks a child to stop and the `SIGKILL` that makes it |
| `ownerPid` | `process.pid`                    | the pid the sweep must never signal, nor signal the group of                                 |
| `system`   | selected from `process.platform` | the operating-system seam the sweep asks its questions through                               |

A command that already names its own `killSignal` or `forceKillAfter` keeps
them: a caller who set one thought about it.

`ContainedSpawner.Options.platform` is deliberately not among these. The
spawner underneath is Effect's, which detaches by the real `process.platform`
whatever a record claims. A caller-supplied `"win32"` on a POSIX host would
record `pgid: null` for a child that really does lead a group, and the reaper
would retire that record as `no-group` and leave the orphan running forever: a
durable lie rather than a compile error.

## Read what the sweep decided

`layerContained` runs the sweep and discards its report. To log the decisions,
call `ProcessReaper.reap` yourself:

```ts
import * as ProcessLedger from "@smthrs/kernel/ProcessLedger"
import * as ProcessReaper from "@smthrs/platform-node/ProcessReaper"
import * as Effect from "effect/Effect"

const sweep = Effect.gen(function*() {
  const decided = yield* ProcessReaper.reap()
  for (const entry of decided) {
    yield* Effect.log(
      entry.killed
        ? `killed ${entry.record.pid}`
        : `kept ${entry.record.pid}: ${entry.refusal}`
    )
  }
}).pipe(Effect.provide(ProcessLedger.layerMemory({ hostId: "engine-1", ownerPid: process.pid })))
```

Each entry carries the record, whether it was killed, and, when it was not, the
`Refusal` that says why. Three refusals leave the record for a later
incarnation to try again: `owner-alive`, `identity-unverified`, and
`own-group-unknown`. The rest are final. See
[Process containment](/concepts/process-containment/) for what each one
means and why the split falls where it does.

## Verify it

The most direct check is to kill a host outright and watch the next one clean
up. Start a host that spawns a detached sleeper, `kill -9` the host process,
confirm the sleeper is still running, then start a host with the same `hostId`
and the same durable journal and confirm the sleeper is gone.

If it is still running, read the refusal. `identity-unverified` and
`own-group-unknown` mean this host has no usable `/bin/ps`; `pre-boot` means
the record was written within two seconds of the machine's boot instant and is
one of the deliberate leaks.
