# Incremental Migration Plan: smithers → @smithers/core + @smithers/react

> Each phase is PR-sized, leaves all existing tests green, and is independently shippable.

---

## Phase 0: Infrastructure Setup

**Scope:** Wire workspace dependencies, verify builds compile
**Files:** `package.json`, `tsconfig.json`, workspace config
**Changes:**
- Add `@smithers/core` and `@smithers/react` as workspace dependencies in root `package.json`
- Ensure `bun install` resolves workspace packages
- Add workspace-level test commands that run both package tests and root tests

**Risk:** Low. No behavioral changes.
**Rollback:** Revert `package.json` changes.
**Verification:** All existing tests pass. Both package typechecks pass.

---

## Phase 1: Errors and Interop (Leaf Dependencies)

**Scope:** Replace `src/utils/errors.ts` and `src/effect/interop.ts` imports with re-exports from `@smithers/core`
**~15 files modified**

**What changes:**
- `src/utils/errors.ts` — add re-exports from `@smithers/core/errors` alongside existing code. Existing file becomes a thin facade.
- `src/effect/interop.ts` — add re-exports from `@smithers/core/interop`
- Consumer imports do not change yet (the facade handles the redirect).

**Why first:** Errors and interop are leaf modules with zero internal dependencies. Every other module depends on them.

**New tests:** Verify `SmithersError` from `@smithers/core/errors` is `instanceof`-compatible with the existing one. Verify `toSmithersError` produces identical output.

**Risk:** Low. Types are structurally identical.
**Rollback:** Remove re-exports, revert to direct implementations.
**Verification:** Full test suite passes. `instanceof SmithersError` checks work everywhere.

---

## Phase 2: State and Graph Types

**Scope:** Align `src/engine/scheduler.ts` types with `@smithers/core/state` and `@smithers/core/graph`
**~8 files modified**

**What changes:**
- `src/engine/scheduler.ts` — import `TaskState`, `TaskStateMap`, `buildStateKey`, `parseStateKey`, `isTerminalState` from `@smithers/core/state`. Local definitions become re-exports.
- `src/dom/extract.ts` — import `HostNode`, `HostElement`, `HostText`, `XmlNode`, `TaskDescriptor`, `WorkflowGraph` from `@smithers/core/graph` and re-export them.
- `src/TaskDescriptor.ts`, `src/XmlNode.ts`, `src/GraphSnapshot.ts` — become re-exports from `@smithers/core/graph`.

**Why second:** Pure type/data definitions with no runtime behavior. Consumed everywhere but safe to change because types are structurally identical.

**New tests:** Verify `buildStateKey` and `parseStateKey` from both locations produce identical results.

**Risk:** Low. Watch for required vs optional field differences (e.g., `needsApproval: boolean` vs `needsApproval?: boolean`).
**Rollback:** Revert re-exports back to local definitions.
**Verification:** Full test suite passes. Type checking passes.

---

## Phase 3: Scheduler Logic

**Scope:** Swap `scheduleTasks` and `buildPlanTree` to call `@smithers/core/scheduler`
**~5 files modified**

**What changes:**
- `src/engine/scheduler.ts` — local `scheduleTasks` and `buildPlanTree` become re-exports from `@smithers/core/scheduler`. File becomes a thin facade.
- `src/engine/index.ts` — imports from `src/engine/scheduler.ts` unchanged (facade handles redirect).

**Why third:** Pure computation with no I/O. Depends only on types from Phase 2. Heavily tested by `scheduler-advanced.test.ts`, `scheduler-comprehensive.test.ts`, `engine-scheduler-plan.test.ts`.

**Risk:** Medium-low. Logic is identical but edge-case differences possible in `resolveStableId` or `parseBool`/`parseNum`. Mitigate by running existing scheduler tests against new implementation first.
**Rollback:** Revert `src/engine/scheduler.ts` to original implementation.
**Verification:** `scheduler-advanced.test.ts`, `scheduler-comprehensive.test.ts`, `engine-scheduler-plan.test.ts`.

---

## Phase 4: Graph Extraction (`extractGraph`)

**Scope:** Swap `extractFromHost` in `src/dom/extract.ts` to delegate to `@smithers/core/graph`
**~4 files modified**

**What changes:**
- `src/dom/extract.ts` — `extractFromHost` becomes a wrapper calling `extractGraph` from `@smithers/core/graph`. Old code removed or kept behind feature flag.
- `src/dom/renderer.ts` — update import if needed.

**New tests:** Parameterized test rendering representative JSX workflows through both old and new `extractGraph`, asserting structural equality.

**Risk:** Medium. Most critical function. Watch for:
- Old version uses `isDrizzleTable` and drizzle-orm utilities; new version uses `isZodObject` and `maybeTableName`
- Old version imports `executeChildWorkflow` and `executeSandbox`; new version only extracts, doesn't execute

**Rollback:** Revert `src/dom/extract.ts` to original.
**Verification:** `dom-extract.test.tsx`, `renderer.test.tsx`, `renderer-comprehensive.test.tsx`, all component tests, all engine tests.

