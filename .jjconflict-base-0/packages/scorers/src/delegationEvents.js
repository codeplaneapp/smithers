/** @typedef {import("./DelegationEvent.js").DelegationEvent} DelegationEvent */
/** @typedef {import("./DelegationEvent.js").DelegationEventsPayload} DelegationEventsPayload */
/** @typedef {import("./types.js").ScorerInput} ScorerInput */

/**
 * @param {unknown} value
 * @returns {value is DelegationEvent}
 */
function isDelegationEvent(value) {
    return (typeof value === "object" &&
        value !== null &&
        typeof (/** @type {{ t?: unknown }} */ (value).t) === "string");
}

/**
 * @param {unknown} candidate
 * @returns {DelegationEventsPayload | null}
 */
function toPayload(candidate) {
    if (Array.isArray(candidate)) {
        const events = candidate.filter(isDelegationEvent);
        return events.length > 0 ? { events } : null;
    }
    if (typeof candidate === "object" && candidate !== null) {
        const events = /** @type {{ events?: unknown }} */ (candidate).events;
        if (Array.isArray(events)) {
            const filteredEvents = events.filter(isDelegationEvent);
            if (filteredEvents.length === 0)
                return null;
            const nodes = /** @type {{ nodes?: unknown }} */ (candidate).nodes;
            return {
                events: filteredEvents,
                nodes: Array.isArray(nodes)
                    ? /** @type {{ id: string; kind?: string }[]} */ (nodes)
                    : undefined,
            };
        }
    }
    return null;
}

/**
 * Extracts a delegation event log from a scorer input.
 *
 * Accepts either a bare `DelegationEvent[]` or a `{ events, nodes? }` object
 * in the scored `output` (preferred) or `context`. Returns `null` when
 * neither carries events, so scorers can no-op per the package's skip
 * convention.
 *
 * @param {Pick<ScorerInput, "output" | "context">} input
 * @returns {DelegationEventsPayload | null}
 */
export function extractDelegationEvents(input) {
    return toPayload(input.output) ?? toPayload(input.context);
}

/**
 * The node kinds that count as planning nodes: they own decomposition and
 * risk judgment. Probes (poc/research), previews, reviews, and score nodes
 * are never judged by planning scorers.
 */
const PLANNING_KINDS = new Set(["goal", "chunk"]);

/**
 * Resolves the set of planning-node ids a delegation log describes.
 *
 * When node metadata is available (payload `nodes`, or `children` carried by
 * `CHILDREN_DECLARED` events), only nodes whose `kind` is `goal` or `chunk`
 * qualify. Otherwise the set is derived from the events: every id referenced
 * as a planning actor (`RISK_FLAGGED.node`, `PROBE_SPAWNED.parent`,
 * `CHILDREN_DECLARED.parent`, `FINDING_REPORTED.toParent`,
 * `REPLAN_REQUESTED.from`, `GATES_DECLARED.node`, node lifecycle events)
 * minus known probe ids (`FINDING_REPORTED.probe`).
 *
 * @param {DelegationEventsPayload} payload
 * @returns {string[]}
 */
export function resolvePlanningNodes(payload) {
    /** @type {Map<string, string | undefined>} kind by id, when known */
    const kinds = new Map();
    for (const node of payload.nodes ?? []) {
        if (typeof node?.id === "string")
            kinds.set(node.id, node.kind);
    }
    for (const event of payload.events) {
        if (event.t === "CHILDREN_DECLARED" && Array.isArray(event.children)) {
            for (const child of event.children) {
                if (typeof child?.id === "string" && !kinds.has(child.id)) {
                    kinds.set(child.id, child.kind);
                }
            }
        }
    }
    /** @type {Set<string>} */
    const candidates = new Set();
    /** @type {Set<string>} */
    const probeIds = new Set();
    for (const event of payload.events) {
        if (typeof event.probe === "string")
            probeIds.add(event.probe);
        for (const id of [
            event.node,
            event.parent,
            event.toParent,
            event.from,
        ]) {
            if (typeof id === "string")
                candidates.add(id);
        }
    }
    const planning = [];
    for (const id of candidates) {
        if (probeIds.has(id))
            continue;
        const kind = kinds.get(id);
        if (kind !== undefined && !PLANNING_KINDS.has(kind))
            continue;
        planning.push(id);
    }
    // Explicitly declared planning nodes count even if the events never
    // mention them (a silent chunk is still a correct negative).
    for (const [id, kind] of kinds) {
        if (kind !== undefined &&
            PLANNING_KINDS.has(kind) &&
            !probeIds.has(id) &&
            !planning.includes(id)) {
            planning.push(id);
        }
    }
    return planning;
}
