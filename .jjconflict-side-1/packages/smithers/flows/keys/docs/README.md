# Colocated documentation

This directory, `docs/Manifest.ts`, and public JSDoc in `src/` own the published
contract for `@smthrs/keys`. Generated pages under `docs/pages` are outputs.

`scripts/docs.mjs` builds `docs/pages/api/keys.md`, injects package-owned
contract and testing fragments into broader pages, and verifies the references
declared by `docs/Manifest.ts` still point readers to `/api/keys`.

The `//packages/smithers/flows/keys:docsPages` target writes or drift-checks those outputs.
After editing, run:

```sh
node packages/smithers/flows/keys/scripts/docs.mjs
pnpm -C apps/site sync:docs
```
