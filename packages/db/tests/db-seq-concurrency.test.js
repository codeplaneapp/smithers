/**
 * The event/signal sequence numbers are the ordering backbone every consumer
 * depends on: deterministic replay, live-stream tailing, and reconnect-after-seq.
 * `insertEventWithNextSeq`/`insertSignalWithNextSeq` must allocate a gapless,
 * monotonic, collision-free seq even when many writers race on one run — a
 * dropped or duplicated seq silently corrupts the durable log. These tests pin
 * that invariant on the bun:sqlite path (BEGIN IMMEDIATE + transaction turn).
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Effect, Fiber } from "effect";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "../src/adapter.js";
import { ensureSmithersTables } from "../src/ensure.js";

function createAdapter() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return new SmithersDb(db);
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const tick = () => new Promise((res) => setTimeout(res, 0));

function raceWithTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

const RUN = "race-run";

async function seedRun(adapter) {
  await adapter.insertRun({
    runId: RUN,
    workflowName: "wf",
    status: "running",
    createdAtMs: Date.now(),
  });
}

describe("event seq allocation under concurrency (bun:sqlite)", () => {
  test("50 concurrent insertEventWithNextSeq produce seqs 0..49 with no drops or dups", async () => {
    const adapter = createAdapter();
    await seedRun(adapter);
    const N = 50;
    const seqs = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        adapter.insertEventWithNextSeq({
          runId: RUN,
          timestampMs: 1000 + i,
          type: "test.event",
          payloadJson: JSON.stringify({ i }),
        }),
      ),
    );
    const sorted = [...seqs].sort((a, b) => a - b);
    expect(sorted).toEqual(Array.from({ length: N }, (_, i) => i));
    expect(new Set(seqs).size).toBe(N); // no two writers got the same seq
    expect(await adapter.getLastEventSeq(RUN)).toBe(N - 1);
    const history = await adapter.listEventHistory(RUN, { limit: N * 2 });
    expect(history.length).toBe(N); // no event silently dropped
  });

  test("re-inserting an identical event returns the same seq (replay dedup)", async () => {
    const adapter = createAdapter();
    await seedRun(adapter);
    const row = {
      runId: RUN,
      timestampMs: 5,
      type: "dup",
      payloadJson: JSON.stringify({ x: 1 }),
    };
    const first = await adapter.insertEventWithNextSeq(row);
    const second = await adapter.insertEventWithNextSeq(row);
    expect(second).toBe(first);
    const history = await adapter.listEventHistory(RUN, { limit: 100 });
    expect(history.length).toBe(1);
  });

  test("20 concurrent identical insertEventWithNextSeq calls dedupe to seq 0", async () => {
    const adapter = createAdapter();
    await seedRun(adapter);
    const row = {
      runId: RUN,
      timestampMs: 1234,
      type: "dup.concurrent",
      payloadJson: JSON.stringify({ x: 1 }),
    };

    const seqs = await Promise.all(
      Array.from({ length: 20 }, () => adapter.insertEventWithNextSeq(row)),
    );

    expect(seqs).toEqual(Array.from({ length: 20 }, () => 0));
    const history = await adapter.listEventHistory(RUN, { limit: 50 });
    expect(history.length).toBe(1);
    expect(await adapter.getLastEventSeq(RUN)).toBe(0);
  });
});

describe("signal seq allocation under concurrency (bun:sqlite)", () => {
  test("40 concurrent insertSignalWithNextSeq produce seqs 0..39 with no drops", async () => {
    const adapter = createAdapter();
    await seedRun(adapter);
    const N = 40;
    const seqs = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        adapter.insertSignalWithNextSeq({
          runId: RUN,
          signalName: "sig",
          correlationId: `c-${i}`,
          payloadJson: JSON.stringify({ i }),
          receivedAtMs: 2000 + i,
        }),
      ),
    );
    const sorted = [...seqs].sort((a, b) => a - b);
    expect(sorted).toEqual(Array.from({ length: N }, (_, i) => i));
    expect(new Set(seqs).size).toBe(N);
    expect(await adapter.getLastSignalSeq(RUN)).toBe(N - 1);
  });

  test("re-inserting an identical signal returns the same seq (replay dedup)", async () => {
    const adapter = createAdapter();
    await seedRun(adapter);
    const row = {
      runId: RUN,
      signalName: "sig",
      correlationId: "c-dup",
      payloadJson: JSON.stringify({ x: 1 }),
      receivedAtMs: 9,
    };
    const first = await adapter.insertSignalWithNextSeq(row);
    const second = await adapter.insertSignalWithNextSeq(row);
    expect(second).toBe(first);
  });

  test("20 concurrent identical insertSignalWithNextSeq calls dedupe to seq 0", async () => {
    const adapter = createAdapter();
    await seedRun(adapter);
    const row = {
      runId: RUN,
      signalName: "sig",
      correlationId: null,
      payloadJson: JSON.stringify({ x: 1 }),
      receivedAtMs: 9,
      receivedBy: undefined,
    };

    const seqs = await Promise.all(
      Array.from({ length: 20 }, () => adapter.insertSignalWithNextSeq(row)),
    );

    expect(seqs).toEqual(Array.from({ length: 20 }, () => 0));
    const signals = await adapter.listSignals(RUN, { limit: 50 });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.seq).toBe(0);
    expect(signals[0]?.receivedBy).toBeNull();
    expect(await adapter.getLastSignalSeq(RUN)).toBe(0);
  });
});

// Regression guard for the transaction-turn interrupt/deadlock fix. The turn is
// acquired via Effect.acquireUseRelease so its release runs whenever acquire
// succeeded — a fiber interrupted while queued behind, or while holding, the
// turn must never leak it. A leaked turn permanently deadlocks every later DB op
// on the client, so each case asserts a subsequent write still completes.
describe("transaction turn interruption (bun:sqlite)", () => {
  test("interrupting a queued write releases the turn so later writes still complete", async () => {
    const adapter = createAdapter();
    await seedRun(adapter);

    // Turn #1: holds the turn until the latch resolves.
    const latch = deferred();
    const holder = Effect.runFork(
      adapter.write("hold-turn", () => latch.promise),
    );
    await tick();

    // Turn #2: queues behind #1, then is interrupted while still queued.
    const queued = Effect.runFork(
      adapter.write("queued", () => Promise.resolve("queued")),
    );
    await tick();
    const interrupted = Effect.runPromise(Fiber.interrupt(queued));
    await tick();

    // Releasing #1 must hand the turn off cleanly even though #2 was interrupted
    // mid-queue; #2's release still fires, so the chain keeps advancing.
    latch.resolve("first");
    // Join the successful holder directly; this keeps the same synchronization
    // point without relying on the keyword-named Fiber.await export.
    await Effect.runPromise(Fiber.join(holder));
    await interrupted;

    const later = await raceWithTimeout(
      Effect.runPromise(adapter.write("after", () => Promise.resolve("done"))),
      3000,
      "later write deadlocked: transaction turn leaked",
    );
    expect(later).toBe("done");
  });

  test("interrupting a write that holds the turn releases it for later writes", async () => {
    const adapter = createAdapter();
    await seedRun(adapter);

    // A write whose operation is in flight owns the turn; interrupt it there.
    const latch = deferred();
    const running = Effect.runFork(
      adapter.write("running", () => latch.promise),
    );
    await tick();
    await Effect.runPromise(Fiber.interrupt(running));

    const later = await raceWithTimeout(
      Effect.runPromise(adapter.write("after", () => Promise.resolve("done"))),
      3000,
      "later write deadlocked: transaction turn leaked",
    );
    expect(later).toBe("done");
    latch.resolve("unblock");
  });
});
