import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

/**
 * Resolve the repo root for docs-driven-development scripts. Starts at
 * process.cwd() (or the given directory) and walks up until it finds
 * `.smithers/spec/features.json` or the DDD pack itself, so the scripts work
 * before the spec has been generated.
 */
export function dddRoot(start: string = process.cwd()): string {
  const found = findDddRoot(start);
  if (found) return found;
  throw new Error(
    `docs-driven-development: could not find the DDD pack walking up from ${start}. ` +
      `Run from a repo whose .smithers/ has the DDD pack installed ` +
      `(.smithers/lib/ddd/build.ts, .smithers/workflows/docs-driven-development.tsx, ` +
      `or .smithers/spec/features.json).`,
  );
}

/**
 * Like dddRoot, but falls back to the start directory instead of throwing.
 * Workflows use this so they can run in a repo whose spec does not exist yet
 * and still fail later with a task-level error
 * instead of dying at module import.
 */
export function dddRootOrCwd(start: string = process.cwd()): string {
  return findDddRoot(start) ?? resolve(start);
}

function findDddRoot(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (isDddRoot(dir)) return dir;
    if (basename(dir) === ".smithers" && isDddPackDir(dir)) return dirname(dir);
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function isDddRoot(dir: string): boolean {
  return (
    existsSync(resolve(dir, ".smithers/spec/features.json")) ||
    existsSync(resolve(dir, ".smithers/spec/content")) ||
    existsSync(resolve(dir, ".smithers/lib/ddd/build.ts")) ||
    existsSync(resolve(dir, ".smithers/workflows/docs-driven-development.tsx"))
  );
}

function isDddPackDir(dir: string): boolean {
  return (
    existsSync(resolve(dir, "spec/features.json")) ||
    existsSync(resolve(dir, "spec/content")) ||
    existsSync(resolve(dir, "lib/ddd/build.ts")) ||
    existsSync(resolve(dir, "workflows/docs-driven-development.tsx"))
  );
}
