---
title: "@smthrs/scorers"
description: "Flow-native scoring, durable observations, and asynchronous score runners for flows"
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/scorers/docs/README.md"
---

This directory and the public JSDoc in `src/` own the contract for
`@smthrs/scorers`. Every published sentence about this package has one source
here or in `src/`; the package `README.md` summarizes, it does not add.

`docs/Manifest.ts` declares the owned surfaces and `scripts/docs.mjs` projects every
categorized source export into `exports.md`. The `docsPages` target in
`PACKAGE.ts` regenerates that index and drift-checks it under the `lint` verb.
The package stays workspace-private at `0.1.0`, so its generated reference
remains colocated rather than creating a public site route.

- `api.md`: the public surface, its failure vocabulary, and its bounds.
- `durability.md`: what the store guarantees across a restart, and what it
  refuses to persist.
- `exports.md`: generated member names, kinds, categories, and summaries.

The one consumer is `@smthrs/evals`, which supplies the evaluator this package
deliberately does not.
