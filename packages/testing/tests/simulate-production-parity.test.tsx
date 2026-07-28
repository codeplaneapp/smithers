/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import React from "react";
import { createSmithers, mdxPlugin, Sequence, Task } from "smithers-orchestrator";
import { z } from "zod/v4";
import { fakeAgent, simulate } from "smithers-orchestrator/testing";

mdxPlugin();
const { ValidationLoop, implementOutputSchema, validateOutputSchema } =
  await import("../../../.smithers/components/ValidationLoop");
const { reviewOutputSchema } = await import("../../../.smithers/components/Review");

describe("simulate production parity", () => {
  test("rerenders after a compute output mounts the next task", async () => {
    const { Workflow, smithers, outputs } = createSmithers({
      plan: z.object({ mountBuild: z.boolean(), terminal: z.string() }),
      build: z.object({ terminal: z.string() }),
    });
    const workflow = smithers((ctx) => {
      const plan = ctx.outputMaybe(outputs.plan, { nodeId: "plan" });
      return (
        <Workflow name="conditional-build">
          <Sequence>
            <Task id="plan" output={outputs.plan}>
              {() => ({ mountBuild: true, terminal: "planned" })}
            </Task>
            {plan?.mountBuild ? (
              <Task id="build" output={outputs.build} dependsOn={["plan"]}>
                {() => ({ terminal: "built" })}
              </Task>
            ) : null}
          </Sequence>
        </Workflow>
      );
    });
    const sim = simulate(workflow, { mocks: {} });

    await sim.run();

    expect(sim.executed).toEqual(["plan", "build"]);
    expect(sim.status).toBe("finished");
    expect(sim.output).toEqual({ terminal: "built" });
    expect(sim.task("plan").outputs).toEqual([{ mountBuild: true, terminal: "planned" }]);
    expect(sim.task("build").outputs).toEqual([{ terminal: "built" }]);
    expect(sim.task("plan").outputs).toHaveLength(1);
    expect(sim.task("build").outputs).toHaveLength(1);
    expect(sim.unusedMocks).toEqual([]);
  }, 30_000);

  test("finishes a real one-round ValidationLoop without duplicate records", async () => {
    const { Workflow, smithers, outputs } = createSmithers({
      input: z.object({ prompt: z.string() }),
      implement: implementOutputSchema,
      validate: validateOutputSchema,
      review: reviewOutputSchema,
    });
    const implementAgent = fakeAgent(implementOutputSchema, {
      output: { summary: "implemented", filesChanged: ["file.ts"], allTestsPassing: true },
    });
    const validateAgent = fakeAgent(validateOutputSchema, {
      output: { summary: "validated", allPassed: true, failingSummary: null },
    });
    const reviewAgent = fakeAgent(reviewOutputSchema, {
      output: { reviewer: "reviewer-1", approved: true, feedback: "approved", issues: [] },
    });
    const workflow = smithers((ctx) => {
      const validate = ctx.outputMaybe(outputs.validate, { nodeId: "impl:validate" });
      const review = ctx.latest(outputs.review, "impl:review:0") as { approved?: boolean } | undefined;
      return (
        <Workflow name="validation-loop">
          <ValidationLoop
            idPrefix="impl"
            prompt={ctx.input.prompt}
            implementAgents={[implementAgent]}
            validateAgents={[validateAgent]}
            reviewAgents={[reviewAgent]}
            done={validate?.allPassed === true && review?.approved === true}
            maxIterations={1}
          />
        </Workflow>
      );
    });
    const sim = simulate(workflow, {
      input: { prompt: "Implement the change." },
      mocks: {
        "impl:implement": { summary: "implemented", filesChanged: ["file.ts"], allTestsPassing: true },
        "impl:validate": { summary: "validated", allPassed: true, failingSummary: null },
        "impl:review:0": { reviewer: "reviewer-1", approved: true, feedback: "approved", issues: [] },
      },
    });

    await sim.run();

    expect(sim.executed).toEqual(["impl:implement", "impl:validate", "impl:review:0"]);
    expect(sim.status).toBe("finished");
    expect(sim.output).toEqual({
      reviewer: "reviewer-1",
      approved: true,
      blocked: false,
      feedback: "approved",
      issues: [],
    });
    for (const id of ["impl:implement", "impl:validate", "impl:review:0"]) {
      expect(sim.task(id).outputs).toHaveLength(1);
    }
    expect(sim.unusedMocks).toEqual([]);
  }, 30_000);
});
