/**
 * Documentation surfaces owned by `@smthrs/triggers`.
 *
 * The package generator consumes this declaration. `api` is the published API
 * page under `docs/pages`, generated from package JSDoc plus `docs/api.md`;
 * `readme` is the same contract rendered as the package's local surface, so a
 * reader who arrives at the directory rather than at the site reads generated
 * prose instead of a hand-written table that drifts.
 *
 * Being private does not decide whether a package owns a page. `@smthrs/
 * integrations` is private at `1.0.0-rc.0` and owns `docs/pages/api/
 * integrations.md`; the page states the privacy rather than standing in for
 * it. This package follows that precedent.
 *
 * There are no `snippets`: this package injects no fragment into a shared
 * repository page. Adding one means adding the region markers to that page in
 * the same change.
 */
export const Manifest = {
  name: "@smthrs/triggers",
  api: { source: "docs/api.md", target: "docs/pages/api/triggers.md" },
  readme: "packages/triggers/README.md",
  snippets: [],
  references: []
} as const
