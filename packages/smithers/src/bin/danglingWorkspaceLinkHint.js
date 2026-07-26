import { existsSync, lstatSync, readdirSync, readlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Diagnose the "dangling workspace link" failure mode: a workspace-linked
 * dependency dir (e.g. `node_modules/@smithers-orchestrator/cli`) is a symlink
 * whose target no longer exists — typically because something rewrote the
 * links to point into a git worktree that has since been removed. Bun then
 * fails the import with a bare `ENOENT reading ".../@smithers-orchestrator/cli"`,
 * which says nothing about the fix.
 *
 * Walks up from `startDir` to the nearest `node_modules` that contains
 * `@smithers-orchestrator` or `smithers-orchestrator`, scans those entries for
 * dangling symlinks, and returns an actionable message naming the broken
 * links, their dead targets, and the repair (`pnpm install`). Returns `null`
 * when no dangling link is found (the import failure has some other cause).
 *
 * @param {string} startDir directory to walk up from (usually the bin's dir)
 * @returns {string | null}
 */
export function danglingWorkspaceLinkHint(startDir) {
  let current = resolve(startDir);
  while (true) {
    const nodeModules = join(current, "node_modules");
    const dangling = collectDanglingLinks(nodeModules);
    if (dangling.length > 0) {
      const shown = dangling.slice(0, 5);
      const lines = [
        `smithers: found ${dangling.length} dangling workspace link${dangling.length === 1 ? "" : "s"} under ${nodeModules}:`,
        ...shown.map(({ linkPath, target }) => `  ${linkPath} -> ${target} (target no longer exists)`),
      ];
      if (dangling.length > shown.length) {
        lines.push(`  ...and ${dangling.length - shown.length} more`);
      }
      lines.push(
        "This usually means the links were rewritten to point into a git worktree that has since been removed.",
        "Fix: run `pnpm install` at the workspace root to restore the workspace links.",
      );
      return lines.join("\n");
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

/**
 * @param {string} nodeModules
 * @returns {{ linkPath: string; target: string }[]}
 */
function collectDanglingLinks(nodeModules) {
  /** @type {{ linkPath: string; target: string }[]} */
  const dangling = [];
  const candidateDirs = [join(nodeModules, "@smithers-orchestrator"), nodeModules];
  for (const dir of candidateDirs) {
    /** @type {string[]} */
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (dir === nodeModules && entry !== "smithers-orchestrator" && entry !== "smithers-workflows") {
        continue;
      }
      const linkPath = join(dir, entry);
      /** @type {import("node:fs").Stats} */
      let stats;
      try {
        stats = lstatSync(linkPath);
      } catch {
        continue;
      }
      if (!stats.isSymbolicLink()) {
        continue;
      }
      // existsSync follows the link: false for a dangling symlink.
      if (existsSync(linkPath)) {
        continue;
      }
      let target = "?";
      try {
        target = readlinkSync(linkPath);
      } catch {
        // Keep the placeholder; the link path alone is actionable.
      }
      dangling.push({ linkPath, target });
    }
  }
  return dangling;
}
