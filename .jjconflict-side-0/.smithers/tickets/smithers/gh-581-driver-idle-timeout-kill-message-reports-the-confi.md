# 🐛 driver: idle-timeout kill message reports the configured timeout, not the Bun-floored effective one

GitHub: https://github.com/smithersai/smithers/issues/581

**What happens**
`packages/driver/src/child-process.js:142-144` computes `effectiveIdleTimeoutMs` (floored to the Bun minimum when running under Bun) and arms the idle timer with it, but the kill reason at :155 says `CLI idle timed out after ${idleTimeoutMs}ms` — the configured value.

**Why it's wrong / failure scenario**
On Bun with `idleTimeoutMs: 1000`, the process actually gets 5000ms of idle time, but the PROCESS_IDLE_TIMEOUT error and warning log claim 1000ms. Anyone debugging an idle-timeout kill is told a number that does not match observed timing.

**Expected behavior**
Report `effectiveIdleTimeoutMs` (or both: "after 5000ms (configured 1000ms, Bun floor)").

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).
