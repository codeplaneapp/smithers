import React from "react";
import { SmithersContext } from "@smithers-orchestrator/react-reconciler/context";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { foldMachineState, hashFoldEvents, orderFoldEvents } from "./foldMachine.js";
import { lintMachine } from "./lintMachine.js";
import { stableHash } from "./stableHash.js";

/** @typedef {import("./EventSource.ts").SmithersEventSource} SmithersEventSource */
/** @typedef {import("./FoldEvent.ts").FoldEvent} FoldEvent */

/**
 * In-process memoized folds keyed by `${runId}::${machine id}`. Entries
 * validate by CONTENT (a payload hash per ordered event), never by
 * (count, maxSeq): an in-place payload replacement at the same
 * (nodeId, iteration) retains its seq but must invalidate the folded prefix.
 * Resume/rewind/fork always land in a fresh process or fail the content
 * check, so they refold from rows — the cache is a per-frame cost saver,
 * never a source of truth.
 * @type {Map<string, { machine: import("xstate").AnyStateMachine; inputHash: string; eventHashes: string[]; snapshot: import("xstate").AnyMachineSnapshot; folded: number }>}
 */
const foldCache = new Map();

/** Machines already warned about reinterpreting an existing fold history. @type {WeakSet<object>} */
const reinterpretationWarned = new WeakSet();

/** Per-render-ctx machine registry for duplicate-id detection. @type {WeakMap<object, Map<string, object>>} */
const machinesByCtx = new WeakMap();

/**
 * Compute an XState machine's state as a pure fold over durable Smithers
 * rows. Nothing about the machine is persisted: resume, fork, and rewind are
 * correct because the fold's inputs are exactly the rows those features
 * restore. Event sources must be pure functions of `ctx` — never of machine
 * state. Returns the final MachineSnapshot (`state.matches` / `state.can` /
 * `state.context` / `state.hasTag` work as `@xstate/react` users expect).
 *
 * @template {import("xstate").AnyStateMachine} TMachine
 * @param {TMachine} machine Define machines at module scope — a machine
 *   recreated inside the component body defeats the fold cache every frame.
 * @param {{ id: string; input?: unknown; events?: SmithersEventSource[] }} options
 *   `id` namespaces this machine instance for caching and error messages;
 *   multiple machines per workflow must use distinct ids.
 * @returns {import("xstate").SnapshotFrom<TMachine>}
 */
export function useSmithersMachine(machine, options) {
    const ctx = React.useContext(SmithersContext);
    if (!ctx) {
        throw new SmithersError("XSTATE_OUTSIDE_WORKFLOW", "useSmithersMachine() must be called inside a <Workflow> render created by createSmithers().");
    }
    return computeMachineState(/** @type {import("./EventSource.ts").SmithersCtxLike & { runId: string }} */ (/** @type {unknown} */ (ctx)), machine, options);
}

/**
 * The non-hook core of `useSmithersMachine`: lint, collect, order, fold,
 * cache. Exposed so tooling (and tests) can reconstruct machine state from a
 * ctx-shaped row reader without a React render — valid only while the loaded
 * machine matches the run's recorded workflow code.
 *
 * @template {import("xstate").AnyStateMachine} TMachine
 * @param {import("./EventSource.ts").SmithersCtxLike & { runId: string }} ctx
 * @param {TMachine} machine
 * @param {{ id: string; input?: unknown; events?: SmithersEventSource[] }} options
 * @returns {import("xstate").SnapshotFrom<TMachine>}
 */
export function computeMachineState(ctx, machine, options) {
    if (!options || typeof options.id !== "string" || options.id.trim() === "") {
        throw new SmithersError("XSTATE_MACHINE_ID_REQUIRED", "useSmithersMachine() requires a non-empty { id } so multiple machines, caches, and error messages stay distinguishable.");
    }
    const id = options.id;
    registerMachineId(ctx, id, machine);
    lintMachine(id, machine);
    const events = collectEvents(ctx, id, options.events ?? []);
    return /** @type {import("xstate").SnapshotFrom<TMachine>} */ (foldWithCache(`${ctx.runId}::${id}`, machine, id, options.input, events));
}

/**
 * @param {object} ctx
 * @param {string} id
 * @param {object} machine
 */
function registerMachineId(ctx, id, machine) {
    let registry = machinesByCtx.get(ctx);
    if (!registry) {
        registry = new Map();
        machinesByCtx.set(ctx, registry);
    }
    const existing = registry.get(id);
    if (existing && existing !== machine) {
        throw new SmithersError("XSTATE_MACHINE_ID_CONFLICT", `Two different machines used id "${id}" in the same render. Give each useSmithersMachine call a distinct id — and define machines at module scope, not inside the component body, so identity is stable across renders.`, { machineId: id });
    }
    registry.set(id, machine);
}

/**
 * @param {import("./EventSource.ts").SmithersCtxLike} ctx
 * @param {string} id
 * @param {SmithersEventSource[]} sources
 * @returns {FoldEvent[]}
 */
function collectEvents(ctx, id, sources) {
    /** @type {FoldEvent[]} */
    const events = [];
    sources.forEach((source, declarationIndex) => {
        if (!source || typeof source.collect !== "function") {
            throw new SmithersError("XSTATE_EVENT_SOURCE_INVALID", `Machine "${id}" events[${declarationIndex}] is not an event source. Use taskOutput(), approvalDecided(), eventReceived(), or timedOut().`, { machineId: id, declarationIndex });
        }
        for (const entry of source.collect(ctx)) {
            entry.events.forEach((event, subIndex) => {
                events.push({ seq: entry.seq, declarationIndex, subIndex, event });
            });
        }
    });
    return orderFoldEvents(events);
}

/**
 * @param {string} cacheKey
 * @param {import("xstate").AnyStateMachine} machine
 * @param {string} id
 * @param {unknown} input
 * @param {FoldEvent[]} events
 * @returns {import("xstate").AnyMachineSnapshot}
 */
function foldWithCache(cacheKey, machine, id, input, events) {
    const inputHash = stableHash(input);
    const eventHashes = hashFoldEvents(events);
    const cached = foldCache.get(cacheKey);
    if (cached && cached.machine !== machine && !reinterpretationWarned.has(machine)) {
        // Mid-run machine edit (hot reload): the fold reinterprets recorded
        // history under the new reducer. Deliberate migrations should prefer
        // fork-and-migrate.
        console.warn(`[smithers-xstate] Machine "${id}" changed identity mid-run; folded history will be reinterpreted under the new machine definition.`);
        reinterpretationWarned.add(machine);
    }
    if (cached &&
        cached.machine === machine &&
        cached.inputHash === inputHash &&
        eventHashes.length >= cached.eventHashes.length &&
        cached.eventHashes.every((hash, i) => hash === eventHashes[i])) {
        const { snapshot, folded } = foldMachineState(machine, {
            id,
            input,
            events,
            startAt: { snapshot: cached.snapshot, alreadyFolded: cached.folded },
        });
        foldCache.set(cacheKey, { machine, inputHash, eventHashes, snapshot, folded });
        return snapshot;
    }
    const { snapshot, folded } = foldMachineState(machine, { id, input, events });
    foldCache.set(cacheKey, { machine, inputHash, eventHashes, snapshot, folded });
    return snapshot;
}

/** Test seam. */
export const __machineCacheInternals = { foldCache };
