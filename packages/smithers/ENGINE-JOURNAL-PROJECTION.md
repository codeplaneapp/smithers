# Recorded engine evidence in control runs

The private `src/internal/EngineJournalProjection.ts` helper projects the existing
durable engine journal into the existing control journal. It adds no database,
table, public package export, execution service, or gateway procedure. The caller
establishes which native execution belongs to the control run before constructing
the helper.

```ts
const projection = yield * EngineJournalProjection.make({
  controlRunId,
  executionId,
  engineJournal,
  controlJournal,
  engineState // existing DurableEngineState.runChildren
})
const follower = yield * Effect.forkScoped(projection.follow)
// Execute through the existing registered engine/catalog.
yield * projection.catchUp
```

For one accepted native launch, start
`projection.followUntilSettled(engineRunStore)` in the host scope. It tolerates
the run row not existing yet, waits while the root is nonterminal, then performs
another catch-up after reading the committed terminal row. A handler-scoped
follower is insufficient: the driver commits the handler's terminal result after
the handler returns. The host may keep ordinary `follow` alive for detached work
that outlives the native root. Trampoline continuation rows are not automatically
traversed as spawn edges; this helper does not infer them from execution IDs.

The host owns the scope and can share one follower per control run through its
existing resource map. `catchUp` completes after the copied entries have durable
destination receipts. A projection refusal remains a `JournalError` (or a
`RunStoreError` when reading settlement); it does not
prove that an already-executed native effect failed or authorize repeating it.
This helper alone does not install the host wiring or render coding statuses.

## Internal event envelopes

`control.engine.event` uses the existing open `ControlEvent.payload` contract:

```ts
{
  version: 1,
  executionId: string,
  generation: number,
  sequence: number,
  eventId: string,
  sourceId: string,
  sourceSequence: number,
  emittedAtMs: number,
  eventType: string,
  payload: unknown,
  meta: unknown
}
```

The nested native kind, payload, metadata, timestamp, and identities come from
the committed journal entry. An encoded result appears only if that entry
contains it. Nothing reconstructs an outcome from current source, an attempt
status, or a model prediction. Control ingestion has its own sequence and time;
the envelope retains the native coordinates separately.

The wrapper is deliberate. `ControlLive` exposes journal payload but not metadata,
and its generic ancestry/monitor folds must not interpret a child's native run
decision as the control root's own lifecycle. Existing wire schemas remain
unchanged; readers opt into the native envelope explicitly.

`control.engine.projection-gap` records the execution, generation, and reason:
`rewound`, `compacted`, `sequence-gap`, or an actual journal read failure code.
Applicable native sequence boundaries accompany it. A gap is evidence of missing
or discontinuous observation, never a fabricated completion or passing check.
If the source transaction or generation lookup itself fails, the gap has
`generation: null` and preserves `lastObservedGeneration` separately. It does not
guess the current generation from a stale cursor.

## Replay and ownership

The helper walks `DurableEngineState.runChildren` edges from the authorized native
root and deduplicates a shared child within a traversal. Similar execution-ID
prefixes establish no ownership. Removing an edge stops future traversal through
it; already-recorded observations remain historical evidence.

Native journal pages contain at most 256 entries. A source transaction reads the
page and rewind generation consistently, then releases its lock before writing
the control journal. The destination producer ID hashes the native execution and
generation. Its source sequence is the native journal's global per-run sequence,
which distinguishes native producers that reuse their own source sequence.

A cursor advances only after the destination's durable receipt. Exact retries,
including a lost acknowledgement, use the journal's existing content deduplication.
Restarting the helper rereads source pages and deduplicates them; there is no new
durable cursor store. A rewind uses a new producer generation, retains prior
evidence, and records a discontinuity. Compaction records the unavailable prefix
before resuming after the source's checkpoint floor.

Live following uses `Journal.changes` only as a wake hint plus the journal's same
one-second durable recheck pattern. Authoritative paging detects cross-process
writes, lost local wakeups, newly linked children, and rewinds below an old cursor.
`catchUp` and following serialize within one helper. Ordering across different
native executions is observation order, not an invented global execution clock.

## Validation

Tests use real SQLite journal/store layers. They cover native outcome preservation,
multiple producers, durable child edges and prefix lookalikes, restart deduplication,
lost destination acknowledgements, changed values at a reused sequence after
rewind, compaction and missing sequences, multi-page replay, new children, source
read failure/recovery, and a separate SQLite writer whose local notifications
cannot wake the source journal. The last test exercises the durable recheck.
Settlement coverage commits final evidence between the earlier page read and the
terminal run-row read, so only the final drain can include that record. It also
starts following before the native run row exists and verifies source transaction
and generation failures remain visible without inventing a current generation.
