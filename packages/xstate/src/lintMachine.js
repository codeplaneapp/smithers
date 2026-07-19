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
    walkStateNode(machineId, machine, machine.root);
    lintedMachines.add(machine);
}

/**
 * @param {string} machineId
 * @param {import("xstate").AnyStateMachine} machine
 * @param {any} stateNode Compiled xstate StateNode.
 */
function walkStateNode(machineId, machine, stateNode) {
    const where = stateNode.id;
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
        walkStateNode(machineId, machine, child);
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
