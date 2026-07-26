import { Database } from "bun:sqlite";
import { Effect } from "effect";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { findSmithersAnchorDir } from "./findSmithersAnchorDir.js";

const BACKENDS = new Set(["sqlite", "pglite", "postgres"]);
const DEFAULT_SQLITE_SCHEMA_VERSION = "0000";
const DEFAULT_PG_SCHEMA_VERSION = "0000";

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
  throw new SmithersError(
    "INVALID_INPUT",
    `Invalid Smithers backend from ${source}: ${String(value)}. Expected sqlite, pglite, or postgres.`,
    {
      source,
      value,
    },
  );
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
    const hasRuns = Boolean(
      sqlite.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_smithers_runs'").get(),
    );
    const runCount = hasRuns
      ? Number(sqlite.query("SELECT COUNT(*) AS count FROM _smithers_runs").get()?.count ?? 0)
      : 0;
    const hasMigrations = Boolean(
      sqlite
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_smithers_schema_migrations'")
        .get(),
    );
    const headId = hasMigrations
      ? sqlite.query("SELECT id FROM _smithers_schema_migrations ORDER BY id DESC LIMIT 1").get()?.id
      : undefined;
    const schemaVersion =
      typeof headId === "string" ? (headId.match(/^\d+/)?.[0] ?? headId) : DEFAULT_SQLITE_SCHEMA_VERSION;
    return { exists: true, runCount, schemaVersion };
  } catch (error) {
    return { exists: true, runCount: 0, schemaVersion: DEFAULT_SQLITE_SCHEMA_VERSION, error: probeErrorMessage(error) };
  } finally {
    try {
      sqlite?.close();
    } catch {
      // best-effort read-only probe cleanup
    }
  }
}

/**
 * @param {unknown} error
 */
function probeErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
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
  try {
    const mod = await import(url);
    return normalizeBackend(mod.backend ?? mod.default?.backend, configPath);
  } catch (error) {
    if (error instanceof SmithersError) {
      throw error;
    }
    throw new SmithersError(
      "INVALID_INPUT",
      `Could not load Smithers config at ${configPath}: ${probeErrorMessage(error)}`,
      {
        configPath,
      },
      { cause: error },
    );
  }
}

/**
 * @param {string} workspaceRoot
 * @returns {"sqlite" | "pglite" | "postgres" | undefined}
 */
function readBackendMarker(workspaceRoot) {
  const markerPath = join(workspaceRoot, ".smithers", "backend.json");
  if (!existsSync(markerPath)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(markerPath, "utf8"));
    return normalizeBackend(parsed?.backend, markerPath);
  } catch {
    return undefined;
  }
}

/**
 * @param {string} workspaceRoot
 * @returns {{ exists: boolean; backend?: "sqlite" | "pglite" | "postgres" }}
 */
function readMigratedMarker(workspaceRoot) {
  const markerPath = join(workspaceRoot, ".smithers", "migrated.json");
  if (!existsSync(markerPath)) {
    return { exists: false };
  }
  try {
    const parsed = JSON.parse(readFileSync(markerPath, "utf8"));
    return {
      exists: true,
      backend: normalizeBackend(parsed?.target?.backend ?? parsed?.target ?? parsed?.backend, markerPath),
      // The migration SOURCE backend, recorded by `migrate` for every
      // direction. A reverse (target sqlite) receipt uses it to tolerate the
      // kept source store (pglite/postgres) without hiding an unrelated one.
      sourceBackend: normalizeBackend(
        parsed?.source?.backend ?? (typeof parsed?.source === "string" ? parsed.source : undefined),
        markerPath,
      ),
    };
  } catch {
    return { exists: true };
  }
}

/**
 * @param {{ dataDir: string }} details
 */
function describePgliteStore(details) {
  const { dataDir } = details;
  const exists = existsSync(dataDir);
  const initialized = exists && existsSync(join(dataDir, "PG_VERSION"));
  return {
    dataDir,
    exists,
    initialized,
    probed: false,
    ...(!initialized ? { hasRunsTable: false, runCount: 0, schemaVersion: DEFAULT_PG_SCHEMA_VERSION } : {}),
  };
}

/**
 * @param {{ dataDir: string }} details
 */
