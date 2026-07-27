import { expect, mock, test } from "bun:test";
import { coverExample } from "./_setup.ts";

const Prompt = () => "test prompt";
mock.module("../prompts/branch-doctor/diagnose.mdx", () => ({ default: Prompt }));
mock.module("../prompts/branch-doctor/plan.mdx", () => ({ default: Prompt }));
mock.module("../prompts/branch-doctor/execute.mdx", () => ({ default: Prompt }));

test("covers branch-doctor", async () => {
  const result = await coverExample("../branch-doctor.jsx", {
    inputs: [{ repoPath: ".", autoExecute: false }, { repoPath: ".", autoExecute: true }],
    executeCompute: true,
    mocks: {
      diagnose: {
        rootCause: "bad-rebase", details: "conflicts", severity: "high", affectedPaths: ["a.ts"],
      },
      plan: {
        commands: [{ command: "git rebase --continue", purpose: "finish", safe: true }],
        estimatedRisk: "low",
        manualStepsRequired: [],
      },
      execute: {
        executedCommands: [{ command: "git rebase --continue", exitCode: 0, output: "ok" }],
        skippedUnsafe: [],
        success: true,
      },
    },
    expectedNodes: ["inspect", "diagnose", "plan", "execute", "summary"],
  });

  expect(result.executed).toEqual([
    "inspect", "diagnose", "plan", "summary",
    "inspect", "diagnose", "plan", "execute", "summary",
  ]);
  expect(result.taskOutputs.summary).toEqual([
    expect.objectContaining({ rootCause: "bad-rebase", executed: false }),
    expect.objectContaining({ rootCause: "bad-rebase", executed: true }),
  ]);
});
