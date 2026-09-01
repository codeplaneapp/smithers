/**
 * The Telegram Bot API client.
 *
 * Plain `fetch`, no telegraf or grammY. What it adds over a bare call:
 *
 * - **Token redaction.** The token appears in the request path, so a transport
 *   error's message contains it. {@link redactBotToken} strips it from every
 *   message this module raises, and from any `/bot<digits>:<secret>/` shaped
 *   substring, so a token cannot reach a log through an error it did not
 *   construct.
 * - **Rate limits.** A 429 is retried, waiting the server's capped
 *   `parameters.retry_after`.
 * - **Long messages.** `sendMessageSmart` chunks at 4096 characters, converts
 *   markdown to MarkdownV2, and resends a chunk as plain text when Telegram
 *   rejects the entities, so a formatting failure costs formatting rather than
 *   the whole message.
 *
 * One `AbortController` per attempt spans the request and the body read, so an
 * interrupt at either stage aborts the exchange.
 *
 * @since 1.0.0
 */
import { SmithersError } from "@smthrs/errors/SmithersError"
import { Context, Duration, Effect, Layer, Schedule } from "effect"
import { chunk } from "./Chunk.ts"
import type { TelegramConfig } from "./Config.ts"
import { clean, toTelegram } from "./Markdown.ts"

const DEFAULT_API_BASE_URL = "https://api.telegram.org"
const DEFAULT_MAX_RATE_LIMIT_RETRIES = 3
const DEFAULT_MAX_RETRY_AFTER_SECONDS = 30

/**
 * A failure reported by the Bot API.
 *
 * Carries the API's own `error_code` and `description`, plus the parsed
 * `retry_after` for a 429. The bot token is never part of any field.
 *
 * @category errors
 * @since 1.0.0
 */
export class TelegramApiError extends SmithersError {
  readonly errorCode: number | null
  readonly retryAfterSeconds: number | null

  constructor(message: string, options: {
    readonly method: string
    readonly errorCode?: number | null | undefined
    readonly description?: string | null | undefined
    readonly retryAfterSeconds?: number | null | undefined
    readonly cause?: unknown
  }) {
    super("TELEGRAM_API_ERROR", message, {
      method: options.method,
      errorCode: options.errorCode ?? null,
      description: options.description ?? null,
      retryAfterSeconds: options.retryAfterSeconds ?? null
    }, { cause: options.cause, name: "TelegramApiError" })
    this.errorCode = options.errorCode ?? null
    this.retryAfterSeconds = options.retryAfterSeconds ?? null
  }
}

/**
 * Whether `error` is a {@link TelegramApiError}.
 *
 * @category refinements
 * @since 1.0.0
 */
export const isTelegramApiError = (error: unknown): error is TelegramApiError =>
  error instanceof TelegramApiError || (error instanceof Error && error.name === "TelegramApiError")

/**
 * Removes the bot token from a string.
 *
 * Both the literal token and any `/bot<id>:<secret>` path segment are
 * replaced, because an error from `fetch` or the platform may quote a URL this
 * module never formatted.
 *
 * @category constructors
 * @since 1.0.0
 */
export const redactBotToken = (text: string, botToken: string): string => {
  if (botToken.length === 0) return text
  return text.split(botToken).join("<redacted>").replace(/\/bot\d+:[A-Za-z0-9_-]+/g, "/bot<redacted>")
}

/** A 400 the Bot API raises when it cannot parse entities: retry as plain text. */
const isParseEntityError = (error: unknown): boolean => {
  if (!isTelegramApiError(error) || error.errorCode !== 400) return false
  return /parse|entit|too long/i.test(String(error.details?.["description"] ?? ""))
}

/**
 * One inline-keyboard button.
 *
 * @category models
 * @since 1.0.0
 */
export interface InlineKeyboardButton {
  readonly text: string
  readonly callback_data?: string | undefined
  readonly url?: string | undefined
  readonly web_app?: { readonly url: string } | undefined
}

/**
 * Rows of inline-keyboard buttons.
 *
 * @category models
 * @since 1.0.0
 */
export type InlineKeyboard = ReadonlyArray<ReadonlyArray<InlineKeyboardButton>>

/**
 * How to format and address an outgoing message.
 *
 * @category models
 * @since 1.0.0
 */
