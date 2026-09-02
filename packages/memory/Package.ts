/**
 * Documentation surfaces owned by `@smthrs/memory`.
 *
 * The package generator consumes this declaration. The API page is written
 * whole from the barrel's module JSDoc plus `docs/api.md`; the Public API
 * fragment is projected into the README so every published sentence about this
 * package has one package-owned source. References are pages that must keep
 * pointing readers at the package API rather than restating its contract.
 */
export const Package = {
  name: "@smthrs/memory",
  api: {
    source: "docs/api.md",
    target: "docs/pages/api/memory.md",
    description: "@smthrs/memory: durable cross-run facts, message history, notes, and recall.",
    title: "Memory"
  },
  pages: [],
  snippets: [{ source: "docs/surface.md", region: "memory-surface", target: "README.md" }],
  references: [
    "docs/pages/api/patterns-delegation.md",
    "docs/pages/release/support-matrix.md"
  ]
} as const
