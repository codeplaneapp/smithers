# Singleton gateway: one owner per store, one CLI per project

Status: engineering spec, approved direction from will (2026-07-02).
Fixes the anti-pattern of many smithers processes opening the same database
through different code paths. Two requirements:

1. A globally installed `smithers` delegates to the project-local install,
   the way `tsc` and `tsx` resolve the local package.
2. The CLI stops opening the workflow database directly. All access goes
   through a singleton gateway process per project: the daemon owns the
   store, executes runs, and serves every client (CLI, MCP, UI).

## Problem inventory (verified 2026-07-02)

How processes reach one `smithers.db` today:

- ~33 `findAndOpenDb` call sites in the CLI (`ps`, `inspect`, `approve`,
  `cancel`, `bug`, ...) open the store per invocation. The "read" mode is a
  lie twice over: approve/deny/signal/cancel/hijack/rewind write through it,
  and every open executes `ensureSmithersTables` DDL plus WAL/-shm
  registration (`packages/smithers/src/openSmithersStore.js:18`).
- Workflow modules open their own connection at import time
  (`createSmithers`, `packages/smithers/src/create.js:379`). `up`, `eval`,
  `graph`, `retry-task`, `gateway` boot, and the MCP server each import
  modules and collect more connections.
- Detached spawns multiply owners: `up -d`, the TUI launcher, the cron
  scheduler, the supervisor, and hijack each spawn a fresh CLI that opens
  the store independently.
- `chat-create` opens `resolve(cwd, 'smithers.db')` raw, bypassing anchor
  resolution (`apps/cli/src/index.js:7382`).
- The gateway already executes runs in-process and polls other processes'
  events into its streams (`outOfProcessEventBridge`), which exists only
  because the store has many writers.

Why this bites:

- No singleton: two `smithers ui` invocations race to autostart gateways on
  port 7331; the loser dies silently (`EADDRINUSE` is an unhandled `error`
  event, `stdio:'ignore'`), and the health poll then succeeds against
  whatever process owns the port, including another project's gateway.
- No identity: `/health` returns `{ok, protocol, features, stateVersion}`
  only. A client cannot tell which workspace or version answered.
- No auth wiring: `smithers ui` sends no bearer, `smithers gateway` accepts
  one static token and never reads the `~/.smithers` token store.
- Version skew per launch directory: the bin delegates only when
  `cwd/.smithers/node_modules/smithers-orchestrator` exists. From a project
  subdirectory the global CLI runs against the project's store.
- pglite is effectively single-process, yet every backend resolution can
  boot a PGlite instance, and reads boot a second one plus a socket server.

## Locked decisions

