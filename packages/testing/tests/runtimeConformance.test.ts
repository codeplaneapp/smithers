import React from "react";
import { z } from "zod";
import { describe, expect, test } from "bun:test";
import {
  createBrowserRuntime,
  createBrowserSmithers,
  defineBrowserWorkflow,
  Task,
  Workflow,
} from "smithers-orchestrator/browser";
import { assertRuntimeConformance } from "../src/runtimeConformance.ts";

// A real Zod schema so `extractGraph` actually wires it in as `outputSchema`
// (it duck-types on `"shape" in value`) and enforcement is engine-owned:
// `WorkflowDriver`/`browser-runtime.js` call `.safeParse`, not this test.
const OUTPUT_SCHEMA = z.object({ answer: z.literal(42) });

function buildWorkflow(agent: unknown) {
  return defineBrowserWorkflow(() =>
    React.createElement(
      Workflow,
      { name: "testing-contract" },
      React.createElement(Task, {
        id: "agent",
        output: "agent_output",
        outputSchema: OUTPUT_SCHEMA,
        agent,
        noRetry: true,
      }),
      React.createElement(
        Task,
        { id: "dependent", output: "dependent_output", deps: { agent: "agent_output" } },
        (deps: { agent: { answer: number } }) => ({ answer: deps.agent.answer + 1 }),
      ),
    ),
  );
}

// Walk `.cause` looking for a real Zod validation failure (or a typed engine
// schema-rejection code), proving the *engine* parsed the output rather than
// this test asserting it happened.
function isEngineSchemaRejection(error: unknown): boolean {
  let current = error as { name?: string; code?: string; cause?: unknown } | undefined;
  for (let depth = 0; current && depth < 5; depth += 1) {
    if (
      current.name === "ZodError" ||
      current.code === "OUTPUT_SCHEMA_VALIDATION_FAILED" ||
      current.code === "INVALID_OUTPUT"
    )
      return true;
    current = current.cause as typeof current;
  }
  return false;
}

function countFinishedSaves(runtime: ReturnType<typeof createBrowserRuntime>) {
  let count = 0;
  const originalSaveRun = runtime.storage.saveRun.bind(runtime.storage);
  runtime.storage.saveRun = async (runId: string, run: { status?: string }) => {
    if (run.status === "finished") count += 1;
    return originalSaveRun(runId, run);
  };
  return () => count;
}

test("runtime contract runs the real portable workflow", async () => {
  let calls = 0;
  const runtime = createBrowserRuntime();
  const getFinishedSaveCount = countFinishedSaves(runtime);
  const smithers = createBrowserSmithers({
    workflow: buildWorkflow({
      async generate() {
        calls += 1;
        return { answer: 42 };
      },
    }),
    runtime,
  });
  const result = await smithers.run();

  const secondResult = await createBrowserSmithers({
    workflow: buildWorkflow({
      async generate() {
        return { answer: 42 };
      },
    }),
    runtime: createBrowserRuntime(),
  }).run();

  const invalidResult = await createBrowserSmithers({
    workflow: buildWorkflow({
      async generate() {
        return { answer: 41 };
      },
    }),
    runtime: createBrowserRuntime(),
  }).run();

  const proof = {
    result,
    stored: await smithers.getRun(result.runId),
    outputs: await smithers.getOutputs(result.runId),
    generateCalls: calls,
    finishedSaveCount: getFinishedSaveCount(),
    runIds: [result.runId, secondResult.runId],
    schemaRejection: {
      rejected: invalidResult.status === "failed",
      engineOwned:
        invalidResult.status === "failed" && isEngineSchemaRejection((invalidResult as { error?: unknown }).error),
    },
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

  test("rejects a proof where the engine did not reject invalid schema output", () => {
    const base = {
      result: { runId: "run_11111111-1111-1111-1111-111111111111", status: "finished", output: { answer: 43 } },
      stored: { status: "finished" },
      outputs: { agent_output: [{ answer: 42 }], dependent_output: [{ answer: 43 }] },
      generateCalls: 1,
      finishedSaveCount: 1,
      runIds: ["run_11111111-1111-1111-1111-111111111111", "run_22222222-2222-2222-2222-222222222222"],
      schemaRejection: { rejected: false, engineOwned: false },
      capabilityProof: {
        filesystem: { runtime: "browser", capability: "filesystem", operation: "readFile" },
        subprocess: { runtime: "browser", capability: "subprocess", operation: "spawn" },
        sandbox: { runtime: "browser", capability: "sandbox", operation: "run" },
        worktree: { runtime: "browser", capability: "worktree", operation: "resolve" },
      },
      host: {},
    };
    expect(() => assertRuntimeConformance(base, "Browser")).toThrow("did not reject agent output");
  });

  test("rejects a proof with duplicate run ids", () => {
    const base = {
      result: { runId: "run_11111111-1111-1111-1111-111111111111", status: "finished", output: { answer: 43 } },
      stored: { status: "finished" },
      outputs: { agent_output: [{ answer: 42 }], dependent_output: [{ answer: 43 }] },
      generateCalls: 1,
      finishedSaveCount: 1,
      runIds: ["run_11111111-1111-1111-1111-111111111111", "run_11111111-1111-1111-1111-111111111111"],
      schemaRejection: { rejected: true, engineOwned: true },
      capabilityProof: {
        filesystem: { runtime: "browser", capability: "filesystem", operation: "readFile" },
        subprocess: { runtime: "browser", capability: "subprocess", operation: "spawn" },
        sandbox: { runtime: "browser", capability: "sandbox", operation: "run" },
        worktree: { runtime: "browser", capability: "worktree", operation: "resolve" },
      },
      host: {},
    };
    expect(() => assertRuntimeConformance(base, "Browser")).toThrow("not unique");
  });
});
