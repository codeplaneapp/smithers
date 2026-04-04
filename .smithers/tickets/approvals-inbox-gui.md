# Dedicated approvals inbox in GUI

## Revision Summary

- Clarified that this can ship as a dedicated GUI tab before full URL routing
  exists.
- Added a required cross-run approvals API instead of relying on per-run approval
  queries.
- Added steps for approval metadata hydration, polling/SSE, optimistic updates, and
  selection preservation.
- Marked deep-link routing as optional follow-on work that can land with the
  CLI-to-GUI ticket.

## Problem

The GUI RunsList has a "Pending Approvals Only" checkbox, but there's no dedicated
approval queue. Approvals are the highest-urgency operator interaction — they block
workflow progress and often have time sensitivity. They deserve their own page.

As the suggestion notes: "This should probably exist even if the rest of the GUI is
thin."

## Proposal

Add an approvals inbox to the GUI as a dedicated operator surface. In the current
GUI this should ship as a first-class tab/view; if route-based navigation is added
later, the same surface can also live at `/approvals`.

### Layout

- **Queue list** — all pending approvals across all runs, sorted by wait time
  (longest-waiting first)
- **Detail panel** — for selected approval: run context, node context, what the
  workflow is asking for, what happens on approve vs deny
- **Inline actions** — approve/deny buttons with optional note field

### Each approval row shows

- Run ID + workflow name
- Node ID + label
- What's being approved (from approval metadata/description)
- Time waiting
- Approve / Deny action buttons

### Behavior

- Auto-refresh on interval (or SSE/polling from a dedicated approvals endpoint, not
  by scraping `/ps`)
- Approving/denying inline updates the list without page reload
- Badge count in the sidebar nav showing pending approval count
- Link from each approval to the full run detail page

## Additional Steps

1. Add a cross-run DB/API query that joins approvals with run and node context.
2. Include request title/summary/metadata in the API payload so the queue is
   actually actionable.
3. Add a GUI transport method dedicated to approvals instead of repurposing the
   runs endpoint.
4. Implement the inbox in the current tab-state app first; URL routing/deep links
   can be layered on later.
5. Preserve selected approval across refreshes when it still exists in the result
   set.
6. Use optimistic row removal or state refresh after approve/deny so the queue feels
   immediate.
7. Add empty/error/loading states and a sidebar badge count.

## Implementation notes

- The `/approval/list` or equivalent API endpoint may need to be added (currently
  approvals are queried per-run via `listPendingApprovals(runId)` — need a cross-run
  query)
- Add a `listAllPendingApprovals()` method to `SmithersDb` that queries
  `_smithers_approvals WHERE status = 'pending'` joined with `_smithers_runs` for
  run context
- Current GUI note: `gui/src/ui/App.tsx` uses local tab state, not SolidRouter, so
  the first version should add a new tab/view there. Route sync is a follow-on.
- Sidebar nav: add approvals link with pending count badge

## Verification requirements

### E2E tests (Playwright)

1. **Approvals page renders** — Navigate to `/approvals`. Assert page loads without
   error, shows "Approvals" heading.

2. **Pending approvals listed** — Start 2 workflows that hit approval gates. Navigate
   to `/approvals`. Assert both approvals appear with: run ID, node ID, workflow name,
   time waiting.

3. **Sorted by wait time** — Oldest-waiting approval appears first. Assert order.

4. **Approve inline** — Click "Approve" button on an approval row. Assert the row
   disappears from the queue. Assert the workflow resumes (check via API).

5. **Deny inline** — Click "Deny" button. Assert row disappears. Assert the workflow
   handles denial.

6. **Approve with note** — Type a note in the note field, click Approve. Assert the
   note is persisted in `_smithers_approvals.note`.

7. **Auto-refresh** — Start a new workflow that hits approval. Without reloading the
   page, assert the new approval appears in the queue within the refresh interval.

8. **Badge count** — Assert sidebar nav shows pending count badge (e.g., "2"). After
   approving one, badge updates to "1".

9. **Link to run detail** — Click run ID link in an approval row. Assert navigation to
   `/runs/<runId>`.

10. **Empty state** — No pending approvals. Assert page shows "No pending approvals"
    message, not a blank page.

### Corner cases

11. **100 pending approvals** — Seed 100 approvals. Assert page renders without
    performance degradation. Consider pagination.

12. **Approval resolved by CLI while GUI is open** — Approve via
    `smithers approve <id>`. Assert GUI removes the row on next refresh.

13. **Concurrent approve** — Two users approve the same approval simultaneously. First
    succeeds, second gets "Already resolved" feedback.

14. **Run deleted while approval pending** — Edge case: run data is missing. Assert
    approval row shows graceful "Run not found" instead of crashing.

## Observability

No new metrics needed — approval metrics (`smithers.approvals.*`) already exist.

### API endpoint
- Add `GET /approval/list` (or `/approvals`) returning all pending approvals cross-run
- Response: `{ approvals: [{ runId, nodeId, iteration, workflowName, requestedAtMs, waitingMs }] }`

## Codebase context

### Smithers files
- `gui/src/ui/App.tsx` — Main GUI shell. Add an approvals tab/view here first; route
  support can come later.
- `gui/src/ui/RunsList.tsx:1-60` — Reference for list page pattern: `createResource`,
  `<For>` loop, table layout, status chips. Approvals page follows same pattern.
- `gui/src/ui/api/transport.ts` — API transport layer. Add `fetchApprovals()` function
  calling the new `/approval/list` endpoint.