async function inspectPgliteStore(details) {
  const physical = describePgliteStore(details);
  if (!physical.exists || !physical.initialized) {
    return physical;
  }
  // Emscripten-backed PGlite can set the host process exitCode before throwing
  // from a corrupt/unreadable data directory. This is a best-effort discovery
  // probe, not the command itself, so contain that side effect even when the
  // exception is caught and returned as probe metadata. Bun does not clear an
  // already-set exitCode when assigned undefined, hence the explicit 0.
  const exitCodeBeforeProbe = process.exitCode;
  let pglite;
  try {
    const { PGlite } = await import("@electric-sql/pglite");
    pglite = await PGlite.create(physical.dataDir);
    const runsTable = await pglite.query("SELECT to_regclass('_smithers_runs') AS table_name");
    const hasRuns = Boolean(runsTable.rows?.[0]?.table_name);
    const runCount = hasRuns
      ? Number((await pglite.query("SELECT COUNT(*)::int AS count FROM _smithers_runs")).rows?.[0]?.count ?? 0)
      : 0;
    const migrationsTable = await pglite.query("SELECT to_regclass('_smithers_schema_migrations') AS table_name");
    const hasMigrations = Boolean(migrationsTable.rows?.[0]?.table_name);
    const headId = hasMigrations
      ? (await pglite.query("SELECT id FROM _smithers_schema_migrations ORDER BY id DESC LIMIT 1")).rows?.[0]?.id
      : undefined;
    const schemaVersion =
      typeof headId === "string" ? (headId.match(/^\d+/)?.[0] ?? headId) : DEFAULT_PG_SCHEMA_VERSION;
    return { ...physical, probed: true, hasRunsTable: hasRuns, runCount, schemaVersion };
  } catch (error) {
    return {
      ...physical,
      probed: true,
      runCount: 0,
      schemaVersion: DEFAULT_PG_SCHEMA_VERSION,
      error: probeErrorMessage(error),
    };
  } finally {
    try {
      await pglite?.close?.();
    } catch {
      // best-effort read-only probe cleanup
    }
    if (process.exitCode !== exitCodeBeforeProbe) {
      process.exitCode = exitCodeBeforeProbe ?? 0;
    }
  }
}

/**
 * @param {{ connectionString?: string; connection?: { query?: Function } }} details
 */
async function inspectPostgresStore(details) {
  if (!details.connectionString && !details.connection) {
    return { exists: false, initialized: false, runCount: 0, schemaVersion: DEFAULT_PG_SCHEMA_VERSION };
  }
  let client;
  let shouldClose = false;
  try {
    if (details.connection) {
      client = details.connection;
    } else {
      const pg = await import("pg");
      client = new pg.Client({ connectionString: details.connectionString });
      await client.connect();
      shouldClose = true;
    }
    const runsTable = await client.query("SELECT to_regclass('_smithers_runs') AS table_name");
    const hasRuns = Boolean(runsTable.rows?.[0]?.table_name);
    const runCount = hasRuns
      ? Number((await client.query("SELECT COUNT(*)::int AS count FROM _smithers_runs")).rows?.[0]?.count ?? 0)
      : 0;
    const migrationsTable = await client.query("SELECT to_regclass('_smithers_schema_migrations') AS table_name");
    const hasMigrations = Boolean(migrationsTable.rows?.[0]?.table_name);
    const headId = hasMigrations
      ? (await client.query("SELECT id FROM _smithers_schema_migrations ORDER BY id DESC LIMIT 1")).rows?.[0]?.id
      : undefined;
    const schemaVersion =
      typeof headId === "string" ? (headId.match(/^\d+/)?.[0] ?? headId) : DEFAULT_PG_SCHEMA_VERSION;
    return {
      exists: true,
      initialized: true,
      hasRunsTable: hasRuns,
      runCount,
      schemaVersion,
      connectionString: details.connectionString ? "set" : undefined,
    };
  } catch (error) {
    return {
      exists: true,
      initialized: false,
      runCount: 0,
      schemaVersion: DEFAULT_PG_SCHEMA_VERSION,
      connectionString: details.connectionString ? "set" : undefined,
      error: probeErrorMessage(error),
    };
  } finally {
    if (shouldClose) {
      await client?.end?.().catch(() => {});
    }
  }
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
  const summary = `Found an existing SQLite store at ${details.dbPath} (${details.runCount} runs, schema v${details.schemaVersion}) but this version uses a ${backendLabel(details.backend)} backend. Your run history will not be visible until you migrate.\n\n  Migrate it:        smithers migrate --to ${details.backend}\n  Or keep SQLite:    smithers <cmd> --backend sqlite   (or backend:"sqlite" in smithers.config.ts)`;
  return new SmithersError("SMITHERS_MIGRATION_REQUIRED", summary, {
    dbPath: details.dbPath,
    runCount: details.runCount,
    schemaVersion: details.schemaVersion,
    resolvedBackend: details.backend,
    sourceBackend: "sqlite",
    targetBackend: details.backend,
  });
}

