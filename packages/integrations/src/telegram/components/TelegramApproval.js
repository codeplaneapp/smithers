// @smithers-type-exports-begin
/** @typedef {import("./TelegramApprovalProps.ts").TelegramApprovalProps} TelegramApprovalProps */
/** @typedef {import("./TelegramApprovalProps.ts").TelegramApprovalRequest} TelegramApprovalRequest */
// @smithers-type-exports-end

// Turn a Smithers approval into inline Approve/Reject (or one-button-per-option)
// controls inside a Telegram chat, resolved durably by the button press. No web
// server, no gateway wiring — it composes the existing durable primitives:
//   SendMessage (post the prompt + inline keyboard)
//     → OnCallbackQuery (durably wait for the press)
//       → a compute Task that acknowledges the press, edits the message to
//         stamp the outcome (best-effort), and yields the decision (shaped like
//         the core approvalDecisionSchema / approvalSelectionSchema).
//
// Register the two internal node schemas once via `telegramApprovalSchemas`:
//   const { smithers, outputs } = createSmithers({
//     ...telegramApprovalSchemas,
//     approval: telegramApprovalDecisionSchema,
//   });
//
// WaitForEvent wakes on the first callback_query for the chat/thread correlation
// and has no predicate, so run one interactive approval per chat at a time, or
// isolate concurrent approvals with `threadId` (forum topics). Any chat member
// can press; the private/allowed chat is the trust boundary for Tier 1.

import React from "react";
import { Effect } from "effect";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { Task } from "@smithers-orchestrator/components";
import { OnCallbackQuery } from "./OnMessage.js";
import { SendMessage, TelegramSendResultSchema } from "./SendMessage.js";
import { TelegramCallbackQuerySchema } from "../schemas.js";
import { resolveTelegramClient } from "../config.js";
import {
  approvalInlineKeyboard,
  telegramApprovalDecision,
  telegramApprovalDecisionSchema,
  telegramApprovalSelectionSchema,
  telegramApproverLabel,
} from "../approval.js";

/**
 * Output schemas for the two internal `TelegramApproval` nodes (the prompt send
 * and the button-press wait). Spread into `createSmithers({...})` so the engine
 * can persist them.
 */
export const telegramApprovalSchemas = {
  telegramApprovalPrompt: TelegramSendResultSchema,
  telegramApprovalCallback: TelegramCallbackQuerySchema,
};

/**
 * @param {TelegramApprovalRequest} request
 * @returns {string}
 */
function renderPromptText(request) {
  const title = request?.title?.trim() || "Approval needed";
  return request?.summary?.trim() ? `**${title}**\n\n${request.summary.trim()}` : `**${title}**`;
}

/**
 * @param {import("../approval.ts").TelegramApprovalKeyboardSpec} spec
 * @param {string} key
 * @returns {string}
 */
function optionLabel(spec, key) {
  return spec.options?.find((option) => option.key === key)?.label ?? key;
}

/**
 * @param {import("../approval.ts").TelegramApprovalKeyboardSpec} spec
 * @param {any} decision
 * @returns {string} short toast text (<=200 chars)
 */
function ackText(spec, decision) {
  if (spec.mode === "select") {
    return decision.selected ? `Selected: ${optionLabel(spec, decision.selected)}` : "Received";
  }
  return decision.approved ? "Approved ✅" : "Rejected 🚫";
}

/**
 * @param {TelegramApprovalRequest} request
 * @param {import("../approval.ts").TelegramApprovalKeyboardSpec} spec
 * @param {any} decision
 * @param {string | null} by
 * @returns {string} the edited-message body (standard markdown)
 */
function outcomeText(request, spec, decision, by) {
  const title = request?.title?.trim() || "Approval";
  const suffix = by ? ` by ${by}` : "";
  if (spec.mode === "select") {
    const label = decision.selected ? optionLabel(spec, decision.selected) : "no option";
    return `**${title}**\n\n✅ Chose ${label}${suffix}`;
  }
  const verb = decision.approved ? "✅ Approved" : "🚫 Rejected";
  return `**${title}**\n\n${verb}${suffix}`;
}

