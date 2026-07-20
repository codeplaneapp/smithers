# 🐛 ui(progress): [low] indicator ignores `max`, diverging visual fill from announced a11y value

GitHub: https://github.com/smithersai/smithers/issues/732

_via ultracode (Opus multi-agent) review_

**Summary:** `Progress`'s visual fill hardcodes a divisor of 100 and never divides by `max`, so the bar diverges from the Radix-computed accessible value whenever `max != 100`.

**Location:** `packages/ui/src/progress.tsx:17` (prop type at `:7`, `max` forwarded via `...props` at `:13`).

**Details:** `ProgressProps = ComponentProps<typeof ProgressPrimitive.Root>` advertises Radix's `max` prop (default 100), and it is spread into `ProgressPrimitive.Root`, which honors it for `aria-valuemax`/`data-state`/value label. But the indicator style is `translateX(-${100 - (value ?? 0)}%)`, treating `value` as a raw percentage.

**Failure scenario:** `<Progress value={25} max={50} />` → Radix sets aria-valuenow=25, aria-valuemax=50 (screen reader: 50% complete), but the indicator computes `translateX(-75%)`, rendering a 25%-filled bar. Visual (25%) and a11y (50%) disagree. `value` is also unclamped for `<0` / `>max` (masked only by `.sui-progress { overflow:hidden }`).

**Why it matters:** The public prop type and Radix advertise `max` support, but the visual layer silently ignores it — a type/behavior contract violation in a published component that yields a misleading bar and an a11y inconsistency for any external consumer using a non-100 max. Fix: `translateX(-${100 - ((value ?? 0) / (max ?? 100)) * 100}%)` with clamping. No in-repo caller currently sets `max` (only test usage at `packages/ui/tests/components.test.tsx:248` with no `max`), so this is latent but real for library consumers.
