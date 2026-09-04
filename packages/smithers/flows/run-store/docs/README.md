# Colocated documentation

This directory and package JSDoc are the source of every published sentence
about `@smthrs/run-store`. The page under `docs/pages` is generated and must
not be hand-edited.

`scripts/docs.mjs` combines `src/index.ts`, `docs/api.md`, and the documented
exports of each root namespace and explicit subpath. An export reaches the
reference table by carrying an `@category` tag.

The `//packages/smithers/flows/run-store:docsPages` target writes or drift-checks the page.
After editing, run `node packages/smithers/flows/run-store/scripts/docs.mjs`, then
`node packages/smithers/flows/run-store/scripts/docs.mjs --check` and
`pnpm -C apps/site check:docs` from the repository root.
