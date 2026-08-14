# @smthrs/engine — src

The concrete Smithers workflow execution engine.

- `engine.js` — `runWorkflow` and the react-driver run loop, plus per-task
  execution (`legacyExecuteTask`, dispatched through `effect/workflow-bridge`):
  agent invocation, caching, heartbeats, hijack handoff, and schema-retry.
- `approvals.js`, `signals.js`, `human-requests.js` — durable human-in-the-loop
  primitives (approve/deny, signal delivery, blocking human requests).
- `child-workflow.js`, `task-compute-fns.js` — child-workflow execution and the
  Subflow/Sandbox compute-fn attachment.
- Durability: `startDurability.js`, `snapshotService.js`/`snapshotServer.js`,
  `restoreWorkspace.js`, `durabilityGapSpool.js`, `pruneWorkspaceDurability.js`,
  `workspaceWatcher.js`, and doc sync (`createDocWatcher.js`,
  `startDocFileSync.js`, `syncDocsFromDisk.js`).
- `AgentTraceCollector.js` — bounded capture of agent traces per attempt.
- Subdirectories: `aspects/` (per-run token/cost/latency budget enforcement),
  `effect/` (Effect unstable cluster + workflow bridges, RPC schema, builder),
  `hot/` (hot-reload controller/overlay/watch), `external/` (vendored
  json-schema-to-zod).

Entry point: `index.js` is the public barrel — but package.json also exposes a
`./*` wildcard subpath export mapping to `src/*.js`, so every file here is
importable by consumers. Treat filenames and their exports as public API; do
not move or rename files.

Gotchas: the `__engineInternals` / `__approvalInternals` /
`__childWorkflowInternals` bundles are imported directly by tests (and reach
consumers via the barrel or the `./*` subpath), so helpers listed there are
live even with no in-file callers. Type-only `.ts` sidecars (`HijackState.ts`, `RalphState.ts`,
…) carry the types for the `.js` implementations. `// @smithers-type-exports`
blocks in source files are tool-managed — keep them byte-for-byte.
