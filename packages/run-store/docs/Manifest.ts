/**
 * Documentation surfaces owned by `@smthrs/run-store`.
 *
 * The package generator combines public JSDoc with `docs/api.md`. The test
 * layer is an explicit Node-only subpath, and reference pages must keep
 * linking here instead of restating this package's durability contract.
 */
export const Manifest = {
  name: "@smthrs/run-store",
  api: {
    source: "docs/api.md",
    target: "docs/pages/api/run-store.md"
  },
  subpaths: [
    {
      namespace: "TestRunStore",
      source: "src/test/TestRunStore.ts",
      specifier: "@smthrs/run-store/test/TestRunStore",
      platform: "Node"
    }
  ],
  snippets: [],
  references: [
    "docs/pages/api/database.md",
    "docs/pages/api/engine-store.md",
    "docs/pages/api/journal.md",
    "docs/pages/api/sandbox.md",
    "docs/pages/api/time-travel.md",
    "docs/pages/architecture/package-map.md",
    "docs/pages/guides/testing.md",
    "docs/pages/release/support-matrix.md"
  ]
} as const
