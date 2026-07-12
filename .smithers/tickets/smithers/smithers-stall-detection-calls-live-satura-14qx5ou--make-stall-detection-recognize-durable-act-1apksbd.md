# Make stall detection recognize durable activity under load

GitHub: https://github.com/smithersai/smithers/issues/1054

Parent: smithers/stall-detection-calls-live-saturated-engine-orphaned.md

Context: High-concurrency engines can continue persisting events while heartbeat timers are delayed. The monitor currently relies on heartbeat freshness, causing healthy busy runs to emit run-stalled.

Acceptance criteria:
- Use an unsaturable liveness signal or recent persisted event activity.
- A run with recent persisted events must not emit run-stalled solely because its heartbeat is late.
- Add regression coverage for continued event persistence with skipped heartbeats.
