# Colocated documentation

This directory, `DocsManifest.ts`, and the public JSDoc in `src/` own the published
contract for `@smthrs/core`. Generated pages under `docs/pages` are outputs.

`scripts/docs.mjs` builds `docs/pages/api/core.md` from the barrel and module
JSDoc plus `docs/api.md`, and verifies the reference list declared by
`DocsManifest.ts`.

The `//packages/core:docsPages` target writes or drift-checks that output.
After editing, run:

```sh
node packages/core/scripts/docs.mjs
pnpm docs:llms
```
