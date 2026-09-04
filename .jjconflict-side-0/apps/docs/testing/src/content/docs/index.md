---
title: "@smthrs/testing"
description: "Testing and conformance library for flows"
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/testing/docs/README.md"
---

Every published sentence about `@smthrs/testing` has exactly one source, and
that source lives inside this package:

| Source                     | What it is                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------- |
| `src/**/*.ts` JSDoc        | The contract of each export. The export tables are derived from it.                   |
| `package.json` description | The one-line summary the generated page quotes.                                       |
| `docs/api.md`              | The prose body of the generated reference page.                                       |
| `docs/concepts.md`         | The governing designs the source JSDoc cites by package-relative path.                |
| `../README.md`             | The package front page. It links to the generated reference rather than repeating it. |

`scripts/docs.mjs` is the generator. Run it from the repository root:

```sh
node packages/testing/scripts/docs.mjs           # write
node packages/testing/scripts/docs.mjs --check   # drift-check, exits 1 when stale
```

`scripts/check-docs.mjs` discovers every `packages/*/scripts/docs.mjs` and runs
the `--check` form, so a stale generated region fails the repository docs gate.

It writes the site's API page, `docs/pages/api/testing.md`: the prose in
`docs/api.md`, an index of every module and its exports, and one row per
documented export of every module the barrel re-exports plus every public
subpath. It also projects `docs/guide.md` into the marked region of the site's
Testing guide.

`@smthrs/testing` was the last name in the release's published set with no page
on the documentation site, because the page cannot land before
`docs/sidebar.ts` lists it: `scripts/check-docs.mjs` fails any published page
the sidebar does not reach, and fails any sidebar link no page answers. That
file is hand-written editorial order no generator writes, so the entry and the
page land in the same commit.

The house style forbids an em-dash on a published page, so the generator
refuses to write one and names the lines that carry it. The offending prose is
in a module's JSDoc or in `docs/api.md`, never in the generated page.
