# Add Live Run DevTools Tree Streaming RPC

> Quality bar for this ticket is **§9 Quality Standards** in the spec.
> Every test tier below is required; no category may be "noted as follow-up".

## Context

Spec: `.smithers/specs/live-run-devtools-ui.md` §3 and §4.2.

The gui renders the running workflow as a React DevTools-style XML tree.
It needs to subscribe to tree state for a run and receive full snapshots +
structural deltas as frames land. We ship the pre-processed `DevToolsNode`
tree over the wire so the rendering contract lives in one place.

## Scope

### 1. `streamDevTools(runId, fromSeq?) → AsyncIterable<DevToolsEvent>`

Live subscription. On connect: emit one full `DevToolsSnapshot`. Thereafter:

- `{ kind: "snapshot", snapshot: DevToolsSnapshot }` — full rebaselines,
  emitted every 50 events or when a structural upheaval makes a delta
  larger than a fresh snapshot.
- `{ kind: "delta", delta: DevToolsDelta }` — incremental ops.

On reconnect with `fromSeq`: resume from the nearest snapshot ≤ fromSeq +
deltas forward. If gaps can't be filled, emit a full snapshot.

### 2. `getDevToolsSnapshot(runId, frameNo?) → DevToolsSnapshot`

One-shot fetch. `frameNo` defaults to latest. Used for time-travel scrub
and finished-run viewing.

### 3. `DevToolsDelta` codec + `diffSnapshots(a, b)`

New module in `packages/devtools/`. Ops: `addNode`, `removeNode`,
`updateProps`, `updateTask`. Keyed by `DevToolsNode.id`.

### 4. Protocol types

Add `DevToolsSnapshot`, `DevToolsDelta`, `DevToolsEvent` to
`packages/protocol/src/`. Versioned (`version: 1`).

### 5. Error codes (typed)

- `RunNotFound` — runId does not exist.
- `InvalidRunId` — fails `/^[a-z0-9_-]{1,64}$/`.
- `FrameOutOfRange` — frameNo < 0 or > latestFrameNo.
- `SeqOutOfRange` — fromSeq is in the future relative to current seq.
- `BackpressureDisconnect` — subscriber's send queue exceeded 1000
  events; server disconnected.
- `Unauthorized` — auth fail (delegated to Gateway middleware).

## Files (expected)

- `packages/devtools/src/diffSnapshots.ts` (new)
- `packages/devtools/src/applyDelta.ts` (new)
- `packages/devtools/src/snapshotSerializer.ts` (new — stable serialization
  for prop objects, handles circular refs + large payloads safely)
- `packages/devtools/src/index.ts` (export)
- `packages/protocol/src/devtools.ts` (new — wire types)
- `packages/protocol/src/errors.ts` (extend with new error codes)
- `packages/protocol/src/index.ts` (re-export)
- `packages/server/src/gatewayRoutes/streamDevTools.ts` (new)
- `packages/server/src/gatewayRoutes/getDevToolsSnapshot.ts` (new)
- `packages/server/src/gateway.ts` (register)
- `packages/devtools/tests/diffSnapshots.test.ts` (new)
- `packages/devtools/tests/applyDelta.test.ts` (new)
- `packages/devtools/tests/snapshotSerializer.test.ts` (new)
- `packages/server/tests/streamDevTools.test.ts` (new)
- `packages/server/tests/getDevToolsSnapshot.test.ts` (new)
- `packages/server/tests/streamDevTools.soak.test.ts` (new, opt-in with
  `SMITHERS_SOAK=1`)

## Testing & Validation

### Unit tests — `diffSnapshots` + `applyDelta`

- Round-trip: `applyDelta(a, diffSnapshots(a, b))` deep-equals `b` — for
  **every** op kind and for:
  - Empty → single root node.
  - Single root → nested 5-deep.
  - Nested 5-deep → flat 20-wide.
  - Swap two siblings (addNode + removeNode).
  - Change only props on a leaf.
  - Change only task sidecar on a leaf.
  - 100-node tree → same tree (no-op delta, ops = []).
  - 1000-node tree → delete half the subtree.
- `applyDelta` with an unknown target id → typed `InvalidDelta` error,
  state unchanged.
- `applyDelta` with two ops mutating the same node → deterministic order.

### Unit tests — `snapshotSerializer`

- Serializes scalars, arrays, objects, null, undefined, booleans.
- Large string (1 MB) passes through.
- Circular reference → replaced with `"[Circular]"` marker, does not
  throw.
- Non-serializable values (Function, Symbol, Date, BigInt) → replaced
  with `"[Date: ...]"` / `"[Function]"` / etc., never throws.
- Depth > 100 → truncates with `"[MaxDepth]"`.

### Unit tests — RPC handlers

- `getDevToolsSnapshot` with valid runId + frameNo → returns correct
  snapshot matching `SmithersDevToolsCore.captureSnapshot`.
- `getDevToolsSnapshot` with `frameNo = undefined` → returns latest.
- `streamDevTools` initial emit is always a snapshot.
- `streamDevTools` with `fromSeq = 0` on a run with no frames → emits
  empty snapshot, does not hang.
- `streamDevTools` closes cleanly on client cancellation (no leaked
  subscription in the gateway subscriber map — asserted via test
  inspector).

### Input-boundary tests

