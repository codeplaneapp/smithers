# Plue consumer contract inventory

Status: Phase 0 deliverable required by `PLAN.md`, section "Plue cutover is part of the migration". Date: 2026-08-28.

Trees surveyed (read-only):

| Tree | Path | Revision |
| --- | --- | --- |
| Plue | `/Users/williamcory/plue` | `8e03dbe5d2` (2026-08-19), 4,591 tracked files; the frozen survey revision and the authority for every count in this document (ruling E9) |
| Old Smithers | `/Users/williamcory/smithers` | `cfb570f193`, `smthrs` 0.35.0 |
| Flows (import source) | `/Users/williamcory/flows/flows` | `393253c2b` (the import reference named by the orchestrator brief; rc-contract R-4) |

Delta to Plue HEAD `2db1ecff2` (2026-08-28, five commits after the survey revision; 237 files changed, 742 insertions, 38,808 deletions, mostly `65ccdff4e` "remove legacy UI and Electric stack"): root `package.json:23`, `packages/workflow/package.json:9`, and `cmd/runner/workflow/package.json:11` now pin `smithers-orchestrator ^0.32.0` (from `^0.9.1`, `^0.9.1`, `^0.28.0`), while `pnpm-lock.yaml` still resolves `0.9.1` and `cmd/runner/workflow/bun.lock` still resolves `0.28.0` (the lockfiles were not refreshed); `.smithers/workflows/pair-poc.tsx` is deleted, so the pack holds 56 `.tsx` files; `from "smithers-orchestrator"` statements fall from 99 to 98 and matching files from 85 to 84; `.smithers/ui` keeps 19 `.tsx` and 5 `.generated.ts`. No other number in this document moved; counts below are at the survey revision unless marked. Plue HEAD moved again to `664c95c60` on 2026-08-28 (three commits after `2db1ecff2`: tracing and observe features; `git diff --name-only 2db1ecff2..664c95c60` lists 78 files, none of which imports a smithers package). Ruling E9: the committed revisions are the only authority; the live Plue working tree is dirty (162 paths on 2026-08-28: `apps/marketing/**` and three `poc/smithers-ship/workflows/ship-pair-*.tsx` deleted, 129 files modified) and is never cited. The cycle-1 review's working-tree count (18 files, 23 import statements) could not be reproduced with the section 1 command, which gives 84 files and 125 statements at `664c95c60` and 82 and 123 in the working tree; this document pins the survey revision and records the deltas.

Sources: the Phase 0 reader findings file `phase0/plue-consumer-contract.md` (primary), `phase0/gateway-and-ui.md` section 6.1, `phase0/flows-cli-control.md` sections 2 and 5, `phase0/agents-and-capabilities.md`, `phase0/workflow-pack-and-skills.md`, and direct reads of the files cited below. Every count in this document was re-run against the Plue tree with `git ls-files | xargs grep`; where a re-run disagreed with a reader, section 2 records the ruling.

## 1. Summary

Plue reaches the old Smithers runtime through four production paths and one dev-automation pack. Nothing else in Plue (Go API, SSH, repo host, Postgres schema, Helm, Terraform, docker-compose, the product CLI `cmd/smithers`, `apps/ui`, `apps/admin`, `packages/sync-platform`, `apps/github-sync`, `apps/notion-sync`) links to it. One more bootstrap line spells the 0.x verb without reaching the engine: the workspace VM `packInitScript` (`internal/services/workspace_provisioning.go:85`) runs `init --global --no-skill` against the staged Plue Go CLI, which has no `init` verb (section 6.1, ruling F1).

| Path | What runs | Pin | Coupling that the RC must replace |
| --- | --- | --- | --- |
| A. Agent VM, one engine run per chat turn | `cmd/runner/workflow/agent.ts` spawns `bun run node_modules/smithers-orchestrator/src/bin/smithers.js up agent-task.tsx --root <repo> --run-id <uuid> --max-concurrency 1` (`agent.ts:246,295`) | `smithers-orchestrator@^0.28.0` (`cmd/runner/workflow/package.json`; `^0.32.0` at `2db1ecff2`, `bun.lock` still 0.28.0) | JSX `<Workflow><Task agent>` (`agent-task.tsx:749-750`), `AgentLike` (`agent-task.tsx:24,171`), durable event file `.smithers/executions/<runId>/logs/stream.ndjson` (`agent.ts:99-106,290-293`), engine event names (section 7.2) |
| B. Sandbox whole-workflow plane (`POST /api/repos/{o}/{r}/invoke`, CI dispatch) | Generated `/opt/smithers/run-workflow.sh` runs `SMITHERS_YES=1 bun x --package smithers-orchestrator@0.28.0 smithers init --global --no-skill`, then `smithers up <path> --root /workspace/repo --max-concurrency 1 --run-id <plue run id>` (`workflow_sandbox_scheduler.go:1010,1035-1037`) | `smithers-orchestrator@0.28.0` string constant (`workflow_sandbox_scheduler.go:58`) | CLI verbs and flags, non-interactive init, exit-code-to-status mapping |
| C. Repo gateway VM (product path for the imported Flows UI and Worker) | systemd service runs `bun x --package smthrs@0.33.0 smithers gateway --host 0.0.0.0 --port 7331 --backend sqlite` (`repo_gateway.go:1682-1683`); Plue relays `/api/gateways/{id}/*` to it | `smthrs@0.33.0` (`repo_gateway.go:69`), Bun `1.3.14` (`:74`), plus an embedded patched `@smthrs/engine/src/workflow-hash.js` (`repo_gateway_engine_patch.go:28`) | `/v1/rpc/<method>` catalog, WebSocket `connect` handshake, `/v1/api/stream`, `/health`, `SMITHERS_API_KEY`, version floor `>= 0.33` (section 4) |
| D. Static CI-workflow DSL (`@smithers-ai/workflow`) | Go parser runs `bun run scripts/workflow-evaluator.ts <tmp>.tsx` (`workflow_parser.go:14,140`); the Go runner executes steps itself and installs a JSX-free shim at task time (`tsx-task-runtime.ts`) | `smithers-orchestrator@^0.9.1` in `packages/workflow/package.json` and root `package.json:23` (`^0.32.0` at `2db1ecff2`, `pnpm-lock.yaml` still 0.9.1) | Typings and re-exports only at run time; the package itself imports `createSmithers` and the JSX components (section 14 D1, rc-contract R-19) |
| E. Dev-automation pack `.smithers/` | 57 JSX `.tsx` files (56 at `2db1ecff2`), 10 JSX components, 19 custom React run UIs, 35 MDX prompts, `agents.ts`; GitHub Actions `pipeline-fast.yml` and `pipeline-thorough.yml` run two of them with `smithers up`; root `package.json:7-17` cron scripts drive `fix-all-issues.tsx` | `file:../../smithers/packages/smithers` (`.smithers/package.json`), a symlink into the old Smithers working tree | Everything: JSX, `createSmithers`, `Worktree`, `openSmithersBackend`, `fallbackAgents`, `mdxPlugin`, gateway-react hooks, gateway-ui and ui components, `smithers ps/inspect/events/eval` JSON output |

Verified totals: 85 tracked files match `from "smithers-orchestrator…"`, `from "@smithers-orchestrator/…"`, or `from "@smthrs/…"`; 83 are source files and 2 are prose (`docs/context/AGENT-002.md`, `.smithers/prompts/create-workflow-scaffold.mdx`). Import statements by specifier: `smithers-orchestrator` 99, `smithers-orchestrator/gateway-react` 10, `smithers-orchestrator/gateway-ui` 6, `smithers-orchestrator/linear` 3, `smithers-orchestrator/ui` 1, `smithers-orchestrator/testing` 1, `smithers-orchestrator/mdx-plugin` 1, `smithers-orchestrator/jsx-runtime` 1, `smithers-orchestrator/gateway-client` 1, `@smithers-orchestrator/testing` 1, `@smithers-orchestrator/super-ralph` 1, `@smthrs/errors/SmithersError` 1, and bare `smthrs` 2 (`internal/services/repo_gateway.go:157-158`, an `agents.ts` template embedded in a Go string that the production Path C provisioner writes to the gateway VM; it is not a `.ts` file, so the file counts above exclude it). Ruling E6: the regex above also misses the bare specifier `smithers`, which only `.smithers/workflows/batch-issues/**` uses (13 statements in 10 files: 11 from bare `smithers`, 1 from `smithers/mdx-plugin`, 1 from `smithers/tools`, and none from `smithers-orchestrator`; `git grep -hE 'from "smithers(/[a-z-]+)?"|from "smithers-orchestrator' 8e03dbe5d2 -- .smithers/workflows/batch-issues | sort | uniq -c`, re-run 2026-08-28, ruling F6; 45 tracked files, last commit `c3588a371` on 2026-07-15); its own `package.json` resolves `smithers` to the old monorepo root (`"smithers": "file:../../../../smithers"`). Section 10 records its disposition.

## 2. Rulings on reader disagreements

| # | Claim in conflict | Ruling | Evidence |
| --- | --- | --- | --- |
| R1 | `gateway-and-ui.md` 6.1: "Zero imports of `gateway-client`, `gateway-react`, `gateway-ui`, `ui` in plue source." `plue-consumer-contract.md` 3: 10, 6, 1, 1 import statements. | The Plue reader is right. The gateway reader searched `@smthrs/*` names; Plue imports these packages through facade subpaths (`smithers-orchestrator/gateway-react` and so on). | `grep -rhoE` over `.smithers/ui` and `byok-subscription-accounts-monitor.tsx`: `createGatewayReactRoot` 18, `useGatewayNodeOutput` 44, `useGatewayRuns` 14, `useGatewayActions` 12, `useGatewayRunEvents` 8, `useGatewayRun` 8, `useGatewayRunTree` 6, `useGatewayApprovals` 4, `useGatewayTickets` 2, `SmithersGatewayClient` 2, `WorkflowUiStyles` 12, `KpiStat` 6, `SectionHeader` 5, `Card` 5, `StatusPill` 4, `EmptyState` 3, `StageStrip` 2, `RunEventLog` 2, `ApprovalPanel` 2. |
| R2 | Import-site totals: `gateway-and-ui.md` says 26 `smithers-orchestrator` sites; `agents-and-capabilities.md` says 17; the Plue reader says 83 files and 111 statements. | 85 tracked files (83 source) is the whole-tree number. The two smaller numbers are scoped counts (agent-class imports; non-pack files) and do not contradict it. The Plue reader's 111 statements used a narrower pattern than the 126 counted here; the file set is identical apart from the two prose files. | Command in section 1. |
| R3 | Plue reader: `.smithers/ui` holds 16 `.tsx` and 5 `.generated.ts`. | 19 `.tsx` plus 5 `.generated.ts`, 24 tracked files, 9,565 lines. | `git ls-files '.smithers/ui/*'`. |
| R4 | Plue reader: 37 MDX prompts. | 35 tracked `.mdx` files under `.smithers/prompts`; 8 more under `.smithers/workflows/batch-issues/prompts`. | `git ls-files '.smithers/prompts/*.mdx'`. |
| R5 | Plue reader section 5 lists "JSON `--input`" as a Path B requirement. | Path B never delivers inputs today. `InvokeWorkflow` persists `dispatch_inputs` (`internal/services/workflow_invoke.go:23-24,103-105`) but `workflow_sandbox_scheduler.go` contains no `input` or `dispatch` reference and its `runArgs` array is `["up", path, "--root", root, "--max-concurrency", "1"]` plus `--run-id`. JSON input stays in the engine feature set because Tier 1 CI uses it (`pipeline-fast.yml:37`, `--input "{\"sha\":…}"`), not because of Path B. | `grep -niE input internal/services/workflow_sandbox_scheduler.go` returns nothing. |
| R6 | `PLAN.md` says the Plue pack contains 57 JSX workflow files; the brief says 41 `.tsx` plus 6 `.ts`. | Both are correct. `.smithers/workflows` holds 57 `.tsx` files in total (41 top-level, 2 under `pipelines/`, 14 under `batch-issues/`) and 47 top-level files (41 `.tsx`, 6 `.ts`). Section 10 ranks the 47. | `git ls-files '.smithers/workflows/**'`. |
| R7 | `gateway-and-ui.md` 8.4 and `flows-cli-control.md` 5.5 treat the run-event stream as a cursor-based `Sync.Subscribe`; the Plue reader describes the old `streamRunEvents` with `afterSeq` and 1 Hz heartbeats. | Both describe real contracts on different sides of the seam. `Control.Watch` (`packages/control/src/ControlRpcs.ts:177`) has no heartbeat frame; `Sync.Subscribe` does (`packages/sync/src/SyncProtocol.ts:181,199`). The relay severs idle WebSockets at about 600 s, so the RC gateway stream must emit keepalives; section 11 lists it as a requirement. | Files cited. |

Port rulings recorded here so implementers do not reopen them:

