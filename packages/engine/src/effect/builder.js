import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { and, desc, eq } from "drizzle-orm";
import { Context, Duration, Effect, Exit, Layer, Schedule, Schema, } from "effect";
import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import React from "react";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { runWorkflow } from "../engine.js";
import { ignoreSyncError } from "@smithers-orchestrator/driver/interop";
import { requireTaskRuntime } from "@smithers-orchestrator/driver/task-runtime";
import { Branch, Loop, Parallel, Sequence, Task, Worktree, Workflow, } from "@smithers-orchestrator/components/components/index";
import { camelToSnake } from "@smithers-orchestrator/db/utils/camelToSnake";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
/**
 * @typedef {import("effect").Schema.Schema<unknown, unknown, never>} AnySchema
 */
/**
 * @typedef {unknown | Promise<unknown> | import("effect").Effect.Effect<unknown, unknown, unknown>} AnyEffect
 */
/**
 * @typedef {{ needs?: Record<string, BuilderStepHandle>; request: (ctx: Record<string, unknown>) => { title: string; summary?: string | null; }; onDeny?: "fail" | "continue" | "skip"; }} ApprovalOptions
 */
/** @typedef {import("./BuilderNode.ts").BuilderNode} BuilderNode */
/**
 * @typedef {Record<string, unknown> & { input: unknown; executionId: string; stepId: string; attempt: number; signal: AbortSignal; iteration: number; heartbeat: (data?: unknown) => void; lastHeartbeat: unknown | null; }} BuilderStepContext
 */
/** @typedef {import("./BuilderStepHandle.ts").BuilderStepHandle} BuilderStepHandle */
/** @typedef {import("@smithers-orchestrator/scheduler/RetryPolicy").RetryPolicy} RetryPolicy */
/** @typedef {import("./SmithersSqliteOptions.ts").SmithersSqliteOptions} SmithersSqliteOptions */
/**
 * @typedef {{
 *   output: AnySchema;
 *   needs?: Record<string, BuilderStepHandle>;
 *   run?: (ctx: BuilderStepContext) => AnyEffect;
 *   retry?: unknown;
 *   retryPolicy?: RetryPolicy;
 *   timeout?: unknown;
 *   skipIf?: (ctx: BuilderStepContext) => boolean;
 *   cache?: import("@smithers-orchestrator/scheduler/CachePolicy").CachePolicy;
 * }} StepOptions
 */
/**
 * @typedef {{
 *   step: (id: string, options: StepOptions) => BuilderStepHandle;
 *   approval: (id: string, options: ApprovalOptions) => BuilderStepHandle;
 *   sequence: (...nodes: BuilderNode[]) => BuilderNode;
 *   parallel: (...nodesOrOptions: [...BuilderNode[], { maxConcurrency?: number }] | BuilderNode[]) => BuilderNode;
 *   loop: (options: { id?: string; children: BuilderNode; until: (outputs: Record<string, unknown>) => boolean; maxIterations?: number; onMaxReached?: "fail" | "return-last"; }) => BuilderNode;
 *   match: (source: BuilderStepHandle, options: { when: (value: unknown) => boolean; then: () => BuilderNode; else?: () => BuilderNode; }) => BuilderNode;
 *   component: (instanceId: string, definition: ComponentDefinition, params?: Record<string, unknown>) => BuilderNode;
 * }} BuilderApi
 */
/**
 * @typedef {{ execute: (input: unknown, opts?: Omit<Parameters<typeof runWorkflow>[1], "input">) => import("effect").Effect.Effect<unknown, unknown, unknown> }} BuiltSmithersWorkflow
 */
/**
 * @typedef {{ build: (buildGraph: ($: BuilderApi) => BuilderNode) => BuiltSmithersWorkflow }} WorkflowDefinitionBuilder
 */
/**
 * @typedef {{ kind: "component-definition"; name: string; buildWithPrefix: (prefix: string, params?: Record<string, unknown>) => BuilderNode }} ComponentDefinition
 */
/**
 * @typedef {{ build: (buildGraph: ($: BuilderApi, params?: Record<string, unknown>) => BuilderNode) => ComponentDefinition }} ComponentDefinitionBuilder
 */

const SmithersSqlite = Context.GenericTag("smithers/effect/sqlite");
class ApprovalDecision extends Schema.Class("ApprovalDecision")({
    approved: Schema.Boolean,
    // `note` is omitted entirely when no note was provided so optional-string
    // approval outputs validate. If a string was provided, preserve it exactly
    // (including the empty string).
    note: Schema.optional(Schema.String),
    decidedBy: Schema.NullOr(Schema.String),
    decidedAt: Schema.NullOr(Schema.String),
}) {
}
/**
 * @param {string} name
 */
function createPayloadTable(name) {
    return sqliteTable(name, {
        runId: text("run_id").notNull(),
        nodeId: text("node_id").notNull(),
        iteration: integer("iteration").notNull().default(0),
        payload: text("payload", { mode: "json" }).$type(),
    }, (t) => ({
        pk: primaryKey({ columns: [t.runId, t.nodeId, t.iteration] }),
    }));
}
/**
 * @param {string} value
 * @returns {string}
 */
function sanitizeIdentifier(value) {
    const snake = camelToSnake(value)
        .replace(/[^a-zA-Z0-9_]+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "")
        .toLowerCase();
    return snake || "node";
}
/**
 * @param {string} id
 * @returns {string}
 */
