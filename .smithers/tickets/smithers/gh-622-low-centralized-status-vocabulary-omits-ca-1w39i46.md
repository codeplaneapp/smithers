# [low] Centralized status vocabulary omits canonical run states (stale/orphaned/continued/succeeded)

GitHub: https://github.com/smithersai/smithers/issues/622

**Severity:** Low · **Feature:** `@smthrs/ui` · **File:** `packages/ui/src/status.ts:16` and `:66`

## Problem
The centralized status vocabulary (new single source of truth, re-exported by `gateway-ui`) omits several **canonical run states**, so they render as neutral/benign tints:

1. **`statusClass()` (`:16`)** drops `recovering`, `stale`, `orphaned`, `continued`, and `cancelled` into `"muted"` (grey). A run that has gone `stale`/`orphaned` renders a benign grey pill in any `StatusPill` surface (e.g. `SimpleWorkflowDashboard.tsx:121`, `RunList.tsx:118`) instead of a failure tint, hiding a real fault state. The TUI classifier (`headerUtils.ts`) treats `recovering` as active and `stale`/`orphaned` as failed.

2. **`isTerminalRunStatus()` (`:66`, `TERMINAL_STATUSES`)** omits `"continued"` (a canonical raw `RunStatus`) and `"succeeded"` (the derived `RunState` success value). It does include `"finished"` and `"success"`, so the common terminal case is fine — but a `continued`/`succeeded` value reports non-terminal.

Canonical vocab for reference:
- `RunStatus` (raw): `running, waiting-approval, waiting-event, waiting-timer, waiting-quota, paused, finished, continued, failed, cancelled`
- `RunState` (derived): `… paused, recovering, stale, orphaned, failed, cancelled, succeeded, unknown`

## Why low
Latent today: `isTerminalRunStatus` from this package has no active in-repo call site (only re-exports); `statusClass` only hits the raw-status path via `StatusPill`; and it is not a regression (matches the prior per-copy vocab that was consolidated). But these are **public** `@smthrs/ui` helpers, so the gap will bite external consumers and any future call site that feeds derived state.

## Suggested fix
Enumerate the full `RunStatus` + derived `RunState` vocabulary in `statusClass`, `formatStatus`, and `TERMINAL_STATUSES` (map `stale`/`orphaned`→bad, `recovering`→warn, `continued`/`succeeded`→ok+terminal, `cancelled`→bad/terminal). Add tests covering every canonical state.

## Verification
`statusClass` matches three explicit arrays + a `waiting-` prefix and otherwise returns `"muted"`; none of the listed states are enumerated. `TERMINAL_STATUSES` has no `continued`/`succeeded`. The tone maps in `gateway-ui/src/theme.ts` mirror the same gaps.

---
*Found in the pre-0.28.0 review of `v0.27.0..HEAD` (@0ed2c28710), adversarially verified against the code. Part of the `pre-0.28-review` batch.*
