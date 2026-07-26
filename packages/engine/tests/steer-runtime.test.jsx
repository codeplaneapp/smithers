/** @jsxImportSource smithers-orchestrator */
/**
 * Runtime behaviour of the durable steer primitive: a queued steer is
 * consumed into a node's next agent generate() call (first start, retry
 * attempt, or loop iteration), injected as a user turn before the
 * structured-output schema wrap, captured in the persisted conversation
 * (replay-safe), and expired when its run reaches a terminal state with the
 * steer still queued.
 *
 * Real bun:sqlite, real engine, inline fake agents that record exactly what the
 * runtime handed them (params.prompt / params.messages) — the in-process
 * equivalent of a fake CLI recording its stdin/argv.
 */
import { describe, expect, test } from "bun:test";
import { Workflow, Task, Sequence, Loop, runWorkflow } from "smithers-orchestrator";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { enqueueSteer } from "../src/steers.js";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { z } from "zod";
import { Effect } from "effect";

/**
 * Flatten whatever the engine handed the agent into a single searchable string.
 * @param {{ prompt?: string; messages?: Array<{ role?: string; content?: unknown }> }} params
 */
function receivedText(params) {
  if (typeof params.prompt === "string") {
    return params.prompt;
  }
  if (Array.isArray(params.messages)) {
    return params.messages
      .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
      .join("\n");
  }
  return "";
}

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {string} type
 */
async function eventsOfType(adapter, runId, type) {
  const rows = await Effect.runPromise(adapter.listEventsByType(runId, type));
  return rows.map((row) => JSON.parse(/** @type {string} */ (row.payloadJson)));
}

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {string} nodeId
 * @param {number} iteration
 */
async function conversationOf(adapter, runId, nodeId, iteration) {
  const attempts = await Effect.runPromise(adapter.listAttempts(runId, nodeId, iteration));
  const last = attempts.at(-1);
  const meta = last?.metaJson ? JSON.parse(last.metaJson) : {};
  return meta.agentConversation ?? null;
}

