---
title: "@smthrs/patterns"
description: "Higher-order flow patterns and decorators for flows. It composes @smthrs/core alone and imports no Node built-ins."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/patterns/docs/README.md"
---

This directory, `docs/Manifest.ts`, and the public JSDoc in `src/` own the published
contract for `@smthrs/patterns`. Every published sentence about this package
has one source inside the package.

`scripts/docs.mjs` builds the four `docs/pages/api/patterns*.md` pages and
injects the Public API fragment into the package README. Those generated pages
are outputs and must never be hand-edited.

The `//packages/smithers/flows/patterns:docsPages` target writes or drift-checks those outputs.
After editing, run:

```sh
node packages/smithers/flows/patterns/scripts/docs.mjs
node packages/smithers/flows/patterns/scripts/docs.mjs --check
```