function makeTableName(id) {
    return `smithers_${sanitizeIdentifier(id)}`;
}
/**
 * @returns {BuilderApi}
 */
function createBuilder(prefix = "") {
    /**
   * @param {string} id
   */
    const applyPrefix = (id) => (prefix ? `${prefix}.${id}` : id);
    /**
   * @param {string} id
   * @param {StepOptions} options
   * @returns {BuilderStepHandle}
   */
    const step = (id, options) => {
        const fullId = applyPrefix(id);
        const tableName = makeTableName(fullId);
        return {
            kind: "step",
            id: fullId,
            localId: id,
            tableKey: sanitizeIdentifier(fullId),
            tableName,
            table: createPayloadTable(tableName),
            output: options.output,
            needs: options.needs ?? {},
            run: options.run,
            retries: deriveRetryCount(options.retry),
            retryPolicy: options.retryPolicy ?? deriveRetryPolicy(options.retry),
            timeoutMs: durationToMs(options.timeout),
            skipIf: options.skipIf,
            cache: options.cache,
        };
    };
    /**
   * @param {string} id
   * @param {ApprovalOptions} options
   * @returns {BuilderStepHandle}
   */
    const approval = (id, options) => {
        const fullId = applyPrefix(id);
        const tableName = makeTableName(fullId);
        return {
            kind: "approval",
            id: fullId,
            localId: id,
            tableKey: sanitizeIdentifier(fullId),
            tableName,
            table: createPayloadTable(tableName),
            output: ApprovalDecision,
            needs: options.needs ?? {},
            request: options.request,
            onDeny: options.onDeny ?? "fail",
            retries: 0,
            timeoutMs: null,
        };
    };
    return {
        step,
        approval,
        sequence: (...nodes) => ({ kind: "sequence", children: nodes }),
        parallel: (...args) => {
            let maxConcurrency;
            const items = [...args];
            const last = items[items.length - 1];
            if (last &&
                typeof last === "object" &&
                !Array.isArray(last) &&
                !isBuilderNode(last) &&
                "maxConcurrency" in last) {
                maxConcurrency = Number(last.maxConcurrency);
                items.pop();
            }
            return {
                kind: "parallel",
                children: items,
                maxConcurrency,
            };
        },
        loop: (options) => ({
            kind: "loop",
            id: options.id ? applyPrefix(options.id) : undefined,
            children: options.children,
            until: options.until,
            maxIterations: options.maxIterations,
            onMaxReached: options.onMaxReached,
        }),
        match: (source, options) => ({
            kind: "match",
            source,
            when: options.when,
            then: options.then(),
            else: options.else?.(),
        }),
        component: (instanceId, definition, params) => definition.buildWithPrefix(applyPrefix(instanceId), params),
    };
}
/**
 * @param {unknown} value
 * @returns {value is BuilderNode}
 */
function isBuilderNode(value) {
    if (!value || typeof value !== "object")
        return false;
    const kind = value.kind;
    return kind === "step" ||
        kind === "approval" ||
        kind === "sequence" ||
        kind === "parallel" ||
        kind === "loop" ||
        kind === "match" ||
        kind === "branch" ||
        kind === "worktree";
}
/**
 * @param {unknown} input
 * @returns {number | null}
 */
function durationToMs(input) {
    if (input == null)
        return null;
    if (typeof input === "string") {
        const trimmed = input.trim();
        const match = trimmed.match(/^(-?\d+(?:\.\d+)?)(ms|s|m|h)$/i);
        if (match) {
            const value = Number(match[1]);
            if (Number.isFinite(value)) {
                const unit = match[2].toLowerCase();
                const factor = unit === "ms"
                    ? 1
                    : unit === "s"
                        ? 1000
                        : unit === "m"
                            ? 60_000
                            : 3_600_000;
                return Math.max(0, Math.floor(value * factor));
            }
        }
    }
    if (typeof input === "number" && Number.isFinite(input)) {
        return Math.max(0, Math.floor(input));
    }
    try {
        return Math.max(0, Math.floor(Duration.toMillis(Duration.decode(input))));
    }
    catch {
        return null;
    }
}
/**
 * @param {unknown} retry
 * @returns {RetryPolicy | undefined}
 */
function deriveRetryPolicy(retry) {
    if (!retry || typeof retry !== "object")
        return undefined;
    const backoff = retry.backoff;
    const initialDelayMs = durationToMs(retry.initialDelay);
    if (backoff !== "fixed" &&
        backoff !== "linear" &&
        backoff !== "exponential" &&
        initialDelayMs == null) {
        return undefined;
    }
    return {
        backoff: backoff === "fixed" || backoff === "linear" || backoff === "exponential"
            ? backoff
            : undefined,
        initialDelayMs: initialDelayMs ?? undefined,
    };
}
/**
 * @param {unknown} retry
 * @returns {number}
 */
function deriveRetryCount(retry) {
    if (retry == null)
        return 0;
    if (typeof retry === "number" && Number.isFinite(retry)) {
        return Math.max(0, Math.floor(retry));
    }
    if (typeof retry === "object" && retry !== null) {
        const maxAttempts = retry.maxAttempts;
        if (typeof maxAttempts === "number" && Number.isFinite(maxAttempts)) {
            return Math.max(0, Math.floor(maxAttempts - 1));
        }
    }
    const driver = Effect.runSync(Schedule.driver(retry));
    let count = 0;
    while (count < 100) {
        const exit = Effect.runSyncExit(driver.next(undefined));
        if (Exit.isFailure(exit)) {
            return count;
        }
        count += 1;
    }
    return count;
}
/**
 * @template T
 * @param {AnySchema} schema
 * @param {unknown} value
 * @returns {T}
 */
