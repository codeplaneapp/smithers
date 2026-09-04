---
title: "@smthrs/engine"
description: "The runtime that executes @smthrs/flow flows, plus HTTP and RPC transport projections"
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/engine/docs/README.md"
---

This directory, `docs/Manifest.ts`, and the public JSDoc in `src/` own the published
contract for `@smthrs/engine`. Generated pages under `docs/pages` are outputs.

`scripts/docs.mjs` builds `docs/pages/api/engine.md` from the module JSDoc of
the barrel, the prose in `docs/api.md`, and every documented export it reaches
through the package barrels, and it verifies the reference list declared by
`docs/Manifest.ts` still points readers to `/api/engine`.

The `//packages/smithers/flows/engine:docsPages` target writes or drift-checks those outputs.
After editing, run:

```sh
node packages/smithers/flows/engine/scripts/docs.mjs
pnpm docs:llms
```

An export without a `@category` tag never reaches the page, so a new public
declaration is documented in `src/` first and published from there.