| Case                             | Expected                                      |
|----------------------------------|-----------------------------------------------|
| runId = "" (empty)               | `InvalidRunId`                                |
| runId = 65 chars                 | `InvalidRunId`                                |
| runId = "../etc/passwd"          | `InvalidRunId`                                |
| runId with emoji                 | `InvalidRunId`                                |
| runId = valid but missing        | `RunNotFound`                                 |
| frameNo = -1                     | `FrameOutOfRange`                             |
| frameNo = 2^53                   | `FrameOutOfRange`                             |
| frameNo = 0 on run with frames   | first frame returned                          |
| frameNo = latest + 1             | `FrameOutOfRange`                             |
| fromSeq = -1                     | `SeqOutOfRange`                               |
| fromSeq = current + 1            | `SeqOutOfRange`                               |
| fromSeq > latest keyframe gap    | emit full snapshot, log warn                  |
| tree with 0 nodes                | snapshot with empty root, no error            |
| tree with 10,000 nodes           | streams snapshot in < 500ms, no crash         |
| node prop string 10 MB           | serialized + streamed, no truncation          |
| tree depth 100                   | serialized, no stack overflow                 |
| tree depth 1000                  | truncates at MaxDepth with marker             |
| unicode in tag/name              | round-trips without corruption                |

### Integration tests

- Drive a real workflow (3 tasks, 1 parallel, 1 sequence) via the
  engine. Subscribe to `streamDevTools`. Assert that the sequence of
  snapshot + delta events reconstructs the tree at each frame to match
  `SmithersDevToolsCore.captureSnapshot` called directly.
- Run a workflow that causes a reconciler re-render (hot-reload
  simulation). Assert the stream emits a full snapshot on structural
  upheaval rather than a giant delta.

### Concurrency tests

- 10 concurrent subscribers on the same run. All receive the same event
  sequence (mod ordering guarantees — each receives monotonic seq).
- Subscriber joins mid-stream. Receives initial snapshot, then catches
  up via deltas.
- Slow subscriber (consumes 1 event / sec while producer emits 100/sec).
  Server queues up to 1000; then emits `BackpressureDisconnect` and
  cleans up. Assert no other subscribers are affected.
- Subscriber cancels during a delta computation. No exception, no leak,
  cancellation log at `info`.
- Reconnect storm: 100 clients reconnect with fromSeq simultaneously.
  Server handles without OOM.

### Performance tests

Budgets (failing budget = failing CI):

- `captureSnapshot` for 500-node tree: < 50ms p95.
- `diffSnapshots(a, b)` between 500-node trees with 10 changes: < 10ms
  p95.
- `streamDevTools` initial emit for 500-node tree: < 100ms p95 wall
  clock to first byte.
- Delta emit: < 10ms p95.
- Memory: 1-hour soak at 10 events/sec → RSS does not grow by more
  than 50 MB from baseline.

### Soak test

Opt-in (`SMITHERS_SOAK=1`): simulate a workflow emitting 100 events /
sec for 30 minutes with 5 concurrent subscribers. Pass = no crash, no
memory growth, every event delivered in order to every subscriber.

## Observability

### Logs (structured)

- `info` on subscribe: `{ runId, fromSeq, subscriberId }`.
- `info` on unsubscribe: `{ runId, subscriberId, eventsDelivered, durationMs }`.
- `debug` on each snapshot emit: `{ runId, seq, frameNo, nodeCount, bytes, durationMs }`.
- `debug` on each delta emit: `{ runId, seq, opCount, bytes, durationMs }`.
- `warn` on fromSeq gap that forces full re-baseline.
- `warn` on circular ref / depth truncation during serialization.
- `error` on backpressure disconnect, DB errors, serializer failures.
- Never log prop values / prompts / outputs.

### Metrics

- Counter: `smithers_devtools_subscribe_total{result}`.
- Counter: `smithers_devtools_event_total{kind=snapshot|delta}`.
- Histogram: `smithers_devtools_snapshot_build_ms`.
- Histogram: `smithers_devtools_delta_build_ms`.
- Histogram: `smithers_devtools_event_bytes`.
- Gauge: `smithers_devtools_active_subscribers{runId=...}` — bounded
  cardinality by truncating runId to hash if > 1000 runs.
- Counter: `smithers_devtools_backpressure_disconnect_total`.

### Traces

- Span `devtools.streamDevTools` (root) with attrs `runId`, `fromSeq`.
- Span `devtools.captureSnapshot` with attrs `nodeCount`, `bytes`.
- Span `devtools.diffSnapshots` with attrs `opCount`, `bytes`.
- Span `db.frames.get` with attrs `runId`, `frameNo`.

## Security

- Gateway auth required (existing middleware — assert via test).
- Input validators reject malformed runId / fromSeq / frameNo **before**
  any DB or reconciler call.
- Subscriber cannot request frames from a different run (auth scope
  check — add test for cross-run attempt).
- No prop values logged even at `debug`.

## Acceptance

Every one of these must be true, verified by an automated test unless
noted:

- [ ] All unit test cases above pass in CI.
- [ ] All input-boundary table entries pass.
- [ ] Integration test drives a real workflow end-to-end; assertions pass.
- [ ] All concurrency tests pass.
- [ ] Performance budgets met (CI fails if exceeded).
- [ ] Soak test passes locally (`SMITHERS_SOAK=1 bun test`).
- [ ] All error codes listed above are returned from their documented
      triggers.
- [ ] Structured logs emitted at the documented points (verified via
      log-capture harness in tests).
- [ ] Metrics registered and incremented (verified via OTel
      test-exporter).
- [ ] Trace spans emitted (verified via OTel test-exporter).
- [ ] No prop values appear in any log at any level.
- [ ] New types exported from `@smithers/protocol` and version-tagged.
- [ ] Protocol doc updated with the new RPCs and error codes.

## Blocks

- smithers/0014 (CLI)
- gui/0074 (wire client)
