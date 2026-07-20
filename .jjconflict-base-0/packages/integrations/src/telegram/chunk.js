// Message chunking at Telegram's hard 4096-character sendMessage limit,
// ported from the eliza plugin-telegram reference client (splitMessage) and
// extended to prefer paragraph/sentence/word boundaries over mid-word cuts.

/** Telegram's maximum `sendMessage` text length. */
export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

/**
 * Find the best split index at or before `limit` inside `text`, preferring
 * (in order) a paragraph break, a line break, a sentence end, then a word
 * boundary. Returns -1 when no acceptable boundary exists (forcing a hard
 * cut). Boundaries in the first tenth of the window are rejected so a lone
 * early period cannot produce degenerate tiny chunks.
 * @param {string} text
 * @param {number} limit
 * @returns {number} number of characters to take into the current chunk
 */
function findSplitIndex(text, limit) {
    const window = text.slice(0, limit + 1);
    const minIndex = Math.floor(limit / 10);
    const paragraph = window.lastIndexOf("\n\n");
    if (paragraph > minIndex) {
        return paragraph;
    }
    const line = window.lastIndexOf("\n");
    if (line > minIndex) {
        return line;
    }
    let sentence = -1;
    const sentenceEnd = /[.!?]["')\]]?\s/g;
    for (const match of window.matchAll(sentenceEnd)) {
        const end = match.index + match[0].length;
        if (end <= limit) {
            sentence = end;
        }
    }
    if (sentence > minIndex) {
        return sentence;
    }
    const space = window.lastIndexOf(" ");
    if (space > minIndex) {
        return space;
    }
    return -1;
}

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
export function chunkTelegramText(text, maxLength = TELEGRAM_MAX_MESSAGE_LENGTH) {
    /** @type {string[]} */
    const chunks = [];
    if (!text) {
        return chunks;
    }
    let remaining = text;
    while (remaining.length > maxLength) {
        const splitAt = findSplitIndex(remaining, maxLength);
        const take = splitAt > 0 ? splitAt : maxLength;
        const chunk = remaining.slice(0, take).replace(/\s+$/, "");
        if (chunk) {
            chunks.push(chunk);
        }
        remaining = remaining.slice(take).replace(/^\s+/, "");
    }
    if (remaining) {
        chunks.push(remaining);
    }
    return chunks;
}
