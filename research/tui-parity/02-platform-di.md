# 02: the Platform DI layer

ui-core defines the interfaces; each shell injects an implementation at boot. multi already proves the pattern twice: `src/app/history.ts` platform-branches to a memory history when `window` is absent, and `src/speech/SpeechRecognitionLike.ts` is a hand-rolled interface with a feature-detecting `getSpeechRecognition()` returning null when unsupported. Every coupling below gets one of three treatments: inject (interface in ui-core, per-shell impl), replace (TUI substitutes a wholesale different widget), or drop (web-only, absent in TUI v1; the interface still exists so callers fail soft).

## The Platform interface (packages/ui-core/src/platform/)

```ts
export type Platform = {
  storage: KeyValueStorage;            // localStorage analog, namespaced
  clipboard: ClipboardPort;            // copy(text) -> ok | unavailable
  openExternal: OpenExternalPort;      // urls, files; TUI: hijack or print
  notify: NotifyPort;                  // toasts; TUI: status-line flash
  navigation: NavigationPort;          // open Surface / back / forward
  focus: FocusVisibilityPort;          // app focus + visibility signals
  viewport: ViewportPort;              // cols/rows or px; compact breakpoint
  auth: AuthPort;                      // current principal + change events
  persistence: TimelinePersistencePort;// chat timeline store (IDB on web)
  speech?: SpeechPort;                 // absent in TUI v1
};
```

Bootstrapping: `setPlatform(p)` module singleton, mirroring multi's `setFlowExecutionServices` seam (module-level registry, 24 lines, no React context needed for non-render code) with a `usePlatform()` convenience for components.

## Every web coupling, mapped (file lists verified in multi)

### storage: localStorage/sessionStorage (19 non-test files)

`app/backendStore.ts`, `app/preferencesStore.ts`, `auth/authClient.ts`, `auth/authStore.ts`, `byok/byokStore.ts`, `byok/inferencePool.ts`, `debug/debugModeRestart.ts`, `docs/docsStore.ts`, `flowchat/chatLru.ts`, `flowchat/memorySource.ts`, `flows/spec-drafts/command.ts`, `gateway/FlowRunUi.tsx`, `pair/executorLease.ts`, `push/pushStore.ts`, `registerServiceWorker.ts`, `smithersCloud/platformBaseUrl.ts`, `smithersCloud/repoCache.ts`, `start/repoRecentsStore.ts`, `tutorial/tutorialReminder.ts`.

Treatment: inject. `KeyValueStorage = { get(key), set(key, value), remove(key) }`, sync API. Web impl wraps localStorage; TUI impl is a JSON file under the workspace state dir (`~/.smithers/tui-state.json` or the workspace `.smithers/`), write-behind. Stores extracted into ui-core switch from direct localStorage calls (or zustand persist middleware) to a zustand persist storage adapter over this port.

### clipboard (3 flow descriptors)

`flows/copy-text/command.ts` (the generic one; already guards `!navigator.clipboard` and fails soft with "clipboard is unavailable"), `flows/copy-file-content/command.ts`, `flows/copy-pair-link/command.ts`. Correction: 3 descriptors, not 4; `runs/nodeProps.ts` mentions clipboard only in a comment.

Treatment: inject. TUI impl: OSC 52 escape write (works through most terminals and over ssh), fallback `pbcopy`/`xclip` when detected, else report unavailable. The copy-text descriptor's existing fail-soft path means no caller changes.

### window.open + downloads

`billing/externalBillingNavigation.ts`, `flows/open-github-app-install/command.ts`, `flows/open-raw-file/command.ts` (window.open); `flows/download-file/command.ts`, `flows/open-raw-file/command.ts` (createObjectURL + anchor download).

Treatment: inject `openExternal(url)` (TUI: spawn `open`/`xdg-open` detached, or print the URL to the status line when headless) and `saveFile(name, bytes)` (TUI: write to cwd or a chosen dir, notify path).

### navigation and history

multi: TanStack Router, URL authoritative; `app/bindRouteStore.ts` subscribes `onResolved` and writes `deriveRoute(pathname, search)` into `app/routeStore.ts` (single writer); `app/navigation.ts` is the write side; `app/history.ts` already returns `createMemoryHistory` with no window.

Treatment: inject `NavigationPort = { openSurface(surface), back(), forward(), current(): RouteState }`. The TUI implements it directly over routeStore + a bounded history stack of RouteState values; deriveRoute/appShellDecision come along unchanged for URL-string round-tripping (deep links printed/parsed as URLs so a TUI state is shareable with the web app).

### OAuth/auth

Web: `__smithers_session` cookie, OAuth redirect; WS auth rides a subprotocol; `auth/authBroadcast.ts` + `auth/authSync.ts` use BroadcastChannel for cross-tab sync.

Treatment: drop the browser flow. The TUI authenticates like the CLI and the existing smithers-mon: local gateway autostart plus `SMITHERS_GATEWAY_URL`/`SMITHERS_TOKEN` env (`packages/tui/src/gatewayConfig.ts`, `startupGateway.ts`). `AuthPort` exposes the principal (from the gateway token) and a no-op change stream. BroadcastChannel: not applicable single-process; the port's event emitter is process-local.

### service worker / Web Push (14 files)

`registerServiceWorker.ts`, `public/sw.js`, `flowchat/remote/machineServiceWorker.ts` and friends, `push/*`.

