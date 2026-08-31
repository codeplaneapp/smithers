---
description: "@smthrs/patterns: higher-order flow patterns and the decorators that compose them."
---

# `@smthrs/patterns`

This page is the public API reference for the higher-order flow patterns:
decorators that wrap one flow, and containers that compose several. The package
depends on `@smthrs/core` alone and builds plan-time topology out of `Flow` and
`Node`. Nothing in it reaches the engine, the journal, or a host capability.
Neither package has an entry in the browser gate, so this page makes no claim
about bundling it for a browser.

## The two halves of a pattern

Every container exports a pair.

| Half | What it is | What it must not do |
| --- | --- | --- |
| `make(options)` | A `Flow` whose body is the **conservative topology**: every rung, round, member, and compensation that the pattern could reach, declared before anything runs | Branch on a value. Core plans continuations against symbolic values, so a plan-time `if` on a result is always the same arm |
| `run(input, options)` | The `Effect` that performs the value-dependent branch at runtime, short-circuiting the parts the topology reserved | Change the shape the declaration promised |

A planner reads `make`. A handler runs `run`. Both accept the same option
names so one is read as the other's contract.

Declaration-time misuse raises `PatternError` from `make`: an empty ladder, a
fractional concurrency, a compensation that is not a flow. The same condition
inside `run` becomes a typed failure rather than a throw.

## `PatternError`

`PatternError` is the package's single tagged error, carrying a `code` from
`PatternErrorCode` and a message.

| Code | Raised when |
| --- | --- |
| `missing_slot` | A required `Pattern.slot` was neither bound nor defaulted |
| `invalid_decorator` | A decorator broke a schema or authority contract, or an option was out of range |
| `envelope_conflict` | A supplied flow declares authority its template excludes |
| `recursion_bound` | `Recursion.recurse` hit its declared depth |
| `exhausted` | A bounded pattern ran out of rounds, rungs, or shards |
| `finalizer_failed` | A `TryCatchFinally` finalizer failed after the protected body settled |
| `compensation_failed` | One or more `Saga` compensations failed while unwinding |
| `quarantined` | `Quarantine.settle` was called on a result holding quarantined members |

## Decorators

