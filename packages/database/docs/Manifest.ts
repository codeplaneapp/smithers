/**
 * Documentation surfaces owned by `@smthrs/database`.
 *
 * The package generator consumes this declaration. The API page is generated
 * from package JSDoc plus `docs/api.md`; `entries` is the published entry-point
 * list, so a new subpath is documented by adding it here rather than by editing
 * a page; `references` names the pages that must keep pointing readers back to
 * the package API rather than restating its contract.
 */
export const Manifest = {
  name: "@smthrs/database",
  api: {
    source: "docs/api.md",
    target: "docs/pages/api/database.md"
  },
  entries: [
    {
      specifier: "@smthrs/database",
      source: "src/index.ts",
      platform: "any"
    },
    {
      specifier: "@smthrs/database/DurableWriter",
      source: "src/DurableWriter.ts",
      platform: "any"
    },
    {
      specifier: "@smthrs/database/DatabaseMetrics",
      source: "src/DatabaseMetrics.ts",
      platform: "any"
    },
    {
      specifier: "@smthrs/database/Migrations",
      source: "src/Migrations.ts",
      platform: "any"
    },
    {
      specifier: "@smthrs/database/UnsupportedBackend",
      source: "src/UnsupportedBackend.ts",
      platform: "any"
    },
    {
      specifier: "@smthrs/database/node/NodeDatabase",
      source: "src/node/NodeDatabase.ts",
      platform: "Node"
    },
    {
      specifier: "@smthrs/database/test/TestDatabase",
      source: "src/test/TestDatabase.ts",
      platform: "Node"
    }
  ],
  modules: [
    { title: "DurableWriter", source: "src/DurableWriter.ts" },
    { title: "DatabaseMetrics", source: "src/DatabaseMetrics.ts" },
    { title: "Migrations", source: "src/Migrations.ts" },
    { title: "UnsupportedBackend", source: "src/UnsupportedBackend.ts" },
    { title: "NodeDatabase", source: "src/node/NodeDatabase.ts" },
    { title: "TestDatabase", source: "src/test/TestDatabase.ts" }
  ],
  references: [
    "docs/pages/api/engine-store.md",
    "docs/pages/api/run-store.md",
    "docs/pages/api/step-cache.md",
    "docs/pages/architecture/package-map.md",
    "docs/pages/release/support-matrix.md"
  ]
} as const
