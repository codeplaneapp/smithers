---
title: "Shut a host down"
description: "How NodeRuntime.layerHost handles SIGINT and SIGTERM, what a released run means for the next host, how to set or remove the shutdown deadline, and the exit status a supervisor gets back."
sidebar:
  order: 2
---

`NodeRuntime.layerHost` installs signal handlers so that stopping the process
hands its runs back cleanly instead of stranding them. This guide covers what
that costs you and how to change it.

## What a shutdown does

The handler closes the runtime's own scope. It does not interrupt a fiber, and
that distinction is the difference between a shutdown and a kill: closing the
scope runs the engine's finalizers, the drive fibers are interrupted from inside
the engine, and each run this host owns parks itself `released`.

A released run is reclaimable by the next host that starts. A run left `running`
behind a dead owner is not, at least not until the stale-run sweep notices it
much later. Under `layerHost`, containment also applies: whatever an interrupted
action spawned is signalled and then killed as its process group.

A fiber could not be the handle here anyway. A layer builds in its own fiber,
not the program's, so the fiber this code can reach is not the one your program
runs on.

## Choose the signals

The default is `SIGINT` and `SIGTERM`.

```ts
const host = NodeRuntime.layerHost(
  {
    filename: ".flows/engine.db",
    workspaceRoot: ".",
    owner: { hostId: "worker-1" },
    signals: ["SIGTERM"]
  },
  registerFlows
)
```

An empty list installs no handler at all, for a program that owns its own signal
wiring:

```ts
signals: ;
;[]
```

Every listener the host installs is removed when the scope closes, so a test
that builds and closes a host leaves the process's listener count exactly where
it found it.

Signal names are validated and de-duplicated before any listener is installed.
`SIGKILL` and `SIGSTOP` cannot be caught and are refused, as is any name the
platform does not know. The refusal is a `RuntimeConfigurationError` thrown from
the `layerHost` call, and it fires before the first listener goes on, so a
partial installation is not a state you can reach.

## Set the shutdown deadline

Installing a handler removes Node's default signal behavior, and that has to be
paid for. Without a deadline, a finalizer that never returns would turn `Ctrl-C`
into a program nothing short of `SIGKILL` can stop.

`shutdownTimeoutMs` is how long a graceful shutdown may take before the host
stops waiting and leaves anyway. It defaults to
`NodeRuntime.defaultShutdownTimeoutMs`, which is 30,000 milliseconds, and must
be an integer from 0 through `NodeRuntime.maximumShutdownTimeoutMs`
(2,147,483,647, the largest delay Node accepts without truncating it to a
one-millisecond timer).

```ts
shutdownTimeoutMs: 5_000
```

A shutdown that finishes on time is never held open by its own deadline timer.

There are two escapes from a shutdown that will not finish, and both exist so
the operator is never stuck:

- A second signal leaves immediately, whatever the deadline is set to.
- A shutdown that outlasts the deadline leaves anyway.

## Report the status a supervisor expects

Both escapes exit with the status Node's default behavior would have produced,
which is `128 + signal number`. `NodeRuntime.signalExitCode` computes it, and it
is exported so a program that installs its own handlers can owe its supervisor
the same answer:

```ts
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"

NodeRuntime.signalExitCode("SIGINT") // 130
NodeRuntime.signalExitCode("SIGTERM") // 143
```

## Shut down without signals

Scope closure is the shutdown. A program that composes `layer` or `make` instead
of `layerHost` installs no handlers at all, and closing the scope it built the
runtime in does everything described above:

```ts
import * as Effect from "effect/Effect"

await Effect.runPromise(
  program.pipe(Effect.provide(engine), Effect.scoped)
)
```

That is also what a test should do. Building and closing a scope is the whole
lifecycle; there is nothing else to call.
