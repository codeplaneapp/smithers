# Colocated documentation

This directory and the public JSDoc in `src/` own the contract for
`@smthrs/scorers`. Every published sentence about this package has one source
here or in `src/`; the package `README.md` summarizes, it does not add.

`@smthrs/scorers` is workspace-private at `1.0.0-rc.0` and is not one of the 40
published names, so it owns no page under `docs/pages` and no generator writes
one. Nothing in `vocs.config.ts` links it and `scripts/check-docs.mjs` does not
gate it. If the package is ever published, follow the colocation pilot in
`packages/crypto`: add `Package.ts`, `scripts/docs.mjs`, and a `docsPages`
`Smithers.Generate` target in a `BUILD.ts`, then register the `--check` run in
`scripts/check-docs.mjs`.

- `api.md` — the public surface, its failure vocabulary, and its bounds.
- `durability.md` — what the store guarantees across a restart, and what it
  refuses to persist.

The one consumer is `@smthrs/evals`, which supplies the evaluator this package
deliberately does not.
