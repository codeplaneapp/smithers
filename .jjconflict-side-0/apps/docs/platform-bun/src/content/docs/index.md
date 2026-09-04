---
title: "@smthrs/platform-bun"
description: "Bun Host bundle for flows: Effect's Bun platform services composed into the closed Host surface"
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/platform-bun/docs/README.md"
---

This directory, `docs/Manifest.ts`, and the public JSDoc in `src/` own the published
contract for `@smthrs/platform-bun`. Generated pages under `docs/pages` are
outputs.

`scripts/docs.mjs` builds `docs/pages/api/platform-bun.md` from the barrel's
module JSDoc, `docs/api.md`, and every export carrying an `@category` tag, then
verifies the reference list declared by `docs/Manifest.ts` still points readers to
`/api/platform-bun`.

The `//packages/smithers/flows/platform-bun:docsPages` target writes or drift-checks that
output. After editing, run:

```sh
node packages/smithers/flows/platform-bun/scripts/docs.mjs
pnpm docs:llms
```
