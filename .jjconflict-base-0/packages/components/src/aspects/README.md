# aspects/

Cross-cutting configuration (token budgets, latency SLOs, metrics tracking)
propagated down the component tree via React context.

- `AspectContext.js` — the `AspectContext` React context plus
  `createAccumulator()`. `<Aspects>` (in `../components/Aspects.js`) provides
  it; `<Task>` reads it and attaches the config as `__aspects` metadata on the
  host element.
- `AspectAccumulator.ts`, `AspectContextValue.ts`, `LatencySloConfig.ts`,
  `TokenBudgetConfig.ts`, `TrackingConfig.ts` — type-only sidecars.

Gotchas:

- The engine — not this package — enforces budgets/SLOs at task-dispatch time;
  these files only carry configuration down the tree.
- The `perTask` fields on `TokenBudgetConfig`/`LatencySloConfig` are declared
  but documented as not yet enforced.
