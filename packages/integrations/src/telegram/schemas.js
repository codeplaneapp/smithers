// Zod schemas for the payloads Telegram listener components deliver.
// All object schemas are `.passthrough()` so extra Bot API fields flow
// through untouched; components accept a `schema` override prop.

import { z } from "zod";

export const TelegramChatSchema = z
    .object({
    id: z.number(),
    type: z.string().optional(),
    title: z.string().optional(),
    username: z.string().optional(),
})
    .passthrough();

export const TelegramUserSchema = z
    .object({
    id: z.number(),
    is_bot: z.boolean().optional(),
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    username: z.string().optional(),
})
    .passthrough();

/**
 * Payload delivered for `integration:telegram:message` (and
 * `integration:telegram:edited_message`): the Bot API Message object.
 */
export const TelegramMessageSchema = z
    .object({
    message_id: z.number(),
    date: z.number(),
    chat: TelegramChatSchema,
    from: TelegramUserSchema.optional(),
    text: z.string().optional(),
    caption: z.string().optional(),
    message_thread_id: z.number().optional(),
    is_topic_message: z.boolean().optional(),
    reply_to_message: z.object({ message_id: z.number() }).passthrough().optional(),
    photo: z.array(z.object({ file_id: z.string() }).passthrough()).optional(),
    document: z
        .object({ file_id: z.string(), file_name: z.string().optional() })
        .passthrough()
        .optional(),
})
    .passthrough();

/** Payload delivered for `integration:telegram:callback_query`. */
export const TelegramCallbackQuerySchema = z
    .object({
    id: z.string(),
    from: TelegramUserSchema,
    data: z.string().optional(),
    message: TelegramMessageSchema.optional(),
})
    .passthrough();

/** The `web_app_data` field of a message from a reply-keyboard Mini App's `sendData`. */
export const TelegramWebAppDataSchema = z
    .object({
    data: z.string(),
    button_text: z.string().optional(),
})
    .passthrough();

/**
 * Payload delivered for `integration:telegram:web_app_data`: the Message that
 * carries the `web_app_data` field (untrusted `data`, but the sender is
 * Telegram-guaranteed).
 */
export const TelegramWebAppDataMessageSchema = TelegramMessageSchema.extend({
    web_app_data: TelegramWebAppDataSchema.optional(),
});
