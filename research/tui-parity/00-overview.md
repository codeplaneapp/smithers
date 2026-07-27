# TUI parity program: overview

Make the terminal a first-class frontend for Smithers with the same product UX as multi (`/Users/williamcory/multi`, "Smithers Code"). We build our own TUI on opentui + React inside the smithers repo. The mechanism is a package split: isomorphic logic packages (identical stack on web and terminal) and platform-visual packages (web DOM vs opentui), so multi and the TUI become thin shells over one headless layer.

This spec set lives in `research/tui-parity/` (mandated by the program prompt; ongoing design docs otherwise live in `.smithers/specs/`). Source prompt: `research/smithers-tui-parity-prompt.md`. Every claim here was cross-checked against the code on 2026-07-27; where the prompt and the code disagreed, the code won and the discrepancy is noted in the file that covers it.

## Decisions already made (do not relitigate)

1. No pi, no fork of any existing TUI product. Custom TUI, smithers repo, opentui + React (`@opentui/core` + `@opentui/react`, pinned `^0.4.2`).
2. Isomorphic components live in separate packages from platform-specific (usually visual) components.
3. Logic components are always the same stack on both platforms; only leaf visual components differ.
4. Web-platform capabilities are dependency-injected behind interfaces defined in the isomorphic layer.
5. All end-to-end testing of the TUI goes through zmux (`/Users/williamcory/zmux`).
6. `.smithers/tui/` joins the starter pack; every seeded GUI gets a TUI twin.

## The package architecture

```
ISOMORPHIC (React, zero DOM, zero opentui)
  packages/gateway-client        exists: transport, wire types
  packages/gateway-react         exists: 26 data hooks; the ONLY react-dom
                                 import in src/ is createGatewayReactRoot.ts
  packages/ui-core   [NEW]       headless product layer extracted from multi
                                 + packages/tui: pure domain modules, feature
                                 stores, headless bridges, view-model hooks,
                                 flow/command descriptor protocol, Platform DI
                                 interfaces (02-platform-di.md)

PLATFORM-VISUAL (leaf rendering, props-in/callbacks-out, no business logic)
  packages/ui, packages/gateway-ui   exist: web DOM. Note: the smithers repo's
                                 own scripts/check-ui-architecture.mjs already
                                 ratchets gateway-ui + ui-styleguide as LEGACY;
                                 new web code prefers @smithers-orchestrator/ui.
  packages/tui-ui    [NEW]       opentui leaf library mirroring the ui/
                                 gateway-ui vocabulary: StatusPill, EmptyState,
                                 Keybar, RunTree, RunEventLog, ApprovalCard,
                                 DiffView, ChatTranscript, ListTable...

SHELLS
  /Users/williamcory/multi       web shell; consumes smithers packages through
                                 pnpm overrides (verified: 4 link:../smithers/
                                 packages/* entries), so extracted packages are
                                 immediately consumable
  packages/tui                   terminal shell (@smithers-orchestrator/tui,
                                 bin smithers-mon): modes, keybindings, layout,
                                 hijack = ui-core + tui-ui
```

Boundary enforcement is mechanical from day one: extend the smithers repo's existing `scripts/check-ui-architecture.mjs` (exact-ratchet baseline in `scripts/ui-architecture-baseline.json`; `@opentui` is already a tracked visual-dependency prefix) with two new rule classes: ui-core must not import opentui, react-dom, or DOM globals; tui-ui must not import gateway-client, gateway-react, or business logic. multi's own 653-line `scripts/check-ui-architecture.mjs` (three rule classes, no baseline, hard CI fail) is the model for rule style.

Extraction direction: move multi's pure-domain modules, stores, and bridges into ui-core and re-import them from multi in the same change. Never copy-paste-fork.

## What already exists (verified)

- `packages/tui` is real and green: opentui ^0.4.2, React 19, gateway-react hooks running under opentui. It is the conventions seed: `App.tsx` global key routing (`routeAppKey`), `data.ts` single facade over gateway-react hooks (`TUI_EVENT_CAP = 2000`), `RendererContext`/`OverlayContext`/`Keybindings`/`ErrorBoundary`, and `modes/` where every mode is a thin opentui view plus a pure sibling `*Utils.ts` tested without a TTY. Extend this app; keep its patterns. Full inventory in 03-tui-screens.md.
- `packages/tui/src/modes/HijackMode.tsx` + `hijackUtils.ts` implement the hijack primitive (suspend renderer, spawn child with inherited stdio, resume exactly once on close/error/unmount). Today it only spawns the smithers CLI `hijack` command; 05-hijack.md generalizes it.
- The `.smithers/ui/<id>.tsx` custom-GUI contract: self-containment is enforced at pack-generation time by `scripts/generate-workflow-pack.ts` (`uiRelativeImportsOf`), the gateway resolves `ui/<key>.tsx` by convention on every request, and `smithers ui` derives the workflow key from the run. 04-custom-tuis.md mirrors this exactly for `.smithers/tui/`.
- zmux is a Zig PTY daemon speaking newline-delimited JSON over a unix socket, with no VT emulator and no TS client anywhere. We write the first one. 06-zmux-harness.md has the corrected protocol facts.

