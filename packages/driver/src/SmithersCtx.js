import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { buildCurrentScopes } from "./buildCurrentScopes.js";
import { filterRowsByNodeId } from "./filterRowsByNodeId.js";
import { normalizeInputRow } from "./normalizeInputRow.js";
import { withLogicalIterationShortcuts } from "./withLogicalIterationShortcuts.js";
import { RuntimeCapabilityError } from "./RuntimeCapabilityError.js";
import { digestProofRow } from "./provenance.js";
/** @typedef {import("./OutputKey.ts").OutputKey} OutputKey */
/** @typedef {import("./SafeParser.ts").SafeParser} SafeParser */
/** @typedef {import("./SmithersCtxOptions.ts").SmithersCtxOptions} SmithersCtxOptions */
/** @typedef {import("./RunAuthContext.ts").RunAuthContext} RunAuthContext */
/** @typedef {import("@smithers-orchestrator/graph/ProofBinding").ProofBinding} ProofBinding */
/** @typedef {import("./SmithersRuntimeConfig.ts").SmithersRuntimeConfig} SmithersRuntimeConfig */
/** @typedef {unknown} TableRef */
/** @typedef {Record<string, unknown>} OutputRow User-visible output row — harness metadata fields (runId, nodeId, iteration) are stripped. */
/**
 * @template Schema
 * @template T
 * @typedef {import("./ResolveOutputRow.ts").ResolveOutputRow<Schema, T>} ResolveOutputRow
 */
/**
 * @template Schema
 * @typedef {import("./OutputAccessor.ts").OutputAccessor<Schema>} OutputAccessor
 */

/**
 * Strip harness metadata columns (runId/nodeId/iteration) from an output row
 * before handing it to user code. Mirrors `@smithers-orchestrator/db/output`'s
 * `stripAutoColumns` exactly (array values pass through unchanged; only plain
 * objects get the three keys omitted) — duplicated locally, rather than
 * imported, because `@smithers-orchestrator/db` pulls in sqlite/postgres
 * modules this portable driver core must stay free of.
 * @param {unknown} row
 * @returns {unknown}
 */
function stripAutoColumns(row) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
        return row;
    }
    const { runId: _runId, nodeId: _nodeId, iteration: _iteration, ...rest } = /** @type {Record<string, unknown>} */ (row);
    return rest;
}
/**
 * @param {TableRef} table
 * @returns {string | undefined}
 */
function resolveDrizzleName(table) {
    if (!table || typeof table !== "object")
        return undefined;
    const tableObj = /** @type {Record<string, unknown>} */ (table);
    const tableMeta = tableObj._;
    if (tableMeta &&
        typeof tableMeta === "object" &&
        typeof (/** @type {Record<string, unknown>} */ (tableMeta)).name === "string") {
        return /** @type {string} */ ((/** @type {Record<string, unknown>} */ (tableMeta)).name);
    }
    if (typeof tableObj.name === "string")
        return /** @type {string} */ (tableObj.name);
    return undefined;
}

/**
 * @template {unknown} [Schema=unknown]
 */
