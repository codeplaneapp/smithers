---
description: "@smthrs/agent: the production cell loop, AgentAction, AgentSession, seats, and the plugin surface a host provides."
---

# `@smthrs/agent`

This page is the public API reference for the **agent**: the production cell
loop, the two adapters that run it, and the three policies that decide what one
model-backed step is allowed to do.

`Agent` is the loop. `AgentSession` runs it as one durable control-plane run;
`AgentAction` runs it as one typed step inside a larger flow. Neither adapter
reimplements the loop, and both reach a provider through the same engine port,
`FlowEngineLike`, which is where every policy on this page is enforced.

## AgentAction

`AgentAction.make(tag, options)` declares an ordinary action, with the same tag,
payload schema, `.call()`, plan node, and durable replay as any other, and ships
its implementation. The composition half is `AgentAction.Host` (the registry,
the sandbox budget, the catalog, and the defaults below) plus `SeatResolver`,
which turns a declared seat string into a live model.

A step fails with `AgentAction.AgentFailure`: a `StructuredOutputFailure` when
the answer never fit the schema, a `BudgetExceeded` when the run has spent what
it was approved for, a `Budget.Skipped` when an earlier step already broke a
`skip-remaining` budget, a `SeatUnresolved` when the host has no model for the
declared seat, and `HarnessError` or `PluginError` when the composition failed
underneath it.

`AgentAction.Host` is the composition half, provided once through
`AgentAction.layerHost`:

| Field | What it decides |
| --- | --- |
| `registry` | The catalog a cell is shown and the registry its calls resolve against. |
| `limits` | The sandbox budget every cell runs under. Never unlimited. |
| `flows`, `implementations`, `plugins`, `config` | The executable flows, module-backed implementations, plugins, and configuration composed into every run. |
| `system` | Stable teaching placed ahead of every action's own. |
| `capabilityEnvelope` | What the composition grants, and what its sealed step keys are computed under. |
| `maxFrames` | The default cell-loop bound for steps that declare none. |
| `defaultCorrections` | The correction budget for steps that declare none. |
| `modelRetryPolicy` | The transport retry ladder one model call runs under. Defaults to the port's own; `Schedule.recurs(0)` turns it off. |
| `maxQuotaParks` | How many quota waits one step may take. Defaults to `QuotaPolicy.defaultMaxParks`, which is eight. |

## Structured-output corrections

The declared output schema is rendered into the run's system teaching and
enforced against the run's final answer. A decode miss spends a correction slot
on a re-prompt that repeats the task verbatim and appends the validation issues.

| Where | What it decides |
| --- | --- |
| `Options.corrections` | This step's budget. Zero makes a first miss terminal. |
| `Host.defaultCorrections` | The composition's budget for steps that declare none. |
| `Options.repair` | One bounded ask after the budget is spent. |

Neither declared leaves the budget at one. The declaration always beats the
composition default, including when it is zero: a step that declared a first
miss terminal stays terminal under a generous host.

A repair is not another rung of the correction ladder. A correction assumes the
model can still answer the question it was asked; a repair is the author's own
prompt, written from the failure, asked once, on its own seat and with its own
teaching if the declaration says so, and decoded by the same schema.

Every rejection writes a `flows.agent.structured-output-rejected.v1` record on
the journal's lossy channel with the action, the attempt, the budget, the schema
digest, and `StructuredOutput.issuesDigest`. The record carries a digest rather
than the issues themselves, so two runs that spent their budget the same way are
distinguishable without the answers being journaled. A composition with no
journal writes nothing and behaves the same otherwise.

**The record is evidence, not a decision.** It is what an operator reads to see
which correction was spent and why; nothing in the ladder reads it back.
Compaction may drop it, and a composition without a journal never writes it, and
the run behaves identically either way. What makes the ladder durable is the
step record underneath it: each attempt is a whole cell run under its own
session and prompt, so its model call is a distinct sealed step with its own
content key and its own attempt row on the journal's durable channel. A settled
ladder replays whole across a process restart, over a second engine on the same
database, and pays the provider nothing.

Distinct is not the same as readable. A session is key material and is hashed
into the step key, so three distinct keys say a ladder ran and not which call
was the ask. `AgentAction` sets `FlowEngineLike.Correction` around each rung and
the port stamps the ordinal onto that rung's `RecordedModelStep`, so a
projection reading the run's sealed steps gets `correction: 0` for the ask and
`1`, `2` for its re-prompts. The field is optional: a model call outside a
ladder has no ordinal, and a record written before the field existed still
decodes for a parked run resuming onto a newer package.

## Quota parks

`QuotaPolicy` classifies a provider refusal as a wait. It answers one question,
whether this is a wait and until when, in order of how much the provider said:
`resetAtEpochMillis`, then `retryAfterMillis`, then a delay parsed out of the
message text, then `Config.defaultWaitMillis`. Above `Config.maxWaitMillis` it
answers `None` and the original `ModelError` propagates, because a run parked
for a day is indistinguishable from a run that hung.

The classifier is required. A composition that binds none is a type error, and
`QuotaPolicy.layerUnclassified()` is how one opts out in writing.

What it opts out of is parking, not the recording floor. `FlowEngineLike` fails
every capacity refusal it normalizes, whichever classifier is composed:
`rate_limited`, `quota_exceeded`, `provider_internal`, and any refusal carrying
HTTP 429, 503, 504, or 529. Under `layerUnclassified` such a refusal fails the
step instead of parking it, and it is still never written as the sealed step's
durable value. Policy decides what happens on top of that floor; no policy
weakens it.

