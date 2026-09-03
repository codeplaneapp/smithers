# Colocated documentation

This directory, `docs/Manifest.ts`, and the public JSDoc in `src/` own the published
contract for `@smthrs/artifacts`. Generated pages under `docs/pages` are
outputs.

`scripts/docs.mjs` builds `docs/pages/api/artifacts.md` and verifies the
reference list declared by `docs/Manifest.ts` still points readers to
`/api/artifacts`.

The `//packages/smithers/flows/artifacts:docsPages` target writes or drift-checks that output.
After editing, run:

```sh
node packages/smithers/flows/artifacts/scripts/docs.mjs
pnpm docs:llms
```
