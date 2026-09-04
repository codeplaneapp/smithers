---
title: "Execution identity"
description: "How the engine decides which run a submission belongs to: caller-supplied execution ids, the joins they make idempotent, the reuses it refuses, and how poll, interrupt, and resume treat an id they do not know."
sidebar:
  order: 2
---

`executionId` is caller-supplied identity, not a handle the server mints. That
one decision explains most of the engine's admission behavior.

## A repeated id joins

A submission that names an id an execution already owns joins that run and
answers with its recorded result. It does not start a second run. This is what
makes a retried submission idempotent: a client that times out, a proxy that
replays a request, and a sweep that resubmits all converge on one execution.

Joining works whether the run is finished or still going. A duplicate submit of
an in-flight id waits on the body that is already running.

When a caller supplies no id at all, the flow uses its declared
`idempotencyKey` when it has one and otherwise asks the ambient execution-id
source. That source refuses by default. A host may explicitly install the
payload-derived source when equal payloads should converge; a flow with an
`idempotencyKey` is content-addressed by construction.

## Two reuses are refused

Answering a caller with a run it did not ask for is worse than failing it, so
two reuses raise `ExecutionIdentityConflict` as a defect:

| `field`     | The reuse                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| `"flow"`    | The id already belongs to a different flow declaration. Answering would hand one flow's value to another flow's schemas. |
| `"payload"` | The id already belongs to a different payload. The recorded result answers the first payload's question, not this one's. |
| `"lineage"` | A durable row with the id belongs to another trampoline lineage.                                                         |
| `"round"`   | A durable row with the id belongs to another round ordinal.                                                              |
| `"parent"`  | A durable row with the id belongs to another predecessor round.                                                          |

Payload identity is structural, not referential. The engine compares the
rebuilt payload snapshots: it recurses through the plain objects and arrays the
schema declares and compares every leaf, and it compares declared-opaque values
by reference, because a reference is exactly what the schema said the value
was.

The same conflict guards `deferredDone`: a deferred addressed to one flow
cannot complete an execution that belongs to another.

## The id is a trust boundary

Because clients supply it, an id is only as namespaced as the server makes it.
Two tenants that both submit `report-1` are one execution unless something
separates them. A server that accepts execution ids from more than one
principal namespaces them in one place:
[Namespace execution ids per tenant](../guides/namespace-execution-ids.md).

## Unknown ids: failure, or silence

The three read-and-control operations disagree about an unknown id on purpose:

- `poll` fails with `FlowRuntime.FlowExecutionNotFound` for an id no engine
  knows. It answers `Option.none()` for a known execution that has not settled,
  and also for an execution belonging to a different flow declaration: from
  this flow's view that run has no result.
- `interrupt`, `interruptUnsafe`, and `resume` treat an unknown id as a silent
  no-op. Each is a request, each is idempotent, and a reaped or mistyped run
  has nothing left to cancel or re-drive.

## Parent and child executions

A flow that opens an explicit child boundary creates a second execution with
its own id, derived from the parent, the plan node, the callee, and the
payload, so replaying the parent's body re-derives the same child id and the
child runs once.

The engine records the parent edge for every child request, including a fan-in
that joins an existing execution, and refuses a request that would close a
cycle with `FlowRuntime.FlowCycleDetected` carrying the path it walked.
Recording the edge rather than a single parent field is what catches a
second-parent cycle in which two runs would otherwise join each other forever.

## Related

- [Step identity](./step-identity.md) is the other identity in the system: it
  names one dispatch inside a run.
- [Trampoline rounds](./trampoline-rounds.md) explains why one `execute` call
  can span several execution ids.