export class SmithersCtx {
    /** @type {string} */
    runId;
    /** @type {number} */
    iteration;
    /** @type {Record<string, number> | undefined} */
    iterations;
    /** @type {Schema extends { input: infer T } ? T : unknown} */
    input;
    /** @type {RunAuthContext | null} */
    auth;
    /** @type {SmithersRuntimeConfig | null | undefined} */
    __smithersRuntime;
    /** @type {Record<string, string>} */
    _worktreePaths;
    /** @type {OutputAccessor<Schema>} */
    outputs;
    /** @type {import("./OutputSnapshot.ts").OutputSnapshot} */
    _outputs;
    /** @type {Map<unknown, string> | undefined} */
    _zodToKeyName;
    /** @type {Set<string>} */
    _currentScopes;
    /** @type {ReadonlyMap<string, unknown> | Record<string, unknown> | undefined} */
    _taskStates;
    /** @type {ReadonlyMap<string, number> | Record<string, number> | undefined} */
    _taskIterations;
    /**
     * Tasks that declared `deps` but could not resolve them this render, so
     * they deferred (returned null) instead of mounting. The engine reads this
     * after each render: a deferral is normal while an upstream is still
     * producing, but one that survives to quiescence means the dependency can
     * never resolve (e.g. a deps/needs key that maps to a node id no task
     * produces) and the run would otherwise finish silently without it.
     * @type {{ nodeId: string; waitingOn: string[] }[]}
     */
    _deferredDeps = [];
    /**
     * @param {SmithersCtxOptions} opts
     */
    constructor(opts) {
        this.runId = opts.runId;
        this.iteration = opts.iteration;
        this.iterations = withLogicalIterationShortcuts(opts.iterations);
        this.input = /** @type {Schema extends { input: infer T } ? T : unknown} */ (normalizeInputRow(opts.input));
        this.auth = opts.auth ?? null;
        this.__smithersRuntime = opts.runtimeConfig ?? null;
        this._worktreePaths = opts.runtimeConfig?.worktreePaths ?? {};
        this._outputs = opts.outputs;
        this._zodToKeyName = opts.zodToKeyName;
        this._currentScopes = buildCurrentScopes(this.iterations);
        this._taskStates = opts.taskStates;
        this._taskIterations = opts.taskIterations;
        /**
         * @param {string} table
         */
        const outputsFn = (table) => opts.outputs[table] ?? [];
        for (const [name, rows] of Object.entries(opts.outputs)) {
            outputsFn[name] = rows;
        }
        this.outputs = /** @type {OutputAccessor<Schema>} */ (/** @type {unknown} */ (outputsFn));
    }
    /**
     * Return the resolved absolute path for a rendered worktree or task id.
     * The lookup is populated from task descriptors, so task node ids and
     * explicit <Worktree id> values both work once the worktree has rendered.
     *
     * @param {string} id
     * @returns {string | undefined}
     */
    worktreePath(id) {
        return this._worktreePaths[id];
    }
    /**
     * Resolve a <Worktree path> prop against the active workflow root using
     * the same resolver graph extraction uses. Delegates to the runtime's
     * injected `resolveWorktreePath` resolver (sourced from
     * `runtimeAdapter.worktree.resolve` — see `WorkflowDriver.renderAndSubmit`)
     * so this class never statically imports a Node-only path resolver
     * itself; that keeps `SmithersCtx` safe to bundle for non-Node runtimes.
     * Throws a typed `RuntimeCapabilityError` if no resolver was configured.
     *
     * @param {string} path
     * @returns {string}
     */
    resolveWorktreePath(path) {
        const resolver = this.__smithersRuntime?.resolveWorktreePath;
        if (typeof resolver !== "function") {
            throw new RuntimeCapabilityError(this.__smithersRuntime?.runtimeName ?? "unconfigured", "worktree", "resolve");
        }
        return resolver(path, {
            baseRootDir: this.__smithersRuntime?.baseRootDir,
            workflowPath: this.__smithersRuntime?.workflowPath,
        });
    }
    /**
     * @template {keyof Schema & string} K
     * @overload
     * @param {K} table
     * @param {OutputKey} key
     * @returns {ResolveOutputRow<Schema, K>}
     */
    /**
     * @template {TableRef} T
     * @overload
     * @param {T} table
     * @param {OutputKey} key
     * @returns {ResolveOutputRow<Schema, T>}
     */
    /**
     * @template {TableRef} T
     * @param {T} table
     * @param {OutputKey} key
     * @returns {ResolveOutputRow<Schema, T>}
     */
    output(table, key) {
        const row = this.resolveRow(table, key);
        if (!row) {
            throw new SmithersError("MISSING_OUTPUT", `Missing output for nodeId=${key.nodeId} iteration=${key.iteration ?? 0}`, { nodeId: key.nodeId, iteration: key.iteration ?? 0 });
        }
        return /** @type {ResolveOutputRow<Schema, T>} */ (/** @type {unknown} */ (stripAutoColumns(row)));
    }
    /**
     * Resolve a single output row. Without an explicit `key.iteration` this
     * resolves the CURRENT render iteration — which equals the loop iteration
     * only for a single, non-nested loop, and is 0 when several loops coexist.
     * For a `<Loop>` exit condition use {@link latest} (the most recent
     * iteration), not `outputMaybe`, or an `until` built on it never advances.
     *
     * @template {keyof Schema & string} K
     * @overload
     * @param {K} table
     * @param {OutputKey} key
     * @returns {ResolveOutputRow<Schema, K> | undefined}
     */
    /**
     * @template {TableRef} T
     * @overload
     * @param {T} table
     * @param {OutputKey} key
     * @returns {ResolveOutputRow<Schema, T> | undefined}
     */
    /**
     * @template {TableRef} T
     * @param {T} table
     * @param {OutputKey} key
     * @returns {ResolveOutputRow<Schema, T> | undefined}
     */
    outputMaybe(table, key) {
        const row = this.resolveRow(table, key);
        return row !== undefined ? /** @type {ResolveOutputRow<Schema, T>} */ (/** @type {unknown} */ (stripAutoColumns(row))) : undefined;
    }
    /**
     * Resolve the most recent iteration's output row for `nodeId` (highest
     * iteration across all matching rows). This is the correct reader for a
     * `<Loop>`/`<Ralph>` `until` exit condition; {@link outputMaybe} resolves
     * the current render iteration and can read stale/iteration-0 data inside a
     * loop.
     *
     * @template {keyof Schema & string} K
     * @overload
     * @param {K} table
     * @param {string} nodeId
     * @returns {ResolveOutputRow<Schema, K> | undefined}
     */
    /**
     * @template {TableRef} T
     * @overload
     * @param {T} table
     * @param {string} nodeId
     * @returns {ResolveOutputRow<Schema, T> | undefined}
     */
    /**
     * @template {TableRef} T
     * @param {T} table
     * @param {string} nodeId
     * @returns {ResolveOutputRow<Schema, T> | undefined}
     */
    latest(table, nodeId) {
        const tableName = this.resolveTableName(table);
        const rows = this._outputs[tableName] ?? [];
        const matching = filterRowsByNodeId(rows, nodeId, this._currentScopes);
        /** @type {ResolveOutputRow<Schema, T> | undefined} */
        let best = undefined;
        let bestIteration = -Infinity;
        for (const row of matching) {
            const iter = Number.isFinite(Number(row.iteration))
                ? Number(row.iteration)
                : 0;
            if (!best || iter >= bestIteration) {
                best = /** @type {ResolveOutputRow<Schema, T>} */ (/** @type {unknown} */ (stripAutoColumns(row)));
                bestIteration = iter;
            }
        }
        return best;
    }
    /**
     * Bind to the latest (or explicitly named) persisted output row for a node.
     * The digest is computed from the typed row only; persistence identity
     * columns are carried separately in the returned binding.
     *
     * @param {TableRef} table
     * @param {OutputKey} key
     * @returns {ProofBinding | undefined}
     */
    prove(table, key) {
        const tableName = this.resolveTableName(table);
        const rows = this._outputs[tableName] ?? [];
        const matching = filterRowsByNodeId(rows, key.nodeId, this._currentScopes);
        let row;
        if (key.iteration !== undefined) {
            row = matching.find((candidate) => Number(candidate.iteration ?? 0) === key.iteration);
        }
        else {
            let bestIteration = -Infinity;
            for (const candidate of matching) {
                const candidateIteration = Number.isFinite(Number(candidate.iteration))
                    ? Number(candidate.iteration)
                    : 0;
                if (!row || candidateIteration >= bestIteration) {
                    row = candidate;
                    bestIteration = candidateIteration;
                }
            }
        }
        if (!row)
            return undefined;
        return {
            table: tableName,
            nodeId: String(row.nodeId ?? key.nodeId),
            iteration: Number.isFinite(Number(row.iteration)) ? Number(row.iteration) : 0,
            digest: digestProofRow(row),
        };
    }
    /**
     * Whether the named task has attempted scheduling and its proof binding no
     * longer matches the current authority row.
     *
     * @param {string} nodeId
     * @returns {boolean}
     */
    boundStale(nodeId) {
        const entries = this._taskStates instanceof Map
            ? this._taskStates.entries()
            : Object.entries(this._taskStates ?? {});
        const states = [];
        for (const [stateKey, state] of entries) {
            const separator = stateKey.lastIndexOf("::");
            const stateNodeId = separator >= 0 ? stateKey.slice(0, separator) : stateKey;
            const parsedIteration = separator >= 0 ? Number(stateKey.slice(separator + 2)) : 0;
            states.push({
                nodeId: stateNodeId,
                iteration: Number.isFinite(parsedIteration) ? parsedIteration : 0,
                state,
            });
        }
        const matching = filterRowsByNodeId(states, nodeId, this._currentScopes);
        const resolvedNodeId = matching[0]?.nodeId ?? nodeId;
        const taskIteration = this._taskIterations instanceof Map
            ? this._taskIterations.get(resolvedNodeId) ?? this._taskIterations.get(nodeId)
            : this._taskIterations?.[resolvedNodeId] ?? this._taskIterations?.[nodeId];
        const currentIteration = taskIteration ?? this.iteration;
        return matching.some((entry) => entry.iteration === currentIteration && entry.state === "bound-stale");
    }
    /**
     * @param {unknown} value
     * @param {SafeParser} schema
     * @returns {unknown[]}
     */
    latestArray(value, schema) {
        if (value == null)
            return [];
        let arr;
        if (typeof value === "string") {
            try {
                const parsed = JSON.parse(value);
                arr = Array.isArray(parsed) ? parsed : [parsed];
            }
            catch {
                return [];
            }
        }
        else {
            arr = Array.isArray(value) ? value : [value];
        }
        return arr.flatMap((item) => {
            const parsed = schema.safeParse(item);
            return parsed.success ? [parsed.data] : [];
        });
    }
    /**
     * @param {TableRef} table
     * @param {string} nodeId
     * @returns {number}
     */
    iterationCount(table, nodeId) {
        const tableName = this.resolveTableName(table);
        const rows = this._outputs[tableName] ?? [];
        const matching = filterRowsByNodeId(rows, nodeId, this._currentScopes);
        const seen = new Set();
        for (const row of matching) {
            const iter = Number.isFinite(Number(row.iteration))
                ? Number(row.iteration)
                : 0;
            seen.add(iter);
        }
        return seen.size;
    }
    /**
     * @param {TableRef} table
     * @returns {string}
     */
    resolveTableName(table) {
        if (typeof table === "string")
            return table;
        const zodKey = this._zodToKeyName?.get(table);
        if (zodKey)
            return zodKey;
        return resolveDrizzleName(table) ?? String(table);
    }
    /**
     * Record that a task with `deps` deferred this render because its
     * dependencies were not resolvable. Called by the Task component before it
     * returns null. The engine inspects these at quiescence to turn a permanent
     * deferral (a never-satisfiable dependency) into a loud error instead of a
     * silent skip.
     * @param {string} nodeId
     * @param {string[]} waitingOn
     * @returns {void}
     */
    recordDeferredDep(nodeId, waitingOn) {
        if (typeof nodeId !== "string" || nodeId.length === 0)
            return;
        this._deferredDeps.push({ nodeId, waitingOn: Array.isArray(waitingOn) ? waitingOn : [] });
    }
    /**
     * @param {TableRef} table
     * @param {OutputKey} key
     * @returns {OutputRow | undefined}
     */
    resolveRow(table, key) {
        const tableName = this.resolveTableName(table);
        const rows = this._outputs[tableName] ?? [];
        const matching = filterRowsByNodeId(rows, key.nodeId, this._currentScopes);
        const targetIteration = key.iteration ?? this.iteration;
        const exact = matching.find((row) => (row.iteration ?? 0) === targetIteration);
        if (exact)
            return exact;
        // Cross-loop-boundary resolution: a task INSIDE a loop (this.iteration >= 1)
        // that depends — via deps/needs — on a task OUTSIDE the loop never matched
        // the strict equality above, because the upstream wrote its row with an
        // unscoped nodeId at its own iteration (typically 0) while the depender
        // renders at the loop iteration. That mismatch made the dependent task
        // resolve `undefined` and unmount forever. Resolve an unscoped producer
        // (one that ran outside any loop) at its own iteration instead.
        //
        // The relaxation is deliberately narrow: it only applies when the caller
        // did not pin an explicit iteration, and only to rows whose nodeId carries
        // no loop scope (`@@`). An in-loop producer always writes scoped rows, so it
        // keeps the strict gate above — a not-yet-produced iteration still defers
        // instead of resolving stale data from an earlier pass.
        if (key.iteration === undefined) {
            return matching.find((row) => typeof row.nodeId === "string" && !row.nodeId.includes("@@"));
        }
        return undefined;
    }
}
