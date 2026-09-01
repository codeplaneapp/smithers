/**
 * Documentation surfaces owned by `@smthrs/capability`.
 *
 * The package generator consumes this declaration. The API page is generated
 * from the package's public JSDoc plus `docs/api.md`; references are the pages
 * that must keep sending readers to the package API rather than restating the
 * capability grammar, the effect tiers, or the permission failures.
 *
 * The package owns no snippet regions. Every shared page that describes the
 * capability vocabulary links to `/api/capability` instead of copying it, which
 * the reference check below enforces.
 */
export const DocsManifest = {
  name: "@smthrs/capability",
  api: {
    source: "docs/api.md",
    target: "docs/pages/api/capability.md"
  },
  snippets: [],
  references: [
    "docs/pages/api/flows.md",
    "docs/pages/api/kernel.md",
    "docs/pages/architecture/package-map.md",
    "docs/pages/release/support-matrix.md"
  ]
} as const
