/**
 * Why a source checkout's `smthrs` suddenly cannot find its own packages.
 *
 * A workspace-linked dependency (`node_modules/@smthrs/control`, say) is a
 * symlink into this repository. Something that rewrites those links to point
 * into a git worktree, and then removes the worktree, leaves them dangling.
 * Node then fails the first import with `ERR_MODULE_NOT_FOUND` naming a
 * package that is right there in the tree, which sends the reader looking for
 * a build problem that does not exist.
 *
 * This is the 0.x `danglingWorkspaceLinkHint` requirement, carried onto the
 * rc.0 shim: walk up to the nearest `node_modules` holding `@smthrs`, report
 * the broken links and their dead targets, and name the repair.
 *
 * @since 1.0.0
 */
import { existsSync, lstatSync, readdirSync, readlinkSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

/** How many broken links the message lists before it summarizes the rest. */
const shownLinks = 5

const danglingLinks = (nodeModules) => {
  const found = []
  // The scope directory holds every first-party package. The `node_modules`
  // directory itself is checked only for the unscoped name, which rc.0
  // publishes as a deprecation notice and a checkout may still link.
  for (const directory of [join(nodeModules, "@smthrs"), nodeModules]) {
    let entries
    try {
      entries = readdirSync(directory)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (directory === nodeModules && entry !== "smthrs") continue
      const linkPath = join(directory, entry)
      let stats
      try {
        stats = lstatSync(linkPath)
      } catch {
        continue
      }
      if (!stats.isSymbolicLink()) continue
      // `existsSync` follows the link, so a dangling one answers false.
      if (existsSync(linkPath)) continue
      let target = "?"
      try {
        target = readlinkSync(linkPath)
      } catch {
        // The link path alone is actionable; keep the placeholder.
      }
      found.push({ linkPath, target })
    }
  }
  return found
}

/**
 * The diagnosis for a checkout whose workspace links point at a directory that
 * is gone, or `null` when the links resolve and the failure has another cause.
 *
 * @param {string} startDirectory Directory to walk up from, usually the shim's.
 * @returns {string | null}
 */
export const danglingWorkspaceLinkHint = (startDirectory) => {
  let current = resolve(startDirectory)
  for (;;) {
    const nodeModules = join(current, "node_modules")
    const dangling = danglingLinks(nodeModules)
    if (dangling.length > 0) {
      const shown = dangling.slice(0, shownLinks)
      const lines = [
        `smthrs: found ${dangling.length} dangling workspace link${
          dangling.length === 1 ? "" : "s"
        } under ${nodeModules}:`,
        ...shown.map(({ linkPath, target }) => `  ${linkPath} -> ${target} (target no longer exists)`)
      ]
      if (dangling.length > shown.length) lines.push(`  ...and ${dangling.length - shown.length} more`)
      lines.push(
        "This usually means the links were rewritten to point into a git worktree that has since been removed.",
        "Fix: run `pnpm install` at the workspace root to restore the workspace links."
      )
      return lines.join("\n")
    }
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}
