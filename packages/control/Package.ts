/**
 * Documentation surfaces owned by `@smthrs/control`.
 *
 * The package generator consumes this declaration. The API page is generated
 * from package JSDoc plus `docs/api.md`; `references` names the pages that must
 * keep pointing readers back at the package API rather than restating its
 * contract.
 *
 * `snippets` is empty on purpose. Projecting fragments into the shared
 * repository pages is a second lane's work, and a generator that rewrote a page
 * this package does not own would fight whoever does.
 */
export const Package = {
  name: "@smthrs/control",
  api: {
    source: "docs/api.md",
    target: "docs/pages/api/control.md"
  },
  snippets: [],
  references: [
    "docs/pages/api/gateway.md",
    "docs/pages/api/notifications.md",
    "docs/pages/release/support-matrix.md"
  ]
} as const
