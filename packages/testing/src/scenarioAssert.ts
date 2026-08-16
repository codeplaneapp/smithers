/**
 * Control-plane assertion helpers for scenario runs (real SmithersDb / event log).
 */

import { runMaybeEffect } from "./runEffect.ts";

/** Minimal adapter surface used by assertions (SmithersDb-compatible). */
export type ScenarioAdapter = {
  listNodes(runId: string): unknown;
  listEventsByType?(runId: string, type: string): unknown;
  listSteers?(runId: string, query?: unknown): unknown;
  getRun?(runId: string): unknown;
};

type NodeRow = { nodeId: string; state?: string | null; iteration?: number | null };

async function listNodes(adapter: ScenarioAdapter, runId: string): Promise<NodeRow[]> {
  const rows = await runMaybeEffect<NodeRow[]>(adapter.listNodes(runId));
  return Array.isArray(rows) ? rows : [];
}

async function listEventsByType(
  adapter: ScenarioAdapter,
  runId: string,
  type: string,
): Promise<Array<Record<string, unknown>>> {
  if (!adapter.listEventsByType) return [];
  const rows = await runMaybeEffect<Array<{ payloadJson?: string }>>(adapter.listEventsByType(runId, type));
  return (rows ?? []).map((row) => {
    try {
      return JSON.parse(String(row.payloadJson ?? "{}")) as Record<string, unknown>;
    } catch {
      return {};
    }
  });
}

export async function expectRunStatus(adapter: ScenarioAdapter, runId: string, status: string): Promise<void> {
  if (!adapter.getRun) {
    throw new Error("adapter.getRun required for expectRunStatus");
  }
  const run = await runMaybeEffect<{ status?: string } | null | undefined>(adapter.getRun(runId));
  const actual = run?.status;
  if (actual !== status) {
    throw new Error(`Expected run status ${status}, got ${String(actual)}`);
  }
}

export async function expectNodeState(
  adapter: ScenarioAdapter,
  runId: string,
  nodeId: string,
  state: string,
): Promise<void> {
  const nodes = await listNodes(adapter, runId);
  const node = nodes.find((n) => n.nodeId === nodeId);
  if (!node) {
    throw new Error(`Node ${nodeId} not found in run ${runId} (nodes: ${nodes.map((n) => n.nodeId).join(",")})`);
  }
  if (node.state !== state) {
    throw new Error(`Expected node ${nodeId} state ${state}, got ${String(node.state)}`);
  }
}

export async function expectNodeStates(
  adapter: ScenarioAdapter,
  runId: string,
  expected: Record<string, string>,
): Promise<void> {
  for (const [nodeId, state] of Object.entries(expected)) {
    await expectNodeState(adapter, runId, nodeId, state);
  }
}

export async function tallyNodeStates(
  adapter: ScenarioAdapter,
  runId: string,
): Promise<{ working: number; failed: number; done: number; blocked: number; other: number; total: number }> {
  const nodes = await listNodes(adapter, runId);
  const t = { working: 0, failed: 0, done: 0, blocked: 0, other: 0, total: nodes.length };
  for (const n of nodes) {
    switch (n.state) {
      case "in-progress":
        t.working += 1;
        break;
      case "failed":
      case "stalled":
        t.failed += 1;
        break;
      case "finished":
        t.done += 1;
        break;
      case "waiting-approval":
      case "waiting-event":
      case "waiting-timer":
      case "waiting-quota":
      case "bound":
      case "waiting-bound":
      case "bound-stale":
        t.blocked += 1;
        break;
      default:
        t.other += 1;
    }
  }
  return t;
}

export async function expectSteerConsumed(
  adapter: ScenarioAdapter,
  runId: string,
  opts?: { nodeId?: string; minCount?: number },
): Promise<void> {
  if (!adapter.listSteers) {
    throw new Error("adapter.listSteers required for expectSteerConsumed");
  }
  const steers = await runMaybeEffect<Array<Record<string, unknown>>>(adapter.listSteers(runId));
  const consumed = (steers ?? []).filter((n) => n.status === "consumed");
  const filtered = opts?.nodeId ? consumed.filter((n) => n.nodeId === opts.nodeId) : consumed;
  const min = opts?.minCount ?? 1;
  if (filtered.length < min) {
    throw new Error(
      `Expected at least ${min} consumed steer(s)${opts?.nodeId ? ` for ${opts.nodeId}` : ""}, got ${filtered.length}`,
    );
  }
  // Event-log assertion is only meaningful when the adapter can list events.
  // listEventsByType is optional (the helper returns [] when absent), so guard
  // on it — otherwise a correctly-consumed steer would falsely fail here on an
  // adapter without event listing. Mirrors the getRun guard in expectRunStatus.
  if (!adapter.listEventsByType) {
    throw new Error("adapter.listEventsByType required for expectSteerConsumed");
  }
  const events = await listEventsByType(adapter, runId, "SteerConsumed");
  if (events.length < min) {
    throw new Error(`Expected SteerConsumed events >= ${min}, got ${events.length}`);
  }
}

export async function expectEventCount(
  adapter: ScenarioAdapter,
  runId: string,
  type: string,
  count: number,
): Promise<void> {
  if (!adapter.listEventsByType) throw new Error("adapter.listEventsByType required for expectEventCount");
  const events = await listEventsByType(adapter, runId, type);
  if (events.length !== count) {
    throw new Error(`Expected ${count} ${type} event(s), got ${events.length}`);
  }
}

/**
 * Soft-pin / board-only oracle for opened tab labels (herdr or in-memory surface).
 */
export function expectSoftPinBoard(
  openedNodeIds: string[],
  opts: {
    workerPattern?: RegExp;
    maxStages?: number;
    mustInclude?: string[];
    mustExclude?: string[];
  } = {},
): void {
  const workerRe = opts.workerPattern ?? /(?:^|[/:._-])(?:worker|fix|shard|leaf|item)[-_]?\d+$/i;
  const maxStages = opts.maxStages ?? 1;
  const allowedFailWorkers = new Set(opts.mustInclude ?? []);
  const workers = openedNodeIds.filter((id) => workerRe.test(id));
  const stages = openedNodeIds.filter((id) => !workerRe.test(id) && !id.startsWith("gate:"));
  const unexpectedWorkers = workers.filter((w) => !allowedFailWorkers.has(w));
  if (unexpectedWorkers.length > 0) {
    throw new Error(`Workers should stay board-only, opened: ${unexpectedWorkers.join(", ")}`);
  }
  if (stages.length > maxStages) {
    throw new Error(`Expected at most ${maxStages} stage tab(s), opened: ${stages.join(", ")}`);
  }
  for (const id of opts.mustInclude ?? []) {
    if (!openedNodeIds.includes(id)) {
      throw new Error(`Expected opened tab ${id}, got [${openedNodeIds.join(", ")}]`);
    }
  }
  for (const id of opts.mustExclude ?? []) {
    if (openedNodeIds.includes(id)) {
      throw new Error(`Expected no tab for ${id}`);
    }
  }
}
