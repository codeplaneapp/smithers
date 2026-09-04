---
title: "Park on quota refusals and cap run spend"
description: "Turn provider rate limits into durable waits with QuotaPolicy, and enforce token and latency ceilings across a run's model calls with Budget."
sidebar:
  order: 3
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/docs/guides/quota-and-budgets.md"
---

Two injected policies decide how a run treats the provider's limits.
`QuotaPolicy` reads a refusal and answers when to come back. `Budget`
accumulates what a run has spent and refuses past its ceiling. Both are
required by `Agent.layer`: a composition that binds none is a type error, and
each policy has an explicit opt-out layer for a host that means to enforce
nothing.

## Classify a refusal as a wait

A `rate_limited` or `quota_exceeded` answer is not a defect report: the
provider is saying when to come back. `QuotaPolicy.layerDefault()` installs the
classifier:

```ts
import * as QuotaPolicy from "@smthrs/agent/QuotaPolicy"

const quota = QuotaPolicy.layerDefault({ maxWaitMillis: 900_000 })
```

The classifier answers one question, whether this refusal is a wait and until
when, in order of how much the provider actually said:

1. `resetAtEpochMillis`, the instant the provider named.
2. `retryAfterMillis`, the delay it named.
3. A delay parsed out of the message text, for the providers that put it only
   there.
4. `Config.defaultWaitMillis` (60,000), when the refusal names nothing.

A deadline beyond `Config.maxWaitMillis` (3,600,000) is not a wait at all: the
classifier answers `None` and the original `ModelError` propagates, because a
run parked for a day is indistinguishable from a run that hung. A deadline
already past is a park of zero: the provider said the window has reopened.
`QuotaPolicy.layerUnclassified()` explicitly keeps every refusal as a failure.

## What a park does

`AgentAction` is what parks on a classified refusal. The park is a real durable
wait:

- The decision is a recorded step, so a replay waits out the deadline the first
  pass chose instead of computing a new one, and the wake time and its source
  sit in the run's own evidence where an operator reads them.
- `annotateWaiting({ reason: "quota", wakeAt })` and `DurableClock.sleep`
  suspend the run, so a supervisor sees a parked run with a wake time and
  `waitingRuns({ reason: "quota" })` finds it.
- The retry runs under `Action.retry`, so the re-issued model call is a new
  attempt of the same step rather than a replay of the one the provider
  refused, and the step's correction budget is untouched: a quota wait is not a
  failed attempt.
- `Host.maxQuotaParks` bounds the waits one ask may take, defaulting to
  `QuotaPolicy.defaultMaxParks` (8). The bound is per ask: a step that parks,
  answers, and is corrected starts its next ask with a full allowance.

Each park writes a `flows.agent.quota-parked.v1` record naming the action, the
session, the wake time, and the deadline's source.

## The refusal that is never recorded

One thing changes at the engine port, and it applies whichever classifier is
composed. `FlowEngineLike` normally records a provider failure as the sealed
step's result, which is right for every failure except a capacity refusal: the
same bytes succeed a minute later, so recording the refusal under a content key
would pin "this prompt is refused" into the shared cache and make the wake
pointless. The port therefore fails every capacity refusal it normalizes
(`rate_limited`, `quota_exceeded`, `provider_internal`, and any refusal
carrying HTTP 429, 503, 504, or 529), which records an attempt rather than a
result. Policy decides what happens on top of that floor; no policy weakens it.

## Cap what a run spends

`Sandbox.Limits` bounds one cell and `Agent.Options.maxFrames` bounds one loop.
Neither accumulates, so the tokens and milliseconds a control plane approved
for a plan bound nothing until `Budget` existed:

```ts
import * as Budget from "@smthrs/agent/Budget"

const budget = Budget.layer({
  tokens: { max: 200_000, onExceeded: "fail" },
  latency: { maxMillis: 900_000 }
})

// Or straight from what the control plane approved:
const approved = Budget.layerFromEnvelope(envelope)
```

Enforcement sits at the model boundary in `FlowEngineLike`, which every model
call passes through, so a step that assembles its own loop cannot evade a
budget declared for the run. Five rules make it usable:

- **The accumulator is per run, keyed by the model step's content key, and
  projected from the journal.** Every accounted call writes a
  `flows.agent.usage.v1` record on the durable channel, and the run's first
  decision writes its latency clock zero as a `flows.agent.budget-started.v1`
  record. A budget entering a resumed run folds both back before it decides
  anything, because the engine resumes from recorded results and never
  re-enters a settled step: an in-memory accumulator would hand a resumed run
  a second full allowance.
- **One instance serves every run.** Provide `Budget` above the engine, so the
  tally is keyed by execution id. `Budget.usageOf(runId)` reads one run's
  spend, from its live accumulator when the run is here and from its records
  when it is not. `Budget.defaultMaxRuns` (256) bounds how many tallies are
  held in memory, and `Budget.layer(policy, { maxRuns })` sets it.
- **Refusal is a projection.** The check runs before a call and projects its
  cost as the largest call the run has made. A budget that noticed afterwards
  would always be exceeded by the call that exceeded it.
- **The first call is never refused.** With nothing recorded, the only honest
  projection is zero.
- **The accounting fails closed.** A record that could not be written, a
  ledger that could not be read, and a ledger longer than one recovery reads
  (`Budget.defaultRecoveryEntries`, overridable with
  `Budget.layer(policy, { recoveryEntries })`) all raise
  `Budget.AccountingUnavailable` rather than answering. Each of them is a run
  whose spend is unknown, and a budget that read an unknown as zero would hand
  a resumed run its whole allowance back. The step that made the call fails;
  its sealed model step replays from the recorded answer, so a re-dispatch
  pays the ledger again and not the provider.

A step the ledger has already counted proceeds whatever the ceiling says: its
replay costs nothing, and a run killed after its last model call must not come
back dead on arrival.

## Choose what running out means

`onExceeded` is the composition's choice, defaulting to `fail`:

| Setting          | Behavior                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------ |
| `fail`           | The step fails with `BudgetExceeded { scope, used, max, next }`.                                       |
| `warn`           | A `flows.agent.budget-warning.v1` record is written and the call proceeds.                             |
| `skip-remaining` | The budget latches. Every later model call in the run fails typed `skipped` without asking a provider. |

A latched refusal is its own failure, `Budget.Skipped`, carrying the
`BudgetExceeded` it latched on. The distinction is what an operator needs: one
step broke the budget and every other step was stopped by it. `Skipped` names a
verdict no retry can change, so build retry policies through
`Budget.neverRetrySkipped`:

```ts
import { RetryPolicy } from "@smthrs/flow"

const policy = Budget.neverRetrySkipped(RetryPolicy.defaultRetryPolicy)
```

## Inspect the spend

`Budget.usageOf(runId)` reads one run's `{ tokens, calls, largestCall }`,
whether or not this process is driving it: a supervisor reads the spend of a
run that is parked, finished, or owned by another host. `Budget.usage` reads
the current run's. Calls recorded outside any run tally under
`Budget.looseRunId`.

For the runnable demonstration of all three policies across an engine restart,
see [`examples/src/39-agent-policies.ts`](https://github.com/smithersai/smithers/blob/main/examples/src/39-agent-policies.ts):
the provider refuses, the run parks, the engine is killed while it waits, and a
second engine over the same file waits out the recorded deadline, spends a
correction, and finishes with the provider called three times in all.
