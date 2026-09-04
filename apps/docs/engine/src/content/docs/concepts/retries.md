---
title: "Retries and attempts"
description: "The engine holds the single retry decision point: how it numbers attempts, where the elapsed-time origin comes from, the four decisions a policy can produce, and what an irreversible action must declare before it may retry."
sidebar:
  order: 4
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/engine/docs/concepts/retries.md"
---

`RetryPolicy` is declared in [`@smthrs/flow`](https://flow.smithers.sh/reference/api/). Deciding what to do
with it is the engine's job, and it happens in exactly one place: after an
action dispatch settles, before its recorded outcome is decoded. Nothing else
in the system classifies a failure as retryable.

## The attempt number

An attempt number starts at 1 and identifies both the attempt row and the rung
of the backoff ladder. It has to survive a process restart, or a resumed run
would sleep the ladder from the beginning and re-dispatch a failure the store
already recorded as terminal.

When the store implements `actionLatestAttempt`, the engine asks it for the
highest persisted attempt for this step key and continues from there whenever
that number is above the one the caller passed. A value that is not a safe
integer is rejected with a warning and the caller's number is used instead.

Without that member the counter is in-process, which is correct for the
in-memory engine and for any store that keeps no attempt rows.

## The elapsed-time origin

A policy's `expirationMs` is a schedule-to-close bound: the whole retry
sequence gives up after that much wall-clock time, however many attempts fit
inside it. Measuring it needs the moment the FIRST attempt started, which the
current process may never have seen.

When a policy declares `expirationMs` and the store implements
`actionRetryOrigin`, the engine asks the store for the persisted start time of
the earliest surviving attempt for this key, and measures from there. Three
answers are possible:

- A usable time. The budget is measured from the true first attempt.
- `Option.none()`, meaning no attempt row survives, usually because retention
  pruning removed them. The engine falls back to the current clock and logs a
  warning, because turning benign pruning into spurious run failures is worse
  than granting a fresh window.
- A time that is not finite, or is in the future. The engine logs a warning and
  starts the budget now.

## The four decisions

When a dispatch settles as a failure and the action declares a policy, the
engine asks the policy for a decision:

| Decision            | What the engine does                                                                                                                                              |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Retry after a delay | Sleeps the delay, increments the attempt, and dispatches again.                                                                                                   |
| Attempts exhausted  | Records a completion whose exit is a `RetryPolicy.RetryAttemptsExhausted` defect carrying the action name, the attempt, the declared maximum, and the last error. |
| Policy expired      | Records a completion whose exit is a `RetryPolicy.RetryPolicyExpired` defect carrying the declared `expirationMs` and the last error.                             |
| Non-retryable       | Falls through and propagates the original failure unchanged.                                                                                                      |

Exhausted and expired are distinguished on purpose. A run that ran out of
attempts and a run that ran out of clock call for different fixes, and the two
defects say which happened.

A settlement that is not a completion, which for the action path means a
suspension, returns immediately. A parked action is not a failed one.

## Irreversible actions must be addressable to retry

An action declared `tier: "irreversible"` may not be retried unless it declares
an `idempotencyKey`. Re-dispatching an irreversible effect that the engine
cannot address is how one charge becomes two, so the engine dies with
`Action.IrreversibleRetryRequiresIdempotencyKey` rather than dispatching.

The refusal is raised twice on purpose: before a dispatch whose attempt number
is already above 1, which catches a restart that resumed into a retry, and
before following a policy's retry decision.

## Compensable actions retry against a snapshot

An action declared `tier: "compensable"` runs inside a snapshot boundary. The
engine snapshots before each attempt, diffs after each one, and restores the
previous snapshot before a retry, so attempt 2 starts from the world attempt 1
started from. See
[Run a compensable action](/guides/compensable-actions/).

## What is not a retry

Two other things bound work, and neither is this decision point:

- A flow's `suspendedRetryPolicy` bounds how long ONE CALLER polls a suspended
  execution. It is per-caller and not durable, and a spent budget cancels
  nothing. See [Suspension and cancellation](/concepts/suspension/).
- A flow's `maxRounds` bounds how many trampoline rounds one lineage may open.
  See [Trampoline rounds](/concepts/trampoline-rounds/).
