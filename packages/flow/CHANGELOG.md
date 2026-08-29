# @smthrs/flow

## [Unreleased]

### Breaking Changes

- `Flow.make` now requires `body`. A flow with nothing to plan is a category
  error under `docs/specs/Concepts/Unified Flow Authoring.md`: that work is an
  `Action`. Every declaration therefore carries a body, and `Flow.Any.body`
  is no longer optional.
- Removed `toLayer` from the flow surface. Actions carry implementations,
  attached separately with `Action.toLayer`; flows carry bodies, driven by
  `Interpreter.layer`. Registering a behavior under a flow tag is the runtime's
  own seam and is now internal to this package.
- Removed `Flow.Bodied`, which existed only to describe a flow that had a body.
  `Flow.Flow` is that type now.
- Removed `Flow.BodyDefinesBehavior`, the defect a bodied flow raised when a
  second, opaque behavior was attached to it. There is nothing to attach.
- Removed the `missing_body` code from `Interpreter.InterpreterError`.
  `Interpreter.layer` takes a flow that has a body by construction.

### Added

- Added `@smthrs/flow`, the flow authoring model split out of
  `@smthrs/engine`: `Flow`, `Action`, `RetryPolicy`, `DurableDeferred`,
  `DurableClock`, `DurableQueue`, `StepIdentity`, and their schemas, errors,
  results, boundaries, and combinators.
- Added `FlowRuntime`, the execution contract those APIs are written against.
  It replaces the direct dependency the authoring modules had on the engine's
  `FlowEngine` module, so the dependency now runs `@smthrs/flow` ←
  `@smthrs/engine` only. The service formerly exported as
  `FlowEngine.FlowEngine` is `FlowRuntime.FlowRuntime`, `FlowEngine.FlowInstance`
  is `FlowRuntime.FlowInstance`, and `FlowEngine.annotateWaiting` and
  `FlowEngine.FlowCycleDetected` moved with them.
