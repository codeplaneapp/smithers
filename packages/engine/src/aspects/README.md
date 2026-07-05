# aspects/

Budget enforcement for a run: token budgets and latency SLOs declared via the
`<Aspects>` component (`packages/components/src/aspects`).

- `createBudgetTracker.js` — per-run accumulator. Sums `TokenUsageReported`
  usage; wall-clock is measured from the persisted run start so latency
  budgets survive a resume.
- `setupBudgetTracker.js` — builds a tracker, seeds it from persisted events,
  and subscribes it to the EventBus (listener emits are synchronous, so the
  accumulator is current when the scheduler evaluates the next task).
- `evaluateAspectBudget.js` — the pure breach decision. Scope totals only:
  `perTask` limits are not evaluated at dispatch.
- `enforceDispatchBudget.js` — applies `onExceeded` semantics right before
  dispatch: `"warn"` runs the task, `"skip-remaining"` persists the node as
  skipped and records it in `budgetSkippedKeys`, `"fail"` throws
  `ASPECT_BUDGET_EXCEEDED` and fails the run.

`enforceDispatchBudget.js` currently has no in-repo callers (the equivalent
enforcement runs via `options.evaluateAspectBudget` inside
`packages/scheduler/src/makeWorkflowSession.js`); it stays because it is
public API via the package's `./*` wildcard subpath export.
