import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { listRewindAuditRows } from "@smithers-orchestrator/time-travel/rewindAudit";

type AnyRow = Record<string, unknown>;

type DbSnapshot = Record<string, AnyRow[]>;

const RUN_ID = "case11-run";
const OWNER_ID = "engine:case11-immutable";
const EVENT_COUNT = 10;

const ALL_TABLES = [
  "_smithers_runs",
  "_smithers_nodes",
  "_smithers_events",
  "_smithers_node_diffs",
  "_smithers_time_travel_audit",
] as const;

function buildDb(): { sqlite: Database; adapter: SmithersDb } {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { sqlite, adapter: new SmithersDb(db) };
}

async function seedRun(adapter: SmithersDb, baseMs: number): Promise<void> {
  await adapter.insertRun({
    runId: RUN_ID,
    workflowName: "case11-workflow",
    status: "running",
    createdAtMs: baseMs - 60_000,
    startedAtMs: baseMs - 50_000,
    heartbeatAtMs: baseMs - 1_000,
    runtimeOwnerId: OWNER_ID,
  });

  const nodeId = "node-A";
  for (let iteration = 0; iteration < EVENT_COUNT; iteration++) {
    const ts = baseMs - (EVENT_COUNT - iteration) * 1_000;
    // First event seq is 0, so seq 0..9 lines up with iteration 0..9.
    await adapter.insertEventWithNextSeq({
      runId: RUN_ID,
      timestampMs: ts,
      type: iteration === 0 ? "NodeStarted" : "NodeProgressed",
      payloadJson: JSON.stringify({ nodeId, iteration, value: iteration * 7 }),
    });

    await adapter.upsertNodeDiffCache({
      runId: RUN_ID,
      nodeId,
      iteration,
      baseRef: iteration === 0 ? "genesis" : `iter-${iteration - 1}`,
      diffJson: JSON.stringify({ op: "set", path: "/value", value: iteration * 7 }),
      computedAtMs: ts,
      sizeBytes: 48,
    });
  }

  await adapter.insertNode({
    runId: RUN_ID,
    nodeId,
    iteration: EVENT_COUNT - 1,
    state: "running",
    lastAttempt: 1,
    updatedAtMs: baseMs - 1_000,
    outputTable: "outputs_node_a",
    label: "Node A",
  });
}

function captureSnapshot(sqlite: Database): DbSnapshot {
  const snapshot: DbSnapshot = {};
  for (const table of ALL_TABLES) {
    const rows = sqlite
      .query(`SELECT * FROM ${table} ORDER BY rowid`)
      .all() as AnyRow[];
    snapshot[table] = rows;
  }
  return snapshot;
}

type ScrubView = {
  frameNo: number;
  events: AnyRow[];
  reconstructedNodeValue: number | null;
};

function scrubToFrame(sqlite: Database, frameNo: number): ScrubView {
  const events = sqlite
    .query(
      `SELECT seq, type, payload_json, timestamp_ms
         FROM _smithers_events
        WHERE run_id = ? AND seq <= ?
        ORDER BY seq ASC`,
    )
    .all(RUN_ID, frameNo) as AnyRow[];

  const diffs = sqlite
    .query(
      `SELECT iteration, diff_json
         FROM _smithers_node_diffs
        WHERE run_id = ? AND node_id = ? AND iteration <= ?
        ORDER BY iteration ASC`,
    )
    .all(RUN_ID, "node-A", frameNo) as AnyRow[];

  let value: number | null = null;
  for (const diff of diffs) {
    const parsed = JSON.parse(String(diff.diff_json)) as {
      op: string;
      path: string;
      value: number;
    };
    if (parsed.op === "set" && parsed.path === "/value") {
      value = parsed.value;
    }
  }

  return { frameNo, events, reconstructedNodeValue: value };
}

