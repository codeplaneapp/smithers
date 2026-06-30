import type { GatewayEventFrame } from "../data.ts";

/**
 * A run event with the gateway `run.event` envelope removed: the engine event
 * `name`, its `payload`, the frame `seq`, and the `nodeId` extracted from the
 * payload (if any). Every event reader in the TUI should go through
 * {@link normalizeFrame} / {@link unwrapEvent} so it works against the REAL
 * wrapped stream, not just flat test fixtures.
 */
export type NormalizedFrame = {
  event: string;
  payload: Record<string, unknown> | undefined;
  seq: number;
  nodeId: string | undefined;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The live gateway delivers persisted engine events wrapped in a `run.event`
 * envelope: the frame's `event` is the literal string `"run.event"` and its
 * `payload` is `{ streamId, seq, event, payload }` — the engine event name under
 * `payload.event` and its data under `payload.payload`
 * (see `createSmithersGatewayTransport` → `eventRows`). Some callers/tests pass
 * the flat engine event straight through (`{ event, payload }`). Normalize both
 * into `{ name, payload }`. The unwrap only triggers when the outer payload has a
 * string `event` field, so a flat payload like `{ nodeId, text }` passes through
 * untouched.
 */
export function unwrapEvent(
  ev: GatewayEventFrame,
): { name: string; payload: Record<string, unknown> | undefined } {
  const outer = ev.payload;
  if (ev.event === "run.event" && isRecord(outer) && typeof outer["event"] === "string") {
    return { name: outer["event"], payload: isRecord(outer["payload"]) ? outer["payload"] : undefined };
  }
  return { name: ev.event, payload: isRecord(outer) ? outer : undefined };
}

function nodeIdOf(payload: Record<string, unknown> | undefined): string | undefined {
  if (!payload) return undefined;
  const v = payload["nodeId"] ?? payload["node_id"] ?? payload["nodeid"];
  return typeof v === "string" ? v : undefined;
}

/** Fully normalize a raw gateway frame to `{ event, payload, seq, nodeId }`. */
export function normalizeFrame(ev: GatewayEventFrame): NormalizedFrame {
  const { name, payload } = unwrapEvent(ev);
  return { event: name, payload, seq: ev.seq, nodeId: nodeIdOf(payload) };
}

/**
 * Filter raw gateway frames down to those belonging to `nodeId` — and, when the
 * selected node is a specific loop/retry attempt (`iteration` is defined), only
 * that iteration's events. Loop/retry attempts reuse the same nodeId, so an
 * id-only filter would mix attempts in the Logs tab even though node output and
 * approvals are already iteration-aware. The (unwrapped) event payload's
 * `iteration` is compared to `iteration ?? 0`; container nodes carry no
 * iteration (pass `undefined`) → matched by id alone.
 */
export function nodeLogEvents(
  events: ReadonlyArray<GatewayEventFrame>,
  nodeId: string,
  iteration: number | undefined,
): GatewayEventFrame[] {
  return events.filter((e) => {
    const { nodeId: evNodeId, payload } = normalizeFrame(e);
    if (evNodeId !== nodeId) return false;
    if (iteration === undefined) return true;
    const evIter = typeof payload?.["iteration"] === "number" ? (payload["iteration"] as number) : 0;
    return evIter === (iteration ?? 0);
  });
}
