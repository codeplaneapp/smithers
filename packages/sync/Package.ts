/**
 * Documentation surfaces owned by `@smthrs/sync`.
 *
 * The package generator consumes this declaration. The API page is generated
 * from package JSDoc plus `docs/api.md`; the concepts page carries one
 * generated region projected from `docs/protocol.md`; references must continue
 * pointing readers back to the package API rather than restating its contract.
 */
export const Package = {
  name: "@smthrs/sync",
  api: {
    source: "docs/api.md",
    target: "docs/pages/api/sync.md"
  },
  snippets: [
    {
      source: "docs/protocol.md",
      region: "sync-protocol",
      target: "docs/pages/concepts/sync.md"
    }
  ],
  references: [
    "docs/pages/architecture/package-map.md",
    "docs/pages/compaction.mdx",
    "docs/pages/concepts/sync.md",
    "docs/pages/release/support-matrix.md"
  ]
} as const
