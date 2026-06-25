// @smithers-type-exports-begin
/**
 * @template Schema
 * @typedef {import("./CreateSmithersApi.ts").CreateSmithersApi<Schema>} CreateSmithersApi
 */
// @smithers-type-exports-end

import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import React from "react";
import { createSmithersContext, SmithersContext as GlobalSmithersContext } from "@smithers-orchestrator/react-reconciler/context";
import { Approval as BaseApproval, Workflow as BaseWorkflow, Task as BaseTask, Sequence as BaseSequence, Parallel as BaseParallel, MergeQueue as BaseMergeQueue, Branch as BaseBranch, Loop as BaseLoop, Ralph as BaseRalph, ContinueAsNew as BaseContinueAsNew, continueAsNew as baseContinueAsNew, Worktree as BaseWorktree, Sandbox as BaseSandbox, Signal as BaseSignal, Timer as BaseTimer, } from "@smithers-orchestrator/components";
import { zodToTable } from "@smithers-orchestrator/db/zodToTable";
import { zodToCreateTableSQL, syncZodTableSchema } from "@smithers-orchestrator/db/zodToCreateTableSQL";
import { camelToSnake } from "@smithers-orchestrator/db/utils/camelToSnake";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { POSTGRES } from "@smithers-orchestrator/db/dialect";
import { resolve, join } from "node:path";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { assertZodV4 } from "@smithers-orchestrator/errors/assertZodV4";
import { findSmithersAnchorDir } from "./findSmithersAnchorDir.js";
import { prepareOutputSchemas } from "./prepareOutputSchemas.js";
/** @typedef {import("@smithers-orchestrator/components").ApprovalProps<any, any>} ApprovalProps */
/** @typedef {import("@smithers-orchestrator/components").SandboxProps} SandboxProps */
/** @typedef {import("@smithers-orchestrator/components").SignalProps<any>} SignalProps */
/** @typedef {import("@smithers-orchestrator/scheduler/SmithersWorkflowOptions").SmithersAlertPolicy} SmithersAlertPolicy */
/** @typedef {import("@smithers-orchestrator/scheduler/SmithersWorkflowOptions").SmithersAlertPolicyDefaults} SmithersAlertPolicyDefaults */
/** @typedef {import("@smithers-orchestrator/scheduler/SmithersWorkflowOptions").SmithersAlertPolicyRule} SmithersAlertPolicyRule */
/**
 * @template Schema
 * @typedef {import("@smithers-orchestrator/driver/SmithersCtx").SmithersCtx<Schema>} SmithersCtx
 */
/**
 * @template Schema
 * @typedef {import("@smithers-orchestrator/components/SmithersWorkflow").SmithersWorkflow<Schema>} SmithersWorkflow
 */
/** @typedef {import("@smithers-orchestrator/scheduler/SmithersWorkflowOptions").SmithersWorkflowOptions} SmithersWorkflowOptions */
/** @typedef {import("@smithers-orchestrator/components").WorkflowProps} WorkflowProps */
/** @typedef {import("./CreateSmithersOptions.ts").CreateSmithersOptions} CreateSmithersOptions */

const hotCache = new Map();
/**
 * @param {Record<string, any>} schemas
 * @param {string} dbPath
 * @returns {string}
 */
function computeSchemaSig(schemas, dbPath) {
    const parts = [dbPath];
    for (const name of Object.keys(schemas).sort()) {
        const tableName = camelToSnake(name);
        const ddl = zodToCreateTableSQL(tableName, schemas[name]);
        parts.push(`${name}:${ddl}`);
    }
    return parts.join("\n");
}
/**
 * @param {Record<string, string>} [base]
 * @param {Record<string, string>} [override]
 * @returns {Record<string, string> | undefined}
 */
function mergeAlertLabels(base, override) {
    if (!base && !override)
        return undefined;
    return {
        ...base,
        ...override,
    };
}
/**
 * @param {SmithersAlertPolicyDefaults} [base]
 * @param {SmithersAlertPolicyDefaults} [override]
 * @returns {SmithersAlertPolicyDefaults | undefined}
 */
