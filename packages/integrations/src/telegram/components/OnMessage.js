// @smithers-type-exports-begin
/**
 * @template {import("zod").ZodTypeAny} Schema
 * @typedef {import("./OnMessageProps.ts").OnMessageProps<Schema>} OnMessageProps
 */
/**
 * @template {import("zod").ZodTypeAny} Schema
 * @typedef {import("./OnMessageProps.ts").OnCallbackQueryProps<Schema>} OnCallbackQueryProps
 */
// @smithers-type-exports-end

import { TelegramCallbackQuerySchema, TelegramMessageSchema, TelegramWebAppDataMessageSchema } from "../schemas.js";
import {
  TELEGRAM_CALLBACK_QUERY_EVENT,
  TELEGRAM_EDITED_MESSAGE_EVENT,
  TELEGRAM_MESSAGE_EVENT,
  TELEGRAM_WEB_APP_DATA_EVENT,
} from "../TelegramSource.js";
import { renderTelegramListener } from "./listenerInternals.js";

/**
 * Durable wait for the next Telegram message in a chat (or forum-topic
 * thread). Renders the `smithers:wait-for-event` intrinsic on
 * `integration:telegram:message` (`integration:telegram:edited_message` with
 * `edited`); the render-prop children receive the zod-parsed Message payload
 * once `makeTelegramSource` delivers it.
 *
 * @template {import("zod").ZodTypeAny} Schema
 * @param {OnMessageProps<Schema>} props
 */
export function OnMessage(props) {
  const eventName = props.edited ? TELEGRAM_EDITED_MESSAGE_EVENT : TELEGRAM_MESSAGE_EVENT;
  return renderTelegramListener(eventName, props, props.schema ?? TelegramMessageSchema);
}

/**
 * Durable wait for an inline-keyboard button press (Telegram callback
 * query) in a chat. Children receive the zod-parsed CallbackQuery payload.
 *
 * @template {import("zod").ZodTypeAny} Schema
 * @param {OnCallbackQueryProps<Schema>} props
 */
export function OnCallbackQuery(props) {
  return renderTelegramListener(TELEGRAM_CALLBACK_QUERY_EVENT, props, props.schema ?? TelegramCallbackQuerySchema);
}

/**
 * Durable wait for structured data from a reply-keyboard Mini App
 * (`Telegram.WebApp.sendData`), which arrives as a message carrying a
 * `web_app_data` field. Renders `smithers:wait-for-event` on
 * `integration:telegram:web_app_data`; children receive the zod-parsed Message,
 * whose `web_app_data.data` holds the payload the Mini App sent.
 *
 * @template {import("zod").ZodTypeAny} Schema
 * @param {OnMessageProps<Schema>} props
 */
export function OnWebAppData(props) {
  return renderTelegramListener(TELEGRAM_WEB_APP_DATA_EVENT, props, props.schema ?? TelegramWebAppDataMessageSchema);
}
