/**
 * Documentation surfaces owned by `@smthrs/model`.
 *
 * `scripts/docs.mjs` consumes this declaration. Every generated surface is
 * derived from package sources: the namespace barrel in `src/index.ts`, the
 * module JSDoc of each namespace it re-exports, the `@category`-tagged export
 * JSDoc inside those modules, the prose in `docs/api.md`, and the `description`
 * in `package.json`. Nothing here is hand-maintained twice.
 */
export const Package = {
  name: "@smthrs/model",
  /**
   * The generated reference page, written whole from `docs/api.md` plus the
   * export tables the barrel's namespaces declare.
   */
  api: {
    source: "docs/api.md",
    target: "packages/model/docs/reference.md"
  },
  /**
   * Regions of hand-written files whose bodies the generator owns. Each target
   * carries `<!-- generated:<region> start -->` and `end` markers.
   */
  regions: [
    {
      region: "model-exports",
      target: "packages/model/README.md"
    }
  ],
  /**
   * Pages elsewhere in the repository that must keep pointing readers at this
   * package rather than restating its contract. The generator verifies each.
   */
  references: [],
  /**
   * The one surface this package does not yet own.
   *
   * A page at `docs/pages/api/model.md` needs a sidebar entry in the
   * hand-written `vocs.config.ts` before it can exist: `scripts/check-docs.mjs`
   * fails any published page the sidebar does not list, and that file is not a
   * generated output. Until the entry lands, `docs/reference.md` is the
   * generated reference and lives in the package. The support matrix row for
   * `@smthrs/model` should gain the `/api/model` link in the same change.
   */
  site: {
    target: "docs/pages/api/model.md",
    sidebarEntry: "{ text: \"@smthrs/model\", link: \"/api/model\" }",
    blockedBy: "vocs.config.ts must list the page in its sidebar first"
  }
} as const
