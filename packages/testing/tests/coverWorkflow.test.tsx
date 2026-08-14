/** @jsxImportSource smthrs */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { createSmithers, HumanTask, Parallel, Signal, Timer } from "smthrs";
import { coverWorkflow, expectFullCoverage, fakeAgent, WorkflowCoverageError } from "../src/index.ts";
import { coverWorkflow as shippedCoverWorkflow } from "@smthrs/testing";

const valueSchema = z.object({ value: z.string() });

function agentWorkflow() {
  const schemas = {
    input: z.object({ name: z.string().optional() }),
    value: valueSchema,
    result: z.object({ done: z.boolean() }),
  };
  const { Workflow, Task, smithers, outputs } = createSmithers(schemas, { dbPath: ":memory:" });
  const unreachableAgent = fakeAgent(valueSchema, { value: "real agent must not run" });
  return smithers((ctx) => (
    <Workflow name="coverage-agent">
      <Task id="work" label="named work" output={outputs.value} agent={unreachableAgent}>
        {`Work for ${ctx.input.name ?? "default"}`}
      </Task>
      <Task id="finish" output={outputs.result} agent={unreachableAgent}>
        Finish
      </Task>
    </Workflow>
  ));
}

describe("coverWorkflow", () => {
  test("covers a workflow module with schema-aware agent outputs", async () => {
    const result = await coverWorkflow({ default: agentWorkflow() }, { input: { name: "Ada" } });

    expect(result.status).toBe("finished");
    expect(result.executed).toEqual(["work", "finish"]);
    expect(result.taskOutputs.work).toEqual([{ value: "string" }]);
    expect(result.finalOutputs).toEqual([{ done: false }]);
    expect(result.unexecuted).toEqual([]);
    expect(result.validations.every((item) => item.valid)).toBe(true);
  });

  test("accepts a scripted fakeAgent override by task label", async () => {
    const scripted = fakeAgent(valueSchema, { value: "scripted" });
    const result = await coverWorkflow(agentWorkflow(), {
      mocks: { "named work": scripted },
    });

    expect(result.taskOutputs.work).toEqual([{ value: "scripted" }]);
    expect(scripted.calls).toHaveLength(1);
  });

  test("auto-approves gates and drives the approved branch", async () => {
    const schemas = {
      approval: z.object({
        approved: z.boolean(),
        reviewer: z.string(),
        note: z.string(),
      }),
      result: valueSchema,
    };
    const { Workflow, Approval, Branch, Task, smithers, outputs } = createSmithers(schemas, {
      dbPath: ":memory:",
    });
    const workflow = smithers((ctx) => {
      const decision = ctx.outputMaybe("approval", { nodeId: "gate" });
      return (
        <Workflow name="approval">
          <Approval id="gate" output={outputs.approval} request={{ title: "Ship?" }} />
          <Branch
            if={decision?.approved === true}
            then={
              <Task id="approved-work" output={outputs.result} agent={fakeAgent(valueSchema, { value: "unused" })}>
                Approved
              </Task>
            }
          />
        </Workflow>
      );
    });

    const result = await coverWorkflow(workflow, { expectedNodes: ["gate", "approved-work"] });

    expect(result.approvals).toEqual([expect.objectContaining({ nodeId: "gate", approved: true })]);
    expect(result.executed).toEqual(["gate", "approved-work"]);
    expect(result.taskOutputs.gate[0]).toMatchObject({ approved: true });
  });

  test("supports an explicit denial without hiding the failed run", async () => {
    const schemas = {
      approval: z.object({ approved: z.boolean(), note: z.string().nullable() }),
    };
    const { Workflow, Approval, smithers, outputs } = createSmithers(schemas, { dbPath: ":memory:" });
    const workflow = smithers(() => (
      <Workflow name="denial">
        <Approval id="gate" output={outputs.approval} request={{ title: "Deny me" }} />
      </Workflow>
    ));

    const result = await coverWorkflow(workflow, {
      approvals: {
        gate: ({ nodeId }) => ({
          approved: nodeId !== "gate",
          note: "no",
        }),
      },
      assert: false,
    });

    expect(result.status).toBe("failed");
    expect(result.approvals[0]).toMatchObject({ nodeId: "gate", approved: false, note: "no" });
    expect(() => expectFullCoverage(result)).toThrow("unfinished passes");
  });

  test("auto-resolves human input and signal payloads", async () => {
    const schemas = {
      human: z.object({ answer: z.string() }),
      signal: z.object({ ok: z.boolean() }),
    };
    const { Workflow, smithers, outputs } = createSmithers(schemas, { dbPath: ":memory:" });
    const workflow = smithers(() => (
      <Workflow name="external-inputs">
        <HumanTask id="human" output={outputs.human} prompt="Answer" />
        <Signal id="signal" schema={outputs.signal} />
      </Workflow>
    ));

    const result = await coverWorkflow(workflow, {
      signals: {
        signal: ({ eventName }) => ({ ok: eventName === "signal" }),
      },
    });

    expect(result.executed).toEqual(["human", "signal"]);
    expect(result.taskOutputs.human).toEqual([{ answer: "string" }]);
    expect(result.taskOutputs.signal).toEqual([{ ok: true }]);
  });

  test("caps loops without running a real agent", async () => {
    const schemas = { value: valueSchema };
    const { Workflow, Loop, Task, smithers, outputs } = createSmithers(schemas, { dbPath: ":memory:" });
    const workflow = smithers(() => (
      <Workflow name="bounded">
        <Loop until={false} maxIterations={100}>
          <Task id="repeat" output={outputs.value} agent={fakeAgent(valueSchema, { value: "unused" })}>
            Again
          </Task>
        </Loop>
      </Workflow>
    ));

    const result = await coverWorkflow(workflow, { maxLoopIterations: 2 });

    expect(result.executed).toEqual(["repeat", "repeat"]);
    expect(result.taskOutputs.repeat).toHaveLength(2);
  });

  test("does not broaden a workflow loop below the coverage cap", async () => {
    const schemas = { value: valueSchema };
    const { Workflow, Loop, Task, smithers, outputs } = createSmithers(schemas, { dbPath: ":memory:" });
    const workflow = smithers(() => (
      <Workflow name="already-bounded">
        <Loop until={false} maxIterations={2}>
          <Task id="repeat" output={outputs.value} agent={fakeAgent(valueSchema, { value: "unused" })}>
            Again
          </Task>
        </Loop>
      </Workflow>
    ));

    const result = await coverWorkflow(workflow, { maxLoopIterations: 5 });

    expect(result.executed).toEqual(["repeat", "repeat"]);
    expect(result.passes[0].unusedMocks).toEqual([]);
  });

  test("reports unreached nodes clearly and honors an allowlist", async () => {
    await expect(coverWorkflow(agentWorkflow(), { expectedNodes: ["work", "missing-branch"] })).rejects.toThrow(
      'unreached expected nodes: ["missing-branch"]',
    );

    const allowed = await coverWorkflow(agentWorkflow(), {
      expectedNodes: ["work"],
      allowUnreached: ["missing-*"],
    });
    expect(allowed.unreached).toEqual(["missing-*"]);
  });

  test("surfaces schema validation failures with the task id", async () => {
    let caught: unknown;
    try {
      await coverWorkflow(agentWorkflow(), {
        mocks: { work: { value: 123 } },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(WorkflowCoverageError);
    expect((caught as Error).message).toContain("invalid structured outputs: work");
    expect((caught as Error).message).toContain('task "work" output failed validation');
  });

  test("validates auto-delivered event payloads", async () => {
    const schemas = { signal: z.object({ ok: z.boolean() }) };
    const { Workflow, smithers, outputs } = createSmithers(schemas, { dbPath: ":memory:" });
    const workflow = smithers(() => (
      <Workflow name="invalid-signal">
        <Signal id="signal" schema={outputs.signal} />
      </Workflow>
    ));

    await expect(coverWorkflow(workflow, { signals: { signal: { ok: "no" } } })).rejects.toThrow(
      "invalid structured outputs: signal",
    );
  });

  test("advances retry backoff without retaining a recovered error", async () => {
    let attempts = 0;
    const result = await coverWorkflow(agentWorkflow(), {
      mocks: {
        work: () => {
          attempts += 1;
          if (attempts === 1) throw new Error("retry once");
          return { value: "recovered" };
        },
      },
    });

    expect(attempts).toBe(2);
    expect(result.errors).toEqual([]);
    expect(result.taskOutputs.work).toEqual([{ value: "recovered" }]);
  });

  test("fires the earliest matching timer when unequal timers wait in parallel", async () => {
    const { Workflow, smithers } = createSmithers({}, { dbPath: ":memory:" });
    const workflow = smithers(() => (
      <Workflow name="parallel-timer-coverage">
        <Parallel>
          <Timer id="short" duration="1s" />
          <Timer id="long" duration="1h" />
        </Parallel>
      </Workflow>
    ));

    const result = await coverWorkflow(workflow);

    expect(result.executed).toEqual(["short", "long"]);
  });

  test("the shipped JavaScript keeps the parallel timer ordering fix", async () => {
    const build = () => {
      const { Workflow, smithers } = createSmithers({}, { dbPath: ":memory:" });
      return smithers(() => (
        <Workflow name="published-parallel-timer-coverage">
          <Parallel>
            <Timer id="short" duration="1s" />
            <Timer id="long" duration="1h" />
          </Parallel>
        </Workflow>
      ));
    };

    expect((await shippedCoverWorkflow(build())).executed).toEqual(["short", "long"]);
  });

  test("aggregates coverage over multiple inputs", async () => {
    const schemas = {
      input: z.object({ side: z.enum(["left", "right"]) }),
      value: valueSchema,
    };
    const { Workflow, Task, smithers, outputs } = createSmithers(schemas, { dbPath: ":memory:" });
    const workflow = smithers((ctx) => (
      <Workflow name="passes">
        <Task id={ctx.input.side} output={outputs.value} agent={fakeAgent(valueSchema, { value: "unused" })}>
          Side
        </Task>
      </Workflow>
    ));

    const result = await coverWorkflow(workflow, {
      inputs: [{ side: "left" }, { side: "right" }],
      expectedNodes: ["left", "right"],
    });

    expect(result.passes).toHaveLength(2);
    expect(result.coveredNodes).toEqual(["left", "right"]);
    expect(result.executed).toEqual(["left", "right"]);
  });

  test("mocks declared side effects by default", async () => {
    let calls = 0;
    const schemas = { value: valueSchema };
    const { Workflow, Task, smithers, outputs } = createSmithers(schemas, { dbPath: ":memory:" });
    const workflow = smithers(() => (
      <Workflow name="side-effects">
        <Task id="write" output={outputs.value} sideEffect={{ idempotent: false }}>
          {() => {
            calls += 1;
            return { value: "wrote" };
          }}
        </Task>
      </Workflow>
    ));

    const result = await coverWorkflow(workflow);

    expect(calls).toBe(0);
    expect(result.taskOutputs.write).toEqual([{ value: "string" }]);

    const executed = await coverWorkflow(workflow, {
      executeCompute: true,
      executeSideEffects: true,
    });
    expect(calls).toBe(1);
    expect(executed.taskOutputs.write).toEqual([{ value: "wrote" }]);
  });

  test("validates option errors", async () => {
    await expect(coverWorkflow(agentWorkflow(), { input: {}, inputs: [{}] })).rejects.toThrow("either input or inputs");
    await expect(coverWorkflow(agentWorkflow(), { inputs: [] })).rejects.toThrow("at least one");
    await expect(coverWorkflow(agentWorkflow(), { maxLoopIterations: 0 })).rejects.toThrow("positive integer");
  });
});
