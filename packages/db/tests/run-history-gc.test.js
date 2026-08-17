import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "../src/adapter.js";
import { ensureSmithersTables } from "../src/ensure.js";
import { compactLegacySnapshots, retainRunHistory } from "../src/run-history-gc.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { adapter: new SmithersDb(db), sqlite };
}

function contentHash(nodesJson, outputsJson, ralphJson, inputJson) {
  return createHash("sha256")
    .update(`{"nodes":${nodesJson},"outputs":${outputsJson},"ralph":${ralphJson},"input":${inputJson}}`)
    .digest("hex");
}

function insertLegacySnapshot(sqlite, runId, frameNo, payload) {
  const nodesJson = JSON.stringify([{ nodeId: "task", state: "finished" }]);
  const outputsJson = JSON.stringify({ result: payload });
  const ralphJson = "[]";
  const inputJson = JSON.stringify({ prompt: "restore me" });
  const hash = contentHash(nodesJson, outputsJson, ralphJson, inputJson);
  sqlite
    .query(
      `INSERT INTO _smithers_snapshots
         (run_id, frame_no, nodes_json, outputs_json, ralph_json, input_json, vcs_pointer, workflow_hash, content_hash, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 'workflow', ?, 1)`,
    )
    .run(runId, frameNo, nodesJson, outputsJson, ralphJson, inputJson, hash);
  return { nodesJson, outputsJson, ralphJson, inputJson, hash };
}

