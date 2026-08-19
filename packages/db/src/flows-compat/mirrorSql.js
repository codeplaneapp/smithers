/**
 * Writes to the legacy `_smithers_*` tables through the flows SQL client.
 *
 * The compat module keeps the legacy tables as the read model: every existing
 * reader in `adapter.js`, the gateway, and the UI keeps working unchanged. The
 * mirror write has to happen on the *flows* connection rather than on the
 * adapter's, because that is what puts it in the same write transaction as the
 * journal, run-store, and attempt-store write it accompanies.
 */
import { camelToSnake } from "../utils/camelToSnake.js";

/**
 * @param {Record<string, unknown>} row
 * @returns {{ columns: string[]; values: unknown[] }}
 */
function splitRow(row) {
  const entries = Object.entries(row).filter(([, value]) => value !== undefined);
  return {
    columns: entries.map(([key]) => camelToSnake(key)),
    values: entries.map(([, value]) => value),
  };
}

/**
 * `INSERT OR IGNORE` one row.
 *
 * @param {any} sql
 * @param {string} table
 * @param {Record<string, unknown>} row
 * @returns {any}
 */
export function insertOrIgnore(sql, table, row) {
  const { columns, values } = splitRow(row);
  const placeholders = columns.map(() => "?").join(", ");
  return sql.unsafe(`INSERT OR IGNORE INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`, values);
}

/**
 * Upsert one row on a known key.
 *
 * @param {any} sql
 * @param {string} table
 * @param {Record<string, unknown>} row
 * @param {string[]} keys camelCase key columns
 * @returns {any}
 */
export function upsertRow(sql, table, row, keys) {
  const { columns, values } = splitRow(row);
  const keyColumns = keys.map((key) => camelToSnake(key));
  const updates = columns.filter((column) => !keyColumns.includes(column));
  const placeholders = columns.map(() => "?").join(", ");
  const conflict =
    updates.length === 0
      ? "DO NOTHING"
      : `DO UPDATE SET ${updates.map((column) => `${column} = excluded.${column}`).join(", ")}`;
  return sql.unsafe(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})
     ON CONFLICT (${keyColumns.join(", ")}) ${conflict}`,
    values,
  );
}

/**
 * Update rows matching a `WHERE` fragment, returning the updated key column.
 *
 * `RETURNING` is what makes the affected-row count available without a second
 * statement, so a compare-and-set answer and its write stay one round trip.
 *
 * @param {any} sql
 * @param {string} table
 * @param {Record<string, unknown>} patch
 * @param {string} where a `WHERE` fragment with `?` placeholders
 * @param {unknown[]} whereParams
 * @param {string} [keyColumn]
 * @returns {any} an effect yielding one row per updated row
 */
export function updateWhereReturning(sql, table, patch, where, whereParams, keyColumn = "run_id") {
  const { columns, values } = splitRow(patch);
  const assignments = columns.map((column) => `${column} = ?`).join(", ");
  return sql.unsafe(`UPDATE ${table} SET ${assignments} WHERE ${where} RETURNING ${keyColumn}`, [
    ...values,
    ...whereParams,
  ]);
}
