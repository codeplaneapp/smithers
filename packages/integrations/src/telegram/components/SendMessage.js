// @smithers-type-exports-begin
/** @typedef {import("./outboundProps.ts").SendMessageProps} SendMessageProps */
/** @typedef {import("./outboundProps.ts").EditMessageProps} EditMessageProps */
/** @typedef {import("./outboundProps.ts").SendDocumentProps} SendDocumentProps */
/** @typedef {import("./outboundProps.ts").AnswerCallbackQueryProps} AnswerCallbackQueryProps */
// @smithers-type-exports-end

import { z } from "zod";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { renderOutboundTask } from "./outboundInternals.js";

/** Output shape produced by `<SendMessage>` (sendMessageSmart's result). */
export const TelegramSendResultSchema = z.object({
  chatId: z.string(),
  messageIds: z.array(z.number()),
  chunkCount: z.number(),
  usedPlainTextFallback: z.boolean(),
});

/**
 * Normalize a `children(deps)` return value into `{ text, ...overrides }`.
 * @param {unknown} value
 * @param {string} componentName
 * @returns {Record<string, any>}
 */
function normalizeBuilt(value, componentName) {
  if (typeof value === "string") {
    return { text: value };
  }
  if (value && typeof value === "object") {
    return /** @type {Record<string, any>} */ (value);
  }
  throw new SmithersError(
    "INVALID_INPUT",
    `Telegram.${componentName} children must return a string or an options object.`,
    { received: typeof value },
  );
}

/**
 * Send a Telegram message as a durable compute Task: chunks at 4096 chars on
 * paragraph/sentence boundaries, converts markdown → MarkdownV2 with
 * plain-text fallback on parse errors, shows a typing indicator, threads
 * replies (`replyToMessageId`, `messageThreadId`), and attaches an inline
 * keyboard to the last chunk. Text comes from the `text` prop or is built
 * from resolved `deps` by the function children.
 *
 * @param {SendMessageProps} props
 */
export function SendMessage(props) {
  const {
    chatId,
    text,
    children,
    parseMode,
    replyToMessageId,
    messageThreadId,
    inlineKeyboard,
    typing,
    disableNotification,
  } = props;
  return renderOutboundTask(props, "SendMessage", (client, deps) => {
    const built = children ? normalizeBuilt(children(deps), "SendMessage") : { text };
    const finalText = built.text ?? text;
    if (typeof finalText !== "string" || finalText.length === 0) {
      throw new SmithersError(
        "INVALID_INPUT",
        "Telegram.SendMessage requires message text (text prop or children returning it).",
      );
    }
    return client.sendMessageSmart(chatId, finalText, {
      parseMode: built.parseMode ?? parseMode,
      replyToMessageId: built.replyToMessageId ?? replyToMessageId,
      messageThreadId: built.messageThreadId ?? messageThreadId,
      inlineKeyboard: built.inlineKeyboard ?? inlineKeyboard,
      typing: built.typing ?? typing,
      disableNotification: built.disableNotification ?? disableNotification,
    });
  });
}

/**
 * Edit a previously sent message in place (MarkdownV2 with plain-text
 * fallback), as a durable compute Task.
 * @param {EditMessageProps} props
 */
export function EditMessage(props) {
  const { chatId, messageId, text, children, parseMode, inlineKeyboard } = props;
  return renderOutboundTask(props, "EditMessage", (client, deps) => {
    const built = children ? normalizeBuilt(children(deps), "EditMessage") : { text, messageId };
    const finalText = built.text ?? text;
    const finalMessageId = built.messageId ?? messageId;
    if (typeof finalText !== "string" || finalText.length === 0 || typeof finalMessageId !== "number") {
      throw new SmithersError(
        "INVALID_INPUT",
        "Telegram.EditMessage requires text and messageId (props or children returning them).",
      );
    }
    return client.editMessageSmart(chatId, finalMessageId, finalText, {
      parseMode: built.parseMode ?? parseMode,
      inlineKeyboard: built.inlineKeyboard ?? inlineKeyboard,
    });
  });
}

/**
 * Send a document (URL/file_id via JSON, raw content via multipart upload)
 * as a durable compute Task.
 * @param {SendDocumentProps} props
 */
export function SendDocument(props) {
  const { chatId, document, caption, replyToMessageId, messageThreadId, children } = props;
  return renderOutboundTask(props, "SendDocument", (client, deps) => {
    const built = children ? normalizeBuilt(children(deps), "SendDocument") : { document, caption };
    const finalDocument = built.document ?? document;
    if (!finalDocument) {
      throw new SmithersError(
        "INVALID_INPUT",
        "Telegram.SendDocument requires a document (prop or children returning one).",
      );
    }
    return client.sendDocument(chatId, finalDocument, {
      caption: built.caption ?? caption,
      replyToMessageId: built.replyToMessageId ?? replyToMessageId,
      messageThreadId: built.messageThreadId ?? messageThreadId,
    });
  });
}

/**
 * Answer an inline-keyboard callback query (dismisses the client-side
 * loading state; optionally shows a toast/alert), as a durable compute Task.
 * Pairs with `<OnCallbackQuery>`.
 * @param {AnswerCallbackQueryProps} props
 */
export function AnswerCallbackQuery(props) {
  const { callbackQueryId, text, showAlert, children } = props;
  return renderOutboundTask(props, "AnswerCallbackQuery", (client, deps) => {
    const built = children
      ? normalizeBuilt(children(deps), "AnswerCallbackQuery")
      : { callbackQueryId, text, showAlert };
    const finalId = built.callbackQueryId ?? callbackQueryId;
    if (typeof finalId !== "string" || finalId.length === 0) {
      throw new SmithersError(
        "INVALID_INPUT",
        "Telegram.AnswerCallbackQuery requires callbackQueryId (prop or children returning it).",
      );
    }
    return client.answerCallbackQuery(finalId, {
      text: built.text ?? text,
      showAlert: built.showAlert ?? showAlert,
    });
  });
}
