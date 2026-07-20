/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { Saga, SagaStep } from "smithers-orchestrator";

// Regression: `import { SagaStep }` previously threw "Export named 'SagaStep'
// not found" because it was only attached as Saga.Step, never re-exported.
describe("SagaStep named export", () => {
  test("SagaStep is importable as a named value", () => {
    expect(typeof SagaStep).toBe("function");
  });

  test("the named export is the same marker as Saga.Step", () => {
    expect(Saga.Step).toBe(SagaStep);
    expect(SagaStep.__isSagaStep).toBe(true);
  });
});
