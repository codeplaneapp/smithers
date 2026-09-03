# Documentation owned by `@smthrs/control`

Every published sentence about this package has exactly one source, and all of
them are inside the package:

- **JSDoc in `src/`** is the reference. The exports table on the API page is
  built from the first sentence of every export that carries an `@category`
  tag, and the page's opening paragraphs are the module JSDoc of
  `src/index.ts`.
- **`docs/api.md`** is the prose body of the API page: the service surface, run
  lineage, watch deltas, live steering, cancellation attribution, and the
  monitor.
- **`package.json`'s `description`** is the page's frontmatter description,
  quoted verbatim.

`docs/pages/api/control.md` is a generated output. Do not edit it. Run
`node packages/control/scripts/docs.mjs` from the repository root to write it,
and `node packages/control/scripts/docs.mjs --check` to fail on drift. The
`docsPages` target in `packages/control/PACKAGE.ts` runs the check form in CI, so
a JSDoc edit cannot land without regenerating the page.

Generated content must contain no em-dashes; the generator refuses them.
