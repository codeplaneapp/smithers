# runState/

Derives the user-facing `RunStateView` (running / waiting-* / stale / orphaned
/ …) from persisted rows.

- `deriveRunState` is the pure classifier; `computeRunStateFromRow` loads the
  pending approval/timer/event context from a `SmithersDb` adapter and calls it;
  `computeRunState` resolves the run first (throws `RUN_NOT_FOUND`).
- `RunConcurrencySaturated` events become durable `warnings` on the view with
  requested demand, the effective automatic cap, and the remediation command.
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
  local recorded owner PID that fails the liveness probe, or a host-scoped
  remote owner whose durable heartbeat is stale. New owner IDs use
  `pid:<pid>@<hostname>:<session>`; only matching-host PIDs are probed. Legacy
  PID IDs without `@<hostname>` retain the single-host assumption. A stale run
  whose local owner PID is alive is `"stale"` — a busy engine with a lagging
  heartbeat, not a candidate for force-resume. An unrecognized owner shape is
  also `"stale"` because its death cannot be proven.
- The `.ts` sidecars (`RunState`, `RunStateView`, `ReasonBlocked`,
  `ReasonUnhealthy`, `DeriveRunStateInput`, `ComputeRunStateOptions`) define the
  wire contract pinned by `tests/runState-wire-contract.test.js`. Some
  `RunState` members (e.g. `"recovering"`) are produced by other layers, not by
  `deriveRunState`.
