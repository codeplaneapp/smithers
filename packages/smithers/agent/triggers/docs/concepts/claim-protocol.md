---
title: "The claim protocol"
description: "How two hosts polling the same trigger fire one occurrence once: revision fencing, launch reservations and their lease, the outcomes a result records, and the two watermarks that decide what is due."
sidebar:
  order: 3
---

Run two hosts against one database and both will notice the 03:00 boundary. The
claim protocol is how exactly one of them launches it, and how the other one
finds out.

Every rule below lives in the store, not in the scheduler. That placement is the
design: a decision made inside the claim transaction cannot be made against a
snapshot that has since gone stale.

## The store is asked for candidates, not for due work

`TriggerStore.listEnabled` returns the enabled triggers, and nothing more.
Due-ness is a cron computation the scheduler performs against its own watermark,
so there is no due-time query to keep in sync with the policy logic, and no
index whose staleness could hide a trigger.

## A claim is fenced on a revision

`claimFire` carries the occurrence and the revision the occurrence was computed
from:

```ts
import * as TriggerStore from "@smthrs/triggers/TriggerStore"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"

const claimOne = (
  store: TriggerStore.Service,
  trigger: TriggerStore.Registered,
  occurrence: number
) =>
  Effect.gen(function*() {
    const claim = yield* store.claimFire({
      triggerId: trigger.id,
      occurrence,
      expectedRevision: trigger.revision
    })
    if (!claim.claimed) return Option.none()
    if (claim.action === "fire" || claim.action === "supersede") {
      return Option.some(claim.reservationId)
    }
    yield* store.recordResult({
      triggerId: trigger.id,
      occurrence,
      outcome: claim.action === "skip" ? "skipped" : "buffered"
    })
    return Option.none()
  })
```

Note what the request does not carry: an overlap policy, a flow id, or an
input. The transaction reads `enabled`, `revision`, and `overlap` from the
trigger row itself, so a caller holding a snapshot from before an edit cannot
fire a trigger that has since been disabled, cannot point it at a different
flow, and cannot supersede a run the stored declaration says to leave alone.

Three refusals come out of that read, and each names one thing to do:

| Failure             | Meaning                                                                              |
| ------------------- | ------------------------------------------------------------------------------------ |
| `unknown_trigger`   | No such row. Every method addressing one trigger reports this, except `clearActive`. |
| `trigger_disabled`  | The row exists and `enabled` is false.                                               |
| `revision_mismatch` | Somebody re-registered the trigger. Re-read the row and decide again.                |

The scheduler answers `revision_mismatch` by refreshing once and retrying once.
One retry is enough, because the next tick reads again anyway.

## A claim that wins hands back work, or a decision

`Claim` has three shapes, and they are separate on purpose:

```ts
type Claim =
  | { readonly claimed: false }
  | { readonly claimed: true; readonly action: "skip" | "buffer" }
  | {
    readonly claimed: true
    readonly action: "fire" | "supersede"
    readonly reservationId: string
    readonly activeRunId?: string | undefined
  }
```

`claimed: false` means another worker holds this occurrence. A claim that only
records a decision names no reservation, because none was written; a claim that
hands you work to launch always names the reservation it wrote against the
trigger row, so you always have an id to release. There is no shape in which
you can read a reservation id that does not exist.

A `supersede` claim also names `activeRunId`, the run it displaced, so the
caller has something to cancel.

## The reservation and its lease

Between winning a claim and having a run id, a host holds a **reservation**: a
placeholder written into the trigger's active-run column, spelled
`trigger-reservation:<triggerId>:<occurrence>`.

```ts
import * as TriggerStore from "@smthrs/triggers/TriggerStore"

TriggerStore.reservationId("nightly-report", 3_600_000)
// "trigger-reservation:nightly-report:3600000"
TriggerStore.isReservation("run-42") // false
TriggerStore.reservationOccurrence("trigger-reservation:nightly-report:3600000")
// 3600000
```

A reservation is not a run. The runner has never heard of it, so asking whether
it is active answers "no" for a launch that is still in flight. Only its lease
may release it. `TriggerStore.reservationLeaseMs` is 300,000 milliseconds, or 5
minutes, and both store implementations use the same constant so swapping the
in-memory store for the SQL one cannot change recovery timing.

When the lease expires, the store reclaims the reservation and restores its
unfinished occurrence to pending work, whether the expiry is noticed during an
active-run read or during a later claim. That is the recovery path for a process
that died after claiming an occurrence and before launching it. Under
`supersede`, the reservation also retains the predecessor run id, so recovery
re-attaches to that run and cancels it before launching the replacement rather
than leaving two runs alive.

## Results close the loop

`recordResult` reports how one occurrence ended:

| Outcome      | Written when                                                          |
| ------------ | --------------------------------------------------------------------- |
| `launched`   | The runner returned a run id. The reservation is replaced by that id. |
| `completed`  | The run stopped and the host observed it stop.                        |
| `failed`     | The launch or the run failed. The message is kept on the fire row.    |
| `skipped`    | The overlap policy dropped the occurrence.                            |
| `buffered`   | The overlap policy remembered the occurrence.                         |
| `superseded` | A newer occurrence replaced this one.                                 |

A terminal result clears the active run only when it names the run that owned
it. A late result with no run id is fenced to the run recorded for its own
occurrence, so a straggler cannot clear a newer active run.

## Two watermarks, and why both exist

**`lastFiredAt` is durable and only moves forward.** It is the cursor catch-up
resumes from. A completed skip or buffer advances it inside the claim
transaction; a fire or supersede does not advance it until the launched run id
is durable. Every update takes the greater of the stored value and the new
occurrence, so an older run settling after a newer occurrence was skipped cannot
drag it backwards and replay settled work.

**The scheduler's watermark is per process and advances only past dispatched
work.** It moves to the boundary the tick reached, but only past occurrences the
tick finished dispatching. A claim or a dispatch that failed leaves its
occurrence available to a later poll, which is what stops a transient store
failure from silently losing a boundary.

The two are different questions. `lastFiredAt` answers "what does this trigger
owe after downtime". The in-process watermark answers "what has this process
already handled since it started", and a fresh process has none, which is why
first sight of a trigger establishes one instead of firing from it.

## Both stores obey this contract

`SqlTriggerStore` and the in-memory `TestTriggers` store share a conformance
suite: the same refusal codes, the same claim decisions, the same lease timing,
the same watermark rules. A test that swaps one for the other is testing the
same protocol. See [Test trigger code](../guides/testing.md).
