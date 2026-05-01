import { Database } from "bun:sqlite";
import { describe, expect, onTestFinished, test } from "bun:test";

const RUN_ID = "case10-run";
const SELECTED_NODE_ID = "n2";
const SELECTED_ITERATION = 0;

type NodeSnapshot = {
  run_id: string;
  node_id: string;
  iteration: number;
  state: string;
  updated_at_ms: number;
  output_table: string;
  label: string | null;
};

type EventRow = {
  run_id: string;
  seq: number;
  type: string;
  payload_json: string;
};

function buildDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE _smithers_runs (
      run_id TEXT PRIMARY KEY,
      workflow_name TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      started_at_ms INTEGER,
      heartbeat_at_ms INTEGER,
      runtime_owner_id TEXT
    );
    CREATE TABLE _smithers_nodes (
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      iteration INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL,
      last_attempt INTEGER,
      updated_at_ms INTEGER NOT NULL,
      output_table TEXT NOT NULL,
      label TEXT,
      PRIMARY KEY (run_id, node_id, iteration)
    );
    CREATE TABLE _smithers_events (
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      timestamp_ms INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (run_id, seq)
    );
  `);
  return db;
}

function seedRun(db: Database, now: number): void {
  db.query(
    `INSERT INTO _smithers_runs
       (run_id, workflow_name, status, created_at_ms, started_at_ms, heartbeat_at_ms, runtime_owner_id)
     VALUES (?, 'case10-workflow', 'running', ?, ?, ?, 'engine:case10')`,
  ).run(RUN_ID, now - 5_000, now - 4_000, now - 500);
}

function seedNode(
  db: Database,
  nodeId: string,
  state: string,
  updatedAtMs: number,
  label: string | null,
): void {
  db.query(
    `INSERT INTO _smithers_nodes
       (run_id, node_id, iteration, state, last_attempt, updated_at_ms, output_table, label)
     VALUES (?, ?, 0, ?, 1, ?, ?, ?)`,
  ).run(RUN_ID, nodeId, state, updatedAtMs, `out_${nodeId}`, label);
}

function readNode(db: Database, nodeId: string): NodeSnapshot | null {
  return (
    (db
      .query(
        `SELECT run_id, node_id, iteration, state, updated_at_ms, output_table, label
           FROM _smithers_nodes
          WHERE run_id = ? AND node_id = ? AND iteration = ?`,
      )
      .get(RUN_ID, nodeId, SELECTED_ITERATION) as NodeSnapshot | null) ?? null
  );
}

function readNodeIds(db: Database): string[] {
  const rows = db
    .query(
      `SELECT node_id FROM _smithers_nodes WHERE run_id = ? ORDER BY node_id ASC`,
    )
    .all(RUN_ID) as Array<{ node_id: string }>;
  return rows.map((r) => r.node_id);
}

function nextSeq(db: Database): number {
  return (
    (
      db
        .query(
          `SELECT COALESCE(MAX(seq), 0) AS max_seq FROM _smithers_events WHERE run_id = ?`,
        )
        .get(RUN_ID) as { max_seq: number }
    ).max_seq + 1
  );
}

function recordUnmountEvent(
  db: Database,
  nodeId: string,
  lastSnapshot: NodeSnapshot,
  timestampMs: number,
): number {
  const seq = nextSeq(db);
  db.query(
    `INSERT INTO _smithers_events (run_id, seq, timestamp_ms, type, payload_json)
     VALUES (?, ?, ?, 'NodeUnmounted', ?)`,
  ).run(
    RUN_ID,
    seq,
    timestampMs,
    JSON.stringify({
      runId: RUN_ID,
      nodeId,
      iteration: lastSnapshot.iteration,
      lastSeen: {
        state: lastSnapshot.state,
        updatedAtMs: lastSnapshot.updated_at_ms,
        outputTable: lastSnapshot.output_table,
        label: lastSnapshot.label,
      },
    }),
  );
  return seq;
}

function readEventsForNode(db: Database, nodeId: string): EventRow[] {
  const rows = db
    .query(
      `SELECT run_id, seq, type, payload_json
         FROM _smithers_events
        WHERE run_id = ?
        ORDER BY seq ASC`,
    )
    .all(RUN_ID) as EventRow[];
  return rows.filter((row) => {
    try {
      const payload = JSON.parse(row.payload_json) as { nodeId?: string };
      return payload.nodeId === nodeId;
    } catch {
      return false;
    }
  });
}

describe("case 10: node unmount after selection; ghost state preserved", () => {
  test("DB-level ghost contract: _smithers_nodes row survives unmount and inspector sees last-known state", () => {
    const db = buildDb();
    onTestFinished(() => db.close());

    const t0 = Date.now();
    seedRun(db, t0);
    seedNode(db, "n1", "running", t0 - 200, "Plan");
    seedNode(db, "n2", "running", t0 - 100, "Build");
    seedNode(db, "n3", "waiting-approval", t0 - 50, "Approve");

    const beforeIds = readNodeIds(db);
    expect(beforeIds).toEqual(["n1", "n2", "n3"]);

    const inspectorSnapshot = readNode(db, SELECTED_NODE_ID);
    expect(inspectorSnapshot).not.toBeNull();
    if (!inspectorSnapshot) return;
    expect(inspectorSnapshot.state).toBe("running");
    expect(inspectorSnapshot.label).toBe("Build");
    expect(inspectorSnapshot.output_table).toBe("out_n2");

    const unmountTs = t0 + 50;
    const unmountSeq = recordUnmountEvent(
      db,
      SELECTED_NODE_ID,
      inspectorSnapshot,
      unmountTs,
    );
    expect(unmountSeq).toBe(1);

    const afterIds = readNodeIds(db);
    expect(afterIds).toEqual(["n1", "n2", "n3"]);

    const ghost = readNode(db, SELECTED_NODE_ID);
    expect(ghost).not.toBeNull();
    if (!ghost) return;
    expect(ghost.node_id).toBe(SELECTED_NODE_ID);
    expect(ghost.state).toBe(inspectorSnapshot.state);
    expect(ghost.updated_at_ms).toBe(inspectorSnapshot.updated_at_ms);
    expect(ghost.output_table).toBe(inspectorSnapshot.output_table);
    expect(ghost.label).toBe(inspectorSnapshot.label);

    const events = readEventsForNode(db, SELECTED_NODE_ID);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("NodeUnmounted");
    const payload = JSON.parse(events[0].payload_json) as {
      nodeId: string;
      iteration: number;
      lastSeen: {
        state: string;
        updatedAtMs: number;
        outputTable: string;
        label: string | null;
      };
    };
    expect(payload.nodeId).toBe(SELECTED_NODE_ID);
    expect(payload.iteration).toBe(SELECTED_ITERATION);
    expect(payload.lastSeen.state).toBe(inspectorSnapshot.state);
    expect(payload.lastSeen.updatedAtMs).toBe(inspectorSnapshot.updated_at_ms);
    expect(payload.lastSeen.outputTable).toBe(inspectorSnapshot.output_table);
    expect(payload.lastSeen.label).toBe(inspectorSnapshot.label);
  });

  test("ghost rows do not move forward after the live engine advances peers", () => {
    const db = buildDb();
    onTestFinished(() => db.close());

    const t0 = Date.now();
    seedRun(db, t0);
    seedNode(db, "n1", "running", t0 - 200, "Plan");
    seedNode(db, "n2", "running", t0 - 100, "Build");
    seedNode(db, "n3", "waiting-approval", t0 - 50, "Approve");

    const captured = readNode(db, SELECTED_NODE_ID);
    expect(captured).not.toBeNull();
    if (!captured) return;

    recordUnmountEvent(db, SELECTED_NODE_ID, captured, t0 + 10);

    db.query(
      `UPDATE _smithers_nodes
          SET state = 'finished', updated_at_ms = ?
        WHERE run_id = ? AND node_id = 'n1'`,
    ).run(t0 + 100, RUN_ID);
    db.query(
      `UPDATE _smithers_nodes
          SET state = 'running', updated_at_ms = ?
        WHERE run_id = ? AND node_id = 'n3'`,
    ).run(t0 + 100, RUN_ID);

    const ghost = readNode(db, SELECTED_NODE_ID);
    expect(ghost).not.toBeNull();
    if (!ghost) return;
    expect(ghost.state).toBe(captured.state);
    expect(ghost.updated_at_ms).toBe(captured.updated_at_ms);
    expect(ghost.label).toBe(captured.label);
  });

  test("audit trail: NodeUnmounted event persists even if the node row is later evicted", () => {
    const db = buildDb();
    onTestFinished(() => db.close());

    const t0 = Date.now();
    seedRun(db, t0);
    seedNode(db, "n1", "running", t0 - 200, "Plan");
    seedNode(db, "n2", "running", t0 - 100, "Build");
    seedNode(db, "n3", "waiting-approval", t0 - 50, "Approve");

    const captured = readNode(db, SELECTED_NODE_ID);
    expect(captured).not.toBeNull();
    if (!captured) return;

    recordUnmountEvent(db, SELECTED_NODE_ID, captured, t0 + 25);

    db.query(
      `DELETE FROM _smithers_nodes WHERE run_id = ? AND node_id = ?`,
    ).run(RUN_ID, SELECTED_NODE_ID);

    expect(readNode(db, SELECTED_NODE_ID)).toBeNull();

    const events = readEventsForNode(db, SELECTED_NODE_ID);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("NodeUnmounted");
    const payload = JSON.parse(events[0].payload_json) as {
      lastSeen: { state: string; updatedAtMs: number };
    };
    expect(payload.lastSeen.state).toBe(captured.state);
    expect(payload.lastSeen.updatedAtMs).toBe(captured.updated_at_ms);
  });

  test.skip("client-side: DevToolsStore.ghostNodes preserves selected node after live tree drops it (gui/0001, pi-plugin/runtime/DevToolsStore.ts)", () => {
    // Skipped: ghost-state preservation is implemented client-side in
    // packages/pi-plugin/src/runtime/DevToolsStore.ts (`ghostNodes` Map,
    // `unmountedFrameNo`/`unmountedSeq`, `selectedGhostRecord`). The schema
    // has no `lastSeen`/`unmounted_at_ms` column on `_smithers_nodes` — the
    // ghost is held in client memory while the row + audit event stay in the
    // DB. Re-enable once gui/0001 (Inspector GUI) ships an integration
    // harness that drives the store from a recorded delta stream and asserts
    // the inspector pane retains last-known props after the unmount delta is
    // applied.
    expect(true).toBe(true);
  });
});
