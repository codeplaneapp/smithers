import { TelegramClientConfig as TelegramClientConfig$1, TelegramClientService } from './TelegramClientTypes.js';
import 'effect';
import '@smithers-orchestrator/errors/SmithersError';

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
declare function resolveTelegramClient(explicit?: Partial<TelegramClientConfig> | undefined): TelegramClientService;
type TelegramClientConfig = TelegramClientConfig$1;

export { type TelegramClientConfig, configureTelegram, resolveTelegramClient, resolveTelegramConfig };
