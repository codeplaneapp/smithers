export type IssueBlitzNodeStatus = "pending" | "running" | "done" | "failed" | "waiting" | "skipped";

type NodeState = {
  status: Map<string, IssueBlitzNodeStatus>;
  iteration: Map<string, number>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function eventStatus(type: string): IssueBlitzNodeStatus | undefined {
  const normalized = type.replaceAll("_", ".").toLowerCase();
  if (normalized === "nodefinished" || normalized === "node.finished") return "done";
  if (
    normalized === "nodefailed"
    || normalized === "node.failed"
    || normalized === "nodecancelled"
    || normalized === "node.cancelled"
  ) return "failed";
  if (normalized === "nodeskipped" || normalized === "node.skipped") return "skipped";
  if (
    normalized === "nodewaitingapproval"
    || normalized === "node.waiting.approval"
    || normalized === "approvalrequested"
    || normalized === "approval.requested"
  ) return "waiting";
  if (
    normalized === "nodestarted"
    || normalized === "node.started"
    || normalized === "noderetrying"
    || normalized === "node.retrying"
    || normalized === "taskheartbeat"
    || normalized === "task.heartbeat"
  ) return "running";
  return undefined;
}

/**
 * Derive latest lifecycle state from Gateway event frames.
 *
 * Gateway run events normally arrive as:
 * `{ payload: { event: "node.finished", payload: { nodeId, iteration } } }`.
 * Shallower engine-event shapes remain accepted for old persisted runs.
 */
export function buildIssueBlitzNodeState(events: readonly unknown[]): NodeState {
  const status = new Map<string, IssueBlitzNodeStatus>();
  const iteration = new Map<string, number>();

  for (const raw of events) {
    const frame = isRecord(raw) ? raw : {};
    const envelope = isRecord(frame.payload) ? frame.payload : {};
    const nodePayload = isRecord(envelope.payload) ? envelope.payload : {};
    const legacyEvent = isRecord(frame.event) ? frame.event : {};

    const nodeId = asString(nodePayload.nodeId)
      ?? asString(envelope.nodeId)
      ?? asString(legacyEvent.nodeId)
      ?? asString(frame.nodeId);
    const type = asString(envelope.event)
      ?? asString(nodePayload.type)
      ?? asString(legacyEvent.type)
      ?? asString(frame.type)
      ?? asString(frame.event);
    if (!nodeId || !type) continue;

    const rawIteration = nodePayload.iteration
      ?? envelope.iteration
      ?? legacyEvent.iteration
      ?? frame.iteration;
    const nextIteration = typeof rawIteration === "number" && Number.isFinite(rawIteration)
      ? rawIteration
      : iteration.get(nodeId);
    const priorIteration = iteration.get(nodeId);
    if (nextIteration !== undefined) {
      iteration.set(nodeId, Math.max(priorIteration ?? 0, nextIteration));
    }

    const nextStatus = eventStatus(type);
    if (!nextStatus) continue;
    const priorStatus = status.get(nodeId);
    const startsNewIteration = nextStatus === "running"
      && nextIteration !== undefined
      && (priorIteration === undefined || nextIteration > priorIteration);
    const priorTerminal = priorStatus === "done"
      || priorStatus === "failed"
      || priorStatus === "skipped";
    if (nextStatus !== "running" || !priorTerminal || startsNewIteration) {
      status.set(nodeId, nextStatus);
    }
  }

  return { status, iteration };
}
