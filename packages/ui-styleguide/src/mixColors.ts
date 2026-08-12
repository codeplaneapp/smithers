/** Parse `#rgb`, `#rrggbb`, or `#rrggbbaa` into 0-255 channels (alpha dropped). */
function parseHex(color: string): [number, number, number] {
  const hex = color.replace("#", "");
  const full =
    hex.length === 3
      ? hex
          .split("")
          .map((c) => c + c)
          .join("")
      : hex.slice(0, 6);
  return [0, 2, 4].map((offset) => Number.parseInt(full.slice(offset, offset + 2), 16)) as [number, number, number];
}

function toHex(channels: readonly number[]): string {
  return `#${channels.map((c) => Math.round(Math.min(255, Math.max(0, c)))
    .toString(16)
    .padStart(2, "0"))
    .join("")}`;
}

/**
 * The srgb color-mix the house recipes use: `amount` of `foreground` over
 * `background`, matching `color-mix(in srgb, fg <amount>%, bg)` with
 * `amount` given as a 0-1 fraction. Alpha channels on the inputs are ignored.
 */
export function mixColors(foreground: string, background: string, amount: number): string {
  const fg = parseHex(foreground);
  const bg = parseHex(background);
  return toHex(fg.map((channel, index) => channel * amount + bg[index]! * (1 - amount)));
}

/** Channel triplet for a hex color, for callers that need raw components. */
export function rgbChannels(color: string): [number, number, number] {
  return parseHex(color);
}
