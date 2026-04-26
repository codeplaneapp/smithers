/**
 * Replay-edge tests covering frames-with-deleted-audit, out-of-range jumps,
 * out-of-order event commits, and replays that reference removed nodes.
 *
 * These exercise the *destructive* edges of `jumpToFrame` and the
 * deterministic-replay contract of the event log. Each test builds a fresh
 * in-memory SQLite via the same fixtures as `jumpToFrame.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { JumpToFrameError, jumpToFrame } from "../src/jumpToFrame.js";
import { listRewindAuditRows } from "../src/rewindAudit.js";

function setupDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS out_a (
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      iteration INTEGER NOT NULL,
      value INTEGER,
      PRIMARY KEY (run_id, node_id, iteration)
    );
  `);
  return { sqlite, adapter: new SmithersDb(db) };
}

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {number[]} frameNos
 */
async function seedFrames(adapter, runId, frameNos) {
  await adapter.insertRun({
    runId,
    workflowName: "wf",
    status: "finished",
    createdAtMs: 1,
    startedAtMs: 1,
    finishedAtMs: 999,
  });
  for (const n of frameNos) {
    await adapter.insertFrame({
      runId,
      frameNo: n,
      createdAtMs: 100 + n * 10,
      xmlJson: JSON.stringify({ kind: "element", frame: n }),
      xmlHash: `h${n}`,
      mountedTaskIdsJson: "[]",
      taskIndexJson: "[]",
      note: `f${n}`,
    });
  }
}

function noVcsHooks() {
  return {
    getCurrentPointerImpl: async () => "current-ptr",
    revertToPointerImpl: async () => ({ success: true }),
  };
}

describe("replay edges: jumpToFrame with sparse / missing frames", () => {
  test("jump to a frame whose intermediate frames have been deleted from the frames table — fails loudly", async () => {
    const { adapter, sqlite } = setupDb();
    try {
      // Frames 0, 1, 2, 5 exist (frames 3 and 4 were deleted out-of-band).
      await seedFrames(adapter, "run-sparse", [0, 1, 2, 5]);

      // Jumping to frame 3 must fail with FrameOutOfRange — the frame row is
      // gone, so the jump cannot reconstruct state. Crucially: it must not
      // succeed by silently picking a sibling frame.
      await expect(
        jumpToFrame({
          adapter,
          runId: "run-sparse",
          frameNo: 3,
          confirm: true,
          caller: "user:test",
          ...noVcsHooks(),
        }),
      ).rejects.toMatchObject({ code: "FrameOutOfRange" });

      // No frames mutated.
      const frames = await adapter.listFrames("run-sparse", 100);
      expect(frames.map((f) => f.frameNo).sort((a, b) => a - b)).toEqual([0, 1, 2, 5]);
    } finally {
      sqlite.close();
    }
  });

  test("jump from frame 5 -> frame 2 succeeds and truncates frames 3..5 even when 3,4 are missing", async () => {
    // This documents the contract: jumpToFrame deletes "frames after target"
    // by SQL — so a partially-pruned frame stream still gets cleaned.
    const { adapter, sqlite } = setupDb();
    try {
      await seedFrames(adapter, "run-skip", [0, 2, 5]);
      const result = await jumpToFrame({
        adapter,
        runId: "run-skip",
        frameNo: 2,
        confirm: true,
        caller: "user:test",
        ...noVcsHooks(),
      });
      expect(result.ok).toBe(true);
      expect(result.newFrameNo).toBe(2);
      const frames = await adapter.listFrames("run-skip", 100);
      expect(frames.map((f) => f.frameNo).sort((a, b) => a - b)).toEqual([0, 2]);
    } finally {
      sqlite.close();
    }
  });

  test("frameNo above the latest is FrameOutOfRange (not silently clamped)", async () => {
    const { adapter, sqlite } = setupDb();
    try {
      await seedFrames(adapter, "run-oob", [0, 1, 2]);
      await expect(
        jumpToFrame({
          adapter,
          runId: "run-oob",
          frameNo: 5,
          confirm: true,
          caller: "user:test",
          ...noVcsHooks(),
        }),
      ).rejects.toBeInstanceOf(JumpToFrameError);
    } finally {
      sqlite.close();
    }
  });
});

