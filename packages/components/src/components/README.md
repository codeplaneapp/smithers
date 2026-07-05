# components/

The component library. `index.js` is the curated export surface; its
`@smithers-type-exports` block is tool-managed (keep byte-for-byte). Every
component has a type-only `FooProps.ts` sidecar.

Rough layers:

- **Core primitives** — Workflow, Task, Sequence, Parallel, Loop/Ralph,
  Branch, Worktree, MergeQueue, ContinueAsNew.
- **Engine-backed hosts** that render straight to `smithers:*` elements —
  Subflow, Sandbox, WaitForEvent, Signal, Timer, HumanTask, Approval, Saga,
  TryCatchFinally.
- **Composite patterns** built from the primitives — Kanban, Panel,
  CheckSuite, Debate, ReviewLoop, Optimizer, ContentPipeline, ApprovalGate,
  EscalationChain, DecisionTable, DriftDetector, ScanFixVerify, Poller,
  Supervisor, Runbook, Sidecar, and the `delegation/` subtree.

Gotchas:

- **The "Panel lesson"**: a `needs` map alone neither gates execution nor
  injects upstream outputs — the engine only uses it to key cache context.
  Real gating is `dependsOn` (or Sequence order); real injection is the
  `deps` prop on Task. See Panel.js / CheckSuite.js for the correct pattern.
- Components that forward `props.key` to their host node (Signal, Approval,
  HumanTask) must be wrapped in a keyed `<React.Fragment>` when keyed in a
  list, or React's special-prop warning trips.
- `Loop.js` is a re-export shim of Ralph.js kept so the public
  `components/Loop` subpath resolves.
