---
title: "Gate work behind an approval"
description: "Take a plan approval before a run starts, and a node approval inside a run that already started: what each gate pins, how a step registers its own request, and what a decision restarts."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/control/docs/guides/approvals.md"
---

Two gates carry an approval, and they are different mechanisms worth keeping
apart. A **plan approval** decides whether a run starts. A **node approval**
decides something inside a run that already started.

Both are decided with the same two verbs, `approve` and `deny`, and both pin
what was reviewed with a digest and an envelope, so a decision cannot be
re-aimed at a different request afterwards.

## Gate the launch: a plan approval

`plan` produces the reviewable card. `run` against an undecided plan starts
nothing and says so:

```ts
import { Control } from "@smthrs/control/Control"
import * as Effect from "effect/Effect"

const gate = Effect.gen(function*() {
  const control = yield* Control

  const card = yield* control.plan({ flowId: "ops/Deploy", input: { build: "v1.4.0" } })

  const launch = {
    _tag: "Plan" as const,
    planId: card.planId,
    digest: card.digest,
    envelope: card.envelope
  }

  // { _tag: "Parked", planId, status: "waiting-approval" }
  yield* control.run({ ...launch, idempotencyKey: "deploy:v1.4.0" })

  // The card carries the exact approval payload, so a reviewer resubmits it
  // unchanged rather than reconstructing authority on the client.
  yield* control.approve(card.approval)

  // Now the same call launches.
  return yield* control.run({ ...launch, idempotencyKey: "deploy:v1.4.0" })
})
```

Deny it instead and the launch refuses with `PlanDenied` rather than parking.
A denied plan cannot be revived: create and approve a new plan.

### What the card pins

`PlanCard.digest` covers the flow id, the decoded input, the envelope, the
deploy-class flag, and the digest of the persisted plan. `nodes` is the keyed
node graph the plan phase produced, and it is part of the digest because
"approve this flow with this input" and "approve this graph of keyed work" are
different promises: a change that re-keys a node changes what will run, and an
approval taken against the old graph must not authorize the new one. A host
that has not built a graph reports an empty one and loses nothing.

`Envelope` is the authority itself: the capabilities, the collaborator flows,
the budget, and the placement being granted.

| Submitted value differs from the stored one | Failure                                                               |
| ------------------------------------------- | --------------------------------------------------------------------- |
| `digest`                                    | `PlanDigestMismatch`, carrying `expected` and `actual`                |
| `envelope`                                  | `EnvelopeMismatch`, compared by canonical bytes rather than key order |

`GrantScope` says how long the grant lasts: `once`, `run`, or `remembered`. The
card defaults to `run`.

## Gate a step: a node approval

A node approval belongs to a run that already exists, and the _step_ registers
it. Nothing outside the run asks for it, so `approve` can only decide a request
a step actually made.

The step's implementation registers the token, reads it, and either proceeds or
parks:

```ts
import * as ControlRuntime from "@smthrs/control/ControlRuntime"
import type * as ControlSchema from "@smthrs/control/ControlSchema"
import { DurableDeferred, FlowRuntime } from "@smthrs/flow"
import * as Effect from "effect/Effect"

const request = (runId: string): Extract<ControlSchema.ApprovalTarget, { readonly _tag: "Node" }> => ({
  _tag: "Node",
  runId,
  requestId: "ship-clearance",
  digest: "ops/Ship:clearance",
  envelope: { capabilities: [], flows: [], budget: {} }
})

const clearance = Clearance.toLayer(({ requestId }) =>
  Effect.gen(function*() {
    const instance = yield* FlowRuntime.FlowInstance
    const runtime = yield* ControlRuntime.ControlRuntime
    const token = yield* Effect.orDie(runtime.registerApproval(request(instance.executionId)))
    if (token.resolved) return token.tokenId
    // The request id is the wake token an operator's tooling matches on.
    yield* FlowRuntime.annotateWaiting({ reason: "approval", token: requestId })
    yield* DurableDeferred.await(clearanceGate)
    return token.tokenId
  })
)
```

`registerApproval` is idempotent. It creates the token on the first attempt and
answers the existing one afterwards, carrying its current `resolved` state, so
the attempt after a decision reads the answer and runs through instead of
asking again. A registration that disagrees with the stored digest or envelope
is refused exactly as `lookupApproval` refuses it.

The complete example, with the two drives around the decision, is
[`examples/src/18-approval-and-signal.ts`](https://github.com/smithersai/smithers/blob/main/examples/src/18-approval-and-signal.ts).

### Decide it from outside the run

```ts
const receipt = yield * control.approve({
  target: request("run-17"),
  scope: "once",
  idempotencyKey: "approve:ship-clearance"
})
```

The node digest is deliberately not the plan's. The two gates are separate
mechanisms, and a run that was never planned still has steps worth gating.

## What a decision does

| Step                           | Plan target                                                   | Node target                                                 |
| ------------------------------ | ------------------------------------------------------------- | ----------------------------------------------------------- |
| Look the token up              | `lookupApproval` refuses an unknown or already-resolved token | same                                                        |
| Install the grant, on approval | `installBulkGrant` with the submitted envelope and scope      | same                                                        |
| Journal the decision           | `control.approval.approved` or `.denied` on `plan:<planId>`   | the same kinds, on the run                                  |
| Resolve the token              | exactly once                                                  | exactly once                                                |
| Restart the run                | nothing to restart                                            | records a resume delegation, journals `control.run.resumed` |

A decision on a node target has to restart the run the ask parked, in this
call: answering without one left the run at `waiting-approval` until a second
call arrived, and a denial the run never learns about decided nothing.

The restart is _recorded_, not performed, and the deciding plane does not claim
the row. See [a resume is a delegation before it is a claim](/concepts/ownership/).

A decision on a run that has already settled answers `Terminal` and decides
nothing, read before the idempotency replay so the answer describes the run
rather than an earlier call.

## Refusals

| Failure              | Cause                                                                    |
| -------------------- | ------------------------------------------------------------------------ |
| `PlanNotFound`       | No plan or node token with this id. Its `message` names the next action. |
| `PlanDenied`         | The plan was denied. Create and approve a new one.                       |
| `PlanDigestMismatch` | The submitted digest is not the stored one.                              |
| `EnvelopeMismatch`   | The submitted envelope is not the stored one.                            |
| `AlreadyResolved`    | This token already carries a terminal decision.                          |
| `RunNotFound`        | A node target names a run this plane cannot find.                        |

`AlreadyResolved` is also the durable evidence that a decision stuck: a second
`lookupApproval` on a decided token refuses rather than answering.

## Where to go next

- [Receipts and idempotency](/concepts/receipts/): why the launch and the
  retry share one key.
- [Ownership, fences, and claims](/concepts/ownership/): what the recorded
  resume reaches.
- [Plan, approve, run on smithers.sh](https://smithers.sh/docs/guides/plan-approve-run/): the same
  gate from the CLI.
