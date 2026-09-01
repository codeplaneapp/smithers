# Colocated documentation

This directory and the public JSDoc in `src/` own the contract for
`@smthrs/scorers`. Every published sentence about this package has one source
here or in `src/`; the package `README.md` summarizes, it does not add.

Workspace privacy does not explain why `@smthrs/scorers` has no `Package.ts`,
`BUILD.ts`, or `scripts/docs.mjs`. `packages/errors` is `private: true` at
`1.0.0-rc.0` and owns all three plus a generated
`docs/pages/reference/errors.md` page. `@smthrs/scorers` is workspace-private at
`0.1.0`, but it owns no page under `docs/pages`, so a generator has no site
artifact to write. Its one reference table is already gated on every default
test run by `test/docs.test.ts`.

The generator in `packages/errors` is a hand-copied script of the kind the
repository is trying to fold into `packages/targets`; another copy here would
make that duplication worse. If this package is ever published, follow the
colocation pilot in `packages/crypto`: add `Package.ts`, `scripts/docs.mjs`, and
a `docsPages` `Smithers.Generate` target in a `BUILD.ts`, then register the
`--check` run in `scripts/check-docs.mjs`.

- `api.md`: the public surface, its failure vocabulary, and its bounds.
- `durability.md`: what the store guarantees across a restart, and what it
  refuses to persist.

The one consumer is `@smthrs/evals`, which supplies the evaluator this package
deliberately does not.
