/**
 * Documentation surfaces owned by `@smthrs/core`.
 *
 * The package generator consumes this declaration. The API page is generated
 * from the module JSDoc in `src/` plus `docs/api.md`; the package owns no
 * snippet regions in shared pages, because every claim it makes about the
 * plan-time data model belongs on its own page.
 *
 * `references` is deliberately empty at rc.0. The pages that name
 * `@smthrs/core` today (the patterns pages, `concepts/concurrency.md`,
 * `migration/migrate-tool.md`, `release/support-matrix.md`, and
 * `api/step-cache.md`) predate this page and still describe the package
 * inline. Pointing them at `/api/core` edits files this package does not own,
 * so it is tracked as a follow-up rather than enforced here.
 */
export const Manifest = {
  name: "@smthrs/core",
  api: {
    source: "docs/api.md",
    target: "docs/pages/api/core.md"
  },
  snippets: [],
  references: []
} as const
