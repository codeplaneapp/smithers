---
title: "Inject a real process fault"
description: "Kill a real process and prove the fault landed: the pid helpers, the orphan test, the wall-clock skew, and where a fault suite has to live so it cannot reach a neighbour."
sidebar:
  order: 8
---

`@smthrs/testing/Faults` is not a double. It sends real signals to real pids,
reads what the operating system did with the survivors, and moves the wall
clock a durable timer is measured against.

It is deliberately absent from the root barrel, so the decision is visible at
the import site:

```ts
import { isAlive, killProcess, waitFor, waitForReparent } from "@smthrs/testing/Faults"
```

## Kill a process and prove it died

```ts
await killProcess(engine.process)
```

`killProcess` sends the signal (`SIGKILL` by default) and does not return until
the operating system has reaped the pid. A pid that was already dead is an
**error**, not a no-op: the test that called this believed it was injecting a
fault, and it was not. A suite that "killed" a corpse would report green over a
fault it never caused.

## Wait for the state you are asserting on

A fault landing is asynchronous. `waitFor` polls a predicate until it holds, or
fails with a message naming what it waited for:

```ts
await waitFor(
  () => fixture.marker(markers.secondStarted) !== undefined,
  "the second action to start",
  60_000
)
```

Every helper takes an optional timeout as its last argument.

## Read the orphan a kill leaves behind

Containment claims have to be measured, not assumed. A child whose parent was
killed is reparented, and on macOS and Linux the new parent is pid 1 or a
subreaper:

```ts
const reparented = await waitForReparent(orphan, engine.process.pid!)
```

`waitForReparent` waits because reparenting is not instantaneous: the kernel
moves the child when the old parent is reaped, which is after the signal was
delivered. A suite that reads `parentPid` once races that.

`parentPid(pid)` is the single-shot read, answering `undefined` when the process
is gone. `isAlive(pid)` and `isGroupAlive(pgid)` use signal 0, which performs
the permission and existence check without delivering anything: `ESRCH` is the
only answer that means "gone", while `EPERM` means the process exists and
belongs to somebody else.

`killGroup(pgid)` tears down a whole process group and never throws, because it
is teardown for what a test deliberately orphaned.

## Skew the wall clock

A durable timer is measured against the wall clock, and a test that has to
cross a deadline should move the clock rather than wait:

```ts
import { skewClock } from "@smthrs/testing/Faults"

const clock = skewClock(60_000)
clock.advance(30_000)
clock.restore()
```

`skewClock` patches `Date.now` and a bare `new Date()` **for this process
only**. A child process does not inherit it, which is why a child runner takes
an explicit skew instead. `restore` is idempotent.

## Where a fault suite has to live

Pids, process groups, ports, and the durable database under a fixture are
machine global. A fault suite therefore gets its own tier:

- Put the cases in the package's `test/faults` tree.
- Declare the tier with a `Smithers.FaultSuite` target.
- Give it a `vitest.faults.config.ts` with `fileParallelism: false`, a finite
  `testTimeout`, and coverage disabled, because the work happens in child
  processes this one never instruments.

A case that kills somebody else's engine belongs in that package's fault tree,
not here. This package's own `Faults` suite is the exception and stays in
`test/`: it signals only pids it spawned itself, so it reaches no neighbouring
suite, and staying there is what keeps `src/Faults.ts` inside the package's
100% coverage denominator.

## Admit the run before you claim anything

A kill proves something only if the thing it killed was really running. The
repository's fault cases boot the shipped product against the fixture first,
assert the state they are about to disturb, then inject:

```ts
await probeEngineChild({ ...fixture })

const engine = spawnEngineChild({ ...fixture, mode: "execute" })
await engine.handshake
await waitFor(() => fixture.marker(markers.secondStarted) !== undefined, "the second action to start", 60_000)

expect(fixture.marker(markers.firstDone)).toBeDefined()
expect(fixture.marker(markers.secondDone)).toBeUndefined()

await killProcess(engine.process)
```

Read the durable evidence out of an append-only file the killed process could
not have rewritten, and out of the run's own journal. Anything read from the
killed process is a claim about a process that is gone.

## Related

- [Test tiers](../concepts/test-tiers.md): why this is a separate tier rather
  than a slower unit test.
- [Assert what a run journaled](./assert-a-journal.md): the vocabulary for the
  evidence a resumed run leaves.
