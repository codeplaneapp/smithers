/**
 * Documentation surfaces owned by `@smthrs/flow`.
 *
 * The package generator consumes this declaration. The API page is generated
 * from `docs/api.md` plus the JSDoc on every exported declaration the barrel
 * re-exports, so the published page cannot drift from the source it describes.
 * Each `snippets` entry projects one package-owned file into a marked region
 * of a shared page, so what the site says about this package is written here
 * even where the page belongs to everyone. Pages listed under `references`
 * must keep pointing readers back at the package API rather than restating its
 * contract.
 */
export const DocsManifest = {
  name: "@smthrs/flow",
  api: {
    source: "docs/api.md",
    target: "docs/pages/api/flow.md"
  },
  snippets: [
    {
      source: "docs/testing.md",
      region: "flow-testing",
      target: "docs/pages/api-tests.md"
    }
  ],
  references: [
    "docs/pages/api/engine.md",
    "docs/pages/api/flows.md",
    "docs/pages/architecture/package-map.md",
    "docs/pages/concepts/actions.md",
    "docs/pages/package-structure.mdx",
    "docs/pages/release/support-matrix.md"
  ]
} as const
