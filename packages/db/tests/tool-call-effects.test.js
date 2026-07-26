import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq, getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { ensureSmithersTables } from "../src/ensure.js";
import { smithersToolCallArchive, smithersToolCalls } from "../src/internal-schema.js";

const effectColumns = [
  "call_token",
  "kind",
  "side_effect",
  "idempotent",
  "accepts_idempotency_key",
  "has_revert",
  "idempotency_key",
  "revert_status",
  "reverted_at_ms",
  "revert_error_json",
  "forced_past_json",
];

describe("tool-call effect journal schema", () => {
  test("forward-migrates a seeded legacy journal without reclassifying existing rows", () => {
    const sqlite = new Database(":memory:");
    try {
      sqlite.exec(`
                CREATE TABLE _smithers_tool_calls (
                    run_id TEXT NOT NULL,
                    node_id TEXT NOT NULL,
                    iteration INTEGER NOT NULL DEFAULT 0,
                    attempt INTEGER NOT NULL,
                    seq INTEGER NOT NULL,
                    tool_name TEXT NOT NULL,
                    input_json TEXT,
                    output_json TEXT,
                    started_at_ms INTEGER NOT NULL,
                    finished_at_ms INTEGER,
                    status TEXT NOT NULL,
                    error_json TEXT,
                    PRIMARY KEY (run_id, node_id, iteration, attempt, seq)
                );
                INSERT INTO _smithers_tool_calls
                    (run_id, node_id, iteration, attempt, seq, tool_name, started_at_ms, status)
                VALUES ('legacy-run', 'publish', 0, 1, 1, 'post-message', 100, 'started');
            `);

      ensureSmithersTables(drizzle(sqlite));

      const columns = sqlite
        .query("PRAGMA table_info(_smithers_tool_calls)")
        .all()
        .map((row) => row.name);
      expect(columns).toEqual(expect.arrayContaining(effectColumns));
      const legacy = sqlite
        .query(`
                SELECT call_token, kind, side_effect, idempotent, accepts_idempotency_key,
                       has_revert, idempotency_key, revert_status, reverted_at_ms,
                       revert_error_json, forced_past_json
                FROM _smithers_tool_calls
                WHERE run_id = 'legacy-run'
            `)
        .get();
      expect(Object.values(legacy)).toEqual(effectColumns.map(() => null));
      expect(
        sqlite
          .query(`
                SELECT id FROM _smithers_schema_migrations
                WHERE id = '0031_side_effect_journal'
            `)
          .get(),
      ).toBeDefined();
      expect(
        sqlite
          .query(`
                SELECT id FROM _smithers_schema_migrations
                WHERE id = '0032_tool_call_tokens'
            `)
          .get(),
      ).toBeDefined();
      expect(
        sqlite
          .query(`
                SELECT name FROM sqlite_master
                WHERE type = 'table' AND name = '_smithers_tool_call_archive'
            `)
          .get(),
      ).toBeDefined();
    } finally {
      sqlite.close();
    }
  });

  test("archive table round-trips the live journal columns plus archive provenance", () => {
    const sqlite = new Database(":memory:");
    try {
      ensureSmithersTables(drizzle(sqlite));
      sqlite
        .query(`
                INSERT INTO _smithers_tool_call_archive (
                    run_id, node_id, iteration, attempt, seq, tool_name,
                    call_token,
                    input_json, output_json, started_at_ms, finished_at_ms,
                    status, error_json, kind, side_effect, idempotent,
                    accepts_idempotency_key, has_revert, idempotency_key,
                    revert_status, reverted_at_ms, revert_error_json,
                    forced_past_json, archived_by_op, archived_at_ms, archive_reason
                ) VALUES (
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                )
            `)
        .run(
          "run-1",
          "publish",
          2,
          3,
          4,
          "post-message",
          "call-token-1",
          '{"channel":"alerts"}',
          '{"id":"m-1"}',
          100,
          200,
          "succeeded",
          null,
          "tool",
          1,
          0,
          1,
          1,
          "effect-key",
          "reverted",
          300,
          null,
          '[{"opId":"force-1"}]',
          "rewind-1",
          400,
          "rewind",
        );

      expect(
        sqlite
          .query(`
                SELECT * FROM _smithers_tool_call_archive
                WHERE run_id = 'run-1' AND archived_by_op = 'rewind-1'
            `)
          .get(),
      ).toEqual({
        run_id: "run-1",
        node_id: "publish",
        iteration: 2,
        attempt: 3,
        seq: 4,
        tool_name: "post-message",
        call_token: "call-token-1",
        input_json: '{"channel":"alerts"}',
        output_json: '{"id":"m-1"}',
        started_at_ms: 100,
        finished_at_ms: 200,
        status: "succeeded",
        error_json: null,
        kind: "tool",
        side_effect: 1,
        idempotent: 0,
        accepts_idempotency_key: 1,
        has_revert: 1,
        idempotency_key: "effect-key",
        revert_status: "reverted",
        reverted_at_ms: 300,
        revert_error_json: null,
        forced_past_json: '[{"opId":"force-1"}]',
        archived_by_op: "rewind-1",
        archived_at_ms: 400,
        archive_reason: "rewind",
      });
    } finally {
      sqlite.close();
    }
  });

  test("exports both current Drizzle journal tables", () => {
    expect(getTableName(smithersToolCalls)).toBe("_smithers_tool_calls");
    expect(getTableName(smithersToolCallArchive)).toBe("_smithers_tool_call_archive");
    expect(smithersToolCalls.revertStatus.enumValues).toEqual([
      "reverting",
      "reverted",
      "revert-failed",
      "revert-stale",
    ]);
    expect(smithersToolCallArchive.revertStatus.enumValues).toEqual(smithersToolCalls.revertStatus.enumValues);
    expect(getTableConfig(smithersToolCalls).indexes).toContainEqual(
      expect.objectContaining({
        config: expect.objectContaining({
          name: "_smithers_tool_calls_call_token_uidx",
          unique: true,
        }),
      }),
    );
  });

  test("selects a live journal row by callToken through the public schema object", async () => {
    const sqlite = new Database(":memory:");
    try {
      const db = drizzle(sqlite);
      ensureSmithersTables(db);
      sqlite
        .query(`
                INSERT INTO _smithers_tool_calls
                    (run_id, node_id, iteration, attempt, seq, call_token,
                     tool_name, started_at_ms, status)
                VALUES ('run-token', 'publish', 0, 1, 1, 'public-call-token',
                        'publish', 1, 'intended')
            `)
        .run();

      const rows = await db
        .select({
          runId: smithersToolCalls.runId,
          callToken: smithersToolCalls.callToken,
        })
        .from(smithersToolCalls)
        .where(eq(smithersToolCalls.callToken, "public-call-token"));

      expect(rows).toEqual([
        {
          runId: "run-token",
          callToken: "public-call-token",
        },
      ]);
    } finally {
      sqlite.close();
    }
  });

  test("enforces unique non-null call tokens on live and archive rows", () => {
    const sqlite = new Database(":memory:");
    try {
      ensureSmithersTables(drizzle(sqlite));
      const insertLive = sqlite.query(`
                INSERT INTO _smithers_tool_calls
                    (run_id, node_id, iteration, attempt, seq, call_token,
                     tool_name, started_at_ms, status)
                VALUES (?, ?, 0, 1, 1, ?, 'publish', 1, 'intended')
            `);
      insertLive.run("run-a", "node-a", "token-a");
      expect(() => insertLive.run("run-b", "node-b", "token-a")).toThrow();

      const insertArchive = sqlite.query(`
                INSERT INTO _smithers_tool_call_archive
                    (run_id, node_id, iteration, attempt, seq, call_token,
                     tool_name, started_at_ms, status, archived_by_op,
                     archived_at_ms, archive_reason)
                VALUES (?, ?, 0, 1, 1, ?, 'publish', 1, 'intended',
                        ?, 2, 'rewind')
            `);
      insertArchive.run("run-a", "node-a", "archive-token-a", "op-a");
      expect(() => insertArchive.run("run-b", "node-b", "archive-token-a", "op-b")).toThrow();
    } finally {
      sqlite.close();
    }
  });
});
