import { describe, expect, test } from "bun:test";
import { persistConversationHijackHandoff } from "../src/hijack-session.js";

/**
 * `persistConversationHijackHandoff(adapter, candidate, messages)` is the seam
 * the CLI uses to hand a live conversation back to the engine. These tests
 * drive it with an in-memory adapter double returning the same shapes
 * SmithersDb.getAttempt/updateAttempt do (same pattern as
 * hijack-unit-coverage.test.js).
 */
function candidate(overrides = {}) {
  return {
    runId: "run-1",
    nodeId: "answer",
    iteration: 2,
    attempt: 3,
    engine: "claude-code",
    mode: "conversation",
    cwd: "/tmp/hijack-cwd",
    ...overrides,
  };
}

function makeAdapter(attemptRow) {
  const getAttemptCalls = [];
  const updates = [];
  return {
    getAttemptCalls,
    updates,
    async getAttempt(runId, nodeId, iteration, attempt) {
      getAttemptCalls.push([runId, nodeId, iteration, attempt]);
      return attemptRow;
    },
    async updateAttempt(runId, nodeId, iteration, attempt, patch) {
      updates.push({ runId, nodeId, iteration, attempt, patch });
    },
  };
}

describe("persistConversationHijackHandoff", () => {
  test("throws HIJACK_ATTEMPT_NOT_FOUND and writes nothing when the attempt row is gone", async () => {
    const adapter = makeAdapter(undefined);
    await expect(
      persistConversationHijackHandoff(adapter, candidate(), [{ role: "user", content: "hi" }]),
    ).rejects.toMatchObject({ code: "HIJACK_ATTEMPT_NOT_FOUND" });
    expect(adapter.updates).toHaveLength(0);
  });

  test("persists the handoff + agentConversation against the exact attempt coordinates", async () => {
    const adapter = makeAdapter({ metaJson: null });
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ];
    const before = Date.now();
    await persistConversationHijackHandoff(adapter, candidate(), messages);
    expect(adapter.getAttemptCalls).toEqual([["run-1", "answer", 2, 3]]);
    expect(adapter.updates).toHaveLength(1);
    const update = adapter.updates[0];
    expect([update.runId, update.nodeId, update.iteration, update.attempt]).toEqual(["run-1", "answer", 2, 3]);
    const meta = JSON.parse(update.patch.metaJson);
    expect(meta.agentConversation).toEqual(messages);
    expect(meta.hijackHandoff).toMatchObject({
      engine: "claude-code",
      mode: "conversation",
      messages,
      cwd: "/tmp/hijack-cwd",
      nodeId: "answer",
      iteration: 2,
      attempt: 3,
    });
    expect(meta.hijackHandoff.requestedAtMs).toBeGreaterThanOrEqual(before);
    expect(meta.hijackHandoff.requestedAtMs).toBeLessThanOrEqual(Date.now());
  });

  test("merges into existing meta, keeping unrelated keys and replacing a stale handoff", async () => {
    const adapter = makeAdapter({
      metaJson: JSON.stringify({
        agentEngine: "codex",
        custom: { keep: true },
        agentConversation: [{ role: "user", content: "old" }],
        hijackHandoff: { engine: "codex", mode: "conversation", messages: [] },
      }),
    });
    const messages = [{ role: "user", content: "new" }];
    await persistConversationHijackHandoff(adapter, candidate(), messages);
    const meta = JSON.parse(adapter.updates[0].patch.metaJson);
    expect(meta.agentEngine).toBe("codex");
    expect(meta.custom).toEqual({ keep: true });
    expect(meta.agentConversation).toEqual(messages);
    expect(meta.hijackHandoff.engine).toBe("claude-code");
    expect(meta.hijackHandoff.messages).toEqual(messages);
  });

  test("treats malformed metaJson as empty instead of crashing", async () => {
    const adapter = makeAdapter({ metaJson: "{not json" });
    await persistConversationHijackHandoff(adapter, candidate(), []);
    const meta = JSON.parse(adapter.updates[0].patch.metaJson);
    expect(meta.agentConversation).toEqual([]);
    expect(meta.hijackHandoff.mode).toBe("conversation");
  });

  test("treats a metaJson that parses to a non-object (array) as empty", async () => {
    const adapter = makeAdapter({ metaJson: JSON.stringify([1, 2, 3]) });
    await persistConversationHijackHandoff(adapter, candidate(), [{ role: "user", content: "x" }]);
    const meta = JSON.parse(adapter.updates[0].patch.metaJson);
    expect(Array.isArray(meta)).toBe(false);
    expect(meta.hijackHandoff.attempt).toBe(3);
  });

  test("an empty conversation persists as an empty array (smallest accepted handoff)", async () => {
    const adapter = makeAdapter({ metaJson: null });
    await persistConversationHijackHandoff(adapter, candidate(), []);
    const meta = JSON.parse(adapter.updates[0].patch.metaJson);
    expect(meta.agentConversation).toEqual([]);
    expect(meta.hijackHandoff.messages).toEqual([]);
  });
});
