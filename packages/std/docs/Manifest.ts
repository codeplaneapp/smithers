/**
 * Documentation surfaces owned by `@smthrs/std`.
 *
 * `scripts/docs.mjs` consumes this declaration. Every generated surface is
 * derived from package sources: the barrel's module JSDoc, each module's
 * `@category`-tagged exports, the prose in `docs/api.md`, and the
 * `description` in `package.json`. Nothing here is hand-maintained twice.
 */
export const Manifest = {
  name: "@smthrs/std",
  /**
   * The generated reference page, written whole from `docs/api.md` plus the
   * export tables the barrel's modules declare.
   */
  api: {
    source: "docs/api.md",
    target: "packages/std/docs/reference.md"
  },
  /**
   * Prose this package projects into a page that belongs to everyone. There is
   * none yet. `docs/pages/api/patterns-teams.md` is the page that most needs
   * it: it tells porters to configure a shell output limit on the std flow,
   * and `MAX_SHELL_OUTPUT_BYTES` is a constant no input exposes. Correcting
   * that page is an edit in the `patterns` lane, not this one.
   */
  snippets: [],
  /**
   * Public entry points outside the root barrel. There are none: `exports["."]`
   * names `src/index.ts` and the barrel re-exports every public module. The
   * four browser-safe subpaths (`Grep`, `Glob`, `Search`, `PortableSearch`) are
   * the same modules reached through `exports["./*"]`.
   */
  subpathModules: [],
  /**
   * The one surface this package does not yet own.
   *
   * `@smthrs/std` is published at rc.0 with no page under `docs/pages/api/`.
   * The page needs a sidebar entry in the hand-written `vocs.config.ts` before
   * it can exist: `scripts/check-docs.mjs` fails any published page the sidebar
   * does not list. Until that lands, `docs/reference.md` is the generated
   * reference and lives in the package, the same arrangement `@smthrs/mcp` and
   * `@smthrs/testing` record for the same reason.
   */
  site: {
    target: "docs/pages/api/std.md",
    blockedBy: "vocs.config.ts must list the page in its sidebar first"
  }
} as const
