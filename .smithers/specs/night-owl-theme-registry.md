# Night Owl theme registry: multi-theme support for the house styleguide

## Goal

Add a first-class color-theme registry to the Smithers UI styleguide. Eight themes, each with a light and a dark variant. `night-owl` becomes the default theme everywhere, including the `var()` fallbacks. Theme selection is a new axis (`data-palette` on `<html>`) orthogonal to the existing light/dark axis (`data-theme` + `prefers-color-scheme`), which stays exactly as it is. Syntax-highlighting surfaces (the Pierre diff view via Shiki, the xterm terminal adapter) use each theme's literal upstream colors.

## The theme suite

All Shiki ids below are bundled in `@shikijs/themes` 3.23.0 (already installed transitively via `@pierre/diffs`). All are MIT licensed. Verified.

| key | label | dark Shiki id | light Shiki id |
|---|---|---|---|
| `night-owl` (default) | Night Owl | `night-owl` | `night-owl-light` |
| `fucory` | Fucory | `github-dark` | `github-light` |
| `one` | One | `one-dark-pro` | `one-light` |
| `github` | GitHub | `github-dark` | `github-light` |
| `catppuccin` | Catppuccin | `catppuccin-mocha` | `catppuccin-latte` |
| `solarized` | Solarized | `solarized-dark` | `solarized-light` |
| `gruvbox` | Gruvbox | `gruvbox-dark-medium` | `gruvbox-light-medium` |
| `rose-pine` | Rosé Pine | `rose-pine` | `rose-pine-dawn` |

`fucory` is the CURRENT zinc + violet house palette, renamed. Its token values are today's `lightTokens`/`darkTokens` from `packages/ui-styleguide/src/themeTokens.ts`, preserved byte-for-byte, and its Shiki pair is today's `github-dark`/`github-light` behavior. It is hand-encoded, never generated.

## Current architecture (verified facts; skip rediscovery)

- Canonical palette: `packages/ui-styleguide/src/themeTokens.ts`. `lightTokens`/`darkTokens` are per-variant joined token strings; `sharedTokens` holds theme-invariant color-mix tint recipes, legacy aliases, and geometry. Only the per-variant blocks change per theme; `sharedTokens` stays single.
- `packages/ui-styleguide/src/standaloneThemeCss.ts` and `index.ts` wrap these into the injected styleguide CSS (`workflowUiThemeCss` / `SmithersUiStyles`). Read them before designing the emission.
- Consumers emit `var(--token, #lightFallback)`: `packages/ui/src/tokens.ts` and `packages/gateway-ui/src/theme.ts`. `packages/ui/tests/css-contract.test.ts` enforces that fallbacks are byte-equal to the styleguide light values and forbids raw hex outside fallback position. Other files carrying fallback hexes: `packages/ui/src/uiCss.ts`, `packages/ui/src/canvas/canvasCss.ts`, `packages/ui/src/sandbox/sandboxCss.ts`, `packages/ui/src/vault/vaultCss.ts`, `packages/gateway-ui/src/workflowGraphCss.ts`, `packages/gateway-ui/src/LaunchButton.tsx`, `packages/gateway-ui/src/styleguide-css.ts`.
- Light/dark resolution: `resolveTheme` / `useResolvedTheme` in `@smthrs/ui` (`packages/ui/src/internal/`). `data-theme="dark|light"` on `<html>` overrides `prefers-color-scheme`; the gateway host page supports `?theme=`.
- Syntax seams:
  - `packages/ui/src/adapters/pierre-diff-view.tsx`: `diffsThemeForMode` returns `github-dark`/`github-light`; `CodeView` tokenizes through Shiki. `DiffsThemeNames = BundledTheme | (string & {})`.
  - `packages/ui/src/adapters/terminal.tsx` (~lines 44-73): hardcoded xterm `ITheme` maps `DARK_THEME`/`LIGHT_THEME`.
  - `scripts/generate-ui-themes.ts`: generates `crepeTheme.generated.ts` (three checked-in copies) and holds a duplicated hardcoded copy of the palette (`crepeLightHouseTokens`/`crepeDarkHouseTokens`).
- The Shiki theme modules contain the full VS Code workbench `colors` map (e.g. `editor.background`, `button.background`). `night-owl` and `rose-pine` include `terminal.ansi*`; `one-light` does not. Handle absence with a documented derivation fallback.

## Design contract

### 1. Theme records and registry