## Product scope and phase order

Parity target is multi's UX translated to keyboard-first terminal idiom (chat-first home, surfaces as embeds/modes, palette for everything), not pixel mimicry. multi's UX law (SPEC.md section 7.0): every feature surface is a chat embed; fullscreen is a mode of an embed. The TUI translation: every surface is a mode reachable from the chat home and the palette.

1. Boilerplate + rails: ui-core/tui-ui scaffolded, arch-check green, zmux Bun harness with a first green e2e driving the existing smithers-mon.
2. Runs: runs list + run inspector (tree/logs/diff/approve) on extracted view-models; existing smithers-mon modes refactor onto ui-core.
3. Approvals queue + human requests.
4. Chat concierge home (transcript + composer + slash-command autocomplete over the flow catalog; embeds open as panes/modes).
5. VCS/diff, tickets, memory, prompts, scores, crons: one thin mode each.
6. Palette (the cmd-K analog) over multi's `src/palette/palette.ts`.
7. Hijack generalized: run any TUI command; agent-session hijack as a preset; picker.
8. Custom TUIs: `.smithers/tui/<id>.tsx` contract, seeding, `smithers tui` command, GUI-vs-TUI preference.

Explicitly out of scope for v1: service worker/push, pair multiplayer, WebLLM anonymous mode, Electrobun, OAuth browser flows (the TUI authenticates the way the CLI already does: local gateway/token env, see `packages/tui/src/gatewayConfig.ts`).

## Non-negotiable repo rules

- New workspace packages: a row in `docs/reference/package-configuration.mdx` (machine-diffed against workspace packages by `scripts/check-docs.mjs`), a root `package.json` `workspace:*` devDependency, `pnpm docs:llms` regen, ui-architecture baseline updates, and BOTH `pnpm-lock.yaml` and `bun.lock` in the same commit. CI reads only the pnpm lockfile; `bun.lock` keeps local bun installs honest.
- Root gate names are `check:docs`, `check:llms`, `check:ui-architecture`, `check:deps` (dependency boundaries). A new package must pass all of them plus `check:dts` to land.
- Real backends in product code and e2e; no mocks. TUI unit tests without a TTY use pure `*Utils`/view-model modules (existing packages/tui pattern; render tests use the headless renderer via `@opentui/react/test-utils`, skipped on win32). Full-screen behavior is zmux e2e.
- `jj st` / `jj diff` for working-copy truth; never blanket-stage; opentui stays pinned at ^0.4.2 unless upgraded deliberately.
- Every phase of the workflow ends with typecheck + affected package tests + arch-check + a review gate before the next begins (07-workflow-plan.md).

## Prompt-vs-code discrepancies found during verification

- multi's SPEC.md has no section 12 (numbering jumps 11 to 13); 14 top-level sections, not 15. Section 15 is the convergence ledger as claimed.
- `paletteDomain.ts` does not exist; the pure palette module is `src/palette/palette.ts` (the test file is named `paletteDomain.test.ts`).
- `docs/spec/features.json` holds 78 records (prompt said ~90); `docs/spec/content/features/` has 78 pages (prompt said ~80); `docs/deck/assets/` is 26 PNGs + 4 GIFs + a manifest (prompt said 28 screenshots).
- Clipboard touches 3 flow descriptors, not 4 (`copy-text`, `copy-file-content`, `copy-pair-link`).
- Zustand store count: 63 `*Store.ts` files, 62 modules importing zustand; the prompt's "62" matches the latter.
- multi imports the scoped names `@smithers-orchestrator/gateway-react` (23 files) and `@smithers-orchestrator/gateway-client` (14 files).
- The 300 flow descriptor dirs are exactly 300 and the tree is flat (nesting is documented but unused).
- zmux corrections are material and collected in 06-zmux-harness.md (no caller-supplied session id; `command` is a shell string; `env` replaces the whole child environment; capture is raw ANSI bytes with no grid; notifications broadcast to every connection; backpressure closes slow clients).
- smithers root scripts use colons (`check:docs`, not `check-docs`), and `smithers up --interactive` today hard-fails with `TUI_MONITOR_UNAVAILABLE` when the TUI package is missing (no inline-stream fallback, contrary to older design notes).

## File map

- `00-overview.md` this file
- `01-packages.md` exact module inventory to extract from multi into ui-core
- `02-platform-di.md` the Platform interface; every web coupling mapped
- `03-tui-screens.md` screen-by-screen: multi surface to TUI mode
- `04-custom-tuis.md` the .smithers/tui contract, seeding, smithers tui command
- `05-hijack.md` hijack today and its generalization
- `06-zmux-harness.md` client protocol, helper API, determinism, CI
- `07-workflow-plan.md` the phase DAG `.smithers/workflows/tui-parity.tsx` implements
