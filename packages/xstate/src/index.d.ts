import * as xstate from 'xstate';
import { AnyEventObject } from 'xstate';

/** One machine event collected from a durable row, positioned in the fold's total order. */
type FoldEvent$2 = {
    /** Shared provenance clock position of the source row (outputs and signals). */
    seq: number;
    /** Index of the producing source in the `events` declaration array. */
    declarationIndex: number;
    /** Index within the array a single `map` call returned (0 for scalar returns). */
    subIndex: number;
    /** The mapped machine event. */
    event: AnyEventObject;
};

/** What a source `map` callback may return: one event, several, or none. */
type MappedEvents$2 = AnyEventObject | AnyEventObject[] | null | undefined;
/** Row metadata handed to output-backed source `map` callbacks. */
type OutputRowMeta$1 = {
    nodeId: string;
    iteration: number;
    seq: number;
};
/** Row metadata handed to `eventReceived` `map` callbacks. */
type SignalRowMeta$1 = {
    signalName: string;
    seq: number;
    correlationId?: string;
    receivedAtMs: number;
};
type OutputSourceOptions$2 = {
    nodeId?: string;
    scope?: string;
};
/**
 * A declared event source: a pure function of `ctx` (never of machine state)
 * that yields `{ seq, events }` entries for the fold. Construct these with
 * `taskOutput` / `approvalDecided` / `eventReceived` / `timedOut`.
 */
type SmithersEventSource$3 = {
    kind: "taskOutput" | "approvalDecided" | "eventReceived" | "timedOut";
    collect(ctx: SmithersCtxLike$1): Array<{
        seq: number;
        events: AnyEventObject[];
    }>;
};
/** The slice of SmithersCtx the sources read. Kept structural so the package
 * never depends on the driver at runtime. */
type SmithersCtxLike$1 = {
    outputRows(output: unknown, options?: {
        nodeId?: string;
        scope?: string;
    }): Array<{
        payload: unknown;
        nodeId: string;
        iteration: number;
        seq: number;
    }>;
    signalRows(signalName: string, options?: {
        correlationId?: string;
    }): Array<{
        payload: unknown;
        signalName: string;
        seq: number;
        correlationId?: string;
        receivedAtMs: number;
    }>;
};

/**
 * Reject machine features that cannot exist inside a durable pure fold.
 * Runs per machine identity at mount. There is deliberately NO escape hatch:
 * a silently-inert invoke/after/raise is worse than a hard error, especially
 * for AI authors. The exact builtin-action allowlist is `assign` (without
 * spawn — runtime spawns are rejected by the fold's children check).
 *
 * @param {string} machineId `useSmithersMachine` id, for error messages.
 * @param {import("xstate").AnyStateMachine} machine
 */
declare function lintMachine(machineId: string, machine: xstate.AnyStateMachine): void;

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
declare function useSmithersMachine<TMachine extends xstate.AnyStateMachine>(machine: TMachine, options: {
    id: string;
    input?: unknown;
    events?: SmithersEventSource$2[];
}): xstate.SnapshotFrom<TMachine>;
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
declare function computeMachineState<TMachine extends xstate.AnyStateMachine>(ctx: SmithersCtxLike$1 & {
    runId: string;
}, machine: TMachine, options: {
    id: string;
    input?: unknown;
    events?: SmithersEventSource$2[];
}): xstate.SnapshotFrom<TMachine>;
declare namespace __machineCacheInternals {
    export { foldCache };
}
type SmithersEventSource$2 = SmithersEventSource$3;
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
declare const foldCache: Map<string, {
    machine: xstate.AnyStateMachine;
    inputHash: string;
    eventHashes: string[];
    snapshot: xstate.AnyMachineSnapshot;
    folded: number;
}>;

/**
 * One machine event (or several) per durable output row, read via
 * `ctx.outputRows`. Named deliberately: it means "a successful durable output
 * row exists", not "the task completed" — failed attempts write no row,
 * `continueOnFail` can end a task without one, and `(nodeId, iteration)`
 * writes are upserts.
 *
 * @template Payload
 * @param {unknown} output Schema key, zod schema, or output table target.
 * @param {OutputSourceOptions} options
 * @param {(payload: Payload, meta: import("./EventSource.ts").OutputRowMeta) => MappedEvents} map
 * @returns {SmithersEventSource}
 */
declare function taskOutput<Payload>(output: unknown, options: OutputSourceOptions$1, map: (payload: Payload, meta: OutputRowMeta$1) => MappedEvents$1): SmithersEventSource$1;
/**
 * Approval decision rows from an `<ApprovalGate>` (or approval-gated task)
 * output table. Identical row mechanics to `taskOutput`; the distinct name
 * keeps machine wiring self-describing. Denials only produce a row when the
 * gate uses `onDeny: "continue"` — a failing gate ends the branch and writes
 * nothing for the fold to see.
 *
 * @template Payload
 * @param {unknown} output
 * @param {OutputSourceOptions} options
 * @param {(payload: Payload, meta: import("./EventSource.ts").OutputRowMeta) => MappedEvents} map
 * @returns {SmithersEventSource}
 */
