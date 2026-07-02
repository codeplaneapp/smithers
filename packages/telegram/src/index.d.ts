export const TELEGRAM_API_ROOT: "https://api.telegram.org";
export const TELEGRAM_MAX_MESSAGE_LENGTH: 4096;
export const TELEGRAM_SAFE_CHUNK_LENGTH: 3800;
export const TELEGRAM_WEBHOOK_SECRET_HEADER: "x-telegram-bot-api-secret-token";

export type TelegramChatId = number | string;
export type TelegramParseMode = "MarkdownV2" | "HTML" | "Markdown";

export interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: {
    retry_after?: number;
    migrate_to_chat_id?: number;
  };
}

export interface TelegramMessageResult {
  message_id: number;
  chat: { id: TelegramChatId; [key: string]: unknown };
  text?: string;
  [key: string]: unknown;
}

export interface TelegramClientOptions {
  botToken: string;
  apiRoot?: string;
  fetch?: typeof fetch;
  maxRetries?: number;
  retryBaseMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface TelegramRequestInit {
  headers?: Record<string, string | undefined>;
  signal?: AbortSignal;
}

export interface TelegramSendMessageArgs {
  chatId: TelegramChatId;
  text: string;
  parseMode?: TelegramParseMode;
  disableWebPagePreview?: boolean;
  replyToMessageId?: number;
  messageThreadId?: number;
  replyMarkup?: unknown;
  maxLength?: number;
}

export interface TelegramEditMessageTextArgs {
  chatId: TelegramChatId;
  messageId: number;
  text: string;
  parseMode?: TelegramParseMode;
  disableWebPagePreview?: boolean;
  replyMarkup?: unknown;
}

export interface TelegramSetWebhookArgs {
  url: string;
  secretToken?: string;
  allowedUpdates?: string[];
  dropPendingUpdates?: boolean;
}

export interface TelegramDeleteWebhookArgs {
  dropPendingUpdates?: boolean;
}

export interface TelegramSendChatActionArgs {
  chatId: TelegramChatId;
  action: string;
  messageThreadId?: number;
}

export interface TelegramBotApiClient {
  call<T = unknown>(method: string, body?: Record<string, unknown>, init?: TelegramRequestInit): Promise<T>;
  getMe<T = unknown>(init?: TelegramRequestInit): Promise<T>;
  setWebhook<T = unknown>(args: TelegramSetWebhookArgs, init?: TelegramRequestInit): Promise<T>;
  deleteWebhook<T = unknown>(args?: TelegramDeleteWebhookArgs, init?: TelegramRequestInit): Promise<T>;
  getWebhookInfo<T = unknown>(init?: TelegramRequestInit): Promise<T>;
  sendChatAction<T = unknown>(args: TelegramSendChatActionArgs, init?: TelegramRequestInit): Promise<T>;
  sendMessage<T = TelegramMessageResult>(args: TelegramSendMessageArgs, init?: TelegramRequestInit): Promise<T>;
  editMessageText<T = unknown>(args: TelegramEditMessageTextArgs, init?: TelegramRequestInit): Promise<T>;
}

export interface NormalizedTelegramMessage {
  updateId: number;
  kind: "message" | "edited_message" | "channel_post" | "edited_channel_post";
  chatId: string;
  chatType: string | null;
  chatTitle: string | null;
  messageId: number | null;
  messageThreadId: number | null;
  fromUserId: string | null;
  fromUsername: string | null;
  fromDisplayName: string | null;
  isBot: boolean;
  text: string;
  sentAtMs: number | null;
  raw: unknown;
}

export interface NormalizeTelegramUpdateOptions {
  includeBotMessages?: boolean;
  includeEmptyText?: boolean;
}

export class TelegramBotApiError extends Error {
  readonly method: string;
  readonly status: number;
  readonly payload: TelegramApiResponse<unknown> | unknown;
  readonly retryAfterSeconds: number | null;
  constructor(method: string, status: number, description?: string, payload?: unknown);
}

export class TelegramNetworkError extends Error {
  readonly method: string;
  override readonly cause: unknown;
  constructor(method: string, cause: unknown);
}

export interface TelegramAllowedChatsPolicy {
  allowAll: boolean;
  chatIds: string[];
  error: string | null;
}

export function parseTelegramAllowedChats(
  value: string | readonly TelegramChatId[] | ReadonlySet<TelegramChatId> | null | undefined,
): TelegramAllowedChatsPolicy;
export function isTelegramChatAllowed(
  chatId: TelegramChatId,
  allowedChats: string | readonly TelegramChatId[] | ReadonlySet<TelegramChatId> | null | undefined,
): boolean;
export function tokensEqual(actual: string | undefined, expected: string): boolean;
export function verifyTelegramWebhookSecret(request: Request, expectedSecret: string | undefined): boolean;
export function normalizeTelegramUpdate(
  update: unknown,
  options?: NormalizeTelegramUpdateOptions,
): NormalizedTelegramMessage | null;
export function escapeTelegramMarkdownV2(text: string): string;
export function splitTelegramText(text: string, options?: { maxLength?: number }): string[];
export function sendTelegramTextChunks<T = TelegramMessageResult>(
  client: Pick<TelegramBotApiClient, "sendMessage">,
  args: TelegramSendMessageArgs,
): Promise<T[]>;
export function createTelegramClient(options: TelegramClientOptions): TelegramBotApiClient;

export class FakeTelegramClient implements Pick<TelegramBotApiClient, "call" | "getMe" | "sendMessage" | "editMessageText"> {
  calls: Array<{ method: string; body: unknown }>;
  messages: TelegramMessageResult[];
  nextMessageId: number;
  call<T = unknown>(method: string, body?: Record<string, unknown>): Promise<T>;
  getMe<T = unknown>(): Promise<T>;
  sendMessage<T = TelegramMessageResult>(args: TelegramSendMessageArgs): Promise<T>;
  editMessageText<T = unknown>(args: TelegramEditMessageTextArgs): Promise<T>;
}
