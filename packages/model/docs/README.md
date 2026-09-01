# Colocated documentation

This directory, `Package.ts`, and the public JSDoc in `src/` own every
published sentence about `@smthrs/model`. `docs/reference.md` is a generated
output and is never hand-edited.

`scripts/docs.mjs` builds that page from the namespace barrel in
`src/index.ts`, the module JSDoc of every namespace it re-exports, the
`@category`-tagged export JSDoc inside each of those modules, and `api.md`.
It also regenerates the public-API table inside the package `README.md`
between its `generated:model-exports` markers, so the table cannot fall behind
the barrel.

Two rules the generator enforces:

- An export without a `@category` tag is invisible to it, so a new public
  export needs the tag before it appears anywhere.
- Generated prose must be free of em-dashes, because `scripts/check-docs.mjs`
  rejects a site page containing one. An em-dash found in a JSDoc summary is
  normalized to a comma, and the run fails if any survives.

`docs/reference.md` is not yet published as `docs/pages/api/model.md`. A site
page must be listed in the sidebar of the hand-written `vocs.config.ts` before
`scripts/check-docs.mjs` will accept it, and that file is outside what this
package generates. `Package.ts` records the entry to add and the support-matrix
link that should land with it.

After editing package sources or `api.md`, run from the repository root:

```sh
node packages/model/scripts/docs.mjs
```

and verify with `node packages/model/scripts/docs.mjs --check`, which
`scripts/check-docs.mjs` discovers and runs on its own.