---

## Phase 5: Observability — Correlation Context

**Scope:** Replace `src/observability/correlation.ts` with `@smithers/core/observability`
**~6 files modified**

**What changes:**
- `src/observability/correlation.ts` — becomes a re-export facade from `@smithers/core/observability`
- All correlation functions come from the new package
- **Critical:** The `AsyncLocalStorage` and `correlationContextFiberRef` must be the **same singleton instance**. The facade must re-export the new module's instances, not create seconds.

**Risk:** Medium. Two `AsyncLocalStorage` instances = context doesn't propagate. The facade must re-export, not wrap.
**Rollback:** Revert correlation.ts facade.
**Verification:** `observability.test.ts`, `observability-options.test.ts`, `effect-logging.test.ts`, `engine-observability.test.tsx`.

---

## Phase 6: Observability — Metrics Service

**Scope:** Introduce `MetricsService` from `@smithers/core` alongside existing `Metric.*` calls
**~10 files modified**

**What changes:**
- This phase does NOT remove existing `void runPromise(Metric.update(...))` calls. It adds the `MetricsService` to the unified layer.
- `src/effect/metrics.ts` — export a `metricsServiceAdapter` wrapping existing `Metric.*` values behind the `MetricsService` interface
- `src/observability/index.ts` — include `MetricsServiceLive` in composed layer
- Adapter maps metric names to existing Effect `Metric.counter` instances, so both paths update the same counters.

**Why sixth:** Purely additive. Old code still works exactly as before.

**New tests:** Verify `metrics.increment("smithers.runs.total")` through new service increments the same counter as `void runPromise(Metric.increment(runsTotal))`.

**Risk:** Low. Purely additive.
**Rollback:** Remove the adapter and service from the layer.
**Verification:** `effect-metrics-definitions.test.ts`, `effect-metrics-track.test.ts`, `observability-prometheus.test.ts`.

---

## Phase 7: Observability — Tracing Service

**Scope:** Replace `withSmithersSpan` and `annotateSmithersTrace` with `TracingService` from `@smithers/core`
**~8 files modified**

**What changes:**
- `src/observability/index.ts` — `withSmithersSpan` and `annotateSmithersTrace` become wrappers calling through to `TracingService`
- Include `TracingServiceLive` in composed runtime layer
- Existing callers unchanged (facade handles redirect)

**Risk:** Low. Implementations are identical.
**Rollback:** Revert to standalone functions.
**Verification:** `observability.test.ts`, engine observability tests.

---

## Phase 8: Unified Runtime (**HIGH RISK**)

**Scope:** Collapse 4 `ManagedRuntime` instances into 1 using `SmithersCoreLayer` from `@smithers/core/runtime`
**~6 files modified**

**What changes:**
- `src/effect/runtime.ts` — `SmithersRuntimeLayer` composed to include `SmithersCoreLayer`
- `src/effect/activity-bridge.ts` — remove local `activityBridgeRuntime`. Use unified runtime.
- `src/effect/durable-deferred-bridge.ts` — remove `durableDeferredBridgeRuntime`. Use unified runtime.
- `src/effect/sql-message-storage.ts` — trickier (creates per-DB runtimes). May remain separate, or SQL client layer provided dynamically.

**Approach:** Feature flag (`SMITHERS_UNIFIED_RUNTIME=1`) to switch between old (4 runtimes) and new (1 runtime). Tests run with both configurations.

**New tests:** Explicit test that unified runtime provides all required services.

**Risk:** **HIGH.**
- Services in isolated runtimes now share fiber scope → possible resource contention
- `@effect/workflow WorkflowEngine.layerMemory` may have ordering constraints
- `sql-message-storage` per-DB pattern may not collapse cleanly
- `ManagedRuntime` shutdown semantics change with collapse

**Mitigation:**
1. Test-only unified runtime first, keep 4 runtimes in production
2. Full test suite under both configurations in CI
3. Only merge when both pass 100%

**Rollback:** Set feature flag to use old code path.
**Verification:** ALL tests, especially: `durable-deferred-contract.test.ts`, `activity-contract.test.ts`, `workflow-bridge*.test.ts`, `engine.test.tsx`, `durability.test.tsx`.

---

## Phase 9: WorkflowSession Integration (**HIGH RISK**)

**Scope:** Wire `makeWorkflowSession` from `@smithers/core/session` into the engine's main run loop
**~3 files modified**

**What changes:**
- `WorkflowSession` introduced as **shadow mode** — runs alongside existing scheduling code.
- `src/engine/index.ts` — in `runWorkflowBody`, create a `WorkflowSession` and call `submitGraph`/`taskCompleted`/`taskFailed` in parallel with existing logic. Compare decisions in debug mode. Log any divergence.
- Session handles scheduling decisions only; persistence, event emission, and task execution still use existing engine code.

**Why ninth:** Depends on unified runtime (Phase 8) and correct graph extraction (Phase 4).

**New tests:** Verify `WorkflowSession.submitGraph` produces same scheduling decisions as old `scheduleTasks` for representative workflows.

