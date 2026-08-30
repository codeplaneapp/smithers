/**
 * Message chunking at Telegram's hard `sendMessage` limit.
 *
 * Telegram rejects a message over 4096 characters outright, so long output has
 * to be split. Splitting at the limit alone cuts words in half; this splits at
 * the last paragraph break, line break, sentence end, or word boundary that
 * fits, and cuts mid-word only when a single unbroken run is longer than the
 * limit.
 *
 * @since 1.0.0
 */

/**
 * Telegram's maximum `sendMessage` text length.
 *
 * @category constants
 * @since 1.0.0
 */
export const MAX_MESSAGE_LENGTH = 4096

/**
 * How many characters to take into the current chunk, or `-1` when no
 * acceptable boundary exists and the caller must cut at the limit.
 *
 * A boundary inside the first tenth of the window is rejected: one early
 * period would otherwise produce a chunk of three words followed by a chunk of
 * four thousand characters.
 */
const findSplitIndex = (text: string, limit: number): number => {
  const window = text.slice(0, limit + 1)
  const minIndex = Math.floor(limit / 10)
  const paragraph = window.lastIndexOf("\n\n")
  if (paragraph > minIndex) return paragraph
  const line = window.lastIndexOf("\n")
  if (line > minIndex) return line
  let sentence = -1
  for (const match of window.matchAll(/[.!?]["')\]]?\s/g)) {
    const end = match.index + match[0].length
    if (end <= limit) sentence = end
  }
  if (sentence > minIndex) return sentence
  const space = window.lastIndexOf(" ")
  if (space > minIndex) return space
  return -1
}

/**
 * Splits `text` into chunks of at most `maxLength` characters.
 *
 * Chunks are trimmed of the whitespace they were split on, and an empty chunk
 * is never emitted.
 *
 * @category constructors
 * @since 1.0.0
 */
export const chunk = (text: string, maxLength: number = MAX_MESSAGE_LENGTH): ReadonlyArray<string> => {
  const chunks: Array<string> = []
  if (text.length === 0) return chunks
  let remaining = text
  while (remaining.length > maxLength) {
    const splitAt = findSplitIndex(remaining, maxLength)
    const take = splitAt > 0 ? splitAt : maxLength
    const piece = remaining.slice(0, take).replace(/\s+$/, "")
    if (piece.length > 0) chunks.push(piece)
    remaining = remaining.slice(take).replace(/^\s+/, "")
  }
  if (remaining.length > 0) chunks.push(remaining)
  return chunks
}
