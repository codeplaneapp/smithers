import { describe, expect, test } from "bun:test";
import { resolveForkSessionMessages } from "../src/resolveForkSessionMessages.js";

/**
 * @param {object} fields
 */
function attempt(fields) {
  return {
    runId: "r",
    iteration: 0,
    attempt: 1,
    state: "finished",
    startedAtMs: 0,
    finishedAtMs: null,
    heartbeatAtMs: null,
    heartbeatDataJson: null,
    errorJson: null,
    jjPointer: null,
    responseText: null,
    jjCwd: null,
    cached: false,
    metaJson: null,
    ...fields,
  };
}

/** @param {unknown[]} messages */
function metaWithConversation(messages) {
  return JSON.stringify({ kind: "agent", agentConversation: messages });
}

describe("resolveForkSessionMessages", () => {
  test("returns a deep copy of the source conversation", () => {
    const messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "ANSWER:a" },
    ];
    const attempts = [attempt({ nodeId: "a", finishedAtMs: 100, metaJson: metaWithConversation(messages) })];
    const result = resolveForkSessionMessages(attempts, "a", "b");
    expect(result).toEqual(messages);
    // Mutating the result must not affect the source array.
    result.push({ role: "user", content: "mutation" });
    expect(messages).toHaveLength(2);
  });

  test("resolves the latest completed iteration by finishedAtMs", () => {
    const attempts = [
      attempt({
        nodeId: "draft@@loop=0",
        iteration: 0,
        finishedAtMs: 100,
        metaJson: metaWithConversation([{ role: "assistant", content: "iter-0" }]),
      }),
      attempt({
        nodeId: "draft@@loop=1",
        iteration: 1,
        finishedAtMs: 200,
        metaJson: metaWithConversation([{ role: "assistant", content: "iter-1" }]),
      }),
    ];
    const result = resolveForkSessionMessages(attempts, "draft", "review");
    expect(result).toEqual([{ role: "assistant", content: "iter-1" }]);
  });

  test("matches the fork source by logical id, ignoring loop scope", () => {
    const attempts = [
      attempt({
        nodeId: "draft@@loop=0",
        finishedAtMs: 100,
        metaJson: metaWithConversation([{ role: "assistant", content: "scoped" }]),
      }),
    ];
    const result = resolveForkSessionMessages(attempts, "draft", "review");
    expect(result).toEqual([{ role: "assistant", content: "scoped" }]);
  });

  test("throws TASK_FORK_SOURCE_NOT_COMPLETE when no finished attempt exists", () => {
    const attempts = [attempt({ nodeId: "a", state: "in-progress", metaJson: null })];
    let error;
    try {
      resolveForkSessionMessages(attempts, "a", "b");
    } catch (err) {
      error = err;
    }
    expect(error?.code).toBe("TASK_FORK_SOURCE_NOT_COMPLETE");
  });

  test("skips attempts whose meta is missing, invalid JSON, or non-object JSON", () => {
    const attempts = [
      // Newest first by finishedAtMs; each malformed meta must be skipped in
      // order until the older usable snapshot is found.
      attempt({ nodeId: "a", finishedAtMs: 400, metaJson: null }),
      attempt({ nodeId: "a", finishedAtMs: 300, metaJson: "{not json" }),
      attempt({ nodeId: "a", finishedAtMs: 250, metaJson: "42" }),
      attempt({ nodeId: "a", finishedAtMs: 200, metaJson: JSON.stringify({ agentConversation: ["bare-string"] }) }),
      attempt({
        nodeId: "a",
        finishedAtMs: 100,
        metaJson: metaWithConversation([{ role: "assistant", content: "usable" }]),
      }),
    ];
    const result = resolveForkSessionMessages(attempts, "a", "b");
    expect(result).toEqual([{ role: "assistant", content: "usable" }]);
  });

  test("orders attempts by startedAtMs when finishedAtMs is missing", () => {
    const attempts = [
      attempt({
        nodeId: "a",
        finishedAtMs: null,
        startedAtMs: 100,
        metaJson: metaWithConversation([{ role: "assistant", content: "older" }]),
      }),
      attempt({
        nodeId: "a",
        finishedAtMs: null,
        startedAtMs: 200,
        metaJson: metaWithConversation([{ role: "assistant", content: "newer" }]),
      }),
    ];
    const result = resolveForkSessionMessages(attempts, "a", "b");
    expect(result).toEqual([{ role: "assistant", content: "newer" }]);
  });

  test("throws TASK_FORK_SESSION_UNAVAILABLE when finished but no usable conversation", () => {
    const attempts = [
      // A compute/static source finishes without an agent conversation.
      attempt({ nodeId: "a", finishedAtMs: 100, metaJson: JSON.stringify({ kind: "static" }) }),
    ];
    let error;
    try {
      resolveForkSessionMessages(attempts, "a", "b");
    } catch (err) {
      error = err;
    }
    expect(error?.code).toBe("TASK_FORK_SESSION_UNAVAILABLE");
  });
});
