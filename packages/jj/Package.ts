/**
 * Documentation surfaces owned by `@smthrs/jj`.
 *
 * The package generator consumes this declaration. The API page is generated
 * from package JSDoc plus `docs/api.md`; references must continue pointing
 * readers back to the package API rather than restating its contract.
 *
 * `entryPoints` is what this package adds to the pilot shape. The root barrel
 * is only a third of the public surface here: `package.json` exports `./*` over
 * `src/`, so every implementation subpath is public too, and the README and the
 * site page had both drifted into listing a subset of them. Naming the subpaths
 * makes the tables generated from their JSDoc rather than retyped.
 */
export const Package = {
  name: "@smthrs/jj",
  api: {
    source: "docs/api.md",
    target: "docs/pages/api/jj.mdx"
  },
  entryPoints: [
    { import: "@smthrs/jj", source: "src/index.ts", platform: "any", barrel: true },
    { import: "@smthrs/jj/node/NodeJj", source: "src/node/NodeJj.ts", platform: "Node" },
    { import: "@smthrs/jj/node/resolveJjBinary", source: "src/node/resolveJjBinary.ts", platform: "Node" },
    { import: "@smthrs/jj/bun/BunJj", source: "src/bun/BunJj.ts", platform: "Bun" },
    { import: "@smthrs/jj/browser/BrowserJj", source: "src/browser/BrowserJj.ts", platform: "browser" },
    { import: "@smthrs/jj/browser/WasiPreview1", source: "src/browser/WasiPreview1.ts", platform: "browser" },
    { import: "@smthrs/jj/browser/WasiFs", source: "src/browser/WasiFs.ts", platform: "browser" }
  ],
  snippets: [],
  references: [
    "docs/pages/architecture/package-map.md",
    "docs/pages/concepts/hosts-and-capabilities.md",
    "docs/pages/release/support-matrix.md"
  ]
} as const
