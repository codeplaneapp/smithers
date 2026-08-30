---
description: "Every feature Smithers 1.0.0-rc.0 excludes, the release note for each one, and how the exclusion is enforced."
---

# Known limitations

A release candidate is not a preview of unfinished work. Every exclusion below
is enforced: the command is gone, the export is removed, or the call fails with
a typed error. Nothing on this page half-works.

The release-note block is generated. `scripts/generate-docs-pages.mjs` reads the
paragraphs out of the release contract
(`docs/migration/rc-contract.md` section 7), keys each one by the exclusion ids
in Table B of `docs/migration/phase5-gap-triage.md`, and renders the enforcement
table from contract section 5.2; `scripts/check-docs.mjs` runs that generator
with `--check`, so the page and the contract cannot drift. Edit the contract,
not the block.

The sections after the block are written by hand: where each exclusion is
enforced in the tree, what shipped and is therefore not a limitation, and the
coverage table that keys every Table B id to its section.

What is supported is in the [rc.0 support matrix](/release/support-matrix).

{/* generated:release-notes start */}

## Release notes

### Databases

> **Databases.** Smithers 1.0.0-rc.0 stores run state in local SQLite only (`@effect/sql-sqlite-node` over Node.js `node:sqlite`). PostgreSQL and PGlite are not supported: no client layer or migration ladder ships, `SMITHERS_BACKEND=pglite|postgres` and `--backend pglite|postgres` exit with `unsupported_database`, and the 0.x `smithers migrate --to` database move is removed. Projects that ran 0.x on PGlite or PostgreSQL must finish or discard their runs on 0.x; there is no import path.

Exclusions: X-01 (defer).

### 0.x run data

> **0.x run data.** 1.0.0-rc.0 does not load, resume, or migrate 0.x run databases (`smithers.db`) or `.smithers/executions` state; `smithers migrate` opens `smithers.db` read-only only to list non-terminal runs before refusing. Finish, archive, or discard 0.x runs with the 0.x CLI, then run `smithers migrate` to convert the project's source. A 0.x database is an archive-only file; no read-only history importer ships in this candidate.

Exclusions: X-13 (drop).

### Hijack

> **Hijack.** `smithers hijack`, `smithers steer --takeover`, the `/v1/pty/hijack` gateway endpoint, and the `hijackRun` RPC are removed. Runs are controlled through `steer`, `signal`, `approve`, `deny`, and `cancel`.

Exclusions: X-02 (drop).

### Pause

> **Pause.** `smithers pause` and the `Pause` control RPC are not available in 1.0.0-rc.0. A run stops on `cancel` or parks on an approval request (`waiting-approval`) and resumes with `smithers run --resume`. Control requests record the acting principal in the control-plane event journaled inside the mutation's own transaction (`control.approval.*`, `control.run.cancel-requested`), and `RunSummary.cancellation` reports who asked, when, and whether the source was control, the engine, or a cascade. The engine run row itself records no actor.

Exclusions: X-03 (drop), X-14 (defer).

### Continue-as-new

> **Continue-as-new.** Continue-as-new is expressed as trampoline handoff rounds (`Flow.Handoff`, `maxRounds`); each round settles `completed` with `lineage_id` and `round_ordinal`. There is no `Continued` terminal status, and the 0.x `<ContinueAsNew>` component has no replacement.

Exclusions: X-04 (drop).

### Checkpoints and worktree lanes

> **Checkpoints and worktree lanes.** In 1.0.0-rc.0 a checkpoint is a pinned git tree taken by a cell call (`ctx.checkpoint()`, `ctx.base`). Worktree lanes, snapshot hooks, and the `replay`, `snapshots`, `restore`, `snapshot-hook`, `revert`, `rewind`, `retry-task`, `timetravel`, `fork`, `tree`, `graph`, `timeline`, `diff`, and `worktrees` commands are removed. Time-travel replay, fork, and rewind exist as the `@smthrs/time-travel` library API and are not composed into the CLI.

Exclusions: X-06 (defer), X-19 (defer).

### Provider quota

