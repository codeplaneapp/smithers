/**
 * Documentation surfaces owned by `@smthrs/kernel`.
 *
 * The package generator consumes this declaration. The API page is generated
 * from package JSDoc plus `docs/api.md`; references must continue pointing
 * readers back to the package API rather than restating its contract.
 */
export const Package = {
  name: "@smthrs/kernel",
  api: {
    source: "docs/api.md",
    target: "docs/pages/api/kernel.md"
  },
  references: [
    "docs/pages/api/capability.md",
    "docs/pages/api/platform-node.md",
    "docs/pages/api/platform-browser.md",
    "docs/pages/api/platform-bun.md",
    "docs/pages/api/sandbox.md",
    "docs/pages/concepts/hosts-and-capabilities.md",
    "docs/pages/architecture/package-map.md",
    "docs/pages/guides/testing.md",
    "docs/pages/release/support-matrix.md"
  ]
} as const
