# Colocated documentation

This directory, `Package.ts`, and the public JSDoc in `src/` own the published
contract for `@smthrs/platform-browser`. Generated pages under `docs/pages` are
outputs, never edited by hand.

`scripts/docs.mjs` builds `docs/pages/api/platform-browser.md` from the barrel's
module JSDoc, this directory's `api.md`, and every `src/` export carrying an
`@category` tag. It injects the package-owned contract and testing fragments
into the broader pages that describe the browser host, and it verifies that the
reference list declared by `Package.ts` still points readers to
`/api/platform-browser`.

The `//packages/platform-browser:docsPages` target writes or drift-checks those
outputs. After editing, run:

```sh
node packages/platform-browser/scripts/docs.mjs
pnpm docs:llms
```