function decodeSchema(schema, value) {
    return Schema.decodeUnknownSync(schema)(value);
}
/**
 * @param {AnySchema} schema
 * @param {unknown} value
 */
function encodeSchema(schema, value) {
    return Schema.encodeSync(schema)(value);
}
/**
 * @param {BuilderStepHandle} handle
 * @param {{ iteration?: number; iterations?: Record<string, number>; }} ctx
 * @returns {number}
 */
function resolveHandleIteration(handle, ctx) {
    if (handle.loopId) {
        return ctx.iterations?.[handle.loopId] ?? 0;
    }
    return 0;
}
/**
 * @param {Record<string, unknown>} row
 */
function stripPersistedKeys(row) {
    const { runId: _runId, nodeId: _nodeId, iteration: _iteration, payload, ...rest } = row;
    if (payload !== undefined)
        return payload;
    return rest;
}
/**
 * @param {BuilderStepHandle} handle
 * @param {any} ctx
 * @returns {unknown}
 */
function readHandleMaybe(handle, ctx) {
    const iteration = resolveHandleIteration(handle, ctx);
    const row = ctx.outputMaybe(handle.tableName, {
        nodeId: handle.id,
        iteration,
    });
    if (!row)
        return undefined;
    return decodeSchema(handle.output, stripPersistedKeys(row));
}
/**
 * @param {BuilderStepHandle} handle
 * @param {any} ctx
 * @returns {unknown}
 */
function readHandle(handle, ctx) {
    const value = readHandleMaybe(handle, ctx);
    if (value === undefined) {
        throw new SmithersError("MISSING_OUTPUT", `Missing output for step "${handle.id}"`, {
            nodeId: handle.id,
        });
    }
    return value;
}
/**
 * @param {BuilderStepHandle} handle
 * @param {any} ctx
 * @param {unknown} decodedInput
 * @param {ReturnType<typeof requireTaskRuntime>} [runtime]
 * @returns {BuilderStepContext}
 */
function buildUserContext(handle, ctx, decodedInput, runtime) {
    const data = {};
    for (const [key, dependency] of Object.entries(handle.needs)) {
        data[key] = readHandle(dependency, ctx);
    }
    return {
        ...data,
        input: decodedInput,
        executionId: runtime?.runId ?? ctx.runId,
        stepId: handle.id,
        attempt: runtime?.attempt ?? 1,
        signal: runtime?.signal ?? new AbortController().signal,
        iteration: runtime?.iteration ?? resolveHandleIteration(handle, ctx),
        heartbeat: runtime?.heartbeat ?? (() => { }),
        lastHeartbeat: runtime?.lastHeartbeat ?? null,
    };
}
/**
 * @param {Record<string, BuilderStepHandle> | undefined} needs
 * @param {any} ctx
 * @param {unknown} decodedInput
 * @param {ReturnType<typeof requireTaskRuntime>} [runtime]
 */
function buildNeedsContext(needs, ctx, decodedInput, runtime) {
    const data = {};
    if (needs) {
        for (const [key, dependency] of Object.entries(needs)) {
            data[key] = readHandleMaybe(dependency, ctx);
        }
    }
    const iteration = runtime?.iteration ??
        (typeof ctx?.iteration === "number" ? ctx.iteration : 0);
    return {
        ...data,
        input: decodedInput,
        executionId: runtime?.runId ?? ctx.runId,
        stepId: runtime?.stepId ?? "",
        attempt: runtime?.attempt ?? 1,
        signal: runtime?.signal ?? new AbortController().signal,
        iteration,
        heartbeat: runtime?.heartbeat ?? (() => { }),
        lastHeartbeat: runtime?.lastHeartbeat ?? null,
        loop: { iteration: iteration + 1 },
    };
}
/**
 * @param {unknown} value
 * @param {any} env
 * @param {AbortSignal} signal
 */
async function resolveEffectResult(value, env, signal) {
    if (Effect.isEffect?.(value)) {
        return await Effect.runPromise(value.pipe(Effect.provide(env)), { signal });
    }
    if (value && typeof value.then === "function") {
        const resolved = await value;
        if (Effect.isEffect?.(resolved)) {
            return await Effect.runPromise(resolved.pipe(Effect.provide(env)), { signal });
        }
        return resolved;
    }
    return value;
}
/**
 * @param {BuilderStepHandle} handle
 * @param {any} ctx
 * @param {unknown} decodedInput
 * @param {any} env
 */
async function executeStepHandle(handle, ctx, decodedInput, env) {
    const runtime = requireTaskRuntime();
    if (handle.kind === "approval") {
        const adapter = new SmithersDb(runtime.db);
        const approval = await adapter.getApproval(runtime.runId, handle.id, runtime.iteration);
        return encodeSchema(ApprovalDecision, {
            approved: approval?.status === "approved",
            // Only include `note` when a string was provided; omitting the key
            // keeps note-less decisions valid against optional string schemas.
            ...(typeof approval?.note === "string"
                ? { note: approval.note }
                : {}),
            decidedBy: approval?.decidedBy ?? null,
            decidedAt: null,
        });
    }
    const userCtx = buildUserContext(handle, ctx, decodedInput, runtime);
    const output = await resolveEffectResult(handle.run?.(userCtx), env, runtime.signal);
    const decoded = decodeSchema(handle.output, output);
    return encodeSchema(handle.output, decoded);
}
/**
 * @param {BuilderStepHandle} handle
 * @param {any} ctx
 * @param {unknown} decodedInput
 * @returns {boolean}
 */
