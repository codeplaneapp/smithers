import { hexAlpha, rgbChannels } from "./rgbChannels.ts";

/** Parsed 0-255 srgb channels. */
export type Rgb = readonly [number, number, number];

/** WCAG 2.x relative luminance of already-parsed 0-255 channels. */
export function relativeLuminanceOf(channels: Rgb): number {
  const [red, green, blue] = channels.map((channel) => {
    const encoded = channel / 255;
    return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
  });
  return red! * 0.2126 + green! * 0.7152 + blue! * 0.0722;
}

function opaqueChannels(color: string, role: string): [number, number, number] {
  if (hexAlpha(color) !== 1) {
    throw new TypeError(
      `contrastRatio needs an opaque ${role}; composite the alpha yourself, received ${JSON.stringify(color)}`,
    );
  }
  return rgbChannels(color);
}

/**
 * WCAG 2.x contrast ratio between two opaque colors, from 1 to 21.
 *
 * Both arguments must be opaque `#rgb` or `#rrggbb` (or `#rrggbbaa` with
 * `aa === ff`). A translucent color has no contrast ratio of its own, so
 * passing one throws instead of scoring the dropped alpha: `#00000000` against
 * white is not 21:1, it is whatever the invisible text sits on.
 *
 * @throws {TypeError} when either argument is not an opaque hex color.
 */
export function contrastRatio(foreground: string, background: string): number {
  return contrastRatioOf(opaqueChannels(foreground, "foreground"), opaqueChannels(background, "background"));
}

/**
 * The same ratio from already-parsed channels, so a caller mixing colors can
 * score the exact result instead of the rounded hex the browser never sees.
 */
export function contrastRatioOf(foreground: Rgb, background: Rgb): number {
  const a = relativeLuminanceOf(foreground);
  const b = relativeLuminanceOf(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
