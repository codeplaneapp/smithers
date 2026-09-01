/**
 * Anchored so a trailing character is rejected rather than silently sliced off.
 * `#rgb`, `#rrggbb`, and `#rrggbbaa` are the three forms the theme files and
 * the house recipes use; everything else is a caller mistake worth naming.
 */
const HEX_COLOR = /^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i;

/**
 * Parse `#rgb`, `#rrggbb`, or `#rrggbbaa` into 0-255 channels.
 *
 * Alpha is dropped, so a caller that needs alpha semantics must composite
 * before calling. Any other input throws rather than returning `NaN` channels:
 * a `NaN` ratio silently compares `false` against every threshold, which reads
 * as "fails contrast" instead of "unsupported input".
 *
 * @throws {TypeError} when `color` is not one of the three hex forms.
 */
export function rgbChannels(color: string): [number, number, number] {
  if (typeof color !== "string" || !HEX_COLOR.test(color)) {
    throw new TypeError(
      `expected a hex color (#rgb, #rrggbb, or #rrggbbaa), received ${JSON.stringify(color)}`,
    );
  }
  const hex = color.slice(1);
  const full = hex.length === 3
    ? hex
      .split("")
      .map((channel) => channel + channel)
      .join("")
    : hex.slice(0, 6);
  return [0, 2, 4].map((offset) => Number.parseInt(full.slice(offset, offset + 2), 16)) as [number, number, number];
}

/**
 * The alpha channel of a hex color as a 0-1 fraction: 1 for `#rgb` and
 * `#rrggbb`, the parsed byte for `#rrggbbaa`.
 *
 * @throws {TypeError} when `color` is not one of the three hex forms.
 */
export function hexAlpha(color: string): number {
  if (typeof color !== "string" || !HEX_COLOR.test(color)) {
    throw new TypeError(
      `expected a hex color (#rgb, #rrggbb, or #rrggbbaa), received ${JSON.stringify(color)}`,
    );
  }
  const hex = color.slice(1);
  return hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1;
}
