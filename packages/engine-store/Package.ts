/**
 * Documentation surfaces owned by `@smthrs/engine-store`.
 *
 * The package generator consumes this declaration. The API page is generated
 * from package JSDoc plus `docs/api.md`; references must continue pointing
 * readers back to the package API rather than restating its contract.
 *
 * `snippets` is empty: engine-store projects no fragment into a shared
 * repository page today, so no page carries a generated region for it.
 */
export const Package = {
  name: "@smthrs/engine-store",
  api: {
    source: "docs/api.md",
    target: "docs/pages/api/engine-store.md"
  },
  snippets: [],
  references: [
    "docs/pages/api/artifacts.md",
    "docs/pages/api/journal.md",
    "docs/pages/api/plan.md",
    "docs/pages/api/run-store.md",
    "docs/pages/api/step-cache.md",
    "docs/pages/architecture/package-map.md",
    "docs/pages/concepts/durable-execution-model.md",
    "docs/pages/concepts/subflows.md",
    "docs/pages/guides/durable-engine.md",
    "docs/pages/release/support-matrix.md"
  ]
} as const
