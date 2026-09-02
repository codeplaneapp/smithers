/**
 * The unscoped `smthrs` package at 1.0.0-rc.0: a migration notice, not a
 * runtime.
 *
 * Smithers 0.x published `smthrs` as an umbrella facade that re-exported the
 * JSX authoring API, the renderer, and fourteen `@smthrs/*` packages. Smithers
 * 1.0 removes that architecture, so the name keeps its place on the registry
 * only to tell an upgrading project where the code went. Importing the module
 * throws instead of resolving to a silently different API.
 *
 * The module exports nothing. Evaluation always throws, so a declared export
 * would be a name the published types offer and the runtime can never hand
 * back.
 *
 * @since 1.0.0-rc.0
 */

/** What an importer of `smthrs` is told. */
const notice: string = [
  "smthrs 1.0 is a migration notice, not a runtime.",
  "Smithers 1.0 ships as @smthrs/* packages. Install @smthrs/flows (authoring and engine)",
  "and @smthrs/cli (the `smithers` command), then run `smithers migrate` in a 0.x project.",
  "Migration guide: https://smithers.sh/migration/1.0"
].join("\n")

throw new Error(notice)
