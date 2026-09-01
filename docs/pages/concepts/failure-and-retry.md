---
description: "Flow outcomes, action attempts, retry policy, error boundaries, sagas, and the waits that are not failures."
---

# Failure and retry

This page describes the retry and terminal-failure rules implemented by flows, actions, run ownership, and time-travel recovery. It does not define a flow-wide graph failure scheduler, which is planned.

## Flow outcomes

A handler completes with an encoded success or expected failure, or returns `Flow.Suspended`. The durable engine persists the decision and updates the run row. A suspended run may be resumed explicitly, by deferred completion, by a clock, or by completion of an attached child flow.

`Flow.SuspendOnFailure` can convert a handler failure into suspension. `Flow.CaptureDefects` controls whether defects are captured into the flow result. These references should be set centrally; changing them between replays changes runtime policy.

## Action attempts

Each durable attempt is addressed by:

```text
(runId, Sha256(stepKey), attempt)
```

`Action.retry` increments `Action.CurrentAttempt` and delegates scheduling to Effect:

```ts
import { Action } from "@smthrs/flow"
const result = yield* Action.retry(
  WriteArtifact,
  { times: 4 }
)
```

The engine claims an attempt row before execution. A previously completed attempt is decoded and replayed. A conflicting active attempt is rejected or suspended according to persisted state; it is not silently run twice.

## Pattern retry

`@smthrs/patterns` `WithRetry` decorates a flow declaration with the retry policy and supplies the Effect that performs it. The option names match `RetryPolicy`, so a pattern policy and an engine policy translate one to one.

```ts
import { WithRetry } from "@smthrs/patterns"

const resilient = WithRetry.withRetry(Publish, {
  attempts: 4,
  backoff: { initialMs: 100, factor: 2, maxMs: 250 },
  nonRetryable: ["examples/Fatal"]
})
```

The delay before attempt `n + 1` is `min(initialMs * factor^(n - 1), maxMs)`, so the ladder above waits 100 ms, 200 ms, then 250 ms. There is no jitter: a declaration built twice describes the same waits. The decorator refuses a backoff it cannot use: `initialMs` must be positive and finite, `factor` at least 1, and `maxMs` at least `initialMs`. A failure whose `_tag` appears in `nonRetryable` ends the sequence on its first occurrence, whatever the attempt budget allows.

`attempts`, `backoff`, and `nonRetryable` all enter the decorated flow's name and key material, so changing a policy produces a different declaration rather than reusing the old one's cached steps.

`WithRetry.retryEffect` performs the retry at the Effect boundary. Fiber interruption is not a typed failure, so cancelling a run never consumes an attempt.

## Error boundaries

`@smthrs/patterns` `TryCatchFinally` composes the three arms an error boundary needs: a protected body, a recovery arm filtered by error schema, and a finalizer.

```ts
import { TryCatchFinally } from "@smthrs/patterns"

const guarded = TryCatchFinally.run(request, {
  try: (request) => publish(request),
  catchErrors: (error) => error._tag === "Timeout",
  catch: (error) => Effect.succeed(retryLater(error)),
  finally: () => releaseLock(request)
})
```

The finalizer runs after success, after recovery, after a failure no handler claimed, and after interruption. A finalizer that fails on its own raises `PatternError { code: "finalizer_failed" }`. A body failure outranks a finalizer failure, so cleanup trouble never hides the reason the body failed.

`TryCatchFinally.make` declares the same boundary as topology: one `Catch` carrying the filter schema, and a finalizer call on both the settled arm and the unhandled arm. The unhandled arm ends in `Node.fail`, which states that the finalizer cleans up and hands the failure back.

## Sagas

A saga answers "the third call failed and the first two already changed the world". `@smthrs/patterns` `Saga` pairs each forward step with the call that undoes it and unwinds in reverse.

```ts
import { Saga } from "@smthrs/patterns"

const booked = yield* Saga.run(order, {
  steps: [
    { id: "hold", action: holdSeat, compensation: releaseSeat },
    { id: "charge", action: chargeCard, compensation: refundCard },
    { id: "ticket", action: issueTicket, compensation: voidTicket }
  ],
  onFailure: "compensate"
})
```

`onFailure` picks what a step failure does to the completed work, and defaults to `compensate`:

