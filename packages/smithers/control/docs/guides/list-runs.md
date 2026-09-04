---
title: "Find runs and page through them"
description: "List the flows a host can plan and the runs it knows about: the five run filters, the page bounds a listing enforces, the cursor contract, and the two refusals a listing answers instead of guessing."
sidebar:
  order: 2
---

`list` answers two questions under one verb, selected by the request's tag:
what can this host plan, and what runs exist.

## List the flows a host can plan

```ts
const catalogued = yield * control.list({ _tag: "flows" })
const flows = catalogued._tag === "flows" ? catalogued.items : []
// [{ flowId: "ops/Deploy", description: "Deploys one build" }]
```

The items come from the [registry](/api/registry) when it has discovered
anything, and fall back to the runtime's own flow catalog when it has not.
`warnings` carries the registry's discovery diagnostics when a scan produced
any, so a flow that failed to load is visible rather than silently missing.

## List runs

```ts
const listed = yield * control.list({ _tag: "runs", filters: { status: "parked" } })
const runs = listed._tag === "runs" ? listed.items : []
```

Five filters are supported, and they combine:

| Filter        | Selects                                             |
| ------------- | --------------------------------------------------- |
| `runId`       | Exactly one run, read directly rather than scanned. |
| `flowId`      | Runs of one flow.                                   |
| `status`      | Runs in one of the seven `RunStatus` values.        |
| `parentRunId` | The runs one run spawned, forked, or handed off to. |
| `lineageId`   | Every round of one trampoline lineage.              |

Filtering on `runId` is one read. Everything else projects every row, so prefer
`runId` when you already know it: a monitor pays the wide read once a beat, and
so does every `smthrs status <run>`.

`filters.principalId` is on the wire and is refused rather than removed.
rc.0 records no launch principal on a run summary, so there is nothing to
evaluate the filter against, and a caller using it as a tenant restriction
would otherwise receive every run.

## Page through the result

A listing is bounded, always:

| Bound             | Value                                |
| ----------------- | ------------------------------------ |
| Default page size | `ControlSchema.defaultPageSize`, 100 |
| Maximum page size | `ControlSchema.maxPageSize`, 500     |

`nextCursor` is present exactly when more rows follow. Pass it back as
`cursor`:

```ts
import * as Effect from "effect/Effect"

const everyRun = Effect.gen(function*() {
  const control = yield* Control
  const items = []
  let cursor: string | undefined
  do {
    const page = yield* control.list({
      _tag: "runs",
      limit: 200,
      ...(cursor === undefined ? {} : { cursor })
    })
    if (page._tag !== "runs") break
    items.push(...page.items)
    cursor = page.nextCursor
  } while (cursor !== undefined)
  return items
})
```

Only a cursor this listing issued is accepted. A `limit` outside 1 to 500, and
an unparsable cursor, are both refused with `InvalidInput` rather than answered
with a plausible page:

```text
InvalidInput: limit: must be an integer between 1 and 500, received 0
InvalidInput: cursor: must be a cursor this listing returned, received "abc"
```

A zero-sized page used to answer `{ items: [], nextCursor: "0" }`, which is a
cursor a client loops on forever.

## What a summary carries

`RunSummary` is the projection every listing returns. Beyond `runId`,
`flowId`, `status`, `createdAt`, and `updatedAt`:

| Field                                                | Present when                                                                                          |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `planId`, `planDigest`                               | The run was launched from a plan on this plane.                                                       |
| `ownerId`                                            | A process holds the row.                                                                              |
| `parentRunId`, `lineageId`, `roundOrdinal`, `origin` | The run has an ancestor. See [run lineage](../concepts/lineage.md).                                   |
| `waitingReason`                                      | The engine parked the run and named a reason.                                                         |
| `parkedBy`                                           | The park was written under a fence.                                                                   |
| `pendingResume`                                      | A resume has been recorded and no host has taken it up.                                               |
| `steering`                                           | The notification queue answered how many steers are pending.                                          |
| `cancellation`                                       | Somebody or something cancelled the run. See [cancellation attribution](../concepts/cancellation.md). |

`steering.pending` is read from the queue rather than from a column, because
pending is admitted minus promoted and the queue owns both halves. A queue that
cannot answer leaves the field absent, because "not known" is representable and
it is the truth.

Several of these fields are filled in only by the durable runtime, and only
when it shares a database with the engine. See
[Store control state in a database](./durable-storage.md).

## Where to go next

- [Watch a run's events](./watch-a-run.md): the same runs, as they change.
- [Run lineage](../concepts/lineage.md): what `parentRunId` and `lineageId`
  select.
- [`smthrs ps`](/cli/ps) and [`smthrs status`](/cli/status): the operator
  surface over this verb.
