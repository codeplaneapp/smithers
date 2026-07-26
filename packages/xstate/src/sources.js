import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";

/** @typedef {import("./EventSource.ts").SmithersEventSource} SmithersEventSource */
/** @typedef {import("./EventSource.ts").SmithersCtxLike} SmithersCtxLike */
/** @typedef {import("./EventSource.ts").MappedEvents} MappedEvents */
/** @typedef {import("./EventSource.ts").OutputSourceOptions} OutputSourceOptions */

/**
 * @param {string} sourceKind
 * @param {MappedEvents} mapped
 * @returns {import("xstate").AnyEventObject[]}
 */
function normalizeMapped(sourceKind, mapped) {
  if (mapped == null) return [];
  const events = Array.isArray(mapped) ? mapped : [mapped];
  for (const event of events) {
    if (!event || typeof event !== "object" || typeof (/** @type {{ type?: unknown }} */ (event).type) !== "string") {
      throw new SmithersError(
        "XSTATE_EVENT_MAP_INVALID",
        `A ${sourceKind}() map returned a value that is not a machine event (expected { type: string, ... }, an array of them, or null).`,
        { sourceKind },
      );
    }
  }
  return events;
}

/**
 * @param {string} sourceKind
 * @param {string} label
 * @param {(payload: never, meta: never) => MappedEvents} map
 * @param {unknown} payload
 * @param {unknown} meta
 * @returns {import("xstate").AnyEventObject[]}
 */
function applyMap(sourceKind, label, map, payload, meta) {
  try {
    return normalizeMapped(sourceKind, map(/** @type {never} */ (payload), /** @type {never} */ (meta)));
  } catch (cause) {
    if (cause instanceof SmithersError) throw cause;
    throw new SmithersError(
      "XSTATE_EVENT_MAP_FAILED",
      `The ${sourceKind}() map for ${label} threw: ${cause instanceof Error ? cause.message : String(cause)}. Event mappers must be pure and total over their rows.`,
      { sourceKind, label },
      { cause },
    );
  }
}

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
export function taskOutput(output, options, map) {
  return outputRowSource("taskOutput", output, options, map);
}

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
export function approvalDecided(output, options, map) {
  return outputRowSource("approvalDecided", output, options, map);
}

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
export function timedOut(output, options, map) {
  const base = outputRowSource("timedOut", output, options, map);
  return {
    ...base,
    collect(ctx) {
      return base.collect({
        outputRows: (target, opts) =>
          ctx
            .outputRows(target, opts)
            .filter(
              (row) =>
                row.payload !== null &&
                typeof row.payload === "object" &&
                /** @type {{ kind?: unknown }} */ (row.payload).kind === "timeout",
            ),
        // timedOut's own collect() never calls signalRows (it only reads
        // outputRows), but the wrapped ctx shape must still satisfy
        // SmithersCtxLike. Bind defensively: an older runtime without the
        // durable signal read path must not crash a source that never
        // touches it.
        signalRows: typeof ctx.signalRows === "function" ? ctx.signalRows.bind(ctx) : undefined,
      });
    },
  };
}

/**
 * Durable delivered signals, folded DIRECTLY over `_smithers_signals` rows in
 * the shared provenance clock — never over `<WaitForEvent>` output rows. Every
 * delivered signal reaches the fold in seq order regardless of listener mount
 * timing; a parked listener is wake-and-park plumbing, not the event source.
 * Signal payloads that fail `schema.safeParse` are skipped deterministically
 * (same rows ⇒ same skips) so a malformed external delivery can never brick
 * every future render of the run. `_smithers_signals.seq` is assigned
 * atomically at insert on the same clock as output provenance — unlike output
 * rows there is no pre-provenance table to backfill, so there is no legacy
 * "row with no seq" state to handle here.
 *
 * @template Payload
 * @param {string} signalName
 * @param {{ safeParse(value: unknown): { success: boolean; data?: unknown } } | null} schema Zod (or zod-shaped) payload schema; pass null to accept any payload.
 * @param {import("./EventSource.ts").EventReceivedOptions} options `correlationId` scopes the fold to signals delivered with a matching
 *   correlation id — required when the same signal name is used by more than
 *   one concurrent wait (e.g. per-subflow instances), or every concurrent
 *   waiter's machine would see every other waiter's deliveries too.
 * @param {(payload: Payload, meta: import("./EventSource.ts").SignalRowMeta) => MappedEvents} map
 * @returns {SmithersEventSource}
 */
export function eventReceived(signalName, schema, options, map) {
  if (typeof signalName !== "string" || signalName.trim() === "") {
    throw new SmithersError("XSTATE_EVENT_SOURCE_INVALID", "eventReceived() requires a non-empty signal name.", {
      sourceKind: "eventReceived",
    });
  }
  if (typeof map !== "function") {
    throw new SmithersError(
      "XSTATE_EVENT_SOURCE_INVALID",
      `eventReceived("${signalName}") requires a map callback producing machine events.`,
      { sourceKind: "eventReceived", signalName },
    );
  }
  const correlationId = options?.correlationId;
  return {
    kind: "eventReceived",
    hashSeed: { sourceKind: "eventReceived", signalName, schema, options, map },
    collect(ctx) {
      if (typeof ctx.signalRows !== "function") {
        throw new SmithersError(
          "XSTATE_EVENT_SOURCE_INVALID",
          `eventReceived("${signalName}") needs ctx.signalRows, which this runtime does not provide. Upgrade the engine/driver to a version with the durable signal read path.`,
          { sourceKind: "eventReceived", signalName },
        );
      }
      const entries = [];
      for (const row of ctx.signalRows(signalName, correlationId !== undefined ? { correlationId } : undefined)) {
        let payload = row.payload;
        if (schema) {
          const parsed = schema.safeParse(row.payload);
          if (!parsed.success) continue;
          payload = parsed.data;
        }
        const events = applyMap("eventReceived", `signal "${signalName}" (seq ${row.seq})`, map, payload, {
          signalName: row.signalName,
          seq: row.seq,
          correlationId: row.correlationId,
          receivedAtMs: row.receivedAtMs,
        });
        if (events.length > 0) entries.push({ seq: row.seq, events });
      }
      return entries;
    },
  };
}

/**
 * @param {"taskOutput" | "approvalDecided" | "timedOut"} sourceKind
 * @param {unknown} output
 * @param {OutputSourceOptions} options
 * @param {(payload: never, meta: never) => MappedEvents} map
 * @returns {SmithersEventSource}
 */
function outputRowSource(sourceKind, output, options, map) {
  if (typeof map !== "function") {
    throw new SmithersError(
      "XSTATE_EVENT_SOURCE_INVALID",
      `${sourceKind}() requires a map callback producing machine events.`,
      { sourceKind },
    );
  }
  return {
    kind: sourceKind,
    hashSeed: { sourceKind, output, options, map },
    collect(ctx) {
      const entries = [];
      for (const row of ctx.outputRows(output, options)) {
        const events = applyMap(sourceKind, `row ${row.nodeId}::${row.iteration} (seq ${row.seq})`, map, row.payload, {
          nodeId: row.nodeId,
          iteration: row.iteration,
          seq: row.seq,
        });
        if (events.length > 0) entries.push({ seq: row.seq, events });
      }
      return entries;
    },
  };
}
