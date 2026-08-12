import { useSyncExternalStore } from "react";
import { DEFAULT_THEME_KEY } from "../styles";
import { resolvePalette, subscribePalette, type ResolvedPalette } from "./resolvePalette";

/** Reactive bridge for adapters that use literal palette colors. */
export function useResolvedPalette(): ResolvedPalette {
  return useSyncExternalStore(subscribePalette, resolvePalette, () => DEFAULT_THEME_KEY);
}