New files in `packages/ui-styleguide/src/` (house rules: one named export per file, filename matches the export, `index.ts` barrels only):

- `SmithersTheme.ts`: the record type. Shape: `{ key, label, light: ThemeVariantTokens, dark: ThemeVariantTokens, syntax: { shikiDark, shikiLight }, terminal: { dark, light } }`. `ThemeVariantTokens` covers exactly the per-variant custom properties currently in `lightTokens`/`darkTokens` (color-scheme, bg, text, text-muted, text-faint, text-placeholder, surface, surface-2, surface-3, surface-glass, surface-glass-strong, border, border-strong, border-solid, hover, hover-subtle, inverse-bg, inverse-text, code-bg, code-text, inline-code-bg, brand, success, danger, warning, info, shadow-rgb, shadow-1/2/3). Terminal palettes mirror the xterm `ITheme` fields used today.
- `themes/` folder, one file per theme: `nightOwl.ts`, `fucory.ts`, `one.ts`, `github.ts`, `catppuccin.ts`, `solarized.ts`, `gruvbox.ts`, `rosePine.ts`.
- `themeRegistry.ts`: ordered `key -> SmithersTheme` map plus `DEFAULT_THEME_KEY = "night-owl"`.
- A serializer (own file) that turns a variant into the joined token-string format `themeTokens.ts` uses today. `themeTokens.ts` keeps exporting `lightTokens`/`darkTokens`/`sharedTokens` for backcompat, with the per-variant pair now derived from the default theme's record.

### 2. Generating theme records from the literal upstream themes

Extend `scripts/generate-ui-themes.ts` or add a sibling generator script (keep the `// Generated by ... do not edit.` convention; run with bun; generated output is checked in). The generator reads the Shiki theme JSONs and emits the six generated theme files (`fucory` is hand-encoded; `night-owl` may be generated with a hand-override map or hand-encoded from the seed table below, your call, but its values must match the seed table).

Resolution: import `@shikijs/themes/<id>` via `createRequire` anchored at `packages/ui`'s `@pierre/diffs` dependency (`createRequire(require.resolve("@pierre/diffs/package.json", ...))` or equivalent). Do NOT add any new dependency to any package.json. If resolution proves brittle, check in extracted per-theme JSON snapshots (workbench colors only, with a provenance header naming source package and version) as the generator's input.

Derivation rules per variant:

