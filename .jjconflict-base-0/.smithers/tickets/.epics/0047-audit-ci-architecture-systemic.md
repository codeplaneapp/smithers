# CI enforcement, architecture & systemic policy

> Target repo: **smithers** (this repo)
> Source: GitHub issue [#300](https://github.com/smithersai/smithers/issues/300) · 2026-06-16 bulletproof audit
> Triaged 2026-06-18 against `main` (post-#442 merge train): 0 of 34 resolved.
> Re-verified 2026-06-20: **5 of 34 landed, 29 still open** (the 5 are the CI-gate items below: lint, typecheck:examples, examples bun test, e2e dependency-boundary scan, tsconfig paths).

## Context

Systemic gaps the post-audit bugfix wave did not touch: CI is still not enforcing the bar (no lint/coverage/build/examples gates), dependency-boundary and exports-map drift, checkJs off almost everywhere, duplicated predicate helpers, and the monolithic CLI entrypoint. These need dedicated policy/architecture PRs, not point fixes.

Each item below is still open in current `main`. Text is the original audit finding (severity + file:line). `remaining:` notes come from the 2026-06-18 verification pass. Check items off here as they land, and mirror the check-off on issue #300.

## Open items

- [ ] **P2** index.js is a 6,439-line monolith mixing parsing, ~60 command bodies, MCP wiring, and helpers — `apps/cli/src/index.js (6439 lines)`
  - _remaining:_ No extraction performed; monolith remains and grew larger.
- [x] **P1** dependency-boundary check scans ZERO files for the e2e workspace (directWorkspaceDirs entry is effectively dead) — `scripts/check-dependency-boundaries.mjs:101 (filesForPackage)`
  - _done (2026-06-20):_ `directWorkspaceDirs = ["e2e"]` (scripts/check-dependency-boundaries.mjs:14); `filesForPackage` now scans e2e source files.
- [ ] **P2** Circular dependency between @smithers-orchestrator/agents and @smithers-orchestrator/observability ships to npm — `packages/agents/src/BaseCliAgent/BaseCliAgent.js:5-6 and apps/observability/src/_traceEventNormalizers.js:1-2`
  - _remaining:_ Published circular dependency still ships.
- [ ] **P2** observability is a foundational library but lives in apps/ (package masquerading as an app) — `apps/observability/package.json`
  - _remaining:_ Still lives under apps/ as a published foundational library.
- [ ] **P2** .smithers workflow pack (a shipping target) is excluded from the dependency-boundary check and imports undeclared react/effect — `scripts/check-dependency-boundaries.mjs:13 (workspaceRoots/directWorkspaceDirs) and .smithers/package.json`
  - _remaining:_ .smithers excluded from boundary check and still imports undeclared react.
- [ ] **P2** Subpath exports point their `types` condition at the barrel index.d.ts, which does not contain the subpath's symbols — `packages/agents/package.json (exports "./BaseCliAgent".types -> ./src/index.d.ts)`
  - _remaining:_ Subpath types still point at barrel index.d.ts (only 3 newer subpaths got own .d.ts).
- [x] **P2** Three workspace packages (accounts, usage, tool-context) are missing from the root tsconfig paths map — `tsconfig.json:24-234 (paths)`
  - _done (2026-06-20):_ accounts, usage, and tool-context are all present in the root `tsconfig.json` paths map.
- [ ] **P2** smithers <-> cli package cycle exists (bin delegates dynamically; cli imports smithers statically) — `packages/smithers/src/bin/smithers.js:138 and apps/cli/src/*.js`
  - _remaining:_ Bidirectional smithers<->cli dependency persists.
- [ ] **P2** Root package.json exports map is a dev-only alias that diverges structurally from the actually-published exports — `package.json:18-40 vs packages/smithers/package.json exports`
  - _remaining:_ Root dev alias still structurally diverges from published exports; no sync guard.
- [ ] **P2** Published smithers-orchestrator ./* wildcard publicly exposes internal helper files — `packages/smithers/package.json (exports "./*" -> ./src/*.js)`
  - _remaining:_ ./* wildcard still present on published package.
- [ ] **P2** No automated guard that every documented public subpath export resolves — `e2e/exports/programmatic-api.test.ts`
  - _remaining:_ No automated guard that every documented subpath export resolves.
- [x] **P1** No lint (oxlint) gate in any CI workflow — `.github/workflows/ci.yml:28`
  - _done (2026-06-20):_ `.github/workflows/ci.yml` runs `pnpm lint` (oxlint with react/node/import plugins).
- [ ] **P1** No coverage measurement or gate anywhere in CI — the ~100% bar is unenforced — `.github/workflows/ci.yml:59`
  - _remaining:_ No coverage measurement or gate anywhere in CI.
- [x] **P1** typecheck:examples never runs in CI — 22 user-facing example workflows can ship broken — `package.json:67`
  - _done (2026-06-20):_ `.github/workflows/ci.yml` runs `pnpm typecheck:examples`.
- [ ] **P2** Gateway OpenAPI drift check is gated only via faults.yml's `pnpm -r build`, not in the primary CI job — `.github/workflows/faults.yml:33`
  - _remaining:_ OpenAPI drift check still gated only via faults.yml build, not primary CI.
- [ ] **P2** jj platform packages' prepublishOnly binary-presence validation never runs on PRs — `packages/jj-darwin-arm64/package.json:1`
  - _remaining:_ jj platform binary-presence validation still never runs on PRs.
- [ ] **P2** Full e2e suite runs in the test job without the build step that faults.yml deems necessary — `e2e/package.json:1`
  - _remaining:_ Full e2e suite still runs in test job against un-built packages.
- [x] **P2** examples/ bun test (porting-rules.test.ts) never runs in CI — same untested-directory root cause as the smithers gap — `examples/bun-port-smithers/components/porting-rules.test.ts:14`
  - _done (2026-06-20):_ `.github/workflows/ci.yml` runs `bun test examples/bun-port-smithers/components/porting-rules.test.ts`.
- [ ] **P2** package.json "./*" subpath export is unused and would serve whole-bundle types for any subpath — `packages/accounts/package.json:13-17`
  - _remaining:_ accounts ./* wildcard still present serving whole-bundle types.
- [ ] **P2** Committed generated index.d.ts has no CI sync guard (drift risk) — `packages/accounts/src/index.d.ts:1-158`
  - _remaining:_ Committed accounts index.d.ts still has no CI sync guard.
- [ ] **P2** getDevToolsSnapshot is used by the nodes collection but is missing from the client's typed RPC surface — `packages/gateway-client/src/sync/gatewayCollectionDefs.ts:118`
  - _remaining:_ getDevToolsSnapshot still missing from the typed RPC surface; call is untyped.
- [ ] **P2** TaskMemoryConfig defined three times with a diverging shape — `packages/memory/src/TaskMemoryConfig.ts:3-15`
  - _remaining:_ Two source definitions still diverge in shape (top-level namespace field).
- [ ] **P2** Generated index.d.ts is committed and can drift; `./*` and `./metrics` subpaths point types at the full bundle — `packages/openapi/package.json:7-23, packages/openapi/src/index.d.ts, packages/openapi/tsup.config.ts`
  - _remaining:_ Committed openapi d.ts can drift; subpath types still point at full bundle; no CI guard.
- [ ] **P1** Quadruple-defined error contract with no drift guard between the runtime (.js) and type (.ts) copies — `packages/protocol/src/errors/index.js (runtime arrays) vs src/errors.ts (second runtime+type copy) vs src/errors/*.ts (type unions) vs src/index.d.ts (generated)`
  - _remaining:_ Quadruple definition persists; no drift guard between the runtime .js arrays and the hand-written .ts type unions.
- [ ] **P2** index.d.ts is a committed generated artifact serving as the type entry for ALL subpath exports — ``
  - _remaining:_ Committed scheduler index.d.ts still serves as type entry for all subpaths; no per-subpath declarations.
- [ ] **P2** package.json declares ./metrics and ./schema subpath exports that no consumer uses; types map all subpaths to index.d.ts — `packages/scorers/package.json:8-25; packages/scorers/src/index.d.ts`
  - _remaining:_ Unused metrics/schema subpaths remain; all subpath types still point at barrel.
- [ ] **P2** Inconsistent timeout policy: isJjRepo (on the durability-startup hot path) has no timeout while getJjPointer/captureWorkspaceSnapshot do — `packages/vcs/src/jj.js:167-171 ; packages/engine/src/startDurability.js:84`
  - _remaining:_ isJjRepo still has no timeout on the durability-startup hot path.
- [ ] **P2** Default operator console re-implements the whole wire protocol instead of using the published SDK — `packages/server/src/gatewayUi/defaultOperatorUi.js:1-1432`
  - _remaining:_ Default operator console still re-implements the wire protocol instead of using the SDK.
- [ ] **P1** checkJs is off in all 27 packages: 831 .js source files (503 with JSDoc types) ship unverified types — ``
  - _remaining:_ checkJs still off in all but 1 package.
- [ ] **P1** 28 packages commit a generated bundled src/index.d.ts that ships as exports `types` and can drift; drift guard exists only at publish, not in CI — ``
  - _remaining:_ 28 committed generated d.ts files still have no CI drift guard.
- [ ] **P1** Published @smithers-orchestrator/observability lives under apps/ and forms a publish cycle with agents (depended on by 14 published packages) — ``
  - _remaining:_ Published observability still under apps/ in a publish cycle with agents.
- [ ] **P2** isRecord / isObject / asRecord predicate family re-implemented across 7+ packages with divergent bodies; 99 inline error-message extractions — ``
  - _remaining:_ No shared predicate package; helpers still re-implemented; inline error extraction remains.
- [ ] **P2** apps/cli is also published from apps/ (non-private @smithers-orchestrator/cli) — apps/ contains 2 shipping packages, not the conventional zero — `apps/cli/package.json`
  - _remaining:_ apps/cli still published from apps/.
- [ ] **P2** Workflow-to-UI binding is implicit filename convention with no missing-UI signal — `apps/cli/src/index.js:1990-1998; apps/cli/src/workflow-pack.js:1716-1727 (renderGatewayFile)`
  - _remaining:_ Workflow-to-UI binding still implicit filename convention with no missing-UI signal.
