# Prompt: Bring multi's product UX to the terminal — the Smithers TUI

> **Written for Smithers 0.x.** This note is research from before the 1.0
> rewrite. It describes the JSX workflow runtime, its CLI, or its gateway, none
> of which exist in 1.0.0-rc.0. It is kept as history, not as guidance; see
> `docs/pages/migration/1.0.md` for what replaced each surface it names.

You are implementing a major feature program in the smithers repo (`/Users/williamcory/smithers`). Read this whole prompt first. Your deliverables, in order:

1. **Write the full detailed spec** (a `research/tui-parity/` spec set, screen-by-screen and package-by-package, expanding every section below).
2. **Author a Smithers workflow** `.smithers/workflows/tui-parity.tsx` (+ live UI `.smithers/ui/tui-parity.tsx`) that implements the spec phase-by-phase with review gates. Use `https://smithers.sh/llms-full.txt` as the API reference when writing the workflow.
3. **Land the boilerplate** (new packages, zmux test harness with a first green e2e, `.smithers/tui/` loader) as the workflow's first phases.

## What we are doing (one paragraph)

Make the terminal a first-class frontend for Smithers with the same product UX as multi (`/Users/williamcory/multi`, "Smithers Code"). We are NOT forking or plugging into any existing TUI product — we build our own TUI on **opentui + React** inside the smithers repo, by splitting UI code into **isomorphic logic packages** (identical stack on web and terminal) and **platform-visual packages** (web DOM vs opentui), so multi and the TUI become thin shells over the same headless layer. The TUI gains a **hijack capability** (suspend renderer, hand the pty to any other TUI — claude, codex, htop, anything — then resume), a **custom-TUI surface** `.smithers/tui/<id>.tsx` parallel to the existing `.smithers/ui/<id>.tsx` GUI contract (seeded TUI counterparts for every shipped GUI; user picks which opens by default), and **zmux-driven e2e tests** for everything.

## Decisions already made — do not relitigate

1. No pi, no fork of anything. Custom TUI, smithers repo, opentui + React.
2. Isomorphic components live in separate packages from platform-specific (usually visual) components.
3. Logic components are always the same stack on both platforms; only leaf visual components differ.
4. Web-platform-specific capabilities are dependency-injected behind interfaces defined in the isomorphic layer.
5. All end-to-end testing of the TUI goes through zmux (`/Users/williamcory/zmux`).
6. `.smithers/tui/` joins the starter pack; every seeded GUI gets a TUI twin.

## Ground truth (verified — do not re-derive, do verify paths still exist)

### Smithers repo (the target)

- **`packages/tui` (`@smthrs/tui`, bin `smithers-mon`) already exists**: opentui `@opentui/core`+`@opentui/react` ^0.4.2, React 19, gateway-react. This is living proof gateway-react hooks run under opentui, and it is the conventions seed: `App.tsx` global key routing, `data.ts` single facade over gateway-react hooks (`TUI_EVENT_CAP` shared event ring), `RendererContext`/`OverlayContext`/`Keybindings`, `ErrorBoundary`, and `modes/` where every mode is a thin opentui view + a pure sibling `*Utils.ts` tested without a TTY. Extend this app; keep its patterns.
- **`packages/tui/src/modes/HijackMode.tsx` + `hijackUtils.ts` already implement the hijack primitive**: `startHijackSession` suspends the opentui renderer, spawns a child with inherited stdio, resumes on close/error. Today it only spawns `smithers hijack <runId> --target <nodeId>`. Generalize it into "run any TUI command" (arbitrary command + args), keep the agent-session path as one use of it.
- **`packages/gateway-react` is already isomorphic** except `createGatewayReactRoot.ts` (the only react-dom touch). Hooks: useGatewayRuns/Run/RunEvents/NodeOutput/Approvals/Workflows/Scores/Prompts/Crons/Tickets/MemoryFacts/RunDiff/..., over `@smthrs/gateway-client` (RPC + WS). This is the shared data backbone — both frontends already use it.
- **`packages/ui` and `packages/gateway-ui` are the web-visual layer** (DOM markup; heavy deps isolated under `ui/src/adapters/`). They stay web-only.
- **`.smithers/ui/<id>.tsx` custom-GUI contract**: self-contained modules (relative imports may not escape `.smithers/ui/`), seeded into the shipped pack by `scripts/generate-workflow-pack.ts`, mounted by the gateway, opened with `smithers ui <runId>`. Mirror this exactly for `.smithers/tui/`.

