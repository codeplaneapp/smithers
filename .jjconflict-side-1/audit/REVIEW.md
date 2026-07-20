# Smithers Codebase Audit — "Bulletproof" Review (COMPLETE)

**Date:** 2026-06-16  ·  **Reviewer:** multi-agent audit (73 + 12 subagents, two rounds + adversarial verification + completeness critic)

**Scope:** *smithers the tool* — `packages/*`, `apps/cli`, `apps/observability`, `apps/review`, the `.smithers` init pack, `examples/`, `docs/`, `skills/`, `e2e/`, and the `smithers ui` custom-workflow-UI system.
**Out of scope:** `apps/smithers` & `apps/smithers-studio-2` (retired POCs; the main product UI lives in a separate repo), `apps/smithers-demo`, `apps/smithers-tui-demo`, `~/gui`, `../plue`.

**Method:** One deep reviewer per package/app + cross-cutting dimension reviewers (docs, workflow↔UI↔doc coverage, the `smithers ui` system, adapters, e2e, skills, missing features, architecture, CI gating, systemic synthesis). Each review was followed by an **adversarial verifier** that tried to refute its findings; a **completeness critic** then found gaps which a second round closed. Findings are graded P0/P1/P2, grounded in `file:line` + observed evidence. Full machine-readable data: `audit/raw-findings-full.json` (raw) and `audit/reconciled-findings.json` (post-verification).

---

## Bottom line

**42 areas reviewed → 23 solid, 18 needs-work, 1 shaky.** **423 verified findings: 4 P0, 94 P1, 325 P2** (only 2 findings were refuted by verification — the findings below are high-confidence).

The runtime core is genuinely strong: the durable engine, the destructive time-travel/rewind path, the frame codec, migrations, and the `BaseCliAgent` subprocess core are well-built and well-tested **against real backends with no mocks**. Smithers is **not** close to "bulletproof" yet, but the gap is bounded and mostly mechanical. The blockers cluster into five themes:

1. **The e2e suite largely tests mocks, not the product** (the single biggest threat to the "no-mocks / 100% e2e" bar) — see the P0s.
2. **The high bar is not enforced by CI** — no coverage gate, no lint gate, the flagship package has no test script, and several drift-guards only run at publish.
3. **Type safety is decorative** — `checkJs` is off in all 27 packages and 28 packages commit a generated `.d.ts` that silently drifts from runtime (this already shipped real bugs).
4. **Several advertised features are no-op stubs** — `AlertRuntime`, memory `TokenLimiter`/`Summarizer`, `smithers gui` / `smithers .`, and faithfulness scoring on live runs.
5. **Dead code and packaging/type-export defects** — ~66 dead-code findings (whole orphaned subsystems) and broken subpath `types` exports across many packages.

Every issue found is concrete and fixable. With the P0s + the CI-enforcement + the systemic policy fixes addressed, the rest is a long but mechanical cleanup (tests, dead-code deletion, doc corrections). **If these are fixed, the confidence verdict is: yes, this becomes a bulletproof, well-architected, maintainable codebase.**

---

## Scorecard

| Area | Verdict | P0 | P1 | P2 |
|------|---------|----|----|----|
| `packages/engine` | solid |  | 3 | 12 |
| `packages/db` | needs-work |  | 5 | 9 |
| `packages/agents` | solid |  | 3 | 7 |
| `packages/components` | solid |  |  | 11 |
| `packages/time-travel` | solid |  | 1 | 11 |
| `packages/smithers` | solid |  | 1 | 7 |
| `packages/scheduler` | needs-work |  |  | 13 |
| `packages/driver` | needs-work |  | 1 | 7 |
| `packages/memory` | needs-work |  | 2 | 7 |
| `packages/errors` | solid |  | 2 | 7 |
| `packages/server` | solid |  | 3 | 8 |
| `packages/graph` | needs-work |  | 3 | 8 |
| `packages/openapi` | solid |  | 4 | 9 |
| `packages/devtools` | solid |  | 1 | 10 |
| `packages/gateway-react` | solid |  | 2 | 14 |
| `packages/gateway-client` | needs-work |  | 3 | 10 |
| `packages/usage` | needs-work |  | 2 | 8 |
| `packages/pi-plugin` | needs-work |  | 6 | 8 |
| `packages/sandbox` | solid |  | 2 | 10 |
| `packages/scorers` | needs-work |  | 1 | 12 |
| `packages/protocol` | needs-work |  | 1 | 10 |
| `packages/accounts` | solid |  | 3 | 6 |
| `packages/react-reconciler` | solid |  | 1 | 10 |
| `packages/vcs` | needs-work | 1 | 1 | 9 |
| `packages/control-plane` | solid |  | 1 | 7 |
| `packages/gateway` | solid |  | 1 | 7 |
| `packages/tool-context` | solid |  | 1 | 2 |
| `apps/cli` | needs-work |  | 3 | 8 |
| `apps/observability` | needs-work |  | 4 | 8 |
| `apps/review` | solid |  | 3 | 8 |
| `examples` | needs-work |  | 3 | 4 |
| `docs-human` | needs-work |  | 4 | 4 |
| `docs-agent-llms` | solid |  | 1 | 4 |
| `workflow-ui-doc-coverage` | needs-work |  |  | 9 |
| `smithers-ui-system` | solid |  | 2 | 6 |
| `adapters-e2e` | solid |  | 3 | 4 |
| `e2e-suite` | shaky | 2 | 2 | 7 |
| `skills` | solid |  | 4 | 5 |
| `missing-features` | solid |  | 4 | 4 |
| `architecture-deps` | solid |  | 1 | 9 |
| `ci-gating` | needs-work | 1 | 3 | 4 |
| `systemic-synthesis` | needs-work |  | 3 | 2 |
| **TOTAL** | | **4** | **94** | **325** |

---

## P0 — must fix (blocks the bar)

### [`packages/vcs`] captureWorkspaceSnapshot + withSnapshotTimeout have ZERO coverage in CI (only tested in jj-real-repo.test.js, which is skipped when jj is absent)
- **Category:** test-gap  ·  **File:** `packages/vcs/tests/jj-real-repo.test.js:26,307-356 ; packages/vcs/src/jj.js:108-147`  ·  **Verification:** confirmed
- **Evidence:** captureWorkspaceSnapshot appears in tests ONLY in jj-real-repo.test.js (grep across repo confirms no fake-bin test). That suite is gated by `const describeIfJj = jjAvailable ? describe : describe.skip` (line 26). CI (.github/workflows/ci.yml: ubuntu-latest, `pnpm install` + `pnpm test`, no jj install, no `fetch:jj`) has no jj and no jj-binaries package in the workspace, so resolveJjBinary falls to bare "jj" which is absent. Re-running with jj off PATH I observed: `0 pass, 12 skip`. The snapshot helper is the restore handle for durability/time-travel (used by engine/startDurability.js and time-travel) — it ships untested on every PR. withSnapshotTimeout's onTimeout sentinel (code 124) and captureWorkspaceSnapshot's intermediate null branches (logRes.code!==0, !commitId, opRes.code!==0, !operationId) are never exercised even locally.
- **Fix:** Add fake-bin (withFakeJj-style) tests for captureWorkspaceSnapshot covering: success (commit/change/op ids parsed), each null branch (log fails, empty commit_id, op fails, empty op id), and the snapshot-timeout path (script sleeps > 1500ms → result null). This mirrors the existing getJjPointer timeout test (jj-workspace.test.js:410) and makes the durability path green-on-CI without a real jj.

### [`e2e-suite`] 22 of 30 fault cases fabricate their own SQL schema and reimplement the feature in-test — they validate a mock of the contract, not the product
- **Category:** test-gap  ·  **File:** `e2e/faults/case12-rewind-reverts-vcs.test.ts:160-221; e2e/faults/case14-gateway-rpc-roundtrip.test.ts:196-485; e2e/faults/case03,case17,case24,case26,case27`  ·  **Verification:** confirmed
- **Evidence:** e2e/faults/case12-rewind-reverts-vcs.test.ts defines its own buildDb() with hand-rolled `CREATE TABLE _smithers_frames/_smithers_time_travel_audit/...` and a local `rewind()` function (lines 160-221) that issues its own DELETE/UPDATE SQL, then asserts the local function works — it never calls the real packages/time-travel jumpToFrame/rewindAudit. Same pattern in case03 (submitApprovalDecision/supervisorTakeover), case14 (full fake gateway: startGateway/handleRpc/checkAuth, lines 196-485), case17 (computeSignature/isValidSignature/startWebhookServer), case24 (classifyReplaySafety/emitReplayUnsafeApproval), case26, case27 (12 in-test functions, 0 real imports). Tally: REAL=2 FABRICATED=22 EMPTY=6 across e2e/faults/case*.ts. These tests pass independently of whether the real engine/gateway/time-travel code is correct or even present.
- **Fix:** Rewrite the fabricated cases to use the real APIs the way case25 and the package-level e2e tests already do: createSmithers/SmithersDb + ensureSmithersTables for storage, real Gateway from @smithers-orchestrator/server/gateway over the wire, real jumpToFrame/replayFromCheckpoint/captureSnapshot for time-travel. Where a real engine harness genuinely doesn't exist, delete the fabricated body rather than leave a green test that asserts a reimplementation.

### [`e2e-suite`] case14 'gateway RPC roundtrip' and case17 'webhook bad signature' skip the real path on an obsolete/false rationale that case25 disproves
- **Category:** test-gap  ·  **File:** `e2e/faults/case14-gateway-rpc-roundtrip.test.ts:853-861; e2e/faults/case17-webhook-bad-signature.test.ts:446-451; contrast e2e/faults/case25-approval-scope-denial.test.ts:11,168-187`  ·  **Verification:** confirmed
- **Evidence:** case14 line 853-861 and case17 line 446-451 both .skip the real-engine sub-test claiming 'booting the real Gateway from packages/server inside the e2e package fails on effect / @smithers-orchestrator/devtools resolution because workspace symlinks bypass e2e flat node_modules'. But case25-approval-scope-denial.test.ts:11 imports `{ Gateway } from "@smithers-orchestrator/server/gateway"`, calls `new Gateway(...)` and `gateway.listen({ port: 0 })` (lines 168-187), and its real-gateway tests run (not skipped) in the same e2e package. So the real gateway DOES boot; case14/17 instead hand-roll an entire fake WebSocketServer/HTTP gateway and assert against it.
- **Fix:** Delete the fake gateway/webhook harnesses in case14/case17 and drive the real Gateway (and real handleWebhook/computeWebhookSignature from packages/server) over the wire exactly as case25 does. Remove the false skip comments.

### [`ci-gating`] Flagship package smithers-orchestrator has no `test` script — its unit tests never run in CI
- **Category:** test-gap  ·  **File:** `packages/smithers/package.json:1`  ·  **Verification:** confirmed
- **Evidence:** packages/smithers/package.json scripts = {typecheck, build} only — NO `test` key. Yet packages/smithers/tests/ contains tools-unit.test.js, create-unit.test.js, define-tool-durability.test.js, exit-listener-leak-unit.test.js (plus src/__type-tests__/task-fork-jsx.test.tsx). CI's only test gate is the root `pnpm test` = `... && pnpm -r test`; `pnpm -r test` silently skips any workspace package lacking a `test` script (pnpm default). CI never runs a top-level `bun test`. So these 4+ unit tests for the primary published package (`smithers-orchestrator`, the `.` export of the monorepo) execute on zero PRs.
- **Fix:** Add `"test": "bun test tests"` to packages/smithers/package.json so `pnpm -r test` picks it up. Then verify the suite is green and consider failing CI when a workspace package with test files has no test script.

---

## P1 — high priority (94)

### Bugs (21)
- **[`packages/errors`]** Committed generated index.d.ts is stale — public KnownSmithersErrorCode/SmithersErrorCode types are missing 6 real error codes — `packages/errors/src/index.d.ts (declare namespace smithersErrorDefinitions, lines 161-747)`
  - *Fix:* Regenerate index.d.ts (pnpm -C packages/errors build) and commit, or add a CI check that fails when the committed d.ts diverges from the source catalog. Consider not committing the generated d.ts at all if a per-file declaration strategy can be used.
- **[`packages/errors`]** tsup bundled-declaration generation silently drops error codes; published types diverge from runtime catalog with no CI guard — `packages/errors/tsup.config.ts (dts.only) + scripts/check-docs.mjs`
- **[`packages/server`]** runs.rerun uses backend-specific raw SQL with a hardcoded `payload` column — `packages/server/src/gateway.js:4542-4546`
  - *Fix:* Replace the raw `SELECT payload FROM input` with the existing `loadInput(db, inputTable, runId)` helper (resolve the input table via resolved.workflow.inputTable / drizzleSchema.input) so rerun works on custom input schemas and non-SQLite backends, then reconstruct the rerun input from the loaded row.
- **[`packages/graph`]** Published TaskDescriptor type is missing forkSource (type drift the build does not catch) — `packages/graph/src/index.d.ts:124-172 (vs packages/graph/src/types.ts:153-154)`
  - *Fix:* Fix the dts pipeline so forkSource (and the full types.ts TaskDescriptor) is emitted into index.d.ts, and add a CI/type test (e.g. a .ts assertion importing TaskDescriptor and reading forkSource) that fails when published types drift from types.ts. Any TS consumer reading forkSource is currently broken.
- **[`packages/openapi`]** additionalProperties as a SchemaObject/RefObject is silently dropped (typed extra props not validated) — `packages/openapi/src/jsonSchemaToZod.js:142-147`
  - *Fix:* Handle additionalProperties when it is a SchemaObject/RefObject by adding `obj.catchall(jsonSchemaToZod(s.additionalProperties, spec, visited))`, and treat `false` explicitly (strict object). Add tests for true/false/schema-object cases.
- **[`packages/openapi`]** enum is ignored for numbers/integers and for typeless schemas — `packages/openapi/src/jsonSchemaToZod.js:91-94,115-124,78-80`
  - *Fix:* Promote enum handling above the type switch (build z.enum / z.literal-union for any enum regardless of declared type), or at minimum honor numeric enums in buildNumber and typeless enums in the fallback. Add tests.
- **[`packages/devtools`]** smithers tree --watch crashes on first delta: CLI passes DevToolsNode to applyDelta (needs DevToolsSnapshotV1) — `apps/cli/src/tree.js:240-241 (root cause: packages/devtools/src/applyDelta.js:49-62 contract)`
  - *Fix:* Fix the CLI call to `applyDelta(snapshot, event.delta)` and assign the returned snapshot (it already returns a full DevToolsSnapshotV1). Add a runTreeWatch test that drives at least one delta event end-to-end. Consider enabling checkJs in apps/cli, and/or hardening applyDelta to throw a clearer InvalidDeltaError when the first arg lacks `seq`/`root` so misuse fails loudly with an actionable message.
- **[`packages/gateway-client`]** streamRunEventsResilient replay detection reads frame.payload.event, but real gap_resync frames have no payload.event — `packages/gateway-client/src/SmithersGatewayClient.ts:383`
  - *Fix:* Detect replay via the outer frame field: `frame.event === "run.gap_resync"`. Update the test fixture's sendGapResync to mirror the real server payload (no payload.event; fromSeq/toSeq instead) so the test actually guards the production shape.
- **[`packages/pi-plugin`]** Approval detection ignores state-string normalization, so /smithers-approve and the active-run prompt miss waiting nodes — `packages/pi-plugin/src/extension.ts:225-240,500-502 and packages/pi-plugin/src/buildSmithersPiSystemPrompt.ts:106-111`
  - *Fix:* Reuse the same normalizeState helper (currently private to DevToolsStore/RunTree) for collectNodeStates and the approval/prompt filters so the extension agrees with the inspector on what 'waiting for approval' means; treat `blocked` as waiting-approval too.
- **[`packages/pi-plugin`]** RunInspector subscribes to the store but never unsubscribes; dispose() is dead code — `packages/pi-plugin/src/views/RunInspector.ts:64,164-166`
  - *Fix:* Store the unsubscribe handle and call it from dispose()/onClose; invoke dispose() (or at least unsubscribe) when the custom UI closes. Decide whether closing the inspector should also disconnect the stream or leave it for status-bar polling, and make that consistent.
- **[`packages/sandbox`]** Deep subpath imports resolve types to index.d.ts and break for strict TS consumers (TS2305/TS2459) — `packages/sandbox/package.json:13-17 (exports "./*" types -> ./src/index.d.ts); packages/sandbox/src/sandboxPath.js; packages/sandbox/src/effect/sandbox-entity.js`
  - *Fix:* Either generate per-subpath .d.ts (e.g. emit declarations alongside each .js and point exports "./sandboxPath", "./effect/*" at their own types), or re-export the deep-subpath symbols from src/index.js so they land in the bundled index.d.ts. Add a .ts smoke import in a test to lock the published type surface.
- **[`packages/scorers`]** context and groundTruth never reach scorers in real execution — faithfulnessScorer is silently broken on live/batch runs — `packages/scorers/src/run-scorers.js:65-71; packages/scorers/src/types.ts:108-117; packages/engine/src/engine.js:4202-4211`
  - *Fix:* Add `context?` and `groundTruth?` to ScorerContext, forward them in runSingleScorerEffect's scorer.score() call, and plumb them from the engine task descriptor. Add an e2e test through runScorersBatch (not direct scorer.score()) asserting context reaches faithfulnessScorer.
- **[`packages/accounts`]** Parser does not enforce the documented "configDir XOR apiKey, never both" invariant — secrets can leak into subscription records — `packages/accounts/src/parseAccountsFile.js:77-92`
  - *Fix:* In parseAccountsFile and addAccount, reject (or strip) the non-applicable field: a subscription provider must not carry apiKey, an API provider must not carry configDir. Add tests for both cross-contamination cases.
- **[`packages/accounts`]** agents.ts codegen also fails the configDir-XOR-apiKey invariant, propagating a stray API key into spawned agents — `apps/cli/src/agent-detection.js:666-667`
- **[`packages/react-reconciler`]** fiberToNode in SmithersDevTools only descends one level through non-Smithers fibers, dropping deeply-wrapped nodes — `packages/react-reconciler/src/devtools/SmithersDevTools.js:137-152`
  - *Fix:* Replace the hand-rolled one-level grandchild fallback with a recursive descent that, when a fiber has no nodeType, collects Smithers descendants at any depth (e.g. a helper that walks child.child recursively, or reuse traverseFiber). Add a devtools test that wraps a Task in two plain React components and asserts it still appears in the tree.