function evaluateSkip(handle, ctx, decodedInput) {
    if (!handle.skipIf)
        return false;
    try {
        return Boolean(handle.skipIf(buildUserContext(handle, ctx, decodedInput)));
    }
    catch {
        return false;
    }
}
/**
 * @param {BuilderNode} node
 * @param {any} ctx
 * @param {unknown} decodedInput
 * @param {any} env
 * @returns {React.ReactNode}
 */
function renderNode(node, ctx, decodedInput, env) {
    if (node.kind === "step" || node.kind === "approval") {
        const requestInfo = node.kind === "approval"
            ? (() => {
                if (!node.request)
                    return null;
                const entries = Object.entries(node.needs).map(([key, dep]) => [
                    key,
                    readHandleMaybe(dep, ctx),
                ]);
                if (entries.some(([, value]) => value === undefined)) {
                    return null;
                }
                return node.request(Object.fromEntries(entries));
            })()
            : null;
        const compute = () => executeStepHandle(node, ctx, decodedInput, env);
        const needsMap = Object.keys(node.needs).length > 0
            ? Object.fromEntries(Object.entries(node.needs).map(([key, dep]) => [key, dep.id]))
            : undefined;
        return (React.createElement(Task, {
            id: node.id,
            output: node.table,
            retries: node.retries,
            retryPolicy: node.retryPolicy,
            timeoutMs: node.timeoutMs,
            cache: node.cache,
            skipIf: evaluateSkip(node, ctx, decodedInput),
            needsApproval: node.kind === "approval",
            approvalMode: node.kind === "approval" ? "decision" : undefined,
            approvalOnDeny: node.kind === "approval" ? node.onDeny : undefined,
            needs: needsMap,
            dependsOn: Object.values(node.needs).map((dep) => dep.id),
            label: requestInfo?.title,
            meta: requestInfo?.summary
                ? { requestSummary: requestInfo.summary }
                : undefined,
            children: compute,
        }));
    }
    if (node.kind === "sequence") {
        return React.createElement(Sequence, null, node.children.map((child, index) => React.createElement(React.Fragment, { key: `sequence-${index}` }, renderNode(child, ctx, decodedInput, env))));
    }
    if (node.kind === "parallel") {
        return React.createElement(Parallel, { maxConcurrency: node.maxConcurrency }, node.children.map((child, index) => React.createElement(React.Fragment, { key: `parallel-${index}` }, renderNode(child, ctx, decodedInput, env))));
    }
    if (node.kind === "loop") {
        const outputs = {};
        for (const handle of node.handles ?? []) {
            outputs[handle.localId] = readHandleMaybe(handle, ctx);
        }
        const iteration = (node.id && ctx?.iterations && typeof ctx.iterations[node.id] === "number")
            ? ctx.iterations[node.id]
            : (typeof ctx?.iteration === "number" ? ctx.iteration : 0);
        const evalCtx = {
            ...outputs,
            input: decodedInput,
            iteration,
            loop: { iteration: iteration + 1 },
        };
        return React.createElement(Loop, {
            id: node.id,
            until: Boolean(node.until(evalCtx)),
            maxIterations: node.maxIterations,
            onMaxReached: node.onMaxReached,
        }, renderNode(node.children, ctx, decodedInput, env));
    }
    if (node.kind === "branch") {
        const baseCtx = buildNeedsContext(node.needs, ctx, decodedInput);
        const chooseThen = Boolean(node.condition(baseCtx));
        return React.createElement(Branch, {
            if: chooseThen,
            then: React.createElement(React.Fragment, null, renderNode(node.then, ctx, decodedInput, env)),
            else: node.else
                ? React.createElement(React.Fragment, null, renderNode(node.else, ctx, decodedInput, env))
                : undefined,
        });
    }
    if (node.kind === "worktree") {
        const baseCtx = buildNeedsContext(node.needs, ctx, decodedInput);
        const skip = node.skipIf ? Boolean(node.skipIf(baseCtx)) : false;
        return React.createElement(Worktree, { id: node.id, path: node.path, branch: node.branch, skipIf: skip }, renderNode(node.children, ctx, decodedInput, env));
    }
    if (node.kind === "match") {
        const sourceValue = readHandleMaybe(node.source, ctx);
        const chooseThen = sourceValue !== undefined && node.when(sourceValue);
        return React.createElement(Branch, {
            if: chooseThen,
            then: React.createElement(React.Fragment, null, renderNode(node.then, ctx, decodedInput, env)),
            else: node.else
                ? React.createElement(React.Fragment, null, renderNode(node.else, ctx, decodedInput, env))
                : undefined,
        });
    }
    return null;
}
/**
 * @param {BuilderNode} node
 * @param {BuilderStepHandle[]} [out]
 */
function collectHandles(node, out = []) {
    switch (node.kind) {
        case "step":
        case "approval":
            out.push(node);
            return out;
        case "sequence":
        case "parallel":
            for (const child of node.children)
                collectHandles(child, out);
            return out;
        case "loop":
            collectHandles(node.children, out);
            return out;
        case "match":
            collectHandles(node.then, out);
            if (node.else)
                collectHandles(node.else, out);
            return out;
        case "branch":
            collectHandles(node.then, out);
            if (node.else)
                collectHandles(node.else, out);
            return out;
        case "worktree":
            collectHandles(node.children, out);
            return out;
    }
}
/**
 * @param {BuilderStepHandle[]} handles
 */
