// Shared body for the Telegram listener components. Pattern copied from
// packages/components/src/components/Signal.js: render a WaitForEvent on the
// integration signal name, and when the delivered row is readable via
// ctx.outputMaybe, parse it with the zod schema and invoke the render prop.

import React from "react";
import { SmithersContext } from "@smthrs/react-reconciler/context";
import { stripAutoColumns } from "@smthrs/db/react-output";
import { SmithersError } from "@smthrs/errors/SmithersError";
import { WaitForEvent } from "@smthrs/components";
import { telegramChatCorrelationId, telegramThreadCorrelationId } from "../TelegramSource.js";

/**
 * Derive the correlationId for a listener's chat/thread props.
 * @param {{ chatId?: number | string; threadId?: number | string }} props
 * @returns {string | undefined}
 */
export function listenerCorrelationId(props) {
  if (props.threadId != null) {
    if (props.chatId == null) {
      throw new SmithersError("INVALID_INPUT", "Telegram listener threadId requires chatId.");
    }
    return telegramThreadCorrelationId(props.chatId, props.threadId);
  }
  return props.chatId != null ? telegramChatCorrelationId(props.chatId) : undefined;
}

/**
 * @param {string} eventName integration signal name to wait for
 * @param {import("./OnMessageProps.ts").TelegramListenerBaseProps<any>} props
 * @param {import("zod").ZodTypeAny} schema effective payload schema
 * @returns {React.ReactElement | null}
 */
export function renderTelegramListener(eventName, props, schema) {
  if (props.skipIf) {
    return null;
  }
  const smithersContext = /** @type {any} */ (props.smithersContext) ?? SmithersContext;
  const ctx = React.useContext(smithersContext);
  const correlationId = listenerCorrelationId(props);
  const waitNode = React.createElement(WaitForEvent, {
    id: props.id,
    key: props.key,
    event: eventName,
    correlationId,
    output: /** @type {any} */ (schema),
    outputSchema: /** @type {any} */ (schema),
    timeoutMs: props.timeoutMs,
    onTimeout: props.onTimeout,
    async: props.async,
    dependsOn: props.dependsOn,
    label: props.label ?? `telegram:${eventName}`,
    meta: props.meta,
  });
  if (!props.children) {
    return waitNode;
  }
  if (!ctx) {
    throw new SmithersError(
      "CONTEXT_OUTSIDE_WORKFLOW",
      "Telegram listener children require a workflow context. Build the workflow with createSmithers().",
    );
  }
  const row = ctx.outputMaybe(schema, { nodeId: props.id });
  if (row === undefined) {
    return waitNode;
  }
  const data = schema.parse(stripAutoColumns(row));
  return React.createElement(React.Fragment, null, waitNode, props.children(data));
}
