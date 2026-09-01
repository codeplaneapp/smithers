# @smthrs/engine

## [Unreleased]

## [1.0.0-rc.0] - 2026-08-31

### Breaking Changes

- Split the flow authoring model out into `@smthrs/flow`. `Flow`, `Action`,
  `RetryPolicy`, `DurableDeferred`, `DurableClock`, `DurableQueue`, and
  `StepIdentity` are no longer exported here; import them from `@smthrs/flow`.
- The `FlowEngine.FlowEngine` service and `FlowEngine.FlowInstance` moved to
  `@smthrs/flow` as `FlowRuntime.FlowRuntime` and `FlowRuntime.FlowInstance`,
  together with `annotateWaiting`, `WaitingAnnotation`, and
  `FlowCycleDetected`. `@smthrs/engine` implements that port; the dependency
  direction is now `@smthrs/flow` ← `@smthrs/engine`, with no cycle.
- `FlowEngine.FlowInstance.initial(flow, executionId)` is now
  `FlowEngine.makeInstance(flow, executionId)`.

### Changed

- Broke the single `FlowEngine.ts` module into a `FlowEngine/` folder:
  `Encoded.ts`, `SnapshotBoundary.ts`, `FlowInstance.ts`, `ActionKey.ts`,
  `make.ts`, `layerMemory.ts`, and the barrel.

- Renamed `Flow.withCompensation` to `Flow.withRollback` in the new
  `@smthrs/flow` authoring package.
- Moved `BoundaryMode` beside the `Action` model it configures in
  `@smthrs/flow`.
- Split the `Flow` and `Action` implementations into focused modules while
  moving their public imports to `@smthrs/flow`.

### Fixed

- Scoped sealed action keys to one run until the composition declares its
  complete layer and capability identity.
- Made in-memory action execution single-flight, snapshotted replay payloads,
  and encoded deferred and clock addresses as injective tuples.
- Made journal lineage and trampoline-round identities injective and added
  typed validation for malformed round bounds.
- Refused colliding proxy operation names and encoded every HTTP flow tag as
  one case-preserving URL-safe segment.
- Made diagnostic rendering total, bounded, accessor-free, and redacting so a
  hostile failure cannot replace the original cause.

## [0.1.0] - 2026-08-05

### Added

- Added the vendored durable flow engine with caller-selected execution
  identity, caller-computed action keys, explicit infrastructure-interrupt
  retry, durability tiers, snapshot boundaries, and signal-assisted resume.

### Fixed

- Kept coverage thresholds on the explicit coverage command so ordinary
  `vitest run` remains the package test gate.
