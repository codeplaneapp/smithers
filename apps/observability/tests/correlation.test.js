import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  correlationContextToLogAnnotations,
  getCurrentCorrelationContext,
  runWithCorrelationContext,
  updateCurrentCorrelationContext,
  withCorrelationContext,
} from "@smithers-orchestrator/observability/correlation";
import { logInfo } from "@smithers-orchestrator/observability/logging";

/**
 * Regression guard: the imperative logger (`logging.js`) reads correlation via
 * `correlationContextToLogAnnotations(getCurrentCorrelationContext())`, and
 * `getCurrentCorrelationContext()` is backed by an AsyncLocalStorage store.
 * `withCorrelationContext` therefore has to populate that same store (not only
 * the Effect FiberRef) or imperative log calls made inside an Effect lose their
 * run/node correlation. This pins that bridge so it cannot silently regress.
 */
describe("correlation visibility to the imperative logger", () => {
  test("no correlation context leaks outside a withCorrelationContext scope", () => {
    expect(getCurrentCorrelationContext()).toBeUndefined();
  });

  test("withCorrelationContext is visible to the imperative logger chain", () => {
    // This mirrors exactly what buildLogProgram() runs when an imperative
    // logInfo/logDebug fires: read the current context, project it to log
    // annotations. If withCorrelationContext stops populating the AsyncLocalStorage
    // store, this returns undefined and the log line drops its correlation.
    const annotations = Effect.runSync(
      withCorrelationContext(
        Effect.sync(() => correlationContextToLogAnnotations(getCurrentCorrelationContext())),
        { runId: "run-1", nodeId: "node-1", iteration: 2, attempt: 3 },
      ),
    );
    expect(annotations).toMatchObject({
      runId: "run-1",
      nodeId: "node-1",
      iteration: 2,
      attempt: 3,
    });
  });

  test("runWithCorrelationContext + in-place update is visible to the imperative logger", () => {
    // The engine's real pattern: open a context with runWithCorrelationContext,
    // then refine it in place via updateCurrentCorrelationContext (the shim used
    // for attempt/iteration). Both have to reach the imperative-logger chain.
    const annotations = runWithCorrelationContext(
      { runId: "run-7", workflowName: "sync-flow" },
      () => {
        updateCurrentCorrelationContext({ nodeId: "node-7", attempt: 2 });
        return correlationContextToLogAnnotations(getCurrentCorrelationContext());
      },
    );
    expect(annotations).toMatchObject({
      runId: "run-7",
      workflowName: "sync-flow",
      nodeId: "node-7",
      attempt: 2,
    });
  });

  test("the store is restored after the scope completes (no leak across runs)", () => {
    Effect.runSync(withCorrelationContext(Effect.sync(() => undefined), { runId: "run-scoped" }));
    expect(getCurrentCorrelationContext()).toBeUndefined();
  });

  test("an imperative log call inside the scope does not throw", () => {
    expect(() =>
      Effect.runSync(
        withCorrelationContext(
          Effect.sync(() => logInfo("sync.correlated", { action: "materialize" }, "test")),
          { runId: "run-1", nodeId: "node-1" },
        ),
      ),
    ).not.toThrow();
  });
});
