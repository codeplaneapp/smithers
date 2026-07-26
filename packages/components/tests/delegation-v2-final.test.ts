import { describe, expect, test } from "bun:test";
import { dv2FinalSchema } from "../src/components/delegation-v2/delegationV2Schemas.ts";

function failedOutcome(code: "crash" | "budget_exhausted") {
  return {
    invocationKey: "trellis:root:0123456789abcdef01234567",
    logicalId: "root",
    generation: 0,
    role: "sol" as const,
    work: "synthesize" as const,
    outputContract: "work_product" as const,
    assignmentDigest: "0".repeat(64),
    acceptanceCriterionIds: ["root-goal"],
    status: "runtime_failed" as const,
    sourceNodeId: "trellis:author:0123456789abcdef01234567",
    runtimeFailure: { code, message: code === "budget_exhausted" ? "Fuel ended." : "Agent crashed." },
  };
}

describe("Trellis final status", () => {
  test("uses fuel_exhausted if and only if the nested runtime failure exhausted budget", () => {
    const budget = failedOutcome("budget_exhausted");
    const crash = failedOutcome("crash");
    expect(
      dv2FinalSchema.safeParse({ status: "fuel_exhausted", summary: "Fuel ended.", outcome: budget }).success,
    ).toBe(true);
    expect(
      dv2FinalSchema.safeParse({ status: "runtime_failed", summary: "Fuel ended.", outcome: budget }).success,
    ).toBe(false);
    expect(
      dv2FinalSchema.safeParse({ status: "fuel_exhausted", summary: "Agent crashed.", outcome: crash }).success,
    ).toBe(false);
    expect(
      dv2FinalSchema.safeParse({ status: "runtime_failed", summary: "Agent crashed.", outcome: crash }).success,
    ).toBe(true);
  });
});
