/**
 * Documentation surfaces owned by `@smthrs/registry`.
 *
 * The package generator consumes this declaration. The API page is generated
 * from package JSDoc plus `docs/api.md`; reusable fragments are projected into
 * broader repository pages; references must continue pointing readers back to
 * the package API rather than restating its contract.
 */
export const Package = {
  name: "@smthrs/registry",
  api: {
    source: "docs/api.md",
    target: "docs/pages/api/registry.md"
  },
  snippets: [],
  references: [
    "docs/pages/release/support-matrix.md"
  ]
} as const
