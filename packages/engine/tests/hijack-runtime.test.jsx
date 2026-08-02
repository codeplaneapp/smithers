/** @jsxImportSource smthrs */
import { expect, test } from "bun:test";
import { SmithersDb } from "@smthrs/db/adapter";
import { Task, Workflow, runWorkflow } from "smthrs";
import { createTestSmithers, sleep } from "../../smithers/tests/helpers.js";
import { outputSchemas } from "../../smithers/tests/schema.js";
import { Effect } from "effect";
test("a hijacked CLI session can be resumed by Smithers on the next attempt", async () => {
  const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
  const adapter = new SmithersDb(db);
  const resumeSessions = [];
  let resolveToolStarted;
  const toolStarted = new Promise((resolve) => {
    resolveToolStarted = resolve;
  });
  let resolveReleaseTool;
  const releaseTool = new Promise((resolve) => {
    resolveReleaseTool = resolve;
  });
  let callCount = 0;
  const agent = {
    id: "fake-hijack-agent",
    cliEngine: "claude-code",
    tools: {},
    /**
     * @param {any} args
     */
    async generate(args) {
      callCount += 1;
      resumeSessions.push(args.resumeSession);
      if (callCount === 1) {
        args.onEvent?.({
          type: "started",
          engine: "claude-code",
          title: "Claude Code",
          resume: "session-1",
        });
        args.onEvent?.({
          type: "action",
          engine: "claude-code",
          phase: "started",
          action: {
            id: "tool-1",
            kind: "tool",
            title: "read",
          },
        });
        resolveToolStarted();
        await releaseTool;
        args.onEvent?.({
          type: "action",
          engine: "claude-code",
          phase: "completed",
          action: {
            id: "tool-1",
            kind: "tool",
            title: "read",
          },
          ok: true,
        });
        for (let i = 0; i < 10; i++) {
          await sleep(50);
          if (args.abortSignal?.aborted) {
            const err = new Error("hijacked");
            err.name = "AbortError";
            throw err;
          }
        }
      }
      return {
        text: '{"value":7}',
        output: { value: 7 },
      };
    },
  };
  const workflow = smithers((_ctx) => (
    <Workflow name="hijack-runtime">
      <Task id="plan" output={outputs.outputA} agent={agent}>
        produce a value
      </Task>
    </Workflow>
  ));
  const runPromise = Effect.runPromise(
    runWorkflow(workflow, {
      input: {},
      runId: "run-hijack-runtime",
    }),
  );
  await toolStarted;
  await adapter.requestRunHijack("run-hijack-runtime", Date.now(), "claude-code");
  await sleep(300);
  resolveReleaseTool();
  const hijacked = await runPromise;
  expect(hijacked.status).toBe("cancelled");
  const attemptsAfterHijack = await adapter.listAttempts("run-hijack-runtime", "plan", 0);
  const firstAttempt = attemptsAfterHijack[0];
  const firstMeta = JSON.parse(firstAttempt.metaJson);
  expect(firstMeta.agentResume).toBe("session-1");
  expect(firstMeta.hijackHandoff).toMatchObject({
    engine: "claude-code",
    resume: "session-1",
  });
  const resumed = await Effect.runPromise(
    runWorkflow(workflow, {
      input: {},
      runId: "run-hijack-runtime",
      resume: true,
    }),
  );
  expect(resumed.status).toBe("finished");
  expect(resumeSessions).toEqual([undefined, "session-1"]);
  cleanup();
});

test("a stale owner cannot complete a pending hijack after runtime takeover", async () => {
  const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
  const adapter = new SmithersDb(db);
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  let options;
  const agent = {
    id: "fake-hijack-takeover-agent",
    cliEngine: "claude-code",
    tools: {},
    async generate(args) {
      options = args;
      args.onEvent?.({
        type: "action",
        engine: "claude-code",
        phase: "started",
        action: { id: "tool-1", kind: "tool", title: "read" },
      });
      // Register the blocking action before publishing the resume
      // metadata, so the auto-hijack request cannot complete early.
      args.onEvent?.({ type: "started", engine: "claude-code", resume: "stale-session" });
      await blocked;
      args.onEvent?.({
        type: "action",
        engine: "claude-code",
        phase: "completed",
        action: { id: "tool-1", kind: "tool", title: "read" },
        ok: true,
      });
      return { text: '{"value":7}' };
    },
  };
  const workflow = smithers(() => (
    <Workflow name="hijack-runtime-owner-takeover">
      <Task id="plan" output={outputs.outputA} agent={agent} hijack>
        produce a value
      </Task>
    </Workflow>
  ));
  const runPromise = Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "run-hijack-owner-takeover" }));
  for (let i = 0; i < 80 && !options; i += 1) await sleep(25);
  expect(options).toBeDefined();
  // `hijack` assembles the durable request before generation starts. The
  // started blocking action keeps the request handoff-ready but prevents
  // completion until the explicit completed callback below.
  const pending = await adapter.getRun("run-hijack-owner-takeover");
  expect(pending?.hijackRequestedAtMs).toEqual(expect.any(Number));
  await sleep(350);
  await Effect.runPromise(adapter.updateRun("run-hijack-owner-takeover", { runtimeOwnerId: "new-runtime-owner" }));
  release();
  const result = await runPromise;
  expect(result.status).toBe("running");
  const attempt = (await adapter.listAttempts("run-hijack-owner-takeover", "plan", 0))[0];
  const meta = JSON.parse(attempt.metaJson);
  expect(meta.hijackHandoff).toBeNull();
  const events = await adapter.listEventHistory("run-hijack-owner-takeover", { limit: 200 });
  expect(events.map((event) => event.type)).not.toContain("RunHijacked");
  cleanup();
});