| # | Ruling | Basis |
| --- | --- | --- |
| P1 | Path A moves to an in-process `@smthrs/agent` and `@smthrs/harness` call with a journal subscription; no per-turn engine process and no `stream.ndjson` follower. The engine's only contribution today is a typed per-call event log and structured-output parsing. | `PLAN.md` "Port behavior, not old internal APIs"; reader section 4 port note; Flows has no `stream.ndjson` writer (`grep -rl stream.ndjson packages apps` is empty). |
| P2 | The RC gateway does not ship a `/v1/rpc` compatibility projection. The Flows Worker (`apps/server/src/gateway.ts`) and Plue's relay tests retarget to the imported control and projection contracts (`/rpc`, `/rpc/ws`, projections). Plue's relay is path-agnostic (`internal/routes/repo_gateway.go:116-126`), so only test path strings and the Worker allowlist change on the Plue side. | `PLAN.md` Phase 4 "Treat the imported gateway, control, journal, run-store, notification, and sync models as the backend contract"; PLAN rule "Do not add adapters whose only purpose is to preserve JSX or old engine contracts". |
| P3 | The engine CLI owns the `smithers` executable everywhere, including developer machines and Plue CI (rc-contract D7, R-20, §3.4, §10). Plue's product CLI (`cmd/smithers`, npm `@smithers/cli`, `packages/npm-cli/package.json:6-9`, which today maps both `smithers` and `plue` to `bin/plue.js`) drops the `smithers` bin key and publishes `plue` only; `canary.yml:123` builds `bin/plue` instead of `bin/smithers`, and no Plue artifact installs a `smithers` executable. Plue's engine invocations keep going through a package (`bun x --package …`) or `SMITHERS_ORCHESTRATOR_CLI`, never through a Plue-provided `smithers` on PATH. | rc-contract R-20 and §10 ("`packages/npm-cli/package.json` bin map becomes `{ plue: bin/plue.js }`"); PLAN default "Keep the user-facing `smithers` binary and make the imported CLI own it"; current Plue practice: `pipeline-fast.yml:37` prepends `.smithers/node_modules/.bin`; `repo_gateway.go:1611,1682` and `workflow_sandbox_scheduler.go:1010` use `bun x --package`. |
| P4 | Local 0.x run state in the Plue checkout (`smithers.db` 624 MB, `.smithers/smithers.db*`, `.smithers/executions/`, `cmd/runner/workflow/.smithers/`, 42 `run-*.log` files) is finished, archived, or discarded; nothing imports it. | PLAN default "Existing run data". |

## 3. Imported packages, exports, types, and hooks

### 3.1 Manifests and pins

| Manifest | Declared | Installed | Notes |
| --- | --- | --- | --- |
| `package.json` (root, devDependencies, line 23) | `smithers-orchestrator: ^0.9.1` | pnpm-lock 0.9.1 | Serves `packages/workflow` typecheck and `scripts/smithers.tsx`. `react` and `react-dom` are pinned to 19.2.4 in dependencies and in `overrides` (lines 30-31, 39-40, 52-53) only because the old engine renders through react-dom; `bench/src/preflight.ts:7-22` self-heals that mismatch. Root `zod` is `^3.25.76`. |
| `packages/workflow/package.json` (`@smithers-ai/workflow` 0.0.1) | `smithers-orchestrator: ^0.9.1`, `react 19.2.4`, `zod ^4.3.6` | via root | tsconfig `jsxImportSource: smithers-orchestrator`. |
| `cmd/runner/workflow/package.json` (`smithers-workflow-runtime`, Bun-managed, outside the pnpm workspace) | `smithers-orchestrator: ^0.28.0`, `ai ^6`, `@ai-sdk/{anthropic,google,openai}`, `node-pty`, `tsx 4.22.4`, `zod 4.4.3`; `trustedDependencies` `@smithers-orchestrator/jj-{darwin-arm64,linux-arm64,linux-x64}` | `bun.lock` 0.28.0 | Installed by `cmd/agent-vm/Dockerfile:125`, `cmd/runner/Dockerfile:201`, `build.zig:81-82` (`workflow-install` step), `.github/workflows/canary.yml:114`. |
| `.smithers/package.json` (`smithers-workflows`) | `smithers-orchestrator: file:../../smithers/packages/smithers`, `zod 4.3.6`, `@types/{bun,react,react-dom,mdx}` | symlink to `/Users/williamcory/smithers/packages/smithers` (`smthrs` 0.35.0) | `pipeline-fast.yml:19,35` checks out `smithersai/smithers` beside Plue and runs `bun install --cwd .smithers --frozen-lockfile`; CI breaks the moment `packages/smithers` leaves Smithers main. `bunfig.toml` preloads `preload.ts`, which calls `mdxPlugin()`. `tsconfig.json:11-12` sets `jsx: react-jsx`, `jsxImportSource: smithers-orchestrator`. Scripts `workflow:list\|run\|implement` call `smithers workflow …`. |
| `internal/services/workflow_sandbox_scheduler.go:58` | `smithers-orchestrator@0.28.0` | fetched at VM boot | `SMITHERS_ORCHESTRATOR_CLI` (`:1039`) overrides with a local CLI path. |
| `internal/services/repo_gateway.go:69,74` | `smthrs@0.33.0`, Bun `1.3.14` | fetched at VM provision | `TestRepoGatewayOrchestratorPin_IsPublishedSmthrsWithAutoResume` (`repo_gateway_test.go`) requires name `smthrs` and minor `>= 33`. |
| `poc/smithers-ship/package.json:6` | `smithers-orchestrator: 0.28.0` | own `bun.lock` | Excluded from the pnpm workspace; 5 JSX workflows. |
| `.smithers/workflows/batch-issues/package.json` (`batch-issues-workflow`) | `smithers: file:../../../../smithers` (the old monorepo root, not `packages/smithers`), `zod ^4.5.2`, `@linear/sdk`, `ai ^7`, `react-dom 19.2.8` | own `pnpm-lock.yaml` | Imports `GeminiAgent`, `getLinearClient`, `useLinear`, `Worktree`, `MergeQueue`, `renderMdx`, `tools` from bare `smithers`; dead since `GeminiAgent` became a throwing shim (old `packages/agents/src/GeminiAgent.js:89,93`, `GEMINI_SUNSET_MESSAGE`); ruling E6. |
| `bench/package.json` | none | `SMITHERS_CLI` env or PATH | `bench/src/smithers-arm.ts:36,53` generates a `createSmithers` workflow at run time. |

Zod pins differ per install root: root `^3.25.76`, `packages/workflow` `^4.3.6`, `.smithers` `4.3.6`, `cmd/runner/workflow` `4.4.3`. The RC packages need one Zod expectation per install root.

### 3.2 Symbols imported

Counts are files containing the import; "where" names the consumers.

| Symbol | Specifier | Files | Where |
| --- | --- | --- | --- |
| `createSmithers` | `smithers-orchestrator` | 45 | every JSX workflow, `packages/workflow/src/create.tsx`, `cmd/runner/workflow/smithers.ts`, `bench/src/smithers-arm.ts`, `scripts/smithers.tsx` |
| `Sequence` | `smithers-orchestrator` | 22 | workflows, components |
| `Task` (bare) | `smithers-orchestrator` | 18 | `batch-issues` components, `packages/workflow/src/components.tsx` |
| `CodexAgent` | `smithers-orchestrator` | 16 | `.smithers/agents.ts`, `agents/codex.ts`, `lib/codexAccounts.ts`, `lib/ddd/dddAgents.ts`, workflows, `scripts/smithers.tsx` |
| `AgentLike` (type) | `smithers-orchestrator` | 13 | `.smithers/agents.ts:5`, `components/roles.ts`, `cmd/runner/workflow/agent-task.tsx:24`, workflows |
| `AgentLike` (type), `OpenAIAgent` | `smthrs` (bare, embedded in a Go string) | 1 | `internal/services/repo_gateway.go:157-158`, the `repoGatewayAgentsTs` template written to `/root/.smithers/agents.ts` on every gateway VM (section 4.1); a production Path C consumer of the deleted `@smthrs/agents` surface |
| `UI` | `smithers-orchestrator` | 9 | workflows declaring `<UI ui="../ui/x.tsx">` |
| `createGatewayReactRoot` | `smithers-orchestrator/gateway-react` | 9 | `.smithers/ui/*.tsx` |
| `ClaudeCodeAgent` | `smithers-orchestrator` | 8 | agents, ddd, workflows |
| `useGatewayNodeOutput` | `smithers-orchestrator/gateway-react` | 8 | `.smithers/ui/*` |
| `Loop`, `Parallel` | `smithers-orchestrator` | 7 each | workflows, components |
| `useGatewayRuns` | `smithers-orchestrator/gateway-react` | 7 | `.smithers/ui/*` |
| `useGatewayActions` | `smithers-orchestrator/gateway-react` | 6 | `.smithers/ui/*` |
| `WorkflowUiStyles` | `smithers-orchestrator/gateway-ui` | 6 | `.smithers/ui/*` |
| `Panel` | `smithers-orchestrator` | 5 | workflows |
| `Worktree` | `smithers-orchestrator` | 5 (8 files use `<Worktree`) | `alpha-plue`, `fix-all-issues`, `ticket-fleet`, `byok-subscription-accounts`, `issue-pipeline`, `ticket-kanban`, `batch-issues/components/IssuePipeline.tsx`, `scripts/smithers.tsx` |
| `useGatewayRunEvents` | `smithers-orchestrator/gateway-react` | 4 | `.smithers/ui/*` |
| `Workflow` (bare) | `smithers-orchestrator` | 3 | `packages/workflow/src/components.tsx`, `poc`, tests |
| `useGatewayRun`, `useGatewayRunTree` | `smithers-orchestrator/gateway-react` | 3 each | `ui/alpha-plue.tsx`, `ui/ticket-fleet.tsx`, `ui/docs-driven-development.tsx` |
| `Approval`, `Branch`, `KimiAgent`, `OpenCodeAgent`, `Ralph`, `LinearWebhookListener`, `SmithersRenderer`, `TryCatchFinally`, `approvalDecisionSchema`, `openSmithersBackend`, `runWorkflow` | `smithers-orchestrator` | 2 each | `openSmithersBackend`: `alpha-plue.tsx`, `fix-all-issues.tsx` (direct old-database access); `LinearWebhookListener`, `SmithersRenderer`, `runWorkflow`: `scripts/smithers.tsx` and compiled `scripts/smithers.js` |
| `useGatewayApprovals` | `smithers-orchestrator/gateway-react` | 2 | `ui/docs-concision.tsx`, `ui/ticket-fleet.tsx` |
| `getLinearClient`, `LinearIssue`, `LinearIssueStatus`, `WebhookIssueEvent` | `smithers-orchestrator/linear` | 1-2 | `scripts/smithers.tsx:33`, `scripts/smithers.js` (the Linear client is rebuilt in core as `@smthrs/integrations`, private at rc.0, ruling A7; the script itself is a Phase 6 fixture) |
| `AmpAgent`, `ApprovalGate`, `HermesCliAgent`, `OpenAIAgent`, `OpenClawAgent`, `PiAgent`, `VibeAgent`, `AntigravityAgent`, `Timer`, `fallbackAgents`, `mdxPlugin`, `OutputTarget`, `CreateSmithersApi`, `SmithersCtx`, `SmithersWorkflow`, `SmithersWorkflowOptions` | `smithers-orchestrator` | 1-2 | `.smithers/agents.ts` (several commented out), `components/roles.ts`, `alpha-plue.tsx` (`fallbackAgents`), `byok-subscription-accounts-monitor.tsx` (`Timer`), `.smithers/preload.ts` (`mdxPlugin`), `packages/workflow/src/*` (types) |
| `SmithersGatewayClient` | `smithers-orchestrator/gateway-client` | 1 | `byok-subscription-accounts-monitor.tsx` |
| `useGatewayTickets` | `smithers-orchestrator/gateway-react` | 1 | `ui/docs-driven-development.tsx` |
| `ApprovalPanel`, `RunEventLog`, `StatusPill` | `smithers-orchestrator/gateway-ui` | 1 each | `ui/ddd-*`, `ui/docs-concision.tsx` |
| `Card`, `EmptyState`, `KpiStat`, `SectionHeader`, `StageStrip` | `smithers-orchestrator/ui` | 1 each | `ui/ddd-shared.tsx` |
| `renderWorkflow`, `simulate` | `smithers-orchestrator/testing`, `@smithers-orchestrator/testing` | 2 | `alpha-plue.test.ts`, `byok-subscription-accounts.test.ts` |
| `jsx`, `jsxs` | `smithers-orchestrator/jsx-runtime` | 1 | `scripts/smithers.js` (compiled artifact) |
| `SmithersError` | `@smthrs/errors/SmithersError` | 1 | `internal/services/assets/repo-gateway-workflow-hash-smthrs-0.33.0.js` (embedded engine patch) |
| Re-exports `Sequence, Parallel, Branch, Ralph, runWorkflow` and types `SmithersCtx, SmithersWorkflow, SmithersWorkflowOptions, OutputKey, OutputAccessor, InferOutputEntry` | `smithers-orchestrator` | 1 | `packages/workflow/src/index.ts` |

