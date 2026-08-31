# Phase 7 gate: plue-cutover

Verdict: FAIL. The cutover branch builds cleanly against the rc.0 contracts and every removed-package and JSX-loading scan is clean, but two real-backend runner tests fail at the branch tip with a reproduced product defect: Path D execution of `.smithers/workflows/*.tsx` cannot resolve `react/jsx-dev-runtime`, so every surviving Tier 0 CI DSL workflow is broken at runtime. A second, procedural blocker: `docs/migration/plue-consumer-contract.md` names no Plue migration branch, so this gate's own ground rules could not bind the validation target without discovery.

Date: 2026-08-30.

## Environment

| Tool | Version |
| --- | --- |
| node | v24.18.0 |
| bun | 1.4.0 (the runner install ran under `bun install v1.4.0-canary.1 (6618e7f7e)`) |
| pnpm | 10.6.5 via corepack (`packageManager: pnpm@10.6.5`; pnpm 11.21.0 on PATH) |
| go | go1.26.0 darwin/arm64 |
| zig | 0.15.2 |

## Target resolution

The ground rules key the writable target off a branch named in `/Users/williamcory/smithers/docs/migration/plue-consumer-contract.md`. That file (identical in the clean checkout at `9c464343f0` and in `/Users/williamcory/smithers`) names no branch: `grep -n "rc0-cutover\|smithers-rc0" docs/migration/plue-consumer-contract.md` exits 1. The literal instruction for that case is to report the cutover as not started. That report would be false: branch `smithers-rc0-cutover` exists in the Plue repository with 13 cutover commits on top of Plue HEAD `664c95c60` (merge base equals HEAD), checked out clean and idle at `/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/wt/plue-cutover`, tip `df7bb2017` ("cutover: clear the last two verifier findings..."). This gate validated that tip and records the missing contract row as a blocker. `/Users/williamcory/plue` itself was touched read-only (`git grep`, `git show`, `git ls-tree`, `git worktree list` at committed revisions only). All builds and tests ran in the lane worktree; `git status --porcelain` there is empty after the run (0 tracked-dirty, 0 untracked).

The lane consumes Smithers through interim ruling R-P1, recorded in `cmd/runner/workflow/agent-host/pnpm-workspace.yaml`: `@smthrs/{agent,cli,control,harness,registry}` pinned `1.0.0-rc.0` in `package.json`, resolved through `link:` overrides into `/Users/williamcory/smithers` (on `v1/rc0-migration` at `9c464343f0`, the same commit as the clean checkout; `packages/agent/package.json` there reads `@smthrs/agent 1.0.0-rc.0`). The release swap procedure is written in the file.

## Builds and installs (checklist items 1 to 4)

All commands ran in the lane worktree.

