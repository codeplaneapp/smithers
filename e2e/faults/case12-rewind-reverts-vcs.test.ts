import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { jumpToFrame } from "@smithers-orchestrator/time-travel/jumpToFrame";
import { listRewindAuditRows } from "@smithers-orchestrator/time-travel/rewindAudit";
import { resetRewindLocksForTests } from "@smithers-orchestrator/time-travel/rewindLock";

const RUN_ID = "case12-run";
const REWIND_TO_FRAME = 2;
const WRITER_NODE_ID = "task:writer";
const WRITER_CWD = "/tmp/case12-writer";

type RevertCall = {
  pointer: string;
  cwd?: string;
};

type FrameRow = {
  frame_no: number;
  xml_json: string;
};

type EventRow = {
  seq: number;
  type: string;
  payload_json: string;
};

type NodeRow = {
  state: string;
  last_attempt: number | null;
};

function buildDb(): { sqlite: Database; adapter: SmithersDb } {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS out_writer (
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      iteration INTEGER NOT NULL,
      value TEXT,
      PRIMARY KEY (run_id, node_id, iteration)
    );
  `);
  return { sqlite, adapter: new SmithersDb(db) };
}

async function seedRun(adapter: SmithersDb, sqlite: Database): Promise<void> {
  await adapter.insertRun({
    runId: RUN_ID,
    workflowName: "case12-workflow",
    status: "running",
    createdAtMs: 1_000,
    startedAtMs: 1_000,
    heartbeatAtMs: 1_500,
    runtimeOwnerId: "worker:case12",
    vcsType: "jj",
    vcsRoot: "/tmp/case12",
    vcsRevision: "live-before-rewind",
  });

  for (let frameNo = 0; frameNo <= 5; frameNo += 1) {
    await adapter.insertFrame({
      runId: RUN_ID,
      frameNo,
      createdAtMs: 1_000 + frameNo * 100,
      xmlJson: JSON.stringify({ frame: frameNo, payload: `state-at-${frameNo}` }),
      xmlHash: `hash-${frameNo}`,
    });
    await adapter.insertEventWithNextSeq({
      runId: RUN_ID,
      timestampMs: 1_000 + frameNo * 100,
      type: "FrameAdvanced",
      payloadJson: JSON.stringify({ frameNo }),
    });
  }

  await adapter.insertNode({
    runId: RUN_ID,
    nodeId: WRITER_NODE_ID,
    iteration: 0,
    state: "finished",
    lastAttempt: 2,
    updatedAtMs: 1_600,
    outputTable: "out_writer",
    label: "writer",
  });
  await adapter.insertAttempt({
    runId: RUN_ID,
    nodeId: WRITER_NODE_ID,
    iteration: 0,
    attempt: 0,
    state: "finished",
    startedAtMs: 1_050,
    finishedAtMs: 1_075,
    jjPointer: "rev-frame-1",
    jjCwd: WRITER_CWD,
  });
  await adapter.insertAttempt({
    runId: RUN_ID,
    nodeId: WRITER_NODE_ID,
    iteration: 0,
    attempt: 1,
    state: "finished",
    startedAtMs: 1_150,
    finishedAtMs: 1_175,
    jjPointer: "rev-frame-2",
    jjCwd: WRITER_CWD,
  });
  await adapter.insertAttempt({
    runId: RUN_ID,
    nodeId: WRITER_NODE_ID,
    iteration: 0,
    attempt: 2,
    state: "finished",
    startedAtMs: 1_350,
    finishedAtMs: 1_375,
    jjPointer: "rev-frame-5",
    jjCwd: WRITER_CWD,
  });

  sqlite
    .query(
      `INSERT INTO _smithers_node_diffs
         (run_id, node_id, iteration, base_ref, diff_json, computed_at_ms, size_bytes)
       VALUES (?, ?, 0, ?, ?, ?, ?)`,
    )
    .run(RUN_ID, WRITER_NODE_ID, "base-before", JSON.stringify({ at: 1 }), 1_180, 8);
  sqlite
    .query(
      `INSERT INTO _smithers_node_diffs
         (run_id, node_id, iteration, base_ref, diff_json, computed_at_ms, size_bytes)
       VALUES (?, ?, 0, ?, ?, ?, ?)`,
    )
    .run(RUN_ID, WRITER_NODE_ID, "base-after", JSON.stringify({ at: 5 }), 1_380, 8);
  sqlite
    .query(
      `INSERT INTO out_writer (run_id, node_id, iteration, value)
       VALUES (?, ?, 0, ?)`,
    )
    .run(RUN_ID, WRITER_NODE_ID, "post-frame-2-output");
}

async function listFrameNos(adapter: SmithersDb): Promise<number[]> {
  const frames = await adapter.listFrames(RUN_ID, 20);
  return frames.map((frame) => frame.frameNo).sort((a, b) => a - b);
}

describe("case 12: rewind reverts VCS, subsequent frames reflect rewound state, audit entry exists", () => {
  test("real jumpToFrame rolls back state, reverts VCS pointer, writes audit row and event", async () => {
    resetRewindLocksForTests();
    const { sqlite, adapter } = buildDb();
    try {
      await seedRun(adapter, sqlite);

      expect(await listFrameNos(adapter)).toEqual([0, 1, 2, 3, 4, 5]);
      const attemptsBefore = await adapter.listAttempts(RUN_ID, WRITER_NODE_ID, 0);
      expect(attemptsBefore.map((attempt) => attempt.attempt).sort()).toEqual([0, 1, 2]);

      const revertCalls: RevertCall[] = [];
      const result = await jumpToFrame({
        adapter,
        runId: RUN_ID,
        frameNo: REWIND_TO_FRAME,
        confirm: true,
        caller: "user:owner",
        nowMs: () => 9_000,
        getCurrentPointerImpl: async (cwd?: string) => `live:${cwd ?? ""}`,
        revertToPointerImpl: async (pointer: string, cwd?: string) => {
          revertCalls.push({ pointer, cwd });
          return { success: true };
        },
      });

      expect(result).toMatchObject({
        ok: true,
        newFrameNo: REWIND_TO_FRAME,
        revertedSandboxes: 1,
        deletedFrames: 3,
        deletedAttempts: 1,
      });
      expect(revertCalls).toEqual([{ pointer: "rev-frame-2", cwd: WRITER_CWD }]);

      const run = await adapter.getRun(RUN_ID);
      expect(run?.status).toBe("running");
      expect(run?.runtimeOwnerId).toBeNull();
      expect(run?.heartbeatAtMs).toBeNull();

      expect(await listFrameNos(adapter)).toEqual([0, 1, 2]);
      const remainingAttempts = await adapter.listAttempts(RUN_ID, WRITER_NODE_ID, 0);
      expect(remainingAttempts.map((attempt) => attempt.attempt).sort()).toEqual([0, 1]);

      const node = sqlite
        .query("SELECT state, last_attempt FROM _smithers_nodes WHERE run_id = ? AND node_id = ?")
        .get(RUN_ID, WRITER_NODE_ID) as NodeRow;
      expect(node.state).toBe("pending");
      expect(node.last_attempt).toBeNull();

      const outputCount = sqlite
        .query("SELECT COUNT(*) AS count FROM out_writer WHERE run_id = ?")
        .get(RUN_ID) as { count: number };
      expect(outputCount.count).toBe(0);

      const diffCount = sqlite
        .query("SELECT COUNT(*) AS count FROM _smithers_node_diffs WHERE run_id = ?")
        .get(RUN_ID) as { count: number };
      expect(diffCount.count).toBe(0);

      const audits = await listRewindAuditRows(adapter, { runId: RUN_ID });
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        runId: RUN_ID,
        fromFrameNo: 5,
        toFrameNo: REWIND_TO_FRAME,
        caller: "user:owner",
        result: "success",
        durationMs: 0,
      });

      const events = sqlite
        .query("SELECT seq, type, payload_json FROM _smithers_events WHERE run_id = ? ORDER BY seq ASC")
        .all(RUN_ID) as EventRow[];
      expect(events.map((event) => event.type)).toEqual([
        "FrameAdvanced",
        "FrameAdvanced",
        "FrameAdvanced",
        "FrameAdvanced",
        "FrameAdvanced",
        "FrameAdvanced",
        "TimeTravelJumped",
      ]);
      expect(JSON.parse(events.at(-1)?.payload_json ?? "{}")).toMatchObject({
        runId: RUN_ID,
        fromFrameNo: 5,
        toFrameNo: REWIND_TO_FRAME,
        caller: "user:owner",
      });
    } finally {
      sqlite.close();
      resetRewindLocksForTests();
    }
  });

  test("subsequent real frames after rewind continue from K+1", async () => {
    resetRewindLocksForTests();
    const { sqlite, adapter } = buildDb();
    try {
      await seedRun(adapter, sqlite);
      await jumpToFrame({
        adapter,
        runId: RUN_ID,
        frameNo: REWIND_TO_FRAME,
        confirm: true,
        caller: "user:owner",
        nowMs: () => 9_000,
        getCurrentPointerImpl: async () => "live",
        revertToPointerImpl: async () => ({ success: true }),
      });

      const nextFrameNo = REWIND_TO_FRAME + 1;
      await adapter.insertFrame({
        runId: RUN_ID,
        frameNo: nextFrameNo,
        createdAtMs: 10_000,
        xmlJson: JSON.stringify({ frame: nextFrameNo, payload: "post-rewind" }),
        xmlHash: `hash-${nextFrameNo}-post`,
      });

      const frames = sqlite
        .query(
          "SELECT frame_no, xml_json FROM _smithers_frames WHERE run_id = ? ORDER BY frame_no ASC",
        )
        .all(RUN_ID) as FrameRow[];
      expect(frames.map((row) => row.frame_no)).toEqual([0, 1, 2, 3]);
      const tail = frames.at(-1);
      expect(tail?.frame_no).toBe(nextFrameNo);
      expect(JSON.parse(tail?.xml_json ?? "{}")).toMatchObject({
        frame: nextFrameNo,
        payload: "post-rewind",
      });

      const audits = await listRewindAuditRows(adapter, { runId: RUN_ID });
      expect(audits).toHaveLength(1);
    } finally {
      sqlite.close();
      resetRewindLocksForTests();
    }
  });

  test("audit entry exists for every real rewind invocation", async () => {
    resetRewindLocksForTests();
    const { sqlite, adapter } = buildDb();
    try {
      await seedRun(adapter, sqlite);

      await jumpToFrame({
        adapter,
        runId: RUN_ID,
        frameNo: 4,
        confirm: true,
        caller: "user:first",
        nowMs: () => 8_000,
        getCurrentPointerImpl: async () => "live-first",
        revertToPointerImpl: async () => ({ success: true }),
      });
      await jumpToFrame({
        adapter,
        runId: RUN_ID,
        frameNo: 1,
        confirm: true,
        caller: "user:second",
        nowMs: () => 9_000,
        getCurrentPointerImpl: async () => "live-second",
        revertToPointerImpl: async () => ({ success: true }),
      });

      const audits = await listRewindAuditRows(adapter, { runId: RUN_ID });
      expect(audits).toHaveLength(2);
      expect(audits[0]).toMatchObject({
        fromFrameNo: 5,
        toFrameNo: 4,
        caller: "user:first",
        result: "success",
      });
      expect(audits[1]).toMatchObject({
        fromFrameNo: 4,
        toFrameNo: 1,
        caller: "user:second",
        result: "success",
      });
      expect(await listFrameNos(adapter)).toEqual([0, 1]);
    } finally {
      sqlite.close();
      resetRewindLocksForTests();
    }
  });
});
