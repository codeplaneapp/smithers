/**
 * Documentation surfaces owned by `@smthrs/sandbox`.
 *
 * The package generator consumes this declaration. The API page is generated
 * from package JSDoc plus `docs/api.md` and `docs/limits.md`; the README's
 * namespace table comes from the same walk of the barrel that builds the
 * page's, so the two published descriptions of this package cannot disagree
 * about what it exports, and its limits are one fragment used in both places
 * rather than two sentences that drift. References must keep pointing readers
 * back to the package API instead of restating its contract.
 */
export const Package = {
  name: "@smthrs/sandbox",
  api: {
    source: "docs/api.md",
    target: "docs/pages/api/sandbox.md"
  },
  /** Package-owned prose projected into more than one output. */
  snippets: [
    {
      source: "docs/namespaces.md",
      region: "sandbox-namespaces",
      target: "packages/sandbox/README.md"
    },
    {
      source: "docs/limits.md",
      region: "sandbox-limits",
      target: "packages/sandbox/README.md"
    }
  ],
  references: [
    "docs/pages/api/engine-store.md",
    "docs/pages/architecture/package-map.md",
    "docs/pages/concepts/hosts-and-capabilities.md",
    "docs/pages/release/support-matrix.md"
  ]
} as const
