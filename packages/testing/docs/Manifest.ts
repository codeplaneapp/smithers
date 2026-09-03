/**
 * Documentation surfaces owned by `@smthrs/testing`.
 *
 * `scripts/docs.mjs` consumes this declaration. Every generated surface is
 * derived from package sources: the barrel's module JSDoc, each module's
 * `@category`-tagged exports, the prose in `docs/api.md`, and the
 * `description` in `package.json`. Nothing here is hand-maintained twice.
 */
export const Manifest = {
  name: "@smthrs/testing",
  /**
   * The generated reference page, written whole from `docs/api.md` plus the
   * export tables the barrel's modules declare.
   */
  api: {
    source: "docs/api.md",
    target: "docs/pages/api/testing.md"
  },
  /**
   * Prose this package owns, projected into a marked region of a page that
   * belongs to everyone. The site's Testing guide is written entirely about
   * the fixtures each package under test ships, and never named the published
   * testing library at all, so the library was reachable from the docs site
   * only by already knowing it existed.
   */
  snippets: [
    {
      source: "docs/guide.md",
      region: "testing-guide",
      target: "docs/pages/guides/testing.md"
    }
  ],
  /**
   * Public entry points outside the root barrel. `Vitest` is not re-exported
   * from `src/index.ts` because `vitest` refuses to load through `require()`,
   * so a barrel that carried it would break every CommonJS consumer of the
   * assertion helpers. It is documented from its own subpath instead.
   */
  subpathModules: ["Vitest"],
  /**
   * Pages that must keep pointing a reader at the generated API page rather
   * than restating what it says.
   *
   * `@smthrs/testing` was the only name in the release's published set with no
   * page under `docs/pages/api/`, because the page needs a sidebar entry in
   * the hand-written `vocs.config.ts` before it can exist:
   * `scripts/check-docs.mjs` fails any published page the sidebar does not
   * list, and fails any sidebar link no page answers. The entry and the page
   * land together.
   */
  references: [
    "docs/pages/guides/testing.md"
  ]
} as const
