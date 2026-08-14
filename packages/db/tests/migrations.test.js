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
  return sqlite.query("SELECT id, destructive, details_json FROM _smithers_schema_migrations ORDER BY id").all();
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
      sqlite.run("DROP TRIGGER _smithers_snapshot_payload_refs_insert");
      ensureSmithersTables(db);
      expect(
        sqlite
          .query(
            "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = '_smithers_snapshot_payload_refs_insert'",
          )
          .get(),
      ).toBeDefined();
      expect(migrationRows(sqlite).map((row) => row.id)).toEqual(
        expect.arrayContaining([
          "0001_current_tables",
          "0013_run_owned_foreign_keys",
          "0014_current_indexes",
          "0017_add_scorer_context_columns",
          "0018_add_docs",
          "0037_agent_checkpoints",
        ]),
      );
    } finally {
      sqlite.close();
    }
  });

  test("0037 repairs missing agent checkpoint tables and index idempotently", () => {
    const { sqlite, db } = setupMemoryDb();
    try {
      sqlite.run("DROP TABLE _smithers_agent_checkpoints");
      sqlite.run("DROP TABLE _smithers_agent_checkpoint_contents");
      sqlite.run("DELETE FROM _smithers_schema_migrations WHERE id = '0037_agent_checkpoints'");
      ensureSmithersTables(db);
      expect(
        sqlite
          .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_smithers_agent_checkpoint_contents'")
          .get(),
      ).toBeDefined();
      expect(
        sqlite
          .query('PRAGMA table_info("_smithers_agent_checkpoint_contents")')
          .all()
          .find((column) => column.name === "content_hash")?.notnull,
      ).toBe(1);
      expect(
        sqlite
          .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_smithers_agent_checkpoints'")
          .get(),
      ).toBeDefined();
      expect(
        sqlite
          .query(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = '_smithers_agent_checkpoints_content_hash_idx'",
          )
          .get(),
      ).toBeDefined();
      expect(
        sqlite
          .query(
            "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = '_smithers_agent_checkpoints_attempt_delete'",
          )
          .get(),
      ).toBeDefined();
      sqlite.run("DROP TRIGGER _smithers_agent_checkpoints_attempt_delete");
      expect(() => ensureSmithersTables(db)).not.toThrow();
      expect(
        sqlite
          .query(
            "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = '_smithers_agent_checkpoints_attempt_delete'",
          )
          .get(),
      ).toBeDefined();
      expect(migrationRows(sqlite).filter((row) => row.id === "0037_agent_checkpoints")).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });

  test("0037 converges stores that recorded the preview 0035 checkpoint id", () => {
    const { sqlite, db } = setupMemoryDb();
    try {
      sqlite.run(
        "UPDATE _smithers_schema_migrations SET id = '0035_agent_checkpoints' WHERE id = '0037_agent_checkpoints'",
      );

      expect(() => ensureSmithersTables(db)).not.toThrow();

      const ids = migrationRows(sqlite).map((row) => row.id);
      expect(ids).toContain("0035_agent_checkpoints");
      expect(ids).toContain("0037_agent_checkpoints");
    } finally {
      sqlite.close();
    }
  });

  test("0037 fails closed when a recorded checkpoint table has an incompatible shape", () => {
    const { sqlite, db } = setupMemoryDb();
    try {
      sqlite.run("DROP TRIGGER _smithers_agent_checkpoints_attempt_delete");
      sqlite.run("DROP TRIGGER _smithers_agent_checkpoint_refs_delete");
      sqlite.run("DROP TABLE _smithers_agent_checkpoints");
      sqlite.run("CREATE TABLE _smithers_agent_checkpoints (run_id TEXT PRIMARY KEY)");
      expect(() => ensureSmithersTables(db)).toThrow(/0037 agent checkpoint schema mismatch/);
    } finally {
      sqlite.close();
    }
  });

  test("legacy integration deliveries reopen as completed claims after migration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-integration-mig-"));
    const dbPath = join(dir, "store.sqlite");
    try {
      const legacy = new Database(dbPath);
      legacy.exec(`
        CREATE TABLE _smithers_integration_deliveries (
          source_id TEXT NOT NULL,
          dedupe_key TEXT NOT NULL,
          event_name TEXT NOT NULL,
          received_at_ms INTEGER NOT NULL,
          PRIMARY KEY (source_id, dedupe_key)
        );
        INSERT INTO _smithers_integration_deliveries
          (source_id, dedupe_key, event_name, received_at_ms)
        VALUES ('github', 'legacy-guid', 'integration:github:push', 1234);
      `);
      legacy.close();

      const reopened = new Database(dbPath);
      const db = drizzle(reopened);
      ensureSmithersTables(db);

      const columns = reopened
        .query('PRAGMA table_info("_smithers_integration_deliveries")')
        .all()
        .map((column) => column.name);
      expect(columns).toEqual(
        expect.arrayContaining(["status", "claim_token", "claim_expires_at_ms", "completed_at_ms"]),
      );
      expect(
        reopened
          .query(
            `SELECT status, claim_token, claim_expires_at_ms
        FROM _smithers_integration_deliveries
        WHERE source_id = 'github' AND dedupe_key = 'legacy-guid'`,
          )
          .get(),
      ).toEqual({
        status: "completed",
        claim_token: null,
        claim_expires_at_ms: null,
      });
      expect(migrationRows(reopened).map((row) => row.id)).toContain("0029_integration_delivery_claims");

      const adapter = new SmithersDb(db);
      expect(
        await adapter.claimIntegrationDelivery(
          {
            sourceId: "github",
            dedupeKey: "legacy-guid",
            eventName: "integration:github:push",
            receivedAtMs: 9999,
          },
          { ownerToken: "new-worker", nowMs: 10_000 },
        ),
      ).toMatchObject({
        status: "completed",
        receivedAtMs: 1234,
      });
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("snapshot storage migration is additive and preserves compressed prototype rows", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE _smithers_snapshots (
        run_id TEXT NOT NULL,
        frame_no INTEGER NOT NULL,
        nodes_json TEXT NOT NULL,
        outputs_json TEXT NOT NULL,
        ralph_json TEXT NOT NULL,
        input_json TEXT NOT NULL,
        vcs_pointer TEXT,
        workflow_hash TEXT,
        content_hash TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        payload_hash TEXT,
        PRIMARY KEY (run_id, frame_no)
      );
      CREATE TABLE _smithers_snapshot_payloads (
        content_hash TEXT PRIMARY KEY,
        payload_b64 TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      );
      INSERT INTO _smithers_snapshot_payloads (content_hash, payload_b64, created_at_ms)
        VALUES ('prototype-hash', 'preserved-base64', 1);
      INSERT INTO _smithers_snapshots
        (run_id, frame_no, nodes_json, outputs_json, ralph_json, input_json, content_hash, payload_hash, created_at_ms)
        VALUES ('prototype-run', 0, '', '', '', '', 'prototype-hash', 'prototype-hash', 1);
    `);
    const before = sqlite
      .query("SELECT rootpage, sql FROM sqlite_master WHERE type = 'table' AND name = '_smithers_snapshots'")
      .get();
    ensureSmithersTables(drizzle(sqlite));
    const after = sqlite
      .query("SELECT rootpage, sql FROM sqlite_master WHERE type = 'table' AND name = '_smithers_snapshots'")
      .get();
    expect(after).toEqual(before);
    expect(sqlite.query("SELECT COUNT(*) AS count FROM _smithers_snapshots").get().count).toBe(1);
    expect(sqlite.query("SELECT COUNT(*) AS count FROM _smithers_snapshot_payloads").get().count).toBe(1);
    expect(
      sqlite
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_smithers_snapshot_contents'")
        .get(),
    ).toBeDefined();
    expect(
      sqlite
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_smithers_snapshot_payload_refs'")
        .get(),
    ).toBeDefined();
    expect(
      sqlite
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_smithers_snapshots_0024_legacy'")
        .get(),
    ).toBeNull();
    expect(migrationRows(sqlite).map((row) => row.id)).toContain("0025_snapshot_contents");
    sqlite.close();
  });

  test("drops poisoned compressed-prototype snapshot triggers so snapshot writes work again", () => {
    // A store that ran the unreleased compressed-payload prototype carries
    // AFTER INSERT/DELETE/UPDATE triggers on _smithers_snapshots whose bodies
    // update _smithers_snapshot_payloads.ref_count — a column a later
    // prototype iteration removed. SQLite compiles trigger bodies when the
    // triggering statement is prepared, so EVERY snapshot insert fails with
    // "no such column: ref_count" even though payload_hash is NULL and the
    // WHEN clause would never match.
    const sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE _smithers_snapshots (
        run_id TEXT NOT NULL,
        frame_no INTEGER NOT NULL,
        nodes_json TEXT NOT NULL,
        outputs_json TEXT NOT NULL,
        ralph_json TEXT NOT NULL,
        input_json TEXT NOT NULL,
        vcs_pointer TEXT,
        workflow_hash TEXT,
        content_hash TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        payload_hash TEXT,
        PRIMARY KEY (run_id, frame_no)
      );
      CREATE TABLE _smithers_snapshot_payloads (
        content_hash TEXT PRIMARY KEY,
        payload_b64 TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      );
      INSERT INTO _smithers_snapshot_payloads (content_hash, payload_b64, created_at_ms)
        VALUES ('prototype-hash', 'preserved-base64', 1);
      INSERT INTO _smithers_snapshots
        (run_id, frame_no, nodes_json, outputs_json, ralph_json, input_json, content_hash, payload_hash, created_at_ms)
        VALUES ('prototype-run', 0, '', '', '', '', 'prototype-hash', 'prototype-hash', 1);
      CREATE TRIGGER _smithers_snapshot_payload_insert AFTER INSERT ON _smithers_snapshots
        WHEN NEW.payload_hash IS NOT NULL BEGIN
          UPDATE _smithers_snapshot_payloads SET ref_count = ref_count + 1 WHERE content_hash = NEW.payload_hash;
        END;
      CREATE TRIGGER _smithers_snapshot_payload_delete AFTER DELETE ON _smithers_snapshots
        WHEN OLD.payload_hash IS NOT NULL BEGIN
          UPDATE _smithers_snapshot_payloads SET ref_count = ref_count - 1 WHERE content_hash = OLD.payload_hash;
          DELETE FROM _smithers_snapshot_payloads WHERE content_hash = OLD.payload_hash AND ref_count = 0;
        END;
      CREATE TRIGGER _smithers_snapshot_payload_update AFTER UPDATE OF payload_hash ON _smithers_snapshots
        WHEN OLD.payload_hash IS NOT NEW.payload_hash BEGIN
          UPDATE _smithers_snapshot_payloads SET ref_count = ref_count - 1 WHERE content_hash = OLD.payload_hash;
          DELETE FROM _smithers_snapshot_payloads WHERE content_hash = OLD.payload_hash AND ref_count = 0;
          UPDATE _smithers_snapshot_payloads SET ref_count = ref_count + 1 WHERE content_hash = NEW.payload_hash;
        END;
      CREATE TRIGGER _smithers_snapshot_payload_immutable BEFORE UPDATE ON _smithers_snapshot_payloads
        WHEN OLD.content_hash IS NOT NEW.content_hash OR OLD.payload_b64 IS NOT NEW.payload_b64
        BEGIN SELECT RAISE(ABORT, 'snapshot payloads are immutable'); END;
    `);
    // Pin the failure mode the migration must repair.
    expect(() =>
      sqlite.run(
        "INSERT INTO _smithers_snapshots (run_id, frame_no, nodes_json, outputs_json, ralph_json, input_json, content_hash, created_at_ms) VALUES ('r', 1, '{}', '{}', '{}', '{}', 'h', 2)",
      ),
    ).toThrow(/no such column: ref_count/);

    ensureSmithersTables(drizzle(sqlite));

    const triggerNames = sqlite
      .query("SELECT name FROM sqlite_master WHERE type = 'trigger'")
      .all()
      .map((row) => row.name);
    expect(triggerNames).not.toContain("_smithers_snapshot_payload_insert");
    expect(triggerNames).not.toContain("_smithers_snapshot_payload_delete");
    expect(triggerNames).not.toContain("_smithers_snapshot_payload_update");
    expect(triggerNames).not.toContain("_smithers_snapshot_payload_immutable");
    expect(triggerNames).toContain("_smithers_snapshot_payload_refs_insert");
    expect(triggerNames).toContain("_smithers_snapshots_payload_refs_cascade");
    // The regression: snapshot writes work again.
    sqlite.run(
      "INSERT INTO _smithers_snapshots (run_id, frame_no, nodes_json, outputs_json, ralph_json, input_json, content_hash, created_at_ms) VALUES ('r', 1, '{}', '{}', '{}', '{}', 'h', 2)",
    );
    expect(sqlite.query("SELECT COUNT(*) AS count FROM _smithers_snapshots").get().count).toBe(2);
    // Prototype payload rows and the payload_hash column stay readable for
    // legacy payload_b64 lookups.
    expect(sqlite.query("SELECT COUNT(*) AS count FROM _smithers_snapshot_payloads").get().count).toBe(1);
    expect(migrationRows(sqlite).map((row) => row.id)).toContain("0026_drop_snapshot_prototype_triggers");
    sqlite.close();
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

    const cols = sqlite
      .query('PRAGMA table_info("_smithers_frames")')
      .all()
      .map((c) => c.name);
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

    const cols = sqlite
      .query('PRAGMA table_info("_smithers_scorers")')
      .all()
      .map((c) => c.name);
    expect(cols).toContain("ground_truth_json");
    expect(cols).toContain("context_json");

    sqlite.run(`UPDATE _smithers_scorers SET ground_truth_json = ?, context_json = ? WHERE id = ?`, [
      JSON.stringify({ expected: "answer" }),
      JSON.stringify({ docs: ["source"] }),
      "score-legacy",
    ]);
    const row = sqlite
      .query("SELECT ground_truth_json, context_json FROM _smithers_scorers WHERE id = ?")
      .get("score-legacy");
    expect(JSON.parse(row.ground_truth_json)).toEqual({ expected: "answer" });
    expect(JSON.parse(row.context_json)).toEqual({ docs: ["source"] });
    sqlite.close();
  });

  test("forward migration deduplicates scorer identities before adding uniqueness", () => {
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
        ground_truth_json TEXT,
        context_json TEXT,
        latency_ms REAL,
        scored_at_ms INTEGER NOT NULL,
        duration_ms REAL
      );
      INSERT INTO _smithers_scorers
        (id, run_id, node_id, iteration, attempt, scorer_id, scorer_name, source, score, scored_at_ms)
      VALUES
        ('old', 'run-1', 'node-1', 0, 0, 'quality', 'Quality', 'live', 0.2, 1000),
        ('new', 'run-1', 'node-1', 0, 0, 'quality', 'Quality', 'live', 0.8, 2000),
        ('batch', 'run-1', 'node-1', 0, 0, 'quality', 'Quality', 'batch', 0.6, 1500);
    `);

    ensureSmithersTables(drizzle(sqlite));

    expect(
      sqlite
        .query("SELECT id FROM _smithers_scorers ORDER BY id")
        .all()
        .map((row) => row.id),
    ).toEqual(["batch", "new"]);
    expect(
      sqlite
        .query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = '_smithers_scorers_identity_uidx'")
        .get(),
    ).toBeDefined();
    expect(() =>
      sqlite.run(`
        INSERT INTO _smithers_scorers
          (id, run_id, node_id, iteration, attempt, scorer_id, scorer_name, source, score, scored_at_ms)
        VALUES ('duplicate', 'run-1', 'node-1', 0, 0, 'quality', 'Quality', 'live', 0.9, 3000)
      `),
    ).toThrow();
    expect(migrationRows(sqlite).map((row) => row.id)).toContain("0033_scorer_identity");
    sqlite.close();
  });

  test("0039 adds the first-class effort column; a legacy meta_json-only row reads clean", () => {
    const sqlite = new Database(":memory:");
    // Pre-0039 attempts table: NO effort column. A legacy row smuggled effort
    // inside meta_json (the old back-compat path).
    sqlite.exec(`
      CREATE TABLE _smithers_attempts (
        run_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        iteration INTEGER NOT NULL DEFAULT 0,
        attempt INTEGER NOT NULL,
        state TEXT NOT NULL,
        started_at_ms INTEGER NOT NULL,
        meta_json TEXT,
        PRIMARY KEY (run_id, node_id, iteration, attempt)
      );
      INSERT INTO _smithers_attempts (run_id, node_id, iteration, attempt, state, started_at_ms, meta_json)
        VALUES ('legacy', 'setup', 0, 1, 'finished', 1000,
          '{"agentEngine":"claude-code","agentModel":"claude-sonnet-4","effort":"high"}');
    `);
    const db = drizzle(sqlite);
    ensureSmithersTables(db);

    // The migration promoted effort to a first-class column...
    const cols = sqlite
      .query('PRAGMA table_info("_smithers_attempts")')
      .all()
      .map((c) => c.name);
    expect(cols).toContain("effort");
    expect(migrationRows(sqlite).map((row) => row.id)).toContain("0039_attempt_effort_column");

    // ...and the legacy row still reads clean: the new column is NULL (never
    // backfilled from the blob) while the old meta_json value survives intact.
    const row = sqlite.query("SELECT effort, meta_json FROM _smithers_attempts WHERE node_id = ?").get("setup");
    expect(row.effort).toBeNull();
    expect(JSON.parse(row.meta_json).effort).toBe("high");
    sqlite.close();
  });

  test("effort persists to the first-class column through the adapter round-trip", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    const adapter = new SmithersDb(db);
    await adapter.insertAttempt({
      runId: "run-1",
      nodeId: "worker",
      iteration: 0,
      attempt: 1,
      state: "finished",
      startedAtMs: 1000,
      metaJson: JSON.stringify({ agentModel: "claude-sonnet-5", effort: "xhigh" }),
      effort: "xhigh",
    });
    const attempts = await adapter.listAttemptsForRun("run-1");
    expect(attempts).toHaveLength(1);
    expect(attempts[0].effort).toBe("xhigh");
    sqlite.close();
  });

  test("0041 adds fresh-input and cost columns without losing legacy usage rows", async () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE _smithers_run_usage (
        run_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        iteration INTEGER NOT NULL DEFAULT 0,
        attempt INTEGER NOT NULL DEFAULT 0,
        model TEXT,
        agent TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (run_id, node_id, iteration, attempt)
      );
      INSERT INTO _smithers_run_usage
        (run_id, node_id, input_tokens, output_tokens, cache_read_tokens, updated_at_ms)
      VALUES ('legacy', 'work', 100, 20, 80, 1);
    `);
    const db = drizzle(sqlite);
    ensureSmithersTables(db);

    const columns = sqlite
      .query('PRAGMA table_info("_smithers_run_usage")')
      .all()
      .map((column) => column.name);
    expect(columns).toEqual(expect.arrayContaining(["fresh_input_tokens", "cost_usd"]));
    expect(migrationRows(sqlite).map((row) => row.id)).toContain("0041_run_usage_breakdown_columns");
    expect(await new SmithersDb(db).getRunTokenUsage("legacy")).toMatchObject({
      inputTokens: 100,
      freshInputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 80,
      totalTokens: 120,
      costUsd: null,
    });
    sqlite.close();
  });

  test("0014 current-indexes upgrades a store whose ledger predates _smithers_docs", () => {
    // Regression: the `_smithers_docs` index lives in the current-index list that
    // migration 0014 runs, but the table is only created by 0018. A store whose
    // ledger recorded 0001 (so 0001 won't recreate tables) but not 0014 used to
    // fail opening with "no such table: _smithers_docs" because 0014 ran the
    // index before 0018 created the table. 0014 must now skip indexes whose
    // table is absent and let 0018 create the table + its index.
    const sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE _smithers_schema_migrations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at_ms INTEGER NOT NULL,
        checksum TEXT,
        destructive INTEGER NOT NULL DEFAULT 0,
        details_json TEXT
      );
      CREATE TABLE _smithers_runs (
        run_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        heartbeat_at_ms INTEGER,
        parent_run_id TEXT,
        created_at_ms INTEGER NOT NULL
      );
      CREATE TABLE _smithers_signals (
        run_id TEXT NOT NULL,
        signal_name TEXT NOT NULL,
        correlation_id TEXT,
        received_at_ms INTEGER NOT NULL
      );
      CREATE TABLE _smithers_time_travel_audit (
        run_id TEXT NOT NULL,
        caller TEXT NOT NULL,
        timestamp_ms INTEGER NOT NULL
      );
      CREATE TABLE _smithers_alerts (
        id TEXT PRIMARY KEY,
        run_id TEXT,
        fingerprint TEXT,
        status TEXT
      );
    `);
    // Record every migration except 0014 and 0018 as already applied, so 0001
    // does not recreate tables and 0014 runs against a DB lacking _smithers_docs.
    for (const id of [
      "0001_current_tables",
      "0002_attempt_legacy_columns",
      "0003_run_legacy_columns",
      "0004_approval_payload_columns",
      "0005_alert_model_extensions",
      "0006_frame_encoding_column",
      "0011_add_node_diffs",
      "0012_add_time_travel_audit",
      "0013_run_owned_foreign_keys",
      "0015_add_workspace_states",
      "0016_add_workspace_checkpoints",
      "0017_add_scorer_context_columns",
    ]) {
      sqlite.run("INSERT INTO _smithers_schema_migrations (id, name, applied_at_ms) VALUES (?, ?, ?)", [id, id, 1]);
    }
    const db = drizzle(sqlite);

    expect(() => ensureSmithersTables(db)).not.toThrow();

    const docsTable = sqlite
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name = '_smithers_docs'")
      .get();
    expect(docsTable).toBeTruthy();
    const docsIndex = sqlite
      .query("SELECT name FROM sqlite_master WHERE type='index' AND name = '_smithers_docs_kind_live_idx'")
      .get();
    expect(docsIndex).toBeTruthy();
    sqlite.close();
  });

  test("effort, steer, and usage-breakdown migrations follow the current ledger head", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE _smithers_schema_migrations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at_ms INTEGER NOT NULL,
        checksum TEXT,
        destructive INTEGER NOT NULL DEFAULT 0,
        details_json TEXT
      );
      CREATE TABLE _smithers_runs (
        run_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      );
    `);
    // 0025_snapshot_contents is deliberately NOT pre-applied: it creates the
    // snapshot tables the post-migration trigger repair depends on, so a ledger
    // claiming 0025 without those tables is not a state a real store reaches.
    for (const id of [
      "0001_current_tables",
      "0002_attempt_legacy_columns",
      "0003_run_legacy_columns",
      "0004_approval_payload_columns",
      "0005_alert_model_extensions",
      "0006_frame_encoding_column",
      "0007_event_timestamp_column",
      "0011_add_node_diffs",
      "0012_add_time_travel_audit",
      "0013_run_owned_foreign_keys",
      "0014_current_indexes",
      "0015_add_workspace_states",
      "0016_add_workspace_checkpoints",
      "0017_add_scorer_context_columns",
      "0018_add_docs",
      "0019_add_integration_tables",
      "0020_run_pause_column",
      "0021_memory_fact_provenance_columns",
      "0022_memory_message_iteration_column",
      "0023_add_memory_notes",
      "0026_drop_snapshot_prototype_triggers",
      "0027_add_rewind_leases",
      "0028_sandbox_heartbeat_column",
      "0029_integration_delivery_claims",
      "0030_output_provenance",
      "0031_side_effect_journal",
      "0032_tool_call_tokens",
    ]) {
      sqlite.run("INSERT INTO _smithers_schema_migrations (id, name, applied_at_ms) VALUES (?, ?, ?)", [id, id, 1]);
    }
    const db = drizzle(sqlite);

    expect(() => ensureSmithersTables(db)).not.toThrow();

    const table = sqlite.query("SELECT name FROM sqlite_master WHERE type='table' AND name = '_smithers_steers'").get();
    expect(table).toBeTruthy();
    const index = sqlite
      .query("SELECT name FROM sqlite_master WHERE type='index' AND name = '_smithers_steers_queued_idx'")
      .get();
    expect(index).toBeTruthy();
    const ledger = migrationRows(sqlite).map((row) => row.id);
    expect(ledger).toEqual(
      expect.arrayContaining([
        "0035_ralph_exhausted",
        "0036_agent_processes",
        "0037_agent_checkpoints",
        "0038_run_token_usage",
        "0039_attempt_effort_column",
        "0040_add_steers",
        "0041_run_usage_breakdown_columns",
      ]),
    );
    sqlite.close();
  });

  test("all preview effort/steer ledger aliases coexist and converge to the 0039/0040 ids", () => {
    const { sqlite, db } = setupMemoryDb();
    try {
      sqlite.run("DELETE FROM _smithers_schema_migrations WHERE id IN (?, ?)", [
        "0039_attempt_effort_column",
        "0040_add_steers",
      ]);
      for (const id of [
        "0035_attempt_effort_column",
        "0036_add_steers",
        "0036_attempt_effort_column",
        "0037_add_steers",
      ]) {
        sqlite.run("INSERT INTO _smithers_schema_migrations (id, name, applied_at_ms) VALUES (?, ?, ?)", [id, id, 1]);
      }
      sqlite.run("DROP INDEX _smithers_steers_queued_idx");

      expect(() => ensureSmithersTables(db)).not.toThrow();

      const ids = migrationRows(sqlite).map((row) => row.id);
      expect(ids).toEqual(
        expect.arrayContaining([
          "0035_attempt_effort_column",
          "0036_add_steers",
          "0036_attempt_effort_column",
          "0037_add_steers",
          "0039_attempt_effort_column",
          "0040_add_steers",
        ]),
      );
      expect(ids).toContain("0037_agent_checkpoints");
      expect(
        sqlite
          .query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = '_smithers_steers_queued_idx'")
          .get(),
      ).toBeDefined();
    } finally {
      sqlite.close();
    }
  });

  test("0040 repairs a missing or malformed owned queued index even with a recorded ledger row", () => {
    const { sqlite, db } = setupMemoryDb();
    try {
      sqlite.run("DROP INDEX _smithers_steers_queued_idx");
      expect(() => ensureSmithersTables(db)).not.toThrow();
      expect(
        sqlite
          .query('PRAGMA index_info("_smithers_steers_queued_idx")')
          .all()
          .map((row) => row.name),
      ).toEqual(["run_id", "node_id", "status", "created_at_ms"]);

      sqlite.run("DROP INDEX _smithers_steers_queued_idx");
      sqlite.run("CREATE UNIQUE INDEX _smithers_steers_queued_idx ON _smithers_steers (status, run_id)");
      expect(() => ensureSmithersTables(db)).not.toThrow();
      const index = sqlite
        .query('PRAGMA index_list("_smithers_steers")')
        .all()
        .find((row) => row.name === "_smithers_steers_queued_idx");
      expect(index.unique).toBe(0);
      expect(index.partial).toBe(0);
      expect(
        sqlite
          .query('PRAGMA index_info("_smithers_steers_queued_idx")')
          .all()
          .map((row) => row.name),
      ).toEqual(["run_id", "node_id", "status", "created_at_ms"]);
    } finally {
      sqlite.close();
    }
  });

  test("0037 fails closed on incompatible table and wrong-owner index collisions", () => {
    const malformed = setupMemoryDb();
    try {
      malformed.sqlite.run("DROP TABLE _smithers_steers");
      malformed.sqlite.run("CREATE TABLE _smithers_steers (steer_id TEXT PRIMARY KEY)");
      expect(() => ensureSmithersTables(malformed.db)).toThrow(/0040 steer schema mismatch/);
    } finally {
      malformed.sqlite.close();
    }

    const wrongOwner = setupMemoryDb();
    try {
      wrongOwner.sqlite.run("DROP INDEX _smithers_steers_queued_idx");
      wrongOwner.sqlite.run(`CREATE TABLE unrelated_steers (
        run_id TEXT, node_id TEXT, status TEXT, created_at_ms INTEGER
      )`);
      wrongOwner.sqlite.run(
        "CREATE INDEX _smithers_steers_queued_idx ON unrelated_steers (run_id, node_id, status, created_at_ms)",
      );
      expect(() => ensureSmithersTables(wrongOwner.db)).toThrow(/queued index name is owned by another table/);
    } finally {
      wrongOwner.sqlite.close();
    }
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
      const cfg = sqlite.query("SELECT config_json FROM _smithers_runs WHERE run_id = ?").get("bad-cfg-run");
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
      const frame = sqlite.query("SELECT xml_json FROM _smithers_frames WHERE run_id = ?").get("bad-xml-run");
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

      const back = ctx.sqlite.query("SELECT xml_json FROM _smithers_frames WHERE run_id = ?").get("big-run");
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

      for (const table of ["_smithers_frames", "_smithers_node_diffs", "_smithers_time_travel_audit"]) {
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

      const cols = sqlite
        .query('PRAGMA table_info("_smithers_runs")')
        .all()
        .map((c) => c.name);
      expect(cols).toContain("heartbeat_at_ms");
      const indexes = sqlite
        .query('PRAGMA index_list("_smithers_runs")')
        .all()
        .map((i) => i.name);
      expect(indexes).toContain("_smithers_runs_status_heartbeat_idx");
    } finally {
      sqlite.close();
    }
  });

  test("forward migration adds pause_requested_at_ms to a legacy runs table", () => {
    const sqlite = new Database(":memory:");
    try {
      sqlite.exec(`CREATE TABLE _smithers_runs (
        run_id TEXT PRIMARY KEY,
        workflow_name TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        cancel_requested_at_ms INTEGER
      )`);
      const db = drizzle(sqlite);
      expect(() => ensureSmithersTables(db)).not.toThrow();

      const cols = sqlite
        .query('PRAGMA table_info("_smithers_runs")')
        .all()
        .map((c) => c.name);
      expect(cols).toContain("pause_requested_at_ms");
    } finally {
      sqlite.close();
    }
  });

  test("forward migration adds nullable cancellation attribution to legacy runs", async () => {
    const sqlite = new Database(":memory:");
    try {
      sqlite.exec(`CREATE TABLE _smithers_runs (
        run_id TEXT PRIMARY KEY,
        workflow_name TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        cancel_requested_at_ms INTEGER
      );
      INSERT INTO _smithers_runs
        (run_id, workflow_name, status, created_at_ms, cancel_requested_at_ms)
      VALUES ('legacy-cancel', 'wf', 'cancelled', 1, 2)`);
      const db = drizzle(sqlite);
      ensureSmithersTables(db);

      const columns = sqlite
        .query('PRAGMA table_info("_smithers_runs")')
        .all()
        .map((column) => column.name);
      expect(columns).toEqual(
        expect.arrayContaining([
          "cancel_request_id",
          "cancel_request_source",
          "cancel_request_client_identity",
          "cancel_request_client_pid",
        ]),
      );
      expect(await new SmithersDb(db).getRun("legacy-cancel")).toMatchObject({
        cancelRequestedAtMs: 2,
        cancelRequestId: null,
        cancelRequestSource: null,
        cancelRequestClientIdentity: null,
        cancelRequestClientPid: null,
      });
      expect(migrationRows(sqlite).map((row) => row.id)).toContain("0034_run_cancellation_attribution");
    } finally {
      sqlite.close();
    }
  });

  test("v0.19-shaped DB upgrades through FK rebuild once and records dropped row counts", () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    const originalWarn = console.warn;
    const originalLog = console.log;
    /** @type {unknown[][]} */
    const warnings = [];
    /** @type {string[]} */
    const structuredLogs = [];
    console.warn = (...args) => {
      warnings.push(args);
    };
    console.log = (...args) => {
      structuredLogs.push(args.map(String).join(" "));
    };
    const destructiveNotices = () =>
      structuredLogs.filter((line) => line.includes("dropped") && line.includes("orphan run-owned rows"));
    try {
      createV019RunOwnedSchema(sqlite);
      ensureSmithersTables(db);

      for (const table of ["_smithers_frames", "_smithers_node_diffs", "_smithers_time_travel_audit"]) {
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

      // The destructive-migration notice routes through the structured logger
      // (level=WARN + db:schema-migration span reach the observability sink),
      // never console.warn.
      expect(warnings).toHaveLength(0);
      const notices = destructiveNotices();
      expect(notices).toHaveLength(1);
      // Effect 4's default logger renders "[time] WARN (#fiber)" instead of
      // logfmt "level=WARN"; assert the level token format-agnostically.
      expect(notices[0]).toMatch(/level=WARN|\bWARN\b/);
      expect(notices[0]).toContain("0013_run_owned_foreign_keys");
      expect(notices[0]).toContain("db:schema-migration");

      const rowsAfterFirstRun = migrationRows(sqlite);
      ensureSmithersTables(db);
      expect(migrationRows(sqlite)).toEqual(rowsAfterFirstRun);
      // The idempotent re-run drops nothing, so no second notice is emitted.
      expect(destructiveNotices()).toHaveLength(1);
    } finally {
      console.warn = originalWarn;
      console.log = originalLog;
      sqlite.close();
    }
  });

  test("migrations 0011 and 0012 produce the expected node_diffs + audit tables", () => {
    const { sqlite } = setupMemoryDb();
    try {
      const diffCols = sqlite
        .query('PRAGMA table_info("_smithers_node_diffs")')
        .all()
        .map((c) => c.name);
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
