# Colocated documentation

This directory, `docs/Manifest.ts`, and the public JSDoc in `src/` own the published
contract for `@smthrs/notifications`. Generated pages under `docs/pages` are
outputs.

`scripts/docs.mjs` builds `docs/pages/api/notifications.md` from the barrel's
module JSDoc, the prose in `api.md`, and the `@category` summary of every
documented export, then verifies the reference list declared by `docs/Manifest.ts`
still points readers to `/api/notifications`. It writes no snippet regions: no
shared repository page carries a generated fragment for this package today.

The `//packages/smithers/notifications:docsPages` target writes or drift-checks those
outputs, so a JSDoc edit that changes the published page cannot land without
regenerating it. After editing, run:

```sh
node packages/smithers/notifications/scripts/docs.mjs
pnpm docs:llms
```
