import { TelegramInitData as TelegramInitData$1, TelegramInitDataUser as TelegramInitDataUser$1, VerifyTelegramWebAppInitDataOptions as VerifyTelegramWebAppInitDataOptions$1, VerifyTelegramWebAppInitDataSignatureOptions as VerifyTelegramWebAppInitDataSignatureOptions$1 } from './initDataTypes.js';

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

export { TELEGRAM_WEBAPP_ED25519_PUBLIC_KEY_PROD, TELEGRAM_WEBAPP_ED25519_PUBLIC_KEY_TEST, type TelegramInitData, type TelegramInitDataUser, type VerifyTelegramWebAppInitDataOptions, type VerifyTelegramWebAppInitDataSignatureOptions, parseTelegramInitData, verifyTelegramWebAppInitData, verifyTelegramWebAppInitDataSignature };