describe("steer runtime", () => {
  test("first-start: a steer queued for a not-yet-started node is consumed at its first generate", async () => {
    const { smithers, outputs, db, cleanup } = createTestSmithers({
      a: z.object({ v: z.number() }),
      b: z.object({ v: z.number() }),
    });
    try {
      const runId = "steer-first-start";
      const adapter = new SmithersDb(db);
      const STEER = "PLEASE prefer the smaller change";
      const receivedByB = [];
      const agentA = {
        id: "agent-a",
        tools: {},
        generate: async () => {
          // Queue a steer for downstream node "b" while it has not started.
          await Effect.runPromise(enqueueSteer(adapter, runId, "b", STEER, { author: "tester" }));
          return { output: { v: 1 }, response: { messages: [{ role: "assistant", content: "a-done" }] } };
        },
      };
      const agentB = {
        id: "agent-b",
        tools: {},
        generate: async (params) => {
          receivedByB.push(params);
          return { output: { v: 2 }, response: { messages: [{ role: "assistant", content: "b-done" }] } };
        },
      };
      const workflow = smithers(() => (
        <Workflow name="steer-first-start">
          <Sequence>
            <Task id="a" output={outputs.a} agent={agentA}>
              run a
            </Task>
            <Task id="b" output={outputs.b} agent={agentB}>
              run b
            </Task>
          </Sequence>
        </Workflow>
      ));
      const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));
      expect(result.status).toBe("finished");

      // The agent actually received the steer text.
      expect(receivedByB).toHaveLength(1);
      expect(receivedText(receivedByB[0])).toContain(STEER);

      // It is captured in the persisted conversation (replay-safe).
      const convo = await conversationOf(adapter, runId, "b", 0);
      expect(JSON.stringify(convo)).toContain(STEER);

      // The steer row is consumed, attributed to b's first attempt/iteration.
      const steers = await Effect.runPromise(adapter.listSteers(runId));
      expect(steers).toHaveLength(1);
      expect(steers[0].status).toBe("consumed");
      expect(steers[0].consumedByAttempt).toBe(1);
      expect(steers[0].consumedByIteration).toBe(0);

      // Events: queued (out-of-process style) then consumed.
      expect(await eventsOfType(adapter, runId, "SteerQueued")).toHaveLength(1);
      const consumed = await eventsOfType(adapter, runId, "SteerConsumed");
      expect(consumed).toHaveLength(1);
      expect(consumed[0].nodeId).toBe("b");
      expect(consumed[0].steerId).toBe(steers[0].steerId);
    } finally {
      cleanup();
    }
  });

  test("retry attempt: a steer queued after a failed attempt is consumed by the retry", async () => {
    const { smithers, outputs, db, cleanup } = createTestSmithers({
      a: z.object({ v: z.number() }),
    });
    try {
      const runId = "steer-retry";
      const adapter = new SmithersDb(db);
      const STEER = "avoid the deprecated API";
      const received = [];
      let calls = 0;
      const agent = {
        id: "agent-retry",
        tools: {},
        generate: async (params) => {
          calls += 1;
          received.push(params);
          if (calls === 1) {
            await Effect.runPromise(enqueueSteer(adapter, runId, "task", STEER));
            throw new Error("boom-attempt-1");
          }
          return { output: { v: 2 }, response: { messages: [{ role: "assistant", content: "ok" }] } };
        },
      };
      const workflow = smithers(() => (
        <Workflow name="steer-retry">
          <Task id="task" output={outputs.a} agent={agent} retries={2}>
            go
          </Task>
        </Workflow>
      ));
      const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));
      expect(result.status).toBe("finished");
      expect(calls).toBe(2);

      // Attempt 1 saw no steer; attempt 2 (the retry) received it.
      expect(receivedText(received[0])).not.toContain(STEER);
      expect(receivedText(received[1])).toContain(STEER);

      const steers = await Effect.runPromise(adapter.listSteers(runId));
      expect(steers).toHaveLength(1);
      expect(steers[0].status).toBe("consumed");
      expect(steers[0].consumedByAttempt).toBe(2);
    } finally {
      cleanup();
    }
  });

  test("loop iteration: a steer queued during iteration 0 is consumed at iteration 1", async () => {
    const { smithers, outputs, db, cleanup } = createTestSmithers({
      rev: z.object({ done: z.boolean() }),
    });
    try {
      const runId = "steer-loop";
      const adapter = new SmithersDb(db);
      const STEER = "tighten the assertion this pass";
      const received = [];
      let calls = 0;
      const agent = {
        id: "agent-loop",
        tools: {},
        generate: async (params) => {
          calls += 1;
          received.push(params);
          if (calls === 1) {
            await Effect.runPromise(enqueueSteer(adapter, runId, "task", STEER));
          }
          return {
            output: { done: calls >= 2 },
            response: { messages: [{ role: "assistant", content: `iter-${calls}` }] },
          };
        },
      };
      const workflow = smithers((ctx) => {
        const latest = ctx.latest("rev", "task");
        return (
          <Workflow name="steer-loop">
            <Loop id="loop" until={latest?.done === true} maxIterations={5}>
              <Task id="task" output={outputs.rev} agent={agent}>
                review
              </Task>
            </Loop>
          </Workflow>
        );
      });
      const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));
      expect(result.status).toBe("finished");
      expect(calls).toBe(2);

      // Iteration 0 did not see the steer; iteration 1 did.
      expect(receivedText(received[0])).not.toContain(STEER);
      expect(receivedText(received[1])).toContain(STEER);

      const steers = await Effect.runPromise(adapter.listSteers(runId));
      expect(steers).toHaveLength(1);
      expect(steers[0].status).toBe("consumed");
      expect(steers[0].consumedByIteration).toBe(1);
    } finally {
      cleanup();
    }
  });

  test("multiple queued steers are consumed in creation order", async () => {
    const { smithers, outputs, db, cleanup } = createTestSmithers({
      a: z.object({ v: z.number() }),
      b: z.object({ v: z.number() }),
    });
    try {
      const runId = "steer-order";
      const adapter = new SmithersDb(db);
      const receivedByB = [];
      const agentA = {
        id: "agent-a",
        tools: {},
        generate: async () => {
          await Effect.runPromise(enqueueSteer(adapter, runId, "b", "FIRST steer", { timestampMs: 1000 }));
          await Effect.runPromise(enqueueSteer(adapter, runId, "b", "SECOND steer", { timestampMs: 2000 }));
          await Effect.runPromise(enqueueSteer(adapter, runId, "b", "THIRD steer", { timestampMs: 3000 }));
          return { output: { v: 1 }, response: { messages: [{ role: "assistant", content: "a" }] } };
        },
      };
      const agentB = {
        id: "agent-b",
        tools: {},
        generate: async (params) => {
          receivedByB.push(params);
          return { output: { v: 2 }, response: { messages: [{ role: "assistant", content: "b" }] } };
        },
      };
      const workflow = smithers(() => (
        <Workflow name="steer-order">
          <Sequence>
            <Task id="a" output={outputs.a} agent={agentA}>
              a
            </Task>
            <Task id="b" output={outputs.b} agent={agentB}>
              b
            </Task>
          </Sequence>
        </Workflow>
      ));
      const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));
      expect(result.status).toBe("finished");

      const text = receivedText(receivedByB[0]);
      const first = text.indexOf("FIRST steer");
      const second = text.indexOf("SECOND steer");
      const third = text.indexOf("THIRD steer");
      expect(first).toBeGreaterThanOrEqual(0);
      expect(first).toBeLessThan(second);
      expect(second).toBeLessThan(third);

      const consumed = await eventsOfType(adapter, runId, "SteerConsumed");
      expect(consumed).toHaveLength(3);
    } finally {
      cleanup();
    }
  });

  test("structured-output node: steer injected before the JSON wrap, extraction still works", async () => {
    const { smithers, outputs, db, cleanup } = createTestSmithers({
      a: z.object({ v: z.number() }),
      b: z.object({ v: z.number() }),
    });
    try {
      const runId = "steer-structured";
      const adapter = new SmithersDb(db);
      const STEER = "return v as 7 exactly";
      const receivedByB = [];
      const agentA = {
        id: "agent-a",
        tools: {},
        generate: async () => {
          await Effect.runPromise(enqueueSteer(adapter, runId, "b", STEER));
          return { output: { v: 1 }, response: { messages: [{ role: "assistant", content: "a" }] } };
        },
      };
      // Returns raw JSON text (no `output`): forces the prompt-injection +
      // text-extraction fallback that the schema wrap drives.
      const agentB = {
        id: "agent-b",
        tools: {},
        generate: async (params) => {
          receivedByB.push(params);
          return { text: JSON.stringify({ v: 7 }) };
        },
      };
      const workflow = smithers(() => (
        <Workflow name="steer-structured">
          <Sequence>
            <Task id="a" output={outputs.a} agent={agentA}>
              a
            </Task>
            <Task id="b" output={outputs.b} agent={agentB}>
              produce json
            </Task>
          </Sequence>
        </Workflow>
      ));
      const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));
      expect(result.status).toBe("finished");

      const text = receivedText(receivedByB[0]);
      const steerAt = text.indexOf(STEER);
      const jsonContractAt = text.indexOf("last character");
      expect(steerAt).toBeGreaterThanOrEqual(0);
      expect(jsonContractAt).toBeGreaterThanOrEqual(0);
      // The steer lands before the "last character must be `}`" instruction,
      // so it does not dilute / break the JSON contract.
      expect(steerAt).toBeLessThan(jsonContractAt);

      // A `finished` status proves text-extraction produced a schema-valid
      // output row for node b (an unparseable / invalid row fails the node).
      const steers = await Effect.runPromise(adapter.listSteers(runId));
      expect(steers[0].status).toBe("consumed");
    } finally {
      cleanup();
    }
  });

  test("expiry: a queued steer that is never consumed expires when the run finishes", async () => {
    const { smithers, outputs, db, cleanup } = createTestSmithers({
      a: z.object({ v: z.number() }),
    });
    try {
      const runId = "steer-expiry";
      const adapter = new SmithersDb(db);
      const agent = {
        id: "agent-expiry",
        tools: {},
        generate: async () => {
          // Queue a steer for THIS node after its consumption drain already
          // ran — it will never see another generate() call, so it must
          // expire when the run finishes.
          await Effect.runPromise(enqueueSteer(adapter, runId, "task", "too late to matter"));
          return { output: { v: 1 }, response: { messages: [{ role: "assistant", content: "ok" }] } };
        },
      };
      const workflow = smithers(() => (
        <Workflow name="steer-expiry">
          <Task id="task" output={outputs.a} agent={agent}>
            go
          </Task>
        </Workflow>
      ));
      const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));
      expect(result.status).toBe("finished");

      const steers = await Effect.runPromise(adapter.listSteers(runId));
      expect(steers).toHaveLength(1);
      expect(steers[0].status).toBe("expired");
      expect(steers[0].expiredAtMs).toBeGreaterThan(0);

      const expired = await eventsOfType(adapter, runId, "SteerExpired");
      expect(expired).toHaveLength(1);
      expect(expired[0].steerId).toBe(steers[0].steerId);
      // Never consumed.
      expect(await eventsOfType(adapter, runId, "SteerConsumed")).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test("zero-steer path is unchanged and injects nothing", async () => {
    const { smithers, outputs, db, cleanup } = createTestSmithers({
      a: z.object({ v: z.number() }),
    });
    try {
      const runId = "steer-none";
      const adapter = new SmithersDb(db);
      const received = [];
      const agent = {
        id: "agent-none",
        tools: {},
        generate: async (params) => {
          received.push(params);
          return { output: { v: 1 }, response: { messages: [{ role: "assistant", content: "ok" }] } };
        },
      };
      const workflow = smithers(() => (
        <Workflow name="steer-none">
          <Task id="task" output={outputs.a} agent={agent}>
            plain prompt
          </Task>
        </Workflow>
      ));
      const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));
      expect(result.status).toBe("finished");
      expect(received).toHaveLength(1);
      expect(receivedText(received[0])).toContain("plain prompt");

      // No steer rows, no steer events.
      expect(await Effect.runPromise(adapter.listSteers(runId))).toHaveLength(0);
      expect(await eventsOfType(adapter, runId, "SteerConsumed")).toHaveLength(0);
      expect(await eventsOfType(adapter, runId, "SteerExpired")).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test("idempotent: consumption is a one-way status transition (no double injection on replay)", async () => {
    const { smithers, outputs, db, cleanup } = createTestSmithers({
      a: z.object({ v: z.number() }),
      b: z.object({ v: z.number() }),
    });
    try {
      const runId = "steer-idempotent";
      const adapter = new SmithersDb(db);
      const STEER = "single application only";
      const agentA = {
        id: "agent-a",
        tools: {},
        generate: async () => {
          await Effect.runPromise(enqueueSteer(adapter, runId, "b", STEER));
          return { output: { v: 1 }, response: { messages: [{ role: "assistant", content: "a" }] } };
        },
      };
      const agentB = {
        id: "agent-b",
        tools: {},
        generate: async () => ({ output: { v: 2 }, response: { messages: [{ role: "assistant", content: "b" }] } }),
      };
      const workflow = smithers(() => (
        <Workflow name="steer-idempotent">
          <Sequence>
            <Task id="a" output={outputs.a} agent={agentA}>
              a
            </Task>
            <Task id="b" output={outputs.b} agent={agentB}>
              b
            </Task>
          </Sequence>
        </Workflow>
      ));
      const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));
      expect(result.status).toBe("finished");

      const convoOnce = JSON.stringify(await conversationOf(adapter, runId, "b", 0));
      // The steer appears exactly once in b's conversation.
      expect(convoOnce.split(STEER).length - 1).toBe(1);

      // Consumption is durable: the queued set is drained, so any re-render /
      // resume of node b finds nothing to inject again.
      expect(await Effect.runPromise(adapter.listQueuedSteers(runId, "b"))).toHaveLength(0);
      expect(await eventsOfType(adapter, runId, "SteerConsumed")).toHaveLength(1);

      // Re-running the finished run is a no-op and never re-injects.
      const second = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));
      expect(second.status).toBe("finished");
      expect(await eventsOfType(adapter, runId, "SteerConsumed")).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  test("child-run addressing: steers target the child run id via the same code path", async () => {
    // The engine consumes steers for (engine.runId, desc.nodeId). A child
    // workflow runs its own engine invocation keyed on childRunId, so a steer
    // addressed to the childRunId is consumed by the child node with no
    // special-casing. Verify the (runId, nodeId) query isolates by run id.
    const { db, cleanup } = createTestSmithers({ a: z.object({ v: z.number() }) });
    try {
      ensureSmithersTables(db);
      const adapter = new SmithersDb(db);
      const now = Date.now();
      await Effect.runPromise(
        adapter.enqueueSteer({
          steerId: "np",
          runId: "parent-run",
          nodeId: "task",
          message: "for parent",
          createdAtMs: now,
        }),
      );
      await Effect.runPromise(
        adapter.enqueueSteer({
          steerId: "nc",
          runId: "child-run",
          nodeId: "task",
          message: "for child",
          createdAtMs: now,
        }),
      );

      const parentQueued = await Effect.runPromise(adapter.listQueuedSteers("parent-run", "task"));
      const childQueued = await Effect.runPromise(adapter.listQueuedSteers("child-run", "task"));
      expect(parentQueued).toHaveLength(1);
      expect(parentQueued[0].message).toBe("for parent");
      expect(childQueued).toHaveLength(1);
      expect(childQueued[0].message).toBe("for child");
    } finally {
      cleanup();
    }
  });
});
