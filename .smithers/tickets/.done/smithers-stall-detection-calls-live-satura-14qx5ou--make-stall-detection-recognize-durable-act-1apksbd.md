# Make stall detection recognize durable activity under load

GitHub: https://github.com/smithersai/smithers/issues/1054

Parent: smithers/stall-detection-calls-live-saturated-engine-orphaned.md

Context: High-concurrency engines can continue persisting events while heartbeat timers are delayed. The monitor currently relies on heartbeat freshness, causing healthy busy runs to emit run-stalled.

Acceptance criteria:
- Use an unsaturable liveness signal or recent persisted event activity.
- A run with recent persisted events must not emit run-stalled solely because its heartbeat is late.
- Add regression coverage for continued event persistence with skipped heartbeats.


> Closed by ticket-fleet sync: apps/cli/src/claude-mirror/runClaudeMonitor.js tracks recent persisted event activity and suppresses run-stalled when heartbeat lateness is the only stale signal. apps/cli/tests/claude-mirror-monitor-stall.test.js covers continued event persistence with skipped heartbeats and confirms no stall, plus the quiet-run regression. Focused test run passed: 4 pass, 0 fail.
