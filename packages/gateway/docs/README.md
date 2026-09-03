# Colocated documentation

This directory, `docs/Manifest.ts`, and the public JSDoc in `src/` own the published
contract for `@smthrs/gateway`. Generated pages under `docs/pages` are outputs.

`scripts/docs.mjs` builds `docs/pages/api/gateway.md` and verifies the reference
list declared by `docs/Manifest.ts` still points readers to `/api/gateway`.

The `//packages/gateway:docsPages` target writes or drift-checks that output.
After editing, run:

```sh
node packages/gateway/scripts/docs.mjs
pnpm docs:llms
```
