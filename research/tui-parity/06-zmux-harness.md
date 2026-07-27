# 06: the zmux e2e harness

zmux (`/Users/williamcory/zmux`) is a tmux-style PTY daemon in Zig. We drive full-screen TUI tests through it from Bun TS. There is no npm package and no TS/JS anywhere in the zmux repo; this harness is the first non-Zig client. Everything below was verified against source (HEAD 4e7071e).

## Daemon facts

- Binaries (all built by `zig build`): `zmuxd` + alias `smithers-session-daemon` (same source), `zmux-connect` + `smithers-session-connect`. Prebuilts currently exist in `zig-out/bin/` (arm64 Mach-O).
- Zig 0.15.2 EXACT (build.zig comptime-fails on any other version; CI pins 0.15.2). No `.zigversion` file.
- Transport: unix socket, one JSON object per `\n`-terminated line, max 1 MiB per request line (overflow: `-32700` then connection close). The server does NOT validate JSON-RPC 2.0 on requests: only `{method: string}` is required; `id` optional; responses/notifications always carry `"jsonrpc":"2.0"`. Use integer ids (the demux convention matches on integer ids).
- Flags (complete set): `--socket PATH`, `--idle-seconds N` (default 3600; `<= 0` disables idle exit; idle exit also requires zero live sessions), `--version`, `--help`. Unknown flag: exit 1.
- Lifecycle: `setsid()` but NO fork, so `Bun.spawn` owns it directly. Exclusive flock on `<socket>.lock`; if a live daemon already answers on the socket it exits 0 immediately WITHOUT serving, so instant exit 0 means "someone else owns this socket". SIGTERM/SIGINT graceful.
- Security: peer euid must equal the daemon's (SO_PEERCRED / getpeereid; other platforms fail closed). A rejected client sees silent EOF after connect, no error frame. Socket chmod 0600. Linux + macOS only.
- Socket path budget: `sun_path` is ~104 bytes; the Zig tests use `/private/tmp` on Darwin. Keep harness socket paths short (NOT the deep scratchpad tmpdir).

## Protocol corrections that shape the client (vs the program prompt)

