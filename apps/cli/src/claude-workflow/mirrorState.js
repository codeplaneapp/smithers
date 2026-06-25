const TERMINAL_RUN_STATUSES = new Set(["finished", "failed", "cancelled"]);
const TERMINAL_NODE_STATES = new Set(["finished", "failed", "skipped", "cancelled"]);

/**
 * @param {unknown} value
 * @returns {{ runStatus: string; steps: Array<{ id: string; state: string; label: string; attempt?: number }> }}
 */
export function parseInspectJson(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError("inspect JSON must be an object");
    }
    const raw = /** @type {Record<string, any>} */ (value);
    const runStatus = typeof raw.run?.status === "string"
        ? raw.run.status
        : typeof raw.runState === "string"
            ? raw.runState
            : "unknown";
    const steps = Array.isArray(raw.steps)
        ? raw.steps
            .filter((step) => step && typeof step === "object" && typeof step.id === "string")
            .map((step) => ({
                id: step.id,
                state: typeof step.state === "string" ? step.state : "unknown",
                label: typeof step.label === "string" && step.label.length > 0 ? step.label : step.id,
                ...(typeof step.attempt === "number" ? { attempt: step.attempt } : {}),
            }))
        : [];
    return { runStatus, steps };
}

/** @param {string} status */
export function isTerminalRunStatus(status) {
    return TERMINAL_RUN_STATUSES.has(status);
}

/** @param {string} state */
export function isTerminalNodeState(state) {
    return TERMINAL_NODE_STATES.has(state);
}

/**
 * @param {unknown} inspect
 * @param {{ nodes: readonly { nodeId: string; phase: string; kind: string }[] }} phasePlan
 * @param {{ mirrorAllNodes?: boolean }} [options]
 * @returns {{ runStatus: string; nodes: Array<{ nodeId: string; label: string; state: string; phase: string; kind: string }> }}
 *
 * By default this mirrors agent nodes plus runtime-discovered nodes that are
 * absent from the baked phase plan (kind "unknown"). Those unknown nodes are the
 * dynamic fan-out / data-dependent tasks the mirror exists to surface, since the
 * static frame-0 graph cannot predict them. Known compute/static/wait nodes stay
 * filtered out unless `mirrorAllNodes` is set. Loop iterations are unaffected:
 * their `@@`-stripped logical id matches the baked map, so they keep their kind.
 */
export function nodesFromInspect(inspect, phasePlan, options = {}) {
    const parsed = parseInspectJson(inspect);
    const phaseMap = new Map(phasePlan.nodes.map((node) => [logicalNodeId(node.nodeId), node.phase]));
    const kindMap = new Map(phasePlan.nodes.map((node) => [logicalNodeId(node.nodeId), node.kind]));
    const nodes = parsed.steps
        .map((step) => {
            const logical = logicalNodeId(step.id);
            const kind = kindMap.get(logical) ?? "unknown";
            return {
                nodeId: step.id,
                label: step.label,
                state: step.state,
                phase: phaseMap.get(logical) ?? "main",
                kind,
            };
        })
        .filter((node) => options.mirrorAllNodes === true || node.kind === "agent" || node.kind === "unknown");
    return { runStatus: parsed.runStatus, nodes };
}

/**
 * @param {ReadonlySet<string> | readonly string[]} previousNodeIds
 * @param {readonly { nodeId: string }[]} currentNodes
 * @returns {{ added: string[]; vanished: string[] }}
 */
export function diffMirrorNodes(previousNodeIds, currentNodes) {
    const previous = previousNodeIds instanceof Set ? previousNodeIds : new Set(previousNodeIds);
    const current = new Set(currentNodes.map((node) => node.nodeId));
    return {
        added: [...current].filter((nodeId) => !previous.has(nodeId)),
        vanished: [...previous].filter((nodeId) => !current.has(nodeId)),
    };
}

/**
 * @param {unknown} event
 * @param {number | undefined} lastFrameNo
 * @returns {{ kind: "frame"; frameNo: number } | { kind: "terminal"; status: string } | { kind: "continued"; runId?: string } | null}
 */
export function eventSignalsFrame(event, lastFrameNo) {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
        return null;
    }
    const raw = /** @type {Record<string, any>} */ (event);
    if (raw.type === "FrameCommitted") {
        const frameNo = typeof raw.payload?.frameNo === "number" ? raw.payload.frameNo : -1;
        return lastFrameNo == null || frameNo > lastFrameNo ? { kind: "frame", frameNo } : null;
    }
    if (raw.type === "RunFinished") return { kind: "terminal", status: "finished" };
    if (raw.type === "RunFailed") return { kind: "terminal", status: "failed" };
    if (raw.type === "RunCancelled") return { kind: "terminal", status: "cancelled" };
    if (raw.type === "RunContinuedAsNew") {
        const runId = typeof raw.payload?.newRunId === "string" ? raw.payload.newRunId : undefined;
        return { kind: "continued", ...(runId ? { runId } : {}) };
    }
    return null;
}

/** @param {string} nodeId */
function logicalNodeId(nodeId) {
    return String(nodeId).split("@@")[0];
}
