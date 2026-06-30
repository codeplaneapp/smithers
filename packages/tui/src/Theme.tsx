import { createContext, useContext, useState, type ReactNode } from "react";

export type ThemeMode = "dark" | "light";

type ThemeContextValue = {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
};

const ThemeContext = createContext<ThemeContextValue>({
  mode: "dark",
  setMode: () => {},
});

export function Theme({ children }: { children?: ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>("dark");
  return <ThemeContext.Provider value={{ mode, setMode }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
