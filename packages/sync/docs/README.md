# Colocated documentation

This directory, `Package.ts`, and the public JSDoc in `src/` own the published
contract for `@smthrs/sync`. Generated pages under `docs/pages` are outputs.

`scripts/docs.mjs` builds `docs/pages/api/sync.md` from the module JSDoc of
`src/index.ts`, the `@category`-tagged JSDoc of every namespace the barrel
re-exports, and `docs/api.md`. It injects `docs/protocol.md` into the
`sync-protocol` region of `docs/pages/concepts/sync.md`, then verifies that the
reference list declared by `Package.ts` still points readers to `/api/sync`.

The `//packages/sync:docsPages` target writes or drift-checks those outputs.
After editing, run:

```sh
node packages/sync/scripts/docs.mjs
pnpm docs:llms
```

A claim about this package belongs in exactly one of four places:

| Claim                                            | Home                                                |
| ------------------------------------------------ | --------------------------------------------------- |
| What one export does                             | its JSDoc in `src/`, which the Exports table quotes |
| How the package fits together, and its contracts | `docs/api.md`                                       |
| What the wire protocol is, for a client author   | `docs/protocol.md`                                  |
| The one-line summary every package table quotes  | `description` in `package.json`                     |
