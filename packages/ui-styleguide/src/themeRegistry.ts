import type { SmithersTheme } from "./SmithersTheme";
import { catppuccin } from "./themes/catppuccin";
import { fucory } from "./themes/fucory";
import { github } from "./themes/github";
import { gruvbox } from "./themes/gruvbox";
import { nightOwl } from "./themes/nightOwl";
import { one } from "./themes/one";
import { rosePine } from "./themes/rosePine";
import { solarized } from "./themes/solarized";

export const DEFAULT_THEME_KEY = "night-owl";

/** Ordered palette registry used by CSS emitters and widget adapters. */
export const themeRegistry = {
  "night-owl": nightOwl,
  fucory,
  one,
  github,
  catppuccin,
  solarized,
  gruvbox,
  "rose-pine": rosePine,
} satisfies Record<string, SmithersTheme>;
