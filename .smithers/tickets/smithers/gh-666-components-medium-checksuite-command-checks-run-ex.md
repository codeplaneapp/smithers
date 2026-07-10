# 🐛 components: [medium] CheckSuite command checks run exec() with no timeout — a hanging command wedges the durable run and leaks the child

GitHub: https://github.com/smithersai/smithers/issues/666

_via ultracode (Opus multi-agent) review_

## Summary
`CheckSuite` command checks execute an arbitrary shell command via `exec` with no timeout at either the exec layer or the Task/engine layer, so a command that never exits hangs the entire run indefinitely and leaks the child process.

## References
- `packages/components/src/components/CheckSuite.js:71` — `await execAsync(command, { maxBuffer: 1024 * 1024 })` — no `timeout`, no `signal`.
- `packages/components/src/components/CheckSuite.js:111-119` — the command-check `Task` sets `id/output/continueOnFail/label` but no `timeoutMs`.
- `packages/engine/src/engine.js:4288-4293` — the compute-callback path only pushes a `TASK_TIMEOUT` race when `desc.timeoutMs` is truthy; with none set, the promise runs unbounded (races only against the abort signal).
- Contrast `packages/components/src/components/delegation/withCommitRange.js:4,15` — every subprocess probe is bounded by `timeout: VCS_PROBE_TIMEOUT_MS` (5s).

## Failure scenario
A workflow uses `<CheckSuite checks={[{ id: 'tests', command: 'npm test' }]} .../>` and the command blocks — a test runner dropping into interactive watch mode, a process that reads the still-open stdin pipe, or an attached `docker run`/server. `execAsync` never resolves, so the check's compute Task never settles, the enclosing `Parallel` and the `CheckSuite` `Sequence` never complete, and the run hangs indefinitely while holding the spawned child. `continueOnFail` does not help because the promise never rejects — it simply never returns. Because no `signal` is passed to `exec`, the child leaks even if the run is cancelled.

## Why it matters
One mis-behaving check command becomes an unrecoverable hang for the whole durable run (no completion, no failure, no retry escape) plus an orphaned subprocess, instead of the intended graceful pass/fail conversion the function performs for non-zero exits. Fix by passing a `timeout` (and `signal`) to the `exec` options and/or threading a configurable per-check `timeoutMs` onto the check Task, matching the bounded pattern already used in `withCommitRange`.
