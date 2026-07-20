/**
 * Per-node hijack candidate discovery over persisted attempt metadata.
 *
 * Agent-backed task attempts persist a resumable continuation in their
 * `metaJson` — either an explicit `hijackHandoff` block (written when a live
 * run hands a session off) or the `agentEngine` + `agentResume` /
 * `agentConversation` fields every agent attempt records. The smithers CLI's
 * `hijack` command consumes the same metadata (apps/cli/src/hijack.js —
 * `resolveHijackCandidate`); this module is the Gateway-side read used by
 * `listHijackCandidates` so UIs can decide, per node, whether a "hijack this
 * node's agent session" affordance exists at all. Keep the meta shapes here
 * and there in sync.
 */

/**
 * @typedef {{
 *   nodeId: string;
 *   engine: string;
 *   mode: "native-cli" | "conversation";
 *   iteration: number;
 *   attempt: number;
 *   startedAtMs: number | null;
 * }} GatewayHijackCandidate
 */

/**
 * @param {string | null | undefined} metaJson
 * @returns {Record<string, unknown>}
 */
function parseAttemptMeta(metaJson) {
    if (!metaJson) {
        return {};
    }
    try {
        const parsed = JSON.parse(metaJson);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed
            : {};
    }
    catch {
        return {};
    }
}

/**
 * @param {Record<string, unknown>} meta
 * @returns {{ engine: string; mode: "native-cli" | "conversation" } | null}
 */
export function extractHijackContinuation(meta) {
    const handoff = meta.hijackHandoff;
    if (handoff && typeof handoff === "object" && !Array.isArray(handoff)) {
        const record = /** @type {Record<string, unknown>} */ (handoff);
        const engine = typeof record.engine === "string" ? record.engine : undefined;
        const mode = record.mode === "conversation" ? "conversation" : "native-cli";
        const resume = typeof record.resume === "string" ? record.resume : undefined;
        const messages = Array.isArray(record.messages) ? record.messages : undefined;
        if (engine && mode === "native-cli" && resume) {
            return { engine, mode: "native-cli" };
        }
        if (engine && mode === "conversation" && messages?.length) {
            return { engine, mode: "conversation" };
        }
    }
    const engine = typeof meta.agentEngine === "string" ? meta.agentEngine : undefined;
    if (engine && typeof meta.agentResume === "string" && meta.agentResume) {
        return { engine, mode: "native-cli" };
    }
    if (engine && Array.isArray(meta.agentConversation) && meta.agentConversation.length > 0) {
        return { engine, mode: "conversation" };
    }
    return null;
}

/**
 * Newest resumable continuation per node, from a run's attempt rows. Rows
 * without a persisted continuation contribute nothing — a node absent from the
 * result has no session to hijack (compute tasks, containers, agent attempts
 * that never recorded a session).
 *
 * @param {ReadonlyArray<{
 *   nodeId: string;
 *   iteration?: number | null;
 *   attempt: number;
 *   startedAtMs?: number | null;
 *   metaJson?: string | null;
 * }>} attempts
 * @returns {GatewayHijackCandidate[]}
 */
export function hijackCandidatesFromAttempts(attempts) {
    const sorted = [...attempts].sort((a, b) => {
        const aMs = a.startedAtMs ?? 0;
        const bMs = b.startedAtMs ?? 0;
        if (aMs !== bMs) {
            return bMs - aMs;
        }
        if ((a.iteration ?? 0) !== (b.iteration ?? 0)) {
            return (b.iteration ?? 0) - (a.iteration ?? 0);
        }
        return (b.attempt ?? 0) - (a.attempt ?? 0);
    });
    /** @type {Map<string, GatewayHijackCandidate>} */
    const byNode = new Map();
    for (const attempt of sorted) {
        if (byNode.has(attempt.nodeId)) {
            continue;
        }
        const continuation = extractHijackContinuation(parseAttemptMeta(attempt.metaJson));
        if (!continuation) {
            continue;
        }
        byNode.set(attempt.nodeId, {
            nodeId: attempt.nodeId,
            engine: continuation.engine,
            mode: continuation.mode,
            iteration: attempt.iteration ?? 0,
            attempt: attempt.attempt,
            startedAtMs: attempt.startedAtMs ?? null,
        });
    }
    return [...byNode.values()];
}