| Command | Exit | Final output |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` (root) | 0 | `Done in 681ms using pnpm v10.6.5` (npm-cli postinstall: "Skipping Smithers CLI binary download") |
| `bun install --frozen-lockfile` (`cmd/runner/workflow`) | 0 | `Checked 36 installs across 62 packages (no changes)` |
| `pnpm install --frozen-lockfile` (`cmd/runner/workflow/agent-host`) | 0 | `Already up to date` |
| `go build ./...` | 0 | no output |

Tarball consumption proof (the "packed rc.0 tarballs" arm of the gate): the agent-host manifest was copied to scratch, every `@smthrs/*` name overridden to the 40 tarballs from the npm-pack gate (`release-packs/`, aggregate SHA in `npm-pack.md`), `pnpm install --no-frozen-lockfile` exit 0, and a Node 24 smoke import printed `agent 1.0.0-rc.0 harness 1.0.0-rc.0 control 1.0.0-rc.0 registry 1.0.0-rc.0 cli 1.0.0-rc.0`, `AgentSession exported: true`. The published pins resolve and load without the interim links.

Item 2 statics: `internal/services` contains no `repo_gateway_engine_patch.go`, no `assets/repo-gateway-workflow-hash-smthrs-0.33.0.js`; `TestRepoGatewayEnginePatch_MatchesPin` and `TestRepoGatewayOrchestratorPin_IsPublishedSmthrsWithAutoResume` appear only in historical WAVE receipt documents. `repo_gateway.go:63` pins `repoGatewayOrchestratorPackage = "@smthrs/cli@1.0.0-rc.0"`.

Item 3 statics: `cmd/agent-vm/Dockerfile:162` and `cmd/agent-snapshot/main.go:57` assert `node_modules/@smthrs/agent` under `agent-host`, replacing the old `node_modules/smithers-orchestrator` assert. The Dockerfile marks the registry install "BLOCKED ON PUBLICATION" (`npm view @smthrs/agent` is 404), so the image build, `zig build e2e` with its `workflow-install` step, and the live VM planes cannot run before the maintainer publishes. Recorded as environment-blocked, not lane defects.

Item 4: root `package.json` pins no `react`/`react-dom` (the comment block records the removal); `bench/src/preflight.ts` contains no react self-heal.

## Real-backend suites (items 5 to 10)

| Command | Exit | Result |
| --- | --- | --- |
| `go test -count=1 ./internal/services/... ./internal/routes/... ./cmd/server/...` | 0 | `ok internal/services 34.963s`, `ok internal/services/alertregistry 2.995s`, `ok internal/services/workspace_scripts 1.090s`, `ok internal/routes 6.439s`, `ok cmd/server 4.191s` (uncached; a first run replayed only cached passes) |
| `bun test` (`cmd/runner/workflow`) | 1 | `221 pass, 2 fail, 531 expect() calls, Ran 223 tests across 13 files. [3.09s]` |

The two failures are both in `cmd/runner/workflow/execute-step.e2e.test.ts`: "installs repo dependencies before the workflow SDK shim" (line 459) and "uploads and downloads artifacts from a checked-out workflow import without buffering the download" (line 814). Both spawn `execute-step.ts` on a fixture repository whose `.smithers/workflows/ci.tsx` runs a `__tsx_task__:` step, and both get exit 1 instead of 0.

Reproduced outside the suite with the identical fixture and a local callback server. Subprocess stderr:

```
ResolveMessage: Cannot find module 'react/jsx-dev-runtime' from '<fixture>/.smithers/workflows/ci.tsx'
[execute-step] Step "tsx" failed with exit code 1
```

Root cause chain, each link verified in the lane tree: Bun transpiles the consumer `.tsx` with the default automatic JSX runtime, which imports `react/jsx-dev-runtime`; the shim `tsx-task-runtime.ts` writes into `node_modules/@smithers-ai/workflow` exports only `"."` (no `./jsx-runtime`, no `./jsx-dev-runtime`); no `jsxImportSource` is configured anywhere for the CI DSL (root `tsconfig.json` and `packages/workflow/tsconfig.json` set none); and the lane removed the root react pin, so `node_modules/react` no longer exists to satisfy the walk-up resolution that masked this on mainline. Consequence: the 8 surviving Tier 0 workflows (`build`, `canary`, `ci`, `deploy`, `release`, `remediate`, `terraform`, `update-homebrew` under `.smithers/workflows/`) fail at execution on any checkout without its own react, which includes the production runner path. This breaks checklist item 10's "green receipt" and PLAN Phase 7's "real-backend contract tests in `../plue`".

Not run, environment-blocked: the live-API suites (`e2e/api/smithers-agent-system.test.ts` needs `API_URL` at `localhost:4000` with the served stack; items 5 to 9's VM, relay, gvisor, and canary planes need provisioned infrastructure) and everything downstream of the unpublished registry packages (agent VM image, `zig build e2e`, GitHub Actions pipeline receipts). The lane's tracked WAVE receipts (`WAVE1-WORKSPACE-RECEIPT.md`, `WAVE4-RELAY-RECEIPT.md`, `WAVE12B-GATEWAY-AGENTS-RECEIPT.md`, `WAVE14B-RECEIPT.md`) record its own live runs; this gate did not re-execute them.

## Scans (items 11 to 18), `git grep`/`git ls-tree` at committed revisions

Mainline `664c95c60` versus lane tip `df7bb2017`:

| Scan | 664c95c60 | df7bb2017 |
| --- | --- | --- |
| `smithers-orchestrator` in code paths (`internal cmd packages apps scripts e2e bench .smithers .github poc`) | 117 files | 0 |
| Old names in any tracked `package.json`, `pnpm-lock.yaml`, `bun.lock` (`smithers-orchestrator`, `"smthrs"`, `@smthrs/{graph,scheduler,driver,react-reconciler,components,db}`, `"smithers": "file:`) | present | 0 files |
| `.smithers/workflows/*.tsx` | 56 | 8, all importing only `@smithers-ai/workflow`, zero smithers pragmas or `jsxImportSource` |
| `.smithers/package.json` (the 0.x pack) | 1 | 0 (pack preserved at annotated tag `smithers-0x-pack-final` = `664c95c60`) |
| `poc/smithers-ship` | 9 files | 0 |
| `.agents/skills/smithers-*` | 63 | 0 (`byok-subscription-accounts.md` and `microsandbox/` remain, per ruling F2) |
| `from "smthrs"`, `openSmithersBackend`, `mdxPlugin(`, `stream.ndjson`, `@smthrs/errors/SmithersError`, `jsxImportSource: smithers` | present | 0 files |
| `createSmithers(`, `/v1/rpc`, `/v1/api/stream`, `connect.challenge` | present | docs and historical receipts only (`docs/context/*`, `WAVE*-RECEIPT.md`); 0 in code |
| `SMITHERS_YES` and `init --global` in `internal/services` | present | 0 |
| `SMITHERS_REPO_TOKEN` and `smithersai/smithers` checkout in `.github` | present | 0 (pipeline comments state the engine comes from the registry) |
| `packages/npm-cli` bin map | `smithers` + `plue` | `{plue: bin/plue.js}`, name `@smithers/cli` |

Item 13: zero "Smithers JSX" in the gated public docs (`apps/docs-smithers`, `apps/docs`, `docs/specs`); remaining hits are historical context notes, reviews, the enforcing test `scripts/plue-docs-verbs.test.ts`, and a past-tense comment in `packages/workflow/src/components.tsx`. Item 14: `docs/migration/smithers-rc0-pack-dispositions.md` at the lane tip lists every pack `.tsx` with a disposition (8 keep, 2 re-authored, 32 fixture, 43 deleted, 85 total under `.smithers` at the base). `packages/workflow/package.json` has no dependencies and no smithers `jsxImportSource`.

## Blocking items

1. Fix the Path D JSX runtime resolution on `smithers-rc0-cutover`: `cmd/runner/workflow/execute-step.e2e.test.ts` tests at lines 402 and 700 must pass. Candidate fixes for the fix lane: export `./jsx-runtime` and `./jsx-dev-runtime` from the `tsx-task-runtime.ts` shim and set `jsxImportSource` for `.smithers/workflows`, or ship a react-free JSX runtime with `@smithers-ai/workflow`. Verify with `bun test` in `cmd/runner/workflow` (exit code, not log tail).
2. Record the cutover branch in `docs/migration/plue-consumer-contract.md`: name `smithers-rc0-cutover`, its base `664c95c60`, the tag `smithers-0x-pack-final`, and the checkout path, so the acceptance checklist binds to a revision.
3. Post-publication only: swap the R-P1 `link:` overrides for the published pins (procedure in `agent-host/pnpm-workspace.yaml`), build the agent VM image, run `zig build e2e` including `workflow-install`, run the live-API and relay suites (checklist items 5 to 9), and land a green `pipeline-fast.yml`/`pipeline-thorough.yml` receipt (item 10).
4. Land `smithers-rc0-cutover`: Plue mainline `664c95c60` still carries the full 0.x surface (117 files, 56 pack workflows, 63 skill directories); the cutover is complete only when the branch is merged and items 1 to 3 pass from a clean Plue checkout.

## Logs

Scratchpad `/private/tmp/claude-501/-Users-williamcory-smithers/b0a4ab15-ceef-429c-8898-089a3db0bc0d/scratchpad/`: `plue-root-pnpm-install.log`, `plue-runner-bun-install.log`, `plue-agenthost-pnpm-install.log`, `plue-go-build.log`, `plue-go-test-count1.log`, `plue-runner-bun-test.log`, `agent-host-tarball-install.log`, `repro-execute-step.ts`, `agent-host-tarball-test/`.
