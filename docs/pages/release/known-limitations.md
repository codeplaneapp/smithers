---
description: "Every feature Smithers 1.0.0-rc.0 excludes, the release note for each one, and how the exclusion is enforced."
---

# Known limitations

A release candidate is not a preview of unfinished work. Each exclusion below is
enforced: the command is gone, the export is removed, or the call fails with a
typed error. Nothing on this page half-works.

The first section is the release note for each exclusion, quoted from
[the release contract](https://github.com/smithersai/smithers/blob/main/docs/migration/rc-contract.md)
section 7 and keyed by the exclusion IDs in the Phase 5 gap triage. The sections
after it describe the parts of the tree that are implemented as contracts
without a production implementation behind them.

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

> **Pause.** `smithers pause` and the `Pause` control RPC are not available in 1.0.0-rc.0. A run stops on `cancel` or parks on an approval request (`waiting-approval`) and resumes with `smithers run --resume`. Control requests record the acting principal in control-plane events (`control.approval.*`, `control.run.cancel-requested`); the engine run row records no actor.

Exclusions: X-03 (drop), X-14 (defer).

### Continue-as-new

> **Continue-as-new.** Continue-as-new is expressed as trampoline handoff rounds (`Flow.Handoff`, `maxRounds`); each round settles `completed` with `lineage_id` and `round_ordinal`. There is no `Continued` terminal status, and the 0.x `<ContinueAsNew>` component has no replacement.

Exclusions: X-04 (drop).

### Checkpoints and worktree lanes

> **Checkpoints and worktree lanes.** In 1.0.0-rc.0 a checkpoint is a pinned git tree taken by a cell call (`ctx.checkpoint()`, `ctx.base`). Worktree lanes, snapshot hooks, and the `replay`, `snapshots`, `restore`, `snapshot-hook`, `revert`, `rewind`, `retry-task`, `timetravel`, `fork`, `tree`, `graph`, `timeline`, `diff`, and `worktrees` commands are removed. Time-travel replay, fork, and rewind exist as the `@smthrs/time-travel` library API and are not composed into the CLI.

Exclusions: X-06 (defer), X-19 (defer).

### Provider quota

> **Provider quota.** A provider quota error fails the model call with `quota_exceeded` (non-retryable). Runs are not parked and re-woken automatically. The 0.x multi-account fallback seat pool (`smithers agents`, `fallbackAgents`) moved to the plugins repository; core resolves seats from `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, and `SMITHERS_OPENAI_AUTH=chatgpt`.

Exclusions: X-05 (defer).

### Wake and supervision

> **Wake and supervision.** Wakes published from another process land through the 1-second heartbeat sweep and cancel poll, not an event bus; in-process wakes use `WakeBus`. No supervisor process launches or resumes an abandoned run: recovery is a running `smithers` process with the flow registered, and a stale owner is reclaimed 30 seconds after its last heartbeat once the owner process is confirmed dead. The 0.x `smithers supervise` command is removed.

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

> **Detached child flows.** Child flows are linked to their parent and cancel with it; detached children are not available (`ChildError` code `unsupported`).

Exclusions: X-15 (defer).

### Plan admission and repair

> **Plan admission and repair.** Linked child runs are not counted against plan admission caps. Failure handling is retry; there is no self-healing repair primitive.

Exclusions: X-16 (defer).

### Hard-killed engine processes

> **Hard-killed engine processes.** Cooperative cancellation (`smithers cancel`) kills the process group of every child the engine spawned. If the engine process itself is hard-killed, child process groups it spawned keep running; restarting the engine does not reap them.

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
| Quota park/wake | `RequestExecutor` classifies `quota_exceeded` as non-retryable; no classifier-to-park driver; `waiting_reason='quota'` is reachable only by an explicit `park` from a flow. |
| Cross-process event-driven wake | In-process `WakeBus` only. |
| Supervisor process and gateway auto-recovery | `SuperviseRuntime` ships noop only; no process watches for dead owners. |
| Detached child flows | `ChildFlows.ts:187` returns typed `unsupported` for detached children. |
| Diff-review gate | Settled diff bundles apply to the host without a human gate. |
| Edge/serverless engine | No Cloudflare or Vercel engine composition in core. |
| Old eval/optimization and UI-adjacent engine features | Removed from the CLI and engine. |
| Plan admission caps and child runs | Linked child runs are not counted against plan admission caps; failure handling is retry, with no self-healing repair primitive. |
| Hard-kill orphan reaping | No durable process registry exists: if the engine process is hard-killed, child process groups it spawned keep running, and a restarted engine does not reap them (0.x had `_smithers_agent_processes` and `reapOrphanedAgentsOnBoot`). |

{/* generated:release-notes end */}

## Not in release 1

`1.0.0-rc.0` ships the `engine` and `agent` groups together at one synchronized version. `scripts/pack-release.mjs` packs every non-private workspace whose manifest declares `smthrs.group` in `{engine, agent}`, checks that set against the 40 names frozen in [rc-contract.md section 3.1](https://github.com/smithersai/smithers/blob/main/docs/migration/rc-contract.md), and throws on a manifest that declares no known group; `.github/workflows/release.yml` gates on the same fields. Group membership is therefore no longer a proxy for feature scope: a package can be published and still not be a release-candidate feature, and the way to keep one out of the release is `private: true`. The following subsystems exist in this tree and are **not** part of release 1.

| Subsystem | Why it is out of release 1 |
| --- | --- |
| `@smthrs/triggers` | `private: true` at rc.0, so the release train never packs it. |
| `@smthrs/evals` | `private: true` at rc.0, so the release train never packs it. |
| `@smthrs/gateway` | Published, because the Plue cutover consumes its wire schemas and projections, but its supervision runtime is a noop. See [abandoned runs and supervision](#abandoned-runs-and-supervision). |
| Memory semantic recall (`@smthrs/memory` `RecallSemantic`) | `@smthrs/memory` is published, but semantic recall needs an embedding provider the RC does not ship. A provider-free `Embedding.layerInProcess` ships, and `MemoryStore` automatically projects records that supply `inProcessVector` (`packages/memory/src/Embedding.ts:185-193`, `packages/memory/src/MemoryStore.ts:647-667`). |
| Observability OTLP export (`@smthrs/observability` `Otlp`) | The module is published, but no composition in this repository installs it. `Otlp` is referenced only by its own package tests, so it is an opt-in layer an application wires itself, not a shipped default. See [telemetry](/telemetry). |

## Abandoned runs and supervision

**Abandoned runs are not auto-resumed in this release.** Nothing in the tree watches for runs whose owner died and starts a process to pick them up. `@smthrs/gateway`'s `SuperviseRuntime` declares the `scan`/`resume` contract and ships only `make`, `makeNoop` (empty scan, successful resume), and `layerNoop` (`packages/gateway/src/SuperviseRuntime.ts:121,129,142`), plus a test double at `packages/gateway/src/test/TestSuperviseRuntime.ts`. There is no production implementation, and no production consumer invokes the supervision contract.

What does recover automatically is scoped to a process that is already running the engine **and** has the flow registered. On the one-second heartbeat cadence (`packages/run-store/src/Heartbeat.ts:24`), each engine driver sweeps parked runs for pending cancels and enumerates `running` rows whose heartbeat is older than the 30-second stale cutoff (`Heartbeat.ts:33`), re-driving up to 64 per tick through the ordinary claim/steal path (`packages/engine-store/src/internal/RunDriver.ts:160,1375,1412`). A wake for a flow the sweeping process has not registered logs a once-per-run warning and leaves the row parked (`RunDriver.ts:1074`).

The manual resume path for an abandoned run is therefore:

1. Start (or restart) a host process composed through `@smthrs/flows/NodeRuntime`, `NodeRuntime.layer(options, stepBoundary, workspaceSandbox, registerFlows)`, against the same SQLite `filename` the dead owner used.
2. Make `registerFlows` register every flow that has stored runs. Registration is the final startup phase of that composition, and the engine's registration hook re-arms durable clocks and deferred wakes, so nothing resumes before its flow exists in the process.
3. Supply an `Options.isAlive` that answers truthfully for the dead owner. Steal is refused while `isAlive` reports the recorded owner alive, and the driver journals a `steal-refused-owner-alive` decision (`packages/engine-store/src/internal/RunDriver.ts:392`); only once it answers `false` does the exact-snapshot claim take the row.
4. Wait out the stale window. There is nothing to invoke by hand; the timing is below.

**Reclaim is not bounded above by 30 seconds.** The 30-second cutoff is an eligibility floor, not a deadline. The steal predicate is strict, `heartbeat_at_ms < now - 30s` (`packages/run-store/src/RunStore.ts:1184`), so a row becomes eligible only *after* its heartbeat is more than 30 seconds old. The sweep that notices it runs once per second, so the earliest re-drive is the first tick after the cutoff passes. Each tick wakes at most 64 stale rows, oldest heartbeat first (`packages/engine-store/src/internal/RunDriver.ts:160,1412`), so a mass owner death drains batch by batch across successive ticks and a run behind a backlog is reclaimed correspondingly later. Steal is also refused for as long as `isAlive` reports the recorded owner alive, which is application-supplied latency the engine does not bound. Plan for "eligible after 30 seconds, reclaimed on a later tick", not for a 30-second recovery-time objective.

If no such process is running, the run stays where it is. Persisted state is not lost, but it does not advance.

## Implemented contracts with no production implementation

| Contract | What is missing |
| --- | --- |
| Cross-host liveness | `EngineStore.Options.isAlive` is application-supplied |
| `RunCatalog` | A durable workspace run list/watch; static and memory implementations ship |
| Browser Jujutsu | A typed unavailable implementation ships |
| Edge process spawning | Typed unavailable by default; optional remote sandbox adapters ship |

## Planned or incomplete integration

- Chunked/resumable artifact transfer (`.smithers/tickets/cas-chunked-transfer.md`) and a Bazel-style remote download policy: a `RemoteOutputChecker` analogue with `all`/`toplevel`/`minimal` (`.smithers/tickets/remote-cache-download-policy.md`). Materialization is read-through today, so a metadata-only replay state is representable, but there is no dial to choose it. Artifact garbage collection shipped as `@smthrs/engine-store` `ArtifactGc` over `@smthrs/artifacts` `ArtifactSweep` (`docs/pages/artifact-gc.mdx`).
- The human diff-review gate: `docs/specs/Concepts/Diff Review.md` renders a pending copy-back as a `PermissionRequired` bundle a person accepts, whole or by hunk, before it reaches the host. The engine applies a settled bundle without that gate today (`.smithers/tickets/diff-review-gate.md`).
- The transaction's `FileSystem` surface is deliberately partial: temp files, streams, sinks, and watches have no meaning over a functional map and refuse rather than lie (`.smithers/tickets/sandbox-filesystem-surface.md`).
- A packaged production layer that composes database, migrations, journal stores, durable deferred/clock state, kernel, Host, and engine. **Partly shipped.** The storage-and-engine half is the `@smthrs/flows/NodeRuntime` subpath (`packages/flows/src/NodeRuntime.ts`): `storage` opens the SQLite database, runs migrations, and provides the journal, run, attempt, cache, and durable-engine-state stores plus `OwnerIdentity`, `Workspace`, and a filesystem artifact store; `layer` and `make` add `EngineStore` over that and run `registerFlows` as the final startup phase; shutdown is scope closure. The host and kernel half is still the caller's. `NodeRuntime` does not install `NodeHost.layer` and does not install the guarded `HostServices` kernel, so `Jj`, Effect `FileSystem`, and Effect `Crypto` remain requirements of the returned layer, and the caller passes `StepBoundary` and `WorkspaceSandbox` in as arguments (`NodeRuntime.ts:105-121,128-131`). It also installs no process or signal handlers by design. Its application-source consumers in this repository are the worked composition in `examples/src/durable-layer.ts:13,36,76` and the production control executor in `packages/cli/src/NodeControl.ts`. The composition itself has a direct real-SQLite package gate at `packages/flows/test/NodeRuntime.test.ts`; the examples manifest dependency is owned separately, so the examples suite is not the evidence for this module's gate.
- Cross-process event-driven wake. The in-process `WakeBus` completes `resumeSignal` today; a wake published in another process still lands through polling and sweeps.
- Injectable retry classification, shareability, and wait/wake seams. Cache-conflict verdicts (`Inconsistency`) and owner identity (`OwnerIdentity`) are services today; the rest is still fixed engine behavior with no service or option in front of it.
- Graph-level failure policies such as quarantine or continue-on-failure.
- Detached child flow construction and lifecycle policy.
- Automatic creation of time-travel snapshots, lineage edges, and boundary records from ordinary engine execution.
- **Postgres/PGlite dialect parity, an accepted gap, not scheduled (issue #78).** The shipped SQL backend is Node SQLite (`@effect/sql-sqlite-node`). Browser package roots expose driver-neutral contracts, but no browser SQL client layer ships here. The journal migration ladder is SQLite-flavoured DDL, so a smithers workspace already on PGlite or Postgres cannot take stage 1 of the documented cutover. What did land is the dialect-blind write-retry seam: `DurableWriter.make` takes any `SqlClient`, and classification now covers the Postgres transient SQLSTATEs (`40001`/`40P01`/`55P03` and PGlite's text forms) as well as the SQLite codes, normalized onto the same `busy` category, so a hand-supplied `PgClient` is degraded rather than silently unprotected. Also SQLite-only, and *outside* the ladder, is the schema `DurableEngineState.make` creates at construction, the run-parent table, its index, the `flows_run_parents_gc` trigger, and the stale-running partial index, now inventoried with per-dialect notes in `packages/engine-store/src/internal/EngineStateSchema.ts` and pinned by a catalog-diff test so it cannot drift (issue #92). The remaining plan (pg/pglite layers, a dialect-parameterized ladder including that inventory, the suites run against PGlite in CI) is written out as new gap 4 in [`smithers-replacement-gaps.md`](/release/known-limitations).
- A fully runnable engine-store deployment for Cloudflare Workers.
- Fully durable serverless deferreds and clocks on Vercel.

## Integration cautions

- `EngineStore` no longer reaches for `process.pid` or `node:crypto` (`randomUUID`) directly: both enter through the injectable `OwnerIdentity` service, which closed issue #114 and made `@smthrs/engine-store`, and the `@smthrs/flows` barrel that re-exports it, browser entry points. The twenty-four browser-bundleable entry points, the seven that stay Node-only, and the `pnpm run browser` gate that executes both halves of the claim are listed in [browser support](/architecture/browser-support). What remains missing for a browser *deployment* is a SQL client behind the `DurableWriter` contract; none ships here. `StepBoundary` briefly added a module-scope `node:buffer` import for its base64 codec; it now uses the platform-neutral `effect/Encoding`, and a regression test pins the module `node:`-free since its contract schemas and `layerTest` must be importable from a browser bundle.
- `SqlTimeTravelStore.createFork` materializes executable state from the
  parent's current persisted snapshot and attempts, and records the lineage
  edge on `flows_runs.parent_run_id`. Those records are not historical per
  journal frame.
- The time-travel package reads cache keys from effect-boundary metadata. Callers recording those boundaries must use the same cache address convention as the cache producer.
- Flow registrations and active fibers are scoped in memory. A restarted process must re-register handlers before driving stored runs.
- The `DurableWriter.write` retry classifier is dialect-blind (issue #78): a hand-supplied PostgreSQL `SqlClient`, as the Vercel store adapter can wrap, gets the same bounded retry as SQLite. What is still missing for those backends is a shipped SQL client layer and a dialect-parameterized migration ladder, tracked above under "Postgres/PGlite dialect parity". A backend that does land must pass `packages/database/test/contract/DatabaseWriteContract.ts`, the conformance suite for the write-serialization contract (issue #97).

The packages are pre-1.0. Treat these boundaries as evolving compatibility contracts.

For the smithers-engine cutover view of this status, what is closed, partial, and missing versus the smithers internal engine, see [smithers-replacement-gaps](/release/known-limitations).

## Substrate pin and known upstream issues

`effect` is pinned to exactly `4.0.0-rc.108` in every release-1 engine manifest, as are the `@effect/*` packages that follow Effect's own version line (`@effect/platform-node`, `@effect/platform-node-shared`, `@effect/platform-bun`, `@effect/sql-sqlite-node`, `@effect/opentelemetry`, `@effect/vitest`). The agent-group packages, `examples`, and `apps/ui` hold the same pin.

Every workspace is on it, including `@smthrs/build-infra` (`packages/build/infra/package.json`), the `private: true` `smthrs.group: "tooling"` deployment workspace that held `4.0.0-rc.109` until the 1.0 root reconciliation aligned it. `scripts/check-single-effect-version.mjs` fails the build on a second version in any manifest, in either lockfile, or in the install.

Pinning a release candidate means an upstream defect is not fixed by a patch range: adopting a fix requires moving the pin across the whole workspace. This section is where known upstream defects against the pin are tracked. There is no separate tracker.

| Upstream issue | Upstream status | Status against the pin |
| --- | --- | --- |
| [Effect-TS/effect#7235](https://github.com/Effect-TS/effect/issues/7235): when `SqlClient.makeWithTransaction` cannot start `BEGIN IMMEDIATE` under contention, the failure branch still tries to roll back, so the typed `SqlError` is lost and the fiber dies with an unrecoverable defect containing `cannot rollback - no transaction is active` | Fixed by [PR #7236](https://github.com/Effect-TS/effect/pull/7236), merged 2026-08-13, first published in `effect@4.0.0-rc.109` (2026-08-14) | **Present in the pinned `4.0.0-rc.108`**, which was published 2026-08-12. Mitigated here rather than avoided: `WriteRetry.isRetryableWriteError` and `DurableWriter.fromSqlError` both match the defect's message text and classify it into the transient busy vocabulary, so a lost `BEGIN IMMEDIATE` race retries instead of killing the run (`packages/database/src/internal/WriteRetry.ts:74`, `packages/database/src/DurableWriter.ts:124`), and `packages/database/test/contract/DatabaseWriteContract.ts` pins that classification. See the [SQLite operating envelope](/sqlite-operating-envelope#write-contention). |