1. `session.create` takes NO caller session id: `id` aliases the TITLE. The result is the pane infoJson and its `id` field IS THE PANE ID (`pane-N-<hex>`); route every subsequent `session.send/capture/sendKey/resize` through that returned pane id (any of `sessionId|id` params resolve pane id, pane title, session id, or session name).
2. `command` is a SHELL STRING, not argv: spawn is `execvpe(shell, [shell, "-l", "-c", command])`; `shell` defaults to `$SHELL` else `/bin/zsh` (mac) / `/bin/sh`. No command -> interactive `[shell, "-l"]`.
3. `env` REPLACES the entire child environment (no merge), values coerced to strings; zmux never sets TERM. Either omit `env` (inherit the daemon's) or pass a complete env including TERM, PATH, HOME.
4. `session.capture {sessionId, lines=200}` returns `{sessionId, text}`: RAW PTY bytes with ANSI escapes intact from a 10 MiB byte ring; `lines` counts `\n` backwards from the tail. There is NO VT emulator/grid anywhere. Assert substrings/regex on the tail; for byte-exact output use `pane_output` notifications (base64) or `client.attach.replayBase64` (capped at the newest 256 KiB).
5. Notifications broadcast to EVERY connection (no attach needed): `pane_output {pane_id, data_base64}`, `pane_activity`, `pane_bell`, `session_exited {session_id, pid, exit_code, signal}` (session_id holds the pane id), `foreground_changed` (500 ms poll). Params are snake_case; RPC results are camelCase.
6. Backpressure is fatal: each connection has a 1 MiB outbound queue; overflow closes YOUR socket. Read in chunks (64 KiB) with an incremental line splitter; never block the read loop. Connection cap 256.
7. `session.send {text, enter}`: `enter: true` appends `"\r"` (not `\n`); when `dataBase64` is present `enter` is ignored. `session.sendKey` names (case-insensitive): `C-<letter>` only (no C-4/C-Space/M-x), Enter/Return, Tab, Backspace, Escape/Esc, Space, arrows (Up/Down/Right/Left with or without Arrow prefix), Home, End, PageUp, PageDown, Insert, Delete, F1-F12. Unknown key: `-32602 UnknownKey`.
8. `session.resize` and `client.attach` DEFAULT missing rows/cols to 24/80, and `client.attach` actually resizes the pty; always pass rows/cols explicitly.
9. Missing/wrong-typed numeric params silently fall back to defaults; there is no request validation to lean on.
10. Full method surface (27): daemon.ping/shutdown, session.create/info/list/terminate/rename/resize/capture/send/sendKey, mux.snapshot, window.new/select/rename, pane.split/select/rename/respawn, client.attach/detach/switch/list, key.bind/dispatch/list, command.exec (split-window/new-window/respawn-pane only).

## The Bun client (e2e/tui/zmux/)

Location: `e2e/tui/` inside the existing `e2e` workspace (its `test` script is plain `bun test`, so `pnpm -C e2e test -- tui` path-filters to the suite). Product code never imports this; it is test infrastructure.

```
e2e/tui/zmux/
  zmuxDaemon.ts     boot/own a daemon per test file
  zmuxClient.ts     persistent-socket client (chunked reads, line demux)
  zmuxRpc.ts        one-shot rpcLine + typed method wrappers
  zmuxWait.ts       waitForCaptureContains / waitForSessionExited / waitForSocket
  zmuxBin.ts        binary resolution + skip logic
```

API sketch (transliterating `test/integration/session_daemon.zig` helpers):

```ts
resolveZmuxd(): string | null
  // SMITHERS_ZMUXD_BIN -> PATH lookup (zmuxd, smithers-session-daemon)
  // -> ../zmux/zig-out/bin/zmuxd relative to the repo checkout, else null.
export const describeZmux = describe.skipIf(resolveZmuxd() === null || win32)

startDaemon(): Promise<ZmuxDaemon>
  // short socket path (/private/tmp/zmux-e2e-<pid>-<n>/s.sock),
  // Bun.spawn([bin, "--socket", sock, "--idle-seconds", "0"]),
  // waitForSocket(sock, 2000) by connect-retry every 10ms,
  // guard: instant exit 0 => throw "socket already owned".
  // dispose(): SIGTERM, await exit, rm socket dir.

class ZmuxClient {
  // Bun.connect({ unix }); 64 KiB chunked reads + carry-buffer line splitter;
  // integer id counter; pending map keyed by id; notification ring + waiters.
  request(method: string, params?: object, timeoutMs = 5000): Promise<any>
  notifications(method?: string): AsyncIterable<Notification>
  close(): void
}

createSession(client, { command, cwd, env, rows = 24, cols = 80, title }):
  Promise<{ paneId: string, pid: number }>   // returns result.id AS paneId

capture(client, paneId, lines = 50): Promise<string>
waitForCaptureContains(client, paneId, needle, timeoutMs = 8000): Promise<string>
  // poll capture every 50ms until needle appears; throw CaptureTimeout with
  // the last capture tail embedded in the error message.
waitForSessionExited(client, paneId, { expectExitCode?, timeoutMs = 8000 })
  // demux session_exited notifications where params.session_id === paneId.
sendText(client, paneId, text, { enter = false })
sendKey(client, paneId, key)
resize(client, paneId, rows, cols)
```

## Determinism rules

- Fixed geometry: create every session with explicit `rows: 24, cols: 80` (or the size under test) and never rely on defaults.
- Env: pass a COMPLETE env: `{ TERM: "xterm-256color", NO_COLOR: "1", CI: "1", PATH, HOME, ...gateway vars }` (rule 3: env replaces). NO_COLOR trims most ANSI noise; capture still contains cursor movements, so assert content substrings, never screen equality.
- One daemon per test file, one session per test; terminate sessions in afterEach (`session.terminate`), daemon in afterAll.
- Isolated state: each spawned smithers-mon/CLI gets its own workspace dir + DB (env override), or a live dev singleton poisons runs (real-PTY harness precedent).
- Overlay tests poll for the overlay to DISAPPEAR, not for background text to reappear (background stays mounted and matchable).
- Cancel discipline: a paused/waiting-approval run rejects direct RPC cancel (`RUN_NOT_ACTIVE`); use the CLI cancel command in cleanup; run status string is `finished`, not `succeeded`.
- Gate on nested agent harnesses: unset vendor agent env vars in the session env (PTY behavior differs inside another agent harness).

## The first e2e (phase 1 exit criterion)

Boot a real gateway with a seeded run (reuse `packages/tui/tests/seededGateway.ts` shape), start the daemon, `createSession` running `bun <tui entry> <runId>` with the complete env + gateway vars at 80x24, then `waitForCaptureContains` on the run's workflow name in the header, sendKey `?` and assert the help overlay text, sendKey `q` and `waitForSessionExited` with exit 0.

## CI story

- Suites skip cleanly (describeZmux) when no binary is found; that keeps every runner green without Zig.
- A dedicated CI job builds zmux: checkout `williamcory/zmux` at a pinned sha, `mlugg/setup-zig` 0.15.2, `zig build`, export `SMITHERS_ZMUXD_BIN`, run `pnpm -C e2e test -- tui`. Cache `zig-out` keyed on the zmux sha. Linux runner (peer-cred check is same-user, fine in CI). Vendoring prebuilt binaries into the smithers repo is rejected (platform matrix + binary blobs in git).
- Local: `zig build` in `/Users/williamcory/zmux` or use the existing `zig-out/bin/zmuxd`.