describe("legacy snapshot compaction", () => {
  test("resumes after one batch and leaves every committed snapshot restorable", async () => {
    const { adapter, sqlite } = createTestDb();
    const expected = insertLegacySnapshot(sqlite, "run-a", 0, "shared payload");
    insertLegacySnapshot(sqlite, "run-b", 0, "shared payload");

    const interrupted = await compactLegacySnapshots(adapter, { batchSize: 1, maxBatches: 1 });
    expect(interrupted).toMatchObject({ migratedRows: 1, remainingRows: null, interrupted: true });
    expect(sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(sqlite.query("SELECT COUNT(*) AS count FROM _smithers_snapshot_payload_refs").get().count).toBe(1);
    expect(sqlite.query("SELECT ref_count FROM _smithers_snapshot_contents").get().ref_count).toBe(1);

    const completed = await compactLegacySnapshots(adapter, { batchSize: 1 });
    expect(completed).toMatchObject({ migratedRows: 1, remainingRows: 0, interrupted: false });
    expect(sqlite.query("SELECT COUNT(*) AS count FROM _smithers_snapshot_contents").get().count).toBe(1);
    expect(sqlite.query("SELECT ref_count FROM _smithers_snapshot_contents").get().ref_count).toBe(2);
    expect(sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);

    const restored = sqlite
      .query(
        `SELECT c.nodes_json, c.outputs_json, c.ralph_json, c.input_json
           FROM _smithers_snapshots s
           JOIN _smithers_snapshot_payload_refs r USING (run_id, frame_no)
           JOIN _smithers_snapshot_contents c ON c.content_hash = r.content_hash
          WHERE s.run_id = 'run-a' AND s.frame_no = 0`,
      )
      .get();
    expect(restored).toEqual({
      nodes_json: expected.nodesJson,
      outputs_json: expected.outputsJson,
      ralph_json: expected.ralphJson,
      input_json: expected.inputJson,
    });
    const compact = sqlite
      .query("SELECT nodes_json, outputs_json, ralph_json, input_json FROM _smithers_snapshots")
      .all();
    expect(compact.every((row) => Object.values(row).every((value) => value === ""))).toBe(true);
  });

  test("dry run reports duplicate inline bytes and changes no rows", async () => {
    const { adapter, sqlite } = createTestDb();
    insertLegacySnapshot(sqlite, "run-a", 0, "payload");
    const before = sqlite.serialize();
    const result = await compactLegacySnapshots(adapter, { dryRun: true });
    expect(result.remainingRows).toBe(1);
    expect(result.remainingInlineBytes).toBeGreaterThan(0);
    expect(result.migratedRows).toBe(0);
    expect(sqlite.serialize()).toEqual(before);
  });
});

describe("terminal run retention", () => {
  test("removes only old terminal leaves and all run-owned history in bounded chunks", async () => {
    const { adapter, sqlite } = createTestDb();
    const nowMs = Date.UTC(2026, 7, 16);
    const cutoffMs = nowMs - 30 * 24 * 60 * 60 * 1_000;
    const oldMs = cutoffMs - 1;
    const recentMs = cutoffMs + 1;
    const runs = [
      ["finished", "finished", oldMs],
      ["failed", "failed", oldMs],
      ["cancelled", "cancelled", oldMs],
      ["continued", "continued", oldMs],
      ["running", "running", null],
      ["paused", "paused", null],
      ["waiting-human", "waiting-approval", null],
      ["waiting-event", "waiting-event", null],
      ["waiting-timer", "waiting-timer", null],
      ["recent", "finished", recentMs],
      ["continued-live", "continued", null],
    ];
    const insertRun = sqlite.query(
      `INSERT INTO _smithers_runs
         (run_id, workflow_name, status, created_at_ms, finished_at_ms)
       VALUES (?, 'workflow', ?, 1, ?)`,
    );
    const insertEvent = sqlite.query(
      "INSERT INTO _smithers_events (run_id, seq, timestamp_ms, type, payload_json) VALUES (?, ?, 1, 'test', '{}')",
    );
    for (const [runId, status, finishedAtMs] of runs) {
      insertRun.run(runId, status, finishedAtMs);
      for (let seq = 0; seq < 3; seq++) insertEvent.run(runId, seq);
    }
    sqlite.exec(
      `CREATE TABLE results (
         run_id TEXT NOT NULL,
         node_id TEXT NOT NULL,
         iteration INTEGER NOT NULL,
         value TEXT NOT NULL
       )`,
    );
    for (const runId of ["finished", "running"]) {
      sqlite
        .query(
          "INSERT INTO _smithers_nodes (run_id, node_id, iteration, state, updated_at_ms, output_table) VALUES (?, 'task', 0, 'finished', 1, 'results')",
        )
        .run(runId);
      sqlite.query("INSERT INTO results VALUES (?, 'task', 0, 'value')").run(runId);
    }
    const snapshot = insertLegacySnapshot(sqlite, "finished", 0, "retained content");
    await compactLegacySnapshots(adapter);
    expect(sqlite.query("SELECT content_hash FROM _smithers_snapshot_contents").get().content_hash).toBe(snapshot.hash);

    const result = await retainRunHistory(adapter, { cutoffMs, chunkSize: 2 });
    expect(result.removedRuns.map((run) => run.runId).sort()).toEqual(["cancelled", "continued", "failed", "finished"]);
    expect(result.rowsByTable._smithers_events).toBe(12);
    expect(result.rowsByTable.results).toBe(1);
    expect(
      sqlite
        .query("SELECT run_id FROM _smithers_runs ORDER BY run_id")
        .all()
        .map((row) => row.run_id),
    ).toEqual(["continued-live", "paused", "recent", "running", "waiting-event", "waiting-human", "waiting-timer"]);
    expect(sqlite.query("SELECT run_id FROM results").all()).toEqual([{ run_id: "running" }]);
    expect(sqlite.query("SELECT COUNT(*) AS count FROM _smithers_snapshot_contents").get().count).toBe(0);
    expect(sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  test("dry run removes nothing and a live descendant protects its terminal ancestry", async () => {
    const { adapter, sqlite } = createTestDb();
    sqlite.exec(`
      INSERT INTO _smithers_runs
        (run_id, workflow_name, status, created_at_ms, finished_at_ms)
      VALUES ('terminal-leaf', 'workflow', 'finished', 1, 2),
             ('terminal-parent', 'workflow', 'finished', 1, 2),
             ('live-child', 'workflow', 'paused', 1, NULL);
      UPDATE _smithers_runs SET parent_run_id = 'terminal-parent' WHERE run_id = 'live-child';
      INSERT INTO _smithers_events (run_id, seq, timestamp_ms, type, payload_json)
      VALUES ('terminal-leaf', 0, 1, 'test', '{}'),
             ('terminal-parent', 0, 1, 'test', '{}'),
             ('live-child', 0, 1, 'test', '{}');
    `);
    const before = sqlite.serialize();
    const result = await retainRunHistory(adapter, { cutoffMs: 10, dryRun: true, chunkSize: 1 });
    expect(result.removedRuns.map((run) => run.runId)).toEqual(["terminal-leaf"]);
    expect(result.rowsByTable).toMatchObject({ _smithers_events: 1, _smithers_runs: 1 });
    expect(sqlite.serialize()).toEqual(before);
  });
});
