import { Database } from "bun:sqlite";
import { Effect } from "effect";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { findSmithersAnchorDir } from "./findSmithersAnchorDir.js";

const BACKENDS = new Set(["sqlite", "pglite", "postgres"]);
const DEFAULT_SQLITE_SCHEMA_VERSION = "0000";

/**
 * @param {unknown} value
 * @param {string} source
 * @returns {"sqlite" | "pglite" | "postgres" | undefined}
 */
function normalizeBackend(value, source) {
    if (value === undefined || value === null || value === "") {
        return undefined;
    }
    const backend = String(value).toLowerCase();
    if (BACKENDS.has(backend)) {
        return /** @type {"sqlite" | "pglite" | "postgres"} */ (backend);
    }
    throw new SmithersError("INVALID_INPUT", `Invalid Smithers backend from ${source}: ${String(value)}. Expected sqlite, pglite, or postgres.`, {
        source,
        value,
    });
}

/**
 * @param {string} dbPath
 */
function inspectSqliteStore(dbPath) {
    if (!existsSync(dbPath)) {
        return { exists: false, runCount: 0, schemaVersion: DEFAULT_SQLITE_SCHEMA_VERSION };
    }
    let sqlite;
    try {
        sqlite = new Database(dbPath, { readonly: true });
        const hasRuns = Boolean(sqlite
            .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_smithers_runs'")
            .get());
        const runCount = hasRuns
            ? Number(sqlite.query("SELECT COUNT(*) AS count FROM _smithers_runs").get()?.count ?? 0)
            : 0;
        const hasMigrations = Boolean(sqlite
            .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_smithers_schema_migrations'")
            .get());
        const headId = hasMigrations
            ? sqlite.query("SELECT id FROM _smithers_schema_migrations ORDER BY id DESC LIMIT 1").get()?.id
            : undefined;
        const schemaVersion = typeof headId === "string"
            ? (headId.match(/^\d+/)?.[0] ?? headId)
            : DEFAULT_SQLITE_SCHEMA_VERSION;
        return { exists: true, runCount, schemaVersion };
    }
    catch {
        return { exists: true, runCount: 0, schemaVersion: DEFAULT_SQLITE_SCHEMA_VERSION };
    }
    finally {
        try {
            sqlite?.close();
        }
        catch {
            // best-effort read-only probe cleanup
        }
    }
}

/**
 * @param {string} primaryDbPath
 * @param {string} workspaceRoot
 * @param {boolean} hasExplicitDbPath
 */
function inspectLegacySqliteStore(primaryDbPath, workspaceRoot, hasExplicitDbPath) {
    const candidates = hasExplicitDbPath
        ? [primaryDbPath]
        : [primaryDbPath, join(workspaceRoot, ".smithers", "smithers.db")];
    let fallback = { dbPath: primaryDbPath, ...inspectSqliteStore(primaryDbPath) };
    for (const dbPath of [...new Set(candidates)]) {
        const store = { dbPath, ...inspectSqliteStore(dbPath) };
        if (dbPath === primaryDbPath) {
            fallback = store;
        }
        if (store.runCount > 0) {
            return store;
        }
    }
    return fallback;
}

/**
 * @param {string} configPath
 */
async function loadConfigBackend(configPath) {
    if (!existsSync(configPath)) {
        return undefined;
    }
    const version = statSync(configPath).mtimeMs.toString(36);
    const url = `${pathToFileURL(configPath).href}?smithers-config=${version}`;
    const mod = await import(url);
    return normalizeBackend(mod.backend ?? mod.default?.backend, configPath);
}

/**
 * @param {string} workspaceRoot
 */
function hasMigratedMarker(workspaceRoot) {
    return existsSync(join(workspaceRoot, ".smithers", "migrated.json"));
}

/**
 * @param {string} backend
 */
function backendLabel(backend) {
    return backend === "pglite" ? "PGlite" : backend === "postgres" ? "Postgres" : "SQLite";
}

