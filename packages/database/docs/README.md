# Colocated documentation

This directory, `Package.ts`, and the public JSDoc in `src/` own the published
contract for `@smthrs/database`. Generated pages under `docs/pages` are outputs.

`scripts/docs.mjs` builds `docs/pages/api/database.md` from the barrel's module
JSDoc, the prose in `docs/api.md`, and the `@category` JSDoc on every export of
every module `Package.ts` declares, then verifies that the reference list in
`Package.ts` still points readers to `/api/database`.

Two rules the generator enforces, because both are repository gates:

- Every entry point in `Package.ts` must resolve to a file that exists, so a new
  subpath is documented by declaring it here rather than by editing a page.
- Generated content may not contain an em-dash. `scripts/check-docs.mjs`
  forbids one anywhere in the site prose, and a first sentence lifted out of
  JSDoc would otherwise smuggle one in.

The `//packages/database:docsPages` target writes or drift-checks the output.
After editing, run:

```sh
node packages/database/scripts/docs.mjs
pnpm docs:llms
```
