# Colocated documentation

This directory, `DocsManifest.ts`, and the public JSDoc in `src/` own the published
contract for `@smthrs/plan`. Generated pages under `docs/pages` are outputs.

`scripts/docs.mjs` builds `docs/pages/api/plan.md`, injects the package-owned
testing fragment into the repository test page, and verifies the reference list
declared by `DocsManifest.ts` still points readers to `/api/plan`.

The `//packages/plan:docsPages` target writes or drift-checks those outputs.
After editing, run:

```sh
node packages/plan/scripts/docs.mjs
pnpm docs:llms
```
