# 🔒 fix(mcp): [high] destructive restore/time-travel tools run without explicit confirmation

GitHub: https://github.com/smithersai/smithers/issues/685

via /codex review (pass 3)

Refs:
- `apps/cli/src/mcp/semantic-tools.js:446` defines `rewindRunInputSchema` with `confirm`.
- `apps/cli/src/mcp/semantic-tools.js:1538` describes `rewind_run` as destructive and requires `confirm=true`.
- `apps/cli/src/mcp/semantic-tools.js:1547` enforces that guard before mutating state.
- `apps/cli/src/mcp/semantic-tools.js:455` defines `restoreCheckpointInputSchema` without any confirmation field.
- `apps/cli/src/mcp/semantic-tools.js:1571` marks `restore_checkpoint` destructive, then `apps/cli/src/mcp/semantic-tools.js:1597` calls `runRestoreOnce()` immediately.
- `apps/cli/src/mcp/semantic-tools.js:496` defines `timeTravelInputSchema` without confirmation; `force` only applies to currently-running runs.
- `apps/cli/src/mcp/semantic-tools.js:1666` marks `time_travel` destructive, then `apps/cli/src/mcp/semantic-tools.js:1682` calls `timeTravel()` for non-running runs without an explicit confirm step.

Failure scenario:
An MCP client or agent with access to semantic tools can call `restore_checkpoint` after listing snapshots and immediately mutate the local worktree. It can also call `time_travel` on a completed/failed run and reset run state/dependents without passing any explicit acknowledgement. `destructiveHint: true` is advisory metadata; it is not an enforcement boundary, and this file already treats `rewind_run` as dangerous enough to require an in-schema `confirm=true` guard.

Why it matters:
These tools mutate durable run state and/or the user's worktree. Accidental tool selection, prompt injection through inspected run content, or a client that does not enforce MCP annotations can cause irreversible local changes with only ordinary tool arguments. `restore_checkpoint` and `time_travel` should require an explicit confirmation field (and reject without it) just like `rewind_run`.
