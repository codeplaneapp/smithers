# Colocated documentation

This directory and the JSDoc in `src/` own the documentation for
`@smthrs/targets`. The package is private and has no page on the documentation
site, so nothing here is projected outward: `docs/` is where a reader of this
package looks, and `README.md` at the package root is the introduction that
points here.

- `api.md` is the hand-written tour of the module surface: what each layer is
  for and which module owns which contract.
- `rules.md` is generated. `scripts/docs.mjs` reads every `Target.make`
  declaration in `src/` and writes the catalog inventory, so a rule that is
  added, re-verbed, or made cacheable shows up without anyone remembering to
  write it down.

`docs/Manifest.ts` at the package root names those surfaces, the way every other
package in the workspace does. The generator reads the source directory and the
generated path from it and refuses to run when its `name` and the one in
`package.json` disagree, so the declaration is what the generator obeys rather
than a second description of it.

The `//packages/targets:docsPages` target writes or drift-checks the generated
file, and `scripts/check-docs.mjs` discovers `scripts/docs.mjs` on its own. After
editing anything the generator reads, run:

```sh
node packages/targets/scripts/docs.mjs
```

Thirty-four reference pages for rules implemented here still live in
`packages/build/docs/reference/targets/`. Moving them under this directory and
having `packages/build` consume the artifact is the remaining half of the
colocation, and it is an edit in that package.
