/**
 * Documentation surfaces owned by `@smthrs/step-cache`.
 *
 * The package generator consumes this declaration. The API page is generated
 * from package JSDoc plus `docs/api.md`; `subpaths` names the entry points the
 * root barrel does not re-export, so the Node-only test layer is documented
 * beside the rest; references must keep pointing readers at the package API
 * rather than restating its contract.
 */
export const Package = {
  name: "@smthrs/step-cache",
  api: {
    source: "docs/api.md",
    target: "docs/pages/api/step-cache.md"
  },
  subpaths: [
    {
      namespace: "TestCacheStore",
      source: "src/test/TestCacheStore.ts",
      specifier: "@smthrs/step-cache/test/TestCacheStore",
      platform: "Node"
    }
  ],
  snippets: [],
  // Only pages no other package's generator writes. A reference on a
  // generated page would make this gate red whenever that package
  // regenerated its own page, which is a failure about their file, not
  // about this contract.
  references: [
    "docs/pages/api/engine-store.md",
    "docs/pages/architecture/package-map.md",
    "docs/pages/guides/testing.md",
    "docs/pages/release/support-matrix.md"
  ]
} as const