> **Provider quota.** A provider refusal that names a reset instant, a retry-after delay, or a delay in its message text parks the run under the `quota` waiting reason until that instant and resumes it there. The park is a sealed durable step (`agent/quota-park`), it journals `flows.agent.quota-parked.v1` with the wake time and where the deadline came from, and waiting does not consume the action's retry budget. The classifier is injected rather than assumed: a composition opts in with `QuotaPolicy.layerDefault()`, and the default `QuotaPolicy.layerNoop()` keeps a refusal a failure. A refusal that names no deadline, or one past the configured ceiling, still fails the call with `quota_exceeded`. Waking a quota park is bound to the process that owns the run: the driver's sweep wakes released and cancel-requested rows only, so a run parked for quota by a process that then died waits for its lease to expire before another process takes it over. The 0.x multi-account fallback seat pool (`smithers agents`, `fallbackAgents`) moved to the plugins repository; core resolves seats from `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, and `SMITHERS_OPENAI_AUTH=chatgpt`.

Exclusions: X-05 / B-R1 (defer).

### Wake and supervision

> **Wake and supervision.** Wakes published from another process land through the 1-second heartbeat sweep and cancel poll, not an event bus; in-process wakes use `WakeBus`. No supervisor process launches or resumes an abandoned run. Recovery is a reclaim rather than a supervisor: a run becomes reclaimable once the heartbeat its owner stopped renewing is older than 30 seconds, and any running `smithers` process with the flow registered takes it over. On a Node host the takeover asks the operating system first: the default liveness check probes the recorded process id on this machine and refuses the reclaim while that process still exists, so a stalled but living owner keeps its runs, and an owner recorded on another host is left to the expired lease, which the run store verifies for itself. A host with no process table to ask, such as a browser composition, answers from that lease alone. Nothing outside such a process watches for dead owners. The 0.x `smithers supervise` command is removed.

Exclusions: X-07 (defer), X-10 (defer).

### Gateway

> **Gateway.** The 0.x gateway (`POST /v1/rpc/<method>`, WebSocket `/`, SSE `/v1/api/stream`, 44 methods) is replaced by `smithers serve`: control RPC at `/rpc` and `/rpc/ws`, journal sync at `/sync` and `/sync/ws`, UI projections at `/projections/ws`, and `GET /health`. No 0.x method name or path is served, and there is no compatibility projection. Bearer-token authentication binds one principal; there are no users, roles, or per-run ownership.

### UI

> **UI.** The product UI is the Electrobun application in `apps/ui`. The 0.x web monitor (`smithers monitor`, `smithers ui --app`), workflow `<UI>` dashboards, and the terminal monitor (`smithers up --interactive`, `smithers-mon`) are not part of 1.0.0-rc.0; the 0.x UI packages (`gateway-react`, `gateway-ui`, `ui-core`, `tui`, `tui-ui`) are deleted and `@smthrs/gateway-client` is superseded by the `@smthrs/control` and `@smthrs/sync` clients, and a run monitor on the new projections is new work.

Exclusions: X-09 (drop).

### Runtimes

> **Runtimes.** The durable engine runs on Node.js 22.19.0 or later with local SQLite. Bun 1.3.0 or later (CI runs 1.3.14) is supported for the non-durable packages and the applications; opening a durable database under Bun fails with `unsupported_runtime`. Browser entry points bundle but do not execute durable flows; no Cloudflare or Vercel engine deployment ships. Windows is unsupported.

Exclusions: X-08 (defer), X-18 (defer).

### Triggers, evaluation, and integrations

> **Triggers, evaluation, and integrations.** `smithers cron`, `smithers listeners`, `smithers eval`, `smithers optimize`, `smithers scores`, `smithers observability`, and `smithers openapi` are removed from the CLI. `@smthrs/triggers`, `@smthrs/evals`, and `@smthrs/scorers` are not published. The GitHub, Linear, and Telegram clients, OAuth PKCE helpers, webhook verification, cursor handling, and error classification are rebuilt as the private workspace package `@smthrs/integrations` on the action, notification, and trigger APIs; GitHub and Linear are the real integrations the release smoke exercises; webhook ingress ships as library code only (the GitHub and Linear webhook sources and the GitHub listener registry bind to `@smthrs/control` `WebhookChannel` with the constant-time signature check; no `smithers listeners` verb and no gateway-level webhook configuration exists, and the old gateway HMAC e2e binding is re-pinned as a `WebhookChannel` test); the JSX integration components are gone. Vendor adapters (Hermes, OpenClaw, herdr, Claude Code and Codex subprocess agents, cloud hosts) live in the plugins repository; the cloud-host adapters there are re-ported onto the current kernel seams before they are usable.

Exclusions: X-09 (drop).

### Diff review

> **Diff review.** Settled diff bundles are applied to the host without a human review gate; the 0.x `smithers diff` and review-mode commands are removed.

Exclusions: X-12 (drop).

### Durable interruptUnsafe

> **Durable interruptUnsafe.** The durable engine has one cancellation path, `interrupt`, which is durable and cascades to linked children. `FlowRuntime.interruptUnsafe` on the durable engine fails with `unsafe_interrupt_unsupported` instead of forcing cancellation without cleanup.

Exclusions: X-11 (drop).

### Detached child flows

> **Detached child flows.** A host that composes `EngineChildren` runs detached children as real runs: `agent/spawn` starts a separate run with its own row, claim, and journal, linked to the caller through the engine's parent-edge table and recorded as detaching on parent exit, so it outlives the run that started it; `agent/send` steers it through the control plane; `agent/await` reads its settled result from the run store, from a different process or a later incarnation. A composition that supplies no child port refuses all three with `ChildError` code `unsupported`. `agent/await` polls the child's run row on an interval rather than parking the caller, so a cell that awaits a long child holds its round open for the length of the wait.

Exclusions: X-15 / B-R2 (defer).

### Plan admission and repair

> **Plan admission and repair.** A model-authored plan is admitted against a declared envelope: a plan past its depth, fanout, or fuel budget is refused with `depth_exceeded`, `fanout_exceeded`, or `fuel_exhausted` before anything runs. Linked child runs are not counted against those caps, so a plan that spawns children can exceed an envelope its own steps stayed inside. Failure handling is retry; there is no self-healing repair primitive.

Exclusions: X-16 (defer).

### Hard-killed engine processes

> **Hard-killed engine processes.** Cooperative cancellation (`smithers cancel`) kills the process group of every child the engine spawned. If the engine process itself is hard-killed, the groups it spawned keep running until the next incarnation of the same host starts: every spawn is journaled as an ownerless durable record, and on start the reaper signals each group a previous incarnation abandoned. It refuses any record whose number the operating system has moved on from, so only a process that answers `ESRCH` counts as dead and the recorded start time must still match. A host that never restarts reaps nothing, and reaping a remote sandbox's processes requires that provider's optional `kill`.

Exclusions: X-17 (defer).

### Effect

> **Effect.** Every published package pins `effect` and the `@effect/*` packages to exactly `4.0.0-rc.108`. Install the same exact version; two Effect instances in one process are not interoperable. Each candidate declares one exact Effect version; a changed pin is a breaking change listed in that candidate's notes.

### Source migration

> **Source migration.** See §11 for the compatibility promise paragraph.

## How each exclusion is enforced

A dropped feature is removed, and a deferred one fails with a typed error. The
state column is what the release does today.

| Feature | State in 1.0.0-rc.0 |
| --- | --- |
| Hijack | Does not exist in flows (`rg hijack` finds one comment and one schema-negative test). |
| Attributed pause | `SqlControlRuntime.pause` flips the control row without parking the engine run (a partial feature). No caller exists: Plue uses no pause, `apps/ui` does not talk to control, the 0.x UI packages are deleted. |
| Durable `interruptUnsafe` | `FlowRuntime.interruptUnsafe` on the durable port aliases `interrupt` (`RunDriver.ts:1800`), a partial promise of forced cancellation without cleanup. |
| Continue-as-new `Continued` terminal | Decided against in source (`RunDriver.ts:975-980`); handed-off rounds settle `completed` with `lineage_id` and `round_ordinal`. |
| Checkpoints and worktree lanes | "Checkpoint" in rc.0 means a pinned git tree per cell call (`@smthrs/std` `Checkpoints.layerGit`, `ctx.checkpoint()`, `ctx.base`). No `Checkpoint` host capability, no lane lifecycle, no worktree verb. |
| Quota park/wake, cross-process | Shipped (A28a). `QuotaPolicy` classifies a provider refusal into a deadline and `AgentAction.waitOutQuota` parks the run there through the sealed `agent/quota-park` step (`packages/agent/src/QuotaPolicy.ts`, `packages/agent/src/AgentAction.ts:341,564`). The classifier is injected: `QuotaPolicy.layerNoop()` keeps the refusal a failure and a composition opts in with `QuotaPolicy.layerDefault()`. Unsupported residual (B-R1): no cross-process quota wake sweep (A28b). |
| Cross-process event-driven wake | In-process `WakeBus` only. |
| Supervisor process and gateway auto-recovery | `SuperviseRuntime` ships noop only; no process watches for dead owners. Recovery is not nothing: a run becomes reclaimable 30 seconds after its owner's last heartbeat, and any process with the flow registered takes it over (A59). On a Node host the takeover asks the process table first (`Ownership.sameHostPidProbe`, section 5.1) and refuses while the recorded pid is still alive; every other host answers from the lease alone (`Ownership.leaseLiveness`). |
| Detached child flows | Shipped for a host that composes `EngineChildren.layer` (A12): durable `agent/spawn`, `agent/send`, and `agent/await` over the flow runtime, the run store, and the control plane (`packages/agent/src/EngineChildren.ts`, exported at `packages/agent/src/index.ts:78`). A composition that supplies no children port refuses all three with `ChildError` code `unsupported` (`packages/agent/src/ChildFlows.ts:183-187`). Unsupported residual (B-R2): `agent/await` polls the child's run row on `pollInterval` and holds the caller's round open; it does not park the caller (`EngineChildren.ts:30-33,169`). |
| Diff-review gate | Settled diff bundles apply to the host without a human gate. |
| Edge/serverless engine | No Cloudflare or Vercel engine composition in core. |
| Old eval/optimization and UI-adjacent engine features | Removed from the CLI and engine. |
| Plan admission caps and child runs | Envelope admission is enforced for model-authored plans (A54): `Trellis` refuses a plan past its depth, fanout, or fuel envelope with `depth_exceeded`, `fanout_exceeded`, or `fuel_exhausted` (`packages/patterns/src/Trellis.ts:35-37`). Linked child runs are still not counted against those caps; failure handling is retry, with no self-healing repair primitive. |
| Hard-kill orphan reaping | Shipped. `ProcessLedger` journals spawn, exit, and reap facts as ownerless durable records and computes `orphans` for the next incarnation of the same `hostId` (`packages/kernel/src/ProcessLedger.ts`); `ProcessReaper` signals those groups with ESRCH-only liveness and a recorded-start-time identity check (`packages/platform-node/src/ProcessReaper.ts`); `NodeHost.layerContained` and `packages/flows/src/NodeRuntime.ts:437` wire both. Remaining limit: a host that never restarts reaps nothing, and a remote sandbox needs that provider's optional `kill`. |

{/* generated:release-notes end */}

