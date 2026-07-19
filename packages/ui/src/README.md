# @smithers-orchestrator/ui — src

The shared component library for Smithers UIs: shadcn anatomy (`data-slot`
attributes, CVA variant APIs, `asChild` via Radix Slot) styled exclusively
through the ui-styleguide theme tokens, so every component is correct in light
AND dark with zero dark-mode code.

How the pieces fit, infrastructure first:

- `cn.ts` — clsx class composition (no tailwind-merge needed; all classes are
  namespaced `sui-*` so there is nothing to merge).
- `tokens.ts` — the `var(--house-token, #lightFallback)` bridge onto the
  styleguide theme. Never emits `:root`; tints only via
  `color-mix(in srgb, ...)`.
- `status.ts` — shared status vocabulary: `normalizeStatus`, `statusClass`,
  `formatStatus`, `isTerminalRunStatus`.
- `uiCss.ts` — the whole stylesheet as one JS string; per-component blocks
  composed into `smithersUiCss`.
- `styles.tsx` — `SmithersUiStyles` render path plus the `useInjectUiCss`
  browser fallback, deduped via `SMITHERS_UI_STYLE_ATTR`.
- One file per component (`button`, `badge`, `card`, `dialog`, `select`, ...)
  plus house compositions (`status-pill`, `empty-state`, `section-header`,
  `row-button`, `kpi-stat`, `file-tree`, `stage-strip`). `index.ts` is the only
  entry point and defines the public API.
- `file-tree.tsx` — the generic collapsible `FileTree`: a flat list of
  `/`-delimited paths grouped into nested directories with expand/collapse,
  controlled single selection (`selected` + `onSelect`), and an optional
  per-leaf trailing affordance slot. Props-driven, with no app/store coupling.
- `chat/` contains the shared Multi-style conversation surface:
  `ChatTranscript`, `ChatMessage`, and the controlled glass `ChatComposer`.
  These are transport-neutral so workflow UIs can feed them Gateway events,
  SSE text, PTY screen snapshots, or stored messages without bringing runtime
  hooks into the visual layer.
- `adapters/` wraps heavy third-party widgets that must NOT weigh down the base
  barrel. Each ships behind its own package subpath, never `index.ts`, so
  `@smithers-orchestrator/ui` stays light and `check-ui-architecture.mjs` keeps
  the heavy dependency out of the base export:
  - `PierreDiffView` (`@smithers-orchestrator/ui/adapters/pierre-diff-view`) is
    the syntax-highlighted diff surface over `@pierre/diffs` `processPatch` +
    `CodeView`. It is props-driven with no app coupling: an explicit `mode`
    (`"light" | "dark"`) maps onto a `DiffsThemeNames` value, and a `layout`
    prop toggles `"split"` (side-by-side) vs `"inline"` (unified). The pure
    seams `diffsThemeForMode`, `diffStyleForLayout`, and `patchToCodeViewItems`
    are exported alongside the component.

Gotchas (all enforced by `../tests/css-contract.test.ts`):

- CSS ships as a string, never `import "./x.css"` — the gateway UI bundler
  drops CSS artifacts. Every rule is document-global so Radix portal content
  stays styled. Colors resolve only through the tokens bridge, and fallbacks
  must stay byte-equal to the styleguide light values.
- Every component calls `useInjectUiCss()`, so a consumer who forgets
  `<SmithersUiStyles/>` still renders styled; standalone (non-gateway) hosts
  pass `withTheme` to `SmithersUiStyles` to also get the theme token block.
