import { describe, expect, test } from "bun:test";
import { SmithersDb } from "../src/adapter.js";
import { ensureSmithersTables } from "../src/ensure.js";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Effect } from "effect";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";

function createTestDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { adapter: new SmithersDb(db), sqlite };
}

/**
 * @param {SmithersDb} adapter
 * @param {string} steerId
 * @param {string} runId
 * @param {string} nodeId
 * @param {string} message
 * @param {number} createdAtMs
 */
function enqueue(adapter, steerId, runId, nodeId, message, createdAtMs) {
  return Effect.runPromise(adapter.enqueueSteer({ steerId, runId, nodeId, message, createdAtMs, author: "tester" }));
}

describe("steer adapter", () => {
  test("enqueueSteerWithEvent is atomic on event failure and idempotent on steer id", async () => {
    const { adapter } = createTestDb();
    const runId = "atomic-run";
    const row = {
      steerId: "atomic-steer",
      runId,
      nodeId: "task",
      message: "atomic",
      createdAtMs: 1000,
      author: "tester",
    };
    const event = {
      type: "SteerQueued",
      runId,
      nodeId: "task",
      steerId: row.steerId,
      message: row.message,
      author: row.author,
      timestampMs: row.createdAtMs,
    };
    const eventRow = {
      runId,
      timestampMs: row.createdAtMs,
      type: "SteerQueued",
      payloadJson: JSON.stringify(event),
    };
    await adapter.insertRun({ runId, workflowName: "steer-test", status: "running", createdAtMs: 1 });
    const originalInsertEvent = adapter.insertEventWithNextSeq.bind(adapter);
    adapter.insertEventWithNextSeq = () => Effect.fail(new SmithersError("DB_WRITE_FAILED", "event fault"));
    await expect(Effect.runPromise(adapter.enqueueSteerWithEvent(row, eventRow))).rejects.toThrow("event fault");
    expect(await Effect.runPromise(adapter.listSteers(runId))).toHaveLength(0);

    adapter.insertEventWithNextSeq = originalInsertEvent;
    expect(await Effect.runPromise(adapter.enqueueSteerWithEvent(row, eventRow))).toBe(true);
    expect(await Effect.runPromise(adapter.enqueueSteerWithEvent(row, eventRow))).toBe(false);
    expect(await Effect.runPromise(adapter.listSteers(runId))).toHaveLength(1);
    expect(await Effect.runPromise(adapter.listEventsByType(runId, "SteerQueued"))).toHaveLength(1);
  });

  test("enqueueSteerWithEvent hides the row from a concurrent consumer until the queued event commits", async () => {
    const { adapter: publisher, sqlite } = createTestDb();
    const consumer = new SmithersDb(drizzle(sqlite));
    const runId = "interleaving-run";
    await publisher.insertRun({ runId, workflowName: "steer-test", status: "running", createdAtMs: 1 });
    const row = {
      steerId: "interleaving-steer",
      runId,
      nodeId: "task",
      message: "interleaved",
      createdAtMs: 2000,
    };
    const eventRow = {
      runId,
      timestampMs: row.createdAtMs,
      type: "SteerQueued",
      payloadJson: JSON.stringify({
        type: "SteerQueued",
        runId,
        nodeId: row.nodeId,
        steerId: row.steerId,
        message: row.message,
        timestampMs: row.createdAtMs,
      }),
    };
    const originalInsertEvent = publisher.insertEventWithNextSeq.bind(publisher);
    let signalEventEntered;
    let releaseEvent;
    const eventEntered = new Promise((resolve) => {
      signalEventEntered = resolve;
    });
    const eventRelease = new Promise((resolve) => {
      releaseEvent = resolve;
    });
    publisher.insertEventWithNextSeq = (event) =>
      Effect.gen(function* () {
        signalEventEntered();
        yield* Effect.promise(() => eventRelease);
        return yield* originalInsertEvent(event);
      });

    const publication = Effect.runPromise(publisher.enqueueSteerWithEvent(row, eventRow));
    await eventEntered;
    let consumerSettled = false;
    const observation = Effect.runPromise(
      Effect.gen(function* () {
        const queued = yield* consumer.listQueuedSteers(runId, "task");
        const events = yield* consumer.listEventsByType(runId, "SteerQueued");
        return { queued, events };
      }),
    ).finally(() => {
      consumerSettled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(consumerSettled).toBe(false);
    releaseEvent();
    expect(await publication).toBe(true);
    const observed = await observation;
    expect(observed.queued).toHaveLength(1);
    expect(observed.events).toHaveLength(1);
  });

  test("enqueue + listQueuedSteers returns queued steers for a node, oldest first", async () => {
    const { adapter } = createTestDb();
    await enqueue(adapter, "n2", "run", "task", "second", 2000);
    await enqueue(adapter, "n1", "run", "task", "first", 1000);
    await enqueue(adapter, "n3", "run", "task", "third", 3000);
    const queued = await Effect.runPromise(adapter.listQueuedSteers("run", "task"));
    expect(queued.map((steer) => steer.message)).toEqual(["first", "second", "third"]);
    expect(queued[0].status).toBe("queued");
    expect(queued[0].author).toBe("tester");
  });

  test("listQueuedSteers isolates by run id and node id", async () => {
    const { adapter } = createTestDb();
    await enqueue(adapter, "a", "run-a", "task", "a", 1000);
    await enqueue(adapter, "b", "run-b", "task", "b", 1000);
    await enqueue(adapter, "c", "run-a", "other", "c", 1000);
    const queued = await Effect.runPromise(adapter.listQueuedSteers("run-a", "task"));
    expect(queued.map((steer) => steer.steerId)).toEqual(["a"]);
  });

  test("enqueue is idempotent on steer id", async () => {
    const { adapter } = createTestDb();
    await enqueue(adapter, "dup", "run", "task", "one", 1000);
    await enqueue(adapter, "dup", "run", "task", "two", 2000);
    const all = await Effect.runPromise(adapter.listSteers("run"));
    expect(all).toHaveLength(1);
    expect(all[0].message).toBe("one");
  });

  test("markSteerConsumed flips status once and records attribution", async () => {
    const { adapter } = createTestDb();
    await enqueue(adapter, "n1", "run", "task", "msg", 1000);
    await Effect.runPromise(
      adapter.markSteerConsumed("n1", { consumedAtMs: 5000, consumedByAttempt: 2, consumedByIteration: 1 }),
    );
    let all = await Effect.runPromise(adapter.listSteers("run"));
    expect(all[0].status).toBe("consumed");
    expect(all[0].consumedAtMs).toBe(5000);
    expect(all[0].consumedByAttempt).toBe(2);
    expect(all[0].consumedByIteration).toBe(1);
    expect(await Effect.runPromise(adapter.listQueuedSteers("run", "task"))).toHaveLength(0);

    // A second consume is a no-op (status guard); attribution is preserved.
    await Effect.runPromise(
      adapter.markSteerConsumed("n1", { consumedAtMs: 9000, consumedByAttempt: 9, consumedByIteration: 9 }),
    );
    all = await Effect.runPromise(adapter.listSteers("run"));
    expect(all[0].consumedByAttempt).toBe(2);
  });

  test("markSteerExpired flips a queued steer and cannot override a consumed one", async () => {
    const { adapter } = createTestDb();
    await enqueue(adapter, "q", "run", "task", "queued", 1000);
    await enqueue(adapter, "c", "run", "task", "consumed", 2000);
    await Effect.runPromise(
      adapter.markSteerConsumed("c", { consumedAtMs: 3000, consumedByAttempt: 1, consumedByIteration: 0 }),
    );

    await Effect.runPromise(adapter.markSteerExpired("q", 4000));
    await Effect.runPromise(adapter.markSteerExpired("c", 4000));

    const all = await Effect.runPromise(adapter.listSteers("run"));
    const byId = Object.fromEntries(all.map((steer) => [steer.steerId, steer]));
    expect(byId.q.status).toBe("expired");
    expect(byId.q.expiredAtMs).toBe(4000);
    // The consumed steer is untouched by expiry.
    expect(byId.c.status).toBe("consumed");
    expect(byId.c.expiredAtMs).toBeNull();
  });

  test("listSteers filters by node id and orders by creation time", async () => {
    const { adapter } = createTestDb();
    await enqueue(adapter, "n1", "run", "task", "one", 3000);
    await enqueue(adapter, "n2", "run", "task", "two", 1000);
    await enqueue(adapter, "n3", "run", "other", "three", 2000);
    const forTask = await Effect.runPromise(adapter.listSteers("run", { nodeId: "task" }));
    expect(forTask.map((steer) => steer.message)).toEqual(["two", "one"]);
    const all = await Effect.runPromise(adapter.listSteers("run"));
    expect(all).toHaveLength(3);
  });
});
