/**
 * Documentation surfaces owned by `@smthrs/gateway`.
 *
 * The package generator consumes this declaration. The API page is generated
 * from package JSDoc plus `docs/api.md`; references must continue pointing
 * readers back to the package API rather than restating its contract.
 *
 * `snippets` is empty: the gateway projects no fragment into a shared
 * repository page today. `docs/pages/control/index.md` is written by
 * `scripts/generate-docs-pages.mjs` from the control RPC group and this
 * package's `ProjectionName`, so it carries no generated region for a package
 * generator to inject into.
 */
export const Package = {
  name: "@smthrs/gateway",
  api: {
    source: "docs/api.md",
    target: "docs/pages/api/gateway.md"
  },
  snippets: [],
  references: [
    "docs/pages/release/support-matrix.md"
  ]
} as const
