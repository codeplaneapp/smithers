# @smthrs/time-travel

One injectable `TimeTravel` service — inspect, fork, rewind — over the journal
and engine-store contracts. It owns both in-memory and SQL state stores and
records effect-boundary evidence used to make time-travel decisions.

```sh
pnpm add @smthrs/time-travel
```

## Public API

Time travel is ONE injectable service. `TimeTravel` is exported flat — the
service key is the door — beside the namespaces you inject or integrate with.
Every module is also reachable at the matching `@smthrs/time-travel/*` subpath;
`@smthrs/time-travel/internal/*` is blocked at the `exports` map.

| Export                  | Public surface                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TimeTravel`            | The service key. Operations `inspect(position, projection)`, `fork(position, options?)`, and `rewind(position, options?)`, where a `Position` is `{ runId, frame }`. Beside it: `Service`, `Projection`, `ForkOptions`, `RewindOptions`, `ForkResult`, `RewindResult`, `Options` (`isAlive`), `make`, `makeWith`, `layer`, and `layerWith`. A fork's jj workspace is named after the child run it mints, under `ForkOptions.workspaceRoot`, and pinned at the frame's recorded pointer. |
| `Frame`                 | `Frame` schema/type, `LineageEdgeKind` schema/type, `LineageEdge`, plus `forkCreatedEventType` and the `ForkCreated` payload a forked run records on its own journal.                                                                                                                                                                                                                                                                                                                   |
| `TimeTravelError`       | `TimeTravelErrorCode` schema/type, `TimeTravelError`, and `error(code, message, cause?)`.                                                                                                                                                                                                                                                                                                                                                                                               |
| `TimeTravelStore`       | Models `Snapshot`, `AttemptRef`, `Descendants`, `Audit`, `AuditPatch`, `Receipt`, `ArchiveResult`, and `Fork`; `Service` operations `snapshotAt`, `recordSnapshot`, `stateAt`, `attemptsAt`, `descendants`, `writeAudit`, `updateAudit`, `pendingAudits`, `archiveAndTruncate`, `archivedAt`, `nextForkId`, `createFork`, and `recordReceipt`; `make`, `makeNoop`, and `layerNoop`.                                                                                                     |
| `MemoryTimeTravelStore` | `JournalRecord`, `MemoryState`, and `Options`; deterministic `make(options?)` and `layer(options?)`.                                                                                                                                                                                                                                                                                                                                                                                    |
| `SqlTimeTravelStore`    | Database-backed `migrate`, `make`, and `layer`.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `EffectBoundary`        | The producer side: `EffectTier`, `EffectStatus`, `EffectRecord`, and `Description`; `eventType`; `guard`, `decodeEntry`, and `fromEntries`.                                                                                                                                                                                                                                                                                                                                             |
| `CompensationHandlers`  | The contribution door: the `Handler` shape, the optional service, `layer(handlers)`, and `layerNoop`.                                                                                                                                                                                                                                                                                                                                                                                   |
| `Migrations`            | The same DDL as a rung on the shared migration ladder at id block `5000`: `set`, `sets`, `run`, and `layer`.                                                                                                                                                                                                                                                                                                                                                                            |

`Replay`, `Fork`, `Rewind`, `Recovery`, `Compensation`, `SnapshotProjector`, and
`EffectHandlerRegistry` are internal machinery under `src/internal/`. Recovery is
never a call: building `TimeTravel.layer` finishes or rolls back any rewind a
crash interrupted.

A lineage id is minted, never spelled. `FlowEngine.Lineage` is the one
constructor for it, the engine stamps its result on every record a run writes,
and the encoding is versioned. This package only stores and compares the value,
so it takes no dependency on the engine; the example reaches the constructor
through `@smthrs/flows`, the barrel a caller already installs.

```ts
import { Engine } from "@smthrs/flows"
import { TimeTravel } from "@smthrs/time-travel"
import { Effect } from "effect"

const rewound = Effect.gen(function*() {
  const timeTravel = yield* TimeTravel
  return yield* timeTravel.rewind({
    runId: "build-42",
    frame: { lineageId: Engine.FlowEngine.Lineage.root("build-42"), seq: 17 }
  })
})
```

## Failure behaviour

Every operation fails as a `TimeTravelError` discriminated by a closed `code`.
The [API reference](https://smithers.sh/api/time-travel) carries the full table,
generated from `TimeTravelErrorCode` itself; in short:

`busy` (another owner holds the run), `live_parent` / `live_child` (the run or a
descendant is still executing), `not_found` (the run or frame addresses
nothing), `invalid` (a malformed option or an undecodable durable payload),
`already_crossed` (the effect already crossed its durable boundary),
`rate_limited`, `compensation_failed` (a rollback or workspace restore failed),
`irreversible` (a crossed effect cannot be undone), `fence_lost` (ownership was
superseded before a mutation committed), and `unknown`.

## Limits

- The SQL store is SQLite dialect only. PostgreSQL and PGlite are unsupported.
- Journal reads page at 100 entries by default; `pageSize` is a throughput knob
  and never changes a derived answer.
- A rewind and a fork materialize the suffix they cross in memory, and refuse a
  suffix past a fixed bound rather than exhausting the process while a run's
  ownership is held.
- `Projection.reduce` receives store entries by reference. Treat them as
  read-only.
- Time travel is a library API in 1.0.0-rc.0: no CLI verb, no MCP tool, and it
  is not composed into `NodeControl`.

## Documentation

Prose about this package lives in [`docs/`](./docs) and is generated into the
site; see [the API reference](https://smithers.sh/api/time-travel) and
[time travel concepts](https://smithers.sh/concepts/time-travel).
