# Colocated documentation

This directory, `docs/Manifest.ts`, and the public JSDoc in `src/` own the published
contract for `@smthrs/platform-node`. Generated pages under `docs/pages` are
outputs.

`scripts/docs.mjs` builds `docs/pages/api/platform-node.md` from the barrel's
module JSDoc, `docs/api.md`, and every export carrying an `@category` tag, then
verifies the reference list declared by `docs/Manifest.ts` still points readers to
`/api/platform-node`. `AtomicFileSystem` is not in the barrel, so `docs/Manifest.ts`
names it under `subpathModules`: the wildcard `./*` export publishes it, and the
generated table has to say so.

The `//packages/platform-node:docsPages` target writes or drift-checks that
output. After editing, run:

```sh
node packages/platform-node/scripts/docs.mjs
pnpm docs:llms
```
