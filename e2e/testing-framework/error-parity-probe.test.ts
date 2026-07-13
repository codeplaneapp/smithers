import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { spawnCaptureEffect } from "@smithers-orchestrator/driver/child-process";
import { boundaryShape, compareBoundaryShape, contractProbe } from "@smithers-orchestrator/testing";

describe("testing framework production error parity", () => {
  test("probes the production child-process adapter at its native boundary", async () => {
    class FiberFailureImpl extends Error {}
    const message = 'spawn smithers-testing-binary-that-does-not-exist: Executable not found in $PATH: "smithers-testing-binary-that-does-not-exist" See https://smithers.sh/reference/errors';
    const simulated = () => {
      const error = new FiberFailureImpl(message);
      error.name = "(FiberFailure) SmithersError";
      Object.assign(error, { _id: "FiberFailure" });
      throw error;
    };
    const report = await contractProbe(
      "driver.spawnCaptureEffect.missing-binary",
      () => Effect.runPromise(spawnCaptureEffect("smithers-testing-binary-that-does-not-exist", [], { cwd: process.cwd() })),
      simulated,
      { serializeProduction: (value) => JSON.parse(JSON.stringify(value)), serializeSimulation: () => ({ _id: "FiberFailure", cause: { _id: "Cause", _tag: "Fail", failure: { cause: { code: "ENOENT", path: "smithers-testing-binary-that-does-not-exist", errno: -2, syscall: "spawn smithers-testing-binary-that-does-not-exist", spawnargs: [] }, code: "PROCESS_SPAWN_FAILED", summary: message.replace(" See https://smithers.sh/reference/errors", ""), docsUrl: "https://smithers.sh/reference/errors", details: { command: "smithers-testing-binary-that-does-not-exist", args: [], cwd: process.cwd(), operation: "spawn smithers-testing-binary-that-does-not-exist" }, name: "SmithersError" } } }) },
    );
    expect(report.passed).toBe(true);
    expect(report.expected.className).toBe("FiberFailureImpl");
    expect(report.expected.code).toBeUndefined();
    expect((report.expected.serialized as { cause?: unknown }).cause).toBeDefined();
    expect(compareBoundaryShape(report.expected, report.actual)).toEqual([]);
  });
});
