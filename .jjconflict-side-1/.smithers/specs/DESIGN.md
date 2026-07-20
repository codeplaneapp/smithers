# Smithers Studio 2 — Design System

## The one idea: it's a console, not a SaaS dashboard

Imagine you're sitting in front of a flight operations console at night. The room
is dark on purpose. The screens are mostly calm, near-monochrome — until something
*moves*. A run starts: a thin blue bar lights up the left edge of a node. A gate
opens: an amber pill appears. Something fails: a red dot. Your eye is pulled to the
*one thing that changed*, because everything else stayed quiet.

That is the whole design thesis. Smithers Studio 2 is an **agent operations
console**. Saturated color is a *signal*, never decoration. The base is a dark,
low-contrast surface stack so that the moments that matter — running, blocked,
failed, approved — are the only things that glow.

This is the opposite of the original "spaceship" UI, which showed 25 panels at once
and used color everywhere, so nothing stood out. Here, color earns its place.

### Three rules that fall out of that idea

1. **Dark base, quiet by default.** Three stacked surfaces (`bg`, `surface1`,
   `surface2`) carry depth. Text is white at three opacities, never pure-on-pure.
2. **Color = state, not branding.** `accent` (blue) means "live / running / the
   primary verb." `success` / `warning` / `danger` map to *run states*. If a color
   appears, a human should be able to ask "what is it telling me?" and get an answer.
3. **Motion is feedback, not flair.** 120–150ms ease-out on real state changes
   (selection, open/close, the running cursor). No decorative animation. Respect
   `prefers-reduced-motion`.

If you remember nothing else: **the screen should be boring until an agent does
something.**

---

## Token reference

All tokens live in `src/theme.css` as CSS custom properties on `:root`, and are
mirrored as named TypeScript constants in `src/theme/themeTokens.ts` (one export,
no inline magic hex anywhere in components — read the var or the const). Every
component reads `var(--token)`; nothing hardcodes a hex value.

### Color — surfaces

| Token            | Value     | Use                                   |
| ---------------- | --------- | ------------------------------------- |
| `--bg`           | `#0C0E16` | App background, behind everything     |
| `--surface-1`    | `#141826` | Sidebar, cards, panels                |
| `--surface-2`    | `#1A2030` | Raised surfaces: palette, sheets, headers |

### Color — text (white at opacity)

| Token              | Value               | Use                          |
| ------------------ | ------------------- | ---------------------------- |
| `--text-primary`   | `rgba(255,255,255,.88)` | Titles, primary labels   |
| `--text-secondary` | `rgba(255,255,255,.60)` | Secondary labels, captions |
| `--text-tertiary`  | `rgba(255,255,255,.45)` | Hints, paths, empty states |

### Color — lines & fills

| Token             | Value               | Use                                |
| ----------------- | ------------------- | ---------------------------------- |
| `--border`        | `rgba(255,255,255,.08)` | Hairline borders, dividers     |
| `--fill-hover`    | `rgba(255,255,255,.04)` | Row/button hover                |
| `--fill-selected` | `rgba(76,141,255,.12)`  | Selected nav row / list item    |

### Color — signals (the only saturated color)

| Token        | Value     | Run-state meaning                    |
| ------------ | --------- | ------------------------------------ |
| `--accent`   | `#4C8DFF` | Live / running / primary CTA         |
| `--success`  | `#34D399` | Completed / approved                 |
| `--warning`  | `#FBBF24` | Waiting / pending approval (a gate)  |
| `--danger`   | `#F87171` | Failed / denied / has-failed-descendant |
| `--info`     | `#60A5FA` | Informational, neutral run events    |

Signal-on-fill tints (used for pills/badges/selected rows) are derived at 12–22%:
`--accent-fill: rgba(76,141,255,.12)`, `--accent-fill-strong: rgba(76,141,255,.22)`,
`--accent-stroke: rgba(76,141,255,.35)`.

### Radius

| Token            | Value | Use                          |
| ---------------- | ----- | ---------------------------- |
| `--radius-card`  | `8px` | Cards, buttons, palette, sheets |
| `--radius-pill`  | `4px` | Pills, badges, shortcut keys |
| `--radius-row`   | `0`   | Sidebar nav rows (full-bleed) |

### Spacing scale

