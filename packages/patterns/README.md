# @smthrs/patterns

Browser-safe higher-order flow patterns and decorators for flows. It composes `@smthrs/core` declarations at plan time and includes runtime helpers only where retries or iterative host execution are required.

```sh
npm install @smthrs/patterns
```

## Public API

The root entry point exports these namespaces; each is also importable from `@smthrs/patterns/<Module>`.

| Module            | Public exports                                                                                                                                                                                                                           | Description                                                                                      |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `Bounded`         | `AllOptions`, `RuntimeOptions`, `all`, `run`                                                                                                                                                                                             | Joins a record of members at most `concurrency` at a time, highest priority first.               |
| `Debate`          | `Turn`, `MakeOptions`, `make`                                                                                                                                                                                                            | Builds a bounded alternating debate followed by a judge flow.                                    |
| `DelegationChain` | `DelegationErrorCode`, `DelegationError`, `Budget`, `Bounds`, `MakeOptions`, `Work`, `ReviewRequest`, `DeriskRequest`, `PlanRequest`, `Settlement`, `RuntimeOptions`, `accepted`, `bound`, `make`, `run`                                 | Runs the fixed refine, plan, derisk, execute, review, settle chain.                              |
| `Escalation`      | `Rung`, `MakeOptions`, `RuntimeRung`, `RuntimeOptions`, `Reached`, `Exhausted`, `defaultEscalate`, `make`, `run`                                                                                                                         | Declares a staged ladder with per-rung escalation and a fallback rung, and runs it.              |
| `MapReduce`       | `OnEmpty`, `MakeOptions`, `make`                                                                                                                                                                                                         | Fans input out through a map flow and combines results with a reducer.                           |
| `Panel`           | `MakeOptions`, `RuntimeOptions`, `make`, `run`                                                                                                                                                                                           | Runs a fixed panel of flows and aggregates their outputs.                                        |
| `Pattern`         | `Slot`, `slot`, `bind`, `Decorator`, `Clipped`, `clipped`, `decorate`, `decorateAll`                                                                                                                                                     | Defines typed slots and the common flow-decorator composition primitives.                        |
| `PatternError`    | `PatternErrorCode`, `PatternError`                                                                                                                                                                                                       | Defines typed pattern declaration and runtime failures.                                          |
| `Quarantine`      | `Policy`, `Quarantined`, `AllOptions`, `RuntimeOptions`, `isQuarantined`, `all`, `run`, `settle`                                                                                                                                         | Fans out a record of members and isolates a failing one from its siblings.                       |
| `Recursion`       | `Envelope`, `RecurseOptions`, `Branch`, `recurse`                                                                                                                                                                                        | Builds explicit bounded recursive branches.                                                      |
| `ReviewLoop`      | `MakeOptions`, `RuntimeOptions`, `Exhausted`, `make`, `run`                                                                                                                                                                              | Declares and runs bounded generate/review/revise loops.                                          |
| `Saga`            | `OnFailure`, `Step`, `MakeOptions`, `RuntimeStep`, `RuntimeOptions`, `Compensated`, `make`, `run`                                                                                                                                        | Runs forward steps and unwinds their compensations in reverse on failure.                        |
| `Trellis`         | `TrellisErrorCode`, `TrellisError`, `Envelope`, `Agent`, `Plan`, `Leaf`, `leaves`, `validate`, `CompileOptions`, `compile`, `MakeOptions`, `make`, `Authoring`, `Continuation`, `Round`, `RunResult`, `RuntimeOptions`, `execute`, `run` | Validates, compiles, and runs a bounded plan a model authored.                                   |
| `TryCatchFinally` | `MakeOptions`, `RuntimeOptions`, `make`, `run`                                                                                                                                                                                           | Protects a body with a filtered recovery arm and a finalizer that always runs.                   |
| `WithApproval`    | `Approved`, `Options`, `make`, `withApproval`                                                                                                                                                                                            | Decorates a flow with an approval boundary.                                                      |
| `WithCache`       | `Options`, `Policy`, `Scope`, `CachePolicyAnnotation`, `policyOf`, `make`, `withCache`                                                                                                                                                   | Declares a cache policy on a flow, under the annotation identifier the engine reads at dispatch. |
| `WithRetry`       | `Backoff`, `Options`, `make`, `withRetry`, `retryEffect`                                                                                                                                                                                 | Decorates a flow with retry metadata and supplies an Effect retry helper.                        |

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

## What `WithCache` declares today

`WithCache` writes its policy under the annotation identifier
`@smthrs/flow/Action/CachePolicy`, which is the key `@smthrs/engine-store` reads
at dispatch. The durable engine executes `@smthrs/flow` actions, and flows HEAD
has no bridge from a `@smthrs/core` `Flow.make` descriptor to that interpreter,
so on a core flow the policy is a declaration: it renames the wrapper, enters its
captured key material, and travels with the flow until the bridge lowers it onto
the dispatched action. For a policy the engine acts on now, declare it on the
action with `CacheEnvironment.withCache(action, policy)` from `@smthrs/flow`. See
`docs/pages/api/step-cache.md`.
