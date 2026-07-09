/** Single source of truth for Smithers brand tokens (Brass Lieutenant). */

export const smithersMarkPath =
  "M7.86 9.58 42.26 26.78 39.22 28.3 4.81 11.1Z M8.78 19.7 43.19 36.9 40.14 38.42 5.74 21.22Z";

export const brandPalette = {
  name: "Brass Lieutenant",
  canvas: "#0c0a09",
  surface: "#161310",
  ink: "#f2ede4",
  inkMuted: "#9a9288",
  accent: "#cab16a",
  accentMuted: "#8a7a52",
  border: "#2a2620",
  onAccent: "#0c0a09",
} as const;

export const brandWordmark = "smithers";

/** OG image generation — same palette, lowercase hex for CSS. */
export const ogBrand = {
  canvas: brandPalette.canvas,
  surface: brandPalette.surface,
  ink: brandPalette.ink,
  inkMuted: brandPalette.inkMuted,
  gold: brandPalette.accent,
  goldMuted: brandPalette.accentMuted,
  line: brandPalette.border,
} as const;
