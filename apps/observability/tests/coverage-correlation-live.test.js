import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  CorrelationContextService,
  CorrelationContextLive,
  updateCurrentCorrelationContext,
  withCorrelationContext,
} from "../src/_coreCorrelation/index.js";

describe("CorrelationContextLive service", () => {
  test("current(), withCorrelation() and toLogAnnotations() are wired to the core helpers", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* CorrelationContextService;
        const withinScope = yield* svc.withCorrelation({ runId: "run-live", nodeId: "node-live" }, svc.current());
        const annotations = svc.toLogAnnotations(withinScope);
        return { withinScope, annotations };
      }).pipe(Effect.provide(CorrelationContextLive)),
    );
    expect(result.withinScope).toMatchObject({ runId: "run-live", nodeId: "node-live" });
    expect(result.annotations).toMatchObject({ runId: "run-live", nodeId: "node-live" });
  });

  test("current() outside any scope resolves to undefined", async () => {
    const outside = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* CorrelationContextService;
        return yield* svc.current();
      }).pipe(Effect.provide(CorrelationContextLive)),
    );
    expect(outside).toBeUndefined();
  });
});

describe("_coreCorrelation updateCurrentCorrelationContext (Effect-based)", () => {
  test("merges the patch onto the current fiber context and returns the result", async () => {
    const next = await Effect.runPromise(
      withCorrelationContext(updateCurrentCorrelationContext({ nodeId: "node-2", attempt: 5 }), {
        runId: "run-1",
        nodeId: "node-1",
      }),
    );
    expect(next).toMatchObject({ runId: "run-1", nodeId: "node-2", attempt: 5 });
  });
});
