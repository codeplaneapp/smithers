import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";

/**
 * Bun compiles JSX using the nearest `tsconfig.json`, so a `.tsx` file in
 * `packages/tui` renders through `@opentui/react` while a user workflow renders
 * through `smthrs`. The Node loader has to make the same choice or every
 * compiled file would target one runtime and break the other.
 *
 * A `@jsxImportSource` pragma in the file wins over this lookup: esbuild reads
 * the pragma itself and overrides the `jsxImportSource` option.
 *
 * @type {Map<string, string>} directory -> resolved import source
 */
const cache = new Map();

const DEFAULT_JSX_IMPORT_SOURCE = "react";

/**
 * Strip comments and trailing commas so a hand-written tsconfig parses. Node
 * has no JSONC reader and tsconfig files in this repo and in user projects
 * routinely carry both.
 *
 * @param {string} text
 */
function parseJsonc(text) {
  const stripped = text
    .replace(/\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g, (match, comment) => (comment ? "" : match))
    .replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(stripped);
}

/**
 * Read `compilerOptions.jsxImportSource` from the nearest `tsconfig.json` at or
 * above `fromDir`. Returns `react` when no tsconfig declares one, which matches
 * Bun's default and keeps library `.tsx` compiling the way its author meant.
 *
 * @param {string} fromDir
 * @returns {string}
 */
export function resolveJsxImportSource(fromDir) {
  const cached = cache.get(fromDir);
  if (cached) return cached;
  const root = parse(fromDir).root;
  const visited = [];
  let dir = fromDir;
  let resolved = DEFAULT_JSX_IMPORT_SOURCE;
  while (true) {
    visited.push(dir);
    const configPath = join(dir, "tsconfig.json");
    if (existsSync(configPath)) {
      try {
        const config = parseJsonc(readFileSync(configPath, "utf8"));
        const declared = config?.compilerOptions?.jsxImportSource;
        if (typeof declared === "string" && declared) {
          resolved = declared;
          break;
        }
      } catch {
        // An unreadable tsconfig is not worth failing the import over; keep walking.
      }
    }
    if (dir === root) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const entry of visited) cache.set(entry, resolved);
  return resolved;
}