### multi (the UX + code to reuse), repo `@smithersai/code` at `/Users/williamcory/multi`

- Canonical product spec: `SPEC.md` (71 KB, §15 is a per-screen convergence ledger), `docs/spec/features.json` (~90 feature records), `docs/spec/content/features/*.md` (~80 per-screen pages), `docs/architecture/flows.md`, 28 annotated screenshots in `docs/deck/assets/`. **Read SPEC.md §1, §2, §7, §9, §10, §15 and features.json before writing your spec.**
- Stack: React 19 + Vite SPA + Cloudflare Worker; TanStack Router (URL is authoritative, `deriveRoute.ts` → Zustand `routeStore` projection); XState v5 for the chat machine (3 modules under `src/flowchat/`); **62 Zustand feature stores**; gateway-react/gateway-client for runs plane; hand-written token CSS ("Silt & Lagoon", `src/styles.css`), `@smthrs/ui` components (26 sites); a second visual registry is CI-forbidden (`scripts/check-ui-architecture.mjs`).
- Core UX thesis (SPEC §7.0): **everything is a chat embed.** One concierge chat is home; every surface (runs, approvals, diffs, files, terminal, issues, PRs…) renders as an embed in the transcript, addressable by URL; fullscreen is a mode of an embed. Surfaces enumerated in `src/app/Surface.ts`: runs, gatewayRun (4-tab inspector: Flow UI/tree/diff/logs), approvals, vcs, files, terminal, issues, tickets, landings, memory, prompts, scores, evals, crons, agents, palette, engine, docs, admin, environment.
- multi's per-feature file taxonomy is the reuse story (exemplar `src/approvals/`):
  - **Pure domain** (`approvals.ts`, `runsList.ts`, `runProgress.ts`, `statusMeta.ts`, `paletteDomain.ts`, `deriveRoute.ts`, `appShellDecision.ts`, …) — DOM-free, React-free. **100% portable.**
  - **Zustand store** (`approvalsStore.ts`) — portable except localStorage touches.
  - **Headless Bridge** (`ApprovalsBridge.tsx`, returns null, pumps gateway-react hooks into the store) — portable.
  - **Execution ports** (`approvalDecisionExecution.ts`, per-feature `*ExecutionPort.ts`, `src/flows/executionServices.ts`) — existing DI seams.
  - **Flow descriptors** (`src/flows/<kebab-id>/command.ts`, ~300; components never perform effects, they `invokeUserFlow`) — portable protocol; `src/flows/portableFlowExecution.ts` documents the portable path.
  - **Views** (`ApprovalsCanvas.tsx` etc.) — NOT props-only today; they read stores directly and interleave DOM markup. **This is the refactor:** the store-reading/view-model half moves into the isomorphic layer; the markup half stays per-platform.
- Web couplings the DI layer must cover (full list in the spec you write): localStorage/sessionStorage (~20 files), clipboard (4 flow descriptors), `window.open`/download flows, TanStack Router+history (`src/app/history.ts` already platform-branched with a memory history), OAuth redirect auth (`__smithers_session` cookie; WS auth rides a subprotocol), service worker/Web Push, iframes (FlowRunUi workflow GUIs, EngineCanvas monitor), BroadcastChannel, ResizeObserver/matchMedia/pointer-drag layout, Monaco/CodeMirror/xterm/Milkdown/pierre-diffs/xyflow (web-only heavy widgets — TUI replaces wholesale with opentui equivalents), WebLLM, Web Speech (already behind `SpeechRecognitionLike`).
- multi consumes smithers packages via `link:../smithers/packages/*` pnpm overrides — extracted packages are immediately consumable from multi.