function assertUniqueHandleIds(handles) {
    const seen = new Set();
    for (const handle of handles) {
        if (seen.has(handle.id)) {
            throw new SmithersError("DUPLICATE_ID", `Duplicate step id "${handle.id}"`, {
                kind: handle.kind,
                id: handle.id,
            });
        }
        seen.add(handle.id);
    }
}
/**
 * @param {BuilderNode} node
 * @param {string} [activeLoopId]
 * @returns {BuilderStepHandle[]}
 */
function annotateLoops(node, activeLoopId) {
    switch (node.kind) {
        case "step":
        case "approval":
            node.loopId = activeLoopId;
            return [node];
        case "sequence":
        case "parallel":
            return node.children.flatMap((child) => annotateLoops(child, activeLoopId));
        case "loop": {
            if (activeLoopId) {
                throw new SmithersError("NESTED_LOOP", "Nested builder loops are not supported.");
            }
            const handles = annotateLoops(node.children, node.id ?? "__loop__");
            node.handles = handles;
            return handles;
        }
        case "match":
            return [
                ...annotateLoops(node.then, activeLoopId),
                ...(node.else ? annotateLoops(node.else, activeLoopId) : []),
            ];
        case "branch":
            return [
                ...annotateLoops(node.then, activeLoopId),
                ...(node.else ? annotateLoops(node.else, activeLoopId) : []),
            ];
        case "worktree":
            return annotateLoops(node.children, activeLoopId);
    }
}
function createInputTable() {
    return sqliteTable("input", {
        runId: text("run_id").primaryKey(),
        payload: text("payload", { mode: "json" }).$type(),
    });
}
/**
 * @param {string} filename
 * @param {BuilderStepHandle[]} handles
 */
function createBuilderDb(filename, handles) {
    const sqlite = new Database(filename);
    sqlite.run("PRAGMA journal_mode = WAL");
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
    sqlite.run(`CREATE TABLE IF NOT EXISTS "input" (run_id TEXT PRIMARY KEY, payload TEXT)`);
    for (const handle of handles) {
        sqlite.run(`CREATE TABLE IF NOT EXISTS "${handle.tableName}" (` +
            `run_id TEXT NOT NULL, ` +
            `node_id TEXT NOT NULL, ` +
            `iteration INTEGER NOT NULL DEFAULT 0, ` +
            `payload TEXT, ` +
            `PRIMARY KEY (run_id, node_id, iteration)` +
            `)`);
    }
    const inputTable = createInputTable();
    const schema = { input: inputTable };
    for (const handle of handles) {
        schema[handle.tableKey] = handle.table;
    }
    const db = drizzle(sqlite, { schema });
    return {
        sqlite,
        db,
        inputTable,
        schema,
    };
}
/**
 * @returns {Promise<number>}
 */
async function findFreePort() {
    const net = await import("node:net");
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.on("error", reject);
        srv.listen(0, "127.0.0.1", () => {
            const address = srv.address();
            const port = typeof address === "object" && address ? address.port : 0;
            srv.close(() => resolve(port));
        });
    });
}
/**
 * PostgreSQL/PGlite equivalent of {@link createBuilderDb}. Boots a node-postgres
 * connection (for `provider: "postgres"`) or an embedded PGlite exposed over the
 * Postgres wire protocol by a local socket server (for `provider: "pglite"`),
 * ensures the durable `_smithers_*` schema, and creates the input + per-handle
 * output tables. Returns a dialect descriptor consumed by SmithersDb plus a
 * teardown hook.
 *
 * @param {{ provider: "postgres" | "pglite"; connectionString?: string; connection?: object; dataDir?: string }} config
 * @param {BuilderStepHandle[]} handles
 */
