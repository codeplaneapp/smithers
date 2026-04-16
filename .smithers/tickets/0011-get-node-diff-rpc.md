# Add Per-Node Diff RPC with Caching

> Quality bar: spec §9. Every tier required.

## Context

Spec: `.smithers/specs/live-run-devtools-ui.md` §2.2 "Diff tab" and §4.2.

The gui's inspector pane Diff tab shows the unified git/jj diff for a
task. Today diffs are computed on-demand by `computeDiffBundle` but not
exposed via the gateway or cached. Both are added here.

## Scope

### 1. `getNodeDiff(runId, nodeId, iteration) → DiffBundle`

Gateway RPC. On call:

1. Validate inputs (see §Security below).
2. Check `_smithers_node_diffs` cache table.
3. On hit: return cached `diffJson`.
4. On miss: resolve the task's start + end jjPointer from
   `_smithers_attempts`; compute via
   `computeDiffBundle(baseJjPointer, jjCwd, seq)`.
5. Persist result to the cache table.

### 2. `_smithers_node_diffs` table

Schema:

```
runId TEXT NOT NULL
nodeId TEXT NOT NULL
iteration INTEGER NOT NULL
baseRef TEXT NOT NULL
diffJson TEXT NOT NULL           -- serialized DiffBundle
computedAtMs INTEGER NOT NULL
sizeBytes INTEGER NOT NULL       -- for cache-size metrics
PRIMARY KEY (runId, nodeId, iteration, baseRef)
```

Migration: additive only, idempotent (safe to re-run).

### 3. Single-flight compute

Concurrent calls with the same cache key must result in exactly one
compute + one DB write. Later callers wait on the first and receive the
same result.

### 4. Invalidation

- On `jumpToFrame` (ticket 0013): drop rows where the attempt's frameNo
  > targetFrameNo.
- No other invalidation (diffs are immutable once the attempt finishes).

### 5. Error codes

- `InvalidRunId`, `InvalidNodeId`, `InvalidIteration`.
- `RunNotFound`, `NodeNotFound`, `AttemptNotFound`.
- `AttemptNotFinished` — task is still running; diff not yet meaningful.
- `VcsError` — underlying JJ/git call failed; includes safe error detail.
- `WorkingTreeDirty` — base pointer can't be reverted cleanly.
- `DiffTooLarge` — > 50 MB serialized; return with truncation marker.

## Files (expected)

- `packages/db/src/internal-schema/smithersNodeDiffs.ts` (new)
- `packages/db/migrations/XXXX_add_node_diffs.sql` (new)
- `packages/db/src/cache/nodeDiffCache.ts` (new — single-flight wrapper)
- `packages/server/src/gatewayRoutes/getNodeDiff.ts` (new)
- `packages/server/src/gateway.ts` (register)
- `packages/protocol/src/errors.ts` (extend)
- `packages/db/tests/nodeDiffCache.test.ts` (new)
- `packages/server/tests/getNodeDiff.test.ts` (new)
- `packages/server/tests/getNodeDiff.integration.test.ts` (new — real JJ)

## Testing & Validation

### Unit tests — cache

- Cold hit writes to DB + returns; warm hit reads from DB without
  recomputing.
- Single-flight: 10 concurrent calls for same key → 1 compute call, 10
  identical results.
- Cache write failure (DB error) → still returns result, logs `warn`.
- Cached row missing optional column (forward-compat) → handles
  gracefully.
- Invalidation by frame truncation: insert rows, call invalidator,
  assert only expected rows remain.

### Unit tests — handler

- Valid request, cache miss, small diff → returns DiffBundle.
- Valid request, cache hit → returns DiffBundle, no VCS call made
  (verified via mock counter).
- AttemptNotFinished → returns typed error, no VCS call.
- 10 concurrent identical calls → one cache row written (observed via
  SQL).

### Input-boundary tests

| Case                              | Expected                        |
|-----------------------------------|---------------------------------|
| runId empty / > 64 chars / invalid | `InvalidRunId`                 |
| nodeId empty / > 128 chars         | `InvalidNodeId`                |
| nodeId with shell metachar         | `InvalidNodeId`                |
| iteration = -1                     | `InvalidIteration`             |
| iteration = 2^31                   | `InvalidIteration`             |
| iteration = 0 on task never run    | `AttemptNotFound`              |
| task still running                 | `AttemptNotFinished`           |
| task finished, no files changed    | `DiffBundle` with empty patches|
| 1 small file changed               | correct hunks                   |
| 1 file with 10,000-line change     | correct hunks                   |
| 1 binary file changed              | `binaryContent` populated       |
| 100 files changed                  | all patches present             |
| diff > 50 MB                       | `DiffTooLarge` or truncation marker |
| Non-UTF8 filename                  | encoded correctly               |
| File renamed                       | patch shows rename              |

### Integration tests (real JJ)

- Run a small workflow where task A writes `foo.txt`. Call
  `getNodeDiff` — assert patch contains the expected addition.
- Task modifies existing file → patch contains correct hunk with line
  numbers.
- Task deletes a file → patch shows deletion.
- Task writes and then deletes — net result is no file, patch is empty
  (or correctly reflects intermediate).
- Run against git-backed (not JJ) project → clear error or compatible
  behavior, whichever the spec decides (add a decision note).

### Performance tests

- Cached call: < 10ms p95.
- Cold call on 1-file diff: < 200ms p95.
- Cold call on 100-file diff: < 2s p95.
- Single-flight under 100 concurrent callers: compute count = 1,
  no caller waits > 2× the cold-call time.

## Observability

### Logs

- `info` on every call: `{ runId, nodeId, iteration, result: "hit"|"miss"|"error", durationMs, sizeBytes }`.
- `warn` on VCS anomalies (pointer revert failed cleanly, retried).
- `warn` on cache write failure.
- `error` on unrecoverable VCS / DB errors.
- Never log diff content or file paths at `info` (paths OK at `debug`).

### Metrics

- Counter: `smithers_node_diff_request_total{result}`.
- Histogram: `smithers_node_diff_compute_ms`.
- Histogram: `smithers_node_diff_bytes`.
- Counter: `smithers_node_diff_cache_total{hit|miss}`.
- Gauge: `smithers_node_diff_cache_rows` (total rows, emitted every
  5 min).

### Traces

- Span `devtools.getNodeDiff` (root) with attrs `runId`, `nodeId`,
  `iteration`, `cacheResult`.
- Span `db.nodeDiffs.get`, `db.nodeDiffs.upsert`.
- Span `vcs.computeDiffBundle` with `fileCount`, `bytes`.

## Security

- Gateway auth required.
- Input validation per §9.5.
- Cross-run attempt → rejected (scope check).
- Diff content returned verbatim — no sanitization (authorized caller
  has access to the run's files already).

## Acceptance

- [ ] All unit + integration + boundary tests pass.
- [ ] Single-flight verified under concurrency.
- [ ] Performance budgets met.
- [ ] Migration is idempotent.
- [ ] Invalidation hook callable from 0013 (interface defined).
- [ ] All error codes returned from their triggers.
- [ ] Logs + metrics + traces emitted as documented.
- [ ] No diff content in logs above `debug`.

## Blocks

- smithers/0014 (CLI exposes via `smithers diff`)
- gui/0078 (Diff tab)