/**
 * @param {{ dbPath: string; runCount: number; schemaVersion: string; backend: "pglite" | "postgres" }} details
 */
function migrationRequiredError(details) {
    const summary = `Found an existing SQLite store at ${details.dbPath} (${details.runCount} runs, schema v${details.schemaVersion}) but this version uses a ${backendLabel(details.backend)} backend. Your run history will not be visible until you migrate.\n\n  Migrate it:        smithers migrate\n  Or keep SQLite:    smithers <cmd> --backend sqlite   (or backend:"sqlite" in smithers.config.ts)`;
    return new SmithersError("SMITHERS_MIGRATION_REQUIRED", summary, {
        dbPath: details.dbPath,
        runCount: details.runCount,
        schemaVersion: details.schemaVersion,
        resolvedBackend: details.backend,
    });
}

/**
 * @param {ReturnType<typeof migrationRequiredError>} error
 */
async function emitMigrationRequired(error) {
    await Effect.runPromise(Effect.logWarning("smithers.migration_required").pipe(Effect.annotateLogs({
        code: error.code,
        ...error.details,
    }), Effect.withLogSpan("smithers:backend-resolve"))).catch(() => {});
}

/**
 * Resolve the storage backend (explicit → env → `.smithers/smithers.config.ts` →
 * default `pglite`) and enforce the fail-loud migration gate shared by every
 * Smithers boot path (the async backend factory and the CLI read commands). A
 * legacy bun:sqlite store that still holds run data with no `migrated.json`
 * marker is never silently switched onto pglite/postgres: it throws
 * SMITHERS_MIGRATION_REQUIRED so the caller can migrate or pin `--backend sqlite`.
 *
 * @param {import("./ResolveSmithersBackendChoiceOptions.ts").ResolveSmithersBackendChoiceOptions} [opts]
 * @returns {Promise<import("./SmithersBackendChoice.ts").SmithersBackendChoice>}
 */
export async function resolveSmithersBackendChoice(opts = {}) {
    const cwd = resolve(opts.cwd ?? process.cwd());
    const env = opts.env ?? process.env;
    const anchorDir = findSmithersAnchorDir(cwd);
    const workspaceRoot = anchorDir ?? cwd;
    const defaultDbPath = join(workspaceRoot, "smithers.db");
    const dbPath = resolve(cwd, opts.dbPath ?? defaultDbPath);
    const configPath = opts.configPath
        ? resolve(cwd, opts.configPath)
        : join(workspaceRoot, ".smithers", "smithers.config.ts");
    const explicitBackend = normalizeBackend(opts.backend, "options.backend");
    const envBackend = normalizeBackend(env.SMITHERS_BACKEND, "SMITHERS_BACKEND");
    const configBackend = explicitBackend || envBackend ? undefined : await loadConfigBackend(configPath);
    const backend = explicitBackend ?? envBackend ?? configBackend ?? "pglite";
    const source = explicitBackend ? "options" : envBackend ? "env" : configBackend ? "config" : "default";
    const sqliteStore = inspectLegacySqliteStore(dbPath, workspaceRoot, Boolean(opts.dbPath));
    const marker = hasMigratedMarker(workspaceRoot);
    // Fail loud whenever a legacy SQLite store has runs and the resolved backend
    // is PGlite/Postgres. The only non-SQLite suppressions are an explicit
    // completed migration marker or a fresh/empty SQLite store.
    if ((backend === "pglite" || backend === "postgres") && sqliteStore.runCount > 0 && !marker) {
        const error = migrationRequiredError({
            dbPath: sqliteStore.dbPath,
            runCount: sqliteStore.runCount,
            schemaVersion: sqliteStore.schemaVersion,
            backend,
        });
        await emitMigrationRequired(error);
        throw error;
    }
    return {
        backend,
        source,
        dbPath,
        workspaceRoot,
        runCount: sqliteStore.runCount,
        schemaVersion: sqliteStore.schemaVersion,
        migratedMarker: marker,
    };
}
