import { createContext, useContext } from "react";
import type { CliRenderer } from "@opentui/core";

const RendererContext = createContext<CliRenderer | null>(null);

export const RendererProvider = RendererContext.Provider;

export function useRenderer(): CliRenderer {
  const ctx = useContext(RendererContext);
  if (!ctx) throw new Error("useRenderer must be used inside <RendererProvider>");
  return ctx;
}
