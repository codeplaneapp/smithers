# runState/

Derives the user-facing `RunStateView` (running / waiting-* / stale / orphaned
/ …) from persisted rows.

- `deriveRunState` is the pure classifier; `computeRunStateFromRow` loads the
  pending approval/timer/event context from a `SmithersDb` adapter and calls it;
  `computeRunState` resolves the run first (throws `RUN_NOT_FOUND`).
- `parseEventMeta` / `parseTimerMeta` leniently parse attempt `meta_json`
  written by the engine's durable-deferred bridge; malformed JSON degrades to
  `null`, never throws. `parseEventMeta` delegates to the package-level
  `parseWaitForEventAttemptSnapshot` so the blocked reason reads the same
  `{ waitForEvent: { signalName, correlationId } }` shape the adapter's
  `findRunsAwaitingEvent` matches on, and reports `correlationId` (or the
  `signalName` when the wait declares none) as the `correlationKey`.
- `RUN_STATE_HEARTBEAT_STALE_MS` (30s) is the running→stale threshold; a stale
  run is only reported `"orphaned"` when its owner is not demonstrably alive:
  no `runtimeOwnerId` at all (nothing for the supervisor to take over), or a
  recorded owner PID that fails the liveness probe (`runtimeOwnerLiveness.js`,
  injectable via `isOwnerPidAlive`). A stale run whose owner PID is alive is
  `"stale"` — a busy engine with a lagging heartbeat, not a candidate for
  force-resume.
- The `.ts` sidecars (`RunState`, `RunStateView`, `ReasonBlocked`,
  `ReasonUnhealthy`, `DeriveRunStateInput`, `ComputeRunStateOptions`) define the
  wire contract pinned by `tests/runState-wire-contract.test.js`. Some
  `RunState` members (e.g. `"recovering"`) are produced by other layers, not by
  `deriveRunState`.
