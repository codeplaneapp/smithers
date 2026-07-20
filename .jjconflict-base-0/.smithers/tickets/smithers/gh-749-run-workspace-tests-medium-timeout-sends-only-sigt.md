# 🐛 run-workspace-tests: [medium] timeout sends only SIGTERM (no SIGKILL escalation), so a child that ignores it hangs the shard forever

GitHub: https://github.com/smithersai/smithers/issues/749

_via ultracode (Opus multi-agent) review_

**Summary:** The per-package timeout in the shard runner only delivers SIGTERM with no SIGKILL follow-up, so a test child that ignores/traps SIGTERM never fires `close` and the shard blocks past its deadline indefinitely.

**Location:**
- `scripts/run-workspace-tests.mjs:207` — timeout timer sets `timedOut=true` and calls `killProcessTree(child)` but does not resolve the promise.
- `scripts/run-workspace-tests.mjs:163-180` — `killProcessTree` sends only `process.kill(-child.pid, "SIGTERM")` (fallback `child.kill("SIGTERM")`), no SIGKILL.
- `scripts/run-workspace-tests.mjs:228` — the promise resolves solely inside `child.on("close")`, which fires only when the process group actually exits.
- `scripts/run-workspace-tests.mjs:273-275` — sequential `await runPackageTest(...)` loop blocks until each promise settles.

**Failure scenario:** A package test spawns (directly or transitively) a process that ignores/traps SIGTERM — e.g. a wedged sandbox/gateway child or a bun process stuck in a native call. After `timeoutMinutes`, SIGTERM is delivered and ignored, `close` never fires, and the awaited `runPackageTest` never resolves. The loop blocks forever; the shard produces no per-package summary and hangs until the outer CI job timeout kills everything.

**Why it matters:** The timeout exists to bound a hung package and continue reporting. Without a SIGKILL escalation (a second timer that force-kills, e.g. `process.kill(-child.pid, "SIGKILL")`, N seconds after SIGTERM if `close` hasn't fired), one unkillable child converts a bounded per-package failure into an unbounded CI hang with no result summary.
