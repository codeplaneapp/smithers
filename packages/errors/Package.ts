/**
 * Documentation surfaces owned by `@smthrs/errors`.
 *
 * The package generator consumes this declaration. The reference page is
 * generated from package JSDoc plus `docs/reference.md`; the error-code table
 * is also projected into the package README; references must continue pointing
 * readers to `/reference/errors` rather than restating the package contract.
 *
 * @since 1.0.0
 */
export const Package = {
  name: "@smthrs/errors",
  api: {
    source: "docs/reference.md",
    target: "docs/pages/reference/errors.md"
  },
  snippets: [
    {
      source: "docs/reference.md",
      region: "error-codes",
      target: "README.md"
    }
  ],
  references: ["docs/pages/routes.md"]
} as const
