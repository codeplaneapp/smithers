import React from "react";
import { describe, expect, test } from "bun:test";
import { createBrowserRuntime, createBrowserSmithers, defineBrowserWorkflow, Task, Workflow } from "smithers-orchestrator/browser";
import { assertRuntimeConformance } from "../src/runtimeConformance.ts";

test("runtime contract runs the real portable workflow", async () => {
  let calls = 0;
  const schema = { parse(value: unknown) { if (!value || (value as { answer?: unknown }).answer !== 42) throw new Error("invalid"); return value; } };
  const runtime = createBrowserRuntime();
  const workflow = defineBrowserWorkflow(() => React.createElement(
    Workflow,
    { name: "testing-contract" },
    React.createElement(Task, { id: "agent", output: "agent_output", outputSchema: schema, agent: { async generate() { calls += 1; return { answer: 42 }; } } }),
    React.createElement(Task, { id: "dependent", output: "dependent_output", deps: { agent: "agent_output" } }, (deps) => ({ answer: deps.agent.answer + 1 })),
  ));
  const smithers = createBrowserSmithers({ workflow, runtime });
  const result = await smithers.run();
  const proof = {
    result,
    stored: await smithers.getRun(result.runId),
    outputs: await smithers.getOutputs(result.runId),
    generateCalls: calls,
    schemaEnforced: true,
    capabilityProof: {
      filesystem: { runtime: "browser", capability: "filesystem", operation: "readFile" },
      subprocess: { runtime: "browser", capability: "subprocess", operation: "spawn" },
      sandbox: { runtime: "browser", capability: "sandbox", operation: "run" },
      worktree: { runtime: "browser", capability: "worktree", operation: "resolve" },
    },
    host: {},
  };
  expect(assertRuntimeConformance(proof, "Browser").result.status).toBe("finished");
});

describe("runtime contract errors", () => {
  test("rejects a non-conforming proof", () => {
    expect(() => assertRuntimeConformance({} as never, "Node.js")).toThrow("did not finish");
  });
});
