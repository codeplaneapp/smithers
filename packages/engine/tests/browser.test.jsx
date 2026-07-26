import React from "react";
import { describe, expect, test } from "bun:test";
import { createBrowserRuntime, createBrowserSmithers, defineBrowserWorkflow, Task, Workflow } from "../src/browser.js";

describe("createBrowserSmithers", () => {
  test("uses a fresh driver and session for sequential runs", async () => {
    let executions = 0;
    const runtime = createBrowserRuntime({
      executeTask: async () => ({ execution: ++executions }),
    });
    const workflow = defineBrowserWorkflow(() =>
      React.createElement(
        Workflow,
        { name: "sequential-browser-runs" },
        React.createElement(Task, { id: "task", output: "browser_outputs" }, { value: "run" }),
      ),
    );
    const smithers = createBrowserSmithers({ workflow, runtime });

    const first = await smithers.run({ runId: "browser-run-one" });
    const second = await smithers.run({ runId: "browser-run-two" });
    const firstOutputs = await smithers.getOutputs(first.runId);
    const secondOutputs = await smithers.getOutputs(second.runId);

    expect(first).toMatchObject({ runId: "browser-run-one", status: "finished" });
    expect(second).toMatchObject({ runId: "browser-run-two", status: "finished" });
    expect(first.runId).not.toBe(second.runId);
    expect(executions).toBe(2);
    expect(firstOutputs).toEqual({
      browser_outputs: [expect.objectContaining({ execution: 1, nodeId: "task", iteration: 0 })],
    });
    expect(secondOutputs).toEqual({
      browser_outputs: [expect.objectContaining({ execution: 2, nodeId: "task", iteration: 0 })],
    });
    expect(secondOutputs).not.toEqual(firstOutputs);
  });
});
