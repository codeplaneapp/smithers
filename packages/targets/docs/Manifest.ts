/**
 * Documentation surfaces owned by `@smthrs/targets`.
 *
 * `scripts/docs.mjs` consumes this declaration. Every surface named here is
 * derived from package sources: `rules` is written out of the `Target.make`
 * declarations in `src/`, and `prose` is the hand-written material it sits
 * beside. Nothing about this package is maintained twice.
 *
 * Being private does not decide whether a package owns a page, but this one
 * has no reader on the documentation site: its whole surface is the authoring
 * API of a private build tool, and `@smthrs/build` already documents that tool
 * for the site. So `site` is null and the generated inventory stays in the
 * package, the way `@smthrs/testing` keeps its reference page until a sidebar
 * entry exists for it.
 *
 * @since 0.1.0
 */
export const Manifest = {
  name: "@smthrs/targets",
  /**
   * The generated catalog inventory: every rule, the verbs it participates
   * in, whether it is cacheable, whether it declares outputs, and which route
   * executes it.
   */
  rules: {
    source: "src",
    target: "packages/targets/docs/rules.md"
  },
  /** The hand-written prose the generated inventory sits beside. */
  prose: ["docs/README.md", "docs/api.md"],
  /**
   * No page under `docs/pages`. The 34 reference pages for rules implemented
   * here live in `packages/build/docs/reference/targets/`; re-sourcing them
   * from this package is an edit in `packages/build`.
   */
  site: null,
  references: []
} as const
