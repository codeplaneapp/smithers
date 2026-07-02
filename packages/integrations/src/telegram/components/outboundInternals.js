// Shared plumbing for the outbound Telegram components.
//
// Deps interaction with Task (verified against
// packages/components/src/components/Task.js:243-266 and proven in
// tests/telegram-outbound.test.js): when Task receives function children AND
// a `deps` prop without an agent, it calls `children(resolvedDeps)` at
// RENDER time and falls through to `__smithersKind: "static"` — the function
// result becomes a static payload and no compute ever runs. Only function
// children WITHOUT `deps` yield `__smithersKind: "compute"`.
//
// So these components resolve deps themselves (same ctx.outputMaybe walk as
// Task's internal resolveDeps), defer rendering until the deps exist, and
// then render a Task whose function child (no deps prop) closes over the
// resolved values — compute kind, executed durably by the engine, gated by
// `dependsOn` on the upstream node ids.

import React from "react";
import { Effect } from "effect";
import { SmithersContext } from "@smithers-orchestrator/react-reconciler/context";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { Task } from "@smithers-orchestrator/components";
import { resolveTelegramClient } from "../config.js";

/**
 * @param {import("./outboundProps.ts").TelegramDepsSpec | undefined} deps
 * @param {Record<string, string> | undefined} needs
 * @returns {string[]}
 */
export function depNodeIds(deps, needs) {
    if (!deps) {
        return [];
    }
    const ids = new Set();
    for (const key of Object.keys(deps)) {
        const nodeId = needs?.[key] ?? key;
        if (nodeId) {
            ids.add(nodeId);
        }
    }
    return [...ids];
}

/**
 * Resolve a deps spec against the workflow ctx (mirror of Task's internal
 * resolveDeps). Returns null while any dep is missing.
 * @param {any} ctx
 * @param {import("./outboundProps.ts").TelegramDepsSpec | undefined} deps
 * @param {Record<string, string> | undefined} needs
 * @returns {Record<string, unknown> | null}
 */
export function resolveOutboundDeps(ctx, deps, needs) {
    if (!deps) {
        return Object.create(null);
    }
    const resolved = Object.create(null);
    for (const key of Object.keys(deps)) {
        const nodeId = needs?.[key] ?? key;
        const value = ctx.outputMaybe(deps[key], { nodeId });
        if (value === undefined) {
            return null;
        }
        resolved[key] = value;
    }
    return resolved;
}

/**
 * Render an outbound Telegram compute Task.
 * @param {import("./outboundProps.ts").TelegramOutboundBaseProps} props
 * @param {string} componentName
 * @param {(client: import("../TelegramClient.ts").TelegramClientService, resolvedDeps: Record<string, unknown>) => Effect.Effect<unknown, unknown>} run
 * @returns {React.ReactElement | null}
 */
export function renderOutboundTask(props, componentName, run) {
    if (props.skipIf) {
        return null;
    }
    const smithersContext = /** @type {any} */ (props.smithersContext) ?? SmithersContext;
    const ctx = React.useContext(smithersContext);
    if (props.deps && !ctx) {
        throw new SmithersError("CONTEXT_OUTSIDE_WORKFLOW", `Telegram.${componentName} deps require a workflow context. Build the workflow with createSmithers().`);
    }
    const resolved = props.deps
        ? resolveOutboundDeps(ctx, props.deps, props.needs)
        : Object.create(null);
    const gateIds = depNodeIds(props.deps, props.needs);
    if (props.deps && resolved == null) {
        // Deps not ready — defer exactly like Task does so the engine can
        // distinguish transient waits from unsatisfiable ones.
        ctx?.recordDeferredDep?.(props.id, gateIds);
        return null;
    }
    const dependsOn = [...new Set([...(props.dependsOn ?? []), ...gateIds])];
    const config = props.config;
    // Function child WITHOUT a deps prop → __smithersKind: "compute".
    const computeFn = () => {
        const client = resolveTelegramClient(config);
        return Effect.runPromise(
        /** @type {Effect.Effect<any, any>} */ (run(client, resolved ?? Object.create(null))));
    };
    return React.createElement(Task, /** @type {any} */ ({
        id: props.id,
        key: props.key,
        output: props.output,
        outputSchema: props.outputSchema,
        retryPolicy: props.retryPolicy,
        timeoutMs: props.timeoutMs,
        dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
        async: props.async,
        label: props.label ?? `telegram:${componentName}`,
        smithersContext: props.smithersContext,
        children: computeFn,
    }));
}
