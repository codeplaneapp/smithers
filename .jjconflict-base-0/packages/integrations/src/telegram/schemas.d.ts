import { z } from 'zod';

declare const TelegramChatSchema: z.ZodObject<{
    id: z.ZodNumber;
    type: z.ZodOptional<z.ZodString>;
    title: z.ZodOptional<z.ZodString>;
    username: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
declare const TelegramUserSchema: z.ZodObject<{
    id: z.ZodNumber;
    is_bot: z.ZodOptional<z.ZodBoolean>;
    first_name: z.ZodOptional<z.ZodString>;
    last_name: z.ZodOptional<z.ZodString>;
    username: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
/**
 * Payload delivered for `integration:telegram:message` (and
 * `integration:telegram:edited_message`): the Bot API Message object.
 */
declare const TelegramMessageSchema: z.ZodObject<{
    message_id: z.ZodNumber;
    date: z.ZodNumber;
    chat: z.ZodObject<{
        id: z.ZodNumber;
        type: z.ZodOptional<z.ZodString>;
        title: z.ZodOptional<z.ZodString>;
        username: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>;
    from: z.ZodOptional<z.ZodObject<{
        id: z.ZodNumber;
        is_bot: z.ZodOptional<z.ZodBoolean>;
        first_name: z.ZodOptional<z.ZodString>;
        last_name: z.ZodOptional<z.ZodString>;
        username: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>>;
    text: z.ZodOptional<z.ZodString>;
    caption: z.ZodOptional<z.ZodString>;
    message_thread_id: z.ZodOptional<z.ZodNumber>;
    is_topic_message: z.ZodOptional<z.ZodBoolean>;
    reply_to_message: z.ZodOptional<z.ZodObject<{
        message_id: z.ZodNumber;
    }, z.core.$loose>>;
    photo: z.ZodOptional<z.ZodArray<z.ZodObject<{
        file_id: z.ZodString;
    }, z.core.$loose>>>;
    document: z.ZodOptional<z.ZodObject<{
        file_id: z.ZodString;
        file_name: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>>;
}, z.core.$loose>;
/** Payload delivered for `integration:telegram:callback_query`. */
declare const TelegramCallbackQuerySchema: z.ZodObject<{
    id: z.ZodString;
    from: z.ZodObject<{
        id: z.ZodNumber;
        is_bot: z.ZodOptional<z.ZodBoolean>;
        first_name: z.ZodOptional<z.ZodString>;
        last_name: z.ZodOptional<z.ZodString>;
        username: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>;
    data: z.ZodOptional<z.ZodString>;
    message: z.ZodOptional<z.ZodObject<{
        message_id: z.ZodNumber;
        date: z.ZodNumber;
        chat: z.ZodObject<{
            id: z.ZodNumber;
            type: z.ZodOptional<z.ZodString>;
            title: z.ZodOptional<z.ZodString>;
            username: z.ZodOptional<z.ZodString>;
        }, z.core.$loose>;
        from: z.ZodOptional<z.ZodObject<{
            id: z.ZodNumber;
            is_bot: z.ZodOptional<z.ZodBoolean>;
            first_name: z.ZodOptional<z.ZodString>;
            last_name: z.ZodOptional<z.ZodString>;
            username: z.ZodOptional<z.ZodString>;
        }, z.core.$loose>>;
        text: z.ZodOptional<z.ZodString>;
        caption: z.ZodOptional<z.ZodString>;
        message_thread_id: z.ZodOptional<z.ZodNumber>;
        is_topic_message: z.ZodOptional<z.ZodBoolean>;
        reply_to_message: z.ZodOptional<z.ZodObject<{
            message_id: z.ZodNumber;
        }, z.core.$loose>>;
        photo: z.ZodOptional<z.ZodArray<z.ZodObject<{
            file_id: z.ZodString;
        }, z.core.$loose>>>;
        document: z.ZodOptional<z.ZodObject<{
            file_id: z.ZodString;
            file_name: z.ZodOptional<z.ZodString>;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
}, z.core.$loose>;
/** The `web_app_data` field of a message from a reply-keyboard Mini App's `sendData`. */
declare const TelegramWebAppDataSchema: z.ZodObject<{
    data: z.ZodString;
    button_text: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
/**
 * Payload delivered for `integration:telegram:web_app_data`: the Message that
 * carries the `web_app_data` field (untrusted `data`, but the sender is
 * Telegram-guaranteed).
 */
declare const TelegramWebAppDataMessageSchema: z.ZodObject<{
    message_id: z.ZodNumber;
    date: z.ZodNumber;
    chat: z.ZodObject<{
        id: z.ZodNumber;
        type: z.ZodOptional<z.ZodString>;
        title: z.ZodOptional<z.ZodString>;
        username: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>;
    from: z.ZodOptional<z.ZodObject<{
        id: z.ZodNumber;
        is_bot: z.ZodOptional<z.ZodBoolean>;
        first_name: z.ZodOptional<z.ZodString>;
        last_name: z.ZodOptional<z.ZodString>;
        username: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>>;
    text: z.ZodOptional<z.ZodString>;
    caption: z.ZodOptional<z.ZodString>;
    message_thread_id: z.ZodOptional<z.ZodNumber>;
    is_topic_message: z.ZodOptional<z.ZodBoolean>;
    reply_to_message: z.ZodOptional<z.ZodObject<{
        message_id: z.ZodNumber;
    }, z.core.$loose>>;
    photo: z.ZodOptional<z.ZodArray<z.ZodObject<{
        file_id: z.ZodString;
    }, z.core.$loose>>>;
    document: z.ZodOptional<z.ZodObject<{
        file_id: z.ZodString;
        file_name: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>>;
    web_app_data: z.ZodOptional<z.ZodObject<{
        data: z.ZodString;
        button_text: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>>;
}, z.core.$loose>;

export { TelegramCallbackQuerySchema, TelegramChatSchema, TelegramMessageSchema, TelegramUserSchema, TelegramWebAppDataMessageSchema, TelegramWebAppDataSchema };
