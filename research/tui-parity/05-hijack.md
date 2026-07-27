# 05: hijack, generalized

Hijack = suspend the opentui renderer, hand the real terminal to another process with inherited stdio, resume when it exits. The primitive already exists and is correct; this phase generalizes what it can spawn and adds a picker.

## What exists (verified, keep byte-for-byte semantics)

`packages/tui/src/modes/hijackUtils.ts`, `startHijackSession({ renderer, spawnChild, killChild?, onDone })`:

1. `renderer.suspend()` inside a try.
2. `child = spawnChild()`.
3. `close` -> `resumeOnce(); onDone(code ?? null)`; `error` -> `resumeOnce(); onDone(null)`; a throw in 1-2 -> `resumeOnce(); onDone(null)`.
4. Returns cleanup `() => { kill(child); resumeOnce(); }`.
5. `resumeOnce` is settled-guarded so `renderer.resume()` runs exactly once across every path, and is try/caught for an already-destroyed renderer.

`HijackMode.tsx` facts to preserve:

- Spawn options `{ stdio: "inherit", detached: SUPPORTS_PROCESS_GROUPS }` (non-win32), so `killHijackChild` can signal the whole process group (`process.kill(-pid, "SIGTERM")`) and catch agent grandchildren; falls back to `child.kill` on Windows/failure; no-ops once exited.
- Today's only command: `hijackCommand(runId, nodeId)` re-invokes the real smithers CLI (`SMITHERS_CLI` env, else `import.meta.resolve("@smithers-orchestrator/cli")` via `cliEntry.ts`) as `[argv0, cliPath, "hijack", runId, "--target", nodeId]`. Never a bare `smithers` on PATH; never `process.argv[1]` (would recurse into the TUI). Null CLI resolution renders "HIJACK unavailable".
- `HandingOff` keeps `onDone` in a ref so effect deps stay `[runId, nodeId, renderer]`; a fresh closure must not kill the live child.
- Phase order renders `handing-off`/`returned` before consulting candidates, so live event churn can never unmount the active session.
- Candidate picking: `hijackCandidates(nodes, events)` (event-derived live nodes union tree-status running/active), `pinnedHijackRows` pins picker rows by `runNodeKey` so a completing node cannot slide a different session under the cursor; departed rows relabel "ended".
- On clean exit the CLI itself resumes the run; the return banner only offers dismiss (no fake resume automation).

## Generalization: HijackTarget

```ts
export type HijackTarget = {
  id: string;                 // preset id or "custom"
  label: string;
  argv: string[];             // argv[0] resolved against PATH unless absolute
  cwd?: string;
  env?: Record<string, string>; // MERGED over process.env (unlike zmux)
};
```

- `startHijackSession` is untouched; a new pure `buildHijackSpawn(target)` maps a target to `spawnChild` options (inherit stdio, detached process group, cwd/env merge). Spawn failure (ENOENT) hits the existing error path -> resume + banner with the failing argv.
- The agent-session hijack becomes preset `agent-session` producing today's exact CLI argv; it stays the default when a running node is selected.
- Presets shipped: `agent-session`, `claude`, `codex`, `shell` (`$SHELL -l`), `htop`, `lazygit`, `editor` (`$EDITOR <path>` when invoked from a file context), `custom` (free-form command line, parsed with a small shell-words splitter in hijackUtils, unit-tested).
- Preset availability is checked with a PATH probe (pure function + injected `which`); unavailable presets render dimmed.
- Entry points: `h` in any mode opens the picker (node-scoped presets first when a run/node is in context); run-inspector action "open agent session" jumps straight to the preset.

## Testing

- Pure: `buildHijackSpawn`, shell-words splitting, preset availability, picker row pinning (extend existing hijack-mode tests; all no-TTY).
- Headless render: picker rendering with mixed availability.
- zmux e2e: hijack into `bash -c 'echo HIJACKED; read'`; `waitForCaptureContains "HIJACKED"` proves the child owns the pty; `session.send "\n"` ends it; then poll for the smithers-mon keybar to reappear (poll for overlay disappearance semantics: assert the RETURNED banner, then dismiss). Killing mid-hijack: send the picker's cleanup key and assert the group died (session capture shows the shell prompt again, no orphan: assert via `ps` in the harness).

## Later option (not v1): embedded panes over zmux

`client.attach` returns `{clientId, ..., replayBase64}` and every connection receives `pane_output` notifications (broadcast; base64), so a future TUI pane could EMBED another TUI instead of full-terminal handoff: create a zmux session for the child, render its output through a VT interpreter into an opentui buffer, forward keys with `session.send`/`sendKey`. Blockers documented in 06: no VT grid server-side (we would interpret client-side), `client.attach` resizes the pty to its rows/cols (must pass the pane size), backpressure discipline (drain continuously). This is why hijack v1 stays full-terminal handoff.
