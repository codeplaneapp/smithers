# 🐛 fix(driver): [medium] spawnCaptureEffect abort listener can SIGKILL a completed child

GitHub: https://github.com/smithersai/smithers/issues/683

via /codex review (pass 3)

Refs:
- `packages/driver/src/child-process.js:93` sends `SIGKILL` to `-child.pid` for detached children.
- `packages/driver/src/child-process.js:140` calls `killChildTree(child, detached)` before checking `settled`.
- `packages/driver/src/child-process.js:191` finalizes successful children but only clears timers.
- `packages/driver/src/child-process.js:217` registers the abort listener without keeping/removing it on successful close.

Failure scenario:
A caller passes an `AbortSignal` to `spawnCaptureEffect` for a detached child. The child exits successfully, `finalize()` sets `settled = true`, and the effect resolves. Later the same controller aborts during run shutdown/cancel cleanup. The stale listener still fires; because `kill()` calls `killChildTree()` before the `settled` guard, it attempts to kill the old child process group even though the process already completed. For detached children this is `process.kill(-child.pid, "SIGKILL")`.

Why it matters:
The shared process runner should be idempotent after a successful close. A late abort can produce false interruption logs and, in the worst case, kill a reused process group id or surviving descendants from an already-finished command. The abort listener should be removed in `finalize()` and `kill()` should return before touching the process when `settled` is already true.
