/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { SmithersDb, Task, Workflow, runWorkflow } from "smithers-orchestrator";
import { Subflow } from "@smithers-orchestrator/components/components/index";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { Effect } from "effect";
const END_TO_END_TIMEOUT_MS = 30_000;
function buildSmithers() {
  return createTestSmithers({
    num: z.object({ value: z.number() }),
    childOut: z.object({ topic: z.string() }),
    subflowEcho: z.object({ topic: z.string() }),
    result: z.object({ value: z.number() }),
  });
}
describe("Task label persistence", () => {
  test(
    "a Task label lands on the persisted node row",
    async () => {
      const { smithers, outputs, db, cleanup } = buildSmithers();
      try {
        const workflow = smithers(() => (
          <Workflow name="task-label">
            <Task id="labeled" label="Compute the answer" output={outputs.num}>
              {{ value: 42 }}
            </Task>
          </Workflow>
        ));
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("finished");
        const adapter = new SmithersDb(db);
        const nodes = await Effect.runPromise(adapter.listNodes(result.runId));
        const labeled = nodes.find((node) => node.nodeId === "labeled");
        expect(labeled?.label).toBe("Compute the answer");
      } finally {
        cleanup();
      }
    },
    END_TO_END_TIMEOUT_MS,
  );
});
describe("Task outputSchema override", () => {
  test(
    "validation uses the outputSchema override instead of the registered output schema",
    async () => {
      const { smithers, outputs, cleanup } = buildSmithers();
      try {
        const workflow = smithers(() => (
          <Workflow name="output-schema-override-reject">
            <Task id="bounded" output={outputs.num} outputSchema={z.object({ value: z.number().max(5) })} noRetry>
              {{ value: 10 }}
            </Task>
          </Workflow>
        ));
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("failed");
      } finally {
        cleanup();
      }
    },
    END_TO_END_TIMEOUT_MS,
  );
  test(
    "a payload satisfying the override validates and finishes",
    async () => {
      const { smithers, outputs, tables, db, cleanup } = buildSmithers();
      try {
        const workflow = smithers(() => (
          <Workflow name="output-schema-override-accept">
            <Task id="bounded" output={outputs.num} outputSchema={z.object({ value: z.number().max(5) })} noRetry>
              {{ value: 3 }}
            </Task>
          </Workflow>
        ));
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("finished");
        const rows = await db.select().from(tables.num);
        expect(rows.length).toBe(1);
        expect(rows[0].value).toBe(3);
      } finally {
        cleanup();
      }
    },
    END_TO_END_TIMEOUT_MS,
  );
});
describe("Task groundTruth scorer input", () => {
  test(
    "groundTruth reaches the scorer and is persisted with the score row",
    async () => {
      const { smithers, outputs, db, cleanup } = buildSmithers();
      try {
        /** @type {unknown} */
        let receivedGroundTruth;
        let resolveScored;
        const scored = new Promise((resolve) => {
          resolveScored = resolve;
        });
        const capturingScorer = {
          id: "ground-truth-capture",
          name: "Ground Truth Capture",
          score: async ({ groundTruth }) => {
            receivedGroundTruth = groundTruth;
            resolveScored();
            return { score: 1, reason: "captured" };
          },
        };
        const groundTruth = { expectedValue: 42, source: "spec" };
        const workflow = smithers(() => (
          <Workflow name="ground-truth-scorer">
            <Task
              id="answer"
              output={outputs.num}
              scorers={{ capture: { scorer: capturingScorer } }}
              groundTruth={groundTruth}
            >
              {{ value: 42 }}
            </Task>
          </Workflow>
        ));
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("finished");
        await scored;
        expect(receivedGroundTruth).toEqual(groundTruth);
        const adapter = new SmithersDb(db);
        const scores = await Effect.runPromise(adapter.listScorerResults(result.runId, "answer"));
        expect(scores.length).toBe(1);
        expect(JSON.parse(scores[0].groundTruthJson ?? "null")).toEqual(groundTruth);
      } finally {
        cleanup();
      }
    },
    END_TO_END_TIMEOUT_MS,
  );
});
describe("skipIf upstream with a dependent downstream", () => {
  test(
    "a downstream deps consumer of a skipped task fails loudly with a deadlock diagnostic",
    async () => {
      const { smithers, outputs, cleanup } = buildSmithers();
      try {
        const workflow = smithers(() => (
          <Workflow name="skipif-upstream-deps">
            <Task id="up" output={outputs.num} skipIf>
              {{ value: 1 }}
            </Task>
            <Task id="down" output={outputs.result} deps={{ up: outputs.num }}>
              {(deps) => ({ value: (deps.up?.value ?? 0) + 1 })}
            </Task>
          </Workflow>
        ));
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("failed");
        expect(result.error?.code).toBe("DEPENDENCY_DEADLOCK");
        expect(result.error?.message).toContain("'down' never ran (waiting on 'up')");
      } finally {
        cleanup();
      }
    },
    END_TO_END_TIMEOUT_MS,
  );
});
describe("Subflow input passing and failure propagation", () => {
  test(
    "the input prop is delivered to the child workflow's ctx.input",
    async () => {
      const { smithers, outputs, tables, db, cleanup } = buildSmithers();
      try {
        const childWorkflow = smithers(
          (ctx) => (
            <Workflow name="subflow-input-child">
              <Task id="echo-topic" output={outputs.childOut}>
                {{ topic: ctx.input.topic ?? "missing" }}
              </Task>
            </Workflow>
          ),
          { output: outputs.childOut },
        );
        const parentWorkflow = smithers(() => (
          <Workflow name="subflow-input-parent">
            <Subflow
              id="child-run"
              output={outputs.subflowEcho}
              workflow={childWorkflow}
              input={{ topic: "quarterly-report" }}
            />
          </Workflow>
        ));
        const result = await Effect.runPromise(runWorkflow(parentWorkflow, { input: {} }));
        expect(result.status).toBe("finished");
        const adapter = new SmithersDb(db);
        const childRun = await adapter.getLatestChildRun(result.runId);
        expect(childRun?.status).toBe("finished");
        const rows = await db.select().from(tables.childOut);
        expect(rows).toEqual([
          expect.objectContaining({
            runId: childRun?.runId,
            nodeId: "echo-topic",
            topic: "quarterly-report",
          }),
        ]);
      } finally {
        cleanup();
      }
    },
    END_TO_END_TIMEOUT_MS,
  );
  test(
    "a failing child run fails the parent when retries are exhausted",
    async () => {
      const { smithers, outputs, db, cleanup } = buildSmithers();
      try {
        const childWorkflow = smithers(() => (
          <Workflow name="subflow-failing-child">
            <Task id="explode" output={outputs.num} noRetry>
              {() => {
                throw new Error("child exploded");
              }}
            </Task>
          </Workflow>
        ));
        const parentWorkflow = smithers(() => (
          <Workflow name="subflow-failing-parent">
            <Subflow id="child-run" output={outputs.result} workflow={childWorkflow} retries={0} />
          </Workflow>
        ));
        const result = await Effect.runPromise(runWorkflow(parentWorkflow, { input: {} }));
        expect(result.status).toBe("failed");
        const adapter = new SmithersDb(db);
        const childRun = await adapter.getLatestChildRun(result.runId);
        expect(childRun?.status).toBe("failed");
      } finally {
        cleanup();
      }
    },
    END_TO_END_TIMEOUT_MS,
  );
});
