export const TELEGRAM_API_ROOT = "https://api.telegram.org";
export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
// Deliberately below the 4096 hard cap: leaves headroom for MarkdownV2 escaping
// and any prefixes callers prepend to a chunk.
export const TELEGRAM_SAFE_CHUNK_LENGTH = 3800;
export const TELEGRAM_WEBHOOK_SECRET_HEADER = "x-telegram-bot-api-secret-token";

// Default finite cap for server-provided Bot API `parameters.retry_after`
// values. Callers may set `maxRetryAfterSeconds` to another finite limit.
const DEFAULT_MAX_RETRY_AFTER_SECONDS = 30;
// Exactly the message-bearing update kinds normalizeTelegramUpdate understands
// (messageFromUpdate mirrors this list).
const DEFAULT_ALLOWED_UPDATES = ["message", "edited_message", "channel_post", "edited_channel_post"];
// Full escape set required by the Bot API MarkdownV2 spec, including backslash itself.
const MARKDOWN_V2_SPECIAL = /([_*\[\]()~`>#+\-=|{}.!\\])/g;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compact(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : null;
}

function bodyTextFromMessage(message) {
  if (typeof message.text === "string") return message.text;
  if (typeof message.caption === "string") return message.caption;
  return "";
}

function authorFromMessage(message) {
  const from = isRecord(message.from) ? message.from : null;
  const senderChat = isRecord(message.sender_chat) ? message.sender_chat : null;
  if (from) {
    if (typeof from.username === "string" && from.username) return `@${from.username}`;
    const name = `${typeof from.first_name === "string" ? from.first_name : ""} ${
      typeof from.last_name === "string" ? from.last_name : ""
    }`.trim();
    if (name) return name;
  }
  if (senderChat && typeof senderChat.title === "string" && senderChat.title) return senderChat.title;
  return null;
}

function chatTitleFromMessage(message) {
  const chat = isRecord(message.chat) ? message.chat : null;
  if (!chat) return null;
  if (typeof chat.title === "string" && chat.title) return chat.title;
  if (typeof chat.first_name === "string" && chat.first_name) return chat.first_name;
  if (typeof chat.username === "string" && chat.username) return chat.username;
  return null;
}

function messageFromUpdate(update) {
  if (!isRecord(update)) return null;
  if (isRecord(update.message)) return { kind: "message", message: update.message };
  if (isRecord(update.edited_message)) return { kind: "edited_message", message: update.edited_message };
  if (isRecord(update.channel_post)) return { kind: "channel_post", message: update.channel_post };
  if (isRecord(update.edited_channel_post)) return { kind: "edited_channel_post", message: update.edited_channel_post };
  return null;
}

function telegramDelayMs(error, attempt, retryBaseMs, maxRetryAfterSeconds) {
  // Bot API `parameters.retry_after` is in seconds — honor it (converted to ms)
  // over our exponential backoff, up to the configured finite cap.
  const retryAfter = error.payload?.parameters?.retry_after;
  if (typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.ceil(Math.min(retryAfter, maxRetryAfterSeconds) * 1000);
  }
  return retryBaseMs * 2 ** attempt;
}

function abortReason(signal) {
  return signal?.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function defaultSleep(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(abortReason(signal));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function sleepWithSignal(sleep, ms, signal) {
  if (!signal) {
    await sleep(ms);
    return;
  }
  if (signal.aborted) throw abortReason(signal);

  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([sleep(ms, signal), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function isRetryableTelegramError(error) {
  if (error instanceof TelegramNetworkError) return true;
  return error instanceof TelegramBotApiError && (error.status === 429 || error.status >= 500);
}

export class TelegramBotApiError extends Error {
  constructor(method, status, description, payload) {
    super(description || `Telegram ${method} failed with HTTP ${status}`);
    this.name = "TelegramBotApiError";
    this.method = method;
    this.status = status;
    this.payload = payload;
    this.retryAfterSeconds =
      typeof payload?.parameters?.retry_after === "number" ? payload.parameters.retry_after : null;
  }
}

export class TelegramNetworkError extends Error {
  constructor(method, cause) {
    super(`Telegram ${method} network request failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "TelegramNetworkError";
    this.method = method;
    this.cause = cause;
  }
}

