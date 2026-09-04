---
title: "Run a compensable action"
description: "Provide a SnapshotBoundary so an action declared tier compensable can run: what the engine calls and in what order, what each call receives, and what happens when the boundary is missing."
---

An action declared `tier: "compensable"` says its effects can be undone by
restoring the world around it. The engine enforces that claim by running every
attempt inside a snapshot boundary, and it refuses to dispatch the action when
no boundary is in context.

This package declares the service and ships no implementation, because
snapshotting a workspace is a host concern.
[`@smthrs/engine-store`](/api/engine-store) provides one backed by a Jujutsu
repository.

## Provide the boundary

`FlowEngine.SnapshotBoundary` has three members. `snapshot` returns an opaque
handle of your choosing, and the other two receive it back:

```ts
import { FlowEngine } from "@smthrs/engine"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

declare const takeSnapshot: (label: string) => Effect.Effect<string>
declare const restoreSnapshot: (handle: string) => Effect.Effect<void>
declare const diffSnapshot: (handle: string) => Effect.Effect<unknown>

const boundary = Layer.succeed(FlowEngine.SnapshotBoundary)(
  FlowEngine.SnapshotBoundary.of({
    snapshot: ({ key, attempt }) => takeSnapshot(`step ${key} attempt ${attempt}`),
    restore: (handle) => restoreSnapshot(handle as string),
    diff: (handle) => diffSnapshot(handle as string)
  })
)
```

The handle is typed `unknown` at the boundary because the engine never
interprets it. It stores what `snapshot` returned, keyed by the step key, and
hands the same value back.

Every member receives `SnapshotBoundaryOptions`: the flow, the execution id,
the step key, the attempt number, and the action's declared metadata. Key and
attempt together name the exact dispatch, which is what a snapshot label should
carry.

## The order the engine calls them

For a compensable action that fails once and succeeds on the retry, the engine
produces exactly this sequence:

```text
snapshot:1
execute:1
diff:snap:1
restore:snap:2
snapshot:2
execute:2
diff:snap:2
```

Reading it in order:

1. Before each attempt, `snapshot` runs and the handle is stored under the step
   key.
2. The attempt runs.
3. `diff` runs after the attempt settles, on every path, including failure.
4. Before a retry, `restore` runs with the handle from the previous attempt, so
   attempt 2 starts from the world attempt 1 started from.

`restore` runs only when a stored handle for that key exists, so the first
attempt is never preceded by one.

## The refusal

A compensable action dispatched with no boundary in context dies with
`FlowEngine.SnapshotBoundaryRequired`, carrying the action name and the
message `Compensable action "<name>" requires SnapshotBoundary`. The action body
never runs, which is the point: the engine will not perform an effect it has
promised it can undo when it has no way to undo it.

The fix is to provide the boundary, or to change the tier if the action is
genuinely sealed.

## Related

- [Retries and attempts](../concepts/retries.md): the retry decision that turns
  a failed attempt into the `restore` call above.
- [Step identity](../concepts/step-identity.md): where the `key` in the
  boundary options comes from.
