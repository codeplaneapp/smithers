"use client";

import { applyThemeToDocument } from "@/lib/theme/apply-theme";
import {
  loadThemePreferences,
  saveThemePreferences,
} from "@/lib/theme/storage";
import {
  DEFAULT_THEME,
  type ThemeFont,
  type ThemePalette,
  type ThemePreferences,
  type ThemeRadius,
} from "@/lib/theme/types";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

type ThemeContextValue = {
  theme: ThemePreferences;
  setPalette: (palette: ThemePalette) => void;
  setFont: (font: ThemeFont) => void;
  setRadius: (radius: ThemeRadius) => void;
  resetTheme: () => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function persistTheme(theme: ThemePreferences) {
  applyThemeToDocument(theme);
  saveThemePreferences(theme);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<ThemePreferences>(() => loadThemePreferences());

  const updateTheme = useCallback((patch: Partial<ThemePreferences>) => {
    setTheme((current) => {
      const next = { ...current, ...patch };
      persistTheme(next);
      return next;
    });
  }, []);

  const setPalette = useCallback(
    (palette: ThemePalette) => updateTheme({ palette }),
    [updateTheme],
  );

  const setFont = useCallback(
    (font: ThemeFont) => updateTheme({ font }),
    [updateTheme],
  );

  const setRadius = useCallback(
    (radius: ThemeRadius) => updateTheme({ radius }),
    [updateTheme],
  );

  const resetTheme = useCallback(() => {
    setTheme(DEFAULT_THEME);
    persistTheme(DEFAULT_THEME);
  }, []);

  const value = useMemo(
    () => ({
      theme,
      setPalette,
      setFont,
      setRadius,
      resetTheme,
    }),
    [theme, setPalette, setFont, setRadius, resetTheme],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return context;
}