Files by area (importing files): `.smithers/workflows` 37, `.smithers/ui` 10, `.smithers/components` 10, `poc` 6, `packages/workflow` 4, `.smithers/agents/` 4, `cmd/runner` 3, `scripts` 2, `.smithers/lib` 2, `internal/services` 1, `bench` 1, `.smithers/agents.ts` 1, `.smithers/preload.ts` 1, `.smithers/evals` 1, prose 2.

`.smithers/agents.ts` (`smithers-source: generated`, lines 1-12) registers `ClaudeCodeAgent`, `CodexAgent`, `OpenCodeAgent`, `AmpAgent`, `KimiAgent`, `OpenAIAgent` (Gemini through an OpenAI-compatible base URL) and exports tier arrays typed `Record<string, AgentLike[]>`. The agents reader counts class references across Plue: `CodexAgent` 36, `ClaudeCodeAgent` 11, `GeminiAgent` 7, `KimiAgent` 5, `AntigravityAgent` 4, `OpenAIAgent` 3, `AmpAgent` 2.

### 3.3 Facade subpaths with no Flows equivalent

Plue resolves `.`, `./gateway-client`, `./gateway-react`, `./gateway-ui`, `./jsx-runtime`, `./testing`, `./ui`, `./linear`, `./mdx-plugin` from the `smthrs` facade (`packages/smithers/package.json` exports plus the `./*` wildcard). Flows `packages/` has none of `gateway-react`, `gateway-ui`, `ui`, a testing facade, `linear`, or `mdx-plugin`; Flows `apps/ui` depends on the registry `@smthrs/ui@0.33.0`, the old package (`gateway-and-ui.md` 8.1).

The contract test that pins this surface is `e2e/api/smithers-agent-system.test.ts` (707 lines): it asserts the installed package is named `smithers-orchestrator` (`:87`), depends on `@smithers-orchestrator/{agents,components}` (`:94-96`), exports `Workflow, Task, Sequence, Parallel, Ralph, Worktree` (`:111-118`), `createSmithers`, `runWorkflow` (`:121-124`), `renderFrame` (`:127-129`), active CLI agent adapters (`:132`), and that `smithers.ts` uses `createSmithers` (`:221`).

## 4. Gateway transport, DTO, websocket, and subscription assumptions

### 4.1 Gateway process contract (Path C, `internal/services/repo_gateway.go`)

One gateway VM per (repo, user):

1. `installGatewayRuntime` installs Bun `1.3.14` and jj under `/usr/local/bin`.
2. `installGlobalSmithersPack` (`:1590-1626`): `HOME=/root`, `TMPDIR=/workspace/.tmp`, `XDG_CACHE_HOME=/workspace/.cache`, `SMITHERS_YES=1`. If a seat key is configured it writes `/root/.smithers/agents.ts` from the `repoGatewayAgentsTs` template (`:156`; marker `smithers-gateway-agent-seat-v2`, `:134`) which imports `AgentLike` and `OpenAIAgent` from `smthrs` and points every stock tier at one Cerebras `gpt-oss-120b` OpenAI-compatible seat with `write_file`, `read_file`, `list_dir`, `run_command` tools. Then `/usr/local/bin/bun x --package smthrs@0.33.0 smithers init --global --no-skill` (`:1611`), then `ln -sfn /root/.smithers/node_modules /workspace/repo/.smithers/node_modules` (`:1619`) so repo-local workflows resolve bare `smithers-orchestrator` and `zod`.
3. `patchGatewayEngine` (`:1553-1588`) overwrites both on-VM copies of `@smthrs/engine/src/workflow-hash.js` with the embedded fixed file when they contain `WORKFLOW_HASH_RESOLUTION_FAILED` and lack `SCANNABLE_MODULE_EXTENSIONS` (`:1541`); a copy with neither marker fails provisioning. The reuse check greps for the seat marker and the patch marker (`:1058-1059`).
4. `startGatewayService` (`:1676-1700`): systemd `smithers-gateway`, restart on failure, workdir `/workspace/repo`, env `HOME`, `PATH`, `SMITHERS_API_KEY=<smithers_gateway_… token>` (`:1656`), `TMPDIR`, `XDG_CACHE_HOME`, `CEREBRAS_API_KEY`, and per-provider seat keys from Plue config `SMITHERS_GATEWAY_AGENT_{ANTHROPIC,OPENAI,OPENROUTER,CEREBRAS}_API_KEY`.
5. Health: `GET <preview-ingress>/__preview/<vm-domain>/health` (`:1087`), 15 attempts at 4 s.
6. Token model: `db/schema.sql` `repo_gateways` (lines 4550-4566) stores the operator token encrypted because "the stock `smithers gateway` accepts ONLY the exact operator token it was started with (fixed in-memory map; no DB tokens, no RPC mint)". The old CLI reads `SMITHERS_TOKEN || SMITHERS_API_KEY` (`apps/cli/src/gateway-runtime.js:703`) and requires the token to bind a non-loopback `--host` (`apps/cli/src/index.js:3092`).

### 4.2 Relay (`internal/routes/repo_gateway.go`, `cmd/server/router.go:576-577`)

- `POST /api/repos/{owner}/{repo}/gateway` returns `{gateway_id, token, base_url, expires_at, status}` with `base_url = <origin>/api/gateways/<id>` (`:72`) and `Cache-Control: no-store` (`:67`); errors are 401, 409 "still provisioning", 500 `no_capacity`.
- `ANY /api/gateways/{gatewayID}` and `/api/gateways/{gatewayID}/*` require `Authorization: Bearer <gateway token>` (`:88,102`), strip the prefix (`:116`), and reverse-proxy HTTP and WebSocket upgrades (`:126`) to `http://preview-gateway-preview-gateway.smithers.svc.cluster.local:3000/__preview/<domain>/<path>` (`:109`). No browser WebSocket path exists; idle WebSockets are severed at about 600 s.
- Path pins in tests and scripts: `internal/routes/repo_gateway_test.go:126,143` (`/v1/rpc/listWorkflows`), `cmd/server/repo_gateway_cors_test.go:10` (`/api/gateways/gateway-1/v1/rpc/launchRun`), `scripts/prewarm-workspaces.sh:159` (`POST $gw_base/v1/rpc/listWorkflows`).

### 4.3 Wire protocol observed live (`WAVE4-RELAY-RECEIPT.md:222-232`, smthrs 0.33.0)

- WebSocket open at `wss://…/api/gateways/{id}/`. Server sends `{"type":"event","event":"connect.challenge","payload":{"nonce"},"seq":1}`. Client sends `{"type":"req","id","method":"connect","params":{"minProtocol":1,"maxProtocol":1,"client":{…},"auth":{"token":"smithers_gateway_…"},"subscribe":[runIds]}}`. Server replies `{"type":"res","ok":true,"payload":{"identity":{"workspaceRoot","version":"0.33.0","pid"},"auth":{"role":"operator","scopes":["*"]}}}`.
- `streamRunEvents {runId}` returns `{streamId, currentSeq}`; pushed frames are `run.heartbeat` at 1 Hz while parked and `run.event` (`node.started`, `node.finished`, `run.completed {status}`, `approval.decided {nodeId, approved}`).
- HTTP RPC is `POST …/v1/rpc/<method>` with JSON bodies; SSE is `GET …/v1/api/stream` with an `afterSeq` cursor (Flows `apps/server/src/gateway.test.ts:766,799`). All of `connect.challenge`, `minProtocol`, `maxProtocol`, `/health`, `run.heartbeat`, `run.event`, `/v1/rpc`, `/v1/api/stream`, and `SMITHERS_API_KEY` are present in the old tree's `packages/gateway/src` and `packages/server/src`.
- Old RPC catalog (`/Users/williamcory/smithers/packages/protocol/src/gatewayRpcTypes.ts:39-83`, `GatewayRpcMethod`, 44 named methods): `listWorkflows, launchRun, getRun, listRuns, listRunDescendants, cancelRun, pauseRun, resumeRun, rewindRun, hijackRun, submitSignal, listApprovals, submitApproval, getNodeOutput, getNodeDiff, getRunDiff, streamRunEvents, whatHappened, listTickets, createTicket, updateTicket, deleteTicket, cronList, cronCreate, cronDelete, cronRun, listPrompts, listDocs, listMemoryFacts, listUsageReports, listRunTokenUsage, listAccounts, getSchemaSignature, getDevToolsSnapshot, streamDevTools, listScores, listScoresForRuns, getScoreDetail, createBrowserSession, browserAct, browserContext, browserPick, closeBrowserSession, listBrowserSessions`.

### 4.4 Methods the product path relies on

The imported Flows Worker (`/Users/williamcory/flows/flows/apps/server/src/gateway.ts`) is the only product consumer. `DEFAULT_CLOUD_API_BASE_URL = "https://api.jjhub.tech"` (`:158`, override `SMITHERS_CLOUD_API_BASE_URL`, `:350`); provision-or-resume via `POST {cloud}/api/repos/{owner}/{repo}/gateway` (`:355`); tokens held in a Durable Object; browser talks to the Worker at `/api/workflow/{provision,rpc,events}` (`apps/ui/src/mainview/state/controller/context.ts`); `GATEWAY_UPSTREAM_TIMEOUT_MS = 20_000` (`:32`); one forced re-provision on 401 (`:381,607`).

`ALLOWED_GATEWAY_METHODS` (`:533-541`): `listWorkflows`, `launchRun`, `getRun`, `listApprovals`, `submitApproval`, `getNodeOutput`, `whatHappened`. `NON_REPLAYABLE_GATEWAY_METHODS = ["launchRun"]` (`:530`). The Worker calls `${base_url}/v1/rpc/<method>` and `/v1/api/stream` (`gateway.test.ts:410,799`).

Plue-side gating: `submitApproval` must auto-resume the parked run (the reason for the `>= 0.33` floor); `identity.version` from the handshake is what Plue gates on.

### 4.5 Assumptions in Plue's custom run UIs (`.smithers/ui`, dev dashboards, not product UI)

Hooks and arguments used: `createGatewayReactRoot(<App/>)`; `useGatewayRuns()` and `useGatewayRuns({filter:{limit}})`; `useGatewayRun(runId)`; `useGatewayRunTree(runId)` returning `tree.nodes[]` with `id, name, status, children`; `useGatewayRunEvents(runId, {afterSeq:0} | {maxEvents:500})` reading `event.type`; `useGatewayNodeOutput({runId, nodeId, iteration:0})` reading `output.data` (registered output rows keyed by node id including iteration ids such as `review:0`, `i<issue>:triage`, `impl:validate`, `fix-loop:gates`); `useGatewayActions()` (launch, cancel, approve); `useGatewayApprovals()` reading `approval.runId, nodeId, iteration`; `useGatewayTickets({})` reading `ticket.status, kind, priority`. Run DTO fields read: `run.runId` (16 reads), `run.status` (7), `run.data` (3), `run.workflowName` (2), `run.workflowKey` (`ddd-LiveTab.tsx:23`, `pipelines-shared.tsx:19`, `docs-driven-development.tsx:154`, `ticket-fleet.tsx:376`), `run.workflow` (`ddd-LiveTab.tsx:23`, `docs-driven-development.tsx:154`), `run.createdAtMs` (`ddd-LiveTab.tsx:31-32,223`); node fields `node.cardLabel` and `node.agent` (`ddd-LiveTab.tsx:143-144`); approval fields `approval.request` and `approval.requestTitle` (`ticket-fleet.tsx:335-336`) (ruling E8). URL contract: `?runId=` through `runIdFromUrl`. `byok-subscription-accounts-monitor.tsx` polls another run through `SmithersGatewayClient`.

### 4.6 Flows-side reality (what the RC gateway can bind to)

- `@smthrs/control` `ControlRpcs` (`packages/control/src/ControlRpcs.ts:103-177`): `Plan`, `Run`, `Approve`, `Deny`, `Steer`, `Signal`, `Cancel`, `Resume`, `List`, `Watch`; unary over `POST /rpc`, stream over WebSocket `/rpc/ws` (`ControlServer.ts:53,59`), NDJSON, single shared bearer token mapped to one `Principal` (`flows-cli-control.md` 5.1).
- DTOs (`flows-cli-control.md` 5.2): `RunStatus = accepted|running|parked|waiting-approval|cancelled|completed|failed`; `RunSummary {runId, flowId, status, planId?, planDigest?, ownerId?, createdAt, updatedAt}`; `ApprovalTarget = Plan{planId, digest, envelope} | Node{runId, requestId, digest, envelope}`; `ApprovalPayload {target, scope: once|run|remembered, idempotencyKey}`; `WatchFilter {runId?, afterSequence?, follow?}`; `ControlEvent {sequence, kind, runId?, occurredAt, payload}`; `ListRequest` for flows or runs with cursor and limit.
- `@smthrs/gateway` `GatewaySchema.ProjectionName` (`packages/gateway/src/GatewaySchema.ts:105-113`): `workspace-runs`, `run-summary`, `run-events`, `transcript`, `run-tree`, `plan-cards`, `approvals`, `node-output`. Contracts only: no server, no projection implementation, no health route, no SSE (`flows-cli-control.md` 5.1, 5.4).
- `@smthrs/sync` `Sync.Subscribe` streams `Entries | Heartbeat | Closed` frames with credit and cursors (`SyncProtocol.ts:181,199`); no HTTP or WebSocket mount exists for it at HEAD.
- Flows has no `listWorkflows`, `launchRun`, `getNodeOutput`, `whatHappened`, `/v1/rpc`, `connect.challenge`, or `/v1/api/stream`.

