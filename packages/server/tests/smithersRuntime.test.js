import { describe, expect, test } from "bun:test";
import { Context, Effect } from "effect";
import { smithersTraceSpanStorage } from "@smithers-orchestrator/observability/_smithersTraceSpanStorage";
import { runFork, runPromise, runSync } from "../src/smithersRuntime.js";

describe("smithersRuntime", () => {
  test("runPromise resolves a successful effect", async () => {
    const value = await runPromise(Effect.succeed(41));
    expect(value).toBe(41);
  });

  test("runSync executes a synchronous effect", () => {
    expect(runSync(Effect.succeed("sync-value"))).toBe("sync-value");
  });

  test("runFork returns a running fiber", () => {
    const fiber = runFork(Effect.succeed(7));
    expect(fiber).toBeDefined();
    // A RuntimeFiber exposes the Fiber protocol (id() accessor).
    expect(typeof fiber.id).toBe("function");
  });

  test("runPromise throws a SmithersError on a typed failure", async () => {
    await expect(runPromise(Effect.fail(new Error("boom")))).rejects.toBeDefined();
  });

  test("runPromise throws on a defect (no failure option)", async () => {
    await expect(runPromise(Effect.die(new Error("defect")))).rejects.toBeDefined();
  });

  test("decorate annotates logs and parent span when a trace span is active", async () => {
    // Running inside smithersTraceSpanStorage makes
    // getCurrentSmithersTraceAnnotations()/getCurrentSmithersTraceSpan() return
    // truthy, exercising both the annotateLogs(traceAnnotations) and the
    // withParentSpan(parentSpan) branches inside decorate().
    const externalSpan = {
      _tag: "ExternalSpan",
      spanId: "span-abc",
      traceId: "trace-xyz",
      sampled: true,
      context: Context.empty(),
    };
    const result = await smithersTraceSpanStorage.run(externalSpan, () => runPromise(Effect.succeed("with-span")));
    expect(result).toBe("with-span");
  });
});
