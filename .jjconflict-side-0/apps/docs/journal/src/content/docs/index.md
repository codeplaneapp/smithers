---
title: "@smthrs/journal"
description: "Effect services for the Smithers event journal: the immutable run history and the owner fence on its durable channel"
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/journal/docs/README.md"
---

This directory, `docs/Manifest.ts`, and the public JSDoc in `src/` own the published
contract for `@smthrs/journal`. Generated pages under `docs/pages` are outputs.

`scripts/docs.mjs` builds `docs/pages/api/journal.md` from the module JSDoc of
`src/index.ts`, the `@category`-tagged JSDoc of every namespace the barrel
re-exports, and `docs/api.md`, then verifies that the reference list declared
by `docs/Manifest.ts` still points readers to `/api/journal`.

The `//packages/smithers/flows/journal:docsPages` target writes or drift-checks that output.
After editing, run:

```sh
node packages/smithers/flows/journal/scripts/docs.mjs
pnpm docs:llms
```

A claim about this package belongs in exactly one of three places:

| Claim                                            | Home                                                |
| ------------------------------------------------ | --------------------------------------------------- |
| What one export does                             | its JSDoc in `src/`, which the Exports table quotes |
| How the package fits together, and its contracts | `docs/api.md`                                       |
| The one-line summary every package table quotes  | `description` in `package.json`                     |
