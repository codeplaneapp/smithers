import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";

/** @typedef {import("./TaskDescriptor.ts").TaskDescriptor} TaskDescriptor */

/**
 * Strip the loop-scope suffix (`@@ralph=0,...`) from a node id to recover the
 * logical task id authored in JSX. `fork` and `dependsOn` reference logical ids.
 * @param {string} nodeId
 * @returns {string}
 */
function logicalId(nodeId) {
    const atIdx = nodeId.indexOf("@@");
    return atIdx === -1 ? nodeId : nodeId.slice(0, atIdx);
}

/**
 * Validate `<Task fork>` references across the extracted task list. Throws a
 * typed SmithersError for fork sources that can never resolve to a usable
 * session snapshot, so authoring mistakes fail fast at graph-build time rather
 * than deadlocking the scheduler.
 *
 * Detects:
 *   - TASK_FORK_SOURCE_NOT_FOUND — fork id absent from the graph (covers a
 *     source that only exists in an unselected branch).
 *   - TASK_FORK_SESSION_UNAVAILABLE — the forking task is not an agent task and
 *     therefore has no session to seed.
 *   - TASK_FORK_CYCLE — the fork edge closes a dependency cycle, directly or
 *     indirectly (via `dependsOn` and/or other fork edges).
 *
 * Loop semantics are intentionally not validated here: `fork` resolves to the
 * latest completed snapshot for a task id at execution time, so a source inside
 * a loop is valid as long as its logical id appears in the graph.
 *
 * @param {readonly TaskDescriptor[]} tasks
 * @returns {void}
 */
export function validateForkSources(tasks) {
    const forks = tasks.filter((task) => typeof task.forkSource === "string" && task.forkSource);
    if (forks.length === 0) {
        return;
    }
    const presentLogicalIds = new Set(tasks.map((task) => logicalId(task.nodeId)));
    // Union of dependency edges keyed by logical id: dependsOn entries plus the
    // fork edge. Used only for cycle detection.
    /** @type {Map<string, Set<string>>} */
    const adjacency = new Map();
    /**
     * @param {string} from
     * @param {string} to
     */
    const addEdge = (from, to) => {
        const cleanedFrom = logicalId(from);
        const cleanedTo = logicalId(to);
        let set = adjacency.get(cleanedFrom);
        if (!set) {
            set = new Set();
            adjacency.set(cleanedFrom, set);
        }
        set.add(cleanedTo);
    };
    for (const task of tasks) {
        const from = logicalId(task.nodeId);
        for (const dep of task.dependsOn ?? []) {
            addEdge(from, dep);
        }
        if (typeof task.forkSource === "string" && task.forkSource) {
            addEdge(from, task.forkSource);
        }
    }
    /**
     * @param {string} from
     * @param {string} target
     * @returns {boolean}
     */
    const canReach = (from, target) => {
        const stack = [from];
        const visited = new Set();
        while (stack.length > 0) {
            const current = /** @type {string} */ (stack.pop());
            if (current === target) {
                return true;
            }
            if (visited.has(current)) {
                continue;
            }
            visited.add(current);
            const neighbors = adjacency.get(current);
            if (neighbors) {
                for (const next of neighbors) {
                    stack.push(next);
                }
            }
        }
        return false;
    };
    for (const task of forks) {
        const forkSource = /** @type {string} */ (task.forkSource);
        const nodeLogicalId = logicalId(task.nodeId);
        if (!presentLogicalIds.has(forkSource)) {
            throw new SmithersError("TASK_FORK_SOURCE_NOT_FOUND", `Task "${task.nodeId}" forks "${forkSource}", which is not present in the workflow graph.`, { nodeId: task.nodeId, forkSource });
        }
        if (!task.agent) {
            throw new SmithersError("TASK_FORK_SESSION_UNAVAILABLE", `Task "${task.nodeId}" uses fork but is not an agent task. Only agent tasks can fork a session.`, { nodeId: task.nodeId, forkSource });
        }
        // The fork edge is nodeLogicalId -> forkSource. A cycle exists iff
        // forkSource can already reach nodeLogicalId through the dependency graph.
        if (canReach(forkSource, nodeLogicalId)) {
            throw new SmithersError("TASK_FORK_CYCLE", `Task "${task.nodeId}" forks "${forkSource}", which creates a dependency cycle.`, { nodeId: task.nodeId, forkSource });
        }
    }
}
