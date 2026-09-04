---
title: "@smthrs/canonical"
description: "RFC 8785 canonical JSON as an Effect Schema"
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/canonical/docs/README.md"
---

This directory and the package JSDoc are the source of every published sentence about `@smthrs/canonical`. The published pages under `docs/pages` are generated from here and never hand-edited.

`scripts/docs.mjs` builds `docs/pages/api/canonical.md` from the JSDoc in `src/` plus `api.md`, injects `serialization.md` into the `canonical-serialization` region of `docs/pages/data-structures.md`, and verifies that the pages quoting the package description (`package.json` `description`) still carry it verbatim.

The `//packages/smithers/flows/canonical:docsPages` target in `PACKAGE.ts` runs the same script: `smithers-build run` writes, `smithers-build lint` reports drift, and CI runs the lint form through the workspace `ci` step.

After editing, run `node packages/smithers/flows/canonical/scripts/docs.mjs` from the repository root, then `pnpm docs:llms`, because both generated pages are in the llms bundles.