- `bg` = `editor.background`; `text` = `editor.foreground`.
- Surface ramp synthesized with color-mix of text into bg, matching the elevation semantics of the current zinc ramp (dark: bg < surface < surface-2 < surface-3 getting lighter; light: bg one step below a near-white surface). Fixed mix percentages are fine; a per-theme override map is expected for themes whose chrome colors (`sideBar.background` etc.) give better real values.
- Borders as alpha-of-text mirroring the current recipes; hover near surface-2; inverse pair swaps bg/text; glass = surface at the existing alphas.
- `code-bg`/`code-text` = the variant's own editor colors. Exception: `fucory` keeps its current values verbatim (including dark code blocks in light mode).
- Brand and status seeds, then a contrast pass:
  - `night-owl`: brand dark `#c792ea`, light `#994cc3`; info `#82aaff` / `#4876d6`; success `#addb67` / seeded from `#2AA298`; danger `#ef5350` / seeded from `#E64D49`; warning seeded from `#ecc48d` (dark) / `#daaa01` (light).
  - Others: brand from each theme's signature accent (`button.background`, `focusBorder`, or `activityBarBadge.background`, with per-theme overrides where those are wrong aesthetically); status colors from the JSON's error/warning/git-decoration colors.
  - Contrast pass (implement in the generator, with unit tests): for each variant, darken (light variant) or lighten (dark variant) brand/status colors until text at that color reaches >= 4.5:1 WCAG contrast against its soft tint (the `sharedTokens` color-mix recipe percentages over that variant's surface). This mirrors the existing hand-derivation noted at `themeTokens.ts:34`.
- Terminal ANSI: from `terminal.ansi*` when the JSON has them; otherwise derive from the seed colors (document the mapping). `fucory` keeps the current `DARK_THEME`/`LIGHT_THEME` values from `terminal.tsx` verbatim.

### 3. CSS emission and selection

- The styleguide CSS emits the default theme exactly as today (`:root` light, media-query dark guarded with `:root:not([data-theme='light'])`, `:root[data-theme='dark']` override), plus for every non-default theme K three parallel blocks keyed by `:root[data-palette='K']`. `sharedTokens` is emitted once, unchanged.
- `data-palette` on `<html>` selects the theme; absent or `night-owl` means default. `data-theme` keeps meaning light/dark. Orthogonal axes.
- Gateway host page: support `?palette=<key>` alongside the existing `?theme=` handling (find where `?theme=` is applied and mirror the mechanism, including any persistence it has).
- Add `resolvePalette`/`subscribePalette` (and a hook) next to `resolveTheme`/`useResolvedTheme` in `@smthrs/ui`, same attribute-observation pattern, defaulting to `night-owl`.

### 4. Default flip and fallback sweep

With `night-owl` default, `lightTokens` serializes Night Owl Light values, so every `var(--x, fallback)` light fallback across `packages/ui` and `packages/gateway-ui` must be updated byte-for-byte (the css-contract test enumerates violations; fix everything it flags, plus the gateway-ui files it does not cover, keeping the three-way sync noted in the token file comments). Update the crepe palette copies in `scripts/generate-ui-themes.ts` to the night-owl pair and regenerate all generated artifacts with bun.

### 5. Syntax seams

- `pierre-diff-view.tsx`: theme lookup replaces the hardcoded pair. Resolve the active palette (new resolver/hook), map to the registry's `syntax` pair; keep the existing `mode` prop; add an optional `palette` override prop.
- `terminal.tsx`: replace the two hardcoded `ITheme` constants with registry lookup by active palette and resolved light/dark mode. Keep the `colors` override prop semantics.

### 6. Docs

Docs-driven development: update the styleguide/theming docs under `docs/` to document the registry, the suite table, `data-palette`, `?palette=`, and the default. Check `scripts/generate-llms.ts` CORE_PAGES first: if an edited page is in the manifest, regenerate the llms bundles only from a clean state per repo discipline (never bake foreign uncommitted docs edits into the bundles); if the tree carries foreign docs WIP in manifest pages, constrain edits to non-manifest pages and note the follow-up. No em-dashes anywhere under `docs/` (check-docs gates on it).

### 7. Tests (the bar is high)

- Registry: every theme has both variants, every token key present in both, no raw hex leaking outside sanctioned positions, Shiki ids are members of the bundled-theme union (typecheck-level or a runtime list check).
- Contrast: automated WCAG assertions for every theme and both variants: brand/status text on its soft tint >= 4.5:1.
- Fucory regression: `fucory`'s serialized light and dark variants byte-equal the pre-change `lightTokens`/`darkTokens` strings (pin the old strings in the test).
- Emission: `data-palette` blocks present for every non-default theme in all three states (base light, media dark, explicit dark); default emission shape unchanged from today apart from values.
- css-contract test green after the sweep.
- Adapters: theme-pair lookup unit tests for the diff view and terminal.
- Existing suites green: run `bun test` in `packages/ui`, `packages/gateway-ui`, `packages/ui-styleguide`, then `pnpm -r --no-bail test` and confirm no NEW failures (this machine has known pre-existing local false-reds around subprocess capture; verify suspicious reds via `bun -e` before treating them as real, and never weaken an assertion to get green).

## Constraints

- No new dependencies. No pnpm-lock.yaml changes.
- Shared jj tree discipline: this tree may carry other sessions' WIP. Never `git add -A`, blanket `git commit`, `git stash`, `git commit --amend`, or `git rebase`. Diagnose with `jj st`/`jj log`, not `git status`. Commit only files you created or edited, with explicit pathspecs (`jj commit <paths> -m "..."`). Before committing any file, check `jj diff -- <file>` shows only your hunks; if a file carries foreign hunks, leave it uncommitted and list it in your summary. Do NOT push.
- Writing style: Google developer-docs register; short declarative sentences; no em-dashes; no marketing adjectives. Code comments follow the existing files' density and register.
- House code rules: one named export per file, filename matches export, colocate by domain, `index.ts` barrels only.
- If genuinely blocked or facing an ambiguous destructive choice, use `smithers ask-human`; never guess.

## Definition of done

- All new and pre-existing tests green as scoped above; typecheck green for the touched packages.
- Generated artifacts regenerated and committed (crepe copies, generated theme files).
- Work committed locally via jj with explicit pathspecs and a descriptive message; not pushed; a summary lists every file touched and any file left uncommitted due to foreign hunks.
