/**
 * Telegram bot credentials.
 *
 * @since 1.0.0
 */
import { SmithersError } from "@smthrs/errors/SmithersError"

/**
 * The public Bot API host.
 *
 * @category constants
 * @since 1.0.0
 */
export const DEFAULT_API_BASE_URL = "https://api.telegram.org"

/**
 * What a caller may supply.
 *
 * @category models
 * @since 1.0.0
 */
export interface TelegramConfig {
  /** The token from BotFather. Never logged, and stripped from error output. */
  readonly botToken: string
  /** Endpoint override, for a fixture server. Defaults to the public host. */
  readonly apiBaseUrl?: string | undefined
  /** Automatic retries on a 429. Defaults to 3. */
  readonly maxRateLimitRetries?: number | undefined
  /** Cap on the server-supplied `retry_after` honored per retry, in seconds. Defaults to 30. */
  readonly maxRetryAfterSeconds?: number | undefined
}

/**
 * Fills the bot token from `SMITHERS_TELEGRAM_BOT_TOKEN` when the caller did
 * not pass one.
 *
 * Fails with `INVALID_INPUT` when no token can be found. The message names the
 * ways to supply one and never contains token material.
 *
 * @category constructors
 * @since 1.0.0
 */
export const resolve = (
  config: Partial<TelegramConfig> = {},
  env: Readonly<Record<string, string | undefined>> = process.env
): TelegramConfig => {
  const botToken = config.botToken ?? env["SMITHERS_TELEGRAM_BOT_TOKEN"]
  if (botToken === undefined || botToken.length === 0) {
    throw new SmithersError(
      "INVALID_INPUT",
      "No Telegram bot token configured. Pass config.botToken or set SMITHERS_TELEGRAM_BOT_TOKEN."
    )
  }
  return { ...config, botToken }
}
