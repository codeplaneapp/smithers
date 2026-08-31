/**
 * Documentation surfaces owned by `@smthrs/crypto`.
 *
 * The package generator consumes this declaration. The API page is generated
 * from package JSDoc plus `docs/api.md`; reusable fragments are projected into
 * broader repository pages; references must continue pointing readers back to
 * the package API rather than restating its contract.
 */
export const Package = {
  name: "@smthrs/crypto",
  api: {
    source: "docs/api.md",
    target: "docs/pages/api/crypto.md"
  },
  snippets: [
    {
      source: "docs/contract.md",
      region: "crypto-contract",
      target: "docs/pages/architecture.md"
    },
    {
      source: "docs/testing.md",
      region: "crypto-testing",
      target: "docs/pages/api-tests.md"
    }
  ],
  references: [
    "docs/pages/api/artifacts.md",
    "docs/pages/api/keys.md",
    "docs/pages/architecture/browser-support.md",
    "docs/pages/architecture/package-map.md",
    "docs/pages/concepts/step-keys.md",
    "docs/pages/package-structure.mdx",
    "docs/pages/release/support-matrix.md"
  ]
} as const
