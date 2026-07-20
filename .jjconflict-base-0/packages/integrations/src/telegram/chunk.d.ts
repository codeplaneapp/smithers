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

export { TELEGRAM_MAX_MESSAGE_LENGTH, chunkTelegramText };
