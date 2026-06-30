import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Theme = "light" | "dark";
export type Layout = "normal" | "sidebar";

type PreferencesState = {
  theme: Theme;
  layout: Layout;
  toggleTheme: () => void;
  toggleLayout: () => void;
  setLayout: (layout: Layout) => void;
};

/** The OS preference, used as the default before the user picks a theme. */
function systemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/**
 * Theme and layout on the `local` medium: persisted to localStorage so a reload
 * keeps the choice. The pre-paint script in index.html reads the same
 * "smithers.prefs" blob to resolve the theme before React boots (no flash).
 */
export const usePreferencesStore = create<PreferencesState>()(
  persist(
    (set) => ({
      theme: systemTheme(),
      layout: "normal",
      toggleTheme: () =>
        set((state) => ({ theme: state.theme === "dark" ? "light" : "dark" })),
      toggleLayout: () =>
        set((state) => ({
          layout: state.layout === "sidebar" ? "normal" : "sidebar",
        })),
      setLayout: (layout) => set({ layout }),
    }),
    { name: "smithers.prefs" },
  ),
);

// DOM sync without an effect: write data-theme now and on every change. The
// index.html observer mirrors data-theme onto the mobile theme-color meta.
function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}
applyTheme(usePreferencesStore.getState().theme);
usePreferencesStore.subscribe((state) => applyTheme(state.theme));
