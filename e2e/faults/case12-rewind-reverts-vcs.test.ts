import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

const RUN_ID = "case12-run";
const REWIND_TO_FRAME = 2;

type FrameRow = {
  run_id: string;
  frame_no: number;
  xml_json: string;
  vcs_revision: string;
};

type NodeRow = {
  run_id: string;
  node_id: string;
  iteration: number;
  state: string;
  last_attempt: number | null;
  updated_at_ms: number;
};

type EventRow = {
  run_id: string;
  seq: number;
  type: string;
};

type AuditRow = {
  id: number;
  run_id: string;
  from_frame_no: number;
  to_frame_no: number;
  caller: string;
  timestamp_ms: number;
  result: string;
  duration_ms: number | null;
};

function buildDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE _smithers_runs (
      run_id TEXT PRIMARY KEY,
      workflow_name TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      vcs_type TEXT,
      vcs_root TEXT,
      vcs_revision TEXT
    );
    CREATE TABLE _smithers_frames (
      run_id TEXT NOT NULL,
      frame_no INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      xml_json TEXT NOT NULL,
      xml_hash TEXT NOT NULL,
      vcs_revision TEXT,
      PRIMARY KEY (run_id, frame_no)
    );
    CREATE TABLE _smithers_nodes (
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      iteration INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL,
      last_attempt INTEGER,
      updated_at_ms INTEGER NOT NULL,
      output_table TEXT NOT NULL,
      PRIMARY KEY (run_id, node_id, iteration)
    );
    CREATE TABLE _smithers_node_diffs (
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      iteration INTEGER NOT NULL,
      base_ref TEXT NOT NULL,
      frame_no INTEGER NOT NULL,
      diff_json TEXT NOT NULL,
      PRIMARY KEY (run_id, node_id, iteration, base_ref)
    );
    CREATE TABLE _smithers_events (
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      timestamp_ms INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (run_id, seq)
    );
    CREATE TABLE _smithers_time_travel_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      from_frame_no INTEGER NOT NULL,
      to_frame_no INTEGER NOT NULL,
      caller TEXT NOT NULL,
      timestamp_ms INTEGER NOT NULL,
      result TEXT NOT NULL,
      duration_ms INTEGER
    );
  `);
  return db;
}

function seedRun(db: Database): void {
  db.query(
    `INSERT INTO _smithers_runs
       (run_id, workflow_name, status, created_at_ms, vcs_type, vcs_root, vcs_revision)
     VALUES (?, 'case12-workflow', 'running', ?, 'jj', '/tmp/case12', 'rev-frame-5')`,
  ).run(RUN_ID, 1_000);

  for (let frameNo = 0; frameNo <= 5; frameNo += 1) {
    db.query(
      `INSERT INTO _smithers_frames
         (run_id, frame_no, created_at_ms, xml_json, xml_hash, vcs_revision)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      RUN_ID,
      frameNo,
      1_000 + frameNo * 100,
      JSON.stringify({ frame: frameNo, payload: `state-at-${frameNo}` }),
      `hash-${frameNo}`,
      `rev-frame-${frameNo}`,
    );
  }

  db.query(
    `INSERT INTO _smithers_nodes
       (run_id, node_id, iteration, state, last_attempt, updated_at_ms, output_table)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(RUN_ID, "task:writer", 0, "finished", 5, 1_500, "out_writer");

  for (let frameNo = 0; frameNo <= 5; frameNo += 1) {
    db.query(
      `INSERT INTO _smithers_node_diffs
         (run_id, node_id, iteration, base_ref, frame_no, diff_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      RUN_ID,
      "task:writer",
      0,
      `base-${frameNo}`,
      frameNo,
      JSON.stringify({ at: frameNo }),
    );
  }

  for (let seq = 1; seq <= 6; seq += 1) {
    db.query(
      `INSERT INTO _smithers_events
         (run_id, seq, timestamp_ms, type, payload_json)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      RUN_ID,
      seq,
      1_000 + seq * 100,
      "FrameAdvanced",
      JSON.stringify({ seq }),
    );
  }
}

function rewind(
  db: Database,
  runId: string,
  toFrameNo: number,
  caller: string,
  nowMs: number,
): { fromFrameNo: number; toFrameNo: number; truncatedFrames: number; truncatedEvents: number } {
  const fromRow = db
    .query("SELECT MAX(frame_no) AS frame FROM _smithers_frames WHERE run_id = ?")
    .get(runId) as { frame: number | null };
  const fromFrameNo = Number(fromRow?.frame ?? 0);

  const targetFrame = db
    .query(
      `SELECT vcs_revision, xml_json
         FROM _smithers_frames
        WHERE run_id = ? AND frame_no = ?`,
    )
    .get(runId, toFrameNo) as Pick<FrameRow, "vcs_revision" | "xml_json"> | null;
  if (!targetFrame) {
    throw new Error(`frame ${toFrameNo} not found for run ${runId}`);
  }

  db.transaction(() => {
    db.query(
      `DELETE FROM _smithers_frames WHERE run_id = ? AND frame_no > ?`,
    ).run(runId, toFrameNo);
    db.query(
      `DELETE FROM _smithers_node_diffs WHERE run_id = ? AND frame_no > ?`,
    ).run(runId, toFrameNo);
    db.query(
      `DELETE FROM _smithers_events WHERE run_id = ? AND seq > ?`,
    ).run(runId, toFrameNo);
    db.query(
      `UPDATE _smithers_nodes
          SET state = 'pending',
              last_attempt = NULL,
              updated_at_ms = ?
        WHERE run_id = ?`,
    ).run(nowMs, runId);
    db.query(
      `UPDATE _smithers_runs
          SET vcs_revision = ?, status = 'recovering'
        WHERE run_id = ?`,
    ).run(targetFrame.vcs_revision, runId);
    db.query(
      `INSERT INTO _smithers_time_travel_audit
         (run_id, from_frame_no, to_frame_no, caller, timestamp_ms, result, duration_ms)
       VALUES (?, ?, ?, ?, ?, 'success', 0)`,
    ).run(runId, fromFrameNo, toFrameNo, caller, nowMs);
  })();

  const remaining = db
    .query("SELECT COUNT(*) AS c FROM _smithers_frames WHERE run_id = ?")
    .get(runId) as { c: number };
  return {
    fromFrameNo,
    toFrameNo,
    truncatedFrames: fromFrameNo - toFrameNo,
    truncatedEvents: fromFrameNo - toFrameNo,
  };
}

describe("case 12: rewind reverts VCS, subsequent frames reflect rewound state, audit entry exists", () => {
  test("rewind to frame K rolls back state, reverts VCS pointer, writes audit row", () => {
    const db = buildDb();
    try {
      seedRun(db);

      const before = db
        .query("SELECT vcs_revision FROM _smithers_runs WHERE run_id = ?")
        .get(RUN_ID) as { vcs_revision: string };
      expect(before.vcs_revision).toBe("rev-frame-5");

      const beforeFrames = db
        .query("SELECT frame_no FROM _smithers_frames WHERE run_id = ? ORDER BY frame_no ASC")
        .all(RUN_ID) as Array<Pick<FrameRow, "frame_no">>;
      expect(beforeFrames.map((row) => row.frame_no)).toEqual([0, 1, 2, 3, 4, 5]);

      const beforeEvents = db
        .query("SELECT seq FROM _smithers_events WHERE run_id = ? ORDER BY seq ASC")
        .all(RUN_ID) as Array<Pick<EventRow, "seq">>;
      expect(beforeEvents.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5, 6]);

      const summary = rewind(db, RUN_ID, REWIND_TO_FRAME, "user:owner", 9_000);
      expect(summary.fromFrameNo).toBe(5);
      expect(summary.toFrameNo).toBe(REWIND_TO_FRAME);
      expect(summary.truncatedFrames).toBe(3);

      const after = db
        .query("SELECT vcs_revision, status FROM _smithers_runs WHERE run_id = ?")
        .get(RUN_ID) as { vcs_revision: string; status: string };
      expect(after.vcs_revision).toBe(`rev-frame-${REWIND_TO_FRAME}`);
      expect(after.status).toBe("recovering");

      const afterFrames = db
        .query("SELECT frame_no FROM _smithers_frames WHERE run_id = ? ORDER BY frame_no ASC")
        .all(RUN_ID) as Array<Pick<FrameRow, "frame_no">>;
      expect(afterFrames.map((row) => row.frame_no)).toEqual([0, 1, 2]);

      const afterEvents = db
        .query("SELECT seq FROM _smithers_events WHERE run_id = ? ORDER BY seq ASC")
        .all(RUN_ID) as Array<Pick<EventRow, "seq">>;
      expect(afterEvents.map((row) => row.seq)).toEqual([1, 2]);

      const node = db
        .query("SELECT state, last_attempt FROM _smithers_nodes WHERE run_id = ? AND node_id = ?")
        .get(RUN_ID, "task:writer") as Pick<NodeRow, "state" | "last_attempt">;
      expect(node.state).toBe("pending");
      expect(node.last_attempt).toBeNull();

      const diffs = db
        .query("SELECT frame_no FROM _smithers_node_diffs WHERE run_id = ? ORDER BY frame_no ASC")
        .all(RUN_ID) as Array<{ frame_no: number }>;
      expect(diffs.every((row) => row.frame_no <= REWIND_TO_FRAME)).toBe(true);

      const audits = db
        .query(
          `SELECT id, run_id, from_frame_no, to_frame_no, caller, timestamp_ms, result, duration_ms
             FROM _smithers_time_travel_audit
            WHERE run_id = ?
            ORDER BY id ASC`,
        )
        .all(RUN_ID) as Array<AuditRow>;
      expect(audits).toHaveLength(1);
      expect(audits[0]?.from_frame_no).toBe(5);
      expect(audits[0]?.to_frame_no).toBe(REWIND_TO_FRAME);
      expect(audits[0]?.result).toBe("success");
      expect(audits[0]?.caller).toBe("user:owner");
      expect(audits[0]?.timestamp_ms).toBe(9_000);
    } finally {
      db.close();
    }
  });

  test("subsequent frames after rewind reflect the rewound state and continue from K+1", () => {
    const db = buildDb();
    try {
      seedRun(db);
      rewind(db, RUN_ID, REWIND_TO_FRAME, "user:owner", 9_000);

      const nextFrameNo = REWIND_TO_FRAME + 1;
      db.query(
        `INSERT INTO _smithers_frames
           (run_id, frame_no, created_at_ms, xml_json, xml_hash, vcs_revision)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        RUN_ID,
        nextFrameNo,
        10_000,
        JSON.stringify({ frame: nextFrameNo, payload: "post-rewind" }),
        `hash-${nextFrameNo}-post`,
        `rev-frame-${nextFrameNo}-post`,
      );
      db.query(
        `INSERT INTO _smithers_events
           (run_id, seq, timestamp_ms, type, payload_json)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        RUN_ID,
        nextFrameNo,
        10_000,
        "FrameAdvanced",
        JSON.stringify({ seq: nextFrameNo, postRewind: true }),
      );

      const frames = db
        .query(
          "SELECT frame_no, xml_json, vcs_revision FROM _smithers_frames WHERE run_id = ? ORDER BY frame_no ASC",
        )
        .all(RUN_ID) as Array<Pick<FrameRow, "frame_no" | "xml_json" | "vcs_revision">>;
      expect(frames.map((row) => row.frame_no)).toEqual([0, 1, 2, 3]);
      const tail = frames[frames.length - 1];
      expect(tail?.frame_no).toBe(REWIND_TO_FRAME + 1);
      expect(tail?.vcs_revision).toBe(`rev-frame-${REWIND_TO_FRAME + 1}-post`);
      expect(JSON.parse(tail?.xml_json ?? "{}")).toMatchObject({
        frame: REWIND_TO_FRAME + 1,
        payload: "post-rewind",
      });

      const events = db
        .query("SELECT seq FROM _smithers_events WHERE run_id = ? ORDER BY seq ASC")
        .all(RUN_ID) as Array<Pick<EventRow, "seq">>;
      expect(events.map((row) => row.seq)).toEqual([1, 2, REWIND_TO_FRAME + 1]);

      const audits = db
        .query("SELECT id FROM _smithers_time_travel_audit WHERE run_id = ?")
        .all(RUN_ID) as Array<Pick<AuditRow, "id">>;
      expect(audits).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("audit entry exists for every rewind invocation (multiple rewinds stack)", () => {
    const db = buildDb();
    try {
      seedRun(db);

      rewind(db, RUN_ID, 4, "user:first", 8_000);
      rewind(db, RUN_ID, 1, "user:second", 9_000);

      const audits = db
        .query(
          `SELECT id, from_frame_no, to_frame_no, caller, result
             FROM _smithers_time_travel_audit
            WHERE run_id = ?
            ORDER BY id ASC`,
        )
        .all(RUN_ID) as Array<AuditRow>;
      expect(audits).toHaveLength(2);
      expect(audits[0]?.from_frame_no).toBe(5);
      expect(audits[0]?.to_frame_no).toBe(4);
      expect(audits[0]?.caller).toBe("user:first");
      expect(audits[0]?.result).toBe("success");
      expect(audits[1]?.from_frame_no).toBe(4);
      expect(audits[1]?.to_frame_no).toBe(1);
      expect(audits[1]?.caller).toBe("user:second");
      expect(audits[1]?.result).toBe("success");

      const run = db
        .query("SELECT vcs_revision FROM _smithers_runs WHERE run_id = ?")
        .get(RUN_ID) as { vcs_revision: string };
      expect(run.vcs_revision).toBe("rev-frame-1");
    } finally {
      db.close();
    }
  });
});
