import type { Rgb } from "./contrastRatio.ts";
import { rgbChannels } from "./rgbChannels.ts";

function toHex(channels: readonly number[]): string {
  return `#${
    channels
      .map((c) =>
        Math.round(Math.min(255, Math.max(0, c)))
          .toString(16)
          .padStart(2, "0")
      )
      .join("")
  }`;
}

function checkedAmount(amount: number): number {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0 || amount > 1) {
    throw new TypeError(`mix amount must be a finite fraction from 0 to 1, received ${String(amount)}`);
  }
  return amount;
}

/**
 * The exact srgb color-mix, in unrounded 0-255 channels.
 *
 * `mixColors` formats these to hex, which rounds each channel; a browser
 * evaluating `color-mix(in srgb, ...)` does not. Score contrast against these
 * channels so the oracle cannot certify a value the browser renders below the
 * threshold.
 *
 * @throws {TypeError} when either color is not a hex color, or `amount` is not
 *   a finite fraction from 0 to 1.
 */
export function mixChannels(foreground: string, background: string, amount: number): Rgb {
  const fraction = checkedAmount(amount);
  const fg = rgbChannels(foreground);
  const bg = rgbChannels(background);
  return fg.map((channel, index) => channel * fraction + bg[index]! * (1 - fraction)) as unknown as Rgb;
}

/**
 * The srgb color-mix the house recipes use: `amount` of `foreground` over
 * `background`, matching `color-mix(in srgb, fg <amount>%, bg)` with
 * `amount` given as a 0-1 fraction. Alpha channels on the inputs are ignored,
 * and the result is rounded to a `#rrggbb` string.
 *
 * @throws {TypeError} when either color is not a hex color, or `amount` is not
 *   a finite fraction from 0 to 1.
 */
export function mixColors(foreground: string, background: string, amount: number): string {
  return toHex(mixChannels(foreground, background, amount));
}
