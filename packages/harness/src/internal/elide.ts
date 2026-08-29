/**
 * Honest shortening.
 *
 * Every place this harness puts bytes in front of a model is bounded, and every
 * one of those bounds used to be spelled the same way: slice, append `…`, move
 * on. A model reading that cannot tell a value that ends in an ellipsis from a
 * value that was cut, cannot tell how much it lost, and — the expensive part —
 * cannot tell how to get the rest back, so it buys the same bytes again. Three
 * of the five most expensive instances of the r90 wave spent real money
 * re-fetching a region the run had already rendered and silently clipped
 * (`pydata__xarray-7229` $0.76, `sphinx-doc__sphinx-8721` $0.36,
 * `pytest-dev__pytest-6197` $0.19).
 *
 * So a shortened value states three things: that it was shortened, how many
 * bytes are missing, and the id that brings them back. The id is a sentence the
 * caller supplies, because only the caller knows whether the thing is a state
 * key (`render`), a settled call (`recall`), or something the model must fetch
 * again.
 *
 * @since 0.1.0
 * @private
 * @slop
 */

/**
 * Whether this UTF-16 unit is the first half of a surrogate pair.
 *
 * A cut between the halves of a pair is the one cut a bound may not make. It
 * does not shorten the value by a character, it replaces that character with a
 * unit that is not one: `JSON.stringify` escapes it, a `TextEncoder` turns it
 * into U+FFFD, and a model reading a Python traceback or a Chinese test name
 * sees a broken glyph at every boundary this module draws. Worse, two ends
 * joined without a marker can fuse a trailing high half onto a leading low half
 * and invent a character that was never printed.
 */
const leading = (code: number): boolean => code >= 0xd800 && code <= 0xdbff

/**
 * The first `limit` units of `text`, stopping short of splitting a pair.
 *
 * A cut lands mid-pair when the unit before it leads one, so that cut moves back
 * by one and the value loses one more unit than the caller asked it to. Every
 * bound here is a ceiling, so giving back a unit is always allowed; taking one
 * is not.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export const headSlice = (text: string, limit: number): string =>
  text.slice(0, limit > 0 && limit < text.length && leading(text.charCodeAt(limit - 1)) ? limit - 1 : limit)

/**
 * The last `limit` units of `text`, starting after a pair rather than inside it.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export const tailSlice = (text: string, limit: number): string => {
  const from = Math.max(0, text.length - limit)
  return text.slice(from > 0 && leading(text.charCodeAt(from - 1)) ? from + 1 : from)
}

/**
 * Shortens an already-shortened text from the middle, counting against the
 * whole it came from.
 *
 * A value can be bounded twice: once where the host copies it out of the
 * sandbox, and again where the frame apportions its print budget across the
 * statements that share it. Counting the second reduction against what survived
 * the first would report a value as smaller than it is — the exact dishonesty
 * this module exists to abolish — so `whole` is stated by the caller, which is
 * the only place that still knows it, and the notice always names the original
 * size.
 *
 * `text` must be the head and tail of the original, in order: every reduction
 * here keeps both ends, so slicing the ends of a reduced value is the same as
 * slicing the ends of the value it came from.
 *
 * The count is what the two ends actually left behind rather than `whole -
 * limit`, because a cut that stopped short of a surrogate pair keeps a unit or
 * two fewer than the limit allowed and the notice names the real number.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export const middleFrom = (text: string, whole: number, limit: number, recall: string): string => {
  if (whole <= limit) return text
  const edge = Math.floor(limit / 2)
  const head = headSlice(text, edge)
  const tail = tailSlice(text, edge)
  return `${head}\n… ${
    whole - head.length - tail.length
  } of ${whole} bytes elided from the middle. ${recall} …\n${tail}`
}

/**
 * The most one {@link middleFrom} notice can cost, for a value of this size.
 *
 * A caller apportioning one budget across several values has to reserve the
 * notices before it can hand out the rest, or it hands out bytes the notices
 * then take back and something downstream cuts the notice in half. The bound is
 * exact: the dropped count is never larger than the whole, so the notice for a
 * value shortened to nothing is the longest notice that value can produce.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export const noticeCost = (whole: number, recall: string): number => middleFrom("", whole, 0, recall).length

/**
 * Shortens text from the middle, keeping both ends.
 *
 * The two ends are where a file excerpt, a diff, or a test log identifies
 * itself; the middle is where the repetition is. `recall` is the sentence that
 * says how to see what was dropped.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export const middle = (text: string, limit: number, recall: string): string =>
  middleFrom(text, text.length, limit, recall)

/**
 * Shortens text from the end, keeping the head.
 *
 * Used for the one-line summaries a ledger prints, where the head is the whole
 * of what identifies the line and the tail is detail.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export const head = (text: string, limit: number, recall: string): string => {
  if (text.length <= limit) return text
  const kept = headSlice(text, limit)
  return `${kept}… [+${text.length - kept.length}b, ${recall}]`
}
