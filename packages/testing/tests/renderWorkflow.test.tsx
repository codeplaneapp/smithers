/** @jsxImportSource smthrs */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { createSmithers } from "smthrs";
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
          <>
            {`Hello `}
            <strong>Ada</strong>
          </>
        </Task>
      </Workflow>
    ));
    const frame = await renderWorkflow(workflow);

    expect(renderPrompt(frame.tasks[0].prompt)).toContain("Hello <strong>Ada</strong>");
    await expect(runTask(frame.tasks[0], { runId: "task-test" })).resolves.toEqual({ message: "hello Ada" });
    expect(greeter.calls[0].taskContext).toMatchObject({ runId: "task-test", nodeId: "greet", iteration: 0 });
  });

  test("resolves a string output key onto outputTable/outputSchema like the engine", async () => {
    const { Workflow, Task, smithers } = createSmithers(schemas);
    const greeter = fakeAgent(schemas.greeting, {
      output: { message: "hello Ada" },
    });
    const workflow = smithers(() => (
      <Workflow name="hello">
        <Task id="greet" output="greeting" agent={greeter}>
          Hello Ada
        </Task>
      </Workflow>
    ));
    const frame = await renderWorkflow(workflow);

    // The engine's resolveTaskOutputs pass runs, so a string output key is
    // resolved to a concrete table + schema instead of a bare string.
    expect(frame.tasks[0].outputTable).toBeDefined();
    expect(frame.tasks[0].outputSchema).toBeDefined();
    // Validation is now enforced by runTask against the resolved schema.
    await expect(runTask(frame.tasks[0], { runId: "task-test" })).resolves.toEqual({
      message: "hello Ada",
    });
  });

  test("throws UNKNOWN_OUTPUT_SCHEMA for an unregistered raw Zod object, matching the engine", async () => {
    const { Workflow, Task, smithers } = createSmithers(schemas);
    const rogue = z.object({ nope: z.string() });
    const greeter = fakeAgent(rogue, { output: { nope: "x" } });
    const workflow = smithers(() => (
      <Workflow name="hello">
        <Task id="greet" output={rogue} agent={greeter}>
          Hello Ada
        </Task>
      </Workflow>
    ));

    await expect(renderWorkflow(workflow)).rejects.toThrow(/not registered/);
  });

  test("validates a text-only agent result against the task output schema", async () => {
    const { Workflow, Task, smithers, outputs } = createSmithers(schemas);
    const textOnly = fakeAgent(schemas.greeting, { text: "no output" });
    const workflow = smithers(() => (
      <Workflow name="hello">
        <Task id="greet" output={outputs.greeting} agent={textOnly}>
          {`Hello`}
        </Task>
      </Workflow>
    ));
    const frame = await renderWorkflow(workflow);

    await expect(runTask(frame.tasks[0])).rejects.toThrow("failed validation");
  });
});
