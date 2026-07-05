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
  `row-button`, `kpi-stat`). `index.ts` is the only entry point and defines the
  public API.

Gotchas (all enforced by `../tests/css-contract.test.ts`):

- CSS ships as a string, never `import "./x.css"` — the gateway UI bundler
  drops CSS artifacts. Every rule is document-global so Radix portal content
  stays styled. Colors resolve only through the tokens bridge, and fallbacks
  must stay byte-equal to the styleguide light values.
- Every component calls `useInjectUiCss()`, so a consumer who forgets
  `<SmithersUiStyles/>` still renders styled; standalone (non-gateway) hosts
  pass `withTheme` to `SmithersUiStyles` to also get the theme token block.
