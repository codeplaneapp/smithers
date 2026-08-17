/** @jsxImportSource smthrs */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SmithersDb } from "@smthrs/db/adapter";
import { Task, Workflow, runWorkflow } from "smthrs";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { outputSchemas } from "../../smithers/tests/schema.js";
import { Effect } from "effect";

/**
 * Stale resume pointers on unsuccessful attempts (#1610).
 *
 * Every agent attempt records where its conversation lives (`agentResume` in
 * `_smithers_attempts.meta_json`, mirrored into the heartbeat payload). Once the
 * attempt ends failed or cancelled that conversation is usually gone, so the
 * next attempt of the node resumed a dead id and died immediately with
 * `AGENT_SESSION_LOST` — burning one of the node's 2-3 retries without doing any
 * work. A live fleet sweep found 64 rows in that state.
 *
 * Two halves, tested here:
 *   1. Resolution ignores pointers recorded by attempts that did not succeed.
 *      This is what repairs rows that are ALREADY poisoned, which is why the
 *      seeded histories below write their rows raw instead of going through the
 *      engine.
 *   2. The terminal transition clears the pointers, so rows stop accumulating.
 *
 * A fresh session is always safe: the agent's real state lives in its worktree,
 * not in the conversation.
 */

const TIMEOUT_MS = 30_000;

/**
 * Seed an attempt history exactly as a poisoned production row looks, bypassing
 * the engine's terminal-transition hygiene. Returns the (VCS-free) root the
 * resumed run must use, so the resume metadata check sees no drift.
 *
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {Array<{ attempt: number; state: string; startedAtMs: number; meta?: Record<string, unknown>; heartbeat?: Record<string, unknown> }>} attempts
 */
async function seedPoisonedRun(adapter, runId, attempts) {
  const rootDir = mkdtempSync(join(tmpdir(), "stale-resume-pointers-"));
  await Effect.runPromise(
    adapter.insertRun({
      runId,
      // The resume guard checks the workflow name; the fixtures name the
      // workflow after the run.
      workflowName: runId,
      workflowPath: null,
      status: "cancelled",
      createdAtMs: 1_000,
      startedAtMs: 1_000,
      finishedAtMs: 2_000,
    }),
  );
  for (const attempt of attempts) {
    await Effect.runPromise(
      adapter.insertAttempt({
        runId,
        nodeId: "work",
        iteration: 0,
        attempt: attempt.attempt,
        state: attempt.state,
        startedAtMs: attempt.startedAtMs,
        finishedAtMs: attempt.startedAtMs + 10,
        errorJson: null,
        jjPointer: null,
        cached: false,
        heartbeatDataJson: attempt.heartbeat ? JSON.stringify(attempt.heartbeat) : null,
        metaJson: JSON.stringify({ kind: "agent", ...attempt.meta }),
        responseText: null,
      }),
    );
  }
  return rootDir;
}

/**
 * @param {Array<Record<string, unknown>>} calls
 */
function recordingAgent(calls) {
  return {
    id: "stale-pointer-agent",
    cliEngine: "fake-cli",
    tools: {},
    /** @param {any} args */
    async generate(args) {
      calls.push({ resumeSession: args.resumeSession, continueSession: args.continueSession });
      return { text: '{"value":1}' };
    },
  };
}

