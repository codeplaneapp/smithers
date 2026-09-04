---
title: "@smthrs/plan"
description: "The persisted flows plan: a keyed action graph, its append-only store, and its diff"
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/plan/docs/README.md"
---

This directory, `docs/Manifest.ts`, and the public JSDoc in `src/` own the published
contract for `@smthrs/plan`. Generated pages under `docs/pages` are outputs.

`scripts/docs.mjs` builds `docs/pages/api/plan.md`, injects the package-owned
testing fragment into the repository test page, and verifies the reference list
declared by `docs/Manifest.ts` still points readers to `/api/plan`.

The `//packages/smithers/flows/plan:docsPages` target writes or drift-checks those outputs.
After editing, run:

```sh
node packages/smithers/flows/plan/scripts/docs.mjs
pnpm docs:llms
```
