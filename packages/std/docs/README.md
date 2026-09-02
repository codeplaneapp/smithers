# Colocated documentation

This directory, `Package.ts`, and the public JSDoc in `src/` own the published
contract for `@smthrs/std`. Nothing here is hand-maintained twice.

- `api.md` is the prose body of the reference: the limits every handler applies,
  the failure codes the handlers share, and what a host must bind before a flow
  can run. Those three facts are what a caller needs and none of them can be
  read off a type.
- `reference.md` is generated. `scripts/docs.mjs` writes it whole from `api.md`,
  the barrel's module JSDoc, and every `@category`-tagged export, and it fails
  when `README.md`'s Public API table no longer matches the barrel. That check
  exists because the hand-written table named 21 of 30 modules and omitted three
  registry flows a model can call.

`scripts/check-docs.mjs` discovers `packages/*/scripts/docs.mjs` and runs each in
`--check` mode, so the generator is a repository gate with no wiring of its own.

## The surface this package does not own yet

There is no `docs/pages/api/std.md`. The site page needs a sidebar entry in the
hand-written `vocs.config.ts` before it can exist, because `check-docs` fails a
published page the sidebar does not list, and that file belongs to no single
package. `Package.ts` records the target and the blocker in its `site` field.
`@smthrs/mcp` and `@smthrs/testing` record the same arrangement for the same
reason.

After editing anything under `src/` or `docs/`, run from the repository root:

```sh
node packages/std/scripts/docs.mjs
node scripts/generate-known-files.mjs
pnpm docs:llms
```