function mergeAlertDefaults(base, override) {
    if (!base && !override)
        return undefined;
    const merged = {
        ...base,
        ...override,
    };
    const labels = mergeAlertLabels(base?.labels, override?.labels);
    if (labels)
        merged.labels = labels;
    return merged;
}
/**
 * @param {SmithersAlertPolicyRule} [base]
 * @param {SmithersAlertPolicyRule} [override]
 * @returns {SmithersAlertPolicyRule | undefined}
 */
function mergeAlertRule(base, override) {
    if (!base && !override)
        return undefined;
    const merged = {
        ...base,
        ...override,
    };
    const labels = mergeAlertLabels(base?.labels, override?.labels);
    if (labels)
        merged.labels = labels;
    return merged;
}
/**
 * @param {Record<string, SmithersAlertPolicyRule>} [base]
 * @param {Record<string, SmithersAlertPolicyRule>} [override]
 * @returns {Record<string, SmithersAlertPolicyRule> | undefined}
 */
function mergeAlertRules(base, override) {
    if (!base && !override)
        return undefined;
    const merged = {
        ...base,
    };
    for (const [name, rule] of Object.entries(override ?? {})) {
        merged[name] = mergeAlertRule(base?.[name], rule) ?? rule;
    }
    return merged;
}
/**
 * @param {SmithersAlertPolicy} [base]
 * @param {SmithersAlertPolicy} [override]
 * @returns {SmithersAlertPolicy | undefined}
 */
function mergeAlertPolicies(base, override) {
    if (!base && !override)
        return undefined;
    const merged = {};
    const defaults = mergeAlertDefaults(base?.defaults, override?.defaults);
    const rules = mergeAlertRules(base?.rules, override?.rules);
    const reactions = base?.reactions || override?.reactions
        ? {
            ...base?.reactions,
            ...override?.reactions,
        }
        : undefined;
    if (defaults)
        merged.defaults = defaults;
    if (rules)
        merged.rules = rules;
    if (reactions)
        merged.reactions = reactions;
    return merged;
}
/**
 * Generate the Drizzle table metadata, schema registry, and output refs shared by
 * every backend. The Drizzle tables carry only column/name metadata — the actual
 * storage is created per-dialect by the caller; dialect-aware engine reads consult
 * these objects via getTableColumns/getTableName, never to issue SQLite queries.
 *
 * @param {Record<string, any>} schemas
 */
function prepareSmithersTables(schemas) {
    // Fail fast and clearly at workflow construction if any schema is not Zod v4.
    // smithers reads Zod v4 internals (schema._zod) and uses z.toJSONSchema();
    // a Zod v3 schema would otherwise silently build wrong columns here and crash
    // later with a cryptic `schema._zod.def` TypeError deep in the agent path.
    for (const [name, zodSchema] of Object.entries(schemas)) {
        assertZodV4(zodSchema, name);
    }
    const tables = {};
    const inputTable = schemas.input
        ? zodToTable("input", schemas.input, { isInput: true })
        : sqliteTable("input", {
            runId: text("run_id").primaryKey(),
            payload: text("payload", { mode: "json" }).$type(),
        });
    for (const [name, zodSchema] of Object.entries(schemas)) {
        if (name === "input")
            continue;
        const tableName = camelToSnake(name);
        tables[name] = zodToTable(tableName, zodSchema);
    }
    const drizzleSchema = { input: inputTable };
    for (const [key, table] of Object.entries(tables)) {
        drizzleSchema[key] = table;
    }
    const schemaRegistry = new Map();
    for (const [name, zodSchema] of Object.entries(schemas)) {
        if (name === "input")
            continue;
        schemaRegistry.set(name, { table: tables[name], zodSchema });
    }
    const { outputs, zodToKeyName, ambiguousZodSchemas } = prepareOutputSchemas(schemas);
    return { tables, inputTable, drizzleSchema, schemaRegistry, outputs, zodToKeyName, ambiguousZodSchemas };
}
/**
 * Construct the public createSmithers API object around a prepared database
 * handle and shared table metadata. Backend-agnostic: `db` is either a Drizzle
 * bun:sqlite instance or a Postgres descriptor; every engine read/write below it
 * is dialect-aware.
 *
 * @param {{
 *   db: unknown;
 *   tables: Record<string, unknown>;
 *   schemaRegistry: Map<string, unknown>;
 *   outputs: Record<string, unknown>;
 *   zodToKeyName: Map<unknown, string>;
 *   ambiguousZodSchemas: Set<unknown>;
 *   opts?: CreateSmithersOptions;
 *   inputSchema?: unknown;
 * }} config
 */
