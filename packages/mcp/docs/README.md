# Package-owned documentation

Every published sentence about `@smthrs/mcp` has exactly one source, and that
source lives inside this package:

| Source                     | What it is                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------- |
| `src/**/*.ts` JSDoc        | The contract of each export. The export tables are derived from it.                   |
| `package.json` description | The one-line summary the generated page quotes.                                       |
| `docs/api.md`              | The prose body of the generated reference page.                                       |
| `../README.md`             | The package front page. It links to the generated reference rather than repeating it. |

`scripts/docs.mjs` is the generator. Run it from the repository root:

```sh
node packages/mcp/scripts/docs.mjs           # write
node packages/mcp/scripts/docs.mjs --check   # drift-check, exits 1 when stale
```

`scripts/check-docs.mjs` discovers every `packages/*/scripts/docs.mjs` and runs
the `--check` form, so stale generated prose fails the repository docs gate.

It writes one file, `docs/reference.md`: the prose in `docs/api.md`, an index of
every module and its exports, and one row per documented export of every module
the barrel re-exports. `dprint.json` excludes that file, because the generator
owns its formatting and dprint's table alignment would fight it forever.

## The one surface this package does not yet own

`@smthrs/mcp` is published at rc.0 and has no page under `docs/pages/api/`.
`Package.ts` records the target and what blocks it: `vocs.config.ts` is
hand-written, `scripts/check-docs.mjs` fails any published page the sidebar does
not list, and the release support matrix's `@smthrs/mcp` row has to link the
page in the same edit. `@smthrs/testing` records the same arrangement for the
same reason. When those two edits land, point `Package.api.target` at
`docs/pages/api/mcp.md`, give the generated file the vocs frontmatter the other
API pages carry, and delete this section.
