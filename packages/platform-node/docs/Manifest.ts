/**
 * Documentation surfaces owned by `@smthrs/platform-node`.
 *
 * The package generator consumes this declaration. The API page is generated
 * from package JSDoc plus `docs/api.md`; references must continue pointing
 * readers back to the package API rather than restating its contract.
 *
 * `snippets` is empty: this package projects no fragment into a shared
 * repository page today, so no page carries a generated region for it.
 */
export const Manifest = {
  name: "@smthrs/platform-node",
  api: {
    source: "docs/api.md",
    target: "docs/pages/api/platform-node.md"
  },
  snippets: [],
  /**
   * Modules the wildcard `./*` export publishes that the barrel does not.
   *
   * `AtomicFileSystem` is deliberately absent from `src/index.ts` — it is
   * reached as `NodeHost.AtomicFileSystem` or through
   * `@smthrs/platform-node/AtomicFileSystem` — but the wildcard subpath makes it
   * public API all the same, so its exports belong in the generated table.
   */
  subpathModules: ["AtomicFileSystem"],
  references: [
    "docs/pages/api/kernel.md",
    "docs/pages/api/platform-bun.md"
  ]
} as const
