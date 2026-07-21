# @smithers-orchestrator/gateway-ui — src

Self-styled React components over `@smithers-orchestrator/gateway-react` hooks,
meant to be dropped into custom workflow UIs (`.smithers/ui/<workflow>.tsx`).
Components use inline styles only — no `.css` imports — so they bundle cleanly
through the gateway's `Bun.build`, and all accept `className` + `style` overrides.

**Public-surface warning:** the package `exports` map includes `"./*" -> "./src/*.ts"`,
so EVERY file here is importable by consumers, whether or not `index.ts`
re-exports it (e.g. `NodeRow`). External importers exist
(`packages/smithers/src/gateway-ui.js`, `apps/cli/src/monitor-ui/monitor.tsx`,
`apps/telegram-summary`, `apps/review`, `.smithers/ui/*`) — do not move, rename,
or split files in this directory.

Component map:
- `theme.ts` — style tokens as `var(--token, #lightFallback)` expressions plus
  the status→color map. Tokens are `var()` expressions, so derive tints with
  `color-mix(...)`, never a hex+alpha suffix.
- `styleguide.tsx` / `styleguide-css.ts` — re-export the shared
  `@smithers-orchestrator/ui-styleguide` CSS and the `WorkflowUiShell` scaffold.
- Pure components: `StatusPill`, `NodeRow`, `MonitorButton` (a link to the
  Gateway's `/monitor`, deep-linked to the current `runId`).
- Hook-driven: `RunList`, `RunTree`, `RunEventLog` (structured event rows with a
  kind badge, nodeId chip, per-row JSON, heartbeat coalescing, and node
  selection), `NodeChatStream`, `ApprovalPanel`, `LaunchButton`,
  `WorkflowPicker`, `ConnectionBadge`, `NodeOutputView`, `NodeOutputCard`.
- `SimpleWorkflowDashboard` — the batteries-included composition of the above.
- `WorkflowGraph` — an n8n-style ReactFlow + dagre DAG canvas built from a
  `WorkflowSpecNode[]`; each node is a self-styled `SmithersTaskNode` card (kind
  kicker, status dot, title, output). `workflowToFlow` is the pure dagre layout
  util. Unlike the rest of the package it pulls in `@xyflow/react` + `dagre`, so
  its required base stylesheet ships inline as `workflowGraphCss` (rendered in a
  `<style>` tag) to survive the gateway's `Bun.build` (which drops `.css`).

`NodeOutputCard` wraps `NodeOutputView`'s envelope handling (`unwrapNodeOutput`)
in card chrome with an ok/fail/pending status glyph and a render-prop body given
the unwrapped row — the generic form of the `OutputCard`/`SummaryPanel` shape
hand-rolled across `.smithers/ui/*` (ticket-fleet, issue-train, orchbench, …).
It also folds in the `key={remountKey + ":" + nodeId}` remount convention.

Gotchas: list-shaped RPCs (runs, approvals) are pull-only on the local gateway
path, so those components poll via `pollMs` (default 2000, `0` disables).
`NodeRow` keys children by `runNodeKey` (structural position), not logical id,
because loop/retry attempts share an id. `tests/` covers only the pure pieces
via `renderToStaticMarkup`; hook-driven components are exercised by the
gateway-react integration tests and the real-backend e2e suite.
