import type { ThemePreferences } from "@/lib/theme/types";

export function applyThemeToDocument(theme: ThemePreferences) {
  const root = document.documentElement;

  root.dataset.palette = theme.palette;
  root.dataset.font = theme.font;
  root.dataset.radius = theme.radius;
}

export function readThemeFromDocument(): Partial<ThemePreferences> {
  const root = document.documentElement;

  return {
    palette: root.dataset.palette as ThemePreferences["palette"] | undefined,
    font: root.dataset.font as ThemePreferences["font"] | undefined,
    radius: root.dataset.radius as ThemePreferences["radius"] | undefined,
  };
}
