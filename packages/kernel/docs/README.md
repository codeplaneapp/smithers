# Colocated documentation

This directory, `docs/Manifest.ts`, and the public JSDoc in `src/` own the published
contract for `@smthrs/kernel`. Generated pages under `docs/pages` are outputs.

`scripts/docs.mjs` builds `docs/pages/api/kernel.md`, projects the contract and
testing fragments into the architecture and API-test pages, and verifies the
reference list declared by `docs/Manifest.ts` still points readers to `/api/kernel`.

The `//packages/kernel:docsPages` target writes or drift-checks that output.
After editing, run:

```sh
node packages/kernel/scripts/docs.mjs
pnpm docs:llms
```
