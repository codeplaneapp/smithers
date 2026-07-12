# Report live owners as busy instead of orphaned

GitHub: https://github.com/smithersai/smithers/issues/1055

Parent: smithers/stall-detection-calls-live-saturated-engine-orphaned.md

Context: Stale heartbeat classification and smithers why can describe a live engine as orphaned and recommend force resume.

Acceptance criteria:
- Verify the recorded driver PID or lock before classifying a stale run as orphaned.
- Report a live owner as engine busy with heartbeat lag and provide no force-resume recommendation.
- Preserve recovery guidance when the owner is demonstrably dead.
- Add coverage for live-owner, dead-owner, and heartbeat-lagging cases.


> Closed by ticket-fleet sync: apps/cli/src/why-diagnosis.js verifies the recorded owner PID, reports live owners as engine-busy with heartbeat lag and logs-only guidance, and preserves forced recovery for dead owners. packages/db/src/runState/deriveRunState.js applies the same stale-versus-orphaned classification. Coverage exists in apps/cli/tests/why-diagnosis-owner-liveness.test.js and packages/db/tests/runState-owner-liveness.test.js. Targeted verification passed: 25 CLI tests and 8 database tests.
