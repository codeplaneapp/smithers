import { asNumber, asString, isRecord, normalizeStatus, pick, quotaInfoOf, type RunRow } from "./monitorModel.ts";

// Keep this aligned with RUN_STATE_HEARTBEAT_STALE_MS: the landing diagnosis
// should not stay calm after the selected-run health model turns unhealthy.
export const STALE_ENGINE_AFTER_MS = 30_000;
export type AttentionItem = {
  kind: "guard" | "failed" | "quota" | "stale-engine" | "approvals" | "failed-tasks";
  tone: "crit" | "warn";
  runId: string;
  workflowKey?: string;
  headline: string;
  detail?: string;
  resetAtMs?: number;
  count?: number;
  atMs?: number;
};
export type Approval = {
  runId?: string;
  run_id?: string;
  requestedAtMs?: number | null;
  requested_at_ms?: number | null;
};

function rowValue(row: RunRow, camel: string, snake: string): unknown {
  return pick(row as Record<string, unknown>, camel, snake);
}

function rowRunId(row: RunRow): string {
  return asString(rowValue(row, "runId", "run_id")) ?? row.runId;
}

function rowAtMs(row: RunRow): number | undefined {
  return (
    asNumber(rowValue(row, "startedAtMs", "started_at_ms")) ??
    asNumber(rowValue(row, "createdAtMs", "created_at_ms"))
  );
}

function approvalRunId(approval: Approval): string | undefined {
  return asString(pick(approval as Record<string, unknown>, "runId", "run_id"));
}

function approvalAtMs(approval: Approval): number | undefined {
  return asNumber(pick(approval as Record<string, unknown>, "requestedAtMs", "requested_at_ms"));
}

function summaryOf(row: RunRow): Record<string, unknown> | undefined {
  const raw = row.summary;
  if (isRecord(raw)) return raw;
  if (typeof raw !== "string") return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function failedTaskCountOf(row: RunRow): number | undefined {
  const summary = summaryOf(row);
  if (!summary) return undefined;
  return Object.entries(summary).reduce(
    (total, [state, count]) => total + (normalizeStatus(state) === "failed" ? (asNumber(count) ?? 0) : 0),
    0,
  );
}

// diagnoseRun keeps this private; duplicate it here so this list-row surface
// remains independent of the selected-run model (see monitorModel.ts:255).
export function isGuardTaskId(id: string): boolean {
  return id.startsWith("guard:") || /:(queue-)?guard$/.test(id);
}

function errorMessage(row: RunRow): string | undefined {
  const raw = asString(rowValue(row, "errorJson", "error_json"));
  if (!raw) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    return isRecord(value) ? asString(value.message) ?? raw : raw;
  } catch {
    return raw;
  }
}

function messageNamesGuard(message: string): boolean {
  return [...message.matchAll(/guard:[\w-]+|[\w-]+:(?:queue-)?guard/g)].some((match) => isGuardTaskId(match[0]));
}

export function diagnoseRunLite(row: RunRow, approvals: Approval[], nowMs: number): AttentionItem[] {
  const status = normalizeStatus(asString(rowValue(row, "status", "status")));
  const atMs = rowAtMs(row);
  const runId = rowRunId(row);
  const workflowKey = asString(rowValue(row, "workflowKey", "workflow_key"));
  const base = { runId, ...(workflowKey ? { workflowKey } : {}), ...(atMs !== undefined ? { atMs } : {}) };
  const items: AttentionItem[] = [];
  const failedRun = status === "failed" || status === "error" || status === "errored";
  if (failedRun) {
    const message = errorMessage(row);
    const guard = !!message && messageNamesGuard(message);
    items.push({
      ...base,
      kind: guard ? "guard" : "failed",
      tone: "crit",
      headline: guard ? "Guard stopped this run" : "Run failed",
      ...(message ? { detail: message.slice(0, 220) } : {}),
    });
  }
  if (status === "waiting-quota") {
    // quotaInfoOf expects the canonical status spelling even when a raw DB row
    // reaches this tolerant list-row reader with `waiting_quota`.
    const quota = quotaInfoOf({ ...(row as Record<string, unknown>), status });
    items.push({
      ...base,
      kind: "quota",
      tone: "warn",
      headline: `Waiting for quota${quota?.blockedCount ? ` (${quota.blockedCount} blocked)` : ""}`,
      ...(quota?.resetAtMs !== undefined ? { resetAtMs: quota.resetAtMs } : {}),
      ...(quota ? { count: quota.blockedCount } : {}),
    });
  }
  const heartbeat = asNumber(rowValue(row, "heartbeatAtMs", "heartbeat_at_ms"));
  const lastAliveAtMs = heartbeat ?? atMs;
  const staleActive =
    status === "running" && lastAliveAtMs !== undefined && nowMs - lastAliveAtMs > STALE_ENGINE_AFTER_MS;
  const stale = status === "stale" || status === "orphaned" || staleActive;
  if (stale) {
    const runtimeOwnerId = asString(rowValue(row, "runtimeOwnerId", "runtime_owner_id"));
    const mayBeOrphaned = status === "orphaned" || (staleActive && runtimeOwnerId === undefined);
    items.push({
      ...base,
      kind: "stale-engine",
      tone: "warn",
      headline: mayBeOrphaned ? "Run may be orphaned" : "Engine heartbeat is stale",
    });
  }
  if (approvals.length) {
    const requested = approvals.map(approvalAtMs).filter((value): value is number => value !== undefined);
    items.push({
      ...base,
      kind: "approvals",
      tone: "warn",
      headline: `${approvals.length} approval${approvals.length === 1 ? "" : "s"} waiting`,
      count: approvals.length,
      ...(requested.length ? { atMs: Math.min(...requested) } : {}),
    });
  }
  const failed = failedTaskCountOf(row);
  if (!failedRun && failed !== undefined && failed > 0) {
    items.push({
      ...base,
      kind: "failed-tasks",
      tone: "warn",
      headline: `${failed} failed task${failed === 1 ? "" : "s"}`,
      count: failed,
    });
  }
  return items;
}

export function workspaceAttention(rows: RunRow[], approvals: Approval[], nowMs: number) {
  const grouped = new Map<string, Approval[]>();
  for (const approval of approvals) {
    const runId = approvalRunId(approval);
    if (runId) grouped.set(runId, [...(grouped.get(runId) ?? []), approval]);
  }
  const items = rows
    .flatMap((row) => diagnoseRunLite(row, grouped.get(rowRunId(row)) ?? [], nowMs))
    .sort((a, b) =>
      a.tone === b.tone ? (b.atMs ?? 0) - (a.atMs ?? 0) : a.tone === "crit" ? -1 : 1,
    );
  const countsByKind: Partial<Record<AttentionItem["kind"], number>> = {};
  for (const item of items) countsByKind[item.kind] = (countsByKind[item.kind] ?? 0) + 1;
  return { items, countsByKind, total: items.length };
}
