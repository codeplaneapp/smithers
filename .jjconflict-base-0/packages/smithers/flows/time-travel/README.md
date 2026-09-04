# @smthrs/time-travel

**Documentation:** https://time-travel.smithers.sh

One injectable `TimeTravel` service, with replay, inspect, fork, and rewind,
over the journal and engine-store contracts. It owns both in-memory and SQL
state stores and records effect-boundary evidence used to make time-travel
decisions.

```sh
pnpm add @smthrs/time-travel
```

## Public API

Time travel is ONE injectable service. `TimeTravel` is exported flat — the
service key is the door — beside the namespaces you inject or integrate with.
Every module is also reachable at the matching `@smthrs/time-travel/*` subpath;
`@smthrs/time-travel/internal/*` is blocked at the `exports` map.

| Export                  | Public surface                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TimeTravel`            | The service key. Operations `replay(position, projection, options?)`, `inspect(position, projection)`, `fork(position, options?)`, and `rewind(position, options?)`, where a `Position` is `{ runId, frame }`. Beside it: `Service`, `Projection`, `ReplayOptions`, `ForkOptions`, `RewindOptions`, `ForkResult`, `RewindResult`, `Options` (`isAlive`, `maxHistoryEntries`), `defaultMaxHistoryEntries`, `make`, `makeWith`, `layer`, and `layerWith`. A fork's jj workspace is named after the child run it mints, under `ForkOptions.workspaceRoot`, and pinned at the frame's recorded pointer. |
| `Frame`                 | `Frame` schema/type, `LineageEdgeKind` schema/type, `LineageEdge`, plus `forkCreatedEventType` and the `ForkCreated` payload a forked run records on its own journal.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `TimeTravelError`       | `TimeTravelErrorCode` schema/type, `TimeTravelError`, and `error(code, message, cause?)`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `TimeTravelStore`       | Models `Snapshot`, `AttemptRef`, `Descendants`, `Audit`, `AuditPatch`, `Receipt`, `ArchiveResult`, `Fork`, and `ForkIntent`; `Service` operations `snapshotAt`, `recordSnapshot`, `stateAt`, `attemptsAt`, `descendants`, `writeAudit`, `updateAudit`, `pendingAudits`, `archiveAndTruncate`, `archivedAt`, `nextForkId`, `abandonForkIntents`, `createFork`, and `recordReceipt`; `make`, `makeNoop`, and `layerNoop`.                                                                                                                                                                             |
| `MemoryTimeTravelStore` | `JournalRecord`, `MemoryState`, and `Options`; deterministic `make(options?)` and `layer(options?)`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `SqlTimeTravelStore`    | Database-backed `migrate`, `make`, and `layer`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `EffectBoundary`        | The producer side: `EffectTier`, `EffectStatus`, `EffectRecord`, and `Description`; `eventType`; `guard`, `decodeEntry`, `fromEntry`, and `fromEntries`. Prefer `decodeEntry`: `fromEntry` returns `undefined` for a corrupt payload instead of failing closed.                                                                                                                                                                                                                                                                                                                                     |
| `CompensationHandlers`  | The contribution door: the `Handler` shape (`kind`, `tier`, `requiresIdempotencyKey`, `compensation`, `residue`, `assess`, `revert`, `rollback`), the `Classification` and `Assessment` schemas a custom `assess` is decoded against, the optional service, `layer(handlers)`, and `layerNoop`.                                                                                                                                                                                                                                                                                                     |
| `Migrations`            | The same DDL as a rung on the shared migration ladder at id block `5000`: `set`, `sets`, `run`, and `layer`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

`Replay`, `Fork`, `Rewind`, `Retry`, `Recovery`, `Compensation`,
`SnapshotProjector`, `HistoryLimit`, and `EffectHandlerRegistry` are internal
machinery under `src/internal/`. Recovery is never a call: building
`TimeTravel.layer` finishes or rolls back any rewind a crash interrupted, and
forgets the jj lane of any fork that reserved an id and died before it
committed.

`replay` and `inspect` are one fold. `replay` takes the read knobs
(`pageSize`, `maxHistoryEntries`); `inspect` is the same fold under the
service defaults.

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
The [API reference](https://smithers.sh/docs/reference/api/time-travel) carries the full table,
generated from `TimeTravelErrorCode` itself; in short:

`busy` (another owner holds the run), `live_parent` / `live_child` (the run or a
descendant is still executing), `not_found` (the run or frame addresses
nothing), `invalid` (a malformed option or an undecodable durable payload),
`already_crossed` (the effect already crossed its durable boundary),
`rate_limited`, `compensation_failed` (a rollback or workspace restore failed),
`irreversible` (a crossed effect cannot be undone), `fence_lost` (ownership was
superseded before a mutation committed), `limit_exceeded` (the operation would
read more journal entries than `maxHistoryEntries` allows), and `unknown`.

## Limits

- The SQL store is SQLite dialect only. PostgreSQL and PGlite are unsupported.
- Journal reads page at 100 entries by default; `pageSize` is a throughput knob
  and never changes a derived answer.
- Every read is capped by `maxHistoryEntries`: the prefix a replay folds, or
  the suffix a fork or rewind assesses. The default is 100,000 entries
  (`TimeTravel.defaultMaxHistoryEntries`); `TimeTravel.layerWith({ maxHistoryEntries })`
  changes the service default and each verb's options override it per call.
  An operation past the cap fails `limit_exceeded`, a rewind before it claims
  the run. A replay streams the fold and stops at the frame; a fork or rewind
  keeps only the effect-boundary records of the suffix it assesses.
- A fork that reserved its id and died before committing leaves its jj lane
  registered until the next build of `TimeTravel.layer`, which forgets lanes
  whose reservation is older than five minutes. The reserved ordinal is never
  handed out again, so the retry lands under a fresh lane name.
- `Projection.reduce` receives store entries by reference. Treat them as
  read-only.
- Time travel is a library API in 1.0.0-rc.0: no CLI verb, no MCP tool, and it
  is not composed into `NodeControl`.

## Documentation

Prose about this package lives in [`docs/`](./docs) and is generated into the
site; see [the API reference](https://smithers.sh/docs/reference/api/time-travel) and
[time travel concepts](https://smithers.sh/docs/concepts/time-travel).
