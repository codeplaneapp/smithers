/**
 * Documentation surfaces owned by `@smthrs/cli`.
 *
 * The generated API page combines the public barrel's JSDoc with the package
 * architecture notes. Command pages remain generated from the real parser by
 * the repository docs gate, so neither surface hand-copies a command schema.
 */
export const Manifest = {
  name: "@smthrs/cli",
  api: {
    source: "docs/api.md",
    target: "docs/pages/api/cli.md"
  },
  snippets: [],
  references: [
    "docs/pages/guides/control-plane-trust.md",
    "docs/pages/release/support-matrix.md"
  ]
} as const
