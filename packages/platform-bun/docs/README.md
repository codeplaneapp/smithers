# Colocated documentation

This directory, `Package.ts`, and the public JSDoc in `src/` own the published
contract for `@smthrs/platform-bun`. Generated pages under `docs/pages` are
outputs.

`scripts/docs.mjs` builds `docs/pages/api/platform-bun.md` from the barrel's
module JSDoc, `docs/api.md`, and every export carrying an `@category` tag, then
verifies the reference list declared by `Package.ts` still points readers to
`/api/platform-bun`.

The `//packages/platform-bun:docsPages` target writes or drift-checks that
output. After editing, run:

```sh
node packages/platform-bun/scripts/docs.mjs
pnpm docs:llms
```
