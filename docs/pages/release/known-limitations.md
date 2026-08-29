# Known limitations in 1.0.0-rc.0

Every paragraph below is the release-note text for one thing 1.0.0-rc.0 does
not do, copied verbatim from the release contract
(`docs/migration/rc-contract.md` section 7). Each is keyed by the exclusion id
the Phase 5 triage assigned it (`docs/migration/phase5-gap-triage.md`, Table
B), so a report, a changelog entry, and this page can name the same thing.

An excluded feature does not partly work. Each one is removed, hidden, or
answers with the exact error quoted here.

## Storage

### Databases

Table B: X-01.

> **Databases.** Smithers 1.0.0-rc.0 stores run state in local SQLite only (`@effect/sql-sqlite-node` over Node.js `node:sqlite`). PostgreSQL and PGlite are not supported: no client layer or migration ladder ships, `SMITHERS_BACKEND=pglite|postgres` and `--backend pglite|postgres` exit with `unsupported_database`, and the 0.x `smithers migrate --to` database move is removed. Projects that ran 0.x on PGlite or PostgreSQL must finish or discard their runs on 0.x; there is no import path.

The CLI half of this exclusion (`--backend`, `SMITHERS_BACKEND`) is triage item W-16.

### 0.x run data

Table B: X-13.

> **0.x run data.** 1.0.0-rc.0 does not load, resume, or migrate 0.x run databases (`smithers.db`) or `.smithers/executions` state; `smithers migrate` opens `smithers.db` read-only only to list non-terminal runs before refusing. Finish, archive, or discard 0.x runs with the 0.x CLI, then run `smithers migrate` to convert the project's source. A 0.x database is an archive-only file; no read-only history importer ships in this candidate.

Enforced by `NodeDatabase.layer`, which refuses a file that has tables and no `flows_migrations` table (`packages/database/src/node/NodeDatabase.ts`, pinned by `packages/database/test/NodeDatabaseGuard.test.ts`).

## Runtimes

### Runtimes

Table B: X-08, X-18.

> **Runtimes.** The durable engine runs on Node.js 22.19.0 or later with local SQLite. Bun 1.3.0 or later (CI runs 1.3.14) is supported for the non-durable packages and the applications; opening a durable database under Bun fails with `unsupported_runtime`. Browser entry points bundle but do not execute durable flows; no Cloudflare or Vercel engine deployment ships. Windows is unsupported.

The browser claim is bundleable entry points, not durable browser or edge execution; `scripts/browser-check.mjs` is the gate. Enforced by `NodeDatabase.layer`, which refuses to open a durable database when `process.versions.bun` is set (`packages/database/test/NodeDatabaseGuard.test.ts`).

### Effect version

Table B: no Table B row.

> **Effect.** Every published package pins `effect` and the `@effect/*` packages to exactly `4.0.0-rc.108`. Install the same exact version; two Effect instances in one process are not interoperable. Each candidate declares one exact Effect version; a changed pin is a breaking change listed in that candidate's notes.

## Run control

### Pause

Table B: X-03, X-14.

> **Pause.** `smithers pause` and the `Pause` control RPC are not available in 1.0.0-rc.0. A run stops on `cancel` or parks on an approval request (`waiting-approval`) and resumes with `smithers run --resume`. Control requests record the acting principal in the control-plane event journaled inside the mutation's own transaction (`control.approval.*`, `control.run.cancel-requested`), and `RunSummary.cancellation` reports who asked, when, and whether the source was control, the engine, or a cascade. The engine run row itself records no actor.

The `Pause` RPC, the `Control.pause` member, and the `control.run.pause` event are removed rather than stubbed.

### Durable interruptUnsafe

Table B: X-11.

> **Durable interruptUnsafe.** The durable engine has one cancellation path, `interrupt`, which is durable and cascades to linked children. `FlowRuntime.interruptUnsafe` on the durable engine fails with `unsafe_interrupt_unsupported` instead of forcing cancellation without cleanup.

### Continue-as-new

Table B: X-04.

> **Continue-as-new.** Continue-as-new is expressed as trampoline handoff rounds (`Flow.Handoff`, `maxRounds`); each round settles `completed` with `lineage_id` and `round_ordinal`. There is no `Continued` terminal status, and the 0.x `<ContinueAsNew>` component has no replacement.

### Hijack

Table B: X-02.

> **Hijack.** `smithers hijack`, `smithers steer --takeover`, the `/v1/pty/hijack` gateway endpoint, and the `hijackRun` RPC are removed. Runs are controlled through `steer`, `signal`, `approve`, `deny`, and `cancel`.

The verb is a hidden subcommand that exits 1 with the migration message (rc-contract section 4.2).

## Durability and recovery

### Wake and supervision

Table B: X-07, X-10.

