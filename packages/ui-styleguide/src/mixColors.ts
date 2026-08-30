import { rgbChannels } from "./rgbChannels.ts";

function toHex(channels: readonly number[]): string {
  return `#${channels
    .map((c) =>
      Math.round(Math.min(255, Math.max(0, c)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/**
 * The srgb color-mix the house recipes use: `amount` of `foreground` over
 * `background`, matching `color-mix(in srgb, fg <amount>%, bg)` with
 * `amount` given as a 0-1 fraction. Alpha channels on the inputs are ignored.
 */
export function mixColors(foreground: string, background: string, amount: number): string {
  const fg = rgbChannels(foreground);
  const bg = rgbChannels(background);
  return toHex(fg.map((channel, index) => channel * amount + bg[index]! * (1 - amount)));
}
