export type ThemePalette = "brass" | "teal" | "blue";

export type ThemeFont = "editorial" | "atkinson" | "instrument";

export type ThemeRadius = "none" | "default";

export type ThemePreferences = {
  palette: ThemePalette;
  font: ThemeFont;
  radius: ThemeRadius;
};

export const DEFAULT_THEME: ThemePreferences = {
  palette: "brass",
  font: "editorial",
  radius: "none",
};
