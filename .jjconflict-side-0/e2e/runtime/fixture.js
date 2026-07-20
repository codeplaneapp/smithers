import React from "react";
import { z } from "zod";
import { createBrowserRuntime, createBrowserSmithers, defineBrowserWorkflow, Task, Workflow } from "smithers-orchestrator/browser";
import { assertAsyncCapabilityError, assertCapabilityError, runConformanceWorkflow } from "@smithers-orchestrator/testing/browser";

// A real Zod schema (recognized by `extractGraph`'s `outputSchema` wiring,
// unlike a duck-typed object) so enforcement is genuinely engine-owned:
// `WorkflowDriver`/`browser-runtime.js` call `.safeParse` themselves — no
// code in this fixture calls it directly.
const OUTPUT_SCHEMA = z.object({ answer: z.literal(42) });

/** @param {{ generate(args: { prompt?: unknown }): Promise<unknown> }} agent */
function buildWorkflow(agent) {
  return defineBrowserWorkflow(() => React.createElement(
    Workflow,
    { name: "runtime-conformance" },
    React.createElement(Task, { id: "agent", agent, outputSchema: OUTPUT_SCHEMA, output: "agent_output", noRetry: true }, "Return the answer."),
    // `Task`'s deps-callback children are read as a computed value by the
    // custom reconciler, not rendered as JSX -- `React.createElement`'s own
    // ambient typing still demands `ReactNode` for variadic children, so
    // the cast documents a real, sanctioned boundary rather than papering
    // over an actual ReactNode mismatch.
    React.createElement(Task, { id: "dependent", output: "dependent_output", deps: { agent: "agent_output" } }, /** @type {React.ReactNode} */ (/** @type {unknown} */ ((/** @param {{ agent: { answer: number } }} deps */ (deps) => ({ answer: deps.agent.answer + 1 }))))),
  ));
}

/** Walk an error's `.cause` chain looking for a real Zod validation failure (or a typed engine schema-rejection code), proving the *engine* parsed the output rather than the fixture asserting it happened. @param {unknown} error */
function isEngineSchemaRejection(error) {
  let current = /** @type {{ name?: string; code?: string; cause?: unknown } | undefined} */ (error);
  for (let depth = 0; current && depth < 5; depth += 1) {
    if (current.name === "ZodError" || current.code === "OUTPUT_SCHEMA_VALIDATION_FAILED" || current.code === "INVALID_OUTPUT") return true;
    current = /** @type {{ name?: string; code?: string; cause?: unknown } | undefined} */ (current.cause);
  }
  return false;
}

/** Wrap `runtime.storage.saveRun` to count how many times a terminal "finished" state is persisted for this runtime's runs. @param {ReturnType<typeof createBrowserRuntime>} runtime */
function countFinishedSaves(runtime) {
  let count = 0;
  const originalSaveRun = runtime.storage.saveRun.bind(runtime.storage);
  runtime.storage.saveRun = async (/** @type {string} */ runId, /** @type {import("@smithers-orchestrator/driver/RuntimeAdapter").StoredRunState} */ run) => {
    if (run.status === "finished") count += 1;
    return originalSaveRun(runId, run);
  };
  return () => count;
}

/** @param {{ globals?: Record<string, string> } & Record<string, unknown>} [host] */
export async function runSharedRuntimeFixture(host = {}) {
  let generateCalls = 0;
  const runtime = createBrowserRuntime();
  const getFinishedSaveCount = countFinishedSaves(runtime);
  const agent = { async generate(/** @type {{ prompt?: unknown }} */ { prompt }) { generateCalls += 1; return { answer: 42, prompt }; } };
  const smithers = createBrowserSmithers({ workflow: buildWorkflow(agent), runtime });
  const conformance = await runConformanceWorkflow(smithers);

  // Independent second run (fresh runtime + runId) proves generated run ids are unique, not just UUID-shaped.
  const secondSmithers = createBrowserSmithers({
    workflow: buildWorkflow({ async generate({ prompt }) { return { answer: 42, prompt }; } }),
    runtime: createBrowserRuntime(),
  });
  const secondResult = await secondSmithers.run();
  if (secondResult.status !== "finished") {
    throw new Error(`second conformance run did not finish (${secondResult.status}): ${JSON.stringify(secondResult.error ?? null)}`);
  }

  // Negative path: an agent that returns output failing outputSchema must be
  // rejected by the engine itself (WorkflowDriver -> browser-runtime.js),
  // not by the agent pre-validating its own return value.
  const invalidSmithers = createBrowserSmithers({
    workflow: buildWorkflow({ async generate() { return { answer: 41 }; } }),
    runtime: createBrowserRuntime(),
  });
  const invalidResult = await invalidSmithers.run();
  const schemaRejection = {
    rejected: invalidResult.status === "failed",
    engineOwned: invalidResult.status === "failed" && isEngineSchemaRejection(invalidResult.error),
  };

  /** @type {(details: Record<string, unknown> | undefined) => { runtime: string; capability: string; operation: string }} */
  const asCapabilityDetails = (details) => /** @type {{ runtime: string; capability: string; operation: string }} */ (details);
  const capabilityProof = {
    filesystem: asCapabilityDetails((await assertAsyncCapabilityError("filesystem", "readFile", () => runtime.filesystem.readFile("/tmp/x"))).details),
    subprocess: asCapabilityDetails((await assertAsyncCapabilityError("subprocess", "spawn", () => runtime.subprocess.spawn("echo", []))).details),
    sandbox: asCapabilityDetails((await assertAsyncCapabilityError("sandbox", "run", () => runtime.sandbox.run({}))).details),
    worktree: asCapabilityDetails(assertCapabilityError("worktree", "resolve", () => runtime.worktree.resolve("./lane")).details),
  };

  return {
    result: conformance.result,
    stored: /** @type {{ status?: string } | undefined} */ (conformance.stored),
    outputs: conformance.outputs,
    generateCalls,
    finishedSaveCount: getFinishedSaveCount(),
    runIds: [conformance.result.runId, secondResult.runId],
    schemaRejection,
    capabilityProof,
    globals: host.globals,
    host,
  };
}
