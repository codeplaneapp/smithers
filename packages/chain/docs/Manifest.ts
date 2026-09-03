/**
 * Documentation surfaces owned by `@smthrs/chain`.
 *
 * The package generator consumes this declaration. `@smthrs/chain` is private
 * at 1.0.0-rc.0, so unlike `@smthrs/crypto` it projects nothing into
 * `docs/pages` yet: the one generated surface is the member-level export
 * index inside the package. When the package goes public, an `api` entry
 * naming `docs/pages/api/chain.md` is added here, the sidebar gains its row,
 * and `scripts/docs.mjs` gains the one write that fills it. Nothing else has
 * to move, which is the point of declaring the surfaces separately from the
 * generator that writes them.
 *
 * The prose sources this pairs with are listed in `docs/README.md`: the JSDoc
 * in `src/`, the fragments in `docs/`, and the `description` in
 * `package.json`.
 */
export const Manifest = {
  name: "@smthrs/chain",
  /** The generator, as an operator would type it from the workspace root. */
  generator: "packages/chain/scripts/docs.mjs",
  /**
   * The member-level export index, generated from the `@category` and first
   * JSDoc sentence of every documented export. Workspace-relative, because
   * that is the path space `Smithers.Generate`'s `changes` list speaks.
   */
  exports: {
    target: "packages/chain/docs/exports.md"
  },
  /**
   * Prose fragments written by hand, gated by `test/Docs.test.ts` rather than
   * generated. Listed so a reader of this declaration sees the whole owned
   * surface, not only the generated part.
   */
  fragments: [
    "packages/chain/docs/README.md",
    "packages/chain/docs/api.md",
    "packages/chain/docs/contract.md"
  ]
} as const
