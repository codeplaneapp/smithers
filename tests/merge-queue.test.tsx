/** @jsxImportSource smithers */
import { describe, expect, test } from "bun:test";
import { SmithersRenderer } from "../src/dom/renderer";
import {
  MergeQueue,
  Parallel,
  Task,
  Workflow,
  runWorkflow,
  smithers,
} from "../src/index.ts";
import { createTestDb, sleep } from "./helpers";
import { ddl, outputC, schema } from "./schema";

function buildDb() {
  return createTestDb(schema, ddl);
}

describe("<MergeQueue>", () => {
  test("explicit id propagates to child task descriptors", async () => {
    const renderer = new SmithersRenderer();
    const res = await renderer.render(
      <Workflow name="mq-id">
        <MergeQueue id="my-queue">
          <Task id="a" output={outputC}>
            {{ value: 1 }}
          </Task>
          <Task id="b" output={outputC}>
            {{ value: 2 }}
          </Task>
        </MergeQueue>
      </Workflow>,
    );
    expect(res.tasks.length).toBe(2);
    expect(res.tasks[0]!.parallelGroupId).toBe("my-queue");
    expect(res.tasks[1]!.parallelGroupId).toBe("my-queue");
  });

  test("extract sets parallel group with default concurrency 1", async () => {
    const renderer = new SmithersRenderer();
    const res = await renderer.render(
      <Workflow name="mq">
        <MergeQueue>
          <Task id="m1" output={outputC}>
            {{ value: 1 }}
          </Task>
          <Task id="m2" output={outputC}>
            {{ value: 2 }}
          </Task>
        </MergeQueue>
      </Workflow>,
    );
    expect(res.tasks.length).toBe(2);
    const g1 = res.tasks[0]!.parallelGroupId;
    const g2 = res.tasks[1]!.parallelGroupId;
    expect(typeof g1).toBe("string");
    expect(g1 && g1.length > 0).toBe(true);
    expect(g1).toBe(g2);
    expect(res.tasks[0]!.parallelMaxConcurrency).toBe(1);
    expect(res.tasks[1]!.parallelMaxConcurrency).toBe(1);
  });

  test("skipIf prevents subtree extraction", async () => {
    const renderer = new SmithersRenderer();
    const res = await renderer.render(
      <Workflow name="mq">
        <MergeQueue skipIf>
          <Task id="m1" output={outputC}>
            {{ value: 1 }}
          </Task>
        </MergeQueue>
      </Workflow>,
    );
    expect(res.tasks.length).toBe(0);
  });

  test("engine enforces default concurrency = 1 within queue", async () => {
    const { db, cleanup } = buildDb();
    let current = 0;
    let max = 0;
    const agent: any = {
      id: "fake",
      generate: async ({ prompt }: { prompt: string }) => {
        current += 1;
        if (current > max) max = current;
        await sleep(30);
        current -= 1;
        const value = Number((prompt ?? "").split(":")[1] ?? 0);
        return { output: { value } };
      },
    };

    const wf = smithers(db as any, (_ctx) => (
      <Workflow name="mq-run">
        <MergeQueue>
          {Array.from({ length: 4 }, (_, i) => (
            <Task key={`m${i}`} id={`m${i}`} output={outputC} agent={agent}>
              {`v:${i}`}
            </Task>
          ))}
        </MergeQueue>
      </Workflow>
    ));

    const result = await runWorkflow(wf, { input: {}, maxConcurrency: 4 });
    expect(result.status).toBe("finished");
    expect(max).toBeLessThanOrEqual(1);
    cleanup();
  });

  test("engine respects provided maxConcurrency on queue", async () => {
    const { db, cleanup } = buildDb();
    let current = 0;
    let max = 0;
    const agent: any = {
      id: "fake",
      generate: async ({ prompt }: { prompt: string }) => {
        current += 1;
        if (current > max) max = current;
        await sleep(20);
        current -= 1;
        const value = Number((prompt ?? "").split(":")[1] ?? 0);
        return { output: { value } };
      },
    };

    const wf = smithers(db as any, (_ctx) => (
      <Workflow name="mq-2">
        <MergeQueue maxConcurrency={2}>
          {Array.from({ length: 5 }, (_, i) => (
            <Task key={`m${i}`} id={`mm${i}`} output={outputC} agent={agent}>
              {`v:${i}`}
            </Task>
          ))}
        </MergeQueue>
      </Workflow>
    ));

    const result = await runWorkflow(wf, { input: {}, maxConcurrency: 4 });
    expect(result.status).toBe("finished");
    expect(max).toBeLessThanOrEqual(2);
    cleanup();
  });
  test("innermost group controls concurrency when nested inside Parallel", async () => {
    const { db, cleanup } = buildDb();
    let queueCurrent = 0, queueMax = 0;
    let outsideCurrent = 0, outsideMax = 0;
    const agent: any = {
      id: "fake",
      generate: async ({ prompt }: { prompt: string }) => {
        const isQueue = String(prompt ?? "").startsWith("q:");
        if (isQueue) {
          queueCurrent += 1;
          queueMax = Math.max(queueMax, queueCurrent);
          await sleep(25);
          queueCurrent -= 1;
        } else {
          outsideCurrent += 1;
          outsideMax = Math.max(outsideMax, outsideCurrent);
          await sleep(25);
          outsideCurrent -= 1;
        }
        return { output: { value: 1 } };
      },
    };

    const wf = smithers(db as any, (_ctx) => (
      <Workflow name="mq-nest">
        <Parallel maxConcurrency={3}>
          <MergeQueue>
            {Array.from({ length: 3 }, (_, i) => (
              <Task key={`q${i}`} id={`q${i}`} output={outputC} agent={agent}>
                {`q:${i}`}
              </Task>
            ))}
          </MergeQueue>
          <Task id="o0" output={outputC} agent={agent}>
            o:0
          </Task>
          <Task id="o1" output={outputC} agent={agent}>
            o:1
          </Task>
        </Parallel>
      </Workflow>
    ));

    const result = await runWorkflow(wf, { input: {}, maxConcurrency: 4 });
    expect(result.status).toBe("finished");
    expect(queueMax).toBeLessThanOrEqual(1);
    expect(outsideMax).toBeGreaterThanOrEqual(1);
    cleanup();
  });
});