## Where each exclusion is enforced in the tree

The table above says what the release does. This one says which code refuses,
and which test fails if that refusal stops working.

| Exclusion | Enforced by | Pinned by |
| --- | --- | --- |
| X-01 | `--backend` and `SMITHERS_BACKEND` with any value but `sqlite` exit 1 with `unsupported_database` (`packages/cli/src/Environment.ts`); `SMITHERS_TEST_PG_URL` and every `SMITHERS_POSTGRES*` name are announced as ignored and otherwise have no effect (`@smthrs/database` `UnsupportedBackend`) | `packages/cli/test/Bin.test.ts`; `packages/database/test/UnsupportedBackend.test.ts` |
| X-13 | `NodeDatabase.layer` refuses a file that has tables and no `flows_migrations` table, before the connection exists, and outwaits a peer holding the file rather than waving it through | `packages/database/test/NodeDatabaseGuard.test.ts` |
| X-18 | `NodeDatabase.layer` refuses to open a durable database when `process.versions.bun` is set | `packages/database/test/NodeDatabaseGuard.test.ts`, and measured under Bun 1.4.0 |
| X-08 | The browser entry points bundle and no browser or edge engine composition ships | `scripts/browser-check.mjs` |
| X-03, X-14 | The `Pause` RPC, the `Control.pause` member, and the `control.run.pause` event are removed, not stubbed | `phase5/terminal-control`, `0550a13943` |
| X-11 | `FlowRuntime.interruptUnsafe` on the durable engine fails with `unsafe_interrupt_unsupported` | `phase5/cancel-durability`, `packages/engine-store/src/internal/RunDriver.ts` |
| X-02, X-04, X-06, X-09, X-12, X-19 | Each removed verb is registered as a hidden subcommand that exits 1 with the migration message, so it never reaches a usage error | `packages/cli/test/Verb.test.ts` and `packages/cli/test/Bin.test.ts` |
| X-19 | `smithers replay` exits 1, is absent from `--help`, and journals no `system/replay` plan | `packages/cli/test/Verb.test.ts` |
| X-07, X-10 | No supervisor process ships: `SuperviseRuntime` is a noop layer, and recovery is the reclaim described above | `packages/control` |
| X-16 | `Trellis` refuses a plan past its depth, fanout, or fuel envelope before anything runs; linked child runs stay uncounted | `packages/patterns` |
| X-17 | `ProcessLedger` journals every spawn as an ownerless record and `ProcessReaper` sweeps them at host start | `packages/kernel`, `packages/platform-node` |
| B-R1 | Residual of X-05. The quota park shipped; the cross-process wake sweep did not | `packages/agent` |
| B-R2 | Residual of X-15. Durable child spawn, send, and await shipped; a parking `await` did not | `packages/agent` |

