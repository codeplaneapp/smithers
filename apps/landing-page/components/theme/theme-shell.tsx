"use client";

import { ThemePlayground } from "@/components/theme/theme-playground";
import { ThemeProvider } from "@/components/theme/theme-provider";

export function ThemeShell({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      {children}
      <ThemePlayground />
    </ThemeProvider>
  );
}
