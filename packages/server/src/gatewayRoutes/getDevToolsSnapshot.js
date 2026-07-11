import { snapshotSerialize } from "@smithers-orchestrator/devtools";
import { computeRunStateFromRow } from "@smithers-orchestrator/db/runState";

/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("@smithers-orchestrator/protocol/devtools").DevToolsNode} DevToolsNode */
/** @typedef {import("@smithers-orchestrator/protocol/devtools").DevToolsSnapshot} DevToolsSnapshot */
/** @typedef {import("@smithers-orchestrator/protocol/devtools").DevToolsNodeType} DevToolsNodeType */
/** @typedef {import("@smithers-orchestrator/devtools/snapshotSerializer").SnapshotSerializerWarning} SnapshotSerializerWarning */

export const DEVTOOLS_RUN_ID_PATTERN = /^[a-z0-9_-]{1,64}$/;
export const DEVTOOLS_MAX_FRAME_NO = 2_147_483_647;
export const DEVTOOLS_TREE_MAX_DEPTH = 256;

const DEVTOOLS_TAG_TO_TYPE = {
    "smithers:workflow": "workflow",
    "smithers:task": "task",
    "smithers:sequence": "sequence",
    "smithers:parallel": "parallel",
    "smithers:merge-queue": "merge-queue",
    "smithers:branch": "branch",
    "smithers:ralph": "loop",
    "smithers:worktree": "worktree",
    "smithers:approval": "approval",
    "smithers:timer": "timer",
    "smithers:subflow": "subflow",
    "smithers:wait-for-event": "wait-for-event",
    "smithers:saga": "saga",
    "smithers:try-catch-finally": "try-catch",
};

