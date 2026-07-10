# 🐛 fix(cli): [medium] restore can hang the CLI and MCP server on unbounded jj restore

GitHub: https://github.com/smithersai/smithers/issues/684

via /codex review (pass 3)

Refs:
- `apps/cli/src/restore.js:21` defines `defaultRevert()`.
- `apps/cli/src/restore.js:25` runs `spawnSync(bin, ["restore", "--from", commitId], { cwd, encoding: "utf8" })` with no timeout or abort path.
- `apps/cli/src/restore.js:77` uses that default from `runRestoreOnce()`.
- `apps/cli/src/index.js:7000` exposes this through `smithers restore`.
- `apps/cli/src/mcp/semantic-tools.js:1571` exposes the same path through the MCP `restore_checkpoint` tool.

Failure scenario:
If `jj restore --from <commit>` hangs because the repo lock is stuck, the jj binary is a wrapper that blocks, or the worktree is on a slow/broken filesystem, `spawnSync` blocks the Node/Bun event loop indefinitely. For `smithers restore` the command never returns. For the MCP server, the whole server is stuck inside the synchronous restore, so other tool calls, cancellation, and shutdown cannot be processed.

Why it matters:
Restore is a durability/recovery path, so it needs bounded failure behavior. An unbounded synchronous subprocess can turn a single stuck VCS operation into a wedged CLI or control-plane server. Use an async process runner with a timeout and abort handling, or at least set a conservative `spawnSync` timeout and report a typed restore failure.