| Policy | Behavior |
| --- | --- |
| `compensate` | Unwind, then return `{ compensated: true, failure }` |
| `compensate-and-fail` | Unwind, then re-raise the original failure |
| `fail` | Leave the completed work alone |

`run` registers one scope finalizer per completed step, so the unwind is LIFO and runs on interruption as well as on failure. A compensation that fails does not stop the ones behind it: every failing step id is collected and the run fails `PatternError { code: "compensation_failed" }` naming them, because state left dirty outranks the failure that started the unwind. A compensation that dies counts as a failed compensation, so a defect inside an undo never hides the residue or the failure that started the unwind.

`Saga.make` declares the same shape as topology: one `Catch` per step whose arm calls that step's compensation and re-raises, so the plan lists the compensation calls in reverse order before anything runs.

## Waits that are not failures

A provider that answers `rate_limited` or `quota_exceeded` is not reporting a
defect: it is naming a time to come back. A model-backed step
(`@smthrs/agent/AgentAction`) treats a classified refusal as a wait rather than
an attempt:

- `QuotaPolicy` decides whether the refusal names a deadline and what that
  deadline is, and refuses to park at all beyond its configured ceiling. A
  composition binds it or binds `QuotaPolicy.layerUnclassified()`; there is no
  default.
- The park is a durable suspension under `annotateWaiting({ reason: "quota" })`,
  so a supervisor sees a parked run with a wake time.
- The retry is `Action.retry`, so it runs as a NEW attempt of the same step and
  the step's own correction budget is untouched.

The engine records a provider refusal as the model step's result, which is what
makes a replay free. A capacity refusal is the exception: it says nothing about
the request, so it fails the sealed action instead of being recorded, and no
cache row outlives the window. That floor belongs to the recorder and holds
whichever classifier is composed. `layerUnclassified` opts out of the park, not
out of the floor.

Spending is bounded separately. `@smthrs/agent/Budget` accumulates token usage
across a run's model calls, keyed by each step's content key so a replayed step
counts exactly once, and refuses, warns, or latches before the next call
according to the policy an approved `Envelope.budget` carried.

## Tiers

| Tier | Meaning | Retry rule |
| --- | --- | --- |
| `sealed` | Intended to execute inside a declared hermetic boundary | Cacheable only with hard-boundary evidence and no deviation |
| `compensable` | External state may be restored | Engine records snapshot/diff metadata around the attempt |
| `irreversible` | External state cannot be rolled back safely | Any attempt after attempt one requires an idempotency key |

An irreversible retry without an idempotency key fails with `IrreversibleRetryRequiresIdempotencyKey`. The key may be a string or a caller-owned canonical JSON object.

## Ownership recovery

Runs use a two-stage `claim` then `activate` protocol. Active ownership is fenced by owner identity and heartbeat time. A worker may take over a stale run only with explicit `Ownership.LivenessEvidence`; elapsed wall time alone does not prove that an owner is dead.

The default heartbeat interval is one second and the stale threshold is 30 seconds. These exported values are protocol defaults, not a promise that every deployment can safely infer death at 30 seconds.

## Recovery utilities

`@smthrs/time-travel` exposes one injectable service, `TimeTravel`, and the recovery machinery sits behind it:

- `TimeTravel.rewind` performs a fenced, audited rewind protocol, including the bounded retry that blocks unsafe irreversible reattempts.
- Compensation assesses and invokes registered rollback handlers as part of that protocol.
- Building `TimeTravel.layer` completes or rolls back interrupted rewind audits, except one whose run a live process still holds, so startup recovery is never a call the application makes. A refused audit stays pending for the next build rather than being closed. `TimeTravel.layerWith({ isAlive })` supplies the liveness check; it defaults to `Ownership.leaseLiveness()`.

The service requires boundary records and store integration supplied by the application. The engine does not create all time-travel records automatically today.

## Planned graph policy

Failure policies such as fail-fast, continue independent branches, quarantine a node, and retry a graph sub-tree are **Planned**. Current concurrency uses ordinary Effect composition, so branch failure semantics are the semantics of the chosen Effect combinator.

See [Concurrency](/concepts/concurrency), [Time travel](/concepts/time-travel), and [Determinism and replay](/concepts/determinism-and-replay).