export class DevToolsRouteError extends Error {
    /**
   * @param {string} code
   * @param {string} message
   * @param {string} [hint]
   */
    constructor(code, message, hint) {
        super(message);
        this.name = "DevToolsRouteError";
        this.code = code;
        this.hint = hint;
    }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function asObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function boolProp(value) {
    return value === true || value === "true" || value === "1";
}

/** @typedef {import("@smithers-orchestrator/protocol/devtools").DevToolsAgentRef} DevToolsAgentRef */
/** @typedef {import("@smithers-orchestrator/protocol/devtools").DevToolsAgentSummary} DevToolsAgentSummary */

/**
 * Re-whitelist an agent ref persisted in the frame task index. The engine only
 * writes label/engine/model, but the index is stored JSON — never trust it to
 * carry more than the display fields.
 *
 * @param {unknown} value
 * @returns {DevToolsAgentRef | undefined}
 */
function sanitizeAgentRef(value) {
    if (!asObject(value)) {
        return undefined;
    }
    const label = typeof value.label === "string" && value.label ? value.label : undefined;
    const engine = typeof value.engine === "string" && value.engine ? value.engine : undefined;
    const model = typeof value.model === "string" && value.model ? value.model : undefined;
    if (!label && !engine && !model) {
        return undefined;
    }
    return {
        ...(label ? { label } : {}),
        ...(engine ? { engine } : {}),
        ...(model ? { model } : {}),
    };
}

/**
 * @param {unknown} value
 * @returns {DevToolsAgentSummary | undefined}
 */
function sanitizeAgentSummary(value) {
    const base = sanitizeAgentRef(value);
    if (!base || !asObject(value)) {
        return base;
    }
    const chain = Array.isArray(value.chain)
        ? value.chain
            .map((entry) => sanitizeAgentRef(entry))
            .filter((entry) => entry !== undefined)
        : [];
    return chain.length > 0 ? { ...base, chain } : base;
}

/**
 * @param {string | null | undefined} raw
 * @returns {Map<string, { iteration?: number; kind?: string; agentSummary?: DevToolsAgentSummary; maxAttempts?: number }>}
 */
function parseTaskIndex(raw) {
    const map = new Map();
    if (typeof raw !== "string" || raw.length === 0) {
        return map;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return map;
    }
    if (!Array.isArray(parsed)) {
        return map;
    }
    for (const entry of parsed) {
        if (!asObject(entry) || typeof entry.nodeId !== "string") {
            continue;
        }
        map.set(entry.nodeId, {
            iteration: typeof entry.iteration === "number" && Number.isFinite(entry.iteration)
                ? entry.iteration
                : undefined,
            kind: typeof entry.kind === "string" ? entry.kind : undefined,
            agentSummary: sanitizeAgentSummary(entry.agent),
            maxAttempts: typeof entry.maxAttempts === "number" &&
                Number.isFinite(entry.maxAttempts) &&
                entry.maxAttempts > 0
                ? entry.maxAttempts
                : undefined,
        });
    }
    return map;
}

export const DEVTOOLS_EMPTY_ROOT_ID = 0;

/**
 * @returns {DevToolsNode}
 */
export function emptyDevToolsRoot() {
    return {
        id: DEVTOOLS_EMPTY_ROOT_ID,
        type: "workflow",
        name: "(empty)",
        props: {},
        children: [],
        depth: 0,
    };
}

/**
 * @param {string} runId
 * @returns {string}
 */
export function validateRunId(runId) {
    if (!DEVTOOLS_RUN_ID_PATTERN.test(runId)) {
        throw new DevToolsRouteError("InvalidRunId", "runId must match /^[a-z0-9_-]{1,64}$/.");
    }
    return runId;
}

/**
 * @param {unknown} frameNo
 * @param {number} latestFrameNo
 * @returns {number}
 */
export function validateRequestedFrameNo(frameNo, latestFrameNo) {
    if (!Number.isInteger(frameNo) || frameNo < 0 || frameNo > DEVTOOLS_MAX_FRAME_NO || frameNo > latestFrameNo) {
        throw new DevToolsRouteError("FrameOutOfRange", `frameNo must be between 0 and ${latestFrameNo}.`);
    }
    return frameNo;
}

/**
 * @param {Record<string, unknown>} props
 * @param {Map<string, { iteration?: number; kind?: string; agentSummary?: DevToolsAgentSummary; maxAttempts?: number }>} taskIndex
 * @returns {DevToolsNode["task"] | undefined}
 */
function extractTaskInfo(props, taskIndex) {
    const rawNodeId = typeof props.id === "string"
        ? props.id
        : typeof props.nodeId === "string"
            ? props.nodeId
            : null;
    if (!rawNodeId) {
        return undefined;
    }
    let nodeId = rawNodeId;
    let iteration = typeof props.iteration === "number" ? props.iteration : undefined;
    const match = rawNodeId.match(/^(.*)::(\d+)$/);
    if (match) {
        nodeId = match[1];
        if (iteration === undefined) {
            iteration = Number(match[2]);
        }
    }
    const indexedTask = taskIndex.get(nodeId);
    if (iteration === undefined) {
        iteration = indexedTask?.iteration;
    }
    const indexedKind = indexedTask?.kind;
    const kind = props.__smithersKind === "human" || props.kind === "human" || indexedKind === "human"
        ? "human"
        : boolProp(props.needsApproval)
            ? "approval"
        : props.__smithersKind === "agent" || props.kind === "agent" || indexedKind === "agent"
        ? "agent"
        : props.__smithersKind === "compute" || props.kind === "compute" || indexedKind === "compute"
            ? "compute"
            : "static";
    return {
        nodeId,
        kind,
        agent: typeof props.agent === "string" ? props.agent : undefined,
        agentSummary: indexedTask?.agentSummary,
        maxAttempts: indexedTask?.maxAttempts,
        label: typeof props.label === "string" ? props.label : undefined,
        outputTableName: typeof props.outputTableName === "string"
            ? props.outputTableName
            : typeof props.output === "string"
                ? props.output
                : undefined,
        iteration: typeof iteration === "number" && Number.isFinite(iteration)
            ? iteration
            : undefined,
    };
}

/**
 * @param {string} raw
 * @returns {unknown}
 */
function parsePropValue(raw) {
    if (raw === "true") {
        return true;
    }
    if (raw === "false") {
        return false;
    }
    if (raw === "null") {
        return null;
    }
    if (/^-?\d+(?:\.\d+)?$/.test(raw)) {
        const parsedNumber = Number(raw);
        if (Number.isFinite(parsedNumber)) {
            return parsedNumber;
        }
    }
    if ((raw.startsWith("{") && raw.endsWith("}")) || (raw.startsWith("[") && raw.endsWith("]"))) {
        try {
            return JSON.parse(raw);
        }
        catch {
            return raw;
        }
    }
    return raw;
}

/**
 * Derive a stable 31-bit numeric id from a node identity string.
 *
 * The identity must be deterministic across frames for the same logical node
 * so that diff/apply round-trips do not mistake a reorder for a removal + re-add
 * or reuse an id across unrelated nodes.
 *
 * @param {string} identity
 * @returns {number}
 */
function stableNodeId(identity) {
    // FNV-1a 32-bit hash, masked to 31-bit positive so JSON numbers are safe.
    let hash = 0x811c9dc5;
    for (let index = 0; index < identity.length; index += 1) {
        hash ^= identity.charCodeAt(index);
        hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
    }
    return hash & 0x7fffffff;
}

/**
 * @param {Record<string, unknown>} element
 * @returns {string}
 */
function nodeIdentityFragment(element) {
    const tag = typeof element.tag === "string" ? element.tag : "unknown";
    const rawProps = asObject(element.props) ? element.props : {};
    const taskId = typeof rawProps.id === "string"
        ? rawProps.id
        : typeof rawProps.nodeId === "string"
            ? rawProps.nodeId
            : "";
    if (taskId) {
        return `${tag}#${taskId}`;
    }
    return tag;
}

/**
 * @param {unknown} xml
 * @param {(warning: SnapshotSerializerWarning) => void} [onWarning]
 * @param {Map<string, { iteration?: number; kind?: string; agentSummary?: DevToolsAgentSummary; maxAttempts?: number }>} [taskIndex]
 * @returns {DevToolsNode}
 */
export function parseXmlToDevToolsRoot(xml, onWarning, taskIndex = new Map()) {
    if (!asObject(xml) || xml.kind !== "element") {
        return emptyDevToolsRoot();
    }
    /** @type {Set<number>} */
    const usedIds = new Set();
    /**
   * @param {string} identity
   * @returns {number}
   */
    const assignId = (identity) => {
        let candidate = identity;
        let id = stableNodeId(candidate);
        // Collisions across unrelated paths: rehash with a suffix until unique.
        let salt = 0;
        while (usedIds.has(id) && salt < 1024) {
            salt += 1;
            candidate = `${identity}\u0000${salt}`;
            id = stableNodeId(candidate);
        }
        usedIds.add(id);
        return id;
    };
    /**
   * @param {Record<string, unknown>} element
   * @param {number} depth
   * @param {string} path
   * @returns {DevToolsNode}
   */
    const makeNode = (element, depth, path) => {
        const tag = typeof element.tag === "string" ? element.tag : "unknown";
        const nodeType = DEVTOOLS_TAG_TO_TYPE[tag] ?? "unknown";
        const rawProps = asObject(element.props) ? element.props : {};
        /** @type {Record<string, unknown>} */
        const serializedProps = {};
        for (const [key, value] of Object.entries(rawProps)) {
            const parsedValue = typeof value === "string" ? parsePropValue(value) : value;
            serializedProps[key] = snapshotSerialize(parsedValue, {
                onWarning,
            });
        }
        const displayName = nodeType === "workflow" && typeof serializedProps.name === "string"
            ? serializedProps.name
            : tag.startsWith("smithers:")
                ? tag.slice("smithers:".length)
                : tag;
        return {
            id: assignId(path),
            type: /** @type {DevToolsNodeType} */ (nodeType),
            name: displayName || "unknown",
            props: serializedProps,
            task: nodeType === "task" ? extractTaskInfo(serializedProps, taskIndex) : undefined,
            children: [],
            depth,
        };
    };
    const rootIdentity = nodeIdentityFragment(xml);
    const root = makeNode(xml, 0, rootIdentity);
    /** @type {Array<{ xml: Record<string, unknown>; node: DevToolsNode; depth: number; path: string }>} */
    const stack = [{ xml, node: root, depth: 0, path: rootIdentity }];
    while (stack.length > 0) {
        const current = stack.pop();
        if (!current) {
            continue;
        }
        const rawChildren = Array.isArray(current.xml.children)
            ? current.xml.children
            : [];
        /** @type {Array<{ xml: Record<string, unknown>; node: DevToolsNode; depth: number; path: string }>} */
        const childPairs = [];
        /** @type {Map<string, number>} */
        const siblingCounts = new Map();
        for (const child of rawChildren) {
            if (!asObject(child) || child.kind !== "element") {
                continue;
            }
            const childDepth = current.depth + 1;
            if (childDepth > DEVTOOLS_TREE_MAX_DEPTH) {
                const markerPath = `${current.path}/__maxdepth__${current.node.children.length}`;
                current.node.children.push({
                    id: assignId(markerPath),
                    type: "unknown",
                    name: "[MaxDepth]",
                    props: { value: "[MaxDepth]" },
                    children: [],
                    depth: childDepth,
                });
                continue;
            }
            const fragment = nodeIdentityFragment(child);
            const occurrence = siblingCounts.get(fragment) ?? 0;
            siblingCounts.set(fragment, occurrence + 1);
            const childPath = occurrence === 0
                ? `${current.path}/${fragment}`
                : `${current.path}/${fragment}[${occurrence}]`;
            const childNode = makeNode(child, childDepth, childPath);
            current.node.children.push(childNode);
            childPairs.push({ xml: child, node: childNode, depth: childDepth, path: childPath });
        }
        for (let index = childPairs.length - 1; index >= 0; index -= 1) {
            stack.push(childPairs[index]);
        }
    }
    return root;
}

/**
 * @param {{
 *   runId: string;
 *   frameNo: number;
 *   xmlJson: string;
 *   taskIndexJson?: string | null;
 *   onWarning?: (warning: SnapshotSerializerWarning) => void;
 * }} input
 * @returns {DevToolsSnapshot}
 */
export function snapshotFromFrameRow(input) {
    let xml = null;
    try {
        xml = JSON.parse(input.xmlJson);
    }
    catch {
        xml = null;
    }
    const root = parseXmlToDevToolsRoot(xml, input.onWarning, parseTaskIndex(input.taskIndexJson));
    return {
        version: 1,
        runId: input.runId,
        frameNo: input.frameNo,
        seq: input.frameNo,
        root,
    };
}

/**
 * Validate a frameNo input before any DB or reconciler call so that oversized
 * or malformed numeric inputs never reach the adapter.
 *
 * @param {unknown} frameNo
 * @returns {void}
 */
export function validateFrameNoInput(frameNo) {
    if (frameNo === undefined) {
        return;
    }
    if (!Number.isInteger(frameNo) || frameNo < 0 || frameNo > DEVTOOLS_MAX_FRAME_NO) {
        throw new DevToolsRouteError("FrameOutOfRange", `frameNo must be an integer between 0 and ${DEVTOOLS_MAX_FRAME_NO}.`);
    }
}

/**
 * Validate a fromSeq input before any DB or reconciler call.
 *
 * @param {unknown} fromSeq
 * @returns {void}
 */
export function validateFromSeqInput(fromSeq) {
    if (fromSeq === undefined) {
        return;
    }
    if (!Number.isInteger(fromSeq) || fromSeq < 0 || fromSeq > Number.MAX_SAFE_INTEGER) {
        throw new DevToolsRouteError("SeqOutOfRange", "fromSeq must be a non-negative integer.");
    }
}

/**
 * Attach each task node's CURRENT lifecycle state (latest iteration wins) from
 * the run's `_smithers_nodes` rows. The frame tree is pure structure; without
 * this, every consumer of the snapshot renders live runs as all-queued (#817).
 * Nodes with no row yet (never scheduled) keep an absent `state`.
 *
 * @param {DevToolsNode} root
 * @param {Array<Record<string, unknown>>} nodeRows
 * @returns {void}
 */
export function attachNodeStatesToDevToolsRoot(root, nodeRows) {
    /** @type {Map<string, { iteration: number; state: string; attempt: number }>} */
    const latest = new Map();
    for (const row of Array.isArray(nodeRows) ? nodeRows : []) {
        if (!asObject(row) || typeof row.nodeId !== "string" || typeof row.state !== "string" || row.state.length === 0) {
            continue;
        }
        const iteration = typeof row.iteration === "number" && Number.isFinite(row.iteration) ? row.iteration : 0;
        const existing = latest.get(row.nodeId);
        if (!existing || iteration > existing.iteration) {
            latest.set(row.nodeId, {
                iteration,
                state: row.state,
                attempt: typeof row.lastAttempt === "number" && Number.isFinite(row.lastAttempt) ? row.lastAttempt : 0,
            });
        }
    }
    if (latest.size === 0) {
        return;
    }
    /** @type {DevToolsNode[]} */
    const stack = [root];
    while (stack.length > 0) {
        const node = stack.pop();
        if (!node) {
            continue;
        }
        if (node.task?.nodeId) {
            const row = latest.get(node.task.nodeId);
            if (row) {
                node.task.state = row.state;
                node.task.attempt = row.attempt;
            }
        }
        for (const child of node.children) {
            stack.push(child);
        }
    }
}

/**
 * Attach the agent that ACTUALLY executed each task node (engine/model/agentId
 * from the latest attempt's persisted `metaJson` — the same metadata the
 * hijack candidates read, see ../hijackCandidates.js). Declared assignments
 * (`task.agentSummary`) come from the frame's task index instead; this covers
 * running/settled nodes and runs recorded before declared-agent capture.
 * Only the newest attempt per node is parsed — attempt metaJson can carry
 * whole conversations, so parsing every row would be wasteful.
 *
 * @param {DevToolsNode} root
 * @param {Array<Record<string, unknown>>} attemptRows
 * @returns {void}
 */
export function attachAgentAttemptsToDevToolsRoot(root, attemptRows) {
    /** @type {Map<string, { iteration: number; attempt: number; metaJson: unknown }>} */
    const latest = new Map();
    for (const row of Array.isArray(attemptRows) ? attemptRows : []) {
        if (!asObject(row) || typeof row.nodeId !== "string") {
            continue;
        }
        const iteration = typeof row.iteration === "number" && Number.isFinite(row.iteration) ? row.iteration : 0;
        const attempt = typeof row.attempt === "number" && Number.isFinite(row.attempt) ? row.attempt : 0;
        const existing = latest.get(row.nodeId);
        if (!existing ||
            iteration > existing.iteration ||
            (iteration === existing.iteration && attempt > existing.attempt)) {
            latest.set(row.nodeId, { iteration, attempt, metaJson: row.metaJson });
        }
    }
    if (latest.size === 0) {
        return;
    }
    /** @type {Map<string, { agentId?: string; engine?: string; model?: string } | undefined>} */
    const parsedByNode = new Map();
    /**
   * @param {string} nodeId
   * @returns {{ agentId?: string; engine?: string; model?: string } | undefined}
   */
    const agentRanFor = (nodeId) => {
        if (parsedByNode.has(nodeId)) {
            return parsedByNode.get(nodeId);
        }
        const row = latest.get(nodeId);
        /** @type {{ agentId?: string; engine?: string; model?: string } | undefined} */
        let ran;
        if (row && typeof row.metaJson === "string" && row.metaJson.length > 0) {
            try {
                const meta = JSON.parse(row.metaJson);
                if (asObject(meta)) {
                    const engine = typeof meta.agentEngine === "string" && meta.agentEngine ? meta.agentEngine : undefined;
                    const model = typeof meta.agentModel === "string" && meta.agentModel ? meta.agentModel : undefined;
                    const agentId = typeof meta.agentId === "string" && meta.agentId ? meta.agentId : undefined;
                    if (engine || model || agentId) {
                        ran = {
                            ...(agentId ? { agentId } : {}),
                            ...(engine ? { engine } : {}),
                            ...(model ? { model } : {}),
                        };
                    }
                }
            }
            catch {
                ran = undefined;
            }
        }
        parsedByNode.set(nodeId, ran);
        return ran;
    };
    /** @type {DevToolsNode[]} */
    const stack = [root];
    while (stack.length > 0) {
        const node = stack.pop();
        if (!node) {
            continue;
        }
        if (node.task?.nodeId) {
            const ran = agentRanFor(node.task.nodeId);
            if (ran) {
                node.task.agentRan = ran;
            }
        }
        for (const child of node.children) {
            stack.push(child);
        }
    }
}

/**
 * @param {{
 *   adapter: SmithersDb;
 *   runId: string;
 *   frameNo?: number;
 *   onWarning?: (warning: SnapshotSerializerWarning) => void;
 * }} input
 * @returns {Promise<DevToolsSnapshot>}
 */
export async function getDevToolsSnapshotRoute(input) {
    const runId = validateRunId(input.runId);
    validateFrameNoInput(input.frameNo);
    const run = await input.adapter.getRun(runId);
    if (!run) {
        throw new DevToolsRouteError("RunNotFound", `Run not found: ${runId}`);
    }
    const runState = await computeRunStateFromRow(input.adapter, run).catch(
        () => undefined,
    );
    const latestFrame = await input.adapter.getLastFrame(runId);
    if (!latestFrame) {
        // Zero-frame runs: only frameNo === undefined or 0 is permitted. Any
        // higher value is out of range because there is no frame 1 to return.
        if (input.frameNo !== undefined && input.frameNo !== 0) {
            throw new DevToolsRouteError("FrameOutOfRange", `frameNo must be 0 for runs with no frames (got ${input.frameNo}).`);
        }
        return {
            version: 1,
            runId,
            frameNo: 0,
            seq: 0,
            root: emptyDevToolsRoot(),
            ...(runState ? { runState } : {}),
        };
    }
    let requestedFrameNo = latestFrame.frameNo;
    if (input.frameNo !== undefined) {
        requestedFrameNo = validateRequestedFrameNo(input.frameNo, latestFrame.frameNo);
    }
    const frame = requestedFrameNo === latestFrame.frameNo
        ? latestFrame
        : (await input.adapter.listFrames(runId, Math.max(latestFrame.frameNo - requestedFrameNo + 1, 50))).find((entry) => entry.frameNo === requestedFrameNo);
    if (!frame) {
        throw new DevToolsRouteError("FrameOutOfRange", `Frame ${requestedFrameNo} is not available for run ${runId}.`);
    }
    const snapshot = snapshotFromFrameRow({
        runId,
        frameNo: requestedFrameNo,
        xmlJson: String(frame.xmlJson ?? "null"),
        taskIndexJson: frame.taskIndexJson,
        onWarning: input.onWarning,
    });
    // RunnableEffect is thenable but has no .catch; assimilate via Promise.resolve.
    const nodeRows = await Promise.resolve(input.adapter.listNodes(runId)).catch(() => []);
    attachNodeStatesToDevToolsRoot(snapshot.root, Array.isArray(nodeRows) ? nodeRows : []);
    const attemptRows = await Promise.resolve(input.adapter.listAttemptsForRun(runId)).catch(() => []);
    attachAgentAttemptsToDevToolsRoot(snapshot.root, Array.isArray(attemptRows) ? attemptRows : []);
    return runState ? { ...snapshot, runState } : snapshot;
}
