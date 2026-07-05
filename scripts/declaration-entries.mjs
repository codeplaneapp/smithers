// Shared tsup entry-map builder for packages that emit ONE declaration file per
// source module (so `pkg/<subpath>` resolves real types via a `"./*"` exports
// wildcard). Walks `sourceRoot` and maps each `.js`/`.ts` module to its own
// declaration entry.
//
// Non-source files under the tree (READMEs, JSON, assets) are skipped — only
// `.js`/`.ts` modules become declaration entries. Throws on the one thing that
// genuinely breaks the emit: a `.js`/`.ts` twin sharing a basename (both map to
// the same key, so one's emitted `.d.ts` would clobber the other's — the classic
// runtime/type-twin collision).
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
      // Only .js/.ts modules produce declarations; skip .d.ts and any
      // non-source file that legitimately lives under src/ (READMEs, JSON, …).
      if (path.endsWith(".d.ts") || (!path.endsWith(".js") && !path.endsWith(".ts"))) {
        continue;
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