describe("replay edges: event log out-of-order commits", () => {
  test("replay reads events strictly by (run_id, seq) — out-of-order timestamp_ms does NOT corrupt the order", async () => {
    // The replay contract: events are ordered by `seq`, never by clock.
    // Insert events whose `timestamp_ms` is non-monotonic and verify that
    // listEventHistory still returns them in seq order — this is the
    // determinism guarantee.
    const { adapter, sqlite } = setupDb();
    try {
      await adapter.insertRun({
        runId: "ooo-run",
        workflowName: "wf",
        status: "running",
        createdAtMs: 1,
      });
      // Frame 5 commits at t=100 (early), frame 3 at t=900 (late).
      const client = sqlite;
      const stmt = client.query(
        `INSERT INTO _smithers_events (run_id, seq, timestamp_ms, type, payload_json)
         VALUES (?, ?, ?, ?, ?)`,
      );
      stmt.run("ooo-run", 0, 500, "FrameCommitted", JSON.stringify({ frameNo: 0 }));
      stmt.run("ooo-run", 1, 600, "FrameCommitted", JSON.stringify({ frameNo: 1 }));
      stmt.run("ooo-run", 2, 700, "FrameCommitted", JSON.stringify({ frameNo: 2 }));
      // Frame 5 ostensibly committed BEFORE frame 3 in wall-clock time but
      // got assigned a later seq — replay must follow seq.
      stmt.run("ooo-run", 3, 900, "FrameCommitted", JSON.stringify({ frameNo: 3 }));
      stmt.run("ooo-run", 4, 800, "FrameCommitted", JSON.stringify({ frameNo: 4 }));
      stmt.run("ooo-run", 5, 100, "FrameCommitted", JSON.stringify({ frameNo: 5 }));

      const events = await adapter.listEventHistory("ooo-run", { limit: 50 });
      expect(events.map((e) => Number(e.seq))).toEqual([0, 1, 2, 3, 4, 5]);
      expect(events.map((e) => JSON.parse(e.payloadJson).frameNo)).toEqual([
        0, 1, 2, 3, 4, 5,
      ]);
    } finally {
      sqlite.close();
    }
  });

  test("getLastEventSeq reflects the highest seq, not the latest timestamp", async () => {
    const { adapter, sqlite } = setupDb();
    try {
      await adapter.insertRun({
        runId: "seq-run",
        workflowName: "wf",
        status: "running",
        createdAtMs: 1,
      });
      const stmt = sqlite.query(
        `INSERT INTO _smithers_events (run_id, seq, timestamp_ms, type, payload_json)
         VALUES (?, ?, ?, ?, ?)`,
      );
      stmt.run("seq-run", 0, 9_000, "A", "{}");
      stmt.run("seq-run", 1, 100, "B", "{}");
      stmt.run("seq-run", 2, 5_000, "C", "{}");
      const last = await adapter.getLastEventSeq("seq-run");
      expect(Number(last)).toBe(2);
    } finally {
      sqlite.close();
    }
  });

  test("inserting a duplicate (run_id, seq) is rejected — no silent clobber", async () => {
    const { adapter, sqlite } = setupDb();
    try {
      await adapter.insertRun({
        runId: "dup-evt-run",
        workflowName: "wf",
        status: "running",
        createdAtMs: 1,
      });
      sqlite
        .query(
          `INSERT INTO _smithers_events (run_id, seq, timestamp_ms, type, payload_json)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run("dup-evt-run", 0, 1, "X", "{}");
      expect(() =>
        sqlite
          .query(
            `INSERT INTO _smithers_events (run_id, seq, timestamp_ms, type, payload_json)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run("dup-evt-run", 0, 2, "Y", "{}"),
      ).toThrow(/UNIQUE|PRIMARY/i);
    } finally {
      sqlite.close();
    }
  });
});

describe("replay edges: referenced node has been removed", () => {
  test("listEventHistory filtered by a nodeId whose row has been deleted still returns the historic events", async () => {
    // Contract: the event log is the source of truth; deleting a node from
    // _smithers_nodes does not retroactively remove its events. A replay
    // therefore observes the historical reference and can decide what to do.
    const { adapter, sqlite } = setupDb();
    try {
      await adapter.insertRun({
        runId: "ghost-node-run",
        workflowName: "wf",
        status: "running",
        createdAtMs: 1,
      });
      await adapter.insertNode({
        runId: "ghost-node-run",
        nodeId: "ghost",
        iteration: 0,
        state: "finished",
        updatedAtMs: 100,
        outputTable: "out_a",
      });
      sqlite
        .query(
          `INSERT INTO _smithers_events (run_id, seq, timestamp_ms, type, payload_json)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          "ghost-node-run",
          0,
          100,
          "NodeStarted",
          JSON.stringify({ runId: "ghost-node-run", nodeId: "ghost" }),
        );

      // Remove the node — simulate a workflow edit that dropped it.
      sqlite
        .query(`DELETE FROM _smithers_nodes WHERE run_id = ? AND node_id = ?`)
        .run("ghost-node-run", "ghost");

      const events = await adapter.listEventHistory("ghost-node-run", {
        nodeId: "ghost",
        limit: 10,
      });
      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0].payloadJson).nodeId).toBe("ghost");

      // And the node row really is gone — the test exercises the divergence.
      const node = sqlite
        .query(`SELECT node_id FROM _smithers_nodes WHERE run_id = ? AND node_id = ?`)
        .get("ghost-node-run", "ghost");
      expect(node).toBeNull();
    } finally {
      sqlite.close();
    }
  });
});

describe("replay edges: audit table tampering", () => {
  test("deleting audit rows out-of-band does not stop a future jump (audit is append-only, not gating)", async () => {
    // The audit table is informational and rate-limit input — it does NOT
    // block a jump if rows are missing. We document that contract here so a
    // future change that gates jumps on audit history is caught.
    const { adapter, sqlite } = setupDb();
    try {
      await seedFrames(adapter, "run-tamper", [0, 1, 2]);
      // Pretend a prior jump's audit row got deleted.
      sqlite.run(`DELETE FROM _smithers_time_travel_audit WHERE 1=1`);

      const result = await jumpToFrame({
        adapter,
        runId: "run-tamper",
        frameNo: 1,
        confirm: true,
        caller: "user:test",
        ...noVcsHooks(),
      });
      expect(result.ok).toBe(true);

      const audits = await listRewindAuditRows(adapter, { runId: "run-tamper" });
      // Exactly the audit row from this jump (the in-progress row was
      // updated to terminal state in-place).
      expect(audits).toHaveLength(1);
      expect(audits[0].result).toBe("success");
    } finally {
      sqlite.close();
    }
  });
});
