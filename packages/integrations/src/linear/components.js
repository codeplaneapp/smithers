// @smithers-type-exports-begin
/** @typedef {import("./LinearComponents.ts").CommentOnIssueProps} CommentOnIssueProps */
/** @typedef {import("./LinearComponents.ts").CreateIssueProps} CreateIssueProps */
/** @typedef {import("./LinearComponents.ts").LinearListenerProps} LinearListenerProps */
/** @typedef {import("./LinearComponents.ts").UpdateIssueProps} UpdateIssueProps */
// @smithers-type-exports-end

import React from "react";
import { Effect } from "effect";
import { Task, WaitForEvent } from "@smithers-orchestrator/components";
import { SmithersContext } from "@smithers-orchestrator/react-reconciler/context";
import { stripAutoColumns } from "@smithers-orchestrator/db/react-output";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { integrationEventName } from "../core/signalNames.js";
import { makeLinearClient } from "./LinearClient.js";
import { LINEAR_SOURCE_ID } from "./LinearWebhookSource.js";

// ---------------------------------------------------------------------------
// Listener components — the Signal.js pattern over WaitForEvent: render the
// intrinsic wait node; once the delivered signal row exists, parse it with
// the zod schema and render the children with the typed payload.
// ---------------------------------------------------------------------------

/**
 * @param {string} eventSegment
 * @param {string} displayName
 * @returns {(props: LinearListenerProps) => React.ReactElement | null}
 */
function makeLinearListener(eventSegment, displayName) {
    /** @param {LinearListenerProps} props */
    function LinearListener(props) {
        if (props.skipIf)
            return null;
        const smithersContext = /** @type {any} */ (props.smithersContext) ?? SmithersContext;
        const ctx = React.useContext(smithersContext);
        const event = integrationEventName(LINEAR_SOURCE_ID, eventSegment);
        const correlationId = props.issueId ?? props.teamKey ?? undefined;
        const waitNode = React.createElement(WaitForEvent, {
            id: props.id,
            key: /** @type {any} */ (props.key),
            event,
            correlationId,
            output: /** @type {any} */ (props.schema),
            outputSchema: /** @type {any} */ (props.schema),
            timeoutMs: props.timeoutMs,
            onTimeout: props.onTimeout,
            async: props.async,
            dependsOn: props.dependsOn,
            needs: props.needs,
            label: props.label ?? `linear:${eventSegment}`,
            meta: props.meta,
        });
        if (!props.children) {
            return waitNode;
        }
        if (!ctx) {
            throw new SmithersError("CONTEXT_OUTSIDE_WORKFLOW", `${displayName} children require a workflow context. Build the workflow with createSmithers().`);
        }
        if (!props.schema) {
            throw new SmithersError("INVALID_INPUT", `${displayName} children require a \`schema\` prop (a registered output schema) to read the delivered payload.`);
        }
        const signalRow = ctx.outputMaybe(props.schema, { nodeId: props.id });
        if (signalRow === undefined) {
            return waitNode;
        }
        const payload = /** @type {any} */ (props.schema).parse(stripAutoColumns(signalRow));
        return React.createElement(React.Fragment, null, waitNode, props.children(payload));
    }
    LinearListener.displayName = displayName;
    return LinearListener;
}

/**
 * Wait for `integration:linear:issue.update`. Correlate on `issueId`
 * (`ENG-123`) or `teamKey` (`ENG`); omit both for a catch-all listener.
 */
export const OnIssueUpdate = makeLinearListener("issue.update", "Linear.OnIssueUpdate");

/** Wait for `integration:linear:issue.create`. */
export const OnIssueCreated = makeLinearListener("issue.create", "Linear.OnIssueCreated");

/** Wait for `integration:linear:comment.create`. */
export const OnComment = makeLinearListener("comment.create", "Linear.OnComment");

// ---------------------------------------------------------------------------
// Outbound components — deterministic compute Tasks.
//
// Task's own deps handling turns function children WITH deps into a STATIC
// payload (children(resolvedDeps) is evaluated at render time,
// packages/components/src/components/Task.js:243-283) — only function
// children WITHOUT deps become `__smithersKind: "compute"`. So these
// wrappers resolve deps themselves (same outputMaybe walk as Task), build
// the API input from value-or-function props, and render a dep-less
// function child so the API call executes as a compute task.
// ---------------------------------------------------------------------------

/**
 * @param {Record<string, unknown> | undefined} deps
 * @param {Record<string, string> | undefined} needs
 * @returns {string[] | undefined}
 */
function deriveDepNodeIds(deps, needs) {
    if (!deps)
        return undefined;
    const ids = new Set();
    for (const key of Object.keys(deps)) {
        const nodeId = needs?.[key] ?? key;
        if (nodeId)
            ids.add(nodeId);
    }
    return ids.size > 0 ? [...ids] : undefined;
}

/**
 * @param {any} ctx
 * @param {Record<string, unknown>} deps
 * @param {Record<string, string> | undefined} needs
 * @returns {Record<string, unknown> | null}
 */
function resolveDeps(ctx, deps, needs) {
    /** @type {Record<string, unknown>} */
    const resolved = Object.create(null);
    for (const key of Object.keys(deps)) {
        const nodeId = needs?.[key] ?? key;
        const value = ctx.outputMaybe(deps[key], { nodeId });
        if (value === undefined)
            return null;
        resolved[key] = value;
    }
    return resolved;
}

