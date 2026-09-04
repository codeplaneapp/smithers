# Package-owned documentation

Everything the documentation site publishes about `@smthrs/flow` is written
here or in the package sources, never in `docs/pages`.

| Source                                                | What it becomes                                         |
| ----------------------------------------------------- | ------------------------------------------------------- |
| `package.json` `description`                          | the frontmatter description of `docs/pages/api/flow.md` |
| `docs/api.md`                                         | the narrative body of that page                         |
| JSDoc carrying `@category` on an exported declaration | one row of the generated export tables                  |
| `src/index.ts` namespace JSDoc                        | the one-line summary above each namespace table         |
| `docs/testing.md`                                     | the `flow-testing` region of `docs/pages/api-tests.md`  |

`scripts/docs.mjs` stitches those together. Run it from the repository root:

```sh
node packages/smithers/flows/flow/scripts/docs.mjs          # write the page
node packages/smithers/flows/flow/scripts/docs.mjs --check  # fail when the committed page has drifted
```

`PACKAGE.ts` declares the same script as the `docsPages` target, so
`smithers-build run //packages/smithers/flows/flow:docsPages` writes the page and
`smithers-build lint //packages/smithers/flows/flow:docsPages` drift-checks it. The recursive
CI pattern `smithers-build ci '//packages/...'` includes the lint form, so a
JSDoc edit that changes the published page fails CI until the page is
regenerated.

Two rules the generator enforces:

- Generated content carries no em-dash. `pnpm -C apps/site check:docs` forbids one
  anywhere in the site, so a summary that reaches for one fails the build at
  the source instead of in review.
- Only exports carrying `@category` reach a table. An export without one is
  invisible to readers of the site, which is why `eslint.jsdoc.js` requires the
  tag on the public surface.

Fragments projected into shared pages work the way `packages/smithers/flows/crypto/docs`
projects `contract.md` into `docs/pages/architecture.md`: a region marker in the
target page and one entry in `docs/Manifest.ts` `snippets`. `docs/testing.md` is the
one this package publishes today, into `docs/pages/api-tests.md`.

That page's inventory table is shared with every package and dprint aligns its
columns, so the generator does not own the `@smthrs/flow` row. It gates it
instead: the suite count in the row has to equal the `test/*.test.ts` files on
disk, and `--check` fails when it does not. The row's prose stays hand-written.
`docs/pages/architecture.md` has no flow region yet; adding one takes the same
two steps.