| Module | Surface |
| --- | --- |
| `Pattern` | `slot`, `bind`, `decorate`, `decorateAll`, and `clipped`, the report of authority a template envelope removed |
| `WithRetry` | `withRetry(flow, { attempts, backoff?, nonRetryable? })` and `retryEffect`. See [Failure and retry](/concepts/failure-and-retry#pattern-retry) |
| `WithApproval` | `withApproval(flow, options)`, an approval boundary in front of a flow |
| `WithCache` | `withCache(flow, options)`, cache policy metadata on a declaration |

## Containers

| Module | Shape |
| --- | --- |
| `Bounded` | A record of members, at most `concurrency` in flight, highest priority first |
| `Quarantine` | The same fan-out, with a failing member isolated instead of interrupting its siblings |
| `Panel` | Named panelists with optional roles, then a moderator over their opinions |
| `Debate` | Alternating proponent/opponent turns, then a judge |
| `MapReduce` | One map call per shard under a static width bound, then one reduce |
| `ReviewLoop` | Bounded produce, review, revise |
| `Escalation` | A ladder of alternative strategies with a fallback rung |
| `Recursion` | Explicit bounded recursive branches |
| `TryCatchFinally` | A protected body, a filtered recovery arm, and a finalizer that always runs |
| `Saga` | Forward steps with compensations that unwind in reverse |

## `Bounded`

`Bounded.all(members, { concurrency, priority? })` splits a named record into
batches of `concurrency` and sequences the batches, so the plan shows exactly
how many calls can be in flight. `Bounded.run(members, { concurrency,
priority?, priorities? })` is the Effect form.

Members are ordered by priority, highest first, and declaration order breaks a
tie so a plan built twice from one record is identical. A member that carries
its own `Node.priority` keeps it; every other member inherits the container's.
Priority is a scheduling hint and never enters key material, so raising it does
not invalidate a cached step. See [Concurrency](/concepts/concurrency).

`Bounded.run` follows `Effect.forEach`: the first failure interrupts the
members still in flight.

## `Quarantine`

`Quarantine.all(members, { policy })` wraps each member in a recovery arm that
succeeds with `{ _tag: "Quarantined", member, error }`, so one failure never
takes its siblings down. `policy: "halt"` is a plain join that does interrupt
them. `Quarantine.run(members, { policy, concurrency? })` is the Effect form,
and `Quarantine.settle(result)` turns a result holding quarantined members into
a `quarantined` failure for callers that want to halt after the join.
`isQuarantined` narrows one joined entry. Quarantine isolates typed failures; a
defect and an interruption still propagate.

## `Panel`

`Panel.make({ panelists, moderator, roles?, concurrency? })` declares one call
per panelist, then the moderator over `{ input, opinions }`. A role named in
`roles` is passed to that panelist as `{ input, role }` and enters its key
material, so changing a role changes the declaration. `Panel.run` keys opinions
by panelist name whatever order they complete in.

## `Escalation`

`Escalation.make({ rungs, accept?, fallback? })` declares a ladder of
alternative strategies. A rung is a flow, or `{ flow, escalateIf }` when that
rung decides for itself. `accept` decides every rung that declares no
`escalateIf`; `fallback` is the last rung and runs only after all of them
escalated, which is where a human approval flow belongs.

`Escalation.run(input, options)` returns `{ level, result }` naming the rung
that settled, counting from zero. A fallback result carries the rung count. If
every rung escalates and no fallback is declared, the last result comes back as
`{ level, result, accepted: false, exhausted: true }`. That case used to fail
with `PatternError { code: "exhausted" }`, so a caller that matched on the code
checks `exhausted: true` on the value instead.

`defaultEscalate` is the predicate used when a rung has neither an
`escalateIf` nor a shared `accept`. It escalates on a missing result and on the
conventional failure markers: a set `error`, `failed: true`, or `ok: false`.

Rungs are alternative strategies, not model-seat fallback. Provider and seat
fallback belong to model routing, before a flow is selected.

## `TryCatchFinally`

`TryCatchFinally.make({ try, catch?, catchErrors?, finally? })` declares the
protected call, the recovery arm `catchErrors` selects, and a finalizer call on
the settled arm and on the arm no handler claimed. The unhandled arm ends in
`Node.fail`, so the plan states that the finalizer cleans up and hands the
failure back rather than absorbing it. Both arms are wrapped in `Node.capture`,
so the boundary keys the same way on every build.

`TryCatchFinally.run(input, options)` takes `catchErrors` as a predicate,
because the runtime form already holds the decoded typed error. The finalizer
runs after success, after recovery, after an unclaimed failure, and after
interruption. A finalizer that fails on its own becomes `finalizer_failed`; a
body failure outranks it, so cleanup trouble never hides the reason the body
failed.

## `Saga`

`Saga.make({ steps, onFailure })` declares the forward chain and its
compensation arms. Each step's continuation is wrapped in a `Node.catch` whose
arm calls that step's compensation and re-raises, so a failure deeper in the
chain unwinds one step at a time, most recent first, and the plan lists the
compensation calls in reverse order. `onFailure` defaults to `compensate` in
both halves. `make` refuses a step whose action or compensation is not a flow.

`Saga.run(input, { steps, onFailure })` registers one scope finalizer per
completed step, so the unwind is LIFO and runs on interruption as well as on
failure. A compensation that dies is recorded as a failed compensation rather
than raised as a defect, so the residue still names it and the finalizers
behind it still run. See
[Failure and retry](/concepts/failure-and-retry#sagas).

## A worked release

`examples/src/30-failure-control.ts` runs one release through five of these
patterns: bounded checks, a quarantined flake, an escalating fixer, a saga that
unwinds a half-finished deploy, and a lock the finalizer always releases. Its
first assertion reads the declaration alone, before anything runs, to show the
compensations in reverse order.

## Entry points

The root exports each module as a namespace; every module is also importable as
`@smthrs/patterns/<Module>`. `internal/*` and nested `*/index` subpaths are
private.

`@smthrs/core` supplies `Flow`, `Node`, and `Graph`. See
[Flows and the action graph](/concepts/action-graph) for what a built
graph means, and [`@smthrs/plan`](/api/plan) for the persisted form a graph
compiles into.