- `src/db/adapter.ts` — `listPendingApprovals(runId)` exists for per-run queries.
  Add `listAllPendingApprovals()` that queries cross-run with JOIN to `_smithers_runs`.
- `src/server/index.ts` — Add `GET /approval/list` route. Pattern: look at existing
  `/ps` route for how list endpoints are structured.
- `src/components/Approval.ts:1-102` — Approval component; understanding the approval
  lifecycle helps design the inbox UX.
- `src/cli/index.ts:2031-2085` — `approve` CLI command; the GUI approve action calls
  the same API endpoint that backs this command.
- `tests/approval-component.test.tsx` — Existing approval tests; reference for how
  approval state transitions are asserted.

## Effect.ts architecture

### Boundary rule

All internal code MUST stay in Effect. Never call `runPromise()` or `runSync()` inside
internal modules. The only places allowed to break out of Effect into promises are:

- **CLI command handlers** — the outermost `run(c)` function in `src/cli/index.ts`
- **HTTP route handlers** — the outermost handler in `src/server/index.ts`
- **JSX component boundaries** — React/Solid components that call into Effect services
- **Test entry points** — `Effect.runPromise` in test files

Everything else — DB queries, engine logic, transport calls, validation, metrics,
logging — must compose as `Effect<A, E, R>` and flow through the Effect pipeline.
Do not wrap Effect code in `runPromise()` to get a Promise, then re-wrap that Promise
in `Effect.tryPromise()`. Keep the Effect chain unbroken.

**Rule:** ALL internal code must use Effect.ts. Only user-facing API boundaries (JSX components, React GUI) are exempt. The GUI itself (Solid.js) is a user-facing boundary -- no Effect there. The API handler uses Effect.

### Packages

- **`effect`** core — `Effect.gen`, `Effect.all`, `Effect.annotateLogs`, `Effect.withLogSpan`, `Stream` for real-time updates

No `@effect/workflow` or `@effect/cluster` needed — this is an API handler and query pipeline using Effect core.

### Key mapping

The cross-run approval query should be an Effect pipeline in the server route handler. The SSE/polling endpoint should use `Stream` for real-time updates:

```typescript
import { Effect, Stream, Schedule } from "effect"

// Cross-run approval query as an Effect pipeline
const listAllPendingApprovals = Effect.gen(function*() {
  yield* Effect.withLogSpan("api:approvals:list")(
    Effect.gen(function*() {
      // Join approvals with run context
      const approvals = yield* queryPendingApprovalsWithRunContext()

      yield* Effect.annotateLogs({ pendingCount: approvals.length })

      return approvals.map((a) => ({
        runId: a.runId,
        nodeId: a.nodeId,
        iteration: a.iteration,
        workflowName: a.workflowName,
        label: a.label,
        requestedAtMs: a.requestedAtMs,
        waitingMs: Date.now() - a.requestedAtMs,
      }))
    })
  )
})

// Approve/deny handler as an Effect
const handleApprovalDecision = (params: {
  runId: string
  nodeId: string
  decision: "approved" | "denied"
  note?: string
}) => Effect.gen(function*() {
  yield* Effect.annotateLogs({ runId: params.runId, nodeId: params.nodeId })
  yield* Effect.withLogSpan("api:approvals:decide")(
    resolveApproval(params)
  )
})
```

### SSE/polling endpoint with Stream

```typescript
// Real-time approval updates via Stream
const approvalUpdatesStream = Stream.repeatEffect(
  listAllPendingApprovals
).pipe(
  Stream.schedule(Schedule.spaced("2 seconds")),
  // SSE: emit when approval list changes
  Stream.changes,
)

// Server route handler (Effect pipeline)
const approvalsRoute = Effect.gen(function*() {
  const approvals = yield* listAllPendingApprovals
  return { approvals }
})
```

### Boundary clarification

- **GUI (Solid.js)**: `gui/src/ui/App.tsx`, `gui/src/ui/RunsList.tsx` — These are user-facing boundaries. No Effect here. Use `createResource`, `<For>`, etc. as normal Solid.js patterns.
- **API transport**: `gui/src/ui/api/transport.ts` — This is a boundary layer. `fetchApprovals()` is a plain `fetch()` call.
- **Server route handler**: `src/server/index.ts` — This IS internal code. Must use Effect. The route handler wraps `listAllPendingApprovals` in the Effect runtime.
- **DB adapter**: `src/db/adapter.ts` — This IS internal code. `listAllPendingApprovals()` must be an Effect pipeline.

### Effect patterns to apply

- `Effect.gen` for the cross-run approval query pipeline
- `Effect.all` if multiple queries need to be joined (approvals + runs + nodes)
- `Stream.repeatEffect` with `Schedule.spaced` for SSE/polling real-time updates
- `Stream.changes` to only emit when the approval list actually changes
- `Effect.withLogSpan("api:approvals:list")` for route handler observability

### Smithers Effect patterns to follow

- `src/effect/runtime.ts` — Use the custom runtime layer for server route execution
- `src/effect/metrics.ts` — Approval metrics (`smithers.approvals.*`) already exist; no new metrics needed
- `src/effect/logging.ts` — Annotate with `{ pendingCount }` for monitoring
- `src/effect/interop.ts` — Use `fromPromise()` to bridge existing adapter methods into Effect

### Reference files

- No `@effect/workflow` or `@effect/cluster` reference needed for this ticket
- Follow the patterns in `src/effect/runtime.ts` for Effect execution context
- Follow the patterns in `src/server/index.ts` for how to wire Effect pipelines into HTTP route handlers
