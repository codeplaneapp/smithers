# runState/

Derives the user-facing `RunStateView` (running / waiting-* / stale / orphaned
/ …) from persisted rows.

- `deriveRunState` is the pure classifier; `computeRunStateFromRow` loads the
  pending approval/timer/event context from a `SmithersDb` adapter and calls it;
  `computeRunState` resolves the run first (throws `RUN_NOT_FOUND`).
- `parseEventMeta` / `parseTimerMeta` leniently parse attempt `meta_json`
  written by the engine's durable-deferred bridge; malformed JSON degrades to
  `null`, never throws.
- `RUN_STATE_HEARTBEAT_STALE_MS` (30s) is the running→stale threshold; a stale
  run with no `runtimeOwnerId` is reported `"orphaned"` (nothing for the
  supervisor to take over).
- The `.ts` sidecars (`RunState`, `RunStateView`, `ReasonBlocked`,
  `ReasonUnhealthy`, `DeriveRunStateInput`, `ComputeRunStateOptions`) define the
  wire contract pinned by `tests/runState-wire-contract.test.js`. Some
  `RunState` members (e.g. `"recovering"`) are produced by other layers, not by
  `deriveRunState`.
