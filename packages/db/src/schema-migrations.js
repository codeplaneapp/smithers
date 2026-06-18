import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { POSTGRES, translateDdl } from "./dialect.js";
import { smithersSchemaMigrations } from "./internal-schema/smithersSchemaMigrations.js";

const MIGRATION_TABLE_SQL = `CREATE TABLE IF NOT EXISTS _smithers_schema_migrations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at_ms INTEGER NOT NULL,
    checksum TEXT,
    destructive INTEGER NOT NULL DEFAULT 0,
    details_json TEXT
  )`;

const RUN_OWNED_FOREIGN_KEY_TABLES = [
    {
        table: "_smithers_frames",
        columns: [
            "run_id",
            "frame_no",
            "created_at_ms",
            "xml_json",
            "xml_hash",
            "encoding",
            "mounted_task_ids_json",
            "task_index_json",
            "note",
        ],
        defaults: { encoding: "'full'" },
    },
    {
        table: "_smithers_node_diffs",
        columns: [
            "run_id",
            "node_id",
            "iteration",
            "base_ref",
            "diff_json",
            "computed_at_ms",
            "size_bytes",
        ],
    },
    {
        table: "_smithers_time_travel_audit",
        columns: [
            "id",
            "run_id",
            "from_frame_no",
            "to_frame_no",
            "caller",
            "timestamp_ms",
            "result",
            "duration_ms",
        ],
    },
];

const LEGACY_COLUMN_MIGRATIONS = [
    {
        id: "0002_attempt_legacy_columns",
        name: "Add legacy attempt operational columns",
        table: "_smithers_attempts",
        columns: [
            ["response_text", "response_text TEXT"],
            ["jj_cwd", "jj_cwd TEXT"],
            ["heartbeat_at_ms", "heartbeat_at_ms INTEGER"],
            ["heartbeat_data_json", "heartbeat_data_json TEXT"],
            ["cached", "cached INTEGER DEFAULT 0"],
            ["meta_json", "meta_json TEXT"],
        ],
    },
    {
        id: "0003_run_legacy_columns",
        name: "Add legacy run operational columns",
        table: "_smithers_runs",
        columns: [
            ["workflow_hash", "workflow_hash TEXT"],
            ["heartbeat_at_ms", "heartbeat_at_ms INTEGER"],
            ["runtime_owner_id", "runtime_owner_id TEXT"],
            ["cancel_requested_at_ms", "cancel_requested_at_ms INTEGER"],
            ["hijack_requested_at_ms", "hijack_requested_at_ms INTEGER"],
            ["hijack_target", "hijack_target TEXT"],
            ["vcs_type", "vcs_type TEXT"],
            ["vcs_root", "vcs_root TEXT"],
            ["vcs_revision", "vcs_revision TEXT"],
            ["parent_run_id", "parent_run_id TEXT"],
            ["error_json", "error_json TEXT"],
            ["config_json", "config_json TEXT"],
        ],
    },
    {
        id: "0004_approval_payload_columns",
        name: "Add approval payload columns",
        table: "_smithers_approvals",
        columns: [
            ["request_json", "request_json TEXT"],
            ["decision_json", "decision_json TEXT"],
            ["auto_approved", "auto_approved INTEGER NOT NULL DEFAULT 0"],
        ],
    },
    {
        id: "0005_alert_model_extensions",
        name: "Add alert model extension columns",
        table: "_smithers_alerts",
        columns: [
            ["fingerprint", "fingerprint TEXT"],
            ["node_id", "node_id TEXT"],
            ["iteration", "iteration INTEGER"],
            ["owner", "owner TEXT"],
            ["runbook", "runbook TEXT"],
            ["labels_json", "labels_json TEXT"],
            ["reaction_json", "reaction_json TEXT"],
            ["source_event_type", "source_event_type TEXT"],
            ["first_fired_at_ms", "first_fired_at_ms INTEGER"],
            ["last_fired_at_ms", "last_fired_at_ms INTEGER"],
            ["occurrence_count", "occurrence_count INTEGER DEFAULT 1"],
            ["silenced_until_ms", "silenced_until_ms INTEGER"],
            ["acknowledged_by", "acknowledged_by TEXT"],
            ["resolved_by", "resolved_by TEXT"],
        ],
    },
    {
        id: "0006_frame_encoding_column",
        name: "Add frame encoding column",
        table: "_smithers_frames",
        columns: [["encoding", "encoding TEXT NOT NULL DEFAULT 'full'"]],
    },
];

