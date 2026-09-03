# Compatibility sweep lane report

## Outcome

Completed the compatibility sweep from baseline `c5180f45`. The change removes compatibility-only surfaces and migrates their callers to the single rc.0 contract. Before this report and the generated known-files update, the working diff covered 193 files with 858 insertions and 3,606 deletions.

The initial required scan found 757 matching lines in 234 files. The identical post-sweep scan finds 599 lines. Every initial hit is classified below; category A surfaces were removed, category B occurrences are current domain/migration/history language, and category C findings were left for their owning lane.

Major removals include:

- `FLOWS_*` CLI environment aliases and dual-name handling; only `SMITHERS_*` names remain.
- The deprecated `OpenAICompatible` module and `Route.openaiCompatible`; callers now use the canonical Responses or Chat Completions constructor with an explicit endpoint path where needed.
- Old inline engine-store replay shapes, omitted lineage coordinates, memo/schema fallbacks, retained harness decode fields, eval aliases, key/digest aliases, and the `ChangesetsLegacy` target.
- UI persistence imports/migrations, bare command aliases, old card shapes, flat component APIs, and legacy HTML/plan/tool-call surfaces.
- Old bug-report payload keys, optional target ids, uppercase testing error spellings, and stale sandbox status spelling.

Callers and tests were updated directly; no shim, alias, compatibility decoder, fallback, skipped test, lowered threshold, dependency change, or generated build declaration was added.

## Decisions and unresolved category C findings

- `packages/migrate`, the CLI's 0.x project detector/notices, the `smthrs-deprecation` release contract, archived status values, sandbox session slugs, registry version-range logic, journal/time-travel history handling, CSS vocabulary used by the current UI, and `Api.Compat` target semantics are category B: they are shipped migration/domain/history behavior rather than alternate accepted APIs.
- `local:/path` remains the canonical identity for a local-only checkout without a remote. Misleading legacy variable names and comments were removed, but the current feature was retained.
- `Flow.agent` remains because it is the current semantic constructor, not a deprecated spelling.
- All inventory hits in `packages/build-cli/src`, plus the structural target-authoring findings in `Cargo.ts`, `Fetch.ts`, `Target.ts`, and `Smithers.ts`, are category C. The brief explicitly prohibits editing executor-mode logic and structural declarations.
- `GithubTarget.PrInvocation.environment` and `Outward.Invocation.environment` remain category C. Removing them broke the root typecheck because the prohibited executor still passes the fields at `packages/build-cli/src/PackageExec.ts:4836` and `:5217`. Their coordinated removal belongs with that executor work.
- There are no diffs in `packages/build-cli`, any `BUILD.ts`/`PACKAGE.ts`, `PLAN.md`, or `docs/migration`.

## Gates

### Green gates

`pnpm run check`:

```text
examples check: Done
packages/build-cli check: Done
apps/ui check: Done
exit=0
```

`pnpm run lint`:

```text
packages/evals lint: Done
packages/chain lint: Done
packages/create-app lint: Done
packages/build-cli lint: Done
exit=0
```

`pnpm run circular`:

```text
packages/evals circular: Done
packages/create-app circular: Done
packages/chain circular: Done
packages/build-cli circular: Done
exit=0
```

The recursive check and lint commands exercise every package that declares those scripts. Focused and repo-wide package results included:

```text
@smthrs/targets: 61 files passed; 1360 tests passed; statements 99% (7587/7663)
@smthrs/evals: 9 files passed; 115 tests passed; 100% coverage
@smthrs/engine-store: 108 files passed; 953 tests passed; 100% coverage
@smthrs/model: 21 files passed; 320 tests passed; 100% coverage
@smthrs/agent: 34 files passed; 462 tests passed; 100% coverage
@smthrs/harness: 33 files passed, 1 skipped; 1131 tests passed, 1 skipped; 100% coverage
@smthrs/time-travel: 39 files passed; 419 tests passed; 100% coverage
@smthrs/cli: 43 files passed; 932 tests passed, 1 skipped
@smthrs/ui: 1234 tests passed, 0 failed
smithers-ui focused target/card tests: 24 passed, 0 failed
apps/bug-worker: 18 passed, 0 failed
apps/shared: 131 passed, 0 failed
e2e: 9 files passed; 42 tests passed
```

The corrected local Chat Completions example also passed in the final repo-wide run. `pnpm --filter @smthrs/examples run check` passed.

### Repo-wide test sweep: non-green, reported without masking

Command:

