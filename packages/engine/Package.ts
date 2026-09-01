/**
 * Documentation surfaces owned by `@smthrs/engine`.
 *
 * The package generator consumes this declaration. The API page is generated
 * from package JSDoc plus `docs/api.md`; references must continue pointing
 * readers back to the package API rather than restating its contract.
 */
export const Package = {
  name: "@smthrs/engine",
  api: {
    source: "docs/api.md",
    target: "docs/pages/api/engine.md"
  },
  snippets: [],
  references: [
    "docs/pages/api/flow.md",
    "docs/pages/architecture/package-map.md",
    "docs/pages/release/support-matrix.md"
  ]
} as const
