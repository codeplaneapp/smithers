# 01: packages/ui-core and packages/tui-ui, and what moves out of multi

All paths under "multi" are relative to `/Users/williamcory/multi/src`. All counts verified 2026-07-27.

## The reuse taxonomy (the approvals exemplar, verified file by file)

multi's per-feature layout is a five-layer taxonomy. `src/approvals/` (35 files: 13 non-test source, 1 css, 21 tests) demonstrates every layer:

| Layer | File | Portability |
|---|---|---|
| Pure domain | `approvals.ts` (approvalProjectionKey, approvalLabel, shortRunId, orderApprovals, waitTime, waitTimeTone, summarizeApprovals; only import is a type from gateway-client) | 100% portable |
| Pure domain | `approvalWait.ts`, `guardianPolicy.ts`, `externalGateNarration.ts`, `externalGateTransition.ts`, `pendingGateToasts.ts` | 100% portable |
| Zustand store | `approvalsStore.ts` (gates, selection, pending-deny, acting keys, notes, identity-epoch fence, `useAuthStore.subscribe` reset) | portable |
| Headless bridge | `ApprovalsBridge.tsx` (returns null; pumps `useGatewayApprovals` + `useSmithersGateway` into the store; fingerprints rows; reconciles toasts; installs the execution port) | portable |
| Execution port | `approvalDecisionExecution.ts` (module singleton + `bindApprovalExecutionPort`/`getApprovalExecutionPort`; `ApprovalExecutionPort = { submit(vars, invocationId), refetch() }`) | portable; the DI seam |
| View | `ApprovalsCanvas.tsx` (~21KB; reads the store via ~12 selectors, invokes flows via `invokeUserFlow` at ~8 sites, mixes 50+ raw DOM elements with `@smithers-orchestrator/ui` components) | NOT portable as-is; this is the refactor |

The view refactor: the store-reading/view-model half of each canvas moves into a ui-core `use<Feature>Vm` hook; the markup half stays per-platform (DOM canvas in multi, opentui mode in packages/tui, both consuming the same VM).

The bridge pattern generalizes: all 15 `*Bridge.tsx` files in multi return null: `app/RepoRouteBridge`, `app/RootProjectSelectionBridge`, `approvals/ApprovalsBridge`, `crons/CronsBridge`, `evals/EvalsBridge`, `issues/IssuesBridge`, `landings/LandingsBridge`, `memory/MemoryFactsBridge`, `optimize/OptimizeBridge`, `prompts/PromptsBridge`, `runs/RunsListBridge`, `scores/ScoresBridge`, `smithersCloud/SandboxRepoSyncBridge`, `tickets/TicketsBridge`, `vcs/VcsBridge`. Of multi's 24 gateway-react importers, 11 are these null-rendering bridges and 4 are pure derivation modules; only ~9 are real visual canvases. The React-hook dependency is already concentrated in a thin pumping layer.

## packages/ui-core (@smithers-orchestrator/ui-core)

Layout (colocate by domain, one named export per file, index.ts barrels only):

```
packages/ui-core/
  package.json          raw-source shipping like gateway-react ("." + "./*"
                        exports to src/*.ts); deps: zustand, zod, gateway-client
                        (types), gateway-react (hooks for VMs); peer: react ^19
  tsconfig.json         no jsx needed for domain files; react-jsx for hooks
  src/
    platform/           the DI interfaces + default no-op/memory impls
                        (02-platform-di.md defines the full surface)
    approvals/          approvals.ts, approvalsStore.ts, approvalsBridge.ts,
                        approvalDecisionExecution.ts, useApprovalsVm.ts
    runs/               runsList.ts, runProgress.ts, statusMeta.ts, runEta.ts,
                        runHealth.ts, runToFlow.ts, runsListStore.ts,
                        runsListBridge.ts, useRunsListVm.ts, useRunInspectorVm.ts
    route/              deriveRoute.ts, routeStore.ts, appShellDecision.ts,
                        navigation intents (surface open requests as data)
    palette/            palette.ts (from multi src/palette/palette.ts),
                        paletteStore.ts, usePaletteVm.ts
    chat/               transcriptGrouping.ts, embedView.ts, chat VM surface
                        extracted from flowchat consumers, useChatTranscriptVm.ts
    flows/              descriptor protocol types, portableFlowExecution seam,
                        executionServices registry (copied contract from multi
                        src/flows/{types,executionServices,portableFlowExecution}.ts)
    diff/               diffPaginate.ts, useDiffVm.ts
    <feature>/          tickets, memory, prompts, scores, crons: domain + store
                        + bridge + VM per phase 5
  tests/                bun tests, no DOM, no TTY
```