export interface SendOptions {
  /**
   * `markdown` (the default) converts standard markdown to MarkdownV2 and
   * falls back to plain text when Telegram rejects the entities.
   * `MarkdownV2` and `HTML` send the text as-is under that parse mode, still
   * with the fallback. `none` sends raw text with no parse mode.
   */
  readonly parseMode?: "markdown" | "MarkdownV2" | "HTML" | "none" | undefined
  /** Attached to the first chunk only. */
  readonly replyToMessageId?: number | undefined
  /** Forum-topic thread id, attached to every chunk. */
  readonly messageThreadId?: number | undefined
  /** Attached to the last chunk only. */
  readonly inlineKeyboard?: InlineKeyboard | undefined
  /** Show a typing action before the first chunk. Defaults to true. */
  readonly typing?: boolean | undefined
  readonly disableNotification?: boolean | undefined
}

/**
 * What `sendMessageSmart` sent.
 *
 * @category models
 * @since 1.0.0
 */
export interface SendResult {
  readonly chatId: string
  /** The `message_id` of every chunk, in send order. */
  readonly messageIds: ReadonlyArray<number>
  readonly chunkCount: number
  /** True when at least one chunk fell back to plain text. */
  readonly usedPlainTextFallback: boolean
}

/**
 * A document to upload: a URL or existing `file_id`, or raw bytes.
 *
 * @category models
 * @since 1.0.0
 */
export type DocumentInput = string | {
  readonly filename: string
  readonly content: string | Uint8Array
  readonly contentType?: string | undefined
}

/**
 * The client service.
 *
 * @category services
 * @since 1.0.0
 */
export interface TelegramClient {
  /** A raw Bot API call, returning the `result` field. Retries a 429. */
  readonly call: (method: string, params?: Record<string, unknown>) => Effect.Effect<unknown, SmithersError>
  readonly sendMessageSmart: (
    chatId: number | string,
    text: string,
    options?: SendOptions
  ) => Effect.Effect<SendResult, SmithersError>
  readonly editMessageSmart: (
    chatId: number | string,
    messageId: number,
    text: string,
    options?: Pick<SendOptions, "parseMode" | "inlineKeyboard">
  ) => Effect.Effect<unknown, SmithersError>
  readonly sendDocument: (
    chatId: number | string,
    document: DocumentInput,
    options?: {
      readonly caption?: string | undefined
      readonly replyToMessageId?: number | undefined
      readonly messageThreadId?: number | undefined
    }
  ) => Effect.Effect<unknown, SmithersError>
  readonly answerCallbackQuery: (
    callbackQueryId: string,
    options?: { readonly text?: string | undefined; readonly showAlert?: boolean | undefined }
  ) => Effect.Effect<unknown, SmithersError>
  /**
   * Answers a Mini App inline query: posts `result` to the chat on the user's
   * behalf and closes the Mini App.
   */
  readonly answerWebAppQuery: (
    webAppQueryId: string,
    result: Record<string, unknown>
  ) => Effect.Effect<unknown, SmithersError>
}

/**
 * Service tag for the Telegram Bot API client.
 *
 * @category services
 * @since 1.0.0
 */
export const TelegramClient: Context.Service<TelegramClient, TelegramClient> = Context.Service(
  "@smthrs/integrations/TelegramClient"
)

const linkInterrupt = (signal: AbortSignal, controller: AbortController): void => {
  if (signal.aborted) {
    controller.abort(signal.reason)
    return
  }
  signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true })
}

