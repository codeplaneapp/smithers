---
title: "smthrs"
description: "Migration notice for Smithers 1.0. The runtime ships as @smthrs/* packages; importing this package throws."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smthrs-deprecation/docs/README.md"
---

This directory is the single source for every published sentence about the
unscoped `smthrs` package.

`notice.md` is projected into `docs/pages/migration/1.0.md` by
`scripts/docs.mjs`. The site page is generated output. Never hand-edit content
between the `generated:smthrs-notice` region markers.

Run:

```sh
node packages/smthrs-deprecation/scripts/docs.mjs
node packages/smthrs-deprecation/scripts/docs.mjs --check
```

The first command writes drifted output, and `--check` reports drift without
writing. `scripts/check-docs.mjs` discovers this generator and runs the
`--check` form automatically.

The golden notice also lives in `src/index.ts` and `README.md`.
`test/notice.test.ts` pins every copy to one string.
