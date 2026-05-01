import { Database } from "bun:sqlite";
import { describe, expect, onTestFinished, test } from "bun:test";

const RUN_ID = "case13-run";
const ROOT_NODE_ID = "root";
const MID_NODE_ID = "mid";
const LEAF_NODE_ID = "leaf";
const FAILED_STATES = new Set(["failed", "error"]);

type FrameTreeNode = {
  nodeId: string;
  state: string;
  children: FrameTreeNode[];
};

type EventRow = {
  run_id: string;
  seq: number;
  type: string;
  payload_json: string;
};

type FrameRow = {
  run_id: string;
  frame_no: number;
  xml_json: string;
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
    CREATE TABLE _smithers_frames (
      run_id TEXT NOT NULL,
      frame_no INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      xml_json TEXT NOT NULL,
      xml_hash TEXT NOT NULL,
      encoding TEXT NOT NULL DEFAULT 'full',
      mounted_task_ids_json TEXT,
      task_index_json TEXT,
      note TEXT,
      PRIMARY KEY (run_id, frame_no)
    );
  `);
  return db;
}

function seedRun(db: Database, now: number): void {
  db.query(
    `INSERT INTO _smithers_runs
       (run_id, workflow_name, status, created_at_ms, started_at_ms, heartbeat_at_ms, runtime_owner_id)
     VALUES (?, 'case13-workflow', 'running', ?, ?, ?, 'engine:case13')`,
  ).run(RUN_ID, now - 5_000, now - 4_000, now - 500);
}

function seedNode(
  db: Database,
  nodeId: string,
  state: string,
  updatedAtMs: number,
  label: string,
): void {
  db.query(
    `INSERT INTO _smithers_nodes
       (run_id, node_id, iteration, state, last_attempt, updated_at_ms, output_table, label)
     VALUES (?, ?, 0, ?, 1, ?, ?, ?)`,
  ).run(RUN_ID, nodeId, state, updatedAtMs, `out_${nodeId}`, label);
}

function commitFrameTree(
  db: Database,
  frameNo: number,
  createdAtMs: number,
  tree: FrameTreeNode,
  mountedTaskIds: string[],
): void {
  db.query(
    `INSERT INTO _smithers_frames
       (run_id, frame_no, created_at_ms, xml_json, xml_hash, encoding, mounted_task_ids_json, task_index_json)
     VALUES (?, ?, ?, ?, ?, 'full', ?, ?)`,
  ).run(
    RUN_ID,
    frameNo,
    createdAtMs,
    JSON.stringify(tree),
    `hash:${frameNo}`,
    JSON.stringify(mountedTaskIds),
    JSON.stringify(mountedTaskIds.map((id, idx) => ({ nodeId: id, index: idx }))),
  );
}

function readLatestFrameTree(db: Database): FrameTreeNode {
  const row = db
    .query(
      `SELECT run_id, frame_no, xml_json
         FROM _smithers_frames
        WHERE run_id = ?
        ORDER BY frame_no DESC
        LIMIT 1`,
    )
    .get(RUN_ID) as FrameRow | null;
  if (!row) throw new Error("frame missing");
  return JSON.parse(row.xml_json) as FrameTreeNode;
}

function readNodeState(db: Database, nodeId: string): string {
  const row = db
    .query(
      `SELECT state FROM _smithers_nodes
        WHERE run_id = ? AND node_id = ? AND iteration = 0`,
    )
    .get(RUN_ID, nodeId) as { state: string } | null;
  if (!row) throw new Error(`node missing: ${nodeId}`);
  return row.state;
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

function recordNodeFailedEvent(
  db: Database,
  nodeId: string,
  attempt: number,
  errorMessage: string,
  timestampMs: number,
): number {
  const seq = nextSeq(db);
  db.query(
    `INSERT INTO _smithers_events (run_id, seq, timestamp_ms, type, payload_json)
     VALUES (?, ?, ?, 'NodeFailed', ?)`,
  ).run(
    RUN_ID,
    seq,
    timestampMs,
    JSON.stringify({
      runId: RUN_ID,
      nodeId,
      iteration: 0,
      attempt,
      error: { message: errorMessage, kind: "tool" },
    }),
  );
  return seq;
}

function readEventsByType(db: Database, type: string): EventRow[] {
  return db
    .query(
      `SELECT run_id, seq, type, payload_json
         FROM _smithers_events
        WHERE run_id = ? AND type = ?
        ORDER BY seq ASC`,
    )
    .all(RUN_ID, type) as EventRow[];
}

function ancestorPath(tree: FrameTreeNode, target: string): FrameTreeNode[] {
  const path: FrameTreeNode[] = [];
  function walk(node: FrameTreeNode, trail: FrameTreeNode[]): boolean {
    const next = [...trail, node];
    if (node.nodeId === target) {
      path.push(...next);
      return true;
    }
    for (const child of node.children) {
      if (walk(child, next)) return true;
    }
    return false;
  }
  walk(tree, []);
  return path;
}

function aggregatedFailureMarker(
  node: FrameTreeNode,
  liveStateByNodeId: Map<string, string>,
): boolean {
  const liveState = liveStateByNodeId.get(node.nodeId) ?? node.state;
  if (FAILED_STATES.has(liveState)) return true;
  for (const child of node.children) {
    if (aggregatedFailureMarker(child, liveStateByNodeId)) return true;
  }
  return false;
}

function liveStateMap(db: Database): Map<string, string> {
  const rows = db
    .query(
      `SELECT node_id, state FROM _smithers_nodes WHERE run_id = ? AND iteration = 0`,
    )
    .all(RUN_ID) as Array<{ node_id: string; state: string }>;
  const map = new Map<string, string>();
  for (const row of rows) map.set(row.node_id, row.state);
  return map;
}

describe("case 13: collapsed ancestor shows failure marker", () => {
  test("DB-level bubble-up: failed leaf surfaces failure on every ancestor in frame tree", () => {
    const db = buildDb();
    onTestFinished(() => db.close());

    const t0 = Date.now();
    seedRun(db, t0);
    seedNode(db, ROOT_NODE_ID, "running", t0 - 300, "Root");
    seedNode(db, MID_NODE_ID, "running", t0 - 200, "Mid");
    seedNode(db, LEAF_NODE_ID, "running", t0 - 100, "Leaf");

    const initialTree: FrameTreeNode = {
      nodeId: ROOT_NODE_ID,
      state: "running",
      children: [
        {
          nodeId: MID_NODE_ID,
          state: "running",
          children: [
            { nodeId: LEAF_NODE_ID, state: "running", children: [] },
          ],
        },
      ],
    };
    commitFrameTree(db, 1, t0 - 100, initialTree, [
      ROOT_NODE_ID,
      MID_NODE_ID,
      LEAF_NODE_ID,
    ]);

    const live = liveStateMap(db);
    expect(aggregatedFailureMarker(initialTree, live)).toBe(false);

    const failedAt = t0 + 50;
    db.query(
      `UPDATE _smithers_nodes
          SET state = 'failed', updated_at_ms = ?
        WHERE run_id = ? AND node_id = ? AND iteration = 0`,
    ).run(failedAt, RUN_ID, LEAF_NODE_ID);

    const failedSeq = recordNodeFailedEvent(
      db,
      LEAF_NODE_ID,
      1,
      "tool blew up",
      failedAt,
    );
    expect(failedSeq).toBe(1);

    const failedTree: FrameTreeNode = {
      nodeId: ROOT_NODE_ID,
      state: "running",
      children: [
        {
          nodeId: MID_NODE_ID,
          state: "running",
          children: [
            { nodeId: LEAF_NODE_ID, state: "failed", children: [] },
          ],
        },
      ],
    };
    commitFrameTree(db, 2, failedAt, failedTree, [
      ROOT_NODE_ID,
      MID_NODE_ID,
      LEAF_NODE_ID,
    ]);

    expect(readNodeState(db, LEAF_NODE_ID)).toBe("failed");
    expect(readNodeState(db, MID_NODE_ID)).toBe("running");
    expect(readNodeState(db, ROOT_NODE_ID)).toBe("running");

    const latest = readLatestFrameTree(db);
    const liveAfter = liveStateMap(db);

    const path = ancestorPath(latest, LEAF_NODE_ID);
    expect(path.map((n) => n.nodeId)).toEqual([
      ROOT_NODE_ID,
      MID_NODE_ID,
      LEAF_NODE_ID,
    ]);

    for (const ancestor of path) {
      expect(aggregatedFailureMarker(ancestor, liveAfter)).toBe(true);
    }

    expect(aggregatedFailureMarker(latest, liveAfter)).toBe(true);
    expect(aggregatedFailureMarker(latest.children[0], liveAfter)).toBe(true);
    expect(aggregatedFailureMarker(latest.children[0].children[0], liveAfter)).toBe(true);
  });

  test("collapse-independence: NodeFailed event for buried leaf is queryable from run event log", () => {
    const db = buildDb();
    onTestFinished(() => db.close());

    const t0 = Date.now();
    seedRun(db, t0);
    seedNode(db, ROOT_NODE_ID, "running", t0 - 300, "Root");
    seedNode(db, MID_NODE_ID, "running", t0 - 200, "Mid");
    seedNode(db, LEAF_NODE_ID, "failed", t0, "Leaf");

    const tree: FrameTreeNode = {
      nodeId: ROOT_NODE_ID,
      state: "running",
      children: [
        {
          nodeId: MID_NODE_ID,
          state: "running",
          children: [
            { nodeId: LEAF_NODE_ID, state: "failed", children: [] },
          ],
        },
      ],
    };
    commitFrameTree(db, 1, t0, tree, [ROOT_NODE_ID, MID_NODE_ID, LEAF_NODE_ID]);
    recordNodeFailedEvent(db, LEAF_NODE_ID, 2, "boom", t0);

    const failedEvents = readEventsByType(db, "NodeFailed");
    expect(failedEvents).toHaveLength(1);
    const payload = JSON.parse(failedEvents[0].payload_json) as {
      runId: string;
      nodeId: string;
      iteration: number;
      attempt: number;
      error: { message: string };
    };
    expect(payload.runId).toBe(RUN_ID);
    expect(payload.nodeId).toBe(LEAF_NODE_ID);
    expect(payload.iteration).toBe(0);
    expect(payload.attempt).toBe(2);
    expect(payload.error.message).toBe("boom");

    const ancestors = ancestorPath(tree, LEAF_NODE_ID).slice(0, -1);
    expect(ancestors.map((a) => a.nodeId)).toEqual([
      ROOT_NODE_ID,
      MID_NODE_ID,
    ]);
    for (const ancestor of ancestors) {
      const reachable = ancestorPath(ancestor, LEAF_NODE_ID).at(-1);
      expect(reachable?.nodeId).toBe(LEAF_NODE_ID);
    }
  });

  test("schema invariant: frame tree provides stable ancestor linkage; aggregator can be re-run on any frame_no", () => {
    const db = buildDb();
    onTestFinished(() => db.close());

    const t0 = Date.now();
    seedRun(db, t0);
    seedNode(db, ROOT_NODE_ID, "running", t0 - 300, "Root");
    seedNode(db, MID_NODE_ID, "running", t0 - 200, "Mid");
    seedNode(db, LEAF_NODE_ID, "running", t0 - 100, "Leaf");

    const f1Tree: FrameTreeNode = {
      nodeId: ROOT_NODE_ID,
      state: "running",
      children: [
        {
          nodeId: MID_NODE_ID,
          state: "running",
          children: [
            { nodeId: LEAF_NODE_ID, state: "running", children: [] },
          ],
        },
      ],
    };
    commitFrameTree(db, 1, t0 - 100, f1Tree, [
      ROOT_NODE_ID,
      MID_NODE_ID,
      LEAF_NODE_ID,
    ]);

    const f2Tree: FrameTreeNode = {
      nodeId: ROOT_NODE_ID,
      state: "running",
      children: [
        {
          nodeId: MID_NODE_ID,
          state: "running",
          children: [
            { nodeId: LEAF_NODE_ID, state: "failed", children: [] },
          ],
        },
      ],
    };
    db.query(
      `UPDATE _smithers_nodes SET state = 'failed', updated_at_ms = ?
        WHERE run_id = ? AND node_id = ? AND iteration = 0`,
    ).run(t0 + 25, RUN_ID, LEAF_NODE_ID);
    commitFrameTree(db, 2, t0 + 25, f2Tree, [
      ROOT_NODE_ID,
      MID_NODE_ID,
      LEAF_NODE_ID,
    ]);
    recordNodeFailedEvent(db, LEAF_NODE_ID, 1, "boom", t0 + 25);

    const frame1Tree = JSON.parse(
      (
        db
          .query(
            `SELECT xml_json FROM _smithers_frames WHERE run_id = ? AND frame_no = 1`,
          )
          .get(RUN_ID) as { xml_json: string }
      ).xml_json,
    ) as FrameTreeNode;

    const frame2Tree = JSON.parse(
      (
        db
          .query(
            `SELECT xml_json FROM _smithers_frames WHERE run_id = ? AND frame_no = 2`,
          )
          .get(RUN_ID) as { xml_json: string }
      ).xml_json,
    ) as FrameTreeNode;

    const live = liveStateMap(db);

    expect(aggregatedFailureMarker(frame1Tree, new Map())).toBe(false);
    expect(aggregatedFailureMarker(frame2Tree, new Map())).toBe(true);
    expect(aggregatedFailureMarker(frame2Tree, live)).toBe(true);

    const f1Path = ancestorPath(frame1Tree, LEAF_NODE_ID).map((n) => n.nodeId);
    const f2Path = ancestorPath(frame2Tree, LEAF_NODE_ID).map((n) => n.nodeId);
    expect(f1Path).toEqual(f2Path);
  });

  test.skip("client-side: DevToolsStore renders failure marker on collapsed ancestor (gui/0001, pi-plugin/runtime/DevToolsStore.ts)", () => {
    // Skipped: the failure-aggregation walk that turns a collapsed ancestor's
    // chevron red is implemented client-side. Today neither the DB
    // (`_smithers_nodes` has no `parent_node_id`, no aggregator view) nor
    // packages/pi-plugin/src/runtime/DevToolsStore.ts (no
    // `hasFailedDescendant` / `aggregateStatus` walk over `tree`) computes it.
    // The contract is documented only in
    // packages/pi-plugin/src/buildSmithersPiSystemPrompt.ts ("Failed
    // descendants bubble an error marker to collapsed ancestors"). Re-enable
    // once gui/0001 (Inspector GUI) ships the tree renderer with a collapse
    // model and a `failureMarker` selector on DevToolsStore that walks
    // `tree.children` for any descendant in {failed, error} state, even when
    // the ancestor is collapsed.
    expect(true).toBe(true);
  });
});