const EXTRA_INDEX_STATEMENTS = [
    `CREATE INDEX IF NOT EXISTS _smithers_runs_parent_idx ON _smithers_runs (parent_run_id)`,
    `CREATE INDEX IF NOT EXISTS _smithers_alerts_fingerprint_idx ON _smithers_alerts (fingerprint)`,
    `CREATE INDEX IF NOT EXISTS _smithers_alerts_run_status_idx ON _smithers_alerts (run_id, status)`,
];

/**
 * @param {string} identifier
 * @returns {string}
 */
function quoteIdentifier(identifier) {
    return `"${identifier.replace(/"/g, "\"\"")}"`;
}

/**
 * @param {import("bun:sqlite").Database} sqlite
 * @param {string} table
 */
function tableExists(sqlite, table) {
    return Boolean(sqlite
        .query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get(table));
}

/**
 * @param {import("bun:sqlite").Database} sqlite
 * @param {string} table
 */
function tableColumnNames(sqlite, table) {
    if (!tableExists(sqlite, table)) {
        return new Set();
    }
    return new Set(sqlite
        .query(`PRAGMA table_info(${quoteIdentifier(table)})`)
        .all()
        .map((row) => row.name)
        .filter((name) => typeof name === "string"));
}

/**
 * @param {import("bun:sqlite").Database} sqlite
 * @param {string} table
 */
function tableHasRunForeignKey(sqlite, table) {
    if (!tableExists(sqlite, table)) {
        return false;
    }
    return sqlite
        .query(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`)
        .all()
        .some((row) => row.from === "run_id" &&
        row.table === "_smithers_runs" &&
        row.to === "run_id" &&
        String(row.on_delete ?? "").toUpperCase() === "CASCADE");
}

/**
 * @param {import("bun:sqlite").Database} sqlite
 * @param {string} table
 * @param {string} [whereSql]
 */
function countRows(sqlite, table, whereSql = "") {
    const row = sqlite
        .query(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)} ${whereSql}`)
        .get();
    return Number(row?.count ?? 0);
}

/**
 * @param {import("bun:sqlite").Database} sqlite
 * @param {string} table
 */
function nextLegacyTableName(sqlite, table) {
    let suffix = 0;
    while (true) {
        const candidate = `${table}__legacy_fk_${suffix}`;
        if (!tableExists(sqlite, candidate)) {
            return candidate;
        }
        suffix += 1;
    }
}

/**
 * @param {string} table
 * @param {readonly string[]} createTableStatements
 */
function createTableStatementFor(table, createTableStatements) {
    const statement = createTableStatements.find((candidate) => candidate.includes(`CREATE TABLE IF NOT EXISTS ${table} (`));
    if (!statement) {
        throw new Error(`Missing create statement for ${table}`);
    }
    return statement;
}

/**
 * @param {import("bun:sqlite").Database} sqlite
 * @param {string} table
 * @param {string} column
 * @param {string} definition
 */
function addColumnIfMissing(sqlite, table, column, definition) {
    const columns = tableColumnNames(sqlite, table);
    if (columns.has(column)) {
        return false;
    }
    sqlite.run(`ALTER TABLE ${quoteIdentifier(table)} ADD COLUMN ${definition}`);
    return true;
}

/**
 * @param {import("bun:sqlite").Database} sqlite
 * @param {{ table: string; columns: readonly string[]; defaults?: Record<string, string>; }} config
 * @param {readonly string[]} createTableStatements
 */
