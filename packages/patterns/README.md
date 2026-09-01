# @smthrs/patterns

Higher-order flow patterns and decorators for flows. It composes `@smthrs/core` alone and imports no Node built-ins.

```sh
npm install @smthrs/patterns
```

## Public API

<!-- generated:patterns-surface start -->

The root entry point exports every public module as a namespace; each is also importable from its listed subpath.

| Module            | Import specifier                   | Summary                                                                                                                                                            | Public exports                                                                                                                                                                                                                           |
| ----------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PatternError`    | `@smthrs/patterns/PatternError`    | Stable failures shared by higher-order flow patterns.                                                                                                              | `PatternErrorCode`, `PatternError`                                                                                                                                                                                                       |
| `Pattern`         | `@smthrs/patterns/Pattern`         | Flow-valued slots and authority-narrowing decorators.                                                                                                              | `Slot`, `slot`, `bind`, `Decorator`, `Clipped`, `clipped`, `decorate`, `decorateAll`                                                                                                                                                     |
| `WithRetry`       | `@smthrs/patterns/WithRetry`       | Bounded retry helpers.                                                                                                                                             | `Backoff`, `Options`, `make`, `withRetry`, `retryEffect`                                                                                                                                                                                 |
| `WithCache`       | `@smthrs/patterns/WithCache`       | Engine step-key cache decoration.                                                                                                                                  | `Scope`, `Options`, `Policy`, `CachePolicyAnnotation`, `policyOf`, `make`, `withCache`                                                                                                                                                   |
| `WithApproval`    | `@smthrs/patterns/WithApproval`    | Run-local approval decoration.                                                                                                                                     | `Approved`, `Options`, `make`, `withApproval`                                                                                                                                                                                            |
| `Debate`          | `@smthrs/patterns/Debate`          | A bounded, alternating deliberation pattern.                                                                                                                       | `Turn`, `RuntimeTurn`, `RuntimeOptions`, `MakeOptions`, `make`, `run`                                                                                                                                                                    |
| `Panel`           | `@smthrs/patterns/Panel`           | A deterministic panel deliberation pattern.                                                                                                                        | `MakeOptions`, `RuntimeOptions`, `make`, `run`                                                                                                                                                                                           |
| `Escalation`      | `@smthrs/patterns/Escalation`      | Sequential escalation pattern.                                                                                                                                     | `Rung`, `MakeOptions`, `RuntimeRung`, `RuntimeOptions`, `Reached`, `Exhausted`, `accepted`, `defaultEscalate`, `make`, `run`                                                                                                             |
| `ReviewLoop`      | `@smthrs/patterns/ReviewLoop`      | Bounded produce-review-revise pattern.                                                                                                                             | `MakeOptions`, `RuntimeOptions`, `Exhausted`, `accepted`, `make`, `run`                                                                                                                                                                  |
| `MapReduce`       | `@smthrs/patterns/MapReduce`       | Deterministic map-reduce declaration pattern.                                                                                                                      | `OnEmpty`, `MakeOptions`, `RuntimeOptions`, `make`, `run`                                                                                                                                                                                |
| `Recursion`       | `@smthrs/patterns/Recursion`       | Trellis-style bounded recursive expansion declarations.                                                                                                            | `Envelope`, `RecurseOptions`, `Branch`, `recurse`                                                                                                                                                                                        |
| `Bounded`         | `@smthrs/patterns/Bounded`         | Bounded fan-out: a fixed set of members run at most `concurrency` at a time, highest priority first.                                                               | `AllOptions`, `RuntimeOptions`, `all`, `run`                                                                                                                                                                                             |
| `TryCatchFinally` | `@smthrs/patterns/TryCatchFinally` | Scoped error boundary: a protected body, a filtered recovery arm, and a finalizer that runs on every path.                                                         | `MakeOptions`, `RuntimeOptions`, `make`, `run`                                                                                                                                                                                           |
| `Quarantine`      | `@smthrs/patterns/Quarantine`      | Continue-on-failure fan-out.                                                                                                                                       | `Policy`, `Quarantined`, `AllOptions`, `RuntimeOptions`, `isQuarantined`, `all`, `run`, `settle`                                                                                                                                         |
| `Saga`            | `@smthrs/patterns/Saga`            | Forward steps with compensations that unwind in reverse.                                                                                                           | `OnFailure`, `Step`, `MakeOptions`, `RuntimeStep`, `RuntimeOptions`, `Compensated`, `make`, `run`                                                                                                                                        |
| `Trellis`         | `@smthrs/patterns/Trellis`         | Model-authored bounded delegation plans.                                                                                                                           | `TrellisErrorCode`, `TrellisError`, `Envelope`, `Agent`, `Plan`, `Leaf`, `leaves`, `validate`, `CompileOptions`, `compile`, `MakeOptions`, `make`, `Authoring`, `Continuation`, `Round`, `RunResult`, `RuntimeOptions`, `execute`, `run` |
| `DelegationChain` | `@smthrs/patterns/DelegationChain` | The fixed delegation chain: refine, plan, derisk, execute, review, settle.                                                                                         | `DelegationErrorCode`, `DelegationError`, `Budget`, `Bounds`, `MakeOptions`, `Work`, `ReviewRequest`, `DeriskRequest`, `PlanRequest`, `Settlement`, `RuntimeOptions`, `accepted`, `bound`, `make`, `run`                                 |
| `CheckSuite`      | `@smthrs/patterns/CheckSuite`      | Check-suite pattern: run independent checks with bounded concurrency and reduce their rows to one verdict.                                                         | `Strategy`, `MakeOptions`, `CheckResult`, `Verdict`, `RuntimeOptions`, `passed`, `rows`, `verdict`, `make`, `run`                                                                                                                        |
| `DriftDetector`   | `@smthrs/patterns/DriftDetector`   | Capture the world, compare it to a baseline, and alert when it moved.                                                                                              | `MakeOptions`, `RuntimeOptions`, `Result`, `drifted`, `make`, `run`                                                                                                                                                                      |
| `Intervene`       | `@smthrs/patterns/Intervene`       | Intervene pattern: read a target, propose a change, apply it behind an optional approval, and report what happened.                                                | `MakeOptions`, `RuntimeOptions`, `make`, `run`                                                                                                                                                                                           |
| `Kanban`          | `@smthrs/patterns/Kanban`          | Kanban pattern: move every item through an ordered list of columns, with a concurrency bound applied inside each column.                                           | `Item`, `Column`, `MakeOptions`, `RuntimeColumn`, `Failure`, `Board`, `RuntimeOptions`, `make`, `run`                                                                                                                                    |
| `Loop`            | `@smthrs/patterns/Loop`            | Bounded repeat-until-predicate loops.                                                                                                                              | `OnMaxReached`, `MakeOptions`, `RalphOptions`, `RuntimeOptions`, `RalphRuntimeOptions`, `Result`, `done`, `make`, `ralph`, `run`, `runRalph`                                                                                             |
| `MergeQueue`      | `@smthrs/patterns/MergeQueue`      | Merge-queue pattern: land a set of members in one prioritized order, at a concurrency the queue owns rather than the members.                                      | `DefaultPriority`, `FailurePolicy`, `Member`, `MakeOptions`, `RuntimeMember`, `RuntimeOptions`, `Landed`, `Quarantined`, `Result`, `Position`, `ordered`, `make`, `run`                                                                  |
| `Optimizer`       | `@smthrs/patterns/Optimizer`       | Generate, evaluate, improve: a bounded search for a candidate that reaches a target score.                                                                         | `OnMaxReached`, `Attempt`, `Evaluation`, `MakeOptions`, `RuntimeOptions`, `Result`, `make`, `run`                                                                                                                                        |
| `Runbook`         | `@smthrs/patterns/Runbook`         | Runbook pattern: an ordered list of steps where a step's risk decides whether it is gated by an approval, and a denial either stops the runbook or skips the step. | `Risk`, `OnDeny`, `Step`, `MakeOptions`, `Request`, `RuntimeStep`, `RuntimeOptions`, `Result`, `gated`, `elevated`, `make`, `run`                                                                                                        |
| `ScanFixVerify`   | `@smthrs/patterns/ScanFixVerify`   | Scan for issues, fix them in parallel, verify, and repeat until clean.                                                                                             | `MakeOptions`, `RuntimeOptions`, `Report`, `resolved`, `make`, `run`                                                                                                                                                                     |
| `Sidecar`         | `@smthrs/patterns/Sidecar`         | Run a cheap shadow beside the primary and measure the gap.                                                                                                         | `MakeOptions`, `Scores`, `Delta`, `Shadow`, `Result`, `RuntimeOptions`, `delta`, `make`, `run`                                                                                                                                           |
| `Supervisor`      | `@smthrs/patterns/Supervisor`      | Supervisor pattern: one boss plans, workers execute in parallel, the boss reviews, and only the tasks the review calls retriable are re-delegated.                 | `Task`, `Plan`, `MakeOptions`, `Outcome`, `RuntimeOptions`, `Completed`, `Exhausted`, `make`, `run`                                                                                                                                      |

<!-- generated:patterns-surface end -->

```ts
import { Debate } from "@smthrs/patterns"

