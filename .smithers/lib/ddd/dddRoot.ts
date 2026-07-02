import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Resolve the repo root for docs-driven-development scripts. Starts at
 * process.cwd() (or the given directory) and walks up until it finds
 * `.smithers/spec/features.json`, so the scripts work when invoked from the
 * repo root, from `.smithers/`, or from any subdirectory.
 */
export function dddRoot(start: string = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(resolve(dir, ".smithers/spec/features.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `docs-driven-development: could not find .smithers/spec/features.json walking up from ${start}. Run from the smithers repo.`,
  );
}