async function createBuilderDbPostgres(config, handles) {
    const pgModule = await import("pg");
    const pg = pgModule.default ?? pgModule;
    // BIGINT (ms timestamps, counters) → JS number, matching SQLite's behavior.
    pg.types.setTypeParser(20, (value) => (value === null ? null : Number(value)));
    /** @type {Array<() => Promise<void>>} */
    const teardown = [];
    let connectionString = config.connectionString;
    if (config.provider === "pglite") {
        const { PGlite } = await import("@electric-sql/pglite");
        const { PGLiteSocketServer } = await import("@electric-sql/pglite-socket");
        const pglite = await PGlite.create(config.dataDir || undefined);
        const port = await findFreePort();
        const server = new PGLiteSocketServer({ db: pglite, host: "127.0.0.1", port, maxConnections: 5 });
        await server.start();
        teardown.push(async () => {
            await server.stop().catch(() => {});
            await pglite.close().catch(() => {});
        });
        connectionString = `postgres://postgres@127.0.0.1:${port}/postgres`;
    }
    try {
        const client = new pg.Client(connectionString ? { connectionString } : config.connection);
        await client.connect();
        teardown.push(async () => {
            await client.end().catch(() => {});
        });
        // Drizzle table metadata (used by the engine to resolve the input/output
        // schema via resolveSchema). The connection is Postgres; these table objects
        // are only consulted for their column/name metadata, never to issue SQLite
        // queries against the descriptor.
        const inputTable = createInputTable();
        const schema = { input: inputTable };
        for (const handle of handles) {
            schema[handle.tableKey] = handle.table;
        }
        const descriptor = { dialect: "postgres", connection: client, schema };
        // Durable engine schema (idempotent), then the builder's input + output tables.
        const adapter = new SmithersDb(descriptor);
        await adapter.internalStorage.ensureSchema();
        await client.query({ text: `CREATE TABLE IF NOT EXISTS "input" (run_id TEXT PRIMARY KEY, payload TEXT)` });
        for (const handle of handles) {
            const escaped = handle.tableName.replaceAll(`"`, `""`);
            await client.query({
                text: `CREATE TABLE IF NOT EXISTS "${escaped}" (` +
                    `run_id TEXT NOT NULL, ` +
                    `node_id TEXT NOT NULL, ` +
                    `iteration BIGINT NOT NULL DEFAULT 0, ` +
                    `payload TEXT, ` +
                    `PRIMARY KEY (run_id, node_id, iteration)` +
                    `)`,
            });
        }
        return {
            db: descriptor,
            connection: client,
            close: async () => {
                for (const fn of teardown.reverse()) {
                    await fn();
                }
            },
        };
    }
    catch (error) {
        // Setup failed after the socket server / connection were started. Run the
        // teardown closures (reversed, error-swallowing) so the PGlite socket
        // server, embedded db, and pg client are not orphaned, then rethrow.
        for (const fn of teardown.reverse()) {
            await fn().catch(() => {});
        }
        throw error;
    }
}
/**
 * @param {any} db
 * @param {string} runId
 * @param {BuilderStepHandle} handle
 */
async function readLatestHandleResult(db, runId, handle) {
    if (db && db.dialect === "postgres" && db.connection) {
        const escaped = handle.tableName.replaceAll(`"`, `""`);
        const result = await db.connection.query({
            text: `SELECT payload FROM "${escaped}" WHERE run_id = $1 AND node_id = $2 ORDER BY iteration DESC LIMIT 1`,
            values: [runId, handle.id],
        });
        const row = result.rows[0];
        if (!row)
            return undefined;
        // The builder stores each handle's output as a JSON string in `payload`.
        const payload = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
        return decodeSchema(handle.output, payload);
    }
    const rows = await db
        .select()
        .from(handle.table)
        .where(and(eq(handle.table.runId, runId), eq(handle.table.nodeId, handle.id)))
        .orderBy(desc(handle.table.iteration))
        .limit(1);
    const row = rows[0];
    if (!row)
        return undefined;
    return decodeSchema(handle.output, stripPersistedKeys(row));
}
/**
 * @param {BuilderNode} node
 * @param {any} db
 * @param {string} runId
 * @param {unknown} [decodedInput]
 * @returns {Promise<unknown>}
 */
async function extractResult(node, db, runId, decodedInput) {
    switch (node.kind) {
        case "step":
        case "approval":
            return readLatestHandleResult(db, runId, node);
        case "sequence": {
            const last = node.children[node.children.length - 1];
            return last ? extractResult(last, db, runId, decodedInput) : undefined;
        }
        case "parallel":
            return Promise.all(node.children.map((child) => extractResult(child, db, runId, decodedInput)));
        case "loop":
            return extractResult(node.children, db, runId, decodedInput);
        case "match": {
            const source = await readLatestHandleResult(db, runId, node.source);
            if (source !== undefined && node.when(source)) {
                return extractResult(node.then, db, runId, decodedInput);
            }
            return node.else ? extractResult(node.else, db, runId, decodedInput) : undefined;
        }
        case "branch": {
            const ctx = {
                input: decodedInput ?? {},
                iteration: 0,
                loop: { iteration: 1 },
            };
            if (node.needs) {
                for (const [key, handle] of Object.entries(node.needs)) {
                    ctx[key] = await readLatestHandleResult(db, runId, handle);
                }
            }
            if (node.condition(ctx)) {
                return extractResult(node.then, db, runId, decodedInput);
            }
            return node.else ? extractResult(node.else, db, runId, decodedInput) : undefined;
        }
        case "worktree":
            return extractResult(node.children, db, runId, decodedInput);
    }
}
/**
 * @param {{ status: string; error?: unknown }} result
 */
function normalizeExecutionError(result) {
    if (result.error instanceof Error)
        return result.error;
    if (typeof result.error === "string" && result.error.length > 0) {
        return new SmithersError("WORKFLOW_EXECUTION_FAILED", result.error, {
            status: result.status,
        });
    }
    return new SmithersError("WORKFLOW_EXECUTION_FAILED", `Workflow execution ended with status "${result.status}"`, { status: result.status });
}
/**
 * @typedef {{ _tag: "WorkflowGraph"; expr: unknown; pipe: (...fns: Array<(g: any) => any>) => any }} WorkflowGraph
 */

/**
 * @param {unknown} value
 * @returns {value is WorkflowGraph}
 */
function isWorkflowGraph(value) {
    return Boolean(value) && typeof value === "object" && /** @type {any} */ (value)._tag === "WorkflowGraph";
}

/**
 * @param {unknown} expr
 * @returns {WorkflowGraph}
 */
function makeGraph(expr) {
    /** @type {WorkflowGraph} */
    const graph = /** @type {any} */ ({ _tag: "WorkflowGraph", expr });
    graph.pipe = function pipe(...fns) {
        return fns.reduce((acc, fn) => fn(acc), graph);
    };
    return graph;
}

