/** Documentation surfaces owned by `@smthrs/scorers`. */
export const Manifest = {
  name: "@smthrs/scorers",
  generator: "packages/scorers/scripts/docs.mjs",
  exports: { target: "packages/scorers/docs/exports.md" },
  fragments: [
    "packages/scorers/README.md",
    "packages/scorers/docs/README.md",
    "packages/scorers/docs/api.md",
    "packages/scorers/docs/durability.md"
  ]
} as const
