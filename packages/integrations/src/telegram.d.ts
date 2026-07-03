// Public type surface for `@smithers-orchestrator/integrations/telegram`.
//
// The bulk of this file is emitted by `tsup --dts-only` from the `src/telegram.js`
// barrel. tsup/rollup-dts drops the runtime *values* of the modules that have a
// types-only `.ts` companion (approval.ts / initData.ts / TelegramClient.ts /
// TelegramSource.ts shadow their `.js` value modules under TS `.js`->`.ts`
// resolution), so those value declarations are curated by hand in the block at
// the end of this file. Keep that block in sync with the barrel's `.js` sources.
import { Effect, Schedule } from 'effect';
import type { Context, Layer } from 'effect';
import type { ExternalEvent as CoreExternalEvent } from './core/ExternalEvent.js';
import type { EventSource as CoreEventSource } from './core/EventSource.js';
import { SmithersError } from '@smithers-orchestrator/errors/SmithersError';
import * as zod from 'zod';
import { z } from 'zod';
import * as react from 'react';
import react__default from 'react';

/**
 * Configuration for the fetch-based Telegram Bot API client. `apiBaseUrl`
 * exists so tests can point the real client at a fixture server.
 */
type TelegramClientConfig$1 = {
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

/** One choice an approver can make via an inline button. */
type TelegramApprovalChoice = {
    kind: "approve";
} | {
    kind: "reject";
} | {
    kind: "select";
    key: string;
};
/** An option offered in `mode: "select"`. */
type TelegramApprovalOption = {
    /** Stable key, echoed back as the decision's `selected`. Kept short (callback_data is 64 bytes). */
    key: string;
    /** Button label shown to the approver. */
    label: string;
};
type TelegramApprovalMode = "approve" | "select";
/** Spec for building the approval keyboard and mapping the press to a decision. */
type TelegramApprovalKeyboardSpec = {
    mode: TelegramApprovalMode;
    /** Options for `mode: "select"` (required, non-empty). */
    options?: TelegramApprovalOption[];
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
type TelegramApprovalDecision = {
    approved: boolean;
    note: string | null;
    decidedBy: string | null;
    decidedAt: string | null;
};
/** Decision shape for `mode: "select"` (matches the core `approvalSelectionSchema`). */
type TelegramApprovalSelection = {
    selected: string;
    notes: string | null;
};

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
declare function configureTelegram(config: TelegramClientConfig | null): void;
/**
 * Resolve the effective Telegram config: explicit prop > `configureTelegram`
 * registry > `SMITHERS_TELEGRAM_BOT_TOKEN` env fallback. Throws
 * `INVALID_INPUT` when no bot token can be found — the error message never
 * includes any token material.
 * @param {Partial<TelegramClientConfig> | undefined} [explicit]
 * @returns {TelegramClientConfig}
 */
declare function resolveTelegramConfig(explicit?: Partial<TelegramClientConfig> | undefined): TelegramClientConfig;
/**
 * Resolve config and build a client from it (outbound component seam).
 * @param {Partial<TelegramClientConfig> | undefined} [explicit]
 */
declare function resolveTelegramClient(explicit?: Partial<TelegramClientConfig> | undefined): any;
type TelegramClientConfig = TelegramClientConfig$1;

/** A Telegram user as it appears inside initData's `user`/`receiver` JSON. */
type TelegramInitDataUser = {
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
type TelegramInitData = {
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
    user: TelegramInitDataUser | null;
    /** Parsed `receiver` object, or null. */
    receiver: TelegramInitDataUser | null;
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
type VerifyTelegramWebAppInitDataOptions = {
    /**
     * Reject `initData` whose `auth_date` is older than this many seconds.
     * `0` disables the freshness check. @default 3600 (one hour)
     */
    maxAgeSeconds?: number;
    /** Override "now" (epoch ms) for deterministic tests. */
    nowMs?: number;
};
type VerifyTelegramWebAppInitDataSignatureOptions = VerifyTelegramWebAppInitDataOptions & {
    /**
     * Ed25519 public key (hex) to verify against. Defaults to Telegram's
     * production key. Pass the test key for the test datacenter.
     */
    publicKeyHex?: string;
};

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
 * Durable persistence seam for polling-source cursors. The db-backed
 * implementation (`makeDbCursorStore`) rides `_smithers_integration_cursors`.
 */
type CursorStore = {
    get: (sourceId: string) => Effect.Effect<string | null | undefined, SmithersError>;
    set: (sourceId: string, cursor: string | null) => Effect.Effect<void, SmithersError>;
};

/**
 * Options for `makeTelegramSource`: a getUpdates long-poll EventSource whose
 * offset cursor is persisted through a CursorStore so restarts never
 * re-deliver already-seen updates.
 */
type MakeTelegramSourceOptions = TelegramClientConfig$1 & {
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
    children?: (data: z.infer<Schema>) => react__default.ReactNode;
    smithersContext?: react__default.Context<unknown>;
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
declare function OnMessage<Schema extends zod.ZodTypeAny>(props: OnMessageProps<Schema>): react.ReactElement<any, string | react.JSXElementConstructor<any>> | null;
/**
 * Durable wait for an inline-keyboard button press (Telegram callback
 * query) in a chat. Children receive the zod-parsed CallbackQuery payload.
 *
 * @template {import("zod").ZodTypeAny} Schema
 * @param {OnCallbackQueryProps<Schema>} props
 */
declare function OnCallbackQuery<Schema extends zod.ZodTypeAny>(props: OnCallbackQueryProps<Schema>): react.ReactElement<any, string | react.JSXElementConstructor<any>> | null;
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
declare function OnWebAppData<Schema extends zod.ZodTypeAny>(props: OnMessageProps<Schema>): react.ReactElement<any, string | react.JSXElementConstructor<any>> | null;
type OnMessageProps<Schema extends zod.ZodTypeAny> = OnMessageProps$1<Schema>;
type OnCallbackQueryProps<Schema extends zod.ZodTypeAny> = OnCallbackQueryProps$1<Schema>;

/** Loose deps spec (mirrors Task's DepsSpec: dep key → zod output schema). */
type TelegramDepsSpec = Record<string, z.ZodTypeAny>;
type ResolvedDeps = Record<string, unknown>;
/** Props shared by every outbound Telegram compute-Task component. */
type TelegramOutboundBaseProps = {
    id: string;
    /** Explicit client config; falls back to configureTelegram()/env. */
    config?: Partial<TelegramClientConfig$1>;
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
    smithersContext?: react__default.Context<unknown>;
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
    } & SendMessageSmartOptions);
    parseMode?: SendMessageSmartOptions["parseMode"];
    replyToMessageId?: number;
    messageThreadId?: number;
    inlineKeyboard?: TelegramInlineKeyboard;
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
        inlineKeyboard?: TelegramInlineKeyboard;
    };
    parseMode?: SendMessageSmartOptions["parseMode"];
    inlineKeyboard?: TelegramInlineKeyboard;
};
type SendDocumentProps$1 = TelegramOutboundBaseProps & {
    chatId: number | string;
    document?: TelegramDocumentInput;
    caption?: string;
    replyToMessageId?: number;
    messageThreadId?: number;
    children?: (deps: ResolvedDeps) => {
        document: TelegramDocumentInput;
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
declare function SendMessage(props: SendMessageProps): react.ReactElement<any, string | react.JSXElementConstructor<any>> | null;
/**
 * Edit a previously sent message in place (MarkdownV2 with plain-text
 * fallback), as a durable compute Task.
 * @param {EditMessageProps} props
 */
declare function EditMessage(props: EditMessageProps): react.ReactElement<any, string | react.JSXElementConstructor<any>> | null;
/**
 * Send a document (URL/file_id via JSON, raw content via multipart upload)
 * as a durable compute Task.
 * @param {SendDocumentProps} props
 */
declare function SendDocument(props: SendDocumentProps): react.ReactElement<any, string | react.JSXElementConstructor<any>> | null;
/**
 * Answer an inline-keyboard callback query (dismisses the client-side
 * loading state; optionally shows a toast/alert), as a durable compute Task.
 * Pairs with `<OnCallbackQuery>`.
 * @param {AnswerCallbackQueryProps} props
 */
declare function AnswerCallbackQuery(props: AnswerCallbackQueryProps): react.ReactElement<any, string | react.JSXElementConstructor<any>> | null;
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
    mode?: TelegramApprovalMode;
    /** Options for `mode: "select"`. */
    options?: TelegramApprovalOption[];
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
    config?: Partial<TelegramClientConfig$1>;
    /** Prompt/outcome message format. @default "markdown" */
    parseMode?: SendMessageSmartOptions["parseMode"];
    /** Max wait for the button press before timing out. */
    timeoutMs?: number;
    onTimeout?: "fail" | "skip" | "continue";
    /** Do not block unrelated downstream flow while waiting. */
    async?: boolean;
    skipIf?: boolean;
    dependsOn?: string[];
    key?: string;
    smithersContext?: react__default.Context<unknown>;
};

/**
 * Durable Telegram approval. See the file header for the composition.
 * @param {TelegramApprovalProps} props
 * @returns {React.ReactElement | null}
 */
declare function TelegramApproval(props: TelegramApprovalProps): react__default.ReactElement | null;
declare namespace telegramApprovalSchemas {
    export { TelegramSendResultSchema as telegramApprovalPrompt };
    export { TelegramCallbackQuerySchema as telegramApprovalCallback };
}
type TelegramApprovalProps = TelegramApprovalProps$1;
type TelegramApprovalRequest = TelegramApprovalRequest$1;

export { AnswerCallbackQuery, type AnswerCallbackQueryProps, EditMessage, type EditMessageProps, type MakeTelegramSourceOptions, OnCallbackQuery, type OnCallbackQueryProps, OnMessage, type OnMessageProps, OnWebAppData, SendDocument, type SendDocumentOptions, type SendDocumentProps, SendMessage, type SendMessageProps, type SendMessageSmartOptions, type SendMessageSmartResult, TELEGRAM_MAX_MESSAGE_LENGTH, TelegramApproval, type TelegramApprovalChoice, type TelegramApprovalDecision, type TelegramApprovalKeyboardSpec, type TelegramApprovalMode, type TelegramApprovalOption, type TelegramApprovalProps, type TelegramApprovalRequest, type TelegramApprovalSelection, TelegramCallbackQuerySchema, TelegramChatSchema, type TelegramClientService, type TelegramDocumentInput, type TelegramInitData, type TelegramInitDataUser, type TelegramInlineKeyboard, type TelegramInlineKeyboardButton, TelegramMessageSchema, TelegramSendResultSchema, TelegramUserSchema, TelegramWebAppDataMessageSchema, TelegramWebAppDataSchema, type VerifyTelegramWebAppInitDataOptions, type VerifyTelegramWebAppInitDataSignatureOptions, chunkTelegramText, cleanText, configureTelegram, convertMarkdownToTelegram, escapeMarkdownV2, resolveTelegramClient, resolveTelegramConfig, telegramApprovalSchemas };

// ---------------------------------------------------------------------------
// Curated value declarations (see the header). These runtime exports are
// dropped by tsup because their `.js` modules are shadowed by types-only `.ts`
// companions. Types reference the aliases already inlined above.
// ---------------------------------------------------------------------------

// src/telegram/approval.js
declare const telegramApprovalDecisionSchema: z.ZodType<TelegramApprovalDecision>;
declare const telegramApprovalSelectionSchema: z.ZodType<TelegramApprovalSelection>;
declare function telegramApprovalCallbackData(choice: TelegramApprovalChoice): string;
declare function parseTelegramApprovalCallbackData(data: string | undefined | null): TelegramApprovalChoice | null;
declare function webAppButton(text: string, url: string): TelegramInlineKeyboardButton;
declare function approvalInlineKeyboard(spec: TelegramApprovalKeyboardSpec): TelegramInlineKeyboard;
declare function telegramApproverLabel(callbackQuery: { from?: { id?: number | string; username?: string } }): string | null;
declare function telegramApprovalDecision(callbackQuery: { data?: string; from?: object; message?: { date?: number } }, spec: TelegramApprovalKeyboardSpec): TelegramApprovalDecision | TelegramApprovalSelection;

// src/telegram/initData.js
declare const TELEGRAM_WEBAPP_ED25519_PUBLIC_KEY_PROD: string;
declare const TELEGRAM_WEBAPP_ED25519_PUBLIC_KEY_TEST: string;
declare function parseTelegramInitData(initData: string): TelegramInitData;
declare function verifyTelegramWebAppInitData(initData: string, botToken: string, options?: VerifyTelegramWebAppInitDataOptions): Promise<TelegramInitData>;
declare function verifyTelegramWebAppInitDataSignature(initData: string, botId: number | string, options?: VerifyTelegramWebAppInitDataSignatureOptions): Promise<TelegramInitData>;

// src/telegram/TelegramClient.js
declare const DEFAULT_TELEGRAM_API_BASE_URL: string;
declare class TelegramApiError extends SmithersError {
    errorCode: number | null;
    retryAfterSeconds: number | null;
    constructor(message: string, options: { method: string; errorCode?: number | null; description?: string | null; retryAfterSeconds?: number | null; cause?: unknown });
}
declare function redactBotToken(text: string, botToken: string): string;
declare function isTelegramApiError(error: unknown): error is TelegramApiError;
declare const TelegramClient: Context.Tag<TelegramClientService, TelegramClientService>;
declare function makeTelegramClient(config: TelegramClientConfig): TelegramClientService;
declare function TelegramClientLive(config: TelegramClientConfig): Layer.Layer<TelegramClientService>;

// src/telegram/TelegramSource.js
declare const TELEGRAM_SERVICE: "telegram";
declare const TELEGRAM_MESSAGE_EVENT: string;
declare const TELEGRAM_EDITED_MESSAGE_EVENT: string;
declare const TELEGRAM_CALLBACK_QUERY_EVENT: string;
declare const TELEGRAM_WEB_APP_DATA_EVENT: string;
declare function telegramChatCorrelationId(chatId: number | string): string;
declare function telegramThreadCorrelationId(chatId: number | string, threadId: number | string): string;
declare function telegramUpdateToEvents(sourceId: string, update: Record<string, any>, receivedAtMs: number): CoreExternalEvent[];
declare function makeTelegramSource(options: MakeTelegramSourceOptions): CoreEventSource;

export {
    DEFAULT_TELEGRAM_API_BASE_URL,
    TELEGRAM_CALLBACK_QUERY_EVENT,
    TELEGRAM_EDITED_MESSAGE_EVENT,
    TELEGRAM_MESSAGE_EVENT,
    TELEGRAM_SERVICE,
    TELEGRAM_WEBAPP_ED25519_PUBLIC_KEY_PROD,
    TELEGRAM_WEBAPP_ED25519_PUBLIC_KEY_TEST,
    TELEGRAM_WEB_APP_DATA_EVENT,
    TelegramApiError,
    TelegramClient,
    TelegramClientLive,
    approvalInlineKeyboard,
    isTelegramApiError,
    makeTelegramClient,
    makeTelegramSource,
    parseTelegramApprovalCallbackData,
    parseTelegramInitData,
    redactBotToken,
    telegramApprovalCallbackData,
    telegramApprovalDecision,
    telegramApprovalDecisionSchema,
    telegramApprovalSelectionSchema,
    telegramApproverLabel,
    telegramChatCorrelationId,
    telegramThreadCorrelationId,
    telegramUpdateToEvents,
    verifyTelegramWebAppInitData,
    verifyTelegramWebAppInitDataSignature,
    webAppButton,
};
