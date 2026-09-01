/**
 * Documentation surfaces owned by `@smthrs/plan`.
 *
 * The package generator consumes this declaration. The API page is generated
 * from package JSDoc plus `docs/api.md`; reusable fragments are projected into
 * broader repository pages; references must continue pointing readers back to
 * the package API rather than restating its contract.
 */
export const DocsManifest = {
  name: "@smthrs/plan",
  api: {
    source: "docs/api.md",
    target: "docs/pages/api/plan.md"
  },
  snippets: [
    {
      source: "docs/testing.md",
      region: "plan-testing",
      target: "docs/pages/api-tests.md"
    }
  ],
  references: [
    "docs/pages/api/engine-store.md",
    "docs/pages/api/flows.md",
    "docs/pages/api/patterns.md",
    "docs/pages/architecture/package-map.md",
    "docs/pages/concepts/action-graph.md",
    "docs/pages/release/support-matrix.md"
  ]
} as const
