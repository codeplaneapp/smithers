import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Cause, Effect } from "effect";
import { SmithersError } from "@smthrs/errors/SmithersError";
import { ensureSmithersTables } from "@smthrs/db/ensure";
import { createMemoryStore } from "../src/store/index.js";
import { TtlGarbageCollector, TokenLimiter, Summarizer } from "../src/processors.js";
const WF_NS = { kind: "workflow", id: "test-proc" };
describe("TtlGarbageCollector", () => {
  let store;
  beforeEach(() => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    store = createMemoryStore(db);
  });
  test("deletes expired facts", async () => {
    // Set a fact with very short TTL
    await store.setFact(WF_NS, "ephemeral", "temp", 1);
    // Wait for it to expire
    await new Promise((r) => setTimeout(r, 10));
    // Set a fact without TTL (should survive)
    await store.setFact(WF_NS, "permanent", "stays");
    const gc = TtlGarbageCollector();
    expect(gc.name).toBe("TtlGarbageCollector");
    await gc.process(store);
    const ephemeral = await store.getFact(WF_NS, "ephemeral");
    const permanent = await store.getFact(WF_NS, "permanent");
    expect(ephemeral).toBeUndefined();
    expect(permanent).toBeDefined();
  });
  test("no-op when no expired facts exist", async () => {
    await store.setFact(WF_NS, "long-lived", "value", 999999);
    const gc = TtlGarbageCollector();
    // Should not throw
    await gc.process(store);
    const fact = await store.getFact(WF_NS, "long-lived");
    expect(fact).toBeDefined();
  });
});
describe("TokenLimiter", () => {
  test("creates processor with name", () => {
    const limiter = TokenLimiter(4096);
    expect(limiter.name).toBe("TokenLimiter");
  });
  test("process does not throw", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    const store = createMemoryStore(db);
    const limiter = TokenLimiter(4096);
    // Should not throw
    await limiter.process(store);
  });
  test("rejects negative and non-finite budgets", () => {
    expect(() => TokenLimiter(-1)).toThrow(/non-negative finite/);
    expect(() => TokenLimiter(Number.NaN)).toThrow(/non-negative finite/);
  });
  test("does not trim a thread exactly at the token budget", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    const store = createMemoryStore(db);
    const thread = await store.createThread(WF_NS);

    for (const [index, content] of ["abcd", "wxyz"].entries()) {
      await store.saveMessage({
        id: `msg-${index}`,
        threadId: thread.threadId,
        role: "user",
        contentJson: JSON.stringify(content),
        createdAtMs: index,
      });
    }

    await TokenLimiter(3).process(store);

    expect((await store.listMessages(thread.threadId)).map((message) => message.id)).toEqual(["msg-0", "msg-1"]);
  });
  test("zero budget prunes all messages in a thread", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    const store = createMemoryStore(db);
    const thread = await store.createThread(WF_NS);

    for (const id of ["msg-1", "msg-2"]) {
      await store.saveMessage({
        id,
        threadId: thread.threadId,
        role: "user",
        contentJson: JSON.stringify("x"),
      });
    }

    await TokenLimiter(0).process(store);

    expect(await store.listMessages(thread.threadId)).toEqual([]);
  });
  test("trims oldest messages in each thread to stay under budget", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    const store = createMemoryStore(db);
    const thread = await store.createThread(WF_NS);
    const otherThread = await store.createThread(WF_NS);

    await store.saveMessage({
      id: "msg-1",
      threadId: thread.threadId,
      role: "user",
      contentJson: JSON.stringify("x".repeat(80)),
      createdAtMs: 1,
    });
    await store.saveMessage({
      id: "msg-2",
      threadId: thread.threadId,
      role: "assistant",
      contentJson: JSON.stringify("short"),
      createdAtMs: 2,
    });
    await store.saveMessage({
      id: "msg-3",
      threadId: otherThread.threadId,
      role: "user",
      contentJson: JSON.stringify("short"),
      createdAtMs: 3,
    });

    const limiter = TokenLimiter(5);
    await limiter.process(store);

    expect((await store.listMessages(thread.threadId)).map((message) => message.id)).toEqual(["msg-2"]);
    expect((await store.listMessages(otherThread.threadId)).map((message) => message.id)).toEqual(["msg-3"]);
  });
});
describe("Summarizer", () => {
  test("creates processor with name", () => {
    const mockAgent = { run: async (_prompt) => ({ text: "summary" }) };
    const summarizer = Summarizer(mockAgent);
    expect(summarizer.name).toBe("Summarizer");
  });
  test("process does not throw", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    const store = createMemoryStore(db);
    const mockAgent = { run: async (_prompt) => ({ text: "summary" }) };
    const summarizer = Summarizer(mockAgent);
    // Should not throw
    await summarizer.process(store);
  });
  test("wraps agent failures as SmithersError", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    const store = createMemoryStore(db);
    const thread = await store.createThread(WF_NS);
    for (const [index, role] of [
      [1, "user"],
      [2, "assistant"],
      [3, "user"],
    ]) {
      await store.saveMessage({
        id: `msg-${index}`,
        threadId: thread.threadId,
        role,
        contentJson: JSON.stringify("message"),
        createdAtMs: index,
      });
    }

    const failure = new Error("agent unavailable");
    const summarizer = Summarizer({
      run: async () => {
        throw failure;
      },
    });
    const exit = await Effect.runPromiseExit(summarizer.processEffect(store));
    const failureOption = Cause.findErrorOption(exit.cause);
    expect(failureOption._tag).toBe("Some");
    const error = failureOption.value;

    expect(error).toBeInstanceOf(SmithersError);
    expect(error.code).toBe("INTERNAL_ERROR");
    expect(error.cause).toBe(failure);
  });
  test("summarizes old messages with the agent and preserves recent messages", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    const store = createMemoryStore(db);
    const thread = await store.createThread(WF_NS);
    const prompts = [];
    const mockAgent = {
      run: async (prompt) => {
        prompts.push(prompt);
        return { text: "The user asked for a status update." };
      },
    };

    for (const [index, role, content] of [
      [1, "user", "Can you check the rollout?"],
      [2, "assistant", "I will check it."],
      [3, "user", "Any update?"],
      [4, "assistant", "The rollout is healthy."],
    ]) {
      await store.saveMessage({
        id: `msg-${index}`,
        threadId: thread.threadId,
        role,
        contentJson: JSON.stringify(content),
        createdAtMs: index,
      });
    }

    const summarizer = Summarizer(mockAgent);
    await summarizer.process(store);

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Can you check the rollout?");
    const messages = await store.listMessages(thread.threadId);
    expect(messages).toHaveLength(3);
    expect(messages[0].role).toBe("system");
    expect(JSON.parse(messages[0].contentJson)).toEqual({
      type: "summary",
      text: "The user asked for a status update.",
    });
    expect(messages.slice(1).map((message) => message.id)).toEqual(["msg-3", "msg-4"]);
  });
  test("includes raw non-JSON message content in the summary prompt", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    const store = createMemoryStore(db);
    const thread = await store.createThread(WF_NS);
    const prompts = [];
    const mockAgent = {
      run: async (prompt) => {
        prompts.push(prompt);
        return { text: "summary" };
      },
    };

    await store.saveMessage({
      id: "raw-old",
      threadId: thread.threadId,
      role: "user",
      contentJson: "raw-not-json",
      createdAtMs: 1,
    });
    await store.saveMessage({
      id: "recent-1",
      threadId: thread.threadId,
      role: "assistant",
      contentJson: JSON.stringify("recent one"),
      createdAtMs: 2,
    });
    await store.saveMessage({
      id: "recent-2",
      threadId: thread.threadId,
      role: "user",
      contentJson: JSON.stringify("recent two"),
      createdAtMs: 3,
    });

    await Summarizer(mockAgent).process(store);

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("user: raw-not-json");
  });
  test("no data-loss window: if the summary save fails the original messages survive", async () => {
    // Failure-injection against the real store: wrap it and make the summary
    // save fail. The delete-then-save ordering had a window where the old
    // messages were already gone when the summary write blew up, losing them
    // forever with no summary to replace them. The summary must be persisted
    // before (or atomically with) the delete so the originals are never lost.
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    const realStore = createMemoryStore(db);
    const thread = await realStore.createThread(WF_NS);
    const original = [
      [1, "user", "Can you check the rollout?"],
      [2, "assistant", "I will check it."],
      [3, "user", "Any update?"],
      [4, "assistant", "The rollout is healthy."],
    ];
    for (const [index, role, content] of original) {
      await realStore.saveMessage({
        id: `msg-${index}`,
        threadId: thread.threadId,
        role,
        contentJson: JSON.stringify(content),
        createdAtMs: index,
      });
    }

    // Real store everywhere except the summary write, which fails once.
    const failingStore = {
      ...realStore,
      saveMessageEffect: () => Effect.fail(new Error("summary write failed")),
    };
    const mockAgent = { run: async () => ({ text: "summary" }) };
    const summarizer = Summarizer(mockAgent);

    await expect(summarizer.process(failingStore)).rejects.toThrow();

    // Originals must still be present — never the gone-with-no-summary state.
    const surviving = await realStore.listMessages(thread.threadId);
    expect(surviving.map((m) => m.id)).toEqual(["msg-1", "msg-2", "msg-3", "msg-4"]);
  });
  test("recovers cleanly after a failed delete: no data lost and the summary chain converges", async () => {
    // With save-before-delete, a crash after the summary save but before the
    // delete leaves the summary + the originals coexisting (run1). Re-running
    // (run2) compresses the leftovers into a single summary and prunes them.
    // A third run is a stable no-op. The summary chain never grows unbounded
    // and no message is ever lost.
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    const realStore = createMemoryStore(db);
    const thread = await realStore.createThread(WF_NS);
    for (const [index, role, content] of [
      [1, "user", "Can you check the rollout?"],
      [2, "assistant", "I will check it."],
      [3, "user", "Any update?"],
      [4, "assistant", "The rollout is healthy."],
    ]) {
      await realStore.saveMessage({
        id: `msg-${index}`,
        threadId: thread.threadId,
        role,
        contentJson: JSON.stringify(content),
        createdAtMs: index,
      });
    }

    let calls = 0;
    // Real store except the delete fails on the first run (post-save crash).
    const flakyStore = {
      ...realStore,
      deleteMessagesEffect: (...args) => {
        calls += 1;
        if (calls === 1) {
          return Effect.fail(new Error("delete failed"));
        }
        return realStore.deleteMessagesEffect(...args);
      },
    };
    const summarizer = Summarizer({ run: async () => ({ text: "summary" }) });

    // Run 1: summary saved, delete fails → throws. No original is lost.
    await expect(summarizer.process(flakyStore)).rejects.toThrow();
    const afterRun1 = await realStore.listMessages(thread.threadId);
    expect(afterRun1.filter((m) => m.id.startsWith("msg-")).map((m) => m.id)).toEqual([
      "msg-1",
      "msg-2",
      "msg-3",
      "msg-4",
    ]);
    expect(afterRun1.filter((m) => m.role === "system")).toHaveLength(1);

    // Run 2: delete succeeds → old messages compressed into one summary.
    await summarizer.process(flakyStore);
    // Run 3: only the summary + recent messages remain → stable no-op.
    await summarizer.process(flakyStore);

    const final = await realStore.listMessages(thread.threadId);
    // Converges to exactly one summary followed by the two recent messages.
    expect(final.filter((m) => m.role === "system")).toHaveLength(1);
    expect(final.map((m) => m.id).filter((id) => id.startsWith("msg-"))).toEqual(["msg-3", "msg-4"]);
  });
});
