# Package-owned documentation

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

It writes one file, `docs/reference.md`: the prose in `docs/api.md`, an index of
every module and its exports, and one row per documented export of every module
the barrel re-exports plus every public subpath. `dprint.json` excludes that
file, because the generator owns its formatting and dprint's table alignment
would fight it forever.

## The one surface this package does not yet own

`docs/pages/api/testing.md` does not exist. `@smthrs/testing` is the only name
in the release's published set with no page on the documentation site, and the
page cannot land before `vocs.config.ts` lists it: `scripts/check-docs.mjs`
fails any published page the sidebar does not reach, and that file is
hand-written editorial order no generator writes. `Package.site` records the
blocked target so the generator can write it the moment the sidebar entry
lands. Until then `docs/reference.md` is the generated reference and it lives
here.
