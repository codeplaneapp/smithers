// @smithers-type-exports-begin
/** @typedef {import("./TelegramClientTypes.ts").TelegramClientConfig} TelegramClientConfig */
/** @typedef {import("./TelegramClientTypes.ts").TelegramClientService} TelegramClientService */
/** @typedef {import("./TelegramClientTypes.ts").SendMessageSmartOptions} SendMessageSmartOptions */
/** @typedef {import("./TelegramClientTypes.ts").SendMessageSmartResult} SendMessageSmartResult */
/** @typedef {import("./TelegramClientTypes.ts").SendDocumentOptions} SendDocumentOptions */
/** @typedef {import("./TelegramClientTypes.ts").TelegramDocumentInput} TelegramDocumentInput */
/** @typedef {import("./TelegramClientTypes.ts").TelegramInlineKeyboard} TelegramInlineKeyboard */
// @smithers-type-exports-end

import { Context, Effect, Layer, Schedule } from "effect";
import { SmithersError } from "@smthrs/errors/SmithersError";
import { logWarning } from "@smthrs/observability/logging";
import { chunkTelegramText } from "./chunk.js";
import { cleanText, convertMarkdownToTelegram } from "./markdown.js";

export const DEFAULT_TELEGRAM_API_BASE_URL = "https://api.telegram.org";
const DEFAULT_MAX_RATE_LIMIT_RETRIES = 3;
const DEFAULT_MAX_RETRY_AFTER_SECONDS = 30;

/**
 * Error from the Telegram Bot API. Carries the Bot API `error_code` and
 * `description` plus the parsed `retry_after` for 429s. The bot token is
 * never included (see {@link redactBotToken}).
 */
export class TelegramApiError extends SmithersError {
  /** @type {number | null} */
  errorCode;
  /** @type {number | null} */
  retryAfterSeconds;
  /**
   * @param {string} message
   * @param {{ method: string; errorCode?: number | null; description?: string | null; retryAfterSeconds?: number | null; cause?: unknown }} options
   */
  constructor(message, options) {
    super(
      "TELEGRAM_API_ERROR",
      message,
      {
        method: options.method,
        errorCode: options.errorCode ?? null,
        description: options.description ?? null,
        retryAfterSeconds: options.retryAfterSeconds ?? null,
      },
      { cause: options.cause, name: "TelegramApiError" },
    );
    this.errorCode = options.errorCode ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }
}

/**
 * Strip the bot token from any string (URLs, error messages, causes) so it
 * can never leak into logs or error output.
 * @param {string} text
 * @param {string} botToken
 * @returns {string}
 */
export function redactBotToken(text, botToken) {
  if (!botToken) {
    return text;
  }
  return text
    .split(botToken)
    .join("<redacted>")
    .replace(/\/bot\d+:[A-Za-z0-9_-]+/g, "/bot<redacted>");
}

/**
 * @param {unknown} error
 * @returns {error is TelegramApiError}
 */
export function isTelegramApiError(error) {
  return error instanceof TelegramApiError || (error instanceof Error && error.name === "TelegramApiError");
}

/**
 * Forward an Effect interruption signal into the per-request controller so
 * interrupting the fiber during either the request or the response-body read
 * aborts the whole HTTP exchange.
 * @param {AbortSignal} signal Effect's interruption signal for one step
 * @param {AbortController} controller shared controller for the exchange
 */
function linkInterruptSignal(signal, controller) {
  if (signal.aborted) {
    controller.abort(signal.reason);
    return;
  }
  signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
}

/**
 * True for a 400 the Bot API raises when it cannot parse formatted entities
 * (or the message is too long) — the cue to retry as plain text.
 * @param {unknown} error
 * @returns {boolean}
 */
function isParseEntityError(error) {
  if (!isTelegramApiError(error) || error.errorCode !== 400) {
    return false;
  }
  const description = String(error.details?.description ?? "");
  return /parse|entit|too long/i.test(description);
}

