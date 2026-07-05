import { OnCallbackQueryProps as OnCallbackQueryProps$1, OnMessageProps as OnMessageProps$1 } from './OnMessageProps.js';
import * as React from 'react';
import * as zod from 'zod';

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
declare function OnMessage<Schema extends zod.ZodTypeAny>(props: OnMessageProps<Schema>): React.ReactElement<any, string | React.JSXElementConstructor<any>> | null;
/**
 * Durable wait for an inline-keyboard button press (Telegram callback
 * query) in a chat. Children receive the zod-parsed CallbackQuery payload.
 *
 * @template {import("zod").ZodTypeAny} Schema
 * @param {OnCallbackQueryProps<Schema>} props
 */
declare function OnCallbackQuery<Schema extends zod.ZodTypeAny>(props: OnCallbackQueryProps<Schema>): React.ReactElement<any, string | React.JSXElementConstructor<any>> | null;
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
declare function OnWebAppData<Schema extends zod.ZodTypeAny>(props: OnMessageProps<Schema>): React.ReactElement<any, string | React.JSXElementConstructor<any>> | null;
type OnMessageProps<Schema extends zod.ZodTypeAny> = OnMessageProps$1<Schema>;
type OnCallbackQueryProps<Schema extends zod.ZodTypeAny> = OnCallbackQueryProps$1<Schema>;

export { OnCallbackQuery, type OnCallbackQueryProps, OnMessage, type OnMessageProps, OnWebAppData };