> **Wake and supervision.** Wakes published from another process land through the 1-second heartbeat sweep and cancel poll, not an event bus; in-process wakes use `WakeBus`. No supervisor process launches or resumes an abandoned run. Recovery is a lease: the default liveness check reports an owner gone once the heartbeat it stopped renewing is older than 30 seconds, so any running `smithers` process with the flow registered reclaims the run, and a deployment that can prove more about an owner supplies its own liveness check and refuses the takeover for longer. Nothing outside such a process watches for dead owners. The 0.x `smithers supervise` command is removed.

No supervisor process ships: `SuperviseRuntime` is a noop layer.

### Hard-killed engine processes

Table B: X-17.

> **Hard-killed engine processes.** Cooperative cancellation (`smithers cancel`) kills the process group of every child the engine spawned. If the engine process itself is hard-killed, the groups it spawned keep running until the next incarnation of the same host starts: every spawn is journaled as an ownerless durable record, and on start the reaper signals each group a previous incarnation abandoned. It refuses any record whose number the operating system has moved on from, so only a process that answers `ESRCH` counts as dead and the recorded start time must still match. A host that never restarts reaps nothing, and reaping a remote sandbox's processes requires that provider's optional `kill`.

Reaping ships and runs at host start; a host that never restarts is the part that stays uncovered.

### Provider quota

Table B: B-R1.

