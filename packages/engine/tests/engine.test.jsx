/** @jsxImportSource smthrs */
import { describe, expect, test } from "bun:test";
import { Parallel, Ralph, Sequence, Task, Workflow, runWorkflow } from "smthrs";
import { approveNode } from "../src/approvals.js";
import { SmithersDb } from "@smthrs/db/adapter";
import { createTestSmithers, sleep } from "../../smithers/tests/helpers.js";
import { outputSchemas } from "../../smithers/tests/schema.js";
import { Effect } from "effect";
function buildSmithers() {
  return createTestSmithers(outputSchemas);
}
describe("Ralph iteration", () => {
  test("iterates until condition met", async () => {
    const { smithers, outputs, tables, db, cleanup } = buildSmithers();
    const workflow = smithers((ctx) => (
      <Workflow name="loop">
        <Ralph id="loop" until={ctx.outputs("outputA").length >= 2}>
          <Task id="step" output={outputs.outputA}>
            {{ value: ctx.outputs("outputA").length }}
          </Task>
        </Ralph>
      </Workflow>
    ));
    const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
    expect(result.status).toBe("finished");
    const rows = await db.select().from(tables.outputA);
    const iterations = rows.map((row) => row.iteration).sort((a, b) => a - b);
    expect(iterations).toEqual([0, 1]);
    cleanup();
  });
  test("multiple Ralph loops are independent", async () => {
    const { smithers, outputs, tables, db, cleanup } = buildSmithers();
    const workflow = smithers((ctx) => (
      <Workflow name="multi">
        <Sequence>
          <Ralph id="loopA" until={ctx.outputs("outputA").length >= 2}>
            <Task id="taskA" output={outputs.outputA}>
              {{ value: ctx.outputs("outputA").length }}
            </Task>
          </Ralph>
          <Ralph id="loopB" until={ctx.outputs("outputB").length >= 1}>
            <Task id="taskB" output={outputs.outputB}>
              {{ value: ctx.outputs("outputB").length }}
            </Task>
          </Ralph>
        </Sequence>
      </Workflow>
    ));
    const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
    expect(result.status).toBe("finished");
    const rowsA = await db.select().from(tables.outputA);
    const rowsB = await db.select().from(tables.outputB);
    const iterationsA = rowsA.map((row) => row.iteration).sort((a, b) => a - b);
    const iterationsB = rowsB.map((row) => row.iteration).sort((a, b) => a - b);
    expect(iterationsA).toEqual([0, 1]);
    expect(iterationsB).toEqual([0]);
    cleanup();
  });
  test("nested Ralph throws", async () => {
    const { smithers, outputs, cleanup } = buildSmithers();
    const workflow = smithers((_ctx) => (
      <Workflow name="nested">
        <Ralph id="outer" until={false}>
          <Ralph id="inner" until={true}>
            <Task id="innerTask" output={outputs.outputA}>
              {{ value: 1 }}
            </Task>
          </Ralph>
        </Ralph>
      </Workflow>
    ));
    const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
    expect(result.status).toBe("failed");
    cleanup();
  });
});
describe("Parallel concurrency", () => {
  test("respects maxConcurrency", async () => {
    const { smithers, outputs, cleanup } = buildSmithers();
    let current = 0;
    let max = 0;
    let started = 0;
    const releases = [];
    let runSettled = false;
    async function waitForStarted(count) {
      for (let i = 0; i < 1000; i += 1) {
        if (started >= count) return;
        if (runSettled) break;
        await Bun.sleep(1);
      }
      throw new Error(`expected ${count} parallel tasks to start, saw ${started}`);
    }
    function releaseOne() {
      const release = releases.shift();
      if (!release) throw new Error("no parallel task waiting to release");
      release();
    }
    const agent = {
      id: "fake",
      tools: {},
      generate: async () => {
        current += 1;
        started += 1;
        if (current > max) max = current;
        return await new Promise((resolve) => {
          releases.push(() => {
            current -= 1;
            resolve({ output: { value: 1 } });
          });
        });
      },
    };
    const workflow = smithers((_ctx) => (
      <Workflow name="parallel">
        <Parallel maxConcurrency={2}>
          {Array.from({ length: 5 }, (_, i) => (
            <Task key={`p${i}`} id={`p${i}`} output={outputs.outputC} agent={agent}>
              run task
            </Task>
          ))}
        </Parallel>
      </Workflow>
    ));
    const run = Effect.runPromise(
      runWorkflow(workflow, {
        input: {},
        maxConcurrency: 4,
      }),
    ).finally(() => {
      runSettled = true;
    });
    await waitForStarted(2);
    expect(current).toBe(2);
    releaseOne();
    releaseOne();
    await waitForStarted(4);
    expect(max).toBeLessThanOrEqual(2);
    releaseOne();
    releaseOne();
    await waitForStarted(5);
    expect(max).toBeLessThanOrEqual(2);
    releaseOne();
    const result = await run;
    expect(result.status).toBe("finished");
    expect(max).toBeLessThanOrEqual(2);
    cleanup();
  });
});
describe("Approvals", () => {
  test("needsApproval pauses and resumes", async () => {
    const { smithers, outputs, tables, db, cleanup } = buildSmithers();
    const workflow = smithers((_ctx) => (
      <Workflow name="approval">
        <Sequence>
          <Task id="gate" output={outputs.outputA} needsApproval>
            {{ value: 1 }}
          </Task>
          <Task id="after" output={outputs.outputB}>
            {{ value: 2 }}
          </Task>
        </Sequence>
      </Workflow>
    ));
    const first = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
    expect(first.status).toBe("waiting-approval");
    const adapter = new SmithersDb(db);
    await Effect.runPromise(approveNode(adapter, first.runId, "gate", 0, "ok", "test"));
    const resumed = await Effect.runPromise(
      runWorkflow(workflow, {
        input: {},
        runId: first.runId,
        resume: true,
      }),
    );
    expect(resumed.status).toBe("finished");
    const rowsB = await db.select().from(tables.outputB);
    expect(rowsB.length).toBe(1);
    cleanup();
  });
});
describe("Compute callback children", () => {
  test("sync callback is invoked and result written to db", async () => {
    const { smithers, outputs, tables, db, cleanup } = buildSmithers();
    const workflow = smithers((_ctx) => (
      <Workflow name="compute-sync">
        <Task id="calc" output={outputs.outputA}>
          {() => ({ value: 40 + 2 })}
        </Task>
      </Workflow>
    ));
    const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
    expect(result.status).toBe("finished");
    const rows = await db.select().from(tables.outputA);
    expect(rows.length).toBe(1);
    expect(rows[0].value).toBe(42);
    cleanup();
  });
  test("async callback is awaited and result written to db", async () => {
    const { smithers, outputs, tables, db, cleanup } = buildSmithers();
    const workflow = smithers((_ctx) => (
      <Workflow name="compute-async">
        <Task id="calc" output={outputs.outputA}>
          {async () => {
            await sleep(10);
            return { value: 99 };
          }}
        </Task>
      </Workflow>
    ));
    const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
    expect(result.status).toBe("finished");
    const rows = await db.select().from(tables.outputA);
    expect(rows.length).toBe(1);
    expect(rows[0].value).toBe(99);
    cleanup();
  });
  test("callback that throws fails the task", async () => {
    const { smithers, outputs, cleanup } = buildSmithers();
    const workflow = smithers((_ctx) => (
      <Workflow name="compute-fail">
        <Task id="calc" output={outputs.outputA} noRetry>
          {() => {
            throw new Error("compute boom");
          }}
        </Task>
      </Workflow>
    ));
    const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
    expect(result.status).toBe("failed");
    cleanup();
  });
  test("callback respects timeoutMs", async () => {
    const { smithers, outputs, cleanup } = buildSmithers();
    const workflow = smithers((_ctx) => (
      <Workflow name="compute-timeout">
        <Task id="slow" output={outputs.outputA} timeoutMs={50} noRetry>
          {async () => {
            await sleep(500);
            return { value: 1 };
          }}
        </Task>
      </Workflow>
    ));
    const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
    expect(result.status).toBe("failed");
    cleanup();
  });
  test("callback retries on failure", async () => {
    const { smithers, outputs, tables, db, cleanup } = buildSmithers();
    let calls = 0;
    const fn = () => {
      calls++;
      if (calls < 3) throw new Error("not yet");
      return { value: calls };
    };
    const workflow = smithers((_ctx) => (
      <Workflow name="compute-retry">
        <Task id="retryable" output={outputs.outputA} retries={2}>
          {fn}
        </Task>
      </Workflow>
    ));
    const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
    expect(result.status).toBe("finished");
    expect(calls).toBe(3);
    const rows = await db.select().from(tables.outputA);
    expect(rows.length).toBe(1);
    expect(rows[0].value).toBe(3);
    cleanup();
  });
  test("callback with continueOnFail does not fail workflow", async () => {
    const { smithers, outputs, tables, db, cleanup } = buildSmithers();
    const workflow = smithers((_ctx) => (
      <Workflow name="compute-continue">
        <Sequence>
          <Task id="bomb" output={outputs.outputA} continueOnFail noRetry>
            {() => {
              throw new Error("boom");
            }}
          </Task>
          <Task id="after" output={outputs.outputB}>
            {{ value: 42 }}
          </Task>
        </Sequence>
      </Workflow>
    ));
    const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
    expect(result.status).toBe("finished");
    const rowsB = await db.select().from(tables.outputB);
    expect(rowsB.length).toBe(1);
    expect(rowsB[0].value).toBe(42);
    cleanup();
  });
  test("callback in a sequence works with static tasks", async () => {
    const { smithers, outputs, tables, db, cleanup } = buildSmithers();
    const workflow = smithers((_ctx) => (
      <Workflow name="compute-sequence">
        <Sequence>
          <Task id="first" output={outputs.outputA}>
            {() => ({ value: 10 })}
          </Task>
          <Task id="second" output={outputs.outputB}>
            {{ value: 20 }}
          </Task>
        </Sequence>
      </Workflow>
    ));
    const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
    expect(result.status).toBe("finished");
    const rowsA = await db.select().from(tables.outputA);
    const rowsB = await db.select().from(tables.outputB);
    expect(rowsA[0].value).toBe(10);
    expect(rowsB[0].value).toBe(20);
    cleanup();
  });
});
describe("Renderer safeguards", () => {
  test("duplicate task ids fail the run", async () => {
    const { smithers, outputs, cleanup } = buildSmithers();
    const workflow = smithers((_ctx) => (
      <Workflow name="dup">
        <Sequence>
          <Task id="dup" output={outputs.outputA}>
            {{ value: 1 }}
          </Task>
          <Task id="dup" output={outputs.outputB}>
            {{ value: 2 }}
          </Task>
        </Sequence>
      </Workflow>
    ));
    const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
    expect(result.status).toBe("failed");
    cleanup();
  });
});