function rebuildRunOwnedForeignKeyTable(sqlite, config, createTableStatements) {
    if (!tableExists(sqlite, config.table)) {
        return { table: config.table, beforeCount: 0, keptCount: 0, droppedCount: 0, skipped: "missing" };
    }
    if (tableHasRunForeignKey(sqlite, config.table)) {
        const count = countRows(sqlite, config.table);
        return { table: config.table, beforeCount: count, keptCount: count, droppedCount: 0, skipped: "has_fk" };
    }

    const beforeCount = countRows(sqlite, config.table);
    const legacyTable = nextLegacyTableName(sqlite, config.table);
    sqlite.run("PRAGMA foreign_keys = OFF");
    sqlite.run("BEGIN IMMEDIATE");
    try {
        sqlite.run(`ALTER TABLE ${quoteIdentifier(config.table)} RENAME TO ${quoteIdentifier(legacyTable)}`);
        sqlite.run(createTableStatementFor(config.table, createTableStatements));
        const legacyColumns = tableColumnNames(sqlite, legacyTable);
        const columnSql = config.columns.map(quoteIdentifier).join(", ");
        const selectSql = config.columns
            .map((column) => legacyColumns.has(column)
            ? quoteIdentifier(column)
            : (config.defaults?.[column] ?? "NULL"))
            .join(", ");
        const validRunWhere = legacyColumns.has("run_id")
            ? `WHERE ${quoteIdentifier("run_id")} IN (SELECT run_id FROM ${quoteIdentifier("_smithers_runs")})`
            : "WHERE 0";
        const keptCount = countRows(sqlite, legacyTable, validRunWhere);
        sqlite.run(`INSERT INTO ${quoteIdentifier(config.table)} (${columnSql})
           SELECT ${selectSql} FROM ${quoteIdentifier(legacyTable)} ${validRunWhere}`);
        sqlite.run(`DROP TABLE ${quoteIdentifier(legacyTable)}`);
        sqlite.run("COMMIT");
        return {
            table: config.table,
            beforeCount,
            keptCount,
            droppedCount: beforeCount - keptCount,
        };
    }
    catch (error) {
        try {
            sqlite.run("ROLLBACK");
        }
        catch {
            // Preserve the original migration error.
        }
        throw error;
    }
    finally {
        sqlite.run("PRAGMA foreign_keys = ON");
    }
}

/**
 * @param {readonly string[]} statements
 */
function checksumForStatements(statements) {
    return statements.join("\n-- statement --\n");
}

/**
 * @param {import("bun:sqlite").Database} sqlite
 * @param {string} id
 */
function hasMigrationRecord(sqlite, id) {
    const db = drizzle(sqlite, { schema: { smithersSchemaMigrations } });
    return Boolean(db
        .select({ id: smithersSchemaMigrations.id })
        .from(smithersSchemaMigrations)
        .where(eq(smithersSchemaMigrations.id, id))
        .limit(1)
        .all()[0]);
}

/**
 * @param {import("bun:sqlite").Database} sqlite
 */
function loadAppliedMigrationIds(sqlite) {
    const db = drizzle(sqlite, { schema: { smithersSchemaMigrations } });
    return new Set(db
        .select({ id: smithersSchemaMigrations.id })
        .from(smithersSchemaMigrations)
        .all()
        .map((row) => row.id));
}

/**
 * @param {import("bun:sqlite").Database} sqlite
 * @param {{ id: string; name: string; checksum?: string; destructive?: boolean; }} migration
 * @param {unknown} details
 */
function recordMigration(sqlite, migration, details) {
    const db = drizzle(sqlite, { schema: { smithersSchemaMigrations } });
    db.insert(smithersSchemaMigrations)
        .values({
        id: migration.id,
        name: migration.name,
        appliedAtMs: Date.now(),
        checksum: migration.checksum ?? null,
        destructive: Boolean(migration.destructive),
        detailsJson: details === undefined ? null : JSON.stringify(details),
    })
        .onConflictDoNothing({ target: smithersSchemaMigrations.id })
        .run();
}

/**
 * @param {{ id: string; destructive?: boolean; }} migration
 * @param {any} details
 */
