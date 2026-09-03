# Colocated documentation

This directory, `docs/Manifest.ts`, and the public JSDoc in `src/` own the published
contract for `@smthrs/sandbox`. Generated pages under `docs/pages`, and the
marked regions of the package `README.md`, are outputs.

- `api.md` is the narrative body of `docs/pages/api/sandbox.md`.
- `limits.md` states what this package buffers whole and what it bounds. It is
  used twice: as the API page's `Limits` section and as the README's
  `sandbox-limits` region.
- The namespace table in both the API page and the README is generated from
  `src/index.ts` itself, so a namespace added to the barrel cannot go
  unlisted. The per-namespace export tables come from the `@category` JSDoc on
  each export.

`scripts/docs.mjs` builds those outputs and verifies that the reference pages
declared by `docs/Manifest.ts` still point readers at `/api/sandbox`.

The `//packages/smithers/flows/sandbox:docsPages` target writes or drift-checks them. After
editing, run from the repository root:

```sh
node packages/smithers/flows/sandbox/scripts/docs.mjs
pnpm docs:llms
```
