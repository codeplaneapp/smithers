import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Resolve the repo root for docs-driven-development scripts. Starts at
 * process.cwd() (or the given directory) and walks up until it finds
 * `.smithers/spec/features.json`, so the scripts work when invoked from the
 * repo root, from `.smithers/`, or from any subdirectory.
 */
export function dddRoot(start: string = process.cwd()): string {
  const found = findDddRoot(start);
  if (found) return found;
  throw new Error(
    `docs-driven-development: could not find .smithers/spec/features.json walking up from ${start}. Run from the smithers repo.`,
  );
}

/**
 * Like dddRoot, but falls back to the start directory instead of throwing.
 * Workflows use this so they can run in a repo whose spec does not exist yet
 * (ddd-generate-docs creates it) and still fail later with a task-level error
 * instead of dying at module import.
 */
export function dddRootOrCwd(start: string = process.cwd()): string {
  return findDddRoot(start) ?? resolve(start);
}

function findDddRoot(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(resolve(dir, ".smithers/spec/features.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
