# Phase 7 gate: plue-cutover

Verdict: FAIL. Every Plue-side item that can run without the live stack passes from a clean Plue checkout against the rc.0 packages: frozen installs, `go build`, the Go service/route/server suites, the runner suite (the two tests that failed on 2026-08-30 now pass), the script, canary, workflow-package, and gVisor contract suites, the agent-host install through both the clean Smithers checkout and the 40 packed tarballs, and every removed-package and JSX-loading scan. The gate fails on what the real-backend run of Plue's re-authored CI flow exposed in the rc.0 tree itself: `smithers up` exits 0 for a run whose terminal status is `failed`, and a failed agent run is never recorded in the engine store, so a later process steals it and calls the model seat again. A third item is the pipeline shape: Plue's `pipeline-*.yml` and rc-contract section 10 launch the CI flow with `-d`, which returns before the tier runs, so the job cannot observe the verdict. The live-stack items (3, 5 to 10 of plue-consumer-contract section 13) and the tier's own verdict stay ENV-SKIP: the registry has no `@smthrs/*` `1.0.0-rc.0`, no API listens on `localhost:4000`, Docker is down, and the OpenAI seat the flow pins has no credits.

Date: 2026-08-31 (07:32Z to 07:47Z). Previous round: 2026-08-30, FAIL on the Path D JSX runtime and the missing branch record; both cleared (see "Target resolution"). The previous evidence file is preserved at `plue-cutover-logs/previous-plue-cutover-20260830.md`.

## Environment

| Tool | Version |
| --- | --- |
| node | v24.18.0 |
| bun | 1.4.0 (`bun test` reports `1.4.0-canary.1 (6618e7f7e)`) |
| pnpm | 10.6.5 through `corepack pnpm` (Plue pins `packageManager: pnpm@10.6.5`); the `pnpm` on PATH is the nvm corepack shim reporting 11.21.0 |
| go | go1.26.0 darwin/arm64 |
| zig | 0.15.2 |
| docker | daemon not running (`docker info` exit 1) |
| host | macOS arm64 (Darwin 25.2.0); load average 2.3 to 9.1 at the start of each suite, recorded per log |

## Target resolution

