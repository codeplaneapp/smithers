# Make `smithers monitor` truly beautiful (match @smthrs/ui polish)

GitHub: https://github.com/smithersai/smithers/issues/643

## Goal

Make **`smithers monitor` truly beautiful** — bring it up to the polish of the rest of the product. Today it looks sloppy relative to `@smthrs/ui` and the hosted surfaces.

## Why now

`smithers monitor` is the live web UI over every run in a workspace (runs list, execution trees, events, approvals). It's a surface prospective paying users (e.g. Antonio Viggiano, benchmarking us vs Braintrust/LangChain/Prefect Cloud for a "beautiful UI") will judge us on. It currently reads as a dev tool, not a product.

## Scope

- [ ] Design pass: apply the `@smthrs/ui` design system (tokens, component anatomy, 2-theme light/dark — see memory `smithers-ui-design-system`, 21 shadcn-anatomy components) consistently across the monitor.
- [ ] Runs list — hierarchy, status, timing, density.
- [ ] Execution tree — legible node states, retries, nesting.
- [ ] Events view — readable stream, filtering.
- [ ] Approvals — clear, actionable.
- [ ] Empty/loading/error states that don't look broken.
- [ ] Responsive + accessible (theme-aware, keyboard).

## Acceptance criteria

`smithers monitor` looks like it belongs to the same product as the styleguide-themed gateway UI — a designer/maintainer would call it "beautiful," not "sloppy."

## Notes

Coordinate with the 0.28.0 gateway-ui theming work (`1db896a131`, `9aeba9af8c`) so monitor and workflow UIs share one visual language.

