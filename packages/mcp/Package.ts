/**
 * Documentation surfaces owned by `@smthrs/mcp`.
 *
 * `scripts/docs.mjs` consumes this declaration. Every generated surface is
 * derived from package sources: the barrel's module JSDoc, each module's
 * `@category`-tagged exports, the prose in `docs/api.md`, and the
 * `description` in `package.json`. Nothing here is hand-maintained twice.
 */
export const Package = {
  name: "@smthrs/mcp",
  /**
   * The generated reference page, written whole from `docs/api.md` plus the
   * export tables the barrel's modules declare.
   */
  api: {
    source: "docs/api.md",
    target: "packages/mcp/docs/reference.md"
  },
  /**
   * Prose this package projects into a page that belongs to everyone. There is
   * none: the only shared page naming this package is the release support
   * matrix, and the row it holds is the release's to write, not the package's.
   */
  snippets: [],
  /**
   * Public entry points outside the root barrel. There are none: `exports["."]`
   * names `src/index.ts` and the barrel re-exports every public module.
   */
  subpathModules: [],
  /**
   * The one surface this package does not yet own.
   *
   * `@smthrs/mcp` is published at rc.0 with no page under `docs/pages/api/`.
   * The page needs a sidebar entry in the hand-written `vocs.config.ts` before
   * it can exist: `scripts/check-docs.mjs` fails any published page the sidebar
   * does not list, and the release support matrix's `@smthrs/mcp` row has to
   * link it in the same edit. Until both land, `docs/reference.md` is the
   * generated reference and lives in the package, the same arrangement
   * `@smthrs/testing` records for the same reason.
   */
  site: {
    target: "docs/pages/api/mcp.md",
    blockedBy: "vocs.config.ts must list the page in its sidebar first"
  }
} as const
