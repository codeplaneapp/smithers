# Colocated documentation

This directory, `docs/Manifest.ts`, and the public JSDoc in `src/` own the published
contract for `@smthrs/core`. Generated pages under `docs/pages` are outputs.

`scripts/docs.mjs` builds `docs/pages/api/core.md` from the barrel and module
JSDoc plus `docs/api.md`, and verifies the reference list declared by
`docs/Manifest.ts`.

The `//packages/smithers/flows/core:docsPages` target writes or drift-checks that output.
After editing, run:

```sh
node packages/smithers/flows/core/scripts/docs.mjs
pnpm -C apps/site sync:docs
```
