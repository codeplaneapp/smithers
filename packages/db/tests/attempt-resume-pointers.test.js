import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Effect } from "effect";
import { SmithersDb } from "../src/adapter.js";
import { ensureSmithersTables } from "../src/ensure.js";
import {
  attemptResumePointersUsable,
  clearAttemptResumePointers,
  isNonSuccessTerminalAttemptState,
} from "../src/attempt-resume-pointers.js";

/**
 * #1610: an attempt that ends failed or cancelled keeps advertising the
 * conversation it was talking to. That conversation is usually gone, so the
 * next attempt of the node resumes a dead id and dies instantly with
 * AGENT_SESSION_LOST, burning a retry without doing any work.
 */

function createTestDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { adapter: new SmithersDb(db), sqlite };
}

const POINTERED_META = {
  kind: "agent",
  agentEngine: "claude-code",
  agentResume: "session-uuid",
  agentConversation: [{ role: "user", content: "hi" }],
  lastHeartbeat: { agentResume: "session-uuid" },
  resumedFromSession: "older-session-uuid",
  resumedFromConversation: true,
};

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {Record<string, unknown>} meta
 */
async function seedInProgressAttempt(adapter, runId, meta = POINTERED_META) {
  await Effect.runPromise(
    Effect.all([
      adapter.insertRun({
        runId,
        workflowName: "resume-pointers",
        status: "running",
        createdAtMs: 1_000,
        startedAtMs: 1_000,
      }),
      adapter.insertAttempt({
        runId,
        nodeId: "work",
        iteration: 0,
        attempt: 1,
        state: "in-progress",
        startedAtMs: 1_100,
        metaJson: JSON.stringify(meta),
      }),
    ]),
  );
}

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 */
async function readMeta(adapter, runId) {
  const attempt = await Effect.runPromise(adapter.getAttempt(runId, "work", 0, 1));
  return JSON.parse(attempt.metaJson);
}

describe("attempt resume pointers", () => {
  test("classifies only the non-success terminal states", () => {
    expect(isNonSuccessTerminalAttemptState("failed")).toBe(true);
    expect(isNonSuccessTerminalAttemptState("cancelled")).toBe(true);
    expect(isNonSuccessTerminalAttemptState("canceled")).toBe(true);
    // Still live, or successful: these attempts own usable pointers.
    expect(isNonSuccessTerminalAttemptState("in-progress")).toBe(false);
    expect(isNonSuccessTerminalAttemptState("finished")).toBe(false);
    expect(isNonSuccessTerminalAttemptState("waiting-approval")).toBe(false);
    expect(isNonSuccessTerminalAttemptState(undefined)).toBe(false);
    expect(attemptResumePointersUsable({ state: "failed" })).toBe(false);
    expect(attemptResumePointersUsable({ state: "finished" })).toBe(true);
    expect(attemptResumePointersUsable(undefined)).toBe(true);
  });

  test("clears pointers without touching what describes the work", () => {
    const cleared = JSON.parse(clearAttemptResumePointers(JSON.stringify(POINTERED_META)));
    expect(cleared).toEqual({ kind: "agent", agentEngine: "claude-code" });
    // Nothing to strip reports no change, so callers can skip the write.
    expect(clearAttemptResumePointers(JSON.stringify({ kind: "agent" }))).toBeNull();
    expect(clearAttemptResumePointers(JSON.stringify({ agentResume: null }))).toBeNull();
    expect(clearAttemptResumePointers("not json")).toBeNull();
    expect(clearAttemptResumePointers(null)).toBeNull();
    // A hand-off names a session a human is holding open.
    expect(
      clearAttemptResumePointers(JSON.stringify({ ...POINTERED_META, hijackHandoff: { engine: "claude-code" } })),
    ).toBeNull();
  });

  test("updateAttempt clears the pointers when the attempt ends without success", async () => {
    const { adapter, sqlite } = createTestDb();
    try {
      await seedInProgressAttempt(adapter, "run-cancel");
      await Effect.runPromise(
        adapter.updateAttempt("run-cancel", "work", 0, 1, { state: "cancelled", finishedAtMs: 1_200 }),
      );
      const meta = await readMeta(adapter, "run-cancel");
      expect(meta).toEqual({ kind: "agent", agentEngine: "claude-code" });
    } finally {
      sqlite.close();
    }
  });

  test("updateAttempt clears pointers the same patch is trying to write", async () => {
    const { adapter, sqlite } = createTestDb();
    try {
      await seedInProgressAttempt(adapter, "run-fail", { kind: "agent" });
      await Effect.runPromise(
        adapter.updateAttempt("run-fail", "work", 0, 1, {
          state: "failed",
          finishedAtMs: 1_200,
          metaJson: JSON.stringify(POINTERED_META),
        }),
      );
      const meta = await readMeta(adapter, "run-fail");
      expect(meta).toEqual({ kind: "agent", agentEngine: "claude-code" });
    } finally {
      sqlite.close();
    }
  });

  test("updateAttempt leaves a successful attempt's pointers alone", async () => {
    const { adapter, sqlite } = createTestDb();
    try {
      await seedInProgressAttempt(adapter, "run-finish");
      await Effect.runPromise(
        adapter.updateAttempt("run-finish", "work", 0, 1, { state: "finished", finishedAtMs: 1_200 }),
      );
      expect(await readMeta(adapter, "run-finish")).toEqual(POINTERED_META);
    } finally {
      sqlite.close();
    }
  });

  test("claimAttemptTerminal clears the pointers it just made stale", async () => {
    const { adapter, sqlite } = createTestDb();
    try {
      await seedInProgressAttempt(adapter, "run-claim");
      const claimed = await Effect.runPromise(
        adapter.claimAttemptTerminal("run-claim", "work", 0, 1, null, "failed", 1_200, null),
      );
      expect(claimed).toBe(true);
      expect(await readMeta(adapter, "run-claim")).toEqual({ kind: "agent", agentEngine: "claude-code" });
    } finally {
      sqlite.close();
    }
  });

  test("claimAttemptTerminal keeps a hand-off attempt resumable", async () => {
    const { adapter, sqlite } = createTestDb();
    try {
      const handoffMeta = { ...POINTERED_META, hijackHandoff: { engine: "claude-code", resume: "session-uuid" } };
      await seedInProgressAttempt(adapter, "run-handoff", handoffMeta);
      const claimed = await Effect.runPromise(
        adapter.claimAttemptTerminal("run-handoff", "work", 0, 1, null, "cancelled", 1_200, null),
      );
      expect(claimed).toBe(true);
      // The hand-off cancelled this attempt precisely so a human could take
      // the session over; both the resumed run and `smithers hijack` need it.
      expect(await readMeta(adapter, "run-handoff")).toEqual(handoffMeta);
    } finally {
      sqlite.close();
    }
  });
});
