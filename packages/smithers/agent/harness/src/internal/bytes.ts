/**
 * UTF-8 byte measurement and boundary-safe slicing.
 *
 * JavaScript indexes strings in UTF-16 code units, while every bound this
 * harness presents to a model and records in a journal is stated in UTF-8
 * bytes. These helpers keep that unit honest without ever cutting a code point
 * into an invalid string.
 *
 * @since 0.1.0
 * @private
 */

const encoder = new TextEncoder()

/**
 * Measures a string in UTF-8 bytes.
 *
 * @category conversions
 * @since 0.1.0
 * @private
 */
export const size = (text: string): number => encoder.encode(text).byteLength

/**
 * Returns the longest code-point-aligned prefix no wider than `limit` UTF-8 bytes.
 *
 * @category conversions
 * @since 0.1.0
 * @private
 */
export const headSlice = (text: string, limit: number): string => {
  let end = 0
  let used = 0
  for (const character of text) {
    const next = used + size(character)
    if (next > limit) break
    used = next
    end = end + character.length
  }
  return text.slice(0, end)
}

/**
 * Returns the longest code-point-aligned suffix no wider than `limit` UTF-8 bytes.
 *
 * @category conversions
 * @since 0.1.0
 * @private
 */
export const tailSlice = (text: string, limit: number): string => {
  const characters = [...text]
  let used = 0
  let units = 0
  for (let index = characters.length - 1; index >= 0; index--) {
    const character = characters[index]!
    const next = used + size(character)
    if (next > limit) break
    used = next
    units = units + character.length
  }
  return text.slice(text.length - units)
}
