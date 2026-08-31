# Phase 7 gate: plue-cutover

Verdict: PASS. Every Plue cutover item that can run without the live stack and without the published registry passes from a clean checkout of the Plue branch `smithers-rc0-cutover` (tip `976a170a6`) against the clean Smithers checkout at `cd14388ed7` and the 40 tarballs packed from that commit: frozen installs, `go build`, the Go service/route/server suites, the runner suite, the script, canary, workflow-package, and gVisor contract suites, the agent-host install through workspace links and through the tarballs, the Path D load of the eight kept DSL files, and every removed-package and JSX-loading scan. The three blockers of the 2026-08-31 07:47Z round are closed and re-verified live against the rc.0 engine: an attached `smithers up` exits 1 for a failed run (S1), a failed agent run is persisted in both stores and is never stolen or re-executed by a later process (S2, four runs and four process boots), and Plue's pipelines launch attached (P1). The live-stack items (plue-consumer-contract section 13 items 3, 5, 6, 7, 8, and the live half of 10) stay ENV-SKIP: `@smthrs/*` `1.0.0-rc.0` is not on the registry, nothing listens on `localhost:4000`, Docker is down, and the OpenAI seat the flows pin has no credits. The `ci-fast` tier's own commands are red on this host and at Plue's base revision for reasons that predate the cutover (Postgres-backed tests under `-short` and two dashboard assertions); that is a Plue mainline condition, recorded below as P3.

Date: 2026-08-31 (12:40Z to 12:53Z). Previous round: 2026-08-31 07:47Z, FAIL on S1, S2, and P1; that evidence file is preserved as `plue-cutover-prev-20b32c6316.md` with its logs in `plue-cutover-logs-prev-20b32c6316/`.

## Environment

| Tool | Version |
| --- | --- |
| node | v24.18.0 |
| bun | 1.4.0 (`bun test` reports `1.4.0-canary.1 (6618e7f7e)`) |
| pnpm | 10.6.5 through `corepack pnpm` (the Plue root pins `packageManager: pnpm@10.6.5`); the `pnpm` on PATH is corepack 0.35.0's shim reporting 11.21.0 |
| go | go1.26.0 darwin/arm64 |
| zig | 0.15.2 |
| jj | 0.39.0 |
| sqlite3 | 3.51.0 |
| docker | daemon not running (`docker info` exit 1) |
| host | macOS arm64 (Darwin 25.2.0); load averages 3.6 to 16.1 during the run, recorded at the top of each log |

`SMITHERS_HOME` was stripped from every pnpm, bun, node, and zig invocation with `env -u SMITHERS_HOME`. `OPENAI_API_KEY` and `CEREBRAS_API_KEY` are set in the calling shell; `ANTHROPIC_API_KEY` is not.

## Target resolution

- Plue branch `smithers-rc0-cutover`, tip `976a170a64097827de8371bbf2a08930ebce7f34` ("launch the CI tiers attached so the pipeline job carries the tier's verdict"), 15 commits on base `664c95c60`, which is the merge base, the detached HEAD of `/Users/williamcory/plue`, and the annotated tag `smithers-0x-pack-final`. `docs/migration/plue-consumer-contract.md` section 14.1 records the branch, its base, the tag, and the worktree path. The branch is not merged: `git merge-base --is-ancestor 976a170a6 main` is false, and Plue's `main` ref is `8e03dbe5d` (the survey revision, 8 commits behind `664c95c60`).
- Validation checkout: `git clone --shared --branch smithers-rc0-cutover /Users/williamcory/plue /Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/plue-clean-cutover` at 12:40:09Z (4,251 tracked files; `git status --porcelain` empty before the run and empty after teardown, log 21). The only additions are ignored: `.flows/`, `.zig-cache/`, `node_modules/`, `e2e/node_modules`, `bin/`. `/Users/williamcory/plue` was read only (`git rev-parse`, `git worktree list`, `git branch --contains`, clone source); its HEAD and branch tip were unchanged at teardown.
- Smithers: `migration/clean-checkout-4` at `cd14388ed782aac6e5f5b23d66c8fa9dc01dd6ba`, which is `v1/rc0-migration` in `/Users/williamcory/smithers`. Its `packages/*/package.json` `exports` point at `src/*.ts`, so the workspace-link install runs the sources and needs no build. Packed tarballs: the npm-pack gate's 40 `.tgz` for this commit (`<scratchpad>/npm-pack/release-packs`); the sorted SHA-256 list hashes to `4a13a1d0769f8046fb8b77e00847c9f1a6be7a27679142b2ba559a13a7db08d0`, identical to the gate's `sha256-run1.txt` (`release-packs-cc4-shasums-now.txt`, `release-packs-cc4-shasums-gate.txt`).
- Registry: `npm view @smthrs/agent version` answers 404; `npm view @smthrs/cli version` answers `0.35.0`; `npm view @smthrs/cli@1.0.0-rc.0 version` answers 404. Every `npm install -g @smthrs/cli@1.0.0-rc.0` and `bun x --package @smthrs/cli@1.0.0-rc.0` site in Plue cannot run yet.
- Live stack: `curl http://localhost:4000/health` exit 7, no listener on 4000 or 5432, Docker down.

