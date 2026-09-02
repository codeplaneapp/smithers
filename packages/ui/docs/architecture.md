# Layering and file layout

shadcn anatomy (`data-slot` attributes, CVA variant APIs, `asChild` via Radix
Slot) styled exclusively through the `@smthrs/ui-styleguide` theme tokens, so
every component is correct in light AND dark with zero dark-mode code.

## Infrastructure, in dependency order

- `cn.ts` — clsx class composition. No tailwind-merge: every class is namespaced
  `sui-*`, so there is nothing to merge.
- `tokens.ts` — the `var(--house-token, #lightFallback)` bridge onto the
  styleguide theme. Never emits `:root`; tints only through
  `color-mix(in srgb, ...)`.
- `internal/resolveTheme.ts` — the exported `resolveTheme()` contract and its
  subscription seam: an explicit `data-theme` on `<html>` wins, otherwise the OS
  color-scheme preference decides.
- `status.ts` — the shared status vocabulary: `normalizeStatus`, `statusClass`,
  `statusColor`, `hasStatusTone`, `formatStatus`, `isTerminalRunStatus`. Every
  lookup table is a frozen null-prototype container, because a status string is
  host data and a plain object literal resolves `statusClass("constructor")`
  through `Object.prototype`.
- `uiCss.ts` — the whole stylesheet as one JS string; per-component blocks
  composed into `smithersUiCss`.
- `styles.tsx` — the `SmithersUiStyles` render path plus the `useInjectUiCss`
  browser fallback.

## Component families

One file per component (`button`, `badge`, `card`, `dialog`, `select`, ...) plus
house compositions (`status-pill`, `empty-state`, `section-header`,
`row-button`, `kpi-stat`, `file-tree`, `stage-strip`). `index.ts` is the only
entry point for the base barrel and defines the public API.

- `file-tree.tsx` — the generic collapsible `FileTree`: a flat list of
  `/`-delimited paths grouped into nested directories with expand/collapse,
  controlled single selection (`selected` + `onSelect`), and an optional
  per-leaf trailing affordance slot. Props-driven, with no app or store
  coupling.
- `chat/` — the shared conversation surface: `ChatTranscript`, `ChatMessage`,
  the controlled glass `ChatComposer`, and the `MessageScroller` family.
  Transport-neutral, so a workflow UI can feed them control-plane events, SSE
  text, PTY screen snapshots, or stored messages without pulling runtime hooks
  into the visual layer.
- `agentic/` — props-driven AI interaction anatomy: reasoning disclosures,
  ordered thought steps, tool invocations, and the `AgentOutput` composition
  over parsed response/reasoning/tool models. It may compose the chat and
  primitive layers but stays independent of every agent or runtime SDK.

## The adapters rule

`adapters/` wraps heavy third-party widgets that must NOT weigh down the base
barrel. Each one ships behind its own `package.json` subpath and is never
re-exported from `index.ts`, so `@smthrs/ui` stays light for a consumer that
only wants a `Button`.

The rule is enforced by `tests/barrel-weight.test.ts`, which bundles
`src/index.ts` with `Bun.build({ target: "browser" })` and asserts that
`recharts`, `@xterm`, `@milkdown`, `@pierre/diffs` and `d3-force` are absent
from the output. It is a real ratchet rather than prose: the rule's previous
enforcer (`scripts/check-ui-architecture.mjs`) was deleted in the 1.0 migration,
and 34 KB of `d3-force` reached the base barrel unnoticed through a
`KnowledgeGraph` re-export before the test existed. `src/index.ts` also lists
the `vault` and `calendar` exports by name rather than re-exporting a
subdirectory barrel, so a future heavy addition cannot ride in silently.

Current adapters:

- `PierreDiffView` (`@smthrs/ui/adapters/pierre-diff-view`) — the
  syntax-highlighted diff surface over `@pierre/diffs` `processPatch` +
  `CodeView`. Props-driven with no app coupling: an explicit `mode`
  (`"light" | "dark"`) maps onto a `DiffsThemeNames` value and otherwise follows
  the active house theme; a `layout` prop toggles `"split"` (side by side)
  against `"inline"` (unified). The pure seams `diffsThemeForMode`,
  `diffStyleForLayout` and `patchToCodeViewItems` are exported alongside the
  component. Its frame, additions and deletions, gutters and stats are bridged
  onto house surface/text/success/danger tokens. Syntax token colors stay the
  bundled Shiki `github-light`/`github-dark` pair: Pierre's `CodeView` accepts a
  theme name but exposes no custom theme-registration prop, so replacing those
  tokens requires owning a separate highlighter and worker registration path and
  is deferred until that can be tested end to end.
- `Terminal` (`@smthrs/ui/adapters/terminal`) — a generic xterm.js render
  surface. The data source is lifted entirely onto props (a `lines` snapshot, a
  `stream` write seam, `onData` out), so it has zero store coupling. Its default
  palette follows the active house theme while an explicit `theme` prop still
  wins. The xterm base stylesheet is vendored as a string
  (`adapters/xtermCss.ts`) and injected through the same style seam the rest of
  the library uses, never a bare `import "@xterm/xterm/css/xterm.css"` that a
  bundler configured to drop CSS artifacts would discard.
- `MarkdownEditor` (`@smthrs/ui/adapters/markdown-editor`) — the Milkdown Crepe
  WYSIWYG surface behind an injectable `loadEditor` seam. See
  [`contracts.md`](./contracts.md) for its failure behavior.
- `Chart` (`@smthrs/ui/adapters/chart`) — the recharts container plus the fixed
  `CHART_SERIES` categorical palette.
- `KnowledgeGraph` (`@smthrs/ui/adapters/knowledge-graph`) — the `d3-force`
  vault graph. The pure `graphModel` and `wikilinks` helpers stay in the base
  barrel; only the renderer sits behind the subpath.

## Styling gotchas

All enforced by `tests/css-contract.test.ts`:

- CSS ships as a string, never `import "./x.css"`, because the bundler this
  package is built for drops CSS artifacts. Every rule is document-global so
  Radix portal content stays styled. Colors resolve only through the tokens
  bridge, and the literal fallbacks must stay byte-equal to the styleguide light
  values.
- Every component calls `useInjectUiCss()`, so a consumer who forgets
  `<SmithersUiStyles/>` still renders styled output. A standalone host passes
  `withTheme` to `SmithersUiStyles` to also get the theme token block.
- `SmithersUiStyles` must be rendered exactly once per document. It cannot
  dedupe itself: it exists to work under `renderToStaticMarkup`, where effects
  never run. `SMITHERS_UI_STYLE_ATTR` is the marker that lets the
  `useInjectUiCss` fallback stand down when a rendered sheet is already present,
  not a mutual guard between the two paths.

## Provenance

Provenance for every ported family is recorded per lane under `provenance/` and
aggregated in `shadcn-provenance.json`. `tests/provenance.test.ts` imports each
manifest's entry module and asserts that the components it names are exactly
what the module exports at runtime, so a lane added without a manifest, or a
manifest that drifts from its module, fails the suite.