/**
 * @param {{ sourceBackend: "pglite" | "postgres"; targetBackend: "sqlite" | "pglite" | "postgres"; location: string; runCount: number; schemaVersion: string }} details
 */
function backendDivergenceError(details) {
  const sourceLabel = backendLabel(details.sourceBackend);
  const targetLabel = backendLabel(details.targetBackend);
  const migrate = `smithers migrate --from ${details.sourceBackend} --to ${details.targetBackend}`;
  const keep = `SMITHERS_BACKEND=${details.sourceBackend} smithers <cmd>`;
  return new SmithersError(
    "SMITHERS_MIGRATION_REQUIRED",
    `Found existing ${sourceLabel} run history at ${details.location} (${details.runCount} runs, schema v${details.schemaVersion}), but the resolved backend is ${targetLabel}. Your run history will not be visible until you migrate or pin the existing backend.\n\n  Migrate it:     ${migrate}\n  Or keep ${sourceLabel}: ${keep}`,
    details,
  );
}

/**
 * @param {{ populated: Array<{ backend: "sqlite" | "pglite" | "postgres"; location: string; runCount: number; schemaVersion: string }> }} details
 */
function backendConflictError(details) {
  const populatedBackends = details.populated.map((store) => store.backend);
  return new SmithersError(
    "SMITHERS_BACKEND_CONFLICT",
    `Multiple Smithers stores contain run history (${populatedBackends.join(", ")}). Refusing to choose a backend because that would hide runs. Migrate or remove the unintended store before continuing.`,
    {
      populatedBackends,
      stores: details.populated,
    },
  );
}

/**
 * @param {{ targetBackend: "pglite" | "postgres"; sqlite: { dbPath: string; runCount: number; schemaVersion: string }; targetLocation: string }} details
 */
function missingMigratedTargetError(details) {
  const targetLabel = backendLabel(details.targetBackend);
  return new SmithersError(
    "SMITHERS_MIGRATION_REQUIRED",
    `Found a migration receipt for ${targetLabel}, but the migrated ${targetLabel} store at ${details.targetLocation} has no run history while the legacy SQLite store at ${details.sqlite.dbPath} still contains ${details.sqlite.runCount} runs. Refusing to use stale SQLite data.\n\n  Restore or point Smithers at the migrated ${targetLabel} store.\n  Or rerun migration: smithers migrate --from sqlite --to ${details.targetBackend}`,
    {
      sourceBackend: "sqlite",
      targetBackend: details.targetBackend,
      dbPath: details.sqlite.dbPath,
      runCount: details.sqlite.runCount,
      schemaVersion: details.sqlite.schemaVersion,
      targetLocation: details.targetLocation,
    },
  );
}

/**
 * @param {{ targetBackend: "pglite" | "postgres"; targetLocation: string; probeError: string }} details
 */
function unreadableMigratedTargetError(details) {
  const targetLabel = backendLabel(details.targetBackend);
  return new SmithersError(
    "DB_QUERY_FAILED",
    `Found a migration receipt for ${targetLabel}, but Smithers could not read the migrated target at ${details.targetLocation}. The target's contents are unknown, so Smithers will not treat it as empty or recommend another migration. Repair the target in place, restore it from a known-good backup, or point Smithers at the correct target before retrying. Original probe error: ${details.probeError}`,
    {
      targetBackend: details.targetBackend,
      targetLocation: details.targetLocation,
      contentsKnown: false,
      probeError: details.probeError,
    },
  );
}

/**
 * @param {ReturnType<typeof migrationRequiredError>} error
 */