```sh
pnpm --recursive --if-present --no-bail run test
```

Exact summary tail:

```text
Summary: 4 fails, 59 passes

packages/build/infra: @smthrs/build-infra test exited 1
packages/flows: @smthrs/flows test exited 1
apps/ui: smithers-ui test exited 1
examples: @smthrs/examples test exited 1
```

Failures:

1. `packages/build/infra/scripts/deploy.test.ts` failed its SIGTERM marker assertion during the concurrent sweep. An isolated rerun executed the test itself successfully (`1 passed | 12 skipped`); the focused command then exited 1 only because selecting one test cannot satisfy the package-wide 100% coverage gate.
2. `packages/flows/test/spawnContainment.test.ts` deterministically reports the existing prohibited importer:
   ```text
   expected [ 'build-cli/src/FoundryExec.ts' ] to deeply equal []
   Test Files 1 failed | 13 passed
   Tests 1 failed | 469 passed | 1 skipped
   ```
   The brief forbids changing the importer or adding an allowlist entry without its owning review.
3. `apps/ui` finished with `1518 pass, 11 fail, 6 errors`. Three failures depend on mutable external checkouts: `~/artsy/force` now exposes 84 graph nodes instead of the pinned 82, and `~/artsy-e2e/force` does not expose `//src:typeCheck` or `//src:srcs`. Eight native-main assertions time out because their child prints no report before exit 143. Running `Main.test.ts` alone reproduces `3 pass, 7 fail, 5 errors`; focused lane-changed UI tests pass.
4. `examples` finished with `34 files passed, 2 failed; 59 tests passed, 2 failed`. The live OpenAI smoke timed out at 30 seconds with a configured key. The approval example deterministically expects `/control/ClaimLost` but receives `/control/PlanDenied`; its isolated rerun reproduces the mismatch. Neither failure is hidden or skipped.

## Known-files generation

`node scripts/generate-known-files.mjs` completed with exit 0 and no stdout. It was run after every file addition/deletion, including this report.

## Full initial inventory

Line numbers refer to the required initial scan at `c5180f45`.

