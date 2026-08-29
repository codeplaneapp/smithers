# @smthrs/patterns

Browser-safe higher-order flow patterns and decorators for flows. It composes `@smthrs/core` declarations at plan time and includes runtime helpers only where retries or iterative host execution are required.

```sh
npm install @smthrs/patterns
```

## Public API

The root entry point exports these namespaces; each is also importable from `@smthrs/patterns/<Module>`.

| Module            | Public exports                                                                                                   | Description                                                                         |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `Bounded`         | `AllOptions`, `RuntimeOptions`, `all`, `run`                                                                     | Joins a record of members at most `concurrency` at a time, highest priority first.  |
| `Debate`          | `Turn`, `MakeOptions`, `make`                                                                                    | Builds a bounded alternating debate followed by a judge flow.                       |
| `Escalation`      | `Rung`, `MakeOptions`, `RuntimeRung`, `RuntimeOptions`, `Reached`, `Exhausted`, `defaultEscalate`, `make`, `run` | Declares a staged ladder with per-rung escalation and a fallback rung, and runs it. |
| `MapReduce`       | `OnEmpty`, `MakeOptions`, `make`                                                                                 | Fans input out through a map flow and combines results with a reducer.              |
| `Panel`           | `MakeOptions`, `RuntimeOptions`, `make`, `run`                                                                   | Runs a fixed panel of flows and aggregates their outputs.                           |
| `Pattern`         | `Slot`, `slot`, `bind`, `Decorator`, `Clipped`, `clipped`, `decorate`, `decorateAll`                             | Defines typed slots and the common flow-decorator composition primitives.           |
| `PatternError`    | `PatternErrorCode`, `PatternError`                                                                               | Defines typed pattern declaration and runtime failures.                             |
| `Quarantine`      | `Policy`, `Quarantined`, `AllOptions`, `RuntimeOptions`, `isQuarantined`, `all`, `run`, `settle`                 | Fans out a record of members and isolates a failing one from its siblings.          |
| `Recursion`       | `Envelope`, `RecurseOptions`, `Branch`, `recurse`                                                                | Builds explicit bounded recursive branches.                                         |
| `ReviewLoop`      | `MakeOptions`, `RuntimeOptions`, `Exhausted`, `make`, `run`                                                      | Declares and runs bounded generate/review/revise loops.                             |
| `Saga`            | `OnFailure`, `Step`, `MakeOptions`, `RuntimeStep`, `RuntimeOptions`, `Compensated`, `make`, `run`                | Runs forward steps and unwinds their compensations in reverse on failure.           |
| `TryCatchFinally` | `MakeOptions`, `RuntimeOptions`, `make`, `run`                                                                   | Protects a body with a filtered recovery arm and a finalizer that always runs.      |
| `WithApproval`    | `Approved`, `Options`, `make`, `withApproval`                                                                    | Decorates a flow with an approval boundary.                                         |
| `WithCache`       | `Options`, `make`, `withCache`                                                                                   | Decorates a flow with cache policy metadata.                                        |
| `WithRetry`       | `Backoff`, `Options`, `make`, `withRetry`, `retryEffect`                                                         | Decorates a flow with retry metadata and supplies an Effect retry helper.           |

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
