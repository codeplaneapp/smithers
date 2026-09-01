/**
 * Documentation surfaces owned by `@smthrs/platform-browser`.
 *
 * The package generator consumes this declaration. The API page is generated
 * from package JSDoc plus `docs/api.md`; reusable fragments are projected into
 * broader repository pages; references must continue pointing readers back to
 * the package API rather than restating its contract.
 */
export const Package = {
  name: "@smthrs/platform-browser",
  api: {
    source: "docs/api.md",
    target: "docs/pages/api/platform-browser.md"
  },
  snippets: [
    {
      source: "docs/contract.md",
      region: "platform-browser-contract",
      target: "docs/pages/architecture/browser-support.md"
    },
    {
      source: "docs/testing.md",
      region: "platform-browser-testing",
      target: "docs/pages/api-tests.md"
    }
  ],
  references: [
    "docs/pages/api/kernel.md",
    "docs/pages/api/platform-bun.md",
    "docs/pages/api/platform-node.md",
    "docs/pages/architecture/package-map.md",
    "docs/pages/release/support-matrix.md"
  ]
} as const
