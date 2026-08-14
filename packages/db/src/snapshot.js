import { eq, getTableName } from "drizzle-orm";
import { getTableColumns } from "drizzle-orm/utils";
import { Effect, Option } from "effect";
import { toSmithersError } from "@smthrs/errors/toSmithersError";
import { SmithersError } from "@smthrs/errors/SmithersError";
/** @typedef {Record<string, Array<unknown>>} OutputSnapshot */
// This is deliberately a distinct, enumerable transport field. A symbol is
// lost by spreads and JSON storage, while a user-owned `seq` field must never
// be mistaken for runtime provenance.
export const OUTPUT_PROVENANCE_SEQ = "__smithersProvenanceSeq";
/** @typedef {import("drizzle-orm/bun-sqlite").BunSQLiteDatabase} BunSQLiteDatabase */
/** @typedef {import("drizzle-orm").Table} _Table */

/**
 * @param {_Table} table
 * @returns {string[]}
 */
function getBooleanColumnKeys(table) {
  try {
    const cols = getTableColumns(table);
    const keys = [];
    for (const [key, col] of Object.entries(cols)) {
      const c = /** @type {Record<string, unknown> & { config?: { mode?: string }; mapFromDriverValue?: unknown }} */ (
        /** @type {unknown} */ (col)
      );
      const mapFn = /** @type {{ toString?: () => string } | undefined} */ (c?.mapFromDriverValue);
      if (
        c?.columnType === "SQLiteBoolean" ||
        c?.config?.mode === "boolean" ||
        c?.mode === "boolean" ||
        mapFn?.toString?.().includes("Boolean") ||
        c?.dataType === "boolean"
      ) {
        keys.push(key);
      }
    }
    return keys;
  } catch {
    return [];
  }
}
/**
 * Keys of every json-mode column on the table. zodToTable maps any
 * array/object/union/complex Zod field to a Drizzle `text(col,{mode:'json'})`
 * column, which Drizzle's bun:sqlite reader auto-decodes on read. The Postgres
 * path stores those as TEXT, so we must JSON.parse them to match.
 * @param {_Table} table
 * @returns {string[]}
 */
export function getJsonColumnKeys(table) {
  try {
    const cols = getTableColumns(table);
    const keys = [];
    for (const [key, col] of Object.entries(cols)) {
      const c = /** @type {Record<string, unknown> & { config?: { mode?: string } }} */ (/** @type {unknown} */ (col));
      if (
        c?.columnType === "SQLiteTextJson" ||
        c?.config?.mode === "json" ||
        c?.mode === "json" ||
        c?.dataType === "json"
      ) {
        keys.push(key);
      }
    }
    return keys;
  } catch {
    return [];
  }
}
/**
 * @param {ReadonlyArray<Record<string, unknown>>} rows
 * @param {readonly string[]} boolKeys
 * @returns {Array<Record<string, unknown>>}
 */
function coerceBooleanColumns(rows, boolKeys) {
  if (boolKeys.length === 0) return rows.slice();
  return rows.map((row) => {
    if (!row) return row;
    /** @type {Record<string, unknown>} */
    const patched = { ...row };
    for (const key of boolKeys) {
      if (key in patched && typeof patched[key] !== "boolean") {
        patched[key] = Boolean(patched[key]);
      }
    }
    return patched;
  });
}
/**
 * @param {unknown} db
 * @returns {boolean}
 */
export function isPostgresDb(db) {
  return Boolean(
    db &&
    typeof db === "object" &&
    /** @type {any} */ (db).dialect === "postgres" &&
    /** @type {any} */ (db).connection,
  );
}
/**
 * Map a raw node-postgres row (snake_case columns, JSON stored as TEXT) into the
 * shape Drizzle's bun:sqlite reader returns (camelCase keys, json-mode columns
 * decoded), so input/output consumers stay dialect-agnostic. `jsonKeys` is the
 * set of camelCase json-mode column keys (from getJsonColumnKeys); every TEXT
 * value for those columns is JSON.parsed to match Drizzle's mode:'json' read.
 * The literal `payload` column is always decoded so callers that omit `jsonKeys`
 * (single-value outputs) keep working.
 * @param {Record<string, unknown>} row
 * @param {readonly string[]} [jsonKeys]
 * @returns {Record<string, unknown>}
 */