The committed interim links (ruling R-P1, `cmd/runner/workflow/agent-host/pnpm-workspace.yaml`) point at `/Users/williamcory/smithers`. This gate never validates inside that tree, so both agent-host manifests were retargeted in the clean Plue checkout to `clean-checkout-4` (`sed` of the absolute `link:` prefix in `pnpm-workspace.yaml` and in the lockfile's `specifier:` lines, and of the relative `version:` links, computed with `os.path.relpath` as `../../../../../clean-checkout-4`; `git diff --stat` shows the two files, 28 lines each way), then restored with `git checkout --` at teardown.

## Builds and installs

All commands ran in the clean Plue checkout unless noted. Logs: `plue-cutover-logs/01` to `04`, `06`, `10`, `10b`, `13`.

| Command | Exit | Final output |
| --- | --- | --- |
| `corepack pnpm install --frozen-lockfile` (root) | 0 | `Done in 10.4s using pnpm v10.6.5` (npm-cli postinstall: "Skipping Smithers CLI binary download") |
| `bun install --frozen-lockfile` (`cmd/runner/workflow`) | 0 | `36 packages installed [1103.00ms]` |
| `go build ./...` | 0 | silent, 12 s |
| `corepack pnpm install --frozen-lockfile` (`agent-host`, links to `clean-checkout-4`) | 0 | `Lockfile is up to date, resolution step is skipped`, `Done in 241ms`; `node_modules/@smthrs/{agent,cli,control,harness,registry}` resolve to `clean-checkout-4/packages/*` at `1.0.0-rc.0`, `effect` and `@effect/platform-node` to its `.pnpm` store at `4.0.0-rc.108` |
| `echo '{}' \| node turn.ts` (agent-host, links) | 1 | `{"_tag":"plue/turn-settled","status":"failed","error":"repoRoot must be a non-empty string"}`: the host's own protocol answer, so `@smthrs/cli/Application`, `@smthrs/cli/NodeControl`, `@smthrs/control`, `@smthrs/registry`, and `@smthrs/agent` all loaded under Node 24 |
| `corepack pnpm install --no-frozen-lockfile` (scratch copy of agent-host: `package.json`, `turn.ts`, `request.ts`, `events.ts`; every `@smthrs/*` name overridden to its `cd14388ed7` tarball, `agent-host-tarballs-cc4.pnpm-workspace.yaml`) | 0 | `resolved 95, reused 53, downloaded 37, added 90, done`; 37 `@smthrs/*` packages materialized from the tarballs, 0 from the registry (`registry.npmjs.org/@smthrs` occurs 0 times in the lockfile), so the pack set satisfies every transitive `1.0.0-rc.0` pin; `layerExecutor`, `layerGuardedPlatform`, `engineDurable`, `Application.layer`, `AgentSession`, `Control`, `Discovery`, `Registry` all resolve from `dist/esm`; `echo '{}' \| node turn.ts` gives the same protocol answer, exit 1 (the first probe in log 10 had copied only `turn.ts` and failed on `./request.ts`; log 10b is the corrected run) |
| `zig build workflow-install` | 0 | `Checked 36 installs across 62 packages (no changes)` |
| `zig build check-naming` | 0 | silent |
| `zig build e2e-install` | 1 | `Unsupported package manager specification (bun@1.3.9)`; host-specific, observation P2 |
| `zig build e2e` | 1 | fails in the same `e2e-install` dependency before any test runs; ENV-SKIP (P2, Docker, `bin/plue`, published registry) |
| `tsc --noEmit -p cmd/runner/workflow/tsconfig.json` (tsc 5.9.3) | 0 | silent |
| `tsc --noEmit -p packages/workflow/tsconfig.json` | 2 | only the two pre-existing `bun:test` TS2307 lines in the two test files; both JSX runtimes and the compile fixture are clean |

Item 2 statics: `internal/services/repo_gateway_engine_patch.go` and `assets/repo-gateway-workflow-hash-smthrs-0.33.0.js` are absent; `TestRepoGatewayEnginePatch_MatchesPin` and `TestRepoGatewayOrchestratorPin_IsPublishedSmthrsWithAutoResume` appear in no `.go` file; `repo_gateway.go:63` pins `repoGatewayOrchestratorPackage = "@smthrs/cli@1.0.0-rc.0"`. Item 3 statics: `cmd/agent-vm/Dockerfile:162` and `cmd/agent-snapshot/main.go:57` assert `agent-host/node_modules/@smthrs/agent`; `Dockerfile:144-146` marks the registry install `BLOCKED ON PUBLICATION`. Item 4: the root `package.json` pins no `react` or `react-dom` (`package.json:20` records the removal in prose); `bench/src/preflight.ts` and `bench/src/smithers-arm.ts` do not exist.

## Suites

Logs: `plue-cutover-logs/05`, `07`, `09`, `11`, `12`.

| Command | Exit | Result |
| --- | --- | --- |
| `go test -count=1 ./internal/services/... ./internal/routes/... ./cmd/server/...` | 0 | `ok internal/services 35.472s`, `ok internal/services/alertregistry 1.388s`, `ok internal/services/workspace_scripts 2.579s`, `ok internal/routes 7.944s`, `ok cmd/server 5.954s` |
| `bun test` (`cmd/runner/workflow`) | 0 | `227 pass, 0 fail, 565 expect() calls, Ran 227 tests across 13 files` |
| `bun test scripts/` | 0 | `298 pass, 0 fail, 1238 expect() calls, Ran 298 tests across 40 files` (294 in the previous round; the four new `ci-flows-contract` cases from the plue-ci-attached lane are the difference) |
| `bun test ./.smithers/workflows/canary-runner.test.ts` | 0 | `31 pass, 0 fail` |
| `bun test packages/workflow` | 0 | `16 pass, 0 fail, Ran 16 tests across 2 files` |
| `bun install --frozen-lockfile` (`e2e`) | 0 | `24 packages installed` |
| `bun test api/gvisor-runner-contract.test.ts` (`e2e`) | 0 | `11 pass, 0 fail, 89 expect() calls` |
| `bun test api/smithers-agent-system.test.ts` (`e2e`) | 1 | `ConnectionRefused` at `beforeAll` posting to `http://localhost:4000/api/user/repos`; no API listens. ENV-SKIP |
| Path D load of the eight kept `.smithers/workflows/*.tsx` | 0 x 8 | Scratch repository outside the Plue tree, shim written by `ensureWorkflowSDKAvailable` (`tsx-task-runtime.ts:865`; exports `.`, `./jsx-runtime`, `./jsx-dev-runtime`), zero `react` entries in its `node_modules`, no root `tsconfig.json`, each file run with `bun run --jsx-import-source=@smithers-ai/workflow` (the flag `execute-step.ts:183` passes) from the repository root: `build`, `canary`, `ci`, `deploy`, `release`, `remediate`, `terraform`, `update-homebrew` all exit 0. Control without the flag: `Cannot find module 'react/jsx-dev-runtime'`, exit 1 |

## Real-backend run of the re-authored CI flow (Path B)

Logs: `plue-cutover-logs/15` to `19`, `22`; the run databases are copied to `plue-cutover-logs/plue-clean-cutover-dot-flows/` (`control.db`, `engine.db` after `PRAGMA wal_checkpoint(TRUNCATE)`, and the detached child's `run-3.log`).

The rc.0 CLI is the working-tree CLI of the clean Smithers checkout, `node clean-checkout-4/packages/cli/bin/smithers.mjs`, run from the clean Plue root.

- `smithers --version`: `smithers v1.0.0-rc.0`.
- `smithers ls`: `ci-fast` and `ci-thorough`, discovered from `flows/<name>/flow.mdx`, exit 0. Before `.flows/` existed the command printed the rc-contract section 6 notice once (observation O1).
- `smithers doctor`: registry 2 flows, 1 directory skipped with no flow body (`flows/lib`); state `.flows`; `control.db` 4 migrations (latest 1002); `engine.db` 8 migrations (latest 4001); node v24.18.0; jj; `providers: OPENAI_API_KEY, CEREBRAS_API_KEY`. Exit 0.

### S1 closed: an attached launch exits with the terminal status

`smithers up ci-fast --data '{"sha":"976a170a6…"}' --json` (the `pipeline-fast.yml:42` shape, attached) printed `{"_tag":"Accepted","receiptId":"approve:plan-1","runId":"run-1"}` and exited 1 after 3 s (log 16). The engine planned, approved with scope `run`, created and claimed `run-1`, started attempt 1, armed the discipline, opened the turn on `openai:gpt-5-mini`, and failed in the model call: `flows/model/ModelError: You have no credits remaining` (a direct `POST https://api.openai.com/v1/responses` with the same key answers `insufficient_quota` / `credit_balance_exhausted`). `smithers ps --json` reports `run-1` `failed`; `smithers status run-1` prints `Verdict failed — /harness/HarnessError: The cell frame failed`. Three more attached launches (`run-2`, `run-4`) exited 1 in 3 to 4 s each. The previous round's exit 0 for the same settlement is gone.

The detached shape still returns after admission: `smithers up ci-fast -d … --json` printed `{"detached":true,"logFile":".../.flows/logs/run-3.log","runId":"run-3"}` and exited 0 after 5 s while the child settled `failed` afterwards (log 18). That is the documented `-d` behavior (rc-contract section 4), and neither pipeline uses it any more (P1 below).

### S2 closed: a failed run is persisted once and never re-driven

After `run-1` (log 17): `.flows/control.db` `flows_runs` has `run-1` `failed`, `finished_at_ms 1788180336952`; `.flows/engine.db` `flows_runs` has `run-1` `failed`, `finished_at_ms 1788180336965`, owner columns NULL; `state_json` carries `{"_tag":"Die","defect":{"_tag":"flows/engine-store/UnencodableResult",…}}`, the JSON projection the engine-failed-persist lane writes when the flow codec rejects the cause. The stderr line is now `engine-store: the settlement of agent/run could not be encoded through its own codec; persisting a JSON projection so the run still settles`; `coordinated drain failed`, `could not be journaled`, `InterruptError`, and `stolen-and-activated` occur 0 times across the four launches' stderr and the detached child's log (log 19).

Cross-process (logs 18, 19):

- `smithers run --resume run-1` from a second process printed `{"_tag":"Terminal","runId":"run-1","status":"failed"}`, exit 1, in 2 s; `run-1` kept `finished_at_ms 1788180336965` and 11 journal events.
- `run-2` (86 s after `run-1`), `run-3` (detached), and `run-4` (136 s after `run-1`, past the window in which the previous round observed the steal) each booted a fresh executor against the same `.flows/`. After all four, every run has exactly one `control.agent.turn-opened`, one `control.run.failed`, three `flows.engine.run-decision` events (`created`, `claimed-and-activated`, `transitioned`), and no `stolen`, `re-driven`, or `reclaimed` decision; both stores agree on `failed` for `run-1` to `run-4`, with owner and heartbeat columns NULL. The OpenAI seat was called once per run.

### P1 closed: the pipelines launch attached

`.github/workflows/pipeline-fast.yml:42` is `smithers up ci-fast --data "{\"sha\":\"$GITHUB_SHA\"}"` and `pipeline-thorough.yml:44` is the thorough twin, both without `-d`, both followed by the `actions/upload-artifact@v4` step with `if: always()`; `scripts/ci-flows-contract.test.ts` pins the shape (inside the 298 passing script tests). Neither file checks out `smithersai/smithers` (the two `smithersai/smithers` hits in `.github` are the comment lines saying so) and both install `@smthrs/cli@1.0.0-rc.0` from the registry, which is the post-publication half.

### The tier's own verdict

The `ci-fast` tier's verdict through the engine is ENV-SKIP (no OpenAI credits; the only other funded seat, Cerebras, has no route, S3). To record what the tier would do, its command was run directly, which is exactly what the flow instructs the seat to run (`flows/ci-fast/flow.mdx` lines 8 to 30: `bun flows/lib/run-tier.ts fast`), and it is the same three commands the 0.x `pipelines/ci-fast.tsx` ran at the tag (`go vet ./...`; `go test -short -timeout=120s ./cmd/... ./internal/... ./pkg/...`; `bun scripts/check-migration-contract.ts`), so the re-authoring is faithful. Logs 20, 20b to 20f.

| Step | Exit on this host | Cause | At base `664c95c60` |
| --- | --- | --- | --- |
| `go vet ./...` | 0 | | |
| `go test -short …` | 1 | 49 packages ok, 5 FAIL: `internal/db`, `internal/sandbox`, `internal/sse` need Postgres on `localhost:5432` (`connection refused`, 2, 19, and 22 lines; nothing listens; the pipelines provision no `services:` block, and only `db-integration.yml` does); `internal/infra` and `internal/infra/alerts` assert dashboard files (`infra/terraform/modules/monitoring/dashboards/microsandbox-vm.json` must exist, `microsandbox.json` structure) | identical: the same five packages fail with the same tests in a scratch worktree of the base (log 20f) |
| `bun scripts/check-migration-contract.ts` | 1 | `isJjWorkspace()` spawns `jj` first; on this host `jj root` resolves to `/Users/williamcory/.jj`, a home-directory repository, and `jj diff --summary db/migrations` exits 255 (`Object 881e9dd… of type commit not found`); with `jj` off PATH the same spawn throws `ENOENT` before the git fallback; with `--base 664c95c60` (the hosted-CI path) it exits 0 | the script's jj probe is unchanged since the base |

The receipt run recorded `{"sha":"976a170a6…","repo":"plue","tier":"fast","verdict":"failed","durationMs":67955}` in `~/.cache/smithers-ops/receipts.jsonl`. None of this is a cutover change; see P3 and P4.

## Scans

`git grep` and `git ls-tree` at committed revisions in the clean checkout; script `plue-cutover-logs/plue-scans.sh` (the zsh `$REV:c` modifier bug in its last two lines is fixed), output `08-scans.log`. "code" excludes `*.md` and `*.mdx`.

| Scan | `664c95c60` (Plue base) | `976a170a6` (cutover tip) |
| --- | --- | --- |
| `smithers-orchestrator` files, code / all | 114 / 138 | 0 / 16 (docs/context, WAVE receipts, `TODO.md`, the dispositions doc, `byok-subscription-accounts.md`) |
| `@smithers-orchestrator/` | 6 / 9 | 0 / 3 |
| `from "smthrs"`, `smthrs@`, `"smithers": "file:` | 1, 3 / 7, 1 | 0, 0 / 5, 0 |
| `"smthrs"` in code | 2 | 3, all negative assertions: `cmd/runner/engine_package_names_test.go`, `e2e/api/smithers-agent-system.test.ts`, `packages/workflow/src/wrappers.test.ts` |
| `from "smithers"`, `from "smithers/`, `@smthrs/errors/SmithersError` | 9, 2, 1 | 0, 0, 0 |
| `createSmithers(`, `mdxPlugin(`, `openSmithersBackend`, `stream.ndjson` | 51 / 60, 3, 2, 3 | 0 / 3, 0, 0, 0 |
| `/v1/rpc`, `/v1/api/stream`, `connect.challenge` | 3 / 5, 0 / 1, 0 / 1 | 0 / 2, 0 / 1, 0 / 1 |
| `@smthrs/{graph,scheduler,driver,react-reconciler,components,db}` (`db` as a whole word), `jsxImportSource: "smithers-orchestrator"`, `smthrs/jsx-runtime` | 0 | 0 |
| Manifests and lockfiles naming `smithers-orchestrator` | 11 of 29 | 0 of 25; the only `@smthrs/*` names are `agent`, `cli`, `control`, `harness`, `registry`, each in the three agent-host files |
| `"react"` / `"react-dom"` in manifests | 7 / 5 | 2 / 0: `e2e/package.json`, `e2e/bun.lock` (the Playwright suite's own dependency, identical at the base) |
| `.smithers/package.json`, `bunfig.toml`, `preload.ts`, `agents.ts`, `smithers.config.ts` | present | absent; the remaining `bunfig.toml` files are `apps/cli` and `e2e` |
| `.smithers/workflows/**/*.tsx` | 56 | 8: `build`, `canary`, `ci`, `deploy`, `release`, `remediate`, `terraform`, `update-homebrew`; imports are `@smithers-ai/workflow` (8), `bun`, `node:fs`, `node:fs/promises`, `node:path`, `crypto`; zero `@jsx`, `jsxImportSource`, `react`, or old-name lines |
| tracked `.tsx` total | 95 | 10 (the 8 above plus `packages/workflow/src/components.tsx` and `jsx-syntax.compile-fixture.tsx`) |
| `jsxImportSource` / `jsx-import-source` in code | pragmas in the pack | only `@smithers-ai/workflow`: `packages/workflow/tsconfig.json:7` and the runner's spawn flag `execute-step.ts:183` |
| Engine invocations naming a `.tsx` | present | 0; `workflow_sync.go:353-386` recognizes `flows/<name>/flow.{ts,mdx}` for the engine and `.smithers/workflows/*.{ts,tsx}` for the Plue renderer; `workflow_sandbox_flows_only_test.go` pins it |
| `cmd/runner/workflow/tsconfig.json` `jsx` lines; `package.json` deps | jsx set; `smithers-orchestrator` dep | none; `node-pty`, `tar-stream`, `tsx`, `viem`, `zod` |
| `poc/smithers-ship` files | 9 | 0 |
| `.agents/skills/smithers-*` files | 63 | 0 (`byok-subscription-accounts.md` and `microsandbox/` remain) |
| `packages/npm-cli` bin | `{smithers, plue}` | `{plue: bin/plue.js}`, name `@smithers/cli`; `canary.yml:124,140` builds and uses `bin/plue` |
| `SMITHERS_YES` / `init --global` in `internal/services` | 16 / 23 | 0 / 0 |
| `SMITHERS_REPO_TOKEN` / `smithersai/smithers` in `.github` | 2 / 2 | 0 / 2 (comment lines) |
| `SMITHERS_BACKEND` with `pglite`, `SMITHERS_CLI` | present | 0 / 0 |
| `SMITHERS_*` names in the gateway, sandbox, and workspace code | includes `SMITHERS_YES` | `SMITHERS_API_KEY` plus Plue-internal names only (`SMITHERS_WORKFLOW_*`, `SMITHERS_JJHUB_*`, `SMITHERS_JJ_*`, `SMITHERS_NODE_*`, `SMITHERS_MICROSANDBOX_*`, `SMITHERS_WORKSPACE_CLI_*`, `SMITHERS_REPO_CLONE_TOKEN`, `SMITHERS_ORCHESTRATOR_CLI`, `SMITHERS_DOWNLOAD_MODE`, `SMITHERS_FLOW_NAME`) |
| "Smithers JSX" in `apps/docs-smithers`, `apps/docs`, `docs/specs` | 0 | 0 (`plue-docs-verbs.test.ts` enforces it inside the 298) |
| Pack dispositions (item 14) | n/a | `docs/migration/smithers-rc0-pack-dispositions.md` names every one of the 85 `.tsx` files under `.smithers` at the tag (0 missing) |

## Checklist map (plue-consumer-contract section 13)

| Item | Result | Proof |
| --- | --- | --- |
| 1 installs, pack removed, no old names in manifests | PASS | builds table; scans |
| 2 Go build and suites, engine patch gone | PASS | builds table; suites table |
| 3 `zig build e2e` with `workflow-install`, image asserts | ENV-SKIP (statics PASS) | `workflow-install` exit 0; `e2e` needs the harness or `docker-up` (Docker down), `bin/plue`, and the published registry packages (`Dockerfile:144`); P2 |
| 4 root react pin gone, preflight self-heal gone | PASS | statics |
| 5 agent VM chat turn end to end | ENV-SKIP | no API on `localhost:4000`; the host loads through the clean checkout and the tarballs (builds table) |
| 6 sandbox plane end to end | ENV-SKIP (statics PASS) | `SMITHERS_YES` and `init --global` gone; live plane needs the stack; S1 now gives the verdict path its exit code |
| 7 repo gateway end to end | ENV-SKIP (statics PASS) | `/v1/rpc` 0 in code, `/rpc`, `/rpc/ws`, `/projections/ws`, `/health` pinned in `repo_gateway_test.go:128`, `prewarm-workspaces.sh:169,177`, Go suites green |
| 8 Flows Worker and UI against a live gateway | ENV-SKIP | Smithers-side apps, live gateway required |
| 9 gVisor contract and canary suites | PASS | 11 pass; 31 pass; `prod-canary-schedule` inside the 298 |
| 10 pipelines to a green receipt | ENV-SKIP for the live half; shape PASS | attached launch pinned (P1 closed), exit code carries the verdict (S1 closed); `npm install -g @smthrs/cli@1.0.0-rc.0` is 404; the tier itself is red at base and tip for Plue-side reasons (P3, P4) |
| 11 removed-literal scans | PASS | scans table |
| 12 no engine invocation loads a `.tsx` | PASS | scans table; Path D load proof |
| 13 public docs wording | PASS | 0 hits; enforcing test green |
| 14 pack report lists every `.tsx` | PASS | 85 of 85 |
| 15 bin map and `canary.yml` | PASS | scans table |
| 16 no `smithers-*` skills | PASS | 0 files |
| 17 `SMITHERS_*` names | PASS | scans table |
| 18 `init --global` in `internal/services` | PASS | 0 |

## Previous blockers

| Id | Previous finding | Fix lane | State in this round |
| --- | --- | --- | --- |
| S1 | attached `smithers up` exited 0 for a `control.run.failed` settlement | `cli-exit-code` (`4a803f193d`), landed through `cli-lifecycle` (`ca22977386`) | closed: exit 1 on `run-1`, `run-2`, `run-4`; `run --resume` on a settled run exits 1 with a `Terminal` receipt |
| S2 | failed agent run not persisted in the engine store; stolen and re-run by the next process | `engine-failed-persist` (`e44159b9ef`) | closed: engine row `failed` with the `UnencodableResult` projection; no steal across three later boots; one model call per run |
| P1 | pipelines launched with `-d` | Plue `plue-ci-attached` (`976a170a6`) | closed: both pipelines attached, four pinning tests green |

## Observations, no action required for this gate

- O1. The first rc.0 command in a Plue checkout prints `Found Smithers 0.x state at <root>/.smithers …` once to stderr, because Plue keeps a tracked `.smithers/` directory (Path D DSL files, `spec`, `tickets`, one architecture note) and rc-contract section 6 names `.smithers/` an unambiguous 0.x marker (`packages/cli/src/Project.ts:30-35`). The notice is informational, the exit code is 0, and it stops once `.flows/` exists, which is the contract's stated behavior. A fresh CI checkout will print it on every job's first `smithers up`.
- S3 (unchanged). `doctor` names `CEREBRAS_API_KEY` a provider (`Doctor.ts:154`), `Route.openaiCompatible` documents a Cerebras measurement dated 2026-08-29, but `smithers up` on a `cerebras:gpt-oss-120b` seat (an untracked copy of the flow, removed afterwards, log 22) still fails `LaunchFailed: No route is configured for the cerebras provider`, exit 1 in 6 s. The control row for that `run-5` stays `running` in `control.db` `flows_runs` (`ps` says `accepted`) with no engine row and no journal event, so a launch that fails before the executor claims the run leaves a permanent non-terminal row in `ps`. Plue's committed flows pin OpenAI, so neither half blocks the branch; the seat is the one plue-consumer-contract section 11 names as a Plue need.
- P2. `zig build e2e-install` runs `pnpm install --frozen-lockfile` in `e2e/`, whose `package.json` declares `packageManager: bun@1.3.9`; corepack's shim on this host refuses that specification. A native pnpm (`npx -y pnpm@10.6.5 install --frozen-lockfile`) exits 0 in the same directory. `build.zig:73` and `e2e/package.json:4` are identical at the base.
- P3. The `ci-fast` tier's short Go suite is red on Plue's own base revision: three packages require Postgres on `localhost:5432` under `-short` while `pipeline-fast.yml` provisions no service, and two `internal/infra` packages assert dashboard files that do not exist at either revision. The cutover reproduced the 0.x command list exactly; a green receipt for item 10 needs Plue to fix the tier's inputs, independent of Smithers.
- P4. `scripts/check-migration-contract.ts` spawns `jj` unconditionally in its workspace probe, so it reads whatever jj repository is nearest above the checkout and throws `ENOENT` where jj is absent; the `--base <sha>` path is unaffected. Unchanged since the base.

## Blocking items

None for this gate on the Smithers side. The items below are outside this gate's reach and are recorded for the maintainer and the Plue lane:

1. After `@smthrs/*` `1.0.0-rc.0` is published: swap the R-P1 links for the published pins (procedure in `agent-host/pnpm-workspace.yaml`), build the agent VM image (`Dockerfile:144-162`), run `zig build e2e`, the live API suite (`e2e/api/smithers-agent-system.test.ts`), the sandbox and gateway planes (items 5 to 8), and land a pipeline receipt (item 10). Each needs the API, sandbox provider, Postgres, and Docker, none of which run on this host.
2. Plue mainline: merge `smithers-rc0-cutover`; `664c95c60` still carries the full 0.x surface (114 code files naming `smithers-orchestrator`, 56 pack workflows, 63 skill directories). P3 and P4 decide whether the merged pipelines can ever produce a green receipt.

Cutover completion: PLAN completion criterion 9 is met on the branch for everything that runs without the live stack, and is met on mainline only after the merge and the post-publication items above.

## Logs

`/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/phase7/plue-cutover-logs/`:

- `01-root-pnpm-install.log`, `02-runner-bun-install.log`, `03-go-build.log`, `04-agent-host-links-cc4-install.log`, `05-go-test.log`, `06-zig-steps.log`, `07-root-bun-tests.log`, `08-scans.log` (`plue-scans.sh` beside it), `09-runner-bun-test.log`, `10-agent-host-tarballs-cc4-install.log` and `10b-agent-host-tarballs-cc4-turn.log` (`agent-host-tarballs-cc4.pnpm-workspace.yaml` beside them), `11-e2e-static-and-live.log`, `12-pathd-eight-workflows.log` (`pathd-install-shim.ts` beside it), `13-typecheck.log`, `14-checklist-statics.log`, `15-rc0-cli-discovery-doctor.log`, `16-rc0-cli-up-ci-fast.log` with `16-up-ci-fast.stdout` and `.stderr`, `17-run-1-status-db.log`, `17b-run-1-journal-baseline.log`, `18-second-process-checks.log` with `18-resume-run-1.*`, `18-up-attached-run-2.*`, `18-up-detached-run-3.*`, `19-fourth-boot-redrive-check.log` with `19-up-attached-run-4.*`, `20-ci-fast-tier-direct.log`, `20b-ci-fast-tier-steps.log`, `20c-migration-contract-step.log`, `20d-short-suite-failure-reasons.log`, `20e-infra-failures-tip.log`, `20f-short-suite-at-base.log`, `21-teardown.log`, `22-up-probe-cerebras.log` with `22-up-cerebras.*`.
- `release-packs-cc4-shasums-now.txt`, `release-packs-cc4-shasums-gate.txt`, `plue-clean-cutover-dot-flows/` (the `control.db` and `engine.db` of the five runs and `run-3.log`).

Clean Plue checkout retained at `/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/plue-clean-cutover` (tracked tree pristine at `976a170a6`; `.flows/` holds the five runs above).