## What shipped, and is not a limitation

The parity lanes closed capabilities that earlier drafts of the release notes
or of the Phase 5 triage listed as deferred. They are recorded here so a reader
who remembers the earlier list does not go looking for them above.

| Capability | Parity item | Where it lives |
| --- | --- | --- |
| Quota park and wake, in the owning process | A28a | `QuotaPolicy` and `AgentAction.waitOutQuota`, with the residual filed as B-R1 |
| Durable child spawn, send, and await | A12 | `EngineChildren`, with the residual filed as B-R2 |
| Reclaiming a hard-killed owner's runs | A59 | `Ownership.leaseLiveness` on every host, with `Ownership.sameHostPidProbe` as the Node host's default over it |
| Plan envelope admission (depth, fanout, fuel) | A54 | `Trellis` |
| Reaping the process groups a hard-killed host abandoned | ProcessLedger, ProcessReaper | `@smthrs/kernel` and `@smthrs/platform-node` |
| A `Terminal` receipt from `steer` on a settled run | A33 | `ControlLive.steer` |
| Cancellation attribution inside the mutation transaction | A60a | `ControlLive.cancel` and `RunSummary.cancellation` |
| A durable clock with a zero in-memory threshold | none | `DurableClock` |

## Coverage

Every exclusion id in Table B of the Phase 5 triage has exactly one row below.
Two Table B rows carry two ids because the feature shipped and only a residual
remains: `X-05 / B-R1` is one residual and `X-15 / B-R2` is one residual (SPEC
AMENDMENT 5). X-09 is one row whose feature is worded by two release-note
paragraphs, so both are named in its row. HARDEN-1 and HARDEN-2 are
code-hardening sweeps rather than released behavior and have no release note.