/**
 * `Context.Tag` for the Telegram Bot API client service. Provide it with
 * `TelegramClientLive(config)` or `Layer.succeed(TelegramClient, service)`.
 * @type {Context.Service<TelegramClientService, TelegramClientService>}
 */
export const TelegramClient = /** @type {Context.Service<TelegramClientService, TelegramClientService>} */ (
  Context.Service("@smthrs/integrations/TelegramClient")
);

/**
 * Build the Telegram Bot API client service (plain fetch, no telegraf/grammY).
 * @param {TelegramClientConfig} config
 * @returns {TelegramClientService}
 */
export function makeTelegramClient(config) {
  const botToken = config.botToken;
  if (!botToken || typeof botToken !== "string") {
    throw new SmithersError(
      "INVALID_INPUT",
      "Telegram client requires a bot token (config.botToken or SMITHERS_TELEGRAM_BOT_TOKEN).",
    );
  }
  const apiBaseUrl = (config.apiBaseUrl ?? DEFAULT_TELEGRAM_API_BASE_URL).replace(/\/+$/, "");
  const maxRateLimitRetries = config.maxRateLimitRetries ?? DEFAULT_MAX_RATE_LIMIT_RETRIES;
  const maxRetryAfterSeconds = config.maxRetryAfterSeconds ?? DEFAULT_MAX_RETRY_AFTER_SECONDS;
  // Retry only 429s, waiting the (capped) server-supplied retry_after.
  const rateLimitSchedule = Schedule.forever.pipe(
    Schedule.while(
      /** @param {{ input: unknown }} metadata */ ({ input }) => isTelegramApiError(input) && input.errorCode === 429,
    ),
    Schedule.addDelay(
      /** @param {{ input: unknown }} metadata */ ({ input: error }) => {
        const seconds =
          isTelegramApiError(error) && typeof error.retryAfterSeconds === "number"
            ? Math.min(Math.max(error.retryAfterSeconds, 0), maxRetryAfterSeconds)
            : 1;
        logWarning(
          "Telegram rate-limited (429); retrying after retry_after",
          { retryAfterSeconds: seconds },
          "integrations:telegram",
        );
        return Effect.succeed(`${seconds} seconds`);
      },
    ),
    Schedule.upTo({ times: maxRateLimitRetries }),
  );
  /**
   * @param {string} method
   * @param {{ body: BodyInit; headers?: Record<string, string> }} request
   * @returns {Effect.Effect<unknown, SmithersError>}
   */
  const rawCall = (method, request) =>
    Effect.suspend(() => {
      // One controller per attempt spans the request and the response-body
      // read: interrupting the fiber at either stage aborts the in-flight
      // HTTP exchange instead of leaving it running in the background.
      const controller = new AbortController();
      return Effect.gen(function* () {
        const response = yield* Effect.tryPromise({
          try: (signal) => {
            linkInterruptSignal(signal, controller);
            return fetch(`${apiBaseUrl}/bot${botToken}/${method}`, {
              method: "POST",
              headers: request.headers,
              body: request.body,
              signal: controller.signal,
            });
          },
          catch: (cause) =>
            new TelegramApiError(
              `Telegram API request failed for method "${method}": ${redactBotToken(cause instanceof Error ? cause.message : String(cause), botToken)}`,
              { method },
            ),
        });
        const payload = yield* Effect.tryPromise({
          try: (signal) => {
            // The fetch step's signal is settled once headers arrive;
            // re-link so an interrupt mid-body-read still cancels the
            // request (and with it the body stream).
            linkInterruptSignal(signal, controller);
            return response.json();
          },
          catch: (cause) =>
            new TelegramApiError(
              `Telegram API returned a non-JSON response for method "${method}" (status ${response.status}).`,
              { method, errorCode: response.status, cause: undefined },
            ),
        });
        const body =
          /** @type {{ ok?: boolean; result?: unknown; error_code?: number; description?: string; parameters?: { retry_after?: number } }} */ (
            payload ?? {}
          );
        if (!body.ok) {
          const description = redactBotToken(String(body.description ?? `HTTP ${response.status}`), botToken);
          return yield* Effect.fail(
            new TelegramApiError(`Telegram API "${method}" failed: ${description}`, {
              method,
              errorCode: body.error_code ?? response.status,
              description,
              retryAfterSeconds: body.parameters?.retry_after ?? null,
            }),
          );
        }
        return body.result;
      });
    });
  /**
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   */
  const call = (method, params) =>
    rawCall(method, {
      body: JSON.stringify(params ?? {}),
      headers: { "content-type": "application/json" },
    }).pipe(Effect.retry(rateLimitSchedule));
  /**
   * Send one text chunk with parse-mode fallback: try formatted, and on a
   * 400 parse-entity rejection resend as raw plain text so the user gets
   * content instead of nothing (ported from eliza sendWithRetry).
   * @param {Record<string, unknown>} base sendMessage params without text/parse_mode
   * @param {string} formatted
   * @param {string} plain
   * @param {string | null} parseMode
   * @returns {Effect.Effect<{ result: unknown; usedPlainTextFallback: boolean }, SmithersError>}
   */
  const sendChunk = (base, formatted, plain, parseMode) => {
    if (!parseMode) {
      return call("sendMessage", { ...base, text: plain }).pipe(
        Effect.map((result) => ({ result, usedPlainTextFallback: false })),
      );
    }
    return call("sendMessage", { ...base, text: formatted, parse_mode: parseMode }).pipe(
      Effect.map((result) => ({ result, usedPlainTextFallback: false })),
      Effect.catch((error) => {
        if (!isParseEntityError(error)) {
          return Effect.fail(error);
        }
        logWarning(
          "Telegram rejected formatted message (400); retrying as plain text",
          { errorCode: 400 },
          "integrations:telegram",
        );
        return call("sendMessage", { ...base, text: plain }).pipe(
          Effect.map((result) => ({ result, usedPlainTextFallback: true })),
        );
      }),
    );
  };
  /** @type {TelegramClientService["sendMessageSmart"]} */
  const sendMessageSmart = (chatId, text, options = {}) =>
    Effect.gen(function* () {
      const parseModeOption = options.parseMode ?? "markdown";
      const chunks = chunkTelegramText(cleanText(text));
      if (chunks.length === 0) {
        return {
          chatId: String(chatId),
          messageIds: [],
          chunkCount: 0,
          usedPlainTextFallback: false,
        };
      }
      if (options.typing !== false) {
        // Typing indicator around a potentially long, multi-chunk send.
        // Best-effort: a failed chat action must not fail the send.
        yield* call("sendChatAction", {
          chat_id: chatId,
          action: "typing",
          ...(options.messageThreadId != null ? { message_thread_id: options.messageThreadId } : {}),
        }).pipe(Effect.catch(() => Effect.void));
      }
      /** @type {number[]} */
      const messageIds = [];
      let usedPlainTextFallback = false;
      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index];
        const isFirst = index === 0;
        const isLast = index === chunks.length - 1;
        const base = {
          chat_id: chatId,
          ...(options.messageThreadId != null ? { message_thread_id: options.messageThreadId } : {}),
          // Reply threading applies to the first chunk only; the rest
          // read as a continuation.
          ...(isFirst && options.replyToMessageId != null ? { reply_to_message_id: options.replyToMessageId } : {}),
          // Interaction controls (inline keyboard) go on the final chunk.
          ...(isLast && options.inlineKeyboard ? { reply_markup: { inline_keyboard: options.inlineKeyboard } } : {}),
          ...(options.disableNotification ? { disable_notification: true } : {}),
        };
        const formatted = parseModeOption === "markdown" ? convertMarkdownToTelegram(chunk) : chunk;
        const parseMode =
          parseModeOption === "none" ? null : parseModeOption === "markdown" ? "MarkdownV2" : parseModeOption;
        const sent = yield* sendChunk(base, formatted, chunk, parseMode);
        usedPlainTextFallback = usedPlainTextFallback || sent.usedPlainTextFallback;
        const messageId = /** @type {{ message_id?: number }} */ (sent.result ?? {})?.message_id;
        if (typeof messageId === "number") {
          messageIds.push(messageId);
        }
      }
      return {
        chatId: String(chatId),
        messageIds,
        chunkCount: chunks.length,
        usedPlainTextFallback,
      };
    });
  /** @type {TelegramClientService["editMessageSmart"]} */
  const editMessageSmart = (chatId, messageId, text, options = {}) => {
    const parseModeOption = options.parseMode ?? "markdown";
    const plain = cleanText(text);
    const formatted = parseModeOption === "markdown" ? convertMarkdownToTelegram(plain) : plain;
    const parseMode =
      parseModeOption === "none" ? null : parseModeOption === "markdown" ? "MarkdownV2" : parseModeOption;
    const base = {
      chat_id: chatId,
      message_id: messageId,
      ...(options.inlineKeyboard ? { reply_markup: { inline_keyboard: options.inlineKeyboard } } : {}),
    };
    if (!parseMode) {
      return call("editMessageText", { ...base, text: plain });
    }
    return call("editMessageText", { ...base, text: formatted, parse_mode: parseMode }).pipe(
      Effect.catch((error) => {
        if (!isParseEntityError(error)) {
          return Effect.fail(error);
        }
        // Fallback: edit with raw text so the user sees fresh content
        // unformatted rather than a stale message.
        return call("editMessageText", { ...base, text: plain });
      }),
    );
  };
  /** @type {TelegramClientService["sendDocument"]} */
  const sendDocument = (chatId, document, options = {}) => {
    const caption = options.caption ? convertMarkdownToTelegram(cleanText(options.caption)) : undefined;
    const shared = {
      ...(caption ? { caption, parse_mode: "MarkdownV2" } : {}),
      ...(options.messageThreadId != null ? { message_thread_id: options.messageThreadId } : {}),
      ...(options.replyToMessageId != null ? { reply_to_message_id: options.replyToMessageId } : {}),
    };
    if (typeof document === "string") {
      // URL or existing file_id — plain JSON call.
      return call("sendDocument", { chat_id: chatId, document, ...shared });
    }
    // Raw content upload — multipart form data.
    const form = new FormData();
    form.set("chat_id", String(chatId));
    for (const [key, value] of Object.entries(shared)) {
      form.set(key, typeof value === "string" ? value : String(value));
    }
    const bytes = typeof document.content === "string" ? new TextEncoder().encode(document.content) : document.content;
    form.set(
      "document",
      new Blob([bytes], { type: document.contentType ?? "application/octet-stream" }),
      document.filename,
    );
    return rawCall("sendDocument", { body: form }).pipe(Effect.retry(rateLimitSchedule));
  };
  /** @type {TelegramClientService["answerCallbackQuery"]} */
  const answerCallbackQuery = (callbackQueryId, options = {}) =>
    call("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(options.text ? { text: options.text } : {}),
      ...(options.showAlert ? { show_alert: true } : {}),
    });
  /** @type {TelegramClientService["answerWebAppQuery"]} */
  const answerWebAppQuery = (webAppQueryId, result) =>
    call("answerWebAppQuery", {
      web_app_query_id: webAppQueryId,
      result,
    });
  return { call, sendMessageSmart, editMessageSmart, sendDocument, answerCallbackQuery, answerWebAppQuery };
}

/**
 * Live Layer for {@link TelegramClient}.
 * @param {TelegramClientConfig} config
 */
export function TelegramClientLive(config) {
  return Layer.succeed(TelegramClient, makeTelegramClient(config));
}
