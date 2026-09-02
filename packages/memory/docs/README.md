# Colocated documentation

This directory, `Package.ts`, and the public JSDoc in `src/` own the published
contract for `@smthrs/memory`. Every published sentence about this package has
one source inside the package.

`scripts/docs.mjs` writes `docs/pages/api/memory.md` whole and injects the
Public API fragment into the package README. Both are generated outputs and
must never be hand-edited.

The `//packages/memory:docsPages` target writes or drift-checks those outputs,
and `scripts/check-docs.mjs` discovers this generator automatically. After
editing package sources or these fragments, run:

```sh
node packages/memory/scripts/docs.mjs
node packages/memory/scripts/docs.mjs --check
```
