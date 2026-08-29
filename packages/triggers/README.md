# @smthrs/triggers

Durable cron triggers, overlap and catch-up policies, verified inbound channels, and a Clock-driven scheduler for flows. It stores fire claims atomically and dispatches scheduled or webhook work through explicit runner and Control boundaries.

```sh
npm install @smthrs/triggers
```

## Public API

The root entry point exports these namespaces; top-level modules are also importable from `@smthrs/triggers/<Module>`.

| Module                     | Public exports                                                                                                                                                                                | Description                                                                                  |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `CatchUp`                  | `occurrences`                                                                                                                                                                                 | Selects bounded missed occurrences for `none`, `one`, or `all` catch-up.                     |
| `Channel`                  | `RawInbound`, `Start`, `Signal`, `Inbound`, `Verify`, `Channel`, `Config`, `make`                                                                                                             | Declares verified inbound channels that start runs or deliver signals.                       |
| `Cron`                     | `Cron`, `parse`, `next`, `previousAtOrBefore`, `occurrencesBetween`                                                                                                                           | Parses cron expressions and computes schedule occurrences.                                   |
| `Overlap`                  | `State`, `Action`, `decide`, `pendingAfter`                                                                                                                                                   | Implements pure `skip`, `buffer-one`, and `supersede` overlap decisions.                     |
| `Schedule`                 | `Overlap`, `CatchUp`, `Schedule`, `make`                                                                                                                                                      | Validates standalone schedule declarations.                                                  |
| `Scheduler`                | `StartInput`, `RunnerService`, `Runner`, `makeRunner`, `makeNoopRunner`, `layerNoopRunner`, `layerControlRunner`, `Options`, `Service`, `Scheduler`, `make`, `makeNoop`, `layer`, `layerNoop` | Claims due fires, dispatches runs, and provides scoped or inert scheduler layers.            |
| `SqlTriggerStore`          | `make`, `layer`                                                                                                                                                                               | Implements TriggerStore over the database service.                                           |
| `Trigger`                  | `Overlap`, `CatchUp`, `Trigger`, `make`                                                                                                                                                       | Validates durable flow trigger declarations.                                                 |
| `TriggerError`             | `TriggerErrorCode`, `TriggerError`                                                                                                                                                            | Defines typed cron, declaration, store, scheduler, and webhook failures.                     |
| `TriggerStore`             | `Registered`, `Fire`, `ClaimFire`, `Claim`, `Outcome`, `Result`, `Service`, `TriggerStore`, `makeNoop`, `layerNoop`                                                                           | Defines registration, due lookup, atomic fire claims, and result recording.                  |
| `Webhook`                  | `constantTimeEqual`, `SignatureConfig`, `makeSignatureVerifier`, `Config`, `Webhook`, `make`                                                                                                  | Builds raw-byte signature verification and webhook channel declarations.                     |
| `test/TestTriggers`        | `layer`                                                                                                                                                                                       | Provides a public in-memory TriggerStore test layer at `@smthrs/triggers/test/TestTriggers`. |
| `migrations/0001_triggers` | default migration effect                                                                                                                                                                      | Creates the trigger and fire tables as a direct public subpath.                              |

```ts
import { Scheduler } from "@smthrs/triggers"
import { Effect } from "effect"

const program = Effect.gen(function*() {
  const scheduler = yield* Scheduler.Scheduler
  return yield* scheduler.runOnce
}).pipe(Effect.provide(Scheduler.layerNoop))
```

Use `SqlTriggerStore.layer`, `Scheduler.layerControlRunner`, and `Scheduler.layer()` for durable scheduling. The nested migration aggregator is blocked by the export map; only the migration file above is directly importable. `@smthrs/triggers/package.json` is also exported, while `internal/*` and nested `*/index` subpaths are not public.