### zmux (the test rig), repo at `/Users/williamcory/zmux`

- tmux-style PTY daemon (`zmuxd`, alias `smithers-session-daemon`) in Zig; clients speak **newline-delimited JSON-RPC 2.0 over a UNIX socket**. No npm package — integrate from Bun via `Bun.connect({ unix })`, one JSON doc per line, demux responses (camelCase, by `id`) from notifications (snake_case: `pane_output`, `session_exited`, …).
- Methods for testing: `session.create` (`{id, command, cwd, env, rows, cols}`), `session.send` (`{text, enter}` or `dataBase64`), `session.sendKey` (named keys: Enter, Escape, Tab, arrows, PageUp/Down…), `session.capture` (`{lines}` → raw byte tail **including ANSI escapes — there is no VT emulator/grid**), `session.resize`, `mux.snapshot`, `daemon.ping/shutdown`. Daemon boot for fixtures: spawn `zmuxd --socket <tmp> --idle-seconds 0`, poll for the socket file.
- The canonical assertion pattern is in `test/integration/session_daemon.zig`: `waitForCaptureContains` — poll `session.capture` every ~50 ms until a substring appears, with a deadline. Transliterate that harness (plus `waitForSessionExited`, `rpcLine`, response/notification demux) to a Bun TS helper module.
- Determinism: run the TUI under test with fixed `rows`/`cols` and `NO_COLOR=1`; assert substrings/regex on the capture tail, never full-screen equality. Daemon rejects cross-user peers; Linux/macOS only.
- **No hijack concept exists in zmux** (that's smithers' renderer-suspend mechanism) and **no smithers↔zmux wiring exists yet** — the Bun client + helpers are part of your boilerplate. Binaries build with `zig build` (Zig 0.15.2); prebuilts may exist in `zig-out/bin/`. Tests must skip cleanly when the binary is missing, and CI should build or vendor it.

## Target package architecture (the central refactor)

```
ISOMORPHIC (React, zero DOM, zero opentui — the "logic stack", identical on both platforms)
  packages/gateway-client        (exists — transport, types)
  packages/gateway-react         (exists — data hooks; move createGatewayReactRoot out or leave web-only subpath)
  packages/ui-core   [NEW]       headless product layer extracted from multi + tui:
                                 pure domain modules, feature stores, headless bridges,
                                 view-model hooks (useRunsListVm, useRunInspectorVm,
                                 useApprovalsVm, useChatTranscriptVm, useDiffVm, usePaletteVm, …),
                                 flow/command descriptors + portable execution,
                                 Platform DI interfaces (storage, clipboard, openExternal,
                                 notify, navigation/history, focus/visibility, viewport, auth)

PLATFORM-VISUAL (leaf rendering only, props-in/callbacks-out, no business logic)
  packages/ui, packages/gateway-ui   (exist — web DOM)
  packages/tui-ui    [NEW]           opentui component library mirroring the ui/gateway-ui
                                     vocabulary: Button, Card, StatusPill, EmptyState, Tabs,
                                     RunTree, RunEventLog, ApprovalPanel, DiffView, ChatTranscript…

SHELLS
  /Users/williamcory/multi           web shell (adopts ui-core incrementally; pnpm link makes this live)
  packages/tui                       terminal shell (modes, keybindings, layout, hijack) = ui-core + tui-ui
```