function logDestructiveMigration(migration, details) {
    if (!migration.destructive || !details?.tables) {
        return;
    }
    const droppedCount = details.tables.reduce((sum, row) => sum + Number(row.droppedCount ?? 0), 0);
    if (droppedCount <= 0) {
        return;
    }
    console.warn(`[smithers-db] migration ${migration.id} dropped ${droppedCount} orphan run-owned rows`, details.tables);
}

/**
 * @param {{
 *   createTableStatements: readonly string[];
 *   createIndexStatements: readonly string[];
 * }} context
 */
function buildMigrations(context) {
    const columnMigrations = LEGACY_COLUMN_MIGRATIONS.map((config) => ({
        id: config.id,
        name: config.name,
        checksum: checksumForStatements(config.columns.map(([, definition]) => `ALTER TABLE ${config.table} ADD COLUMN ${definition}`)),
        isApplied: (sqlite) => {
            const columns = tableColumnNames(sqlite, config.table);
            return config.columns.every(([column]) => columns.has(column));
        },
        up: (sqlite) => {
            const addedColumns = [];
            for (const [column, definition] of config.columns) {
                if (addColumnIfMissing(sqlite, config.table, column, definition)) {
                    addedColumns.push(column);
                }
            }
            return { table: config.table, addedColumns };
        },
    }));
    return [
        {
            id: "0001_current_tables",
            name: "Create current Smithers tables",
            checksum: checksumForStatements(context.createTableStatements),
            isApplied: () => false,
            up: (sqlite) => {
                for (const statement of context.createTableStatements) {
                    sqlite.run(statement);
                }
                return { statementCount: context.createTableStatements.length };
            },
        },
        ...columnMigrations,
        {
            id: "0011_add_node_diffs",
            name: "Add node diff cache table",
            checksum: "packages/db/migrations/0011_add_node_diffs.sql",
            isApplied: (sqlite) => tableExists(sqlite, "_smithers_node_diffs"),
            up: (sqlite) => {
                sqlite.run(createTableStatementFor("_smithers_node_diffs", context.createTableStatements));
                return { table: "_smithers_node_diffs" };
            },
        },
        {
            id: "0012_add_time_travel_audit",
            name: "Add time-travel audit table",
            checksum: "packages/db/migrations/0012_add_time_travel_audit.sql",
            isApplied: (sqlite) => tableExists(sqlite, "_smithers_time_travel_audit") &&
                tableColumnNames(sqlite, "_smithers_time_travel_audit").has("duration_ms"),
            up: (sqlite) => {
                if (!tableExists(sqlite, "_smithers_time_travel_audit")) {
                    sqlite.run(createTableStatementFor("_smithers_time_travel_audit", context.createTableStatements));
                    return { table: "_smithers_time_travel_audit", created: true };
                }
                addColumnIfMissing(sqlite, "_smithers_time_travel_audit", "duration_ms", "duration_ms INTEGER");
                return { table: "_smithers_time_travel_audit", addedColumns: ["duration_ms"] };
            },
        },
        {
            id: "0013_run_owned_foreign_keys",
            name: "Rebuild run-owned tables with cascading foreign keys",
            checksum: checksumForStatements(RUN_OWNED_FOREIGN_KEY_TABLES.map((config) => config.table)),
            destructive: true,
            isApplied: (sqlite) => RUN_OWNED_FOREIGN_KEY_TABLES.every((config) => tableHasRunForeignKey(sqlite, config.table)),
            up: (sqlite) => {
                const tables = RUN_OWNED_FOREIGN_KEY_TABLES.map((config) => rebuildRunOwnedForeignKeyTable(sqlite, config, context.createTableStatements));
                const violations = sqlite.query("PRAGMA foreign_key_check").all();
                if (violations.length > 0) {
                    throw new Error(`SQLite foreign key check failed after Smithers schema migration: ${JSON.stringify(violations)}`);
                }
                return { tables };
            },
        },
        {
            id: "0014_current_indexes",
            name: "Create current Smithers indexes",
            checksum: checksumForStatements([...context.createIndexStatements, ...EXTRA_INDEX_STATEMENTS]),
            isApplied: () => false,
            up: (sqlite) => {
                for (const statement of [...context.createIndexStatements, ...EXTRA_INDEX_STATEMENTS]) {
                    sqlite.run(statement);
                }
                return { statementCount: context.createIndexStatements.length + EXTRA_INDEX_STATEMENTS.length };
            },
        },
        {
            id: "0015_add_workspace_states",
            name: "Add workspace snapshot states table",
            checksum: "packages/db/migrations/0015_add_workspace_states.sql",
            isApplied: (sqlite) => tableExists(sqlite, "_smithers_workspace_states"),
            up: (sqlite) => {
                sqlite.run(createTableStatementFor("_smithers_workspace_states", context.createTableStatements));
                return { table: "_smithers_workspace_states" };
            },
        },
        {
            id: "0016_add_workspace_checkpoints",
            name: "Add workspace snapshot checkpoints table",
            checksum: "packages/db/migrations/0016_add_workspace_checkpoints.sql",
            isApplied: (sqlite) => tableExists(sqlite, "_smithers_workspace_checkpoints"),
            up: (sqlite) => {
                sqlite.run(createTableStatementFor("_smithers_workspace_checkpoints", context.createTableStatements));
                return { table: "_smithers_workspace_checkpoints" };
            },
        },
        {
            id: "0017_add_scorer_context_columns",
            name: "Add scorer context correlation columns",
            checksum: "packages/db/migrations/0017_add_scorer_context_columns.sql",
            isApplied: (sqlite) => {
                const columns = tableColumnNames(sqlite, "_smithers_scorers");
                return columns.has("ground_truth_json") && columns.has("context_json");
            },
            up: (sqlite) => {
                const addedColumns = [];
                if (addColumnIfMissing(sqlite, "_smithers_scorers", "ground_truth_json", "ground_truth_json TEXT")) {
                    addedColumns.push("ground_truth_json");
                }
                if (addColumnIfMissing(sqlite, "_smithers_scorers", "context_json", "context_json TEXT")) {
                    addedColumns.push("context_json");
                }
                return { table: "_smithers_scorers", addedColumns };
            },
        },
    ];
}

