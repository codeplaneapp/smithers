/**
 * Documentation surfaces owned by `@smthrs/integrations`.
 *
 * The package generator consumes this declaration. The API page is generated
 * from package JSDoc plus `docs/api.md`; references must continue pointing
 * readers back to the package API rather than restating its contract.
 *
 * There are no `snippets`: this package injects no fragment into a shared
 * repository page. Adding one means adding the region markers to that page in
 * the same change.
 */
export const Package = {
  name: "@smthrs/integrations",
  api: {
    source: "docs/api.md",
    target: "docs/pages/api/integrations.md"
  },
  snippets: [],
  references: [
    "docs/pages/reference/errors.md"
  ]
} as const
