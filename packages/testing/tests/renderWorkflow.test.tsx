/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { createSmithers } from "smithers-orchestrator";
import { fakeAgent, renderPrompt, renderWorkflow, runTask } from "../src/index.ts";

const schemas = {
  input: z.object({
    name: z.string(),
  }),
  greeting: z.object({
    message: z.string(),
  }),
};

describe("renderWorkflow", () => {
  test("renders a workflow frame without running the engine", async () => {
    const { Workflow, Task, smithers, outputs } = createSmithers(schemas);
    const greeter = fakeAgent(schemas.greeting, {
      output: { message: "hello Ada" },
    });
    const workflow = smithers((ctx) => (
      <Workflow name="hello">
        <Task id="greet" output={outputs.greeting} agent={greeter}>
          {`Hello ${ctx.input.name}`}
        </Task>
      </Workflow>
    ));

    const frame = await renderWorkflow(workflow, {
      input: { name: "Ada" },
      runId: "render-test",
      workflowPath: "/workflows/hello.tsx",
    });

    expect(frame.runId).toBe("render-test");
    expect(frame.tasks).toHaveLength(1);
    expect(frame.tasks[0].nodeId).toBe("greet");
    expect(frame.tasks[0].prompt).toBe("Hello Ada");
    expect(frame.mountedTaskIds).toContain("greet::0");
    expect(frame.toXml()).toContain('"tag":"smithers:workflow"');
  });

  test("renders prompts and runs descriptor tasks", async () => {
    const { Workflow, Task, smithers, outputs } = createSmithers(schemas);
    const greeter = fakeAgent(schemas.greeting, {
      output: { message: "hello Ada" },
    });
    const workflow = smithers(() => (
      <Workflow name="hello">
        <Task id="greet" output={outputs.greeting} agent={greeter}>
          <>{`Hello `}<strong>Ada</strong></>
        </Task>
      </Workflow>
    ));
    const frame = await renderWorkflow(workflow);

    expect(renderPrompt(frame.tasks[0].prompt)).toContain("Hello <strong>Ada</strong>");
    await expect(runTask(frame.tasks[0], { runId: "task-test" })).resolves.toEqual({ message: "hello Ada" });
    expect(greeter.calls[0].taskContext).toMatchObject({ runId: "task-test", nodeId: "greet", iteration: 0 });
  });
});
