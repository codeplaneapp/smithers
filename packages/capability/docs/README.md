# Colocated documentation

This directory, `DocsManifest.ts`, and the public JSDoc in `src/` own the published
contract for `@smthrs/capability`. Generated pages under `docs/pages` are
outputs, never edit them by hand.

`scripts/docs.mjs` builds `docs/pages/api/capability.md` from the barrel's module
JSDoc, this directory's `api.md`, and every `src/` export carrying an
`@category` tag. It also verifies that the reference list declared by
`DocsManifest.ts` still points readers at `/api/capability` rather than restating the
capability grammar, the effect tiers, or the permission failures.

The `//packages/capability:docsPages` target writes or drift-checks those
outputs: `smithers-build run` writes, `smithers-build lint` fails on drift, and
the workspace `ci` step runs the lint form.

After editing package sources or this directory, run:

```sh
node packages/capability/scripts/docs.mjs
pnpm docs:llms
```
