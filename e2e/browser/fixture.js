import React from "react";
import {
  createBrowserRuntime,
  createBrowserSmithers,
  defineBrowserWorkflow,
  Task,
  Workflow,
} from "smithers-orchestrator/browser";
import {
  assertCapabilityError,
  assertAsyncCapabilityError,
  runConformanceWorkflow,
} from "@smithers-orchestrator/testing/browser";

let generateCalls = 0;
const agent = {
  async generate({ prompt }) {
    generateCalls += 1;
    return { answer: 42, prompt };
  },
};
const schema = {
  parse(value) {
    if (!value || value.answer !== 42) throw new Error("invalid agent output");
    return { answer: value.answer };
  },
};

const runtime = createBrowserRuntime();

// Every OS-only capability fails closed with a typed RuntimeCapabilityError —
// proven directly against the real runtime adapter, not a rendered <Worktree>.
const capabilityProof = {
  filesystem: (await assertAsyncCapabilityError("filesystem", "readFile", () => runtime.filesystem.readFile("/tmp/x"))).details,
  subprocess: (await assertAsyncCapabilityError("subprocess", "spawn", () => runtime.subprocess.spawn("ls", []))).details,
  sandbox: (await assertAsyncCapabilityError("sandbox", "run", () => runtime.sandbox.run({}))).details,
  worktree: assertCapabilityError("worktree", "resolve", () => runtime.worktree.resolve("./lane")).details,
};

// A real two-task dependency workflow through the production Task/Workflow
// primitives: an agent task (AgentLike.generate + outputSchema validation)
// feeding a dependent compute task via real SmithersCtx output propagation
// (deps/needs), not a module-global variable.
const workflow = defineBrowserWorkflow(() =>
  React.createElement(
    Workflow,
    { name: "browser-conformance" },
    React.createElement(Task, { id: "agent", agent, outputSchema: schema, output: "agent_output" }, "Return the answer."),
    React.createElement(
      Task,
      { id: "dependent", output: "dependent_output", deps: { agent: "agent_output" } },
      (deps) => ({ answer: deps.agent.answer + 1 }),
    ),
  ),
);

// No explicit runId: Web Crypto UUID generation actually runs.
const smithers = createBrowserSmithers({ workflow, runtime });
const conformance = await runConformanceWorkflow(smithers);

globalThis.__smithersBrowserResult = {
  result: conformance.result,
  stored: conformance.stored,
  outputs: conformance.outputs,
  generateCalls,
  capabilityProof,
  runIdLooksLikeUuid: /^run_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(conformance.result.runId),
  globals: {
    process: typeof globalThis.process,
    Bun: typeof globalThis.Bun,
    Buffer: typeof globalThis.Buffer,
  },
};
