---
title: "@smthrs/step-cache"
description: "Effect service for the flows content-addressed step result cache"
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/step-cache/docs/README.md"
---

This directory and the package JSDoc are the source of every published sentence
about `@smthrs/step-cache`. The page under `docs/pages` is generated from here
and never hand-edited.

`scripts/docs.mjs` builds `docs/pages/api/step-cache.md` from the module JSDoc
in `src/index.ts`, plus `api.md`, plus one reference table per exported
namespace, and verifies that the pages pointing readers at this package still
name it and link `/api/step-cache`.

An export reaches the reference table by carrying an `@category` tag. An
untagged export is silently absent from the page, which is the one failure mode
to watch for when adding a public name.

The `//packages/smithers/flows/step-cache:docsPages` target in `PACKAGE.ts` runs the same
script: `smithers-build run` writes, `smithers-build lint` reports drift, and
CI runs the lint form through the workspace `ci` step. `scripts/check-docs.mjs`
discovers this generator by path and runs its `--check` form as well.

After editing, run `node packages/smithers/flows/step-cache/scripts/docs.mjs` from the
repository root, then `pnpm docs:llms`, because the generated page feeds the
llms bundles.
