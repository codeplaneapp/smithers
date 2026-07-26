/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import React from "react";
import { z } from "zod";
import { createSmithers } from "smithers-orchestrator";
import { fakeAgent, simulate } from "../src/index.ts";
import { simMatchers, toHaveExecuted, toHaveExecutedInOrder, toHaveFinished } from "../src/matchers.ts";

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
      { name: "matcher-simulate" },
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

describe("sim matchers", () => {
  test("pure matcher functions inspect simulation-like values", () => {
    expect(toHaveExecutedInOrder({ executed: ["a", "b", "c"] }, ["a", "c"]).pass).toBe(true);
    expect(toHaveExecutedInOrder({ executed: ["a", "b", "c"] }, ["c", "a"]).pass).toBe(false);
    expect(toHaveExecuted({ executed: ["a", "b"] }, ["a", "missing"]).pass).toBe(false);
    expect(toHaveExecuted({ status: "finished" }, ["a"]).pass).toBe(false);
    expect(toHaveFinished({ status: "finished" }).pass).toBe(true);
    expect(toHaveFinished({ status: "failed" }).pass).toBe(false);
  });

  test("integrates with bun expect.extend against a real simulation", async () => {
    expect.extend(simMatchers);

    const sim = simulate(buildWorkflow(), {
      input: { name: "Ada" },
      mocks: {
        greet: { message: "hello Ada" },
      },
    });

    await sim.run();

    expect(sim).toHaveExecutedInOrder(["greet", "reply"]);
    expect(sim).toHaveFinished();
    expect(sim).not.toHaveExecuted(["does-not-exist"]);
  });
});
