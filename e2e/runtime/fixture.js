import React from "react";
import { createBrowserRuntime, createBrowserSmithers, defineBrowserWorkflow, Task, Workflow } from "smithers-orchestrator/browser";
import { assertAsyncCapabilityError, assertCapabilityError, runConformanceWorkflow } from "@smithers-orchestrator/testing/browser";

export async function runSharedRuntimeFixture(host = {}) {
  let generateCalls = 0;
  const schema = { parse(value) { if (!value || value.answer !== 42) throw new Error("invalid agent output"); return { answer: value.answer }; } };
  const agent = { async generate({ prompt }) { generateCalls += 1; return schema.parse({ answer: 42, prompt }); } };
  const runtime = createBrowserRuntime();
  const workflow = defineBrowserWorkflow(() => React.createElement(
    Workflow,
    { name: "runtime-conformance" },
    React.createElement(Task, { id: "agent", agent, outputSchema: schema, output: "agent_output" }, "Return the answer."),
    React.createElement(Task, { id: "dependent", output: "dependent_output", deps: { agent: "agent_output" } }, (deps) => ({ answer: deps.agent.answer + 1 })),
  ));
  const smithers = createBrowserSmithers({ workflow, runtime });
  const conformance = await runConformanceWorkflow(smithers);
  const capabilityProof = {
    filesystem: (await assertAsyncCapabilityError("filesystem", "readFile", () => runtime.filesystem.readFile("/tmp/x"))).details,
    subprocess: (await assertAsyncCapabilityError("subprocess", "spawn", () => runtime.subprocess.spawn("echo", []))).details,
    sandbox: (await assertAsyncCapabilityError("sandbox", "run", () => runtime.sandbox.run({}))).details,
    worktree: assertCapabilityError("worktree", "resolve", () => runtime.worktree.resolve("./lane")).details,
  };
  return {
    result: conformance.result,
    stored: conformance.stored,
    outputs: conformance.outputs,
    generateCalls,
    schemaEnforced: true,
    capabilityProof,
    globals: host.globals,
    host,
  };
}
