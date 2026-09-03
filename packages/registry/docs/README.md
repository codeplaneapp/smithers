# Colocated documentation

This directory, `docs/Manifest.ts`, and the public JSDoc in `src/` own the published
contract for `@smthrs/registry`. Generated pages under `docs/pages` are outputs.

`scripts/docs.mjs` builds `docs/pages/api/registry.md` from the barrel's module
JSDoc, the prose in `api.md`, and the `@category` JSDoc on every public export,
and verifies the reference list declared by `docs/Manifest.ts` still points readers to
`/api/registry`.

The `//packages/registry:docsPages` target writes or drift-checks those outputs.
After editing, run:

```sh
node packages/registry/scripts/docs.mjs
pnpm docs:llms
```
