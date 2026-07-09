import { THEME_STORAGE_KEY } from "@/lib/theme/config";
import { DEFAULT_THEME } from "@/lib/theme/types";

/** Inline script applied before paint to avoid theme flash. */
export const themeInitScript = `(function(){try{var k=${JSON.stringify(THEME_STORAGE_KEY)};var d=${JSON.stringify(DEFAULT_THEME)};var t=JSON.parse(localStorage.getItem(k)||"null")||d;var r=document.documentElement;r.dataset.palette=t.palette||d.palette;r.dataset.font=t.font||d.font;r.dataset.radius=t.radius||d.radius;}catch(e){var f=${JSON.stringify(DEFAULT_THEME)};var r=document.documentElement;r.dataset.palette=f.palette;r.dataset.font=f.font;r.dataset.radius=f.radius;}})();`;
