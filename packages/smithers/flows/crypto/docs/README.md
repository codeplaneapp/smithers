# Colocated documentation

This directory, `docs/Manifest.ts`, and the public JSDoc in `src/` own the published
contract for `@smthrs/crypto`. Generated pages under `docs/pages` are outputs.

`scripts/docs.mjs` builds `docs/pages/api/crypto.md`, injects the package-owned
contract and testing fragments into broader pages, and verifies the reference
list declared by `docs/Manifest.ts` still points readers to `/api/crypto`.

The `//packages/smithers/flows/crypto:docsPages` target writes or drift-checks those outputs.
After editing, run:

```sh
node packages/smithers/flows/crypto/scripts/docs.mjs
pnpm -C apps/site sync:docs
```
