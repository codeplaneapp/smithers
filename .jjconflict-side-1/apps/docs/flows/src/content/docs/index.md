---
title: "@smthrs/flows"
description: "Barrel package re-exporting the whole @smthrs durable flow engine"
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/docs/README.md"
---

This directory, `docs/Manifest.ts`, and the public JSDoc in `src/` own the published
contract for `@smthrs/flows`. Generated pages under `docs/pages` are outputs.

`scripts/docs.mjs` builds `docs/pages/api/flows.md` from `docs/api.md`, the
barrel's namespace list, and the documented exports of `src/NodeRuntime.ts` and
`src/SandboxedFlow.ts`. It also verifies that every page listed in
`Package.references` still names `@smthrs/flows` and points readers at
`/api/flows`.

The `//packages/smithers/flows:docsPages` target writes or drift-checks those outputs.
After editing, run:

```sh
node packages/smithers/flows/scripts/docs.mjs
pnpm docs:llms
```
