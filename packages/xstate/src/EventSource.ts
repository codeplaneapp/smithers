import type { AnyEventObject } from "xstate";

/** What a source `map` callback may return: one event, several, or none. */
export type MappedEvents = AnyEventObject | AnyEventObject[] | null | undefined;

/** Row metadata handed to output-backed source `map` callbacks. */
export type OutputRowMeta = { nodeId: string; iteration: number; seq: number };

/** Row metadata handed to `eventReceived` `map` callbacks. */
export type SignalRowMeta = {
  signalName: string;
  seq: number;
  correlationId?: string;
  receivedAtMs: number;
};

export type OutputSourceOptions = { nodeId?: string; scope?: string };

/** Scoping options for `eventReceived`. */
export type EventReceivedOptions = {
  /** Fold only signals delivered with a matching correlation id — required
   * when the same signal name is used by more than one concurrent wait. */
  correlationId?: string;
};

/**
 * A declared event source: a pure function of `ctx` (never of machine state)
 * that yields `{ seq, events }` entries for the fold. Construct these with
 * `taskOutput` / `approvalDecided` / `eventReceived` / `timedOut`.
 */
export type SmithersEventSource = {
  kind: "taskOutput" | "approvalDecided" | "eventReceived" | "timedOut";
  collect(ctx: SmithersCtxLike): Array<{ seq: number; events: AnyEventObject[] }>;
};

/** The slice of SmithersCtx the sources read. Kept structural so the package
 * never depends on the driver at runtime. */
export type SmithersCtxLike = {
  outputRows(
    output: unknown,
    options?: { nodeId?: string; scope?: string },
  ): Array<{
    payload: unknown;
    nodeId: string;
    iteration: number;
    seq: number;
  }>;
  signalRows(
    signalName: string,
    options?: { correlationId?: string },
  ): Array<{
    payload: unknown;
    signalName: string;
    seq: number;
    correlationId?: string;
    receivedAtMs: number;
  }>;
};
