import { asNumber, asString, asArray, isRecord, pick, timeAgo, toneForStatus, type Tone } from "./monitorModel.ts";

export type DecisionEntry = { kind: "approval" | "ask-human" | "memory"; nodeId: string | null; iteration: number | null; occurredAtMs?: number; title: string; status: string; resolution: Record<string, unknown> | null; detail: unknown };
const parse = (value: unknown): unknown => { if (typeof value !== "string") return value; try { return JSON.parse(value); } catch { return undefined; } };
const record = (value: unknown) => isRecord(value) ? value : {};

/** Tolerantly read both gateway row spellings and JSON-encoded fields. */
export function decisionEntriesOf(payload: unknown): DecisionEntry[] {
  // REST routes use the gateway's { ok, data } envelope while direct callers
  // (and RPC clients) may pass the route payload itself.
  const root = record(payload);
  const data = record(root.data);
  const source = Array.isArray(root.entries) ? root : data;
  return asArray(source.entries).flatMap((raw) => {
    const row = record(raw); const kind = asString(row.kind);
    if (kind !== "approval" && kind !== "ask-human" && kind !== "memory") return [];
    const resolution = parse(row.resolution); const detail = parse(row.detail);
    return [{ kind, nodeId: asString(pick(row, "nodeId", "node_id")) ?? null, iteration: asNumber(row.iteration) ?? null,
      occurredAtMs: asNumber(pick(row, "occurredAtMs", "occurred_at_ms")), title: asString(row.title) ?? "Decision", status: asString(row.status) ?? "unknown",
      resolution: isRecord(resolution) ? resolution : null, detail: detail === undefined ? row.detail : detail }];
  });
}

export function sortDecisions(entries: DecisionEntry[]): DecisionEntry[] {
  return entries.map((entry, index) => ({ entry, index })).sort((a, b) => (a.entry.occurredAtMs ?? Infinity) - (b.entry.occurredAtMs ?? Infinity) || a.index - b.index).map(({ entry }) => entry);
}

export function decisionTone(status: string): Tone {
  const normalized = status.toLowerCase().replaceAll("_", "-");
  if (normalized === "approved" || normalized === "auto-approved" || normalized === "answered" || normalized === "recorded") return "ok";
  if (normalized === "denied" || normalized === "expired") return "failed";
  if (normalized === "requested" || normalized === "pending") return "waiting";
  return toneForStatus(normalized);
}

export function formatDecisionResolution(entry: DecisionEntry, now = Date.now()): string {
  const r = entry.resolution ?? {}; const by = asString(r.by); const at = asNumber(pick(r, "atMs", "at_ms")); const note = asString(r.note);
  // The resolved payload (selected option, ask-human answer) belongs in the
  // visible line, not only under Details — it IS what resolved the decision.
  const picked = r.value == null ? "" : summarizeDecisionValue(r.value, 80);
  const after = at && entry.occurredAtMs ? ` · ${Math.max(0, Math.round((at - entry.occurredAtMs) / 60_000))}m after request` : "";
  const status = entry.status.toLowerCase().replaceAll("_", "-");
  if (status === "auto-approved") return "auto-approved";
  if (status === "approved") return `approved${by ? ` by ${by}` : ""}${note ? ` — ${note}` : ""}${picked ? ` · ${picked}` : ""}${after}`;
  if (status === "denied") return `denied${by ? ` by ${by}` : ""}${note ? ` — ${note}` : ""}${picked ? ` · ${picked}` : ""}`;
  if (status === "answered") return `answered${by ? ` by ${by}` : ""}${picked ? ` — ${picked}` : ""}${after}`;
  if (status === "recorded") return entry.occurredAtMs ? `recorded · ${timeAgo(entry.occurredAtMs, now)}` : "recorded";
  if (status === "expired") return "expired unanswered";
  if (status === "cancelled" || status === "canceled") return "cancelled";
  return entry.occurredAtMs ? `awaiting response · ${timeAgo(entry.occurredAtMs, now)}` : "awaiting response";
}

export function pendingDecisionCount(entries: DecisionEntry[]): number { return entries.filter((entry) => entry.status === "requested" || entry.status === "pending").length; }
/** One-line rendering for any decision payload: JSON strings unwrap, structures go compact, long text truncates. */
export function summarizeDecisionValue(value: unknown, limit = 120): string {
  const text = typeof value === "string" ? (() => { const parsed = parse(value); return parsed === undefined ? value : typeof parsed === "string" ? parsed : JSON.stringify(parsed); })() : typeof value === "number" || typeof value === "boolean" ? String(value) : JSON.stringify(value);
  return (text ?? "—").length > limit ? `${(text ?? "").slice(0, limit - 1)}…` : text ?? "—";
}
