import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { __serverTestInternals } from "../src/index.js";

const { buildMirrorOnProgress } = __serverTestInternals;

function makeAdapter() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { adapter: new SmithersDb(db), sqlite };
}

/**
 * @template T
 * @param {() => Promise<T>} read
 * @param {(value: T) => boolean} done
 */
async function pollUntil(read, done, tries = 80, intervalMs = 25) {
  for (let i = 0; i < tries; i += 1) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return read();
}

describe("detached-run mirror approval projection", () => {
  test("projects ApprovalRequested into a pending row with request_json, then clears it on grant", async () => {
    const { adapter, sqlite } = makeAdapter();
    try {
      const runId = "mirror-approval-run";
      const onProgress = buildMirrorOnProgress(adapter, runId, "wf", "/wf.tsx", "{}");
      const ts = 1_000;

      // The detached run's mirror sees the node enter waiting-approval AND
      // the approval request event.
      onProgress({ type: "NodeWaitingApproval", runId, nodeId: "gate", iteration: 0, timestampMs: ts });
      onProgress({
        type: "ApprovalRequested",
        runId,
        nodeId: "gate",
        iteration: 0,
        request: { mode: "decision", options: ["ship", "hold"] },
        timestampMs: ts,
      });

      // Root-cause claim: the real approval row is reconstructed WITH its
      // request payload — not degraded to a bare gate via the fallback.
      const pending = await pollUntil(
        () => adapter.listPendingApprovals(runId),
        (rows) => rows.length === 1 && rows[0]?.requestJson != null,
      );
      expect(pending).toHaveLength(1);
      expect(String(pending[0].requestJson)).toContain("decision");
      expect(String(pending[0].requestJson)).toContain("ship");

      // A decision event flips the mirrored row out of pending.
      onProgress({ type: "ApprovalGranted", runId, nodeId: "gate", iteration: 0, timestampMs: ts + 1 });
      const afterGrant = await pollUntil(
        () => adapter.listPendingApprovals(runId),
        (rows) => rows.length === 0,
      );
      expect(afterGrant).toHaveLength(0);

      const decided = await adapter.getApproval(runId, "gate", 0);
      expect(decided?.status).toBe("approved");
      // The decision event carries no payload, so the projection preserved
      // the original request_json rather than nulling it.
      expect(String(decided?.requestJson)).toContain("decision");
    } finally {
      sqlite.close();
    }
  });
});