/**
 * Builds a Bot API client bound to `config`.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (config: TelegramConfig): TelegramClient => {
  const botToken = config.botToken
  if (typeof botToken !== "string" || botToken.length === 0) {
    throw new SmithersError(
      "INVALID_INPUT",
      "Telegram client requires a bot token (config.botToken or SMITHERS_TELEGRAM_BOT_TOKEN)."
    )
  }
  const apiBaseUrl = (config.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/, "")
  const maxRateLimitRetries = config.maxRateLimitRetries ?? DEFAULT_MAX_RATE_LIMIT_RETRIES
  const maxRetryAfterSeconds = config.maxRetryAfterSeconds ?? DEFAULT_MAX_RETRY_AFTER_SECONDS

  // Retry only a 429, waiting the capped server-supplied retry_after.
  const rateLimitSchedule = Schedule.forever.pipe(
    Schedule.while(({ input }) => isTelegramApiError(input) && input.errorCode === 429),
    Schedule.addDelay(({ input }) => {
      const seconds = isTelegramApiError(input) && typeof input.retryAfterSeconds === "number"
        ? Math.min(Math.max(input.retryAfterSeconds, 0), maxRetryAfterSeconds)
        : 1
      return Effect.succeed(Duration.seconds(seconds))
    }),
    Schedule.upTo({ times: maxRateLimitRetries })
  )

  const rawCall = (
    method: string,
    request: { readonly body: BodyInit; readonly headers?: Record<string, string> | undefined }
  ): Effect.Effect<unknown, SmithersError> =>
    Effect.suspend(() => {
      const controller = new AbortController()
      return Effect.gen(function*() {
        const response = yield* Effect.tryPromise({
          try: (signal) => {
            linkInterrupt(signal, controller)
            return fetch(`${apiBaseUrl}/bot${botToken}/${method}`, {
              method: "POST",
              ...(request.headers === undefined ? {} : { headers: request.headers }),
              body: request.body,
              signal: controller.signal
            })
          },
          catch: (cause) =>
            new TelegramApiError(
              `Telegram API request failed for method "${method}": ${
                redactBotToken(cause instanceof Error ? cause.message : String(cause), botToken)
              }`,
              { method }
            )
        })
        const payload = yield* Effect.tryPromise({
          try: (signal) => {
            // The fetch step's signal settles once headers arrive, so re-link
            // to keep an interrupt during the body read effective.
            linkInterrupt(signal, controller)
            return response.json() as Promise<unknown>
          },
          catch: () =>
            new TelegramApiError(
              `Telegram API returned a non-JSON response for method "${method}" (status ${response.status}).`,
              { method, errorCode: response.status }
            )
        })
        const body = (payload ?? {}) as {
          ok?: boolean
          result?: unknown
          error_code?: number
          description?: string
          parameters?: { retry_after?: number }
        }
        if (body.ok !== true) {
          const description = redactBotToken(String(body.description ?? `HTTP ${response.status}`), botToken)
          return yield* Effect.fail(
            new TelegramApiError(`Telegram API "${method}" failed: ${description}`, {
              method,
              errorCode: body.error_code ?? response.status,
              description,
              retryAfterSeconds: body.parameters?.retry_after ?? null
            })
          )
        }
        return body.result
      })
    })

  const call: TelegramClient["call"] = (method, params) =>
    rawCall(method, {
      body: JSON.stringify(params ?? {}),
      headers: { "content-type": "application/json" }
    }).pipe(Effect.retry(rateLimitSchedule))

  const sendChunk = (
    base: Record<string, unknown>,
    formatted: string,
    plain: string,
    parseMode: string | null
  ): Effect.Effect<{ readonly result: unknown; readonly usedPlainTextFallback: boolean }, SmithersError> => {
    if (parseMode === null) {
      return call("sendMessage", { ...base, text: plain }).pipe(
        Effect.map((result) => ({ result, usedPlainTextFallback: false }))
      )
    }
    return call("sendMessage", { ...base, text: formatted, parse_mode: parseMode }).pipe(
      Effect.map((result) => ({ result, usedPlainTextFallback: false })),
      Effect.catch((error) =>
        isParseEntityError(error)
          ? call("sendMessage", { ...base, text: plain }).pipe(
            Effect.map((result) => ({ result, usedPlainTextFallback: true }))
          )
          : Effect.fail(error)
      )
    )
  }

  const parseModeFor = (option: NonNullable<SendOptions["parseMode"]>): string | null =>
    option === "none" ? null : option === "markdown" ? "MarkdownV2" : option

  const sendMessageSmart: TelegramClient["sendMessageSmart"] = (chatId, text, options = {}) =>
    Effect.gen(function*() {
      const parseModeOption = options.parseMode ?? "markdown"
      const chunks = chunk(clean(text))
      if (chunks.length === 0) {
        return { chatId: String(chatId), messageIds: [], chunkCount: 0, usedPlainTextFallback: false }
      }
      if (options.typing !== false) {
        // Best effort: a failed chat action must not fail the send.
        yield* call("sendChatAction", {
          chat_id: chatId,
          action: "typing",
          ...(options.messageThreadId == null ? {} : { message_thread_id: options.messageThreadId })
        }).pipe(
          Effect.catch((error) =>
            Effect.annotateLogs(
              Effect.logWarning("Telegram typing action failed"),
              { chatId: String(chatId), error }
            )
          )
        )
      }
      const messageIds: Array<number> = []
      let usedPlainTextFallback = false
      for (const [index, piece] of chunks.entries()) {
        const isFirst = index === 0
        const isLast = index === chunks.length - 1
        const base = {
          chat_id: chatId,
          ...(options.messageThreadId == null ? {} : { message_thread_id: options.messageThreadId }),
          // Reply threading applies to the first chunk; the rest read as a
          // continuation. The keyboard goes on the last, where the reader is.
          ...(isFirst && options.replyToMessageId != null
            ? { reply_to_message_id: options.replyToMessageId }
            : {}),
          ...(isLast && options.inlineKeyboard !== undefined
            ? { reply_markup: { inline_keyboard: options.inlineKeyboard } }
            : {}),
          ...(options.disableNotification === true ? { disable_notification: true } : {})
        }
        const formatted = parseModeOption === "markdown" ? toTelegram(piece) : piece
        const sent = yield* sendChunk(base, formatted, piece, parseModeFor(parseModeOption))
        usedPlainTextFallback = usedPlainTextFallback || sent.usedPlainTextFallback
        const messageId = (sent.result as { message_id?: unknown } | null)?.message_id
        if (typeof messageId === "number") messageIds.push(messageId)
      }
      return { chatId: String(chatId), messageIds, chunkCount: chunks.length, usedPlainTextFallback }
    })

  const editMessageSmart: TelegramClient["editMessageSmart"] = (chatId, messageId, text, options = {}) => {
    const parseModeOption = options.parseMode ?? "markdown"
    const plain = clean(text)
    const formatted = parseModeOption === "markdown" ? toTelegram(plain) : plain
    const parseMode = parseModeFor(parseModeOption)
    const base = {
      chat_id: chatId,
      message_id: messageId,
      ...(options.inlineKeyboard === undefined ? {} : { reply_markup: { inline_keyboard: options.inlineKeyboard } })
    }
    if (parseMode === null) return call("editMessageText", { ...base, text: plain })
    return call("editMessageText", { ...base, text: formatted, parse_mode: parseMode }).pipe(
      Effect.catch((error) =>
        isParseEntityError(error)
          // Show fresh content unformatted rather than leaving a stale message.
          ? call("editMessageText", { ...base, text: plain })
          : Effect.fail(error)
      )
    )
  }

  const sendDocument: TelegramClient["sendDocument"] = (chatId, document, options = {}) => {
    const caption = options.caption === undefined ? undefined : toTelegram(clean(options.caption))
    const shared: Record<string, string | number> = {
      ...(caption === undefined ? {} : { caption, parse_mode: "MarkdownV2" }),
      ...(options.messageThreadId == null ? {} : { message_thread_id: options.messageThreadId }),
      ...(options.replyToMessageId == null ? {} : { reply_to_message_id: options.replyToMessageId })
    }
    if (typeof document === "string") {
      return call("sendDocument", { chat_id: chatId, document, ...shared })
    }
    const form = new FormData()
    form.set("chat_id", String(chatId))
    for (const [key, value] of Object.entries(shared)) form.set(key, String(value))
    const bytes = typeof document.content === "string" ? new TextEncoder().encode(document.content) : document.content
    form.set(
      "document",
      new Blob([bytes as BlobPart], { type: document.contentType ?? "application/octet-stream" }),
      document.filename
    )
    return rawCall("sendDocument", { body: form }).pipe(Effect.retry(rateLimitSchedule))
  }

  return TelegramClient.of({
    call,
    sendMessageSmart,
    editMessageSmart,
    sendDocument,
    answerCallbackQuery: (callbackQueryId, options = {}) =>
      call("answerCallbackQuery", {
        callback_query_id: callbackQueryId,
        ...(options.text === undefined ? {} : { text: options.text }),
        ...(options.showAlert === true ? { show_alert: true } : {})
      }),
    answerWebAppQuery: (webAppQueryId, result) => call("answerWebAppQuery", { web_app_query_id: webAppQueryId, result })
  })
}

/**
 * Layer for a client bound to `config`.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = (config: TelegramConfig): Layer.Layer<TelegramClient> =>
  Layer.sync(TelegramClient, () => make(config))