| File and line(s) | Category | Action |
|---|---:|---|
| `apps/bug-worker/src/bugReportSchema.ts:6,21,30,35,41,51` | A | Deleted the compatibility surface; migrated callers/tests to the canonical contract. |
| `apps/review/action/src/materializeInferenceCredentials.ts:10` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `apps/review/action/src/resolveInferenceEnv.ts:13,58` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `apps/review/src/cli/createProgressReporter.ts:4` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `apps/review/src/cli/whichBinary.ts:4` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `apps/review/src/schema/withDefault.ts:7,22` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `apps/review/src/server/proxy/modelPrices.ts:4` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `apps/review/src/server/walkthroughs/handleWalkthroughs.ts:44,67,69,78,132,134,141,163` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `apps/review/src/workflow/openCodeReview.ts:1033` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `apps/review/src/workflow/reviewActions.ts:6` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `apps/review/src/workflow/reviewAgentActions.ts:7` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `apps/review/src/workflow/reviewFlow.ts:181` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `apps/review/src/workflow/reviewSchemas.ts:50` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `apps/review/src/workflow/reviewSeatResolver.ts:163,203,257` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `apps/review/src/workflow/reviewSeats.ts:8` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `apps/server/src/index.ts:193,194` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `apps/shared/src/AgentApiRoutes.ts:47` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `apps/shared/src/BrowserFetch.ts:112` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `apps/shared/src/Cards.ts:982` | A | Deleted the compatibility surface; migrated callers/tests to the canonical contract. |
| `apps/shared/src/LocalApp.ts:344` | A | Deleted the compatibility surface; migrated callers/tests to the canonical contract. |
| `apps/shared/src/LocalApp.ts:429` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `apps/ui/src/bun/CloudAuth.ts:15,163` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `apps/ui/src/bun/RepoPlugin.test.ts:94` | A | Deleted the compatibility surface; migrated callers/tests to the canonical contract. |
| `apps/ui/src/bun/RepoPlugin.ts:17,20,29,30,36,42,46,48` | A | Deleted the compatibility surface; migrated callers/tests to the canonical contract. |
| `apps/ui/src/conformance/LiteralPin.test.ts:345,347` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `apps/ui/src/mainview/chain/deps.test.ts:134,138` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `apps/ui/src/mainview/chain/FlowCatalog.ts:7` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `apps/ui/src/mainview/chain/SchemaVersion.test.ts:47,48,198,205,228,234,285,290` | A | Deleted the compatibility surface; migrated callers/tests to the canonical contract. |
| `apps/ui/src/mainview/chain/SqliteRowStorage.test.ts:105,112,119,131,144` | A | Deleted the compatibility surface; migrated callers/tests to the canonical contract. |
| `apps/ui/src/mainview/chain/SqliteRowStorage.ts:6,22,32,48,99,103,105,107,113,131,150,153,214,215,225,239,249,252,318` | A | Deleted the compatibility surface; migrated callers/tests to the canonical contract. |
| `apps/ui/src/mainview/chain/TransactionalStorage.test.ts:180,198,204,215` | A | Deleted the compatibility surface; migrated callers/tests to the canonical contract. |
| `apps/ui/src/mainview/chain/TransactionalStorage.ts:30,39,119,121,124,126,131,132,144,160,161,169,173,181,195,202` | A | Deleted the compatibility surface; migrated callers/tests to the canonical contract. |
| `apps/ui/src/mainview/flows/Flows.ts:156` | A | Deleted the compatibility surface; migrated callers/tests to the canonical contract. |
| `apps/ui/src/mainview/FocusRing.ts:32,39` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `apps/ui/src/mainview/state/AgentTurnPolicy.test.ts:37` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `apps/ui/src/mainview/state/AgentTurnPolicy.ts:63` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `apps/ui/src/mainview/state/AppState.ts:112,291,296,304` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `apps/ui/src/mainview/state/AppStore.ts:15,268` | A | Deleted the compatibility surface; migrated callers/tests to the canonical contract. |
| `apps/ui/src/mainview/state/AppStore.ts:2756,2770,2771` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `apps/ui/src/mainview/state/controller/tabs.ts:379` | A | Deleted the compatibility surface; migrated callers/tests to the canonical contract. |
| `apps/ui/src/mainview/state/controller/turns.ts:139` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `apps/ui/src/mainview/state/Persistence.test.ts:133` | A | Deleted the compatibility surface; migrated callers/tests to the canonical contract. |
| `apps/ui/src/mainview/state/RepoContext.ts:42,49,67,75` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `apps/ui/src/mainview/state/seams/ChangeSeam.ts:21,317` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `apps/ui/src/mainview/state/seams/LinearSeam.ts:20` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `apps/ui/src/mainview/state/seams/RepositoriesSeam.test.ts:13` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `apps/ui/src/mainview/state/seams/RepositoriesSeam.ts:164` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `apps/ui/src/mainview/state/seams/WorkspaceSeam.test.ts:304` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `apps/ui/src/mainview/state/seams/WorkspaceSeam.ts:135,136,285` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/agent/src/Budget.ts:378,403` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/agent/src/internal/FlowEngineLike.ts:6` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/artifacts/src/ArtifactStore.ts:343` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/artifacts/src/RemoteArtifacts.ts:575` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/build-cli/src/Executor.ts:183` | C | Unchanged and reported: prohibited build-executor or structural-authoring work belongs to another lane. |
| `packages/build-cli/src/PackageError.ts:46` | C | Unchanged and reported: prohibited build-executor or structural-authoring work belongs to another lane. |
| `packages/build-cli/src/PackageExec.ts:178,371,2452,2453,2673,4760,4763,4764,4765,4767,4772,4786,4798,4808` | C | Unchanged and reported: prohibited build-executor or structural-authoring work belongs to another lane. |
| `packages/build-cli/src/PackageIndex.ts:205` | C | Unchanged and reported: prohibited build-executor or structural-authoring work belongs to another lane. |
| `packages/build-cli/src/PackageLoader.ts:438` | C | Unchanged and reported: prohibited build-executor or structural-authoring work belongs to another lane. |
| `packages/build-cli/src/Planner.ts:994,997,1005,1166` | C | Unchanged and reported: prohibited build-executor or structural-authoring work belongs to another lane. |
| `packages/build-cli/src/WorkspaceLoader.ts:57` | C | Unchanged and reported: prohibited build-executor or structural-authoring work belongs to another lane. |
| `packages/chain/src/Chain.ts:325` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/cli/src/Agents.ts:9,83` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/cli/src/Application.ts:50,51,53` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/cli/src/Bug.ts:23` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/cli/src/ClaudeMirror.ts:8,10` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/cli/src/Command.ts:44,134,145,162,462,463,465,467,470,1113,1119,1165,1166,1171,1174,1175,1177,1612,1625` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/cli/src/Detached.ts:4` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/cli/src/Docs.ts:10` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/cli/src/Doctor.ts:9,21,237,239,241,299,300,306,307,308,314,315,316,317,318,319` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/cli/src/Environment.ts:9,41,53,65,66` | A | Deleted the compatibility surface; migrated callers/tests to the canonical contract. |
| `packages/cli/src/index.ts:93` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/cli/src/Init.ts:5,18,71` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/cli/src/Legacy.ts:2,4,11,19,21,30,42,58,97,109` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/cli/src/McpServer.ts:10,12,20,287,512,557` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/cli/src/NodeControl.ts:52,699,704` | A | Deleted the compatibility surface; migrated callers/tests to the canonical contract. |
| `packages/cli/src/NodeControl.ts:234,236,237,1170,1174,1175` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/cli/src/Project.ts:5,15,26,31,43,99,102,105,112,122,164,166,177,193,202,210,222,228,229,230,251,257,258,259,263,268,275,279,281,282,300` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/cli/src/Unsupported.ts:4,214,284` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/cli/src/Update.ts:5` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/cli/src/Verb.ts:75` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/core/src/Digest.ts:2` | A | Deleted the compatibility surface; migrated callers/tests to the canonical contract. |
| `packages/core/src/Flow.ts:444` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/core/src/Graph.ts:925` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/core/src/Markdown.ts:56,95,201,245,247,248,250` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/database/src/internal/WriteRetry.ts:6` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/database/src/node/NodeDatabase.ts:36,94,109,123,129,140,207,214` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/database/src/UnsupportedBackend.ts:4,28` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/engine-store/src/internal/ActionPersistence.ts:296,2187` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/engine-store/src/internal/JournalRecords.ts:47` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/engine-store/src/internal/RunCatalogOps.ts:134` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/engine-store/src/internal/RunDriver.ts:1317,1320` | A | Deleted the compatibility surface; migrated callers/tests to the canonical contract. |
| `packages/engine-store/src/StepBoundary.ts:413,430,449,454,455,462,463,537,538,570,925` | A | Deleted the compatibility surface; migrated callers/tests to the canonical contract. |
| `packages/errors/src/ErrorCode.ts:5` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/evals/src/Baseline.ts:219` | A | Deleted the compatibility surface; migrated callers/tests to the canonical contract. |
| `packages/evals/src/Regression.ts:183,321` | A | Deleted the compatibility surface; migrated callers/tests to the canonical contract. |
| `packages/evals/src/Report.ts:32,167` | A | Deleted the compatibility surface; migrated callers/tests to the canonical contract. |
| `packages/evals/src/Suite.ts:47,68` | A | Deleted the compatibility surface; migrated callers/tests to the canonical contract. |
| `packages/flow/src/Action/Errors.ts:7` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/flow/src/HumanTask.ts:7` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/flow/src/Poll.ts:5` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/flow/src/RetryPolicy.ts:15` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/flows/src/internal/SandboxedFlowGuest.ts:66` | A | Deleted the compatibility surface; migrated callers/tests to the canonical contract. |
| `packages/flows/src/NodeRuntime.ts:67,479` | A | Deleted the compatibility surface; migrated callers/tests to the canonical contract. |
| `packages/flows/src/SandboxedFlow.ts:12,46,108` | A | Deleted the compatibility surface; migrated callers/tests to the canonical contract. |
| `packages/gateway/src/Projections.ts:589,670` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/harness/src/AgentEvent.ts:124` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/harness/src/CallLedger.ts:162,168` | A | Deleted the compatibility surface; migrated callers/tests to the canonical contract. |
| `packages/harness/src/Cell.ts:100,105,121,136,140,146,150,156,159,165,167,201,203,208,212,228,230` | A | Deleted the compatibility surface; migrated callers/tests to the canonical contract. |
| `packages/harness/src/ContextWindow.ts:384,424` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/harness/src/internal/cellPrompt.ts:186` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/harness/src/internal/printChannel.ts:19` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/harness/src/Sandbox.ts:467` | A | Deleted the compatibility surface; migrated callers/tests to the canonical contract. |
| `packages/harness/src/Steering.ts:93` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/integrations/src/core/migrations/index.ts:8,9` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/integrations/src/github/Config.ts:4` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/integrations/src/github/Webhook.ts:10` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/integrations/src/linear/Config.ts:4` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/jj/src/browser/WasiFs.ts:86` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/jj/src/browser/WasiPreview1.ts:51,229` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/jj/src/node/resolveJjBinary.ts:10,18,193` | A | Deleted the compatibility surface; migrated callers/tests to the canonical contract. |
| `packages/kernel/src/GrantEvent.ts:158,173` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/keys/src/Key.ts:9,78,189` | A | Deleted the compatibility surface; migrated callers/tests to the canonical contract. |
| `packages/memory/src/MemoryStore.ts:76` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/memory/src/RecallKeyword.ts:6` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/migrate/src/Checks.ts:49,62,368,500` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/migrate/src/Constructs.ts:2,42,515` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/migrate/src/Detect.ts:2,28,39,40,50,58,125,151,323,464,469,500,507,707,932,1055,1148,1166,1173,1182` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/migrate/src/flow/Archive.ts:12,75,234,365,399,427,481,539` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/migrate/src/flow/Checkpoint.ts:81,149` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/migrate/src/flow/Cli.ts:128` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/migrate/src/flow/Command.ts:215` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/migrate/src/flow/Contract.ts:6,58,484,646,671` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/migrate/src/flow/Gate.ts:7,125` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/migrate/src/flow/Layers.ts:11,46,175,242` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/migrate/src/flow/MigrateFlow.ts:129,146,610,615,650,660,665,698,702` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/migrate/src/flow/Options.ts:73` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/migrate/src/flow/Transform.ts:237,475,498` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/migrate/src/index.ts:4,7,9,97` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/migrate/src/internal/FacadeExports.ts:2` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/migrate/src/internal/Fs.ts:21,66` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/migrate/src/internal/Semver.ts:85,90` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/migrate/src/internal/Ts.ts:5,49` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/migrate/src/Inventory.ts:5,81,366,698,835` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/migrate/src/Mapping.ts:27,546` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/migrate/src/PromptHints.ts:4` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/migrate/src/Report.ts:52,649,665,752,790,808,810` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/migrate/src/RunState.ts:2,12,15,66,87,130,155,180,198,224,228,241,395,442,553,586,593` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/migrate/src/Scan.ts:196` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/migrate/src/ZodSchemaHints.ts:4` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/model/src/DeferredTools.ts:39,64` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/model/src/index.ts:88` | A | Deleted the compatibility surface; migrated callers/tests to the canonical contract. |
| `packages/model/src/ModelRequest.ts:427` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/model/src/OpenAIChatCompletions.ts:6,7,9,62,378,475,557,558` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/model/src/OpenAICompatible.ts:4,17,24,27,29` | A | Deleted the compatibility surface; migrated callers/tests to the canonical contract. |
| `packages/model/src/Route.ts:386,387,400,405,413,415,421` | A | Deleted the compatibility surface; migrated callers/tests to the canonical contract. |
| `packages/model/src/Route.ts:459,460,461,466,494,495,506,511` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/patterns/src/internal/Compose.ts:220,247,249,262,267,271,283,294,301,305,308` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/patterns/src/Pattern.ts:4,30,32,38,39,59,93,171` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/patterns/src/Saga.ts:6` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/plan/src/Plan.ts:31` | A | Deleted the compatibility surface; migrated callers/tests to the canonical contract. |
| `packages/plan/src/Plan.ts:519` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/platform-browser/src/BrowserFileSystem/streamFile.ts:76` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/platform-node/src/AtomicFileSystem.ts:999` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/platform-node/src/ProcessReaper.ts:510` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/registry/src/Descriptor.ts:332` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/registry/src/internal/Names.ts:21` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/registry/src/MarkdownFlow.ts:177,536,537,538,540,542,584` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/registry/src/Pack.ts:9,290,328,329,330,389,545,547,552,565,578,580` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/registry/src/Registry.ts:45,200,219,474` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/registry/src/RegistryError.ts:57` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/run-store/src/RunStore.ts:47,1551` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/sandbox/src/AwsSandbox/make.ts:302` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/sandbox/src/AwsSandbox/Sdk.ts:100` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/sandbox/src/ContainerSandbox/index.ts:5` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/sandbox/src/index.ts:35` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/sandbox/src/internal/sessionSlug.ts:29` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/scorers/src/migrations/0004_require_failure_codes.ts:14,15` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/smthrs-deprecation/src/index.ts:5,22` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/std/src/Container.ts:112` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/sync/src/SyncClient.ts:191` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/targets/src/Cargo.ts:1150` | C | Unchanged and reported: prohibited build-executor or structural-authoring work belongs to another lane. |
| `packages/targets/src/Fetch.ts:13` | C | Unchanged and reported: prohibited build-executor or structural-authoring work belongs to another lane. |
| `packages/targets/src/GithubTarget.ts:549,558` | C | Retained and reported: active callers are in the prohibited build executor, so removal must be coordinated with that lane. |
| `packages/targets/src/NodeArtifact.ts:2,99,104,109,110,113,120` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/targets/src/Outward.ts:21,77` | C | Retained and reported: active callers are in the prohibited build executor, so removal must be coordinated with that lane. |
| `packages/targets/src/Smithers.ts:216` | A | Deleted the compatibility surface; migrated callers/tests to the canonical contract. |
| `packages/targets/src/Smithers.ts:540` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/targets/src/Smithers.ts:367` | C | Unchanged and reported: prohibited build-executor or structural-authoring work belongs to another lane. |
| `packages/targets/src/Target.ts:927` | C | Unchanged and reported: prohibited build-executor or structural-authoring work belongs to another lane. |
| `packages/testing/src/internal/Execution.ts:11` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/testing/src/internal/ParityManifest.ts:2,8,172,186,220,222,269,270,306,308,323,503,512,521,532,612,666,682,689` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/testing/src/internal/Pin.ts:10` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/testing/src/internal/Structural.ts:20` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/testing/src/internal/TestEffectRunner.ts:5` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/testing/src/TestingError.ts:13` | A | Deleted the compatibility surface; migrated callers/tests to the canonical contract. |
| `packages/time-travel/src/EffectBoundary.ts:286` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/time-travel/src/internal/Rewind.ts:345` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/time-travel/src/MemoryTimeTravelStore.ts:485` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/time-travel/src/SqlTimeTravelStore.ts:961,1026` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/triggers/src/SqlTriggerStore.ts:398` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/ui-styleguide/src/index.ts:30` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/ui-styleguide/src/themeTokens.ts:26` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/ui-styleguide/src/ThemeVariantTokens.ts:5` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/ui/src/agentic/parseAgentOutput.ts:365` | A | Deleted the compatibility surface; migrated callers/tests to the canonical contract. |
| `packages/ui/src/index.ts:100,194` | A | Deleted the compatibility surface; migrated callers/tests to the canonical contract. |
| `packages/ui/src/status.ts:73,74,75` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/ui/src/tokens.ts:21` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/ui/src/uiCss.ts:23` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `packages/ui/src/vault/wikilinks.ts:3` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `scripts/check-dependency-boundaries.mjs:46,48,196` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `scripts/check-docs.mjs:15,19,41,244,246,253,260,321,328,331,333` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `scripts/check-legacy-absent.mjs:2,4,7,13,16,23,29,45,53,59,63,67` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `scripts/check-llms.mjs:30,34` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `scripts/check-llms.test.mjs:44` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `scripts/check-local-smithers.mjs:42,67,68` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `scripts/check-local-smithers.test.mjs:158` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `scripts/check-single-effect-version.mjs:36` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `scripts/docs-contract.mjs:192,198,219,220,221,235,242,253,260,315,323` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `scripts/docs-contract.test.mjs:13,110,123,127,128,134,252,253,257,267` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `scripts/docs-links.test.mjs:75` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `scripts/docs-pages.mjs:87,90,92` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `scripts/docs-render.mjs:182` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `scripts/docs-render.test.mjs:129,130` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `scripts/docs-routes.mjs:5,41,48` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `scripts/docs-routes.test.mjs:23` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `scripts/docs-sidebar.mjs:11` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `scripts/generate-docs-pages.mjs:148,225,546,617,621,623,624,628,631,657` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `scripts/generate-llms.test.mjs:32,35,36,103` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `scripts/generate-llms.ts:96,98,122,226,255,261` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `scripts/llms-version-guard.ts:5` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `scripts/normalize-bunx.test.ts:16` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `scripts/normalize-bunx.ts:10,16,31,38,93,119` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `scripts/normalize-placeholders.ts:107` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `scripts/pack-release.mjs:25` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `scripts/pack-release.test.mjs:126,465` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `scripts/repo-contract/barrels.test.mjs:4,11,74,75,76,78,82` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `scripts/repo-contract/fault-skips.test.mjs:4` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `scripts/repo-contract/package-contract.test.mjs:4,5,34` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
| `scripts/repo-contract/test-script-wiring.test.mjs:4,7` | B | Kept: current domain, migration, history, portability, or release-contract usage—not an accepted old API. |