| Exclusion | Section |
| --- | --- |
| X-01 | [Databases](#databases) |
| X-02 | [Hijack](#hijack) |
| X-03 | [Pause](#pause) |
| X-04 | [Continue-as-new](#continue-as-new) |
| X-05 / B-R1 | [Provider quota](#provider-quota) |
| X-06 | [Checkpoints and worktree lanes](#checkpoints-and-worktree-lanes) |
| X-07 | [Wake and supervision](#wake-and-supervision) |
| X-08 | [Runtimes](#runtimes) |
| X-09 | [Triggers, evaluation, and integrations](#triggers-evaluation-and-integrations) and [UI](#ui) |
| X-10 | [Wake and supervision](#wake-and-supervision) |
| X-11 | [Durable interruptUnsafe](#durable-interruptunsafe) |
| X-12 | [Diff review](#diff-review) |
| X-13 | [0.x run data](#0x-run-data) |
| X-14 | [Pause](#pause) |
| X-15 / B-R2 | [Detached child flows](#detached-child-flows) |
| X-16 | [Plan admission and repair](#plan-admission-and-repair) |
| X-17 | [Hard-killed engine processes](#hard-killed-engine-processes) |
| X-18 | [Runtimes](#runtimes) |
| X-19 | [Checkpoints and worktree lanes](#checkpoints-and-worktree-lanes) |
