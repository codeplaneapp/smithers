import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { SmithersDb } from "@smthrs/db/adapter";
import { ensureSmithersTables } from "@smthrs/db/ensure";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { createNodeRuntime } from "../src/node-runtime.js";

describe("createNodeRuntime signals capability", () => {
  test("omits the signals capability when no adapter is supplied", () => {
    const runtime = createNodeRuntime();
    expect(runtime.signals).toBeUndefined();
  });

  test("load() reads real durable _smithers_signals rows in seq order with parsed payload", async () => {
    const { db, cleanup } = createTestSmithers({});
    try {
      ensureSmithersTables(db);
      const adapter = new SmithersDb(db);
      const runId = "run-signals-1";
      await adapter.insertRun({ runId, workflowName: "wf", status: "running", input: {} });
      await Effect.runPromise(
        adapter.insertSignalWithNextSeq({
          runId,
          signalName: "REVISE",
          correlationId: null,
          payloadJson: JSON.stringify({ feedback: "first" }),
          receivedAtMs: 1000,
          receivedBy: null,
        }),
      );
      await Effect.runPromise(
        adapter.insertSignalWithNextSeq({
          runId,
          signalName: "REVISE",
          correlationId: "waiter-a",
          payloadJson: JSON.stringify({ feedback: "second" }),
          receivedAtMs: 2000,
          receivedBy: null,
        }),
      );

      const runtime = createNodeRuntime({ adapter });
      expect(typeof runtime.signals?.load).toBe("function");
      const rows = await runtime.signals.load(runId);
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.seq)).toEqual(rows.map((r) => r.seq).sort((a, b) => a - b));
      expect(rows[0].signalName).toBe("REVISE");
      expect(typeof rows[0].payloadJson).toBe("string");
      expect(JSON.parse(rows[0].payloadJson)).toEqual({ feedback: "first" });
      expect(rows[1].correlationId).toBe("waiter-a");
    } finally {
      await cleanup();
    }
  });
});
