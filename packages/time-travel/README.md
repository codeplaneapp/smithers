# @smthrs/time-travel

One injectable `TimeTravel` service — inspect, fork, rewind — over the journal
and engine-store contracts. It owns both in-memory and SQL state stores and
records effect-boundary evidence used to make time-travel decisions.

```sh
pnpm add @smthrs/time-travel
```

## Public API

Time travel is ONE injectable service. `TimeTravel` is exported flat — the
service key is the door — beside the namespaces you inject or integrate with,
also available from matching `@smthrs/time-travel/*` subpaths.

| Export                  | Public surface                                                                                                                                                                                                                                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TimeTravel`            | The service key. Operations `inspect(position, projection)`, `fork(position, options?)`, and `rewind(position, options?)`, where a `Position` is `{ runId, frame }`. `TimeTravel.layer` provides it from `TimeTravelStore`, `Journal`, `RunStore`, `CacheStore`, and `Jj`, and recovers on build.    |
| `Frame`                 | `Frame` schema/type plus `LineageEdgeKind` schema/type and `LineageEdge`.                                                                                                                                                                                                                            |
| `TimeTravelError`       | `TimeTravelErrorCode` schema/type, `TimeTravelError`, and `error(code, message, cause?)`.                                                                                                                                                                                                            |
| `TimeTravelStore`       | Models `Snapshot`, `Descendants`, `Audit`, `Receipt`, `ArchiveResult`, and `Fork`; `Service` / `TimeTravelStore` operations `snapshotAt`, `descendants`, `writeAudit`, `updateAudit`, `pendingAudits`, `archiveAndTruncate`, `createFork`, and `recordReceipt`; `make`, `makeNoop`, and `layerNoop`. |
| `MemoryTimeTravelStore` | `JournalRecord`, `MemoryState`, and `Options`; deterministic `make(options?)` and `layer(options?)`.                                                                                                                                                                                                 |
| `SqlTimeTravelStore`    | Database-backed `migrate`, `make`, and `layer`.                                                                                                                                                                                                                                                      |
| `EffectBoundary`        | The producer side: `EffectTier`, `EffectStatus`, `EffectRecord`, and `Description`; `eventType`; `guard`, `fromEntry`, and `fromEntries`.                                                                                                                                                            |

`Replay`, `Fork`, `Rewind`, `Retry`, `Recovery`, `Compensation`, and
`EffectHandlerRegistry` are internal machinery under `src/internal/`, blocked at
the package `exports` map. Recovery is never a call: building `TimeTravel.layer`
finishes or rolls back any rewind a crash interrupted.

```ts
import { TimeTravel } from "@smthrs/time-travel"
import { Effect } from "effect"

const rewound = Effect.gen(function*() {
  const timeTravel = yield* TimeTravel
  return yield* timeTravel.rewind({
    runId: "build-42",
    frame: { lineageId: "build-42/root", seq: 17 }
  })
})
```

See the [time-travel reference](../../docs/reference/time-travel.md) and
[time-travel concepts](../../docs/concepts/time-travel.md).
