# Package-owned documentation

Every published sentence about `@smthrs/harness` has exactly one source, and
that source lives inside this package:

| Source                     | What it is                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------- |
| `src/**/*.ts` JSDoc        | The contract of each export. The export table is derived from it.                     |
| `package.json` description | The one-line summary every generated page quotes.                                     |
| `docs/api.md`              | The prose body of the generated reference page.                                       |
| `docs/concepts.md`         | The governing designs the source JSDoc cites by package-relative path.                |
| `docs/history.md`          | The wave-by-wave narrative that used to sit in `CHANGELOG.md`.                        |
| `../README.md`             | The package front page. It links to the generated reference rather than repeating it. |

`scripts/docs.mjs` is the generator. Run it from the repository root:

```sh
node packages/harness/scripts/docs.mjs           # write
node packages/harness/scripts/docs.mjs --check   # drift-check, exits 1 when stale
```

`scripts/check-docs.mjs` discovers every `packages/*/scripts/docs.mjs` and runs
the `--check` form, so a stale generated region fails the repository docs gate.

It writes one file, `docs/reference.md`: the barrel's module docblock, the prose
in `docs/api.md`, an index of every module and its exports, and one row per
documented export of every module the barrel re-exports plus every public
subpath. `dprint.json` excludes that file, because the generator owns its
formatting and dprint's table alignment would fight it forever.

`README.md` links to it instead of repeating it. The table that used to sit in
`README.md` was hand-maintained and had drifted by seven whole modules and more
than thirty exports, which is the defect this arrangement removes.

`docs/Manifest.ts` declares that target as data. It also records the one surface this
package does not yet own: `docs/pages/api/harness.md` on the documentation site.
That page needs a sidebar entry in the hand-written `vocs.config.ts` before it
can exist, because `check-docs.mjs` fails any published page the sidebar does
not list.

## Rules for editing

- Never hand-edit a generated region. Edit the JSDoc, `docs/api.md`, or
  `package.json`, then rerun the generator.
- An export with no `@category` tag is invisible to the generator. Tag it.
- A module the barrel does not re-export is not part of the public API and does
  not appear in the table.