/**
 * @param {import("bun:sqlite").Database} sqlite
 * @param {{
 *   createTableStatements: readonly string[];
 *   createIndexStatements: readonly string[];
 * }} context
 */
export function runSmithersSchemaMigrations(sqlite, context) {
    sqlite.run("PRAGMA foreign_keys = ON");
    sqlite.run(MIGRATION_TABLE_SQL);
    const applied = loadAppliedMigrationIds(sqlite);
    for (const migration of buildMigrations(context)) {
        if (applied.has(migration.id) || hasMigrationRecord(sqlite, migration.id)) {
            continue;
        }
        const alreadyApplied = migration.isApplied(sqlite);
        const details = alreadyApplied
            ? { skipped: "schema_already_matches" }
            : migration.up(sqlite);
        logDestructiveMigration(migration, details);
        recordMigration(sqlite, migration, details);
        applied.add(migration.id);
    }
}

/**
 * PostgreSQL schema initialization. A fresh PostgreSQL database starts at the
 * current schema, so it skips the SQLite-only legacy column/foreign-key
 * migrations entirely and simply creates every current table and index
 * idempotently, with DDL translated to PostgreSQL types. Tables are created in
 * declaration order, which keeps foreign-key references valid (referenced
 * tables precede their dependents).
 *
 * @param {{ query: (config: { text: string }) => Promise<unknown> }} pgConn
 * @param {{
 *   createTableStatements: readonly string[];
 *   createIndexStatements: readonly string[];
 * }} context
 * @returns {Promise<void>}
 */
export async function runSmithersSchemaInitPostgres(pgConn, context) {
    const statements = [
        MIGRATION_TABLE_SQL,
        ...context.createTableStatements,
        ...context.createIndexStatements,
        ...EXTRA_INDEX_STATEMENTS,
    ];
    for (const statement of statements) {
        await pgConn.query({ text: translateDdl(POSTGRES, statement) });
    }
}
