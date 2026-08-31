# Removed and deprecated APIs at 1.0.0-rc.0

Every surface Smithers 0.x published that 1.0.0-rc.0 does not, with the
replacement a caller moves to, or `none` where there is no replacement in this
candidate.

Read this with the [compatibility promise](rc-contract.md#11-compatibility-promise):
1.0.0-rc.0 is a source migration, not a compatible upgrade. No shim, adapter,
or compatibility layer is published for anything on this page.

Sources, in precedence order. Where this page and a source disagree, the source
wins and this page is wrong.

| Section here | Authority |
| --- | --- |
| Authoring API | `docs/migration/rc-contract.md` section 11 |
| Packages | rc-contract sections 3.1, 3.2, 3.3; `docs/migration/disposition-ledger.md` |
| CLI verbs and flags | rc-contract section 4.2; `packages/cli/src/Unsupported.ts` |
| Control plane and engine | rc-contract section 5.2 |
| MCP tools | rc-contract section 4.1 |
| Gateway protocol | rc-contract section 7, the Gateway paragraph |
| Databases | rc-contract section 2 |
| Environment and exit codes | rc-contract section 4 |

The operator-facing version of this page is the published migration guide,
[smithers.sh/migration/1.0](https://smithers.sh/migration/1.0)
(`docs/pages/migration/1.0.md`), which prints the exact refusal sentence for
every removed verb. This page is the complete inventory, including the library
and protocol surfaces the guide does not enumerate.

## 1. Authoring API

The JSX authoring stack is gone in full: no runtime, no reconciler, no
components, no factory. A flow is `Flow.make`, a step is `Action.make`, and
control flow is `Node.andThen`, `Node.all`, and `Node.branch`.

| 0.x export or setting | Replacement |
| --- | --- |
| `smthrs/jsx-runtime` | none. There is no JSX runtime. |
| `smthrs/jsx-dev-runtime` | none. |
| `jsxImportSource: "smthrs"` in a tsconfig | none. Remove the setting; `@smthrs/flow` is plain TypeScript. |
| `createSmithers` | `Flow.make(tag, { payload, success, error, body })` from `@smthrs/flow` |
| `runWorkflow` | `FlowEngine` from `@smthrs/engine`, or `smithers up <flow>` |
| `renderFrame` | none. There is no host tree to render. |
| `SmithersCtx` | the planned value the previous node returned |
| `closeSingleRunnerRuntime` | scope closure on the `NodeRuntime` layer |
| `<Workflow>` | `Flow.make` |
| `<Task>` | `Action.make(tag, { payload, success })` with `.toLayer(handler)` |
| `<Task agent>` with prompt children | `AgentAction.make(tag, { payload, output, seat, system, prompt })` |
| `<Sequence>` | `Node.andThen` |
| `<Parallel>` | `Node.all` |
| `<Branch>` | `Node.branch` |
| `<Loop>` | `ReviewLoop.run`, or `Recursion.recurse` with explicit fuel |
| `<Ralph>` | `ReviewLoop.run` |
| `<Approval>` | `WithApproval.withApproval` |
| `<Signal>` | `WaitFor.action` plus `smithers signal` |
| `<Timer>` | `Sleep.action` |
| `<Subflow>` | `Flow.to`, or a child run through `EngineChildren` |
| `<Worktree>` | none in rc.0. Worktree lanes are deferred; `@smthrs/std` `Checkpoints.layerGit` pins a git tree per cell call. |
| `<Saga>` | `@smthrs/time-travel` `CompensationHandlers` |
| `<Kanban>` and the other 0.x pack components | `@smthrs/patterns` |
| `<ContinueAsNew>` | `Flow.Handoff` with `maxRounds`. There is no `Continued` terminal status. |
| `<UI>` dashboards and workflow UIs | none in rc.0. A run monitor on the new projections is new work. |
| zod schemas on a step boundary | `effect/Schema` |
| an agent adapter or a `fallbackAgents` pool | a seat string a `SeatResolver` resolves, from `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, or `SMITHERS_OPENAI_AUTH=chatgpt`. The multi-account seat pool moved to the plugins repository. |

## 2. Packages

### 2.1 Deleted outright, with no package at rc.0

| 0.x package | Replacement |
| --- | --- |
| `smithers-orchestrator` | `@smthrs/flows` for authoring and the engine, `@smthrs/cli` for the `smithers` command |
| `@smthrs/graph` | `@smthrs/core` (`Flow` and `Node` builders, `Graph`), `@smthrs/plan`, `@smthrs/keys` |
| `@smthrs/scheduler` | `@smthrs/engine-store` (`PlanScheduler`, `DurableEngineState`), `@smthrs/flow` `RetryPolicy` |
| `@smthrs/driver` | `@smthrs/flow` `FlowRuntime`, `@smthrs/engine`, `@smthrs/kernel` `ChildProcessSpawner`, `@smthrs/plan` |
| `@smthrs/react-reconciler` | none |
| `@smthrs/components` | `@smthrs/flow`, `@smthrs/patterns`, `@smthrs/time-travel` `CompensationHandlers`, `@smthrs/control` |
| `@smthrs/xstate` | none |
| `@smthrs/protocol` | `@smthrs/control` `ControlRpcs` |
| `@smthrs/control-plane` | `@smthrs/control` |
| `@smthrs/db` | `@smthrs/database` (`NodeDatabase`, `DurableWriter`, `Migrations`), `@smthrs/run-store`, `@smthrs/journal`, `@smthrs/step-cache` |
| `@smthrs/server` | `@smthrs/control` `ControlServer`, `@smthrs/sync` `SyncServer`, the `@smthrs/gateway` projection server behind `smithers serve` |
| `@smthrs/devtools` | `smithers status`, `smithers logs --json`, the gateway projections |
| `@smthrs/electric-proxy` | `@smthrs/sync`, the read-only journal replication protocol |
| `@smthrs/gateway-react` | none in rc.0 |
| `@smthrs/gateway-ui` | none in rc.0 |
| `@smthrs/gateway-client` | `@smthrs/control` `ControlClient` and `@smthrs/sync` `SyncClient` |
| `@smthrs/ui-core` | none in rc.0 |
| `@smthrs/tui` | none in rc.0. The terminal monitor is deleted. |
| `@smthrs/tui-ui` | none in rc.0 |
| `@smthrs/agents` | `@smthrs/model` seats and `@smthrs/agent` (`AgentSession`, `AgentAction`). The Claude Code and Codex subprocess adapters and the seat pool move to the plugins repository. |
| `@smthrs/accounts` | seat resolution from environment keys. The account registry moves to the plugins repository; the OAuth PKCE helpers move into `@smthrs/integrations`. |
| `@smthrs/usage` | none in core. Usage metering is Plue-owned. |
| `@smthrs/vcs` | `@smthrs/jj` and `@smthrs/std` `Checkpoints` |
| `packages/herdr` (the supervision client and run surface) | none. Supervision and hijack are removed. |
| `@smthrs/tool-context` | `@smthrs/harness` `FlowBinding` and `CallLedger` |
| `@smthrs/openapi` | none. The `smithers openapi` verb is removed and no spec-driven flow surface ships. |
| `@smthrs/telegram` | `@smthrs/integrations`, private at rc.0 |
| `@smthrs/agent-eliza`, `@smthrs/pi-plugin` | none |
| `@smthrs/aws`, `@smthrs/gcp`, `@smthrs/daytona` | none in core. A remote host implements `@smthrs/sandbox` `RemoteChildProcessSpawner.Provider`. |
| `@smthrs/cloudflare`, `@smthrs/vercel` | the plugins repository `host-cloudflare` and `host-vercel`, re-ported onto `@smthrs/kernel` and `@smthrs/sandbox`. No edge or serverless engine deployment ships in rc.0. |
| `@smthrs/microsandbox` | the plugins repository `host-microsandbox` |
| the five `@smthrs/jj-<platform>` binary packages | `jj` on `PATH`; `NodeJj` spawns it and reports `not_installed` |
| old `@smthrs/cli` (`apps/cli`) | `@smthrs/cli`, rebuilt on the control plane |

### 2.2 Replaced by the package of the same name

The name survives and every export changed. Treat these as new packages.

`@smthrs/engine`, `@smthrs/gateway`, `@smthrs/testing`, `@smthrs/time-travel`,
`@smthrs/memory`, `@smthrs/scorers`, `@smthrs/sandbox`, and
`@smthrs/observability` are the imported implementations, not ports of the 0.x
packages that held those names.

### 2.3 Published at 0.35.0, not published at rc.0

Each stays a workspace package and re-enters the public set when a registry
consumer with file evidence exists.

| Package | Reason |
| --- | --- |
| `@smthrs/ui`, `@smthrs/ui-styleguide` | no registry consumer at rc.0 |
| `@smthrs/evals`, `@smthrs/scorers` | not part of the engine release |
| `@smthrs/chain` | consumed only by `apps/ui` through `workspace:*` |
| `@smthrs/fs` | zero consumers |
| `@smthrs/triggers` | zero consumers; the replacement seam for `smithers cron` in a later candidate |
| `@smthrs/build` | build tooling, private with the rest of the build graph |
| `@smthrs/integrations` | rebuilt on the action, notification, and trigger APIs; no registry consumer at rc.0 |
| `@smthrs/errors` | trimmed to `SmithersError` and the codes `@smthrs/integrations` raises |

### 2.4 The unscoped `smthrs` package

`smthrs@1.0.0-rc.0` is a deprecation notice. It publishes no `bin`, exports `.`
only, and its one module throws on import. Replacement: `@smthrs/flows` for
authoring and the engine, `@smthrs/cli` for the `smithers` command.
`smthrs@0.35.0` keeps the `latest` dist-tag until 1.0.0 is final.

## 3. CLI

Every verb below is registered as a hidden subcommand that exits 1 and prints

```
smithers <verb> was removed in 1.0.0-rc.0: <reason>. See https://smithers.sh/migration/1.0#<verb>
```

Removed flags are declared hidden on the command that used to carry them and
fail the same way, so a stale script gets the migration sentence rather than a
usage error. Exit code 1, never 2.

Six 0.x names survive as aliases and are not removed: `inspect`, `why`,
`events`, `resume`, `gateway`, and `workflow list`.

### 3.1 Verbs

| 0.x verb | Removed forms | Replacement |
| --- | --- | --- |
| `smithers add` | `smithers add` | JSX pack tooling is gone; `smithers migrate` replaces `upgrade` |
| `smithers agents` | `smithers agents add\|list\|reauth\|remove\|test\|capabilities\|doctor` | moved to the plugins repository or deferred |
| `smithers alerts` | `smithers alerts` | moved to the plugins repository or deferred |
| `smithers ask` | `smithers ask` | removed with the JSX inline workflow |
| `smithers ask-human` | `smithers ask-human` | approvals park the run; use `ps --status waiting-approval`, `approve`, and `deny` |
| `smithers chat` | `smithers chat` | removed with the JSX inline workflow |
| `smithers chat-create` | `smithers chat-create` | removed with the JSX inline workflow |
| `smithers claude-shell` | `smithers claude-shell` | moved to the plugins repository or deferred |
| `smithers cron` | `smithers cron start\|add\|list\|rm` | moved to the plugins repository or deferred (cron returns on `@smthrs/triggers`) |
| `smithers diff` | `smithers diff` | time travel is a library API (`@smthrs/time-travel`) and worktree lanes are deferred |
| `smithers docs-full` | `smithers docs-full` | `docs-full` becomes `docs --full` |
| `smithers eject` | `smithers eject` | JSX pack tooling is gone; `smithers migrate` replaces `upgrade` |
| `smithers eval` | `smithers eval` | not part of the engine release |
| `smithers exec` | `smithers exec` | use `up` |
| `smithers fork` | `smithers fork` | time travel is a library API (`@smthrs/time-travel`) and worktree lanes are deferred |
| `smithers graph` | `smithers graph` | time travel is a library API (`@smthrs/time-travel`) and worktree lanes are deferred |
| `smithers gui` | `smithers gui` | replaced by `smithers serve` and the Electrobun product UI; the terminal monitor is deleted |
| `smithers help` | `smithers help` | use `--help` |
| `smithers herdr` | `smithers herdr status\|attach\|open\|clean` | moved to the plugins repository or deferred |
| `smithers hermes` | `smithers hermes` | moved to the plugins repository or deferred |
| `smithers hijack` | `smithers hijack` | not available; use `steer`, `signal`, `approve`, `deny`, `cancel`, `run --resume` |
| `smithers human` | `smithers human list\|resolve` | approvals park the run; use `ps --status waiting-approval`, `approve`, and `deny` |
| `smithers kill` | `smithers kill` | use `cancel` |
| `smithers list` | `smithers list` | use `ls` |
| `smithers list-runs` | `smithers list-runs` | use `ps` |
| `smithers listeners` | `smithers listeners` | moved to the plugins repository or deferred |
| `smithers log` | `smithers log` | use `logs` |
| `smithers make-workflow` | `smithers make-workflow` | JSX pack tooling is gone; `smithers migrate` replaces `upgrade` |
| `smithers monitor` | `smithers monitor` | replaced by `smithers serve` and the Electrobun product UI; the terminal monitor is deleted |
| `smithers node` | `smithers node` | use `output`, `logs --json`, and the `node-output` projection |
| `smithers observability` | `smithers observability` | moved to the plugins repository or deferred |
| `smithers openapi` | `smithers openapi list\|generate` | moved to the plugins repository or deferred |
| `smithers optimize` | `smithers optimize` | not part of the engine release |
| `smithers packs` | `smithers packs list\|update` | JSX pack tooling is gone; `smithers migrate` replaces `upgrade` |
| `smithers pause` | `smithers pause` | not available; use `steer`, `signal`, `approve`, `deny`, `cancel`, `run --resume` |
| `smithers release` | `smithers release` | not an rc.0 verb |
| `smithers remove` | `smithers remove` | JSX pack tooling is gone; `smithers migrate` replaces `upgrade` |
| `smithers replay` | `smithers replay` | time travel is a library API (`@smthrs/time-travel`) and worktree lanes are deferred |
| `smithers restore` | `smithers restore` | time travel is a library API (`@smthrs/time-travel`) and worktree lanes are deferred |
| `smithers retry-task` | `smithers retry-task` | time travel is a library API (`@smthrs/time-travel`) and worktree lanes are deferred |
| `smithers revert` | `smithers revert` | time travel is a library API (`@smthrs/time-travel`) and worktree lanes are deferred |
| `smithers review` | `smithers review` | not an rc.0 verb |
| `smithers rewind` | `smithers rewind` | time travel is a library API (`@smthrs/time-travel`) and worktree lanes are deferred |
| `smithers runs` | `smithers runs` | use `ps` |
| `smithers scores` | `smithers scores` | not part of the engine release |
| `smithers share` | `smithers share` | JSX pack tooling is gone; `smithers migrate` replaces `upgrade` |
| `smithers show` | `smithers show` | use `status` |
| `smithers snapshot-hook` | `smithers snapshot-hook` | time travel is a library API (`@smthrs/time-travel`) and worktree lanes are deferred |
| `smithers snapshots` | `smithers snapshots` | time travel is a library API (`@smthrs/time-travel`) and worktree lanes are deferred |
| `smithers start` | `smithers start` | use `up` |
| `smithers starters` | `smithers starters` | JSX pack tooling is gone; `smithers migrate` replaces `upgrade` |
| `smithers stop` | `smithers stop` | use `cancel` |
| `smithers supervise` | `smithers supervise` | the run driver's heartbeat sweep owns recovery |
| `smithers supervisor` | `smithers supervisor` | the run driver's heartbeat sweep owns recovery |
| `smithers tail` | `smithers tail` | use `output`, `logs --json`, and the `node-output` projection |
| `smithers test` | `smithers test` | not an rc.0 verb |
| `smithers timeline` | `smithers timeline` | time travel is a library API (`@smthrs/time-travel`) and worktree lanes are deferred |
| `smithers timetravel` | `smithers timetravel` | time travel is a library API (`@smthrs/time-travel`) and worktree lanes are deferred |
| `smithers token` | `smithers token issue\|exec\|revoke` | moved to the plugins repository or deferred |
| `smithers top` | `smithers top` | the run driver's heartbeat sweep owns recovery |
| `smithers tree` | `smithers tree` | time travel is a library API (`@smthrs/time-travel`) and worktree lanes are deferred |
| `smithers ui` | `smithers ui` | replaced by `smithers serve` and the Electrobun product UI; the terminal monitor is deleted |
| `smithers upgrade` | `smithers upgrade` | JSX pack tooling is gone; `smithers migrate` replaces `upgrade` |
| `smithers usage` | `smithers usage` | moved to the plugins repository or deferred |
| `smithers what` | `smithers what` | removed with the JSX inline workflow |
| `smithers workflows` | `smithers workflows` | use `ls` |
| `smithers worktrees` | `smithers worktrees list\|prune` | time travel is a library API (`@smthrs/time-travel`) and worktree lanes are deferred |

### 3.2 Subcommands removed from a verb that ships

| Removed form | Parent that ships | Replacement |
| --- | --- | --- |
| `smithers gateway status\|stop` | `smithers gateway` | replaced by `smithers serve` and the Electrobun product UI; the terminal monitor is deleted |
| `smithers workflow run\|path\|create\|inspect\|skills\|doctor` | `smithers workflow` | JSX pack tooling is gone; `smithers migrate` replaces `upgrade` |

### 3.3 Flags

| Command | 0.x flag | Replacement |
| --- | --- | --- |
| `smithers steer` | `--takeover` | hijack is not available; `steer --message` is the only mode |
| `smithers up` | `--serve` | replaced by `smithers serve` and the Electrobun product UI; the terminal monitor is deleted |
| `smithers up` | `--interactive` | replaced by `smithers serve` and the Electrobun product UI; the terminal monitor is deleted |
| `smithers up` | `--supervise` | replaced by `smithers serve` and the Electrobun product UI; the terminal monitor is deleted |
| `smithers up` | `--herdr` | replaced by `smithers serve` and the Electrobun product UI; the terminal monitor is deleted |
| `smithers up` | `--monitor` | replaced by `smithers serve` and the Electrobun product UI; the terminal monitor is deleted |
| `smithers up` | `--report` | replaced by `smithers serve` and the Electrobun product UI; the terminal monitor is deleted |
| `smithers up` | `--force` | the run driver's heartbeat sweep owns recovery |
| `smithers up` | `--steal-ownership` | the run driver's heartbeat sweep owns recovery |
| `smithers up` | `--resume-claim-*` | the run driver's heartbeat sweep owns recovery |
| `smithers up` | `--resume-restore-*` | the run driver's heartbeat sweep owns recovery |
| `smithers up` | `--max-concurrency <n>` | parallelism is declared by the flow and bounded by plan admission |
| `smithers migrate` | `--to <backend>` | SQLite only; the 0.x database move is removed |
| any command | `--backend pglite\|postgres` | SQLite only (`--backend sqlite` is accepted as a no-op) |
| any command | `--backend sqlite` | Not removed. Accepted as a no-op and exits 0, because SQLite is the supported backend. |
| `smithers init` | `--global` | rc.0 has no global pack; seats resolve from environment keys |

## 4. Control plane

| 0.x or import-reference surface | Replacement |
| --- | --- |
| `Pause` RPC in `ControlRpcs`, `ControlServer`, `ControlClient` | none. A run stops on `cancel` or parks on an approval and resumes with `smithers run --resume`. |
| `Control.pause`, `ControlLive.pause`, `layerNoop.pause` | none |
| `ControlRuntime.pause`, `SqlControlRuntime.pause` (public exports of `@smthrs/control`) | `writeStatus(runId, fence, "parked")`, the same ownership-releasing transition |
| the `control.run.pause` event kind | none |
| `hijackRun` RPC | none. Use `steer`, `signal`, `approve`, `deny`, `cancel`. |
| `POST /v1/pty/hijack` | none |
| `Control` question and answer RPCs behind `smithers human` | approvals: `ps --status waiting-approval`, `approve`, `deny` |
| `@smthrs/engine/human-requests` | `WithApproval.withApproval` and the approval RPCs |

## 5. Engine and library APIs

| 0.x or import-reference surface | Replacement |
| --- | --- |
| `FlowRuntime.interruptUnsafe` on the durable engine | `interrupt`. The durable engine has one cancellation path; `interruptUnsafe` now fails with `CancelRequestFailed` code `unsafe_interrupt_unsupported` instead of silently aliasing `interrupt`. |
| `RunStatus` value `continued` | none. A handed-off round settles `completed` with `lineage_id` and `round_ordinal`. |
| the `Checkpoint` host capability and the workspace lane lifecycle | `@smthrs/std` `Checkpoints.layerGit`, `ctx.checkpoint()`, `ctx.base` |
| `restoreWorkspace` | `@smthrs/time-travel` `rewind` |
| `GatewayCheckpointControls` | none |
| `snapshot-hook` | none |
| the `_smithers_workspace_*` tables | none. `.flows/engine.db` carries the rc.0 ladder. |
| `SuperviseRuntime` with a live supervisor process | the run driver's heartbeat sweep. `SuperviseRuntime` ships noop only. |
| the fallback-agent seat pool (`fallbackAgents`) | a seat string resolved from environment keys; the pool moved to the plugins repository |

## 6. MCP tools

`smithers --mcp` keeps the `{ ok, data?, error? }` envelope. Eleven tools are
supported. Ten keep their names and answer
`{ ok: false, error: { code: "unsupported", ... } }`, because a tool that
disappears breaks a client's tool list and a tool that pretends to work is
worse:

`revert_attempt`, `fork_run`, `replay_run`, `rewind_run`,
`restore_checkpoint`, `list_snapshots`, `get_timeline`, `time_travel`,
`list_artifacts`, `ask_human`.

Replacement for the first eight: the `@smthrs/time-travel` library API.
Replacement for `list_artifacts`: `@smthrs/artifacts`. Replacement for
`ask_human`: approvals.

## 7. Gateway protocol

| 0.x surface | Replacement |
| --- | --- |
| `POST /v1/rpc/<method>` (44 methods) | `POST /rpc`, one control request per call |
| WebSocket `/` | `/rpc/ws`, the same requests plus `Watch` |
| SSE `/v1/api/stream` | `/projections/ws` |
| the 0.x journal feed | `/sync` and `/sync/ws`, read-only journal replication |
| the 0.x health endpoint | `GET /health`, returning `GatewayHealth` |
| users, roles, per-run ownership | none. A bearer token binds one principal. |
| gateway-level webhook configuration | `@smthrs/control` `WebhookChannel`, library code only |

No 0.x method name or path is served, and there is no compatibility projection.

## 8. Databases

| 0.x surface | Replacement |
| --- | --- |
| `createSmithersPostgres` | none. rc.0 is SQLite only. |
| `createSmithersCloudflare` | none |
| `sharedPostgresPool` | none |
| `migrateSmithersStore` | the `Migrations` ladder in `@smthrs/database` |
| `packages/db` `dialect.js`, `schema-migrations.js`, `sql-message-storage.js`, `zodToCreateTableSQL.js` | `@smthrs/database`, `@smthrs/journal`, `@smthrs/run-store`, `@smthrs/step-cache` |
| the `pg`, `@electric-sql/pglite`, and `@electric-sql/pglite-socket` dependencies | none |
| `smithers.db` and `.smithers/executions/` | none. rc.0 does not load, resume, or migrate 0.x run state. `.flows/control.db` and `.flows/engine.db` are the rc.0 files. |
| `~/.smithers` global state | none. rc.0 does not read it. |

Pointing a 1.0 runtime at a 0.x database is refused, not merged:
`NodeDatabase.layer` raises `unsupported_database_file` for a file that has
tables and no `flows_migrations` table.

## 9. Environment variables

| 0.x name | rc.0 behavior | Replacement |
| --- | --- | --- |
| `SMITHERS_BACKEND=pglite` or `postgres` | exits 1 with `unsupported_database` | unset it, or set `sqlite` |
| `SMITHERS_TEST_PG_URL`, `SMITHERS_POSTGRES_URL`, every `SMITHERS_POSTGRES_*` | one stderr notice per name, then ignored. The exit code does not change. | none |
| `SMITHERS_YES` | not read. No rc.0 command prompts. | none |
| `SMITHERS_CLI` | not read | none |
| `SMITHERS_REPO_TOKEN` | not read | none |
| `SMITHERS_TOKEN` | not read | `SMITHERS_API_KEY` |
| `SMITHERS_BIN` | not read in core | none |
| `SMITHERS_WORKFLOW_PATHS` | not read | flow discovery over `flows/**` |
| `FLOWS_REMOTE`, `FLOWS_MCP_CONFIG`, `FLOWS_OPENAI_AUTH`, `FLOWS_TEST_*` | read as aliases through rc.0, removed at 1.0.0 | `SMITHERS_REMOTE`, `SMITHERS_MCP_CONFIG`, `SMITHERS_OPENAI_AUTH`, `SMITHERS_TEST_*` |

`SMITHERS_INSIDE_RUN` and `SMITHERS_RUN_ID` keep their 0.x meaning.

## 10. Exit codes

| Code | 0.x | rc.0 |
| --- | --- | --- |
| 0 | success | success |
| 1 | generic error | unsupported or generic error |
| 2 | (unused) | usage |
| 3 | (unused) | parked, waiting on an approval |
| 4 | usage | none. Usage is 2. |
| devtools 0, 1, 2, 3 | devtools-specific | none |
| 130 | SIGINT | SIGINT |
| 143 | SIGTERM | SIGTERM |

A plugin that asserted exit 4 for a usage error must change.

## 11. Skills

The 0.x per-verb command skills (`smithers-<verb>/SKILL.md`, written by
`smithers skills add`) are not regenerated. rc.0 `smithers skills add` writes
one curated `smithers` skill into the detected agents' skill directories.
Forty-three of the 0.x per-verb skills scripted a verb this page removes.

Replacement for the migration itself: the `migrate-smithers-v1` flow
(`flows/migrate-smithers-v1/`) and its skill
(`skills/migrate-smithers-v1/SKILL.md`), run through `smithers migrate` or the
standalone `smithers-migrate` bin from `@smthrs/migrate`.
