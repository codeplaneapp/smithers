// @smithers-type-exports-begin
/**
 * @template Schema
 * @typedef {import("./OnWebhookProps.ts").OnWebhookProps<Schema>} OnWebhookProps
 */
/**
 * @template Schema
 * @typedef {import("./OnWebhookProps.ts").GitHubSugarListenerProps<Schema>} GitHubSugarListenerProps
 */
// @smithers-type-exports-end

import React from "react";
import { SmithersContext } from "@smthrs/react-reconciler/context";
import { stripAutoColumns } from "@smthrs/db/react-output";
import { SmithersError } from "@smthrs/errors/SmithersError";
import { WaitForEvent } from "@smthrs/components";
import { integrationEventName } from "../../core/signalNames.js";
import {
  GitHubWebhookPayloadSchema,
  GitHubIssueCommentEventSchema,
  GitHubIssuesEventSchema,
  GitHubPullRequestEventSchema,
  GitHubPushEventSchema,
} from "../schemas.js";

/**
 * Correlation id for a GitHub listener: most specific form the props allow.
 * @param {string | undefined} repo
 * @param {number | undefined} number
 * @returns {string | undefined}
 */
export function githubCorrelationId(repo, number) {
  if (repo && typeof number === "number") {
    return `${repo}#${number}`;
  }
  return repo || undefined;
}

/**
 * Generic declarative GitHub listener (Signal.js pattern over WaitForEvent).
 * Waits durably for `integration:github:<event>[.<action>]` with the most
 * specific correlation the props allow; the webhook source emits one signal
 * per (name, correlation) variant, so every combination of
 * `event`/`action`/`repo`/`number` has a matching signal.
 *
 * @template {import("zod").ZodObject<import("zod").ZodRawShape>} Schema
 * @param {OnWebhookProps<Schema>} props
 */
export function OnWebhook(props) {
  if (props.skipIf) return null;
  if (typeof props.number === "number" && !props.repo) {
    throw new SmithersError(
      "INVALID_INPUT",
      "GitHub OnWebhook `number` requires `repo` (correlation is `<owner>/<repo>#<number>`).",
      { id: props.id, number: props.number },
    );
  }
  const smithersContext = props.smithersContext ?? SmithersContext;
  const ctx = React.useContext(smithersContext);
  const schema = props.schema ?? /** @type {Schema} */ (/** @type {unknown} */ (GitHubWebhookPayloadSchema));
  const eventName = integrationEventName("github", props.action ? `${props.event}.${props.action}` : props.event);
  const correlationId = githubCorrelationId(props.repo, props.number);
  const waitNode = React.createElement(WaitForEvent, {
    id: props.id,
    key: props.key,
    event: eventName,
    correlationId,
    output: schema,
    outputSchema: schema,
    timeoutMs: props.timeoutMs,
    onTimeout: props.onTimeout,
    async: props.async,
    dependsOn: props.dependsOn,
    needs: props.needs,
    label: props.label ?? `github:${props.action ? `${props.event}.${props.action}` : props.event}`,
    meta: props.meta,
  });
  if (!props.children) {
    return waitNode;
  }
  if (!ctx) {
    throw new SmithersError(
      "CONTEXT_OUTSIDE_WORKFLOW",
      "GitHub listener children require a workflow context. Build the workflow with createSmithers().",
    );
  }
  const row = ctx.outputMaybe(schema, { nodeId: props.id });
  if (row === undefined) {
    return waitNode;
  }
  const payload = schema.parse(stripAutoColumns(row));
  return React.createElement(React.Fragment, null, waitNode, props.children(payload));
}

/**
 * Wait for a `pull_request` event (optionally a specific `action`, repo, PR).
 * @template {import("zod").ZodObject<import("zod").ZodRawShape>} Schema
 * @param {GitHubSugarListenerProps<Schema> & { action?: string }} props
 */
export function OnPullRequest(props) {
  return OnWebhook({
    schema: /** @type {any} */ (GitHubPullRequestEventSchema),
    ...props,
    event: "pull_request",
  });
}

/**
 * Wait for `issues.opened`.
 * @template {import("zod").ZodObject<import("zod").ZodRawShape>} Schema
 * @param {GitHubSugarListenerProps<Schema>} props
 */
export function OnIssueOpened(props) {
  return OnWebhook({
    schema: /** @type {any} */ (GitHubIssuesEventSchema),
    action: "opened",
    ...props,
    event: "issues",
  });
}

/**
 * Wait for an issue/PR comment (`issue_comment`, default action `created`).
 * @template {import("zod").ZodObject<import("zod").ZodRawShape>} Schema
 * @param {GitHubSugarListenerProps<Schema> & { action?: string }} props
 */
export function OnIssueComment(props) {
  return OnWebhook({
    schema: /** @type {any} */ (GitHubIssueCommentEventSchema),
    action: "created",
    ...props,
    event: "issue_comment",
  });
}

/**
 * Wait for a `push` event (push deliveries carry no `action`).
 * @template {import("zod").ZodObject<import("zod").ZodRawShape>} Schema
 * @param {GitHubSugarListenerProps<Schema>} props
 */
export function OnPush(props) {
  return OnWebhook({
    schema: /** @type {any} */ (GitHubPushEventSchema),
    ...props,
    event: "push",
  });
}
