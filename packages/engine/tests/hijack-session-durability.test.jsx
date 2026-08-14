/** @jsxImportSource smthrs */
/**
 * Regression for #1502: `smithers init` with Codex handed the user a session
 * id that `codex resume` could not find. Codex announces its thread id on
 * `thread.started` (and OMP its session id on `session`) but flushes the
 * matching session file a beat later, so aborting the CLI the moment that id
 * appeared left nothing on disk to resume. The auto-hijack handoff must
 * therefore wait for these engines' terminal turn `completed` event, while
 * engines with session-creation-time persistence keep handing off as soon as
 * the id appears.
 */
import { expect, test } from "bun:test";
import { SmithersDb } from "@smthrs/db/adapter";
import { Task, Workflow, runWorkflow } from "smthrs";
import { __engineInternals } from "../src/engine.js";
import { createTestSmithers, sleep } from "../../smithers/tests/helpers.js";
import { outputSchemas } from "../../smithers/tests/schema.js";
import { Effect } from "effect";

test("CLI turn completion resets before every generation", () => {
  const state = __engineInternals.createCliTurnCompletionState();
  expect(state.isCompleted()).toBe(false);
  state.complete();
  expect(state.isCompleted()).toBe(true);
  state.begin();
  expect(state.isCompleted()).toBe(false);
});

/**
 * A hijack-capable CLI agent that reports its session id up front and records
 * whether the engine aborted it before the turn finished.
 *
 * @param {string} cliEngine
 * @param {string} resume
 */
function sessionAnnouncingAgent(cliEngine, resume) {
  const observed = { abortedBeforeTurnCompleted: false };
  return {
    observed,
    agent: {
      id: `fake-${cliEngine}-agent`,
      cliEngine,
      tools: {},
      /** @param {any} args */
      async generate(args) {
        args.onEvent?.({ type: "started", engine: cliEngine, title: cliEngine, resume });
        // Keep the turn open across several hijack polls so an early abort is
        // observable before the terminal event is emitted.
        for (let tick = 0; tick < 12 && !args.abortSignal?.aborted; tick += 1) {
          await sleep(25);
        }
        observed.abortedBeforeTurnCompleted = Boolean(args.abortSignal?.aborted);
        args.onEvent?.({ type: "completed", engine: cliEngine, ok: true, answer: "{}", resume });
        while (!args.abortSignal?.aborted) {
          await sleep(25);
        }
        const err = new Error("hijacked");
        err.name = "AbortError";
        throw err;
      },
    },
  };
}

for (const engine of ["codex", "omp"]) {
  test(`${engine} auto-hijack waits for the turn to complete before handing off its session`, async () => {
    const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
    const adapter = new SmithersDb(db);
    const runId = `run-hijack-${engine}-durability`;
    const { agent, observed } = sessionAnnouncingAgent(engine, `${engine}-session-1`);
    const workflow = smithers(() => (
      <Workflow name={`hijack-${engine}-durability`}>
        <Task id="plan" output={outputs.outputA} agent={agent} hijack>
          produce a value
        </Task>
      </Workflow>
    ));
    try {
      const hijacked = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));
      expect(hijacked.status).toBe("cancelled");
      expect(observed.abortedBeforeTurnCompleted).toBe(false);
      const attempts = await adapter.listAttempts(runId, "plan", 0);
      const meta = JSON.parse(attempts[0].metaJson);
      expect(meta.hijackHandoff).toMatchObject({
        engine,
        mode: "native-cli",
        resume: `${engine}-session-1`,
      });
    } finally {
      cleanup();
    }
  });
}

test("a schema-correction turn must complete before Codex is handed off", async () => {
  const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
  const adapter = new SmithersDb(db);
  const runId = "run-hijack-codex-schema-correction";
  const observed = { calls: 0, abortedBeforeCorrectionCompleted: false };
  const resume = "codex-correction-session-1";
  const agent = {
    id: "fake-codex-correction-agent",
    cliEngine: "codex",
    tools: {},
    /** @param {any} args */
    async generate(args) {
      observed.calls += 1;
      if (observed.calls === 1) {
        args.onEvent?.({ type: "started", engine: "codex", title: "codex", resume });
        // Keep a tool marked active so the first completed event cannot hand
        // off yet, forcing the invalid output into a correction generation.
        args.onEvent?.({
          type: "action",
          engine: "codex",
          phase: "started",
          action: { id: "lingering-tool", kind: "tool", title: "tool" },
        });
        args.onEvent?.({ type: "completed", engine: "codex", ok: true, answer: "not-json", resume });
        return { text: "not-json" };
      }

      // Clearing the prior action makes the handoff eligible. It must still
      // wait for this correction turn's own terminal event.
      args.onEvent?.({
        type: "action",
        engine: "codex",
        phase: "completed",
        action: { id: "lingering-tool", kind: "tool", title: "tool" },
      });
      for (let tick = 0; tick < 40 && !args.abortSignal?.aborted; tick += 1) {
        await sleep(25);
      }
      observed.abortedBeforeCorrectionCompleted = Boolean(args.abortSignal?.aborted);
      if (!args.abortSignal?.aborted) {
        args.onEvent?.({ type: "completed", engine: "codex", ok: true, answer: '{"value":1}', resume });
      }
      while (!args.abortSignal?.aborted) {
        await sleep(25);
      }
      const err = new Error("hijacked");
      err.name = "AbortError";
      throw err;
    },
  };
  const workflow = smithers(() => (
    <Workflow name="hijack-codex-schema-correction">
      <Task id="plan" output={outputs.outputA} agent={agent} hijack maxSchemaRetries={1}>
        produce a value
      </Task>
    </Workflow>
  ));
  try {
    const hijacked = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));
    expect(hijacked.status).toBe("cancelled");
    expect(observed.calls).toBe(2);
    expect(observed.abortedBeforeCorrectionCompleted).toBe(false);
    const attempts = await adapter.listAttempts(runId, "plan", 0);
    const meta = JSON.parse(attempts[0].metaJson);
    expect(meta.hijackHandoff).toMatchObject({ engine: "codex", mode: "native-cli", resume });
  } finally {
    cleanup();
  }
});

test("engines that persist sessions at creation still hand off on the started event", async () => {
  const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
  const adapter = new SmithersDb(db);
  const runId = "run-hijack-claude-durability";
  const { agent, observed } = sessionAnnouncingAgent("claude-code", "claude-session-1");
  const workflow = smithers(() => (
    <Workflow name="hijack-claude-durability">
      <Task id="plan" output={outputs.outputA} agent={agent} hijack>
        produce a value
      </Task>
    </Workflow>
  ));
  try {
    const hijacked = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));
    expect(hijacked.status).toBe("cancelled");
    expect(observed.abortedBeforeTurnCompleted).toBe(true);
    const attempts = await adapter.listAttempts(runId, "plan", 0);
    const meta = JSON.parse(attempts[0].metaJson);
    expect(meta.hijackHandoff).toMatchObject({
      engine: "claude-code",
      mode: "native-cli",
      resume: "claude-session-1",
    });
  } finally {
    cleanup();
  }
});
