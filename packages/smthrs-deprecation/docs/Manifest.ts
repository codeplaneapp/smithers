/**
 * Documentation surfaces owned by the unscoped `smthrs` package.
 *
 * The package generator consumes this declaration. The package-owned notice
 * is projected into the migration guide, which is also this package's public
 * documentation reference.
 */
export const Manifest = {
  name: "smthrs",
  snippets: [
    {
      source: "docs/notice.md",
      region: "smthrs-notice",
      target: "docs/pages/migration/1.0.md"
    }
  ],
  references: ["docs/pages/migration/1.0.md"]
} as const
