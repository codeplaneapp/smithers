/**
 * Documentation surfaces owned by `@smthrs/artifacts`.
 *
 * The package generator consumes this declaration. The API page is generated
 * from package JSDoc plus `docs/api.md`; references must continue pointing
 * readers back to the package API rather than restating its contract.
 *
 * `snippets` is empty: the artifacts package projects no fragment into a
 * shared repository page today, so no page carries a generated region for it.
 */
export const Manifest = {
  name: "@smthrs/artifacts",
  api: {
    source: "docs/api.md",
    target: "docs/pages/api/artifacts.md"
  },
  snippets: [],
  references: [
    "docs/pages/api/step-cache.md",
    "docs/pages/architecture/package-map.md",
    "docs/pages/release/support-matrix.md"
  ]
} as const
