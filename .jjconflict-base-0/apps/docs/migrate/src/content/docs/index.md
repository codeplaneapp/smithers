---
title: "@smthrs/migrate"
description: "Upgrades Smithers 0.x projects to Smithers 1.0 flows and writes an auditable migration report"
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/migrate/docs/README.md"
---

Every published sentence about `@smthrs/migrate` has one source, and it is
inside this package: the JSDoc in `src/`, the prose in this directory, and the
`description` in `package.json`.

| File     | Where it goes                                                                                                               |
| -------- | --------------------------------------------------------------------------------------------------------------------------- |
| `api.md` | The body of `docs/pages/migration/migrate-tool.md`, the reference an operator reads before deciding whether to run `apply`. |

The page lives on the migration path rather than under `/api` because an
operator reaches this tool from the 0.x upgrade guide, not from the API index.
`docs/sidebar.ts` lists that route and `scripts/generate-docs-pages.mjs` maps
the package to it.

`scripts/docs.mjs` writes the page from `../Package.ts`, this directory, and
the JSDoc of every public module:

```sh
node packages/smithers/migrate/scripts/docs.mjs           # write
node packages/smithers/migrate/scripts/docs.mjs --check   # fail on drift
```

`PACKAGE.ts` declares that script as a `Generate` target, so
`smithers-build run` writes the page and `smithers-build lint` drift-checks it
inside the ordinary `smithers-build ci '//packages/...'` run.

Edit the page only by editing this directory or the JSDoc it reads. A hand
edit to `docs/pages/migration/migrate-tool.md` is overwritten by the next
generator run and fails the drift check before that.
