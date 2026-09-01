/**
 * Documentation surfaces owned by `@smthrs/journal`.
 *
 * The package generator consumes this declaration. The API page is generated
 * from package JSDoc plus `docs/api.md`; references must continue pointing
 * readers back to the package API rather than restating its contract.
 *
 * `snippets` is empty: the journal projects no fragment into a shared
 * repository page today, so no page carries a generated region for it.
 */
export const DocsManifest = {
  name: "@smthrs/journal",
  api: {
    source: "docs/api.md",
    target: "docs/pages/api/journal.md"
  },
  snippets: [],
  references: [
    "docs/pages/api/database.md",
    "docs/pages/api/engine-store.md",
    "docs/pages/api/flows.md",
    "docs/pages/api/run-store.md",
    "docs/pages/api/step-cache.md",
    "docs/pages/architecture/package-map.md",
    "docs/pages/concepts/journal.md",
    "docs/pages/guides/testing.md",
    "docs/pages/release/support-matrix.md"
  ]
} as const
