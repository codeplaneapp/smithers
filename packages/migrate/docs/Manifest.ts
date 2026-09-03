/**
 * Documentation surfaces owned by `@smthrs/migrate`.
 *
 * The package generator consumes this declaration. The reference page is
 * generated from package JSDoc plus `docs/api.md`, and it lives on the
 * migration path rather than under `/api`, because an operator reaches the
 * tool from the 0.x upgrade guide and not from the API index. `references`
 * names the pages that must keep pointing readers at that page rather than
 * restating the tool's contract.
 *
 * `snippets` is empty: this package projects no fragment into a shared
 * repository page, so no page carries a generated region for it.
 */
export const Manifest = {
  name: "@smthrs/migrate",
  api: {
    source: "docs/api.md",
    target: "docs/pages/migration/migrate-tool.md",
    route: "/migration/migrate-tool"
  },
  snippets: [],
  references: [
    "docs/pages/migration/1.0.md",
    "docs/pages/release/support-matrix.md"
  ]
} as const
