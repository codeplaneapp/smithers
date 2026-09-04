---
title: "Effect tiers"
description: "The three tiers a journaled effect can have, the boundary evidence recorded around it, and how a rewind turns that evidence into a verdict of revertible, warning, or blocking."
sidebar:
  order: 3
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/time-travel/docs/concepts/effect-tiers.md"
---

A rewind deletes history. Whether that is safe depends entirely on what the run
did to the outside world while it was writing that history, and the journal is
the only place to find out. This page is the model behind that decision.

## Three tiers

Every effect the engine journals declares one of three tiers, and the tier says
how the effect can be undone:

| Tier           | What it means                               | How a rewind handles it                                        |
| -------------- | ------------------------------------------- | -------------------------------------------------------------- |
| `sealed`       | The result is content-addressed and cached. | Nothing to undo. Replay stays a cache hit.                     |
| `compensable`  | The effect mutated the workspace.           | The workspace is restored to the frame's recorded pointer.     |
| `irreversible` | The effect left the system.                 | A registered handler compensates it, or the rewind is refused. |

The tier is recorded with the effect, not inferred later. An irreversible
effect must also carry an idempotency key, and `EffectBoundary.guard` refuses
one that does not with `invalid` before the action runs.

## Boundary evidence is monotonic

An effect is journaled as a pair of records under the event type
`flows.time-travel.effect-boundary`:

- `intended`, written durably **before** the action runs.
- a terminal record, `succeeded` or `unknown`, written after it settles.

Interruption, defects, and typed failures all settle the boundary as `unknown`
before the original cause is re-raised, and the settlement is uninterruptible,
so cancellation cannot strand an action that has crossed the boundary. An
`unknown` outcome is the honest answer for "we do not know whether this
reached the world", and it is what stops a rewind from compensating something
that may never have happened.

The legal history of one effect is an `intended` record followed by at most one
terminal record. Reading it back folds to one record per effect, and everything
else fails closed as `invalid`: two terminals, a terminal followed by
`intended`, two records at one sequence that disagree, or two records whose
identity fields differ. Exact duplicates are tolerated, because a reader can
page the same record twice.

Writing the `intended` record is also the re-arm guard. If it comes back as a
duplicate, the effect already crossed its durable boundary and executing it
again is refused with `already_crossed`.

## How a rewind reads the evidence

Before a rewind mutates anything, it assesses every crossed effect in the
suffix and gives each one a classification:

- `revertible`: the rewind compensates it.
- `warning`: it stands, and the rewind discloses it.
- `blocking`: the rewind is refused.

One blocking assessment refuses the whole operation with `irreversible`,
carrying every blocking assessment as the cause. The rules per tier are:

**Sealed.** The effect must name a content-addressed cache key and that entry
must still be present. Present is a `warning`, because the result stands and a
replay remains a cache hit. A missing key or a missing entry is `blocking`: the
result can no longer be re-derived.

**Compensable.** The target frame must have a recorded Jujutsu pointer. With
one, the assessment is `revertible` and the workspace is restored to that
change. Without one, it is `blocking`, because there is nowhere honest to
restore to.

**Irreversible.** The effect resolves against the handlers the composition
contributed. With no handler registered for the kind, the verdict is
`blocking`, which is the default a composition with no
[`CompensationHandlers`](/guides/compensate-an-effect/) gets and the safe
one. A resolved handler still blocks when its tier does not match the effect's,
when the effect's terminal status is not `succeeded`, when the handler declares
a different compensation descriptor from the one the effect recorded, or when
the handler requires an idempotency key the effect did not record. Otherwise
the verdict is `revertible`, or whatever the handler's own `assess` returns.

A custom `assess` result is decoded against the `Assessment` schema before
anything acts on it, and a result that does not decode assesses as `blocking`.
A handler bug can refuse a rewind; it can never let one through.

## A fork never compensates

A fork runs the same assessment and then normalizes every blocking and
revertible entry to a warning, because a fork changes nothing about the parent
and undoes nothing. The warning says what it means: this effect may execute
again on the child.

A fork with a non-empty `warnings` array is a successful fork, not a refused
one. Read them and decide; the operation has already happened.

## Where to go next

- [Journal an effect boundary](/guides/journal-an-effect/): the producer
  side, for an adapter author.
- [Compensate an irreversible effect](/guides/compensate-an-effect/):
  writing the handler that turns `blocking` into `revertible`.
- [The rewind protocol](/concepts/rewind-protocol/): where the assessment sits in the
  order of operations.
