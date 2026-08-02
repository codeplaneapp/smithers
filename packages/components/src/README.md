# @smthrs/components — src

The React render layer for Smithers workflows. Components here render to
`smithers:*` host elements that the reconciler and graph packages extract into
a workflow graph — nothing in this package executes tasks itself; the engine
does that.

## Entry points

- `index.js` — the curated export surface: re-exports `components/`,
  `markdownComponents`, `renderMdx`, and `zodSchemaToJsonExample`.
- `markdownComponents.js` + `renderMdx.js` — turn MDX/JSX prompt bodies into
  plain markdown text for agent prompts.
- `zod-to-example.js` — renders a zod schema as the JSON example embedded in
  agent prompts.
- `SmithersWorkflow.ts` / `types.ts` — type-only re-export surfaces.

## Conventions

- Implementation is `.js` with JSDoc types plus type-only `.ts` sidecars
  (`FooProps.ts`). Never convert between the two.
- `// @smithers-type-exports-begin/end` blocks are tool-managed — never
  hand-edit them.
- The package.json `"./*"` export makes EVERY file under src/ a public
  subpath (e.g. `@smthrs/components/SmithersWorkflow` is
  imported by packages/server; packages/engine tests import
  `components/components/index`). No file here may be moved, renamed, or have
  exports removed without a breaking-change decision.

## Subdirectories

- `components/` — the component library (see its README).
- `aspects/` — cross-cutting budget/SLO context carried down the tree.
- `types/` — ambient `.d.ts` shims only.
