/**
 * Persistence/replay edges for the SQLite schema applied by
 * `ensureSmithersTables`. Tests cover legacy-row upgrades, JSON validity at
 * the deserialize boundary, and large-blob round-trips. Some FK tests are
 * skipped because the schema does not declare any FOREIGN KEY constraints
 * (see FIXMEs).
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

  test("inserting row with FK violation is NOT rejected — schema declares no FKs", () => {
    // FIXME: prod code does not declare any FOREIGN KEY constraints between
    // `_smithers_runs` / `_smithers_frames` / `_smithers_node_diffs`. Once
    // FK constraints are added, this test should be flipped: inserting an
    // attempt with a missing run_id should throw. For now, we document
    // current behavior so a future contract change is caught.
    const { sqlite } = setupMemoryDb();
    try {
      sqlite.exec("PRAGMA foreign_keys = ON");
      // Insert a frame for a run that does not exist in _smithers_runs.
      expect(() =>
        sqlite.run(
          `INSERT INTO _smithers_frames (run_id, frame_no, created_at_ms, xml_json, xml_hash)
           VALUES (?, ?, ?, ?, ?)`,
          ["nonexistent", 0, 1, "{}", "h"],
        ),
      ).not.toThrow();
      // Also: a node_diff with a missing parent run/node is silently accepted.
      expect(() =>
        sqlite.run(
          `INSERT INTO _smithers_node_diffs (run_id, node_id, iteration, base_ref, diff_json, computed_at_ms, size_bytes)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ["ghost-run", "ghost-node", 0, "ref", "{}", 1, 2],
        ),
      ).not.toThrow();
    } finally {
      sqlite.close();
    }
  });

  test.skip("FIXME: deleting a run cascades to _smithers_node_diffs / frames / audit", () => {
    // FIXME: skipped because the schema declares no FKs — see the test above.
    // When ON DELETE CASCADE constraints are introduced, this test should
    // delete a run row and verify all child rows are gone in one statement.
  });

  test("re-inserting same primary key into _smithers_frames is rejected (constraint enforcement)", () => {
    const { sqlite } = setupMemoryDb();
    try {
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

  test.skip("FIXME: forward-migration partial failure on legacy _smithers_runs throws because index references a column that hasn't been added yet", () => {
    // FIXME (real bug surfaced): when a legacy database has an old
    // `_smithers_runs` table missing `heartbeat_at_ms`, calling
    // `ensureSmithersTables` throws "no such column: heartbeat_at_ms" because
    // CREATE_TABLE_STATEMENTS creates the index `_smithers_runs_status_heartbeat_idx`
    // BEFORE MIGRATION_STATEMENTS runs `ALTER TABLE _smithers_runs ADD COLUMN
    // heartbeat_at_ms`. The CREATE_TABLE_STATEMENTS loop has no try/catch, so
    // the throw propagates to the caller.
    //
    // Repro:
    //   const sqlite = new Database(":memory:");
    //   sqlite.exec(`CREATE TABLE _smithers_runs (
    //     run_id TEXT PRIMARY KEY, workflow_name TEXT NOT NULL,
    //     status TEXT NOT NULL, created_at_ms INTEGER NOT NULL
    //   )`);
    //   ensureSmithersTables(drizzle(sqlite)); // throws SQLiteError
    //
    // Fix: either (a) wrap CREATE INDEX statements in try/catch or (b) run
    // ALTER TABLEs BEFORE CREATE INDEX statements, or (c) make the index
    // creation idempotent + lazy. Per task rules we leave this skipped.
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