const debate = Debate.make({
  proponent,
  opponent,
  judge,
  rounds: 2
})
```

`@smthrs/patterns/package.json` is also exported. `internal/*` and nested `*/index` subpaths are not public.

## Declaration size

Every `make` expands its declared bounds eagerly into graph nodes. The options
that expand or multiply topology are `Loop.maxIterations`,
`ReviewLoop.maxRounds`, `Debate.rounds`, `Recursion` envelope depth across
fanout, `ScanFixVerify.maxRetries` times `maxIssues` in concurrency-sized
batches, `Trellis` envelope fuel, and `DelegationChain.maxDepth` together with
`maxDeriskRounds`. These bounds are sized for tens to low hundreds of declared
calls. A very large bound builds a very large graph before anything runs. For
an unbounded loop, use the `run` half under an external scheduler instead of
unrolling it in `make`.

## What `WithCache` declares today

`WithCache` writes its policy under the annotation identifier
`@smthrs/flow/Action/CachePolicy`, which is the key `@smthrs/engine-store` reads
at dispatch. The durable engine executes `@smthrs/flow` actions, and flows HEAD
has no bridge from a `@smthrs/core` `Flow.make` descriptor to that interpreter,
so on a core flow the policy is a declaration: it renames the wrapper, enters its
captured key material, and travels with the flow until the bridge lowers it onto
the dispatched action. For a policy the engine acts on now, declare it on the
action with `CacheEnvironment.withCache(action, policy)` from `@smthrs/flow`. See
[Step cache](https://smithers.sh/api/step-cache).