- **[`packages/vcs`]** Bare require() inside an ESM module breaks workspaceAdd pre-create cleanup under Node (inconsistent with resolveJjBinary's createRequire) — `packages/vcs/src/jj.js:197-211`
  - *Fix:* Either import fs/path statically at top of jj.js (preferred; they're node builtins) or add `const require = createRequire(import.meta.url)` as resolveJjBinary.js already does. Add a fake-bin test asserting a stale target dir is removed and a missing parent dir is created before `jj workspace add` runs.
- **[`apps/cli`]** `snapshots --json` and `timeline --json` emit unparseable stdout (dead command-level json option + framework CTA injection) — `apps/cli/src/index.js:4969-4994 (snapshots), 5672-5716 (timeline); contract test apps/cli/tests/json-stdout-contract.test.js:151-160`
  - *Fix:* Route snapshots/timeline through the same `--json`→`-j` rewrite + json-mode detection used for tree/diff/output/rewind (add them to DEVTOOLS_COMMANDS/argvRequestsJsonMode or give them a `-j` alias), and add them to json-stdout-contract.test.js so every command advertising JSON is asserted to emit a single parseable document.
- **[`apps/cli`]** `smithers cron` scheduler spawns `bun run src/index.js` which does not exist in user projects — `apps/cli/src/scheduler.js:30-37`
  - *Fix:* Resolve the CLI entry via `fileURLToPath(new URL("./index.js", import.meta.url))` (matching resume-detached.js) and set cwd to the workflow's directory; add a unit/e2e test that asserts the spawned argv/entry path.
- **[`apps/review`]** CLI --publish defaults to the non-functional review.smithers.sh domain — `apps/review/src/cli/publishWalkthrough.ts:5`
  - *Fix:* Default DEFAULT_PUBLISH_URL to https://review.jjhub.tech (the live host) until the smithers.sh domain is provisioned, matching action/action.yml and runAction.ts which already default to jjhub.tech.
- **[`packages/control-plane`]** checkUsageLimit ignores `period` — a 'daily' limit sums all-time usage (quota math is window-blind) — `src/index.js:852`
  - *Fix:* Either (a) derive [sinceMs,untilMs] from `period` (daily = start-of-day, monthly = start-of-month relative to now/untilMs) so the quota window matches the declared period, or (b) if period is intentionally opaque and the caller MUST pass sinceMs/untilMs, document that loudly in index.d.ts + control-plane.mdx and add a test proving daily vs monthly require different caller windows. Today the field is a silent footgun.
- **[`examples`]** Hallucinated / nonexistent model ID 'claude-sonnet-4-7' in ralph-loop.jsx — `examples/ralph-loop.jsx:9`
  - *Fix:* Change to `claude-sonnet-4-6` (or `claude-opus-4-8`). Separately, consider narrowing the `model` option type or adding a runtime model-ID validation/allowlist so hallucinated IDs are caught by tsc or at construction rather than failing only when the agent actually runs.

### Missing / stubbed features (9)
- **[`packages/engine`]** AlertRuntime is a no-op stub; alertPolicy.rules are never evaluated and no alert is ever inserted — `packages/engine/src/alert-runtime.js:7-22; wired at packages/engine/src/engine.js:5488-5514 and 6059-6088`
  - *Fix:* Implement AlertRuntime (subscribe to the eventBus, evaluate policy.rules, insertAlert / createHumanRequest / requestCancel per rule action) with unit tests for each rule outcome, or remove the alertPolicy surface if unsupported. The pauseScheduler service is also stubbed to () => {} at the engine call site, reinforcing that the feature is incomplete.
- **[`packages/memory`]** TokenLimiter and Summarizer are no-op placeholders shipped as working public API and documented as functional — `packages/memory/src/TokenLimiter.js:15-23 and packages/memory/src/Summarizer.js:8-26`
  - *Fix:* Either implement thread-scoped trimming/summarization (the processors receive a store but the code admits it needs a thread context they never get), or mark them clearly as unimplemented and fix docs/concepts/memory.mdx + the llms bundles to stop claiming they trim/compress. Drop the unused `_agent`/`charBudget` until implemented.
- **[`packages/openapi`]** Non-JSON request bodies (multipart/form-data, x-www-form-urlencoded) are silently dropped — `packages/openapi/src/buildOperationSchema.js:44-58, packages/openapi/src/tool-factory/_helpers.js:120-125`
  - *Fix:* Either support common alternate content types or, at minimum, detect a body with no application/json content and surface a clear error/warning. Document the JSON-only limitation. Add a test fixture with multipart content.
- **[`adapters-e2e`]** AmpAgent cannot resume a session — it is the only CLI adapter that never wires resumeSession into buildCommand — `packages/agents/src/AmpAgent.js:196-240, packages/agents/src/AmpAgentOptions.ts`
  - *Fix:* Either (a) implement Amp resume: add `threadId`/`resumeSession` handling that emits `amp threads continue <id>` (per the manifest's documented subcommand) and gate `--archive` so resumed threads aren't archived, plus add an amp-support resume test; or (b) explicitly document Amp as resume-unsupported in the capability registry (currently it advertises no resume-specific capability) so callers don't expect the emitted `resume` id to be usable.
- **[`missing-features`]** Memory processors TokenLimiter and Summarizer are documented features but ship as no-op placeholders — `packages/memory/src/TokenLimiter.js:15-22 and packages/memory/src/Summarizer.js:13-19`
  - *Fix:* Either implement thread-scoped trimming/summarization (the store API the GC uses suggests the plumbing exists), or remove the exports and the docs/concepts/memory.mdx claims until implemented. Shipping a documented `TokenLimiter`/`Summarizer` that silently does nothing is worse than not shipping it.
- **[`missing-features`]** `smithers gui` launches a native app (com.smithers.SmithersGUI) that is not built or shipped from this repo — `apps/cli/src/index.js:5721-5748 (and docs/cli/overview.mdx:319-324)`
  - *Fix:* Either hide/remove `smithers gui` until the native app ships, or make it degrade loudly (detect the bundle is absent and point the user at `smithers ui`, which is the working browser-based equivalent). At minimum document that it requires a separately-installed app.
- **[`missing-features`]** Default semantic MCP surface omits the flagship time-travel / durability controls, forcing agents to the CLI — `apps/cli/src/mcp/semantic-tools.js (toolSurface default 'semantic', apps/cli/src/index.js:5282)`
  - *Fix:* Add semantic MCP tools for the time-travel set (at least fork, rewind, replay, timeline) plus deliver_signal, cancel_run, and retry_task — or default new MCP registrations to the 'both' surface so the raw CLI-derived tools are available alongside the curated ones.
- **[`missing-features`]** `smithers .` / `smithers <dir>` shortcut silently no-ops because it routes to the unbuilt `gui` command — ``
- **[`packages/gateway`]** 10 live runtime RPC methods are absent from the canonical GATEWAY_RPC_DEFINITIONS contract (real drift, opposite of the prompt's premise) — `packages/gateway/src/rpc/index.ts:397-707`
  - *Fix:* Either promote these into GATEWAY_RPC_DEFINITIONS (schema + errors + docs page + OpenAPI path) so the contract is complete, or, for the ones that are intentionally internal, register the legacy spellings (workflows.list, approvals.list) in GATEWAY_RPC_LEGACY_METHOD_ALIASES and explicitly document the rest as out-of-contract. The canonical contract claiming to be the single source of truth while the runtime serves 10 uncontracted methods is the actual documented-drift this audit was looking for.

### Architecture (5)
- **[`packages/protocol`]** Quadruple-defined error contract with no drift guard between the runtime (.js) and type (.ts) copies — `packages/protocol/src/errors/index.js (runtime arrays) vs src/errors.ts (second runtime+type copy) vs src/errors/*.ts (type unions) vs src/index.d.ts (generated)`
  - *Fix:* Collapse to one source of truth: define the arrays once in errors/index.js with JSDoc `@type {const}` and derive the unions via typedef (as the JSDoc already attempts), delete errors.ts, OR add a parity test that imports both errors.ts and errors/index.js and asserts deep-equality for all four arrays so drift fails CI.
- **[`architecture-deps`]** dependency-boundary check scans ZERO files for the e2e workspace (directWorkspaceDirs entry is effectively dead) — `scripts/check-dependency-boundaries.mjs:101 (filesForPackage)`
  - *Fix:* Make filesForPackage scan the actual source roots for e2e (e.g. faults/budgets/exports/harness, or fall back to the package root excluding ignoredDirs) so the e2e suite's imports are actually validated.
- **[`systemic-synthesis`]** checkJs is off in all 27 packages: 831 .js source files (503 with JSDoc types) ship unverified types — ``
  - *Fix:* Set `checkJs: true` repo-wide (add it to the shared compiler-options base that every package tsconfig should `extends` — note none currently extend a base, which is a related smell). Roll out package-by-package, fixing the JSDoc/implementation mismatches that surface, then gate it in CI via the existing `pnpm -r typecheck`. This converts 503 JSDoc-annotated .js files from 'documentation that silently lies' into checked types, and is the single highest-leverage type-safety policy fix for the published surface.
- **[`systemic-synthesis`]** 28 packages commit a generated bundled src/index.d.ts that ships as exports `types` and can drift; drift guard exists only at publish, not in CI — ``
  - *Fix:* Pick one policy and enforce it in CI, not just at release: either (a) gitignore the generated `src/*.d.ts`, generate them at build/prepack, and stop committing them; or (b) keep them committed but add the publish.mjs drift guard to CI — a job that runs `pnpm -r build` and `git diff --exit-code` so a PR with a stale committed d.ts goes red. Today stale d.ts can merge to main between releases and only the release operator catches it (and 0.24.0 proves even that can slip).
- **[`systemic-synthesis`]** Published @smithers-orchestrator/observability lives under apps/ and forms a publish cycle with agents (depended on by 14 published packages) — ``
  - *Fix:* Move observability to packages/observability so its location matches its shipped status, and break the cycle: extract the small agents-side helpers observability needs (extractTextFromJsonValue, normalizeTokenUsage) into a leaf package (or into observability itself) so the agents->observability edge is one-directional. This removes the only published cross-package import cycle and aligns the published surface with the packages/ convention used by every other shipped module.

### Dead code (8)
- **[`packages/engine`]** Obsolete ~1759-line legacy engine body (runWorkflowBodyLegacy) is unreachable in production — `packages/engine/src/engine.js:5829-7587 (runWorkflowBodyLegacy); gate at 4624-4630`
  - *Fix:* Delete runWorkflowBodyLegacy, the __smithersEngineMode/SMITHERS_LEGACY_ENGINE gate, and the three legacy-only tests (engine-legacy-mode.test.jsx and the legacy variants in parallel-loop-advancement/aspects-budget). Keep legacyExecuteTask. This removes ~1759 lines of obsolete code per the completed migration plan.
- **[`packages/db`]** Entire in-memory storage module (storage/) is dead code — ``
  - *Fix:* Delete the storage/ module, or wire it up if an in-memory backend is intended (e.g. for tests). As-is it is a 600+ line maintenance liability that drifts from the real adapter (see the answerHumanRequest arg-order bug below).
- **[`packages/db`]** Parallel duplicate implementations: output/, frame-codec/, internal-schema/index.js, loadInputEffect.js, loadOutputsEffect.js — ``
  - *Fix:* Remove the duplicate directory/standalone files (keep only the per-table internal-schema/*.js files that internal-schema.js / schema-migrations.js actually re-export: smithersScorers, smithersMemory*, smithersWorkspaceStates, smithersWorkspaceCheckpoints, smithersSchemaMigrations). Consolidate on the single canonical file per module to eliminate drift.
- **[`packages/time-travel`]** VCS-tag write path (tagSnapshotVcs) is orphaned — the whole vcs-version read feature no-ops in production — `packages/time-travel/src/vcs-version/tagSnapshotVcsEffect.js:18; src/vcs-version/loadVcsTagEffect.js; src/vcs-version/rerunAtRevisionEffect.js`
  - *Fix:* Either wire tagSnapshotVcs into the engine's frame-commit/snapshot path so _smithers_vcs_tags is populated (making restore-vcs functional), or remove the vcs-version write/read module and the CLI --restore-vcs flag as an unfinished feature. Do not ship a flag that is structurally a no-op.
- **[`packages/smithers`]** Entire src/ide/ subtree is orphaned dead code (zero importers, zero tests, no docs) — `packages/smithers/src/ide/SmithersIdeService.js (433 lines), packages/smithers/src/ide/tools.js (95 lines), packages/smithers/src/ide/index.js, and 13 SmithersIde*.ts type files`
  - *Fix:* Either wire src/ide/ into a real consumer (the desktop smithers-ctl MCP server it was clearly built for) and add unit tests + a docs entry, or delete the subtree. As-is it is ~500 lines of untested, unreachable surface that the ./* export silently publishes.
- **[`packages/graph`]** Two divergent extractors with a colliding name; legacy src/dom/extract.js is dead in product but still tested — `packages/graph/src/dom/extract.js (whole file; see TODO at lines 17-25)`
  - *Fix:* Either delete src/dom/extract.js and its dependents (utils/tree-ids.js — see separate finding) and repoint the two tests at the production extractGraph, or finish the migration in the TODO. Same-named, divergent extractFromHost across two import paths is a real footgun; the 'roundtrip' tests give false confidence about the production pipeline.
- **[`packages/accounts`]** Public export `accountToProviderEnv` is dead code with false JSDoc; logic duplicated in 3 places — `packages/accounts/src/accountToProviderEnv.js:1-48`
  - *Fix:* Either delete accountToProviderEnv (and trim its docs-table mention), or make it the single source of truth and have the agent adapters + usage adapters import it. At minimum fix the false JSDoc claiming it is used by buildCommand/`agent test`.
- **[`apps/observability`]** Entire in-memory MetricsService in _coreMetrics.js is dead code (only the Tag is used) — `apps/observability/src/_coreMetrics.js:85-510`
  - *Fix:* Strip _coreMetrics.js down to just the MetricsService Tag class (and the shape typedefs). Move the Tag to its own file (e.g. MetricsService.js) and delete the dead in-memory service, duplicate catalog, and the empty `import {}` in metricsServiceAdapter.js. This removes ~400 lines and eliminates a divergent second metrics implementation.

### Test coverage gaps (40)
- **[`packages/engine`]** AgentTraceCollector (716 lines, ~28 methods) has a single direct unit test; persistence/error/lifecycle paths untested — `packages/engine/src/AgentTraceCollector.js:55-716; only test packages/engine/tests/agent-trace-collector-structured.test.js (1 test case)`
  - *Fix:* Add a focused unit suite for AgentTraceCollector covering NDJSON persist/rewrite (with a temp logDir), provider session file resolution + transcript import, observeError/observeResult, completeness resolution, and the begin/endListener subscription lifecycle.
- **[`packages/db`]** rawQuery's read-only SQL guard (validateReadOnlyRawQuery) has zero tests anywhere in the repo — ``
  - *Fix:* Add unit tests for validateReadOnlyRawQuery covering: empty/whitespace query, comment-only query, forbidden keyword in each form (incl. keyword hidden in a string literal that should be allowed after stripping), multi-statement rejection, allowed prefixes (select/with/explain/values), and a happy-path rawQuery round-trip against an in-memory DB.
- **[`packages/db`]** SmithersDb adapter's Postgres dialect branches are never tested — ``
  - *Fix:* Add a PGlite-backed SmithersDb test (mirroring db-postgres-dialect.test.js's setup) that exercises claimRunForResume/updateClaimedRun/deleteOutputRow/getRawNodeOutput/hasPhysicalTable through the adapter, asserting the RETURNING/IS NOT DISTINCT FROM/information_schema paths.
- **[`packages/db`]** Multiple production-reachable adapter methods have zero tests repo-wide — ``
  - *Fix:* Add in-package adapter tests for these. deleteOutputRow especially needs coverage: its SQLite branch (adapter.js:1192-1254) has nontrivial PRAGMA-based column discovery + schema-fallback logic and snake/camel column-name resolution that is entirely unexercised.
- **[`packages/agents`]** GeminiAgent.createOutputInterpreter has zero direct tests (all event branches untested) — ``
  - *Fix:* Add a gemini-support.test.js mirroring amp-support/opencode-support: call createOutputInterpreter() directly with synthetic init/MESSAGE(delta)/TOOL_USE/TOOL_RESULT/ERROR/RESULT lines and assert AgentCliEvents; and unit-test buildCommand arg shaping for each branch.
- **[`packages/agents`]** VibeAgent interpreter/buildCommand only covered by a skipped e2e suite — ``
  - *Fix:* Add vibe-support.test.js with direct createOutputInterpreter() line-feeding (assistant role JSON lines, onExit success/failure) and buildCommand arg assertions (maxTurns/maxPrice/maxTokens/enabledTools/resume/continueSession), matching the amp/opencode pattern so coverage holds in CI.
- **[`packages/agents`]** CLI capability doctor failure branches are entirely untested — ``
  - *Fix:* Add tests passing hand-crafted malformed AgentCapabilityRegistry/surface entries through diagnoseCapabilityRegistry/diagnoseSurfaceContract (or the public report) and assert each issue code+severity.
- **[`packages/driver`]** Deferred-deps deadlock detection (DEPENDENCY_DEADLOCK) is completely untested — `packages/driver/src/WorkflowDriver.js:182-196 & 352-360 (describeDeferredDeadlock, lastDeferredDeps -> failed); packages/driver/src/SmithersCtx.js:231-235 (recordDeferredDep)`
  - *Fix:* Add a test where the workflow build() calls ctx.recordDeferredDep(...) and the fake session returns Finished, asserting the run result is status:'failed' with the DEPENDENCY_DEADLOCK message listing the never-run node. Also cover the empty-waitingOn vs non-empty-waitingOn message branches in describeDeferredDeadlock.
- **[`packages/memory`]** Error paths untested for 9 of 11 store operations — `packages/memory/tests/store.test.js:85-103`
  - *Fix:* Add failure-injection tests (throwing fake db like the existing ones) for each remaining op, asserting the correct code/label. Consider wrapping deleteThread's two deletes in a transaction and testing partial-failure behavior.
- **[`packages/server`]** Several gateway RPC methods are untested (runs.rerun, signals.send/submitSignal, cronRun/cron.trigger, hijackRun) — `packages/server/src/gateway.js:4288-4302 (hijackRun), 4495-4519 (signals.send), 4533-4557 (runs.rerun), 4609-4638 (cronRun)`
  - *Fix:* Add routeRequest-level tests for signals.send/submitSignal (correlationKey aliasing + resume), cron.trigger/cronRun (manual trigger updates cron run time and starts a run), hijackRun (returns sessionId for a real run, RunNotFound otherwise), and runs.rerun (after fixing the SQL bug) against the real Gateway+SQLite stack already used elsewhere.
- **[`packages/server`]** HTTP server (index.js) signal route and key error branches are untested — `packages/server/src/index.js:1115-1138 (signals), 716 (RUN_ID_REQUIRED), 724-726 (RUN_ALREADY_EXISTS 409), 721-723 (resume fresh-heartbeat), 871-910 (waiting-timer cancel), 673 (/metrics)`
  - *Fix:* Extend server.test.js with cases for the signal route (happy path + 404 unknown run), duplicate-run 409, resume-without-runId 400, resume-of-fresh-run short circuit, waiting-timer cancel (asserting TimerCancelled event + cancelled attempt), and GET /metrics returning Prometheus text.
- **[`packages/graph`]** JS logic files are not type-checked (checkJs off) — JSDoc types are decorative only — `packages/graph/tsconfig.json:25 (allowJs:true, no checkJs)`
  - *Fix:* Enable checkJs in packages/graph (and ideally repo-wide for .js logic packages) so JSDoc types are actually validated; fix the resulting errors. This is the structural guard that would have caught the forkSource bug.
- **[`packages/openapi`]** Path-level parameters and mergeParameters precedence are entirely untested — `packages/openapi/src/extractOperations.js:24,31-32, packages/openapi/src/_specHelpers.js:45-49`
  - *Fix:* Add a fixture with path-level parameters (including a $ref parameter and a name+in collision with an operation-level param) and assert the merged/deduped result.
- **[`packages/gateway-react`]** Exported hooks useGatewayMutation and useGatewayRunStream have zero tests — `packages/gateway-react/src/sync/useGatewayMutation.ts; packages/gateway-react/src/sync/useGatewayRunStream.ts`
  - *Fix:* Add direct tests: useGatewayRunStream subscribing a real fake-transport stream for a given runId and the runId=undefined disabled case; useGatewayMutation firing a method through the registry and surfacing success.
- **[`packages/gateway-react`]** useGatewayExtensionStream reconnect path and error surfacing are untested — `packages/gateway-react/tests/extension-hooks.test.ts:160-227; packages/gateway-react/src/useGatewayExtensionStream.ts:83-95`
  - *Fix:* Add a test where the fake streamExtension throws once (transient drop) then yields frames on the retry: assert error is surfaced on drop, then cleared and frames flow after reconnect; plus a test that `enabled:false`/undefined namespace yields streaming=false and no subscription.
- **[`packages/gateway-client`]** createSmithersGatewayTransport.stream's streamRunEvents branch is entirely untested — `packages/gateway-client/src/sync/createSmithersGatewayTransport.ts:44-71`
  - *Fix:* Add tests for the streamRunEvents scope (asserting runId validation, afterSeq passthrough, and seq extraction from both payload.seq and outer seq), the rpc() passthrough, and the unknown-scope error.
- **[`packages/gateway-client`]** gatewayCollectionDefs is largely untested (27% lines) — most collection defs and frame mappers have no coverage — `packages/gateway-client/src/sync/gatewayCollectionDefs.ts:45-152`
  - *Fix:* Add unit tests for each collection def's key/method/getKey/rows wiring, eventRows seq-skip, runStatusFromFrame's branch matrix, and runRowsFromFrame merging a status onto an existing run row.
- **[`packages/usage`]** Five network probe adapters have zero unit tests despite the spec mandating fixture tests for each — `packages/usage/src/anthropicHeaderUsage.js, openaiHeaderUsage.js, claudeOauthUsage.js, codexWhamUsage.js, googleUsage.js`
  - *Fix:* Add unit tests that inject a fetch seam (or use a real local HTTP fixture server per the no-mocks rule) to exercise each adapter's 200/401/429/non-ok/throw paths and assert the resulting UsageProbe. At minimum, googleUsage and the header-error formatting (retry-after present/absent) are pure enough to test without network.
- **[`packages/usage`]** Credential readers (readClaudeCredentials, readCodexCredentials) have zero tests, including the JWT account-id fallback — `packages/usage/src/readClaudeCredentials.js:27-37, packages/usage/src/readCodexCredentials.js:31-39`
  - *Fix:* Add temp-configDir fixture tests for both readers covering present/absent/malformed credential files and the id_token JWT account-id fallback. Add a spawn/read DI seam to readClaudeCredentials so the macOS Keychain branch is testable on non-macOS CI (per spec §11).
- **[`packages/pi-plugin`]** Entire documented api/* public surface has zero direct tests — `packages/pi-plugin/src/api/approve.ts, cancel.ts, deny.ts, getFrames.ts, getStatus.ts, listRuns.ts, resume.ts, runWorkflow.ts, streamEvents.ts`
  - *Fix:* Add unit tests per wrapper that stub fetch and assert URL, method, headers (auth), and JSON body for default and supplied args (including iteration?? 0, tail?? 20, listRuns limit/status branches, runWorkflow optional runId, resume's resume:true flag).
- **[`packages/pi-plugin`]** DevToolsClient has no dedicated unit tests; many methods and error paths uncovered — `packages/pi-plugin/src/runtime/DevToolsClient.ts`
  - *Fix:* Add focused tests: pure-function tests for auditRowId/normalizeEvent/unsupportedRpc/toWsUrl; WS-fixture tests for SeqOutOfRange resync, devtools.error→throw, connect.challenge timeout; an HTTP-fixture test for rpc() non-200 and ok:false frames; and performMutation method fallback for resume().
- **[`packages/pi-plugin`]** Four view classes (RunTree, NodeInspector, Header, FrameScrubber) have no dedicated unit tests — `packages/pi-plugin/src/views/RunTree.ts, NodeInspector.ts, Header.ts, FrameScrubber.ts`
  - *Fix:* Add per-view unit tests driving handleInput() and asserting render() output (with a passthrough theme) across selection, search, tab, scrub, and heartbeat-threshold cases.
- **[`packages/pi-plugin`]** DevToolsStore: scrubTo, rewind, returnToLive, ghost budget/eviction, stale banner, and reconnect/backoff are untested — `packages/pi-plugin/src/runtime/DevToolsStore.ts`
  - *Fix:* Add deterministic unit tests for these (inject ghostNodeCap, staleBannerDelayMs, and a fake client) covering rewind guards/success, ghost eviction at cap, scrub boundary/error, baseSeq-mismatch resync, and backoff growth.
- **[`packages/sandbox`]** egress.js has zero direct unit tests; validation/error branches only hit incidentally — `packages/sandbox/src/egress.js (normalizeSandboxEgressConfig, optionalString, optionalStringRecord, normalizeNoProxy, redactSandboxEgressConfig)`
  - *Fix:* Add a dedicated egress.test.js asserting each invalidEgressConfig path (invalid object, bad env name, key/value length bounds, null bytes, noProxy non-string/array, caCertPem+caCertPath conflict) plus redactSandboxEgressConfig field-by-field and the no-egress passthrough.
- **[`apps/cli`]** Core argv-parsing functions have zero unit tests (parseMcpSurfaceArgv, findFirstPositionalIndex, rewriteBareResumeFlagArgv) — `apps/cli/src/argv-utils.js:13-73`
  - *Fix:* Add a unit test suite for argv-utils.js covering each branch: bare/`=`/missing/invalid `--surface`, BUILTIN_FLAGS_WITH_VALUES value-skipping in findFirstPositionalIndex, and rewriteBareResumeFlagArgv at end-of-argv and followed by another flag.
- **[`apps/observability`]** trackEvent (608-line event→metric router) tested only for 'does not throw' — no value/label assertions — `apps/observability/tests/effect-metrics-track.test.js:9-385`
  - *Fix:* Use the live MetricsServiceLive snapshot() (or renderPrometheus()) to assert that representative events produce the expected counter/gauge/histogram deltas and labels. At minimum cover: RunStarted/RunFinished active-run balance, TokenUsageReported tagging + bucket classification, ApprovalRequested/Granted/Denied pending balance, and the AgentEvent started/action/completed paths including error/retry detection.
- **[`apps/observability`]** Correlation module has zero test coverage despite non-trivial normalization/merge logic — `apps/observability/src/_coreCorrelation/mergeCorrelationContext.js:8-61`
  - *Fix:* Add unit tests for mergeCorrelationContext (empty-string drop, non-finite iteration/attempt drop, no-runId→undefined, base override semantics), correlationContextToLogAnnotations (empty context→undefined), and the documented in-place mutation behavior of updateCurrentCorrelationContext.
- **[`apps/observability`]** Tracing layer (withSmithersSpan / inferSmithersSpanName / annotateSmithersTrace / TracingServiceLive) is untested — `apps/observability/src/_coreTracing.js:32-142`
  - *Fix:* Add tests asserting span-name inference per branch and attribute aliasing/prefix behavior. Deduplicate the alias map: have _coreTracing.js import _smithersSpanAttributeAliases.js (or makeSmithersSpanAttributes.js) instead of inlining a second copy.
- **[`apps/review`]** GitHub PR-posting path (src/github/) has no automated test coverage — `apps/review/src/github/postPullRequestReview.ts, resolvePullRequest.ts, listPullRequestFiles.ts, runGh.ts`
  - *Fix:* Add tests injecting a fake `gh` binary (PATH shim or a runGh seam) to cover: successful post, the 422→fold-into-body fallback, the unparseable-PR-url throw, and runGh stderr propagation.
- **[`apps/review`]** Walkthrough publish/serve path (/api/walkthroughs + /w/<id>) untested in CI — `apps/review/src/server/walkthroughs/handleWalkthroughs.ts, apps/review/src/server/worker.ts:64-75`
  - *Fix:* Add a worker.fetch test posting to /api/walkthroughs with each credential type, asserting it stores into the memoryBucket and that GET /w/<id> serves the bytes back with the immutable+noindex headers (and 404 for a missing id).
- **[`smithers-ui-system`]** Declarative TanStack-DB sync hooks have no real-browser e2e; no shipped UI exercises them — `packages/gateway-react/src/sync/useSyncQuery.ts, useSyncMutation.ts, useSyncSubscription.ts, useGatewayQuery.ts, useGatewayMutation.ts, useGatewayRunStream.ts, useGatewayRunTree.ts, useGatewayConnectionStatus.ts`
  - *Fix:* Ship at least one .smithers/ui reference UI that drives useGatewayRunTree + useGatewayRunStream + useGatewayConnectionStatus (e.g. a live run-graph/inspector UI), and add it to workflow-ui-descriptors.json so the real-browser e2e exercises the TanStack-DB live-query path against a real gateway + real run.
- **[`smithers-ui-system`]** `smithers ui` CLI command (resolution, autostart, error envelopes) is completely untested — `apps/cli/src/index.js:5758-5848 (ui command), apps/cli/src/index.js:1940-1963 (autoStartGateway)`
  - *Fix:* Add a real-backend CLI test: start a Gateway with a UI-mounted workflow + a completed run, then assert `smithers ui <runId> --no-open --gateway <url>` prints the correct /workflows/<key>?runId=<id> URL and returns {opened:false,url,runId,workflow}; assert NO_UI for a workflow without a UI and NO_RUNS / GATEWAY_UNREACHABLE on the error paths.
- **[`adapters-e2e`]** HermesAgent has zero tests anywhere in the repo — `packages/agents/src/HermesAgent.js (impl), packages/agents/tests/* (no coverage)`
  - *Fix:* Add a hermes-support.test.js: (1) assert constructing HermesAgent() with no baseURL and no HERMES_BASE_URL throws AGENT_CONFIG_INVALID; (2) assert it resolves baseURL from HERMES_BASE_URL; (3) assert supportsNativeStructuredOutput defaults to false (and can be enabled). Use MockLanguageModelV3 as the other SDK agents do — no real Hermes server needed for the validation/config paths.
- **[`adapters-e2e`]** GeminiAgent has no buildCommand/interpreter behavior test despite being a fully-wired shipping adapter — `packages/agents/src/GeminiAgent.js:60-280`
  - *Fix:* Add a gemini-support.test.js mirroring forge-support/pi-support: a fake `gemini` binary that emits the JSONL event stream to assert interpreter events (started/action/completed, delta accumulation), plus direct buildCommand assertions for output-format selection, resume->--resume, and the allowedTools=[] empty-flag edge case. If Gemini is truly being retired, gate removal behind a deprecation timeline rather than shipping it untested.
- **[`e2e-suite`]** Nightly soak CI gate (120-min budget) runs effectively one fabricated-transport test; cases 29 and 30 are permanently skipped — `e2e/faults/case28-soak-live-stream-rss.test.ts:4,86,212; e2e/faults/case29-soak-cron-2h-no-stuck.test.ts:7; e2e/faults/case30-soak-jjhub-long-lived.test.ts:7; .github/workflows/faults-nightly.yml`
  - *Fix:* Point case28's live stream at the real gateway streamRunEvents/subscriber path (the real streaming code is exercised by packages/server/tests/streamDevTools.soak.test.ts). Either implement case29/case30 against the real scheduler and jjhub runtime or remove the empty stubs and the soak CI job until they exist, so the nightly gate isn't green-on-nothing.
- **[`e2e-suite`]** Six fault cases are empty skip-only stubs — entire feature areas have zero fault/e2e coverage — `e2e/faults/case19,case20,case21,case22 (each line 5-7); e2e/faults/case02-kill-sandbox-engine-alive.test.ts:189`
  - *Fix:* Track these as explicit coverage gaps, not as 'tests'. For secret redaction and VCS pointer integrity, add real e2e even if narrower than the jjhub-runtime ideal (e.g. assert redaction on the real log stream / real vcs adapter). Skip-only stubs inflate the apparent case count (30) versus the real count (2 real + a few hybrids).
- **[`packages/tool-context`]** 31-line test hits 100% lines but misses ~8 branches/boundary cases the ~100% bar requires — `packages/tool-context/tests/tool-context.test.js:19-30`
  - *Fix:* Add cases: getToolIdempotencyKey with idempotencyKey:'' and a non-string value (assert fall-through to smithers:r:n:0), with runId+nodeId but no iteration (assert :0 default), with {nodeId:'n'} only (missing runId -> null), and called inside runWithToolContext (default-param ambient read). Add nextToolSeq with {seq:41}->42. Add runWithToolContext returns fn's value, propagates a thrown error AND leaves getToolContext() undefined afterward, and a nested-scope test (inner shadows, outer restored).
- **[`examples`]** Neither 'examples smoke test' actually exercises the examples/ tree — both only scan docs/** — `apps/cli/tests/docs-examples-smoke.test.js:155`
  - *Fix:* Add a real smoke test that globs examples/**/*.{jsx,tsx} and runs `smithers graph <file>` (render-only, no agent execution, like docs-examples-smoke does) on each, seeding a fake agent per the CI-is-agent-free constraint. At minimum, typecheck them in CI (see prior finding). This is the only way to catch the model-ID and API drift below before users hit it.
- **[`ci-gating`]** No coverage measurement or gate anywhere in CI — the ~100% bar is unenforced — `.github/workflows/ci.yml:59`
  - *Fix:* Measure coverage in the test gate (bun test --coverage with a per-package or aggregate threshold) and fail CI below a target, or at minimum upload coverage so reviewers can see deltas on PRs.
- **[`ci-gating`]** typecheck:examples never runs in CI — 22 user-facing example workflows can ship broken — `package.json:67`
  - *Fix:* Add `pnpm typecheck:examples` to ci.yml's typecheck job.

### Documentation (6)
- **[`docs-human`]** watch-and-steer.mdx documents out-of-scope product UIs (Studio 2 + PWA web app) in the For Humans guide — `docs/guide/watch-and-steer.mdx:36-78`
  - *Fix:* Remove the 'Studio: the visual console' and 'A browser and remote view' (PWA) sections from watch-and-steer.mdx. Reframe the page entirely around the CLI watch loop (ps, chat --follow, inspect --watch) and, if a visual surface is mentioned at all, only the in-scope `smithers ui` custom workflow UIs. Delete the leaked `pnpm dev:studio` internal dev instruction from human docs.
- **[`docs-human`]** watch-and-steer.mdx contradicts the docs' own 'not a GUI you click / no GUI required' thesis — `docs/guide/watch-and-steer.mdx:36-78`
  - *Fix:* Resolve by removing the Studio/PWA sections (see P0). The page's existing CLI-driven 'observe loop' and 'steering' tables are consistent with the thesis and should stand on their own.
- **[`docs-human`]** starters.mdx documents a non-existent `idea-to-prd` starter template — `docs/starters.mdx:26-30`
  - *Fix:* Either remove the `idea-to-prd` row from starters.mdx, or (if a PRD starter is intended) register an `idea-to-prd`/`write-a-prd` recipe in starter-gallery.js. Note the write-a-prd.tsx workflow and docs/images/workflow-ui/write-a-prd.png already exist, so the workflow is real but not wired as a starter.
- **[`docs-human`]** llms-full.txt, llms-core.txt, and apps/cli/docs/llms-full.txt carry the same broken `idea-to-prd` starter row — `docs/llms-full.txt:579`
- **[`docs-agent-llms`]** Stale Claude Sonnet model ID (claude-sonnet-4-5-20250929) in 7 For-Agents example pages — `docs/examples/approval-gate.mdx:41,47 (and dynamic-plan, loop, multi-agent-review, tools-agent, workflow-quickstart, claude-plugin-orchestrator)`
  - *Fix:* Replace claude-sonnet-4-5-20250929 with the current claude-sonnet-4-6 (or claude-fable-5 to match the rest of the docs) across the 7 example MDX files so example code matches the CLI scaffolder and the rest of the documentation.
- **[`examples`]** Pervasive stale model ID: deprecated claude-sonnet-4-20250514 in 93 of 97 top-level example workflows (274 occurrences) — `examples/fan-out-fan-in.jsx:41`
  - *Fix:* Bulk-update examples to current IDs (claude-sonnet-4-6 / claude-opus-4-8). Because today's date is 2026-06-16, the May-2025 snapshot has already passed its 2026-06-15 retirement — these examples now reference a model that 404s at runtime, not merely a deprecated one.

### Clean code (1)
- **[`ci-gating`]** No lint (oxlint) gate in any CI workflow — `.github/workflows/ci.yml:28`
  - *Fix:* Add a `pnpm lint` step to ci.yml's typecheck job (and `pnpm --filter ./.smithers lint`). Both are fast (oxlint), so they add negligible CI time.

### Skills (4)
- **[`skills`]** eval-writer shows faithfulnessScorer()/relevancyScorer() called with no judge argument — `skills/eval-writer/SKILL.md:78-88`
  - *Fix:* Show these scorers with a judge agent, e.g. `faithfulnessScorer(judge)` / `relevancyScorer(judge)` where judge is an agent from agents.ts, matching the real signature.
- **[`skills`]** eval-writer's llmJudge config shape is entirely wrong (model/prompt fields do not exist) — `skills/eval-writer/SKILL.md:83-84`
  - *Fix:* Replace with the actual config shape: `llmJudge({ id, name, description, judge, instructions, promptTemplate })`, or point at the canonical example in docs rather than inventing a `{ model, prompt }` shape.
- **[`skills`]** report-maker documents report-slideshow with `runId` input, but the workflow requires `targetRunId` — `skills/report-maker/SKILL.md:67`
  - *Fix:* Change the example to `--input '{"targetRunId":"<run-id>"}'` to match the workflow's actual input schema.
- **[`skills`]** eval-writer's scorer sampling config shape is wrong (kind/ratio instead of type/rate) — `skills/eval-writer/SKILL.md:84,92`

---

## P2 — cleanup backlog (325)

Grouped by area (one line each; full evidence in `audit/reconciled-findings.json`).

**`packages/engine`** (12)
- _(dead-code)_ deferred-bridge.js is entirely dead code (non-durable bridge superseded by durable variant) — `packages/engine/src/effect/deferred-bridge.js:1-64`
- _(dead-code)_ Dead exports in durable-deferred-bridge.js (Workflow + success schemas never consumed) — `packages/engine/src/effect/durable-deferred-bridge.js:19 (DurableDeferredBridgeWorkflow), 44 (approvalDurableDeferredSuccessSchema), 51 (waitForEventDurableDeferredSuccessSchema)`
- _(dead-code)_ rpc-schema.js (SmithersRpcGroup + payload/result schemas) is published but has no implementation or consumer — `packages/engine/src/effect/rpc-schema.js:1-102`
- _(test-gap)_ optimization-artifact.js has zero direct unit tests despite being on the production render path — `packages/engine/src/optimization-artifact.js:21-86 (loadOptimizationArtifact, promptPatchesFromArtifact, applyOptimizationArtifactToTasks)`
- _(test-gap)_ task-compute-fns.js (subflow/sandbox compute-fn attachment) has zero direct unit tests — `packages/engine/src/task-compute-fns.js:14-86 (attachSubflowComputeFns, attachSandboxComputeFns)`
- _(clean-code)_ EventBus.persistDb advances this.seq even when the DB assigns its own seq, leaving this.seq as misleading dead state — `packages/engine/src/events.js:126-153`
- _(bug)_ builder fragment(_inputSchema) silently discards its input schema argument — `packages/engine/src/effect/builder.js:1201-1203`
- _(dead-code)_ subscribeTaskWorkerDispatches is a published observability hook with no production consumer — `packages/engine/src/effect/single-runner.js:191-196 (re-exported via workflow-bridge.js:28 and index.js)`
- _(doc)_ Stale 'Phase 0 Seam Adapter' doc comment claims the bridge will be replaced by Activity.make() — `packages/engine/src/effect/workflow-bridge.js:29-38`
- _(clean-code)_ Dead boolean condition in extractBalancedJson (c === '"' && !escape) — escape is always false at that point — `packages/engine/src/json-extraction.js:24`
- _(clean-code)_ Confusing snapshot-handle defaults: public snapshot() hardcodes source 'watch'/tier 2 while its comment says Tier 1/wrap — `packages/engine/src/startDurability.js:125-127 (and undocumented withSocket/createSocketServer options at 77-78)`
- _(missing-feature)_ alertPolicy.reactions are never consumed anywhere (entire alert reaction pipeline unimplemented) — ``

**`packages/db`** (9)
- _(test-gap)_ Human-request adapter surface untested within packages/db — ``
- _(bug)_ answerHumanRequest argument order differs between SmithersDb and the (dead) InMemoryStorage — ``
- _(dead-code)_ dialect.js exports isDialect and tableColumnsSql are never used — ``
- _(dead-code)_ SmithersDb.buildEventHistoryWhere duplicates SqlMessageStorage logic but is SQLite-hardcoded and unused — ``
- _(clean-code)_ classifyRunRowStatus is a permanent no-op shim left in the hot path — ``
- _(test-gap)_ Input-bounds validators (assertJsonPayloadWithinBounds, assertMaxJsonDepth, assertMaxBytes, etc.) and JSON-bounds error paths are untested in-package — ``
- _(test-gap)_ Frame-codec edge/error paths (parse version mismatch, invalid path ops) untested — ``
- _(dead-code)_ react-output.js stripAutoColumns is a third copy of the same function — ``
- _(test-gap)_ Postgres branch of deleteOutputRow/upsertOutputRow/getRawNodeOutputForIteration in SmithersDb is unreachable from tests (subset detail of Postgres-coverage gap) — `packages/db/src/adapter.js`

**`packages/agents`** (7)
- _(test-gap)_ AntigravityAgent stream-json interpreter is untested and effectively dead in practice — ``
- _(dead-code)_ BaseCliAgent.stream() path is unused by the product and has no tests (buildStreamResult/emptyUsage/asyncIterableToStream) — ``
- _(test-gap)_ Observability metric emission path has no test assertions — ``
- _(adapter)_ ./BaseCliAgent subpath export declares types target missing its runtime exports — ``
- _(test-gap)_ extractTextFromJsonValue (widely-used recursive util) has a single test case — ``
- _(test-gap)_ createMcpToolset include filter and callMcpTool error/structured-content branches untested — ``
- _(test-gap)_ HermesAgent (public export) has no dedicated tests — ``

**`packages/components`** (11)
- _(dead-code)_ Aspects accumulator + tracking config are render-time plumbing that the engine discards (dead data path) — `packages/components/src/aspects/AspectContext.js:22 (createAccumulator), packages/components/src/components/Aspects.js:27-37, packages/components/src/components/Task.js:300-309 (buildAspectMeta)`
- _(dead-code)_ aspects/index.js barrel is exported but imported by nothing — `packages/components/src/aspects/index.js:9`
- _(bug)_ SuperSmithers collides all 4 task outputs onto one key when reportOutput is provided — `packages/components/src/components/SuperSmithers.js:48,57,72,84`
- _(missing-feature)_ SuperSmithers 'apply' task is a no-op stub that returns a literal and writes nothing — `packages/components/src/components/SuperSmithers.js:74-91`
- _(clean-code)_ Inconsistent host-prop sanitization across structural components — `packages/components/src/components/Branch.js:11, Sequence.js:8, Ralph.js:13, Workflow.js:9 vs Parallel.js:11-16, MergeQueue.js:11-16`
- _(test-gap)_ Poller onTimeout='fail' runtime path (loop exhausts, run fails) is not e2e tested — `packages/components/src/components/Poller.js:54,60-62; tests/poller-component.test.jsx`
- _(test-gap)_ EscalationChain: default humanRequest fallback and error/failed branches of defaultEscalateIf are untested — `packages/components/src/components/EscalationChain.js:18-29 (defaultEscalateIf), :120-124 (default humanRequest)`
- _(test-gap)_ markdown table/thead/tbody components have no exact-output assertions — `packages/components/src/markdownComponents.js:35-37; tests/markdown-components.test.jsx:94-104`
- _(test-gap)_ Reconciler/driver/devtools tests are co-located in components but exercise a different package — `packages/components/tests/driver.test.js:3, tests/reconciler.test.js:3, tests/devtools.test.js:14-16`
- _(clean-code)_ tsconfig outDir/declaration cruft conflicts with tsup build target — `packages/components/tsconfig.json:18-20 vs tsup.config.ts:5-6`
- _(doc)_ SuperSmithers JSDoc contradicts its own apply implementation about what writes files — `packages/components/src/components/SuperSmithers.js:18 vs 77-80`

**`packages/time-travel`** (11)
- _(dead-code)_ resolveWorkflowAtRevision has no production or internal consumer — `packages/time-travel/src/vcs-version/resolveWorkflowAtRevisionEffect.js:17; src/vcs-version/index.js:47`
- _(test-gap)_ vcs-version success paths are untested (only the null/no-tag branches are exercised) — `packages/time-travel/tests/vcs-version.test.js:13-52`
- _(test-gap)_ revertToAttempt success + frame-cleanup path is not asserted — `packages/time-travel/src/revert.js:50-67; tests/revert.test.js:69-103`
- _(test-gap)_ timeTravel restoreVcs success path is jj-gated and weakly asserted — `packages/time-travel/tests/timetravel.e2e.test.jsx:107-114; src/timetravel.js:139-166`
- _(clean-code)_ JUMP_RUN_ID_PATTERN / JUMP_MAX_FRAME_NO exported from subpath but absent from main barrel and index.d.ts — `packages/time-travel/src/jumpToFrame.js:21-22; src/index.js:46; src/index.d.ts`
- _(bug)_ diffSnapshots ignores outputTable changes in node-change detection — `packages/time-travel/src/diff.js:39-42`
- _(test-gap)_ recoverInProgressRewindAudits updateRun fallback branches are untested — `packages/time-travel/src/recoverInProgressRewindAudits.js:52-68`
- _(test-gap)_ Rate-limit and audit-write helpers have no direct unit tests — `packages/time-travel/src/evaluateRewindRateLimit.js; src/updateRewindAuditRow.js; src/countRecentRewindAuditRows.js`
- _(test-gap)_ expandResetSet exact-key fallback branch is uncovered — `packages/time-travel/src/fork/_helpers.js:19-27`
- _(dead-code)_ formatDiffAsJson is an identity-spread export with no production caller — `packages/time-travel/src/diff.js:206-208`
- _(clean-code)_ rerunAtRevision/replayFromCheckpoint error surface (vcsError) is captured but never shown to the user in the CLI — `packages/time-travel/src/replayFromCheckpointEffect.js:38; apps/cli/src/index.js:5373-5376`

**`packages/smithers`** (7)
- _(test-gap)_ createSmithersPostgres and findFreePgPort have no test coverage inside packages/smithers — `packages/smithers/src/create.js:481-580`
- _(test-gap)_ bin/smithers.js local-CLI delegation logic is untested in this package — `packages/smithers/src/bin/smithers.js:1-160`
- _(test-gap)_ Several create.js branches uncovered: anchor-based default dbPath, journalMode option, input ALTER catch — `packages/smithers/src/create.js:372-374, 392, 427-436`
- _(test-gap)_ findSmithersAnchorDir fsRoot guard and HOME-unset branch only covered indirectly — `packages/smithers/src/findSmithersAnchorDir.js:18-31`
- _(doc)_ Stale/misleading JSDoc on the create.js Task wrapper — `packages/smithers/src/create.js:251-260`
- _(clean-code)_ prepareOutputSchemas duplicated and divergent between create.js and external/create-external-smithers.js — `packages/smithers/src/create.js:60-89 and packages/smithers/src/external/create-external-smithers.js:70-93`
- _(test-gap)_ Public mdxPlugin (and createExternalSmithers) lack package-level coverage / in-repo consumers — `packages/smithers/src/mdx-plugin.js:1-6, packages/smithers/src/external/index.js`

**`packages/scheduler`** (13)
- _(test-gap)_ 11 of 19 WorkflowSessionService methods have zero unit tests — ``
- _(test-gap)_ decide() ralph-advancement, ContinueAsNew, RALPH_MAX, and budget branches are untested — ``
- _(dead-code)_ Scheduler/WorkflowSession Effect Tags and SchedulerLive are dead provisioning (never consumed) — ``
- _(dead-code)_ ~9 session methods are dead in production; the package ships a much larger API than is used — ``
- _(clean-code)_ eventReceived and signalReceived are near-duplicate ~24-line handlers — ``
- _(test-gap)_ Scheduler unit tests exercise a configuration the engine never uses — ``
- _(test-gap)_ DEPENDENCY_DEADLOCK / describeDeadlock diagnostic has no scheduler-level test — ``
- _(clean-code)_ Approval 'continue' path stores resolution as output without usage; cache/output shape inconsistency — ``
- _(clean-code)_ decide() depth>10 guard silently swallows the decision into a Wait — ``
- _(architecture)_ index.d.ts is a committed generated artifact serving as the type entry for ALL subpath exports — ``
- _(doc)_ inspect()/decide() JSDoc signatures omit the options/depth parameters — ``
- _(bug)_ WorkflowSessionLive builds a single shared session — a latent correctness bug if ever consumed — ``
- _(clean-code)_ signalReceived is byte-for-byte duplicate of eventReceived except the dead __signalName lookup — ``

**`packages/driver`** (7)
- _(test-gap)_ #267 out-of-order completion concurrency machinery has zero tests anywhere — `packages/driver/src/WorkflowDriver.js:449-573 (executeTasks, startInflightTask, nextCompletionDecision, drainInflight)`
- _(test-gap)_ WorkflowDriver run-loop branches (Wait/ReRender/ContinueAsNew/Failed, abort, cancelRun, renderAndSubmit) have no direct driver-package tests — `packages/driver/src/WorkflowDriver.js:327-374 (run switch), 397-444 (renderAndSubmit), 578-659 (handleWait/continueAsNew/cancelRun)`
- _(doc)_ Public RunOptions type omits initialOutputs/initialIteration/initialIterations that run() actually reads — `packages/driver/src/RunOptions.ts:17-43 vs packages/driver/src/WorkflowDriver.js:307-320`
- _(dead-code)_ loadCreateSession has an unreachable createSession branch and a dead relative-path fallback — `packages/driver/src/WorkflowDriver.js:22-23, 157-173`
- _(test-gap)_ Cross-loop-boundary resolveRow fallback (unscoped-producer match) is untested — `packages/driver/src/SmithersCtx.js:262-264`
- _(clean-code)_ onSchedulerWait fires on every completion with a near-zero duration and empty tasks — `packages/driver/src/WorkflowDriver.js:505-524`
- _(test-gap)_ Scheduler-level deadlock detection (makeWorkflowSession describeDeadlock) is also untested — `packages/scheduler/src/makeWorkflowSession.js:657 (describeDeadlock) and the SmithersError('DEPENDENCY_DEADLOCK', ...) it raises`

**`packages/memory`** (7)
- _(dead-code)_ MemoryService / createMemoryLayer Effect layer and <Task memory> recall/remember are never wired into any runtime — `packages/memory/src/createMemoryLayer.js:11-30, packages/memory/src/MemoryService.js:1`
- _(test-gap)_ Boundary/branch coverage gaps: ttlMs=0, undefined value, listMessages limit=0, deleteExpiredFacts driver fallback, exposed store handle — `packages/memory/src/store/MemoryStoreLive.js:122,129,243,275 and packages/memory/src/store/createMemoryStore.js`
- _(dead-code)_ react-types.ts is dead code (zero references anywhere) — `packages/memory/src/react-types.ts:1`
- _(architecture)_ TaskMemoryConfig defined three times with a diverging shape — `packages/memory/src/TaskMemoryConfig.ts:3-15`
- _(dead-code)_ Four exported config types have no consumers (speculative public API) — `packages/memory/src/WorkingMemoryConfig.ts, MessageHistoryConfig.ts, MemoryProcessorConfig.ts, SemanticRecallConfig.ts`
- _(test-gap)_ No test for percent-encoding round-trip of namespace ids containing % or : for enumerated kinds — `packages/memory/src/namespaceToString.js:8-17 and parseNamespace.js:10-28`
- _(bug)_ deleteThread is non-transactional across two writes (partial-delete risk) — `packages/memory/src/store/MemoryStoreLive.js:200-211`

**`packages/errors`** (7)
- _(bug)_ isSmithersError returns true for EngineError, so toSmithersError(engineError) returns a non-SmithersError and violates its @returns {SmithersError} contract — `packages/errors/src/isSmithersError.js:8-18 and packages/errors/src/toSmithersError.js:36-45`
- _(dead-code)_ EngineError class and EngineErrorCode type are dead across the whole repo — `packages/errors/src/EngineError.js, packages/errors/src/EngineErrorCode.ts`
- _(dead-code)_ tagged.js is an orphan barrel — never imported anywhere — `packages/errors/src/tagged.js`
- _(bug)_ errorToJson loses code/context for EngineError (and any tagged error fromTaggedError can't map) — `packages/errors/src/errorToJson.js:7-23 and packages/errors/src/fromTaggedError.js:60-62`
- _(test-gap)_ Untested functions, branches, and error paths vs the ~100% bar — `packages/errors/tests/errors-core.test.js`
- _(dead-code)_ Five tagged-error classes are never constructed anywhere in the repo — `packages/errors/src/RunNotFound.js, InvalidInput.js, DbWriteFailed.js, AgentCliError.js, WorkflowFailed.js`
- _(test-gap)_ No regression test for the label-less toSmithersError early-return on a non-SmithersError tagged cause — `packages/errors/tests/errors-core.test.js (toSmithersError describe block)`

**`packages/server`** (8)
- _(test-gap)_ Connection-limit (503) WS upgrade rejection path is untested — `packages/server/src/gateway.js:2302-2323`
- _(test-gap)_ Built-in operator UI (1.4k-line stringified browser app) has zero behavioral coverage — `packages/server/src/gatewayUi/defaultOperatorUi.js:3-1430`
- _(dead-code)_ getNodeDiffRoute documents and destructures parameters it never uses (getCurrentPointerImpl, restorePointerImpl) — `packages/server/src/gatewayRoutes/getNodeDiff.js:260-262, 276-278`
- _(dead-code)_ ConnectRequest declares a `{ password: string }` auth variant that is never implemented — `packages/server/src/ConnectRequest.ts:11-15`
- _(doc)_ ConnectionState typedef field `subscribe?: Set<string>` is stale (runtime uses `subscribedRuns`) — `packages/server/src/gateway.js:81`
- _(test-gap)_ mapEvent's ~30-case SmithersEvent→wire mapping has minimal direct coverage — `packages/server/src/gateway.js:3558-3793`
- _(clean-code)_ asStringRecord is a redundant one-line alias of asObject — `packages/server/src/gateway.js:596-601`
- _(test-gap)_ case14 gateway-rpc-roundtrip e2e is not real e2e: it reimplements the RPC handlers instead of booting the real Gateway — `e2e/faults/case14-gateway-rpc-roundtrip.test.ts:382-485`

**`packages/graph`** (8)
- _(dead-code)_ src/utils/tree-ids.js is dead in production (only the legacy dom/extract.js uses it) — `packages/graph/src/utils/tree-ids.js`
- _(clean-code)_ src/extract.js re-declares shared constants instead of importing constants.js (drift risk) — `packages/graph/src/extract.js:11-12`
- _(dead-code)_ Dead duplicate type exports: Scorer/ScorerBinding/SamplingConfig/ScorerFn/ScorerInput/ScoreResult/AgentLike/RetryPolicy/etc. — `packages/graph/src/types.ts:63-95,47-61,32-35 (+ Scorer.ts, ScorerBinding.ts, SamplingConfig.ts, ScorerFn.ts, ScorerInput.ts, ScoreResult.ts, AgentLike.ts, RetryPolicy.ts, MemoryNamespaceKind.ts, ExtractResult.ts)`
- _(test-gap)_ worktree-path.js has no dedicated unit tests; branches only hit indirectly — `packages/graph/src/worktree-path.js`
- _(clean-code)_ Misleading test titles: parseXmlJson tests named 'returns null' but assert toThrow() — `packages/graph/tests/utils-xml-extended.test.js:58-65`
- _(doc)_ TaskAspects missing from index.js @smithers-type-exports block (export-marker inconsistency) — `packages/graph/src/index.js:2-30`
- _(test-gap)_ Low-value/duplicated test files inflate the suite without adding coverage — `packages/graph/tests/constants-extended.test.js (also tree-ids.test.js vs utils-tree-ids.test.js, xml-utils.test.js vs utils-xml-extended.test.js)`
- _(test-gap)_ Untested branches in src/extract.js aspects and wait-for-event/heartbeat env logic — `packages/graph/src/extract.js:19-31 (envHeartbeatTimeoutMs), 268-291 (aspects), 533 (WaitForEvent continueOnFail)`

**`packages/openapi`** (9)
- _(bug)_ Pre-loaded object specs without an `openapi` key (e.g. Swagger 2.0) throw a misleading parse error — `packages/openapi/src/loadSpecSync.js:16-27, packages/openapi/src/loadSpecEffect.js:18-21`
- _(bug)_ Repeated path parameters only substitute the first occurrence — `packages/openapi/src/tool-factory/_helpers.js:57-59`
- _(bug)_ A parameter literally named `body` is silently overwritten by the request body — `packages/openapi/src/buildOperationSchema.js:24-58`
- _(test-gap)_ Metric increments are never asserted; duration is not recorded on error — `packages/openapi/src/tool-factory/_helpers.js:143-159`
- _(test-gap)_ No real-backend e2e: e2e.test.js mocks globalThis.fetch — `packages/openapi/tests/e2e.test.js:4-22, packages/openapi/tests/execution.test.js, packages/openapi/tests/execution-escaping.test.js`
- _(dead-code)_ `deprecated` is parsed but never used; OpenApiToolCalled event is typed/formatted but never emitted — `packages/openapi/src/extractOperations.js:45, apps/cli/src/format.js:280, packages/engine/src/index.d.ts:204`
- _(doc)_ Package limitations are undocumented (cookie params, JSON-only bodies, no parameter styles, no Swagger object) — `docs/concepts/openapi-tools.mdx (Notes section)`
- _(test-gap)_ include+exclude combined behavior and resolveBaseUrl localhost fallback are untested — `packages/openapi/src/tool-factory/_helpers.js:201-227`
- _(architecture)_ Generated index.d.ts is committed and can drift; `./*` and `./metrics` subpaths point types at the full bundle — `packages/openapi/package.json:7-23, packages/openapi/src/index.d.ts, packages/openapi/tsup.config.ts`

**`packages/devtools`** (10)
- _(bug)_ applyDelta validation is asymmetric: addNode/updateProps/updateTask accept malformed payloads and corrupt the tree — `packages/devtools/src/applyDelta.js:82-110`
- _(bug)_ snapshotSerializer maxEntries does not bound flat arrays/objects of scalars — `packages/devtools/src/snapshotSerializer.js:56-80`
- _(dead-code)_ Five package exports have no consumers anywhere in the repo (effectively dead public API) — `packages/devtools/src/index.js:18-23`
- _(test-gap)_ DevToolsRunStore: verbose logging, unknown-event recording, orphan ToolCallFinished, and getTaskState-miss branches are untested — `packages/devtools/src/DevToolsRunStore.js:68-77,119-142,183-189`
- _(test-gap)_ snapshotSerializer: top-level non-plain values and anonymous-class instances are untested boundary cases — `packages/devtools/src/snapshotSerializer.js:88-106`
- _(test-gap)_ diffSnapshots p95 timing assertion is a CI-flaky unit test — `packages/devtools/tests/diffSnapshots.test.ts:7,236-253`
- _(clean-code)_ SMITHERS_NODE_ICONS uses the same '⚡' glyph for both 'task' and 'parallel' — `packages/devtools/src/SMITHERS_NODE_ICONS.js:6,8`
- _(dead-code)_ Server snapshotFromFrameRow constructs a SmithersDevToolsCore + captureSnapshot whose result is discarded — `packages/server/src/gatewayRoutes/getDevToolsSnapshot.js:334-335 (re: packages/devtools/src/SmithersDevToolsCore.js:33-37)`
- _(clean-code)_ printTree prints props.name/props.id without type-narrowing (Record<string,unknown> values) — `packages/devtools/src/printTree.js:24-29`
- _(bug)_ applyDelta replaceRoot/addNode/removeNode/updateProps reject only by side effects, but updateProps with no props key sets node.props = undefined — `packages/devtools/src/applyDelta.js:96`

**`packages/gateway-react`** (14)
- _(bug)_ useGatewayExtensionStream never clears `error` after a successful reconnect — `packages/gateway-react/src/useGatewayExtensionStream.ts:66-101`
- _(test-gap)_ useSyncMutation success-path branches (invalidate, onSuccess, reset, mutateSafe, success status) untested — `packages/gateway-react/src/sync/useSyncMutation.ts:85-122; packages/gateway-react/tests/sync/sync.test.ts:246-287`
- _(test-gap)_ Connection observer offline/connecting transitions and reconnectingSince never asserted — `packages/gateway-react/src/sync/createGatewayCollections.ts:78-101; packages/gateway-react/tests/sync/sync.test.ts:576-628`
- _(test-gap)_ invalidate() re-pull of pollable list collections via the pulser is untested — `packages/gateway-react/src/sync/createGatewayCollections.ts:109-147,387-391; packages/gateway-react/tests/sync/sync.test.ts`
- _(test-gap)_ isAuthError 401/403 status and code-based branches untested — `packages/gateway-react/src/sync/createGatewayCollections.ts:53-62`
- _(test-gap)_ useGatewayExtensionAction error path and double-call generation fence untested — `packages/gateway-react/src/useGatewayExtensionAction.ts:33-39; packages/gateway-react/tests/extension-hooks.test.ts:129-158`
- _(test-gap)_ useGatewayRunEvents afterSeq filter and error state untested — `packages/gateway-react/src/useGatewayRunEvents.ts:45,58-59; packages/gateway-react/tests/sync/sync.test.ts:455-503`
- _(test-gap)_ createGatewayReactRoot success path (mount + dual-provider wiring) untested — `packages/gateway-react/src/createGatewayReactRoot.ts:12-34; packages/gateway-react/tests/gateway-react.test.ts:78-101`
- _(clean-code)_ useGatewayRunTree casts node status to NodeStatus despite the source type being plain `string` — `packages/gateway-react/src/sync/useGatewayRunTree.ts:57`
- _(bug)_ buildRunTree recursion is unguarded against cyclic childIds — `packages/gateway-react/src/sync/useGatewayRunTree.ts:26-38`
- _(test-gap)_ useSyncClient missing-provider throw and SyncContext default are untested — `packages/gateway-react/src/sync/useSyncClient.ts:10-16; packages/gateway-react/src/sync/SyncContext.ts`
- _(doc)_ No README for the package — `packages/gateway-react/`
- _(clean-code)_ useGatewayExtensionStream `streaming` is initialized to `enabled` and a same-tick early-return path can briefly report streaming=true with no subscription — `packages/gateway-react/src/useGatewayExtensionStream.ts:53-59`
- _(bug)_ flattenGatewayRunNode visit() is also unguarded against cycles (same class as buildRunTree) — `packages/gateway-client/src/sync/flattenGatewayRunNode.ts:6-19`

**`packages/gateway-client`** (10)
- _(dead-code)_ Stale empty src/index.d.ts is checked in and shipped — `packages/gateway-client/src/index.d.ts:1`
- _(dead-code)_ Exported GatewayRequestFrame type is never imported or used anywhere — `packages/gateway-client/src/GatewayRequestFrame.ts:1`
- _(dead-code)_ Three exported gatewayKeys factories (cronList, nodeOutput, nodeDiff) are unused — `packages/gateway-client/src/sync/gatewayKeys.ts:16-24`
- _(clean-code)_ Duplicated helper functions copy-pasted across files (isObject x3, isGatewayResponseFrame x2 identical, withoutVirtualFields x3, asRecord x2) — `packages/gateway-client/src/SmithersGatewayConnection.ts:50-63`
- _(architecture)_ getDevToolsSnapshot is used by the nodes collection but is missing from the client's typed RPC surface — `packages/gateway-client/src/sync/gatewayCollectionDefs.ts:118`
- _(clean-code)_ Run-row status vocabulary diverges from node status vocabulary (raw 'finished' vs normalized 'ok') — `packages/gateway-client/src/sync/gatewayCollectionDefs.ts:55-68`
- _(test-gap)_ Untested error/auth/reconnect branches in createGatewayCollection — `packages/gateway-client/src/sync/createGatewayCollection.ts:281-309`
- _(test-gap)_ snapshotToGatewayRunNode nodeKind/nodeName/nodeStatus branches partially untested — `packages/gateway-client/src/sync/snapshotToGatewayRunNode.ts:49-87`
- _(test-gap)_ streamExtension and extensionRpc lack reconnect/error-frame and abort coverage — `packages/gateway-client/src/SmithersGatewayClient.ts:562-602`
- _(clean-code)_ connect() open-failure path leaves the socket unclosed (inconsistent with abort path) — `packages/gateway-client/src/SmithersGatewayClient.ts:272-280`

**`packages/usage`** (8)
- _(test-gap)_ No e2e coverage of the `smithers usage` command — `e2e/ (absent), apps/cli/src/index.js:5874-5894`
- _(test-gap)_ Pure parser/formatter branches and boundaries untested — `packages/usage/src/humanizeDurationShort.js:10, packages/usage/src/formatUsageReports.js:16-25, packages/usage/src/parseCodexUsage.js:12-17`
- _(dead-code)_ Declared dependency @smithers-orchestrator/errors is unused — `packages/usage/package.json:29`
- _(bug)_ readUsageCache does not validate cache version and accepts array `entries` — `packages/usage/src/usageCache.js:29-37`
- _(bug)_ Anthropic/OpenAI count windows can report a negative `used` when remaining > limit — `packages/usage/src/parseAnthropicRateLimitHeaders.js:25, packages/usage/src/parseOpenAiRateLimitHeaders.js:28`
- _(clean-code)_ parseDurationSeconds silently parses leading garbage (lenient regex) — `packages/usage/src/parseDurationSeconds.js:20-37`
- _(clean-code)_ readClaudeCredentials reads token expiresAt but the adapter never checks it before sending — `packages/usage/src/readClaudeCredentials.js:64-65, packages/usage/src/claudeOauthUsage.js:24-50`
- _(test-gap)_ getUsageForAccounts has untested branches: --fresh bypass, the claude-code hard 180s floor, and the cache-write-failure catch — `packages/usage/src/getUsageForAccounts.js:42-75`

**`packages/pi-plugin`** (8)
- _(doc)_ System prompt advertises `-u`/`-k` flag aliases that are never registered — `packages/pi-plugin/src/buildSmithersPiSystemPrompt.ts:91-92`
- _(dead-code)_ Committed generated src/index.d.ts is unreferenced by the exports map (dead generated artifact in source) — `packages/pi-plugin/src/index.d.ts`
- _(clean-code)_ DevToolsClient.toWsUrl has a no-op pathname assignment — `packages/pi-plugin/src/runtime/DevToolsClient.ts:91`
- _(dead-code)_ DevToolsStore.retryNode and runSupportsRetry are effectively dead (no-op feature) — `packages/pi-plugin/src/runtime/DevToolsStore.ts:204,520-524`
- _(dead-code)_ DevToolsClient.signal/resume/getNodeOutput/getNodeDiff are unused within the package — `packages/pi-plugin/src/runtime/DevToolsClient.ts:411-425,449-466`
- _(test-gap)_ buildSmithersPiSystemPrompt activeRun branch and jsonSchemaToTypebox default branch are untested — `packages/pi-plugin/src/buildSmithersPiSystemPrompt.ts:101-117, packages/pi-plugin/src/extension.ts:200-205`
- _(test-gap)_ SmithersPiHttpClient.json (error path, headers, auth) is untested — `packages/pi-plugin/src/api/SmithersPiHttpClient.ts:35-54`
- _(test-gap)_ getStatus/cancel/deny/resume/runWorkflow/streamEvents api wrappers untested individually (sub-scope of finding 3, but each has distinct branch logic worth separate coverage) — `packages/pi-plugin/src/api/getStatus.ts, cancel.ts, deny.ts, resume.ts, runWorkflow.ts, streamEvents.ts`

**`packages/sandbox`** (10)
- _(test-gap)_ Several executeSandbox error/result branches are untested — `packages/sandbox/src/execute.js:192-231 (materializeProviderResult), 195/198-203, 260-276 (applyAcceptedSandboxChanges), 347-352, 607-609`
- _(dead-code)_ SandboxHttpRunner / SandboxSocketRunner are dead pass-through re-exports — `packages/sandbox/src/effect/http-runner.js:108 (export const SandboxHttpRunner = HttpRunner); packages/sandbox/src/effect/socket-runner.js:93 (export const SandboxSocketRunner = SocketRunner)`
- _(dead-code)_ process-runner.js exports normalizeSandboxEnv/Ports/Volumes but they are only used internally; their negative paths are untested — `packages/sandbox/src/effect/process-runner.js:67,109,143 (normalizeSandboxEnv, normalizeSandboxPorts, normalizeSandboxVolumes)`
- _(dead-code)_ sandboxEgressEnv NO_PROXY array branch is unreachable dead code — `packages/sandbox/src/egress.js:148`
- _(test-gap)_ executeSandbox via the transport (non-provider) path never exercises svc.execute, and codeplane.execute is never integration-tested — `packages/sandbox/src/execute.js:607-609; packages/sandbox/src/effect/http-runner.js:97-100 (codeplane execute)`
- _(dead-code)_ assertPathWithinRootEffect exported but only used internally — `packages/sandbox/src/sandboxPath.js:28`
- _(clean-code)_ directorySize misnamed and dangling WalkResult typedef — `packages/sandbox/src/execute.js:106-113 (directorySize); packages/sandbox/src/bundle.js:19 (@returns {Promise<WalkResult>})`
- _(clean-code)_ Request README writes confusing/empty runtime field on provider path — `packages/sandbox/src/execute.js:417-423`
- _(bug)_ Type-only subpath @smithers-orchestrator/sandbox/SandboxHandle also breaks external strict TS consumers (extends finding #1) — `packages/sandbox/src/SandboxHandle.ts; packages/sandbox/package.json:13-17; e2e/harness/stallSandbox.ts:2`
- _(test-gap)_ socket-runner.js darwin sandbox-exec missing-binary branch (line 68) untested — `packages/sandbox/src/effect/socket-runner.js:68`

**`packages/scorers`** (12)
- _(dead-code)_ Dead file: src/react-types.ts is never imported anywhere — `packages/scorers/src/react-types.ts:1`
- _(bug)_ aggregateScores builds SQL via string interpolation with a one-character escaper — `packages/scorers/src/aggregate.js:19-52, 106-108`
- _(clean-code)_ Redundant two-layer barrel shims (create-scorer.js, builtins.js) duplicate the real implementation files — `packages/scorers/src/create-scorer.js:6-7; packages/scorers/src/builtins.js:1-5`
- _(test-gap)_ Heavy test-file duplication inflates the suite without adding coverage — `packages/scorers/tests/builtins.test.js vs scorers-builtins.test.js; run-scorers.test.js vs scorers-run.test.js; aggregate.test.js vs scorers-aggregate.test.js; create-scorer.test.js vs scorers-create.test.js`
- _(test-gap)_ types.test.js asserts plain JS object literals, providing no real type or behavior coverage — `packages/scorers/tests/types.test.js:1-132`
- _(test-gap)_ parseJudgeJson treats valid top-level non-object JSON (bare number/array) as a parse failure — `packages/scorers/src/llmJudge.js:17-24, 111-126`
- _(test-gap)_ Untested error/branch paths in run-scorers and aggregate — `packages/scorers/src/run-scorers.js:139-148, 162-169; packages/scorers/src/aggregate.js:82-101`
- _(doc)_ smithersScorers is typed as `any` in the hand-maintained index.d.ts, erasing column types for consumers — `packages/scorers/src/index.d.ts:159`
- _(architecture)_ package.json declares ./metrics and ./schema subpath exports that no consumer uses; types map all subpaths to index.d.ts — `packages/scorers/package.json:8-25; packages/scorers/src/index.d.ts`
- _(dead-code)_ Public API (aggregateScores, runScorersBatch, relevancy/toxicity/faithfulness scorers) has no in-repo product consumer — `packages/scorers/src/index.js:18-28; packages/smithers/src/index.js:231`
- _(doc)_ skills/eval-writer/SKILL.md documents scorer/llmJudge/sampling APIs that don't match the real signatures — `skills/eval-writer/SKILL.md:81-84`
- _(missing-feature)_ Scorer execution never persists context/groundTruth even when a scorer does receive them, and inputJson is the only correlation column — `packages/scorers/src/run-scorers.js:110-131`

**`packages/protocol`** (10)
- _(dead-code)_ outputs.ts is entirely dead — exported types have zero consumers; server and db reimplement them — `packages/protocol/src/outputs.ts (whole file: OutputSchemaFieldType, OutputSchemaDescriptor, NodeOutputResponse)`
- _(dead-code)_ ProtocolError type is exported but never consumed anywhere — `packages/protocol/src/errors.ts:51 (and duplicate at src/errors/ProtocolError.ts:6, re-exported via index.ts:22)`
- _(dead-code)_ DEVTOOLS_PROTOCOL_VERSION is exported but never read; both producer and consumers hardcode version: 1 — `packages/protocol/src/devtools.js:10 (DEVTOOLS_PROTOCOL_VERSION), re-exported index.ts:1`
- _(dead-code)_ errors/*.ts type files are dead — shadowed by errors.ts in path resolution, never a consumer target — `packages/protocol/src/errors/DevToolsErrorCode.ts, NodeOutputErrorCode.ts, NodeDiffErrorCode.ts, JumpToFrameErrorCode.ts, ProtocolError.ts`
- _(test-gap)_ Loose test assertions: 3 of 4 error arrays are only spot-checked with toContain, not exact-asserted — `packages/protocol/tests/protocol-contracts.test.js:31-48`
- _(bug)_ tsconfig path map for the protocol root points at a non-existent file (src/index.js) — `tsconfig.json:162-164 (and examples/tsconfig.json equivalent)`
- _(clean-code)_ Package root has no runtime entry, so the constants re-exported from index.ts are unreachable at runtime — `packages/protocol/package.json:7-26 (exports) and src/index.ts:1,13-23 (runtime re-exports)`
- _(clean-code)_ Inconsistent subpath module layout between /devtools and /errors — `packages/protocol/src/devtools.js + devtools/*.ts vs src/errors.ts + errors/index.js + errors/*.ts`
- _(clean-code)_ DevToolsNodeType union is duplicated inline in index.d.ts instead of being a single declared type — `packages/protocol/src/index.d.ts:1 vs src/devtools/DevToolsNodeType.ts:1-17`
- _(dead-code)_ Duplicate ProtocolError definition: errors.ts and errors/ProtocolError.ts both define the identical shape independently — `packages/protocol/src/errors.ts:51-55 and packages/protocol/src/errors/ProtocolError.ts:6-10`

**`packages/accounts`** (6)
- _(clean-code)_ ACCOUNT_* error codes are not registered in the errors-package code registry that every other domain code uses — `packages/errors/src/smithersErrorDefinitions.js:1-40`
- _(test-gap)_ Untested branches/input-classes: addAccount apiKey:"" + addedAt-preservation + model paths, and accountsRoot empty-string SMITHERS_HOME — `packages/accounts/src/addAccount.js:40-44`
- _(test-gap)_ defaultConfigDir defense-in-depth escape branch is unreachable and untested (only uncovered lines in the package) — `packages/accounts/src/defaultConfigDir.js:33-40`
- _(doc)_ 0.17.0 changelog documents the accounts public API incorrectly (async + wrong provider id + wrong getAccount signature) — `docs/changelogs/0.17.0.mdx:327-336`
- _(architecture)_ package.json "./*" subpath export is unused and would serve whole-bundle types for any subpath — `packages/accounts/package.json:13-17`
- _(architecture)_ Committed generated index.d.ts has no CI sync guard (drift risk) — `packages/accounts/src/index.d.ts:1-158`

**`packages/react-reconciler`** (10)
- _(dead-code)_ Dead host-config method: prepareUpdate is never called by react-reconciler 0.33 — `packages/react-reconciler/src/reconciler.js:181-185`
- _(dead-code)_ core-types.js is an orphaned re-export imported by nothing — `packages/react-reconciler/src/core-types.js:1`
- _(bug)_ reconciler.js has top-level side effects but package.json declares sideEffects:false — `packages/react-reconciler/src/reconciler.js:400-410`
- _(bug)_ Container stores a single root; top-level Fragment/array silently truncated to last child — `packages/react-reconciler/src/reconciler.js:129-131,171-173`
- _(test-gap)_ resolveExtractGraph error/fallback paths and importCoreModule catch are untested — `packages/react-reconciler/src/core-peer.js:13,25-33`
- _(test-gap)_ commitUpdate defensive branches for non-0.33 signatures are untested and likely unreachable — `packages/react-reconciler/src/reconciler.js:191-208`
- _(test-gap)_ SmithersDevTools verbose-logging and onCommitFiberUnmount paths are untested — `packages/react-reconciler/src/devtools/SmithersDevTools.js:233-256,311`
- _(test-gap)_ Several react-reconciler 0.33 host-config stubs are never executed by the headless sync path — `packages/react-reconciler/src/reconciler.js:146,171,254,260,266,284,300-302,350,356,362,372,380`
- _(test-gap)_ commitTextUpdate (text content re-render) is not exercised by a changing-text test — `packages/react-reconciler/src/reconciler.js:219-221`
- _(bug)_ insertInContainerBefore ignores its _beforeChild argument, silently dropping ordering semantics — `packages/react-reconciler/src/reconciler.js:171-173`

**`packages/vcs`** (9)
- _(dead-code)_ WorkspaceSnapshot.ts is orphaned dead code with documentation that diverges from (and is richer than) the authoritative inline typedef — `packages/vcs/src/WorkspaceSnapshot.ts:1-16`
- _(test-gap)_ Two near-duplicate test files for findVcsRoot with overlapping cases and a misleading test name — `packages/vcs/tests/find-vcs-root.test.js ; packages/vcs/tests/vcs-find-root.test.js`
- _(test-gap)_ vcsToolingStatus error/negative branches untested: ok:false (both null), jj-null path, and runsVersion catch branch — `packages/vcs/tests/vcs-tooling-status.test.js:53-75 ; packages/vcs/src/vcsToolingStatus.js:24-52`
- _(test-gap)_ resolveGitBinary 'override file does not exist' branch is untested (resolveJjBinary has the equivalent test) — `packages/vcs/tests/vcs-tooling-status.test.js:40-51 ; packages/vcs/src/resolveGitBinary.js:16-18`
- _(test-gap)_ resolveJjBinary bundled-resolution branches (bundled path, require.resolve catch, unsupported platform) are untested — `packages/vcs/src/resolveJjBinary.js:34-67 ; packages/vcs/tests/resolve-jj-binary.test.js:47-56`
- _(clean-code)_ vcsDuration metric is recorded only on the jj success path, not on failure/timeout — `packages/vcs/src/jj.js:44-67`
- _(architecture)_ Inconsistent timeout policy: isJjRepo (on the durability-startup hot path) has no timeout while getJjPointer/captureWorkspaceSnapshot do — `packages/vcs/src/jj.js:167-171 ; packages/engine/src/startDurability.js:84`
- _(clean-code)_ findVcsRoot is wrapped in Effect.sync but every consumer immediately Effect.runSync's it — pure ceremony with no Effect benefit — `packages/vcs/src/find-root.js:12-29 ; packages/engine/src/engine.js:709,733,1697`
- _(test-gap)_ jj snapshot dedup/edge branches in captureWorkspaceSnapshot are only asserted under real jj, leaving the changeId-fallback and op-id parsing untested in CI — `packages/vcs/src/jj.js:131-147`

**`packages/control-plane`** (7)
- _(clean-code)_ Duplicate slug / UNIQUE-constraint conflicts leak raw SQLite Error instead of a typed SmithersError — `src/index.js:504`
- _(clean-code)_ recordUsage / recordAuditEvent do not validate project existence — asymmetric with setUsageLimit/putSecretRef, leaks raw FK error — `src/index.js:753`
- _(bug)_ Unguarded JSON.parse on DB-stored metadata_json — exportOrgAudit/getOrg/etc. throw a raw SyntaxError on corrupt rows — `src/index.js:288`
- _(test-gap)_ Secret-value test assertion is a no-op — does not actually prove the no-plaintext invariant — `tests/control-plane.test.js:183`
- _(doc)_ Docs imply period-windowed quotas but checkUsageLimit is window-blind — `docs/deployment/control-plane.mdx:113`
- _(test-gap)_ No test exercises UNIQUE-conflict or constraint-error branches; coverage is line-only — `tests/control-plane.test.js:262`
- _(clean-code)_ checkUsageLimit/setUsageLimit `period` field is entirely non-functional — no validation, no enumeration, no behavioral effect beyond row-keying — `packages/control-plane/src/index.js:857`

**`packages/gateway`** (7)
- _(test-gap)_ rpc-contract.test.ts example validation is schema self-validation, not a round-trip; near-tautological for opaque response schemas — `packages/gateway/tests/rpc-contract.test.ts:191-198`
- _(dead-code)_ `approve` special-case in getRequiredScopeForGatewayMethod maps a method the runtime never dispatches (vestigial) — `packages/gateway/src/rpc/index.ts:744-746`
- _(dead-code)_ JsonSchema type declares anyOf/format/default/maximum fields that no schema sets and the test validator cannot check — `packages/gateway/src/rpc/index.ts:9-25`
- _(test-gap)_ generate-openapi.ts has zero test coverage despite emitting the published contract artifact and shipping in `files` — `packages/gateway/scripts/generate-openapi.ts:1-265`
- _(test-gap)_ TS *Request/*Response types and JsonSchema definitions are maintained in parallel with no agreement test — `packages/gateway/src/rpc/index.ts:93-267`
- _(doc)_ Misleading test comment claims a non-existent 'canonical approve method' — `packages/gateway/tests/rpc-contract.test.ts:241`
- _(test-gap)_ objectSchema(additionalProperties) supports a sub-schema type per JsonSchema, but no definition ever uses it and the OpenAPI generator/validator paths for it are untested — `packages/gateway/src/rpc/index.ts:276-287`

**`packages/tool-context`** (2)
- _(clean-code)_ Public type surface is Record<string,any> — direct importers of the package get zero type safety — `packages/tool-context/src/index.d.ts:12-26`
- _(clean-code)_ package.json ./* subpath export maps every subpath's types to index.d.ts (latent mis-mapping, currently unused) — `packages/tool-context/package.json:13-17`

**`apps/cli`** (8)
- _(dead-code)_ Orphaned type files: AskOptions.ts, InitWorkflowPackOptions.ts, InitWorkflowPackResult.ts, and a shebang-only index.d.ts — `apps/cli/src/AskOptions.ts, apps/cli/src/InitWorkflowPackOptions.ts, apps/cli/src/InitWorkflowPackResult.ts, apps/cli/src/index.d.ts`
- _(dead-code)_ Dead MCP exports: registerSemanticTools and serveSemanticMcpServer — `apps/cli/src/mcp/semantic-server.js:11-21 (registerSemanticTools), 36-41 (serveSemanticMcpServer)`
- _(test-gap)_ cron commands and scheduler tick logic have no tests — `apps/cli/src/index.js:2265-2328 (cron add/list/rm/start), apps/cli/src/scheduler.js (schedulerTickEffect/processCronEffect/runScheduler)`
- _(test-gap)_ MCP revert_attempt tool handler is untested — `apps/cli/src/mcp/semantic-tools.js:1185-1209`
- _(architecture)_ index.js is a 6,439-line monolith mixing parsing, ~60 command bodies, MCP wiring, and helpers — `apps/cli/src/index.js (6439 lines)`
- _(clean-code)_ Detached spawn path resolution is inconsistent (`.pathname` vs fileURLToPath) — `apps/cli/src/index.js:1649 and 2902 vs apps/cli/src/resume-detached.js:17`
- _(clean-code)_ runDevtoolsCommandWithTelemetry is called for snapshots/restore despite its `cmd` type being tree\|diff\|output\|rewind — `apps/cli/src/index.js:2606 (JSDoc), 4978 (snapshots), 5006 (restore), 2589 (DEVTOOLS_COMMANDS)`
- _(test-gap)_ Contract test does not cover every command that advertises JSON output (rewind omitted despite being handled) — `apps/cli/tests/json-stdout-contract.test.js:151-160`

**`apps/observability`** (8)
- _(dead-code)_ Dead in-memory recordEvent handles event types that don't exist in the SmithersEvent union — `apps/observability/src/_coreMetrics.js:359-479`
- _(test-gap)_ OTLP integration entry points (createSmithersOtelLayer/ObservabilityLayer/RuntimeLayer) have no tests — `apps/observability/src/createSmithersObservabilityLayer.js:46-49`
- _(test-gap)_ _traceEventNormalizers.js: shared/generic normalizer and provider-correlation paths largely untested — `apps/observability/src/_traceEventNormalizers.js:306-397`
- _(test-gap)_ OTLP severity edge cases untested: truncated-json-stream WARN and session error/warning inference — `apps/observability/src/_otelLogBuilders.js:60-92`
- _(test-gap)_ renderPrometheusMetrics Frequency and Summary metric-state branches untested — `apps/observability/src/renderPrometheusMetrics.js:172-188`
- _(clean-code)_ Redaction 'secret-ish' rule carries a misleading dead replace:'' field — `apps/observability/src/_traceRedaction.js:27-31`
- _(clean-code)_ Public makeSmithersSpanAttributes and the internal _coreTracing.js copy can silently diverge — only the standalone file uses the shared alias table — `apps/observability/src/_coreTracing.js:32-59`
- _(dead-code)_ _coreMetrics.js catalog is reachable as a published deep import via the './*' subpath export, exposing a stale duplicate metric catalog — `apps/observability/package.json:18-22`

**`apps/review`** (8)
- _(dead-code)_ bearerToken.ts is dead code — exported helper imported nowhere — `apps/review/src/server/bearerToken.ts`
- _(test-gap)_ Non-streaming JSON metering and srk_ api-key proxy branches untested — `apps/review/src/server/proxy/handleAnthropic.ts:131-146, authenticateProxyRequest.ts:71-75`
- _(bug)_ SSE metering silently under-bills responses larger than 1MB — `apps/review/src/server/proxy/handleAnthropic.ts:43-51`
- _(bug)_ Session spend-cap enforcement races under concurrent requests — `apps/review/src/server/proxy/handleAnthropic.ts:91-92, 131-146`
- _(test-gap)_ CLI entrypoint and GitHub Action drivers have no tests — `apps/review/src/cli/main.ts, apps/review/src/cli/parseReviewArgs.ts, apps/review/action/src/runAction.ts, runGate.ts, runReview.ts, fetchOidcToken.ts`
- _(test-gap)_ Several pure walkthrough helpers lack direct unit tests — `apps/review/src/walkthrough/classifyChangeRole.ts, buildNarratePrompt.ts, describeChange.ts, escapeHtml.ts, src/diffs/renderFallbackDiffHtml.ts, src/workflow/normalizeReviewInput.ts, writeOpenAiSchemaFile.ts`
- _(clean-code)_ verifyOidc accepts a single JWKS key when the token's kid does not match — `apps/review/src/server/sessions/verifyOidc.ts:104`
- _(test-gap)_ /api/admin/usage endpoint untested — `apps/review/src/server/admin/handleAdminUsage.ts`

**`examples`** (4)
- _(test-gap)_ examples/ tree (108 workflows) is in NO CI gate — typecheck:examples script exists but is never invoked — `.github/workflows/ci.yml:34`
- _(test-gap)_ examples/tsconfig.json points smithers-orchestrator at src/*.js source, not the published package — typecheck:examples does not validate against shipped types — `examples/tsconfig.json`
- _(doc)_ Directory-based example projects use raw bare model strings, compounding the staleness blast radius — `examples/defending-code/workflow.jsx:35`
- _(doc)_ Doc inconsistency: shared/models.md lists Sonnet 4 retirement as 'TBD' while model-migration.md says 'June 15, 2026' (note: claude-api is an installed skill, not the smithers repo) — `(external skill) claude-api/shared/models.md`

**`docs-human`** (4)
- _(doc)_ README hero GIF alt text still references the out-of-scope 'Smithers Studio' — `README.md:14`
- _(doc)_ tui.mdx points humans at the `gui` command, which launches a retired native app bundle — `docs/guides/tui.mdx:20`
- _(doc)_ custom-workflow-ui.mdx couples the in-scope `smithers ui` guide to out-of-scope product surfaces (apps/smithers PWA, Studio 2) — `docs/guides/custom-workflow-ui.mdx:3,6,8,28`
- _(doc)_ 0.22.0 changelog claims 'Ten canonical starters' but only nine are defined — `docs/changelogs/0.22.0.mdx:128`

**`docs-agent-llms`** (4)
- _(doc)_ Stale Opus model ID in OpenCodeAgent JSDoc example (claude-opus-4-20250514) — `packages/agents/src/OpenCodeAgent.ts:6`
- _(doc)_ reference/types.mdx SmithersWorkflow omits the zodToKeyName field present in actual WorkflowDefinition — `docs/reference/types.mdx:21-28`
- _(dead-code)_ Orphan jsx stub pages not in any navigation (jsx/installation.mdx, jsx/quickstart.mdx) — `docs/jsx/installation.mdx, docs/jsx/quickstart.mdx`
- _(doc)_ docs/why/background-agents.mdx uses non-current model claude-opus-4-5 — `docs/why/background-agents.mdx:28`

**`workflow-ui-doc-coverage`** (9)
- _(ui)_ 13 canonical init workflows ship with no custom UI (violates the 'every built-in workflow has a UI' bar) — `apps/cli/src/workflow-pack.js:1651 (UI_WORKFLOWS) vs the 30 workflows emitted by renderTemplateFiles`
- _(architecture)_ Workflow-to-UI binding is implicit filename convention with no missing-UI signal — `apps/cli/src/index.js:1990-1998; apps/cli/src/workflow-pack.js:1716-1727 (renderGatewayFile)`
- _(doc)_ docs/workflows/overview.mdx 'Default Workflows' table lists only 16 of 30 installed workflows — `docs/workflows/overview.mdx:18-35`
- _(doc)_ docs/workflows/monitor.mdx is orphaned — not in docs.json sidebar nav, not linked anywhere — `docs/docs.json (workflows nav) vs docs/workflows/monitor.mdx`
- _(test-gap)_ kanban UI ships and is mounted but is not functionally covered by the all-UI e2e — `apps/cli/tests/workflow-ui-descriptors.json; apps/cli/tests/workflow-ui-all.e2e.test.js`
- _(doc)_ docs/workflows/catalog.mdx pack tables are stale and inconsistent ('install all three' / 4 packs / 16 of 30 workflows) — `docs/workflows/catalog.mdx:6-15`
- _(test-gap)_ No test guards UI_WORKFLOWS / gateway-mounts / ui-files / e2e-descriptors against drift — `apps/cli/src/workflow-pack.js:1651 (UI_WORKFLOWS); apps/cli/tests/init.e2e.test.js`
- _(doc)_ docs/workflows/monitor.mdx is an orphan page — linked from no index and absent from docs.json nav — `docs/docs.json:140`
- _(doc)_ workflow-ui-all.e2e.test.js docstring says 'ALL 15 UIs' but the harness covers 16 descriptors — `apps/cli/tests/workflow-ui-all.e2e.test.js:24`

**`smithers-ui-system`** (6)
- _(architecture)_ Default operator console re-implements the whole wire protocol instead of using the published SDK — `packages/server/src/gatewayUi/defaultOperatorUi.js:1-1432`
- _(test-gap)_ Default operator console has no behavioral/browser test — only string-grep assertions — `packages/server/tests/gateway-ui.test.jsx:94-180`
- _(test-gap)_ Pure run-status mapper `runStatusFromFrame` branches are not directly unit-tested — `packages/gateway-client/src/sync/gatewayCollectionDefs.ts:55-87 (runStatusFromFrame, runRowsFromFrame, eventRows)`
- _(clean-code)_ refetch closures reference `params` but omit it from the dependency array — `packages/gateway-react/src/useGatewayApprovals.ts:18-20, useGatewayRuns.ts:16-18, useGatewayWorkflows.ts:17-19`
- _(doc)_ Doc claims a 'generation counter' stale-fence for useGatewayExtensionStream that does not exist in code — `packages/gateway-react/src/useGatewayExtensionStream.ts:28-31 (JSDoc) vs 55-104 (impl); docs/guides/custom-workflow-ui.mdx:110,221-227`
- _(bug)_ Extension-stream reconnect backoff timer ignores the abort signal — `packages/gateway-react/src/useGatewayExtensionStream.ts:94`

**`adapters-e2e`** (4)
- _(dead-code)_ Capability-registry factory exports are inconsistent: 4 of 10 re-exported from index, and those 4 are consumed nowhere — `packages/agents/src/index.js:48-58`
- _(clean-code)_ OpenCodeAgent is the only adapter with a hand-maintained .ts declaration file instead of the standard XAgentOptions.ts pattern — `packages/agents/src/OpenCodeAgent.ts (+ OpenCodeAgent.js)`
- _(test-gap)_ Manifest emittedFlags are validated for internal consistency but never against real buildCommand output — `packages/agents/tests/cli-capabilities.test.js:11-55, packages/agents/src/cli-surface/cliAgentSurfaceManifest.js`
- _(test-gap)_ Real-CLI e2e exists for only 2 of 10 CLI engines (OpenCode, Vibe); the other 8 are proven only via fake-binary subprocess tests — `packages/agents/tests/opencode-e2e.test.js, packages/agents/tests/vibe-agent-e2e.test.js`

**`e2e-suite`** (7)
- _(missing-feature)_ Major features have NO real happy-path e2e: crons, OpenAPI tools, memory, eval/optimize, sandbox suspend/resume — `packages/*/tests/*.e2e.test.*, apps/cli/tests/*.e2e.test.js (absence of eval/openapi/memory/cron-loop e2e)`
- _(test-gap)_ workflow-ui-all e2e depends on a retired POC (apps/smithers-studio-2) for its Chromium binary — `apps/cli/tests/workflow-ui-all.e2e.test.js:43,59`
- _(doc)_ flake-log.md is empty, so the documented promotion gate (0 flakes / 100 CI runs) cannot have been applied — yet fabricated cases were 'promoted' to per-PR — `e2e/flake-log.md:9-11; e2e/README.md:42-46; .github/workflows/faults.yml:35`
- _(test-gap)_ case08 inspector and case24 replay-safety are hybrids: real predicate called against fabricated storage — `e2e/faults/case08-inspector-never-idle.test.ts:3,62,277; e2e/faults/case24-replay-unsafe-approval.test.ts:3,189-248,443`
- _(test-gap)_ Reconnect-afterSeq / ws-drop / webhook behaviors are fabricated in e2e/faults but exist as real (non-e2e) tests elsewhere — duplicate-but-fake instead of promoting the real ones — `e2e/faults/case09-reconnect-afterseq.test.ts; case15-ws-drop-reconnect.test.ts; case17-webhook-bad-signature.test.ts; e2e/budgets/latency.json`
- _(test-gap)_ e2e package.json omits the smithers-orchestrator dependency that case25 imports, so the real-gateway e2e relies on hoisting — `e2e/package.json; e2e/faults/case25-approval-scope-denial.test.ts:7`
- _(test-gap)_ OpenAPI 'e2e' test mocks globalThis.fetch, so it is not a strict no-mock e2e — `packages/openapi/tests/e2e.test.js:9-18,30-42`

**`skills`** (5)
- _(skill)_ report-maker makes inaccurate claims about shared slideshow renderer and monitor-smithers — `skills/report-maker/SKILL.md:64,72-73`
- _(skill)_ context-engineer cites a node id `grill-until-clear` that does not exist — `skills/context-engineer/SKILL.md:56`
- _(skill)_ smithers SKILL.md uses singular `smithers agent add\|list\|remove`; the actual command is `agents` (plural) — `skills/smithers/SKILL.md:255`
- _(skill)_ smithers SKILL.md lists `<LoopUntilScored>` as a box-shipped built-in, but it is a seeded local-pack component — `skills/smithers/SKILL.md:217-219,268`
- _(doc)_ skills/smithers/llms-full.txt is up to date with the generated docs bundle (positive finding) — `skills/smithers/llms-full.txt`

**`missing-features`** (4)
- _(missing-feature)_ Several documented remote sandbox targets (gVisor, Daytona, Cloudflare) have no shipped or example provider — `docs/index.mdx:240-241, README.md:170-174, packages/sandbox/src/`
- _(missing-feature)_ `smithers openapi` advertises 'Generate AI SDK tools' but only has a `list` (preview) subcommand — no generate verb — `apps/cli/src/index.js:2486-2511`
- _(doc)_ README promotes the deprecated `<Ralph>` component as a first-class primitive with example code — `README.md:285-303`
- _(missing-feature)_ `smithers memory` and `smithers cron` CLI groups are partial vs their underlying store/adapter capabilities — `apps/cli/src/index.js:2230-2328`

**`architecture-deps`** (9)
- _(architecture)_ Circular dependency between @smithers-orchestrator/agents and @smithers-orchestrator/observability ships to npm — `packages/agents/src/BaseCliAgent/BaseCliAgent.js:5-6 and apps/observability/src/_traceEventNormalizers.js:1-2`
- _(architecture)_ observability is a foundational library but lives in apps/ (package masquerading as an app) — `apps/observability/package.json`
- _(architecture)_ .smithers workflow pack (a shipping target) is excluded from the dependency-boundary check and imports undeclared react/effect — `scripts/check-dependency-boundaries.mjs:13 (workspaceRoots/directWorkspaceDirs) and .smithers/package.json`
- _(architecture)_ Subpath exports point their `types` condition at the barrel index.d.ts, which does not contain the subpath's symbols — `packages/agents/package.json (exports "./BaseCliAgent".types -> ./src/index.d.ts)`
- _(architecture)_ Three workspace packages (accounts, usage, tool-context) are missing from the root tsconfig paths map — `tsconfig.json:24-234 (paths)`
- _(architecture)_ smithers <-> cli package cycle exists (bin delegates dynamically; cli imports smithers statically) — `packages/smithers/src/bin/smithers.js:138 and apps/cli/src/*.js`
- _(architecture)_ Root package.json exports map is a dev-only alias that diverges structurally from the actually-published exports — `package.json:18-40 vs packages/smithers/package.json exports`
- _(architecture)_ Published smithers-orchestrator ./* wildcard publicly exposes internal helper files — `packages/smithers/package.json (exports "./*" -> ./src/*.js)`
- _(test-gap)_ No automated guard that every documented public subpath export resolves — `e2e/exports/programmatic-api.test.ts`

**`ci-gating`** (4)
- _(test-gap)_ Gateway OpenAPI drift check is gated only via faults.yml's `pnpm -r build`, not in the primary CI job — `.github/workflows/faults.yml:33`
- _(test-gap)_ jj platform packages' prepublishOnly binary-presence validation never runs on PRs — `packages/jj-darwin-arm64/package.json:1`
- _(architecture)_ Full e2e suite runs in the test job without the build step that faults.yml deems necessary — `e2e/package.json:1`
- _(test-gap)_ examples/ bun test (porting-rules.test.ts) never runs in CI — same untested-directory root cause as the smithers gap — `examples/bun-port-smithers/components/porting-rules.test.ts:14`

**`systemic-synthesis`** (2)
- _(clean-code)_ isRecord / isObject / asRecord predicate family re-implemented across 7+ packages with divergent bodies; 99 inline error-message extractions — ``
- _(architecture)_ apps/cli is also published from apps/ (non-private @smithers-orchestrator/cli) — apps/ contains 2 shipping packages, not the conventional zero — `apps/cli/package.json`

---

## Per-area summaries

### `packages/engine` — solid
packages/engine is large (28k+ lines of JS) and generally well-engineered: most small/medium modules have focused unit tests with error-path and boundary coverage (json-extraction, cache-policy, aspects, diff-bundle, deferred-state-bridge internals, single-runner, entity-worker, versioning), and durability/bridge seams are DI-friendly and tested. Against a ~100% bar it falls short in two areas: (1) substantial dead/obsolete code — an entire ~1759-line legacy engine body kept behind a rollback flag whose migration plan said to delete it, a fully-unused deferred-bridge.js module, an unconsumed RPC schema module, and several dead exports in durable-deferred-bridge.js; and (2) under-tested complex units — the 716-line AgentTraceCollector has one unit test, and optimization-artifact.js / task-compute-fns.js have zero direct unit tests despite being on the production render path. No correctness P0s found, but the obsolete legacy path and unused public exports inflate the surface and maintenance cost.

*Coverage:* High unit coverage on small/medium modules (~85-90%); notable gaps in AgentTraceCollector, optimization-artifact, task-compute-fns. Strong e2e (8 real-backend suites). 109 test files vs 106 src.

### `packages/db` — needs-work
packages/db is the SQLite/Postgres persistence core: a ~2750-line SmithersDb adapter over a dialect-agnostic SqlMessageStorage, plus zod→DDL, frame-codec delta encoding, schema migrations, runState derivation, and bounds validators. The shipped form is hand-JSDoc'd .js with type-only .ts stubs and a generated index.d.ts. The 354-test suite is solid on the happy paths it touches and on write-retry/transactions/frame-codec/zod-to-sql, but it leaves whole feature surfaces with zero coverage in this package (and several with zero coverage repo-wide), most notably the security-critical rawQuery read-only SQL guard and the high-level adapter's entire Postgres branch. The package also carries a large amount of dead/duplicated code: an entire unused in-memory storage module, parallel output/, frame-codec/, and loadInput/loadOutputs implementations, and dead dialect exports. Against a ~100%-coverage, no-dead-code bar this area falls short despite being functionally green.

*Coverage:* ~60-65% of adapter surface unit-tested in-package; SqlMessageStorage SQLite+Postgres well covered, but SmithersDb Postgres branches and ~18 adapter methods untested in-package

### `packages/agents` — solid
packages/agents is a large, well-structured adapter layer (101 src / 35 test files; 247 pass / 14 skip locally). The shared utilities (truncateToBytes, taskContextEnv, extractUsageFromOutput, sanitizeForOpenAI, normalizeCodexConfig, capability-registry, diagnostics happy paths) are genuinely well-tested with real subprocesses and a real MCP server (no mocks). However, against a ~100% bar there are concrete gaps: three CLI adapters' stream-json output interpreters (GeminiAgent, AntigravityAgent, VibeAgent) have zero unit coverage in CI; the doctor-report failure branches are entirely untested; the BaseCliAgent.stream() path (buildStreamResult/emptyUsage/asyncIterableToStream) is unused by the product and untested; the metric/observability emission path has no assertions; and the public ./BaseCliAgent subpath ships a types target that omits its actual runtime exports. No correctness bugs found.

*Coverage:* Unit ~75-80% of shared utils/SDK adapters; CLI-adapter interpreters uneven (OpenCode/Pi/Claude/Amp/Codex strong, Gemini/Antigravity/Vibe ~0 in CI). E2E: real (vibe/opencode/mcp) but skipped without CLIs.

### `packages/components` — solid
packages/components is in genuinely strong shape against the high bar: Bun reports 100% line/function coverage on every source file, 274 tests / 801 assertions pass, and the tests are real — many composites (Saga, TryCatchFinally, Poller, Kanban, Signal) are exercised end-to-end through runWorkflow against a real SQLite DB with no mocks, and unit tests assert on the extracted graph structure rather than just "renders without throwing". The public API surface (every exported component + util) is genuinely consumed via the umbrella package, docs, and the .smithers pack — no dead exports there. The shortfalls are: (1) the Aspects accumulator/tracking machinery is render-time plumbing that the graph extractor explicitly discards, plus an aspects/index.js barrel that nothing imports; (2) a real output-key collision in SuperSmithers when reportOutput is provided; (3) a no-op apply task in SuperSmithers; (4) inconsistent host-prop sanitization across structural components; and (5) a handful of small untested branches (Poller onTimeout=fail at runtime, EscalationChain default humanRequest + error/failed predicates, exact markdown table output).

*Coverage:* Unit/e2e: ~100% line+function coverage reported by bun (all src files 100%), but with a few untested behavioral branches noted below. E2E composites use real backends (real SQLite via createTestSmithers + runWorkflow) — no mocks.

### `packages/time-travel` — solid
The time-travel package is well-architected and unusually well-tested for its riskiest surface: jumpToFrame (rewind) has thorough coverage of validation, boundaries, rate-limiting, single-flight locking, atomic-transaction truncation, per-step failure injection + rollback, and durable audit recovery; diff/snapshot/fork/timeline/replay all run against real SQLite (and Postgres/PGlite in the engine package) with no mocks. All 133 tests pass and typecheck is clean. The gaps vs the high bar are concentrated in the VCS-versioning sub-module: the write half of the feature (tagSnapshotVcs) has no production caller, so the _smithers_vcs_tags table is never populated and every reader (loadVcsTag/rerunAtRevision/resolveWorkflowAtRevision) plus the CLI `replay --restore-vcs` flag silently no-op in production. Several success paths and a few error branches are only covered behind a jj-binary gate (skipped in CI) or not at all.

*Coverage:* High on the rewind/diff/snapshot/fork/timeline/replay core (~90%+ of branches); low on vcs-version success paths and a handful of error-fallback branches.

### `packages/smithers` — solid
packages/smithers is the public facade ("smithers-orchestrator"): ~40 of 53 source files are pure one-line re-exports of workspace packages (all 195 named exports verified to resolve cleanly at runtime), with the real logic concentrated in create.js, external/create-external-smithers.js, tools/*, ide/*, findSmithersAnchorDir.js, and bin/smithers.js. Typecheck passes and all 23 unit tests pass. The createSmithers/createExternalSmithers/tools surface is exercised thoroughly (exit-listener leak, hot-reload cache, UTF-8 truncation boundaries, network guards, durability snapshots, oversized inputs). Against the ~100% bar there are two real gaps: the entire src/ide/ subtree (~430-line Effect service + 95-line incur CLI + 13 type files) is orphaned — never imported anywhere in the repo, no MCP registration, no tests, no docs — and createSmithersPostgres / findFreePgPort plus several create.js branches have no in-package coverage (postgres is only indirectly tested from packages/engine, and bin/smithers.js delegation logic is untested here).

*Coverage:* Unit: tools/* and create.js (sqlite path) + external near-complete; createSmithersPostgres only covered indirectly (engine pkg, env-gated); ide/* 0% (orphaned); bin/smithers.js 0% in-package; findSmithersAnchorDir indirect-only. Roughly 60-65% of the package's real logic has direct in-package tests, dragged down mainly by the orphaned ide/ subtree and the untested bin + postgres paths. E2E: none in this package (facade; e2e lives in apps/cli + e2e/).

### `packages/scheduler` — needs-work
packages/scheduler is the pure decision engine: scheduleTasks (graph traversal -> runnable/wait/ready-ralph), buildPlanTree (XML -> PlanNode), and makeWorkflowSession (the EngineDecision state machine), plus small retry/backoff helpers and ~25 type-only .ts files. The core pure functions (scheduleTasks, buildPlanTree, computeRetryDelayMs, retryPolicyToSchedule, state-key helpers) are well-tested and the 102 tests pass. But makeWorkflowSession — the most complex file (862 lines) and the only stateful one — is badly under-tested: of its 19 service methods, 11 have ZERO unit tests, and the entire ralph-advancement, ContinueAsNew, Aspect-budget, deadlock, stable-finish, and orphan-recovery decision logic in decide() is untested. There is also a large dead/unexercised public API surface: the Scheduler/WorkflowSession Effect Tags + SchedulerLive are never consumed in production, and ~9 session methods (event/signal/cache/heartbeat/orphan/hotReload/approvalTimedOut/getSchedule/getCurrentGraph) are never called by any consumer (engine/driver/server). Tests also exercise the session in a config the engine never uses (engine always sets requireStableFinish + requireRerenderOnOutputChange true; tests never set them), so the production code path is effectively unvalidated at this layer.

*Coverage:* Pure functions (scheduleTasks/buildPlanTree/retry helpers): ~85-90% of branches. makeWorkflowSession decide() state machine: ~30-40% of branches (retry classification + try/catch/saga happy paths covered; ralph advance, ContinueAsNew, Aspect budget, deadlock, stable-finish, orphan recovery, event/signal/timer/cache/heartbeat handlers all uncovered). No e2e in-package (engine/e2e covers some indirectly).

### `packages/driver` — needs-work
The driver package is the execution heart of Smithers: WorkflowDriver (the base class ReactWorkflowDriver extends and the engine runs), SmithersCtx (the ctx object every workflow build() receives), and spawnCaptureEffect (the child-process captor every CLI agent uses). The leaf helpers (SmithersCtx output accessors, iteration-scope helpers, normalizeInputRow, withAbort, defaultTaskExecutor, spawnCaptureEffect) are very well covered — child-process testing in particular is excellent (timeouts, idle resets, EPIPE, truncation policy, detached kill fallback, concurrency). But the flagship WorkflowDriver run loop is essentially untested inside this package: its concurrency machinery (the #267 out-of-order completion drain) and its deferred-deps deadlock detection have NO test coverage anywhere in the repo, and a meaningful share of the class is only reachable via tests. Code quality and Effect usage are clean; the main risks are test gaps on correctness-critical, recently-added paths plus a public-type/runtime mismatch on RunOptions.

*Coverage:* Leaf utils + child-process ~95% (excellent); WorkflowDriver class direct unit coverage ~15% in-package (run-happy-path, initializeSession variants, unknown-decision only). Partial indirect coverage of the base run loop exists in packages/components/tests/driver.test.js, but the #267 concurrency drain and deferred-deps deadlock paths are 0% everywhere.

### `packages/memory` — needs-work
packages/memory is a thin, well-structured Drizzle-over-SQLite store (facts/threads/messages) with a clean Effect+Promise dual API, and the store CRUD happy paths are reasonably well tested (54 tests, all green). But it falls short of the high bar in three ways: (1) substantial scaffolding ships as documented-but-non-functional public API — TokenLimiter and Summarizer are pure no-op placeholders yet docs/skills bundles describe them as doing real work, and the entire MemoryService/createMemoryLayer Effect layer plus the &lt;Task memory&gt; recall/remember feature are never consumed by any runtime; (2) test coverage has real gaps on error paths (only getFact/setFact error wrapping is tested — 9 other store ops untested for failure), boundary conditions (ttlMs=0, undefined value, listMessages limit=0, deleteExpiredFacts cross-driver fallback, percent-encoding round-trip with literal %), and the exposed store handle is only null-checked; (3) dead/speculative surface — react-types.ts is unreferenced, four exported config types have zero consumers, and TaskMemoryConfig is defined three times with a diverging shape.

*Coverage:* Store CRUD happy paths well covered (~80%); overall ~55-60% because error paths (9/11 ops), boundary conditions (ttlMs=0, undefined value, limit=0, driver fallbacks), and the no-op processors' actual behavior are untested, and the Effect service layer is only happy-path covered.

### `packages/errors` — solid
packages/errors is a small, well-organized JS-with-type-stubs package (the error catalog, SmithersError class, tagged-error classes, and serialization/normalization helpers). The single test file is genuinely good — 64 tests, 537 assertions, parametrized over all 8 tagged errors, covering happy paths plus several real corner cases (Node errno false-positives, array details, legacy cause arg, inherited-key rejection). Typecheck and tests are green. Against the ~100% bar it falls short in three concrete ways: a committed generated d.ts that is stale (6 missing error codes, so the public KnownSmithersErrorCode type is wrong for consumers), a real correctness gap where isSmithersError mis-classifies EngineError causing toSmithersError to return a non-SmithersError, and dead code (the EngineError class/type and the tagged.js barrel are never used anywhere in the repo) that is entirely untested.

*Coverage:* Unit: ~85% of statements (1 test file, 64 tests, 537 assertions covering all 8 tagged errors + most SmithersError/toSmithersError/errorToJson paths). Notable uncovered: EngineError interactions, fromTaggedError default branch, tagged.js (0 tests), errorToJson cause/default-name assertions. E2E: N/A (pure library, no backend).

### `packages/server` — solid
packages/server is a large (10.7k LOC src) but generally well-built package: the Gateway is the backbone (WS + HTTP RPC, auth modes, webhooks, cron, timers, devtools streaming, extensions, time-travel) and has strong real-backend integration coverage (23 test files / 8.4k LOC, no mocks/route-fabrication anywhere — confirmed against the no-mocks rule). Effect usage is consistent, layering is clean, and the public API surface (createServeApp, startServer, route helpers) is genuinely consumed by the CLI and the smithers package. It falls short of the ~100% bar mainly via untested RPC methods and HTTP edge paths, a real backend-portability/correctness bug in runs.rerun, the entirely-unexercised ~1.4k-line stringified operator-UI app, and a handful of dead/stale type-and-parameter surfaces. None are P0; the bug and the test gaps keep it from "bulletproof".

*Coverage:* High unit+integration coverage of the Gateway core (handshake, auth modes incl. JWT/token/trusted-proxy, scope enforcement, run lifecycle, event streaming, approvals, cron, timers, out-of-process bridge, devtools snapshot/stream/diff/output, extensions) and the index.js HTTP server happy paths; real-backend e2e present and mock-free. Estimated ~80-85% line coverage, with concrete holes in 4 RPC methods, several index.js error branches, the WS connection-limit path, and the ~1.4k-line stringified operator UI (effectively 0% behavioral).

### `packages/graph` — needs-work
The production extractor (src/extract.js, src/worktree-path.js, src/utils/xml.js, src/validateForkSources.js) is well-structured and has strong unit coverage (157 passing tests, including fork validation, ralph scoping, parallel/merge-queue, worktrees, subflow/sandbox/wait-for-event/timer, aspects, retries). However the package carries a second, fully-divergent extractor (src/dom/extract.js) that is now used only by tests, creating a name-collision footgun (root extractFromHost !== dom/extract extractFromHost) and a real test-fidelity problem (two "roundtrip"/"external-host-node" tests exercise the legacy extractor, not the production one). The published type surface is broken: TaskDescriptor.forkSource is set at runtime and consumed by the scheduler/engine but is dropped from the generated index.d.ts, and the package compiles its JS logic with checkJs OFF, so this drift (and any future JSDoc type error) goes completely undetected. Several exported types are dead duplicates of canonical defs in other packages, and worktree-path.js has no dedicated unit tests.

*Coverage:* High line coverage of src/extract.js + utils; but checkJs disabled (types unenforced), worktree-path.js has no direct unit test, and src/dom/extract.js (~700 lines) is test-only/dead in product.

### `packages/openapi` — solid
packages/openapi is a small, clean, well-layered package (one-symbol-per-file JS+JSDoc with separate .ts type files, thin Effect wrappers, re-export aggregators). Line/function coverage is ~95-100% and 103 tests pass, but coverage is misleading: it measures lines executed, not behavioral branches. Several real correctness gaps exist with zero tests — additionalProperties-as-schema is silently dropped, typeless/numeric enums are ignored, non-JSON request bodies are silently dropped, repeated path params and param/body name collisions misbehave, Swagger-2.0/object inputs throw a misleading error, path-level parameters and mergeParameters precedence are entirely untested, and metric increments (including the duration-on-error gap) are never asserted. The "e2e" test is not a real e2e (it mocks globalThis.fetch); there is no real HTTP-server round-trip anywhere. None of these are P0 blockers, but against a ~100% / real-backend bar there is meaningful work.

*Coverage:* Line/function coverage ~95-100% (bun --coverage: most src files 100%, extractOperations.js 66.67% funcs, _specHelpers.js 80% funcs). Branch/behavioral coverage materially lower: additionalProperties-as-schema, numeric/typeless enums, non-JSON bodies, repeated path params, name collisions, path-level/$ref params + mergeParameters precedence, Swagger/object input, include+exclude combined, resolveBaseUrl localhost fallback, and all metric assertions are untested. No real-HTTP-server e2e (fetch is mocked).

### `packages/devtools` — solid
packages/devtools is a small, focused, well-tested package: 12 JS implementation files with JSDoc-typed `.ts` companions, a committed-and-in-sync `index.d.ts`, 75 passing tests, and clean typecheck. Core algorithms (diffSnapshots/applyDelta roundtrip, snapshotSerializer, DevToolsRunStore reducer) are exercised with good edge-case and regression coverage. Against the ~100% bar, however, there are real gaps: an asymmetric validation contract in applyDelta (addNode/updateProps accept malformed ops silently while replaceRoot validates), maxEntries that silently fails to bound flat scalar arrays, several untested branches (verbose logging, unknown engine events, orphan ToolCallFinished, getTaskState miss paths), and five package-level exports with zero external consumers. Most consequentially, the package's applyDelta API is misused by the published CLI (apps/cli/src/tree.js) in a way that breaks `smithers tree --watch` on the first delta — undetected because checkJs is off and no test drives a delta through the watch loop.

*Coverage:* Unit: high for core algorithms (applyDelta/diffSnapshots roundtrip, serializer, run-store happy paths) ~85-90% of statements, but several specific branches uncovered (verbose logging, unknown-event recording, malformed-op validation, maxEntries-on-scalars, getTaskState misses). E2E: N/A for this package; the cross-package CLI watch+delta path (which exposes a P1 applyDelta misuse) has no test driving a delta.

### `packages/gateway-react` — solid
gateway-react is a thin, well-architected React layer over @smithers-orchestrator/gateway-client: legacy context hooks (RPC/actions/extension) plus a TanStack-DB-backed sync registry (collections + useSync* hooks + typed gateway shortcuts). Typecheck is clean and all 38 unit tests pass. Effect is not used here (this is pure React/TanStack — appropriate). Architecture and naming are clear and consistently documented. Against the ~100% bar it falls short: several exported hooks have zero tests (useGatewayMutation, useGatewayRunStream), and important error/reconnect paths are untested — including a real bug where useGatewayExtensionStream never clears a stale error after a successful reconnect. There is one redundant committed build artifact (src/index.d.ts) and a couple of low-severity type-safety/consistency gaps.

*Coverage:* Unit: ~60-65% of branches. All 31 src files typecheck and 38 tests pass, but 2 exported hooks (useGatewayMutation, useGatewayRunStream) have no tests, and key error/reconnect/invalidate branches (extension-stream reconnect, mutation success+invalidate, connection offline/connecting, isAuthError status/code, action error path, createGatewayReactRoot success) are uncovered. E2E: N/A (library; verified only via React-reconciler unit harnesses + a docs-snippet tsc compile test).

### `packages/gateway-client` — needs-work
The HTTP RPC, WebSocket connection, backoff, and SyncKey layers are clean and well-tested (most files 100% line coverage). But the package falls short of the high bar in three ways: (1) a real correctness bug in streamRunEventsResilient's replay/flap detection that reads the wrong field — its test only passes because the in-repo fixture builds a non-faithful gap_resync frame; (2) large untested surfaces — gatewayCollectionDefs is 27% line coverage (workflows/runs/run/approvals/runEvents defs, runStatusFromFrame, runRowsFromFrame all untested) and createSmithersGatewayTransport's streamRunEvents branch (its primary production path) is entirely untested at 56%; (3) genuine dead/duplicated code — an empty stale src/index.d.ts that ships, an unused exported GatewayRequestFrame type, three unused gatewayKeys factories, and helper functions (isObject, isGatewayResponseFrame, withoutVirtualFields, asRecord) copy-pasted across 2-3 files.

*Coverage:* Unit ~80% lines overall but very uneven: gatewayCollectionDefs 27%, createSmithersGatewayTransport 56%, snapshotToGatewayRunNode 86%, createGatewayCollection 83%; core client/connection/backoff/SyncKey at ~100%. No e2e in this package (reconnect test uses a real in-process Bun WS server, which is good).

### `packages/usage` — needs-work
The library code is clean, well-documented, consistently structured (a dispatcher + per-provider probe adapters + pure parsers/formatters + a cache), and correctly degrades to `none` reports instead of throwing — the architecture matches its README and spec. But against a ~100% bar the test suite is thin: only 14 of 24 exported symbols are imported by the single test file, and ALL five network adapters and BOTH credential readers — the exact units the spec's testing section (`.smithers/specs/usage-and-limits.md` §11) prescribes fixture/temp-dir tests for — have zero coverage, including every 401/429/!ok/catch error branch. There is no e2e coverage of `smithers usage`. Plus a declared-but-unused dependency and two minor cache/parse correctness gaps. No dead code (all extra exports are deliberate public API, re-exported in index.js).

*Coverage:* ~40% of exported symbols have any test; pure parsers/formatters partially covered, all 5 adapters + both credential readers at 0%

### `packages/pi-plugin` — needs-work
The pi-plugin is reasonably clean and the DevToolsStore reconnect/ghost/gap-resync logic is well-considered, but it falls well short of the high bar. Test coverage is thin and concentrated: the entire documented `api/*` public surface (9 thin HTTP wrappers) has zero direct tests, five view files (RunTree, NodeInspector, Header, FrameScrubber) and the runtime DevToolsClient have no dedicated unit tests, and large swaths of DevToolsStore (scrubTo, rewind, returnToLive, ghost eviction/budget, stale banner, reconnect backoff, error paths) are untested. There are concrete bugs: a state-normalization mismatch that makes `/smithers-approve` and the active-run prompt miss waiting nodes whose raw state isn't the exact literal `waiting-approval`; a never-unsubscribed store listener (memory leak) plus a dead `dispose()` in RunInspector; and a system prompt that advertises `-u`/`-k` flag aliases that are never registered. There is also a committed generated `src/index.d.ts` that the exports map never references.

*Coverage:* Unit: ~25-35% by branch. Only 5 of 21 source files are imported by any test; api/* (9 files) and 4 of 5 view files and DevToolsClient have no dedicated tests. E2E: the two relevant e2e cases (case10 ghost-state, case13 collapsed-ancestor) are test.skip placeholders, so no live-backend e2e exercises this package's runtime.

### `packages/sandbox` — solid
packages/sandbox is well-structured and unusually well-tested for a security-sensitive boundary: bundle validation, path-escape/symlink defenses, transport runners (bubblewrap/docker/codeplane/sandbox-exec args), and the executeSandbox happy/review/concurrency paths are covered with real fixtures (in-memory SQLite, fake runtime binaries, real fs), 67 passing tests, ~95% line coverage on the core files. The biggest real defect is a packaging/type-surface bug: deep subpath imports (e.g. /sandboxPath, /effect/sandbox-entity, /effect/socket-runner) all resolve their .d.ts to index.d.ts which lacks those symbols, so strict TS consumers get TS2305/TS2459 — masked today only because the actual consumers are allowJs JSDoc files. Remaining gaps are concentrated in egress.js (zero direct unit tests; its validation/error branches are only hit incidentally), several untested executeSandbox error branches, exported-but-unused symbols, and one dead branch.

*Coverage:* Unit: high. bun coverage on sandbox src: bundle.js ~99%, execute.js ~95%, sandbox-entity.js 100% lines, socket-runner ~98%, http-runner ~96%, process-runner ~85% lines (error branches uncovered), egress.js ~91% lines but no dedicated test file. E2E: 1 real-backend e2e (e2e/faults/case23) covering provider egress delivery, no mocks. Overall ~88% line coverage with concentrated gaps in egress validation and several executeSandbox error branches.

### `packages/scorers` — needs-work
The package is small, focused, and broadly well-tested at the unit level (130 passing tests, including a real in-memory-SQLite e2e for the run→persist→aggregate lifecycle and a strong regression suite for judge-JSON parsing). However it falls short of the high bar in several concrete ways: a real correctness bug where `context`/`groundTruth` never reach scorers in actual execution (so `faithfulnessScorer` is effectively broken on a real run), hand-rolled SQL string interpolation in `aggregateScores`, a genuinely dead file (`react-types.ts`), and substantial test/file duplication (two parallel barrel shims plus ~7 overlapping test files) that inflates the file count without adding coverage. Public API surface (`aggregateScores`, `runScorersBatch`, the three LLM scorers) is re-exported but has no in-repo product consumer, which is acceptable for a published library but worth noting.

*Coverage:* High line coverage of the happy paths (~85-90% by eye); the gaps are specific branches and the un-exercised real-execution context plumbing, not whole files (except the type-only files).

### `packages/protocol` — needs-work
packages/protocol is a small, purely-declarative contract package: TypeScript types, four frozen error-code string arrays, and one version constant (all real logic like applyDelta lives in the separate packages/devtools). Typecheck, the 8-test suite, and the tsup --dts-only build all pass, and the committed index.d.ts is in sync with index.ts. Against the high bar, though, it falls short: roughly a third of its public surface is dead (the entire outputs.ts file, the ProtocolError type, the DEVTOOLS_PROTOCOL_VERSION constant, and the errors/*.ts type files), the same error contract is defined in four parallel places with no drift guard, three of the four error arrays are only loosely asserted in tests, and the workspace path mapping points at a non-existent index.js.

*Coverage:* 8 unit tests over the 4 error arrays + version constant; ~50% of the testable runtime surface is exact-asserted (only DEVTOOLS_ERROR_CODES uses toEqual). No drift/parity tests between the package's duplicate definitions. No e2e (declarative package; N/A).

### `packages/accounts` — solid
packages/accounts is a small, well-organized JSON-registry package (~/.smithers/accounts.json) with strong validation, atomic mode-0600 writes, and path-traversal hardening. Its single test file genuinely exercises the public surface against real temp dirs (no mocks) and hits 98.79% line / 100% function coverage. Against the very-high bar, three things keep it from bulletproof: a public export (accountToProviderEnv) that is dead (zero importers, false JSDoc) with its logic re-duplicated in two other places; a validation invariant ("configDir XOR apiKey, never both") that the docs assert but the parser does not enforce (a plaintext secret can leak into a subscription record); and the four ACCOUNT_* SmithersError codes are absent from the errors-package code registry that all 92 other domain codes are in. Several branch/input-class corners (apiKey:"" persistence, addedAt preservation, the defense-in-depth escape throw) are uncovered.

*Coverage:* Unit: 98.79% lines / 100% functions per `bun test --coverage` (only defaultConfigDir.js:36-39 uncovered), but several branch/input-class corners untested (addAccount apiKey:""/addedAt/model, accountsRoot empty-string, configDir+apiKey cross-contamination). E2E: N/A (pure library; no e2e expected).

### `packages/react-reconciler` — solid
The custom React 0.33 reconciler is well-structured, correct on the core mutation paths (createInstance/append/insertBefore/removeChild/commitUpdate/commitTextUpdate), and the keyed-move dedup regression is tested. Combined coverage from this package's own tests plus packages/components is high: index/context/driver/dom-renderer/jsx-runtime hit ~100%, devtools ~82%, and the host-config reconciler ~85% lines. Against the 100% bar there are real gaps: several host-config stubs and the core-peer error path are untested, the commitUpdate has untested defensive branches, and there are genuine defects — a depth-limited devtools fiber traversal that drops deeply-wrapped nodes, a dead prepareUpdate method (gone from react-reconciler 0.33), an orphaned core-types.js, a sideEffects:false vs top-level installRDTHook mismatch, and silent single-root truncation for top-level Fragments/arrays.

*Coverage:* Combined (this package's tests + packages/components tests): index/context/driver/dom-renderer/jsx-runtime ~100% lines; devtools/SmithersDevTools ~82-87% lines; reconciler.js ~85% lines (branch coverage notably lower — commitUpdate defensive branches and host-config stubs untested); core-peer.js ~75% lines (error/fallback paths untested). Package's own tests/ alone cover much less (devtools ~33%, reconciler ~82%) — real coverage depends on packages/components.

### `packages/vcs` — needs-work
packages/vcs is a small, focused, well-documented wrapper around jj/git discovery and workspace ops. The fake-bin unit suite (jj-workspace.test.js, resolve-jj-binary.test.js, vcs-tooling-status.test.js) is genuinely good and the real-jj suite (jj-real-repo.test.js) tests excellent corner cases (dirty trees, symlinks, abandoned changes, shell-meta injection, large binaries). But it falls short of the ~100% bar in two structural ways: (1) the durability-critical captureWorkspaceSnapshot + withSnapshotTimeout are tested ONLY in the real-jj suite, which is skipped on CI (Ubuntu, no jj on PATH, no jj-binaries in the workspace) — so on every PR these functions and the snapshot-timeout path run with ZERO coverage; and (2) several negative/error branches across vcsToolingStatus, resolveGitBinary, resolveJjBinary, and getJjPointer/captureWorkspaceSnapshot null-paths are untested. There is also one real portability defect (bare require in an ESM module), one orphaned dead file with diverged docs (WorkspaceSnapshot.ts), and a duplicated find-root test file.

*Coverage:* Fake-bin unit coverage of jj.js is high locally; but CI-effective coverage of captureWorkspaceSnapshot/withSnapshotTimeout/real-revert behaviors is ~0% (skipped when jj absent). Several error/negative branches untested even locally.

### `packages/control-plane` — solid
The control-plane store is well-built on the security axes that matter most: SQL injection posture is clean (all 30 query() calls parameterize with ?, every template-literal ${} is confined to error-message strings), input validation is thorough (SLUG_RE/ID_RE/timestamp/quantity/jsonObject all guard their inputs), and the secretRef-vs-plaintext invariant is satisfied by construction — the _smithers_cp_secret_refs schema has NO column capable of holding a secret value (only provider + ref), so it is structurally impossible to store plaintext (strictly better than the accounts package's runtime invariant). The significant defect is a correctness/semantics bug: checkUsageLimit treats the `period` field (daily/monthly) purely as a primary-key discriminator and NEVER derives a time window from it — the usage SUM is bounded only by caller-supplied sinceMs/untilMs which default to all-time, so a 'daily' limit silently sums usage from months ago. Secondary issues: error-handling is asymmetric (setUsageLimit/putSecretRef raise friendly SmithersError on missing project, but recordUsage/recordAuditEvent and all duplicate-slug conflicts leak raw SQLite Error objects), there is an unguarded JSON.parse on DB-stored JSON, and the test suite never asserts the conflict/constraint-failure branches despite reporting 100% line coverage. No dead code found.

*Coverage:* 100% line coverage (verified via bun test --coverage), but branch/error-path coverage is materially lower: UNIQUE-conflict paths, raw-SQLite-error propagation, and period-window semantics are unexercised.

### `packages/gateway` — solid
The canonical RPC contract (packages/gateway/src/rpc/index.ts) is internally consistent and well-tested for what it covers: 19 method definitions, 19 GatewayRpcMethod union members, 19 docs/rpc/*.mdx pages, and 19 paths in the committed openapi.yaml all agree, and check-docs.mjs hard-asserts exactly 19 (line 911). The audit prompt's premise of "22 definitions vs 19 docs (3 unaccounted)" is FALSE — it was inherited from a prior audit's raw-findings-full.json suggestedProbe, which miscounted; there are 19, with zero undocumented canonical methods. All 14 GATEWAY_RPC_LEGACY_METHOD_ALIASES round-trip correctly (verified programmatically), and every canonical method resolves a required scope. However, the REAL drift runs the opposite direction: 10 RPC methods served by the runtime (health, workflows.list, approvals.list, runs.diff, frames.list, frames.get, attempts.list, attempts.get, getDevToolsSnapshot, runs.rerun) are dispatched by packages/server/src/gateway.js but have NO entry in GATEWAY_RPC_DEFINITIONS — no schema, no error list, no docs page, no OpenAPI path. Four other concrete issues: (1) generate-openapi.ts's --check drift guard is ungated on PRs (only in the gateway `build` script; CI runs `pnpm test`, never `pnpm -r build`); (2) the rpc-contract.test.ts example-validation is schema self-validation, not a round-trip, and is near-tautological for the ~9 opaque (additionalProperties:true, empty properties) response schemas; (3) the `approve` entry in getRequiredScopeForGatewayMethod maps a method the runtime never dispatches (vestigial); (4) the JsonSchema type declares anyOf/format/default/maximum fields that no schema uses and the test validator does not handle.

*Coverage:* ~85% line coverage of the contract package's behavior; the gaps are in cross-boundary agreement (contract<->runtime<->TS types), the OpenAPI generator (0% test coverage), and several opaque-schema example checks that are near-tautological.

### `packages/tool-context` — solid
@smithers-orchestrator/tool-context is a clean, genuinely self-contained extraction. toolContext.js (53 LOC) is correct on every branch I exercised by hand, the extraction broke the cycle as designed (zero runtime deps — only node:async_hooks; no engine/smithers re-imports; both engine and smithers depend on it via workspace:*), and Bun reports 100% line/function coverage with the suite green. The two real issues are: (1) coverage is 100% by LINE but the 31-line test misses several BRANCHES that share a line with covered code — the empty-string idempotencyKey fall-through, non-string idempotencyKey, the iteration ?? 0 default, the missing-runId side of the \|\| , the default-parameter ctx=getToolContext() path, runWithToolContext's throw-restores-context behavior, nested contexts, and nextToolSeq honoring a pre-existing seq. I wrote throwaway tests for all of them and they all pass, so these are test-coverage gaps, not bugs, but they fall short of the stated ~100%/error-and-boundary bar. (2) The package's public TYPE surface is entirely Record<string, any>: the functions read specific fields (runId/nodeId/iteration/idempotencyKey/seq) but expose no typed shape, so a direct importer of this package gets zero type safety — only consumers going through smithers' tools.d.ts (which re-declares the strong ToolContext) are protected. Plus a minor latent package.json ./* subpath mis-mapping (currently unused). Source quality is high; gaps are in tests and type ergonomics.

*Coverage:* 100% line/function (Bun), but ~60-70% branch coverage by manual analysis: ~8 distinct branches/boundary paths in getToolIdempotencyKey, runWithToolContext (throw/restore, nesting, return value), and nextToolSeq (pre-existing seq) are unasserted though correct.

### `apps/cli` — needs-work
The smithers CLI has broad command coverage (~60 top-level + grouped subcommands), no mocks in e2e tests, strong docs-vs-command coverage gates, and thorough semantic-MCP and devtools-JSON unit tests. But against the high bar it falls short in three ways: two real shipping bugs (`snapshots --json` / `timeline --json` emit unparseable stdout; `cron`/scheduler spawns a non-existent `src/index.js`), several genuinely dead files/exports, and untested core argv-parsing plus several whole commands (cron, scheduler, revert_attempt MCP tool, MCP --surface selection). The 6,400-line index.js also carries inconsistent JSON-flag handling that the existing stdout-contract test does not cover for every command.

*Coverage:* Unit/e2e coverage is high for the read/devtools/format/semantic-MCP/init/agent-wiring surface (66 test files, no mocks, real SQLite + real fake-agent binaries), but there are clear holes: argv-utils.js (0 tests), scheduler/cron (0 tests), MCP --surface selection (0 tests), revert_attempt MCP tool (0 tests), and the JSON-stdout contract omits snapshots/timeline/scores. Estimate ~75-80% effective coverage of the in-scope CLI surface.

### `apps/observability` — needs-work
The observability package is real and heavily consumed (87 import sites across packages/*), with a well-structured metric catalog, agent-trace normalization pipeline, OTLP/log builders, and a bundled Grafana/Prometheus/Tempo/Loki Docker stack. The agent-trace capability and redaction logic is reasonably tested. However, against the high bar there are two serious gaps: (1) a large block of dead code — the entire in-memory MetricsService implementation in src/_coreMetrics.js (makeInMemoryMetricsService, MetricsServiceLive, MetricsServiceNoop, a duplicate 114-entry metric catalog) is exported but never imported anywhere; the live MetricsServiceLive comes from src/MetricsServiceLive.js. (2) Thin/assertion-free testing of the most logic-heavy code: the 608-line trackEvent router is exercised only with "does-not-throw" runs (no metric value/label assertions, and the AgentEvent + all Sandbox branches are untested), and the correlation module, tracing layer, and OTLP-layer factories have zero tests. The 230/8 src/test ratio is NOT justified — much of it is per-metric one-liners (genuinely thin glue), but the routing/correlation/tracing core is substantive and undertested.

*Coverage:* Unit: ~40-50% of meaningful logic. Per-metric definition files and the agent-trace capability/redaction/normalize wrappers are covered; the substantive routing (trackEvent), correlation, tracing layer, OTLP layer factories, and Prometheus Frequency/Summary rendering are unverified. trackEvent's 35+ tests are assertion-free. E2E: N/A (no real-backend OTLP→collector→Prometheus/Loki/Tempo integration test exists; the only CLI test asserts file presence in package.json).

### `apps/review` — solid
apps/review is a real, shipping feature — not a POC. It is a standalone package (`@smithers-orchestrator/review`, private but consumed via the GitHub composite action `smithersai/smithers/apps/review/action@main`), it is dogfooded on every PR in this repo via `.github/workflows/pr-review.yml`, and its Cloudflare Worker (sessions + OIDC + metered Anthropic proxy + R2 walkthrough hosting + Prometheus metrics) is deployed live at review.jjhub.tech. Code quality is high: small single-purpose modules, consistent escape-first HTML rendering, careful security primitives (constant-time compare, hashed tokens, OIDC verify with tagged failure reasons), and a clean deps-injected worker for testability. typecheck and the 66-test suite pass. The bar is missed in two places: the entire GitHub PR-posting path (`src/github/*` except the pure payload builder) and the R2 publish/serve path (`/api/walkthroughs`, `/w/<id>`) have no unit/integration coverage — only a CI-skipped live e2e — and several proxy/metering branches and pure helpers are untested. There is one confirmed piece of dead code and a real default-publish-URL defect.

*Coverage:* ~60% line/branch. Walkthrough rendering, story normalization, fallback story, PR payload builder, OIDC session minting, quota, proxy SSE happy-path, admin upsert/keys, and the agentless engine e2e are well covered. Untested: all of src/github/ except buildPullRequestReview, /api/walkthroughs + /w/ serving, /api/admin/usage, src/cli/main.ts, action drivers (runGate/runAction/runReview/fetchOidcToken), createReviewAgents, writeOpenAiSchemaFile, and several proxy/parse helpers + branches.

### `examples` — needs-work
The examples/ tree (~108 .jsx/.tsx workflows; 97 top-level + 7 directory-based projects) is NOT covered by any CI gate. The repo defines `typecheck:examples` (package.json:67, `tsc -p examples/tsconfig.json --noEmit`) but it is invoked NOWHERE — not in .github/workflows/ci.yml, not in `pnpm test`, not in any script or hook. CI's typecheck job runs `pnpm -r typecheck` + `pnpm --filter ./.smithers typecheck`; examples/ has no package.json and is absent from pnpm-workspace.yaml (only packages/*, apps/*, e2e, .smithers), so `-r` skips it entirely. The two "smoke tests" the task names do NOT exercise examples/ at all: docsExamplesCompile.test.ts compiles only 2 files from docs/examples/ (workflow-ui-react.mdx, workflow-ui-vanilla.mdx), and docs-examples-smoke.test.js globs docs/**/*.mdx code fences — neither reads the repo-root examples/ directory. I confirmed zero tests load any examples/*.jsx file. Net: 0% of the examples tree is gated. I ran `pnpm typecheck:examples` manually — it passes clean (exit 0, 0 TS errors), so the examples DO currently compile; the gap is purely that nothing runs it, so future drift will land silently. Staleness is the real damage already present: 274 occurrences of the deprecated model `claude-sonnet-4-20250514` (Claude Sonnet 4, retires 2026-06-15 per the Anthropic catalog; replacement is claude-sonnet-4-6) across 93 of 97 top-level workflows, plus a hallucinated `claude-sonnet-4-7` in ralph-loop.jsx:9 that does not exist in the catalog (there is no Sonnet 4.7 — only Opus 4.7). These typecheck only because ClaudeCodeAgentOptions.ts:47 types `model?: string` (open string), so invalid IDs pass tsc but would fail at runtime against the `claude --model` CLI flag.

### `docs-human` — needs-work
The For Humans guide is well-written, internally consistent, and almost entirely accurate to the current tool: every documented workflow ID, CLI command, flag, model ID, and example link I spot-checked against the actual code/pack resolved correctly, and every referenced image exists. The narrative thesis ("you drive Smithers through your agent, not a GUI you click") is strong and consistent. However, it fails one explicit maintainer requirement squarely: docs/guide/watch-and-steer.mdx (in the "For Humans" tab) devotes two large sections to out-of-scope product UIs — "Studio: the visual console" (the retired apps/smithers-studio-2 POC, even leaking the repo-internal `pnpm dev:studio` dev command) and "the installable Smithers web app"/PWA (apps/smithers, whose UI lives in a separate repo). This both violates the "no product-UI prose" rule and directly contradicts the page's own "no GUI required" thesis. There is also one stale starter (idea-to-prd) documented that does not exist in the gallery, and the README's hero GIF alt text still says "Smithers Studio."

*Coverage:* N/A (documentation area). Human-facing workflow coverage is strong: every built-in workflow in what-you-can-do.mdx has a screenshot and all exist; common CLI commands are documented; "under the hood" overview is covered by how-it-works.mdx and per-section "Smithers runs" tables.

### `docs-agent-llms` — solid
The For Agents documentation and LLM bundles are in strong shape and meet a high bar. I verified the generated bundles are NOT stale: running the full pipeline (`bun scripts/generate-llms.ts` then `bun scripts/optimize-llms-full.ts`, which is exactly what `check-llms.mjs` gates on) produces zero diff against the committed `llms*.txt`, `skills/smithers/llms-full.txt`, and `apps/cli/docs/*`. The reference docs are accurate and complete against actual exported code: all 92 `SmithersError` codes plus the HTTP-server codes are documented in `reference/errors.mdx`; all 67 engine event types are documented in `reference/event-types.mdx`; all 19 RPC pages match `GATEWAY_RPC_DEFINITIONS` exactly (methods, scopes, errors, request/response shapes); and memory/openapi/effect/runtime exports all match. The one clear defect is stale Claude model IDs: 7 example pages teach the old `claude-sonnet-4-5-20250929` while the CLI scaffolder and the rest of the docs use the current `claude-sonnet-4-6`/`claude-fable-5`/`claude-opus-4-8`. A couple of minor type-drift and orphan-file nits round it out.

*Coverage:* N/A (docs area). Bundle-generation drift is gated by scripts/check-llms.mjs + check-docs.mjs; verified clean by regenerating locally.

### `workflow-ui-doc-coverage` — needs-work
The canonical init pack (ground-truthed by running initWorkflowPack into a temp dir) installs 30 workflows; every one has a docs/workflows/*.mdx file, but only 17 ship a custom UI (.smithers/ui/<id>.tsx). 13 canonical workflows ship with NO UI, so the maintainer requirement "every built-in init workflow should have a UI" is not met. The shipped pack is clean of the scratch/demo workflows named in the task (fix-six-issues, demo, dynamic-demo, smoketest, studio-parity-swarm, roadmapbench, repo-prospector, real-stack-e2e, etc. exist only in the repo's dogfooding .smithers/ and are NOT installed by init). The workflow-to-UI wiring is purely positional filename convention with no error/warning when a UI is missing, and several docs/test surfaces (overview.mdx, catalog.mdx, docs.json nav, the UI e2e descriptor set) have drifted out of sync with the actual 30-workflow / 17-UI set.

*Coverage:* UI: 17/30 canonical workflows (57%) ship a custom UI. Docs: 30/30 have an .mdx file, but only 16/30 linked from overview.mdx and 1 (monitor) missing from docs.json nav. UI e2e: 16/17 shipped UIs functionally asserted (kanban omitted from workflow-ui-all.e2e.test.js descriptors).

### `smithers-ui-system` — solid
The custom-workflow-UI system is genuinely well-built: TanStack DB is used idiomatically (one `createCollection` per `SyncKey` fingerprint in `createGatewayCollections`, real `useLiveQuery` subscriptions, optimistic mutations with rollback in `useSyncMutation`, surgical diff reconciliation in `createGatewayCollection.replaceRows`/`reconcileSnapshotNodes`, bounded ring buffers, and a per-collection `gcTime` lifecycle that gives clean run-to-run isolation). The render/serve path (real Bun.build bundling, boot config, HTML shell) is real and well-tested, and there is a strong NON-MOCK browser e2e (`workflow-ui-all.e2e.test.js`) that builds+boots all 20+ init-pack UIs and executes a subset for real-output verification. The gaps that keep it from "bulletproof": (1) the declarative TanStack-DB sync hooks (useSyncQuery/Mutation/Subscription, useGatewayQuery/Mutation/RunStream/RunTree/ConnectionStatus) — the explicit "use TanStack DB properly" surface — have NO real-browser e2e in-scope (only a happy-dom reconciler test); none of the shipped reference UIs exercise them. (2) The `smithers ui` CLI command's resolution/autostart/error logic is entirely untested. (3) The gateway's own default operator console is 1432 lines of hand-rolled vanilla JS that re-implements the whole wire protocol instead of dogfooding the published SDK. (4) Several pure mapper branches and a couple of small hook-correctness/doc-mismatch issues.

### `adapters-e2e` — solid
The 13 adapters split cleanly into 3 SDK agents (Anthropic, OpenAI, Hermes — built on `ToolLoopAgent`) and 10 CLI agents (built on `BaseCliAgent`). The CLI adapters are uniformly well-architected: each implements `buildCommand`, a streaming `createOutputInterpreter`, a capability registry, and resume wiring, and the shared `BaseCliAgent` handles timeouts, token-usage normalization, truncation, diagnostics, and metrics consistently. Test quality is genuinely high for the well-covered adapters: Pi, Claude, Codex, Forge, OpenCode all spawn a real fake CLI binary (true subprocess, no mocks) and exercise buildCommand + interpreter; OpenCode and Vibe additionally have `which`-gated real-CLI e2e. However, two shipping adapters have NO behavioral tests at all (Hermes — confirmed zero references anywhere; Gemini — only incidental config/capability references, no buildCommand/interpreter test despite being fully wired into the CLI), one adapter cannot resume sessions (Amp), and there are export/structural inconsistencies (capability-registry re-exports, OpenCode's hand-written `.ts` declaration). No SDK-mock e2e violations were found — the SDK-agent tests legitimately use `MockLanguageModelV3` for the AI SDK path, and the CLI-agent tests use real subprocesses.

*Coverage:* CLI adapters: ~8/10 have real fake-binary or real-CLI behavior tests; SDK agents 2/3 (Anthropic+OpenAI tested, Hermes 0). Gemini + Hermes have no behavioral coverage. ~36 agent test files total.

### `e2e-suite` — shaky
The dedicated fault-injection suite (e2e/faults, the per-PR `faults.yml` gate and `faults-nightly.yml` soak) badly misses the no-mocks / real-backend bar: of 30 cases, only 2 (case23, case25) exercise real product code, 22 fabricate their own `CREATE TABLE _smithers_*` schemas and reimplement the very feature under test (rewind, gateway RPC, approvals, webhooks, scorers, diff-review, replay safety) as in-test helper functions, and 6 are empty skip-only stubs. These fabricated cases would pass even if the real engine/gateway/time-travel code were entirely deleted — they test a hand-rolled mirror of the contract, not the contract. The harness primitives (killProcess, dropWebSocket, freezeSqliteLock, skewClock, takeoverRun, corruptHeartbeat) are genuinely real and well-tested, and the SEPARATE package-level `*.e2e.test.*` suites (engine durability/snapshots/fork/resume-with-time-travel, time-travel timetravel/retry-task, server gateway-edge, apps/cli init/signals/ask-human/workflow-ui) ARE real-backend and constitute the actual e2e coverage. case25 proves the real `@smithers-orchestrator/server/gateway` boots fine inside the e2e package, which makes the "effect/devtools resolution fails" skip rationale in case14/case17 obsolete and false. Coverage gaps with NO real happy-path e2e anywhere: crons (scheduler), sandbox suspend/resume + auth persistence, secret redaction, file/VCS pointer integrity, browser-automation runtime, OpenAPI tools, memory, eval/optimize, and the `smithers ui` custom-workflow-UI runtime beyond the studio-2-dependent screenshot test.

*Coverage:* e2e/faults: 2/30 cases test real code (~7%); 22/30 fabricate schema+logic; 6/30 empty stubs. Real e2e coverage lives almost entirely in the separate package-level *.e2e.test.* suites.

### `skills` — solid
The skill pack is well-written, well-scoped, and largely accurate: every referenced seeded workflow (context-engineer, route-task, create-workflow, create-skill, eval-author, report-slideshow, monitor-smithers, studio-parity-swarm) and component exists, CLI commands/flags/arg-orders (diff/output/scores/eval/ps --status/observability --detach\|--down/--hot) check out, and the descriptions have good trigger phrasing. Crucially, skills/smithers/llms-full.txt is byte-identical to docs/llms-full.txt and apps/cli/docs/llms-full.txt and is fully fresh against the MDX source (confirmed by running the full `generate-llms.ts && optimize-llms-full.ts` pipeline — zero drift). The gaps are concrete code-snippet inaccuracies that would not run as written: two wrong scorer signatures and an entirely wrong llmJudge config shape in eval-writer, a copy-paste-breaking `runId` vs `targetRunId` input in report-maker plus a false monitor/slideshow attribution, one fabricated node id in context-engineer, and a couple of CLI/component mislabels in the big SKILL.md. None are structural; all are fixable line edits.

*Coverage:* N/A (skills are docs, not code with test coverage). Bundle freshness verified by re-running the generator pipeline (zero drift). Accuracy spot-checked against source for ~30 distinct claims (scorers, components, CLI commands/flags/arg-order, seeded workflow names, engine injection behavior).

### `missing-features` — solid
The advertised CLI/workflow/agent/component surface is overwhelmingly real: all README-listed built-in workflows ship in .smithers/workflows and the init pack, every named agent harness (Claude Code, Codex, Gemini, Pi, Antigravity, etc.) is implemented, eval/optimize/observability/hot-reload all have genuine implementations, and the exported component set matches the docs. Against the high bar, though, several documented capabilities are stubs or non-functional: two of three "memory processors" (TokenLimiter, Summarizer) are no-op placeholders despite docs promising token-budget trimming and LLM compression; the `smithers gui` command launches a native app bundle (com.smithers.SmithersGUI) that is not built or shipped from this repo; and the DEFAULT semantic MCP surface (the primary way agents drive Smithers per the README) omits the flagship time-travel/durability controls (fork, rewind, replay, timeline, restore, snapshots, signal, cancel, retry-task), forcing agents to shell out to the CLI. A few minor CLI-completeness gaps round it out (openapi has no generate verb, memory/cron are read-only/partial).

*Coverage:* N/A (feature-completeness review, not a coverage measurement)

### `architecture-deps` — solid
The package layering is largely a clean DAG: errors/protocol/gateway are true leaves, graph→errors, and the build of tool-context was deliberately extracted to break an engine↔smithers cycle (its package.json description even says so). The exports map resolves correctly (all 17 root export targets exist; the published smithers-orchestrator package backs every public subpath with re-export shims). However there are real holes: exactly one package-graph cycle (agents ↔ observability) that ships to npm, a foundational library (observability) misplaced under apps/, three packages missing from tsconfig paths, and the dependency-boundary checker has two concrete blind spots (it scans zero files for e2e and skips the .smithers shipping target entirely, which imports undeclared react/effect). Effect adoption is uneven (graph and components import effect in 0 files) but that is acceptable rather than a defect. The single-effect-version gate is sound and effect is deduped to one version across both lockfiles.

*Coverage:* N/A (architecture review, not measured)

### `ci-gating` — needs-work
CI for smithers-the-tool is two correctness workflows: ci.yml (PR+push) runs check:effect, check:deps, `pnpm -r typecheck`, `.smithers typecheck`, then the `pnpm test` gate (= check:effect && check:deps && check:docs && check:llms && pnpm -r test); faults.yml (PR+push) runs `pnpm -r build` then e2e test:faults. The "no mocks" + "~100% coverage" + "clean architecture" bar is NOT fully enforced. Most severe: the flagship published package `packages/smithers` (smithers-orchestrator) has NO `test` script, so `pnpm -r test` silently skips its 4 unit test files — the flagship's unit tests never run on PRs. There is no lint (oxlint) gate anywhere, no coverage measurement anywhere (so the ~100% bar is unmeasured), and `typecheck:examples` (22 user-facing reference workflow files with their own tsconfig) never runs because `examples/` is not a workspace package. The gateway OpenAPI drift check (check:openapi) IS enforced, but only transitively via faults.yml's `pnpm -r build` (it lives inside gateway's `build` script), so OpenAPI/dts-build validation is coupled to the faults job rather than the primary CI job. Positives: workflow-pack drift IS gated (apps/cli seeded-pack-fresh.test.js, runs under pnpm -r test), check:docs/check:llms drift gates exist, and `pnpm -r typecheck` does cover apps/cli, e2e, server, gateway, review, observability.

*Coverage:* Reviewed all 4 workflow YAMLs, root package.json scripts, and every package/app/e2e/.smithers package.json build/check/test script; traced each generator's --check/drift mode and the pnpm -r test/build/typecheck scope. High confidence on the gating map.

### `systemic-synthesis` — needs-work
Repo-wide synthesis surfaced four systemic, root-cause defect classes that recur across the published packages, each fixable with a single policy change rather than per-package nits. (1) checkJs is off everywhere: 27 package/app tsconfigs set allowJs:true but omit checkJs (defaults false), so the bodies of 831 .js source files (503 carrying JSDoc @param/@returns/@type) are never type-checked by `tsc --noEmit` / CI typecheck — JSDoc types feed the shipped .d.ts but are unverified against the implementation. (2) 28 packages COMMIT a tsup-generated bundled src/index.d.ts into source control and ship it as the exports-map `"types"` entry; dist/ is gitignored, so the committed .d.ts IS what consumers consume and it can drift from runtime .js. A drift guard exists ONLY in scripts/publish.mjs (it even cites how 0.24.0 shipped a stale smithers/src/index.d.ts), but CI never runs `pnpm -r build` + git-diff, so stale d.ts merges into main undetected between releases — and packages/errors/src/index.d.ts is demonstrably stale (committed 2026-04-17 vs its .js last changed 2026-06-16). (3) The same micro-helpers are re-implemented across 7+ packages with subtly divergent bodies (isRecord in agents, components, db x4, devtools, errors, pi-plugin, cli — variants `value != null`, `Boolean(value)`, `Boolean(value && ...)`; isObject in engine/gateway-client x3/cli; asRecord x2) plus 99 inline `err instanceof Error ? err.message : String(err)` extractions — no shared util package owns these predicates. (4) The published @smithers-orchestrator/observability package physically lives under apps/ yet is non-private and depended on by 14 published workspace packages (50 import sites under packages/*/src), and it forms a true publish cycle with agents: observability imports @smithers-orchestrator/agents/BaseCliAgent while agents imports @smithers-orchestrator/observability — a layering/resolution hazard for external consumers and for monorepo build ordering.

*Coverage:* High confidence on all four systemic findings — each is grep/read-confirmed with exact file lists, line numbers, and (for drift) git-history timestamps. checkJs gap: 27 tsconfigs confirmed via grep + tsc --showConfig. Committed d.ts: 28 packages + exports-map + gitignore + publish.mjs drift-guard text confirmed. Helper duplication: bodies compared across 7 packages. observability cycle: confirmed at both package.json (lines 42/63) and code-import level. Not exhaustively enumerated: every individual JSDoc/d.ts mismatch (would require building each package and diffing), and the full inline-error-message site list (count 99 confirmed, not individually cited).

---

## Systemic recommendations (policy-level, fix once)

These recurred across many areas; fix the policy, not the symptom:

1. **Turn on `checkJs` repo-wide.** All 27 packages have it off; 831 `.js` source files (503 with JSDoc types) ship unverified — this already caused shipped bugs (`smithers tree --watch` crash, `TaskDescriptor`/error-code type drift).
2. **Stop committing generated `src/index.d.ts`** (28 packages) — generate at build + `.gitignore`, or add a CI drift-guard. Today the only guard runs at publish, so PRs ship drifted public types.
3. **Enforce the bar in CI:** add a coverage gate, an `oxlint` gate, and a `test` script to the flagship `smithers-orchestrator` package (currently its unit tests never run). Run build-only drift checks (`gateway check:openapi`, workflow-pack drift, `typecheck:examples`) on PRs, not just at publish.
4. **Make e2e actually e2e.** Replace the 22 fabricated-schema fault cases and the skipped real-path cases with tests that drive the real product (the seeded-fake-agent / browser-skip pattern is fine; fabricating the contract is not).
5. **De-stub or remove advertised features:** `AlertRuntime`, memory `TokenLimiter`/`Summarizer`, `smithers gui`/`smithers .`, live-run faithfulness scoring, `AmpAgent` resume.
6. **Dedupe + delete dead code** (66 findings): orphaned `ide/` (~570 LOC), `db/storage/` (~763 LOC), engine legacy body (~1759 LOC), `deferred-bridge.js`, `rpc-schema.js`, time-travel `types.ts`, duplicated helper families, etc.
7. **Move `observability` to `packages/`** — it's published as `./observability`, consumed by 14 published packages, but lives under `apps/` and forms a publish cycle with `agents`.
8. **Refresh `examples/`** — 93 of 97 use a deprecated model ID (274 occurrences) and one references a nonexistent `claude-sonnet-4-7`; neither "examples smoke test" actually exercises the tree.

---

## Filed issues

All 423 findings are tracked as 9 themed checklist epics in `smithersai/smithers`:

- [#299](https://github.com/smithersai/smithers/issues/299) — 🔴 P0 critical blockers (4)
- [#300](https://github.com/smithersai/smithers/issues/300) — 🏛️ CI enforcement, architecture & systemic policy (34)
- [#301](https://github.com/smithersai/smithers/issues/301) — 🧹 Dead code cleanup (66)
- [#302](https://github.com/smithersai/smithers/issues/302) — 🧩 Stubbed & missing features (17)
- [#303](https://github.com/smithersai/smithers/issues/303) — 🐛 Bug fixes (50)
- [#304](https://github.com/smithersai/smithers/issues/304) — 📝 Documentation & skills accuracy (47)
- [#305](https://github.com/smithersai/smithers/issues/305) — ✅ Test coverage gaps — core library packages (67)
- [#306](https://github.com/smithersai/smithers/issues/306) — ✅ Test coverage gaps — apps, gateway, UI, e2e, examples (90)
- [#307](https://github.com/smithersai/smithers/issues/307) — ♻️ Code cleanup & refactors (48)

*This document is generated from `audit/raw-findings-full.json` via `audit/generate-report.mjs`.*
