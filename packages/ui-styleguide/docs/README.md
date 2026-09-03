# Colocated documentation

This directory and the JSDoc in `src/` own every published sentence about
`@smthrs/ui-styleguide`.

`@smthrs/ui-styleguide` is private at `1.0.0-rc.0`, so it has no page under
`docs/pages` and no `Package.ts`/`scripts/docs.mjs` pair to generate one. The
files here are the source a page would be generated from the day it becomes
public, following the `packages/crypto` recipe.

| File | Covers |
| --- | --- |
| [`api.md`](./api.md) | Every runtime export and type, with the input contracts. |
| [`theming.md`](./theming.md) | The two selection axes, the cascade, and the WCAG AA discipline the tests enforce. |

The package `README.md` is the entry point; `src/README.md` is a pointer back
to these files.
