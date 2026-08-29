import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ensureSmithersTables } from "@smthrs/db/ensure";
import { SmithersDb } from "@smthrs/db/adapter";
import { __serverTestInternals } from "../src/index.js";

const { buildMirrorOnProgress } = __serverTestInternals;

describe("detached-run mirror cancellation projection", () => {
  test("projects RunCancelled source into the terminal run row", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    const adapter = new SmithersDb(db);
    try {
      const runId = "mirror-cancelled-run";
      const onProgress = buildMirrorOnProgress(adapter, runId, "wf", "/wf.tsx", "{}");
      onProgress({
        type: "RunCancelled",
        runId,
        timestampMs: 1_000,
        source: {
          kind: "signal",
          detail: "worker received SIGTERM",
          signal: "SIGTERM",
          clientPid: 4321,
          requestId: "shutdown-1",
          clientIdentity: "operator",
        },
      });

      let row;
      for (let attempt = 0; attempt < 80; attempt += 1) {
        row = await adapter.getRun(runId);
        if (row?.status === "cancelled") break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(row).toMatchObject({
        status: "cancelled",
        cancelRequestSource: "signal",
        cancelRequestDetail: "worker received SIGTERM",
        cancelRequestSignal: "SIGTERM",
        cancelRequestClientPid: 4321,
        cancelRequestId: "shutdown-1",
        cancelRequestClientIdentity: "operator",
      });
    } finally {
      sqlite.close();
    }
  });
});
