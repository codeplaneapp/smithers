/**
 * Documentation surfaces owned by `@smthrs/keys`.
 *
 * The package generator builds the API page from public JSDoc and `docs/api.md`,
 * projects reusable contract fragments into repository-wide pages, and checks
 * that related documentation points back to the package contract.
 */
export const DocsManifest = {
  name: "@smthrs/keys",
  api: {
    source: "docs/api.md",
    target: "docs/pages/api/keys.md"
  },
  snippets: [
    {
      source: "docs/contract.md",
      region: "keys-contract",
      target: "docs/pages/data-structures.md"
    },
    {
      source: "docs/testing.md",
      region: "keys-testing",
      target: "docs/pages/api-tests.md"
    }
  ],
  references: [
    "docs/pages/api/plan.md",
    "docs/pages/api-tests.md",
    "docs/pages/architecture.md",
    "docs/pages/architecture/browser-support.md",
    "docs/pages/architecture/package-map.md",
    "docs/pages/concepts/step-keys.md",
    "docs/pages/data-structures.md",
    "docs/pages/package-structure.mdx",
    "docs/pages/release/support-matrix.md"
  ]
} as const
