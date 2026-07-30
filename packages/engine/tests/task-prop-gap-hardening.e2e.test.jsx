/** @jsxImportSource smthrs */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Sequence, SmithersDb, Task, Workflow, runWorkflow } from "smthrs";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { approveNode } from "../src/approvals.js";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { Effect } from "effect";
const END_TO_END_TIMEOUT_MS = 30_000;
function buildSmithers() {
  return createTestSmithers({
    num: z.object({ value: z.number() }),
    result: z.object({ value: z.number() }),
  });
}
describe("Task retryPolicy through the real engine", () => {
  test(
    "an explicit fixed retryPolicy delays the retry attempt by initialDelayMs",
    async () => {
      const { smithers, outputs, cleanup } = buildSmithers();
      try {
        /** @type {number[]} */
        const attemptTimes = [];
        const workflow = smithers(() => (
          <Workflow name="retry-policy-fixed">
            <Task id="flaky" output={outputs.num} retries={1} retryPolicy={{ backoff: "fixed", initialDelayMs: 300 }}>
              {() => {
                attemptTimes.push(Date.now());
                if (attemptTimes.length === 1) {
                  throw new Error("first attempt fails");
                }
                return { value: attemptTimes.length };
              }}
            </Task>
          </Workflow>
        ));
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("finished");
        expect(attemptTimes.length).toBe(2);
        // The retry must be admitted no earlier than the policy's delay
        // (small slack for clock granularity across nowMs anchors).
        expect(attemptTimes[1] - attemptTimes[0]).toBeGreaterThanOrEqual(250);
      } finally {
        cleanup();
      }
    },
    END_TO_END_TIMEOUT_MS,
  );
  test(
    "initialDelayMs 0 retries immediately instead of inheriting the 1s default policy",
    async () => {
      const { smithers, outputs, cleanup } = buildSmithers();
      try {
        /** @type {number[]} */
        const attemptTimes = [];
        const workflow = smithers(() => (
          <Workflow name="retry-policy-zero-delay">
            <Task id="flaky" output={outputs.num} retries={1} retryPolicy={{ backoff: "fixed", initialDelayMs: 0 }}>
              {() => {
                attemptTimes.push(Date.now());
                if (attemptTimes.length === 1) {
                  throw new Error("first attempt fails");
                }
                return { value: attemptTimes.length };
              }}
            </Task>
          </Workflow>
        ));
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("finished");
        expect(attemptTimes.length).toBe(2);
        // The implicit default policy for retriable tasks is exponential
        // with a 1000ms base; an explicit zero-delay policy must not fall
        // back to it. The generous bound only catches that regression.
        expect(attemptTimes[1] - attemptTimes[0]).toBeLessThan(1000);
      } finally {
        cleanup();
      }
    },
    END_TO_END_TIMEOUT_MS,
  );
  test(
    "retryAfterMs prevents a retry earlier than the provider minimum",
    async () => {
      const { smithers, outputs, cleanup } = buildSmithers();
      try {
        /** @type {number[]} */
        const attemptTimes = [];
        const workflow = smithers(() => (
          <Workflow name="retry-after-minimum">
            <Task id="provider-flaky" output={outputs.num} retries={1} retryPolicy={{ initialDelayMs: 50 }}>
              {() => {
                attemptTimes.push(Date.now());
                if (attemptTimes.length === 1) {
                  throw new SmithersError("PROVIDER_TRANSIENT", "provider cooldown", {
                    failureRetryable: true,
                    retryAfterMs: 300,
                  });
                }
                return { value: attemptTimes.length };
              }}
            </Task>
          </Workflow>
        ));

        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("finished");
        expect(attemptTimes).toHaveLength(2);
        expect(attemptTimes[1] - attemptTimes[0]).toBeGreaterThanOrEqual(250);
      } finally {
        cleanup();
      }
    },
    END_TO_END_TIMEOUT_MS,
  );
});
describe("depsOptional through the real engine", () => {
  test(
    "a failed continueOnFail upstream leaves the optional dep absent and the downstream still runs",
    async () => {
      const { smithers, outputs, tables, db, cleanup } = buildSmithers();
      try {
        const seenDeps = [];
        const workflow = smithers(() => (
          <Workflow name="deps-optional-failed-upstream">
            <Task id="up" output={outputs.num} continueOnFail noRetry>
              {() => {
                throw new Error("upstream always fails");
              }}
            </Task>
            <Task id="down" output={outputs.result} deps={{ up: outputs.num }} depsOptional>
              {(deps) => {
                seenDeps.push(deps);
                return { value: deps.up?.value ?? -1 };
              }}
            </Task>
          </Workflow>
        ));
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("finished");
        const rows = await db.select().from(tables.result);
        expect(rows).toEqual([
          expect.objectContaining({
            runId: result.runId,
            nodeId: "down",
            iteration: 0,
            value: -1,
          }),
        ]);
        // The unresolved key is omitted entirely, not set to undefined.
        expect(Object.keys(seenDeps.at(-1) ?? { sentinel: true })).toEqual([]);
      } finally {
        cleanup();
      }
    },
    END_TO_END_TIMEOUT_MS,
  );
});
describe("Task-level async approval (waitAsync)", () => {
  test(
    "a needsApproval async Task lets unrelated downstream work run before the decision",
    async () => {
      const { smithers, outputs, tables, db, cleanup } = buildSmithers();
      try {
        const workflow = smithers(() => (
          <Workflow name="task-async-approval">
            <Sequence>
              <Task id="gate" output={outputs.num} needsApproval async>
                {{ value: 1 }}
              </Task>
              <Task id="after" output={outputs.result}>
                {{ value: 2 }}
              </Task>
            </Sequence>
          </Workflow>
        ));
        const first = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(first.status).toBe("waiting-approval");
        // The async gate must not block the sequence: "after" already ran
        // while the approval was still pending.
        const afterRows = await db.select().from(tables.result);
        expect(afterRows).toEqual([
          expect.objectContaining({
            runId: first.runId,
            nodeId: "after",
            iteration: 0,
            value: 2,
          }),
        ]);
        expect((await db.select().from(tables.num)).length).toBe(0);
        const adapter = new SmithersDb(db);
        await Effect.runPromise(approveNode(adapter, first.runId, "gate", 0, "ok", "tester"));
        const resumed = await Effect.runPromise(
          runWorkflow(workflow, {
            input: {},
            runId: first.runId,
            resume: true,
          }),
        );
        expect(resumed.status).toBe("finished");
        const gateRows = await db.select().from(tables.num);
        expect(gateRows).toEqual([expect.objectContaining({ nodeId: "gate", value: 1 })]);
      } finally {
        cleanup();
      }
    },
    END_TO_END_TIMEOUT_MS,
  );
});
describe("Task scorer context input through the real engine", () => {
  test(
    "the context prop reaches the scorer and is persisted with the score row",
    async () => {
      const { smithers, outputs, db, cleanup } = buildSmithers();
      try {
        /** @type {unknown} */
        let receivedContext;
        let resolveScored;
        const scored = new Promise((resolve) => {
          resolveScored = resolve;
        });
        const capturingScorer = {
          id: "context-capture",
          name: "Context Capture",
          score: async ({ context }) => {
            receivedContext = context;
            resolveScored();
            return { score: 1, reason: "captured" };
          },
        };
        const context = { sources: ["spec.md", "design.md"], revision: 7 };
        const workflow = smithers(() => (
          <Workflow name="scorer-context">
            <Task id="answer" output={outputs.num} scorers={{ capture: { scorer: capturingScorer } }} context={context}>
              {{ value: 42 }}
            </Task>
          </Workflow>
        ));
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("finished");
        await scored;
        expect(receivedContext).toEqual(context);
        const adapter = new SmithersDb(db);
        const scores = await Effect.runPromise(adapter.listScorerResults(result.runId, "answer"));
        expect(scores.length).toBe(1);
        expect(JSON.parse(scores[0].contextJson ?? "null")).toEqual(context);
      } finally {
        cleanup();
      }
    },
    END_TO_END_TIMEOUT_MS,
  );
});
