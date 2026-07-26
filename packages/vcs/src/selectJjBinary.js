import { existsSync } from "node:fs";

/**
 * Select among already-discovered jj candidates. Kept separate from package
 * resolution so the fallback ordering has a deterministic unit seam.
 *
 * Internal: intentionally NOT re-exported from the package barrel.
 *
 * @param {{ override?: string, bundled?: string | null, overrideExists?: typeof existsSync }} candidates
 * @returns {import("./ResolvedBinary.js").ResolvedBinary}
 */
export function selectJjBinary({ override, bundled, overrideExists = existsSync }) {
  if (override && overrideExists(override)) return { path: override, source: "env" };
  if (bundled) return { path: bundled, source: "bundled" };
  return { path: "jj", source: "path" };
}
