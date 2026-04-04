# Delta-encode frames to eliminate DB bloat

## Problem

`_smithers_frames` is the #1 storage consumer in smithers databases, accounting for 95-99% of total DB size in long-running workflows. Measured across real production databases:

| DB | Total Size | `_smithers_frames` | % |
|----|-----------|-------------------|---|
| codeplane/specs/tui | 6.8GB | 7.3GB (with WAL) | 99% |
| codeplane | 5.8GB | 5.7GB | 98% |
| smithers (dev) | 45MB | 26MB | 56% |
| crush | 117MB | 28MB + 91MB snapshots | 78% |

Every render cycle stores the **full serialized XML tree** in `xmlJson`. A typical workflow re-renders hundreds to thousands of times during execution, but each render usually changes only 1-2 node states (e.g., `pending` → `in-progress`, `in-progress` → `finished`). The XML tree itself can be 100KB+ for a workflow with 700+ nodes, so storing it verbatim every frame wastes 99%+ of the space on duplicated content.

## Proposal

Delta-encode frames so only the difference from the previous frame is stored.

### Storage format

- **Frame 0 (keyframe):** Store the full `xmlJson` as today.
- **Frame N > 0 (delta frame):** Store a compact diff against frame N-1. The diff format should capture:
  - Changed node `state` values (the most common mutation)
  - Added/removed nodes (from conditional rendering)
  - Changed props on existing nodes
- **Periodic keyframes:** Every K frames (e.g., K=50), store a full keyframe to bound reconstruction cost and allow random access without replaying from frame 0.

### Reconstruction

To read frame N:
1. Find the nearest keyframe at or before N.
2. Apply deltas forward from the keyframe to N.
3. Cache the reconstructed XML for the current frame to avoid repeated reconstruction during the same engine loop iteration.

### Candidate diff strategies (pick one)

1. **Structural node diff:** Since the XML is a tree of typed nodes with stable IDs, diff at the node level — emit `{nodeId, field, oldValue, newValue}` tuples. Most frames would produce 1-3 tuples.
2. **JSON patch (RFC 6902):** Apply standard JSON patch operations against the canonicalized `xmlJson`. Generic but slightly larger diffs.
3. **Binary diff (e.g., zstd dictionary compression):** Compress each frame's `xmlJson` using the previous frame as a zstd dictionary. Zero application-level logic, good compression ratio, but opaque diffs.

Recommendation: option 1 (structural node diff) for maximum compression and debuggability. The renderer already produces typed `XmlNode` trees with stable IDs, so diffing is straightforward.

### Migration

- New frames use delta encoding; old frames remain readable as-is.
- Add a `encoding` column to `_smithers_frames` (`full` | `delta` | `keyframe`) defaulting to `full` for backwards compatibility.
- `insertFrame` checks if the previous frame exists and computes the delta automatically.
- **Graceful handling of old databases:** When opening a database created with the old schema (no `encoding` column), detect this via `PRAGMA table_info(_smithers_frames)` and run `ALTER TABLE _smithers_frames ADD COLUMN encoding TEXT NOT NULL DEFAULT 'full'`. All existing rows are implicitly `full` keyframes. This must happen in `ensureSmithersTables()` so it's automatic on first access — no manual migration step.

## Expected impact

- **95-99% reduction** in `_smithers_frames` table size for typical workflows.
- A 6.8GB database would shrink to ~50-100MB.
- Negligible CPU overhead — diffing two JSON trees of 700 nodes takes <1ms.
- Read path adds one delta-apply step per frame, cached for the hot path.

## Validation

- Unit test: round-trip encode/decode for keyframes and delta frames.
- Integration test: run a workflow, verify all frames reconstruct identically to the non-delta-encoded originals.
- Benchmark: measure DB size before/after on the `scripts/worktree-feature` example workflow.
- Verify `smithers inspect`, `smithers timeline`, `smithers diff`, and time-travel replay all work correctly with delta-encoded frames.

## Scope

- `src/db/adapter.ts` — `insertFrame` to compute and store deltas.
- `src/db/adapter.ts` or new `src/db/frame-codec.ts` — delta encode/decode logic.
- `src/engine/index.ts` — frame reading to reconstruct from deltas.
- Migration for the `encoding` column on `_smithers_frames`.
- `src/cli/index.ts` — any commands that read raw frames (inspect, timeline, diff).