export function pgRowToDrizzle(row, jsonKeys) {
  /** @type {Record<string, unknown>} */
  const out = {};
  const jsonSet = new Set(jsonKeys ?? []);
  for (const [columnName, value] of Object.entries(row)) {
    const camel = columnName.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    if ((camel === "payload" || jsonSet.has(camel)) && typeof value === "string") {
      try {
        out[camel] = JSON.parse(value);
      } catch {
        out[camel] = value;
      }
    } else {
      out[camel] = value;
    }
  }
  return out;
}
/**
 * @param {BunSQLiteDatabase<Record<string, unknown>>} db
 * @param {_Table} inputTable
 * @param {string} runId
 * @returns {Effect.Effect<Record<string, unknown> | undefined, SmithersError>}
 */
export function loadInputEffect(db, inputTable, runId) {
  return Effect.suspend(() => {
    const cols = getTableColumns(inputTable);
    const runIdCol = cols.runId;
    if (!runIdCol) {
      return Effect.fail(new SmithersError("DB_MISSING_COLUMNS", "schema.input must include runId column"));
    }
    if (isPostgresDb(db)) {
      const tableName = getTableName(inputTable).replaceAll(`"`, `""`);
      const jsonKeys = getJsonColumnKeys(inputTable);
      return Effect.tryPromise({
        try: () =>
          db.connection
            .query({ text: `SELECT * FROM "${tableName}" WHERE run_id = $1 LIMIT 1`, values: [runId] })
            .then((result) => (result.rows[0] ? pgRowToDrizzle(result.rows[0], jsonKeys) : undefined)),
        catch: (cause) =>
          toSmithersError(cause, "load input", {
            code: "DB_QUERY_FAILED",
            details: { runId },
          }),
      });
    }
    return Effect.tryPromise({
      try: () => db.select().from(inputTable).where(eq(runIdCol, runId)).limit(1),
      catch: (cause) =>
        toSmithersError(cause, "load input", {
          code: "DB_QUERY_FAILED",
          details: { runId },
        }),
    }).pipe(Effect.map((rows) => rows[0]));
  }).pipe(Effect.annotateLogs({ runId }), Effect.withLogSpan("db:load-input"));
}
/**
 * @param {BunSQLiteDatabase<Record<string, unknown>>} db
 * @param {_Table} inputTable
 * @param {string} runId
 * @returns {Promise<Record<string, unknown> | undefined>}
 */
export function loadInput(db, inputTable, runId) {
  return Effect.runPromise(loadInputEffect(db, inputTable, runId));
}
/**
 * @param {BunSQLiteDatabase<Record<string, unknown>>} db
 * @param {Record<string, _Table | unknown>} schema
 * @param {string} runId
 * @returns {Effect.Effect<OutputSnapshot, SmithersError>}
 */