A classified refusal parks for real:

- the decision is a **recorded step**, so a replay waits out the deadline the
  first pass chose rather than computing a new one;
- `annotateWaiting({ reason: "quota", wakeAt })` and `DurableClock.sleep`
  suspend the run, so `waitingRuns({ reason: "quota" })` finds it and an
  operator sees a park with a wake time instead of a stall;
- the retry runs under `Action.retry`, so the re-issued model call is a new
  attempt of the same step rather than a replay of the one the provider
  refused, and the step's correction budget is untouched, because a quota wait
  is not a failed attempt;
- `Host.maxQuotaParks` bounds it: a window still closed after its own deadline
  is not one a run waits out forever.

One thing changes at the engine port. `FlowEngineLike` records a provider
refusal as the sealed step's *result*, which is right for every failure but this
one: a capacity refusal says nothing about the request, so recording it under a
content key would pin "this prompt is refused" into the shared cache and make
the wake pointless. A capacity refusal fails the sealed action instead, which
records an attempt rather than a result, and nothing outlives the window. That
is the recorder's own floor, applied before any classifier is consulted. The
classifier then decides whether the failed step parks and waits or ends the run.

## Budgets

`Sandbox.Limits` bounds one cell and `Agent.Options.maxFrames` bounds one loop.
Neither accumulates, so `Envelope.budget`, the tokens and milliseconds a control
plane approved, bound nothing until `Budget` existed.
`Budget.layerFromEnvelope(envelope)` turns the approval into enforcement;
`Budget.layer(policy)` states one directly.

Enforcement sits at the model boundary, which every model call passes through,
so a step that assembles its own loop cannot evade a run-wide budget. Three
rules make it usable:

- **The accumulator is keyed by the model step's content key, and it is
  projected from the journal.** Every accounted call writes a
  `flows.agent.usage.v1` record, and a budget built inside a resumed run folds
  that run's records back before it decides anything. Without the projection a
  restart would start the accounting at zero and hand the run a second full
  allowance, because the engine resumes from recorded node results and never
  re-enters a settled step. The content key stops the two sources double
  counting: a recovered record and its own live call are the same key.
- **Refusal is a projection.** The check runs before a call and projects its
  cost as the largest call the run has made. A budget that noticed afterwards
  would always be exceeded by the call that exceeded it.
- **The first call is never refused.** With nothing recorded, the only honest
  projection is zero.
- **The accounting fails closed.** A usage record that could not be written, a
  ledger that could not be read, and a ledger longer than
  `Budget.defaultRecoveryEntries` all raise `Budget.AccountingUnavailable`
  instead of answering. Each is a run whose spend is unknown, not zero, and a
  budget that read the difference as zero would give a resumed run its whole
  allowance back and report itself healthy. The step that made the call fails;
  its sealed model step replays from the recorded answer, so re-dispatching it
  pays the ledger again and not the provider.
  `Budget.layer(policy, { recoveryEntries })` sets the bound.

`onExceeded` decides what running out means:

| Setting | Behavior |
| --- | --- |
| `fail` | The step fails with `BudgetExceeded { scope, used, max, next }`. |
| `warn` | A `flows.agent.budget-warning.v1` record is written and the call proceeds. |
| `skip-remaining` | The budget latches. Every later model call in the run fails typed `skipped` without asking a provider. |

A latched refusal is `Budget.Skipped`, not another `BudgetExceeded`. It is
quarantine-compatible: it names a verdict no retry can change, so a supervisor
can hold the run rather than re-dispatch it, and `Budget.neverRetrySkipped`
adds the tag to a retry policy so a ladder that would otherwise re-dispatch the
step gives up on the first refusal.

One budget instance serves a whole composition. The accumulator is keyed by
execution id, so a layer built above the engine gives every run its own
allowance and its own latency clock, and `Budget.usageOf(runId)` reads one run's
spend. `Budget.defaultMaxRuns` bounds how many tallies it holds in memory, and
`Budget.layer(policy, { maxRuns })` sets it.

`Budget.usageEvent` is the one record this module writes to be READ BACK rather
than read by an operator. It goes on the journal's durable channel for that
reason, and its write failure is reported rather than ignored. A composition
with no journal at all, such as the reference memory engine, accounts within one
process and recovers nothing across a restart: that absence is the one this
module reads as "nothing recorded" rather than as "spend unknown", because such
a composition never recorded anything to lose.
`Budget.budgetWarningEvent` is the opposite record and stays on the lossy
channel: nothing reads it back, so losing one costs a line in an operator view.

The budget is required too. A composition that binds none is a type error, and
`Budget.layerUnbounded()` is how one gives up token and latency ceilings in
writing. The local CLI binds `Budget.layerFromEnvelope`, so a flow that declares
`budget: { tokens, milliseconds }` in its frontmatter is held to what it
declared and a flow that declares nothing runs unbounded.

## Where these live

`packages/agent/src/AgentAction.ts` holds the correction ladder, the repair
slot, and the park loop; `QuotaPolicy.ts` and `Budget.ts` hold the two injected
policies; `FlowEngineLike.ts` is the enforcement point for the budget check, the
usage accounting, and the refusal that is not recorded. The package README
carries the composition examples.

`examples/src/39-agent-policies.ts` runs one step through all three policies on
the durable engine: the provider refuses, the run parks, the engine is killed
while it waits, a second engine over the same file waits out the recorded
deadline, spends a correction, and finishes. Its test pins the counters: three
provider calls in all, one before the restart, one park decision, and one
correction.
