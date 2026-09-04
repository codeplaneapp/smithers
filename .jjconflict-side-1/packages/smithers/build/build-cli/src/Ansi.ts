/**
 * ANSI terminal primitives for the human renderers.
 *
 * A colour palette that degrades to the identity function, capability
 * detection that follows the `NO_COLOR` and `FORCE_COLOR` conventions the
 * `supports-color` package and Turborepo's `ColorConfig::infer` codified, and
 * the three cursor motions the live renderer needs. Raw escape sequences
 * rather than a dependency: the whole surface is six colours, two
 * attributes, and a handful of control sequences, and every consumer is
 * inside this package.
 *
 * @since 0.1.0
 */

/**
 * Text decorators. Each returns its input wrapped in the SGR sequences for one
 * attribute, or the input unchanged when the palette is {@link none}.
 *
 * @category models
 * @since 0.1.0
 */
export interface Palette {
  readonly enabled: boolean
  readonly bold: (text: string) => string
  readonly dim: (text: string) => string
  readonly red: (text: string) => string
  readonly green: (text: string) => string
  readonly yellow: (text: string) => string
  readonly blue: (text: string) => string
  readonly magenta: (text: string) => string
  readonly cyan: (text: string) => string
  readonly inverse: (text: string) => string
}

/**
 * The process environment slice the detectors read.
 *
 * @category models
 * @since 0.1.0
 */
export type Environment = Readonly<Record<string, string | undefined>>

const sgr = (open: number, close: number) => (text: string): string => `\u001b[${open}m${text}\u001b[${close}m`

const identity = (text: string): string => text

/**
 * The palette that emits escape sequences.
 *
 * @category constants
 * @since 0.1.0
 */
export const colors: Palette = {
  enabled: true,
  bold: sgr(1, 22),
  dim: sgr(2, 22),
  red: sgr(31, 39),
  green: sgr(32, 39),
  yellow: sgr(33, 39),
  blue: sgr(34, 39),
  magenta: sgr(35, 39),
  cyan: sgr(36, 39),
  inverse: sgr(7, 27)
}

/**
 * The palette that leaves text alone.
 *
 * @category constants
 * @since 0.1.0
 */
export const none: Palette = {
  enabled: false,
  bold: identity,
  dim: identity,
  red: identity,
  green: identity,
  yellow: identity,
  blue: identity,
  magenta: identity,
  cyan: identity,
  inverse: identity
}

const nonEmpty = (value: string | undefined): boolean => value !== undefined && value !== ""

/**
 * Whether `FORCE_COLOR` asks for colour. `0` and `false` refuse it, any other
 * present value requests it, and an absent variable says nothing.
 *
 * @category detection
 * @since 0.1.0
 */
export const forcedColor = (env: Environment): boolean | undefined => {
  const value = env["FORCE_COLOR"]
  if (value === undefined) return undefined
  return value !== "0" && value !== "false"
}

/**
 * Whether colour may be emitted on a stream.
 *
 * `NO_COLOR` set to anything but the empty string wins, then `FORCE_COLOR`,
 * then `TERM=dumb` refuses, and otherwise the answer is whether the stream is
 * a terminal. That is the order `supports-color` applies and the one
 * `no-color.org` asks for.
 *
 * @category detection
 * @since 0.1.0
 */
export const colorSupport = (env: Environment, isTTY: boolean): boolean => {
  if (nonEmpty(env["NO_COLOR"])) return false
  const forced = forcedColor(env)
  if (forced !== undefined) return forced
  if (env["TERM"] === "dumb") return false
  return isTTY
}

/**
 * The palette a stream gets: {@link colors} when {@link colorSupport} allows
 * it, {@link none} otherwise.
 *
 * @category detection
 * @since 0.1.0
 */
export const palette = (env: Environment, isTTY: boolean): Palette => colorSupport(env, isTTY) ? colors : none

const escapePattern = /\u001b\[[0-9;?]*[A-Za-z]/g

/**
 * Removes every escape sequence, leaving the visible text.
 *
 * @category text
 * @since 0.1.0
 */
export const strip = (text: string): string => text.replace(escapePattern, "")

/**
 * The number of terminal cells a string occupies, counting code points and
 * ignoring escape sequences. The glyphs the renderers use are all single
 * width, so this is exact for their output and approximate for arbitrary
 * tool output.
 *
 * @category text
 * @since 0.1.0
 */
export const visibleWidth = (text: string): number => [...strip(text)].length

/**
 * Cuts a string to `columns` visible cells, ending it with an ellipsis and a
 * reset when it was cut. Escape sequences pass through uncounted so a
 * coloured line truncates on its text rather than on its control bytes.
 *
 * @category text
 * @since 0.1.0
 */
export const truncate = (text: string, columns: number): string => {
  if (visibleWidth(text) <= columns) return text
  const limit = Math.max(0, columns - 1)
  let out = ""
  let seen = 0
  let index = 0
  let styled = false
  while (index < text.length && seen < limit) {
    if (text.startsWith("\u001b[", index)) {
      const end = text.slice(index).search(/[A-Za-z]/)
      if (end === -1) break
      out += text.slice(index, index + end + 1)
      styled = true
      index += end + 1
      continue
    }
    const point = text.codePointAt(index)!
    const char = String.fromCodePoint(point)
    out += char
    seen += 1
    index += char.length
  }
  return `${out}…${styled ? "\u001b[0m" : ""}`
}

/**
 * Moves the cursor up `lines` rows; the empty string for zero.
 *
 * @category cursor
 * @since 0.1.0
 */
export const cursorUp = (lines: number): string => lines > 0 ? `\u001b[${lines}A` : ""

/**
 * Erases from the cursor to the end of the screen.
 *
 * @category cursor
 * @since 0.1.0
 */
export const eraseDown = "\u001b[0J"

/**
 * Hides the cursor while the live region redraws.
 *
 * @category cursor
 * @since 0.1.0
 */
export const hideCursor = "\u001b[?25l"

/**
 * Shows the cursor again.
 *
 * @category cursor
 * @since 0.1.0
 */
export const showCursor = "\u001b[?25h"
