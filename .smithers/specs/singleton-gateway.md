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

## Production-readiness decisions (added 2026-07-02)

Context: users report smithers **breaking when multiple workflows run at
once**. This is the concrete failure the singleton owner exists to fix, not a
future nicety. The audit (2026-07-02) confirmed the mechanism. On the default
sqlite backend, concurrent runs are correctness-safe (WAL, per-event
`BEGIN IMMEDIATE` seq allocation, `busy_timeout=30000`, jittered write-retry),
but the code's own comments attribute those settings to fighting
`SQLITE_IOERR_VNODE` under multi-process WAL contention on macOS
(`packages/smithers/src/create.js:379-390`); heavy concurrency exhausts the
retry budget and surfaces as intermittent write failures. On pglite it is
worse: cross-process event-seq allocation serializes only under an in-process
promise mutex keyed on the client object, so two processes collide on the
`(run_id, seq)` primary key and `insertIgnore` silently drops an event
(`packages/db/src/adapter.js:2334-2360`), and a second `PGlite.create` against
the same data dir is invalid. Several cross-process races are latent regardless
of backend (run-creation TOCTOU on `up --run-id`, unguarded `updateRun`, cron
double-fire). The singleton daemon removes cross-process contention by making
one process the only writer. Decisions 14-19 make that daemon production-grade.

14. **Idle spin-down is a first-class requirement.** An autostarted daemon
    must exit on its own when it has nothing left to do, so users are not left
    with orphaned forever-daemons (today it lives until `gateway stop`, SIGTERM,
    or reboot; no idle path exists anywhere). "Nothing to do" = zero in-flight
    or parked runs AND zero attached clients (WS connections plus recent HTTP
    RPC within a short window) AND no due-soon gateway-registered cron or
    durable timer before the next idle check. Design: track last-activity on
    both the WS connection set (`this.connections`, already present) and every
    `handleHttpRpc` call; an interval (default 60s, `SMITHERS_GATEWAY_IDLE_MS`
    override, `0` disables) checks the three conditions and, when all idle,
    re-claims the autostart lock and re-checks atomically before calling the
    graceful-shutdown path, so a client attaching mid-decision is never
    stranded. Crons and durable timers count as activity: a daemon that owns a
    schedule does not idle-exit and silently stop firing it (a daemon with
    only schedules and no clients is a deliberate, documented "keep-alive"
    reason surfaced by `gateway status`). An explicitly launched
    `smithers gateway` (foreground/service) never idle-exits; only autostarted
    daemons do. Manual `--linger`/`--idle-timeout` flags override the default.

15. **50 concurrent runs is a supported, tested scale target.** The daemon must
    execute at least 50 concurrent workflow runs without event loss, cross-run
    corruption, unbounded memory, or fd exhaustion, proven by a real (no-mocks)
    test in CI. Concretely this forces: (a) admission control on `launchRun`
    (a daemon-wide concurrency semaphore with a bounded queue; today `startRun`
    runs immediately with no cap, `packages/server/src/gateway.js`), because
    50 runs times the per-run task cap of 4 (`DEFAULT_MAX_CONCURRENCY`,
    `packages/engine/src/engine.js:849`) times ~3 pipe fds per agent subprocess
    plus one `caffeinate` child per run exceeds the macOS default 256-fd soft
    limit at roughly 21 runs; (b) freeing per-run in-memory event windows on
    run completion (`runEventWindows` is inserted but never deleted,
    `gateway.js:1334` + trim at `:1842`, a lifetime-of-daemon leak at up to
    10k frames per run); (c) bounding `AgentTraceCollector.events`, which
    retains every raw stdout chunk until node end
    (`packages/engine/src/AgentTraceCollector.js:91`); (d) a runId to
    subscriber index so `broadcastEvent` stops scanning every connection per
    event (`gateway.js:3752`); (e) one `caffeinate` for the daemon, not one per
    run. See the concurrency test in the test doctrine below.