async function emitMigrationRequired(error) {
  await Effect.runPromise(
    Effect.logWarning("smithers.migration_required").pipe(
      Effect.annotateLogs({
        code: error.code,
        ...error.details,
      }),
      Effect.withLogSpan("smithers:backend-resolve"),
    ),
  ).catch(() => {});
}

/**
 * Resolve the storage backend (explicit → env → `.smithers/smithers.config.ts` →
 * default `sqlite`) and enforce the fail-loud migration gate shared by every
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
  const migratedMarker = readMigratedMarker(workspaceRoot);
  const markerBackend =
    explicitBackend || envBackend || configBackend
      ? undefined
      : (readBackendMarker(workspaceRoot) ?? migratedMarker.backend);
  const backend = explicitBackend ?? envBackend ?? configBackend ?? markerBackend ?? "sqlite";
  const source = explicitBackend
    ? "options"
    : envBackend
      ? "env"
      : configBackend
        ? "config"
        : markerBackend
          ? "marker"
          : "default";
  // An option/env/config SQLite pin is an authoritative operator choice. Do
  // not boot a leftover PGlite store merely to describe the backend we are
  // explicitly not using: a locked or corrupt store can abort the process,
  // and its logical contents are irrelevant to the selected SQLite path.
  const explicitSqliteOverride =
    backend === "sqlite" && (explicitBackend === "sqlite" || envBackend === "sqlite" || configBackend === "sqlite");
  const sqliteStore = inspectLegacySqliteStore(dbPath, workspaceRoot, Boolean(opts.dbPath));
  const pgliteDataDir = resolve(cwd, opts.pgliteDataDir ?? join(workspaceRoot, ".smithers", "pg"));
  const pgliteStore = explicitSqliteOverride
    ? describePgliteStore({ dataDir: pgliteDataDir })
    : await inspectPgliteStore({ dataDir: pgliteDataDir });
  const explicitPostgresConnectionString = opts.connectionString;
  const shouldInspectPostgres = backend === "postgres" || Boolean(opts.connection || explicitPostgresConnectionString);
  const postgresStore = shouldInspectPostgres
    ? await inspectPostgresStore({
        connectionString: explicitPostgresConnectionString ?? env.SMITHERS_POSTGRES_URL ?? env.DATABASE_URL,
        connection: opts.connection,
      })
    : { exists: false, initialized: false, runCount: 0, schemaVersion: DEFAULT_PG_SCHEMA_VERSION };
  // A migration receipt only suppresses the guards when it actually names a
  // valid non-sqlite target backend. A bare/malformed `migrated.json` (e.g.
  // `{ migratedAt: 1 }` with no parseable target) must NOT silently suppress —
  // otherwise an explicit pglite/postgres open beside a populated SQLite store
  // would hide the SQLite history.
  const marker =
    migratedMarker.exists && (migratedMarker.backend === "pglite" || migratedMarker.backend === "postgres");
  // A REVERSE migration receipt (target sqlite) is authoritative the same way a
  // forward one is — but the only leftover store it authorizes keeping is the
  // recorded migration SOURCE (pglite/postgres). It must NOT silently hide an
  // unrelated populated store, so it requires a recorded source backend (a bare
  // or sourceless receipt does not suppress) and resolves only when we actually
  // land on sqlite. Symmetric to the forward path's sqlite-source tolerance.
  const reverseMarker =
    migratedMarker.exists &&
    migratedMarker.backend === "sqlite" &&
    backend === "sqlite" &&
    (migratedMarker.sourceBackend === "pglite" || migratedMarker.sourceBackend === "postgres");
  const populated = [
    ...(sqliteStore.runCount > 0
      ? [
          {
            backend: /** @type {"sqlite"} */ ("sqlite"),
            location: sqliteStore.dbPath,
            runCount: sqliteStore.runCount,
            schemaVersion: sqliteStore.schemaVersion,
          },
        ]
      : []),
    ...(typeof pgliteStore.runCount === "number" && pgliteStore.runCount > 0
      ? [
          {
            backend: /** @type {"pglite"} */ ("pglite"),
            location: pgliteStore.dataDir,
            runCount: pgliteStore.runCount,
            schemaVersion: pgliteStore.schemaVersion ?? DEFAULT_PG_SCHEMA_VERSION,
          },
        ]
      : []),
    ...(postgresStore.runCount > 0
      ? [
          {
            backend: /** @type {"postgres"} */ ("postgres"),
            location: postgresStore.connectionString === "set" ? "postgres connection" : "postgres",
            runCount: postgresStore.runCount,
            schemaVersion: postgresStore.schemaVersion,
          },
        ]
      : []),
  ];
  // An explicit sqlite pin (--backend / SMITHERS_BACKEND / backend:"sqlite" in
  // smithers.config.ts) IS the disambiguation the conflict guard demands: the
  // user has chosen to keep the legacy sqlite store, which is authoritative and
  // never hidden. Suppress the multi-store conflict for that (safe) direction
  // only. Pinning toward pglite/postgres beside a populated sqlite store still
  // falls through to the migration/conflict guards below so legacy history is
  // never silently hidden.
  if (!marker && !reverseMarker && !explicitSqliteOverride && populated.length > 1) {
    throw backendConflictError({ populated });
  }
  if (reverseMarker) {
    // Tolerate sqlite (the migration target) and the recorded source only;
    // any other populated store would be hidden, so refuse to choose.
    const unexpectedPopulated = populated.filter(
      (store) => store.backend !== "sqlite" && store.backend !== migratedMarker.sourceBackend,
    );
    if (unexpectedPopulated.length > 0) {
      throw backendConflictError({ populated });
    }
  }
  // marker (above) already guarantees migratedMarker.backend is "pglite" | "postgres".
  const migratedTargetBackend = marker ? /** @type {"pglite" | "postgres"} */ (migratedMarker.backend) : undefined;
  if (migratedTargetBackend && !explicitSqliteOverride) {
    const targetStore = migratedTargetBackend === "pglite" ? pgliteStore : postgresStore;
    const targetLocation =
      migratedTargetBackend === "pglite"
        ? pgliteStore.dataDir
        : postgresStore.connectionString === "set"
          ? "postgres connection"
          : "postgres";
    if (targetStore.error) {
      throw unreadableMigratedTargetError({
        targetBackend: migratedTargetBackend,
        targetLocation,
        probeError: targetStore.error,
      });
    }
    const unexpectedPopulated = populated.filter(
      (store) => store.backend !== migratedTargetBackend && store.backend !== "sqlite",
    );
    if (unexpectedPopulated.length > 0) {
      throw backendConflictError({ populated });
    }
    if (sqliteStore.runCount > 0) {
      const targetRunCount = Number(targetStore.runCount ?? 0);
      if (targetRunCount <= 0) {
        const error = missingMigratedTargetError({
          targetBackend: migratedTargetBackend,
          sqlite: sqliteStore,
          targetLocation,
        });
        await emitMigrationRequired(error);
        throw error;
      }
    }
  }
  if ((backend === "pglite" || backend === "postgres") && sqliteStore.exists && sqliteStore.error && !marker) {
    throw new SmithersError(
      "DB_QUERY_FAILED",
      `Could not read existing SQLite store at ${sqliteStore.dbPath}; refusing to switch to ${backend} because that could hide run history. Original error: ${sqliteStore.error}`,
      {
        dbPath: sqliteStore.dbPath,
        sourceBackend: "sqlite",
        targetBackend: backend,
      },
    );
  }
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
  if (!marker) {
    const authoritative = populated[0];
    if (authoritative && authoritative.backend !== backend) {
      const error = backendDivergenceError({
        sourceBackend: /** @type {"pglite" | "postgres"} */ (authoritative.backend),
        targetBackend: backend,
        location: authoritative.location,
        runCount: authoritative.runCount,
        schemaVersion: authoritative.schemaVersion,
      });
      await emitMigrationRequired(error);
      throw error;
    }
  }
  return {
    backend,
    source,
    // The store that actually holds the sqlite run history, not the requested
    // primary path. When the primary store is empty/absent but a legacy
    // nested `.smithers/smithers.db` has runs, `inspectLegacySqliteStore`
    // returns that legacy path; surfacing it here keeps consumers (e.g.
    // openSmithersStore) from opening the empty primary and hiding history.
    dbPath: sqliteStore.dbPath,
    workspaceRoot,
    runCount: sqliteStore.runCount,
    schemaVersion: sqliteStore.schemaVersion,
    sqlite: sqliteStore,
    pglite: pgliteStore,
    postgres: postgresStore,
    migratedMarker: marker || reverseMarker,
  };
}