function buildSmithersApi(config) {
    const { db, tables, schemaRegistry, outputs, zodToKeyName, ambiguousZodSchemas, opts, inputSchema } = config;
    const { SmithersContext: RuntimeSmithersContext, useCtx } = createSmithersContext();
    const ctxRef = { current: null };
    let moduleAlertPolicy = opts?.alertPolicy;
    /**
   * @param {WorkflowProps} props
   */
    function Workflow(props) {
        return React.createElement(BaseWorkflow, props, props.children);
    }
    /**
   * @template Row
   * @param {ApprovalProps<Row>} props
   */
    function Approval(props) {
        return React.createElement(BaseApproval, {
            ...props,
            smithersContext: RuntimeSmithersContext,
        });
    }
    /**
     * Task wrapper that resolves ZodObject output references against the
     * schema registry by reference equality, injecting the outputSchema.
     */
    function Task(props) {
        return React.createElement(BaseTask, {
            ...props,
            smithersContext: RuntimeSmithersContext,
        });
    }
    /**
   * @param {SandboxProps} props
   */
    function Sandbox(props) {
        const workflow = props.workflow ??
            {
                db,
                build: () => React.createElement(BaseWorkflow, { name: `sandbox:${props.id}` }, props.children),
                opts: {},
                schemaRegistry,
                zodToKeyName,
                ambiguousZodSchemas,
            };
        return React.createElement(BaseSandbox, {
            ...props,
            workflow,
            smithersContext: RuntimeSmithersContext,
        });
    }
    /**
   * @template SignalSchema
   * @param {SignalProps<SignalSchema>} props
   */
    function Signal(props) {
        return React.createElement(BaseSignal, {
            ...props,
            smithersContext: RuntimeSmithersContext,
        });
    }
    /**
   * @param {(ctx: SmithersCtx<any>) => React.ReactElement} build
   * @param {SmithersWorkflowOptions} [smithersOpts]
   */
    function boundSmithers(build, smithersOpts) {
        const workflowOpts = {
            ...smithersOpts,
        };
        const alertPolicy = mergeAlertPolicies(moduleAlertPolicy, smithersOpts?.alertPolicy);
        if (alertPolicy)
            workflowOpts.alertPolicy = alertPolicy;
        return {
            readableName: opts?.readableName,
            description: opts?.description,
            db,
            build: (ctx) => {
                ctxRef.current = ctx;
                return React.createElement(RuntimeSmithersContext.Provider, { value: ctxRef.current }, React.createElement(GlobalSmithersContext.Provider, { value: ctxRef.current }, build(ctx)));
            },
            opts: workflowOpts,
            inputSchema,
            schemaRegistry,
            zodToKeyName,
            ambiguousZodSchemas,
        };
    }
    /**
   * @param {SmithersAlertPolicy} [alertPolicy]
   */
    const setModuleAlertPolicy = (alertPolicy) => {
        moduleAlertPolicy = alertPolicy;
    };
    const api = {
        Workflow,
        Approval,
        Task,
        Sequence: BaseSequence,
        Parallel: BaseParallel,
        MergeQueue: BaseMergeQueue,
        Branch: BaseBranch,
        Loop: BaseLoop,
        Ralph: BaseRalph,
        ContinueAsNew: BaseContinueAsNew,
        continueAsNew: baseContinueAsNew,
        Worktree: BaseWorktree,
        Sandbox,
        Signal,
        Timer: BaseTimer,
        useCtx,
        smithers: boundSmithers,
        db,
        tables,
        outputs,
    };
    return { api, setModuleAlertPolicy };
}
/**
 * Schema-driven API — users define only Zod schemas, the framework owns the entire storage layer.
 *
 * @template {Record<string, import("zod").ZodObject<any>>} Schemas
 * @param {Schemas} schemas
 * @param {CreateSmithersOptions} [opts]
 * @returns {import("./CreateSmithersApi.ts").CreateSmithersApi<Schemas>}
 *
 * @example
 * ```ts
 * const { Workflow, Task, smithers, outputs } = createSmithers({
 *   discover: discoverOutputSchema,
 *   research: researchOutputSchema,
 * });
 *
 * export default smithers((ctx) => (
 *   <Workflow name="my-workflow">
 *     <Task id="discover" output={outputs.discover} agent={myAgent}>...</Task>
 *   </Workflow>
 * ));
 * ```
 */
