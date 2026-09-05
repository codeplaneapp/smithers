---
title: "Test against the control plane"
description: "Use the deterministic in-memory stack, swap one collaborator at a time, exercise the pure projections with no stack at all, and hold your own runtime to the contract both shipped ones satisfy."
sidebar:
  order: 13
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/control/docs/guides/testing.md"
---

Nothing about the control plane is hard to test, because every nondeterministic
input is a service: the clock, the runtime, the journal, the notification
queue, and the executor. A test swaps the service, not the verb.

## Start with the whole stack

`TestControl.layer` bundles the four collaborators `ControlLive` requires,
already deterministic:

```ts
import { Control } from "@smthrs/control/Control"
import type * as ControlRuntime from "@smthrs/control/ControlRuntime"
import * as TestControl from "@smthrs/control/test/TestControl"
import * as Effect from "effect/Effect"

const Deploy: ControlRuntime.MemoryFlow = {
  flowId: "ops/Deploy",
  description: "Deploys one build",
  deployClass: true,
  envelope: { capabilities: [], flows: [], budget: {} }
}

const stack = TestControl.layer({ flows: [Deploy], now: () => 0 })
```

It provides `Control` together with every collaborator it built:
`ControlRuntime`, the in-memory journal bundle, a notification queue over that
journal, an executor, and an empty registry. Ids are derived from counters, so
`plan-1`, `run-1`, and `fence-1` are stable across runs.

`MemoryOptions` is the whole configuration surface:

| Option      | Effect                                                                    |
| ----------- | ------------------------------------------------------------------------- |
| `flows`     | What the plane may plan. Defaults to the plannable reserved system flows. |
| `now`       | The clock every timestamp reads. Pass `() => 0` for stable output.        |
| `principal` | The identity stamped when a caller names none.                            |

## Swap the executor

`TestControl.layer` takes an executor as its second argument, so a test states
exactly what the engine did:

```ts
import * as ControlExecutor from "@smthrs/control/ControlExecutor"

const launched: Array<string> = []

const executor = ControlExecutor.makeNoop({
  launch: ({ run }) =>
    Effect.sync(() => {
      launched.push(run.runId)
      return "accepted" as const
    })
})

const stack = TestControl.layer({ flows: [Deploy], now: () => 0 }, executor)
```

Each answer in the executor's vocabulary is a distinct composition worth a
test: `pending` releases the row, `accepted` promotes it to `running`, a
`LaunchFailed` settles it as `failed`, and a `CancelTerminal` reconciles the
control row onto the engine's status. See
[Connect an execution engine](/guides/implement-an-executor/).

The default is `ControlExecutor.makeNoop()`, which answers the honest absence
for every method, and _no executor at all_ is a different composition again:
`ControlLive` reads the port optionally, so a plane that starts nothing is a
supported shape rather than a broken one.

## Test the projections with no stack

`classify`, `remedyFor`, `originOf`, `derive`, `expand`, `attribute`, and
`steerItem` are pure functions of their arguments. Enumerate them directly:

```ts
import * as Monitor from "@smthrs/control/Monitor"

expect(Monitor.classify({
  summary: { runId: "run-1", flowId: "ops/Deploy", status: "running", createdAt: 0, updatedAt: 0 },
  events: [{ sequence: 1, kind: Monitor.attemptStartedEventType, runId: "run-1", occurredAt: 0, payload: {} }],
  beatsWithoutProgress: 3,
  stallBeats: 3
})).toBe("wedged-node")
```

Splitting `beatsWithoutProgress` from `stallBeats` is what lets one pure
function serve a monitor that beats every second and one that beats every hour,
and it is what lets a test reach a stall without waiting for one.

## Assert on durable evidence

The plane's promises are visible in the journal, so assert there rather than on
internal state:

```ts
const kinds = yield * control.watch({ runId, follow: false }).pipe(
  Stream.map((event) => event.kind),
  Stream.runCollect
)
expect([...kinds]).toEqual(["control.run.accepted", "control.run.pending"])
```

Use `follow: false`. It ends; the live stream does not.

## Hold your own runtime to the contract

`ControlRuntime.layerMemory` and `SqlControlRuntime.layer` are both held to one
[shared contract suite](https://github.com/smithersai/smithers/blob/main/packages/smithers/control/test/ControlContract.ts).
It is not part of the published tarball, so a third implementation copies it
from the repository and runs it against its own layer. That is what makes
"behaves like the memory runtime" a checkable claim rather than a hope.

## Assert on the refusals too

Several behaviors are refusals, and they carry the sentence an operator reads:

```ts
const error = yield * Effect.flip(control.list({ _tag: "runs", limit: 0 }))
expect(error.issue).toBe("limit: must be an integer between 1 and 500, received 0")
```

`ControlClient.isControlError` narrows an unknown value to the declared union,
derived from the same schema the errors are declared in.

## Where to go next

- [Quickstart](/quickstart/): the smallest complete program on this stack.
- [Troubleshooting](/troubleshooting/): the refusals worth a test of their
  own.
- [Testing flows on smithers.sh](https://smithers.sh/docs/guides/testing-flows/): the same habit,
  one layer down.