1. **The singleton is `smithers gateway`.** No new daemon. This matches the
   locked decision in `tanstack-db-sync-engine.md` ("the REST domain API
   lives in the existing gateway HTTP server"). That spec's `/v1/api/*`
   routes are the transport the CLI adopts; this spec adds daemon lifecycle,
   discovery, identity, and ownership.

2. **Delegation walks up from cwd.** When argv carries an explicit workflow
   path, the existing nearest-install walk from that path stays. Otherwise
   the bin walks up from cwd to the filesystem root (the same unbounded
   walk as `findLocalPackDir` and tsx/bunx; `findSmithersAnchorDir`'s HOME
   bound is a DB-placement rule, not a code-resolution rule), checking at
   each level `.smithers/node_modules/smithers-orchestrator` first, then
   `node_modules/smithers-orchestrator` (a project that depends on
   smithers-orchestrator directly delegates too). First hit wins; reaching
   `$HOME` and finding `~/.smithers/node_modules` delegates to the global
   pack's pinned runtime, consistent with `resolvePackDirs` serving
   `~/.smithers` workflows. The realpath self-guard stays. `.mdx` joins the
   workflow-path extension set. The bin stays dependency-free (node
   builtins only).

3. **Workspace identity on the wire.** `GET /health` and the WS `hello`
   gain `{workspaceRoot, backend, pid, version, startedAtMs}`. A client
   never trusts "some process answered on the port"; it verifies
   `workspaceRoot` matches the workspace it resolved locally, and treats a
   mismatch exactly like no gateway.

4. **Runtime state file outside the repo.** The daemon writes
   `<tmpdir>/smithers-gateway/<sha256(workspaceRoot)>.json` after `listen()`
   succeeds, mode 0600 (dir 0700): `{pid, host, port, url, token,
   workspaceRoot, backend, version, protocol, startedAtMs}`. Keeping it out
   of `.smithers/` sidesteps stale-`.gitignore` packs committing a token,
   and it dies with the machine like the pids it records. Discovery = read
   file, verify pid alive, verify `/health` identity, use the token. Stale
   state (dead pid, identity mismatch, connection refused) is deleted and
   treated as absent. `smithers gateway status` prints the path.

5. **Singleton enforcement via claim-then-verify.** A starting daemon
   creates `gateway.json.lock` with `O_EXCL`. On `EEXIST` it probes the
   incumbent: healthy and matching means this start aborts ("already
   running: pid, url"); stale means delete and retry once. The lock is
   removed after the state file is written. `smithers gateway status` and
   `smithers gateway stop` are new subcommands (stop = SIGTERM to the
   recorded pid, wait for health to drop, clean the state file).

6. **Port is discovered, never assumed.** The daemon prefers 7331 and falls
   back to an ephemeral port when taken. `Gateway.listen` gets an `error`
   listener so `EADDRINUSE` rejects instead of crashing the process
   (library bug fix). Clients resolve the port from the state file;
   `SMITHERS_GATEWAY_URL` / `--gateway` still override everything.

7. **Auth converges on a minted token, sequenced behind UI token
   injection.** `smithers gateway` gains `--mint-token`: mint a random
   bearer, record it only in the state file, require it on every request.
   CLI clients read the token from the state file (or `SMITHERS_TOKEN` /
   `SMITHERS_API_KEY`) and send it; `smithers ui` learns the bearer header
   either way. Minting cannot default ON until the gateway injects the
   token into the workflow-UI bundles it serves (today a custom UI in the
   browser has no way to obtain it; `SmithersGatewayProvider` only takes an
   explicit `options.token`), so: G1 ships the flag plus client-side bearer
   support, G2 ships UI token injection and flips the autostart default to
   minted. The `~/.smithers` token store stays the broker for issued
   grants; wiring `smithers gateway` to accept store-issued grants is a
   follow-up, out of scope here.

8. **CLI transport is the gateway domain API.** Read and control commands
   route through `/v1/api/*` (tanstack-db-sync-engine M1) plus the routes
   that surface the CLI's remaining needs: event history with filters, node
   detail aggregation, human requests (ask/answer/inbox), chat transcript,
   timeline, artifacts, workspace checkpoints, why-diagnosis, usage.
   Handlers delegate to the same internal functions the RPC methods use.
   Exit codes and output shapes are part of the contract: `ps` in an
   uninitialized directory prints an empty list and exits 0 without
   spawning anything; waiting statuses exit 3; progress lines land on
   stderr.

9. **Ownership invariant, staged honestly.** End state: when a daemon is
   running for a workspace, every process that wants the store goes through
   it. When none is running, transient direct access stays legal (that is
   what SQLite WAL is for), with one change shipped early: read-mode opens
   stop executing DDL (`ensureSmithersTables` moves out of the read path;
   missing tables fail loud). The daemon is the only long-lived owner:
   scheduler and supervisor loops run inside it, not as separate CLI
   processes, once G4 lands.

10. **Execution moves into the daemon (G4).** `launchRun` grows
    launch-by-path: `{path, input, env, rootDir, logDir, detach, runId}`.
    The env snapshot comes from the launching client, not the daemon's
    boot env. Foreground `up` becomes: ensure daemon, launch, stream
    events, reproduce today's stderr progress lines and exit codes;
    `--detach` returns after launch (the run lives in the daemon, no
    spawned child). Workflow modules are imported per launch with
    cache-busting so edits take effect. Graceful daemon shutdown parks
    in-flight runs as resumable (abort agents, cancel in-flight attempts,
    keep the run non-terminal with a released claim) instead of finalizing
    `cancelled`; the next daemon start resumes parked runs. Today's
    abort-to-cancelled stays only for explicit cancel.

11. **The daemonless engine path is permanent.** Sandboxes run
    `smithers up bundle.tsx` against a sandbox-local store; CI has no
    daemons; `SMITHERS_NO_DAEMON=1` (or `--no-daemon`) forces the embedded
    engine and direct store access for any command. This is an escape
    hatch, not a silent fallback: when a daemon should be reachable and is
    not startable, commands fail loud rather than quietly going direct.

12. **No unix sockets.** Loopback TCP + state-file token gives the same
    local security with one code path on all platforms, and the browser UI
    needs TCP anyway. `ws+unix:` client support stays as-is for advanced
    setups.

13. **Version skew is handled by delegation plus handshake.** Delegation
    makes the CLI and the daemon come from the same local install, which is
    the primary defense. The state file and `/health` carry the package
    version; a client whose own version differs in major, or whose
    protocol does not match, refuses with a message naming both versions
    and the fix (`smithers gateway stop` + restart, or `smithers update`).

## Milestones

Each lands green (typecheck + package tests + affected e2e) and is committed
atomically. G0 and G1 are independent of the tanstack work; G2+ sequence
after its M1 or absorb it if that work stalls.

### G0: delegation

`packages/smithers/src/bin/` only.

- Upward walk from cwd per decision 2; `.mdx` extension; keep helpers pure
  and unit-tested (`bin-smithers-delegation.test.js` matrix: cwd at root /
  subdir / outside project, `.smithers` install vs project `node_modules`
  vs both at different levels, HOME boundary, malformed package.json, self
  realpath).
- Process-level tests extend `apps/cli/tests/bin-delegation-unit.test.js`
  (fake JSON-marker installs, no npm): subdir invocation delegates; project
  `node_modules` delegates; nearer install beats farther.
- win32 guard on the signal re-raise (exit code fallback instead of
  `process.kill(pid, signal)`).

### G1: daemon primitives

- `EADDRINUSE` rejection in `Gateway.listen` + ephemeral-port fallback in
  the CLI (decision 6).
- Identity in `/health`, the `health` RPC, and hello (decision 3); the
  gateway learns `backend`/`version` from options passed by the CLI,
  `workspaceRoot` from the existing option.
- Runtime state file + lock + `--mint-token` (decisions 4, 5, 7).
- `smithers gateway status|stop`; `smithers gateway` refuses a second start
  against a healthy singleton.
- `smithers ui`/`gui` discovery order: explicit `--gateway` /
  `SMITHERS_GATEWAY_URL` > state file (verified) > claim + autostart + poll
  state file. Bearer sent when a token is known (state file,
  `SMITHERS_TOKEN`, `SMITHERS_API_KEY`). The TUI monitor keeps its
  `SMITHERS_GATEWAY_URL` pin and moves to state-file discovery in G2.

Acceptance: two concurrent autostarts yield one daemon and two working
clients; a second project autostarts on a different port and neither client
cross-attaches; killing the daemon leaves a stale state file that the next
discovery cleans up; `gateway status` reports identity; all with real
processes (no mocks), sqlite and pglite parameterized where the store
matters.

### G2: reads through the daemon

- Gateway grows the missing read routes (decision 8 list) on `/v1/api/*`.
- `ps`, `inspect`, `events`, `logs -f`, `output`, `diff`, `tree`, `node`,
  `why`, `chat`, `timeline`, `scores`, `snapshots`, `alerts`, `bug` route
  through a discovered daemon; `logs -f` consumes the SSE/stream surface
  instead of a 500ms poll loop.
- Read-mode DDL removal (decision 9).
- Without a running daemon these commands do NOT autostart one; they use
  the direct read path (now DDL-free). Autostart stays reserved for
  commands that need a server anyway (`ui`, `gui`, monitor) until G4 makes
  boot lazy.

### G3: control writes through the daemon

- `approve`, `deny`, `signal`, `cancel`, `down`, `human`, `ask-human`,
  `rewind`, `cron add/rm` go through the daemon when one is running.
- Durable cancel semantics move server-side: gateway `cancelRun` handles
  live-elsewhere (`cancel_requested_at_ms`) and stale runs (status flips),
  matching today's CLI behavior.
- Human-request routes (ask, answer, inbox) added.

### G4: execution ownership

- Launch-by-path RPC with env/rootDir/logDir (decision 10); `up`,
  `workflow run`, `--detach`, resume, `retry-task` route through the
  daemon; TUI launches via the daemon.
- Park-don't-cancel shutdown; daemon-start resume of parked runs.
- Scheduler and supervisor loops fold into the daemon; `smithers
  scheduler`/`supervise` become thin wrappers that ensure the daemon.
- Lazy workflow loading so daemon boot is fast enough for autostart from
  any command; module cache busting per launch.
- Lease semantics move from pid-liveness to daemon-heartbeat: runs owned by
  `gateway:<pid>:<uuid>`, per-run fiber accounting, `updateRun` gains the
  owner guard that only heartbeat/claim writes have today.

### G5: MCP, chat-create, docs

- MCP semantic tools take a gateway client instead of `openDb`; raw MCP
  inherits the fixed CLI commands for free.
- `chat-create` stops opening `cwd/smithers.db` raw.
- Docs sweep: `cli/overview`, `reference/db`, `integrations/gateway`,
  `deployment/*`, the rpc pages, skills, and `pnpm docs:llms` (CI gates on
  check-docs/check-llms).

## Test doctrine

No mocks anywhere: real gateways on real ports, real stores, fake agents
where a run is needed (CI has no agent CLIs). Discovery, lock contention,
stale-file cleanup, and identity mismatch get dedicated process-level
tests. Every gateway-routed command keeps a golden test asserting exit code
and output parity with the direct path. Backend-parameterized suites
(sqlite + pglite; postgres behind `SMITHERS_TEST_PG_URL`) for anything that
touches the store, per the pluggable-db testing bar.

## Out of scope

- Wiring the `~/.smithers` token store into gateway auth (follow-up).
- Remote daemons / multi-host (run-on-plue covers remote execution).
- Row-level sync, Electric, and the collection layer (tanstack spec owns
  those).
- Windows CI (Windows-specific guards land, but no CI leg exists).
