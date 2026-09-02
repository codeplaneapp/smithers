/**
 * Documentation surfaces owned by `@smthrs/notifications`.
 *
 * The package generator consumes this declaration. The API page is generated
 * from package JSDoc plus `docs/api.md`; references must continue pointing
 * readers back to the package API rather than restating its contract.
 *
 * `snippets` is empty: the notification queue projects no fragment into a
 * shared repository page today, so no page carries a generated region for it.
 */
export const Package = {
  name: "@smthrs/notifications",
  api: {
    source: "docs/api.md",
    target: "docs/pages/api/notifications.md"
  },
  snippets: [],
  references: [
    "docs/pages/release/support-matrix.md"
  ]
} as const
