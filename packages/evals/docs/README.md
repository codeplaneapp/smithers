# Colocated documentation

This directory and the public JSDoc in `src/` own everything published about
`@smthrs/evals`. The package README is a short entry point that links here; it
restates nothing.

`api.md` is the whole reference: the pipeline, the comparison semantics a caller
has to know, the stable failure codes, the batch protocol, the determinism and
size limits, and the table of every documented export.

`@smthrs/evals` is private at 1.0.0-rc.0, so it owns no page under `docs/pages`
and no generator writes one. `test/docs.test.ts` is the gate: it fails when an
export carrying a `@category` tag is missing from the `api.md` table, or when the
table names an export that no longer exists. Keep the two in step in the same
commit as the source change.
