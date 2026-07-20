/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { Parallel, Sequence, Task, Workflow, runWorkflow } from "smithers-orchestrator";
import { approveNode } from "../src/approvals.js";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { outputSchemas } from "../../smithers/tests/schema.js";
import { Effect } from "effect";

const TIMEOUT_MS = 20_000;

/**
 * A recording agent that captures every generate() call and returns a
 * structured output plus an assistant message tagged with a unique marker so
 * tests can prove which prior contexts a forked task received.
 * @param {string} marker
 * @param {number} value
 * @param {{ failFirst?: boolean; alwaysFail?: boolean }} [opts]
 */
function recordingAgent(marker, value, opts = {}) {
  const calls = [];
  let attempts = 0;
  return {
    calls,
    get callCount() {
      return calls.length;
    },
    agent: {
      id: `agent-${marker}`,
      tools: {},
      generate: async (args) => {
        attempts += 1;
        calls.push(args);
        if (opts.alwaysFail || (opts.failFirst && attempts === 1)) {
          throw new Error(`agent ${marker} failed`);
        }
        return {
          output: { value },
          text: JSON.stringify({ value }),
          response: { messages: [{ role: "assistant", content: `ANSWER:${marker}` }] },
        };
      },
    },
  };
}

/**
 * Collect the string contents of a captured generate() call's messages.
 * @param {any} call
 * @returns {string}
 */
function messagesText(call) {
  if (!call || !Array.isArray(call.messages)) return "";
  return JSON.stringify(call.messages);
}