Two sources feed ui-core:

1. multi (move-and-reimport; its pnpm overrides already link `@smithers-orchestrator/{gateway-client,gateway-react,ui}` and `smithers-orchestrator` to `../smithers/packages/*`, so adding a ui-core override makes the loop same-day).
2. `packages/tui/src/modes/*Utils.ts` where they duplicate multi domain logic (treeUtils/graphUtils/logUtils/timelineUtils overlap runsList/runProgress; approvalUtils/humanUtils overlap the approvals domain; `eventFrame.ts` is the shared event-envelope normalizer and belongs in ui-core).

## The extraction inventory from multi, phase by phase

Scale: ~245 `.ts` files under multi `src/` (excluding flows/, tests, .d.ts) contain no React, no zustand, no DOM globals, and no gateway-react. Store modules: 63 `*Store.ts` files (62 modules import zustand; `app/bindRouteStore.ts`, `sync/persist/workerGatewayStore.ts`, `uiPreview/waitlistStore.ts` do not; `components/github/composerState.ts` and `files/fileDraftSync.ts` are zustand modules without the suffix).

### Phase 2 (runs)

- Pure: `runs/runsList.ts` (filter/group/summarize reducers, "unit-tested without a DOM" per its own header), `runs/runProgress.ts` (pure completion estimator), `runs/statusMeta.ts` (statusTone/statusLabel), `runs/Run.ts`, `runs/runEta.ts`, `runs/runHealth.ts`, `runs/runToFlow.ts` (pure graph projection currently feeding xyflow), `runs/nodeProps.ts`, `runs/structuredOutputDetect.ts`.
- Store: `runs/runsListStore.ts`, `runs/clockStore.ts`.
- Bridge: `runs/RunsListBridge.tsx`.
- Derivations already pure in multi's gateway dir: `gateway/gatewayRunObservability.ts`, `gateway/gatewayRunProgressDerivation.ts`, `sync/useGatewayRunTree.ts`.
- New VMs: `useRunsListVm`, `useRunInspectorVm` (tree/logs/diff/approve tabs; multi's GatewayRunInspector four-tab surface and packages/tui TreeMode inform the shape).

### Phase 3 (approvals)

The whole exemplar table above, plus `approvals/guardianStore.ts` and `approvals/guardianExecution.ts` (policy evaluation is pure; keep Guardian auto-decisions web-only until needed).

### Phase 4 (chat)

- `flowchat/` root is 20 modules; the machine is XState v5 (`machine.ts` uses `setup()`, `actor.ts` uses `createActor`; binding hook `useFlowChatSnapshot`). The machine, `timeline.ts`, `commands.ts`, `invocationId.ts`, `chatContext.ts` are DOM-free and port as-is. `persist/` (IndexedDB workers) and `remote/` (service worker, web workers, sqlite-wasm) stay web-only behind the persistence port.
- Flow descriptor protocol: exactly 300 `src/flows/<kebab-id>/command.ts` dirs, flat (nesting documented but unused). Components never perform effects; 114 files call `invokeUserFlow` (defined `src/flows/invoke.ts:366`, siblings invokeAgentFlow/invokeSystemFlow/...). The protocol pieces ui-core adopts:
  - `flows/types.ts` (descriptor + settlement contract),
  - `flows/executionServices.ts` (24 lines; module-level `setFlowExecutionServices`/`getFlowExecutionServices`: the host-injection seam),
  - `flows/portableFlowExecution.ts` (35 lines; `PORTABLE_FLOW_EXECUTOR_SERVICE`, `PortableFlowExecutor.tryExecute` returns undefined to delegate to the descriptor's production implementation; explicitly designed so "runtime selection stays generic": this is the terminal runtime injection point).
  - The descriptors themselves stay in multi for now; the TUI's flow catalog comes over the gateway (`useGatewayWorkflows` + flow catalog projection) rather than by importing 300 browser-flavored descriptors. Descriptor migration into ui-core is a later program.
- Chat transcript pure pieces: `chat/transcriptGrouping.ts`, `chat/embedView.ts`, `cards/Card.ts` (the EmbeddableKind union), `cards/embed.ts`.

### Phase 5 (thin modes)

Per feature, the domain + store + bridge trio: `vcs/vcs.ts` + `vcsStore` + `VcsBridge`; `tickets/tickets.ts` + `ticketsStore` + `TicketsBridge`; `memory/memoryFacts.ts` + `memoryStore` + `MemoryFactsBridge`; `prompts/promptPicker.ts`/`promptsSource.ts` + `promptsStore` + `PromptsBridge`; `scores/scoreReport.ts`/`scoreTabs.ts` + `scoresStore` + `ScoresBridge`; `crons/crons.ts` + `cronsStore` + `CronsBridge`; `diff/Diff.ts` + `diff/diffPaginate.ts` + `diff/gatewayRunDiff.ts` + `diffStore`.

### Phase 6 (palette)

`palette/palette.ts` (query parser, fuzzy scorer, rankers, section grouper, `PaletteMode = "open"|"files"|"flows"|"ask"`) + `paletteStore.ts`. Correction from the prompt: the file is `palette.ts`, not `paletteDomain.ts`.

### App-shell modules (phase 2, small but load-bearing)

- `app/Surface.ts`: the 24-kind surface enumeration (docs, vcs, files, terminal, issues, tickets, landings, runs, environment, repoFeature, pairConnect, approvals, agents, memory, prompts, scores, evals, crons, engine, admin, advanced, palette, optimize, gatewayRun) with per-kind params. This is the shared vocabulary for "what can open".
- `app/deriveRoute.ts` (354 lines, pure, parity-tested against the real router), `app/routeStore.ts` (25 lines; sole writer is the router subscription), `app/appShellDecision.ts` (86 lines, pure `deriveAppShellDecision` returning `{effectiveLayout, isChat, mode, showTranscript, canvasKey}`).
- `app/history.ts` already platform-branches: no window -> `createMemoryHistory`, desktop webview -> hash, else browser. The TUI takes the memory-history path and keeps deriveRoute + routeStore + appShellDecision byte-for-byte; multi's `bindRouteStore.ts` (32 lines, router subscription -> `deriveRoute` -> store) is replaced in the TUI by a navigation intent writer that sets the same RouteState.

## packages/tui-ui (@smithers-orchestrator/tui-ui)

opentui leaf components, props-in/callbacks-out, `jsxImportSource "@opentui/react"` (same tsconfig shape as packages/tui). No gateway imports, no stores, no business logic (arch-check enforced). Vocabulary mirrors ui/gateway-ui so a web reader recognizes the TUI code:

- Phase 1: `StatusPill` (status -> glyph+color), `EmptyState`, `Keybar`, `Frame` (bordered box with title).
- Phase 2: `RunTreeView` (rows + chevrons + status glyphs), `RunEventLogView`, `NodeOutputBlock` (`<code>`), `TabStrip`.
- Phase 3: `ApprovalCard`, `DecisionBar`, `NoteInput`.
- Phase 4: `ChatTranscriptView`, `ComposerInput`, `AutocompletePopup`.
- Phase 5: `DiffView` (`<code filetype="diff">`), `ListTable`.
- Phase 6: `PaletteOverlay`.

Existing render vocabulary to reuse from packages/tui: box/text/scrollbox/select/code intrinsics, `useKeyboard`, `useTerminalDimensions`, the headless test renderer via `@opentui/react/test-utils` (`tests/renderHelpers.tsx` pattern: `describeHeadlessRender = describe.skipIf(win32)`).

## Arch-check extension (phase 1)

Extend `scripts/check-ui-architecture.mjs` (smithers repo; exact-ratchet baseline `scripts/ui-architecture-baseline.json`, `checkUiArchitecture({root, baselinePath})` also invoked by `scripts/generate-workflow-pack.ts`) with:

- ui-core forbidden imports: `@opentui/*`, `react-dom`, `@smithers-orchestrator/ui`, `@smithers-orchestrator/gateway-ui`, plus DOM-global lexical scan (window/document/navigator/localStorage) outside `src/platform/web*` adapters.
- tui-ui forbidden imports: `@smithers-orchestrator/gateway-client`, `@smithers-orchestrator/gateway-react`, `@smithers-orchestrator/ui-core`, zustand.
- Baseline inventory rows for both new packages; keep `scripts/check-ui-architecture.test.mjs` green.

## Repo mechanics for the new packages

Both packages need: `docs/reference/package-configuration.mdx` rows (check:docs diffs the table against `readWorkspacePackages()` in both directions and requires non-private packages to be root `workspace:*` deps), root `package.json` devDependency entries, `pnpm docs:llms` regen, and both lockfiles in the same commit. multi consumes ui-core by adding one more `link:../smithers/packages/ui-core` override.
