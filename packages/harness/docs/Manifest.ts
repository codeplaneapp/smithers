/**
 * Documentation surfaces owned by `@smthrs/harness`.
 *
 * `scripts/docs.mjs` consumes this declaration. Every generated surface is
 * derived from package sources: the barrel's module JSDoc, each module's
 * `@category`-tagged exports, the prose in `docs/api.md`, and the
 * `description` in `package.json`. Nothing here is hand-maintained twice.
 */
export const Manifest = {
  name: "@smthrs/harness",
  /**
   * The generated reference page, written whole from `docs/api.md` plus the
   * export tables the barrel's modules declare.
   */
  api: {
    source: "docs/api.md",
    target: "packages/harness/docs/reference.md"
  },
  /**
   * Public entry points outside the root barrel. `QuickJSSandbox` is not
   * re-exported from `src/index.ts` because it carries an embedded WebAssembly
   * build, so it is documented from its own subpath instead.
   */
  subpathModules: ["QuickJSSandbox"],
  /**
   * The one surface this package does not yet own.
   *
   * A page at `docs/pages/api/harness.md` needs a sidebar entry in the
   * hand-written `vocs.config.ts` before it can exist: `scripts/check-docs.mjs`
   * fails any published page the sidebar does not list. Until that entry lands,
   * `docs/reference.md` is the generated reference and lives in the package.
   */
  site: {
    target: "docs/pages/api/harness.md",
    blockedBy: "vocs.config.ts must list the page in its sidebar first"
  }
} as const
