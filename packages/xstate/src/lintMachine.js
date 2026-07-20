import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";

/**
 * Machines already validated in this process, keyed by machine object
 * identity. Hot reload produces a new machine object, so edited machines
 * re-lint; re-renders of the same machine skip the walk.
 * @type {WeakSet<object>}
 */
const lintedMachines = new WeakSet();

/**
 * Reject machine features that cannot exist inside a durable pure fold.
 * Runs per machine identity at mount. There is deliberately NO escape hatch:
 * a silently-inert invoke/after/raise is worse than a hard error, especially
 * for AI authors. The exact builtin-action allowlist is `assign` (without
 * spawn — runtime spawns are rejected by the fold's children check).
 *
 * @param {string} machineId `useSmithersMachine` id, for error messages.
 * @param {import("xstate").AnyStateMachine} machine
 */
export function lintMachine(machineId, machine) {
    if (lintedMachines.has(machine)) return;
    const reenterableIds = findReenterableStateIds(machine.root);
    walkStateNode(machineId, machine, machine.root, reenterableIds);
    lintedMachines.add(machine);
}

/**
 * States the machine can transition back into after leaving — a nonzero-
 * length path from the state back to itself in the resolved transition
 * graph (a direct self-transition, or a longer cycle through siblings).
 * Re-entering a state re-mounts every descendant region too, so a
 * reenterable ancestor marks its whole subtree reenterable.
 *
 * @param {any} root Compiled xstate root StateNode.
 * @returns {Set<string>} State ids the machine can re-enter.
 */
function findReenterableStateIds(root) {
    /** @type {Map<string, any>} */
    const nodesById = new Map();
    /** @type {Map<string, Set<string>>} */
    const adjacency = new Map();
    /** @type {Map<string, string>} */
    const parentById = new Map();
    (function collect(node, parent) {
        nodesById.set(node.id, node);
        if (parent) parentById.set(node.id, parent.id);
        const edges = new Set();
        const addTargets = (defs) => {
            for (const def of defs ?? []) {
                for (const target of def.target ?? []) {
                    if (target?.id) edges.add(target.id);
                }
            }
        };
        if (node.transitions instanceof Map) {
            for (const defs of node.transitions.values()) addTargets(defs);
        }
        addTargets(node.always);
        if (node.type === "compound") {
            for (const target of node.initial?.target ?? []) {
                if (target?.id) edges.add(target.id);
            }
        }
        adjacency.set(node.id, edges);
        for (const child of Object.values(node.states ?? {})) collect(/** @type {any} */ (child), node);
    })(root, null);
    /** @type {Set<string>} */
    const reenterable = new Set();
    for (const [id, edges] of adjacency) {
        if (edges.has(id)) reenterable.add(id);
    }
    // Tarjan SCC: any strongly-connected component with more than one node
    // is a cycle, and every node in it can reach itself via a nonzero path.
    let index = 0;
    /** @type {Map<string, number>} */
    const indices = new Map();
    /** @type {Map<string, number>} */
    const lowlink = new Map();
    /** @type {Set<string>} */
    const onStack = new Set();
    /** @type {string[]} */
    const stack = [];
    const strongconnect = (id) => {
        indices.set(id, index);
        lowlink.set(id, index);
        index += 1;
        stack.push(id);
        onStack.add(id);
        for (const target of adjacency.get(id) ?? []) {
            if (!indices.has(target)) {
                strongconnect(target);
                lowlink.set(id, Math.min(/** @type {number} */ (lowlink.get(id)), /** @type {number} */ (lowlink.get(target))));
            }
            else if (onStack.has(target)) {
                lowlink.set(id, Math.min(/** @type {number} */ (lowlink.get(id)), /** @type {number} */ (indices.get(target))));
            }
        }
        if (lowlink.get(id) === indices.get(id)) {
            const scc = [];
            let member;
            do {
                member = /** @type {string} */ (stack.pop());
                onStack.delete(member);
                scc.push(member);
            } while (member !== id);
            if (scc.length > 1) {
                for (const member2 of scc) reenterable.add(member2);
            }
        }
    };
    for (const id of nodesById.keys()) {
        if (!indices.has(id)) strongconnect(id);
    }
    // Propagate down: re-entering a state re-mounts its descendants too.
    for (const id of [...reenterable]) {
        for (const [candidateId, parentId] of parentById) {
            if (parentId === id) reenterable.add(candidateId);
        }
    }
    // The above only walks one level; repeat until no new ids are added.
    let grew = true;
    while (grew) {
        grew = false;
        for (const [candidateId, parentId] of parentById) {
            if (reenterable.has(parentId) && !reenterable.has(candidateId)) {
                reenterable.add(candidateId);
                grew = true;
            }
        }
    }
    return reenterable;
}

