# effect/

The bridge between the React/JSX engine (`../engine.js`) and Effect-land
durable primitives (`@effect/workflow`, `@effect/cluster`).

- **Task execution bridges** — `compute-task-bridge.js` (computeFn tasks with
  heartbeats/timeouts), `static-task-bridge.js` (static output tasks),
  `activity-bridge.js` (durable activity wrapper with a bounded result cache).
- **Deferred state** — `deferred-state-bridge.js` reconciles timers,
  wait-for-event, and approval-gated tasks against durable attempt/node rows;
  `durable-deferred-bridge.js` backs them with DurableDeferred resolutions.
- **Cluster runner** — `entity-worker.js` and `single-runner.js` run the
  workflow entity in-process.
- **DSL & contracts** — `builder.js` (code-first `Smithers.workflow` builder),
  `rpc-schema.js` (RPC contract), `versioning.js` (workflow patch decisions),
  `diff-bundle.js` (git diff bundles).
- `workflow-bridge.js` is the authoritative public umbrella, re-exported from
  `src/index.js`; `workflow-make-bridge.js` builds the runtime behind it.
- `http-runner.js` and `sql-message-storage.js` are one-line shims that keep
  the engine subpaths alive over the canonical sandbox/db implementations.

The `.ts` files are type-only sidecars for the `.js` implementations (never
convert between the two); tool-managed `@smithers-type-exports` blocks
re-surface them as JSDoc typedefs.

Gotchas: the package exports map makes every file here a public subpath
(`@smithers-orchestrator/engine/effect/*`), so nothing can be moved or renamed. Each
sizeable module exports a `__*Internals` object consumed by
`packages/engine/tests/*-internals.test.js` — private helpers are part of the
test surface; keep those objects complete when adding or removing helpers.
