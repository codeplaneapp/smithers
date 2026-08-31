# Colocated documentation

This directory, `Package.ts`, and the public JSDoc in `src/` own the published
contract for `@smthrs/crypto`. Generated pages under `docs/pages` are outputs.

`scripts/docs.mjs` builds `docs/pages/api/crypto.md`, injects the package-owned
contract and testing fragments into broader pages, and verifies the reference
list declared by `Package.ts` still points readers to `/api/crypto`.

The `//packages/crypto:docsPages` target writes or drift-checks those outputs.
After editing, run:

```sh
node packages/crypto/scripts/docs.mjs
pnpm docs:llms
```
