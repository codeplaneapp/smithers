import { resolve } from "node:path";

/**
 * Marker prefixed to the injected notice so the engine never doubles it up
 * (e.g. when a workflow author already includes the notice in the prompt).
 */
export const WORKTREE_ISOLATION_NOTICE_MARKER = "[smithers worktree isolation]";

/**
 * Build the prompt preamble for a task running inside a smithers-managed
 * worktree. Agents dropped into a fresh worktree see no node_modules and,
 * without guidance, improvise dependency sharing by symlinking node_modules
 * from the parent checkout. Installs and "fix the workspace links" loops then
 * write THROUGH those symlinks into the parent checkout's node_modules,
 * replacing its workspace links with absolute links into the worktree. When
 * the worktree is later removed, every one of those links dangles and the
 * parent checkout's CLI and tests break. This notice tells the agent the one
 * safe move (install fresh inside the worktree) and the one forbidden move
 * (touching the parent checkout) before it has a chance to improvise.
 *
 * Returns `null` when the worktree IS the root checkout (nothing to isolate).
 *
 * @param {string} worktreePath absolute path of the task's worktree
 * @param {string} rootDir absolute path of the parent (launch) checkout
 * @returns {string | null}
 */
export function buildWorktreeIsolationNotice(worktreePath, rootDir) {
  if (!worktreePath || !rootDir || resolve(worktreePath) === resolve(rootDir)) {
    return null;
  }
  return [
    `${WORKTREE_ISOLATION_NOTICE_MARKER} Your working directory is an isolated git worktree of the parent checkout at ${rootDir}.`,
    "- Do all reads, writes, installs, builds, and tests inside this worktree.",
    "- Dependencies (node_modules) may be absent here. Install them fresh inside the worktree (e.g. `pnpm install` at the worktree root); the package manager's shared store makes this cheap.",
    `- NEVER symlink node_modules (top-level or per-package) from ${rootDir} into this worktree, and NEVER create, modify, or delete anything under ${rootDir} itself. Shared node_modules links make installs write through into the parent checkout and leave it broken once this worktree is removed.`,
  ].join("\n");
}
