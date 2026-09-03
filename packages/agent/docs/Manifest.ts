/**
 * Documentation surfaces owned by `@smthrs/agent`.
 *
 * The package generator consumes this declaration. The API page is generated
 * from package JSDoc plus `docs/api.md`; references must continue pointing
 * readers back to the package API rather than restating its contract.
 */
export const Manifest = {
  name: "@smthrs/agent",
  api: {
    source: "docs/api.md",
    target: "docs/pages/api/agent.md"
  },
  snippets: [],
  references: [
    "docs/pages/release/support-matrix.md"
  ]
} as const
