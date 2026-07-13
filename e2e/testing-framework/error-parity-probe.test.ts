import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { spawnCaptureEffect } from "@smithers-orchestrator/driver/child-process";
import { boundaryShape, compareBoundaryShape, contractProbe } from "@smithers-orchestrator/testing";

describe("testing framework production error parity", () => {
  test("probes the production child-process adapter at its native boundary", async () => {
    class FiberFailureImpl extends Error {}
    const message = 'spawn smithers-testing-binary-that-does-not-exist: Executable not found in $PATH: "smithers-testing-binary-that-does-not-exist" See https://smithers.sh/reference/errors';
    const report = await contractProbe(
      "driver.spawnCaptureEffect.missing-binary",
      () => Effect.runPromise(spawnCaptureEffect("smithers-testing-binary-that-does-not-exist", [], { cwd: process.cwd() })),
      () => { const error = new FiberFailureImpl(message); error.name = "(FiberFailure) SmithersError"; throw error; },
      { serializeProduction: (value) => boundaryShape(value), serializeSimulation: (value) => boundaryShape(value) },
    );
    expect(report.passed).toBe(true);
    expect(report.expected.className).toBe("FiberFailureImpl");
    expect(compareBoundaryShape(report.expected, report.expected)).toEqual([]);
  });
});
