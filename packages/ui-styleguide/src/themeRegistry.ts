import type { SmithersTheme } from "./SmithersTheme.ts";
import { catppuccin } from "./themes/catppuccin.ts";
import { fucory } from "./themes/fucory.ts";
import { github } from "./themes/github.ts";
import { gruvbox } from "./themes/gruvbox.ts";
import { nightOwl } from "./themes/nightOwl.ts";
import { one } from "./themes/one.ts";
import { rosePine } from "./themes/rosePine.ts";
import { solarized } from "./themes/solarized.ts";

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
