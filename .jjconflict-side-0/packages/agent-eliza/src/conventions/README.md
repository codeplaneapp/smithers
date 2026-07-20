# conventions/

elizaOS-conventions authoring layer for Smithers workflows: author, load,
format, and register workflows using elizaOS Skill/Plugin shapes. Public
surface is `index.js` (subpath export
`@smithers-orchestrator/agent-eliza/conventions`).

- `frontmatter.js` — parses/serializes frontmatter. Executable `.ts`/`.js`
  files use a leading block comment (`/* ---\n...yaml...\n--- */`) because raw
  `---` breaks JS syntax; companion `.md` files use plain `---`-fenced YAML.
- `loader.js` — discovers workflow files and merges sources with precedence
  bundled < managed (`~/.smithers/workflows`) < explicit `workflowPaths` <
  project `.smithers/workflows`, emitting a `collision` diagnostic on each
  override.
- `define.js` — `defineWorkflow` / `defineWorkflowPlugin` factories; normalize
  kebab-case `disable-model-invocation` to camelCase.
- `formatter.js` — renders the prompt section; skips workflows with
  `disableModelInvocation` or `system` set.
- `register.js` — bridges definitions into a duck-typed registry and converts
  to elizaOS Skill/Plugin shapes.
- `types.ts` — single type source (`WorkflowDefinition`, diagnostics, options).

Gotchas: the loader reads and parses frontmatter from file text BEFORE dynamic
import and prefers a companion `.md` for frontmatter, but
`WorkflowDefinition.source` is always the executable file's own text (never
the `.md`). `index.d.ts` here is hand-maintained alongside the `.js`/JSDoc
sources (tsup does not build it) — keep it in sync by hand; only the package
root `src/index.d.ts` is tsup-generated.