- Plue branch `smithers-rc0-cutover`, tip `93abe834f` ("cutover: ship the CI DSL's own react-free JSX runtime so Path D executes"), 14 commits on base `664c95c60`, which is Plue HEAD, the merge base, and the annotated tag `smithers-0x-pack-final`. `docs/migration/plue-consumer-contract.md` section 14.1 now records the branch, its base, the tag, and the worktree path, which closes procedural blocker 2 of the previous round.
- Validation checkout: `git clone --shared --branch smithers-rc0-cutover /Users/williamcory/plue /Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/plue-clean-cutover` (4,251 tracked files, `git status --porcelain` empty before and after the run; the only ignored additions are `node_modules/`, `.flows/`, `.zig-cache/`). The lane worktree `migration/wt/plue-cutover` sits at the same tip, clean, and was not used. `/Users/williamcory/plue` was read only (`git rev-parse`, `git worktree list`, clone source).
- Smithers: the clean checkout `migration/clean-checkout-2` at `20b32c6316`, which is the `v1/rc0-migration` ref in `/Users/williamcory/smithers` (that tree's HEAD `163fdf4bf5` is one chore commit ahead, "regenerate known-files.d.ts"). Packed tarballs: the npm-pack gate's `release-packs-cc2` (40 `.tgz`); the sorted SHA-256 list hashes to `eac5bb9b2ca2a168d5d22ece1f2943a4da482aefc68661e88c032a45f60d7ba7`, identical to `npm-pack-logs/tarball-shasums-cc2.txt` (`plue-cutover-logs/release-packs-cc2-shasums-verified.txt`).
- Registry: `npm view @smthrs/agent version` answers 404; `npm view @smthrs/cli version` answers `0.35.0` (the 0.x line). `1.0.0-rc.0` is unpublished, so every `bun x --package @smthrs/cli@1.0.0-rc.0` and `npm install -g @smthrs/cli@1.0.0-rc.0` site in Plue cannot run yet.

The committed interim links (ruling R-P1, `cmd/runner/workflow/agent-host/pnpm-workspace.yaml`) point at `/Users/williamcory/smithers`. This gate never validates inside that tree, so the two agent-host manifests were retargeted in the clean Plue checkout to the clean Smithers checkout for the install (`sed` of the `link:` prefix in `pnpm-workspace.yaml` and of the absolute and relative link paths in `pnpm-lock.yaml`; `git diff --stat` shows only those two files, 28 lines each way), then restored with `git checkout --` at the end. The first attempt wrote the relative path one segment short and produced dangling symlinks (`04-agent-host-links-cc2-install.log`, retained); the corrected install is `04b-agent-host-links-cc2-install.log`. The runner suite passed identically before and after the correction, which shows it never spawns the real host (`agent-task.test.ts:735` injects a fake `host`).

## Builds and installs

All commands ran in the clean Plue checkout unless noted. Logs: `plue-cutover-logs/01` to `06`, `10`, `13`.

| Command | Exit | Final output |
| --- | --- | --- |
| `corepack pnpm install --frozen-lockfile` (root) | 0 | `Done in 19.2s using pnpm v10.6.5` (npm-cli postinstall: "Skipping Smithers CLI binary download") |
| `bun install --frozen-lockfile` (`cmd/runner/workflow`) | 0 | `36 packages installed [983.00ms]` |
| `go build ./...` | 0 | silent, 18 s |
| `corepack pnpm install --frozen-lockfile` (`agent-host`, links to the clean Smithers checkout) | 0 | `Lockfile is up to date, resolution step is skipped`, `Done in 227ms`; `node_modules/@smthrs/{agent,cli,control,harness,registry}` resolve to `clean-checkout-2/packages/*`, `effect` and `@effect/platform-node` to its `.pnpm` store; versions `1.0.0-rc.0` x5, `4.0.0-rc.108` x2 |
| `echo '{}' \| node turn.ts` (agent-host, links) | 1 | `{"_tag":"plue/turn-settled","status":"failed","error":"repoRoot must be a non-empty string"}`: the host's own protocol answer, so the whole `@smthrs/cli/Application`, `NodeControl`, `@smthrs/control`, `@smthrs/registry` graph loaded under Node 24 |
| `corepack pnpm install --no-frozen-lockfile` (scratch copy of agent-host, every `@smthrs/*` name overridden to its tarball, `plue-cutover-logs/agent-host-tarballs.pnpm-workspace.yaml`) | 0 | `resolved 95, reused 53, downloaded 37, added 90, done`; 37 `@smthrs/*` packages materialized from the tarballs and none from the registry, so the pack set satisfies every transitive `1.0.0-rc.0` pin; `AgentSession`, `Control`, `NodeControl.layerExecutor`, `Discovery` exported; `echo '{}' \| node turn.ts` gives the same protocol answer, exit 1 |
| `zig build workflow-install` | 0 | `Checked 36 installs across 62 packages (no changes)` |
| `zig build check-naming` | 0 | silent |
| `zig build e2e-install` | 1 | `Unsupported package manager specification (bun@1.3.9)`; host-specific, see observation P2 |
| `tsc --noEmit -p cmd/runner/workflow/tsconfig.json` | 0 | silent |
| `tsc --noEmit -p packages/workflow/tsconfig.json` | 2 | only the two pre-existing `bun:test` TS2307 lines in the test files; both JSX runtimes and the compile fixture are clean |

Item 2 statics: `internal/services/repo_gateway_engine_patch.go` and `assets/repo-gateway-workflow-hash-smthrs-0.33.0.js` are absent; `TestRepoGatewayEnginePatch_MatchesPin` and `TestRepoGatewayOrchestratorPin_IsPublishedSmthrsWithAutoResume` appear in no `.go` file; `repo_gateway.go` pins `repoGatewayOrchestratorPackage = "@smthrs/cli@1.0.0-rc.0"`. Item 3 statics: `cmd/agent-vm/Dockerfile:162` and `cmd/agent-snapshot/main.go:57` assert `agent-host/node_modules/@smthrs/agent`; `Dockerfile:144-145` marks the registry install `BLOCKED ON PUBLICATION`. Item 4: the root `package.json` pins no `react` or `react-dom` (the `comments.overrides` prose records the removal); `bench/src/preflight.ts` has no react mention; `bench/src/smithers-arm.ts` is gone.

## Suites

Logs: `plue-cutover-logs/05`, `07`, `09`, `09b`, `11`, `12`.

| Command | Exit | Result |
| --- | --- | --- |
| `go test -count=1 ./internal/services/... ./internal/routes/... ./cmd/server/...` | 0 | `ok internal/services 35.033s`, `ok internal/services/alertregistry 0.379s`, `ok internal/services/workspace_scripts 1.406s`, `ok internal/routes 7.672s`, `ok cmd/server 5.161s` |
| `bun test` (`cmd/runner/workflow`) | 0 | `227 pass, 0 fail, 565 expect() calls, Ran 227 tests across 13 files`; the two cases the previous round named ("installs repo dependencies before the workflow SDK shim", "uploads and downloads artifacts from a checked-out workflow import without buffering the download") are inside this count |
| `bun test scripts/` | 0 | `294 pass, 0 fail, Ran 294 tests across 40 files` (includes `plue-docs-verbs.test.ts`, `workflow-renderer.test.ts`, `ci-flows-contract.test.ts`, `prod-canary-schedule.test.ts`) |
| `bun test ./.smithers/workflows/canary-runner.test.ts` | 0 | `31 pass, 0 fail` |
| `bun test packages/workflow` | 0 | `16 pass, 0 fail, Ran 16 tests across 2 files` |
| `bun install --frozen-lockfile` (`e2e`) | 0 | `24 packages installed` |
| `bun test api/gvisor-runner-contract.test.ts` (`e2e`) | 0 | `11 pass, 0 fail, 89 expect() calls` |
| `bun test api/smithers-agent-system.test.ts` (`e2e`) | 1 | `error: Unable to connect`; the file's `beforeAll` posts to `${API_URL}/user/repos` and nothing listens on `localhost:4000` (`curl` exit 7, no `lsof` listener). ENV-SKIP |
| Path D load of the eight kept `.smithers/workflows/*.tsx` | 0 x 8 | Scratch repo outside the Plue tree, shim written by `ensureWorkflowSDKAvailable` (exports `.`, `./jsx-runtime`, `./jsx-dev-runtime`), zero `react` entries in its `node_modules`, each file imported with `bun run --jsx-import-source=@smithers-ai/workflow` from the repo root: `build`, `canary`, `ci`, `deploy`, `release`, `remediate`, `terraform`, `update-homebrew` all exit 0. Control without the flag: `Cannot find module 'react/jsx-dev-runtime'`, exit 1, so the fix from the plue-jsx lane is load-bearing |

## Real-backend run of the re-authored CI flow (Path B)

Logs: `plue-cutover-logs/15` to `20`; the run databases are copied to `plue-cutover-logs/plue-clean-cutover-dot-flows/`.

The rc.0 CLI is the working-tree CLI of the clean Smithers checkout, `node clean-checkout-2/packages/cli/bin/smithers.mjs`, run from the clean Plue root.

- `smithers --version`: `smithers v1.0.0-rc.0`.
- `smithers ls`: `ci-fast` and `ci-thorough`, discovered from `flows/<name>/flow.mdx`. `smithers doctor`: registry 2 flows; state `.flows`; `control.db` 4 migrations (latest 1002); `engine.db` 8 migrations (latest 4001); node v24.18.0; jj; `providers: OPENAI_API_KEY, CEREBRAS_API_KEY`. Exit 0.
- `smithers up ci-fast --data '{"sha":"93abe834f33a96445e5cc4d1e5d527657d82b628"}' --json` (the `pipeline-fast.yml:37` step, attached): the engine planned (`plan-1`), approved with scope `run`, accepted `run-1`, created and claimed the engine run, started attempt 1, armed the discipline, opened the turn on `openai:gpt-5-mini`, and failed in the model call: `flows/model/ModelError: You have no credits remaining`. A direct `POST https://api.openai.com/v1/responses` with the same key answers `insufficient_quota` / `credit_balance_exhausted`, so the tier's verdict is ENV-SKIP. Ten events are journaled in `.flows/control.db` for `run-1`.

Three defects in the rc.0 tree and one in the pipeline shape came out of this run. None is a Plue build, test, or scan failure.

S1. `smithers up` exits 0 for a failed run. Both attached invocations (`run-1`, `run-2`) returned `exit=0` in 3 to 4 s while `smithers ps` and `smithers status` report `failed` and the diagnosis card reads `Verdict failed`. rc-contract section 4 (`up` row, line 206: "exit code follows the terminal status") and section 10 (line 515: "exits with the terminal status code") say otherwise. Source: `packages/cli/src/Command.ts:372-392` `runLaunch` waits for the settlement and fails only when `wasDeclined` (`control.run.pending`, line 302); a `control.run.failed` settlement renders the receipt and succeeds, and `bin.ts:67-68` maps success to exit 0. A launch failure does exit 1 (`run-4`, S3), so only the failed-terminal path is missing. Consequence for Plue: no caller of `smithers up` (the pipelines, the sandbox `run-workflow.sh`) can read a red run from the exit code.

S2. A failed agent run is not recorded in the engine store and is re-run by the next process. Each failure logs `engine-store: coordinated drain failed for run-N SchemaError: Expected JSON value at ["exit"]["cause"][0]["error"]` (`packages/engine-store/src/internal/RunCoordinator.ts:89`): the exit cause carries the `HarnessError` object with its nested `ModelError`, and the drain's JSON schema rejects it. The stores then disagree: `.flows/control.db` `flows_runs` has `run-1`, `run-2`, `run-3` as `failed` with `finished_at_ms` set; `.flows/engine.db` `flows_runs` has all three as `running`, `finished_at_ms` NULL, owner pids 32834 and 33005 (processes that had exited). When `run-2`'s process booted 86 s after `run-1`'s process exited, the journal for `run-1` gained `flows.engine.run-decision stolen-and-activated` (sequence 10, 07:43:56.235Z), `control.agent.discipline-armed` and `control.agent.turn-opened` (sequences 12, 13), and that process logged `An agent run failed { runId: 'run-1' ... You have no credits remaining }` a second time: the OpenAI seat was called again for a run the control plane had already closed. Each failure also logs `An agent run lifecycle event could not be journaled ... InterruptError` although `control.run.failed` is present. Consequence for Plue: Path A boots one `agent-host/turn.ts` process per chat turn against the same repository `.flows/`, so every turn after a failed one re-runs the failed turn once its dead owner's heartbeat is stale, bills the seat, and writes into the journal the relay is watching; Path B's one-shot VM boots once, so its exposure is bounded to a wedged engine row.

S3. `doctor` names `CEREBRAS_API_KEY` a provider (`packages/cli/src/Doctor.ts:154`), and `smithers up` on a `cerebras:gpt-oss-120b` seat (an untracked copy of the flow, removed afterwards) fails `/control/LaunchFailed: No route is configured for the cerebras provider`, exit 1. The control row for that `run-4` stays `running` in `flows_runs` (`ps` says `accepted`, `status` says `unlaunched`, zero journal events). rc-contract section 10's provider-seat item and plue-consumer-contract section 11 name the Cerebras seat as a Plue need; Plue's committed flows pin OpenAI, so this does not block the branch.

P1. The pipelines launch detached. `smithers up ci-fast -d --data ... --json` returned `{"detached":true,"logFile":".../.flows/logs/run-3.log","runId":"run-3"}` with exit 0 after 5 s; the run failed afterwards in the child. `.github/workflows/pipeline-fast.yml:37` and `pipeline-thorough.yml:39` use exactly this shape, and rc-contract section 10's CI item prescribes it. A GitHub job therefore finishes before the tier runs, the `receipts.jsonl` upload (`if: always()`) races the child, and the job is green whatever the tier does. `scripts/ci-flows-contract.test.ts` pins the flow's shape but not this. Item 10 needs an attached launch, which in turn needs S1.

## Scans

`git grep` and `git ls-tree` at committed revisions in the clean checkout; script `plue-cutover-logs/plue-scans.sh`, output `08-scans.log`. "code" excludes `*.md` and `*.mdx`.

| Scan | `664c95c60` (Plue mainline) | `93abe834f` (cutover tip) |
| --- | --- | --- |
| `smithers-orchestrator` files, code / all | 114 / 138 | 0 / 16 (docs/context, WAVE receipts, `TODO.md`, the dispositions doc, `byok-subscription-accounts.md`) |
| `@smithers-orchestrator/` | present | 0 / 3 |
| `from "smthrs"`, `smthrs@`, `"smithers": "file:` | 1, 3 / 7, 1 | 0, 0 / 5, 0 |
| `"smthrs"` in code | 2 | 3, all negative assertions: `cmd/runner/engine_package_names_test.go:17` (legacy-name list asserted absent), `e2e/api/smithers-agent-system.test.ts:69` (same), `packages/workflow/src/wrappers.test.ts:109` (forbidden-import list) |
| `createSmithers(`, `mdxPlugin(`, `openSmithersBackend`, `stream.ndjson` | 51 / 60, 3, 2, 3 | 0 / 3, 0, 0, 0 |
| `/v1/rpc`, `/v1/api/stream`, `connect.challenge` | 3 / 5, 0 / 1, 0 / 1 | 0 / 2, 0 / 1, 0 / 1 |
| `@smthrs/{graph,scheduler,driver,react-reconciler,components,db}` (`db` as a whole word), `@smthrs/errors/SmithersError`, `jsxImportSource: "smithers-orchestrator"`, `smthrs/jsx-runtime` | 0 | 0 |
| Manifests and lockfiles (`package.json`, `pnpm-lock.yaml`, `bun.lock`) naming `smithers-orchestrator` | 11 of 29 | 0 of 25; the only `@smthrs/*` names are `agent`, `cli`, `control`, `harness`, `registry`, each in the three agent-host files |
| `"react"` in manifests | 7 (root, runner, workflow package, poc, e2e) | 2: `e2e/package.json`, `e2e/bun.lock` (the Playwright suite's own dependency, identical at the base; not an engine pin) |
| `.smithers/package.json`, `bunfig.toml`, `preload.ts`, `agents.ts`, `smithers.config.ts` | present | absent; the remaining `bunfig.toml` files are `apps/cli` (`preload = ["./tests/setup.ts"]`) and `e2e` (`[test] root = "./api"`) |
| `.smithers/workflows/**/*.tsx` | 56 | 8: `build`, `canary`, `ci`, `deploy`, `release`, `remediate`, `terraform`, `update-homebrew`; imports are `@smithers-ai/workflow` (8), `bun`, `node:fs`, `node:fs/promises`, `node:path`, `crypto`; zero `@jsx`, `jsxImportSource`, `react`, or old-name lines |
| tracked `.tsx` total | 95 | 10 (the 8 above plus `packages/workflow/src/components.tsx` and `jsx-syntax.compile-fixture.tsx`) |
| `jsxImportSource` / `jsx-import-source` in code | pragmas in the pack | only `@smithers-ai/workflow`: `packages/workflow/tsconfig.json:7` and the runner's spawn flag `cmd/runner/workflow/execute-step.ts:183` |
| Engine invocations naming a `.tsx` (`smithers up\|run ... .tsx`) | present | 0; `internal/services/workflow_sandbox_scheduler.go:896` admits `isFlowsProjectPath` only, `workflow_sync.go:353-397` recognizes `flows/<name>/flow.{ts,mdx}` for the engine and `.smithers/workflows/*.{ts,tsx}` for the Plue renderer, `workflow_sandbox_flows_only_test.go` pins it |
| `poc/smithers-ship` files | 9 | 0 |
| `.agents/skills/smithers-*` files | 63 | 0 (`byok-subscription-accounts.md` and `microsandbox/` remain, ruling F2) |
| `packages/npm-cli` bin | `{smithers, plue}` | `{plue: bin/plue.js}`, name `@smithers/cli`; `canary.yml:124,140` builds and uses `bin/plue` |
| `SMITHERS_YES` / `init --global` in `internal/services` | 16 / 23 | 0 / 0 |
| `SMITHERS_REPO_TOKEN` / `smithersai/smithers` in `.github` | 2 / 2 | 0 / 2 (comment lines: "The engine comes from the registry. Nothing checks out smithersai/smithers") |
| `SMITHERS_BACKEND` with `pglite`, `SMITHERS_CLI` | present | 0 / 0 |
| `SMITHERS_*` names in the gateway, sandbox, and workspace code | includes `SMITHERS_YES` | `SMITHERS_API_KEY` plus Plue-internal names only (`SMITHERS_WORKFLOW_*`, `SMITHERS_JJHUB_*`, `SMITHERS_WORKSPACE_CLI_BINARY`, `SMITHERS_REPO_CLONE_TOKEN`, `SMITHERS_ORCHESTRATOR_CLI`) |
| "Smithers JSX" in `apps/docs-smithers`, `apps/docs`, `docs/specs` | 0 | 0 (the 294 script tests include `plue-docs-verbs.test.ts`) |
| Pack dispositions (item 14) | n/a | `docs/migration/smithers-rc0-pack-dispositions.md` names every one of the 85 `.tsx` files under `.smithers` at the base (0 missing) |

## Checklist map (plue-consumer-contract section 13)

| Item | Result | Proof |
| --- | --- | --- |
| 1 installs, pack removed, no old names in manifests | PASS | builds table; scans |
| 2 Go build and suites, engine patch gone | PASS | builds table; suites table |
| 3 `zig build e2e` with `workflow-install`, image asserts | ENV-SKIP (statics PASS) | `workflow-install` exit 0; `e2e` needs the harness or `docker-up` (Docker down), `bin/plue`, and the published registry packages (`Dockerfile:144`) |
| 4 root react pin gone, preflight self-heal gone | PASS | statics |
| 5 agent VM chat turn end to end | ENV-SKIP | no API on `localhost:4000`; the host loads through the clean checkout and the tarballs (builds table); S2 will affect this item once it runs |
| 6 sandbox plane end to end | ENV-SKIP (statics PASS) | `SMITHERS_YES` and `init --global` gone; live plane needs the stack; S1 and P1 affect the verdict path |
| 7 repo gateway end to end | ENV-SKIP (statics PASS) | `/v1/rpc` 0 in code, `smithers serve` exec line, Go suites green |
| 8 Flows Worker and UI against a live gateway | ENV-SKIP | Smithers-side apps, live gateway required |
| 9 gVisor contract and canary suites | PASS | 11 pass; 31 pass; `prod-canary-schedule` inside the 24 |
| 10 pipelines to a green receipt | ENV-SKIP, and blocked by P1 and S1 | `npm install -g @smthrs/cli@1.0.0-rc.0` is 404; the `-d` launch cannot gate |
| 11 removed-literal scans | PASS | scans table |
| 12 no engine invocation loads a `.tsx` | PASS | scans table; Path D load proof |
| 13 public docs wording | PASS | 0 hits; enforcing test green |
| 14 pack report lists every `.tsx` | PASS | 85 of 85 |
| 15 bin map and `canary.yml` | PASS | scans table |
| 16 no `smithers-*` skills | PASS | 0 files |
| 17 `SMITHERS_*` names | PASS | scans table |
| 18 `init --global` in `internal/services` | PASS | 0 |

## Blocking items

1. (Smithers, `packages/cli`) S1: make the attached `smithers up` (and `smithers run`, which shares `runLaunch` at `Command.ts:401`) exit non-zero when the settlement is `control.run.failed` (and `cancelled`), per rc-contract section 4 line 206 and section 10 line 515. Reproduce from any project whose seat rejects the call: `smithers up <flow> --json; echo $?` prints 0 while `smithers status <runId>` prints `Verdict failed`. Add the failed-terminal case to `packages/cli/test/Bin.test.ts`; the cli-e2e gate's negative sweep did not cover it.
2. (Smithers, `packages/engine-store` with `packages/agent`) S2: the drain must persist a failed run whose exit cause is not a JSON value, and a run the control plane has closed must never be stolen and re-executed. Reproduce with the two `.flows/*.db` files in `plue-cutover-logs/plue-clean-cutover-dot-flows/`: `control.db` `flows_runs` says `failed`, `engine.db` `flows_runs` says `running`; boot any executor against them after the heartbeat is stale and watch `stolen-and-activated` followed by a new model call. Fix the schema at the drain boundary (encode the cause as a string or a structured JSON error) and add a cross-process test that a failed run stays failed across a second boot.
3. (Plue lane, with an rc-contract section 10 edit) P1: `pipeline-fast.yml:37` and `pipeline-thorough.yml:39` must launch attached (`smithers up ci-<tier> --data ... --json`) so the job's exit code is the tier's, and the contract's CI item must stop prescribing `-d`. Depends on item 1 for a red tier to fail the job.

Environment-blocked, not lane defects: section 13 items 3, 5, 6, 7, 8, and 10's live halves (publication of `@smthrs/*` `1.0.0-rc.0`, the API and sandbox stack, Docker), and the `ci-fast` tier verdict itself (OpenAI `credit_balance_exhausted`; the only other funded seat, Cerebras, has no route, S3). After publication: swap the R-P1 links for the published pins (procedure in `agent-host/pnpm-workspace.yaml`), build the agent VM image, run `zig build e2e`, the live-API and relay suites, and land the pipeline receipts.

Observations recorded, no action required for this gate:

- P2. `zig build e2e-install` runs `pnpm install --frozen-lockfile` in `e2e/`, whose `package.json` declares `packageManager: bun@1.3.9`; the nvm corepack shim on this host refuses that specification. A native pnpm (`npx -y pnpm@10.6.5 install --frozen-lockfile`) exits 0 in the same directory. `build.zig:73` and `e2e/package.json:4` are identical at the base, so this predates the cutover.
- S3 as described above.

Cutover completion: `smithers-rc0-cutover` is not merged. Plue mainline `664c95c60` still carries the full 0.x surface (114 code files naming `smithers-orchestrator`, 56 pack workflows, 63 skill directories). PLAN completion criterion 9 is met on the branch for everything that runs without the live stack, and is met on mainline only after the merge and the post-publication items above.

## Logs

`/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/phase7/plue-cutover-logs/`:

- `01-root-pnpm-install.log`, `02-runner-bun-install.log`, `03-go-build.log`, `04-agent-host-links-cc2-install.log` (the miscounted first attempt), `04b-agent-host-links-cc2-install.log`, `05-go-test.log`, `06-zig-steps.log`, `07-root-bun-tests.log`, `08-scans.log` (`plue-scans.sh` beside it), `09-runner-bun-test.log`, `09b-runner-bun-test-rerun.log`, `10-agent-host-tarballs-install.log` (`agent-host-tarballs.pnpm-workspace.yaml` beside it), `11-e2e-static-and-live.log`, `12-pathd-eight-workflows.log` (`pathd-install-shim.ts` beside it), `13-typecheck-and-statics.log`, `14-checklist-statics.log`, `15-rc0-cli-discovery-doctor.log` (a failed invocation, superseded by 16), `16-rc0-cli-up-ci-fast.log` and `16-up-ci-fast.stdout`, `17-run-1-status-logs.log`, `18-up-exit-codes.log` with `18-up-attached.stdout` and `18-up-detached.stdout`, `19-run-1-redrive-check.log`, `20-up-probe-cerebras.log` with `20-up-probe.stderr`.
- `release-packs-cc2-shasums-verified.txt`, `plue-clean-cutover-dot-flows/` (the `control.db` and `engine.db` of the four runs), `previous-plue-cutover-20260830.md`.

Clean Plue checkout retained for the fix lanes at `/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/plue-clean-cutover` (tracked tree pristine at `93abe834f`; `.flows/` holds the four runs above).
