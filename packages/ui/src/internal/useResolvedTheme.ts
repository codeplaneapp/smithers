import { useSyncExternalStore } from "react";
import { resolveTheme, subscribeTheme, type ResolvedTheme } from "./resolveTheme";

/** Internal reactive bridge for third-party widget adapters. */
export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribeTheme, resolveTheme, () => "light");
}