function sanitizeTelegramNetworkCause(cause, botToken, requestUrl) {
  const redact = (value) =>
    String(value)
      .split(requestUrl)
      .join("<redacted>")
      .split(botToken)
      .join("<redacted>")
      .replace(/\/bot\d+:[A-Za-z0-9_-]+/g, "/bot<redacted>");
  const message =
    cause instanceof Error || (isRecord(cause) && typeof cause.message === "string") ? cause.message : cause;
  const name = cause instanceof Error || (isRecord(cause) && typeof cause.name === "string") ? cause.name : "Error";
  const sanitized = new Error(redact(message));
  sanitized.name = redact(name);
  if (isRecord(cause) && (typeof cause.code === "string" || typeof cause.code === "number")) {
    sanitized.code = redact(cause.code);
  }
  return sanitized;
}

export function parseTelegramAllowedChats(value) {
  if (value == null) return { allowAll: true, chatIds: [], error: null };

  let entries = value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return { allowAll: true, chatIds: [], error: null };
    try {
      entries = JSON.parse(trimmed);
    } catch (error) {
      return {
        allowAll: false,
        chatIds: [],
        error: `TELEGRAM_ALLOWED_CHATS must be a JSON array of chat-id strings: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  } else if (value instanceof Set) {
    entries = Array.from(value);
  }

  if (!Array.isArray(entries)) {
    return {
      allowAll: false,
      chatIds: [],
      error: "TELEGRAM_ALLOWED_CHATS must be a JSON array of chat-id strings",
    };
  }

  const chatIds = [];
  for (const entry of entries) {
    if (typeof entry !== "string" && typeof entry !== "number" && typeof entry !== "bigint") {
      return {
        allowAll: false,
        chatIds: [],
        error: "TELEGRAM_ALLOWED_CHATS entries must be strings or numbers",
      };
    }
    const chatId = String(entry).trim();
    if (!chatId) {
      return {
        allowAll: false,
        chatIds: [],
        error: "TELEGRAM_ALLOWED_CHATS entries must not be blank",
      };
    }
    chatIds.push(chatId);
  }

  return { allowAll: false, chatIds, error: null };
}

export function isTelegramChatAllowed(chatId, allowedChats) {
  const parsed = parseTelegramAllowedChats(allowedChats);
  if (parsed.error) return false;
  if (parsed.allowAll) return true;
  return parsed.chatIds.includes(String(chatId));
}

// XOR-accumulate over every character instead of early-exit comparison so
// webhook-secret checks run in constant time for equal-length inputs
// (timing-attack hardening).
export function tokensEqual(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string" || actual.length !== expected.length) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < expected.length; index += 1) {
    diff |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return diff === 0;
}

export function verifyTelegramWebhookSecret(request, expectedSecret) {
  const expected = compact(expectedSecret);
  if (!expected) return false;
  return tokensEqual(request.headers.get(TELEGRAM_WEBHOOK_SECRET_HEADER) ?? undefined, expected);
}

export function normalizeTelegramUpdate(update, options = {}) {
  if (!isRecord(update) || typeof update.update_id !== "number") return null;
  const extracted = messageFromUpdate(update);
  if (!extracted) return null;
  const message = extracted.message;
  const chat = isRecord(message.chat) ? message.chat : null;
  const from = isRecord(message.from) ? message.from : null;
  if (!chat || (from?.is_bot === true && options.includeBotMessages !== true)) return null;
  // Telegram chat ids can arrive numeric; normalize to string so callers compare/route uniformly.
  const chatId = typeof chat.id === "string" ? chat.id : typeof chat.id === "number" ? String(chat.id) : null;
  if (!chatId) return null;
  // collapse internal whitespace so multi-line messages normalize to one searchable line
  const text = bodyTextFromMessage(message).replace(/\s+/g, " ").trim();
  if (!text && options.includeEmptyText !== true) return null;
  return {
    updateId: update.update_id,
    kind: extracted.kind,
    chatId,
    chatType: typeof chat.type === "string" ? chat.type : null,
    chatTitle: chatTitleFromMessage(message),
    messageId: typeof message.message_id === "number" ? message.message_id : null,
    messageThreadId: typeof message.message_thread_id === "number" ? message.message_thread_id : null,
    fromUserId: from && (typeof from.id === "number" || typeof from.id === "string") ? String(from.id) : null,
    fromUsername: from && typeof from.username === "string" ? from.username : null,
    fromDisplayName: authorFromMessage(message),
    isBot: from?.is_bot === true,
    text,
    sentAtMs: typeof message.date === "number" ? message.date * 1000 : null,
    raw: update,
  };
}

export function escapeTelegramMarkdownV2(text) {
  return String(text).replace(MARKDOWN_V2_SPECIAL, "\\$1");
}

// Back a cut index off any boundary that would corrupt the chunk it ends:
// a bisected surrogate pair (lone surrogates render as replacement chars) or an
// odd trailing run of backslashes (a MarkdownV2 escape whose escaped character
// would land in the next chunk, making both chunks unparseable).
function safeCutIndex(text, end) {
  let cut = end;
  if (cut > 0 && cut < text.length) {
    const high = text.charCodeAt(cut - 1);
    const low = text.charCodeAt(cut);
    if (high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) cut -= 1;
  }
  const codePointSafe = cut > 0 ? cut : end;
  cut = codePointSafe;
  // Trailing whitespace is dropped by trimEnd/trimStart either way, so look past it —
  // otherwise a backslash it hides only surfaces after the trim. Backing off one
  // backslash can expose another the same way, so re-check until the cut is stable.
  while (cut > 0) {
    let scan = cut;
    while (scan > 0 && /\s/.test(text[scan - 1])) scan -= 1;
    let backslashes = 0;
    while (scan - backslashes > 0 && text.charCodeAt(scan - backslashes - 1) === 0x5c) backslashes += 1;
    if (backslashes % 2 === 0) {
      cut = scan;
      break;
    }
    cut = scan - 1;
  }
  // Never stall the split loop: a zero-width cut would repeat forever. When no
  // escape-safe cut fits the window, keep at least the code-point-safe one.
  return cut > 0 ? cut : codePointSafe;
}

export function splitTelegramText(text, options = {}) {
  const maxLength = Math.min(
    TELEGRAM_MAX_MESSAGE_LENGTH,
    Math.max(1, Math.floor(options.maxLength ?? TELEGRAM_SAFE_CHUNK_LENGTH)),
  );
  const chunks = [];
  let remaining = String(text).trim();
  while (remaining.length > maxLength) {
    const newlineCut = remaining.lastIndexOf("\n", maxLength);
    const spaceCut = remaining.lastIndexOf(" ", maxLength);
    const softCut = Math.max(newlineCut, spaceCut);
    // Prefer the last newline/space cut, but only if it lands past the midpoint —
    // otherwise hard-cut at maxLength rather than emit tiny fragment chunks.
    const end = safeCutIndex(remaining, softCut > Math.floor(maxLength / 2) ? softCut : maxLength);
    chunks.push(remaining.slice(0, end).trimEnd());
    remaining = remaining.slice(end).trimStart();
  }
  if (remaining || chunks.length === 0) chunks.push(remaining);
  return chunks;
}

export async function sendTelegramTextChunks(client, args) {
  const chunks = splitTelegramText(args.text, { maxLength: args.maxLength });
  const results = [];
  for (const chunk of chunks) {
    results.push(
      await client.sendMessage({
        ...args,
        text: chunk,
      }),
    );
  }
  return results;
}

export function createTelegramClient(options) {
  const token = compact(options?.botToken);
  if (!token) throw new Error("botToken is required");
  const apiRoot = (compact(options.apiRoot) ?? TELEGRAM_API_ROOT).replace(/\/+$/, "");
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("fetch is not available");
  const maxRetries = Math.max(0, Math.floor(options.maxRetries ?? 3));
  const retryBaseMs = Math.max(1, Math.floor(options.retryBaseMs ?? 500));
  const configuredMaxRetryAfterSeconds = options.maxRetryAfterSeconds ?? DEFAULT_MAX_RETRY_AFTER_SECONDS;
  const maxRetryAfterSeconds =
    typeof configuredMaxRetryAfterSeconds === "number" && Number.isFinite(configuredMaxRetryAfterSeconds)
      ? Math.max(0, configuredMaxRetryAfterSeconds)
      : DEFAULT_MAX_RETRY_AFTER_SECONDS;
  const sleep = options.sleep ?? defaultSleep;

  async function call(method, body = {}, init = {}) {
    let lastError = null;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const requestUrl = `${apiRoot}/bot${token}/${method}`;
        let response;
        try {
          response = await fetchImpl(requestUrl, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              // drop undefined overrides so they don't serialize as the string "undefined"
              ...Object.fromEntries(Object.entries(init.headers ?? {}).filter(([, value]) => value !== undefined)),
            },
            body: JSON.stringify(body),
            signal: init.signal,
          });
        } catch (error) {
          if (init.signal?.aborted || error?.name === "AbortError") {
            throw sanitizeTelegramNetworkCause(error, token, requestUrl);
          }
          throw new TelegramNetworkError(method, sanitizeTelegramNetworkCause(error, token, requestUrl));
        }

        let text;
        try {
          text = await response.text();
        } catch (error) {
          if (init.signal?.aborted || error?.name === "AbortError") {
            throw sanitizeTelegramNetworkCause(error, token, requestUrl);
          }
          throw new TelegramNetworkError(method, sanitizeTelegramNetworkCause(error, token, requestUrl));
        }

        let payload;
        try {
          payload = text ? JSON.parse(text) : {};
        } catch {
          throw new TelegramBotApiError(
            method,
            response.status,
            `Telegram ${method} returned invalid JSON with HTTP ${response.status}`,
            { raw: text },
          );
        }
        if (response.ok && payload.ok !== false) return payload.result;
        throw new TelegramBotApiError(
          method,
          response.status >= 400 ? response.status : (payload.error_code ?? response.status),
          typeof payload.description === "string" ? payload.description : undefined,
          payload,
        );
      } catch (error) {
        lastError = error;
        if (attempt >= maxRetries || !isRetryableTelegramError(error)) throw error;
        await sleepWithSignal(sleep, telegramDelayMs(error, attempt, retryBaseMs, maxRetryAfterSeconds), init.signal);
      }
    }
    throw lastError ?? new Error(`Telegram ${method} failed`);
  }

  return {
    call,
    getMe: (init) => call("getMe", {}, init),
    setWebhook: (args, init) =>
      call(
        "setWebhook",
        {
          url: args.url,
          secret_token: args.secretToken,
          allowed_updates: args.allowedUpdates ?? DEFAULT_ALLOWED_UPDATES,
          drop_pending_updates: args.dropPendingUpdates ?? false,
        },
        init,
      ),
    deleteWebhook: (args = {}, init) =>
      call("deleteWebhook", { drop_pending_updates: args.dropPendingUpdates ?? false }, init),
    getWebhookInfo: (init) => call("getWebhookInfo", {}, init),
    sendChatAction: (args, init) =>
      call(
        "sendChatAction",
        {
          chat_id: args.chatId,
          action: args.action,
          message_thread_id: args.messageThreadId,
        },
        init,
      ),
    sendMessage: (args, init) =>
      call(
        "sendMessage",
        {
          chat_id: args.chatId,
          text: args.text,
          parse_mode: args.parseMode,
          disable_web_page_preview: args.disableWebPagePreview,
          reply_to_message_id: args.replyToMessageId,
          message_thread_id: args.messageThreadId,
          reply_markup: args.replyMarkup,
        },
        init,
      ),
    editMessageText: (args, init) =>
      call(
        "editMessageText",
        {
          chat_id: args.chatId,
          message_id: args.messageId,
          text: args.text,
          parse_mode: args.parseMode,
          disable_web_page_preview: args.disableWebPagePreview,
          reply_markup: args.replyMarkup,
        },
        init,
      ),
  };
}

export class FakeTelegramClient {
  constructor() {
    this.calls = [];
    this.messages = [];
    this.nextMessageId = 1;
  }

  async call(method, body = {}) {
    this.calls.push({ method, body });
    return { ok: true };
  }

  async getMe() {
    this.calls.push({ method: "getMe", body: {} });
    return { id: 1, is_bot: true, username: "smithers_test_bot" };
  }

  async sendMessage(args) {
    const message = {
      message_id: this.nextMessageId++,
      chat: { id: args.chatId },
      text: args.text,
    };
    this.calls.push({ method: "sendMessage", body: { chat_id: args.chatId, text: args.text } });
    this.messages.push(message);
    return message;
  }

  async editMessageText(args) {
    this.calls.push({
      method: "editMessageText",
      body: { chat_id: args.chatId, message_id: args.messageId, text: args.text },
    });
    return true;
  }
}
