# apps/smithers design system

How `apps/smithers` (the chat-first PWA) looks. This is the reference the visual
layer must follow. For where state lives (zustand-only, no `useState`/`useEffect`)
see [state-and-routing.md](./state-and-routing.md). This file is separate from
[DESIGN.md](./DESIGN.md), which is the Studio 2 dark-console system; the two apps
do not share tokens.

## Where the styles live

- `src/styles.css` owns the token block (`:root` plus the two dark-mode copies)
  and the genuinely global chrome: app shell, composer, toasts, command menu,
  login panel, sidebar rail.
- Every feature keeps its own CSS in `feature/feature.css` and imports it from one
  of its components (e.g. `control/control.css` is imported by `ControlRing`,
  `auth/auth.css` by `SignInModal`). This keeps feature rules out of the 1900-line
  shared sheet and avoids edit contention when several features change at once.
- `cards/featureCards.css` is the shared layer for card surfaces. It also defines
  the app-wide **button** and **tone** classes (below). It is imported by
  `CardView`, which is reachable from the shell at boot, so its classes are
  available everywhere, not only inside cards.

Rule: a new feature's rules go in `feature/feature.css`, imported from a component
in that feature. Only add to `styles.css` when the thing is genuinely global.

## Tokens

All themeable color comes from CSS custom properties. Never hardcode a hex or rgb
for text, background, border, or shadow; use a token so light and dark both
resolve. The set:

- Text: `--text`, `--text-muted`, `--text-faint`, `--text-placeholder`
- Surfaces: `--bg`, `--surface`, `--surface-glass`, `--surface-glass-strong`
- Lines/states on neutral: `--border`, `--border-strong`, `--border-solid`,
  `--hover`, `--hover-subtle`
- Inverse (the dark-on-light / light-on-dark fill): `--inverse-bg`,
  `--inverse-bg-hover`, `--inverse-text`
- Brand and status: `--brand`, `--success`, `--danger`
- Code: `--code-bg`, `--code-text`, `--inline-code-bg`
- Graph/nodes: `--graph-*`, `--node-*`
- Brand mark (theme-invariant, no dark override): `--logo-bg`, `--logo-ring`,
  `--logo-stem`
- Run-state tones (in `featureCards.css`): `--st-running/ok/waiting/failed/info/idle`,
  surfaced per element through `--tone` via the `.tone-*` classes.

Two rules that catch most drift:

1. **Shadows use the channel form** `rgb(var(--shadow-rgb) / <alpha>)`. A raw
   `rgba(0,0,0,…)` shadow breaks dark mode, where `--shadow-rgb` flips to `0 0 0`
   at higher alpha. Example: `box-shadow: 0 10px 30px rgb(var(--shadow-rgb) / 0.1)`.
2. **No token fallbacks.** Every token is always defined in `:root`, so
   `var(--success, #0f8f78)` is dead code and hides the dark-mode value. Write
   `var(--success)`.

Dark mode is two duplicated blocks (`:root[data-theme="dark"]` for the explicit
toggle and `@media (prefers-color-scheme: dark)` for the OS default). A new token
that should change with theme must be added to both. A theme-invariant constant
(the `--logo-*` mark colors) goes in `:root` only.

## Buttons

There are two primary looks. Pick a class; do not re-declare the recipe.

- **`.btn-brand`** (brand-filled): the primary call to action. Defined in
  `featureCards.css`. Compose with `.btn` for the standard 32px / 9px-radius
  shape, or with a feature class for a different shape. The onboarding pill CTAs
  do this: `className="btn-brand ob-begin"` keeps the brand fill, hover, and focus
  ring from `.btn-brand` and adds only the pill radius and entrance animation.
- **Inverse fill** (`background: var(--inverse-bg); color: var(--inverse-text)`):
  inline form-submit buttons that sit next to an input (`.login-row button`,
  `.remote-controls button`, `.ob-goal-send`, `.mic-button`).
- **`.btn`** is the neutral/secondary button; **`.btn-deny`** is the destructive
  variant. Both in `featureCards.css`.

Hover for filled buttons is `filter: brightness(1.06)`. Use that one value.

## Glass

Frosted surfaces (auth chip, composer, toasts, nav buttons, rail, overlays) use
`blur(<n>px) saturate(180%)` over `--surface-glass` / `--surface-glass-strong`.
Always declare `-webkit-backdrop-filter` immediately before `backdrop-filter`;
Safari and the iOS PWA ignore the unprefixed property and the blur silently
no-ops.

```css
-webkit-backdrop-filter: blur(18px) saturate(180%);
backdrop-filter: blur(18px) saturate(180%);
```

## Focus

Keyboard focus has one shared treatment, defined once in `styles.css` as a long
`:focus-visible` selector list that applies `outline: 2px solid var(--brand);
outline-offset: 2px`. Any custom or filled control that washes out the UA ring
must be added to that list. Adding `.btn-brand` there, for instance, rings every
brand button across the app.

Text inputs may instead use the composer's brand glow:
`border-color: color-mix(in srgb, var(--brand) 40%, var(--border))` plus
`box-shadow: 0 0 0 4px color-mix(in srgb, var(--brand) 14%, transparent)`. A new
interactive control with no focus treatment is a bug. A non-interactive element
(`pointer-events: none`) needs none.

## Radii

`7-8px` inputs, buttons, small panels. `9-12px` menu options and small controls.
`14-16px` cards. `18-20px` composer and large cards. `999px` pills, switches,
avatars. Match a sibling rather than inventing a value.

## Motion

The `prefers-reduced-motion` block in `styles.css` ends with a global safety net
that clamps every animation and transition to near-zero, so a new `@keyframes`
is covered by default. Add an explicit entry only for a prominent transform that
needs a tailored reduced-motion fallback (see the onboarding fly-to-corner).