/**
 * @param {string} machineId
 * @param {import("xstate").AnyStateMachine} machine
 * @param {any} stateNode Compiled xstate StateNode.
 * @param {Set<string>} reenterableIds
 */
function walkStateNode(machineId, machine, stateNode, reenterableIds) {
    const where = stateNode.id;
    const taskId = stateNode.meta && Object.prototype.hasOwnProperty.call(stateNode.meta, "smithersTaskId")
        ? stateNode.meta.smithersTaskId
        : undefined;
    if (taskId !== undefined && typeof taskId !== "function" && reenterableIds.has(where)) {
        throw new SmithersError("XSTATE_REENTRY_TASK_ID_UNSUPPORTED", `Machine "${machineId}" state "${where}" declares meta.smithersTaskId as a bare constant, but the machine can re-enter this state. A completed Smithers task is never re-executed, so re-entering would deadlock: no new row, no new event, and the quiescent graph ends the run mid-flight. Derive the id from context instead — meta: { smithersTaskId: (context) => \`draft-r\${context.rev}\` } — minted from an assign() counter, and render the <Task id={...}> with that same value.`, { machineId, stateId: where });
    }
    if (Array.isArray(stateNode.invoke) && stateNode.invoke.length > 0) {
        throw lintError("XSTATE_INVOKE_UNSUPPORTED", machineId, where, "uses invoke", "Actors cannot run inside a durable fold. Execute the work with a Smithers <Task> (or <Subflow>) that writes an output row, and feed it back with the taskOutput() event source.");
    }
    // Check `after` before entry/exit: compiling a delayed transition injects
    // builtin raise/cancel actions into this node's entry/exit, and flagging
    // those would misname the real problem.
    const transitionKeys = stateNode.transitions instanceof Map ? [...stateNode.transitions.keys()] : [];
    if (transitionKeys.some((key) => String(key).startsWith("xstate.after")) ||
        (stateNode.config && stateNode.config.after && Object.keys(stateNode.config.after).length > 0)) {
        throw lintError("XSTATE_AFTER_UNSUPPORTED", machineId, where, "uses after (delayed transitions)", "Timers cannot fire inside a durable fold. Render a Smithers <WaitForEvent timeoutMs onTimeout=\"continue\"> with the tagged wait-result envelope and feed the timeout back with the timedOut() event source, or use <Timer> for pure delays.");
    }
    for (const action of [...(stateNode.entry ?? []), ...(stateNode.exit ?? [])]) {
        checkAction(machineId, machine, where, action);
    }
    if (stateNode.transitions instanceof Map) {
        for (const transitions of stateNode.transitions.values()) {
            for (const transitionDef of transitions) {
                for (const action of transitionDef.actions ?? []) {
                    checkAction(machineId, machine, where, action);
                }
            }
        }
    }
    for (const transitionDef of stateNode.always ?? []) {
        for (const action of transitionDef.actions ?? []) {
            checkAction(machineId, machine, where, action);
        }
    }
    for (const child of Object.values(stateNode.states ?? {})) {
        walkStateNode(machineId, machine, child, reenterableIds);
    }
}