/**
 * Build the graph constructors shared by Smithers.workflow and Smithers.fragment.
 */
function makeFactory() {
    return {
        /**
         * @param {string} id
         * @param {StepOptions} options
         */
        step: (id, options) => makeGraph({ _tag: "Step", id, options }),
        /**
         * @param {string} id
         * @param {ApprovalOptions} options
         */
        approval: (id, options) => makeGraph({ _tag: "Approval", id, options }),
        /**
         * @param {WorkflowGraph[]} children
         */
        sequence: (...children) => makeGraph({ _tag: "Sequence", children }),
        parallel: (...args) => {
            let maxConcurrency;
            const items = [...args];
            const last = items[items.length - 1];
            if (last &&
                typeof last === "object" &&
                !Array.isArray(last) &&
                !isWorkflowGraph(last) &&
                "maxConcurrency" in last) {
                maxConcurrency = Number(last.maxConcurrency);
                items.pop();
            }
            return makeGraph({ _tag: "Parallel", children: items, maxConcurrency });
        },
        match: (source, options) => makeGraph({
            _tag: "Match",
            source,
            when: options.when,
            then: options.then,
            else: options.else,
        }),
        branch: (options) => makeGraph({
            _tag: "Branch",
            condition: options.condition,
            needs: options.needs,
            then: options.then,
            else: options.else,
        }),
        loop: (options) => makeGraph({
            _tag: "Loop",
            id: options.id,
            child: options.children,
            until: options.until,
            maxIterations: options.maxIterations,
            onMaxReached: options.onMaxReached,
        }),
        worktree: (options) => makeGraph({
            _tag: "Worktree",
            id: options.id,
            path: options.path,
            branch: options.branch,
            skipIf: options.skipIf,
            needs: options.needs,
            child: options.children,
        }),
        scope: (instanceId, child) => makeGraph({
            _tag: "Scope",
            instanceId,
            child,
        }),
    };
}

/**
 * @param {string} prefix
 * @param {string | undefined} id
 */
function applyPrefixId(prefix, id) {
    if (!id) return id;
    return prefix ? `${prefix}.${id}` : id;
}

/**
 * @param {Record<string, WorkflowGraph> | undefined} needs
 * @param {string} prefix
 * @param {Map<string, Map<WorkflowGraph, BuilderNode>>} memo
 */
function compileNeeds(needs, prefix, memo) {
    if (!needs) return undefined;
    const out = {};
    for (const [key, dep] of Object.entries(needs)) {
        out[key] = compileGraph(dep, prefix, memo);
    }
    return out;
}

/**
 * Walk a graph expression tree and produce a BuilderNode tree at the active prefix.
 * Memoizes per (prefix, graph) so a value referenced as both a child and a needs source
 * compiles to a single handle, while reuse under different scopes produces distinct handles.
 *
 * @param {WorkflowGraph} graph
 * @param {string} [prefix]
 * @param {Map<string, Map<WorkflowGraph, BuilderNode>>} [memo]
 * @returns {BuilderNode}
 */
function compileGraph(graph, prefix = "", memo = new Map()) {
    let perPrefix = memo.get(prefix);
    if (!perPrefix) {
        perPrefix = new Map();
        memo.set(prefix, perPrefix);
    }
    const cached = perPrefix.get(graph);
    if (cached) return cached;

    const builder = createBuilder(prefix);
    const expr = /** @type {any} */ (graph.expr);
    let node;

    switch (expr._tag) {
        case "Step": {
            const compiledOptions = {
                ...expr.options,
                needs: compileNeeds(expr.options.needs, prefix, memo) ?? {},
            };
            node = builder.step(expr.id, compiledOptions);
            break;
        }
        case "Approval": {
            const compiledOptions = {
                ...expr.options,
                needs: compileNeeds(expr.options.needs, prefix, memo) ?? {},
            };
            node = builder.approval(expr.id, compiledOptions);
            break;
        }
        case "Sequence": {
            node = {
                kind: "sequence",
                children: expr.children.map((c) => compileGraph(c, prefix, memo)),
            };
            break;
        }
        case "Parallel": {
            node = {
                kind: "parallel",
                children: expr.children.map((c) => compileGraph(c, prefix, memo)),
                maxConcurrency: expr.maxConcurrency,
            };
            break;
        }
        case "Match": {
            node = {
                kind: "match",
                source: compileGraph(expr.source, prefix, memo),
                when: expr.when,
                then: compileGraph(expr.then, prefix, memo),
                else: expr.else ? compileGraph(expr.else, prefix, memo) : undefined,
            };
            break;
        }
        case "Branch": {
            node = {
                kind: "branch",
                condition: expr.condition,
                needs: compileNeeds(expr.needs, prefix, memo),
                then: compileGraph(expr.then, prefix, memo),
                else: expr.else ? compileGraph(expr.else, prefix, memo) : undefined,
            };
            break;
        }
        case "Loop": {
            node = {
                kind: "loop",
                id: applyPrefixId(prefix, expr.id),
                children: compileGraph(expr.child, prefix, memo),
                until: expr.until,
                maxIterations: expr.maxIterations,
                onMaxReached: expr.onMaxReached,
            };
            break;
        }
        case "Worktree": {
            node = {
                kind: "worktree",
                id: applyPrefixId(prefix, expr.id),
                path: expr.path,
                branch: expr.branch,
                skipIf: expr.skipIf,
                needs: compileNeeds(expr.needs, prefix, memo),
                children: compileGraph(expr.child, prefix, memo),
            };
            break;
        }
        case "Scope": {
            const nextPrefix = prefix ? `${prefix}.${expr.instanceId}` : expr.instanceId;
            node = compileGraph(expr.child, nextPrefix, memo);
            break;
        }
        default:
            throw new SmithersError("UNKNOWN_GRAPH_EXPR", `Unknown graph expression _tag: "${expr._tag}"`);
    }

    perPrefix.set(graph, node);
    return node;
}

