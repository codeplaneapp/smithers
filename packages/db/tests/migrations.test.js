/**
 * Persistence/replay edges for the SQLite schema applied by
 * `ensureSmithersTables`. Tests cover legacy-row upgrades, JSON validity at
 * the deserialize boundary, large-blob round-trips, and the tracked
 * migration ledger used to gate destructive schema changes.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ensureSmithersTables } from "../src/ensure.js";
import { SmithersDb } from "../src/adapter/SmithersDb.js";

/**
 * Open a real on-disk SQLite DB in WAL mode (some round-trip cases benefit
 * from the disk path so the WAL file actually exists). Returns helpers to
 * tear down the temp dir.
 */
function setupDiskDb() {
  const dir = mkdtempSync(join(tmpdir(), "smithers-db-mig-"));
  const dbPath = join(dir, "store.sqlite");
  const sqlite = new Database(dbPath);
  sqlite.exec("PRAGMA journal_mode = WAL");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return {
    dir,
    dbPath,
    sqlite,
    db,
    adapter: new SmithersDb(db),
    cleanup() {
      try {
        sqlite.close();
      } catch {
        // best-effort
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function setupMemoryDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { sqlite, db, adapter: new SmithersDb(db) };
}

function migrationRows(sqlite) {
  return sqlite
    .query('SELECT id, destructive, details_json FROM _smithers_schema_migrations ORDER BY id')
    .all();
}

function createV019RunOwnedSchema(sqlite) {
  sqlite.exec(`
    CREATE TABLE _smithers_runs (
      run_id TEXT PRIMARY KEY,
      workflow_name TEXT NOT NULL,
      workflow_path TEXT,
      workflow_hash TEXT,
      status TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      started_at_ms INTEGER,
      finished_at_ms INTEGER,
      heartbeat_at_ms INTEGER,
      runtime_owner_id TEXT,
      cancel_requested_at_ms INTEGER,
      hijack_requested_at_ms INTEGER,
      hijack_target TEXT,
      vcs_type TEXT,
      vcs_root TEXT,
      vcs_revision TEXT,
      parent_run_id TEXT,
      error_json TEXT,
      config_json TEXT
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
    CREATE TABLE _smithers_node_diffs (
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      iteration INTEGER NOT NULL,
      base_ref TEXT NOT NULL,
      diff_json TEXT NOT NULL,
      computed_at_ms INTEGER NOT NULL,
      size_bytes INTEGER NOT NULL,
      PRIMARY KEY (run_id, node_id, iteration, base_ref)
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
    INSERT INTO _smithers_runs (run_id, workflow_name, status, created_at_ms)
      VALUES ('valid-run', 'wf', 'running', 1);
    INSERT INTO _smithers_frames (run_id, frame_no, created_at_ms, xml_json, xml_hash)
      VALUES ('valid-run', 0, 2, '{}', 'hash-valid');
    INSERT INTO _smithers_frames (run_id, frame_no, created_at_ms, xml_json, xml_hash)
      VALUES ('orphan-run', 0, 3, '{}', 'hash-orphan');
    INSERT INTO _smithers_node_diffs (run_id, node_id, iteration, base_ref, diff_json, computed_at_ms, size_bytes)
      VALUES ('valid-run', 'node', 0, 'base', '{}', 4, 2);
    INSERT INTO _smithers_node_diffs (run_id, node_id, iteration, base_ref, diff_json, computed_at_ms, size_bytes)
      VALUES ('orphan-run', 'node', 0, 'base', '{}', 5, 2);
    INSERT INTO _smithers_time_travel_audit (run_id, from_frame_no, to_frame_no, caller, timestamp_ms, result)
      VALUES ('valid-run', 0, 0, 'test', 6, 'ok');
    INSERT INTO _smithers_time_travel_audit (run_id, from_frame_no, to_frame_no, caller, timestamp_ms, result)
      VALUES ('orphan-run', 0, 0, 'test', 7, 'ok');
  `);
}

describe("DB migration edges", () => {
  test("forward migration is idempotent — running ensure twice is a no-op", () => {
    const { sqlite, db } = setupMemoryDb();
    try {
      // Re-applying must not throw and must leave the table list stable.
      const beforeTables = sqlite
        .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all()
        .map((r) => r.name);
      expect(() => ensureSmithersTables(db)).not.toThrow();
      const afterTables = sqlite
        .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all()
        .map((r) => r.name);
      expect(afterTables).toEqual(beforeTables);
      expect(afterTables).toContain("_smithers_schema_migrations");
      expect(migrationRows(sqlite).map((row) => row.id)).toEqual(
        expect.arrayContaining([
          "0001_current_tables",
          "0013_run_owned_foreign_keys",
          "0014_current_indexes",
        ]),
      );
    } finally {
      sqlite.close();
    }
  });

  test("forward migration over a partially populated legacy DB upgrades schema without dropping rows", () => {
    // Simulate a legacy state: only the old _smithers_frames table exists with
    // a row, plus _smithers_approvals missing the new payload columns. Running
    // ensure must add the new columns AND keep the row intact.
    const sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE _smithers_frames (
        run_id TEXT NOT NULL,
        frame_no INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL,
        xml_json TEXT NOT NULL,
        xml_hash TEXT NOT NULL,
        PRIMARY KEY (run_id, frame_no)
      );
      INSERT INTO _smithers_frames (run_id, frame_no, created_at_ms, xml_json, xml_hash)
        VALUES ('legacy', 0, 1, '{"kind":"element"}', 'hash');
      CREATE TABLE _smithers_runs (
        run_id TEXT PRIMARY KEY,
        workflow_name TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      );
      INSERT INTO _smithers_runs (run_id, workflow_name, status, created_at_ms)
        VALUES ('legacy', 'wf', 'running', 1);
    `);
    const db = drizzle(sqlite);
    ensureSmithersTables(db);

    const cols = sqlite.query('PRAGMA table_info("_smithers_frames")').all().map((c) => c.name);
    expect(cols).toContain("encoding");

    const row = sqlite.query("SELECT run_id, encoding FROM _smithers_frames").get();
    // Auto-upgrade path: legacy row must be readable and have encoding
    // defaulted to 'full'.
    expect(row.run_id).toBe("legacy");
    expect(row.encoding).toBe("full");
    sqlite.close();
  });

  test("forward migration adds scorer context columns to legacy scorer tables", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE _smithers_scorers (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        iteration INTEGER NOT NULL DEFAULT 0,
        attempt INTEGER NOT NULL DEFAULT 0,
        scorer_id TEXT NOT NULL,
        scorer_name TEXT NOT NULL,
        source TEXT NOT NULL,
        score REAL NOT NULL,
        reason TEXT,
        meta_json TEXT,
        input_json TEXT,
        output_json TEXT,
        latency_ms REAL,
        scored_at_ms INTEGER NOT NULL,
        duration_ms REAL
      );
      INSERT INTO _smithers_scorers (id, run_id, node_id, scorer_id, scorer_name, source, score, scored_at_ms)
        VALUES ('score-legacy', 'run-1', 'node-1', 'accuracy', 'Accuracy', 'batch', 0.8, 1000);
    `);
    const db = drizzle(sqlite);
    ensureSmithersTables(db);

    const cols = sqlite.query('PRAGMA table_info("_smithers_scorers")').all().map((c) => c.name);
    expect(cols).toContain("ground_truth_json");
    expect(cols).toContain("context_json");

    sqlite.run(
      `UPDATE _smithers_scorers SET ground_truth_json = ?, context_json = ? WHERE id = ?`,
      [
        JSON.stringify({ expected: "answer" }),
        JSON.stringify({ docs: ["source"] }),
        "score-legacy",
      ],
    );
    const row = sqlite
      .query("SELECT ground_truth_json, context_json FROM _smithers_scorers WHERE id = ?")
      .get("score-legacy");
    expect(JSON.parse(row.ground_truth_json)).toEqual({ expected: "answer" });
    expect(JSON.parse(row.context_json)).toEqual({ docs: ["source"] });
    sqlite.close();
  });

  test("malformed JSON in valueJson / xmlJson / configJson is caught at deserialize layer with a useful error", () => {
    // The DB stores TEXT — so writing arbitrary bytes succeeds. The contract
    // is that the deserialize layer (JSON.parse on read) surfaces the
    // problem clearly. We exercise that contract here against
    // `_smithers_frames.xml_json`, `_smithers_runs.config_json`, and
    // `_smithers_memory_facts.value_json`.
    const { sqlite } = setupMemoryDb();
    try {
      sqlite.run(
        `INSERT INTO _smithers_runs (run_id, workflow_name, status, created_at_ms, config_json)
         VALUES (?, ?, ?, ?, ?)`,
        ["bad-cfg-run", "wf", "running", 1, "{not-valid-json"],
      );
      const cfg = sqlite
        .query("SELECT config_json FROM _smithers_runs WHERE run_id = ?")
        .get("bad-cfg-run");
      // Round-trip preserves the bytes — corruption is not caught at write.
      expect(cfg.config_json).toBe("{not-valid-json");
      // Deserialize must throw a SyntaxError which the caller can wrap.
      expect(() => JSON.parse(cfg.config_json)).toThrow(SyntaxError);

      sqlite.run(
        `INSERT INTO _smithers_runs (run_id, workflow_name, status, created_at_ms)
         VALUES (?, ?, ?, ?)`,
        ["bad-xml-run", "wf", "running", 1],
      );
      sqlite.run(
        `INSERT INTO _smithers_frames (run_id, frame_no, created_at_ms, xml_json, xml_hash)
         VALUES (?, ?, ?, ?, ?)`,
        ["bad-xml-run", 0, 1, "{garbage", "h"],
      );
      const frame = sqlite
        .query("SELECT xml_json FROM _smithers_frames WHERE run_id = ?")
        .get("bad-xml-run");
      let parsed;
      let parseErr;
      try {
        parsed = JSON.parse(frame.xml_json);
      } catch (err) {
        parseErr = err;
      }
      expect(parsed).toBeUndefined();
      expect(parseErr).toBeInstanceOf(SyntaxError);
      // Useful message: the SyntaxError includes a JSON position and is not
      // a cryptic SQLite error — that is the user-facing guarantee.
      expect(String(parseErr)).toMatch(/JSON|Unexpected|Expected/);

      sqlite.run(
        `INSERT INTO _smithers_memory_facts (namespace, key, value_json, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?)`,
        ["ns", "k", "<<<not-json>>>", 1, 1],
      );
      const fact = sqlite
        .query("SELECT value_json FROM _smithers_memory_facts WHERE namespace = ? AND key = ?")
        .get("ns", "k");
      expect(() => JSON.parse(fact.value_json)).toThrow();
    } finally {
      sqlite.close();
    }
  });

  test("oversized JSON blob (~10 MB) round-trips through SQLite WAL", () => {
    const ctx = setupDiskDb();
    try {
      // Build a ~10 MB JSON payload. The default SQLITE_MAX_LENGTH is 1 GB,
      // so a 10 MB blob is well within bounds — the test is here so a future
      // BLOB-size cap regression fails loudly.
      const blobChars = 10 * 1024 * 1024;
      const blobValue = "x".repeat(blobChars);
      const giant = JSON.stringify({ blob: blobValue });
      expect(giant.length).toBeGreaterThan(blobChars);

      ctx.sqlite.run(
        `INSERT INTO _smithers_runs (run_id, workflow_name, status, created_at_ms)
         VALUES (?, ?, ?, ?)`,
        ["big-run", "wf", "running", 1],
      );
      ctx.sqlite.run(
        `INSERT INTO _smithers_frames (run_id, frame_no, created_at_ms, xml_json, xml_hash)
         VALUES (?, ?, ?, ?, ?)`,
        ["big-run", 0, 1, giant, "hash"],
      );

      const row = ctx.sqlite
        .query("SELECT length(xml_json) AS n FROM _smithers_frames WHERE run_id = ?")
        .get("big-run");
      expect(row.n).toBe(giant.length);

      // WAL file should exist on disk for an on-disk DB after a write.
      // (We don't assert the exact path — different bun-sqlite builds may
      // pre-allocate differently; the important behavior is that the row is
      // intact across a checkpoint.)
      ctx.sqlite.exec("PRAGMA wal_checkpoint(FULL)");

      const back = ctx.sqlite
        .query("SELECT xml_json FROM _smithers_frames WHERE run_id = ?")
        .get("big-run");
      expect(back.xml_json.length).toBe(giant.length);
      expect(JSON.parse(back.xml_json).blob.length).toBe(blobChars);
    } finally {
      ctx.cleanup();
    }
  });

  test("run-owned frames and node diffs reject missing runs", () => {
    const { sqlite } = setupMemoryDb();
    try {
      sqlite.exec("PRAGMA foreign_keys = ON");
      expect(() =>
        sqlite.run(
          `INSERT INTO _smithers_frames (run_id, frame_no, created_at_ms, xml_json, xml_hash)
           VALUES (?, ?, ?, ?, ?)`,
          ["nonexistent", 0, 1, "{}", "h"],
        ),
      ).toThrow(/FOREIGN KEY/i);
      expect(() =>
        sqlite.run(
          `INSERT INTO _smithers_node_diffs (run_id, node_id, iteration, base_ref, diff_json, computed_at_ms, size_bytes)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ["ghost-run", "ghost-node", 0, "ref", "{}", 1, 2],
        ),
      ).toThrow(/FOREIGN KEY/i);
    } finally {
      sqlite.close();
    }
  });

  test("deleting a run cascades to frames, node diffs, and time-travel audit", () => {
    const { sqlite } = setupMemoryDb();
    try {
      sqlite.exec("PRAGMA foreign_keys = ON");
      sqlite.run(
        `INSERT INTO _smithers_runs (run_id, workflow_name, status, created_at_ms)
         VALUES (?, ?, ?, ?)`,
        ["cascade-run", "wf", "running", 1],
      );
      sqlite.run(
        `INSERT INTO _smithers_nodes (run_id, node_id, iteration, state, updated_at_ms, output_table)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ["cascade-run", "node-a", 0, "finished", 2, "output"],
      );
      sqlite.run(
        `INSERT INTO _smithers_frames (run_id, frame_no, created_at_ms, xml_json, xml_hash)
         VALUES (?, ?, ?, ?, ?)`,
        ["cascade-run", 0, 3, "{}", "hash"],
      );
      sqlite.run(
        `INSERT INTO _smithers_node_diffs (run_id, node_id, iteration, base_ref, diff_json, computed_at_ms, size_bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ["cascade-run", "node-a", 0, "base", "{}", 4, 2],
      );
      sqlite.run(
        `INSERT INTO _smithers_time_travel_audit (run_id, from_frame_no, to_frame_no, caller, timestamp_ms, result)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ["cascade-run", 0, 0, "test", 5, "ok"],
      );

      sqlite.run(`DELETE FROM _smithers_runs WHERE run_id = ?`, ["cascade-run"]);

      for (const table of [
        "_smithers_frames",
        "_smithers_node_diffs",
        "_smithers_time_travel_audit",
      ]) {
        const row = sqlite.query(`SELECT COUNT(*) AS count FROM ${table}`).get();
        expect(row.count).toBe(0);
      }
    } finally {
      sqlite.close();
    }
  });

  test("re-inserting same primary key into _smithers_frames is rejected (constraint enforcement)", () => {
    const { sqlite } = setupMemoryDb();
    try {
      sqlite.run(
        `INSERT INTO _smithers_runs (run_id, workflow_name, status, created_at_ms)
         VALUES (?, ?, ?, ?)`,
        ["dup-run", "wf", "running", 1],
      );
      sqlite.run(
        `INSERT INTO _smithers_frames (run_id, frame_no, created_at_ms, xml_json, xml_hash)
         VALUES (?, ?, ?, ?, ?)`,
        ["dup-run", 0, 1, "{}", "h"],
      );
      expect(() =>
        sqlite.run(
          `INSERT INTO _smithers_frames (run_id, frame_no, created_at_ms, xml_json, xml_hash)
           VALUES (?, ?, ?, ?, ?)`,
          ["dup-run", 0, 1, "{}", "h"],
        ),
      ).toThrow(/UNIQUE|PRIMARY/i);
    } finally {
      sqlite.close();
    }
  });

  test("forward migration adds run heartbeat column before creating heartbeat index", () => {
    const sqlite = new Database(":memory:");
    try {
      sqlite.exec(`CREATE TABLE _smithers_runs (
        run_id TEXT PRIMARY KEY,
        workflow_name TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      )`);
      const db = drizzle(sqlite);
      expect(() => ensureSmithersTables(db)).not.toThrow();

      const cols = sqlite.query('PRAGMA table_info("_smithers_runs")').all().map((c) => c.name);
      expect(cols).toContain("heartbeat_at_ms");
      const indexes = sqlite.query('PRAGMA index_list("_smithers_runs")').all().map((i) => i.name);
      expect(indexes).toContain("_smithers_runs_status_heartbeat_idx");
    } finally {
      sqlite.close();
    }
  });

  test("v0.19-shaped DB upgrades through FK rebuild once and records dropped row counts", () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    const originalWarn = console.warn;
    /** @type {unknown[][]} */
    const warnings = [];
    console.warn = (...args) => {
      warnings.push(args);
    };
    try {
      createV019RunOwnedSchema(sqlite);
      ensureSmithersTables(db);

      for (const table of [
        "_smithers_frames",
        "_smithers_node_diffs",
        "_smithers_time_travel_audit",
      ]) {
        const fks = sqlite.query(`PRAGMA foreign_key_list("${table}")`).all();
        expect(fks).toContainEqual(
          expect.objectContaining({
            from: "run_id",
            table: "_smithers_runs",
            to: "run_id",
            on_delete: "CASCADE",
          }),
        );
        expect(sqlite.query(`SELECT COUNT(*) AS count FROM ${table} WHERE run_id = 'orphan-run'`).get().count).toBe(0);
      }

      const migration = sqlite
        .query(`SELECT destructive, details_json FROM _smithers_schema_migrations WHERE id = ?`)
        .get("0013_run_owned_foreign_keys");
      expect(Boolean(migration.destructive)).toBe(true);
      const details = JSON.parse(migration.details_json);
      expect(details.tables.map((row) => row.droppedCount)).toEqual([1, 1, 1]);
      expect(warnings).toHaveLength(1);
      expect(String(warnings[0][0])).toContain("0013_run_owned_foreign_keys");

      const rowsAfterFirstRun = migrationRows(sqlite);
      ensureSmithersTables(db);
      expect(migrationRows(sqlite)).toEqual(rowsAfterFirstRun);
      expect(warnings).toHaveLength(1);
    } finally {
      console.warn = originalWarn;
      sqlite.close();
    }
  });

  test("migrations 0011 and 0012 produce the expected node_diffs + audit tables", () => {
    const { sqlite } = setupMemoryDb();
    try {
      const diffCols = sqlite.query('PRAGMA table_info("_smithers_node_diffs")').all().map((c) => c.name);
      expect(diffCols.sort()).toEqual([
        "base_ref",
        "computed_at_ms",
        "diff_json",
        "iteration",
        "node_id",
        "run_id",
        "size_bytes",
      ]);
      const auditCols = sqlite
        .query('PRAGMA table_info("_smithers_time_travel_audit")')
        .all()
        .map((c) => c.name);
      expect(auditCols).toEqual(
        expect.arrayContaining([
          "id",
          "run_id",
          "from_frame_no",
          "to_frame_no",
          "caller",
          "timestamp_ms",
          "result",
          "duration_ms",
        ]),
      );
      const indexes = sqlite
        .query('PRAGMA index_list("_smithers_time_travel_audit")')
        .all()
        .map((i) => i.name);
      expect(indexes).toContain("_smithers_time_travel_audit_lookup_idx");
    } finally {
      sqlite.close();
    }
  });
});
