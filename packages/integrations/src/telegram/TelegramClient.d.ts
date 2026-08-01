import { SendDocumentOptions as SendDocumentOptions$1, SendMessageSmartOptions as SendMessageSmartOptions$1, SendMessageSmartResult as SendMessageSmartResult$1, TelegramClientService as TelegramClientService$1, TelegramClientConfig as TelegramClientConfig$1, TelegramDocumentInput as TelegramDocumentInput$1, TelegramInlineKeyboard as TelegramInlineKeyboard$1 } from './TelegramClientTypes.js';
import { Context, Layer } from 'effect';
import { SmithersError } from '@smithers-orchestrator/errors/SmithersError';

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
 * @type {Context.Service<TelegramClientService, TelegramClientService>}
 */
declare const TelegramClient: Context.Service<TelegramClientService, TelegramClientService>;
type TelegramClientConfig = TelegramClientConfig$1;
type TelegramClientService = TelegramClientService$1;
type SendMessageSmartOptions = SendMessageSmartOptions$1;
type SendMessageSmartResult = SendMessageSmartResult$1;
type SendDocumentOptions = SendDocumentOptions$1;
type TelegramDocumentInput = TelegramDocumentInput$1;
type TelegramInlineKeyboard = TelegramInlineKeyboard$1;

export { DEFAULT_TELEGRAM_API_BASE_URL, type SendDocumentOptions, type SendMessageSmartOptions, type SendMessageSmartResult, TelegramApiError, TelegramClient, type TelegramClientConfig, TelegramClientLive, type TelegramClientService, type TelegramDocumentInput, type TelegramInlineKeyboard, isTelegramApiError, makeTelegramClient, redactBotToken };
