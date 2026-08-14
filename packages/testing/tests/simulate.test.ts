/** @jsxImportSource smthrs */
import { describe, expect, test } from "bun:test";
import React from "react";
import { z } from "zod";
import { createSmithers } from "smthrs";
import { fakeAgent, simulate } from "../src/index.ts";

const schemas = {
  input: z.object({
    name: z.string(),
  }),
  greeting: z.object({
    message: z.string(),
  }),
  reply: z.object({
    text: z.string(),
  }),
};

function buildWorkflow() {
  const { Workflow, Task, smithers, outputs } = createSmithers(schemas);
  const realAgent = fakeAgent(schemas.greeting, {
    output: { message: "real agent should not run" },
  });

  return smithers((ctx) =>
    React.createElement(
      Workflow,
      { name: "simulate" },
      React.createElement(
        Task,
        { id: "greet", output: outputs.greeting, agent: realAgent, noRetry: true },
        `Greet ${ctx.input.name}`,
      ),
      React.createElement(Task, { id: "reply", output: outputs.reply, dependsOn: ["greet"] }, () => ({
        text: `done ${ctx.input.name}`,
      })),
    ),
  );
}

describe("simulate", () => {
  test("runs workflow control flow in memory with mocked agents", async () => {
    const sim = simulate(buildWorkflow(), {
      input: { name: "Ada" },
      mocks: {
        greet: { message: "hello Ada" },
      },
    });

    await sim.run();

    expect(sim.status).toBe("finished");
    expect(sim.executed).toEqual(["greet", "reply"]);
    expect(sim.outputs.greeting).toEqual([{ message: "hello Ada" }]);
    expect(sim.outputs.reply).toEqual([{ text: "done Ada" }]);
    expect(sim.output).toEqual({ text: "done Ada" });
    expect(sim.task("greet")).toEqual({
      status: "finished",
      outputs: [{ message: "hello Ada" }],
      prompts: ["Greet Ada"],
    });
    expect(sim.unusedMocks).toEqual([]);
  });

  test("throws loudly for an unmocked agent task", async () => {
    let caught: unknown;
    try {
      await simulate(buildWorkflow(), {
        input: { name: "Ada" },
      }).run();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain('simulate(): agent task "greet" has no mock');
    expect(message).toContain("Agent tasks in this run");
    expect(message).toContain("greet");
  });

  test("throws loudly when a mock violates the task output schema", async () => {
    let caught: unknown;
    try {
      await simulate(buildWorkflow(), {
        input: { name: "Ada" },
        mocks: {
          greet: { message: 123 },
        },
      }).run();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain('simulate(): task "greet" output failed validation');
    expect(message).toContain("expected string");
  });
});
