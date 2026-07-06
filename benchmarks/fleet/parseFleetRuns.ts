import type { FleetRun } from "./FleetRun";

/**
 * Project the output of `smithers ps --json` into `FleetRun`s, optionally
 * restricted to the run ids this shard launched. Defensive about shape: accepts
 * a bare array or a `{ runs: [...] }` envelope, tolerates `runId` vs `id`, and
 * reads the quota reset from the top-level `resetAtMs` (surfaced by `ps --json`),
 * the parsed `errorJson`, or a nested `blocked.resetAtMs` — the real field names
 * the engine records as `resetAtMs` when it parks a run on quota.
 */
export function parseFleetRuns(psOutput: unknown, runIds?: Iterable<string>): FleetRun[] {
  const wanted = runIds ? new Set(runIds) : undefined;
  const rows = Array.isArray(psOutput)
    ? psOutput
    : psOutput && typeof psOutput === "object" && Array.isArray((psOutput as { runs?: unknown }).runs)
      ? ((psOutput as { runs: unknown[] }).runs)
      : [];
  const out: FleetRun[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const runId = typeof r.runId === "string" ? r.runId : typeof r.id === "string" ? r.id : undefined;
    const status = typeof r.status === "string" ? r.status : undefined;
    if (!runId || !status) continue;
    if (wanted && !wanted.has(runId)) continue;
    out.push({ runId, status, quotaResetAtMs: readQuotaReset(r) });
  }
  return out;
}

function readQuotaReset(r: Record<string, unknown>): number | undefined {
  if (typeof r.resetAtMs === "number") return r.resetAtMs;
  const errorJson = r.errorJson;
  const obj = typeof errorJson === "string" ? tryParse(errorJson) : errorJson;
  if (obj && typeof obj === "object") {
    const o = obj as Record<string, unknown>;
    if (typeof o.resetAtMs === "number") return o.resetAtMs;
    const details = o.details;
    if (details && typeof details === "object" && typeof (details as Record<string, unknown>).resetAtMs === "number") {
      return (details as Record<string, unknown>).resetAtMs as number;
    }
  }
  const blocked = r.blocked;
  if (blocked && typeof blocked === "object" && typeof (blocked as Record<string, unknown>).resetAtMs === "number") {
    return (blocked as Record<string, unknown>).resetAtMs as number;
  }
  return undefined;
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}
