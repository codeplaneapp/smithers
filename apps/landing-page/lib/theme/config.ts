import type { ThemeFont, ThemePalette, ThemeRadius } from "@/lib/theme/types";

export type ThemeOption<T extends string> = {
  value: T;
  label: string;
  description?: string;
};

export const PALETTE_OPTIONS: ThemeOption<ThemePalette>[] = [
  {
    value: "brass",
    label: "Brass",
    description: "Current — obsidian & pilot gold",
  },
  {
    value: "teal",
    label: "Teal",
    description: "Deep green-cyan runtime",
  },
  {
    value: "blue",
    label: "Blue",
    description: "Midnight & steel blue",
  },
];

export const FONT_OPTIONS: ThemeOption<ThemeFont>[] = [
  {
    value: "editorial",
    label: "Editorial",
    description: "Newsreader + DM Sans",
  },
  {
    value: "atkinson",
    label: "Atkinson",
    description: "Atkinson Hyperlegible",
  },
  {
    value: "instrument",
    label: "Instrument",
    description: "Instrument Serif + Sans",
  },
];

export const RADIUS_OPTIONS: ThemeOption<ThemeRadius>[] = [
  { value: "none", label: "0", description: "Brutalist — hard corners" },
  { value: "default", label: "Clean", description: "Standard shadcn radius" },
];

export const THEME_STORAGE_KEY = "smithers-theme-preferences";
