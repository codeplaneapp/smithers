import { Effect } from 'effect';
import { SmithersError } from '@smithers-orchestrator/errors/SmithersError';

/**
 * Configuration for the fetch-based Telegram Bot API client. `apiBaseUrl`
 * exists so tests can point the real client at a fixture server.
 */
type TelegramClientConfig = {
    /** Bot token from @BotFather. Never logged; stripped from error output. */
    botToken: string;
    /** @default "https://api.telegram.org" */
    apiBaseUrl?: string;
    /** Max automatic retries on 429 rate limits. @default 3 */
    maxRateLimitRetries?: number;
    /** Cap on the server-supplied `retry_after` honored per retry (seconds). @default 30 */
    maxRetryAfterSeconds?: number;
};
/** One button of an inline keyboard (Telegram `InlineKeyboardButton`). */
type TelegramInlineKeyboardButton = {
    text: string;
    callback_data?: string;
    url?: string;
    web_app?: {
        url: string;
    };
};
/** Rows of inline-keyboard buttons (Telegram `InlineKeyboardMarkup.inline_keyboard`). */
type TelegramInlineKeyboard = TelegramInlineKeyboardButton[][];
type SendMessageSmartOptions = {
    /**
     * How to format outgoing text. `"markdown"` (default) converts standard
     * markdown to MarkdownV2 with escaping and falls back to plain text when
     * Telegram rejects the entities; `"MarkdownV2"`/`"HTML"` send the text
     * as-is under that parse mode (still with plain-text fallback); `"none"`
     * sends raw text with no parse mode.
     */
    parseMode?: "markdown" | "MarkdownV2" | "HTML" | "none";
    /** Attached to the FIRST chunk only. */
    replyToMessageId?: number;
    /** Forum-topic thread id, attached to every chunk. */
    messageThreadId?: number;
    /** Inline keyboard attached to the LAST chunk only. */
    inlineKeyboard?: TelegramInlineKeyboard;
    /** Send a `typing` chat action before the first chunk. @default true */
    typing?: boolean;
    disableNotification?: boolean;
};
type SendMessageSmartResult = {
    chatId: string;
    /** message_id of every sent chunk, in send order. */
    messageIds: number[];
    chunkCount: number;
    /** True when at least one chunk fell back to plain text after a parse 400. */
    usedPlainTextFallback: boolean;
};
type SendDocumentOptions = {
    /** Caption for the document (converted/escaped like sendMessageSmart). */
    caption?: string;
    replyToMessageId?: number;
    messageThreadId?: number;
};
/**
 * A document to upload: either a URL / existing `file_id` string (sent via
 * JSON) or raw bytes uploaded as multipart form data.
 */
type TelegramDocumentInput = string | {
    filename: string;
    content: string | Uint8Array;
    contentType?: string;
};
/** The service behind the `TelegramClient` Context.Tag. */
type TelegramClientService = {
    /**
     * Raw Bot API call: POST `<apiBaseUrl>/bot<token>/<method>` with a JSON
     * body, returning the `result` field. Retries 429s honoring
     * `parameters.retry_after`. Fails with a SmithersError (code
     * `TELEGRAM_API_ERROR`) that never contains the bot token.
     */
    call: (method: string, params?: Record<string, unknown>) => Effect.Effect<unknown, SmithersError>;
    /**
     * High-level send: chunks at 4096 chars on paragraph/sentence boundaries,
     * converts markdown → MarkdownV2, falls back to plain text on a 400
     * "can't parse entities", and shows a typing indicator first.
     */
    sendMessageSmart: (chatId: number | string, text: string, options?: SendMessageSmartOptions) => Effect.Effect<SendMessageSmartResult, SmithersError>;
    /** Edit a sent message in place, with the same MarkdownV2 → plain fallback. */
    editMessageSmart: (chatId: number | string, messageId: number, text: string, options?: Pick<SendMessageSmartOptions, "parseMode" | "inlineKeyboard">) => Effect.Effect<unknown, SmithersError>;
    /** Send a document (URL/file_id via JSON, raw content via multipart). */
    sendDocument: (chatId: number | string, document: TelegramDocumentInput, options?: SendDocumentOptions) => Effect.Effect<unknown, SmithersError>;
    /** Answer a callback query (inline-keyboard button press). */
    answerCallbackQuery: (callbackQueryId: string, options?: {
        text?: string;
        showAlert?: boolean;
    }) => Effect.Effect<unknown, SmithersError>;
    /**
     * Answer a Mini App inline query: post the `result` back to the chat on the
     * user's behalf and close the Mini App. `webAppQueryId` is the `query_id`
     * from a Mini App launched by an inline-keyboard `web_app` button. `result`
     * is a Bot API `InlineQueryResult`. Returns the `SentWebAppMessage`.
     */
    answerWebAppQuery: (webAppQueryId: string, result: Record<string, unknown>) => Effect.Effect<unknown, SmithersError>;
};

export type { SendDocumentOptions, SendMessageSmartOptions, SendMessageSmartResult, TelegramClientConfig, TelegramClientService, TelegramDocumentInput, TelegramInlineKeyboard, TelegramInlineKeyboardButton };