export function loadOutputsEffect(db, schema, runId) {
  return Effect.gen(function* () {
    /** @type {Record<string, ReadonlyArray<Record<string, unknown>>>} */
    const out = {};
    for (const [key, table] of Object.entries(schema)) {
      if (!table || typeof table !== "object") continue;
      if (key === "input") continue;
      const colsOpt = yield* Effect.try({
        try: () => getTableColumns(/** @type {_Table} */ (table)),
        catch: (cause) =>
          toSmithersError(cause, "get table columns", { code: "DB_QUERY_FAILED", details: { runId, schemaKey: key } }),
      }).pipe(Effect.option);
      if (Option.isNone(colsOpt)) continue;
      const cols = colsOpt.value;
      const runIdCol = cols.runId;
      if (!runIdCol) continue;
      const tableNameOpt = yield* Effect.try({
        try: () => getTableName(/** @type {_Table} */ (table)),
        catch: (cause) =>
          toSmithersError(cause, "get table name", { code: "DB_QUERY_FAILED", details: { runId, schemaKey: key } }),
      }).pipe(Effect.option);
      if (Option.isNone(tableNameOpt)) continue;
      const tableName = tableNameOpt.value;
      const jsonKeys = getJsonColumnKeys(/** @type {_Table} */ (table));
      const rawRows = yield* Effect.tryPromise({
        try: () =>
          isPostgresDb(db)
            ? db.connection
                .query({
                  text: `SELECT * FROM "${tableName.replaceAll(`"`, `""`)}" WHERE run_id = $1`,
                  values: [runId],
                })
                .then((result) => result.rows.map((r) => pgRowToDrizzle(r, jsonKeys)))
            : db.select().from(/** @type {_Table} */ (table)).where(eq(runIdCol, runId)),
        catch: (cause) =>
          toSmithersError(cause, `load outputs ${tableName}`, {
            code: "DB_QUERY_FAILED",
            details: { runId, tableName },
          }),
      });
      const boolKeys = getBooleanColumnKeys(/** @type {_Table} */ (table));
      const rows = coerceBooleanColumns(rawRows, boolKeys);
      let provenance = [];
      try {
        provenance = isPostgresDb(db)
          ? (yield* Effect.promise(() =>
              db.connection.query({
                text: `SELECT node_id, iteration, seq FROM _smithers_output_provenance WHERE run_id = $1 AND output_table = $2`,
                values: [runId, tableName],
              }),
            )).rows
          : db.session.client
              .query(
                `SELECT node_id, iteration, seq FROM _smithers_output_provenance WHERE run_id = ? AND output_table = ?`,
              )
              .all(runId, tableName);
      } catch (cause) {
        yield* Effect.logWarning("output provenance unavailable; legacy rows will be excluded").pipe(
          Effect.annotateLogs({
            runId,
            tableName,
            cause: String(cause),
          }),
        );
      }
      const seqByKey = new Map(
        provenance.map((row) => [`${row.nodeId ?? row.node_id}::${Number(row.iteration ?? 0)}`, Number(row.seq)]),
      );
      for (const row of rows) {
        const seq = seqByKey.get(`${row.nodeId}::${Number(row.iteration ?? 0)}`);
        if (seq !== undefined) row[OUTPUT_PROVENANCE_SEQ] = seq;
      }
      const missingProvenance = rows.filter((row) => row[OUTPUT_PROVENANCE_SEQ] === undefined).length;
      if (missingProvenance > 0) {
        yield* Effect.logWarning("output rows missing durable provenance; outputRows will reject them").pipe(
          Effect.annotateLogs({
            runId,
            tableName,
            missingProvenance,
          }),
        );
      }
      out[tableName] = rows;
      out[key] = rows;
    }
    return /** @type {OutputSnapshot} */ (/** @type {unknown} */ (out));
  }).pipe(Effect.annotateLogs({ runId }), Effect.withLogSpan("db:load-outputs"));
}
/**
 * @param {BunSQLiteDatabase<Record<string, unknown>>} db
 * @param {Record<string, _Table | unknown>} schema
 * @param {string} runId
 * @returns {Promise<OutputSnapshot>}
 */
export function loadOutputs(db, schema, runId) {
  return Effect.runPromise(loadOutputsEffect(db, schema, runId));
}
/**
 * Coerce one freshly-selected output row into the exact shape loadOutputs
 * returns for that table (boolean-mode columns coerced to JS booleans; json
 * columns are already decoded by the select paths). Lets callers that maintain
 * an incremental outputs snapshot keep patched rows byte-equivalent to a full
 * loadOutputs reload.
 * @param {_Table} table
 * @param {Record<string, unknown>} row
 * @returns {Record<string, unknown>}
 */
export function coerceOutputRowForSnapshot(table, row) {
  return coerceBooleanColumns([row], getBooleanColumnKeys(table))[0];
}
/**
 * Read every row of a single output table for a run, returning Drizzle-shaped
 * rows (camelCase keys, boolean columns coerced to JS booleans). Dialect-aware:
 * Drizzle for bun:sqlite, a raw `$n` query for the Postgres descriptor.
 * @param {unknown} db
 * @param {_Table} table
 * @param {string} [runId]
 * @returns {Effect.Effect<Array<Record<string, unknown>>, SmithersError>}
 */
export function loadRunOutputRowsEffect(db, table, runId) {
  return Effect.gen(function* () {
    const cols = getTableColumns(table);
    const runIdCol = cols.runId;
    const tableName = getTableName(table);
    const boolKeys = getBooleanColumnKeys(table);
    const jsonKeys = getJsonColumnKeys(table);
    const rawRows = yield* Effect.tryPromise({
      try: () => {
        if (isPostgresDb(db)) {
          const escaped = tableName.replaceAll(`"`, `""`);
          const text =
            runId && runIdCol ? `SELECT * FROM "${escaped}" WHERE run_id = $1` : `SELECT * FROM "${escaped}"`;
          const values = runId && runIdCol ? [runId] : [];
          return db.connection
            .query({ text, values })
            .then((result) => result.rows.map((r) => pgRowToDrizzle(r, jsonKeys)));
        }
        return runId && runIdCol ? db.select().from(table).where(eq(runIdCol, runId)) : db.select().from(table);
      },
      catch: (cause) =>
        toSmithersError(cause, `load run output ${tableName}`, {
          code: "DB_QUERY_FAILED",
          details: { runId, tableName },
        }),
    });
    return coerceBooleanColumns(rawRows, boolKeys);
  }).pipe(Effect.annotateLogs({ runId: runId ?? "" }), Effect.withLogSpan("db:load-run-output"));
}
