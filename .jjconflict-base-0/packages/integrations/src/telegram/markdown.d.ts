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

export { cleanText, convertMarkdownToTelegram, escapeMarkdownV2 };
