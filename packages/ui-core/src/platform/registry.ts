import type { Platform } from "./types.ts";

/**
 * Module-singleton DI seam, mirroring multi's `setFlowExecutionServices`
 * pattern: each shell (multi's web app, packages/tui's terminal app) calls
 * `setPlatform` once at boot with its concrete `Platform` implementation.
 * Plain functions rather than a React context: most ui-core callers are
 * non-render code (stores, bridges, pure modules) that need the platform
 * before or outside of any component tree.
 */
let currentPlatform: Platform | null = null;

export function setPlatform(platform: Platform): void {
  currentPlatform = platform;
}

export function getPlatform(): Platform {
  if (!currentPlatform) {
    throw new Error("Platform not set. Call setPlatform(...) once at shell boot before using @smthrs/ui-core.");
  }
  return currentPlatform;
}

/** Test-only: clear the singleton between test cases so platform state doesn't leak across them. */
export function resetPlatformForTests(): void {
  currentPlatform = null;
}
