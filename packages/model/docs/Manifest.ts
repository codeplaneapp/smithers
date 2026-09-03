/**
 * Documentation surfaces owned by `@smthrs/model`.
 *
 * `scripts/docs.mjs` consumes this declaration. Every generated surface is
 * derived from package sources: the namespace barrel in `src/index.ts`, the
 * module JSDoc of each namespace it re-exports, the `@category`-tagged export
 * JSDoc inside those modules, the prose in `docs/api.md`, and the `description`
 * in `package.json`. Nothing here is hand-maintained twice.
 */
export const Manifest = {
  name: "@smthrs/model",
  /** The generated site reference page. */
  api: {
    source: "docs/api.md",
    target: "docs/pages/api/model.md"
  },
  /** The same reference shipped beside the package README. */
  reference: {
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
  references: ["docs/pages/release/support-matrix.md"]
} as const
