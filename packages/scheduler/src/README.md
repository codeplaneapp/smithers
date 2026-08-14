# @smthrs/scheduler — src

The pure decision engine for Smithers workflows: no IO, no DB, no timers. It
maps a rendered workflow graph plus task states to the next `EngineDecision`.
Consumed primarily by `packages/engine`, which re-exports several helpers via
`packages/engine/src/scheduler.js`.

## How the pieces fit

- `buildPlanTree.js` turns the graph XML into a `PlanNode` tree; node ids inside
  loops get an `@@<ralphId>=<iteration>` scope suffix (`buildLoopScope`).
- `scheduleTasks.js` walks the plan + `TaskStateMap` into a `ScheduleResult`:
  runnable tasks, wait flags, ready Ralph loops, and failure-recovery keys for
  saga/try-catch-finally regions.
- `makeWorkflowSession.js` owns all per-run mutable state and turns engine
  events (task completed/failed, approval, timer, event/signal, hot reload,
  cancel) into `EngineDecision`s via its internal `decide()` loop.
- `Scheduler.js`/`WorkflowSession.js` are the Effect Context tags;
  `SchedulerLive.js`/`WorkflowSessionLive.js` the layers.

## Conventions & gotchas

- Implementation is `.js` with JSDoc; the `.ts` files are type-only sidecars
  re-exported through `index.js`'s tool-managed typedef block.
- Every `.js` module is a subpath export in `package.json`, and each sidecar
  type name is a types-only subpath routed through `index.d.ts` — never move
  or rename a file in this directory.
- Task state keys are `nodeId::iteration` (`buildStateKey`/`parseStateKey`).
- `WorkflowSessionLive` builds ONE shared session per layer scope; the engine
  deliberately calls `makeWorkflowSession()` per run instead (see the warning
  in `WorkflowSessionLive.js`).
- The timer duration parser in `makeWorkflowSession.js` must stay in lockstep
  with the engine's deferred-state-bridge parser — the dependency direction
  (engine → scheduler) forbids importing it here.
