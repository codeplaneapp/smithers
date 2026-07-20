// Shared tsup entry-map builder for packages that emit ONE declaration file per
// source module (so `pkg/<subpath>` resolves real types via a `"./*"` exports
// wildcard). Walks `sourceRoot` and maps each `.js`/`.ts` module to its own
// declaration entry.
//
// Only `.js`/`.ts` modules become declaration entries. Non-source files are
// limited to a known allow-list (`.md`, `.json`) that is skipped; any other,
// unrecognized module-like extension (`.tsx`/`.jsx`/`.mts`/`.cts`, …) throws so
// it can't silently ship with no per-file `.d.ts`. Also throws on the one thing
// that genuinely breaks the emit: a `.js`/`.ts` twin sharing a basename (both map
// to the same key, so one's emitted `.d.ts` would clobber the other's — the
// classic runtime/type-twin collision).
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
      // Only .js/.ts modules produce declarations. Skip .d.ts and the known
      // non-source files that legitimately live under src/ (READMEs, JSON); any
      // other module-like extension (.tsx/.jsx/.mts/.cts, …) would emit no
      // per-file .d.ts and silently ship untyped, so fail loudly instead.
      if (path.endsWith(".d.ts")) continue;
      if (path.endsWith(".md") || path.endsWith(".json")) continue;
      if (!path.endsWith(".js") && !path.endsWith(".ts")) {
        const rel = relative(sourceRoot, path).split(sep).join("/");
        throw new Error(
          `declarationEntries: unexpected source file "${rel}" — only .js/.ts modules produce per-file declarations; author components as .js, or extend the walker to handle this extension.`,
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