/**
 * Coerce a forum-topic `threadId` to the numeric `message_thread_id` the Bot API
 * expects. A non-numeric string would otherwise become `NaN` and get sent
 * silently, so reject it up front with `INVALID_INPUT`.
 * @param {number | string | undefined} threadId
 * @returns {number | undefined}
 */
function threadIdAsNumber(threadId) {
  if (threadId == null) {
    return undefined;
  }
  const numeric = Number(threadId);
  if (!Number.isFinite(numeric)) {
    throw new SmithersError(
      "INVALID_INPUT",
      `Telegram.TelegramApproval threadId must be numeric (a forum-topic message_thread_id); received ${JSON.stringify(threadId)}.`,
      { threadId },
    );
  }
  return numeric;
}

/**
 * Acknowledge the press and stamp the outcome onto the prompt (both best-effort
 * so a UI hiccup never fails the approval), then resolve to the decision.
 * @param {Partial<import("../TelegramClient.ts").TelegramClientConfig> | undefined} config
 * @param {number | string} chatId
 * @param {any} callbackQuery
 * @param {import("../approval.ts").TelegramApprovalKeyboardSpec} spec
 * @param {TelegramApprovalRequest} request
 * @param {import("../TelegramClient.ts").SendMessageSmartOptions["parseMode"]} parseMode
 * @param {any} decision
 * @returns {Promise<any>}
 */
function resolveApprovalDecision(config, chatId, callbackQuery, spec, request, parseMode, decision) {
  const client = resolveTelegramClient(config);
  const by = telegramApproverLabel(callbackQuery);
  const messageId = callbackQuery?.message?.message_id;
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* client
        .answerCallbackQuery(callbackQuery.id, { text: ackText(spec, decision) })
        .pipe(Effect.catchAll(() => Effect.void));
      if (typeof messageId === "number") {
        yield* client
          .editMessageSmart(chatId, messageId, outcomeText(request, spec, decision, by), {
            parseMode,
            inlineKeyboard: [],
          })
          .pipe(Effect.catchAll(() => Effect.void));
      }
      return decision;
    }),
  );
}

/**
 * Durable Telegram approval. See the file header for the composition.
 * @param {TelegramApprovalProps} props
 * @returns {React.ReactElement | null}
 */
export function TelegramApproval(props) {
  if (props.skipIf) {
    return null;
  }
  const mode = props.mode ?? "approve";
  /** @type {import("../approval.ts").TelegramApprovalKeyboardSpec} */
  const spec = {
    mode,
    options: props.options,
    approveText: props.approveText,
    rejectText: props.rejectText,
    miniAppUrl: props.miniApp?.url,
    miniAppText: props.miniApp?.text,
  };
  const keyboard = approvalInlineKeyboard(spec);
  const parseMode = props.parseMode ?? "markdown";
  const outputSchema = props.outputSchema ??
    (mode === "select" ? telegramApprovalSelectionSchema : telegramApprovalDecisionSchema);
  const askId = `${props.id}:ask`;
  const waitId = `${props.id}:wait`;

  return React.createElement(
    React.Fragment,
    null,
    React.createElement(SendMessage, {
      id: askId,
      chatId: props.chatId,
      config: props.config,
      output: TelegramSendResultSchema,
      messageThreadId: threadIdAsNumber(props.threadId),
      text: renderPromptText(props.request),
      inlineKeyboard: keyboard,
      parseMode,
      smithersContext: props.smithersContext,
    }),
    React.createElement(OnCallbackQuery, {
      id: waitId,
      chatId: props.chatId,
      threadId: props.threadId,
      dependsOn: [askId],
      timeoutMs: props.timeoutMs,
      onTimeout: props.onTimeout,
      async: props.async,
      smithersContext: props.smithersContext,
      children: (/** @type {any} */ callbackQuery) => {
        const decision = telegramApprovalDecision(callbackQuery, spec);
        return React.createElement(Task, {
          id: props.id,
          output: props.output,
          outputSchema,
          dependsOn: [waitId],
          smithersContext: props.smithersContext,
          children: () =>
            resolveApprovalDecision(props.config, props.chatId, callbackQuery, spec, props.request, parseMode, decision),
        });
      },
    }),
  );
}
