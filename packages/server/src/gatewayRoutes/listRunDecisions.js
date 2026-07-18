const RUN_ID_PATTERN = /^[a-z0-9_-]{1,64}$/;

export class ListRunDecisionsRouteError extends Error {
    constructor(code, message) { super(message); this.name = "ListRunDecisionsRouteError"; this.code = code; }
}

const value = (row, camel, snake) => row?.[camel] ?? row?.[snake];
const string = (value) => typeof value === "string" ? value : value == null ? undefined : String(value);
const number = (value) => { const n = typeof value === "number" ? value : Number(value); return Number.isFinite(n) ? n : undefined; };
function json(value) { if (typeof value !== "string") return value; try { return JSON.parse(value); } catch { return undefined; } }
function object(value) { const parsed = json(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}; }

function approval(row) {
    const request = object(value(row, "requestJson", "request_json"));
    const decision = json(value(row, "decisionJson", "decision_json"));
    const status = string(value(row, "status", "status")) ?? "requested";
    const auto = value(row, "autoApproved", "auto_approved") === true || value(row, "autoApproved", "auto_approved") === 1;
    const decidedAtMs = number(value(row, "decidedAtMs", "decided_at_ms"));
    const note = string(value(row, "note", "note"));
    return { kind: "approval", nodeId: string(value(row, "nodeId", "node_id")) ?? null, iteration: number(value(row, "iteration", "iteration")) ?? null,
        occurredAtMs: number(value(row, "requestedAtMs", "requested_at_ms")), title: string(request.title) ?? string(request.summary) ?? "Approval requested", status: auto ? "auto-approved" : status,
        resolution: status === "requested" ? null : { by: auto ? null : string(value(row, "decidedBy", "decided_by")) ?? null, atMs: decidedAtMs ?? null, note: note ?? null, value: decision },
        // Keep structured decisions: approval notes alone lose selected options.
        detail: { request, decision } };
}
function human(row) {
    const status = string(value(row, "status", "status")) ?? "pending";
    const response = json(value(row, "responseJson", "response_json"));
    return { kind: "ask-human", nodeId: string(value(row, "nodeId", "node_id")) ?? null, iteration: number(value(row, "iteration", "iteration")) ?? null,
        occurredAtMs: number(value(row, "requestedAtMs", "requested_at_ms")), title: string(value(row, "prompt", "prompt")) ?? "Human input requested", status,
        resolution: status === "pending" ? null : { by: string(value(row, "answeredBy", "answered_by")) ?? null, atMs: number(value(row, "answeredAtMs", "answered_at_ms")) ?? null, value: response }, detail: { prompt: value(row, "prompt", "prompt"), response } };
}
function memory(row) {
    const raw = value(row, "valueJson", "value_json");
    return { kind: "memory", nodeId: string(value(row, "nodeId", "node_id")) ?? null, iteration: number(value(row, "iteration", "iteration")) ?? null,
        occurredAtMs: number(value(row, "updatedAtMs", "updated_at_ms")), title: `${string(value(row, "namespace", "namespace")) ?? "memory"}.${string(value(row, "key", "key")) ?? "fact"}`, status: "recorded", resolution: null, detail: { value: json(raw), valueJson: raw } };
}

/** Aggregate durable approval, ask-human, and provenance-stamped memory data. */
export async function listRunDecisionsRoute(params) {
    const runId = string(params.runId);
    if (!runId || !RUN_ID_PATTERN.test(runId)) throw new ListRunDecisionsRouteError("InvalidRunId", "runId must match /^[a-z0-9_-]{1,64}$/.");
    const resolved = await params.resolveRun(runId);
    if (!resolved) throw new ListRunDecisionsRouteError("RunNotFound", `Run not found: ${runId}`);
    const adapter = resolved.adapter;
    const pending = typeof adapter.listPendingApprovals === "function" ? await adapter.listPendingApprovals(runId) : [];
    const decided = typeof adapter.listAllDecidedApprovals === "function" ? await adapter.listAllDecidedApprovals(runId) : [];
    const humans = typeof adapter.listHumanRequestsForRun === "function" ? await adapter.listHumanRequestsForRun(runId) : [];
    // Facts without run_id predate provenance and must never be guessed into a run.
    const facts = typeof adapter.listMemoryFactsForRun === "function" ? await adapter.listMemoryFactsForRun(runId) : [];
    const entries = [...(Array.isArray(pending) ? pending : []).map(approval), ...(Array.isArray(decided) ? decided : []).map(approval), ...(Array.isArray(humans) ? humans : []).map(human), ...(Array.isArray(facts) ? facts : []).map(memory)]
        .sort((a, b) => (a.occurredAtMs ?? Number.MAX_SAFE_INTEGER) - (b.occurredAtMs ?? Number.MAX_SAFE_INTEGER));
    return { runId, entries, counts: { pending: entries.filter((entry) => entry.status === "requested" || entry.status === "pending").length, approvals: Array.isArray(pending) ? pending.length + (Array.isArray(decided) ? decided.length : 0) : (Array.isArray(decided) ? decided.length : 0), askHuman: Array.isArray(humans) ? humans.length : 0, memory: Array.isArray(facts) ? facts.length : 0 } };
}