/** Smithers-native alternative per rejected builtin action type. */
const BUILTIN_REJECTIONS = {
    "xstate.raise": ["XSTATE_RAISE_UNSUPPORTED", "uses raise()", "Self-sent events would not be durable rows. Model the extra step as machine states, or deliver a real signal (smithers signal) read by the eventReceived() source."],
    "xstate.sendTo": ["XSTATE_SEND_TO_UNSUPPORTED", "uses sendTo()", "There are no live actors to address inside a fold. Communicate through durable channels: task outputs, approvals, or signals."],
    "xstate.emit": ["XSTATE_EMIT_UNSUPPORTED", "uses emit()", "Emitted events have no subscribers inside a fold. Derive UI/observers from the machine snapshot returned by useSmithersMachine, or write a Smithers output row."],
    "xstate.enqueueActions": ["XSTATE_ENQUEUE_ACTIONS_UNSUPPORTED", "uses enqueueActions()", "Queued action programs cannot execute in a fold. Keep context updates in plain assign() and move side effects into Smithers tasks."],
    "xstate.spawnChild": ["XSTATE_SPAWN_UNSUPPORTED", "uses spawnChild()", "Spawned actors cannot run inside a durable fold. Execute work with a Smithers <Task> and feed its output back with the taskOutput() event source."],
    "xstate.stopChild": ["XSTATE_STOP_CHILD_UNSUPPORTED", "uses stopChild()/stop()", "There are no child actors to stop inside a fold. Stop rendering the corresponding Smithers task instead — unmounting is the durable equivalent."],
    "xstate.cancel": ["XSTATE_CANCEL_UNSUPPORTED", "uses cancel()", "There are no scheduled delays to cancel inside a fold (after is also unsupported). Model timeouts with <WaitForEvent timeoutMs> and the timedOut() source."],
    "xstate.log": ["XSTATE_ACTION_UNSUPPORTED", "uses log()", "Fold actions are discarded, so log() would be silently inert. Log from workflow code or a Smithers task instead."],
};

/**
 * @param {string} machineId
 * @param {import("xstate").AnyStateMachine} machine
 * @param {string} where
 * @param {unknown} action
 */
function checkAction(machineId, machine, where, action) {
    const resolved = resolveActionType(machine, action);
    if (resolved.builtinType === "xstate.assign") return;
    if (resolved.builtinType) {
        const rejection = BUILTIN_REJECTIONS[/** @type {keyof typeof BUILTIN_REJECTIONS} */ (resolved.builtinType)];
        if (rejection) {
            throw lintError(rejection[0], machineId, where, rejection[1], rejection[2]);
        }
        throw lintError("XSTATE_ACTION_UNSUPPORTED", machineId, where, `uses builtin action "${resolved.builtinType}"`, "Only assign() may run inside a durable fold. Move side effects into Smithers tasks and feed results back as events.");
    }
    throw lintError("XSTATE_ACTION_UNSUPPORTED", machineId, where, `declares custom action ${resolved.label}`, "Custom actions are discarded by the fold and would be silently inert. Only assign() is allowed; run side effects in a Smithers <Task> and feed its output back with taskOutput().");
}

/**
 * @param {import("xstate").AnyStateMachine} machine
 * @param {unknown} action
 * @returns {{ builtinType?: string; label: string }}
 */
function resolveActionType(machine, action) {
    if (typeof action === "string" || (action && typeof action === "object")) {
        const name = typeof action === "string" ? action : String((/** @type {{ type?: unknown }} */ (action)).type ?? "");
        if (name.startsWith("xstate.")) return { builtinType: name, label: `"${name}"` };
        const impl = /** @type {Record<string, unknown> | undefined} */ (machine.implementations?.actions)?.[name];
        if (impl) return resolveImplType(name, impl);
        return { label: `"${name}" (no implementation registered)` };
    }
    if (typeof action === "function") {
        const type = /** @type {{ type?: unknown }} */ (action).type;
        if (typeof type === "string" && type.startsWith("xstate.")) return { builtinType: type, label: `"${type}"` };
        return { label: `inline function "${/** @type {{ name?: string }} */ (action).name || "anonymous"}"` };
    }
    return { label: String(action) };
}

/**
 * @param {string} name
 * @param {unknown} impl
 * @returns {{ builtinType?: string; label: string }}
 */
function resolveImplType(name, impl) {
    const type = impl && (typeof impl === "function" || typeof impl === "object")
        ? /** @type {{ type?: unknown }} */ (impl).type
        : undefined;
    if (typeof type === "string" && type.startsWith("xstate.")) return { builtinType: type, label: `"${name}"` };
    return { label: `"${name}"` };
}

/**
 * @param {string} code
 * @param {string} machineId
 * @param {string} where
 * @param {string} what
 * @param {string} alternative
 * @returns {SmithersError}
 */
function lintError(code, machineId, where, what, alternative) {
    return new SmithersError(/** @type {never} */ (code), `Machine "${machineId}" state "${where}" ${what}, which useSmithersMachine cannot support. ${alternative}`, { machineId, stateId: where });
}

/** Test seam: clears nothing (WeakSet), exists to document identity-keyed behavior. */
export const __lintInternals = { lintedMachines };