describe("stale resume pointers on unsuccessful attempts", () => {
  test(
    "a failed attempt's resume pointer is not reused by the next attempt",
    async () => {
      const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
      try {
        const calls = [];
        const agent = {
          id: "failing-then-working",
          cliEngine: "fake-cli",
          tools: {},
          /** @param {any} args */
          async generate(args) {
            calls.push({ resumeSession: args.resumeSession, continueSession: args.continueSession });
            if (calls.length === 1) {
              // Capture a session id the way every CLI agent does, then fail
              // for a reason that has nothing to do with the session.
              args.onEvent?.({ type: "started", engine: "fake-cli", resume: "dead-session-uuid" });
              throw new Error("transient tool failure");
            }
            return { text: '{"value":1}' };
          },
        };
        const workflow = smithers(() => (
          <Workflow name="stale-pointer-failed">
            <Task id="work" output={outputs.outputA} agent={agent} retries={1}>
              produce a value
            </Task>
          </Workflow>
        ));
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("finished");
        expect(calls).toHaveLength(2);
        expect(calls[0].resumeSession).toBeUndefined();
        // The retry must start a fresh session instead of dying on a dead id,
        // and must not fall back to the cwd-scoped --continue either.
        expect(calls[1].resumeSession).toBeUndefined();
        expect(calls[1].continueSession).toBeFalsy();

        // Hygiene half: the failed row no longer advertises the session.
        const adapter = new SmithersDb(db);
        const attempts = await Effect.runPromise(adapter.listAttempts(result.runId, "work", 0));
        const failed = attempts.find((attempt) => attempt.state === "failed");
        expect(failed).toBeDefined();
        const failedMeta = JSON.parse(failed.metaJson);
        expect(failedMeta.agentResume).toBeUndefined();
        expect(failedMeta.agentConversation).toBeFalsy();
        expect(failedMeta.lastHeartbeat).toBeFalsy();
        // Everything describing the work itself survives.
        expect(failedMeta.agentEngine).toBe("fake-cli");
      } finally {
        await cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "a cancelled attempt's resume pointer is not reused by the next attempt",
    async () => {
      const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
      let rootDir;
      try {
        const adapter = new SmithersDb(db);
        const runId = "stale-pointer-cancelled";
        // An engine bounce (crash recovery, concurrency change, quota-park
        // resume) cancels the in-flight attempt and leaves its pointer behind.
        rootDir = await seedPoisonedRun(adapter, runId, [
          {
            attempt: 1,
            state: "cancelled",
            startedAtMs: 1_100,
            meta: { agentEngine: "fake-cli", agentResume: "dead-session-uuid" },
            heartbeat: { agentEngine: "fake-cli", agentResume: "dead-session-uuid" },
          },
        ]);
        const calls = [];
        const workflow = smithers(() => (
          <Workflow name="stale-pointer-cancelled">
            <Task id="work" output={outputs.outputA} agent={recordingAgent(calls)} retries={1}>
              produce a value
            </Task>
          </Workflow>
        ));
        const result = await Effect.runPromise(
          runWorkflow(workflow, { input: {}, runId, rootDir, resume: true, force: true }),
        );
        expect(result.status).toBe("finished");
        expect(calls).toHaveLength(1);
        expect(calls[0].resumeSession).toBeUndefined();
        expect(calls[0].continueSession).toBeFalsy();
      } finally {
        if (rootDir) rmSync(rootDir, { recursive: true, force: true });
        await cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "a succeeded attempt's resume pointer is still honored",
    async () => {
      const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
      let rootDir;
      try {
        const adapter = new SmithersDb(db);
        const runId = "stale-pointer-succeeded";
        rootDir = await seedPoisonedRun(adapter, runId, [
          {
            attempt: 1,
            state: "finished",
            startedAtMs: 1_100,
            meta: { agentEngine: "fake-cli", agentResume: "live-session-uuid" },
            heartbeat: { agentEngine: "fake-cli", agentResume: "live-session-uuid" },
          },
        ]);
        const calls = [];
        const workflow = smithers(() => (
          <Workflow name="stale-pointer-succeeded">
            <Task id="work" output={outputs.outputA} agent={recordingAgent(calls)} retries={1}>
              produce a value
            </Task>
          </Workflow>
        ));
        const result = await Effect.runPromise(
          runWorkflow(workflow, { input: {}, runId, rootDir, resume: true, force: true }),
        );
        expect(result.status).toBe("finished");
        expect(calls).toHaveLength(1);
        // The fix must not disable resume: a session recorded by an attempt
        // that actually succeeded is still live and still worth continuing.
        expect(calls[0].resumeSession).toBe("live-session-uuid");
      } finally {
        if (rootDir) rmSync(rootDir, { recursive: true, force: true });
        await cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "a pointer survives neither a node reset nor accumulated attempt history",
    async () => {
      const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
      let rootDir;
      try {
        const adapter = new SmithersDb(db);
        const runId = "stale-pointer-reset-history";
        // Reproduction path 1 — `smithers timetravel --no-vcs --no-deps
        // --force`: the reset row carries the chronological boundary, and the
        // post-reset failures below it are the ones whose pointers used to be
        // picked up again once attempt numbering restarted.
        //
        // Reproduction path 2 — accumulated history: the newest failure never
        // reached a `started` event, so resolution walked back to an older
        // failed row and resurrected ITS pointer.
        rootDir = await seedPoisonedRun(adapter, runId, [
          {
            attempt: 5,
            state: "cancelled",
            startedAtMs: 900,
            meta: {
              resetCancelled: true,
              resetResumeBoundaryMs: 1_000,
              agentEngine: "fake-cli",
              agentResume: "pre-reset-session",
            },
          },
          {
            attempt: 1,
            state: "failed",
            startedAtMs: 1_100,
            meta: { agentEngine: "fake-cli", agentResume: "post-reset-session-1" },
            heartbeat: { agentEngine: "fake-cli", agentResume: "post-reset-session-1" },
          },
          {
            attempt: 2,
            state: "failed",
            startedAtMs: 1_200,
            meta: { agentEngine: "fake-cli", agentResume: "post-reset-session-2" },
            heartbeat: { agentEngine: "fake-cli", agentResume: "post-reset-session-2" },
          },
          // Died before the CLI announced a session, so this row holds no
          // pointer of its own to shadow the older ones.
          { attempt: 3, state: "failed", startedAtMs: 1_300, meta: { agentEngine: "fake-cli" } },
        ]);
        const calls = [];
        const workflow = smithers(() => (
          <Workflow name="stale-pointer-reset-history">
            {/* The seeded history already burned three attempts. */}
            <Task id="work" output={outputs.outputA} agent={recordingAgent(calls)} retries={5}>
              produce a value
            </Task>
          </Workflow>
        ));
        const result = await Effect.runPromise(
          runWorkflow(workflow, { input: {}, runId, rootDir, resume: true, force: true }),
        );
        expect(result.status).toBe("finished");
        expect(calls).toHaveLength(1);
        expect(calls[0].resumeSession).toBeUndefined();
        expect(calls[0].continueSession).toBeFalsy();
      } finally {
        if (rootDir) rmSync(rootDir, { recursive: true, force: true });
        await cleanup();
      }
    },
    TIMEOUT_MS,
  );
});