> **Provider quota.** A provider refusal that names a reset instant, a retry-after delay, or a delay in its message text parks the run under the `quota` waiting reason until that instant and resumes it there. The park is a sealed durable step (`agent/quota-park`), it journals `flows.agent.quota-parked.v1` with the wake time and where the deadline came from, and waiting does not consume the action's retry budget. The classifier is injected rather than assumed: a composition opts in with `QuotaPolicy.layerDefault()`, and the default `QuotaPolicy.layerNoop()` keeps a refusal a failure. A refusal that names no deadline, or one past the configured ceiling, still fails the call with `quota_exceeded`. Waking a quota park is bound to the process that owns the run: the driver's sweep wakes released and cancel-requested rows only, so a run parked for quota by a process that then died waits for its lease to expire before another process takes it over. The 0.x multi-account fallback seat pool (`smithers agents`, `fallbackAgents`) moved to the plugins repository; core resolves seats from `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, and `SMITHERS_OPENAI_AUTH=chatgpt`.

Residual of exclusion X-05. The quota park itself shipped; the cross-process wake sweep did not.

### Detached child flows

Table B: B-R2.

> **Detached child flows.** A host that composes `EngineChildren` runs detached children as real runs: `agent/spawn` starts a separate run with its own row, claim, and journal, linked to the caller through the engine's parent-edge table and recorded as detaching on parent exit, so it outlives the run that started it; `agent/send` steers it through the control plane; `agent/await` reads its settled result from the run store, from a different process or a later incarnation. A composition that supplies no child port refuses all three with `ChildError` code `unsupported`. `agent/await` polls the child's run row on an interval rather than parking the caller, so a cell that awaits a long child holds its round open for the length of the wait.

Residual of exclusion X-15. Durable child spawn, send, and await shipped; a parking `await` did not.

### Plan admission and repair

Table B: X-16.

> **Plan admission and repair.** A model-authored plan is admitted against a declared envelope: a plan past its depth, fanout, or fuel budget is refused with `depth_exceeded`, `fanout_exceeded`, or `fuel_exhausted` before anything runs. Linked child runs are not counted against those caps, so a plan that spawns children can exceed an envelope its own steps stayed inside. Failure handling is retry; there is no self-healing repair primitive.

Envelope admission ships; linked child runs are the part that stays uncounted.

## Surfaces that are not in this candidate

### Checkpoints and worktree lanes

Table B: X-06, X-19.

> **Checkpoints and worktree lanes.** In 1.0.0-rc.0 a checkpoint is a pinned git tree taken by a cell call (`ctx.checkpoint()`, `ctx.base`). Worktree lanes, snapshot hooks, and the `replay`, `snapshots`, `restore`, `snapshot-hook`, `revert`, `rewind`, `retry-task`, `timetravel`, `fork`, `tree`, `graph`, `timeline`, `diff`, and `worktrees` commands are removed. Time-travel replay, fork, and rewind exist as the `@smthrs/time-travel` library API and are not composed into the CLI.

Each removed verb is a hidden subcommand that exits 1 with the migration message (rc-contract section 4.2). `smithers replay` exits 1, is absent from `--help`, and journals no `system/replay` plan.

### Diff review

Table B: X-12.

> **Diff review.** Settled diff bundles are applied to the host without a human review gate; the 0.x `smithers diff` and review-mode commands are removed.

### Triggers, evaluation, integrations, and UI

Table B: X-09.

> **Triggers, evaluation, and integrations.** `smithers cron`, `smithers listeners`, `smithers eval`, `smithers optimize`, `smithers scores`, `smithers observability`, and `smithers openapi` are removed from the CLI. `@smthrs/triggers`, `@smthrs/evals`, and `@smthrs/scorers` are not published. The GitHub, Linear, and Telegram clients, OAuth PKCE helpers, webhook verification, cursor handling, and error classification are rebuilt as the private workspace package `@smthrs/integrations` on the action, notification, and trigger APIs; GitHub and Linear are the real integrations the release smoke exercises; webhook ingress ships as library code only (the GitHub and Linear webhook sources and the GitHub listener registry bind to `@smthrs/control` `WebhookChannel` with the constant-time signature check; no `smithers listeners` verb and no gateway-level webhook configuration exists, and the old gateway HMAC e2e binding is re-pinned as a `WebhookChannel` test); the JSX integration components are gone. Vendor adapters (Hermes, OpenClaw, herdr, Claude Code and Codex subprocess agents, cloud hosts) live in the plugins repository; the cloud-host adapters there are re-ported onto the current kernel seams before they are usable.

> **UI.** The product UI is the Electrobun application in `apps/ui`. The 0.x web monitor (`smithers monitor`, `smithers ui --app`), workflow `<UI>` dashboards, and the terminal monitor (`smithers up --interactive`, `smithers-mon`) are not part of 1.0.0-rc.0; the 0.x UI packages (`gateway-react`, `gateway-ui`, `ui-core`, `tui`, `tui-ui`) are deleted and `@smthrs/gateway-client` is superseded by the `@smthrs/control` and `@smthrs/sync` clients, and a run monitor on the new projections is new work.

### Gateway

Table B: no Table B row.

> **Gateway.** The 0.x gateway (`POST /v1/rpc/<method>`, WebSocket `/`, SSE `/v1/api/stream`, 44 methods) is replaced by `smithers serve`: control RPC at `/rpc` and `/rpc/ws`, journal sync at `/sync` and `/sync/ws`, UI projections at `/projections/ws`, and `GET /health`. No 0.x method name or path is served, and there is no compatibility projection. Bearer-token authentication binds one principal; there are no users, roles, or per-run ownership.

### Source migration

Table B: no Table B row.

> **Source migration.** See §11 for the compatibility promise paragraph.

## What shipped, and is not a limitation

The parity lanes closed capabilities that earlier drafts of the release notes
or of the Phase 5 triage listed as deferred. They are recorded here so a reader
who remembers the earlier list does not go looking for them above.

| Capability | Parity item | Where it lives |
| --- | --- | --- |
| Quota park and wake, in the owning process | A28a | `QuotaPolicy` and `AgentAction.waitOutQuota`, with the residual filed as B-R1 |
| Durable child spawn, send, and await | A12 | `EngineChildren`, with the residual filed as B-R2 |
| Reclaiming a hard-killed owner's runs | A59 | `Ownership.leaseLiveness`, the default liveness check |
| Plan envelope admission (depth, fanout, fuel) | A54 | `Trellis` |
| Reaping the process groups a hard-killed host abandoned | ProcessLedger, ProcessReaper | `@smthrs/kernel` and `@smthrs/platform-node` |
| A `Terminal` receipt from `steer` on a settled run | A33 | `ControlLive.steer` |
| Cancellation attribution inside the mutation transaction | A60a | `ControlLive.cancel` and `RunSummary.cancellation` |
| A durable clock with a zero in-memory threshold | none | `DurableClock` |

## Coverage

Every exclusion id in Table B of the Phase 5 triage appears exactly once above.
Two Table B rows carry two ids each because the feature shipped and only a
residual remains: `X-05 / B-R1` is one residual and `X-15 / B-R2` is one
residual (SPEC AMENDMENT 5), and each is listed once, under the residual id.
HARDEN-1 is a code-hardening sweep rather than a released behavior and has no
section.

| Exclusion | Section |
| --- | --- |
| X-01 | [Databases](#databases) |
| X-02 | [Hijack](#hijack) |
| X-03 | [Pause](#pause) |
| X-04 | [Continue-as-new](#continue-as-new) |
| X-06 | [Checkpoints and worktree lanes](#checkpoints-and-worktree-lanes) |
| X-07 | [Wake and supervision](#wake-and-supervision) |
| X-08 | [Runtimes](#runtimes) |
| X-09 | [Triggers, evaluation, integrations, and UI](#triggers-evaluation-integrations-and-ui) |
| X-10 | [Wake and supervision](#wake-and-supervision) |
| X-11 | [Durable interruptUnsafe](#durable-interruptunsafe) |
| X-12 | [Diff review](#diff-review) |
| X-13 | [0.x run data](#0x-run-data) |
| X-14 | [Pause](#pause) |
| X-16 | [Plan admission and repair](#plan-admission-and-repair) |
| X-17 | [Hard-killed engine processes](#hard-killed-engine-processes) |
| X-18 | [Runtimes](#runtimes) |
| X-19 | [Checkpoints and worktree lanes](#checkpoints-and-worktree-lanes) |
| B-R1 | [Provider quota](#provider-quota) |
| B-R2 | [Detached child flows](#detached-child-flows) |
