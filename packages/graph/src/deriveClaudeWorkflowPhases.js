/** @typedef {import("./GraphSnapshot.ts").GraphSnapshot} GraphSnapshot */
/** @typedef {import("./TaskDescriptor.ts").TaskDescriptor} TaskDescriptor */
/** @typedef {import("./XmlNode.ts").XmlNode} XmlNode */
/** @typedef {import("./ClaudeWorkflowNodePhase.ts").ClaudeWorkflowNodeKind} ClaudeWorkflowNodeKind */
/** @typedef {import("./ClaudeWorkflowPhasePlan.ts").ClaudeWorkflowPhasePlan} ClaudeWorkflowPhasePlan */

const PHASE_TAGS = new Set(["smithers:sequence", "smithers:parallel", "smithers:ralph"]);
const TASK_TAGS = new Set([
    "smithers:task",
    "smithers:subflow",
    "smithers:sandbox",
    "smithers:wait-for-event",
    "smithers:timer",
    "smithers:approval",
    "smithers:approval-gate",
    "smithers:human-task",
]);

/**
 * @param {GraphSnapshot} snapshot
 * @param {{ collapsePhases?: boolean }} [options]
 * @returns {ClaudeWorkflowPhasePlan}
 */
export function deriveClaudeWorkflowPhases(snapshot, options = {}) {
    const tasks = [...(snapshot.tasks ?? [])].sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
    const taskById = new Map(tasks.map((task) => [task.nodeId, task]));
    const assigned = new Set();
    /** @type {import("./ClaudeWorkflowPhase.ts").ClaudeWorkflowPhase[]} */
    const phases = [];
    const phaseTitleCounts = new Map();
    /** @type {import("./ClaudeWorkflowNodePhase.ts").ClaudeWorkflowNodePhase[]} */
    const nodes = [];
    const fallbackBase = titleFromProps(snapshot.xml?.kind === "element" ? snapshot.xml.props : undefined, "Workflow");
    const fallbackPhase = options.collapsePhases === true ? "Smithers run" : uniquePhaseTitle(fallbackBase, phaseTitleCounts);

    ensurePhase(fallbackPhase);

    /** @param {string} title */
    function ensurePhase(title) {
        if (!phases.some((phase) => phase.title === title)) {
            phases.push({ title });
        }
    }

    /** @param {XmlNode | null | undefined} node @param {string} currentPhase */
    function walk(node, currentPhase) {
        if (!node || node.kind !== "element") {
            return;
        }

        let nextPhase = currentPhase;
        if (PHASE_TAGS.has(node.tag) && options.collapsePhases !== true) {
            const fallback = node.tag === "smithers:ralph" ? "Loop" : node.tag === "smithers:parallel" ? "Parallel" : "Sequence";
            nextPhase = uniquePhaseTitle(titleFromProps(node.props, fallback), phaseTitleCounts);
            ensurePhase(nextPhase);
        }

        if (TASK_TAGS.has(node.tag)) {
            const task = findTaskForElement(node, taskById);
            if (task && !assigned.has(task.nodeId)) {
                assigned.add(task.nodeId);
                nodes.push(nodePhase(task, nextPhase));
            }
        }

        for (const child of node.children ?? []) {
            walk(child, nextPhase);
        }
    }

    walk(snapshot.xml, fallbackPhase);

    for (const task of tasks) {
        if (!assigned.has(task.nodeId)) {
            nodes.push(nodePhase(task, fallbackPhase));
        }
    }

    return { phases, nodes };
}

/**
 * @param {Record<string, unknown> | undefined} props
 * @param {string} fallback
 * @returns {string}
 */
function titleFromProps(props, fallback) {
    for (const key of ["label", "name", "id"]) {
        const value = props?.[key];
        if (typeof value === "string" && value.trim().length > 0) {
            return value.trim();
        }
    }
    return fallback;
}

/**
 * @param {string} title
 * @param {Map<string, number>} counts
 * @returns {string}
 */
function uniquePhaseTitle(title, counts) {
    const count = (counts.get(title) ?? 0) + 1;
    counts.set(title, count);
    return count === 1 ? title : `${title} ${count}`;
}

/**
 * @param {Extract<XmlNode, { kind: "element" }>} node
 * @param {Map<string, TaskDescriptor>} taskById
 * @returns {TaskDescriptor | undefined}
 */
function findTaskForElement(node, taskById) {
    const id = node.props?.id;
    if (typeof id !== "string" || id.length === 0) {
        return undefined;
    }
    return taskById.get(id) ?? [...taskById.values()].find((task) => task.nodeId.startsWith(`${id}@@`));
}

/**
 * @param {TaskDescriptor} task
 * @param {string} phase
 * @returns {import("./ClaudeWorkflowNodePhase.ts").ClaudeWorkflowNodePhase}
 */
function nodePhase(task, phase) {
    return {
        nodeId: task.nodeId,
        label: task.label || task.nodeId,
        phase,
        kind: classifyTask(task),
    };
}

/**
 * @param {TaskDescriptor} task
 * @returns {ClaudeWorkflowNodeKind}
 */
function classifyTask(task) {
    if (task.agent) return "agent";
    if (task.computeFn) return "compute";
    if (task.staticPayload !== undefined) return "static";
    if (task.meta?.__timer) return "timer";
    if (task.waitAsync || task.meta?.__waitForEvent) return "wait";
    if (task.meta?.__subflow) return "subflow";
    if (task.meta?.__sandbox) return "sandbox";
    if (task.needsApproval) return "approval";
    return "unknown";
}