/**
 * @template T
 * @param {import("./LinearComponents.ts").FromDeps<T> | undefined} value
 * @param {Record<string, unknown>} deps
 * @returns {T | undefined}
 */
function fromDeps(value, deps) {
    return typeof value === "function"
        ? /** @type {(deps: Record<string, unknown>) => T} */ (value)(deps)
        : value;
}

/**
 * @param {string} displayName
 * @param {(props: any, resolvedDeps: Record<string, unknown>) => (client: import("./LinearClientTypes.ts").LinearClientService) => Effect.Effect<Record<string, unknown>, import("@smithers-orchestrator/errors/SmithersError").SmithersError>} buildCall
 */
function makeLinearOutbound(displayName, buildCall) {
    /** @param {any} props */
    function LinearOutbound(props) {
        const { id, deps, needs, config, output, outputSchema, retryPolicy, timeoutMs, async: waitAsync, dependsOn, label, smithersContext, skipIf } = props;
        if (skipIf)
            return null;
        const taskContext = /** @type {any} */ (smithersContext) ?? SmithersContext;
        const ctx = React.useContext(taskContext);
        if (deps && !ctx) {
            throw new SmithersError("CONTEXT_OUTSIDE_WORKFLOW", `${displayName} deps require a workflow context. Build the workflow with createSmithers().`);
        }
        const depNodeIds = deriveDepNodeIds(deps, needs);
        const resolved = deps ? resolveDeps(ctx, deps, needs) : Object.create(null);
        if (deps && resolved == null) {
            // Upstream outputs not ready yet — defer like Task does.
            ctx?.recordDeferredDep?.(id, depNodeIds ?? []);
            return null;
        }
        const call = buildCall(props, resolved ?? Object.create(null));
        const computeFn = () => {
            const client = makeLinearClient(config);
            return Effect.runPromise(call(client));
        };
        return React.createElement(Task, {
            id,
            key: /** @type {any} */ (props.key),
            output,
            outputSchema,
            retryPolicy,
            timeoutMs,
            async: waitAsync,
            smithersContext,
            dependsOn: depNodeIds
                ? [...new Set([...(dependsOn ?? []), ...depNodeIds])]
                : dependsOn,
            label: label ?? `linear:${displayName.split(".").pop()}`,
            children: computeFn,
        });
    }
    LinearOutbound.displayName = displayName;
    return LinearOutbound;
}

/**
 * @param {import("./LinearClientTypes.ts").LinearIssueResult} issue
 * @returns {{ id: string; identifier: string; title: string; url: string }}
 */
function issueOutputRow(issue) {
    return {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        url: issue.url,
    };
}

/**
 * Create a Linear issue as a deterministic compute Task. Props may be
 * values or `(resolvedDeps) => value` functions when `deps` is set. Output
 * row shape: `linearIssueOutputSchema`.
 * @type {(props: CreateIssueProps) => React.ReactElement | null}
 */
export const CreateIssue = makeLinearOutbound("Linear.CreateIssue", (props, deps) => {
    /** @type {import("./LinearClientTypes.ts").CreateIssueInput} */
    const input = {
        teamKey: fromDeps(props.teamKey, deps),
        teamId: fromDeps(props.teamId, deps),
        title: /** @type {string} */ (fromDeps(props.title, deps)),
        description: fromDeps(props.description, deps),
        priority: fromDeps(props.priority, deps),
        labels: fromDeps(props.labels, deps),
        stateName: fromDeps(props.stateName, deps),
        assigneeId: fromDeps(props.assigneeId, deps),
    };
    return (client) => Effect.map(client.createIssue(input), issueOutputRow);
});

/**
 * Update a Linear issue (by UUID or `ENG-123` identifier) as a compute
 * Task. Output row shape: `linearIssueOutputSchema`.
 * @type {(props: UpdateIssueProps) => React.ReactElement | null}
 */
export const UpdateIssue = makeLinearOutbound("Linear.UpdateIssue", (props, deps) => {
    const issue = /** @type {string} */ (fromDeps(props.issue, deps));
    /** @type {import("./LinearClientTypes.ts").UpdateIssueFields} */
    const fields = {
        title: fromDeps(props.title, deps),
        description: fromDeps(props.description, deps),
        priority: fromDeps(props.priority, deps),
        labels: fromDeps(props.labels, deps),
        stateName: fromDeps(props.stateName, deps),
        assigneeId: fromDeps(props.assigneeId, deps),
    };
    return (client) => Effect.map(client.updateIssue(issue, fields), issueOutputRow);
});

/**
 * Comment on a Linear issue (by UUID or `ENG-123` identifier) as a compute
 * Task. Output row shape: `linearCommentOutputSchema`.
 * @type {(props: CommentOnIssueProps) => React.ReactElement | null}
 */
export const CommentOnIssue = makeLinearOutbound("Linear.CommentOnIssue", (props, deps) => {
    const issue = /** @type {string} */ (fromDeps(props.issue, deps));
    const body = /** @type {string} */ (fromDeps(props.body, deps));
    return (client) => Effect.map(client.commentOnIssue(issue, body), (comment) => ({
        id: comment.id,
        body: comment.body,
        issueId: comment.issue?.id ?? "",
        issueIdentifier: comment.issue?.identifier ?? "",
    }));
});
