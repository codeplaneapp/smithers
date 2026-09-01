/**
 * Documentation surfaces owned by `@smthrs/platform-bun`.
 *
 * The package generator consumes this declaration. The API page is generated
 * from package JSDoc plus `docs/api.md`; references must continue pointing
 * readers back to the package API rather than restating its contract.
 *
 * `snippets` is empty: this package projects no fragment into a shared
 * repository page today, so no page carries a generated region for it.
 */
export const Package = {
  name: "@smthrs/platform-bun",
  api: {
    source: "docs/api.md",
    target: "docs/pages/api/platform-bun.md"
  },
  snippets: [],
  references: [
    "docs/pages/api/kernel.md",
    "docs/pages/api/platform-node.md",
    "docs/pages/release/support-matrix.md"
  ]
} as const
