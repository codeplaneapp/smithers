/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import React from "react";
import { z } from "zod";
import { createSmithers } from "smithers-orchestrator";
import { fakeAgent, simulate } from "../src/index.ts";

const gradeSchema = z.object({
  output: z.string(),
  score: z.number(),
});

function buildWorkflow() {
  const { Workflow, Task, smithers, outputs } = createSmithers({ grade: gradeSchema });
  const realAgent = fakeAgent(gradeSchema, {
    output: { output: "unused", score: 0 },
  });

  return smithers(() =>
    React.createElement(
      Workflow,
      { name: "simulate-function-mock" },
      React.createElement(
        Task,
        { id: "grade", output: outputs.grade, agent: realAgent, noRetry: true },
        "Grade the answer",
      ),
    ),
  );
}

describe("simulate function mocks", () => {
  test("preserves a bare output whose schema has an output field", async () => {
    const sim = simulate(buildWorkflow(), {
      mocks: {
        grade: () => ({ output: "A", score: 95 }),
      },
    });

    await sim.run();

    expect(sim.outputs.grade).toEqual([{ output: "A", score: 95 }]);
    expect(sim.output).toEqual({ output: "A", score: 95 });
  });

  test("unwraps a function mock response when its nested output matches the schema", async () => {
    const sim = simulate(buildWorkflow(), {
      mocks: {
        grade: () => ({ output: { output: "A", score: 95 } }),
      },
    });

    await sim.run();

    expect(sim.outputs.grade).toEqual([{ output: "A", score: 95 }]);
  });

  test("still validates a function mock when its nested output is invalid", async () => {
    let caught: unknown;
    try {
      await simulate(buildWorkflow(), {
        mocks: {
          grade: () => ({ output: { output: "A", score: "not a number" } }),
        },
      }).run();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('simulate(): task "grade" output failed validation');
  });
});