## 5. Workflow discovery, file-extension, and loader assumptions

| Consumer | Rule | Source |
| --- | --- | --- |
| Plue workflow sync (product) | A workflow definition is any file under `.smithers/workflows/` ending in `.tsx` or `.ts`; the name is the basename without the extension; stored in `workflow_definitions(name, path, config JSONB)`. | `internal/services/workflow_sync.go:351-364` |
| Plue static parser (Path D) | `bun run scripts/workflow-evaluator.ts <tmp>.tsx\|.ts`, 30 s timeout, bounded concurrency; the evaluator is a TypeScript AST pass over `scripts/lib/workflow-renderer.ts` (1,292 lines) that recognises `Workflow`, `Task`, `Parallel`, `Sequence` elements and emits `{on, jobs:{steps, needs, runs-on, if, secrets, cache}}`. No smithers package is imported at runtime. | `workflow_parser.go:14,17,85,140` |
| Plue Go runner (Path D execution) | `execute-step.ts` runs shell steps; `__tsx_task__:` steps go through `tsx-task-runtime.ts`, which writes a JSX-free `@smithers-ai/workflow` shim (`Workflow/Task/Sequence/Parallel/Branch/Ralph` return `{type, props}` nodes) into `node_modules/@smithers-ai/workflow` before executing. | `cmd/runner/workflow/tsx-task-runtime.ts:43`, `cmd/runner/factory.go:109-112` |
| Sandbox plane (Path B) | Default path `.smithers/workflows/workflow.tsx` (`:772`); the engine loads the file by path with `--root /workspace/repo`. | `workflow_sandbox_scheduler.go:772,998-1000,1035` |
| Agent VM (Path A) | Engine loads `agent-task.tsx` from `/opt/smithers/runner-workflow` with `--root <repo>`; `preload.ts` registers `mdxPlugin` before load. | `agent.ts:295`, `cmd/runner/workflow/preload.ts` |
| Gateway VM (Path C) | `smithers gateway` serves repo-local `.smithers/workflows` plus the global `~/.smithers` pack installed by `init --global`; repo-local files resolve bare `smithers-orchestrator` through the `node_modules` symlink. | `repo_gateway.go:1521,1611,1619` |
| Dev pack (Path E) | JSX through `jsxImportSource: smithers-orchestrator`; MDX prompts imported as components through `bunfig.toml` preload `mdxPlugin()`; custom UIs declared with `<UI ui="../ui/x.tsx">`; `batch-issues/` carries its own `smithers.ts`, `preload.ts`, `bunfig.toml`, `package.json`. | `.smithers/tsconfig.json:11-12`, `.smithers/bunfig.toml`, `.smithers/preload.ts` |
| Public docs | "Smithers workflows are TSX files … They use Smithers JSX components wrapped by the `@smithers-ai/workflow` package"; project layout lists `tsconfig.json # JSX + Smithers config`. | `apps/docs-smithers/guides/workflows.mdx:9,69`; also `getting-started/first-workflow.mdx`, `cli-reference/commands.mdx`, `apps/docs/src/content/docs/docs/workflows/{writing,triggers,overview,sandbox}.mdx`, `docs/specs/engineering.md` (reader section 7) |

Engine-executed flows move to `flows/**/flow.ts` (or `flow.mdx`), the rc.0 project convention (rc-contract §6, R-6); to the engine's 0.x detector, `.smithers/` is 0.x state. Plue's `workflow_sync.go:351-364` discovery rule is extended to `flows/` (rc-contract §10, Plue item). `.smithers/workflows/*.tsx` survives only for Plue's own CI DSL, which is Plue's decision (rc-contract R-19, section 14 D1).

## 6. CLI commands and environment variables

### 6.1 Engine CLI commands in execution position

| Command | Where | Runs where |
| --- | --- | --- |
| `smithers up agent-task.tsx --root <repo> --run-id <uuid> --max-concurrency 1` | `cmd/runner/workflow/agent.ts:295` | agent VM |
| `SMITHERS_YES=1 bun x --package smithers-orchestrator@0.28.0 smithers init --global --no-skill \|\| echo "smithers global pack install failed; continuing"` (the sandbox bootstrap line, verbatim; `set -euo pipefail` script, so the `\|\|` fallback keeps the VM alive) and `/usr/local/bin/bun x --package smthrs@0.33.0 smithers init --global --no-skill` after `export SMITHERS_YES=1` (the gateway pack-install exec, no fallback; `execGatewayCommand` fails provisioning on a non-zero status, `repo_gateway.go:1624-1649`), and `"/usr/local/bin/smithers" init --global --no-skill` after `export SMITHERS_YES=1` (the workspace VM `packInitScript`, run as the developer user through `runuser` or `su` with `\|\| echo "smithers workspace bootstrap: global smithers pack init failed; continuing"`; the binary is the Plue Go CLI staged from `SMITHERS_WORKSPACE_CLI_BINARY`, which registers no `init` verb, so the step fails today and the fallback hides it) | `workflow_sandbox_scheduler.go:1010` (pinned verbatim by `workflow_sandbox_scheduler_test.go:1165-1175`, which also requires the init to precede `bun run /opt/smithers/workflow-runner.tsx`); `repo_gateway.go:1597,1611` (pinned by `repo_gateway_seat_test.go:67-79`, which requires `smithers init --global` after the `agents.ts` heredoc, by `repo_gateway_test.go:384,1065`, and called directly by `repo_gateway_h_test.go:254`); `workspace_provisioning.go:83-85` and `workspace_scripts/bootstrap.sh.tmpl:39-46` (pinned by `workspace_provisioning_test.go:54,593` and `workspace_scripts/embed_test.go:29,71`; binary: `workspace_provisioning.go:113-118`, `workspace.go:98-101`, `cmd/server/Dockerfile:44,122`, `internal/smitherscli/run.go:56-87`) | sandbox VM, gateway VM, workspace VM. Ruling F1: rc.0 makes `init --global` exit 1 (rc-contract §4.2), so all three lines and their pinning tests are dropped at the cutover (rc-contract §10; checklist items 6, 7, and 18) |
| `smithers up <path> --root /workspace/repo --max-concurrency 1 --run-id <plue run id>` | `workflow_sandbox_scheduler.go:1035-1037` | sandbox VM |
| `smithers gateway --host 0.0.0.0 --port 7331 --backend sqlite` | `repo_gateway.go:1682-1683` | gateway VM |
| `smithers up .smithers/workflows/pipelines/ci-{fast,thorough}.tsx -d --input '{"sha":…}'` with `PATH=$PWD/.smithers/node_modules/.bin:$PATH` | `.github/workflows/pipeline-fast.yml:37`, `pipeline-thorough.yml` | GitHub Actions; receipts at `~/.cache/smithers-ops/receipts.jsonl` (`:41`) |
| `.smithers/node_modules/.bin/smithers up .smithers/workflows/fix-all-issues.tsx -d --max-concurrency 32` | root `package.json:7` (`smithers:fix-all`) | maintainer machine |
| `smithers ps --format json --backend pglite\|sqlite`, `smithers inspect <run> --format json`, `smithers up …` | `scripts/issue-closure-controller.ts:30-31,436,843-844,1001` (`SMITHERS_BACKEND = "pglite"`), `scripts/workflow-health-monitor.ts:3-6,316,983` (Bun cron, `*/10 * * * *`) | maintainer machine via `package.json:8-17` |
| `smithers inspect\|events\|output … --json`, `smithers eval <tsx> --cases … --suite …` | `.smithers/evals/alpha-plue/{capture-run.ts:6,README.md:18-80}` | maintainer |
| `smithers workflow list\|run\|implement` | `.smithers/package.json` scripts | maintainer |
| `smithers` (generated workflow) through `SMITHERS_CLI` or PATH | `bench/src/smithers-arm.ts`, `bench/worfbench/smithers-shim.ts` | bench |
| `bun scripts/smithers.tsx --team JJH …` (`LinearWebhookListener` + `runWorkflow`) | `scripts/smithers.tsx` | ad hoc; no package script, no CI reference |

Scripts that only look related: `.smithers/workflows/canary-runner.ts` (2,883 lines) and `remediate-runner.ts` (1,543 lines) are plain Bun programs. `SMITHERS_BIN` names the Plue product CLI (`bin/smithers`) at `canary-runner.ts:1766` and `ci.tsx:152`; `remediate-runner.ts` never references it (`git grep -n SMITHERS_BIN 8e03dbe5d2 -- .smithers/workflows` returns exactly those two lines).

### 6.2 Environment variables

| Variable | Set by | Read by |
| --- | --- | --- |
| `SMITHERS_AGENT_SESSION_ID`, `SMITHERS_AGENT_TOKEN`, `SMITHERS_API_BASE_URL`, `SMITHERS_AGENT_PROVIDER`, `SMITHERS_AGENT_TRANSPORT`, `SMITHERS_REPOSITORY_PATH`, `SMITHERS_WORKFLOW_RUN_ID`, `SMITHERS_TASK_PAYLOAD`, `SMITHERS_DEBUG=1`, `SMITHERS_JJHUB_TOKEN`, `SMITHERS_JJHUB_API_URL`, `HOME=/root`, `PATH=/usr/local/bin:/root/.bun/bin:/usr/bin:/bin` | `internal/services/agent_dispatch.go:494-546` (plus repository secrets through `injectSecrets`, `secret_injection.go`; reserved keys re-applied after injection, `:519-529`) | `agent.ts`, `agent-task.tsx:262,644`, `agent-tools.ts` |
| `SMITHERS_TASK_ID` | runner plane | `cmd/runner/workflow/smithers.ts` (selects the per-task SQLite path) |
| `SMITHERS_WORKFLOW_PATH`, `SMITHERS_WORKFLOW_ROOT`, `SMITHERS_WORKFLOW_RUN_ID`, `HOME`, `SMITHERS_YES=1`, repository secrets | `workflow_sandbox_scheduler.go:998-1010` | `/opt/smithers/workflow-runner.tsx` (`:1029-1037`) |
| `SMITHERS_ORCHESTRATOR_CLI` | operator | `workflow_sandbox_scheduler.go:1039` (working-tree CLI override) |
| `SMITHERS_API_KEY`, `HOME`, `PATH`, `TMPDIR=/workspace/.tmp`, `XDG_CACHE_HOME=/workspace/.cache`, `SMITHERS_YES=1`, `CEREBRAS_API_KEY`, `SMITHERS_GATEWAY_AGENT_{ANTHROPIC,OPENAI,OPENROUTER,CEREBRAS}_API_KEY` (Plue config keys mapped to provider env) | `repo_gateway.go:1590-1700` | old `smithers gateway` (`gateway-runtime.js:703`) |
| `SMITHERS_CLOUD_API_BASE_URL`, `GATEWAY_UPSTREAM_URL` | Worker env | Flows `apps/server/src/gateway.ts:350` |
| `SMITHERS_REPO_TOKEN` (secret), `PATH` prepend | `pipeline-fast.yml:19,37` | GitHub Actions checkout of `smithersai/smithers` |
| `SMITHERS_CLI`, `SMITHERS_BIN`, `SMITHERS_BACKEND` (constant) | bench, canary runner, controllers | see 6.1 |

Ruling F4 (closes E1): rc-contract §4 carries the per-variable disposition for every name in this table (rc.0 consumer module, Plue-retained, removed, replacement). In short: `SMITHERS_API_KEY` and the provider keys behind `SMITHERS_GATEWAY_AGENT_*` stay; `SMITHERS_YES`, the `SMITHERS_BACKEND=pglite` setting, `SMITHERS_CLI`, and `SMITHERS_REPO_TOKEN` go with the sites that set them; the Path A, B, and D names are read by Plue's own code only and never reach the engine. rc.0 does not read `SMITHERS_TOKEN`, which Plue's product CLI owns.

### 6.3 Images, bake-time assertions, and build steps

- `cmd/agent-vm/Dockerfile:125` runs `bun install --frozen-lockfile` in `/app/cmd/runner/workflow`; `:131` copies `packages/workflow`; `:135-138` symlinks `/opt/smithers/runner-workflow` and asserts `node_modules/smithers-orchestrator` exists.
- `cmd/agent-snapshot/main.go:53-54` asserts `/opt/smithers/runner-workflow/agent.ts` and `node_modules/smithers-orchestrator` survived the snapshot.
- `cmd/runner/Dockerfile:201,204,211` installs the same tree for the GKE gVisor runner; `cmd/runner/factory.go:109-112` executes scripts with `bun run` or `node node_modules/tsx/dist/cli.mjs` for workspace PTY tasks.
- `build.zig:81-82` defines the `workflow-install` step (`bun install --frozen-lockfile` in `cmd/runner/workflow`); e2e depends on it.
- `.github/workflows/canary.yml:114` installs `cmd/runner/workflow`; `:123` builds `bin/smithers` from `./cmd/smithers` (the Plue product CLI); `:139` exports it as `CANARY_CLI_BIN`.