export function createSmithers(schemas, opts) {
    // Honor an explicitly requested backend instead of silently opening
    // bun:sqlite. `createSmithers` is the synchronous SQLite path; PGlite and
    // Postgres provision over the wire asynchronously, so a workflow that wants
    // them must use the async `openSmithersBackend` factory (which returns this
    // exact API). When `--backend pglite|postgres` / `SMITHERS_BACKEND` selects a
    // non-SQLite backend but the workflow still calls `createSmithers`, fail loud
    // (design decision 4: never silently degrade) instead of running on SQLite.
    const requestedBackend = (opts?.backend ?? process.env.SMITHERS_BACKEND ?? "").toLowerCase();
    if (requestedBackend === "pglite" || requestedBackend === "postgres") {
        throw new SmithersError("INVALID_INPUT", `createSmithers() is the synchronous bun:sqlite backend and cannot serve the "${requestedBackend}" backend. ` +
            `Author the workflow with the async factory instead:\n\n` +
            `  const { smithers, Workflow, outputs } = await openSmithersBackend(schemas);\n\n` +
            `or run on SQLite with \`--backend sqlite\` (or SMITHERS_BACKEND=sqlite, or backend:"sqlite" in smithers.config.ts).`, { requestedBackend });
    }
    // Resolve the DB path from the nearest .smithers/ anchor so that running a
    // workflow from a subdirectory always creates/uses the project-root DB, not
    // a new one at CWD. An explicit opts.dbPath overrides this entirely.
    const anchorDir = findSmithersAnchorDir(process.cwd());
    const defaultDbPath = anchorDir ? join(anchorDir, "smithers.db") : "./smithers.db";
    const dbPath = opts?.dbPath ?? defaultDbPath;
    const absDbPath = resolve(process.cwd(), dbPath);
    if (process.env.SMITHERS_HOT === "1") {
        const sig = computeSchemaSig(schemas, absDbPath);
        const cached = hotCache.get(absDbPath);
        if (cached) {
            if (cached.schemaSig !== sig) {
                throw new SmithersError("SCHEMA_CHANGE_HOT", "[smithers hot] Schema change detected; restart required to apply schema changes.");
            }
            cached.setModuleAlertPolicy(opts?.alertPolicy);
            return cached.api;
        }
        // Will cache after creating the API below
    }
    // 1. Generate Drizzle tables + schema metadata from Zod schemas.
    const { tables, drizzleSchema, schemaRegistry, outputs, zodToKeyName, ambiguousZodSchemas } = prepareSmithersTables(schemas);
    // 2. Create SQLite db
    const sqlite = new Database(dbPath);
    sqlite.run(`PRAGMA journal_mode = ${opts?.journalMode ?? "WAL"}`);
    // 30s timeout: concurrent worktrees each spawn agent processes that all write
    // to smithers.db simultaneously. 5s is too short and causes SQLITE_IOERR_VNODE
    // on macOS when the VFS can't acquire the WAL shared-memory lock in time.
    sqlite.run("PRAGMA busy_timeout = 30000");
    // NORMAL is safe in WAL mode (no data loss on crash) and reduces fsync
    // stalls that contribute to WAL checkpoint contention across processes.
    sqlite.run("PRAGMA synchronous = NORMAL");
    // Ensure no exclusive lock is held, allowing multiple readers/writers.
    sqlite.run("PRAGMA locking_mode = NORMAL");
    sqlite.run("PRAGMA foreign_keys = ON");
    // Register a process-exit hook to explicitly close the Database.
    // bun:sqlite's GC finalizer calls sqlite3_close() which fatally aborts if
    // Drizzle's cached prepared statements haven't been finalized first.
    // Calling close() ourselves lets sqlite3 finalize everything gracefully.
    let dbClosed = false;
    const closeDb = () => {
        if (dbClosed)
            return;
        dbClosed = true;
        try {
            sqlite.close();
        }
        catch { }
        process.removeListener("exit", closeDb);
    };
    process.once("exit", closeDb);
    // 3. Auto-create tables, and ALTER any existing tables to add columns the
    // current schema introduced (CREATE TABLE IF NOT EXISTS would silently
    // skip the columns and a later upsert would fail with "no column named X").
    if (schemas.input) {
        syncZodTableSchema(sqlite, "input", schemas.input, { isInput: true });
    }
    else {
        sqlite.exec(`CREATE TABLE IF NOT EXISTS "input" (run_id TEXT PRIMARY KEY, payload TEXT)`);
        try {
            const cols = sqlite.query(`PRAGMA table_info("input")`).all();
            const hasPayload = cols.some((col) => col?.name === "payload");
            if (!hasPayload) {
                sqlite.run(`ALTER TABLE "input" ADD COLUMN payload TEXT`);
            }
        }
        catch {
            // ignore - older SQLite or permission issues; input payload remains best-effort
        }
    }
    for (const [name, zodSchema] of Object.entries(schemas)) {
        if (name === "input")
            continue;
        const tableName = camelToSnake(name);
        syncZodTableSchema(sqlite, tableName, zodSchema);
    }
    // 4. Create Drizzle instance with all tables in the schema
    const db = drizzle(sqlite, { schema: drizzleSchema });
    // 5. Build the public API around the prepared db + table metadata.
    const { api, setModuleAlertPolicy } = buildSmithersApi({
        db,
        tables,
        schemaRegistry,
        outputs,
        zodToKeyName,
        ambiguousZodSchemas,
        opts,
        inputSchema: schemas.input,
    });
    if (process.env.SMITHERS_HOT === "1") {
        const sig = computeSchemaSig(schemas, absDbPath);
        hotCache.set(absDbPath, {
            api: api,
            schemaSig: sig,
            setModuleAlertPolicy,
        });
    }
    return api;
}
/**
 * PostgreSQL/PGlite-backed equivalent of {@link createSmithers}. Asynchronous
 * because connecting and provisioning schema over the wire is async (unlike the
 * synchronous bun:sqlite path). Boots a node-postgres connection (`provider:
 * "postgres"`) or an embedded PGlite over a local socket (`provider: "pglite"`),
 * provisions the durable engine schema + the per-Zod-schema output tables with
 * Postgres-typed DDL, and returns the same createSmithers API surface plus a
 * `close()` teardown for the connection.
 *
 * @template {Record<string, import("zod").ZodObject<any>>} Schemas
 * @param {Schemas} schemas
 * @param {CreateSmithersOptions & ({ provider: "postgres"; connectionString?: string; connection?: object } | { provider: "pglite"; dataDir?: string })} opts
 * @returns {Promise<import("./CreateSmithersApi.ts").CreateSmithersApi<Schemas> & { close: () => Promise<void> }>}
 */
