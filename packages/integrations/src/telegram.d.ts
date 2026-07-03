import { Effect, Context, Layer, Schedule } from 'effect';
import { SmithersError } from '@smithers-orchestrator/errors/SmithersError';
import * as zod from 'zod';
import { z } from 'zod';
import { C as CursorStore, a as EventSource, E as ExternalEvent } from './EventSourceTypes-BAOYWyD3.js';
import * as React from 'react';
import React__default from 'react';

/**
 * Configuration for the fetch-based Telegram Bot API client. `apiBaseUrl`
 * exists so tests can point the real client at a fixture server.
 */
type TelegramClientConfig$2 = {
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
type TelegramInlineKeyboardButton$1 = {
    text: string;
    callback_data?: string;
    url?: string;
    web_app?: {
        url: string;
    };
};
/** Rows of inline-keyboard buttons (Telegram `InlineKeyboardMarkup.inline_keyboard`). */
type TelegramInlineKeyboard$1 = TelegramInlineKeyboardButton$1[][];
type SendMessageSmartOptions$1 = {
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
    inlineKeyboard?: TelegramInlineKeyboard$1;
    /** Send a `typing` chat action before the first chunk. @default true */
    typing?: boolean;
    disableNotification?: boolean;
};
type SendMessageSmartResult$1 = {
    chatId: string;
    /** message_id of every sent chunk, in send order. */
    messageIds: number[];
    chunkCount: number;
    /** True when at least one chunk fell back to plain text after a parse 400. */
    usedPlainTextFallback: boolean;
};
type SendDocumentOptions$1 = {
    /** Caption for the document (converted/escaped like sendMessageSmart). */
    caption?: string;
    replyToMessageId?: number;
    messageThreadId?: number;
};
/**
 * A document to upload: either a URL / existing `file_id` string (sent via
 * JSON) or raw bytes uploaded as multipart form data.
 */
type TelegramDocumentInput$1 = string | {
    filename: string;
    content: string | Uint8Array;
    contentType?: string;
};
/** The service behind the `TelegramClient` Context.Tag. */
type TelegramClientService$1 = {
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
    sendMessageSmart: (chatId: number | string, text: string, options?: SendMessageSmartOptions$1) => Effect.Effect<SendMessageSmartResult$1, SmithersError>;
    /** Edit a sent message in place, with the same MarkdownV2 → plain fallback. */
    editMessageSmart: (chatId: number | string, messageId: number, text: string, options?: Pick<SendMessageSmartOptions$1, "parseMode" | "inlineKeyboard">) => Effect.Effect<unknown, SmithersError>;
    /** Send a document (URL/file_id via JSON, raw content via multipart). */
    sendDocument: (chatId: number | string, document: TelegramDocumentInput$1, options?: SendDocumentOptions$1) => Effect.Effect<unknown, SmithersError>;
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

/** One choice an approver can make via an inline button. */
type TelegramApprovalChoice$1 = {
    kind: "approve";
} | {
    kind: "reject";
} | {
    kind: "select";
    key: string;
};
/** An option offered in `mode: "select"`. */
type TelegramApprovalOption$1 = {
    /** Stable key, echoed back as the decision's `selected`. Kept short (callback_data is 64 bytes). */
    key: string;
    /** Button label shown to the approver. */
    label: string;
};
type TelegramApprovalMode$1 = "approve" | "select";
/** Spec for building the approval keyboard and mapping the press to a decision. */
type TelegramApprovalKeyboardSpec$1 = {
    mode: TelegramApprovalMode$1;
    /** Per-approval token that namespaces its buttons (see `approvalToken`). */
    token?: string;
    /** Options for `mode: "select"` (required, non-empty). */
    options?: TelegramApprovalOption$1[];
    /** Approve-button label. @default "✅ Approve" */
    approveText?: string;
    /** Reject-button label. @default "🚫 Reject" */
    rejectText?: string;
    /** When set, adds a Mini App (`web_app`) button opening this HTTPS url. */
    miniAppUrl?: string;
    /** Mini App button label. @default "🔍 Open review" */
    miniAppText?: string;
};
/** Decision shape for `mode: "approve"` (matches the core `approvalDecisionSchema`). */
type TelegramApprovalDecision$1 = {
    approved: boolean;
    note: string | null;
    decidedBy: string | null;
    decidedAt: string | null;
};
/** Decision shape for `mode: "select"` (matches the core `approvalSelectionSchema`). */
type TelegramApprovalSelection$1 = {
    selected: string;
    notes: string | null;
};

/**
 * A short, deterministic, colon-free token that disambiguates one approval's
 * buttons from any other keyboard in the same chat. Derived from the node id
 * (djb2 → base36); NOT security-sensitive, just a namespace so a stale/foreign
 * press on a different prompt cannot resolve this approval.
 * @param {string} id
 * @returns {string}
 */
declare function approvalToken(id: string): string;
/**
 * Encode a choice as callback_data (`sap:<token>:a`, `sap:<token>:d`,
 * `sap:<token>:s:<key>`). The token namespaces the press to one approval.
 * @param {TelegramApprovalChoice} choice
 * @param {string} token
 * @returns {string}
 */
declare function telegramApprovalCallbackData(choice: TelegramApprovalChoice, token: string): string;
/**
 * Decode approval callback_data into `{ token, ...choice }`. Returns null for
 * anything that is not ours (a stray press from an unrelated keyboard).
 * @param {string | undefined | null} data
 * @returns {(TelegramApprovalChoice & { token: string }) | null}
 */
declare function parseTelegramApprovalCallbackData(data: string | undefined | null): (TelegramApprovalChoice & {
    token: string;
}) | null;
/**
 * True when a delivered callback query is a press on THIS approval's own
 * buttons (matching token), not a stale/foreign press in the same chat.
 * @param {{ data?: string }} callbackQuery
 * @param {TelegramApprovalKeyboardSpec} spec
 * @returns {boolean}
 */
declare function isOwnApprovalPress(callbackQuery: {
    data?: string;
}, spec: TelegramApprovalKeyboardSpec): boolean;
/**
 * Build a Mini App (`web_app`) inline-keyboard button. `url` must be HTTPS.
 * @param {string} text
 * @param {string} url
 * @returns {TelegramInlineKeyboardButton}
 */
declare function webAppButton(text: string, url: string): TelegramInlineKeyboardButton;
/**
 * Build the inline keyboard for an approval prompt.
 * @param {TelegramApprovalKeyboardSpec} spec
 * @returns {TelegramInlineKeyboard}
 */
declare function approvalInlineKeyboard(spec: TelegramApprovalKeyboardSpec): TelegramInlineKeyboard;
/**
 * Who pressed the button, as a stable string (`@username` or the numeric id).
 * @param {{ from?: { id?: number | string; username?: string } }} callbackQuery
 * @returns {string | null}
 */
declare function telegramApproverLabel(callbackQuery: {
    from?: {
        id?: number | string;
        username?: string;
    };
}): string | null;
/**
 * Map a delivered callback query to an approval decision. Deterministic from
 * the persisted payload. A press that is not this approval's own (wrong or
 * missing token) or is otherwise unrecognized fails safe: a non-approval
 * (`approved: false`) in approve mode, or an empty selection in select mode. A
 * stale/foreign press can therefore never produce a false approval.
 * @param {{ data?: string; from?: object; message?: { date?: number } }} callbackQuery
 * @param {TelegramApprovalKeyboardSpec} spec
 * @returns {TelegramApprovalDecision | TelegramApprovalSelection}
 */
declare function telegramApprovalDecision(callbackQuery: {
    data?: string;
    from?: object;
    message?: {
        date?: number;
    };
}, spec: TelegramApprovalKeyboardSpec): TelegramApprovalDecision | TelegramApprovalSelection;
/** Decision schema for `mode: "approve"` (mirrors the core approvalDecisionSchema). */
declare const telegramApprovalDecisionSchema: z.ZodObject<{
    approved: z.ZodBoolean;
    note: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    decidedBy: z.ZodNullable<z.ZodString>;
    decidedAt: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
/** Decision schema for `mode: "select"` (mirrors the core approvalSelectionSchema). */
declare const telegramApprovalSelectionSchema: z.ZodObject<{
    selected: z.ZodString;
    notes: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
type TelegramApprovalChoice = TelegramApprovalChoice$1;
type TelegramApprovalOption = TelegramApprovalOption$1;
type TelegramApprovalMode = TelegramApprovalMode$1;
type TelegramApprovalKeyboardSpec = TelegramApprovalKeyboardSpec$1;
type TelegramApprovalDecision = TelegramApprovalDecision$1;
type TelegramApprovalSelection = TelegramApprovalSelection$1;
type TelegramInlineKeyboard = TelegramInlineKeyboard$1;
type TelegramInlineKeyboardButton = TelegramInlineKeyboardButton$1;

/**
 * Split `text` into chunks of at most `maxLength` characters, breaking on
 * paragraph, line, sentence, or word boundaries (in that order of
 * preference) and only cutting mid-word when a single unbroken run exceeds
 * the limit. Chunks are trimmed of the boundary whitespace they were split
 * on; empty chunks are never emitted.
 * @param {string} text
 * @param {number} [maxLength]
 * @returns {string[]}
 */
declare function chunkTelegramText(text: string, maxLength?: number): string[];
/** Telegram's maximum `sendMessage` text length. */
declare const TELEGRAM_MAX_MESSAGE_LENGTH: 4096;

/**
 * Register process-wide Telegram config for outbound components.
 * Pass `null` to clear (tests).
 * @param {TelegramClientConfig | null} config
 */
declare function configureTelegram(config: TelegramClientConfig$1 | null): void;
/**
 * Resolve the effective Telegram config: explicit prop > `configureTelegram`
 * registry > `SMITHERS_TELEGRAM_BOT_TOKEN` env fallback. Throws
 * `INVALID_INPUT` when no bot token can be found — the error message never
 * includes any token material.
 * @param {Partial<TelegramClientConfig> | undefined} [explicit]
 * @returns {TelegramClientConfig}
 */
declare function resolveTelegramConfig(explicit?: Partial<TelegramClientConfig$1> | undefined): TelegramClientConfig$1;
/**
 * Resolve config and build a client from it (outbound component seam).
 * @param {Partial<TelegramClientConfig> | undefined} [explicit]
 */
declare function resolveTelegramClient(explicit?: Partial<TelegramClientConfig$1> | undefined): TelegramClientService$1;
type TelegramClientConfig$1 = TelegramClientConfig$2;

/** A Telegram user as it appears inside initData's `user`/`receiver` JSON. */
type TelegramInitDataUser$1 = {
    id: number;
    is_bot?: boolean;
    first_name?: string;
    last_name?: string;
    username?: string;
    language_code?: string;
    is_premium?: boolean;
    photo_url?: string;
    [key: string]: unknown;
};
/** The parsed contents of a Mini App `initData` query string. */
type TelegramInitData$1 = {
    /** The exact raw query string that was verified. */
    raw: string;
    /** HMAC hash field (present on the standard path). */
    hash: string | null;
    /** Ed25519 signature field (present on newer clients / third-party path). */
    signature: string | null;
    /** `auth_date` as a Unix timestamp in seconds, or null when absent/invalid. */
    authDate: number | null;
    /** `query_id` (present only for inline-keyboard / menu-button launches). */
    queryId: string | null;
    /** Parsed `user` object, or null when absent/unparseable. */
    user: TelegramInitDataUser$1 | null;
    /** Parsed `receiver` object, or null. */
    receiver: TelegramInitDataUser$1 | null;
    /** Parsed `chat` object, or null. */
    chat: Record<string, unknown> | null;
    /** `chat_type` (private/group/supergroup/channel), or null. */
    chatType: string | null;
    /** `chat_instance`, or null. */
    chatInstance: string | null;
    /** `start_param` from a `?startapp=` deep link, or null. */
    startParam: string | null;
    /** Every decoded key/value pair, for fields not surfaced above. */
    params: Record<string, string>;
};
type VerifyTelegramWebAppInitDataOptions$1 = {
    /**
     * Reject `initData` whose `auth_date` is older than this many seconds.
     * `0` disables the freshness check. @default 3600 (one hour)
     */
    maxAgeSeconds?: number;
    /** Override "now" (epoch ms) for deterministic tests. */
    nowMs?: number;
};
type VerifyTelegramWebAppInitDataSignatureOptions$1 = VerifyTelegramWebAppInitDataOptions$1 & {
    /**
     * Ed25519 public key (hex) to verify against. Defaults to Telegram's
     * production key. Pass the test key for the test datacenter.
     */
    publicKeyHex?: string;
};

/**
 * Parse a raw Mini App `initData` query string into its fields. Uses
 * `URLSearchParams` (split-then-decode-each-value-once), which is the robust
 * parse — decoding the whole string first would corrupt values containing
 * percent-encoded delimiters inside the JSON `user`/`chat` blobs.
 * @param {string} initData
 * @returns {TelegramInitData}
 */
declare function parseTelegramInitData(initData: string): TelegramInitData;
/**
 * Verify a Mini App's `initData` with the HMAC path (your server holds the bot
 * token). Resolves to the parsed, trusted fields on success; rejects with a
 * `SmithersError` (`TELEGRAM_INIT_DATA_INVALID`) otherwise. The bot token is
 * never included in the error output.
 *
 * @param {string} initData raw `window.Telegram.WebApp.initData` query string
 * @param {string} botToken bot token from @BotFather
 * @param {VerifyTelegramWebAppInitDataOptions} [options]
 * @returns {Promise<TelegramInitData>}
 */
declare function verifyTelegramWebAppInitData(initData: string, botToken: string, options?: VerifyTelegramWebAppInitDataOptions): Promise<TelegramInitData>;
/**
 * Verify a Mini App's `initData` with the Ed25519 third-party path (you only
 * need the numeric bot id + Telegram's public key, not the bot token). Resolves
 * to the parsed fields on success; rejects otherwise.
 *
 * @param {string} initData raw initData query string (must include `signature`)
 * @param {number | string} botId numeric bot id (the part before `:` in the token)
 * @param {VerifyTelegramWebAppInitDataSignatureOptions} [options]
 * @returns {Promise<TelegramInitData>}
 */
declare function verifyTelegramWebAppInitDataSignature(initData: string, botId: number | string, options?: VerifyTelegramWebAppInitDataSignatureOptions): Promise<TelegramInitData>;
/** Telegram's production Ed25519 public key (hex) for third-party validation. */
declare const TELEGRAM_WEBAPP_ED25519_PUBLIC_KEY_PROD: "e7bf03a2fa4602af4580703d88dda5bb59f32ed8b02a56c187fe7d34caed242d";
/** Telegram's test-datacenter Ed25519 public key (hex). */
declare const TELEGRAM_WEBAPP_ED25519_PUBLIC_KEY_TEST: "40055058a4ee38156a06562e52eece92a771bcd8346a8c4615cb7376eddf72ec";
type TelegramInitData = TelegramInitData$1;
type TelegramInitDataUser = TelegramInitDataUser$1;
type VerifyTelegramWebAppInitDataOptions = VerifyTelegramWebAppInitDataOptions$1;
type VerifyTelegramWebAppInitDataSignatureOptions = VerifyTelegramWebAppInitDataSignatureOptions$1;

/**
 * Escape plain text for Telegram MarkdownV2 (every reserved character gets a
 * leading backslash).
 * @param {string} text
 * @returns {string}
 */
declare function escapeMarkdownV2(text: string): string;
/**
 * Convert standard markdown to Telegram MarkdownV2: fenced/inline code,
 * links, bold (`**` → `*`), strikethrough (`~~` → `~`), italic (`*`/`_` →
 * `_`), and headers (`#...` → bold — unescaped `#` crashes Telegram), with
 * everything else escaped. Uses NUL sentinels to protect already-formatted
 * segments during the final escape pass, then substitutes them back.
 * @param {string} markdown
 * @returns {string}
 */
declare function convertMarkdownToTelegram(markdown: string): string;
/**
 * Strip NUL characters (they collide with the sentinel scheme above and
 * Telegram rejects them anyway).
 * @param {string | undefined | null} text
 * @returns {string}
 */
declare function cleanText(text: string | undefined | null): string;

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

/**
 * Strip the bot token from any string (URLs, error messages, causes) so it
 * can never leak into logs or error output.
 * @param {string} text
 * @param {string} botToken
 * @returns {string}
 */
declare function redactBotToken(text: string, botToken: string): string;
/**
 * @param {unknown} error
 * @returns {error is TelegramApiError}
 */
declare function isTelegramApiError(error: unknown): error is TelegramApiError;
/**
 * Build the Telegram Bot API client service (plain fetch, no telegraf/grammY).
 * @param {TelegramClientConfig} config
 * @returns {TelegramClientService}
 */
declare function makeTelegramClient(config: TelegramClientConfig): TelegramClientService;
/**
 * Live Layer for {@link TelegramClient}.
 * @param {TelegramClientConfig} config
 */
declare function TelegramClientLive(config: TelegramClientConfig): Layer.Layer<TelegramClientService$1, never, never>;
declare const DEFAULT_TELEGRAM_API_BASE_URL: "https://api.telegram.org";
/**
 * Error from the Telegram Bot API. Carries the Bot API `error_code` and
 * `description` plus the parsed `retry_after` for 429s. The bot token is
 * never included (see {@link redactBotToken}).
 */
declare class TelegramApiError extends SmithersError {
    /**
   * @param {string} message
   * @param {{ method: string; errorCode?: number | null; description?: string | null; retryAfterSeconds?: number | null; cause?: unknown }} options
   */
    constructor(message: string, options: {
        method: string;
        errorCode?: number | null;
        description?: string | null;
        retryAfterSeconds?: number | null;
        cause?: unknown;
    });
    /** @type {number | null} */
    errorCode: number | null;
    /** @type {number | null} */
    retryAfterSeconds: number | null;
}
/**
 * `Context.Tag` for the Telegram Bot API client service. Provide it with
 * `TelegramClientLive(config)` or `Layer.succeed(TelegramClient, service)`.
 * @type {Context.Tag<TelegramClientService, TelegramClientService>}
 */
declare const TelegramClient: Context.Tag<TelegramClientService, TelegramClientService>;
type TelegramClientConfig = TelegramClientConfig$2;
type TelegramClientService = TelegramClientService$1;
type SendMessageSmartOptions = SendMessageSmartOptions$1;
type SendMessageSmartResult = SendMessageSmartResult$1;
type SendDocumentOptions = SendDocumentOptions$1;
type TelegramDocumentInput = TelegramDocumentInput$1;

/**
 * Options for `makeTelegramSource`: a getUpdates long-poll EventSource whose
 * offset cursor is persisted through a CursorStore so restarts never
 * re-deliver already-seen updates.
 */
type MakeTelegramSourceOptions$1 = TelegramClientConfig$2 & {
    /** EventSource id (also the cursor key + dedupe scope). @default "telegram" */
    sourceId?: string;
    /** Durable cursor persistence; use `makeDbCursorStore(adapter)`. */
    cursorStore?: CursorStore;
    /**
     * Long-poll `timeout` parameter passed to getUpdates (seconds; the Bot API
     * holds the request open until updates arrive or the timeout fires).
     * @default 25
     */
    pollTimeoutSeconds?: number;
    /** Delay between poll turns (long-polling makes this mostly idle). @default Schedule.spaced("250 millis") */
    schedule?: Schedule.Schedule<unknown>;
    /** getUpdates `allowed_updates`. @default ["message", "edited_message", "callback_query"] */
    allowedUpdates?: string[];
    /**
     * When set, updates from chats not in this list are dropped (the offset
     * still advances so they are acknowledged, not re-polled).
     */
    allowedChatIds?: Array<number | string>;
};

/**
 * Correlation id for a Telegram chat: `chat:<chatId>`.
 * @param {number | string} chatId
 * @returns {string}
 */
declare function telegramChatCorrelationId(chatId: number | string): string;
/**
 * Correlation id for a forum-topic thread: `chat:<chatId>:thread:<threadId>`.
 * @param {number | string} chatId
 * @param {number | string} threadId
 * @returns {string}
 */
declare function telegramThreadCorrelationId(chatId: number | string, threadId: number | string): string;
/**
 * Map one getUpdates Update object to ExternalEvents.
 *
 * Dedupe soundness: `deliverEvents` dedupes on (sourceId, dedupeKey) BEFORE
 * matching runs, and one delivered event carries exactly ONE correlationId.
 * Topical messages therefore emit TWO events — chat-level correlation
 * (`chat:<id>`, dedupeKey `update:<update_id>`) and thread-level correlation
 * (`chat:<id>:thread:<tid>`, dedupeKey `update:<update_id>:thread`) — each
 * deduped independently, so a redelivered update can never double-signal
 * either wait while both chat- and thread-scoped listeners still wake.
 *
 * @param {string} sourceId
 * @param {Record<string, any>} update
 * @param {number} receivedAtMs
 * @returns {import("../core/ExternalEventTypes.ts").ExternalEvent[]}
 */
declare function telegramUpdateToEvents(sourceId: string, update: Record<string, any>, receivedAtMs: number): ExternalEvent[];
/**
 * Build a Telegram EventSource: getUpdates long-polling (Bot API semantics —
 * offset = last update_id + 1, server-side `timeout` hold, `allowed_updates`
 * filter) on top of the core polling source, with the offset persisted via
 * the CursorStore so a restarted process resumes without re-delivering.
 * Non-allowed chats are dropped but still acknowledged (offset advances).
 *
 * @param {MakeTelegramSourceOptions} options
 * @returns {import("../core/EventSourceTypes.ts").EventSource}
 */
declare function makeTelegramSource(options: MakeTelegramSourceOptions): EventSource;
declare const TELEGRAM_SERVICE: "telegram";
declare const TELEGRAM_MESSAGE_EVENT: string;
declare const TELEGRAM_EDITED_MESSAGE_EVENT: string;
declare const TELEGRAM_CALLBACK_QUERY_EVENT: string;
declare const TELEGRAM_WEB_APP_DATA_EVENT: string;
type MakeTelegramSourceOptions = MakeTelegramSourceOptions$1;

/** Props shared by the Telegram listener components. */
type TelegramListenerBaseProps<Schema extends z.ZodTypeAny> = {
    /** Node id (also the output lookup key for render-prop children). */
    id: string;
    /** Only wake for this chat (correlationId `chat:<chatId>`). Omit to match any-correlation waits. */
    chatId?: number | string;
    /** Only wake for this forum-topic thread (correlationId `chat:<chatId>:thread:<threadId>`; requires chatId). */
    threadId?: number | string;
    /** Zod schema override for the delivered payload. */
    schema?: Schema;
    timeoutMs?: number;
    onTimeout?: "fail" | "skip" | "continue";
    /** Do not block unrelated downstream flow while waiting. */
    async?: boolean;
    skipIf?: boolean;
    dependsOn?: string[];
    label?: string;
    meta?: Record<string, unknown>;
    key?: string;
    children?: (data: z.infer<Schema>) => React__default.ReactNode;
    smithersContext?: React__default.Context<unknown>;
};
type OnMessageProps$1<Schema extends z.ZodTypeAny> = TelegramListenerBaseProps<Schema> & {
    /** Listen for edits instead of new messages. */
    edited?: boolean;
};
type OnCallbackQueryProps$1<Schema extends z.ZodTypeAny> = TelegramListenerBaseProps<Schema>;

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

/** Loose deps spec (mirrors Task's DepsSpec: dep key → zod output schema). */
type TelegramDepsSpec = Record<string, z.ZodTypeAny>;
type ResolvedDeps = Record<string, unknown>;
/** Props shared by every outbound Telegram compute-Task component. */
type TelegramOutboundBaseProps = {
    id: string;
    /** Explicit client config; falls back to configureTelegram()/env. */
    config?: Partial<TelegramClientConfig$2>;
    /**
     * Upstream outputs to consume. The component resolves them itself and
     * renders a compute Task gated on them via `dependsOn` (Task's own
     * deps+function-children path would evaluate at render time as a static
     * payload — see Task.js — so it is deliberately not used here).
     */
    deps?: TelegramDepsSpec;
    /** dep key → node id when they differ. */
    needs?: Record<string, string>;
    output?: z.ZodTypeAny;
    outputSchema?: z.ZodTypeAny;
    retryPolicy?: unknown;
    timeoutMs?: number;
    dependsOn?: string[];
    async?: boolean;
    skipIf?: boolean;
    label?: string;
    key?: string;
    smithersContext?: React__default.Context<unknown>;
};
type SendMessageProps$1 = TelegramOutboundBaseProps & {
    chatId: number | string;
    /** Static message text (standard markdown). */
    text?: string;
    /**
     * Build the message from resolved deps: return the text, or an object of
     * `{ text, ...SendMessageSmartOptions }` overrides.
     */
    children?: (deps: ResolvedDeps) => string | ({
        text: string;
    } & SendMessageSmartOptions$1);
    parseMode?: SendMessageSmartOptions$1["parseMode"];
    replyToMessageId?: number;
    messageThreadId?: number;
    inlineKeyboard?: TelegramInlineKeyboard$1;
    /** Show the typing indicator before sending. @default true */
    typing?: boolean;
    disableNotification?: boolean;
};
type EditMessageProps$1 = TelegramOutboundBaseProps & {
    chatId: number | string;
    messageId?: number;
    text?: string;
    children?: (deps: ResolvedDeps) => string | {
        text: string;
        messageId?: number;
        inlineKeyboard?: TelegramInlineKeyboard$1;
    };
    parseMode?: SendMessageSmartOptions$1["parseMode"];
    inlineKeyboard?: TelegramInlineKeyboard$1;
};
type SendDocumentProps$1 = TelegramOutboundBaseProps & {
    chatId: number | string;
    document?: TelegramDocumentInput$1;
    caption?: string;
    replyToMessageId?: number;
    messageThreadId?: number;
    children?: (deps: ResolvedDeps) => {
        document: TelegramDocumentInput$1;
        caption?: string;
    };
};
type AnswerCallbackQueryProps$1 = TelegramOutboundBaseProps & {
    callbackQueryId?: string;
    text?: string;
    showAlert?: boolean;
    children?: (deps: ResolvedDeps) => {
        callbackQueryId: string;
        text?: string;
        showAlert?: boolean;
    };
};

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
declare function SendMessage(props: SendMessageProps): React.ReactElement<any, string | React.JSXElementConstructor<any>> | null;
/**
 * Edit a previously sent message in place (MarkdownV2 with plain-text
 * fallback), as a durable compute Task.
 * @param {EditMessageProps} props
 */
declare function EditMessage(props: EditMessageProps): React.ReactElement<any, string | React.JSXElementConstructor<any>> | null;
/**
 * Send a document (URL/file_id via JSON, raw content via multipart upload)
 * as a durable compute Task.
 * @param {SendDocumentProps} props
 */
declare function SendDocument(props: SendDocumentProps): React.ReactElement<any, string | React.JSXElementConstructor<any>> | null;
/**
 * Answer an inline-keyboard callback query (dismisses the client-side
 * loading state; optionally shows a toast/alert), as a durable compute Task.
 * Pairs with `<OnCallbackQuery>`.
 * @param {AnswerCallbackQueryProps} props
 */
declare function AnswerCallbackQuery(props: AnswerCallbackQueryProps): React.ReactElement<any, string | React.JSXElementConstructor<any>> | null;
/** Output shape produced by `<SendMessage>` (sendMessageSmart's result). */
declare const TelegramSendResultSchema: z.ZodObject<{
    chatId: z.ZodString;
    messageIds: z.ZodArray<z.ZodNumber>;
    chunkCount: z.ZodNumber;
    usedPlainTextFallback: z.ZodBoolean;
}, z.core.$strip>;
type SendMessageProps = SendMessageProps$1;
type EditMessageProps = EditMessageProps$1;
type SendDocumentProps = SendDocumentProps$1;
type AnswerCallbackQueryProps = AnswerCallbackQueryProps$1;

/** The request rendered into the approval prompt. */
type TelegramApprovalRequest$1 = {
    /** Short title / question, e.g. "Deploy to prod?". */
    title: string;
    /** Optional detail shown under the title (standard markdown). */
    summary?: string;
};
type TelegramApprovalProps$1 = {
    /** Node id. The decision output is stored under this id. */
    id: string;
    /** Chat that receives the prompt and whose button press resolves it. */
    chatId: number | string;
    /** Forum-topic thread to scope the prompt + wait to (isolates concurrent approvals). */
    threadId?: number | string;
    /** What is being approved. */
    request: TelegramApprovalRequest$1;
    /** Where to store the decision (a createSmithers output target). */
    output?: z.ZodTypeAny;
    /** Override the decision output schema. Defaults to the approve/select schema. */
    outputSchema?: z.ZodTypeAny;
    /** "approve" (Approve/Reject) or "select" (one button per option). @default "approve" */
    mode?: TelegramApprovalMode$1;
    /** Options for `mode: "select"`. */
    options?: TelegramApprovalOption$1[];
    /** Approve-button label (approve mode). */
    approveText?: string;
    /** Reject-button label (approve mode). */
    rejectText?: string;
    /** Add a Mini App (`web_app`) button opening this HTTPS url for a richer UI. */
    miniApp?: {
        url: string;
        text?: string;
    };
    /** Telegram client config; falls back to configureTelegram()/env. */
    config?: Partial<TelegramClientConfig$2>;
    /** Prompt/outcome message format. @default "markdown" */
    parseMode?: SendMessageSmartOptions$1["parseMode"];
    /** Max wait for the button press before timing out. */
    timeoutMs?: number;
    onTimeout?: "fail" | "skip" | "continue";
    /** Do not block unrelated downstream flow while waiting. */
    async?: boolean;
    skipIf?: boolean;
    dependsOn?: string[];
    key?: string;
    smithersContext?: React__default.Context<unknown>;
};

/**
 * Durable Telegram approval. See the file header for the composition.
 * @param {TelegramApprovalProps} props
 * @returns {React.ReactElement | null}
 */
declare function TelegramApproval(props: TelegramApprovalProps): React__default.ReactElement | null;
declare namespace telegramApprovalSchemas {
    export { TelegramSendResultSchema as telegramApprovalPrompt };
    export { TelegramCallbackQuerySchema as telegramApprovalCallback };
}
type TelegramApprovalProps = TelegramApprovalProps$1;
type TelegramApprovalRequest = TelegramApprovalRequest$1;

export { AnswerCallbackQuery, type AnswerCallbackQueryProps, DEFAULT_TELEGRAM_API_BASE_URL, EditMessage, type EditMessageProps, type MakeTelegramSourceOptions, OnCallbackQuery, type OnCallbackQueryProps, OnMessage, type OnMessageProps, OnWebAppData, SendDocument, type SendDocumentOptions, type SendDocumentProps, SendMessage, type SendMessageProps, type SendMessageSmartOptions, type SendMessageSmartResult, TELEGRAM_CALLBACK_QUERY_EVENT, TELEGRAM_EDITED_MESSAGE_EVENT, TELEGRAM_MAX_MESSAGE_LENGTH, TELEGRAM_MESSAGE_EVENT, TELEGRAM_SERVICE, TELEGRAM_WEBAPP_ED25519_PUBLIC_KEY_PROD, TELEGRAM_WEBAPP_ED25519_PUBLIC_KEY_TEST, TELEGRAM_WEB_APP_DATA_EVENT, TelegramApiError, TelegramApproval, type TelegramApprovalChoice, type TelegramApprovalDecision, type TelegramApprovalKeyboardSpec, type TelegramApprovalMode, type TelegramApprovalOption, type TelegramApprovalProps, type TelegramApprovalRequest, type TelegramApprovalSelection, TelegramCallbackQuerySchema, TelegramChatSchema, TelegramClient, TelegramClientLive, type TelegramClientService, type TelegramDocumentInput, type TelegramInitData, type TelegramInitDataUser, type TelegramInlineKeyboardButton, TelegramMessageSchema, TelegramSendResultSchema, TelegramUserSchema, TelegramWebAppDataMessageSchema, TelegramWebAppDataSchema, type VerifyTelegramWebAppInitDataOptions, type VerifyTelegramWebAppInitDataSignatureOptions, approvalInlineKeyboard, approvalToken, chunkTelegramText, cleanText, configureTelegram, convertMarkdownToTelegram, escapeMarkdownV2, isOwnApprovalPress, isTelegramApiError, makeTelegramClient, makeTelegramSource, parseTelegramApprovalCallbackData, parseTelegramInitData, redactBotToken, resolveTelegramClient, resolveTelegramConfig, telegramApprovalCallbackData, telegramApprovalDecision, telegramApprovalDecisionSchema, telegramApprovalSchemas, telegramApprovalSelectionSchema, telegramApproverLabel, telegramChatCorrelationId, telegramThreadCorrelationId, telegramUpdateToEvents, verifyTelegramWebAppInitData, verifyTelegramWebAppInitDataSignature, webAppButton };
