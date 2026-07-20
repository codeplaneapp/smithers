import { describe, expect, test } from "bun:test";

import { evaluateReleaseNextGate } from "./release-next-gate.mjs";

function workflowRun(overrides) {
  return {
    event: "push",
    created_at: "2026-07-15T12:00:00Z",
    conclusion: "success",
    ...overrides,
  };
}

describe("release-next gate", () => {
  test("accepts a successful rerun after an earlier failure of the same workflow", () => {
    const result = evaluateReleaseNextGate([
      workflowRun({ id: 101, name: "CI", run_number: 42, run_attempt: 1, conclusion: "failure" }),
      workflowRun({
        id: 102,
        name: "CI",
        run_number: 42,
        run_attempt: 2,
        created_at: "2026-07-15T12:02:00Z",
      }),
      workflowRun({ id: 201, name: "Faults (per-PR)", run_number: 15 }),
    ]);

    expect(result.ready).toBe(true);
    expect(result.checks.find((check) => check.name === "CI")?.run?.id).toBe(102);
  });

  test("rejects the commit when the latest required workflow run failed", () => {
    const result = evaluateReleaseNextGate([
      workflowRun({ id: 101, name: "CI", run_number: 42 }),
      workflowRun({
        id: 102,
        name: "CI",
        run_number: 43,
        created_at: "2026-07-15T12:02:00Z",
        conclusion: "failure",
      }),
      workflowRun({ id: 201, name: "Faults (per-PR)", run_number: 15 }),
    ]);

    expect(result.ready).toBe(false);
    expect(result.checks.find((check) => check.name === "CI")).toMatchObject({
      ready: false,
      run: { id: 102, conclusion: "failure" },
    });
  });

  test("is not ready until every required workflow has a push run", () => {
    const result = evaluateReleaseNextGate([
      workflowRun({ id: 101, name: "CI", run_number: 42 }),
      workflowRun({ id: 201, name: "Faults (per-PR)", run_number: 15, event: "workflow_dispatch" }),
    ]);

    expect(result.ready).toBe(false);
    expect(result.checks.find((check) => check.name === "Faults (per-PR)")).toMatchObject({ run: null, ready: false });
  });
});
