/**
 * Regression tests for EventBus on-disk NDJSON persistence (persistLog).
 *
 * Covers two fixes from fix/engine-events-append-and-error:
 *
 *   1. persistLog must APPEND each event as one NDJSON line. The previous
 *      implementation read the whole file and rewrote it on every event
 *      (readFile + writeFile of prefix + line). That is O(n^2), and any
 *      concurrent/interleaved write could clobber earlier lines. The fix
 *      uses appendFile so emitting N events yields exactly N lines, in order.
 *
 *   2. A single queued-persist failure must only surface ONCE (via flush),
 *      not twice. The previous enqueuePersist returned the raw rejecting
 *      task while ALSO stashing the error in persistError, so the same
 *      failure rejected emitEventQueued AND threw again on the next flush.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { EventBus } from "../src/events.js";

/**
 * @param {Partial<SmithersEvent>} [overrides]
 * @returns {SmithersEvent}
 */
function makeEvent(overrides) {
  return {
    type: "RunStarted",
    runId: "run-append",
    timestampMs: 1_000,
    ...overrides,
  };
}

describe("EventBus persistLog append", () => {
  test("appends every event as its own NDJSON line, in order, across many emits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-events-append-"));
    try {
      const logDir = join(dir, "events");
      const bus = new EventBus({ logDir });

      const N = 25;
      for (let i = 0; i < N; i += 1) {
        await Effect.runPromise(
          bus.emitEventWithPersist(
            makeEvent({ seq: i, timestampMs: 1_000 + i }),
          ),
        );
      }

      const logFile = join(logDir, "stream.ndjson");
      const contents = readFileSync(logFile, "utf8");

      // Exactly N lines, no leading/extra blank lines, trailing newline only.
      const lines = contents.split("\n");
      expect(lines[lines.length - 1]).toBe("");
      const jsonLines = lines.slice(0, -1);
      expect(jsonLines).toHaveLength(N);

      // Content correctness: every line is valid JSON and seqs are 0..N-1
      // in append order. A full-rewrite-per-event bug would still produce
      // ordered seqs, but the next assertion (no clobbering / exact count)
      // is what a clobbering rewrite would break.
      const parsed = jsonLines.map((line) => JSON.parse(line));
      expect(parsed.map((e) => e.seq)).toEqual(
        Array.from({ length: N }, (_, i) => i),
      );
      for (const event of parsed) {
        expect(event.type).toBe("RunStarted");
        expect(event.runId).toBe("run-append");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("concurrent persists do not clobber lines (append, not read-modify-write)", async () => {
    // emitEventWithPersist runs persist() directly with no queue
    // serialization, so firing many in parallel exercises overlapping
    // writes. The old read+rewrite implementation has a read-modify-write
    // race: two persists read the same prefix, then both writeFile, and
    // one line is lost. appendFile is atomic per write, so all lines land.
    const dir = mkdtempSync(join(tmpdir(), "smithers-events-concurrent-"));
    try {
      const logDir = join(dir, "events");
      const bus = new EventBus({ logDir });

      const N = 30;
      await Promise.all(
        Array.from({ length: N }, (_, i) =>
          Effect.runPromise(
            bus.emitEventWithPersist(
              makeEvent({ seq: i, timestampMs: 1_000 + i }),
            ),
          ),
        ),
      );

      const logFile = join(logDir, "stream.ndjson");
      const jsonLines = readFileSync(logFile, "utf8").split("\n").slice(0, -1);

      // No lines lost to clobbering: exactly N, every seq present once.
      expect(jsonLines).toHaveLength(N);
      const seqs = jsonLines.map((line) => JSON.parse(line).seq).sort(
        (a, b) => a - b,
      );
      expect(seqs).toEqual(Array.from({ length: N }, (_, i) => i));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("appends (does not rewrite) when interleaving emits with reads", async () => {
    // This is the scenario the read+rewrite implementation could corrupt:
    // if persist were not a pure append, a write happening while earlier
    // content existed could drop previously-written lines. We assert the
    // file only ever GROWS and every previously-seen line is still present.
    const dir = mkdtempSync(join(tmpdir(), "smithers-events-grow-"));
    try {
      const logDir = join(dir, "events");
      const bus = new EventBus({ logDir });
      const logFile = join(logDir, "stream.ndjson");

      let lastSize = 0;
      const seen = [];
      for (let i = 0; i < 10; i += 1) {
        await Effect.runPromise(
          bus.emitEventWithPersist(
            makeEvent({ seq: i, timestampMs: 1_000 + i }),
          ),
        );
        const contents = readFileSync(logFile, "utf8");
        // File must be strictly growing — never truncated/rewritten smaller.
        expect(contents.length).toBeGreaterThan(lastSize);
        lastSize = contents.length;

        // Every line we have ever seen must still be present, in order.
        const jsonLines = contents.split("\n").slice(0, -1);
        seen.push(jsonLines[jsonLines.length - 1]);
        expect(jsonLines).toEqual(seen);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("EventBus queued persist failure surfaces once", () => {
  test("a single failing queued persist rejects exactly once via flush, not twice", async () => {
    // Force persistDb to fail so the error propagates through enqueuePersist.
    const failingDb = {
      insertEventEffect: () => {
        throw new Error("boom-persist");
      },
    };
    const bus = new EventBus({ db: failingDb });

    // emitEventQueued must NOT reject — the fix routes through the settled
    // promise. (Old behavior: emitEventQueued rejected here = surface #1.)
    let queuedRejected = false;
    try {
      await bus.emitEventQueued(makeEvent({ seq: 0 }));
    } catch {
      queuedRejected = true;
    }
    expect(queuedRejected).toBe(false);

    // flush surfaces the captured error exactly once.
    let firstFlushError;
    try {
      await Effect.runPromise(bus.flush());
    } catch (error) {
      firstFlushError = error;
    }
    expect(firstFlushError).toBeDefined();

    // A subsequent flush must NOT throw again — persistError was cleared,
    // so the same failure cannot be surfaced a second time.
    let secondFlushThrew = false;
    try {
      await Effect.runPromise(bus.flush());
    } catch {
      secondFlushThrew = true;
    }
    expect(secondFlushThrew).toBe(false);
  });
});