/**
 * @param {{ name: string; input: AnySchema }} options
 */
export function workflow(options) {
    const factory = makeFactory();
    return {
        ...factory,
        /**
         * Finalize the workflow definition. Compiles the graph expression tree to a
         * BuilderNode tree, allocates step handles with active prefixes, and returns
         * a runnable workflow.
         *
         * @param {WorkflowGraph} graph
         */
        from(graph) {
            const root = compileGraph(graph);
            annotateLoops(root);
            const handles = collectHandles(root);
            assertUniqueHandleIds(handles);
            return {
                node: root,
                /**
                 * @param {unknown} input
                 * @param {Omit<Parameters<typeof runWorkflow>[1], "input">} [opts]
                 */
                execute(input, opts) {
                    return Effect.gen(function* () {
                        const env = yield* Effect.context();
                        const sqliteConfig = yield* SmithersSqlite;
                        const isPostgres = sqliteConfig?.provider === "postgres" ||
                            sqliteConfig?.provider === "pglite";
                        const decodedInput = decodeSchema(options.input, input);
                        const encodedInput = JSON.parse(JSON.stringify(encodeSchema(options.input, decodedInput) ?? {}));
                        return yield* Effect.acquireUseRelease(isPostgres
                            ? Effect.promise(() => createBuilderDbPostgres(sqliteConfig, handles))
                            : Effect.sync(() => createBuilderDb(sqliteConfig.filename, handles)), (runtime) => Effect.promise(async () => {
                            const wf = {
                                db: runtime.db,
                                build: (ctx) => React.createElement(Workflow, { name: options.name }, renderNode(root, ctx, decodedInput, env)),
                                opts: {},
                            };
                            const result = await Effect.runPromise(runWorkflow(wf, {
                                ...opts,
                                input: encodedInput,
                            }));
                            if (result.status === "finished") {
                                return await extractResult(root, runtime.db, result.runId, decodedInput);
                            }
                            if (result.status === "waiting-approval" ||
                                result.status === "waiting-timer") {
                                return result;
                            }
                            throw normalizeExecutionError(result);
                        }), (runtime) => isPostgres
                            ? Effect.promise(() => runtime.close())
                            : ignoreSyncError("close builder sqlite", () => runtime.sqlite.close()));
                    });
                },
            };
        },
    };
}

/**
 * Build a graph fragment whose steps live across workflows. Same constructors as
 * a workflow handle, minus `from` — fragments are values, not workflows. They compile
 * when mounted into a real workflow via `G.scope(instanceId, fragment)`.
 *
 * The input schema is preserved on the returned fragment as `inputSchema` (rather
 * than silently discarded) so a mount point can validate the inputs it passes.
 *
 * @param {AnySchema} inputSchema
 */
export function fragment(inputSchema) {
    return { ...makeFactory(), inputSchema };
}

/**
 * @param {SmithersSqliteOptions} options
 */
function sqlite(options) {
    return Layer.succeed(SmithersSqlite, options);
}

/**
 * Persist the workflow to a PostgreSQL database. `options.connectionString` (or
 * a node-postgres `options.connection` config) selects the server.
 * @param {{ connectionString?: string; connection?: object }} options
 */
function postgres(options) {
    return Layer.succeed(SmithersSqlite, { ...options, provider: "postgres" });
}

/**
 * Persist the workflow to an embedded PGlite database (Postgres-in-WASM),
 * exposed to the engine over the Postgres wire protocol via a local socket
 * server. `options.dataDir` persists to disk; omit it for an in-memory database.
 * @param {{ dataDir?: string }} [options]
 */
function pglite(options) {
    return Layer.succeed(SmithersSqlite, { ...(options ?? {}), provider: "pglite" });
}

/** @type {{ sqlite: typeof sqlite; postgres: typeof postgres; pglite: typeof pglite; workflow: typeof workflow; fragment: typeof fragment }} */
export const Smithers = {
    sqlite,
    postgres,
    pglite,
    workflow,
    fragment,
};

export const __builderInternals = {
    ApprovalDecision,
    SmithersSqlite,
    annotateLoops,
    applyPrefixId,
    assertUniqueHandleIds,
    buildNeedsContext,
    buildUserContext,
    collectHandles,
    compileGraph,
    compileNeeds,
    createBuilder,
    createBuilderDb,
    createBuilderDbPostgres,
    createInputTable,
    createPayloadTable,
    decodeSchema,
    deriveRetryCount,
    deriveRetryPolicy,
    durationToMs,
    encodeSchema,
    evaluateSkip,
    executeStepHandle,
    extractResult,
    isBuilderNode,
    isWorkflowGraph,
    makeFactory,
    makeGraph,
    makeTableName,
    normalizeExecutionError,
    readHandle,
    readHandleMaybe,
    readLatestHandleResult,
    renderNode,
    resolveEffectResult,
    resolveHandleIteration,
    sanitizeIdentifier,
    sqlite,
    postgres,
    pglite,
    stripPersistedKeys,
};
