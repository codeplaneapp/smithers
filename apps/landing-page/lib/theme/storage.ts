import { THEME_STORAGE_KEY } from "@/lib/theme/config";
import {
  DEFAULT_THEME,
  type ThemeFont,
  type ThemePalette,
  type ThemePreferences,
  type ThemeRadius,
} from "@/lib/theme/types";

const PALETTES: ThemePalette[] = ["brass", "teal", "blue"];
const FONTS: ThemeFont[] = ["editorial", "atkinson", "instrument"];
const RADII: ThemeRadius[] = ["none", "default"];

function isPalette(value: unknown): value is ThemePalette {
  return typeof value === "string" && PALETTES.includes(value as ThemePalette);
}

function isFont(value: unknown): value is ThemeFont {
  return typeof value === "string" && FONTS.includes(value as ThemeFont);
}

function isRadius(value: unknown): value is ThemeRadius {
  return typeof value === "string" && RADII.includes(value as ThemeRadius);
}

export function loadThemePreferences(): ThemePreferences {
  if (typeof window === "undefined") {
    return DEFAULT_THEME;
  }

  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (!raw) return DEFAULT_THEME;

    const parsed = JSON.parse(raw) as Partial<ThemePreferences>;

    return {
      palette: isPalette(parsed.palette) ? parsed.palette : DEFAULT_THEME.palette,
      font: isFont(parsed.font) ? parsed.font : DEFAULT_THEME.font,
      radius: isRadius(parsed.radius) ? parsed.radius : DEFAULT_THEME.radius,
    };
  } catch {
    return DEFAULT_THEME;
  }
}

export function saveThemePreferences(theme: ThemePreferences) {
  window.localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(theme));
}