**Risk:** **HIGH.** The `WorkflowSession` is a new state machine. The old engine has 6298 lines of accumulated edge-case handling that may not be captured.
**Rollback:** Remove the shadow session. No behavioral change.
**Verification:** All engine tests pass. Shadow comparison logs show zero divergence.

---

## Phase 10: React Components Migration

**Scope:** Replace `src/components/*` imports with re-exports from `@smithers/react/components`
**~40 component files, ~5 other files**

**What changes:**
- `src/components/index.ts` — becomes re-export facade from `@smithers/react/components`
- Each component file replaced with re-export from `packages/@smithers/react/src/components/`
- `SmithersContext` must be the same React context instance. `src/context.ts` re-exports from `@smithers/react/context`.

**Risk:** Medium. React context singleton issue (same pattern as correlation context in Phase 5).
**Rollback:** Revert `src/components/index.ts` to local implementations.
**Verification:** All component tests: `approval-component.test.tsx`, `components-comprehensive.test.tsx`, `task-deps.test.tsx`, `parallel-edges.test.tsx`, `saga-component.test.tsx`, etc.

---

## Phase 11: Reconciler Migration

**Scope:** Replace `src/dom/renderer.ts` with `SmithersRenderer` from `@smithers/react/reconciler`
**~3 files modified**

**What changes:**
- `src/dom/renderer.ts` — becomes `export { SmithersRenderer } from "@smithers/react/reconciler"` plus local type re-exports
- New `SmithersRenderer` calls `extractGraph` from `@smithers/core` (already swapped in Phase 4)

**Risk:** Low. Reconciler is a mechanical translation layer. Host config is identical.
**Rollback:** Revert to local renderer.
**Verification:** `renderer.test.tsx`, `renderer-comprehensive.test.tsx`, `dom-extract.test.tsx`.

---

## Phase 12: Engine Decomposition (**HIGHEST RISK**)

**Scope:** Refactor `src/engine/index.ts` to use `ReactWorkflowDriver` from `@smithers/react` as the primary run loop
**~3 files modified, 1 major file rewritten**

**What changes:**
- `runWorkflowBody` replaced with `ReactWorkflowDriver.run()`, with engine providing `executeTask`, `onWait`, and `continueAsNew` callbacks
- Engine shrinks from ~6300 lines to ~2000 lines (agent execution, DB persistence, event emission, worktree management, hot-reload, resume, hijack)
- Scheduling loop (~1500 lines inline) gone — `WorkflowSession` handles it
- `runWorkflow` and `runWorkflowEffect` public API unchanged

**Why last:** Culmination. Every dependency is already migrated.

**Approach:** Feature flag (`SMITHERS_LEGACY_ENGINE=1`) to keep old `runWorkflowBody` available. Full test suite under both code paths in CI. Remove flag after 2 weeks of green CI.

**Risk:** **HIGHEST.**
- Effectively rewriting the main run loop
- Edge cases: hijack detection, supervisor polling, caffeinate wake-locks, run heartbeats, stale detection
- Integration may expose order-of-operations issues or race conditions

**Rollback:** Set `SMITHERS_LEGACY_ENGINE=1`.
**Verification:** ALL tests, especially: `engine.test.tsx`, `engine-workflow.test.tsx`, `engine-regressions.test.tsx`, `engine-edge-cases.test.tsx`, `engine-concurrent-runs.test.tsx`, `engine-transactional-writes.test.tsx`, `engine-approvals.test.ts`, `durability.test.tsx`, `resume-*.test.tsx`, `hijack-*.test.tsx`, `hot-*.test.ts`.

---

## Risk Summary

| Phase | Risk | Key Concern |
|-------|------|-------------|
| 0 | Low | Plumbing only |
| 1 | Low | Structural type compatibility |
| 2 | Low | Required vs optional fields |
| 3 | Medium-low | Edge cases in scheduler logic |
| 4 | Medium | drizzle-orm vs simplified type detection |
| 5 | Medium | AsyncLocalStorage singleton |
| 6 | Low | Purely additive |
| 7 | Low | Identical implementations |
| 8 | **High** | 4 runtimes → 1, fiber scope sharing |
| 9 | **High** | New state machine vs 6300-line engine |
| 10 | Medium | React context singleton |
| 11 | Low | Mechanical translation |
| 12 | **Highest** | Main run loop rewrite |

## Public API Stability

`src/index.ts` exports ~400 symbols. Throughout the migration:
- Component exports route through facades (Phase 10 changes backing implementation)
- Engine exports (`runWorkflow`, `renderFrame`) keep exact signatures
- Type exports re-exported from new packages
- Observability exports keep names (service is additive)
- **No export is removed or renamed during the migration**

## Critical Singleton Invariants

Two instances that MUST be shared singletons between old and new code:
1. `AsyncLocalStorage` + `correlationContextFiberRef` (Phase 5) — if duplicated, correlation context doesn't propagate
2. `SmithersContext` React context (Phase 10) — if duplicated, `useContext(SmithersContext)` returns undefined in child components
