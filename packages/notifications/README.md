# @smthrs/notifications

Durable notification queue, admission policy, and journal projection for flows. It models human and system notifications, derives queue state from journal events, and drains eligible work at harness boundaries.

```sh
npm install @smthrs/notifications
```

## Public API

The root entry point exports these namespaces; each is also importable from `@smthrs/notifications/<Module>`.

| Module              | Public exports                                                                                                                                    | Description                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `Notification`      | `Provenance`, `HumanSteer`, `HumanFollowup`, `SystemEvent`, `Notification`, `admissionClass`, `coalesceKey`                                       | Defines notification schemas, admission classes, and coalescing keys.      |
| `NotificationEvent` | `AdmittedEventType`, `PromotedEventType`, `Admitted`, `Promoted`, `Event`, `fromEntry`                                                            | Defines journal notification events and decodes them from journal entries. |
| `NotificationQueue` | `NotificationError`, `AdmissionReceipt`, `DrainInput`, `DrainReceipt`, `Service`, `NotificationQueue`, `make`, `makeNoop`, `layerNoop`, `layer`   | Defines the durable admit/drain service and its journal-backed layer.      |
| `NotificationState` | `Pending`, `AdmissionDecision`, `State`, `Admission`, `Promotion`, `empty`, `admit`, `pending`, `promoteSteers`, `promoteQueued`, `applyPromoted` | Implements the pure notification admission and promotion state machine.    |
| `Projection`        | `defaultCapacity`, `derive`                                                                                                                       | Derives notification state from journal entries.                           |

```ts
import { NotificationQueue } from "@smthrs/notifications"
import { Effect } from "effect"

const program = Effect.gen(function*() {
  const queue = yield* NotificationQueue.NotificationQueue
  return yield* queue.drain({
    runId: "run-1",
    targetLineageId: "root",
    boundary: "turn-close",
    wouldIdle: true
  })
}).pipe(Effect.provide(NotificationQueue.layerNoop()))
```

Use `NotificationQueue.layer` with Journal for durable operation. `@smthrs/notifications/package.json` is also exported; `internal/*` and nested `*/index` subpaths are blocked.
