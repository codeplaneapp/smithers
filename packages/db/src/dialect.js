/**
 * SQL dialect seam for the Smithers persistence layer.
 *
 * Smithers' storage was authored against SQLite (bun:sqlite). This module is the
 * single source of truth for the handful of places where SQLite and PostgreSQL
 * SQL diverge, so the same hand-written SQL the adapter emits can run unchanged
 * against either backend:
 *
 *   - placeholder style: SQLite `?` vs PostgreSQL `$1, $2, …`
 *   - DDL types: SQLite's permissive `INTEGER`/`REAL`/`BLOB` vs PostgreSQL's
 *     stricter `BIGINT`/`DOUBLE PRECISION`/`BYTEA` (millisecond timestamps stored
 *     in `INTEGER` overflow PostgreSQL's 32-bit `integer`, hence `BIGINT`)
 *   - autoincrement: `INTEGER PRIMARY KEY AUTOINCREMENT` vs `BIGSERIAL PRIMARY KEY`
 *   - schema introspection: `PRAGMA table_info` vs `information_schema.columns`
 *   - transaction start: `BEGIN IMMEDIATE` (SQLite write-lock) vs `BEGIN`
 *
 * Identifier quoting (`"x"`), `ON CONFLICT … DO UPDATE SET … = excluded.…`, and
 * `CREATE TABLE/INDEX IF NOT EXISTS` are already standard across both dialects,
 * so they need no translation.
 *
 * @typedef {"sqlite" | "postgres"} Dialect
 */

export const SQLITE = /** @type {const} */ ("sqlite");
export const POSTGRES = /** @type {const} */ ("postgres");

/**
 * @param {unknown} value
 * @returns {value is Dialect}
 */
export function isDialect(value) {
    return value === SQLITE || value === POSTGRES;
}

/**
 * @param {string} identifier
 * @returns {string}
 */
export function quoteIdentifier(identifier) {
    return `"${String(identifier).replaceAll(`"`, `""`)}"`;
}

/**
 * Rewrite positional `?` placeholders to PostgreSQL's `$1, $2, …`. SQLite keeps
 * `?`. A `?` inside a string literal, quoted identifier, or comment is left
 * untouched so only real placeholders are renumbered.
 *
 * @param {Dialect} dialect
 * @param {string} sql
 * @returns {string}
 */
export function translatePlaceholders(dialect, sql) {
    if (dialect !== POSTGRES) {
        return sql;
    }
    let out = "";
    let index = 1;
    let inSingle = false;
    let inDouble = false;
    let inLineComment = false;
    let inBlockComment = false;
    for (let i = 0; i < sql.length; i++) {
        const ch = sql[i];
        const next = sql[i + 1];
        if (inLineComment) {
            out += ch;
            if (ch === "\n") inLineComment = false;
            continue;
        }
        if (inBlockComment) {
            out += ch;
            if (ch === "*" && next === "/") {
                out += next;
                i++;
                inBlockComment = false;
            }
            continue;
        }
        if (inSingle) {
            out += ch;
            if (ch === "'") {
                if (next === "'") {
                    out += next;
                    i++;
                } else {
                    inSingle = false;
                }
            }
            continue;
        }
        if (inDouble) {
            out += ch;
            if (ch === `"`) {
                if (next === `"`) {
                    out += next;
                    i++;
                } else {
                    inDouble = false;
                }
            }
            continue;
        }
        if (ch === "'") {
            inSingle = true;
            out += ch;
            continue;
        }
        if (ch === `"`) {
            inDouble = true;
            out += ch;
            continue;
        }
        if (ch === "-" && next === "-") {
            inLineComment = true;
            out += ch;
            continue;
        }
        if (ch === "/" && next === "*") {
            inBlockComment = true;
            out += ch;
            continue;
        }
        if (ch === "?") {
            out += `$${index++}`;
            continue;
        }
        out += ch;
    }
    return out;
}

/**
 * Map a single SQLite column type keyword (`INTEGER`, `REAL`, `BLOB`, `TEXT`) to
 * the dialect equivalent. Used by the Zod→DDL generator for schema-derived
 * columns such as `INTEGER`, `REAL`, and `TEXT`.
 *
 * @param {Dialect} dialect
 * @param {string} sqliteType
 * @returns {string}
 */
export function columnType(dialect, sqliteType) {
    if (dialect !== POSTGRES) {
        return sqliteType;
    }
    switch (sqliteType.toUpperCase()) {
        case "INTEGER":
            return "BIGINT";
        case "REAL":
            return "DOUBLE PRECISION";
        case "BLOB":
            return "BYTEA";
        default:
            return sqliteType;
    }
}

/**
 * Translate a complete `CREATE TABLE`/`CREATE INDEX` statement written in SQLite
 * DDL to the target dialect. Only the controlled, internal Smithers DDL passes
 * through here (no user-supplied text), so keyword-level regex substitution is
 * safe. Order matters: the autoincrement primary key is rewritten before the
 * blanket `INTEGER → BIGINT` so it is not double-translated.
 *
 * @param {Dialect} dialect
 * @param {string} ddl
 * @returns {string}
 */
export function translateDdl(dialect, ddl) {
    if (dialect !== POSTGRES) {
        return ddl;
    }
    return ddl
        .replace(/\bINTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/gi, "BIGSERIAL PRIMARY KEY")
        .replace(/\s+AUTOINCREMENT\b/gi, "")
        .replace(/\bBLOB\b/gi, "BYTEA")
        .replace(/\bREAL\b/gi, "DOUBLE PRECISION")
        .replace(/\bINTEGER\b/gi, "BIGINT");
}

/**
 * SQL that lists the column names of a table, normalized to rows shaped
 * `{ name: string }`.
 *
 * @param {Dialect} dialect
 * @param {string} table
 * @returns {{ sql: string; params: ReadonlyArray<string> }}
 */
export function tableColumnsSql(dialect, table) {
    if (dialect === POSTGRES) {
        return {
            sql: "SELECT column_name AS name FROM information_schema.columns WHERE table_name = ? AND table_schema = current_schema()",
            params: [table],
        };
    }
    return {
        sql: `PRAGMA table_info(${quoteIdentifier(table)})`,
        params: [],
    };
}

/**
 * The statement that begins a write transaction. SQLite takes the write lock
 * eagerly with `BEGIN IMMEDIATE`; PostgreSQL uses a plain `BEGIN`.
 *
 * @param {Dialect} dialect
 * @returns {string}
 */
export function beginTransactionSql(dialect) {
    return dialect === POSTGRES ? "BEGIN" : "BEGIN IMMEDIATE";
}

/**
 * A scalar SQL expression extracting a top-level string field from a JSON column
 * stored as TEXT. SQLite uses `json_extract(col, '$.key')`; PostgreSQL casts to
 * `json` and uses the `->>` operator. Only simple top-level paths (`$.key`) are
 * used in Smithers' queries.
 *
 * @param {Dialect} dialect
 * @param {string} columnSql Already-quoted/qualified column expression.
 * @param {string} jsonPath SQLite-style path, e.g. `$.nodeId`.
 * @returns {string}
 */
export function jsonExtractText(dialect, columnSql, jsonPath) {
    if (dialect === POSTGRES) {
        const key = jsonPath.replace(/^\$\./, "").replace(/'/g, "''");
        return `(${columnSql}::json->>'${key}')`;
    }
    return `json_extract(${columnSql}, '${jsonPath.replace(/'/g, "''")}')`;
}
