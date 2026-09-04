# Package-owned documentation

Every published sentence about `@smthrs/jj` has one source, and it is inside
this package.

- `api.md` is the body of the API page: the prose between the barrel's module
  header and the generated tables. It is written whole into the site page.
- The entry-point table and every export table on that page are generated from
  the JSDoc in `src/`, driven by the `entryPoints` list in `../Package.ts`. A
  new export shows up on the site by carrying a `@category` tag, not by being
  retyped into a table.
- `../README.md` is the npm-facing overview and links to the published page
  rather than restating it.

`docs/pages/api/jj.mdx` is a generated output. Do not edit it. Regenerate with:

```sh
node packages/smithers/flows/jj/scripts/docs.mjs
```

and drift-check it with `node packages/smithers/flows/jj/scripts/docs.mjs --check`, which is
what `pnpm -C apps/site check:docs` runs. The generator refuses to write content
containing an em-dash, so keep the prose here and the first sentence of every
`@category` JSDoc block free of them.