describe("case 11: frame scrub for view-only time travel", () => {
  test("scrubbing across all frames mutates zero rows", async () => {
    const { sqlite, adapter } = buildDb();
    try {
      const baseMs = Date.now();
      await seedRun(adapter, baseMs);

      const baseline = captureSnapshot(sqlite);
      expect(baseline._smithers_events).toHaveLength(EVENT_COUNT);
      expect(baseline._smithers_node_diffs).toHaveLength(EVENT_COUNT);
      expect(baseline._smithers_runs).toHaveLength(1);
      expect(baseline._smithers_nodes).toHaveLength(1);
      expect(baseline._smithers_time_travel_audit).toHaveLength(0);

      const views: ScrubView[] = [];
      for (let frame = 0; frame < EVENT_COUNT; frame++) {
        views.push(scrubToFrame(sqlite, frame));
      }
      views.push(scrubToFrame(sqlite, 0));
      views.push(scrubToFrame(sqlite, EVENT_COUNT - 1));
      views.push(scrubToFrame(sqlite, 4));

      const after = captureSnapshot(sqlite);

      expect(JSON.stringify(after)).toBe(JSON.stringify(baseline));
      for (const table of ALL_TABLES) {
        expect(after[table]).toEqual(baseline[table]);
      }

      expect(views[0]?.events).toHaveLength(1);
      expect(views[0]?.reconstructedNodeValue).toBe(0);
      expect(views[EVENT_COUNT - 1]?.events).toHaveLength(EVENT_COUNT);
      expect(views[EVENT_COUNT - 1]?.reconstructedNodeValue).toBe(
        (EVENT_COUNT - 1) * 7,
      );
      expect(views[4]?.reconstructedNodeValue).toBe(4 * 7);
    } finally {
      sqlite.close();
    }
  });

  test("scrub never writes a time-travel audit row (audit is for mutators only)", async () => {
    const { sqlite, adapter } = buildDb();
    try {
      const baseMs = Date.now();
      await seedRun(adapter, baseMs);

      const beforeAudit = await listRewindAuditRows(adapter, { runId: RUN_ID });
      expect(beforeAudit).toHaveLength(0);

      for (let frame = 0; frame < EVENT_COUNT; frame++) {
        scrubToFrame(sqlite, frame);
      }

      const afterAudit = await listRewindAuditRows(adapter, { runId: RUN_ID });
      expect(afterAudit).toHaveLength(0);

      const scrubbyAudit = afterAudit.filter((row) => {
        const caller = String(row.caller ?? "");
        return caller.includes("scrub") || caller.includes("view");
      });
      expect(scrubbyAudit).toHaveLength(0);
    } finally {
      sqlite.close();
    }
  });

  test("engine ownership and node row are untouched after scrub", async () => {
    const { sqlite, adapter } = buildDb();
    try {
      const baseMs = Date.now();
      await seedRun(adapter, baseMs);

      const runBefore = sqlite
        .query(`SELECT * FROM _smithers_runs WHERE run_id = ?`)
        .get(RUN_ID) as AnyRow;
      const nodeBefore = sqlite
        .query(`SELECT * FROM _smithers_nodes WHERE run_id = ?`)
        .get(RUN_ID) as AnyRow;
      expect(runBefore.runtime_owner_id).toBe(OWNER_ID);

      for (let frame = EVENT_COUNT - 1; frame >= 0; frame--) {
        scrubToFrame(sqlite, frame);
      }

      const runAfter = sqlite
        .query(`SELECT * FROM _smithers_runs WHERE run_id = ?`)
        .get(RUN_ID) as AnyRow;
      const nodeAfter = sqlite
        .query(`SELECT * FROM _smithers_nodes WHERE run_id = ?`)
        .get(RUN_ID) as AnyRow;

      expect(runAfter).toEqual(runBefore);
      expect(nodeAfter).toEqual(nodeBefore);
      expect(runAfter.runtime_owner_id).toBe(OWNER_ID);
      expect(runAfter.status).toBe("running");
    } finally {
      sqlite.close();
    }
  });

  test("regression guard: a write masquerading as scrub fails the snapshot diff", async () => {
    const { sqlite, adapter } = buildDb();
    try {
      const baseMs = Date.now();
      await seedRun(adapter, baseMs);

      const baseline = captureSnapshot(sqlite);

      // No public insert method for audit rows; a raw INSERT into the REAL
      // _smithers_time_travel_audit table (real schema) proves the snapshot
      // diff catches a mutation masquerading as a view-only scrub.
      sqlite
        .query(
          `INSERT INTO _smithers_time_travel_audit
             (run_id, from_frame_no, to_frame_no, caller, timestamp_ms, result, duration_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(RUN_ID, 9, 4, "rewind", baseMs, "ok", 12);

      const after = captureSnapshot(sqlite);
      expect(JSON.stringify(after)).not.toBe(JSON.stringify(baseline));
      expect(after._smithers_time_travel_audit).toHaveLength(1);

      const audits = await listRewindAuditRows(adapter, { runId: RUN_ID });
      expect(audits).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });
});