`--space-1: 4px` · `--space-2: 6px` · `--space-3: 8px` · `--space-4: 12px` ·
`--space-5: 14px` · `--space-6: 16px` · `--space-7: 24px` · `--space-8: 32px` ·
`--space-9: 40px` · `--space-10: 48px`

### Typography

| Token            | Value                                          | Use            |
| ---------------- | ---------------------------------------------- | -------------- |
| `--font-sans`    | `system-ui, -apple-system, "Segoe UI", sans-serif` | Body / UI  |
| `--font-mono`    | `ui-monospace, SFMono-Regular, Menlo, monospace`   | Code / tree / paths |
| `--text-body`    | `14px`                                          | Default body   |
| `--text-mono`    | `11px`–`12px`                                    | Mono cells, tree nodes |
| `--text-label`   | `12px`                                          | Nav labels     |
| `--text-section` | `10px` / 700 / uppercase                         | Section headers |

### Motion

| Token           | Value            | Use                          |
| --------------- | ---------------- | ---------------------------- |
| `--motion-fast` | `120ms`          | Hover, selection             |
| `--motion-base` | `150ms`          | Open/close, sheet transitions |
| `--ease`        | `cubic-bezier(.2,.8,.2,1)` | ease-out for all of the above |

Under `prefers-reduced-motion: reduce`, the running-cursor pulse holds at full
opacity and transitions collapse to 0ms.

---

## The CSS custom-property block (verbatim — paste into `src/theme.css`)

```css
:root {
  color-scheme: dark;

  /* surfaces */
  --bg: #0C0E16;
  --surface-1: #141826;
  --surface-2: #1A2030;

  /* text */
  --text-primary: rgba(255, 255, 255, 0.88);
  --text-secondary: rgba(255, 255, 255, 0.60);
  --text-tertiary: rgba(255, 255, 255, 0.45);

  /* lines & fills */
  --border: rgba(255, 255, 255, 0.08);
  --fill-hover: rgba(255, 255, 255, 0.04);
  --fill-selected: rgba(76, 141, 255, 0.12);

  /* signals */
  --accent: #4C8DFF;
  --success: #34D399;
  --warning: #FBBF24;
  --danger: #F87171;
  --info: #60A5FA;

  /* signal-on-fill tints */
  --accent-fill: rgba(76, 141, 255, 0.12);
  --accent-fill-strong: rgba(76, 141, 255, 0.22);
  --accent-stroke: rgba(76, 141, 255, 0.35);

  /* radius */
  --radius-card: 8px;
  --radius-pill: 4px;
  --radius-row: 0;

  /* spacing scale */
  --space-1: 4px;
  --space-2: 6px;
  --space-3: 8px;
  --space-4: 12px;
  --space-5: 14px;
  --space-6: 16px;
  --space-7: 24px;
  --space-8: 32px;
  --space-9: 40px;
  --space-10: 48px;

  /* typography */
  --font-sans: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  --text-body: 14px;
  --text-mono: 12px;
  --text-mono-sm: 11px;
  --text-label: 12px;
  --text-section: 10px;

  /* motion */
  --motion-fast: 120ms;
  --motion-base: 150ms;
  --ease: cubic-bezier(0.2, 0.8, 0.2, 1);

  font-family: var(--font-sans);
  background: var(--bg);
  color: var(--text-primary);
  font-synthesis: none;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
}

* { box-sizing: border-box; }
body { margin: 0; min-width: 320px; min-height: 100vh; background: var(--bg); }
button, input { font: inherit; }
button { cursor: pointer; }

@media (prefers-reduced-motion: reduce) {
  :root { --motion-fast: 0ms; --motion-base: 0ms; }
}
```

## Component visual contracts (so surfaces stay consistent)

- **NavRow:** 16px icon + 12px label (600 when selected, regular otherwise),
  padding `--space-3` / `--space-2`, `--radius-row` (full-bleed), foreground
  `--accent` when selected else `--text-secondary`, selected background
  `--fill-selected`, hover `--fill-hover`.
- **Pill / badge:** `--radius-pill`, mono 11px, signal color on its 12–22% fill.
- **Card / button:** `--radius-card`, `--surface-1` bg, `1px solid --border`.
  Primary button: `--accent` bg, white text.
- **Selected palette row:** `--accent-fill-strong` fill + `1px solid --accent-stroke`.
- **Running cursor (live leaf node):** 2px `--accent` left bar + play glyph
  pulsing opacity 1.0s ease-in-out (held under reduced-motion).