Treatment: drop in v1 (explicitly out of scope). The `notify` port covers in-app toasts only; OS-level notifications later via `osascript`/`notify-send` if wanted.

### iframes (3 hosts)

- `gateway/FlowRunUi.tsx`: workflow-owned GUIs in sandboxed iframes with an exact-origin postMessage bridge. TUI replacement: the `.smithers/tui/<id>.tsx` custom-TUI surface (04-custom-tuis.md) is the native analog; a GUI-only workflow surfaces as "open in browser" via openExternal, or hijack into `smithers ui`-launched browser? No: openExternal only.
- `engine/EngineCanvas.tsx`: embeds the browser monitor (`smithers monitor`). TUI: drop; smithers-mon IS the monitor. Offer openExternal to the web monitor.
- `chat/HtmlPageCard.tsx`: agent-generated HTML pages (sandbox allow-scripts, srcDoc). TUI v1: render page title + "open in browser" (write srcDoc to a temp file, openExternal).

### layout observers

ResizeObserver (`chat/chatStore.ts`, `terminal/terminalSessionController.ts`, `tutorial/SpotlightOverlay.tsx`), matchMedia (`app/layoutFlip.ts`, `app/preferencesStore.ts`, `start/placeholderPrompts.ts`), pointer-drag layout.

Treatment: inject `ViewportPort = { size(): {cols, rows} | {width, height}, compact(): boolean, subscribe(cb) }`. TUI impl over opentui `useTerminalDimensions` (packages/tui already has `COMPACT_WIDTH = 100`). Pointer-drag panes: replace with keyboard-driven pane sizing; no port needed.

### heavy web widgets (replace wholesale with opentui equivalents)

Verified import sites in multi:

| Web widget | Sites | TUI replacement |
|---|---|---|
| monaco (`monaco-editor`, `@monaco-editor/react`) | `files/MonacoFileViewer.tsx`, `files/monacoLoader.ts`, `files/BlobView.tsx`, `input/VimComposer.tsx` | `<code>` viewer in tui-ui; editing hijacks `$EDITOR` |
| codemirror + `@replit/codemirror-vim` | `input/VimComposer.tsx` only | composer input; vim mode later |
| xterm (`@xterm/xterm`, addon-fit) | `terminal/TerminalSession.tsx`, `terminalSessionController.ts` | the terminal IS the terminal: hijack, or zmux `client.attach` later |
| milkdown (`@milkdown/crepe`, kit) | `files/MarkdownEditor.tsx` | markdown source in `<code>`; editing via `$EDITOR` hijack |
| `@pierre/diffs` / `@pierre/trees` | `files/PierreDiffView.tsx`, `files/FilesCanvas.tsx`, `landings/LandingsCanvas.tsx`, `smithersCloud/landingDiff.ts` | tui-ui `DiffView` over unified-diff text (`diff/diffPaginate.ts` is pure and ports) |
| `@xyflow/react` | `askme/FlowDiagram.tsx`, `askme/flowGraph.ts`, `runs/runToFlow.ts` | `runToFlow.ts` is pure and ports; render via GraphMode-style box cards (packages/tui GraphMode exists) |

multi's arch-check pins each heavy widget to exactly one importer file (SPECIALIZED_COMPONENT_IMPORTERS), which is why wholesale replacement is tractable.

### WebLLM and speech

`flowchat/onDeviceEngine.ts` (`@mlc-ai/web-llm`): drop in v1 (anonymous on-device chat is web-only). Speech: already behind `SpeechRecognitionLike`; the port is optional and absent in TUI v1.

### workers + IndexedDB (found during verification; the prompt missed these)

`flowchat/persist/idbTimelinePersistence.ts`, `flowchat/persist/timelinePersistence.ts`, `flowchat/remote/{connect,machineWorker,sqliteScriptStorage}.ts`, `local/localRepoStore.ts`, `debug/debugModeRestart.ts`, plus `@sqlite.org/sqlite-wasm`.

Treatment: `TimelinePersistencePort` with the interface already implied by `timelinePersistence.ts`; TUI impl over `bun:sqlite` or a JSON log in the workspace state dir. Web workers are an implementation detail behind the port; the TUI runs in-process.

### execution seams that already exist (adopt, do not invent)

- `flows/executionServices.ts`: `FlowExecutionServices = { currentAccountContext?, subscribeAccountContext?, service?(name), notifyFailed? }` with module-level set/get. ui-core adopts this contract verbatim.
- `flows/portableFlowExecution.ts`: `PORTABLE_FLOW_EXECUTOR_SERVICE`; a detached runtime injects ONE executor; `tryExecute` returning undefined delegates to the descriptor's production implementation. The TUI registers a portable executor for flows whose production implementations are browser-bound.
- Per-feature `*ExecutionPort.ts` files (`approvals/approvalDecisionExecution.ts`, `evals/evalsExecutionPort.ts`, `evals/diffGrid/diffGridExecutionPort.ts`, `optimize/optimizeExecutionPort.ts`): keep the naming and the bind/get module-singleton shape for every new port.

## Rules

- Interfaces live in `packages/ui-core/src/platform/`; web impls live in multi (or a `ui-core/src/platform/web/` subpath excluded from the DOM-global arch scan); TUI impls live in `packages/tui/src/platform/`.
- No ui-core module reads a DOM global directly; the arch-check (01-packages.md) enforces it lexically.
- Ports fail soft: unavailable capabilities return typed "unavailable" results (the copy-text precedent), never throw at call sites.
