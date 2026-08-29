/**
 * Bridges the brand tokens onto the token names `@smthrs/ui` actually reads.
 *
 * `virtual:smthrs-app/brand.css` emits the brand as `--house-*` custom
 * properties (@smthrs/create-app/vite). `@smthrs/ui@0.33.0` resolves
 * every color through the `@smthrs/ui-styleguide` names instead (`--bg`,
 * `--text`, `--surface`, `--brand`, `--r-2`, ...), so without this bridge the
 * components render in the styleguide default violet while the bespoke Aomi
 * pieces render in the brand.
 *
 * The sheet is passed to `<SmithersUiStyles extra={...}/>`, which appends it
 * after `workflowUiThemeCss`. Same specificity, later in the cascade, so these
 * declarations win. Values are `var()` references only; no color is spelled
 * here. Deriving tokens (`--ring`, `--brand-soft`) resolve `var(--brand)`
 * lazily, so they follow the override with no extra rule.
 *
 * TEMP: delete once `@smthrs/create-app/vite` emits the styleguide
 * names directly (TODO.md).
 */
export const houseBridgeCss = `:root, :root[data-theme='light'], :root[data-theme='dark'] {
  --font-sans: var(--house-font-ui);
  --font-mono: var(--house-font-mono);
  --bg: var(--house-background);
  --text: var(--house-foreground);
  --text-muted: var(--house-foreground-muted);
  --text-faint: var(--house-foreground-subtle);
  --text-placeholder: var(--house-foreground-subtle);
  --surface: var(--house-surface-raised);
  --surface-2: var(--house-surface);
  --surface-3: var(--house-surface-raised);
  --border: var(--house-border);
  --border-strong: var(--house-border-strong);
  --border-solid: var(--house-border-strong);
  --hover: var(--house-primary-subtle);
  --hover-subtle: var(--house-surface);
  --brand: var(--house-accent);
  --success: var(--house-success);
  --danger: var(--house-danger);
  --warning: var(--house-warning);
  --info: var(--house-info);
  --inverse-bg: var(--house-primary);
  --inverse-text: var(--house-accent-foreground);
  --code-bg: var(--house-primary);
  --code-text: var(--house-primary-subtle);
  --r-1: var(--house-radius-sm);
  --r-2: var(--house-radius-md);
  --r-3: var(--house-radius-lg);
  --r-4: var(--house-radius-xl);
  --r-bubble: var(--house-radius-lg);
  --r-full: var(--house-radius-pill);
  --shadow-1: var(--house-shadow-sm);
  --shadow-2: var(--house-shadow-md);
  --shadow-3: var(--house-shadow-lg);
}
`
