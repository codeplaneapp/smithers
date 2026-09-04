---
title: "@smthrs/errors"
description: "SmithersError and the error codes the integration adapters raise"
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/errors/docs/README.md"
---

This directory, `docs/Manifest.ts`, and the public JSDoc in `src/` own the published
contract for `@smthrs/errors`. The generated page at
`docs/pages/reference/errors.md` is an output.

`scripts/docs.mjs` writes that page and injects the generated error-code table
into the package README. The `//packages/errors:docsPages` target writes or
drift-checks those outputs. After editing, run:

```sh
node packages/errors/scripts/docs.mjs
pnpm docs:llms
```