export async function createSmithersPostgres(schemas, opts) {
    const provider = opts?.provider ?? "postgres";
    // 1. Generate Drizzle tables + schema metadata from Zod schemas (shared).
    const { tables, drizzleSchema, schemaRegistry, outputs, zodToKeyName, ambiguousZodSchemas } = prepareSmithersTables(schemas);
    // 2. Boot the Postgres/PGlite connection.
    const pgModule = await import("pg");
    const pg = pgModule.default ?? pgModule;
    // BIGINT (ms timestamps, counters) → JS number, matching SQLite's behavior.
    pg.types.setTypeParser(20, (value) => (value === null ? null : Number(value)));
    /** @type {Array<() => Promise<void>>} */
    const teardown = [];
    let connectionString = opts?.connectionString;
    if (provider === "pglite") {
        const { PGlite } = await import("@electric-sql/pglite");
        const { PGLiteSocketServer } = await import("@electric-sql/pglite-socket");
        const pglite = await PGlite.create(opts?.dataDir || undefined);
        const port = await findFreePgPort();
        const server = new PGLiteSocketServer({ db: pglite, host: "127.0.0.1", port, maxConnections: 5 });
        await server.start();
        teardown.push(async () => {
            await server.stop().catch(() => {});
            await pglite.close().catch(() => {});
        });
        connectionString = `postgres://postgres@127.0.0.1:${port}/postgres`;
    }
    const client = new pg.Client(connectionString ? { connectionString } : opts?.connection);
    /** @type {{ api: import("./CreateSmithersApi.ts").CreateSmithersApi<Schemas> }} */
    let built;
    try {
        await client.connect();
        teardown.push(async () => {
            await client.end().catch(() => {});
        });
        // 3. Postgres descriptor consumed by the engine + adapter. The Drizzle table
        // objects (snake_case columns identical to the DDL below) are attached only
        // for column/name metadata; the engine's reads/writes against this descriptor
        // are dialect-aware and go through the @effect/sql adapter or raw $n queries.
        const descriptor = { dialect: "postgres", connection: client, schema: drizzleSchema };
        const adapter = new SmithersDb(descriptor);
        // 4. Durable engine schema (idempotent), then the input + output tables with
        // Postgres-typed DDL derived from the Zod schemas.
        await adapter.internalStorage.ensureSchema();
        if (schemas.input) {
            await client.query({ text: zodToCreateTableSQL("input", schemas.input, { isInput: true, dialect: POSTGRES }) });
        }
        else {
            await client.query({ text: `CREATE TABLE IF NOT EXISTS "input" (run_id TEXT PRIMARY KEY, payload TEXT)` });
        }
        for (const [name, zodSchema] of Object.entries(schemas)) {
            if (name === "input")
                continue;
            const tableName = camelToSnake(name);
            await client.query({ text: zodToCreateTableSQL(tableName, zodSchema, { dialect: POSTGRES }) });
        }
        // 5. Build the public API around the descriptor + table metadata.
        built = buildSmithersApi({
            db: descriptor,
            tables,
            schemaRegistry,
            outputs,
            zodToKeyName,
            ambiguousZodSchemas,
            opts,
            inputSchema: schemas.input,
        });
    }
    catch (e) {
        // Drain any teardown registered so far (socket server, pg client) so a
        // failure after boot does not leak the port / connection.
        for (const fn of teardown.reverse()) {
            await fn().catch(() => {});
        }
        throw e;
    }
    const { api } = built;
    return {
        ...api,
        close: async () => {
            for (const fn of teardown.reverse()) {
                await fn();
            }
        },
    };
}
/**
 * @returns {Promise<number>}
 */
async function findFreePgPort() {
    const net = await import("node:net");
    return new Promise((resolveFn, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.on("error", reject);
        srv.listen(0, "127.0.0.1", () => {
            const address = srv.address();
            const port = typeof address === "object" && address ? address.port : 0;
            srv.close(() => resolveFn(port));
        });
    });
}
