/**
 * `smithers docs`: the documentation an agent can read without a browser.
 *
 * The docs lane generates two bundles from the vocs `docs/pages` tree and
 * ships them inside this package: `llms.txt` is the index, `llms-full.txt` is
 * every page concatenated. `smithers docs` prints the first and
 * `smithers docs --full` prints the second, so an agent working in a checkout
 * pipes the documentation into its own context instead of fetching it.
 *
 * 0.x resolved the same files over the network with a version ladder and a
 * GitHub raw fallback. rc.0 prints what shipped in the installed package: a
 * CLI that answers documentation questions from another release's docs is
 * worse than one that answers from its own.
 *
 * @since 1.0.0
 */
import { existsSync, readFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * The bundle names this command prints.
 *
 * @category constants
 * @since 1.0.0
 */
export const bundles = { index: "llms.txt", full: "llms-full.txt" } as const

/**
 * The root of the installed package, from the location of one of its modules.
 *
 * Source and build put this module at two different depths: `src/Docs.ts` in a
 * checkout, `dist/esm/Docs.js` in a tarball. Counting `..` once is right for
 * the first and one segment short for the second, so the build layout is
 * recognized by name instead.
 *
 * @category constructors
 * @since 1.0.0
 */
export const packageRoot = (moduleUrl: string = import.meta.url): string => {
  const enclosing = dirname(fileURLToPath(moduleUrl))
  const parent = dirname(enclosing)
  return basename(parent) === "dist" ? dirname(parent) : parent
}

/**
 * Where the bundles live inside the installed package.
 *
 * Resolved from this module rather than from the working directory, so
 * `smithers docs` prints the installed release's documentation wherever it is
 * invoked from. `package.json` ships `docs/` at the package root, never inside
 * `dist/`, so the built entry has to resolve to the same directory the source
 * entry does.
 *
 * @category constructors
 * @since 1.0.0
 */
export const directory = (moduleUrl: string = import.meta.url): string => join(packageRoot(moduleUrl), "docs")

/**
 * The path of one bundle.
 *
 * @category constructors
 * @since 1.0.0
 */
export const file = (full: boolean, root: string = directory()): string =>
  join(root, full ? bundles.full : bundles.index)

/**
 * The message printed when a bundle is missing.
 *
 * A source checkout before `pnpm docs:llms` has run is the ordinary case, so
 * the message names the command that produces the file rather than reporting
 * a defect.
 *
 * @category constructors
 * @since 1.0.0
 */
export const missing = (path: string): string =>
  `No documentation bundle at ${path}. Run \`pnpm docs:llms\` in a source checkout, ` +
  `or read the published documentation at https://smithers.sh.`

/**
 * Reads one bundle, or the message explaining why it is not there.
 *
 * @category getters
 * @since 1.0.0
 */
export const read = (full: boolean, root: string = directory()): { readonly text: string; readonly found: boolean } => {
  const path = file(full, root)
  if (!existsSync(path)) return { text: missing(path), found: false }
  return { text: readFileSync(path, "utf8"), found: true }
}
