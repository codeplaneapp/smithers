import type { FleetRun } from "./FleetRun";

/**
 * Project the output of `smithers ps --json` into `FleetRun`s, optionally
 * restricted to the run ids this shard launched. Defensive about shape: accepts
 * a bare array or a `{ runs: [...] }` envelope, tolerates `runId` vs `id`, and
 * reads the quota reset from either a top-level field or the run's `errorJson`
 * (where the engine records `quotaResetAtMs` when it parks a run on quota).
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
  if (typeof r.quotaResetAtMs === "number") return r.quotaResetAtMs;
  const errorJson = r.errorJson;
  const obj = typeof errorJson === "string" ? tryParse(errorJson) : errorJson;
  if (obj && typeof obj === "object") {
    const o = obj as Record<string, unknown>;
    if (typeof o.quotaResetAtMs === "number") return o.quotaResetAtMs;
    const details = o.details;
    if (details && typeof details === "object" && typeof (details as Record<string, unknown>).quotaResetAtMs === "number") {
      return (details as Record<string, unknown>).quotaResetAtMs as number;
    }
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
