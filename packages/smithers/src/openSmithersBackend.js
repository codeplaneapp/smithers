import { Effect } from "effect";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { openDurableSqliteDatabase } from "@smithers-orchestrator/db/openDurableSqliteDatabase";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { createHindsightMemoryStore, createLocalMemoryRuntime, createMemoryStore } from "@smithers-orchestrator/memory";
import { createSmithers, createSmithersPostgres } from "./create.js";
import { findSmithersAnchorDir } from "./findSmithersAnchorDir.js";
import { resolveSmithersBackendChoice } from "./resolveSmithersBackendChoice.js";

/**
 * @param {Record<string, unknown>} attrs
 */
async function emitBackendResolution(attrs) {
    await Effect.runPromise(Effect.logDebug("smithers.backend.resolved").pipe(Effect.annotateLogs(attrs), Effect.withLogSpan("smithers:backend-resolve"))).catch(() => {});
}

/**
 * Select the memory backend independently from workflow-state storage. A
 * configured Hindsight service wins; otherwise the exact existing store stays
 * local and the component gets a keyword runtime adapter over those facts.
 * @param {any} api
 * @param {Record<string, string | undefined>} env
 * @param {string} localMemoryDbPath
 */
function attachMemoryBackend(api, env, localMemoryDbPath) {
    const hindsightUrl = env.HINDSIGHT_URL?.trim();
    let contractStore;
    let closeLocalMemory;
    if (api.db?.dialect !== "postgres") {
        ensureSmithersTables(api.db);
        contractStore = createMemoryStore(api.db);
    }
    else {
        mkdirSync(dirname(localMemoryDbPath), { recursive: true });
        const local = openDurableSqliteDatabase(localMemoryDbPath);
        ensureSmithersTables(local.db);
        contractStore = createMemoryStore(local.db);
        closeLocalMemory = local.close;
    }
    const memoryStore = hindsightUrl
        ? createHindsightMemoryStore({
            baseUrl: hindsightUrl,
            contractStore,
            ...(env.HINDSIGHT_API_KEY ? { apiKey: env.HINDSIGHT_API_KEY } : {}),
            ...(env.HINDSIGHT_BANK_PREFIX ? { bankPrefix: env.HINDSIGHT_BANK_PREFIX } : {}),
        })
        : contractStore;
    const memoryService = hindsightUrl ? memoryStore : createLocalMemoryRuntime(memoryStore);
    const smithers = api.smithers;
    const close = api.close;
    return {
        ...api,
        memoryStore,
        memoryService,
        ...(closeLocalMemory ? {
            close: async () => {
                try {
                    await close?.();
                }
                finally {
                    closeLocalMemory();
                }
            },
        } : {}),
        smithers(build, smithersOpts) {
            return {
                ...smithers(build, smithersOpts),
                memoryService,
            };
        },
    };
}

/**
 * Resolve the storage backend and open the matching Smithers API. Delegates the
 * backend resolution and the fail-loud migration gate to
 * {@link resolveSmithersBackendChoice} so the gateway/server boot path and the
 * CLI read commands enforce the identical contract.
 *
 * @template {Record<string, import("zod").ZodObject<any>>} Schemas
 * @param {Schemas} schemas
 * @param {import("./OpenSmithersBackendOptions.ts").OpenSmithersBackendOptions} [opts]
 * @returns {Promise<import("./CreateSmithersApi.ts").CreateSmithersApi<Schemas> & {
 *   close?: () => Promise<void>;
 *   memoryStore: import("@smithers-orchestrator/memory").MemoryStore;
 *   memoryService: import("@smithers-orchestrator/driver/MemoryRuntimeService").MemoryRuntimeService;
 * }>}
 */
export async function openSmithersBackend(schemas = /** @type {Schemas} */ ({}), opts = {}) {
    const startedAt = Date.now();
    const cwd = resolve(opts.cwd ?? process.cwd());
    const env = opts.env ?? process.env;
    const anchorDir = findSmithersAnchorDir(cwd);
    const workspaceRoot = anchorDir ?? cwd;
    const choice = await resolveSmithersBackendChoice({
        backend: opts.backend,
        cwd,
        dbPath: opts.dbPath,
        configPath: opts.configPath,
        env,
        connectionString: opts.connectionString,
        connection: opts.connection,
        pgliteDataDir: opts.pgliteDataDir,
    });
    const { backend, source, dbPath } = choice;
    if (backend === "sqlite") {
        // Pass the resolved backend explicitly: createSmithers fails loud on a
        // non-sqlite `SMITHERS_BACKEND`, and the caller may have supplied a custom
        // `env` that differs from process.env. Stamping "sqlite" pins the choice.
        const api = createSmithers(schemas, { ...opts, backend: "sqlite", dbPath });
        await emitBackendResolution({
            backend,
            dbPath,
            source,
            durationMs: Date.now() - startedAt,
        });
        return attachMemoryBackend(api, env, join(workspaceRoot, ".smithers", "smithers.db"));
    }
    if (backend === "postgres") {
        const connectionString = opts.connectionString ?? env.SMITHERS_POSTGRES_URL ?? env.DATABASE_URL;
        if (!connectionString && !opts.connection) {
            throw new SmithersError("INVALID_INPUT", "Postgres backend requires connectionString, connection, SMITHERS_POSTGRES_URL, or DATABASE_URL.", {
                backend,
            });
        }
        const environmentPoolMax = env.SMITHERS_POSTGRES_POOL_MAX;
        const api = await createSmithersPostgres(schemas, {
            ...opts,
            provider: "postgres",
            ...(connectionString ? { connectionString } : {}),
            ...(opts.connection ? { connection: opts.connection } : {}),
            ...(opts.postgresPoolMax === undefined && environmentPoolMax !== undefined
                ? { postgresPoolMax: Number(environmentPoolMax) }
                : {}),
        });
        await emitBackendResolution({
            backend,
            connectionString: connectionString ? "set" : "custom-connection",
            source,
            durationMs: Date.now() - startedAt,
        });
        return attachMemoryBackend(api, env, join(workspaceRoot, ".smithers", "smithers.db"));
    }
    const pgliteDataDir = resolve(cwd, opts.pgliteDataDir ?? join(workspaceRoot, ".smithers", "pg"));
    mkdirSync(dirname(pgliteDataDir), { recursive: true });
    const api = await createSmithersPostgres(schemas, {
        ...opts,
        provider: "pglite",
        dataDir: pgliteDataDir,
    });
    await emitBackendResolution({
        backend,
        dataDir: pgliteDataDir,
        source,
        durationMs: Date.now() - startedAt,
    });
    return attachMemoryBackend(api, env, join(workspaceRoot, ".smithers", "smithers.db"));
}
