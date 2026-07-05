// Shared tsup entry-map builder for packages that emit ONE declaration file per
// source module (so `pkg/<subpath>` resolves real types via a `"./*"` exports
// wildcard). Walks `sourceRoot` and maps each `.js`/`.ts` module to its own
// declaration entry.
//
// Throws rather than silently misbehaving on the two ways this can go wrong:
//   - a `.js`/`.ts` twin sharing a basename (both map to the same key, so one's
//     emitted `.d.ts` would clobber the other's — the classic runtime/type-twin
//     collision), and
//   - an unexpected file extension under the source tree (a signal the walk is
//     picking up something the emit isn't set up to handle).
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * @param {string} [sourceRoot]
 * @returns {Record<string, string>}
 */
export function declarationEntries(sourceRoot = "src") {
  /** @type {Record<string, string>} */
  const entries = {};
  /** @type {Map<string, string>} key -> the source path that first claimed it */
  const claimedBy = new Map();
  /** @param {string} dir */
  const walk = (dir) => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (path.endsWith(".d.ts")) {
        continue;
      }
      if (!path.endsWith(".js") && !path.endsWith(".ts")) {
        throw new Error(
          `declarationEntries: unexpected file extension at ${path}; only .js/.ts sources (and .d.ts, skipped) are supported under ${sourceRoot}/`,
        );
      }
      const relativePath = relative(sourceRoot, path).split(sep).join("/");
      const key = relativePath.replace(/\.(js|ts)$/, "");
      const existing = claimedBy.get(key);
      if (existing) {
        throw new Error(
          `declarationEntries: declaration key "${key}" is claimed by both ${existing} and ${relativePath}; a .js/.ts twin sharing a basename would overwrite the other's emitted .d.ts. Rename one (e.g. the type twin to <name>Types.ts).`,
        );
      }
      claimedBy.set(key, relativePath);
      entries[key] = `${sourceRoot}/${relativePath}`;
    }
  };
  walk(sourceRoot);
  return entries;
}
