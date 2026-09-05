---
title: "Quickstart"
description: "Run a file operation and a command through BunHost.layer, then turn containment on and watch a spawned child enter and leave the process ledger."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/platform-bun/docs/quickstart.md"
---

This quickstart runs one program against the Bun host twice: first on the plain
bundle, then with process containment turned on. By the end you will have
executed a real child process through the host surface and seen its record
appear in, and disappear from, the process ledger.

## Prerequisites

- Bun 1.4.0 or later, or Node.js 22.19.0 or later.
- A CPython 3 interpreter at `/usr/bin/python3`. Confirm it with
  `/usr/bin/python3 --version`. See [Installation](/installation/) if yours
  lives elsewhere.
- A package with the dependencies installed:

```bash
pnpm add @smthrs/platform-bun @effect/platform-bun@4.0.0-rc.112 @smthrs/kernel effect@4.0.0-rc.112
```

## Run a file operation and a command

Create `quickstart.ts`. The program asks for two of the five host services by
tag, and names Bun nowhere:

```ts
import { BunHost } from "@smthrs/platform-bun"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner

  yield* fs.writeFileString("report.txt", "written through the host filesystem\n")
  const readBack = yield* fs.readFileString("report.txt")
  const listed = yield* spawner.string(ChildProcess.make("ls", ["report.txt"]))

  return { listed: listed.trim(), readBack: readBack.trim() }
})

Effect.runPromise(Effect.provide(program, BunHost.layer)).then(console.log)
```

Run it:

```bash
bun run quickstart.ts
```

```text
{
  listed: "report.txt",
  readBack: "written through the host filesystem",
}
```

`BunHost.layer` provided all five slots; the program used two of them. The
other three were built and never asked for.

## Turn containment on

The plain bundle spawns children the way Effect does: a child dies when the
scope that holds it closes. That is enough while the host is alive, and it is
nothing at all after the host crashes, because a dead process runs no
finalizer.

`BunHost.layerContained` closes that hole. It routes every spawn through the
kernel's `ContainedSpawner`, which gives each child a process group, a
`SIGTERM`-then-`SIGKILL` deadline, and a record in a `ProcessLedger` that
outlives the process holding it. The ledger is a layer requirement rather than
a default, because only your program knows whether it has a durable one to
write to.

Create `contained.ts`:

```ts
import * as ProcessLedger from "@smthrs/kernel/ProcessLedger"
import { BunHost } from "@smthrs/platform-bun"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

const program = Effect.gen(function*() {
  const ledger = yield* ProcessLedger.makeMemory({
    hostId: "quickstart",
    ownerPid: process.pid
  })

  const host = BunHost.layerContained({ graceMs: 500 }).pipe(
    Layer.provide(Layer.succeed(ProcessLedger.ProcessLedger)(ledger))
  )

  const duringScope = yield* Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner
    yield* spawner.spawn(ChildProcess.make("sleep", ["30"]))
    return yield* ledger.live
  }).pipe(Effect.provide(host), Effect.scoped)

  return { afterScope: yield* ledger.live, duringScope }
})

Effect.runPromise(program).then((result) => console.log(JSON.stringify(result, null, 2)))
```

Run it:

```bash
bun run contained.ts
```

```text
{
  "afterScope": [],
  "duringScope": [
    {
      "pid": 51234,
      "pgid": 51234,
      "hostId": "quickstart",
      "ownerPid": 51230,
      "startedAtMs": 1756900000000,
      "commandDigest": "sleep 30"
    }
  ]
}
```

Three facts are in that output. The child leads its own process group, so a
signal reaches its descendants and not just it. The record names the
incarnation that started it, which is how a later incarnation tells an
abandoned process from a live one. And the record is gone once the scope
closed, because the child ended with it.

Give it a durable half by swapping `ProcessLedger.makeMemory` for
`ProcessLedger.layer`, which writes through a [`@smthrs/journal`](https://journal.smithers.sh/reference/api/)
`Journal`. Then a crashed host's records survive, and the next incarnation
kills what the last one abandoned while its layer is built.

## Where to go next

- [Contain and reap child processes](/guides/contain-child-processes/):
  the escalation deadline, the reaper, and the options both contained
  factories take.
- [Bind the host to a repository root](/guides/bind-a-repository-root/):
  `layerAt` and `layerContainedAt`, so `Jj` does not inherit the process
  working directory.
- [The Host surface on Bun](/concepts/host-surface/): what each of the five
  slots is, and how to take one service without the other four.
