import { useSyncExternalStore } from "react";
import { resolvePalette, subscribePalette, type ResolvedPalette } from "./resolvePalette";

/** Reactive bridge for adapters that use literal palette colors. */
export function useResolvedPalette(): ResolvedPalette {
  return useSyncExternalStore(subscribePalette, resolvePalette, () => "night-owl");
}