declare function approvalDecided<Payload>(output: unknown, options: OutputSourceOptions$1, map: (payload: Payload, meta: OutputRowMeta$1) => MappedEvents$1): SmithersEventSource$1;
/**
 * Tagged `{ kind: "timeout" }` rows written by waits that opted into the
 * tagged wait-result envelope (`onTimeout: "continue"` + `tagged`). Rows
 * whose payload is not a timeout envelope are skipped, so this source can
 * share an output table with a `taskOutput` source reading the signal arm.
 *
 * @param {unknown} output
 * @param {OutputSourceOptions} options
 * @param {(payload: { kind: "timeout" }, meta: import("./EventSource.ts").OutputRowMeta) => MappedEvents} map
 * @returns {SmithersEventSource}
 */
declare function timedOut(output: unknown, options: OutputSourceOptions$1, map: (payload: {
    kind: "timeout";
}, meta: OutputRowMeta$1) => MappedEvents$1): SmithersEventSource$1;
/**
 * Durable delivered signals, folded DIRECTLY over `_smithers_signals` rows in
 * the shared provenance clock — never over `<WaitForEvent>` output rows. Every
 * delivered signal reaches the fold in seq order regardless of listener mount
 * timing; a parked listener is wake-and-park plumbing, not the event source.
 * Signal payloads that fail `schema.safeParse` are skipped deterministically
 * (same rows ⇒ same skips) so a malformed external delivery can never brick
 * every future render of the run.
 *
 * @template Payload
 * @param {string} signalName
 * @param {{ safeParse(value: unknown): { success: boolean; data?: unknown } } | null} schema Zod (or zod-shaped) payload schema; pass null to accept any payload.
 * @param {(payload: Payload, meta: import("./EventSource.ts").SignalRowMeta) => MappedEvents} map
 * @returns {SmithersEventSource}
 */
declare function eventReceived<Payload>(signalName: string, schema: {
    safeParse(value: unknown): {
        success: boolean;
        data?: unknown;
    };
} | null, map: (payload: Payload, meta: SignalRowMeta$1) => MappedEvents$1): SmithersEventSource$1;
type SmithersEventSource$1 = SmithersEventSource$3;
type MappedEvents$1 = MappedEvents$2;
type OutputSourceOptions$1 = OutputSourceOptions$2;

/** @typedef {import("./FoldEvent.ts").FoldEvent} FoldEvent */
/**
 * Order collected events into the fold's total order:
 * (provenance seq, declaration index, mapped-event subindex).
 * Causal arrival order first, deterministic tiebreaks after — a pure
 * function of rows on every branch, in every process.
 * @param {FoldEvent[]} events
 * @returns {FoldEvent[]}
 */
declare function orderFoldEvents(events: FoldEvent$1[]): FoldEvent$1[];
/**
 * Pure fold: `initialTransition(machine, input)` then one
 * `transition(machine, snapshot, event)` per ordered event. Both return
 * `[snapshot, actions]`; actions are discarded (builtin `assign` applies
 * inside `transition` itself). Events arriving after the machine leaves
 * `active` status are discarded, matching live-actor semantics. Any snapshot
 * that acquires children means `spawn` ran inside an `assign` — rejected
 * with a typed error (the mount lint cannot see runtime spawns).
 *
 * @param {import("xstate").AnyStateMachine} machine
 * @param {{ id: string; input?: unknown; events: FoldEvent[]; startAt?: { snapshot: import("xstate").AnyMachineSnapshot; alreadyFolded: number } }} options
 * @returns {{ snapshot: import("xstate").AnyMachineSnapshot; folded: number }}
 */
declare function foldMachineState(machine: xstate.AnyStateMachine, options: {
    id: string;
    input?: unknown;
    events: FoldEvent$1[];
    startAt?: {
        snapshot: xstate.AnyMachineSnapshot;
        alreadyFolded: number;
    };
}): {
    snapshot: xstate.AnyMachineSnapshot;
    folded: number;
};
/**
 * Content hashes for the prefix cache: one hash per ordered event. The cache
 * validates by CONTENT, never by (count, maxSeq) — an in-place payload
 * replacement at the same (nodeId, iteration) keeps its seq but must
 * invalidate the folded prefix from that position.
 * @param {FoldEvent[]} events
 * @returns {string[]}
 */
declare function hashFoldEvents(events: FoldEvent$1[]): string[];
type FoldEvent$1 = FoldEvent$2;

/**
 * Deterministic content hash for event payloads: canonical JSON (recursively
 * sorted object keys) digested with two independently-seeded FNV-1a passes
 * plus the canonical length. Used by the prefix cache to validate folded
 * history by CONTENT — an in-place payload replacement at the same
 * (nodeId, iteration) retains its seq but must still invalidate the cache,
 * so (count, maxSeq) style checks are never enough.
 * @param {unknown} value
 * @returns {string}
 */
declare function stableHash(value: unknown): string;
/**
 * @param {unknown} value
 * @returns {string}
 */
declare function stableStringify(value: unknown): string;

type SmithersEventSource = SmithersEventSource$3;
type SmithersCtxLike = SmithersCtxLike$1;
type MappedEvents = MappedEvents$2;
type OutputRowMeta = OutputRowMeta$1;
type SignalRowMeta = SignalRowMeta$1;
type OutputSourceOptions = OutputSourceOptions$2;
type FoldEvent = FoldEvent$2;

export { type FoldEvent, type MappedEvents, type OutputRowMeta, type OutputSourceOptions, type SignalRowMeta, type SmithersCtxLike, type SmithersEventSource, __machineCacheInternals, approvalDecided, computeMachineState, eventReceived, foldMachineState, hashFoldEvents, lintMachine, orderFoldEvents, stableHash, stableStringify, taskOutput, timedOut, useSmithersMachine };