Enforce the boundary mechanically from day one: an arch-check script (model: multi's `scripts/check-ui-architecture.mjs`) that fails CI if `ui-core` imports opentui/react-dom/DOM globals, or if `tui-ui` imports business logic. Extraction direction: move multi's pure-domain modules + stores + bridges into `ui-core` and re-import them from multi (its pnpm `link:` overrides make this a same-day loop) — never copy-paste-fork.

## Product scope and phase order for the TUI

Parity target is multi's UX translated to keyboard-first terminal idiom (chat-first home, surfaces as embeds/modes, palette for everything), not pixel mimicry. Phase order:

1. **Boilerplate + rails**: `ui-core`/`tui-ui` packages scaffolded, arch-check green, zmux Bun harness with a first green e2e driving the existing `smithers-mon`.
2. **Runs**: runs list + run inspector (tree/logs/diff/approve) — extract multi's runs/approvals view-models; TUI modes consume them (today's smithers-mon modes refactor onto ui-core).
3. **Approvals queue** + human requests.
4. **Chat concierge home** (transcript + composer + slash-command autocomplete over the flow catalog; embeds open as panes/modes).
5. **VCS/diff, tickets, memory, prompts, scores, crons** — one thin mode each over their view-models.
6. **Palette** (the ⌘K analog) over `paletteDomain.ts`.
7. **Hijack generalized**: "open any TUI" command (arbitrary argv), agent-session hijack, and a picker; later option: zmux `client.attach` for embedded panes instead of full-terminal handoff.
8. **Custom TUIs**: `.smithers/tui/<id>.tsx` contract (self-contained like `.smithers/ui/`), seeded by `scripts/generate-workflow-pack.ts`, loaded by a new `smithers tui <runId|workflow>` command and from `smithers up` interactive; seeded TUI twins for every seeded GUI; a user preference (config + per-invocation flag) choosing GUI vs TUI as the default open surface.

Explicitly out of scope for v1: service worker/push, pair multiplayer, WebLLM anonymous mode, Electrobun, OAuth browser flows (TUI authenticates the way the CLI already does: local gateway/token).

## Non-negotiable repo rules (from CLAUDE.md + hard-won gotchas)

- New workspace packages: docs `package-configuration.mdx` row, `pnpm docs:llms` regen, ui-arch baseline updates, and **both** `pnpm-lock.yaml` + `bun.lock` in the same commit.
- Any new public export/CLI flag: run `check-docs` before landing, not just typecheck+tests.
- Real backends in product code and e2e — no mocks. TUI unit tests without a TTY use the pure `*Utils`/view-model modules (existing packages/tui pattern); full-screen behavior is zmux e2e.
- `jj st`/`jj diff` for working-copy truth; never blanket-stage; opentui stays pinned at ^0.4.2 unless upgrading deliberately.
- Every phase of your workflow ends with typecheck + affected package tests + a review gate before the next begins.

## Deliverable 1 in detail — the spec set (`research/tui-parity/`)

Write: `00-overview.md` (this program, restated precisely), `01-packages.md` (exact module inventory to extract from multi into ui-core — enumerate the files, exemplar-by-exemplar using the approvals/runs taxonomy above), `02-platform-di.md` (the Platform interface, every web coupling mapped to inject/replace/drop), `03-tui-screens.md` (screen-by-screen: multi surface → TUI mode, keybindings, layout, which ui-core VM + which tui-ui components), `04-custom-tuis.md` (.smithers/tui contract, seeding, `smithers tui` command, preference), `05-hijack.md`, `06-zmux-harness.md` (client protocol, helper API, determinism rules, CI story), `07-workflow-plan.md` (the phase DAG your workflow implements). Cross-check every claim against the actual files; where this prompt and the code disagree, the code wins — note the discrepancy.

## Deliverable 2 in detail — the workflow

`.smithers/workflows/tui-parity.tsx`: phases mirroring the order above, each phase = implement (worktree lane) → typecheck/tests/arch-check → review → gate. `.smithers/ui/tui-parity.tsx`: composed from `smthrs/gateway-ui` + `smthrs/ui` over gateway-react hooks (SimpleWorkflowDashboard baseline is fine). Fetch `https://smithers.sh/llms-full.txt` before writing either file.