describe("Task fork — agent session forking", () => {
  test("basic fork: b waits for a, receives a's context, a is not mutated", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers(outputSchemas);
    const a = recordingAgent("a", 1);
    const b = recordingAgent("b", 2);
    const wf = smithers(() => (
      <Workflow name="fork-basic">
        <Task id="a" output={outputs.outputA} agent={a.agent}>
          Prompt A
        </Task>
        <Task id="b" output={outputs.outputB} agent={b.agent} fork="a">
          Prompt B
        </Task>
      </Workflow>
    ));
    const result = await Effect.runPromise(runWorkflow(wf, { input: {} }));
    expect(result.status).toBe("finished");

    // a ran fresh (with a prompt, not seeded messages); b ran once.
    expect(a.callCount).toBe(1);
    expect(b.callCount).toBe(1);
    expect(a.calls[0].messages).toBeUndefined();
    expect(a.calls[0].prompt).toContain("Prompt A");

    // b received a's conversation as seeded messages, plus its own prompt.
    expect(Array.isArray(b.calls[0].messages)).toBe(true);
    expect(messagesText(b.calls[0])).toContain("ANSWER:a");
    expect(messagesText(b.calls[0])).toContain("Prompt B");

    // Both outputs persist independently.
    const rowsA = await db.select().from(tables.outputA);
    const rowsB = await db.select().from(tables.outputB);
    expect(rowsA.map((r) => r.value)).toEqual([1]);
    expect(rowsB.map((r) => r.value)).toEqual([2]);

    // a's stored session is unchanged — it never received b's prompt.
    const adapter = new SmithersDb(db);
    const aAttempts = await Effect.runPromise(adapter.listAttempts(result.runId, "a", 0));
    const aMeta = JSON.parse(aAttempts[0].metaJson ?? "{}");
    expect(JSON.stringify(aMeta.agentConversation)).not.toContain("Prompt B");
    cleanup();
  }, TIMEOUT_MS);

  test("parallel forks: both branches get the same base context, isolated from each other", async () => {
    const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
    const base = recordingAgent("base", 1);
    const left = recordingAgent("left", 2);
    const right = recordingAgent("right", 3);
    const wf = smithers(() => (
      <Workflow name="fork-parallel">
        <Task id="base" output={outputs.outputA} agent={base.agent}>
          Base prompt
        </Task>
        <Parallel>
          <Task id="left" output={outputs.outputB} agent={left.agent} fork="base">
            Left prompt
          </Task>
          <Task id="right" output={outputs.outputC} agent={right.agent} fork="base">
            Right prompt
          </Task>
        </Parallel>
      </Workflow>
    ));
    const result = await Effect.runPromise(runWorkflow(wf, { input: {} }));
    expect(result.status).toBe("finished");
    expect(base.callCount).toBe(1);

    // Both forks see the base context.
    expect(messagesText(left.calls[0])).toContain("ANSWER:base");
    expect(messagesText(right.calls[0])).toContain("ANSWER:base");
    // ...but not each other's prompts (independent copies).
    expect(messagesText(left.calls[0])).not.toContain("Right prompt");
    expect(messagesText(right.calls[0])).not.toContain("Left prompt");
    cleanup();
  }, TIMEOUT_MS);

  test("refork: c forked from b receives a + b context", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers(outputSchemas);
    const a = recordingAgent("a", 1);
    const b = recordingAgent("b", 2);
    const c = recordingAgent("c", 3);
    const wf = smithers(() => (
      <Workflow name="fork-refork">
        <Task id="a" output={outputs.outputA} agent={a.agent}>
          Prompt A
        </Task>
        <Task id="b" output={outputs.outputB} agent={b.agent} fork="a">
          Prompt B
        </Task>
        <Task id="c" output={outputs.outputC} agent={c.agent} fork="b">
          Prompt C
        </Task>
      </Workflow>
    ));
    const result = await Effect.runPromise(runWorkflow(wf, { input: {} }));
    expect(result.status).toBe("finished");
    const cMessages = messagesText(c.calls[0]);
    expect(cMessages).toContain("ANSWER:a");
    expect(cMessages).toContain("ANSWER:b");
    expect(cMessages).toContain("Prompt C");
    cleanup();
  }, TIMEOUT_MS);

  test("failed source: forked task does not run", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers(outputSchemas);
    const a = recordingAgent("a", 1, { alwaysFail: true });
    const b = recordingAgent("b", 2);
    const wf = smithers(() => (
      <Workflow name="fork-failed-source">
        <Task id="a" output={outputs.outputA} agent={a.agent} noRetry>
          Prompt A
        </Task>
        <Task id="b" output={outputs.outputB} agent={b.agent} fork="a">
          Prompt B
        </Task>
      </Workflow>
    ));
    const result = await Effect.runPromise(runWorkflow(wf, { input: {} }));
    expect(result.status).toBe("failed");
    expect(b.callCount).toBe(0);
    cleanup();
  }, TIMEOUT_MS);

  test("non-agent source: forked task fails with TASK_FORK_SESSION_UNAVAILABLE", async () => {
    const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
    const b = recordingAgent("b", 2);
    const wf = smithers(() => (
      <Workflow name="fork-non-agent-source">
        <Task id="a" output={outputs.outputA}>
          {{ value: 1 }}
        </Task>
        <Task id="b" output={outputs.outputB} agent={b.agent} fork="a" noRetry>
          Prompt B
        </Task>
      </Workflow>
    ));
    const result = await Effect.runPromise(runWorkflow(wf, { input: {} }));
    expect(result.status).toBe("failed");
    const adapter = new SmithersDb(db);
    const bAttempts = await Effect.runPromise(adapter.listAttempts(result.runId, "b", 0));
    const error = JSON.parse(bAttempts[0]?.errorJson ?? "{}");
    expect(error.code).toBe("TASK_FORK_SESSION_UNAVAILABLE");
    cleanup();
  }, TIMEOUT_MS);

  test("resume: source completes before a stop, forked task still gets context after resume", async () => {
    const { smithers, outputs, tables, db, dbPath, cleanup } = createTestSmithers(outputSchemas);
    const a = recordingAgent("a", 1);
    const b = recordingAgent("b", 2);
    const wf = smithers(() => (
      <Workflow name="fork-resume">
        <Sequence>
          <Task id="a" output={outputs.outputA} agent={a.agent}>
            Prompt A
          </Task>
          <Task id="gate" output={outputs.outputC} needsApproval>
            {{ value: 0 }}
          </Task>
          <Task id="b" output={outputs.outputB} agent={b.agent} fork="a">
            Prompt B
          </Task>
        </Sequence>
      </Workflow>
    ));
    // First pass: a completes, run pauses at the approval gate, b has not run.
    const first = await Effect.runPromise(runWorkflow(wf, { input: {} }));
    expect(first.status).toBe("waiting-approval");
    expect(a.callCount).toBe(1);
    expect(b.callCount).toBe(0);

    // Approve and resume in a fresh run invocation.
    const adapter = new SmithersDb(db);
    await Effect.runPromise(approveNode(adapter, first.runId, "gate", 0, "ok", "test"));
    const resumed = await Effect.runPromise(
      runWorkflow(wf, { input: {}, runId: first.runId, resume: true }),
    );
    expect(resumed.status).toBe("finished");

    // a was not re-executed; b received a's context across the stop/resume.
    expect(a.callCount).toBe(1);
    expect(b.callCount).toBe(1);
    expect(messagesText(b.calls[0])).toContain("ANSWER:a");
    const rowsB = await db.select().from(tables.outputB);
    expect(rowsB.map((r) => r.value)).toEqual([2]);
    expect(dbPath).toBeTruthy();
    cleanup();
  }, TIMEOUT_MS);
});