### 6.4 Binary-name collision

Plue's product CLI is Go (`cmd/smithers`, `internal/smitherscli`), packaged as npm `@smithers/cli` with bins `smithers` and `plue` today (`packages/npm-cli/package.json:6-9`, both pointing at `bin/plue.js`). Ruling P3 applies: the engine CLI owns `smithers`; Plue's package keeps the `plue` bin only, `canary.yml` builds `bin/plue`, and checklist item 15 in section 13 gates it. Plue keeps invoking the engine by package (`bun x --package @smthrs/cli@1.0.0-rc.0 smithers`) or `SMITHERS_ORCHESTRATOR_CLI`.

### 6.5 Agent skills (`.agents/skills`)

Plue tracks 65 skill directories under `.agents/skills` at `8e03dbe5d2`: 63 `smithers-*/SKILL.md` files, `byok-subscription-accounts.md` (section 10, rank 19), and `microsandbox/` (Plue's own provider skill). The 63 `smithers-*` files are the 0.x `smithers skills add` generated command skills (old `apps/cli/src/index.js:12878-12896`; the same 63 files are tracked in the old tree at `cfb570f193` with identical frontmatter), installed by Plue commit `7b3aa2640` (2026-07-11, "install smithers skill pack across agent harnesses") and unchanged since; nothing outside the directory references them (`git grep -n 'agents/skills' 8e03dbe5d2 -- . ':!.agents'` finds only the checked-in binary). Every file's frontmatter is `requires_bin: smithers` plus `command: smithers <verb>` (`git show 8e03dbe5d2:.agents/skills/smithers-<verb>/SKILL.md`, lines 1-6), and the body documents that verb's 0.x arguments, flags, and output.

Classification against the rc-contract verb tables:

| Group | Count | Verbs (`.agents/skills/smithers-<verb>/SKILL.md`) |
| --- | --- | --- |
| Verb removed or unsupported at rc.0 (rc-contract §4.2) | 43 | `agents`, `alerts`, `ask`, `ask-human`, `chat`, `chat-create`, `cron`, `diff`, `docs-full`, `eval`, `fork`, `graph`, `gui`, `hermes`, `hijack`, `human`, `make-workflow`, `monitor`, `node`, `observability`, `openapi`, `optimize`, `pause`, `replay`, `restore`, `retry-task`, `revert`, `review`, `rewind`, `scores`, `snapshot-hook`, `snapshots`, `starters`, `supervise`, `timeline`, `timetravel`, `token`, `tree`, `ui`, `upgrade`, `usage`, `what`, `workflow` (only `workflow list` survives as an alias) |
| Verb survives at rc.0 (rc-contract §4.1) but the skill documents 0.x flags or output | 20 | `approve`, `bug`, `cancel`, `claude`, `deny`, `docs`, `down`, `events`, `gateway` (alias of `serve`; `gateway status\|stop` removed), `init` (`--global` removed), `inspect`, `logs`, `memory`, `migrate` (`--to` removed), `output`, `ps` (`--format json`, `--backend`), `signal`, `up` (`--max-concurrency`, `--serve`, `--interactive`, `--force` removed), `update`, `why` |

Example: `smithers-ask-human/SKILL.md:3-5` scripts `command: smithers ask-human`, which rc-contract §4.2 makes unsupported (approvals park the run; the MCP `ask_human` tool returns the `unsupported` envelope).

Disposition (ruling F2): delete all 63 `smithers-*` directories at the cutover; keep `byok-subscription-accounts.md` (it follows rank 19, a Phase 6 fixture) and `microsandbox/`. rc.0 `smithers skills add` (rc-contract §4.1) writes the single curated `smithers` skill into the detected agents' skill directories and generates no per-verb skills, so nothing regenerates the set; a per-verb skill set for rc.0 is not an rc.0 deliverable (the Phase 6 scanner may emit one from the rc-contract §4.1 catalog in a later candidate). Checklist item 16 in section 13 gates the deletion; section 14 records it.

## 7. Persisted run and event fields displayed by the UI

### 7.1 Plue-owned Postgres (`db/schema.sql`), no engine tables

| Table | Fields the UI and CLI display |
| --- | --- |
| `workflow_definitions` | `name`, `path`, `config JSONB`, `is_active` |
| `workflow_runs` (`:1574`) | `status IN (queued, running, success, failure, cancelled)`, `trigger_event`, `trigger_ref`, `trigger_commit_sha`, `dispatch_inputs JSONB`, `agent_token_hash`, `agent_token_expires_at`, `jjhub_token_id`, `check_run_id`, `check_run_url`, `started_at`, `completed_at`, `execution_plane IN (runner, sandbox, agent)`, `log_bytes`, `log_entry_count` |
| `workflow_steps` (`:1790`) | `name`, `position`, `status` (includes `skipped`) |
| `workflow_tasks` (`:1847`) | `status IN (pending, assigned, running, done, failed, cancelled, blocked, skipped)`, `priority 0-3`, `payload JSONB`, `attempt`, `runner_id`, `vm_id`, `last_error` |
| `workflow_run_logs` (`:1975`) | `sequence`, `stream IN (stdout, stderr, system)`, `entry`; `NotifyWorkflowRunLog` fan-out |
| `workflow_caches`, `workflow_artifacts`, `workflow_triggers`, `workflow_schedule_specs`, `workflow_sandbox_claims` | cache and artifact handles, trigger specs, sandbox claims |
| `agent_sessions` (`:2221`) | `status IN (active, completed, failed, cancelled, timed_out)`, `workflow_run_id`; `agent_messages`, `agent_parts` |
| `approvals` (`:4426`) | `state IN (pending, approved, rejected, expired)`, `kind`, `title`, `payload JSONB` |
| `repo_gateways` (`:4567`) | `vm_id`, `base_url`, `auth_token_hash`, `auth_token_ciphertext`, `status IN (pending, starting, running, suspended, stopped, failed)`, `last_activity_at` |

The sandbox and agent planes map engine exit status to `workflow_runs.status` and capture `journalctl` output into `workflow_run_logs`; no engine row is read by SQL.

### 7.2 Engine-persisted data Plue reads

| Source | Consumer | Fields |
| --- | --- | --- |
| `.smithers/executions/<runId>/logs/stream.ndjson` (Path A) | `agent.ts:99-106` `followRunEventStream`, `agent_event_mapper.ts` | Event names `RunStarted`, `RunFinished`, `RunFailed {error}`, `RunCancelled`, `NodeStarted`, `NodeFinished`, `NodeFailed`, `NodeOutput {text\|output, stream}`, `ToolCallStarted`, `ToolCallFinished {toolName, inputJson, outputJson, errorJson, status}`; mapped to `POST /internal/agent/sessions/{id}/events` with `event_type` `text`, `tool_call`, `tool_result`, `done`. The old engine emits `NodeOutput` only for CLI agents, so `agent-task.tsx:163-170,211-215` posts SDK replies through `onReply` before the task settles. |
| `smithers ps --format json` `{runs:[{id, status, backend, …}]}`, `smithers inspect --format json` | `scripts/issue-closure-controller.ts:1001`, `scripts/workflow-health-monitor.ts:316` | run id, status, backend |
| Gateway `getRun` (status, node summary, `identity.version`), `getNodeOutput` rows, `listApprovals` rows, `run.event` frames | Flows Worker and UI; Plue custom UIs (section 4.5) | `run.runId`, `run.status`, `run.workflowName`, `run.workflowKey`, `run.workflow`, `run.createdAtMs`, `run.data`; `node.id`, `node.name`, `node.status`, `node.children`, `node.cardLabel`, `node.agent`; `approval.runId`, `approval.nodeId`, `approval.iteration`, `approval.request`, `approval.requestTitle`; `output.data`; `event.type` (ruling E8) |
| `.smithers/evals/alpha-plue/traces/*.json` (18 tracked eval files) | eval suite | captured `inspect` and `events` output |

### 7.3 Local 0.x state on disk (untracked or ignored)

`smithers.db` (624 MB, 2026-08-19) plus WAL at the Plue root, `.smithers/smithers.db*`, `.smithers/backups/smithers-pre-0.28-*.db`, `.smithers/executions/` (about 70 run directories), `.smithers/logs/`, 42 `.smithers/workflows/run-*.log` transcripts (up to 8.7 MB each), `cmd/runner/workflow/.smithers/executions/*`, `.smithers/runs/*-reports`, `.smithers/workflows/.smithers`, `.smithers/workflows/.worktrees`. Ruling P4 applies.

## 8. Hosted API and authentication contracts shared with Plue

| Contract | Shape | Consumers |
| --- | --- | --- |
| Gateway relay | `POST /api/repos/{owner}/{repo}/gateway` (session or PAT) returns `gateway_id`, `token` (`smithers_gateway_…`), `base_url`, `expires_at` (1 h advertised), `Cache-Control: no-store`; `ANY /api/gateways/{gatewayID}/*` with `Authorization: Bearer <gateway token>` for HTTP RPC, SSE, and WebSocket upgrade. The Worker holds tokens server-side. | Flows `apps/server` and `apps/ui`; `WAVE4-RELAY-RECEIPT.md` 5, `WAVE12B-GATEWAY-AGENTS-RECEIPT.md`, `WAVE14B-RECEIPT.md` (`POST /api/workflow/rpc getRun` via session cookie) |
| Sandbox plane | `POST /api/repos/{owner}/{repo}/invoke {flow, input, trigger}` returns `{id, run_id, workflow_definition_id, flow, path, status:"queued"}` (`internal/routes/workflow_invoke.go:14-44`); `/api/repos/{o}/{r}/workflows`, `/workflows/{id}/dispatches`, `/runs/*` | Plue CLI `internal/smitherscli/commands_issue_wiki_workflow.go`, cron and webhook workers (`cmd/server/main.go:700-708`) |
| Agent callbacks from VMs | `POST {SMITHERS_API_BASE_URL}/internal/agent/sessions/{id}/events` with `Authorization: Bearer <SMITHERS_AGENT_TOKEN>`; artifact, cache, and tool endpoints used by `agent-tools.ts` and `execute-step.ts` (`workflow_artifacts.go`, `workflow_cache.go`, `agent_internal.go`) | agent VM, runner |
| Token shapes | Plue PATs `smithers_…` sent as `Authorization: token …`; gateway tokens `smithers_gateway_…` as Bearer; SIWE, GitHub, and Auth0 sessions for the UI. The engine sees only the gateway token, passed as `SMITHERS_API_KEY`. | all |

None of these contracts change in the cutover except the upstream path and payload shapes behind the relay (section 11).

## 9. Production workflows that depend on deferred features

Deferred by PLAN defaults: hijack, attributed pause, continue-as-new, checkpoints and worktree lanes, Postgres and PGlite, provider quota park and wake, cross-process wake, tickets and cron RPCs, old eval and UI-adjacent engine features.

Grep over `.smithers/**`, `scripts/*`, `cmd/runner/workflow/*`, `bench/**`:

| Deferred feature | Files that use it | Production role |
| --- | --- | --- |
| `<Worktree` lanes | `alpha-plue.tsx` (27 elements), `fix-all-issues.tsx` (9), `ticket-fleet.tsx` (8), `byok-subscription-accounts.tsx` (5), `issue-pipeline.tsx` (3), `ticket-kanban.tsx` (3), `batch-issues/components/IssuePipeline.tsx` (3), `scripts/smithers.tsx` (3) | none; all Tier 2 dev automation |
| `openSmithersBackend` (direct old-database access) | `alpha-plue.tsx`, `fix-all-issues.tsx` | none |
| `fallbackAgents` seat pools | `alpha-plue.tsx` | none |
| `pglite` backend | `scripts/issue-closure-controller.ts` (`SMITHERS_BACKEND = "pglite"`, legacy `sqlite`) and its test | maintainer cron only |
| Tickets and cron RPCs | `ui/docs-driven-development.tsx` (`useGatewayTickets`), `ticket-fleet-monitor.tsx` (`smithers-source: cron`, `Timer`) | none |
| Custom React run UIs (`gateway-react`, `gateway-ui`, `ui`) | 19 files under `.smithers/ui`, declared by `<UI>` in 9 workflows | none; dev dashboards |
| MDX prompts as components (`mdxPlugin`) | `.smithers/preload.ts`, `cmd/runner/workflow/preload.ts`, `batch-issues/preload.ts`; 35 + 8 `.mdx` prompts | Path A preload only; the prompts are read as text after the port |
| `TryCatchFinally` | `alpha-plue.tsx`, `fix-all-issues.tsx` | none |
| `<Timer>` | `byok-subscription-accounts-monitor.tsx` | none |
| `SmithersGatewayClient` inside a workflow | `byok-subscription-accounts-monitor.tsx` | none |
| `actions.rewindRun` (time travel is library-only at rc.0: no CLI verb, no MCP tool, no gateway RPC; rc-contract §5.1) | `.smithers/ui/implement.tsx:288`, `.smithers/ui/research-plan-implement.tsx:285` (`actions.rewindRun({ runId, frameNo: 0, confirm: true })`) | none; dev dashboards. Disposition (ruling E7): both UIs are deleted with the custom run UIs (section 14); `rewindRun` appears in the generic 35-method `useGatewayActions` catalog only and gets no rc.0 binding |
| `smithers eval` (removed verb, rc-contract §4.2) | `.smithers/workflows/alpha-plue.tsx:193` (an agent instruction to author "a Smithers eval suite (runnable via `smithers eval`)" under `.smithers/evals/alpha-plue/`) | none; tier 2. Disposition (ruling E7): `alpha-plue.tsx` is a Phase 6 fixture (R-21); the migration report flags the instruction as unsupported text (`smithers eval` is a hidden unsupported verb) and `.smithers/evals/alpha-plue` is deleted with the pack |

Zero hits anywhere in Plue for checkpoints or `restore`, `hijack` (one prose hit in `lib/ddd/generateSpecDocs.ts`), `continueAsNew`, engine `<Sandbox>`, `<Signal>` or `submitSignal`, `<Subflow>` or `resumeFromRunId`. Gateway VMs, sandbox VMs, and agent tasks use SQLite.

Conclusion: no Tier 0 or Tier 1 workflow depends on a deferred feature. The PLAN defaults for checkpoints, worktree lanes, Postgres, PGlite, hijack, and attributed pause stand for the Plue cutover.

## 10. Ranked workflow inventory (47 top-level files in `.smithers/workflows`)

Columns: lines, last commit, commit count, `smithers-source` header, engine features, external referrers (outside `.smithers/workflows`), RC disposition. Tier 0 files are never executed by the engine: they are rendered by Plue's static parser and executed by Plue's Go runner, or they are plain Bun programs.

| Rank | File | Lines | Last | Commits | Header | Engine features | External referrers | Disposition |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Tier 0, production runtime | | | | | | | | |
| 1 | `canary.tsx` | 63 | 2026-08-19 | 6 | none | `@smithers-ai/workflow` only | `internal/routes/canary_metrics.go:14` (`CanaryWorkflowPath`), `.github/workflows/canary.yml`, `docs/runbooks/canary-failure.md`, `scripts/prod-canary-schedule.test.ts` | keep (Path D) |
| 2 | `canary-runner.ts` | 2,883 | 2026-08-19 | 13 | n/a | none (plain Bun) | `infra/helm/smithers/templates/canary-cronjob.yaml`, `values.yaml`, `e2e/Dockerfile.canary`, `.dockerignore` | keep |
| 3 | `canary-runner.test.ts` | 474 | 2026-08-19 | 8 | n/a | none | tests rank 2 | keep |
| 4 | `remediate.tsx` | 44 | 2026-07-18 | 4 | none | `@smithers-ai/workflow` only | `cmd/server/main.go:714`, `internal/services/alertregistry/registry.go:4`, `docs/runbooks/registry.json`, `infra/terraform/environments/prod/variables.tf` | keep (Path D) |
| 5 | `remediate-runner.ts` | 1,543 | 2026-07-18 | 5 | n/a | none (plain Bun) | `e2e/api/gvisor-runner-contract.test.ts:201,230` | keep |
| 6 | `ci.tsx` | 167 | 2026-07-02 | 2 | none | `@smithers-ai/workflow` (4 `on.*`) | `workflow_sandbox_scheduler_test.go`, `workflow_sync_test.go`, `workflow_parser_test.go` (42 references across ci, build, deploy), `docs/specs/engineering.md`, `apps/cli/tests/cli-workflow.test.ts`, `execute-step.e2e.test.ts` | keep (Path D) |
| 7 | `build.tsx` | 133 | 2026-07-02 | 2 | none | `@smithers-ai/workflow` | `workflow_sync_test.go`, `workflow_parser_test.go` | keep (Path D) |
| 8 | `deploy.tsx` | 205 | 2026-06-06 | 1 | none | `@smithers-ai/workflow` | `workflow_sync_test.go`, docs | keep (Path D) |
| 9 | `release.tsx` | 47 | 2026-06-06 | 1 | none | `@smithers-ai/workflow` | `docs/specs/engineering.md` release chain | keep (Path D) |
| 10 | `terraform.tsx` | 56 | 2026-06-06 | 1 | none | `@smithers-ai/workflow` (1 `Branch`) | release chain | keep (Path D) |
| 11 | `update-homebrew.tsx` | 82 | 2026-07-11 | 1 | none | `@smithers-ai/workflow` | release chain | keep (Path D) |
| Tier 2, maintainer dev automation (engine-heavy, no Go, Helm, or CI referrer) | | | | | | | | |
| 12 | `fix-all-issues.tsx` | 2,436 | 2026-07-12 | 5 | authored | Worktree 9, Loop, Parallel 3, Sequence 7, TryCatchFinally 4, `openSmithersBackend`, UI, 73 output reads | root `package.json:7` (`smithers:fix-all`), `scripts/workflow-health-monitor.ts`, `scripts/issue-closure-controller.ts`, `scripts/fix-all-issues-workflow.test.ts` | Phase 6 fixture (R-21) |
| 13 | `fix-all-issues.test.ts` | 68 | 2026-07-12 | 1 | n/a | tests rank 12 | | follows rank 12 |
| 14 | `alpha-plue.tsx` | 1,361 | 2026-08-17 | 1 | authored | Worktree 27, Approval, Loop 3, Parallel 3, Sequence 6, TryCatchFinally 2, `fallbackAgents` 8, `openSmithersBackend`, UI, 44 output reads | `.smithers/ui/alpha-plue.tsx`, `.smithers/evals/alpha-plue/*`, `PROMPT.md` | Phase 6 fixture (R-21) |
| 15 | `alpha-plue.test.ts` | 228 | 2026-08-17 | 1 | n/a | `renderWorkflow` from `…/testing` | | follows rank 14 |
| 16 | `ticket-fleet.tsx` | 1,832 | 2026-07-18 | 2 | two | Worktree 8, Approval 8, Loop, Parallel 9, Sequence 11, UI 4, 96 output reads | `.smithers/ui/ticket-fleet.tsx` | Phase 6 fixture (R-21) |
| 17 | `ticket-fleet-monitor.tsx` | 145 | 2026-07-10 | 1 | cron | Sequence, `Timer`, cron source | | Phase 6 fixture (R-21) |
| 18 | `triage-review-findings.tsx` | 468 | 2026-07-18 | 2 | authored | Loop, Branch, Parallel 2, Sequence 4 | | Phase 6 fixture (R-21) |
| 19 | `byok-subscription-accounts.tsx` | 345 | 2026-07-11 | 3 | hardened | Worktree 5, Loop 3, Parallel 2, Sequence 3, 11 MDX prompt imports, UI 4, 78 output reads | `.agents/skills/byok-subscription-accounts.md`, 2 UIs, 18 MDX prompts | Phase 6 fixture (R-21) |
| 20 | `byok-subscription-accounts-monitor.tsx` | 70 | 2026-07-11 | 3 | hardened | `SmithersGatewayClient`, Sequence 3, UI 2 | | Phase 6 fixture (R-21) |
| 21 | `byok-subscription-accounts.test.ts` | 334 | 2026-07-11 | 4 | n/a | `renderWorkflow`, `simulate` | | follows rank 19 |
| 22 | `docs-driven-development.tsx` | 700 | 2026-07-07 | 2 | none | Approval, Loop, Sequence, UI 3, 23 output reads | `.smithers/lib/ddd/*` (8 files), `.smithers/ui/ddd-*` (12 files, 5 generated by `lib/ddd/generateUiModules.ts`) | Phase 6 fixture (R-21) |
| 23 | `ddd-bug-scan.tsx` | 410 | 2026-07-07 | 2 | none | Sequence, outputs | ddd lib and UIs | Phase 6 fixture (R-21) |
| 24 | `ddd-generate-docs.tsx` | 379 | 2026-07-06 | 2 | none | Sequence, outputs | ddd lib and UIs | Phase 6 fixture (R-21) |
| 25 | `ddd-improve.tsx` | 188 | 2026-07-06 | 1 | none | Loop, Sequence, UI | ddd lib and UIs | Phase 6 fixture (R-21) |
| 26 | `docs-concision.tsx` | 257 | 2026-07-11 | 1 | none | Approval 4, Loop, Parallel, Sequence 2, UI 2 | `.smithers/ui/docs-concision.tsx` | Phase 6 fixture (R-21) |
| 27 | `create-workflow.tsx` | 449 | 2026-07-11 | 1 | seeded | Approval, Loop, Branch 2, Sequence 2, 6 MDX prompts, UI 2 | `create-workflow-*.mdx` | Phase 6 fixture (R-21) |
| 28 | `issue-pipeline.tsx` | 548 | 2026-06-06 | 1 | none | Worktree 3, Ralph, Parallel, Sequence 2, `@smithers-ai/workflow` `on.*` | `poc/issue-trigger` | Phase 6 fixture (R-21) |
| 29 | `ticket-kanban.tsx` | 234 | 2026-06-06 | 1 | none | Worktree 3, Parallel, Sequence 2 | | Phase 6 fixture (R-21) |
| 30 | `research-plan-implement.tsx` | 104 | 2026-07-11 | 2 | seeded | Sequence, MDX, UI 2 | `.smithers/ui/research-plan-implement.tsx` | Phase 6 fixture (R-21) |
| 31 | `pair-poc.tsx` | 90 | 2026-07-02 | 2 | seeded | seeded pattern | `poc/pair` | Phase 6 fixture (R-21) at the survey revision; deleted from Plue at `2db1ecff2` |
| 32 | `create-ui.tsx` | 62 | 2026-07-10 | 1 | one | seeded pattern | | Phase 6 fixture (R-21) |
| Tier 3, seeded stock copies (1 commit, 2026-06-06, zero external referrers) | | | | | | | | |
| 33 | `write-a-prd.tsx` | 72 | 2026-06-06 | 1 | seeded | MDX prompt | | delete; regenerated by the RC pack initializer |
| 34 | `implement.tsx` | 58 | 2026-06-06 | 1 | seeded | Sequence, MDX | bench references it as the pattern (`bench/src/smithers-arm.ts:27`) | delete |
| 35 | `ticket-implement.tsx` | 56 | 2026-06-06 | 1 | seeded | MDX | | delete |
| 36 | `audit.tsx` | 38 | 2026-06-06 | 1 | seeded | MDX | | delete |
| 37 | `feature-enum.tsx` | 32 | 2026-06-06 | 1 | seeded | MDX | | delete |
| 38 | `tickets-create.tsx` | 32 | 2026-06-06 | 1 | seeded | MDX | | delete |
| 39 | `debug.tsx` | 31 | 2026-06-06 | 1 | seeded | MDX | | delete |
| 40 | `improve-test-coverage.tsx` | 31 | 2026-06-06 | 1 | seeded | MDX | | delete |
| 41 | `test-first.tsx` | 31 | 2026-06-06 | 1 | seeded | MDX | | delete |
| 42 | `ticket-create.tsx` | 30 | 2026-06-06 | 1 | seeded | MDX | | delete |
| 43 | `grill-me.tsx` | 29 | 2026-06-06 | 1 | seeded | MDX | | delete |
| 44 | `plan.tsx` | 29 | 2026-06-06 | 1 | seeded | MDX | | delete |
| 45 | `ralph.tsx` | 29 | 2026-06-06 | 1 | seeded | Loop, MDX | | delete |
| 46 | `research.tsx` | 29 | 2026-06-06 | 1 | seeded | MDX | | delete |
| 47 | `review.tsx` | 26 | 2026-06-06 | 1 | seeded | MDX | | delete |

Subdirectories outside the 47 count but inside the 57 `.tsx` total:

| Files | Tier | Notes | Disposition |
| --- | --- | --- | --- |
| `pipelines/ci-fast.tsx` (45), `pipelines/ci-thorough.tsx` (47), `pipelines/lib.ts` | Tier 1, CI through the engine CLI | Run by `pipeline-fast.yml` and `pipeline-thorough.yml`; compute-only `<Task>`s wrapping `spawn`, `Sequence`, `UI` (`.smithers/ui/pipelines-*.tsx`), `--input {"sha"}`, receipts via `scripts/ci-receipt.ts`. No deferred features. | migrate: re-author as `.ts` flows before the cutover; CI must keep running |
| `batch-issues/**` (45 tracked files incl. 14 `.tsx` and 16 `.ts`; last commit `c3588a371` 2026-07-15) | Tier 2 | Own `smithers.ts` with `dbPath`, `preload.ts`, `bunfig.toml`, `package.json` (`"smithers": "file:../../../../smithers"`, the old monorepo root), `pnpm-lock.yaml`, `run.sh`; imports the bare `smithers` specifier (13 statements in 10 files); Worktree, Ralph, Branch, `GeminiAgent` | Ruling E6: delete as dead (the `file:` dependency points at the old repository root and `GeminiAgent` has thrown `GEMINI_SUNSET_MESSAGE` since 0.28) unless the maintainer objects; preserved at the Plue tag as an extra migration-tool fixture (a project that depends on the old repository by `file:` path) |

Other JSX consumers outside `.smithers/workflows`: `scripts/smithers.tsx` (1,066 lines; Worktree 3, Ralph, Branch, Parallel, Sequence 2, Linear listener; ad hoc), `cmd/runner/workflow/agent-task.tsx` (763; Path A), `bench/src/smithers-arm.ts` (179; generated JSX), `poc/smithers-ship/workflows/*.tsx` (5), `.smithers/components/*` (10 files, 927 lines, seeded).

## 11. Minimum new gateway and UI projection

The product path (C) needs the following from the RC gateway. Each row maps the consumed old method to the imported contract and states whether Flows HEAD provides it.

| Consumed today | RC binding | Flows HEAD status |
| --- | --- | --- |
| Headless launch: `smithers gateway --host 0.0.0.0 --port 7331 --backend sqlite`, token from `SMITHERS_API_KEY`, restart-safe, no model credential at boot, `bun x`-installable package with a stable bin | One CLI verb that serves `ControlServer` (`/rpc`, `/rpc/ws`) plus the projection and sync mounts on a bindable host and port, `--listen` for non-loopback, bearer token from env or flag, SQLite state under the workspace | Missing. `flows` has no verb that starts a server; `NodeControl.layerServerBearerAuth` is a library call (`flows-cli-control.md` 2, "up, serve, gateway" row). |
| `GET /health` | `GatewaySchema.GatewayHealth` served on a plain HTTP route | Schema only; no route (`flows-cli-control.md` 5.1). |
| `connect` handshake returning `identity.version`, scopes | `SingletonRecord {gatewayId, workspaceHash, hostId, pid, url, protocolVersion}` or `GatewayStatus` returned by a first RPC; `ControlAuth` bearer middleware maps the token to one `Principal` | Schemas exist; no handshake route. |
| `listWorkflows` (ids, paths, display names; repo-local plus global pack) | `Control.List {_tag:"flows"}` returning `{items:[{flowId, description}], nextCursor?}`; the gateway host registers the `flows/**/flow.{ts,mdx}` descriptors that `@smthrs/registry` discovers in the workspace plus the system catalog; there is no global pack | Present for registered flows; discovery of repo-local flow files is host work. |
| `launchRun` (workflow id plus JSON input, returns runId; non-replayable) | `Control.Plan {flowId, input}` then `Control.Run {_tag:"Plan", planId, digest, envelope, idempotencyKey}`; `Receipt.Accepted {runId}`. The Worker either performs both calls or the gateway exposes a composed `launch` that does. | Present (two calls). |
| `getRun` (status vocabulary, node summary, `identity.version`) | `Control.List {_tag:"runs", filters:{runId}}` returning `RunSummary`; node summary from the `run-summary` and `run-tree` projections | `RunSummary` present; projections declared, unserved. |
| `listApprovals` | `approvals` projection, or fold of `control.approval.requested` events from `Control.Watch` | Declared, unserved; events present. |
| `submitApproval {runId, nodeId, iteration, approved, note}` with auto-resume | `Control.Approve` or `Control.Deny {target: Node{runId, requestId, digest, envelope}, scope, idempotencyKey}`; resolves the parked agent session once (auto-resume equivalent) | Present (blocker B-15 closed): `ControlLive.decide` resolves the token, installs the grant, and RECORDS the restart durably; the executor hosting the run takes that record up and clears it, so no `Resume` call follows an `Approve`. A decision taken in a process that does not host the run — the Worker, a gateway, a second CLI — is honoured by the host's own poll, once a second. `RunSummary.pendingResume` projects a restart recorded and not yet taken up, and `RunSummary.parkedBy` names the fence of the host whose take-up is owed. Payload shape changes (`gateway-and-ui.md` 8.5). |
| `getNodeOutput {runId, nodeId, iteration}` | `node-output` projection, or `control.agent.cell-produced` payloads from `Watch` | Declared, unserved; events present. |
| `whatHappened` | `Forensics.renderDiagnosis` over the run's `Watch` history, exposed as a projection or computed in the Worker | Present in the CLI only (`flows status <run-id>`). |
| `cancelRun` | `Control.Cancel {runId, idempotencyKey}` | Present in-process only: cancellation is owner-process only (`flows-cli-control.md` 4; `SqlControlRuntime.interrupt` returns `ClaimLost` for a run owned elsewhere), and rc-contract §10 requires cancel to be durable and cross-process; that is blocker B-10 (W-05) in `phase5-gap-triage.md`. |
| `streamRunEvents` and `/v1/api/stream?afterSeq` with 1 Hz heartbeats | `Control.Watch {runId, afterSequence, follow}` over `/rpc/ws`, or `Sync.Subscribe` with cursors and `Heartbeat` frames, proxied through the relay with header auth; keepalive interval well under the relay's 600 s idle cut | `Watch` present without heartbeats; `Sync.Subscribe` has heartbeats but no mount. Ruled (rc-contract R-8, §10): `smithers serve` mounts `Watch` over `/rpc/ws` and the projections over `/projections/ws`, both with heartbeat frames at an interval below the relay's 600 s idle cut. |
| Pack init `init --global --no-skill`, idempotent, non-interactive, tolerant of a missing credential; repo-local flows resolve bare `@smthrs/*` | None. rc.0 has no global pack and `init --global` exits 1 (rc-contract §4.2); seats resolve from environment keys (`SMITHERS_GATEWAY_AGENT_*` mapped to provider env), so Plue deletes `installGlobalSmithersPack` (`repo_gateway.go:1583-1622`, with `repo_gateway_seat_test.go:67-79` and `repo_gateway_h_test.go:254`) the `SMITHERS_YES=1 bun x --package smithers-orchestrator@0.28.0 smithers init --global --no-skill \|\| echo …` line in `run-workflow.sh` (`workflow_sandbox_scheduler.go:1010`, with the `workflow_sandbox_scheduler_test.go:1165-1175` assertions), and the workspace VM `packInitScript` (`workspace_provisioning.go:83-85`, run by `workspace_scripts/bootstrap.sh.tmpl:39-46`, with the `workspace_provisioning_test.go:54,593` and `workspace_scripts/embed_test.go:29,71` assertions) (ruling F1; rc-contract §10). | Ruled out; nothing to bind (`flows init` is a catalog-only plan card at HEAD, `flows-cli-control.md` 2). |
| Provider seat: OpenAI-compatible SDK agent with tools and a native structured-output toggle (Cerebras `/chat/completions` rejects `tools` with `response_format`) | `@smthrs/model` OpenAI Chat Completions provider through `@smthrs/agent` seats (`provider:modelId`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`) | Present at the import reference: `OpenAICompatible.make` (`packages/model/src/OpenAICompatible.ts:28-32`) accepts a `baseUrl` but targets `/v1/responses`; `Route.openaiCompatible` (`packages/model/src/Route.ts:329-340`, flows `d60679808`, lowering in `packages/model/src/OpenAIChatCompletions.ts`) accepts a `baseUrl` and targets `/chat/completions`, which is the shape Cerebras speaks. Phase 4 verifies the native-structured-output toggle against a live Cerebras seat (rc-contract §10). |

Not required by the product path and dropped from the RC gateway: tickets, cron, devtools, hijack, diff, memory, docs, prompts, accounts, usage, and scores RPCs. They serve only Tier 2 dashboards.

Projection fields (ruling E8). Beyond the product path, the Tier 2 dashboards display `run.workflowKey`, `run.workflow`, `run.createdAtMs`, `node.cardLabel`, `node.agent`, `approval.request`, and `approval.requestTitle` (section 4.5). None is an rc.0 requirement (the dashboards are Phase 6 fixtures), but the `run-summary`, `run-tree`, and `approvals` projections carry the flow id, the run's `createdAt`, the step's display label and seat, and the approval request envelope and title so a re-authored dashboard can bind to them without a second gateway change; the field names on the wire are the flows names (`flowId`, `createdAt`, the `ApprovalTarget.Node` envelope), not the 0.x names.

Plue-side changes implied: `repo_gateway.go` pins, launch line, seat template, and removal of `patchGatewayEngine`, `repo_gateway_engine_patch.go`, `assets/repo-gateway-workflow-hash-smthrs-0.33.0.js`, and the two pin tests; `internal/routes/repo_gateway_test.go`, `cmd/server/repo_gateway_cors_test.go`, and `scripts/prewarm-workspaces.sh` path strings; the Flows Worker allowlist, RPC path, event path, and `Wave11`, `Wave13`, and `gateway.test.ts` fixtures.

## 12. Minimum RC engine feature set (paths A, B, Tier 1, and the surviving pack)

| Requirement | Consumer | Flows HEAD status |
| --- | --- | --- |
| Run a flow file by path with `--root <dir>`, detached mode, and exit code equal to terminal status | Path B (`runArgs`), Tier 1 CI (`-d`), `smithers:fix-all` | `flows run` takes a plan payload; no path, root, or detach flags; `up` is a stub. Exit-code mapping exists (`BinTeardown.test.ts`). rc-contract §4.1 ships `up <flow> --root --data -d --json`. Operator-supplied run ids and `--max-concurrency` are not provided (rc-contract §4.1, §4.2): Plue stores the engine's `runId` from the receipt beside its own `workflow_runs.id` and drops `--max-concurrency` from `runArgs` and `agent.ts` (rc-contract §10). |
| JSON input | Tier 1 CI (`--input '{"sha"}'`) | `plan <flow> key=value --data <json>` present. |
| Non-interactive init that tolerates a VM with no model credential | Paths B and C; workspace VMs (`workspace_provisioning.go`) | Not required at rc.0, but three VMs run the init step today: the sandbox `run-workflow.sh` line at `workflow_sandbox_scheduler.go:1010` (with a `\|\|` fallback that keeps the VM alive; pinned by `workflow_sandbox_scheduler_test.go:1165-1175`), the gateway pack-install exec at `repo_gateway.go:1611` (no fallback; `execGatewayCommand` fails provisioning on a non-zero status; pinned by `repo_gateway_seat_test.go:67-79` and `repo_gateway_test.go:384,1065`), and the workspace VM `packInitScript` at `workspace_provisioning.go:85` (run by `workspace_scripts/bootstrap.sh.tmpl:39-46` with a `\|\|` fallback; pinned by `workspace_provisioning_test.go:54,593` and `workspace_scripts/embed_test.go:29,71`; it invokes the staged Plue Go CLI, which has no `init` verb, so it already fails). rc.0 has no global pack, `init --global` exits 1, and seats resolve from environment keys (rc-contract §4.1, §4.2, §10). Ruling F1: all three lines and their pinning tests are dropped at the cutover; an earlier draft of this row said the VMs run no init step, and a later one listed only the sandbox and gateway sites. |
| Agent action with a Zod structured output and a pluggable adapter (custom `generate`, tools, `supportsNativeStructuredOutput`) | Path A (`agent-task.tsx:156-184`) | `@smthrs/agent` and `@smthrs/harness` `Cell`, `EngineLike`, `FlowBinding` (`agents-and-capabilities.md`); adapter parity is Phase 4 work. |
| CLI agent adapters for Codex, Claude Code, OpenCode, Kimi, Amp with `configDir` and model options; OpenAI-compatible SDK agent | `.smithers/agents.ts`, gateway seat | Ported onto `@smthrs/harness` in Phase 4 (`agents-and-capabilities.md`). |
| Durable, typed, subscribable per-run event journal readable by another process: run started, finished, failed, cancelled; node output text with a stream channel; tool call start and finish with input, output, error | Path A mapper (`agent_event_mapper.ts`) | `@smthrs/journal` plus `control.agent.*` events (`flows-cli-control.md` 5.3). Ruling P1 replaces the file follower with an in-process subscription. |
| Per-run SQLite path override on a read-only image | Path A (`smithers.ts`, `/tmp/smithers-agent-state/…`, `journalMode: DELETE`) | Store path is a host composition parameter; confirm in Phase 4. |
| Sequential and parallel composition, loops, retries, timeouts, skip conditions, registered outputs addressable by (runId, nodeId, iteration), approvals as durable waits with resume, cancellation | Tier 1 CI, gateway product path | Present in `@smthrs/flow` and `@smthrs/engine`; output addressing becomes the `node-output` projection. |
| SQLite only | all Plue planes | Matches the PLAN default. |
| Node.js >=22.19.0 present on every Plue VM that opens `.flows/*.db`: the agent VM image (`cmd/agent-vm/Dockerfile:41,92`, Node 24.19.0 already installed (`ARG NODE_VERSION=24.19.0`, above the `>=22.19.0` floor); the service entry `bun run ./agent.ts` at `:12` changes to a Node entry or spawns a Node child for the harness), the sandbox VM (`workflow_sandbox_scheduler.go:61` installs `git`, `curl`, `jj`, `bun` only; add Node), and the repo gateway VM (`repo_gateway.go:1530-1536` installs Bun and `jj` only, package list `git`, `curl`, `ca-certificates`, `unzip` at `:1405`; add Node) | Paths A, B, C | rc-contract §1: `NodeDatabase.layer` fails with `unsupported_runtime` when `process.versions.bun` is set (W-16); the `smithers` shim carries a Node shebang, so `bun x --package @smthrs/cli smithers` runs under Node once Node is on the VM (rc-contract §3.4, §10). Today only the agent VM image ships Node. |

Deferred, used only by Tier 2 dev automation: worktree lanes, `fallbackAgents` seat pools, `openSmithersBackend`, tickets and cron RPCs, custom React run UIs, the `pglite` backend, MDX-as-component prompts.

## 13. Plue cutover acceptance checklist

The cutover is complete only when every item passes from a clean Plue checkout against the RC packages.

Builds and installs:

1. `pnpm install --frozen-lockfile` at the Plue root and `bun install --frozen-lockfile` in `cmd/runner/workflow` succeed, `.smithers/package.json` and its lockfile are removed (the pack is deleted or re-authored and preserved at a tag, rc-contract §10), and `poc/smithers-ship` is deleted or installs, with no `smithers-orchestrator`, `@smithers-orchestrator/*`, unscoped `smthrs`, or `file:../../smithers/…` entry in any manifest or lockfile.
2. `go build ./...` and `go test ./internal/services/... ./internal/routes/... ./cmd/server/...` pass with the RC pins; `repo_gateway_engine_patch.go`, `assets/repo-gateway-workflow-hash-smthrs-0.33.0.js`, `TestRepoGatewayEnginePatch_MatchesPin`, and `TestRepoGatewayOrchestratorPin_IsPublishedSmthrsWithAutoResume` are deleted or replaced by pins on the RC package and version.
3. `zig build e2e` passes, including the `workflow-install` step; `cmd/agent-vm/Dockerfile:137` and `cmd/agent-snapshot/main.go:54` assert the RC package directory instead of `node_modules/smithers-orchestrator`.
4. Root `package.json` no longer pins or overrides `react` and `react-dom` for the engine; `bench/src/preflight.ts` self-heal is removed or retargeted.

Real-backend suites:

5. Agent VM chat turn end to end: a session dispatched by `agent_dispatch.go` posts `text`, `tool_call`, `tool_result`, and `done` events to `/internal/agent/sessions/{id}/events` from the in-process harness; `e2e/api/smithers-agent-system.test.ts` is rewritten against the RC package and passes.
6. Sandbox plane end to end: `POST /api/repos/{o}/{r}/invoke` reaches `success` or `failure` in `workflow_runs` with logs in `workflow_run_logs`, using the RC CLI in the generated `run-workflow.sh`; the `SMITHERS_YES=1 bun x --package … smithers init --global --no-skill \|\| echo …` line is gone from the script and `workflow_sandbox_scheduler_test.go:1161-1175` no longer asserts it (ruling F1); the other `workflow_sandbox_scheduler_test.go` string assertions updated.
7. Repo gateway end to end: provisioning installs the RC package, writes the RC seat template, starts the gateway service, passes the health probe, and the relay serves every method the Worker allowlist needs (list flows, plan and run, run summary, approvals, approve, node output, diagnosis, cancel) plus an event stream that stays alive through the relay for more than 600 s idle; `internal/routes/repo_gateway_test.go`, `cmd/server/repo_gateway_cors_test.go`, and `scripts/prewarm-workspaces.sh` use the new paths; `installGlobalSmithersPack`, `repo_gateway_seat_test.go:67-79` (which asserts `smithers init --global` in the pack-install exec), and the `repo_gateway_h_test.go:254` call are deleted (ruling F1).
8. The Flows Worker and UI (`apps/server/src/gateway.ts`, `apps/ui/src/mainview/state/controller/context.ts`) pass their suites against a live RC gateway through the relay.
9. `e2e/api/gvisor-runner-contract.test.ts` and the canary suite (`canary-runner.test.ts`, `scripts/prod-canary-schedule.test.ts`) pass unchanged.
10. `pipeline-fast.yml` and `pipeline-thorough.yml` install the RC packages without checking out `smithersai/smithers` and run the re-authored `pipelines/ci-*.ts` flows to a green receipt.

Scans (zero matches in tracked source, excluding fixtures under the migration workflow's control):

11. `smithers-orchestrator`, `@smithers-orchestrator/`, `from "smthrs"`, `from "smithers"` and `from "smithers/`, `"smithers": "file:`, `@smthrs/errors/SmithersError`, `jsxImportSource: "smithers-orchestrator"`, `mdxPlugin(`, `createSmithers(`, `openSmithersBackend`, `stream.ndjson`, `/v1/rpc`, `/v1/api/stream`, `connect.challenge`.
12. No engine invocation loads a `.tsx` file: `.smithers/workflows/**/*.tsx` files that survive are Plue CI DSL files rendered by `scripts/workflow-evaluator.ts` and executed by the Go runner shim, never passed to the engine CLI; `bunfig.toml` preloads and `preload.ts` files are gone; `packages/workflow/package.json` has no smithers dependency and no smithers `jsxImportSource`.
13. Public docs (`apps/docs-smithers/guides/workflows.mdx`, `getting-started/first-workflow.mdx`, `cli-reference/commands.mdx`, `apps/docs/src/content/docs/docs/workflows/*.mdx`, `docs/specs/engineering.md`) contain no "Smithers JSX" wording and no removed `smithers` command.
14. The migration workflow's report for the Plue pack lists every one of the 57 `.tsx` files (56 at `2db1ecff2`) with a disposition (re-authored, fixture, or deleted) and detects the local 0.x state listed in 7.3 with the finish, archive, or discard instruction.
15. `packages/npm-cli/package.json` bin map is `{ plue: bin/plue.js }`, `canary.yml` builds `bin/plue`, and no Plue artifact (npm package, Docker image, Helm chart, VM snapshot) installs a `smithers` executable; the engine CLI owns that name (ruling P3, rc-contract R-20).
16. `.agents/skills` holds no `smithers-*` directory (63 deleted, ruling F2, section 6.5); `git ls-files '.agents/skills/smithers-*'` is empty; `byok-subscription-accounts.md` and `microsandbox/` remain; if the team wants agent skills for the rc.0 CLI it runs `smithers skills add` from `@smthrs/cli@1.0.0-rc.0`, which writes the curated `smithers` skill only.
17. Every `SMITHERS_*` name Plue sets for an engine process matches the rc-contract §4 table (ruling F4): `SMITHERS_YES` appears in no generated script or exec (`grep -rn SMITHERS_YES internal/services` is empty), `SMITHERS_BACKEND` is set to `pglite` nowhere, `SMITHERS_REPO_TOKEN` is gone from `.github/workflows/pipeline-*.yml`, `SMITHERS_CLI` is gone with `bench/src/smithers-arm.ts`, and `SMITHERS_API_KEY` is the only engine credential the gateway VM env carries beside the provider keys.
18. `git grep -n 'init --global' -- internal/services` is empty (ruling F1). At `8e03dbe5d2` it matches 23 lines in 10 files: the gateway site and its comments (`repo_gateway.go:56,82,111,141,1521,1611`, `repo_gateway_seat_test.go:67,70,76,191`, `repo_gateway_test.go:384,1065,1080`), the sandbox site (`workflow_sandbox_scheduler.go:1010`, `workflow_sandbox_scheduler_test.go:1165,1171`), and the workspace site (`workspace.go:114`, `workspace_provisioning.go:85`, `workspace_provisioning_test.go:54,593`, `workspace_scripts/bootstrap.sh.tmpl:33`, `workspace_scripts/embed_test.go:29,71`). The workspace deletion covers `workspace_provisioning.go:80-86`, the `PackInitScript` template variable, the `bootstrap.sh.tmpl:30-46` block, `workspaceGlobalPackInitLog` (`workspace.go:114-116`), and the four assertions; the same grep at Plue HEAD `664c95c60` still matches `workspace_provisioning.go:85` and `bootstrap.sh.tmpl:33`.

## 14. Dispositions and recorded Plue decisions

| Area | Disposition | Notes |
| --- | --- | --- |
| Go API, routes, services, DB schema, Helm, Terraform, compose, relay reverse proxy, static CI DSL renderer, discovery rule, Tier 0 workflows, canary and remediate runners, `cmd/smithers`, `cmd/smithers-agent` | keep | never touch the engine |
| Paths A, B, C Go and TS code; `packages/workflow` typings; `pipeline-*.yml`; `e2e/api/smithers-agent-system.test.ts`; `.smithers` pack config; `agents.ts`; MDX prompts (loader change); `.smithers/evals`; public docs | migrate | rewritten against the RC contracts |
| Tier 1 `pipelines/*` | migrate | re-author as `.ts` flows before cutover |
| Seeded stock copies (Tier 3), `.smithers/components/*`, custom run UIs including generated modules, compiled `scripts/smithers.js`, `poc/smithers-ship`, embedded engine patch asset, bench smithers arm and shim, local 0.x databases and logs | delete | no product role |
| `.agents/skills/smithers-*/SKILL.md` (63 files) | delete | 0.x `skills add` generated command skills that script removed verbs and 0.x flags (ruling F2, section 6.5); rc.0 `skills add` writes the curated skill only. `byok-subscription-accounts.md` and `microsandbox/` stay. |
| D1. Plue CI DSL syntax | keep for the static renderer and evaluator; migrate for `packages/workflow` (ruled, rc-contract R-19) | Plue's decision in shape, not a Smithers contract item: Plue keeps `@smithers-ai/workflow` as a TSX DSL under its own name because the Go runner already executes a JSX-free shim and the static renderer (`node:fs`, `node:path`, `typescript` only) needs no change. The package itself is engine-bound today (`src/create.tsx:8-12` imports `createSmithers`, `src/index.ts:24-32` re-exports the JSX components and `runWorkflow`, `tsconfig.json:7` `jsxImportSource: smithers-orchestrator`) and is rewritten under rc-contract §10. The rc.0 gate is that `packages/workflow` and `scripts/lib/workflow-renderer.ts` import nothing from `smithers-orchestrator` or `smthrs`, carry no smithers `jsxImportSource`, and Plue docs stop calling the DSL "Smithers JSX" (checklist items 12 and 13). Recorded in the disposition ledger section `Plue cutover decisions` as two rows. |
| D2. Tier 2 dev-automation survivors | delete; Phase 6 fixtures (ruled, rc-contract R-21) | None is re-authored before `1.0.0-rc.0`: `fix-all-issues` (with its cron controllers), `alpha-plue`, `ticket-fleet*`, `byok-*`, `ddd-*`, `docs-concision`, `create-workflow`, `research-plan-implement`, `issue-pipeline`, `ticket-kanban`, `batch-issues` (deleted as dead under ruling E6 and kept at the tag as the extra `file:`-dependency fixture), `triage-review-findings`, `create-ui`, and `scripts/smithers.tsx` are Phase 6 fixtures preserved at a Plue tag (`pair-poc` was on the list at the survey revision and was deleted from Plue at `2db1ecff2`), because they alone use worktree lanes, `fallbackAgents`, `openSmithersBackend`, `pglite`, tickets and cron RPCs, and custom React run UIs. The re-author list is empty; re-authoring is Plue backlog after the cutover. Recorded in the disposition ledger section `Plue cutover decisions`. |

### 14.1 Cutover branch (recorded 2026-08-30)

The Plue cutover is implemented on branch `smithers-rc0-cutover` in the Plue repository
(base `664c95c60`, the survey revision's successor; tag `smithers-0x-pack-final` marks the
last 0.x pack). During the migration program it was checked out at
`<program base>/wt/plue-cutover` (a git worktree of `/Users/williamcory/plue`); the
acceptance checklist in section 13 binds to that branch's tip, and the per-item evidence
lives in the program's `finish/plue-cutover-report.md`. Items 3, 5 to 10 remain
BLOCKED-ON-publication or ENV-SKIP until `@smthrs/*` `1.0.0-rc.0` is on npm and the live
stack (Postgres, API, sandbox provider) is up; each row names its proving command.

## 15. Items not re-verified in this pass

- `apps/docs-smithers` hit counts (52 old-surface hits in `guides/workflows.mdx`, 23 in `first-workflow.mdx`, 24 command mentions in `commands.mdx`) are the reader's numbers; this pass verified the JSX claim at `workflows.mdx:9,69` and the file set only.
- `cmd/server/main.go:700-708` cron and webhook workers, `docs/runbooks/registry.json` (33 references), and `infra/terraform/environments/prod/variables.tf:125` are cited from the reader.
- Whether `Control.Cancel` reaches a run owned by another process is no longer open: it does not at the import reference (B-10), and W-05's `packages/cli/test/CrossProcessCancel.test.ts` is the proof the gateway path inherits; the Phase 4 relay proof is the checklist item 7 end-to-end run.
- `@smthrs/model` accepts a custom OpenAI-compatible base URL at the import reference: `Route.openaiCompatible` (`packages/model/src/Route.ts:329-340`, flows `d60679808`) targets `/chat/completions`; only the native-structured-output toggle for the Cerebras seat needs the Phase 4 check (rc-contract §10, R-4).