16. **Local security is not optional once the daemon owns execution.** An
    unauthenticated daemon exposes `launchRun` (real compute and shell), so
    the following are required before autostart may default to running an
    exposed server: (a) **Host-header validation / DNS-rebinding defense** on
    every HTTP and WS request (today nothing inspects `req.headers.host` and
    the Origin allow-list treats empty as allow, `gateway.js:3400-3440`, so a
    malicious web page can reach the loopback daemon as a same-origin target
    and call `launchRun`); accept only `localhost`/`127.0.0.1`/`[::1]` Host
    values or require auth unconditionally. (b) **The pglite socket must not
    publish the raw Postgres wire protocol with a passwordless superuser on
    loopback** (`PGLiteSocketServer` binds `127.0.0.1` with
    `postgres://postgres@...` and no password, `create.js:576-585`); any local
    process or other local user can `psql` straight into the store, bypassing
    the gateway and the single-owner invariant. Gate it behind a
    per-boot password or bind only when the daemon itself needs it. (c) **Never
    send bearer credentials to an endpoint that failed identity verification**
    (the legacy port-7331 fallback attaches the env bearer to an
    identity-less server, `index.js:2442-2481`). (d) **Per-uid runtime
    directory with ownership/mode verification** (state lives in a predictable
    shared `<tmpdir>/smithers-gateway` path with no stat/uid check on read,
    `gateway-runtime.js:71-125`, so on a multi-user box a hostile user can
    plant a state file and harvest the victim's env bearer). Use
    `XDG_RUNTIME_DIR` when set and verify owner+mode before trusting contents.
    (e) **Timing-safe token comparison** for parity with the webhook path that
    already uses `timingSafeEqual` (`gateway.js:3440` vs `:1269`).

17. **Crash recovery and daemon supervision.** Folding scheduler and supervisor
    into the daemon (G4) makes it a single point of failure, so it needs a
    recovery story, not just graceful shutdown. Requirements: (a) on daemon
    start, reconcile runs left `running` with stale heartbeats from a prior
    crash (resume or fail-loud, never leave them wedged); this is the same
    resume path G4 uses for parked runs but must not presume a graceful prior
    exit. (b) `gateway stop` must use the retrying, transient-aware health
    probe that discovery uses, not a single 1.5s fetch that clears the
    write-once state file on any blip and orphans a live daemon
    (`index.js:2622-2626`). (c) The daemon writes to a discoverable, rotated
    log file recorded in the state file and surfaced by `gateway status` (today
    autostart uses `stdio:'ignore'` and all boot output, including the minted
    token line, is discarded, `index.js:2399-2404`), so "why is this daemon
    running/wedged" is answerable. (d) `smithers gateway ls` enumerates
    daemons across workspaces for the current uid (today status/stop resolve
    only cwd, so N projects yield N invisible daemons). (e) A daemon whose
    workspace directory was deleted must still be stoppable. (f) The
    version/protocol handshake of decision 13 must be enforced client-side,
    not merely advertised, so an old never-exiting daemon after `npm update`
    fails loud instead of serving stale engine and UI code
    (`gateway-runtime.js` verifies `workspaceRoot` only today).

18. **The `SMITHERS_NO_DAEMON` / `--no-daemon` escape hatch (decision 11) is a
    hard prerequisite, implemented before any further daemonization.** It does
    not exist in code today (zero matches across the CLI/server/smithers
    packages), yet `smithers monitor` already background-spawns
    `smithers ui <runId>`, which would autostart daemons inside CI, sandboxes,
    and containers. The env var and flag force the embedded engine and direct
    store access for every command, fail loud (not silent-fallback) when a
    daemon should be reachable but is not, and are honored by autostart before
    G2 routes any read through a daemon.

19. **Concurrency-correctness fixes ship regardless of milestone sequencing.**
    These are latent data-integrity bugs today and are fixed as standalone,
    test-first commits on main without waiting for the daemon: (a) the
    non-bun-sqlite `claimRunForResume` branch UPDATEs `claimed_at_ms` /
    `claimed_by` columns that no DDL anywhere creates, breaking claims on
    Cloudflare-class backends (`packages/db/src/adapter.js`, columns exist only
    in that one file); (b) run-creation TOCTOU where two `up --run-id X`
    processes both pass the getRun-then-`insertIgnore` guard and both believe
    they own the run; (c) `updateRun` has no ownership guard, so any process can
    overwrite any run's status/owner/cancel flags; (d) cron double-fire because
    both the CLI scheduler and the gateway scheduler are read-then-act-then-
    update with no atomic claim; (e) pglite/postgres cross-process event-seq
    collision (decision context above). Where a fix needs an owner-guarded
    write, it uses the CAS pattern `claimRunForResume` already establishes.

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

### G6: production hardening (decisions 14-18)

Sequences independently of G2-G4 where it can; the escape hatch (18) and the
concurrency-correctness fixes (19) land first as they gate everything else.

- Escape hatch `SMITHERS_NO_DAEMON` / `--no-daemon`, honored by autostart,
  fail-loud when a daemon is expected but unreachable (decision 18).
- Concurrency-correctness commits (decision 19), each test-first and standalone.
- Idle spin-down: last-activity tracking on WS + HTTP RPC, the three-condition
  idle check, atomic re-claim-before-shutdown, keep-alive on owned schedules,
  `--idle-timeout`/`--linger` overrides (decision 14).
- Scale hardening: `launchRun` admission-control semaphore + bounded queue,
  free `runEventWindows` on completion, bound `AgentTraceCollector`, runId to
  subscriber index for `broadcastEvent`, one daemon-level `caffeinate`
  (decision 15).
- Security: Host-header/DNS-rebinding defense, pglite socket auth, no-bearer-to-
  unverified-endpoint, per-uid runtime dir with owner/mode checks, timing-safe
  token compare (decision 16).
- Recovery/ops: start-time reconcile of crash-orphaned runs, transient-aware
  `gateway stop`, rotated daemon log file in state + `status`,
  `gateway ls`, stoppable deleted-workspace daemon, enforced version/protocol
  handshake (decision 17).

## Test doctrine

No mocks anywhere: real gateways on real ports, real stores, fake agents
where a run is needed (CI has no agent CLIs). Discovery, lock contention,
stale-file cleanup, and identity mismatch get dedicated process-level
tests. Every gateway-routed command keeps a golden test asserting exit code
and output parity with the direct path. Backend-parameterized suites
(sqlite + pglite; postgres behind `SMITHERS_TEST_PG_URL`) for anything that
touches the store, per the pluggable-db testing bar.

**50-concurrent-runs test (decision 15), two layers matching existing homes:**

- Per-PR, in-process: `packages/server/tests/gateway-load-50-runs.test.jsx`,
  cloned from the existing 3-run `gateway-shared-db.test.jsx` + the RPC harness
  in `gateway-concurrent-rpc.test.ts`. One `new Gateway()`, one registered
  workflow, launch 50 runs through the real `launchRun` RPC via
  `gateway.routeRequest`, literal-output tasks (no subprocess) so it is fast
  and CI-safe. Parameterized sqlite + pglite; postgres behind
  `SMITHERS_TEST_PG_URL`.
- e2e, real processes: `e2e/faults/case32-load-50-concurrent-runs.test.ts`,
  real `Gateway.listen({port:0})`, HTTP `launchRun`, a workflow whose tasks use
  a fake agent binary (`writeFakeClaudeBinary` + `SMITHERS_FAKE_AGENT_RESPONSE`
  from `e2e-helpers.js`) so each step actually spawns a subprocess, exercising
  the fd/process dimension. Full 50x4-subprocess variant gated
  `SMITHERS_E2E_SOAK=1`; a 50-run / 1-agent-node variant stays per-PR.

Assertions, each mapped to a decision-15 hazard: all 50 reach `finished`
within budget; per run the event seqs are contiguous from 0 and no run holds
another run's node ids (no loss, no cross-run corruption); zero spurious
`BackpressureDisconnect` on 5 cross-run subscribers; RSS ceiling and p95
launch-to-finished latency enforced via new `e2e/budgets/{memory,latency}.json`
keys (the memory budget must catch the `runEventWindows` leak, that is the
point); fd and child-process count sampled at peak stay under budget with zero
orphaned agent processes after completion; `gateway.close()` mid-load settles
all inflight without unhandled rejection. A spin-down test (decision 14) asserts
an autostarted daemon with no clients, no runs, and no due schedules exits
within the idle window, and that one with an owned cron does not.

## Out of scope

- Wiring the `~/.smithers` token store into gateway auth (follow-up).
- Remote daemons / multi-host (run-on-plue covers remote execution).
- Row-level sync, Electric, and the collection layer (tanstack spec owns
  those).
- Windows CI (Windows-specific guards land, but no CI leg exists).
